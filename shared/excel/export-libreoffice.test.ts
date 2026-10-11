// The real proof that the workbook works in a spreadsheet: LibreOffice opens it, recalculates all of it
// and saves it again, and here we check that no cell gives an error and that the calculated values are
// those of shared/calc.ts. It covers two things at once:
//   · the translated names (sheets, tables, columns) and the formulas, in the three languages;
//   · the bridge from the app's state (data.ts buildExportData): what the app calculates with its account
//     model is what the workbook calculates again from what it receives, also when there are accounts and
//     amounts in TRY, which the workbook does not know about and which reach it already converted.
//
// It needs LibreOffice (soffice); if it is not installed, these tests are skipped. The conversion runs from the
// command line (--headless --convert-to): it opens no windows or ports, and uses its own temporary profile.

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
  approxCur: null,
  ...plan,
  sort,
});

/**
 * Sample data plus seven goals, so there are several bands of cards: one with a plan whose name has
 * quotes and &, and three pairs without a plan whose names can only be told apart if "?", "*" and "=" are
 * taken literally in the SUMIFS criteria (and not as wildcards or as a comparison).
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
  // An expense in USD and a category outside the list.
  state.months['2026-10']!.tx.push({
    id: 'tx-usd',
    monthKey: '2026-10',
    date: '2026-10-08',
    desc: 'Domain',
    place: 'Namecheap',
    cat: 'Pets',
    method: 'Debit card',
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

/** An app state and the workbook that comes out of it. */
interface Case {
  id: string;
  /** The state as the user has it (with their main currency). */
  state: AppState;
  /**
   * The same state as the workbook sees it: everything in DOP and the "≈" in USD. With it, the figures of
   * shared/calc.ts are compared directly with the cells.
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

/** What each test needs to look at one case's workbook in one language. */
interface Opened {
  lang: Language;
  L: ExcelLocale;
  book(): TestBook;
  monthSheet(key: string): TestSheet;
  savings(): TestSheet;
  /** Numeric value of a cell (the test fails if it is not one). */
  num(sheet: TestSheet, ref: string): number;
  /** Header row of the two tables of the savings sheet: they start below the last band. */
  head: number;
}

describe.skipIf(!SOFFICE)('the workbook recalculated by LibreOffice', () => {
  const books = new Map<string, TestBook>();
  const files = [SAMPLE, MIXED].flatMap((c) => LANGS.map((lang) => ({ name: `${c.id}-${lang}`, data: c.data, lang })));
  let dir = '';

  // A single LibreOffice run for all the workbooks: starting it up is what takes time.
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
        // Its own profile: it does not touch the user's or clash with an open LibreOffice or another running test.
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

  /** Registers, for each language, the checks common to any workbook and those specific to the case (`extra`). */
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

      it('keeps sheets and tables, and recalculates every formula', () => {
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

      it('no cell gives an error', () => {
        const errors = errorsOf(book());
        // No names that do not exist (#NAME?: a misspelled table, column or function) and no wrong types.
        expect(errors.filter((e) => e.value !== '#REF!')).toEqual([]);
        // LibreOffice does not let IFERROR catch the INDIRECT to a sheet that does not exist (Excel does, and
        // returns ""): in "Income by month", the rows of the months that have no sheet yet give #REF!. The same
        // happens with the workbook of the original design; outside those cells there can be none.
        const future = new Set<string>();
        for (let r = head + 1 + keys.length; r <= head + 15; r++) for (const col of 'CDEFG') future.add(`${col}${r}`);
        expect(errors.filter((e) => !(e.sheet === L.sheets.savings && future.has(e.ref)))).toEqual([]);
      });

      it.each(keys)('%s sheet: rate, balances, budget and totals as in shared/calc.ts', (key) => {
        const c = monthCalc(view, key);
        const b = balances(view, key);
        const sh = monthSheet(key);
        // The rate the workbook derives from its transfers is the month rate in the app.
        expect(num(sh, 'T3')).toBeCloseTo(rateFor(state, key, 'USD', 'DOP').rate, 8);
        expect(num(sh, 'T4')).toBeCloseTo(c.fixedPaid, 6);
        expect(num(sh, 'T5')).toBeCloseTo(c.varSpent, 6);
        expect(num(sh, 'T6')).toBeCloseTo(c.pending, 6);
        expect(num(sh, 'T7')).toBeCloseTo(c.free, 6);
        // Budget and used for the month.
        expect(num(sh, 'O6')).toBeCloseTo(c.budget, 6);
        expect(num(sh, 'T8')).toBeCloseTo(c.used, 6);
        expect(num(sh, 'O8')).toBeCloseTo(c.used, 6);
        expect(num(sh, 'O9')).toBeCloseTo(c.avail, 6);
        expect(num(sh, 'O10')).toBeCloseTo(c.after, 6);
        expect(num(sh, 'O11')).toBeCloseTo(c.usedSecond!, 6);
        // Total money: the app's (the sum of its visible accounts), in DOP and in USD.
        expect(num(sh, 'B5')).toBeCloseTo(b.totalMain, 6);
        expect(num(sh, 'B5')).toBeCloseTo(convert(state, key, balances(state, key).totalMain, state.mainCurrency, 'DOP'), 6);
        expect(num(sh, 'B6')).toBeCloseTo(b.totalSecond!, 6);
        // The month's income, and what is left of it.
        expect(num(sh, 'C10')).toBeCloseTo(incomeInMonth(state, key, 'USD'), 6);
        expect(num(sh, 'C11')).toBeCloseTo(c.incomeLeft, 6);
        // "6 of 11 paid · total 42,025.57 DOP": the counters come from the Paid column (Sí/Yes/Evet).
        const [before, mid, total] = L.month.fixedMeta;
        expect(String(sh.cells.get('H14')?.value)).toContain(`${before}${c.paidCount}${mid}${c.fixedCount}${total}`);
        // By category: the translated list matches the translated category of each history row.
        expect(num(sh, 'Q15')).toBeCloseTo(c.fixedPaid, 6);
        // The workbook lists the ten categories of the original design (L.cats); "Other", the eleventh, has no row.
        expect(L.cats).toHaveLength(10);
        CATS.slice(0, L.cats.length).forEach((cat, i) => {
          expect(L.cats[i]).toBe(catLabel(cat, lang));
          expect(sh.cells.get(`M${16 + i}`)?.value).toBe(catLabel(cat, lang));
          expect(num(sh, `Q${16 + i}`), cat).toBeCloseTo(c.categories.find((x) => x.name === cat)?.value ?? 0, 6);
        });
      });

      it('savings: the summary reads the sheet of the current month by its name', () => {
        const c = monthCalc(view, now);
        const sh = savings();
        expect(sh.cells.get('B4')?.value).toBe(label(now, lang));
        expect(num(sh, 'C4')).toBeCloseTo(balances(view, now).totalMain, 6);
        expect(num(sh, 'F4')).toBeCloseTo(c.budget, 6);
        expect(num(sh, 'I4')).toBeCloseTo(c.used, 6);
        expect(num(sh, 'K4')).toBeCloseTo(c.avail, 6);
        expect(num(sh, 'N4')).toBeCloseTo(c.rate!.rate, 8);
        expect(num(sh, 'R3')).toBeCloseTo(c.rate!.rate, 8);
      });

      it('savings: what was contributed to each goal, on its card', () => {
        const sh = savings();
        for (const placed of layout.goals) {
          const goal = state.goals.find((g) => g.name === placed.name)!;
          const mine = state.contribs.filter((x) => x.goalId === goal.id);
          // The workbook keeps every goal in USD: what was contributed, at the month rate of each contribution.
          const savedUSD = mine.reduce((a, x) => a + contribIn(view, x, 'USD'), 0);
          const o = 8 * placed.band;
          const c1 = GOAL_SLOTS[placed.slot]![0];
          expect(sh.cells.get(`${c1}${6 + o}`)?.value).toBe(goal.name);
          // Total contributed to the goal, in USD and, at the current month's rate, in DOP.
          expect(num(sh, `${c1}${8 + o}`), goal.name).toBeCloseTo(savedUSD, 6);
          expect(num(sh, placed.plan ? `L${8 + o}` : `${c1}${9 + o}`), goal.name).toBeCloseTo(convert(view, now, savedUSD, 'USD', 'DOP'), 5);
          const p = goalProgress(view, goal);
          if (goal.cur === 'USD') {
            // A goal in USD is the same in the app and in the workbook.
            expect(p.saved, goal.name).toBeCloseTo(savedUSD, 6);
            expect(num(sh, placed.plan ? `L${8 + o}` : `${c1}${9 + o}`), goal.name).toBeCloseTo(p.savedMain, 5);
          }
          if (!placed.plan) {
            expect(String(sh.cells.get(`${c1}${11 + o}`)?.value)).toBe(`${L.savings.contribCount[0]}${p.contribCount}${L.savings.contribCount[1]}`);
            continue;
          }
          const t = p.target!;
          // The target of a goal in another currency arrives in USD, at the current month's rate.
          const targetUSD = convert(view, now, t.targetAmount, goal.cur, 'USD');
          expect(placed.plan.monthlyUSD * monthSpan(placed.plan.start, placed.plan.end), goal.name).toBeCloseTo(targetUSD, 6);
          expect(num(sh, `R${4 + o}`), goal.name).toBeCloseTo(targetUSD, 6);
          expect(num(sh, `R${5 + o}`), goal.name).toBeCloseTo(savedUSD, 6);
          expect(num(sh, `R${8 + o}`), goal.name).toBeCloseTo(savedUSD / targetUSD, 8);
          expect(num(sh, `I${10 + o}`), goal.name).toBeCloseTo(savedUSD / targetUSD, 8);
          if (goal.cur === 'USD') expect(num(sh, `R${8 + o}`), goal.name).toBeCloseTo(t.pct / 100, 8);
          // "Target: October 2027": the month comes from the CHOOSE list, in each language's upper or lower case.
          const month = L.months[+t.end.slice(5) - 1]!;
          const shown = L.savings.monthCase === 'LOWER' ? month.toLocaleLowerCase(lang) : month;
          expect(sh.cells.get(`L${11 + o}`)?.value).toBe(`${L.savings.target[0]}${shown}${L.savings.target[1]}${t.end.slice(0, 4)}`);
        }
      });

      it('savings: income by month and contributions', () => {
        const sh = savings();
        incomeRows(view).forEach((row, i) => {
          const r = head + 1 + i;
          expect(sh.cells.get(`B${r}`)?.value).toBe(label(row.key, lang));
          expect(num(sh, `C${r}`)).toBeCloseTo(incomeInMonth(view, row.key, 'USD'), 6);
          expect(num(sh, `D${r}`)).toBeCloseTo(row.rate!.rate, 8);
          expect(num(sh, `E${r}`)).toBeCloseTo(row.income, 6);
          // Saved in the month: SUMIFS over the Month column of the contributions, which is text ("October 2026").
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
        // The table's blank rows stay blank, not zero and not an error.
        expect(sh.cells.get(`N${head + 1 + sorted.length}`)?.value).toBe('');
        expect(String(sh.cells.get(`L${head - 1}`)?.value).startsWith(L.savings.total[0])).toBe(true);
      });

      extra({ lang, L, book, monthSheet, savings, num, head });
    });
  }

  describe('sample data, with seven more goals', () => {
    const { state } = SAMPLE;

    check(SAMPLE, ({ monthSheet, savings, num }) => {
      it('the expense in USD is converted with the month rate', () => {
        const sh = monthSheet('2026-10');
        const row = [...sh.cells.values()].find((c) => c.value === 'Namecheap')!.ref.slice(1);
        expect(sh.cells.get(`H${row}`)?.value).toBe('USD');
        expect(num(sh, `I${row}`)).toBeCloseTo(12.5 * monthCalc(state, '2026-10').rate!.rate, 6);
        expect(num(sh, `J${row}`)).toBeCloseTo(12.5, 6);
      });

      it('the balances of the two accounts are the ones the app calculates', () => {
        const sh = monthSheet('2026-10');
        const b = balances(state, '2026-10');
        expect(num(sh, 'C8')).toBeCloseTo(b.accounts.find((a) => a.account.id === 'us')!.balance, 6);
        expect(num(sh, 'C9')).toBeCloseTo(b.accounts.find((a) => a.account.id === 'dr')!.balance, 6);
        expect(num(sh, 'C8')).toBeCloseTo(13482 - 12.5, 6);
      });

      it('each goal counts only its own, even if its name has wildcards or starts with an operator', () => {
        const sh = savings();
        expect(SAMPLE.layout.bands).toBe(4);
        // "Gifts?" does not add in the amounts of "Giftsx", nor "5* hotel…" those of "5 stars hotel…", nor "=10"
        // those of "10" (bands 1, 2 and 3; slots B and E).
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

  describe('with TRY, more accounts and hidden accounts: what the workbook receives already converted', () => {
    const { state, data } = MIXED;

    check(MIXED, ({ monthSheet, savings, num }) => {
      it('premise: the user sees their money in TRY and has more accounts than fit in the workbook', () => {
        expect(state.mainCurrency).toBe('TRY');
        expect(state.accounts.filter((a) => !a.hidden)).toHaveLength(5);
        expect(MIXED.layout.bands).toBe(2);
      });

      it('the two balance cells add up the visible accounts: the DOP ones and, in USD, the rest', () => {
        const sh = monthSheet('2026-10');
        const bal = (id: string) => balances(state, '2026-10').accounts.find((a) => a.account.id === id)!.balance;
        expect(num(sh, 'C8')).toBeCloseTo(bal('us') + bal('pp') + convert(state, '2026-10', bal('tr'), 'TRY', 'USD'), 6);
        expect(num(sh, 'C9')).toBeCloseTo(bal('dr') + bal('cash'), 6);
      });

      it('what was in TRY arrives in DOP, and the transaction notes the original amount', () => {
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

      it('the transfer back (DOP → USD) goes into the month rate as the USD that arrived', () => {
        const sh = monthSheet('2026-10');
        const sent = data.months[2]!.transfers;
        expect(sent).toHaveLength(3);
        const usd = sent.reduce((a, t) => a + t.usd!, 0);
        expect(num(sh, 'T3')).toBeCloseTo(sent.reduce((a, t) => a + t.usd! * t.rate!, 0) / usd, 8);
        expect(num(sh, 'T3')).toBeCloseTo((1500 * 58.76 + 11700 + 50 * 58.9) / (1500 + 200 + 50), 8);
      });

      it('the goal in TRY has its card with a plan, in USD', () => {
        const sh = savings();
        // Band 1, wide slot: 10,000 TRY a month for 12 months, at the October rate.
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
