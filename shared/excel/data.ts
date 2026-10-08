import { sortedKeys } from '../calc';
import type { AppState } from '../types';
import type { ExportData } from './types';

/** Arma la entrada del generador de .xlsx a partir del estado (equivale a `downloadExcel()` del prototipo). */
export function buildExportData(state: AppState): ExportData {
  const goalName = new Map(state.goals.map((g) => [g.id, g.name]));
  // La hoja Ahorros modela una sola meta con aporte fijo mensual (Viaje a Turquía en el diseño).
  const planned = state.goals.find((g) => g.monthlyUSD && g.start && g.end);
  return {
    months: sortedKeys(state).map((key) => {
      const m = state.months[key]!;
      return {
        key,
        budget: m.budget,
        incomeUSD: m.incomeUSD,
        accounts: { ...m.accounts },
        fixed: [...m.fixed]
          .sort((a, b) => a.sort - b.sort)
          .map((f) => ({ name: f.name, day: f.day, amount: f.amount, cur: f.cur, paid: f.paid })),
        transfers: m.transfers.map((t) => ({ date: t.date, via: t.via, usd: t.usd, rate: t.rate })),
        tx: m.tx.map((t) => ({
          date: t.date,
          desc: t.desc,
          place: t.place,
          cat: t.cat,
          method: t.method,
          amount: t.amount,
          cur: t.cur,
          notes: t.notes,
        })),
      };
    }),
    contribs: state.contribs.map((c) => ({
      date: c.date,
      goalName: goalName.get(c.goalId) ?? c.goalId,
      amount: c.amount,
      cur: c.cur,
    })),
    turkey: { monthlyUSD: planned?.monthlyUSD ?? null, start: planned?.start ?? null, end: planned?.end ?? null },
    defaultRate: state.defaultRate,
  };
}
