// Outside-budget expenses (Month.outside) and overrun budget parts: what they count toward and what they do not.

import { describe, expect, it } from 'vitest';
import { balances, budgetOverruns, monthCalc, outsideOf, outsideSummary, rateFor } from './calc';
import { seedState } from './seed';
import type { AppState, OutsideExpense } from './types';

const KEY = '2026-10';

const row = (patch: Partial<OutsideExpense>): OutsideExpense => ({
  id: 'o1',
  monthKey: KEY,
  date: '2026-10-07',
  name: 'Car repair',
  desc: '',
  accountId: 'dr',
  amount: 1000,
  cur: 'DOP',
  ...patch,
});

function withOutside(...rows: OutsideExpense[]): AppState {
  const state = seedState();
  return { ...state, months: { ...state.months, [KEY]: { ...state.months[KEY]!, outside: rows } } };
}

const balanceOf = (state: AppState, id: string) => balances(state, KEY).accounts.find((a) => a.account.id === id)!.balance;

describe('outside-budget expenses', () => {
  it('they subtract from the balance of their account, in its currency', () => {
    const base = seedState();
    const state = withOutside(row({ amount: 1000 }));
    expect(balanceOf(state, 'dr')).toBeCloseTo(balanceOf(base, 'dr') - 1000, 8);
    expect(balanceOf(state, 'us')).toBe(balanceOf(base, 'us'));
  });

  it('in another currency they subtract converted with the rate in effect on their date, not with the last one of the month', () => {
    // A later rate (day 20) cannot change an expense from day 7.
    const later = (s: AppState): AppState => ({
      ...s,
      months: { ...s.months, [KEY]: { ...s.months[KEY]!, rates: [...s.months[KEY]!.rates, { from: 'USD', to: 'DOP', rate: 70, date: '2026-10-20' }] } },
    });
    const base = later(seedState());
    // 100 USD paid from the DOP account: the October 7 rate, not any other.
    const state = later(withOutside(row({ amount: 100, cur: 'USD', date: '2026-10-07' })));
    const rate = rateFor(state, KEY, 'USD', 'DOP', '2026-10-07').rate;
    expect(rate).not.toBe(70);
    expect(balanceOf(state, 'dr')).toBeCloseTo(balanceOf(base, 'dr') - 100 * rate, 6);
    // And 5,876 DOP from the USD account.
    const back = later(withOutside(row({ amount: 5876, cur: 'DOP', accountId: 'us' })));
    expect(balanceOf(back, 'us')).toBeCloseTo(balanceOf(base, 'us') - 5876 * rateFor(back, KEY, 'DOP', 'USD', '2026-10-07').rate, 6);
  });

  it('they lower total money, but are not part of the budget: not used, not available, not categories, not the count', () => {
    const base = seedState();
    const state = withOutside(row({ amount: 5000 }), row({ id: 'o2', amount: 20, cur: 'USD', accountId: 'us' }));
    const [a, b] = [monthCalc(base, KEY), monthCalc(state, KEY)];
    expect(b.used).toBe(a.used);
    expect(b.avail).toBe(a.avail);
    expect(b.after).toBe(a.after);
    expect(b.varSpent).toBe(a.varSpent);
    expect(b.txCount).toBe(a.txCount);
    expect(b.categories).toEqual(a.categories);
    expect(b.budget).toBe(a.budget);
    expect(balances(state, KEY).totalMain).toBeLessThan(balances(base, KEY).totalMain);
  });

  it('a later month sees the expense of an earlier one in its balances; an earlier one does not see that of a later one', () => {
    const state = withOutside(row({ amount: 1000 }));
    const base = seedState();
    expect(balances(state, '2026-09').accounts.map((x) => x.balance)).toEqual(balances(base, '2026-09').accounts.map((x) => x.balance));
  });

  it('outsideSummary counts and adds up in the main currency, each one with the rate of its date', () => {
    const state = withOutside(row({ amount: 1000 }), row({ id: 'o2', amount: 10, cur: 'USD', accountId: 'us' }));
    const rate = rateFor(state, KEY, 'USD', 'DOP', '2026-10-07').rate;
    const s = outsideSummary(state, KEY);
    expect(s.count).toBe(2);
    expect(s.total).toBeCloseTo(1000 + 10 * rate, 8);
    expect(outsideSummary(seedState(), KEY)).toEqual({ count: 0, total: 0 });
    expect(outsideSummary(seedState(), '2099-01')).toEqual({ count: 0, total: 0 });
    expect(outsideOf(seedState().months[KEY]!)).toEqual([]);
  });
});

describe('budgetOverruns', () => {
  it('only the parts in the negative, with how much they are over', () => {
    const state = seedState();
    const month = state.months[KEY]!;
    // A transfer that moves more budget than the origin account has leaves it in the negative.
    const withTransfer: AppState = {
      ...state,
      months: {
        ...state.months,
        [KEY]: { ...month, transfers: [...month.transfers, { id: 'big', monthKey: KEY, date: '2026-10-05', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 800, rate: 58, budget: true, fee: 0 }] },
      },
    };
    const parts = monthCalc(withTransfer, KEY).budgetParts;
    const us = parts.find((p) => p.account.id === 'us')!;
    expect(us.amount).toBeLessThan(0);
    const over = budgetOverruns(parts);
    expect(over.map((o) => [o.account.id, o.over])).toEqual([['us', -us.amount]]);
  });

  it('none if no part is negative', () => {
    expect(budgetOverruns(monthCalc(seedState(), KEY).budgetParts)).toEqual([]);
  });
});
