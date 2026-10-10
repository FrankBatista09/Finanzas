// Lo que el panel del presupuesto y el diálogo de cierre enseñan del registro del presupuesto: el sobrante del mes
// anterior, la historia del presupuesto y las partes iniciales del mes siguiente. Los números salen de
// shared/calc.ts; aquí solo se decide qué se ve y qué se manda. Sin React, para probarlo en Node.

import type { CloseRequest } from '../../shared/api';
import { budgetHistory, budgetOverruns, incomeBudgetUse, isMoneyIncome, monthCalc } from '../../shared/calc';
import type { Balances, BudgetHistoryRow, BudgetPart, BudgetSummary, Leftover } from '../../shared/calc';
import { f2, parseAmount } from '../../shared/format';
import { firstDay, inMonth, isISODate, monthOf, nextKey } from '../../shared/month';
import type { AppState, Currency, Income, ISODate, MonthKey } from '../../shared/types';
import type { CoreKey } from '../i18n';
import { isLocalEntry } from '../store';

/** Un importe que con dos decimales se ve como 0.00: no hay nada que sumar ni que ofrecer. */
const isZero = (n: number) => Math.round(n * 100) === 0;

// ── Sobrante del mes anterior ────────────────────────────────────────────────

/**
 *  offer  se puede sumar al presupuesto: va el botón "Add to budget"
 *  added  ya está sumado: en vez del botón, "added"
 *  plain  solo la cifra: el mes está cerrado, o sobró 0 y no hay nada que sumar
 */
export type LeftoverStatus = 'offer' | 'added' | 'plain';

export interface LeftoverView {
  /** Lo que sobró del mes anterior, en la moneda principal (negativo si se pasó). */
  amount: number;
  /** El mes del que viene. */
  from: MonthKey;
  status: LeftoverStatus;
}

/** La línea "Leftover from last month" del panel; null si no hay mes anterior (no se enseña nada). */
export function leftoverView(leftover: Leftover, readOnly: boolean): LeftoverView | null {
  if (leftover.previousKey === null || leftover.leftover === null) return null;
  const status: LeftoverStatus = leftover.added ? 'added' : readOnly || isZero(leftover.leftover) ? 'plain' : 'offer';
  return { amount: leftover.leftover, from: leftover.previousKey, status };
}

// ── Partes pasadas de presupuesto ───────────────────────────────────────────

export interface OverrunLine {
  /** Id de la cuenta: la clave de la línea. */
  id: string;
  /** Lo que se pasa, en la moneda de la cuenta y con dos decimales. */
  amount: string;
  currency: Currency;
  /** Nombre de la cuenta (lo escribe el usuario: no se traduce). */
  account: string;
}

/** Una línea por cada parte del presupuesto en negativo ("Over budget by 800.00 USD · Bank"); ninguna si no hay. */
export function overrunLines(parts: readonly BudgetPart[]): OverrunLine[] {
  return budgetOverruns(parts).map(({ account, over }) => ({ id: account.id, amount: f2(over), currency: account.currency, account: account.name }));
}

// ── Historia del presupuesto ─────────────────────────────────────────────────

/** El nombre de cada clase de movimiento, como clave de los textos comunes. */
export const BUDGET_KIND: Record<BudgetHistoryRow['kind'], CoreKey> = {
  initial: 'budgetKindInitial',
  adjust: 'budgetKindAdjust',
  leftover: 'budgetKindLeftover',
  income: 'budgetKindIncome',
  transfer: 'budgetKindTransfer',
};

export interface BudgetHistoryView {
  /** Única en la lista: un envío sale en dos filas (la de origen y la de destino) con el mismo id. */
  key: string;
  id: string;
  date: ISODate;
  kind: BudgetHistoryRow['kind'];
  /** Clave del texto común con el nombre de `kind`. */
  kindKey: CoreKey;
  /** Nombre de la cuenta (lo escribe el usuario: no se traduce). */
  account: string;
  /** En la moneda de la cuenta, con dos decimales; lleva su signo si resta. */
  amount: string;
  currency: Currency;
  negative: boolean;
  /** Presupuesto acumulado hasta esta fila, en la moneda principal. */
  total: string;
  /** La nota del movimiento, la descripción del ingreso o la vía del envío; '' si no hay. */
  note: string;
  /** The income an entry was taken from (its description, '' when it has none); absent without a link. */
  incomeName?: string;
  /**
   * Se puede quitar con ×: un movimiento del registro (no un ingreso ni un envío, que se quitan o se desmarcan en
   * su propia tabla) de un mes abierto y que ya tiene su id del servidor.
   */
  deletable: boolean;
}

/** Las filas de "Budget history": calc.budgetHistory con su formato. La última lleva el presupuesto del mes. */
export function budgetHistoryRows(state: AppState, key: MonthKey): BudgetHistoryView[] {
  const open = state.months[key]?.closed === false;
  return budgetHistory(state, key).map((r) => ({
    key: `${r.kind}:${r.id}${r.side ? `:${r.side}` : ''}`,
    id: r.id,
    date: r.date,
    kind: r.kind,
    // A positive adjustment is money added on top of the budget, so it reads "Extra"; a negative one stays "Adjustment".
    kindKey: r.kind === 'adjust' && r.amount > 0 ? 'budgetKindExtra' : BUDGET_KIND[r.kind],
    account: r.account.name,
    amount: f2(r.amount),
    currency: r.account.currency,
    negative: r.amount < 0,
    total: f2(r.total),
    note: r.note,
    ...(r.incomeId !== null && { incomeName: r.incomeName ?? '' }),
    deletable: open && r.kind !== 'income' && r.kind !== 'transfer' && !isLocalEntry(r.id),
  }));
}

// ── Cerrar el mes: el presupuesto del siguiente ──────────────────────────────

export interface CloseBudgetField {
  accountId: string;
  /** Nombre de la cuenta. */
  name: string;
  currency: Currency;
  /** Texto del campo: la parte con la que arranca el mes siguiente, en la moneda de la cuenta. */
  amount: string;
  /**
   * La parte de este mes sin redondear. El campo la enseña con dos decimales; si no se toca, se manda esta (un
   * sobrante llevado a otra moneda tiene más decimales y no debe perderlos solo por pasar por el diálogo).
   */
  exact: number;
}

export interface CloseBudgetForm {
  /** El mes que se crearía. */
  next: MonthKey;
  /**
   * true si el mes siguiente ya existe: el cierre no lo toca (el servidor ignoraría lo que se mande), así que el
   * diálogo no pregunta por su presupuesto.
   */
  nextExists: boolean;
  /** Un campo por cuenta que hoy tiene parte en el registro del presupuesto, con esa parte; vacío si `nextExists`. */
  fields: CloseBudgetField[];
  /** Lo que sobra de este mes (su disponible), en la moneda principal; null si no hay nada que ofrecer (0, o `nextExists`). */
  leftover: number | null;
}

/**
 * Un monto tal como va en un campo editable: a centavos. Una parte del presupuesto puede traer más decimales (un
 * sobrante llevado a la moneda de la cuenta) y en el campo se vería como 73363.4591384.
 */
export const fieldAmount = (n: number) => Math.round(n * 100) / 100;

/** El mismo monto como valor de un <input type="number">: sin separadores. */
const fieldText = (n: number) => String(fieldAmount(n));

/**
 * Lo que pregunta el diálogo de cierre sobre el presupuesto del mes siguiente. Las partes son las del registro
 * (BudgetPart.fromLog): los ingresos que subieron el presupuesto de este mes y los envíos que lo movieron de una
 * cuenta a otra no se heredan, igual que cuando el servidor las copia por su cuenta: el mes siguiente arranca
 * con el reparto escrito, antes de mover nada.
 */
export function closeBudgetForm(state: AppState, key: MonthKey): CloseBudgetForm {
  const next = nextKey(key);
  if (state.months[next] || !state.months[key]) return { next, nextExists: state.months[next] !== undefined, fields: [], leftover: null };
  const calc = monthCalc(state, key);
  const fields = calc.budgetParts
    .filter((p) => p.fromLog !== 0)
    // Una parte en negativo (un sobrante negativo sin nada más) no se puede pedir como parte inicial: arranca en 0.
    .map((p) => ({ account: p.account, exact: Math.max(0, p.fromLog) }))
    .map(({ account, exact }) => ({ accountId: account.id, name: account.name, currency: account.currency, amount: fieldText(exact), exact }));
  return { next, nextExists: false, fields, leftover: isZero(calc.avail) ? null : calc.avail };
}

/** true si el campo no vale: vacío cuenta como 0; lo demás tiene que ser un número >= 0. */
export function closeFieldInvalid(amount: string): boolean {
  const text = amount.trim();
  if (text === '') return false;
  const n = Number(text);
  return !Number.isFinite(n) || n < 0;
}

/**
 * El cuerpo de POST …/close: las partes tal como quedaron en los campos (un campo vacío o en 0 deja a esa cuenta
 * sin parte) y si se suma el sobrante. undefined cuando el mes siguiente ya existe (no se manda nada) y null si
 * algún campo no vale.
 */
export function closeRequest(form: CloseBudgetForm, fields: readonly CloseBudgetField[], addLeftover: boolean): CloseRequest | undefined | null {
  if (form.nextExists) return undefined;
  if (fields.some((f) => closeFieldInvalid(f.amount))) return null;
  const budgets = Object.fromEntries(fields.map((f) => [f.accountId, f.amount === fieldText(f.exact) ? f.exact : parseAmount(f.amount)]));
  return { budgets, addLeftover: addLeftover && form.leftover !== null };
}

// ── Extra budget dialog ──────────────────────────────────────────────────────

export interface ExtraForm {
  accountId: string;
  /** The income it is taken from; '' = none in particular. */
  incomeId: string;
  /** Text of the amount field; '' until typed. */
  amount: string;
  note: string;
  date: ISODate;
}

/**
 * Date the dialog opens with: today when the viewed month is the current one, otherwise the month's first day
 * (an extra for a past or future month is dated inside that month, never at an unrelated today).
 */
export function extraDefaultDate(key: MonthKey, today: ISODate): ISODate {
  return monthOf(today) === key ? today : firstDay(key);
}

/**
 * The first budget part's account (the one the user is already budgeting from); with no parts yet, the first
 * account that can hold a budget. '' when there is none.
 */
export function extraDefaultAccount(parts: readonly BudgetPart[], accounts: readonly { id: string }[]): string {
  const part = parts.find((p) => p.amount !== 0 || p.fromLog !== 0);
  return part?.account.id ?? accounts[0]?.id ?? '';
}

export function newExtraForm(key: MonthKey, today: ISODate, parts: readonly BudgetPart[], accounts: readonly { id: string }[]): ExtraForm {
  return { accountId: extraDefaultAccount(parts, accounts), incomeId: '', amount: '', note: '', date: extraDefaultDate(key, today) };
}

/** The amount typed, or null when it is not a number > 0. */
export function extraAmount(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Why the form cannot be confirmed, or null when it can: only the date has its own message, the rest just disables the button. */
export function extraProblem(form: ExtraForm, key: MonthKey): 'account' | 'amount' | 'date' | null {
  if (form.accountId === '') return 'account';
  if (extraAmount(form.amount) === null) return 'amount';
  if (!isISODate(form.date) || !inMonth(form.date, key)) return 'date';
  return null;
}

/** The log entry the dialog adds: always a positive 'adjust', which the history shows as an extra. */
export function extraInput(
  form: ExtraForm,
  key: MonthKey,
): { accountId: string; amount: number; date: ISODate; note: string; kind: 'adjust'; incomeId: string | null } | null {
  const amount = extraAmount(form.amount);
  if (extraProblem(form, key) !== null || amount === null) return null;
  return { accountId: form.accountId, amount, date: form.date, note: form.note.trim(), kind: 'adjust', incomeId: form.incomeId || null };
}

/** An income the extra can be taken from, in the account's currency. */
export interface ExtraIncomeOption {
  id: string;
  desc: string;
  date: ISODate;
  /** As earned: amount and currency of the income itself. */
  amount: string;
  currency: string;
  /** Still free to take, in the account's currency (0 when the income already adds its whole amount). */
  available: number;
  /** true: it has "Adds to budget", so the whole of it is already counted. */
  whole: boolean;
}

/** The incomes of the viewed month that are in `accountId`, oldest first: the ones an extra can say it comes from. */
export function extraIncomeOptions(state: AppState, key: MonthKey, accountId: string): ExtraIncomeOption[] {
  return state.incomes
    .filter(isMoneyIncome)
    .filter((i) => i.accountId === accountId && inMonth(i.date, key))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .flatMap((i) => {
      const use = incomeBudgetUse(state, i);
      return use ? [{ id: i.id, desc: i.desc, date: i.date, amount: f2(i.amount), currency: i.cur, available: use.available, whole: use.whole }] : [];
    });
}

/** What the account holds in the viewed month, never below 0 (a negative balance has nothing to spend); null if unknown. */
export function accountAvailable(balances: Balances, accountId: string): number | null {
  const hit = balances.accounts.find((b) => b.account.id === accountId);
  return hit ? Math.max(0, hit.balance) : null;
}

/**
 * The amount the dialog proposes once an income is chosen: what is left of the income, capped by what the account
 * holds. null when there is nothing to propose (no income, or nothing left).
 */
export function extraDefaultAmount(incomeAvailable: number | null, accountAvail: number | null): number | null {
  if (incomeAvailable === null) return null;
  const cap = accountAvail === null ? incomeAvailable : Math.min(incomeAvailable, accountAvail);
  const amount = fieldAmount(cap);
  return amount > 0 ? amount : null;
}

/** true when `amount` is more than `limit` by at least a cent. */
const exceeds = (amount: number, limit: number) => Math.round((amount - limit) * 100) > 0;

export interface ExtraWarnings {
  /** What is left of the income when the typed amount is more than that; null when it fits or no income is chosen. */
  income: number | null;
  /** What the account holds when the typed amount is more than that; null when it fits. */
  account: number | null;
}

/** The soft warnings of the dialog: they never block the confirm button. */
export function extraWarnings(amount: number | null, incomeAvailable: number | null, accountAvail: number | null): ExtraWarnings {
  if (amount === null) return { income: null, account: null };
  return {
    income: incomeAvailable !== null && exceeds(amount, incomeAvailable) ? incomeAvailable : null,
    account: accountAvail !== null && exceeds(amount, accountAvail) ? accountAvail : null,
  };
}

/**
 * For an income with "Adds to budget": what its account holds (never below 0) when that is less than what the
 * income adds, in the account's currency; null when the account covers it or the income does not add to the budget.
 * Informative only: the budget math does not change.
 */
export function incomeBudgetShortfall(state: AppState, balances: Balances, income: Income): { available: number; currency: Currency } | null {
  if (!income.budget || !isMoneyIncome(income)) return null;
  const use = incomeBudgetUse(state, income);
  const hit = balances.accounts.find((b) => b.account.id === income.accountId);
  if (!use || !hit || hit.account.currency === 'XAU') return null;
  return exceeds(use.amount, Math.max(0, hit.balance)) ? { available: Math.max(0, hit.balance), currency: hit.account.currency } : null;
}

// ── Month budget summary ─────────────────────────────────────────────────────

export type SummaryRowKind = 'initial' | 'leftover' | 'income' | 'transfer' | 'addition' | 'reduction' | 'added' | 'total' | 'spent' | 'remaining';

export interface SummaryRow {
  key: string;
  kind: SummaryRowKind;
  labelKey: CoreKey;
  /** dd/mm of an addition or reduction; null on the rest. */
  date: string | null;
  note: string;
  /** Account name of an addition or reduction. */
  account: string | null;
  /** Description of the income an addition was taken from; null without one. */
  income: string | null;
  /** Main currency, two decimals; signed for reductions and a negative leftover. */
  amount: string;
  /** Same figure in the second currency; null when there is none or the line has no such figure. */
  second: string | null;
  /** "50.00 USD" when the line's own currency is not the main one. */
  original: string | null;
  negative: boolean;
  /** Initial, total and the closing figures read heavier. */
  strong: boolean;
}

const dayMonth = (date: ISODate) => `${date.slice(8)}/${date.slice(5, 7)}`;

/**
 * The rows of the month summary list, or its compact form in the close dialog (additions collapsed into one
 * "Added during the month" row). Zero lines are left out; the closing three (total, spent, remaining) always show.
 */
export function summaryRows(b: BudgetSummary, compact = false): SummaryRow[] {
  const row = (r: Partial<SummaryRow> & Pick<SummaryRow, 'key' | 'kind' | 'labelKey'>, value: number, second: number | null = null): SummaryRow => ({
    date: null,
    note: '',
    account: null,
    income: null,
    original: null,
    strong: false,
    ...r,
    amount: f2(value),
    second: second === null ? null : f2(second),
    negative: value < 0,
  });
  const out: SummaryRow[] = [row({ key: 'initial', kind: 'initial', labelKey: 'summaryInitial', strong: true }, b.initial, b.initialSecond)];
  if (!isZero(b.leftover)) out.push(row({ key: 'leftover', kind: 'leftover', labelKey: 'summaryLeftover' }, b.leftover));
  if (!isZero(b.incomes)) out.push(row({ key: 'income', kind: 'income', labelKey: 'summaryIncomes' }, b.incomes));
  if (!isZero(b.transfers)) out.push(row({ key: 'transfer', kind: 'transfer', labelKey: 'summaryTransfers' }, b.transfers));
  const line = (kind: 'addition' | 'reduction') => (l: BudgetSummary['additions'][number]) =>
    row(
      {
        key: `${kind}:${l.id}`,
        kind,
        labelKey: kind === 'addition' ? 'budgetKindExtra' : 'summaryAdjustment',
        date: dayMonth(l.date),
        note: l.note,
        account: l.accountName,
        income: l.incomeId === null ? null : (l.incomeName ?? ''),
        original: l.currency === b.main ? null : `${f2(l.amount)} ${l.currency}`,
      },
      l.inMain,
    );
  if (compact) {
    if (b.additions.length > 0) out.push(row({ key: 'added', kind: 'added', labelKey: 'summaryAdded' }, b.added, b.addedSecond));
    if (b.reductions.length > 0) out.push(row({ key: 'reduced', kind: 'reduction', labelKey: 'summaryAdjustment' }, b.reduced));
  } else {
    out.push(...b.additions.map(line('addition')), ...b.reductions.map(line('reduction')));
  }
  out.push(row({ key: 'total', kind: 'total', labelKey: 'summaryTotal', strong: true }, b.total, b.totalSecond));
  out.push(row({ key: 'spent', kind: 'spent', labelKey: 'summarySpent' }, b.spent, b.spentSecond));
  const over = b.remaining < 0 && !isZero(b.remaining);
  out.push(
    row(
      { key: 'remaining', kind: 'remaining', labelKey: over ? 'summaryOver' : 'summaryRemaining', strong: true },
      over ? -b.remaining : b.remaining,
      b.remainingSecond === null ? null : over ? -b.remainingSecond : b.remainingSecond,
    ),
  );
  // "Over budget by 800" already says it is negative: the figure is shown as a magnitude, only flagged.
  if (over) out[out.length - 1]!.negative = true;
  return out;
}
