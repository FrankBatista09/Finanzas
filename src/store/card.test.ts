// Tarjeta de crédito en los reductores: otros cargos, pagar y deshacer, las reglas que el servidor también exige,
// el gasto fijo «en tarjeta» y la cuenta que paga como cuenta en uso.

import { describe, expect, it } from 'vitest';
import { balances, cardCalc, monthCalc } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import type { AppState } from '../../shared/types';
import { accountInUse, cardOtherChange, cardPayment, cardUnpay, cardUnpayOne, newFixed, reduce, snapToTotal, targetOf } from './reducers';
import type { Action } from './reducers';

const OCT = '2026-10';

const apply = (state: AppState, action: Action | null): AppState => (action ? reduce(state, action) : state);
const DAY = '2026-10-20';
/** Un pago de la tarjeta de octubre con id fijo. */
const pay = (s: AppState, amount: number, accountId: string, id = 'p1') => cardPayment(s, OCT, amount, accountId, id, DAY);
const bal = (s: AppState, id: string) => balances(s, OCT).accounts.find((a) => a.account.id === id)!.balance;

/** Octubre con 1,000 de otros cargos: el total de la tarjeta es 1,000. */
const owing = (): AppState => apply(seedState(), cardOtherChange(seedState(), OCT, 1000));

describe('otros cargos', () => {
  it('suben el total; un mes cerrado, un mes que no existe o un monto negativo no se aceptan; 0 lo deja como estaba', () => {
    const s = seedState();
    expect(cardCalc(owing(), OCT).total).toBe(1000);
    expect(cardOtherChange(s, '2026-09', 5)).toBeNull();
    expect(cardOtherChange(s, '2030-01', 5)).toBeNull();
    expect(cardOtherChange(s, OCT, -1)).toBeNull();
    expect(cardOtherChange(s, OCT, NaN)).toBeNull();
    const cleared = apply(owing(), cardOtherChange(owing(), OCT, 0));
    expect('card' in cleared.months[OCT]!).toBe(false);
  });

  it('aplicar dos veces la misma acción da lo mismo que una', () => {
    const action = cardOtherChange(seedState(), OCT, 40)!;
    const once = reduce(seedState(), action);
    expect(reduce(once, action)).toBe(once);
  });
});

describe('pagar la tarjeta', () => {
  it('guarda el importe y la cuenta; solo entonces baja el saldo; deshacer lo devuelve', () => {
    const s = owing();
    const before = bal(s, 'dr');
    const paid = apply(s, pay(s, 400, 'dr'));
    expect(paid.months[OCT]!.card).toEqual({ other: 1000, payments: [{ id: 'p1', date: DAY, accountId: 'dr', amount: 400 }] });
    expect(bal(paid, 'dr')).toBeCloseTo(before - 400, 9);
    expect(monthCalc(paid, OCT).used).toBeCloseTo(monthCalc(s, OCT).used + 400, 9);
    expect(reduce(paid, pay(s, 400, 'dr')!)).not.toBe(paid); // con otro id sería otro pago: el mismo id no se repite en el servidor

    const undone = apply(paid, cardUnpay(paid, OCT));
    expect(undone.months[OCT]!.card).toEqual({ other: 1000, payments: [] });
    expect(bal(undone, 'dr')).toBe(before);
    expect(cardUnpay(undone, OCT)).toBeNull();
  });

  it('el importe tiene que ser > 0 y no pasar del total; la cuenta, de dinero y existente; el mes, abierto', () => {
    const s = owing();
    expect(pay(s, 0, 'dr')).toBeNull();
    expect(pay(s, -5, 'dr')).toBeNull();
    expect(pay(s, 1000.01, 'dr')).toBeNull();
    expect(pay(s, 1000, 'dr')).toMatchObject({ payment: { amount: 1000 } });
    expect(pay(s, 10, 'nope')).toBeNull();
    expect(cardPayment(s, '2026-09', 10, 'dr', 'p1', DAY)).toBeNull();
    const gold = { ...s, accounts: [...s.accounts, { id: 'gold', name: 'Gold', currency: 'XAU' as const, opening: 1, hidden: false, sort: 9 }] };
    expect(pay(gold, 10, 'gold')).toBeNull();
    // Sin nada cargado no hay nada que pagar.
    expect(pay(seedState(), 1, 'dr')).toBeNull();
  });

  it('el total mostrado con dos decimales cuenta como el total: no deja un resto de céntimos', () => {
    expect(snapToTotal(100, 100.004)).toBe(100.004);
    expect(snapToTotal(99.99, 100.004)).toBe(99.99);
    // 100.006 se ve como «100.01»: confirmar eso paga el total exacto y no lo rechaza por pasarse.
    const s = apply(seedState(), cardOtherChange(seedState(), OCT, 100.006));
    expect(pay(s, 100.01, 'dr')).toMatchObject({ payment: { amount: 100.006 } });
    expect(cardCalc(apply(s, pay(s, 100.01, 'dr')), OCT).remainder).toBe(0);
    expect(pay(s, 100.02, 'dr')).toBeNull();
  });

  it('las acciones de la tarjeta se agrupan por mes', () => {
    expect(targetOf({ type: 'card/pay', key: OCT, payment: { id: 'p1', date: DAY, accountId: 'dr', amount: 1 } })).toBe(`card:${OCT}`);
    expect(targetOf({ type: 'card/unpay', key: OCT })).toBe(`card:${OCT}`);
  });
});

describe('varios pagos de la tarjeta', () => {
  it('se acumulan, cada uno baja el saldo de su cuenta, y lo que falta limita al siguiente', () => {
    const s = owing();
    const base = { dr: bal(s, 'dr'), us: bal(s, 'us') };
    const one = apply(s, pay(s, 300, 'dr', 'a'));
    const two = apply(one, pay(one, 587.6, 'us', 'b'));
    expect(cardCalc(two, OCT).paid).toBeCloseTo(887.6, 9);
    expect(cardCalc(two, OCT).remainder).toBeCloseTo(112.4, 9);
    expect(bal(two, 'dr')).toBeCloseTo(base.dr - 300, 9);
    expect(bal(two, 'us')).toBeCloseTo(base.us - 587.6 / 58.76, 9);
    expect(pay(two, 112.5, 'dr', 'c')).toBeNull();
    expect(pay(two, 112.4, 'dr', 'c')).not.toBeNull();
    // Pagada del todo ya no se puede pagar más.
    const full = apply(two, pay(two, 112.4, 'dr', 'c'));
    expect(pay(full, 1, 'dr', 'd')).toBeNull();
  });

  it('quitar uno devuelve solo su parte; quitar todos deja el mes sin tarjeta si no hay más', () => {
    const s = apply(seedState(), cardOtherChange(seedState(), OCT, 1000));
    const one = apply(s, pay(s, 300, 'dr', 'a'));
    const two = apply(one, pay(one, 200, 'us', 'b'));
    const less = apply(two, cardUnpayOne(two, OCT, 'a'));
    expect(less.months[OCT]!.card!.payments.map((p) => p.id)).toEqual(['b']);
    expect(cardUnpayOne(less, OCT, 'a')).toBeNull();
    expect(cardUnpayOne(less, '2026-09', 'b')).toBeNull();
    expect(apply(two, cardUnpay(two, OCT)).months[OCT]!.card).toEqual({ other: 1000, payments: [] });
    // Sin otros cargos, quitar el único pago deja el mes sin `card`, como lo manda el servidor.
    const only = apply(seedState(), cardOtherChange(seedState(), OCT, 1000));
    const paid = apply(only, pay(only, 50, 'dr', 'z'));
    const noOther = { ...paid, months: { ...paid.months, [OCT]: { ...paid.months[OCT]!, card: { other: 0, payments: paid.months[OCT]!.card!.payments } } } };
    expect('card' in apply(noOther, cardUnpayOne(noOther, OCT, 'z')).months[OCT]!).toBe(false);
  });
});

describe('gasto fijo en tarjeta y cuenta en uso', () => {
  it('newFixed solo marca onCard cuando se pide', () => {
    const s = seedState();
    expect('onCard' in newFixed(s, OCT, { name: 'Gym', amount: 5, cur: 'DOP' }, 'a')!).toBe(false);
    expect(newFixed(s, OCT, { name: 'Gym', amount: 5, cur: 'DOP', onCard: true }, 'a')).toMatchObject({ onCard: true, paid: false });
  });

  it('la cuenta que pagó la tarjeta está en uso', () => {
    const s = owing();
    expect(accountInUse(s, 'us')).toBe(accountInUse(seedState(), 'us'));
    const paid = apply(s, pay(s, 10, 'us'));
    expect(accountInUse(paid, 'us')).toBe(true);
  });
});
