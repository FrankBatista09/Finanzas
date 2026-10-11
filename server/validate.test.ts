import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { en, es } from 'zod/locales';
import { ApiError, toApiError, zodMessage } from './errors';
import {
  accountCreateSchema,
  accountPatchSchema,
  budgetEntryCreateSchema,
  closeRequestSchema,
  contributionCreateSchema,
  fixedCreateSchema,
  fixedPatchSchema,
  goalCreateSchema,
  goalPatchSchema,
  goalPlanIssue,
  ID_RE,
  importSchema,
  incomeCreateSchema,
  incomePatchSchema,
  ingestSchema,
  MAX_BUDGET_PARTS,
  monthPatchSchema,
  monthRateSchema,
  parse,
  ratePairSchema,
  settingsUpdateSchema,
  transferCreateSchema,
  transferPatchSchema,
  txCreateSchema,
  txPatchSchema,
} from './validate';

const tx = { monthKey: '2026-10', date: '2026-10-07', desc: 'Uber', cat: 'Transport', method: 'Debit card', amount: 850, cur: 'DOP' };

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'validation' });
    return (err as ApiError).message;
  }
  throw new Error('se esperaba un error de validación');
}

describe('parse', () => {
  it('returns the normalized value: trimmed text and nothing beyond what is declared', () => {
    expect(parse(txCreateSchema, { ...tx, desc: '  Uber  ', place: ' Centro ', notes: '  ' })).toEqual({
      ...tx,
      place: 'Centro',
      notes: '',
    });
  });

  it('the messages are readable and in English', () => {
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: 0 }))).toBe('Invalid data: amount: must be greater than 0');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, desc: ' ' }))).toBe('Invalid data: desc: cannot be empty');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, desc: 'x'.repeat(201) }))).toBe('Invalid data: desc: allows up to 200 characters');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, date: '2026-02-30' }))).toBe(
      'Invalid data: date: is not a valid date (YYYY-MM-DD)',
    );
    expect(messageOf(() => parse(txCreateSchema, { ...tx, monthKey: '2026-13' }))).toBe('Invalid data: monthKey: is not a valid month (YYYY-MM)');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, cur: 'EUR' }))).toBe('Invalid data: cur: must be DOP, USD or TRY');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: '850' }))).toBe('Invalid data: amount: must be a number');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: -1 }))).toBe('Invalid data: amount: must be greater than 0');
    expect(messageOf(() => parse(txPatchSchema, { amount: -1 }))).toBe('Invalid data: amount: cannot be negative');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: 1e13 }))).toBe('Invalid data: amount: is too large');
    expect(messageOf(() => parse(txCreateSchema, { ...tx, id: 'a b' }))).toBe(
      'Invalid data: id: only letters, numbers, "-" and "_" are allowed (up to 64)',
    );
    expect(messageOf(() => parse(fixedCreateSchema, { monthKey: '2026-10', name: 'x', amount: 1, cur: 'DOP', paid: 1 }))).toBe(
      'Invalid data: paid: must be true or false',
    );
    expect(messageOf(() => parse(txCreateSchema, { ...tx, amount: undefined, desc: undefined }))).toBe(
      'Invalid data: desc: is required; amount: is required',
    );
  });

  it('also the messages that were not written by hand, even when zod is configured in another language', () => {
    const unknownKey = 'Invalid data: Unrecognized key: "otra"';
    expect(messageOf(() => parse(txCreateSchema, { ...tx, otra: 1 }))).toBe(unknownKey);
    expect(messageOf(() => parse(txCreateSchema, null))).toBe('Invalid data: Invalid input: expected object, received null');
    // The API always answers in English: it does not depend on zod's global configuration.
    z.config(es());
    try {
      expect(messageOf(() => parse(txCreateSchema, { ...tx, otra: 1 }))).toBe(unknownKey);
    } finally {
      z.config(en());
    }
  });

  it('summarizes when there are many issues', () => {
    const message = messageOf(() => parse(txCreateSchema, {}));
    expect(message).toContain('monthKey: is required; date: is required; desc: is required');
    expect(message).toMatch(/\(and 2 more\)$/);
  });

  it('amounts: finite; > 0 on create, ≥ 0 on edit', () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1e13, '1', null]) {
      expect(() => parse(txCreateSchema, { ...tx, amount }), String(amount)).toThrow(ApiError);
    }
    expect(parse(txCreateSchema, { ...tx, amount: 0.01 }).amount).toBe(0.01);
    expect(parse(txPatchSchema, { amount: 0 })).toEqual({ amount: 0 });
    expect(() => parse(txPatchSchema, { amount: -0.01 })).toThrow(ApiError);
    expect(() => parse(txPatchSchema, { amount: Number.POSITIVE_INFINITY })).toThrow(ApiError);
  });

  it('transfers: amount and rate greater than 0, two different accounts; the rate can be missing and via is free text', () => {
    const transfer = { monthKey: '2026-10', date: '2026-10-02', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1500, rate: 58.76 };
    expect(parse(transferCreateSchema, transfer)).toEqual(transfer);
    // Without a rate: the server fills it in with the month rate for the currencies of the two accounts.
    const { rate: _rate, ...noRate } = transfer;
    expect(parse(transferCreateSchema, noRate)).toEqual(noRate);
    expect(() => parse(transferCreateSchema, { ...transfer, amount: 0 })).toThrow(ApiError);
    expect(() => parse(transferCreateSchema, { ...transfer, rate: 0 })).toThrow(ApiError);
    expect(() => parse(transferCreateSchema, { ...transfer, rate: null })).toThrow(ApiError);
    // The fee: optional, >= 0, in the currency of the origin account.
    expect(parse(transferCreateSchema, { ...transfer, fee: 2.99 })).toEqual({ ...transfer, fee: 2.99 });
    expect(parse(transferCreateSchema, { ...transfer, fee: 0 })).toEqual({ ...transfer, fee: 0 });
    expect(messageOf(() => parse(transferCreateSchema, { ...transfer, fee: -1 }))).toBe('Invalid data: fee: cannot be negative');
    expect(() => parse(transferCreateSchema, { ...transfer, fee: '2.99' })).toThrow(ApiError);
    expect(parse(transferPatchSchema, { fee: 3.49 })).toEqual({ fee: 3.49 });
    expect(messageOf(() => parse(transferPatchSchema, { fee: -0.01 }))).toBe('Invalid data: fee: cannot be negative');
    // The previous format (dollars only, no accounts) no longer exists.
    expect(messageOf(() => parse(transferCreateSchema, { ...transfer, usd: 1500 }))).toContain('Unrecognized key: "usd"');
    expect(messageOf(() => parse(transferCreateSchema, { ...noRate, toAccountId: undefined }))).toBe('Invalid data: toAccountId: is required');
    const same = 'Invalid data: toAccountId: must be different from fromAccountId';
    expect(messageOf(() => parse(transferCreateSchema, { ...transfer, toAccountId: 'us' }))).toBe(same);
    expect(messageOf(() => parse(transferPatchSchema, { fromAccountId: 'dr', toAccountId: 'dr' }))).toBe(same);
    // A single account in a patch passes: if it clashes with the other one, the repository says so, since it is the one that knows it.
    expect(parse(transferPatchSchema, { toAccountId: 'us' })).toEqual({ toAccountId: 'us' });
    expect(parse(transferPatchSchema, { fromAccountId: 'dr', toAccountId: 'us', amount: 5, rate: 0.017 })).toEqual({
      fromAccountId: 'dr',
      toAccountId: 'us',
      amount: 5,
      rate: 0.017,
    });
    expect(() => parse(transferPatchSchema, { amount: 0 })).toThrow(ApiError);
    expect(() => parse(transferPatchSchema, { fromAccountId: 'con espacios' })).toThrow(ApiError);
    // Remitly and PayPal are suggestions: any name works, trimmed, as long as it is not empty and no longer than 60.
    expect(parse(transferCreateSchema, { ...transfer, via: '  Banco BHD (ventanilla) ' }).via).toBe('Banco BHD (ventanilla)');
    expect(parse(transferPatchSchema, { via: 'Efectivo de mamá' })).toEqual({ via: 'Efectivo de mamá' });
    expect(messageOf(() => parse(transferCreateSchema, { ...transfer, via: '   ' }))).toBe('Invalid data: via: cannot be empty');
    expect(messageOf(() => parse(transferPatchSchema, { via: 'x'.repeat(61) }))).toBe('Invalid data: via: allows up to 60 characters');
  });

  it('ids: letters, numbers, "-" and "_", from 1 to 64', () => {
    const fixed = { monthKey: '2026-10', name: 'Luz', amount: 1, cur: 'DOP' };
    for (const id of ['a', 'seed-fx-2026-10-1', 'A_b-9', 'x'.repeat(64), '3f2b8c1e-0d4a-4f6b-9c7d-1e2f3a4b5c6d']) {
      expect(ID_RE.test(id)).toBe(true);
      expect(parse(fixedCreateSchema, { ...fixed, id }).id).toBe(id);
    }
    for (const id of ['', ' ', 'a b', 'a/b', 'ñ', 'x'.repeat(65), "a'; DROP TABLE months;--", 7]) {
      expect(() => parse(fixedCreateSchema, { ...fixed, id }), String(id)).toThrow(ApiError);
    }
  });

  it('months and dates are validated with shared/month', () => {
    for (const monthKey of ['2026-00', '2026-13', '2026-1', '26-10', '2026-10-01', '']) {
      expect(() => parse(txCreateSchema, { ...tx, monthKey }), monthKey).toThrow(ApiError);
    }
    for (const date of ['2026-10-32', '2026-02-29', '2026-10-7', '2026-10', '']) {
      expect(() => parse(txCreateSchema, { ...tx, date }), date).toThrow(ApiError);
    }
    expect(parse(txCreateSchema, { ...tx, date: '2028-02-29' }).date).toBe('2028-02-29');
  });

  it('category and method are free text and are not translated: the web app sends the canonical value', () => {
    expect(parse(txCreateSchema, { ...tx, cat: 'Mascotas', method: 'Efectivo' })).toMatchObject({ cat: 'Mascotas', method: 'Efectivo' });
    // "Market" is Groceries in Turkish, but here it can be a custom category of someone who writes in English.
    expect(parse(txPatchSchema, { cat: 'Market' })).toEqual({ cat: 'Market' });
  });

  it('currencies: DOP, USD and TRY, in everything that carries a currency', () => {
    for (const cur of ['EUR', 'usd', 'try', '', null, 1]) expect(() => parse(txCreateSchema, { ...tx, cur }), String(cur)).toThrow(ApiError);
    for (const cur of ['DOP', 'USD', 'TRY']) {
      expect(parse(txCreateSchema, { ...tx, cur }).cur).toBe(cur);
      expect(parse(txPatchSchema, { cur })).toEqual({ cur });
      expect(parse(fixedCreateSchema, { monthKey: '2026-10', name: 'Luz', amount: 1, cur }).cur).toBe(cur);
      expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur }).cur).toBe(cur);
      expect(parse(contributionCreateSchema, { goalId: 'g', date: '2026-10-01', amount: 1, cur }).cur).toBe(cur);
      expect(parse(accountCreateSchema, { name: 'x', currency: cur }).currency).toBe(cur);
      expect(parse(goalCreateSchema, { name: 'x', cur }).cur).toBe(cur);
    }
  });

  it('the account of an expense is an id: optional on create (without it, the default one) and editable', () => {
    expect(parse(txCreateSchema, { ...tx, accountId: 'dr' }).accountId).toBe('dr');
    expect(parse(txCreateSchema, tx)).not.toHaveProperty('accountId');
    expect(parse(txPatchSchema, { accountId: 'us' })).toEqual({ accountId: 'us' });
    expect(parse(fixedPatchSchema, { accountId: 'us', paid: true })).toEqual({ accountId: 'us', paid: true });
    for (const accountId of ['', 'con espacios', null, 7]) {
      expect(() => parse(txCreateSchema, { ...tx, accountId }), String(accountId)).toThrow(ApiError);
      expect(() => parse(fixedPatchSchema, { accountId }), String(accountId)).toThrow(ApiError);
    }
  });
});

describe('months: budget per account and rates', () => {
  it('budget: account → non-negative amount (0 removes the part); the previous format no longer exists', () => {
    expect(parse(monthPatchSchema, { budgets: { dr: 70000, us: 0, 'a-b_9': 12.5 } })).toEqual({ budgets: { dr: 70000, us: 0, 'a-b_9': 12.5 } });
    expect(parse(monthPatchSchema, { budgets: {} })).toEqual({ budgets: {} });
    expect(parse(monthPatchSchema, {})).toEqual({});
    expect(messageOf(() => parse(monthPatchSchema, { budgets: { dr: -1 } }))).toBe('Invalid data: budgets.dr: cannot be negative');
    expect(messageOf(() => parse(monthPatchSchema, { budgets: { dr: '70000' } }))).toBe('Invalid data: budgets.dr: must be a number');
    expect(messageOf(() => parse(monthPatchSchema, { budgets: { dr: 1e13 } }))).toBe('Invalid data: budgets.dr: is too large');
    for (const budgets of [70000, 'x', null, [1], { 'con espacios': 1 }, { '': 1 }, { dr: null }]) {
      expect(() => parse(monthPatchSchema, { budgets }), JSON.stringify(budgets)).toThrow(ApiError);
    }
    for (const body of [{ budget: 1 }, { incomeUSD: 1 }, { accUSD: 1 }, { accDOP: 1 }, { rates: [] }, { closed: true }]) {
      expect(messageOf(() => parse(monthPatchSchema, body)), JSON.stringify(body)).toContain('Unrecognized key');
    }
    const many = Object.fromEntries(Array.from({ length: MAX_BUDGET_PARTS + 1 }, (_, i) => [`a${i}`, 1]));
    expect(messageOf(() => parse(monthPatchSchema, { budgets: many }))).toBe('Invalid data: budgets: allows up to 100 accounts');
  });

  it('rate: two different currencies, rate greater than 0 and the date it applies from', () => {
    expect(parse(monthRateSchema, { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-08' })).toEqual({ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-08' });
    expect(parse(monthRateSchema, { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-01' })).toEqual({ from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-01' });
    const ok = { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-08' };
    expect(messageOf(() => parse(monthRateSchema, { ...ok, to: 'USD' }))).toBe('Invalid data: to: must be different from `from`');
    expect(messageOf(() => parse(monthRateSchema, { ...ok, rate: 0 }))).toBe('Invalid data: rate: must be greater than 0');
    expect(messageOf(() => parse(monthRateSchema, { ...ok, to: 'EUR' }))).toBe('Invalid data: to: must be DOP, USD or TRY');
    expect(messageOf(() => parse(monthRateSchema, { from: 'USD', to: 'DOP', rate: 58 }))).toBe('Invalid data: date: is required');
    expect(messageOf(() => parse(monthRateSchema, { ...ok, date: '2026-02-30' }))).toBe('Invalid data: date: is not a valid date (YYYY-MM-DD)');
    for (const body of [{ from: 'USD', to: 'DOP', date: ok.date }, { from: 'USD', rate: 1, date: ok.date }, { ...ok, rate: -1 }, { ...ok, rate: '58' }, { ...ok, monthKey: '2026-10' }, { ...ok, date: '2026-10' }, { ...ok, date: 20261008 }]) {
      expect(() => parse(monthRateSchema, body), JSON.stringify(body)).toThrow(ApiError);
    }
    // The pair and the date of the delete route.
    expect(parse(ratePairSchema, { from: 'DOP', to: 'TRY', date: '2026-10-08' })).toEqual({ from: 'DOP', to: 'TRY', date: '2026-10-08' });
    expect(messageOf(() => parse(ratePairSchema, { from: 'DOP', to: 'TRY' }))).toBe('Invalid data: date: is required');
    for (const pair of [{ from: 'DOP', to: 'DOP' }, { from: 'dop', to: 'USD' }, { from: 'DOP' }, { from: 'DOP', to: 'EUR' }]) {
      expect(() => parse(ratePairSchema, { ...pair, date: '2026-10-08' }), JSON.stringify(pair)).toThrow(ApiError);
    }
    expect(() => parse(ratePairSchema, { from: 'DOP', to: 'TRY', date: 'hoy' })).toThrow(ApiError);
  });

  it('budget movement: account and signed amount (not 0); kind initial or adjustment; the leftover is not written by hand', () => {
    expect(parse(budgetEntryCreateSchema, { accountId: 'dr', amount: 5000 })).toEqual({ accountId: 'dr', amount: 5000 });
    expect(parse(budgetEntryCreateSchema, { id: 'b-1', date: '2026-10-05', accountId: 'dr', amount: -1200.5, kind: 'initial', note: '  Car repair ' })).toEqual({
      id: 'b-1', date: '2026-10-05', accountId: 'dr', amount: -1200.5, kind: 'initial', note: 'Car repair',
    });
    expect(messageOf(() => parse(budgetEntryCreateSchema, { accountId: 'dr', amount: 0 }))).toBe('Invalid data: amount: cannot be 0');
    expect(messageOf(() => parse(budgetEntryCreateSchema, { accountId: 'dr', amount: 1, kind: 'leftover' }))).toBe('Invalid data: kind: must be initial or adjust');
    expect(messageOf(() => parse(budgetEntryCreateSchema, { amount: 1 }))).toBe('Invalid data: accountId: is required');
    expect(messageOf(() => parse(budgetEntryCreateSchema, { accountId: 'dr', amount: 1, date: '2026-13-01' }))).toBe('Invalid data: date: is not a valid date (YYYY-MM-DD)');
    for (const body of [{ accountId: 'dr' }, { accountId: 'dr', amount: '5' }, { accountId: 'dr', amount: 1e13 }, { accountId: 'dr', amount: -1e13 }, { accountId: 'con espacios', amount: 1 }, { accountId: 'dr', amount: 1, monthKey: '2026-10' }, { accountId: 'dr', amount: 1, note: 5 }]) {
      expect(() => parse(budgetEntryCreateSchema, body), JSON.stringify(body)).toThrow(ApiError);
    }
  });

  it('month close: optional body with the initial parts of the next month and whether the leftover is added', () => {
    expect(parse(closeRequestSchema, {})).toEqual({});
    expect(parse(closeRequestSchema, { budgets: { dr: 80000, us: 0 }, addLeftover: true })).toEqual({ budgets: { dr: 80000, us: 0 }, addLeftover: true });
    expect(messageOf(() => parse(closeRequestSchema, { budgets: { dr: -1 } }))).toBe('Invalid data: budgets.dr: cannot be negative');
    expect(messageOf(() => parse(closeRequestSchema, { addLeftover: 'yes' }))).toBe('Invalid data: addLeftover: must be true or false');
    expect(messageOf(() => parse(closeRequestSchema, { leftover: true }))).toContain('Unrecognized key');
    for (const body of [null, [], 'x', { budgets: [1] }]) expect(() => parse(closeRequestSchema, body), JSON.stringify(body)).toThrow(ApiError);
  });
});

describe('accounts and incomes', () => {
  it('account: trimmed, non-empty name, currency and opening balance (which can be negative)', () => {
    expect(parse(accountCreateSchema, { name: '  PayPal ', currency: 'USD' })).toEqual({ name: 'PayPal', currency: 'USD' });
    expect(parse(accountCreateSchema, { id: 'tr', name: 'TR account', currency: 'TRY', opening: -250.5 })).toEqual({
      id: 'tr',
      name: 'TR account',
      currency: 'TRY',
      opening: -250.5,
    });
    expect(parse(accountCreateSchema, { name: 'x'.repeat(120), currency: 'DOP' }).name).toHaveLength(120);
    expect(messageOf(() => parse(accountCreateSchema, { name: '  ', currency: 'USD' }))).toBe('Invalid data: name: cannot be empty');
    expect(messageOf(() => parse(accountCreateSchema, { name: 'x'.repeat(121), currency: 'USD' }))).toBe('Invalid data: name: allows up to 120 characters');
    expect(messageOf(() => parse(accountCreateSchema, { name: 'x' }))).toBe('Invalid data: currency: must be DOP, USD, TRY or XAU (gold, in grams)');
    expect(messageOf(() => parse(accountCreateSchema, { name: 'x', currency: 'USD', opening: 1e13 }))).toBe('Invalid data: opening: is too large');
    // Hidden and order are not chosen on create, and the balance does not travel: it is calculated.
    for (const extra of [{ hidden: true }, { sort: 3 }, { balance: 100 }]) {
      expect(() => parse(accountCreateSchema, { name: 'x', currency: 'USD', ...extra }), JSON.stringify(extra)).toThrow(ApiError);
    }

    expect(parse(accountPatchSchema, { name: ' Chase ', currency: 'TRY', opening: -1, hidden: true, sort: 4 })).toEqual({
      name: 'Chase',
      currency: 'TRY',
      opening: -1,
      hidden: true,
      sort: 4,
    });
    expect(parse(accountPatchSchema, {})).toEqual({});
    for (const body of [{ name: '' }, { hidden: 1 }, { sort: -1 }, { sort: 1.5 }, { currency: 'EUR' }, { opening: '5' }, { id: 'otra' }, { balance: 1 }]) {
      expect(() => parse(accountPatchSchema, body), JSON.stringify(body)).toThrow(ApiError);
    }
  });

  it('income: date, amount and currency; the description and the account can be missing', () => {
    expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 5800, cur: 'USD' })).toEqual({ date: '2026-10-01', amount: 5800, cur: 'USD' });
    expect(parse(incomeCreateSchema, { id: 'in-1', date: '2026-10-01', desc: '  Salary ', accountId: 'us', amount: 5800, cur: 'USD' })).toEqual({
      id: 'in-1',
      date: '2026-10-01',
      desc: 'Salary',
      accountId: 'us',
      amount: 5800,
      cur: 'USD',
    });
    expect(messageOf(() => parse(incomeCreateSchema, { date: '2026-10-01', amount: 0, cur: 'USD' }))).toBe('Invalid data: amount: must be greater than 0');
    expect(messageOf(() => parse(incomeCreateSchema, { date: '2026-02-30', amount: 1, cur: 'USD' }))).toBe(
      'Invalid data: date: is not a valid date (YYYY-MM-DD)',
    );
    expect(messageOf(() => parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', desc: 'x'.repeat(201) }))).toBe(
      'Invalid data: desc: allows up to 200 characters',
    );
    // It does not belong to a month: it carries no monthKey.
    expect(() => parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', monthKey: '2026-10' })).toThrow(ApiError);
    // On edit, the amount can end up at 0 and the description empty.
    expect(parse(incomePatchSchema, { amount: 0, desc: ' ', accountId: 'dr', date: '2030-01-01', cur: 'TRY' })).toEqual({
      amount: 0,
      desc: '',
      accountId: 'dr',
      date: '2030-01-01',
      cur: 'TRY',
    });
    expect(() => parse(incomePatchSchema, { amount: -1 })).toThrow(ApiError);
    expect(() => parse(incomePatchSchema, { id: 'otro' })).toThrow(ApiError);
  });

  it('income that raises the budget: `budget` is optional and only true or false', () => {
    expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', budget: true }).budget).toBe(true);
    expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', budget: false }).budget).toBe(false);
    expect(parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD' }).budget).toBeUndefined();
    expect(parse(incomePatchSchema, { budget: true })).toEqual({ budget: true });
    for (const budget of [1, 'true', null]) {
      expect(messageOf(() => parse(incomeCreateSchema, { date: '2026-10-01', amount: 1, cur: 'USD', budget })), String(budget)).toBe('Invalid data: budget: must be true or false');
      expect(() => parse(incomePatchSchema, { budget }), String(budget)).toThrow(ApiError);
    }
  });

  it('goal: the "≈" currency is one of the three or null, even the currency of the goal itself', () => {
    for (const approxCur of ['DOP', 'USD', 'TRY', null]) {
      expect(parse(goalCreateSchema, { name: 'x', cur: 'USD', approxCur }).approxCur).toBe(approxCur);
      expect(parse(goalPatchSchema, { approxCur })).toEqual({ approxCur });
    }
    expect(parse(goalCreateSchema, { name: 'x' }).approxCur).toBeUndefined();
    expect(messageOf(() => parse(goalCreateSchema, { name: 'x', approxCur: 'EUR' }))).toBe('Invalid data: approxCur: must be DOP, USD or TRY');
    expect(messageOf(() => parse(goalPatchSchema, { approxCur: 'usd' }))).toBe('Invalid data: approxCur: must be DOP, USD or TRY');
  });
});

describe('settings (PATCH /api/settings)', () => {
  it('language: one of the app languages', () => {
    for (const language of ['en', 'es', 'tr']) expect(parse(settingsUpdateSchema, { language })).toEqual({ language });
    for (const language of ['fr', 'EN', 'español', '', null, 1]) {
      expect(messageOf(() => parse(settingsUpdateSchema, { language })), String(language)).toBe(
        'Invalid data: language: must be one of: en, es, tr',
      );
    }
  });

  it('colors: null or all three, which come out normalized and with nothing else', () => {
    expect(parse(settingsUpdateSchema, { theme: null })).toEqual({ theme: null });
    expect(parse(settingsUpdateSchema, { theme: { accent: '#ABC', header: ' #000000', background: '#FFFFFF', extra: 1 } })).toEqual({
      theme: { accent: '#aabbcc', header: '#000000', background: '#ffffff' },
    });
    const message = 'Invalid data: theme: must be null or the three colors accent, header and background as "#rrggbb"';
    for (const theme of ['#fff', {}, { accent: '#112233' }, { accent: '#112233', header: '#000000', background: 'white' }, 0, false, []]) {
      expect(messageOf(() => parse(settingsUpdateSchema, { theme })), JSON.stringify(theme)).toBe(message);
    }
  });

  it('currencies: each one is DOP, USD or TRY; if both are sent, they must differ', () => {
    expect(parse(settingsUpdateSchema, { mainCurrency: 'TRY' })).toEqual({ mainCurrency: 'TRY' });
    expect(parse(settingsUpdateSchema, { secondCurrency: 'DOP' })).toEqual({ secondCurrency: 'DOP' });
    // Swapping them means sending both.
    expect(parse(settingsUpdateSchema, { mainCurrency: 'USD', secondCurrency: 'DOP' })).toEqual({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    expect(messageOf(() => parse(settingsUpdateSchema, { mainCurrency: 'USD', secondCurrency: 'USD' }))).toBe(
      'Invalid data: secondCurrency: must be different from mainCurrency',
    );
    for (const currency of ['EUR', 'usd', '', null, 1]) {
      expect(messageOf(() => parse(settingsUpdateSchema, { mainCurrency: currency })), String(currency)).toBe(
        'Invalid data: mainCurrency: must be DOP, USD or TRY',
      );
    }
    for (const currency of ['EUR', 'usd', '', 'None', 1]) {
      expect(() => parse(settingsUpdateSchema, { secondCurrency: currency }), String(currency)).toThrow(ApiError);
    }
  });

  it('optional second currency: null or "none" remove it, and with none there is no pair to compare', () => {
    expect(parse(settingsUpdateSchema, { secondCurrency: null })).toEqual({ secondCurrency: null });
    expect(parse(settingsUpdateSchema, { secondCurrency: 'none' })).toEqual({ secondCurrency: null });
    expect(parse(settingsUpdateSchema, { mainCurrency: 'USD', secondCurrency: 'none' })).toEqual({ mainCurrency: 'USD', secondCurrency: null });
  });

  it('default account: an id or null (the automatic one)', () => {
    expect(parse(settingsUpdateSchema, { defaultAccountId: 'dr' })).toEqual({ defaultAccountId: 'dr' });
    expect(parse(settingsUpdateSchema, { defaultAccountId: null })).toEqual({ defaultAccountId: null });
    for (const defaultAccountId of ['', 'con espacios', 7, {}]) {
      expect(() => parse(settingsUpdateSchema, { defaultAccountId }), JSON.stringify(defaultAccountId)).toThrow(ApiError);
    }
  });

  it('only changes what is sent: something has to be sent, and nothing unknown', () => {
    expect(parse(settingsUpdateSchema, { language: 'tr', theme: null })).toEqual({ language: 'tr', theme: null });
    expect(messageOf(() => parse(settingsUpdateSchema, {}))).toBe(
      'Invalid data: nothing to change: send theme, language, mainCurrency, secondCurrency, defaultAccountId or goldPrice',
    );
    expect(messageOf(() => parse(settingsUpdateSchema, { defaultRate: 60 }))).toContain('Unrecognized key: "defaultRate"');
    expect(messageOf(() => parse(settingsUpdateSchema, { language: 'es', initialized: false }))).toContain('Unrecognized key: "initialized"');
  });
});

describe('goals', () => {
  it('goalPlanIssue: all three together (monthly > 0, start <= end) or all three null', () => {
    // The monthly amount is called `monthly` in the API and `monthlyUSD` in the Excel workbook: the message uses whichever applies.
    expect(goalPlanIssue({ monthly: 3000, start: null, end: null }, 'monthlyUSD')).toEqual({
      kind: 'partial',
      path: 'monthlyUSD',
      message: 'monthlyUSD, start and end go together: set all three, or leave all three null',
    });
    expect(goalPlanIssue({ monthly: 0, start: '2026-08', end: '2027-10' }, 'monthlyUSD')).toMatchObject({ kind: 'amount', path: 'monthlyUSD' });
    expect(goalPlanIssue({ monthly: null, start: null, end: null })).toBeNull();
    expect(goalPlanIssue({ monthly: 3000, start: '2026-08', end: '2027-10' })).toBeNull();
    expect(goalPlanIssue({ monthly: 0.01, start: '2026-08', end: '2026-08' })).toBeNull();
    for (const plan of [
      { monthly: 3000, start: null, end: null },
      { monthly: null, start: '2026-08', end: '2027-10' },
      { monthly: 3000, start: '2026-08', end: null },
      { monthly: 3000, start: null, end: '2027-10' },
      { monthly: null, start: null, end: '2027-10' },
    ]) {
      expect(goalPlanIssue(plan), JSON.stringify(plan)).toMatchObject({ kind: 'partial', path: 'monthly' });
    }
    expect(goalPlanIssue({ monthly: 0, start: '2026-08', end: '2027-10' })).toMatchObject({ kind: 'amount', path: 'monthly' });
    expect(goalPlanIssue({ monthly: -5, start: '2026-08', end: '2027-10' })).toMatchObject({ kind: 'amount' });
    expect(goalPlanIssue({ monthly: 3000, start: '2027-11', end: '2027-10' })).toMatchObject({ kind: 'order', path: 'end' });
    // The year counts: December 2026 comes before January 2027.
    expect(goalPlanIssue({ monthly: 3000, start: '2026-12', end: '2027-01' })).toBeNull();
  });

  it('create: the plan is required in full; without a plan, all three null or absent', () => {
    expect(parse(goalCreateSchema, { name: ' Car ' })).toEqual({ name: 'Car' });
    // The currency is optional: without it, the user's main currency.
    expect(parse(goalCreateSchema, { name: 'Car', cur: 'TRY' })).toEqual({ name: 'Car', cur: 'TRY' });
    expect(messageOf(() => parse(goalCreateSchema, { name: 'Car', monthlyUSD: 100 }))).toContain('Unrecognized key: "monthlyUSD"');
    expect(parse(goalCreateSchema, { name: 'Car', monthly: null, start: null, end: null })).toEqual({
      name: 'Car',
      monthly: null,
      start: null,
      end: null,
    });
    const planned = { id: 'trip', name: 'Trip', monthly: 3000, start: '2026-08', end: '2027-10' };
    expect(parse(goalCreateSchema, planned)).toEqual(planned);

    const partial = 'Invalid data: monthly: monthly, start and end go together: set all three, or leave all three null';
    expect(messageOf(() => parse(goalCreateSchema, { name: 'x', monthly: 100 }))).toBe(partial);
    expect(messageOf(() => parse(goalCreateSchema, { name: 'x', end: '2027-01' }))).toBe(partial);
    expect(messageOf(() => parse(goalCreateSchema, { ...planned, start: null }))).toBe(partial);
    expect(messageOf(() => parse(goalCreateSchema, { ...planned, start: '2027-11' }))).toBe(
      'Invalid data: end: the start month cannot be after the end month',
    );
    // A malformed field is reported once, without adding the plan rule to it.
    expect(messageOf(() => parse(goalCreateSchema, { ...planned, monthly: 0 }))).toBe('Invalid data: monthly: must be greater than 0');
    expect(messageOf(() => parse(goalCreateSchema, { ...planned, start: 'zz' }))).toBe('Invalid data: start: is not a valid month (YYYY-MM)');
    // The target amount does not travel (it is monthly × months) and the server sets the order.
    expect(() => parse(goalCreateSchema, { ...planned, target: 45000 })).toThrow(ApiError);
    expect(() => parse(goalCreateSchema, { ...planned, sort: 0 })).toThrow(ApiError);
  });

  it('name: trimmed, non-empty and up to 120 characters', () => {
    expect(parse(goalCreateSchema, { name: 'x'.repeat(120) }).name).toHaveLength(120);
    expect(messageOf(() => parse(goalCreateSchema, { name: '  ' }))).toBe('Invalid data: name: cannot be empty');
    expect(messageOf(() => parse(goalCreateSchema, { name: 'x'.repeat(121) }))).toBe('Invalid data: name: allows up to 120 characters');
    expect(messageOf(() => parse(goalPatchSchema, { name: '' }))).toBe('Invalid data: name: cannot be empty');
    expect(parse(goalPatchSchema, { name: ' Viaje a Turquía ' })).toEqual({ name: 'Viaje a Turquía' });
  });

  it('edit: each field separately; the repository applies the full rule to the resulting goal', () => {
    expect(parse(goalPatchSchema, { monthly: null, start: null, end: null })).toEqual({ monthly: null, start: null, end: null });
    // A single part of the plan passes body validation: whether it is valid or not depends on the existing goal.
    expect(parse(goalPatchSchema, { end: '2027-12' })).toEqual({ end: '2027-12' });
    expect(parse(goalPatchSchema, { monthly: 100 })).toEqual({ monthly: 100 });
    expect(parse(goalPatchSchema, {})).toEqual({});
    expect(parse(goalPatchSchema, { cur: 'DOP' })).toEqual({ cur: 'DOP' });
    expect(() => parse(goalPatchSchema, { cur: null })).toThrow(ApiError);
    // What already contradicts itself does not.
    expect(messageOf(() => parse(goalPatchSchema, { start: '2027-02', end: '2027-01' }))).toBe(
      'Invalid data: end: the start month cannot be after the end month',
    );
    expect(() => parse(goalPatchSchema, { monthly: 0 })).toThrow(ApiError);
    expect(() => parse(goalPatchSchema, { id: 'otra' })).toThrow(ApiError);
  });
});

describe('recording from Claude and import', () => {
  it('ingest: null and empty are taken as absent; everything else, strict', () => {
    expect(parse(ingestSchema, { description: ' Pan ', amount: 90, date: null, category: '', notes: ' algo ', user: null })).toEqual({
      description: 'Pan',
      amount: 90,
      notes: 'algo',
    });
    expect(() => parse(ingestSchema, { description: 'Pan', amount: 90, date: '31/10/2026' })).toThrow(ApiError);
    expect(() => parse(ingestSchema, { description: null, amount: 90 })).toThrow(ApiError);
  });

  it('ingest: `user` is text; server/ingest.ts decides who it is with the configured users', () => {
    expect(parse(ingestSchema, { description: 'Pan', amount: 90, user: ' Eda ' })).toEqual({ description: 'Pan', amount: 90, user: 'Eda' });
    expect(messageOf(() => parse(ingestSchema, { description: 'Pan', amount: 90, user: 7 }))).toBe('Invalid data: user: must be text');
    expect(() => parse(ingestSchema, { description: 'Pan', amount: 90, user: ['eda'] })).toThrow(ApiError);
  });

  it('ingest: `account` is text (an id or a name; server/ingest.ts decides which one it is) and the currency can be TRY', () => {
    expect(parse(ingestSchema, { description: 'Pan', amount: 90, account: ' DR account ', currency: 'TRY' })).toEqual({
      description: 'Pan',
      amount: 90,
      account: 'DR account',
      currency: 'TRY',
    });
    expect(parse(ingestSchema, { description: 'Pan', amount: 90, account: '  ' })).toEqual({ description: 'Pan', amount: 90 });
    expect(parse(ingestSchema, { description: 'Pan', amount: 90, account: null })).toEqual({ description: 'Pan', amount: 90 });
    expect(messageOf(() => parse(ingestSchema, { description: 'Pan', amount: 90, account: 7 }))).toBe('Invalid data: account: must be text');
    expect(messageOf(() => parse(ingestSchema, { description: 'Pan', amount: 90, account: 'x'.repeat(121) }))).toBe(
      'Invalid data: account: allows up to 120 characters',
    );
    expect(messageOf(() => parse(ingestSchema, { description: 'Pan', amount: 90, accountId: 'dr' }))).toContain('Unrecognized key: "accountId"');
  });

  it('import: repeated months and size limits', () => {
    const month = { key: '2026-10', closed: false, budget: 0, incomeUSD: 0, accounts: { usd: 0, dop: 0 }, fixed: [], transfers: [], tx: [] };
    const base = { months: [month], contribs: null, goals: null };
    expect(parse(importSchema, base)).toEqual(base);
    expect(messageOf(() => parse(importSchema, { ...base, months: [month, month] }))).toBe('Invalid data: months: there are repeated months');
    const fixed = Array.from({ length: 501 }, () => ({ name: 'x', day: '', amount: 1, cur: 'DOP', paid: false }));
    expect(messageOf(() => parse(importSchema, { ...base, months: [{ ...month, fixed }] }))).toBe(
      'Invalid data: months.0.fixed: allows up to 500 items',
    );
    const goals = Array.from({ length: 201 }, (_, i) => ({ name: `Meta ${i}`, monthlyUSD: null, start: null, end: null }));
    expect(messageOf(() => parse(importSchema, { ...base, goals }))).toBe('Invalid data: goals: allows up to 200 items');
  });

  it('import: the workbook keeps the original format, which only knows DOP and USD', () => {
    const month = { key: '2026-10', closed: false, budget: 0, incomeUSD: 0, accounts: { usd: 0, dop: 0 }, fixed: [], transfers: [], tx: [] };
    const fixed = [{ name: 'x', day: '', amount: 1, cur: 'TRY', paid: false }];
    expect(messageOf(() => parse(importSchema, { months: [{ ...month, fixed }], contribs: null, goals: null }))).toBe(
      'Invalid data: months.0.fixed.0.cur: must be DOP or USD',
    );
    const contribs = [{ date: '2026-10-01', goalName: 'x', amount: 1, cur: 'TRY' }];
    expect(messageOf(() => parse(importSchema, { months: [], contribs, goals: null }))).toBe('Invalid data: contribs.0.cur: must be DOP or USD');
    // And it still carries the budget, the income and the two balances of the month: not the parts per account.
    expect(() => parse(importSchema, { months: [{ ...month, budgets: {} }], contribs: null, goals: null })).toThrow(ApiError);
  });

  it('import: `goals` is required (null if the workbook has no savings sheet) and each goal carries its full plan or none', () => {
    const base = { months: [], contribs: null };
    expect(() => parse(importSchema, base)).toThrow(ApiError);
    // The format of the previous version, with the parameters of a single goal, is no longer accepted.
    expect(messageOf(() => parse(importSchema, { ...base, goals: null, turkey: null }))).toContain('Unrecognized key: "turkey"');

    const goals = [
      { name: ' Trip to Turkey ', monthlyUSD: 3000, start: '2026-08', end: '2027-10' },
      { name: 'Emergency fund', monthlyUSD: null, start: null, end: null },
    ];
    expect(parse(importSchema, { ...base, goals }).goals).toEqual([{ ...goals[0], name: 'Trip to Turkey' }, goals[1]]);
    expect(parse(importSchema, { ...base, goals: [] }).goals).toEqual([]);

    const partial = 'monthlyUSD, start and end go together: set all three, or leave all three null';
    expect(messageOf(() => parse(importSchema, { ...base, goals: [goals[1], { ...goals[0], start: null }] }))).toBe(
      `Invalid data: goals.1.monthlyUSD: ${partial}`,
    );
    expect(messageOf(() => parse(importSchema, { ...base, goals: [{ ...goals[0], monthlyUSD: 0 }] }))).toBe(
      'Invalid data: goals.0.monthlyUSD: must be greater than 0',
    );
    expect(messageOf(() => parse(importSchema, { ...base, goals: [{ ...goals[0], end: '2026-07' }] }))).toBe(
      'Invalid data: goals.0.end: the start month cannot be after the end month',
    );
    expect(messageOf(() => parse(importSchema, { ...base, goals: [{ name: 'x' }] }))).toContain('goals.0.monthlyUSD: is required');
    expect(() => parse(importSchema, { ...base, goals: [{ ...goals[0], id: 'turkey' }] })).toThrow(ApiError);
  });
});

describe('toApiError', () => {
  it('lets ApiErrors through, translates the zod ones and hides everything else', () => {
    const api = new ApiError(409, 'month_closed', 'closed');
    expect(toApiError(api)).toBe(api);

    const zod = txCreateSchema.safeParse({ ...tx, amount: 0 });
    expect(zod.success).toBe(false);
    if (!zod.success) {
      expect(toApiError(zod.error)).toMatchObject({ status: 400, code: 'validation', message: zodMessage(zod.error) });
    }

    for (const err of [new Error('D1_ERROR: no such table: x'), 'texto', null, undefined, { status: 404 }]) {
      expect(toApiError(err)).toMatchObject({ status: 500, code: 'internal', message: 'Internal server error.' });
    }
  });
});
