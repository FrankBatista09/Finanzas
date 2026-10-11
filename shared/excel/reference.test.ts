// Anchor of the "golden" tests: it checks that the prototype's original exporter, with the sample data in
// Spanish (the frozen input tests/export-data-es.json), reproduces byte for byte the workbooks in
// design_handoff/referencia/. The port (export.test.ts) is compared against that same exporter.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildWithReference, frozenExportData, referenceGoals, REFERENCE_GOAL_NAMES, REFERENCE_PLAN } from '../../tests/reference-export';
import type { ExportData } from './types';

const ref = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../design_handoff/referencia/${name}`, import.meta.url)));

const empty = (over: Partial<ExportData> = {}): ExportData => ({
  months: [],
  goals: referenceGoals(),
  contribs: [],
  defaultRate: 58.76,
  ...over,
});

describe('reference exporter (excel-export.js)', () => {
  it('sample data in Spanish → Finanzas Personales v3.xlsx', async () => {
    const out = await buildWithReference(frozenExportData('es'));
    expect(Buffer.from(out).equals(Buffer.from(ref('Finanzas Personales v3.xlsx')))).toBe(true);
  });

  it('the two frozen inputs are the same data: only the texts change', () => {
    const es = frozenExportData('es');
    const en = frozenExportData('en');
    // Each call reads the file again: modifying one copy does not touch the next.
    es.months.length = 0;
    expect(frozenExportData('es').months.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);

    /** What is not text: keys, figures, dates, currencies and paid marks. */
    const figures = (data: ExportData) => ({
      defaultRate: data.defaultRate,
      goals: data.goals.map((g) => [g.monthlyUSD, g.start, g.end]),
      contribs: data.contribs.map((c) => [c.date, c.amount, c.cur]),
      months: data.months.map((m) => ({
        key: m.key,
        budget: m.budget,
        incomeUSD: m.incomeUSD,
        accounts: m.accounts,
        fixed: m.fixed.map((f) => [f.day, f.amount, f.cur, f.paid]),
        transfers: m.transfers,
        tx: m.tx.map((t) => [t.date, t.amount, t.cur]),
      })),
    });
    expect(figures(en)).toEqual(figures(frozenExportData('es')));
    expect(figures(en).months.map((m) => [m.key, m.fixed.length, m.transfers.length, m.tx.length])).toEqual([
      ['2026-08', 11, 2, 10],
      ['2026-09', 11, 2, 10],
      ['2026-10', 11, 1, 7],
    ]);
    // And the texts do change: items, descriptions, categories, methods and goals.
    const oct = (data: ExportData) => data.months[2]!;
    expect([oct(en).fixed[0]!.name, oct(en).tx[0]!.desc, oct(en).tx[0]!.cat, oct(en).tx[0]!.method]).toEqual(['Electricity', 'Weekly groceries', 'Groceries', 'Card']);
    const esOct = oct(frozenExportData('es'));
    expect([esOct.fixed[0]!.name, esOct.tx[0]!.desc, esOct.tx[0]!.cat, esOct.tx[0]!.method]).toEqual(['Luz', 'Compra semanal', 'Supermercado', 'Tarjeta']);
    expect(en.goals.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey']);
  });

  it('no months → Plantilla vacia.xlsx (current month: October 2026)', async () => {
    const out = await buildWithReference(empty(), { now: new Date(2026, 9, 7) });
    expect(Buffer.from(out).equals(Buffer.from(ref('Plantilla vacia.xlsx')))).toBe(true);
  });

  it('the reference goals are those of the original design', () => {
    // The frozen input in Spanish and this helper describe the same three goals.
    expect(referenceGoals()).toEqual(frozenExportData('es').goals);
    expect(referenceGoals().map((g) => g.name)).toEqual([...REFERENCE_GOAL_NAMES]);
    expect(referenceGoals()[2]).toMatchObject(REFERENCE_PLAN);
    expect(referenceGoals({ monthlyUSD: 500, start: '2027-01', end: '2027-06' })[2]).toEqual({
      name: 'Viaje a Turquía',
      monthlyUSD: 500,
      start: '2027-01',
      end: '2027-06',
    });
  });

  it('the plan of the third goal reaches the script: a different plan gives a different workbook', async () => {
    const base = await buildWithReference(empty(), { now: new Date(2026, 9, 7) });
    const other = await buildWithReference(empty({ goals: referenceGoals({ monthlyUSD: 2500, start: '2027-01', end: '2029-06' }) }), {
      now: new Date(2026, 9, 7),
    });
    expect(Buffer.from(other).equals(Buffer.from(base))).toBe(false);
  });

  describe('rejects the goals the original script cannot represent', () => {
    const [emergency, personal, trip] = referenceGoals();
    const cases: [why: string, goals: unknown, message: RegExp][] = [
      ['sin metas', [], /expected 3 goals, got 0/],
      ['falta la lista', undefined, /goals is not a list/],
      ['solo dos metas', [emergency, personal], /expected 3 goals, got 2/],
      ['una cuarta meta', [emergency, personal, trip, { ...personal, name: 'Carro' }], /expected 3 goals, got 4/],
      ['otro orden', [personal, emergency, trip], /goal 1 must be named "Fondo de emergencia"/],
      ['otro nombre', [emergency, personal, { ...trip, name: 'Trip to Turkey' }], /goal 3 must be named "Viaje a Turquía"/],
      ['la tercera sin plan', [emergency, personal, { ...trip, monthlyUSD: null, start: null, end: null }], /needs monthlyUSD > 0/],
      ['aporte mensual 0', [emergency, personal, { ...trip, monthlyUSD: 0 }], /needs monthlyUSD > 0/],
      ['sin fecha de inicio', [emergency, personal, { ...trip, start: null }], /needs start and end months/],
      ['fin antes del inicio', [emergency, personal, { ...trip, start: '2027-11' }], /start <= end/],
      ['mes inválido', [emergency, personal, { ...trip, end: '2027-13' }], /needs start and end months/],
      ['una de aportes variables con plan', [{ ...emergency, monthlyUSD: 100, start: '2026-01', end: '2026-12' }, personal, trip], /"Fondo de emergencia" must not have a plan/],
    ];

    it.each(cases)('%s', async (_why, goals, message) => {
      const data = { ...empty(), goals } as ExportData;
      await expect(buildWithReference(data)).rejects.toThrow(message);
      await expect(buildWithReference(data)).rejects.toThrow(/reference exporter can only represent the three goals/);
    });

    it('the sample data in English (other goal names)', async () => {
      await expect(buildWithReference(frozenExportData('en'))).rejects.toThrow(/goal 1 must be named/);
    });
  });
});
