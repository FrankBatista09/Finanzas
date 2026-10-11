// End to end with two users and all the real pieces (API + D1 + Excel generator and reader): what can only be
// checked once all of them exist. Frank and Eda start with the same sample data—the same ids and the same
// accounts included—and Eda changes her own: a transaction, an income, a goal with a plan, a contribution, her
// colors and her language. From then on, nothing of one user's may show up in the other's: not in the state, not in
// the balances, not in the Excel, not on import.
//
// The Excel workbook is a summary of the state with the original design (shared/excel/data.ts): what has to come
// out of reading each user's is the projection of THEIR state, and what loading it leaves is what that bridge says.

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

/** Names of the workbook's sheets, in their order. */
function sheetNames(bytes: Uint8Array): string[] {
  const workbook = unzipText(bytes).get('xl/workbook.xml') ?? '';
  return [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => m[1]!);
}

const sorted = <T>(rows: readonly T[]): T[] => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/**
 * What has to come out of reading that state's workbook: its projection onto the workbook's shape (buildExportData),
 * with every month closed except the last. The order of the rows within a table is not part of the
 * comparison (the sheet sorts the contributions by date).
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

/** A workbook already read, with the tables in the same neutral order as `asWorkbook`. */
function readWorkbook(bytes: Uint8Array): ImportPayload {
  const book = parseFinanzasXlsx(bytes);
  return {
    ...book,
    months: book.months.map((m) => ({ ...m, transfers: sorted(m.transfers), tx: sorted(m.tx) })),
    contribs: book.contribs && sorted(book.contribs),
  };
}

/** A workbook without the figures that are computed over the whole history: the month's income and the balances. */
function rows(book: ImportPayload) {
  return { ...book, months: book.months.map(({ incomeUSD: _income, accounts: _accounts, ...m }) => m) };
}

/** Two workbooks say the same thing; the balances, which are computed numbers, are compared to the cent. */
function expectSameBook(actual: ImportPayload, expected: ImportPayload) {
  expect(rows(actual)).toEqual(rows(expected));
  actual.months.forEach((m, i) => {
    const want = expected.months[i]!;
    expect(m.incomeUSD, `${m.key} income`).toBeCloseTo(want.incomeUSD, 6);
    expect(m.accounts.usd, `${m.key} usd`).toBeCloseTo(want.accounts.usd, 2);
    expect(m.accounts.dop, `${m.key} dop`).toBeCloseTo(want.accounts.dop, 2);
  });
}

/** Balance of each account at the end of `asOf`, rounded to the cent. */
function monthEnd(state: AppState, asOf: string): [string, number][] {
  return balances(state, asOf).accounts.map((a) => [a.account.id, Math.round(a.balance * 100) / 100]);
}

/**
 * The two users with the sample data and Eda's changes. It also returns what Eda added, to be able to
 * say exactly what each one has.
 */
async function twoUsers() {
  const t = makeEnv({ ALLOW_DEV_RESET: '1' });
  const frank = client(t.env);
  const eda = client(t.env, EDA.id);
  expect((await frank.post('/api/dev/seed')).status).toBe(200);
  expect((await eda.post('/api/dev/seed')).status).toBe(200);

  const settings = await eda.patch<SettingsResponse>('/api/settings', { language: 'tr', theme: OCEAN });
  expect(settings.body).toEqual({ language: 'tr', theme: OCEAN, mainCurrency: 'DOP', secondCurrency: 'USD', defaultAccountId: 'dr', goldPrice: null });
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

describe('end to end: two users with the same starting finances', () => {
  it('GET /api/state for each one returns only their data, their balances and their settings', async () => {
    const { frank, eda, added } = await twoUsers();
    const seed = seedState();

    const his = await getState(frank);
    expect(his.user).toEqual(FRANK);
    // Frank still has exactly the sample data, in English and with the original palette.
    expect(withoutTimestamps(his.state)).toEqual(seed);

    const hers = await getState(eda);
    expect(hers.user).toEqual(EDA);
    expect(hers.state.language).toBe('tr');
    expect(hers.state.theme).toEqual(OCEAN);
    expect(hers.state.accounts).toEqual(seed.accounts);
    expect(hers.state.goals).toEqual([...seed.goals, { id: added.goal.id, name: 'Ev', cur: 'USD', monthly: 500, start: '2026-10', end: '2027-09', approxCur: null, sort: 3 }]);
    expect(hers.state.contribs).toEqual([...seed.contribs, added.contribution]);
    expect(hers.state.incomes).toEqual([...seed.incomes, added.income]);
    expect(withoutTimestamps(hers.state).months).toEqual({
      ...seed.months,
      '2026-10': { ...seed.months['2026-10']!, tx: [...seed.months['2026-10']!.tx, { ...added.tx, createdAt: null, accountId: 'dr' }] },
    });

    // The accounts have the same name and the same id, but each one carries its own: Eda had 300 USD come in
    // and 250 DOP go out; Frank, nothing.
    expect(monthEnd(his.state, '2026-10')).toEqual([
      ['us', 13482],
      ['dr', 220641.93],
    ]);
    expect(monthEnd(hers.state, '2026-10')).toEqual([
      ['us', 13782],
      ['dr', 220391.93],
    ]);

    // What Eda added does not exist for Frank, not even when asking for it by its id.
    expect((await frank.patch(`/api/transactions/${added.tx.id}`, { amount: 1 })).status).toBe(404);
    expect((await frank.patch(`/api/incomes/${added.income.id}`, { amount: 1 })).status).toBe(404);
    expect((await frank.patch(`/api/goals/${added.goal.id}`, { name: 'Casa' })).status).toBe(404);
    expect((await frank.del(`/api/contributions/${added.contribution.id}`)).status).toBe(404);
    expect((await getState(eda)).state).toEqual(hers.state);
  });

  it('the Excel of each one comes out in their language and, read back, is the projection of their own state', async () => {
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
    // In the workbook the categories and methods are in Turkish; on reading it they go back to their canonical name.
    const strings = unzipText(edaBook.bytes).get('xl/sharedStrings.xml') ?? [...unzipText(edaBook.bytes).values()].join('');
    expect(strings).toContain('Banka uygulaması');
    expectSameBook(readWorkbook(edaBook.bytes), asWorkbook(hers));

    // And they are two different workbooks: Frank's carries nothing of what Eda added.
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
    // Her October income and the balance of her USD account include the 300 she was paid.
    expect(edaRead.months[2]!.incomeUSD).toBe(6100);
    expect(edaRead.months[2]!.accounts.usd).toBe(13782);
  });

  it('loading the workbook from Eda into Frank changes only Frank', async () => {
    const { frank, eda, db } = await twoUsers();
    const edaBefore = await loadState(db, EDA.id);
    const frankBefore = (await getState(frank)).state;
    const { bytes } = await exportXlsx(eda);

    expect(await importXlsx(frank, bytes)).toEqual({ months: ['2026-08', '2026-09', '2026-10'], contributions: 9 });

    // Eda does not notice: not one of her rows changed (ids, creation dates and settings included).
    expect(await loadState(db, EDA.id)).toEqual(edaBefore);

    // Frank now has the rows of Eda's workbook (fixed expenses, transfers, transactions, goals and contributions)…
    const frankAfter = (await getState(frank)).state;
    expect(rows(asWorkbook(frankAfter))).toEqual(rows(asWorkbook(edaBefore)));
    expect(Object.values(frankAfter.months).flatMap((m) => m.tx).every((t) => t.source === 'import')).toBe(true);
    // …in his own rows and accounts: his three goals are still the same (same id) and Eda's was created for him separately.
    expect(frankAfter.accounts.map((a) => a.id)).toEqual(frankBefore.accounts.map((a) => a.id));
    expect(frankAfter.goals.slice(0, 3)).toEqual(frankBefore.goals);
    expect(frankAfter.goals[3]).toMatchObject({ name: 'Ev', cur: 'USD', monthly: 500, start: '2026-10', end: '2027-09', approxCur: null, sort: 3 });
    expect(frankAfter.goals[3]!.id).not.toBe(edaBefore.goals[3]!.id);
    // …with the balances the workbook carried, which are Eda's at the end of October…
    expect(monthEnd(frankAfter, '2026-10')).toEqual(monthEnd(edaBefore, '2026-10'));
    // …without losing the incomes he had already recorded…
    expect(frankAfter.incomes).toEqual(expect.arrayContaining(frankBefore.incomes));
    // …and with his own settings: the language, the colors and the currencies do not travel in the workbook.
    expect([frankAfter.language, frankAfter.theme, frankAfter.mainCurrency, frankAfter.defaultAccountId]).toEqual(['en', null, 'DOP', 'dr']);
    // His next Excel comes out in English, with the rows he loaded.
    const again = await exportXlsx(frank);
    expect(sheetNames(again.bytes)).toEqual(['August 2026', 'September 2026', 'October 2026', 'Savings', 'Config']);
    expect(rows(readWorkbook(again.bytes))).toEqual(rows(asWorkbook(edaBefore)));
  });
});

describe('end to end: the version 1 workbook (in Spanish) in a user with no data', () => {
  /** What is checked the same way whether or not they had visited the app before. */
  function expectImportedReference(state: AppState) {
    const tx = Object.values(state.months).flatMap((m) => m.tx);
    expect(tx).toHaveLength(27);
    // Categories and methods: always their canonical name, even if the workbook has them in Spanish.
    expect(tx.every((t) => (CATS as readonly string[]).includes(t.cat))).toBe(true);
    expect(tx.every((t) => (METHODS as readonly string[]).includes(t.method))).toBe(true);
    // The user's texts, as they were in the workbook; the figures, those of the sample data.
    expect(tx.slice(0, 2).map((t) => t.desc)).toEqual(['Compra semanal', 'Uber']);
    const seedTx = Object.values(seedState().months).flatMap((m) => m.tx);
    expect(tx.map((t) => [t.date, t.cat, t.method, t.amount, t.cur, t.accountId])).toEqual(
      seedTx.map((t) => [t.date, t.cat, t.method, t.amount, t.cur, t.accountId]),
    );
    // Everything in their two initial accounts, which end up with the workbook's balances.
    expect(state.accounts.map((a) => [a.id, a.name, a.currency])).toEqual(DEFAULT_ACCOUNTS.map((a) => [a.id, a.name, a.currency]));
    expect(monthEnd(state, '2026-10')).toEqual([
      ['us', 4320],
      ['dr', 86400],
    ]);

    // Goals: the two initial ones with their English name (not duplicated in Spanish) and the trip one with its plan.
    expect(state.goals.map(({ name, cur, monthly, start, end, sort }) => ({ name, cur, monthly, start, end, sort }))).toEqual(
      [...DEFAULT_GOALS, SEED_PLANNED_GOAL].map(({ name, cur, monthly, start, end, sort }) => ({ name, cur, monthly, start, end, sort })),
    );
    const goalName = new Map(state.goals.map((g) => [g.id, g.name]));
    const perGoal = (name: string) => state.contribs.filter((c) => goalName.get(c.goalId) === name).reduce((sum, c) => sum + c.amount, 0);
    expect([perGoal('Emergency fund'), perGoal('Personal savings'), perGoal('Trip to Turkey')]).toEqual([1200, 450, 9000]);
  }

  it('who had never visited: on opening the app they find their data, with the initial accounts and goals', async () => {
    const { env } = makeEnv();
    const eda = client(env, EDA.id);
    await importXlsx(eda, REFERENCE);

    const { state } = await getState(eda);
    expectImportedReference(state);
    // The first visit does not create the initial goals or accounts for her again.
    expect(state.goals).toHaveLength(3);
    expect(state.goals.slice(0, 2).map((g) => g.id)).toEqual(DEFAULT_GOALS.map((g) => g.id));
    expect(state.accounts).toHaveLength(2);

    // Frank, who had not visited either, finds a brand-new app.
    const his = (await getState(client(env))).state;
    expect(his.goals).toEqual([...DEFAULT_GOALS]);
    expect(his.accounts).toEqual([...DEFAULT_ACCOUNTS]);
    expect(his.contribs).toEqual([]);
    expect(his.incomes).toEqual([]);
    expect(Object.values(his.months).flatMap((m) => [...m.fixed, ...m.transfers, ...m.tx])).toEqual([]);
  });

  it('who had already visited: the contributions land in the initial goals they already had, without creating others', async () => {
    const { env } = makeEnv();
    const eda = client(env, EDA.id);
    const before = (await getState(eda)).state;
    expect(before.goals).toEqual([...DEFAULT_GOALS]);
    await eda.patch('/api/settings', { language: 'tr', mainCurrency: 'TRY', secondCurrency: 'DOP' });

    await importXlsx(eda, REFERENCE);
    const { state } = await getState(eda);
    expectImportedReference(state);
    expect(state.goals.slice(0, 2)).toEqual([...DEFAULT_GOALS]);
    // The month she already had and the workbook does not carry is still there, and her settings, as she left them.
    expect(Object.keys(state.months)).toEqual(expect.arrayContaining(Object.keys(before.months)));
    expect([state.language, state.mainCurrency, state.secondCurrency]).toEqual(['tr', 'TRY', 'DOP']);
  });
});
