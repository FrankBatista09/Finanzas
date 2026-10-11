import type { Account, AccountCurrency, Currency, Goal, Gold } from './types';

/** App name: the brand in the top bar, the tab title and the Excel file name. */
export const APP_NAME = 'FE Finance';

// The values that get STORED (categories, methods) are these canonical English names, whatever the language of
// whoever records them; they are translated when shown (shared/i18n.ts catLabel / methodLabel). A value outside the
// list (free text, imported data) is shown as is.

export const CATS = [
  'Food',
  'Groceries',
  'Transport',
  'Entertainment',
  'Health',
  'Clothing',
  'Home',
  'Subscriptions',
  'Education',
  'Travel',
  'Other',
] as const;

export const METHODS = ['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash'] as const;

/**
 * Payment method that charges the transaction to the credit card: it comes out of no account and does not count as used
 * until the credit card is paid (shared/calc.ts cardCalc). With "Debit card" and the rest, everything stays the same.
 */
export const CREDIT_CARD_METHOD = 'Credit card';

/** Category and method of the transaction created when an expense moves from "Outside budget" into the budget (it has neither). */
export const MOVED_TO_BUDGET = { cat: 'Other', method: 'Transfer' } as const;

/** Suggestions for the via of a transfer. It is free text: any other one can be typed. */
export const VIAS = ['Remitly', 'PayPal'] as const;

/** In the order they are offered in the selects. */
export const CURRENCIES: readonly Currency[] = ['DOP', 'USD', 'TRY'];

/** Gold as the "currency" of an account: it is measured in grams (shared/types.ts Gold). */
export const GOLD: Gold = 'XAU';
/** Unit in which gold balances are shown: "125.50 g". The same in all three languages. */
export const GOLD_UNIT = 'g';
/** Decimals accepted and shown, at most, in an amount of gold. */
export const GOLD_DECIMALS = 3;

/** What is offered when creating or editing an ACCOUNT, and only there: the currencies and gold. */
export const ACCOUNT_CURRENCIES: readonly AccountCurrency[] = [...CURRENCIES, GOLD];

export function isGold(currency: AccountCurrency | null | undefined): currency is Gold {
  return currency === GOLD;
}

/** Currencies a new user starts with; each user changes them in Settings. */
export const DEFAULT_MAIN_CURRENCY: Currency = 'DOP';
export const DEFAULT_SECOND_CURRENCY: Currency = 'USD';

/**
 * Maximum length of the texts. The API requires it (server/validate.ts) and the cells enforce it (maxLength),
 * so that a save is not rejected over a text that is too long. `label` applies to category, method and via.
 */
export const MAX_LEN = { name: 120, desc: 200, place: 120, label: 60, day: 20, notes: 1000 } as const;

/** Reference USD→DOP rate (Remitly): the fallback when no month has a rate or transfers for that pair. */
export const DEFAULT_RATE = 58.76;

/**
 * Last fallback for conversions: how many units of each currency 1 USD is worth. Only used when neither the month
 * nor any earlier one has a rate for the pair; the interface warns when a figure comes from here (RateInfo.source
 * === 'default'), because it is a fixed value and not the market's. The DOP one is replaced by settings.default_rate.
 */
export const DEFAULT_USD_RATES: Readonly<Record<Currency, number>> = { USD: 1, DOP: DEFAULT_RATE, TRY: 42 };

/** The users live in the Dominican Republic (UTC-4, no daylight saving time): "today" is computed in this zone. */
export const TIMEZONE = 'America/Santo_Domingo';

/**
 * Accounts a new user starts with (the server creates them the first time the user signs in). They are the two from
 * the original design; each user adds their own (PayPal, TR account…), renames them or hides the ones they do not use.
 * An account's name is user data and is not translated.
 */
export const DEFAULT_ACCOUNTS: readonly Account[] = [
  { id: 'us', name: 'US account', currency: 'USD', opening: 0, hidden: false, sort: 0 },
  { id: 'dr', name: 'DR account', currency: 'DOP', opening: 0, hidden: false, sort: 1 },
];

/**
 * Goals a new user starts with (the server creates them the first time the user signs in).
 * They take variable contributions; goals with a plan (target amount and dates) are added by each user from Savings.
 * A goal's name is user data (the user can change it) and is not translated.
 */
export const DEFAULT_GOALS: readonly Goal[] = [
  { id: 'emergency', name: 'Emergency fund', cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: 0 },
  { id: 'personal', name: 'Personal savings', cur: 'USD', monthly: null, start: null, end: null, approxCur: null, sort: 1 },
];
