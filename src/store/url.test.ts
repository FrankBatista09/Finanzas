import { describe, expect, it } from 'vitest';
import { seedState } from '../../shared/seed';
import { buildSearch, parseUrl, resolveMonth } from './url';

const NONE = { user: null, mes: null, hoja: 'mes' } as const;

describe('parseUrl', () => {
  it('no parameters: no user, current month and the Month sheet', () => {
    expect(parseUrl('')).toEqual(NONE);
    expect(parseUrl('?')).toEqual(NONE);
  });

  it('reads user, month and sheet', () => {
    expect(parseUrl('?month=2026-10')).toEqual({ ...NONE, mes: '2026-10' });
    expect(parseUrl('?sheet=savings')).toEqual({ ...NONE, hoja: 'ahorros' });
    expect(parseUrl('?user=eda')).toEqual({ ...NONE, user: 'eda' });
    expect(parseUrl('?sheet=savings&month=2026-08&user=eda')).toEqual({ user: 'eda', mes: '2026-08', hoja: 'ahorros' });
    expect(parseUrl('user=eda&month=2026-10&sheet=savings')).toEqual({ user: 'eda', mes: '2026-10', hoja: 'ahorros' });
  });

  it('discards values that are not a user, a month or a sheet', () => {
    expect(parseUrl('?month=october')).toEqual(NONE);
    expect(parseUrl('?month=2026-13')).toEqual(NONE);
    expect(parseUrl('?month=2026-1')).toEqual(NONE);
    expect(parseUrl('?sheet=config')).toEqual(NONE);
    expect(parseUrl('?sheet=month&month=')).toEqual(NONE);
    expect(parseUrl('?user=')).toEqual(NONE);
    expect(parseUrl('?user=Eda%20Reyes')).toEqual(NONE);
    expect(parseUrl('?user=../etc')).toEqual(NONE);
  });

  it('the version 1 names (?mes=, ?hoja=) are no longer recognized', () => {
    expect(parseUrl('?mes=2026-10&hoja=ahorros')).toEqual(NONE);
    expect(parseUrl('?sheet=ahorros')).toEqual(NONE);
  });
});

describe('buildSearch', () => {
  it('omits an empty user and month and the default sheet', () => {
    expect(buildSearch(NONE)).toBe('');
    expect(buildSearch({ ...NONE, mes: '2026-10' })).toBe('?month=2026-10');
    expect(buildSearch({ ...NONE, hoja: 'ahorros' })).toBe('?sheet=savings');
    expect(buildSearch({ ...NONE, user: 'eda' })).toBe('?user=eda');
  });

  it('writes all three in order: user, month, sheet', () => {
    expect(buildSearch({ user: 'eda', mes: '2026-10', hoja: 'ahorros' })).toBe('?user=eda&month=2026-10&sheet=savings');
    expect(buildSearch({ user: 'frank', mes: '2026-10', hoja: 'mes' })).toBe('?user=frank&month=2026-10');
  });

  it('keeps foreign parameters and replaces its own', () => {
    expect(buildSearch({ ...NONE, mes: '2026-09' }, '?debug=1&month=2026-10&sheet=savings&user=eda')).toBe('?month=2026-09&debug=1');
    expect(buildSearch(NONE, '?month=2026-10&x=a%20b')).toBe('?x=a+b');
    // An old link keeps its parameters as foreign ones: they neither get in the way nor are interpreted.
    expect(buildSearch({ ...NONE, user: 'eda' }, '?mes=2026-10')).toBe('?user=eda&mes=2026-10');
  });

  it('round trip', () => {
    for (const url of [
      NONE,
      { user: null, mes: '2026-10', hoja: 'mes' },
      { user: null, mes: null, hoja: 'ahorros' },
      { user: 'eda', mes: '2027-01', hoja: 'ahorros' },
      { user: 'frank-2', mes: null, hoja: 'mes' },
    ] as const) {
      expect(parseUrl(buildSearch(url))).toEqual(url);
    }
  });
});

describe('resolveMonth', () => {
  const s = seedState();

  it('uses the requested month if it exists, even when it is closed', () => {
    expect(resolveMonth('2026-08', s)).toBe('2026-08');
  });

  it('if it is missing or does not exist, the current month', () => {
    expect(resolveMonth(null, s)).toBe('2026-10');
    expect(resolveMonth('2031-05', s)).toBe('2026-10');
  });

  it('switching to a user who does not have that month falls back to their current month', () => {
    // Eda has just started: she only has November. The URL was still on Frank's August.
    const eda = { ...s, months: { '2026-11': { ...s.months['2026-10']!, key: '2026-11' } } };
    expect(resolveMonth('2026-08', eda)).toBe('2026-11');
  });

  it('with every month closed, the last one', () => {
    const closed = seedState();
    closed.months['2026-10']!.closed = true;
    expect(resolveMonth(null, closed)).toBe('2026-10');
  });

  it('with no months, null', () => {
    expect(resolveMonth('2026-10', { ...s, months: {} })).toBeNull();
  });
});
