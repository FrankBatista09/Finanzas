// Datos de ejemplo del prototipo (3 meses: ago y sep cerrados, oct en curso).
// Se usan en las pruebas y en /api/dev/seed. Los ids son deterministas para que las pruebas sean estables.
// Exportados a Excel dan exactamente design_handoff/referencia/Finanzas Personales v3.xlsx (ver shared/excel/reference.test.ts).

import { DEFAULT_GOALS, DEFAULT_RATE } from './constants';
import type { AppState, Contribution, Currency, FixedExpense, Month, MonthKey, Transaction, Transfer } from './types';

type FixRow = [name: string, day: string, amount: number, cur: Currency];
type TxRow = [day: number, desc: string, place: string, cat: string, method: string, amount: number, notes?: string];
type TrRow = [day: number, via: string, usd: number, rate: number];

const FIX: FixRow[] = [
  ['Luz', '', 1337.15, 'DOP'],
  ['Internet', '', 2699, 'DOP'],
  ['Seguro médico', '', 5640, 'DOP'],
  ['Pago nevera', '', 15000, 'DOP'],
  ['Claude', '5', 106, 'USD'],
  ['Google One', '16', 121.56, 'DOP'],
  ['iCloud+', '17', 604, 'DOP'],
  ['Cluely', '', 308, 'DOP'],
  ['Smartfit', '17', 1550, 'DOP'],
  ['Netflix', '', 1137.3, 'DOP'],
  ['Unicaribe', '', 7400, 'DOP'],
];

const d = (k: MonthKey, n: number) => `${k}-${String(n).padStart(2, '0')}`;

function fixed(k: MonthKey, paid: true | string[], over: Record<string, number> = {}): FixedExpense[] {
  return FIX.map(([name, day, amount, cur], i) => ({
    id: `seed-fx-${k}-${i + 1}`,
    monthKey: k,
    name,
    day,
    amount: over[name] ?? amount,
    cur,
    paid: paid === true || paid.includes(name),
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
    notes: notes ?? '',
    source: 'web',
    createdAt: null,
  }));
}

function tr(k: MonthKey, rows: TrRow[]): Transfer[] {
  return rows.map(([n, via, usd, rate], i) => ({ id: `seed-tr-${k}-${i + 1}`, monthKey: k, date: d(k, n), via, usd, rate }));
}

function month(
  key: MonthKey,
  closed: boolean,
  accounts: Month['accounts'],
  rest: Pick<Month, 'fixed' | 'transfers' | 'tx'>,
): Month {
  return { key, closed, closedAt: null, budget: 70000, incomeUSD: 5800, accounts, ...rest };
}

export function seedState(): AppState {
  const contribs: Contribution[] = (
    [
      ['2026-08-03', 'turquia', 3000],
      ['2026-08-03', 'emerg', 400],
      ['2026-08-20', 'personal', 250],
      ['2026-09-02', 'turquia', 3000],
      ['2026-09-02', 'emerg', 300],
      ['2026-09-18', 'personal', 200],
      ['2026-10-03', 'turquia', 3000],
      ['2026-10-03', 'emerg', 500],
    ] as [string, string, number][]
  ).map(([date, goalId, amount], i) => ({ id: `seed-ct-${i + 1}`, goalId, date, amount, cur: 'USD' }));

  return {
    defaultRate: DEFAULT_RATE,
    goals: DEFAULT_GOALS.map((g) => ({ ...g })),
    contribs,
    months: {
      '2026-08': month('2026-08', true, { usd: 3900, dop: 78200 }, {
        fixed: fixed('2026-08', true, { Luz: 1290.4 }),
        transfers: tr('2026-08', [
          [3, 'Remitly', 1500, 58.4],
          [18, 'PayPal', 300, 57.1],
        ]),
        tx: tx('2026-08', [
          [2, 'Compra semanal', 'Supermercado Nacional', 'Supermercado', 'Tarjeta', 5230],
          [4, 'Uber', 'Uber', 'Transporte', 'Tarjeta', 410],
          [6, 'Almuerzo', 'Adrian Tropical', 'Comida', 'Tarjeta', 1280],
          [9, 'Gasolina', 'Texaco Churchill', 'Transporte', 'Tarjeta', 2200],
          [12, 'Concierto', 'Teatro Nacional', 'Entretenimiento', 'App del banco', 2500],
          [15, 'Compra semanal', 'Jumbo', 'Supermercado', 'Tarjeta', 4680],
          [18, 'Camisas', 'Zara Blue Mall', 'Ropa', 'Tarjeta', 3900],
          [21, 'Consulta', 'Centro Médico', 'Salud', 'Transferencia', 2500, 'Copago seguro'],
          [24, 'Cena', 'Lulú Tasting Bar', 'Comida', 'Tarjeta', 3150],
          [29, 'Gasolina', 'Shell', 'Transporte', 'Tarjeta', 2000],
        ]),
      }),
      '2026-09': month('2026-09', true, { usd: 4100, dop: 81500 }, {
        fixed: fixed('2026-09', true, { Luz: 1412.8 }),
        transfers: tr('2026-09', [
          [2, 'Remitly', 1500, 58.55],
          [17, 'Remitly', 800, 58.62],
        ]),
        tx: tx('2026-09', [
          [1, 'Compra semanal', 'Supermercado Bravo', 'Supermercado', 'Tarjeta', 4975],
          [3, 'Libro de contabilidad', 'Librería Cuesta', 'Educación', 'Tarjeta', 1850],
          [5, 'Uber', 'Uber', 'Transporte', 'Tarjeta', 360],
          [8, 'Almuerzo', 'El Conuco', 'Comida', 'Tarjeta', 1420],
          [11, 'Gasolina', 'Texaco', 'Transporte', 'Tarjeta', 2100],
          [14, 'Cine', 'Caribbean Cinemas', 'Entretenimiento', 'App del banco', 850],
          [16, 'Compra semanal', 'Jumbo', 'Supermercado', 'Tarjeta', 5320],
          [19, 'Farmacia', 'Farmacia Carol', 'Salud', 'Tarjeta', 980],
          [23, 'Reserva hotel Estambul', 'Booking', 'Viajes', 'Tarjeta', 4800, 'Depósito'],
          [28, 'Gasolina', 'Shell', 'Transporte', 'Tarjeta', 1900],
        ]),
      }),
      '2026-10': month('2026-10', false, { usd: 4320, dop: 86400 }, {
        fixed: fixed('2026-10', ['Luz', 'Internet', 'Seguro médico', 'Pago nevera', 'Claude', 'Unicaribe']),
        transfers: tr('2026-10', [[2, 'Remitly', 1500, 58.76]]),
        tx: tx('2026-10', [
          [1, 'Compra semanal', 'Supermercado Nacional', 'Supermercado', 'Tarjeta', 4850],
          [2, 'Uber al trabajo', 'Uber', 'Transporte', 'Tarjeta', 320],
          [3, 'Almuerzo', 'Adrian Tropical', 'Comida', 'Tarjeta', 1150],
          [4, 'Cine', 'Caribbean Cinemas', 'Entretenimiento', 'App del banco', 900],
          [5, 'Farmacia', 'Farmacia Carol', 'Salud', 'Tarjeta', 1240],
          [6, 'Gasolina', 'Texaco', 'Transporte', 'Tarjeta', 2000],
          [7, 'Café', 'Starbucks Ágora', 'Comida', 'Tarjeta', 385],
        ]),
      }),
    },
  };
}
