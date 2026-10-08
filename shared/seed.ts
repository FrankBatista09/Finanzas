// Datos de ejemplo (3 meses: ago y sep cerrados, oct en curso). Son los gastos, envíos y aportes del prototipo
// del diseño, llevados al modelo de cuentas: el sueldo entra a la US account, los envíos lo pasan a la DR account
// y casi todo se paga desde la DR account. Se usan en las pruebas y en /api/dev/seed.
// Los ids son deterministas para que las pruebas sean estables.

import { DEFAULT_GOALS, DEFAULT_RATE } from './constants';
import { budgetsFromLog } from './calc';
import { firstDay } from './month';
import type {
  Account,
  AppState,
  BudgetEntry,
  Contribution,
  Currency,
  FixedExpense,
  Goal,
  Income,
  Month,
  MonthKey,
  MonthRate,
  Transaction,
  Transfer,
} from './types';

export const SEED_ACCOUNTS: readonly Account[] = [
  { id: 'us', name: 'US account', currency: 'USD', opening: 2000, hidden: false, sort: 0 },
  { id: 'dr', name: 'DR account', currency: 'DOP', opening: 60000, hidden: false, sort: 1 },
];

/** La meta con plan del diseño: 15 meses × 3,000 USD = 45,000 USD. */
export const SEED_PLANNED_GOAL: Goal = {
  id: 'turkey',
  name: 'Trip to Turkey',
  cur: 'USD',
  monthly: 3000,
  start: '2026-08',
  end: '2027-10',
  approxCur: null,
  sort: 2,
};

type FixRow = [name: string, day: string, amount: number, cur: Currency];
type TxRow = [day: number, desc: string, place: string, cat: string, method: string, amount: number, notes?: string];
type TrRow = [day: number, via: string, usd: number, rate: number];

const FIX: FixRow[] = [
  ['Electricity', '', 1337.15, 'DOP'],
  ['Internet', '', 2699, 'DOP'],
  ['Health insurance', '', 5640, 'DOP'],
  ['Fridge payment', '', 15000, 'DOP'],
  ['Claude', '5', 106, 'USD'],
  ['Google One', '16', 121.56, 'DOP'],
  ['iCloud+', '17', 604, 'DOP'],
  ['Cluely', '', 308, 'DOP'],
  ['Smartfit', '17', 1550, 'DOP'],
  ['Netflix', '', 1137.3, 'DOP'],
  ['Unicaribe', '', 7400, 'DOP'],
];

const d = (k: MonthKey, n: number) => `${k}-${String(n).padStart(2, '0')}`;

// Lo que se cobra en USD sale de la US account; el resto, de la DR account.
function fixed(k: MonthKey, paid: true | string[], over: Record<string, number> = {}): FixedExpense[] {
  return FIX.map(([name, day, amount, cur], i) => ({
    id: `seed-fx-${k}-${i + 1}`,
    monthKey: k,
    name,
    day,
    amount: over[name] ?? amount,
    cur,
    paid: paid === true || paid.includes(name),
    accountId: cur === 'USD' ? 'us' : 'dr',
    sort: i,
  }));
}

function tx(k: MonthKey, rows: TxRow[]): Transaction[] {
  return rows.map(([n, desc, place, cat, method, amount, notes], i) => ({
    id: `seed-tx-${k}-${i + 1}`,
    monthKey: k,
    date: d(k, n),
    desc,
    place,
    cat,
    method,
    amount,
    cur: 'DOP',
    accountId: 'dr',
    notes: notes ?? '',
    source: 'web',
    createdAt: null,
  }));
}

function tr(k: MonthKey, rows: TrRow[]): Transfer[] {
  return rows.map(([n, via, usd, rate], i) => ({
    id: `seed-tr-${k}-${i + 1}`,
    monthKey: k,
    date: d(k, n),
    via,
    fromAccountId: 'us',
    toAccountId: 'dr',
    amount: usd,
    rate,
    // Ninguno mueve presupuesto ni lleva comisión: las cifras de ejemplo (70,000 en octubre) salen solo del registro.
    budget: false,
    fee: 0,
  }));
}

type LogRow = [day: number, amount: number, kind: BudgetEntry['kind'], note?: string];

/** El presupuesto del diseño (70,000 DOP) sale entero de la DR account. */
const FLAT_BUDGET: LogRow[] = [[1, 70000, 'initial']];

function month(
  key: MonthKey,
  closed: boolean,
  rates: MonthRate[],
  rest: Pick<Month, 'fixed' | 'transfers' | 'tx'>,
  budget: LogRow[] = FLAT_BUDGET,
): Month {
  const budgetLog: BudgetEntry[] = budget.map(([n, amount, kind, note], i) => ({
    id: `seed-bg-${key}-${i + 1}`,
    date: n === 1 ? firstDay(key) : d(key, n),
    accountId: 'dr',
    amount,
    kind,
    note: note ?? '',
  }));
  return { key, closed, closedAt: null, budgetLog, budgets: budgetsFromLog(budgetLog), rates, ...rest };
}

/**
 * Deja el presupuesto de un mes en esas partes (cuenta → monto), como un movimiento 'initial' por cuenta con
 * fecha del primer día. Sustituye su registro. Para armar estados de prueba sin escribir el registro a mano.
 */
export function setBudgets(month: Month, budgets: Record<string, number>): void {
  month.budgetLog = Object.entries(budgets).map(([accountId, amount]) => ({
    id: `bg-${month.key}-${accountId}`,
    date: firstDay(month.key),
    accountId,
    amount,
    kind: 'initial',
    note: '',
  }));
  month.budgets = budgetsFromLog(month.budgetLog);
}

export function seedState(): AppState {
  const contribs: Contribution[] = (
    [
      ['2026-08-03', 'turkey', 3000],
      ['2026-08-03', 'emergency', 400],
      ['2026-08-20', 'personal', 250],
      ['2026-09-02', 'turkey', 3000],
      ['2026-09-02', 'emergency', 300],
      ['2026-09-18', 'personal', 200],
      ['2026-10-03', 'turkey', 3000],
      ['2026-10-03', 'emergency', 500],
    ] as [string, string, number][]
  ).map(([date, goalId, amount], i) => ({ id: `seed-ct-${i + 1}`, goalId, date, amount, cur: 'USD' }));

  const incomes: Income[] = ['2026-08', '2026-09', '2026-10'].map((k, i) => ({
    id: `seed-in-${i + 1}`,
    date: d(k, 1),
    desc: 'Salary',
    accountId: 'us',
    amount: 5800,
    cur: 'USD',
    budget: false,
  }));

  return {
    mainCurrency: 'DOP',
    secondCurrency: 'USD',
    defaultAccountId: 'dr',
    defaultRate: DEFAULT_RATE,
    goldPrice: null,
    theme: null,
    language: 'en',
    accounts: SEED_ACCOUNTS.map((a) => ({ ...a })),
    incomes,
    goals: [...DEFAULT_GOALS, SEED_PLANNED_GOAL].map((g) => ({ ...g })),
    contribs,
    months: {
      // Agosto y septiembre no tienen tasa escrita: sale del promedio ponderado de sus envíos.
      '2026-08': month('2026-08', true, [], {
        fixed: fixed('2026-08', true, { Electricity: 1290.4 }),
        transfers: tr('2026-08', [
          [3, 'Remitly', 1500, 58.4],
          [18, 'PayPal', 300, 57.1],
        ]),
        tx: tx('2026-08', [
          [2, 'Weekly groceries', 'Supermercado Nacional', 'Groceries', 'Debit card', 5230],
          [4, 'Uber', 'Uber', 'Transport', 'Debit card', 410],
          [6, 'Lunch', 'Adrian Tropical', 'Food', 'Debit card', 1280],
          [9, 'Gas', 'Texaco Churchill', 'Transport', 'Debit card', 2200],
          [12, 'Concert', 'Teatro Nacional', 'Entertainment', 'Bank app', 2500],
          [15, 'Weekly groceries', 'Jumbo', 'Groceries', 'Debit card', 4680],
          [18, 'Shirts', 'Zara Blue Mall', 'Clothing', 'Debit card', 3900],
          [21, 'Doctor visit', 'Centro Médico', 'Health', 'Transfer', 2500, 'Insurance copay'],
          [24, 'Dinner', 'Lulú Tasting Bar', 'Food', 'Debit card', 3150],
          [29, 'Gas', 'Shell', 'Transport', 'Debit card', 2000],
        ]),
      }),
      '2026-09': month('2026-09', true, [], {
        fixed: fixed('2026-09', true, { Electricity: 1412.8 }),
        transfers: tr('2026-09', [
          [2, 'Remitly', 1500, 58.55],
          [17, 'Remitly', 800, 58.62],
        ]),
        tx: tx('2026-09', [
          [1, 'Weekly groceries', 'Supermercado Bravo', 'Groceries', 'Debit card', 4975],
          [3, 'Accounting book', 'Librería Cuesta', 'Education', 'Debit card', 1850],
          [5, 'Uber', 'Uber', 'Transport', 'Debit card', 360],
          [8, 'Lunch', 'El Conuco', 'Food', 'Debit card', 1420],
          [11, 'Gas', 'Texaco', 'Transport', 'Debit card', 2100],
          [14, 'Movies', 'Caribbean Cinemas', 'Entertainment', 'Bank app', 850],
          [16, 'Weekly groceries', 'Jumbo', 'Groceries', 'Debit card', 5320],
          [19, 'Pharmacy', 'Farmacia Carol', 'Health', 'Debit card', 980],
          [23, 'Istanbul hotel booking', 'Booking', 'Travel', 'Debit card', 4800, 'Deposit'],
          [28, 'Gas', 'Shell', 'Transport', 'Debit card', 1900],
        ]),
      }),
      // Octubre tiene la tasa escrita a mano dos veces: el día 1 y, vuelta a confirmar, el día 6. Las dos valen
      // 58.76 a propósito: el libro de Excel solo conoce una tasa por mes y los datos de ejemplo tienen que dar
      // en él las mismas cifras que en la app (shared/excel/export-libreoffice.test.ts).
      '2026-10': month(
        '2026-10',
        false,
        [
          { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
          { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
        ],
        {
        fixed: fixed('2026-10', ['Electricity', 'Internet', 'Health insurance', 'Fridge payment', 'Claude', 'Unicaribe']),
        transfers: tr('2026-10', [[2, 'Remitly', 1500, 58.76]]),
        tx: tx('2026-10', [
          [1, 'Weekly groceries', 'Supermercado Nacional', 'Groceries', 'Debit card', 4850],
          [2, 'Uber to work', 'Uber', 'Transport', 'Debit card', 320],
          [3, 'Lunch', 'Adrian Tropical', 'Food', 'Debit card', 1150],
          [4, 'Movies', 'Caribbean Cinemas', 'Entertainment', 'Bank app', 900],
          [5, 'Pharmacy', 'Farmacia Carol', 'Health', 'Debit card', 1240],
          [6, 'Gas', 'Texaco', 'Transport', 'Debit card', 2000],
          [7, 'Coffee', 'Starbucks Ágora', 'Food', 'Debit card', 385],
        ]),
        },
        // El mes arrancó con 65,000 y el día 5 se subió 5,000: los mismos 70,000 del diseño, con su historia.
        [
          [1, 65000, 'initial'],
          [5, 5000, 'adjust', 'Car repair'],
        ],
      ),
    },
  };
}
