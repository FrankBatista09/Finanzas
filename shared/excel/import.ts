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

// ── Idiomas ──────────────────────────────────────────────────────────────────
// El libro puede venir en cualquiera de los idiomas de la app (y todos los anteriores a esos idiomas, en
// español). Cada cosa que se reconoce por su texto —hojas, encabezados, el "Sí" de Pagado— se compara con
// los textos de los tres ExcelLocale a la vez, no con los de un idioma elegido para todo el libro: así
// también se lee un libro que los mezcla (una hoja renombrada, una tabla pegada de otro archivo).

const LOCALES = Object.values(EXCEL_LOCALES);

/** Sin espacios sobrantes y en forma compuesta, para que "Vía" sea igual venga como venga escrito. */
const tidy = (s: string) => s.trim().normalize('NFC');

/** Sin tildes y en minúsculas: "Sí", "SI" y " si " son lo mismo. */
const fold = (s: string) => s.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Los textos que puede tener un mismo sitio del libro, uno por idioma. */
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
 * Una función de texto a texto que recuerda lo que ya respondió. canonicalCat y canonicalMethod recorren las
 * listas de los tres idiomas en cada llamada, y en una hoja las mismas pocas categorías se repiten miles de
 * veces. El tope evita que crezca sin fin con categorías escritas a mano, distintas en cada fila.
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

/** El libro trae categorías y métodos en su idioma; se guardan con el nombre canónico. Lo que no es de la lista queda igual. */
const toCat = remembering(canonicalCat);
const toMethod = remembering(canonicalMethod);

// ── Valores por defecto ──────────────────────────────────────────────────────

/** Presupuesto cuando la celda O6 está vacía (la plantilla sin datos), igual que en el prototipo. */
const DEFAULT_BUDGET = 70000;

/** Meta a la que el prototipo asignaba un aporte sin meta: la de ahorro personal. */
const FALLBACK_GOAL = DEFAULT_GOALS.find((g) => g.id === 'personal')?.name ?? 'Personal savings';

/**
 * Las tres metas fijas del libro de la versión 1 (siempre en español) y la meta de hoy que le corresponde a
 * cada una: las dos con las que arranca un usuario y la del viaje. Solo en un libro con esa forma se cambia el
 * nombre de una meta (ver `isLegacyBook`); en cualquier otro, el nombre es un dato del usuario y no se toca.
 * Se exporta para el servidor: al aplicar la importación, quien conserva una meta con el nombre de entonces
 * la sigue usando (server/db.ts applyImport).
 */
export const LEGACY_GOALS: readonly (readonly [before: string, now: string])[] = [
  ['Fondo de emergencia', DEFAULT_GOALS.find((g) => g.id === 'emergency')?.name ?? 'Emergency fund'],
  ['Ahorro personal', FALLBACK_GOAL],
  ['Viaje a Turquía', 'Trip to Turkey'],
];

// ── Hoja de ahorros ──────────────────────────────────────────────────────────
// La disposición es la del exportador (export.ts `savingsSheet` y export-goals.ts).

/** Fila del encabezado de la tabla de aportes en el diseño original (una sola banda de tarjetas). */
const CONTRIB_HEAD = BAND_TOP + BAND_ROWS + 1;
/** Hasta cuántas bandas de tarjetas se busca ese encabezado. La API admite 200 metas; esto va muy sobrado. */
const MAX_BANDS = 1000;
/** Dentro de una banda, fila de los tres datos de una meta con plan: aporte (J), inicio (L) y fin (N). */
const PLAN_ROW = 6;
/** Lista de metas de la hoja Config (el desplegable de los aportes): columna G, de la fila 4 hacia abajo. */
const CONFIG_GOALS_ROW = 4;
const CONFIG_GOALS_MAX = 5000;

/** Filas seguidas sin datos que dan por terminada una tabla. */
const TX_GAP = 40;
const TRANSFER_GAP = 80;
const CONTRIB_GAP = 40;

/** Ningún número ni fecha escritos como texto pasa de este largo; lo demás ni se intenta interpretar. */
const MAX_LITERAL = 40;

// Número escrito como texto: "1337.15", "1,337.15", "-20", "1e3". Coma solo como separador de miles (formato es-DO).
const NUM_TEXT_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d*)?|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/;
// Fechas escritas como texto. La forma con el día primero es la que usa la hoja (dd/mm/yyyy).
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

/** El texto tal como está en la celda; lo que solo son espacios cuenta como vacío. */
function toText(v: CellValue | undefined): string {
  if (typeof v === 'string') return v.trim() === '' ? '' : v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return '';
}

/** "Sí", "Yes" o "Evet", con o sin tilde y en cualquier combinación de mayúsculas; también una casilla marcada (Numbers). */
function isYes(v: CellValue | undefined): boolean {
  if (typeof v === 'boolean') return v;
  return typeof v === 'string' && YES.has(fold(v));
}

/** `empty` es la moneda por defecto de la tabla cuando la celda está vacía; cualquier otro texto es DOP. */
function toCurrency(v: CellValue | undefined, empty: Currency): Currency {
  const t = toText(v).trim().toUpperCase();
  if (t === '') return empty;
  return t === 'USD' ? 'USD' : 'DOP';
}

/**
 * Serial de Excel → fecha, con la misma cuenta que `iso()` en el prototipo (25569 es el 1970-01-01).
 * En el sistema 1904 los seriales empiezan 1462 días después.
 */
function serialToISO(serial: number, date1904: boolean): ISODate | null {
  const days = date1904 ? serial + 1462 : serial;
  // Fuera de 1900-01-01..9999-12-31 no es una fecha de Excel (y toISOString fallaría).
  if (!(days >= 1 && days < 2958466)) return null;
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

/** Mes de una celda de fecha (inicio y fin de una meta con plan, con formato mm/yyyy). */
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

/** ¿Tiene la celda uno de esos textos de encabezado? */
function isHeader(sheet: SheetCells, col: string, row: number, names: ReadonlySet<string>): boolean {
  const v = sheet.get(col, row);
  return typeof v === 'string' && names.has(tidy(v));
}

function readMonth(sheet: SheetCells, key: MonthKey, closed: boolean, date1904: boolean): ImportMonth {
  const g = (col: string, row: number) => sheet.get(col, row);
  const firstDay = `${key}-01`;

  // Las tablas se localizan por sus encabezados: con más de 15 fijos o más de 5 envíos el historial baja.
  // Vale la primera fila que coincide: más abajo, un gasto que se llame "Item" o "Concepto" es un gasto.
  // Si no aparecen, valen las filas del diseño original.
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

  // Gastos mensuales: entre su encabezado y el del historial. Una fila cuenta si tiene concepto y monto.
  const fixed: ImportMonth['fixed'] = [];
  for (let r = fh + 1; r < th; r++) {
    const name = toText(g('C', r));
    const amount = toNumber(g('E', r));
    if (name === '' || amount === null) continue;
    fixed.push({ name, day: toText(g('D', r)), amount, cur: toCurrency(g('F', r), 'DOP'), paid: isYes(g('B', r)) });
  }

  // Envíos: una fila cuenta si tiene USD. El prototipo miraba 80 filas fijas; aquí se sigue mientras haya datos.
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
      // La vía es texto libre: va como esté escrita.
      via: toText(g('N', r)) || VIAS[0],
      usd,
      rate: toNumber(g('P', r)) ?? 0,
    });
  }

  // Historial: una fila cuenta si tiene descripción o un monto numérico. Las filas en blanco del final de la
  // tabla (o intercaladas) no son transacciones; tras 40 seguidas se da la tabla por terminada.
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
 * Tarjetas de metas, en el orden de la hoja: banda a banda y, dentro de cada una, los dos huecos estrechos
 * (metas de aportes variables) y el ancho (meta con plan). El nombre está en la primera celda del hueco; un
 * hueco sin nombre está vacío. Si los datos del plan no se pueden leer o no forman un plan (aporte que no es
 * mayor que cero, falta una fecha, el fin va antes del inicio), la meta queda como de aportes variables: es
 * el mismo criterio con el que el exportador decide qué tarjeta dibuja (`goalPlan`).
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
 * Las metas en el orden de la lista de Config, que es el orden en que las tenía el usuario: en la hoja de
 * ahorros, una meta con plan y otra sin plan de la misma banda no dicen cuál iba primero. Las tarjetas que
 * la lista no nombra van al final, en el orden de la hoja; un nombre de la lista sin tarjeta no es una meta.
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
    // Con nombres repetidos, cada aparición en la lista se lleva la siguiente tarjeta con ese nombre.
    const card = byName.get(tidy(toText(config.get('G', r))))?.shift();
    if (card) listed.add(card);
  }
  return [...listed, ...cards.filter((card) => !listed.has(card))];
}

/**
 * ¿Es el libro de la versión 1? Aquel exportador solo sabía dibujar tres metas, siempre las mismas y en
 * español; cualquier libro de hoy con otras metas, o en otro idioma, se distingue de él. (Uno de hoy en
 * español con exactamente esas tres metas es, byte a byte, el de antes: no hay forma de distinguirlo.)
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

  // La tabla de aportes baja 8 filas por cada banda de tarjetas de más: se localiza por su encabezado
  // (Fecha en I, Meta en K) y, de paso, su fila dice cuántas bandas hay. Si no aparece, vale la del diseño original.
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

  // Aportes: fecha en I, meta en K, monto en L, moneda en M. Cuenta la fila que tiene monto.
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
      // El exportador y el prototipo dan por USD el aporte sin moneda.
      cur: toCurrency(g('M', r), 'USD'),
    });
  }

  const goals = inConfigOrder(cards, config);
  if (isLegacyBook(name, bands, cards)) {
    // Así, al importar un libro de la versión 1, sus aportes caen en las metas con las que arranca el usuario.
    const renamed = new Map(LEGACY_GOALS);
    for (const goal of goals) goal.name = renamed.get(tidy(goal.name)) ?? goal.name;
    for (const c of contribs) c.goalName = renamed.get(tidy(c.goalName)) ?? c.goalName;
  }
  return { contribs, goals };
}

/**
 * Lee un .xlsx con el formato de la app, esté en el idioma que esté (inglés, español o turco, o una mezcla).
 * Localiza las tablas por sus encabezados (p. ej. "Item", "Date"+"Via", "Date"+"Description") y las tarjetas de
 * metas por su sitio en la hoja de ahorros. Equivale a `importExcel()` del prototipo, pero devuelve datos ya
 * normalizados y sin idioma (números, fechas ISO, moneda DOP/USD, categorías y métodos con su nombre
 * canónico) y sin ids. Los textos que escribió el usuario salen tal cual.
 *
 * Lanza ImportError (mensaje en inglés y `code` estable) si los bytes no son un .xlsx o el libro no tiene
 * hojas de mes ("October 2026", "Octubre 2026", "Ekim 2026").
 */
export function parseFinanzasXlsx(bytes: Uint8Array): ImportPayload {
  try {
    const monthKeyOf = (name: string) => keyFromLabel(tidy(name));
    const isSavings = (name: string) => SAVINGS_SHEETS.has(tidy(name));
    const isConfig = (name: string) => tidy(name) === CONFIG_SHEET;
    const book = readXlsx(bytes, (name) => monthKeyOf(name) !== null || isSavings(name) || isConfig(name));

    // Si dos hojas dan el mismo mes ("Octubre 2026" y "October 2026"), vale la última, como en el prototipo.
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

    // Todos los meses quedan cerrados salvo el último, que pasa a ser el mes en curso.
    const lastKey = keys[keys.length - 1]!;
    const months = keys.map((key) => readMonth(byKey.get(key)!, key, key !== lastKey, book.date1904));

    // Un aporte sin fecha legible se anota en el mes en curso.
    const { contribs, goals } = savings
      ? readSavings(savings, config, book.date1904, `${lastKey}-01`)
      : { contribs: null, goals: null };
    return { months, contribs, goals };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    // Los bytes vienen de un archivo del usuario: cualquier otra falla al leerlos es un archivo ilegible.
    throw new ImportError('Could not read the file.', { code: 'unreadable', cause: e });
  }
}
