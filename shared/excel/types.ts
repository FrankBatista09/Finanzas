import type { Currency, ISODate, MonthKey } from '../types';

/**
 * Entrada del generador de .xlsx. Parte de la forma que armaba `downloadExcel()` en el prototipo para
 * `window.buildFinanzasXlsx(data)`, con una diferencia: el prototipo tenía tres metas fijas y mandaba solo los
 * parámetros de la única con plan (`turkey`); aquí va la lista de metas del usuario, las que sean.
 */
export interface ExportData {
  months: ExportMonth[];
  /** Metas en el orden en que se muestran. Cada una tiene su tarjeta en la hoja de ahorros. */
  goals: ExportGoal[];
  contribs: { date: ISODate; goalName: string; amount: number; cur: Currency }[];
  defaultRate: number;
}

export interface ExportGoal {
  name: string;
  /**
   * Plan (los tres juntos) o los tres null para una meta de aportes variables. Un plan incompleto o
   * incoherente se exporta como meta de aportes variables (export-goals.ts `goalPlan`).
   */
  monthlyUSD: number | null;
  start: MonthKey | null;
  end: MonthKey | null;
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
