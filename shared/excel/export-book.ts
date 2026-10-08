// Maquinaria OOXML del exportador de Excel: estilos, registros del libro (textos, formatos, tablas), hojas y celdas.
// Port de design_handoff/referencia/excel-export.js. La salida tiene que ser idéntica byte a byte a la del
// script original (ver export.test.ts), así que el orden en que se registran los estilos y los textos
// compartidos es parte del contrato: no reordenar ni "mejorar" el XML.

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

// ── Utilidades ───────────────────────────────────────────────────────────────

/** Escapa texto para XML. No toca las comillas: quien lo ponga en un atributo las escapa aparte. */
export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Índice de columna (0 = A) → letras: 0 → 'A', 26 → 'AA'. */
export function colL(n: number): string {
  let s = '';
  n++;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 'C10' → [2, 10]: columna desde 0, fila desde 1. */
export function parse(ref: string): [col: number, row: number] {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`Referencia de celda inválida: ${ref}`);
  const [, letters = '', digits = ''] = m;
  let c = 0;
  for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [c - 1, +digits];
}

/** 'YYYY-MM-DD' → número de serie de fecha de Excel (días desde 1899-12-30); null si no hay fecha. */
export function serialISO(d: string | null | undefined): number | null {
  if (!d) return null;
  const [y = NaN, m = NaN, dd = NaN] = String(d).split('-').map(Number);
  if (!y) return null;
  return (Date.UTC(y, m - 1, dd || 1) - Date.UTC(1899, 11, 30)) / 86400000;
}

/** Número, o null (celda vacía) si viene vacío, null o no es numérico. */
export function num(v: string | number | null | undefined): number | null {
  return v === '' || v === null || v === undefined || isNaN(+v) ? null : +v;
}

// ── Estilos ──────────────────────────────────────────────────────────────────

// Paleta del diseño (RGB sin '#') y fuente monoespaciada de las cifras.
export const INK = '1D1F1C';
export const MUTED = '6B6D66';
export const SUB = '45473F';
export const LINE = 'E3E1D8';
export const ROWL = 'EEECE5';
export const VL = 'F1EFE9';
export const HEADF = 'F6F5F0';
export const BG = 'EFEEE8';
export const GREEN = '2F7D52';
export const DGREEN = '23613F';
export const DARK = '2B3A33';
export const MONO = 'Consolas';

export interface FontSpec {
  /** Por defecto 'Segoe UI'. */
  readonly name?: string;
  /** Tamaño en puntos; por defecto 10. */
  readonly sz?: number;
  /** Por defecto `INK`. */
  readonly color?: string;
  readonly b?: boolean;
  readonly i?: boolean;
}

/** Color de cada lado con borde fino; sin color, ese lado no lleva borde. */
export interface BorderSpec {
  readonly l?: string;
  readonly r?: string;
  readonly t?: string;
  readonly b?: string;
}

export interface AlignSpec {
  readonly h?: 'left' | 'center' | 'right';
  /** Por defecto 'center'. */
  readonly v?: 'top' | 'center' | 'bottom';
  readonly wrap?: boolean;
  readonly indent?: number;
}

/** Descripción del formato de una celda; `Workbook.xfOf` la convierte en un índice de estilo. */
export interface StyleSpec {
  readonly font?: FontSpec;
  /** Color de relleno sólido. */
  readonly fill?: string;
  readonly border?: BorderSpec;
  /** Código de formato numérico de Excel. */
  readonly numFmt?: string;
  readonly align?: AlignSpec;
}

/**
 * Combina dos estilos: gana `b`, y fuente, borde y alineación se mezclan propiedad a propiedad.
 * Una propiedad presente con valor undefined también pisa a la anterior (así lo hace el original).
 */
export function merge(a: StyleSpec, b: StyleSpec): StyleSpec {
  return {
    ...a,
    ...b,
    font: { ...a.font, ...b.font },
    border: { ...a.border, ...b.border },
    align: { ...a.align, ...b.align },
  };
}

/** Estilos con nombre que se repiten en todas las hojas. */
export const st = {
  band: { fill: INK },
  label: { font: { sz: 8, b: true, color: MUTED } },
  h2: { font: { sz: 12, b: true } },
  meta: { font: { sz: 9, color: MUTED }, align: { h: 'right' } },
  th: { fill: HEADF, font: { sz: 8, b: true, color: MUTED }, border: { t: LINE, b: LINE, r: 'EBE9E2' } },
  thR: {
    fill: HEADF,
    font: { sz: 8, b: true, color: MUTED },
    border: { t: LINE, b: LINE, r: 'EBE9E2' },
    align: { h: 'right' },
  },
  td: { fill: 'FFFFFF', border: { b: ROWL, r: VL } },
  tdNum: {
    fill: 'FFFFFF',
    border: { b: ROWL, r: VL },
    font: { name: MONO, sz: 10 },
    numFmt: '#,##0.00',
    align: { h: 'right' },
  },
  tdDate: {
    fill: 'FFFFFF',
    border: { b: ROWL, r: VL },
    font: { name: MONO, sz: 10, color: SUB },
    numFmt: 'dd/mm/yyyy',
    align: { h: 'left' },
  },
  tdMono: { fill: 'FFFFFF', border: { b: ROWL, r: VL }, font: { name: MONO, sz: 9.5, color: SUB } },
  input: { fill: HEADF, font: { name: MONO, sz: 10 }, numFmt: '#,##0.00', align: { h: 'right' } },
} as const satisfies Record<string, StyleSpec>;

/** Formatos numéricos que Excel trae de fábrica (no se declaran en styles.xml). */
const BUILTIN_NUMFMT: ReadonlyMap<string, number> = new Map([
  ['General', 0],
  ['0', 1],
  ['0.00', 2],
  ['#,##0', 3],
  ['#,##0.00', 4],
  ['0%', 9],
]);

// Formatos diferenciales a los que apuntan las reglas de formato condicional por su índice (dxfId):
// 0 = negativo en rojo, 1 = "Sí" (pagado) en verde, 2 = "No" en gris.
const DXFS =
  '<dxfs count="3">' +
  '<dxf><font><b/><color rgb="FFB23A2A"/></font></dxf>' +
  '<dxf><font><b/><color rgb="FF23613F"/></font><fill><patternFill patternType="solid"><bgColor rgb="FFE6F0E9"/></patternFill></fill></dxf>' +
  '<dxf><font><color rgb="FF9A9C94"/></font></dxf>' +
  '</dxfs>';

// ── Libro ────────────────────────────────────────────────────────────────────

/** Lista sin repetidos: `add` devuelve el índice del valor y lo agrega al final si es nuevo. */
class Registry {
  readonly items: string[] = [];
  private readonly index = new Map<string, number>();

  constructor(initial: readonly string[] = []) {
    for (const x of initial) this.add(x);
  }

  add(x: string): number {
    let i = this.index.get(x);
    if (i === undefined) {
      i = this.items.length;
      this.items.push(x);
      this.index.set(x, i);
    }
    return i;
  }
}

/** Dibujo de una hoja (la dona): su XML y el número del gráfico que enlaza. */
export interface Drawing {
  chart: number;
  xml: string;
}

/**
 * Estado de una exportación: todo lo que comparten las hojas del libro. Se crea uno por llamada
 * (nada de esto puede vivir a nivel de módulo: los Workers reutilizan el isolate entre peticiones).
 */
export class Workbook {
  private readonly sst = new Registry();
  private readonly fonts = new Registry();
  // Excel reserva los dos primeros rellenos.
  private readonly fills = new Registry([
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ]);
  private readonly borders = new Registry();
  private readonly numFmts = new Registry();
  private readonly xfs = new Registry();
  /** XML de cada tabla; el número de la tabla es su posición + 1. */
  readonly tables: string[] = [];
  /** XML de cada gráfico; ídem. */
  readonly charts: string[] = [];
  readonly drawings: Drawing[] = [];

  constructor() {
    // El estilo 0 es el estilo por defecto de las celdas.
    this.xfOf({});
  }

  /** Índice del texto (ya en XML: `<t>…</t>` o `<r>…</r>`) en la tabla de textos compartidos. */
  si(x: string): number {
    return this.sst.add(x);
  }

  /** Índice del estilo de celda (cellXfs) para `sp`; registra fuente, relleno, borde y formato si son nuevos. */
  xfOf(sp: StyleSpec): number {
    const f = { name: 'Segoe UI', sz: 10, color: INK, ...sp.font };
    const fi = this.fonts.add(
      `<font>${f.b ? '<b/>' : ''}${f.i ? '<i/>' : ''}<sz val="${f.sz}"/><color rgb="FF${f.color}"/><name val="${f.name}"/><family val="2"/></font>`,
    );
    const fl = sp.fill
      ? this.fills.add(
          `<fill><patternFill patternType="solid"><fgColor rgb="FF${sp.fill}"/><bgColor indexed="64"/></patternFill></fill>`,
        )
      : 0;
    const b: BorderSpec = sp.border ?? {};
    const sd = (t: string, c: string | undefined) =>
      c ? `<${t} style="thin"><color rgb="FF${c}"/></${t}>` : `<${t}/>`;
    const bi = this.borders.add(
      `<border>${sd('left', b.l)}${sd('right', b.r)}${sd('top', b.t)}${sd('bottom', b.b)}<diagonal/></border>`,
    );
    let nf = 0;
    if (sp.numFmt) nf = BUILTIN_NUMFMT.get(sp.numFmt) ?? 164 + this.numFmts.add(sp.numFmt);
    const a: AlignSpec = sp.align ?? {};
    const al = `<alignment vertical="${a.v || 'center'}"${a.h ? ` horizontal="${a.h}"` : ''}${a.wrap ? ' wrapText="1"' : ''}${a.indent ? ` indent="${a.indent}"` : ''}/>`;
    return this.xfs.add(
      `<xf numFmtId="${nf}" fontId="${fi}" fillId="${fl}" borderId="${bi}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${al}</xf>`,
    );
  }

  /** xl/styles.xml. Hay que generarlo después del XML de todas las hojas, que es donde se registran los estilos. */
  stylesXml(): string {
    const numFmts = this.numFmts.items;
    const fonts = this.fonts.items;
    const fills = this.fills.items;
    const borders = this.borders.items;
    const xfs = this.xfs.items;
    const numFmtsXml = numFmts.length
      ? `<numFmts count="${numFmts.length}">${numFmts
          .map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f).replace(/"/g, '&quot;')}"/>`)
          .join('')}</numFmts>`
      : '';
    return [
      XML_DECL,
      `<styleSheet xmlns="${NS_MAIN}">`,
      numFmtsXml,
      `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`,
      `<fills count="${fills.length}">${fills.join('')}</fills>`,
      `<borders count="${borders.length}">${borders.join('')}</borders>`,
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`,
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
      DXFS,
      '</styleSheet>',
    ].join('');
  }

  /** xl/sharedStrings.xml. También va después del XML de las hojas. */
  sharedStringsXml(): string {
    const sst = this.sst.items;
    return `${XML_DECL}<sst xmlns="${NS_MAIN}" count="${sst.length}" uniqueCount="${sst.length}">${sst
      .map((x) => `<si>${x}</si>`)
      .join('')}</sst>`;
  }
}

// ── Hojas ────────────────────────────────────────────────────────────────────

export interface Formula {
  /** Fórmula sin el '=' inicial. */
  f: string;
}

export interface RichText {
  /** Tramos `<r>…</r>` ya en XML (ver `rich`). */
  rich: string;
}

/** Valor de una celda. null y '' dejan la celda vacía (solo con estilo). */
export type CellValue = string | number | null | Formula | RichText;

interface Cell {
  v: CellValue;
  sp: StyleSpec;
}

export interface TableColumn {
  name: string;
  /** Columna numérica: su encabezado va alineado a la derecha. */
  num?: boolean;
  /** Estilo de las celdas de datos; por defecto `st.td`. */
  st?: StyleSpec;
  /** Fórmula de columna calculada: todas las filas llevan esta fórmula en vez de un valor. */
  f?: string;
}

/** Lista desplegable sobre un rango. `f` es la fórmula de la lista: `"Sí,No"` o un rango. */
export interface DataValidation {
  sqref: string;
  f: string;
}

/** Formato condicional sobre un rango; `rules` son sus `<cfRule>` ya en XML. */
export interface ConditionalFormat {
  sqref: string;
  rules: string;
}

/** Texto con tramos de distinto color en una misma celda. */
export function rich(parts: readonly (readonly [text: string, color: string])[]): RichText {
  return {
    rich: parts
      .map(
        ([t, color]) =>
          `<r><rPr><sz val="10"/><color rgb="FF${color}"/><rFont val="Segoe UI"/></rPr><t xml:space="preserve">${esc(t)}</t></r>`,
      )
      .join(''),
  };
}

/** Regla "en rojo si es negativo". */
export function neg(sqref: string, priority = 1): ConditionalFormat {
  return {
    sqref,
    rules: `<cfRule type="cellIs" dxfId="0" priority="${priority}" operator="lessThan"><formula>0</formula></cfRule>`,
  };
}

/** Referencia estructurada a una columna de la tabla en la misma fila. */
export function TR(table: string, column: string): string {
  return `${table}[[#This Row],[${column}]]`;
}

export class Sheet {
  readonly name: string;
  private readonly book: Workbook;
  private readonly cells = new Map<string, Cell>();
  /** Ancho de las columnas, desde A. */
  cols: number[] = [];
  /** Alto (en puntos) de las filas que no usan el alto por defecto, por número de fila. */
  readonly rowHt: Record<number, number> = {};
  readonly dv: DataValidation[] = [];
  readonly cf: ConditionalFormat[] = [];
  /** Números de las tablas de la hoja (posición + 1 en `Workbook.tables`). */
  readonly tables: number[] = [];
  private readonly merges: string[] = [];
  /** Índices (desde 0) de las columnas ocultas. */
  hidden: number[] = [];
  /** Número del dibujo de la hoja (posición + 1 en `Workbook.drawings`), si tiene. */
  drawing: number | null = null;
  /** Color de la pestaña. */
  tab: string | null = null;
  selected = false;
  private readonly defHt = 20;

  constructor(book: Workbook, name: string) {
    this.book = book;
    this.name = name;
  }

  /** Mezcla `sp` con el estilo que ya tenga la celda (la crea vacía si no existe). */
  style(ref: string, sp?: StyleSpec): Cell {
    let c = this.cells.get(ref);
    if (!c) {
      c = { v: null, sp: {} };
      this.cells.set(ref, c);
    }
    c.sp = merge(c.sp, sp ?? {});
    return c;
  }

  set(ref: string, v: CellValue, sp?: StyleSpec): void {
    const c = this.style(ref, sp);
    c.v = v;
  }

  /** Recorre el rango por filas; L, R, T y B dicen si la celda está en ese borde del rango. */
  range(
    r1: string,
    r2: string,
    fn: (ref: string, L: boolean, R: boolean, T: boolean, B: boolean) => void,
  ): void {
    const [c1, a] = parse(r1);
    const [c2, b] = parse(r2);
    for (let r = a; r <= b; r++) {
      for (let c = c1; c <= c2; c++) fn(colL(c) + r, c === c1, c === c2, r === a, r === b);
    }
  }

  /** Tarjeta: fondo blanco y borde alrededor del rango. */
  card(r1: string, r2: string): void {
    this.range(r1, r2, (ref, L, R, T, B) =>
      this.style(ref, {
        fill: 'FFFFFF',
        border: { l: L ? LINE : undefined, r: R ? LINE : undefined, t: T ? LINE : undefined, b: B ? LINE : undefined },
      }),
    );
  }

  fill(r1: string, r2: string, sp: StyleSpec): void {
    this.range(r1, r2, (ref) => this.style(ref, sp));
  }

  mergeR(r1: string, r2: string): void {
    this.merges.push(`${r1}:${r2}`);
  }

  /**
   * Tabla de Excel: encabezados en `startRef` y una fila por elemento de `rows` (un valor por columna;
   * el de las columnas calculadas se ignora).
   */
  table(name: string, startRef: string, cols: readonly TableColumn[], rows: readonly (readonly CellValue[])[]): void {
    const [c0, r0] = parse(startRef);
    cols.forEach((c, i) => this.set(colL(c0 + i) + r0, c.name, c.num ? st.thR : st.th));
    rows.forEach((row, ri) =>
      cols.forEach((c, i) =>
        this.set(colL(c0 + i) + (r0 + 1 + ri), c.f ? { f: c.f } : (row[i] ?? null), merge(c.st || st.td, {})),
      ),
    );
    this.addTable(name, startRef, colL(c0 + cols.length - 1) + (r0 + rows.length), cols);
  }

  private addTable(name: string, r1: string, r2: string, cols: readonly TableColumn[]): void {
    const { tables } = this.book;
    const columns = cols
      .map((c, i) => {
        const formula = c.f ? `><calculatedColumnFormula>${esc(c.f)}</calculatedColumnFormula></tableColumn>` : '/>';
        return `<tableColumn id="${i + 1}" name="${esc(c.name)}"${formula}`;
      })
      .join('');
    tables.push(
      [
        XML_DECL,
        `<table xmlns="${NS_MAIN}" id="${tables.length + 1}" name="${name}" displayName="${name}" ref="${r1}:${r2}" totalsRowShown="0">`,
        `<tableColumns count="${cols.length}">${columns}</tableColumns>`,
        '<tableStyleInfo showFirstColumn="0" showLastColumn="0" showRowStripes="0" showColumnStripes="0"/>',
        '</table>',
      ].join(''),
    );
    this.tables.push(tables.length);
  }

  /** XML de la hoja. Registra en el libro los estilos y textos de sus celdas, en orden de fila y columna. */
  xml(): string {
    const rows = new Map<number, [col: number, cell: Cell][]>();
    for (const [ref, cell] of this.cells) {
      const [c, r] = parse(ref);
      let row = rows.get(r);
      if (!row) {
        row = [];
        rows.set(r, row);
      }
      row.push([c, cell]);
    }
    // Filas y columnas llevan el fondo de la página para que no se vea blanco fuera de las tarjetas.
    const bgS = this.book.xfOf({ fill: BG });
    const all = new Set([...rows.keys(), ...Object.keys(this.rowHt).map(Number)]);
    const rowsXml = [...all]
      .sort((a, b) => a - b)
      .map((r) => {
        const cells = (rows.get(r) ?? [])
          .sort((a, b) => a[0] - b[0])
          .map(([c, { v, sp }]) => {
            const ref = colL(c) + r;
            const s = this.book.xfOf(sp);
            if (v === null || v === '') return `<c r="${ref}" s="${s}"/>`;
            if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
            if (typeof v === 'string') {
              return `<c r="${ref}" s="${s}" t="s"><v>${this.book.si(`<t xml:space="preserve">${esc(v)}</t>`)}</v></c>`;
            }
            if ('f' in v) return `<c r="${ref}" s="${s}"><f>${esc(v.f)}</f></c>`;
            return `<c r="${ref}" s="${s}" t="s"><v>${this.book.si(v.rich)}</v></c>`;
          })
          .join('');
        const ht = this.rowHt[r] ? ` ht="${this.rowHt[r]}" customHeight="1"` : '';
        return `<row r="${r}" s="${bgS}" customFormat="1"${ht}>${cells}</row>`;
      })
      .join('');
    const cols = `<cols>${this.cols
      .map(
        (w, i) =>
          `<col min="${i + 1}" max="${i + 1}" width="${w}" style="${bgS}" customWidth="1"${this.hidden.includes(i) ? ' hidden="1"' : ''}/>`,
      )
      .join('')}<col min="${this.cols.length + 1}" max="60" width="9" style="${bgS}"/></cols>`;
    const view = `<sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="100"${this.selected ? ' tabSelected="1"' : ''}/></sheetViews>`;
    const pr = this.tab ? `<sheetPr><tabColor rgb="FF${this.tab}"/></sheetPr>` : '';
    const mg = this.merges.length
      ? `<mergeCells count="${this.merges.length}">${this.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '';
    const cf = this.cf
      .map((x) => `<conditionalFormatting sqref="${x.sqref}">${x.rules}</conditionalFormatting>`)
      .join('');
    const dv = this.dv.length
      ? `<dataValidations count="${this.dv.length}">${this.dv
          .map(
            (d) =>
              `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${d.sqref}"><formula1>${esc(d.f)}</formula1></dataValidation>`,
          )
          .join('')}</dataValidations>`
      : '';
    // Los rId siguen el orden de `relsXml`: primero el dibujo, después las tablas.
    let rid = 1;
    const dr = this.drawing ? `<drawing r:id="rId${rid++}"/>` : '';
    const tp = this.tables.length
      ? `<tableParts count="${this.tables.length}">${this.tables.map(() => `<tablePart r:id="rId${rid++}"/>`).join('')}</tableParts>`
      : '';
    return [
      XML_DECL,
      `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`,
      pr,
      view,
      `<sheetFormatPr defaultRowHeight="${this.defHt}" customHeight="1"/>`,
      cols,
      `<sheetData>${rowsXml}</sheetData>`,
      mg,
      cf,
      dv,
      '<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>',
      dr,
      tp,
      '</worksheet>',
    ].join('');
  }

  /** Relaciones de la hoja (su dibujo y sus tablas); null si no tiene ninguna. */
  relsXml(): string | null {
    const rels: string[] = [];
    let rid = 1;
    if (this.drawing) {
      rels.push(
        `<Relationship Id="rId${rid++}" Type="${NS_REL}/drawing" Target="../drawings/drawing${this.drawing}.xml"/>`,
      );
    }
    for (const t of this.tables) {
      rels.push(`<Relationship Id="rId${rid++}" Type="${NS_REL}/table" Target="../tables/table${t}.xml"/>`);
    }
    if (!rels.length) return null;
    return `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">${rels.join('')}</Relationships>`;
  }

  // Geometría en píxeles, para anclar los dibujos: así calcula Excel el ancho de una columna y el alto de una fila.

  px(c: number): number {
    return Math.round((this.cols[c] ?? 9) * 7 + 5);
  }

  rowPx(r: number): number {
    return ((this.rowHt[r] || this.defHt) * 4) / 3;
  }

  /** Borde izquierdo de la columna `c` (desde 0). */
  xAt(c: number): number {
    let x = 0;
    for (let i = 0; i < c; i++) x += this.px(i);
    return x;
  }

  /** Borde superior de la fila `r` (desde 1). */
  yAt(r: number): number {
    let y = 0;
    for (let i = 1; i < r; i++) y += this.rowPx(i);
    return y;
  }

  /** Punto (x, y) en píxeles → celda y desplazamiento dentro de ella (en EMU), como lo pide un ancla de dibujo. */
  anchor(x: number, y: number): string {
    let c = 0;
    let acc = 0;
    while (acc + this.px(c) <= x) {
      acc += this.px(c);
      c++;
    }
    let r = 1;
    let ay = 0;
    while (ay + this.rowPx(r) <= y) {
      ay += this.rowPx(r);
      r++;
    }
    return `<xdr:col>${c}</xdr:col><xdr:colOff>${Math.round((x - acc) * 9525)}</xdr:colOff><xdr:row>${r - 1}</xdr:row><xdr:rowOff>${Math.round((y - ay) * 9525)}</xdr:rowOff>`;
  }
}
