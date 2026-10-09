// Varias tarjetas de crédito en los reductores: alta, edición y borrado con las reglas del servidor, y las filas nuevas
// con su tarjeta.

import { describe, expect, it } from 'vitest';
import { seedState } from '../../shared/seed';
import type { AppState, CreditCard } from '../../shared/types';
import { canRemoveCard, canTurnOffCard, cardOtherChange, cardPatchChange, cardPayment, cardRemoval, fixedChange, newCard, newFixed, newTx, reduce, txChange } from './reducers';
import type { Action } from './reducers';

const OCT = '2026-10';
const card = (over: Partial<CreditCard> = {}): CreditCard => ({ id: 'a', name: 'Visa', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0, ...over });
const withCards = (...cards: CreditCard[]): AppState => ({ ...seedState(), cards });
const apply = (state: AppState, action: Action | null): AppState => (action ? reduce(state, action) : state);

describe('newCard', () => {
  it('nombre obligatorio y único, días entre 1 y 31, límite > 0, 4 dígitos; la moneda nace en la principal', () => {
    const s = withCards(card());
    expect(newCard(s, { name: '  Master ' }, 'x')).toEqual({ id: 'x', name: 'Master', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 1 });
    expect(newCard(s, { name: 'Gold', bank: ' Popular ', last4: '1234', cur: 'USD', limit: 60000, cutoffDay: 13, dueDay: 31 }, 'x')).toMatchObject({ bank: 'Popular', last4: '1234', cur: 'USD', limit: 60000, cutoffDay: 13, dueDay: 31 });
    for (const bad of [{ name: '' }, { name: '  ' }, { name: 'visa' }, { name: 'A', cutoffDay: 0 }, { name: 'A', cutoffDay: 32 }, { name: 'A', dueDay: 2.5 }, { name: 'A', limit: 0 }, { name: 'A', last4: '12' }]) {
      expect(newCard(s, bad, 'x'), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('editar y borrar', () => {
  it('guarda lo que cambia; sin cambio, nada; nombre repetido o día fuera de rango, no', () => {
    const s = withCards(card(), card({ id: 'b', name: 'Master', sort: 1 }));
    const action = cardPatchChange(s, 'a', { limit: 60000, cutoffDay: 13, bank: ' Popular ' });
    expect(action).toEqual({ type: 'creditCard/patch', id: 'a', patch: { limit: 60000, cutoffDay: 13, bank: 'Popular' } });
    expect(apply(s, action).cards[0]).toMatchObject({ limit: 60000, cutoffDay: 13, bank: 'Popular' });
    expect(cardPatchChange(s, 'a', { name: 'Visa' })).toBeNull();
    expect(cardPatchChange(s, 'a', { name: 'MASTER' })).toBeNull();
    expect(cardPatchChange(s, 'a', { dueDay: 40 })).toBeNull();
    expect(cardPatchChange(s, 'nope', { limit: 1 })).toBeNull();
    // null borra un dato opcional.
    const timed = withCards(card({ dueDay: 5 }));
    expect(apply(timed, cardPatchChange(timed, 'a', { dueDay: null })).cards[0]!.dueDay).toBeNull();
  });

  it('apagar solo sin deuda ni cargos en el último mes; encender siempre', () => {
    const s = withCards(card());
    expect(canTurnOffCard(s, 'a')).toBe(true);
    expect(apply(s, cardPatchChange(s, 'a', { active: false })).cards[0]!.active).toBe(false);
    const owing = apply(s, cardOtherChange(s, OCT, 'a', 100));
    expect(canTurnOffCard(owing, 'a')).toBe(false);
    expect(cardPatchChange(owing, 'a', { active: false })).toBeNull();
    const paid = apply(owing, cardPayment(owing, OCT, 'a', 100, 'dr', 'p', '2026-10-20'));
    expect(cardPatchChange(paid, 'a', { active: false })).not.toBeNull();
    const off = apply(paid, cardPatchChange(paid, 'a', { active: false }));
    expect(cardPatchChange(off, 'a', { active: true })).not.toBeNull();
  });

  it('borrar solo si nada la usa; la moneda de una tarjeta en uso no cambia', () => {
    const s = withCards(card(), card({ id: 'b', name: 'Master', sort: 1 }));
    expect(canRemoveCard(s, 'b')).toBe(true);
    expect(apply(s, cardRemoval(s, 'b')).cards.map((c) => c.id)).toEqual(['a']);
    const owing = apply(s, cardOtherChange(s, OCT, 'b', 100));
    expect(cardRemoval(owing, 'b')).toBeNull();
    expect(cardPatchChange(owing, 'b', { cur: 'USD' })).toBeNull();
    expect(cardPatchChange(s, 'b', { cur: 'USD' })).not.toBeNull();
    // Lo que no nombra tarjeta es de la primera activa: ella no se borra.
    const implicit = apply(s, { type: 'tx/add', row: { id: 't', monthKey: OCT, date: '2026-10-02', desc: 'x', place: '', cat: 'Food', method: 'Credit card', amount: 5, cur: 'DOP', accountId: 'dr', notes: '', source: 'import', createdAt: null } });
    expect(canRemoveCard(implicit, 'a')).toBe(false);
    expect(canRemoveCard(implicit, 'b')).toBe(true);
  });

  it('las acciones son idempotentes', () => {
    const s = withCards(card());
    const add: Action = { type: 'creditCard/add', row: card({ id: 'z', name: 'Z', sort: 1 }) };
    const once = reduce(s, add);
    expect(reduce(once, add).cards).toEqual(once.cards);
    const patch: Action = { type: 'creditCard/patch', id: 'z', patch: { limit: 5 } };
    expect(reduce(reduce(once, patch), patch)).toEqual(reduce(once, patch));
    const gone = reduce(once, { type: 'creditCard/remove', id: 'z' });
    expect(reduce(gone, { type: 'creditCard/remove', id: 'z' })).toBe(gone);
  });
});

describe('filas nuevas con tarjeta', () => {
  it('un gasto fijo o una transacción de crédito llevan la tarjeta pedida, o la primera activa; sin ninguna, no se agrega', () => {
    const s = withCards(card(), card({ id: 'b', name: 'Master', sort: 1 }), card({ id: 'c', name: 'Old', sort: 2, active: false }));
    expect(newFixed(s, OCT, { name: 'Gym', amount: 5, cur: 'DOP', onCard: true }, 'f')).toMatchObject({ onCard: true, cardId: 'a' });
    expect(newFixed(s, OCT, { name: 'Gym', amount: 5, cur: 'DOP', onCard: true, cardId: 'b' }, 'f')).toMatchObject({ cardId: 'b' });
    expect(newFixed(s, OCT, { name: 'Gym', amount: 5, cur: 'DOP', onCard: true, cardId: 'c' }, 'f')).toMatchObject({ cardId: 'a' });
    expect('cardId' in newFixed(s, OCT, { name: 'Gym', amount: 5, cur: 'DOP' }, 'f')!).toBe(false);
    const tx = { date: '2026-10-07', desc: 'Taxi', cat: 'Transport', amount: 5, cur: 'DOP' as const };
    expect(newTx(s, OCT, { ...tx, method: 'Credit card', cardId: 'b' }, 't')).toMatchObject({ cardId: 'b' });
    expect(newTx(s, OCT, { ...tx, method: 'Credit card' }, 't')).toMatchObject({ cardId: 'a' });
    expect('cardId' in newTx(s, OCT, { ...tx, method: 'Debit card', cardId: 'b' }, 't')!).toBe(false);
    const none = withCards();
    expect(newTx(none, OCT, { ...tx, method: 'Credit card' }, 't')).toBeNull();
    expect(newFixed(none, OCT, { name: 'Gym', amount: 5, cur: 'DOP', onCard: true }, 'f')).toBeNull();
    expect(newTx(none, OCT, { ...tx, method: 'Debit card' }, 't')).not.toBeNull();
  });

  it('las ediciones descartan una tarjeta apagada o inexistente y «en tarjeta» sin tarjetas activas', () => {
    const s = withCards(card(), card({ id: 'c', name: 'Old', sort: 2, active: false }));
    expect(fixedChange(s, { cardId: 'c' })).toEqual({});
    expect(fixedChange(s, { cardId: 'a', onCard: true })).toEqual({ cardId: 'a', onCard: true });
    expect(txChange(s, { cardId: 'nope' })).toEqual({});
    expect(txChange(s, { method: 'Credit card' })).toEqual({ method: 'Credit card' });
    const none = withCards();
    expect(fixedChange(none, { onCard: true })).toEqual({});
    expect(txChange(none, { method: 'Credit card' })).toEqual({});
    expect(txChange(none, { method: 'Cash' })).toEqual({ method: 'Cash' });
  });
});
