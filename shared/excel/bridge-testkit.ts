// Solo para pruebas (data.test.ts y export-libreoffice.test.ts): estados de la app con los que se prueba el
// puente entre el modelo de cuentas y el libro de Excel (data.ts).

import { DEFAULT_ACCOUNTS, DEFAULT_GOALS, DEFAULT_MAIN_CURRENCY, DEFAULT_RATE, DEFAULT_SECOND_CURRENCY } from '../constants';
import { seedState, setBudgets } from '../seed';
import type { AppState, Currency, MonthKey, Transaction, Transfer } from '../types';

/** Un usuario recién llegado, como lo deja el servidor: sus cuentas y metas iniciales y el mes actual, vacío. */
export function newUserState(current: MonthKey = '2026-10'): AppState {
  return {
    mainCurrency: DEFAULT_MAIN_CURRENCY,
    secondCurrency: DEFAULT_SECOND_CURRENCY,
    defaultAccountId: null,
    defaultRate: DEFAULT_RATE,
    goldPrice: null,
    theme: null,
    language: 'en',
    accounts: DEFAULT_ACCOUNTS.map((a) => ({ ...a })),
    incomes: [],
    goals: DEFAULT_GOALS.map((g) => ({ ...g })),
    contribs: [],
    cards: [],
    months: { [current]: { key: current, closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] } },
  };
}

/**
 * Los datos de ejemplo más todo lo que el libro no sabe representar: moneda principal TRY, una cuenta en TRY,
 * otra en USD y otra en DOP además de las dos de siempre, dos cuentas ocultas, gastos fijos, transacciones,
 * ingresos y aportes en TRY, una meta en TRY con plan, otra en DOP y una con el plan a medias, envíos en todos
 * los sentidos (también entre cuentas de la misma moneda) y el presupuesto repartido entre varias cuentas.
 *
 * Las tasas de cada mes son coherentes entre sí, que es cuando el dinero total del libro coincide con el de la
 * app: cada mes tiene tasa propia para dos de los tres pares y el tercero sale de cruzarlos (o cuadra con ellos).
 *  · agosto: USD↔DOP de sus envíos y USD→TRY escrita a mano;
 *  · septiembre: USD↔DOP de sus envíos y USD→TRY escrita a mano, la que dan sus envíos (en los dos sentidos);
 *  · octubre: USD↔DOP y TRY↔DOP de sus envíos (en los dos sentidos) y USD→TRY escrita a mano, la que sale de
 *    cruzar las otras dos.
 * Una tasa escrita sigue vigente hasta que se escribe otra: por eso, escrita la de agosto, septiembre y octubre
 * llevan la suya desde su día 1 (sin ella valdría la de agosto y el mes dejaría de cuadrar con sus envíos).
 * Ningún mes tiene escrita la tasa USD→DOP: la app la saca de los envíos, igual que el libro.
 */
export function mixedState(): AppState {
  const s = seedState();
  s.mainCurrency = 'TRY';
  s.secondCurrency = 'DOP';
  s.defaultAccountId = 'tr';
  s.accounts.push(
    { id: 'tr', name: 'TR account', currency: 'TRY', opening: 50000, hidden: false, sort: 2 },
    { id: 'pp', name: 'PayPal', currency: 'USD', opening: 300, hidden: false, sort: 3 },
    { id: 'cash', name: 'Cash', currency: 'DOP', opening: 5000, hidden: false, sort: 4 },
    { id: 'old', name: 'Old bank', currency: 'USD', opening: 999, hidden: true, sort: 5 },
    { id: 'box', name: 'Piggy bank', currency: 'DOP', opening: 1234, hidden: true, sort: 6 },
  );

  const aug = s.months['2026-08']!;
  const sep = s.months['2026-09']!;
  const oct = s.months['2026-10']!;
  aug.rates = [{ from: 'USD', to: 'TRY', rate: 39, date: '2026-08-01' }];
  // Septiembre: 500 USD → 19,700 TRY y 3,950 TRY → 100.33 USD. Octubre: USD→DOP (102,785 DOP por 1,750 USD)
  // entre TRY→DOP (4,350 DOP por 3,001 TRY), las dos de sus envíos.
  sep.rates = [{ from: 'USD', to: 'TRY', rate: (500 * 39.4 + 3950) / (500 + 3950 * 0.0254), date: '2026-09-01' }];
  oct.rates = [
    {
      from: 'USD',
      to: 'TRY',
      rate: (1500 * 58.76 + 11700 + 50 * 58.9) / (1500 + 11700 / 58.5 + 50) / ((1000 * 1.45 + 2900) / (1000 + 2900 * 0.69)),
      date: '2026-10-01',
    },
  ];

  const transfer = (key: MonthKey, n: number, day: string, via: string, from: string, to: string, amount: number, rate: number): Transfer => ({
    id: `mx-tr-${key}-${n}`,
    monthKey: key,
    date: `${key}-${day}`,
    via,
    fromAccountId: from,
    toAccountId: to,
    amount,
    rate,
    budget: false, fee: 0,
  });
  sep.transfers.push(
    transfer('2026-09', 1, '05', 'Wise', 'us', 'tr', 500, 39.4),
    transfer('2026-09', 2, '12', 'Wise', 'tr', 'pp', 3950, 0.0254),
    transfer('2026-09', 3, '20', 'PayPal', 'us', 'pp', 250, 1),
  );
  oct.transfers.push(
    transfer('2026-10', 1, '04', 'Bank', 'dr', 'us', 11700, 1 / 58.5),
    transfer('2026-10', 2, '05', 'Remitly', 'old', 'dr', 50, 58.9),
    transfer('2026-10', 3, '06', 'Cash', 'tr', 'dr', 1000, 1.45),
    transfer('2026-10', 4, '07', 'Cash', 'dr', 'tr', 2900, 0.69),
    transfer('2026-10', 5, '08', 'ATM', 'dr', 'cash', 3000, 1),
  );

  const tx = (
    key: MonthKey,
    n: number,
    day: string,
    desc: string,
    cat: string,
    amount: number,
    cur: Currency,
    accountId: string,
    notes = '',
  ): Transaction => ({
    id: `mx-tx-${key}-${n}`,
    monthKey: key,
    date: `${key}-${day}`,
    desc,
    place: '',
    cat,
    method: 'Debit card',
    amount,
    cur,
    accountId,
    notes,
    source: 'web',
    createdAt: null,
  });
  sep.tx.push(tx('2026-09', 1, '13', 'Baklava', 'Food', 1250, 'TRY', 'tr'));
  oct.tx.push(
    tx('2026-10', 1, '08', 'Seat selection', 'Travel', 2400.5, 'TRY', 'tr', 'Turkish Airlines'),
    // En TRY pero pagado desde la cuenta en DOP.
    tx('2026-10', 2, '09', 'Gift for Eda', 'Home', 600, 'TRY', 'dr'),
    tx('2026-10', 3, '09', 'Domain', 'Subscriptions', 12.5, 'USD', 'pp'),
    // Pagado desde una cuenta oculta: cuenta como gasto del mes, pero su saldo no entra en el dinero total.
    tx('2026-10', 4, '10', 'Snacks', 'Food', 200, 'DOP', 'box'),
  );
  oct.fixed.push(
    { id: 'mx-fx-1', monthKey: '2026-10', name: 'Turkcell', day: '12', amount: 350, cur: 'TRY', paid: true, accountId: 'tr', sort: 11 },
    { id: 'mx-fx-2', monthKey: '2026-10', name: 'Istanbul gym', day: '', amount: 900, cur: 'TRY', paid: false, accountId: 'tr', sort: 12 },
  );

  setBudgets(sep, { dr: 70000, old: 25 });
  setBudgets(oct, { dr: 60000, us: 100, tr: 4000 });

  s.incomes.push(
    { id: 'mx-in-1', date: '2026-09-20', desc: 'Sold bike', accountId: 'cash', amount: 8000, cur: 'DOP', budget: false },
    { id: 'mx-in-2', date: '2026-10-15', desc: 'Freelance', accountId: 'tr', amount: 20000, cur: 'TRY', budget: false },
    { id: 'mx-in-3', date: '2026-10-02', desc: 'Refund', accountId: 'old', amount: 40, cur: 'USD', budget: false },
    // Con fecha en un mes que todavía no existe: no tiene hoja en la que salir.
    { id: 'mx-in-4', date: '2026-11-01', desc: 'Early salary', accountId: 'us', amount: 100, cur: 'USD', budget: false },
  );

  s.goals.push(
    { id: 'flat', name: 'Istanbul flat', cur: 'TRY', monthly: 10000, start: '2026-09', end: '2027-08', approxCur: null, sort: 3 },
    { id: 'gifts', name: 'Gifts', cur: 'DOP', monthly: null, start: null, end: null, approxCur: null, sort: 4 },
    { id: 'half', name: 'Half plan', cur: 'TRY', monthly: 500, start: '2026-10', end: null, approxCur: null, sort: 5 },
  );
  s.contribs.push(
    { id: 'mx-ct-1', goalId: 'flat', date: '2026-09-10', amount: 4000, cur: 'TRY' },
    { id: 'mx-ct-2', goalId: 'flat', date: '2026-10-05', amount: 100, cur: 'USD' },
    { id: 'mx-ct-3', goalId: 'flat', date: '2026-10-06', amount: 2938, cur: 'DOP' },
    { id: 'mx-ct-4', goalId: 'emergency', date: '2026-10-07', amount: 420, cur: 'TRY' },
    { id: 'mx-ct-5', goalId: 'gifts', date: '2026-10-07', amount: 1500, cur: 'DOP' },
  );
  return s;
}
