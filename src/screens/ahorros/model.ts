// Textos de la hoja "Savings": lo que `renderVals()` del prototipo llamaba goalCards, incomeRows, contribRows y ct.
// Los números salen de shared/calc.ts; aquí solo se les da formato y se arma cada frase en el idioma que se pida
// (./strings). Sin React, para probarlo en Node.
//
// Cada meta va en su moneda; los ingresos y los aportes, en la suya. Lo que se ve convertido usa la tasa vigente
// en la fecha de cada fila, y cada cifra convertida lleva una nota (RateNote) cuando esa tasa no es una escrita
// en el mes de la fila.

import {
  contribIn,
  currentKey,
  defaultAccount,
  goalsProgress,
  incomeIn,
  incomeInMonth,
  incomeRows,
  isMoneyIncome,
  ownRate,
  moneyAccounts,
  rateFor,
  sortedIncomes,
  visibleAccounts,
} from '../../../shared/calc';
import type { GoalProgress, IncomeRow } from '../../../shared/calc';
import { GOLD, isGold, MAX_LEN } from '../../../shared/constants';
import { f0, f2, fGrams, fPct } from '../../../shared/format';
import { firstDay, isISODate, monthOf } from '../../../shared/month';
import type { AccountCurrency, AppState, Currency, Goal, ISODate, Language, MonthKey } from '../../../shared/types';
import { createI18n, translator } from '../../i18n';
import type { ContributionInput } from '../../store';
import { AHORROS } from './strings';

// ── Tasas ────────────────────────────────────────────────────────────────────

/** Lo que hay que decir de la tasa con la que se convirtió una cifra. */
export interface RateNote {
  /** De dónde salió la tasa, en palabras (useI18n().rateHint); '' si es la escrita para ese mes o no hubo conversión. */
  hint: string;
  /** La tasa es el valor fijo de respaldo: nadie la ha escrito. La cifra se destaca. */
  fallback: boolean;
}

export const NO_NOTE: RateNote = { hint: '', fallback: false };

/**
 * La tasa automática de una fila (moneda principal por 1 de `cur`, la vigente en su fecha), que es la que se
 * ve atenuada junto al control "Rate"; null si la fila no tiene control: su moneda es la principal o son gramos.
 */
export function autoRate(state: AppState, date: ISODate, cur: AccountCurrency): number | null {
  if (isGold(cur) || cur === state.mainCurrency) return null;
  return rateFor(state, monthOf(date), cur, state.mainCurrency, date).rate;
}

/** La nota de la conversión `from` → `to` con las tasas del mes `key`: la última del mes o, con `date`, la vigente ese día. */
export function rateNote(state: AppState, key: MonthKey, from: Currency, to: Currency, lang: Language, date?: ISODate): RateNote {
  const info = rateFor(state, key, from, to, date);
  if (info.source === 'same' || info.source === 'month') return NO_NOTE;
  return { hint: createI18n(lang).rateHint(info, from, to), fallback: info.source === 'default' };
}

// ── Tarjetas de metas ────────────────────────────────────────────────────────

export interface GoalTargetView {
  /** Porcentaje sin redondear (0..100): el ancho de la barra. */
  value: number;
  /** '20% of 45,000 USD' */
  progress: string;
  /** 'Target: October 2027' */
  deadline: string;
}

export interface GoalCardView {
  id: string;
  name: string;
  /** Moneda de la meta: la de `saved` y la de las cifras de las frases. */
  cur: Currency;
  /** 'Variable contributions' o '3,000 USD / month'. */
  kind: string;
  /** Ahorrado en la moneda de la meta, con dos decimales. */
  saved: string;
  /**
   * Su equivalente en `approxCur`, sin decimales (la línea "≈"); null si esa moneda es la de la propia meta: la
   * línea no se pinta.
   */
  savedApprox: string | null;
  /** La moneda de la línea "≈": la que eligió la meta o, si no eligió, la principal del usuario. */
  approxCur: Currency;
  /** La tasa del mes en curso con la que se calculó `savedApprox`. */
  approxNote: RateNote;
  /** Con objetivo: cuánto falta (o que ya se llegó, o que el mes objetivo pasó). Sin objetivo: cuántos aportes lleva. */
  plan: string;
  /** null = meta de aportes variables: sin barra de progreso. */
  target: GoalTargetView | null;
}

/**
 * Un monto sin decimales, como en el diseño ('3,000'). Si redondea a menos de 1 se dejan los centavos,
 * para no escribir "0 USD" de algo que no es cero.
 */
export function wholeAmount(n: number): string {
  return Math.round(n) >= 1 ? f0(n) : f2(n);
}

// Dentro de una frase ("Meta: octubre 2027") el español escribe el mes en minúscula; el inglés y el turco, no.
const LOWERCASE_MONTH: Record<Language, boolean> = { en: false, es: true, tr: false };

/** El mes tal como va dentro de una frase en ese idioma. */
export function monthInSentence(key: MonthKey, lang: Language): string {
  const text = createI18n(lang).label(key);
  return LOWERCASE_MONTH[lang] ? text.toLowerCase() : text;
}

/**
 * `current` es el mes en curso (shared/calc currentKey), el mismo desde el que goalProgress cuenta los aportes que
 * faltan: con él se sabe si el mes objetivo ya quedó atrás. `approxNote` es la nota de la tasa con la que se pasó
 * lo ahorrado a la moneda de la línea "≈" (GoalProgress.approxCur).
 */
export function goalCard(g: GoalProgress, lang: Language, current: MonthKey | null = null, approxNote: RateNote = NO_NOTE): GoalCardView {
  const s = translator(AHORROS, lang);
  const currency = g.cur;
  const same = g.cur === g.approxCur;
  const base = {
    id: g.id,
    name: g.name,
    cur: g.cur,
    saved: f2(g.saved),
    savedApprox: same ? null : f0(g.savedApprox),
    approxCur: g.approxCur,
    approxNote: same ? NO_NOTE : approxNote,
  };
  const t = g.target;
  if (!t) {
    return { ...base, kind: s('kindVariable'), plan: s('recorded', { count: g.contribCount }), target: null };
  }

  // El prototipo siempre escribía "N aportes · X USD por mes para llegar": con la meta cumplida o el mes objetivo
  // ya pasado eso daba un "0 USD por mes" o una cuota que no significaba nada.
  const missing = t.targetAmount - g.saved;
  let plan: string;
  // Se compara en centavos: 833.33… × 12 no da 10,000 exactos.
  if (Math.round(missing * 100) <= 0) plan = s('reached');
  else if (current !== null && t.end < current) plan = s('passed', { amount: f2(missing), currency });
  else plan = s('left', { count: t.left, amount: wholeAmount(t.needPerMonth), currency });

  return {
    ...base,
    kind: s('kindMonthly', { amount: wholeAmount(t.monthly), currency }),
    plan,
    target: {
      value: t.pct,
      progress: s('progress', { pct: f0(t.pct), target: f0(t.targetAmount), currency }),
      deadline: s('deadline', { month: monthInSentence(t.end, lang) }),
    },
  };
}

export function goalCards(state: AppState, lang: Language): GoalCardView[] {
  const current = currentKey(state);
  // goalProgress pasa lo ahorrado a la moneda "≈" con la última tasa del mes en curso: la nota es la de esa tasa.
  return goalsProgress(state).map((g) => goalCard(g, lang, current, current ? rateNote(state, current, g.cur, g.approxCur, lang) : NO_NOTE));
}

// ── Ingresos por mes ─────────────────────────────────────────────────────────

export interface IncomeRowView {
  key: MonthKey;
  /** 'October 2026' */
  label: string;
  /** Lo que entró en el mes, en la moneda principal. */
  income: string;
  /** Lo que se apartó en el mes, en la moneda principal. */
  saved: string;
  pct: string;
  /** Algún ingreso del mes se convirtió con la tasa fija de respaldo. */
  incomeFallback: boolean;
  /** Algún aporte del mes se convirtió con la tasa fija de respaldo. */
  savedFallback: boolean;
}

/** '% saved': un decimal, o una raya cuando el mes no tiene ingreso. */
export function pctText(pct: number | null): string {
  return pct === null || !Number.isFinite(pct) ? '—' : fPct(pct);
}

type Dated = { date: ISODate; cur: Currency };

/** ¿Alguna de esas filas con fecha en ese mes pasó a la moneda principal con la tasa de respaldo? */
function usesFallback(state: AppState, key: MonthKey, rows: readonly Dated[]): boolean {
  return rows.some((r) => monthOf(r.date) === key && rateFor(state, key, r.cur, state.mainCurrency, r.date).source === 'default');
}

export function incomeRowView(r: IncomeRow, lang: Language, incomeFallback = false, savedFallback = false): IncomeRowView {
  return {
    key: r.key,
    label: createI18n(lang).label(r.key),
    income: f2(r.income),
    saved: f2(r.saved),
    pct: pctText(r.pct),
    incomeFallback,
    savedFallback,
  };
}

export function incomeRowViews(state: AppState, lang: Language): IncomeRowView[] {
  return incomeRows(state).map((r) => incomeRowView(r, lang, usesFallback(state, r.key, state.incomes.filter(isMoneyIncome)), usesFallback(state, r.key, state.contribs)));
}

// ── Ingresos, uno por uno ────────────────────────────────────────────────────

export interface IncomeItemView {
  id: string;
  date: ISODate;
  desc: string;
  accountId: string;
  /** El valor de la celda editable. */
  amount: number;
  /** El mismo monto con formato, para el nombre del botón de eliminar. */
  amountText: string;
  /** XAU en un ingreso a una cuenta de oro: el monto son gramos, sin moneda que elegir ni presupuesto que subir. */
  cur: AccountCurrency;
  /** true: además de entrar a la cuenta, sube el presupuesto del mes de su fecha (la casilla "Adds to budget"). */
  budget: boolean;
  /** Tasa propia (null = la del mes) y la automática que se mostraría; `rateAuto` null = sin control de tasa. */
  rate: number | null;
  rateAuto: number | null;
  /** La casilla "Recurring". */
  recurring: boolean;
  /** En la moneda principal, con su tasa propia o la vigente en su fecha. Una raya si son gramos de oro: no son dinero cobrado. */
  main: string;
  mainNote: RateNote;
}

/**
 * Del más reciente al más antiguo; los de un mismo día quedan en el orden en que se registraron. Con `monthKey`,
 * solo los que tienen fecha en ese mes (la tarjeta "Income" de la hoja del mes) y solo los de dinero: los gramos
 * que entran a una cuenta de oro se ven en Savings, no en la hoja del mes.
 */
export function incomeItems(state: AppState, lang: Language, monthKey?: MonthKey, withGold = false): IncomeItemView[] {
  const main = state.mainCurrency;
  const all = sortedIncomes(state);
  const shown =
    monthKey === undefined ? all : (withGold ? all : all.filter(isMoneyIncome)).filter((i) => monthOf(i.date) === monthKey);
  return shown.map((i) => {
    const key = monthOf(i.date);
    const recurring = i.recurring === true;
    if (!isMoneyIncome(i)) {
      const base = { id: i.id, date: i.date, desc: i.desc, accountId: i.accountId, amount: i.amount, cur: i.cur, budget: false };
      return { ...base, rate: null, rateAuto: null, recurring, amountText: fGrams(i.amount), main: '—', mainNote: NO_NOTE };
    }
    return {
      id: i.id,
      date: i.date,
      desc: i.desc,
      accountId: i.accountId,
      amount: i.amount,
      amountText: f2(i.amount),
      cur: i.cur,
      budget: i.budget,
      rate: ownRate(state, i),
      rateAuto: autoRate(state, i.date, i.cur),
      recurring,
      main: f2(incomeIn(state, i, main)),
      // Con tasa propia no hay de dónde salió la tasa que explicar: la escribió el usuario.
      mainNote: ownRate(state, i) ? NO_NOTE : rateNote(state, key, i.cur, main, lang, i.date),
    };
  });
}

export interface IncomeDraft {
  /** null = hoy. */
  date: ISODate | null;
  desc: string;
  /** null = la cuenta por defecto del usuario. */
  accountId: string | null;
  /** 0 = vacío. */
  amount: number;
  /** null = la moneda de la cuenta elegida: la sigue hasta que el usuario elige otra. */
  cur: Currency | null;
  /** La casilla "Adds to budget" de la fila de agregar. */
  budget: boolean;
  /** Tasa propia; null = la del mes. */
  rate: number | null;
  /** La casilla "Recurring". */
  recurring: boolean;
}

/** La fila de agregar de Savings: el ingreso entra a la cuenta y no toca el presupuesto. */
export const EMPTY_INCOME: IncomeDraft = { date: null, desc: '', accountId: null, amount: 0, cur: null, budget: false, rate: null, recurring: false };

/** La fila de agregar de la hoja del mes: el ingreso sube además el presupuesto de ese mes, salvo que se desmarque. */
export const EMPTY_MONTH_INCOME: IncomeDraft = { ...EMPTY_INCOME, budget: true };

/** Un ingreso tal como lo muestra la fila de agregar, con todos sus campos resueltos. */
export interface IncomeDraftView {
  date: ISODate;
  desc: string;
  /** '' solo si el usuario no tiene ninguna cuenta. */
  accountId: string;
  amount: number;
  /** XAU si la cuenta es de oro: el monto son gramos. */
  cur: AccountCurrency;
  budget: boolean;
  /** Solo si la moneda no es la principal ni oro; si no, null. */
  rate: number | null;
  recurring: boolean;
}

/**
 * Lo que muestra la fila de agregar. Una cuenta que ya no se ofrece (se ocultó o se eliminó) se cambia por la
 * cuenta por defecto. Sin moneda elegida va la de la cuenta. `today` es la fecha que se propone: hoy en Savings; en
 * la hoja del mes, la de sus filas de agregar (useFinanzas().draftDate). Con `gold` (Savings) se ofrecen también
 * las cuentas de oro: en una de ellas el ingreso son gramos (XAU) y no sube el presupuesto, diga lo que diga el borrador.
 */
export function resolveIncomeDraft(draft: IncomeDraft, state: AppState, today: ISODate, gold = false): IncomeDraftView {
  const offered = gold ? visibleAccounts(state) : moneyAccounts(state);
  const account = offered.find((a) => a.id === draft.accountId) ?? defaultAccount(state);
  const base = { date: draft.date ?? today, desc: draft.desc, accountId: account?.id ?? '', amount: draft.amount };
  if (account && isGold(account.currency)) return { ...base, cur: GOLD, budget: false, rate: null, recurring: draft.recurring };
  const cur = draft.cur ?? account?.currency ?? state.mainCurrency;
  return { ...base, cur, budget: draft.budget, rate: cur === state.mainCurrency ? null : draft.rate, recurring: draft.recurring };
}

/**
 * El ingreso listo para guardar, o null si no se puede agregar: hace falta una cuenta, una fecha válida y un monto
 * mayor que 0. La descripción es opcional (va sin espacios sobrantes) y no puede pasar del largo que admite la API.
 */
export function incomeDraftInput(draft: IncomeDraft, state: AppState, today: ISODate, gold = false): IncomeDraftView | null {
  const input = resolveIncomeDraft(draft, state, today, gold);
  const desc = input.desc.trim();
  const ok = input.accountId !== '' && isISODate(input.date) && Number.isFinite(input.amount) && input.amount > 0 && desc.length <= MAX_LEN.desc;
  return ok ? { ...input, desc } : null;
}

/**
 * Después de agregar se limpia lo propio de cada ingreso (también su tasa y su casilla "Recurring": son de esa
 * operación); fecha, cuenta, moneda y la casilla del presupuesto se quedan para el siguiente.
 */
export function afterIncomeAdd(draft: IncomeDraft): IncomeDraft {
  return { ...draft, desc: '', amount: 0, rate: null, recurring: false };
}

// ── El mes de la tabla de ingresos de Savings ────────────────────────────────

/**
 * Los meses que ofrece el selector de la tabla de ingresos, del más antiguo al más reciente: los registrados, los
 * que tienen algún ingreso y el que se está viendo (que puede no ser ninguno de los dos).
 */
export function incomeMonthKeys(state: AppState, selected: MonthKey): MonthKey[] {
  const keys = new Set<MonthKey>([...Object.keys(state.months), ...state.incomes.map((i) => monthOf(i.date)), selected]);
  return [...keys].sort();
}

/** La fecha que propone la fila de agregar en ese mes: hoy si es el mes en curso; si no, su día 1 (como la hoja del mes). */
export function monthDraftDate(key: MonthKey, today: ISODate): ISODate {
  return monthOf(today) === key ? today : firstDay(key);
}

/** La suma de los ingresos de dinero de ese mes en la moneda principal (lo que dice la cabecera de la tabla). */
export function incomeTotalOf(state: AppState, key: MonthKey): number {
  return incomeInMonth(state, key);
}

// ── Aportes ──────────────────────────────────────────────────────────────────

export interface ContributionRowView {
  id: string;
  date: ISODate;
  goalId: string;
  /** Nombre de la meta; una raya si ya no existe. */
  goal: string;
  /** El valor de la celda editable. */
  amount: number;
  /** El mismo monto con formato, para el nombre del botón de eliminar. */
  amountText: string;
  cur: Currency;
  /** Tasa propia (null = la del mes) y la automática; `rateAuto` null = sin control (la moneda es la principal). */
  rate: number | null;
  rateAuto: number | null;
  /** Cuenta de la que sale ('' = ninguna). */
  accountId: string;
  /** En la moneda de su meta, con el código ('3,000.00 USD'); una raya si la meta ya no existe. */
  inGoal: string;
  goalNote: RateNote;
  /** En la moneda principal. Las dos conversiones usan la tasa vigente en la fecha del aporte. */
  main: string;
  mainNote: RateNote;
}

/** Del más reciente al más antiguo; los de un mismo día quedan en el orden en que se registraron. */
export function contributionRows(state: AppState, lang: Language): ContributionRowView[] {
  const goals = new Map(state.goals.map((g) => [g.id, g]));
  const main = state.mainCurrency;
  return [...state.contribs]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((c) => {
      const goal = goals.get(c.goalId);
      const key = monthOf(c.date);
      return {
        id: c.id,
        date: c.date,
        goalId: c.goalId,
        goal: goal?.name ?? '—',
        amount: c.amount,
        amountText: f2(c.amount),
        cur: c.cur,
        rate: ownRate(state, c),
        rateAuto: autoRate(state, c.date, c.cur),
        accountId: c.accountId ?? '',
        inGoal: goal ? `${f2(contribIn(state, c, goal.cur))} ${goal.cur}` : '—',
        goalNote: goal ? rateNote(state, key, c.cur, goal.cur, lang, c.date) : NO_NOTE,
        main: f2(contribIn(state, c, main)),
        mainNote: ownRate(state, c) ? NO_NOTE : rateNote(state, key, c.cur, main, lang, c.date),
      };
    });
}

// ── Fila de agregar un aporte ────────────────────────────────────────────────

export interface ContributionDraft {
  /** null = hoy. Así la fecha sigue al calendario hasta que el usuario elige una. */
  date: ISODate | null;
  /** null = la primera meta de la lista. */
  goalId: string | null;
  /** 0 = vacío. */
  amount: number;
  /** null = la moneda de la meta elegida: la sigue hasta que el usuario elige otra. */
  cur: Currency | null;
  /** Tasa propia; null = la del mes. */
  rate: number | null;
  /** null = ninguna cuenta: el aporte no mueve saldos. */
  accountId: string | null;
}

export const EMPTY_DRAFT: ContributionDraft = { date: null, goalId: null, amount: 0, cur: null, rate: null, accountId: null };

type GoalRef = Pick<Goal, 'id' | 'name' | 'sort'>;
type GoalCur = GoalRef & Pick<Goal, 'cur'>;

/** Las metas del usuario en el orden de las tarjetas, como opciones del selector. */
export function goalOptions(goals: readonly GoalRef[]): { value: string; label: string }[] {
  return [...goals].sort((a, b) => a.sort - b.sort).map((g) => ({ value: g.id, label: g.name }));
}

/** Las opciones del selector de meta de un aporte ya registrado: si su meta ya no existe, sale como una raya en vez de su id. */
export function goalOptionsFor(goals: readonly GoalRef[], goalId: string): { value: string; label: string }[] {
  const options = goalOptions(goals);
  return options.some((o) => o.value === goalId) ? options : [{ value: goalId, label: '—' }, ...options];
}

/**
 * Lo que muestra la fila de agregar. Una meta que ya no existe (eliminada, o tras cargar un Excel) se cambia por
 * la primera; sin metas, `goalId` queda vacío. Sin moneda elegida va la de la meta (`fallbackCur` si no hay metas).
 */
export function resolveDraft(draft: ContributionDraft, goals: readonly GoalCur[], today: ISODate, fallbackCur: Currency = 'USD'): ContributionInput {
  const sorted = [...goals].sort((a, b) => a.sort - b.sort);
  const goal = sorted.find((g) => g.id === draft.goalId) ?? sorted[0];
  const cur = draft.cur ?? goal?.cur ?? fallbackCur;
  // Sin control de tasa (la moneda es la principal) no se guarda ninguna.
  return {
    goalId: goal?.id ?? '',
    date: draft.date ?? today,
    amount: draft.amount,
    cur,
    rate: cur === fallbackCur ? null : draft.rate,
    accountId: draft.accountId,
  };
}

/** El aporte listo para guardar, o null si no se puede agregar: hace falta una meta, una fecha válida y un monto > 0. */
export function draftInput(draft: ContributionDraft, goals: readonly GoalCur[], today: ISODate, main: Currency = 'USD'): ContributionInput | null {
  const input = resolveDraft(draft, goals, today, main);
  const ok = input.goalId !== '' && isISODate(input.date) && Number.isFinite(input.amount) && input.amount > 0;
  return ok ? input : null;
}

/** Después de agregar se limpian el monto y la tasa propia (son de ese aporte): fecha, meta, moneda y cuenta se quedan para el siguiente. */
export function afterAdd(draft: ContributionDraft): ContributionDraft {
  return { ...draft, amount: 0, rate: null };
}
