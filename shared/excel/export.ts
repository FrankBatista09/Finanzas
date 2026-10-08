// Contenido del libro: una hoja por mes + ahorros + Config.
// Port de design_handoff/referencia/excel-export.js, generalizado en dos cosas: los textos salen de un
// ExcelLocale (locale.ts) y la hoja de ahorros admite las metas que tenga el usuario (export-goals.ts).
// Con los textos en español y las tres metas del diseño, la salida sigue siendo idéntica byte a byte a la del
// script original (export.test.ts lo compara con él), así que fórmulas, estilos y el orden de las operaciones
// se copian tal cual: cualquier cambio aquí cambia el archivo que recibe el usuario.

import { APP_NAME } from '../constants';
import { catLabel, methodLabel } from '../i18n';
import { currentMonthKey } from '../month';
import type { MonthKey } from '../types';
import {
  DARK,
  DGREEN,
  GREEN,
  INK,
  MONO,
  MUTED,
  NS_MAIN,
  NS_PKG_REL,
  NS_REL,
  ROWL,
  SUB,
  Sheet,
  TR,
  Workbook,
  XML_DECL,
  colL,
  esc,
  merge,
  neg,
  num,
  rich,
  serialISO,
  st,
} from './export-book';
import type { CellValue, ConditionalFormat, StyleSpec, TableColumn } from './export-book';
import { BAND_HEIGHTS, BAND_ROWS, BAND_TOP, GOAL_SLOTS, WIDE_SLOT, placeGoals } from './export-goals';
import type { GoalLayout, GoalPlan, PlacedGoal } from './export-goals';
import { zipStored } from './export-zip';
import { EXCEL_EN } from './locale';
import type { ExcelLocale } from './locale';
import type { ExportData, ExportMonth } from './types';

export { EXCEL_EN, EXCEL_ES, EXCEL_LOCALES, EXCEL_TR, excelLocale } from './locale';
export type { ExcelLocale } from './locale';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** La hoja de ajustes se llama igual en todos los idiomas; las fórmulas la nombran tal cual (Config!$C$4). */
export const CONFIG_SHEET = 'Config';

/** Nombre del archivo que se descarga: "FE Finance.xlsx", o "FE Finance - Frank.xlsx" con el nombre del usuario. */
export function xlsxFilename(userName?: string): string {
  // Fuera los caracteres que no admite un nombre de archivo (Windows es el más estricto) y los de control.
  const who = (userName ?? '')
    .replace(/[\\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return who ? `${APP_NAME} - ${who}.xlsx` : `${APP_NAME}.xlsx`;
}

export interface BuildOptions {
  /** Mes de la plantilla vacía cuando `data.months` viene sin meses. Por defecto, el mes actual. */
  currentKey?: MonthKey;
  /** Idioma del libro. Por defecto, inglés. */
  locale?: ExcelLocale;
}

const NS_CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_DRAWING_MAIN = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_SHEET_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const CT = 'application/vnd.openxmlformats-officedocument';

/** Texto para un atributo XML: como `esc`, y además las comillas dobles. */
function attr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

/** Literal de texto de una fórmula: entre comillas, con las comillas de dentro duplicadas. */
function str(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Fórmula de texto: los trozos de `parts` (literales) con las expresiones `exprs` intercaladas, unidos con &.
 * Los trozos vacíos no se escriben: la misma frase sirve a los idiomas que ponen el texto delante y a los
 * que lo ponen detrás, sin cambiar el orden de las expresiones.
 */
function phrase(parts: readonly string[], ...exprs: string[]): string {
  const out: string[] = [];
  parts.forEach((part, i) => {
    if (part) out.push(str(part));
    if (i < exprs.length) out.push(exprs[i]);
  });
  return out.join('&');
}

/**
 * Criterio de SUMIFS/COUNTIFS que coincide exactamente con el nombre de una meta. Los comodines (* ? ~) se
 * escapan con ~, y a un nombre que empieza por un operador (= < >) se le antepone "=" para que no se lea
 * como una comparación.
 */
function criterion(name: string): string {
  const exact = name.replace(/[~*?]/g, '~$&');
  return str(/^[=<>]/.test(exact) ? `=${exact}` : exact);
}

/** '2026-10' → nombre de la hoja de ese mes ('Octubre 2026'). */
function sheetLabel(L: ExcelLocale, key: MonthKey): string {
  const [y, m] = key.split('-');
  return `${L.months[+m - 1]} ${y}`;
}

/** Columna calculada DOP de una tabla con Monto y Moneda: convierte los montos en USD con la tasa del mes ($T$3). */
function dopColumn(table: string, L: ExcelLocale): TableColumn {
  const amount = TR(table, L.cols.amount);
  return {
    name: 'DOP',
    num: true,
    st: merge(st.tdNum, { font: { b: true } }),
    f: `IF(${amount}="","",IF(${TR(table, L.cols.currency)}="USD",${amount}*$T$3,${amount}))`,
  };
}

/** Columna calculada USD: el equivalente en USD de la columna DOP. */
function usdColumn(table: string): TableColumn {
  return {
    name: 'USD',
    num: true,
    st: merge(st.tdNum, { font: { color: MUTED } }),
    f: `IF(${TR(table, 'DOP')}="","",${TR(table, 'DOP')}/$T$3)`,
  };
}

/** Barra de datos dentro de la celda, escalada al mayor valor de "Por categoría". */
function categoryBar(sqref: string, color: string, priority: number): ConditionalFormat {
  return {
    sqref,
    rules: `<cfRule type="dataBar" priority="${priority}"><dataBar showValue="0"><cfvo type="num" val="0"/><cfvo type="formula" val="MAX($Q$15:$Q$25)"/><color rgb="FF${color}"/></dataBar></cfRule>`,
  };
}

/** Gráfico de dona del presupuesto: los cuatro segmentos son las celdas T4:T7 de la hoja del mes. */
function donutChartXml(quotedSheet: string, L: ExcelLocale): string {
  const points = [DARK, GREEN, 'C9D3C9', 'EBE9E1']
    .map(
      (col, i) =>
        `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${col}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:dPt>`,
    )
    .join('');
  return [
    XML_DECL,
    `<c:chartSpace xmlns:c="${NS_CHART}" xmlns:a="${NS_DRAWING_MAIN}" xmlns:r="${NS_REL}">`,
    '<c:roundedCorners val="0"/>',
    '<c:chart><c:autoTitleDeleted val="1"/>',
    '<c:plotArea>',
    '<c:layout><c:manualLayout><c:layoutTarget val="inner"/><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="0.03"/><c:y val="0.03"/><c:w val="0.94"/><c:h val="0.94"/></c:manualLayout></c:layout>',
    '<c:doughnutChart><c:varyColors val="1"/>',
    `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${esc(L.drawing.series)}</c:v></c:tx>`,
    points,
    `<c:val><c:numRef><c:f>${esc(quotedSheet)}!$T$4:$T$7</c:f></c:numRef></c:val>`,
    '</c:ser>',
    '<c:firstSliceAng val="0"/><c:holeSize val="72"/></c:doughnutChart>',
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>',
    '</c:plotArea>',
    '<c:plotVisOnly val="0"/><c:dispBlanksAs val="gap"/></c:chart>',
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>',
    '</c:chartSpace>',
  ].join('');
}

/**
 * Dibujo de la hoja del mes: la dona centrada en la tarjeta "Presupuesto usado" (E4:I12) y, encima,
 * tres cajas de texto: "USADO", el monto usado (enlazado a T9) y "de N DOP" (enlazado a T10).
 */
function donutDrawingXml(sh: Sheet, cid: number, L: ExcelLocale): string {
  const D = L.drawing;
  const panelTop = sh.yAt(4);
  const panelH = sh.yAt(13) - panelTop;
  const size = Math.min(196, panelH - 14);
  const cx0 = sh.xAt(4) + (sh.px(4) + sh.px(5)) / 2;
  const cy0 = panelTop + panelH / 2;

  const frame = (x: number, y: number, w: number, h: number) =>
    [
      '<xdr:twoCellAnchor editAs="oneCell">',
      `<xdr:from>${sh.anchor(x, y)}</xdr:from><xdr:to>${sh.anchor(x + w, y + h)}</xdr:to>`,
      '<xdr:graphicFrame macro="">',
      `<xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="${attr(D.frame)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`,
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>',
      `<a:graphic><a:graphicData uri="${NS_CHART}"><c:chart xmlns:c="${NS_CHART}" xmlns:r="${NS_REL}" r:id="rId1"/></a:graphicData></a:graphic>`,
      '</xdr:graphicFrame>',
      '<xdr:clientData/>',
      '</xdr:twoCellAnchor>',
    ].join('');

  // Las formas se numeran desde 3 (la 2 es el marco del gráfico). El nombre lleva el número siguiente
  // al id ("Centro 4" para la forma 3): así salía del original y se conserva.
  let sid = 3;
  const textBox = (
    link: string,
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    sz: number,
    bold: boolean,
    col: string,
  ) => {
    const b = bold ? 1 : 0;
    // Identificador del campo enlazado: único por gráfico y forma.
    const g = `${(10000000 + cid * 1000 + sid).toString(16).toUpperCase().padStart(8, '0')}-1B2C-4D3E-8F4A-5B6C7D8E9F0A`;
    const body = link
      ? `<a:fld id="{${g}}" type="TxLink"><a:rPr lang="${D.lang}" sz="${sz}" b="${b}"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill><a:latin typeface="${bold ? MONO : 'Segoe UI'}"/></a:rPr><a:pPr algn="ctr"/><a:t>${esc(text)}</a:t></a:fld>`
      : `<a:r><a:rPr lang="${D.lang}" sz="${sz}" b="${b}"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill><a:latin typeface="Segoe UI"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
    const id = sid++;
    return [
      '<xdr:twoCellAnchor editAs="oneCell">',
      `<xdr:from>${sh.anchor(x, y)}</xdr:from><xdr:to>${sh.anchor(x + w, y + h)}</xdr:to>`,
      `<xdr:sp macro="" textlink="${link}">`,
      `<xdr:nvSpPr><xdr:cNvPr id="${id}" name="${attr(D.center)} ${sid}"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>`,
      '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></xdr:spPr>',
      '<xdr:txBody>',
      '<a:bodyPr vertOverflow="overflow" horzOverflow="overflow" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/>',
      '<a:lstStyle/>',
      `<a:p><a:pPr algn="ctr"/>${body}<a:endParaRPr lang="${D.lang}" sz="${sz}"/></a:p>`,
      '</xdr:txBody>',
      '</xdr:sp>',
      '<xdr:clientData/>',
      '</xdr:twoCellAnchor>',
    ].join('');
  };

  return [
    XML_DECL,
    `<xdr:wsDr xmlns:xdr="${NS_SHEET_DRAWING}" xmlns:a="${NS_DRAWING_MAIN}">`,
    frame(cx0 - size / 2, cy0 - size / 2, size, size),
    textBox('', L.month.used, cx0 - 60, cy0 - 30, 120, 14, 700, true, MUTED),
    // El texto guardado de las cajas enlazadas ('0' y vacío) es provisional: Excel lo sustituye por el
    // valor de la celda al abrir el libro.
    textBox('$T$9', '0', cx0 - 70, cy0 - 15, 140, 24, 1500, true, INK),
    textBox('$T$10', '', cx0 - 70, cy0 + 10, 140, 16, 800, false, MUTED),
    '</xdr:wsDr>',
  ].join('');
}

/** Hoja de un mes: resumen, dona, gastos mensuales, por categoría, envíos e historial. */
function monthSheet(book: Workbook, mo: ExportMonth, L: ExcelLocale): Sheet {
  const [y, m] = mo.key.split('-').map(Number);
  const name = sheetLabel(L, mo.key);
  const M = L.month;
  const cols = L.cols;
  // X: sufijo de las tablas del mes (Fijos_2026_10…). Q: nombre de la hoja entre comillas, para fórmulas.
  const X = `${y}_${String(m).padStart(2, '0')}`;
  const Q = `'${name}'`;
  const sh = new Sheet(book, name);
  sh.tab = GREEN;
  sh.cols = [2, 16, 22, 16, 15, 14, 12, 8, 13, 12, 18, 3, 11, 10, 10, 8, 12, 2, 2, 14];
  sh.hidden = [19];

  // Las tablas de fijos y de envíos dejan filas en blanco para escribir en Excel; si crecen, el historial baja.
  const fixedN = Math.max(15, mo.fixed.length + 3);
  const envN = Math.max(5, mo.transfers.length + 2);
  const fxEnd = 15 + fixedN;
  const envTitle = 28;
  const envEnd = 29 + envN;
  const hTitle = Math.max(fxEnd + 1, envEnd + 1) + 2;
  Object.assign(sh.rowHt, {
    1: 26,
    2: 16,
    3: 6,
    4: 18,
    5: 28,
    6: 18,
    7: 10,
    8: 20,
    9: 20,
    10: 20,
    11: 20,
    12: 10,
    13: 10,
    14: 26,
    [fxEnd + 1]: 6,
    [envEnd + 1]: 6,
    [hTitle]: 26,
  });

  // Banda superior
  sh.fill('A1', 'R1', st.band);
  sh.set('B1', L.brand, merge(st.band, { font: { sz: 13, b: true, color: 'F4F3EE' } }));
  sh.set('D1', name, merge(st.band, { font: { sz: 11, color: 'A9ABA3' } }));
  sh.set('M1', M.rate, merge(st.band, { font: { sz: 9, color: 'A9ABA3' }, align: { h: 'right' } }));
  sh.set(
    'N1',
    { f: '"1 USD = "&FIXED($T$3,2)&" DOP"' },
    merge(st.band, { font: { name: MONO, sz: 10, color: 'F4F3EE' }, align: { h: 'right' } }),
  );
  sh.mergeR('N1', 'Q1');
  sh.set('B2', M.hint, { font: { sz: 8, i: true, color: MUTED } });

  // Dinero total
  sh.card('B4', 'D12');
  sh.card('E4', 'I12');
  sh.card('J4', 'Q12');
  sh.set('B4', M.totalMoney, st.label);
  sh.set('B5', { f: 'C8*$T$3+C9' }, { font: { name: MONO, sz: 18, b: true }, numFmt: '#,##0.00" DOP"' });
  sh.mergeR('B5', 'D5');
  sh.set('B6', { f: 'C8+C9/$T$3' }, { font: { name: MONO, sz: 9.5, color: MUTED }, numFmt: '"≈ "#,##0.00" USD"' });
  sh.mergeR('B6', 'D6');
  const acc: ExportMonth['accounts'] = mo.accounts || {};
  const balances: [label: string, value: number | null, unit: string][] = [
    [M.usAccount, num(acc.usd), 'USD'],
    [M.drAccount, num(acc.dop), 'DOP'],
    [M.income, num(mo.incomeUSD), 'USD'],
  ];
  balances.forEach(([l, v, u], i) => {
    const r = 8 + i;
    sh.set(`B${r}`, l, { font: { color: SUB }, border: { b: ROWL } });
    sh.set(`C${r}`, v, merge(st.input, { border: { b: ROWL } }));
    sh.set(`D${r}`, u, { font: { sz: 8, color: MUTED }, align: { indent: 1 }, border: { b: ROWL } });
  });
  sh.set('B11', M.incomeMinusUsed, { font: { color: SUB } });
  sh.set(
    'C11',
    { f: 'C10*$T$3-$T$8' },
    { font: { name: MONO, sz: 10 }, numFmt: '#,##0.00" DOP"', align: { h: 'right' } },
  );
  sh.mergeR('C11', 'D11');
  sh.cf.push(neg('C11', 1));

  // Presupuesto usado: leyenda de la dona
  sh.set('G4', M.budgetUsed, st.label);
  const legend: [label: string, color: string, ref: string, row: number][] = [
    [M.fixedPaid, DARK, '$T$4', 6],
    [M.transactions, GREEN, '$T$5', 8],
    [M.fixedPending, 'B7C4B7', '$T$6', 9],
    [M.free, 'DCDAD1', '$T$7', 10],
  ];
  for (const [l, c, ref, r] of legend) {
    sh.set(`G${r}`, rich([['■  ', c], [l, INK]]), {});
    sh.mergeR(`G${r}`, `H${r}`);
    sh.set(`I${r}`, { f: ref }, { font: { name: MONO, sz: 10 }, numFmt: '#,##0', align: { h: 'right' } });
  }

  // Presupuesto del mes
  sh.set('J4', { f: 'UPPER($D$1)' }, st.label);
  type BudgetKind = 'input' | 'used' | 'avail' | 'after' | 'usd';
  const budgetRows: [label: string, value: CellValue, kind: BudgetKind, row: number][] = [
    [M.planned, num(mo.budget), 'input', 6],
    [M.usedSoFar, { f: '$T$8' }, 'used', 8],
    [M.available, { f: 'O6-O8' }, 'avail', 9],
    [M.availableAfter, { f: 'O9-$T$6' }, 'after', 10],
    [M.usedUSD, { f: '$T$8/$T$3' }, 'usd', 11],
  ];
  for (const [l, v, k, r] of budgetRows) {
    const bold = k === 'used' || k === 'avail';
    const secondary = k === 'after' || k === 'usd';
    sh.fill(`J${r}`, `Q${r}`, { border: { b: ROWL } });
    sh.set(`J${r}`, l, { font: { b: bold, color: secondary ? SUB : INK }, border: { b: ROWL } });
    const vs: StyleSpec =
      k === 'input'
        ? merge(st.input, { font: { b: true } })
        : {
            font: { name: MONO, sz: 10, b: bold, color: k === 'avail' ? DGREEN : secondary ? SUB : INK },
            numFmt: '#,##0.00',
            align: { h: 'right' },
          };
    sh.set(`O${r}`, v, merge(vs, { border: { b: ROWL } }));
    sh.mergeR(`O${r}`, `Q${r}`);
  }
  sh.set(
    'J5',
    { f: phrase(M.pctUsed, 'FIXED(100*$T$8/MAX(1,O6),1)') },
    { font: { sz: 9, color: MUTED }, align: { v: 'bottom' } },
  );
  sh.cf.push(neg('O9:O10', 2));

  // Cálculos (columna T, oculta): de aquí leen el resumen, la dona y la hoja Ahorros.
  const F = `${L.tables.fixed}_${X}`;
  const E = `${L.tables.transfers}_${X}`;
  const T = `${L.tables.tx}_${X}`;
  const yes = str(L.yes);
  const no = str(L.no);
  sh.set('T2', L.calc, { font: { b: true } });
  sh.set('T3', { f: `IFERROR(SUMPRODUCT(${E}[USD],${E}[${cols.rate}])/SUM(${E}[USD]),Config!$C$4)` });
  sh.set('T4', { f: `SUMIFS(${F}[DOP],${F}[${cols.paid}],${yes})` });
  sh.set('T5', { f: `SUM(${T}[DOP])` });
  sh.set('T6', { f: `SUMIFS(${F}[DOP],${F}[${cols.paid}],${no})` });
  sh.set('T7', { f: 'MAX(0,O6-T4-T5-T6)' });
  sh.set('T8', { f: 'T4+T5' });
  sh.set('T9', { f: 'FIXED(T8,0)' });
  sh.set('T10', { f: phrase(M.ofBudget, 'FIXED(O6,0)') });

  // Gastos mensuales
  sh.card('B14', `K${fxEnd + 1}`);
  sh.set('B14', M.fixedTitle, st.h2);
  sh.set(
    'H14',
    {
      f: phrase(
        M.fixedMeta,
        `COUNTIFS(${F}[${cols.paid}],${yes})`,
        `COUNTA(${F}[${cols.item}])`,
        `FIXED(SUM(${F}[DOP]),2)`,
      ),
    },
    st.meta,
  );
  sh.mergeR('H14', 'K14');
  const fxRows: CellValue[][] = mo.fixed.map((f) => [
    f.paid ? L.yes : L.no,
    f.name,
    // El día es texto libre: si es numérico va como número, si no, tal cual.
    num(f.day) ?? (f.day || null),
    num(f.amount),
    f.cur || 'DOP',
    null,
    null,
  ]);
  while (fxRows.length < fixedN) fxRows.push([null, null, null, null, null, null, null]);
  sh.table(
    F,
    'B15',
    [
      { name: cols.paid, st: merge(st.td, { align: { h: 'center' }, font: { b: true } }) },
      { name: cols.item },
      { name: cols.day, st: st.tdMono },
      { name: cols.amount, num: true, st: st.tdNum },
      { name: cols.currency, st: st.tdMono },
      dopColumn(F, L),
      usdColumn(F),
    ],
    fxRows,
  );
  sh.dv.push({ sqref: `B16:B${fxEnd}`, f: str(`${L.yes},${L.no}`) }, { sqref: `F16:F${fxEnd}`, f: '"DOP,USD"' });
  sh.cf.push({
    sqref: `B16:B${fxEnd}`,
    rules:
      `<cfRule type="cellIs" dxfId="1" priority="3" operator="equal"><formula>${esc(yes)}</formula></cfRule>` +
      `<cfRule type="cellIs" dxfId="2" priority="4" operator="equal"><formula>${esc(no)}</formula></cfRule>`,
  });

  // Por categoría
  sh.card('M14', 'Q26');
  sh.set('M14', M.byCategory, st.h2);
  sh.set('Q14', 'DOP', st.meta);
  [M.fixedCategory, ...L.cats].forEach((c, i) => {
    const r = 15 + i;
    sh.set(`M${r}`, c, {});
    sh.mergeR(`M${r}`, `N${r}`);
    // La barra es el mismo valor en blanco y diminuto, con una barra de datos por formato condicional.
    sh.set(`O${r}`, { f: `Q${r}` }, { font: { color: 'FFFFFF', sz: 6 } });
    sh.mergeR(`O${r}`, `P${r}`);
    sh.set(
      `Q${r}`,
      i === 0 ? { f: '$T$4' } : { f: `SUMIFS(${T}[DOP],${T}[${cols.category}],M${r})` },
      { font: { name: MONO, sz: 10 }, numFmt: '#,##0', align: { h: 'right' } },
    );
  });
  sh.cf.push(categoryBar('O15:P15', DARK, 5), categoryBar('O16:P25', GREEN, 6));

  // Envíos
  sh.card(`M${envTitle}`, `Q${envEnd + 1}`);
  sh.set(`M${envTitle}`, M.transfersTitle, st.h2);
  sh.set(`O${envTitle}`, { f: phrase(M.average, 'FIXED($T$3,2)') }, st.meta);
  sh.mergeR(`O${envTitle}`, `Q${envTitle}`);
  const envRows: CellValue[][] = mo.transfers.map((t) => [
    serialISO(t.date),
    t.via || 'Remitly',
    num(t.usd),
    num(t.rate),
    null,
  ]);
  while (envRows.length < envN) envRows.push([null, null, null, null, null]);
  sh.table(
    E,
    'M29',
    [
      { name: cols.date, st: st.tdDate },
      { name: cols.via },
      { name: 'USD', num: true, st: st.tdNum },
      { name: cols.rate, num: true, st: merge(st.tdNum, { numFmt: '0.00' }) },
      { name: 'DOP', num: true, st: st.tdNum, f: `IF(${TR(E, 'USD')}="","",${TR(E, 'USD')}*${TR(E, cols.rate)})` },
    ],
    envRows,
  );
  sh.dv.push({ sqref: `N30:N${envEnd}`, f: '"Remitly,PayPal"' });

  // Historial
  const txs = [...mo.tx].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const txRows: CellValue[][] = txs.map((t) => [
    serialISO(t.date),
    t.desc || '',
    t.place || '',
    // Categoría y método se guardan con su nombre canónico y se escriben en el idioma del libro.
    catLabel(t.cat || '', L.lang),
    methodLabel(t.method || '', L.lang),
    num(t.amount),
    t.cur || 'DOP',
    null,
    null,
    t.notes || '',
  ]);
  for (let i = 0; i < 12; i++) txRows.push([null, null, null, null, null, null, null, null, null, null]);
  const hHead = hTitle + 1;
  const last = hHead + txRows.length;
  sh.card(`B${hTitle}`, `K${last}`);
  sh.set(`B${hTitle}`, M.txTitle, st.h2);
  sh.set(`H${hTitle}`, { f: phrase(M.txMeta, `COUNT(${T}[${cols.amount}])`, 'FIXED($T$5,2)') }, st.meta);
  sh.mergeR(`H${hTitle}`, `K${hTitle}`);
  sh.table(
    T,
    `B${hHead}`,
    [
      { name: cols.date, st: st.tdDate },
      { name: cols.description },
      { name: cols.place, st: merge(st.td, { font: { color: SUB } }) },
      { name: cols.category },
      { name: cols.method, st: merge(st.td, { font: { color: SUB } }) },
      { name: cols.amount, num: true, st: st.tdNum },
      { name: cols.currency, st: st.tdMono },
      dopColumn(T, L),
      usdColumn(T),
      { name: cols.notes, st: merge(st.td, { font: { sz: 9, color: MUTED } }) },
    ],
    txRows,
  );
  sh.dv.push(
    { sqref: `E${hHead + 1}:E3000`, f: 'Config!$E$4:$E$13' },
    { sqref: `F${hHead + 1}:F3000`, f: 'Config!$F$4:$F$6' },
    { sqref: `H${hHead + 1}:H3000`, f: '"DOP,USD"' },
  );

  // Dona
  const cid = book.charts.length + 1;
  book.charts.push(donutChartXml(Q, L));
  book.drawings.push({ chart: cid, xml: donutDrawingXml(sh, cid, L) });
  sh.drawing = book.drawings.length;
  return sh;
}

/**
 * Hoja de ahorros: resumen del mes actual, tarjetas de metas (en bandas, ver export-goals.ts), ingresos por
 * mes y aportes. `monthsData` son los meses ya ordenados (al menos uno).
 */
function savingsSheet(
  book: Workbook,
  data: ExportData,
  monthsData: readonly ExportMonth[],
  layout: GoalLayout,
  L: ExcelLocale,
): Sheet {
  const S = L.savings;
  const cols = L.cols;
  const A = new Sheet(book, L.sheets.savings);
  A.tab = INK;
  A.cols = [2, 17, 13, 9, 14, 13, 9, 3, 12, 16, 19, 11, 8, 11, 12, 2, 2, 14];
  A.hidden = [17];
  const firstKey = monthsData[0].key;
  const [fy, fm] = firstKey.split('-').map(Number);
  const lastKey = monthsData[monthsData.length - 1].key;
  const [ly, lm] = lastKey.split('-').map(Number);
  // La tabla de ingresos cubre desde el primer mes hasta un año después del último (mínimo 15 filas).
  const incN = Math.max(15, (ly - fy) * 12 + (lm - fm) + 1 + 12);

  // Las tarjetas de metas van en bandas; las dos tablas empiezan debajo de la última.
  const top = BAND_TOP + BAND_ROWS * layout.bands;
  const head = top + 1;
  const incEnd = head + incN;
  Object.assign(A.rowHt, { 1: 26, 2: 8, 3: 16, 4: 24, 5: 10, [top]: 26, [incEnd + 1]: 6 });
  for (let band = 0; band < layout.bands; band++) {
    BAND_HEIGHTS.forEach((ht, i) => {
      A.rowHt[BAND_TOP + BAND_ROWS * band + i] = ht;
    });
  }
  A.fill('A1', 'P1', st.band);
  A.set('B1', L.brand, merge(st.band, { font: { sz: 13, b: true, color: 'F4F3EE' } }));
  A.set('D1', L.sheets.savings, merge(st.band, { font: { sz: 11, color: 'A9ABA3' } }));

  // Resumen del mes actual: lee de la hoja cuyo nombre está en Config!C5.
  const IND = (c: string) => `INDIRECT("'"&Config!$C$5&"'!${c}")`;
  A.card('B3', 'O4');
  const summary: [col: string, label: string, formula: string, style: StyleSpec][] = [
    ['B', S.currentMonth, 'Config!$C$5', { font: { b: true, sz: 11 } }],
    ['C', S.totalMoney, `IFERROR(${IND('B5')},"")`, { font: { name: MONO, b: true, sz: 11 }, numFmt: '#,##0.00' }],
    ['F', S.budget, `IFERROR(${IND('O6')},"")`, { font: { name: MONO, sz: 11 }, numFmt: '#,##0.00' }],
    ['I', S.used, `IFERROR(${IND('T8')},"")`, { font: { name: MONO, sz: 11 }, numFmt: '#,##0.00' }],
    [
      'K',
      S.available,
      `IFERROR(${IND('O9')},"")`,
      { font: { name: MONO, b: true, sz: 11, color: DGREEN }, numFmt: '#,##0.00' },
    ],
    ['N', S.rate, `IFERROR(${IND('T3')},Config!$C$4)`, { font: { name: MONO, sz: 11 }, numFmt: '0.00' }],
  ];
  for (const [c, l, f, s] of summary) {
    A.set(`${c}3`, l, st.label);
    A.set(`${c}4`, { f }, s);
  }
  A.mergeR('C4', 'E4');
  A.mergeR('C3', 'E3');
  A.mergeR('F4', 'H4');
  A.mergeR('I4', 'J4');
  A.mergeR('K4', 'M4');
  A.mergeR('N4', 'O4');
  A.cf.push(neg('K4', 1));

  // Cálculos (columna R, oculta). R3 es la tasa del mes actual, común a todas las tarjetas; cada meta con
  // plan tiene además sus cinco celdas (ver plannedCard).
  A.set('R2', L.calc, { font: { b: true } });
  A.set('R3', { f: `IFERROR(${IND('T3')},Config!$C$4)` });

  // Tabla de aportes: de ella leen las tarjetas y la tabla de ingresos.
  const AP = L.tables.contribs;
  const apGoal = `${AP}[${cols.goal}]`;
  const apMonth = `${AP}[${cols.month}]`;
  const monthList = L.months.map(str).join(',');

  // Meta de aportes variables: total aportado y número de aportes.
  const variableCard = (g: PlacedGoal) => {
    const [c1, c2] = GOAL_SLOTS[g.slot];
    // Las filas se nombran como en la banda 0 (6 a 12); `r` las lleva a la banda de la meta.
    const r = (n: number) => n + BAND_ROWS * g.band;
    const goal = criterion(g.name);
    A.card(`${c1}${r(6)}`, `${c2}${r(12)}`);
    A.set(`${c1}${r(6)}`, g.name, st.h2);
    A.set(`${c1}${r(7)}`, S.variable, { font: { sz: 9, color: MUTED } });
    A.set(
      `${c1}${r(8)}`,
      { f: `SUMIFS(${AP}[USD],${apGoal},${goal})` },
      { font: { name: MONO, sz: 16, b: true }, numFmt: '#,##0.00" USD"' },
    );
    A.mergeR(`${c1}${r(8)}`, `${c2}${r(8)}`);
    A.set(
      `${c1}${r(9)}`,
      { f: `${c1}${r(8)}*$R$3` },
      { font: { name: MONO, sz: 9, color: MUTED }, numFmt: '"≈ "#,##0" DOP"' },
    );
    A.mergeR(`${c1}${r(9)}`, `${c2}${r(9)}`);
    A.set(
      `${c1}${r(11)}`,
      { f: phrase(S.contribCount, `COUNTIFS(${apGoal},${goal})`) },
      { font: { sz: 9, color: MUTED } },
    );
    A.mergeR(`${c1}${r(11)}`, `${c2}${r(11)}`);
  };

  // Meta con plan: aporte fijo mensual entre Inicio y Fin (editables en la última fila de la tarjeta).
  // Sus cálculos van en la columna R, dos filas por encima de la banda (R4:R8 en la banda 0).
  const plannedCard = (g: PlacedGoal, plan: GoalPlan, priority: number) => {
    const r = (n: number) => n + BAND_ROWS * g.band;
    const goal = criterion(g.name);
    const [monthly, start, end] = [`J${r(12)}`, `L${r(12)}`, `N${r(12)}`];
    const [target, saved, left, need, pct] = [4, 5, 6, 7, 8].map((n) => `R${r(n)}`);
    const abs = (ref: string) => `$R$${ref.slice(1)}`;
    A.set(target, { f: `${monthly}*((YEAR(${end})-YEAR(${start}))*12+MONTH(${end})-MONTH(${start})+1)` });
    A.set(saved, { f: `SUMIFS(${AP}[USD],${apGoal},${goal})` });
    A.set(left, {
      f: `MAX(1,(YEAR(${end})-YEAR(TODAY()))*12+MONTH(${end})-MONTH(TODAY())+1-IF(COUNTIFS(${apGoal},${goal},${apMonth},Config!$C$5)>0,1,0))`,
    });
    A.set(need, { f: `MAX(0,${target}-${saved})/${left}` });
    A.set(pct, { f: `IF(${target}=0,0,${saved}/${target})` });

    A.card(`I${r(6)}`, `O${r(12)}`);
    A.set(`I${r(6)}`, g.name, st.h2);
    A.set(`L${r(6)}`, { f: phrase(S.perMonth, `FIXED(${monthly},0)`) }, st.meta);
    A.mergeR(`L${r(6)}`, `O${r(6)}`);
    A.set(
      `I${r(7)}`,
      { f: phrase(S.remaining, abs(left), `FIXED(${abs(need)},0)`) },
      { font: { sz: 9, color: MUTED } },
    );
    A.mergeR(`I${r(7)}`, `O${r(7)}`);
    A.set(`I${r(8)}`, { f: abs(saved) }, { font: { name: MONO, sz: 16, b: true }, numFmt: '#,##0.00" USD"' });
    A.mergeR(`I${r(8)}`, `K${r(8)}`);
    A.set(
      `L${r(8)}`,
      { f: `${abs(saved)}*$R$3` },
      { font: { name: MONO, sz: 9, color: MUTED }, numFmt: '"≈ "#,##0" DOP"', align: { h: 'right' } },
    );
    A.mergeR(`L${r(8)}`, `O${r(8)}`);
    A.set(`I${r(10)}`, { f: abs(pct) }, { font: { color: 'FFFFFF', sz: 6 } });
    A.mergeR(`I${r(10)}`, `O${r(10)}`);
    A.cf.push({
      sqref: `I${r(10)}:O${r(10)}`,
      rules: `<cfRule type="dataBar" priority="${priority}"><dataBar showValue="0"><cfvo type="num" val="0"/><cfvo type="num" val="1"/><color rgb="FF2F7D52"/></dataBar></cfRule>`,
    });
    A.set(
      `I${r(11)}`,
      { f: phrase(S.pctOfTarget, `FIXED(100*${abs(pct)},0)`, `FIXED(${abs(target)},0)`) },
      { font: { sz: 9, color: SUB } },
    );
    A.mergeR(`I${r(11)}`, `K${r(11)}`);
    A.set(
      `L${r(11)}`,
      { f: phrase(S.target, `${S.monthCase}(CHOOSE(MONTH(${end}),${monthList}))`, `YEAR(${end})`) },
      st.meta,
    );
    A.mergeR(`L${r(11)}`, `O${r(11)}`);
    A.set(`I${r(12)}`, S.monthly, { font: { sz: 9, color: MUTED } });
    A.set(monthly, plan.monthlyUSD, merge(st.input, { numFmt: '#,##0' }));
    A.set(`K${r(12)}`, S.start, { font: { sz: 9, color: MUTED }, align: { h: 'right' } });
    A.set(start, serialISO(`${plan.start}-01`), merge(st.input, { numFmt: 'mm/yyyy' }));
    A.set(`M${r(12)}`, S.end, { font: { sz: 9, color: MUTED }, align: { h: 'right' } });
    A.set(end, serialISO(`${plan.end}-01`), merge(st.input, { numFmt: 'mm/yyyy' }));
    A.mergeR(end, `O${r(12)}`);
  };

  // La prioridad 1 es la del resumen (K4); cada barra de progreso lleva la siguiente.
  let priority = 2;
  for (const g of layout.goals) {
    if (g.slot === WIDE_SLOT && g.plan) plannedCard(g, g.plan, priority++);
    else variableCard(g);
  }

  // Ingresos por mes: cada fila lee el ingreso y la tasa de la hoja de ese mes, si existe.
  A.card(`B${top}`, `G${incEnd + 1}`);
  A.set(`B${top}`, S.incomeTitle, st.h2);
  S.incomeCols.forEach((h, i) => A.set(`${colL(1 + i)}${head}`, h, i ? st.thR : st.th));
  for (let i = 0; i < incN; i++) {
    const r = head + 1 + i;
    const mm = ((fm - 1 + i) % 12) + 1;
    const yy = fy + Math.floor((fm - 1 + i) / 12);
    A.set(`B${r}`, `${L.months[mm - 1]} ${yy}`, st.td);
    A.set(`C${r}`, { f: `IFERROR(INDIRECT("'"&B${r}&"'!C10"),"")` }, st.tdNum);
    A.set(
      `D${r}`,
      { f: `IFERROR(INDIRECT("'"&B${r}&"'!T3"),"")` },
      merge(st.tdNum, { numFmt: '0.00', font: { color: MUTED } }),
    );
    A.set(`E${r}`, { f: `IF(C${r}="","",C${r}*D${r})` }, st.tdNum);
    A.set(`F${r}`, { f: `IF(C${r}="","",SUMIFS(${AP}[USD],${apMonth},B${r}))` }, st.tdNum);
    A.set(
      `G${r}`,
      { f: `IF(OR(C${r}="",C${r}=0),"",F${r}/C${r})` },
      merge(st.tdNum, { numFmt: '0.0%', font: { color: DGREEN } }),
    );
  }

  // Aportes
  const apRows: CellValue[][] = [...(data.contribs || [])]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((c) => [serialISO(c.date), null, c.goalName, num(c.amount), c.cur || 'USD', null, null]);
  for (let i = 0; i < 10; i++) apRows.push([null, null, null, null, null, null, null]);
  A.card(`I${top}`, `O${head + apRows.length}`);
  A.set(`I${top}`, S.contribsTitle, st.h2);
  A.set(`L${top}`, { f: phrase(S.total, `FIXED(SUM(${AP}[USD]),2)`) }, st.meta);
  A.mergeR(`L${top}`, `O${top}`);
  // Tasa de la hoja del mes `x`; si esa hoja no existe, la tasa por defecto.
  const RT = (x: string) => `IFERROR(INDIRECT("'"&${x}&"'!T3"),Config!$C$4)`;
  const date = TR(AP, cols.date);
  const month = TR(AP, cols.month);
  const amount = TR(AP, cols.amount);
  A.table(
    AP,
    `I${head}`,
    [
      { name: cols.date, st: st.tdDate },
      {
        name: cols.month,
        st: merge(st.td, { font: { sz: 9, color: MUTED } }),
        f: `IF(${date}="","",CHOOSE(MONTH(${date}),${monthList})&" "&YEAR(${date}))`,
      },
      { name: cols.goal },
      { name: cols.amount, num: true, st: st.tdNum },
      { name: cols.currency, st: st.tdMono },
      {
        name: 'USD',
        num: true,
        st: merge(st.tdNum, { font: { b: true } }),
        f: `IF(${amount}="","",IF(${TR(AP, cols.currency)}="USD",${amount},${amount}/${RT(month)}))`,
      },
      {
        name: 'DOP',
        num: true,
        st: merge(st.tdNum, { font: { color: MUTED } }),
        f: `IF(${TR(AP, 'USD')}="","",${TR(AP, 'USD')}*${RT(month)})`,
      },
    ],
    apRows,
  );
  // Los desplegables bajan con la tabla. El de metas apunta a la lista de Config; sin metas no hay lista.
  const lastRow = 2000 + (top - 14);
  if (layout.goals.length) {
    A.dv.push({ sqref: `K${head + 1}:K${lastRow}`, f: `Config!$G$4:$G$${3 + layout.goals.length}` });
  }
  A.dv.push({ sqref: `M${head + 1}:M${lastRow}`, f: '"USD,DOP"' });
  return A;
}

/** Hoja Config: ajustes y las listas que alimentan los desplegables de las demás hojas. */
function configSheet(
  book: Workbook,
  data: ExportData,
  curLabel: string,
  goals: readonly string[],
  L: ExcelLocale,
): Sheet {
  const G = L.config;
  const C = new Sheet(book, CONFIG_SHEET);
  C.tab = 'A9ABA3';
  C.cols = [2, 34, 14, 3, 18, 16, 22];
  C.fill('A1', 'G1', st.band);
  C.rowHt[1] = 26;
  C.set('B1', G.title, merge(st.band, { font: { sz: 13, b: true, color: 'F4F3EE' } }));
  C.card('B3', 'C6');
  C.set('B3', G.settings, st.label);
  C.set('B4', G.defaultRate, {});
  C.set('C4', num(data.defaultRate) ?? 58.76, merge(st.input, { numFmt: '0.00' }));
  C.set('B5', G.currentMonth, {});
  C.set('C5', curLabel, merge(st.input, { font: { name: 'Segoe UI', b: true } }));
  // La tarjeta de las listas llega a la fila 14 (diez categorías); con más de diez metas, se alarga.
  C.card('E3', `G${Math.max(14, 4 + goals.length)}`);
  C.set('E3', G.cats, st.label);
  C.set('F3', G.methods, st.label);
  C.set('G3', G.goals, st.label);
  L.cats.forEach((c, i) => C.set(`E${4 + i}`, c, { border: { b: ROWL } }));
  L.methods.forEach((c, i) => C.set(`F${4 + i}`, c, { border: { b: ROWL } }));
  // Las metas, en su orden: es la lista del desplegable de la tabla de aportes.
  goals.forEach((c, i) => C.set(`G${4 + i}`, c, { border: { b: ROWL } }));
  return C;
}

/**
 * Genera el .xlsx (una hoja por mes + ahorros + Config) sin dependencias: OOXML + zip sin compresión.
 * El libro sale en el idioma de `opts.locale` (inglés si no se indica); la estructura es la misma en todos.
 * Port de design_handoff/referencia/excel-export.js: en español y con las tres metas del diseño devuelve,
 * para los mismos datos, los mismos bytes que el script original.
 * Sin meses exporta la plantilla vacía de `opts.currentKey` (por defecto, el mes actual del usuario).
 * Funciona igual en el navegador, en Node y en Workers; no modifica `data`.
 */
export function buildFinanzasXlsx(data: ExportData, opts: BuildOptions = {}): Uint8Array<ArrayBuffer> {
  const book = new Workbook();
  const L = opts.locale ?? EXCEL_EN;

  let monthsData = [...(data.months || [])].sort((a, b) => a.key.localeCompare(b.key));
  if (!monthsData.length) {
    // El original usaba la fecha del reloj local; aquí manda la zona horaria del usuario, no la del servidor.
    const key = opts.currentKey ?? currentMonthKey();
    monthsData = [{ key, budget: null, incomeUSD: null, accounts: {}, fixed: [], transfers: [], tx: [] }];
  }
  const months = monthsData.map((mo) => monthSheet(book, mo, L));
  months[months.length - 1].selected = true;
  const curLabel = sheetLabel(L, monthsData[monthsData.length - 1].key);
  const layout = placeGoals(data.goals || []);

  const sheets = [
    ...months,
    savingsSheet(book, data, monthsData, layout, L),
    configSheet(
      book,
      data,
      curLabel,
      layout.goals.map((g) => g.name),
      L,
    ),
  ];

  // El orden de inserción es el orden de las entradas del zip.
  const files = new Map<string, string>();
  sheets.forEach((s, i) => {
    files.set(`xl/worksheets/sheet${i + 1}.xml`, s.xml());
    const rels = s.relsXml();
    if (rels) files.set(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, rels);
  });
  const { tables, drawings, charts } = book;
  tables.forEach((x, i) => files.set(`xl/tables/table${i + 1}.xml`, x));
  drawings.forEach((d, i) => {
    files.set(`xl/drawings/drawing${i + 1}.xml`, d.xml);
    files.set(
      `xl/drawings/_rels/drawing${i + 1}.xml.rels`,
      `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/chart" Target="../charts/chart${d.chart}.xml"/></Relationships>`,
    );
  });
  charts.forEach((x, i) => files.set(`xl/charts/chart${i + 1}.xml`, x));
  // Estilos y textos compartidos se registran al generar el XML de las hojas: van después.
  files.set('xl/styles.xml', book.stylesXml());
  files.set('xl/sharedStrings.xml', book.sharedStringsXml());
  files.set(
    'xl/workbook.xml',
    [
      XML_DECL,
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`,
      `<bookViews><workbookView activeTab="${months.length - 1}"/></bookViews>`,
      `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`,
      // Los valores no se guardan: Excel calcula todas las fórmulas al abrir.
      '<calcPr calcId="191029" fullCalcOnLoad="1"/>',
      '</workbook>',
    ].join(''),
  );
  files.set(
    'xl/_rels/workbook.xml.rels',
    [
      XML_DECL,
      `<Relationships xmlns="${NS_PKG_REL}">`,
      sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join(''),
      `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`,
      `<Relationship Id="rId${sheets.length + 2}" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>`,
      '</Relationships>',
    ].join(''),
  );
  files.set(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  const override = (part: string, type: string) => `<Override PartName="/xl/${part}.xml" ContentType="${CT}.${type}+xml"/>`;
  files.set(
    '[Content_Types].xml',
    [
      XML_DECL,
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      override('workbook', 'spreadsheetml.sheet.main'),
      sheets.map((_, i) => override(`worksheets/sheet${i + 1}`, 'spreadsheetml.worksheet')).join(''),
      tables.map((_, i) => override(`tables/table${i + 1}`, 'spreadsheetml.table')).join(''),
      drawings.map((_, i) => override(`drawings/drawing${i + 1}`, 'drawing')).join(''),
      charts.map((_, i) => override(`charts/chart${i + 1}`, 'drawingml.chart')).join(''),
      override('styles', 'spreadsheetml.styles'),
      override('sharedStrings', 'spreadsheetml.sharedStrings'),
      '</Types>',
    ].join(''),
  );

  return zipStored(files);
}
