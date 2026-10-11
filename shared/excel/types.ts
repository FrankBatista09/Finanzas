import type { Currency, ISODate, MonthKey } from '../types';

/**
 * Input of the .xlsx generator. It starts from the shape `downloadExcel()` built in the prototype for
 * `window.buildFinanzasXlsx(data)`, with one difference: the prototype had three fixed goals and sent only the
 * parameters of the only one with a plan (`turkey`); here it carries the user's list of goals, whatever they are.
 */
export interface ExportData {
  months: ExportMonth[];
  /** Goals in the order they are shown. Each one has its card on the savings sheet. */
  goals: ExportGoal[];
  contribs: { date: ISODate; goalName: string; amount: number; cur: Currency }[];
  defaultRate: number;
}

export interface ExportGoal {
  name: string;
  /**
   * Plan (all three together) or all three null for a variable-contribution goal. An incomplete or
   * inconsistent plan is exported as a variable-contribution goal (export-goals.ts `goalPlan`).
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
