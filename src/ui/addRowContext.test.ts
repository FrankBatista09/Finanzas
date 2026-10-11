import { describe, expect, it } from 'vitest';
import { addRowKeyAction } from './addRowContext';

describe('addRowKeyAction: the keyboard in an add row', () => {
  const key = (key: string, over: Partial<Parameters<typeof addRowKeyAction>[0]> = {}) =>
    addRowKeyAction({ key, isComposing: false, inInput: true, closable: true, ...over });

  it('Enter in a field adds; in a select or a button it does not (they have their own Enter)', () => {
    expect(key('Enter')).toBe('submit');
    expect(key('Enter', { inInput: false })).toBeNull();
  });

  it('Esc closes the row (and discards the draft) from any control, if the row can be closed', () => {
    expect(key('Escape')).toBe('cancel');
    expect(key('Escape', { inInput: false })).toBe('cancel');
    expect(key('Escape', { closable: false })).toBeNull();
  });

  it('in the middle of an IME composition it does nothing, and neither do the other keys', () => {
    expect(key('Enter', { isComposing: true })).toBeNull();
    expect(key('Escape', { isComposing: true })).toBeNull();
    expect(key('a')).toBeNull();
    expect(key('Tab')).toBeNull();
  });
});
