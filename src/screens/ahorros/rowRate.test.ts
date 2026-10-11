// New Savings logic: own rate and origin account in the drafts and the changes, and the month of the income
// table (no React).

import { describe, expect, it } from 'vitest';
import { seedState } from '../../../shared/seed';
import { accountInUse, canRemoveAccount, contributionChange, incomeChange, newContribution, newIncome } from '../../store/reducers';
import { afterAdd, autoRate, EMPTY_DRAFT, EMPTY_INCOME, incomeDraftInput, incomeItems, incomeMonthKeys, incomeTotalOf, monthDraftDate, resolveDraft } from './model';

const goals = seedState().goals;

describe('own rate in the drafts and in the changes', () => {
  it('an income in the main currency or into a gold account carries no rate; in another currency it does, and it is cleared on add', () => {
    const s = seedState();
    const usd = incomeDraftInput({ ...EMPTY_INCOME, accountId: 'us', amount: 10, rate: 60 }, s, '2026-10-07');
    expect(usd).toMatchObject({ cur: 'USD', rate: 60 });
    expect(incomeDraftInput({ ...EMPTY_INCOME, accountId: 'dr', amount: 10, rate: 60 }, s, '2026-10-07')).toMatchObject({ cur: 'DOP', rate: null });
    expect(newIncome(s, { date: '2026-10-07', accountId: 'us', amount: 10, cur: 'USD', rate: 60, recurring: true }, 'n')).toMatchObject({ rate: 60, recurring: true });
    expect(newIncome(s, { date: '2026-10-07', accountId: 'us', amount: 10, cur: 'USD', rate: -3 }, 'n')).toMatchObject({ rate: null, recurring: false });
  });

  it('incomeChange and contributionChange: rate null or > 0; anything else is discarded', () => {
    const s = seedState();
    expect(incomeChange(s, 'seed-in-3', { rate: 61 })).toEqual({ rate: 61 });
    expect(incomeChange(s, 'seed-in-3', { rate: null })).toEqual({ rate: null });
    expect(incomeChange(s, 'seed-in-3', { rate: 0 })).toEqual({});
    expect(incomeChange(s, 'seed-in-3', { recurring: true })).toEqual({ recurring: true });
    expect(contributionChange(s, { rate: 0 })).toEqual({});
    expect(contributionChange(s, { rate: 60, accountId: null })).toEqual({ rate: 60, accountId: null });
  });

  it('contributions: the account must be a money account and exist; the draft rate and account are resolved and cleared on add', () => {
    const s = seedState();
    const ok = { goalId: 'emergency', date: '2026-10-07', amount: 5, cur: 'USD' as const };
    expect(newContribution(s, { ...ok, accountId: 'us', rate: 60 }, 'c')).toMatchObject({ accountId: 'us', rate: 60 });
    expect(newContribution(s, { ...ok, accountId: 'nope' }, 'c')).toMatchObject({ accountId: null, rate: null });
    // In the main currency there is no rate to store.
    expect(resolveDraft({ ...EMPTY_DRAFT, cur: 'DOP', rate: 60 }, goals, '2026-10-07', 'DOP').rate).toBeNull();
    expect(resolveDraft({ ...EMPTY_DRAFT, cur: 'USD', rate: 60, accountId: 'us' }, goals, '2026-10-07', 'DOP')).toMatchObject({ rate: 60, accountId: 'us' });
    expect(afterAdd({ ...EMPTY_DRAFT, amount: 5, rate: 60, accountId: 'us' })).toEqual({ ...EMPTY_DRAFT, accountId: 'us' });
  });

  it('an account used by a contribution cannot be deleted', () => {
    const s = seedState();
    s.contribs[0]!.accountId = 'us';
    expect(accountInUse(s, 'us')).toBe(true);
    expect(canRemoveAccount(s, 'us')).toBe(false);
  });

  it('the automatic rate shown is the one in effect on the date; no control in the main currency', () => {
    const s = seedState();
    expect(autoRate(s, '2026-10-07', 'USD')).toBe(58.76);
    expect(autoRate(s, '2026-10-07', 'DOP')).toBeNull();
    expect(autoRate(s, '2026-10-07', 'XAU')).toBeNull();
  });
});

describe('the month of the income table', () => {
  it('offers the recorded months, the ones that have incomes and the picked one, in order', () => {
    const s = seedState();
    s.incomes.push({ id: 'old', date: '2026-03-02', desc: '', accountId: 'dr', amount: 1, cur: 'DOP', budget: false });
    expect(incomeMonthKeys(s, '2026-10')).toEqual(['2026-03', '2026-08', '2026-09', '2026-10']);
    expect(incomeMonthKeys(s, '2027-01').at(-1)).toBe('2027-01');
  });

  it('only lists the incomes dated in the month (the gold ones, in Savings) and its total is that of the month', () => {
    const s = seedState();
    s.accounts.push({ id: 'gold', name: 'Gold', currency: 'XAU', opening: 0, hidden: false, sort: 9 });
    s.incomes.push({ id: 'g', date: '2026-09-20', desc: '', accountId: 'gold', amount: 2, cur: 'XAU', budget: false });
    expect(incomeItems(s, 'en', '2026-09', true).map((i) => i.id)).toEqual(['g', 'seed-in-2']);
    expect(incomeItems(s, 'en', '2026-09').map((i) => i.id)).toEqual(['seed-in-2']);
    expect(incomeItems(s, 'en', '2026-07', true)).toEqual([]);
    expect(incomeTotalOf(s, '2026-09')).toBeCloseTo(339731.22, 2);
  });

  it('the date the add row proposes is today if it is the current month and, otherwise, day 1', () => {
    expect(monthDraftDate('2026-10', '2026-10-07')).toBe('2026-10-07');
    expect(monthDraftDate('2026-09', '2026-10-07')).toBe('2026-09-01');
  });
});
