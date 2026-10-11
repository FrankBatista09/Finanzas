import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportPayload } from '../shared/api';
import { balances, defaultAccount, monthCalc, rateFor } from '../shared/calc';
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_GOALS,
  DEFAULT_MAIN_CURRENCY,
  DEFAULT_RATE,
  DEFAULT_SECOND_CURRENCY,
} from '../shared/constants';
import { applyImportToState, IMPORTED_INCOME } from '../shared/excel/data';
import { seedState, SEED_ACCOUNTS, SEED_PLANNED_GOAL, setBudgets } from '../shared/seed';
import type { AppState, FixedExpense, Month } from '../shared/types';
import {
  applyImport,
  closeMonth,
  createAccount,
  createContribution,
  createFixed,
  createGoal,
  createIncome,
  createTransaction,
  createTransfer,
  deleteAccount,
  deleteBudgetEntry,
  deleteContribution,
  deleteFixed,
  deleteGoal,
  deleteIncome,
  deleteMonth,
  deleteMonthRate,
  deleteTransaction,
  deleteTransfer,
  ensureMonth,
  getMonth,
  getSettings,
  initUser,
  listAccounts,
  listContributions,
  listGoals,
  listIncomes,
  listMonths,
  loadState,
  openState,
  patchAccount,
  patchContribution,
  patchFixed,
  patchGoal,
  patchIncome,
  patchMonth,
  patchTransaction,
  patchTransfer,
  reopenMonth,
  replaceAll,
  resetAll,
  setMonthRate,
  updateSettings,
  userAccounts,
  userState,
} from './db';
import { ApiError } from './errors';
import { count, EDA, FRANK, makeEnv, withoutTimestamps } from './test-util';

// Almost every test acts as Frank; Eda sits alongside with the same data (same ids, same months,
// same accounts).
const F = FRANK.id;
const E = EDA.id;

const core = (f: FixedExpense) => ({ name: f.name, day: f.day, amount: f.amount, cur: f.cur, accountId: f.accountId, sort: f.sort });

const EMPTY: AppState = {
  months: {},
  accounts: [],
  incomes: [],
  goals: [],
  contribs: [],
  cards: [],
  mainCurrency: DEFAULT_MAIN_CURRENCY,
  secondCurrency: DEFAULT_SECOND_CURRENCY,
  defaultAccountId: null,
  defaultRate: DEFAULT_RATE,
  goldPrice: null,
  theme: null,
  language: 'en',
};

const emptyMonth = (key: string): Month => ({ key, closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] });

const DEFAULT_SETTINGS = { theme: null, language: 'en', mainCurrency: 'DOP', secondCurrency: 'USD', defaultAccountId: null, goldPrice: null };

const invalid = { status: 400, code: 'validation' };
const notFound = { status: 404, code: 'not_found' };
const conflict = { status: 409, code: 'conflict' };
const closedMonth = { status: 409, code: 'month_closed' };
const unknownAccount = (id: string) => ({ ...invalid, message: `Unknown account "${id}".` });

/** Balance of an account at the end of `asOf`, computed as the web app does: shared/calc over the loaded state. */
async function balance(db: D1Database, userId: string, accountId: string, asOf = '2026-10'): Promise<number> {
  return balances(await loadState(db, userId), asOf).accounts.find((a) => a.account.id === accountId)!.balance;
}

let bystander: { db: D1Database; before: AppState } | null = null;

/** Both users with the sample data. When the test ends, Eda's data is checked to still be intact. */
async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, E, seedState());
  bystander = { db: t.db, before: await loadState(t.db, E) };
  return t;
}

/** Both users, newly arrived: their initial accounts and goals and October 2026, empty. */
async function arrived() {
  const t = makeEnv();
  await openState(t.db, F, '2026-10');
  await openState(t.db, E, '2026-10');
  bystander = { db: t.db, before: await loadState(t.db, E) };
  return t;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const watched = bystander;
  bystander = null;
  // Nothing a test does as Frank may touch Eda's data.
  if (watched) expect(await loadState(watched.db, E)).toEqual(watched.before);
});

/** A D1 that runs `before(n)` right before the nth write or read: it simulates another request slipping in between. */
function interleaved(db: D1Database, before: (call: number) => void, what: 'batch' | 'prepare' = 'batch'): D1Database {
  let calls = 0;
  return {
    prepare: (query: string) => {
      if (what === 'prepare') before(++calls);
      return db.prepare(query);
    },
    batch: (statements: D1PreparedStatement[]) => {
      if (what === 'batch') before(++calls);
      return db.batch(statements);
    },
  } as unknown as D1Database;
}

describe('loadState / replaceAll', () => {
  it('freshly migrated database: a user who never visited comes out empty, with the default currencies, rate, language and palette', async () => {
    const { db, sqlite } = makeEnv();
    expect(await loadState(db, F)).toEqual(EMPTY);
    // Reading creates nothing.
    for (const table of ['months', 'accounts', 'goals', 'settings']) expect(count(sqlite, table)).toBe(0);
  });

  it('replaceAll(seedState()) and loadState return exactly the sample data (except createdAt)', async () => {
    const { db } = await seeded();
    const state = await loadState(db, F);
    expect(withoutTimestamps(state)).toEqual(seedState());
    for (const m of Object.values(state.months)) {
      for (const t of m.tx) expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('amounts lose no precision going through the database: same calculations and same balances as with the sample data', async () => {
    const { db } = await seeded();
    const state = await loadState(db, F);
    const seed = seedState();
    // Same numbers → same calculations the frontend would do with the sample data.
    expect(monthCalc(state, '2026-10')).toEqual(monthCalc(seed, '2026-10'));
    expect(balances(state, '2026-10')).toEqual(balances(seed, '2026-10'));
    expect(balances(state, '2026-08')).toEqual(balances(seed, '2026-08'));
    expect(state.months['2026-10']!.fixed[0]!.amount).toBe(1337.15);
  });

  it('replaceAll replaces everything the user has: accounts, months, incomes, goals, contributions and all their settings', async () => {
    const { db, sqlite } = await seeded();
    const other = seedState();
    other.defaultRate = 60.5;
    other.language = 'tr';
    other.theme = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };
    other.mainCurrency = 'TRY';
    other.secondCurrency = 'DOP';
    other.defaultAccountId = 'tr';
    other.accounts.push({ id: 'tr', name: 'TR account', currency: 'TRY', opening: -150.5, hidden: true, sort: 2 });
    other.goals = [{ id: 'g1', name: 'Única', cur: 'TRY', monthly: null, start: null, end: null, approxCur: null, sort: 0 }];
    other.contribs = [{ id: 'c1', goalId: 'g1', date: '2026-10-01', amount: 10, cur: 'TRY', rate: null, accountId: null }];
    other.incomes = [{ id: 'i1', date: '2027-03-15', desc: 'Maaş', accountId: 'tr', amount: 90000, cur: 'TRY', budget: true, rate: null, recurring: false }];
    setBudgets(other.months['2026-10']!, { dr: 50000, tr: 12000.5 });
    other.months['2026-10']!.budgetLog.push({ id: 'cut', date: '2026-10-09', accountId: 'tr', amount: -2000.5, kind: 'adjust', note: 'Menos' });
    other.months['2026-10']!.budgets = { dr: 50000, tr: 10000 };
    other.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-01' },
      { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 59.5, date: '2026-10-06' },
    ];
    other.months['2026-10']!.transfers.push({
      id: 't-try', monthKey: '2026-10', date: '2026-10-08', via: 'Wise', fromAccountId: 'us', toAccountId: 'tr', amount: 100, rate: 40.2, budget: true, fee: 0,
    });
    delete other.months['2026-08'];
    await replaceAll(db, F, other);
    expect(withoutTimestamps(await loadState(db, F))).toEqual(other);
    expect(count(sqlite, 'months', F)).toBe(2);
    expect(count(sqlite, 'months', E)).toBe(3);
    expect(count(sqlite, 'accounts', F)).toBe(3);
    expect(count(sqlite, 'accounts', E)).toBe(2);
  });

  it('a budget part of 0 is not stored (it is the same as not having it), and neither is a rate the app would ignore', async () => {
    const { db, sqlite } = makeEnv();
    const state = seedState();
    // What gets stored is the log: `budgets` is its sum, and whatever the state carries does not count.
    state.months['2026-10']!.budgets = { dr: 1, us: 5 };
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 0, date: '2026-10-01' },
      // The same pair and the same date, reversed: the last one wins, which is the one rateFor uses.
      { from: 'DOP', to: 'USD', rate: 0.02, date: '2026-10-01' },
      // Another date for the same pair is indeed a different rate.
      { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-04' },
    ];
    await replaceAll(db, F, state);
    const october = (await loadState(db, F)).months['2026-10']!;
    expect(october.budgets).toEqual({ dr: 70000 });
    expect(october.rates).toEqual([
      { from: 'DOP', to: 'USD', rate: 0.02, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-04' },
    ]);
    expect(count(sqlite, 'month_budget_log')).toBe(4);
    expect(count(sqlite, 'month_rates')).toBe(2);
  });

  it('getMonth returns the whole month or null', async () => {
    const { db } = await seeded();
    const m = await getMonth(db, F, '2026-10');
    expect(m).toEqual((await loadState(db, F)).months['2026-10']);
    expect(m!.budgets).toEqual({ dr: 70000 });
    expect(m!.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
    ]);
    expect(m!.budgetLog.map((e) => [e.date, e.amount, e.kind])).toEqual([
      ['2026-10-01', 65000, 'initial'],
      ['2026-10-05', 5000, 'adjust'],
    ]);
    expect(m!.fixed).toHaveLength(11);
    expect(m!.transfers).toHaveLength(1);
    expect(m!.tx).toHaveLength(7);
    expect(await getMonth(db, F, '2030-01')).toBeNull();
  });

  it('listMonths summarizes each month in the main currency, with the figures from shared/calc', async () => {
    const { db } = await seeded();
    const seed = seedState();
    const list = await listMonths(db, F);
    expect(list.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    for (const s of list) {
      const c = monthCalc(seed, s.key);
      expect(s).toEqual({ key: s.key, closed: seed.months[s.key]!.closed, closedAt: null, main: 'DOP', budget: 70000, used: c.used, txCount: c.txCount });
    }

    // With another main currency, the same month comes out in it: 70,000 DOP at 58.76 is 1,191.29 USD.
    await updateSettings(db, F, { mainCurrency: 'USD', secondCurrency: 'DOP' });
    const october = (await listMonths(db, F))[2]!;
    expect(october.main).toBe('USD');
    expect(october.budget).toBeCloseTo(70000 / 58.76, 8);
    expect(october.used).toBeCloseTo(monthCalc(seed, '2026-10').used / 58.76, 8);
  });
});

describe('two users: each with their own finances', () => {
  it('they can have the same ids, the same accounts and the same months without clashing, and each reads only their own data', async () => {
    const { db, sqlite } = await seeded();
    // The sample data has fixed ids: it is in the database twice, once per user.
    expect(count(sqlite, 'months')).toBe(6);
    expect(count(sqlite, 'accounts')).toBe(4);
    expect(count(sqlite, 'month_budget_log')).toBe(8);
    expect(count(sqlite, 'month_rates')).toBe(4);
    expect(count(sqlite, 'fixed_expenses')).toBe(66);
    expect(count(sqlite, 'transactions')).toBe(54);
    expect(count(sqlite, 'transfers')).toBe(10);
    expect(count(sqlite, 'incomes')).toBe(6);
    expect(count(sqlite, 'goals')).toBe(6);
    expect(count(sqlite, 'contributions')).toBe(16);
    expect(count(sqlite, 'transactions', F)).toBe(27);

    await patchTransaction(db, F, 'seed-tx-2026-10-1', { amount: 1, desc: 'Solo de Frank' });
    await patchMonth(db, F, '2026-10', { budgets: { dr: 1, us: 2 } });
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' });
    await patchAccount(db, F, 'dr', { name: 'Banco de Frank', opening: 1 });
    await patchIncome(db, F, 'seed-in-1', { amount: 1 });
    expect((await getMonth(db, F, '2026-10'))!.tx[0]).toMatchObject({ id: 'seed-tx-2026-10-1', amount: 1, desc: 'Solo de Frank' });
    expect((await getMonth(db, E, '2026-10'))!.tx[0]).toMatchObject({ id: 'seed-tx-2026-10-1', amount: 4850, desc: 'Weekly groceries' });
    expect((await listMonths(db, E))[2]!.budget).toBe(70000);
    expect((await listMonths(db, F))[2]!.budget).toBe(1 + 2 * 60);
    expect((await listAccounts(db, E)).map((a) => a.name)).toEqual(['US account', 'DR account']);
    // Eda's balance in her 'dr' account is unaffected by any of this (afterEach checks it too).
    expect(await balance(db, E, 'dr')).toBeCloseTo(220641.93, 6);
  });

  it('a user with no data does not see the data of another', async () => {
    const { db } = makeEnv();
    await replaceAll(db, F, seedState());
    expect(await loadState(db, E)).toEqual(EMPTY);
    expect(await listMonths(db, E)).toEqual([]);
    expect(await getMonth(db, E, '2026-10')).toBeNull();
    expect(await listAccounts(db, E)).toEqual([]);
    expect(await listIncomes(db, E)).toEqual([]);
    expect(await listGoals(db, E)).toEqual([]);
    expect(await listContributions(db, E)).toEqual([]);
    expect(await getSettings(db, E)).toEqual(DEFAULT_SETTINGS);
  });

  it('an id that exists but belongs to another user behaves like one that does not exist', async () => {
    const { db } = await seeded();
    // Rows only Frank has.
    await createAccount(db, F, { id: 'acc-frank', name: 'PayPal', currency: 'USD' });
    await createFixed(db, F, { id: 'fx-frank', monthKey: '2026-10', name: 'Agua', amount: 500, cur: 'DOP' });
    await createTransaction(db, F, { id: 'tx-frank', monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' });
    await createTransfer(db, F, { id: 'tr-frank', monthKey: '2026-10', date: '2026-10-07', via: 'Wise', fromAccountId: 'us', toAccountId: 'acc-frank', amount: 1 });
    await createIncome(db, F, { id: 'in-frank', date: '2026-10-07', amount: 5, cur: 'USD', accountId: 'acc-frank' });
    await createGoal(db, F, { id: 'goal-frank', name: 'Car' });
    await createContribution(db, F, { id: 'ct-frank', goalId: 'goal-frank', date: '2026-10-07', amount: 5, cur: 'USD' });
    const before = await loadState(db, F);

    await expect(patchAccount(db, E, 'acc-frank', { hidden: true })).rejects.toMatchObject(notFound);
    await expect(patchAccount(db, E, 'acc-frank', {})).rejects.toMatchObject(notFound);
    await expect(deleteAccount(db, E, 'acc-frank')).rejects.toMatchObject(notFound);
    await expect(patchFixed(db, E, 'fx-frank', { paid: true })).rejects.toMatchObject(notFound);
    await expect(patchFixed(db, E, 'fx-frank', {})).rejects.toMatchObject(notFound);
    await expect(deleteFixed(db, E, 'fx-frank')).rejects.toMatchObject(notFound);
    await expect(patchTransaction(db, E, 'tx-frank', { amount: 2 })).rejects.toMatchObject(notFound);
    await expect(deleteTransaction(db, E, 'tx-frank')).rejects.toMatchObject(notFound);
    await expect(patchTransfer(db, E, 'tr-frank', { amount: 2 })).rejects.toMatchObject(notFound);
    await expect(patchTransfer(db, E, 'tr-frank', { toAccountId: 'dr' })).rejects.toMatchObject(notFound);
    await expect(deleteTransfer(db, E, 'tr-frank')).rejects.toMatchObject(notFound);
    await expect(patchIncome(db, E, 'in-frank', { amount: 9 })).rejects.toMatchObject(notFound);
    await expect(patchIncome(db, E, 'in-frank', {})).rejects.toMatchObject(notFound);
    await expect(deleteIncome(db, E, 'in-frank')).rejects.toMatchObject(notFound);
    await expect(patchGoal(db, E, 'goal-frank', { name: 'Mine now' })).rejects.toMatchObject(notFound);
    await expect(patchGoal(db, E, 'goal-frank', {})).rejects.toMatchObject(notFound);
    await expect(deleteGoal(db, E, 'goal-frank')).rejects.toMatchObject(notFound);
    await expect(patchContribution(db, E, 'ct-frank', { amount: 9 })).rejects.toMatchObject(notFound);
    await expect(patchContribution(db, E, 'ct-frank', {})).rejects.toMatchObject(notFound);
    await expect(deleteContribution(db, E, 'ct-frank')).rejects.toMatchObject(notFound);
    // Nor can she attach something of hers to someone else's goal: neither when creating nor when moving a contribution.
    await expect(createContribution(db, E, { goalId: 'goal-frank', date: '2026-10-07', amount: 5, cur: 'USD' })).rejects.toMatchObject({
      ...notFound,
      message: 'Goal not found.',
    });
    await expect(patchContribution(db, E, 'seed-ct-1', { goalId: 'goal-frank' })).rejects.toMatchObject(notFound);

    // Nor pay, get paid, transfer or budget with someone else's account: for her that account does not exist.
    const foreign = unknownAccount('acc-frank');
    const tx = { monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' as const };
    await expect(createTransaction(db, E, { ...tx, accountId: 'acc-frank' })).rejects.toMatchObject(foreign);
    await expect(patchTransaction(db, E, 'seed-tx-2026-10-1', { accountId: 'acc-frank' })).rejects.toMatchObject(foreign);
    await expect(createFixed(db, E, { monthKey: '2026-10', name: 'Agua', amount: 1, cur: 'DOP', accountId: 'acc-frank' })).rejects.toMatchObject(foreign);
    await expect(patchFixed(db, E, 'seed-fx-2026-10-1', { accountId: 'acc-frank' })).rejects.toMatchObject(foreign);
    const transfer = { monthKey: '2026-10', date: '2026-10-07', via: 'Wise', amount: 1 };
    await expect(createTransfer(db, E, { ...transfer, fromAccountId: 'us', toAccountId: 'acc-frank' })).rejects.toMatchObject(foreign);
    await expect(createTransfer(db, E, { ...transfer, fromAccountId: 'acc-frank', toAccountId: 'dr', rate: 58 })).rejects.toMatchObject(foreign);
    await expect(patchTransfer(db, E, 'seed-tr-2026-10-1', { toAccountId: 'acc-frank' })).rejects.toMatchObject(foreign);
    await expect(createIncome(db, E, { date: '2026-10-07', amount: 5, cur: 'USD', accountId: 'acc-frank' })).rejects.toMatchObject(foreign);
    await expect(patchIncome(db, E, 'seed-in-1', { accountId: 'acc-frank' })).rejects.toMatchObject(foreign);
    await expect(patchMonth(db, E, '2026-10', { budgets: { 'acc-frank': 100 } })).rejects.toMatchObject(foreign);
    await expect(updateSettings(db, E, { defaultAccountId: 'acc-frank' })).rejects.toMatchObject(foreign);

    expect(await loadState(db, F)).toEqual(before);
  });

  it('the same id works for a new row of each user; repeated within the same user, 409', async () => {
    const { db } = await seeded();
    const tx = { id: 'tx-igual', monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' as const };
    await createTransaction(db, F, tx);
    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    await createIncome(db, F, { id: 'in-igual', date: '2026-10-07', amount: 1, cur: 'USD' });
    bystander = null; // this test does write as Eda
    expect((await createTransaction(db, E, { ...tx, amount: 2 })).amount).toBe(2);
    // Same account (same id and same name) and same income, but another person's.
    expect((await createAccount(db, E, { id: 'pp', name: 'PayPal', currency: 'TRY' })).currency).toBe('TRY');
    expect((await createIncome(db, E, { id: 'in-igual', date: '2026-10-07', amount: 2, cur: 'USD' })).amount).toBe(2);
    await expect(createTransaction(db, F, tx)).rejects.toMatchObject(conflict);
    await expect(createAccount(db, F, { id: 'pp', name: 'Otra', currency: 'USD' })).rejects.toMatchObject(conflict);
    await expect(createIncome(db, F, { id: 'in-igual', date: '2026-10-07', amount: 1, cur: 'USD' })).rejects.toMatchObject(conflict);
    expect((await getMonth(db, F, '2026-10'))!.tx.find((t) => t.id === 'tx-igual')!.amount).toBe(1);
    expect((await listAccounts(db, F)).find((a) => a.id === 'pp')!.currency).toBe('USD');
  });

  it('ensureMonth copies from the previous month of the same user, not from that of another', async () => {
    const { db, sqlite } = await seeded();
    await createFixed(db, F, { monthKey: '2026-10', name: 'Solo Frank', amount: 9, cur: 'DOP' });
    await patchMonth(db, F, '2026-10', { budgets: { dr: 12345, us: 10 } });

    bystander = null;
    const eda = await ensureMonth(db, E, '2026-11');
    expect(eda.created).toBe(true);
    expect(eda.month.budgets).toEqual({ dr: 70000 });
    expect(eda.month.fixed).toHaveLength(11);
    expect(eda.month.fixed.some((f) => f.name === 'Solo Frank')).toBe(false);
    // The same month still does not exist for Frank, and when created it comes from his own months.
    expect(await getMonth(db, F, '2026-11')).toBeNull();
    const frank = await ensureMonth(db, F, '2026-11');
    expect(frank.created).toBe(true);
    expect(frank.month.budgets).toEqual({ dr: 12345, us: 10 });
    expect(frank.month.fixed).toHaveLength(12);
    expect(count(sqlite, 'months', E)).toBe(4);
    expect(count(sqlite, 'months', F)).toBe(4);
  });

  it('closeMonth closes the month of one user and creates their next one; the same month of the other stays open', async () => {
    const { db } = await seeded();
    const { closed, next } = await closeMonth(db, F, '2026-10');
    expect(closed.closed).toBe(true);
    expect(next.key).toBe('2026-11');
    expect((await getMonth(db, E, '2026-10'))!.closed).toBe(false);
    expect(await getMonth(db, E, '2026-11')).toBeNull();
    // And the other way around: reopening Frank's does not depend on anything of Eda's.
    expect((await reopenMonth(db, F, '2026-10')).closed).toBe(false);
    await expect(reopenMonth(db, E, '2026-11')).rejects.toMatchObject(notFound);
  });

  it('a closed month of one user does not block the same open month of the other', async () => {
    const { db } = await seeded();
    await reopenMonth(db, F, '2026-08');
    expect((await patchFixed(db, F, 'seed-fx-2026-08-1', { paid: false })).paid).toBe(false);
    expect((await patchMonth(db, F, '2026-08', { budgets: { us: 5 } })).budgets).toEqual({ dr: 70000, us: 5 });
    // For Eda, August is still closed.
    await expect(patchFixed(db, E, 'seed-fx-2026-08-1', { paid: false })).rejects.toMatchObject(closedMonth);
    await expect(patchMonth(db, E, '2026-08', { budgets: { us: 5 } })).rejects.toMatchObject(closedMonth);
  });

  it('deleting a month of one user does not delete the same month of the other', async () => {
    const { db, sqlite } = await seeded();
    await deleteMonth(db, F, '2026-10');
    expect(await getMonth(db, F, '2026-10')).toBeNull();
    expect((await getMonth(db, E, '2026-10'))!.tx).toHaveLength(7);
    expect(count(sqlite, 'transactions', E)).toBe(27);
    await expect(deleteMonth(db, F, '2026-10')).rejects.toMatchObject(notFound);
  });

  it('replaceAll and resetAll for one user do not touch the other', async () => {
    const { db, sqlite } = await seeded();
    const tiny = seedState();
    delete tiny.months['2026-08'];
    delete tiny.months['2026-09'];
    await replaceAll(db, F, tiny);
    expect(count(sqlite, 'months', F)).toBe(1);
    await resetAll(db, F, '2027-01');
    expect(Object.keys((await loadState(db, F)).months)).toEqual(['2027-01']);
    expect(count(sqlite, 'transactions', F)).toBe(0);
    expect(count(sqlite, 'incomes', F)).toBe(0);
    expect(count(sqlite, 'transactions', E)).toBe(27);
    expect(count(sqlite, 'incomes', E)).toBe(3);
  });

  it('applyImport only changes the data of the user who imports', async () => {
    const { db } = await seeded();
    await applyImport(db, F, {
      months: [{ key: '2026-10', closed: false, budget: 1, incomeUSD: 2, accounts: { usd: 3, dop: 4 }, fixed: [], transfers: [], tx: [] }],
      contribs: [{ date: '2026-10-01', goalName: 'Car', amount: 1, cur: 'USD' }],
      goals: [{ name: 'Trip to Turkey', monthlyUSD: 100, start: '2026-01', end: '2026-12' }],
    });
    const frank = await loadState(db, F);
    expect(frank.months['2026-10']).toMatchObject({ budgets: { dr: 1 }, fixed: [], tx: [] });
    expect(frank.contribs).toHaveLength(1);
    expect(frank.goals.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Car']);
    // Eda keeps her October, her 8 contributions, her balances and her goal's plan (afterEach checks it).
  });

  it('settings belong to each user', async () => {
    const { db } = await seeded();
    await updateSettings(db, F, {
      language: 'es',
      theme: { accent: '#112233', header: '#000000', background: '#ffffff' },
      mainCurrency: 'USD',
      secondCurrency: 'TRY',
      defaultAccountId: 'us',
    });
    expect(await getSettings(db, E)).toEqual({ ...DEFAULT_SETTINGS, defaultAccountId: 'dr' });
    expect(await loadState(db, F)).toMatchObject({ language: 'es', mainCurrency: 'USD', secondCurrency: 'TRY', defaultAccountId: 'us' });
  });
});

describe('first visit: initUser / openState', () => {
  it('openState creates the initial accounts and goals, the default rate, the flag and the given month', async () => {
    const { db, sqlite } = makeEnv();
    const state = await openState(db, F, '2026-10');
    expect(state).toEqual({
      ...EMPTY,
      accounts: [...DEFAULT_ACCOUNTS],
      goals: [...DEFAULT_GOALS],
      months: { '2026-10': emptyMonth('2026-10') },
    });
    const settings = sqlite.sqlite.prepare('SELECT user_id, key, value FROM settings ORDER BY key').all();
    expect(settings.map((r) => ({ ...r }))).toEqual([
      { user_id: F, key: 'default_rate', value: String(DEFAULT_RATE) },
      { user_id: F, key: 'initialized', value: '1' },
    ]);
    // Only Frank was set up.
    expect(await loadState(db, E)).toEqual(EMPTY);

    // Opening again creates nothing else and does not change the month.
    expect(await openState(db, F, '2027-05')).toEqual(state);
    expect(count(sqlite, 'accounts')).toBe(2);
    expect(count(sqlite, 'goals')).toBe(2);
    expect(count(sqlite, 'months')).toBe(1);
  });

  it('each user gets their own initial accounts and goals, with the same ids', async () => {
    const { db, sqlite } = makeEnv();
    await openState(db, F, '2026-10');
    await openState(db, E, '2026-10');
    for (const user of [F, E]) {
      expect(await listAccounts(db, user)).toEqual([...DEFAULT_ACCOUNTS]);
      expect(await listGoals(db, user)).toEqual([...DEFAULT_GOALS]);
    }
    expect(count(sqlite, 'accounts')).toBe(4);
    expect(count(sqlite, 'goals')).toBe(4);
  });

  it('whoever deletes or renames their initial accounts and goals does not get them back', async () => {
    const { db } = makeEnv();
    await openState(db, F, '2026-10');
    for (const g of DEFAULT_GOALS) await deleteGoal(db, F, g.id);
    await deleteAccount(db, F, 'us');
    await patchAccount(db, F, 'dr', { name: 'Banreservas' });
    const again = await openState(db, F, '2026-10');
    expect(again.goals).toEqual([]);
    expect(again.accounts.map((a) => [a.id, a.name])).toEqual([['dr', 'Banreservas']]);
    await initUser(db, F);
    expect(await listGoals(db, F)).toEqual([]);
    expect(await listAccounts(db, F)).toHaveLength(1);
  });

  it('a user with months but not flagged gets their accounts and goals and keeps their months', async () => {
    const { db } = makeEnv();
    await ensureMonth(db, F, '2026-09');
    const state = await openState(db, F, '2026-10');
    expect(Object.keys(state.months)).toEqual(['2026-09']);
    expect(state.accounts).toEqual([...DEFAULT_ACCOUNTS]);
    expect(state.goals).toEqual([...DEFAULT_GOALS]);
  });

  it('userState sets up the user (accounts, goals and flag) without creating any month; after that it only reads', async () => {
    const { db, sqlite } = makeEnv();
    const state = await userState(db, F);
    expect(state).toEqual({ ...EMPTY, accounts: [...DEFAULT_ACCOUNTS], goals: [...DEFAULT_GOALS] });
    expect(count(sqlite, 'months')).toBe(0);
    await deleteGoal(db, F, 'personal');
    expect((await userState(db, F)).goals.map((g) => g.id)).toEqual(['emergency']);
    // And opening the app afterwards only adds the month.
    expect(await openState(db, F, '2026-10')).toEqual({ ...state, goals: [DEFAULT_GOALS[0]], months: { '2026-10': emptyMonth('2026-10') } });
  });

  it('does not duplicate an account or a goal that already exists with that id or that name; the missing ones go at the end', async () => {
    const { db } = makeEnv();
    // Before opening the web app for the first time he already had an account and a goal named like the initial ones.
    await createAccount(db, F, { id: 'mine', name: 'dr ACCOUNT', currency: 'TRY', opening: 7 });
    await createGoal(db, F, { id: 'rainy', name: 'emergency FUND', cur: 'DOP' });
    await initUser(db, F);
    expect((await listAccounts(db, F)).map((a) => [a.id, a.name, a.currency, a.sort])).toEqual([
      ['mine', 'dr ACCOUNT', 'TRY', 0],
      ['us', 'US account', 'USD', 1],
    ]);
    expect((await listGoals(db, F)).map((g) => [g.id, g.name, g.cur, g.sort])).toEqual([
      ['rainy', 'emergency FUND', 'DOP', 0],
      ['personal', 'Personal savings', 'USD', 1],
    ]);
  });

  it('two first visits at once duplicate nothing', async () => {
    const { db, sqlite } = makeEnv();
    await Promise.all([initUser(db, F), initUser(db, F), openState(db, F, '2026-10'), userState(db, F)]);
    expect(await listAccounts(db, F)).toEqual([...DEFAULT_ACCOUNTS]);
    expect(await listGoals(db, F)).toEqual([...DEFAULT_GOALS]);
    expect(count(sqlite, 'settings', F)).toBe(2);
    expect(count(sqlite, 'months', F)).toBe(1);
  });

  it('keeps a default rate that was already stored', async () => {
    const { db, sqlite } = makeEnv();
    sqlite.sqlite.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'default_rate', '61.2')").run(F);
    expect((await openState(db, F, '2026-10')).defaultRate).toBe(61.2);
  });

  it('replaceAll and resetAll leave the user flagged: no accounts or goals are added afterwards', async () => {
    const { db } = makeEnv();
    const state = seedState();
    state.goals = [SEED_PLANNED_GOAL];
    state.contribs = [];
    state.accounts = [{ id: 'only', name: 'Only', currency: 'DOP', opening: 0, hidden: false, sort: 0 }];
    state.defaultAccountId = 'only';
    state.incomes = [];
    state.months = { '2026-10': emptyMonth('2026-10') };
    await replaceAll(db, F, state);
    const opened = await openState(db, F);
    expect(opened.goals).toEqual([SEED_PLANNED_GOAL]);
    expect(opened.accounts.map((a) => a.id)).toEqual(['only']);

    await resetAll(db, E, '2026-10');
    await deleteGoal(db, E, 'emergency');
    await deleteAccount(db, E, 'us');
    const hers = await openState(db, E);
    expect(hers.goals.map((g) => g.id)).toEqual(['personal']);
    expect(hers.accounts.map((a) => a.id)).toEqual(['dr']);
  });
});

describe('settings: language, colors, currencies and default account', () => {
  const ocean = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };

  it('with nothing stored: original palette, English, DOP as main, USD as second and the automatic account', async () => {
    const { db } = makeEnv();
    expect(await getSettings(db, F)).toEqual(DEFAULT_SETTINGS);
  });

  it('updateSettings changes only what is sent and returns how it ends up', async () => {
    const { db } = makeEnv();
    expect(await updateSettings(db, F, { language: 'tr' })).toEqual({ ...DEFAULT_SETTINGS, language: 'tr' });
    expect(await updateSettings(db, F, { theme: ocean })).toEqual({ ...DEFAULT_SETTINGS, theme: ocean, language: 'tr' });
    expect(await updateSettings(db, F, { language: 'es' })).toEqual({ ...DEFAULT_SETTINGS, theme: ocean, language: 'es' });
    expect(await getSettings(db, F)).toEqual({ ...DEFAULT_SETTINGS, theme: ocean, language: 'es' });
    const state = await loadState(db, F);
    expect([state.theme, state.language]).toEqual([ocean, 'es']);
    // null goes back to the original palette without touching the language.
    expect(await updateSettings(db, F, { theme: null })).toEqual({ ...DEFAULT_SETTINGS, language: 'es' });
    // With nothing to change it only reads.
    expect(await updateSettings(db, F, {})).toEqual({ ...DEFAULT_SETTINGS, language: 'es' });
  });

  it('the original palette is stored as NULL', async () => {
    const { db, sqlite } = makeEnv();
    await updateSettings(db, F, { theme: ocean });
    const stored = () => sqlite.sqlite.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'theme'").get(F)?.value;
    expect(JSON.parse(String(stored()))).toEqual(ocean);
    expect(await updateSettings(db, F, { theme: { accent: '#2f7d52', header: '#1d1f1c', background: '#efeee8' } })).toMatchObject({ theme: null });
    expect(stored()).toBeNull();
  });

  it('currencies: the two must end up different, counting the one that is not sent; to swap them, both go together', async () => {
    const { db } = await arrived();
    const same = { ...invalid, message: 'Invalid data: secondCurrency: must be different from mainCurrency' };
    // Starts from DOP / USD.
    await expect(updateSettings(db, F, { mainCurrency: 'USD' })).rejects.toMatchObject(same);
    await expect(updateSettings(db, F, { secondCurrency: 'DOP' })).rejects.toMatchObject(same);
    await expect(updateSettings(db, F, { mainCurrency: 'TRY', secondCurrency: 'TRY' })).rejects.toMatchObject(same);
    expect(await getSettings(db, F)).toEqual(DEFAULT_SETTINGS);

    // Swapped in a single request.
    expect(await updateSettings(db, F, { mainCurrency: 'USD', secondCurrency: 'DOP' })).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    // Just one, if it does not clash with the other.
    expect(await updateSettings(db, F, { secondCurrency: 'TRY' })).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'TRY' });
    expect(await updateSettings(db, F, { mainCurrency: 'DOP' })).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'TRY' });
    await expect(updateSettings(db, F, { mainCurrency: 'TRY' })).rejects.toMatchObject(same);
    // Writing the one he already has is not a problem.
    expect(await updateSettings(db, F, { mainCurrency: 'DOP' })).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'TRY' });
    expect(await loadState(db, F)).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'TRY' });
  });

  it('default account: an account of the user or null; one that does not exist, 400', async () => {
    const { db } = await arrived();
    expect(await updateSettings(db, F, { defaultAccountId: 'us' })).toMatchObject({ defaultAccountId: 'us' });
    expect((await loadState(db, F)).defaultAccountId).toBe('us');
    await expect(updateSettings(db, F, { defaultAccountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    expect((await getSettings(db, F)).defaultAccountId).toBe('us');
    // A hidden one is valid: shared/calc skips it while it stays hidden.
    await patchAccount(db, F, 'us', { hidden: true });
    expect(await updateSettings(db, F, { defaultAccountId: 'us' })).toMatchObject({ defaultAccountId: 'us' });
    expect(defaultAccount(await loadState(db, F))!.id).toBe('dr');
    expect(await updateSettings(db, F, { defaultAccountId: null })).toMatchObject({ defaultAccountId: null });
  });

  it('if one part is invalid none of them is saved', async () => {
    const { db } = await arrived();
    await expect(updateSettings(db, F, { language: 'tr', theme: ocean, mainCurrency: 'USD' })).rejects.toMatchObject(invalid);
    await expect(updateSettings(db, F, { language: 'tr', secondCurrency: 'TRY', defaultAccountId: 'nope' })).rejects.toMatchObject(invalid);
    expect(await getSettings(db, F)).toEqual(DEFAULT_SETTINGS);
  });

  it('a stored value that cannot be read counts as not having it', async () => {
    const { db, sqlite } = makeEnv();
    const put = sqlite.sqlite.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)');
    for (const theme of ['{no es json', '"#fff"', '{"accent":"#112233"}', '{"accent":"rojo","header":"#000000","background":"#ffffff"}', '']) {
      put.run(F, 'theme', theme);
      put.run(F, 'language', 'fr');
      put.run(F, 'default_rate', 'abc');
      put.run(F, 'main_currency', 'EUR');
      put.run(F, 'second_currency', 'usd');
      put.run(F, 'default_account', 'ya-no-existe');
      expect(await getSettings(db, F), theme).toEqual(DEFAULT_SETTINGS);
      expect(await loadState(db, F), theme).toEqual(EMPTY);
    }
    // What was stored by hand in another valid format is normalized on read.
    put.run(F, 'theme', '{"accent":"#ABC","header":"#000000","background":"#FFFFFF","extra":1}');
    expect((await getSettings(db, F)).theme).toEqual({ accent: '#aabbcc', header: '#000000', background: '#ffffff' });
    // Two identical currencies are not a valid pair: the second one goes back to a different one.
    put.run(F, 'main_currency', 'USD');
    put.run(F, 'second_currency', 'USD');
    expect(await getSettings(db, F)).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    put.run(F, 'main_currency', 'TRY');
    put.run(F, 'second_currency', 'TRY');
    expect(await loadState(db, F)).toMatchObject({ mainCurrency: 'TRY', secondCurrency: 'USD' });
  });
});

describe('accounts', () => {
  it('a new account goes at the end (sort = max + 1), with opening balance 0 and visible', async () => {
    const { db } = await arrived();
    const paypal = await createAccount(db, F, { name: 'PayPal', currency: 'USD' });
    expect(paypal).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), name: 'PayPal', currency: 'USD', opening: 0, hidden: false, sort: 2 });
    await patchAccount(db, F, 'us', { sort: 10 });
    const tr = await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY', opening: -250.75 });
    expect(tr).toEqual({ id: 'tr', name: 'TR account', currency: 'TRY', opening: -250.75, hidden: false, sort: 11 });
    // They are read in their order.
    expect((await listAccounts(db, F)).map((a) => a.id)).toEqual(['dr', paypal.id, 'us', 'tr']);
    expect((await loadState(db, F)).accounts.map((a) => a.id)).toEqual(['dr', paypal.id, 'us', 'tr']);
  });

  it('rename, correct the opening balance, hide and show again', async () => {
    const { db } = await seeded();
    expect(await patchAccount(db, F, 'dr', { name: 'Banreservas' })).toEqual({ ...SEED_ACCOUNTS[1], name: 'Banreservas' });
    // "Correcting the balance" means moving the opening balance: from 60,000 to 50,000 the balance drops 10,000.
    const before = await balance(db, F, 'dr');
    expect((await patchAccount(db, F, 'dr', { opening: 50000 })).opening).toBe(50000);
    expect(await balance(db, F, 'dr')).toBeCloseTo(before - 10000, 6);

    const total = balances(await loadState(db, F), '2026-10').totalMain;
    expect((await patchAccount(db, F, 'us', { hidden: true })).hidden).toBe(true);
    const hidden = await loadState(db, F);
    // Hidden: it still exists with its movements and its balance, but does not add to the total money.
    expect(hidden.accounts.map((a) => [a.id, a.hidden])).toEqual([
      ['us', true],
      ['dr', false],
    ]);
    expect(balances(hidden, '2026-10').accounts.find((a) => a.account.id === 'us')!.balance).toBeCloseTo(13482, 8);
    expect(balances(hidden, '2026-10').totalMain).toBeCloseTo(total - 13482 * 58.76, 6);
    expect((await patchAccount(db, F, 'us', { hidden: false })).hidden).toBe(false);
    expect(balances(await loadState(db, F), '2026-10').totalMain).toBeCloseTo(total, 6);
    // An empty patch returns the account as it is.
    expect(await patchAccount(db, F, 'us', {})).toEqual(SEED_ACCOUNTS[0]);
    await expect(patchAccount(db, F, 'nope', { name: 'x' })).rejects.toMatchObject({ ...notFound, message: 'Account not found.' });
    await expect(patchAccount(db, F, 'nope', {})).rejects.toMatchObject(notFound);
  });

  it('the name is unique per user, case-insensitively (also with accents): 409', async () => {
    const { db } = await arrived();
    const taken = { ...conflict, message: 'There is already an account with that name.' };
    await expect(createAccount(db, F, { name: 'us ACCOUNT', currency: 'TRY' })).rejects.toMatchObject(taken);
    await createAccount(db, F, { id: 'ah', name: 'Ahorros en dólares', currency: 'USD' });
    await expect(createAccount(db, F, { name: 'AHORROS EN DÓLARES', currency: 'USD' })).rejects.toMatchObject(taken);
    await expect(patchAccount(db, F, 'dr', { name: 'ahorros en dólares' })).rejects.toMatchObject(taken);
    // Its own name is not a conflict: it can be rewritten or have its capitalization changed.
    expect((await patchAccount(db, F, 'ah', { name: 'AHORROS EN DÓLARES' })).name).toBe('AHORROS EN DÓLARES');
    // Once renamed, the previous name is free.
    await patchAccount(db, F, 'us', { name: 'Chase' });
    expect((await createAccount(db, F, { name: 'US account', currency: 'USD' })).name).toBe('US account');
    // Another user can indeed have an account with that same name.
    bystander = null;
    expect((await createAccount(db, E, { name: 'Ahorros en dólares', currency: 'DOP' })).currency).toBe('DOP');
  });

  it('the currency can only be changed while nothing uses the account', async () => {
    const { db } = await seeded();
    const inUse = { ...conflict, message: 'The account is in use: its currency cannot be changed.' };
    await expect(patchAccount(db, F, 'dr', { currency: 'USD' })).rejects.toMatchObject(inUse);
    // Not even together with other changes, which are not saved either.
    await expect(patchAccount(db, F, 'us', { name: 'Chase', currency: 'TRY' })).rejects.toMatchObject(inUse);
    expect(await listAccounts(db, F)).toEqual([...SEED_ACCOUNTS]);
    // Writing the currency it already has is not a change.
    expect((await patchAccount(db, F, 'dr', { currency: 'DOP', name: 'Popular' })).name).toBe('Popular');

    const fresh = await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    expect((await patchAccount(db, F, fresh.id, { currency: 'TRY' })).currency).toBe('TRY');
    expect((await patchAccount(db, F, fresh.id, { currency: 'USD', opening: 5 })).currency).toBe('USD');
  });

  it('an account that something uses cannot be deleted or change currency: a fixed expense, a transaction, a transfer, an income or a budget part', async () => {
    const { db } = await arrived();
    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    const inUse = { ...conflict, message: 'The account is in use: hide it instead of deleting it.' };
    const blocked = async (what: string) => {
      await expect(deleteAccount(db, F, 'pp'), what).rejects.toMatchObject(inUse);
      await expect(patchAccount(db, F, 'pp', { currency: 'TRY' }), what).rejects.toMatchObject(conflict);
    };

    const fixed = await createFixed(db, F, { monthKey: '2026-10', name: 'Hosting', amount: 5, cur: 'USD', accountId: 'pp' });
    await blocked('fijo');
    // Unpaid, it does not move the balance, but the account is still in use.
    expect(fixed.paid).toBe(false);
    await deleteFixed(db, F, fixed.id);

    const tx = await createTransaction(db, F, { monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'USD', accountId: 'pp' });
    await blocked('transacción');
    await patchTransaction(db, F, tx.id, { accountId: 'us' });

    const out = await createTransfer(db, F, { monthKey: '2026-10', date: '2026-10-07', via: 'PayPal', fromAccountId: 'pp', toAccountId: 'us', amount: 1 });
    await blocked('envío que sale');
    await patchTransfer(db, F, out.id, { fromAccountId: 'dr', toAccountId: 'pp', rate: 0.017 });
    await blocked('envío que entra');
    await deleteTransfer(db, F, out.id);

    const income = await createIncome(db, F, { date: '2031-01-01', amount: 1, cur: 'USD', accountId: 'pp' });
    await blocked('ingreso');
    await deleteIncome(db, F, income.id);

    const withPart = await patchMonth(db, F, '2026-10', { budgets: { pp: 50 } });
    await blocked('presupuesto');
    // Setting the part to 0 does not free the account: the log keeps the history (+50, −50) and still names it.
    const zeroed = await patchMonth(db, F, '2026-10', { budgets: { pp: 0 } });
    expect(zeroed.budgets).toEqual({});
    await blocked('historia del presupuesto');
    // Only by deleting those movements does it stop using the account.
    for (const e of zeroed.budgetLog.filter((x) => x.accountId === 'pp')) await deleteBudgetEntry(db, F, '2026-10', e.id);
    expect(withPart.budgetLog.filter((x) => x.accountId === 'pp')).toHaveLength(1);

    await deleteAccount(db, F, 'pp');
    expect((await listAccounts(db, F)).map((a) => a.id)).toEqual(['us', 'dr']);
    await expect(deleteAccount(db, F, 'pp')).rejects.toMatchObject({ ...notFound, message: 'Account not found.' });
  });

  it('the last account cannot be deleted', async () => {
    const { db } = await arrived();
    await deleteAccount(db, F, 'us');
    await expect(deleteAccount(db, F, 'dr')).rejects.toMatchObject({
      ...conflict,
      message: 'The last account cannot be deleted: there must always be one.',
    });
    expect((await listAccounts(db, F)).map((a) => a.id)).toEqual(['dr']);
    // With another one, it can.
    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    await deleteAccount(db, F, 'dr');
    expect((await listAccounts(db, F)).map((a) => a.id)).toEqual(['pp']);
  });

  it('deleting the default account leaves it on the automatic one', async () => {
    const { db, sqlite } = await arrived();
    await updateSettings(db, F, { defaultAccountId: 'us' });
    await deleteAccount(db, F, 'us');
    expect((await getSettings(db, F)).defaultAccountId).toBeNull();
    expect(sqlite.sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE user_id = ? AND key = 'default_account'").get(F)?.n).toBe(0);
    // A rejected delete does not touch it.
    await updateSettings(db, F, { defaultAccountId: 'dr' });
    await expect(deleteAccount(db, F, 'dr')).rejects.toMatchObject(conflict);
    expect((await getSettings(db, F)).defaultAccountId).toBe('dr');
  });
});

describe('default account for whatever does not say which one it comes out of', () => {
  const tx = { monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' as const };
  const fixed = { monthKey: '2026-10', name: 'Agua', amount: 1, cur: 'DOP' as const };
  const income = { date: '2026-10-07', amount: 1, cur: 'USD' as const };

  /** Which account a transaction, a fixed expense and an income created without `accountId` come out of (or go into). */
  async function resolved(db: D1Database, userId = F): Promise<string[]> {
    return [
      (await createTransaction(db, userId, tx)).accountId,
      (await createFixed(db, userId, fixed)).accountId,
      (await createIncome(db, userId, income)).accountId,
    ];
  }

  it('the one chosen in the settings; if there is none or it is hidden, the first visible one in the main currency; otherwise, the first visible one', async () => {
    const { db } = await seeded();
    // The sample data chooses 'dr'.
    expect(await resolved(db)).toEqual(['dr', 'dr', 'dr']);
    await updateSettings(db, F, { defaultAccountId: 'us' });
    expect(await resolved(db)).toEqual(['us', 'us', 'us']);
    // Hidden, it no longer counts: the first visible one in the main currency (DOP).
    await patchAccount(db, F, 'us', { hidden: true });
    expect(await resolved(db)).toEqual(['dr', 'dr', 'dr']);
    await patchAccount(db, F, 'us', { hidden: false });
    // With none chosen and TRY as main (no account in TRY): the first visible one.
    await updateSettings(db, F, { defaultAccountId: null, mainCurrency: 'TRY' });
    expect(await resolved(db)).toEqual(['us', 'us', 'us']);
    const tr = await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY' });
    expect(await resolved(db)).toEqual([tr.id, tr.id, tr.id]);
  });

  it('the account that is sent is honored, whether or not it is the default one and whether or not it is hidden', async () => {
    const { db } = await seeded();
    await patchAccount(db, F, 'us', { hidden: true });
    expect((await createTransaction(db, F, { ...tx, accountId: 'us' })).accountId).toBe('us');
    expect((await createFixed(db, F, { ...fixed, accountId: 'us' })).accountId).toBe('us');
    expect((await createIncome(db, F, { ...income, accountId: 'us' })).accountId).toBe('us');
  });

  it('each user has their own', async () => {
    const { db } = await seeded();
    await updateSettings(db, F, { defaultAccountId: 'us' });
    bystander = null;
    expect(await resolved(db, E)).toEqual(['dr', 'dr', 'dr']);
    expect(await resolved(db, F)).toEqual(['us', 'us', 'us']);
  });

  it('a user who never visited gets their initial accounts created first', async () => {
    const { db, sqlite } = makeEnv();
    const created = await createIncome(db, F, income);
    expect(created.accountId).toBe('dr');
    expect(await listAccounts(db, F)).toEqual([...DEFAULT_ACCOUNTS]);
    expect(await listGoals(db, F)).toEqual([...DEFAULT_GOALS]);
    expect(count(sqlite, 'accounts', E)).toBe(0);
  });

  it('userAccounts: the accounts of the user and their default account, the same one shared/calc gives over the whole state', async () => {
    const { db, sqlite } = await seeded();
    const same = async () => {
      const mine = await userAccounts(db, F);
      const state = await loadState(db, F);
      expect(mine.accounts).toEqual(state.accounts);
      expect(mine.defaultAccount).toEqual(defaultAccount(state));
      return mine.defaultAccount?.id;
    };
    expect(await same()).toBe('dr');
    await updateSettings(db, F, { defaultAccountId: 'us' });
    expect(await same()).toBe('us');
    await patchAccount(db, F, 'us', { hidden: true });
    expect(await same()).toBe('dr');
    await updateSettings(db, F, { defaultAccountId: null, mainCurrency: 'TRY' });
    await patchAccount(db, F, 'us', { hidden: false, sort: 9 });
    expect(await same()).toBe('dr');
    await patchAccount(db, F, 'dr', { hidden: true });
    expect(await same()).toBe('us');
    // With all of them hidden, the first one there is.
    await patchAccount(db, F, 'us', { hidden: true });
    expect(await same()).toBe('dr');

    // A user who never visited is set up first (accounts, goals and flag), without creating any month.
    const { db: empty, sqlite: raw } = makeEnv();
    expect(await userAccounts(empty, F)).toEqual({ accounts: [...DEFAULT_ACCOUNTS], defaultAccount: DEFAULT_ACCOUNTS[1] });
    expect(await listGoals(empty, F)).toEqual([...DEFAULT_GOALS]);
    expect(count(raw, 'months')).toBe(0);
    expect(count(raw, 'accounts', E)).toBe(0);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('with no account at all (can only happen outside the API) there is nowhere to record: 409, and with the account stated, 400', async () => {
    const { db } = makeEnv();
    const state = seedState();
    await replaceAll(db, F, { ...state, accounts: [], incomes: [], defaultAccountId: null, months: { '2026-10': emptyMonth('2026-10') } });
    const none = { ...conflict, message: 'There are no accounts yet: add one first.' };
    expect(await userAccounts(db, F)).toEqual({ accounts: [], defaultAccount: null });
    await expect(createIncome(db, F, income)).rejects.toMatchObject(none);
    await expect(createTransaction(db, F, tx)).rejects.toMatchObject(none);
    await expect(createFixed(db, F, fixed)).rejects.toMatchObject(none);
    await expect(createIncome(db, F, { ...income, accountId: 'dr' })).rejects.toMatchObject(unknownAccount('dr'));
    // Opening the app does not give them back (he is already flagged): he creates them himself, and then it works.
    expect((await openState(db, F, '2026-10')).accounts).toEqual([]);
    await createAccount(db, F, { id: 'new', name: 'Nueva', currency: 'DOP' });
    expect((await createIncome(db, F, income)).accountId).toBe('new');
  });

  it('an account that does not exist: 400 and nothing is saved', async () => {
    const { db, sqlite } = await seeded();
    await expect(createTransaction(db, F, { ...tx, accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(createFixed(db, F, { ...fixed, accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(createIncome(db, F, { ...income, accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(patchTransaction(db, F, 'seed-tx-2026-10-1', { accountId: 'nope', amount: 9 })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(patchFixed(db, F, 'seed-fx-2026-10-1', { accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(patchIncome(db, F, 'seed-in-1', { accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    expect(count(sqlite, 'transactions', F)).toBe(27);
    expect((await getMonth(db, F, '2026-10'))!.tx[0]!.amount).toBe(4850);
    // A row that does not exist is still a 404, whatever account is sent.
    await expect(patchTransaction(db, F, 'nada', { accountId: 'nope' })).rejects.toMatchObject(notFound);
    await expect(patchIncome(db, F, 'nada', { accountId: 'nope' })).rejects.toMatchObject(notFound);
    // And in a closed month, the account comes first (invalid data) and then the month.
    await expect(patchFixed(db, F, 'seed-fx-2026-08-1', { accountId: 'nope' })).rejects.toMatchObject(invalid);
    await expect(patchFixed(db, F, 'seed-fx-2026-08-1', { accountId: 'us' })).rejects.toMatchObject(closedMonth);
  });

  it('everything moves the balances: paying a fixed expense, recording an expense or an income, and moving them to another account', async () => {
    const { db } = await seeded();
    const dr = await balance(db, F, 'dr');
    const us = await balance(db, F, 'us');

    // Netflix (1,137.30 DOP, unpaid) subtracts from 'dr' only while it is paid.
    const netflix = (await getMonth(db, F, '2026-10'))!.fixed.find((f) => f.name === 'Netflix')!;
    await patchFixed(db, F, netflix.id, { paid: true });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr - 1137.3, 6);
    // Paid from the USD account, it subtracts from that one, converted at the month rate (58.76).
    await patchFixed(db, F, netflix.id, { accountId: 'us' });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr, 6);
    expect(await balance(db, F, 'us')).toBeCloseTo(us - 1137.3 / 58.76, 6);
    await patchFixed(db, F, netflix.id, { paid: false });
    expect(await balance(db, F, 'us')).toBeCloseTo(us, 6);

    const spent = await createTransaction(db, F, { ...tx, amount: 500 });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr - 500, 6);
    await deleteTransaction(db, F, spent.id);
    await createIncome(db, F, { date: '2026-10-09', amount: 100, cur: 'USD', accountId: 'dr' });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr + 5876, 6);
    // A contribution to a goal moves no balance.
    await createContribution(db, F, { goalId: 'personal', date: '2026-10-09', amount: 300, cur: 'USD' });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr + 5876, 6);
    expect(await balance(db, F, 'us')).toBeCloseTo(us, 6);
  });
});

describe('ensureMonth', () => {
  it('with no previous months it creates an empty month', async () => {
    const { db } = makeEnv();
    const { month, created } = await ensureMonth(db, F, '2026-10');
    expect(created).toBe(true);
    expect(month).toEqual(emptyMonth('2026-10'));
  });

  it('if it already exists it does not touch it and says so', async () => {
    const { db, sqlite } = await seeded();
    const before = await getMonth(db, F, '2026-10');
    const { month, created } = await ensureMonth(db, F, '2026-10');
    expect(created).toBe(false);
    expect(month).toEqual(before);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(33);
  });

  it('clones from the closest previous month: fixed expenses unpaid with their account and new ids, and the budget parts; not the rates', async () => {
    const { db } = await seeded();
    await patchMonth(db, F, '2026-10', { budgets: { us: 250 } });
    // There is a gap: November does not exist; December is copied from October.
    const { month, created } = await ensureMonth(db, F, '2026-12');
    const october = (await getMonth(db, F, '2026-10'))!;
    expect(created).toBe(true);
    expect(month.closed).toBe(false);
    expect(month.budgets).toEqual({ dr: 70000, us: 250 });
    expect(october.rates).toHaveLength(2);
    expect(month.rates).toEqual([]);
    // One initial movement per account, dated the first day of the new month, for what October's log added up to.
    expect(month.budgetLog.map(({ id: _id, ...e }) => e)).toEqual([
      { date: '2026-12-01', accountId: 'dr', amount: 70000, kind: 'initial', note: '' },
      { date: '2026-12-01', accountId: 'us', amount: 250, kind: 'initial', note: '' },
    ]);
    for (const e of month.budgetLog) expect(e.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(month.transfers).toEqual([]);
    expect(month.tx).toEqual([]);
    expect(month.fixed.map(core)).toEqual(october.fixed.map(core));
    // Claude is paid from the USD account; the rest, from the DOP one.
    expect(month.fixed.filter((f) => f.accountId === 'us').map((f) => f.name)).toEqual(['Claude']);
    expect(month.fixed.every((f) => !f.paid && f.monthKey === '2026-12')).toBe(true);
    const ids = new Set([...month.fixed, ...october.fixed].map((f) => f.id));
    expect(ids.size).toBe(22);
    for (const f of month.fixed) expect(f.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    // With no rate of its own, the last typed one is still in effect in December.
    expect(rateFor(await loadState(db, F), '2026-12', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'previous', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('an in-between month is copied from the previous one, not from the later one', async () => {
    const { db } = await arrived();
    await ensureMonth(db, F, '2026-06');
    await createFixed(db, F, { monthKey: '2026-06', name: 'Luz', amount: 100, cur: 'DOP', paid: true });
    await patchMonth(db, F, '2026-06', { budgets: { dr: 600 } });
    await createFixed(db, F, { monthKey: '2026-10', name: 'Internet', amount: 200, cur: 'DOP' });
    await patchMonth(db, F, '2026-10', { budgets: { dr: 1000 } });
    const { month } = await ensureMonth(db, F, '2026-08');
    expect(month.fixed.map((f) => [f.name, f.paid])).toEqual([['Luz', false]]);
    expect(month.budgets).toEqual({ dr: 600 });
  });

  it('a month earlier than all the existing ones ends up empty', async () => {
    const { db } = await seeded();
    const { month, created } = await ensureMonth(db, F, '2026-01');
    expect(created).toBe(true);
    expect(month).toEqual(emptyMonth('2026-01'));
  });

  it('rejects keys that are not a month', async () => {
    const { db } = makeEnv();
    await expect(ensureMonth(db, F, '2026-13')).rejects.toMatchObject(invalid);
  });
});

describe('closeMonth', () => {
  it('crosses the year: closing December creates January', async () => {
    const { db } = makeEnv();
    await ensureMonth(db, F, '2026-12');
    const { closed, next } = await closeMonth(db, F, '2026-12', {}, new Date('2027-01-02T03:04:05.000Z'));
    expect(closed.closed).toBe(true);
    expect(closed.closedAt).toBe('2027-01-02T03:04:05.000Z');
    expect(next.key).toBe('2027-01');
  });

  it('the next month starts with the fixed expenses unpaid (same account) and the same budget parts, without rates', async () => {
    const { db } = await seeded();
    await patchMonth(db, F, '2026-10', { budgets: { us: 100 } });
    const { closed, next } = await closeMonth(db, F, '2026-10');
    expect(next).toMatchObject({ key: '2026-11', closed: false, closedAt: null, budgets: { dr: 70000, us: 100 }, rates: [], transfers: [], tx: [] });
    expect(next.fixed.map(core)).toEqual(closed.fixed.map(core));
    expect(next.fixed.every((f) => !f.paid)).toBe(true);
    // Closing changes no balance: the fixed expenses of the new month are unpaid.
    expect(await balance(db, F, 'dr', '2026-11')).toBeCloseTo(220641.93, 6);
  });

  it('if the next month cannot be created, the month is not left closed either (a single batch)', async () => {
    const { db, sqlite } = await seeded();
    // Forces the INSERT of the new month's fixed expenses to fail.
    sqlite.sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON fixed_expenses BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(closeMonth(db, F, '2026-10')).rejects.toThrow(/boom/);
    expect((await getMonth(db, F, '2026-10'))!.closed).toBe(false);
    expect(await getMonth(db, F, '2026-11')).toBeNull();
  });
});

describe('budget per account (patchMonth)', () => {
  const NOW = new Date('2026-10-08T15:00:00.000Z');
  const log = (m: Month) => m.budgetLog.map((e) => [e.date, e.accountId, e.amount, e.kind]);

  it('sets the part of an account by adding the difference to the log: initial the first time, adjustment afterwards', async () => {
    const { db, sqlite } = await seeded();
    // The US account had nothing in October: its first movement is the initial one, dated today.
    const first = await patchMonth(db, F, '2026-10', { budgets: { us: 200 } }, NOW);
    expect(first.budgets).toEqual({ dr: 70000, us: 200 });
    expect(log(first)).toEqual([
      ['2026-10-01', 'dr', 65000, 'initial'],
      ['2026-10-05', 'dr', 5000, 'adjust'],
      ['2026-10-08', 'us', 200, 'initial'],
    ]);
    // The DR account already had 70,000: lowering it to 58,248.5 is an adjustment of −11,751.5.
    const second = await patchMonth(db, F, '2026-10', { budgets: { dr: 58248.5 } }, NOW);
    expect(second.budgets).toEqual({ dr: 58248.5, us: 200 });
    expect(log(second).at(-1)).toEqual(['2026-10-08', 'dr', -11751.5, 'adjust']);
    // The total is the sum converted to the main currency at the month rate.
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBeCloseTo(58248.5 + 200 * 58.76, 8);
    expect(count(sqlite, 'month_budget_log', F)).toBe(6);

    // The same amount again adds nothing (nor does the amount it already adds up to): the difference is 0.
    expect(log(await patchMonth(db, F, '2026-10', { budgets: { dr: 58248.5, us: 200 } }, NOW))).toEqual(log(second));
    expect(count(sqlite, 'month_budget_log', F)).toBe(6);

    // 0 leaves the part at zero with a negative adjustment: the history is kept.
    const zero = await patchMonth(db, F, '2026-10', { budgets: { dr: 0 } }, NOW);
    expect(zero.budgets).toEqual({ us: 200 });
    expect(log(zero).at(-1)).toEqual(['2026-10-08', 'dr', -58248.5, 'adjust']);
    // Setting it to 0 again, or setting 0 on an account with no part, is neither an error nor a movement.
    expect((await patchMonth(db, F, '2026-10', { budgets: { dr: 0, us: 0 } }, NOW)).budgets).toEqual({});
    expect(count(sqlite, 'month_budget_log', F)).toBe(8);
    // Several at once, and the other months are unaffected.
    const month = await patchMonth(db, F, '2026-10', { budgets: { dr: 1, us: 2 } }, NOW);
    expect(month.budgets).toEqual({ dr: 1, us: 2 });
    expect(log(month).slice(-2)).toEqual([
      ['2026-10-08', 'dr', 1, 'adjust'],
      ['2026-10-08', 'us', 2, 'adjust'],
    ]);
    expect(month.fixed).toHaveLength(11);
    expect((await getMonth(db, F, '2026-09'))!.budgets).toEqual({ dr: 70000 });
  });

  it('the date of the movement is today in Santo Domingo, moved into the month if it falls outside', async () => {
    const { db } = await seeded();
    await reopenMonth(db, F, '2026-08');
    await ensureMonth(db, F, '2026-12');
    // At 03:00 UTC on the 9th it is still the 8th in Santo Domingo.
    const late = new Date('2026-10-09T03:00:00.000Z');
    expect(log(await patchMonth(db, F, '2026-10', { budgets: { dr: 70001 } }, late)).at(-1)).toEqual(['2026-10-08', 'dr', 1, 'adjust']);
    // A past month: its last day. A future one: the first.
    expect(log(await patchMonth(db, F, '2026-08', { budgets: { dr: 70010 } }, late)).at(-1)).toEqual(['2026-08-31', 'dr', 10, 'adjust']);
    expect(log(await patchMonth(db, F, '2026-12', { budgets: { dr: 70100 } }, late)).at(-1)).toEqual(['2026-12-01', 'dr', 100, 'adjust']);
  });

  it('does not carry floating-point noise along: 0.1 + 0.2 is already 0.3', async () => {
    const { db, sqlite } = await arrived();
    await patchMonth(db, F, '2026-10', { budgets: { dr: 0.1 } }, NOW);
    await patchMonth(db, F, '2026-10', { budgets: { dr: 0.3 } }, NOW);
    const before = count(sqlite, 'month_budget_log', F);
    const month = await patchMonth(db, F, '2026-10', { budgets: { dr: 0.3 } }, NOW);
    expect(count(sqlite, 'month_budget_log', F)).toBe(before);
    expect(month.budgets).toEqual({ dr: 0.3 });
    expect(log(month)).toEqual([
      ['2026-10-08', 'dr', 0.1, 'initial'],
      ['2026-10-08', 'dr', 0.2, 'adjust'],
    ]);
  });

  it('incomes that raise the budget are left out of the calculation: what gets set is what the log adds up to', async () => {
    const { db } = await seeded();
    await createIncome(db, F, { id: 'bonus', date: '2026-10-04', accountId: 'dr', amount: 3000, cur: 'DOP', budget: true });
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBe(73000);
    const month = await patchMonth(db, F, '2026-10', { budgets: { dr: 71000 } }, NOW);
    expect(log(month).at(-1)).toEqual(['2026-10-08', 'dr', 1000, 'adjust']);
    expect(month.budgets).toEqual({ dr: 71000 });
    const c = monthCalc(await loadState(db, F), '2026-10');
    expect(c.budget).toBe(74000);
    expect(c.budgetParts.find((p) => p.account.id === 'dr')).toMatchObject({ amount: 74000, fromLog: 71000, fromIncomes: 3000 });
  });

  it('an empty patch returns the month unchanged', async () => {
    const { db } = await seeded();
    const before = await getMonth(db, F, '2026-10');
    expect(await patchMonth(db, F, '2026-10', {})).toEqual(before);
    expect(await patchMonth(db, F, '2026-10', { budgets: {} })).toEqual(before);
    await expect(patchMonth(db, F, '2031-01', {})).rejects.toMatchObject(notFound);
  });

  it('the account must exist: if any does not, no part is applied', async () => {
    const { db } = await seeded();
    await expect(patchMonth(db, F, '2026-10', { budgets: { us: 5, nope: 10 } })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(patchMonth(db, F, '2026-10', { budgets: { nope: 0 } })).rejects.toMatchObject(unknownAccount('nope'));
    expect((await getMonth(db, F, '2026-10'))!.budgets).toEqual({ dr: 70000 });
    await expect(patchMonth(db, F, '2031-01', { budgets: { dr: 1 } })).rejects.toMatchObject({ ...notFound, message: 'Month 2031-01 does not exist.' });
  });
});

describe('month rates', () => {
  it('one per currency pair: typing it again replaces it, also in the other direction', async () => {
    const { db, sqlite } = await seeded();
    // The one from the 1st is replaced; the one from the 6th is a different rate and is left untouched.
    expect((await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-01' })).rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
    ]);
    const state = await loadState(db, F);
    expect(rateFor(state, '2026-10', 'USD', 'DOP', '2026-10-05')).toEqual({ rate: 59.1, source: 'month', monthKey: '2026-10', date: '2026-10-01' });
    expect(rateFor(state, '2026-10', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-06' });

    // DOP → USD is the same pair: it replaces the USD → DOP one of that date, it is not added next to it.
    const inverse = await setMonthRate(db, F, '2026-10', { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' });
    expect(inverse.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' },
    ]);
    expect(count(sqlite, 'month_rates', F)).toBe(2);
    expect(rateFor(await loadState(db, F), '2026-10', 'USD', 'DOP').rate).toBeCloseTo(1 / 0.0168, 10);

    // A new date is added to the history: the earlier ones still apply to what came before.
    const third = await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' });
    expect(third.rates.map((r) => [r.date, r.rate])).toEqual([
      ['2026-10-01', 59.1],
      ['2026-10-06', 0.0168],
      ['2026-10-08', 60],
    ]);
    const dated = await loadState(db, F);
    expect([rateFor(dated, '2026-10', 'USD', 'DOP', '2026-10-03').rate, rateFor(dated, '2026-10', 'USD', 'DOP').rate]).toEqual([59.1, 60]);
    await deleteMonthRate(db, F, '2026-10', 'USD', 'DOP', '2026-10-08');
    await deleteMonthRate(db, F, '2026-10', 'USD', 'DOP', '2026-10-06');

    // Another pair is added; with two, the third comes out by crossing them.
    const two = await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    expect(two.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
    ]);
    expect(rateFor(await loadState(db, F), '2026-10', 'TRY', 'DOP').source).toBe('cross');
    // And each month has its own.
    expect((await getMonth(db, F, '2026-09'))!.rates).toEqual([]);
    expect(two.fixed).toHaveLength(11);
  });

  it('removing it, whether it is stored in one direction or the other; if there is none, the month stays the same', async () => {
    const { db, sqlite } = await seeded();
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    // Stored as USD → DOP, it is removed by asking for DOP → USD; only the one of that date.
    const one = await deleteMonthRate(db, F, '2026-10', 'DOP', 'USD', '2026-10-06');
    expect(one.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
    ]);
    // A date on which there is no rate: nothing changes.
    expect(await deleteMonthRate(db, F, '2026-10', 'USD', 'DOP', '2026-10-02')).toEqual(one);
    const removed = await deleteMonthRate(db, F, '2026-10', 'DOP', 'USD', '2026-10-01');
    expect(removed.rates).toEqual([{ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' }]);
    // With none typed, October goes back to the one from its transfers.
    expect(rateFor(await loadState(db, F), '2026-10', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'transfers', monthKey: '2026-10', date: null });
    expect(await deleteMonthRate(db, F, '2026-10', 'DOP', 'USD', '2026-10-01')).toEqual(removed);
    expect((await deleteMonthRate(db, F, '2026-10', 'USD', 'TRY', '2026-10-01')).rates).toEqual([]);
    expect(count(sqlite, 'month_rates', F)).toBe(0);
    await expect(deleteMonthRate(db, F, '2031-01', 'USD', 'DOP', '2031-01-01')).rejects.toMatchObject(notFound);
    await expect(setMonthRate(db, F, '2031-01', { from: 'USD', to: 'DOP', rate: 1, date: '2031-01-01' })).rejects.toMatchObject(notFound);
  });

  it('the date of a rate must fall within its month', async () => {
    const { db } = await seeded();
    const before = await getMonth(db, F, '2026-10');
    for (const date of ['2026-09-30', '2026-11-01', '2025-10-08']) {
      await expect(setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 60, date }), date).rejects.toMatchObject({
        ...invalid,
        message: 'Invalid data: date: must be a date in 2026-10',
      });
    }
    expect(await getMonth(db, F, '2026-10')).toEqual(before);
    expect((await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-31' })).rates.at(-1)).toEqual({
      from: 'USD', to: 'DOP', rate: 60, date: '2026-10-31',
    });
  });
});

describe('closed month: the budget and the rates are read-only too', () => {
  it('409 month_closed and nothing changes; once reopened, it does', async () => {
    const { db } = await seeded();
    const before = await loadState(db, F);
    const closed = { ...closedMonth, message: 'August 2026 is closed: it is read-only. Reopen it to make changes.' };
    await expect(patchMonth(db, F, '2026-08', { budgets: { dr: 1 } })).rejects.toMatchObject(closed);
    await expect(patchMonth(db, F, '2026-08', { budgets: { dr: 0 } })).rejects.toMatchObject(closed);
    await expect(setMonthRate(db, F, '2026-08', { from: 'USD', to: 'DOP', rate: 60, date: '2026-08-01' })).rejects.toMatchObject(closed);
    await expect(deleteMonthRate(db, F, '2026-08', 'USD', 'DOP', '2026-08-01')).rejects.toMatchObject(closed);
    expect(await loadState(db, F)).toEqual(before);

    // With a rate already typed in the closed month, it cannot be replaced (not even by its inverse) or removed either.
    await reopenMonth(db, F, '2026-08');
    expect((await setMonthRate(db, F, '2026-08', { from: 'USD', to: 'DOP', rate: 58, date: '2026-08-01' })).rates).toHaveLength(1);
    expect((await patchMonth(db, F, '2026-08', { budgets: { dr: 65000 } })).budgets).toEqual({ dr: 65000 });
    await closeMonth(db, F, '2026-08');
    await expect(setMonthRate(db, F, '2026-08', { from: 'DOP', to: 'USD', rate: 0.02, date: '2026-08-01' })).rejects.toMatchObject(closedMonth);
    await expect(deleteMonthRate(db, F, '2026-08', 'DOP', 'USD', '2026-08-01')).rejects.toMatchObject(closedMonth);
    expect((await getMonth(db, F, '2026-08'))!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 58, date: '2026-08-01' }]);
    // An empty patch only reads.
    expect((await patchMonth(db, F, '2026-08', {})).closed).toBe(true);
  });
});

describe('deleting a month', () => {
  it('takes everything of its own with it (fixed expenses, transactions, transfers, budget and rates), whether open or closed', async () => {
    const { db, sqlite } = await seeded();
    // October: open, with a typed rate.
    await deleteMonth(db, F, '2026-10');
    expect(count(sqlite, 'months', F)).toBe(2);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(22);
    expect(count(sqlite, 'transactions', F)).toBe(20);
    expect(count(sqlite, 'transfers', F)).toBe(4);
    expect(count(sqlite, 'month_budget_log', F)).toBe(2);
    // The other user's data is still intact.
    expect(count(sqlite, 'month_budget_log', E)).toBe(4);
    expect(count(sqlite, 'month_rates', E)).toBe(2);
    expect(count(sqlite, 'month_rates', F)).toBe(0);
    // September: closed.
    await deleteMonth(db, F, '2026-09');
    const state = await loadState(db, F);
    expect(Object.keys(state.months)).toEqual(['2026-08']);
    expect(count(sqlite, 'transactions', F)).toBe(10);
    // What belongs to no month is kept.
    expect(state.incomes).toEqual(seedState().incomes);
    expect(state.contribs).toEqual(seedState().contribs);
    expect(state.accounts).toEqual(seedState().accounts);
    expect(state.goals).toEqual(seedState().goals);
    await expect(deleteMonth(db, F, '2026-09')).rejects.toMatchObject({ ...notFound, message: 'Month 2026-09 does not exist.' });
    await expect(deleteMonth(db, F, '2031-01')).rejects.toMatchObject(notFound);
  });

  it('balances change accordingly: its expenses and its transfers stop counting, not its incomes', async () => {
    const { db } = await seeded();
    expect(await balance(db, F, 'us')).toBeCloseTo(13482, 8);
    expect(await balance(db, F, 'dr')).toBeCloseTo(220641.93, 6);
    await deleteMonth(db, F, '2026-09');
    // US: 2,000 + 3 salaries of 5,800 − the August and October transfers (1,800 + 1,500) − Claude for two months.
    expect(await balance(db, F, 'us')).toBeCloseTo(2000 + 17400 - 3300 - 212, 8);
    // DR: 60,000 + what was received in August and October − its transactions − its fixed expenses paid in DOP.
    expect(await balance(db, F, 'dr')).toBeCloseTo(60000 + 104730 + 88140 - 27850 - 10845 - 35750.26 - 32076.15, 6);
    // September's salary still counts, converted at the rate of the closest previous month.
    const state = await loadState(db, F);
    expect(state.incomes).toHaveLength(3);
    expect(rateFor(state, '2026-09', 'USD', 'DOP')).toMatchObject({ source: 'previous', monthKey: '2026-08' });
  });

  it('when no month is left, opening the app creates the current one again, empty', async () => {
    const { db } = await seeded();
    for (const key of ['2026-08', '2026-09', '2026-10']) await deleteMonth(db, F, key);
    expect((await loadState(db, F)).months).toEqual({});
    const state = await openState(db, F, '2026-10');
    expect(state.months).toEqual({ '2026-10': emptyMonth('2026-10') });
    // It is not a first visit: nothing else is added.
    expect(state.accounts).toEqual(seedState().accounts);
    expect(state.goals).toEqual(seedState().goals);
    expect(state.incomes).toHaveLength(3);
    // With no expense or transfer: opening balance plus the incomes.
    expect(balances(state, '2026-10').accounts.map((a) => a.balance)).toEqual([2000 + 17400, 60000]);
  });
});

describe('races between requests (D1 has no interactive transactions)', () => {
  it('ensureMonth: if another request creates the month between the read and the write, its month stands', async () => {
    const { db, sqlite } = await seeded();
    const racy = interleaved(db, (call) => {
      // 1st batch: the read (the month does not exist). 2nd: the creation, which arrives late.
      if (call === 2) sqlite.sqlite.exec("INSERT INTO months (user_id, key) VALUES ('frank', '2026-11')");
    });
    const { month, created } = await ensureMonth(racy, F, '2026-11');
    expect(created).toBe(false);
    // The other request's month, empty: nothing from the copy that was rolled back.
    expect(month).toEqual(emptyMonth('2026-11'));
    expect(count(sqlite, 'fixed_expenses', F)).toBe(33);
    expect(count(sqlite, 'month_budget_log', F)).toBe(4);
  });

  it('ensureMonth: ANOTHER user creating that same month at the same time does not get in the way', async () => {
    const { db, sqlite } = await seeded();
    bystander = null;
    const racy = interleaved(db, (call) => {
      if (call === 2) sqlite.sqlite.exec("INSERT INTO months (user_id, key) VALUES ('eda', '2026-11')");
    });
    const { month, created } = await ensureMonth(racy, F, '2026-11');
    expect(created).toBe(true);
    expect(month).toMatchObject({ key: '2026-11', budgets: { dr: 70000 } });
    expect(month.fixed).toHaveLength(11);
  });

  it('closeMonth: if the next month appears midway, it closes all the same and nothing is duplicated', async () => {
    const { db, sqlite } = await seeded();
    const racy = interleaved(db, (call) => {
      // 1st batch: close + create November; by then "another request" has already created it.
      if (call === 1) sqlite.sqlite.exec("INSERT INTO months (user_id, key) VALUES ('frank', '2026-11')");
    });
    const { closed, next } = await closeMonth(racy, F, '2026-10');
    expect(closed.closed).toBe(true);
    expect(next).toEqual(emptyMonth('2026-11'));
    expect(count(sqlite, 'months', F)).toBe(4);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(33);
  });

  it('patchMonth and setMonthRate: if the month is closed between the check and the write, nothing is written', async () => {
    const { db, sqlite } = await seeded();
    const close = "UPDATE months SET closed = 1 WHERE user_id = 'frank' AND key = '2026-10'";
    const before = await getMonth(db, F, '2026-10');
    // The only batch of each one is the write.
    const racy = () => interleaved(db, (call) => void (call === 1 && sqlite.sqlite.exec(close)));
    await expect(patchMonth(racy(), F, '2026-10', { budgets: { dr: 1, us: 2 } })).rejects.toMatchObject(closedMonth);
    await reopenMonth(db, F, '2026-10');
    await expect(setMonthRate(racy(), F, '2026-10', { from: 'DOP', to: 'USD', rate: 1, date: '2026-10-01' })).rejects.toMatchObject(closedMonth);
    await reopenMonth(db, F, '2026-10');
    await expect(deleteMonthRate(racy(), F, '2026-10', 'USD', 'DOP', '2026-10-01')).rejects.toMatchObject(closedMonth);
    expect(await getMonth(db, F, '2026-10')).toEqual({ ...before, closed: true });
  });

  it('createAccount and createGoal: two creations with the same name at once do not leave two', async () => {
    const { db, sqlite } = await seeded();
    const racyAccount = interleaved(
      db,
      (call) => {
        // 1st statement: the read of the accounts (the name is free). 2nd: the INSERT, which arrives late.
        if (call === 2) sqlite.sqlite.exec("INSERT INTO accounts (user_id, id, name, currency, sort) VALUES ('frank', 'la-otra', 'paypal', 'USD', 2)");
      },
      'prepare',
    );
    await expect(createAccount(racyAccount, F, { name: 'PayPal', currency: 'USD' })).rejects.toMatchObject(conflict);
    expect(count(sqlite, 'accounts', F)).toBe(3);

    const racyGoal = interleaved(
      db,
      (call) => {
        // 1st and 2nd: the reads (goals and settings). 3rd: the INSERT.
        if (call === 3) sqlite.sqlite.exec("INSERT INTO goals (user_id, id, name, sort) VALUES ('frank', 'la-otra', 'car', 3)");
      },
      'prepare',
    );
    await expect(createGoal(racyGoal, F, { name: 'Car' })).rejects.toMatchObject(conflict);
    expect(count(sqlite, 'goals', F)).toBe(4);
  });

  it('patchGoal: what is stored is always a valid plan even if the goal changes between the read and the write', async () => {
    const { db, sqlite } = await seeded();
    const racy = interleaved(
      db,
      (call) => {
        // Another request removes the plan from the goal right before the UPDATE.
        if (call === 2) {
          sqlite.sqlite.exec("UPDATE goals SET monthly = NULL, start_month = NULL, end_month = NULL WHERE user_id = 'frank' AND id = 'turkey'");
        }
      },
      'prepare',
    );
    // Only `end`: valid because the goal it read had a plan. Without writing all three fields, half a plan would remain.
    const goal = await patchGoal(racy, F, 'turkey', { end: '2027-12' });
    expect(goal).toMatchObject({ monthly: 3000, start: '2026-08', end: '2027-12' });
    expect((await listGoals(db, F))[2]).toEqual(goal);
  });

  it('patchAccount: the currency does not change if the account starts being used between the read and the write', async () => {
    const { db, sqlite } = await arrived();
    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    const racy = interleaved(
      db,
      (call) => {
        // 1st statement: the read of the accounts. 2nd: the UPDATE; by then there is already an income in it.
        if (call === 2) {
          sqlite.sqlite.exec("INSERT INTO incomes (user_id, id, date, account_id, amount, currency) VALUES ('frank', 'i', '2026-10-01', 'pp', 1, 'USD')");
        }
      },
      'prepare',
    );
    await expect(patchAccount(racy, F, 'pp', { currency: 'TRY' })).rejects.toMatchObject(conflict);
    expect((await listAccounts(db, F)).find((a) => a.id === 'pp')!.currency).toBe('USD');
  });
});

describe('fixed expenses', () => {
  it('a new fixed expense goes at the end: sort = max(sort) + 1', async () => {
    const { db } = await arrived();
    const a = await createFixed(db, F, { monthKey: '2026-10', name: 'A', amount: 1, cur: 'DOP' });
    const b = await createFixed(db, F, { monthKey: '2026-10', name: 'B', amount: 1, cur: 'DOP' });
    expect([a.sort, b.sort]).toEqual([0, 1]);
    await patchFixed(db, F, b.id, { sort: 7 });
    const c = await createFixed(db, F, { monthKey: '2026-10', name: 'C', amount: 1, cur: 'TRY' });
    expect(c.sort).toBe(8);
    // A fixed expense can be in any of the three currencies, whatever the currency of its account.
    expect(c).toMatchObject({ cur: 'TRY', accountId: 'dr' });
    // The read order is by sort.
    await patchFixed(db, F, a.id, { sort: 9 });
    expect((await getMonth(db, F, '2026-10'))!.fixed.map((f) => f.name)).toEqual(['B', 'C', 'A']);
  });

  it('the order of one user does not depend on the fixed expenses of another in the same month', async () => {
    const { db } = await arrived();
    bystander = null;
    for (const name of ['A', 'B', 'C']) await createFixed(db, E, { monthKey: '2026-10', name, amount: 1, cur: 'DOP' });
    expect((await createFixed(db, F, { monthKey: '2026-10', name: 'A', amount: 1, cur: 'DOP' })).sort).toBe(0);
  });
});

describe('transfers between accounts', () => {
  const transfer = { monthKey: '2026-10', date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 100 };

  it('without a rate it takes the month rate for the currencies of the two accounts; between accounts of the same currency, 1', async () => {
    const { db } = await seeded();
    // October has 1 USD = 58.76 DOP typed.
    expect(await createTransfer(db, F, transfer)).toEqual({ id: expect.any(String), ...transfer, rate: 58.76, budget: false, fee: 0 });
    // In the opposite direction, its inverse.
    const back = await createTransfer(db, F, { ...transfer, fromAccountId: 'dr', toAccountId: 'us', amount: 5876 });
    expect(back.rate).toBeCloseTo(1 / 58.76, 12);

    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    expect((await createTransfer(db, F, { ...transfer, toAccountId: 'pp' })).rate).toBe(1);

    // September has no typed rate: the one from its transfers (weighted average).
    await reopenMonth(db, F, '2026-09');
    const september = await createTransfer(db, F, { ...transfer, monthKey: '2026-09', date: '2026-09-20' });
    expect(september.rate).toBeCloseTo((1500 * 58.55 + 800 * 58.62) / 2300, 10);

    // Nobody ever typed a rate toward a TRY account: the default value (58.76 DOP and 42 TRY per USD).
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY' });
    expect((await createTransfer(db, F, { ...transfer, toAccountId: 'tr' })).rate).toBe(42);
    await setMonthRate(db, F, '2026-10', { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-01' });
    expect((await createTransfer(db, F, { ...transfer, toAccountId: 'tr' })).rate).toBeCloseTo(40, 10);
  });

  it('with a rate it takes the one that is sent, and moves both balances: amount goes out and amount × rate comes in', async () => {
    const { db } = await seeded();
    const [us, dr] = [await balance(db, F, 'us'), await balance(db, F, 'dr')];
    const created = await createTransfer(db, F, { ...transfer, via: 'Banco Popular', rate: 57.5 });
    expect(created).toMatchObject({ via: 'Banco Popular', amount: 100, rate: 57.5 });
    expect(await balance(db, F, 'us')).toBeCloseTo(us - 100, 8);
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr + 5750, 6);

    // Editing it: the amount, the rate and the accounts.
    expect(await patchTransfer(db, F, created.id, { amount: 200, rate: 58 })).toMatchObject({ amount: 200, rate: 58 });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr + 11600, 6);
    const swapped = await patchTransfer(db, F, created.id, { fromAccountId: 'dr', toAccountId: 'us', amount: 5800, rate: 1 / 58 });
    expect(swapped).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us', amount: 5800 });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr - 5800, 6);
    expect(await balance(db, F, 'us')).toBeCloseTo(us + 100, 6);
    await deleteTransfer(db, F, created.id);
    expect([await balance(db, F, 'us'), await balance(db, F, 'dr')]).toEqual([us, dr]);
  });

  it('the two accounts must be different, also when editing just one', async () => {
    const { db, sqlite } = await seeded();
    const same = { ...invalid, message: 'Invalid data: toAccountId: must be different from fromAccountId' };
    await expect(createTransfer(db, F, { ...transfer, toAccountId: 'us' })).rejects.toMatchObject(same);
    await expect(createTransfer(db, F, { ...transfer, toAccountId: 'us', rate: 1 })).rejects.toMatchObject(same);
    expect(count(sqlite, 'transfers', F)).toBe(5);
    // seed-tr-2026-10-1 goes from 'us' to 'dr'.
    await expect(patchTransfer(db, F, 'seed-tr-2026-10-1', { toAccountId: 'us' })).rejects.toMatchObject(same);
    await expect(patchTransfer(db, F, 'seed-tr-2026-10-1', { fromAccountId: 'dr' })).rejects.toMatchObject(same);
    await expect(patchTransfer(db, F, 'seed-tr-2026-10-1', { fromAccountId: 'dr', toAccountId: 'dr' })).rejects.toMatchObject(same);
    expect((await getMonth(db, F, '2026-10'))!.transfers).toEqual(seedState().months['2026-10']!.transfers);
  });

  it('both accounts must exist', async () => {
    const { db, sqlite } = await seeded();
    await expect(createTransfer(db, F, { ...transfer, toAccountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(createTransfer(db, F, { ...transfer, fromAccountId: 'nope', rate: 58 })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(patchTransfer(db, F, 'seed-tr-2026-10-1', { toAccountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    expect(count(sqlite, 'transfers', F)).toBe(5);
    await expect(createTransfer(db, F, { ...transfer, monthKey: '2031-01' })).rejects.toMatchObject(notFound);
    await expect(createTransfer(db, F, { ...transfer, monthKey: '2026-08', date: '2026-08-30' })).rejects.toMatchObject(closedMonth);
    await expect(patchTransfer(db, F, 'seed-tr-2026-08-1', { toAccountId: 'dr', amount: 1 })).rejects.toMatchObject(closedMonth);
  });
});

describe('incomes', () => {
  it('create, list, edit and delete; the income of the month is the sum of those dated in it', async () => {
    const { db } = await seeded();
    expect(await listIncomes(db, F)).toEqual(seedState().incomes);

    const created = await createIncome(db, F, { date: '2026-10-15', desc: 'Freelance', accountId: 'us', amount: 400, cur: 'USD' });
    expect(created).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), date: '2026-10-15', desc: 'Freelance', accountId: 'us', amount: 400, cur: 'USD', budget: false, rate: null, recurring: false });
    expect(monthCalc(await loadState(db, F), '2026-10').income).toBeCloseTo((5800 + 400) * 58.76, 6);
    expect(await balance(db, F, 'us')).toBeCloseTo(13482 + 400, 8);

    // In another currency and to another account: it comes in converted at the rate of the month of its date.
    const patched = await patchIncome(db, F, created.id, { date: '2026-10-16', desc: '', accountId: 'dr', amount: 1000, cur: 'TRY' });
    expect(patched).toEqual({ id: created.id, date: '2026-10-16', desc: '', accountId: 'dr', amount: 1000, cur: 'TRY', budget: false, rate: null, recurring: false });
    expect(await balance(db, F, 'us')).toBeCloseTo(13482, 8);
    expect(await balance(db, F, 'dr')).toBeCloseTo(220641.93 + (1000 * 58.76) / 42, 6);
    expect((await patchIncome(db, F, created.id, { amount: 0 })).amount).toBe(0);
    expect(await patchIncome(db, F, created.id, {})).toEqual({ ...patched, amount: 0 });

    await deleteIncome(db, F, created.id);
    await expect(deleteIncome(db, F, created.id)).rejects.toMatchObject({ ...notFound, message: 'Income not found.' });
    await expect(patchIncome(db, F, created.id, { amount: 1 })).rejects.toMatchObject(notFound);
    expect(await listIncomes(db, F)).toEqual(seedState().incomes);
  });

  it('without a description it stays empty; the id can come from the client and a repeated one is a 409', async () => {
    const { db } = await seeded();
    expect(await createIncome(db, F, { id: 'in-1', date: '2026-10-15', amount: 1, cur: 'DOP' })).toEqual({
      id: 'in-1', date: '2026-10-15', desc: '', accountId: 'dr', amount: 1, cur: 'DOP', budget: false, rate: null, recurring: false,
    });
    await expect(createIncome(db, F, { id: 'in-1', date: '2026-10-15', amount: 1, cur: 'DOP' })).rejects.toMatchObject(conflict);
    await expect(createIncome(db, F, { id: 'seed-in-1', date: '2026-10-15', amount: 1, cur: 'DOP' })).rejects.toMatchObject(conflict);
  });

  it('they do not belong to a month: they are created, edited and deleted even if the month of their date is closed or does not exist', async () => {
    const { db } = await seeded();
    // August is closed.
    const august = await createIncome(db, F, { date: '2026-08-15', desc: 'Bonus', accountId: 'us', amount: 100, cur: 'USD' });
    expect(await balance(db, F, 'us', '2026-08')).toBeCloseTo(2000 + 5800 - 1800 - 106 + 100, 8);
    expect((await patchIncome(db, F, 'seed-in-1', { amount: 6000 })).amount).toBe(6000);
    await deleteIncome(db, F, august.id);
    // Neither 2025 nor 2031 has a month.
    const early = await createIncome(db, F, { date: '2025-12-31', amount: 50, cur: 'USD', accountId: 'us' });
    const late = await createIncome(db, F, { date: '2031-01-01', amount: 70, cur: 'USD', accountId: 'us' });
    const state = await loadState(db, F);
    expect(Object.keys(state.months)).toEqual(['2026-08', '2026-09', '2026-10']);
    // The earlier one already counts in the balance; the later one, not yet.
    expect(await balance(db, F, 'us')).toBeCloseTo(13482 + 200 + 50, 8);
    expect((await patchIncome(db, F, late.id, { date: '2026-09-30' })).date).toBe('2026-09-30');
    expect(await balance(db, F, 'us')).toBeCloseTo(13482 + 200 + 50 + 70, 8);
    await deleteIncome(db, F, early.id);
    // And closing or deleting a month does not touch them.
    await closeMonth(db, F, '2026-10');
    expect((await patchIncome(db, F, 'seed-in-3', { desc: 'October salary' })).desc).toBe('October salary');
  });
});

describe('goals', () => {
  it('a new goal goes at the end (sort = max + 1), in the main currency of the user unless it says another', async () => {
    const { db } = await seeded();
    expect(await createGoal(db, F, { name: 'Car' })).toMatchObject({ cur: 'DOP', sort: 3 });
    await patchGoal(db, F, 'emergency', { sort: 10 });
    expect(await createGoal(db, F, { name: 'House', cur: 'USD' })).toMatchObject({ cur: 'USD', sort: 11 });
    await updateSettings(db, F, { mainCurrency: 'TRY' });
    expect(await createGoal(db, F, { name: 'Istanbul flat', monthly: 10000, start: '2026-10', end: '2027-09' })).toMatchObject({
      cur: 'TRY',
      monthly: 10000,
    });
    // The currency can be changed later; the plan keeps the same numbers.
    expect(await patchGoal(db, F, 'turkey', { cur: 'TRY' })).toEqual({ ...SEED_PLANNED_GOAL, cur: 'TRY' });
  });

  it('the name is unique per user, case-insensitively (also with accents): 409', async () => {
    const { db } = await seeded();
    const taken = { ...conflict, message: 'There is already a goal with that name.' };
    await expect(createGoal(db, F, { name: 'emergency FUND' })).rejects.toMatchObject(taken);
    await createGoal(db, F, { id: 'viaje', name: 'Viaje a Turquía' });
    await expect(createGoal(db, F, { name: 'VIAJE A TURQUÍA' })).rejects.toMatchObject(taken);
    await expect(patchGoal(db, F, 'personal', { name: 'viaje a turquía' })).rejects.toMatchObject(taken);
    // Its own name is not a conflict: it can be rewritten or have its capitalization changed.
    expect((await patchGoal(db, F, 'viaje', { name: 'VIAJE A TURQUÍA' })).name).toBe('VIAJE A TURQUÍA');
    expect((await patchGoal(db, F, 'viaje', { name: 'VIAJE A TURQUÍA', sort: 9 })).sort).toBe(9);
    // Another user can indeed have a goal with that same name.
    bystander = null;
    expect((await createGoal(db, E, { name: 'Viaje a Turquía' })).name).toBe('Viaje a Turquía');
  });

  it('plan: the three fields together or none, also if someone calls the repository without going through validation', async () => {
    const { db } = await seeded();
    await expect(createGoal(db, F, { name: 'A', monthly: 100 })).rejects.toMatchObject(invalid);
    await expect(createGoal(db, F, { name: 'A', start: '2026-01', end: '2026-12' })).rejects.toMatchObject(invalid);
    await expect(createGoal(db, F, { name: 'A', monthly: 100, start: '2027-01', end: '2026-12' })).rejects.toMatchObject(invalid);
    expect(await createGoal(db, F, { name: 'A', monthly: 100, start: '2026-01', end: '2026-12' })).toMatchObject({
      monthly: 100,
      start: '2026-01',
      end: '2026-12',
    });
    expect(await createGoal(db, F, { name: 'B', monthly: null, start: null, end: null })).toMatchObject({ monthly: null });
  });

  it('when editing, the plan rule applies to the resulting goal', async () => {
    const { db } = await seeded();
    // Goal with a plan: changing a single part is valid…
    expect(await patchGoal(db, F, 'turkey', { end: '2028-01' })).toMatchObject({ monthly: 3000, start: '2026-08', end: '2028-01' });
    expect(await patchGoal(db, F, 'turkey', { monthly: 2500 })).toMatchObject({ monthly: 2500, start: '2026-08', end: '2028-01' });
    // …unless the result does not comply.
    await expect(patchGoal(db, F, 'turkey', { start: '2028-02' })).rejects.toMatchObject({
      ...invalid,
      message: 'Invalid data: end: the start month cannot be after the end month',
    });
    await expect(patchGoal(db, F, 'turkey', { monthly: null })).rejects.toMatchObject(invalid);
    await expect(patchGoal(db, F, 'turkey', { start: null, end: null })).rejects.toMatchObject(invalid);
    // Goal without a plan: a single part is not enough.
    await expect(patchGoal(db, F, 'personal', { monthly: 100 })).rejects.toMatchObject({
      ...invalid,
      message: 'Invalid data: monthly: monthly, start and end go together: set all three, or leave all three null',
    });
    await expect(patchGoal(db, F, 'personal', { end: '2027-01' })).rejects.toMatchObject(invalid);
    expect(await patchGoal(db, F, 'personal', { monthly: 100, start: '2026-10', end: '2027-01' })).toMatchObject({ monthly: 100 });
    // Removing the plan: all three to null.
    expect(await patchGoal(db, F, 'turkey', { monthly: null, start: null, end: null })).toMatchObject({
      monthly: null,
      start: null,
      end: null,
    });
    // Name, currency and order do not touch the plan.
    expect(await patchGoal(db, F, 'personal', { name: 'Rainy day', cur: 'DOP', sort: 5 })).toMatchObject({ name: 'Rainy day', cur: 'DOP', sort: 5, monthly: 100 });
    // Nothing that was rejected got saved.
    expect((await listGoals(db, F)).find((g) => g.id === 'emergency')).toEqual(DEFAULT_GOALS[0]);
  });

  it('a goal with contributions cannot be deleted; without them, it can', async () => {
    const { db } = await seeded();
    await expect(deleteGoal(db, F, 'turkey')).rejects.toMatchObject(conflict);
    for (const c of (await listContributions(db, F)).filter((c) => c.goalId === 'turkey')) await deleteContribution(db, F, c.id);
    await deleteGoal(db, F, 'turkey');
    expect((await listGoals(db, F)).map((g) => g.id)).toEqual(['emergency', 'personal']);
  });

  it('a contribution can be in any of the three currencies', async () => {
    const { db } = await seeded();
    const created = await createContribution(db, F, { goalId: 'emergency', date: '2026-10-08', amount: 4200, cur: 'TRY' });
    expect(created).toMatchObject({ goalId: 'emergency', amount: 4200, cur: 'TRY' });
    expect((await patchContribution(db, F, created.id, { cur: 'DOP' })).cur).toBe('DOP');
  });
});

describe('resetAll', () => {
  it('deletes everything; leaves the initial accounts and goals and the given month empty; keeps the settings except the default account', async () => {
    const { db, sqlite } = await seeded();
    await createGoal(db, F, { name: 'Car' });
    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    const theme = { accent: '#112233', header: '#000000', background: '#ffffff' };
    await updateSettings(db, F, { language: 'es', theme, mainCurrency: 'USD', secondCurrency: 'TRY', defaultAccountId: 'pp' });
    await resetAll(db, F, '2026-10');
    expect(await loadState(db, F)).toEqual({
      ...EMPTY,
      months: { '2026-10': emptyMonth('2026-10') },
      accounts: [...DEFAULT_ACCOUNTS],
      goals: [...DEFAULT_GOALS],
      language: 'es',
      theme,
      mainCurrency: 'USD',
      secondCurrency: 'TRY',
    });
    for (const table of ['incomes', 'contributions', 'transactions', 'transfers', 'fixed_expenses', 'month_budget_log', 'month_rates']) {
      expect(count(sqlite, table, F), table).toBe(0);
    }
  });

  it('also works for a user who never visited', async () => {
    const { db } = makeEnv();
    await resetAll(db, F, '2026-10');
    expect(await loadState(db, F)).toEqual({
      ...EMPTY,
      months: { '2026-10': emptyMonth('2026-10') },
      accounts: [...DEFAULT_ACCOUNTS],
      goals: [...DEFAULT_GOALS],
    });
  });
});

// The Excel workbook keeps the original design (two currencies, two accounts). How it maps onto the account model
// is decided by applyImportToState (shared/excel/data.ts), which has its own tests; what is checked here is what the
// repository does with it: which state it starts from, that it stores exactly the resulting one, and that it is atomic.
describe('applyImport', () => {
  const empty: ImportPayload = { months: [], contribs: null, goals: null };
  const NOW = new Date('2026-10-07T12:00:00.000Z');

  const month = (key: string, closed: boolean): ImportPayload['months'][number] => ({
    key,
    closed,
    budget: 65000,
    incomeUSD: 6000,
    accounts: { usd: 100, dop: 200 },
    fixed: [
      { name: 'Luz', day: '', amount: 1500, cur: 'DOP', paid: true },
      { name: 'Claude', day: '5', amount: 106, cur: 'USD', paid: false },
    ],
    transfers: [{ date: `${key}-05`, via: 'Remitly', usd: 1000, rate: 59 }],
    tx: [
      { date: `${key}-02`, desc: 'Café', place: '', cat: 'Food', method: 'Debit card', amount: 250, cur: 'DOP', notes: '' },
      { date: `${key}-03`, desc: 'Libro', place: 'Cuesta', cat: 'Otra', method: 'Efectivo', amount: 20, cur: 'USD', notes: 'n' },
    ],
  });

  /** Makes the new ids come out in sequence, so the same import can be repeated with the pure function. */
  function serialIds(): () => string {
    let n = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `id-${++n}` as ReturnType<typeof crypto.randomUUID>);
    let m = 0;
    return () => `id-${++m}`;
  }

  /** What the pure function leaves undated and the repository sets: the closing of the file's months and the creation of their rows. */
  function stamped(state: AppState, payload: ImportPayload, stamp: string): AppState {
    const keys = new Set(payload.months.map((m) => m.key));
    return {
      ...state,
      months: Object.fromEntries(
        Object.entries(state.months).map(([key, m]) => [
          key,
          {
            ...m,
            closedAt: keys.has(key) && m.closed && m.closedAt === null ? stamp : m.closedAt,
            tx: m.tx.map((t) => ({ ...t, createdAt: t.createdAt ?? stamp })),
          },
        ]),
      ),
    };
  }

  it('stores exactly the state applyImportToState computes over that of the user, with the dates the pure function does not set', async () => {
    const { db } = await seeded();
    const before = await loadState(db, F);
    const payload: ImportPayload = {
      months: [month('2026-10', false), month('2026-11', true)],
      contribs: [
        { date: '2026-10-01', goalName: 'Emergency fund', amount: 100, cur: 'USD' },
        { date: '2026-10-02', goalName: 'Car', amount: 5000, cur: 'DOP' },
      ],
      goals: [
        { name: 'Trip to Turkey', monthlyUSD: 3500, start: '2026-08', end: '2027-12' },
        { name: 'House', monthlyUSD: null, start: null, end: null },
      ],
    };
    const ids = serialIds();
    const res = await applyImport(db, F, payload, NOW);
    expect(res).toEqual({ months: ['2026-10', '2026-11'], contributions: 2 });

    const after = await loadState(db, F);
    expect(after).toEqual(stamped(applyImportToState(before, payload, ids), payload, NOW.toISOString()));

    // And that, concretely, is: the months that are not included, intact (ids and creation dates included)…
    expect(after.months['2026-08']).toEqual(before.months['2026-08']);
    expect(after.months['2026-09']).toEqual(before.months['2026-09']);
    // …the file's month completely replaces the one that was there, with everything in the user's two accounts…
    const oct = after.months['2026-10']!;
    expect(oct).toMatchObject({ closed: false, closedAt: null, budgets: { dr: 65000 }, rates: [] });
    expect(oct.fixed.map((f) => [f.name, f.amount, f.cur, f.paid, f.accountId, f.sort])).toEqual([
      ['Luz', 1500, 'DOP', true, 'dr', 0],
      ['Claude', 106, 'USD', false, 'us', 1],
    ]);
    expect(oct.transfers.map((t) => [t.fromAccountId, t.toAccountId, t.amount, t.rate])).toEqual([['us', 'dr', 1000, 59]]);
    // What is not from the lists (category, method) is stored as is.
    expect(oct.tx.map((t) => [t.date, t.desc, t.cat, t.method, t.amount, t.cur, t.accountId, t.source, t.createdAt])).toEqual([
      ['2026-10-02', 'Café', 'Food', 'Debit card', 250, 'DOP', 'dr', 'import', NOW.toISOString()],
      ['2026-10-03', 'Libro', 'Otra', 'Efectivo', 20, 'USD', 'us', 'import', NOW.toISOString()],
    ]);
    // …the new month is created, closed at the time of the import…
    expect(after.months['2026-11']).toMatchObject({ closed: true, closedAt: NOW.toISOString() });
    // …the workbook's income is the month total: October, which already had 5,800 USD, is only missing 200…
    expect(after.incomes.filter((i) => i.desc === IMPORTED_INCOME).map((i) => [i.date, i.accountId, i.amount, i.cur])).toEqual([
      ['2026-10-01', 'us', 200, 'USD'],
      ['2026-11-01', 'us', 6000, 'USD'],
    ]);
    // …and the balances of the two accounts at the end of the last imported month are the workbook's.
    const last = balances(after, '2026-11').accounts;
    expect(last.find((a) => a.account.id === 'us')!.balance).toBeCloseTo(100, 6);
    expect(last.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(200, 6);
    expect(after.goals.map((g) => [g.name, g.monthly, g.end])).toEqual([
      ['Emergency fund', null, null],
      ['Personal savings', null, null],
      ['Trip to Turkey', 3500, '2027-12'],
      ['House', null, null],
      ['Car', null, null],
    ]);
    expect(after.contribs.map((c) => [c.goalId, c.amount, c.cur])).toEqual([
      ['emergency', 100, 'USD'],
      [after.goals[4]!.id, 5000, 'DOP'],
    ]);
  });

  it('does not touch the settings of the user: not their currencies, their default account, their language or their colors', async () => {
    const { db, sqlite } = await seeded();
    const theme = { accent: '#112233', header: '#000000', background: '#ffffff' };
    await updateSettings(db, F, { language: 'tr', theme, mainCurrency: 'TRY', secondCurrency: 'USD', defaultAccountId: 'us' });
    const settings = () => sqlite.sqlite.prepare('SELECT key, value FROM settings WHERE user_id = ? ORDER BY key').all(F).map((r) => ({ ...r }));
    const before = settings();
    await applyImport(db, F, { ...empty, months: [month('2026-10', false)] });
    expect(settings()).toEqual(before);
    expect(await getSettings(db, F)).toEqual({ theme, language: 'tr', mainCurrency: 'TRY', secondCurrency: 'USD', defaultAccountId: 'us', goldPrice: null });
  });

  it('honors closed: a month that was already closed keeps its closing date; if it arrives open, it is reopened', async () => {
    const { db } = await arrived();
    await applyImport(db, F, { ...empty, months: [month('2026-08', true), month('2026-09', false)] }, NOW);
    const state = await loadState(db, F);
    expect(state.months['2026-08']).toMatchObject({ closed: true, closedAt: NOW.toISOString() });
    expect(state.months['2026-09']).toMatchObject({ closed: false, closedAt: null });
    // The month he already had and that is not in the file is still there.
    expect(Object.keys(state.months)).toEqual(['2026-08', '2026-09', '2026-10']);

    // Reimporting an already closed month keeps its closing date and duplicates nothing.
    await applyImport(db, F, { ...empty, months: [month('2026-08', true)] }, new Date('2027-01-01T00:00:00.000Z'));
    const again = (await getMonth(db, F, '2026-08'))!;
    expect(again.closedAt).toBe(NOW.toISOString());
    expect([again.fixed.length, again.transfers.length, again.tx.length]).toEqual([2, 1, 2]);
    expect((await listIncomes(db, F)).filter((i) => i.date === '2026-08-01')).toHaveLength(1);
    await applyImport(db, F, { ...empty, months: [month('2026-08', false)] });
    expect(await getMonth(db, F, '2026-08')).toMatchObject({ closed: false, closedAt: null });
  });

  it('a user who never visited gets their initial accounts and goals set up first: the workbook lands in them', async () => {
    const { db } = makeEnv();
    await applyImport(db, F, {
      months: [month('2026-10', false)],
      contribs: [{ date: '2026-10-01', goalName: 'emergency FUND', amount: 1, cur: 'USD' }],
      goals: null,
    });
    const state = await loadState(db, F);
    expect(state.accounts.map((a) => [a.id, a.name, a.currency])).toEqual([
      ['us', 'US account', 'USD'],
      ['dr', 'DR account', 'DOP'],
    ]);
    expect(state.months['2026-10']!.tx.map((t) => t.accountId)).toEqual(['dr', 'us']);
    // The workbook's goal is the initial one (case-insensitively), not another new one.
    expect(state.goals).toEqual([...DEFAULT_GOALS]);
    expect(state.contribs.map((c) => c.goalId)).toEqual(['emergency']);
    // And opening the app afterwards adds nothing: he is already flagged and has a month.
    expect(await openState(db, F, '2027-01')).toEqual(state);
  });

  it('contribs: [] deletes the contributions; contribs: null does not touch them', async () => {
    const { db, sqlite } = await seeded();
    await applyImport(db, F, empty);
    expect(count(sqlite, 'contributions', F)).toBe(8);
    await applyImport(db, F, { ...empty, contribs: [] });
    expect(count(sqlite, 'contributions', F)).toBe(0);
    expect(count(sqlite, 'contributions', E)).toBe(8);
  });

  it('splits the INSERTs so as not to exceed 100 parameters per statement, and keeps the order of the file', async () => {
    const { db, sqlite } = makeEnv();
    const day = (i: number) => `2026-10-${String((i % 28) + 1).padStart(2, '0')}`;
    await applyImport(db, F, {
      months: [
        {
          key: '2026-10',
          closed: false,
          budget: 0,
          incomeUSD: 0,
          accounts: { usd: 0, dop: 0 },
          fixed: Array.from({ length: 40 }, (_, i) => ({ name: `Fijo ${i}`, day: '', amount: i, cur: 'DOP' as const, paid: false })),
          transfers: Array.from({ length: 50 }, (_, i) => ({ date: day(i), via: 'Remitly', usd: 100 + i, rate: 58 })),
          tx: Array.from({ length: 250 }, (_, i) => ({
            date: day(i),
            desc: `Gasto ${i}`,
            place: '',
            cat: 'Food',
            method: 'Debit card',
            amount: i + 0.25,
            cur: 'DOP' as const,
            notes: '',
          })),
        },
      ],
      contribs: Array.from({ length: 60 }, (_, i) => ({ date: day(i), goalName: `Meta ${i % 25}`, amount: 1, cur: 'USD' as const })),
      goals: Array.from({ length: 30 }, (_, i) => ({ name: `Meta ${i}`, monthlyUSD: 10, start: '2026-01', end: '2026-12' })),
    });
    expect(count(sqlite, 'fixed_expenses')).toBe(40);
    expect(count(sqlite, 'transfers')).toBe(50);
    expect(count(sqlite, 'transactions')).toBe(250);
    expect(count(sqlite, 'contributions')).toBe(60);
    // The two initial ones plus the 30 from the file.
    expect(count(sqlite, 'goals')).toBe(32);
    const m = (await getMonth(db, F, '2026-10'))!;
    expect(m.tx.map((t) => t.desc)).toEqual(Array.from({ length: 250 }, (_, i) => `Gasto ${i}`));
    expect(m.transfers.map((t) => t.amount)).toEqual(Array.from({ length: 50 }, (_, i) => 100 + i));
    expect(m.fixed.map((f) => f.sort)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect((await listGoals(db, F)).slice(2).map((g) => g.name)).toEqual(Array.from({ length: 30 }, (_, i) => `Meta ${i}`));
  });

  it('many months, accounts, incomes and rates: replaceAll also splits all of its tables', async () => {
    const { db, sqlite } = makeEnv();
    const keys = Array.from({ length: 150 }, (_, i) => `${2010 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
    const state = seedState();
    state.accounts = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, name: `Cuenta ${i}`, currency: 'DOP' as const, opening: i, hidden: false, sort: i }));
    state.defaultAccountId = 'a0';
    state.incomes = Array.from({ length: 80 }, (_, i) => ({ id: `i${i}`, date: `${keys[i]!}-01`, desc: '', accountId: `a${i % 40}`, amount: 1, cur: 'USD' as const, budget: i % 2 === 0, rate: null, recurring: false }));
    state.months = Object.fromEntries(
      keys.map((key) => {
        const month: Month = {
          ...emptyMonth(key),
          closed: true,
          rates: [
            { from: 'USD' as const, to: 'DOP' as const, rate: 58, date: `${key}-01` },
            { from: 'USD' as const, to: 'TRY' as const, rate: 40, date: `${key}-15` },
          ],
          fixed: [{ id: `f-${key}`, monthKey: key, name: 'Luz', day: '', amount: 1, cur: 'DOP' as const, paid: true, accountId: 'a2', sort: 0 }],
        };
        setBudgets(month, { a0: 1, a1: 2 });
        return [key, month];
      }),
    );
    await replaceAll(db, F, state);
    await replaceAll(db, F, state);
    expect(count(sqlite, 'months', F)).toBe(150);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(150);
    expect(count(sqlite, 'month_budget_log', F)).toBe(300);
    expect(count(sqlite, 'month_rates', F)).toBe(300);
    expect(count(sqlite, 'accounts', F)).toBe(40);
    expect(count(sqlite, 'incomes', F)).toBe(80);
    expect(withoutTimestamps(await loadState(db, F))).toEqual(state);
    // An import on top rewrites all of that again.
    await applyImport(db, F, { ...empty, months: [month('2022-06', true)] });
    expect(count(sqlite, 'months', F)).toBe(150);
    expect(count(sqlite, 'accounts', F)).toBe(41);
  });

  it('is atomic: if something fails midway nothing changes', async () => {
    const { db, sqlite } = await seeded();
    const before = await loadState(db, F);
    sqlite.sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON contributions BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(
      applyImport(db, F, {
        months: [month('2026-10', true)],
        contribs: [{ date: '2026-10-01', goalName: 'Nueva', amount: 1, cur: 'USD' }],
        goals: [{ name: 'Trip to Turkey', monthlyUSD: 1, start: '2026-01', end: '2026-02' }],
      }),
    ).rejects.toThrow(/boom/);
    sqlite.sqlite.exec('DROP TRIGGER boom');
    expect(await loadState(db, F)).toEqual(before);
  });

  it('a file with nothing to apply leaves everything the same', async () => {
    const { db } = await seeded();
    const before = await loadState(db, F);
    expect(await applyImport(db, F, empty)).toEqual({ months: [], contributions: 0 });
    expect(await loadState(db, F)).toEqual(before);
  });
});

describe('repository errors', () => {
  it('throws ApiError with the code from the contract and the message in English', async () => {
    const { db } = await seeded();
    const tx = { date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' as const };
    await expect(createTransaction(db, F, { ...tx, monthKey: '2030-01' })).rejects.toBeInstanceOf(ApiError);
    await expect(createTransaction(db, F, { ...tx, monthKey: '2030-01' })).rejects.toMatchObject({
      ...notFound,
      message: 'Month 2030-01 does not exist.',
    });
    await expect(createTransaction(db, F, { ...tx, monthKey: '2026-08' })).rejects.toMatchObject({
      ...closedMonth,
      message: 'August 2026 is closed: it is read-only. Reopen it to make changes.',
    });
    await expect(createTransaction(db, F, { ...tx, monthKey: '2026-10', id: 'seed-tx-2026-10-1' })).rejects.toMatchObject({
      ...conflict,
      message: 'A record with that id already exists.',
    });
    await expect(createTransaction(db, F, { ...tx, monthKey: '2026-10', accountId: 'nope' })).rejects.toMatchObject({
      ...invalid,
      message: 'Unknown account "nope".',
    });
    await expect(deleteFixed(db, F, 'nope')).rejects.toMatchObject({ status: 404, message: 'Monthly expense not found.' });
    await expect(deleteTransaction(db, F, 'nope')).rejects.toMatchObject({ status: 404, message: 'Transaction not found.' });
    await expect(deleteTransfer(db, F, 'nope')).rejects.toMatchObject({ status: 404, message: 'Transfer not found.' });
    await expect(deleteIncome(db, F, 'nope')).rejects.toMatchObject({ status: 404, message: 'Income not found.' });
    await expect(deleteAccount(db, F, 'nope')).rejects.toMatchObject({ status: 404, message: 'Account not found.' });
    await expect(deleteGoal(db, F, 'nope')).rejects.toMatchObject({ status: 404, message: 'Goal not found.' });
    await expect(deleteContribution(db, F, 'nope')).rejects.toMatchObject({ status: 404, message: 'Contribution not found.' });
  });
});
