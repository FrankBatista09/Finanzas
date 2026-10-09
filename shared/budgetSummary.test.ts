import { describe, expect, it } from 'vitest';
import { budgetSummary, monthCalc } from './calc';
import { seedState } from './seed';

// seedState October 2026: initial 65,000 DOP (day 1) and a +5,000 'Car repair' adjustment (day 5); 1 USD = 58.76 DOP.
describe('budgetSummary', () => {
  it('the seed month: initial, one addition, total and what is left', () => {
    const s = seedState();
    const b = budgetSummary(s, '2026-10');
    const c = monthCalc(s, '2026-10');
    expect(b.initial).toBe(65000);
    expect(b.additions.map((l) => [l.date, l.accountId, l.amount, l.currency, l.note, l.inMain])).toEqual([
      ['2026-10-05', 'dr', 5000, 'DOP', 'Car repair', 5000],
    ]);
    expect(b.added).toBe(5000);
    expect(b.additionDates).toEqual(['2026-10-05']);
    expect(b.total).toBe(c.budget);
    expect(b.spent).toBe(c.used);
    expect(b.remaining).toBe(c.avail);
    expect(b.totalSecond).toBe(c.budgetSecond);
  });

  it('initial + extras + leftover + income + transfer: the parts add up to the same total as monthCalc', () => {
    const s = seedState();
    const m = s.months['2026-10']!;
    m.budgetLog.push(
      { id: 'left', date: '2026-10-02', accountId: 'dr', amount: 3363.46, kind: 'leftover', note: '' },
      { id: 'extra-usd', date: '2026-10-08', accountId: 'us', amount: 50, kind: 'adjust', note: 'Medical' },
      { id: 'cut', date: '2026-10-09', accountId: 'dr', amount: -1000, kind: 'adjust', note: 'Trim' },
    );
    s.incomes.push({ id: 'gig', date: '2026-10-03', desc: 'Gig', accountId: 'dr', amount: 2000, cur: 'DOP', budget: true });
    m.transfers[0]!.budget = true;
    const b = budgetSummary(s, '2026-10');
    const c = monthCalc(s, '2026-10');
    expect(b.total).toBe(c.budget);
    expect(b.initial + b.leftover + b.incomes + b.transfers + b.added + b.reduced).toBeCloseTo(c.budget, 6);
    expect(b.leftover).toBeCloseTo(3363.46, 6);
    expect(b.incomes).toBe(2000);
    expect(b.additions.map((l) => l.id)).toEqual(['seed-bg-2026-10-2', 'extra-usd']);
    // 50 USD keeps its own currency on the line and is worth 50 x 58.76 in the main one.
    expect(b.additions[1]).toMatchObject({ amount: 50, currency: 'USD', note: 'Medical' });
    expect(b.additions[1]!.inMain).toBeCloseTo(2938, 6);
    expect(b.reductions.map((l) => l.id)).toEqual(['cut']);
    expect(b.reduced).toBe(-1000);
    expect(b.additionDates).toEqual(['2026-10-05', '2026-10-08']);
  });

  it('second currency is derived with the month rate, and is null without one', () => {
    const s = seedState();
    const b = budgetSummary(s, '2026-10');
    expect(b.second).toBe('USD');
    expect(b.remainingSecond).toBeCloseTo(b.remaining / 58.76, 8);
    expect(b.addedSecond).toBeCloseTo(5000 / 58.76, 8);
    s.secondCurrency = null;
    const none = budgetSummary(s, '2026-10');
    expect([none.second, none.totalSecond, none.spentSecond, none.remainingSecond, none.initialSecond, none.addedSecond]).toEqual([
      null, null, null, null, null, null,
    ]);
  });

  it('remaining is negative when the month was overspent', () => {
    const s = seedState();
    s.months['2026-10']!.budgetLog.push({ id: 'cut', date: '2026-10-06', accountId: 'dr', amount: -60000, kind: 'adjust', note: '' });
    const b = budgetSummary(s, '2026-10');
    expect(b.total).toBe(10000);
    expect(b.remaining).toBeLessThan(0);
    expect(b.remaining).toBe(b.total - b.spent);
  });

  it('works for a closed month: it comes from the log', () => {
    const s = seedState();
    expect(s.months['2026-08']!.closed).toBe(true);
    const b = budgetSummary(s, '2026-08');
    expect(b.initial).toBe(70000);
    expect(b.additions).toEqual([]);
    expect(b.total).toBe(monthCalc(s, '2026-08').budget);
  });
});
