// La prueba de verdad de que el libro funciona en una hoja de cálculo: LibreOffice lo abre, lo recalcula
// entero y lo vuelve a guardar, y aquí se comprueba que ninguna celda da error y que los valores calculados son
// los de shared/calc.ts. Cubre dos cosas a la vez:
//   · los nombres traducidos (hojas, tablas, columnas) y las fórmulas, en los tres idiomas;
//   · el puente desde el estado de la app (data.ts buildExportData): lo que la app calcula con su modelo de
//     cuentas es lo que el libro vuelve a calcular con lo que recibe, también cuando hay cuentas y montos en
//     TRY, que el libro no conoce y le llegan ya convertidos.
//
// Necesita LibreOffice (soffice); si no está instalado, estas pruebas se saltan. La conversión es por línea
// de comandos (--headless --convert-to): no abre ventanas ni puertos, y usa un perfil temporal propio.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balances, contribIn, convert, currentKey, goalProgress, incomeInMonth, incomeRows, monthCalc, rateFor, savedInMonth, sortedKeys } from '../calc';
import { CATS } from '../constants';
import { catLabel } from '../i18n';
import { label, monthOf, monthSpan } from '../month';
import { seedState } from '../seed';
import type { AppState, Goal, Language } from '../types';
import { mixedState } from './bridge-testkit';
import { buildExportData } from './data';
import { EXCEL_LOCALES, buildFinanzasXlsx } from './export';
import type { ExcelLocale } from './export';
import { GOAL_SLOTS, placeGoals } from './export-goals';
import type { GoalLayout } from './export-goals';
import { readBook } from './export-testkit';
import type { TestBook, TestSheet } from './export-testkit';
import type { ExportData } from './types';

function findSoffice(): string | null {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  const candidates = [
    process.env.SOFFICE,
    ...dirs.flatMap((dir) => [join(dir, 'soffice'), join(dir, 'libreoffice')]),
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

const SOFFICE = findSoffice();
const LANGS: Language[] = ['en', 'tr', 'es'];

const usdGoal = (id: string, name: string, sort: number, plan: Pick<Goal, 'monthly' | 'start' | 'end'> = { monthly: null, start: null, end: null }): Goal => ({
  id,
  name,
  cur: 'USD',
  ...plan,
  sort,
});

/**
 * Datos de ejemplo más siete metas, para que haya varias bandas de tarjetas: una con plan cuyo nombre lleva
 * comillas y &, y tres parejas sin plan cuyos nombres solo se distinguen si "?", "*" y "=" se toman al pie
 * de la letra en los criterios de SUMIFS (y no como comodines o como una comparación).
 */
function sampleState(): AppState {
  const state = seedState();
  state.goals.push(
    usdGoal('car', 'New "car" & co', 3, { monthly: 500, start: '2026-09', end: '2027-02' }),
    usdGoal('gifts', 'Gifts?', 4),
    usdGoal('giftsx', 'Giftsx', 5),
    usdGoal('hotel', '5* hotel ~ maybe', 6),
    usdGoal('hotelx', '5 stars hotel ~ maybe', 7),
    usdGoal('ten', '=10', 8),
    usdGoal('tenx', '10', 9),
  );
  state.contribs.push(
    { id: 'c-car-1', goalId: 'car', date: '2026-09-10', amount: 29300, cur: 'DOP' },
    { id: 'c-car-2', goalId: 'car', date: '2026-10-05', amount: 500, cur: 'USD' },
    { id: 'c-gifts', goalId: 'gifts', date: '2026-10-06', amount: 5876, cur: 'DOP' },
    { id: 'c-giftsx', goalId: 'giftsx', date: '2026-10-06', amount: 77, cur: 'USD' },
    { id: 'c-hotel', goalId: 'hotel', date: '2026-10-07', amount: 11, cur: 'USD' },
    { id: 'c-hotelx', goalId: 'hotelx', date: '2026-10-07', amount: 22, cur: 'USD' },
    { id: 'c-ten', goalId: 'ten', date: '2026-10-07', amount: 33, cur: 'USD' },
    { id: 'c-tenx', goalId: 'tenx', date: '2026-10-07', amount: 44, cur: 'USD' },
  );
  // Un gasto en USD y una categoría fuera de la lista.
  state.months['2026-10']!.tx.push({
    id: 'tx-usd',
    monthKey: '2026-10',
    date: '2026-10-08',
    desc: 'Domain',
    place: 'Namecheap',
    cat: 'Pets',
    method: 'Card',
    amount: 12.5,
    cur: 'USD',
    accountId: 'us',
    notes: '',
    source: 'web',
    createdAt: null,
  });
  return state;
}

const ERROR_RE = /^(#[A-Z0-9/]+[!?]?|Err:\d+)$/;

interface ErrorCell {
  sheet: string;
  ref: string;
  value: string;
  formula: string | null;
}

function errorsOf(book: TestBook): ErrorCell[] {
  const out: ErrorCell[] = [];
  for (const sh of book.sheets) {
    for (const c of sh.cells.values()) {
      if (c.type === 'e' || (typeof c.value === 'string' && c.formula !== null && ERROR_RE.test(c.value))) {
        out.push({ sheet: sh.name, ref: c.ref, value: String(c.value), formula: c.formula });
      }
    }
  }
  return out;
}

/** Un estado de la app y el libro que sale de él. */
interface Case {
  id: string;
  /** El estado tal como lo tiene el usuario (con su moneda principal). */
  state: AppState;
  /**
   * El mismo estado visto como lo ve el libro: todo en DOP y el "≈" en USD. Con él, las cifras de
   * shared/calc.ts se comparan directamente con las celdas.
   */
  view: AppState;
  data: ExportData;
  layout: GoalLayout;
}

function makeCase(id: string, state: AppState): Case {
  const data = buildExportData(state);
  return { id, state, view: { ...state, mainCurrency: 'DOP', secondCurrency: 'USD' }, data, layout: placeGoals(data.goals) };
}

const SAMPLE = makeCase('sample', sampleState());
const MIXED = makeCase('mixed', mixedState());

/** Lo que cada prueba necesita para mirar el libro de un caso en un idioma. */
interface Opened {
  lang: Language;
  L: ExcelLocale;
  book(): TestBook;
  monthSheet(key: string): TestSheet;
  savings(): TestSheet;
  /** Valor numérico de una celda (la prueba falla si no lo es). */
  num(sheet: TestSheet, ref: string): number;
  /** Fila del encabezado de las dos tablas de la hoja de ahorros: empiezan debajo de la última banda. */
  head: number;
}

describe.skipIf(!SOFFICE)('el libro recalculado por LibreOffice', () => {
  const books = new Map<string, TestBook>();
  const files = [SAMPLE, MIXED].flatMap((c) => LANGS.map((lang) => ({ name: `${c.id}-${lang}`, data: c.data, lang })));
  let dir = '';

  // Una sola pasada de LibreOffice para todos los libros: arrancarlo es lo que tarda.
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fe-finance-xlsx-'));
    const inDir = join(dir, 'in');
    const outDir = join(dir, 'out');
    mkdirSync(inDir);
    mkdirSync(outDir);
    for (const f of files) writeFileSync(join(inDir, `${f.name}.xlsx`), buildFinanzasXlsx(f.data, { locale: EXCEL_LOCALES[f.lang] }));
    execFileSync(
      SOFFICE!,
      [
        '--headless',
        '--norestore',
        '--nolockcheck',
        // Perfil propio: no toca el del usuario ni choca con un LibreOffice abierto o con otra prueba en marcha.
        `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`,
        '--convert-to',
        'xlsx',
        '--outdir',
        outDir,
        ...files.map((f) => join(inDir, `${f.name}.xlsx`)),
      ],
      { stdio: 'pipe', timeout: 240_000 },
    );
    for (const f of files) books.set(f.name, readBook(new Uint8Array(readFileSync(join(outDir, `${f.name}.xlsx`)))));
  }, 270_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Registra, para cada idioma, las comprobaciones comunes a cualquier libro y las propias del caso (`extra`). */
  function check({ id, state, view, layout }: Case, extra: (o: Opened) => void): void {
    describe.each(LANGS)('%s', (lang) => {
      const L = EXCEL_LOCALES[lang];
      const keys = sortedKeys(state);
      const now = currentKey(state)!;
      const book = () => books.get(`${id}-${lang}`)!;
      const monthSheet = (key: string) => book().sheet(label(key, lang));
      const savings = () => book().sheet(L.sheets.savings);
      const num = (sheet: TestSheet, ref: string) => {
        const v = sheet.cells.get(ref)?.value;
        expect(typeof v, `${sheet.name}!${ref} = ${String(v)}`).toBe('number');
        return v as number;
      };
      const head = 15 + 8 * (layout.bands - 1);

      it('conserva hojas y tablas, y recalcula todas las fórmulas', () => {
        expect(book().sheets.map((s) => s.name)).toEqual([...keys.map((k) => label(k, lang)), L.sheets.savings, 'Config']);
        expect(book().tables.map((t) => t.name).sort()).toEqual(
          [...keys.flatMap((k) => [L.tables.fixed, L.tables.transfers, L.tables.tx].map((t) => `${t}_${k.replace('-', '_')}`)), L.tables.contribs].sort(),
        );
        let formulas = 0;
        for (const sh of book().sheets) {
          for (const c of sh.cells.values()) {
            if (c.formula === null) continue;
            formulas++;
            expect(c.value, `${sh.name}!${c.ref} sin valor: ${c.formula}`).not.toBeNull();
          }
        }
        expect(formulas).toBeGreaterThan(500);
      });

      it('ninguna celda da error', () => {
        const errors = errorsOf(book());
        // Ni nombres que no existan (#NAME?: una tabla, una columna o una función mal escrita) ni tipos equivocados.
        expect(errors.filter((e) => e.value !== '#REF!')).toEqual([]);
        // LibreOffice no deja que IFERROR atrape el INDIRECT a una hoja que no existe (Excel sí, y devuelve ""):
        // en "Ingresos por mes", las filas de los meses que aún no tienen hoja dan #REF!. Pasa igual con el libro
        // del diseño original; fuera de esas celdas no puede haber ninguno.
        const future = new Set<string>();
        for (let r = head + 1 + keys.length; r <= head + 15; r++) for (const col of 'CDEFG') future.add(`${col}${r}`);
        expect(errors.filter((e) => !(e.sheet === L.sheets.savings && future.has(e.ref)))).toEqual([]);
      });

      it.each(keys)('hoja de %s: tasa, saldos, presupuesto y totales como en shared/calc.ts', (key) => {
        const c = monthCalc(view, key);
        const b = balances(view, key);
        const sh = monthSheet(key);
        // La tasa que el libro saca de sus envíos es la del mes en la app.
        expect(num(sh, 'T3')).toBeCloseTo(rateFor(state, key, 'USD', 'DOP').rate, 8);
        expect(num(sh, 'T4')).toBeCloseTo(c.fixedPaid, 6);
        expect(num(sh, 'T5')).toBeCloseTo(c.varSpent, 6);
        expect(num(sh, 'T6')).toBeCloseTo(c.pending, 6);
        expect(num(sh, 'T7')).toBeCloseTo(c.free, 6);
        // Presupuesto y usado del mes.
        expect(num(sh, 'O6')).toBeCloseTo(c.budget, 6);
        expect(num(sh, 'T8')).toBeCloseTo(c.used, 6);
        expect(num(sh, 'O8')).toBeCloseTo(c.used, 6);
        expect(num(sh, 'O9')).toBeCloseTo(c.avail, 6);
        expect(num(sh, 'O10')).toBeCloseTo(c.after, 6);
        expect(num(sh, 'O11')).toBeCloseTo(c.usedSecond, 6);
        // Dinero total: el de la app (la suma de sus cuentas visibles), en DOP y en USD.
        expect(num(sh, 'B5')).toBeCloseTo(b.totalMain, 6);
        expect(num(sh, 'B5')).toBeCloseTo(convert(state, key, balances(state, key).totalMain, state.mainCurrency, 'DOP'), 6);
        expect(num(sh, 'B6')).toBeCloseTo(b.totalSecond, 6);
        // Ingreso del mes, y lo que queda de él.
        expect(num(sh, 'C10')).toBeCloseTo(incomeInMonth(state, key, 'USD'), 6);
        expect(num(sh, 'C11')).toBeCloseTo(c.incomeLeft, 6);
        // "6 of 11 paid · total 42,025.57 DOP": los contadores salen de la columna Pagado (Sí/Yes/Evet).
        const [before, mid, total] = L.month.fixedMeta;
        expect(String(sh.cells.get('H14')?.value)).toContain(`${before}${c.paidCount}${mid}${c.fixedCount}${total}`);
        // Por categoría: la lista traducida casa con la categoría traducida de cada fila del historial.
        expect(num(sh, 'Q15')).toBeCloseTo(c.fixedPaid, 6);
        CATS.forEach((cat, i) => {
          expect(sh.cells.get(`M${16 + i}`)?.value).toBe(catLabel(cat, lang));
          expect(num(sh, `Q${16 + i}`), cat).toBeCloseTo(c.categories.find((x) => x.name === cat)?.value ?? 0, 6);
        });
      });

      it('ahorros: el resumen lee la hoja del mes actual por su nombre', () => {
        const c = monthCalc(view, now);
        const sh = savings();
        expect(sh.cells.get('B4')?.value).toBe(label(now, lang));
        expect(num(sh, 'C4')).toBeCloseTo(balances(view, now).totalMain, 6);
        expect(num(sh, 'F4')).toBeCloseTo(c.budget, 6);
        expect(num(sh, 'I4')).toBeCloseTo(c.used, 6);
        expect(num(sh, 'K4')).toBeCloseTo(c.avail, 6);
        expect(num(sh, 'N4')).toBeCloseTo(c.rate.rate, 8);
        expect(num(sh, 'R3')).toBeCloseTo(c.rate.rate, 8);
      });

      it('ahorros: lo aportado a cada meta, en su tarjeta', () => {
        const sh = savings();
        for (const placed of layout.goals) {
          const goal = state.goals.find((g) => g.name === placed.name)!;
          const mine = state.contribs.filter((x) => x.goalId === goal.id);
          // El libro lleva todas las metas en USD: lo aportado, con la tasa del mes de cada aporte.
          const savedUSD = mine.reduce((a, x) => a + contribIn(view, x, 'USD'), 0);
          const o = 8 * placed.band;
          const c1 = GOAL_SLOTS[placed.slot]![0];
          expect(sh.cells.get(`${c1}${6 + o}`)?.value).toBe(goal.name);
          // Total aportado a la meta, en USD y, a la tasa del mes en curso, en DOP.
          expect(num(sh, `${c1}${8 + o}`), goal.name).toBeCloseTo(savedUSD, 6);
          expect(num(sh, placed.plan ? `L${8 + o}` : `${c1}${9 + o}`), goal.name).toBeCloseTo(convert(view, now, savedUSD, 'USD', 'DOP'), 5);
          const p = goalProgress(view, goal);
          if (goal.cur === 'USD') {
            // Una meta en USD es la misma en la app y en el libro.
            expect(p.saved, goal.name).toBeCloseTo(savedUSD, 6);
            expect(num(sh, placed.plan ? `L${8 + o}` : `${c1}${9 + o}`), goal.name).toBeCloseTo(p.savedMain, 5);
          }
          if (!placed.plan) {
            expect(String(sh.cells.get(`${c1}${11 + o}`)?.value)).toBe(`${L.savings.contribCount[0]}${p.contribCount}${L.savings.contribCount[1]}`);
            continue;
          }
          const t = p.target!;
          // El objetivo de una meta en otra moneda llega en USD, a la tasa del mes en curso.
          const targetUSD = convert(view, now, t.targetAmount, goal.cur, 'USD');
          expect(placed.plan.monthlyUSD * monthSpan(placed.plan.start, placed.plan.end), goal.name).toBeCloseTo(targetUSD, 6);
          expect(num(sh, `R${4 + o}`), goal.name).toBeCloseTo(targetUSD, 6);
          expect(num(sh, `R${5 + o}`), goal.name).toBeCloseTo(savedUSD, 6);
          expect(num(sh, `R${8 + o}`), goal.name).toBeCloseTo(savedUSD / targetUSD, 8);
          expect(num(sh, `I${10 + o}`), goal.name).toBeCloseTo(savedUSD / targetUSD, 8);
          if (goal.cur === 'USD') expect(num(sh, `R${8 + o}`), goal.name).toBeCloseTo(t.pct / 100, 8);
          // "Target: October 2027": el mes sale de la lista CHOOSE, con la mayúscula o minúscula de cada idioma.
          const month = L.months[+t.end.slice(5) - 1]!;
          const shown = L.savings.monthCase === 'LOWER' ? month.toLocaleLowerCase(lang) : month;
          expect(sh.cells.get(`L${11 + o}`)?.value).toBe(`${L.savings.target[0]}${shown}${L.savings.target[1]}${t.end.slice(0, 4)}`);
        }
      });

      it('ahorros: ingresos por mes y aportes', () => {
        const sh = savings();
        incomeRows(view).forEach((row, i) => {
          const r = head + 1 + i;
          expect(sh.cells.get(`B${r}`)?.value).toBe(label(row.key, lang));
          expect(num(sh, `C${r}`)).toBeCloseTo(incomeInMonth(view, row.key, 'USD'), 6);
          expect(num(sh, `D${r}`)).toBeCloseTo(row.rate.rate, 8);
          expect(num(sh, `E${r}`)).toBeCloseTo(row.income, 6);
          // Ahorrado en el mes: SUMIFS por la columna Mes de los aportes, que es texto ("October 2026").
          expect(num(sh, `F${r}`)).toBeCloseTo(savedInMonth(view, row.key, 'USD'), 6);
          expect(num(sh, `G${r}`)).toBeCloseTo(row.pct! / 100, 8);
        });
        const sorted = [...state.contribs].sort((a, b) => a.date.localeCompare(b.date));
        sorted.forEach((c, i) => {
          const r = head + 1 + i;
          expect(sh.cells.get(`J${r}`)?.value).toBe(label(monthOf(c.date), lang));
          expect(sh.cells.get(`K${r}`)?.value).toBe(state.goals.find((g) => g.id === c.goalId)!.name);
          expect(num(sh, `N${r}`)).toBeCloseTo(contribIn(view, c, 'USD'), 6);
          expect(num(sh, `O${r}`)).toBeCloseTo(contribIn(view, c, 'DOP'), 5);
        });
        // Las filas en blanco de la tabla quedan en blanco, no en cero ni en error.
        expect(sh.cells.get(`N${head + 1 + sorted.length}`)?.value).toBe('');
        expect(String(sh.cells.get(`L${head - 1}`)?.value).startsWith(L.savings.total[0])).toBe(true);
      });

      extra({ lang, L, book, monthSheet, savings, num, head });
    });
  }

  describe('datos de ejemplo, con siete metas más', () => {
    const { state } = SAMPLE;

    check(SAMPLE, ({ monthSheet, savings, num }) => {
      it('el gasto en USD se convierte con la tasa del mes', () => {
        const sh = monthSheet('2026-10');
        const row = [...sh.cells.values()].find((c) => c.value === 'Namecheap')!.ref.slice(1);
        expect(sh.cells.get(`H${row}`)?.value).toBe('USD');
        expect(num(sh, `I${row}`)).toBeCloseTo(12.5 * monthCalc(state, '2026-10').rate.rate, 6);
        expect(num(sh, `J${row}`)).toBeCloseTo(12.5, 6);
      });

      it('los saldos de las dos cuentas son los que calcula la app', () => {
        const sh = monthSheet('2026-10');
        const b = balances(state, '2026-10');
        expect(num(sh, 'C8')).toBeCloseTo(b.accounts.find((a) => a.account.id === 'us')!.balance, 6);
        expect(num(sh, 'C9')).toBeCloseTo(b.accounts.find((a) => a.account.id === 'dr')!.balance, 6);
        expect(num(sh, 'C8')).toBeCloseTo(13482 - 12.5, 6);
      });

      it('cada meta cuenta solo lo suyo, aunque su nombre lleve comodines o empiece por un operador', () => {
        const sh = savings();
        expect(SAMPLE.layout.bands).toBe(4);
        // "Gifts?" no suma lo de "Giftsx", ni "5* hotel…" lo de "5 stars hotel…", ni "=10" lo de "10"
        // (bandas 1, 2 y 3; huecos B y E).
        expect(goalProgress(state, state.goals.find((g) => g.id === 'gifts')!).saved).toBeCloseTo(100, 6);
        expect(['B16', 'E16', 'B24', 'E24', 'B32', 'E32'].map((ref) => num(sh, ref))).toEqual([100, 77, 11, 22, 33, 44].map((n) => expect.closeTo(n, 6)));
        expect(['B14', 'E14', 'B22', 'E22', 'B30', 'E30'].map((ref) => sh.cells.get(ref)?.value)).toEqual([
          'Gifts?',
          'Giftsx',
          '5* hotel ~ maybe',
          '5 stars hotel ~ maybe',
          '=10',
          '10',
        ]);
      });
    });
  });

  describe('con TRY, más cuentas y cuentas ocultas: lo que el libro recibe ya convertido', () => {
    const { state, data } = MIXED;

    check(MIXED, ({ monthSheet, savings, num }) => {
      it('premisa: el usuario ve su dinero en TRY y tiene más cuentas de las que caben en el libro', () => {
        expect(state.mainCurrency).toBe('TRY');
        expect(state.accounts.filter((a) => !a.hidden)).toHaveLength(5);
        expect(MIXED.layout.bands).toBe(2);
      });

      it('las dos celdas de saldo suman las cuentas visibles: las de DOP y, en USD, las demás', () => {
        const sh = monthSheet('2026-10');
        const bal = (id: string) => balances(state, '2026-10').accounts.find((a) => a.account.id === id)!.balance;
        expect(num(sh, 'C8')).toBeCloseTo(bal('us') + bal('pp') + convert(state, '2026-10', bal('tr'), 'TRY', 'USD'), 6);
        expect(num(sh, 'C9')).toBeCloseTo(bal('dr') + bal('cash'), 6);
      });

      it('lo que estaba en TRY llega en DOP, y la transacción anota el monto original', () => {
        const sh = monthSheet('2026-10');
        const rowOf = (text: string) => [...sh.cells.values()].find((c) => c.value === text)!.ref.slice(1);
        const seat = rowOf('Seat selection');
        expect(sh.cells.get(`H${seat}`)?.value).toBe('DOP');
        expect(num(sh, `G${seat}`)).toBeCloseTo(convert(state, '2026-10', 2400.5, 'TRY', 'DOP'), 6);
        expect(num(sh, `I${seat}`)).toBeCloseTo(convert(state, '2026-10', 2400.5, 'TRY', 'DOP'), 6);
        expect(sh.cells.get(`K${seat}`)?.value).toBe('Turkish Airlines · TRY 2,400.50');
        const turkcell = rowOf('Turkcell');
        expect(sh.cells.get(`F${turkcell}`)?.value).toBe('DOP');
        expect(num(sh, `G${turkcell}`)).toBeCloseTo(convert(state, '2026-10', 350, 'TRY', 'DOP'), 6);
      });

      it('el envío de vuelta (DOP → USD) entra en la tasa del mes como los USD que llegaron', () => {
        const sh = monthSheet('2026-10');
        const sent = data.months[2]!.transfers;
        expect(sent).toHaveLength(3);
        const usd = sent.reduce((a, t) => a + t.usd!, 0);
        expect(num(sh, 'T3')).toBeCloseTo(sent.reduce((a, t) => a + t.usd! * t.rate!, 0) / usd, 8);
        expect(num(sh, 'T3')).toBeCloseTo((1500 * 58.76 + 11700 + 50 * 58.9) / (1500 + 200 + 50), 8);
      });

      it('la meta en TRY tiene su tarjeta con plan, en USD', () => {
        const sh = savings();
        // Banda 1, hueco ancho: 10,000 TRY al mes durante 12 meses, a la tasa de octubre.
        expect(sh.cells.get('I14')?.value).toBe('Istanbul flat');
        const monthly = convert(state, '2026-10', 10000, 'TRY', 'USD');
        expect(num(sh, 'J20')).toBeCloseTo(monthly, 6);
        expect(num(sh, 'R12')).toBeCloseTo(12 * monthly, 6);
        expect(sh.cells.get('B14')?.value).toBe('Gifts');
        expect(num(sh, 'B16')).toBeCloseTo(convert(state, '2026-10', 1500, 'DOP', 'USD'), 6);
      });
    });
  });
});
