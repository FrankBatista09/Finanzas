// Remote MCP (Model Context Protocol) server at /mcp: it is what lets you tell Claude
// "I spent 850 on Uber today by card" and have it recorded.
//
// Stateless Streamable HTTP transport, with no SDK: each POST carries a JSON-RPC 2.0 message and the response goes
// back as JSON in that same request. There are no sessions (no Mcp-Session-Id is issued) and no SSE stream, so GET
// and DELETE answer 405. Every request requires Authorization: Bearer <API_TOKEN>.
//
// It speaks both eras of the protocol on the same endpoint:
//   · with a handshake (2025-11-25 and earlier): initialize negotiates the version; then ping, tools/list and
//     tools/call, alone or in a batch;
//   · without a handshake (2026-07-28): each request declares its version in the MCP-Protocol-Version header and in
//     `_meta`, repeats its method in Mcp-Method, and the server describes itself with server/discover.
// Since nothing is kept between requests here, the era is decided on each one from what it carries.
//
// Whose data it is: each person has their own separate finances (USERS, shared/users.ts) and there is a single
// Bearer for all of them, so every tool takes `user`. It is required when more than one user is
// configured: the model gets it from the conversation or from the project instructions and, if it does not know,
// it has to ask. Since the list comes from the environment, tools/list and the instructions are built on each request.
//
// Money: each user has their own accounts, main currency and second currency. Everything that is recorded
// moves the balance of an account (an expense subtracts from the account it is paid from, an income adds, a transfer
// moves money from one to another), so each confirmation says which account and what its balance is now. The month's
// figures are in the user's main currency, with its code. All the calculations come from shared/calc.ts.
//
// Language: everything this server says to the model is in English (Claude already speaks to each person in
// their own). What the user dictates is not translated; categories and methods are accepted in any of the app's
// languages and stored under their canonical name (shared/i18n.ts).
//
// A tool's domain and validation failures (closed month, invalid date, missing user,
// fixed expense that does not exist) are a normal result with isError: true, so the model can read them and
// correct itself; JSON-RPC errors are left for protocol failures.

import { z } from 'zod';
import {
  accountsById,
  balances,
  budgetHistory,
  budgetSummary,
  cardCalc,
  cardCalcs,
  cardHint,
  convert,
  currentKey,
  cardAccountFor,
  defaultAccount,
  FEE_CATEGORY,
  incomeInMonth,
  isCardTx,
  isMoneyAccount,
  isMoneyIncome,
  leftoverFor,
  monthCalc,
  outsideOf,
  outsideSummary,
  rateFor,
  sortedKeys,
  transferFees,
  transferReceived,
} from '../shared/calc';
import type { AccountBalance, Balances, BudgetSummary, CardCalc, MonthCalc, RateInfo, RateSource } from '../shared/calc';
import { APP_NAME, CATS, GOLD, GOLD_UNIT, isGold, METHODS, TIMEZONE, VIAS } from '../shared/constants';
import { f0, f2, fGrams, fRate } from '../shared/format';
import { canonicalCat, canonicalMethod } from '../shared/i18n';
import { clampToMonth, currentMonthKey, isISODate, isMonthKey, label, monthOf, monthSpan, todayISO } from '../shared/month';
import type { Account, AccountCurrency, AppState, AppUser, CreditCard, Currency, FixedExpense, Income, ISODate, Month, MonthKey } from '../shared/types';
import { checkBearer } from './auth';
import { readLimitedBody } from './body';
import { addBudgetEntry, createIncome, createOutside, createTransfer, ensureMonth, getMonth, listCards, loadState, patchFixed, payCard, userAccounts, userState } from './db';
import type { Env } from './env';
import {
  ApiError,
  errorBody,
  goldAccountError,
  INTERNAL_MESSAGE,
  invalidData,
  monthClosedError,
  noAccountsError,
  notFoundError,
  toApiError,
  validationError,
} from './errors';
import { ingestTransaction, matchAccount, matchCard } from './ingest';
import { configuredUsers, userFromBody } from './users';
import { fixedPatchSchema, incomeCreateSchema, MAX_AMOUNT, MAX_LEN, parse, transferCreateSchema } from './validate';

/** The app's currencies, as the model sees them: always by their code. */
const CURRENCY_CODES = ['DOP', 'USD', 'TRY'] as const satisfies readonly Currency[];


// ── Protocol ─────────────────────────────────────────────────────────────────

/** Revisions without a handshake: each request declares its version and the client's capabilities. */
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;
/** Revisions with the `initialize` handshake. */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** Every MCP revision this server understands, from newest to oldest. */
export const PROTOCOL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** `version` is the one in package.json (server/mcp.test.ts checks that they do not drift apart). */
export const SERVER_INFO = { name: 'fe-finance', title: APP_NAME, version: '0.1.0' } as const;

/** An MCP message of this server takes a few hundred bytes; the cap only stops abuse. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Each tool call is several D1 queries: a batch cannot multiply them without limit. */
export const MAX_BATCH = 20;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
// MCP's own codes (2026-07-28). A client that speaks both eras recognizes a server without a handshake
// by them and fixes the request instead of going back to initialize.
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** `_meta` keys reserved by the protocol without a handshake. */
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const CAPABILITIES = { tools: {} } as const;

/**
 * Cache hints for server/discover and tools/list (2026-07-28). The list is the same for anyone
 * ("public") and only changes with a deploy (the users it names come from the USERS variable): five
 * minutes without asking for it again is low risk.
 */
const CACHE_HINTS = { ttlMs: 5 * 60 * 1000, cacheScope: 'public' } as const;

type JsonRpcId = string | number;

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

type Incoming =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification' }
  | { kind: 'response' }
  | { kind: 'invalid'; id: JsonRpcId | null };

/**
 * Protocol failure: it is answered as a JSON-RPC error with this code. `status` is the HTTP status when the
 * request travels alone (in a batch the response is always 200).
 */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status: number = 200,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

function failure(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...NO_STORE, ...headers } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is JsonRpcId {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

function isSupported(version: string): boolean {
  return (PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

function isModern(version: string): boolean {
  return (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

function isLegacy(version: string): boolean {
  return (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/** What the client sent and is echoed back in an error message: bounded, in case something huge comes in. */
function quoted(value: string): string {
  return value.slice(0, 80);
}

function classify(msg: unknown): Incoming {
  if (!isRecord(msg)) return { kind: 'invalid', id: null };
  // MCP does not allow a null id: an id that is not text or a number identifies nothing.
  const id = isId(msg.id) ? msg.id : null;
  if (msg.jsonrpc !== '2.0') return { kind: 'invalid', id };
  if ('method' in msg) {
    if (typeof msg.method !== 'string') return { kind: 'invalid', id };
    if (!('id' in msg)) return { kind: 'notification' };
    return id === null ? { kind: 'invalid', id } : { kind: 'request', id, method: msg.method, params: msg.params };
  }
  // The client's response to a request from the server. This server makes no requests: it is accepted and ignored.
  if (id !== null && ('result' in msg || 'error' in msg)) return { kind: 'response' };
  return { kind: 'invalid', id };
}

// ── Users ────────────────────────────────────────────────────────────────────

/** "frank (Frank), eda (Eda)": the id is what goes in `user`; the name, what that person is called. */
function userList(users: readonly AppUser[]): string {
  return users.map((u) => `${u.id} (${u.name})`).join(', ');
}

/** The `user` property of each tool's inputSchema: its values are the configured users. */
function userProperty(users: readonly AppUser[]): Record<string, unknown> {
  const ids = users.map((u) => u.id);
  if (ids.length === 1) {
    return {
      type: 'string',
      enum: ids,
      default: ids[0],
      description: `Whose finances to act on. Only one user is configured, ${userList(users)}, so it can be omitted.`,
    };
  }
  return {
    type: 'string',
    enum: ids,
    description: `Whose finances to act on, by id: ${userList(users)}. Use the person named in the conversation or in the project instructions; if it is not clear who, ask instead of guessing.`,
  };
}

function userError(users: readonly AppUser[], problem: string): ApiError {
  const ask = users.length > 1 ? ' If it is not clear whose finances are meant, ask the person; do not guess.' : '';
  return validationError(invalidData(`user: ${problem}. Valid users: ${userList(users)}.${ask}`));
}

/**
 * Whose finances a call is about. The rule is the one in server/users.ts (the id, case-insensitive;
 * it can be omitted if only one user is configured). What changes here is the message: it names each
 * user, so the model knows who each id belongs to and asks the person instead of trying another one.
 */
function resolveUser(users: readonly AppUser[], value: unknown): AppUser {
  const given = value ?? undefined;
  if (given !== undefined && typeof given !== 'string') throw userError(users, 'must be text');
  try {
    return userFromBody(users, given);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    throw userError(users, given?.trim() ? `unknown user "${quoted(given.trim())}"` : 'is required');
  }
}

// ── Texts for the model ──────────────────────────────────────────────────────

/** The instructions name the configured users: they are built on each request. */
function instructions(users: readonly AppUser[]): string {
  const who =
    users.length === 1
      ? `Users: only one user is configured, ${userList(users)}. Every tool takes \`user\`; with a single user it can be omitted.`
      : `Users: each person has completely separate finances (their own accounts, currencies, months, budget, monthly expenses, transactions, incomes and transfers). Configured users: ${userList(users)}. Every tool takes \`user\`, the id of the person whose finances to act on, and it is required. Use the person named in the conversation or in the project instructions. If it is not clear whose finances are meant, ask before calling a tool: never guess, and never record one person's expense under another person.`;
  return [
    `${APP_NAME}: personal finances. With these tools you record a person's expenses, incomes and transfers, and check how the month and the accounts are going.`,
    who,
    `Money: each person has their own accounts (a name and a currency: ${CURRENCY_CODES.join(', ')}) and their own main currency, in which budget and totals are shown. Nobody types a balance: every movement changes it. An expense is subtracted from the account it is paid from, which is the person's default account unless they name another one. An income adds to an account. A transfer moves money from one account to another. Call list_accounts when you need to know which accounts exist.`,
    `Gold: an account can also hold gold, measured in grams (its currency is ${GOLD} and balances read like "125.50 ${GOLD_UNIT}"). A gold account is not money: it cannot pay expenses or fixed expenses, send or receive transfers, carry budget or be the default account, and the tools reject it. Grams are added to it with add_income (the amount is grams; no \`currency\`, no \`add_to_budget\`). Its value in money comes from the gold price the person types in the web app (the value of 1 gram); while no price is set, gold is shown in grams only and is not counted in the total money. The gold price cannot be changed from these tools.`,
    'Language: these tools answer in English only; talk to each person in their own language. People may dictate in Spanish or Turkish: pass descriptions, places, notes, account names and names of fixed expenses exactly as they said them, without translating.',
    'Currency: when the person names a currency (dollars, pesos, lira), record the amount in the currency they said, even if it is not the currency of the account: the server converts with the rate in effect on the date of the record. If they name none, omit `currency` and the currency of the account is used. Never convert an amount yourself.',
    `Date: by default, today in ${TIMEZONE}. If the person gives no date or says "today", omit \`date\` and the server uses today's. Dates are YYYY-MM-DD and months are YYYY-MM. Each record goes to the month of its date. For relative dates ("yesterday", "on Friday") start from today's date as returned by month_summary or list_accounts.`,
    `Categories: ${CATS.join(', ')}. Always choose the one that best describes the expense; if none is given it is ${CATS[0]}.`,
    `Payment methods: ${METHODS.join(', ')}. If none is given it is ${METHODS[0]}.`,
    'Categories and payment methods are stored under these English names. Pass the English name; the Spanish or Turkish name ("Comida", "Yemek", "Tarjeta", "Kart") is also accepted and stored as the English one. A plain "card" ("tarjeta", "kart") is stored as Debit card; when the person says it was a credit card ("tarjeta de credito", "kredi karti"), pass Credit card.',
    `Transfers: \`via\` is the service used, as free text (${VIAS.join(', ')} or any other; ${VIAS[0]} by default). Between accounts of different currencies the rate is what arrives per unit sent (for example, the DOP received per USD).`,
    'Rates: each month has its own rates between currencies. When a tool says that a rate is a default value, nobody has set it yet: tell the person, because the converted amounts are only approximate until they type the rate of the month in the web app.',
    'Outside-budget expenses: an expense the person says is outside their budget is recorded with add_outside_expense. It lowers the account balance like any expense but does not count in used, available or the categories.',
    'Fixed expenses (the "Fixed monthly expenses" list of the app): the same items every month (electricity, internet, subscriptions…). They are not recorded as transactions: mark them as paid with mark_fixed_paid.',
    'Credit card: it is a deferred payment. A purchase with method "Credit card" (or a fixed expense on the card) does not touch any account or the budget when it is made; the month has a credit card total, and only when the person pays the bill (all of it or part, with pay_credit_card, as many payments as they make) is the budget charged and the paying account debited. What is left unpaid stays pending in the month and, if the month closes with it unpaid, carries to the next one. The person may have several credit cards, or none (list_credit_cards): pass `card` to add_transaction or pay_credit_card when they name one.',
    'A closed month is read-only: it can be consulted, but it accepts no expenses, transfers or changes until the person reopens it in the web app. If a tool answers that the month is closed, tell the person; do not record it under another date.',
    'After recording something, confirm to the person what was recorded and for whom, with the amount, the account and its new balance, based on the text the tool returns.',
  ].join('\n');
}

const SEP = ' · ';

/** How the default month is explained to the model (see resolveMonth). */
const IN_PROGRESS = 'the month in progress (the calendar month or, if it does not exist yet or is already closed, the last open month)';

/** An amount with its currency; for gold, its grams: "125.50 g". */
function money(amount: number, cur: AccountCurrency): string {
  return isGold(cur) ? `${fGrams(amount)} ${GOLD_UNIT}` : `${f2(amount)} ${cur}`;
}

/**
 * An amount and, if it is in a currency other than `to`, its equivalent too: at the rate in effect on `date` if the
 * row has its own date, or at the latest one of month `key` if not.
 */
function moneyIn(state: AppState, key: MonthKey, amount: number, cur: Currency, to: Currency, date?: ISODate): string {
  return cur === to ? money(amount, cur) : `${money(amount, cur)} (${money(convert(state, key, amount, cur, to, date), to)})`;
}

/** An amount with its sign showing: "+5,000.00 DOP", "-1,200.00 DOP". */
function signed(amount: number, cur: Currency): string {
  return `${amount < 0 ? '-' : '+'}${money(Math.abs(amount), cur)}`;
}

function monthTitle(m: Pick<Month, 'key' | 'closed'>): string {
  return `${label(m.key)}${m.closed ? `${SEP}closed` : ''}`;
}

/** Heading of a query: whose figures they are and for which month. */
function heading(user: AppUser, m: Pick<Month, 'key' | 'closed'>): string {
  return `${user.name}${SEP}${monthTitle(m)}`;
}

function usedLine(c: MonthCalc): string {
  if (!(c.budget > 0)) return `Used so far: ${money(c.used, c.main)} (no budget set).`;
  const over = c.avail < 0 ? ` Over budget by ${money(-c.avail, c.main)}.` : '';
  return `Used so far: ${f2(c.used)} of ${f0(c.budget)} ${c.main}.${over}`;
}

function fixedLine(c: MonthCalc): string {
  return `Monthly expenses: ${c.paidCount} of ${c.fixedCount} paid${SEP}Fixed pending: ${money(c.pending, c.main)}.`;
}

/** The month's figures are in the user's main currency: `currency` says which one. */
function monthStatus(c: MonthCalc) {
  return { key: c.key, label: label(c.key), closed: c.closed, currency: c.main, budget: c.budget, used: c.used, available: c.avail };
}

// ── Rates ────────────────────────────────────────────────────────────────────

interface RateLine {
  from: Currency;
  to: Currency;
  /** 1 `from` = `rate` `to`. */
  rate: number;
  source: RateSource;
  /** Month the rate came from (shared/calc.ts RateInfo). */
  monthKey: MonthKey | null;
  /** Date it applies from, if it is a rate typed by hand; null if it came from somewhere else. */
  date: ISODate | null;
  /** Where it came from, in plain words: it is what warns of a rate that is not the month's. */
  note: string;
}

function rateNote(info: RateInfo, from: Currency, to: Currency): string {
  switch (info.source) {
    case 'same':
      return 'same currency';
    case 'month':
      return info.date ? `typed on ${info.date}` : 'typed for this month';
    case 'transfers':
      return "from this month's transfers";
    case 'cross':
      // With three currencies, the one that is neither of the two.
      return `crossed through ${CURRENCY_CODES.find((c) => c !== from && c !== to) ?? 'another currency'}`;
    case 'previous':
      // One typed in an earlier month stays in effect until another one is typed.
      if (info.date) return `typed on ${info.date}, still in effect`;
      return info.monthKey ? `from ${label(info.monthKey)}` : 'from an earlier month';
    case 'default':
      return 'default value, not set yet';
  }
}

/**
 * The rate between two currencies, in the direction it is read (the one worth more first: "USD to DOP: 58.76" and not
 * "DOP to USD: 0.02", which says nothing with two decimals). Without `date`, the month's latest; with it, the one in
 * effect that day.
 */
function rateLine(state: AppState, key: MonthKey, a: Currency, b: Currency, date?: ISODate): RateLine {
  const direct = rateFor(state, key, a, b, date);
  const [from, to, info] = direct.rate >= 1 ? [a, b, direct] : [b, a, rateFor(state, key, b, a, date)];
  return { from, to, rate: info.rate, source: info.source, monthKey: info.monthKey, date: info.date, note: rateNote(info, from, to) };
}

function rateText(r: RateLine): string {
  return `${r.from} to ${r.to}: ${fRate(r.rate)} (${r.note})`;
}

/** A single rate, in the direction it is read: "1 USD = 59.40 DOP" also for a transfer from DOP to USD. */
function pairText(from: Currency, to: Currency, rate: number): string {
  return rate >= 1 || !(rate > 0) ? `1 ${from} = ${fRate(rate)} ${to}` : `1 ${to} = ${fRate(1 / rate)} ${from}`;
}

/**
 * Warning that the converted amounts are approximate: at least one conversion from `cur` to the currencies in `to` in
 * month `key` comes from the default value, because nobody has typed that rate. One sentence per pair; none otherwise.
 */
function approxNotes(state: AppState, key: MonthKey, cur: Currency, to: readonly Currency[], date?: ISODate): string[] {
  return [...new Set(to)]
    .filter((other) => other !== cur)
    .map((other) => rateLine(state, key, cur, other, date))
    .filter((r) => r.source === 'default')
    .map((r) => `Note: the rate ${r.from} to ${r.to} (${fRate(r.rate)}) is a default value, not set yet, so the converted amounts are only approximate.`);
}

/** The rates used to bring each of the other currencies in `used` to the main currency. */
function ratesToMain(state: AppState, key: MonthKey, used: Iterable<Currency>): RateLine[] {
  const wanted = new Set(used);
  return CURRENCY_CODES.filter((c) => c !== state.mainCurrency && wanted.has(c)).map((c) => rateLine(state, key, c, state.mainCurrency));
}

// ── Rules shared by the tools ────────────────────────────────────────────────

/** What all the messages of one HTTP request share. */
interface ServerContext {
  db: D1Database;
  now: Date;
  /** The configured users (USERS), in their order. */
  users: readonly AppUser[];
}

interface ToolContext {
  db: D1Database;
  now: Date;
  /** Whose finances this call is about, already resolved: everything the tool reads or writes is theirs. */
  user: AppUser;
}

/**
 * The month a tool works on. Without `requested` it is the current month: the calendar one (in the
 * user's time zone) while it exists and is open; otherwise, the application's current month (the last open one).
 * It covers the first days of a month when the previous one has not been closed yet, and the last ones when the month
 * was closed early and work has already moved to the next one.
 */
function resolveMonth(state: AppState, requested: MonthKey | undefined, { now, user }: Pick<ToolContext, 'now' | 'user'>): Month {
  const calendar = currentMonthKey(now);
  const inCalendar = state.months[calendar];
  const key = requested ?? (inCalendar && !inCalendar.closed ? calendar : currentKey(state));
  const month = key ? state.months[key] : undefined;
  if (month) return month;

  const keys = sortedKeys(state);
  if (keys.length === 0) {
    throw notFoundError(`${user.name} has no months yet. Record a transaction to create the current month.`);
  }
  // With the key, which is what has to be sent in `month`.
  const known = keys.slice(-12).map((k) => `${k}${state.months[k]!.closed ? ' (closed)' : ''}`);
  throw notFoundError(`${label(key ?? calendar)} does not exist for ${user.name}. Existing months: ${known.join(', ')}.`);
}

/** Months back and ahead of today in which a tool accepts a date in a month that does not exist. */
const CREATE_MONTHS_BACK = 6;
const CREATE_MONTHS_AHEAD = 1;

/**
 * Recording something creates the month of its date if it does not exist. A wrong year from the model would leave a
 * ghost month (or an income nobody sees that moves a balance): that is why only dates in months close to today are
 * accepted. A month that already exists can be written to whatever its date.
 */
async function assertReachable({ db, now, user }: ToolContext, date: ISODate): Promise<void> {
  const key = monthOf(date);
  const offset = monthSpan(currentMonthKey(now), key) - 1;
  if (offset >= -CREATE_MONTHS_BACK && offset <= CREATE_MONTHS_AHEAD) return;
  if (await getMonth(db, user.id, key)) return;
  throw validationError(
    `The date ${date} falls in ${label(key)}, a month that does not exist for ${user.name} and is far from today (${todayISO(now)}). Check the year of the date.`,
  );
}

/**
 * What a confirmation reports after writing (the month's used amount, the account's new balance). It is an
 * extra: if it cannot be read or computed, the confirmation goes out without it. Answering with an error would make
 * the model repeat a record that was already saved.
 */
async function afterWrite<T>({ db, user }: ToolContext, derive: (state: AppState) => T): Promise<T | null> {
  try {
    return derive(await loadState(db, user.id));
  } catch (err) {
    console.error('[mcp] no se pudo leer el estado tras guardar', err);
    return null;
  }
}

/**
 * The balances "as of now": at the end of the most recent month among the recorded ones, the calendar one and the ones
 * given (that of the record just made). That way an expense dated in the next month already shows as subtracted.
 */
function balancesNow(state: AppState, now: Date, ...keys: MonthKey[]): { asOf: MonthKey; all: Balances } {
  const asOf = [...sortedKeys(state).slice(-1), currentMonthKey(now), ...keys].sort().at(-1)!;
  return { asOf, all: balances(state, asOf) };
}

function balanceOf(all: Balances, accountId: string): AccountBalance | null {
  return all.accounts.find((b) => b.account.id === accountId) ?? null;
}

function balanceSentence(b: AccountBalance): string {
  return `${b.account.name} balance: ${money(b.balance, b.account.currency)}.`;
}

/** An account in the raw data; `balance` is null if it could not be read after writing. */
function accountData(account: Account, b: AccountBalance | null) {
  return { id: account.id, name: account.name, currency: account.currency, balance: b ? b.balance : null };
}

/** The account `amount` goes into or comes out of, and how much it is in its currency if it was stated in another. */
function accountPart(state: AppState | null, key: MonthKey, account: Account, amount: number, cur: AccountCurrency, date?: ISODate): string {
  const to = account.currency;
  // Grams and money are not converted into each other in a movement.
  if (!state || cur === to || isGold(cur) || isGold(to)) return account.name;
  return `${account.name} (${money(convert(state, key, amount, cur, to, date), to)})`;
}

/**
 * An account's balance as it is told to the model, with its equivalent in `main` if it is in another currency. For a
 * gold account, its grams and what they are worth at the gold price; with no price, only the grams, and it says why.
 */
function balanceText(state: AppState, key: MonthKey, b: AccountBalance, main: Currency): string {
  const cur = b.account.currency;
  if (!isGold(cur)) return moneyIn(state, key, b.balance, cur, main);
  return b.valued ? `${money(b.balance, cur)} (${money(b.inMain, main)})` : `${money(b.balance, cur)} (no gold price set)`;
}

/** The real currencies among those of some accounts: gold has no rate. */
function moneyCurrencies(list: readonly AccountCurrency[]): Currency[] {
  return list.filter((c): c is Currency => !isGold(c));
}

/**
 * What there is to know about gold when the user has a visible gold account: the typed price and, if there is
 * none, that gold is left out of the total. No line if they have no gold in view.
 */
function goldLines(state: AppState, all: Balances): string[] {
  if (!all.accounts.some((b) => !b.account.hidden && isGold(b.account.currency))) return [];
  const price = state.goldPrice;
  return [
    price
      ? `Gold price: 1 ${GOLD_UNIT} = ${money(price.amount, price.currency)} (typed by the person in the web app).`
      : 'Gold is not included in the total money: no gold price is set. The person can type the value of 1 gram in the web app (Savings).',
  ];
}

/** The account the person names or, if they name none, their default account. */
async function resolveAccount({ db, user }: ToolContext, named: string | undefined): Promise<Account> {
  const { accounts, defaultAccount } = await userAccounts(db, user.id);
  const account = named === undefined ? defaultAccount : matchAccount(accounts, named);
  if (!account) throw noAccountsError();
  return account;
}

/** For comparing names ignoring case, accents and extra spaces. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fixed expenses that match `name`: first by exact name, otherwise by prefix and otherwise by containment.
 * Returns those of the first criterion that hits; more than one means the name is ambiguous.
 */
function findFixed(list: readonly FixedExpense[], name: string): FixedExpense[] {
  const query = fold(name);
  if (!query) return [];
  const folded = list.map((f) => ({ f, n: fold(f.name) }));
  const tiers: ((n: string) => boolean)[] = [(n) => n === query, (n) => n.startsWith(query), (n) => n.includes(query)];
  for (const matches of tiers) {
    const hits = folded.filter((x) => matches(x.n)).map((x) => x.f);
    if (hits.length > 0) return hits;
  }
  return [];
}

/**
 * The income of `accountId` that `named` points to: an exact id, otherwise a description (exact, then prefix, then
 * contained). Several matches prefer the ones dated in `key`; still several is ambiguous.
 */
function findBudgetIncome(state: AppState, named: string, accountId: string, key: MonthKey, userName: string): Income {
  const byId = state.incomes.find((i) => i.id === named);
  if (byId) {
    if (byId.accountId !== accountId) throw validationError('That income is in a different account than the extra budget: pass the account of the income.');
    return byId;
  }
  const same = state.incomes.filter((i) => i.accountId === accountId);
  const query = fold(named);
  const folded = same.map((i) => ({ i, n: fold(i.desc) }));
  const tiers: ((n: string) => boolean)[] = [(n) => n === query, (n) => n.startsWith(query), (n) => n.includes(query)];
  for (const matches of tiers) {
    let hits = folded.filter((x) => query !== '' && matches(x.n)).map((x) => x.i);
    if (hits.length > 1) {
      const inMonth = hits.filter((i) => monthOf(i.date) === key);
      if (inMonth.length > 0) hits = inMonth;
    }
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      throw validationError(
        `"${quoted(named)}" matches several incomes of ${userName} in that account: ${hits.map((i) => `${i.desc || '(no description)'} (${i.date}, id ${i.id})`).join('; ')}. Repeat the call with the id.`,
      );
    }
  }
  const options = same.map((i) => `${i.desc || '(no description)'} (${i.date})`).join('; ');
  throw validationError(`No income of ${userName} in that account matches "${quoted(named)}".${options ? ` Incomes in it: ${options}.` : ' It has no incomes.'}`);
}

// ── Arguments ────────────────────────────────────────────────────────────────
// A single zod schema per tool: it validates the arguments and the inputSchema the model sees comes from it.
// The exception is `user`, which depends on the configuration and not on the code: it is resolved separately
// (resolveUser) and its property is added to the inputSchema on each request (userProperty).
// Category and method are limited here to the lists of the interface (in the API they are free text): a value outside
// the list could not be picked later in the application's selects. The via of a transfer is free text, though.
// An account is given by its name (or its id) and looked up among the user's (server/ingest.ts matchAccount).

type IssueLike = { input?: unknown };

/** Type message: tells "missing" apart from "came with another type". */
const typed = (message: string) => (issue: IssueLike) => (issue.input === undefined ? 'is required' : message);

const text = (max: number) => z.string({ error: typed('must be text') }).trim().max(max, { error: `allows up to ${max} characters` });
const requiredText = (max: number) => text(max).min(1, { error: 'cannot be empty' });
const positive = () =>
  z.number({ error: typed('must be a number') }).gt(0, { error: 'must be greater than 0' }).max(MAX_AMOUNT, { error: 'is too large' });
const nonNegative = () =>
  z.number({ error: typed('must be a number') }).min(0, { error: 'cannot be negative' }).max(MAX_AMOUNT, { error: 'is too large' });
const oneOf = <const T extends readonly [string, ...string[]]>(values: T) => z.enum(values, { error: `must be one of: ${values.join(', ')}` });

/**
 * A value from a fixed list (category, method), optional and defaulting to the first of the list. The person may
 * say it in Spanish or in Turkish and Claude passes what it hears: before validating, it is mapped to its canonical name.
 * The schema the model sees lists only the canonical ones.
 */
const listed = <const T extends readonly [string, ...string[]]>(values: T, canonical: (name: string) => string, description: string) =>
  z.preprocess((v) => (typeof v === 'string' ? canonical(v) : v), oneOf(values).optional().meta({ description, default: values[0] }));

/** No default value in the schema: the currency that applies is the account's, which the schema does not know. */
const currency = (description: string) => z.enum(CURRENCY_CODES, { error: 'must be DOP, USD or TRY' }).optional().describe(description);

const accountName = (description: string) => text(MAX_LEN.name).optional().describe(description);

// The patterns are the hint for the model; the one that decides is shared/month.ts (which also rejects a February 30).
const NOT_A_DATE = 'is not a valid date (YYYY-MM-DD)';
const NOT_A_MONTH = 'is not a valid month (YYYY-MM)';
const isoDate = () =>
  z
    .string({ error: typed('must be a date (YYYY-MM-DD)') })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error: NOT_A_DATE, abort: true })
    .refine(isISODate, { error: NOT_A_DATE });
const monthKey = () =>
  z
    .string({ error: typed('must be a month (YYYY-MM)') })
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: NOT_A_MONTH, abort: true })
    .refine(isMonthKey, { error: NOT_A_MONTH });

const DEFAULT_LIST = 20;
const MAX_LIST = 200;

const CARD_HINT = 'by name or id, as the person calls it (part of the name is enough if it identifies only one; see list_credit_cards)';
const ACCOUNT_HINT = 'by name or id, as the person calls it (part of the name is enough if it identifies only one; see list_accounts)';

const addTransactionArgs = z.strictObject({
  description: requiredText(MAX_LEN.desc).describe('What the expense was, in a few words and as the person said it: "Uber", "Lunch", "Weekly groceries".'),
  amount: positive().describe('Amount as the person said it, in the currency of `currency` and without converting. Greater than 0.'),
  currency: currency(
    'Currency the person said: DOP (Dominican pesos), USD (dollars) or TRY (Turkish lira). Omit it if they named none: the currency of the account is used.',
  ),
  account: accountName(`Account the expense is paid from, ${ACCOUNT_HINT}. Omit it unless the person names one: their default account is used.`),
  date: isoDate()
    .optional()
    .describe(`Date of the expense, YYYY-MM-DD. Omit it if the person gave no date or said "today": today in ${TIMEZONE} is used.`),
  place: text(MAX_LEN.place).optional().describe('Shop or place of the expense, if the person said it: "Supermercado Nacional", "Texaco".'),
  category: listed(CATS, canonicalCat, 'Category that best describes the expense.'),
  method: listed(METHODS, canonicalMethod, 'Payment method.'),
  card: accountName(`Only with method "Credit card": which credit card, ${CARD_HINT}. Omit it unless the person names one: their first active card is used.`),
  notes: text(MAX_LEN.notes).optional().describe('Free note, if the person added some detail.'),
});

const addOutsideExpenseArgs = z.strictObject({
  name: requiredText(MAX_LEN.desc).describe('What the expense was, in a few words and as the person said it: "Car repair", "Wedding gift".'),
  amount: positive().describe('Amount as the person said it, in the currency of `currency` and without converting. Greater than 0.'),
  currency: currency(
    'Currency the person said: DOP (Dominican pesos), USD (dollars) or TRY (Turkish lira). Omit it if they named none: the currency of the account is used.',
  ),
  account: accountName(`Account the expense is paid from, ${ACCOUNT_HINT}. Omit it unless the person names one: their default account is used.`),
  date: isoDate()
    .optional()
    .describe(`Date of the expense, YYYY-MM-DD. Omit it if the person gave no date or said "today": today in ${TIMEZONE} is used.`),
  description: text(MAX_LEN.notes).optional().describe('Free detail about the expense, if the person added some.'),
});

const listTransactionsArgs = z.strictObject({
  month: monthKey().optional().describe('Month to list, YYYY-MM. By default, the month in progress.'),
  limit: z
    .number({ error: 'must be a number' })
    .int({ error: 'must be an integer' })
    .min(1, { error: 'must be at least 1' })
    .max(MAX_LIST, { error: `allows up to ${MAX_LIST}` })
    .default(DEFAULT_LIST)
    .describe('Maximum number of transactions to return, starting with the most recent.'),
});

const monthSummaryArgs = z.strictObject({
  month: monthKey().optional().describe('Month to summarize, YYYY-MM. By default, the month in progress.'),
});

const addTransferArgs = z.strictObject({
  from_account: requiredText(MAX_LEN.name).describe(`Account the money leaves, ${ACCOUNT_HINT}.`),
  to_account: requiredText(MAX_LEN.name).describe(`Account the money arrives in, ${ACCOUNT_HINT}. It must be a different account.`),
  amount: positive().describe('Amount that leaves, in the currency of the origin account. Greater than 0.'),
  rate: positive()
    .optional()
    .describe(
      "What arrives per unit sent: 1 unit of the origin currency = `rate` units of the destination currency, for example 58.76 from USD to DOP. If the person gives the amount that arrived, it is arrived ÷ sent. Omit it if they give neither: the rate in effect on that date for the two currencies is used. Between accounts of the same currency, omit it.",
    ),
  via: requiredText(MAX_LEN.label)
    .default(VIAS[0])
    .describe(`Service the transfer was made through, as free text: ${VIAS.join(', ')} or any other name.`),
  date: isoDate()
    .optional()
    .describe(`Date of the transfer, YYYY-MM-DD. Omit it if the person gave no date or said "today": today in ${TIMEZONE} is used.`),
  fee: nonNegative()
    .optional()
    .describe(
      'Fee the service charged on top of the amount, in the currency of the origin account (for example 2.99 when Remitly charges 2.99 USD from the US account). It is not part of `amount` and is never converted. Omit it if the person mentions no fee.',
    ),
  move_budget: z
    .boolean({ error: 'must be true or false' })
    .optional()
    .describe(
      "true only if the person says the money sent should also move in the budget of the month (for example \"move it in this month's budget\" or \"I sent it to spend it this month\"): the budget part of the origin account goes down by the amount sent and the part of the destination account goes up by the amount that arrived. By default false: the money moves between the accounts and the budget stays as it is.",
    ),
  add_to_budget: z
    .boolean({ error: 'must be true or false' })
    .optional()
    .describe('Former name of `move_budget`, still accepted with the same meaning. Prefer `move_budget`; if both are given, `move_budget` wins.'),
});

const addIncomeArgs = z.strictObject({
  amount: positive().describe('Amount received as the person said it, in the currency of `currency` and without converting. Greater than 0.'),
  currency: currency(
    'Currency the person said: DOP (Dominican pesos), USD (dollars) or TRY (Turkish lira). Omit it if they named none: the currency of the account is used. Always omit it for a gold account: there the amount is grams.',
  ),
  account: accountName(`Account the money enters, ${ACCOUNT_HINT}. Omit it unless the person names one: their default account is used.`),
  date: isoDate()
    .optional()
    .describe(`Date the money was received, YYYY-MM-DD. Omit it if the person gave no date or said "today": today in ${TIMEZONE} is used.`),
  description: text(MAX_LEN.desc).optional().describe('What the income was, in a few words and as the person said it: "Salary", "Freelance", "Gift".'),
  add_to_budget: z
    .boolean({ error: 'must be true or false' })
    .default(false)
    .describe(
      "true only if the person says this money should also raise the budget of the month of its date (for example \"add it to this month's budget\"). By default false: the income enters the account and the budget stays as it is. Not allowed for a gold account.",
    ),
  rate: positive().optional().describe("Only if the person says at what rate this money was exchanged: amount of their main currency per 1 unit of `currency` (for example 61.2 for USD when the main currency is DOP). Omit it to use the rate of the month. Ignored when the currency is the main currency."),
  recurring: z
    .boolean({ error: 'must be true or false' })
    .optional()
    .describe('true only if the person says this income repeats every month (a salary): a copy is then created when each new month starts. Omit it otherwise.'),
});

const addBudgetExtraArgs = z.strictObject({
  amount: positive().describe('Extra money to add to the budget of the month, in the currency of the account. Greater than 0.'),
  account: accountName(`Account the extra budget comes out of, ${ACCOUNT_HINT}. Omit it unless the person names one: their default account is used.`),
  note: text(MAX_LEN.desc).optional().describe('Why it was added, in a few words and as the person said it: "Medical expense", "Car repair".'),
  date: isoDate()
    .optional()
    .describe(`Date it was added, YYYY-MM-DD. Omit it if the person gave no date or said "today": today in ${TIMEZONE} is used. It decides the month.`),
  income: text(MAX_LEN.desc)
    .optional()
    .describe('Only if the person says which income the extra budget is taken from ("from the Apply income"): its description or id. It must be an income into the same account. Omit it otherwise.'),
});

const listAccountsArgs = z.strictObject({});

const markFixedPaidArgs = z.strictObject({
  name: requiredText(MAX_LEN.name).describe(
    'Name of the fixed expense, as the person calls it: "Internet", "Netflix", "Luz". Part of the name is enough if it identifies only one.',
  ),
  month: monthKey().optional().describe('Month of the fixed expense, YYYY-MM. By default, the month in progress.'),
  paid: z
    .boolean({ error: 'must be true or false' })
    .default(true)
    .describe('true to mark it as paid; false to leave it as not paid.'),
  on_card: z
    .boolean({ error: 'must be true or false' })
    .optional()
    .describe(
      'true if the person pays this expense with the credit card: marking it as paid then charges it to the card instead of subtracting it from an account. false to make it a normal expense again. Omit it to leave it as it is.',
    ),
});

const payCreditCardArgs = z.strictObject({
  amount: positive().describe("How much of the credit card bill was paid, in the currency of that card (see list_credit_cards). At most what is still left to pay this month; it can be less (a partial payment)."),
  account: accountName(`Account the payment came out of, ${ACCOUNT_HINT}. Omit it unless the person names one: the account of the previous card payment or their default account is used.`),
  card: accountName(`Which credit card was paid, ${CARD_HINT}. Omit it if the person has only one active card, or does not say: the first active card is used.`),
  month: monthKey().optional().describe('Month of the credit card bill, YYYY-MM. By default, the month in progress.'),
});

const listCreditCardsArgs = z.strictObject({});

// ── Tools ────────────────────────────────────────────────────────────────────

interface ToolOutput {
  /** Short confirmation, in English: it is what the model reads. It says whose finances they are. */
  text: string;
  /** The raw data (structuredContent); callTool adds the user to it. */
  data: Record<string, unknown>;
}

interface ToolSpec<T> {
  name: string;
  title: string;
  /** For the model: when to use it and what happens if arguments are omitted. */
  description: string;
  /** The tool's own arguments, without `user`. */
  schema: z.ZodType<T>;
  readOnly: boolean;
  /** Repeating the call with the same arguments changes nothing else. */
  idempotent: boolean;
  run(args: T, ctx: ToolContext): Promise<ToolOutput>;
}

interface Tool {
  name: string;
  /** What is published in tools/list, with `user` according to the configured users. */
  definition(users: readonly AppUser[]): Record<string, unknown>;
  /** Validates the arguments (already without `user`) and runs. Throws ApiError if they are invalid or the domain forbids it. */
  call(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

/** A model often sends null or '' for what it does not know: it counts as "not sent" and the default value applies. */
function dropBlank(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && !(typeof v === 'string' && v.trim() === '')));
}

function defineTool<T>(spec: ToolSpec<T>): Tool {
  // Only keywords common to draft-07 and 2020-12 are used; without `$schema`, each client applies the dialect it understands.
  const { properties = {}, required = [], additionalProperties } = z.toJSONSchema(spec.schema, { io: 'input' });
  return {
    name: spec.name,
    definition: (users) => {
      // `user` goes first, because it is the first thing to know, and is required only if there is someone to choose from.
      const mandatory = users.length > 1 ? ['user', ...required] : required;
      return {
        name: spec.name,
        title: spec.title,
        description: spec.description,
        inputSchema: {
          type: 'object',
          properties: { user: userProperty(users), ...properties },
          ...(mandatory.length > 0 ? { required: mandatory } : {}),
          additionalProperties,
        },
        annotations: {
          title: spec.title,
          readOnlyHint: spec.readOnly,
          // No tool deletes or overwrites user data.
          destructiveHint: false,
          idempotentHint: spec.idempotent,
          // They only touch this application's database.
          openWorldHint: false,
        },
      };
    },
    call: async (args, ctx) => spec.run(parse(spec.schema, dropBlank(args)), ctx),
  };
}

const addTransaction = defineTool({
  name: 'add_transaction',
  title: 'Record transaction',
  description: [
    'Records an expense (a transaction) in the finances of `user`, in the month of its date, and subtracts it from the account it is paid from. Use it when the person says they spent, paid or bought something, for example "I spent 850 on Uber today with my card".',
    `Apart from \`user\`, only \`description\` and \`amount\` are required. Defaults: the person's default account, the currency of that account, today's date in ${TIMEZONE}, category ${CATS[0]} and method ${METHODS[0]}; even so, always choose the category that best describes the expense.`,
    'Pass `account` only if the person names the account it was paid from, and `currency` only if they name a currency: the amount is recorded in the currency they said, without converting, even if the account is in another one (the account is charged the equivalent at the rate in effect on that date).',
    'Category and method are stored under their English names; a Spanish or Turkish name is also accepted. Description, place and notes are kept exactly as given.',
    'The answer says which account it was paid from and the new balance of that account. If the month of the date does not exist, it is created (only near today: a date in another year is rejected); if it is closed, the call fails.',
    "Each call creates a new transaction: do not repeat it for the same expense. Do not use it for the month's fixed expenses (use mark_fixed_paid), for money moved between accounts (use add_transfer) or for money received (use add_income).",
  ].join(' '),
  schema: addTransactionArgs,
  readOnly: false,
  idempotent: false,
  async run(args, ctx) {
    const { db, now, user } = ctx;
    if (args.date) await assertReachable(ctx, args.date);
    // The user is already resolved: ingestTransaction only has to find them. The rules for the default account and
    // currency are its own (the same as those of POST /api/ingest/transaction).
    const { transaction: t, monthCreated } = await ingestTransaction(db, [user], { ...args, user: user.id }, now);
    const after = await afterWrite(ctx, (state) => ({
      state,
      calc: monthCalc(state, t.monthKey),
      paidFrom: balanceOf(balancesNow(state, now, t.monthKey).all, t.accountId),
    }));
    // A credit card purchase does not come out of any account: it stays charged to the credit card until it is paid.
    const onCard = isCardTx(t);
    const paidFrom = onCard ? null : (after?.paidFrom ?? null);

    const parts = [
      t.desc,
      t.place,
      after ? moneyIn(after.state, t.monthKey, t.amount, t.cur, after.calc.main, t.date) : money(t.amount, t.cur),
      t.cat,
      t.method,
      `${t.date} (${label(t.monthKey)})`,
      onCard ? `charged to the credit card${after && after.state.cards.length > 1 ? ` ${after.state.cards.find((x) => x.id === t.cardId)?.name ?? ''}`.trimEnd() : ''}` : after && paidFrom && `paid from ${accountPart(after.state, t.monthKey, paidFrom.account, t.amount, t.cur, t.date)}`,
    ];
    const sentences = [`Recorded for ${user.name}: ${parts.filter(Boolean).join(SEP)}.`];
    if (onCard) sentences.push('No account or budget is charged until the credit card is paid (pay_credit_card).');
    if (monthCreated) sentences.push(`The month ${label(t.monthKey)} was created.`);
    if (after) sentences.push(usedLine(after.calc));
    if (paidFrom) sentences.push(balanceSentence(paidFrom));
    if (after) sentences.push(...approxNotes(after.state, t.monthKey, t.cur, [after.calc.main, ...moneyCurrencies(paidFrom ? [paidFrom.account.currency] : [])], t.date));
    return {
      text: sentences.join(' '),
      data: {
        transaction: t,
        monthCreated,
        account: paidFrom ? accountData(paidFrom.account, paidFrom) : null,
        month: after ? monthStatus(after.calc) : null,
      },
    };
  },
});

const addOutsideExpense = defineTool({
  name: 'add_outside_expense',
  title: 'Record outside-budget expense',
  description: [
    'Records an expense that is OUTSIDE the budget in the finances of `user`: it is subtracted from the account it is paid from, exactly like a transaction, but it does not count in "used", "available", the categories or the transaction count of the month. Use it only when the person says the expense is outside their budget (for example "that was outside the budget", "do not count it in my budget"); otherwise use add_transaction.',
    `Apart from \`user\`, only \`name\` and \`amount\` are required. Defaults: the person's default account, the currency of that account and today's date in ${TIMEZONE}. Pass \`account\` only if the person names the account, and \`currency\` only if they name a currency: the amount is recorded in the currency they said and the account is charged the equivalent at the rate in effect on that date.`,
    'It has no category or payment method. If the month of the date does not exist it is created (only near today); if it is closed, the call fails. Each call creates a new expense: do not repeat it for the same one.',
  ].join(' '),
  schema: addOutsideExpenseArgs,
  readOnly: false,
  idempotent: false,
  async run({ name, amount, currency: cur, account: named, date: givenDate, description }, ctx) {
    const { db, now, user } = ctx;
    if (givenDate) await assertReachable(ctx, givenDate);
    const date = givenDate ?? todayISO(now);
    const key = monthOf(date);
    const account = await resolveAccount(ctx, named);
    if (!isMoneyAccount(account)) throw goldAccountError(account.name);
    const { month, created } = await ensureMonth(db, user.id, key);
    if (month.closed) throw monthClosedError(key);

    const expense = await createOutside(db, user.id, { monthKey: key, date, name, desc: description ?? '', accountId: account.id, amount, cur: cur ?? account.currency });
    const after = await afterWrite(ctx, (state) => ({
      state,
      calc: monthCalc(state, key),
      outside: outsideSummary(state, key),
      balance: balanceOf(balancesNow(state, now, key).all, account.id),
    }));
    const parts = [
      expense.name,
      expense.desc,
      after ? moneyIn(after.state, key, expense.amount, expense.cur, after.calc.main, expense.date) : money(expense.amount, expense.cur),
      `${expense.date} (${label(key)})`,
      `paid from ${accountPart(after?.state ?? null, key, account, expense.amount, expense.cur, expense.date)}`,
    ];
    const sentences = [`Recorded outside the budget for ${user.name}: ${parts.filter(Boolean).join(SEP)}.`];
    if (created) sentences.push(`The month ${label(key)} was created.`);
    if (after) sentences.push(`Used so far is unchanged by it: ${money(after.calc.used, after.calc.main)}.`);
    if (after?.balance) sentences.push(balanceSentence(after.balance));
    if (after) sentences.push(`Outside budget in ${label(key)}: ${after.outside.count} (${money(after.outside.total, after.calc.main)}).`);
    return {
      text: sentences.join(' '),
      data: {
        outsideExpense: expense,
        monthCreated: created,
        account: accountData(account, after?.balance ?? null),
        month: after ? { ...monthStatus(after.calc), outsideBudget: after.outside } : null,
      },
    };
  },
});

const listTransactions = defineTool({
  name: 'list_transactions',
  title: 'List transactions',
  description: [
    "Lists the transactions of one month in the finances of `user`, from the most recent to the oldest, with the original amount, its equivalent in the person's main currency and the account each one was paid from.",
    'Use it to review what has been recorded, to look for an expense, or to check whether something is already recorded before recording it again.',
    `Defaults: ${IN_PROGRESS} and the ${DEFAULT_LIST} most recent. It does not include the fixed expenses (they are in month_summary), the incomes or the transfers.`,
  ].join(' '),
  schema: listTransactionsArgs,
  readOnly: true,
  idempotent: true,
  async run({ month, limit }, ctx) {
    const { db, now, user } = ctx;
    const state = await loadState(db, user.id);
    const m = resolveMonth(state, month, ctx);
    const main = state.mainCurrency;
    const accounts = accountsById(state);

    // Most recent first; on the same date, the last one recorded.
    const sorted = m.tx
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (a.t.date < b.t.date ? 1 : a.t.date > b.t.date ? -1 : b.i - a.i))
      .map(({ t }) => ({ ...t, inMain: convert(state, m.key, t.amount, t.cur, main, t.date), account: accounts.get(t.accountId)?.name ?? null }));
    const shown = sorted.slice(0, limit);
    const total = sorted.reduce((a, t) => a + t.inMain, 0);

    const lines =
      sorted.length === 0
        ? [`${heading(user, m)}: no transactions recorded.`]
        : [
            `${heading(user, m)}: ${sorted.length} ${sorted.length === 1 ? 'transaction' : 'transactions'}${SEP}${money(total, main)} in total.` +
              (shown.length === sorted.length ? '' : shown.length === 1 ? ' Showing the most recent one.' : ` Showing the ${shown.length} most recent.`),
            ...shown.map((t) =>
              [t.date, t.desc, t.place, moneyIn(state, m.key, t.amount, t.cur, main, t.date), t.cat, t.method, t.account, t.notes && `Notes: ${t.notes}`]
                .filter(Boolean)
                .join(SEP),
            ),
          ];
    return {
      text: lines.join('\n'),
      data: {
        month: m.key,
        label: label(m.key),
        closed: m.closed,
        today: todayISO(now),
        currency: main,
        count: sorted.length,
        total,
        shown: shown.length,
        transactions: shown,
      },
    };
  },
});

/** How each row of the budget history is named. */
const HISTORY_KIND = { initial: 'initial', adjust: 'adjustment', leftover: 'leftover', income: 'income', transfer: 'transfer' } as const;

/** A credit card's hint, only in the last recorded month (in an earlier one it makes no sense) and if it has a limit and a cutoff. */
function hintOf(state: AppState, key: MonthKey, k: CardCalc, today: ISODate) {
  return key === sortedKeys(state).at(-1) ? cardHint(k.card, k.remainder, today) : null;
}

function hintText(name: string, cur: Currency, h: NonNullable<ReturnType<typeof cardHint>>): string {
  const parts = [
    h.payToUnder10 > 0
      ? `to end the cutoff under 10% pay at least ${money(h.payToUnder10, cur)} before ${h.nextCutoff} (in ${h.daysToCutoff} days)`
      : `under 10% of the limit; next cutoff ${h.nextCutoff} (in ${h.daysToCutoff} days)`,
  ];
  if (h.upcomingDue) parts.push(`payment due ${h.upcomingDue.date} (in ${h.upcomingDue.days} days)`);
  return `${name}: ${parts.join(SEP)}`;
}

/** The month budget as a sentence: initial, what was added and when, total, spent, remaining (main currency). */
function summaryText(b: BudgetSummary): string {
  const { main } = b;
  const parts = [`initial ${money(b.initial, main)}`];
  if (b.leftover !== 0) parts.push(`leftover from the previous month ${signed(b.leftover, main)}`);
  if (b.incomes !== 0) parts.push(`incomes added to the budget ${signed(b.incomes, main)}`);
  if (b.transfers !== 0) parts.push(`moved by transfers ${signed(b.transfers, main)}`);
  for (const l of b.additions) {
    parts.push(`added on ${l.date}${l.incomeName ? ` from income "${l.incomeName}"` : ''}${l.note ? ` (${l.note})` : ''} to ${l.accountName} ${signed(l.amount, l.currency)}`);
  }
  for (const l of b.reductions) {
    parts.push(`reduced on ${l.date}${l.note ? ` (${l.note})` : ''} in ${l.accountName} ${signed(l.amount, l.currency)}`);
  }
  parts.push(`total budget ${money(b.total, main)}`, `spent ${money(b.spent, main)}`);
  parts.push(b.remaining < 0 ? `over budget by ${money(-b.remaining, main)}` : `remaining ${money(b.remaining, main)}`);
  return parts.join(SEP);
}

function summaryData(b: BudgetSummary) {
  const line = (l: BudgetSummary['additions'][number]) => ({
    id: l.id,
    date: l.date,
    accountId: l.accountId,
    account: l.accountName,
    amount: l.amount,
    currency: l.currency,
    inMain: l.inMain,
    note: l.note,
    incomeId: l.incomeId,
    income: l.incomeName,
  });
  return {
    currency: b.main,
    initial: b.initial,
    initialLines: b.initialLines.map(line),
    leftover: b.leftover,
    incomes: b.incomes,
    transfers: b.transfers,
    additions: b.additions.map(line),
    added: b.added,
    additionDates: b.additionDates,
    reductions: b.reductions.map(line),
    reduced: b.reduced,
    total: b.total,
    spent: b.spent,
    remaining: b.remaining,
    ...(b.second !== null && {
      secondCurrency: b.second,
      initialSecond: b.initialSecond,
      addedSecond: b.addedSecond,
      totalSecond: b.totalSecond,
      spentSecond: b.spentSecond,
      remainingSecond: b.remainingSecond,
    }),
  };
}

const monthSummary = defineTool({
  name: 'month_summary',
  title: 'Month summary',
  description: [
    "Summary of one month in the finances of `user`, with every amount in the person's main currency: budget and the part of it that comes out of each account, how the budget got there (its history: the initial amount, later adjustments, the leftover of the previous month, the incomes added to it and the transfers that moved it from one account to another, each with its date), used, available, fixed expenses paid and pending (with the names of the ones still to pay), spending by category (transfer fees count as transactions, under Other), the outside-budget expenses (subtracted from the account balances but not part of used or available), the month's income and income minus used, the balance of each account and the month's rates.",
    'Use it when the person asks how the month is going, how much is left, what is still to be paid, how much they have or why the budget changed.',
    'If the previous month ended with money left over (or overspent) and it has not been added to this month\'s budget, a "Leftover" line says how much; adding it is done in the app.',
    'The "Budget summary" line tells the budget as a story: the initial budget, each amount added later with its date and note (see add_budget_extra), the total, what was spent and what remains (or by how much it is over budget).',
    'Rates carry the date they apply from: an amount is converted with the rate in effect on its own date, so a rate typed later does not change earlier records. The "Month rates" line gives the latest rate of the month and where it came from; "default value, not set yet" means the converted amounts are only approximate.',
    `It also says what today's date is for the users. By default: ${IN_PROGRESS}.`,
  ].join(' '),
  schema: monthSummaryArgs,
  readOnly: true,
  idempotent: true,
  async run({ month }, ctx) {
    const { db, now, user } = ctx;
    const state = await loadState(db, user.id);
    const m = resolveMonth(state, month, ctx);
    const c = monthCalc(state, m.key);
    const { main, second } = c;
    const today = todayISO(now);
    // Without a second currency there is no figure in parentheses and no *Second fields in `data`.
    const both = (amount: number, inSecond: number | null) =>
      second && inSecond !== null ? `${money(amount, main)} (${money(inSecond, second)})` : money(amount, main);

    const pending = m.fixed
      .filter((f) => !f.paid)
      .map((f) => ({ name: f.name, day: f.day, amount: f.amount, cur: f.cur, inMain: convert(state, m.key, f.amount, f.cur, main) }));
    // Parts with no amount say nothing: the budget of an account that contributes nothing is zero.
    const parts = c.budgetParts.filter((p) => p.amount !== 0);
    // Balances at the end of the month being summarized: for the current month they are the ones as of now.
    const all = balances(state, m.key);
    const visible = all.accounts.filter((b) => !b.account.hidden);
    // The month's incomes are the money ones: grams entering a gold account do not count (incomeInMonth).
    const incomes = state.incomes.filter(isMoneyIncome).filter((i) => monthOf(i.date) === m.key);
    // The transfer fees: they are already inside c.txCount and c.varSpent, each as one more transaction.
    const fees = transferFees(state, m.key);
    const outside = outsideSummary(state, m.key);
    const rates = ratesToMain(state, m.key, [
      ...(second ? [second] : []),
      ...moneyCurrencies(visible.map((b) => b.account.currency)),
      ...parts.map((p) => p.account.currency),
      ...m.fixed.map((f) => f.cur),
      ...m.tx.map((t) => t.cur),
      ...outsideOf(m).map((o) => o.cur),
      ...fees.map((f) => f.cur),
      ...incomes.map((i) => i.cur),
    ]);

    const history = budgetHistory(state, m.key);
    const left = leftoverFor(state, m.key);
    // The rates typed with a date in the month: each one applies from its date until the next one of the pair.
    const typed = m.rates.filter((r) => r.rate > 0);

    const lines = [
      `${heading(user, m)}${SEP}amounts in ${main}`,
      c.budget === 0 && parts.length === 0
        ? `Budget: ${money(0, main)} (no budget set)`
        : `Budget: ${both(c.budget, c.budgetSecond)}${SEP}by account: ${parts.map((p) => `${p.account.name} ${moneyIn(state, m.key, p.amount, p.account.currency, main)}`).join('; ')}`,
    ];
    if (history.length > 0) {
      lines.push(
        `Budget history: ${history
          .map((h) => `${h.date} ${HISTORY_KIND[h.kind]} ${h.account.name} ${signed(h.amount, h.account.currency)}${h.note ? ` (${h.note})` : ''}`)
          .join('; ')}`,
      );
    }
    const story = budgetSummary(state, m.key);
    if (history.length > 0) lines.push(`Budget summary: ${summaryText(story)}`);
    if (left.previousKey !== null && left.leftover !== null && !left.added) {
      lines.push(`Leftover of ${label(left.previousKey)}: ${money(left.leftover, main)}, not added to this month's budget.`);
    }
    lines.push(
      `Used so far: ${both(c.used, c.usedSecond)}`,
      `Available: ${money(c.avail, main)}`,
      `Available after pending fixed: ${money(c.after, main)}`,
      `Monthly expenses: ${c.paidCount} of ${c.fixedCount} paid${SEP}Fixed paid: ${money(c.fixedPaid, main)}${SEP}Fixed pending: ${money(c.pending, main)}`,
    );
    // Only the active credit cards that have something this month (or that owed something).
    const cards = c.cards.filter((k) => k.total !== 0 || k.payments.length > 0);
    for (const k of cards) {
      const cur = k.cur;
      lines.push(
        `Credit card "${k.card.name}": total ${money(k.total, cur)} (previous ${money(k.previous, cur)}${SEP}other charges ${money(k.other, cur)}${SEP}charged this month ${money(k.charged, cur)})${SEP}` +
          (k.payments.length === 0
            ? 'not paid yet'
            : `paid ${money(k.paid, cur)} in ${k.payments.length} payment${k.payments.length === 1 ? '' : 's'} (${k.payments.map((p) => `${p.date} ${money(p.amount, cur)} from ${accountsById(state).get(p.accountId)?.name ?? p.accountId}`).join('; ')})`) +
          `${SEP}left to pay ${money(k.remainder, cur)} (it carries to the next month if this one closes with it unpaid). Charges on the card are not in Used or in the account balances until it is paid.`,
      );
      const h = hintOf(state, m.key, k, today);
      if (h) lines.push(`${k.card.name} limit ${money(k.card.limit!, cur)}${SEP}${(h.utilization * 100).toFixed(1)}% used${SEP}${hintText(k.card.name, cur, h)}`);
    }
    if (pending.length > 0) {
      lines.push(`Still to pay: ${pending.map((f) => `${f.name} ${moneyIn(state, m.key, f.amount, f.cur, main)}${f.day ? `, day ${f.day}` : ''}`).join('; ')}`);
    }
    lines.push(
      `Transactions: ${c.txCount} (${money(c.varSpent, main)})` +
        (fees.length > 0
          ? `${SEP}of them, transfer fees (category ${FEE_CATEGORY}): ${fees.map((f) => `${f.via} ${f.date} ${money(f.amount, f.cur)} from ${f.account.name}`).join('; ')}`
          : ''),
      c.categories.length > 0
        ? `By category: ${c.categories.map((cat) => `${cat.name} ${money(cat.value, main)}`).join(SEP)}`
        : 'By category: No expenses yet this month.',
      ...(outside.count > 0
        ? [
            `Outside budget: ${outside.count} (${money(outside.total, main)})${SEP}not part of used or available, but already subtracted from the account balances: ${outsideOf(m)
              .map((o) => `${o.name} ${moneyIn(state, m.key, o.amount, o.cur, main, o.date)}`)
              .join('; ')}`,
          ]
        : []),
      `Month income: ${money(c.income, main)}${SEP}Income − used: ${money(c.incomeLeft, main)}`,
      visible.length > 0
        ? `Account balances at the end of ${label(m.key)}: ${visible.map((b) => `${b.account.name} ${balanceText(state, m.key, b, main)}`).join('; ')}${SEP}Total money: ${both(all.totalMain, all.totalSecond)}`
        : `Account balances at the end of ${label(m.key)}: no visible accounts.`,
      ...goldLines(state, all),
      `Month rates: ${rates.map(rateText).join('; ')}`,
    );
    if (typed.length > 0) {
      lines.push(`Rates typed in ${label(m.key)}: ${typed.map((r) => `${pairText(r.from, r.to, r.rate)} from ${r.date}`).join('; ')}`);
    }
    lines.push(`Today is ${today}.`);
    return {
      text: lines.join('\n'),
      data: {
        month: m.key,
        label: label(m.key),
        closed: m.closed,
        today,
        currency: main,
        secondCurrency: second,
        budget: c.budget,
        ...(c.budgetSecond !== null && { budgetSecond: c.budgetSecond }),
        budgetParts: parts.map((p) => ({
          accountId: p.account.id,
          name: p.account.name,
          currency: p.account.currency,
          amount: p.amount,
          fromLog: p.fromLog,
          fromIncomes: p.fromIncomes,
          fromTransfers: p.fromTransfers,
          inMain: p.inMain,
        })),
        budgetHistory: history.map((h) => ({
          kind: h.kind,
          id: h.id,
          // Only on a transfer: 'out' is what it subtracts from the origin account, 'in' what it adds to the destination.
          ...(h.side && { side: h.side }),
          date: h.date,
          accountId: h.account.id,
          account: h.account.name,
          amount: h.amount,
          currency: h.account.currency,
          note: h.note,
          inMain: h.inMain,
          total: h.total,
        })),
        budgetSummary: summaryData(story),
        leftover: { previousMonth: left.previousKey, amount: left.leftover, added: left.added },
        used: c.used,
        ...(c.usedSecond !== null && { usedSecond: c.usedSecond }),
        available: c.avail,
        availableAfterPending: c.after,
        fixed: { count: c.fixedCount, paidCount: c.paidCount, paid: c.fixedPaid, pending: c.pending, pendingItems: pending },
        transactions: { count: c.txCount, total: c.varSpent },
        // Deferred payment: `total` = previous + other + charged; `paid` = sum of `payments`; `remainder` = what is left to
        // pay (if the month closes like that, it carries to the next one). In the main currency.
        creditCards: c.cards.map((k) => ({
          id: k.card.id,
          name: k.card.name,
          currency: k.cur,
          total: k.total,
          previous: k.previous,
          other: k.other,
          charged: k.charged,
          paid: k.paid,
          payments: k.payments.map((p) => ({ id: p.id, date: p.date, accountId: p.accountId, amount: p.amount })),
          remainder: k.remainder,
          limit: k.card.limit,
          utilization: k.card.limit ? Math.max(0, k.remainder) / k.card.limit : null,
          hint: hintOf(state, m.key, k, today),
        })),
        // Separate from `transactions`, `used` and `available`: it subtracts from the account balances, nothing more.
        outsideBudget: { ...outsideSummary(state, m.key), expenses: outsideOf(m) },
        // Already counted in `transactions` and `categories` (Other): not transaction rows; they come from the transfers.
        transferFees: fees.map((f) => ({
          transferId: f.transferId,
          date: f.date,
          via: f.via,
          accountId: f.account.id,
          account: f.account.name,
          amount: f.amount,
          currency: f.cur,
          category: FEE_CATEGORY,
          inMain: convert(state, m.key, f.amount, f.cur, main, f.date),
        })),
        categories: c.categories.map((cat) => ({ name: cat.name, value: cat.value })),
        income: { count: incomes.length, total: c.income, left: c.incomeLeft },
        // For a gold account, `balance` is grams; `inMain` is null if there is no gold price.
        accounts: visible.map((b) => ({ ...accountData(b.account, b), inMain: b.valued ? b.inMain : null })),
        totalMoney: { main: all.totalMain, ...(all.totalSecond !== null && { second: all.totalSecond }) },
        // The gold price typed by the person (null = no price) and whether that leaves gold out of the total.
        gold: { price: state.goldPrice, excludedFromTotal: all.goldExcluded },
        rates,
        typedRates: typed,
      },
    };
  },
});

const addTransfer = defineTool({
  name: 'add_transfer',
  title: 'Record transfer between accounts',
  description: [
    'Records money moved from one account to another in the finances of `user`: it leaves `from_account` and arrives in `to_account`. Use it when the person says they sent, exchanged, withdrew or moved money between their accounts, for example dollars sent to their pesos account.',
    'It is not an expense and does not count as used. `amount` is what leaves, in the currency of the origin account; what arrives is amount × rate, in the currency of the destination account.',
    "Between accounts of different currencies pass `rate` if the person says it or says how much arrived; if it is omitted, the rate in effect on that date for the two currencies is used and the answer says where it came from. The transfers of a month also set that month's rate between the two currencies while the person has never typed one. Between accounts of the same currency the same amount arrives.",
    `Defaults: via ${VIAS[0]} and today's date in ${TIMEZONE}. \`via\` is free text: the name of the service used (${VIAS.join(', ')} or any other). If the month of the date does not exist, it is created (only near today); if it is closed, the call fails.`,
    "With `move_budget: true` (formerly `add_to_budget`, still accepted) the transfer also moves budget within its month: the budget part of the origin account goes down by the amount sent and the part of the destination account goes up by the amount that arrived, so the month's total budget stays the same when the transfer's rate is the month's rate. It does not create budget. The answer then states the month's budget.",
    'Pass `fee` when the service charged a fee on top of the amount: it is in the currency of the origin account, lowers that account\'s balance and counts as a transaction of the month (category Other), so the available budget drops by it. It is not a separate expense: do not also record it with add_transaction.',
    'The answer states what left, what arrived and the new balance of both accounts. Each call creates a new transfer: do not repeat it for the same transfer.',
  ].join(' '),
  schema: addTransferArgs,
  readOnly: false,
  idempotent: false,
  async run({ from_account, to_account, amount, rate: given, via, date: givenDate, fee, move_budget, add_to_budget }, ctx) {
    const { db, now, user } = ctx;
    if (givenDate) await assertReachable(ctx, givenDate);
    const date = givenDate ?? todayISO(now);
    const key = monthOf(date);

    // The accounts are resolved before touching anything: one that is not recognized never gets to create the month.
    const { accounts } = await userAccounts(db, user.id);
    const from = matchAccount(accounts, from_account, 'from_account');
    const to = matchAccount(accounts, to_account, 'to_account');
    // A gold account holds grams: it neither sends nor receives money.
    if (!isMoneyAccount(from)) throw goldAccountError(from.name);
    if (!isMoneyAccount(to)) throw goldAccountError(to.name);
    if (from.id === to.id) throw validationError(invalidData(`to_account: must be a different account from from_account (both are ${from.name})`));
    const same = from.currency === to.currency;
    // Between accounts of the same currency, what goes in equals what comes out: another rate would invent or lose money.
    if (same && given !== undefined && given !== 1) {
      throw validationError(invalidData(`rate: must be omitted between accounts of the same currency (both are in ${from.currency})`));
    }

    const { month, created } = await ensureMonth(db, user.id, key);
    if (month.closed) throw monthClosedError(key);
    // Without a rate, the one in effect on the transfer's date for that pair applies. It is resolved here (and not inside
    // createTransfer) to be able to say where it came from: once the transfer is saved, the month rate could come from it.
    const assumed = same || given !== undefined ? null : rateFor(await loadState(db, user.id), key, from.currency, to.currency, date);
    const rate = same ? 1 : (given ?? assumed?.rate);
    // The contract's rules (shared/api.ts) are set by the same schema POST /api/transfers uses.
    const transfer = await createTransfer(
      db,
      user.id,
      parse(transferCreateSchema, { monthKey: key, date, via, fromAccountId: from.id, toAccountId: to.id, amount, rate, budget: move_budget ?? add_to_budget ?? false, fee }),
    );
    const received = transferReceived(transfer);
    const after = await afterWrite(ctx, (state) => {
      const { all } = balancesNow(state, now, key);
      const c = monthCalc(state, key);
      return { from: balanceOf(all, from.id), to: balanceOf(all, to.id), budget: c.budget, main: c.main };
    });

    const moved = `${money(transfer.amount, from.currency)} left ${from.name}, ${money(received, to.currency)} arrived in ${to.name}`;
    const head = same ? moved : `${moved} (${pairText(from.currency, to.currency, transfer.rate)})`;
    const sentences = [`Transfer recorded for ${user.name}: ${[head, transfer.via, `${transfer.date} (${label(key)})`].join(SEP)}.`];
    if (created) sentences.push(`The month ${label(key)} was created.`);
    if (assumed) {
      sentences.push(
        `No rate was given: the rate in effect on that date was used (${rateNote(assumed, from.currency, to.currency)}).` +
          (assumed.source === 'default' ? ' Nobody has set that rate yet, so the amount that arrived is only approximate: ask the person how much arrived.' : ''),
      );
    }
    if (after?.from) sentences.push(balanceSentence(after.from));
    if (after?.to) sentences.push(balanceSentence(after.to));
    if (transfer.fee > 0) {
      sentences.push(
        `The fee of ${money(transfer.fee, from.currency)} also left ${from.name} and counts as a transaction of ${label(key)} (category ${FEE_CATEGORY}).`,
      );
    }
    if (transfer.budget && after) {
      sentences.push(
        `Budget of ${label(key)} moved: ${money(transfer.amount, from.currency)} less in ${from.name}, ${money(received, to.currency)} more in ${to.name}; the month's budget is now ${money(after.budget, after.main)}.`,
      );
    }
    return {
      text: sentences.join(' '),
      data: {
        transfer,
        from: accountData(from, after?.from ?? null),
        to: accountData(to, after?.to ?? null),
        sent: { amount: transfer.amount, currency: from.currency },
        fee: { amount: transfer.fee, currency: from.currency },
        received: { amount: received, currency: to.currency },
        rateSource: same ? 'same' : assumed ? assumed.source : 'given',
        month: after ? { key, label: label(key), currency: after.main, budget: after.budget } : null,
        monthCreated: created,
      },
    };
  },
});

const addIncome = defineTool({
  name: 'add_income',
  title: 'Record income',
  description: [
    'Records money received (an income: salary, a payment, a gift…) in the finances of `user` and adds it to the account it enters. Use it when the person says they were paid or received money.',
    `Apart from \`user\`, only \`amount\` is required. Defaults: the person's default account, the currency of that account and today's date in ${TIMEZONE}. Pass \`account\` if the person names the account the money entered, and \`currency\` only if they name a currency: the amount is recorded in the currency they said, without converting.`,
    "The month's income is the sum of the incomes dated in it. An income does not belong to a month sheet, so it can also be recorded with a date in a closed month; a date in another year is rejected.",
    "With `add_to_budget: true` the income also raises the budget of the month of its date, in the part of the account it enters, by its amount (converted to the currency of that account at the rate in effect on its date); the answer then states the month's budget. Use it only when the person asks for it.",
    'To add grams to a gold account, name that account and pass the grams as `amount`, without `currency` and without `add_to_budget`: grams of gold are not money, so they do not count in the month\'s income.',
    "The answer states the new balance of the account and the month's income so far. Each call creates a new income: do not repeat it for the same one. Do not use it for money moved between the person's own accounts (use add_transfer).",
  ].join(' '),
  schema: addIncomeArgs,
  readOnly: false,
  idempotent: false,
  async run({ amount, currency: cur, account: named, date: givenDate, description, add_to_budget, rate, recurring }, ctx) {
    const { db, now, user } = ctx;
    if (givenDate) await assertReachable(ctx, givenDate);
    const date = givenDate ?? todayISO(now);
    const key = monthOf(date);
    const account = await resolveAccount(ctx, named);

    // An income belongs to no month (shared/api.ts): it does not create the month of its date, nor does a closed one stop it.
    const income = await createIncome(
      db,
      user.id,
      parse(incomeCreateSchema, { date, desc: description ?? '', accountId: account.id, amount, cur: cur ?? account.currency, budget: add_to_budget, rate, recurring }),
    );
    const after = await afterWrite(ctx, (state) => ({
      state,
      main: state.mainCurrency,
      balance: balanceOf(balancesNow(state, now, key).all, account.id),
      monthIncome: incomeInMonth(state, key),
      count: state.incomes.filter((i) => monthOf(i.date) === key).length,
      // The budget only exists if the month is recorded: an income does not create the month of its date.
      budget: state.months[key] ? monthCalc(state, key).budget : null,
    }));

    const parts = [
      income.desc,
      after && isMoneyIncome(income) ? moneyIn(after.state, key, income.amount, income.cur, after.main, income.date) : money(income.amount, income.cur),
      `into ${accountPart(after?.state ?? null, key, account, income.amount, income.cur, income.date)}`,
      `${income.date} (${label(key)})`,
    ];
    const sentences = [`Income recorded for ${user.name}: ${parts.filter(Boolean).join(SEP)}.`];
    if (after?.balance) sentences.push(balanceSentence(after.balance));
    if (after) {
      sentences.push(`Income in ${label(key)} so far: ${money(after.monthIncome, after.main)}.`);
      if (income.budget) {
        sentences.push(
          after.budget === null
            ? `It is marked to raise the budget of ${label(key)}, a month that does not exist yet: it will count when the month is created.`
            : `It was also added to the budget of ${label(key)}, now ${money(after.budget, after.main)}.`,
        );
      }
      if (isMoneyIncome(income)) sentences.push(...approxNotes(after.state, key, income.cur, [after.main, ...moneyCurrencies([account.currency])], income.date));
    }
    return {
      text: sentences.join(' '),
      data: {
        income,
        account: accountData(account, after?.balance ?? null),
        month: after
          ? { key, label: label(key), currency: after.main, income: after.monthIncome, incomeCount: after.count, budget: after.budget }
          : null,
      },
    };
  },
});

const listAccounts = defineTool({
  name: 'list_accounts',
  title: 'List accounts',
  description: [
    "Lists the accounts in the finances of `user`: the name, currency and current balance of each visible account, which one is the default account, and the total money in the person's main currency and in their second currency.",
    `A gold account has currency ${GOLD} and its balance is in grams; its value in money uses the gold price typed by the person (the value of 1 gram), which is also stated. With no gold price set, gold is listed in grams only and is not counted in the total.`,
    'Call it when you need to know which accounts exist: before recording an expense, an income or a transfer for which the person names an account you do not know, or when they ask how much money they have or what the balance of an account is.',
    "Balances are never typed: each one is the account's opening balance plus everything recorded since. Hidden accounts are not listed. It also says what today's date is for the users.",
  ].join(' '),
  schema: listAccountsArgs,
  readOnly: true,
  idempotent: true,
  async run(_args, ctx) {
    const { db, now, user } = ctx;
    // Someone who never opened the web app gets their initial accounts here (as on any write): without them the
    // list would come out empty and the model would have nothing to record into.
    const state = await userState(db, user.id);
    const { asOf, all } = balancesNow(state, now);
    const main = state.mainCurrency;
    const second = state.secondCurrency;
    const preferred = defaultAccount(state);
    const visible = all.accounts.filter((b) => !b.account.hidden);
    const hidden = all.accounts.length - visible.length;
    const today = todayISO(now);
    const rates = ratesToMain(state, asOf, [...(second ? [second] : []), ...moneyCurrencies(visible.map((b) => b.account.currency))]);

    const lines = [
      `${user.name}${SEP}${visible.length} ${visible.length === 1 ? 'account' : 'accounts'}${SEP}main currency ${main}${second ? `, second currency ${second}` : ', no second currency'}`,
      ...visible.map((b) =>
        [
          b.account.name,
          isGold(b.account.currency) ? `${GOLD} (gold, in grams)` : b.account.currency,
          `balance ${balanceText(state, asOf, b, main)}`,
          b.account.id === preferred?.id && 'default account',
        ]
          .filter(Boolean)
          .join(SEP),
      ),
      `Total money: ${second && all.totalSecond !== null ? `${money(all.totalMain, main)} (${money(all.totalSecond, second)})` : money(all.totalMain, main)}`,
      ...goldLines(state, all),
    ];
    if (hidden > 0) lines.push(`Hidden accounts, not listed and not counted in the total: ${hidden}.`);
    lines.push(`Rates used (${label(asOf)}): ${rates.map(rateText).join('; ')}`, `Today is ${today}.`);
    return {
      text: lines.join('\n'),
      data: {
        today,
        asOf,
        mainCurrency: main,
        secondCurrency: second,
        defaultAccountId: preferred?.id ?? null,
        accounts: visible.map((b) => ({
          ...accountData(b.account, b),
          // For a gold account, `balance` is grams; its value is null if there is no gold price.
          inMain: b.valued ? b.inMain : null,
          ...(second && { inSecond: b.valued ? b.inSecond : null }),
          isDefault: b.account.id === preferred?.id,
        })),
        totalMoney: { main: all.totalMain, ...(all.totalSecond !== null && { second: all.totalSecond }) },
        // The gold price typed by the person (null = no price) and whether that leaves gold out of the total.
        gold: { price: state.goldPrice, excludedFromTotal: all.goldExcluded },
        hiddenCount: hidden,
        rates,
      },
    };
  },
});

/** The total of the credit card an expense is charged to (its own, or the first active one if it does not say). */
function cardTotalLine(c: MonthCalc, cardId: string | null | undefined): string[] {
  const k = c.cards.find((x) => x.card.id === (cardId ?? c.cards[0]?.card.id));
  return k ? [`${k.card.name} total: ${money(k.total, k.cur)}.`] : [];
}

const markFixedPaid = defineTool({
  name: 'mark_fixed_paid',
  title: 'Mark fixed expense as paid',
  description: [
    'Marks one of the fixed expenses of a month in the finances of `user` (the "Fixed monthly expenses" list: electricity, internet, insurance, subscriptions…) as paid, or as not paid with `paid: false`. Use it when the person says they have already paid one of their fixed expenses.',
    "The expense is found by name, ignoring case and accents, and part of the name is enough if it identifies only one. If none or several match, the answer lists the names of the month's fixed expenses so the call can be repeated with the exact name.",
    'While it is marked as paid, its amount is subtracted from the account it is paid from: the answer says which account that is and its new balance. If the expense is on the credit card (`on_card: true`), marking it as paid charges it to the card instead: no account changes until the card is paid with pay_credit_card.',
    `Defaults: ${IN_PROGRESS} and \`paid: true\`. It does not change the amount or the account of the expense or create new fixed expenses; in a closed month it fails.`,
  ].join(' '),
  schema: markFixedPaidArgs,
  readOnly: false,
  idempotent: true,
  async run({ name, month, paid, on_card: onCardArg }, ctx) {
    const { db, now, user } = ctx;
    const state = await loadState(db, user.id);
    const m = resolveMonth(state, month, ctx);
    const where = label(m.key);

    const hits = findFixed(m.fixed, name);
    if (hits.length !== 1) {
      if (m.fixed.length === 0) throw notFoundError(`${user.name} has no fixed expenses in ${where}.`);
      const all = `Fixed expenses in ${where}: ${m.fixed.map((f) => f.name).join(', ')}.`;
      throw hits.length === 0
        ? notFoundError(`No fixed expense for ${user.name} in ${where} matches "${quoted(name)}". ${all}`)
        : validationError(
            `"${quoted(name)}" matches several fixed expenses for ${user.name} in ${where}: ${hits.map((f) => f.name).join(', ')}. Repeat the call with the exact name. ${all}`,
          );
    }

    const found = hits[0]!;
    const changed = found.paid !== paid || (onCardArg !== undefined && (found.onCard === true) !== onCardArg);
    // With no change nothing is written: repeating the call is harmless. The closed-month rule is applied by patchFixed.
    const fixed = changed ? await patchFixed(db, user.id, found.id, parse(fixedPatchSchema, { paid, ...(onCardArg === undefined ? {} : { onCard: onCardArg }) })) : found;
    m.fixed = m.fixed.map((f) => (f.id === fixed.id ? fixed : f));
    const c = monthCalc(state, m.key);
    // An expense on the credit card does not come out of any account when it is marked: it stays charged to the credit card.
    const onCard = fixed.onCard === true;
    const paidFrom = onCard ? null : balanceOf(balancesNow(state, now, m.key).all, fixed.accountId);

    const what = [
      fixed.name,
      moneyIn(state, m.key, fixed.amount, fixed.cur, c.main),
      where,
      onCard ? (paid ? 'charged to the credit card' : 'on the credit card') : paidFrom && `paid from ${accountPart(state, m.key, paidFrom.account, fixed.amount, fixed.cur)}`,
    ];
    const head = !changed
      ? `${fixed.name} was already ${paid ? 'paid' : 'not paid'} for ${user.name} in ${where}: nothing was changed.`
      : `${paid ? 'Paid' : 'Marked as not paid'} for ${user.name}: ${what.filter(Boolean).join(SEP)}.`;
    return {
      text: [head, fixedLine(c), usedLine(c), ...(onCard ? cardTotalLine(c, fixed.cardId) : []), ...(paidFrom ? [balanceSentence(paidFrom)] : [])].join(' '),
      data: {
        fixed,
        changed,
        account: paidFrom ? accountData(paidFrom.account, paidFrom) : null,
        month: { ...monthStatus(c), fixedCount: c.fixedCount, paidCount: c.paidCount, pending: c.pending },
      },
    };
  },
});

/** The credit card the person names or, with no name, the only active one / the first active one. */
async function resolveCard({ db }: ToolContext, userId: string, named: string | undefined): Promise<CreditCard> {
  const cards = await listCards(db, userId);
  if (named === undefined) {
    const first = cards.find((c) => c.active);
    if (!first) throw validationError('There is no active credit card: the person can add one in the app (Month screen).');
    return first;
  }
  return matchCard(cards, named);
}

const payCreditCard = defineTool({
  name: 'pay_credit_card',
  title: 'Pay credit card',
  description: [
    "Adds a payment of the bill of one credit card in a month in the finances of `user`: the amount (in the currency of that card, at most what is still left to pay; it may be only part of it) is subtracted from the account it is paid from and counts as used in the budget. A month can have several payments, each from its own account. What is left unpaid stays pending in the month and, if the month closes with it unpaid, carries to the next one. Use it when the person says they paid a credit card (or part of it).",
    'Purchases on a card (add_transaction with method "Credit card", or fixed expenses on the card) do not touch any account or the budget when they are made: only this payment does. Each call adds one more payment; the answer says what is left.',
    `Defaults: ${IN_PROGRESS}, the first active card (pass \`card\` when the person has several and names one; see list_credit_cards), and the account of the previous payment of that card or the person's default account. In a closed month it fails, and the amount cannot be more than what is left to pay (month_summary shows it).`,
  ].join(' '),
  schema: payCreditCardArgs,
  readOnly: false,
  idempotent: false,
  async run({ amount, account: named, month, card: cardName }, ctx) {
    const { db, now, user } = ctx;
    const before = await loadState(db, user.id);
    const m = resolveMonth(before, month, ctx);
    const card = await resolveCard(ctx, user.id, cardName);
    // With no account named: that of the credit card's last payment (cardAccountFor); with one named, the one the person says.
    const account = named === undefined ? cardAccountFor(before, m.key, card.id) : await resolveAccount(ctx, named);
    if (!account) throw noAccountsError();
    if (!isMoneyAccount(account)) throw goldAccountError(account.name);
    await payCard(db, user.id, m.key, card.id, { amount, accountId: account.id }, now);

    const after = await afterWrite(ctx, (state) => ({
      state,
      calc: monthCalc(state, m.key),
      balance: balanceOf(balancesNow(state, now, m.key).all, account.id),
      card: state.months[m.key] ? cardCalcs(state, m.key).find((k) => k.card.id === card.id) : undefined,
    }));
    const k = after?.card;
    const sentences = [`Paid ${money(amount, card.cur)} of ${card.name} for ${user.name} in ${label(m.key)}, from ${account.name}.`];
    if (k) {
      sentences.push(
        `Card total: ${money(k.total, card.cur)}${SEP}paid so far: ${money(k.paid, card.cur)}${SEP}left to pay: ${money(k.remainder, card.cur)}` +
          (k.remainder > 1e-6 ? ' (it carries to the next month if this one closes with it unpaid).' : '.'),
      );
    }
    if (after) sentences.push(usedLine(after.calc));
    if (after?.balance) sentences.push(balanceSentence(after.balance));
    return {
      text: sentences.join(' '),
      data: {
        creditCard: k ? { id: card.id, name: card.name, currency: card.cur, total: k.total, paid: k.paid, payments: k.payments, remainder: k.remainder } : null,
        account: accountData(account, after?.balance ?? null),
        month: after ? monthStatus(after.calc) : null,
      },
    };
  },
});

const listCreditCards = defineTool({
  name: 'list_credit_cards',
  title: 'List credit cards',
  description: [
    'Lists the credit cards in the finances of `user` (the person may have none, one or several): name, bank, last 4 digits, currency, limit, cutoff day and due day, whether it is on, how much is owed on it now, what share of the limit that is, and the hint "pay at least X before the cutoff to end it under 10% of the limit" when the limit and the cutoff day are set.',
    'Call it when you need to know which cards exist (before add_transaction with method "Credit card" or pay_credit_card when the person names a card you do not know), or when they ask how much they owe on a card or when to pay it.',
    'The amounts owed are those of the latest month. Cards that are off are listed too, marked as off.',
  ].join(' '),
  schema: listCreditCardsArgs,
  readOnly: true,
  idempotent: true,
  async run(_args, ctx) {
    const { db, now, user } = ctx;
    const state = await userState(db, user.id);
    const today = todayISO(now);
    const last = sortedKeys(state).at(-1);
    const rows = [...state.cards].sort((a, b) => a.sort - b.sort).map((card) => {
      const calc = last ? cardCalc(state, last, card.id) : undefined;
      const owed = calc?.remainder ?? 0;
      return { card, owed, util: card.limit ? Math.max(0, owed) / card.limit : null, hint: cardHint(card, owed, today) };
    });
    const lines = [
      `${user.name}${SEP}${rows.length === 0 ? 'no credit cards' : `${rows.length} credit card${rows.length === 1 ? '' : 's'}`}`,
      ...rows.map(({ card, owed, util, hint }) =>
        [
          `${card.name}${card.bank ? ` (${card.bank}${card.last4 ? ` ****${card.last4}` : ''})` : card.last4 ? ` (****${card.last4})` : ''}`,
          card.cur,
          card.active ? 'on' : 'off',
          `owed ${money(owed, card.cur)}`,
          card.limit ? `limit ${money(card.limit, card.cur)}${SEP}${((util ?? 0) * 100).toFixed(1)}% used` : 'no limit set',
          card.cutoffDay ? `cutoff day ${card.cutoffDay}` : 'no cutoff day',
          card.dueDay ? `due day ${card.dueDay}` : 'due day unknown',
          hint && hintText(card.name, card.cur, hint),
        ]
          .filter(Boolean)
          .join(SEP),
      ),
      `Today is ${today}.`,
    ];
    return {
      text: lines.join('\n'),
      data: {
        today,
        month: last ?? null,
        cards: rows.map(({ card, owed, util, hint }) => ({ ...card, owed, utilization: util, hint })),
      },
    };
  },
});

const addBudgetExtra = defineTool({
  name: 'add_budget_extra',
  title: 'Add extra budget',
  description: [
    "Adds extra money to the budget of a month in the finances of `user`, recorded as a dated addition on top of the original budget (the initial amount stays as it was and month_summary reports both). Use it when the person says they need to add more money to this month's budget, for example \"add 5,000 to the budget for the medical expense\".",
    `Apart from \`user\`, only \`amount\` is required. Defaults: the person's default account (the amount is in the currency of that account) and today's date in ${TIMEZONE}; the month is the one of the date. Pass \`note\` with the reason, and \`income\` only when the person says which income it is taken from (an income into the same account). It fails in a closed month and for a gold account.`,
    "The answer states the budget summary of the month: initial, added, new total, spent and remaining. Each call adds one more extra: do not repeat it for the same one. It does not move any money between accounts; the budget is a plan.",
  ].join(' '),
  schema: addBudgetExtraArgs,
  readOnly: false,
  idempotent: false,
  async run({ amount, account: named, note, date: givenDate, income: incomeName }, ctx) {
    const { db, now, user } = ctx;
    if (givenDate) await assertReachable(ctx, givenDate);
    const before = await loadState(db, user.id);
    const m = resolveMonth(before, givenDate ? monthOf(givenDate) : undefined, ctx);
    const account = await resolveAccount(ctx, named);
    if (!isMoneyAccount(account)) throw goldAccountError(account.name);
    const date = givenDate ?? clampToMonth(todayISO(now), m.key);
    const income = incomeName === undefined ? null : findBudgetIncome(before, incomeName, account.id, m.key, user.name);
    await addBudgetEntry(db, user.id, m.key, { accountId: account.id, amount, date, note: note ?? '', kind: 'adjust', incomeId: income?.id ?? null }, now);

    const after = await afterWrite(ctx, (state) => ({ state, summary: budgetSummary(state, m.key) }));
    const added = money(amount, account.currency);
    const sentences = [`Extra budget recorded for ${user.name}: +${added} from ${account.name}${income ? `, income "${income.desc || income.id}"` : ''}${note ? ` (${note})` : ''} on ${date} (${label(m.key)}).`];
    if (after) sentences.push(`Budget summary of ${label(m.key)}: ${summaryText(after.summary)}.`);
    return {
      text: sentences.join(' '),
      data: {
        entry: {
          accountId: account.id,
          account: account.name,
          amount,
          currency: account.currency,
          date,
          note: note ?? '',
          incomeId: income?.id ?? null,
          income: income ? income.desc : null,
        },
        month: { key: m.key, label: label(m.key) },
        budgetSummary: after ? summaryData(after.summary) : null,
      },
    };
  },
});

/** In the order tools/list lists them. */
const TOOLS = new Map(
  [addTransaction, addOutsideExpense, listTransactions, monthSummary, addTransfer, markFixedPaid, addIncome, listAccounts, payCreditCard, listCreditCards, addBudgetExtra].map((t) => [t.name, t]),
);
// ── Methods ──────────────────────────────────────────────────────────────────

type RequestMessage = Extract<Incoming, { kind: 'request' }>;

/** The parts of the HTTP request that decide how a message is handled. */
interface HttpContext {
  headers: Headers;
  /** MCP-Protocol-Version header, already checked to be a supported version; null if it was not sent. */
  version: string | null;
}

/**
 * Version negotiation with a handshake: the one the client asks for if it is understood; otherwise, the newest of
 * those that use a handshake (the later ones have no initialize: they cannot be agreed on this way).
 */
function initialize(params: Record<string, unknown>, users: readonly AppUser[]): unknown {
  const requested = params.protocolVersion;
  if (typeof requested !== 'string') throw new RpcError(INVALID_PARAMS, 'Invalid params: `protocolVersion` is missing.');
  return {
    protocolVersion: isLegacy(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0],
    capabilities: CAPABILITIES,
    serverInfo: SERVER_INFO,
    instructions: instructions(users),
  };
}

/** There are nine: they fit in one page and no nextCursor is returned. */
function listTools(users: readonly AppUser[]): { tools: Record<string, unknown>[] } {
  return { tools: [...TOOLS.values()].map((t) => t.definition(users)) };
}

async function callTool(params: Record<string, unknown>, ctx: ServerContext): Promise<Record<string, unknown>> {
  const { name } = params;
  if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, 'Invalid params: `name` is missing.');
  const tool = TOOLS.get(name);
  if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${quoted(name)}`);
  const args = params.arguments ?? {};
  if (!isRecord(args)) throw new RpcError(INVALID_PARAMS, 'Invalid params: `arguments` must be an object.');

  try {
    // First of all, whose: without that there is nothing to validate or read.
    const { user: requested, ...own } = args;
    const user = resolveUser(ctx.users, requested);
    const out = await tool.call(own, { db: ctx.db, now: ctx.now, user });
    return {
      content: [{ type: 'text', text: out.text }],
      structuredContent: { user: { id: user.id, name: user.name }, ...out.data },
      isError: false,
    };
  } catch (err) {
    const api = toApiError(err);
    // The unexpected is not a tool error: it propagates and is answered as an internal error.
    if (api.status === 500) throw err;
    return { content: [{ type: 'text', text: api.message }], isError: true };
  }
}

/** MCP only uses named parameters. */
function namedParams(params: unknown, status = 200): Record<string, unknown> {
  if (params != null && !isRecord(params)) throw new RpcError(INVALID_PARAMS, 'Invalid params: `params` must be an object.', status);
  return params ?? {};
}

function headerMismatch(detail: string): RpcError {
  return new RpcError(HEADER_MISMATCH, `The headers do not match the body: ${detail}`, 400);
}

const VERSION_MISMATCH = '`_meta` declares a protocol version that is not the one in the MCP-Protocol-Version header.';

/** Value of a header that repeats a field of the body: anything that is not plain ASCII travels as =?base64?…?= (UTF-8). */
function mirrored(value: string | null): string | null {
  const encoded = value === null ? null : /^=\?base64\?(.*)\?=$/.exec(value);
  if (!encoded) return value;
  try {
    const bytes = Uint8Array.from(atob(encoded[1]!), (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Era with a handshake (2025-11-25 and earlier). */
async function dispatchLegacy(req: RequestMessage, ctx: ServerContext, http: HttpContext): Promise<unknown> {
  const params = namedParams(req.params);
  if (req.method === 'initialize') return initialize(params, ctx.users);

  // Anyone declaring its version in `_meta` speaks the protocol without a handshake, which requires repeating it in the header.
  const declared = isRecord(params._meta) ? params._meta[META_VERSION] : undefined;
  if (declared !== undefined && declared !== http.version) throw headerMismatch(VERSION_MISMATCH);

  switch (req.method) {
    case 'ping':
      return {};
    case 'tools/list':
      return listTools(ctx.users);
    case 'tools/call':
      return callTool(params, ctx);
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${quoted(req.method)}`);
  }
}

/**
 * Era without a handshake (2026-07-28). The headers repeat fields of the body so an intermediary can
 * route without reading it; the server has to reject the request if they do not match (400), because otherwise each
 * one would be acting on different data.
 */
async function dispatchModern(req: RequestMessage, ctx: ServerContext, http: HttpContext): Promise<unknown> {
  const params = namedParams(req.params, 400);
  const meta = isRecord(params._meta) ? params._meta : {};
  const declared = meta[META_VERSION];
  if (typeof declared !== 'string') throw new RpcError(INVALID_PARAMS, `Invalid params: \`_meta["${META_VERSION}"]\` is missing.`, 400);
  if (declared !== http.version) throw headerMismatch(VERSION_MISMATCH);
  if (!isRecord(meta[META_CLIENT_CAPABILITIES])) {
    throw new RpcError(INVALID_PARAMS, `Invalid params: \`_meta["${META_CLIENT_CAPABILITIES}"]\` is missing.`, 400);
  }
  if (http.headers.get('Mcp-Method') !== req.method) throw headerMismatch('the Mcp-Method header is missing or is not the method of the request.');
  // Without a readable name in the body there is nothing to compare with: callTool rejects it.
  if (req.method === 'tools/call' && typeof params.name === 'string' && mirrored(http.headers.get('Mcp-Name')) !== params.name) {
    throw headerMismatch('the Mcp-Name header is missing or is not the name of the tool.');
  }

  let result: Record<string, unknown>;
  switch (req.method) {
    case 'server/discover':
      result = { supportedVersions: PROTOCOL_VERSIONS, capabilities: CAPABILITIES, instructions: instructions(ctx.users), ...CACHE_HINTS };
      break;
    case 'tools/list':
      result = { ...listTools(ctx.users), ...CACHE_HINTS };
      break;
    case 'tools/call':
      result = await callTool(params, ctx);
      break;
    default:
      // Here a method that does not exist is also a 404 (initialize and ping are no longer part of the protocol).
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${quoted(req.method)}`, 404);
  }
  // Without a handshake there is no other moment to introduce itself: the server identifies itself in each result.
  return { resultType: 'complete', ...result, _meta: { [META_SERVER_INFO]: SERVER_INFO } };
}

interface Answer {
  /** HTTP status if the message travels alone. */
  status: number;
  body: JsonRpcResponse;
}

async function respond(req: RequestMessage, ctx: ServerContext, http: HttpContext): Promise<Answer> {
  // initialize only exists with a handshake, whatever the header says.
  const modern = http.version !== null && isModern(http.version) && req.method !== 'initialize';
  try {
    const result = await (modern ? dispatchModern(req, ctx, http) : dispatchLegacy(req, ctx, http));
    return { status: 200, body: { jsonrpc: '2.0', id: req.id, result } };
  } catch (err) {
    if (err instanceof RpcError) return { status: err.status, body: failure(req.id, err.code, err.message) };
    // Only the unexpected goes to the log, and never to the response.
    console.error(`[mcp] ${req.method}`, err);
    return { status: 200, body: failure(req.id, INTERNAL_ERROR, INTERNAL_MESSAGE) };
  }
}

// ── Transport ────────────────────────────────────────────────────────────────

/** Handles /mcp. `now` is only passed in tests. */
export async function handleMcp(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  // Authentication goes before everything else: without the token the body is not read and what the server accepts is
  // not revealed. The 401 body is the same as in the rest of the API (shared/api.ts).
  if (!(await checkBearer(request, env))) {
    return reply(401, errorBody('unauthorized', 'Invalid or missing token.'), { 'WWW-Authenticate': 'Bearer' });
  }
  if (request.method !== 'POST') {
    return reply(405, failure(null, INVALID_REQUEST, 'HTTP method not allowed: this server only accepts POST.'), { Allow: 'POST' });
  }

  try {
    const bytes = await readLimitedBody(request, MAX_BODY_BYTES);
    if (!bytes) return reply(413, failure(null, INVALID_REQUEST, 'The request body is too large.'));

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      return reply(400, failure(null, PARSE_ERROR, 'The request body is not valid JSON.'));
    }

    const batch = Array.isArray(payload);
    const raw: unknown[] = batch ? (payload as unknown[]) : [payload];
    if (raw.length === 0) return reply(400, failure(null, INVALID_REQUEST, 'Invalid request: the batch is empty.'));
    if (raw.length > MAX_BATCH) return reply(400, failure(null, INVALID_REQUEST, `Invalid request: a batch allows up to ${MAX_BATCH} messages.`));
    const messages = raw.map(classify);
    const first = messages[0]!;

    // On initialize the version is negotiated in the body. On everything else the header says which version is spoken:
    // if it is none of the supported ones it is rejected saying which ones there are, so the client can retry with one.
    const version = request.headers.get('MCP-Protocol-Version');
    const initializing = messages.some((m) => m.kind === 'request' && m.method === 'initialize');
    if (version !== null && !isSupported(version) && !initializing) {
      const data = { supported: PROTOCOL_VERSIONS, requested: quoted(version) };
      const id = !batch && first.kind === 'request' ? first.id : null;
      return reply(400, failure(id, UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version: ${data.requested}.`, data));
    }
    if (batch && version !== null && isModern(version) && !initializing) {
      return reply(400, failure(null, INVALID_REQUEST, 'Invalid request: since version 2026-07-28 each POST carries a single message.'));
    }

    // One at a time and in order: a batch can record something and ask for the summary afterward.
    // A malformed USERS is a configuration error: it throws here and comes out as an internal error, with the reason in the log.
    const ctx: ServerContext = { db: env.DB, now, users: configuredUsers(env) };
    const http: HttpContext = { headers: request.headers, version };
    const answers: Answer[] = [];
    for (const m of messages) {
      if (m.kind === 'invalid') answers.push({ status: 400, body: failure(m.id, INVALID_REQUEST, 'Invalid JSON-RPC request.') });
      else if (m.kind === 'request') answers.push(await respond(m, ctx, http));
      // Notifications and the client's responses are accepted and not answered.
    }

    if (answers.length === 0) return new Response(null, { status: 202, headers: NO_STORE });
    if (batch) return reply(200, answers.map((a) => a.body));
    return reply(answers[0]!.status, answers[0]!.body);
  } catch (err) {
    console.error('[mcp]', err);
    return reply(500, failure(null, INTERNAL_ERROR, INTERNAL_MESSAGE));
  }
}
