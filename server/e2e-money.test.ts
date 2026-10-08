// De punta a punta, el modelo de dinero: un mes guionizado con cifras redondas, registrado por la API y por las
// herramientas del MCP, y comprobado contra cuentas hechas a mano (no contra lo que devuelva shared/calc.ts con
// otros datos). Todas las piezas son las reales (API + D1 de server/d1-node.ts + MCP + Excel).
//
// El guion (moneda principal TRY, segunda USD; tasas escritas del mes: 1 USD = 60 DOP y 1 USD = 40 TRY, así que
// TRY↔DOP sale cruzando por USD: 1 TRY = 1.5 DOP):
//
//   Cuentas        us  USD  inicial  1,000      dr  DOP  inicial 10,000      tr  TRY  inicial 20,000 (por defecto)
//                  cash DOP inicial 500, oculta: se calcula pero no suma al dinero total
//   Presupuesto    dr 30,000 DOP → luego 36,000 DOP (= 24,000 TRY)   +   tr 8,000 TRY            = 32,000 TRY
//   Ingresos       3,000 USD → us      12,000 TRY → tr      100 USD → dr (entran 6,000 DOP)      = 136,000 TRY
//   Transacciones  400 TRY de tr · 3,000 DOP de dr · 50 USD de dr (salen 3,000 DOP) · 600 DOP de tr (salen 400 TRY)
//                  en TRY: 400 + 2,000 + 2,000 + 400                                             =   4,800 TRY
//   Gastos fijos   Rent 6,000 TRY de tr (se marca pagado) · Internet 1,500 DOP de dr (pendiente = 1,000 TRY)
//                  Claude 20 USD de us (pagado = 800 TRY)                           pagados      =   6,800 TRY
//   Envíos         us → dr 500 USD a 59 (entran 29,500 DOP) · tr → us 4,000 TRY a la tasa del mes (entran 100 USD)
//                  dr → tr 3,000 DOP a la tasa del mes (entran 2,000 TRY)
//
//   Usado 11,600 TRY (290 USD) · disponible 20,400 · tras pendientes 19,400
//   Saldos   us = 1,000 + 3,000 − 20 − 500 + 100            =  3,580 USD
//            dr = 10,000 + 6,000 − 3,000 − 3,000 + 29,500 − 3,000 = 36,500 DOP
//            tr = 20,000 + 12,000 − 400 − 400 − 6,000 − 4,000 + 2,000 = 23,200 TRY
//   Dinero total = 3,580 × 40 + 36,500 / 1.5 + 23,200 = 190,733.33 TRY

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

/** Una llamada a una herramienta del MCP, como la haría Claude. `now` fija el "hoy" del servidor. */
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

/** Lo que no son movimientos: primera visita, cuentas, monedas, tasas del mes, presupuesto y los gastos fijos. Devuelve el mes. */
async function setUp(api: Client): Promise<MonthKey> {
  // Primera visita: las dos cuentas de partida y el mes actual.
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
  await ok(api.put(`/api/months/${key}/rates`, { from: 'USD', to: 'DOP', rate: 60 }));
  await ok(api.put(`/api/months/${key}/rates`, { from: 'USD', to: 'TRY', rate: 40 }));
  await ok(api.patch(`/api/months/${key}`, { budgets: { dr: 30000, tr: 8000 } }));
  // Con dos tasas escritas, la tercera sale cruzando por USD.
  expect(rateFor(await getState(api), key, 'TRY', 'DOP')).toMatchObject({ rate: expect.closeTo(1.5, 10), source: 'cross', monthKey: key });

  await ok(api.post<FixedExpense>('/api/fixed', { id: 'rent', monthKey: key, name: 'Rent', day: '1', amount: 6000, cur: 'TRY' }), 201);
  await ok(api.post<FixedExpense>('/api/fixed', { id: 'net', monthKey: key, name: 'Internet', amount: 1500, cur: 'DOP', accountId: 'dr' }), 201);
  await ok(api.post<FixedExpense>('/api/fixed', { id: 'claude', monthKey: key, name: 'Claude', amount: 20, cur: 'USD', accountId: 'us', paid: true }), 201);
  return key;
}

/** Los movimientos del guion, por la API. */
async function movementsByApi(api: Client, key: MonthKey): Promise<void> {
  const d = (day: string) => `${key}-${day}`;
  await ok(api.post('/api/incomes', { date: d('01'), desc: 'Salary', accountId: 'us', amount: 3000, cur: 'USD' }), 201);
  // Sin cuenta: entra a la de por defecto (tr).
  await ok(api.post('/api/incomes', { date: d('02'), desc: 'Maaş', amount: 12000, cur: 'TRY' }), 201);
  await ok(api.post('/api/incomes', { date: d('03'), desc: 'Gift', accountId: 'dr', amount: 100, cur: 'USD' }), 201);

  const tx = { monthKey: key, cat: 'Food', method: 'Card' };
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

/** Los mismos movimientos, dictados a Claude: cuentas por su nombre y lo que no se dice, por defecto. */
async function movementsByMcp(env: Env, api: Client, now: Date, user: string, key: MonthKey): Promise<void> {
  const d = (day: string) => `${key}-${day}`;
  const say = (name: string, args: Record<string, unknown>) => done(tool(env, now, user, name, args));
  await say('add_income', { amount: 3000, currency: 'USD', account: 'US account', date: d('01'), description: 'Salary' });
  // Sin cuenta ni moneda: la cuenta por defecto (tr) y su moneda.
  await say('add_income', { amount: 12000, date: d('02'), description: 'Maaş' });
  await say('add_income', { amount: 100, currency: 'USD', account: 'dr account', date: d('03'), description: 'Gift' });

  await say('add_transaction', { description: 'Kahve', amount: 400, date: d('04') });
  await say('add_transaction', { description: 'Groceries', amount: 3000, account: 'DR', date: d('05') });
  await say('add_transaction', { description: 'Hosting', amount: 50, currency: 'USD', account: 'dr', date: d('06') });
  await say('add_transaction', { description: 'Souvenir', amount: 600, currency: 'DOP', account: 'TR account', date: d('07') });

  await say('add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 500, rate: 59, date: d('08') });
  const toUs = await say('add_transfer', { from_account: 'TR account', to_account: 'US account', amount: 4000, date: d('09') });
  expect(toUs.text).toContain('typed for this month');
  const toTr = await say('add_transfer', { from_account: 'DR account', to_account: 'TR account', amount: 3000, date: d('10') });
  expect(toTr.text).toContain('crossed through USD');

  await say('mark_fixed_paid', { name: 'Rent', month: key });
  // El presupuesto no se cambia desde Claude: por la API, como en la web.
  await ok(api.patch(`/api/months/${key}`, { budgets: { dr: 36000 } }));
}

const balanceOf = (state: AppState, asOf: MonthKey) => Object.fromEntries(balances(state, asOf).accounts.map((a) => [a.account.id, a.balance]));

/** Las cifras del guion, hechas a mano (cabecera del archivo). */
function expectScriptedMonth(state: AppState, key: MonthKey, asOf: MonthKey = key): void {
  expect([state.mainCurrency, state.secondCurrency, state.defaultAccountId]).toEqual(['TRY', 'USD', 'tr']);

  // Tasas: dos escritas a mano. La tercera salía cruzando por USD; el envío dr → tr se guardó con esa misma tasa,
  // y desde entonces el par tiene la de sus propios envíos (el mismo número, otro origen).
  expect(rateFor(state, key, 'USD', 'DOP')).toEqual({ rate: 60, source: 'month', monthKey: key });
  expect(rateFor(state, key, 'TRY', 'USD')).toEqual({ rate: 1 / 40, source: 'month', monthKey: key });
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

  // Los envíos sin tasa guardaron la del mes para su par.
  const month = state.months[key]!;
  expect(month.transfers.map((t) => [t.fromAccountId, t.toAccountId, t.amount])).toEqual([['us', 'dr', 500], ['tr', 'us', 4000], ['dr', 'tr', 3000]]);
  expect(month.transfers.map((t) => t.rate)).toEqual([59, expect.closeTo(0.025, 12), expect.closeTo(1 / 1.5, 12)]);
  // Cada fila guarda su monto y su moneda originales, y la cuenta de la que sale.
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
  // La cuenta oculta no suma.
  expect(b.totalMain).toBeCloseTo(143200 + 36500 / 1.5 + 23200, 6);
  expect(b.totalSecond).toBeCloseTo(3580 + 36500 / 60 + 580, 6);
}

describe('de punta a punta: el mes guionizado', () => {
  it('por la API: saldos, presupuesto, usado e ingreso son los calculados a mano; al cerrar, el mes siguiente los hereda', async () => {
    const { frank } = fresh();
    const key = await setUp(frank);
    await movementsByApi(frank, key);

    const state = await getState(frank);
    expectScriptedMonth(state, key);

    // El resumen de meses habla en la moneda principal.
    expect(await ok(frank.get<MonthSummary[]>('/api/months'))).toEqual([
      { key, closed: false, closedAt: null, main: 'TRY', budget: expect.closeTo(32000, 6), used: expect.closeTo(11600, 6), txCount: 4 },
    ]);

    // Una meta en TRY con un aporte en USD: se convierte a la moneda de la meta y no mueve ningún saldo.
    const goal = await ok(frank.post<Goal>('/api/goals', { name: 'Araba', monthly: 5000, start: key, end: nextKey(key) }), 201);
    expect(goal.cur).toBe('TRY');
    await ok(frank.post('/api/contributions', { goalId: goal.id, date: `${key}-11`, amount: 50, cur: 'USD' }), 201);
    const withGoal = await getState(frank);
    expectScriptedMonth(withGoal, key);
    const progress = goalsProgress(withGoal).find((g) => g.id === goal.id)!;
    expect([progress.cur, progress.saved, progress.target?.targetAmount]).toEqual(['TRY', expect.closeTo(2000, 6), 10000]);
    expect(incomeRows(withGoal)[0]).toMatchObject({ income: expect.closeTo(136000, 6), saved: expect.closeTo(2000, 6) });

    // Cerrar: el mes queda de solo lectura y el siguiente nace con los fijos sin pagar y el mismo presupuesto.
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
      frank.post('/api/transactions', { monthKey: key, date: `${key}-12`, desc: 'x', cat: 'Food', method: 'Card', amount: 1, cur: 'TRY' }),
      frank.patch('/api/fixed/net', { paid: true }),
      frank.patch(`/api/months/${key}`, { budgets: { tr: 1 } }),
      frank.put(`/api/months/${key}/rates`, { from: 'USD', to: 'DOP', rate: 61 }),
      frank.del(`/api/months/${key}/rates/USD/DOP`),
      frank.post('/api/transfers', { monthKey: key, date: `${key}-12`, via: 'x', fromAccountId: 'us', toAccountId: 'dr', amount: 1 }),
    ]) {
      const r = await write;
      expect([r.status, r.error?.code]).toEqual([409, 'month_closed']);
    }

    // Nada se movió: los saldos al final del mes siguiente son los mismos, con las tasas del mes anterior.
    const after = await getState(frank);
    expectScriptedMonth(after, key, next);
    expect(rateFor(after, next, 'USD', 'TRY')).toEqual({ rate: 40, source: 'previous', monthKey: key });
    expect(monthCalc(after, next)).toMatchObject({ budget: expect.closeTo(32000, 6), used: 0, pending: expect.closeTo(7800, 6), income: 0 });
  });

  it('por las herramientas del MCP: las mismas cifras, y lo que Claude responde es lo que calcula la app', async () => {
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
    expect(summary.text).toContain('USD to TRY: 40.00 (typed for this month)');

    // Lo que no puede ser: una cuenta que no existe, la misma cuenta dos veces, un mes cerrado.
    const unknown = await tool(env, now, EDA.id, 'add_transaction', { description: 'x', amount: 1, account: 'Wise' });
    expect([unknown.isError, unknown.text]).toEqual([true, expect.stringContaining('unknown account "Wise"')]);
    const same = await tool(env, now, EDA.id, 'add_transfer', { from_account: 'tr', to_account: 'TR account', amount: 1 });
    expect([same.isError, same.text]).toEqual([true, expect.stringContaining('must be a different account')]);
    await ok(eda.post(`/api/months/${key}/close`));
    const late = await tool(env, now, EDA.id, 'add_transaction', { description: 'x', amount: 1, date: `${key}-14` });
    expect(late.isError).toBe(true);
    expectScriptedMonth(await getState(eda), key);
  });

  it('dos usuarios con el mismo guion no se mezclan, y borrar un mes devuelve los saldos a como estaban', async () => {
    const { env, db, frank, eda } = fresh();
    const key = await setUp(frank);
    expect(await setUp(eda)).toBe(key);
    await movementsByApi(frank, key);
    await movementsByMcp(env, eda, new Date(`${key}-15T16:00:00Z`), EDA.id, key);
    expectScriptedMonth(await getState(frank), key);
    expectScriptedMonth(await getState(eda), key);
    const edaBefore = await loadState(db, EDA.id);

    // Frank cierra y sigue en el mes siguiente: un gasto, un envío y un fijo pagado mueven sus saldos…
    const next = nextKey(key);
    const closed = await ok(frank.post<CloseResponse>(`/api/months/${key}/close`));
    await ok(frank.post('/api/transactions', { monthKey: next, date: `${next}-02`, desc: 'Bilet', cat: 'Travel', method: 'Card', amount: 1000, cur: 'TRY' }), 201);
    await ok(frank.post('/api/transfers', { monthKey: next, date: `${next}-03`, via: 'Wise', fromAccountId: 'us', toAccountId: 'tr', amount: 100, rate: 41 }), 201);
    await ok(frank.patch(`/api/fixed/${closed.next.fixed.find((f) => f.name === 'Claude')!.id}`, { paid: true }));
    const moved = await getState(frank);
    expect(balanceOf(moved, next)).toEqual({ us: expect.closeTo(3460, 6), dr: expect.closeTo(36500, 6), tr: expect.closeTo(26300, 6), cash: 500 });
    // …y el saldo al final del mes cerrado no cambia por lo que pasa después.
    expectScriptedMonth(moved, key);

    // Borrar el mes siguiente se lleva sus movimientos: los saldos vuelven.
    expect(await ok(frank.del(`/api/months/${next}`))).toEqual({ ok: true });
    const back = await getState(frank);
    expect(sortedKeys(back)).toEqual([key]);
    expectScriptedMonth(back, key);
    expect((await frank.get(`/api/months/${next}`)).status).toBe(404);
    expect((await frank.del(`/api/months/${next}`)).status).toBe(404);

    // Borrar también el mes cerrado: quedan los saldos iniciales más los ingresos, que no son de ningún mes.
    // Al volver a entrar se crea el mes actual, vacío y sin tasas: la conversión cae al valor de respaldo.
    await ok(frank.del(`/api/months/${key}`));
    const empty = await getState(frank);
    const [only] = sortedKeys(empty);
    expect(empty.months[only!]).toMatchObject({ closed: false, budgets: {}, rates: [], fixed: [], transfers: [], tx: [] });
    expect(empty.incomes).toHaveLength(3);
    expect(rateFor(empty, only!, 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'default', monthKey: null });
    expect(balanceOf(empty, only!)).toEqual({ us: 4000, dr: expect.closeTo(10000 + 100 * 58.76, 6), tr: 32000, cash: 500 });

    // Nada de esto tocó a Eda.
    expect(await loadState(db, EDA.id)).toEqual(edaBefore);
    expectScriptedMonth(await getState(eda), key);
  });

  it('errores del modelo: cuenta desconocida, envío a la misma cuenta, monedas iguales, cuenta en uso', async () => {
    const { frank } = fresh();
    const key = await setUp(frank);
    await movementsByApi(frank, key);
    const tx = { monthKey: key, date: `${key}-12`, desc: 'x', cat: 'Food', method: 'Card', amount: 1, cur: 'TRY' };
    const cases: [Promise<{ status: number; error: { code: string } | undefined }>, number, string][] = [
      [frank.post('/api/transactions', { ...tx, accountId: 'wise' }), 400, 'validation'],
      [frank.post('/api/incomes', { date: `${key}-12`, amount: 1, cur: 'USD', accountId: 'wise' }), 400, 'validation'],
      [frank.patch(`/api/months/${key}`, { budgets: { wise: 10 } }), 400, 'validation'],
      [frank.post('/api/transfers', { monthKey: key, date: `${key}-12`, via: 'x', fromAccountId: 'tr', toAccountId: 'tr', amount: 1 }), 400, 'validation'],
      [frank.patch('/api/settings', { secondCurrency: 'TRY' }), 400, 'validation'],
      [frank.patch('/api/settings', { mainCurrency: 'USD', secondCurrency: 'USD' }), 400, 'validation'],
      [frank.patch('/api/settings', { defaultAccountId: 'wise' }), 400, 'validation'],
      [frank.put(`/api/months/${key}/rates`, { from: 'USD', to: 'USD', rate: 1 }), 400, 'validation'],
      [frank.del('/api/accounts/tr'), 409, 'conflict'],
      [frank.patch('/api/accounts/tr', { currency: 'USD' }), 409, 'conflict'],
    ];
    for (const [reply, status, code] of cases) {
      const r = await reply;
      expect([r.status, r.error?.code]).toEqual([status, code]);
    }
    // Ninguno dejó nada a medias.
    expectScriptedMonth(await getState(frank), key);
    // Intercambiar las dos monedas sí se puede, mandándolas juntas; y una cuenta sin uso se borra.
    await ok(frank.patch('/api/settings', { mainCurrency: 'USD', secondCurrency: 'TRY' }));
    expect(monthCalc(await getState(frank), key)).toMatchObject({ main: 'USD', used: expect.closeTo(290, 6), usedSecond: expect.closeTo(11600, 6) });
    await ok(frank.del('/api/accounts/cash'));
  });
});

describe('de punta a punta: el Excel como resumen del modelo de cuentas', () => {
  async function download(api: Client): Promise<{ bytes: Uint8Array; book: ImportPayload }> {
    const res = await api.raw('/api/export.xlsx', { method: 'GET' });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, book: parseFinanzasXlsx(bytes) };
  }

  it('exportar el mes guionizado e importarlo en un usuario vacío da los mismos totales en los términos del libro', async () => {
    const { frank, ana } = fresh();
    const key = await setUp(frank);
    await movementsByApi(frank, key);
    const goal = await ok(frank.post<Goal>('/api/goals', { name: 'Araba', monthly: 5000, start: key, end: nextKey(key) }), 201);
    await ok(frank.post('/api/contributions', { goalId: goal.id, date: `${key}-11`, amount: 3000, cur: 'TRY' }), 201);
    const source = await getState(frank);
    const { bytes, book } = await download(frank);

    // El libro, en sus términos (DOP y USD, dos cuentas), con las tasas del mes de la app.
    expect(book.months).toHaveLength(1);
    const m = book.months[0]!;
    expect(m.budget).toBeCloseTo(36000 + 8000 * 1.5, 6); // 48,000 DOP
    expect(m.incomeUSD).toBeCloseTo(3000 + 12000 / 40 + 100, 6); // 3,400 USD
    expect(m.accounts.dop).toBeCloseTo(36500, 6); // la cuenta oculta no cuenta
    expect(m.accounts.usd).toBeCloseTo(3580 + 23200 / 40, 6); // lo que no es DOP, en USD
    // Lo que estaba en TRY llega en DOP; solo viajan los envíos entre USD y DOP.
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

    // Ana nunca entró: importar le crea sus cuentas de partida y vuelca el libro en ellas.
    const res = await ana.raw('/api/import', { method: 'POST', headers: { 'Content-Type': XLSX_MIME }, body: bytes });
    expect(res.status).toBe(200);
    const imported = await getState(ana);
    expect(imported.accounts.map((a) => [a.id, a.currency])).toEqual([['us', 'USD'], ['dr', 'DOP']]);
    expect(imported.months[key]).toMatchObject({ budgets: { dr: expect.closeTo(48000, 6) }, rates: [] });

    // El libro de Ana dice lo mismo que el de Frank.
    const again = (await download(ana)).book;
    const approx = (book: ImportPayload) => JSON.parse(JSON.stringify(book), (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)) as ImportPayload;
    expect(approx(again)).toEqual(approx(book));

    // Y en la app, los totales que el libro sabe llevar coinciden: saldos del último mes, ingreso y presupuesto.
    const b = balanceOf(imported, key);
    expect(b.us).toBeCloseTo(3580 + 23200 / 40, 6);
    expect(b.dr).toBeCloseTo(36500, 6);
    const dop = { ...imported, mainCurrency: 'DOP' as const, secondCurrency: 'USD' as const };
    const sourceDop = { ...source, mainCurrency: 'DOP' as const, secondCurrency: 'USD' as const };
    expect(monthCalc(dop, key).budget).toBeCloseTo(monthCalc(sourceDop, key).budget, 6);
    // El libro saca su tasa de los envíos del mes (59), no de la escrita (60): lo convertido difiere justo en eso.
    expect(rateFor(imported, key, 'USD', 'DOP')).toEqual({ rate: 59, source: 'transfers', monthKey: key });
    expect(monthCalc(dop, key).income).toBeCloseTo(3400 * 59, 6);
    expect(monthCalc(sourceDop, key).income).toBeCloseTo(3400 * 60, 6);
    // Gastado, en DOP: 600 + 3,000 + 600 + 9,000 en DOP y 70 USD a la tasa de cada uno.
    expect(monthCalc(dop, key).used).toBeCloseTo(13200 + 70 * 59, 6);
    expect(monthCalc(sourceDop, key).used).toBeCloseTo(13200 + 70 * 60, 6);

    // Volver a cargar el propio libro no duplica el ingreso del mes ni infla el dinero total, aunque Frank tiene
    // tres cuentas visibles. Sí pierde lo que el libro no lleva: las tasas escritas y el reparto del presupuesto.
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
