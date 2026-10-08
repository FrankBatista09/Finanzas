// Idiomas del libro de Excel: los tres ExcelLocale tienen las mismas claves y nombres que Excel acepta, el
// libro en inglés y en turco no lleva ningún texto en español, y los tres idiomas dan el mismo libro salvo
// por los textos (mismas partes, celdas, estilos y fórmulas).
// Que el libro en español sea el del diseño original lo comprueba export.test.ts byte a byte.

import { describe, expect, it } from 'vitest';
import { frozenExportData } from '../../tests/reference-export';
import { APP_NAME, CATS, METHODS } from '../constants';
import { CAT_NAMES, FIXED_CATEGORY_NAMES, LANGUAGES, METHOD_NAMES, MONTH_NAMES } from '../i18n';
import { keyFromLabel } from '../month';
import type { Language } from '../types';
import { CONFIG_SHEET, EXCEL_EN, EXCEL_ES, EXCEL_LOCALES, EXCEL_TR, buildFinanzasXlsx, excelLocale } from './export';
import type { ExcelLocale } from './export';
import { parseFinanzasXlsx } from './import';
import {
  bookFormulas,
  formulaLiterals,
  readBook,
  unescapeXml,
  unzipText,
  withoutLiterals,
  xmlProblem,
} from './export-testkit';
import type { TestBook } from './export-testkit';
import * as localeModule from './locale';
import type { ExportData } from './types';

const LANGS: Language[] = ['en', 'es', 'tr'];

/**
 * Las categorías que lista el libro (Config y "Por categoría"): las diez del diseño original, para que el libro
 * en español siga saliendo byte a byte como el de referencia. "Other", la undécima, no está en esas listas.
 */
const LISTED_CATS = 10;

/**
 * Lo mismo con los métodos: Config lista los tres del diseño original, con sus nombres de entonces. Los de hoy
 * (débito, crédito, efectivo…) se escriben en las filas, y al importar la tarjeta de entonces vale por la de débito.
 */
const LISTED_METHODS: Record<Language, readonly string[]> = {
  en: ['Card', 'Transfer', 'Bank app'],
  es: ['Tarjeta', 'Transferencia', 'App del banco'],
  tr: ['Kart', 'Havale', 'Banka uygulaması'],
};

/** Frases de fórmula: listas de trozos de texto, alguno de los cuales puede ir vacío. */
const PHRASES = [
  'month.pctUsed',
  'month.ofBudget',
  'month.fixedMeta',
  'month.average',
  'month.txMeta',
  'savings.contribCount',
  'savings.perMonth',
  'savings.remaining',
  'savings.pctOfTarget',
  'savings.target',
  'savings.total',
];
/** Las demás listas de un idioma. */
const LISTS = ['months', 'cats', 'methods', 'savings.incomeCols'];

/** Todos los textos de un idioma, por ruta ('month.fixedMeta.2'). `lang` no es un texto del libro. */
function leaves(locale: ExcelLocale): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') out.set(path, value);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    } else throw new Error(`Unexpected value at ${path}: ${String(value)}`);
  };
  const { lang: _lang, ...texts } = locale;
  walk(texts, '');
  return out;
}

/** Rutas de las listas de un idioma, con su largo. */
function lists(locale: ExcelLocale): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) out.set(path, value.length);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(locale, '');
  return out;
}

const isPhrasePart = (path: string) => PHRASES.some((p) => path.startsWith(`${p}.`));

/**
 * Datos de ejemplo (en inglés, con categorías y métodos canónicos) más texto del usuario en español y valores
 * fuera de las listas, que tienen que salir tal cual en cualquier idioma. Dos bandas de metas.
 */
function sampleData(): ExportData {
  const data = frozenExportData('en');
  // La entrada congelada es de cuando había una sola tarjeta ('Card'): aquí va con el método de hoy.
  for (const m of data.months) for (const t of m.tx) if (t.method === 'Card') t.method = 'Debit card';
  const oct = data.months[data.months.length - 1]!;
  oct.fixed.push({ name: 'Colegio', day: 'fin de mes', amount: 3000, cur: 'DOP', paid: false });
  oct.transfers.push({ date: '2026-10-06', via: 'Banco Popular', usd: 200, rate: 58.9 });
  oct.tx.push(
    { date: '2026-10-08', desc: 'Compra semanal', place: 'Veterinaria', cat: 'Mascotas', method: 'Cheque', amount: 950, cur: 'DOP', notes: 'Comida del perro' },
    // 'Comida' es la categoría Food en español, pero no es el valor canónico: es texto del usuario y no se traduce.
    { date: '2026-10-09', desc: 'Almuerzo', place: 'Adrian Tropical', cat: 'Comida', method: 'Tarjeta', amount: 1150, cur: 'DOP', notes: '' },
    // "Other" es una categoría de la app que el libro no lista en Config: su fila se escribe traducida igualmente.
    { date: '2026-10-10', desc: 'Regalo', place: 'Librería Cuesta', cat: 'Other', method: 'Debit card', amount: 500, cur: 'DOP', notes: '' },
    // Métodos de la app que el libro tampoco lista en Config.
    { date: '2026-10-11', desc: 'Zapatos', place: 'Ágora Mall', cat: 'Clothing', method: 'Credit card', amount: 2800, cur: 'DOP', notes: '' },
    { date: '2026-10-12', desc: 'Colmado', place: '', cat: 'Groceries', method: 'Cash', amount: 300, cur: 'DOP', notes: '' },
  );
  data.goals.push(
    { name: 'Ahorros', monthlyUSD: null, start: null, end: null },
    { name: 'Viaje a Turquía', monthlyUSD: 250, start: '2026-09', end: '2027-02' },
  );
  data.contribs.push(
    { date: '2026-10-08', goalName: 'Ahorros', amount: 100, cur: 'USD' },
    { date: '2026-10-08', goalName: 'Viaje a Turquía', amount: 14690, cur: 'DOP' },
  );
  return data;
}

/** Todo el texto que escribió el usuario en `data`. */
function userTexts(data: ExportData): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') out.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(data);
  return out;
}

const tableKey = (name: string) => name.replace(/_\d{4}_\d{2}$/, '');

/**
 * Todos los textos del libro, uno por uno: celdas (y cada tramo de un texto enriquecido), literales de las
 * fórmulas, nombres de tabla (sin el sufijo del mes), de columna, de hoja y de función, y los textos, nombres
 * e idioma de los dibujos y gráficos.
 */
function bookTexts(book: TestBook): Set<string> {
  const texts = new Set<string>();
  const add = (s: string) => void texts.add(s);
  book.strings.forEach(add);
  for (const m of (book.parts.get('xl/sharedStrings.xml') ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
    add(unescapeXml(m[1]!));
  }
  for (const f of bookFormulas(book)) {
    for (const literal of formulaLiterals(f)) {
      add(literal);
      // Las listas de los desplegables: "Sí,No".
      literal.split(',').forEach(add);
    }
    const bare = withoutLiterals(f);
    for (const m of bare.matchAll(/([A-Za-z_][\w.]*)\[/g)) add(tableKey(m[1]!));
    for (const m of bare.matchAll(/\[([^[\]]+)\]/g)) add(m[1]!);
    for (const m of bare.matchAll(/([A-Z][A-Z0-9.]*)\(/g)) add(m[1]!);
  }
  for (const t of book.tables) {
    add(tableKey(t.name));
    t.columns.forEach(add);
  }
  for (const sh of book.sheets) {
    add(sh.name);
    add(sh.name.replace(/ \d{4}$/, ''));
  }
  for (const [path, xml] of book.parts) {
    if (path.startsWith('xl/drawings/drawing')) {
      for (const m of xml.matchAll(/ name="([^"]*)"/g)) add(unescapeXml(m[1]!).replace(/ \d+$/, ''));
      for (const m of xml.matchAll(/ lang="([^"]*)"/g)) add(m[1]!);
      for (const m of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) add(unescapeXml(m[1]!));
    }
    if (path.startsWith('xl/charts/chart')) {
      for (const m of xml.matchAll(/<c:v>([\s\S]*?)<\/c:v>/g)) add(unescapeXml(m[1]!));
    }
  }
  return texts;
}

const build = (data: ExportData, lang: Language) => buildFinanzasXlsx(data, { locale: EXCEL_LOCALES[lang], currentKey: '2026-10' });

// ── Los idiomas ──────────────────────────────────────────────────────────────

describe('ExcelLocale', () => {
  it('hay uno por idioma de la app, con los nombres acordados', () => {
    expect(Object.keys(EXCEL_LOCALES).sort()).toEqual(LANGUAGES.map((l) => l.id).sort());
    expect(EXCEL_LOCALES).toEqual({ en: EXCEL_EN, es: EXCEL_ES, tr: EXCEL_TR });
    for (const lang of LANGS) {
      expect(EXCEL_LOCALES[lang].lang).toBe(lang);
      expect(excelLocale(lang)).toBe(EXCEL_LOCALES[lang]);
    }
    // Un idioma desconocido (datos viejos, un valor corrupto) cae en inglés, el idioma por defecto.
    expect(excelLocale('fr' as Language)).toBe(EXCEL_EN);
    expect(excelLocale(undefined as unknown as Language)).toBe(EXCEL_EN);
    // locale.ts y export.ts exportan los mismos objetos.
    expect(localeModule.EXCEL_EN).toBe(EXCEL_EN);
    expect(localeModule.EXCEL_ES).toBe(EXCEL_ES);
    expect(localeModule.EXCEL_TR).toBe(EXCEL_TR);
    expect(localeModule.excelLocale).toBe(excelLocale);
  });

  it('los tres tienen exactamente las mismas claves y listas del mismo largo', () => {
    const keys = (l: ExcelLocale) => [...leaves(l).keys()].sort();
    expect(keys(EXCEL_ES).length).toBeGreaterThan(100);
    expect(keys(EXCEL_EN)).toEqual(keys(EXCEL_ES));
    expect(keys(EXCEL_TR)).toEqual(keys(EXCEL_ES));
    expect(lists(EXCEL_EN)).toEqual(lists(EXCEL_ES));
    expect(lists(EXCEL_TR)).toEqual(lists(EXCEL_ES));
    expect([...lists(EXCEL_ES).keys()].sort()).toEqual([...PHRASES, ...LISTS].sort());
    expect(lists(EXCEL_ES).get('months')).toBe(12);
    expect(lists(EXCEL_ES).get('cats')).toBe(LISTED_CATS);
    expect(CATS).toHaveLength(LISTED_CATS + 1);
    expect(lists(EXCEL_ES).get('methods')).toBe(3);
    expect(METHODS).toHaveLength(5);
  });

  it.each(LANGS)('%s: ningún texto vacío ni con espacios sobrantes; cada frase dice algo', (lang) => {
    const L = EXCEL_LOCALES[lang];
    for (const [path, text] of leaves(L)) {
      if (isPhrasePart(path)) continue;
      expect(text, path).not.toBe('');
      expect(text, path).toBe(text.trim());
    }
    for (const phrase of PHRASES) {
      const parts = [...leaves(L)].filter(([path]) => path.startsWith(`${phrase}.`)).map(([, text]) => text);
      expect(parts.some((p) => p.trim() !== ''), phrase).toBe(true);
    }
  });

  it.each(LANGS)('%s: meses y categorías son los de shared/i18n; los métodos de la lista, los tres del diseño original', (lang) => {
    const L = EXCEL_LOCALES[lang];
    expect(L.months).toBe(MONTH_NAMES[lang]);
    expect(L.cats).toEqual(CAT_NAMES[lang].slice(0, LISTED_CATS));
    expect(CATS[LISTED_CATS]).toBe('Other');
    expect(L.methods).toEqual(LISTED_METHODS[lang]);
    expect(L.methods).not.toEqual(METHOD_NAMES[lang]);
    expect(L.month.fixedCategory).toBe(FIXED_CATEGORY_NAMES[lang]);
  });

  it('la marca: "Finanzas personales" en español, como en el diseño; el nombre de la app en los demás', () => {
    expect(EXCEL_ES.brand).toBe('Finanzas personales');
    expect(EXCEL_EN.brand).toBe(APP_NAME);
    expect(EXCEL_TR.brand).toBe(APP_NAME);
  });

  it('la hoja de ahorros: Ahorros / Savings / Birikimler; Config no cambia', () => {
    expect(LANGS.map((lang) => EXCEL_LOCALES[lang].sheets.savings)).toEqual(['Savings', 'Ahorros', 'Birikimler']);
    expect(CONFIG_SHEET).toBe('Config');
  });

  it.each(LANGS)('%s: nombres de hoja que Excel acepta y que se pueden volver a leer como un mes', (lang) => {
    const L = EXCEL_LOCALES[lang];
    const valid = (name: string) => name.length > 0 && name.length <= 31 && !/[:\\/?*[\]]/.test(name) && !/^'|'$/.test(name);
    expect(valid(L.sheets.savings)).toBe(true);
    expect(new Set(L.months).size).toBe(12);
    L.months.forEach((name, i) => {
      const sheet = `${name} 2026`;
      expect(valid(sheet), sheet).toBe(true);
      // Sin comillas simples: las fórmulas INDIRECT citan la hoja como 'Octubre 2026'.
      expect(name).not.toContain("'");
      expect(name).not.toMatch(/\s/);
      expect(keyFromLabel(sheet), sheet).toBe(`2026-${String(i + 1).padStart(2, '0')}`);
      expect(keyFromLabel(sheet, L.months)).toBe(`2026-${String(i + 1).padStart(2, '0')}`);
    });
    // La hoja de ahorros no se confunde con un mes.
    expect(keyFromLabel(L.sheets.savings)).toBeNull();
  });

  it.each(LANGS)('%s: nombres de tabla que Excel acepta (ASCII, sin espacios, distintos entre sí)', (lang) => {
    const names = Object.values(EXCEL_LOCALES[lang].tables);
    expect(names).toHaveLength(4);
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      // Ni una referencia de celda (A1, R1C1) ni las letras que Excel reserva.
      expect(name).not.toMatch(/^[A-Za-z]{1,3}\d+$/);
      expect(name).not.toMatch(/^(R|C|R\d*C\d*)$/i);
      expect(`${name}_2026_10`.length).toBeLessThan(255);
    }
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it.each(LANGS)('%s: nombres de columna válidos en una referencia estructurada y distintos dentro de cada tabla', (lang) => {
    const c = EXCEL_LOCALES[lang].cols;
    for (const [key, name] of Object.entries(c)) {
      expect(name, key).not.toMatch(/[[\]#'"@]/);
      expect(name, key).toBe(name.trim());
      expect(name.length, key).toBeLessThanOrEqual(255);
    }
    const tables = [
      [c.paid, c.item, c.day, c.amount, c.currency, 'DOP', 'USD'],
      [c.date, c.via, 'USD', c.rate, 'DOP'],
      [c.date, c.description, c.place, c.category, c.method, c.amount, c.currency, 'DOP', 'USD', c.notes],
      [c.date, c.month, c.goal, c.amount, c.currency, 'USD', 'DOP'],
    ];
    for (const columns of tables) {
      expect(new Set(columns.map((n) => n.toLocaleLowerCase(lang))).size, columns.join(' | ')).toBe(columns.length);
    }
  });

  it.each(LANGS)('%s: los valores de "Pagado" caben en una lista "a,b" y en una fórmula', (lang) => {
    const { yes, no } = EXCEL_LOCALES[lang];
    expect(yes).not.toBe(no);
    for (const v of [yes, no]) expect(v).not.toMatch(/[,"]/);
  });

  it('Sí/No, Yes/No, Evet/Hayır', () => {
    expect(LANGS.map((lang) => [EXCEL_LOCALES[lang].yes, EXCEL_LOCALES[lang].no])).toEqual([
      ['Yes', 'No'],
      ['Sí', 'No'],
      ['Evet', 'Hayır'],
    ]);
  });
});

// ── El libro en cada idioma ──────────────────────────────────────────────────

describe('el ayudante de XML detecta un documento mal formado', () => {
  it.each([
    ['<a><b/></a>', null],
    ['<?xml version="1.0"?><a x="1" y="a&amp;b">t &lt; u<b></b></a>', null],
    ['<a><b></a>', /cierra/],
    ['<a>', /sin cerrar/],
    ['<a/><b/>', /2 elementos raíz/],
    ['<a>Tom & Jerry</a>', /"&" sin escapar/],
    ['<a x="Tom & Jerry"/>', /"&" sin escapar/],
    ['<a x="1" x="2"/>', /atributo repetido/],
    ['<a x=1/>', /mal formada/],
    ['<a>\u0001</a>', /no permitido/],
  ] as [string, RegExp | null][])('%s', (xml, problem) => {
    if (problem === null) expect(xmlProblem(xml)).toBeNull();
    else expect(xmlProblem(xml)).toMatch(problem);
  });
});

describe.each(LANGS)('libro en %s', (lang) => {
  const L = EXCEL_LOCALES[lang];
  const data = sampleData();
  const bytes = build(data, lang);
  const book = readBook(bytes);
  const texts = bookTexts(book);
  const oct = book.sheet(`${L.months[9]} 2026`);
  const savings = book.sheet(L.sheets.savings);
  const config = book.sheet(CONFIG_SHEET);

  it('es un zip de XML bien formado', () => {
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(book.parts.size).toBeGreaterThan(20);
    for (const [path, xml] of book.parts) {
      expect(xmlProblem(xml), path).toBeNull();
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), path).toBe(true);
    }
  });

  it('las hojas se llaman como en ese idioma', () => {
    expect(book.sheets.map((s) => s.name)).toEqual([
      `${MONTH_NAMES[lang][7]} 2026`,
      `${MONTH_NAMES[lang][8]} 2026`,
      `${MONTH_NAMES[lang][9]} 2026`,
      L.sheets.savings,
      'Config',
    ]);
    // El mes actual de Config es el nombre de la última hoja de mes: de ahí lo toma INDIRECT.
    expect(config.cells.get('C5')?.value).toBe(`${MONTH_NAMES[lang][9]} 2026`);
    expect(savings.cells.get('D1')?.value).toBe(L.sheets.savings);
    expect(oct.cells.get('B1')?.value).toBe(L.brand);
    expect(savings.cells.get('B1')?.value).toBe(L.brand);
  });

  it('las tablas y sus columnas se llaman como en ese idioma', () => {
    const c = L.cols;
    expect(book.tables.map((t) => t.name)).toEqual([
      ...['2026_08', '2026_09', '2026_10'].flatMap((x) => [`${L.tables.fixed}_${x}`, `${L.tables.transfers}_${x}`, `${L.tables.tx}_${x}`]),
      L.tables.contribs,
    ]);
    expect(book.table(`${L.tables.fixed}_2026_10`).columns).toEqual([c.paid, c.item, c.day, c.amount, c.currency, 'DOP', 'USD']);
    expect(book.table(`${L.tables.transfers}_2026_10`).columns).toEqual([c.date, c.via, 'USD', c.rate, 'DOP']);
    expect(book.table(`${L.tables.tx}_2026_10`).columns).toEqual([
      c.date,
      c.description,
      c.place,
      c.category,
      c.method,
      c.amount,
      c.currency,
      'DOP',
      'USD',
      c.notes,
    ]);
    expect(book.table(L.tables.contribs).columns).toEqual([c.date, c.month, c.goal, c.amount, c.currency, 'USD', 'DOP']);
    // El encabezado de cada tabla, en la hoja, es el nombre de sus columnas.
    expect(['B', 'C', 'D', 'E', 'F', 'G', 'H'].map((col) => oct.cells.get(`${col}15`)?.value)).toEqual(
      book.table(`${L.tables.fixed}_2026_10`).columns,
    );
    // Toda referencia estructurada de una fórmula nombra una tabla y una columna que existen.
    const tables = new Map(book.tables.map((t) => [t.name, new Set(t.columns)]));
    let refs = 0;
    for (const f of bookFormulas(book)) {
      for (const m of withoutLiterals(f).matchAll(/([A-Za-z_][\w.]*)\[(?:\[#This Row\],)?\[?([^[\]]+)\]/g)) {
        expect(tables.has(m[1]!), f).toBe(true);
        expect(tables.get(m[1]!)!.has(m[2]!), f).toBe(true);
        refs++;
      }
    }
    expect(refs).toBeGreaterThan(100);
  });

  it('categorías y métodos se escriben traducidos; lo que no está en las listas, tal cual', () => {
    // Listas de Config y filas de "Por categoría".
    expect(L.cats.map((_, i) => config.cells.get(`E${4 + i}`)?.value)).toEqual(CAT_NAMES[lang].slice(0, LISTED_CATS));
    expect(METHODS.map((_, i) => config.cells.get(`F${4 + i}`)?.value ?? null)).toEqual([...LISTED_METHODS[lang], null, null]);
    expect(oct.cells.get('M15')?.value).toBe(FIXED_CATEGORY_NAMES[lang]);
    expect(L.cats.map((_, i) => oct.cells.get(`M${16 + i}`)?.value)).toEqual(CAT_NAMES[lang].slice(0, LISTED_CATS));

    // Historial de octubre: el encabezado está donde diga la columna Descripción.
    const head = [...oct.cells.values()].find((c) => c.ref.startsWith('C') && c.value === L.cols.description)!;
    const first = +head.ref.slice(1) + 1;
    const row = (i: number) => ['C', 'D', 'E', 'F', 'K'].map((col) => oct.cells.get(`${col}${first + i}`)?.value ?? null);
    const cat = (name: (typeof CATS)[number]) => CAT_NAMES[lang][CATS.indexOf(name)];
    const method = (name: (typeof METHODS)[number]) => METHOD_NAMES[lang][METHODS.indexOf(name)];
    expect(row(0)).toEqual(['Weekly groceries', 'Supermercado Nacional', cat('Groceries'), method('Debit card'), null]);
    expect(row(3)).toEqual(['Movies', 'Caribbean Cinemas', cat('Entertainment'), method('Bank app'), null]);
    expect(row(7)).toEqual(['Compra semanal', 'Veterinaria', 'Mascotas', 'Cheque', 'Comida del perro']);
    expect(row(8)).toEqual(['Almuerzo', 'Adrian Tropical', 'Comida', 'Tarjeta', null]);
    expect(row(9)).toEqual(['Regalo', 'Librería Cuesta', cat('Other'), method('Debit card'), null]);
    expect(row(10)).toEqual(['Zapatos', 'Ágora Mall', cat('Clothing'), method('Credit card'), null]);
    expect(row(11)).toEqual(['Colmado', null, cat('Groceries'), method('Cash'), null]);

    // El método Transfer (agosto) también.
    const aug = book.sheet(`${L.months[7]} 2026`);
    expect([...aug.cells.values()].some((c) => c.ref.startsWith('F') && c.value === method('Transfer'))).toBe(true);
  });

  it('"Other" no está en la lista de Config, pero su fila sale traducida y vuelve como "Other" al importar', () => {
    const other = CAT_NAMES[lang][CATS.indexOf('Other')]!;
    expect(other).toBe({ en: 'Other', es: 'Otros', tr: 'Diğer' }[lang]);
    // Config y "Por categoría" terminan en la décima categoría; el desplegable del historial apunta a esas diez.
    expect(config.cells.get(`E${3 + LISTED_CATS}`)?.value).toBe(CAT_NAMES[lang][LISTED_CATS - 1]);
    expect(config.cells.get(`E${4 + LISTED_CATS}`)?.value ?? null).toBeNull();
    expect(oct.cells.get(`M${16 + LISTED_CATS}`)?.value ?? null).toBeNull();
    expect(oct.validations.map((v) => v.formula)).toContain(`Config!$E$4:$E$${3 + LISTED_CATS}`);
    expect([...config.cells.values()].some((c) => c.value === other)).toBe(false);
    // La fila del historial lleva el nombre en el idioma del libro…
    expect([...oct.cells.values()].filter((c) => c.ref.startsWith('E') && c.value === other)).toHaveLength(1);
    // …y el lector la devuelve con su nombre canónico, sea cual sea el idioma.
    const read = parseFinanzasXlsx(bytes).months.find((m) => m.key === '2026-10')!;
    expect(read.tx.find((x) => x.desc === 'Regalo')).toMatchObject({ cat: 'Other', method: 'Debit card', amount: 500 });
    expect(read.tx.find((x) => x.desc === 'Movies')).toMatchObject({ cat: 'Entertainment' });
  });

  it('Config lista los tres métodos de antes; los de hoy salen traducidos en su fila y vuelven canónicos al importar', () => {
    expect([4, 5, 6, 7].map((r) => config.cells.get(`F${r}`)?.value ?? null)).toEqual([...LISTED_METHODS[lang], null]);
    const names = { en: ['Debit card', 'Credit card', 'Cash'], es: ['Tarjeta de débito', 'Tarjeta de crédito', 'Efectivo'], tr: ['Banka kartı', 'Kredi kartı', 'Nakit'] }[lang];
    expect((['Debit card', 'Credit card', 'Cash'] as const).map((m) => METHOD_NAMES[lang][METHODS.indexOf(m)])).toEqual(names);
    const written = (name: string) => [...oct.cells.values()].filter((c) => c.ref.startsWith('F') && c.value === name).length;
    expect(names.map(written)).toEqual([7, 1, 1]);
    // Ninguno de los nuevos entra en Config.
    for (const name of names) expect([...config.cells.values()].some((c) => c.value === name), name).toBe(false);
    const read = parseFinanzasXlsx(bytes).months.find((m) => m.key === '2026-10')!;
    expect(read.tx.find((x) => x.desc === 'Zapatos')).toMatchObject({ cat: 'Clothing', method: 'Credit card' });
    expect(read.tx.find((x) => x.desc === 'Colmado')).toMatchObject({ cat: 'Groceries', method: 'Cash' });
    expect(read.tx.find((x) => x.desc === 'Weekly groceries')).toMatchObject({ method: 'Debit card' });
    // 'Tarjeta' escrito por el usuario (o elegido de la lista de Config) es la tarjeta de antes: la de débito.
    expect(read.tx.find((x) => x.desc === 'Almuerzo')).toMatchObject({ cat: 'Food', method: 'Debit card' });
  });

  it('la columna "Pagado" lleva los valores de ese idioma, también en su lista y en su formato', () => {
    const paid = data.months[2]!.fixed.map((f) => (f.paid ? L.yes : L.no));
    expect(paid.map((_, i) => oct.cells.get(`B${16 + i}`)?.value)).toEqual(paid);
    expect(oct.validations.find((v) => v.sqref.startsWith('B16:'))?.formula).toBe(`"${L.yes},${L.no}"`);
    expect(oct.xml).toContain(`<formula>"${L.yes}"</formula>`);
    expect(oct.xml).toContain(`<formula>"${L.no}"</formula>`);
    expect(oct.cells.get('T4')?.formula).toBe(
      `SUMIFS(${L.tables.fixed}_2026_10[DOP],${L.tables.fixed}_2026_10[${L.cols.paid}],"${L.yes}")`,
    );
  });

  it('el texto del usuario no se traduce', () => {
    for (const text of ['Colegio', 'fin de mes', 'Banco Popular', 'Compra semanal', 'Comida del perro', 'Ahorros', 'Viaje a Turquía', 'Emergency fund', 'Trip to Turkey']) {
      expect(book.strings, text).toContain(text);
    }
  });

  it('todos los textos del idioma están en el libro', () => {
    for (const [path, text] of leaves(L)) {
      if (text !== '') expect(texts.has(text), `${path}: ${JSON.stringify(text)}`).toBe(true);
    }
  });

  // En el libro en español, claro, sí lo hay: esta comprobación es para los otros dos.
  if (lang === 'es') return;

  it('no queda ningún texto en español', () => {
    const user = userTexts(data);
    const own = new Set(leaves(L).values());
    const spanish = [...new Set(leaves(EXCEL_ES).values())].filter((s) => s.trim() !== '' && !own.has(s) && !user.has(s));
    // Casi todo el español es propio del español: si esta lista se vaciara, la prueba no probaría nada.
    expect(spanish.length).toBeGreaterThan(100);
    expect(spanish).toEqual(expect.arrayContaining(['Octubre', 'Supermercado', 'Sí', 'Aportes', 'Meta', 'Faltan ', 'LOWER', 'es-DO']));
    for (const s of spanish) expect(texts.has(s), JSON.stringify(s)).toBe(false);

    // Y, por si un texto se escribiera en un sitio que `bookTexts` no mira: los textos largos no aparecen en
    // ninguna parte del archivo (salvo los que son parte de un texto del usuario, como "Supermercado Nacional").
    const all = [...book.parts.values()].join('\n');
    const long = spanish.map((s) => s.trim()).filter((s) => s.length >= 8 && ![...user].some((u) => u.includes(s)));
    expect(long.length).toBeGreaterThan(50);
    for (const s of long) expect(all.includes(s) || all.includes(s.replace(/"/g, '&quot;')), JSON.stringify(s)).toBe(false);
  });
});

describe('el idioma por defecto es el inglés', () => {
  it('sin `locale` sale el mismo libro que con EXCEL_EN', () => {
    const data = sampleData();
    expect(Buffer.compare(buildFinanzasXlsx(data), buildFinanzasXlsx(data, { locale: EXCEL_EN }))).toBe(0);
    expect(Buffer.compare(buildFinanzasXlsx(data), buildFinanzasXlsx(data, { locale: EXCEL_ES }))).not.toBe(0);
    expect(readBook(buildFinanzasXlsx(data)).sheets.map((s) => s.name)).toEqual([
      'August 2026',
      'September 2026',
      'October 2026',
      'Savings',
      'Config',
    ]);
  });

  it('la plantilla vacía también sale en el idioma pedido', () => {
    const blank: ExportData = { months: [], goals: [], contribs: [], defaultRate: 58.76 };
    expect(readBook(buildFinanzasXlsx(blank, { currentKey: '2026-10' })).sheets.map((s) => s.name)).toEqual(['October 2026', 'Savings', 'Config']);
    expect(readBook(build(blank, 'tr')).sheets.map((s) => s.name)).toEqual(['Ekim 2026', 'Birikimler', 'Config']);
    expect(readBook(build(blank, 'es')).sheets.map((s) => s.name)).toEqual(['Octubre 2026', 'Ahorros', 'Config']);
  });
});

// ── Misma estructura ─────────────────────────────────────────────────────────

/**
 * El libro sin sus textos: de cada parte se quita lo que depende del idioma (textos de las celdas, literales
 * de las fórmulas, nombres de hoja, tabla y columna, textos de los dibujos) y se deja todo lo demás:
 * direcciones de celda, estilos, fórmulas, rangos, anchos, altos, anclas.
 */
function structure(bytes: Uint8Array, L: ExcelLocale): Map<string, string> {
  const parts = unzipText(bytes);
  const sheetNames = [...parts.get('xl/workbook.xml')!.matchAll(/<sheet name="([^"]*)"/g)].map((m) => unescapeXml(m[1]!));
  const tables = Object.entries(L.tables);
  const cols = new Map(Object.entries(L.cols).map(([key, name]) => [name, key]));
  const table = (name: string) => {
    const hit = tables.find(([, prefix]) => name === prefix || new RegExp(`^${prefix}_\\d{4}_\\d{2}$`).test(name));
    return hit ? `{${hit[0]}}${name.slice(hit[1].length)}` : name;
  };
  const column = (name: string) => (cols.has(name) ? `{${cols.get(name)}}` : name);
  const formula = (escaped: string) => {
    // Los literales quedan en "" y las concatenaciones con ellos desaparecen: "Faltan "&$R$6&" aportes" → $R$6.
    let f = withoutLiterals(unescapeXml(escaped));
    for (let prev = ''; prev !== f; ) {
      prev = f;
      f = f.replace(/""&|&""/g, '');
    }
    f = f.replace(/([A-Za-z_][\w.]*)(?=\[)/g, (name) => table(name));
    f = f.replace(/\[([^[\]]+)\]/g, (_, name: string) => `[${column(name)}]`);
    // La función que pone el mes en minúscula (español) o con mayúscula inicial (inglés, turco).
    return f.replace(new RegExp(`\\b${L.savings.monthCase}\\(CHOOSE\\(`, 'g'), 'CASE(CHOOSE(');
  };
  const out = new Map<string, string>();
  for (const [path, xml] of parts) {
    let s = xml;
    if (path === 'xl/sharedStrings.xml') {
      // Los textos son justo lo que cambia; cuántos hay depende de cuáles coinciden entre sí en cada idioma.
      s = '';
    } else if (path === 'xl/workbook.xml') {
      let n = 0;
      s = s.replace(/<sheet name="[^"]*"/g, () => `<sheet name="{${n++}}"`);
    } else if (path.startsWith('xl/worksheets/sheet')) {
      s = s
        .replace(/t="s"><v>\d+<\/v>/g, 't="s"><v>#</v>')
        .replace(/<(f|formula1|formula)>([\s\S]*?)<\/\1>/g, (_, tag: string, f: string) => `<${tag}>${formula(f)}</${tag}>`);
    } else if (path.startsWith('xl/tables/table')) {
      s = s
        .replace(/ name="([^"]*)" displayName="([^"]*)"/, (_, a: string, b: string) => ` name="${table(a)}" displayName="${table(b)}"`)
        .replace(/<tableColumn id="(\d+)" name="([^"]*)"/g, (_, id: string, name: string) => `<tableColumn id="${id}" name="${column(unescapeXml(name))}"`)
        .replace(/<calculatedColumnFormula>([\s\S]*?)<\/calculatedColumnFormula>/g, (_, f: string) => `<calculatedColumnFormula>${formula(f)}</calculatedColumnFormula>`);
    } else if (path.startsWith('xl/drawings/drawing')) {
      s = s
        .replace(/ lang="[^"]*"/g, ' lang="{lang}"')
        .replace(/ name="[^"]*?( \d+)?"/g, (_, n: string | undefined) => ` name="{name}${n ?? ''}"`)
        .replace(/<a:t>[\s\S]*?<\/a:t>/g, '<a:t>{text}</a:t>');
    } else if (path.startsWith('xl/charts/chart')) {
      s = s
        .replace(/<c:v>[\s\S]*?<\/c:v>/g, '<c:v>{series}</c:v>')
        .replace(/<c:f>'([^']*)'!/g, (_, name: string) => `<c:f>'{${sheetNames.indexOf(name)}}'!`);
    }
    out.set(path, s);
  }
  return out;
}

function expectSameStructure(actual: Map<string, string>, expected: Map<string, string>): void {
  expect([...actual.keys()]).toEqual([...expected.keys()]);
  for (const [path, want] of expected) {
    const got = actual.get(path)!;
    if (got === want) continue;
    let i = 0;
    while (i < got.length && i < want.length && got[i] === want[i]) i++;
    const around = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 100), i + 140));
    expect.fail(`${path} difiere en el carácter ${i}:\n  esperado: ${around(want)}\n  obtenido: ${around(got)}`);
  }
}

describe('los tres idiomas dan el mismo libro salvo por los textos', () => {
  const blank = (): ExportData => ({ months: [], goals: [], contribs: [], defaultRate: 58.76 });
  const cases: [name: string, data: () => ExportData][] = [
    ['datos de ejemplo, con dos bandas de metas', sampleData],
    ['plantilla vacía, sin metas', blank],
    ['solo las metas iniciales', () => ({ ...frozenExportData('en'), goals: frozenExportData('en').goals.slice(0, 2), contribs: [] })],
  ];

  describe.each(cases)('%s', (_name, make) => {
    const data = make();
    const books = Object.fromEntries(LANGS.map((lang) => [lang, build(data, lang)])) as Record<Language, Uint8Array>;

    it('mismas partes, en el mismo orden', () => {
      const names = (lang: Language) => [...unzipText(books[lang]).keys()];
      expect(names('en')).toEqual(names('es'));
      expect(names('tr')).toEqual(names('es'));
    });

    it('mismos estilos: styles.xml es idéntico', () => {
      const styles = (lang: Language) => unzipText(books[lang]).get('xl/styles.xml');
      expect(styles('en')).toBe(styles('es'));
      expect(styles('tr')).toBe(styles('es'));
    });

    it('mismas celdas: dirección, estilo, tipo y cuáles llevan fórmula', () => {
      const shape = (lang: Language) =>
        readBook(books[lang]).sheets.map((sh) => [...sh.cells.values()].map((c) => `${c.ref}|${c.style}|${c.type}|${c.formula !== null}|${typeof c.value}`));
      const es = shape('es');
      expect(es.flat().length).toBeGreaterThan(300);
      expect(shape('en')).toEqual(es);
      expect(shape('tr')).toEqual(es);
    });

    it('mismos números y fechas en las celdas', () => {
      const numbers = (lang: Language) =>
        readBook(books[lang]).sheets.map((sh) => [...sh.cells.values()].filter((c) => typeof c.value === 'number').map((c) => `${c.ref}=${c.value}`));
      expect(numbers('en')).toEqual(numbers('es'));
      expect(numbers('tr')).toEqual(numbers('es'));
    });

    it('mismas fórmulas, rangos, anchos, altos y dibujos una vez quitados los textos', () => {
      const es = structure(books.es, EXCEL_ES);
      expectSameStructure(structure(books.en, EXCEL_EN), es);
      expectSameStructure(structure(books.tr, EXCEL_TR), es);
      // Lo que queda sigue siendo el libro: las fórmulas están ahí, con sus tablas y columnas ya sin idioma.
      const all = [...es.values()].join('\n');
      expect(all).toContain('SUMIFS({contribs}[USD],{contribs}[{month}],B');
      expect(all).toContain('{fixed}_2026_10[[#This Row],[{amount}]]');
      expect(all).not.toMatch(/Aportes|Fijos_|\[Monto\]|Pagado/);
    });
  });

  it('la comparación nota una fórmula distinta', () => {
    const data = sampleData();
    const es = structure(build(data, 'es'), EXCEL_ES);
    const en = structure(build(data, 'en'), EXCEL_EN);
    const path = 'xl/worksheets/sheet4.xml';
    expect(en.get(path)).toContain('<f>$R$5*$R$3</f>');
    en.set(path, en.get(path)!.replace('<f>$R$5*$R$3</f>', '<f>$R$5*$R$4</f>'));
    expect(() => expectSameStructure(en, es)).toThrow(/sheet4\.xml difiere/);
  });
});
