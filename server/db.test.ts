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

// Casi todas las pruebas actúan como Frank; Eda está al lado con los mismos datos (mismos ids, mismos meses,
// mismas cuentas).
const F = FRANK.id;
const E = EDA.id;

const core = (f: FixedExpense) => ({ name: f.name, day: f.day, amount: f.amount, cur: f.cur, accountId: f.accountId, sort: f.sort });

const EMPTY: AppState = {
  months: {},
  accounts: [],
  incomes: [],
  goals: [],
  contribs: [],
  mainCurrency: DEFAULT_MAIN_CURRENCY,
  secondCurrency: DEFAULT_SECOND_CURRENCY,
  defaultAccountId: null,
  defaultRate: DEFAULT_RATE,
  theme: null,
  language: 'en',
};

const emptyMonth = (key: string): Month => ({ key, closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] });

const DEFAULT_SETTINGS = { theme: null, language: 'en', mainCurrency: 'DOP', secondCurrency: 'USD', defaultAccountId: null };

const invalid = { status: 400, code: 'validation' };
const notFound = { status: 404, code: 'not_found' };
const conflict = { status: 409, code: 'conflict' };
const closedMonth = { status: 409, code: 'month_closed' };
const unknownAccount = (id: string) => ({ ...invalid, message: `Unknown account "${id}".` });

/** Saldo de una cuenta al final de `asOf`, calculado como en la web: shared/calc sobre el estado cargado. */
async function balance(db: D1Database, userId: string, accountId: string, asOf = '2026-10'): Promise<number> {
  return balances(await loadState(db, userId), asOf).accounts.find((a) => a.account.id === accountId)!.balance;
}

let bystander: { db: D1Database; before: AppState } | null = null;

/** Los dos usuarios con los datos de ejemplo. Al acabar la prueba se comprueba que lo de Eda sigue intacto. */
async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, E, seedState());
  bystander = { db: t.db, before: await loadState(t.db, E) };
  return t;
}

/** Los dos usuarios recién llegados: sus cuentas y metas iniciales y octubre de 2026, vacío. */
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
  // Nada de lo que hace una prueba como Frank puede tocar lo de Eda.
  if (watched) expect(await loadState(watched.db, E)).toEqual(watched.before);
});

/** Un D1 que ejecuta `before(n)` justo antes de la n-ésima escritura o lectura: simula otra petición que se cuela en medio. */
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
  it('base recién migrada: un usuario que nunca entró sale vacío, con las monedas, la tasa, el idioma y la paleta por defecto', async () => {
    const { db, sqlite } = makeEnv();
    expect(await loadState(db, F)).toEqual(EMPTY);
    // Leer no crea nada.
    for (const table of ['months', 'accounts', 'goals', 'settings']) expect(count(sqlite, table)).toBe(0);
  });

  it('replaceAll(seedState()) y loadState devuelven exactamente los datos de ejemplo (salvo createdAt)', async () => {
    const { db } = await seeded();
    const state = await loadState(db, F);
    expect(withoutTimestamps(state)).toEqual(seedState());
    for (const m of Object.values(state.months)) {
      for (const t of m.tx) expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('los montos no pierden precisión al pasar por la base: mismos cálculos y mismos saldos que con los datos de ejemplo', async () => {
    const { db } = await seeded();
    const state = await loadState(db, F);
    const seed = seedState();
    // Mismos números → mismos cálculos que el frontend haría con los datos de ejemplo.
    expect(monthCalc(state, '2026-10')).toEqual(monthCalc(seed, '2026-10'));
    expect(balances(state, '2026-10')).toEqual(balances(seed, '2026-10'));
    expect(balances(state, '2026-08')).toEqual(balances(seed, '2026-08'));
    expect(state.months['2026-10']!.fixed[0]!.amount).toBe(1337.15);
  });

  it('replaceAll sustituye todo lo del usuario: cuentas, meses, ingresos, metas, aportes y todos sus ajustes', async () => {
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
    other.contribs = [{ id: 'c1', goalId: 'g1', date: '2026-10-01', amount: 10, cur: 'TRY' }];
    other.incomes = [{ id: 'i1', date: '2027-03-15', desc: 'Maaş', accountId: 'tr', amount: 90000, cur: 'TRY', budget: true }];
    setBudgets(other.months['2026-10']!, { dr: 50000, tr: 12000.5 });
    other.months['2026-10']!.budgetLog.push({ id: 'cut', date: '2026-10-09', accountId: 'tr', amount: -2000.5, kind: 'adjust', note: 'Menos' });
    other.months['2026-10']!.budgets = { dr: 50000, tr: 10000 };
    other.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-01' },
      { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 59.5, date: '2026-10-06' },
    ];
    other.months['2026-10']!.transfers.push({
      id: 't-try', monthKey: '2026-10', date: '2026-10-08', via: 'Wise', fromAccountId: 'us', toAccountId: 'tr', amount: 100, rate: 40.2, budget: true,
    });
    delete other.months['2026-08'];
    await replaceAll(db, F, other);
    expect(withoutTimestamps(await loadState(db, F))).toEqual(other);
    expect(count(sqlite, 'months', F)).toBe(2);
    expect(count(sqlite, 'months', E)).toBe(3);
    expect(count(sqlite, 'accounts', F)).toBe(3);
    expect(count(sqlite, 'accounts', E)).toBe(2);
  });

  it('una parte del presupuesto en 0 no se guarda (es no tenerla) y una tasa que la app ignoraría, tampoco', async () => {
    const { db, sqlite } = makeEnv();
    const state = seedState();
    // Lo que se guarda es el registro: `budgets` es su suma y lo que traiga el estado no cuenta.
    state.months['2026-10']!.budgets = { dr: 1, us: 5 };
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 0, date: '2026-10-01' },
      // El mismo par y la misma fecha al revés: vale la última, que es la que usa rateFor.
      { from: 'DOP', to: 'USD', rate: 0.02, date: '2026-10-01' },
      // Otra fecha del mismo par sí es otra tasa.
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

  it('getMonth da el mes completo o null', async () => {
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

  it('listMonths resume cada mes en la moneda principal, con las cifras de shared/calc', async () => {
    const { db } = await seeded();
    const seed = seedState();
    const list = await listMonths(db, F);
    expect(list.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    for (const s of list) {
      const c = monthCalc(seed, s.key);
      expect(s).toEqual({ key: s.key, closed: seed.months[s.key]!.closed, closedAt: null, main: 'DOP', budget: 70000, used: c.used, txCount: c.txCount });
    }

    // Con otra moneda principal, el mismo mes sale en ella: 70,000 DOP a 58.76 son 1,191.29 USD.
    await updateSettings(db, F, { mainCurrency: 'USD', secondCurrency: 'DOP' });
    const october = (await listMonths(db, F))[2]!;
    expect(october.main).toBe('USD');
    expect(october.budget).toBeCloseTo(70000 / 58.76, 8);
    expect(october.used).toBeCloseTo(monthCalc(seed, '2026-10').used / 58.76, 8);
  });
});

describe('dos usuarios: cada uno con sus finanzas', () => {
  it('pueden tener los mismos ids, las mismas cuentas y los mismos meses sin chocar, y cada uno lee solo lo suyo', async () => {
    const { db, sqlite } = await seeded();
    // Los datos de ejemplo tienen ids fijos: están dos veces en la base, una por usuario.
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
    // El saldo de Eda en su cuenta 'dr' no se entera de nada de esto (lo comprueba además afterEach).
    expect(await balance(db, E, 'dr')).toBeCloseTo(220641.93, 6);
  });

  it('un usuario sin datos no ve los de otro', async () => {
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

  it('un id que existe pero es de otro usuario se comporta como uno que no existe', async () => {
    const { db } = await seeded();
    // Filas que solo tiene Frank.
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
    // Tampoco puede colgar algo suyo de una meta ajena: ni al crear ni al mover un aporte.
    await expect(createContribution(db, E, { goalId: 'goal-frank', date: '2026-10-07', amount: 5, cur: 'USD' })).rejects.toMatchObject({
      ...notFound,
      message: 'Goal not found.',
    });
    await expect(patchContribution(db, E, 'seed-ct-1', { goalId: 'goal-frank' })).rejects.toMatchObject(notFound);

    // Ni pagar, cobrar, enviar o presupuestar con una cuenta ajena: para ella esa cuenta no existe.
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

  it('el mismo id sirve para una fila nueva de cada usuario; repetido dentro del mismo, 409', async () => {
    const { db } = await seeded();
    const tx = { id: 'tx-igual', monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' as const };
    await createTransaction(db, F, tx);
    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    await createIncome(db, F, { id: 'in-igual', date: '2026-10-07', amount: 1, cur: 'USD' });
    bystander = null; // esta prueba sí escribe como Eda
    expect((await createTransaction(db, E, { ...tx, amount: 2 })).amount).toBe(2);
    // Misma cuenta (mismo id y mismo nombre) y mismo ingreso, pero de otra persona.
    expect((await createAccount(db, E, { id: 'pp', name: 'PayPal', currency: 'TRY' })).currency).toBe('TRY');
    expect((await createIncome(db, E, { id: 'in-igual', date: '2026-10-07', amount: 2, cur: 'USD' })).amount).toBe(2);
    await expect(createTransaction(db, F, tx)).rejects.toMatchObject(conflict);
    await expect(createAccount(db, F, { id: 'pp', name: 'Otra', currency: 'USD' })).rejects.toMatchObject(conflict);
    await expect(createIncome(db, F, { id: 'in-igual', date: '2026-10-07', amount: 1, cur: 'USD' })).rejects.toMatchObject(conflict);
    expect((await getMonth(db, F, '2026-10'))!.tx.find((t) => t.id === 'tx-igual')!.amount).toBe(1);
    expect((await listAccounts(db, F)).find((a) => a.id === 'pp')!.currency).toBe('USD');
  });

  it('ensureMonth copia del mes anterior del propio usuario, no del de otro', async () => {
    const { db, sqlite } = await seeded();
    await createFixed(db, F, { monthKey: '2026-10', name: 'Solo Frank', amount: 9, cur: 'DOP' });
    await patchMonth(db, F, '2026-10', { budgets: { dr: 12345, us: 10 } });

    bystander = null;
    const eda = await ensureMonth(db, E, '2026-11');
    expect(eda.created).toBe(true);
    expect(eda.month.budgets).toEqual({ dr: 70000 });
    expect(eda.month.fixed).toHaveLength(11);
    expect(eda.month.fixed.some((f) => f.name === 'Solo Frank')).toBe(false);
    // El mismo mes sigue sin existir para Frank, y al crearlo sale de los suyos.
    expect(await getMonth(db, F, '2026-11')).toBeNull();
    const frank = await ensureMonth(db, F, '2026-11');
    expect(frank.created).toBe(true);
    expect(frank.month.budgets).toEqual({ dr: 12345, us: 10 });
    expect(frank.month.fixed).toHaveLength(12);
    expect(count(sqlite, 'months', E)).toBe(4);
    expect(count(sqlite, 'months', F)).toBe(4);
  });

  it('closeMonth cierra el mes de un usuario y crea su siguiente; el mismo mes del otro sigue abierto', async () => {
    const { db } = await seeded();
    const { closed, next } = await closeMonth(db, F, '2026-10');
    expect(closed.closed).toBe(true);
    expect(next.key).toBe('2026-11');
    expect((await getMonth(db, E, '2026-10'))!.closed).toBe(false);
    expect(await getMonth(db, E, '2026-11')).toBeNull();
    // Y al revés: reabrir el de Frank no depende de nada de Eda.
    expect((await reopenMonth(db, F, '2026-10')).closed).toBe(false);
    await expect(reopenMonth(db, E, '2026-11')).rejects.toMatchObject(notFound);
  });

  it('un mes cerrado de un usuario no bloquea el mismo mes abierto del otro', async () => {
    const { db } = await seeded();
    await reopenMonth(db, F, '2026-08');
    expect((await patchFixed(db, F, 'seed-fx-2026-08-1', { paid: false })).paid).toBe(false);
    expect((await patchMonth(db, F, '2026-08', { budgets: { us: 5 } })).budgets).toEqual({ dr: 70000, us: 5 });
    // Para Eda agosto sigue cerrado.
    await expect(patchFixed(db, E, 'seed-fx-2026-08-1', { paid: false })).rejects.toMatchObject(closedMonth);
    await expect(patchMonth(db, E, '2026-08', { budgets: { us: 5 } })).rejects.toMatchObject(closedMonth);
  });

  it('borrar un mes de un usuario no borra el mismo mes del otro', async () => {
    const { db, sqlite } = await seeded();
    await deleteMonth(db, F, '2026-10');
    expect(await getMonth(db, F, '2026-10')).toBeNull();
    expect((await getMonth(db, E, '2026-10'))!.tx).toHaveLength(7);
    expect(count(sqlite, 'transactions', E)).toBe(27);
    await expect(deleteMonth(db, F, '2026-10')).rejects.toMatchObject(notFound);
  });

  it('replaceAll y resetAll de un usuario no tocan al otro', async () => {
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

  it('applyImport solo cambia lo del usuario que importa', async () => {
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
    // Eda conserva su octubre, sus 8 aportes, sus saldos y el plan de su meta (lo comprueba afterEach).
  });

  it('los ajustes son de cada uno', async () => {
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

describe('primera visita: initUser / openState', () => {
  it('openState crea las cuentas y las metas iniciales, la tasa por defecto, la marca y el mes indicado', async () => {
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
    // Solo se preparó a Frank.
    expect(await loadState(db, E)).toEqual(EMPTY);

    // Volver a abrir no crea nada más ni cambia el mes.
    expect(await openState(db, F, '2027-05')).toEqual(state);
    expect(count(sqlite, 'accounts')).toBe(2);
    expect(count(sqlite, 'goals')).toBe(2);
    expect(count(sqlite, 'months')).toBe(1);
  });

  it('cada usuario recibe sus propias cuentas y metas iniciales, con los mismos ids', async () => {
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

  it('quien borra o renombra sus cuentas y metas iniciales no las recupera', async () => {
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

  it('un usuario con meses pero sin marcar recibe sus cuentas y metas y conserva sus meses', async () => {
    const { db } = makeEnv();
    await ensureMonth(db, F, '2026-09');
    const state = await openState(db, F, '2026-10');
    expect(Object.keys(state.months)).toEqual(['2026-09']);
    expect(state.accounts).toEqual([...DEFAULT_ACCOUNTS]);
    expect(state.goals).toEqual([...DEFAULT_GOALS]);
  });

  it('userState prepara al usuario (cuentas, metas y marca) sin crearle ningún mes; después solo lee', async () => {
    const { db, sqlite } = makeEnv();
    const state = await userState(db, F);
    expect(state).toEqual({ ...EMPTY, accounts: [...DEFAULT_ACCOUNTS], goals: [...DEFAULT_GOALS] });
    expect(count(sqlite, 'months')).toBe(0);
    await deleteGoal(db, F, 'personal');
    expect((await userState(db, F)).goals.map((g) => g.id)).toEqual(['emergency']);
    // Y abrir la app después solo añade el mes.
    expect(await openState(db, F, '2026-10')).toEqual({ ...state, goals: [DEFAULT_GOALS[0]], months: { '2026-10': emptyMonth('2026-10') } });
  });

  it('no duplica una cuenta o una meta que ya existe con ese id o ese nombre; las que faltan van al final', async () => {
    const { db } = makeEnv();
    // Antes de abrir la web por primera vez ya tenía una cuenta y una meta con nombres de las iniciales.
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

  it('dos primeras visitas a la vez no duplican nada', async () => {
    const { db, sqlite } = makeEnv();
    await Promise.all([initUser(db, F), initUser(db, F), openState(db, F, '2026-10'), userState(db, F)]);
    expect(await listAccounts(db, F)).toEqual([...DEFAULT_ACCOUNTS]);
    expect(await listGoals(db, F)).toEqual([...DEFAULT_GOALS]);
    expect(count(sqlite, 'settings', F)).toBe(2);
    expect(count(sqlite, 'months', F)).toBe(1);
  });

  it('respeta una tasa por defecto que ya estuviera guardada', async () => {
    const { db, sqlite } = makeEnv();
    sqlite.sqlite.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'default_rate', '61.2')").run(F);
    expect((await openState(db, F, '2026-10')).defaultRate).toBe(61.2);
  });

  it('replaceAll y resetAll dejan al usuario marcado: después no se le añaden cuentas ni metas', async () => {
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

describe('ajustes: idioma, colores, monedas y cuenta por defecto', () => {
  const ocean = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };

  it('sin nada guardado: paleta original, inglés, DOP como principal, USD como segunda y la cuenta automática', async () => {
    const { db } = makeEnv();
    expect(await getSettings(db, F)).toEqual(DEFAULT_SETTINGS);
  });

  it('updateSettings cambia solo lo que viene y devuelve cómo queda', async () => {
    const { db } = makeEnv();
    expect(await updateSettings(db, F, { language: 'tr' })).toEqual({ ...DEFAULT_SETTINGS, language: 'tr' });
    expect(await updateSettings(db, F, { theme: ocean })).toEqual({ ...DEFAULT_SETTINGS, theme: ocean, language: 'tr' });
    expect(await updateSettings(db, F, { language: 'es' })).toEqual({ ...DEFAULT_SETTINGS, theme: ocean, language: 'es' });
    expect(await getSettings(db, F)).toEqual({ ...DEFAULT_SETTINGS, theme: ocean, language: 'es' });
    const state = await loadState(db, F);
    expect([state.theme, state.language]).toEqual([ocean, 'es']);
    // null vuelve a la paleta original sin tocar el idioma.
    expect(await updateSettings(db, F, { theme: null })).toEqual({ ...DEFAULT_SETTINGS, language: 'es' });
    // Sin nada que cambiar solo lee.
    expect(await updateSettings(db, F, {})).toEqual({ ...DEFAULT_SETTINGS, language: 'es' });
  });

  it('la paleta original se guarda como NULL', async () => {
    const { db, sqlite } = makeEnv();
    await updateSettings(db, F, { theme: ocean });
    const stored = () => sqlite.sqlite.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'theme'").get(F)?.value;
    expect(JSON.parse(String(stored()))).toEqual(ocean);
    expect(await updateSettings(db, F, { theme: { accent: '#2f7d52', header: '#1d1f1c', background: '#efeee8' } })).toMatchObject({ theme: null });
    expect(stored()).toBeNull();
  });

  it('monedas: las dos tienen que quedar distintas, contando la que no viene; para intercambiarlas van las dos juntas', async () => {
    const { db } = await arrived();
    const same = { ...invalid, message: 'Invalid data: secondCurrency: must be different from mainCurrency' };
    // Parte de DOP / USD.
    await expect(updateSettings(db, F, { mainCurrency: 'USD' })).rejects.toMatchObject(same);
    await expect(updateSettings(db, F, { secondCurrency: 'DOP' })).rejects.toMatchObject(same);
    await expect(updateSettings(db, F, { mainCurrency: 'TRY', secondCurrency: 'TRY' })).rejects.toMatchObject(same);
    expect(await getSettings(db, F)).toEqual(DEFAULT_SETTINGS);

    // Intercambiadas en una sola petición.
    expect(await updateSettings(db, F, { mainCurrency: 'USD', secondCurrency: 'DOP' })).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    // Una sola, si no choca con la otra.
    expect(await updateSettings(db, F, { secondCurrency: 'TRY' })).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'TRY' });
    expect(await updateSettings(db, F, { mainCurrency: 'DOP' })).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'TRY' });
    await expect(updateSettings(db, F, { mainCurrency: 'TRY' })).rejects.toMatchObject(same);
    // Escribir la que ya tiene no es un problema.
    expect(await updateSettings(db, F, { mainCurrency: 'DOP' })).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'TRY' });
    expect(await loadState(db, F)).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'TRY' });
  });

  it('cuenta por defecto: una cuenta del usuario o null; una que no existe, 400', async () => {
    const { db } = await arrived();
    expect(await updateSettings(db, F, { defaultAccountId: 'us' })).toMatchObject({ defaultAccountId: 'us' });
    expect((await loadState(db, F)).defaultAccountId).toBe('us');
    await expect(updateSettings(db, F, { defaultAccountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    expect((await getSettings(db, F)).defaultAccountId).toBe('us');
    // Vale una oculta: shared/calc la salta mientras lo esté.
    await patchAccount(db, F, 'us', { hidden: true });
    expect(await updateSettings(db, F, { defaultAccountId: 'us' })).toMatchObject({ defaultAccountId: 'us' });
    expect(defaultAccount(await loadState(db, F))!.id).toBe('dr');
    expect(await updateSettings(db, F, { defaultAccountId: null })).toMatchObject({ defaultAccountId: null });
  });

  it('si una parte no vale no se guarda ninguna', async () => {
    const { db } = await arrived();
    await expect(updateSettings(db, F, { language: 'tr', theme: ocean, mainCurrency: 'USD' })).rejects.toMatchObject(invalid);
    await expect(updateSettings(db, F, { language: 'tr', secondCurrency: 'TRY', defaultAccountId: 'nope' })).rejects.toMatchObject(invalid);
    expect(await getSettings(db, F)).toEqual(DEFAULT_SETTINGS);
  });

  it('un valor guardado que no se puede leer cuenta como no tenerlo', async () => {
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
    // Lo guardado a mano en otro formato válido se normaliza al leer.
    put.run(F, 'theme', '{"accent":"#ABC","header":"#000000","background":"#FFFFFF","extra":1}');
    expect((await getSettings(db, F)).theme).toEqual({ accent: '#aabbcc', header: '#000000', background: '#ffffff' });
    // Dos monedas iguales no son un par válido: la segunda vuelve a una distinta.
    put.run(F, 'main_currency', 'USD');
    put.run(F, 'second_currency', 'USD');
    expect(await getSettings(db, F)).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    put.run(F, 'main_currency', 'TRY');
    put.run(F, 'second_currency', 'TRY');
    expect(await loadState(db, F)).toMatchObject({ mainCurrency: 'TRY', secondCurrency: 'USD' });
  });
});

describe('cuentas', () => {
  it('una cuenta nueva va al final (sort = max + 1), con saldo inicial 0 y visible', async () => {
    const { db } = await arrived();
    const paypal = await createAccount(db, F, { name: 'PayPal', currency: 'USD' });
    expect(paypal).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), name: 'PayPal', currency: 'USD', opening: 0, hidden: false, sort: 2 });
    await patchAccount(db, F, 'us', { sort: 10 });
    const tr = await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY', opening: -250.75 });
    expect(tr).toEqual({ id: 'tr', name: 'TR account', currency: 'TRY', opening: -250.75, hidden: false, sort: 11 });
    // Se leen en su orden.
    expect((await listAccounts(db, F)).map((a) => a.id)).toEqual(['dr', paypal.id, 'us', 'tr']);
    expect((await loadState(db, F)).accounts.map((a) => a.id)).toEqual(['dr', paypal.id, 'us', 'tr']);
  });

  it('renombrar, corregir el saldo inicial, ocultar y volver a mostrar', async () => {
    const { db } = await seeded();
    expect(await patchAccount(db, F, 'dr', { name: 'Banreservas' })).toEqual({ ...SEED_ACCOUNTS[1], name: 'Banreservas' });
    // "Corregir el saldo" es mover el saldo inicial: de 60,000 a 50,000 el saldo baja 10,000.
    const before = await balance(db, F, 'dr');
    expect((await patchAccount(db, F, 'dr', { opening: 50000 })).opening).toBe(50000);
    expect(await balance(db, F, 'dr')).toBeCloseTo(before - 10000, 6);

    const total = balances(await loadState(db, F), '2026-10').totalMain;
    expect((await patchAccount(db, F, 'us', { hidden: true })).hidden).toBe(true);
    const hidden = await loadState(db, F);
    // Oculta: sigue existiendo con sus movimientos y su saldo, pero no suma al dinero total.
    expect(hidden.accounts.map((a) => [a.id, a.hidden])).toEqual([
      ['us', true],
      ['dr', false],
    ]);
    expect(balances(hidden, '2026-10').accounts.find((a) => a.account.id === 'us')!.balance).toBeCloseTo(13482, 8);
    expect(balances(hidden, '2026-10').totalMain).toBeCloseTo(total - 13482 * 58.76, 6);
    expect((await patchAccount(db, F, 'us', { hidden: false })).hidden).toBe(false);
    expect(balances(await loadState(db, F), '2026-10').totalMain).toBeCloseTo(total, 6);
    // Un patch vacío devuelve la cuenta tal como está.
    expect(await patchAccount(db, F, 'us', {})).toEqual(SEED_ACCOUNTS[0]);
    await expect(patchAccount(db, F, 'nope', { name: 'x' })).rejects.toMatchObject({ ...notFound, message: 'Account not found.' });
    await expect(patchAccount(db, F, 'nope', {})).rejects.toMatchObject(notFound);
  });

  it('el nombre es único por usuario sin distinguir mayúsculas (también con tildes): 409', async () => {
    const { db } = await arrived();
    const taken = { ...conflict, message: 'There is already an account with that name.' };
    await expect(createAccount(db, F, { name: 'us ACCOUNT', currency: 'TRY' })).rejects.toMatchObject(taken);
    await createAccount(db, F, { id: 'ah', name: 'Ahorros en dólares', currency: 'USD' });
    await expect(createAccount(db, F, { name: 'AHORROS EN DÓLARES', currency: 'USD' })).rejects.toMatchObject(taken);
    await expect(patchAccount(db, F, 'dr', { name: 'ahorros en dólares' })).rejects.toMatchObject(taken);
    // Su propio nombre no es un conflicto: se puede reescribir o cambiarle las mayúsculas.
    expect((await patchAccount(db, F, 'ah', { name: 'AHORROS EN DÓLARES' })).name).toBe('AHORROS EN DÓLARES');
    // Renombrada, el nombre anterior queda libre.
    await patchAccount(db, F, 'us', { name: 'Chase' });
    expect((await createAccount(db, F, { name: 'US account', currency: 'USD' })).name).toBe('US account');
    // Otro usuario sí puede tener una cuenta con ese mismo nombre.
    bystander = null;
    expect((await createAccount(db, E, { name: 'Ahorros en dólares', currency: 'DOP' })).currency).toBe('DOP');
  });

  it('la moneda solo se puede cambiar mientras nada use la cuenta', async () => {
    const { db } = await seeded();
    const inUse = { ...conflict, message: 'The account is in use: its currency cannot be changed.' };
    await expect(patchAccount(db, F, 'dr', { currency: 'USD' })).rejects.toMatchObject(inUse);
    // Ni junto con otros cambios, que tampoco se guardan.
    await expect(patchAccount(db, F, 'us', { name: 'Chase', currency: 'TRY' })).rejects.toMatchObject(inUse);
    expect(await listAccounts(db, F)).toEqual([...SEED_ACCOUNTS]);
    // Escribir la moneda que ya tiene no es un cambio.
    expect((await patchAccount(db, F, 'dr', { currency: 'DOP', name: 'Popular' })).name).toBe('Popular');

    const fresh = await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    expect((await patchAccount(db, F, fresh.id, { currency: 'TRY' })).currency).toBe('TRY');
    expect((await patchAccount(db, F, fresh.id, { currency: 'USD', opening: 5 })).currency).toBe('USD');
  });

  it('no se borra ni cambia de moneda una cuenta que algo usa: un fijo, una transacción, un envío, un ingreso o una parte del presupuesto', async () => {
    const { db } = await arrived();
    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    const inUse = { ...conflict, message: 'The account is in use: hide it instead of deleting it.' };
    const blocked = async (what: string) => {
      await expect(deleteAccount(db, F, 'pp'), what).rejects.toMatchObject(inUse);
      await expect(patchAccount(db, F, 'pp', { currency: 'TRY' }), what).rejects.toMatchObject(conflict);
    };

    const fixed = await createFixed(db, F, { monthKey: '2026-10', name: 'Hosting', amount: 5, cur: 'USD', accountId: 'pp' });
    await blocked('fijo');
    // Sin pagar no mueve el saldo, pero la cuenta sigue en uso.
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
    // Dejar la parte en 0 no la libera: el registro guarda la historia (+50, −50) y la sigue nombrando.
    const zeroed = await patchMonth(db, F, '2026-10', { budgets: { pp: 0 } });
    expect(zeroed.budgets).toEqual({});
    await blocked('historia del presupuesto');
    // Solo borrando esos movimientos deja de usarla.
    for (const e of zeroed.budgetLog.filter((x) => x.accountId === 'pp')) await deleteBudgetEntry(db, F, '2026-10', e.id);
    expect(withPart.budgetLog.filter((x) => x.accountId === 'pp')).toHaveLength(1);

    await deleteAccount(db, F, 'pp');
    expect((await listAccounts(db, F)).map((a) => a.id)).toEqual(['us', 'dr']);
    await expect(deleteAccount(db, F, 'pp')).rejects.toMatchObject({ ...notFound, message: 'Account not found.' });
  });

  it('no se puede borrar la última cuenta', async () => {
    const { db } = await arrived();
    await deleteAccount(db, F, 'us');
    await expect(deleteAccount(db, F, 'dr')).rejects.toMatchObject({
      ...conflict,
      message: 'The last account cannot be deleted: there must always be one.',
    });
    expect((await listAccounts(db, F)).map((a) => a.id)).toEqual(['dr']);
    // Con otra, ya sí.
    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    await deleteAccount(db, F, 'dr');
    expect((await listAccounts(db, F)).map((a) => a.id)).toEqual(['pp']);
  });

  it('borrar la cuenta por defecto la deja en la automática', async () => {
    const { db, sqlite } = await arrived();
    await updateSettings(db, F, { defaultAccountId: 'us' });
    await deleteAccount(db, F, 'us');
    expect((await getSettings(db, F)).defaultAccountId).toBeNull();
    expect(sqlite.sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE user_id = ? AND key = 'default_account'").get(F)?.n).toBe(0);
    // Un borrado rechazado no la toca.
    await updateSettings(db, F, { defaultAccountId: 'dr' });
    await expect(deleteAccount(db, F, 'dr')).rejects.toMatchObject(conflict);
    expect((await getSettings(db, F)).defaultAccountId).toBe('dr');
  });
});

describe('cuenta por defecto de lo que no dice de cuál sale', () => {
  const tx = { monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' as const };
  const fixed = { monthKey: '2026-10', name: 'Agua', amount: 1, cur: 'DOP' as const };
  const income = { date: '2026-10-07', amount: 1, cur: 'USD' as const };

  /** De qué cuenta salen (o a cuál entran) una transacción, un fijo y un ingreso creados sin `accountId`. */
  async function resolved(db: D1Database, userId = F): Promise<string[]> {
    return [
      (await createTransaction(db, userId, tx)).accountId,
      (await createFixed(db, userId, fixed)).accountId,
      (await createIncome(db, userId, income)).accountId,
    ];
  }

  it('la elegida en los ajustes; si no hay o está oculta, la primera visible en la moneda principal; si no, la primera visible', async () => {
    const { db } = await seeded();
    // Los datos de ejemplo eligen 'dr'.
    expect(await resolved(db)).toEqual(['dr', 'dr', 'dr']);
    await updateSettings(db, F, { defaultAccountId: 'us' });
    expect(await resolved(db)).toEqual(['us', 'us', 'us']);
    // Oculta deja de valer: la primera visible en la moneda principal (DOP).
    await patchAccount(db, F, 'us', { hidden: true });
    expect(await resolved(db)).toEqual(['dr', 'dr', 'dr']);
    await patchAccount(db, F, 'us', { hidden: false });
    // Sin elegida y con TRY de principal (ninguna cuenta en TRY): la primera visible.
    await updateSettings(db, F, { defaultAccountId: null, mainCurrency: 'TRY' });
    expect(await resolved(db)).toEqual(['us', 'us', 'us']);
    const tr = await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY' });
    expect(await resolved(db)).toEqual([tr.id, tr.id, tr.id]);
  });

  it('la cuenta que venga se respeta, sea o no la de por defecto y esté o no oculta', async () => {
    const { db } = await seeded();
    await patchAccount(db, F, 'us', { hidden: true });
    expect((await createTransaction(db, F, { ...tx, accountId: 'us' })).accountId).toBe('us');
    expect((await createFixed(db, F, { ...fixed, accountId: 'us' })).accountId).toBe('us');
    expect((await createIncome(db, F, { ...income, accountId: 'us' })).accountId).toBe('us');
  });

  it('cada usuario tiene la suya', async () => {
    const { db } = await seeded();
    await updateSettings(db, F, { defaultAccountId: 'us' });
    bystander = null;
    expect(await resolved(db, E)).toEqual(['dr', 'dr', 'dr']);
    expect(await resolved(db, F)).toEqual(['us', 'us', 'us']);
  });

  it('a quien nunca entró se le crean antes sus cuentas iniciales', async () => {
    const { db, sqlite } = makeEnv();
    const created = await createIncome(db, F, income);
    expect(created.accountId).toBe('dr');
    expect(await listAccounts(db, F)).toEqual([...DEFAULT_ACCOUNTS]);
    expect(await listGoals(db, F)).toEqual([...DEFAULT_GOALS]);
    expect(count(sqlite, 'accounts', E)).toBe(0);
  });

  it('userAccounts: las cuentas del usuario y su cuenta por defecto, la misma que da shared/calc sobre todo el estado', async () => {
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
    // Con todas ocultas, la primera que haya.
    await patchAccount(db, F, 'us', { hidden: true });
    expect(await same()).toBe('dr');

    // A quien nunca entró se le prepara antes (cuentas, metas y marca), sin crearle ningún mes.
    const { db: empty, sqlite: raw } = makeEnv();
    expect(await userAccounts(empty, F)).toEqual({ accounts: [...DEFAULT_ACCOUNTS], defaultAccount: DEFAULT_ACCOUNTS[1] });
    expect(await listGoals(empty, F)).toEqual([...DEFAULT_GOALS]);
    expect(count(raw, 'months')).toBe(0);
    expect(count(raw, 'accounts', E)).toBe(0);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('sin ninguna cuenta (solo puede pasar por fuera de la API) no hay dónde registrar: 409, y con la cuenta dicha, 400', async () => {
    const { db } = makeEnv();
    const state = seedState();
    await replaceAll(db, F, { ...state, accounts: [], incomes: [], defaultAccountId: null, months: { '2026-10': emptyMonth('2026-10') } });
    const none = { ...conflict, message: 'There are no accounts yet: add one first.' };
    expect(await userAccounts(db, F)).toEqual({ accounts: [], defaultAccount: null });
    await expect(createIncome(db, F, income)).rejects.toMatchObject(none);
    await expect(createTransaction(db, F, tx)).rejects.toMatchObject(none);
    await expect(createFixed(db, F, fixed)).rejects.toMatchObject(none);
    await expect(createIncome(db, F, { ...income, accountId: 'dr' })).rejects.toMatchObject(unknownAccount('dr'));
    // Abrir la app no se las devuelve (ya está marcado): las crea él, y entonces sí.
    expect((await openState(db, F, '2026-10')).accounts).toEqual([]);
    await createAccount(db, F, { id: 'new', name: 'Nueva', currency: 'DOP' });
    expect((await createIncome(db, F, income)).accountId).toBe('new');
  });

  it('una cuenta que no existe: 400 y no se guarda nada', async () => {
    const { db, sqlite } = await seeded();
    await expect(createTransaction(db, F, { ...tx, accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(createFixed(db, F, { ...fixed, accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(createIncome(db, F, { ...income, accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(patchTransaction(db, F, 'seed-tx-2026-10-1', { accountId: 'nope', amount: 9 })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(patchFixed(db, F, 'seed-fx-2026-10-1', { accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(patchIncome(db, F, 'seed-in-1', { accountId: 'nope' })).rejects.toMatchObject(unknownAccount('nope'));
    expect(count(sqlite, 'transactions', F)).toBe(27);
    expect((await getMonth(db, F, '2026-10'))!.tx[0]!.amount).toBe(4850);
    // Una fila que no existe sigue siendo un 404, venga la cuenta que venga.
    await expect(patchTransaction(db, F, 'nada', { accountId: 'nope' })).rejects.toMatchObject(notFound);
    await expect(patchIncome(db, F, 'nada', { accountId: 'nope' })).rejects.toMatchObject(notFound);
    // Y en un mes cerrado, primero la cuenta (un dato inválido) y después el mes.
    await expect(patchFixed(db, F, 'seed-fx-2026-08-1', { accountId: 'nope' })).rejects.toMatchObject(invalid);
    await expect(patchFixed(db, F, 'seed-fx-2026-08-1', { accountId: 'us' })).rejects.toMatchObject(closedMonth);
  });

  it('todo mueve los saldos: pagar un fijo, registrar un gasto o un ingreso, y cambiarlos de cuenta', async () => {
    const { db } = await seeded();
    const dr = await balance(db, F, 'dr');
    const us = await balance(db, F, 'us');

    // Netflix (1,137.30 DOP, sin pagar) resta de 'dr' solo mientras está pagado.
    const netflix = (await getMonth(db, F, '2026-10'))!.fixed.find((f) => f.name === 'Netflix')!;
    await patchFixed(db, F, netflix.id, { paid: true });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr - 1137.3, 6);
    // Pagado desde la cuenta en USD, le resta convertido con la tasa del mes (58.76).
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
    // Un aporte a una meta no mueve ningún saldo.
    await createContribution(db, F, { goalId: 'personal', date: '2026-10-09', amount: 300, cur: 'USD' });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr + 5876, 6);
    expect(await balance(db, F, 'us')).toBeCloseTo(us, 6);
  });
});

describe('ensureMonth', () => {
  it('sin meses anteriores crea un mes vacío', async () => {
    const { db } = makeEnv();
    const { month, created } = await ensureMonth(db, F, '2026-10');
    expect(created).toBe(true);
    expect(month).toEqual(emptyMonth('2026-10'));
  });

  it('si ya existe no lo toca y lo dice', async () => {
    const { db, sqlite } = await seeded();
    const before = await getMonth(db, F, '2026-10');
    const { month, created } = await ensureMonth(db, F, '2026-10');
    expect(created).toBe(false);
    expect(month).toEqual(before);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(33);
  });

  it('clona del mes anterior más cercano: fijos sin pagar con su cuenta e ids nuevos, y las partes del presupuesto; las tasas no', async () => {
    const { db } = await seeded();
    await patchMonth(db, F, '2026-10', { budgets: { us: 250 } });
    // Hay hueco: noviembre no existe; diciembre se copia de octubre.
    const { month, created } = await ensureMonth(db, F, '2026-12');
    const october = (await getMonth(db, F, '2026-10'))!;
    expect(created).toBe(true);
    expect(month.closed).toBe(false);
    expect(month.budgets).toEqual({ dr: 70000, us: 250 });
    expect(october.rates).toHaveLength(2);
    expect(month.rates).toEqual([]);
    // Un movimiento inicial por cuenta, del primer día del mes nuevo, por lo que sumaba el registro de octubre.
    expect(month.budgetLog.map(({ id: _id, ...e }) => e)).toEqual([
      { date: '2026-12-01', accountId: 'dr', amount: 70000, kind: 'initial', note: '' },
      { date: '2026-12-01', accountId: 'us', amount: 250, kind: 'initial', note: '' },
    ]);
    for (const e of month.budgetLog) expect(e.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(month.transfers).toEqual([]);
    expect(month.tx).toEqual([]);
    expect(month.fixed.map(core)).toEqual(october.fixed.map(core));
    // Claude se paga de la cuenta en USD; el resto, de la de DOP.
    expect(month.fixed.filter((f) => f.accountId === 'us').map((f) => f.name)).toEqual(['Claude']);
    expect(month.fixed.every((f) => !f.paid && f.monthKey === '2026-12')).toBe(true);
    const ids = new Set([...month.fixed, ...october.fixed].map((f) => f.id));
    expect(ids.size).toBe(22);
    for (const f of month.fixed) expect(f.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    // Sin tasa propia, en diciembre sigue vigente la última escrita.
    expect(rateFor(await loadState(db, F), '2026-12', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'previous', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('un mes intermedio se copia del anterior, no del posterior', async () => {
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

  it('un mes anterior a todos los que hay queda vacío', async () => {
    const { db } = await seeded();
    const { month, created } = await ensureMonth(db, F, '2026-01');
    expect(created).toBe(true);
    expect(month).toEqual(emptyMonth('2026-01'));
  });

  it('rechaza claves que no son un mes', async () => {
    const { db } = makeEnv();
    await expect(ensureMonth(db, F, '2026-13')).rejects.toMatchObject(invalid);
  });
});

describe('closeMonth', () => {
  it('cruza el año: cerrar diciembre crea enero', async () => {
    const { db } = makeEnv();
    await ensureMonth(db, F, '2026-12');
    const { closed, next } = await closeMonth(db, F, '2026-12', {}, new Date('2027-01-02T03:04:05.000Z'));
    expect(closed.closed).toBe(true);
    expect(closed.closedAt).toBe('2027-01-02T03:04:05.000Z');
    expect(next.key).toBe('2027-01');
  });

  it('el mes siguiente nace con los fijos sin pagar (misma cuenta) y las mismas partes del presupuesto, sin tasas', async () => {
    const { db } = await seeded();
    await patchMonth(db, F, '2026-10', { budgets: { us: 100 } });
    const { closed, next } = await closeMonth(db, F, '2026-10');
    expect(next).toMatchObject({ key: '2026-11', closed: false, closedAt: null, budgets: { dr: 70000, us: 100 }, rates: [], transfers: [], tx: [] });
    expect(next.fixed.map(core)).toEqual(closed.fixed.map(core));
    expect(next.fixed.every((f) => !f.paid)).toBe(true);
    // Cerrar no cambia ningún saldo: los fijos del mes nuevo están sin pagar.
    expect(await balance(db, F, 'dr', '2026-11')).toBeCloseTo(220641.93, 6);
  });

  it('si no se puede crear el mes siguiente tampoco queda cerrado (un solo batch)', async () => {
    const { db, sqlite } = await seeded();
    // Fuerza el fallo del INSERT de fijos del mes nuevo.
    sqlite.sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON fixed_expenses BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await expect(closeMonth(db, F, '2026-10')).rejects.toThrow(/boom/);
    expect((await getMonth(db, F, '2026-10'))!.closed).toBe(false);
    expect(await getMonth(db, F, '2026-11')).toBeNull();
  });
});

describe('presupuesto por cuenta (patchMonth)', () => {
  const NOW = new Date('2026-10-08T15:00:00.000Z');
  const log = (m: Month) => m.budgetLog.map((e) => [e.date, e.accountId, e.amount, e.kind]);

  it('fija la parte de una cuenta añadiendo al registro la diferencia: inicial la primera vez, ajuste después', async () => {
    const { db, sqlite } = await seeded();
    // La US account no tenía nada en octubre: su primer movimiento es el inicial, con fecha de hoy.
    const first = await patchMonth(db, F, '2026-10', { budgets: { us: 200 } }, NOW);
    expect(first.budgets).toEqual({ dr: 70000, us: 200 });
    expect(log(first)).toEqual([
      ['2026-10-01', 'dr', 65000, 'initial'],
      ['2026-10-05', 'dr', 5000, 'adjust'],
      ['2026-10-08', 'us', 200, 'initial'],
    ]);
    // La DR account ya tenía 70,000: bajarla a 58,248.5 es un ajuste de −11,751.5.
    const second = await patchMonth(db, F, '2026-10', { budgets: { dr: 58248.5 } }, NOW);
    expect(second.budgets).toEqual({ dr: 58248.5, us: 200 });
    expect(log(second).at(-1)).toEqual(['2026-10-08', 'dr', -11751.5, 'adjust']);
    // El total es la suma convertida a la moneda principal con la tasa del mes.
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBeCloseTo(58248.5 + 200 * 58.76, 8);
    expect(count(sqlite, 'month_budget_log', F)).toBe(6);

    // El mismo monto otra vez no añade nada (ni el mismo que ya suma): la diferencia es 0.
    expect(log(await patchMonth(db, F, '2026-10', { budgets: { dr: 58248.5, us: 200 } }, NOW))).toEqual(log(second));
    expect(count(sqlite, 'month_budget_log', F)).toBe(6);

    // 0 deja la parte en cero con un ajuste negativo: la historia se conserva.
    const zero = await patchMonth(db, F, '2026-10', { budgets: { dr: 0 } }, NOW);
    expect(zero.budgets).toEqual({ us: 200 });
    expect(log(zero).at(-1)).toEqual(['2026-10-08', 'dr', -58248.5, 'adjust']);
    // Volver a ponerle 0, o ponérselo a una cuenta sin parte, no es un error ni un movimiento.
    expect((await patchMonth(db, F, '2026-10', { budgets: { dr: 0, us: 0 } }, NOW)).budgets).toEqual({});
    expect(count(sqlite, 'month_budget_log', F)).toBe(8);
    // Varias a la vez, y los demás meses no se enteran.
    const month = await patchMonth(db, F, '2026-10', { budgets: { dr: 1, us: 2 } }, NOW);
    expect(month.budgets).toEqual({ dr: 1, us: 2 });
    expect(log(month).slice(-2)).toEqual([
      ['2026-10-08', 'dr', 1, 'adjust'],
      ['2026-10-08', 'us', 2, 'adjust'],
    ]);
    expect(month.fixed).toHaveLength(11);
    expect((await getMonth(db, F, '2026-09'))!.budgets).toEqual({ dr: 70000 });
  });

  it('la fecha del movimiento es hoy en Santo Domingo, llevada al mes si cae fuera', async () => {
    const { db } = await seeded();
    await reopenMonth(db, F, '2026-08');
    await ensureMonth(db, F, '2026-12');
    // A las 03:00 UTC del día 9 en Santo Domingo todavía es el día 8.
    const late = new Date('2026-10-09T03:00:00.000Z');
    expect(log(await patchMonth(db, F, '2026-10', { budgets: { dr: 70001 } }, late)).at(-1)).toEqual(['2026-10-08', 'dr', 1, 'adjust']);
    // Un mes pasado: su último día. Uno futuro: el primero.
    expect(log(await patchMonth(db, F, '2026-08', { budgets: { dr: 70010 } }, late)).at(-1)).toEqual(['2026-08-31', 'dr', 10, 'adjust']);
    expect(log(await patchMonth(db, F, '2026-12', { budgets: { dr: 70100 } }, late)).at(-1)).toEqual(['2026-12-01', 'dr', 100, 'adjust']);
  });

  it('no arrastra el ruido de la coma flotante: 0.1 + 0.2 ya es 0.3', async () => {
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

  it('los ingresos que suben el presupuesto no entran en la cuenta: se fija lo que suma el registro', async () => {
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

  it('un patch vacío devuelve el mes sin cambios', async () => {
    const { db } = await seeded();
    const before = await getMonth(db, F, '2026-10');
    expect(await patchMonth(db, F, '2026-10', {})).toEqual(before);
    expect(await patchMonth(db, F, '2026-10', { budgets: {} })).toEqual(before);
    await expect(patchMonth(db, F, '2031-01', {})).rejects.toMatchObject(notFound);
  });

  it('la cuenta tiene que existir: si alguna no, no se aplica ninguna parte', async () => {
    const { db } = await seeded();
    await expect(patchMonth(db, F, '2026-10', { budgets: { us: 5, nope: 10 } })).rejects.toMatchObject(unknownAccount('nope'));
    await expect(patchMonth(db, F, '2026-10', { budgets: { nope: 0 } })).rejects.toMatchObject(unknownAccount('nope'));
    expect((await getMonth(db, F, '2026-10'))!.budgets).toEqual({ dr: 70000 });
    await expect(patchMonth(db, F, '2031-01', { budgets: { dr: 1 } })).rejects.toMatchObject({ ...notFound, message: 'Month 2031-01 does not exist.' });
  });
});

describe('tasas del mes', () => {
  it('una por par de monedas: escribirla otra vez la sustituye, también en el otro sentido', async () => {
    const { db, sqlite } = await seeded();
    // La del día 1 se sustituye; la del día 6 es otra tasa y no se toca.
    expect((await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-01' })).rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
    ]);
    const state = await loadState(db, F);
    expect(rateFor(state, '2026-10', 'USD', 'DOP', '2026-10-05')).toEqual({ rate: 59.1, source: 'month', monthKey: '2026-10', date: '2026-10-01' });
    expect(rateFor(state, '2026-10', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-06' });

    // DOP → USD es el mismo par: sustituye a la USD → DOP de esa fecha, no se suma a ella.
    const inverse = await setMonthRate(db, F, '2026-10', { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' });
    expect(inverse.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' },
    ]);
    expect(count(sqlite, 'month_rates', F)).toBe(2);
    expect(rateFor(await loadState(db, F), '2026-10', 'USD', 'DOP').rate).toBeCloseTo(1 / 0.0168, 10);

    // Una fecha nueva se añade a la historia: las anteriores siguen valiendo para lo de antes.
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

    // Otro par se añade; con dos, el tercero sale cruzando.
    const two = await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    expect(two.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
    ]);
    expect(rateFor(await loadState(db, F), '2026-10', 'TRY', 'DOP').source).toBe('cross');
    // Y cada mes tiene las suyas.
    expect((await getMonth(db, F, '2026-09'))!.rates).toEqual([]);
    expect(two.fixed).toHaveLength(11);
  });

  it('quitarla, esté guardada en un sentido o en el otro; si no la hay, el mes queda igual', async () => {
    const { db, sqlite } = await seeded();
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    // Guardada como USD → DOP, se quita pidiendo DOP → USD; solo la de esa fecha.
    const one = await deleteMonthRate(db, F, '2026-10', 'DOP', 'USD', '2026-10-06');
    expect(one.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
    ]);
    // Una fecha en la que no hay tasa: nada cambia.
    expect(await deleteMonthRate(db, F, '2026-10', 'USD', 'DOP', '2026-10-02')).toEqual(one);
    const removed = await deleteMonthRate(db, F, '2026-10', 'DOP', 'USD', '2026-10-01');
    expect(removed.rates).toEqual([{ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' }]);
    // Sin ninguna escrita, octubre vuelve a la de sus envíos.
    expect(rateFor(await loadState(db, F), '2026-10', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'transfers', monthKey: '2026-10', date: null });
    expect(await deleteMonthRate(db, F, '2026-10', 'DOP', 'USD', '2026-10-01')).toEqual(removed);
    expect((await deleteMonthRate(db, F, '2026-10', 'USD', 'TRY', '2026-10-01')).rates).toEqual([]);
    expect(count(sqlite, 'month_rates', F)).toBe(0);
    await expect(deleteMonthRate(db, F, '2031-01', 'USD', 'DOP', '2031-01-01')).rejects.toMatchObject(notFound);
    await expect(setMonthRate(db, F, '2031-01', { from: 'USD', to: 'DOP', rate: 1, date: '2031-01-01' })).rejects.toMatchObject(notFound);
  });

  it('la fecha de una tasa tiene que caer dentro de su mes', async () => {
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

describe('mes cerrado: el presupuesto y las tasas también son de solo lectura', () => {
  it('409 month_closed y nada cambia; reabierto, sí', async () => {
    const { db } = await seeded();
    const before = await loadState(db, F);
    const closed = { ...closedMonth, message: 'August 2026 is closed: it is read-only. Reopen it to make changes.' };
    await expect(patchMonth(db, F, '2026-08', { budgets: { dr: 1 } })).rejects.toMatchObject(closed);
    await expect(patchMonth(db, F, '2026-08', { budgets: { dr: 0 } })).rejects.toMatchObject(closed);
    await expect(setMonthRate(db, F, '2026-08', { from: 'USD', to: 'DOP', rate: 60, date: '2026-08-01' })).rejects.toMatchObject(closed);
    await expect(deleteMonthRate(db, F, '2026-08', 'USD', 'DOP', '2026-08-01')).rejects.toMatchObject(closed);
    expect(await loadState(db, F)).toEqual(before);

    // Con una tasa ya escrita en el mes cerrado tampoco se puede sustituir (ni por su inversa) ni quitar.
    await reopenMonth(db, F, '2026-08');
    expect((await setMonthRate(db, F, '2026-08', { from: 'USD', to: 'DOP', rate: 58, date: '2026-08-01' })).rates).toHaveLength(1);
    expect((await patchMonth(db, F, '2026-08', { budgets: { dr: 65000 } })).budgets).toEqual({ dr: 65000 });
    await closeMonth(db, F, '2026-08');
    await expect(setMonthRate(db, F, '2026-08', { from: 'DOP', to: 'USD', rate: 0.02, date: '2026-08-01' })).rejects.toMatchObject(closedMonth);
    await expect(deleteMonthRate(db, F, '2026-08', 'DOP', 'USD', '2026-08-01')).rejects.toMatchObject(closedMonth);
    expect((await getMonth(db, F, '2026-08'))!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 58, date: '2026-08-01' }]);
    // Un patch vacío solo lee.
    expect((await patchMonth(db, F, '2026-08', {})).closed).toBe(true);
  });
});

describe('borrar un mes', () => {
  it('se lleva todo lo suyo (fijos, transacciones, envíos, presupuesto y tasas), esté abierto o cerrado', async () => {
    const { db, sqlite } = await seeded();
    // Octubre: abierto, con una tasa escrita.
    await deleteMonth(db, F, '2026-10');
    expect(count(sqlite, 'months', F)).toBe(2);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(22);
    expect(count(sqlite, 'transactions', F)).toBe(20);
    expect(count(sqlite, 'transfers', F)).toBe(4);
    expect(count(sqlite, 'month_budget_log', F)).toBe(2);
    // Lo del otro usuario sigue entero.
    expect(count(sqlite, 'month_budget_log', E)).toBe(4);
    expect(count(sqlite, 'month_rates', E)).toBe(2);
    expect(count(sqlite, 'month_rates', F)).toBe(0);
    // Septiembre: cerrado.
    await deleteMonth(db, F, '2026-09');
    const state = await loadState(db, F);
    expect(Object.keys(state.months)).toEqual(['2026-08']);
    expect(count(sqlite, 'transactions', F)).toBe(10);
    // Lo que no es de ningún mes se conserva.
    expect(state.incomes).toEqual(seedState().incomes);
    expect(state.contribs).toEqual(seedState().contribs);
    expect(state.accounts).toEqual(seedState().accounts);
    expect(state.goals).toEqual(seedState().goals);
    await expect(deleteMonth(db, F, '2026-09')).rejects.toMatchObject({ ...notFound, message: 'Month 2026-09 does not exist.' });
    await expect(deleteMonth(db, F, '2031-01')).rejects.toMatchObject(notFound);
  });

  it('los saldos cambian en consecuencia: dejan de contar sus gastos y sus envíos, no sus ingresos', async () => {
    const { db } = await seeded();
    expect(await balance(db, F, 'us')).toBeCloseTo(13482, 8);
    expect(await balance(db, F, 'dr')).toBeCloseTo(220641.93, 6);
    await deleteMonth(db, F, '2026-09');
    // US: 2,000 + 3 sueldos de 5,800 − los envíos de agosto y octubre (1,800 + 1,500) − Claude dos meses.
    expect(await balance(db, F, 'us')).toBeCloseTo(2000 + 17400 - 3300 - 212, 8);
    // DR: 60,000 + lo recibido en agosto y octubre − sus transacciones − sus fijos pagados en DOP.
    expect(await balance(db, F, 'dr')).toBeCloseTo(60000 + 104730 + 88140 - 27850 - 10845 - 35750.26 - 32076.15, 6);
    // El sueldo de septiembre sigue contando, convertido con la tasa del mes anterior más cercano.
    const state = await loadState(db, F);
    expect(state.incomes).toHaveLength(3);
    expect(rateFor(state, '2026-09', 'USD', 'DOP')).toMatchObject({ source: 'previous', monthKey: '2026-08' });
  });

  it('cuando no queda ningún mes, abrir la app crea otra vez el actual, vacío', async () => {
    const { db } = await seeded();
    for (const key of ['2026-08', '2026-09', '2026-10']) await deleteMonth(db, F, key);
    expect((await loadState(db, F)).months).toEqual({});
    const state = await openState(db, F, '2026-10');
    expect(state.months).toEqual({ '2026-10': emptyMonth('2026-10') });
    // No es una primera visita: no se le añade nada más.
    expect(state.accounts).toEqual(seedState().accounts);
    expect(state.goals).toEqual(seedState().goals);
    expect(state.incomes).toHaveLength(3);
    // Sin ningún gasto ni envío: saldo inicial más los ingresos.
    expect(balances(state, '2026-10').accounts.map((a) => a.balance)).toEqual([2000 + 17400, 60000]);
  });
});

describe('carreras entre peticiones (D1 no tiene transacciones interactivas)', () => {
  it('ensureMonth: si otra petición crea el mes entre la lectura y la escritura, vale el suyo', async () => {
    const { db, sqlite } = await seeded();
    const racy = interleaved(db, (call) => {
      // 1.er batch: la lectura (el mes no existe). 2.º: la creación, que llega tarde.
      if (call === 2) sqlite.sqlite.exec("INSERT INTO months (user_id, key) VALUES ('frank', '2026-11')");
    });
    const { month, created } = await ensureMonth(racy, F, '2026-11');
    expect(created).toBe(false);
    // El mes de la otra petición, vacío: nada de la copia que se deshizo.
    expect(month).toEqual(emptyMonth('2026-11'));
    expect(count(sqlite, 'fixed_expenses', F)).toBe(33);
    expect(count(sqlite, 'month_budget_log', F)).toBe(4);
  });

  it('ensureMonth: que OTRO usuario cree ese mismo mes a la vez no estorba', async () => {
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

  it('closeMonth: si el mes siguiente aparece a mitad, se cierra igual y no se duplica nada', async () => {
    const { db, sqlite } = await seeded();
    const racy = interleaved(db, (call) => {
      // 1.er batch: cerrar + crear noviembre; para entonces "otra petición" ya lo creó.
      if (call === 1) sqlite.sqlite.exec("INSERT INTO months (user_id, key) VALUES ('frank', '2026-11')");
    });
    const { closed, next } = await closeMonth(racy, F, '2026-10');
    expect(closed.closed).toBe(true);
    expect(next).toEqual(emptyMonth('2026-11'));
    expect(count(sqlite, 'months', F)).toBe(4);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(33);
  });

  it('patchMonth y setMonthRate: si el mes se cierra entre la comprobación y la escritura, no se escribe nada', async () => {
    const { db, sqlite } = await seeded();
    const close = "UPDATE months SET closed = 1 WHERE user_id = 'frank' AND key = '2026-10'";
    const before = await getMonth(db, F, '2026-10');
    // El único batch de cada una es el de la escritura.
    const racy = () => interleaved(db, (call) => void (call === 1 && sqlite.sqlite.exec(close)));
    await expect(patchMonth(racy(), F, '2026-10', { budgets: { dr: 1, us: 2 } })).rejects.toMatchObject(closedMonth);
    await reopenMonth(db, F, '2026-10');
    await expect(setMonthRate(racy(), F, '2026-10', { from: 'DOP', to: 'USD', rate: 1, date: '2026-10-01' })).rejects.toMatchObject(closedMonth);
    await reopenMonth(db, F, '2026-10');
    await expect(deleteMonthRate(racy(), F, '2026-10', 'USD', 'DOP', '2026-10-01')).rejects.toMatchObject(closedMonth);
    expect(await getMonth(db, F, '2026-10')).toEqual({ ...before, closed: true });
  });

  it('createAccount y createGoal: dos altas con el mismo nombre a la vez no dejan dos', async () => {
    const { db, sqlite } = await seeded();
    const racyAccount = interleaved(
      db,
      (call) => {
        // 1.ª sentencia: la lectura de las cuentas (el nombre está libre). 2.ª: el INSERT, que llega tarde.
        if (call === 2) sqlite.sqlite.exec("INSERT INTO accounts (user_id, id, name, currency, sort) VALUES ('frank', 'la-otra', 'paypal', 'USD', 2)");
      },
      'prepare',
    );
    await expect(createAccount(racyAccount, F, { name: 'PayPal', currency: 'USD' })).rejects.toMatchObject(conflict);
    expect(count(sqlite, 'accounts', F)).toBe(3);

    const racyGoal = interleaved(
      db,
      (call) => {
        // 1.ª y 2.ª: las lecturas (metas y ajustes). 3.ª: el INSERT.
        if (call === 3) sqlite.sqlite.exec("INSERT INTO goals (user_id, id, name, sort) VALUES ('frank', 'la-otra', 'car', 3)");
      },
      'prepare',
    );
    await expect(createGoal(racyGoal, F, { name: 'Car' })).rejects.toMatchObject(conflict);
    expect(count(sqlite, 'goals', F)).toBe(4);
  });

  it('patchGoal: lo guardado es siempre un plan válido aunque la meta cambie entre la lectura y la escritura', async () => {
    const { db, sqlite } = await seeded();
    const racy = interleaved(
      db,
      (call) => {
        // Otra petición le quita el plan a la meta justo antes del UPDATE.
        if (call === 2) {
          sqlite.sqlite.exec("UPDATE goals SET monthly = NULL, start_month = NULL, end_month = NULL WHERE user_id = 'frank' AND id = 'turkey'");
        }
      },
      'prepare',
    );
    // Solo `end`: vale porque la meta leída tenía plan. Sin escribir los tres campos quedaría un plan a medias.
    const goal = await patchGoal(racy, F, 'turkey', { end: '2027-12' });
    expect(goal).toMatchObject({ monthly: 3000, start: '2026-08', end: '2027-12' });
    expect((await listGoals(db, F))[2]).toEqual(goal);
  });

  it('patchAccount: la moneda no cambia si la cuenta empieza a usarse entre la lectura y la escritura', async () => {
    const { db, sqlite } = await arrived();
    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    const racy = interleaved(
      db,
      (call) => {
        // 1.ª sentencia: la lectura de las cuentas. 2.ª: el UPDATE; para entonces ya hay un ingreso en ella.
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

describe('gastos fijos', () => {
  it('un fijo nuevo va al final: sort = max(sort) + 1', async () => {
    const { db } = await arrived();
    const a = await createFixed(db, F, { monthKey: '2026-10', name: 'A', amount: 1, cur: 'DOP' });
    const b = await createFixed(db, F, { monthKey: '2026-10', name: 'B', amount: 1, cur: 'DOP' });
    expect([a.sort, b.sort]).toEqual([0, 1]);
    await patchFixed(db, F, b.id, { sort: 7 });
    const c = await createFixed(db, F, { monthKey: '2026-10', name: 'C', amount: 1, cur: 'TRY' });
    expect(c.sort).toBe(8);
    // Un fijo puede estar en cualquiera de las tres monedas, sea cual sea la de su cuenta.
    expect(c).toMatchObject({ cur: 'TRY', accountId: 'dr' });
    // El orden de lectura es por sort.
    await patchFixed(db, F, a.id, { sort: 9 });
    expect((await getMonth(db, F, '2026-10'))!.fixed.map((f) => f.name)).toEqual(['B', 'C', 'A']);
  });

  it('el orden de un usuario no depende de los fijos de otro en el mismo mes', async () => {
    const { db } = await arrived();
    bystander = null;
    for (const name of ['A', 'B', 'C']) await createFixed(db, E, { monthKey: '2026-10', name, amount: 1, cur: 'DOP' });
    expect((await createFixed(db, F, { monthKey: '2026-10', name: 'A', amount: 1, cur: 'DOP' })).sort).toBe(0);
  });
});

describe('envíos entre cuentas', () => {
  const transfer = { monthKey: '2026-10', date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 100 };

  it('sin tasa lleva la del mes para las monedas de las dos cuentas; entre cuentas de la misma moneda, 1', async () => {
    const { db } = await seeded();
    // Octubre tiene escrita 1 USD = 58.76 DOP.
    expect(await createTransfer(db, F, transfer)).toEqual({ id: expect.any(String), ...transfer, rate: 58.76, budget: false });
    // En sentido contrario, su inversa.
    const back = await createTransfer(db, F, { ...transfer, fromAccountId: 'dr', toAccountId: 'us', amount: 5876 });
    expect(back.rate).toBeCloseTo(1 / 58.76, 12);

    await createAccount(db, F, { id: 'pp', name: 'PayPal', currency: 'USD' });
    expect((await createTransfer(db, F, { ...transfer, toAccountId: 'pp' })).rate).toBe(1);

    // Septiembre no tiene tasa escrita: la de sus envíos (promedio ponderado).
    await reopenMonth(db, F, '2026-09');
    const september = await createTransfer(db, F, { ...transfer, monthKey: '2026-09', date: '2026-09-20' });
    expect(september.rate).toBeCloseTo((1500 * 58.55 + 800 * 58.62) / 2300, 10);

    // Hacia una cuenta en TRY nadie escribió nunca una tasa: el valor de respaldo (58.76 DOP y 42 TRY por USD).
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY' });
    expect((await createTransfer(db, F, { ...transfer, toAccountId: 'tr' })).rate).toBe(42);
    await setMonthRate(db, F, '2026-10', { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-01' });
    expect((await createTransfer(db, F, { ...transfer, toAccountId: 'tr' })).rate).toBeCloseTo(40, 10);
  });

  it('con tasa lleva la que venga, y mueve los dos saldos: sale amount y entra amount × rate', async () => {
    const { db } = await seeded();
    const [us, dr] = [await balance(db, F, 'us'), await balance(db, F, 'dr')];
    const created = await createTransfer(db, F, { ...transfer, via: 'Banco Popular', rate: 57.5 });
    expect(created).toMatchObject({ via: 'Banco Popular', amount: 100, rate: 57.5 });
    expect(await balance(db, F, 'us')).toBeCloseTo(us - 100, 8);
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr + 5750, 6);

    // Editarlo: el monto, la tasa y las cuentas.
    expect(await patchTransfer(db, F, created.id, { amount: 200, rate: 58 })).toMatchObject({ amount: 200, rate: 58 });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr + 11600, 6);
    const swapped = await patchTransfer(db, F, created.id, { fromAccountId: 'dr', toAccountId: 'us', amount: 5800, rate: 1 / 58 });
    expect(swapped).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us', amount: 5800 });
    expect(await balance(db, F, 'dr')).toBeCloseTo(dr - 5800, 6);
    expect(await balance(db, F, 'us')).toBeCloseTo(us + 100, 6);
    await deleteTransfer(db, F, created.id);
    expect([await balance(db, F, 'us'), await balance(db, F, 'dr')]).toEqual([us, dr]);
  });

  it('las dos cuentas tienen que ser distintas, también al editar una sola', async () => {
    const { db, sqlite } = await seeded();
    const same = { ...invalid, message: 'Invalid data: toAccountId: must be different from fromAccountId' };
    await expect(createTransfer(db, F, { ...transfer, toAccountId: 'us' })).rejects.toMatchObject(same);
    await expect(createTransfer(db, F, { ...transfer, toAccountId: 'us', rate: 1 })).rejects.toMatchObject(same);
    expect(count(sqlite, 'transfers', F)).toBe(5);
    // seed-tr-2026-10-1 va de 'us' a 'dr'.
    await expect(patchTransfer(db, F, 'seed-tr-2026-10-1', { toAccountId: 'us' })).rejects.toMatchObject(same);
    await expect(patchTransfer(db, F, 'seed-tr-2026-10-1', { fromAccountId: 'dr' })).rejects.toMatchObject(same);
    await expect(patchTransfer(db, F, 'seed-tr-2026-10-1', { fromAccountId: 'dr', toAccountId: 'dr' })).rejects.toMatchObject(same);
    expect((await getMonth(db, F, '2026-10'))!.transfers).toEqual(seedState().months['2026-10']!.transfers);
  });

  it('las dos cuentas tienen que existir', async () => {
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

describe('ingresos', () => {
  it('crear, listar, editar y borrar; el ingreso del mes es la suma de los de su fecha', async () => {
    const { db } = await seeded();
    expect(await listIncomes(db, F)).toEqual(seedState().incomes);

    const created = await createIncome(db, F, { date: '2026-10-15', desc: 'Freelance', accountId: 'us', amount: 400, cur: 'USD' });
    expect(created).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), date: '2026-10-15', desc: 'Freelance', accountId: 'us', amount: 400, cur: 'USD', budget: false });
    expect(monthCalc(await loadState(db, F), '2026-10').income).toBeCloseTo((5800 + 400) * 58.76, 6);
    expect(await balance(db, F, 'us')).toBeCloseTo(13482 + 400, 8);

    // En otra moneda y a otra cuenta: entra convertido con la tasa del mes de su fecha.
    const patched = await patchIncome(db, F, created.id, { date: '2026-10-16', desc: '', accountId: 'dr', amount: 1000, cur: 'TRY' });
    expect(patched).toEqual({ id: created.id, date: '2026-10-16', desc: '', accountId: 'dr', amount: 1000, cur: 'TRY', budget: false });
    expect(await balance(db, F, 'us')).toBeCloseTo(13482, 8);
    expect(await balance(db, F, 'dr')).toBeCloseTo(220641.93 + (1000 * 58.76) / 42, 6);
    expect((await patchIncome(db, F, created.id, { amount: 0 })).amount).toBe(0);
    expect(await patchIncome(db, F, created.id, {})).toEqual({ ...patched, amount: 0 });

    await deleteIncome(db, F, created.id);
    await expect(deleteIncome(db, F, created.id)).rejects.toMatchObject({ ...notFound, message: 'Income not found.' });
    await expect(patchIncome(db, F, created.id, { amount: 1 })).rejects.toMatchObject(notFound);
    expect(await listIncomes(db, F)).toEqual(seedState().incomes);
  });

  it('sin descripción queda vacía; el id puede venir del cliente y repetido es un 409', async () => {
    const { db } = await seeded();
    expect(await createIncome(db, F, { id: 'in-1', date: '2026-10-15', amount: 1, cur: 'DOP' })).toEqual({
      id: 'in-1', date: '2026-10-15', desc: '', accountId: 'dr', amount: 1, cur: 'DOP', budget: false,
    });
    await expect(createIncome(db, F, { id: 'in-1', date: '2026-10-15', amount: 1, cur: 'DOP' })).rejects.toMatchObject(conflict);
    await expect(createIncome(db, F, { id: 'seed-in-1', date: '2026-10-15', amount: 1, cur: 'DOP' })).rejects.toMatchObject(conflict);
  });

  it('no pertenecen a un mes: se crean, editan y borran aunque el mes de su fecha esté cerrado o no exista', async () => {
    const { db } = await seeded();
    // Agosto está cerrado.
    const august = await createIncome(db, F, { date: '2026-08-15', desc: 'Bonus', accountId: 'us', amount: 100, cur: 'USD' });
    expect(await balance(db, F, 'us', '2026-08')).toBeCloseTo(2000 + 5800 - 1800 - 106 + 100, 8);
    expect((await patchIncome(db, F, 'seed-in-1', { amount: 6000 })).amount).toBe(6000);
    await deleteIncome(db, F, august.id);
    // Ni 2025 ni 2031 tienen mes.
    const early = await createIncome(db, F, { date: '2025-12-31', amount: 50, cur: 'USD', accountId: 'us' });
    const late = await createIncome(db, F, { date: '2031-01-01', amount: 70, cur: 'USD', accountId: 'us' });
    const state = await loadState(db, F);
    expect(Object.keys(state.months)).toEqual(['2026-08', '2026-09', '2026-10']);
    // El de antes ya cuenta en el saldo; el de después, todavía no.
    expect(await balance(db, F, 'us')).toBeCloseTo(13482 + 200 + 50, 8);
    expect((await patchIncome(db, F, late.id, { date: '2026-09-30' })).date).toBe('2026-09-30');
    expect(await balance(db, F, 'us')).toBeCloseTo(13482 + 200 + 50 + 70, 8);
    await deleteIncome(db, F, early.id);
    // Y cerrar o borrar un mes no los toca.
    await closeMonth(db, F, '2026-10');
    expect((await patchIncome(db, F, 'seed-in-3', { desc: 'October salary' })).desc).toBe('October salary');
  });
});

describe('metas', () => {
  it('una meta nueva va al final (sort = max + 1), en la moneda principal del usuario si no dice otra', async () => {
    const { db } = await seeded();
    expect(await createGoal(db, F, { name: 'Car' })).toMatchObject({ cur: 'DOP', sort: 3 });
    await patchGoal(db, F, 'emergency', { sort: 10 });
    expect(await createGoal(db, F, { name: 'House', cur: 'USD' })).toMatchObject({ cur: 'USD', sort: 11 });
    await updateSettings(db, F, { mainCurrency: 'TRY' });
    expect(await createGoal(db, F, { name: 'Istanbul flat', monthly: 10000, start: '2026-10', end: '2027-09' })).toMatchObject({
      cur: 'TRY',
      monthly: 10000,
    });
    // La moneda se puede cambiar después; el plan sigue en los mismos números.
    expect(await patchGoal(db, F, 'turkey', { cur: 'TRY' })).toEqual({ ...SEED_PLANNED_GOAL, cur: 'TRY' });
  });

  it('el nombre es único por usuario sin distinguir mayúsculas (también con tildes): 409', async () => {
    const { db } = await seeded();
    const taken = { ...conflict, message: 'There is already a goal with that name.' };
    await expect(createGoal(db, F, { name: 'emergency FUND' })).rejects.toMatchObject(taken);
    await createGoal(db, F, { id: 'viaje', name: 'Viaje a Turquía' });
    await expect(createGoal(db, F, { name: 'VIAJE A TURQUÍA' })).rejects.toMatchObject(taken);
    await expect(patchGoal(db, F, 'personal', { name: 'viaje a turquía' })).rejects.toMatchObject(taken);
    // Su propio nombre no es un conflicto: se puede reescribir o cambiarle las mayúsculas.
    expect((await patchGoal(db, F, 'viaje', { name: 'VIAJE A TURQUÍA' })).name).toBe('VIAJE A TURQUÍA');
    expect((await patchGoal(db, F, 'viaje', { name: 'VIAJE A TURQUÍA', sort: 9 })).sort).toBe(9);
    // Otro usuario sí puede tener una meta con ese mismo nombre.
    bystander = null;
    expect((await createGoal(db, E, { name: 'Viaje a Turquía' })).name).toBe('Viaje a Turquía');
  });

  it('plan: los tres campos juntos o ninguno, también si alguien llama al repositorio sin pasar por la validación', async () => {
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

  it('al editar, la regla del plan se aplica a la meta resultante', async () => {
    const { db } = await seeded();
    // Meta con plan: cambiar una sola parte vale…
    expect(await patchGoal(db, F, 'turkey', { end: '2028-01' })).toMatchObject({ monthly: 3000, start: '2026-08', end: '2028-01' });
    expect(await patchGoal(db, F, 'turkey', { monthly: 2500 })).toMatchObject({ monthly: 2500, start: '2026-08', end: '2028-01' });
    // …salvo que el resultado no cumpla.
    await expect(patchGoal(db, F, 'turkey', { start: '2028-02' })).rejects.toMatchObject({
      ...invalid,
      message: 'Invalid data: end: the start month cannot be after the end month',
    });
    await expect(patchGoal(db, F, 'turkey', { monthly: null })).rejects.toMatchObject(invalid);
    await expect(patchGoal(db, F, 'turkey', { start: null, end: null })).rejects.toMatchObject(invalid);
    // Meta sin plan: una sola parte no basta.
    await expect(patchGoal(db, F, 'personal', { monthly: 100 })).rejects.toMatchObject({
      ...invalid,
      message: 'Invalid data: monthly: monthly, start and end go together: set all three, or leave all three null',
    });
    await expect(patchGoal(db, F, 'personal', { end: '2027-01' })).rejects.toMatchObject(invalid);
    expect(await patchGoal(db, F, 'personal', { monthly: 100, start: '2026-10', end: '2027-01' })).toMatchObject({ monthly: 100 });
    // Quitar el plan: los tres a null.
    expect(await patchGoal(db, F, 'turkey', { monthly: null, start: null, end: null })).toMatchObject({
      monthly: null,
      start: null,
      end: null,
    });
    // Nombre, moneda y orden no tocan el plan.
    expect(await patchGoal(db, F, 'personal', { name: 'Rainy day', cur: 'DOP', sort: 5 })).toMatchObject({ name: 'Rainy day', cur: 'DOP', sort: 5, monthly: 100 });
    // Nada de lo rechazado se guardó.
    expect((await listGoals(db, F)).find((g) => g.id === 'emergency')).toEqual(DEFAULT_GOALS[0]);
  });

  it('no se borra una meta con aportes; sin ellos, sí', async () => {
    const { db } = await seeded();
    await expect(deleteGoal(db, F, 'turkey')).rejects.toMatchObject(conflict);
    for (const c of (await listContributions(db, F)).filter((c) => c.goalId === 'turkey')) await deleteContribution(db, F, c.id);
    await deleteGoal(db, F, 'turkey');
    expect((await listGoals(db, F)).map((g) => g.id)).toEqual(['emergency', 'personal']);
  });

  it('un aporte puede ir en cualquiera de las tres monedas', async () => {
    const { db } = await seeded();
    const created = await createContribution(db, F, { goalId: 'emergency', date: '2026-10-08', amount: 4200, cur: 'TRY' });
    expect(created).toMatchObject({ goalId: 'emergency', amount: 4200, cur: 'TRY' });
    expect((await patchContribution(db, F, created.id, { cur: 'DOP' })).cur).toBe('DOP');
  });
});

describe('resetAll', () => {
  it('borra todo; deja las cuentas y las metas iniciales y el mes indicado vacío; conserva los ajustes salvo la cuenta por defecto', async () => {
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

  it('sirve también para un usuario que nunca entró', async () => {
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

// El libro de Excel conserva el diseño original (dos monedas, dos cuentas). Cómo se vuelca al modelo de cuentas
// lo decide applyImportToState (shared/excel/data.ts), que tiene sus propias pruebas; aquí se comprueba lo que
// hace el repositorio con ello: de qué estado parte, que guarda exactamente el que sale y que es atómico.
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

  /** Hace que los ids nuevos salgan en serie, para poder repetir la misma importación con la función pura. */
  function serialIds(): () => string {
    let n = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `id-${++n}` as ReturnType<typeof crypto.randomUUID>);
    let m = 0;
    return () => `id-${++m}`;
  }

  /** Lo que la función pura deja sin fecha y pone el repositorio: el cierre de los meses del archivo y el alta de sus filas. */
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

  it('guarda exactamente el estado que calcula applyImportToState sobre el del usuario, con las fechas que la función pura no pone', async () => {
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

    // Y eso, en concreto, es: los meses que no vienen, intactos (ids y fechas de alta incluidos)…
    expect(after.months['2026-08']).toEqual(before.months['2026-08']);
    expect(after.months['2026-09']).toEqual(before.months['2026-09']);
    // …el mes del archivo sustituye por completo al que había, con todo en las dos cuentas del usuario…
    const oct = after.months['2026-10']!;
    expect(oct).toMatchObject({ closed: false, closedAt: null, budgets: { dr: 65000 }, rates: [] });
    expect(oct.fixed.map((f) => [f.name, f.amount, f.cur, f.paid, f.accountId, f.sort])).toEqual([
      ['Luz', 1500, 'DOP', true, 'dr', 0],
      ['Claude', 106, 'USD', false, 'us', 1],
    ]);
    expect(oct.transfers.map((t) => [t.fromAccountId, t.toAccountId, t.amount, t.rate])).toEqual([['us', 'dr', 1000, 59]]);
    // Lo que no es de las listas (categoría, método) se guarda tal cual.
    expect(oct.tx.map((t) => [t.date, t.desc, t.cat, t.method, t.amount, t.cur, t.accountId, t.source, t.createdAt])).toEqual([
      ['2026-10-02', 'Café', 'Food', 'Debit card', 250, 'DOP', 'dr', 'import', NOW.toISOString()],
      ['2026-10-03', 'Libro', 'Otra', 'Efectivo', 20, 'USD', 'us', 'import', NOW.toISOString()],
    ]);
    // …el mes nuevo se crea, cerrado en el momento de importar…
    expect(after.months['2026-11']).toMatchObject({ closed: true, closedAt: NOW.toISOString() });
    // …el ingreso del libro es el total del mes: a octubre, que ya tenía 5,800 USD, solo le faltan 200…
    expect(after.incomes.filter((i) => i.desc === IMPORTED_INCOME).map((i) => [i.date, i.accountId, i.amount, i.cur])).toEqual([
      ['2026-10-01', 'us', 200, 'USD'],
      ['2026-11-01', 'us', 6000, 'USD'],
    ]);
    // …y los saldos de las dos cuentas al final del último mes importado son los del libro.
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

  it('no toca los ajustes del usuario: ni sus monedas, ni su cuenta por defecto, ni su idioma, ni sus colores', async () => {
    const { db, sqlite } = await seeded();
    const theme = { accent: '#112233', header: '#000000', background: '#ffffff' };
    await updateSettings(db, F, { language: 'tr', theme, mainCurrency: 'TRY', secondCurrency: 'USD', defaultAccountId: 'us' });
    const settings = () => sqlite.sqlite.prepare('SELECT key, value FROM settings WHERE user_id = ? ORDER BY key').all(F).map((r) => ({ ...r }));
    const before = settings();
    await applyImport(db, F, { ...empty, months: [month('2026-10', false)] });
    expect(settings()).toEqual(before);
    expect(await getSettings(db, F)).toEqual({ theme, language: 'tr', mainCurrency: 'TRY', secondCurrency: 'USD', defaultAccountId: 'us' });
  });

  it('respeta closed: un mes que ya estaba cerrado conserva su fecha de cierre; si llega abierto, se reabre', async () => {
    const { db } = await arrived();
    await applyImport(db, F, { ...empty, months: [month('2026-08', true), month('2026-09', false)] }, NOW);
    const state = await loadState(db, F);
    expect(state.months['2026-08']).toMatchObject({ closed: true, closedAt: NOW.toISOString() });
    expect(state.months['2026-09']).toMatchObject({ closed: false, closedAt: null });
    // El mes que ya tenía y no viene en el archivo sigue ahí.
    expect(Object.keys(state.months)).toEqual(['2026-08', '2026-09', '2026-10']);

    // Reimportar un mes ya cerrado conserva su fecha de cierre y no duplica nada.
    await applyImport(db, F, { ...empty, months: [month('2026-08', true)] }, new Date('2027-01-01T00:00:00.000Z'));
    const again = (await getMonth(db, F, '2026-08'))!;
    expect(again.closedAt).toBe(NOW.toISOString());
    expect([again.fixed.length, again.transfers.length, again.tx.length]).toEqual([2, 1, 2]);
    expect((await listIncomes(db, F)).filter((i) => i.date === '2026-08-01')).toHaveLength(1);
    await applyImport(db, F, { ...empty, months: [month('2026-08', false)] });
    expect(await getMonth(db, F, '2026-08')).toMatchObject({ closed: false, closedAt: null });
  });

  it('a quien nunca entró se le preparan antes sus cuentas y metas iniciales: el libro cae en ellas', async () => {
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
    // La meta del libro es la inicial (sin distinguir mayúsculas), no otra nueva.
    expect(state.goals).toEqual([...DEFAULT_GOALS]);
    expect(state.contribs.map((c) => c.goalId)).toEqual(['emergency']);
    // Y abrir la app después no añade nada: ya está marcado y tiene un mes.
    expect(await openState(db, F, '2027-01')).toEqual(state);
  });

  it('contribs: [] borra los aportes; contribs: null no los toca', async () => {
    const { db, sqlite } = await seeded();
    await applyImport(db, F, empty);
    expect(count(sqlite, 'contributions', F)).toBe(8);
    await applyImport(db, F, { ...empty, contribs: [] });
    expect(count(sqlite, 'contributions', F)).toBe(0);
    expect(count(sqlite, 'contributions', E)).toBe(8);
  });

  it('reparte los INSERT para no pasar de 100 parámetros por sentencia, y conserva el orden del archivo', async () => {
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
    // Las dos iniciales más las 30 del archivo.
    expect(count(sqlite, 'goals')).toBe(32);
    const m = (await getMonth(db, F, '2026-10'))!;
    expect(m.tx.map((t) => t.desc)).toEqual(Array.from({ length: 250 }, (_, i) => `Gasto ${i}`));
    expect(m.transfers.map((t) => t.amount)).toEqual(Array.from({ length: 50 }, (_, i) => 100 + i));
    expect(m.fixed.map((f) => f.sort)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect((await listGoals(db, F)).slice(2).map((g) => g.name)).toEqual(Array.from({ length: 30 }, (_, i) => `Meta ${i}`));
  });

  it('muchos meses, cuentas, ingresos y tasas: replaceAll también reparte todas sus tablas', async () => {
    const { db, sqlite } = makeEnv();
    const keys = Array.from({ length: 150 }, (_, i) => `${2010 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
    const state = seedState();
    state.accounts = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, name: `Cuenta ${i}`, currency: 'DOP' as const, opening: i, hidden: false, sort: i }));
    state.defaultAccountId = 'a0';
    state.incomes = Array.from({ length: 80 }, (_, i) => ({ id: `i${i}`, date: `${keys[i]!}-01`, desc: '', accountId: `a${i % 40}`, amount: 1, cur: 'USD' as const, budget: i % 2 === 0 }));
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
    // Una importación encima reescribe todo eso otra vez.
    await applyImport(db, F, { ...empty, months: [month('2022-06', true)] });
    expect(count(sqlite, 'months', F)).toBe(150);
    expect(count(sqlite, 'accounts', F)).toBe(41);
  });

  it('es atómico: si algo falla a mitad no cambia nada', async () => {
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

  it('un archivo sin nada que aplicar deja todo igual', async () => {
    const { db } = await seeded();
    const before = await loadState(db, F);
    expect(await applyImport(db, F, empty)).toEqual({ months: [], contributions: 0 });
    expect(await loadState(db, F)).toEqual(before);
  });
});

describe('errores del repositorio', () => {
  it('lanza ApiError con el código del contrato y el mensaje en inglés', async () => {
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
