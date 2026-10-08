// Dónde va la tarjeta de cada meta en la hoja de ahorros.
//
// El diseño original tenía tres tarjetas fijas en las filas 6 a 12: dos estrechas (B:D y E:G) para las metas
// de aportes variables y una ancha (I:O) para la meta con plan. Con las metas que tenga el usuario, esa franja
// se repite hacia abajo en "bandas" de 8 filas (7 de tarjeta y 1 de separación): la banda k ocupa las filas
// 6+8k a 12+8k, y todo lo que hay debajo (ingresos por mes y aportes) baja 8 filas por cada banda de más.

import { isMonthKey } from '../month';
import type { MonthKey } from '../types';
import { num } from './export-book';
import type { ExportGoal } from './types';

/** Primera fila de la banda 0. */
export const BAND_TOP = 6;
/** Filas de una banda, contando la de separación. */
export const BAND_ROWS = 8;
/** Alto de las ocho filas de una banda (las filas 6 a 13 del diseño original). */
export const BAND_HEIGHTS: readonly number[] = [24, 16, 28, 16, 14, 20, 24, 10];

/**
 * Columnas (primera, última) de los tres huecos de una banda: los dos estrechos, para metas sin plan, y el
 * ancho, para una meta con plan. El nombre de la meta va en la primera columna, en la primera fila de la banda.
 */
export const GOAL_SLOTS: readonly (readonly [first: string, last: string])[] = [
  ['B', 'D'],
  ['E', 'G'],
  ['I', 'O'],
];
/** Índice del hueco ancho en GOAL_SLOTS. */
export const WIDE_SLOT = 2;

export interface GoalPlan {
  monthlyUSD: number;
  start: MonthKey;
  end: MonthKey;
}

/**
 * Plan de la meta, o null si es de aportes variables. Un plan incompleto o incoherente (sin aporte mensual
 * mayor que cero, sin alguna de las dos fechas o con el fin antes del inicio) cuenta como que no hay plan.
 */
export function goalPlan(goal: Pick<ExportGoal, 'monthlyUSD' | 'start' | 'end'>): GoalPlan | null {
  const monthlyUSD = num(goal.monthlyUSD);
  if (monthlyUSD === null || !(monthlyUSD > 0)) return null;
  if (!isMonthKey(goal.start) || !isMonthKey(goal.end) || goal.start > goal.end) return null;
  return { monthlyUSD, start: goal.start, end: goal.end };
}

export interface PlacedGoal {
  name: string;
  /** Banda de la tarjeta, desde 0. */
  band: number;
  /** Hueco dentro de la banda: índice en GOAL_SLOTS. */
  slot: number;
  plan: GoalPlan | null;
}

export interface GoalLayout {
  /** Número de bandas; al menos una, aunque no haya metas, para que las tablas no cambien de sitio. */
  bands: number;
  /** Las metas, en el mismo orden en que llegaron. */
  goals: PlacedGoal[];
}

/**
 * Reparte las metas en orden: una sin plan ocupa el primer hueco estrecho libre de la banda en curso y una
 * con plan, el ancho; si el hueco que necesita ya está ocupado, se abre una banda nueva. No se vuelve a bandas
 * anteriores. [sin plan, sin plan, con plan] llena la banda 0 igual que el diseño original.
 */
export function placeGoals(goals: readonly ExportGoal[]): GoalLayout {
  const placed: PlacedGoal[] = [];
  let band = 0;
  let narrow = 0;
  let wide = false;
  for (const goal of goals) {
    const plan = goalPlan(goal);
    if (plan ? wide : narrow === WIDE_SLOT) {
      band++;
      narrow = 0;
      wide = false;
    }
    let slot: number;
    if (plan) {
      slot = WIDE_SLOT;
      wide = true;
    } else {
      slot = narrow++;
    }
    placed.push({ name: String(goal.name ?? ''), band, slot, plan });
  }
  return { bands: band + 1, goals: placed };
}
