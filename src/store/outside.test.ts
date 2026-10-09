// Gastos fuera de presupuesto en los reductores: alta, edición, baja, los dos "mover" y la cuenta en uso.

import { describe, expect, it } from 'vitest';
import { balances, monthCalc } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import type { AppState, OutsideExpense } from '../../shared/types';
import {
  accountInUse,
  canRemoveAccount,
  isPatch,
  newOutside,
  outsideChange,
  outsideFromTx,
  reduce,
  targetOf,
  txFromOutside,
} from './reducers';
import type { Action } from './reducers';

const OCT = '2026-10';
const input = { date: '2026-10-07', name: 'Car repair', amount: 1000 };
const frozen = (s: AppState = seedState()): AppState => {
  const freeze = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || Object.isFrozen(v)) return;
    Object.freeze(v);
    Object.values(v).forEach(freeze);
  };
  freeze(s);
  return s;
};
const out = (state: AppState) => state.months[OCT]!.outside ?? [];
const bal = (s: AppState, id: string) => balances(s, OCT).accounts.find((a) => a.account.id === id)!.balance;

describe('newOutside', () => {
  it('nombre, fecha válida, monto > 0 y una cuenta de dinero; la moneda por defecto es la de la cuenta', () => {
    const s = seedState();
    expect(newOutside(s, OCT, input, 'o1')).toEqual({ id: 'o1', monthKey: OCT, date: '2026-10-07', name: 'Car repair', desc: '', accountId: 'dr', amount: 1000, cur: 'DOP' });
    expect(newOutside(s, OCT, { ...input, accountId: 'us', desc: ' x ' }, 'o1')).toMatchObject({ accountId: 'us', cur: 'USD', desc: 'x' });
    expect(newOutside(s, OCT, { ...input, accountId: 'us', cur: 'TRY' }, 'o1')).toMatchObject({ cur: 'TRY' });
    for (const bad of [{ name: '  ' }, { amount: 0 }, { amount: -1 }, { date: 'ayer' }, { accountId: 'nope' }]) {
      expect(newOutside(s, OCT, { ...input, ...bad }, 'o1'), JSON.stringify(bad)).toBeNull();
    }
    expect(newOutside(s, '2030-01', input, 'o1')).toBeNull();
    // Una cuenta de oro no paga gastos.
    const gold = { ...s, accounts: [...s.accounts, { id: 'gold', name: 'Gold', currency: 'XAU' as const, opening: 5, hidden: false, sort: 9 }] };
    expect(newOutside(gold, OCT, { ...input, accountId: 'gold' }, 'o1')).toBeNull();
  });
});

describe('outside/add, patch y remove', () => {
  it('agrega (sin duplicar), edita y quita; el saldo lo sigue y lo usado no se mueve', () => {
    const s0 = frozen();
    const row = newOutside(s0, OCT, input, 'o1')!;
    const add: Action = { type: 'outside/add', row };
    const s1 = reduce(s0, add);
    expect(reduce(s1, add)).toEqual(s1);
    expect(out(s1)).toEqual([row]);
    expect(bal(s1, 'dr')).toBeCloseTo(bal(s0, 'dr') - 1000, 8);
    expect(monthCalc(s1, OCT).used).toBe(monthCalc(s0, OCT).used);

    const s2 = reduce(s1, { type: 'outside/patch', id: 'o1', patch: outsideChange(s1, { amount: 400, name: '  ', accountId: 'nope' }) });
    expect(out(s2)[0]).toMatchObject({ amount: 400, name: 'Car repair', accountId: 'dr' });
    expect(reduce(s2, { type: 'outside/remove', id: 'o1' }).months[OCT]!.outside).toEqual([]);
    expect(reduce(s2, { type: 'outside/remove', id: 'ghost' })).toBe(s2);
  });

  it('es una edición de celda (se agrupa y se retrasa) y su fila es la suya', () => {
    const patch: Action = { type: 'outside/patch', id: 'o1', patch: { amount: 3 } };
    expect(isPatch(patch)).toBe(true);
    expect(targetOf(patch)).toBe('outside:o1');
  });
});

describe('mover', () => {
  const tx = () => seedState().months[OCT]!.tx.find((t) => t.desc === 'Coffee')!;

  it('tx/moveOutside: la transacción deja el historial y aparece fuera de presupuesto en un solo paso; es idempotente', () => {
    const s0 = frozen();
    const t = tx();
    const row = outsideFromTx(t, 'o9');
    expect(row).toEqual({ id: 'o9', monthKey: OCT, date: t.date, name: t.desc, desc: [t.place, t.notes].filter(Boolean).join(' · '), accountId: t.accountId, amount: t.amount, cur: t.cur });
    const action: Action = { type: 'tx/moveOutside', id: t.id, row };
    const s1 = reduce(s0, action);
    expect(s1.months[OCT]!.tx.some((x) => x.id === t.id)).toBe(false);
    expect(out(s1)).toEqual([row]);
    // Aplicarla otra vez (un refetch ya la trajo) no duplica ni resucita nada.
    expect(reduce(s1, action)).toBe(s1);
    // El dinero total no cambia: sigue restando; lo usado baja.
    expect(bal(s1, 'dr')).toBeCloseTo(bal(s0, 'dr'), 8);
    expect(bal(s1, 'us')).toBeCloseTo(bal(s0, 'us'), 8);
    expect(monthCalc(s1, OCT).txCount).toBe(monthCalc(s0, OCT).txCount - 1);
    expect(targetOf(action)).toBe(`tx:${t.id}`);
  });

  it('una transacción que ya no está no deja un gasto huérfano', () => {
    const s0 = frozen();
    const t = tx();
    expect(reduce(s0, { type: 'tx/moveOutside', id: 'ghost', row: outsideFromTx(t, 'o9') })).toBe(s0);
  });

  it('outside/moveToBudget: vuelve como Other / Transfer, sin lugar, con la descripción en las notas', () => {
    const s0 = frozen();
    const row: OutsideExpense = { id: 'o1', monthKey: OCT, date: '2026-10-05', name: 'Repair', desc: 'radiator', accountId: 'us', amount: 20, cur: 'USD' };
    const s1 = reduce(s0, { type: 'outside/add', row });
    const back = txFromOutside(row, 'tx9');
    expect(back).toEqual({ id: 'tx9', monthKey: OCT, date: '2026-10-05', desc: 'Repair', place: '', cat: 'Other', method: 'Transfer', amount: 20, cur: 'USD', accountId: 'us', notes: 'radiator', source: 'web', createdAt: null });
    const action: Action = { type: 'outside/moveToBudget', id: 'o1', row: back };
    const s2 = reduce(s1, action);
    expect(out(s2)).toEqual([]);
    expect(s2.months[OCT]!.tx.at(-1)).toEqual(back);
    expect(reduce(s2, action)).toBe(s2);
    expect(bal(s2, 'us')).toBeCloseTo(bal(s1, 'us'), 8);
    expect(monthCalc(s2, OCT).txCount).toBe(monthCalc(s1, OCT).txCount + 1);
    expect(targetOf(action)).toBe('outside:o1');
  });
});

describe('cuenta en uso', () => {
  it('una cuenta con un gasto fuera de presupuesto no se puede eliminar', () => {
    const s = seedState();
    const extra = { ...s, accounts: [...s.accounts, { id: 'x', name: 'Extra', currency: 'DOP' as const, opening: 0, hidden: false, sort: 5 }] };
    expect(canRemoveAccount(extra, 'x')).toBe(true);
    const used = reduce(extra, { type: 'outside/add', row: newOutside(extra, OCT, { ...input, accountId: 'x' }, 'o1')! });
    expect(accountInUse(used, 'x')).toBe(true);
    expect(canRemoveAccount(used, 'x')).toBe(false);
  });
});
