// Lo que el panel del presupuesto y el diálogo de cierre enseñan del registro del presupuesto: el sobrante del mes
// anterior, la historia del presupuesto y las partes iniciales del mes siguiente. Los números salen de
// shared/calc.ts; aquí solo se decide qué se ve y qué se manda. Sin React, para probarlo en Node.

import type { CloseRequest } from '../../shared/api';
import { budgetHistory, monthCalc } from '../../shared/calc';
import type { BudgetHistoryRow, Leftover } from '../../shared/calc';
import { f2, parseAmount } from '../../shared/format';
import { nextKey } from '../../shared/month';
import type { AppState, Currency, ISODate, MonthKey } from '../../shared/types';
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
    kindKey: BUDGET_KIND[r.kind],
    account: r.account.name,
    amount: f2(r.amount),
    currency: r.account.currency,
    negative: r.amount < 0,
    total: f2(r.total),
    note: r.note,
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
