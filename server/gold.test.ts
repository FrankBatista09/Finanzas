// Cuentas de oro (gramos, 'XAU') por la API, el repositorio y el MCP: dónde vale el oro, dónde se rechaza con un
// mensaje claro, el precio del oro como ajuste y que una importación de Excel no lo toca.
// Datos de ejemplo de octubre de 2026 (US account 13,482 USD, DR account 220,641.93 DOP, 1 USD = 58.76 DOP).

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
/** Mediodía del 7 de octubre de 2026 en Santo Domingo. */
const NOW = new Date('2026-10-07T16:00:00Z');

const GOLD_REJECTED =
  '"Gold" is a gold account (grams): it cannot be used for budget parts, monthly expenses, transactions or transfers, or as the default account.';
const rejected = { status: 400, error: { code: 'validation', message: GOLD_REJECTED } };

/** Los dos usuarios con los datos de ejemplo; Frank, además, con una cuenta de oro de 100 g creada por la API. */
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

/** Lo de Frank que una escritura rechazada no puede haber tocado. */
const snapshot = async (db: D1Database) => JSON.stringify(await loadState(db, F));

describe('oro: solo vale como moneda de una cuenta', () => {
  it('no es moneda principal ni segunda, ni de metas, aportes, gastos, transacciones o tasas', async () => {
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

  it('una cuenta de oro no lleva presupuesto, ni paga gastos, ni envía ni recibe, ni es la cuenta por defecto', async () => {
    const { api, db, env } = await withGold();
    const fixedId = seedState().months[OCT]!.fixed[0]!.id;
    const txId = seedState().months[OCT]!.tx[0]!.id;
    const transferId = seedState().months[OCT]!.transfers[0]!.id;
    const before = await snapshot(db);
    const tx = { monthKey: OCT, date: '2026-10-07', desc: 'Coin', cat: 'Other', method: 'Cash', amount: 1, cur: 'USD' };
    const transfer = { monthKey: OCT, date: '2026-10-07', via: 'Shop', amount: 100 };
    const cases: [method: 'post' | 'patch', path: string, body: unknown][] = [
      ['patch', `/api/months/${OCT}`, { budgets: { gold: 5 } }],
      // Con otra parte válida al lado tampoco se guarda ninguna.
      ['patch', `/api/months/${OCT}`, { budgets: { dr: 1, gold: 0 } }],
      ['post', `/api/months/${OCT}/budget-log`, { accountId: 'gold', amount: 5 }],
      ['post', `/api/months/${OCT}/close`, { budgets: { dr: 100, gold: 5 } }],
      ['post', '/api/fixed', { monthKey: OCT, name: 'Vault', amount: 1, cur: 'USD', accountId: 'gold' }],
      ['patch', `/api/fixed/${fixedId}`, { accountId: 'gold' }],
      ['post', '/api/transactions', { ...tx, accountId: 'gold' }],
      ['patch', `/api/transactions/${txId}`, { accountId: 'gold', notes: 'x' }],
      ['post', '/api/transfers', { ...transfer, fromAccountId: 'gold', toAccountId: 'dr', rate: 5000 }],
      ['post', '/api/transfers', { ...transfer, fromAccountId: 'us', toAccountId: 'gold', rate: 0.01 }],
      // Sin tasa tampoco: no hay tasa entre una moneda y el oro.
      ['post', '/api/transfers', { ...transfer, fromAccountId: 'us', toAccountId: 'gold' }],
      ['patch', `/api/transfers/${transferId}`, { toAccountId: 'gold' }],
      ['patch', `/api/transfers/${transferId}`, { fromAccountId: 'gold' }],
      ['patch', '/api/settings', { defaultAccountId: 'gold' }],
    ];
    for (const [method, path, body] of cases) {
      const r = await api[method](path, body);
      expect({ status: r.status, error: r.error }, `${method} ${path} ${JSON.stringify(body)}`).toEqual(rejected);
    }
    // El registro dictado a Claude, igual: de palabra o por id.
    const ingest = await client(env, null).post('/api/ingest/transaction', { user: F, description: 'Coin', amount: 1, account: 'gold' }, { Authorization: `Bearer ${TOKEN}` });
    expect({ status: ingest.status, error: ingest.error }).toEqual(rejected);
    expect(await snapshot(db)).toBe(before);
    // El mes sigue abierto: el cierre rechazado no lo dejó a medias.
    expect((await loadState(db, F)).months[OCT]!.closed).toBe(false);
  });

  it('una cuenta que pasa a ser de oro deja de ser la de por defecto; la última de dinero no se borra', async () => {
    const { api, db } = await withGold();
    await api.post('/api/accounts', { id: 'spare', name: 'Spare', currency: 'USD' });
    expect((await api.patch<SettingsResponse>('/api/settings', { defaultAccountId: 'spare' })).body.defaultAccountId).toBe('spare');
    expect((await api.patch<Account>('/api/accounts/spare', { currency: 'XAU' })).body.currency).toBe('XAU');
    expect((await api.get<StateResponse>('/api/state')).body.state.defaultAccountId).toBeNull();
    // Con movimientos, la moneda de una cuenta no cambia: tampoco a oro.
    expect((await api.patch('/api/accounts/us', { currency: 'XAU' })).status).toBe(409);

    // Un usuario con una sola cuenta de dinero y una de oro: la de dinero no se puede borrar, la de oro sí.
    await replaceAll(db, F, { ...seedState(), months: {}, incomes: [], defaultAccountId: null, accounts: [seedState().accounts[1]!, { id: 'g', name: 'G', currency: 'XAU', opening: 1, hidden: false, sort: 5 }] });
    expect((await api.del('/api/accounts/dr')).status).toBe(409);
    expect((await api.del('/api/accounts/g')).status).toBe(200);
  });
});

describe('oro: saldo inicial, ingresos en gramos y precio', () => {
  it('un ingreso a una cuenta de oro son gramos y nunca sube el presupuesto', async () => {
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
      // Sin cuenta entra a la de por defecto, que nunca es de oro.
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

    // Lo que sí vale: corregir los gramos, y mover el ingreso de cuenta mandando la moneda que le toca.
    expect((await api.patch<Income>('/api/incomes/g1', { amount: 30, desc: 'More' })).body).toMatchObject({ amount: 30, cur: 'XAU', accountId: 'gold' });
    expect((await api.patch<Income>('/api/incomes/g1', { accountId: 'us', cur: 'USD', budget: true })).body).toMatchObject({ accountId: 'us', cur: 'USD', budget: true });
    expect((await api.patch<Income>('/api/incomes/g1', { accountId: 'gold', cur: 'XAU', budget: false })).body).toMatchObject({ accountId: 'gold', cur: 'XAU', budget: false });

    // 100 g iniciales + 30: el saldo son gramos, y el ingreso y el presupuesto del mes no se mueven.
    const state = await loadState(db, F);
    expect(balances(state, OCT).accounts.find((b) => b.account.id === 'gold')).toMatchObject({ balance: 130, valued: false });
    expect(monthCalc(state, OCT).income).toBe(monthCalc(seedState(), OCT).income);
    expect(monthCalc(state, OCT).budget).toBe(70000);
  });

  it('el precio del oro es un ajuste de cada usuario: se escribe, se cambia y se quita', async () => {
    const { api, db, env } = await withGold();
    expect((await api.get<StateResponse>('/api/state')).body.state.goldPrice).toBeNull();

    const set = await api.patch<SettingsResponse>('/api/settings', { goldPrice: { amount: 85.5, currency: 'USD' } });
    expect(set.status).toBe(200);
    expect(set.body.goldPrice).toEqual({ amount: 85.5, currency: 'USD' });
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(state.goldPrice).toEqual({ amount: 85.5, currency: 'USD' });
    // 100 g × 85.5 USD × 58.76 = 502,398 DOP, que ahora suman al dinero total.
    const b = balances(state, OCT);
    expect(b.accounts.find((a) => a.account.id === 'gold')!.inMain).toBeCloseTo(502398, 6);
    expect(b.totalMain).toBeCloseTo(1012844.25 + 502398, 2);
    expect(b.goldExcluded).toBe(false);
    // Es de Frank: Eda sigue sin precio.
    expect((await client(env, EDA.id).get<StateResponse>('/api/state')).body.state.goldPrice).toBeNull();

    // Otro ajuste no lo toca, y lo que no vale no lo cambia.
    expect((await api.patch<SettingsResponse>('/api/settings', { language: 'tr' })).body.goldPrice).toEqual({ amount: 85.5, currency: 'USD' });
    for (const goldPrice of [{ amount: 0, currency: 'USD' }, { amount: -1, currency: 'USD' }, { amount: 85 }, { currency: 'USD' }, 85, { amount: '85', currency: 'USD' }]) {
      expect((await api.patch('/api/settings', { goldPrice })).status, JSON.stringify(goldPrice)).toBe(400);
    }
    expect((await loadState(db, F)).goldPrice).toEqual({ amount: 85.5, currency: 'USD' });

    expect((await api.patch<SettingsResponse>('/api/settings', { goldPrice: { amount: 5000, currency: 'DOP' } })).body.goldPrice).toEqual({ amount: 5000, currency: 'DOP' });
    expect((await api.patch<SettingsResponse>('/api/settings', { goldPrice: null })).body.goldPrice).toBeNull();
    expect(balances(await loadState(db, F), OCT).goldExcluded).toBe(true);
  });

  it('un precio guardado que no se puede leer cuenta como no tenerlo', async () => {
    const { db, sqlite } = await withGold();
    for (const value of ['{roto', '{"amount":0,"currency":"USD"}', '{"amount":85,"currency":"XAU"}', '{"amount":"85","currency":"USD"}', '85']) {
      sqlite.sqlite.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'gold_price', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(F, value);
      expect((await loadState(db, F)).goldPrice, value).toBeNull();
    }
  });

  it('importar un Excel no borra ni cambia las cuentas de oro, sus ingresos ni el precio', async () => {
    const { api, db } = await withGold();
    await api.post('/api/incomes', { id: 'g1', date: '2026-10-05', accountId: 'gold', amount: 25.5, cur: 'XAU' });
    await api.patch('/api/settings', { goldPrice: { amount: 85, currency: 'USD' } });
    const month = { key: OCT, closed: false, budget: 50000, incomeUSD: 5800, accounts: { usd: 1000, dop: 2000 }, fixed: [], transfers: [], tx: [] };
    await applyImport(db, F, { months: [month], contribs: [], goals: [] }, NOW);

    const state = await loadState(db, F);
    expect(state.goldPrice).toEqual({ amount: 85, currency: 'USD' });
    expect(state.accounts.find((a) => a.id === 'gold')).toEqual({ id: 'gold', name: 'Gold', currency: 'XAU', opening: 100, hidden: false, sort: 2 });
    expect(state.incomes.find((i) => i.id === 'g1')).toMatchObject({ accountId: 'gold', amount: 25.5, cur: 'XAU', budget: false });
    // Las dos celdas del libro son solo dinero: las cuentas de dinero quedan con lo que dice, y el oro aparte.
    const b = balances(state, OCT);
    expect(b.accounts.map((a) => [a.account.id, Math.round(a.balance * 100) / 100])).toEqual([
      ['us', 1000],
      ['dr', 2000],
      ['gold', 125.5],
    ]);
    // El oro no es ingreso: el del libro (5,800 USD) no se duplica ni se descuenta por los gramos.
    expect(incomeInMonth(state, OCT, 'USD')).toBeCloseTo(5800, 6);
  });
});

describe('oro en el MCP', () => {
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

  it('list_accounts y month_summary dan el oro en gramos, el precio y si queda fuera del total', async () => {
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
    // El oro no tiene tasa: la línea de tasas sigue siendo la de las monedas.
    expect(summary.text).toContain('Month rates: USD to DOP: 58.76 (typed on 2026-10-06)\n');
    expect(summary.data!.gold).toEqual({ price: { amount: 85, currency: 'USD' }, excludedFromTotal: false });
  });

  it('add_income suma gramos a una cuenta de oro; los gastos, los envíos y el presupuesto la rechazan', async () => {
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
