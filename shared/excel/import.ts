import type { ImportGoal, ImportMonth, ImportPayload } from '../api';
import { APP_NAME, CATS, DEFAULT_GOALS, METHODS, VIAS } from '../constants';
import { canonicalCat, canonicalMethod } from '../i18n';
import { isISODate, isMonthKey, keyFromLabel } from '../month';
import type { Currency, ISODate, MonthKey } from '../types';
import { CONFIG_SHEET } from './export';
import { BAND_ROWS, BAND_TOP, GOAL_SLOTS, WIDE_SLOT, goalPlan } from './export-goals';
import { ImportError } from './import-error';
import { readXlsx } from './import-xlsx';
import type { CellValue, SheetCells, XlsxSheet } from './import-xlsx';
import { EXCEL_ES, EXCEL_LOCALES } from './locale';
import type { ExcelLocale } from './locale';

export { ImportError };
export type { ImportErrorCode } from './import-error';

// ── Languages ────────────────────────────────────────────────────────────────
// The workbook can come in any of the app's languages (and every workbook from before those languages, in
// Spanish). Everything recognized by its text — sheets, headers, the "Yes" under Paid — is compared against
// the texts of the three ExcelLocale at once, not against those of one language chosen for the whole
// workbook: that way a workbook that mixes them (a renamed sheet, a table pasted from another file) is read too.

const LOCALES = Object.values(EXCEL_LOCALES);

/** No stray whitespace and in composed form, so that "Vía" is the same however it was written. */
const tidy = (s: string) => s.trim().normalize('NFC');

/** No accents and in lower case: "Sí", "SI" and " si " are the same. */
const fold = (s: string) => s.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** The texts a given spot in the workbook can have, one per language. */
function inAnyLanguage(pick: (L: ExcelLocale) => string): ReadonlySet<string> {
  return new Set(LOCALES.map((L) => tidy(pick(L))));
}

const SAVINGS_SHEETS = inAnyLanguage((L) => L.sheets.savings);
const HEAD = {
  item: inAnyLanguage((L) => L.cols.item),
  date: inAnyLanguage((L) => L.cols.date),
  via: inAnyLanguage((L) => L.cols.via),
  description: inAnyLanguage((L) => L.cols.description),
  goal: inAnyLanguage((L) => L.cols.goal),
};
const YES = new Set(LOCALES.map((L) => fold(L.yes)));

/**
 * A text-to-text function that remembers what it already answered. canonicalCat and canonicalMethod walk the
 * lists of the three languages on every call, and in a sheet the same few categories repeat thousands of
 * times. The cap keeps it from growing without end with hand-typed categories, different in every row.
 */
function remembering(fn: (text: string) => string): (text: string) => string {
  const seen = new Map<string, string>();
  return (text) => {
    let out = seen.get(text);
    if (out === undefined) {
      out = fn(text);
      if (seen.size < 500) seen.set(text, out);
    }
    return out;
  };
}

/** The workbook has categories and methods in its language; they are stored by canonical name. Unlisted values stay as is. */
const toCat = remembering(canonicalCat);
const toMethod = remembering(canonicalMethod);

// ── Default values ───────────────────────────────────────────────────────────

/** Budget when cell O6 is empty (the template with no data), same as in the prototype. */
const DEFAULT_BUDGET = 70000;

/** Goal the prototype assigned a contribution with no goal to: the personal savings one. */
const FALLBACK_GOAL = DEFAULT_GOALS.find((g) => g.id === 'personal')?.name ?? 'Personal savings';

/**
 * The three fixed goals of the version 1 workbook (always in Spanish) and today's goal that corresponds to
 * each one: the two a user starts with and the trip one. Only in a workbook with that shape is a goal
 * renamed (see `isLegacyBook`); in any other, the name is the user's data and is left untouched.
 * It is exported for the server: when applying the import, whoever still has a goal with the name from back
 * then keeps using it (server/db.ts applyImport).
 */
export const LEGACY_GOALS: readonly (readonly [before: string, now: string])[] = [
  ['Fondo de emergencia', DEFAULT_GOALS.find((g) => g.id === 'emergency')?.name ?? 'Emergency fund'],
  ['Ahorro personal', FALLBACK_GOAL],
  ['Viaje a Turquía', 'Trip to Turkey'],
];

// ── Savings sheet ────────────────────────────────────────────────────────────
// The layout is the exporter's (export.ts `savingsSheet` and export-goals.ts).

/** Header row of the contributions table in the original design (a single band of cards). */
const CONTRIB_HEAD = BAND_TOP + BAND_ROWS + 1;
/** Maximum number of bands of cards searched for that header. The API allows 200 goals; this leaves ample room. */
const MAX_BANDS = 1000;
/** Within a band, the row of the three values of a goal with a plan: contribution (J), start (L) and end (N). */
const PLAN_ROW = 6;
/** Goal list of the Config sheet (the contributions' dropdown): column G, from row 4 down. */
const CONFIG_GOALS_ROW = 4;
const CONFIG_GOALS_MAX = 5000;

/** Consecutive rows with no data that mark a table as finished. */
const TX_GAP = 40;
const TRANSFER_GAP = 80;
const CONTRIB_GAP = 40;

/** No number or date written as text is longer than this; anything else is not even parsed. */
const MAX_LITERAL = 40;

// Number written as text: "1337.15", "1,337.15", "-20", "1e3". Comma only as a thousands separator (es-DO format).
const NUM_TEXT_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d*)?|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/;
// Dates written as text. The day-first form is the one the sheet uses (dd/mm/yyyy).
const YMD_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/;
const DMY_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ].*)?$/;
const YM_RE = /^(\d{4})[-/.](\d{1,2})$/;
const MY_RE = /^(\d{1,2})[-/.](\d{4})$/;

const pad = (n: string | number) => String(n).padStart(2, '0');

function toNumber(v: CellValue | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length > MAX_LITERAL || !NUM_TEXT_RE.test(t)) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** The text as it is in the cell; text that is only whitespace counts as empty. */
function toText(v: CellValue | undefined): string {
  if (typeof v === 'string') return v.trim() === '' ? '' : v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return '';
}

/** "Sí", "Yes" or "Evet", with or without the accent and in any letter case; also a checked checkbox (Numbers). */
function isYes(v: CellValue | undefined): boolean {
  if (typeof v === 'boolean') return v;
  return typeof v === 'string' && YES.has(fold(v));
}

/** `empty` is the table's default currency when the cell is empty; any other text is DOP. */
function toCurrency(v: CellValue | undefined, empty: Currency): Currency {
  const t = toText(v).trim().toUpperCase();
  if (t === '') return empty;
  return t === 'USD' ? 'USD' : 'DOP';
}

/**
 * Excel serial → date, with the same arithmetic as `iso()` in the prototype (25569 is 1970-01-01).
 * In the 1904 system the serials start 1462 days later.
 */
function serialToISO(serial: number, date1904: boolean): ISODate | null {
  const days = date1904 ? serial + 1462 : serial;
  // Outside 1900-01-01..9999-12-31 it is not an Excel date (and toISOString would throw).
  // Serial 1 is 1899-12-31, which the app does not accept as a date.
  if (!(days >= 2 && days < 2958466)) return null;
  return new Date(Math.round((days - 25569) * 864e5)).toISOString().slice(0, 10);
}

function toISODate(v: CellValue | undefined, date1904: boolean): ISODate | null {
  if (typeof v === 'number') return serialToISO(v, date1904);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length > MAX_LITERAL) return null;
  let iso: string;
  let m = YMD_RE.exec(t);
  if (m) {
    iso = `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`;
  } else if ((m = DMY_RE.exec(t))) {
    iso = `${m[3]}-${pad(m[2]!)}-${pad(m[1]!)}`;
  } else {
    return null;
  }
  return isISODate(iso) ? iso : null;
}

/** Month of a date cell (start and end of a goal with a plan, formatted mm/yyyy). */
function toMonthKey(v: CellValue | undefined, date1904: boolean): MonthKey | null {
  const iso = toISODate(v, date1904);
  if (iso) return iso.slice(0, 7);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length > MAX_LITERAL) return null;
  let key: string;
  let m = YM_RE.exec(t);
  if (m) {
    key = `${m[1]}-${pad(m[2]!)}`;
  } else if ((m = MY_RE.exec(t))) {
    key = `${m[2]}-${pad(m[1]!)}`;
  } else {
    return null;
  }
  return isMonthKey(key) ? key : null;
}

/** Does the cell hold one of those header texts? */
function isHeader(sheet: SheetCells, col: string, row: number, names: ReadonlySet<string>): boolean {
  const v = sheet.get(col, row);
  return typeof v === 'string' && names.has(tidy(v));
}

function readMonth(sheet: SheetCells, key: MonthKey, closed: boolean, date1904: boolean): ImportMonth {
  const g = (col: string, row: number) => sheet.get(col, row);
  const firstDay = `${key}-01`;

  // Tables are located by their headers: with more than 15 fixed expenses or more than 5 transfers the history
  // moves down. The first matching row wins: further down, an expense named "Item" or "Concepto" is an expense.
  // If they do not show up, the rows of the original design apply.
  let fh = 0;
  let eh = 0;
  let th = 0;
  for (let r = 1; r <= 400 && r <= sheet.maxRow; r++) {
    if (!fh && isHeader(sheet, 'C', r, HEAD.item)) fh = r;
    if (!eh && isHeader(sheet, 'M', r, HEAD.date) && isHeader(sheet, 'N', r, HEAD.via)) eh = r;
    if (isHeader(sheet, 'B', r, HEAD.date) && isHeader(sheet, 'C', r, HEAD.description)) {
      th = r;
      break;
    }
  }
  fh ||= 15;
  eh ||= 29;
  th ||= 38;

  // Fixed expenses: between their header and the history's. A row counts if it has an item and an amount.
  const fixed: ImportMonth['fixed'] = [];
  for (let r = fh + 1; r < th; r++) {
    const name = toText(g('C', r));
    const amount = toNumber(g('E', r));
    if (name === '' || amount === null) continue;
    fixed.push({ name, day: toText(g('D', r)), amount, cur: toCurrency(g('F', r), 'DOP'), paid: isYes(g('B', r)) });
  }

  // Transfers: a row counts if it has USD. The prototype looked at 80 fixed rows; here it goes on while there is data.
  const transfers: ImportMonth['transfers'] = [];
  for (let r = eh + 1, gap = 0; r <= sheet.maxRow && gap < TRANSFER_GAP; r++) {
    const usd = toNumber(g('O', r));
    if (usd === null) {
      gap++;
      continue;
    }
    gap = 0;
    transfers.push({
      date: toISODate(g('M', r), date1904) ?? firstDay,
      // The via is free text: it goes in as written.
      via: toText(g('N', r)) || VIAS[0],
      usd,
      rate: toNumber(g('P', r)) ?? 0,
    });
  }

  // History: a row counts if it has a description or a numeric amount. The blank rows at the end of the
  // table (or in between) are not transactions; after 40 in a row the table is taken as finished.
  const tx: ImportMonth['tx'] = [];
  for (let r = th + 1, gap = 0; r <= sheet.maxRow && gap < TX_GAP; r++) {
    const desc = toText(g('C', r));
    const amount = toNumber(g('G', r));
    if (desc === '' && amount === null) {
      gap++;
      continue;
    }
    gap = 0;
    tx.push({
      date: toISODate(g('B', r), date1904) ?? firstDay,
      desc,
      place: toText(g('D', r)),
      cat: toCat(toText(g('E', r))) || CATS[0],
      method: toMethod(toText(g('F', r))) || METHODS[0],
      amount: amount ?? 0,
      cur: toCurrency(g('H', r), 'DOP'),
      notes: toText(g('K', r)),
    });
  }

  return {
    key,
    closed,
    budget: toNumber(g('O', 6)) ?? DEFAULT_BUDGET,
    incomeUSD: toNumber(g('C', 10)) ?? 0,
    accounts: { usd: toNumber(g('C', 8)) ?? 0, dop: toNumber(g('C', 9)) ?? 0 },
    fixed,
    transfers,
    tx,
  };
}

/**
 * Goal cards, in sheet order: band by band and, within each one, the two narrow slots (variable-contribution
 * goals) and the wide one (goal with a plan). The name is in the slot's first cell; a slot with no name is
 * empty. If the plan's values cannot be read or do not make a plan (a contribution that is not greater than
 * zero, a missing date, the end before the start), the goal stays a variable-contribution one: it is the
 * same rule the exporter uses to decide which card it draws (`goalPlan`).
 */
function readGoalCards(sheet: SheetCells, bands: number, date1904: boolean): ImportGoal[] {
  const goals: ImportGoal[] = [];
  for (let band = 0; band < bands; band++) {
    const top = BAND_TOP + BAND_ROWS * band;
    GOAL_SLOTS.forEach(([col], slot) => {
      const name = toText(sheet.get(col, top));
      if (name === '') return;
      const plan =
        slot === WIDE_SLOT
          ? goalPlan({
              monthlyUSD: toNumber(sheet.get('J', top + PLAN_ROW)),
              start: toMonthKey(sheet.get('L', top + PLAN_ROW), date1904),
              end: toMonthKey(sheet.get('N', top + PLAN_ROW), date1904),
            })
          : null;
      goals.push({ name, monthlyUSD: plan?.monthlyUSD ?? null, start: plan?.start ?? null, end: plan?.end ?? null });
    });
  }
  return goals;
}

/**
 * The goals in the order of the Config list, which is the order the user had them in: on the savings
 * sheet, a goal with a plan and one without a plan in the same band do not say which came first. The cards
 * the list does not name go last, in sheet order; a name in the list with no card is not a goal.
 */
function inConfigOrder(cards: ImportGoal[], config: SheetCells | null): ImportGoal[] {
  if (!config || cards.length < 2) return cards;
  const byName = new Map<string, ImportGoal[]>();
  for (const card of cards) {
    const same = byName.get(tidy(card.name));
    if (same) same.push(card);
    else byName.set(tidy(card.name), [card]);
  }
  const listed = new Set<ImportGoal>();
  const last = Math.min(config.maxRow, CONFIG_GOALS_ROW + CONFIG_GOALS_MAX);
  for (let r = CONFIG_GOALS_ROW; r <= last; r++) {
    // With repeated names, each occurrence in the list takes the next card with that name.
    const card = byName.get(tidy(toText(config.get('G', r))))?.shift();
    if (card) listed.add(card);
  }
  return [...listed, ...cards.filter((card) => !listed.has(card))];
}

/**
 * Is it the version 1 workbook? That exporter could only draw three goals, always the same ones and in Spanish;
 * any of today's workbooks with other goals, or in another language, can be told apart from it. (One of today's
 * in Spanish with exactly those three goals is, byte for byte, the old one: there is no way to tell them apart.)
 */
function isLegacyBook(sheetName: string, bands: number, cards: readonly ImportGoal[]): boolean {
  return (
    tidy(sheetName) === EXCEL_ES.sheets.savings &&
    bands === 1 &&
    cards.length === LEGACY_GOALS.length &&
    cards.every((card, i) => tidy(card.name) === LEGACY_GOALS[i][0])
  );
}

function readSavings(
  { name, cells: sheet }: XlsxSheet,
  config: SheetCells | null,
  date1904: boolean,
  fallbackDate: ISODate,
): Pick<ImportPayload, 'contribs' | 'goals'> {
  const g = (col: string, row: number) => sheet.get(col, row);

  // The contributions table moves down 8 rows for each extra band of cards: it is located by its header
  // (Date in I, Goal in K) and its row also says how many bands there are. If missing, the original design's row applies.
  let head = CONTRIB_HEAD;
  const lastHead = Math.min(sheet.maxRow, BAND_TOP + BAND_ROWS * MAX_BANDS + 1);
  for (let r = 1; r <= lastHead; r++) {
    if (isHeader(sheet, 'I', r, HEAD.date) && isHeader(sheet, 'K', r, HEAD.goal)) {
      head = r;
      break;
    }
  }
  const bands = Math.max(1, Math.floor((head - 1 - BAND_TOP) / BAND_ROWS));

  const cards = readGoalCards(sheet, bands, date1904);

  // Contributions: date in I, goal in K, amount in L, currency in M. A row counts if it has an amount.
  const contribs: NonNullable<ImportPayload['contribs']> = [];
  for (let r = head + 1, gap = 0; r <= sheet.maxRow && gap < CONTRIB_GAP; r++) {
    const amount = toNumber(g('L', r));
    if (amount === null) {
      if (g('I', r) === undefined) gap++;
      continue;
    }
    gap = 0;
    contribs.push({
      date: toISODate(g('I', r), date1904) ?? fallbackDate,
      goalName: toText(g('K', r)) || FALLBACK_GOAL,
      amount,
      // The exporter and the prototype treat a contribution with no currency as USD.
      cur: toCurrency(g('M', r), 'USD'),
    });
  }

  const goals = inConfigOrder(cards, config);
  if (isLegacyBook(name, bands, cards)) {
    // That way, when a version 1 workbook is imported, its contributions land in the goals the user starts with.
    const renamed = new Map(LEGACY_GOALS);
    for (const goal of goals) goal.name = renamed.get(tidy(goal.name)) ?? goal.name;
    for (const c of contribs) c.goalName = renamed.get(tidy(c.goalName)) ?? c.goalName;
  }
  return { contribs, goals };
}

/**
 * Reads an .xlsx in the app's format, whatever language it is in (English, Spanish or Turkish, or a mix).
 * It locates the tables by their headers (e.g. "Item", "Date"+"Via", "Date"+"Description") and the goal cards
 * by their place on the savings sheet. Equivalent to the prototype's `importExcel()`, but it returns data
 * already normalized and language-free (numbers, ISO dates, DOP/USD currency, categories and methods under
 * their canonical name) and without ids. The texts the user typed come out as is.
 *
 * Throws ImportError (message in English and a stable `code`) if the bytes are not an .xlsx or the workbook
 * has no month sheets ("October 2026", "Octubre 2026", "Ekim 2026").
 */
export function parseFinanzasXlsx(bytes: Uint8Array): ImportPayload {
  try {
    const monthKeyOf = (name: string) => keyFromLabel(tidy(name));
    const isSavings = (name: string) => SAVINGS_SHEETS.has(tidy(name));
    const isConfig = (name: string) => tidy(name) === CONFIG_SHEET;
    const book = readXlsx(bytes, (name) => monthKeyOf(name) !== null || isSavings(name) || isConfig(name));

    // If two sheets give the same month ("Octubre 2026" and "October 2026"), the last one wins, as in the prototype.
    const byKey = new Map<MonthKey, SheetCells>();
    let savings: XlsxSheet | null = null;
    let config: SheetCells | null = null;
    for (const sheet of book.sheets) {
      const key = monthKeyOf(sheet.name);
      if (key !== null) byKey.set(key, sheet.cells);
      else if (isSavings(sheet.name)) savings = sheet;
      else config = sheet.cells;
    }
    const keys = [...byKey.keys()].sort();
    if (!keys.length) {
      throw new ImportError(`The file is not in the ${APP_NAME} format: it has no month sheets.`, { code: 'no_month_sheets' });
    }

    // Every month ends up closed except the last one, which becomes the current month.
    const lastKey = keys[keys.length - 1]!;
    const months = keys.map((key) => readMonth(byKey.get(key)!, key, key !== lastKey, book.date1904));

    // A contribution with no readable date is recorded in the current month.
    const { contribs, goals } = savings
      ? readSavings(savings, config, book.date1904, `${lastKey}-01`)
      : { contribs: null, goals: null };
    return { months, contribs, goals };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    // The bytes come from a user's file: any other failure while reading them is an unreadable file.
    throw new ImportError('Could not read the file.', { code: 'unreadable', cause: e });
  }
}
