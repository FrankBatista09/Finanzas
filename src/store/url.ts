// State in the URL: ?user=eda (whose data it is), ?month=2026-10 (selected month) and ?sheet=savings
// (the Month sheet is the default one and is not written). The parameter names are not translated.
// Pure functions; the hook that connects them to history is in useUrlState.ts.

import { currentKey } from '../../shared/calc';
import { isMonthKey } from '../../shared/month';
import type { AppState, MonthKey } from '../../shared/types';
import { isUserId } from '../../shared/users';

export type Sheet = 'mes' | 'ahorros';

export interface UrlState {
  /** null = no user in the URL: follow the last one used on this device (session.ts resolveUser). */
  user: string | null;
  /** null = no month in the URL: follow the current month. */
  mes: MonthKey | null;
  hoja: Sheet;
}

export const DEFAULT_SHEET: Sheet = 'mes';

/** Value of ?sheet= for each sheet (the default one never gets written). */
const SHEET_PARAM: Record<Sheet, string> = { mes: 'month', ahorros: 'savings' };

/** Reads `location.search`. Anything not recognized falls back to the default values. */
export function parseUrl(search: string): UrlState {
  const params = new URLSearchParams(search);
  const user = params.get('user');
  const month = params.get('month');
  return {
    // Only the shape of the id is checked here; whether it is a configured user is known once the session arrives.
    user: isUserId(user) ? user : null,
    mes: isMonthKey(month) ? month : null,
    hoja: params.get('sheet') === SHEET_PARAM.ahorros ? 'ahorros' : DEFAULT_SHEET,
  };
}

/**
 * Returns the `search` ('' or '?…') for that state. Keeps any foreign parameters found in `current`
 * and puts `user`, `month` and `sheet` first, in that order.
 */
export function buildSearch(next: UrlState, current = ''): string {
  const rest = new URLSearchParams(current);
  rest.delete('user');
  rest.delete('month');
  rest.delete('sheet');
  const params = new URLSearchParams();
  if (next.user) params.set('user', next.user);
  if (next.mes) params.set('month', next.mes);
  if (next.hoja !== DEFAULT_SHEET) params.set('sheet', SHEET_PARAM[next.hoja]);
  for (const [k, v] of rest) params.append(k, v);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Month to show: the requested one if it exists; if missing or not found, the current month. null only with no months. */
export function resolveMonth(requested: MonthKey | null, state: AppState): MonthKey | null {
  if (requested && state.months[requested]) return requested;
  return currentKey(state);
}
