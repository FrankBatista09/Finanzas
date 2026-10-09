// La ventana de dos tarjetas de «Credit cards» y sus flechas.

import { describe, expect, it } from 'vitest';
import { arrowsOf, clampStart, moveWindow, windowOf } from './cardWindow';

describe('ventana de dos tarjetas', () => {
  const four = ['a', 'b', 'c', 'd'];

  it('enseña como mucho dos, a partir de `start`, sin salirse', () => {
    expect(windowOf([], 0)).toEqual([]);
    expect(windowOf(['a'], 0)).toEqual(['a']);
    expect(windowOf(['a', 'b'], 0)).toEqual(['a', 'b']);
    expect(windowOf(four, 0)).toEqual(['a', 'b']);
    expect(windowOf(four, 1)).toEqual(['b', 'c']);
    expect(windowOf(four, 2)).toEqual(['c', 'd']);
    // Un `start` pasado de largo (se borró una tarjeta) se lleva al último hueco posible.
    expect(windowOf(four, 9)).toEqual(['c', 'd']);
    expect(windowOf(four, -3)).toEqual(['a', 'b']);
  });

  it('las flechas se apagan en los extremos', () => {
    expect(arrowsOf(2, 0)).toEqual({ up: false, down: false });
    expect(arrowsOf(3, 0)).toEqual({ up: false, down: true });
    expect(arrowsOf(3, 1)).toEqual({ up: true, down: false });
    expect(arrowsOf(4, 1)).toEqual({ up: true, down: true });
  });

  it('mover la ventana avanza de una tarjeta en una y se queda en el extremo', () => {
    expect(moveWindow(3, 0, 1)).toBe(1);
    expect(moveWindow(3, 1, 1)).toBe(1);
    expect(moveWindow(3, 1, -1)).toBe(0);
    expect(moveWindow(3, 0, -1)).toBe(0);
    expect(moveWindow(5, 2, 1)).toBe(3);
    expect(clampStart(1, 5)).toBe(0);
  });
});
