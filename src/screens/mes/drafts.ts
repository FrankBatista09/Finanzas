// Drafts of the add rows of the "Month" sheet: what they hold, when they can be added and how they are left afterwards.
// It is the logic of the prototype's addFixed / addTransfer / addTx, without React.
//
// Amounts are numbers and 0 means "empty", as the cells in src/ui expect. For account, currency and rate,
// null means "untouched": the field shows whatever applies at that moment (the default account, the account's
// currency, the month rate) and follows it if that changes, until the user picks something else.

import { isMoneyAccount } from '../../../shared/calc';
import type { MoneyAccount } from '../../../shared/calc';
import { CATS, CREDIT_CARD_METHOD, CURRENCIES, METHODS, VIAS } from '../../../shared/constants';
import { fRate } from '../../../shared/format';
import type { Account, Currency, ISODate, MonthKey } from '../../../shared/types';
import type { FixedInput, OutsideInput, PairRate, TransferInput, TxInput } from '../../store';
import { newRateDate } from './rows';

// ── Account and currency of an expense ───────────────────────────────────────

/** What the draft needs to know about the user. It comes straight from useFinanzas(). */
export interface DraftContext {
  /** All the accounts, including the hidden ones. */
  accounts: readonly Account[];
  defaultAccount: MoneyAccount | null;
  main: Currency;
}

interface Paying {
  /** null = the user's default account. */
  accountId: string | null;
  /** null = the currency of the chosen account. */
  cur: Currency | null;
}

/** The account the expense will come out of: the chosen one if it still exists (and is a money account: a gold one pays for nothing); otherwise, the default one. */
export function draftAccount(draft: Pick<Paying, 'accountId'>, ctx: DraftContext): MoneyAccount | null {
  return ctx.accounts.filter(isMoneyAccount).find((a) => a.id === draft.accountId) ?? ctx.defaultAccount;
}

/** The currency of the expense: the chosen one or, while untouched, its account's (the main currency if there are no accounts). */
export function draftCurrency(draft: Paying, ctx: DraftContext): Currency {
  return draft.cur ?? draftAccount(draft, ctx)?.currency ?? ctx.main;
}

// ── Fixed expense ────────────────────────────────────────────────────────────

export interface FixedDraft extends Paying {
  name: string;
  day: string;
  amount: number;
  /** "Pay with" = credit card: the account does not count (the expense does not come out of any until the credit card is paid). */
  onCard: boolean;
  /** Which credit card if `onCard`; null = the first active one (and it follows it if that changes). */
  cardId: string | null;
}

export const EMPTY_FIXED: FixedDraft = { name: '', day: '', amount: 0, cur: null, accountId: null, onCard: false, cardId: null };

/** An item and an amount greater than 0. After adding, the whole draft goes back to EMPTY_FIXED. */
export function canAddFixed(draft: FixedDraft): boolean {
  return draft.name.trim() !== '' && draft.amount > 0;
}

/** What is sent when adding: currency and account already resolved. With no accounts none is sent and the data layer rejects it. */
export function fixedInput(draft: FixedDraft, ctx: DraftContext): FixedInput {
  const account = draftAccount(draft, ctx);
  return {
    name: draft.name,
    day: draft.day,
    amount: draft.amount,
    cur: draftCurrency(draft, ctx),
    ...(account && { accountId: account.id }),
    ...(draft.onCard && { onCard: true, ...(draft.cardId && { cardId: draft.cardId }) }),
  };
}

// ── Transaction ──────────────────────────────────────────────────────────────

export interface TxDraft extends Paying {
  /** null = the user has not touched the date: the shell's is used (today, or day 1 of a month that is not the current one). */
  date: ISODate | null;
  desc: string;
  place: string;
  cat: string;
  method: string;
  amount: number;
  notes: string;
  /** Which credit card if the method is credit; null = the first active one. */
  cardId: string | null;
}

export function newTxDraft(): TxDraft {
  return { date: null, desc: '', place: '', cat: CATS[0], method: METHODS[0], amount: 0, cur: null, accountId: null, notes: '', cardId: null };
}

/** A description and an amount greater than 0. */
export function canAddTx(draft: TxDraft): boolean {
  return draft.desc.trim() !== '' && draft.amount > 0;
}

/** What is sent when adding: the draft with its date, its currency and its account already resolved. */
export function txInput(draft: TxDraft, draftDate: ISODate, ctx: DraftContext): TxInput {
  const account = draftAccount(draft, ctx);
  return {
    date: draft.date ?? draftDate,
    desc: draft.desc,
    place: draft.place,
    cat: draft.cat,
    method: draft.method,
    amount: draft.amount,
    cur: draftCurrency(draft, ctx),
    ...(account && { accountId: account.id }),
    notes: draft.notes,
    ...(draft.method === CREDIT_CARD_METHOD && draft.cardId && { cardId: draft.cardId }),
  };
}

/** What is specific to each expense is cleared; date, category, method, currency and account stay to enter several in a row. */
export function afterTxAdded(draft: TxDraft): TxDraft {
  return { ...draft, desc: '', place: '', amount: 0, notes: '' };
}

// ── Outside-budget expense ───────────────────────────────────────────────────

export interface OutsideDraft extends Paying {
  /** null = untouched: the shell's date, as in TxDraft. */
  date: ISODate | null;
  name: string;
  amount: number;
  desc: string;
}

export function newOutsideDraft(): OutsideDraft {
  return { date: null, name: '', amount: 0, desc: '', cur: null, accountId: null };
}

/** A name and an amount greater than 0. */
export function canAddOutside(draft: OutsideDraft): boolean {
  return draft.name.trim() !== '' && draft.amount > 0;
}

export function outsideInput(draft: OutsideDraft, draftDate: ISODate, ctx: DraftContext): OutsideInput {
  const account = draftAccount(draft, ctx);
  return {
    date: draft.date ?? draftDate,
    name: draft.name,
    desc: draft.desc,
    amount: draft.amount,
    cur: draftCurrency(draft, ctx),
    ...(account && { accountId: account.id }),
  };
}

/** Like transactions: what is specific to each expense is cleared; date, currency and account stay to enter several in a row. */
export function afterOutsideAdded(draft: OutsideDraft): OutsideDraft {
  return { ...draft, name: '', amount: 0, desc: '' };
}

// ── Transfer ─────────────────────────────────────────────────────────────────

export interface TransferDraft {
  /** null = untouched: the shell's date, as in TxDraft. */
  date: ISODate | null;
  /** Free text, exactly as it is in the field (it can be empty mid-edit; see transferInput). */
  via: string;
  /** null = untouched: see transferSides. */
  fromAccountId: string | null;
  toAccountId: string | null;
  /** What goes out, in the currency of the origin account. */
  amount: number;
  /** null = untouched: the month rate for the currencies of the two accounts, and it follows them if they change. */
  rate: number | null;
  /** The "Moves budget" checkbox: checked to begin with, because what is transferred is usually meant to be spent this month. */
  budget: boolean;
  /** null = untouched: the fee of the last transfer through that via (TransferContext.lastFee), and it follows it if the via changes. */
  fee: number | null;
}

export interface TransferContext extends Pick<DraftContext, 'accounts' | 'defaultAccount'> {
  /** The accounts on offer, in their order: the visible money accounts. */
  visible: readonly MoneyAccount[];
  /** The rate of the selected month for that pair, in effect on the draft's date (useFinanzas().rateOf(from, to, undefined, date).rate). */
  rateOf(from: Currency, to: Currency): number;
  /** The fee of the most recent transfer through that via; 0 if there is none (rows.ts lastFee). */
  lastFee(via: string): number;
}

export interface TransferSides {
  from: MoneyAccount | null;
  to: MoneyAccount | null;
}

/** The via the draft starts with, and the one used if the field is left empty (a transfer with no via is not valid). */
export const DEFAULT_VIA: string = VIAS[0];

/** What was typed without the extra spaces or, if there is nothing, the default via. */
function viaOf(draft: TransferDraft): string {
  return draft.via.trim() || DEFAULT_VIA;
}

export function newTransferDraft(): TransferDraft {
  return { date: null, via: DEFAULT_VIA, fromAccountId: null, toAccountId: null, amount: 0, rate: null, budget: true, fee: null };
}

/** Another visible account, different from `than`; preferably one in another currency, which is what a transfer usually is. */
function another(visible: readonly MoneyAccount[], than: MoneyAccount | null): MoneyAccount | null {
  const rest = visible.filter((a) => a.id !== than?.id);
  return rest.find((a) => a.currency !== than?.currency) ?? rest[0] ?? null;
}

/**
 * The two accounts of the draft. Untouched, the money arrives in the default account (the one expenses come out of)
 * from another visible account, preferably in another currency: "US account → DR account". They are never the same;
 * with a single account one of the sides is missing and the transfer cannot be added.
 */
export function transferSides(draft: Pick<TransferDraft, 'fromAccountId' | 'toAccountId'>, ctx: TransferContext): TransferSides {
  const chosen = (id: string | null) => ctx.accounts.filter(isMoneyAccount).find((a) => a.id === id) ?? null;
  const from = chosen(draft.fromAccountId);
  let to = chosen(draft.toAccountId);
  if (to && to.id === from?.id) to = null;
  if (!to) to = ctx.defaultAccount && ctx.defaultAccount.id !== from?.id ? ctx.defaultAccount : another(ctx.visible, from);
  return { from: from ?? another(ctx.visible, to), to };
}

/**
 * The rate a transfer is proposed with: the month's, with two decimals as in the rest of the sheet; one lower
 * than 1 (DOP → USD: 0.017) with four significant figures, since with two decimals it would say nothing.
 */
export function prefillRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return rate >= 1 ? Number(fRate(rate)) : Number(rate.toPrecision(4));
}

export interface TransferRate {
  rate: number;
  /** Between accounts in the same currency the rate is 1 and is not typed. */
  locked: boolean;
}

/** The rate the field shows: 1 between equal currencies; the one the user typed; otherwise, the month's for that pair. */
export function transferRate(draft: TransferDraft, ctx: TransferContext): TransferRate {
  const { from, to } = transferSides(draft, ctx);
  if (!from || !to) return { rate: draft.rate ?? 0, locked: false };
  if (from.currency === to.currency) return { rate: 1, locked: true };
  return { rate: draft.rate ?? prefillRate(ctx.rateOf(from.currency, to.currency)), locked: false };
}

/**
 * Picking the account on one side of a transfer. The two have to be different: picking the one on the other side
 * swaps them (reversing the transfer), which is what is wanted and the only thing possible with two accounts.
 */
export function swapSides(
  row: { fromAccountId: string; toAccountId: string },
  side: 'from' | 'to',
  id: string,
): { fromAccountId: string; toAccountId: string } {
  const other = side === 'from' ? row.toAccountId : row.fromAccountId;
  const mine = side === 'from' ? row.fromAccountId : row.toAccountId;
  const next = id === other ? mine : other;
  return side === 'from' ? { fromAccountId: id, toAccountId: next } : { fromAccountId: next, toAccountId: id };
}

/**
 * The draft after picking an account. Both are pinned as they are shown (the other one no longer moves on its own).
 * A rate typed by hand is kept as long as the transfer is still between the same currencies and in the same
 * direction; if they change, it belonged to another pair and it goes back to following the month rate (as the data
 * layer does when a transfer is edited).
 */
export function pickTransferAccount(draft: TransferDraft, ctx: TransferContext, side: 'from' | 'to', id: string): TransferDraft {
  const before = transferSides(draft, ctx);
  const ids = swapSides({ fromAccountId: before.from?.id ?? '', toAccountId: before.to?.id ?? '' }, side, id);
  const next = { ...draft, fromAccountId: ids.fromAccountId || null, toAccountId: ids.toAccountId || null };
  const after = transferSides(next, ctx);
  const samePair = before.from?.currency === after.from?.currency && before.to?.currency === after.to?.currency;
  return samePair ? next : { ...next, rate: null };
}

/** The fee the field shows: the one the user typed; untouched, that of the last transfer through the draft's via. */
export function transferFee(draft: TransferDraft, ctx: Pick<TransferContext, 'lastFee'>): number {
  return draft.fee ?? ctx.lastFee(viaOf(draft));
}

/** The draft after typing in the rate. Emptying the field (0) returns it to the month rate. */
export function typeTransferRate(draft: TransferDraft, rate: number): TransferDraft {
  return { ...draft, rate: rate > 0 ? rate : null };
}

/** Two different accounts, amount and rate greater than 0. The via does not block: empty, it counts as the default one. */
export function canAddTransfer(draft: TransferDraft, ctx: TransferContext): boolean {
  const { from, to } = transferSides(draft, ctx);
  return from !== null && to !== null && from.id !== to.id && draft.amount > 0 && transferRate(draft, ctx).rate > 0;
}

/** What is sent when adding: date, via, accounts and rate already resolved (the rate, the one shown in the field). null if it cannot be added. */
export function transferInput(draft: TransferDraft, draftDate: ISODate, ctx: TransferContext): TransferInput | null {
  const { from, to } = transferSides(draft, ctx);
  if (!from || !to || !canAddTransfer(draft, ctx)) return null;
  return {
    date: draft.date ?? draftDate,
    via: viaOf(draft),
    fromAccountId: from.id,
    toAccountId: to.id,
    amount: draft.amount,
    rate: transferRate(draft, ctx).rate,
    budget: draft.budget,
    fee: transferFee(draft, ctx),
  };
}

/**
 * Only the amount is cleared: date, via, accounts, rate and checkbox are usually repeated in the next transfer. The via
 * stays as it was saved and the fee goes back to "untouched": it will propose that of the transfer just saved.
 */
export function afterTransferAdded(draft: TransferDraft): TransferDraft {
  return { ...draft, via: viaOf(draft), amount: 0, fee: null };
}

// ── Month rate ───────────────────────────────────────────────────────────────

export type Pair = readonly [from: Currency, to: Currency];

export interface RateDraft {
  /** null = untouched: the first pair of the card that still has no typed rate. */
  pair: Pair | null;
  rate: number;
  /** null = untouched: the date that applies to the pair (rows.ts newRateDate). */
  date: ISODate | null;
}

export const EMPTY_RATE: RateDraft = { pair: null, rate: 0, date: null };

/**
 * The pair the add row proposes: the chosen one or, untouched, the first of those shown whose rate is not
 * typed for this month (it is the one still to be entered); if they all are, the first one.
 */
export function ratePair(draft: RateDraft, shown: readonly PairRate[], main: Currency, second: Currency | null): Pair {
  if (draft.pair) return draft.pair;
  const row = shown.find((r) => r.source !== 'month') ?? shown[0];
  // With no rate needed and no second currency, the first other currency against the main one.
  return row ? [row.from, row.to] : [second ?? CURRENCIES.find((c) => c !== main) ?? main, main];
}

/** Picking a currency of the pair. They have to be different: picking the one on the other side swaps them. */
export function pickRateCurrency(pair: Pair, side: 'from' | 'to', cur: Currency): Pair {
  const [from, to] = pair;
  if (side === 'from') return [cur, cur === to ? from : to];
  return [cur === from ? to : from, cur];
}

/** A rate greater than 0. */
export function canAddRate(draft: RateDraft): boolean {
  return draft.rate > 0;
}

/**
 * The date the new rate will apply from: the chosen one or, untouched, the one that applies to the pair (newRateDate):
 * it changes on its own with the pair as long as the user does not pick one.
 */
export function rateDate(draft: RateDraft, pair: Pair, rates: readonly PairRate[], monthKey: MonthKey, draftDate: ISODate): ISODate {
  return draft.date ?? newRateDate(pair[0], pair[1], rates, monthKey, draftDate);
}
