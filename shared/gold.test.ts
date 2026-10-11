// Gold as the "currency" of an account (shared/types.ts Gold): grams that are only worth money with the price typed
// by the user. Figures worked out by hand on the October 2026 sample data: US account 13,482 USD,
// DR account 220,641.93 DOP, 1 USD = 58.76 DOP (typed) and, for TRY, the default value (1 USD = 42 TRY).

import { describe, expect, it } from 'vitest';
import { balances, defaultAccount, goldValue, incomeInMonth, moneyAccounts, monthCalc, openingFor } from './calc';
import { ACCOUNT_CURRENCIES, CURRENCIES } from './constants';
import { buildExportData } from './excel/data';
import { fGrams } from './format';
import { seedState } from './seed';
import type { Account, AppState, GoldPrice, Income } from './types';

const OCT = '2026-10';
const GOLD_ACCOUNT: Account = { id: 'gold', name: 'Gold', currency: 'XAU', opening: 100, hidden: false, sort: 9 };
const GRAMS_IN: Income = { id: 'g1', date: '2026-10-05', desc: 'Bought', accountId: 'gold', amount: 25.5, cur: 'XAU', budget: false };

/** The sample data plus a gold account with an opening 100 g and 25.5 g that come into it in October. */
function withGold(price: GoldPrice | null, extra: Partial<AppState> = {}): AppState {
  const s = seedState();
  return { ...s, accounts: [...s.accounts, GOLD_ACCOUNT], incomes: [...s.incomes, GRAMS_IN], goldPrice: price, ...extra };
}

const goldOf = (s: AppState, asOf = OCT) => balances(s, asOf).accounts.find((b) => b.account.id === 'gold')!;

describe('gold: balance in grams and value with the gold price', () => {
  it('without a price: the account shows in grams, is worth no money and stays out of the total, which warns about it', () => {
    const plain = balances(seedState(), OCT);
    const b = balances(withGold(null), OCT);
    expect(goldOf(withGold(null))).toMatchObject({ balance: 125.5, inMain: 0, inSecond: 0, valued: false });
    expect(b.totalMain).toBe(plain.totalMain);
    expect(b.totalSecond).toBe(plain.totalSecond);
    expect(b.goldExcluded).toBe(true);
    expect(plain.goldExcluded).toBe(false);
    expect(goldValue(withGold(null), OCT, 125.5, 'DOP')).toBeNull();
  });

  it('with the price in the main currency: grams × price, and it adds to the total', () => {
    const s = withGold({ amount: 5000, currency: 'DOP' });
    const plain = balances(seedState(), OCT);
    const b = balances(s, OCT);
    expect(goldOf(s)).toMatchObject({ balance: 125.5, valued: true });
    expect(goldOf(s).inMain).toBeCloseTo(125.5 * 5000, 8);
    // To the second currency, with the month rate: 627,500 DOP ÷ 58.76.
    expect(goldOf(s).inSecond).toBeCloseTo((125.5 * 5000) / 58.76, 8);
    expect(b.totalMain).toBeCloseTo(plain.totalMain + 627500, 6);
    expect(b.totalSecond).toBeCloseTo(plain.totalSecond! + 627500 / 58.76, 6);
    expect(b.goldExcluded).toBe(false);
  });

  it('with the price in another currency: it goes through it to the main currency with the usual conversion', () => {
    // 1 g = 85 USD → 125.5 g = 10,667.5 USD = 626,822.30 DOP at 58.76.
    const usd = withGold({ amount: 85, currency: 'USD' });
    expect(goldOf(usd).inMain).toBeCloseTo(125.5 * 85 * 58.76, 6);
    expect(goldOf(usd).inSecond).toBeCloseTo(125.5 * 85, 8);
    // 1 g = 3,570 TRY, with no typed TRY rate: the default value (1 USD = 42 TRY) and from there to DOP → 85 USD per gram.
    const tl = withGold({ amount: 3570, currency: 'TRY' });
    expect(goldOf(tl).inSecond).toBeCloseTo((125.5 * 3570) / 42, 6);
    expect(goldOf(tl).inMain).toBeCloseTo(((125.5 * 3570) / 42) * 58.76, 4);
    // And it follows the user's main currency if that changes.
    const inTry = withGold({ amount: 85, currency: 'USD' }, { mainCurrency: 'TRY', secondCurrency: 'USD' });
    expect(goldOf(inTry).inMain).toBeCloseTo(125.5 * 85 * 42, 6);
  });

  it('a price that is not greater than 0 is like having no price', () => {
    expect(goldOf(withGold({ amount: 0, currency: 'USD' })).valued).toBe(false);
    expect(balances(withGold({ amount: 0, currency: 'USD' }), OCT).goldExcluded).toBe(true);
  });

  it('a hidden gold account does not count and does not trigger the warning', () => {
    const hidden = withGold(null, { accounts: [...seedState().accounts, { ...GOLD_ACCOUNT, hidden: true }] });
    expect(balances(hidden, OCT).goldExcluded).toBe(false);
    const priced = { ...hidden, goldPrice: { amount: 5000, currency: 'DOP' as const } };
    expect(balances(priced, OCT).totalMain).toBe(balances(seedState(), OCT).totalMain);
  });

  it('grams come in by their date, and only grams: a movement in money does not touch a gold account', () => {
    const s = withGold({ amount: 5000, currency: 'DOP' });
    expect(goldOf(s, '2026-09').balance).toBe(100);
    const mixed: AppState = { ...s, incomes: [...s.incomes, { ...GRAMS_IN, id: 'bad', cur: 'USD', amount: 999 }] };
    expect(goldOf(mixed).balance).toBe(125.5);
    // Correcting the balance adjusts the opening balance, in grams: to see 200 g it takes 174.5 to start with.
    expect(openingFor(s, 'gold', OCT, 200)).toBeCloseTo(174.5, 9);
  });
});

describe('gold: outside everything that is money', () => {
  const s = withGold({ amount: 5000, currency: 'DOP' });

  it('it is not income of the month and has no budget part: the month figures are the usual ones', () => {
    const plain = seedState();
    expect(incomeInMonth(s, OCT)).toBe(incomeInMonth(plain, OCT));
    const c = monthCalc(s, OCT);
    expect(c.income).toBe(monthCalc(plain, OCT).income);
    expect(c.budget).toBe(70000);
    expect(c.budgetParts.map((p) => p.account.id)).toEqual(['us', 'dr']);
  });

  it('it is never the default account and is not offered among the money accounts', () => {
    expect(moneyAccounts(s).map((a) => a.id)).toEqual(['us', 'dr']);
    expect(defaultAccount({ ...s, defaultAccountId: 'gold' })!.id).toBe('dr');
    expect(defaultAccount({ ...s, accounts: [GOLD_ACCOUNT] })).toBeNull();
  });

  it('gold is not just another currency: it is only in the list for accounts', () => {
    expect(CURRENCIES).toEqual(['DOP', 'USD', 'TRY']);
    expect(ACCOUNT_CURRENCIES).toEqual(['DOP', 'USD', 'TRY', 'XAU']);
  });

  it('the Excel workbook comes out the same with or without gold, whether or not it has a price', () => {
    const book = buildExportData(seedState());
    expect(buildExportData(s)).toEqual(book);
    expect(buildExportData(withGold(null))).toEqual(book);
  });
});

describe('fGrams', () => {
  it('two decimals, or three if the third one counts', () => {
    expect(fGrams(125.5)).toBe('125.50');
    expect(fGrams(1.234)).toBe('1.234');
    expect(fGrams(1250)).toBe('1,250.00');
    expect(fGrams(0.0004)).toBe('0.00');
    expect(fGrams(Number.NaN)).toBe('0.00');
  });
});
