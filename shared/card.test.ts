// Credit card as a deferred payment (here with ONE credit card, the 'card' from migration 0011; with several: cards.test.ts): the total (previous balance + other charges + what was charged), what it carries over from
// one month to the next and which figures each thing moves. What is charged does not touch balances or "used": only the payment does.

import { describe, expect, it } from 'vitest';
import { balances, cardAccountFor, cardCalc, monthCalc } from './calc';
import { seedState } from './seed';
import type { AppState, CardPayment, CreditCard, FixedExpense, MonthCard, Transaction } from './types';

/** The usual single credit card, in the main currency. */
const CARD: CreditCard = { id: 'card', name: 'Credit card', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
const seed = (): AppState => ({ ...seedState(), cards: [CARD] });

const AUG = '2026-08';
const SEP = '2026-09';
const OCT = '2026-10';

const fx = (over: Partial<FixedExpense>): FixedExpense => ({
  id: 'fx',
  monthKey: OCT,
  name: 'Gym',
  day: '',
  amount: 100,
  cur: 'DOP',
  paid: true,
  accountId: 'dr',
  sort: 99,
  onCard: true,
  ...over,
});

const tx = (over: Partial<Transaction>): Transaction => ({
  id: 'tx',
  monthKey: OCT,
  date: '2026-10-07',
  desc: 'Taxi',
  place: '',
  cat: 'Transport',
  method: 'Credit card',
  amount: 100,
  cur: 'DOP',
  accountId: 'dr',
  notes: '',
  source: 'web',
  createdAt: null,
  ...over,
});

/** The sample state with changes in October: the month's credit card and whatever is charged to it. */
function october(card: MonthCard | undefined, extra: { fixed?: FixedExpense[]; tx?: Transaction[] } = {}): AppState {
  const s = seed();
  const m = s.months[OCT]!;
  s.months[OCT] = { ...m, fixed: [...m.fixed, ...(extra.fixed ?? [])], tx: [...m.tx, ...(extra.tx ?? [])], ...(card && { cards: [card] }) };
  return s;
}

let seq = 0;
const pay = (amount: number, accountId: string): CardPayment => ({ id: `p${++seq}`, date: '2026-10-20', accountId, amount });
const none: MonthCard = { cardId: 'card', other: 0, payments: [] };
const bal = (s: AppState, id: string) => balances(s, OCT).accounts.find((a) => a.account.id === id)!.balance;

describe('the credit card total', () => {
  it('with nothing charged it is 0 in every month and changes no figure', () => {
    const s = seed();
    for (const key of [AUG, SEP, OCT]) expect(cardCalc(s, key, 'card')).toMatchObject({ previous: 0, other: 0, charged: 0, total: 0, paid: 0, remainder: 0 });
    const c = monthCalc(s, OCT);
    expect(c.pending).toBeCloseTo(c.fixedAll - c.fixedPaid, 9);
  });

  it('adds previous balance + other charges + checked fixed expenses + credit card transactions, converted to the main currency', () => {
    const s = october(
      { cardId: 'card', other: 300, payments: [] },
      {
        fixed: [
          fx({ id: 'a', amount: 1000 }),
          fx({ id: 'b', amount: 10, cur: 'USD' }), // 10 × 58.76 = 587.6 at the month rate
          fx({ id: 'c', amount: 500, paid: false }), // unchecked: pending, not charged
          fx({ id: 'd', amount: 70, onCard: false }), // paid from an account: not on the credit card
        ],
        tx: [
          tx({ id: 't1', amount: 200 }),
          tx({ id: 't2', amount: 5, cur: 'USD' }), // 5 × 58.76 = 293.8 at the rate of its date
          tx({ id: 't3', amount: 50, method: 'Debit card' }), // debit: not on the credit card
        ],
      },
    );
    // September: 1,000 in other charges, paid 400; August: 250 unpaid and untouched. 250 + 1,000 − 400 = 850.
    s.months[AUG] = { ...s.months[AUG]!, cards: [{ cardId: 'card', other: 250, payments: [] }] };
    s.months[SEP] = { ...s.months[SEP]!, cards: [{ cardId: 'card', other: 1000, payments: [pay(400, 'dr')] }] };
    expect(cardCalc(s, AUG, 'card')).toMatchObject({ total: 250, remainder: 250 });
    expect(cardCalc(s, SEP, 'card')).toMatchObject({ previous: 250, total: 1250, paid: 400, remainder: 850 });
    const c = cardCalc(s, OCT, 'card');
    expect(c.previous).toBe(850);
    expect(c.other).toBe(300);
    expect(c.charged).toBeCloseTo(1000 + 587.6 + 200 + 293.8, 6);
    expect(c.total).toBeCloseTo(850 + 300 + 1000 + 587.6 + 200 + 293.8, 6);
  });

  it('an unpaid month carries over its whole total, also across several months', () => {
    const s = seed();
    s.months[AUG] = { ...s.months[AUG]!, cards: [{ cardId: 'card', other: 100, payments: [] }] };
    expect(cardCalc(s, SEP, 'card').previous).toBe(100);
    expect(cardCalc(s, OCT, 'card').previous).toBe(100);
    expect(cardCalc(s, OCT, 'card').total).toBe(100);
  });
});

describe('what it moves in the month', () => {
  const base = seed();
  const b = monthCalc(base, OCT);
  const items = {
    fixed: [fx({ id: 'a', amount: 1000 }), fx({ id: 'c', amount: 500, paid: false })],
    tx: [tx({ id: 't1', amount: 200 })],
  };

  it('unpaid: what is charged is not used and the credit card counts as pending for its total', () => {
    const s = october(none, items);
    const c = monthCalc(s, OCT);
    expect(c.cards[0]!.total).toBe(1200);
    expect(c.used).toBeCloseTo(b.used, 9);
    expect(c.avail).toBeCloseTo(b.avail, 9);
    // The unchecked 500 expense is still pending and the credit card adds its 1,200.
    expect(c.pending).toBeCloseTo(b.pending + 500 + 1200, 9);
    expect(c.after).toBeCloseTo(b.after - 500 - 1200, 9);
    // The credit card transaction is not in the budget's transaction total, but it is in the category.
    expect(c.varSpent).toBeCloseTo(b.varSpent, 9);
    expect(c.categories.find((x) => x.name === 'Transport')!.value).toBeCloseTo(monthCalc(base, OCT).categories.find((x) => x.name === 'Transport')!.value + 200, 9);
  });

  it('partial payment: it goes into used and what is left of the credit card stays pending this month', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(700, 'dr')] }, items);
    const c = monthCalc(s, OCT);
    expect(c.used).toBeCloseTo(b.used + 700, 9);
    // 500 from the unchecked expense + 500 left on the credit card.
    expect(c.pending).toBeCloseTo(b.pending + 500 + 500, 9);
    expect(c.cards[0]!.remainder).toBe(500);
    expect(c.fixedPaid).toBeCloseTo(b.fixedPaid + 700, 9);
    // Fixed expenses in the breakdown: what is charged counts as a fixed expense, the credit card payment is not counted again.
    const fixedCat = (x: typeof c) => x.categories.find((k) => k.fixed)!.value;
    expect(fixedCat(c)).toBeCloseTo(fixedCat(b) + 1000, 9);
  });

  it('paying the total leaves the credit card at 0 for the next month', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(1200, 'dr')] }, items);
    expect(cardCalc(s, OCT, 'card').remainder).toBe(0);
    expect(monthCalc(s, OCT).used).toBeCloseTo(b.used + 1200, 9);
  });
});

describe('account balances', () => {
  const items = { fixed: [fx({ id: 'a', amount: 1000 })], tx: [tx({ id: 't1', amount: 200 }), tx({ id: 't2', amount: 5, cur: 'USD' })] };

  it('what is charged lowers no balance; only the payment does, in the currency of the paying account', () => {
    const base = seed();
    const charged = october(none, items);
    expect(bal(charged, 'dr')).toBe(bal(base, 'dr'));
    expect(bal(charged, 'us')).toBe(bal(base, 'us'));

    const total = cardCalc(charged, OCT, 'card').total; // 1,000 + 200 + 293.8
    const fromDr = october({ cardId: 'card', other: 0, payments: [pay(600, 'dr')] }, items);
    expect(bal(fromDr, 'dr')).toBeCloseTo(bal(base, 'dr') - 600, 9);
    expect(bal(fromDr, 'us')).toBe(bal(base, 'us'));
    // From the USD account: 600 DOP at the month rate.
    const fromUs = october({ cardId: 'card', other: 0, payments: [pay(total, 'us')] }, items);
    expect(bal(fromUs, 'us')).toBeCloseTo(bal(base, 'us') - total / 58.76, 9);
    expect(bal(fromUs, 'dr')).toBe(bal(base, 'dr'));
  });

  it('a payment from an earlier month keeps subtracting from later balances', () => {
    const s = seed();
    s.months[SEP] = { ...s.months[SEP]!, cards: [{ cardId: 'card', other: 300, payments: [pay(300, 'dr')] }] };
    expect(bal(s, 'dr')).toBeCloseTo(bal(seed(), 'dr') - 300, 9);
  });
});

describe('account offered for paying', () => {
  it('the one from the last credit card payment if it is still visible; otherwise, the default account', () => {
    const s = seed();
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('dr');
    s.months[SEP] = { ...s.months[SEP]!, cards: [{ cardId: 'card', other: 10, payments: [pay(10, 'us')] }] };
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('us');
    s.accounts = s.accounts.map((a) => (a.id === 'us' ? { ...a, hidden: true } : a));
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('dr');
  });
});

describe('several payments in the same month', () => {
  const items = { fixed: [fx({ id: 'a', amount: 1000 })], tx: [tx({ id: 't1', amount: 200 })] };
  const base = seed();
  const b = monthCalc(base, OCT);

  it('the sum of the payments is what was paid; what is left stays pending and what was paid goes into used', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(300, 'dr'), pay(400, 'us')] }, items);
    const k = cardCalc(s, OCT, 'card');
    expect(k).toMatchObject({ total: 1200, paid: 700, remainder: 500 });
    const c = monthCalc(s, OCT);
    expect(c.used).toBeCloseTo(b.used + 700, 9);
    // An honest "Available after pending": the credit card stays pending for what is left.
    expect(c.pending).toBeCloseTo(b.pending + 500, 9);
    expect(c.after).toBeCloseTo(b.after - 700 - 500, 9);
  });

  it('each payment lowers the balance of its account, converted to the currency of that account', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(300, 'dr'), pay(587.6, 'us')] }, items);
    expect(bal(s, 'dr')).toBeCloseTo(bal(base, 'dr') - 300, 9);
    expect(bal(s, 'us')).toBeCloseTo(bal(base, 'us') - 587.6 / 58.76, 9);
  });

  it('what is left carries over to the next month, derived, and with everything paid nothing carries over', () => {
    const open = october({ cardId: 'card', other: 0, payments: [pay(300, 'dr'), pay(400, 'us')] }, items);
    const nov = '2026-11';
    open.months[nov] = { ...open.months[OCT]!, key: nov, fixed: [], tx: [], cards: undefined };
    delete open.months[nov]!.cards;
    expect(cardCalc(open, nov, 'card')).toMatchObject({ previous: 500, total: 500, remainder: 500 });
    const full = october({ cardId: 'card', other: 0, payments: [pay(300, 'dr'), pay(900, 'us')] }, items);
    full.months[nov] = { ...open.months[nov]! };
    expect(cardCalc(full, nov, 'card').previous).toBe(0);
    expect(monthCalc(full, OCT).pending).toBeCloseTo(b.pending, 9);
  });

  it('the account offered is the one from the last payment of the month', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(10, 'us'), pay(10, 'dr')] }, items);
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('dr');
    s.months[OCT] = { ...s.months[OCT]!, cards: [{ cardId: 'card', other: 0, payments: [pay(10, 'dr'), pay(10, 'us')] }] };
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('us');
  });
});
