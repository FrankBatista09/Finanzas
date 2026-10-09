// Tarjeta de crédito como pago diferido: el total (saldo anterior + otros cargos + lo cargado), lo que arrastra de
// un mes a otro y qué cifras mueve cada cosa. Lo cargado no toca saldos ni "usado": solo el pago.

import { describe, expect, it } from 'vitest';
import { balances, cardAccountFor, cardCalc, monthCalc } from './calc';
import { seedState } from './seed';
import type { AppState, FixedExpense, MonthCard, Transaction } from './types';

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
  const s = seedState();
  const m = s.months[OCT]!;
  s.months[OCT] = { ...m, fixed: [...m.fixed, ...(extra.fixed ?? [])], tx: [...m.tx, ...(extra.tx ?? [])], ...(card && { card }) };
  return s;
}

const none: MonthCard = { other: 0, paid: null, accountId: null };
const bal = (s: AppState, id: string) => balances(s, OCT).accounts.find((a) => a.account.id === id)!.balance;

describe('el total de la tarjeta', () => {
  it('sin nada cargado es 0 en todos los meses y no cambia ninguna cifra', () => {
    const s = seedState();
    for (const key of [AUG, SEP, OCT]) expect(cardCalc(s, key)).toMatchObject({ previous: 0, other: 0, charged: 0, total: 0, paid: null, remainder: 0 });
    const c = monthCalc(s, OCT);
    expect(c.pending).toBeCloseTo(c.fixedAll - c.fixedPaid, 9);
  });

  it('suma saldo anterior + otros cargos + gastos fijos marcados + transacciones con tarjeta, convertidos a la principal', () => {
    const s = october(
      { other: 300, paid: null, accountId: null },
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
    s.months[AUG] = { ...s.months[AUG]!, card: { other: 250, paid: null, accountId: null } };
    s.months[SEP] = { ...s.months[SEP]!, card: { other: 1000, paid: 400, accountId: 'dr' } };
    expect(cardCalc(s, AUG)).toMatchObject({ total: 250, remainder: 250 });
    expect(cardCalc(s, SEP)).toMatchObject({ previous: 250, total: 1250, paid: 400, remainder: 850 });
    const c = cardCalc(s, OCT);
    expect(c.previous).toBe(850);
    expect(c.other).toBe(300);
    expect(c.charged).toBeCloseTo(1000 + 587.6 + 200 + 293.8, 6);
    expect(c.total).toBeCloseTo(850 + 300 + 1000 + 587.6 + 200 + 293.8, 6);
  });

  it('un mes sin pagar arrastra todo su total, también por varios meses', () => {
    const s = seedState();
    s.months[AUG] = { ...s.months[AUG]!, card: { other: 100, paid: null, accountId: null } };
    expect(cardCalc(s, SEP).previous).toBe(100);
    expect(cardCalc(s, OCT).previous).toBe(100);
    expect(cardCalc(s, OCT).total).toBe(100);
  });
});

describe('lo que mueve en el mes', () => {
  const base = seedState();
  const b = monthCalc(base, OCT);
  const items = {
    fixed: [fx({ id: 'a', amount: 1000 }), fx({ id: 'c', amount: 500, paid: false })],
    tx: [tx({ id: 't1', amount: 200 })],
  };

  it('sin pagar: lo cargado no es usado y la tarjeta cuenta como pendiente por su total', () => {
    const s = october(none, items);
    const c = monthCalc(s, OCT);
    expect(c.card.total).toBe(1200);
    expect(c.used).toBeCloseTo(b.used, 9);
    expect(c.avail).toBeCloseTo(b.avail, 9);
    // El gasto de 500 sin marcar sigue pendiente y la tarjeta suma sus 1,200.
    expect(c.pending).toBeCloseTo(b.pending + 500 + 1200, 9);
    expect(c.after).toBeCloseTo(b.after - 500 - 1200, 9);
    // La transacción con tarjeta no está en el total de transacciones del presupuesto, pero sí en la categoría.
    expect(c.varSpent).toBeCloseTo(b.varSpent, 9);
    expect(c.categories.find((x) => x.name === 'Transport')!.value).toBeCloseTo(monthCalc(base, OCT).categories.find((x) => x.name === 'Transport')!.value + 200, 9);
  });

  it('pago parcial: entra a lo usado, la tarjeta ya no es pendiente y el resto pasa al mes siguiente', () => {
    const s = october({ other: 0, paid: 700, accountId: 'dr' }, items);
    const c = monthCalc(s, OCT);
    expect(c.used).toBeCloseTo(b.used + 700, 9);
    expect(c.pending).toBeCloseTo(b.pending + 500, 9);
    expect(c.card.remainder).toBe(500);
    expect(c.fixedPaid).toBeCloseTo(b.fixedPaid + 700, 9);
    // Fixed expenses del desglose: lo cargado cuenta como gasto fijo, el pago de la tarjeta no se repite.
    const fixedCat = (x: typeof c) => x.categories.find((k) => k.fixed)!.value;
    expect(fixedCat(c)).toBeCloseTo(fixedCat(b) + 1000, 9);
  });

  it('pagar el total deja la tarjeta en 0 para el mes siguiente', () => {
    const s = october({ other: 0, paid: 1200, accountId: 'dr' }, items);
    expect(cardCalc(s, OCT).remainder).toBe(0);
    expect(monthCalc(s, OCT).used).toBeCloseTo(b.used + 1200, 9);
  });
});

describe('saldos de las cuentas', () => {
  const items = { fixed: [fx({ id: 'a', amount: 1000 })], tx: [tx({ id: 't1', amount: 200 }), tx({ id: 't2', amount: 5, cur: 'USD' })] };

  it('lo cargado no baja ningún saldo; solo el pago, en la moneda de la cuenta que paga', () => {
    const base = seedState();
    const charged = october(none, items);
    expect(bal(charged, 'dr')).toBe(bal(base, 'dr'));
    expect(bal(charged, 'us')).toBe(bal(base, 'us'));

    const total = cardCalc(charged, OCT).total; // 1,000 + 200 + 293.8
    const fromDr = october({ other: 0, paid: 600, accountId: 'dr' }, items);
    expect(bal(fromDr, 'dr')).toBeCloseTo(bal(base, 'dr') - 600, 9);
    expect(bal(fromDr, 'us')).toBe(bal(base, 'us'));
    // Desde la cuenta en USD: 600 DOP a la tasa del mes.
    const fromUs = october({ other: 0, paid: total, accountId: 'us' }, items);
    expect(bal(fromUs, 'us')).toBeCloseTo(bal(base, 'us') - total / 58.76, 9);
    expect(bal(fromUs, 'dr')).toBe(bal(base, 'dr'));
  });

  it('un pago de un mes anterior sigue restando en los saldos posteriores', () => {
    const s = seedState();
    s.months[SEP] = { ...s.months[SEP]!, card: { other: 300, paid: 300, accountId: 'dr' } };
    expect(bal(s, 'dr')).toBeCloseTo(bal(seedState(), 'dr') - 300, 9);
  });
});

describe('cuenta que se ofrece para pagar', () => {
  it('la del último pago de la tarjeta si sigue visible; si no, la cuenta por defecto', () => {
    const s = seedState();
    expect(cardAccountFor(s, OCT)?.id).toBe('dr');
    s.months[SEP] = { ...s.months[SEP]!, card: { other: 10, paid: 10, accountId: 'us' } };
    expect(cardAccountFor(s, OCT)?.id).toBe('us');
    s.accounts = s.accounts.map((a) => (a.id === 'us' ? { ...a, hidden: true } : a));
    expect(cardAccountFor(s, OCT)?.id).toBe('dr');
  });
});
