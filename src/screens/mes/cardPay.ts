// Lógica pura del diálogo «Pagar la tarjeta de crédito»: qué propone al abrirse y cuándo se puede confirmar.
// Sin React ni textos. El dinero (lo que falta por pagar) lo calcula shared/calc.ts cardCalc.

import { cardAccountFor, cardCalc } from '../../../shared/calc';
import type { AppState, MonthKey } from '../../../shared/types';
import { snapToTotal } from '../../store';

/** Lo que el diálogo deja escribir: el monto como texto (un campo a medio escribir no es un número) y la cuenta. */
export interface PayForm {
  amount: string;
  accountId: string;
}

/** Con menos de medio centavo por pagar, la tarjeta está pagada del todo. */
export const isFullyPaid = (left: number): boolean => left < 0.005;

/**
 * Lo que propone al abrirse: pagar todo lo que falta (con dos decimales) desde la cuenta del último pago de la
 * tarjeta o, si nunca se pagó, la cuenta por defecto. Sin ninguna cuenta de dinero, la cuenta queda vacía.
 */
export function payForm(state: AppState, key: MonthKey): PayForm {
  return { amount: Math.max(0, cardCalc(state, key).remainder).toFixed(2), accountId: cardAccountFor(state, key)?.id ?? '' };
}

/**
 * El monto a pagar: un número > 0 y no mayor que lo que falta. Escribir lo que falta redondeado cuenta como eso
 * mismo, para no dejar un resto de céntimos. null si el campo no vale (la confirmación queda apagada).
 */
export function payAmount(text: string, left: number): number | null {
  const n = text.trim() === '' ? NaN : Number(text);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  const amount = snapToTotal(n, left);
  return amount <= left ? amount : null;
}

/** Lo que quedará por pagar con ese monto; con un monto inválido, todo lo que falta. */
export function payRest(text: string, left: number): number {
  const amount = payAmount(text, left);
  return amount === null ? left : left - amount;
}
