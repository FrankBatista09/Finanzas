// Abre un .xlsx (zip + SpreadsheetML) y devuelve los valores de las celdas de las hojas pedidas.
// Sustituye a SheetJS, que el prototipo cargaba desde un CDN. Solo lee lo que el importador usa:
// nombres de hoja, valores (no estilos ni fórmulas) y el sistema de fechas del libro.
//
// Tiene que entender lo que escriben Excel, Numbers y LibreOffice al guardar, no solo nuestro exportador:
// entradas comprimidas, hojas cuyo archivo no sigue el orden de las pestañas, cadenas compartidas con
// formato, cadenas en línea, celdas sin referencia, etc.

import { unzipSync } from 'fflate';
import { ImportError } from './import-error';
import { decodeOoxmlEscapes, XmlScanner } from './import-xml';

export type CellValue = string | number | boolean;

/** Límites de una hoja de Excel (XFD1048576). Lo que caiga fuera se ignora. */
const MAX_COLS = 16384;
const MAX_ROWS = 1048576;

/**
 * Tope de XML descomprimido por lectura. Un libro real son unos pocos MB (una hoja con 5,000 transacciones
 * ronda los 3 MB); más que esto es un archivo corrupto o hostil, y en un Worker agotaría la memoria.
 */
const MAX_XML_BYTES = 64 * 1024 * 1024;

const ROOT_RELS = '_rels/.rels';
const DEFAULT_WORKBOOK = 'xl/workbook.xml';

// Los mensajes van en inglés, como los de la API; el código (import-error.ts) es lo que permite traducirlos.
const notXlsx = (cause?: unknown) =>
  new ImportError('The file is not a valid .xlsx.', cause === undefined ? { code: 'not_xlsx' } : { code: 'not_xlsx', cause });

const missingSheet = (name: string) =>
  new ImportError(`The .xlsx is damaged: sheet "${name}" cannot be found.`, { code: 'damaged' });

/** 'A' → 0, 'Z' → 25, 'AA' → 26. */
function colIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + ((letters.charCodeAt(i) | 32) - 96);
  return n - 1;
}

/** Celdas con valor de una hoja. Las vacías (sin valor, cadena vacía, error o fórmula sin calcular) no existen. */
export class SheetCells {
  /** Última fila con algún valor (0 si la hoja está vacía). */
  maxRow = 0;
  private readonly values = new Map<number, CellValue>();

  /** `col` desde 0, `row` desde 1. */
  set(col: number, row: number, value: CellValue): void {
    if (col < 0 || col >= MAX_COLS || row < 1 || row > MAX_ROWS) return;
    this.values.set(row * MAX_COLS + col, value);
    if (row > this.maxRow) this.maxRow = row;
  }

  /** Valor de la celda, p. ej. `get('C', 8)`; undefined si está vacía. */
  get(col: string, row: number): CellValue | undefined {
    return this.values.get(row * MAX_COLS + colIndex(col));
  }
}

export interface XlsxSheet {
  name: string;
  cells: SheetCells;
}

export interface XlsxBook {
  /** true si los seriales de fecha cuentan desde 1904 (libros que vienen de Excel para Mac antiguo). */
  date1904: boolean;
  /** Las hojas pedidas, en el orden de las pestañas. */
  sheets: XlsxSheet[];
}

/** Los nombres de parte de OPC no distinguen mayúsculas; algún generador escribe '\' en vez de '/'. */
function partKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** Resuelve el Target de una relación: absoluto ('/xl/worksheets/sheet1.xml') o relativo a la parte que lo declara. */
function resolveTarget(baseDir: string, target: string): string {
  let t = target;
  if (t.indexOf('%') >= 0) {
    try {
      t = decodeURI(t);
    } catch {
      // Un '%' suelto no es un escape: se deja el texto como está.
    }
  }
  const out: string[] = [];
  for (const seg of (t.startsWith('/') ? t : baseDir + t).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

/** 'xl/workbook.xml' → 'xl/_rels/workbook.xml.rels' */
function relsOf(path: string): string {
  const dir = dirOf(path);
  return `${dir}_rels/${path.slice(dir.length)}.rels`;
}

function decodeXml(bytes: Uint8Array): string {
  // OPC admite UTF-8 y UTF-16; en la práctica todos escriben UTF-8. TextDecoder quita el BOM.
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  return new TextDecoder(utf16 ?? 'utf-8').decode(bytes);
}

/** Descomprime solo las partes pedidas (el resto del zip —gráficos, estilos, imágenes— ni se toca). */
function unzipParts(bytes: Uint8Array, paths: readonly string[]): Map<string, string> {
  const wanted = new Set(paths.map(partKey));
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (!wanted.has(partKey(file.name))) return false;
        // fflate reserva el tamaño declarado antes de inflar: se corta aquí para no pedir gigas de memoria.
        total += file.originalSize;
        if (!(total <= MAX_XML_BYTES)) throw new ImportError('The file is too large to import.', { code: 'too_large' });
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw notXlsx(e);
  }
  const out = new Map<string, string>();
  for (const name of Object.keys(files)) out.set(partKey(name), decodeXml(files[name]!));
  return out;
}

interface Relationship {
  type: string;
  target: string;
}

function parseRels(xml: string): Map<string, Relationship> {
  const out = new Map<string, Relationship>();
  const sc = new XmlScanner(xml);
  while (sc.next()) {
    if (sc.name !== 'Relationship' || sc.kind === 'close') continue;
    const a = sc.attrs();
    // Las relaciones externas (vínculos a otros archivos) no son partes del paquete.
    if (a.Id === undefined || a.Target === undefined || a.TargetMode === 'External') continue;
    out.set(a.Id, { type: a.Type ?? '', target: a.Target });
  }
  return out;
}

/** Compara por el final del tipo: así valen tanto los libros normales como los "Strict Open XML" (otra URL base). */
function isType(rel: Relationship, kind: string): boolean {
  return rel.type.endsWith(`/${kind}`);
}

interface WorkbookInfo {
  date1904: boolean;
  sheets: { name: string; rid: string }[];
}

function parseWorkbook(xml: string): WorkbookInfo {
  const info: WorkbookInfo = { date1904: false, sheets: [] };
  const sc = new XmlScanner(xml);
  let inSheets = false;
  while (sc.next()) {
    if (sc.name === 'sheets') {
      inSheets = sc.kind === 'open';
    } else if (sc.kind === 'close') {
      continue;
    } else if (sc.name === 'workbookPr') {
      const v = sc.attrs().date1904;
      info.date1904 = v === '1' || v === 'true';
    } else if (inSheets && sc.name === 'sheet') {
      const a = sc.attrs();
      // El id de la relación va en otro espacio de nombres; el prefijo suele ser 'r' pero es libre.
      let rid = a['r:id'];
      if (rid === undefined) for (const k in a) if (k.endsWith(':id')) rid = a[k];
      if (a.name !== undefined && rid !== undefined) info.sheets.push({ name: a.name, rid });
    }
  }
  return info;
}

/**
 * Texto de un <si> (cadena compartida) o <is> (cadena en línea): une los <t>, vengan sueltos o en
 * tramos con formato <r>, y descarta la guía fonética <rPh> (lectura en japonés, no es parte del texto).
 */
function readRichText(sc: XmlScanner, end: string): string {
  let out = '';
  let phonetic = false;
  while (sc.next()) {
    if (sc.name === 'rPh') {
      phonetic = sc.kind === 'open';
    } else if (sc.kind === 'close') {
      if (sc.name === end) break;
    } else if (sc.name === 't' && sc.kind === 'open') {
      const t = sc.text();
      if (!phonetic) out += decodeOoxmlEscapes(t);
    }
  }
  return out;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const sc = new XmlScanner(xml);
  while (sc.next()) {
    if (sc.name !== 'si' || sc.kind === 'close') continue;
    out.push(sc.kind === 'empty' ? '' : readRichText(sc, 'si'));
  }
  return out;
}

function parseSheet(xml: string, sst: readonly string[]): SheetCells {
  const cells = new SheetCells();
  const sc = new XmlScanner(xml);
  let inData = false;
  // Posición implícita: una fila o celda sin atributo r va justo después de la anterior.
  let row = 0;
  let col = -1;
  // Celda <c> abierta, a la espera de su </c>.
  let open = false;
  let type = '';
  let cellRow = 0;
  let cellCol = 0;
  let v: string | undefined;
  let inline: string | undefined;

  const finish = (): void => {
    if (!open) return;
    open = false;
    let value: CellValue | undefined;
    switch (type) {
      case 's': {
        // Índice en sharedStrings.xml. (Number('') es 0: un <v> vacío no debe leerse como la primera cadena.)
        const t = v?.trim();
        value = t ? sst[Number(t)] : undefined;
        break;
      }
      case 'inlineStr':
        value = inline ?? (v === undefined ? undefined : decodeOoxmlEscapes(v));
        break;
      case 'str':
        // Resultado de texto de una fórmula.
        value = v === undefined ? undefined : decodeOoxmlEscapes(v);
        break;
      case 'd':
        // Fecha ISO 8601 (libros "Strict"); se entrega como texto y el importador la interpreta.
        value = v?.trim();
        break;
      case 'b': {
        const t = v?.trim().toLowerCase();
        value = t === undefined || t === '' ? undefined : t === '1' || t === 'true';
        break;
      }
      case 'e':
        // #N/A, #DIV/0!…: para importar es una celda vacía.
        break;
      default: {
        // Número (t="n" o sin tipo). Una fórmula sin valor en caché —las que escribe nuestro exportador— no trae <v>.
        const t = v?.trim();
        if (t !== undefined && t !== '') {
          const n = Number(t);
          value = Number.isFinite(n) ? n : decodeOoxmlEscapes(v!);
        } else if (inline !== undefined) {
          value = inline;
        }
      }
    }
    if (value !== undefined && value !== '') cells.set(cellCol, cellRow, value);
  };

  while (sc.next()) {
    const name = sc.name;
    if (!inData) {
      if (name !== 'sheetData') continue;
      if (sc.kind !== 'open') break;
      inData = true;
    } else if (sc.kind === 'close') {
      if (name === 'c') finish();
      else if (name === 'sheetData') break;
    } else if (name === 'row') {
      finish();
      const r = Number(sc.attrs().r);
      row = r >= 1 ? Math.floor(r) : row + 1;
      col = -1;
    } else if (name === 'c') {
      finish();
      const a = sc.attrs();
      cellRow = row;
      cellCol = col + 1;
      const ref = a.r;
      if (ref !== undefined) {
        // "AB12" → columna y fila, sin regex ni subcadenas (se ejecuta una vez por celda).
        let i = 0;
        let c = 0;
        for (; i < ref.length; i++) {
          const ch = ref.charCodeAt(i) | 32;
          if (ch < 97 || ch > 122) break;
          c = c * 26 + (ch - 96);
        }
        let r = 0;
        for (; i < ref.length; i++) {
          const d = ref.charCodeAt(i) - 48;
          if (d < 0 || d > 9) {
            r = 0;
            break;
          }
          r = r * 10 + d;
        }
        if (c > 0 && r > 0) {
          cellCol = c - 1;
          cellRow = r;
        }
      }
      col = cellCol;
      if (sc.kind === 'open') {
        open = true;
        type = a.t ?? '';
        v = undefined;
        inline = undefined;
      }
    } else if (open && sc.kind === 'open') {
      if (name === 'v') v = sc.text();
      else if (name === 'is') inline = readRichText(sc, 'is');
    }
  }
  finish();
  return cells;
}

/**
 * Lee el libro y devuelve las hojas de cálculo cuyo nombre acepta `wanted`.
 * Lanza ImportError si los bytes no son un zip o el zip no es un libro de Excel.
 */
export function readXlsx(bytes: Uint8Array, wanted: (sheetName: string) => boolean): XlsxBook {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    // Contenedor OLE: el formato binario antiguo, o un .xlsx cifrado con contraseña.
    throw new ImportError('The file is an old .xls or is password-protected. Save it as .xlsx without a password.', {
      code: 'old_format',
    });
  }
  // 22 bytes es el zip más pequeño posible (solo el registro de fin del directorio).
  if (bytes.length < 22) throw notXlsx();

  // La ubicación del libro la dan las relaciones raíz; casi siempre es xl/workbook.xml, que se pide de una vez.
  const first = unzipParts(bytes, [ROOT_RELS, DEFAULT_WORKBOOK, relsOf(DEFAULT_WORKBOOK)]);
  let wbPath = DEFAULT_WORKBOOK;
  const rootRels = first.get(partKey(ROOT_RELS));
  if (rootRels !== undefined) {
    for (const rel of parseRels(rootRels).values()) {
      if (isType(rel, 'officeDocument')) wbPath = resolveTarget('', rel.target);
    }
  }
  let wbXml = first.get(partKey(wbPath));
  let wbRels = first.get(partKey(relsOf(wbPath)));
  if (wbXml === undefined && wbPath !== DEFAULT_WORKBOOK) {
    const more = unzipParts(bytes, [wbPath, relsOf(wbPath)]);
    wbXml = more.get(partKey(wbPath));
    wbRels = more.get(partKey(relsOf(wbPath)));
  }
  if (wbXml === undefined) throw new ImportError('The file is not an Excel workbook (.xlsx).', { code: 'not_xlsx' });

  const info = parseWorkbook(wbXml);
  const rels = wbRels === undefined ? new Map<string, Relationship>() : parseRels(wbRels);
  const baseDir = dirOf(wbPath);

  // La hoja se localiza por su relación, nunca por su posición: sheet1.xml no tiene por qué ser la primera pestaña.
  const picked: { name: string; path: string }[] = [];
  for (const sheet of info.sheets) {
    if (!wanted(sheet.name)) continue;
    const rel = rels.get(sheet.rid);
    if (rel === undefined) throw missingSheet(sheet.name);
    // Una hoja de gráfico o de macros no tiene celdas.
    if (!isType(rel, 'worksheet')) continue;
    picked.push({ name: sheet.name, path: resolveTarget(baseDir, rel.target) });
  }
  if (!picked.length) return { date1904: info.date1904, sheets: [] };

  let sstPath = resolveTarget(baseDir, 'sharedStrings.xml');
  for (const rel of rels.values()) if (isType(rel, 'sharedStrings')) sstPath = resolveTarget(baseDir, rel.target);

  const parts = unzipParts(bytes, [sstPath, ...picked.map((p) => p.path)]);
  const sstXml = parts.get(partKey(sstPath));
  const sst = sstXml === undefined ? [] : parseSharedStrings(sstXml);
  return {
    date1904: info.date1904,
    sheets: picked.map(({ name, path }) => {
      const xml = parts.get(partKey(path));
      if (xml === undefined) throw missingSheet(name);
      return { name, cells: parseSheet(xml, sst) };
    }),
  };
}
