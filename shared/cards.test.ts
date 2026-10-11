// Several credit cards: the per-card calculation (with its currency and its carried-over balance), only the ones that
// are on add up, the "pay to get under 10 %" notice and when a credit card can be turned off.

import { describe, expect, it } from 'vitest';
import { activeCards, balances, cardCalc, cardCalcs, cardHint, cardOffBlocked, cardUtilization, defaultCardId, monthCalc } from './calc';
import { seedState } from './seed';
import type { AppState, CardPayment, CreditCard, FixedExpense, MonthCard, Transaction } from './types';

const SEP = '2026-09';
const OCT = '2026-10';

const card = (over: Partial<CreditCard>): CreditCard => ({
  id: 'a',
  name: 'Visa',
  bank: null,
  last4: null,
  cur: 'DOP',
  limit: null,
  cutoffDay: null,
  dueDay: null,
  active: true,
  sort: 0,
  ...over,
});

const pay = (id: string, amount: number, accountId: string): CardPayment => ({ id, date: '2026-10-20', accountId, amount });
const tx = (over: Partial<Transaction>): Transaction => ({
  id: 't',
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
const fx = (over: Partial<FixedExpense>): FixedExpense => ({
  id: 'f',
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

/** The sample state with these credit cards and, in September and October, whatever is given for each one. */
function withCards(cards: CreditCard[], months: Record<string, { cards?: MonthCard[]; tx?: Transaction[]; fixed?: FixedExpense[] }>): AppState {
  const s = seedState();
  s.cards = cards;
  for (const [key, extra] of Object.entries(months)) {
    const m = s.months[key]!;
    s.months[key] = { ...m, tx: [...m.tx, ...(extra.tx ?? [])], fixed: [...m.fixed, ...(extra.fixed ?? [])], ...(extra.cards && { cards: extra.cards }) };
  }
  return s;
}

describe('two credit cards', () => {
  const visa = card({ id: 'a', name: 'Visa', sort: 0 });
  const usd = card({ id: 'b', name: 'Dólares', cur: 'USD', sort: 1 });
  const s = withCards([visa, usd], {
    // September: 1,000 DOP on the first one, unpaid; 30 USD on the second one, 10 of them paid.
    [SEP]: { cards: [{ cardId: 'a', other: 1000, payments: [] }, { cardId: 'b', other: 30, payments: [pay('p1', 10, 'us')] }] },
    [OCT]: {
      cards: [{ cardId: 'a', other: 0, payments: [pay('p2', 400, 'dr')] }, { cardId: 'b', other: 5, payments: [] }],
      // No credit card: the first one that is on (Visa). The dollar one gets only its own, converted to USD (58.76 DOP = 1 USD).
      tx: [tx({ id: 't1', amount: 200 }), tx({ id: 't2', amount: 117.52, cardId: 'b' })],
      fixed: [fx({ id: 'f1', amount: 300 }), fx({ id: 'f2', amount: 3, cur: 'USD', cardId: 'b' })],
    },
  });

  it('each credit card carries over its own balance, in its currency', () => {
    expect(cardCalc(s, SEP, 'a')).toMatchObject({ previous: 0, total: 1000, remainder: 1000 });
    expect(cardCalc(s, SEP, 'b')).toMatchObject({ previous: 0, total: 30, paid: 10, remainder: 20, cur: 'USD' });
    const a = cardCalc(s, OCT, 'a');
    expect(a).toMatchObject({ previous: 1000, charged: 500, total: 1500, paid: 400, remainder: 1100, cur: 'DOP' });
    const b = cardCalc(s, OCT, 'b');
    expect(b.previous).toBe(20);
    expect(b.charged).toBeCloseTo(2 + 3, 9);
    expect(b.remainder).toBeCloseTo(20 + 5 + 5, 9);
  });

  it('the month adds up both, converted to the main currency; payments go into used and the rest stays pending', () => {
    const base = monthCalc(withCards([], {}), OCT);
    const c = monthCalc(s, OCT);
    expect(c.cards.map((k) => k.card.id)).toEqual(['a', 'b']);
    // Paid: 400 DOP; what is left: 1,100 DOP and 30 USD (× 58.76).
    expect(c.used).toBeCloseTo(base.used + 400, 6);
    expect(c.pending).toBeCloseTo(base.pending + 1100 + 30 * 58.76, 6);
  });

  it('a payment lowers the balance of its account, in the currency of its credit card', () => {
    const none = withCards([visa, usd], {});
    const bal = (st: AppState, id: string) => balances(st, OCT).accounts.find((x) => x.account.id === id)!.balance;
    expect(bal(s, 'dr')).toBeCloseTo(bal(none, 'dr') - 400, 9);
    // 10 USD from the USD account (September).
    expect(bal(s, 'us')).toBeCloseTo(bal(none, 'us') - 10, 9);
  });

  it('a credit card that is off adds to nothing, and whatever names no credit card goes to the first one that is on', () => {
    const off = { ...s, cards: [{ ...visa, active: false }, usd] };
    const c = monthCalc(off, OCT);
    expect(c.cards.map((k) => k.card.id)).toEqual(['b']);
    expect(defaultCardId(off)).toBe('b');
    // What named Visa no longer counts; what named none (200 and 300) now belongs to the dollar one.
    expect(cardCalc(off, OCT, 'b').charged).toBeCloseTo(2 + 3 + 500 / 58.76, 9);
    expect(activeCards(off).map((k) => k.id)).toEqual(['b']);
  });

  it('with no credit card on there is no row and there are no figures', () => {
    const none = withCards([{ ...visa, active: false }], { [OCT]: { cards: [{ cardId: 'a', other: 700, payments: [] }] } });
    expect(cardCalcs(none, OCT)).toEqual([]);
    const base = monthCalc(withCards([], {}), OCT);
    const c = monthCalc(none, OCT);
    expect(c.cards).toEqual([]);
    expect(c.pending).toBeCloseTo(base.pending, 9);
    expect(c.used).toBeCloseTo(base.used, 9);
  });

  it('the payment of a credit card that is off still comes out of its account: the money did go out', () => {
    const off = { ...s, cards: [visa, { ...usd, active: false }] };
    const bal = (st: AppState) => balances(st, OCT).accounts.find((x) => x.account.id === 'us')!.balance;
    expect(bal(off)).toBe(bal(s));
  });
});

describe('turning a credit card off', () => {
  const visa = card({ id: 'a' });

  it('allowed if in the last month it owes nothing and has no charges', () => {
    expect(cardOffBlocked(withCards([visa], {}), 'a')).toBe(false);
    // With other charges paid in full and nothing charged: nothing blocks it.
    const paid = withCards([visa], { [OCT]: { cards: [{ cardId: 'a', other: 100, payments: [pay('p', 100, 'dr')] }] } });
    expect(cardOffBlocked(paid, 'a')).toBe(false);
  });

  it('not allowed if it owes something, or if it has something charged in the last month', () => {
    const owes = withCards([visa], { [OCT]: { cards: [{ cardId: 'a', other: 100, payments: [] }] } });
    expect(cardOffBlocked(owes, 'a')).toBe(true);
    const charged = withCards([visa], { [OCT]: { tx: [tx({ cardId: 'a' })], cards: [{ cardId: 'a', other: 0, payments: [pay('p', 100, 'dr')] }] } });
    expect(cardOffBlocked(charged, 'a')).toBe(true);
    // Debt carried over from an earlier month counts too.
    const carried = withCards([visa], { [SEP]: { cards: [{ cardId: 'a', other: 50, payments: [] }] } });
    expect(cardOffBlocked(carried, 'a')).toBe(true);
  });
});

describe('the notice to get under 10 %', () => {
  const k = card({ limit: 60000, cutoffDay: 13 });

  it('without a limit or a cutoff day there is no notice', () => {
    expect(cardHint({ ...k, limit: null }, 1000, '2026-10-09')).toBeNull();
    expect(cardHint({ ...k, cutoffDay: null }, 1000, '2026-10-09')).toBeNull();
    expect(cardUtilization({ limit: null }, 500)).toBeNull();
    expect(cardUtilization(k, 15000)).toBeCloseTo(0.25, 9);
  });

  it('how much to pay: what exceeds 10 % plus one cent; 0 if it is already under', () => {
    expect(cardHint(k, 12000, '2026-10-09')).toMatchObject({ utilization: 0.2, payToUnder10: 6000.01 });
    expect(cardHint(k, 5999.99, '2026-10-09')!.payToUnder10).toBe(0);
    // Right at 10 %: not under yet.
    expect(cardHint(k, 6000, '2026-10-09')!.payToUnder10).toBe(0.01);
    // What was overpaid is not debt.
    expect(cardHint(k, -300, '2026-10-09')).toMatchObject({ utilization: 0, payToUnder10: 0 });
  });

  it('next cutoff: today counts; if it already passed, the one in the next month (also when the year changes)', () => {
    expect(cardHint(k, 0, '2026-10-09')).toMatchObject({ nextCutoff: '2026-10-13', daysToCutoff: 4 });
    expect(cardHint(k, 0, '2026-10-13')).toMatchObject({ nextCutoff: '2026-10-13', daysToCutoff: 0 });
    expect(cardHint(k, 0, '2026-10-14')).toMatchObject({ nextCutoff: '2026-11-13', daysToCutoff: 30 });
    expect(cardHint({ ...k, cutoffDay: 5 }, 0, '2026-12-20')).toMatchObject({ nextCutoff: '2027-01-05', daysToCutoff: 16 });
  });

  it('day 31 is clamped to the length of each month', () => {
    const d31 = { ...k, cutoffDay: 31 };
    expect(cardHint(d31, 0, '2026-04-10')!.nextCutoff).toBe('2026-04-30');
    expect(cardHint(d31, 0, '2026-02-15')!.nextCutoff).toBe('2026-02-28');
    expect(cardHint(d31, 0, '2028-02-15')!.nextCutoff).toBe('2028-02-29');
    expect(cardHint(d31, 0, '2026-05-01')!.nextCutoff).toBe('2026-05-31');
    // In early May the most recent cutoff was April 30: the payment due on the 5th falls on May 5.
    expect(cardHint({ ...d31, dueDay: 5 }, 0, '2026-05-01')!.nextDue).toBe('2026-05-05');
  });

  it('the payment is the first one after the most recent cutoff: the same month if its day is later, otherwise the next one', () => {
    // Due on the 28th, cutoff on the 13th: the 28th of the cutoff's month.
    expect(cardHint({ ...k, dueDay: 28 }, 0, '2026-10-20')).toMatchObject({ nextDue: '2026-10-28', daysToDue: 8 });
    // Due on the 5th, cutoff on the 13th: the 5th of the next month.
    expect(cardHint({ ...k, dueDay: 5 }, 0, '2026-10-20')).toMatchObject({ nextDue: '2026-11-05', daysToDue: 16 });
    // Before the October cutoff, the most recent cutoff is September's: the payment due on the 5th is October's.
    expect(cardHint({ ...k, dueDay: 5 }, 0, '2026-10-03')).toMatchObject({ nextDue: '2026-10-05', daysToDue: 2 });
    // The same day as the cutoff is not "after": it moves to the next month.
    expect(cardHint({ ...k, dueDay: 13 }, 0, '2026-10-20')!.nextDue).toBe('2026-11-13');
    // A payment that came due without being paid shows up with negative days.
    expect(cardHint({ ...k, dueDay: 15 }, 0, '2026-10-20')).toMatchObject({ nextDue: '2026-10-15', daysToDue: -5 });
  });

  it('without a due day there is no due date', () => {
    expect(cardHint(k, 0, '2026-10-20')).toMatchObject({ nextDue: null, daysToDue: null, upcomingDue: null });
  });

  it('the date shown jumps to the payment of the upcoming cutoff once that of the previous one is past due', () => {
    // Cutoff on the 13th, due on the 28th: on October 7 the September payment has already passed; the one left is the October 28 one.
    expect(cardHint({ ...k, dueDay: 28 }, 0, '2026-10-07')).toMatchObject({ nextDue: '2026-09-28', daysToDue: -9, upcomingDue: { date: '2026-10-28', days: 21 } });
    // Due on the 5th (the month after the cutoff): not yet due on October 3, and it belongs to the September cutoff.
    expect(cardHint({ ...k, dueDay: 5 }, 0, '2026-10-03')!.upcomingDue).toEqual({ date: '2026-10-05', days: 2 });
    // On October 20 the one of the 13th → November 5 is not due yet.
    expect(cardHint({ ...k, dueDay: 5 }, 0, '2026-10-20')!.upcomingDue).toEqual({ date: '2026-11-05', days: 16 });
  });
});
