// Lógica pura del diálogo «Pagar la tarjeta de crédito»: qué propone al abrirse y cuándo se puede confirmar.
// Sin React ni textos. El dinero (el total de la tarjeta) lo calcula shared/calc.ts cardCalc.

import { cardAccountFor, cardCalc } from '../../../shared/calc';
import type { AppState, MonthKey } from '../../../shared/types';
import { snapToTotal } from '../../store';

/** Lo que el diálogo deja escribir: el monto como texto (un campo a medio escribir no es un número) y la cuenta. */
export interface PayForm {
  amount: string;
  accountId: string;
}

/**
 * Lo que propone al abrirse: pagar todo el total (con dos decimales) desde la cuenta de la tarjeta, es decir, la del
 * último pago o, si nunca se pagó, la cuenta por defecto. Sin ninguna cuenta de dinero, la cuenta queda vacía.
 */
export function payForm(state: AppState, key: MonthKey): PayForm {
  return { amount: Math.max(0, cardCalc(state, key).total).toFixed(2), accountId: cardAccountFor(state, key)?.id ?? '' };
}

/**
 * El monto a pagar: un número > 0 y no mayor que el total. Escribir el total redondeado cuenta como el total, para
 * no dejar un resto de céntimos para el mes siguiente. null si el campo no vale (la confirmación queda apagada).
 */
export function payAmount(text: string, total: number): number | null {
  const n = text.trim() === '' ? NaN : Number(text);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  const amount = snapToTotal(n, total);
  return amount <= total ? amount : null;
}

/** Lo que quedará sin pagar (pasa al mes siguiente) con ese monto; con un monto inválido, todo el total. */
export function payRest(text: string, total: number): number {
  const amount = payAmount(text, total);
  return amount === null ? total : total - amount;
}
