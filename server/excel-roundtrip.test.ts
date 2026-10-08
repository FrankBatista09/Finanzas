// Ida y vuelta real (sin sustituir nada): lo que exporta GET /api/export.xlsx se puede volver a cargar con
// POST /api/import, sea cual sea el idioma del libro.
//
// El libro conserva el diseño original, que solo conoce dos monedas y dos cuentas: es un resumen del estado, no
// una copia (shared/excel/data.ts dice qué se pierde en cada sentido, y lo prueba). Con los datos de ejemplo
// —una cuenta en USD y otra en DOP, que es justo lo que el libro sabe representar— la vuelta devuelve el mismo
// histórico salvo lo que el libro no lleva: la tasa escrita a mano y la descripción de cada ingreso.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportResponse } from '../shared/api';
import { balances, monthCalc, rateFor } from '../shared/calc';
import { IMPORTED_INCOME } from '../shared/excel/data';
import { XLSX_MIME } from '../shared/excel/export';
import { parseFinanzasXlsx } from '../shared/excel/import';
import { LANGUAGES } from '../shared/i18n';
import { seedState, setBudgets } from '../shared/seed';
import type { AppState } from '../shared/types';
import { loadState, replaceAll, resetAll } from './db';
import { client, EDA, FRANK, makeEnv } from './test-util';

const F = FRANK.id;
const E = EDA.id;

/**
 * Lo que el libro lleva y trae de un estado, sin lo que una importación asigna de nuevo (ids, origen, fechas de
 * alta o de cierre) ni lo que no viaja en él (ajustes, tasas escritas, el detalle de los ingresos).
 */
function content(state: AppState) {
  const goalName = new Map(state.goals.map((g) => [g.id, g.name]));
  return {
    goals: state.goals.map((g) => ({ name: g.name, cur: g.cur, monthly: g.monthly, start: g.start, end: g.end, sort: g.sort })),
    contribs: state.contribs.map((c) => ({ date: c.date, goal: goalName.get(c.goalId), amount: c.amount, cur: c.cur })),
    months: Object.values(state.months).map((m) => ({
      key: m.key,
      closed: m.closed,
      budgets: m.budgets,
      fixed: m.fixed.map((f) => ({ name: f.name, day: f.day, amount: f.amount, cur: f.cur, paid: f.paid, accountId: f.accountId, sort: f.sort })),
      transfers: m.transfers.map((t) => ({ date: t.date, via: t.via, fromAccountId: t.fromAccountId, toAccountId: t.toAccountId, amount: t.amount, rate: t.rate })),
      tx: m.tx.map((t) => ({
        date: t.date,
        desc: t.desc,
        place: t.place,
        cat: t.cat,
        method: t.method,
        amount: t.amount,
        cur: t.cur,
        accountId: t.accountId,
        notes: t.notes,
      })),
    })),
  };
}

/** Las cifras del estado, sin los textos que escribió el usuario: para comparar libros en distinto idioma. */
function figures(state: AppState) {
  const full = content(state);
  return {
    goals: full.goals,
    contribs: full.contribs,
    months: full.months.map((m) => ({
      ...m,
      fixed: m.fixed.map(({ name: _name, ...f }) => f),
      tx: m.tx.map(({ desc: _desc, place: _place, notes: _notes, ...t }) => t),
    })),
  };
}

/** Saldo de cada cuenta visible al final de cada mes, redondeado al centavo. */
function monthEndBalances(state: AppState) {
  return Object.keys(state.months)
    .sort()
    .map((key) => balances(state, key).accounts.map((a) => [key, a.account.id, Math.round(a.balance * 100) / 100]));
}

const upload = (api: ReturnType<typeof client>, bytes: Uint8Array) =>
  api.raw('/api/import', { method: 'POST', headers: { 'Content-Type': XLSX_MIME }, body: bytes });

async function download(api: ReturnType<typeof client>): Promise<Uint8Array> {
  const exported = await api.raw('/api/export.xlsx', { method: 'GET' });
  expect(exported.status).toBe(200);
  return new Uint8Array(await exported.arrayBuffer());
}

/** Lo que tiene que quedar al cargar el libro de los datos de ejemplo en un usuario que solo tiene sus dos cuentas iniciales. */
function expectSeedHistory(state: AppState) {
  const seed = seedState();
  // Meses, fijos, envíos, transacciones (cada uno en su cuenta), presupuesto, metas y aportes: lo mismo.
  expect(content(state)).toEqual(content(seed));
  // Las dos cuentas, con el mismo saldo al final de cada mes (y por tanto el mismo saldo inicial).
  expect(state.accounts.map((a) => [a.id, a.currency, a.hidden])).toEqual(seed.accounts.map((a) => [a.id, a.currency, a.hidden]));
  expect(monthEndBalances(state)).toEqual(monthEndBalances(seed));
  expect(state.accounts[0]!.opening).toBeCloseTo(2000, 6);
  expect(state.accounts[1]!.opening).toBeCloseTo(60000, 6);
  // El ingreso de cada mes llega como un ingreso el día 1, a la cuenta en USD: la descripción no viaja.
  expect(state.incomes.map((i) => [i.date, i.desc, i.accountId, i.amount, i.cur])).toEqual(
    seed.incomes.map((i) => [i.date, IMPORTED_INCOME, i.accountId, i.amount, i.cur]),
  );
  // La tasa escrita a mano de octubre tampoco: el libro (y la app, al volver) la sacan de los envíos del mes.
  for (const m of Object.values(state.months)) expect(m.rates).toEqual([]);
  expect(rateFor(state, '2026-10', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'transfers', monthKey: '2026-10', date: null });
  // Con todo eso, las cifras de cada mes son las mismas.
  for (const key of Object.keys(seed.months)) {
    const [mine, theirs] = [monthCalc(state, key), monthCalc(seed, key)];
    expect(mine.used).toBeCloseTo(theirs.used, 6);
    expect(mine.budget).toBeCloseTo(theirs.budget, 6);
    expect(mine.income).toBeCloseTo(theirs.income, 6);
    expect(mine.saved).toBeCloseTo(theirs.saved, 6);
  }
}

describe('Excel: exportar e importar de verdad', () => {
  for (const { id: language, name } of LANGUAGES) {
    it(`con el libro en ${name}: exportar los datos de ejemplo, vaciar e importar el archivo devuelve el mismo histórico`, async () => {
      const { env, db } = makeEnv();
      const api = client(env);
      await replaceAll(db, F, { ...seedState(), language });
      // Eda tiene lo mismo, en otro idioma, y no se entera de nada.
      await replaceAll(db, E, seedState());
      const eda = await loadState(db, E);

      const bytes = await download(api);
      // Un .xlsx es un zip: empieza por "PK".
      expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);

      await resetAll(db, F, '2026-10');
      const res = await upload(api, bytes);
      expect(res.status).toBe(200);
      expect((await res.json()) as ImportResponse).toEqual({ months: ['2026-08', '2026-09', '2026-10'], contributions: 8 });

      const state = await loadState(db, F);
      // Lo guardado no depende del idioma del libro: categorías y métodos vuelven con su nombre canónico.
      expectSeedHistory(state);
      for (const m of Object.values(state.months)) expect(m.tx.every((t) => t.source === 'import')).toBe(true);
      expect(state.language).toBe(language);
      expect(await loadState(db, E)).toEqual(eda);

      // Y el libro que sale ahora dice lo mismo que el que se cargó.
      expect(parseFinanzasXlsx(await download(api))).toEqual(parseFinanzasXlsx(bytes));
    });
  }

  it('un libro exportado en un idioma se puede cargar con la app en otro', async () => {
    const { env, db } = makeEnv();
    await replaceAll(db, F, { ...seedState(), language: 'tr' });
    const bytes = await download(client(env));

    // Eda, que usa la app en inglés y nunca había entrado, carga el libro en turco de Frank.
    const res = await upload(client(env, E), bytes);
    expect(res.status).toBe(200);
    const state = await loadState(db, E);
    expectSeedHistory(state);
    expect(state.language).toBe('en');
  });

  it('volver a cargar el propio libro encima de lo que ya hay no duplica nada', async () => {
    const source = makeEnv();
    await replaceAll(source.db, F, seedState());
    const bytes = await download(client(source.env));

    const { env, db } = makeEnv();
    const api = client(env);
    expect((await upload(api, bytes)).status).toBe(200);
    const once = await loadState(db, F);
    expect((await upload(api, bytes)).status).toBe(200);
    const twice = await loadState(db, F);
    expect(content(twice)).toEqual(content(once));
    expect(twice.accounts).toEqual(once.accounts);
    // Los ingresos importados se sustituyen (conservan su id), no se suman otra vez.
    expect(twice.incomes).toEqual(once.incomes);
    expect(monthEndBalances(twice)).toEqual(monthEndBalances(once));
  });

  it('carga el libro de referencia del diseño (en español)', async () => {
    const { env, db } = makeEnv();
    const file = fileURLToPath(import.meta.resolve('../design_handoff/referencia/Finanzas Personales v3.xlsx'));
    const res = await upload(client(env), new Uint8Array(readFileSync(file)));
    expect(res.status).toBe(200);
    const state = await loadState(db, F);
    // Las mismas cifras que los datos de ejemplo (que salen de ese libro), cada gasto en la cuenta de su moneda;
    // las categorías y los métodos, con su nombre canónico, y las tres metas de la versión 1, con su nombre de hoy.
    expect(figures(state)).toEqual(figures(seedState()));
    // Descripciones, lugares y notas quedan como estaban en el libro.
    expect(state.months['2026-10']!.tx[0]).toMatchObject({ desc: 'Compra semanal', cat: 'Groceries', method: 'Debit card', accountId: 'dr' });
    expect(state.months['2026-10']!.fixed.find((f) => f.cur === 'USD')).toMatchObject({ name: 'Claude', accountId: 'us' });
    // Los saldos del libro (los de su último mes) son ahora los de las dos cuentas.
    expect(balances(state, '2026-10').accounts.map((a) => [a.account.id, Math.round(a.balance * 100) / 100])).toEqual([
      ['us', 4320],
      ['dr', 86400],
    ]);
    expect(state.incomes.map((i) => [i.date, i.amount, i.cur, i.accountId])).toEqual([
      ['2026-08-01', 5800, 'USD', 'us'],
      ['2026-09-01', 5800, 'USD', 'us'],
      ['2026-10-01', 5800, 'USD', 'us'],
    ]);
  });

  it('con una tercera moneda y más cuentas el libro sigue saliendo y cargándose: lo que no sabe escribir va convertido', async () => {
    const { env, db } = makeEnv();
    const mine = seedState();
    mine.mainCurrency = 'TRY';
    mine.secondCurrency = 'USD';
    mine.accounts.push({ id: 'tr', name: 'TR account', currency: 'TRY', opening: 50000, hidden: false, sort: 2 });
    const october = mine.months['2026-10']!;
    october.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    setBudgets(october, { dr: 60000, tr: 4000 });
    october.tx.push({ ...october.tx[0]!, id: 'lira', desc: 'Baklava', amount: 1250, cur: 'TRY', accountId: 'tr' });
    october.transfers.push({ id: 'to-tr', monthKey: '2026-10', date: '2026-10-08', via: 'Wise', fromAccountId: 'us', toAccountId: 'tr', amount: 100, rate: 40, budget: false, fee: 0 });
    mine.incomes.push({ id: 'maas', date: '2026-10-15', desc: 'Maaş', accountId: 'tr', amount: 20000, cur: 'TRY', budget: false });
    mine.goals.push({ id: 'flat', name: 'Istanbul flat', cur: 'TRY', monthly: 10000, start: '2026-10', end: '2027-09', approxCur: null, sort: 3 });
    mine.contribs.push({ id: 'c-try', goalId: 'flat', date: '2026-10-09', amount: 4000, cur: 'TRY' });
    await replaceAll(db, F, mine);

    const bytes = await download(client(env));
    const book = parseFinanzasXlsx(bytes);
    expect(book.months.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    // En el libro solo hay DOP y USD; la transacción en liras está, convertida.
    const rows = [...book.months.flatMap((m) => [...m.fixed, ...m.tx]), ...(book.contribs ?? [])];
    expect(new Set(rows.map((r) => r.cur))).toEqual(new Set(['DOP', 'USD']));
    expect(book.months[2]!.tx.map((t) => t.desc)).toContain('Baklava');
    expect(book.goals!.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Istanbul flat']);

    // Eda lo carga: le llega como un histórico en sus dos cuentas, con sus propias monedas.
    const res = await upload(client(env, E), bytes);
    expect(res.status).toBe(200);
    const hers = await loadState(db, E);
    expect([hers.mainCurrency, hers.secondCurrency]).toEqual(['DOP', 'USD']);
    expect(hers.accounts.map((a) => a.id)).toEqual(['us', 'dr']);
    expect(hers.months['2026-10']!.tx).toHaveLength(8);
    expect(hers.contribs).toHaveLength(9);
    // Y a Frank no le cambió nada.
    expect((await loadState(db, F)).accounts.map((a) => a.id)).toEqual(['us', 'dr', 'tr']);
  });

  it('un archivo que no es un .xlsx: 400 validation y la base queda igual', async () => {
    const { env, db } = makeEnv();
    await replaceAll(db, F, seedState());
    const before = await loadState(db, F);
    const res = await upload(client(env), new TextEncoder().encode('esto no es un excel'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation');
    expect(await loadState(db, F)).toEqual(before);
  });
});
