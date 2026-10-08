// De punta a punta, con todas las piezas reales (API + D1 + generador y lector de Excel + MCP) y sin sustituir
// ninguna: lo que no se podía probar hasta que existieran todas. La base es la de server/d1-node.ts.
//
// El libro de Excel conserva el diseño original (dos monedas, dos cuentas, saldos escritos mes a mes) y el
// estado de la app es otro modelo: entre uno y otro median buildExportData y applyImportToState
// (shared/excel/data.ts, con sus propias pruebas). Aquí se comprueba el camino completo por la API: que lo que
// se carga queda guardado como dice ese puente y que lo que se descarga es lo que hay guardado.
// El libro de referencia del diseño ("Finanzas Personales v3.xlsx") está en español y es de la versión 1.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportPayload, ImportResponse, StateResponse } from '../shared/api';
import { balances } from '../shared/calc';
import { DEFAULT_ACCOUNTS, DEFAULT_GOALS } from '../shared/constants';
import { buildExportData, IMPORTED_INCOME } from '../shared/excel/data';
import { buildFinanzasXlsx, EXCEL_ES, XLSX_MIME } from '../shared/excel/export';
import { LEGACY_GOALS, parseFinanzasXlsx } from '../shared/excel/import';
import { seedState } from '../shared/seed';
import type { AppState } from '../shared/types';
import { loadState, replaceAll, resetAll } from './db';
import { handleMcp } from './mcp';
import { client, EDA, FRANK, makeEnv, TOKEN } from './test-util';
import type { Client } from './test-util';

const REFERENCE = new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve('../design_handoff/referencia/Finanzas Personales v3.xlsx'))));

/** Una base recién migrada (sin nada de nadie) con las rutas de desarrollo activas. `api` es Frank; `eda`, Eda. */
function fresh() {
  const t = makeEnv({ ALLOW_DEV_RESET: '1' });
  return { ...t, api: client(t.env), eda: client(t.env, EDA.id) };
}

async function exportXlsx(api: Client): Promise<Uint8Array> {
  const res = await api.raw('/api/export.xlsx', { method: 'GET' });
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toBe(XLSX_MIME);
  return new Uint8Array(await res.arrayBuffer());
}

async function importXlsx(api: Client, bytes: Uint8Array): Promise<ImportResponse> {
  const res = await api.raw('/api/import', { method: 'POST', headers: { 'Content-Type': XLSX_MIME }, body: bytes });
  expect(res.status).toBe(200);
  return (await res.json()) as ImportResponse;
}

async function getState(api: Client): Promise<AppState> {
  const r = await api.get<StateResponse>('/api/state');
  expect(r.status).toBe(200);
  return r.body.state;
}

/** El estado sin lo que una importación asigna por su cuenta: ids, createdAt, source y closedAt. Los aportes, por nombre de meta. */
function comparable(state: AppState) {
  const goalName = new Map(state.goals.map((g) => [g.id, g.name]));
  return {
    ...state,
    goals: state.goals.map(({ id: _id, ...g }) => g),
    contribs: state.contribs.map(({ id: _id, goalId, ...c }) => ({ ...c, goal: goalName.get(goalId) })),
    incomes: state.incomes.map(({ id: _id, ...i }) => i),
    months: Object.fromEntries(
      Object.entries(state.months).map(([key, m]) => [
        key,
        {
          ...m,
          closedAt: null,
          fixed: m.fixed.map(({ id: _id, ...f }) => f),
          transfers: m.transfers.map(({ id: _id, ...t }) => t),
          tx: m.tx.map(({ id: _id, createdAt: _createdAt, source: _source, ...t }) => t),
        },
      ]),
    ),
  };
}

/** Las cifras de un estado sin los textos que escribió el usuario: lo que comparten el libro en español y los datos de ejemplo. */
function figures(state: AppState) {
  const goalName = new Map(state.goals.map((g) => [g.id, g.name]));
  return {
    goals: state.goals.map((g) => [g.name, g.cur, g.monthly, g.start, g.end, g.sort]),
    contribs: state.contribs.map((c) => [c.date, goalName.get(c.goalId), c.amount, c.cur]),
    months: Object.values(state.months).map((m) => ({
      key: m.key,
      closed: m.closed,
      budgets: m.budgets,
      fixed: m.fixed.map((f) => [f.day, f.amount, f.cur, f.paid, f.accountId, f.sort]),
      transfers: m.transfers.map((t) => [t.date, t.via, t.fromAccountId, t.toAccountId, t.amount, t.rate]),
      tx: m.tx.map((t) => [t.date, t.cat, t.method, t.amount, t.cur, t.accountId]),
    })),
  };
}

/** Saldo de cada cuenta al final de `asOf`, redondeado al centavo. */
function monthEnd(state: AppState, asOf: string): [string, number][] {
  return balances(state, asOf).accounts.map((a) => [a.account.id, Math.round(a.balance * 100) / 100]);
}

/**
 * Dos libros ya leídos dicen lo mismo. Los saldos de las cuentas se comparan al centavo: en el libro son un
 * número calculado (saldo inicial más movimientos) y no tienen por qué coincidir hasta el último decimal.
 */
function expectSameBook(actual: ImportPayload, expected: ImportPayload) {
  const withoutBalances = (book: ImportPayload) => ({ ...book, months: book.months.map((m) => ({ ...m, accounts: null })) });
  expect(withoutBalances(actual)).toEqual(withoutBalances(expected));
  actual.months.forEach((m, i) => {
    expect(m.accounts.usd, `${m.key} usd`).toBeCloseTo(expected.months[i]!.accounts.usd, 2);
    expect(m.accounts.dop, `${m.key} dop`).toBeCloseTo(expected.months[i]!.accounts.dop, 2);
  });
}

/** Los datos de ejemplo con las tres metas llamadas como en la versión 1 (en español), que es como las conserva quien viene de ella. */
function seedWithFormerGoalNames(): AppState {
  const former = new Map(LEGACY_GOALS.map(([before, now]) => [now, before]));
  const state = seedState();
  return { ...state, language: 'es', goals: state.goals.map((g) => ({ ...g, name: former.get(g.name) ?? g.name })) };
}

describe('de punta a punta: Excel', () => {
  it('POST /api/import con el libro de referencia en una base vacía → GET /api/state trae las cifras de los datos de ejemplo', async () => {
    const { api, eda } = fresh();
    expect(await importXlsx(api, REFERENCE)).toEqual({ months: ['2026-08', '2026-09', '2026-10'], contributions: 8 });

    const state = await getState(api);
    // Mismos meses, fijos, envíos, transacciones, presupuesto, metas y aportes que los datos de ejemplo (que salen
    // de ese libro): cada gasto en la cuenta de su moneda, y las tres metas de la versión 1 con su nombre de hoy,
    // que son justo las metas iniciales más la del viaje. La primera visita ya no tiene nada que crearle.
    expect(figures(state)).toEqual(figures(seedState()));
    expect(state.accounts.map((a) => [a.id, a.name, a.currency])).toEqual(DEFAULT_ACCOUNTS.map((a) => [a.id, a.name, a.currency]));
    // Los textos del usuario, tal cual (en español); categorías y métodos, con su nombre canónico.
    expect(state.months['2026-10']!.tx[0]).toMatchObject({ desc: 'Compra semanal', cat: 'Groceries', method: 'Card' });
    // El ingreso de cada mes es un ingreso en USD el día 1; los saldos del último mes son los del libro.
    expect(state.incomes.map((i) => [i.date, i.desc, i.accountId, i.amount, i.cur])).toEqual(
      ['2026-08-01', '2026-09-01', '2026-10-01'].map((date) => [date, IMPORTED_INCOME, 'us', 5800, 'USD']),
    );
    expect(monthEnd(state, '2026-10')).toEqual([
      ['us', 4320],
      ['dr', 86400],
    ]);
    // El idioma y las monedas no vienen del libro.
    expect([state.language, state.mainCurrency, state.secondCurrency, state.defaultAccountId]).toEqual(['en', 'DOP', 'USD', null]);

    // Lo que sí cambia con una importación.
    const months = Object.values(state.months);
    expect(months.flatMap((m) => m.tx).every((t) => t.source === 'import' && t.createdAt !== null)).toBe(true);
    expect(months.map((m) => m.closedAt !== null)).toEqual([true, true, false]);
    const ids = [...months.flatMap((m) => [...m.fixed, ...m.transfers, ...m.tx]), ...state.contribs, ...state.goals, ...state.incomes].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Y nada de eso es de Eda: ella entra y encuentra una app recién estrenada.
    const hers = await getState(eda);
    expect(hers.goals).toEqual([...DEFAULT_GOALS]);
    expect(hers.accounts).toEqual([...DEFAULT_ACCOUNTS]);
    expect(hers.contribs).toEqual([]);
    expect(hers.incomes).toEqual([]);
    expect(Object.values(hers.months).flatMap((m) => [...m.fixed, ...m.transfers, ...m.tx])).toEqual([]);
  });

  it('ese usuario, con la app en español, descarga un libro que dice lo mismo que el de referencia', async () => {
    const { api } = fresh();
    await importXlsx(api, REFERENCE);
    expect((await api.patch('/api/settings', { language: 'es' })).status).toBe(200);
    const mine = parseFinanzasXlsx(await exportXlsx(api));
    const reference = parseFinanzasXlsx(REFERENCE);
    // Todo igual salvo los saldos de los meses anteriores: en el libro de referencia estaban escritos a mano mes a
    // mes; ahora son un cálculo (lo que había al final de ese mes), y solo el último tiene que coincidir.
    const withoutBalances = (book: ImportPayload) => ({ ...book, months: book.months.map((m) => ({ ...m, accounts: null })) });
    expect(withoutBalances(mine)).toEqual(withoutBalances(reference));
    expect(mine.months[2]!.accounts.usd).toBeCloseTo(reference.months[2]!.accounts.usd, 2);
    expect(mine.months[2]!.accounts.dop).toBeCloseTo(reference.months[2]!.accounts.dop, 2);
    expect(reference.months[2]!.accounts).toEqual({ usd: 4320, dop: 86400 });
  });

  it('los datos de ejemplo de la app, vistos en español, dan ese mismo libro salvo los textos que escribió el usuario y los saldos', async () => {
    const { api } = fresh();
    expect((await api.post('/api/dev/seed')).status).toBe(200);
    expect((await api.patch('/api/settings', { language: 'es' })).status).toBe(200);
    const mine = parseFinanzasXlsx(await exportXlsx(api));
    const reference = parseFinanzasXlsx(REFERENCE);
    // Mismas cifras, fechas, categorías y métodos (lo que se traduce); otros nombres y descripciones (lo que no).
    const shape = (book: typeof mine) =>
      book.months.map((m) => ({
        key: m.key,
        closed: m.closed,
        budget: m.budget,
        incomeUSD: m.incomeUSD,
        fixed: m.fixed.map((f) => [f.amount, f.cur, f.paid]),
        transfers: m.transfers,
        tx: m.tx.map((t) => [t.date, t.cat, t.method, t.amount, t.cur]),
      }));
    expect(shape(mine)).toEqual(shape(reference));
    expect(mine.months[2]!.tx[0]!.desc).toBe('Weekly groceries');
    expect(reference.months[2]!.tx[0]!.desc).toBe('Compra semanal');
    // Los saldos del libro son los de las cuentas de la app al final de cada mes: los de octubre, 13,482 y 220,641.93.
    const state = await getState(api);
    expect(mine.months.map((m) => [m.accounts.usd, Math.round(m.accounts.dop * 100) / 100])).toEqual(
      ['2026-08', '2026-09', '2026-10'].map((key) => monthEnd(state, key).map(([, balance]) => balance)),
    );
    expect(mine.months[2]!.accounts.usd).toBe(13482);
  });

  it('exportar → importar → exportar da el mismo libro', async () => {
    const source = fresh();
    // Una cuarta meta, en español, para que el libro no sea uno de la versión 1 (más abajo).
    const mine = seedWithFormerGoalNames();
    mine.goals.push({ id: 'carro', name: 'Carro', cur: 'USD', monthly: null, start: null, end: null, sort: 3 });
    await replaceAll(source.db, FRANK.id, mine);
    const first = await exportXlsx(source.api);

    // En otra base, a otro usuario que también usa la app en español y no tiene nada propio: sus dos cuentas, un
    // octubre vacío y ninguna meta (borró las iniciales, que si no se conservarían junto a las cuatro del libro).
    const target = fresh();
    await target.eda.patch('/api/settings', { language: 'es' });
    await resetAll(target.db, EDA.id, '2026-10');
    for (const goal of DEFAULT_GOALS) expect((await target.eda.del(`/api/goals/${goal.id}`)).status).toBe(200);
    await importXlsx(target.eda, first);
    expectSameBook(parseFinanzasXlsx(await exportXlsx(target.eda)), parseFinanzasXlsx(first));
    expect((await getState(target.eda)).goals.map((g) => g.name)).toEqual(['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía', 'Carro']);

    // Volver a importar encima de lo que ya hay tampoco cambia nada (los meses se sustituyen, no se duplican).
    const once = await getState(target.eda);
    await importXlsx(target.eda, first);
    expect(comparable(await getState(target.eda))).toEqual(comparable(once));
  });

  it('quien conserva las tres metas de la versión 1 en español puede volver a cargar su propio libro sin que se le dupliquen', async () => {
    const { api, db } = fresh();
    // Con solo esas tres metas y en español, su libro es uno de la versión 1: el lector renombra sus metas a las de hoy…
    await replaceAll(db, FRANK.id, seedWithFormerGoalNames());
    const before = await getState(api);
    expect(before.goals.map((g) => g.name)).toEqual(['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía']);
    const first = await exportXlsx(api);
    expect(parseFinanzasXlsx(first).goals!.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey']);

    // …pero al aplicarlo valen las que él tiene con el nombre de entonces: ni metas nuevas ni aportes movidos.
    await importXlsx(api, first);
    const after = await getState(api);
    expect(after.goals).toEqual(before.goals);
    expect(comparable(after).contribs).toEqual(comparable(before).contribs);
    // Y su siguiente libro trae las mismas tres metas con los mismos aportes.
    const [again, original] = [parseFinanzasXlsx(await exportXlsx(api)), parseFinanzasXlsx(first)];
    expect(again.goals).toEqual(original.goals);
    expect(again.contribs).toEqual(original.contribs);
  });

  it('ese mismo libro, en un usuario que tiene las metas con el nombre de hoy, cae en ellas', async () => {
    const { api, eda, db } = fresh();
    await replaceAll(db, FRANK.id, seedWithFormerGoalNames());
    const first = await exportXlsx(api);

    // Eda ya entró alguna vez: tiene las dos metas iniciales.
    const mine = await getState(eda);
    expect(mine.goals.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings']);
    await importXlsx(eda, first);
    const hers = await getState(eda);
    expect(hers.goals.map((g) => [g.name, g.cur, g.monthly, g.start, g.end])).toEqual([
      ['Emergency fund', 'USD', null, null, null],
      ['Personal savings', 'USD', null, null, null],
      ['Trip to Turkey', 'USD', 3000, '2026-08', '2027-10'],
    ]);
    // Las dos que ya tenía son las mismas filas, no otras nuevas con el mismo nombre.
    expect(hers.goals.slice(0, 2).map((g) => g.id)).toEqual(mine.goals.map((g) => g.id));
    const byGoal = (name: string) => hers.contribs.filter((c) => c.goalId === hers.goals.find((g) => g.name === name)!.id).length;
    expect([byGoal('Emergency fund'), byGoal('Personal savings'), byGoal('Trip to Turkey')]).toEqual([3, 2, 3]);
  });

  it('exportar → importar → exportar también da el mismo libro en inglés y en turco', async () => {
    for (const language of ['en', 'tr'] as const) {
      const source = fresh();
      await source.api.post('/api/dev/seed');
      await source.api.patch('/api/settings', { language });
      const first = await exportXlsx(source.api);

      const target = fresh();
      await target.api.patch('/api/settings', { language });
      await importXlsx(target.api, first);
      expectSameBook(parseFinanzasXlsx(await exportXlsx(target.api)), parseFinanzasXlsx(first));
    }
  });

  it('la variante JSON (lo que manda la web tras leer el archivo en el navegador) deja lo mismo que el .xlsx crudo', async () => {
    const raw = fresh();
    await importXlsx(raw.api, REFERENCE);

    const json = fresh();
    const r = await json.api.post<ImportResponse>('/api/import', parseFinanzasXlsx(REFERENCE));
    expect(r.status).toBe(200);
    expect(comparable(await getState(json.api))).toEqual(comparable(await getState(raw.api)));
  });
});

describe('de punta a punta: un Excel editado a mano', () => {
  it('un monto negativo rechaza el archivo entero, dice dónde está y no cambia nada', async () => {
    const { api } = fresh();
    await api.post('/api/dev/seed');
    const before = await getState(api);

    // La app nunca guarda montos negativos; solo pueden llegar en un libro retocado en Excel.
    for (const locale of [undefined, EXCEL_ES]) {
      const edited = seedState();
      edited.months['2026-10']!.tx[3]!.amount = -900;
      const res = await api.raw('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': XLSX_MIME },
        body: buildFinanzasXlsx(buildExportData(edited), locale ? { locale } : {}),
      });
      expect(res.status).toBe(400);
      // El aviso va en inglés aunque el libro esté en otro idioma.
      expect(await res.json()).toEqual({
        error: { code: 'validation', message: 'Invalid data: months.2.tx.3.amount: cannot be negative' },
      });
    }
    expect(await getState(api)).toEqual(before);
  });
});

describe('de punta a punta: lo que registra Claude llega a la web y al Excel', () => {
  /** Mediodía del 7 de octubre de 2026 en Santo Domingo. */
  const NOW = new Date('2026-10-07T16:00:00Z');
  const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('add_transaction por /mcp y POST /api/ingest/transaction aparecen en /api/state y en el libro de ese usuario', async () => {
    const { api, eda, env, db } = fresh();
    await api.post('/api/dev/seed');
    await eda.post('/api/dev/seed');
    const edaBefore = await loadState(db, EDA.id);
    const drBefore = monthEnd(await getState(api), '2026-10')[1]![1];

    // Frank le dicta a Claude en español: la categoría llega como 'Transporte' y se guarda como 'Transport'.
    const mcp = await handleMcp(
      new Request('https://finanzas.example/mcp', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'add_transaction', arguments: { user: 'frank', description: 'Uber', amount: 850, category: 'Transporte' } },
        }),
      }),
      env,
      NOW,
    );
    expect(mcp.status).toBe(200);
    const result = ((await mcp.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('Uber');
    expect(result.content[0]!.text).toContain('850.00 DOP');

    // Y por la API, diciendo de qué cuenta sale por su nombre.
    const ingest = await client(env, null).post(
      '/api/ingest/transaction',
      { user: 'frank', date: '2026-10-06', description: 'Colmado', amount: 12.5, account: 'us account' },
      AUTH,
    );
    expect(ingest.status).toBe(201);

    const state = await getState(api);
    const fromClaude = state.months['2026-10']!.tx.filter((t) => t.source === 'claude');
    expect(fromClaude.map((t) => [t.date, t.desc, t.cat, t.method, t.amount, t.cur, t.accountId])).toEqual([
      // Sin cuenta: la de por defecto de Frank ('dr'), en su moneda.
      ['2026-10-07', 'Uber', 'Transport', 'Card', 850, 'DOP', 'dr'],
      ['2026-10-06', 'Colmado', 'Food', 'Card', 12.5, 'USD', 'us'],
    ]);
    // Los dos gastos ya restaron de sus cuentas.
    expect(monthEnd(state, '2026-10')).toEqual([
      ['us', 13482 - 12.5],
      ['dr', Math.round((drBefore - 850) * 100) / 100],
    ]);

    const october = parseFinanzasXlsx(await exportXlsx(api)).months.find((m) => m.key === '2026-10')!;
    expect(october.tx).toHaveLength(9);
    expect(october.tx).toContainEqual({ date: '2026-10-07', desc: 'Uber', place: '', cat: 'Transport', method: 'Card', amount: 850, cur: 'DOP', notes: '' });
    expect(october.tx).toContainEqual({ date: '2026-10-06', desc: 'Colmado', place: '', cat: 'Food', method: 'Card', amount: 12.5, cur: 'USD', notes: '' });
    expect(october.accounts.usd).toBeCloseTo(13482 - 12.5, 2);

    // Nada de eso llegó a las finanzas ni al libro de Eda.
    expect(await loadState(db, EDA.id)).toEqual(edaBefore);
    expect(parseFinanzasXlsx(await exportXlsx(eda)).months.find((m) => m.key === '2026-10')!.tx).toHaveLength(7);
  });

  it('cerrar el mes por la API: el libro gana la hoja del mes siguiente, con los fijos sin pagar', async () => {
    const { api, eda } = fresh();
    await api.post('/api/dev/seed');
    await eda.post('/api/dev/seed');
    expect((await api.post('/api/months/2026-10/close')).status).toBe(200);

    const book = parseFinanzasXlsx(await exportXlsx(api));
    expect(book.months.map((m) => [m.key, m.closed])).toEqual([
      ['2026-08', true],
      ['2026-09', true],
      ['2026-10', true],
      ['2026-11', false],
    ]);
    const november = book.months[3]!;
    expect(november.fixed).toHaveLength(11);
    expect(november.fixed.every((f) => !f.paid)).toBe(true);
    expect(november.tx).toEqual([]);
    expect(november.transfers).toEqual([]);
    // El presupuesto se copia; el ingreso no: es la suma de los ingresos de noviembre, que todavía no hay.
    expect([november.budget, november.incomeUSD]).toEqual([70000, 0]);
    // Nada se ha movido todavía en noviembre: los saldos son los de octubre.
    expect(november.accounts.usd).toBeCloseTo(book.months[2]!.accounts.usd, 2);
    expect(november.accounts.dop).toBeCloseTo(book.months[2]!.accounts.dop, 2);

    // El libro de Eda sigue con sus tres meses.
    expect(parseFinanzasXlsx(await exportXlsx(eda)).months.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);
  });
});
