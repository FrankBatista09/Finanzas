// For tests only (export-*.test.ts): opens an .xlsx and exposes its parts, cells and texts, whether it is the
// one the exporter generates or that same workbook recalculated and saved by LibreOffice. It is not a general
// Excel reader (import-xlsx.ts is for that): it understands just enough of those two sources, and on purpose
// shares no code with the importer, so that the exporter's tests do not depend on it.

import { strFromU8, unzipSync } from 'fflate';

/** Parts of the zip (path → text), in the order they are in the file. */
export function unzipText(bytes: Uint8Array): Map<string, string> {
  const parts = new Map<string, string>();
  for (const [name, data] of Object.entries(unzipSync(bytes))) parts.set(name, strFromU8(data));
  return parts;
}

export function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
  });
}

/**
 * Checks that `xml` is well formed; returns the first problem or null. It is stricter than the standard in
 * one respect: it does not allow an unescaped '>' inside an attribute (the exporter always escapes it).
 */
export function xmlProblem(xml: string): string | null {
  const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.exec(xml);
  if (bad) return `carácter no permitido en XML (U+${bad[0].charCodeAt(0).toString(16).padStart(4, '0')}) en ${bad.index}`;
  const entity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  if (xml.startsWith('<?xml')) {
    const end = xml.indexOf('?>');
    if (end < 0) return 'declaración XML sin cerrar';
    i = end + 2;
  }
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (entity.test(text)) return `"&" sin escapar en el texto, cerca de ${JSON.stringify(text.slice(0, 60))}`;
    if (text.trim() && !stack.length) return `texto fuera del elemento raíz: ${JSON.stringify(text.slice(0, 60))}`;
    if (lt < 0) break;
    const gt = xml.indexOf('>', lt);
    if (gt < 0) return `etiqueta sin cerrar en ${lt}`;
    const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith('/')) {
      const open = stack.pop();
      if (open !== tag.slice(1)) return `</${tag.slice(1)}> cierra <${open ?? '(nada)'}>`;
    } else {
      const m = /^([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)$/.exec(tag);
      if (!m) return `etiqueta mal formada: <${tag.slice(0, 80)}>`;
      const names = [...m[2]!.matchAll(/\s([A-Za-z_][\w:.-]*)="([^"]*)"/g)];
      if (new Set(names.map((a) => a[1])).size !== names.length) return `atributo repetido en <${tag.slice(0, 80)}>`;
      if (names.some((a) => entity.test(a[2]!))) return `"&" sin escapar en un atributo de <${tag.slice(0, 80)}>`;
      if (!stack.length) roots++;
      if (!m[3]) stack.push(m[1]!);
    }
    i = gt + 1;
  }
  if (stack.length) return `sin cerrar: <${stack[stack.length - 1]}>`;
  if (roots !== 1) return `${roots} elementos raíz`;
  return null;
}

// ── Workbook ─────────────────────────────────────────────────────────────────

export interface TestCell {
  ref: string;
  /** Style index (the s attribute). */
  style: number | null;
  /** The t attribute: 's' shared string, 'str' text of a formula, 'e' error, 'b' boolean; null = number. */
  type: string | null;
  /** Formula without the '=', if the cell has one. */
  formula: string | null;
  /** The cell's text, number or boolean; null if it stores no value (our formulas do not store one). */
  value: string | number | boolean | null;
}

export interface TestSheet {
  name: string;
  /** Path of the part: xl/worksheets/sheetN.xml. */
  path: string;
  xml: string;
  cells: Map<string, TestCell>;
  /** Merged ranges ("B8:D8"), in file order. */
  merges: string[];
  /** Height of the rows that set one, by row number. */
  rowHeights: Map<number, number>;
  /** Dropdowns: range and formula of the list. */
  validations: { sqref: string; formula: string }[];
  /** Conditional formats: range and priority of each rule. */
  conditional: { sqref: string; priorities: number[] }[];
}

export interface TestTable {
  name: string;
  /** Range of the table, header included ("I15:O33"). */
  ref: string;
  columns: string[];
  /** Formula of each calculated column, by column name. */
  formulas: Map<string, string>;
}

export interface TestBook {
  parts: Map<string, string>;
  /** Shared strings, each with its runs joined. */
  strings: string[];
  sheets: TestSheet[];
  tables: TestTable[];
  sheet(name: string): TestSheet;
  table(name: string): TestTable;
}

const attrsOf = (s: string) =>
  new Map([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1]!, unescapeXml(m[2]!)] as const));

/** Text of an <si> or an <is>: its <t> elements, joined. */
const runsText = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]!)).join('');

function readSheet(name: string, path: string, xml: string, strings: readonly string[]): TestSheet {
  const cells = new Map<string, TestCell>();
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const a = attrsOf(m[1]!);
    const inner = m[2] ?? '';
    const ref = a.get('r');
    if (!ref) continue;
    const type = a.get('t') ?? null;
    // LibreOffice writes shared formulas as <f t="shared" si="0"/>: there is a formula, though without text.
    const f = /<f(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
    const raw = v ? unescapeXml(v[1]!) : null;
    let value: TestCell['value'] = null;
    if (type === 'inlineStr') value = runsText(inner);
    else if (raw === null) value = null;
    else if (type === 's') value = strings[+raw] ?? null;
    else if (type === 'str' || type === 'e') value = raw;
    else if (type === 'b') value = raw === '1';
    else value = Number(raw);
    cells.set(ref, { ref, style: a.has('s') ? +a.get('s')! : null, type, formula: f ? unescapeXml(f[1] ?? '') : null, value });
  }
  const rowHeights = new Map<number, number>();
  for (const m of xml.matchAll(/<row\b([^>]*)>/g)) {
    const a = attrsOf(m[1]!);
    if (a.has('ht')) rowHeights.set(+a.get('r')!, +a.get('ht')!);
  }
  return {
    name,
    path,
    xml,
    cells,
    merges: [...xml.matchAll(/<mergeCell ref="([^"]*)"\/>/g)].map((m) => m[1]!),
    rowHeights,
    validations: [...xml.matchAll(/<dataValidation\b[^>]*sqref="([^"]*)"[^>]*>\s*<formula1>([\s\S]*?)<\/formula1>/g)].map((m) => ({
      sqref: m[1]!,
      formula: unescapeXml(m[2]!),
    })),
    conditional: [...xml.matchAll(/<conditionalFormatting sqref="([^"]*)">([\s\S]*?)<\/conditionalFormatting>/g)].map((m) => ({
      sqref: m[1]!,
      priorities: [...m[2]!.matchAll(/priority="(\d+)"/g)].map((p) => +p[1]!),
    })),
  };
}

function readTable(xml: string): TestTable {
  const head = attrsOf(/<table\b([^>]*)>/.exec(xml)?.[1] ?? '');
  const columns: string[] = [];
  const formulas = new Map<string, string>();
  for (const m of xml.matchAll(/<tableColumn\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tableColumn>)/g)) {
    const name = attrsOf(m[1]!).get('name') ?? '';
    columns.push(name);
    const f = /<calculatedColumnFormula>([\s\S]*?)<\/calculatedColumnFormula>/.exec(m[2] ?? '');
    if (f) formulas.set(name, unescapeXml(f[1]!));
  }
  return { name: head.get('name') ?? '', ref: head.get('ref') ?? '', columns, formulas };
}

/** Opens an .xlsx. Sheets come out in workbook order; each one is located by its relationship (rId). */
export function readBook(bytes: Uint8Array): TestBook {
  const parts = unzipText(bytes);
  const part = (path: string) => {
    const xml = parts.get(path);
    if (xml === undefined) throw new Error(`Missing part: ${path}`);
    return xml;
  };
  const sst = parts.get('xl/sharedStrings.xml') ?? '';
  const strings = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runsText(m[1]!));
  const targets = new Map(
    [...part('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/>/g)].map((m) => {
      const a = attrsOf(m[1]!);
      return [a.get('Id')!, a.get('Target')!.replace(/^\/?(xl\/)?/, 'xl/')] as const;
    }),
  );
  const sheets = [...part('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/>/g)].map((m) => {
    const a = attrsOf(m[1]!);
    const path = targets.get(a.get('r:id')!)!;
    return readSheet(a.get('name')!, path, part(path), strings);
  });
  const tables = [...parts.keys()].filter((p) => /^xl\/tables\/table\d+\.xml$/.test(p)).map((p) => readTable(part(p)));
  const find = <T extends { name: string }>(list: T[], kind: string, name: string): T => {
    const hit = list.find((x) => x.name === name);
    if (!hit) throw new Error(`No ${kind} named "${name}" (there are: ${list.map((x) => x.name).join(', ')})`);
    return hit;
  };
  return { parts, strings, sheets, tables, sheet: (name) => find(sheets, 'sheet', name), table: (name) => find(tables, 'table', name) };
}

// ── Formulas ─────────────────────────────────────────────────────────────────

/** Contents of a formula's text literals ("…"), with doubled quotes already resolved. */
export function formulaLiterals(formula: string): string[] {
  return [...formula.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
}

/** The formula without its text literals: what is left is references, functions and operators. */
export function withoutLiterals(formula: string): string {
  return formula.replace(/"(?:[^"]|"")*"/g, '""');
}

/** Every formula in the workbook: cells, calculated columns, dropdowns and conditional formats. */
export function bookFormulas(book: TestBook): string[] {
  const out: string[] = [];
  for (const sh of book.sheets) {
    for (const c of sh.cells.values()) if (c.formula !== null) out.push(c.formula);
    for (const v of sh.validations) out.push(v.formula);
    for (const m of sh.xml.matchAll(/<formula>([\s\S]*?)<\/formula>/g)) out.push(unescapeXml(m[1]!));
  }
  for (const t of book.tables) out.push(...t.formulas.values());
  return out;
}
