// Tarjeta de crédito en los reductores: otros cargos, pagar y deshacer, las reglas que el servidor también exige,
// el gasto fijo «en tarjeta» y la cuenta que paga como cuenta en uso.

import { describe, expect, it } from 'vitest';
import { balances, cardCalc, monthCalc } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import type { AppState } from '../../shared/types';
import { accountInUse, cardOtherChange, cardPayment, cardUnpay, newFixed, reduce, snapToTotal, targetOf } from './reducers';
import type { Action } from './reducers';

const OCT = '2026-10';

const apply = (state: AppState, action: Action | null): AppState => (action ? reduce(state, action) : state);
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
    const paid = apply(s, cardPayment(s, OCT, 400, 'dr'));
    expect(paid.months[OCT]!.card).toEqual({ other: 1000, paid: 400, accountId: 'dr' });
    expect(bal(paid, 'dr')).toBeCloseTo(before - 400, 9);
    expect(monthCalc(paid, OCT).used).toBeCloseTo(monthCalc(s, OCT).used + 400, 9);
    expect(reduce(paid, cardPayment(s, OCT, 400, 'dr')!)).toBe(paid);

    const undone = apply(paid, cardUnpay(paid, OCT));
    expect(undone.months[OCT]!.card).toEqual({ other: 1000, paid: null, accountId: null });
    expect(bal(undone, 'dr')).toBe(before);
    expect(cardUnpay(undone, OCT)).toBeNull();
  });

  it('el importe tiene que ser > 0 y no pasar del total; la cuenta, de dinero y existente; el mes, abierto', () => {
    const s = owing();
    expect(cardPayment(s, OCT, 0, 'dr')).toBeNull();
    expect(cardPayment(s, OCT, -5, 'dr')).toBeNull();
    expect(cardPayment(s, OCT, 1000.01, 'dr')).toBeNull();
    expect(cardPayment(s, OCT, 1000, 'dr')).toMatchObject({ amount: 1000 });
    expect(cardPayment(s, OCT, 10, 'nope')).toBeNull();
    expect(cardPayment(s, '2026-09', 10, 'dr')).toBeNull();
    const gold = { ...s, accounts: [...s.accounts, { id: 'gold', name: 'Gold', currency: 'XAU' as const, opening: 1, hidden: false, sort: 9 }] };
    expect(cardPayment(gold, OCT, 10, 'gold')).toBeNull();
    // Sin nada cargado no hay nada que pagar.
    expect(cardPayment(seedState(), OCT, 1, 'dr')).toBeNull();
  });

  it('el total mostrado con dos decimales cuenta como el total: no deja un resto de céntimos', () => {
    expect(snapToTotal(100, 100.004)).toBe(100.004);
    expect(snapToTotal(99.99, 100.004)).toBe(99.99);
    // 100.006 se ve como «100.01»: confirmar eso paga el total exacto y no lo rechaza por pasarse.
    const s = apply(seedState(), cardOtherChange(seedState(), OCT, 100.006));
    expect(cardPayment(s, OCT, 100.01, 'dr')).toMatchObject({ amount: 100.006 });
    expect(cardCalc(apply(s, cardPayment(s, OCT, 100.01, 'dr')), OCT).remainder).toBe(0);
    expect(cardPayment(s, OCT, 100.02, 'dr')).toBeNull();
  });

  it('las acciones de la tarjeta se agrupan por mes', () => {
    expect(targetOf({ type: 'card/pay', key: OCT, amount: 1, accountId: 'dr' })).toBe(`card:${OCT}`);
    expect(targetOf({ type: 'card/unpay', key: OCT })).toBe(`card:${OCT}`);
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
    const paid = apply(s, cardPayment(s, OCT, 10, 'us'));
    expect(accountInUse(paid, 'us')).toBe(true);
  });
});
