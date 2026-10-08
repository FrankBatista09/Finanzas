import { describe, expect, it } from 'vitest';
import {
  balances,
  convert,
  currentKey,
  defaultAccount,
  donut,
  goalsProgress,
  incomeRows,
  monthCalc,
  openingFor,
  rateFor,
  ring,
  totalSaved,
} from './calc';
import { f0, f2 } from './format';
import { seedState } from './seed';
import type { AppState } from './types';

// Las cifras del mes son las del prototipo del diseño (mismos gastos, mismo presupuesto, misma tasa);
// los saldos y los ingresos son del modelo de cuentas, calculados a mano en los comentarios.

describe('monthCalc · October 2026 (mes en curso, moneda principal DOP)', () => {
  const s = seedState();
  const c = monthCalc(s, '2026-10');

  it('la tasa del mes es la escrita a mano', () => {
    expect(c.main).toBe('DOP');
    expect(c.second).toBe('USD');
    expect(c.rate).toEqual({ rate: 58.76, source: 'month', monthKey: '2026-10' });
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
  });

  it('una parte del presupuesto en otra moneda se convierte con la tasa del mes', () => {
    const t = seedState();
    t.months['2026-10']!.budgets = { us: 200, dr: 58248 };
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
    s.months['2026-08']!.rates = [{ from: 'USD', to: 'DOP', rate: 60 }];
    expect(rateFor(s, '2026-08', 'USD', 'DOP')).toEqual({ rate: 60, source: 'month', monthKey: '2026-08' });
    expect(rateFor(s, '2026-08', 'DOP', 'USD').rate).toBeCloseTo(1 / 60, 12);
    expect(rateFor(s, '2026-08', 'DOP', 'DOP')).toEqual({ rate: 1, source: 'same', monthKey: null });
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
      { from: 'USD', to: 'DOP', rate: 60 },
      { from: 'USD', to: 'TRY', rate: 40 },
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

    expect(rateFor(s, '2026-10', 'USD', 'TRY')).toEqual({ rate: 42, source: 'default', monthKey: null });
    expect(rateFor(s, '2026-01', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'default', monthKey: null });
    expect(rateFor(s, '2026-01', 'TRY', 'DOP').rate).toBeCloseTo(58.76 / 42, 12);
  });

  it('acepta meses sin registro: toma el anterior más cercano', () => {
    const s = seedState();
    expect(rateFor(s, '2027-03', 'USD', 'DOP')).toEqual({ rate: 58.76, source: 'previous', monthKey: '2026-10' });
  });

  it('una tasa escrita con 0 o negativa se ignora', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 0 }];
    expect(rateFor(s, '2026-10', 'USD', 'DOP').source).toBe('transfers');
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
    t.incomes.push({ id: 'ghost', date: '2026-10-05', desc: '', accountId: 'gone', amount: 999, cur: 'USD' });
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
      { from: 'USD', to: 'DOP', rate: 58.76 },
      { from: 'USD', to: 'TRY', rate: 40 },
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
    t.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40 });
    t.goals.push({ id: 'tr', name: 'Istanbul flat', cur: 'TRY', monthly: 10000, start: '2026-10', end: '2027-09', sort: 3 });
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
