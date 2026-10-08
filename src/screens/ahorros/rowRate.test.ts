// Lógica nueva de Savings: tasa propia y cuenta de origen en los borradores y los cambios, y el mes de la tabla de
// ingresos (sin React).

import { describe, expect, it } from 'vitest';
import { seedState } from '../../../shared/seed';
import { accountInUse, canRemoveAccount, contributionChange, incomeChange, newContribution, newIncome } from '../../store/reducers';
import { afterAdd, autoRate, EMPTY_DRAFT, EMPTY_INCOME, incomeDraftInput, incomeItems, incomeMonthKeys, incomeTotalOf, monthDraftDate, resolveDraft } from './model';

const goals = seedState().goals;

describe('tasa propia en los borradores y en los cambios', () => {
  it('un ingreso en la moneda principal o a una cuenta de oro no lleva tasa; en otra moneda sí, y se limpia al agregar', () => {
    const s = seedState();
    const usd = incomeDraftInput({ ...EMPTY_INCOME, accountId: 'us', amount: 10, rate: 60 }, s, '2026-10-07');
    expect(usd).toMatchObject({ cur: 'USD', rate: 60 });
    expect(incomeDraftInput({ ...EMPTY_INCOME, accountId: 'dr', amount: 10, rate: 60 }, s, '2026-10-07')).toMatchObject({ cur: 'DOP', rate: null });
    expect(newIncome(s, { date: '2026-10-07', accountId: 'us', amount: 10, cur: 'USD', rate: 60, recurring: true }, 'n')).toMatchObject({ rate: 60, recurring: true });
    expect(newIncome(s, { date: '2026-10-07', accountId: 'us', amount: 10, cur: 'USD', rate: -3 }, 'n')).toMatchObject({ rate: null, recurring: false });
  });

  it('incomeChange y contributionChange: rate null o > 0; lo demás se descarta', () => {
    const s = seedState();
    expect(incomeChange(s, 'seed-in-3', { rate: 61 })).toEqual({ rate: 61 });
    expect(incomeChange(s, 'seed-in-3', { rate: null })).toEqual({ rate: null });
    expect(incomeChange(s, 'seed-in-3', { rate: 0 })).toEqual({});
    expect(incomeChange(s, 'seed-in-3', { recurring: true })).toEqual({ recurring: true });
    expect(contributionChange(s, { rate: 0 })).toEqual({});
    expect(contributionChange(s, { rate: 60, accountId: null })).toEqual({ rate: 60, accountId: null });
  });

  it('aportes: la cuenta debe ser de dinero y existir; la tasa y la cuenta del borrador se resuelven y se limpian al agregar', () => {
    const s = seedState();
    const ok = { goalId: 'emergency', date: '2026-10-07', amount: 5, cur: 'USD' as const };
    expect(newContribution(s, { ...ok, accountId: 'us', rate: 60 }, 'c')).toMatchObject({ accountId: 'us', rate: 60 });
    expect(newContribution(s, { ...ok, accountId: 'nope' }, 'c')).toMatchObject({ accountId: null, rate: null });
    // En la moneda principal no hay tasa que guardar.
    expect(resolveDraft({ ...EMPTY_DRAFT, cur: 'DOP', rate: 60 }, goals, '2026-10-07', 'DOP').rate).toBeNull();
    expect(resolveDraft({ ...EMPTY_DRAFT, cur: 'USD', rate: 60, accountId: 'us' }, goals, '2026-10-07', 'DOP')).toMatchObject({ rate: 60, accountId: 'us' });
    expect(afterAdd({ ...EMPTY_DRAFT, amount: 5, rate: 60, accountId: 'us' })).toEqual({ ...EMPTY_DRAFT, accountId: 'us' });
  });

  it('una cuenta que un aporte usa no se puede eliminar', () => {
    const s = seedState();
    s.contribs[0]!.accountId = 'us';
    expect(accountInUse(s, 'us')).toBe(true);
    expect(canRemoveAccount(s, 'us')).toBe(false);
  });

  it('la tasa automática que se muestra es la vigente en la fecha; sin control en la principal', () => {
    const s = seedState();
    expect(autoRate(s, '2026-10-07', 'USD')).toBe(58.76);
    expect(autoRate(s, '2026-10-07', 'DOP')).toBeNull();
    expect(autoRate(s, '2026-10-07', 'XAU')).toBeNull();
  });
});

describe('el mes de la tabla de ingresos', () => {
  it('ofrece los meses registrados, los que tienen ingresos y el elegido, en orden', () => {
    const s = seedState();
    s.incomes.push({ id: 'old', date: '2026-03-02', desc: '', accountId: 'dr', amount: 1, cur: 'DOP', budget: false });
    expect(incomeMonthKeys(s, '2026-10')).toEqual(['2026-03', '2026-08', '2026-09', '2026-10']);
    expect(incomeMonthKeys(s, '2027-01').at(-1)).toBe('2027-01');
  });

  it('solo lista los ingresos con fecha en el mes (los de oro, en Savings) y su total es el del mes', () => {
    const s = seedState();
    s.accounts.push({ id: 'gold', name: 'Gold', currency: 'XAU', opening: 0, hidden: false, sort: 9 });
    s.incomes.push({ id: 'g', date: '2026-09-20', desc: '', accountId: 'gold', amount: 2, cur: 'XAU', budget: false });
    expect(incomeItems(s, 'en', '2026-09', true).map((i) => i.id)).toEqual(['g', 'seed-in-2']);
    expect(incomeItems(s, 'en', '2026-09').map((i) => i.id)).toEqual(['seed-in-2']);
    expect(incomeItems(s, 'en', '2026-07', true)).toEqual([]);
    expect(incomeTotalOf(s, '2026-09')).toBeCloseTo(339731.22, 2);
  });

  it('la fecha que propone la fila de agregar es hoy si es el mes en curso y, si no, el día 1', () => {
    expect(monthDraftDate('2026-10', '2026-10-07')).toBe('2026-10-07');
    expect(monthDraftDate('2026-09', '2026-10-07')).toBe('2026-09-01');
  });
});
