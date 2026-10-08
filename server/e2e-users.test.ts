// De punta a punta con dos usuarios y todas las piezas reales (API + D1 + generador y lector de Excel): lo que
// solo se puede comprobar cuando existen todas. Frank y Eda arrancan con los mismos datos de ejemplo —los mismos
// ids y las mismas cuentas incluidos— y Eda cambia lo suyo: una transacción, un ingreso, una meta con plan, un
// aporte, sus colores y su idioma. A partir de ahí, nada de uno puede aparecer en lo del otro: ni en el estado,
// ni en los saldos, ni en el Excel, ni al importar.
//
// El libro de Excel es un resumen del estado con el diseño original (shared/excel/data.ts): lo que tiene que
// salir al leer el de cada uno es la proyección de SU estado, y lo que queda al cargarlo, lo que dice ese puente.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportPayload, ImportResponse, SettingsResponse, StateResponse } from '../shared/api';
import { balances } from '../shared/calc';
import { CATS, DEFAULT_ACCOUNTS, DEFAULT_GOALS, METHODS } from '../shared/constants';
import { buildExportData } from '../shared/excel/data';
import { XLSX_MIME } from '../shared/excel/export';
import { unzipText } from '../shared/excel/export-testkit';
import { parseFinanzasXlsx } from '../shared/excel/import';
import { seedState, SEED_PLANNED_GOAL } from '../shared/seed';
import type { AppState, Contribution, Goal, Income, ThemeColors, Transaction } from '../shared/types';
import { loadState } from './db';
import { client, EDA, FRANK, makeEnv, withoutTimestamps } from './test-util';
import type { Client } from './test-util';

const REFERENCE = new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve('../design_handoff/referencia/Finanzas Personales v3.xlsx'))));

const OCEAN: ThemeColors = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };

async function getState(api: Client): Promise<StateResponse> {
  const r = await api.get<StateResponse>('/api/state');
  expect(r.status).toBe(200);
  return r.body;
}

async function exportXlsx(api: Client): Promise<{ bytes: Uint8Array; filename: string }> {
  const res = await api.raw('/api/export.xlsx', { method: 'GET' });
  expect(res.status).toBe(200);
  return { bytes: new Uint8Array(await res.arrayBuffer()), filename: res.headers.get('Content-Disposition') ?? '' };
}

async function importXlsx(api: Client, bytes: Uint8Array): Promise<ImportResponse> {
  const res = await api.raw('/api/import', { method: 'POST', headers: { 'Content-Type': XLSX_MIME }, body: bytes });
  expect(res.status).toBe(200);
  return (await res.json()) as ImportResponse;
}

/** Nombres de las hojas del libro, en su orden. */
function sheetNames(bytes: Uint8Array): string[] {
  const workbook = unzipText(bytes).get('xl/workbook.xml') ?? '';
  return [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => m[1]!);
}

const sorted = <T>(rows: readonly T[]): T[] => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/**
 * Lo que tiene que salir al leer el libro de ese estado: su proyección a la forma del libro (buildExportData),
 * con todos los meses cerrados salvo el último. El orden de las filas dentro de una tabla no forma parte de la
 * comparación (la hoja ordena los aportes por fecha).
 */
function asWorkbook(state: AppState): ImportPayload {
  const data = buildExportData(state);
  return {
    months: data.months.map((m, i) => ({
      key: m.key,
      closed: i < data.months.length - 1,
      budget: m.budget ?? 0,
      incomeUSD: m.incomeUSD ?? 0,
      accounts: { usd: m.accounts.usd ?? 0, dop: m.accounts.dop ?? 0 },
      fixed: m.fixed.map((f) => ({ ...f, day: String(f.day ?? ''), amount: f.amount ?? 0 })),
      transfers: sorted(m.transfers.map((t) => ({ ...t, usd: t.usd ?? 0, rate: t.rate ?? 0 }))),
      tx: sorted(m.tx.map((t) => ({ ...t, amount: t.amount ?? 0 }))),
    })),
    contribs: sorted(data.contribs),
    goals: data.goals,
  };
}

/** Un libro ya leído, con las tablas en el mismo orden neutro que `asWorkbook`. */
function readWorkbook(bytes: Uint8Array): ImportPayload {
  const book = parseFinanzasXlsx(bytes);
  return {
    ...book,
    months: book.months.map((m) => ({ ...m, transfers: sorted(m.transfers), tx: sorted(m.tx) })),
    contribs: book.contribs && sorted(book.contribs),
  };
}

/** Un libro sin las cifras que son un cálculo sobre todo el histórico: el ingreso del mes y los saldos. */
function rows(book: ImportPayload) {
  return { ...book, months: book.months.map(({ incomeUSD: _income, accounts: _accounts, ...m }) => m) };
}

/** Dos libros dicen lo mismo; los saldos, que son números calculados, se comparan al centavo. */
function expectSameBook(actual: ImportPayload, expected: ImportPayload) {
  expect(rows(actual)).toEqual(rows(expected));
  actual.months.forEach((m, i) => {
    const want = expected.months[i]!;
    expect(m.incomeUSD, `${m.key} income`).toBeCloseTo(want.incomeUSD, 6);
    expect(m.accounts.usd, `${m.key} usd`).toBeCloseTo(want.accounts.usd, 2);
    expect(m.accounts.dop, `${m.key} dop`).toBeCloseTo(want.accounts.dop, 2);
  });
}

/** Saldo de cada cuenta al final de `asOf`, redondeado al centavo. */
function monthEnd(state: AppState, asOf: string): [string, number][] {
  return balances(state, asOf).accounts.map((a) => [a.account.id, Math.round(a.balance * 100) / 100]);
}

/**
 * Los dos usuarios con los datos de ejemplo y los cambios de Eda. Devuelve también lo que Eda agregó, para
 * poder decir exactamente qué tiene cada uno.
 */
async function twoUsers() {
  const t = makeEnv({ ALLOW_DEV_RESET: '1' });
  const frank = client(t.env);
  const eda = client(t.env, EDA.id);
  expect((await frank.post('/api/dev/seed')).status).toBe(200);
  expect((await eda.post('/api/dev/seed')).status).toBe(200);

  const settings = await eda.patch<SettingsResponse>('/api/settings', { language: 'tr', theme: OCEAN });
  expect(settings.body).toEqual({ language: 'tr', theme: OCEAN, mainCurrency: 'DOP', secondCurrency: 'USD', defaultAccountId: 'dr' });
  const tx = await eda.post<Transaction>('/api/transactions', {
    monthKey: '2026-10',
    date: '2026-10-07',
    desc: 'Türk kahvesi',
    place: 'Kahve Dünyası',
    cat: 'Food',
    method: 'Bank app',
    amount: 250,
    cur: 'DOP',
    notes: 'şekerli',
  });
  expect(tx.status).toBe(201);
  const income = await eda.post<Income>('/api/incomes', { date: '2026-10-10', desc: 'Çeviri işi', accountId: 'us', amount: 300, cur: 'USD' });
  expect(income.status).toBe(201);
  const goal = await eda.post<Goal>('/api/goals', { name: 'Ev', cur: 'USD', monthly: 500, start: '2026-10', end: '2027-09' });
  expect(goal.status).toBe(201);
  const contribution = await eda.post<Contribution>('/api/contributions', { goalId: goal.body.id, date: '2026-10-05', amount: 500, cur: 'USD' });
  expect(contribution.status).toBe(201);

  return { ...t, frank, eda, added: { tx: tx.body, income: income.body, goal: goal.body, contribution: contribution.body } };
}

describe('de punta a punta: dos usuarios con las mismas finanzas de partida', () => {
  it('GET /api/state de cada uno trae solo sus datos, sus saldos y sus ajustes', async () => {
    const { frank, eda, added } = await twoUsers();
    const seed = seedState();

    const his = await getState(frank);
    expect(his.user).toEqual(FRANK);
    // Frank sigue exactamente con los datos de ejemplo, en inglés y con la paleta original.
    expect(withoutTimestamps(his.state)).toEqual(seed);

    const hers = await getState(eda);
    expect(hers.user).toEqual(EDA);
    expect(hers.state.language).toBe('tr');
    expect(hers.state.theme).toEqual(OCEAN);
    expect(hers.state.accounts).toEqual(seed.accounts);
    expect(hers.state.goals).toEqual([...seed.goals, { id: added.goal.id, name: 'Ev', cur: 'USD', monthly: 500, start: '2026-10', end: '2027-09', sort: 3 }]);
    expect(hers.state.contribs).toEqual([...seed.contribs, added.contribution]);
    expect(hers.state.incomes).toEqual([...seed.incomes, added.income]);
    expect(withoutTimestamps(hers.state).months).toEqual({
      ...seed.months,
      '2026-10': { ...seed.months['2026-10']!, tx: [...seed.months['2026-10']!.tx, { ...added.tx, createdAt: null, accountId: 'dr' }] },
    });

    // Las cuentas se llaman igual y tienen el mismo id, pero cada una lleva lo suyo: a Eda le entraron 300 USD
    // y le salieron 250 DOP; a Frank, nada.
    expect(monthEnd(his.state, '2026-10')).toEqual([
      ['us', 13482],
      ['dr', 220641.93],
    ]);
    expect(monthEnd(hers.state, '2026-10')).toEqual([
      ['us', 13782],
      ['dr', 220391.93],
    ]);

    // Lo que agregó Eda no existe para Frank, ni siquiera pidiéndolo por su id.
    expect((await frank.patch(`/api/transactions/${added.tx.id}`, { amount: 1 })).status).toBe(404);
    expect((await frank.patch(`/api/incomes/${added.income.id}`, { amount: 1 })).status).toBe(404);
    expect((await frank.patch(`/api/goals/${added.goal.id}`, { name: 'Casa' })).status).toBe(404);
    expect((await frank.del(`/api/contributions/${added.contribution.id}`)).status).toBe(404);
    expect((await getState(eda)).state).toEqual(hers.state);
  });

  it('el Excel de cada uno sale en su idioma y, leído de vuelta, es la proyección de su propio estado', async () => {
    const { frank, eda } = await twoUsers();
    const his = (await getState(frank)).state;
    const hers = (await getState(eda)).state;

    const frankBook = await exportXlsx(frank);
    expect(frankBook.filename).toContain('FE Finance - Frank.xlsx');
    expect(sheetNames(frankBook.bytes)).toEqual(['August 2026', 'September 2026', 'October 2026', 'Savings', 'Config']);
    expectSameBook(readWorkbook(frankBook.bytes), asWorkbook(his));

    const edaBook = await exportXlsx(eda);
    expect(edaBook.filename).toContain('FE Finance - Eda.xlsx');
    expect(sheetNames(edaBook.bytes)).toEqual(['Ağustos 2026', 'Eylül 2026', 'Ekim 2026', 'Birikimler', 'Config']);
    // En el libro las categorías y los métodos van en turco; al leerlo vuelven a su nombre canónico.
    const strings = unzipText(edaBook.bytes).get('xl/sharedStrings.xml') ?? [...unzipText(edaBook.bytes).values()].join('');
    expect(strings).toContain('Banka uygulaması');
    expectSameBook(readWorkbook(edaBook.bytes), asWorkbook(hers));

    // Y son dos libros distintos: el de Frank no trae nada de lo que agregó Eda.
    const frankRead = parseFinanzasXlsx(frankBook.bytes);
    expect(frankRead.goals!.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey']);
    expect(frankRead.months[2]!.tx.some((t) => t.desc === 'Türk kahvesi')).toBe(false);
    expect(frankRead.months[2]!.incomeUSD).toBe(5800);
    expect(frankRead.months[2]!.accounts.usd).toBe(13482);
    const edaRead = parseFinanzasXlsx(edaBook.bytes);
    expect(edaRead.goals!.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Ev']);
    expect(edaRead.goals![3]).toEqual({ name: 'Ev', monthlyUSD: 500, start: '2026-10', end: '2027-09' });
    expect(edaRead.months[2]!.tx).toContainEqual({
      date: '2026-10-07', desc: 'Türk kahvesi', place: 'Kahve Dünyası', cat: 'Food', method: 'Bank app', amount: 250, cur: 'DOP', notes: 'şekerli',
    });
    // Su ingreso de octubre y el saldo de su cuenta en USD llevan los 300 que cobró.
    expect(edaRead.months[2]!.incomeUSD).toBe(6100);
    expect(edaRead.months[2]!.accounts.usd).toBe(13782);
  });

  it('cargar el libro de Eda en Frank cambia solo a Frank', async () => {
    const { frank, eda, db } = await twoUsers();
    const edaBefore = await loadState(db, EDA.id);
    const frankBefore = (await getState(frank)).state;
    const { bytes } = await exportXlsx(eda);

    expect(await importXlsx(frank, bytes)).toEqual({ months: ['2026-08', '2026-09', '2026-10'], contributions: 9 });

    // Eda no se entera: ni una fila suya cambió (ids, fechas de alta y ajustes incluidos).
    expect(await loadState(db, EDA.id)).toEqual(edaBefore);

    // Frank tiene ahora las filas del libro de Eda (gastos fijos, envíos, transacciones, metas y aportes)…
    const frankAfter = (await getState(frank)).state;
    expect(rows(asWorkbook(frankAfter))).toEqual(rows(asWorkbook(edaBefore)));
    expect(Object.values(frankAfter.months).flatMap((m) => m.tx).every((t) => t.source === 'import')).toBe(true);
    // …en sus propias filas y cuentas: sus tres metas siguen siendo las mismas (mismo id) y la de Eda se le creó aparte.
    expect(frankAfter.accounts.map((a) => a.id)).toEqual(frankBefore.accounts.map((a) => a.id));
    expect(frankAfter.goals.slice(0, 3)).toEqual(frankBefore.goals);
    expect(frankAfter.goals[3]).toMatchObject({ name: 'Ev', cur: 'USD', monthly: 500, start: '2026-10', end: '2027-09', sort: 3 });
    expect(frankAfter.goals[3]!.id).not.toBe(edaBefore.goals[3]!.id);
    // …con los saldos que traía el libro, que son los de Eda al final de octubre…
    expect(monthEnd(frankAfter, '2026-10')).toEqual(monthEnd(edaBefore, '2026-10'));
    // …sin perder los ingresos que él ya tenía registrados…
    expect(frankAfter.incomes).toEqual(expect.arrayContaining(frankBefore.incomes));
    // …y con sus propios ajustes: el idioma, los colores y las monedas no viajan en el libro.
    expect([frankAfter.language, frankAfter.theme, frankAfter.mainCurrency, frankAfter.defaultAccountId]).toEqual(['en', null, 'DOP', 'dr']);
    // Su siguiente Excel sale en inglés, con las filas que cargó.
    const again = await exportXlsx(frank);
    expect(sheetNames(again.bytes)).toEqual(['August 2026', 'September 2026', 'October 2026', 'Savings', 'Config']);
    expect(rows(readWorkbook(again.bytes))).toEqual(rows(asWorkbook(edaBefore)));
  });
});

describe('de punta a punta: el libro de la versión 1 (en español) en un usuario sin datos', () => {
  /** Lo que se comprueba igual haya entrado antes a la app o no. */
  function expectImportedReference(state: AppState) {
    const tx = Object.values(state.months).flatMap((m) => m.tx);
    expect(tx).toHaveLength(27);
    // Categorías y métodos: siempre su nombre canónico, aunque el libro los traiga en español.
    expect(tx.every((t) => (CATS as readonly string[]).includes(t.cat))).toBe(true);
    expect(tx.every((t) => (METHODS as readonly string[]).includes(t.method))).toBe(true);
    // Los textos del usuario, como estaban en el libro; las cifras, las de los datos de ejemplo.
    expect(tx.slice(0, 2).map((t) => t.desc)).toEqual(['Compra semanal', 'Uber']);
    const seedTx = Object.values(seedState().months).flatMap((m) => m.tx);
    expect(tx.map((t) => [t.date, t.cat, t.method, t.amount, t.cur, t.accountId])).toEqual(
      seedTx.map((t) => [t.date, t.cat, t.method, t.amount, t.cur, t.accountId]),
    );
    // Todo en sus dos cuentas iniciales, que quedan con los saldos del libro.
    expect(state.accounts.map((a) => [a.id, a.name, a.currency])).toEqual(DEFAULT_ACCOUNTS.map((a) => [a.id, a.name, a.currency]));
    expect(monthEnd(state, '2026-10')).toEqual([
      ['us', 4320],
      ['dr', 86400],
    ]);

    // Las metas: las dos iniciales con su nombre en inglés (no duplicadas en español) y la del viaje con su plan.
    expect(state.goals.map(({ name, cur, monthly, start, end, sort }) => ({ name, cur, monthly, start, end, sort }))).toEqual(
      [...DEFAULT_GOALS, SEED_PLANNED_GOAL].map(({ name, cur, monthly, start, end, sort }) => ({ name, cur, monthly, start, end, sort })),
    );
    const goalName = new Map(state.goals.map((g) => [g.id, g.name]));
    const perGoal = (name: string) => state.contribs.filter((c) => goalName.get(c.goalId) === name).reduce((sum, c) => sum + c.amount, 0);
    expect([perGoal('Emergency fund'), perGoal('Personal savings'), perGoal('Trip to Turkey')]).toEqual([1200, 450, 9000]);
  }

  it('que nunca había entrado: al abrir la app encuentra sus datos, con las cuentas y las metas iniciales', async () => {
    const { env } = makeEnv();
    const eda = client(env, EDA.id);
    await importXlsx(eda, REFERENCE);

    const { state } = await getState(eda);
    expectImportedReference(state);
    // La primera visita no le crea otra vez las metas ni las cuentas iniciales.
    expect(state.goals).toHaveLength(3);
    expect(state.goals.slice(0, 2).map((g) => g.id)).toEqual(DEFAULT_GOALS.map((g) => g.id));
    expect(state.accounts).toHaveLength(2);

    // Frank, que tampoco había entrado, encuentra una app recién estrenada.
    const his = (await getState(client(env))).state;
    expect(his.goals).toEqual([...DEFAULT_GOALS]);
    expect(his.accounts).toEqual([...DEFAULT_ACCOUNTS]);
    expect(his.contribs).toEqual([]);
    expect(his.incomes).toEqual([]);
    expect(Object.values(his.months).flatMap((m) => [...m.fixed, ...m.transfers, ...m.tx])).toEqual([]);
  });

  it('que ya había entrado: los aportes caen en las metas iniciales que ya tenía, sin crear otras', async () => {
    const { env } = makeEnv();
    const eda = client(env, EDA.id);
    const before = (await getState(eda)).state;
    expect(before.goals).toEqual([...DEFAULT_GOALS]);
    await eda.patch('/api/settings', { language: 'tr', mainCurrency: 'TRY', secondCurrency: 'DOP' });

    await importXlsx(eda, REFERENCE);
    const { state } = await getState(eda);
    expectImportedReference(state);
    expect(state.goals.slice(0, 2)).toEqual([...DEFAULT_GOALS]);
    // El mes que ya tenía y el libro no trae sigue ahí, y sus ajustes, como los dejó.
    expect(Object.keys(state.months)).toEqual(expect.arrayContaining(Object.keys(before.months)));
    expect([state.language, state.mainCurrency, state.secondCurrency]).toEqual(['tr', 'TRY', 'DOP']);
  });
});
