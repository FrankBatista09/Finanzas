// The form of a credit card's dialog: what the user types (everything as text, a half-typed field
// is not a number), what is missing or wrong, and what the saved data looks like. No React and no UI text.

import type { Currency, CreditCard } from '../../../shared/types';
import type { CardInput } from '../../store';

export interface CardForm {
  name: string;
  bank: string;
  last4: string;
  cur: Currency;
  limit: string;
  cutoffDay: string;
  dueDay: string;
  active: boolean;
}

export type CardFormError = 'name' | 'nameTaken' | 'last4' | 'limit' | 'cutoffDay' | 'dueDay';

/** A new credit card starts in the user's main currency, turned on and with no other data. */
export function newCardForm(main: Currency): CardForm {
  return { name: '', bank: '', last4: '', cur: main, limit: '', cutoffDay: '', dueDay: '', active: true };
}

export function cardToForm(card: CreditCard): CardForm {
  return {
    name: card.name,
    bank: card.bank ?? '',
    last4: card.last4 ?? '',
    cur: card.cur,
    limit: card.limit === null ? '' : String(card.limit),
    cutoffDay: card.cutoffDay === null ? '' : String(card.cutoffDay),
    dueDay: card.dueDay === null ? '' : String(card.dueDay),
    active: card.active,
  };
}

const blank = (text: string) => text.trim() === '';
const fold = (t: string) => t.trim().normalize('NFC').toLowerCase();

/** A typed day of the month: empty is valid (it is optional); otherwise, an integer from 1 to 31. */
const dayOk = (text: string) => blank(text) || (/^\d{1,2}$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 31);

/** What blocks saving. `id` is the credit card being edited (its own name does not count as repeated). */
export function cardFormErrors(form: CardForm, cards: readonly CreditCard[], id: string | null): CardFormError[] {
  const errors: CardFormError[] = [];
  if (blank(form.name)) errors.push('name');
  else if (cards.some((c) => c.id !== id && fold(c.name) === fold(form.name))) errors.push('nameTaken');
  if (!blank(form.last4) && !/^\d{4}$/.test(form.last4.trim())) errors.push('last4');
  if (!blank(form.limit) && !(Number(form.limit) > 0)) errors.push('limit');
  if (!dayOk(form.cutoffDay)) errors.push('cutoffDay');
  if (!dayOk(form.dueDay)) errors.push('dueDay');
  return errors;
}

/** The data to save: empty is null (no data). Only with a form that has no errors. */
export function formToInput(form: CardForm): CardInput {
  const num = (text: string) => (blank(text) ? null : Number(text));
  return {
    name: form.name.trim(),
    bank: form.bank.trim() || null,
    last4: form.last4.trim() || null,
    cur: form.cur,
    limit: num(form.limit),
    cutoffDay: num(form.cutoffDay),
    dueDay: num(form.dueDay),
    active: form.active,
  };
}
