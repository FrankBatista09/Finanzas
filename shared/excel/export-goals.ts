// Where each goal's card goes on the savings sheet.
//
// The original design had three fixed cards in rows 6 to 12: two narrow ones (B:D and E:G) for the goals with
// variable contributions and a wide one (I:O) for the goal with a plan. With whatever goals the user has, that
// strip repeats downward in "bands" of 8 rows (7 for the card and 1 for spacing): band k takes rows
// 6+8k to 12+8k, and everything below (income by month and contributions) moves down 8 rows per extra band.

import { isMonthKey } from '../month';
import type { MonthKey } from '../types';
import { num } from './export-book';
import type { ExportGoal } from './types';

/** First row of band 0. */
export const BAND_TOP = 6;
/** Rows in a band, counting the spacing row. */
export const BAND_ROWS = 8;
/** Heights of the eight rows of a band (rows 6 to 13 of the original design). */
export const BAND_HEIGHTS: readonly number[] = [24, 16, 28, 16, 14, 20, 24, 10];

/**
 * Columns (first, last) of the three slots of a band: the two narrow ones, for goals without a plan, and the
 * wide one, for a goal with a plan. The goal's name goes in the first column, on the first row of the band.
 */
export const GOAL_SLOTS: readonly (readonly [first: string, last: string])[] = [
  ['B', 'D'],
  ['E', 'G'],
  ['I', 'O'],
];
/** Index of the wide slot in GOAL_SLOTS. */
export const WIDE_SLOT = 2;

export interface GoalPlan {
  monthlyUSD: number;
  start: MonthKey;
  end: MonthKey;
}

/**
 * The goal's plan, or null if it has variable contributions. An incomplete or inconsistent plan (no monthly
 * contribution greater than zero, either date missing, or the end before the start) counts as no plan.
 */
export function goalPlan(goal: Pick<ExportGoal, 'monthlyUSD' | 'start' | 'end'>): GoalPlan | null {
  const monthlyUSD = num(goal.monthlyUSD);
  if (monthlyUSD === null || !(monthlyUSD > 0)) return null;
  if (!isMonthKey(goal.start) || !isMonthKey(goal.end) || goal.start > goal.end) return null;
  return { monthlyUSD, start: goal.start, end: goal.end };
}

export interface PlacedGoal {
  name: string;
  /** The card's band, from 0. */
  band: number;
  /** Slot within the band: index in GOAL_SLOTS. */
  slot: number;
  plan: GoalPlan | null;
}

export interface GoalLayout {
  /** Number of bands; at least one, even with no goals, so the tables do not move. */
  bands: number;
  /** The goals, in the same order they came in. */
  goals: PlacedGoal[];
}

/**
 * Places the goals in order: one without a plan takes the first free narrow slot of the current band and one
 * with a plan, the wide one; if the slot it needs is already taken, a new band is opened. It never goes back to
 * earlier bands. [no plan, no plan, with plan] fills band 0 the same way as the original design.
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
