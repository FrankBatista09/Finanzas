import type { Currency, ISODate, MonthKey } from '../types';

/**
 * Entrada del generador de .xlsx. Es la misma forma que arma `downloadExcel()` en el prototipo
 * para `window.buildFinanzasXlsx(data)`.
 */
export interface ExportData {
  months: ExportMonth[];
  contribs: { date: ISODate; goalName: string; amount: number; cur: Currency }[];
  /** Parámetros de la meta con aporte fijo mensual (Viaje a Turquía). */
  turkey: { monthlyUSD?: number | null; start?: MonthKey | null; end?: MonthKey | null };
  defaultRate: number;
}

export interface ExportMonth {
  key: MonthKey;
  budget: number | null;
  incomeUSD: number | null;
  accounts: { usd?: number | null; dop?: number | null };
  fixed: { name: string; day: string | number | null; amount: number | null; cur: Currency; paid: boolean }[];
  transfers: { date: ISODate; via: string; usd: number | null; rate: number | null }[];
  tx: {
    date: ISODate;
    desc: string;
    place: string;
    cat: string;
    method: string;
    amount: number | null;
    cur: Currency;
    notes: string;
  }[];
}
