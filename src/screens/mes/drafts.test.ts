import { describe, expect, it } from 'vitest';
import { defaultAccount, moneyAccounts, rateFor } from '../../../shared/calc';
import { seedState } from '../../../shared/seed';
import type { Account, AppState, Currency, MonthKey } from '../../../shared/types';
import { pairRates } from '../../store';
import {
  afterTransferAdded,
  afterTxAdded,
  canAddFixed,
  canAddRate,
  canAddTransfer,
  canAddTx,
  DEFAULT_VIA,
  draftAccount,
  draftCurrency,
  EMPTY_FIXED,
  EMPTY_RATE,
  fixedInput,
  newTransferDraft,
  newTxDraft,
  pickRateCurrency,
  pickTransferAccount,
  prefillRate,
  rateDate,
  ratePair,
  swapSides,
  transferFee,
  transferInput,
  transferRate,
  transferSides,
  txInput,
  typeTransferRate,
} from './drafts';
import type { DraftContext, FixedDraft, TransferContext, TransferDraft, TxDraft } from './drafts';
import { lastFee } from './rows';

const account = (id: string, currency: Currency, sort: number, hidden = false): Account => ({ id, name: `${id} account`, currency, opening: 0, hidden, sort });

/** The sample data (US account in USD, DR account in DOP; the default is DR) plus the requested accounts. */
function stateWith(...extra: Account[]): AppState {
  const state = seedState();
  state.accounts.push(...extra);
  return state;
}

const context = (state: AppState): DraftContext => ({ accounts: state.accounts, defaultAccount: defaultAccount(state), main: state.mainCurrency });

const transferContext = (state: AppState, key: MonthKey = '2026-10'): TransferContext => ({
  accounts: state.accounts,
  visible: moneyAccounts(state),
  defaultAccount: defaultAccount(state),
  rateOf: (from, to) => rateFor(state, key, from, to).rate,
  lastFee: (via) => lastFee(state.months, key, via),
});

describe('account and currency of a new expense', () => {
  const state = stateWith(account('tr', 'TRY', 2), account('old', 'USD', 3, true));
  const ctx = context(state);

  it('untouched: the default account and its currency', () => {
    expect(draftAccount(EMPTY_FIXED, ctx)?.id).toBe('dr');
    expect(draftCurrency(EMPTY_FIXED, ctx)).toBe('DOP');
  });

  it('the currency follows the chosen account until the user picks another currency', () => {
    const inLira: FixedDraft = { ...EMPTY_FIXED, accountId: 'tr' };
    expect(draftAccount(inLira, ctx)?.id).toBe('tr');
    expect(draftCurrency(inLira, ctx)).toBe('TRY');
    expect(draftCurrency({ ...inLira, accountId: 'us' }, ctx)).toBe('USD');
    // Picked by hand, it no longer follows the account.
    expect(draftCurrency({ ...inLira, cur: 'USD' }, ctx)).toBe('USD');
    expect(draftCurrency({ ...EMPTY_FIXED, cur: 'TRY' }, ctx)).toBe('TRY');
  });

  it('the default account is the one the user has at that moment: if it changes, the untouched draft follows it', () => {
    const other = { ...state, defaultAccountId: 'us' };
    expect(draftAccount(EMPTY_FIXED, context(other))?.id).toBe('us');
    expect(draftCurrency(EMPTY_FIXED, context(other))).toBe('USD');
  });

  it('a chosen account that was hidden later is kept; one that no longer exists falls back to the default one', () => {
    expect(draftAccount({ accountId: 'old' }, ctx)?.id).toBe('old');
    expect(draftAccount({ accountId: 'gone' }, ctx)?.id).toBe('dr');
  });

  it('with no accounts: there is no account and the currency is the main one', () => {
    const empty: DraftContext = { accounts: [], defaultAccount: null, main: 'TRY' };
    expect(draftAccount(EMPTY_FIXED, empty)).toBeNull();
    expect(draftCurrency(EMPTY_FIXED, empty)).toBe('TRY');
  });
});

describe('fixed expense', () => {
  const ctx = context(stateWith(account('tr', 'TRY', 2)));
  const named = (over: Partial<FixedDraft>): FixedDraft => ({ ...EMPTY_FIXED, name: 'Spotify', amount: 350, ...over });

  it('the empty draft: no item, no day, no amount, and with the currency and the account untouched', () => {
    expect(EMPTY_FIXED).toEqual({ name: '', day: '', amount: 0, cur: null, accountId: null, onCard: false, cardId: null });
  });

  it('"Pay with" credit card: what is added is marked onCard; with an account, the same as always', () => {
    expect(fixedInput(named({ onCard: true }), ctx)).toMatchObject({ onCard: true });
    expect('onCard' in fixedInput(named({}), ctx)).toBe(false);
  });

  it('needs an item and an amount greater than 0', () => {
    expect(canAddFixed(named({}))).toBe(true);
    expect(canAddFixed(named({ day: '12', amount: 5.99, cur: 'USD' }))).toBe(true);
    expect(canAddFixed(EMPTY_FIXED)).toBe(false);
    expect(canAddFixed(named({ name: '' }))).toBe(false);
    expect(canAddFixed(named({ name: '   ' }))).toBe(false);
    expect(canAddFixed(named({ amount: 0 }))).toBe(false);
    expect(canAddFixed(named({ amount: -5 }))).toBe(false);
    expect(canAddFixed(named({ amount: Number.NaN }))).toBe(false);
  });

  it('what is sent carries the currency and the account already resolved', () => {
    expect(fixedInput(named({}), ctx)).toEqual({ name: 'Spotify', day: '', amount: 350, cur: 'DOP', accountId: 'dr' });
    expect(fixedInput(named({ accountId: 'tr' }), ctx)).toEqual({ name: 'Spotify', day: '', amount: 350, cur: 'TRY', accountId: 'tr' });
    expect(fixedInput(named({ accountId: 'us', cur: 'TRY', day: '5' }), ctx)).toEqual({ name: 'Spotify', day: '5', amount: 350, cur: 'TRY', accountId: 'us' });
  });

  it('with no accounts none is sent (the data layer rejects it)', () => {
    expect(fixedInput(named({}), { accounts: [], defaultAccount: null, main: 'DOP' })).toEqual({ name: 'Spotify', day: '', amount: 350, cur: 'DOP' });
  });
});

describe('transaction', () => {
  const ctx = context(stateWith(account('tr', 'TRY', 2)));
  const filled: TxDraft = {
    date: '2026-10-05',
    desc: 'Cena',
    place: 'Lulú',
    cat: 'Travel',
    method: 'Transfer',
    amount: 3150,
    cur: 'USD',
    accountId: 'us',
    notes: 'Con propina',
    cardId: null,
  };

  it('starts with Food / Card (the canonical names, which are the ones stored), with no date, currency or account of its own', () => {
    expect(newTxDraft()).toEqual({ date: null, desc: '', place: '', cat: 'Food', method: 'Debit card', amount: 0, cur: null, accountId: null, notes: '', cardId: null });
  });

  it('needs a description and an amount greater than 0; place and notes are optional', () => {
    expect(canAddTx(filled)).toBe(true);
    expect(canAddTx({ ...newTxDraft(), desc: 'Café', amount: 385 })).toBe(true);
    expect(canAddTx(newTxDraft())).toBe(false);
    expect(canAddTx({ ...filled, desc: '' })).toBe(false);
    expect(canAddTx({ ...filled, desc: '  ' })).toBe(false);
    expect(canAddTx({ ...filled, amount: 0 })).toBe(false);
    expect(canAddTx({ ...filled, amount: -1 })).toBe(false);
    expect(canAddTx({ ...filled, amount: Number.NaN })).toBe(false);
  });

  it('with no date of its own it uses the one from the shell; with its own date, that one', () => {
    expect(txInput({ ...filled, date: null }, '2026-10-07', ctx).date).toBe('2026-10-07');
    expect(txInput(filled, '2026-10-07', ctx).date).toBe('2026-10-05');
    // The draft with no credit card (`cardId: null`) sends none; with a credit method and a chosen credit card, it sends it.
    const { cardId: _none, ...sent } = filled;
    expect(txInput(filled, '2026-10-07', ctx)).toEqual(sent);
    expect(txInput({ ...filled, method: 'Credit card', cardId: 'b' }, '2026-10-07', ctx)).toMatchObject({ method: 'Credit card', cardId: 'b' });
    expect(txInput({ ...filled, cardId: 'b' }, '2026-10-07', ctx)).not.toHaveProperty('cardId');
  });

  it('untouched, it comes out of the default account and in its currency; when another account is picked, in the currency of that one', () => {
    const coffee = { ...newTxDraft(), desc: 'Café', amount: 385 };
    expect(txInput(coffee, '2026-10-07', ctx)).toMatchObject({ cur: 'DOP', accountId: 'dr' });
    expect(txInput({ ...coffee, accountId: 'tr' }, '2026-10-07', ctx)).toMatchObject({ cur: 'TRY', accountId: 'tr' });
    // The currency picked by hand wins over the account's.
    expect(txInput({ ...coffee, accountId: 'tr', cur: 'USD' }, '2026-10-07', ctx)).toMatchObject({ cur: 'USD', accountId: 'tr' });
  });

  it('after adding, description, place, amount and notes are cleared; the rest stays', () => {
    expect(afterTxAdded(filled)).toEqual({
      date: '2026-10-05',
      desc: '',
      place: '',
      cat: 'Travel',
      method: 'Transfer',
      amount: 0,
      cur: 'USD',
      accountId: 'us',
      notes: '',
      cardId: null,
    });
    // What was untouched stays untouched: tomorrow the date will be tomorrow's, and the account, the default one.
    expect(afterTxAdded({ ...filled, date: null, cur: null, accountId: null })).toMatchObject({ date: null, cur: null, accountId: null });
    expect(filled.desc).toBe('Cena');
  });
});

describe('transfer: the two accounts', () => {
  it('untouched: it arrives at the default account from another visible account', () => {
    const ctx = transferContext(seedState());
    const sides = transferSides(newTransferDraft(), ctx);
    expect([sides.from?.id, sides.to?.id]).toEqual(['us', 'dr']);
  });

  it('the origin account is one in a different currency than the destination account, if there is one', () => {
    // The first visible one that is not the destination is in the same currency: the US account is preferred.
    const state = stateWith(account('cash', 'DOP', -1));
    const sides = transferSides(newTransferDraft(), transferContext(state));
    expect([sides.from?.id, sides.to?.id]).toEqual(['us', 'dr']);
    // If they are all in the same currency, the first one.
    const pesos = seedState();
    pesos.accounts = [account('a', 'DOP', 0), account('b', 'DOP', 1), account('c', 'DOP', 2)];
    pesos.defaultAccountId = 'b';
    const same = transferSides(newTransferDraft(), transferContext(pesos));
    expect([same.from?.id, same.to?.id]).toEqual(['a', 'b']);
  });

  it('they are never the same: if the chosen origin is the default account, the destination is another one', () => {
    const ctx = transferContext(seedState());
    const sides = transferSides({ fromAccountId: 'dr', toAccountId: null }, ctx);
    expect([sides.from?.id, sides.to?.id]).toEqual(['dr', 'us']);
    // An inconsistent draft (the same one on both sides) is resolved the same way.
    const both = transferSides({ fromAccountId: 'dr', toAccountId: 'dr' }, ctx);
    expect([both.from?.id, both.to?.id]).toEqual(['dr', 'us']);
  });

  it('does not offer a hidden account on its own, but keeps the one that was chosen', () => {
    const state = stateWith(account('old', 'TRY', -5, true));
    const ctx = transferContext(state);
    expect(transferSides(newTransferDraft(), ctx).from?.id).toBe('us');
    expect(transferSides({ fromAccountId: 'old', toAccountId: null }, ctx).from?.id).toBe('old');
  });

  it('with a single account one side is missing, and with no accounts both are', () => {
    const one = seedState();
    one.accounts = [account('dr', 'DOP', 0)];
    const sides = transferSides(newTransferDraft(), transferContext(one));
    expect([sides.from, sides.to?.id]).toEqual([null, 'dr']);
    expect(canAddTransfer({ ...newTransferDraft(), amount: 500, rate: 1 }, transferContext(one))).toBe(false);

    one.accounts = [];
    expect(transferSides(newTransferDraft(), transferContext(one))).toEqual({ from: null, to: null });
  });

  it('swapSides: picking the account on the other side reverses the transfer', () => {
    const row = { fromAccountId: 'us', toAccountId: 'dr' };
    expect(swapSides(row, 'from', 'dr')).toEqual({ fromAccountId: 'dr', toAccountId: 'us' });
    expect(swapSides(row, 'to', 'us')).toEqual({ fromAccountId: 'dr', toAccountId: 'us' });
    // Another account only changes its side; the same one changes nothing.
    expect(swapSides(row, 'from', 'tr')).toEqual({ fromAccountId: 'tr', toAccountId: 'dr' });
    expect(swapSides(row, 'to', 'tr')).toEqual({ fromAccountId: 'us', toAccountId: 'tr' });
    expect(swapSides(row, 'from', 'us')).toEqual(row);
    expect(swapSides(row, 'to', 'dr')).toEqual(row);
  });
});

describe('transfer: the proposed rate', () => {
  it('prefillRate: two decimals; four significant figures below 1', () => {
    expect(prefillRate(58.76)).toBe(58.76);
    // Weighted average of September in the sample data.
    expect(prefillRate(134721 / 2300)).toBe(58.57);
    expect(prefillRate(58.184444)).toBe(58.18);
    expect(prefillRate(1)).toBe(1);
    expect(prefillRate(1 / 58.76)).toBe(0.01702);
    expect(prefillRate(0.714285)).toBe(0.7143);
    expect(prefillRate(0)).toBe(0);
    expect(prefillRate(-3)).toBe(0);
    expect(prefillRate(Number.NaN)).toBe(0);
  });

  it('untouched it is the month rate for the currencies of the two accounts', () => {
    const state = seedState();
    expect(transferRate(newTransferDraft(), transferContext(state))).toEqual({ rate: 58.76, locked: false });
    // September has no typed rate: the average of its transfers, to two decimals.
    expect(transferRate(newTransferDraft(), transferContext(state, '2026-09'))).toEqual({ rate: 58.57, locked: false });
  });

  it('with several typed rates in the month, it proposes the one in effect on the transfer date', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
    ];
    // The way the card builds its context: the pair's rate on the draft's date.
    const on = (date: string): TransferContext => ({ ...transferContext(state), rateOf: (from, to) => rateFor(state, '2026-10', from, to, date).rate });
    expect(transferRate(newTransferDraft(), on('2026-10-04'))).toEqual({ rate: 58, locked: false });
    expect(transferRate(newTransferDraft(), on('2026-10-05'))).toEqual({ rate: 60, locked: false });
    expect(transferInput({ ...newTransferDraft(), amount: 100 }, '2026-10-04', on('2026-10-04'))).toMatchObject({ date: '2026-10-04', rate: 58 });
    // With no date, the last one of the month.
    expect(transferRate(newTransferDraft(), transferContext(state)).rate).toBe(60);
  });

  it('follows the accounts as long as the user does not type their own', () => {
    const state = stateWith(account('tr', 'TRY', 2));
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 41.5, date: '2026-10-01' });
    const ctx = transferContext(state);
    let draft = newTransferDraft();
    expect(transferRate(draft, ctx).rate).toBe(58.76);
    draft = pickTransferAccount(draft, ctx, 'to', 'tr');
    expect(draft).toMatchObject({ fromAccountId: 'us', toAccountId: 'tr', rate: null });
    expect(transferRate(draft, ctx)).toEqual({ rate: 41.5, locked: false });
    // Reversed: DR → US, the inverse of the typed one.
    draft = pickTransferAccount(newTransferDraft(), ctx, 'from', 'dr');
    expect(draft).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us' });
    expect(transferRate(draft, ctx)).toEqual({ rate: 0.01702, locked: false });
  });

  it('between accounts of the same currency it is 1 and is not typed', () => {
    const state = stateWith(account('paypal', 'USD', 2));
    const ctx = transferContext(state);
    const draft = pickTransferAccount(newTransferDraft(), ctx, 'to', 'paypal');
    expect(transferRate(draft, ctx)).toEqual({ rate: 1, locked: true });
    // Even if a typed rate were left in the draft.
    expect(transferRate({ ...draft, rate: 58.9 }, ctx)).toEqual({ rate: 1, locked: true });
    expect(transferInput({ ...draft, amount: 200 }, '2026-10-07', ctx)).toMatchObject({ fromAccountId: 'us', toAccountId: 'paypal', rate: 1 });
  });

  it('the rate typed by the user is kept, also after adding', () => {
    const ctx = transferContext(seedState());
    const typed = typeTransferRate(newTransferDraft(), 58.9);
    expect(typed.rate).toBe(58.9);
    expect(transferRate(typed, ctx)).toEqual({ rate: 58.9, locked: false });
    expect(transferRate(afterTransferAdded({ ...typed, amount: 500 }), ctx).rate).toBe(58.9);
  });

  it('changing the account without changing the currencies keeps the typed rate', () => {
    const state = stateWith(account('paypal', 'USD', 2));
    const ctx = transferContext(state);
    const typed = typeTransferRate(newTransferDraft(), 58.9);
    const moved = pickTransferAccount(typed, ctx, 'from', 'paypal');
    expect(moved).toMatchObject({ fromAccountId: 'paypal', toAccountId: 'dr', rate: 58.9 });
  });

  it('if the currencies (or the direction) change, the typed rate belonged to another pair: it goes back to following the month rate', () => {
    const state = stateWith(account('tr', 'TRY', 2));
    const ctx = transferContext(state);
    const typed = typeTransferRate(newTransferDraft(), 58.9);
    expect(pickTransferAccount(typed, ctx, 'to', 'tr').rate).toBeNull();
    const reversed = pickTransferAccount(typed, ctx, 'from', 'dr');
    expect(reversed).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us', rate: null });
    expect(transferRate(reversed, ctx).rate).toBe(0.01702);
  });

  it('clearing the rate field (0) returns it to the month rate', () => {
    const ctx = transferContext(seedState());
    const cleared = typeTransferRate(typeTransferRate(newTransferDraft(), 58.9), 0);
    expect(cleared.rate).toBeNull();
    expect(transferRate(cleared, ctx).rate).toBe(58.76);
    expect(typeTransferRate(newTransferDraft(), Number.NaN).rate).toBeNull();
  });
});

describe('transfer: adding', () => {
  const ctx = transferContext(seedState());
  const filled: TransferDraft = { date: '2026-10-02', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 500, rate: 58.9, budget: false, fee: 0 };

  it('starts with Remitly, with no amount, with accounts, rate and fee untouched and with "Moves budget" checked', () => {
    expect(DEFAULT_VIA).toBe('Remitly');
    expect(newTransferDraft()).toEqual({ date: null, via: 'Remitly', fromAccountId: null, toAccountId: null, amount: 0, rate: null, budget: true, fee: null });
  });

  it('needs an amount and a rate greater than 0 and two accounts', () => {
    expect(canAddTransfer(filled, ctx)).toBe(true);
    expect(canAddTransfer({ ...newTransferDraft(), amount: 500 }, ctx)).toBe(true);
    expect(canAddTransfer(newTransferDraft(), ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, amount: 0 }, ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, amount: -100 }, ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, amount: Number.NaN }, ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, rate: 0 }, ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, rate: Number.NaN }, ctx)).toBe(false);
    expect(transferInput({ ...filled, amount: 0 }, '2026-11-01', ctx)).toBeNull();
  });

  it('what is sent: date, via, accounts and rate already resolved (the rate, the one shown in the field), and the checkbox as it is', () => {
    expect(transferInput(filled, '2026-11-01', ctx)).toEqual({
      date: '2026-10-02',
      via: 'PayPal',
      fromAccountId: 'us',
      toAccountId: 'dr',
      amount: 500,
      rate: 58.9,
      budget: false,
      fee: 0,
    });
    expect(transferInput({ ...newTransferDraft(), amount: 500 }, '2026-11-01', ctx)).toEqual({
      date: '2026-11-01',
      via: 'Remitly',
      fromAccountId: 'us',
      toAccountId: 'dr',
      amount: 500,
      rate: 58.76,
      budget: true,
      fee: 0,
    });
  });

  it('the via is free text: whatever is typed is sent, with no extra spaces', () => {
    expect(transferInput({ ...filled, via: 'Western Union' }, '2026-11-01', ctx)?.via).toBe('Western Union');
    expect(transferInput({ ...filled, via: '  Banco Popular ' }, '2026-11-01', ctx)?.via).toBe('Banco Popular');
    expect(transferInput({ ...filled, via: 'paypal' }, '2026-11-01', ctx)?.via).toBe('paypal');
  });

  it('an empty via does not block the transfer: the default one is sent', () => {
    for (const via of ['', '   ']) {
      expect(canAddTransfer({ ...filled, via }, ctx)).toBe(true);
      expect(transferInput({ ...filled, via }, '2026-11-01', ctx)?.via).toBe('Remitly');
    }
  });

  it('the fee: untouched, the one of the last transfer through that via (and it follows it if the via changes); typed, the typed one', () => {
    const state = seedState();
    // Remitly charged 2.99 on its last September transfer and 3.49 in October; PayPal, nothing.
    state.months['2026-09']!.transfers.at(-1)!.fee = 2.99;
    state.months['2026-10']!.transfers[0]!.fee = 3.49;
    const withFees = transferContext(state);
    expect(transferFee(newTransferDraft(), withFees)).toBe(3.49);
    expect(transferFee({ ...newTransferDraft(), via: ' remitly ' }, withFees)).toBe(3.49);
    expect(transferFee({ ...newTransferDraft(), via: 'PayPal' }, withFees)).toBe(0);
    expect(transferFee({ ...newTransferDraft(), via: 'Wise' }, withFees)).toBe(0);
    // Looking at September, what belongs to October does not exist yet.
    expect(transferFee(newTransferDraft(), transferContext(state, '2026-09'))).toBe(2.99);
    // A typed one (0 too) wins.
    expect(transferFee({ ...newTransferDraft(), fee: 0 }, withFees)).toBe(0);
    expect(transferFee({ ...newTransferDraft(), fee: 1.5 }, withFees)).toBe(1.5);
    expect(transferInput({ ...newTransferDraft(), amount: 500 }, '2026-10-07', withFees)?.fee).toBe(3.49);
  });

  it('after adding only the amount is cleared (and the fee goes back to following the via)', () => {
    expect(afterTransferAdded(filled)).toEqual({ ...filled, amount: 0, fee: null });
    expect(afterTransferAdded({ ...filled, via: 'Western Union' }).via).toBe('Western Union');
    expect(afterTransferAdded({ ...newTransferDraft(), amount: 500 })).toEqual(newTransferDraft());
    expect(filled.amount).toBe(500);
  });

  it('after adding, the via stays as it was saved: without the spaces, or the default one if it was empty', () => {
    expect(afterTransferAdded({ ...filled, via: ' Wise ' }).via).toBe('Wise');
    expect(afterTransferAdded({ ...filled, via: '' }).via).toBe('Remitly');
    expect(afterTransferAdded({ ...filled, via: '  ' }).via).toBe('Remitly');
  });
});

describe('month rate: the add row', () => {
  it('untouched it proposes the first pair that has no typed rate yet', () => {
    const state = seedState();
    // October has USD → DOP typed; the other two come from the default value.
    const october = pairRates(state, '2026-10');
    expect(ratePair(EMPTY_RATE, october, 'DOP', 'USD')).toEqual(['TRY', 'DOP']);
    // September has none typed: the pair of the top bar.
    expect(ratePair(EMPTY_RATE, pairRates(state, '2026-09'), 'DOP', 'USD')).toEqual(['USD', 'DOP']);
  });

  it('if all are typed, the first one; with no rows, second → main', () => {
    const state = seedState();
    const only = pairRates(state, '2026-10').slice(0, 1);
    expect(ratePair(EMPTY_RATE, only, 'DOP', 'USD')).toEqual(['USD', 'DOP']);
    expect(ratePair(EMPTY_RATE, [], 'TRY', 'USD')).toEqual(['USD', 'TRY']);
  });

  it('the chosen pair wins', () => {
    expect(ratePair({ pair: ['TRY', 'DOP'], rate: 0, date: null }, pairRates(seedState(), '2026-10'), 'DOP', 'USD')).toEqual(['TRY', 'DOP']);
  });

  it('the two currencies are different: picking the one on the other side reverses the pair', () => {
    expect(pickRateCurrency(['USD', 'DOP'], 'from', 'TRY')).toEqual(['TRY', 'DOP']);
    expect(pickRateCurrency(['USD', 'DOP'], 'to', 'TRY')).toEqual(['USD', 'TRY']);
    expect(pickRateCurrency(['USD', 'DOP'], 'from', 'DOP')).toEqual(['DOP', 'USD']);
    expect(pickRateCurrency(['USD', 'DOP'], 'to', 'USD')).toEqual(['DOP', 'USD']);
    expect(pickRateCurrency(['USD', 'DOP'], 'from', 'USD')).toEqual(['USD', 'DOP']);
  });

  it('the empty draft carries no pair, rate or date', () => {
    expect(EMPTY_RATE).toEqual({ pair: null, rate: 0, date: null });
  });

  it('the untouched date: today if the pair already has a typed rate in effect and the month is the current one', () => {
    const rates = pairRates(seedState(), '2026-10');
    expect(rateDate(EMPTY_RATE, ['USD', 'DOP'], rates, '2026-10', '2026-10-07')).toBe('2026-10-07');
    // The reversed pair is the same pair.
    expect(rateDate(EMPTY_RATE, ['DOP', 'USD'], rates, '2026-10', '2026-10-07')).toBe('2026-10-07');
  });

  it('the untouched date: the first day of the month if the selected month is not the current one', () => {
    const rates = pairRates(seedState(), '2026-10');
    // draftDate is already day 1 when today does not fall in the selected month (buildFinanzas).
    expect(rateDate(EMPTY_RATE, ['USD', 'DOP'], rates, '2026-10', '2026-10-01')).toBe('2026-10-01');
  });

  it('the untouched date: the first day of the month if the pair has no typed rate, even if today is another day', () => {
    const state = seedState();
    const rates = pairRates(state, '2026-10');
    expect(rateDate(EMPTY_RATE, ['TRY', 'DOP'], rates, '2026-10', '2026-10-07')).toBe('2026-10-01');
    expect(rateDate(EMPTY_RATE, ['USD', 'TRY'], rates, '2026-10', '2026-10-07')).toBe('2026-10-01');
    // September gets its rate from the transfers: there is no typed one either.
    expect(rateDate(EMPTY_RATE, ['USD', 'DOP'], pairRates(state, '2026-09'), '2026-09', '2026-09-20')).toBe('2026-09-01');
  });

  it('the date follows the pair as long as none is chosen; the chosen one wins', () => {
    const rates = pairRates(seedState(), '2026-10');
    const pairs = [ratePair(EMPTY_RATE, rates, 'DOP', 'USD'), pickRateCurrency(['TRY', 'DOP'], 'from', 'USD')];
    expect(pairs).toEqual([
      ['TRY', 'DOP'],
      ['USD', 'DOP'],
    ]);
    expect(pairs.map((pair) => rateDate(EMPTY_RATE, pair, rates, '2026-10', '2026-10-07'))).toEqual(['2026-10-01', '2026-10-07']);
    const chosen = { ...EMPTY_RATE, date: '2026-10-03' };
    expect(pairs.map((pair) => rateDate(chosen, pair, rates, '2026-10', '2026-10-07'))).toEqual(['2026-10-03', '2026-10-03']);
  });

  it('needs a rate greater than 0', () => {
    expect(canAddRate({ pair: null, rate: 58.76, date: null })).toBe(true);
    expect(canAddRate({ pair: ['USD', 'TRY'], rate: 0.024, date: '2026-10-03' })).toBe(true);
    expect(canAddRate(EMPTY_RATE)).toBe(false);
    expect(canAddRate({ pair: null, rate: -1, date: null })).toBe(false);
    expect(canAddRate({ pair: null, rate: Number.NaN, date: null })).toBe(false);
  });
});
