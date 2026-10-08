// Solo para pruebas: ejecuta el exportador original del prototipo (design_handoff/referencia/excel-export.js)
// para comparar su salida con el port de shared/excel/export.ts, y da las entradas congeladas con las que se
// comparan (tests/export-data-*.json).
//
// El script original solo conoce el libro en español con sus tres metas fijas: dos de aportes variables
// ("Fondo de emergencia" y "Ahorro personal") y una con plan ("Viaje a Turquía"), de la que recibe los
// parámetros en `turkey`. Aquí se traduce la entrada de hoy (una lista de metas) a esa forma; unas metas que
// no sean exactamente esas no se pueden representar y se rechazan con un error.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { ExportData, ExportGoal } from '../shared/excel/types';

const SRC = new URL('../design_handoff/referencia/excel-export.js', import.meta.url);

/**
 * Entradas congeladas del generador: los datos de ejemplo del diseño original, ya con la forma del libro.
 *  · 'es': exactamente lo que reproduce design_handoff/referencia/Finanzas Personales v3.xlsx con los textos
 *    en español (las metas son las tres del diseño, ver `referenceGoals`).
 *  · 'en': los mismos datos con los textos en inglés (categorías y métodos con su nombre canónico).
 * Son archivos y no salen del estado de la app a propósito: el modelo de la app puede cambiar sin que cambie
 * lo que tiene que escribir el generador. Cada llamada devuelve una copia nueva (las pruebas la modifican).
 */
export function frozenExportData(lang: 'es' | 'en'): ExportData {
  return JSON.parse(readFileSync(new URL(`./export-data-${lang}.json`, import.meta.url), 'utf8')) as ExportData;
}

/** Nombres de las metas del diseño original, en el orden en que el script las dibuja. */
export const REFERENCE_GOAL_NAMES = ['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía'] as const;

/** Plan que el script original usa cuando no recibe parámetros (el de los libros de referencia). */
export const REFERENCE_PLAN = { monthlyUSD: 3000, start: '2026-08', end: '2027-10' } as const;

/** Las tres metas del diseño original; `plan` cambia los parámetros de la única con plan. */
export function referenceGoals(plan: Pick<ExportGoal, 'monthlyUSD' | 'start' | 'end'> = REFERENCE_PLAN): ExportGoal[] {
  const [emergency, personal, trip] = REFERENCE_GOAL_NAMES;
  return [
    { name: emergency, monthlyUSD: null, start: null, end: null },
    { name: personal, monthlyUSD: null, start: null, end: null },
    { name: trip, monthlyUSD: plan.monthlyUSD, start: plan.start, end: plan.end },
  ];
}

export interface ReferenceOptions {
  /** Fija "hoy" dentro del script (solo afecta a la plantilla vacía, que usa `new Date()`). */
  now?: Date;
}

const KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Parámetros `turkey` del script original; lanza si las metas no son las tres del diseño. */
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
 * Bytes del .xlsx que genera el exportador de referencia para `data`.
 * Lanza un error si `data.goals` no son las tres metas del diseño original (ver `referenceGoals`).
 */
export async function buildWithReference(data: ExportData, opts: ReferenceOptions = {}): Promise<Uint8Array> {
  const { goals, ...rest } = data;
  const legacy = { ...rest, turkey: turkeyOf(goals) };
  const window: { buildFinanzasXlsx?: (d: unknown) => Blob } = {};
  const now = opts.now;
  // Date del contexto: igual que la nativa, pero `new Date()` sin argumentos devuelve `now` si se indicó.
  const FakeDate = now
    ? (new Proxy(Date, {
        construct: (target, args: unknown[]) =>
          args.length ? Reflect.construct(target, args) : new Date(now.getTime()),
      }) as DateConstructor)
    : Date;
  const ctx = vm.createContext({ window, Blob, TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Date: FakeDate });
  vm.runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'excel-export.js' });
  // Se clona para que el script no pueda mutar los datos de la prueba.
  const blob = window.buildFinanzasXlsx!(structuredClone(legacy));
  return new Uint8Array(await blob.arrayBuffer());
}
