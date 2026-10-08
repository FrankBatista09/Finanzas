// Textos de la hoja "Savings": lo que `renderVals()` del prototipo llamaba goalCards, incomeRows, contribRows y ct.
// Los números salen de shared/calc.ts; aquí solo se les da formato y se arma cada frase en el idioma que se pida
// (./strings). Sin React, para probarlo en Node.
//
// Cada meta va en su moneda; los ingresos y los aportes, en la suya. Lo que se ve convertido usa la tasa del mes
// de la fecha de cada fila, y cada cifra convertida lleva una nota (RateNote) cuando esa tasa no es la escrita
// para ese mes.

import { contribIn, convert, currentKey, defaultAccount, goalsProgress, incomeRows, rateFor, sortedIncomes, visibleAccounts } from '../../../shared/calc';
import type { GoalProgress, IncomeRow } from '../../../shared/calc';
import { MAX_LEN } from '../../../shared/constants';
import { f0, f2, fPct } from '../../../shared/format';
import { isISODate, monthOf } from '../../../shared/month';
import type { AppState, Currency, Goal, ISODate, Language, MonthKey } from '../../../shared/types';
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

/** La nota de la conversión `from` → `to` con las tasas del mes `key`. */
export function rateNote(state: AppState, key: MonthKey, from: Currency, to: Currency, lang: Language): RateNote {
  const info = rateFor(state, key, from, to);
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
  /** Su equivalente en la moneda principal, sin decimales (la línea "≈"); null si la meta ya está en la principal. */
  savedMain: string | null;
  /** La tasa del mes en curso con la que se calculó `savedMain`. */
  mainNote: RateNote;
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
 * `main` es la moneda principal del usuario. `current` es el mes en curso (shared/calc currentKey), el mismo desde
 * el que goalProgress cuenta los aportes que faltan: con él se sabe si el mes objetivo ya quedó atrás. `mainNote`
 * es la nota de la tasa con la que se pasó lo ahorrado a la moneda principal.
 */
export function goalCard(g: GoalProgress, lang: Language, main: Currency, current: MonthKey | null = null, mainNote: RateNote = NO_NOTE): GoalCardView {
  const s = translator(AHORROS, lang);
  const currency = g.cur;
  const same = g.cur === main;
  const base = {
    id: g.id,
    name: g.name,
    cur: g.cur,
    saved: f2(g.saved),
    savedMain: same ? null : f0(g.savedMain),
    mainNote: same ? NO_NOTE : mainNote,
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
  const main = state.mainCurrency;
  // goalProgress pasa lo ahorrado a la moneda principal con la tasa del mes en curso: la nota es la de esa tasa.
  return goalsProgress(state).map((g) => goalCard(g, lang, main, current, current ? rateNote(state, current, g.cur, main, lang) : NO_NOTE));
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
  return rows.some((r) => monthOf(r.date) === key && rateFor(state, key, r.cur, state.mainCurrency).source === 'default');
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
  return incomeRows(state).map((r) => incomeRowView(r, lang, usesFallback(state, r.key, state.incomes), usesFallback(state, r.key, state.contribs)));
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
  cur: Currency;
  /** En la moneda principal, con la tasa del mes de su fecha. */
  main: string;
  mainNote: RateNote;
}

/** Del más reciente al más antiguo; los de un mismo día quedan en el orden en que se registraron. */
export function incomeItems(state: AppState, lang: Language): IncomeItemView[] {
  const main = state.mainCurrency;
  return sortedIncomes(state).map((i) => {
    const key = monthOf(i.date);
    return {
      id: i.id,
      date: i.date,
      desc: i.desc,
      accountId: i.accountId,
      amount: i.amount,
      amountText: f2(i.amount),
      cur: i.cur,
      main: f2(convert(state, key, i.amount, i.cur, main)),
      mainNote: rateNote(state, key, i.cur, main, lang),
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
}

export const EMPTY_INCOME: IncomeDraft = { date: null, desc: '', accountId: null, amount: 0, cur: null };

/** Un ingreso tal como lo muestra la fila de agregar, con todos sus campos resueltos. */
export interface IncomeDraftView {
  date: ISODate;
  desc: string;
  /** '' solo si el usuario no tiene ninguna cuenta. */
  accountId: string;
  amount: number;
  cur: Currency;
}

/**
 * Lo que muestra la fila de agregar. Una cuenta que ya no se ofrece (se ocultó o se eliminó) se cambia por la
 * cuenta por defecto. Sin moneda elegida va la de la cuenta.
 */
export function resolveIncomeDraft(draft: IncomeDraft, state: AppState, today: ISODate): IncomeDraftView {
  const account = visibleAccounts(state).find((a) => a.id === draft.accountId) ?? defaultAccount(state);
  return {
    date: draft.date ?? today,
    desc: draft.desc,
    accountId: account?.id ?? '',
    amount: draft.amount,
    cur: draft.cur ?? account?.currency ?? state.mainCurrency,
  };
}

/**
 * El ingreso listo para guardar, o null si no se puede agregar: hace falta una cuenta, una fecha válida y un monto
 * mayor que 0. La descripción es opcional (va sin espacios sobrantes) y no puede pasar del largo que admite la API.
 */
export function incomeDraftInput(draft: IncomeDraft, state: AppState, today: ISODate): IncomeDraftView | null {
  const input = resolveIncomeDraft(draft, state, today);
  const desc = input.desc.trim();
  const ok = input.accountId !== '' && isISODate(input.date) && Number.isFinite(input.amount) && input.amount > 0 && desc.length <= MAX_LEN.desc;
  return ok ? { ...input, desc } : null;
}

/** Después de agregar se limpia lo propio de cada ingreso; fecha, cuenta y moneda se quedan para el siguiente. */
export function afterIncomeAdd(draft: IncomeDraft): IncomeDraft {
  return { ...draft, desc: '', amount: 0 };
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
  /** En la moneda de su meta, con el código ('3,000.00 USD'); una raya si la meta ya no existe. */
  inGoal: string;
  goalNote: RateNote;
  /** En la moneda principal. Las dos conversiones usan la tasa del mes de la fecha del aporte. */
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
        inGoal: goal ? `${f2(contribIn(state, c, goal.cur))} ${goal.cur}` : '—',
        goalNote: goal ? rateNote(state, key, c.cur, goal.cur, lang) : NO_NOTE,
        main: f2(contribIn(state, c, main)),
        mainNote: rateNote(state, key, c.cur, main, lang),
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
}

export const EMPTY_DRAFT: ContributionDraft = { date: null, goalId: null, amount: 0, cur: null };

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
  return { goalId: goal?.id ?? '', date: draft.date ?? today, amount: draft.amount, cur: draft.cur ?? goal?.cur ?? fallbackCur };
}

/** El aporte listo para guardar, o null si no se puede agregar: hace falta una meta, una fecha válida y un monto > 0. */
export function draftInput(draft: ContributionDraft, goals: readonly GoalCur[], today: ISODate): ContributionInput | null {
  const input = resolveDraft(draft, goals, today);
  const ok = input.goalId !== '' && isISODate(input.date) && Number.isFinite(input.amount) && input.amount > 0;
  return ok ? input : null;
}

/** Después de agregar solo se limpia el monto: fecha, meta y moneda se quedan para el siguiente aporte. */
export function afterAdd(draft: ContributionDraft): ContributionDraft {
  return { ...draft, amount: 0 };
}
