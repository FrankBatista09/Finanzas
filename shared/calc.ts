// Cálculos puros sobre AppState: tasas, saldos de cuentas, el mes, las metas y los ingresos.
// Devuelven números; el formato (f2/f0), los textos y los colores los pone quien los muestre.
//
// Todo importe se guarda en su moneda original. Aquí se convierte, siempre con las tasas de un mes concreto:
//  · lo que pertenece a un mes (gastos, transacciones, envíos, presupuesto) usa las tasas de ese mes;
//  · un ingreso o un aporte usa las del mes de su fecha;
//  · un saldo se expresa en otra moneda con las tasas del mes que se está mirando.

import { DEFAULT_USD_RATES } from './constants';
import { monthOf, monthSpan } from './month';
import type { Account, AppState, Contribution, Currency, Goal, Income, Month, MonthKey, Transfer } from './types';

export function sortedKeys(state: AppState): MonthKey[] {
  return Object.keys(state.months).sort();
}

/** Mes "en curso": el último mes abierto; si todos están cerrados, el último; null si no hay meses. */
export function currentKey(state: AppState): MonthKey | null {
  const keys = sortedKeys(state);
  const open = keys.filter((k) => !state.months[k]!.closed);
  return open[open.length - 1] ?? keys[keys.length - 1] ?? null;
}

// ── Cuentas ──────────────────────────────────────────────────────────────────

export function accountsById(state: AppState): Map<string, Account> {
  return new Map(state.accounts.map((a) => [a.id, a]));
}

/** Las cuentas que se muestran (no ocultas), en su orden. */
export function visibleAccounts(state: AppState): Account[] {
  return state.accounts.filter((a) => !a.hidden).sort((a, b) => a.sort - b.sort);
}

/**
 * Cuenta de la que sale un gasto cuando no se indica otra: la elegida en Settings si sigue visible; si no,
 * la primera visible en la moneda principal; si no, la primera visible; si no hay visibles, la primera que haya.
 */
export function defaultAccount(state: AppState): Account | null {
  const visible = visibleAccounts(state);
  return (
    visible.find((a) => a.id === state.defaultAccountId) ??
    visible.find((a) => a.currency === state.mainCurrency) ??
    visible[0] ??
    [...state.accounts].sort((a, b) => a.sort - b.sort)[0] ??
    null
  );
}

// ── Tasas ────────────────────────────────────────────────────────────────────

/**
 * De dónde salió una tasa, de más a menos fiable:
 *  same      misma moneda (1)
 *  month     escrita a mano para ese mes (o la inversa de la escrita)
 *  transfers promedio ponderado de los envíos de ese mes entre esas dos monedas
 *  cross     cruzando por la tercera moneda con tasas de ese mes
 *  previous  cualquiera de las anteriores, pero de un mes anterior (el más reciente que la tenga)
 *  default   valor fijo de respaldo: nadie la ha escrito nunca. La interfaz debe avisarlo.
 */
export type RateSource = 'same' | 'month' | 'transfers' | 'cross' | 'previous' | 'default';

export interface RateInfo {
  /** 1 `from` = `rate` `to`. */
  rate: number;
  source: RateSource;
  /** Mes del que salió la tasa; null para 'same' y 'default'. */
  monthKey: MonthKey | null;
}

type Direct = { rate: number; source: 'month' | 'transfers' } | null;

/** Tasa que el propio mes da para un par, sin cruzar monedas: la escrita (o su inversa) o la de sus envíos. */
function directRate(month: Month, accounts: Map<string, Account>, from: Currency, to: Currency): Direct {
  for (const r of month.rates) {
    if (!(r.rate > 0)) continue;
    if (r.from === from && r.to === to) return { rate: r.rate, source: 'month' };
    if (r.from === to && r.to === from) return { rate: 1 / r.rate, source: 'month' };
  }
  // Envíos del mes entre las dos monedas, en cualquier sentido: lo que salió en `from` frente a lo que entró en `to`.
  let sumFrom = 0;
  let sumTo = 0;
  for (const t of month.transfers) {
    const a = accounts.get(t.fromAccountId)?.currency;
    const b = accounts.get(t.toAccountId)?.currency;
    if (!(t.amount > 0) || !(t.rate > 0)) continue;
    if (a === from && b === to) {
      sumFrom += t.amount;
      sumTo += t.amount * t.rate;
    } else if (a === to && b === from) {
      sumTo += t.amount;
      sumFrom += t.amount * t.rate;
    }
  }
  return sumFrom > 0 && sumTo > 0 ? { rate: sumTo / sumFrom, source: 'transfers' } : null;
}

const ALL: readonly Currency[] = ['DOP', 'USD', 'TRY'];

function monthRate(month: Month, accounts: Map<string, Account>, from: Currency, to: Currency): Direct | { rate: number; source: 'cross' } {
  const direct = directRate(month, accounts, from, to);
  if (direct) return direct;
  for (const via of ALL) {
    if (via === from || via === to) continue;
    const a = directRate(month, accounts, from, via);
    const b = a && directRate(month, accounts, via, to);
    if (a && b) return { rate: a.rate * b.rate, source: 'cross' };
  }
  return null;
}

// Las tasas se piden una vez por fila y por columna; se memorizan por objeto de estado (el estado no se muta:
// cada cambio produce uno nuevo, así que la memoria nunca queda desfasada).
const rateMemo = new WeakMap<AppState, Map<string, RateInfo>>();

/**
 * Tasa para convertir `from` → `to` con las cifras del mes `key`. Nunca falla: si ni ese mes ni ninguno anterior
 * la tienen, devuelve el valor de respaldo con source 'default'. Acepta claves sin mes registrado (un ingreso con
 * fecha de un mes que no existe): usa el mes registrado anterior más cercano.
 */
export function rateFor(state: AppState, key: MonthKey, from: Currency, to: Currency): RateInfo {
  if (from === to) return { rate: 1, source: 'same', monthKey: null };
  let memo = rateMemo.get(state);
  if (!memo) rateMemo.set(state, (memo = new Map()));
  const id = `${key}|${from}|${to}`;
  const hit = memo.get(id);
  if (hit) return hit;

  const accounts = accountsById(state);
  const keys = sortedKeys(state);
  let found: RateInfo | null = null;
  for (let i = keys.length - 1; i >= 0 && !found; i--) {
    const k = keys[i]!;
    if (k > key) continue;
    const r = monthRate(state.months[k]!, accounts, from, to);
    if (r) found = { rate: r.rate, source: k === key ? r.source : 'previous', monthKey: k };
  }
  if (!found) {
    const usd = { ...DEFAULT_USD_RATES, DOP: state.defaultRate > 0 ? state.defaultRate : DEFAULT_USD_RATES.DOP };
    found = { rate: usd[to] / usd[from], source: 'default', monthKey: null };
  }
  memo.set(id, found);
  return found;
}

/** `amount` de `from` expresado en `to`, con las tasas del mes `key`. */
export function convert(state: AppState, key: MonthKey, amount: number, from: Currency, to: Currency): number {
  return from === to ? amount || 0 : (amount || 0) * rateFor(state, key, from, to).rate;
}

/** Lo que entra a la cuenta de destino de un envío, en su moneda. */
export function transferReceived(t: Pick<Transfer, 'amount' | 'rate'>): number {
  return (t.amount || 0) * (t.rate || 0);
}

// ── Saldos ───────────────────────────────────────────────────────────────────

export interface AccountBalance {
  account: Account;
  /** Saldo en la moneda de la cuenta. */
  balance: number;
  /** El mismo saldo en la moneda principal y en la segunda, con las tasas del mes que se mira. */
  inMain: number;
  inSecond: number;
}

export interface Balances {
  /** Todas las cuentas (también las ocultas), en su orden. */
  accounts: AccountBalance[];
  /** Suma de las cuentas visibles: el "Total money". */
  totalMain: number;
  totalSecond: number;
}

/**
 * Saldo de cada cuenta al final del mes `asOf`: su saldo inicial más todo lo que la movió hasta ese mes incluido.
 *  + ingresos (por su fecha)          − transacciones pagadas desde ella
 *  + envíos que le entran             − gastos fijos marcados como pagados desde ella
 *                                     − envíos que salen de ella
 * Un movimiento en otra moneda entra o sale convertido con la tasa de su propio mes. Los aportes a metas no
 * mueven saldos (son un apartado). Un movimiento cuya cuenta ya no existe se ignora.
 */
export function balances(state: AppState, asOf: MonthKey): Balances {
  const byId = accountsById(state);
  const sum = new Map<string, number>(state.accounts.map((a) => [a.id, a.opening || 0]));
  const move = (accountId: string, key: MonthKey, amount: number, cur: Currency, sign: 1 | -1) => {
    const acc = byId.get(accountId);
    if (!acc) return;
    sum.set(acc.id, sum.get(acc.id)! + sign * convert(state, key, amount, cur, acc.currency));
  };

  for (const inc of state.incomes) {
    const k = monthOf(inc.date);
    if (k <= asOf) move(inc.accountId, k, inc.amount, inc.cur, 1);
  }
  for (const key of sortedKeys(state)) {
    if (key > asOf) break;
    const m = state.months[key]!;
    for (const t of m.tx) move(t.accountId, key, t.amount, t.cur, -1);
    for (const f of m.fixed) if (f.paid) move(f.accountId, key, f.amount, f.cur, -1);
    for (const t of m.transfers) {
      const from = byId.get(t.fromAccountId);
      const to = byId.get(t.toAccountId);
      if (from) sum.set(from.id, sum.get(from.id)! - (t.amount || 0));
      if (to) sum.set(to.id, sum.get(to.id)! + transferReceived(t));
    }
  }

  const accounts = [...state.accounts]
    .sort((a, b) => a.sort - b.sort)
    .map((account) => {
      const balance = sum.get(account.id)!;
      return {
        account,
        balance,
        inMain: convert(state, asOf, balance, account.currency, state.mainCurrency),
        inSecond: convert(state, asOf, balance, account.currency, state.secondCurrency),
      };
    });
  const visible = accounts.filter((a) => !a.account.hidden);
  return {
    accounts,
    totalMain: visible.reduce((a, b) => a + b.inMain, 0),
    totalSecond: visible.reduce((a, b) => a + b.inSecond, 0),
  };
}

/**
 * Saldo inicial que hay que guardar para que la cuenta muestre `desired` al final del mes `asOf`.
 * Es como se "corrige" un saldo a mano: los movimientos no se tocan, se ajusta el punto de partida.
 */
export function openingFor(state: AppState, accountId: string, asOf: MonthKey, desired: number): number {
  const row = balances(state, asOf).accounts.find((a) => a.account.id === accountId);
  return row ? row.account.opening + ((desired || 0) - row.balance) : desired || 0;
}

// ── El mes ───────────────────────────────────────────────────────────────────

export interface CategorySum {
  name: string;
  /** En la moneda principal. */
  value: number;
  /** true solo para la fila de gastos fijos. */
  fixed: boolean;
}

/** Nombre canónico de la fila de gastos fijos; en pantalla se traduce (shared/i18n.ts FIXED_CATEGORY_NAMES). */
export const FIXED_CATEGORY = 'Fixed expenses';

export interface BudgetPart {
  account: Account;
  /** Parte del presupuesto que sale de esta cuenta, en su moneda. */
  amount: number;
  inMain: number;
}

/** Todas las cifras son en la moneda principal (`main`) salvo las que terminan en Second. */
export interface MonthCalc {
  key: MonthKey;
  closed: boolean;
  main: Currency;
  second: Currency;
  /** 1 segunda = rate principal, con las tasas del mes: el "1 USD = 58.76 DOP" de la barra superior. */
  rate: RateInfo;

  /** Σ de todos los fijos. */
  fixedAll: number;
  /** Σ de los fijos pagados. */
  fixedPaid: number;
  /** Σ de los fijos no pagados. */
  pending: number;
  paidCount: number;
  fixedCount: number;

  /** Σ de las transacciones. */
  varSpent: number;
  txCount: number;

  /** fijosPagados + transacciones */
  used: number;
  usedSecond: number;
  /** Presupuesto del mes: Σ de las partes por cuenta. */
  budget: number;
  budgetSecond: number;
  /** Una fila por cuenta visible (y por cualquier cuenta oculta que tenga parte), en el orden de las cuentas. */
  budgetParts: BudgetPart[];
  /** presupuesto − usado */
  avail: number;
  /** disponible − pendientes */
  after: number;
  /** max(0, after): el segmento "Free" de la dona. */
  free: number;
  /** usado / presupuesto × 100 (0 si no hay presupuesto). */
  pctUsed: number;

  /** Σ de los ingresos con fecha en este mes. */
  income: number;
  /** ingreso − usado */
  incomeLeft: number;
  /** Σ de los aportes a metas con fecha en este mes. */
  saved: number;

  /** La fila de gastos fijos (pagados) + cada categoría con gasto, de mayor a menor. Solo valores > 0. */
  categories: CategorySum[];
  /** Mayor valor de `categories` (mínimo 1), para escalar las barras. */
  catMax: number;
}

/** Ingresos con fecha en ese mes, sumados en `to` con las tasas del propio mes. */
export function incomeInMonth(state: AppState, key: MonthKey, to: Currency = state.mainCurrency): number {
  return state.incomes
    .filter((i) => monthOf(i.date) === key)
    .reduce((a, i) => a + convert(state, key, i.amount, i.cur, to), 0);
}

/** Aportes a metas con fecha en ese mes, sumados en `to` con las tasas del propio mes. */
export function savedInMonth(state: AppState, key: MonthKey, to: Currency = state.mainCurrency): number {
  return state.contribs
    .filter((c) => monthOf(c.date) === key)
    .reduce((a, c) => a + convert(state, key, c.amount, c.cur, to), 0);
}

export function monthCalc(state: AppState, key: MonthKey): MonthCalc {
  const m = state.months[key];
  if (!m) throw new Error(`Month not found: ${key}`);
  const main = state.mainCurrency;
  const second = state.secondCurrency;
  const toMain = (amount: number, cur: Currency) => convert(state, key, amount, cur, main);

  let fixedAll = 0;
  let fixedPaid = 0;
  let paidCount = 0;
  for (const f of m.fixed) {
    const v = toMain(f.amount, f.cur);
    fixedAll += v;
    if (f.paid) {
      fixedPaid += v;
      paidCount++;
    }
  }
  const pending = fixedAll - fixedPaid;

  let varSpent = 0;
  const byCat = new Map<string, number>();
  for (const t of m.tx) {
    const v = toMain(t.amount, t.cur);
    varSpent += v;
    byCat.set(t.cat, (byCat.get(t.cat) ?? 0) + v);
  }

  const budgetParts: BudgetPart[] = [...state.accounts]
    .sort((a, b) => a.sort - b.sort)
    .filter((a) => !a.hidden || (m.budgets[a.id] ?? 0) !== 0)
    .map((account) => {
      const amount = m.budgets[account.id] ?? 0;
      return { account, amount, inMain: toMain(amount, account.currency) };
    });
  const budget = budgetParts.reduce((a, p) => a + p.inMain, 0);

  const used = fixedPaid + varSpent;
  const avail = budget - used;
  const after = avail - pending;
  const income = incomeInMonth(state, key);
  const rate = rateFor(state, key, second, main);

  const catSums: CategorySum[] = [...byCat]
    .map(([name, value]) => ({ name, value, fixed: false }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
  const categories = [{ name: FIXED_CATEGORY, value: fixedPaid, fixed: true }, ...catSums].filter((c) => c.value > 0);

  return {
    key,
    closed: m.closed,
    main,
    second,
    rate,
    fixedAll,
    fixedPaid,
    pending,
    paidCount,
    fixedCount: m.fixed.length,
    varSpent,
    txCount: m.tx.length,
    used,
    usedSecond: convert(state, key, used, main, second),
    budget,
    budgetSecond: convert(state, key, budget, main, second),
    budgetParts,
    avail,
    after,
    free: Math.max(0, after),
    pctUsed: budget ? (used / budget) * 100 : 0,
    income,
    incomeLeft: income - used,
    saved: savedInMonth(state, key),
    categories,
    catMax: Math.max(1, ...categories.map((c) => c.value)),
  };
}

// ── Donas ────────────────────────────────────────────────────────────────────

export const DONUT = { size: 168, r: 64, stroke: 20 } as const;

export interface DonutSegment {
  /** stroke-dasharray: "<largo> <circunferencia>" */
  dash: string;
  /** stroke-dashoffset */
  offset: number;
}

/**
 * Segmentos encadenados de una dona: cada valor ocupa su parte de `scale` (por defecto, la suma).
 * Los valores negativos o no finitos no ocupan nada.
 */
export function ring(values: readonly number[], scale?: number): DonutSegment[] {
  const circ = 2 * Math.PI * DONUT.r;
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = Math.max(scale ?? clean.reduce((a, v) => a + v, 0), 1);
  let acc = 0;
  return clean.map((v) => {
    const len = (v / total) * circ;
    const s = { dash: `${len} ${circ}`, offset: -acc };
    acc += len;
    return s;
  });
}

/**
 * Dona del presupuesto, en el orden en que se acumulan: fijos pagados, transacciones, fijos pendientes.
 * Escala = max(presupuesto, usado + pendientes): si se pasa del presupuesto, la dona completa es el total.
 */
export function donut(
  c: Pick<MonthCalc, 'budget' | 'used' | 'pending' | 'fixedPaid' | 'varSpent'>,
): { fixed: DonutSegment; variable: DonutSegment; pending: DonutSegment } {
  const [fixed, variable, pending] = ring([c.fixedPaid, c.varSpent, c.pending], Math.max(c.budget, c.used + c.pending, 1));
  return { fixed: fixed!, variable: variable!, pending: pending! };
}

// ── Ahorros ──────────────────────────────────────────────────────────────────

/** Aporte expresado en `to` (por defecto, la moneda de su meta se pasa aparte), con la tasa del mes de su fecha. */
export function contribIn(state: AppState, c: Pick<Contribution, 'amount' | 'cur' | 'date'>, to: Currency): number {
  return convert(state, monthOf(c.date), c.amount, c.cur, to);
}

export interface GoalTarget {
  /** Ahorro mensual planeado, en la moneda de la meta. */
  monthly: number;
  /** meses del plan × ahorro mensual */
  targetAmount: number;
  /** 0..100 */
  pct: number;
  end: MonthKey;
  /** Aportes que faltan hasta `end` (mínimo 1; no cuenta el mes en curso si ya se aportó). */
  left: number;
  /** Lo que hay que aportar por mes para llegar, en la moneda de la meta. */
  needPerMonth: number;
}

export interface GoalProgress {
  id: string;
  name: string;
  /** Moneda de la meta. `saved` y `target` van en ella. */
  cur: Currency;
  saved: number;
  /** Lo ahorrado en la moneda principal, a la tasa del mes en curso. */
  savedMain: number;
  contribCount: number;
  /** null = meta de aportes variables. */
  target: GoalTarget | null;
}

export function goalProgress(state: AppState, goal: Goal): GoalProgress {
  const cur = currentKey(state);
  const mine = state.contribs.filter((c) => c.goalId === goal.id);
  const saved = mine.reduce((a, c) => a + contribIn(state, c, goal.cur), 0);
  const base = {
    id: goal.id,
    name: goal.name,
    cur: goal.cur,
    saved,
    savedMain: cur ? convert(state, cur, saved, goal.cur, state.mainCurrency) : saved,
    contribCount: mine.length,
  };
  if (!goal.monthly || !goal.start || !goal.end) return { ...base, target: null };

  const targetAmount = monthSpan(goal.start, goal.end) * goal.monthly;
  const from = cur ?? goal.start;
  const doneThis = mine.some((c) => monthOf(c.date) === from);
  const left = Math.max(1, monthSpan(from, goal.end) - (doneThis ? 1 : 0));
  return {
    ...base,
    target: {
      monthly: goal.monthly,
      targetAmount,
      pct: targetAmount > 0 ? Math.min(100, (saved / targetAmount) * 100) : 0,
      end: goal.end,
      left,
      needPerMonth: Math.max(0, targetAmount - saved) / left,
    },
  };
}

export function goalsProgress(state: AppState): GoalProgress[] {
  return [...state.goals].sort((a, b) => a.sort - b.sort).map((g) => goalProgress(state, g));
}

/** Todo lo ahorrado en todas las metas, en la moneda principal, a la tasa del mes en curso. */
export function totalSaved(state: AppState): number {
  return goalsProgress(state).reduce((a, g) => a + g.savedMain, 0);
}

export interface IncomeRow {
  key: MonthKey;
  /** Ingresos del mes, en la moneda principal. */
  income: number;
  /** Aportes del mes, en la moneda principal. */
  saved: number;
  /** ahorrado / ingreso × 100; null si no hubo ingreso. */
  pct: number | null;
  /** 1 segunda = rate principal en ese mes. */
  rate: RateInfo;
}

/** Una fila por mes registrado: lo que entró, lo que se apartó y qué porcentaje es. */
export function incomeRows(state: AppState): IncomeRow[] {
  return sortedKeys(state).map((key) => {
    const income = incomeInMonth(state, key);
    const saved = savedInMonth(state, key);
    return {
      key,
      income,
      saved,
      pct: income ? (saved / income) * 100 : null,
      rate: rateFor(state, key, state.secondCurrency, state.mainCurrency),
    };
  });
}

/** Ingresos ordenados del más reciente al más antiguo (estable). */
export function sortedIncomes(state: AppState): Income[] {
  return [...state.incomes].sort((a, b) => b.date.localeCompare(a.date));
}
