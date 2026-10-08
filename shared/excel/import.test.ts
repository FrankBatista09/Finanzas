// Pruebas del lector de .xlsx (shared/excel/import.ts).
// Los libros salen de tres sitios:
//   · los archivos de design_handoff/referencia/ y el exportador original del prototipo
//     (tests/reference-export.ts): son los libros de la versión 1, siempre en español y con tres metas fijas;
//   · el exportador de la app (export.ts), el único que los escribe en inglés y en turco y con las metas que
//     tenga el usuario; sus datos de ejemplo son las entradas congeladas de tests/export-data-*.json, no el
//     estado de la app (de ese paso se ocupa data.test.ts);
//   · XML escrito a mano, con las variantes que producen Excel, Numbers y LibreOffice al guardar.
// Lo que se espera está escrito aquí con sus valores, no calculado con las funciones que usa el importador.

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

// ── Comparación ──────────────────────────────────────────────────────────────

function sorted<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
const txKey = (t: Tx) => [t.date, t.desc, t.place, t.amount].join('\u0000');
const contribKey = (c: Contrib) => [c.date, c.goalName, c.amount].join('\u0000');

/** El exportador escribe transacciones y aportes ordenados por fecha: se compara sin importar el orden. */
function normalize(p: ImportPayload): ImportPayload {
  return {
    ...p,
    months: p.months.map((m) => ({ ...m, tx: sorted(m.tx, txKey) })),
    contribs: p.contribs && sorted(p.contribs, contribKey),
  };
}

/**
 * Lo que debe salir al importar un libro generado a partir de `data`, esté en el idioma que esté: los mismos
 * datos (categorías y métodos con su nombre canónico, que es como vienen en `data`) y las metas en su orden.
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
        method: t.method,
        amount: t.amount ?? 0,
        cur: t.cur,
        notes: t.notes,
      })),
    })),
    contribs: data.contribs.map((c) => ({ date: c.date, goalName: c.goalName, amount: c.amount, cur: c.cur })),
    goals: data.goals.map((g) => ({ name: g.name, monthlyUSD: g.monthlyUSD, start: g.start, end: g.end })),
  });
}

// ── Español de la versión 1 ↔ nombres de hoy ─────────────────────────────────
// Escritos aquí a mano (no sacados de shared/i18n.ts): son lo que hay dentro de los libros que ya existen.

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
const METHOD_ES: Record<string, string> = { Card: 'Tarjeta', Transfer: 'Transferencia', 'Bank app': 'App del banco' };
const GOAL_ES: Record<string, string> = {
  'Emergency fund': 'Fondo de emergencia',
  'Personal savings': 'Ahorro personal',
  'Trip to Turkey': 'Viaje a Turquía',
};

const inverse = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
const CAT_EN = inverse(CAT_ES);
const METHOD_EN = inverse(METHOD_ES);
const GOAL_EN = inverse(GOAL_ES);

/** Los mismos datos como los tenía un usuario de la versión 1: categorías, métodos y metas en español. */
function asVersion1(data: ExportData): ExportData {
  return {
    ...data,
    months: data.months.map((m) => ({
      ...m,
      tx: m.tx.map((t) => ({ ...t, cat: CAT_ES[t.cat] ?? t.cat, method: METHOD_ES[t.method] ?? t.method })),
    })),
    goals: data.goals.map((g) => ({ ...g, name: GOAL_ES[g.name] ?? g.name })),
    contribs: data.contribs.map((c) => ({ ...c, goalName: GOAL_ES[c.goalName] ?? c.goalName })),
  };
}

const variable = (name: string): ExportGoal => ({ name, monthlyUSD: null, start: null, end: null });
const planned = (name: string, monthlyUSD: number, start: string, end: string): ExportGoal => ({ name, monthlyUSD, start, end });

/** Las metas de hoy que corresponden a las tres del diseño original. */
const TODAY_GOALS: ImportGoal[] = [
  variable('Emergency fund'),
  variable('Personal savings'),
  planned('Trip to Turkey', 3000, '2026-08', '2027-10'),
];

// ── Libros escritos a mano ───────────────────────────────────────────────────

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
const ROOT_RELS = `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colNumber = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const pad = (n: number) => String(n).padStart(2, '0');

/** Serial de Excel (sistema 1900) de una fecha ISO. */
function serial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;
}

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 6 });
}

/** Texto → cadena en línea, número → <v>, booleano → t="b"; `raw` es el elemento <c> tal cual. */
type TestCell = string | number | boolean | { raw: string };

/** Hoja mínima a partir de { C15: 'Concepto', E16: 1337.15, … }. */
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

/** .xlsx mínimo: una parte por hoja, en el orden dado. */
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

/** Encabezados de las tres tablas en su sitio original, como en los libros de la versión 1 (en español). */
const HEADERS: Record<string, TestCell> = {
  B15: 'Pagado', C15: 'Concepto', D15: 'Día de cobro', E15: 'Monto', F15: 'Moneda',
  M29: 'Fecha', N29: 'Vía', O29: 'USD', P29: 'Tasa',
  B38: 'Fecha', C38: 'Descripción', D38: 'Lugar', E38: 'Categoría', F38: 'Método', G38: 'Monto', H38: 'Moneda', K38: 'Notas',
};

/** Importa un libro con una sola hoja "Enero 2027" y devuelve ese mes. */
function month(cells: Record<string, TestCell>, opts: { date1904?: boolean } = {}): ImportMonth {
  return parseFinanzasXlsx(xlsx([['Enero 2027', sheetXml({ ...HEADERS, ...cells })]], opts)).months[0]!;
}

/** Hoja Config con esa lista de metas (columna G, desde la fila 4). */
const configXml = (goals: string[]) => sheetXml(Object.fromEntries(goals.map((name, i) => [`G${4 + i}`, name])));

/** Importa un libro con "Enero 2027" (vacía), la hoja de ahorros dada y, si se indica, la lista de metas de Config. */
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

const TX_DEFAULTS = { place: '', cat: 'Food', method: 'Card', cur: 'DOP' as Currency, notes: '' };

/** El error que lanza `fn`, comprobando que es un ImportError. */
function importError(fn: () => unknown): ImportError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ImportError);
    return e as ImportError;
  }
  throw new Error('did not throw');
}

// ── Libros de referencia ─────────────────────────────────────────────────────

describe('libros de design_handoff/referencia (versión 1, en español)', () => {
  it('Finanzas Personales v3.xlsx → los datos de ejemplo en español, con categorías, métodos y metas de hoy', () => {
    // Los datos con los que se generó ese libro (reference.test.ts lo comprueba byte a byte).
    const seed = frozenExportData('es');
    const payload = parseFinanzasXlsx(reference('Finanzas Personales v3.xlsx'));

    expect(payload.months.map((m) => m.key)).toEqual(['2026-08', '2026-09', '2026-10']);
    // Todos cerrados salvo el último.
    expect(payload.months.map((m) => m.closed)).toEqual([true, true, false]);
    payload.months.forEach((m, i) => {
      const month = seed.months[i]!;
      expect(month.key).toBe(m.key);
      expect(m.budget, m.key).toBe(month.budget);
      expect(m.incomeUSD, m.key).toBe(month.incomeUSD);
      expect(m.accounts, m.key).toEqual(month.accounts);
      // Los fijos, en el orden de la hoja y con su estado de pago. Sus nombres son del usuario: no se traducen.
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

    // Algunos valores literales, para que la prueba no dependa solo de la entrada congelada.
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
    expect(oct.tx).toContainEqual({ date: '2026-10-07', desc: 'Café', place: 'Starbucks Ágora', cat: 'Food', method: 'Card', amount: 385, cur: 'DOP', notes: '' });
    expect(payload.months[0]!.tx).toContainEqual({ date: '2026-08-21', desc: 'Consulta', place: 'Centro Médico', cat: 'Health', method: 'Transfer', amount: 2500, cur: 'DOP', notes: 'Copago seguro' });
    expect(payload.contribs).toHaveLength(8);
    expect(payload.contribs).toContainEqual({ date: '2026-09-18', goalName: 'Personal savings', amount: 200, cur: 'USD' });
    expect(payload.contribs).toContainEqual({ date: '2026-10-03', goalName: 'Trip to Turkey', amount: 3000, cur: 'USD' });
  });

  it('lo que no son textos del usuario coincide con los datos de ejemplo de la app (shared/seed.ts, en inglés)', () => {
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
    // Las metas de ejemplo son en USD, la única moneda que el libro conoce para una meta.
    expect(state.goals.map((g) => g.cur)).toEqual(['USD', 'USD', 'USD']);
    expect(payload.goals).toEqual(state.goals.map(({ name, monthly, start, end }) => ({ name, monthlyUSD: monthly, start, end })));
  });

  it('Plantilla vacia.xlsx → un mes con las tablas vacías', () => {
    expect(parseFinanzasXlsx(reference('Plantilla vacia.xlsx'))).toEqual({
      months: [
        { key: '2026-10', closed: false, budget: 70000, incomeUSD: 0, accounts: { usd: 0, dop: 0 }, fixed: [], transfers: [], tx: [] },
      ],
      contribs: [],
      // Aquel exportador siempre dibujaba las tres metas, con el plan por defecto en la del viaje.
      goals: TODAY_GOALS,
    });
  });

  // import-libreoffice.fixture.xlsx es "Finanzas Personales v3.xlsx" abierto y guardado por LibreOffice 26.2
  // (soffice --headless --convert-to xlsx): entradas comprimidas, fórmulas con su valor en caché,
  // resultados vacíos como t="str" y otros ids de relación.
  it('el mismo libro guardado por LibreOffice se lee igual', () => {
    const saved = file('./import-libreoffice.fixture.xlsx');
    expect(parseFinanzasXlsx(saved)).toEqual(parseFinanzasXlsx(reference('Finanzas Personales v3.xlsx')));
  });
});

// ── Datos propios ────────────────────────────────────────────────────────────

/** Dos meses con todo lo que puede torcerse: USD, notas, caracteres especiales y tablas desplazadas. */
const custom: ExportData = {
  defaultRate: 58.76,
  goals: [variable('Emergency fund'), variable('Personal savings'), planned('Trip to Turkey', 2500, '2025-11', '2027-03')],
  months: [
    // Desordenados a propósito: el libro y el resultado van por clave.
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
      // 18 fijos (más de 15) y 7 envíos (más de 5): las tablas crecen y el historial baja de la fila 38.
      fixed: [
        { name: 'Luz & agua', day: '', amount: 1890.35, cur: 'DOP', paid: true },
        { name: 'Seguro <médico>', day: '1', amount: 5640, cur: 'DOP', paid: true },
        { name: 'Préstamo "carro"', day: '15', amount: 310.5, cur: 'USD', paid: false },
        { name: "Niñera d'Ana", day: 'fin de mes', amount: 9000, cur: 'DOP', paid: false },
        { name: 'Ñandú · año', day: '28', amount: 0.1 + 0.2, cur: 'DOP', paid: true },
        { name: 'Gratis este mes', day: '', amount: 0, cur: 'USD', paid: false },
        // Nombres que coinciden con un encabezado o con un "sí": son gastos como cualquier otro.
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
        // La vía es texto libre.
        { date: '2025-12-09', via: 'Western Union', usd: 120, rate: 56.935 },
        { date: '2025-12-12', via: 'Remitly', usd: 800, rate: 58.62 },
        { date: '2025-12-18', via: 'Banco de mi tía & Cía', usd: 50, rate: 57 },
        { date: '2025-12-22', via: 'Remitly', usd: 1000, rate: 58.9 },
        { date: '2025-12-30', via: 'Remitly', usd: 75.25, rate: 59.01 },
      ],
      tx: [
        // Categoría y método fuera de las listas: texto del usuario, queda como está en cualquier idioma.
        { date: '2025-12-24', desc: 'Cena de Nochebuena', place: 'Casa', cat: 'Categoría propia', method: 'Efectivo', amount: 7300, cur: 'DOP', notes: 'ñ á é í ó ú ü ¿? ¡! € RD$ ğ ş ı İ ö ç' },
        { date: '2025-12-01', desc: 'Café & pan <integral>', place: 'Panadería "La Única"', cat: 'Food', method: 'Card', amount: 385.5, cur: 'DOP', notes: "l'apóstrofo > todo" },
        { date: '2025-12-05', desc: 'Hosting', place: 'Hetzner', cat: 'Subscriptions', method: 'Card', amount: 12.99, cur: 'USD', notes: 'Factura #A-17 & recibo' },
        { date: '2025-12-05', desc: 'Sin lugar ni notas', place: '', cat: 'Transport', method: 'Bank app', amount: 250, cur: 'DOP', notes: '' },
        { date: '2025-12-05', desc: 'Vuelo SDQ → IST', place: 'Turkish Airlines', cat: 'Travel', method: 'Card', amount: 1480.4, cur: 'USD', notes: 'línea 1\nlínea 2' },
        // Una descripción que es el nombre de una categoría en otro idioma no se toca: no es una categoría.
        { date: '2025-12-06', desc: 'Comida', place: 'Yemek', cat: 'Groceries', method: 'Card', amount: 640, cur: 'DOP', notes: 'Tarjeta' },
        { date: '2025-12-07', desc: 'Lentes', place: 'Óptica', cat: 'Health', method: 'Card', amount: 4100, cur: 'DOP', notes: '' },
        { date: '2025-12-08', desc: 'Abrigo', place: '', cat: 'Clothing', method: 'Card', amount: 2300, cur: 'DOP', notes: '' },
        { date: '2025-12-09', desc: 'Curso', place: '', cat: 'Education', method: 'Transfer', amount: 49, cur: 'USD', notes: '' },
        { date: '2025-12-10', desc: 'Cine', place: '', cat: 'Entertainment', method: 'Bank app', amount: 900, cur: 'DOP', notes: '' },
        // La hoja manda sobre la fecha: un cargo de enero anotado en diciembre sigue en diciembre.
        { date: '2026-01-02', desc: 'Cargo atrasado', place: 'Banco', cat: 'Home', method: 'Transfer', amount: 99.99, cur: 'DOP', notes: '  con espacios  ' },
      ],
    },
  ],
  contribs: [
    { date: '2025-12-15', goalName: 'Emergency fund', amount: 15000, cur: 'DOP' },
    { date: '2025-12-02', goalName: 'Trip to Turkey', amount: 2500, cur: 'USD' },
    // Una meta que no tiene tarjeta: el aporte conserva su nombre.
    { date: '2026-01-10', goalName: 'Carro nuevo & seguro', amount: 20500.5, cur: 'DOP' },
    { date: '2026-01-10', goalName: 'Personal savings', amount: 120, cur: 'USD' },
    // Suficientes para pasar de la fila 40 de la hoja de ahorros.
    ...Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${pad(i + 1)}`,
      goalName: i % 2 ? 'Personal savings' : 'Emergency fund',
      amount: 10 + i,
      cur: (i % 3 ? 'USD' : 'DOP') as Currency,
    })),
  ],
};

/** Listas de metas para el exportador de la app. El orden es el del usuario, no el de las tarjetas en la hoja. */
const GOAL_LISTS: Record<string, ExportGoal[]> = {
  'sin metas': [],
  'una sola, con plan': [planned('Trip to Turkey', 3000, '2026-08', '2027-10')],
  'cinco sin plan': [variable('Emergency fund'), variable('Personal savings'), variable('Gifts'), variable('Vacaciones'), variable('Düğün')],
  'tres con plan': [
    planned('Trip to Turkey', 3000, '2026-08', '2027-10'),
    planned('Car', 450.5, '2026-01', '2026-01'),
    planned('House', 1200, '2025-12', '2030-12'),
  ],
  // En la hoja quedan en cuatro bandas y en otro orden: B6 Emergency fund, E6 Fondo de emergencia, I6 Trip to
  // Turkey; B14 Gifts, I14 Car; B22 Düğün & balayı, I22 House; I30 Ahorro personal.
  'ocho mezcladas': [
    planned('Trip to Turkey', 3000, '2026-08', '2027-10'),
    variable('Emergency fund'),
    // Dos nombres de las metas de la versión 1 puestos por el usuario: en un libro con otras metas no se tocan.
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
    // El nombre vuelve como está escrito, también con sus espacios.
    variable('  con espacios  '),
  ],
};

/** `custom` con esas metas y dos aportes a cada una, más dos a una meta que no tiene tarjeta. */
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
/** Rango de la tabla con ese nombre ("I31:O49"). */
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
  // Se corta en un espacio para no partir una entidad (&amp;).
  const cut = text.indexOf(' ');
  const runs =
    cut > 0
      ? `<r><t xml:space="preserve">${text.slice(0, cut)}</t></r><r><rPr><b/><sz val="10"/></rPr><t xml:space="preserve">${text.slice(cut)}</t></r>`
      : `<r><rPr><i/></rPr><t xml:space="preserve">${text}</t></r>`;
  return `${runs}<rPh sb="0" eb="1"><t>guía fonética</t></rPh><phoneticPr fontId="1"/>`;
}

/** Quita el atributo r de las celdas (y, si se pide, de las filas), rellenando los huecos con elementos vacíos. */
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
 * Reescribe un libro del exportador (2 meses + ahorros + Config) con lo que hacen otras aplicaciones:
 * cadenas compartidas con formato y guía fonética, cadenas en línea, fechas en sistema 1904, celdas y
 * filas sin referencia, partes de hoja que no siguen el orden de las pestañas, destino absoluto y deflate.
 * `planRows` son las filas de la hoja de ahorros con las fechas de una meta con plan (12, 20, 28…).
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
  // Los únicos enteros de esas columnas son fechas: B y M en un mes; I y las celdas de inicio y fin en ahorros.
  const to1904 = (xml: string, isDate: (col: string, row: number) => boolean) =>
    xml.replace(/<c r="([A-Z]+)(\d+)" s="(\d+)"><v>(\d+)<\/v><\/c>/g, (m, col: string, row: string, s: string, v: string) => {
      return isDate(col, +row) ? `<c r="${col}${row}" s="${s}"><v>${+v - 1462}</v></c>` : m;
    });
  const monthDate = (col: string) => col === 'B' || col === 'M';
  const savingsDate = (col: string, row: number) => col === 'I' || ((col === 'L' || col === 'N') && planRows.includes(row));

  const dec = stripRefs(inline(to1904(get(sheet(1)), monthDate)), true);
  const jan = stripRefs(to1904(get(sheet(2)), monthDate), false);
  put(sheet(3), stripRefs(to1904(get(sheet(3)), savingsDate), true));
  // Diciembre (primera pestaña) pasa a sheet2.xml y enero a sheet1.xml.
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

/** Método de compresión de la primera entrada del zip: 0 = sin comprimir (exportador), 8 = deflate. */
const zipMethod = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true);

// ── Ida y vuelta con el exportador original (libros de la versión 1) ─────────

describe('ida y vuelta con el exportador de referencia (libro de la versión 1)', () => {
  const legacy = asVersion1(custom);

  it('datos propios: USD, notas, caracteres especiales, tablas desplazadas; todo vuelve sin idioma', async () => {
    const bytes = await buildWithReference(legacy);

    // Comprueba las premisas: el libro está en español, y con 18 fijos y 7 envíos el encabezado del historial
    // ya no está en la fila 38.
    const strings = sharedStrings(bytes);
    for (const text of ['>Hogar<', '>Transferencia<', '>App del banco<', '>Fondo de emergencia<', '>Viaje a Turquía<']) {
      expect(strings, text).toContain(text);
    }
    for (const text of ['>Home<', '>Bank app<', '>Emergency fund<', '>Trip to Turkey<']) expect(strings, text).not.toContain(text);
    expect(tableRef(bytes, 'Tx_2025_12')).toMatch(/^B42:K/);

    const payload = parseFinanzasXlsx(bytes);
    expect(normalize(payload)).toEqual(expectedPayload(custom));
    // Los fijos y los envíos conservan el orden en que se escribieron.
    expect(payload.months[0]!.fixed.map((f) => f.name)).toEqual(custom.months[1]!.fixed.map((f) => f.name));
    expect(payload.months[0]!.transfers.map((t) => t.date)).toEqual(custom.months[1]!.transfers.map((t) => t.date));
    expect(payload.months.map((m) => [m.key, m.closed])).toEqual([['2025-12', true], ['2026-01', false]]);
    expect(payload.contribs).toHaveLength(34);

    // Valores literales: lo que era de una lista vuelve en inglés; lo que escribió el usuario, como estaba.
    const dec = payload.months[0]!;
    expect(dec.tx).toContainEqual({ date: '2025-12-24', desc: 'Cena de Nochebuena', place: 'Casa', cat: 'Categoría propia', method: 'Efectivo', amount: 7300, cur: 'DOP', notes: 'ñ á é í ó ú ü ¿? ¡! € RD$ ğ ş ı İ ö ç' });
    expect(dec.tx).toContainEqual({ date: '2025-12-06', desc: 'Comida', place: 'Yemek', cat: 'Groceries', method: 'Card', amount: 640, cur: 'DOP', notes: 'Tarjeta' });
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

  it('el mismo libro comprimido con deflate se lee idéntico', async () => {
    const bytes = await buildWithReference(legacy);
    const deflated = zipSync(unzipSync(bytes), { level: 6 });
    expect(zipMethod(bytes)).toBe(0);
    expect(zipMethod(deflated)).toBe(8);
    expect(deflated.length).toBeLessThan(bytes.length / 2);
    expect(parseFinanzasXlsx(deflated)).toEqual(parseFinanzasXlsx(bytes));
  });

  it('inlineStr, cadenas con formato, date1904 y celdas sin r: se lee idéntico', async () => {
    const bytes = await buildWithReference(legacy);
    const rewritten = rewriteLikeOtherApps(bytes);

    // Comprueba que la reescritura hizo lo que dice (si no, la prueba no probaría nada).
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
    // Diciembre de 2025 en sistema 1904: 45992 − 1462.
    expect(dec).toContain(`<v>${serial('2025-12-01') - 1462}</v>`);
    expect(dec).not.toContain(`<v>${serial('2025-12-01')}</v>`);

    expect(parseFinanzasXlsx(rewritten)).toEqual(parseFinanzasXlsx(bytes));
    expect(normalize(parseFinanzasXlsx(rewritten))).toEqual(expectedPayload(custom));
  });

  it('una hoja con 5,000 transacciones se importa entera y sin demoras', async () => {
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
            method: i % 2 ? 'Card' : 'Bank app',
            amount: i + 0.5,
            cur: (i % 7 ? 'DOP' : 'USD') as Currency,
            notes: i % 5 ? '' : `nota ${i}`,
          })),
        },
      ],
    };
    // Deflate, como lo dejaría Excel al guardar.
    const bytes = zipSync(unzipSync(await buildWithReference(asVersion1(data))), { level: 6 });
    const t0 = performance.now();
    const payload = parseFinanzasXlsx(bytes);
    const ms = performance.now() - t0;
    expect(normalize(payload)).toEqual(expectedPayload(data));
    expect(payload.months[0]!.tx).toHaveLength(5000);
    // Holgado a propósito: tarda decenas de milisegundos; un lector cuadrático tardaría mucho más.
    expect(ms).toBeLessThan(2000);
  }, 30_000);
});

// ── Ida y vuelta con el exportador de la app, en los tres idiomas ────────────

/** Textos que solo están en un libro de ese idioma: la hoja de diciembre, la de ahorros y la categoría Travel. */
const IN_LANGUAGE: Record<Language, { december: string; savings: string; travel: string; contribs: string }> = {
  en: { december: 'December 2025', savings: 'Savings', travel: 'Travel', contribs: 'Contributions' },
  es: { december: 'Diciembre 2025', savings: 'Ahorros', travel: 'Viajes', contribs: 'Aportes' },
  tr: { december: 'Aralık 2025', savings: 'Birikimler', travel: 'Seyahat', contribs: 'Katkilar' },
};

describe.each(LANGS)('ida y vuelta con el exportador de la app, libro en "%s"', (lang) => {
  const words = IN_LANGUAGE[lang];
  const build = (data: ExportData) => buildFinanzasXlsx(data, { locale: EXCEL_LOCALES[lang] });

  it('los datos de ejemplo vuelven tal cual', () => {
    const data = frozenExportData('en');
    const payload = parseFinanzasXlsx(build(data));
    expect(normalize(payload)).toEqual(expectedPayload(data));

    // Valores literales, iguales en los tres idiomas.
    expect(payload.months.map((m) => [m.key, m.closed])).toEqual([['2026-08', true], ['2026-09', true], ['2026-10', false]]);
    const oct = payload.months[2]!;
    expect(oct.fixed[4]).toEqual({ name: 'Claude', day: '5', amount: 106, cur: 'USD', paid: true });
    expect(oct.fixed.filter((f) => f.paid).map((f) => f.name)).toEqual(['Electricity', 'Internet', 'Health insurance', 'Fridge payment', 'Claude', 'Unicaribe']);
    expect(oct.tx).toContainEqual({ date: '2026-10-07', desc: 'Coffee', place: 'Starbucks Ágora', cat: 'Food', method: 'Card', amount: 385, cur: 'DOP', notes: '' });
    expect(oct.tx).toContainEqual({ date: '2026-10-04', desc: 'Movies', place: 'Caribbean Cinemas', cat: 'Entertainment', method: 'Bank app', amount: 900, cur: 'DOP', notes: '' });
    expect(payload.months[0]!.tx).toContainEqual({ date: '2026-08-21', desc: 'Doctor visit', place: 'Centro Médico', cat: 'Health', method: 'Transfer', amount: 2500, cur: 'DOP', notes: 'Insurance copay' });
    expect(payload.goals).toEqual(TODAY_GOALS);
    expect(payload.contribs).toHaveLength(8);
    expect(payload.contribs).toContainEqual({ date: '2026-09-18', goalName: 'Personal savings', amount: 200, cur: 'USD' });
  });

  it.each(Object.keys(GOAL_LISTS))('datos propios con metas: %s', (list) => {
    const data = withGoals(GOAL_LISTS[list]!);
    const bytes = build(data);

    // Comprueba la premisa: el libro está de verdad en ese idioma (hojas y valores de las listas).
    expect(workbookXml(bytes)).toContain(`name="${words.december}"`);
    expect(workbookXml(bytes)).toContain(`name="${words.savings}"`);
    expect(sharedStrings(bytes)).toContain(`>${words.travel}<`);

    const payload = parseFinanzasXlsx(bytes);
    expect(normalize(payload)).toEqual(expectedPayload(data));
    expect(payload.goals!.map((g) => g.name)).toEqual(GOAL_LISTS[list]!.map((g) => g.name));
    expect(payload.contribs).toHaveLength(2 * (GOAL_LISTS[list]!.length + 1));
    expect(payload.months[0]!.fixed.map((f) => f.name)).toEqual(custom.months[1]!.fixed.map((f) => f.name));
  });

  it('con cuatro bandas de metas la tabla de aportes empieza 24 filas más abajo y se encuentra igual', () => {
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

  it('comprimido con deflate, o reescrito como lo guardan otras aplicaciones, se lee idéntico', () => {
    const data = withGoals(GOAL_LISTS['ocho mezcladas']!);
    const bytes = build(data);
    const deflated = zipSync(unzipSync(bytes), { level: 6 });
    expect(zipMethod(bytes)).toBe(0);
    expect(zipMethod(deflated)).toBe(8);
    expect(parseFinanzasXlsx(deflated)).toEqual(parseFinanzasXlsx(bytes));

    // Cuatro bandas: las fechas de las metas con plan están en las filas 12, 20, 28 y 36.
    const rewritten = rewriteLikeOtherApps(bytes, [12, 20, 28, 36]);
    const files = unzipSync(rewritten);
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('date1904="1"');
    expect(strFromU8(files['xl/worksheets/sheet3.xml']!)).not.toMatch(/<(c|row) r="/);
    expect(strFromU8(files['xl/worksheets/sheet3.xml']!)).toContain(`<v>${serial('2030-12-01') - 1462}</v>`);
    expect(parseFinanzasXlsx(rewritten)).toEqual(parseFinanzasXlsx(bytes));
    expect(normalize(parseFinanzasXlsx(rewritten))).toEqual(expectedPayload(data));
  });

  it('sin meses exporta la plantilla vacía, que vuelve como un mes vacío y sin metas', () => {
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

describe('listas de metas al azar', () => {
  it('de 0 a 14 metas, con y sin plan y en cualquier orden, en los tres idiomas: vuelven las mismas y en su orden', () => {
    // Generador determinista: las mismas listas en cada ejecución.
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
    // Comprueba que el azar dio variedad de verdad (si no, la prueba no probaría nada).
    expect(shapes.size).toBeGreaterThan(60);
  });
});

describe('metas que no vuelven como se mandaron', () => {
  it('un plan incompleto o incoherente se exporta, y vuelve, como meta de aportes variables', () => {
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

  it('una meta sin nombre no tiene tarjeta que leer; dos con el mismo nombre vuelven las dos', () => {
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

// ── Las metas de la versión 1 ────────────────────────────────────────────────

describe('las tres metas del libro de la versión 1 pasan a ser las de hoy', () => {
  const legacy = asVersion1(custom);

  it('el exportador de la app, en español y con esas tres metas, da el libro de antes: se lee igual', async () => {
    const bytes = buildFinanzasXlsx(legacy, { locale: EXCEL_LOCALES.es });
    expect(Buffer.from(bytes).equals(Buffer.from(await buildWithReference(legacy)))).toBe(true);
    expect(normalize(parseFinanzasXlsx(bytes))).toEqual(expectedPayload(custom));
  });

  it('solo se cambian esos tres nombres: un aporte a otra meta conserva el suyo', () => {
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
      // Sin meta: la de ahorro personal, como en el prototipo.
      'Personal savings',
    ]);
  });

  it('en inglés o en turco no es un libro de antes: esos nombres los puso el usuario y quedan como están', () => {
    const data: ExportData = { ...custom, goals: legacy.goals, contribs: legacy.contribs };
    for (const lang of ['en', 'tr'] as const) {
      const payload = parseFinanzasXlsx(buildFinanzasXlsx(data, { locale: EXCEL_LOCALES[lang] }));
      expect(normalize(payload), lang).toEqual(expectedPayload(data));
      expect(payload.goals!.map((g) => g.name), lang).toEqual(['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía']);
    }
  });

  it('en español con una meta más, una menos o en otro orden, tampoco', () => {
    const [emergency, personal, trip] = legacy.goals as [ExportGoal, ExportGoal, ExportGoal];
    for (const goals of [[emergency, personal, trip, variable('Carro')], [emergency, trip], [personal, emergency, trip]]) {
      const data: ExportData = { ...custom, goals, contribs: legacy.contribs };
      const payload = parseFinanzasXlsx(buildFinanzasXlsx(data, { locale: EXCEL_LOCALES.es }));
      expect(normalize(payload)).toEqual(expectedPayload(data));
      expect(payload.contribs).toContainEqual({ date: '2025-12-15', goalName: 'Fondo de emergencia', amount: 15000, cur: 'DOP' });
    }
  });
});

// ── Lector de SpreadsheetML ──────────────────────────────────────────────────

describe('lector de SpreadsheetML', () => {
  it('tipos de celda, entidades, escapes _xHHHH_, CDATA, prefijos y celdas sin r', () => {
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
      // Error y fórmula sin valor en caché: celdas vacías, así que esas filas no tienen monto.
      '<x:row r="17"><x:c r="C17" t="inlineStr"><x:is><x:t>Con error</x:t></x:is></x:c><x:c r="E17" t="e"><x:v>#DIV/0!</x:v></x:c></x:row>' +
      '<x:row r="18"><x:c r="C18" t="inlineStr"><x:is><x:t>Sin calcular</x:t></x:is></x:c><x:c r="E18"><x:f>1+1</x:f></x:c></x:row>' +
      '<x:row r="19"><x:c r="B19" t="s"><x:v>7</x:v></x:c><x:c r="C19" t="s"><x:v>4</x:v></x:c><x:c r="E19"><x:f>100*2</x:f><x:v>200</x:v></x:c><x:c r="F19" t="str"><x:f>""</x:f><x:v></x:v></x:c></x:row>' +
      '<x:row r="38"><x:c r="B38" t="s"><x:v>2</x:v></x:c><x:c r="C38" t="s"><x:v>1</x:v></x:c></x:row>' +
      // Celdas sin r: la posición la da el orden (A, B, C…).
      '<x:row r="39"><x:c/><x:c t="d"><x:v>2027-01-15T00:00:00Z</x:v></x:c><x:c t="s"><x:v>5</x:v></x:c><x:c t="s"><x:v>3</x:v></x:c><x:c s="4"/><x:c/><x:c><x:v>250</x:v></x:c></x:row>' +
      '<!-- <x:row r="40"><x:c r="C40" t="inlineStr"><x:is><x:t>Comentada</x:t></x:is></x:c></x:row> -->' +
      // Fila sin r: es la siguiente a la 39.
      '<x:row><x:c/><x:c/><x:c t="s"><x:v>6</x:v></x:c><x:c/><x:c/><x:c/><x:c><x:v>10</x:v></x:c><x:c r="K40" t="inlineStr"><x:is><x:t xml:space="preserve"> nota </x:t></x:is></x:c></x:row>' +
      '</x:sheetData><x:mergeCells count="1"><x:mergeCell ref="B5:D5"/></x:mergeCells></x:worksheet>';
    const bytes = zip({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': ROOT_RELS,
      // Prefijos distintos de los habituales, la pestaña del mes en segundo lugar y su parte con ruta absoluta.
      'xl/workbook.xml': `${XML}<x:workbook xmlns:x="${MAIN}" xmlns:rel="${REL}"><x:workbookPr date1904="false"/><x:sheets><x:sheet name="Notas &amp; pendientes" sheetId="9" rel:id="rIdA"/><x:sheet name="Enero 2027" sheetId="4" rel:id="rIdB"/></x:sheets></x:workbook>`,
      'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="cadenas.xml"/><Relationship Id="rIdB" Type="${REL}/worksheet" Target="/xl/hojas/enero.xml"/><Relationship Id="rIdA" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/cadenas.xml': sst,
      'xl/hojas/enero.xml': sheet,
      // Si el lector tomara sheet1.xml por la primera hoja de mes, este fijo aparecería en el resultado.
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

  it('la hoja se localiza por sus relaciones: libro fuera de xl/, rutas con ".." y mayúsculas distintas', () => {
    const bytes = zip({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="/libro/wb.xml"/></Relationships>`,
      'libro/wb.xml': `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Febrero 2027" sheetId="1" r:id="rId2"/><sheet name="Marzo 2027" sheetId="2" r:id="rId9"/><sheet name="Enero 2027" sheetId="3" r:id="rId1"/></sheets></workbook>`,
      'libro/_rels/wb.xml.rels':
        `${XML}<Relationships xmlns="${PKG_REL}">` +
        // Tipo de relación de un libro "Strict Open XML".
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
    // "Marzo 2027" es una hoja de gráfico: no tiene celdas y no cuenta como mes.
    expect(payload.months.map((m) => [m.key, m.budget, m.closed])).toEqual([
      ['2027-01', 111, true],
      ['2027-02', 222, false],
    ]);
  });

  it('partes con BOM o codificadas en UTF-16', () => {
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

  it('XML truncado: devuelve lo leído hasta ahí, no se cuelga ni lanza otra cosa', () => {
    const whole = sheetXml({ ...HEADERS, C39: 'Completa', G39: 1, C40: 'Incompleta', G40: 2 });
    for (const cut of [whole.indexOf('Incompleta') + 4, whole.indexOf('r="C40"') + 4, whole.indexOf('<row r="40"') + 2]) {
      const payload = parseFinanzasXlsx(xlsx([['Enero 2027', whole.slice(0, cut)]]));
      expect(payload.months[0]!.tx.map((t) => t.desc)[0]).toBe('Completa');
    }
  });
});

// ── Qué cuenta como fila y cómo se normaliza ─────────────────────────────────

describe('gastos mensuales', () => {
  it('una fila cuenta si tiene concepto y monto numérico', () => {
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

  it('pagado es "sí" en cualquiera de los tres idiomas; todo lo demás es que no', () => {
    const values: [TestCell, boolean][] = [
      ['Sí', true], ['Yes', true], ['Evet', true], ['YES', true], [' evet ', true], ['EVET', true], ['sí', true], [true, true],
      ['No', false], ['Hayır', false], ['Yes!', false], ['Y', false], ['Evet değil', false], ['Pagado', false], [1, false], [false, false],
    ];
    const cells: Record<string, TestCell> = {};
    values.forEach(([v], i) => Object.assign(cells, { [`B${16 + i}`]: v, [`C${16 + i}`]: `Gasto ${i}`, [`E${16 + i}`]: 1 }));
    expect(month(cells).fixed.map((f) => f.paid)).toEqual(values.map(([, paid]) => paid));
  });

  it('un gasto que se llama como el encabezado de la tabla, en cualquier idioma, es un gasto', () => {
    const m = month({ C16: 'Item', E16: 5, C17: 'Concepto', E17: 6, C18: 'Kalem', E18: 7, C19: 'Luz', E19: 8 });
    expect(m.fixed.map((f) => f.name)).toEqual(['Item', 'Concepto', 'Kalem', 'Luz']);
  });
});

describe('envíos', () => {
  it('una fila cuenta si tiene USD; fecha, vía y tasa tienen valor por defecto', () => {
    const m = month({
      M30: serial('2027-01-03'), N30: 'PayPal', O30: 1500, P30: 58.4,
      M31: '18/01/2027', O31: 300,
      N32: 'PayPal', P32: 57,
      M34: 'ayer', N34: 'Western Union', O34: '1,000', P34: '57.10',
      // La vía es texto libre: cualquier nombre vale, tal como está escrito.
      M35: serial('2027-01-20'), N35: ' La tía Carmen (en efectivo) ', O35: 20, P35: 60,
    });
    expect(m.transfers).toEqual([
      { date: '2027-01-03', via: 'PayPal', usd: 1500, rate: 58.4 },
      { date: '2027-01-18', via: 'Remitly', usd: 300, rate: 0 },
      { date: '2027-01-01', via: 'Western Union', usd: 1000, rate: 57.1 },
      { date: '2027-01-20', via: ' La tía Carmen (en efectivo) ', usd: 20, rate: 60 },
    ]);
  });

  it('lee más de 80 envíos seguidos, pero no lo que quede tras 80 filas vacías', () => {
    const cells: Record<string, TestCell> = {};
    for (let i = 0; i < 100; i++) cells[`O${30 + i}`] = i + 1;
    cells.O300 = 9999;
    const m = month(cells);
    expect(m.transfers.map((t) => t.usd)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });
});

describe('historial de transacciones', () => {
  it('una fila cuenta si tiene descripción o un monto numérico; las vacías no son registros', () => {
    const m = month({
      B39: serial('2027-01-02'), C39: 'Compra semanal', D39: 'Jumbo', E39: 'Supermercado', F39: 'App del banco', G39: 4680, H39: 'DOP', K39: 'con nota',
      // 40: en blanco.
      B41: serial('2027-01-03'),
      E42: 'Comida', F42: 'Tarjeta', H42: 'DOP', K42: 'solo listas y nota',
      C43: 'Solo descripción',
      G44: 99.9,
      C45: '   ', G45: 'n/a',
      B46: '2027-01-20', C46: 'Fecha ISO como texto', G46: '1,250.50', H46: 'usd',
      B47: '32/01/2027', C47: 'Fecha imposible', G47: 5, H47: 'EUR',
      B48: 0, C48: 'Serial cero', G48: 0,
      B49: '7/1/2027', C49: 7, D49: 8, G49: 9,
      // Fórmulas de la tabla con resultado vacío, como las deja Excel en las filas sin usar.
      I50: { raw: '<c r="I50" t="str"><f>IF(G50="","",G50)</f><v></v></c>' },
      J50: { raw: '<c r="J50" t="str"><f>IF(I50="","",I50/58.76)</f><v/></c>' },
    });
    expect(m.tx).toEqual([
      { date: '2027-01-02', desc: 'Compra semanal', place: 'Jumbo', cat: 'Groceries', method: 'Bank app', amount: 4680, cur: 'DOP', notes: 'con nota' },
      // Sin categoría ni método: Food y Card, los mismos valores por defecto que al registrar un gasto.
      { ...TX_DEFAULTS, date: '2027-01-01', desc: 'Solo descripción', amount: 0 },
      { ...TX_DEFAULTS, date: '2027-01-01', desc: '', amount: 99.9 },
      { ...TX_DEFAULTS, date: '2027-01-20', desc: 'Fecha ISO como texto', amount: 1250.5, cur: 'USD' },
      { ...TX_DEFAULTS, date: '2027-01-01', desc: 'Fecha imposible', amount: 5 },
      { ...TX_DEFAULTS, date: '2027-01-01', desc: 'Serial cero', amount: 0 },
      { ...TX_DEFAULTS, date: '2027-01-07', desc: '7', place: '8', amount: 9 },
    ]);
  });

  it('categoría y método: nombre canónico si es de la lista en cualquier idioma; si no, como está escrito', () => {
    const rows: [cat: TestCell, method: TestCell, expected: [string, string]][] = [
      ['Comida', 'Tarjeta', ['Food', 'Card']],
      ['Yemek', 'Kart', ['Food', 'Card']],
      ['Food', 'Card', ['Food', 'Card']],
      ['Supermercado', 'Transferencia', ['Groceries', 'Transfer']],
      ['Market', 'Havale', ['Groceries', 'Transfer']],
      ['Ulaşım', 'Banka uygulaması', ['Transport', 'Bank app']],
      ['Educación', 'App del banco', ['Education', 'Bank app']],
      ['Eğitim', 'Bank app', ['Education', 'Bank app']],
      // Mayúsculas y espacios de más no cambian lo que es.
      [' viajes ', 'TARJETA', ['Travel', 'Card']],
      ['SEYAHAT', ' kart', ['Travel', 'Card']],
      // Fuera de las listas: texto del usuario.
      ['Mascotas', 'Efectivo', ['Mascotas', 'Efectivo']],
      ['Comida rápida', 'Tarjeta de crédito', ['Comida rápida', 'Tarjeta de crédito']],
      ['Evcil hayvan', 'Nakit', ['Evcil hayvan', 'Nakit']],
      [2027, true, ['2027', 'TRUE']],
    ];
    const cells: Record<string, TestCell> = {};
    rows.forEach(([cat, method], i) => Object.assign(cells, { [`C${39 + i}`]: `Fila ${i}`, [`E${39 + i}`]: cat, [`F${39 + i}`]: method, [`G${39 + i}`]: 1 }));
    expect(month(cells).tx.map((t) => [t.cat, t.method])).toEqual(rows.map(([, , expected]) => expected));
  });

  it('sigue tras 39 filas en blanco y termina tras 40', () => {
    const m = month({
      C39: 'Primera', G39: 1,
      // 40..78 en blanco (39 filas).
      C79: 'Tras 39 filas en blanco', G79: 2,
      // 80..119 en blanco (40 filas).
      C120: 'Tras 40 filas en blanco', G120: 3,
    });
    expect(m.tx.map((t) => t.desc)).toEqual(['Primera', 'Tras 39 filas en blanco']);
  });

  it('fechas en sistema 1904', () => {
    const m = month(
      { B39: serial('2027-01-15') - 1462, C39: 'Mac antiguo', G39: 1, M30: serial('2027-01-09') - 1462, O30: 100, P30: 58 },
      { date1904: true },
    );
    expect(m.tx[0]!.date).toBe('2027-01-15');
    expect(m.transfers[0]!.date).toBe('2027-01-09');
  });
});

describe('estructura de la hoja de mes', () => {
  it('sin encabezados usa las filas del diseño original (15, 29 y 38)', () => {
    const m = parseFinanzasXlsx(
      xlsx([['Enero 2027', sheetXml({ C16: 'Luz', E16: 10, O30: 100, P30: 58, C39: 'Compra', G39: 20, C8: 1, C9: 2, C10: 3, O6: 4 })]]),
    ).months[0]!;
    expect(m.fixed.map((f) => f.name)).toEqual(['Luz']);
    expect(m.transfers.map((t) => t.usd)).toEqual([100]);
    expect(m.tx.map((t) => t.desc)).toEqual(['Compra']);
    expect([m.accounts.usd, m.accounts.dop, m.incomeUSD, m.budget]).toEqual([1, 2, 3, 4]);
  });

  it('encuentra las tablas aunque estén desplazadas', () => {
    const m = parseFinanzasXlsx(
      xlsx([
        [
          'Enero 2027',
          sheetXml({
            // Por encima del encabezado "Concepto" no hay fijos, aunque parezcan filas válidas.
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

  it('celdas de resumen vacías o con texto: presupuesto 70,000 y lo demás en cero', () => {
    const m = month({ O6: 'n/d', C8: '4,320.50', C9: true });
    expect(m).toMatchObject({ budget: 70000, incomeUSD: 0, accounts: { usd: 4320.5, dop: 0 } });
  });

  it('meses ordenados por clave, cerrados salvo el último; las demás hojas se ignoran', () => {
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
        // Mismo mes que una hoja anterior: vale la última.
        ['Diciembre  2026', sheetXml({ O6: 1212 })],
      ]),
    );
    expect(payload.months.map((m) => [m.key, m.budget, m.closed])).toEqual([
      ['2026-12', 1212, true],
      ['2027-01', 1, true],
      ['2027-02', 2, false],
    ]);
    // Sin hoja de ahorros no se tocan los aportes ni las metas.
    expect(payload.contribs).toBeNull();
    expect(payload.goals).toBeNull();
  });
});

// ── Los tres idiomas, en libros escritos a mano ──────────────────────────────
// Los textos van aquí como literales, no sacados de locale-*.ts: son los que llevan dentro los libros ya
// exportados. Si algún día se cambia uno en el exportador, esta prueba avisa de que los libros anteriores
// dejarían de reconocerse (y entonces el importador tendría que seguir aceptando el texto viejo).

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
 * Hoja de mes con las tres tablas fuera de su sitio (solo se encuentran por sus encabezados), cada tabla con
 * los textos del idioma que se le pasa.
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

/** Hoja de ahorros con tres bandas de metas y la tabla de aportes en la fila 31, con los textos de ese idioma. */
function shiftedSavings(lang: Language): Record<string, TestCell> {
  const w = WORDS[lang];
  return {
    // Banda 0: dos metas sin plan y una con plan. Banda 1: solo una con plan. Banda 2: solo una sin plan.
    B6: 'Emergency', E6: 'Personal', I6: 'Trip', J12: 3000, L12: serial('2026-08-01'), N12: serial('2027-10-01'),
    I14: 'Car', J20: 450.5, L20: '01/2027', N20: '2027-06',
    B22: 'Gifts',
    I31: w.date, K31: w.goal,
    I32: serial('2027-01-05'), K32: 'Trip', L32: 3000, M32: 'USD',
    I33: serial('2027-01-06'), K33: 'Gifts', L33: 1500, M33: 'DOP',
    // Sin fecha, sin meta y sin moneda.
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

describe('libros en los tres idiomas', () => {
  it.each(LANGS)('libro en "%s": hojas, encabezados, pagado, categorías y métodos se reconocen y el resultado es el mismo', (lang) => {
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
      // El orden es el de la lista de Config, no el de las tarjetas.
      goals: [SHIFTED_GOALS[2], SHIFTED_GOALS[0], SHIFTED_GOALS[1], SHIFTED_GOALS[3], SHIFTED_GOALS[4]],
    });
  });

  it('un libro que mezcla idiomas (hojas, tablas y valores de cada uno) se lee igual', () => {
    const payload = parseFinanzasXlsx(
      xlsx([
        // Cada hoja de mes con el nombre en un idioma y cada tabla con los encabezados de otro.
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
      // El aporte sin fecha va al primer día del último mes.
      contribs: [SHIFTED_CONTRIBS[0], SHIFTED_CONTRIBS[1], { ...SHIFTED_CONTRIBS[2], date: '2027-03-01' }],
      // Sin hoja Config, las metas van en el orden de las tarjetas.
      goals: SHIFTED_GOALS,
    });
  });

  it('un libro exportado en turco al que le renombran hojas a otros idiomas se lee igual', () => {
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

  it('el mismo mes en dos idiomas: vale la última hoja; con dos hojas de ahorros, también', () => {
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

  it('nombres de hoja que no son de la app en ningún idioma no cuentan', () => {
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

// ── Hoja de ahorros ──────────────────────────────────────────────────────────

describe('hoja de ahorros', () => {
  it('aportes: cuenta la fila con monto; la meta va tal como está escrita', () => {
    const { contribs, goals } = savings({
      I6: 'Viaje largo', J12: 2500, L12: serial('2026-08-01'), N12: '10/2027',
      I15: 'Fecha', J15: 'Mes', K15: 'Meta', L15: 'Monto', M15: 'Moneda',
      I16: serial('2027-01-05'), K16: 'Viaje a Turquía', L16: 3000, M16: 'USD',
      I17: '06/01/2027', K17: 'Meta nueva & rara', L17: '15,000', M17: 'dop',
      I18: serial('2027-01-07'), K18: 'Sin monto',
      L19: 250,
      I20: serial('2027-01-08'), K20: 'Fondo de emergencia', L20: 40, M20: 'EUR',
      // 21..59 en blanco (39 filas).
      I60: serial('2027-01-09'), K60: 'Ahorro personal', L60: 10,
      // 61..100 en blanco (40 filas): fin de la tabla.
      L101: 5,
    });
    expect(contribs).toEqual([
      // No es el libro de la versión 1 (sus tarjetas son otras): estos nombres no se cambian.
      { date: '2027-01-05', goalName: 'Viaje a Turquía', amount: 3000, cur: 'USD' },
      { date: '2027-01-06', goalName: 'Meta nueva & rara', amount: 15000, cur: 'DOP' },
      // Sin fecha → primer día del último mes; sin meta → "Personal savings"; sin moneda → USD.
      { date: '2027-01-01', goalName: 'Personal savings', amount: 250, cur: 'USD' },
      { date: '2027-01-08', goalName: 'Fondo de emergencia', amount: 40, cur: 'DOP' },
      { date: '2027-01-09', goalName: 'Ahorro personal', amount: 10, cur: 'USD' },
    ]);
    expect(goals).toEqual([planned('Viaje largo', 2500, '2026-08', '2027-10')]);
  });

  it('meta con plan: si sus datos no se pueden leer o no forman un plan, queda como de aportes variables', () => {
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
      // El fin antes del inicio.
      { J12: 3000, L12: serial('2027-10-01'), N12: serial('2026-08-01') },
      { J12: { raw: '<c r="J12" t="e"><v>#REF!</v></c>' }, L12: serial('2026-08-01'), N12: serial('2027-10-01') },
    ];
    for (const cells of unreadable) expect(goal(cells), JSON.stringify(cells)).toEqual([variable('Viaje')]);
  });

  it('una tarjeta sin nombre no es una meta; una hoja sin tarjetas no tiene metas', () => {
    expect(savings({ J12: 3000, L12: serial('2026-08-01'), N12: serial('2027-10-01'), B7: 'Aportes variables', B8: 120 })).toEqual({
      contribs: [],
      goals: [],
    });
    expect(savings({ B1: 'Finanzas personales' })).toEqual({ contribs: [], goals: [] });
    expect(savings({ B6: '   ', E6: 2027, I6: true }).goals).toEqual([variable('2027'), variable('TRUE')]);
  });

  it('las metas con plan solo están en el hueco ancho: en los estrechos no se leen datos de plan', () => {
    const { goals } = savings({ B6: 'Sin plan', B12: 3000, D12: serial('2026-08-01'), J12: 3000, L12: serial('2026-08-01'), N12: serial('2027-10-01') });
    expect(goals).toEqual([variable('Sin plan')]);
  });

  it('varias bandas: la tabla de aportes se localiza por su encabezado y las tarjetas se leen banda a banda', () => {
    const cells = shiftedSavings('en');
    expect(savings(cells, { sheet: 'Savings' })).toEqual({ contribs: SHIFTED_CONTRIBS, goals: SHIFTED_GOALS });

    // Lo que hay por debajo de la última banda no son tarjetas, aunque caiga donde iría la siguiente.
    expect(savings({ ...cells, B30: 'Income by month', I30: 'Contributions', B38: 'March 2027', I38: 46000 }, { sheet: 'Savings' }).goals).toEqual(SHIFTED_GOALS);
  });

  it('sin el encabezado de los aportes vale la disposición original: una banda y aportes desde la fila 16', () => {
    const { contribs, goals } = savings({
      B6: 'Emergency', I6: 'Trip', J12: 100, L12: serial('2027-01-01'), N12: serial('2027-12-01'),
      // Parecería una segunda banda, pero sin encabezado no hay forma de saberlo.
      B14: 'No es una tarjeta',
      I16: serial('2027-01-05'), K16: 'Trip', L16: 100, M16: 'USD',
    });
    expect(goals).toEqual([variable('Emergency'), planned('Trip', 100, '2027-01', '2027-12')]);
    expect(contribs).toEqual([{ date: '2027-01-05', goalName: 'Trip', amount: 100, cur: 'USD' }]);
  });

  it('el encabezado de los aportes es "fecha" en I y "meta" en K a la vez; una tarjeta que se llame así no lo es', () => {
    const { contribs, goals } = savings({
      I6: 'Fecha', J12: 10, L12: serial('2027-01-01'), N12: serial('2027-02-01'),
      B14: 'Meta', I14: 'Date', K14: 'Otra cosa',
      I23: 'Date', K23: 'Hedef',
      I24: serial('2027-01-05'), K24: 'Fecha', L24: 7,
    });
    expect(goals).toEqual([planned('Fecha', 10, '2027-01', '2027-02'), variable('Meta'), variable('Date')]);
    expect(contribs).toEqual([{ date: '2027-01-05', goalName: 'Fecha', amount: 7, cur: 'USD' }]);
  });

  it('orden de las metas: el de la lista de Config; las que no nombra, al final; un nombre sin tarjeta no es meta', () => {
    const cells: Record<string, TestCell> = {
      B6: 'A', E6: 'B', I6: 'C', J12: 1, L12: serial('2027-01-01'), N12: serial('2027-01-01'),
      B14: 'D', E14: 'A', I14: 'E', J20: 2, L20: serial('2027-01-01'), N20: serial('2027-03-01'),
      I23: 'Fecha', K23: 'Meta',
    };
    const names = (config?: string[]) => savings(cells, { config }).goals!.map((g) => `${g.name}${g.monthlyUSD ?? ''}`);
    // Sin Config (o con la lista vacía): banda a banda; en cada una, los dos huecos estrechos y luego el ancho.
    expect(names()).toEqual(['A', 'B', 'C1', 'D', 'A', 'E2']);
    expect(names([])).toEqual(['A', 'B', 'C1', 'D', 'A', 'E2']);
    expect(names(['E', 'C', 'D', 'B', 'A', 'A'])).toEqual(['E2', 'C1', 'D', 'B', 'A', 'A']);
    // Con espacios de más en la lista, un nombre que no tiene tarjeta y dos tarjetas que la lista no nombra.
    expect(names([' C ', 'Sin tarjeta', 'A', 'E'])).toEqual(['C1', 'A', 'E2', 'B', 'D', 'A']);
  });
});

// ── LibreOffice ──────────────────────────────────────────────────────────────

/** Los meses de ejemplo con ocho metas en cuatro bandas: el libro del fixture de abajo. */
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

describe('libro de la app guardado por LibreOffice', () => {
  // import-libreoffice-bands.fixture.xlsx es `bandsData()` exportado en turco, y abierto, recalculado y guardado
  // por LibreOffice. Para volver a generarlo si cambia el exportador (necesita soffice en el PATH o en SOFFICE):
  //   UPDATE_IMPORT_FIXTURES=1 npx vitest run shared/excel/import.test.ts
  // Sin esa variable este paso ni se registra: no es una prueba.
  if (process.env.UPDATE_IMPORT_FIXTURES) {
    it('regenera el fixture', () => {
      const dir = mkdtempSync(join(tmpdir(), 'fe-finance-import-'));
      try {
        const source = join(dir, 'bands.xlsx');
        writeFileSync(source, buildFinanzasXlsx(bandsData(), { locale: EXCEL_LOCALES.tr }));
        const out = join(dir, 'out');
        execFileSync(
          process.env.SOFFICE ?? 'soffice',
          // Perfil propio (no toca el del usuario); sin ventanas ni puertos.
          ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(join(dir, 'profile')).href}`, '--convert-to', 'xlsx', '--outdir', out, source],
          { stdio: 'pipe', timeout: 150_000 },
        );
        writeFileSync(fileURLToPath(BANDS_FIXTURE), readFileSync(join(out, 'bands.xlsx')));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);
  }

  it('en turco y con cuatro bandas de metas: se lee igual que el libro recién exportado', () => {
    expect(existsSync(BANDS_FIXTURE)).toBe(true);
    const saved = new Uint8Array(readFileSync(BANDS_FIXTURE));
    const data = bandsData();

    // Comprueba la premisa: es lo que guarda LibreOffice (comprimido y con las fórmulas ya calculadas), el
    // libro está en turco y la tabla de aportes está 24 filas más abajo que en el diseño original.
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

// ── Archivos inválidos ───────────────────────────────────────────────────────

describe('archivos inválidos', () => {
  it('bytes que no son un zip → ImportError not_xlsx', () => {
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
      // Según dónde se rompa: no se puede abrir como zip, o se abre pero dentro no hay un libro.
      expect(['The file is not a valid .xlsx.', 'The file is not an Excel workbook (.xlsx).'], name).toContain(error.message);
    }
    expect(importError(() => parseFinanzasXlsx(cases.texto!)).message).toBe('The file is not a valid .xlsx.');
  });

  it('.xls antiguo o .xlsx con contraseña (contenedor OLE) → ImportError que lo explica', () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const error = importError(() => parseFinanzasXlsx(ole));
    expect(error.code).toBe('old_format');
    expect(error.message).toMatch(/old \.xls or is password-protected/);
  });

  it('un zip que no es un libro → ImportError not_xlsx', () => {
    for (const bytes of [zip({ 'hola.txt': 'hola' }), zip({ mimetype: 'application/vnd.oasis.opendocument.spreadsheet', 'content.xml': '<x/>' })]) {
      const error = importError(() => parseFinanzasXlsx(bytes));
      expect(error.code).toBe('not_xlsx');
      expect(error.message).toBe('The file is not an Excel workbook (.xlsx).');
    }
  });

  it('un libro válido sin hojas de mes, en ningún idioma → ImportError no_month_sheets', () => {
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

  it('una hoja que declara un tamaño descomprimido enorme → ImportError too_large sin llegar a inflarla', () => {
    const bytes = xlsx([['Enero 2027', sheetXml(HEADERS)]]);
    // Tamaño sin comprimir (offset 24) en la entrada del directorio central de la hoja.
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

  it('un libro al que le falta la parte de una hoja (de mes, de ahorros o Config) → ImportError damaged', () => {
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

  it('ImportError: sin código es "unreadable"; con código y causa, los conserva', () => {
    // Así lo crean las pruebas de otras capas: solo con el mensaje.
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
