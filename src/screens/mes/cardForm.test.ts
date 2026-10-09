// El formulario de una tarjeta: qué impide guardar y qué se guarda.

import { describe, expect, it } from 'vitest';
import type { CreditCard } from '../../../shared/types';
import { cardFormErrors, cardToForm, formToInput, newCardForm } from './cardForm';

const card: CreditCard = { id: 'a', name: 'Visa', bank: 'Popular', last4: '4242', cur: 'USD', limit: 60000, cutoffDay: 13, dueDay: null, active: false, sort: 0 };

describe('cardForm', () => {
  it('una tarjeta nueva nace en la moneda principal, activa y vacía; sin nombre no se guarda', () => {
    const form = newCardForm('TRY');
    expect(form).toMatchObject({ name: '', cur: 'TRY', active: true, limit: '', cutoffDay: '', dueDay: '' });
    expect(cardFormErrors(form, [], null)).toEqual(['name']);
    expect(cardFormErrors({ ...form, name: 'Visa' }, [], null)).toEqual([]);
  });

  it('el día de pago puede quedar vacío; los días van de 1 a 31, el límite > 0 y los dígitos son 4', () => {
    const ok = { ...newCardForm('DOP'), name: 'A' };
    expect(cardFormErrors({ ...ok, dueDay: '' }, [], null)).toEqual([]);
    expect(cardFormErrors({ ...ok, cutoffDay: '0', dueDay: '32' }, [], null)).toEqual(['cutoffDay', 'dueDay']);
    expect(cardFormErrors({ ...ok, cutoffDay: '31', dueDay: '1' }, [], null)).toEqual([]);
    expect(cardFormErrors({ ...ok, cutoffDay: '1.5' }, [], null)).toEqual(['cutoffDay']);
    expect(cardFormErrors({ ...ok, limit: '0' }, [], null)).toEqual(['limit']);
    expect(cardFormErrors({ ...ok, limit: '60000' }, [], null)).toEqual([]);
    expect(cardFormErrors({ ...ok, last4: '12' }, [], null)).toEqual(['last4']);
  });

  it('el nombre repetido se avisa, pero no contra la propia tarjeta', () => {
    const form = { ...newCardForm('DOP'), name: ' visa ' };
    expect(cardFormErrors(form, [card], null)).toEqual(['nameTaken']);
    expect(cardFormErrors(form, [card], 'a')).toEqual([]);
  });

  it('lo vacío se guarda como null y los números como números', () => {
    expect(formToInput({ ...newCardForm('DOP'), name: ' Visa ', limit: '60000', cutoffDay: '13' })).toEqual({
      name: 'Visa',
      bank: null,
      last4: null,
      cur: 'DOP',
      limit: 60000,
      cutoffDay: 13,
      dueDay: null,
      active: true,
    });
    expect(formToInput(cardToForm(card))).toEqual({ name: 'Visa', bank: 'Popular', last4: '4242', cur: 'USD', limit: 60000, cutoffDay: 13, dueDay: null, active: false });
  });
});
