// The pure side of the statement panel: which statements it offers, what each lists, what is pickable and the sums.

import { describe, expect, it } from 'vitest';
import type { StatementItem } from '../../../shared/calc';
import { canPick, currentStatement, itemsIn, selection, statementCutoffs, statementTotals, stepStatement } from './cardStatement';

const item = (id: string, over: Partial<StatementItem> = {}): StatementItem => ({
  kind: 'tx', id, key: '2026-10', date: '2026-10-02', name: id, cat: 'Food', amount: 10, cur: 'DOP', converted: 10, statement: '2026-10-13', status: 'unpaid', includedIn: null, payment: null, ...over,
});

describe('statementCutoffs', () => {
  it('lists the statements with items plus the current one, oldest first', () => {
    const items = [item('a', { statement: '2026-11-13' }), item('b', { statement: '2026-09-13' }), item('c', { statement: '2026-11-13' })];
    expect(statementCutoffs(items, '2026-10-20', 13)).toEqual(['2026-09-13', '2026-11-13']);
    expect(statementCutoffs([], '2026-10-13', 13)).toEqual(['2026-10-13']);
  });

  it('is empty without a cutoff day', () => {
    expect(statementCutoffs([item('a')], '2026-10-20', null)).toEqual([]);
    expect(currentStatement('2026-10-20', null)).toBeNull();
    expect(currentStatement('2026-10-20', 13)).toBe('2026-11-13');
  });
});

describe('stepStatement', () => {
  const list = ['2026-09-13', '2026-10-13', '2026-11-13'];
  it('moves one place and stops at the ends', () => {
    expect(stepStatement(list, '2026-10-13', -1)).toBe('2026-09-13');
    expect(stepStatement(list, '2026-10-13', 1)).toBe('2026-11-13');
    expect(stepStatement(list, '2026-09-13', -1)).toBe('2026-09-13');
    expect(stepStatement(list, '2026-11-13', 1)).toBe('2026-11-13');
  });
});

describe('itemsIn', () => {
  const items = [item('a'), item('b', { statement: '2026-11-13' })];
  it('keeps one statement, or everything without a cutoff day', () => {
    expect(itemsIn(items, '2026-11-13').map((i) => i.id)).toEqual(['b']);
    expect(itemsIn(items, null).map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('selection and totals', () => {
  const items = [
    item('a', { converted: 0.1 }),
    item('b', { converted: 0.2 }),
    item('month', { status: 'month', includedIn: '2026-10', converted: 5 }),
    item('fixed', { kind: 'fixed', converted: 7 }),
  ];

  it('only unpaid transactions can be picked', () => {
    expect(items.map(canPick)).toEqual([true, true, false, false]);
  });

  it('adds up the checked ones that can be picked, to cents, ignoring the rest', () => {
    expect(selection(items, new Set(['a', 'b', 'month', 'fixed']))).toEqual({ ids: ['a', 'b'], sum: 0.3 });
    expect(selection(items, new Set())).toEqual({ ids: [], sum: 0 });
    expect(selection(items, new Set(['gone']))).toEqual({ ids: [], sum: 0 });
  });

  it('totals the statement and what is unpaid in it', () => {
    expect(statementTotals(items)).toEqual({ total: 12.3, unpaid: 7.3 });
  });
});
