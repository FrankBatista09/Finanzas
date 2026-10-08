// Lógica del formulario de una meta (GoalDialog): los campos enlazados, la validación y el paso de ida y vuelta
// entre la meta guardada y lo que se ve en el diálogo. Sin React, para probarlo en Node.
//
// La meta guarda su moneda, el ahorro mensual y los dos meses; el monto objetivo no se guarda: es mensual × meses,
// ambos incluidos (shared/types.ts Goal). En el formulario se puede escribir cualquiera de los dos montos y el otro
// se calcula. Los dos montos van en la moneda de la meta: cambiarla no los toca.

import { MAX_LEN } from '../../../shared/constants';
import { parseAmount } from '../../../shared/format';
import { isMonthKey, monthOf, monthSpan } from '../../../shared/month';
import type { Currency, Goal, ISODate, MonthKey } from '../../../shared/types';
import { normalizeGoalPlan } from '../../store';
import type { GoalPlan } from '../../store';

export interface GoalForm {
  name: string;
  /** Moneda de la meta: en ella van el objetivo, el ahorro mensual y lo ahorrado. */
  cur: Currency;
  /** La casilla "This goal has a target". Al desmarcarla los campos del plan se conservan, por si se vuelve a marcar. */
  planned: boolean;
  start: MonthKey;
  end: MonthKey;
  /** Texto del campo "Target amount (CUR)". */
  target: string;
  /** Texto del campo "Monthly saving (CUR)". */
  monthly: string;
  /**
   * El ahorro mensual exacto que hay detrás de los dos textos, que van redondeados a centavos; null mientras no
   * haya un monto mayor que 0. Es lo que se guarda: 10,000 en 12 meses son 833.333… al mes, no los 833.33 que se
   * ven (que darían 9,999.96 al volver a abrir la meta).
   */
  exact: number | null;
}

/** Una meta nueva con objetivo propone este plazo: el mes objetivo cae doce meses después del de inicio. */
export const DEFAULT_MONTHS_AHEAD = 12;

/** '2026-10' + 12 → '2027-10'. */
export function addMonths(key: MonthKey, n: number): MonthKey {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** Un monto como valor de un <input type="number">: redondeado a centavos y sin separadores ('10000', '833.33'). */
export function amountText(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** El monto escrito en un campo, o null si está vacío o no es mayor que 0. */
function amountOf(text: string): number | null {
  const n = parseAmount(text);
  return n > 0 ? n : null;
}

/** Meses del plan, ambos incluidos; 0 si el mes objetivo queda antes del de inicio. */
export function planMonths(form: Pick<GoalForm, 'start' | 'end'>): number {
  return isMonthKey(form.start) && isMonthKey(form.end) && form.start <= form.end ? monthSpan(form.start, form.end) : 0;
}

// ── De la meta al formulario ─────────────────────────────────────────────────

/** Formulario de una meta nueva, en la moneda principal del usuario: sin objetivo; si se marca la casilla, el plan empieza este mes. */
export function newGoalForm(today: ISODate, cur: Currency): GoalForm {
  const start = monthOf(today);
  return { name: '', cur, planned: false, start, end: addMonths(start, DEFAULT_MONTHS_AHEAD), target: '', monthly: '', exact: null };
}

/** Formulario para editar una meta. El mensual exacto se conserva: guardar sin tocar nada no cambia la meta. */
export function goalToForm(goal: Goal, today: ISODate): GoalForm {
  const blank = { ...newGoalForm(today, goal.cur), name: goal.name };
  const plan = normalizeGoalPlan(goal);
  if (!plan || plan.monthly === null || plan.start === null || plan.end === null) return blank;
  const { monthly, start, end } = plan;
  return {
    ...blank,
    planned: true,
    start,
    end,
    target: amountText(monthly * monthSpan(start, end)),
    monthly: amountText(monthly),
    exact: monthly,
  };
}

// ── Campos enlazados ─────────────────────────────────────────────────────────

/** Manda el objetivo: mensual = objetivo / meses. Sin objetivo o sin meses válidos, el mensual queda vacío. */
function fromTarget(form: GoalForm): GoalForm {
  const months = planMonths(form);
  const target = amountOf(form.target);
  if (!months || target === null) return { ...form, monthly: '', exact: null };
  const exact = target / months;
  return { ...form, monthly: amountText(exact), exact };
}

/** Manda el mensual: objetivo = mensual × meses. Sin meses válidos el objetivo no se puede calcular y queda vacío. */
function fromMonthly(form: GoalForm): GoalForm {
  const months = planMonths(form);
  const exact = amountOf(form.monthly);
  return { ...form, exact, target: exact !== null && months ? amountText(exact * months) : '' };
}

/** Se escribió el monto objetivo: se recalcula el ahorro mensual. */
export function setTarget(form: GoalForm, target: string): GoalForm {
  return fromTarget({ ...form, target });
}

/** Se escribió el ahorro mensual: se recalcula el monto objetivo. */
export function setMonthly(form: GoalForm, monthly: string): GoalForm {
  return fromMonthly({ ...form, monthly });
}

/**
 * Cambió un mes: el objetivo se queda y se recalcula el mensual. Si no hay objetivo a la vista (se escribió el
 * mensual mientras los meses no cuadraban), se parte del mensual.
 */
function withMonths(form: GoalForm): GoalForm {
  if (amountOf(form.target) !== null) return fromTarget(form);
  return form.exact !== null ? fromMonthly(form) : form;
}

export function setStart(form: GoalForm, start: MonthKey): GoalForm {
  return withMonths({ ...form, start });
}

export function setEnd(form: GoalForm, end: MonthKey): GoalForm {
  return withMonths({ ...form, end });
}

/** Se eligió otra moneda: los montos escritos se quedan tal cual, ahora en esa moneda. */
export function setCur(form: GoalForm, cur: Currency): GoalForm {
  return { ...form, cur };
}

/** La línea de resumen bajo los campos del plan ("15 months · 3,000 USD / month"); null si aún no hay plan que resumir. */
export function planSummary(form: GoalForm): { months: number; monthly: number; cur: Currency } | null {
  const months = planMonths(form);
  return form.planned && months && form.exact !== null ? { months, monthly: form.exact, cur: form.cur } : null;
}

// ── Validación y guardado ────────────────────────────────────────────────────

/**
 * name       falta el nombre
 * nameTaken  otra meta ya se llama así (sin distinguir mayúsculas)
 * amount     con objetivo, falta un monto mayor que 0
 * months     con objetivo, el mes objetivo queda antes del de inicio
 */
export type GoalFormError = 'name' | 'nameTaken' | 'amount' | 'months';

const fold = (name: string) => name.trim().normalize('NFC').toLowerCase();

/**
 * Lo que impide guardar; vacío si el formulario es válido. `editingId` es la meta que se edita (null si es nueva),
 * para no contarla como "otra" con su mismo nombre.
 */
export function goalFormErrors(form: GoalForm, goals: readonly Pick<Goal, 'id' | 'name'>[], editingId: string | null): GoalFormError[] {
  const errors: GoalFormError[] = [];
  const name = fold(form.name);
  if (!name || name.length > MAX_LEN.name) errors.push('name');
  else if (goals.some((g) => g.id !== editingId && fold(g.name) === name)) errors.push('nameTaken');
  if (form.planned) {
    if (form.exact === null && amountOf(form.target) === null) errors.push('amount');
    if (!planMonths(form)) errors.push('months');
  }
  return errors;
}

/**
 * Lo que se guarda (actions.addGoal / patchGoal): el nombre sin espacios sobrantes, la moneda y el plan con sus tres
 * valores, o los tres en null si la meta es de aportes variables. Solo tiene sentido con el formulario ya validado.
 */
export function formToInput(form: GoalForm): { name: string; cur: Currency } & GoalPlan {
  const base = { name: form.name.trim(), cur: form.cur };
  return form.planned ? { ...base, monthly: form.exact, start: form.start, end: form.end } : { ...base, monthly: null, start: null, end: null };
}
