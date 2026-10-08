// Ancla de las pruebas "golden": comprueba que el exportador original del prototipo, con los datos de
// ejemplo en español (la entrada congelada tests/export-data-es.json), reproduce byte a byte los libros de
// design_handoff/referencia/. El port (export.test.ts) se compara contra ese mismo exportador.

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

describe('exportador de referencia (excel-export.js)', () => {
  it('datos de ejemplo en español → Finanzas Personales v3.xlsx', async () => {
    const out = await buildWithReference(frozenExportData('es'));
    expect(Buffer.from(out).equals(Buffer.from(ref('Finanzas Personales v3.xlsx')))).toBe(true);
  });

  it('las dos entradas congeladas son los mismos datos: solo cambian los textos', () => {
    const es = frozenExportData('es');
    const en = frozenExportData('en');
    // Cada llamada lee el archivo de nuevo: modificar una copia no toca la siguiente.
    es.months.length = 0;
    expect(frozenExportData('es').months.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);

    /** Lo que no es texto: claves, cifras, fechas, monedas y marcas de pagado. */
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
    // Y los textos sí cambian: conceptos, descripciones, categorías, métodos y metas.
    const oct = (data: ExportData) => data.months[2]!;
    expect([oct(en).fixed[0]!.name, oct(en).tx[0]!.desc, oct(en).tx[0]!.cat, oct(en).tx[0]!.method]).toEqual(['Electricity', 'Weekly groceries', 'Groceries', 'Card']);
    const esOct = oct(frozenExportData('es'));
    expect([esOct.fixed[0]!.name, esOct.tx[0]!.desc, esOct.tx[0]!.cat, esOct.tx[0]!.method]).toEqual(['Luz', 'Compra semanal', 'Supermercado', 'Tarjeta']);
    expect(en.goals.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey']);
  });

  it('sin meses → Plantilla vacia.xlsx (mes actual: octubre 2026)', async () => {
    const out = await buildWithReference(empty(), { now: new Date(2026, 9, 7) });
    expect(Buffer.from(out).equals(Buffer.from(ref('Plantilla vacia.xlsx')))).toBe(true);
  });

  it('las metas de referencia son las del diseño original', () => {
    // La entrada congelada en español y este ayudante describen las mismas tres metas.
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

  it('el plan de la tercera meta llega al script: otro plan da otro libro', async () => {
    const base = await buildWithReference(empty(), { now: new Date(2026, 9, 7) });
    const other = await buildWithReference(empty({ goals: referenceGoals({ monthlyUSD: 2500, start: '2027-01', end: '2029-06' }) }), {
      now: new Date(2026, 9, 7),
    });
    expect(Buffer.from(other).equals(Buffer.from(base))).toBe(false);
  });

  describe('rechaza las metas que el script original no puede representar', () => {
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

    it('los datos de ejemplo en inglés (otros nombres de meta)', async () => {
      await expect(buildWithReference(frozenExportData('en'))).rejects.toThrow(/goal 1 must be named/);
    });
  });
});
