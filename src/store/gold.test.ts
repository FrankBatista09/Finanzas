// Las reglas del oro en la capa de datos de la web: lo que el servidor rechazaría no llega a enviarse, y lo que
// se ofrece en cada selector. Una cuenta de oro (gramos, 'XAU') solo tiene saldo inicial e ingresos en gramos.

import { describe, expect, it } from 'vitest';
import { seedState } from '../../shared/seed';
import type { Account, AppState, Income } from '../../shared/types';
import { EMPTY_INCOME, EMPTY_MONTH_INCOME, incomeItems, resolveIncomeDraft } from '../screens/ahorros/model';
import {
  budgetPart,
  canHideAccount,
  fixedChange,
  goldPriceChange,
  incomeChange,
  newAccount,
  newBudgetEntry,
  newFixed,
  newIncome,
  newTransfer,
  newTx,
  openingForBalance,
  reduce,
  transferChange,
  txChange,
} from './reducers';
import { accountOptions, incomeAccountOptions } from './view';

const OCT = '2026-10';
const GOLD: Account = { id: 'gold', name: 'Gold', currency: 'XAU', opening: 100, hidden: false, sort: 9 };
const GRAMS: Income = { id: 'g1', date: '2026-10-05', desc: 'Bought', accountId: 'gold', amount: 25.5, cur: 'XAU', budget: false };

function withGold(): AppState {
  const s = seedState();
  return { ...s, accounts: [...s.accounts, GOLD], incomes: [...s.incomes, GRAMS] };
}

describe('cuentas de oro', () => {
  const s = withGold();

  it('newAccount acepta el oro, con los gramos iniciales a tres decimales', () => {
    expect(newAccount(seedState(), { name: 'Gold', currency: 'XAU', opening: 125.50049 }, 'x')).toEqual({
      id: 'x',
      name: 'Gold',
      currency: 'XAU',
      opening: 125.5,
      hidden: false,
      sort: 2,
    });
    expect(newAccount(seedState(), { name: 'Gold', currency: 'XAU', opening: 1.2346 }, 'x')!.opening).toBe(1.235);
    // El dinero no se recorta.
    expect(newAccount(seedState(), { name: 'PayPal', currency: 'USD', opening: 1.23456 }, 'x')!.opening).toBe(1.23456);
  });

  it('corregir su saldo corrige los gramos; ocultarla se puede siempre, pero no la última de dinero', () => {
    // 25.5 g entraron: para ver 200.0004 → 200 g hacen falta 174.5 de partida.
    expect(openingForBalance(s, OCT, 'gold', 200.0004)).toBe(174.5);
    expect(canHideAccount(s, 'gold')).toBe(true);
    const oneMoney: AppState = { ...s, accounts: [s.accounts[0]!, GOLD] };
    expect(canHideAccount(oneMoney, 'gold')).toBe(true);
    expect(canHideAccount(oneMoney, s.accounts[0]!.id)).toBe(false);
  });

  it('no se puede elegir para nada que sea dinero', () => {
    const tx = { date: '2026-10-07', desc: 'Coin', cat: 'Other', method: 'Cash', amount: 1, cur: 'USD' as const };
    const transfer = { date: '2026-10-07', via: 'Shop', amount: 100 };
    expect(newFixed(s, OCT, { name: 'Vault', amount: 1, cur: 'USD', accountId: 'gold' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...tx, accountId: 'gold' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...tx, accountId: 'us' }, 'x')).not.toBeNull();
    expect(newTransfer(s, OCT, { ...transfer, fromAccountId: 'us', toAccountId: 'gold' }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...transfer, fromAccountId: 'gold', toAccountId: 'dr', rate: 5000 }, 'x')).toBeNull();
    expect(newBudgetEntry(s, OCT, { accountId: 'gold', amount: 5 }, 'x', '2026-10-07')).toBeNull();
    expect(budgetPart(s, OCT, 'gold', 5)).toBeNull();
    expect(budgetPart(s, OCT, 'dr', 5)).not.toBeNull();
    // En una celda, la cuenta de oro se ignora y lo demás se guarda.
    expect(fixedChange(s, { accountId: 'gold', amount: 9 })).toEqual({ amount: 9 });
    expect(txChange(s, { accountId: 'gold', notes: 'x' })).toEqual({ notes: 'x' });
    const transferId = s.months[OCT]!.transfers[0]!.id;
    expect(transferChange(s, transferId, { toAccountId: 'gold', amount: 7 })).toEqual({ amount: 7 });
    expect(transferChange(s, transferId, { fromAccountId: 'gold' })).toEqual({});
  });

  it('solo se ofrece para los ingresos de Savings', () => {
    expect(accountOptions(s).map((o) => o.value)).toEqual(['us', 'dr']);
    expect(incomeAccountOptions(s).map((o) => o.value)).toEqual(['us', 'dr', 'gold']);
    // La hoja del mes ni la ofrece ni lista sus ingresos; Savings sí, en gramos y sin equivalente.
    expect(incomeItems(s, 'en', OCT).map((i) => i.id)).toEqual(['seed-in-3']);
    expect(incomeItems(s, 'en').find((i) => i.id === 'g1')).toMatchObject({ amount: 25.5, amountText: '25.50', cur: 'XAU', budget: false, main: '—' });
    const picked = { ...EMPTY_MONTH_INCOME, accountId: 'gold', cur: 'USD' as const };
    expect(resolveIncomeDraft(picked, s, '2026-10-07')).toMatchObject({ accountId: 'dr', cur: 'USD', budget: true });
    expect(resolveIncomeDraft(picked, s, '2026-10-07', true)).toMatchObject({ accountId: 'gold', cur: 'XAU', budget: false });
    expect(resolveIncomeDraft({ ...EMPTY_INCOME, accountId: 'us' }, s, '2026-10-07', true)).toMatchObject({ accountId: 'us', cur: 'USD' });
  });
});

describe('ingresos en gramos', () => {
  const s = withGold();

  it('newIncome: a una cuenta de oro entran gramos, sin presupuesto, se indique lo que se indique', () => {
    expect(newIncome(s, { date: '2026-10-07', accountId: 'gold', amount: 2.12549, cur: 'USD', budget: true }, 'x')).toEqual({
      id: 'x',
      date: '2026-10-07',
      desc: '',
      accountId: 'gold',
      amount: 2.125,
      cur: 'XAU',
      budget: false,
    });
    // Menos de un miligramo no es nada.
    expect(newIncome(s, { date: '2026-10-07', accountId: 'gold', amount: 0.0004, cur: 'XAU' }, 'x')).toBeNull();
    // A una cuenta de dinero no le valen los gramos; sin cuenta va a la de por defecto, que nunca es de oro.
    expect(newIncome(s, { date: '2026-10-07', accountId: 'us', amount: 1, cur: 'XAU' }, 'x')).toBeNull();
    expect(newIncome(s, { date: '2026-10-07', amount: 1, cur: 'XAU' }, 'x')).toBeNull();
    expect(newIncome(s, { date: '2026-10-07', amount: 1, cur: 'USD' }, 'x')).toMatchObject({ accountId: 'dr', cur: 'USD' });
  });

  it('incomeChange: la moneda y la casilla siguen a la cuenta en la que queda el ingreso', () => {
    // Un ingreso de dinero que sube el presupuesto pasa a una cuenta de oro: gramos y sin presupuesto.
    const raising: AppState = { ...s, incomes: s.incomes.map((i) => (i.id === 'seed-in-3' ? { ...i, budget: true } : i)) };
    expect(incomeChange(raising, 'seed-in-3', { accountId: 'gold' })).toEqual({ accountId: 'gold', cur: 'XAU', budget: false });
    expect(incomeChange(s, 'seed-in-3', { accountId: 'gold' })).toEqual({ accountId: 'gold', cur: 'XAU' });
    // Uno en gramos: ni otra moneda ni la casilla; los gramos, a tres decimales.
    expect(incomeChange(s, 'g1', { cur: 'USD' })).toEqual({});
    expect(incomeChange(s, 'g1', { budget: true, amount: 30.00049 })).toEqual({ amount: 30 });
    // Al sacarlo a una cuenta de dinero toma su moneda.
    expect(incomeChange(s, 'g1', { accountId: 'us' })).toEqual({ accountId: 'us', cur: 'USD' });
    // A uno de dinero no se le pueden poner gramos sin cambiarlo de cuenta.
    expect(incomeChange(s, 'seed-in-3', { cur: 'XAU', desc: 'x' })).toEqual({ desc: 'x' });
    expect(incomeChange(s, 'seed-in-3', { cur: 'TRY', budget: true })).toEqual({ cur: 'TRY', budget: true });
    expect(incomeChange(s, 'nope', { amount: 1 })).toEqual({});
  });
});

describe('precio del oro', () => {
  const s = seedState();
  const priced: AppState = { ...s, goldPrice: { amount: 85, currency: 'USD' } };

  it('goldPriceChange: un monto mayor que 0 lo escribe, 0 lo quita y lo que no cambia no se manda', () => {
    expect(goldPriceChange(s, 85, 'USD')).toEqual({ goldPrice: { amount: 85, currency: 'USD' } });
    expect(goldPriceChange(priced, 85, 'USD')).toEqual({});
    expect(goldPriceChange(priced, 85, 'TRY')).toEqual({ goldPrice: { amount: 85, currency: 'TRY' } });
    expect(goldPriceChange(priced, 0, 'USD')).toEqual({ goldPrice: null });
    expect(goldPriceChange(s, 0, 'USD')).toEqual({});
    expect(goldPriceChange(s, -1, 'USD')).toBeNull();
    expect(goldPriceChange(s, Number.NaN, 'USD')).toBeNull();
    expect(goldPriceChange(s, 85, 'XAU' as 'USD')).toBeNull();
  });

  it('settings/patch lo aplica, lo quita con null y es idempotente', () => {
    const set = reduce(s, { type: 'settings/patch', patch: { goldPrice: { amount: 85, currency: 'USD' } } });
    expect(set.goldPrice).toEqual({ amount: 85, currency: 'USD' });
    expect(reduce(set, { type: 'settings/patch', patch: { goldPrice: { amount: 85, currency: 'USD' } } })).toBe(set);
    // Otro ajuste no lo toca.
    expect(reduce(set, { type: 'settings/patch', patch: { language: 'es' } }).goldPrice).toBe(set.goldPrice);
    const cleared = reduce(set, { type: 'settings/patch', patch: { goldPrice: null } });
    expect(cleared.goldPrice).toBeNull();
    expect(reduce(cleared, { type: 'settings/patch', patch: { goldPrice: null } })).toBe(cleared);
  });
});
