// Estado en la URL: ?user=eda (de quién son los datos), ?month=2026-10 (mes seleccionado) y ?sheet=savings
// (la hoja del mes es la de por defecto y no se escribe). Los nombres de los parámetros no se traducen.
// Funciones puras; el hook que las conecta con history está en useUrlState.ts.

import { currentKey } from '../../shared/calc';
import { isMonthKey } from '../../shared/month';
import type { AppState, MonthKey } from '../../shared/types';
import { isUserId } from '../../shared/users';

export type Sheet = 'mes' | 'ahorros';

export interface UrlState {
  /** null = sin usuario en la URL: se sigue el último usado en este dispositivo (session.ts resolveUser). */
  user: string | null;
  /** null = sin mes en la URL: se sigue el mes en curso. */
  mes: MonthKey | null;
  hoja: Sheet;
}

export const DEFAULT_SHEET: Sheet = 'mes';

/** Valor de ?sheet= para cada hoja (la de por defecto no llega a escribirse). */
const SHEET_PARAM: Record<Sheet, string> = { mes: 'month', ahorros: 'savings' };

/** Lee `location.search`. Lo que no se reconoce cae en los valores por defecto. */
export function parseUrl(search: string): UrlState {
  const params = new URLSearchParams(search);
  const user = params.get('user');
  const month = params.get('month');
  return {
    // Aquí solo se mira la forma del id; si es un usuario configurado se sabe al llegar la sesión.
    user: isUserId(user) ? user : null,
    mes: isMonthKey(month) ? month : null,
    hoja: params.get('sheet') === SHEET_PARAM.ahorros ? 'ahorros' : DEFAULT_SHEET,
  };
}

/**
 * Devuelve el `search` ('' o '?…') para ese estado. Conserva los parámetros ajenos que hubiera en `current`
 * y deja `user`, `month` y `sheet` al principio, en ese orden.
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

/** Mes a mostrar: el pedido si existe; si falta o no existe, el mes en curso. null solo si no hay ningún mes. */
export function resolveMonth(requested: MonthKey | null, state: AppState): MonthKey | null {
  if (requested && state.months[requested]) return requested;
  return currentKey(state);
}
