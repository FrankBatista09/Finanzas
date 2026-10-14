// A credit card's form: what blocks saving and what gets saved.

import { describe, expect, it } from 'vitest';
import type { CreditCard } from '../../../shared/types';
import { cardFormErrors, cardToForm, formToInput, newCardForm } from './cardForm';

const card: CreditCard = { id: 'a', name: 'Visa', bank: 'Popular', last4: '4242', cur: 'USD', limit: 60000, cutoffDay: 13, dueDay: null, active: false, sort: 0 };

describe('cardForm', () => {
  it('a new credit card starts in the main currency, active and empty; without a name it is not saved', () => {
    const form = newCardForm('TRY');
    expect(form).toMatchObject({ name: '', cur: 'TRY', active: true, limit: '', cutoffDay: '', dueDay: '' });
    expect(cardFormErrors(form, [], null)).toEqual(['name']);
    expect(cardFormErrors({ ...form, name: 'Visa' }, [], null)).toEqual([]);
  });

  it('the due day can stay empty; days go from 1 to 31, the limit is > 0 and there are 4 digits', () => {
    const ok = { ...newCardForm('DOP'), name: 'A' };
    expect(cardFormErrors({ ...ok, dueDay: '' }, [], null)).toEqual([]);
    expect(cardFormErrors({ ...ok, cutoffDay: '0', dueDay: '32' }, [], null)).toEqual(['cutoffDay', 'dueDay']);
    expect(cardFormErrors({ ...ok, cutoffDay: '31', dueDay: '1' }, [], null)).toEqual([]);
    expect(cardFormErrors({ ...ok, cutoffDay: '1.5' }, [], null)).toEqual(['cutoffDay']);
    expect(cardFormErrors({ ...ok, limit: '0' }, [], null)).toEqual(['limit']);
    expect(cardFormErrors({ ...ok, limit: '60000' }, [], null)).toEqual([]);
    expect(cardFormErrors({ ...ok, last4: '12' }, [], null)).toEqual(['last4']);
  });

  it('a repeated name is flagged, but not against the credit card itself', () => {
    const form = { ...newCardForm('DOP'), name: ' visa ' };
    expect(cardFormErrors(form, [card], null)).toEqual(['nameTaken']);
    expect(cardFormErrors(form, [card], 'a')).toEqual([]);
  });

  it('empty values are saved as null and numbers as numbers', () => {
    expect(formToInput({ ...newCardForm('DOP'), name: ' Visa ', limit: '60000', cutoffDay: '13' })).toEqual({
      name: 'Visa',
      bank: null,
      last4: null,
      cur: 'DOP',
      limit: 60000,
      cutoffDay: 13,
      dueDay: null,
      active: true,
      cashback: false,
    });
    expect(formToInput(cardToForm(card))).toEqual({ name: 'Visa', bank: 'Popular', last4: '4242', cur: 'USD', limit: 60000, cutoffDay: 13, dueDay: null, active: false, cashback: false });
    expect(formToInput(cardToForm({ ...card, cashback: true })).cashback).toBe(true);
  });
});
