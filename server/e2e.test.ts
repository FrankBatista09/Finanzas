// End to end, with all the real pieces (API + D1 + Excel generator and reader + MCP) and without replacing any
// of them: what could not be tested until all of them existed. The database is the one from server/d1-node.ts.
//
// The Excel workbook keeps the original design (two currencies, two accounts, balances typed month by month) and
// the app's state is a different model: between the two sit buildExportData and applyImportToState
// (shared/excel/data.ts, with its own tests). Here the whole path through the API is checked: that what is
// loaded ends up stored as that bridge says, and that what is downloaded is what is stored.
// The design's reference workbook ("Finanzas Personales v3.xlsx") is in Spanish and comes from version 1.

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

/** A freshly migrated database (nothing of anyone's in it) with the development routes on. `api` is Frank; `eda`, Eda. */
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

/** The state without what an import assigns on its own: ids, createdAt, source and closedAt. The contributions, by goal name. */
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

/** The figures of a state without the texts the user typed: what the Spanish workbook and the sample data share. */
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

/** Balance of each account at the end of `asOf`, rounded to the cent. */
function monthEnd(state: AppState, asOf: string): [string, number][] {
  return balances(state, asOf).accounts.map((a) => [a.account.id, Math.round(a.balance * 100) / 100]);
}

/**
 * Two workbooks already read say the same thing. The account balances are compared to the cent: in the workbook they
 * are a computed number (opening balance plus movements) and need not match down to the last decimal.
 */
function expectSameBook(actual: ImportPayload, expected: ImportPayload) {
  const withoutBalances = (book: ImportPayload) => ({ ...book, months: book.months.map((m) => ({ ...m, accounts: null })) });
  expect(withoutBalances(actual)).toEqual(withoutBalances(expected));
  actual.months.forEach((m, i) => {
    expect(m.accounts.usd, `${m.key} usd`).toBeCloseTo(expected.months[i]!.accounts.usd, 2);
    expect(m.accounts.dop, `${m.key} dop`).toBeCloseTo(expected.months[i]!.accounts.dop, 2);
  });
}

/** The sample data with the three goals named as in version 1 (in Spanish), which is how someone coming from it still has them. */
function seedWithFormerGoalNames(): AppState {
  const former = new Map(LEGACY_GOALS.map(([before, now]) => [now, before]));
  const state = seedState();
  return { ...state, language: 'es', goals: state.goals.map((g) => ({ ...g, name: former.get(g.name) ?? g.name })) };
}

describe('end to end: Excel', () => {
  it('POST /api/import with the reference workbook on an empty database → GET /api/state returns the figures of the sample data', async () => {
    const { api, eda } = fresh();
    expect(await importXlsx(api, REFERENCE)).toEqual({ months: ['2026-08', '2026-09', '2026-10'], contributions: 8 });

    const state = await getState(api);
    // Same months, fixed expenses, transfers, transactions, budget, goals and contributions as the sample data (which
    // comes from that workbook): each expense in the account of its currency, and the three version 1 goals with today's
    // name, which are exactly the initial goals plus the trip one. The first visit has nothing left to create for him.
    expect(figures(state)).toEqual(figures(seedState()));
    expect(state.accounts.map((a) => [a.id, a.name, a.currency])).toEqual(DEFAULT_ACCOUNTS.map((a) => [a.id, a.name, a.currency]));
    // The user's texts, as is (in Spanish); categories and methods, with their canonical name.
    expect(state.months['2026-10']!.tx[0]).toMatchObject({ desc: 'Compra semanal', cat: 'Groceries', method: 'Debit card' });
    // Each month's income is an income in USD on day 1; the last month's balances are the workbook's.
    expect(state.incomes.map((i) => [i.date, i.desc, i.accountId, i.amount, i.cur])).toEqual(
      ['2026-08-01', '2026-09-01', '2026-10-01'].map((date) => [date, IMPORTED_INCOME, 'us', 5800, 'USD']),
    );
    expect(monthEnd(state, '2026-10')).toEqual([
      ['us', 4320],
      ['dr', 86400],
    ]);
    // The language and the currencies do not come from the workbook.
    expect([state.language, state.mainCurrency, state.secondCurrency, state.defaultAccountId]).toEqual(['en', 'DOP', 'USD', null]);

    // What does change with an import.
    const months = Object.values(state.months);
    expect(months.flatMap((m) => m.tx).every((t) => t.source === 'import' && t.createdAt !== null)).toBe(true);
    expect(months.map((m) => m.closedAt !== null)).toEqual([true, true, false]);
    const ids = [...months.flatMap((m) => [...m.fixed, ...m.transfers, ...m.tx]), ...state.contribs, ...state.goals, ...state.incomes].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    // And none of that is Eda's: she visits and finds a brand-new app.
    const hers = await getState(eda);
    expect(hers.goals).toEqual([...DEFAULT_GOALS]);
    expect(hers.accounts).toEqual([...DEFAULT_ACCOUNTS]);
    expect(hers.contribs).toEqual([]);
    expect(hers.incomes).toEqual([]);
    expect(Object.values(hers.months).flatMap((m) => [...m.fixed, ...m.transfers, ...m.tx])).toEqual([]);
  });

  it('that user, with the app in Spanish, downloads a workbook that says the same as the reference one', async () => {
    const { api } = fresh();
    await importXlsx(api, REFERENCE);
    expect((await api.patch('/api/settings', { language: 'es' })).status).toBe(200);
    const mine = parseFinanzasXlsx(await exportXlsx(api));
    const reference = parseFinanzasXlsx(REFERENCE);
    // All the same except the balances of the earlier months: in the reference workbook they were typed by hand month
    // by month; now they are a computation (what there was at the end of that month), and only the last has to match.
    const withoutBalances = (book: ImportPayload) => ({ ...book, months: book.months.map((m) => ({ ...m, accounts: null })) });
    expect(withoutBalances(mine)).toEqual(withoutBalances(reference));
    expect(mine.months[2]!.accounts.usd).toBeCloseTo(reference.months[2]!.accounts.usd, 2);
    expect(mine.months[2]!.accounts.dop).toBeCloseTo(reference.months[2]!.accounts.dop, 2);
    expect(reference.months[2]!.accounts).toEqual({ usd: 4320, dop: 86400 });
  });

  it('the sample data of the app, viewed in Spanish, gives that same workbook except for the texts the user typed and the balances', async () => {
    const { api } = fresh();
    expect((await api.post('/api/dev/seed')).status).toBe(200);
    expect((await api.patch('/api/settings', { language: 'es' })).status).toBe(200);
    const mine = parseFinanzasXlsx(await exportXlsx(api));
    const reference = parseFinanzasXlsx(REFERENCE);
    // Same figures, dates, categories and methods (what is translated); different names and descriptions (what is not).
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
    // The workbook's balances are those of the app's accounts at the end of each month: October's, 13,482 and 220,641.93.
    const state = await getState(api);
    expect(mine.months.map((m) => [m.accounts.usd, Math.round(m.accounts.dop * 100) / 100])).toEqual(
      ['2026-08', '2026-09', '2026-10'].map((key) => monthEnd(state, key).map(([, balance]) => balance)),
    );
    expect(mine.months[2]!.accounts.usd).toBe(13482);
  });

  it('export → import → export gives the same workbook', async () => {
    const source = fresh();
    // A fourth goal, in Spanish, so that the workbook is not a version 1 one (further down).
    const mine = seedWithFormerGoalNames();
    mine.goals.push({ id: 'carro', name: 'Carro', cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: 3 });
    await replaceAll(source.db, FRANK.id, mine);
    const first = await exportXlsx(source.api);

    // In another database, into another user who also uses the app in Spanish and has nothing of their own: their two
    // accounts, an empty October and no goals (the initial ones were deleted, or they would stay with the workbook's four).
    const target = fresh();
    await target.eda.patch('/api/settings', { language: 'es' });
    await resetAll(target.db, EDA.id, '2026-10');
    for (const goal of DEFAULT_GOALS) expect((await target.eda.del(`/api/goals/${goal.id}`)).status).toBe(200);
    await importXlsx(target.eda, first);
    expectSameBook(parseFinanzasXlsx(await exportXlsx(target.eda)), parseFinanzasXlsx(first));
    expect((await getState(target.eda)).goals.map((g) => g.name)).toEqual(['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía', 'Carro']);

    // Importing again on top of what is already there changes nothing either (the months are replaced, not duplicated).
    const once = await getState(target.eda);
    await importXlsx(target.eda, first);
    expect(comparable(await getState(target.eda))).toEqual(comparable(once));
  });

  it('someone who still has the three version 1 goals in Spanish can load their own workbook again without duplicating them', async () => {
    const { api, db } = fresh();
    // With only those three goals and in Spanish, his workbook is a version 1 one: the reader renames its goals to today's…
    await replaceAll(db, FRANK.id, seedWithFormerGoalNames());
    const before = await getState(api);
    expect(before.goals.map((g) => g.name)).toEqual(['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía']);
    const first = await exportXlsx(api);
    expect(parseFinanzasXlsx(first).goals!.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey']);

    // …but on applying it, the ones he has under the old name are what counts: no new goals, no moved contributions.
    await importXlsx(api, first);
    const after = await getState(api);
    expect(after.goals).toEqual(before.goals);
    expect(comparable(after).contribs).toEqual(comparable(before).contribs);
    // And his next workbook carries the same three goals with the same contributions.
    const [again, original] = [parseFinanzasXlsx(await exportXlsx(api)), parseFinanzasXlsx(first)];
    expect(again.goals).toEqual(original.goals);
    expect(again.contribs).toEqual(original.contribs);
  });

  it('that same workbook, in a user who has the goals under their current name, lands in them', async () => {
    const { api, eda, db } = fresh();
    await replaceAll(db, FRANK.id, seedWithFormerGoalNames());
    const first = await exportXlsx(api);

    // Eda has visited before: she has the two initial goals.
    const mine = await getState(eda);
    expect(mine.goals.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings']);
    await importXlsx(eda, first);
    const hers = await getState(eda);
    expect(hers.goals.map((g) => [g.name, g.cur, g.monthly, g.start, g.end])).toEqual([
      ['Emergency fund', 'USD', null, null, null],
      ['Personal savings', 'USD', null, null, null],
      ['Trip to Turkey', 'USD', 3000, '2026-08', '2027-10'],
    ]);
    // The two she already had are the same rows, not new ones with the same name.
    expect(hers.goals.slice(0, 2).map((g) => g.id)).toEqual(mine.goals.map((g) => g.id));
    const byGoal = (name: string) => hers.contribs.filter((c) => c.goalId === hers.goals.find((g) => g.name === name)!.id).length;
    expect([byGoal('Emergency fund'), byGoal('Personal savings'), byGoal('Trip to Turkey')]).toEqual([3, 2, 3]);
  });

  it('export → import → export also gives the same workbook in English and in Turkish', async () => {
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

  it('the JSON variant (what the web sends after reading the file in the browser) leaves the same as the raw .xlsx', async () => {
    const raw = fresh();
    await importXlsx(raw.api, REFERENCE);

    const json = fresh();
    const r = await json.api.post<ImportResponse>('/api/import', parseFinanzasXlsx(REFERENCE));
    expect(r.status).toBe(200);
    expect(comparable(await getState(json.api))).toEqual(comparable(await getState(raw.api)));
  });
});

describe('end to end: a hand-edited Excel', () => {
  it('a negative amount rejects the whole file, says where it is and changes nothing', async () => {
    const { api } = fresh();
    await api.post('/api/dev/seed');
    const before = await getState(api);

    // The app never stores negative amounts; they can only arrive in a workbook touched up in Excel.
    for (const locale of [undefined, EXCEL_ES]) {
      const edited = seedState();
      edited.months['2026-10']!.tx[3]!.amount = -900;
      const res = await api.raw('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': XLSX_MIME },
        body: buildFinanzasXlsx(buildExportData(edited), locale ? { locale } : {}),
      });
      expect(res.status).toBe(400);
      // The notice is in English even if the workbook is in another language.
      expect(await res.json()).toEqual({
        error: { code: 'validation', message: 'Invalid data: months.2.tx.3.amount: cannot be negative' },
      });
    }
    expect(await getState(api)).toEqual(before);
  });
});

describe('end to end: what Claude records reaches the web and the Excel', () => {
  /** Noon on October 7, 2026 in Santo Domingo. */
  const NOW = new Date('2026-10-07T16:00:00Z');
  const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('add_transaction through /mcp and POST /api/ingest/transaction show up in /api/state and in the workbook of that user', async () => {
    const { api, eda, env, db } = fresh();
    await api.post('/api/dev/seed');
    await eda.post('/api/dev/seed');
    const edaBefore = await loadState(db, EDA.id);
    const drBefore = monthEnd(await getState(api), '2026-10')[1]![1];

    // Frank dictates to Claude in Spanish: the category arrives as 'Transporte' and is stored as 'Transport'.
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

    // And through the API, saying by name which account it comes out of.
    const ingest = await client(env, null).post(
      '/api/ingest/transaction',
      { user: 'frank', date: '2026-10-06', description: 'Colmado', amount: 12.5, account: 'us account' },
      AUTH,
    );
    expect(ingest.status).toBe(201);

    const state = await getState(api);
    const fromClaude = state.months['2026-10']!.tx.filter((t) => t.source === 'claude');
    expect(fromClaude.map((t) => [t.date, t.desc, t.cat, t.method, t.amount, t.cur, t.accountId])).toEqual([
      // No account: Frank's default one ('dr'), in its currency.
      ['2026-10-07', 'Uber', 'Transport', 'Debit card', 850, 'DOP', 'dr'],
      ['2026-10-06', 'Colmado', 'Food', 'Debit card', 12.5, 'USD', 'us'],
    ]);
    // Both expenses have already been subtracted from their accounts.
    expect(monthEnd(state, '2026-10')).toEqual([
      ['us', 13482 - 12.5],
      ['dr', Math.round((drBefore - 850) * 100) / 100],
    ]);

    const october = parseFinanzasXlsx(await exportXlsx(api)).months.find((m) => m.key === '2026-10')!;
    expect(october.tx).toHaveLength(9);
    expect(october.tx).toContainEqual({ date: '2026-10-07', desc: 'Uber', place: '', cat: 'Transport', method: 'Debit card', amount: 850, cur: 'DOP', notes: '' });
    expect(october.tx).toContainEqual({ date: '2026-10-06', desc: 'Colmado', place: '', cat: 'Food', method: 'Debit card', amount: 12.5, cur: 'USD', notes: '' });
    expect(october.accounts.usd).toBeCloseTo(13482 - 12.5, 2);

    // None of that reached Eda's finances or her workbook.
    expect(await loadState(db, EDA.id)).toEqual(edaBefore);
    expect(parseFinanzasXlsx(await exportXlsx(eda)).months.find((m) => m.key === '2026-10')!.tx).toHaveLength(7);
  });

  it('closing the month through the API: the workbook gains the sheet of the next month, with the fixed expenses unpaid', async () => {
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
    // The budget is copied; the income is not: it is the sum of November's incomes, and there are none yet.
    expect([november.budget, november.incomeUSD]).toEqual([70000, 0]);
    // Nothing has moved yet in November: the balances are October's.
    expect(november.accounts.usd).toBeCloseTo(book.months[2]!.accounts.usd, 2);
    expect(november.accounts.dop).toBeCloseTo(book.months[2]!.accounts.dop, 2);

    // Eda's workbook still has its three months.
    expect(parseFinanzasXlsx(await exportXlsx(eda)).months.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);
  });
});
