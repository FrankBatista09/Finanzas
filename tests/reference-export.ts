// For tests only: runs the prototype's original exporter (design_handoff/referencia/excel-export.js)
// to compare its output with the port in shared/excel/export.ts, and provides the frozen inputs they are
// compared with (tests/export-data-*.json).
//
// The original script only knows the Spanish workbook with its three fixed goals: two with variable contributions
// ("Fondo de emergencia" and "Ahorro personal") and one with a plan ("Viaje a Turquía"), whose parameters it
// receives in `turkey`. Here today's input (a list of goals) is translated into that shape; goals that are not
// exactly those cannot be represented and are rejected with an error.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { ExportData, ExportGoal } from '../shared/excel/types';

const SRC = new URL('../design_handoff/referencia/excel-export.js', import.meta.url);

/**
 * Frozen inputs of the generator: the original design's sample data, already in the shape of the workbook.
 *  · 'es': exactly what reproduces design_handoff/referencia/Finanzas Personales v3.xlsx with the text
 *    in Spanish (the goals are the three from the design, see `referenceGoals`).
 *  · 'en': the same data with the text in English (categories and methods with their canonical names).
 * They are files and do not come from the app state on purpose: the app's model can change without changing
 * what the generator has to write. Each call returns a new copy (the tests modify it).
 */
export function frozenExportData(lang: 'es' | 'en'): ExportData {
  return JSON.parse(readFileSync(new URL(`./export-data-${lang}.json`, import.meta.url), 'utf8')) as ExportData;
}

/** Names of the goals of the original design, in the order the script draws them. */
export const REFERENCE_GOAL_NAMES = ['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía'] as const;

/** Plan the original script uses when it receives no parameters (the one in the reference workbooks). */
export const REFERENCE_PLAN = { monthlyUSD: 3000, start: '2026-08', end: '2027-10' } as const;

/** The three goals of the original design; `plan` changes the parameters of the only one with a plan. */
export function referenceGoals(plan: Pick<ExportGoal, 'monthlyUSD' | 'start' | 'end'> = REFERENCE_PLAN): ExportGoal[] {
  const [emergency, personal, trip] = REFERENCE_GOAL_NAMES;
  return [
    { name: emergency, monthlyUSD: null, start: null, end: null },
    { name: personal, monthlyUSD: null, start: null, end: null },
    { name: trip, monthlyUSD: plan.monthlyUSD, start: plan.start, end: plan.end },
  ];
}

export interface ReferenceOptions {
  /** Pins "today" inside the script (it only affects the empty template, which uses `new Date()`). */
  now?: Date;
}

const KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `turkey` parameters of the original script; throws if the goals are not the three from the design. */
function turkeyOf(goals: unknown): { monthlyUSD: number; start: string; end: string } {
  const fail = (why: string): never => {
    throw new Error(
      `The reference exporter can only represent the three goals of the original design ` +
        `(${REFERENCE_GOAL_NAMES.map((n) => `"${n}"`).join(', ')}; the first two without a plan, the third with one): ${why}. ` +
        `Got ${JSON.stringify(goals)}`,
    );
  };
  if (!Array.isArray(goals)) return fail('goals is not a list');
  const list = goals as Partial<ExportGoal>[];
  if (list.length !== REFERENCE_GOAL_NAMES.length) return fail(`expected 3 goals, got ${list.length}`);
  REFERENCE_GOAL_NAMES.forEach((name, i) => {
    if (list[i]?.name !== name) fail(`goal ${i + 1} must be named "${name}"`);
  });
  for (const g of list.slice(0, 2)) {
    if (g.monthlyUSD != null || g.start != null || g.end != null) fail(`"${g.name}" must not have a plan`);
  }
  const { monthlyUSD, start, end } = list[2]!;
  if (typeof monthlyUSD !== 'number' || !Number.isFinite(monthlyUSD) || monthlyUSD <= 0) {
    return fail(`"${REFERENCE_GOAL_NAMES[2]}" needs monthlyUSD > 0`);
  }
  if (typeof start !== 'string' || typeof end !== 'string' || !KEY_RE.test(start) || !KEY_RE.test(end) || start > end) {
    return fail(`"${REFERENCE_GOAL_NAMES[2]}" needs start and end months (YYYY-MM) with start <= end`);
  }
  return { monthlyUSD, start, end };
}

/**
 * Bytes of the .xlsx the reference exporter generates for `data`.
 * Throws an error if `data.goals` are not the three goals of the original design (see `referenceGoals`).
 */
export async function buildWithReference(data: ExportData, opts: ReferenceOptions = {}): Promise<Uint8Array> {
  const { goals, ...rest } = data;
  const legacy = { ...rest, turkey: turkeyOf(goals) };
  const window: { buildFinanzasXlsx?: (d: unknown) => Blob } = {};
  const now = opts.now;
  // The context's Date: same as the native one, but `new Date()` without arguments returns `now` if it was given.
  const FakeDate = now
    ? (new Proxy(Date, {
        construct: (target, args: unknown[]) =>
          args.length ? Reflect.construct(target, args) : new Date(now.getTime()),
      }) as DateConstructor)
    : Date;
  const ctx = vm.createContext({ window, Blob, TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Date: FakeDate });
  vm.runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'excel-export.js' });
  // It is cloned so the script cannot mutate the test's data.
  const blob = window.buildFinanzasXlsx!(structuredClone(legacy));
  return new Uint8Array(await blob.arrayBuffer());
}
