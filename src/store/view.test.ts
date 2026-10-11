// What the screens read already computed: the value of useFinanzas() and the pieces it is built from.

import { describe, expect, it } from 'vitest';
import { balances, leftoverFor, monthCalc, rateFor } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import type { AppState, AppUser } from '../../shared/types';
import type { Actions } from './context';
import { accountOptions, buildFinanzas, inBoth, pairRates } from './view';

const OCT = '2026-10';
const FRANK: AppUser = { id: 'frank', name: 'Frank' };
const actions = {} as Actions;

const build = (state: AppState = seedState(), monthKey = OCT, today = '2026-10-07') => buildFinanzas({ user: FRANK, state, monthKey, today, actions })!;

/** The sample data with all three October rates in view: USD → DOP and USD → TRY typed. */
function withLira(): AppState {
  const s = seedState();
  s.months[OCT]!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
  return s;
}

/** October with two USD → DOP rates on different dates: 58 from day 1 and 60 from day 6. */
function twoRates(): AppState {
  const s = seedState();
  s.months[OCT]!.rates = [
    { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
    { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' },
  ];
  return s;
}

describe('inBoth: an amount in the main currency and in the second one', () => {
  it('with the rates of whichever month is requested', () => {
    const s = seedState();
    expect(inBoth(s, OCT, 5876, 'DOP')).toEqual({ main: 5876, second: 100 });
    expect(inBoth(s, OCT, 100, 'USD')).toEqual({ main: 5876, second: 100 });
    // August has no typed rate: the one from its transfers.
    const aug = rateFor(s, '2026-08', 'USD', 'DOP').rate;
    expect(inBoth(s, '2026-08', 100, 'USD').main).toBeCloseTo(100 * aug, 10);
    expect(inBoth(s, '2026-08', 100, 'USD').second).toBe(100);
  });

  it("follows the user's currencies, also with a third one", () => {
    const s = withLira();
    s.mainCurrency = 'TRY';
    s.secondCurrency = 'DOP';
    const { main, second } = inBoth(s, OCT, 100, 'USD');
    expect(main).toBeCloseTo(4000, 9);
    expect(second).toBeCloseTo(5876, 9);
    // An amount in lira: as is in the main one, crossed through USD into the second.
    expect(inBoth(s, OCT, 1000, 'TRY').main).toBe(1000);
    expect(inBoth(s, OCT, 1000, 'TRY').second).toBeCloseTo((1000 / 40) * 58.76, 9);
  });

  it('with a date, the rate in effect that day; without one, the last of the month', () => {
    const s = twoRates();
    // A row from day 3 converts at 58 even though 60 was typed on day 6.
    expect(inBoth(s, OCT, 100, 'USD', '2026-10-03')).toEqual({ main: 5800, second: 100 });
    expect(inBoth(s, OCT, 100, 'USD', '2026-10-01').main).toBe(5800);
    expect(inBoth(s, OCT, 5800, 'DOP', '2026-10-05').second).toBeCloseTo(100, 10);
    // From day 6 on (inclusive), the new one.
    expect(inBoth(s, OCT, 100, 'USD', '2026-10-06').main).toBe(6000);
    expect(inBoth(s, OCT, 100, 'USD', '2026-10-20').main).toBe(6000);
    expect(inBoth(s, OCT, 100, 'USD')).toEqual({ main: 6000, second: 100 });
    expect(inBoth(s, OCT, 6000, 'DOP').second).toBeCloseTo(100, 10);
  });
});

describe('pairRates: the month rates, one per pair, with their source', () => {
  it('the top bar pair goes first; each row in a direction that reads well', () => {
    const rates = pairRates(seedState(), OCT);
    expect(rates.map((r) => [r.from, r.to, r.source])).toEqual([
      ['USD', 'DOP', 'month'],
      ['TRY', 'DOP', 'default'],
      ['USD', 'TRY', 'default'],
    ]);
    // Of the two typed in October (days 1 and 6), the one in effect at the end of the month.
    expect(rates[0]).toEqual({ from: 'USD', to: 'DOP', rate: 58.76, source: 'month', monthKey: OCT, date: '2026-10-06' });
    // Default values: 42 TRY and 58.76 DOP per USD. Always in the direction that gives a number >= 1.
    expect(rates[1]!.rate).toBeCloseTo(58.76 / 42, 12);
    expect(rates[2]!.rate).toBe(42);
    for (const r of rates) expect(r.rate).toBeGreaterThanOrEqual(1);
  });

  it('a typed rate comes out in the direction it was typed, even if it is less than 1', () => {
    const s = seedState();
    s.months[OCT]!.rates = [
      { from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-02' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-03' },
    ];
    const rates = pairRates(s, OCT);
    expect(rates[0]).toEqual({ from: 'DOP', to: 'USD', rate: 0.017, source: 'month', monthKey: OCT, date: '2026-10-02' });
    expect(rates.find((r) => r.from === 'USD' && r.to === 'TRY')).toMatchObject({ rate: 40, source: 'month' });
    // The third one comes from crossing through USD.
    const cross = rates.find((r) => r.source === 'cross')!;
    expect([cross.from, cross.to]).toEqual(['TRY', 'DOP']);
    expect(cross.rate).toBeCloseTo(1 / 0.017 / 40, 10);
  });

  it('says where each one comes from: transfers of the month, a previous month', () => {
    expect(pairRates(seedState(), '2026-08')[0]).toMatchObject({ from: 'USD', to: 'DOP', source: 'transfers', monthKey: '2026-08', date: null });
    // Another state (not the same object changed: shared/calc.ts memoizes the rates per state object).
    const s = seedState();
    s.months[OCT]!.rates = [];
    s.months[OCT]!.transfers = [];
    expect(pairRates(s, OCT)[0]).toMatchObject({ from: 'USD', to: 'DOP', source: 'previous', monthKey: '2026-09', date: null });
  });

  it('with several typed rates for the same pair, a single row: the one in effect at the end of the month, with its date', () => {
    const rates = pairRates(twoRates(), OCT);
    expect(rates).toHaveLength(3);
    expect(rates.filter((r) => r.from === 'USD' && r.to === 'DOP')).toEqual([
      { from: 'USD', to: 'DOP', rate: 60, source: 'month', monthKey: OCT, date: '2026-10-06' },
    ]);
  });

  it('the one in effect comes out in the direction it was typed itself, not that of an earlier one for the same pair', () => {
    const s = seedState();
    s.months[OCT]!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 0.016, date: '2026-10-06' },
    ];
    expect(pairRates(s, OCT)[0]).toEqual({ from: 'DOP', to: 'USD', rate: 0.016, source: 'month', monthKey: OCT, date: '2026-10-06' });
  });

  it('the last typed one stays in effect in the following months: it comes out as from a previous month, with its date', () => {
    const s = twoRates();
    s.months['2026-11'] = { key: '2026-11', closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] };
    expect(pairRates(s, '2026-11')[0]).toEqual({ from: 'USD', to: 'DOP', rate: 60, source: 'previous', monthKey: OCT, date: '2026-10-06' });
  });

  it('with other currencies chosen, the first pair is theirs', () => {
    const s = withLira();
    s.mainCurrency = 'TRY';
    s.secondCurrency = 'USD';
    expect(pairRates(s, OCT).map((r) => `${r.from}>${r.to}`)).toEqual(['USD>TRY', 'USD>DOP', 'TRY>DOP']);
    // It matches the top bar rate (MonthCalc.rate: 1 second = rate main).
    expect(pairRates(s, OCT)[0]).toMatchObject(monthCalc(s, OCT).rate!);
  });

  it('a month that does not exist: with no typed rates, it resolves with whatever came before', () => {
    expect(pairRates(seedState(), '2027-03')[0]).toMatchObject({ from: 'USD', to: 'DOP', rate: 58.76, source: 'previous', monthKey: OCT, date: '2026-10-06' });
  });
});

describe('accountOptions: the options of an account select', () => {
  it('the visible accounts, in their order, with their names', () => {
    expect(accountOptions(seedState())).toEqual([
      { value: 'us', label: 'US account' },
      { value: 'dr', label: 'DR account' },
    ]);
  });

  it("a row's account that was later hidden stays in the list, with its name", () => {
    const s = seedState();
    s.accounts.find((a) => a.id === 'us')!.hidden = true;
    expect(accountOptions(s)).toEqual([{ value: 'dr', label: 'DR account' }]);
    expect(accountOptions(s, 'us')).toEqual([
      { value: 'dr', label: 'DR account' },
      { value: 'us', label: 'US account' },
    ]);
    // Those already there are not repeated, and anything that is not an id is ignored.
    expect(accountOptions(s, 'dr', null, undefined, 'us', 'us')).toHaveLength(2);
    // An account that no longer exists does not end up with its id on display.
    expect(accountOptions(s, 'gone').at(-1)).toEqual({ value: 'gone', label: '—' });
  });
});

describe('buildFinanzas: the value of useFinanzas()', () => {
  it('brings what shared/calc.ts provides already computed for the selected month', () => {
    const s = seedState();
    const f = build(s);
    expect(f.calc).toEqual(monthCalc(s, OCT));
    expect(f.rate).toEqual({ rate: 58.76, source: 'month', monthKey: OCT, date: '2026-10-06' });
    expect([f.main, f.second]).toEqual(['DOP', 'USD']);
    expect(f.balances).toEqual(balances(s, OCT));
    expect(f.rates).toEqual(pairRates(s, OCT));
    expect(f.leftover).toEqual(leftoverFor(s, OCT));
    expect(f.month).toBe(s.months[OCT]);
    expect(f.readOnly).toBe(false);
    expect(f.latestMonth).toBe(true);
  });

  it('the accounts: all of them, the visible ones and the default one', () => {
    const s = seedState();
    s.accounts.push({ id: 'old', name: 'Old', currency: 'USD', opening: 0, hidden: true, sort: -1 });
    const f = build(s);
    // In their order (sort), the hidden ones too.
    expect(f.accounts.map((a) => a.id)).toEqual(['old', 'us', 'dr']);
    expect(f.visibleAccounts.map((a) => a.id)).toEqual(['us', 'dr']);
    expect(f.defaultAccount!.id).toBe('dr');
    expect(f.accountOptions('old').map((o) => o.label)).toEqual(['US account', 'DR account', 'Old']);
    expect(build({ ...s, accounts: [] }).defaultAccount).toBeNull();
  });

  it('inBoth and rateOf use the selected month unless another one is requested', () => {
    const f = build();
    expect(f.inBoth(100, 'USD')).toEqual({ main: 5876, second: 100 });
    const aug = rateFor(seedState(), '2026-08', 'USD', 'DOP');
    expect(f.inBoth(100, 'USD', '2026-08').main).toBeCloseTo(100 * aug.rate, 10);
    expect(f.rateOf('USD', 'DOP')).toEqual({ rate: 58.76, source: 'month', monthKey: OCT, date: '2026-10-06' });
    expect(f.rateOf('USD', 'DOP', '2026-08')).toEqual(aug);
    expect(f.rateOf('USD', 'TRY').source).toBe('default');
    expect(f.rateOf('DOP', 'DOP')).toEqual({ rate: 1, source: 'same', monthKey: null, date: null });
  });

  it('inBoth and rateOf with a date: the rate in effect that day, not the last of the month', () => {
    const f = build(twoRates());
    expect(f.inBoth(100, 'USD')).toEqual({ main: 6000, second: 100 });
    expect(f.inBoth(100, 'USD', OCT, '2026-10-03')).toEqual({ main: 5800, second: 100 });
    expect(f.inBoth(100, 'USD', undefined, '2026-10-05').main).toBe(5800);
    expect(f.inBoth(100, 'USD', OCT, '2026-10-06').main).toBe(6000);
    expect(f.rateOf('USD', 'DOP')).toEqual({ rate: 60, source: 'month', monthKey: OCT, date: '2026-10-06' });
    expect(f.rateOf('USD', 'DOP', OCT, '2026-10-05')).toEqual({ rate: 58, source: 'month', monthKey: OCT, date: '2026-10-01' });
    expect(f.rateOf('DOP', 'USD', undefined, '2026-10-05').rate).toBeCloseTo(1 / 58, 12);
    // The top bar and the rate list show the last one.
    expect(f.rate!.rate).toBe(60);
    expect(f.rates[0]).toMatchObject({ rate: 60, date: '2026-10-06' });
  });

  it('leftover: what was left over from the previous month, in the main currency, and whether it was already added', () => {
    const s = seedState();
    const sep = monthCalc(s, '2026-09').avail;
    expect(build(s).leftover).toEqual({ previousKey: '2026-09', leftover: sep, added: false });
    // September: a budget of 70,000 minus what was used.
    expect(sep).toBeCloseTo(70000 - monthCalc(s, '2026-09').used, 8);
    expect(build(s, '2026-09').leftover).toMatchObject({ previousKey: '2026-08', added: false });
    // The first month has no previous one.
    expect(build(s, '2026-08').leftover).toEqual({ previousKey: null, leftover: null, added: false });

    // Already added: the month has its 'leftover' movement.
    const added = seedState();
    added.months[OCT]!.budgetLog.push({ id: 'lo', date: '2026-10-02', accountId: 'dr', amount: sep, kind: 'leftover', note: '' });
    expect(build(added).leftover).toEqual({ previousKey: '2026-09', leftover: sep, added: true });
  });

  it("leftover: it is in the user's main currency and can be negative", () => {
    const usd = seedState();
    usd.mainCurrency = 'USD';
    usd.secondCurrency = 'DOP';
    expect(build(usd).leftover.leftover).toBeCloseTo(monthCalc(usd, '2026-09').avail, 10);
    expect(build(usd).leftover.leftover).not.toBeCloseTo(monthCalc(seedState(), '2026-09').avail, 0);

    const over = seedState();
    over.months['2026-09']!.budgetLog = [{ id: 'b', date: '2026-09-01', accountId: 'dr', amount: 1000, kind: 'initial', note: '' }];
    expect(build(over).leftover.leftover).toBeLessThan(0);
  });

  it('in a past month: its balances, read-only if it is closed, and no balance corrections', () => {
    const s = seedState();
    const f = build(s, '2026-09');
    expect(f.readOnly).toBe(true);
    expect(f.latestMonth).toBe(false);
    expect(f.balances).toEqual(balances(s, '2026-09'));
    expect(f.balances.totalMain).not.toBe(build(s).balances.totalMain);
    expect(f.rate!.source).toBe('transfers');
    // The latest month counts as such even when it is closed.
    s.months[OCT]!.closed = true;
    expect(build(s)).toMatchObject({ readOnly: true, latestMonth: true });
  });

  it('with another main currency, everything computed is in it', () => {
    const s = withLira();
    s.mainCurrency = 'TRY';
    const f = build(s);
    expect([f.main, f.second]).toEqual(['TRY', 'USD']);
    expect(f.rate).toEqual({ rate: 40, source: 'month', monthKey: OCT, date: '2026-10-01' });
    expect(f.calc.budget).toBeCloseTo((70000 / 58.76) * 40, 6);
    expect(f.balances.totalMain).toBeCloseTo((13482 + 220641.93 / 58.76) * 40, 4);
    expect(f.inBoth(58.76, 'DOP').main).toBeCloseTo(40, 9);
  });

  it("the date of the add rows: today if the selected month is today's month; otherwise, its day 1", () => {
    expect(build().draftDate).toBe('2026-10-07');
    expect(build(seedState(), '2026-09').draftDate).toBe('2026-09-01');
    expect(build(seedState(), OCT, '2026-11-02')).toMatchObject({ today: '2026-11-02', draftDate: '2026-10-01' });
  });

  it('a month that does not exist: null', () => {
    expect(buildFinanzas({ user: FRANK, state: seedState(), monthKey: '2030-01', today: '2026-10-07', actions })).toBeNull();
  });
});
