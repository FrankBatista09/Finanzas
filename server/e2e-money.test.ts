// End to end, the money model: a scripted month with round figures, recorded through the API and through the
// MCP tools, and checked against calculations done by hand (not against whatever shared/calc.ts returns with
// other data). All the pieces are the real ones (API + the D1 from server/d1-node.ts + MCP + Excel).
//
// The script (main currency TRY, second USD; typed month rates: 1 USD = 60 DOP and 1 USD = 40 TRY, so
// TRY↔DOP comes from crossing through USD: 1 TRY = 1.5 DOP):
//
//   Accounts       us  USD  opening  1,000      dr  DOP  opening 10,000      tr  TRY  opening 20,000 (default)
//                  cash DOP opening 500, hidden: it is computed but does not count toward the total money
//   Budget         dr 30,000 DOP → then 36,000 DOP (= 24,000 TRY)   +   tr 8,000 TRY             = 32,000 TRY
//   Income         3,000 USD → us      12,000 TRY → tr      100 USD → dr (6,000 DOP in)          = 136,000 TRY
//   Transactions   400 TRY from tr · 3,000 DOP from dr · 50 USD from dr (3,000 DOP out) · 600 DOP from tr (400 TRY out)
//                  in TRY: 400 + 2,000 + 2,000 + 400                                             =   4,800 TRY
//   Fixed expenses Rent 6,000 TRY from tr (gets marked paid) · Internet 1,500 DOP from dr (pending = 1,000 TRY)
//                  Claude 20 USD from us (paid = 800 TRY)                           paid         =   6,800 TRY
//   Transfers      us → dr 500 USD at 59 (29,500 DOP in) · tr → us 4,000 TRY at the month rate (100 USD in)
//                  dr → tr 3,000 DOP at the month rate (2,000 TRY in)
//
//   Used 11,600 TRY (290 USD) · available 20,400 · after pending 19,400
//   Balances us = 1,000 + 3,000 − 20 − 500 + 100            =  3,580 USD
//            dr = 10,000 + 6,000 − 3,000 − 3,000 + 29,500 − 3,000 = 36,500 DOP
//            tr = 20,000 + 12,000 − 400 − 400 − 6,000 − 4,000 + 2,000 = 23,200 TRY
//   Total money = 3,580 × 40 + 36,500 / 1.5 + 23,200 = 190,733.33 TRY

import { describe, expect, it } from 'vitest';
import type { CloseResponse, ImportPayload, MonthSummary, StateResponse } from '../shared/api';
import { balances, goalsProgress, incomeRows, monthCalc, rateFor, sortedKeys } from '../shared/calc';
import { XLSX_MIME } from '../shared/excel/export';
import { parseFinanzasXlsx } from '../shared/excel/import';
import { nextKey } from '../shared/month';
import type { Account, AppState, FixedExpense, Goal, MonthKey } from '../shared/types';
import type { Env } from './env';
import { loadState } from './db';
import { handleMcp } from './mcp';
import { client, EDA, FRANK, makeEnv, TOKEN } from './test-util';
import type { Client } from './test-util';

const ANA = { id: 'ana', name: 'Ana' };

function fresh() {
  const t = makeEnv({ USERS: 'frank:Frank,eda:Eda,ana:Ana' });
  return { ...t, frank: client(t.env, FRANK.id), eda: client(t.env, EDA.id), ana: client(t.env, ANA.id) };
}

async function ok<T>(reply: Promise<{ status: number; body: T; error: { message: string } | undefined }>, status = 200): Promise<T> {
  const r = await reply;
  expect(r.status, r.error?.message).toBe(status);
  return r.body;
}

async function getState(api: Client): Promise<AppState> {
  return (await ok(api.get<StateResponse>('/api/state'))).state;
}

interface ToolReply {
  text: string;
  isError: boolean;
  data: Record<string, unknown>;
}

/** A call to an MCP tool, the way Claude would make it. `now` sets the server's "today". */
async function tool(env: Env, now: Date, user: string, name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const res = await handleMcp(
    new Request('https://finanzas.example/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { user, ...args } } }),
    }),
    env,
    now,
  );
  expect(res.status).toBe(200);
  const { result } = (await res.json()) as { result: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> } };
  return { text: result.content[0]!.text, isError: result.isError === true, data: result.structuredContent ?? {} };
}

async function done(reply: Promise<ToolReply>): Promise<ToolReply> {
  const r = await reply;
  expect(r.isError, r.text).toBe(false);
  return r;
}

/** What is not a movement: first visit, accounts, currencies, month rates, budget and the fixed expenses. Returns the month. */
async function setUp(api: Client): Promise<MonthKey> {
  // First visit: the two starting accounts and the current month.
  const first = await getState(api);
  expect(rateFor(first, sortedKeys(first)[0]!, 'TRY', 'DOP').source).toBe('default');
  expect(first.accounts.map((a) => [a.id, a.currency, a.opening])).toEqual([['us', 'USD', 0], ['dr', 'DOP', 0]]);
  expect([first.mainCurrency, first.secondCurrency, first.defaultAccountId]).toEqual(['DOP', 'USD', null]);
  const key = sortedKeys(first)[0]!;

  await ok(api.patch('/api/accounts/us', { opening: 1000 }));
  await ok(api.patch('/api/accounts/dr', { opening: 10000 }));
  await ok(api.post<Account>('/api/accounts', { id: 'tr', name: 'TR account', currency: 'TRY', opening: 20000 }), 201);
  await ok(api.post<Account>('/api/accounts', { id: 'cash', name: 'Cash', currency: 'DOP', opening: 500 }), 201);
  await ok(api.patch('/api/accounts/cash', { hidden: true }));

  await ok(api.patch('/api/settings', { mainCurrency: 'TRY', secondCurrency: 'USD', defaultAccountId: 'tr' }));
  // The script's two rates apply from day 1: all of its rows are converted with them.
  await ok(api.put(`/api/months/${key}/rates`, { from: 'USD', to: 'DOP', rate: 60, date: `${key}-01` }));
  await ok(api.put(`/api/months/${key}/rates`, { from: 'USD', to: 'TRY', rate: 40, date: `${key}-01` }));
  await ok(api.patch(`/api/months/${key}`, { budgets: { dr: 30000, tr: 8000 } }));
  // With two typed rates, the third comes from crossing through USD.
  expect(rateFor(await getState(api), key, 'TRY', 'DOP')).toMatchObject({ rate: expect.closeTo(1.5, 10), source: 'cross', monthKey: key });

  await ok(api.post<FixedExpense>('/api/fixed', { id: 'rent', monthKey: key, name: 'Rent', day: '1', amount: 6000, cur: 'TRY' }), 201);
  await ok(api.post<FixedExpense>('/api/fixed', { id: 'net', monthKey: key, name: 'Internet', amount: 1500, cur: 'DOP', accountId: 'dr' }), 201);
  await ok(api.post<FixedExpense>('/api/fixed', { id: 'claude', monthKey: key, name: 'Claude', amount: 20, cur: 'USD', accountId: 'us', paid: true }), 201);
  return key;
}

/** The script's movements, through the API. */
async function movementsByApi(api: Client, key: MonthKey): Promise<void> {
  const d = (day: string) => `${key}-${day}`;
  await ok(api.post('/api/incomes', { date: d('01'), desc: 'Salary', accountId: 'us', amount: 3000, cur: 'USD' }), 201);
  // No account: it goes into the default one (tr).
  await ok(api.post('/api/incomes', { date: d('02'), desc: 'Maaş', amount: 12000, cur: 'TRY' }), 201);
  await ok(api.post('/api/incomes', { date: d('03'), desc: 'Gift', accountId: 'dr', amount: 100, cur: 'USD' }), 201);

  const tx = { monthKey: key, cat: 'Food', method: 'Debit card' };
  await ok(api.post('/api/transactions', { ...tx, date: d('04'), desc: 'Kahve', amount: 400, cur: 'TRY' }), 201);
  await ok(api.post('/api/transactions', { ...tx, date: d('05'), desc: 'Groceries', amount: 3000, cur: 'DOP', accountId: 'dr' }), 201);
  await ok(api.post('/api/transactions', { ...tx, date: d('06'), desc: 'Hosting', amount: 50, cur: 'USD', accountId: 'dr' }), 201);
  await ok(api.post('/api/transactions', { ...tx, date: d('07'), desc: 'Souvenir', amount: 600, cur: 'DOP', accountId: 'tr' }), 201);

  const tr = { monthKey: key, via: 'Remitly' };
  await ok(api.post('/api/transfers', { ...tr, date: d('08'), fromAccountId: 'us', toAccountId: 'dr', amount: 500, rate: 59 }), 201);
  await ok(api.post('/api/transfers', { ...tr, date: d('09'), fromAccountId: 'tr', toAccountId: 'us', amount: 4000 }), 201);
  await ok(api.post('/api/transfers', { ...tr, date: d('10'), fromAccountId: 'dr', toAccountId: 'tr', amount: 3000 }), 201);

  await ok(api.patch('/api/fixed/rent', { paid: true }));
  await ok(api.patch(`/api/months/${key}`, { budgets: { dr: 36000 } }));
}

/** The same movements, dictated to Claude: accounts by name, and whatever is left unsaid takes its default. */
async function movementsByMcp(env: Env, api: Client, now: Date, user: string, key: MonthKey): Promise<void> {
  const d = (day: string) => `${key}-${day}`;
  const say = (name: string, args: Record<string, unknown>) => done(tool(env, now, user, name, args));
  await say('add_income', { amount: 3000, currency: 'USD', account: 'US account', date: d('01'), description: 'Salary' });
  // No account or currency: the default account (tr) and its currency.
  await say('add_income', { amount: 12000, date: d('02'), description: 'Maaş' });
  await say('add_income', { amount: 100, currency: 'USD', account: 'dr account', date: d('03'), description: 'Gift' });

  await say('add_transaction', { description: 'Kahve', amount: 400, date: d('04') });
  await say('add_transaction', { description: 'Groceries', amount: 3000, account: 'DR', date: d('05') });
  await say('add_transaction', { description: 'Hosting', amount: 50, currency: 'USD', account: 'dr', date: d('06') });
  await say('add_transaction', { description: 'Souvenir', amount: 600, currency: 'DOP', account: 'TR account', date: d('07') });

  await say('add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 500, rate: 59, date: d('08') });
  const toUs = await say('add_transfer', { from_account: 'TR account', to_account: 'US account', amount: 4000, date: d('09') });
  expect(toUs.text).toContain(`typed on ${key}-01`);
  const toTr = await say('add_transfer', { from_account: 'DR account', to_account: 'TR account', amount: 3000, date: d('10') });
  expect(toTr.text).toContain('crossed through USD');

  await say('mark_fixed_paid', { name: 'Rent', month: key });
  // The budget is not changed from Claude: through the API, as on the web.
  await ok(api.patch(`/api/months/${key}`, { budgets: { dr: 36000 } }));
}

const balanceOf = (state: AppState, asOf: MonthKey) => Object.fromEntries(balances(state, asOf).accounts.map((a) => [a.account.id, a.balance]));

/** The script's figures, worked out by hand (file header). */
function expectScriptedMonth(state: AppState, key: MonthKey, asOf: MonthKey = key): void {
  expect([state.mainCurrency, state.secondCurrency, state.defaultAccountId]).toEqual(['TRY', 'USD', 'tr']);

  // Rates: two typed by hand. The third used to come from crossing through USD; the dr → tr transfer was saved with
  // that same rate, and since then the pair has the rate of its own transfers (the same number, a different source).
  expect(rateFor(state, key, 'USD', 'DOP')).toEqual({ rate: 60, source: 'month', monthKey: key, date: `${key}-01` });
  expect(rateFor(state, key, 'TRY', 'USD')).toEqual({ rate: 1 / 40, source: 'month', monthKey: key, date: `${key}-01` });
  expect(rateFor(state, key, 'TRY', 'DOP')).toMatchObject({ rate: expect.closeTo(1.5, 10), source: 'transfers', monthKey: key });

  const c = monthCalc(state, key);
  expect(c.main).toBe('TRY');
  expect(c.budgetParts.map((p) => [p.account.id, p.amount])).toEqual([['us', 0], ['dr', 36000], ['tr', 8000]]);
  expect(c.budget).toBeCloseTo(32000, 6);
  expect(c.budgetSecond).toBeCloseTo(800, 6);
  expect(c.varSpent).toBeCloseTo(4800, 6);
  expect(c.fixedPaid).toBeCloseTo(6800, 6);
  expect(c.pending).toBeCloseTo(1000, 6);
  expect([c.paidCount, c.fixedCount, c.txCount]).toEqual([2, 3, 4]);
  expect(c.used).toBeCloseTo(11600, 6);
  expect(c.usedSecond).toBeCloseTo(290, 6);
  expect(c.avail).toBeCloseTo(20400, 6);
  expect(c.after).toBeCloseTo(19400, 6);
  expect(c.income).toBeCloseTo(136000, 6);
  expect(c.incomeLeft).toBeCloseTo(124400, 6);

  // The transfers without a rate saved the month rate for their pair.
  const month = state.months[key]!;
  expect(month.transfers.map((t) => [t.fromAccountId, t.toAccountId, t.amount])).toEqual([['us', 'dr', 500], ['tr', 'us', 4000], ['dr', 'tr', 3000]]);
  expect(month.transfers.map((t) => t.rate)).toEqual([59, expect.closeTo(0.025, 12), expect.closeTo(1 / 1.5, 12)]);
  // Each row keeps its original amount and currency, and the account it comes out of.
  expect(month.tx.map((t) => [t.desc, t.amount, t.cur, t.accountId])).toEqual([
    ['Kahve', 400, 'TRY', 'tr'],
    ['Groceries', 3000, 'DOP', 'dr'],
    ['Hosting', 50, 'USD', 'dr'],
    ['Souvenir', 600, 'DOP', 'tr'],
  ]);
  expect(state.incomes.map((i) => [i.desc, i.amount, i.cur, i.accountId])).toEqual([
    ['Salary', 3000, 'USD', 'us'],
    ['Maaş', 12000, 'TRY', 'tr'],
    ['Gift', 100, 'USD', 'dr'],
  ]);

  const b = balances(state, asOf);
  const byId = Object.fromEntries(b.accounts.map((a) => [a.account.id, a]));
  expect(byId.us!.balance).toBeCloseTo(3580, 6);
  expect(byId.dr!.balance).toBeCloseTo(36500, 6);
  expect(byId.tr!.balance).toBeCloseTo(23200, 6);
  expect(byId.cash!.balance).toBe(500);
  expect(byId.us!.inMain).toBeCloseTo(143200, 6);
  expect(byId.dr!.inSecond).toBeCloseTo(36500 / 60, 6);
  // The hidden account does not count.
  expect(b.totalMain).toBeCloseTo(143200 + 36500 / 1.5 + 23200, 6);
  expect(b.totalSecond).toBeCloseTo(3580 + 36500 / 60 + 580, 6);
}

describe('end to end: the scripted month', () => {
  it('through the API: balances, budget, used and income are the ones worked out by hand; on close, the next month inherits them', async () => {
    const { frank } = fresh();
    const key = await setUp(frank);
    await movementsByApi(frank, key);

    const state = await getState(frank);
    expectScriptedMonth(state, key);

    // The summary of months speaks in the main currency.
    expect(await ok(frank.get<MonthSummary[]>('/api/months'))).toEqual([
      { key, closed: false, closedAt: null, main: 'TRY', budget: expect.closeTo(32000, 6), used: expect.closeTo(11600, 6), txCount: 4 },
    ]);

    // A goal in TRY with a contribution in USD: it is converted to the goal's currency and moves no balance.
    const goal = await ok(frank.post<Goal>('/api/goals', { name: 'Araba', monthly: 5000, start: key, end: nextKey(key) }), 201);
    expect(goal.cur).toBe('TRY');
    await ok(frank.post('/api/contributions', { goalId: goal.id, date: `${key}-11`, amount: 50, cur: 'USD' }), 201);
    const withGoal = await getState(frank);
    expectScriptedMonth(withGoal, key);
    const progress = goalsProgress(withGoal).find((g) => g.id === goal.id)!;
    expect([progress.cur, progress.saved, progress.target?.targetAmount]).toEqual(['TRY', expect.closeTo(2000, 6), 10000]);
    expect(incomeRows(withGoal)[0]).toMatchObject({ income: expect.closeTo(136000, 6), saved: expect.closeTo(2000, 6) });

    // Closing: the month becomes read-only and the next one starts with the fixed expenses unpaid and the same budget.
    const next = nextKey(key);
    const closed = await ok(frank.post<CloseResponse>(`/api/months/${key}/close`));
    expect(closed.closed.closed).toBe(true);
    expect(closed.next).toMatchObject({ key: next, closed: false, budgets: { dr: 36000, tr: 8000 }, rates: [], tx: [], transfers: [] });
    expect(closed.next.fixed.map((f) => [f.name, f.amount, f.cur, f.paid, f.accountId])).toEqual([
      ['Rent', 6000, 'TRY', false, 'tr'],
      ['Internet', 1500, 'DOP', false, 'dr'],
      ['Claude', 20, 'USD', false, 'us'],
    ]);
    for (const write of [
      frank.post('/api/transactions', { monthKey: key, date: `${key}-12`, desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'TRY' }),
      frank.patch('/api/fixed/net', { paid: true }),
      frank.patch(`/api/months/${key}`, { budgets: { tr: 1 } }),
      frank.put(`/api/months/${key}/rates`, { from: 'USD', to: 'DOP', rate: 61, date: `${key}-01` }),
      frank.del(`/api/months/${key}/rates/USD/DOP?date=${key}-01`),
      frank.post(`/api/months/${key}/budget-log`, { accountId: 'dr', amount: 1 }),
      frank.post('/api/transfers', { monthKey: key, date: `${key}-12`, via: 'x', fromAccountId: 'us', toAccountId: 'dr', amount: 1 }),
    ]) {
      const r = await write;
      expect([r.status, r.error?.code]).toEqual([409, 'month_closed']);
    }

    // Nothing moved: the balances at the end of the next month are the same, with the previous month's rates.
    const after = await getState(frank);
    expectScriptedMonth(after, key, next);
    expect(rateFor(after, next, 'USD', 'TRY')).toEqual({ rate: 40, source: 'previous', monthKey: key, date: `${key}-01` });
    expect(monthCalc(after, next)).toMatchObject({ budget: expect.closeTo(32000, 6), used: 0, pending: expect.closeTo(7800, 6), income: 0 });
  });

  it('through the MCP tools: the same figures, and what Claude answers is what the app computes', async () => {
    const { env, eda } = fresh();
    const key = await setUp(eda);
    const now = new Date(`${key}-15T16:00:00Z`);
    await movementsByMcp(env, eda, now, EDA.id, key);

    const state = await getState(eda);
    expectScriptedMonth(state, key);
    expect(state.months[key]!.tx.every((t) => t.source === 'claude')).toBe(true);

    const accounts = await done(tool(env, now, EDA.id, 'list_accounts'));
    expect(accounts.data).toMatchObject({
      mainCurrency: 'TRY',
      secondCurrency: 'USD',
      defaultAccountId: 'tr',
      hiddenCount: 1,
      accounts: [
        { id: 'us', currency: 'USD', balance: expect.closeTo(3580, 6), isDefault: false },
        { id: 'dr', currency: 'DOP', balance: expect.closeTo(36500, 6), isDefault: false },
        { id: 'tr', currency: 'TRY', balance: expect.closeTo(23200, 6), isDefault: true },
      ],
      totalMoney: { main: expect.closeTo(143200 + 36500 / 1.5 + 23200, 6), second: expect.closeTo(3580 + 36500 / 60 + 580, 6) },
    });
    expect(accounts.text).toContain('Total money: 190,733.33 TRY (4,768.33 USD)');

    const summary = await done(tool(env, now, EDA.id, 'month_summary', { month: key }));
    expect(summary.data).toMatchObject({
      month: key,
      currency: 'TRY',
      secondCurrency: 'USD',
      budget: expect.closeTo(32000, 6),
      budgetSecond: expect.closeTo(800, 6),
      used: expect.closeTo(11600, 6),
      usedSecond: expect.closeTo(290, 6),
      available: expect.closeTo(20400, 6),
      availableAfterPending: expect.closeTo(19400, 6),
      fixed: { count: 3, paidCount: 2, paid: expect.closeTo(6800, 6), pending: expect.closeTo(1000, 6) },
      transactions: { count: 4, total: expect.closeTo(4800, 6) },
      income: { count: 3, total: expect.closeTo(136000, 6), left: expect.closeTo(124400, 6) },
      totalMoney: { main: expect.closeTo(143200 + 36500 / 1.5 + 23200, 6) },
    });
    expect(summary.text).toContain('Budget: 32,000.00 TRY');
    expect(summary.text).toContain(`USD to TRY: 40.00 (typed on ${key}-01)`);

    // What is not possible: an account that does not exist, the same account twice, a closed month.
    const unknown = await tool(env, now, EDA.id, 'add_transaction', { description: 'x', amount: 1, account: 'Wise' });
    expect([unknown.isError, unknown.text]).toEqual([true, expect.stringContaining('unknown account "Wise"')]);
    const same = await tool(env, now, EDA.id, 'add_transfer', { from_account: 'tr', to_account: 'TR account', amount: 1 });
    expect([same.isError, same.text]).toEqual([true, expect.stringContaining('must be a different account')]);
    await ok(eda.post(`/api/months/${key}/close`));
    const late = await tool(env, now, EDA.id, 'add_transaction', { description: 'x', amount: 1, date: `${key}-14` });
    expect(late.isError).toBe(true);
    expectScriptedMonth(await getState(eda), key);
  });

  it('two users with the same script do not mix, and deleting a month puts the balances back as they were', async () => {
    const { env, db, frank, eda } = fresh();
    const key = await setUp(frank);
    expect(await setUp(eda)).toBe(key);
    await movementsByApi(frank, key);
    await movementsByMcp(env, eda, new Date(`${key}-15T16:00:00Z`), EDA.id, key);
    expectScriptedMonth(await getState(frank), key);
    expectScriptedMonth(await getState(eda), key);
    const edaBefore = await loadState(db, EDA.id);

    // Frank closes and carries on in the next month: an expense, a transfer and a paid fixed expense move his balances…
    const next = nextKey(key);
    const closed = await ok(frank.post<CloseResponse>(`/api/months/${key}/close`));
    await ok(frank.post('/api/transactions', { monthKey: next, date: `${next}-02`, desc: 'Bilet', cat: 'Travel', method: 'Debit card', amount: 1000, cur: 'TRY' }), 201);
    await ok(frank.post('/api/transfers', { monthKey: next, date: `${next}-03`, via: 'Wise', fromAccountId: 'us', toAccountId: 'tr', amount: 100, rate: 41 }), 201);
    await ok(frank.patch(`/api/fixed/${closed.next.fixed.find((f) => f.name === 'Claude')!.id}`, { paid: true }));
    const moved = await getState(frank);
    expect(balanceOf(moved, next)).toEqual({ us: expect.closeTo(3460, 6), dr: expect.closeTo(36500, 6), tr: expect.closeTo(26300, 6), cash: 500 });
    // …and the balance at the end of the closed month does not change because of what happens afterwards.
    expectScriptedMonth(moved, key);

    // Deleting the next month takes its movements with it: the balances come back.
    expect(await ok(frank.del(`/api/months/${next}`))).toEqual({ ok: true });
    const back = await getState(frank);
    expect(sortedKeys(back)).toEqual([key]);
    expectScriptedMonth(back, key);
    expect((await frank.get(`/api/months/${next}`)).status).toBe(404);
    expect((await frank.del(`/api/months/${next}`)).status).toBe(404);

    // Deleting the closed month too: what remains is the opening balances plus the incomes, which belong to no month.
    // The next visit creates the current month, empty and with no rates: conversion falls back to the default value.
    await ok(frank.del(`/api/months/${key}`));
    const empty = await getState(frank);
    const [only] = sortedKeys(empty);
    expect(empty.months[only!]).toMatchObject({ closed: false, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] });
    expect(empty.incomes).toHaveLength(3);
    expect(rateFor(empty, only!, 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'default', monthKey: null, date: null });
    expect(balanceOf(empty, only!)).toEqual({ us: 4000, dr: expect.closeTo(10000 + 100 * 58.76, 6), tr: 32000, cash: 500 });

    // None of this touched Eda.
    expect(await loadState(db, EDA.id)).toEqual(edaBefore);
    expectScriptedMonth(await getState(eda), key);
  });

  it('model errors: unknown account, transfer to the same account, equal currencies, account in use', async () => {
    const { frank } = fresh();
    const key = await setUp(frank);
    await movementsByApi(frank, key);
    const tx = { monthKey: key, date: `${key}-12`, desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'TRY' };
    const cases: [Promise<{ status: number; error: { code: string } | undefined }>, number, string][] = [
      [frank.post('/api/transactions', { ...tx, accountId: 'wise' }), 400, 'validation'],
      [frank.post('/api/incomes', { date: `${key}-12`, amount: 1, cur: 'USD', accountId: 'wise' }), 400, 'validation'],
      [frank.patch(`/api/months/${key}`, { budgets: { wise: 10 } }), 400, 'validation'],
      [frank.post('/api/transfers', { monthKey: key, date: `${key}-12`, via: 'x', fromAccountId: 'tr', toAccountId: 'tr', amount: 1 }), 400, 'validation'],
      [frank.patch('/api/settings', { secondCurrency: 'TRY' }), 400, 'validation'],
      [frank.patch('/api/settings', { mainCurrency: 'USD', secondCurrency: 'USD' }), 400, 'validation'],
      [frank.patch('/api/settings', { defaultAccountId: 'wise' }), 400, 'validation'],
      [frank.put(`/api/months/${key}/rates`, { from: 'USD', to: 'USD', rate: 1, date: `${key}-01` }), 400, 'validation'],
      [frank.del('/api/accounts/tr'), 409, 'conflict'],
      [frank.patch('/api/accounts/tr', { currency: 'USD' }), 409, 'conflict'],
    ];
    for (const [reply, status, code] of cases) {
      const r = await reply;
      expect([r.status, r.error?.code]).toEqual([status, code]);
    }
    // None of them left anything half done.
    expectScriptedMonth(await getState(frank), key);
    // Swapping the two currencies is allowed, by sending them together; and an unused account can be deleted.
    await ok(frank.patch('/api/settings', { mainCurrency: 'USD', secondCurrency: 'TRY' }));
    expect(monthCalc(await getState(frank), key)).toMatchObject({ main: 'USD', used: expect.closeTo(290, 6), usedSecond: expect.closeTo(11600, 6) });
    await ok(frank.del('/api/accounts/cash'));
  });
});

describe('end to end: Excel as a summary of the account model', () => {
  async function download(api: Client): Promise<{ bytes: Uint8Array; book: ImportPayload }> {
    const res = await api.raw('/api/export.xlsx', { method: 'GET' });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, book: parseFinanzasXlsx(bytes) };
  }

  it('exporting the scripted month and importing it into an empty user gives the same totals in the terms of the workbook', async () => {
    const { frank, ana } = fresh();
    const key = await setUp(frank);
    await movementsByApi(frank, key);
    const goal = await ok(frank.post<Goal>('/api/goals', { name: 'Araba', monthly: 5000, start: key, end: nextKey(key) }), 201);
    await ok(frank.post('/api/contributions', { goalId: goal.id, date: `${key}-11`, amount: 3000, cur: 'TRY' }), 201);
    const source = await getState(frank);
    const { bytes, book } = await download(frank);

    // The workbook, in its own terms (DOP and USD, two accounts), with the app's month rates.
    expect(book.months).toHaveLength(1);
    const m = book.months[0]!;
    expect(m.budget).toBeCloseTo(36000 + 8000 * 1.5, 6); // 48,000 DOP
    expect(m.incomeUSD).toBeCloseTo(3000 + 12000 / 40 + 100, 6); // 3,400 USD
    expect(m.accounts.dop).toBeCloseTo(36500, 6); // the hidden account does not count
    expect(m.accounts.usd).toBeCloseTo(3580 + 23200 / 40, 6); // what is not DOP, in USD
    // What was in TRY arrives in DOP; only the transfers between USD and DOP travel.
    expect(m.tx.map((t) => [t.desc, t.amount, t.cur])).toEqual([
      ['Kahve', expect.closeTo(600, 6), 'DOP'],
      ['Groceries', 3000, 'DOP'],
      ['Hosting', 50, 'USD'],
      ['Souvenir', 600, 'DOP'],
    ]);
    expect(m.fixed.map((f) => [f.name, f.amount, f.cur, f.paid])).toEqual([
      ['Rent', expect.closeTo(9000, 6), 'DOP', true],
      ['Internet', 1500, 'DOP', false],
      ['Claude', 20, 'USD', true],
    ]);
    expect(m.transfers.map((t) => [t.usd, t.rate])).toEqual([[500, 59]]);
    expect(book.contribs).toEqual([{ date: `${key}-11`, goalName: 'Araba', amount: expect.closeTo(75, 6), cur: 'USD' }]);

    // Ana never visited: importing creates her starting accounts and dumps the workbook into them.
    const res = await ana.raw('/api/import', { method: 'POST', headers: { 'Content-Type': XLSX_MIME }, body: bytes });
    expect(res.status).toBe(200);
    const imported = await getState(ana);
    expect(imported.accounts.map((a) => [a.id, a.currency])).toEqual([['us', 'USD'], ['dr', 'DOP']]);
    expect(imported.months[key]).toMatchObject({ budgets: { dr: expect.closeTo(48000, 6) }, rates: [] });

    // Ana's workbook says the same as Frank's.
    const again = (await download(ana)).book;
    const approx = (book: ImportPayload) => JSON.parse(JSON.stringify(book), (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)) as ImportPayload;
    expect(approx(again)).toEqual(approx(book));

    // And in the app, the totals the workbook knows how to carry match: the last month's balances, income and budget.
    const b = balanceOf(imported, key);
    expect(b.us).toBeCloseTo(3580 + 23200 / 40, 6);
    expect(b.dr).toBeCloseTo(36500, 6);
    const dop = { ...imported, mainCurrency: 'DOP' as const, secondCurrency: 'USD' as const };
    const sourceDop = { ...source, mainCurrency: 'DOP' as const, secondCurrency: 'USD' as const };
    expect(monthCalc(dop, key).budget).toBeCloseTo(monthCalc(sourceDop, key).budget, 6);
    // The workbook gets its rate from the month's transfers (59), not the typed one (60): conversions differ by just that.
    expect(rateFor(imported, key, 'USD', 'DOP')).toEqual({ rate: 59, source: 'transfers', monthKey: key, date: null });
    expect(monthCalc(dop, key).income).toBeCloseTo(3400 * 59, 6);
    expect(monthCalc(sourceDop, key).income).toBeCloseTo(3400 * 60, 6);
    // Spent, in DOP: 600 + 3,000 + 600 + 9,000 in DOP and 70 USD at each one's rate.
    expect(monthCalc(dop, key).used).toBeCloseTo(13200 + 70 * 59, 6);
    expect(monthCalc(sourceDop, key).used).toBeCloseTo(13200 + 70 * 60, 6);

    // Reloading his own workbook does not duplicate the month's income or inflate the total money, even though Frank
    // has three visible accounts. It does lose what the workbook does not carry: the typed rates and the budget split.
    const reload = await frank.raw('/api/import', { method: 'POST', headers: { 'Content-Type': XLSX_MIME }, body: bytes });
    expect(reload.status).toBe(200);
    const reloaded = (await download(frank)).book.months[0]!;
    expect(reloaded.incomeUSD).toBeCloseTo(3400, 6);
    expect(reloaded.accounts.dop).toBeCloseTo(36500, 6);
    expect(reloaded.accounts.usd).toBeCloseTo(3580 + 23200 / 40, 6);
    const after = await getState(frank);
    expect(after.months[key]).toMatchObject({ rates: [], budgets: { dr: expect.closeTo(48000, 6) } });
    expect(after.incomes.slice(0, 3)).toEqual(source.incomes);
  });
});
