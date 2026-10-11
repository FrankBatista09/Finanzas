// Gold accounts (grams, 'XAU') through the API, the repository and the MCP: where gold is valid, where it is rejected
// with a clear message, the gold price as a setting, and that an Excel import does not touch it.
// Sample data for October 2026 (US account 13,482 USD, DR account 220,641.93 DOP, 1 USD = 58.76 DOP).

import { describe, expect, it } from 'vitest';
import type { SettingsResponse, StateResponse } from '../shared/api';
import { balances, incomeInMonth, monthCalc } from '../shared/calc';
import { seedState } from '../shared/seed';
import type { Account, Income, Transfer } from '../shared/types';
import { applyImport, loadState, replaceAll } from './db';
import type { Env } from './env';
import { handleMcp } from './mcp';
import { client, EDA, FRANK, makeEnv, TOKEN } from './test-util';

const F = FRANK.id;
const OCT = '2026-10';
/** Noon on October 7, 2026 in Santo Domingo. */
const NOW = new Date('2026-10-07T16:00:00Z');

const GOLD_REJECTED =
  '"Gold" is a gold account (grams): it cannot be used for budget parts, monthly expenses, transactions or transfers, or as the default account.';
const rejected = { status: 400, error: { code: 'validation', message: GOLD_REJECTED } };

/** The two users with the sample data; Frank, in addition, with a 100 g gold account created through the API. */
async function withGold() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, EDA.id, seedState());
  const api = client(t.env);
  const created = await api.post<Account>('/api/accounts', { id: 'gold', name: 'Gold', currency: 'XAU', opening: 100 });
  expect(created.status).toBe(201);
  expect(created.body).toEqual({ id: 'gold', name: 'Gold', currency: 'XAU', opening: 100, hidden: false, sort: 2 });
  return { ...t, api };
}

/** Everything of Frank's that a rejected write cannot have touched. */
const snapshot = async (db: D1Database) => JSON.stringify(await loadState(db, F));

describe('gold: only valid as the currency of an account', () => {
  it('is not a main or second currency, nor one for goals, contributions, expenses, transactions or rates', async () => {
    const { api, db } = await withGold();
    const before = await snapshot(db);
    const moneyOnly = 'must be DOP, USD or TRY';
    const cases: [method: 'post' | 'patch' | 'put', path: string, body: unknown, field: string][] = [
      ['patch', '/api/settings', { mainCurrency: 'XAU' }, 'mainCurrency'],
      ['patch', '/api/settings', { secondCurrency: 'XAU' }, 'secondCurrency'],
      ['post', '/api/goals', { name: 'Ring', cur: 'XAU' }, 'cur'],
      ['patch', '/api/goals/emergency', { cur: 'XAU' }, 'cur'],
      ['patch', '/api/goals/emergency', { approxCur: 'XAU' }, 'approxCur'],
      ['post', '/api/contributions', { goalId: 'emergency', date: '2026-10-07', amount: 1, cur: 'XAU' }, 'cur'],
      ['put', `/api/months/${OCT}/rates`, { from: 'XAU', to: 'USD', rate: 85, date: '2026-10-07' }, 'from'],
      ['put', `/api/months/${OCT}/rates`, { from: 'USD', to: 'XAU', rate: 0.01, date: '2026-10-07' }, 'to'],
      ['post', '/api/fixed', { monthKey: OCT, name: 'Vault', amount: 1, cur: 'XAU' }, 'cur'],
      ['post', '/api/transactions', { monthKey: OCT, date: '2026-10-07', desc: 'Coin', cat: 'Other', method: 'Cash', amount: 1, cur: 'XAU' }, 'cur'],
      ['patch', '/api/settings', { goldPrice: { amount: 85, currency: 'XAU' } }, 'goldPrice.currency'],
    ];
    for (const [method, path, body, field] of cases) {
      const r = await api[method](path, body);
      expect([r.status, r.error?.message], `${method} ${path} ${JSON.stringify(body)}`).toEqual([400, `Invalid data: ${field}: ${moneyOnly}`]);
    }
    expect(await snapshot(db)).toBe(before);
  });

  it('a gold account carries no budget, pays no expenses, neither sends nor receives, and is not the default account', async () => {
    const { api, db, env } = await withGold();
    const fixedId = seedState().months[OCT]!.fixed[0]!.id;
    const txId = seedState().months[OCT]!.tx[0]!.id;
    const transferId = seedState().months[OCT]!.transfers[0]!.id;
    const before = await snapshot(db);
    const tx = { monthKey: OCT, date: '2026-10-07', desc: 'Coin', cat: 'Other', method: 'Cash', amount: 1, cur: 'USD' };
    const transfer = { monthKey: OCT, date: '2026-10-07', via: 'Shop', amount: 100 };
    const cases: [method: 'post' | 'patch', path: string, body: unknown][] = [
      ['patch', `/api/months/${OCT}`, { budgets: { gold: 5 } }],
      // With another valid part next to it, none is saved either.
      ['patch', `/api/months/${OCT}`, { budgets: { dr: 1, gold: 0 } }],
      ['post', `/api/months/${OCT}/budget-log`, { accountId: 'gold', amount: 5 }],
      ['post', `/api/months/${OCT}/close`, { budgets: { dr: 100, gold: 5 } }],
      ['post', '/api/fixed', { monthKey: OCT, name: 'Vault', amount: 1, cur: 'USD', accountId: 'gold' }],
      ['patch', `/api/fixed/${fixedId}`, { accountId: 'gold' }],
      ['post', '/api/transactions', { ...tx, accountId: 'gold' }],
      ['patch', `/api/transactions/${txId}`, { accountId: 'gold', notes: 'x' }],
      ['post', '/api/transfers', { ...transfer, fromAccountId: 'gold', toAccountId: 'dr', rate: 5000 }],
      ['post', '/api/transfers', { ...transfer, fromAccountId: 'us', toAccountId: 'gold', rate: 0.01 }],
      // Not without a rate either: there is no rate between a currency and gold.
      ['post', '/api/transfers', { ...transfer, fromAccountId: 'us', toAccountId: 'gold' }],
      ['patch', `/api/transfers/${transferId}`, { toAccountId: 'gold' }],
      ['patch', `/api/transfers/${transferId}`, { fromAccountId: 'gold' }],
      ['patch', '/api/settings', { defaultAccountId: 'gold' }],
    ];
    for (const [method, path, body] of cases) {
      const r = await api[method](path, body);
      expect({ status: r.status, error: r.error }, `${method} ${path} ${JSON.stringify(body)}`).toEqual(rejected);
    }
    // The record dictated to Claude, likewise: by name or by id.
    const ingest = await client(env, null).post('/api/ingest/transaction', { user: F, description: 'Coin', amount: 1, account: 'gold' }, { Authorization: `Bearer ${TOKEN}` });
    expect({ status: ingest.status, error: ingest.error }).toEqual(rejected);
    expect(await snapshot(db)).toBe(before);
    // The month is still open: the rejected close did not leave it half done.
    expect((await loadState(db, F)).months[OCT]!.closed).toBe(false);
  });

  it('an account that becomes a gold one stops being the default; the last money account cannot be deleted', async () => {
    const { api, db } = await withGold();
    await api.post('/api/accounts', { id: 'spare', name: 'Spare', currency: 'USD' });
    expect((await api.patch<SettingsResponse>('/api/settings', { defaultAccountId: 'spare' })).body.defaultAccountId).toBe('spare');
    expect((await api.patch<Account>('/api/accounts/spare', { currency: 'XAU' })).body.currency).toBe('XAU');
    expect((await api.get<StateResponse>('/api/state')).body.state.defaultAccountId).toBeNull();
    // With movements, an account's currency does not change: not to gold either.
    expect((await api.patch('/api/accounts/us', { currency: 'XAU' })).status).toBe(409);

    // A user with a single money account and a gold one: the money one cannot be deleted, the gold one can.
    await replaceAll(db, F, { ...seedState(), months: {}, incomes: [], defaultAccountId: null, accounts: [seedState().accounts[1]!, { id: 'g', name: 'G', currency: 'XAU', opening: 1, hidden: false, sort: 5 }] });
    expect((await api.del('/api/accounts/dr')).status).toBe(409);
    expect((await api.del('/api/accounts/g')).status).toBe(200);
  });
});

describe('gold: opening balance, incomes in grams and price', () => {
  it('an income into a gold account is grams and never raises the budget', async () => {
    const { api, db } = await withGold();
    const income = { date: '2026-10-05', desc: 'Bought', accountId: 'gold', amount: 25.125 };
    const ok = await api.post<Income>('/api/incomes', { ...income, id: 'g1', cur: 'XAU' });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ ...income, id: 'g1', cur: 'XAU', budget: false, rate: null, recurring: false });

    const invalid = (detail: string) => ({ status: 400, error: { code: 'validation', message: `Invalid data: ${detail}` } });
    const cases: [method: 'post' | 'patch', path: string, body: unknown, detail: string][] = [
      ['post', '/api/incomes', { ...income, cur: 'XAU', budget: true }, 'budget: an income in gold (XAU, grams) cannot add to the budget'],
      ['post', '/api/incomes', { ...income, cur: 'USD' }, 'cur: must be XAU (grams) because "Gold" is a gold account'],
      ['post', '/api/incomes', { ...income, accountId: 'us', cur: 'XAU' }, 'cur: XAU (grams of gold) is only valid for an income into a gold account, and "US account" is not one'],
      // With no account it goes into the default one, which is never a gold account.
      ['post', '/api/incomes', { date: '2026-10-05', amount: 1, cur: 'XAU' }, 'cur: XAU (grams of gold) is only valid for an income into a gold account, and "DR account" is not one'],
      ['patch', '/api/incomes/g1', { budget: true }, 'budget: an income into a gold account cannot add to the budget ("Gold" holds grams of gold)'],
      ['patch', '/api/incomes/g1', { cur: 'USD' }, 'cur: must be XAU (grams) because "Gold" is a gold account'],
      ['patch', '/api/incomes/g1', { accountId: 'us' }, 'cur: XAU (grams of gold) is only valid for an income into a gold account, and "US account" is not one'],
      ['patch', '/api/incomes/seed-in-3', { accountId: 'gold' }, 'cur: must be XAU (grams) because "Gold" is a gold account'],
      ['patch', '/api/incomes/seed-in-3', { cur: 'XAU' }, 'cur: XAU (grams of gold) is only valid for an income into a gold account, and "US account" is not one'],
    ];
    const before = await snapshot(db);
    for (const [method, path, body, detail] of cases) {
      const r = await api[method](path, body);
      expect({ status: r.status, error: r.error }, `${method} ${path} ${JSON.stringify(body)}`).toEqual(invalid(detail));
    }
    expect((await api.patch('/api/incomes/g1', { accountId: 'nope' })).error?.message).toBe('Unknown account "nope".');
    expect(await snapshot(db)).toBe(before);

    // What is valid: correcting the grams, and moving the income to another account by sending the matching currency.
    expect((await api.patch<Income>('/api/incomes/g1', { amount: 30, desc: 'More' })).body).toMatchObject({ amount: 30, cur: 'XAU', accountId: 'gold' });
    expect((await api.patch<Income>('/api/incomes/g1', { accountId: 'us', cur: 'USD', budget: true })).body).toMatchObject({ accountId: 'us', cur: 'USD', budget: true });
    expect((await api.patch<Income>('/api/incomes/g1', { accountId: 'gold', cur: 'XAU', budget: false })).body).toMatchObject({ accountId: 'gold', cur: 'XAU', budget: false });

    // 100 g opening + 30: the balance is grams, and the month's income and budget do not move.
    const state = await loadState(db, F);
    expect(balances(state, OCT).accounts.find((b) => b.account.id === 'gold')).toMatchObject({ balance: 130, valued: false });
    expect(monthCalc(state, OCT).income).toBe(monthCalc(seedState(), OCT).income);
    expect(monthCalc(state, OCT).budget).toBe(70000);
  });

  it('the gold price is a per-user setting: it is typed, changed and removed', async () => {
    const { api, db, env } = await withGold();
    expect((await api.get<StateResponse>('/api/state')).body.state.goldPrice).toBeNull();

    const set = await api.patch<SettingsResponse>('/api/settings', { goldPrice: { amount: 85.5, currency: 'USD' } });
    expect(set.status).toBe(200);
    expect(set.body.goldPrice).toEqual({ amount: 85.5, currency: 'USD' });
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(state.goldPrice).toEqual({ amount: 85.5, currency: 'USD' });
    // 100 g × 85.5 USD × 58.76 = 502,398 DOP, which now add to the total money.
    const b = balances(state, OCT);
    expect(b.accounts.find((a) => a.account.id === 'gold')!.inMain).toBeCloseTo(502398, 6);
    expect(b.totalMain).toBeCloseTo(1012844.25 + 502398, 2);
    expect(b.goldExcluded).toBe(false);
    // It is Frank's: Eda still has no price.
    expect((await client(env, EDA.id).get<StateResponse>('/api/state')).body.state.goldPrice).toBeNull();

    // Another setting does not touch it, and what is not valid does not change it.
    expect((await api.patch<SettingsResponse>('/api/settings', { language: 'tr' })).body.goldPrice).toEqual({ amount: 85.5, currency: 'USD' });
    for (const goldPrice of [{ amount: 0, currency: 'USD' }, { amount: -1, currency: 'USD' }, { amount: 85 }, { currency: 'USD' }, 85, { amount: '85', currency: 'USD' }]) {
      expect((await api.patch('/api/settings', { goldPrice })).status, JSON.stringify(goldPrice)).toBe(400);
    }
    expect((await loadState(db, F)).goldPrice).toEqual({ amount: 85.5, currency: 'USD' });

    expect((await api.patch<SettingsResponse>('/api/settings', { goldPrice: { amount: 5000, currency: 'DOP' } })).body.goldPrice).toEqual({ amount: 5000, currency: 'DOP' });
    expect((await api.patch<SettingsResponse>('/api/settings', { goldPrice: null })).body.goldPrice).toBeNull();
    expect(balances(await loadState(db, F), OCT).goldExcluded).toBe(true);
  });

  it('a stored price that cannot be read counts as having none', async () => {
    const { db, sqlite } = await withGold();
    for (const value of ['{roto', '{"amount":0,"currency":"USD"}', '{"amount":85,"currency":"XAU"}', '{"amount":"85","currency":"USD"}', '85']) {
      sqlite.sqlite.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'gold_price', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(F, value);
      expect((await loadState(db, F)).goldPrice, value).toBeNull();
    }
  });

  it('importing an Excel file does not delete or change the gold accounts, their incomes or the price', async () => {
    const { api, db } = await withGold();
    await api.post('/api/incomes', { id: 'g1', date: '2026-10-05', accountId: 'gold', amount: 25.5, cur: 'XAU' });
    await api.patch('/api/settings', { goldPrice: { amount: 85, currency: 'USD' } });
    const month = { key: OCT, closed: false, budget: 50000, incomeUSD: 5800, accounts: { usd: 1000, dop: 2000 }, fixed: [], transfers: [], tx: [] };
    await applyImport(db, F, { months: [month], contribs: [], goals: [] }, NOW);

    const state = await loadState(db, F);
    expect(state.goldPrice).toEqual({ amount: 85, currency: 'USD' });
    expect(state.accounts.find((a) => a.id === 'gold')).toEqual({ id: 'gold', name: 'Gold', currency: 'XAU', opening: 100, hidden: false, sort: 2 });
    expect(state.incomes.find((i) => i.id === 'g1')).toMatchObject({ accountId: 'gold', amount: 25.5, cur: 'XAU', budget: false });
    // The workbook's two cells are money only: the money accounts end up with what it says, and the gold stays apart.
    const b = balances(state, OCT);
    expect(b.accounts.map((a) => [a.account.id, Math.round(a.balance * 100) / 100])).toEqual([
      ['us', 1000],
      ['dr', 2000],
      ['gold', 125.5],
    ]);
    // Gold is not income: the workbook's income (5,800 USD) is neither duplicated nor reduced by the grams.
    expect(incomeInMonth(state, OCT, 'USD')).toBeCloseTo(5800, 6);
  });
});

describe('gold in the MCP', () => {
  interface Called {
    text: string;
    isError: boolean;
    data: Record<string, any> | undefined;
  }
  let nextId = 1;
  async function call(env: Env, name: string, args: Record<string, unknown> = {}): Promise<Called> {
    const res = await handleMcp(
      new Request('https://finanzas.example/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: { user: F, ...args } } }),
      }),
      env,
      NOW,
    );
    const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, any> } };
    return { text: result.content[0]!.text, isError: result.isError === true, data: result.structuredContent };
  }

  it('list_accounts and month_summary give the gold in grams, the price and whether it is left out of the total', async () => {
    const { api, env } = await withGold();
    const bare = await call(env, 'list_accounts');
    expect(bare.text.split('\n')).toEqual([
      'Frank · 3 accounts · main currency DOP, second currency USD',
      'US account · USD · balance 13,482.00 USD (792,202.32 DOP)',
      'DR account · DOP · balance 220,641.93 DOP · default account',
      'Gold · XAU (gold, in grams) · balance 100.00 g (no gold price set)',
      'Total money: 1,012,844.25 DOP (17,236.97 USD)',
      'Gold is not included in the total money: no gold price is set. The person can type the value of 1 gram in the web app (Savings).',
      'Rates used (October 2026): USD to DOP: 58.76 (typed on 2026-10-06)',
      'Today is 2026-10-07.',
    ]);
    expect(bare.data!.gold).toEqual({ price: null, excludedFromTotal: true });
    expect(bare.data!.accounts[2]).toEqual({ id: 'gold', name: 'Gold', currency: 'XAU', balance: 100, inMain: null, inSecond: null, isDefault: false });

    await api.patch('/api/settings', { goldPrice: { amount: 85, currency: 'USD' } });
    const priced = await call(env, 'list_accounts');
    expect(priced.text.split('\n').slice(3, 6)).toEqual([
      'Gold · XAU (gold, in grams) · balance 100.00 g (499,460.00 DOP)',
      'Total money: 1,512,304.25 DOP (25,736.97 USD)',
      'Gold price: 1 g = 85.00 USD (typed by the person in the web app).',
    ]);
    expect(priced.data!.gold).toEqual({ price: { amount: 85, currency: 'USD' }, excludedFromTotal: false });
    expect(priced.data!.accounts[2]).toMatchObject({ balance: 100, inSecond: 8500 });

    const summary = await call(env, 'month_summary');
    expect(summary.text).toContain('Gold 100.00 g (499,460.00 DOP) · Total money: 1,512,304.25 DOP (25,736.97 USD)');
    expect(summary.text).toContain('Gold price: 1 g = 85.00 USD');
    // Gold has no rate: the rates line is still the one for the currencies.
    expect(summary.text).toContain('Month rates: USD to DOP: 58.76 (typed on 2026-10-06)\n');
    expect(summary.data!.gold).toEqual({ price: { amount: 85, currency: 'USD' }, excludedFromTotal: false });
  });

  it('add_income adds grams to a gold account; expenses, transfers and the budget reject it', async () => {
    const { db, env } = await withGold();
    const added = await call(env, 'add_income', { account: 'Gold', amount: 2.125, description: 'Coin' });
    expect(added.isError).toBe(false);
    expect(added.text).toBe('Income recorded for Frank: Coin · 2.125 g · into Gold · 2026-10-07 (October 2026). Gold balance: 102.125 g. Income in October 2026 so far: 340,808.00 DOP.');
    expect(added.data!.income).toMatchObject({ accountId: 'gold', amount: 2.125, cur: 'XAU', budget: false });
    expect(added.data!.account).toEqual({ id: 'gold', name: 'Gold', currency: 'XAU', balance: 102.125 });

    const before = await snapshot(db);
    const failures: [tool: string, args: Record<string, unknown>, message: string][] = [
      ['add_transaction', { description: 'Coin', amount: 1, account: 'Gold' }, GOLD_REJECTED],
      ['add_transfer', { from_account: 'US account', to_account: 'Gold', amount: 100 }, GOLD_REJECTED],
      ['add_transfer', { from_account: 'Gold', to_account: 'DR account', amount: 1, rate: 5000 }, GOLD_REJECTED],
      ['add_income', { account: 'Gold', amount: 1, add_to_budget: true }, 'Invalid data: budget: an income in gold (XAU, grams) cannot add to the budget'],
      ['add_income', { account: 'Gold', amount: 1, currency: 'USD' }, 'Invalid data: cur: must be XAU (grams) because "Gold" is a gold account'],
      ['add_income', { account: 'Gold', amount: 1, currency: 'XAU' }, 'Invalid data: currency: must be DOP, USD or TRY'],
    ];
    for (const [tool, args, message] of failures) {
      const r = await call(env, tool, args);
      expect([r.isError, r.text], `${tool} ${JSON.stringify(args)}`).toEqual([true, message]);
    }
    expect(await snapshot(db)).toBe(before);
    expect(((await loadState(db, F)).months[OCT]!.transfers as Transfer[]).length).toBe(1);
  });
});
