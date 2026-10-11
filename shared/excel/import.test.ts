// Tests for the .xlsx reader (shared/excel/import.ts).
// The workbooks come from three places:
//   · the files in design_handoff/referencia/ and the prototype's original exporter
//     (tests/reference-export.ts): these are the version 1 workbooks, always in Spanish and with three fixed goals;
//   · the app's exporter (export.ts), the only one that writes them in English and in Turkish and with whatever
//     goals the user has; its sample data is the frozen inputs in tests/export-data-*.json, not the
//     app state (data.test.ts takes care of that step);
//   · hand-written XML, with the variants that Excel, Numbers and LibreOffice produce when saving.
// What is expected is written here with its values, not computed with the functions the importer uses.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildWithReference, frozenExportData } from '../../tests/reference-export';
import type { ImportGoal, ImportMonth, ImportPayload } from '../api';
import { seedState } from '../seed';
import type { Currency, Language } from '../types';
import { EXCEL_LOCALES, buildFinanzasXlsx } from './export';
import { ImportError, parseFinanzasXlsx } from './import';
import type { ImportErrorCode } from './import';
import type { ExportData, ExportGoal } from './types';

type Tx = ImportMonth['tx'][number];
type Contrib = NonNullable<ImportPayload['contribs']>[number];

const LANGS: Language[] = ['en', 'es', 'tr'];

const file = (path: string) => new Uint8Array(readFileSync(new URL(path, import.meta.url)));
const reference = (name: string) => file(`../../design_handoff/referencia/${name}`);

// ── Comparison ───────────────────────────────────────────────────────────────

function sorted<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
const txKey = (t: Tx) => [t.date, t.desc, t.place, t.amount].join('\u0000');
const contribKey = (c: Contrib) => [c.date, c.goalName, c.amount].join('\u0000');

/** The exporter writes transactions and contributions sorted by date: the comparison ignores the order. */
function normalize(p: ImportPayload): ImportPayload {
  return {
    ...p,
    months: p.months.map((m) => ({ ...m, tx: sorted(m.tx, txKey) })),
    contribs: p.contribs && sorted(p.contribs, contribKey),
  };
}

/**
 * What must come out when importing a workbook generated from `data`, whatever language it is in: the same
 * data (categories and methods with their canonical name, which is how they come in `data`; the 'Card' of the
 * frozen inputs, as 'Debit card') and the goals in their order.
 */
function expectedPayload(data: ExportData): ImportPayload {
  const months = sorted(data.months, (m) => m.key);
  return normalize({
    months: months.map((m, i) => ({
      key: m.key,
      closed: i < months.length - 1,
      budget: m.budget ?? 70000,
      incomeUSD: m.incomeUSD ?? 0,
      accounts: { usd: m.accounts.usd ?? 0, dop: m.accounts.dop ?? 0 },
      fixed: m.fixed.map((f) => ({ name: f.name, day: String(f.day ?? ''), amount: f.amount ?? 0, cur: f.cur, paid: f.paid })),
      transfers: m.transfers.map((t) => ({ date: t.date, via: t.via, usd: t.usd ?? 0, rate: t.rate ?? 0 })),
      tx: m.tx.map((t) => ({
        date: t.date,
        desc: t.desc,
        place: t.place,
        cat: t.cat,
        method: todayMethod(t.method),
        amount: t.amount ?? 0,
        cur: t.cur,
        notes: t.notes,
      })),
    })),
    contribs: data.contribs.map((c) => ({ date: c.date, goalName: c.goalName, amount: c.amount, cur: c.cur })),
    goals: data.goals.map((g) => ({ name: g.name, monthlyUSD: g.monthlyUSD, start: g.start, end: g.end })),
  });
}

// ── Version 1 Spanish ↔ today's names ────────────────────────────────────────
// Written here by hand (not taken from shared/i18n.ts): they are what is inside the workbooks that already exist.

const CAT_ES: Record<string, string> = {
  Food: 'Comida',
  Groceries: 'Supermercado',
  Transport: 'Transporte',
  Entertainment: 'Entretenimiento',
  Health: 'Salud',
  Clothing: 'Ropa',
  Home: 'Hogar',
  Subscriptions: 'Suscripciones',
  Education: 'Educación',
  Travel: 'Viajes',
};
// The only card back then ('Tarjeta') is today's debit card.
const METHOD_ES: Record<string, string> = { 'Debit card': 'Tarjeta', Transfer: 'Transferencia', 'Bank app': 'App del banco' };
/** The frozen inputs in English say 'Card', the method from when they were made: today it is read as 'Debit card'. */
const todayMethod = (method: string) => (method === 'Card' ? 'Debit card' : method);
const GOAL_ES: Record<string, string> = {
  'Emergency fund': 'Fondo de emergencia',
  'Personal savings': 'Ahorro personal',
  'Trip to Turkey': 'Viaje a Turquía',
};

const inverse = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
const CAT_EN = inverse(CAT_ES);
const METHOD_EN = inverse(METHOD_ES);
const GOAL_EN = inverse(GOAL_ES);

/** The same data as a version 1 user had it: categories, methods and goals in Spanish. */
function asVersion1(data: ExportData): ExportData {
  return {
    ...data,
    months: data.months.map((m) => ({
      ...m,
      tx: m.tx.map((t) => ({ ...t, cat: CAT_ES[t.cat] ?? t.cat, method: METHOD_ES[todayMethod(t.method)] ?? t.method })),
    })),
    goals: data.goals.map((g) => ({ ...g, name: GOAL_ES[g.name] ?? g.name })),
    contribs: data.contribs.map((c) => ({ ...c, goalName: GOAL_ES[c.goalName] ?? c.goalName })),
  };
}

const variable = (name: string): ExportGoal => ({ name, monthlyUSD: null, start: null, end: null });
const planned = (name: string, monthlyUSD: number, start: string, end: string): ExportGoal => ({ name, monthlyUSD, start, end });

/** Today's goals that correspond to the three of the original design. */
const TODAY_GOALS: ImportGoal[] = [
  variable('Emergency fund'),
  variable('Personal savings'),
  planned('Trip to Turkey', 3000, '2026-08', '2027-10'),
];

// ── Hand-written workbooks ───────────────────────────────────────────────────

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
const ROOT_RELS = `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colNumber = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const pad = (n: number) => String(n).padStart(2, '0');

/** Excel serial (1900 system) of an ISO date. */
function serial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;
}

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 6 });
}

/** Text → inline string, number → <v>, boolean → t="b"; `raw` is the <c> element as is. */
type TestCell = string | number | boolean | { raw: string };

/** Minimal sheet from { C15: 'Concepto', E16: 1337.15, … }. */
function sheetXml(cells: Record<string, TestCell>): string {
  const rows = new Map<number, [col: number, xml: string][]>();
  for (const [ref, v] of Object.entries(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    const xml =
      typeof v === 'object'
        ? v.raw
        : typeof v === 'number'
          ? `<c r="${ref}"><v>${v}</v></c>`
          : typeof v === 'boolean'
            ? `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    const row = rows.get(+m[2]!) ?? [];
    row.push([colNumber(m[1]!), xml]);
    rows.set(+m[2]!, row);
  }
  const body = [...rows]
    .sort((a, b) => a[0] - b[0])
    .map(([r, cs]) => `<row r="${r}">${cs.sort((a, b) => a[0] - b[0]).map((c) => c[1]).join('')}</row>`)
    .join('');
  return `${XML}<worksheet xmlns="${MAIN}"><sheetData>${body}</sheetData></worksheet>`;
}

/** Minimal .xlsx: one part per sheet, in the given order. */
function xlsx(sheets: [name: string, xml: string][], opts: { date1904?: boolean } = {}): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'xl/workbook.xml': `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}">${opts.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets.map(([name], i) => `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="${PKG_REL}">${sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  sheets.forEach(([, xml], i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = xml;
  });
  return zip(files);
}

/** Headers of the three tables in their original place, as in the version 1 workbooks (in Spanish). */
const HEADERS: Record<string, TestCell> = {
  B15: 'Pagado', C15: 'Concepto', D15: 'Día de cobro', E15: 'Monto', F15: 'Moneda',
  M29: 'Fecha', N29: 'Vía', O29: 'USD', P29: 'Tasa',
  B38: 'Fecha', C38: 'Descripción', D38: 'Lugar', E38: 'Categoría', F38: 'Método', G38: 'Monto', H38: 'Moneda', K38: 'Notas',
};

/** Imports a workbook with a single "Enero 2027" sheet and returns that month. */
function month(cells: Record<string, TestCell>, opts: { date1904?: boolean } = {}): ImportMonth {
  return parseFinanzasXlsx(xlsx([['Enero 2027', sheetXml({ ...HEADERS, ...cells })]], opts)).months[0]!;
}

/** Config sheet with that list of goals (column G, from row 4). */
const configXml = (goals: string[]) => sheetXml(Object.fromEntries(goals.map((name, i) => [`G${4 + i}`, name])));

/** Imports a workbook with "Enero 2027" (empty), the given savings sheet and, if specified, the Config goal list. */
function savings(
  cells: Record<string, TestCell>,
  opts: { sheet?: string; config?: string[] } = {},
): Pick<ImportPayload, 'contribs' | 'goals'> {
  const sheets: [string, string][] = [
    ['Enero 2027', sheetXml(HEADERS)],
    [opts.sheet ?? 'Ahorros', sheetXml(cells)],
  ];
  if (opts.config) sheets.push(['Config', configXml(opts.config)]);
  const { contribs, goals } = parseFinanzasXlsx(xlsx(sheets));
  return { contribs, goals };
}

const TX_DEFAULTS = { place: '', cat: 'Food', method: 'Debit card', cur: 'DOP' as Currency, notes: '' };

/** The error that `fn` throws, checking that it is an ImportError. */
function importError(fn: () => unknown): ImportError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ImportError);
    return e as ImportError;
  }
  throw new Error('did not throw');
}

// ── Reference workbooks ──────────────────────────────────────────────────────

describe('workbooks in design_handoff/referencia (version 1, in Spanish)', () => {
  it('Finanzas Personales v3.xlsx → the sample data in Spanish, with the categories, methods and goals of today', () => {
    // The data that workbook was generated from (reference.test.ts checks it byte for byte).
    const seed = frozenExportData('es');
    const payload = parseFinanzasXlsx(reference('Finanzas Personales v3.xlsx'));

    expect(payload.months.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    // All closed except the last one.
    expect(payload.months.map((m) => m.closed)).toEqual([true, true, false]);
    payload.months.forEach((m, i) => {
      const month = seed.months[i]!;
      expect(month.key).toBe(m.key);
      expect(m.budget, m.key).toBe(month.budget);
      expect(m.incomeUSD, m.key).toBe(month.incomeUSD);
      expect(m.accounts, m.key).toEqual(month.accounts);
      // The fixed expenses, in sheet order and with their paid status. Their names are the user's: not translated.
      expect(m.fixed, m.key).toEqual(month.fixed);
      expect(m.transfers, m.key).toEqual(month.transfers);
      expect(sorted(m.tx, txKey), m.key).toEqual(
        sorted(
          month.tx.map((t) => ({ ...t, amount: t.amount ?? 0, cat: CAT_EN[t.cat]!, method: METHOD_EN[t.method]! })),
          txKey,
        ),
      );
    });
    expect(sorted(payload.contribs!, contribKey)).toEqual(
      sorted(
        seed.contribs.map((c) => ({ ...c, goalName: GOAL_EN[c.goalName]! })),
        contribKey,
      ),
    );
    expect(payload.goals).toEqual(TODAY_GOALS);

    // Some literal values, so the test does not depend only on the frozen input.
    expect(payload.months.map((m) => [m.budget, m.incomeUSD, m.accounts.usd, m.accounts.dop])).toEqual([
      [70000, 5800, 3900, 78200],
      [70000, 5800, 4100, 81500],
      [70000, 5800, 4320, 86400],
    ]);
    const oct = payload.months[2]!;
    expect(oct.fixed[4]).toEqual({ name: 'Claude', day: '5', amount: 106, cur: 'USD', paid: true });
    expect(oct.fixed[5]).toEqual({ name: 'Google One', day: '16', amount: 121.56, cur: 'DOP', paid: false });
    expect(oct.fixed.filter((f) => f.paid).map((f) => f.name)).toEqual(['Luz', 'Internet', 'Seguro médico', 'Pago nevera', 'Claude', 'Unicaribe']);
    expect(oct.transfers).toEqual([{ date: '2026-10-02', via: 'Remitly', usd: 1500, rate: 58.76 }]);
    expect(oct.tx).toHaveLength(7);
    expect(oct.tx).toContainEqual({ date: '2026-10-07', desc: 'Café', place: 'Starbucks Ágora', cat: 'Food', method: 'Debit card', amount: 385, cur: 'DOP', notes: '' });
    expect(payload.months[0]!.tx).toContainEqual({ date: '2026-08-21', desc: 'Consulta', place: 'Centro Médico', cat: 'Health', method: 'Transfer', amount: 2500, cur: 'DOP', notes: 'Copago seguro' });
    expect(payload.contribs).toHaveLength(8);
    expect(payload.contribs).toContainEqual({ date: '2026-09-18', goalName: 'Personal savings', amount: 200, cur: 'USD' });
    expect(payload.contribs).toContainEqual({ date: '2026-10-03', goalName: 'Trip to Turkey', amount: 3000, cur: 'USD' });
  });

  it('what is not user text matches the sample data of the app (shared/seed.ts, in English)', () => {
    const state = seedState();
    const goalName = new Map(state.goals.map((g) => [g.id, g.name]));
    const payload = parseFinanzasXlsx(reference('Finanzas Personales v3.xlsx'));
    const figures = (rows: readonly Tx[]) => rows.map((t) => [t.date, t.cat, t.method, t.amount, t.cur].join(' ')).sort();
    for (const m of payload.months) expect(figures(m.tx), m.key).toEqual(figures(state.months[m.key]!.tx));
    expect(sorted(payload.contribs!, contribKey)).toEqual(
      sorted(
        state.contribs.map((c) => ({ date: c.date, goalName: goalName.get(c.goalId)!, amount: c.amount, cur: c.cur })),
        contribKey,
      ),
    );
    // The sample goals are in USD, the only currency the workbook knows for a goal.
    expect(state.goals.map((g) => g.cur)).toEqual(['USD', 'USD', 'USD']);
    expect(payload.goals).toEqual(state.goals.map(({ name, monthly, start, end }) => ({ name, monthlyUSD: monthly, start, end })));
  });

  it('Plantilla vacia.xlsx → one month with empty tables', () => {
    expect(parseFinanzasXlsx(reference('Plantilla vacia.xlsx'))).toEqual({
      months: [
        { key: '2026-10', closed: false, budget: 70000, incomeUSD: 0, accounts: { usd: 0, dop: 0 }, fixed: [], transfers: [], tx: [] },
      ],
      contribs: [],
      // That exporter always drew the three goals, with the default plan on the trip one.
      goals: TODAY_GOALS,
    });
  });

  // import-libreoffice.fixture.xlsx is "Finanzas Personales v3.xlsx" opened and saved by LibreOffice 26.2
  // (soffice --headless --convert-to xlsx): compressed entries, formulas with their cached value,
  // empty results as t="str" and different relationship ids.
  it('the same workbook saved by LibreOffice reads the same', () => {
    const saved = file('./import-libreoffice.fixture.xlsx');
    expect(parseFinanzasXlsx(saved)).toEqual(parseFinanzasXlsx(reference('Finanzas Personales v3.xlsx')));
  });
});

// ── Custom data ──────────────────────────────────────────────────────────────

/** Two months with everything that can go wrong: USD, notes, special characters and shifted tables. */
const custom: ExportData = {
  defaultRate: 58.76,
  goals: [variable('Emergency fund'), variable('Personal savings'), planned('Trip to Turkey', 2500, '2025-11', '2027-03')],
  months: [
    // Out of order on purpose: the workbook and the result go by key.
    {
      key: '2026-01',
      budget: 82500.75,
      incomeUSD: 6100.5,
      accounts: { usd: 2310.4, dop: 45120.33 },
      fixed: [],
      transfers: [],
      tx: [{ date: '2026-01-03', desc: 'Único movimiento', place: '', cat: 'Home', method: 'Transfer', amount: 1200, cur: 'DOP', notes: '' }],
    },
    {
      key: '2025-12',
      budget: 65000,
      incomeUSD: 5400,
      accounts: { usd: 1200.25, dop: 30500 },
      // 18 fixed expenses (over 15) and 7 transfers (over 5): the tables grow and the history moves down from row 38.
      fixed: [
        { name: 'Luz & agua', day: '', amount: 1890.35, cur: 'DOP', paid: true },
        { name: 'Seguro <médico>', day: '1', amount: 5640, cur: 'DOP', paid: true },
        { name: 'Préstamo "carro"', day: '15', amount: 310.5, cur: 'USD', paid: false },
        { name: "Niñera d'Ana", day: 'fin de mes', amount: 9000, cur: 'DOP', paid: false },
        { name: 'Ñandú · año', day: '28', amount: 0.1 + 0.2, cur: 'DOP', paid: true },
        { name: 'Gratis este mes', day: '', amount: 0, cur: 'USD', paid: false },
        // Names that match a header or a "yes": they are expenses like any other.
        { name: 'Item', day: '', amount: 11, cur: 'DOP', paid: true },
        { name: 'Concepto', day: '', amount: 12, cur: 'DOP', paid: false },
        { name: 'Kalem', day: '', amount: 13, cur: 'DOP', paid: true },
        ...Array.from({ length: 9 }, (_, i) => ({
          name: `Suscripción ${i + 1}`,
          day: String(i + 2),
          amount: 100 + i * 10.25,
          cur: (i % 2 ? 'USD' : 'DOP') as Currency,
          paid: i % 3 === 0,
        })),
      ],
      transfers: [
        { date: '2025-12-01', via: 'Remitly', usd: 1500, rate: 58.4 },
        { date: '2025-12-03', via: 'PayPal', usd: 300.5, rate: 57.1 },
        // The via is free text.
        { date: '2025-12-09', via: 'Western Union', usd: 120, rate: 56.935 },
        { date: '2025-12-12', via: 'Remitly', usd: 800, rate: 58.62 },
        { date: '2025-12-18', via: 'Banco de mi tía & Cía', usd: 50, rate: 57 },
        { date: '2025-12-22', via: 'Remitly', usd: 1000, rate: 58.9 },
        { date: '2025-12-30', via: 'Remitly', usd: 75.25, rate: 59.01 },
      ],
      tx: [
        // Category and method outside the lists: user text, it stays as is in any language.
        { date: '2025-12-24', desc: 'Cena de Nochebuena', place: 'Casa', cat: 'Categoría propia', method: 'Cheque', amount: 7300, cur: 'DOP', notes: 'ñ á é í ó ú ü ¿? ¡! € RD$ ğ ş ı İ ö ç' },
        { date: '2025-12-01', desc: 'Café & pan <integral>', place: 'Panadería "La Única"', cat: 'Food', method: 'Debit card', amount: 385.5, cur: 'DOP', notes: "l'apóstrofo > todo" },
        { date: '2025-12-05', desc: 'Hosting', place: 'Hetzner', cat: 'Subscriptions', method: 'Debit card', amount: 12.99, cur: 'USD', notes: 'Factura #A-17 & recibo' },
        { date: '2025-12-05', desc: 'Sin lugar ni notas', place: '', cat: 'Transport', method: 'Bank app', amount: 250, cur: 'DOP', notes: '' },
        { date: '2025-12-05', desc: 'Vuelo SDQ → IST', place: 'Turkish Airlines', cat: 'Travel', method: 'Debit card', amount: 1480.4, cur: 'USD', notes: 'línea 1\nlínea 2' },
        // A description that is the name of a category in another language is left alone: it is not a category.
        { date: '2025-12-06', desc: 'Comida', place: 'Yemek', cat: 'Groceries', method: 'Debit card', amount: 640, cur: 'DOP', notes: 'Tarjeta' },
        { date: '2025-12-07', desc: 'Lentes', place: 'Óptica', cat: 'Health', method: 'Debit card', amount: 4100, cur: 'DOP', notes: '' },
        { date: '2025-12-08', desc: 'Abrigo', place: '', cat: 'Clothing', method: 'Debit card', amount: 2300, cur: 'DOP', notes: '' },
        { date: '2025-12-09', desc: 'Curso', place: '', cat: 'Education', method: 'Transfer', amount: 49, cur: 'USD', notes: '' },
        { date: '2025-12-10', desc: 'Cine', place: '', cat: 'Entertainment', method: 'Bank app', amount: 900, cur: 'DOP', notes: '' },
        // The sheet wins over the date: a January charge recorded in December stays in December.
        { date: '2026-01-02', desc: 'Cargo atrasado', place: 'Banco', cat: 'Home', method: 'Transfer', amount: 99.99, cur: 'DOP', notes: '  con espacios  ' },
      ],
    },
  ],
  contribs: [
    { date: '2025-12-15', goalName: 'Emergency fund', amount: 15000, cur: 'DOP' },
    { date: '2025-12-02', goalName: 'Trip to Turkey', amount: 2500, cur: 'USD' },
    // A goal that has no card: the contribution keeps its name.
    { date: '2026-01-10', goalName: 'Carro nuevo & seguro', amount: 20500.5, cur: 'DOP' },
    { date: '2026-01-10', goalName: 'Personal savings', amount: 120, cur: 'USD' },
    // Enough to go past row 40 of the savings sheet.
    ...Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${pad(i + 1)}`,
      goalName: i % 2 ? 'Personal savings' : 'Emergency fund',
      amount: 10 + i,
      cur: (i % 3 ? 'USD' : 'DOP') as Currency,
    })),
  ],
};

/** Goal lists for the app's exporter. The order is the user's, not that of the cards on the sheet. */
const GOAL_LISTS: Record<string, ExportGoal[]> = {
  'sin metas': [],
  'una sola, con plan': [planned('Trip to Turkey', 3000, '2026-08', '2027-10')],
  'cinco sin plan': [variable('Emergency fund'), variable('Personal savings'), variable('Gifts'), variable('Vacaciones'), variable('Düğün')],
  'tres con plan': [
    planned('Trip to Turkey', 3000, '2026-08', '2027-10'),
    planned('Car', 450.5, '2026-01', '2026-01'),
    planned('House', 1200, '2025-12', '2030-12'),
  ],
  // On the sheet they end up in four bands and in another order: B6 Emergency fund, E6 Fondo de emergencia, I6 Trip to
  // Turkey; B14 Gifts, I14 Car; B22 Düğün & balayı, I22 House; I30 Ahorro personal.
  'ocho mezcladas': [
    planned('Trip to Turkey', 3000, '2026-08', '2027-10'),
    variable('Emergency fund'),
    // Two of the version 1 goal names, typed by the user: in a workbook with other goals they are left alone.
    variable('Fondo de emergencia'),
    variable('Gifts'),
    planned('Car', 450.5, '2026-01', '2026-06'),
    planned('House', 1200, '2025-12', '2030-12'),
    variable('Düğün & balayı'),
    planned('Ahorro personal', 75, '2027-01', '2027-12'),
  ],
  'nombres con comillas, & y signos': [
    variable('Mamá "70" & Cía'),
    planned('R&D <lab> "x"', 99.99, '2026-02', '2026-11'),
    variable("L'été <2027>"),
    variable('=10'),
    variable('Gifts?'),
    planned('5* hotel ~ maybe', 10, '2026-03', '2026-04'),
    variable('Meta'),
    variable('Fecha'),
    // The name comes back as written, spaces included.
    variable('  con espacios  '),
  ],
};

/** `custom` with those goals and two contributions to each, plus two to a goal that has no card. */
function withGoals(goals: ExportGoal[]): ExportData {
  const names = [...goals.map((g) => g.name), 'Sin tarjeta'];
  return {
    ...custom,
    goals,
    contribs: names.flatMap((goalName, i) => [
      { date: `2025-12-${pad(i + 1)}`, goalName, amount: 100 + i, cur: 'USD' as Currency },
      { date: `2026-01-${pad(28 - i)}`, goalName, amount: 2500.5 + i, cur: 'DOP' as Currency },
    ]),
  };
}

const sharedStrings = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['xl/sharedStrings.xml']!);
const workbookXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['xl/workbook.xml']!);
/** Range of the table with that name ("I31:O49"). */
function tableRef(bytes: Uint8Array, name: string): string {
  const tables = Object.entries(unzipSync(bytes))
    .filter(([path]) => path.startsWith('xl/tables/'))
    .map(([, data]) => strFromU8(data));
  return / ref="([^"]+)"/.exec(tables.find((t) => t.includes(`name="${name}"`))!)![1]!;
}

function richText(si: string): string {
  const m = /^<t xml:space="preserve">(.*)<\/t>$/s.exec(si);
  if (!m) return si;
  const text = m[1]!;
  // It is cut at a space so as not to split an entity (&amp;).
  const cut = text.indexOf(' ');
  const runs =
    cut > 0
      ? `<r><t xml:space="preserve">${text.slice(0, cut)}</t></r><r><rPr><b/><sz val="10"/></rPr><t xml:space="preserve">${text.slice(cut)}</t></r>`
      : `<r><rPr><i/></rPr><t xml:space="preserve">${text}</t></r>`;
  return `${runs}<rPh sb="0" eb="1"><t>guía fonética</t></rPh><phoneticPr fontId="1"/>`;
}

/** Removes the r attribute from the cells (and, if asked, from the rows), filling the gaps with empty elements. */
function stripRefs(xml: string, rowsToo: boolean): string {
  return xml.replace(/<sheetData>(.*)<\/sheetData>/s, (_whole, body: string) => {
    let out = '';
    let prevRow = 0;
    for (const [, r, attrs, cells] of body.matchAll(/<row r="(\d+)"([^>]*)>(.*?)<\/row>/gs)) {
      let line = '';
      let prevCol = 0;
      for (const [, letters, rest] of cells!.matchAll(/<c r="([A-Z]+)\d+"((?:\/>|[^>]*?\/>|[^>]*?>.*?<\/c>))/gs)) {
        const col = colNumber(letters!);
        line += '<c/>'.repeat(col - prevCol - 1) + `<c${rest}`;
        prevCol = col;
      }
      if (rowsToo) out += '<row/>'.repeat(+r! - prevRow - 1) + `<row${attrs}>${line}</row>`;
      else out += `<row r="${r}"${attrs}>${line}</row>`;
      prevRow = +r!;
    }
    return `<sheetData>${out}</sheetData>`;
  });
}

/**
 * Rewrites an exporter workbook (2 months + savings + Config) with what other applications do:
 * shared strings with formatting and a phonetic guide, inline strings, dates in the 1904 system, cells and
 * rows without a reference, sheet parts that do not follow the tab order, an absolute target and deflate.
 * `planRows` are the rows of the savings sheet with the dates of a goal with a plan (12, 20, 28…).
 */
function rewriteLikeOtherApps(bytes: Uint8Array, planRows: number[] = [12]): Uint8Array {
  const files = unzipSync(bytes);
  const get = (name: string) => strFromU8(files[name]!);
  const put = (name: string, xml: string) => {
    files[name] = strToU8(xml);
  };
  const sheet = (n: number) => `xl/worksheets/sheet${n}.xml`;

  const sst = get('xl/sharedStrings.xml');
  const items = [...sst.matchAll(/<si>(.*?)<\/si>/gs)].map((m) => richText(m[1]!));
  put('xl/sharedStrings.xml', sst.replace(/<si>.*<\/si>/s, () => items.map((s) => `<si>${s}</si>`).join('')));

  const inline = (xml: string) =>
    xml.replace(/<c r="([A-Z]+\d+)" s="(\d+)" t="s"><v>(\d+)<\/v><\/c>/g, (_m, ref: string, s: string, i: string) => {
      return `<c r="${ref}" s="${s}" t="inlineStr"><is>${items[+i]}</is></c>`;
    });
  // The only integers in those columns are dates: B and M in a month; I and the start and end cells in savings.
  const to1904 = (xml: string, isDate: (col: string, row: number) => boolean) =>
    xml.replace(/<c r="([A-Z]+)(\d+)" s="(\d+)"><v>(\d+)<\/v><\/c>/g, (m, col: string, row: string, s: string, v: string) => {
      return isDate(col, +row) ? `<c r="${col}${row}" s="${s}"><v>${+v - 1462}</v></c>` : m;
    });
  const monthDate = (col: string) => col === 'B' || col === 'M';
  const savingsDate = (col: string, row: number) => col === 'I' || ((col === 'L' || col === 'N') && planRows.includes(row));

  const dec = stripRefs(inline(to1904(get(sheet(1)), monthDate)), true);
  const jan = stripRefs(to1904(get(sheet(2)), monthDate), false);
  put(sheet(3), stripRefs(to1904(get(sheet(3)), savingsDate), true));
  // December (first tab) moves to sheet2.xml and January to sheet1.xml.
  put(sheet(2), dec);
  put(sheet(1), jan);
  put(
    'xl/_rels/workbook.xml.rels',
    get('xl/_rels/workbook.xml.rels')
      .replace('Target="worksheets/sheet1.xml"', 'Target="/xl/worksheets/sheet2.xml"')
      .replace('Target="worksheets/sheet2.xml"', 'Target="worksheets/sheet1.xml"'),
  );
  put('xl/workbook.xml', get('xl/workbook.xml').replace('<bookViews>', '<workbookPr date1904="1"/><bookViews>'));
  return zipSync(files, { level: 6 });
}

/** Compression method of the first zip entry: 0 = uncompressed (exporter), 8 = deflate. */
const zipMethod = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true);

// ── Round trip with the original exporter (version 1 workbooks) ──────────────

describe('round trip with the reference exporter (version 1 workbook)', () => {
  const legacy = asVersion1(custom);

  it('custom data: USD, notes, special characters, shifted tables; everything comes back language-neutral', async () => {
    const bytes = await buildWithReference(legacy);

    // Checks the premises: the workbook is in Spanish, and with 18 fixed expenses and 7 transfers the history header
    // is no longer on row 38.
    const strings = sharedStrings(bytes);
    for (const text of ['>Hogar<', '>Transferencia<', '>App del banco<', '>Fondo de emergencia<', '>Viaje a Turquía<']) {
      expect(strings, text).toContain(text);
    }
    for (const text of ['>Home<', '>Bank app<', '>Emergency fund<', '>Trip to Turkey<']) expect(strings, text).not.toContain(text);
    expect(tableRef(bytes, 'Tx_2025_12')).toMatch(/^B42:K/);

    const payload = parseFinanzasXlsx(bytes);
    expect(normalize(payload)).toEqual(expectedPayload(custom));
    // The fixed expenses and the transfers keep the order in which they were written.
    expect(payload.months[0]!.fixed.map((f) => f.name)).toEqual(custom.months[1]!.fixed.map((f) => f.name));
    expect(payload.months[0]!.transfers.map((t) => t.date)).toEqual(custom.months[1]!.transfers.map((t) => t.date));
    expect(payload.months.map((m) => [m.key, m.closed])).toEqual([['2025-12', true], ['2026-01', false]]);
    expect(payload.contribs).toHaveLength(34);

    // Literal values: what came from a list comes back in English; what the user typed, as it was.
    const dec = payload.months[0]!;
    expect(dec.tx).toContainEqual({ date: '2025-12-24', desc: 'Cena de Nochebuena', place: 'Casa', cat: 'Categoría propia', method: 'Cheque', amount: 7300, cur: 'DOP', notes: 'ñ á é í ó ú ü ¿? ¡! € RD$ ğ ş ı İ ö ç' });
    expect(dec.tx).toContainEqual({ date: '2025-12-06', desc: 'Comida', place: 'Yemek', cat: 'Groceries', method: 'Debit card', amount: 640, cur: 'DOP', notes: 'Tarjeta' });
    expect(dec.tx).toContainEqual({ date: '2025-12-05', desc: 'Sin lugar ni notas', place: '', cat: 'Transport', method: 'Bank app', amount: 250, cur: 'DOP', notes: '' });
    expect(dec.transfers[4]).toEqual({ date: '2025-12-18', via: 'Banco de mi tía & Cía', usd: 50, rate: 57 });
    expect(dec.fixed.slice(6, 9)).toEqual([
      { name: 'Item', day: '', amount: 11, cur: 'DOP', paid: true },
      { name: 'Concepto', day: '', amount: 12, cur: 'DOP', paid: false },
      { name: 'Kalem', day: '', amount: 13, cur: 'DOP', paid: true },
    ]);
    expect(payload.goals).toEqual([
      variable('Emergency fund'),
      variable('Personal savings'),
      planned('Trip to Turkey', 2500, '2025-11', '2027-03'),
    ]);
    expect(payload.contribs).toContainEqual({ date: '2025-12-15', goalName: 'Emergency fund', amount: 15000, cur: 'DOP' });
    expect(payload.contribs).toContainEqual({ date: '2026-01-10', goalName: 'Carro nuevo & seguro', amount: 20500.5, cur: 'DOP' });
  });

  it('the same workbook compressed with deflate reads identically', async () => {
    const bytes = await buildWithReference(legacy);
    const deflated = zipSync(unzipSync(bytes), { level: 6 });
    expect(zipMethod(bytes)).toBe(0);
    expect(zipMethod(deflated)).toBe(8);
    expect(deflated.length).toBeLessThan(bytes.length / 2);
    expect(parseFinanzasXlsx(deflated)).toEqual(parseFinanzasXlsx(bytes));
  });

  it('inlineStr, formatted strings, date1904 and cells without r: reads identically', async () => {
    const bytes = await buildWithReference(legacy);
    const rewritten = rewriteLikeOtherApps(bytes);

    // Checks that the rewrite did what it says (otherwise the test would prove nothing).
    const files = unzipSync(rewritten);
    const dec = strFromU8(files['xl/worksheets/sheet2.xml']!);
    const jan = strFromU8(files['xl/worksheets/sheet1.xml']!);
    const sav = strFromU8(files['xl/worksheets/sheet3.xml']!);
    expect(dec).toContain('t="inlineStr"><is><r>');
    expect(dec).toContain('Suscripción');
    expect(dec).not.toContain('t="s"');
    expect(dec).not.toMatch(/<(c|row) r="/);
    expect(dec).toContain('<row/>');
    expect(dec).toContain('<c/>');
    expect(jan).toContain('<row r="');
    expect(jan).not.toContain('<c r="');
    expect(jan).toContain('t="s"');
    expect(sav).not.toMatch(/<(c|row) r="/);
    expect(strFromU8(files['xl/sharedStrings.xml']!)).toContain('<rPh ');
    expect(strFromU8(files['xl/sharedStrings.xml']!)).not.toContain('<si><t');
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('date1904="1"');
    // December 2025 in the 1904 system: 45992 − 1462.
    expect(dec).toContain(`<v>${serial('2025-12-01') - 1462}</v>`);
    expect(dec).not.toContain(`<v>${serial('2025-12-01')}</v>`);

    expect(parseFinanzasXlsx(rewritten)).toEqual(parseFinanzasXlsx(bytes));
    expect(normalize(parseFinanzasXlsx(rewritten))).toEqual(expectedPayload(custom));
  });

  it('a sheet with 5,000 transactions imports in full and without delay', async () => {
    const data: ExportData = {
      defaultRate: 58.76,
      goals: [variable('Emergency fund'), variable('Personal savings'), planned('Trip to Turkey', 3000, '2026-08', '2027-10')],
      contribs: [],
      months: [
        {
          key: '2026-03',
          budget: 70000,
          incomeUSD: 5800,
          accounts: { usd: 1, dop: 2 },
          fixed: [],
          transfers: [],
          tx: Array.from({ length: 5000 }, (_, i) => ({
            date: `2026-03-${pad((i % 28) + 1)}`,
            desc: `Compra ${i}`,
            place: i % 3 ? 'Colmado & más' : '',
            cat: i % 4 ? 'Food' : 'Groceries',
            method: i % 2 ? 'Debit card' : 'Bank app',
            amount: i + 0.5,
            cur: (i % 7 ? 'DOP' : 'USD') as Currency,
            notes: i % 5 ? '' : `nota ${i}`,
          })),
        },
      ],
    };
    // Deflate, as Excel would leave it when saving.
    const bytes = zipSync(unzipSync(await buildWithReference(asVersion1(data))), { level: 6 });
    const t0 = performance.now();
    const payload = parseFinanzasXlsx(bytes);
    const ms = performance.now() - t0;
    expect(normalize(payload)).toEqual(expectedPayload(data));
    expect(payload.months[0]!.tx).toHaveLength(5000);
    // Generous on purpose: it takes tens of milliseconds; a quadratic reader would take much longer.
    expect(ms).toBeLessThan(2000);
  }, 30_000);
});

// ── Round trip with the app's exporter, in the three languages ───────────────

/** Texts found only in a workbook of that language: the December sheet, the savings sheet and the Travel category. */
const IN_LANGUAGE: Record<Language, { december: string; savings: string; travel: string; contribs: string }> = {
  en: { december: 'December 2025', savings: 'Savings', travel: 'Travel', contribs: 'Contributions' },
  es: { december: 'Diciembre 2025', savings: 'Ahorros', travel: 'Viajes', contribs: 'Aportes' },
  tr: { december: 'Aralık 2025', savings: 'Birikimler', travel: 'Seyahat', contribs: 'Katkilar' },
};

describe.each(LANGS)('round trip with the app exporter, workbook in "%s"', (lang) => {
  const words = IN_LANGUAGE[lang];
  const build = (data: ExportData) => buildFinanzasXlsx(data, { locale: EXCEL_LOCALES[lang] });

  it('the sample data comes back as is', () => {
    const data = frozenExportData('en');
    const payload = parseFinanzasXlsx(build(data));
    expect(normalize(payload)).toEqual(expectedPayload(data));

    // Literal values, the same in the three languages.
    expect(payload.months.map((m) => [m.key, m.closed])).toEqual([['2026-08', true], ['2026-09', true], ['2026-10', false]]);
    const oct = payload.months[2]!;
    expect(oct.fixed[4]).toEqual({ name: 'Claude', day: '5', amount: 106, cur: 'USD', paid: true });
    expect(oct.fixed.filter((f) => f.paid).map((f) => f.name)).toEqual(['Electricity', 'Internet', 'Health insurance', 'Fridge payment', 'Claude', 'Unicaribe']);
    expect(oct.tx).toContainEqual({ date: '2026-10-07', desc: 'Coffee', place: 'Starbucks Ágora', cat: 'Food', method: 'Debit card', amount: 385, cur: 'DOP', notes: '' });
    expect(oct.tx).toContainEqual({ date: '2026-10-04', desc: 'Movies', place: 'Caribbean Cinemas', cat: 'Entertainment', method: 'Bank app', amount: 900, cur: 'DOP', notes: '' });
    expect(payload.months[0]!.tx).toContainEqual({ date: '2026-08-21', desc: 'Doctor visit', place: 'Centro Médico', cat: 'Health', method: 'Transfer', amount: 2500, cur: 'DOP', notes: 'Insurance copay' });
    expect(payload.goals).toEqual(TODAY_GOALS);
    expect(payload.contribs).toHaveLength(8);
    expect(payload.contribs).toContainEqual({ date: '2026-09-18', goalName: 'Personal savings', amount: 200, cur: 'USD' });
  });

  it.each(Object.keys(GOAL_LISTS))('custom data with goals: %s', (list) => {
    const data = withGoals(GOAL_LISTS[list]!);
    const bytes = build(data);

    // Checks the premise: the workbook really is in that language (sheets and list values).
    expect(workbookXml(bytes)).toContain(`name="${words.december}"`);
    expect(workbookXml(bytes)).toContain(`name="${words.savings}"`);
    expect(sharedStrings(bytes)).toContain(`>${words.travel}<`);

    const payload = parseFinanzasXlsx(bytes);
    expect(normalize(payload)).toEqual(expectedPayload(data));
    expect(payload.goals!.map((g) => g.name)).toEqual(GOAL_LISTS[list]!.map((g) => g.name));
    expect(payload.contribs).toHaveLength(2 * (GOAL_LISTS[list]!.length + 1));
    expect(payload.months[0]!.fixed.map((f) => f.name)).toEqual(custom.months[1]!.fixed.map((f) => f.name));
  });

  it('with four goal bands the contributions table starts 24 rows lower and is still found', () => {
    const data = withGoals(GOAL_LISTS['ocho mezcladas']!);
    const bytes = build(data);
    expect(tableRef(bytes, words.contribs)).toMatch(/^I39:O/);
    const payload = parseFinanzasXlsx(bytes);
    expect(payload.contribs).toHaveLength(18);
    expect(payload.goals).toEqual([
      planned('Trip to Turkey', 3000, '2026-08', '2027-10'),
      variable('Emergency fund'),
      variable('Fondo de emergencia'),
      variable('Gifts'),
      planned('Car', 450.5, '2026-01', '2026-06'),
      planned('House', 1200, '2025-12', '2030-12'),
      variable('Düğün & balayı'),
      planned('Ahorro personal', 75, '2027-01', '2027-12'),
    ]);
    expect(payload.contribs).toContainEqual({ date: '2025-12-03', goalName: 'Fondo de emergencia', amount: 102, cur: 'USD' });
    expect(payload.contribs).toContainEqual({ date: '2026-01-21', goalName: 'Ahorro personal', amount: 2507.5, cur: 'DOP' });
  });

  it('compressed with deflate, or rewritten the way other applications save it, reads identically', () => {
    const data = withGoals(GOAL_LISTS['ocho mezcladas']!);
    const bytes = build(data);
    const deflated = zipSync(unzipSync(bytes), { level: 6 });
    expect(zipMethod(bytes)).toBe(0);
    expect(zipMethod(deflated)).toBe(8);
    expect(parseFinanzasXlsx(deflated)).toEqual(parseFinanzasXlsx(bytes));

    // Four bands: the dates of the goals with a plan are on rows 12, 20, 28 and 36.
    const rewritten = rewriteLikeOtherApps(bytes, [12, 20, 28, 36]);
    const files = unzipSync(rewritten);
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('date1904="1"');
    expect(strFromU8(files['xl/worksheets/sheet3.xml']!)).not.toMatch(/<(c|row) r="/);
    expect(strFromU8(files['xl/worksheets/sheet3.xml']!)).toContain(`<v>${serial('2030-12-01') - 1462}</v>`);
    expect(parseFinanzasXlsx(rewritten)).toEqual(parseFinanzasXlsx(bytes));
    expect(normalize(parseFinanzasXlsx(rewritten))).toEqual(expectedPayload(data));
  });

  it('with no months it exports the empty template, which comes back as an empty month with no goals', () => {
    const empty: ExportData = { defaultRate: 58.76, months: [], goals: [], contribs: [] };
    expect(parseFinanzasXlsx(buildFinanzasXlsx(empty, { locale: EXCEL_LOCALES[lang], currentKey: '2027-02' }))).toEqual({
      months: [
        { key: '2027-02', closed: false, budget: 70000, incomeUSD: 0, accounts: { usd: 0, dop: 0 }, fixed: [], transfers: [], tx: [] },
      ],
      contribs: [],
      goals: [],
    });
  });
});

describe('random goal lists', () => {
  it('from 0 to 14 goals, with and without a plan and in any order, in the three languages: the same ones come back, in their order', () => {
    // Deterministic generator: the same lists on every run.
    let seed = 20261008;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 8) % n;
    };
    const monthAt = (n: number) => `${2025 + Math.floor(n / 12)}-${pad((n % 12) + 1)}`;
    const shapes = new Set<string>();
    for (let round = 0; round < 90; round++) {
      const goals = Array.from({ length: rnd(15) }, (_, i) => {
        const name = `Meta ${round}.${i}`;
        if (rnd(2)) return variable(name);
        const start = rnd(36);
        return planned(name, 25 + rnd(400000) / 100, monthAt(start), monthAt(start + rnd(40)));
      });
      shapes.add(goals.map((g) => (g.monthlyUSD === null ? 'v' : 'p')).join(''));
      const data: ExportData = {
        defaultRate: 58.76,
        months: [{ key: '2026-05', budget: 70000, incomeUSD: 5800, accounts: { usd: 1, dop: 2 }, fixed: [], transfers: [], tx: [] }],
        goals,
        contribs: goals.map((g, i) => ({ date: `2026-05-${pad((i % 28) + 1)}`, goalName: g.name, amount: 10 + i, cur: (i % 2 ? 'DOP' : 'USD') as Currency })),
      };
      const lang = LANGS[round % LANGS.length]!;
      const payload = parseFinanzasXlsx(buildFinanzasXlsx(data, { locale: EXCEL_LOCALES[lang] }));
      expect(normalize(payload), `${lang}: ${JSON.stringify(goals)}`).toEqual(expectedPayload(data));
    }
    // Checks that the randomness really gave variety (otherwise the test would prove nothing).
    expect(shapes.size).toBeGreaterThan(60);
  });
});

describe('goals that do not come back as they were sent', () => {
  it('an incomplete or inconsistent plan is exported, and comes back, as a goal with variable contributions', () => {
    const data: ExportData = {
      ...custom,
      contribs: [],
      goals: [
        { name: 'Aporte cero', monthlyUSD: 0, start: '2026-01', end: '2026-12' },
        { name: 'Fin antes del inicio', monthlyUSD: 100, start: '2027-01', end: '2026-12' },
        { name: 'Sin inicio', monthlyUSD: 100, start: null, end: '2026-12' },
        planned('Completo', 100, '2026-01', '2026-12'),
      ],
    };
    expect(parseFinanzasXlsx(buildFinanzasXlsx(data)).goals).toEqual([
      variable('Aporte cero'),
      variable('Fin antes del inicio'),
      variable('Sin inicio'),
      planned('Completo', 100, '2026-01', '2026-12'),
    ]);
  });

  it('a goal with no name has no card to read; two with the same name both come back', () => {
    const data: ExportData = {
      ...custom,
      contribs: [],
      goals: [variable('Repetida'), variable(''), planned('Repetida', 50, '2026-01', '2026-02'), variable('Repetida')],
    };
    expect(parseFinanzasXlsx(buildFinanzasXlsx(data)).goals).toEqual([
      variable('Repetida'),
      planned('Repetida', 50, '2026-01', '2026-02'),
      variable('Repetida'),
    ]);
  });
});

// ── The version 1 goals ──────────────────────────────────────────────────────

describe('the three goals of the version 1 workbook become the ones of today', () => {
  const legacy = asVersion1(custom);

  it('the app exporter, in Spanish and with those three goals, produces the old workbook: it reads the same', async () => {
    const bytes = buildFinanzasXlsx(legacy, { locale: EXCEL_LOCALES.es });
    expect(Buffer.from(bytes).equals(Buffer.from(await buildWithReference(legacy)))).toBe(true);
    expect(normalize(parseFinanzasXlsx(bytes))).toEqual(expectedPayload(custom));
  });

  it('only those three names are changed: a contribution to another goal keeps its own', () => {
    const { contribs, goals } = savings({
      B6: 'Fondo de emergencia', E6: 'Ahorro personal', I6: ' Viaje a Turquía ',
      J12: 3000, L12: serial('2026-08-01'), N12: serial('2027-10-01'),
      I15: 'Fecha', J15: 'Mes', K15: 'Meta', L15: 'Monto', M15: 'Moneda',
      I16: serial('2027-01-05'), K16: 'Viaje a Turquía', L16: 3000, M16: 'USD',
      I17: serial('2027-01-06'), K17: 'Fondo de emergencia ', L17: 400, M17: 'USD',
      I18: serial('2027-01-07'), K18: 'Ahorro personal', L18: 250, M18: 'DOP',
      I19: serial('2027-01-08'), K19: 'Fondo de emergencias', L19: 1, M19: 'USD',
      I20: serial('2027-01-09'), K20: 'Carro', L20: 2, M20: 'USD',
      I21: serial('2027-01-10'), L21: 3,
    });
    expect(goals).toEqual(TODAY_GOALS);
    expect(contribs!.map((c) => c.goalName)).toEqual([
      'Trip to Turkey',
      'Emergency fund',
      'Personal savings',
      'Fondo de emergencias',
      'Carro',
      // No goal: the personal savings one, as in the prototype.
      'Personal savings',
    ]);
  });

  it('in English or in Turkish it is not an old workbook: the user typed those names and they stay as they are', () => {
    const data: ExportData = { ...custom, goals: legacy.goals, contribs: legacy.contribs };
    for (const lang of ['en', 'tr'] as const) {
      const payload = parseFinanzasXlsx(buildFinanzasXlsx(data, { locale: EXCEL_LOCALES[lang] }));
      expect(normalize(payload), lang).toEqual(expectedPayload(data));
      expect(payload.goals!.map((g) => g.name), lang).toEqual(['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía']);
    }
  });

  it('in Spanish with one more goal, one fewer or in another order, it is not one either', () => {
    const [emergency, personal, trip] = legacy.goals as [ExportGoal, ExportGoal, ExportGoal];
    for (const goals of [[emergency, personal, trip, variable('Carro')], [emergency, trip], [personal, emergency, trip]]) {
      const data: ExportData = { ...custom, goals, contribs: legacy.contribs };
      const payload = parseFinanzasXlsx(buildFinanzasXlsx(data, { locale: EXCEL_LOCALES.es }));
      expect(normalize(payload)).toEqual(expectedPayload(data));
      expect(payload.contribs).toContainEqual({ date: '2025-12-15', goalName: 'Fondo de emergencia', amount: 15000, cur: 'DOP' });
    }
  });
});

// ── SpreadsheetML reader ─────────────────────────────────────────────────────

describe('SpreadsheetML reader', () => {
  it('cell types, entities, _xHHHH_ escapes, CDATA, prefixes and cells without r', () => {
    const sst =
      `${XML}<sst xmlns="${MAIN}" count="8" uniqueCount="8">` +
      '<si><t>Concepto</t></si>' + // 0
      '<si><r><rPr><b/><sz val="8"/></rPr><t>Descrip</t></r><r><t xml:space="preserve">ción</t></r><rPh sb="0" eb="2"><t>IGNORAR</t></rPh><phoneticPr fontId="1"/></si>' + // 1
      '<si><t>Fecha</t></si>' + // 2
      '<si/>' + // 3
      '<si><t xml:space="preserve">Caf&#233; &amp; t&#xE9; &lt;fr&#237;o&gt; &quot;x&quot; &apos;y&apos;</t></si>' + // 4
      '<si><t>l&#237;nea 1_x000D__x000A_l&#237;nea 2 _x005F_x0041_</t></si>' + // 5
      '<si><t><![CDATA[<b>R&D</b>]]></t></si>' + // 6
      '<si><t>S&#237;</t></si>' + // 7
      '</sst>';
    const sheet =
      `${XML}<x:worksheet xmlns:x="${MAIN}"><x:dimension ref="A1:K41"/><x:sheetData>` +
      '<x:row r="6" spans="1:20" ht="18" customHeight="1"><x:c r="O6" s="3"><x:v>45000</x:v></x:c></x:row>' +
      '<x:row r="8"><x:c r="C8"><x:v>1200.5</x:v></x:c></x:row>' +
      '<x:row r="15"><x:c r="C15" t="s"><x:v>0</x:v></x:c></x:row>' +
      '<x:row r="16">' +
      '<x:c r="B16" t="b"><x:v>1</x:v></x:c>' +
      '<x:c r="C16" t="inlineStr"><x:is><x:r><x:t>Lu</x:t></x:r><x:r><x:rPr><x:b/></x:rPr><x:t>z</x:t></x:r><x:rPh sb="0" eb="1"><x:t>ルス</x:t></x:rPh></x:is></x:c>' +
      '<x:c r="D16"><x:v>5</x:v></x:c>' +
      '<x:c r="E16" t="n"><x:v>1.5E3</x:v></x:c>' +
      '<x:c r="F16" t="str"><x:f>UPPER("usd")</x:f><x:v>USD</x:v></x:c>' +
      '</x:row>' +
      // Error and formula with no cached value: empty cells, so those rows have no amount.
      '<x:row r="17"><x:c r="C17" t="inlineStr"><x:is><x:t>Con error</x:t></x:is></x:c><x:c r="E17" t="e"><x:v>#DIV/0!</x:v></x:c></x:row>' +
      '<x:row r="18"><x:c r="C18" t="inlineStr"><x:is><x:t>Sin calcular</x:t></x:is></x:c><x:c r="E18"><x:f>1+1</x:f></x:c></x:row>' +
      '<x:row r="19"><x:c r="B19" t="s"><x:v>7</x:v></x:c><x:c r="C19" t="s"><x:v>4</x:v></x:c><x:c r="E19"><x:f>100*2</x:f><x:v>200</x:v></x:c><x:c r="F19" t="str"><x:f>""</x:f><x:v></x:v></x:c></x:row>' +
      '<x:row r="38"><x:c r="B38" t="s"><x:v>2</x:v></x:c><x:c r="C38" t="s"><x:v>1</x:v></x:c></x:row>' +
      // Cells without r: the order gives the position (A, B, C…).
      '<x:row r="39"><x:c/><x:c t="d"><x:v>2027-01-15T00:00:00Z</x:v></x:c><x:c t="s"><x:v>5</x:v></x:c><x:c t="s"><x:v>3</x:v></x:c><x:c s="4"/><x:c/><x:c><x:v>250</x:v></x:c></x:row>' +
      '<!-- <x:row r="40"><x:c r="C40" t="inlineStr"><x:is><x:t>Comentada</x:t></x:is></x:c></x:row> -->' +
      // Row without r: it is the one after 39.
      '<x:row><x:c/><x:c/><x:c t="s"><x:v>6</x:v></x:c><x:c/><x:c/><x:c/><x:c><x:v>10</x:v></x:c><x:c r="K40" t="inlineStr"><x:is><x:t xml:space="preserve"> nota </x:t></x:is></x:c></x:row>' +
      '</x:sheetData><x:mergeCells count="1"><x:mergeCell ref="B5:D5"/></x:mergeCells></x:worksheet>';
    const bytes = zip({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': ROOT_RELS,
      // Prefixes other than the usual ones, the month tab in second place and its part with an absolute path.
      'xl/workbook.xml': `${XML}<x:workbook xmlns:x="${MAIN}" xmlns:rel="${REL}"><x:workbookPr date1904="false"/><x:sheets><x:sheet name="Notas &amp; pendientes" sheetId="9" rel:id="rIdA"/><x:sheet name="Enero 2027" sheetId="4" rel:id="rIdB"/></x:sheets></x:workbook>`,
      'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="cadenas.xml"/><Relationship Id="rIdB" Type="${REL}/worksheet" Target="/xl/hojas/enero.xml"/><Relationship Id="rIdA" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/cadenas.xml': sst,
      'xl/hojas/enero.xml': sheet,
      // If the reader took sheet1.xml for the first month sheet, this fixed expense would show up in the result.
      'xl/worksheets/sheet1.xml': sheetXml({ C15: 'Concepto', C16: 'Trampa', E16: 999 }),
    });

    expect(parseFinanzasXlsx(bytes)).toEqual({
      months: [
        {
          key: '2027-01',
          closed: false,
          budget: 45000,
          incomeUSD: 0,
          accounts: { usd: 1200.5, dop: 0 },
          fixed: [
            { name: 'Luz', day: '5', amount: 1500, cur: 'USD', paid: true },
            { name: 'Café & té <frío> "x" \'y\'', day: '', amount: 200, cur: 'DOP', paid: true },
          ],
          transfers: [],
          tx: [
            { ...TX_DEFAULTS, date: '2027-01-15', desc: 'línea 1\r\nlínea 2 _x0041_', amount: 250 },
            { ...TX_DEFAULTS, date: '2027-01-01', desc: '<b>R&D</b>', amount: 10, notes: ' nota ' },
          ],
        },
      ],
      contribs: null,
      goals: null,
    });
  });

  it('the sheet is located through its relationships: workbook outside xl/, paths with ".." and different letter case', () => {
    const bytes = zip({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="/libro/wb.xml"/></Relationships>`,
      'libro/wb.xml': `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Febrero 2027" sheetId="1" r:id="rId2"/><sheet name="Marzo 2027" sheetId="2" r:id="rId9"/><sheet name="Enero 2027" sheetId="3" r:id="rId1"/></sheets></workbook>`,
      'libro/_rels/wb.xml.rels':
        `${XML}<Relationships xmlns="${PKG_REL}">` +
        // Relationship type of a "Strict Open XML" workbook.
        '<Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet" Target="hojas/h2.xml"/>' +
        `<Relationship Id="rId2" Type="${REL}/worksheet" Target="hojas/../hojas/./h1.xml"/>` +
        `<Relationship Id="rId9" Type="${REL}/chartsheet" Target="graficos/g1.xml"/>` +
        `<Relationship Id="rId10" Type="${REL}/hyperlink" Target="https://example.com/Abril%202027" TargetMode="External"/>` +
        '</Relationships>',
      'libro/Hojas/H1.xml': sheetXml({ O6: 222 }),
      'libro/hojas/h2.xml': sheetXml({ O6: 111 }),
      'libro/graficos/g1.xml': `${XML}<chartsheet xmlns="${MAIN}"/>`,
    });
    const payload = parseFinanzasXlsx(bytes);
    // "Marzo 2027" is a chart sheet: it has no cells and does not count as a month.
    expect(payload.months.map((m) => [m.key, m.budget, m.closed])).toEqual([
      ['2027-01', 111, true],
      ['2027-02', 222, false],
    ]);
  });

  it('parts with a BOM or encoded in UTF-16', () => {
    const bom = String.fromCharCode(0xfeff);
    const files = unzipSync(xlsx([['Enero 2027', sheetXml({ ...HEADERS, C39: 'Café ñ €', G39: 5 })]]));
    const workbook = strFromU8(files['xl/workbook.xml']!);
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    files['xl/workbook.xml'] = strToU8(bom + workbook);
    files['xl/worksheets/sheet1.xml'] = new Uint8Array(Buffer.from(bom + sheet.replace('UTF-8', 'UTF-16'), 'utf16le'));
    expect(parseFinanzasXlsx(zipSync(files)).months[0]!.tx).toEqual([
      { ...TX_DEFAULTS, date: '2027-01-01', desc: 'Café ñ €', amount: 5 },
    ]);
  });

  it('truncated XML: returns what was read up to there, does not hang or throw anything else', () => {
    const whole = sheetXml({ ...HEADERS, C39: 'Completa', G39: 1, C40: 'Incompleta', G40: 2 });
    for (const cut of [whole.indexOf('Incompleta') + 4, whole.indexOf('r="C40"') + 4, whole.indexOf('<row r="40"') + 2]) {
      const payload = parseFinanzasXlsx(xlsx([['Enero 2027', whole.slice(0, cut)]]));
      expect(payload.months[0]!.tx.map((t) => t.desc)[0]).toBe('Completa');
    }
  });
});

// ── What counts as a row and how it is normalized ────────────────────────────

describe('fixed monthly expenses', () => {
  it('a row counts if it has an item and a numeric amount', () => {
    const m = month({
      B16: 'Sí', C16: 'Luz', E16: 1337.15, F16: 'DOP',
      B17: 'SI', C17: 'Internet', D17: 5, E17: '2,699.00', F17: 'usd',
      B18: ' si ', C18: 'Gimnasio', D18: 'fin de mes', E18: 1550, F18: 'EUR',
      B19: 'No', C19: 'Netflix', E19: 0,
      C20: 'Sin monto',
      E21: 500,
      C22: '   ', E22: 10,
      C23: 'Monto de texto', E23: 'pendiente',
      B24: true, C24: 'Casilla marcada', D24: 17.5, E24: '-20',
      B25: 'sí, ya', C25: 2027, E25: 1,
      C37: 'Justo antes del historial', E37: 1,
    });
    expect(m.fixed).toEqual([
      { name: 'Luz', day: '', amount: 1337.15, cur: 'DOP', paid: true },
      { name: 'Internet', day: '5', amount: 2699, cur: 'USD', paid: true },
      { name: 'Gimnasio', day: 'fin de mes', amount: 1550, cur: 'DOP', paid: true },
      { name: 'Netflix', day: '', amount: 0, cur: 'DOP', paid: false },
      { name: 'Casilla marcada', day: '17.5', amount: -20, cur: 'DOP', paid: true },
      { name: '2027', day: '', amount: 1, cur: 'DOP', paid: false },
      { name: 'Justo antes del historial', day: '', amount: 1, cur: 'DOP', paid: false },
    ]);
    expect(m.tx).toEqual([]);
    expect(m.transfers).toEqual([]);
  });

  it('paid is "yes" in any of the three languages; everything else is a no', () => {
    const values: [TestCell, boolean][] = [
      ['Sí', true], ['Yes', true], ['Evet', true], ['YES', true], [' evet ', true], ['EVET', true], ['sí', true], [true, true],
      ['No', false], ['Hayır', false], ['Yes!', false], ['Y', false], ['Evet değil', false], ['Pagado', false], [1, false], [false, false],
    ];
    const cells: Record<string, TestCell> = {};
    values.forEach(([v], i) => Object.assign(cells, { [`B${16 + i}`]: v, [`C${16 + i}`]: `Gasto ${i}`, [`E${16 + i}`]: 1 }));
    expect(month(cells).fixed.map((f) => f.paid)).toEqual(values.map(([, paid]) => paid));
  });

  it('an expense named like the table header, in any language, is an expense', () => {
    const m = month({ C16: 'Item', E16: 5, C17: 'Concepto', E17: 6, C18: 'Kalem', E18: 7, C19: 'Luz', E19: 8 });
    expect(m.fixed.map((f) => f.name)).toEqual(['Item', 'Concepto', 'Kalem', 'Luz']);
  });
});

describe('transfers', () => {
  it('a row counts if it has USD; date, via and rate have a default value', () => {
    const m = month({
      M30: serial('2027-01-03'), N30: 'PayPal', O30: 1500, P30: 58.4,
      M31: '18/01/2027', O31: 300,
      N32: 'PayPal', P32: 57,
      M34: 'ayer', N34: 'Western Union', O34: '1,000', P34: '57.10',
      // The via is free text: any name is valid, exactly as written.
      M35: serial('2027-01-20'), N35: ' La tía Carmen (en efectivo) ', O35: 20, P35: 60,
    });
    expect(m.transfers).toEqual([
      { date: '2027-01-03', via: 'PayPal', usd: 1500, rate: 58.4 },
      { date: '2027-01-18', via: 'Remitly', usd: 300, rate: 0 },
      { date: '2027-01-01', via: 'Western Union', usd: 1000, rate: 57.1 },
      { date: '2027-01-20', via: ' La tía Carmen (en efectivo) ', usd: 20, rate: 60 },
    ]);
  });

  it('reads more than 80 consecutive transfers, but not whatever comes after 80 empty rows', () => {
    const cells: Record<string, TestCell> = {};
    for (let i = 0; i < 100; i++) cells[`O${30 + i}`] = i + 1;
    cells.O300 = 9999;
    const m = month(cells);
    expect(m.transfers.map((t) => t.usd)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });
});

describe('transaction history', () => {
  it('a row counts if it has a description or a numeric amount; empty ones are not records', () => {
    const m = month({
      B39: serial('2027-01-02'), C39: 'Compra semanal', D39: 'Jumbo', E39: 'Supermercado', F39: 'App del banco', G39: 4680, H39: 'DOP', K39: 'con nota',
      // 40: blank.
      B41: serial('2027-01-03'),
      E42: 'Comida', F42: 'Tarjeta', H42: 'DOP', K42: 'solo listas y nota',
      C43: 'Solo descripción',
      G44: 99.9,
      C45: '   ', G45: 'n/a',
      B46: '2027-01-20', C46: 'Fecha ISO como texto', G46: '1,250.50', H46: 'usd',
      B47: '32/01/2027', C47: 'Fecha imposible', G47: 5, H47: 'EUR',
      B48: 0, C48: 'Serial cero', G48: 0,
      B49: '7/1/2027', C49: 7, D49: 8, G49: 9,
      // Table formulas with an empty result, as Excel leaves them in unused rows.
      I50: { raw: '<c r="I50" t="str"><f>IF(G50="","",G50)</f><v></v></c>' },
      J50: { raw: '<c r="J50" t="str"><f>IF(I50="","",I50/58.76)</f><v/></c>' },
    });
    expect(m.tx).toEqual([
      { date: '2027-01-02', desc: 'Compra semanal', place: 'Jumbo', cat: 'Groceries', method: 'Bank app', amount: 4680, cur: 'DOP', notes: 'con nota' },
      // No category or method: Food and Debit card, the same default values as when recording an expense.
      { ...TX_DEFAULTS, date: '2027-01-01', desc: 'Solo descripción', amount: 0 },
      { ...TX_DEFAULTS, date: '2027-01-01', desc: '', amount: 99.9 },
      { ...TX_DEFAULTS, date: '2027-01-20', desc: 'Fecha ISO como texto', amount: 1250.5, cur: 'USD' },
      { ...TX_DEFAULTS, date: '2027-01-01', desc: 'Fecha imposible', amount: 5 },
      { ...TX_DEFAULTS, date: '2027-01-01', desc: 'Serial cero', amount: 0 },
      { ...TX_DEFAULTS, date: '2027-01-07', desc: '7', place: '8', amount: 9 },
    ]);
  });

  it('category and method: canonical name if it is from the list in any language; otherwise, as written', () => {
    const rows: [cat: TestCell, method: TestCell, expected: [string, string]][] = [
      // The single card of the old workbooks (and of the Config sheet's list) is today's debit card.
      ['Comida', 'Tarjeta', ['Food', 'Debit card']],
      ['Yemek', 'Kart', ['Food', 'Debit card']],
      ['Food', 'Card', ['Food', 'Debit card']],
      ['Comida', 'Tarjeta de débito', ['Food', 'Debit card']],
      ['Yemek', 'Banka kartı', ['Food', 'Debit card']],
      ['Food', 'Debit card', ['Food', 'Debit card']],
      ['Ropa', 'Tarjeta de crédito', ['Clothing', 'Credit card']],
      ['Giyim', 'Kredi kartı', ['Clothing', 'Credit card']],
      ['Clothing', 'credit card', ['Clothing', 'Credit card']],
      ['Hogar', 'Efectivo', ['Home', 'Cash']],
      ['Ev', 'Nakit', ['Home', 'Cash']],
      ['Home', 'cash', ['Home', 'Cash']],
      ['Supermercado', 'Transferencia', ['Groceries', 'Transfer']],
      ['Market', 'Havale', ['Groceries', 'Transfer']],
      ['Ulaşım', 'Banka uygulaması', ['Transport', 'Bank app']],
      ['Educación', 'App del banco', ['Education', 'Bank app']],
      ['Eğitim', 'Bank app', ['Education', 'Bank app']],
      // Upper case and extra spaces do not change what it is.
      [' viajes ', 'TARJETA', ['Travel', 'Debit card']],
      ['SEYAHAT', ' kart', ['Travel', 'Debit card']],
      // Neither do missing accents.
      ['Viajes', 'tarjeta de credito', ['Travel', 'Credit card']],
      ['Seyahat', 'KREDİ KARTI', ['Travel', 'Credit card']],
      // Outside the lists: user text.
      ['Mascotas', 'Cheque', ['Mascotas', 'Cheque']],
      ['Comida rápida', 'Tarjeta de regalo', ['Comida rápida', 'Tarjeta de regalo']],
      ['Evcil hayvan', 'Çek', ['Evcil hayvan', 'Çek']],
      [2027, true, ['2027', 'TRUE']],
    ];
    const cells: Record<string, TestCell> = {};
    rows.forEach(([cat, method], i) => Object.assign(cells, { [`C${39 + i}`]: `Fila ${i}`, [`E${39 + i}`]: cat, [`F${39 + i}`]: method, [`G${39 + i}`]: 1 }));
    expect(month(cells).tx.map((t) => [t.cat, t.method])).toEqual(rows.map(([, , expected]) => expected));
  });

  it('continues after 39 blank rows and ends after 40', () => {
    const m = month({
      C39: 'Primera', G39: 1,
      // 40..78 blank (39 rows).
      C79: 'Tras 39 filas en blanco', G79: 2,
      // 80..119 blank (40 rows).
      C120: 'Tras 40 filas en blanco', G120: 3,
    });
    expect(m.tx.map((t) => t.desc)).toEqual(['Primera', 'Tras 39 filas en blanco']);
  });

  it('dates in the 1904 system', () => {
    const m = month(
      { B39: serial('2027-01-15') - 1462, C39: 'Mac antiguo', G39: 1, M30: serial('2027-01-09') - 1462, O30: 100, P30: 58 },
      { date1904: true },
    );
    expect(m.tx[0]!.date).toBe('2027-01-15');
    expect(m.transfers[0]!.date).toBe('2027-01-09');
  });
});

describe('structure of the month sheet', () => {
  it('without headers it uses the rows of the original design (15, 29 and 38)', () => {
    const m = parseFinanzasXlsx(
      xlsx([['Enero 2027', sheetXml({ C16: 'Luz', E16: 10, O30: 100, P30: 58, C39: 'Compra', G39: 20, C8: 1, C9: 2, C10: 3, O6: 4 })]]),
    ).months[0]!;
    expect(m.fixed.map((f) => f.name)).toEqual(['Luz']);
    expect(m.transfers.map((t) => t.usd)).toEqual([100]);
    expect(m.tx.map((t) => t.desc)).toEqual(['Compra']);
    expect([m.accounts.usd, m.accounts.dop, m.incomeUSD, m.budget]).toEqual([1, 2, 3, 4]);
  });

  it('finds the tables even when they are shifted', () => {
    const m = parseFinanzasXlsx(
      xlsx([
        [
          'Enero 2027',
          sheetXml({
            // Above the "Concepto" header there are no fixed expenses, even if they look like valid rows.
            C16: 'No es un fijo', E16: 1,
            C20: ' Concepto ', C21: 'Luz', E21: 10, C59: 'Internet', E59: 20,
            M35: 'Fecha', N35: 'Vía', O30: 555, O36: 100, P36: 58,
            B60: 'Fecha', C60: 'Descripción', C39: 'No es una transacción', G39: 1, C61: 'Compra', G61: 30,
          }),
        ],
      ]),
    ).months[0]!;
    expect(m.fixed.map((f) => f.name)).toEqual(['Luz', 'Internet']);
    expect(m.transfers.map((t) => t.usd)).toEqual([100]);
    expect(m.tx.map((t) => t.desc)).toEqual(['Compra']);
  });

  it('summary cells empty or with text: budget 70,000 and the rest at zero', () => {
    const m = month({ O6: 'n/d', C8: '4,320.50', C9: true });
    expect(m).toMatchObject({ budget: 70000, incomeUSD: 0, accounts: { usd: 4320.5, dop: 0 } });
  });

  it('months sorted by key, closed except the last one; the other sheets are ignored', () => {
    const payload = parseFinanzasXlsx(
      xlsx([
        ['Resumen', sheetXml({ C15: 'Concepto', C16: 'Trampa', E16: 1 })],
        ['Febrero 2027', sheetXml({ O6: 2 })],
        ['Diciembre 2026', sheetXml({ O6: 12 })],
        ['Config', sheetXml({ C4: 58.76 })],
        ['Enero 2027', sheetXml({ O6: 1 })],
        ['Enero', sheetXml({ O6: 99 })],
        ['Smarch 2027', sheetXml({ O6: 99 })],
        ['Octubre 2026 (2)', sheetXml({ O6: 99 })],
        // Same month as an earlier sheet: the last one wins.
        ['Diciembre  2026', sheetXml({ O6: 1212 })],
      ]),
    );
    expect(payload.months.map((m) => [m.key, m.budget, m.closed])).toEqual([
      ['2026-12', 1212, true],
      ['2027-01', 1, true],
      ['2027-02', 2, false],
    ]);
    // Without a savings sheet the contributions and the goals are left untouched.
    expect(payload.contribs).toBeNull();
    expect(payload.goals).toBeNull();
  });
});

// ── The three languages, in hand-written workbooks ───────────────────────────
// The texts go here as literals, not taken from locale-*.ts: they are the ones inside the workbooks already
// exported. If one is ever changed in the exporter, this test warns that the earlier workbooks would no
// longer be recognized (and then the importer would have to keep accepting the old text).

const WORDS: Record<Language, {
  month: string; savings: string; yes: string; no: string;
  item: string; date: string; via: string; description: string; goal: string;
  groceries: string; travel: string; bankApp: string; transfer: string;
}> = {
  en: {
    month: 'January 2027', savings: 'Savings', yes: 'Yes', no: 'No',
    item: 'Item', date: 'Date', via: 'Via', description: 'Description', goal: 'Goal',
    groceries: 'Groceries', travel: 'Travel', bankApp: 'Bank app', transfer: 'Transfer',
  },
  es: {
    month: 'Enero 2027', savings: 'Ahorros', yes: 'Sí', no: 'No',
    item: 'Concepto', date: 'Fecha', via: 'Vía', description: 'Descripción', goal: 'Meta',
    groceries: 'Supermercado', travel: 'Viajes', bankApp: 'App del banco', transfer: 'Transferencia',
  },
  tr: {
    month: 'Ocak 2027', savings: 'Birikimler', yes: 'Evet', no: 'Hayır',
    item: 'Kalem', date: 'Tarih', via: 'Kanal', description: 'Açıklama', goal: 'Hedef',
    groceries: 'Market', travel: 'Seyahat', bankApp: 'Banka uygulaması', transfer: 'Havale',
  },
};

/**
 * Month sheet with the three tables out of place (they are only found by their headers), each table with
 * the texts of the language passed for it.
 */
function shiftedMonth(fixed: Language, transfers: Language, tx: Language): Record<string, TestCell> {
  const [f, e, t] = [WORDS[fixed], WORDS[transfers], WORDS[tx]];
  return {
    O6: 50000, C8: 100, C9: 200, C10: 300,
    C16: 'Encima del encabezado', E16: 1,
    C20: f.item,
    B21: f.yes, C21: 'Rent', D21: 1, E21: 800, F21: 'USD',
    B22: f.no, C22: 'Gym', E22: 1500, F22: 'DOP',
    O30: 999,
    M45: e.date, N45: e.via,
    M46: serial('2027-01-04'), N46: 'Wise', O46: 500, P46: 59.5,
    C39: 'Encima del historial', G39: 1,
    B60: t.date, C60: t.description,
    B61: serial('2027-01-05'), C61: 'Weekly shop', D61: 'Jumbo', E61: t.groceries, F61: t.bankApp, G61: 4680, H61: 'DOP', K61: 'note',
    B62: serial('2027-01-06'), C62: 'Flight', E62: t.travel, F62: t.transfer, G62: 320.5, H62: 'USD',
  };
}

/** Savings sheet with three goal bands and the contributions table on row 31, with the texts of that language. */
function shiftedSavings(lang: Language): Record<string, TestCell> {
  const w = WORDS[lang];
  return {
    // Band 0: two goals with no plan and one with a plan. Band 1: only one with a plan. Band 2: only one with no plan.
    B6: 'Emergency', E6: 'Personal', I6: 'Trip', J12: 3000, L12: serial('2026-08-01'), N12: serial('2027-10-01'),
    I14: 'Car', J20: 450.5, L20: '01/2027', N20: '2027-06',
    B22: 'Gifts',
    I31: w.date, K31: w.goal,
    I32: serial('2027-01-05'), K32: 'Trip', L32: 3000, M32: 'USD',
    I33: serial('2027-01-06'), K33: 'Gifts', L33: 1500, M33: 'DOP',
    // No date, no goal and no currency.
    L34: 20,
  };
}

const SHIFTED_MONTH: Omit<ImportMonth, 'key' | 'closed'> = {
  budget: 50000,
  incomeUSD: 300,
  accounts: { usd: 100, dop: 200 },
  fixed: [
    { name: 'Rent', day: '1', amount: 800, cur: 'USD', paid: true },
    { name: 'Gym', day: '', amount: 1500, cur: 'DOP', paid: false },
  ],
  transfers: [{ date: '2027-01-04', via: 'Wise', usd: 500, rate: 59.5 }],
  tx: [
    { date: '2027-01-05', desc: 'Weekly shop', place: 'Jumbo', cat: 'Groceries', method: 'Bank app', amount: 4680, cur: 'DOP', notes: 'note' },
    { date: '2027-01-06', desc: 'Flight', place: '', cat: 'Travel', method: 'Transfer', amount: 320.5, cur: 'USD', notes: '' },
  ],
};
const SHIFTED_GOALS: ImportGoal[] = [
  variable('Emergency'),
  variable('Personal'),
  planned('Trip', 3000, '2026-08', '2027-10'),
  planned('Car', 450.5, '2027-01', '2027-06'),
  variable('Gifts'),
];
const SHIFTED_CONTRIBS: Contrib[] = [
  { date: '2027-01-05', goalName: 'Trip', amount: 3000, cur: 'USD' },
  { date: '2027-01-06', goalName: 'Gifts', amount: 1500, cur: 'DOP' },
  { date: '2027-01-01', goalName: 'Personal savings', amount: 20, cur: 'USD' },
];

describe('workbooks in the three languages', () => {
  it.each(LANGS)('workbook in "%s": sheets, headers, paid, categories and methods are recognized and the result is the same', (lang) => {
    const w = WORDS[lang];
    const payload = parseFinanzasXlsx(
      xlsx([
        [w.month, sheetXml(shiftedMonth(lang, lang, lang))],
        [w.savings, sheetXml(shiftedSavings(lang))],
        ['Config', configXml(['Trip', 'Emergency', 'Personal', 'Car', 'Gifts'])],
      ]),
    );
    expect(payload).toEqual({
      months: [{ key: '2027-01', closed: false, ...SHIFTED_MONTH }],
      contribs: SHIFTED_CONTRIBS,
      // The order is that of the Config list, not that of the cards.
      goals: [SHIFTED_GOALS[2], SHIFTED_GOALS[0], SHIFTED_GOALS[1], SHIFTED_GOALS[3], SHIFTED_GOALS[4]],
    });
  });

  it('a workbook that mixes languages (sheets, tables and values from each) reads the same', () => {
    const payload = parseFinanzasXlsx(
      xlsx([
        // Each month sheet with its name in one language and each table with the headers of another.
        ['Ocak 2027', sheetXml(shiftedMonth('es', 'en', 'tr'))],
        ['Febrero 2027', sheetXml(shiftedMonth('en', 'tr', 'es'))],
        ['March 2027', sheetXml(shiftedMonth('tr', 'es', 'en'))],
        ['Savings', sheetXml(shiftedSavings('tr'))],
      ]),
    );
    expect(payload).toEqual({
      months: [
        { key: '2027-01', closed: true, ...SHIFTED_MONTH },
        { key: '2027-02', closed: true, ...SHIFTED_MONTH },
        { key: '2027-03', closed: false, ...SHIFTED_MONTH },
      ],
      // The contribution with no date goes to the first day of the last month.
      contribs: [SHIFTED_CONTRIBS[0], SHIFTED_CONTRIBS[1], { ...SHIFTED_CONTRIBS[2], date: '2027-03-01' }],
      // Without a Config sheet, the goals go in the order of the cards.
      goals: SHIFTED_GOALS,
    });
  });

  it('a workbook exported in Turkish whose sheets are renamed into other languages reads the same', () => {
    const data = withGoals(GOAL_LISTS['ocho mezcladas']!);
    const files = unzipSync(buildFinanzasXlsx(data, { locale: EXCEL_LOCALES.tr }));
    const workbook = strFromU8(files['xl/workbook.xml']!);
    const renamed = workbook
      .replace('name="Aralık 2025"', 'name="Diciembre 2025"')
      .replace('name="Ocak 2026"', 'name="January 2026"')
      .replace('name="Birikimler"', 'name="Ahorros"');
    expect(renamed).not.toBe(workbook);
    expect(renamed).not.toMatch(/Aralık|Ocak|Birikimler/);
    files['xl/workbook.xml'] = strToU8(renamed);
    expect(normalize(parseFinanzasXlsx(zipSync(files)))).toEqual(expectedPayload(data));
  });

  it('the same month in two languages: the last sheet wins; with two savings sheets, too', () => {
    const payload = parseFinanzasXlsx(
      xlsx([
        ['Octubre 2026', sheetXml({ O6: 1 })],
        ['Ahorros', sheetXml({ B6: 'Primera' })],
        ['Ekim 2026', sheetXml({ O6: 2 })],
        ['October 2026', sheetXml({ O6: 3 })],
        ['Birikimler', sheetXml({ B6: 'Última' })],
      ]),
    );
    expect(payload.months.map((m) => [m.key, m.budget])).toEqual([['2026-10', 3]]);
    expect(payload.goals).toEqual([variable('Última')]);
  });

  it('sheet names that do not belong to the app in any language do not count', () => {
    const payload = parseFinanzasXlsx(
      xlsx([
        ['Ekim 2026', sheetXml({ O6: 10 })],
        ['Oktober 2026', sheetXml({ O6: 99 })],
        ['ekim 2026', sheetXml({ O6: 99 })],
        ['Ahorro', sheetXml({ B6: 'No es la hoja de ahorros' })],
        ['Saving', sheetXml({ B6: 'Tampoco' })],
      ]),
    );
    expect(payload.months.map((m) => [m.key, m.budget])).toEqual([['2026-10', 10]]);
    expect(payload.contribs).toBeNull();
    expect(payload.goals).toBeNull();
  });
});

// ── Savings sheet ────────────────────────────────────────────────────────────

describe('savings sheet', () => {
  it('contributions: a row with an amount counts; the goal goes exactly as written', () => {
    const { contribs, goals } = savings({
      I6: 'Viaje largo', J12: 2500, L12: serial('2026-08-01'), N12: '10/2027',
      I15: 'Fecha', J15: 'Mes', K15: 'Meta', L15: 'Monto', M15: 'Moneda',
      I16: serial('2027-01-05'), K16: 'Viaje a Turquía', L16: 3000, M16: 'USD',
      I17: '06/01/2027', K17: 'Meta nueva & rara', L17: '15,000', M17: 'dop',
      I18: serial('2027-01-07'), K18: 'Sin monto',
      L19: 250,
      I20: serial('2027-01-08'), K20: 'Fondo de emergencia', L20: 40, M20: 'EUR',
      // 21..59 blank (39 rows).
      I60: serial('2027-01-09'), K60: 'Ahorro personal', L60: 10,
      // 61..100 blank (40 rows): end of the table.
      L101: 5,
    });
    expect(contribs).toEqual([
      // It is not the version 1 workbook (its cards are different): these names are not changed.
      { date: '2027-01-05', goalName: 'Viaje a Turquía', amount: 3000, cur: 'USD' },
      { date: '2027-01-06', goalName: 'Meta nueva & rara', amount: 15000, cur: 'DOP' },
      // No date → first day of the last month; no goal → "Personal savings"; no currency → USD.
      { date: '2027-01-01', goalName: 'Personal savings', amount: 250, cur: 'USD' },
      { date: '2027-01-08', goalName: 'Fondo de emergencia', amount: 40, cur: 'DOP' },
      { date: '2027-01-09', goalName: 'Ahorro personal', amount: 10, cur: 'USD' },
    ]);
    expect(goals).toEqual([planned('Viaje largo', 2500, '2026-08', '2027-10')]);
  });

  it('goal with a plan: if its data cannot be read or does not form a plan, it ends up as one with variable contributions', () => {
    const goal = (cells: Record<string, TestCell>) => savings({ I6: 'Viaje', ...cells }).goals;
    expect(goal({ J12: '3,000', L12: '08/2026', N12: serial('2027-10-15') })).toEqual([planned('Viaje', 3000, '2026-08', '2027-10')]);
    expect(goal({ J12: 0.5, L12: '2026-08-01', N12: '2026-08' })).toEqual([planned('Viaje', 0.5, '2026-08', '2026-08')]);
    const unreadable: Record<string, TestCell>[] = [
      {},
      { J12: 3000 },
      { L12: serial('2026-08-01'), N12: serial('2027-10-01') },
      { J12: 0, L12: serial('2026-08-01'), N12: serial('2027-10-01') },
      { J12: -100, L12: serial('2026-08-01'), N12: serial('2027-10-01') },
      { J12: 'mucho', L12: serial('2026-08-01'), N12: serial('2027-10-01') },
      { J12: 3000, L12: '2026-08-01', N12: 'algún día' },
      { J12: 3000, L12: '13/2026', N12: serial('2027-10-01') },
      { J12: 3000, L12: serial('2026-08-01') },
      // The end before the start.
      { J12: 3000, L12: serial('2027-10-01'), N12: serial('2026-08-01') },
      { J12: { raw: '<c r="J12" t="e"><v>#REF!</v></c>' }, L12: serial('2026-08-01'), N12: serial('2027-10-01') },
    ];
    for (const cells of unreadable) expect(goal(cells), JSON.stringify(cells)).toEqual([variable('Viaje')]);
  });

  it('a card with no name is not a goal; a sheet with no cards has no goals', () => {
    expect(savings({ J12: 3000, L12: serial('2026-08-01'), N12: serial('2027-10-01'), B7: 'Aportes variables', B8: 120 })).toEqual({
      contribs: [],
      goals: [],
    });
    expect(savings({ B1: 'Finanzas personales' })).toEqual({ contribs: [], goals: [] });
    expect(savings({ B6: '   ', E6: 2027, I6: true }).goals).toEqual([variable('2027'), variable('TRUE')]);
  });

  it('goals with a plan are only in the wide slot: no plan data is read in the narrow ones', () => {
    const { goals } = savings({ B6: 'Sin plan', B12: 3000, D12: serial('2026-08-01'), J12: 3000, L12: serial('2026-08-01'), N12: serial('2027-10-01') });
    expect(goals).toEqual([variable('Sin plan')]);
  });

  it('several bands: the contributions table is located by its header and the cards are read band by band', () => {
    const cells = shiftedSavings('en');
    expect(savings(cells, { sheet: 'Savings' })).toEqual({ contribs: SHIFTED_CONTRIBS, goals: SHIFTED_GOALS });

    // Anything below the last band is not a card, even if it falls where the next band would go.
    expect(savings({ ...cells, B30: 'Income by month', I30: 'Contributions', B38: 'March 2027', I38: 46000 }, { sheet: 'Savings' }).goals).toEqual(SHIFTED_GOALS);
  });

  it('without the contributions header the original layout applies: one band and contributions from row 16', () => {
    const { contribs, goals } = savings({
      B6: 'Emergency', I6: 'Trip', J12: 100, L12: serial('2027-01-01'), N12: serial('2027-12-01'),
      // It would look like a second band, but without a header there is no way to know.
      B14: 'No es una tarjeta',
      I16: serial('2027-01-05'), K16: 'Trip', L16: 100, M16: 'USD',
    });
    expect(goals).toEqual([variable('Emergency'), planned('Trip', 100, '2027-01', '2027-12')]);
    expect(contribs).toEqual([{ date: '2027-01-05', goalName: 'Trip', amount: 100, cur: 'USD' }]);
  });

  it('the contributions header is "date" in I and "goal" in K at the same time; a card named like that is not a header', () => {
    const { contribs, goals } = savings({
      I6: 'Fecha', J12: 10, L12: serial('2027-01-01'), N12: serial('2027-02-01'),
      B14: 'Meta', I14: 'Date', K14: 'Otra cosa',
      I23: 'Date', K23: 'Hedef',
      I24: serial('2027-01-05'), K24: 'Fecha', L24: 7,
    });
    expect(goals).toEqual([planned('Fecha', 10, '2027-01', '2027-02'), variable('Meta'), variable('Date')]);
    expect(contribs).toEqual([{ date: '2027-01-05', goalName: 'Fecha', amount: 7, cur: 'USD' }]);
  });

  it('goal order: that of the Config list; the ones it does not name, at the end; a name without a card is not a goal', () => {
    const cells: Record<string, TestCell> = {
      B6: 'A', E6: 'B', I6: 'C', J12: 1, L12: serial('2027-01-01'), N12: serial('2027-01-01'),
      B14: 'D', E14: 'A', I14: 'E', J20: 2, L20: serial('2027-01-01'), N20: serial('2027-03-01'),
      I23: 'Fecha', K23: 'Meta',
    };
    const names = (config?: string[]) => savings(cells, { config }).goals!.map((g) => `${g.name}${g.monthlyUSD ?? ''}`);
    // Without Config (or with the list empty): band by band; in each one, the two narrow slots and then the wide one.
    expect(names()).toEqual(['A', 'B', 'C1', 'D', 'A', 'E2']);
    expect(names([])).toEqual(['A', 'B', 'C1', 'D', 'A', 'E2']);
    expect(names(['E', 'C', 'D', 'B', 'A', 'A'])).toEqual(['E2', 'C1', 'D', 'B', 'A', 'A']);
    // With extra spaces in the list, a name that has no card and two cards the list does not name.
    expect(names([' C ', 'Sin tarjeta', 'A', 'E'])).toEqual(['C1', 'A', 'E2', 'B', 'D', 'A']);
  });
});

// ── LibreOffice ──────────────────────────────────────────────────────────────

/** The sample months with eight goals in four bands: the workbook of the fixture below. */
function bandsData(): ExportData {
  const goals = GOAL_LISTS['ocho mezcladas']!;
  return {
    ...frozenExportData('en'),
    goals,
    contribs: [...goals.map((g) => g.name), 'Sin tarjeta'].flatMap((goalName, i) => [
      { date: `2026-08-${pad(i + 1)}`, goalName, amount: 100 + i, cur: 'USD' as Currency },
      { date: `2026-10-${pad(28 - i)}`, goalName, amount: 2500.5 + i, cur: 'DOP' as Currency },
    ]),
  };
}

const BANDS_FIXTURE = new URL('./import-libreoffice-bands.fixture.xlsx', import.meta.url);

describe('app workbook saved by LibreOffice', () => {
  // import-libreoffice-bands.fixture.xlsx is `bandsData()` exported in Turkish, then opened, recalculated and saved
  // by LibreOffice. To regenerate it if the exporter changes (needs soffice on the PATH or in SOFFICE):
  //   UPDATE_IMPORT_FIXTURES=1 npx vitest run shared/excel/import.test.ts
  // Without that variable this step is not even registered: it is not a test.
  if (process.env.UPDATE_IMPORT_FIXTURES) {
    it('regenerates the fixture', () => {
      const dir = mkdtempSync(join(tmpdir(), 'fe-finance-import-'));
      try {
        const source = join(dir, 'bands.xlsx');
        writeFileSync(source, buildFinanzasXlsx(bandsData(), { locale: EXCEL_LOCALES.tr }));
        const out = join(dir, 'out');
        execFileSync(
          process.env.SOFFICE ?? 'soffice',
          // Its own profile (does not touch the user's); no windows or ports.
          ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--convert-to', 'xlsx', '--outdir', out, source],
          { stdio: 'pipe', timeout: 150_000 },
        );
        writeFileSync(fileURLToPath(BANDS_FIXTURE), readFileSync(join(out, 'bands.xlsx')));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);
  }

  it('in Turkish and with four goal bands: reads the same as the freshly exported workbook', () => {
    expect(existsSync(BANDS_FIXTURE)).toBe(true);
    const saved = new Uint8Array(readFileSync(BANDS_FIXTURE));
    const data = bandsData();

    // Checks the premise: it is what LibreOffice saves (compressed and with the formulas already calculated), the
    // workbook is in Turkish and the contributions table is 24 rows lower than in the original design.
    expect(zipMethod(saved)).toBe(8);
    const files = unzipSync(saved);
    const workbook = strFromU8(files['xl/workbook.xml']!);
    for (const name of ['Ağustos 2026', 'Eylül 2026', 'Ekim 2026', 'Birikimler']) expect(workbook, name).toContain(`name="${name}"`);
    const sheets = Object.keys(files).filter((path) => /^xl\/worksheets\/[^/]+\.xml$/.test(path));
    expect(sheets.some((path) => /<f[ >][^]*?<\/f><v>[^<]+<\/v>/.test(strFromU8(files[path]!)))).toBe(true);

    const payload = parseFinanzasXlsx(saved);
    expect(normalize(payload)).toEqual(expectedPayload(data));
    expect(payload).toEqual(parseFinanzasXlsx(buildFinanzasXlsx(data, { locale: EXCEL_LOCALES.tr })));
    expect(payload.goals!.map((g) => g.name)).toEqual(GOAL_LISTS['ocho mezcladas']!.map((g) => g.name));
    expect(payload.contribs).toHaveLength(18);
  });
});

// ── Invalid files ────────────────────────────────────────────────────────────

describe('invalid files', () => {
  it('bytes that are not a zip → ImportError not_xlsx', () => {
    let seed = 42;
    const noise = Uint8Array.from({ length: 5000 }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16);
    const ref = reference('Finanzas Personales v3.xlsx');
    const cases: Record<string, Uint8Array> = {
      vacío: new Uint8Array(0),
      texto: strToU8('fecha,descripción,monto\n2026-10-01,Café,385\n'),
      ruido: noise,
      'empieza como un zip': strToU8('PK\u0003\u0004' + 'no soy un zip de verdad '.repeat(40)),
      'xlsx cortado por la mitad': ref.subarray(0, ref.length >> 1),
      'xlsx sin el principio': ref.subarray(1000),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      const error = importError(() => parseFinanzasXlsx(bytes));
      expect(error.code, name).toBe('not_xlsx');
      // Depending on where it breaks: it cannot be opened as a zip, or it opens but there is no workbook inside.
      expect(['The file is not a valid .xlsx.', 'The file is not an Excel workbook (.xlsx).'], name).toContain(error.message);
    }
    expect(importError(() => parseFinanzasXlsx(cases.texto!)).message).toBe('The file is not a valid .xlsx.');
  });

  it('old .xls or password-protected .xlsx (OLE container) → ImportError that explains it', () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const error = importError(() => parseFinanzasXlsx(ole));
    expect(error.code).toBe('old_format');
    expect(error.message).toMatch(/old \.xls or is password-protected/);
  });

  it('a zip that is not a workbook → ImportError not_xlsx', () => {
    for (const bytes of [zip({ 'hola.txt': 'hola' }), zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': '<x/>' })]) {
      const error = importError(() => parseFinanzasXlsx(bytes));
      expect(error.code).toBe('not_xlsx');
      expect(error.message).toBe('The file is not an Excel workbook (.xlsx).');
    }
  });

  it('a valid workbook with no month sheets, in any language → ImportError no_month_sheets', () => {
    const books = [
      xlsx([['Hoja1', sheetXml({ A1: 'hola' })], ['Ahorros', sheetXml({ L16: 100 })]]),
      xlsx([['Savings', sheetXml({ B6: 'Goal' })], ['Config', configXml(['Goal'])], ['Oktober 2026', sheetXml({ O6: 1 })]]),
      xlsx([['Sheet1', sheetXml({})]]),
    ];
    for (const bytes of books) {
      const error = importError(() => parseFinanzasXlsx(bytes));
      expect(error.code).toBe('no_month_sheets');
      expect(error.message).toBe('The file is not in the FE Finance format: it has no month sheets.');
    }
  });

  it('a sheet that declares a huge uncompressed size → ImportError too_large without ever inflating it', () => {
    const bytes = xlsx([['Enero 2027', sheetXml(HEADERS)]]);
    // Uncompressed size (offset 24) in the sheet's central directory entry.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let patched = 0;
    for (let i = 0; i + 46 <= bytes.length; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const name = strFromU8(bytes.subarray(i + 46, i + 46 + view.getUint16(i + 28, true)));
      if (name !== 'xl/worksheets/sheet1.xml') continue;
      view.setUint32(i + 24, 0x7fffffff, true);
      patched++;
    }
    expect(patched).toBe(1);
    const error = importError(() => parseFinanzasXlsx(bytes));
    expect(error.code).toBe('too_large');
    expect(error.message).toBe('The file is too large to import.');
  });

  it('a workbook missing the part of a sheet (month, savings or Config) → ImportError damaged', () => {
    const book = () => unzipSync(xlsx([['Enero 2027', sheetXml(HEADERS)], ['Savings', sheetXml({ B6: 'Goal' })], ['Config', configXml(['Goal'])]]));
    const expected: [part: string, sheet: string][] = [
      ['xl/worksheets/sheet1.xml', 'Enero 2027'],
      ['xl/worksheets/sheet2.xml', 'Savings'],
      ['xl/worksheets/sheet3.xml', 'Config'],
    ];
    for (const [part, sheet] of expected) {
      const files = book();
      delete files[part];
      const error = importError(() => parseFinanzasXlsx(zipSync(files)));
      expect(error.code, part).toBe('damaged');
      expect(error.message, part).toBe(`The .xlsx is damaged: sheet "${sheet}" cannot be found.`);
    }
    const noRels = book();
    delete noRels['xl/_rels/workbook.xml.rels'];
    expect(importError(() => parseFinanzasXlsx(zipSync(noRels))).code).toBe('damaged');
  });

  it('ImportError: without a code it is "unreadable"; with a code and a cause, it keeps them', () => {
    // This is how the tests of other layers create it: with the message only.
    const plain = new ImportError('Could not read the file.');
    expect(plain.code).toBe('unreadable');
    expect(plain.name).toBe('ImportError');
    expect(plain).toBeInstanceOf(Error);
    const cause = new Error('boom');
    expect(new ImportError('x', { cause }).cause).toBe(cause);
    const codes: ImportErrorCode[] = ['not_xlsx', 'old_format', 'too_large', 'damaged', 'no_month_sheets', 'unreadable'];
    for (const code of codes) expect(new ImportError('x', { code, cause }).code).toBe(code);
  });
});
