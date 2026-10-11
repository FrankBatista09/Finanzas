// Tests only (data.test.ts and export-libreoffice.test.ts): app states used to test the
// bridge between the accounts model and the Excel workbook (data.ts).

import { DEFAULT_ACCOUNTS, DEFAULT_GOALS, DEFAULT_MAIN_CURRENCY, DEFAULT_RATE, DEFAULT_SECOND_CURRENCY } from '../constants';
import { seedState, setBudgets } from '../seed';
import type { AppState, Currency, MonthKey, Transaction, Transfer } from '../types';

/** A brand-new user, as the server leaves them: their initial accounts and goals and the current month, empty. */
export function newUserState(current: MonthKey = '2026-10'): AppState {
  return {
    mainCurrency: DEFAULT_MAIN_CURRENCY,
    secondCurrency: DEFAULT_SECOND_CURRENCY,
    defaultAccountId: null,
    defaultRate: DEFAULT_RATE,
    goldPrice: null,
    theme: null,
    language: 'en',
    accounts: DEFAULT_ACCOUNTS.map((a) => ({ ...a })),
    incomes: [],
    goals: DEFAULT_GOALS.map((g) => ({ ...g })),
    contribs: [],
    cards: [],
    months: { [current]: { key: current, closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] } },
  };
}

/**
 * The sample data plus everything the workbook cannot represent: main currency TRY, one account in TRY, another in
 * USD and another in DOP besides the usual two, two hidden accounts, fixed expenses, transactions, incomes and
 * contributions in TRY, a goal in TRY with a plan, another in DOP and one with a half-filled plan, transfers in every
 * direction (also between accounts of the same currency) and the budget split across several accounts.
 *
 * Each month's rates are consistent with each other, which is when the workbook's total money matches the app's:
 * each month has its own rate for two of the three pairs and the third comes from crossing them (or agrees with them).
 *  · August: USD↔DOP from its transfers and USD→TRY typed by hand;
 *  · September: USD↔DOP from its transfers and USD→TRY typed by hand, the one its transfers give (in both directions);
 *  · October: USD↔DOP and TRY↔DOP from its transfers (in both directions) and USD→TRY typed by hand, the one that
 *    comes from crossing the other two.
 * A typed rate stays in effect until another one is typed: that is why, once August's is typed, September and October
 * carry their own from their day 1 (without it August's would apply and the month would stop matching its transfers).
 * No month has the USD→DOP rate typed: the app derives it from the transfers, like the workbook does.
 */
export function mixedState(): AppState {
  const s = seedState();
  s.mainCurrency = 'TRY';
  s.secondCurrency = 'DOP';
  s.defaultAccountId = 'tr';
  s.accounts.push(
    { id: 'tr', name: 'TR account', currency: 'TRY', opening: 50000, hidden: false, sort: 2 },
    { id: 'pp', name: 'PayPal', currency: 'USD', opening: 300, hidden: false, sort: 3 },
    { id: 'cash', name: 'Cash', currency: 'DOP', opening: 5000, hidden: false, sort: 4 },
    { id: 'old', name: 'Old bank', currency: 'USD', opening: 999, hidden: true, sort: 5 },
    { id: 'box', name: 'Piggy bank', currency: 'DOP', opening: 1234, hidden: true, sort: 6 },
  );

  const aug = s.months['2026-08']!;
  const sep = s.months['2026-09']!;
  const oct = s.months['2026-10']!;
  aug.rates = [{ from: 'USD', to: 'TRY', rate: 39, date: '2026-08-01' }];
  // September: 500 USD → 19,700 TRY and 3,950 TRY → 100.33 USD. October: USD→DOP (102,785 DOP for 1,750 USD)
  // divided by TRY→DOP (4,350 DOP for 3,001 TRY), both from its transfers.
  sep.rates = [{ from: 'USD', to: 'TRY', rate: (500 * 39.4 + 3950) / (500 + 3950 * 0.0254), date: '2026-09-01' }];
  oct.rates = [
    {
      from: 'USD',
      to: 'TRY',
      rate: (1500 * 58.76 + 11700 + 50 * 58.9) / (1500 + 11700 / 58.5 + 50) / ((1000 * 1.45 + 2900) / (1000 + 2900 * 0.69)),
      date: '2026-10-01',
    },
  ];

  const transfer = (key: MonthKey, n: number, day: string, via: string, from: string, to: string, amount: number, rate: number): Transfer => ({
    id: `mx-tr-${key}-${n}`,
    monthKey: key,
    date: `${key}-${day}`,
    via,
    fromAccountId: from,
    toAccountId: to,
    amount,
    rate,
    budget: false, fee: 0,
  });
  sep.transfers.push(
    transfer('2026-09', 1, '05', 'Wise', 'us', 'tr', 500, 39.4),
    transfer('2026-09', 2, '12', 'Wise', 'tr', 'pp', 3950, 0.0254),
    transfer('2026-09', 3, '20', 'PayPal', 'us', 'pp', 250, 1),
  );
  oct.transfers.push(
    transfer('2026-10', 1, '04', 'Bank', 'dr', 'us', 11700, 1 / 58.5),
    transfer('2026-10', 2, '05', 'Remitly', 'old', 'dr', 50, 58.9),
    transfer('2026-10', 3, '06', 'Cash', 'tr', 'dr', 1000, 1.45),
    transfer('2026-10', 4, '07', 'Cash', 'dr', 'tr', 2900, 0.69),
    transfer('2026-10', 5, '08', 'ATM', 'dr', 'cash', 3000, 1),
  );

  const tx = (
    key: MonthKey,
    n: number,
    day: string,
    desc: string,
    cat: string,
    amount: number,
    cur: Currency,
    accountId: string,
    notes = '',
  ): Transaction => ({
    id: `mx-tx-${key}-${n}`,
    monthKey: key,
    date: `${key}-${day}`,
    desc,
    place: '',
    cat,
    method: 'Debit card',
    amount,
    cur,
    accountId,
    notes,
    source: 'web',
    createdAt: null,
  });
  sep.tx.push(tx('2026-09', 1, '13', 'Baklava', 'Food', 1250, 'TRY', 'tr'));
  oct.tx.push(
    tx('2026-10', 1, '08', 'Seat selection', 'Travel', 2400.5, 'TRY', 'tr', 'Turkish Airlines'),
    // In TRY but paid from the DOP account.
    tx('2026-10', 2, '09', 'Gift for Eda', 'Home', 600, 'TRY', 'dr'),
    tx('2026-10', 3, '09', 'Domain', 'Subscriptions', 12.5, 'USD', 'pp'),
    // Paid from a hidden account: it counts as an expense of the month, but its balance is not part of the total money.
    tx('2026-10', 4, '10', 'Snacks', 'Food', 200, 'DOP', 'box'),
  );
  oct.fixed.push(
    { id: 'mx-fx-1', monthKey: '2026-10', name: 'Turkcell', day: '12', amount: 350, cur: 'TRY', paid: true, accountId: 'tr', sort: 11 },
    { id: 'mx-fx-2', monthKey: '2026-10', name: 'Istanbul gym', day: '', amount: 900, cur: 'TRY', paid: false, accountId: 'tr', sort: 12 },
  );

  setBudgets(sep, { dr: 70000, old: 25 });
  setBudgets(oct, { dr: 60000, us: 100, tr: 4000 });

  s.incomes.push(
    { id: 'mx-in-1', date: '2026-09-20', desc: 'Sold bike', accountId: 'cash', amount: 8000, cur: 'DOP', budget: false },
    { id: 'mx-in-2', date: '2026-10-15', desc: 'Freelance', accountId: 'tr', amount: 20000, cur: 'TRY', budget: false },
    { id: 'mx-in-3', date: '2026-10-02', desc: 'Refund', accountId: 'old', amount: 40, cur: 'USD', budget: false },
    // Dated in a month that does not exist yet: it has no sheet to appear on.
    { id: 'mx-in-4', date: '2026-11-01', desc: 'Early salary', accountId: 'us', amount: 100, cur: 'USD', budget: false },
  );

  s.goals.push(
    { id: 'flat', name: 'Istanbul flat', cur: 'TRY', monthly: 10000, start: '2026-09', end: '2027-08', approxCur: null, sort: 3 },
    { id: 'gifts', name: 'Gifts', cur: 'DOP', monthly: null, start: null, end: null, approxCur: null, sort: 4 },
    { id: 'half', name: 'Half plan', cur: 'TRY', monthly: 500, start: '2026-10', end: null, approxCur: null, sort: 5 },
  );
  s.contribs.push(
    { id: 'mx-ct-1', goalId: 'flat', date: '2026-09-10', amount: 4000, cur: 'TRY' },
    { id: 'mx-ct-2', goalId: 'flat', date: '2026-10-05', amount: 100, cur: 'USD' },
    { id: 'mx-ct-3', goalId: 'flat', date: '2026-10-06', amount: 2938, cur: 'DOP' },
    { id: 'mx-ct-4', goalId: 'emergency', date: '2026-10-07', amount: 420, cur: 'TRY' },
    { id: 'mx-ct-5', goalId: 'gifts', date: '2026-10-07', amount: 1500, cur: 'DOP' },
  );
  return s;
}
