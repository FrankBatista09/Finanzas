// Real round trip (nothing mocked): what GET /api/export.xlsx exports can be loaded back with
// POST /api/import, whatever the workbook's language.
//
// The workbook keeps the original design, which only knows two currencies and two accounts: it is a summary of the
// state, not a copy (shared/excel/data.ts says what is lost in each direction, and tests it). With the sample data—one
// account in USD and another in DOP, which is exactly what the workbook can represent—the round trip returns the same
// history except for what the workbook does not carry: the hand-typed rate and each income's description.

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
 * What the workbook carries back and forth of a state, without what an import assigns anew (ids, source, creation
 * or closing dates) or what does not travel in it (settings, typed rates, the detail of the incomes).
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

/** The state's figures, without the texts the user typed: for comparing workbooks in different languages. */
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

/** Balance of each visible account at the end of each month, rounded to the cent. */
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

/** What must be left after loading the sample-data workbook into a user who only has their two initial accounts. */
function expectSeedHistory(state: AppState) {
  const seed = seedState();
  // Months, fixed expenses, transfers, transactions (each in its account), budget, goals and contributions: the same.
  expect(content(state)).toEqual(content(seed));
  // The two accounts, with the same balance at the end of each month (and therefore the same opening balance).
  expect(state.accounts.map((a) => [a.id, a.currency, a.hidden])).toEqual(seed.accounts.map((a) => [a.id, a.currency, a.hidden]));
  expect(monthEndBalances(state)).toEqual(monthEndBalances(seed));
  expect(state.accounts[0]!.opening).toBeCloseTo(2000, 6);
  expect(state.accounts[1]!.opening).toBeCloseTo(60000, 6);
  // Each month's income arrives as one income on day 1, into the USD account: the description does not travel.
  expect(state.incomes.map((i) => [i.date, i.desc, i.accountId, i.amount, i.cur])).toEqual(
    seed.incomes.map((i) => [i.date, IMPORTED_INCOME, i.accountId, i.amount, i.cur]),
  );
  // Nor does October's hand-typed rate: the workbook (and the app, on the way back) get it from the month's transfers.
  for (const m of Object.values(state.months)) expect(m.rates).toEqual([]);
  expect(rateFor(state, '2026-10', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'transfers', monthKey: '2026-10', date: null });
  // With all that, each month's figures are the same.
  for (const key of Object.keys(seed.months)) {
    const [mine, theirs] = [monthCalc(state, key), monthCalc(seed, key)];
    expect(mine.used).toBeCloseTo(theirs.used, 6);
    expect(mine.budget).toBeCloseTo(theirs.budget, 6);
    expect(mine.income).toBeCloseTo(theirs.income, 6);
    expect(mine.saved).toBeCloseTo(theirs.saved, 6);
  }
}

describe('Excel: real export and import', () => {
  for (const { id: language, name } of LANGUAGES) {
    it(`with the workbook in ${name}: exporting the sample data, emptying and importing the file returns the same history`, async () => {
      const { env, db } = makeEnv();
      const api = client(env);
      await replaceAll(db, F, { ...seedState(), language });
      // Eda has the same, in another language, and notices nothing.
      await replaceAll(db, E, seedState());
      const eda = await loadState(db, E);

      const bytes = await download(api);
      // An .xlsx is a zip: it starts with "PK".
      expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);

      await resetAll(db, F, '2026-10');
      const res = await upload(api, bytes);
      expect(res.status).toBe(200);
      expect((await res.json()) as ImportResponse).toEqual({ months: ['2026-08', '2026-09', '2026-10'], contributions: 8 });

      const state = await loadState(db, F);
      // What is stored does not depend on the workbook's language: categories and methods come back with canonical names.
      expectSeedHistory(state);
      for (const m of Object.values(state.months)) expect(m.tx.every((t) => t.source === 'import')).toBe(true);
      expect(state.language).toBe(language);
      expect(await loadState(db, E)).toEqual(eda);

      // And the workbook that comes out now says the same as the one that was loaded.
      expect(parseFinanzasXlsx(await download(api))).toEqual(parseFinanzasXlsx(bytes));
    });
  }

  it('a workbook exported in one language can be loaded with the app in another', async () => {
    const { env, db } = makeEnv();
    await replaceAll(db, F, { ...seedState(), language: 'tr' });
    const bytes = await download(client(env));

    // Eda, who uses the app in English and had never signed in, loads Frank's Turkish workbook.
    const res = await upload(client(env, E), bytes);
    expect(res.status).toBe(200);
    const state = await loadState(db, E);
    expectSeedHistory(state);
    expect(state.language).toBe('en');
  });

  it('loading your own workbook again on top of what is already there duplicates nothing', async () => {
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
    // Imported incomes are replaced (they keep their id), not added again.
    expect(twice.incomes).toEqual(once.incomes);
    expect(monthEndBalances(twice)).toEqual(monthEndBalances(once));
  });

  it('loads the reference workbook of the design (in Spanish)', async () => {
    const { env, db } = makeEnv();
    const file = fileURLToPath(import.meta.resolve('../design_handoff/referencia/Finanzas Personales v3.xlsx'));
    const res = await upload(client(env), new Uint8Array(readFileSync(file)));
    expect(res.status).toBe(200);
    const state = await loadState(db, F);
    // The same figures as the sample data (which come from that workbook), each expense in the account of its currency;
    // the categories and methods, with their canonical name, and the three goals of version 1, with today's name.
    expect(figures(state)).toEqual(figures(seedState()));
    // Descriptions, places and notes stay as they were in the workbook.
    expect(state.months['2026-10']!.tx[0]).toMatchObject({ desc: 'Compra semanal', cat: 'Groceries', method: 'Debit card', accountId: 'dr' });
    expect(state.months['2026-10']!.fixed.find((f) => f.cur === 'USD')).toMatchObject({ name: 'Claude', accountId: 'us' });
    // The workbook's balances (those of its last month) are now those of the two accounts.
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

  it('with a third currency and more accounts the workbook still exports and loads: what it cannot write is converted', async () => {
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
    mine.incomes.push({ id: 'maas', date: '2026-10-15', desc: 'Maaş', accountId: 'tr', amount: 20000, cur: 'TRY', budget: false, rate: null, recurring: false });
    mine.goals.push({ id: 'flat', name: 'Istanbul flat', cur: 'TRY', monthly: 10000, start: '2026-10', end: '2027-09', approxCur: null, sort: 3 });
    mine.contribs.push({ id: 'c-try', goalId: 'flat', date: '2026-10-09', amount: 4000, cur: 'TRY', rate: null });
    await replaceAll(db, F, mine);

    const bytes = await download(client(env));
    const book = parseFinanzasXlsx(bytes);
    expect(book.months.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    // The workbook only has DOP and USD; the transaction in liras is there, converted.
    const rows = [...book.months.flatMap((m) => [...m.fixed, ...m.tx]), ...(book.contribs ?? [])];
    expect(new Set(rows.map((r) => r.cur))).toEqual(new Set(['DOP', 'USD']));
    expect(book.months[2]!.tx.map((t) => t.desc)).toContain('Baklava');
    expect(book.goals!.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Istanbul flat']);

    // Eda loads it: it reaches her as a history in her two accounts, with her own currencies.
    const res = await upload(client(env, E), bytes);
    expect(res.status).toBe(200);
    const hers = await loadState(db, E);
    expect([hers.mainCurrency, hers.secondCurrency]).toEqual(['DOP', 'USD']);
    expect(hers.accounts.map((a) => a.id)).toEqual(['us', 'dr']);
    expect(hers.months['2026-10']!.tx).toHaveLength(8);
    expect(hers.contribs).toHaveLength(9);
    // And nothing changed for Frank.
    expect((await loadState(db, F)).accounts.map((a) => a.id)).toEqual(['us', 'dr', 'tr']);
  });

  it('a file that is not an .xlsx: 400 validation and the database stays the same', async () => {
    const { env, db } = makeEnv();
    await replaceAll(db, F, seedState());
    const before = await loadState(db, F);
    const res = await upload(client(env), new TextEncoder().encode('esto no es un excel'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation');
    expect(await loadState(db, F)).toEqual(before);
  });
});
