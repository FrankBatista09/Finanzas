import { describe, expect, it } from 'vitest';
import { canPaySelection, pendingAfter, selection } from './cardPurchases';

const p = (id: string, amount: number) => ({ tx: { id } as never, amount });
const list = [p('a', 100.1), p('b', 0.2), p('c', 50)];

describe('selection', () => {
  it('adds up only the checked purchases, to cents', () => {
    expect(selection(list, new Set(['a', 'b']))).toEqual({ ids: ['a', 'b'], sum: 100.3 });
    expect(selection(list, new Set())).toEqual({ ids: [], sum: 0 });
  });

  it('ignores a checked id that is no longer in the list', () => {
    expect(selection(list, new Set(['c', 'gone']))).toEqual({ ids: ['c'], sum: 50 });
  });
});

describe('pendingAfter and canPaySelection', () => {
  it('what stays pending is the remainder minus the selection, never below 0', () => {
    expect(pendingAfter(300, 100)).toBe(200);
    expect(pendingAfter(50, 100)).toBe(0);
  });

  it('needs a non-empty selection that fits what is left', () => {
    expect(canPaySelection({ ids: [], sum: 0 }, 100)).toBe(false);
    expect(canPaySelection({ ids: ['a'], sum: 100 }, 100)).toBe(true);
    expect(canPaySelection({ ids: ['a'], sum: 100.004 }, 100)).toBe(true);
    expect(canPaySelection({ ids: ['a'], sum: 100.02 }, 100)).toBe(false);
  });
});
