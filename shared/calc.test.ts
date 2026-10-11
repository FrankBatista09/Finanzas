import { describe, expect, it } from 'vitest';
import {
  balances,
  budgetHistory,
  budgetRaised,
  budgetsFromLog,
  convert,
  convertOn,
  currentKey,
  defaultAccount,
  donut,
  FEE_CATEGORY,
  goalsProgress,
  incomeRows,
  leftoverFor,
  monthCalc,
  openingFor,
  rateFor,
  ring,
  totalSaved,
  transferFees,
} from './calc';
import { f0, f2 } from './format';
import { clampToMonth, firstDay, inMonth, lastDay } from './month';
import { seedState, setBudgets } from './seed';
import type { AppState } from './types';

// The month's figures are those of the design prototype (same expenses, same budget, same rate);
// the balances and the incomes come from the accounts model, worked out by hand in the comments.

describe('monthCalc · October 2026 (current month, main currency DOP)', () => {
  const s = seedState();
  const c = monthCalc(s, '2026-10');

  it('the month rate is the one typed by hand', () => {
    expect(c.main).toBe('DOP');
    expect(c.second).toBe('USD');
    // The last one of the month: the one from the 6th.
    expect(c.rate).toEqual({ rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('fixed expenses: 6 of 11 paid · total 42,025.57', () => {
    expect(c.paidCount).toBe(6);
    expect(c.fixedCount).toBe(11);
    expect(f2(c.fixedAll)).toBe('42,025.57');
  });

  it('used = paid fixed expenses + transactions', () => {
    // Paid: 1,337.15 + 2,699 + 5,640 + 15,000 + Claude 106 USD × 58.76 + 7,400
    expect(c.fixedPaid).toBeCloseTo(38304.71, 6);
    expect(c.varSpent).toBe(10845);
    expect(f2(c.used)).toBe('49,149.71');
    expect(f2(c.usedSecond!)).toBe('836.45');
    expect(f2(c.avail)).toBe('20,850.29');
    expect(f2(c.pending)).toBe('3,720.86');
    expect(f2(c.after)).toBe('17,129.43');
    expect(c.free).toBeCloseTo(c.after, 10);
  });

  it('budget = sum of the parts per account', () => {
    expect(c.budget).toBe(70000);
    expect(f2(c.budgetSecond!)).toBe('1,191.29');
    expect(c.budgetParts.map((p) => [p.account.id, p.amount, p.inMain])).toEqual([
      ['us', 0, 0],
      ['dr', 70000, 70000],
    ]);
    // It all comes from the log (65,000 initial + 5,000 adjustment): no income raises the budget.
    expect(c.budgetParts.map((p) => [p.fromLog, p.fromIncomes])).toEqual([
      [0, 0],
      [70000, 0],
    ]);
  });

  it('a budget part in another currency is converted with the month rate', () => {
    const t = seedState();
    setBudgets(t.months['2026-10']!, { us: 200, dr: 58248 });
    const tc = monthCalc(t, '2026-10');
    expect(tc.budget).toBeCloseTo(200 * 58.76 + 58248, 8);
    expect(tc.budget).toBeCloseTo(70000, 8);
  });

  it('month income = sum of the recorded incomes', () => {
    expect(c.income).toBeCloseTo(5800 * 58.76, 8);
    expect(f2(c.incomeLeft)).toBe('291,658.29');
    expect(c.saved).toBeCloseTo(3500 * 58.76, 8);
  });

  it('by category: fixed expenses first and the rest from largest to smallest', () => {
    expect(c.categories.map((x) => x.name)).toEqual(['Fixed expenses', 'Groceries', 'Transport', 'Food', 'Health', 'Entertainment']);
    expect(c.categories[0]!.fixed).toBe(true);
    expect(c.catMax).toBeCloseTo(c.fixedPaid, 10);
  });

  it('donut: the segments are chained and the scale is the budget', () => {
    const dn = donut(c);
    const circ = 2 * Math.PI * 64;
    const len = (seg: { dash: string }) => +seg.dash.split(' ')[0]!;
    expect(dn.fixed.offset).toBe(-0);
    expect(dn.variable.offset).toBeCloseTo(-len(dn.fixed), 10);
    expect(dn.pending.offset).toBeCloseTo(-(len(dn.fixed) + len(dn.variable)), 10);
    expect(len(dn.fixed) + len(dn.variable) + len(dn.pending)).toBeCloseTo(((c.used + c.pending) / 70000) * circ, 8);
  });
});

describe('rateFor', () => {
  it('with no typed rate it uses the weighted average of the transfers of the month', () => {
    const s = seedState();
    const aug = rateFor(s, '2026-08', 'USD', 'DOP');
    expect(aug.source).toBe('transfers');
    expect(aug.rate).toBeCloseTo((1500 * 58.4 + 300 * 57.1) / 1800, 10);
    expect(rateFor(s, '2026-09', 'USD', 'DOP').rate).toBeCloseTo((1500 * 58.55 + 800 * 58.62) / 2300, 10);
  });

  it('the one typed by hand wins over the transfers, and also holds in reverse', () => {
    const s = seedState();
    s.months['2026-08']!.rates = [{ from: 'USD', to: 'DOP', rate: 60, date: '2026-08-01' }];
    expect(rateFor(s, '2026-08', 'USD', 'DOP')).toEqual({ rate: 60, source: 'month', monthKey: '2026-08', date: '2026-08-01' });
    expect(rateFor(s, '2026-08', 'DOP', 'USD').rate).toBeCloseTo(1 / 60, 12);
    expect(rateFor(s, '2026-08', 'DOP', 'DOP')).toEqual({ rate: 1, source: 'same', monthKey: null, date: null });
  });

  it('a transfer in the opposite direction also counts toward the average', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [];
    // 1,500 USD → 88,140 DOP and 58,000 DOP → 1,000 USD: 2,500 USD went out in total against 146,140 DOP.
    s.months['2026-10']!.transfers.push({
      id: 'back', monthKey: '2026-10', date: '2026-10-09', via: 'Bank', fromAccountId: 'dr', toAccountId: 'us', amount: 58000, rate: 1 / 58, budget: false, fee: 0,
    });
    expect(rateFor(s, '2026-10', 'USD', 'DOP').rate).toBeCloseTo(146140 / 2500, 8);
  });

  it('crosses through the third currency when the pair has no rate of its own', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
    ];
    const r = rateFor(s, '2026-10', 'TRY', 'DOP');
    expect(r.source).toBe('cross');
    expect(r.rate).toBeCloseTo(60 / 40, 12);
    expect(convert(s, '2026-10', 1000, 'TRY', 'DOP')).toBeCloseTo(1500, 9);
  });

  it('if the month has none, it uses the most recent earlier month; if none does, the default value', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [];
    s.months['2026-10']!.transfers = [];
    const oct = rateFor(s, '2026-10', 'USD', 'DOP');
    expect(oct.source).toBe('previous');
    expect(oct.monthKey).toBe('2026-09');
    expect(oct.rate).toBeCloseTo(rateFor(s, '2026-09', 'USD', 'DOP').rate, 12);

    expect(rateFor(s, '2026-10', 'USD', 'TRY')).toEqual({ rate: 42, source: 'default', monthKey: null, date: null });
    expect(rateFor(s, '2026-01', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'default', monthKey: null, date: null });
    expect(rateFor(s, '2026-01', 'TRY', 'DOP').rate).toBeCloseTo(58.76 / 42, 12);
  });

  it('accepts months with no record: the last typed one is still in effect', () => {
    const s = seedState();
    expect(rateFor(s, '2027-03', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'previous', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('a typed rate of 0 or a negative one is ignored', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 0, date: '2026-10-01' }];
    expect(rateFor(s, '2026-10', 'USD', 'DOP').source).toBe('transfers');
  });
});

// October with two USD→DOP rates: 58 from the 1st and 60 from the 5th. The figures below come from that.
function twoRates(): AppState {
  const s = seedState();
  s.months['2026-10']!.rates = [
    { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
    { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
  ];
  return s;
}

const usdTx = (s: AppState, id: string, date: string, amount: number) => ({
  ...s.months['2026-10']!.tx[0]!,
  id,
  date,
  amount,
  cur: 'USD' as const,
  accountId: 'dr',
});

describe('dated rates: each row is converted with the one in effect on ITS date', () => {
  it('rateFor with a date gives the last one typed up to that day; without a date, the last one of the month', () => {
    const s = twoRates();
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-01')).toEqual({ rate: 58, source: 'month', monthKey: '2026-10', date: '2026-10-01' });
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-04')).toEqual({ rate: 58, source: 'month', monthKey: '2026-10', date: '2026-10-01' });
    // The new one already applies on the very day it is typed.
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-05')).toEqual({ rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-05' });
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-31').rate).toBe(60);
    expect(rateFor(s, '2026-10', 'USD', 'DOP')).toEqual({ rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-05' });
  });

  it('holds in both directions, whichever one it is typed in', () => {
    const s = twoRates();
    expect(rateFor(s, '2026-10', 'DOP', 'USD', '2026-10-04').rate).toBeCloseTo(1 / 58, 14);
    expect(rateFor(s, '2026-10', 'DOP', 'USD').rate).toBeCloseTo(1 / 60, 14);
    // Typed in reverse: 1 DOP = 0.016 USD from the 8th → 1 USD = 62.5 DOP.
    // (A state is not mutated after calculating with it: rates are memoized per object.)
    const t = twoRates();
    t.months['2026-10']!.rates.push({ from: 'DOP', to: 'USD', rate: 0.016, date: '2026-10-08' });
    expect(rateFor(t, '2026-10', 'USD', 'DOP', '2026-10-07').rate).toBe(60);
    expect(rateFor(t, '2026-10', 'USD', 'DOP', '2026-10-08')).toEqual({ rate: 62.5, source: 'month', monthKey: '2026-10', date: '2026-10-08' });
    expect(rateFor(t, '2026-10', 'DOP', 'USD', '2026-10-08').rate).toBe(0.016);
  });

  it('typing a new rate does not change what was converted in earlier transactions', () => {
    const s = twoRates();
    s.months['2026-10']!.tx.push(usdTx(s, 'early', '2026-10-02', 10), usdTx(s, 'late', '2026-10-06', 10));
    // 10 USD on the 2nd at 58 = 580; 10 USD on the 6th at 60 = 600.
    const before = monthCalc(s, '2026-10');
    expect(before.varSpent).toBeCloseTo(10845 + 580 + 600, 8);
    const drBefore = balances(s, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance;
    expect(drBefore).toBeCloseTo(220641.93 - 580 - 600, 6);

    // Today (the 8th) 62 is typed: both transactions are still worth the same, in the month and in the balance.
    const later: AppState = structuredClone(s);
    later.months['2026-10']!.rates.push({ from: 'USD', to: 'DOP', rate: 62, date: '2026-10-08' });
    const after = monthCalc(later, '2026-10');
    expect(after.varSpent).toBeCloseTo(10845 + 580 + 600, 8);
    expect(balances(later, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(drBefore, 8);
    // What belongs to the whole month does follow the last rate: Claude (106 USD, paid fixed expense) goes from 6,360 to 6,572.
    expect(before.fixedPaid).toBeCloseTo(32076.15 + 106 * 60, 6);
    expect(after.fixedPaid).toBeCloseTo(32076.15 + 106 * 62, 6);
    expect(after.rate!.rate).toBe(62);
    // And a transaction from that same day already uses the new one.
    later.months['2026-10']!.tx.push(usdTx(later, 'today', '2026-10-08', 10));
    expect(monthCalc(structuredClone(later), '2026-10').varSpent).toBeCloseTo(10845 + 580 + 600 + 620, 8);
  });

  it('incomes and contributions also use the rate of their date', () => {
    const s = twoRates();
    // Salary on the 1st at 58; a 100 USD payment on the 6th at 60.
    s.incomes.push({ id: 'late', date: '2026-10-06', desc: 'Gig', accountId: 'dr', amount: 100, cur: 'USD', budget: false });
    expect(monthCalc(s, '2026-10').income).toBeCloseTo(5800 * 58 + 100 * 60, 8);
    // 6,000 go into the DOP account.
    expect(balances(s, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(220641.93 + 6000, 6);
    // Contributions on the 3rd (3,500 USD) at 58; one of 5,800 DOP on the 3rd is 100 USD and on the 6th it would be 96.67.
    expect(monthCalc(s, '2026-10').saved).toBeCloseTo(3500 * 58, 8);
    s.contribs.push({ id: 'dop', goalId: 'emergency', date: '2026-10-03', amount: 5800, cur: 'DOP' });
    expect(goalsProgress(structuredClone(s)).find((g) => g.id === 'emergency')!.saved).toBeCloseTo(1200 + 100, 8);
    expect(convertOn(s, '2026-10-06', 5800, 'DOP', 'USD')).toBeCloseTo(5800 / 60, 10);
  });

  it('crosses months: the last typed one stays in effect until another is typed', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' }];
    s.months['2026-08']!.rates = [{ from: 'USD', to: 'DOP', rate: 57, date: '2026-08-10' }];
    // Before August 10 none is in effect: August's transfers.
    const early = rateFor(s, '2026-08', 'USD', 'DOP', '2026-08-05');
    expect(early).toEqual({ rate: (1500 * 58.4 + 300 * 57.1) / 1800, source: 'transfers', monthKey: '2026-08', date: null });
    expect(rateFor(s, '2026-08', 'USD', 'DOP', '2026-08-10')).toEqual({ rate: 57, source: 'month', monthKey: '2026-08', date: '2026-08-10' });
    // September typed none: August's applies (and not its own transfers), and it says when it is from.
    expect(rateFor(s, '2026-09', 'USD', 'DOP')).toEqual({ rate: 57, source: 'previous', monthKey: '2026-08', date: '2026-08-10' });
    expect(rateFor(s, '2026-09', 'USD', 'DOP', '2026-09-15').rate).toBe(57);
    // October too, up to and including the 4th; from the 5th, its own.
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-04')).toEqual({ rate: 57, source: 'previous', monthKey: '2026-08', date: '2026-08-10' });
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-05').rate).toBe(60);
    // A transaction from October 2 in USD: 10 × 57.
    s.months['2026-10']!.tx.push(usdTx(s, 'oct-2', '2026-10-02', 10));
    expect(monthCalc(structuredClone(s), '2026-10').varSpent).toBeCloseTo(10845 + 570, 8);
    // An unrecorded month (a November income): the last typed one.
    expect(rateFor(s, '2026-11', 'USD', 'DOP', '2026-11-03')).toEqual({ rate: 60, source: 'previous', monthKey: '2026-10', date: '2026-10-05' });
    // August's balance is still shown with August's last one, not October's.
    expect(rateFor(s, '2026-08', 'USD', 'DOP').rate).toBe(57);
  });

  it('with no typed rate in effect on that date: transfers of the month, crossed rate, previous month and default value', () => {
    const s = seedState();
    // October's only rate is from the 5th: on the 2nd none is in effect and the month's transfers apply (58.76).
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' }];
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-02')).toEqual({ rate: 58.76, source: 'transfers', monthKey: '2026-10', date: null });
    // No transfers in October: those of the previous month.
    s.months['2026-10']!.transfers = [];
    const sep = (1500 * 58.55 + 800 * 58.62) / 2300;
    expect(rateFor(structuredClone(s), '2026-10', 'USD', 'DOP', '2026-10-02')).toEqual({ rate: sep, source: 'previous', monthKey: '2026-09', date: null });
    // Nothing before: the default value.
    expect(rateFor(s, '2026-07', 'USD', 'DOP', '2026-07-15')).toEqual({ rate: 58.76, source: 'default', monthKey: null, date: null });

    // Crossed rate: USD→DOP 60 from the 5th and USD→TRY 40 from the 7th.
    const t = seedState();
    t.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-07' },
    ];
    expect(rateFor(t, '2026-10', 'TRY', 'DOP', '2026-10-07')).toEqual({ rate: 1.5, source: 'cross', monthKey: '2026-10', date: null });
    // On the 6th the TRY one does not apply yet and there is no other: default (58.76 ÷ 42).
    expect(rateFor(t, '2026-10', 'TRY', 'DOP', '2026-10-06')).toEqual({ rate: 58.76 / 42, source: 'default', monthKey: null, date: null });
    // On the 7th one leg is typed (USD→TRY) and so is the other; on the 3rd USD→DOP comes from the transfers (58.76) and TRY has nothing.
    expect(rateFor(t, '2026-10', 'USD', 'DOP', '2026-10-03').source).toBe('transfers');
    // One leg typed and the other from the month's transfers: typed TRY→USD (1/40) × USD→DOP from the transfers (58.76).
    t.months['2026-10']!.rates = [{ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' }];
    expect(rateFor(structuredClone(t), '2026-10', 'TRY', 'DOP', '2026-10-03')).toEqual({ rate: expect.closeTo(58.76 / 40, 10), source: 'cross', monthKey: '2026-10', date: null });
  });

  it('two rates for the same pair and the same date: the last one in the list applies', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 1 / 61, date: '2026-10-01' },
    ];
    expect(rateFor(s, '2026-10', 'USD', 'DOP').rate).toBeCloseTo(61, 10);
  });
});

describe('budget log', () => {
  it('budgetsFromLog adds up per account; what adds up to 0 does not appear', () => {
    expect(budgetsFromLog([])).toEqual({});
    expect(
      budgetsFromLog([
        { accountId: 'dr', amount: 65000 },
        { accountId: 'us', amount: 100 },
        { accountId: 'dr', amount: 5000.1 },
        { accountId: 'dr', amount: -0.1 },
        { accountId: 'us', amount: -100 },
      ]),
    ).toEqual({ dr: 70000 });
    expect(seedState().months['2026-10']!.budgets).toEqual({ dr: 70000 });
  });

  it('the month budget is the sum of the log, with negative adjustments and parts in another currency', () => {
    const s = seedState();
    // −100 USD in the US account on the 7th: 70,000 − 100 × 58.76 = 64,124.
    s.months['2026-10']!.budgetLog.push({ id: 'cut', date: '2026-10-07', accountId: 'us', amount: -100, kind: 'adjust', note: 'Less' });
    const c = monthCalc(s, '2026-10');
    expect(c.budget).toBeCloseTo(64124, 8);
    expect(c.budgetParts.map((p) => [p.account.id, p.amount, p.fromLog, p.fromIncomes])).toEqual([
      ['us', -100, -100, 0],
      ['dr', 70000, 70000, 0],
    ]);
    expect(c.avail).toBeCloseTo(64124 - 49149.71, 6);
    // calc reads the log, not Month.budgets (which was not recalculated here).
    expect(s.months['2026-10']!.budgets).toEqual({ dr: 70000 });
  });

  it('budgetHistory: the log in date order with the running total', () => {
    const s = seedState();
    expect(budgetHistory(s, '2026-10').map((h) => [h.date, h.kind, h.account.id, h.amount, h.note, h.inMain, h.total])).toEqual([
      ['2026-10-01', 'initial', 'dr', 65000, '', 65000, 65000],
      ['2026-10-05', 'adjust', 'dr', 5000, 'Car repair', 5000, 70000],
    ]);
    expect(budgetHistory(s, '2026-10').at(-1)!.total).toBe(monthCalc(s, '2026-10').budget);
    expect(budgetHistory(s, '2026-08').map((h) => [h.id, h.total])).toEqual([['seed-bg-2026-08-1', 70000]]);
    expect(budgetHistory(s, '2031-01')).toEqual([]);
  });
});

describe('incomes that raise the budget (Income.budget)', () => {
  it('in the currency of the account: raises the budget of the month of its date and only that one', () => {
    const s = seedState();
    s.incomes.push(
      { id: 'bonus', date: '2026-10-04', desc: 'Bonus', accountId: 'dr', amount: 3000, cur: 'DOP', budget: true },
      // Unchecked it raises nothing; checked but from September, it raises September.
      { id: 'plain', date: '2026-10-04', desc: 'Gift', accountId: 'dr', amount: 999, cur: 'DOP', budget: false },
      { id: 'sep', date: '2026-09-10', desc: 'Old bonus', accountId: 'dr', amount: 1000, cur: 'DOP', budget: true },
    );
    const c = monthCalc(s, '2026-10');
    expect(c.budget).toBe(73000);
    expect(c.budgetParts.find((p) => p.account.id === 'dr')).toMatchObject({ amount: 73000, fromLog: 70000, fromIncomes: 3000, inMain: 73000 });
    expect(f2(c.avail)).toBe('23,850.29');
    expect(f2(c.budgetSecond!)).toBe('1,242.34');
    expect(monthCalc(s, '2026-09').budget).toBe(71000);
    expect(monthCalc(s, '2026-08').budget).toBe(70000);
    // It is still an income: it goes into the account and counts in the month's income.
    expect(c.income).toBeCloseTo(5800 * 58.76 + 3999, 8);
    // Month.budgets is only the log.
    expect(s.months['2026-10']!.budgets).toEqual({ dr: 70000 });
  });

  it('in another currency: goes into the part of its account converted with the rate of its date', () => {
    const s = twoRates();
    s.incomes.push(
      // 100 USD to the DOP account on the 2nd (at 58) and on the 6th (at 60): 5,800 and 6,000 DOP.
      { id: 'a', date: '2026-10-02', desc: 'Gig A', accountId: 'dr', amount: 100, cur: 'USD', budget: true },
      { id: 'b', date: '2026-10-06', desc: 'Gig B', accountId: 'dr', amount: 100, cur: 'USD', budget: true },
      // 50 USD to the USD account: 50 USD in its part, 3,000 DOP with the last rate of the month.
      { id: 'c', date: '2026-10-03', desc: 'Refund', accountId: 'us', amount: 50, cur: 'USD', budget: true },
    );
    const c = monthCalc(s, '2026-10');
    expect(c.budgetParts.map((p) => [p.account.id, p.amount, p.fromLog, p.fromIncomes, p.inMain])).toEqual([
      ['us', 50, 0, 50, 3000],
      ['dr', 81800, 70000, 11800, 81800],
    ]);
    expect(c.budget).toBe(84800);
    expect(c.budgetSecond).toBeCloseTo(84800 / 60, 8);

    expect(budgetHistory(s, '2026-10').map((h) => [h.date, h.kind, h.id, h.account.id, h.amount, h.note, h.total])).toEqual([
      ['2026-10-01', 'initial', 'seed-bg-2026-10-1', 'dr', 65000, '', 65000],
      ['2026-10-02', 'income', 'a', 'dr', 5800, 'Gig A', 70800],
      ['2026-10-03', 'income', 'c', 'us', 50, 'Refund', 73800],
      ['2026-10-05', 'adjust', 'seed-bg-2026-10-2', 'dr', 5000, 'Car repair', 78800],
      ['2026-10-06', 'income', 'b', 'dr', 6000, 'Gig B', 84800],
    ]);
  });

  it('on the same date the log movements go first; anything from an account that does not exist does not count', () => {
    const s = seedState();
    s.incomes.push(
      { id: 'same-day', date: '2026-10-05', desc: '', accountId: 'dr', amount: 10, cur: 'DOP', budget: true },
      { id: 'ghost', date: '2026-10-05', desc: '', accountId: 'gone', amount: 500, cur: 'DOP', budget: true },
    );
    s.months['2026-10']!.budgetLog.push({ id: 'orphan', date: '2026-10-02', accountId: 'gone', amount: 500, kind: 'adjust', note: '' });
    expect(budgetHistory(s, '2026-10').map((h) => [h.kind, h.id, h.total])).toEqual([
      ['initial', 'seed-bg-2026-10-1', 65000],
      ['adjust', 'seed-bg-2026-10-2', 70000],
      ['income', 'same-day', 70010],
    ]);
    expect(monthCalc(s, '2026-10').budget).toBe(70010);
  });
});

describe('transfers that move budget (Transfer.budget)', () => {
  it('what leaves the origin part goes into the destination one: at the month rate, the total does not change', () => {
    const s = seedState();
    // Frank's case: the salary, 2,200 USD, budgeted in the US account; 1,500 USD of it go to the DR account
    // at 58.76 (the month rate) = 88,140 DOP.
    s.months['2026-10']!.budgetLog = [{ id: 'salary', date: '2026-10-01', accountId: 'us', amount: 2200, kind: 'initial', note: '' }];
    const before = monthCalc(s, '2026-10').budget;
    expect(before).toBeCloseTo(2200 * 58.76, 8);
    s.months['2026-10']!.transfers[0]!.budget = true;
    const c = monthCalc(s, '2026-10');
    expect(c.budgetParts.map((p) => [p.account.id, p.amount, p.fromLog, p.fromIncomes, p.fromTransfers])).toEqual([
      ['us', 700, 2200, 0, -1500],
      ['dr', 88140, 0, 0, 88140],
    ]);
    expect(c.budget).toBeCloseTo(before, 8);
    // Only its month: September's transfers are not checked.
    expect(monthCalc(s, '2026-09').budget).toBe(70000);
  });

  it('the origin part can go negative, and it shows even if the account has no log (or is hidden)', () => {
    const plain = seedState();
    const s = seedState();
    s.months['2026-10']!.transfers[0]!.budget = true;
    const c = monthCalc(s, '2026-10');
    expect(c.budgetParts.map((p) => [p.account.id, p.amount, p.fromLog, p.fromTransfers, p.inMain])).toEqual([
      ['us', -1500, 0, -1500, -1500 * 58.76],
      ['dr', 158140, 70000, 88140, 158140],
    ]);
    // At the month rate it creates no budget: the same as before, and the same available.
    expect(c.budget).toBeCloseTo(70000, 8);
    expect(c.avail).toBeCloseTo(monthCalc(plain, '2026-10').avail, 8);
    // The checkbox moves no money: the balances are the same as without it, and Month.budgets is still only the log.
    expect(balances(s, '2026-10')).toEqual(balances(plain, '2026-10'));
    expect(s.months['2026-10']!.budgets).toEqual({ dr: 70000 });
    // Hidden and with no log, the origin account still shows: budget was taken from it.
    s.accounts.find((a) => a.id === 'us')!.hidden = true;
    expect(monthCalc(s, '2026-10').budgetParts.map((p) => [p.account.id, p.amount])).toEqual([
      ['us', -1500],
      ['dr', 158140],
    ]);
  });

  it('between other currencies: each side in the currency of its account, and it counts in the month of its sheet', () => {
    const s = seedState();
    s.accounts.push({ id: 'tr', name: 'TR account', currency: 'TRY', opening: 0, hidden: false, sort: 2 });
    const october = s.months['2026-10']!;
    october.rates.push({ from: 'TRY', to: 'DOP', rate: 1.5, date: '2026-10-01' });
    october.transfers.push(
      // 100 USD → 4,000 TRY. Its date is in September, but it belongs to the October sheet: it moves October.
      { id: 'to-tr', monthKey: '2026-10', date: '2026-09-30', via: 'Wise', fromAccountId: 'us', toAccountId: 'tr', amount: 100, rate: 40, budget: true, fee: 0 },
      // 5,876 DOP → 100 USD: lowers the DR account by 5,876 DOP and raises the US account by 100 USD.
      { id: 'to-us', monthKey: '2026-10', date: '2026-10-06', via: 'Bank', fromAccountId: 'dr', toAccountId: 'us', amount: 5876, rate: 1 / 58.76, budget: true, fee: 0 },
      // Unchecked it does not count; to an account that no longer exists, only the side that does exist.
      { id: 'plain', monthKey: '2026-10', date: '2026-10-06', via: 'Bank', fromAccountId: 'us', toAccountId: 'tr', amount: 10, rate: 40, budget: false, fee: 0 },
      { id: 'ghost', monthKey: '2026-10', date: '2026-10-06', via: 'Bank', fromAccountId: 'us', toAccountId: 'gone', amount: 10, rate: 40, budget: true, fee: 0 },
    );
    const c = monthCalc(s, '2026-10');
    const parts = c.budgetParts.map((p) => [p.account.id, p.fromLog, Math.round(p.fromTransfers * 1e6) / 1e6, Math.round(p.amount * 1e6) / 1e6]);
    expect(parts).toEqual([
      ['us', 0, -10, -10],
      ['dr', 70000, -5876, 64124],
      ['tr', 0, 4000, 4000],
    ]);
    // −10 USD × 58.76 + 64,124 DOP + 4,000 TRY × 1.5
    expect(c.budget).toBeCloseTo(-587.6 + 64124 + 6000, 6);
    expect(monthCalc(s, '2026-09').budget).toBe(70000);

    // Each transfer in two rows: what leaves the origin account and what goes into the destination one.
    const history = budgetHistory(s, '2026-10');
    expect(
      history.map((h) => [h.date, h.kind, h.id, h.side, h.account.id, Math.round(h.amount * 100) / 100, h.note, Math.round(h.total * 100) / 100]),
    ).toEqual([
      ['2026-09-30', 'transfer', 'to-tr', 'out', 'us', -100, 'Wise', -5876],
      ['2026-09-30', 'transfer', 'to-tr', 'in', 'tr', 4000, 'Wise', 124],
      ['2026-10-01', 'initial', 'seed-bg-2026-10-1', undefined, 'dr', 65000, '', 65124],
      ['2026-10-05', 'adjust', 'seed-bg-2026-10-2', undefined, 'dr', 5000, 'Car repair', 70124],
      ['2026-10-06', 'transfer', 'to-us', 'out', 'dr', -5876, 'Bank', 64248],
      ['2026-10-06', 'transfer', 'to-us', 'in', 'us', 100, 'Bank', 70124],
      ['2026-10-06', 'transfer', 'ghost', 'out', 'us', -10, 'Bank', 69536.4],
    ]);
    expect(history.at(-1)!.total).toBeCloseTo(c.budget, 8);
  });

  it('on the same date: the log, then the incomes and then the transfers', () => {
    const s = seedState();
    s.months['2026-10']!.transfers.push({
      id: 'same-day', monthKey: '2026-10', date: '2026-10-05', via: 'Cash', fromAccountId: 'us', toAccountId: 'dr', amount: 1, rate: 60, budget: true, fee: 0,
    });
    s.incomes.push({ id: 'gift', date: '2026-10-05', desc: 'Gift', accountId: 'dr', amount: 10, cur: 'DOP', budget: true });
    // −1 USD (58.76 DOP) and +60 DOP: a transfer at a better rate than the month's leaves the difference.
    expect(budgetHistory(s, '2026-10').map((h) => [h.kind, h.id, Math.round(h.total * 100) / 100])).toEqual([
      ['initial', 'seed-bg-2026-10-1', 65000],
      ['adjust', 'seed-bg-2026-10-2', 70000],
      ['income', 'gift', 70010],
      ['transfer', 'same-day', 69951.24],
      ['transfer', 'same-day', 70011.24],
    ]);
  });

  it('budgetRaised: what incomes and transfers put on top of the log of an account, in its currency (the net of the transfers)', () => {
    const s = seedState();
    s.months['2026-10']!.transfers[0]!.budget = true;
    s.incomes.push({ id: 'gig', date: '2026-10-03', desc: 'Gig', accountId: 'dr', amount: 100, cur: 'USD', budget: true });
    // 88,140 from the transfer + 100 USD at 58.76.
    expect(budgetRaised(s, '2026-10', 'dr')).toBeCloseTo(88140 + 5876, 8);
    // The amount transferred leaves the origin account.
    expect(budgetRaised(s, '2026-10', 'us')).toBe(-1500);
    expect(budgetRaised(s, '2026-09', 'dr')).toBe(0);
    expect(budgetRaised(s, '2026-10', 'gone')).toBe(0);
    expect(budgetRaised(s, '2030-01', 'dr')).toBe(0);
    for (const part of monthCalc(s, '2026-10').budgetParts) {
      expect(part.amount - part.fromLog).toBeCloseTo(budgetRaised(s, '2026-10', part.account.id), 8);
    }
  });
});

describe('fee of a transfer (Transfer.fee)', () => {
  /** The sample data with a 2.99 USD fee on the October transfer (1,500 USD to the DR account, on the 2nd). */
  const withFee = (fee = 2.99) => {
    const s = seedState();
    s.months['2026-10']!.transfers[0]!.fee = fee;
    return s;
  };

  it('subtracts from the origin account, in its currency and unconverted; the destination one is not touched', () => {
    const plain = balances(seedState(), '2026-10').accounts;
    const after = balances(withFee(), '2026-10').accounts;
    expect(after[0]!.balance).toBeCloseTo(plain[0]!.balance - 2.99, 10);
    expect(after[1]!.balance).toBe(plain[1]!.balance);
    // And it keeps subtracting in later months, not in earlier ones.
    expect(balances(withFee(), '2026-09').accounts[0]!.balance).toBe(balances(seedState(), '2026-09').accounts[0]!.balance);
  });

  it('counts as a transaction of the month: in used, in the count, in "Other" and in available', () => {
    const plain = monthCalc(seedState(), '2026-10');
    const c = monthCalc(withFee(), '2026-10');
    // With the rate in effect on the day of the transfer (58.76).
    const fee = 2.99 * 58.76;
    expect(c.varSpent - plain.varSpent).toBeCloseTo(fee, 10);
    expect(c.used - plain.used).toBeCloseTo(fee, 10);
    expect(c.avail - plain.avail).toBeCloseTo(-fee, 10);
    expect(c.txCount).toBe(plain.txCount + 1);
    expect(c.categories.find((cat) => cat.name === FEE_CATEGORY)!.value).toBeCloseTo(fee, 10);
    expect(FEE_CATEGORY).toBe('Other');
    // It does not touch the budget, not even if the transfer moves it: only `amount` is moved.
    expect(c.budget).toBe(plain.budget);
    const moving = withFee();
    moving.months['2026-10']!.transfers[0]!.budget = true;
    expect(monthCalc(moving, '2026-10').budgetParts.find((p) => p.account.id === 'us')!.fromTransfers).toBe(-1500);
  });

  it('transferFees: one row per transfer with a fee, in the currency of its origin account and with its date', () => {
    const s = withFee();
    s.accounts.push({ id: 'tr', name: 'TR account', currency: 'TRY', opening: 0, hidden: false, sort: 2 });
    const october = s.months['2026-10']!;
    october.rates.push({ from: 'TRY', to: 'DOP', rate: 1.5, date: '2026-10-01' });
    october.transfers.push(
      { id: 'from-tr', monthKey: '2026-10', date: '2026-10-08', via: 'Wise', fromAccountId: 'tr', toAccountId: 'dr', amount: 1000, rate: 1.5, budget: false, fee: 20 },
      // With no fee, or from an account that no longer exists (its currency is unknown): they do not show.
      { id: 'free', monthKey: '2026-10', date: '2026-10-08', via: 'Cash', fromAccountId: 'us', toAccountId: 'dr', amount: 1, rate: 58, budget: false, fee: 0 },
      { id: 'ghost', monthKey: '2026-10', date: '2026-10-08', via: 'Cash', fromAccountId: 'gone', toAccountId: 'dr', amount: 1, rate: 58, budget: false, fee: 5 },
    );
    expect(transferFees(s, '2026-10').map((f) => [f.transferId, f.date, f.via, f.account.id, f.amount, f.cur])).toEqual([
      ['seed-tr-2026-10-1', '2026-10-02', 'Remitly', 'us', 2.99, 'USD'],
      ['from-tr', '2026-10-08', 'Wise', 'tr', 20, 'TRY'],
    ]);
    // The one in lira, at the rate of its date: 20 × 1.5 DOP.
    expect(monthCalc(s, '2026-10').varSpent - monthCalc(withFee(), '2026-10').varSpent).toBeCloseTo(30, 10);
    expect(transferFees(s, '2026-09')).toEqual([]);
    expect(transferFees(s, '2030-01')).toEqual([]);
  });
});

describe('leftover from the previous month (leftoverFor)', () => {
  // September: budget 70,000; used = fixed expenses in DOP 35,872.66 + Claude 106 USD × (134,721 ÷ 2,300) + transactions 24,555.
  const SEP_LEFT = 70000 - (35872.66 + (106 * 134721) / 2300 + 24555);

  it('is the available amount (budget − used) of the previous recorded month, in the main currency', () => {
    const s = seedState();
    expect(monthCalc(s, '2026-09').avail).toBeCloseTo(SEP_LEFT, 6);
    expect(f2(SEP_LEFT)).toBe('3,363.46');
    const left = leftoverFor(s, '2026-10');
    expect(left.previousKey).toBe('2026-09');
    expect(left.leftover).toBeCloseTo(SEP_LEFT, 6);
    expect(left.added).toBe(false);
  });

  it('with no previous month there is no leftover; the previous one is the closest recorded month, even if months are missing', () => {
    const s = seedState();
    expect(leftoverFor(s, '2026-08')).toEqual({ previousKey: null, leftover: null, added: false });
    // December does not exist (nor November): its previous month is October, with 20,850.29 available.
    const dec = leftoverFor(s, '2026-12');
    expect(dec.previousKey).toBe('2026-10');
    expect(f2(dec.leftover!)).toBe('20,850.29');
    expect(dec.added).toBe(false);
  });

  it('`added` says whether the month already has its leftover movement; a negative one subtracts', () => {
    const s = seedState();
    s.months['2026-10']!.budgetLog.push({ id: 'left', date: '2026-10-02', accountId: 'dr', amount: SEP_LEFT, kind: 'leftover', note: '' });
    expect(leftoverFor(s, '2026-10').added).toBe(true);
    expect(monthCalc(s, '2026-10').budget).toBeCloseTo(70000 + SEP_LEFT, 6);
    expect(budgetHistory(s, '2026-10').map((h) => h.kind)).toEqual(['initial', 'leftover', 'adjust']);

    // September with a 60,000 budget went over: negative leftover.
    const over = seedState();
    setBudgets(over.months['2026-09']!, { dr: 60000 });
    expect(leftoverFor(over, '2026-10').leftover).toBeCloseTo(SEP_LEFT - 10000, 6);
    expect(leftoverFor(over, '2026-10').leftover).toBeLessThan(0);
  });

  it('the leftover includes what incomes added to the budget of that month', () => {
    const s = seedState();
    s.incomes.push({ id: 'sep', date: '2026-09-10', desc: '', accountId: 'dr', amount: 1000, cur: 'DOP', budget: true });
    expect(leftoverFor(s, '2026-10').leftover).toBeCloseTo(SEP_LEFT + 1000, 6);
  });
});

describe('"≈" currency of a goal (Goal.approxCur)', () => {
  it('null = the main currency: savedApprox is savedMain', () => {
    const turkey = goalsProgress(seedState()).find((g) => g.id === 'turkey')!;
    expect(turkey.approxCur).toBe('DOP');
    expect(turkey.savedApprox).toBeCloseTo(9000 * 58.76, 8);
    expect(turkey.savedApprox).toBe(turkey.savedMain);
  });

  it('another currency: what is saved is expressed in it with the last rate of the current month; savedMain does not change', () => {
    const s = seedState();
    s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-02' });
    s.goals.find((g) => g.id === 'turkey')!.approxCur = 'TRY';
    const turkey = goalsProgress(s).find((g) => g.id === 'turkey')!;
    expect(turkey.approxCur).toBe('TRY');
    expect(turkey.savedApprox).toBeCloseTo(360000, 8);
    expect(turkey.savedMain).toBeCloseTo(9000 * 58.76, 8);
    expect(totalSaved(s)).toBeCloseTo(10650 * 58.76, 6);
  });

  it('it can be the currency of the goal itself: the same figure', () => {
    const s = seedState();
    s.goals.find((g) => g.id === 'turkey')!.approxCur = 'USD';
    const turkey = goalsProgress(s).find((g) => g.id === 'turkey')!;
    expect([turkey.cur, turkey.approxCur, turkey.saved, turkey.savedApprox]).toEqual(['USD', 'USD', 9000, 9000]);
  });
});

describe('dates within the month', () => {
  it('firstDay, lastDay, inMonth and clampToMonth', () => {
    expect(firstDay('2026-10')).toBe('2026-10-01');
    expect([lastDay('2026-10'), lastDay('2026-02'), lastDay('2028-02'), lastDay('2026-12')]).toEqual(['2026-10-31', '2026-02-28', '2028-02-29', '2026-12-31']);
    expect([inMonth('2026-10-31', '2026-10'), inMonth('2026-11-01', '2026-10')]).toEqual([true, false]);
    expect(clampToMonth('2026-10-08', '2026-10')).toBe('2026-10-08');
    expect(clampToMonth('2026-09-30', '2026-10')).toBe('2026-10-01');
    expect(clampToMonth('2027-01-02', '2026-11')).toBe('2026-11-30');
  });
});

describe('balances: everything moves the balances', () => {
  const s = seedState();

  it('balance = opening + incomes − expenses paid from the account ± transfers', () => {
    const b = balances(s, '2026-10');
    const us = b.accounts.find((a) => a.account.id === 'us')!;
    const dr = b.accounts.find((a) => a.account.id === 'dr')!;
    // US: 2,000 + 3 × 5,800 − transfers (1,800 + 2,300 + 1,500) − Claude 106 × 3 months paid
    expect(us.balance).toBeCloseTo(2000 + 17400 - 5600 - 318, 8);
    // DR: 60,000 + received (104,730 + 134,721 + 88,140) − transactions (27,850 + 24,555 + 10,845)
    //     − fixed expenses paid in DOP (35,750.26 + 35,872.66 + 32,076.15)
    expect(dr.balance).toBeCloseTo(60000 + 327591 - 63250 - 103699.07, 6);
    expect(f2(dr.balance)).toBe('220,641.93');
    expect(us.inMain).toBeCloseTo(13482 * 58.76, 6);
    expect(f2(b.totalMain)).toBe('1,012,844.25');
    expect(b.totalSecond).toBeCloseTo(13482 + 220641.93 / 58.76, 6);
  });

  it('at the end of an earlier month only what happened up to that month counts, with its rates', () => {
    const b = balances(s, '2026-08');
    const us = b.accounts.find((a) => a.account.id === 'us')!;
    const dr = b.accounts.find((a) => a.account.id === 'dr')!;
    expect(us.balance).toBeCloseTo(2000 + 5800 - 1800 - 106, 8);
    expect(dr.balance).toBeCloseTo(60000 + 104730 - 27850 - 35750.26, 6);
    expect(us.inMain).toBeCloseTo(us.balance * ((1500 * 58.4 + 300 * 57.1) / 1800), 6);
  });

  it('a fixed expense only subtracts while it is paid', () => {
    const t = seedState();
    const before = balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance;
    t.months['2026-10']!.fixed.find((f) => f.name === 'Netflix')!.paid = true;
    expect(balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(before - 1137.3, 8);
  });

  it('an expense in another currency subtracts from the account converted with the rate of its month', () => {
    const t = seedState();
    const before = balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance;
    t.months['2026-10']!.tx.push({ ...t.months['2026-10']!.tx[0]!, id: 'usd-from-dr', amount: 10, cur: 'USD', accountId: 'dr' });
    expect(balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(before - 587.6, 8);
  });

  it('hidden accounts do not add to the total; a movement with no account is ignored', () => {
    const t = seedState();
    const all = balances(t, '2026-10').totalMain;
    t.accounts.find((a) => a.id === 'us')!.hidden = true;
    const b = balances(t, '2026-10');
    expect(b.accounts).toHaveLength(2);
    expect(b.totalMain).toBeCloseTo(all - 13482 * 58.76, 6);
    t.incomes.push({ id: 'ghost', date: '2026-10-05', desc: '', accountId: 'gone', amount: 999, cur: 'USD', budget: false });
    expect(balances(t, '2026-10').totalMain).toBeCloseTo(b.totalMain, 8);
  });

  it('openingFor: correcting a balance means moving the opening balance by whatever it takes', () => {
    const t = seedState();
    const opening = openingFor(t, 'dr', '2026-10', 200000);
    expect(opening).toBeCloseTo(60000 + (200000 - 220641.93), 6);
    t.accounts.find((a) => a.id === 'dr')!.opening = opening;
    expect(balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(200000, 6);
  });

  it('defaultAccount: the chosen one, or the first visible one in the main currency', () => {
    const t = seedState();
    expect(defaultAccount(t)!.id).toBe('dr');
    t.defaultAccountId = null;
    expect(defaultAccount(t)!.id).toBe('dr');
    t.mainCurrency = 'TRY';
    expect(defaultAccount(t)!.id).toBe('us');
    t.defaultAccountId = 'dr';
    t.accounts.find((a) => a.id === 'dr')!.hidden = true;
    expect(defaultAccount(t)!.id).toBe('us');
    t.accounts = [];
    expect(defaultAccount(t)).toBeNull();
  });
});

describe('another main currency', () => {
  const tryState = (): AppState => {
    const s = seedState();
    s.mainCurrency = 'TRY';
    s.secondCurrency = 'USD';
    s.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
    ];
    return s;
  };

  it('the whole month is expressed in the main currency', () => {
    const c = monthCalc(tryState(), '2026-10');
    expect(c.main).toBe('TRY');
    expect(c.rate!.rate).toBe(40);
    expect(c.budget).toBeCloseTo((70000 / 58.76) * 40, 6);
    expect(c.varSpent).toBeCloseTo((10845 / 58.76) * 40, 6);
    expect(c.usedSecond).toBeCloseTo(49149.71 / 58.76, 4);
    expect(c.income).toBeCloseTo(5800 * 40, 8);
  });
});

describe('savings', () => {
  const s = seedState();

  it('current month = last open month', () => {
    expect(currentKey(s)).toBe('2026-10');
  });

  it('Trip to Turkey: 15 months × 3,000 = 45,000 USD', () => {
    const turkey = goalsProgress(s).find((g) => g.id === 'turkey')!;
    expect(turkey.cur).toBe('USD');
    expect(turkey.saved).toBe(9000);
    expect(turkey.savedMain).toBeCloseTo(9000 * 58.76, 8);
    expect(f0(turkey.target!.targetAmount)).toBe('45,000');
    expect(turkey.target!.pct).toBeCloseTo(20, 10);
    // October already has a contribution: nov-2026..oct-2027 are left = 12 contributions of 3,000.
    expect(turkey.target!.left).toBe(12);
    expect(turkey.target!.needPerMonth).toBe(3000);
  });

  it('a contribution in another currency is converted to the currency of the goal with the rate of its month', () => {
    const t = seedState();
    t.contribs.push({ id: 'dop', goalId: 'emergency', date: '2026-10-08', amount: 5876, cur: 'DOP' });
    expect(goalsProgress(t).find((g) => g.id === 'emergency')!.saved).toBeCloseTo(1200 + 100, 8);
  });

  it('a goal in another currency keeps what is saved and the target in its own', () => {
    const t = seedState();
    t.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    t.goals.push({ id: 'tr', name: 'Istanbul flat', cur: 'TRY', monthly: 10000, start: '2026-10', end: '2027-09', approxCur: null, sort: 3 });
    t.contribs.push({ id: 'c-tr', goalId: 'tr', date: '2026-10-05', amount: 100, cur: 'USD' });
    const g = goalsProgress(t).find((x) => x.id === 'tr')!;
    expect(g.saved).toBeCloseTo(4000, 8);
    expect(g.target!.targetAmount).toBe(120000);
    expect(g.savedMain).toBeCloseTo(100 * 58.76, 6);
  });

  it('goals with variable contributions have no target', () => {
    const [emergency, personal] = goalsProgress(s);
    expect(emergency!.target).toBeNull();
    expect(emergency!.saved).toBe(1200);
    expect(emergency!.contribCount).toBe(3);
    expect(personal!.saved).toBe(450);
  });

  it('incomes per month and total saved, in the main currency', () => {
    const rows = incomeRows(s);
    expect(rows.map((r) => r.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    const augRate = (1500 * 58.4 + 300 * 57.1) / 1800;
    expect(rows[0]!.income).toBeCloseTo(5800 * augRate, 6);
    expect(rows[0]!.saved).toBeCloseTo(3650 * augRate, 6);
    expect(rows[0]!.pct).toBeCloseTo((3650 / 5800) * 100, 8);
    expect(totalSaved(s)).toBeCloseTo(10650 * 58.76, 6);
    const t = seedState();
    t.incomes = [];
    expect(incomeRows(t)[0]!.pct).toBeNull();
  });
});

describe('ring and format', () => {
  it('ring: one segment per value, chained; negative and non-finite ones take no space', () => {
    const circ = 2 * Math.PI * 64;
    const [a, b, c] = ring([50, -10, 50]);
    const len = (seg: { dash: string }) => +seg.dash.split(' ')[0]!;
    expect(len(a!)).toBeCloseTo(circ / 2, 8);
    expect(len(b!)).toBe(0);
    expect(c!.offset).toBeCloseTo(-circ / 2, 8);
    expect(len(ring([0, Number.NaN])[0]!)).toBe(0);
  });

  it('es-DO without depending on the runtime locale', () => {
    expect(f2(1234567.891)).toBe('1,234,567.89');
    expect(f2(-1234.5)).toBe('-1,234.50');
    expect(f2(-0.001)).toBe('0.00');
    expect(f2(Number.NaN)).toBe('0.00');
    expect(f0(999.5)).toBe('1,000');
    expect(f0(-0.4)).toBe('0');
  });
});

describe('without a second currency', () => {
  const none: AppState = { ...seedState(), secondCurrency: null };

  it('monthCalc and balances give no figures in the second currency; those in the main one do not change', () => {
    const c = monthCalc(none, '2026-10');
    const full = monthCalc(seedState(), '2026-10');
    expect(c).toMatchObject({ second: null, rate: null, usedSecond: null, budgetSecond: null });
    expect([c.budget, c.used, c.avail, c.income]).toEqual([full.budget, full.used, full.avail, full.income]);
    const b = balances(none, '2026-10');
    expect(b.totalSecond).toBeNull();
    expect(b.accounts.every((a) => a.inSecond === null && a.valued)).toBe(true);
    expect(b.totalMain).toBeCloseTo(balances(seedState(), '2026-10').totalMain, 8);
  });

  it('convert and rateFor still cross through the main currency; incomeRows carries no rate', () => {
    expect(convert(none, '2026-10', 100, 'USD', 'DOP')).toBeCloseTo(5876, 8);
    expect(incomeRows(none).every((r) => r.rate === null)).toBe(true);
  });
});
