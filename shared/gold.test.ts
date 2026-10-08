// El oro como "moneda" de una cuenta (shared/types.ts Gold): gramos que solo valen dinero con el precio escrito
// por el usuario. Cifras hechas a mano sobre los datos de ejemplo de octubre de 2026: US account 13,482 USD,
// DR account 220,641.93 DOP, 1 USD = 58.76 DOP (escrita) y, para TRY, el valor de respaldo (1 USD = 42 TRY).

import { describe, expect, it } from 'vitest';
import { balances, defaultAccount, goldValue, incomeInMonth, moneyAccounts, monthCalc, openingFor } from './calc';
import { ACCOUNT_CURRENCIES, CURRENCIES } from './constants';
import { buildExportData } from './excel/data';
import { fGrams } from './format';
import { seedState } from './seed';
import type { Account, AppState, GoldPrice, Income } from './types';

const OCT = '2026-10';
const GOLD_ACCOUNT: Account = { id: 'gold', name: 'Gold', currency: 'XAU', opening: 100, hidden: false, sort: 9 };
const GRAMS_IN: Income = { id: 'g1', date: '2026-10-05', desc: 'Bought', accountId: 'gold', amount: 25.5, cur: 'XAU', budget: false };

/** Los datos de ejemplo más una cuenta de oro con 100 g iniciales y 25.5 g que le entran en octubre. */
function withGold(price: GoldPrice | null, extra: Partial<AppState> = {}): AppState {
  const s = seedState();
  return { ...s, accounts: [...s.accounts, GOLD_ACCOUNT], incomes: [...s.incomes, GRAMS_IN], goldPrice: price, ...extra };
}

const goldOf = (s: AppState, asOf = OCT) => balances(s, asOf).accounts.find((b) => b.account.id === 'gold')!;

describe('oro: saldo en gramos y valor con el precio del oro', () => {
  it('sin precio: la cuenta se ve en gramos, no vale nada en dinero y queda fuera del total, que lo avisa', () => {
    const plain = balances(seedState(), OCT);
    const b = balances(withGold(null), OCT);
    expect(goldOf(withGold(null))).toMatchObject({ balance: 125.5, inMain: 0, inSecond: 0, valued: false });
    expect(b.totalMain).toBe(plain.totalMain);
    expect(b.totalSecond).toBe(plain.totalSecond);
    expect(b.goldExcluded).toBe(true);
    expect(plain.goldExcluded).toBe(false);
    expect(goldValue(withGold(null), OCT, 125.5, 'DOP')).toBeNull();
  });

  it('con el precio en la moneda principal: gramos × precio, y suma al total', () => {
    const s = withGold({ amount: 5000, currency: 'DOP' });
    const plain = balances(seedState(), OCT);
    const b = balances(s, OCT);
    expect(goldOf(s)).toMatchObject({ balance: 125.5, valued: true });
    expect(goldOf(s).inMain).toBeCloseTo(125.5 * 5000, 8);
    // A la segunda moneda, con la tasa del mes: 627,500 DOP ÷ 58.76.
    expect(goldOf(s).inSecond).toBeCloseTo((125.5 * 5000) / 58.76, 8);
    expect(b.totalMain).toBeCloseTo(plain.totalMain + 627500, 6);
    expect(b.totalSecond).toBeCloseTo(plain.totalSecond + 627500 / 58.76, 6);
    expect(b.goldExcluded).toBe(false);
  });

  it('con el precio en otra moneda: pasa por ella a la principal con la conversión de siempre', () => {
    // 1 g = 85 USD → 125.5 g = 10,667.5 USD = 626,822.30 DOP a 58.76.
    const usd = withGold({ amount: 85, currency: 'USD' });
    expect(goldOf(usd).inMain).toBeCloseTo(125.5 * 85 * 58.76, 6);
    expect(goldOf(usd).inSecond).toBeCloseTo(125.5 * 85, 8);
    // 1 g = 3,570 TRY, sin tasa TRY escrita: el respaldo (1 USD = 42 TRY) y de ahí a DOP → 85 USD por gramo.
    const tl = withGold({ amount: 3570, currency: 'TRY' });
    expect(goldOf(tl).inSecond).toBeCloseTo((125.5 * 3570) / 42, 6);
    expect(goldOf(tl).inMain).toBeCloseTo(((125.5 * 3570) / 42) * 58.76, 4);
    // Y sigue a la moneda principal del usuario si esta cambia.
    const inTry = withGold({ amount: 85, currency: 'USD' }, { mainCurrency: 'TRY', secondCurrency: 'USD' });
    expect(goldOf(inTry).inMain).toBeCloseTo(125.5 * 85 * 42, 6);
  });

  it('un precio que no es mayor que 0 es como no tener precio', () => {
    expect(goldOf(withGold({ amount: 0, currency: 'USD' })).valued).toBe(false);
    expect(balances(withGold({ amount: 0, currency: 'USD' }), OCT).goldExcluded).toBe(true);
  });

  it('una cuenta de oro oculta no cuenta ni hace saltar el aviso', () => {
    const hidden = withGold(null, { accounts: [...seedState().accounts, { ...GOLD_ACCOUNT, hidden: true }] });
    expect(balances(hidden, OCT).goldExcluded).toBe(false);
    const priced = { ...hidden, goldPrice: { amount: 5000, currency: 'DOP' as const } };
    expect(balances(priced, OCT).totalMain).toBe(balances(seedState(), OCT).totalMain);
  });

  it('los gramos entran por su fecha, y solo gramos: un movimiento en dinero no toca una cuenta de oro', () => {
    const s = withGold({ amount: 5000, currency: 'DOP' });
    expect(goldOf(s, '2026-09').balance).toBe(100);
    const mixed: AppState = { ...s, incomes: [...s.incomes, { ...GRAMS_IN, id: 'bad', cur: 'USD', amount: 999 }] };
    expect(goldOf(mixed).balance).toBe(125.5);
    // Corregir el saldo ajusta el inicial, en gramos: para ver 200 g hacen falta 174.5 de partida.
    expect(openingFor(s, 'gold', OCT, 200)).toBeCloseTo(174.5, 9);
  });
});

describe('oro: fuera de todo lo que es dinero', () => {
  const s = withGold({ amount: 5000, currency: 'DOP' });

  it('no es ingreso del mes ni tiene parte del presupuesto: las cifras del mes son las de siempre', () => {
    const plain = seedState();
    expect(incomeInMonth(s, OCT)).toBe(incomeInMonth(plain, OCT));
    const c = monthCalc(s, OCT);
    expect(c.income).toBe(monthCalc(plain, OCT).income);
    expect(c.budget).toBe(70000);
    expect(c.budgetParts.map((p) => p.account.id)).toEqual(['us', 'dr']);
  });

  it('nunca es la cuenta por defecto ni se ofrece entre las cuentas de dinero', () => {
    expect(moneyAccounts(s).map((a) => a.id)).toEqual(['us', 'dr']);
    expect(defaultAccount({ ...s, defaultAccountId: 'gold' })!.id).toBe('dr');
    expect(defaultAccount({ ...s, accounts: [GOLD_ACCOUNT] })).toBeNull();
  });

  it('el oro no es una moneda más: solo está en la lista de las cuentas', () => {
    expect(CURRENCIES).toEqual(['DOP', 'USD', 'TRY']);
    expect(ACCOUNT_CURRENCIES).toEqual(['DOP', 'USD', 'TRY', 'XAU']);
  });

  it('el libro de Excel sale igual con o sin oro, tenga o no precio', () => {
    const book = buildExportData(seedState());
    expect(buildExportData(s)).toEqual(book);
    expect(buildExportData(withGold(null))).toEqual(book);
  });
});

describe('fGrams', () => {
  it('dos decimales, o tres si el tercero cuenta', () => {
    expect(fGrams(125.5)).toBe('125.50');
    expect(fGrams(1.234)).toBe('1.234');
    expect(fGrams(1250)).toBe('1,250.00');
    expect(fGrams(0.0004)).toBe('0.00');
    expect(fGrams(Number.NaN)).toBe('0.00');
  });
});
