// Recording of an expense dictated to Claude. Used by POST /api/ingest/transaction and the add_transaction
// tool of the MCP server, so it knows nothing about HTTP and validates its own input.

import type { IngestResponse, IngestTransaction } from '../shared/api';
import { isMoneyAccount } from '../shared/calc';
import { CATS, CREDIT_CARD_METHOD, METHODS } from '../shared/constants';
import { canonicalCat, canonicalMethod } from '../shared/i18n';
import { currentMonthKey, label, monthOf, monthSpan, todayISO } from '../shared/month';
import type { Account, AppUser, CreditCard } from '../shared/types';
import { createTransaction, ensureMonth, getMonth, listCards, userAccounts } from './db';
import { goldAccountError, invalidData, monthClosedError, noAccountsError, validationError } from './errors';
import { userFromBody } from './users';
import { ingestSchema, parse } from './validate';

// ── Accounts named out loud ──────────────────────────────────────────────────

/**
 * To compare names the way a person says them: no capitals, no accents and no extra spaces
 * ("Cuenta Dólares" = "cuenta dolares", "İş Bankası" = "is bankasi").
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text comes from outside: it is trimmed so the message does not grow with whatever the client sends. */
function shown(text: string): string {
  return text.trim().slice(0, 60);
}

/** The names offered to whoever got it wrong: the accounts they see (or all of them, if every one is hidden). */
function accountNames(accounts: readonly Account[]): string {
  const sorted = [...accounts].sort((a, b) => a.sort - b.sort);
  const visible = sorted.filter((a) => !a.hidden);
  return (visible.length > 0 ? visible : sorted).map((a) => a.name).join(', ');
}

/**
 * The account that `text` names, among the user's: its id as is or its name, ignoring case and accents; first
 * the full name and, if none is called that, a prefix that only one has ("us" → "US account"). Hidden accounts
 * are only looked at when no visible one matches.
 * Throws ApiError 400 `validation` if there is none or there are several, with the account names in the message
 * so Claude can correct itself. `field` is the name of the field in that message.
 * Used by the expense recording below and by the tools of the MCP server.
 */
export function matchAccount(accounts: readonly Account[], text: string, field = 'account'): Account {
  const byId = accounts.find((a) => a.id === text.trim());
  if (byId) return byId;

  const wanted = fold(text);
  const visible = accounts.filter((a) => !a.hidden);
  const hidden = accounts.filter((a) => a.hidden);
  const tiers = [
    visible.filter((a) => fold(a.name) === wanted),
    hidden.filter((a) => fold(a.name) === wanted),
    visible.filter((a) => fold(a.name).startsWith(wanted)),
    hidden.filter((a) => fold(a.name).startsWith(wanted)),
  ];
  const found = wanted ? tiers.find((tier) => tier.length > 0) : undefined;
  if (found?.length === 1) return found[0]!;

  const names = accountNames(accounts);
  throw validationError(
    invalidData(
      found
        ? `${field}: "${shown(text)}" matches several accounts; use the full name of one of: ${names}`
        : `${field}: unknown account "${shown(text)}" (accounts: ${names})`,
    ),
  );
}

/**
 * The credit card that `text` names: its id or its name (ignoring case and accents), first the full name and, if
 * none is called that, a prefix that only one has. The ones turned off are only looked at if no active one
 * matches. 400 `validation` with the credit card names if there is none or there are several.
 */
export function matchCard(cards: readonly CreditCard[], text: string, field = 'card'): CreditCard {
  const byId = cards.find((c) => c.id === text.trim());
  if (byId) return byId;
  const wanted = fold(text);
  const on = cards.filter((c) => c.active);
  const off = cards.filter((c) => !c.active);
  const tiers = [
    on.filter((c) => fold(c.name) === wanted),
    off.filter((c) => fold(c.name) === wanted),
    on.filter((c) => fold(c.name).startsWith(wanted)),
    off.filter((c) => fold(c.name).startsWith(wanted)),
  ];
  const found = wanted ? tiers.find((tier) => tier.length > 0) : undefined;
  if (found?.length === 1) return found[0]!;
  const names = cards.map((c) => c.name).join(', ') || 'none yet';
  throw validationError(
    invalidData(found ? `${field}: "${shown(text)}" matches several credit cards; use the full name of one of: ${names}` : `${field}: unknown credit card "${shown(text)}" (credit cards: ${names})`),
  );
}

// ── Recording ────────────────────────────────────────────────────────────────

/**
 * Saves the transaction in the finances of the user `input.user`, who has to be one of `users` (the configured
 * ones, see server/users.ts configuredUsers); if `users` holds a single one, it is that one and `user` may be missing.
 * Applies the contract's defaults (date: today in the user's time zone; category 'Food'; method 'Debit card';
 * account: the user's default account; currency: that account's) and saves it in the month of its date,
 * creating it if it does not exist. `account` is the id of an account or its name (see matchAccount).
 * Claude talks to each person in their language: a category or a method said in Spanish or in Turkish
 * ('Comida', 'Kredi kartı') is saved under its canonical name; a bare 'Tarjeta' or 'Kart', as 'Debit card';
 * whatever is not on the list is saved as is.
 * If the user never opened the web app, their initial accounts and goals are created first.
 * Throws ApiError: 400 `validation` if the input is invalid, the user is missing or does not exist or the
 * account is not recognized; 409 `month_closed` if that month is closed.
 */
export async function ingestTransaction(
  db: D1Database,
  users: readonly AppUser[],
  input: IngestTransaction,
  now: Date = new Date(),
): Promise<IngestResponse> {
  const data = parse(ingestSchema, input);
  const user = userFromBody(users, data.user);
  const date = data.date ?? todayISO(now);
  const monthKey = monthOf(date);

  // The account is resolved before touching anything: one that is not recognized never gets to create the month.
  const { accounts, defaultAccount } = await userAccounts(db, user.id);
  const account = data.account === undefined ? defaultAccount : matchAccount(accounts, data.account);
  if (!account) throw noAccountsError();
  // A gold account holds grams: no expense comes out of it.
  if (!isMoneyAccount(account)) throw goldAccountError(account.name);

  // A wrong year would leave a ghost month: only a month close to today is created (6 back, 1 ahead).
  // A month that already exists can be written to, whatever its date.
  const offset = monthSpan(currentMonthKey(now), monthKey) - 1;
  if ((offset < -6 || offset > 1) && !(await getMonth(db, user.id, monthKey))) {
    throw validationError(
      `The date ${date} falls in ${label(monthKey)}, a month that does not exist for ${user.name} and is far from today (${todayISO(now)}). Check the year of the date.`,
    );
  }

  // The credit card, only if the payment is by credit card; with no name, createTransaction uses the first active one.
  const method = data.method ? canonicalMethod(data.method) : METHODS[0];
  const cardId = method === CREDIT_CARD_METHOD && data.card !== undefined ? matchCard(await listCards(db, user.id), data.card).id : undefined;

  const { month, created } = await ensureMonth(db, user.id, monthKey);
  if (month.closed) throw monthClosedError(monthKey);

  const transaction = await createTransaction(
    db,
    user.id,
    {
      monthKey,
      date,
      desc: data.description,
      place: data.place ?? '',
      cat: data.category ? canonicalCat(data.category) : CATS[0],
      method,
      ...(cardId && { cardId }),
      amount: data.amount,
      cur: data.currency ?? account.currency,
      accountId: account.id,
      notes: data.notes ?? '',
    },
    'claude',
    now,
  );
  return { transaction, monthCreated: created };
}
