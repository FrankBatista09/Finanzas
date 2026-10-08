import { describe, expect, it } from 'vitest';
import type { GoalProgress } from '../../../shared/calc';
import { seedState } from '../../../shared/seed';
import type { AppState, Contribution, Income, Language } from '../../../shared/types';
import {
  afterAdd,
  afterIncomeAdd,
  contributionRows,
  draftInput,
  EMPTY_DRAFT,
  EMPTY_INCOME,
  goalCard,
  goalCards,
  goalOptions,
  goalOptionsFor,
  incomeDraftInput,
  incomeItems,
  incomeRowViews,
  monthInSentence,
  NO_NOTE,
  pctText,
  rateNote,
  resolveDraft,
  resolveIncomeDraft,
  wholeAmount,
} from './model';
import type { ContributionDraft, IncomeDraft } from './model';

const TODAY = '2026-10-07';
const LANGS: Language[] = ['en', 'es', 'tr'];

const FROM_TRANSFERS = { hint: "from this month's transfers", fallback: false };
const DEFAULT_RATE_NOTE = { hint: 'default value, not set yet', fallback: true };

/** Los datos de ejemplo con una tasa escrita en octubre: 1 USD = 40 TRY. */
function withTRY(): AppState {
  const s = seedState();
  s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40 });
  return s;
}

describe('nota de la tasa de una cifra convertida', () => {
  const s = seedState();

  it('sin conversión o con la tasa escrita para ese mes no hay nada que decir', () => {
    expect(rateNote(s, '2026-10', 'USD', 'USD', 'en')).toBe(NO_NOTE);
    expect(rateNote(s, '2026-10', 'USD', 'DOP', 'en')).toBe(NO_NOTE);
    // La inversa de la escrita también es la del mes.
    expect(rateNote(s, '2026-10', 'DOP', 'USD', 'en')).toBe(NO_NOTE);
  });

  it('de los envíos del mes, de un mes anterior o cruzada: se dice de dónde salió, sin alarma', () => {
    expect(rateNote(s, '2026-08', 'USD', 'DOP', 'en')).toEqual(FROM_TRANSFERS);
    expect(rateNote(s, '2026-08', 'USD', 'DOP', 'es')).toEqual({ hint: 'de los envíos de este mes', fallback: false });
    expect(rateNote(s, '2026-08', 'USD', 'DOP', 'tr')).toEqual({ hint: 'bu ayın transferlerinden', fallback: false });
    // Un mes sin registro usa el registrado anterior más cercano.
    expect(rateNote(s, '2027-01', 'USD', 'DOP', 'en')).toEqual({ hint: 'from October 2026', fallback: false });
    expect(rateNote(s, '2027-01', 'USD', 'DOP', 'es')).toEqual({ hint: 'de octubre 2026', fallback: false });
    expect(rateNote(withTRY(), '2026-10', 'TRY', 'DOP', 'en')).toEqual({ hint: 'crossed through USD', fallback: false });
  });

  it('el valor fijo de respaldo se marca: nadie ha escrito esa tasa', () => {
    expect(rateNote(s, '2026-10', 'USD', 'TRY', 'en')).toEqual(DEFAULT_RATE_NOTE);
    expect(rateNote(s, '2026-10', 'TRY', 'DOP', 'es')).toEqual({ hint: 'valor por defecto, aún sin definir', fallback: true });
    expect(rateNote(s, '2026-10', 'TRY', 'DOP', 'tr')).toEqual({ hint: 'varsayılan değer, henüz girilmedi', fallback: true });
    expect(rateNote(withTRY(), '2026-10', 'USD', 'TRY', 'en')).toBe(NO_NOTE);
  });
});

// Valores de referencia: los que muestra el prototipo en la hoja de ahorros con los datos de ejemplo.
describe('tarjetas de metas', () => {
  it('datos de ejemplo, en inglés: dos metas de aportes variables y el viaje con objetivo', () => {
    expect(goalCards(seedState(), 'en')).toEqual([
      {
        id: 'emergency',
        name: 'Emergency fund',
        cur: 'USD',
        kind: 'Variable contributions',
        saved: '1,200.00',
        savedMain: '70,512', // 1,200 × 58.76, la tasa del mes en curso (escrita a mano: sin nota)
        mainNote: NO_NOTE,
        plan: '3 contributions recorded',
        target: null,
      },
      {
        id: 'personal',
        name: 'Personal savings',
        cur: 'USD',
        kind: 'Variable contributions',
        saved: '450.00',
        savedMain: '26,442',
        mainNote: NO_NOTE,
        plan: '2 contributions recorded',
        target: null,
      },
      {
        id: 'turkey',
        name: 'Trip to Turkey',
        cur: 'USD',
        kind: '3,000 USD / month',
        saved: '9,000.00',
        savedMain: '528,840',
        mainNote: NO_NOTE,
        plan: '12 contributions left · 3,000 USD per month to get there',
        target: { value: 20, progress: '20% of 45,000 USD', deadline: 'Target: October 2027' },
      },
    ]);
  });

  it('en español salen los textos de la versión 1; el nombre de la meta y las cifras no cambian', () => {
    const [emergency, , turkey] = goalCards(seedState(), 'es');
    expect(emergency).toMatchObject({ name: 'Emergency fund', kind: 'Aportes variables', saved: '1,200.00', plan: '3 aportes registrados' });
    expect(turkey).toEqual({
      id: 'turkey',
      name: 'Trip to Turkey',
      cur: 'USD',
      kind: '3,000 USD / mes',
      saved: '9,000.00',
      savedMain: '528,840',
      mainNote: NO_NOTE,
      plan: 'Faltan 12 aportes · 3,000 USD por mes para llegar',
      target: { value: 20, progress: '20% de 45,000 USD', deadline: 'Meta: octubre 2027' },
    });
  });

  it('en turco: el porcentaje lleva el signo delante y el mes va con mayúscula', () => {
    const [emergency, , turkey] = goalCards(seedState(), 'tr');
    expect(emergency).toMatchObject({ name: 'Emergency fund', kind: 'Değişken katkılar', plan: '3 katkı kaydedildi' });
    expect(turkey).toEqual({
      id: 'turkey',
      name: 'Trip to Turkey',
      cur: 'USD',
      kind: '3,000 USD / ay',
      saved: '9,000.00',
      savedMain: '528,840',
      mainNote: NO_NOTE,
      plan: '12 katkı kaldı · hedefe ulaşmak için ayda 3,000 USD',
      target: { value: 20, progress: '%20 / 45,000 USD', deadline: 'Hedef: Ekim 2027' },
    });
  });

  it('las tarjetas salen en el orden de `sort`, no en el del arreglo', () => {
    const s = seedState();
    s.goals.reverse();
    expect(goalCards(s, 'en').map((g) => g.id)).toEqual(['emergency', 'personal', 'turkey']);
  });

  const progress = (over: Partial<GoalProgress> = {}): GoalProgress => ({
    id: 'g',
    name: 'Goal',
    cur: 'USD',
    saved: 0,
    savedMain: 0,
    contribCount: 0,
    target: null,
    ...over,
  });
  const target = (over: Partial<NonNullable<GoalProgress['target']>> = {}): NonNullable<GoalProgress['target']> => ({
    monthly: 3000,
    targetAmount: 45000,
    pct: 0,
    end: '2027-10',
    left: 15,
    needPerMonth: 3000,
    ...over,
  });

  it('sin aportes: ceros y plural', () => {
    expect(goalCard(progress(), 'en', 'DOP')).toMatchObject({ saved: '0.00', savedMain: '0', plan: '0 contributions recorded' });
    expect(goalCard(progress(), 'es', 'DOP').plan).toBe('0 aportes registrados');
    expect(goalCard(progress(), 'tr', 'DOP').plan).toBe('0 katkı kaydedildi');
  });

  it('un solo aporte va en singular, en cada idioma', () => {
    const one = progress({ contribCount: 1 });
    expect(goalCard(one, 'en', 'DOP').plan).toBe('1 contribution recorded');
    expect(goalCard(one, 'es', 'DOP').plan).toBe('1 aporte registrado');
    expect(goalCard(one, 'tr', 'DOP').plan).toBe('1 katkı kaydedildi');

    const last = progress({ target: target({ left: 1, needPerMonth: 1234.5 }) });
    expect(goalCard(last, 'en', 'DOP').plan).toBe('1 contribution left · 1,235 USD per month to get there');
    expect(goalCard(last, 'es', 'DOP').plan).toBe('Falta 1 aporte · 1,235 USD por mes para llegar');
    expect(goalCard(last, 'tr', 'DOP').plan).toBe('1 katkı kaldı · hedefe ulaşmak için ayda 1,235 USD');
  });

  it('el porcentaje se muestra sin decimales y la barra usa el valor sin redondear', () => {
    const t = goalCard(progress({ target: target({ pct: 33.33333 }) }), 'en', 'DOP').target!;
    expect(t.progress).toBe('33% of 45,000 USD');
    expect(t.value).toBe(33.33333);
    expect(goalCard(progress({ target: target({ pct: 99.5 }) }), 'en', 'DOP').target!.progress).toBe('100% of 45,000 USD');
    expect(goalCard(progress({ target: target({ pct: 100 }) }), 'en', 'DOP').target!.progress).toBe('100% of 45,000 USD');
  });

  it('aporte mensual, objetivo y cuota con separador de miles, igual en los tres idiomas', () => {
    const g = progress({ target: target({ monthly: 1250.4, targetAmount: 1234567.4, end: '2028-01', left: 20, needPerMonth: 61728.37 }) });
    const en = goalCard(g, 'en', 'DOP');
    expect(en.kind).toBe('1,250 USD / month');
    expect(en.target).toMatchObject({ progress: '0% of 1,234,567 USD', deadline: 'Target: January 2028' });
    expect(en.plan).toBe('20 contributions left · 61,728 USD per month to get there');

    const es = goalCard(g, 'es', 'DOP');
    expect(es.kind).toBe('1,250 USD / mes');
    expect(es.target).toMatchObject({ progress: '0% de 1,234,567 USD', deadline: 'Meta: enero 2028' });
    expect(es.plan).toBe('Faltan 20 aportes · 61,728 USD por mes para llegar');

    const tr = goalCard(g, 'tr', 'DOP');
    expect(tr.kind).toBe('1,250 USD / ay');
    expect(tr.target).toMatchObject({ progress: '%0 / 1,234,567 USD', deadline: 'Hedef: Ocak 2028' });
    expect(tr.plan).toBe('20 katkı kaldı · hedefe ulaşmak için ayda 61,728 USD');
  });

  it('el mes dentro de una frase: en minúscula solo en español', () => {
    expect(monthInSentence('2027-10', 'en')).toBe('October 2027');
    expect(monthInSentence('2027-10', 'es')).toBe('octubre 2027');
    expect(monthInSentence('2027-10', 'tr')).toBe('Ekim 2027');
  });

  describe('meta cumplida o con el mes objetivo pasado', () => {
    it('con el objetivo cubierto dice que se llegó, no "0 USD por mes"', () => {
      const done = progress({ saved: 45000, target: target({ pct: 100, left: 12, needPerMonth: 0 }) });
      expect(goalCard(done, 'en', 'DOP', '2026-10').plan).toBe('Target reached');
      expect(goalCard(done, 'es', 'DOP', '2026-10').plan).toBe('Meta alcanzada');
      expect(goalCard(done, 'tr', 'DOP', '2026-10').plan).toBe('Hedefe ulaşıldı');
      // La barra, el objetivo y el mes siguen ahí.
      expect(goalCard(done, 'en', 'DOP', '2026-10').target).toEqual({ value: 100, progress: '100% of 45,000 USD', deadline: 'Target: October 2027' });
      // De más también es llegar, y da igual que el mes objetivo ya haya pasado.
      expect(goalCard(progress({ saved: 50000, target: target({ pct: 100, left: 1, needPerMonth: 0 }) }), 'en', 'DOP', '2028-01').plan).toBe('Target reached');
    });

    it('se compara en centavos: 833.33… × 12 cuenta como 10,000', () => {
      const t = target({ monthly: 10000 / 12, targetAmount: (10000 / 12) * 12, pct: 100, left: 1, needPerMonth: 0 });
      expect(goalCard(progress({ saved: 10000, target: t }), 'en', 'DOP').plan).toBe('Target reached');
      expect(goalCard(progress({ saved: 10000, target: { ...t, targetAmount: 10000.000000000002 } }), 'en', 'DOP').plan).toBe('Target reached');
      expect(goalCard(progress({ saved: 9999.99, target: { ...t, needPerMonth: 0.01 } }), 'en', 'DOP').plan).toBe(
        '1 contribution left · 0.01 USD per month to get there',
      );
    });

    it('pasado el mes objetivo sin llegar dice cuánto falta, no una cuota mensual', () => {
      const late = progress({ saved: 9000, target: target({ pct: 20, left: 1, needPerMonth: 36000 }) });
      expect(goalCard(late, 'en', 'DOP', '2027-11').plan).toBe('Target month passed · 36,000.00 USD to go');
      expect(goalCard(late, 'es', 'DOP', '2027-11').plan).toBe('El mes objetivo ya pasó · faltan 36,000.00 USD');
      expect(goalCard(late, 'tr', 'DOP', '2027-11').plan).toBe('Hedef ay geçti · 36,000.00 USD kaldı');
      // En el propio mes objetivo todavía se puede aportar.
      expect(goalCard(late, 'en', 'DOP', '2027-10').plan).toBe('1 contribution left · 36,000 USD per month to get there');
      // Sin meses registrados no hay "mes en curso" con el que comparar.
      expect(goalCard(late, 'en', 'DOP').plan).toBe('1 contribution left · 36,000 USD per month to get there');
    });

    it('con el estado completo: el mes en curso es el de shared/calc', () => {
      const s = seedState();
      const turkey = s.goals.find((g) => g.id === 'turkey')!;
      // El plan acabó en septiembre y octubre es el mes en curso. 2 meses × 3,000 = 6,000, y hay 9,000 ahorrados.
      Object.assign(turkey, { start: '2026-08', end: '2026-09' });
      expect(goalCards(s, 'en')[2]).toMatchObject({ plan: 'Target reached', target: { value: 100, progress: '100% of 6,000 USD', deadline: 'Target: September 2026' } });
      // 2 meses × 10,000 = 20,000: faltan 11,000 y el mes objetivo ya pasó.
      turkey.monthly = 10000;
      expect(goalCards(s, 'en')[2]).toMatchObject({ kind: '10,000 USD / month', plan: 'Target month passed · 11,000.00 USD to go' });
    });

    it('una cuota de menos de 1 USD conserva los centavos en vez de salir como 0', () => {
      const g = progress({ saved: 44998, target: target({ pct: 99.99, left: 5, needPerMonth: 0.4 }) });
      expect(goalCard(g, 'en', 'DOP', '2026-10').plan).toBe('5 contributions left · 0.40 USD per month to get there');
      expect(wholeAmount(3000)).toBe('3,000');
      expect(wholeAmount(1234.5)).toBe('1,235');
      expect(wholeAmount(0.5)).toBe('1');
      expect(wholeAmount(0.49)).toBe('0.49');
      expect(wholeAmount(0)).toBe('0.00');
    });
  });

  it('la meta en otra moneda: sus cifras y sus frases llevan ese código', () => {
    const g = progress({ cur: 'TRY', saved: 126000, savedMain: 176280, target: target({ monthly: 42000, targetAmount: 630000, pct: 20, left: 12, needPerMonth: 42000 }) });
    expect(goalCard(g, 'en', 'DOP', '2026-10')).toEqual({
      id: 'g',
      name: 'Goal',
      cur: 'TRY',
      kind: '42,000 TRY / month',
      saved: '126,000.00',
      savedMain: '176,280',
      mainNote: NO_NOTE,
      plan: '12 contributions left · 42,000 TRY per month to get there',
      target: { value: 20, progress: '20% of 630,000 TRY', deadline: 'Target: October 2027' },
    });
    expect(goalCard(g, 'es', 'DOP', '2026-10')).toMatchObject({ kind: '42,000 TRY / mes', plan: 'Faltan 12 aportes · 42,000 TRY por mes para llegar' });
    expect(goalCard(g, 'tr', 'DOP', '2026-10')).toMatchObject({ kind: '42,000 TRY / ay', target: { progress: '%20 / 630,000 TRY' } });
    expect(goalCard(g, 'en', 'DOP', '2027-11').plan).toBe('Target month passed · 504,000.00 TRY to go');
    expect(goalCard(g, 'es', 'DOP', '2027-11').plan).toBe('El mes objetivo ya pasó · faltan 504,000.00 TRY');
    expect(goalCard(g, 'tr', 'DOP', '2027-11').plan).toBe('Hedef ay geçti · 504,000.00 TRY kaldı');
  });

  it('una meta en la moneda principal no lleva línea "≈"', () => {
    expect(goalCard(progress({ cur: 'DOP', saved: 5000, savedMain: 5000 }), 'en', 'DOP')).toMatchObject({ saved: '5,000.00', savedMain: null });
    // Aunque se le pase una nota, no hay conversión de la que hablar.
    expect(goalCard(progress({ cur: 'DOP' }), 'en', 'DOP', null, DEFAULT_RATE_NOTE).mainNote).toBe(NO_NOTE);
    const s = seedState();
    s.mainCurrency = 'USD';
    s.secondCurrency = 'DOP';
    expect(goalCards(s, 'en').map((g) => g.savedMain)).toEqual([null, null, null]);
    expect(goalCards(s, 'en').map((g) => g.saved)).toEqual(['1,200.00', '450.00', '9,000.00']);
  });

  it('la línea "≈" lleva la nota de la tasa del mes en curso; con la de respaldo se marca', () => {
    expect(goalCard(progress(), 'en', 'DOP', '2026-10', FROM_TRANSFERS).mainNote).toEqual(FROM_TRANSFERS);
    // Nadie ha escrito una tasa para TRY: 1 USD = 42 TRY y 1 USD = 58.76 DOP son los valores de respaldo.
    const s = seedState();
    Object.assign(s.goals.find((g) => g.id === 'turkey')!, { cur: 'TRY' });
    expect(goalCards(s, 'en')[2]).toMatchObject({
      cur: 'TRY',
      kind: '3,000 TRY / month',
      saved: '378,000.00', // 9,000 USD × 42
      savedMain: '528,840', // 378,000 TRY × 58.76 / 42
      mainNote: DEFAULT_RATE_NOTE,
      plan: 'Target reached',
      target: { value: 100, progress: '100% of 45,000 TRY' },
    });
    // Con la tasa escrita la nota desaparece de las metas que no pasan por TRY, y la de TRY → DOP sale cruzada.
    const t = withTRY();
    Object.assign(t.goals.find((g) => g.id === 'turkey')!, { cur: 'TRY' });
    expect(goalCards(t, 'en').map((g) => g.mainNote)).toEqual([NO_NOTE, NO_NOTE, { hint: 'crossed through USD', fallback: false }]);
  });

  it('una meta con aporte en DOP suma su equivalente en USD a la tasa del mes del aporte', () => {
    const s = seedState();
    // Agosto: (1,500 × 58.40 + 300 × 57.10) / 1,800 = 58.18333…
    s.contribs.push({ id: 'x', goalId: 'personal', date: '2026-08-25', amount: 5818.33, cur: 'DOP' });
    const personal = goalCards(s, 'en')[1]!;
    expect(personal.saved).toBe('550.00');
    expect(personal.plan).toBe('3 contributions recorded');
  });
});

describe('ingresos por mes', () => {
  it('datos de ejemplo: todo en la moneda principal, a la tasa de cada mes', () => {
    expect(incomeRowViews(seedState(), 'en')).toEqual([
      // 5,800 × 58.18333… ; 3,650 × 58.18333… ; 3,650 / 5,800
      { key: '2026-08', label: 'August 2026', income: '337,463.33', saved: '212,369.17', pct: '62.9%', incomeFallback: false, savedFallback: false },
      // (1,500 × 58.55 + 800 × 58.62) / 2,300 = 58.57434… ; 3,500 / 5,800
      { key: '2026-09', label: 'September 2026', income: '339,731.22', saved: '205,010.22', pct: '60.3%', incomeFallback: false, savedFallback: false },
      { key: '2026-10', label: 'October 2026', income: '340,808.00', saved: '205,660.00', pct: '60.3%', incomeFallback: false, savedFallback: false },
    ]);
  });

  it('con la moneda principal en USD salen las mismas filas en USD', () => {
    const s = seedState();
    s.mainCurrency = 'USD';
    s.secondCurrency = 'DOP';
    expect(incomeRowViews(s, 'en').map((r) => `${r.income} ${r.saved} ${r.pct}`)).toEqual([
      '5,800.00 3,650.00 62.9%',
      '5,800.00 3,500.00 60.3%',
      '5,800.00 3,500.00 60.3%',
    ]);
  });

  it('el nombre del mes sale en el idioma pedido; las cifras llevan el mismo formato en todos', () => {
    expect(incomeRowViews(seedState(), 'es').map((r) => r.label)).toEqual(['Agosto 2026', 'Septiembre 2026', 'Octubre 2026']);
    expect(incomeRowViews(seedState(), 'tr').map((r) => r.label)).toEqual(['Ağustos 2026', 'Eylül 2026', 'Ekim 2026']);
    const figures = (lang: Language) => incomeRowViews(seedState(), lang).map(({ label: _label, ...rest }) => rest);
    for (const lang of LANGS) expect(figures(lang)).toEqual(figures('en'));
  });

  it('el ingreso del mes es la suma de sus ingresos, cada uno por su fecha', () => {
    const s = seedState();
    s.incomes.push({ id: 'x', date: '2026-10-15', desc: 'Bonus', accountId: 'dr', amount: 10000, cur: 'DOP' });
    const rows = incomeRowViews(s, 'en');
    expect(rows[2]).toMatchObject({ income: '350,808.00', saved: '205,660.00', pct: '58.6%' });
    expect(rows[1]!.income).toBe('339,731.22');
  });

  it('un mes sin ingreso no tiene % de ahorro', () => {
    const s = seedState();
    s.incomes = s.incomes.filter((i) => !i.date.startsWith('2026-09'));
    expect(incomeRowViews(s, 'en')[1]).toMatchObject({ income: '0.00', saved: '205,010.22', pct: '—' });
  });

  it('se marca el mes en el que algo se convirtió con la tasa de respaldo', () => {
    const s = seedState();
    s.incomes.push({ id: 'x', date: '2026-09-10', desc: '', accountId: 'dr', amount: 4200, cur: 'TRY' });
    expect(incomeRowViews(s, 'en').map((r) => r.incomeFallback)).toEqual([false, true, false]);
    expect(incomeRowViews(s, 'en').map((r) => r.savedFallback)).toEqual([false, false, false]);
    // 4,200 TRY = 100 USD = 5,876 DOP con los valores de respaldo.
    expect(incomeRowViews(s, 'en')[1]!.income).toBe('345,607.22');
    // Un aporte marca la columna de lo ahorrado, no la del ingreso.
    const t = seedState();
    t.contribs.push({ id: 'x', goalId: 'personal', date: '2026-08-10', amount: 100, cur: 'TRY' });
    expect(incomeRowViews(t, 'en').map((r) => r.savedFallback)).toEqual([true, false, false]);
    expect(incomeRowViews(t, 'en').map((r) => r.incomeFallback)).toEqual([false, false, false]);
    // Con la tasa escrita en el mes ya no es de respaldo.
    const u = withTRY();
    u.incomes.push({ id: 'x', date: '2026-10-10', desc: '', accountId: 'dr', amount: 4000, cur: 'TRY' });
    expect(incomeRowViews(u, 'en').map((r) => r.incomeFallback)).toEqual([false, false, false]);
  });

  it('% de ahorro: un decimal', () => {
    expect(pctText(null)).toBe('—');
    expect(pctText(0)).toBe('0.0%');
    expect(pctText(62.931)).toBe('62.9%');
    expect(pctText(99.96)).toBe('100.0%');
    expect(pctText(250)).toBe('250.0%');
    expect(pctText(Number.NaN)).toBe('—');
    expect(pctText(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('ingresos, uno por uno', () => {
  it('datos de ejemplo: del más reciente al más antiguo, con su equivalente en la moneda principal', () => {
    expect(incomeItems(seedState(), 'en')).toEqual([
      { id: 'seed-in-3', date: '2026-10-01', desc: 'Salary', accountId: 'us', amount: 5800, amountText: '5,800.00', cur: 'USD', main: '340,808.00', mainNote: NO_NOTE },
      { id: 'seed-in-2', date: '2026-09-01', desc: 'Salary', accountId: 'us', amount: 5800, amountText: '5,800.00', cur: 'USD', main: '339,731.22', mainNote: FROM_TRANSFERS },
      { id: 'seed-in-1', date: '2026-08-01', desc: 'Salary', accountId: 'us', amount: 5800, amountText: '5,800.00', cur: 'USD', main: '337,463.33', mainNote: FROM_TRANSFERS },
    ]);
  });

  it('no reordena el estado, y uno recién agregado queda debajo de los de su mismo día', () => {
    const s = seedState();
    s.incomes.push({ id: 'nuevo', date: '2026-10-01', desc: 'Gift', accountId: 'dr', amount: 500, cur: 'DOP' });
    const before = s.incomes.map((i) => i.id);
    expect(incomeItems(s, 'en').slice(0, 2).map((r) => r.id)).toEqual(['seed-in-3', 'nuevo']);
    expect(s.incomes.map((i) => i.id)).toEqual(before);
  });

  it('en la moneda principal no hay conversión; en otra, la tasa es la del mes de su fecha', () => {
    const s = withTRY();
    s.incomes = [
      { id: 'a', date: '2026-10-10', desc: '', accountId: 'dr', amount: 1234.5, cur: 'DOP' },
      { id: 'b', date: '2026-10-09', desc: 'Kira', accountId: 'dr', amount: 4000, cur: 'TRY' },
      { id: 'c', date: '2026-08-09', desc: '', accountId: 'dr', amount: 4200, cur: 'TRY' },
    ];
    const [a, b, c] = incomeItems(s, 'en');
    expect(a).toMatchObject({ amountText: '1,234.50', main: '1,234.50', mainNote: NO_NOTE });
    // 4,000 TRY / 40 × 58.76
    expect(b).toMatchObject({ desc: 'Kira', main: '5,876.00', mainNote: { hint: 'crossed through USD', fallback: false } });
    // Agosto no tiene tasa de TRY (ni ningún mes anterior): valores de respaldo.
    expect(c).toMatchObject({ main: '5,876.00', mainNote: DEFAULT_RATE_NOTE });
  });

  it('la nota sale en el idioma pedido; las cifras no cambian', () => {
    expect(incomeItems(seedState(), 'es')[2]).toMatchObject({ main: '337,463.33', mainNote: { hint: 'de los envíos de este mes', fallback: false } });
    expect(incomeItems(seedState(), 'tr')[2]).toMatchObject({ main: '337,463.33', mainNote: { hint: 'bu ayın transferlerinden', fallback: false } });
  });
});

describe('fila de agregar un ingreso', () => {
  const state = seedState();
  const draft = (over: Partial<IncomeDraft> = {}): IncomeDraft => ({ ...EMPTY_INCOME, ...over });

  it('borrador vacío: hoy, la cuenta por defecto y su moneda, sin monto', () => {
    expect(resolveIncomeDraft(EMPTY_INCOME, state, TODAY)).toEqual({ date: TODAY, desc: '', accountId: 'dr', amount: 0, cur: 'DOP' });
    expect(resolveIncomeDraft(EMPTY_INCOME, state, '2026-10-08').date).toBe('2026-10-08');
    expect(resolveIncomeDraft(draft({ date: '2026-09-30' }), state, '2026-10-08').date).toBe('2026-09-30');
  });

  it('la moneda sigue a la cuenta elegida hasta que el usuario elige una', () => {
    expect(resolveIncomeDraft(draft({ accountId: 'us' }), state, TODAY)).toMatchObject({ accountId: 'us', cur: 'USD' });
    expect(resolveIncomeDraft(draft({ accountId: 'us', cur: 'TRY' }), state, TODAY)).toMatchObject({ accountId: 'us', cur: 'TRY' });
    // Ya elegida, cambiar de cuenta no la mueve.
    expect(resolveIncomeDraft(draft({ accountId: 'dr', cur: 'TRY' }), state, TODAY)).toMatchObject({ accountId: 'dr', cur: 'TRY' });
  });

  it('la cuenta por defecto es la de shared/calc: la elegida en Settings o la primera en la moneda principal', () => {
    const s = seedState();
    s.defaultAccountId = 'us';
    expect(resolveIncomeDraft(EMPTY_INCOME, s, TODAY)).toMatchObject({ accountId: 'us', cur: 'USD' });
    s.defaultAccountId = null;
    expect(resolveIncomeDraft(EMPTY_INCOME, s, TODAY)).toMatchObject({ accountId: 'dr', cur: 'DOP' });
  });

  it('una cuenta que se ocultó o se eliminó se cambia por la de por defecto', () => {
    const s = seedState();
    s.accounts.find((a) => a.id === 'us')!.hidden = true;
    expect(resolveIncomeDraft(draft({ accountId: 'us' }), s, TODAY)).toMatchObject({ accountId: 'dr', cur: 'DOP' });
    expect(resolveIncomeDraft(draft({ accountId: 'borrada' }), s, TODAY)).toMatchObject({ accountId: 'dr', cur: 'DOP' });
  });

  it('sin cuentas no hay a dónde entrar: no se agrega', () => {
    const s = seedState();
    s.accounts = [];
    expect(resolveIncomeDraft(EMPTY_INCOME, s, TODAY)).toMatchObject({ accountId: '', cur: 'DOP' });
    expect(incomeDraftInput(draft({ amount: 100 }), s, TODAY)).toBeNull();
  });

  it('hace falta un monto mayor que 0 y una fecha válida; la descripción es opcional', () => {
    expect(incomeDraftInput(EMPTY_INCOME, state, TODAY)).toBeNull();
    expect(incomeDraftInput(draft({ amount: -5 }), state, TODAY)).toBeNull();
    expect(incomeDraftInput(draft({ amount: Number.NaN }), state, TODAY)).toBeNull();
    expect(incomeDraftInput(draft({ amount: Number.POSITIVE_INFINITY }), state, TODAY)).toBeNull();
    expect(incomeDraftInput(draft({ amount: 100, date: '2026-02-30' }), state, TODAY)).toBeNull();
    expect(incomeDraftInput(draft({ amount: 100, date: '' }), state, TODAY)).toBeNull();
    expect(incomeDraftInput(draft({ amount: 0.01 }), state, TODAY)).toEqual({ date: TODAY, desc: '', accountId: 'dr', amount: 0.01, cur: 'DOP' });
  });

  it('la descripción va sin espacios sobrantes y no puede pasar del largo que admite la API', () => {
    const d = draft({ date: '2026-09-15', desc: '  Salary ', accountId: 'us', amount: 5800 });
    expect(incomeDraftInput(d, state, TODAY)).toEqual({ date: '2026-09-15', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD' });
    expect(incomeDraftInput(draft({ amount: 1, desc: 'x'.repeat(200) }), state, TODAY)).not.toBeNull();
    expect(incomeDraftInput(draft({ amount: 1, desc: 'x'.repeat(201) }), state, TODAY)).toBeNull();
  });

  it('después de agregar se limpian la descripción y el monto; fecha, cuenta y moneda se quedan', () => {
    const d = draft({ date: '2026-09-15', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD' });
    expect(afterIncomeAdd(d)).toEqual({ date: '2026-09-15', desc: '', accountId: 'us', amount: 0, cur: 'USD' });
    expect(afterIncomeAdd(draft({ desc: 'x', amount: 10 }))).toEqual(EMPTY_INCOME);
  });

  it('el ingreso que sale del borrador es el que entra en la lista y en el mes', () => {
    const s = seedState();
    const input = incomeDraftInput(draft({ desc: 'Bonus', accountId: 'us', amount: 200 }), s, TODAY)!;
    const row: Income = { id: 'nuevo', ...input };
    s.incomes.push(row);
    expect(incomeItems(s, 'en')[0]).toEqual({
      id: 'nuevo',
      date: TODAY,
      desc: 'Bonus',
      accountId: 'us',
      amount: 200,
      amountText: '200.00',
      cur: 'USD',
      main: '11,752.00',
      mainNote: NO_NOTE,
    });
    expect(incomeRowViews(s, 'en')[2]!.income).toBe('352,560.00');
  });
});

describe('aportes', () => {
  it('datos de ejemplo: del más reciente al más antiguo', () => {
    const rows = contributionRows(seedState(), 'en');
    expect(rows.map((r) => `${r.date} ${r.goal}`)).toEqual([
      '2026-10-03 Trip to Turkey',
      '2026-10-03 Emergency fund',
      '2026-09-18 Personal savings',
      '2026-09-02 Trip to Turkey',
      '2026-09-02 Emergency fund',
      '2026-08-20 Personal savings',
      '2026-08-03 Trip to Turkey',
      '2026-08-03 Emergency fund',
    ]);
    expect(rows[0]).toEqual({
      id: 'seed-ct-7',
      date: '2026-10-03',
      goalId: 'turkey',
      goal: 'Trip to Turkey',
      amount: 3000,
      amountText: '3,000.00',
      cur: 'USD',
      inGoal: '3,000.00 USD',
      goalNote: NO_NOTE,
      main: '176,280.00', // 3,000 × 58.76
      mainNote: NO_NOTE,
    });
    // Cada aporte se convierte con la tasa de su mes: agosto 58.18333…, septiembre 58.57434… (de sus envíos).
    expect(rows[7]).toMatchObject({ amountText: '400.00', inGoal: '400.00 USD', goalNote: NO_NOTE, main: '23,273.33', mainNote: FROM_TRANSFERS });
    expect(rows[2]).toMatchObject({ amountText: '200.00', inGoal: '200.00 USD', main: '11,714.87', mainNote: FROM_TRANSFERS });
  });

  it('no reordena el estado', () => {
    const s = seedState();
    const before = s.contribs.map((c) => c.id);
    contributionRows(s, 'en');
    expect(s.contribs.map((c) => c.id)).toEqual(before);
  });

  it('un aporte recién agregado queda debajo de los que ya había ese mismo día', () => {
    const s = seedState();
    s.contribs.push({ id: 'nuevo', goalId: 'personal', date: '2026-10-03', amount: 50, cur: 'USD' });
    expect(contributionRows(s, 'en').slice(0, 3).map((r) => r.id)).toEqual(['seed-ct-7', 'seed-ct-8', 'nuevo']);
  });

  it('aporte en DOP a una meta en USD: en la meta sale en USD con la tasa del mes', () => {
    const s = seedState();
    s.contribs = [{ id: 'a', goalId: 'emergency', date: '2026-10-10', amount: 5876, cur: 'DOP' }];
    expect(contributionRows(s, 'en')).toEqual([
      {
        id: 'a',
        date: '2026-10-10',
        goalId: 'emergency',
        goal: 'Emergency fund',
        amount: 5876,
        amountText: '5,876.00',
        cur: 'DOP',
        inGoal: '100.00 USD',
        goalNote: NO_NOTE,
        main: '5,876.00',
        mainNote: NO_NOTE,
      },
    ]);
  });

  it('las tres monedas: cada columna con la tasa del mes del aporte y su nota', () => {
    const s = withTRY();
    Object.assign(s.goals.find((g) => g.id === 'personal')!, { cur: 'TRY' });
    s.contribs = [
      // USD a una meta en TRY, con la tasa escrita en octubre (1 USD = 40 TRY).
      { id: 'a', goalId: 'personal', date: '2026-10-10', amount: 100, cur: 'USD' },
      // TRY a una meta en USD: la inversa de la escrita; a DOP, cruzando por USD.
      { id: 'b', goalId: 'emergency', date: '2026-10-09', amount: 4000, cur: 'TRY' },
      // En agosto nadie había escrito una tasa de TRY: valores de respaldo (1 USD = 42 TRY).
      { id: 'c', goalId: 'personal', date: '2026-08-09', amount: 100, cur: 'USD' },
    ];
    const [a, b, c] = contributionRows(s, 'en');
    expect(a).toMatchObject({ inGoal: '4,000.00 TRY', goalNote: NO_NOTE, main: '5,876.00', mainNote: NO_NOTE });
    expect(b).toMatchObject({ inGoal: '100.00 USD', goalNote: NO_NOTE, main: '5,876.00', mainNote: { hint: 'crossed through USD', fallback: false } });
    expect(c).toMatchObject({ inGoal: '4,200.00 TRY', goalNote: DEFAULT_RATE_NOTE, main: '5,818.33', mainNote: FROM_TRANSFERS });
  });

  it('con fecha de un mes sin registro usa la tasa del mes registrado anterior, y lo dice', () => {
    const s = seedState();
    s.contribs = [{ id: 'a', goalId: 'emergency', date: '2027-01-15', amount: 100, cur: 'USD' }];
    expect(contributionRows(s, 'en')[0]).toMatchObject({ inGoal: '100.00 USD', main: '5,876.00', mainNote: { hint: 'from October 2026', fallback: false } });
    expect(contributionRows(s, 'es')[0]!.mainNote.hint).toBe('de octubre 2026');
  });

  it('una meta que ya no existe se muestra con una raya', () => {
    const s = seedState();
    s.contribs = [{ id: 'a', goalId: 'borrada', date: '2026-10-01', amount: 10, cur: 'USD' }];
    expect(contributionRows(s, 'en')[0]).toMatchObject({ goalId: 'borrada', goal: '—', inGoal: '—', goalNote: NO_NOTE, main: '587.60' });
    // En su selector la meta perdida sale como una raya, delante de las que sí existen.
    expect(goalOptionsFor(s.goals, 'borrada').map((o) => o.label)).toEqual(['—', 'Emergency fund', 'Personal savings', 'Trip to Turkey']);
    expect(goalOptionsFor(s.goals, 'turkey')).toEqual(goalOptions(s.goals));
  });

  it('el nombre de la meta sale como lo escribió el usuario, sin traducir', () => {
    const s = seedState();
    s.goals.find((g) => g.id === 'turkey')!.name = 'Viaje a Türkiye';
    expect(contributionRows(s, 'tr')[0]!.goal).toBe('Viaje a Türkiye');
    for (const lang of LANGS) expect(goalCards(s, lang)[2]!.name).toBe('Viaje a Türkiye');
  });
});

describe('fila de agregar un aporte', () => {
  // Las metas del usuario: las dos con las que arranca más la del viaje.
  const goals = seedState().goals;
  const draft = (over: Partial<ContributionDraft> = {}): ContributionDraft => ({ ...EMPTY_DRAFT, ...over });

  it('las metas del selector son las del usuario, en el orden de las tarjetas', () => {
    expect(goalOptions([...goals].reverse())).toEqual([
      { value: 'emergency', label: 'Emergency fund' },
      { value: 'personal', label: 'Personal savings' },
      { value: 'turkey', label: 'Trip to Turkey' },
    ]);
    // Una meta recién creada queda al final; una eliminada deja de salir.
    const mine = [...goals.filter((g) => g.id !== 'personal'), { id: 'car', name: 'Car', sort: 3 }];
    expect(goalOptions(mine).map((o) => o.label)).toEqual(['Emergency fund', 'Trip to Turkey', 'Car']);
    expect(goalOptions([])).toEqual([]);
  });

  it('borrador vacío: hoy, la primera meta y su moneda, sin monto', () => {
    expect(EMPTY_DRAFT.cur).toBeNull();
    expect(resolveDraft(EMPTY_DRAFT, goals, TODAY)).toEqual({ goalId: 'emergency', date: TODAY, amount: 0, cur: 'USD' });
  });

  it('la moneda sigue a la meta elegida hasta que el usuario elige una', () => {
    const mine = goals.map((g) => (g.id === 'turkey' ? { ...g, cur: 'TRY' as const } : g));
    expect(resolveDraft(draft({ goalId: 'turkey' }), mine, TODAY).cur).toBe('TRY');
    expect(resolveDraft(draft({ goalId: 'personal' }), mine, TODAY).cur).toBe('USD');
    expect(resolveDraft(draft({ goalId: 'turkey', cur: 'DOP' }), mine, TODAY).cur).toBe('DOP');
    expect(resolveDraft(draft({ goalId: 'personal', cur: 'TRY' }), mine, TODAY).cur).toBe('TRY');
    // Sin metas no hay moneda que seguir: la que se le pase (la principal del usuario).
    expect(resolveDraft(EMPTY_DRAFT, [], TODAY, 'DOP').cur).toBe('DOP');
  });

  it('la fecha sigue al calendario mientras el usuario no elija una', () => {
    expect(resolveDraft(EMPTY_DRAFT, goals, '2026-10-08').date).toBe('2026-10-08');
    expect(resolveDraft(draft({ date: '2026-09-30' }), goals, '2026-10-08').date).toBe('2026-09-30');
  });

  it('respeta la meta elegida; si ya no existe, vuelve a la primera', () => {
    expect(resolveDraft(draft({ goalId: 'turkey' }), goals, TODAY).goalId).toBe('turkey');
    expect(resolveDraft(draft({ goalId: 'borrada' }), goals, TODAY).goalId).toBe('emergency');
    expect(resolveDraft(draft({ goalId: 'turkey' }), [], TODAY).goalId).toBe('');
  });

  it('hace falta un monto mayor que 0', () => {
    expect(draftInput(EMPTY_DRAFT, goals, TODAY)).toBeNull();
    expect(draftInput(draft({ amount: -5 }), goals, TODAY)).toBeNull();
    expect(draftInput(draft({ amount: Number.NaN }), goals, TODAY)).toBeNull();
    expect(draftInput(draft({ amount: Number.POSITIVE_INFINITY }), goals, TODAY)).toBeNull();
    expect(draftInput(draft({ amount: 0.01 }), goals, TODAY)).toEqual({ goalId: 'emergency', date: TODAY, amount: 0.01, cur: 'USD' });
  });

  it('con todo lleno devuelve el aporte tal cual, en cualquiera de las tres monedas', () => {
    for (const cur of ['DOP', 'USD', 'TRY'] as const) {
      const d = draft({ date: '2026-09-15', goalId: 'personal', amount: 2500, cur });
      expect(draftInput(d, goals, TODAY)).toEqual({ goalId: 'personal', date: '2026-09-15', amount: 2500, cur });
    }
  });

  it('sin metas o con una fecha imposible no se agrega', () => {
    expect(draftInput(draft({ amount: 100 }), [], TODAY)).toBeNull();
    expect(draftInput(draft({ amount: 100, date: '2026-02-30' }), goals, TODAY)).toBeNull();
    expect(draftInput(draft({ amount: 100, date: '' }), goals, TODAY)).toBeNull();
  });

  it('después de agregar solo se limpia el monto', () => {
    const d = draft({ date: '2026-09-15', goalId: 'personal', amount: 2500, cur: 'DOP' });
    expect(afterAdd(d)).toEqual({ date: '2026-09-15', goalId: 'personal', amount: 0, cur: 'DOP' });
    expect(afterAdd(draft({ amount: 10 }))).toEqual(EMPTY_DRAFT);
  });

  it('el aporte que sale del borrador es el que entra en el historial', () => {
    const s = seedState();
    const input = draftInput(draft({ goalId: 'turkey', amount: 3000 }), s.goals, TODAY)!;
    const row: Contribution = { id: 'nuevo', ...input };
    s.contribs.push(row);
    expect(contributionRows(s, 'en')[0]).toMatchObject({
      id: 'nuevo',
      date: TODAY,
      goal: 'Trip to Turkey',
      amountText: '3,000.00',
      cur: 'USD',
      inGoal: '3,000.00 USD',
      main: '176,280.00',
    });
    expect(goalCards(s, 'en')[2]).toMatchObject({ saved: '12,000.00', plan: '12 contributions left · 2,750 USD per month to get there' });
  });
});
