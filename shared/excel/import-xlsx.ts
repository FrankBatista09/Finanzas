// Opens an .xlsx (zip + SpreadsheetML) and returns the cell values of the requested sheets.
// It replaces SheetJS, which the prototype loaded from a CDN. It reads only what the importer uses:
// sheet names, values (no styles or formulas) and the workbook's date system.
//
// It has to understand what Excel, Numbers and LibreOffice write when saving, not only our exporter:
// compressed entries, sheets whose file does not follow the tab order, shared strings with
// formatting, inline strings, cells without a reference, etc.

import { unzipSync } from 'fflate';
import { ImportError } from './import-error';
import { decodeOoxmlEscapes, XmlScanner } from './import-xml';

export type CellValue = string | number | boolean;

/** Limits of an Excel sheet (XFD1048576). Anything that falls outside is ignored. */
const MAX_COLS = 16384;
const MAX_ROWS = 1048576;

/**
 * Cap on uncompressed XML per read. A real workbook is a few MB (a sheet with 5,000 transactions
 * is around 3 MB); more than this is a corrupt or hostile file, and in a Worker it would exhaust memory.
 */
const MAX_XML_BYTES = 64 * 1024 * 1024;

const ROOT_RELS = '_rels/.rels';
const DEFAULT_WORKBOOK = 'xl/workbook.xml';

// The messages are in English, like the API's; the code (import-error.ts) is what makes them translatable.
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

/** A sheet's cells with a value. Empty ones (no value, empty string, error or uncalculated formula) do not exist. */
export class SheetCells {
  /** Last row with any value (0 if the sheet is empty). */
  maxRow = 0;
  private readonly values = new Map<number, CellValue>();

  /** `col` from 0, `row` from 1. */
  set(col: number, row: number, value: CellValue): void {
    if (col < 0 || col >= MAX_COLS || row < 1 || row > MAX_ROWS) return;
    this.values.set(row * MAX_COLS + col, value);
    if (row > this.maxRow) this.maxRow = row;
  }

  /** The cell's value, e.g. `get('C', 8)`; undefined if it is empty. */
  get(col: string, row: number): CellValue | undefined {
    return this.values.get(row * MAX_COLS + colIndex(col));
  }
}

export interface XlsxSheet {
  name: string;
  cells: SheetCells;
}

export interface XlsxBook {
  /** true if date serials count from 1904 (workbooks that come from old Excel for Mac). */
  date1904: boolean;
  /** The requested sheets, in tab order. */
  sheets: XlsxSheet[];
}

/** OPC part names are case-insensitive; some generators write '\' instead of '/'. */
function partKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** Resolves a relationship Target: absolute ('/xl/worksheets/sheet1.xml') or relative to the part that declares it. */
function resolveTarget(baseDir: string, target: string): string {
  let t = target;
  if (t.indexOf('%') >= 0) {
    try {
      t = decodeURI(t);
    } catch {
      // A stray '%' is not an escape: the text is left as is.
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
  // OPC allows UTF-8 and UTF-16; in practice everyone writes UTF-8. TextDecoder strips the BOM.
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  return new TextDecoder(utf16 ?? 'utf-8').decode(bytes);
}

/** Decompresses only the requested parts (the rest of the zip—charts, styles, images—is not even touched). */
function unzipParts(bytes: Uint8Array, paths: readonly string[]): Map<string, string> {
  const wanted = new Set(paths.map(partKey));
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (!wanted.has(partKey(file.name))) return false;
        // fflate allocates the declared size before inflating: it is cut off here to avoid requesting gigs of memory.
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
    // External relationships (links to other files) are not parts of the package.
    if (a.Id === undefined || a.Target === undefined || a.TargetMode === 'External') continue;
    out.set(a.Id, { type: a.Type ?? '', target: a.Target });
  }
  return out;
}

/** Compares by the end of the type, so both regular workbooks and "Strict Open XML" ones (another base URL) match. */
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
      // The relationship id lives in another namespace; the prefix is usually 'r' but can be anything.
      let rid = a['r:id'];
      if (rid === undefined) for (const k in a) if (k.endsWith(':id')) rid = a[k];
      if (a.name !== undefined && rid !== undefined) info.sheets.push({ name: a.name, rid });
    }
  }
  return info;
}

/**
 * Text of an <si> (shared string) or <is> (inline string): joins the <t> elements, whether they come on their own
 * or in formatted runs <r>, and drops the phonetic guide <rPh> (Japanese reading, not part of the text).
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
  // Implicit position: a row or cell without an r attribute goes right after the previous one.
  let row = 0;
  let col = -1;
  // Open <c> cell, waiting for its </c>.
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
        // Index into sharedStrings.xml. (Number('') is 0: an empty <v> must not be read as the first string.)
        const t = v?.trim();
        value = t ? sst[Number(t)] : undefined;
        break;
      }
      case 'inlineStr':
        value = inline ?? (v === undefined ? undefined : decodeOoxmlEscapes(v));
        break;
      case 'str':
        // Text result of a formula.
        value = v === undefined ? undefined : decodeOoxmlEscapes(v);
        break;
      case 'd':
        // ISO 8601 date ("Strict" workbooks); it is returned as text and the importer interprets it.
        value = v?.trim();
        break;
      case 'b': {
        const t = v?.trim().toLowerCase();
        value = t === undefined || t === '' ? undefined : t === '1' || t === 'true';
        break;
      }
      case 'e':
        // #N/A, #DIV/0!…: for import purposes it is an empty cell.
        break;
      default: {
        // Number (t="n" or no type). A formula with no cached value—the kind our exporter writes—has no <v>.
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
        // "AB12" → column and row, without regex or substrings (it runs once per cell).
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
 * Reads the workbook and returns the worksheets whose name `wanted` accepts.
 * Throws ImportError if the bytes are not a zip or the zip is not an Excel workbook.
 */
export function readXlsx(bytes: Uint8Array, wanted: (sheetName: string) => boolean): XlsxBook {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    // OLE container: the old binary format, or a password-encrypted .xlsx.
    throw new ImportError('The file is an old .xls or is password-protected. Save it as .xlsx without a password.', {
      code: 'old_format',
    });
  }
  // 22 bytes is the smallest possible zip (only the end-of-directory record).
  if (bytes.length < 22) throw notXlsx();

  // The root relationships give the workbook's location; it is almost always xl/workbook.xml, requested right away.
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

  // The sheet is located by its relationship, never by its position: sheet1.xml does not have to be the first tab.
  const picked: { name: string; path: string }[] = [];
  for (const sheet of info.sheets) {
    if (!wanted(sheet.name)) continue;
    const rel = rels.get(sheet.rid);
    if (rel === undefined) throw missingSheet(sheet.name);
    // A chart sheet or a macro sheet has no cells.
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
