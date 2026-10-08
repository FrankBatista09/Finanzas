// Modelo de dominio compartido por el frontend (src/), la API (server/, functions/) y el Excel (shared/excel/).
// Los nombres de campo (desc, cat, cur, tx…) son los del prototipo: el exportador de Excel espera esta misma forma.

export type Currency = 'DOP' | 'USD';

/** 'YYYY-MM' */
export type MonthKey = string;

/** 'YYYY-MM-DD' */
export type ISODate = string;

export type TxSource = 'web' | 'claude' | 'import';

export interface Accounts {
  /** Cuenta USA, en USD. */
  usd: number;
  /** Cuenta RD, en DOP. */
  dop: number;
}

export interface FixedExpense {
  id: string;
  monthKey: MonthKey;
  name: string;
  /** Día del mes en que se cobra; texto libre, '' si no aplica. */
  day: string;
  amount: number;
  cur: Currency;
  paid: boolean;
  sort: number;
}

export interface Transaction {
  id: string;
  /** Mes (hoja) al que pertenece. Normalmente coincide con el mes de `date`, pero no es obligatorio. */
  monthKey: MonthKey;
  date: ISODate;
  desc: string;
  place: string;
  cat: string;
  method: string;
  /** Monto y moneda originales; DOP/USD se calculan con la tasa del mes y no se persisten. */
  amount: number;
  cur: Currency;
  notes: string;
  source: TxSource;
  createdAt: string | null;
}

export interface Transfer {
  id: string;
  monthKey: MonthKey;
  date: ISODate;
  via: string;
  usd: number;
  rate: number;
}

export interface Month {
  key: MonthKey;
  closed: boolean;
  closedAt: string | null;
  /** Presupuesto planeado, en DOP. */
  budget: number;
  incomeUSD: number;
  /** Saldos de las cuentas. En un mes cerrado es la foto al momento del cierre. */
  accounts: Accounts;
  fixed: FixedExpense[];
  transfers: Transfer[];
  tx: Transaction[];
}

export interface Goal {
  id: string;
  name: string;
  /** Aporte fijo mensual; null = aportes variables (sin meta). */
  monthlyUSD: number | null;
  start: MonthKey | null;
  end: MonthKey | null;
  sort: number;
}

export interface Contribution {
  id: string;
  goalId: string;
  date: ISODate;
  amount: number;
  cur: Currency;
}

/** Todo el histórico. Es lo que devuelve GET /api/state y sobre lo que operan los cálculos de shared/calc.ts. */
export interface AppState {
  months: Record<MonthKey, Month>;
  goals: Goal[];
  contribs: Contribution[];
  /** Tasa de respaldo cuando no hay envíos (settings.default_rate). */
  defaultRate: number;
}
