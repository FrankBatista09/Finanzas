// The gold rules in the web's data layer: what the server would reject never gets sent, and what
// each select offers. A gold account (grams, 'XAU') only has an opening balance and income in grams.

import { describe, expect, it } from 'vitest';
import { seedState } from '../../shared/seed';
import type { Account, AppState, Income } from '../../shared/types';
import { EMPTY_INCOME, EMPTY_MONTH_INCOME, incomeItems, resolveIncomeDraft } from '../screens/ahorros/model';
import {
  budgetPart,
  canHideAccount,
  fixedChange,
  goldPriceChange,
  incomeChange,
  newAccount,
  newBudgetEntry,
  newFixed,
  newIncome,
  newTransfer,
  newTx,
  openingForBalance,
  reduce,
  transferChange,
  txChange,
} from './reducers';
import { accountOptions, incomeAccountOptions } from './view';

const OCT = '2026-10';
const GOLD: Account = { id: 'gold', name: 'Gold', currency: 'XAU', opening: 100, hidden: false, sort: 9 };
const GRAMS: Income = { id: 'g1', date: '2026-10-05', desc: 'Bought', accountId: 'gold', amount: 25.5, cur: 'XAU', budget: false };

function withGold(): AppState {
  const s = seedState();
  return { ...s, accounts: [...s.accounts, GOLD], incomes: [...s.incomes, GRAMS] };
}

describe('gold accounts', () => {
  const s = withGold();

  it('newAccount accepts gold, with the opening grams to three decimals', () => {
    expect(newAccount(seedState(), { name: 'Gold', currency: 'XAU', opening: 125.50049 }, 'x')).toEqual({
      id: 'x',
      name: 'Gold',
      currency: 'XAU',
      opening: 125.5,
      hidden: false,
      sort: 2,
    });
    expect(newAccount(seedState(), { name: 'Gold', currency: 'XAU', opening: 1.2346 }, 'x')!.opening).toBe(1.235);
    // Money is not trimmed.
    expect(newAccount(seedState(), { name: 'PayPal', currency: 'USD', opening: 1.23456 }, 'x')!.opening).toBe(1.23456);
  });

  it('correcting its balance corrects the grams; it can always be hidden, but not the last money account', () => {
    // 25.5 g came in: to see 200.0004 → 200 g it takes an opening of 174.5.
    expect(openingForBalance(s, OCT, 'gold', 200.0004)).toBe(174.5);
    expect(canHideAccount(s, 'gold')).toBe(true);
    const oneMoney: AppState = { ...s, accounts: [s.accounts[0]!, GOLD] };
    expect(canHideAccount(oneMoney, 'gold')).toBe(true);
    expect(canHideAccount(oneMoney, s.accounts[0]!.id)).toBe(false);
  });

  it('cannot be chosen for anything that is money', () => {
    const tx = { date: '2026-10-07', desc: 'Coin', cat: 'Other', method: 'Cash', amount: 1, cur: 'USD' as const };
    const transfer = { date: '2026-10-07', via: 'Shop', amount: 100 };
    expect(newFixed(s, OCT, { name: 'Vault', amount: 1, cur: 'USD', accountId: 'gold' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...tx, accountId: 'gold' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...tx, accountId: 'us' }, 'x')).not.toBeNull();
    expect(newTransfer(s, OCT, { ...transfer, fromAccountId: 'us', toAccountId: 'gold' }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...transfer, fromAccountId: 'gold', toAccountId: 'dr', rate: 5000 }, 'x')).toBeNull();
    expect(newBudgetEntry(s, OCT, { accountId: 'gold', amount: 5 }, 'x', '2026-10-07')).toBeNull();
    expect(budgetPart(s, OCT, 'gold', 5)).toBeNull();
    expect(budgetPart(s, OCT, 'dr', 5)).not.toBeNull();
    // In a cell, the gold account is ignored and the rest is saved.
    expect(fixedChange(s, { accountId: 'gold', amount: 9 })).toEqual({ amount: 9 });
    expect(txChange(s, { accountId: 'gold', notes: 'x' })).toEqual({ notes: 'x' });
    const transferId = s.months[OCT]!.transfers[0]!.id;
    expect(transferChange(s, transferId, { toAccountId: 'gold', amount: 7 })).toEqual({ amount: 7 });
    expect(transferChange(s, transferId, { fromAccountId: 'gold' })).toEqual({});
  });

  it('is only offered for the income of Savings', () => {
    expect(accountOptions(s).map((o) => o.value)).toEqual(['us', 'dr']);
    expect(incomeAccountOptions(s).map((o) => o.value)).toEqual(['us', 'dr', 'gold']);
    // The Month sheet neither offers it nor lists its income; Savings does, in grams and with no equivalent.
    expect(incomeItems(s, 'en', OCT).map((i) => i.id)).toEqual(['seed-in-3']);
    expect(incomeItems(s, 'en').find((i) => i.id === 'g1')).toMatchObject({ amount: 25.5, amountText: '25.50', cur: 'XAU', budget: false, main: '—' });
    const picked = { ...EMPTY_MONTH_INCOME, accountId: 'gold', cur: 'USD' as const };
    expect(resolveIncomeDraft(picked, s, '2026-10-07')).toMatchObject({ accountId: 'dr', cur: 'USD', budget: true });
    expect(resolveIncomeDraft(picked, s, '2026-10-07', true)).toMatchObject({ accountId: 'gold', cur: 'XAU', budget: false });
    expect(resolveIncomeDraft({ ...EMPTY_INCOME, accountId: 'us' }, s, '2026-10-07', true)).toMatchObject({ accountId: 'us', cur: 'USD' });
  });
});

describe('income in grams', () => {
  const s = withGold();

  it('newIncome: grams go into a gold account, with no budget, whatever is specified', () => {
    expect(newIncome(s, { date: '2026-10-07', accountId: 'gold', amount: 2.12549, cur: 'USD', budget: true }, 'x')).toEqual({
      id: 'x',
      date: '2026-10-07',
      desc: '',
      accountId: 'gold',
      amount: 2.125,
      cur: 'XAU',
      budget: false,
      rate: null,
      recurring: false,
    });
    // Less than a milligram is nothing.
    expect(newIncome(s, { date: '2026-10-07', accountId: 'gold', amount: 0.0004, cur: 'XAU' }, 'x')).toBeNull();
    // A money account does not take grams; with no account it goes to the default one, which is never a gold account.
    expect(newIncome(s, { date: '2026-10-07', accountId: 'us', amount: 1, cur: 'XAU' }, 'x')).toBeNull();
    expect(newIncome(s, { date: '2026-10-07', amount: 1, cur: 'XAU' }, 'x')).toBeNull();
    expect(newIncome(s, { date: '2026-10-07', amount: 1, cur: 'USD' }, 'x')).toMatchObject({ accountId: 'dr', cur: 'USD' });
  });

  it('incomeChange: the currency and the checkbox follow the account the income ends up in', () => {
    // A money income that raises the budget moves to a gold account: grams and no budget.
    const raising: AppState = { ...s, incomes: s.incomes.map((i) => (i.id === 'seed-in-3' ? { ...i, budget: true } : i)) };
    expect(incomeChange(raising, 'seed-in-3', { accountId: 'gold' })).toEqual({ accountId: 'gold', cur: 'XAU', budget: false });
    expect(incomeChange(s, 'seed-in-3', { accountId: 'gold' })).toEqual({ accountId: 'gold', cur: 'XAU' });
    // One in grams: neither another currency nor the checkbox; the grams, to three decimals.
    expect(incomeChange(s, 'g1', { cur: 'USD' })).toEqual({});
    expect(incomeChange(s, 'g1', { budget: true, amount: 30.00049 })).toEqual({ amount: 30 });
    // When moved out to a money account it takes that account's currency.
    expect(incomeChange(s, 'g1', { accountId: 'us' })).toEqual({ accountId: 'us', cur: 'USD' });
    // A money one cannot be given grams without changing its account.
    expect(incomeChange(s, 'seed-in-3', { cur: 'XAU', desc: 'x' })).toEqual({ desc: 'x' });
    expect(incomeChange(s, 'seed-in-3', { cur: 'TRY', budget: true })).toEqual({ cur: 'TRY', budget: true });
    expect(incomeChange(s, 'nope', { amount: 1 })).toEqual({});
  });
});

describe('gold price', () => {
  const s = seedState();
  const priced: AppState = { ...s, goldPrice: { amount: 85, currency: 'USD' } };

  it('goldPriceChange: an amount greater than 0 sets it, 0 removes it and what does not change is not sent', () => {
    expect(goldPriceChange(s, 85, 'USD')).toEqual({ goldPrice: { amount: 85, currency: 'USD' } });
    expect(goldPriceChange(priced, 85, 'USD')).toEqual({});
    expect(goldPriceChange(priced, 85, 'TRY')).toEqual({ goldPrice: { amount: 85, currency: 'TRY' } });
    expect(goldPriceChange(priced, 0, 'USD')).toEqual({ goldPrice: null });
    expect(goldPriceChange(s, 0, 'USD')).toEqual({});
    expect(goldPriceChange(s, -1, 'USD')).toBeNull();
    expect(goldPriceChange(s, Number.NaN, 'USD')).toBeNull();
    expect(goldPriceChange(s, 85, 'XAU' as 'USD')).toBeNull();
  });

  it('settings/patch applies it, removes it with null and is idempotent', () => {
    const set = reduce(s, { type: 'settings/patch', patch: { goldPrice: { amount: 85, currency: 'USD' } } });
    expect(set.goldPrice).toEqual({ amount: 85, currency: 'USD' });
    expect(reduce(set, { type: 'settings/patch', patch: { goldPrice: { amount: 85, currency: 'USD' } } })).toBe(set);
    // Another setting does not touch it.
    expect(reduce(set, { type: 'settings/patch', patch: { language: 'es' } }).goldPrice).toBe(set.goldPrice);
    const cleared = reduce(set, { type: 'settings/patch', patch: { goldPrice: null } });
    expect(cleared.goldPrice).toBeNull();
    expect(reduce(cleared, { type: 'settings/patch', patch: { goldPrice: null } })).toBe(cleared);
  });
});
