// Tarjeta de crédito como pago diferido (aquí con UNA tarjeta, la 'card' de la migración 0011; con varias: cards.test.ts): el total (saldo anterior + otros cargos + lo cargado), lo que arrastra de
// un mes a otro y qué cifras mueve cada cosa. Lo cargado no toca saldos ni "usado": solo el pago.

import { describe, expect, it } from 'vitest';
import { balances, cardAccountFor, cardCalc, monthCalc } from './calc';
import { seedState } from './seed';
import type { AppState, CardPayment, CreditCard, FixedExpense, MonthCard, Transaction } from './types';

/** La tarjeta única de siempre, en la moneda principal. */
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

/** El estado de ejemplo con cambios en octubre: la tarjeta del mes y lo que se le cargue. */
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

describe('el total de la tarjeta', () => {
  it('sin nada cargado es 0 en todos los meses y no cambia ninguna cifra', () => {
    const s = seed();
    for (const key of [AUG, SEP, OCT]) expect(cardCalc(s, key, 'card')).toMatchObject({ previous: 0, other: 0, charged: 0, total: 0, paid: 0, remainder: 0 });
    const c = monthCalc(s, OCT);
    expect(c.pending).toBeCloseTo(c.fixedAll - c.fixedPaid, 9);
  });

  it('suma saldo anterior + otros cargos + gastos fijos marcados + transacciones con tarjeta, convertidos a la principal', () => {
    const s = october(
      { cardId: 'card', other: 300, payments: [] },
      {
        fixed: [
          fx({ id: 'a', amount: 1000 }),
          fx({ id: 'b', amount: 10, cur: 'USD' }), // 10 × 58.76 = 587.6 con la tasa del mes
          fx({ id: 'c', amount: 500, paid: false }), // sin marcar: pendiente, no cargado
          fx({ id: 'd', amount: 70, onCard: false }), // pagado desde una cuenta: no es de la tarjeta
        ],
        tx: [
          tx({ id: 't1', amount: 200 }),
          tx({ id: 't2', amount: 5, cur: 'USD' }), // 5 × 58.76 = 293.8 con la tasa de su fecha
          tx({ id: 't3', amount: 50, method: 'Debit card' }), // débito: no es de la tarjeta de crédito
        ],
      },
    );
    // Septiembre: 1,000 de otros cargos, pagó 400; agosto: 250 sin pagar y sin tocar. 250 + 1,000 − 400 = 850.
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

  it('un mes sin pagar arrastra todo su total, también por varios meses', () => {
    const s = seed();
    s.months[AUG] = { ...s.months[AUG]!, cards: [{ cardId: 'card', other: 100, payments: [] }] };
    expect(cardCalc(s, SEP, 'card').previous).toBe(100);
    expect(cardCalc(s, OCT, 'card').previous).toBe(100);
    expect(cardCalc(s, OCT, 'card').total).toBe(100);
  });
});

describe('lo que mueve en el mes', () => {
  const base = seed();
  const b = monthCalc(base, OCT);
  const items = {
    fixed: [fx({ id: 'a', amount: 1000 }), fx({ id: 'c', amount: 500, paid: false })],
    tx: [tx({ id: 't1', amount: 200 })],
  };

  it('sin pagar: lo cargado no es usado y la tarjeta cuenta como pendiente por su total', () => {
    const s = october(none, items);
    const c = monthCalc(s, OCT);
    expect(c.cards[0]!.total).toBe(1200);
    expect(c.used).toBeCloseTo(b.used, 9);
    expect(c.avail).toBeCloseTo(b.avail, 9);
    // El gasto de 500 sin marcar sigue pendiente y la tarjeta suma sus 1,200.
    expect(c.pending).toBeCloseTo(b.pending + 500 + 1200, 9);
    expect(c.after).toBeCloseTo(b.after - 500 - 1200, 9);
    // La transacción con tarjeta no está en el total de transacciones del presupuesto, pero sí en la categoría.
    expect(c.varSpent).toBeCloseTo(b.varSpent, 9);
    expect(c.categories.find((x) => x.name === 'Transport')!.value).toBeCloseTo(monthCalc(base, OCT).categories.find((x) => x.name === 'Transport')!.value + 200, 9);
  });

  it('pago parcial: entra a lo usado y lo que falta de la tarjeta sigue pendiente este mes', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(700, 'dr')] }, items);
    const c = monthCalc(s, OCT);
    expect(c.used).toBeCloseTo(b.used + 700, 9);
    // 500 del gasto sin marcar + 500 que faltan de la tarjeta.
    expect(c.pending).toBeCloseTo(b.pending + 500 + 500, 9);
    expect(c.cards[0]!.remainder).toBe(500);
    expect(c.fixedPaid).toBeCloseTo(b.fixedPaid + 700, 9);
    // Fixed expenses del desglose: lo cargado cuenta como gasto fijo, el pago de la tarjeta no se repite.
    const fixedCat = (x: typeof c) => x.categories.find((k) => k.fixed)!.value;
    expect(fixedCat(c)).toBeCloseTo(fixedCat(b) + 1000, 9);
  });

  it('pagar el total deja la tarjeta en 0 para el mes siguiente', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(1200, 'dr')] }, items);
    expect(cardCalc(s, OCT, 'card').remainder).toBe(0);
    expect(monthCalc(s, OCT).used).toBeCloseTo(b.used + 1200, 9);
  });
});

describe('saldos de las cuentas', () => {
  const items = { fixed: [fx({ id: 'a', amount: 1000 })], tx: [tx({ id: 't1', amount: 200 }), tx({ id: 't2', amount: 5, cur: 'USD' })] };

  it('lo cargado no baja ningún saldo; solo el pago, en la moneda de la cuenta que paga', () => {
    const base = seed();
    const charged = october(none, items);
    expect(bal(charged, 'dr')).toBe(bal(base, 'dr'));
    expect(bal(charged, 'us')).toBe(bal(base, 'us'));

    const total = cardCalc(charged, OCT, 'card').total; // 1,000 + 200 + 293.8
    const fromDr = october({ cardId: 'card', other: 0, payments: [pay(600, 'dr')] }, items);
    expect(bal(fromDr, 'dr')).toBeCloseTo(bal(base, 'dr') - 600, 9);
    expect(bal(fromDr, 'us')).toBe(bal(base, 'us'));
    // Desde la cuenta en USD: 600 DOP a la tasa del mes.
    const fromUs = october({ cardId: 'card', other: 0, payments: [pay(total, 'us')] }, items);
    expect(bal(fromUs, 'us')).toBeCloseTo(bal(base, 'us') - total / 58.76, 9);
    expect(bal(fromUs, 'dr')).toBe(bal(base, 'dr'));
  });

  it('un pago de un mes anterior sigue restando en los saldos posteriores', () => {
    const s = seed();
    s.months[SEP] = { ...s.months[SEP]!, cards: [{ cardId: 'card', other: 300, payments: [pay(300, 'dr')] }] };
    expect(bal(s, 'dr')).toBeCloseTo(bal(seed(), 'dr') - 300, 9);
  });
});

describe('cuenta que se ofrece para pagar', () => {
  it('la del último pago de la tarjeta si sigue visible; si no, la cuenta por defecto', () => {
    const s = seed();
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('dr');
    s.months[SEP] = { ...s.months[SEP]!, cards: [{ cardId: 'card', other: 10, payments: [pay(10, 'us')] }] };
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('us');
    s.accounts = s.accounts.map((a) => (a.id === 'us' ? { ...a, hidden: true } : a));
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('dr');
  });
});

describe('varios pagos en el mismo mes', () => {
  const items = { fixed: [fx({ id: 'a', amount: 1000 })], tx: [tx({ id: 't1', amount: 200 })] };
  const base = seed();
  const b = monthCalc(base, OCT);

  it('la suma de los pagos es lo pagado; lo que falta sigue como pendiente y entra a lo usado lo pagado', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(300, 'dr'), pay(400, 'us')] }, items);
    const k = cardCalc(s, OCT, 'card');
    expect(k).toMatchObject({ total: 1200, paid: 700, remainder: 500 });
    const c = monthCalc(s, OCT);
    expect(c.used).toBeCloseTo(b.used + 700, 9);
    // «Disponible tras pendientes» honesto: la tarjeta sigue pendiente por lo que falta.
    expect(c.pending).toBeCloseTo(b.pending + 500, 9);
    expect(c.after).toBeCloseTo(b.after - 700 - 500, 9);
  });

  it('cada pago baja el saldo de su cuenta, convertido a la moneda de esa cuenta', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(300, 'dr'), pay(587.6, 'us')] }, items);
    expect(bal(s, 'dr')).toBeCloseTo(bal(base, 'dr') - 300, 9);
    expect(bal(s, 'us')).toBeCloseTo(bal(base, 'us') - 587.6 / 58.76, 9);
  });

  it('lo que falta pasa al mes siguiente derivado, y con todo pagado no pasa nada', () => {
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

  it('la cuenta que se ofrece es la del último pago del mes', () => {
    const s = october({ cardId: 'card', other: 0, payments: [pay(10, 'us'), pay(10, 'dr')] }, items);
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('dr');
    s.months[OCT] = { ...s.months[OCT]!, cards: [{ cardId: 'card', other: 0, payments: [pay(10, 'dr'), pay(10, 'us')] }] };
    expect(cardAccountFor(s, OCT, 'card')?.id).toBe('us');
  });
});
