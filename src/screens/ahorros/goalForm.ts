// Logic of a goal's form (GoalDialog): the linked fields, the validation and the round trip
// between the saved goal and what the dialog shows. No React, so it can be tested in Node.
//
// The goal stores its currency, the monthly saving and the two months; the target amount is not stored: it is
// monthly × months, both included (shared/types.ts Goal). In the form either of the two amounts can be typed and the
// other is calculated. Both amounts are in the goal's currency: changing it does not touch them.

import { MAX_LEN } from '../../../shared/constants';
import { parseAmount } from '../../../shared/format';
import { isMonthKey, monthOf, monthSpan } from '../../../shared/month';
import type { Currency, Goal, ISODate, MonthKey } from '../../../shared/types';
import { normalizeGoalPlan } from '../../store';
import type { GoalPlan } from '../../store';

export interface GoalForm {
  name: string;
  /** Goal currency: the target, the monthly saving and the amount saved are in it. */
  cur: Currency;
  /** The "Show equivalent in" select: the currency of the card's "≈" line. It starts on the user's main one. */
  approxCur: Currency;
  /** The "This goal has a target" checkbox. Unchecking it keeps the plan fields, in case it is checked again. */
  planned: boolean;
  start: MonthKey;
  end: MonthKey;
  /** Text of the "Target amount (CUR)" field. */
  target: string;
  /** Text of the "Monthly saving (CUR)" field. */
  monthly: string;
  /**
   * The exact monthly saving behind the two texts, which are rounded to cents; null while there is no
   * amount greater than 0. It is what gets saved: 10,000 over 12 months is 833.333… a month, not the 833.33 that is
   * shown (which would give 9,999.96 when the goal is opened again).
   */
  exact: number | null;
}

/** A new goal with a target proposes this term: the target month falls twelve months after the start month. */
export const DEFAULT_MONTHS_AHEAD = 12;

/** '2026-10' + 12 → '2027-10'. */
export function addMonths(key: MonthKey, n: number): MonthKey {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** An amount as the value of an <input type="number">: rounded to cents and with no separators ('10000', '833.33'). */
export function amountText(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** The amount typed in a field, or null if it is empty or not greater than 0. */
function amountOf(text: string): number | null {
  const n = parseAmount(text);
  return n > 0 ? n : null;
}

/** Months of the plan, both included; 0 if the target month falls before the start month. */
export function planMonths(form: Pick<GoalForm, 'start' | 'end'>): number {
  return isMonthKey(form.start) && isMonthKey(form.end) && form.start <= form.end ? monthSpan(form.start, form.end) : 0;
}

// ── From the goal to the form ────────────────────────────────────────────────

/** Form of a new goal, in the user's main currency: no target; if the checkbox is checked, the plan starts this month. */
export function newGoalForm(today: ISODate, cur: Currency, approxCur: Currency = cur): GoalForm {
  const start = monthOf(today);
  return { name: '', cur, approxCur, planned: false, start, end: addMonths(start, DEFAULT_MONTHS_AHEAD), target: '', monthly: '', exact: null };
}

/**
 * Form for editing a goal. The exact monthly amount is kept: saving without touching anything does not change the goal.
 * `main` is the user's main currency: it is the one the "≈" select shows for a goal that chose none.
 */
export function goalToForm(goal: Goal, today: ISODate, main: Currency = goal.cur): GoalForm {
  const blank = { ...newGoalForm(today, goal.cur, goal.approxCur ?? main), name: goal.name };
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

// ── Linked fields ────────────────────────────────────────────────────────────

/** The target leads: monthly = target / months. With no target or no valid months, the monthly amount stays empty. */
function fromTarget(form: GoalForm): GoalForm {
  const months = planMonths(form);
  const target = amountOf(form.target);
  if (!months || target === null) return { ...form, monthly: '', exact: null };
  const exact = target / months;
  return { ...form, monthly: amountText(exact), exact };
}

/** The monthly amount leads: target = monthly × months. With no valid months the target cannot be calculated and stays empty. */
function fromMonthly(form: GoalForm): GoalForm {
  const months = planMonths(form);
  const exact = amountOf(form.monthly);
  return { ...form, exact, target: exact !== null && months ? amountText(exact * months) : '' };
}

/** The target amount was typed: the monthly saving is recalculated. */
export function setTarget(form: GoalForm, target: string): GoalForm {
  return fromTarget({ ...form, target });
}

/** The monthly saving was typed: the target amount is recalculated. */
export function setMonthly(form: GoalForm, monthly: string): GoalForm {
  return fromMonthly({ ...form, monthly });
}

/**
 * A month changed: the target stays and the monthly amount is recalculated. If no target is showing (the monthly
 * amount was typed while the months did not add up), it starts from the monthly amount.
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

/** Another currency was chosen: the typed amounts stay as they are, now in that currency. */
export function setCur(form: GoalForm, cur: Currency): GoalForm {
  return { ...form, cur };
}

/** The summary line under the plan fields ("15 months · 3,000 USD / month"); null if there is no plan to summarize yet. */
export function planSummary(form: GoalForm): { months: number; monthly: number; cur: Currency } | null {
  const months = planMonths(form);
  return form.planned && months && form.exact !== null ? { months, monthly: form.exact, cur: form.cur } : null;
}

// ── Validation and saving ────────────────────────────────────────────────────

/**
 * name       the name is missing
 * nameTaken  another goal already has that name (ignoring case)
 * amount     with a target, an amount greater than 0 is missing
 * months     with a target, the target month falls before the start month
 */
export type GoalFormError = 'name' | 'nameTaken' | 'amount' | 'months';

const fold = (name: string) => name.trim().normalize('NFC').toLowerCase();

/**
 * What prevents saving; empty if the form is valid. `editingId` is the goal being edited (null if it is new),
 * so it is not counted as "another" one with the same name.
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
 * What gets saved (actions.addGoal / patchGoal): the name without extra spaces, the currency, the "≈" currency and the
 * plan with its three values, or all three as null if the goal has variable contributions. It only makes sense with the
 * form already validated. A "≈" currency equal to the main one (`main`) is saved as null: that way it follows the
 * main one if the user changes it later.
 */
export function formToInput(form: GoalForm, main: Currency): { name: string; cur: Currency; approxCur: Currency | null } & GoalPlan {
  const base = { name: form.name.trim(), cur: form.cur, approxCur: form.approxCur === main ? null : form.approxCur };
  return form.planned ? { ...base, monthly: form.exact, start: form.start, end: form.end } : { ...base, monthly: null, start: null, end: null };
}
