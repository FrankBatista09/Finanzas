// Solo para pruebas (export-*.test.ts): abre un .xlsx y deja ver sus partes, celdas y textos, sea el que
// genera el exportador o ese mismo libro recalculado y guardado por LibreOffice. No es un lector de Excel
// general (para eso está import-xlsx.ts): entiende lo justo de esos dos orígenes, y a propósito no comparte
// código con el importador, para que las pruebas del exportador no dependan de él.

import { strFromU8, unzipSync } from 'fflate';

/** Partes del zip (ruta → texto), en el orden en que están en el archivo. */
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
 * Comprueba que `xml` está bien formado; devuelve el primer problema o null. Es más estricto que la norma en
 * una cosa: no admite '>' sin escapar dentro de un atributo (el exportador siempre lo escapa).
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

// ── Libro ────────────────────────────────────────────────────────────────────

export interface TestCell {
  ref: string;
  /** Índice de estilo (atributo s). */
  style: number | null;
  /** Atributo t: 's' texto compartido, 'str' texto de una fórmula, 'e' error, 'b' booleano; null = número. */
  type: string | null;
  /** Fórmula sin el '=', si la celda tiene. */
  formula: string | null;
  /** Texto, número o booleano de la celda; null si no guarda valor (nuestras fórmulas no lo guardan). */
  value: string | number | boolean | null;
}

export interface TestSheet {
  name: string;
  /** Ruta de la parte: xl/worksheets/sheetN.xml. */
  path: string;
  xml: string;
  cells: Map<string, TestCell>;
  /** Rangos combinados ("B8:D8"), en el orden del archivo. */
  merges: string[];
  /** Alto de las filas que lo fijan, por número de fila. */
  rowHeights: Map<number, number>;
  /** Desplegables: rango y fórmula de la lista. */
  validations: { sqref: string; formula: string }[];
  /** Formatos condicionales: rango y prioridad de cada regla. */
  conditional: { sqref: string; priorities: number[] }[];
}

export interface TestTable {
  name: string;
  /** Rango de la tabla, encabezado incluido ("I15:O33"). */
  ref: string;
  columns: string[];
  /** Fórmula de cada columna calculada, por nombre de columna. */
  formulas: Map<string, string>;
}

export interface TestBook {
  parts: Map<string, string>;
  /** Textos compartidos, cada uno con sus tramos unidos. */
  strings: string[];
  sheets: TestSheet[];
  tables: TestTable[];
  sheet(name: string): TestSheet;
  table(name: string): TestTable;
}

const attrsOf = (s: string) =>
  new Map([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1]!, unescapeXml(m[2]!)] as const));

/** Texto de un <si> o de un <is>: sus <t>, unidos. */
const runsText = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]!)).join('');

function readSheet(name: string, path: string, xml: string, strings: readonly string[]): TestSheet {
  const cells = new Map<string, TestCell>();
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const a = attrsOf(m[1]!);
    const inner = m[2] ?? '';
    const ref = a.get('r');
    if (!ref) continue;
    const type = a.get('t') ?? null;
    // LibreOffice escribe las fórmulas compartidas como <f t="shared" si="0"/>: hay fórmula, aunque sin texto.
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

/** Abre un .xlsx. Las hojas salen en el orden del libro; cada una se localiza por su relación (rId). */
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

// ── Fórmulas ─────────────────────────────────────────────────────────────────

/** Contenido de los literales de texto de una fórmula ("…"), con las comillas dobladas ya resueltas. */
export function formulaLiterals(formula: string): string[] {
  return [...formula.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
}

/** La fórmula sin sus literales de texto: lo que queda son referencias, funciones y operadores. */
export function withoutLiterals(formula: string): string {
  return formula.replace(/"(?:[^"]|"")*"/g, '""');
}

/** Todas las fórmulas del libro: celdas, columnas calculadas, desplegables y formatos condicionales. */
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
