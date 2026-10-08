// Tasa propia por ingreso y por aporte, y la cuenta de la que sale un aporte: cifras calculadas a mano sobre los
// datos de ejemplo (1 USD = 58.76 DOP en octubre de 2026; moneda principal DOP).

import { describe, expect, it } from 'vitest';
import { balances, contribIn, goalProgress, incomeInMonth, incomeIn, incomeRows, ownRate, savedInMonth } from './calc';
import { seedState } from './seed';
import type { AppState } from './types';

const balanceOf = (s: AppState, id: string) => balances(s, '2026-10').accounts.find((a) => a.account.id === id)!.balance;

describe('ingresos con tasa propia', () => {
  it('la tasa propia manda en la columna principal, en el total del mes y en "Income by month"', () => {
    const s = seedState();
    expect(incomeInMonth(s, '2026-10')).toBeCloseTo(5800 * 58.76, 6);
    s.incomes.find((i) => i.id === 'seed-in-3')!.rate = 60;
    expect(incomeInMonth(s, '2026-10')).toBeCloseTo(5800 * 60, 6);
    expect(incomeRows(s).find((r) => r.key === '2026-10')!.income).toBeCloseTo(5800 * 60, 6);
    // Los otros meses no cambian.
    expect(incomeInMonth(s, '2026-09')).toBeCloseTo(339731.22, 2);
  });

  it('rate null o ausente es la automática; en la moneda principal (o en oro) la tasa no cuenta', () => {
    const s = seedState();
    const auto = incomeInMonth(s, '2026-10');
    s.incomes[2]!.rate = null;
    expect(incomeInMonth(s, '2026-10')).toBe(auto);
    s.incomes.push({ id: 'dop', date: '2026-10-09', desc: '', accountId: 'dr', amount: 1000, cur: 'DOP', budget: false, rate: 99 });
    expect(incomeInMonth(s, '2026-10')).toBeCloseTo(auto + 1000, 6);
    expect(ownRate(s, { cur: 'DOP', rate: 99 })).toBeNull();
    expect(ownRate(s, { cur: 'XAU', rate: 99 })).toBeNull();
    expect(ownRate(s, { cur: 'USD', rate: 0 })).toBeNull();
    expect(ownRate(s, { cur: 'USD', rate: 60 })).toBe(60);
  });

  it('solo gobierna la conversión a la moneda principal: saldos y el presupuesto del ingreso siguen la tasa de su fecha', () => {
    const s = seedState();
    const before = balanceOf(s, 'dr');
    s.incomes.push({ id: 'x', date: '2026-10-09', desc: '', accountId: 'dr', amount: 100, cur: 'USD', budget: true, rate: 70 });
    const withRate = balanceOf(s, 'dr');
    s.incomes.at(-1)!.rate = null;
    expect(balanceOf(s, 'dr')).toBe(withRate);
    expect(withRate).toBeCloseTo(before + 100 * 58.76, 6);
    // Hacia otra moneda que no es la principal, la tasa propia tampoco entra.
    expect(incomeIn(s, { ...s.incomes.at(-1)!, cur: 'USD', rate: 70 }, 'TRY')).toBeCloseTo(incomeIn(s, { ...s.incomes.at(-1)!, cur: 'USD', rate: null }, 'TRY'), 8);
  });
});

describe('aportes con tasa propia', () => {
  it('hacia la moneda principal usa la tasa propia; la meta en la principal recibe el monto ya convertido', () => {
    const s = seedState();
    s.goals.push({ id: 'dop', name: 'Pesos', cur: 'DOP', monthly: null, start: null, end: null, approxCur: null, sort: 9 });
    s.contribs = [{ id: 'a', goalId: 'dop', date: '2026-10-10', amount: 100, cur: 'USD', rate: 60 }];
    expect(contribIn(s, s.contribs[0]!, 'DOP')).toBe(6000);
    expect(goalProgress(s, s.goals.at(-1)!).saved).toBe(6000);
    expect(savedInMonth(s, '2026-10')).toBe(6000);
  });

  it('meta en otra moneda: la meta suma el monto tal cual y su valor en la principal queda fijo en la tasa propia', () => {
    const s = seedState();
    const emergency = s.goals.find((g) => g.id === 'emergency')!;
    s.contribs = [
      { id: 'a', goalId: 'emergency', date: '2026-10-10', amount: 100, cur: 'USD', rate: 60 },
      { id: 'b', goalId: 'emergency', date: '2026-10-11', amount: 200, cur: 'USD' },
    ];
    const p = goalProgress(s, emergency);
    expect(p.saved).toBe(300);
    // 100 × 60 fijo + 200 × 58.76 (la tasa del mes en curso).
    expect(p.savedMain).toBeCloseTo(6000 + 200 * 58.76, 6);
    // Sin tasa propia es lo de siempre.
    s.contribs[0]!.rate = null;
    expect(goalProgress(s, emergency).savedMain).toBeCloseTo(300 * 58.76, 6);
  });

  it('tercera moneda: la meta se convierte como siempre; solo contribución → principal usa la tasa propia', () => {
    const s = seedState();
    s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    s.goals.push({ id: 'try', name: 'Lira', cur: 'TRY', monthly: null, start: null, end: null, approxCur: null, sort: 9 });
    s.contribs = [{ id: 'a', goalId: 'try', date: '2026-10-10', amount: 100, cur: 'USD', rate: 60 }];
    const p = goalProgress(s, s.goals.at(-1)!);
    expect(p.saved).toBeCloseTo(4000, 8);
    expect(p.savedMain).toBeCloseTo(6000, 8);
  });
});

describe('cuenta de origen de un aporte', () => {
  it('resta de su saldo, en la moneda de la cuenta y con la tasa de la fecha del aporte', () => {
    const s = seedState();
    const dr = balanceOf(s, 'dr');
    const us = balanceOf(s, 'us');
    s.contribs = [{ id: 'a', goalId: 'emergency', date: '2026-10-10', amount: 100, cur: 'USD', accountId: 'dr' }];
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr - 100 * 58.76, 6);
    // En la misma moneda no se convierte.
    s.contribs[0]!.accountId = 'us';
    expect(balanceOf(s, 'us')).toBeCloseTo(us - 100, 8);
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr, 8);
  });

  it('con tasa propia, el aporte hacia una cuenta en la moneda principal resta a esa tasa; sin cuenta no mueve nada', () => {
    const s = seedState();
    const dr = balanceOf(s, 'dr');
    s.contribs = [{ id: 'a', goalId: 'emergency', date: '2026-10-10', amount: 100, cur: 'USD', accountId: 'dr', rate: 60 }];
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr - 6000, 8);
    s.contribs[0]!.accountId = null;
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr, 8);
    // Un aporte posterior al mes que se mira no cuenta todavía.
    s.contribs[0]!.accountId = 'dr';
    s.contribs[0]!.date = '2026-11-02';
    expect(balanceOf(s, 'dr')).toBeCloseTo(dr, 8);
  });
});
