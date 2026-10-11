// Own rate per income and per contribution, and the account a contribution comes out of: figures calculated by hand on
// the sample data (1 USD = 58.76 DOP in October 2026; main currency DOP).

import { describe, expect, it } from 'vitest';
import { balances, contribIn, goalProgress, incomeInMonth, incomeIn, incomeRows, ownRate, savedInMonth } from './calc';
import { seedState } from './seed';
import type { AppState } from './types';

const balanceOf = (s: AppState, id: string) => balances(s, '2026-10').accounts.find((a) => a.account.id === id)!.balance;

describe('incomes with their own rate', () => {
  it('its own rate wins in the main-currency column, in the month total and in "Income by month"', () => {
    const s = seedState();
    expect(incomeInMonth(s, '2026-10')).toBeCloseTo(5800 * 58.76, 6);
    s.incomes.find((i) => i.id === 'seed-in-3')!.rate = 60;
    expect(incomeInMonth(s, '2026-10')).toBeCloseTo(5800 * 60, 6);
    expect(incomeRows(s).find((r) => r.key === '2026-10')!.income).toBeCloseTo(5800 * 60, 6);
    // The other months do not change.
    expect(incomeInMonth(s, '2026-09')).toBeCloseTo(339731.22, 2);
  });

  it('rate null or absent is the automatic one; in the main currency (or in gold) the rate does not count', () => {
    const s = seedState();
    const auto = incomeInMonth(s, '2026-10');
    s.incomes[2]!.rate = null;
    expect(incomeInMonth(s, '2026-10')).toBe(auto);
    s.incomes.push({ id: 'dop', date: '2026-10-09', desc: '', accountId: 'dr', amount: 1000, cur: 'DOP', budget: false, rate: 99 });
    expect(incomeInMonth(s, '2026-10')).toBeCloseTo(auto + 1000, 6);
    expect(ownRate(s, { cur: 'DOP', rate: 99 })).toBeNull();
    expect(ownRate(s, { cur: 'XAU', rate: 99 })).toBeNull();
    expect(ownRate(s, { cur: 'USD', rate: 0 })).toBeNull();
    expect(ownRate(s, { cur: 'USD', rate: 60 })).toBe(60);
  });

  it('it only governs the conversion to the main currency: balances and the budget of the income follow the rate of its date', () => {
    const s = seedState();
    const before = balanceOf(s, 'dr');
    s.incomes.push({ id: 'x', date: '2026-10-09', desc: '', accountId: 'dr', amount: 100, cur: 'USD', budget: true, rate: 70 });
    const withRate = balanceOf(s, 'dr');
    s.incomes.at(-1)!.rate = null;
    expect(balanceOf(s, 'dr')).toBe(withRate);
    expect(withRate).toBeCloseTo(before + 100 * 58.76, 6);
    // Toward another currency that is not the main one, its own rate does not come into play either.
    expect(incomeIn(s, { ...s.incomes.at(-1)!, cur: 'USD', rate: 70 }, 'TRY')).toBeCloseTo(incomeIn(s, { ...s.incomes.at(-1)!, cur: 'USD', rate: null }, 'TRY'), 8);
  });
});

describe('contributions with their own rate', () => {
  it('toward the main currency it uses its own rate; a goal in the main currency receives the amount already converted', () => {
    const s = seedState();
    s.goals.push({ id: 'dop', name: 'Pesos', cur: 'DOP', monthly: null, start: null, end: null, approxCur: null, sort: 9 });
    s.contribs = [{ id: 'a', goalId: 'dop', date: '2026-10-10', amount: 100, cur: 'USD', rate: 60 }];
    expect(contribIn(s, s.contribs[0]!, 'DOP')).toBe(6000);
    expect(goalProgress(s, s.goals.at(-1)!).saved).toBe(6000);
    expect(savedInMonth(s, '2026-10')).toBe(6000);
  });

  it('goal in another currency: the goal adds the amount as is and its value in the main currency stays fixed at its own rate', () => {
    const s = seedState();
    const emergency = s.goals.find((g) => g.id === 'emergency')!;
    s.contribs = [
      { id: 'a', goalId: 'emergency', date: '2026-10-10', amount: 100, cur: 'USD', rate: 60 },
      { id: 'b', goalId: 'emergency', date: '2026-10-11', amount: 200, cur: 'USD' },
    ];
    const p = goalProgress(s, emergency);
    expect(p.saved).toBe(300);
    // 100 × 60 fixed + 200 × 58.76 (the rate of the current month).
    expect(p.savedMain).toBeCloseTo(6000 + 200 * 58.76, 6);
    // Without its own rate it is the usual.
    s.contribs[0]!.rate = null;
    expect(goalProgress(s, emergency).savedMain).toBeCloseTo(300 * 58.76, 6);
  });

  it('third currency: the goal is converted as usual; only contribution → main currency uses its own rate', () => {
    const s = seedState();
    s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    s.goals.push({ id: 'try', name: 'Lira', cur: 'TRY', monthly: null, start: null, end: null, approxCur: null, sort: 9 });
    s.contribs = [{ id: 'a', goalId: 'try', date: '2026-10-10', amount: 100, cur: 'USD', rate: 60 }];
    const p = goalProgress(s, s.goals.at(-1)!);
    expect(p.saved).toBeCloseTo(4000, 8);
    expect(p.savedMain).toBeCloseTo(6000, 8);
  });
});

describe('origin account of a contribution', () => {
  it('it subtracts from its balance, in the currency of the account and with the rate of the contribution date', () => {
    const s = seedState();
    const dr = balanceOf(s, 'dr');
    const us = balanceOf(s, 'us');
    s.contribs = [{ id: 'a', goalId: 'emergency', date: '2026-10-10', amount: 100, cur: 'USD', accountId: 'dr' }];
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr - 100 * 58.76, 6);
    // In the same currency there is no conversion.
    s.contribs[0]!.accountId = 'us';
    expect(balanceOf(s, 'us')).toBeCloseTo(us - 100, 8);
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr, 8);
  });

  it('with its own rate, a contribution toward a main-currency account subtracts at that rate; without an account it moves nothing', () => {
    const s = seedState();
    const dr = balanceOf(s, 'dr');
    s.contribs = [{ id: 'a', goalId: 'emergency', date: '2026-10-10', amount: 100, cur: 'USD', accountId: 'dr', rate: 60 }];
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr - 6000, 8);
    s.contribs[0]!.accountId = null;
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr, 8);
    // A contribution later than the month being viewed does not count yet.
    s.contribs[0]!.accountId = 'dr';
    s.contribs[0]!.date = '2026-11-02';
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr, 8);
  });
});
