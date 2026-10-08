import { describe, expect, it } from 'vitest';
import {
  balances,
  budgetHistory,
  budgetsFromLog,
  convert,
  convertOn,
  currentKey,
  defaultAccount,
  donut,
  goalsProgress,
  incomeRows,
  leftoverFor,
  monthCalc,
  openingFor,
  rateFor,
  ring,
  totalSaved,
} from './calc';
import { f0, f2 } from './format';
import { clampToMonth, firstDay, inMonth, lastDay } from './month';
import { seedState, setBudgets } from './seed';
import type { AppState } from './types';

// Las cifras del mes son las del prototipo del diseño (mismos gastos, mismo presupuesto, misma tasa);
// los saldos y los ingresos son del modelo de cuentas, calculados a mano en los comentarios.

describe('monthCalc · October 2026 (mes en curso, moneda principal DOP)', () => {
  const s = seedState();
  const c = monthCalc(s, '2026-10');

  it('la tasa del mes es la escrita a mano', () => {
    expect(c.main).toBe('DOP');
    expect(c.second).toBe('USD');
    // La última del mes: la del día 6.
    expect(c.rate).toEqual({ rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('gastos fijos: 6 de 11 pagados · total 42,025.57', () => {
    expect(c.paidCount).toBe(6);
    expect(c.fixedCount).toBe(11);
    expect(f2(c.fixedAll)).toBe('42,025.57');
  });

  it('usado = fijos pagados + transacciones', () => {
    // Pagados: 1,337.15 + 2,699 + 5,640 + 15,000 + Claude 106 USD × 58.76 + 7,400
    expect(c.fixedPaid).toBeCloseTo(38304.71, 6);
    expect(c.varSpent).toBe(10845);
    expect(f2(c.used)).toBe('49,149.71');
    expect(f2(c.usedSecond)).toBe('836.45');
    expect(f2(c.avail)).toBe('20,850.29');
    expect(f2(c.pending)).toBe('3,720.86');
    expect(f2(c.after)).toBe('17,129.43');
    expect(c.free).toBeCloseTo(c.after, 10);
  });

  it('presupuesto = suma de las partes por cuenta', () => {
    expect(c.budget).toBe(70000);
    expect(f2(c.budgetSecond)).toBe('1,191.29');
    expect(c.budgetParts.map((p) => [p.account.id, p.amount, p.inMain])).toEqual([
      ['us', 0, 0],
      ['dr', 70000, 70000],
    ]);
    // Todo viene del registro (65,000 iniciales + 5,000 de ajuste): ningún ingreso sube el presupuesto.
    expect(c.budgetParts.map((p) => [p.fromLog, p.fromIncomes])).toEqual([
      [0, 0],
      [70000, 0],
    ]);
  });

  it('una parte del presupuesto en otra moneda se convierte con la tasa del mes', () => {
    const t = seedState();
    setBudgets(t.months['2026-10']!, { us: 200, dr: 58248 });
    const tc = monthCalc(t, '2026-10');
    expect(tc.budget).toBeCloseTo(200 * 58.76 + 58248, 8);
    expect(tc.budget).toBeCloseTo(70000, 8);
  });

  it('ingreso del mes = suma de los ingresos registrados', () => {
    expect(c.income).toBeCloseTo(5800 * 58.76, 8);
    expect(f2(c.incomeLeft)).toBe('291,658.29');
    expect(c.saved).toBeCloseTo(3500 * 58.76, 8);
  });

  it('por categoría: gastos fijos primero y el resto de mayor a menor', () => {
    expect(c.categories.map((x) => x.name)).toEqual(['Fixed expenses', 'Groceries', 'Transport', 'Food', 'Health', 'Entertainment']);
    expect(c.categories[0]!.fixed).toBe(true);
    expect(c.catMax).toBeCloseTo(c.fixedPaid, 10);
  });

  it('dona: los segmentos se encadenan y la escala es el presupuesto', () => {
    const dn = donut(c);
    const circ = 2 * Math.PI * 64;
    const len = (seg: { dash: string }) => +seg.dash.split(' ')[0]!;
    expect(dn.fixed.offset).toBe(-0);
    expect(dn.variable.offset).toBeCloseTo(-len(dn.fixed), 10);
    expect(dn.pending.offset).toBeCloseTo(-(len(dn.fixed) + len(dn.variable)), 10);
    expect(len(dn.fixed) + len(dn.variable) + len(dn.pending)).toBeCloseTo(((c.used + c.pending) / 70000) * circ, 8);
  });
});

describe('rateFor', () => {
  it('sin tasa escrita usa el promedio ponderado de los envíos del mes', () => {
    const s = seedState();
    const aug = rateFor(s, '2026-08', 'USD', 'DOP');
    expect(aug.source).toBe('transfers');
    expect(aug.rate).toBeCloseTo((1500 * 58.4 + 300 * 57.1) / 1800, 10);
    expect(rateFor(s, '2026-09', 'USD', 'DOP').rate).toBeCloseTo((1500 * 58.55 + 800 * 58.62) / 2300, 10);
  });

  it('la escrita a mano manda sobre los envíos, y vale también al revés', () => {
    const s = seedState();
    s.months['2026-08']!.rates = [{ from: 'USD', to: 'DOP', rate: 60, date: '2026-08-01' }];
    expect(rateFor(s, '2026-08', 'USD', 'DOP')).toEqual({ rate: 60, source: 'month', monthKey: '2026-08', date: '2026-08-01' });
    expect(rateFor(s, '2026-08', 'DOP', 'USD').rate).toBeCloseTo(1 / 60, 12);
    expect(rateFor(s, '2026-08', 'DOP', 'DOP')).toEqual({ rate: 1, source: 'same', monthKey: null, date: null });
  });

  it('un envío en sentido contrario también cuenta para el promedio', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [];
    // 1,500 USD → 88,140 DOP y 58,000 DOP → 1,000 USD: salieron 2,500 USD en total frente a 146,140 DOP.
    s.months['2026-10']!.transfers.push({
      id: 'back', monthKey: '2026-10', date: '2026-10-09', via: 'Bank', fromAccountId: 'dr', toAccountId: 'us', amount: 58000, rate: 1 / 58,
    });
    expect(rateFor(s, '2026-10', 'USD', 'DOP').rate).toBeCloseTo(146140 / 2500, 8);
  });

  it('cruza por la tercera moneda cuando el par no tiene tasa propia', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
    ];
    const r = rateFor(s, '2026-10', 'TRY', 'DOP');
    expect(r.source).toBe('cross');
    expect(r.rate).toBeCloseTo(60 / 40, 12);
    expect(convert(s, '2026-10', 1000, 'TRY', 'DOP')).toBeCloseTo(1500, 9);
  });

  it('si el mes no la tiene, usa el mes anterior más reciente; si ninguno, el valor de respaldo', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [];
    s.months['2026-10']!.transfers = [];
    const oct = rateFor(s, '2026-10', 'USD', 'DOP');
    expect(oct.source).toBe('previous');
    expect(oct.monthKey).toBe('2026-09');
    expect(oct.rate).toBeCloseTo(rateFor(s, '2026-09', 'USD', 'DOP').rate, 12);

    expect(rateFor(s, '2026-10', 'USD', 'TRY')).toEqual({ rate: 42, source: 'default', monthKey: null, date: null });
    expect(rateFor(s, '2026-01', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'default', monthKey: null, date: null });
    expect(rateFor(s, '2026-01', 'TRY', 'DOP').rate).toBeCloseTo(58.76 / 42, 12);
  });

  it('acepta meses sin registro: sigue vigente la última escrita', () => {
    const s = seedState();
    expect(rateFor(s, '2027-03', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'previous', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('una tasa escrita con 0 o negativa se ignora', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 0, date: '2026-10-01' }];
    expect(rateFor(s, '2026-10', 'USD', 'DOP').source).toBe('transfers');
  });
});

// Octubre con dos tasas USD→DOP: 58 desde el día 1 y 60 desde el día 5. Las cifras de abajo salen de ahí.
function twoRates(): AppState {
  const s = seedState();
  s.months['2026-10']!.rates = [
    { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
    { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
  ];
  return s;
}

const usdTx = (s: AppState, id: string, date: string, amount: number) => ({
  ...s.months['2026-10']!.tx[0]!,
  id,
  date,
  amount,
  cur: 'USD' as const,
  accountId: 'dr',
});

describe('tasas con fecha: cada fila se convierte con la vigente en SU fecha', () => {
  it('rateFor con fecha da la última escrita hasta ese día; sin fecha, la última del mes', () => {
    const s = twoRates();
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-01')).toEqual({ rate: 58, source: 'month', monthKey: '2026-10', date: '2026-10-01' });
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-04')).toEqual({ rate: 58, source: 'month', monthKey: '2026-10', date: '2026-10-01' });
    // El mismo día en que se escribe ya vale la nueva.
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-05')).toEqual({ rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-05' });
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-31').rate).toBe(60);
    expect(rateFor(s, '2026-10', 'USD', 'DOP')).toEqual({ rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-05' });
  });

  it('vale en los dos sentidos, esté escrita en el que esté', () => {
    const s = twoRates();
    expect(rateFor(s, '2026-10', 'DOP', 'USD', '2026-10-04').rate).toBeCloseTo(1 / 58, 14);
    expect(rateFor(s, '2026-10', 'DOP', 'USD').rate).toBeCloseTo(1 / 60, 14);
    // Escrita al revés: 1 DOP = 0.016 USD desde el día 8 → 1 USD = 62.5 DOP.
    // (Un estado no se muta después de calcular con él: las tasas se memorizan por objeto.)
    const t = twoRates();
    t.months['2026-10']!.rates.push({ from: 'DOP', to: 'USD', rate: 0.016, date: '2026-10-08' });
    expect(rateFor(t, '2026-10', 'USD', 'DOP', '2026-10-07').rate).toBe(60);
    expect(rateFor(t, '2026-10', 'USD', 'DOP', '2026-10-08')).toEqual({ rate: 62.5, source: 'month', monthKey: '2026-10', date: '2026-10-08' });
    expect(rateFor(t, '2026-10', 'DOP', 'USD', '2026-10-08').rate).toBe(0.016);
  });

  it('escribir una tasa nueva no cambia lo convertido en las transacciones anteriores', () => {
    const s = twoRates();
    s.months['2026-10']!.tx.push(usdTx(s, 'early', '2026-10-02', 10), usdTx(s, 'late', '2026-10-06', 10));
    // 10 USD el día 2 a 58 = 580; 10 USD el día 6 a 60 = 600.
    const before = monthCalc(s, '2026-10');
    expect(before.varSpent).toBeCloseTo(10845 + 580 + 600, 8);
    const drBefore = balances(s, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance;
    expect(drBefore).toBeCloseTo(220641.93 - 580 - 600, 6);

    // Hoy (día 8) se escribe 62: las dos transacciones siguen valiendo lo mismo, en el mes y en el saldo.
    const later: AppState = structuredClone(s);
    later.months['2026-10']!.rates.push({ from: 'USD', to: 'DOP', rate: 62, date: '2026-10-08' });
    const after = monthCalc(later, '2026-10');
    expect(after.varSpent).toBeCloseTo(10845 + 580 + 600, 8);
    expect(balances(later, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(drBefore, 8);
    // Lo que es del mes entero sí sigue a la última tasa: Claude (106 USD, fijo pagado) pasa de 6,360 a 6,572.
    expect(before.fixedPaid).toBeCloseTo(32076.15 + 106 * 60, 6);
    expect(after.fixedPaid).toBeCloseTo(32076.15 + 106 * 62, 6);
    expect(after.rate.rate).toBe(62);
    // Y una transacción de ese mismo día ya va con la nueva.
    later.months['2026-10']!.tx.push(usdTx(later, 'today', '2026-10-08', 10));
    expect(monthCalc(structuredClone(later), '2026-10').varSpent).toBeCloseTo(10845 + 580 + 600 + 620, 8);
  });

  it('ingresos y aportes también van con la tasa de su fecha', () => {
    const s = twoRates();
    // Sueldo del día 1 a 58; un pago de 100 USD el día 6 a 60.
    s.incomes.push({ id: 'late', date: '2026-10-06', desc: 'Gig', accountId: 'dr', amount: 100, cur: 'USD', budget: false });
    expect(monthCalc(s, '2026-10').income).toBeCloseTo(5800 * 58 + 100 * 60, 8);
    // A la cuenta en DOP le entran 6,000.
    expect(balances(s, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(220641.93 + 6000, 6);
    // Aportes del día 3 (3,500 USD) a 58; uno de 5,800 DOP el día 3 son 100 USD y el día 6 serían 96.67.
    expect(monthCalc(s, '2026-10').saved).toBeCloseTo(3500 * 58, 8);
    s.contribs.push({ id: 'dop', goalId: 'emergency', date: '2026-10-03', amount: 5800, cur: 'DOP' });
    expect(goalsProgress(structuredClone(s)).find((g) => g.id === 'emergency')!.saved).toBeCloseTo(1200 + 100, 8);
    expect(convertOn(s, '2026-10-06', 5800, 'DOP', 'USD')).toBeCloseTo(5800 / 60, 10);
  });

  it('cruza los meses: la última escrita sigue vigente hasta que se escribe otra', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' }];
    s.months['2026-08']!.rates = [{ from: 'USD', to: 'DOP', rate: 57, date: '2026-08-10' }];
    // Antes del 10 de agosto no hay ninguna vigente: los envíos de agosto.
    const early = rateFor(s, '2026-08', 'USD', 'DOP', '2026-08-05');
    expect(early).toEqual({ rate: (1500 * 58.4 + 300 * 57.1) / 1800, source: 'transfers', monthKey: '2026-08', date: null });
    expect(rateFor(s, '2026-08', 'USD', 'DOP', '2026-08-10')).toEqual({ rate: 57, source: 'month', monthKey: '2026-08', date: '2026-08-10' });
    // Septiembre no escribió ninguna: vale la de agosto (y no sus envíos), y dice de cuándo es.
    expect(rateFor(s, '2026-09', 'USD', 'DOP')).toEqual({ rate: 57, source: 'previous', monthKey: '2026-08', date: '2026-08-10' });
    expect(rateFor(s, '2026-09', 'USD', 'DOP', '2026-09-15').rate).toBe(57);
    // Octubre, hasta el día 4 inclusive, también; desde el 5, la suya.
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-04')).toEqual({ rate: 57, source: 'previous', monthKey: '2026-08', date: '2026-08-10' });
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-05').rate).toBe(60);
    // Una transacción del 2 de octubre en USD: 10 × 57.
    s.months['2026-10']!.tx.push(usdTx(s, 'oct-2', '2026-10-02', 10));
    expect(monthCalc(structuredClone(s), '2026-10').varSpent).toBeCloseTo(10845 + 570, 8);
    // Un mes sin registrar (un ingreso de noviembre): la última escrita.
    expect(rateFor(s, '2026-11', 'USD', 'DOP', '2026-11-03')).toEqual({ rate: 60, source: 'previous', monthKey: '2026-10', date: '2026-10-05' });
    // El saldo de agosto se sigue viendo con la última de agosto, no con la de octubre.
    expect(rateFor(s, '2026-08', 'USD', 'DOP').rate).toBe(57);
  });

  it('sin ninguna escrita vigente en esa fecha: envíos del mes, cruce, mes anterior y valor de respaldo', () => {
    const s = seedState();
    // La única tasa de octubre es del día 5: el día 2 no hay ninguna vigente y valen los envíos del mes (58.76).
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' }];
    expect(rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-02')).toEqual({ rate: 58.76, source: 'transfers', monthKey: '2026-10', date: null });
    // Sin envíos en octubre: los del mes anterior.
    s.months['2026-10']!.transfers = [];
    const sep = (1500 * 58.55 + 800 * 58.62) / 2300;
    expect(rateFor(structuredClone(s), '2026-10', 'USD', 'DOP', '2026-10-02')).toEqual({ rate: sep, source: 'previous', monthKey: '2026-09', date: null });
    // Sin nada antes: el valor de respaldo.
    expect(rateFor(s, '2026-07', 'USD', 'DOP', '2026-07-15')).toEqual({ rate: 58.76, source: 'default', monthKey: null, date: null });

    // Cruce: USD→DOP 60 desde el día 5 y USD→TRY 40 desde el día 7.
    const t = seedState();
    t.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-07' },
    ];
    expect(rateFor(t, '2026-10', 'TRY', 'DOP', '2026-10-07')).toEqual({ rate: 1.5, source: 'cross', monthKey: '2026-10', date: null });
    // El día 6 la de TRY todavía no vale y nadie tiene otra: respaldo (58.76 ÷ 42).
    expect(rateFor(t, '2026-10', 'TRY', 'DOP', '2026-10-06')).toEqual({ rate: 58.76 / 42, source: 'default', monthKey: null, date: null });
    // El día 7 un tramo escrito (USD→TRY) y el otro también; el día 3 USD→DOP sale de los envíos (58.76) y TRY no tiene nada.
    expect(rateFor(t, '2026-10', 'USD', 'DOP', '2026-10-03').source).toBe('transfers');
    // Un tramo escrito y el otro de los envíos del mes: TRY→USD escrita (1/40) × USD→DOP de los envíos (58.76).
    t.months['2026-10']!.rates = [{ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' }];
    expect(rateFor(structuredClone(t), '2026-10', 'TRY', 'DOP', '2026-10-03')).toEqual({ rate: expect.closeTo(58.76 / 40, 10), source: 'cross', monthKey: '2026-10', date: null });
  });

  it('dos tasas del mismo par y la misma fecha: vale la última de la lista', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 1 / 61, date: '2026-10-01' },
    ];
    expect(rateFor(s, '2026-10', 'USD', 'DOP').rate).toBeCloseTo(61, 10);
  });
});

describe('registro del presupuesto', () => {
  it('budgetsFromLog suma por cuenta; lo que suma 0 no aparece', () => {
    expect(budgetsFromLog([])).toEqual({});
    expect(
      budgetsFromLog([
        { accountId: 'dr', amount: 65000 },
        { accountId: 'us', amount: 100 },
        { accountId: 'dr', amount: 5000.1 },
        { accountId: 'dr', amount: -0.1 },
        { accountId: 'us', amount: -100 },
      ]),
    ).toEqual({ dr: 70000 });
    expect(seedState().months['2026-10']!.budgets).toEqual({ dr: 70000 });
  });

  it('el presupuesto del mes es la suma del registro, con ajustes negativos y partes en otra moneda', () => {
    const s = seedState();
    // −100 USD en la US account el día 7: 70,000 − 100 × 58.76 = 64,124.
    s.months['2026-10']!.budgetLog.push({ id: 'cut', date: '2026-10-07', accountId: 'us', amount: -100, kind: 'adjust', note: 'Less' });
    const c = monthCalc(s, '2026-10');
    expect(c.budget).toBeCloseTo(64124, 8);
    expect(c.budgetParts.map((p) => [p.account.id, p.amount, p.fromLog, p.fromIncomes])).toEqual([
      ['us', -100, -100, 0],
      ['dr', 70000, 70000, 0],
    ]);
    expect(c.avail).toBeCloseTo(64124 - 49149.71, 6);
    // calc lee el registro, no Month.budgets (que aquí quedó sin recalcular).
    expect(s.months['2026-10']!.budgets).toEqual({ dr: 70000 });
  });

  it('budgetHistory: el registro en orden de fecha con el total acumulado', () => {
    const s = seedState();
    expect(budgetHistory(s, '2026-10').map((h) => [h.date, h.kind, h.account.id, h.amount, h.note, h.inMain, h.total])).toEqual([
      ['2026-10-01', 'initial', 'dr', 65000, '', 65000, 65000],
      ['2026-10-05', 'adjust', 'dr', 5000, 'Car repair', 5000, 70000],
    ]);
    expect(budgetHistory(s, '2026-10').at(-1)!.total).toBe(monthCalc(s, '2026-10').budget);
    expect(budgetHistory(s, '2026-08').map((h) => [h.id, h.total])).toEqual([['seed-bg-2026-08-1', 70000]]);
    expect(budgetHistory(s, '2031-01')).toEqual([]);
  });
});

describe('ingresos que suben el presupuesto (Income.budget)', () => {
  it('en la moneda de la cuenta: sube el presupuesto del mes de su fecha y solo ese', () => {
    const s = seedState();
    s.incomes.push(
      { id: 'bonus', date: '2026-10-04', desc: 'Bonus', accountId: 'dr', amount: 3000, cur: 'DOP', budget: true },
      // Sin marcar no sube nada; marcado pero de septiembre, sube septiembre.
      { id: 'plain', date: '2026-10-04', desc: 'Gift', accountId: 'dr', amount: 999, cur: 'DOP', budget: false },
      { id: 'sep', date: '2026-09-10', desc: 'Old bonus', accountId: 'dr', amount: 1000, cur: 'DOP', budget: true },
    );
    const c = monthCalc(s, '2026-10');
    expect(c.budget).toBe(73000);
    expect(c.budgetParts.find((p) => p.account.id === 'dr')).toMatchObject({ amount: 73000, fromLog: 70000, fromIncomes: 3000, inMain: 73000 });
    expect(f2(c.avail)).toBe('23,850.29');
    expect(f2(c.budgetSecond)).toBe('1,242.34');
    expect(monthCalc(s, '2026-09').budget).toBe(71000);
    expect(monthCalc(s, '2026-08').budget).toBe(70000);
    // Sigue siendo un ingreso: entra a la cuenta y cuenta en el ingreso del mes.
    expect(c.income).toBeCloseTo(5800 * 58.76 + 3999, 8);
    // Month.budgets es solo el registro.
    expect(s.months['2026-10']!.budgets).toEqual({ dr: 70000 });
  });

  it('en otra moneda: entra a la parte de su cuenta convertido con la tasa de su fecha', () => {
    const s = twoRates();
    s.incomes.push(
      // 100 USD a la cuenta en DOP el día 2 (a 58) y el día 6 (a 60): 5,800 y 6,000 DOP.
      { id: 'a', date: '2026-10-02', desc: 'Gig A', accountId: 'dr', amount: 100, cur: 'USD', budget: true },
      { id: 'b', date: '2026-10-06', desc: 'Gig B', accountId: 'dr', amount: 100, cur: 'USD', budget: true },
      // 50 USD a la cuenta en USD: 50 USD en su parte, 3,000 DOP con la última tasa del mes.
      { id: 'c', date: '2026-10-03', desc: 'Refund', accountId: 'us', amount: 50, cur: 'USD', budget: true },
    );
    const c = monthCalc(s, '2026-10');
    expect(c.budgetParts.map((p) => [p.account.id, p.amount, p.fromLog, p.fromIncomes, p.inMain])).toEqual([
      ['us', 50, 0, 50, 3000],
      ['dr', 81800, 70000, 11800, 81800],
    ]);
    expect(c.budget).toBe(84800);
    expect(c.budgetSecond).toBeCloseTo(84800 / 60, 8);

    expect(budgetHistory(s, '2026-10').map((h) => [h.date, h.kind, h.id, h.account.id, h.amount, h.note, h.total])).toEqual([
      ['2026-10-01', 'initial', 'seed-bg-2026-10-1', 'dr', 65000, '', 65000],
      ['2026-10-02', 'income', 'a', 'dr', 5800, 'Gig A', 70800],
      ['2026-10-03', 'income', 'c', 'us', 50, 'Refund', 73800],
      ['2026-10-05', 'adjust', 'seed-bg-2026-10-2', 'dr', 5000, 'Car repair', 78800],
      ['2026-10-06', 'income', 'b', 'dr', 6000, 'Gig B', 84800],
    ]);
  });

  it('con la misma fecha van primero los movimientos del registro; lo de una cuenta que no existe no cuenta', () => {
    const s = seedState();
    s.incomes.push(
      { id: 'same-day', date: '2026-10-05', desc: '', accountId: 'dr', amount: 10, cur: 'DOP', budget: true },
      { id: 'ghost', date: '2026-10-05', desc: '', accountId: 'gone', amount: 500, cur: 'DOP', budget: true },
    );
    s.months['2026-10']!.budgetLog.push({ id: 'orphan', date: '2026-10-02', accountId: 'gone', amount: 500, kind: 'adjust', note: '' });
    expect(budgetHistory(s, '2026-10').map((h) => [h.kind, h.id, h.total])).toEqual([
      ['initial', 'seed-bg-2026-10-1', 65000],
      ['adjust', 'seed-bg-2026-10-2', 70000],
      ['income', 'same-day', 70010],
    ]);
    expect(monthCalc(s, '2026-10').budget).toBe(70010);
  });
});

describe('sobrante del mes anterior (leftoverFor)', () => {
  // Septiembre: presupuesto 70,000; usado = fijos en DOP 35,872.66 + Claude 106 USD × (134,721 ÷ 2,300) + transacciones 24,555.
  const SEP_LEFT = 70000 - (35872.66 + (106 * 134721) / 2300 + 24555);

  it('es el disponible (presupuesto − usado) del mes registrado anterior, en la moneda principal', () => {
    const s = seedState();
    expect(monthCalc(s, '2026-09').avail).toBeCloseTo(SEP_LEFT, 6);
    expect(f2(SEP_LEFT)).toBe('3,363.46');
    const left = leftoverFor(s, '2026-10');
    expect(left.previousKey).toBe('2026-09');
    expect(left.leftover).toBeCloseTo(SEP_LEFT, 6);
    expect(left.added).toBe(false);
  });

  it('sin mes anterior no hay sobrante; el anterior es el registrado más cercano, aunque falten meses', () => {
    const s = seedState();
    expect(leftoverFor(s, '2026-08')).toEqual({ previousKey: null, leftover: null, added: false });
    // Diciembre no existe (ni noviembre): su anterior es octubre, con 20,850.29 disponibles.
    const dec = leftoverFor(s, '2026-12');
    expect(dec.previousKey).toBe('2026-10');
    expect(f2(dec.leftover!)).toBe('20,850.29');
    expect(dec.added).toBe(false);
  });

  it('`added` dice si el mes ya tiene su movimiento de sobrante; uno negativo resta', () => {
    const s = seedState();
    s.months['2026-10']!.budgetLog.push({ id: 'left', date: '2026-10-02', accountId: 'dr', amount: SEP_LEFT, kind: 'leftover', note: '' });
    expect(leftoverFor(s, '2026-10').added).toBe(true);
    expect(monthCalc(s, '2026-10').budget).toBeCloseTo(70000 + SEP_LEFT, 6);
    expect(budgetHistory(s, '2026-10').map((h) => h.kind)).toEqual(['initial', 'leftover', 'adjust']);

    // Septiembre con 60,000 de presupuesto se pasó: sobrante negativo.
    const over = seedState();
    setBudgets(over.months['2026-09']!, { dr: 60000 });
    expect(leftoverFor(over, '2026-10').leftover).toBeCloseTo(SEP_LEFT - 10000, 6);
    expect(leftoverFor(over, '2026-10').leftover).toBeLessThan(0);
  });

  it('el sobrante incluye lo que los ingresos le subieron al presupuesto de ese mes', () => {
    const s = seedState();
    s.incomes.push({ id: 'sep', date: '2026-09-10', desc: '', accountId: 'dr', amount: 1000, cur: 'DOP', budget: true });
    expect(leftoverFor(s, '2026-10').leftover).toBeCloseTo(SEP_LEFT + 1000, 6);
  });
});

describe('moneda "≈" de una meta (Goal.approxCur)', () => {
  it('null = la moneda principal: savedApprox es savedMain', () => {
    const turkey = goalsProgress(seedState()).find((g) => g.id === 'turkey')!;
    expect(turkey.approxCur).toBe('DOP');
    expect(turkey.savedApprox).toBeCloseTo(9000 * 58.76, 8);
    expect(turkey.savedApprox).toBe(turkey.savedMain);
  });

  it('otra moneda: lo ahorrado se expresa en ella con la última tasa del mes en curso; savedMain no cambia', () => {
    const s = seedState();
    s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-02' });
    s.goals.find((g) => g.id === 'turkey')!.approxCur = 'TRY';
    const turkey = goalsProgress(s).find((g) => g.id === 'turkey')!;
    expect(turkey.approxCur).toBe('TRY');
    expect(turkey.savedApprox).toBeCloseTo(360000, 8);
    expect(turkey.savedMain).toBeCloseTo(9000 * 58.76, 8);
    expect(totalSaved(s)).toBeCloseTo(10650 * 58.76, 6);
  });

  it('puede ser la moneda de la propia meta: la misma cifra', () => {
    const s = seedState();
    s.goals.find((g) => g.id === 'turkey')!.approxCur = 'USD';
    const turkey = goalsProgress(s).find((g) => g.id === 'turkey')!;
    expect([turkey.cur, turkey.approxCur, turkey.saved, turkey.savedApprox]).toEqual(['USD', 'USD', 9000, 9000]);
  });
});

describe('fechas dentro del mes', () => {
  it('firstDay, lastDay, inMonth y clampToMonth', () => {
    expect(firstDay('2026-10')).toBe('2026-10-01');
    expect([lastDay('2026-10'), lastDay('2026-02'), lastDay('2028-02'), lastDay('2026-12')]).toEqual(['2026-10-31', '2026-02-28', '2028-02-29', '2026-12-31']);
    expect([inMonth('2026-10-31', '2026-10'), inMonth('2026-11-01', '2026-10')]).toEqual([true, false]);
    expect(clampToMonth('2026-10-08', '2026-10')).toBe('2026-10-08');
    expect(clampToMonth('2026-09-30', '2026-10')).toBe('2026-10-01');
    expect(clampToMonth('2027-01-02', '2026-11')).toBe('2026-11-30');
  });
});

describe('balances: todo mueve los saldos', () => {
  const s = seedState();

  it('saldo = inicial + ingresos − gastos pagados desde la cuenta ± envíos', () => {
    const b = balances(s, '2026-10');
    const us = b.accounts.find((a) => a.account.id === 'us')!;
    const dr = b.accounts.find((a) => a.account.id === 'dr')!;
    // US: 2,000 + 3 × 5,800 − envíos (1,800 + 2,300 + 1,500) − Claude 106 × 3 meses pagado
    expect(us.balance).toBeCloseTo(2000 + 17400 - 5600 - 318, 8);
    // DR: 60,000 + lo recibido (104,730 + 134,721 + 88,140) − transacciones (27,850 + 24,555 + 10,845)
    //     − fijos pagados en DOP (35,750.26 + 35,872.66 + 32,076.15)
    expect(dr.balance).toBeCloseTo(60000 + 327591 - 63250 - 103699.07, 6);
    expect(f2(dr.balance)).toBe('220,641.93');
    expect(us.inMain).toBeCloseTo(13482 * 58.76, 6);
    expect(f2(b.totalMain)).toBe('1,012,844.25');
    expect(b.totalSecond).toBeCloseTo(13482 + 220641.93 / 58.76, 6);
  });

  it('al final de un mes anterior solo cuenta lo de hasta ese mes, con sus tasas', () => {
    const b = balances(s, '2026-08');
    const us = b.accounts.find((a) => a.account.id === 'us')!;
    const dr = b.accounts.find((a) => a.account.id === 'dr')!;
    expect(us.balance).toBeCloseTo(2000 + 5800 - 1800 - 106, 8);
    expect(dr.balance).toBeCloseTo(60000 + 104730 - 27850 - 35750.26, 6);
    expect(us.inMain).toBeCloseTo(us.balance * ((1500 * 58.4 + 300 * 57.1) / 1800), 6);
  });

  it('un gasto fijo solo resta mientras está pagado', () => {
    const t = seedState();
    const before = balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance;
    t.months['2026-10']!.fixed.find((f) => f.name === 'Netflix')!.paid = true;
    expect(balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(before - 1137.3, 8);
  });

  it('un gasto en otra moneda resta de la cuenta convertido con la tasa de su mes', () => {
    const t = seedState();
    const before = balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance;
    t.months['2026-10']!.tx.push({ ...t.months['2026-10']!.tx[0]!, id: 'usd-from-dr', amount: 10, cur: 'USD', accountId: 'dr' });
    expect(balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(before - 587.6, 8);
  });

  it('las cuentas ocultas no suman al total; un movimiento sin cuenta se ignora', () => {
    const t = seedState();
    const all = balances(t, '2026-10').totalMain;
    t.accounts.find((a) => a.id === 'us')!.hidden = true;
    const b = balances(t, '2026-10');
    expect(b.accounts).toHaveLength(2);
    expect(b.totalMain).toBeCloseTo(all - 13482 * 58.76, 6);
    t.incomes.push({ id: 'ghost', date: '2026-10-05', desc: '', accountId: 'gone', amount: 999, cur: 'USD', budget: false });
    expect(balances(t, '2026-10').totalMain).toBeCloseTo(b.totalMain, 8);
  });

  it('openingFor: corregir un saldo es mover el saldo inicial lo que haga falta', () => {
    const t = seedState();
    const opening = openingFor(t, 'dr', '2026-10', 200000);
    expect(opening).toBeCloseTo(60000 + (200000 - 220641.93), 6);
    t.accounts.find((a) => a.id === 'dr')!.opening = opening;
    expect(balances(t, '2026-10').accounts.find((a) => a.account.id === 'dr')!.balance).toBeCloseTo(200000, 6);
  });

  it('defaultAccount: la elegida, o la primera visible en la moneda principal', () => {
    const t = seedState();
    expect(defaultAccount(t)!.id).toBe('dr');
    t.defaultAccountId = null;
    expect(defaultAccount(t)!.id).toBe('dr');
    t.mainCurrency = 'TRY';
    expect(defaultAccount(t)!.id).toBe('us');
    t.defaultAccountId = 'dr';
    t.accounts.find((a) => a.id === 'dr')!.hidden = true;
    expect(defaultAccount(t)!.id).toBe('us');
    t.accounts = [];
    expect(defaultAccount(t)).toBeNull();
  });
});

describe('otra moneda principal', () => {
  const tryState = (): AppState => {
    const s = seedState();
    s.mainCurrency = 'TRY';
    s.secondCurrency = 'USD';
    s.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
    ];
    return s;
  };

  it('todo el mes se expresa en la moneda principal', () => {
    const c = monthCalc(tryState(), '2026-10');
    expect(c.main).toBe('TRY');
    expect(c.rate.rate).toBe(40);
    expect(c.budget).toBeCloseTo((70000 / 58.76) * 40, 6);
    expect(c.varSpent).toBeCloseTo((10845 / 58.76) * 40, 6);
    expect(c.usedSecond).toBeCloseTo(49149.71 / 58.76, 4);
    expect(c.income).toBeCloseTo(5800 * 40, 8);
  });
});

describe('ahorros', () => {
  const s = seedState();

  it('mes en curso = último mes abierto', () => {
    expect(currentKey(s)).toBe('2026-10');
  });

  it('Trip to Turkey: 15 meses × 3,000 = 45,000 USD', () => {
    const turkey = goalsProgress(s).find((g) => g.id === 'turkey')!;
    expect(turkey.cur).toBe('USD');
    expect(turkey.saved).toBe(9000);
    expect(turkey.savedMain).toBeCloseTo(9000 * 58.76, 8);
    expect(f0(turkey.target!.targetAmount)).toBe('45,000');
    expect(turkey.target!.pct).toBeCloseTo(20, 10);
    // Octubre ya tiene aporte: quedan nov-2026..oct-2027 = 12 aportes de 3,000.
    expect(turkey.target!.left).toBe(12);
    expect(turkey.target!.needPerMonth).toBe(3000);
  });

  it('un aporte en otra moneda se convierte a la de la meta con la tasa de su mes', () => {
    const t = seedState();
    t.contribs.push({ id: 'dop', goalId: 'emergency', date: '2026-10-08', amount: 5876, cur: 'DOP' });
    expect(goalsProgress(t).find((g) => g.id === 'emergency')!.saved).toBeCloseTo(1200 + 100, 8);
  });

  it('una meta en otra moneda lleva lo ahorrado y el objetivo en la suya', () => {
    const t = seedState();
    t.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    t.goals.push({ id: 'tr', name: 'Istanbul flat', cur: 'TRY', monthly: 10000, start: '2026-10', end: '2027-09', approxCur: null, sort: 3 });
    t.contribs.push({ id: 'c-tr', goalId: 'tr', date: '2026-10-05', amount: 100, cur: 'USD' });
    const g = goalsProgress(t).find((x) => x.id === 'tr')!;
    expect(g.saved).toBeCloseTo(4000, 8);
    expect(g.target!.targetAmount).toBe(120000);
    expect(g.savedMain).toBeCloseTo(100 * 58.76, 6);
  });

  it('metas de aportes variables no tienen objetivo', () => {
    const [emergency, personal] = goalsProgress(s);
    expect(emergency!.target).toBeNull();
    expect(emergency!.saved).toBe(1200);
    expect(emergency!.contribCount).toBe(3);
    expect(personal!.saved).toBe(450);
  });

  it('ingresos por mes y total ahorrado, en la moneda principal', () => {
    const rows = incomeRows(s);
    expect(rows.map((r) => r.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    const augRate = (1500 * 58.4 + 300 * 57.1) / 1800;
    expect(rows[0]!.income).toBeCloseTo(5800 * augRate, 6);
    expect(rows[0]!.saved).toBeCloseTo(3650 * augRate, 6);
    expect(rows[0]!.pct).toBeCloseTo((3650 / 5800) * 100, 8);
    expect(totalSaved(s)).toBeCloseTo(10650 * 58.76, 6);
    const t = seedState();
    t.incomes = [];
    expect(incomeRows(t)[0]!.pct).toBeNull();
  });
});

describe('ring y formato', () => {
  it('ring: un segmento por valor, encadenados; negativos y no finitos no ocupan', () => {
    const circ = 2 * Math.PI * 64;
    const [a, b, c] = ring([50, -10, 50]);
    const len = (seg: { dash: string }) => +seg.dash.split(' ')[0]!;
    expect(len(a!)).toBeCloseTo(circ / 2, 8);
    expect(len(b!)).toBe(0);
    expect(c!.offset).toBeCloseTo(-circ / 2, 8);
    expect(len(ring([0, Number.NaN])[0]!)).toBe(0);
  });

  it('es-DO sin depender del locale del runtime', () => {
    expect(f2(1234567.891)).toBe('1,234,567.89');
    expect(f2(-1234.5)).toBe('-1,234.50');
    expect(f2(-0.001)).toBe('0.00');
    expect(f2(Number.NaN)).toBe('0.00');
    expect(f0(999.5)).toBe('1,000');
    expect(f0(-0.4)).toBe('0');
  });
});
