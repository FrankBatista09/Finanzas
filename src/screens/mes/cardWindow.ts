// La ventana de la tarjeta «Credit cards»: se ven como mucho dos tarjetas a la vez y las flechas la mueven de una en una.
// Funciones puras, sin React.

/** Cuántas tarjetas caben a la vez. */
export const CARD_WINDOW = 2;

/** El primer índice de la ventana, llevado al rango que existe (al borrar una tarjeta la ventana no se queda fuera). */
export function clampStart(count: number, start: number): number {
  return Math.max(0, Math.min(start, count - CARD_WINDOW));
}

/** Las tarjetas que se ven: dos a partir de `start`. */
export function windowOf<T>(items: readonly T[], start: number): T[] {
  const from = clampStart(items.length, start);
  return items.slice(from, from + CARD_WINDOW);
}

/** Qué flechas sirven: arriba si hay algo antes de la ventana, abajo si hay algo después. */
export function arrowsOf(count: number, start: number): { up: boolean; down: boolean } {
  const from = clampStart(count, start);
  return { up: from > 0, down: from + CARD_WINDOW < count };
}

/** Mueve la ventana una tarjeta (-1 arriba, +1 abajo) sin salirse. */
export function moveWindow(count: number, start: number, step: -1 | 1): number {
  return clampStart(count, clampStart(count, start) + step);
}
