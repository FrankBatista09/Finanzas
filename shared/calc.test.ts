import { describe, expect, it } from 'vitest';
import { currentKey, donut, goalsProgress, incomeRows, monthCalc, rateOf, totalSavedUSD } from './calc';
import { f0, f2 } from './format';
import { seedState } from './seed';

// Valores de referencia: los que muestra el prototipo con los datos de ejemplo.
describe('monthCalc · Octubre 2026 (mes en curso)', () => {
  const s = seedState();
  const c = monthCalc(s, '2026-10');

  it('tasa del mes = promedio ponderado de los envíos', () => {
    expect(c.rate).toBeCloseTo(58.76, 10);
  });

  it('gastos fijos: 6 de 11 pagados · total 42,025.57 DOP', () => {
    expect(c.paidCount).toBe(6);
    expect(c.fixedCount).toBe(11);
    expect(f2(c.fixedAll)).toBe('42,025.57');
  });

  it('usado = fijos pagados + transacciones', () => {
    // Pagados: Luz 1,337.15 + Internet 2,699 + Seguro 5,640 + Nevera 15,000 + Claude 106 USD × 58.76 + Unicaribe 7,400
    expect(c.fixedPaid).toBeCloseTo(38304.71, 6);
    expect(c.varSpent).toBe(10845);
    expect(f2(c.used)).toBe('49,149.71');
    expect(f2(c.avail)).toBe('20,850.29');
    expect(f2(c.pending)).toBe('3,720.86');
    expect(f2(c.after)).toBe('17,129.43');
    expect(c.free).toBeCloseTo(c.after, 10);
  });

  it('dinero total e ingreso', () => {
    expect(f2(c.totalDOP)).toBe('340,243.20'); // 4,320 USD × 58.76 + 86,400 DOP
    expect(f2(c.totalUSD)).toBe('5,790.39');
    expect(f2(c.incomeLeft)).toBe('291,658.29');
  });

  it('por categoría: "Gastos fijos" primero y el resto de mayor a menor', () => {
    expect(c.categories.map((x) => x.name)).toEqual([
      'Gastos fijos',
      'Supermercado',
      'Transporte',
      'Comida',
      'Salud',
      'Entretenimiento',
    ]);
    expect(c.categories[0]!.fixed).toBe(true);
    expect(c.catMax).toBeCloseTo(c.fixedPaid, 10);
  });

  it('dona: los segmentos se encadenan y la escala es el presupuesto', () => {
    const d = donut(c);
    const circ = 2 * Math.PI * 64;
    const len = (seg: { dash: string }) => +seg.dash.split(' ')[0]!;
    expect(d.fixed.offset).toBe(-0);
    expect(d.variable.offset).toBeCloseTo(-len(d.fixed), 10);
    expect(d.pending.offset).toBeCloseTo(-(len(d.fixed) + len(d.variable)), 10);
    expect(len(d.fixed) + len(d.variable) + len(d.pending)).toBeCloseTo(((c.used + c.pending) / 70000) * circ, 8);
  });
});

describe('rateOf', () => {
  it('promedio ponderado por USD', () => {
    const s = seedState();
    expect(rateOf(s, '2026-08')).toBeCloseTo((1500 * 58.4 + 300 * 57.1) / 1800, 10);
    expect(rateOf(s, '2026-09')).toBeCloseTo((1500 * 58.55 + 800 * 58.62) / 2300, 10);
  });

  it('sin envíos usa el mes anterior más reciente; sin ninguno, la tasa por defecto', () => {
    const s = seedState();
    s.months['2026-10']!.transfers = [];
    expect(rateOf(s, '2026-10')).toBeCloseTo(rateOf(s, '2026-09'), 10);
    s.months['2026-09']!.transfers = [];
    s.months['2026-08']!.transfers = [];
    expect(rateOf(s, '2026-10')).toBe(58.76);
  });

  it('acepta meses sin registro: toma el anterior más cercano', () => {
    const s = seedState();
    expect(rateOf(s, '2027-03')).toBeCloseTo(58.76, 10);
    expect(rateOf(s, '2026-01')).toBe(58.76);
  });
});

describe('ahorros', () => {
  const s = seedState();

  it('mes en curso = último mes abierto', () => {
    expect(currentKey(s)).toBe('2026-10');
  });

  it('Viaje a Turquía: 15 meses × 3,000 = 45,000 USD', () => {
    const turquia = goalsProgress(s).find((g) => g.id === 'turquia')!;
    expect(turquia.savedUSD).toBe(9000);
    expect(turquia.target).not.toBeNull();
    expect(f0(turquia.target!.targetUSD)).toBe('45,000');
    expect(turquia.target!.pct).toBeCloseTo(20, 10);
    // Octubre ya tiene aporte: quedan nov-2026..oct-2027 = 12 aportes de 3,000.
    expect(turquia.target!.left).toBe(12);
    expect(turquia.target!.needPerMonth).toBe(3000);
  });

  it('metas de aportes variables no tienen objetivo', () => {
    const [emerg, personal] = goalsProgress(s);
    expect(emerg!.target).toBeNull();
    expect(emerg!.savedUSD).toBe(1200);
    expect(emerg!.contribCount).toBe(3);
    expect(personal!.savedUSD).toBe(450);
  });

  it('ingresos por mes', () => {
    const rows = incomeRows(s);
    expect(rows.map((r) => r.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(rows[0]!.savedUSD).toBe(3650);
    expect(rows[0]!.pct).toBeCloseTo((3650 / 5800) * 100, 10);
    expect(totalSavedUSD(s)).toBe(10650);
  });
});

describe('format', () => {
  it('es-DO sin depender del locale del runtime', () => {
    expect(f2(1234567.891)).toBe('1,234,567.89');
    expect(f2(-1234.5)).toBe('-1,234.50');
    expect(f2(-0.001)).toBe('0.00');
    expect(f2(Number.NaN)).toBe('0.00');
    expect(f0(999.5)).toBe('1,000');
    expect(f0(-0.4)).toBe('0');
  });
});
