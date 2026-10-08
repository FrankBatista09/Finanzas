// Cálculos puros sobre AppState. Es el `renderVals()` del prototipo sin formato ni UI:
// devuelven números; el formato (f2/f0) y los colores los pone quien los muestre.

import { DEFAULT_RATE } from './constants';
import { monthOf, monthSpan } from './month';
import type { AppState, Contribution, Currency, Goal, MonthKey, Transfer } from './types';

export function sortedKeys(state: AppState): MonthKey[] {
  return Object.keys(state.months).sort();
}

/** Mes "en curso": el último mes abierto; si todos están cerrados, el último; null si no hay meses. */
export function currentKey(state: AppState): MonthKey | null {
  const keys = sortedKeys(state);
  const open = keys.filter((k) => !state.months[k]!.closed);
  return open[open.length - 1] ?? keys[keys.length - 1] ?? null;
}

/** Promedio ponderado Σ(usd × tasa) / Σ(usd); null si no hay envíos con USD > 0. */
export function weightedRate(transfers: readonly Pick<Transfer, 'usd' | 'rate'>[]): number | null {
  const usd = transfers.reduce((a, t) => a + (t.usd || 0), 0);
  if (!(usd > 0)) return null;
  const rate = transfers.reduce((a, t) => a + (t.usd || 0) * (t.rate || 0), 0) / usd;
  return rate > 0 ? rate : null;
}

/**
 * Tasa del mes: promedio ponderado de sus envíos. Si no tiene envíos, la del mes anterior más
 * reciente que sí tenga; si ninguno tiene, la tasa por defecto. Acepta claves sin mes registrado
 * (p. ej. un aporte con fecha de un mes que no existe): usa el mes registrado anterior más cercano.
 */
export function rateOf(state: AppState, key: MonthKey): number {
  const keys = sortedKeys(state);
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i]!;
    if (k > key) continue;
    const r = weightedRate(state.months[k]!.transfers);
    if (r !== null) return r;
  }
  return state.defaultRate > 0 ? state.defaultRate : DEFAULT_RATE;
}

export function toDOP(amount: number, cur: Currency, rate: number): number {
  return cur === 'USD' ? (amount || 0) * rate : amount || 0;
}

/** Aporte expresado en USD (los aportes en DOP se convierten con la tasa del mes de su fecha). */
export function contribUSD(state: AppState, c: Pick<Contribution, 'amount' | 'cur' | 'date'>): number {
  return c.cur === 'USD' ? c.amount || 0 : (c.amount || 0) / rateOf(state, monthOf(c.date));
}

/** Aporte expresado en DOP, a la tasa del mes de su fecha. */
export function contribDOP(state: AppState, c: Pick<Contribution, 'amount' | 'cur' | 'date'>): number {
  return c.cur === 'DOP' ? c.amount || 0 : (c.amount || 0) * rateOf(state, monthOf(c.date));
}

/** Total ahorrado (USD) con aportes fechados en ese mes. */
export function savedInMonth(state: AppState, key: MonthKey): number {
  return state.contribs.filter((c) => monthOf(c.date) === key).reduce((a, c) => a + contribUSD(state, c), 0);
}

export function totalSavedUSD(state: AppState): number {
  return state.contribs.reduce((a, c) => a + contribUSD(state, c), 0);
}

export interface CategorySum {
  name: string;
  /** DOP */
  value: number;
  /** true solo para la fila "Gastos fijos". */
  fixed: boolean;
}

export const FIXED_CATEGORY = 'Gastos fijos';

export interface MonthCalc {
  key: MonthKey;
  closed: boolean;
  rate: number;

  /** Σ DOP de todos los fijos. */
  fixedAll: number;
  /** Σ DOP de los fijos pagados. */
  fixedPaid: number;
  /** Σ DOP de los fijos no pagados. */
  pending: number;
  paidCount: number;
  fixedCount: number;

  /** Σ DOP de las transacciones. */
  varSpent: number;
  txCount: number;

  /** fijosPagados + transacciones */
  used: number;
  usedUSD: number;
  budget: number;
  /** presupuesto − usado */
  avail: number;
  /** disponible − pendientes */
  after: number;
  /** max(0, after): el segmento "Libre" de la dona. */
  free: number;
  /** usado / presupuesto × 100 (0 si no hay presupuesto). */
  pctUsed: number;

  incomeUSD: number;
  incomeDOP: number;
  /** ingreso del mes (DOP) − usado */
  incomeLeft: number;

  /** Ahorrado en el mes (aportes con fecha en este mes). */
  savedUSD: number;
  savedDOP: number;

  /** cuentaUSA × tasa + cuentaRD */
  totalDOP: number;
  /** cuentaUSA + cuentaRD / tasa */
  totalUSD: number;

  /** "Gastos fijos" (pagados) + cada categoría con gasto, de mayor a menor. Solo valores > 0. */
  categories: CategorySum[];
  /** Mayor valor de `categories` (mínimo 1), para escalar las barras. */
  catMax: number;
}

export function monthCalc(state: AppState, key: MonthKey): MonthCalc {
  const m = state.months[key];
  if (!m) throw new Error(`Mes no encontrado: ${key}`);
  const rate = rateOf(state, key);

  let fixedAll = 0;
  let fixedPaid = 0;
  let paidCount = 0;
  for (const f of m.fixed) {
    const dop = toDOP(f.amount, f.cur, rate);
    fixedAll += dop;
    if (f.paid) {
      fixedPaid += dop;
      paidCount++;
    }
  }
  const pending = fixedAll - fixedPaid;

  let varSpent = 0;
  const byCat = new Map<string, number>();
  for (const t of m.tx) {
    const dop = toDOP(t.amount, t.cur, rate);
    varSpent += dop;
    byCat.set(t.cat, (byCat.get(t.cat) ?? 0) + dop);
  }

  const used = fixedPaid + varSpent;
  const budget = m.budget || 0;
  const avail = budget - used;
  const after = avail - pending;
  const incomeUSD = m.incomeUSD || 0;
  const incomeDOP = incomeUSD * rate;
  const savedUSD = savedInMonth(state, key);

  const catSums: CategorySum[] = [...byCat]
    .map(([name, value]) => ({ name, value, fixed: false }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
  const categories = [{ name: FIXED_CATEGORY, value: fixedPaid, fixed: true }, ...catSums].filter((c) => c.value > 0);

  return {
    key,
    closed: m.closed,
    rate,
    fixedAll,
    fixedPaid,
    pending,
    paidCount,
    fixedCount: m.fixed.length,
    varSpent,
    txCount: m.tx.length,
    used,
    usedUSD: used / rate,
    budget,
    avail,
    after,
    free: Math.max(0, after),
    pctUsed: budget ? (used / budget) * 100 : 0,
    incomeUSD,
    incomeDOP,
    incomeLeft: incomeDOP - used,
    savedUSD,
    savedDOP: savedUSD * rate,
    totalDOP: (m.accounts.usd || 0) * rate + (m.accounts.dop || 0),
    totalUSD: (m.accounts.usd || 0) + (m.accounts.dop || 0) / rate,
    categories,
    catMax: Math.max(1, ...categories.map((c) => c.value)),
  };
}

// ── Dona de presupuesto ──────────────────────────────────────────────────────

export const DONUT = { size: 168, r: 64, stroke: 20 } as const;

export interface DonutSegment {
  /** stroke-dasharray: "<largo> <circunferencia>" */
  dash: string;
  /** stroke-dashoffset */
  offset: number;
}

/**
 * Segmentos de la dona, en el orden en que se acumulan: fijos pagados, transacciones, fijos pendientes.
 * Escala = max(presupuesto, usado + pendientes): si se pasa del presupuesto, la dona completa es el total.
 */
export function donut(
  c: Pick<MonthCalc, 'budget' | 'used' | 'pending' | 'fixedPaid' | 'varSpent'>,
): { fixed: DonutSegment; variable: DonutSegment; pending: DonutSegment } {
  const circ = 2 * Math.PI * DONUT.r;
  const scale = Math.max(c.budget, c.used + c.pending, 1);
  let acc = 0;
  const seg = (v: number): DonutSegment => {
    const len = (Math.max(0, v) / scale) * circ;
    const s = { dash: `${len} ${circ}`, offset: -acc };
    acc += len;
    return s;
  };
  return { fixed: seg(c.fixedPaid), variable: seg(c.varSpent), pending: seg(c.pending) };
}

// ── Ahorros ──────────────────────────────────────────────────────────────────

export interface GoalTarget {
  monthlyUSD: number;
  /** meses del plan × aporte mensual */
  targetUSD: number;
  /** 0..100 */
  pct: number;
  end: MonthKey;
  /** Aportes que faltan hasta `end` (mínimo 1; no cuenta el mes en curso si ya se aportó). */
  left: number;
  /** USD por mes necesarios para llegar. */
  needPerMonth: number;
}

export interface GoalProgress {
  id: string;
  name: string;
  savedUSD: number;
  /** A la tasa del mes en curso. */
  savedDOP: number;
  contribCount: number;
  /** null = meta de aportes variables. */
  target: GoalTarget | null;
}

export function goalProgress(state: AppState, goal: Goal): GoalProgress {
  const cur = currentKey(state);
  const mine = state.contribs.filter((c) => c.goalId === goal.id);
  const savedUSD = mine.reduce((a, c) => a + contribUSD(state, c), 0);
  const base = {
    id: goal.id,
    name: goal.name,
    savedUSD,
    savedDOP: savedUSD * (cur ? rateOf(state, cur) : state.defaultRate || DEFAULT_RATE),
    contribCount: mine.length,
  };
  if (!goal.monthlyUSD || !goal.start || !goal.end) return { ...base, target: null };

  const targetUSD = monthSpan(goal.start, goal.end) * goal.monthlyUSD;
  const from = cur ?? goal.start;
  const doneThis = mine.some((c) => monthOf(c.date) === from);
  const left = Math.max(1, monthSpan(from, goal.end) - (doneThis ? 1 : 0));
  return {
    ...base,
    target: {
      monthlyUSD: goal.monthlyUSD,
      targetUSD,
      pct: targetUSD > 0 ? Math.min(100, (savedUSD / targetUSD) * 100) : 0,
      end: goal.end,
      left,
      needPerMonth: Math.max(0, targetUSD - savedUSD) / left,
    },
  };
}

export function goalsProgress(state: AppState): GoalProgress[] {
  return [...state.goals].sort((a, b) => a.sort - b.sort).map((g) => goalProgress(state, g));
}

export interface IncomeRow {
  key: MonthKey;
  incomeUSD: number;
  rate: number;
  incomeDOP: number;
  savedUSD: number;
  /** ahorrado / ingreso × 100; null si no hay ingreso. */
  pct: number | null;
}

export function incomeRows(state: AppState): IncomeRow[] {
  return sortedKeys(state).map((key) => {
    const rate = rateOf(state, key);
    const incomeUSD = state.months[key]!.incomeUSD || 0;
    const savedUSD = savedInMonth(state, key);
    return { key, incomeUSD, rate, incomeDOP: incomeUSD * rate, savedUSD, pct: incomeUSD ? (savedUSD / incomeUSD) * 100 : null };
  });
}
