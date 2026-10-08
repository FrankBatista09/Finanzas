import { describe, expect, it } from 'vitest';
import { addRowKeyAction } from './addRowContext';

describe('addRowKeyAction: el teclado en una fila de agregar', () => {
  const key = (key: string, over: Partial<Parameters<typeof addRowKeyAction>[0]> = {}) =>
    addRowKeyAction({ key, isComposing: false, inInput: true, closable: true, ...over });

  it('Enter en un campo agrega; en una lista o un botón no (tienen su propio Enter)', () => {
    expect(key('Enter')).toBe('submit');
    expect(key('Enter', { inInput: false })).toBeNull();
  });

  it('Esc cierra la fila (y descarta el borrador) desde cualquier control, si la fila se puede cerrar', () => {
    expect(key('Escape')).toBe('cancel');
    expect(key('Escape', { inInput: false })).toBe('cancel');
    expect(key('Escape', { closable: false })).toBeNull();
  });

  it('a media composición de un IME no hace nada, y las demás teclas tampoco', () => {
    expect(key('Enter', { isComposing: true })).toBeNull();
    expect(key('Escape', { isComposing: true })).toBeNull();
    expect(key('a')).toBeNull();
    expect(key('Tab')).toBeNull();
  });
});
