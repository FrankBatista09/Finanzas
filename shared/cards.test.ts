// Varias tarjetas de crédito: el cálculo por tarjeta (con su moneda y su saldo arrastrado), solo las activas suman, el
// aviso "paga para quedar por debajo del 10 %" y cuándo se puede apagar una tarjeta.

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

/** El estado de ejemplo con estas tarjetas y, en septiembre y octubre, lo que se indique de cada una. */
function withCards(cards: CreditCard[], months: Record<string, { cards?: MonthCard[]; tx?: Transaction[]; fixed?: FixedExpense[] }>): AppState {
  const s = seedState();
  s.cards = cards;
  for (const [key, extra] of Object.entries(months)) {
    const m = s.months[key]!;
    s.months[key] = { ...m, tx: [...m.tx, ...(extra.tx ?? [])], fixed: [...m.fixed, ...(extra.fixed ?? [])], ...(extra.cards && { cards: extra.cards }) };
  }
  return s;
}

describe('dos tarjetas', () => {
  const visa = card({ id: 'a', name: 'Visa', sort: 0 });
  const usd = card({ id: 'b', name: 'Dólares', cur: 'USD', sort: 1 });
  const s = withCards([visa, usd], {
    // Septiembre: 1,000 DOP en la primera sin pagar; 30 USD en la segunda, pagados 10.
    [SEP]: { cards: [{ cardId: 'a', other: 1000, payments: [] }, { cardId: 'b', other: 30, payments: [pay('p1', 10, 'us')] }] },
    [OCT]: {
      cards: [{ cardId: 'a', other: 0, payments: [pay('p2', 400, 'dr')] }, { cardId: 'b', other: 5, payments: [] }],
      // Sin tarjeta: la primera activa (Visa). La de dólares recibe solo lo suyo, convertido a USD (58.76 DOP = 1 USD).
      tx: [tx({ id: 't1', amount: 200 }), tx({ id: 't2', amount: 117.52, cardId: 'b' })],
      fixed: [fx({ id: 'f1', amount: 300 }), fx({ id: 'f2', amount: 3, cur: 'USD', cardId: 'b' })],
    },
  });

  it('cada tarjeta arrastra su propio saldo, en su moneda', () => {
    expect(cardCalc(s, SEP, 'a')).toMatchObject({ previous: 0, total: 1000, remainder: 1000 });
    expect(cardCalc(s, SEP, 'b')).toMatchObject({ previous: 0, total: 30, paid: 10, remainder: 20, cur: 'USD' });
    const a = cardCalc(s, OCT, 'a');
    expect(a).toMatchObject({ previous: 1000, charged: 500, total: 1500, paid: 400, remainder: 1100, cur: 'DOP' });
    const b = cardCalc(s, OCT, 'b');
    expect(b.previous).toBe(20);
    expect(b.charged).toBeCloseTo(2 + 3, 9);
    expect(b.remainder).toBeCloseTo(20 + 5 + 5, 9);
  });

  it('el mes suma las dos convertidas a la principal; los pagos entran a lo usado y el resto queda pendiente', () => {
    const base = monthCalc(withCards([], {}), OCT);
    const c = monthCalc(s, OCT);
    expect(c.cards.map((k) => k.card.id)).toEqual(['a', 'b']);
    // Pagado: 400 DOP; lo que falta: 1,100 DOP y 30 USD (× 58.76).
    expect(c.used).toBeCloseTo(base.used + 400, 6);
    expect(c.pending).toBeCloseTo(base.pending + 1100 + 30 * 58.76, 6);
  });

  it('un pago baja el saldo de su cuenta, en la moneda de su tarjeta', () => {
    const none = withCards([visa, usd], {});
    const bal = (st: AppState, id: string) => balances(st, OCT).accounts.find((x) => x.account.id === id)!.balance;
    expect(bal(s, 'dr')).toBeCloseTo(bal(none, 'dr') - 400, 9);
    // 10 USD desde la cuenta en USD (septiembre).
    expect(bal(s, 'us')).toBeCloseTo(bal(none, 'us') - 10, 9);
  });

  it('una tarjeta apagada no suma a nada, y lo que no dice tarjeta pasa a la primera activa', () => {
    const off = { ...s, cards: [{ ...visa, active: false }, usd] };
    const c = monthCalc(off, OCT);
    expect(c.cards.map((k) => k.card.id)).toEqual(['b']);
    expect(defaultCardId(off)).toBe('b');
    // Lo de Visa que decía su nombre ya no cuenta; lo que no decía ninguna (200 y 300) ahora es de la de dólares.
    expect(cardCalc(off, OCT, 'b').charged).toBeCloseTo(2 + 3 + 500 / 58.76, 9);
    expect(activeCards(off).map((k) => k.id)).toEqual(['b']);
  });

  it('sin ninguna tarjeta activa no hay fila ni cifras', () => {
    const none = withCards([{ ...visa, active: false }], { [OCT]: { cards: [{ cardId: 'a', other: 700, payments: [] }] } });
    expect(cardCalcs(none, OCT)).toEqual([]);
    const base = monthCalc(withCards([], {}), OCT);
    const c = monthCalc(none, OCT);
    expect(c.cards).toEqual([]);
    expect(c.pending).toBeCloseTo(base.pending, 9);
    expect(c.used).toBeCloseTo(base.used, 9);
  });

  it('el pago de una tarjeta apagada sigue restando de su cuenta: el dinero salió', () => {
    const off = { ...s, cards: [visa, { ...usd, active: false }] };
    const bal = (st: AppState) => balances(st, OCT).accounts.find((x) => x.account.id === 'us')!.balance;
    expect(bal(off)).toBe(bal(s));
  });
});

describe('apagar una tarjeta', () => {
  const visa = card({ id: 'a' });

  it('se puede si el último mes no debe nada ni tiene cargos', () => {
    expect(cardOffBlocked(withCards([visa], {}), 'a')).toBe(false);
    // Con otros cargos pagados del todo y nada cargado: nada que bloquee.
    const paid = withCards([visa], { [OCT]: { cards: [{ cardId: 'a', other: 100, payments: [pay('p', 100, 'dr')] }] } });
    expect(cardOffBlocked(paid, 'a')).toBe(false);
  });

  it('no si debe algo, o si tiene algo cargado en el último mes', () => {
    const owes = withCards([visa], { [OCT]: { cards: [{ cardId: 'a', other: 100, payments: [] }] } });
    expect(cardOffBlocked(owes, 'a')).toBe(true);
    const charged = withCards([visa], { [OCT]: { tx: [tx({ cardId: 'a' })], cards: [{ cardId: 'a', other: 0, payments: [pay('p', 100, 'dr')] }] } });
    expect(cardOffBlocked(charged, 'a')).toBe(true);
    // La deuda de un mes anterior que se arrastra también cuenta.
    const carried = withCards([visa], { [SEP]: { cards: [{ cardId: 'a', other: 50, payments: [] }] } });
    expect(cardOffBlocked(carried, 'a')).toBe(true);
  });
});

describe('el aviso para quedar por debajo del 10 %', () => {
  const k = card({ limit: 60000, cutoffDay: 13 });

  it('sin límite o sin día de corte no hay aviso', () => {
    expect(cardHint({ ...k, limit: null }, 1000, '2026-10-09')).toBeNull();
    expect(cardHint({ ...k, cutoffDay: null }, 1000, '2026-10-09')).toBeNull();
    expect(cardUtilization({ limit: null }, 500)).toBeNull();
    expect(cardUtilization(k, 15000)).toBeCloseTo(0.25, 9);
  });

  it('cuánto pagar: lo que pasa del 10 % más un centavo; 0 si ya está por debajo', () => {
    expect(cardHint(k, 12000, '2026-10-09')).toMatchObject({ utilization: 0.2, payToUnder10: 6000.01 });
    expect(cardHint(k, 5999.99, '2026-10-09')!.payToUnder10).toBe(0);
    // Justo en el 10 %: todavía no está por debajo.
    expect(cardHint(k, 6000, '2026-10-09')!.payToUnder10).toBe(0.01);
    // Lo pagado de más no es deuda.
    expect(cardHint(k, -300, '2026-10-09')).toMatchObject({ utilization: 0, payToUnder10: 0 });
  });

  it('próximo corte: hoy cuenta; si ya pasó, el del mes siguiente (también al cambiar de año)', () => {
    expect(cardHint(k, 0, '2026-10-09')).toMatchObject({ nextCutoff: '2026-10-13', daysToCutoff: 4 });
    expect(cardHint(k, 0, '2026-10-13')).toMatchObject({ nextCutoff: '2026-10-13', daysToCutoff: 0 });
    expect(cardHint(k, 0, '2026-10-14')).toMatchObject({ nextCutoff: '2026-11-13', daysToCutoff: 30 });
    expect(cardHint({ ...k, cutoffDay: 5 }, 0, '2026-12-20')).toMatchObject({ nextCutoff: '2027-01-05', daysToCutoff: 16 });
  });

  it('el día 31 se recorta al largo de cada mes', () => {
    const d31 = { ...k, cutoffDay: 31 };
    expect(cardHint(d31, 0, '2026-04-10')!.nextCutoff).toBe('2026-04-30');
    expect(cardHint(d31, 0, '2026-02-15')!.nextCutoff).toBe('2026-02-28');
    expect(cardHint(d31, 0, '2028-02-15')!.nextCutoff).toBe('2028-02-29');
    expect(cardHint(d31, 0, '2026-05-01')!.nextCutoff).toBe('2026-05-31');
    // El corte más reciente de principios de mayo fue el 30 de abril: el pago del 5 cae el 5 de mayo.
    expect(cardHint({ ...d31, dueDay: 5 }, 0, '2026-05-01')!.nextDue).toBe('2026-05-05');
  });

  it('el pago es el primero después del corte más reciente: el mismo mes si su día es mayor, si no el siguiente', () => {
    // Pago el 28, corte el 13: el 28 del mes del corte.
    expect(cardHint({ ...k, dueDay: 28 }, 0, '2026-10-20')).toMatchObject({ nextDue: '2026-10-28', daysToDue: 8 });
    // Pago el 5, corte el 13: el 5 del mes siguiente.
    expect(cardHint({ ...k, dueDay: 5 }, 0, '2026-10-20')).toMatchObject({ nextDue: '2026-11-05', daysToDue: 16 });
    // Antes del corte de octubre, el corte más reciente es el de septiembre: el pago del 5 es el de octubre.
    expect(cardHint({ ...k, dueDay: 5 }, 0, '2026-10-03')).toMatchObject({ nextDue: '2026-10-05', daysToDue: 2 });
    // El mismo día que el corte no es "después": pasa al mes siguiente.
    expect(cardHint({ ...k, dueDay: 13 }, 0, '2026-10-20')!.nextDue).toBe('2026-11-13');
    // Un pago que ya venció sin pagarse sale con días negativos.
    expect(cardHint({ ...k, dueDay: 15 }, 0, '2026-10-20')).toMatchObject({ nextDue: '2026-10-15', daysToDue: -5 });
  });

  it('sin día de pago no hay fecha de pago', () => {
    expect(cardHint(k, 0, '2026-10-20')).toMatchObject({ nextDue: null, daysToDue: null, upcomingDue: null });
  });

  it('la fecha que se enseña salta al pago del corte que viene cuando el del anterior ya venció', () => {
    // Corte el 13, pago el 28: el 7 de octubre el pago de septiembre ya pasó; el que queda es el del 28 de octubre.
    expect(cardHint({ ...k, dueDay: 28 }, 0, '2026-10-07')).toMatchObject({ nextDue: '2026-09-28', daysToDue: -9, upcomingDue: { date: '2026-10-28', days: 21 } });
    // Pago el 5 (mes siguiente al corte): aún no vence el 3 de octubre, que es del corte de septiembre.
    expect(cardHint({ ...k, dueDay: 5 }, 0, '2026-10-03')!.upcomingDue).toEqual({ date: '2026-10-05', days: 2 });
    // El 20 de octubre el del 13 → 5 de noviembre aún no venció.
    expect(cardHint({ ...k, dueDay: 5 }, 0, '2026-10-20')!.upcomingDue).toEqual({ date: '2026-11-05', days: 16 });
  });
});
