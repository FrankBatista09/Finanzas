// Genera el .xlsx (mismo diseño que "Finanzas Personales v2.xlsx") a partir de los datos de la página.
(function () {
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colL = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const parse = ref => { const m = ref.match(/^([A-Z]+)(\d+)$/); let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); return [c - 1, +m[2]]; };
const serialISO = d => { if (!d) return null; const [y, m, dd] = String(d).split('-').map(Number); if (!y) return null; return (Date.UTC(y, m - 1, dd || 1) - Date.UTC(1899, 11, 30)) / 86400000; };
const num = v => (v === '' || v === null || v === undefined || isNaN(+v)) ? null : +v;
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const CATS = ['Comida','Supermercado','Transporte','Entretenimiento','Salud','Ropa','Hogar','Suscripciones','Educación','Viajes'];
const METHODS = ['Tarjeta','Transferencia','App del banco'];
const GOALS = ['Fondo de emergencia','Ahorro personal','Viaje a Turquía'];
const INK='1D1F1C',MUTED='6B6D66',SUB='45473F',LINE='E3E1D8',ROWL='EEECE5',VL='F1EFE9',HEADF='F6F5F0',BG='EFEEE8',GREEN='2F7D52',DGREEN='23613F',DARK='2B3A33',MONO='Consolas';

function build(data) {
const sst = [], sstMap = {}; const si = x => { if (!(x in sstMap)) { sstMap[x] = sst.length; sst.push(x); } return sstMap[x]; };
const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'], borders = [], numFmts = [], xfs = [];
const reg = (a, x) => { let i = a.indexOf(x); if (i < 0) { a.push(x); i = a.length - 1; } return i; };
const BUILTIN = { 'General': 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9 };
function xfOf(sp) {
  const f = Object.assign({ name: 'Segoe UI', sz: 10, color: INK }, sp.font || {});
  const fi = reg(fonts, `<font>${f.b ? '<b/>' : ''}${f.i ? '<i/>' : ''}<sz val="${f.sz}"/><color rgb="FF${f.color}"/><name val="${f.name}"/><family val="2"/></font>`);
  const fl = sp.fill ? reg(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${sp.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
  const b = sp.border || {}; const sd = (t, c) => c ? `<${t} style="thin"><color rgb="FF${c}"/></${t}>` : `<${t}/>`;
  const bi = reg(borders, `<border>${sd('left', b.l)}${sd('right', b.r)}${sd('top', b.t)}${sd('bottom', b.b)}<diagonal/></border>`);
  let nf = 0; if (sp.numFmt) nf = sp.numFmt in BUILTIN ? BUILTIN[sp.numFmt] : 164 + reg(numFmts, sp.numFmt);
  const a = sp.align || {};
  const al = `<alignment vertical="${a.v || 'center'}"${a.h ? ` horizontal="${a.h}"` : ''}${a.wrap ? ' wrapText="1"' : ''}${a.indent ? ` indent="${a.indent}"` : ''}/>`;
  return reg(xfs, `<xf numFmtId="${nf}" fontId="${fi}" fillId="${fl}" borderId="${bi}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${al}</xf>`);
}
xfOf({});
const merge = (a, b) => ({ ...a, ...b, font: { ...(a.font || {}), ...(b.font || {}) }, border: { ...(a.border || {}), ...(b.border || {}) }, align: { ...(a.align || {}), ...(b.align || {}) } });
const st = {
  band: { fill: INK }, label: { font: { sz: 8, b: 1, color: MUTED } }, h2: { font: { sz: 12, b: 1 } },
  meta: { font: { sz: 9, color: MUTED }, align: { h: 'right' } },
  th: { fill: HEADF, font: { sz: 8, b: 1, color: MUTED }, border: { t: LINE, b: LINE, r: 'EBE9E2' } },
  thR: { fill: HEADF, font: { sz: 8, b: 1, color: MUTED }, border: { t: LINE, b: LINE, r: 'EBE9E2' }, align: { h: 'right' } },
  td: { fill: 'FFFFFF', border: { b: ROWL, r: VL } },
  tdNum: { fill: 'FFFFFF', border: { b: ROWL, r: VL }, font: { name: MONO, sz: 10 }, numFmt: '#,##0.00', align: { h: 'right' } },
  tdDate: { fill: 'FFFFFF', border: { b: ROWL, r: VL }, font: { name: MONO, sz: 10, color: SUB }, numFmt: 'dd/mm/yyyy', align: { h: 'left' } },
  tdMono: { fill: 'FFFFFF', border: { b: ROWL, r: VL }, font: { name: MONO, sz: 9.5, color: SUB } },
  input: { fill: HEADF, font: { name: MONO, sz: 10 }, numFmt: '#,##0.00', align: { h: 'right' } },
};
class Sheet {
  constructor(name) { Object.assign(this, { name, cells: {}, cols: [], rowHt: {}, dv: [], cf: [], tables: [], merges: [], hidden: [], drawing: null, tab: null, selected: false, defHt: 20 }); }
  sp(ref, sp) { const c = this.cells[ref] || (this.cells[ref] = { v: undefined, sp: {} }); c.sp = merge(c.sp, sp || {}); return c; }
  set(ref, v, sp) { const c = this.sp(ref, sp); c.v = v; }
  range(r1, r2, fn) { const [c1, a] = parse(r1), [c2, b] = parse(r2); for (let r = a; r <= b; r++) for (let c = c1; c <= c2; c++) fn(colL(c) + r, c, r, c === c1, c === c2, r === a, r === b); }
  card(r1, r2) { this.range(r1, r2, (ref, c, r, L, R, T, B) => this.sp(ref, { fill: 'FFFFFF', border: { l: L ? LINE : undefined, r: R ? LINE : undefined, t: T ? LINE : undefined, b: B ? LINE : undefined } })); }
  fill(r1, r2, sp) { this.range(r1, r2, ref => this.sp(ref, sp)); }
  mergeR(r1, r2) { this.merges.push(r1 + ':' + r2); }
  xml() {
    const rows = {}; for (const k in this.cells) { const [c, r] = parse(k); (rows[r] = rows[r] || []).push([c, this.cells[k]]); }
    const bgS = xfOf({ fill: BG });
    const all = new Set([...Object.keys(rows).map(Number), ...Object.keys(this.rowHt).map(Number)]);
    const rowsXml = [...all].sort((a, b) => a - b).map(r => {
      const cells = (rows[r] || []).sort((a, b) => a[0] - b[0]).map(([c, { v, sp }]) => {
        const ref = colL(c) + r, s = xfOf(sp);
        if (v === undefined || v === null || v === '') return `<c r="${ref}" s="${s}"/>`;
        if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
        if (v.f) return `<c r="${ref}" s="${s}"><f>${esc(v.f)}</f></c>`;
        if (v.rich) return `<c r="${ref}" s="${s}" t="s"><v>${si(v.rich)}</v></c>`;
        return `<c r="${ref}" s="${s}" t="s"><v>${si(`<t xml:space="preserve">${esc(v)}</t>`)}</v></c>`;
      }).join('');
      const ht = this.rowHt[r] ? ` ht="${this.rowHt[r]}" customHeight="1"` : ''; return `<row r="${r}" s="${bgS}" customFormat="1"${ht}>${cells}</row>`;
    }).join('');
    const cols = `<cols>${this.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" style="${bgS}" customWidth="1"${this.hidden.includes(i) ? ' hidden="1"' : ''}/>`).join('')}<col min="${this.cols.length + 1}" max="60" width="9" style="${bgS}"/></cols>`;
    const view = `<sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="100"${this.selected ? ' tabSelected="1"' : ''}/></sheetViews>`;
    const pr = this.tab ? `<sheetPr><tabColor rgb="FF${this.tab}"/></sheetPr>` : '';
    const mg = this.merges.length ? `<mergeCells count="${this.merges.length}">${this.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const cf = this.cf.map(x => `<conditionalFormatting sqref="${x.sqref}">${x.rules}</conditionalFormatting>`).join('');
    const dv = this.dv.length ? `<dataValidations count="${this.dv.length}">${this.dv.map(d => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${d.sqref}"><formula1>${esc(d.f)}</formula1></dataValidation>`).join('')}</dataValidations>` : '';
    let rid = 1; const dr = this.drawing ? `<drawing r:id="rId${rid++}"/>` : '';
    const tp = this.tables.length ? `<tableParts count="${this.tables.length}">${this.tables.map(() => `<tablePart r:id="rId${rid++}"/>`).join('')}</tableParts>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pr}${view}<sheetFormatPr defaultRowHeight="${this.defHt}" customHeight="1"/>${cols}<sheetData>${rowsXml}</sheetData>${mg}${cf}${dv}<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>${dr}${tp}</worksheet>`;
  }
  px(c) { return Math.round((this.cols[c] ?? 9) * 7 + 5); } rowPx(r) { return (this.rowHt[r] || this.defHt) * 4 / 3; }
  xAt(c) { let x = 0; for (let i = 0; i < c; i++) x += this.px(i); return x; } yAt(r) { let y = 0; for (let i = 1; i < r; i++) y += this.rowPx(i); return y; }
  anchor(x, y) { let c = 0, acc = 0; while (acc + this.px(c) <= x) { acc += this.px(c); c++; } let r = 1, ay = 0; while (ay + this.rowPx(r) <= y) { ay += this.rowPx(r); r++; }
    return `<xdr:col>${c}</xdr:col><xdr:colOff>${Math.round((x - acc) * 9525)}</xdr:colOff><xdr:row>${r - 1}</xdr:row><xdr:rowOff>${Math.round((y - ay) * 9525)}</xdr:rowOff>`; }
}
const neg = (sq, p = 1) => ({ sqref: sq, rules: `<cfRule type="cellIs" dxfId="0" priority="${p}" operator="lessThan"><formula>0</formula></cfRule>` });
const tables = [];
function addTable(sh, name, r1, r2, cols) {
  tables.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${tables.length + 1}" name="${name}" displayName="${name}" ref="${r1}:${r2}" totalsRowShown="0"><tableColumns count="${cols.length}">${cols.map((c, i) => `<tableColumn id="${i + 1}" name="${esc(c.name)}"${c.f ? `><calculatedColumnFormula>${esc(c.f)}</calculatedColumnFormula></tableColumn>` : '/>'}`).join('')}</tableColumns><tableStyleInfo showFirstColumn="0" showLastColumn="0" showRowStripes="0" showColumnStripes="0"/></table>`);
  sh.tables.push(tables.length);
}
function table(sh, name, startRef, cols, rows) {
  const [c0, r0] = parse(startRef);
  cols.forEach((c, i) => sh.set(colL(c0 + i) + r0, c.name, c.num ? st.thR : st.th));
  rows.forEach((row, ri) => cols.forEach((c, i) => sh.set(colL(c0 + i) + (r0 + 1 + ri), c.f ? { f: c.f } : row[i], merge(c.st || st.td, {}))));
  addTable(sh, name, startRef, colL(c0 + cols.length - 1) + (r0 + rows.length), cols);
}
const TR = (t, c) => `${t}[[#This Row],[${c}]]`;
const rich = parts => ({ rich: parts.map(([t, color]) => `<r><rPr><sz val="10"/><color rgb="FF${color}"/><rFont val="Segoe UI"/></rPr><t xml:space="preserve">${esc(t)}</t></r>`).join('') });
const label = k => { const [y, m] = k.split('-'); return MESES[+m - 1] + ' ' + y; };
const charts = [], drawings = [];

function monthSheet(mo) {
  const [y, m] = mo.key.split('-').map(Number);
  const name = label(mo.key), X = `${y}_${String(m).padStart(2, '0')}`, Q = `'${name}'`;
  const sh = new Sheet(name); sh.tab = GREEN;
  sh.cols = [2, 16, 22, 16, 15, 14, 12, 8, 13, 12, 18, 3, 11, 10, 10, 8, 12, 2, 2, 14]; sh.hidden = [19];
  const fixedN = Math.max(15, mo.fixed.length + 3), envN = Math.max(5, mo.transfers.length + 2);
  const fxEnd = 15 + fixedN, envTitle = 28, envEnd = 29 + envN;
  const hTitle = Math.max(fxEnd + 1, envEnd + 1) + 2;
  Object.assign(sh.rowHt, { 1: 26, 2: 16, 3: 6, 4: 18, 5: 28, 6: 18, 7: 10, 8: 20, 9: 20, 10: 20, 11: 20, 12: 10, 13: 10, 14: 26, [fxEnd + 1]: 6, [envEnd + 1]: 6, [hTitle]: 26 });
  sh.fill('A1', 'R1', st.band);
  sh.set('B1', 'Finanzas personales', merge(st.band, { font: { sz: 13, b: 1, color: 'F4F3EE' } }));
  sh.set('D1', name, merge(st.band, { font: { sz: 11, color: 'A9ABA3' } }));
  sh.set('M1', 'Tasa del mes', merge(st.band, { font: { sz: 9, color: 'A9ABA3' }, align: { h: 'right' } }));
  sh.set('N1', { f: '"1 USD = "&FIXED($T$3,2)&" DOP"' }, merge(st.band, { font: { name: MONO, sz: 10, color: 'F4F3EE' }, align: { h: 'right' } })); sh.mergeR('N1', 'Q1');
  sh.set('B2', 'Mes nuevo: usa "Cerrar mes" en la página y descarga el Excel, o duplica esta hoja (clic derecho en la pestaña → Mover o copiar → Crear una copia).', { font: { sz: 8, i: 1, color: MUTED } });
  sh.card('B4', 'D12'); sh.card('E4', 'I12'); sh.card('J4', 'Q12');
  sh.set('B4', 'DINERO TOTAL', st.label);
  sh.set('B5', { f: 'C8*$T$3+C9' }, { font: { name: MONO, sz: 18, b: 1 }, numFmt: '#,##0.00" DOP"' }); sh.mergeR('B5', 'D5');
  sh.set('B6', { f: 'C8+C9/$T$3' }, { font: { name: MONO, sz: 9.5, color: MUTED }, numFmt: '"≈ "#,##0.00" USD"' }); sh.mergeR('B6', 'D6');
  const acc = mo.accounts || {};
  [['Cuenta USA', num(acc.usd), 'USD'], ['Cuenta RD', num(acc.dop), 'DOP'], ['Ingreso del mes', num(mo.incomeUSD), 'USD']].forEach(([l, v, u], i) => { const r = 8 + i;
    sh.set('B' + r, l, { font: { color: SUB }, border: { b: ROWL } }); sh.set('C' + r, v, merge(st.input, { border: { b: ROWL } })); sh.set('D' + r, u, { font: { sz: 8, color: MUTED }, align: { indent: 1 }, border: { b: ROWL } }); });
  sh.set('B11', 'Ingreso − usado', { font: { color: SUB } });
  sh.set('C11', { f: 'C10*$T$3-$T$8' }, { font: { name: MONO, sz: 10 }, numFmt: '#,##0.00" DOP"', align: { h: 'right' } }); sh.mergeR('C11', 'D11');
  sh.cf.push(neg('C11', 1));
  sh.set('G4', 'PRESUPUESTO USADO', st.label);
  [['Fijos pagados', DARK, '$T$4'], ['Transacciones', GREEN, '$T$5'], ['Fijos pendientes', 'B7C4B7', '$T$6'], ['Libre', 'DCDAD1', '$T$7']].forEach(([l, c, ref], i) => { const r = [6, 8, 9, 10][i];
    sh.set('G' + r, rich([['■  ', c], [l, INK]]), {}); sh.mergeR('G' + r, 'H' + r); sh.set('I' + r, { f: ref }, { font: { name: MONO, sz: 10 }, numFmt: '#,##0', align: { h: 'right' } }); });
  sh.set('J4', { f: 'UPPER($D$1)' }, st.label);
  [['Presupuesto planeado', num(mo.budget), 'input', 6], ['Usado hasta hoy', { f: '$T$8' }, 'b', 8], ['Disponible', { f: 'O6-O8' }, 'disp', 9], ['Disponible tras fijos pendientes', { f: 'O9-$T$6' }, '', 10], ['Usado en USD', { f: '$T$8/$T$3' }, 'usd', 11]].forEach(([l, v, k, r]) => {
    sh.fill('J' + r, 'Q' + r, { border: { b: ROWL } });
    sh.set('J' + r, l, { font: { b: k === 'b' || k === 'disp' ? 1 : 0, color: k === '' || k === 'usd' ? SUB : INK }, border: { b: ROWL } });
    const vs = k === 'input' ? merge(st.input, { font: { b: 1 } }) : { font: { name: MONO, sz: 10, b: k === 'b' || k === 'disp' ? 1 : 0, color: k === 'disp' ? DGREEN : (k === '' || k === 'usd' ? SUB : INK) }, numFmt: '#,##0.00', align: { h: 'right' } };
    sh.set('O' + r, v, merge(vs, { border: { b: ROWL } })); sh.mergeR('O' + r, 'Q' + r); });
  sh.set('J5', { f: 'FIXED(100*$T$8/MAX(1,O6),1)&"% del presupuesto usado"' }, { font: { sz: 9, color: MUTED }, align: { v: 'bottom' } });
  sh.cf.push(neg('O9:O10', 2));
  const F = `Fijos_${X}`, E = `Env_${X}`, T = `Tx_${X}`;
  sh.set('T2', 'Cálculos', { font: { b: 1 } });
  sh.set('T3', { f: `IFERROR(SUMPRODUCT(${E}[USD],${E}[Tasa])/SUM(${E}[USD]),Config!$C$4)` });
  sh.set('T4', { f: `SUMIFS(${F}[DOP],${F}[Pagado],"Sí")` });
  sh.set('T5', { f: `SUM(${T}[DOP])` });
  sh.set('T6', { f: `SUMIFS(${F}[DOP],${F}[Pagado],"No")` });
  sh.set('T7', { f: 'MAX(0,O6-T4-T5-T6)' }); sh.set('T8', { f: 'T4+T5' });
  sh.set('T9', { f: 'FIXED(T8,0)' }); sh.set('T10', { f: '"de "&FIXED(O6,0)&" DOP"' });
  // Gastos mensuales
  sh.card('B14', 'K' + (fxEnd + 1));
  sh.set('B14', 'Gastos mensuales', st.h2);
  sh.set('H14', { f: `COUNTIFS(${F}[Pagado],"Sí")&" de "&COUNTA(${F}[Concepto])&" pagados · total "&FIXED(SUM(${F}[DOP]),2)&" DOP"` }, st.meta); sh.mergeR('H14', 'K14');
  const fxRows = mo.fixed.map(f => [f.paid ? 'Sí' : 'No', f.name, num(f.day) ?? (f.day || null), num(f.amount), f.cur || 'DOP', null, null]);
  while (fxRows.length < fixedN) fxRows.push([null, null, null, null, null, null, null]);
  table(sh, F, 'B15', [{ name: 'Pagado', st: merge(st.td, { align: { h: 'center' }, font: { b: 1 } }) }, { name: 'Concepto' }, { name: 'Día de cobro', st: st.tdMono }, { name: 'Monto', num: 1, st: st.tdNum }, { name: 'Moneda', st: st.tdMono },
    { name: 'DOP', num: 1, st: merge(st.tdNum, { font: { b: 1 } }), f: `IF(${TR(F, 'Monto')}="","",IF(${TR(F, 'Moneda')}="USD",${TR(F, 'Monto')}*$T$3,${TR(F, 'Monto')}))` },
    { name: 'USD', num: 1, st: merge(st.tdNum, { font: { color: MUTED } }), f: `IF(${TR(F, 'DOP')}="","",${TR(F, 'DOP')}/$T$3)` }], fxRows);
  sh.dv.push({ sqref: `B16:B${fxEnd}`, f: '"Sí,No"' }, { sqref: `F16:F${fxEnd}`, f: '"DOP,USD"' });
  sh.cf.push({ sqref: `B16:B${fxEnd}`, rules: `<cfRule type="cellIs" dxfId="1" priority="3" operator="equal"><formula>"Sí"</formula></cfRule><cfRule type="cellIs" dxfId="2" priority="4" operator="equal"><formula>"No"</formula></cfRule>` });
  // Por categoría
  sh.card('M14', 'Q26');
  sh.set('M14', 'Por categoría', st.h2); sh.set('Q14', 'DOP', st.meta);
  ['Gastos fijos', ...CATS].forEach((c, i) => { const r = 15 + i;
    sh.set('M' + r, c, {}); sh.mergeR('M' + r, 'N' + r);
    sh.set('O' + r, { f: `Q${r}` }, { font: { color: 'FFFFFF', sz: 6 } }); sh.mergeR('O' + r, 'P' + r);
    sh.set('Q' + r, i === 0 ? { f: '$T$4' } : { f: `SUMIFS(${T}[DOP],${T}[Categoría],M${r})` }, { font: { name: MONO, sz: 10 }, numFmt: '#,##0', align: { h: 'right' } }); });
  const bar = (sq, col, p) => ({ sqref: sq, rules: `<cfRule type="dataBar" priority="${p}"><dataBar showValue="0"><cfvo type="num" val="0"/><cfvo type="formula" val="MAX($Q$15:$Q$25)"/><color rgb="FF${col}"/></dataBar></cfRule>` });
  sh.cf.push(bar('O15:P15', DARK, 5), bar('O16:P25', GREEN, 6));
  // Envíos
  sh.card('M' + envTitle, 'Q' + (envEnd + 1));
  sh.set('M' + envTitle, 'Envíos USD → DOP', st.h2); sh.set('O' + envTitle, { f: '"Promedio "&FIXED($T$3,2)' }, st.meta); sh.mergeR('O' + envTitle, 'Q' + envTitle);
  const envRows = mo.transfers.map(t => [serialISO(t.date), t.via || 'Remitly', num(t.usd), num(t.rate), null]);
  while (envRows.length < envN) envRows.push([null, null, null, null, null]);
  table(sh, E, 'M29', [{ name: 'Fecha', st: st.tdDate }, { name: 'Vía' }, { name: 'USD', num: 1, st: st.tdNum }, { name: 'Tasa', num: 1, st: merge(st.tdNum, { numFmt: '0.00' }) }, { name: 'DOP', num: 1, st: st.tdNum, f: `IF(${TR(E, 'USD')}="","",${TR(E, 'USD')}*${TR(E, 'Tasa')})` }], envRows);
  sh.dv.push({ sqref: `N30:N${envEnd}`, f: '"Remitly,PayPal"' });
  // Historial
  const txs = [...mo.tx].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const txRows = txs.map(t => [serialISO(t.date), t.desc || '', t.place || '', t.cat || '', t.method || '', num(t.amount), t.cur || 'DOP', null, null, t.notes || '']);
  for (let i = 0; i < 12; i++) txRows.push([null, null, null, null, null, null, null, null, null, null]);
  const hHead = hTitle + 1, last = hHead + txRows.length;
  sh.card('B' + hTitle, 'K' + last);
  sh.set('B' + hTitle, 'Historial de transacciones', st.h2);
  sh.set('H' + hTitle, { f: `COUNT(${T}[Monto])&" transacciones · total "&FIXED($T$5,2)&" DOP"` }, st.meta); sh.mergeR('H' + hTitle, 'K' + hTitle);
  table(sh, T, 'B' + hHead, [{ name: 'Fecha', st: st.tdDate }, { name: 'Descripción' }, { name: 'Lugar', st: merge(st.td, { font: { color: SUB } }) }, { name: 'Categoría' }, { name: 'Método', st: merge(st.td, { font: { color: SUB } }) }, { name: 'Monto', num: 1, st: st.tdNum }, { name: 'Moneda', st: st.tdMono },
    { name: 'DOP', num: 1, st: merge(st.tdNum, { font: { b: 1 } }), f: `IF(${TR(T, 'Monto')}="","",IF(${TR(T, 'Moneda')}="USD",${TR(T, 'Monto')}*$T$3,${TR(T, 'Monto')}))` },
    { name: 'USD', num: 1, st: merge(st.tdNum, { font: { color: MUTED } }), f: `IF(${TR(T, 'DOP')}="","",${TR(T, 'DOP')}/$T$3)` }, { name: 'Notas', st: merge(st.td, { font: { sz: 9, color: MUTED } }) }], txRows);
  sh.dv.push({ sqref: `E${hHead + 1}:E3000`, f: 'Config!$E$4:$E$13' }, { sqref: `F${hHead + 1}:F3000`, f: 'Config!$F$4:$F$6' }, { sqref: `H${hHead + 1}:H3000`, f: '"DOP,USD"' });
  // dona
  const panelTop = sh.yAt(4), panelH = sh.yAt(13) - panelTop, size = Math.min(196, panelH - 14);
  const cx0 = sh.xAt(4) + (sh.px(4) + sh.px(5)) / 2, cy0 = panelTop + panelH / 2;
  const cid = charts.length + 1;
  charts.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout><c:manualLayout><c:layoutTarget val="inner"/><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="0.03"/><c:y val="0.03"/><c:w val="0.94"/><c:h val="0.94"/></c:manualLayout></c:layout><c:doughnutChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Presupuesto</c:v></c:tx>${[DARK, GREEN, 'C9D3C9', 'EBE9E1'].map((col, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${col}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:dPt>`).join('')}<c:val><c:numRef><c:f>${esc(Q)}!$T$4:$T$7</c:f></c:numRef></c:val></c:ser><c:firstSliceAng val="0"/><c:holeSize val="72"/></c:doughnutChart><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea><c:plotVisOnly val="0"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>`);
  const ns = 'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const frame = (x, y, w, h) => `<xdr:twoCellAnchor editAs="oneCell"><xdr:from>${sh.anchor(x, y)}</xdr:from><xdr:to>${sh.anchor(x + w, y + h)}</xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Dona presupuesto"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  let sid = 3;
  const tb = (link, text, x, y, w, h, sz, b, col) => { const g = `${(10000000 + cid * 1000 + sid).toString(16).toUpperCase().padStart(8, '0')}-1B2C-4D3E-8F4A-5B6C7D8E9F0A`;
    const body = link ? `<a:fld id="{${g}}" type="TxLink"><a:rPr lang="es-DO" sz="${sz}" b="${b}"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill><a:latin typeface="${b ? MONO : 'Segoe UI'}"/></a:rPr><a:pPr algn="ctr"/><a:t>${esc(text)}</a:t></a:fld>` : `<a:r><a:rPr lang="es-DO" sz="${sz}" b="${b}"><a:solidFill><a:srgbClr val="${col}"/></a:solidFill><a:latin typeface="Segoe UI"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
    return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from>${sh.anchor(x, y)}</xdr:from><xdr:to>${sh.anchor(x + w, y + h)}</xdr:to><xdr:sp macro="" textlink="${link || ''}"><xdr:nvSpPr><xdr:cNvPr id="${sid++}" name="Centro ${sid}"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></xdr:spPr><xdr:txBody><a:bodyPr vertOverflow="overflow" horzOverflow="overflow" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>${body}<a:endParaRPr lang="es-DO" sz="${sz}"/></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>`; };
  const usedNow = (mo.fixed.filter(f => f.paid).length ? 0 : 0);
  drawings.push({ chart: cid, xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr ${ns}>${frame(cx0 - size / 2, cy0 - size / 2, size, size)}${tb('', 'USADO', cx0 - 60, cy0 - 30, 120, 14, 700, 1, MUTED)}${tb('$T$9', String(mo.usedText || usedNow), cx0 - 70, cy0 - 15, 140, 24, 1500, 1, INK)}${tb('$T$10', mo.budgetText || '', cx0 - 70, cy0 + 10, 140, 16, 800, 0, MUTED)}</xdr:wsDr>` });
  sh.drawing = drawings.length;
  return sh;
}

let monthsData = [...(data.months || [])].sort((a, b) => a.key.localeCompare(b.key));
if (!monthsData.length) { const d = new Date(); monthsData = [{ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), budget: null, incomeUSD: null, accounts: {}, fixed: [], transfers: [], tx: [] }]; }
const months = monthsData.map(monthSheet);
months[months.length - 1].selected = true;
const curLabel = label(monthsData[monthsData.length - 1].key);

// Ahorros
const A = new Sheet('Ahorros'); A.tab = INK;
A.cols = [2, 17, 13, 9, 14, 13, 9, 3, 12, 16, 19, 11, 8, 11, 12, 2, 2, 14]; A.hidden = [17];
const firstKey = monthsData[0].key; const [fy, fm] = firstKey.split('-').map(Number);
const lastKey = monthsData[monthsData.length - 1].key; const [ly, lm] = lastKey.split('-').map(Number);
const incN = Math.max(15, (ly - fy) * 12 + (lm - fm) + 1 + 12);
const incEnd = 15 + incN;
Object.assign(A.rowHt, { 1: 26, 2: 8, 3: 16, 4: 24, 5: 10, 6: 24, 7: 16, 8: 28, 9: 16, 10: 14, 11: 20, 12: 24, 13: 10, 14: 26, [incEnd + 1]: 6 });
A.fill('A1', 'P1', st.band);
A.set('B1', 'Finanzas personales', merge(st.band, { font: { sz: 13, b: 1, color: 'F4F3EE' } }));
A.set('D1', 'Ahorros', merge(st.band, { font: { sz: 11, color: 'A9ABA3' } }));
const IND = c => `INDIRECT("'"&Config!$C$5&"'!${c}")`;
A.card('B3', 'O4');
[['B', 'MES ACTUAL', { f: 'Config!$C$5' }, { font: { b: 1, sz: 11 } }], ['C', 'DINERO TOTAL (DOP)', { f: `IFERROR(${IND('B5')},"")` }, { font: { name: MONO, b: 1, sz: 11 }, numFmt: '#,##0.00' }], ['F', 'PRESUPUESTO', { f: `IFERROR(${IND('O6')},"")` }, { font: { name: MONO, sz: 11 }, numFmt: '#,##0.00' }], ['I', 'USADO', { f: `IFERROR(${IND('T8')},"")` }, { font: { name: MONO, sz: 11 }, numFmt: '#,##0.00' }], ['K', 'DISPONIBLE', { f: `IFERROR(${IND('O9')},"")` }, { font: { name: MONO, b: 1, sz: 11, color: DGREEN }, numFmt: '#,##0.00' }], ['N', 'TASA', { f: `IFERROR(${IND('T3')},Config!$C$4)` }, { font: { name: MONO, sz: 11 }, numFmt: '0.00' }]].forEach(([c, l, f, s]) => { A.set(c + '3', l, st.label); A.set(c + '4', f, s); });
A.mergeR('C4', 'E4'); A.mergeR('C3', 'E3'); A.mergeR('F4', 'H4'); A.mergeR('I4', 'J4'); A.mergeR('K4', 'M4'); A.mergeR('N4', 'O4');
A.cf.push(neg('K4', 1));
A.set('R2', 'Cálculos', { font: { b: 1 } });
A.set('R3', { f: `IFERROR(${IND('T3')},Config!$C$4)` });
A.set('R4', { f: 'J12*((YEAR(N12)-YEAR(L12))*12+MONTH(N12)-MONTH(L12)+1)' });
A.set('R5', { f: 'SUMIFS(Aportes[USD],Aportes[Meta],"Viaje a Turquía")' });
A.set('R6', { f: 'MAX(1,(YEAR(N12)-YEAR(TODAY()))*12+MONTH(N12)-MONTH(TODAY())+1-IF(COUNTIFS(Aportes[Meta],"Viaje a Turquía",Aportes[Mes],Config!$C$5)>0,1,0))' });
A.set('R7', { f: 'MAX(0,R4-R5)/R6' }); A.set('R8', { f: 'IF(R4=0,0,R5/R4)' });
[['B', 'D', 'Fondo de emergencia'], ['E', 'G', 'Ahorro personal']].forEach(([c1, c2, n]) => {
  A.card(c1 + '6', c2 + '12'); A.set(c1 + '6', n, st.h2); A.set(c1 + '7', 'Aportes variables', { font: { sz: 9, color: MUTED } });
  A.set(c1 + '8', { f: `SUMIFS(Aportes[USD],Aportes[Meta],"${n}")` }, { font: { name: MONO, sz: 16, b: 1 }, numFmt: '#,##0.00" USD"' }); A.mergeR(c1 + '8', c2 + '8');
  A.set(c1 + '9', { f: `${c1}8*$R$3` }, { font: { name: MONO, sz: 9, color: MUTED }, numFmt: '"≈ "#,##0" DOP"' }); A.mergeR(c1 + '9', c2 + '9');
  A.set(c1 + '11', { f: `COUNTIFS(Aportes[Meta],"${n}")&" aportes registrados"` }, { font: { sz: 9, color: MUTED } }); A.mergeR(c1 + '11', c2 + '11'); });
const tk = data.turkey || {};
A.card('I6', 'O12');
A.set('I6', 'Viaje a Turquía', st.h2); A.set('L6', { f: 'FIXED(J12,0)&" USD / mes"' }, st.meta); A.mergeR('L6', 'O6');
A.set('I7', { f: '"Faltan "&$R$6&" aportes · "&FIXED($R$7,0)&" USD por mes para llegar"' }, { font: { sz: 9, color: MUTED } }); A.mergeR('I7', 'O7');
A.set('I8', { f: '$R$5' }, { font: { name: MONO, sz: 16, b: 1 }, numFmt: '#,##0.00" USD"' }); A.mergeR('I8', 'K8');
A.set('L8', { f: '$R$5*$R$3' }, { font: { name: MONO, sz: 9, color: MUTED }, numFmt: '"≈ "#,##0" DOP"', align: { h: 'right' } }); A.mergeR('L8', 'O8');
A.set('I10', { f: '$R$8' }, { font: { color: 'FFFFFF', sz: 6 } }); A.mergeR('I10', 'O10');
A.cf.push({ sqref: 'I10:O10', rules: `<cfRule type="dataBar" priority="2"><dataBar showValue="0"><cfvo type="num" val="0"/><cfvo type="num" val="1"/><color rgb="FF2F7D52"/></dataBar></cfRule>` });
A.set('I11', { f: 'FIXED(100*$R$8,0)&"% de "&FIXED($R$4,0)&" USD"' }, { font: { sz: 9, color: SUB } }); A.mergeR('I11', 'K11');
A.set('L11', { f: '"Meta: "&LOWER(CHOOSE(MONTH(N12),"Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"))&" "&YEAR(N12)' }, st.meta); A.mergeR('L11', 'O11');
A.set('I12', 'Aporte', { font: { sz: 9, color: MUTED } }); A.set('J12', num(tk.monthlyUSD) ?? 3000, merge(st.input, { numFmt: '#,##0' }));
A.set('K12', 'Inicio', { font: { sz: 9, color: MUTED }, align: { h: 'right' } }); A.set('L12', serialISO((tk.start || '2026-08') + '-01'), merge(st.input, { numFmt: 'mm/yyyy' }));
A.set('M12', 'Fin', { font: { sz: 9, color: MUTED }, align: { h: 'right' } }); A.set('N12', serialISO((tk.end || '2027-10') + '-01'), merge(st.input, { numFmt: 'mm/yyyy' })); A.mergeR('N12', 'O12');
A.card('B14', 'G' + (incEnd + 1)); A.set('B14', 'Ingresos por mes', st.h2);
['Mes', 'Ingreso USD', 'Tasa', 'Ingreso DOP', 'Ahorrado USD', '% ahorro'].forEach((h, i) => A.set(colL(1 + i) + '15', h, i ? st.thR : st.th));
for (let i = 0; i < incN; i++) { const r = 16 + i, mm = (fm - 1 + i) % 12 + 1, yy = fy + Math.floor((fm - 1 + i) / 12);
  A.set('B' + r, MESES[mm - 1] + ' ' + yy, st.td);
  A.set('C' + r, { f: `IFERROR(INDIRECT("'"&B${r}&"'!C10"),"")` }, st.tdNum);
  A.set('D' + r, { f: `IFERROR(INDIRECT("'"&B${r}&"'!T3"),"")` }, merge(st.tdNum, { numFmt: '0.00', font: { color: MUTED } }));
  A.set('E' + r, { f: `IF(C${r}="","",C${r}*D${r})` }, st.tdNum);
  A.set('F' + r, { f: `IF(C${r}="","",SUMIFS(Aportes[USD],Aportes[Mes],B${r}))` }, st.tdNum);
  A.set('G' + r, { f: `IF(OR(C${r}="",C${r}=0),"",F${r}/C${r})` }, merge(st.tdNum, { numFmt: '0.0%', font: { color: DGREEN } })); }
const apRows = [...(data.contribs || [])].sort((a, b) => String(a.date).localeCompare(String(b.date))).map(c => [serialISO(c.date), null, c.goalName, num(c.amount), c.cur || 'USD', null, null]);
for (let i = 0; i < 10; i++) apRows.push([null, null, null, null, null, null, null]);
A.card('I14', 'O' + (15 + apRows.length));
A.set('I14', 'Aportes', st.h2); A.set('L14', { f: '"Total "&FIXED(SUM(Aportes[USD]),2)&" USD"' }, st.meta); A.mergeR('L14', 'O14');
const RT = x => `IFERROR(INDIRECT("'"&${x}&"'!T3"),Config!$C$4)`;
table(A, 'Aportes', 'I15', [{ name: 'Fecha', st: st.tdDate }, { name: 'Mes', st: merge(st.td, { font: { sz: 9, color: MUTED } }), f: `IF(${TR('Aportes', 'Fecha')}="","",CHOOSE(MONTH(${TR('Aportes', 'Fecha')}),"Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre")&" "&YEAR(${TR('Aportes', 'Fecha')}))` }, { name: 'Meta' }, { name: 'Monto', num: 1, st: st.tdNum }, { name: 'Moneda', st: st.tdMono },
  { name: 'USD', num: 1, st: merge(st.tdNum, { font: { b: 1 } }), f: `IF(${TR('Aportes', 'Monto')}="","",IF(${TR('Aportes', 'Moneda')}="USD",${TR('Aportes', 'Monto')},${TR('Aportes', 'Monto')}/${RT(TR('Aportes', 'Mes'))}))` },
  { name: 'DOP', num: 1, st: merge(st.tdNum, { font: { color: MUTED } }), f: `IF(${TR('Aportes', 'USD')}="","",${TR('Aportes', 'USD')}*${RT(TR('Aportes', 'Mes'))})` }], apRows);
A.dv.push({ sqref: 'K16:K2000', f: 'Config!$G$4:$G$6' }, { sqref: 'M16:M2000', f: '"USD,DOP"' });

// Config
const C = new Sheet('Config'); C.tab = 'A9ABA3'; C.cols = [2, 34, 14, 3, 18, 16, 22];
C.fill('A1', 'G1', st.band); C.rowHt[1] = 26; C.set('B1', 'Configuración', merge(st.band, { font: { sz: 13, b: 1, color: 'F4F3EE' } }));
C.card('B3', 'C6'); C.set('B3', 'AJUSTES', st.label);
C.set('B4', 'Tasa por defecto (mes sin envíos)', {}); C.set('C4', num(data.defaultRate) ?? 58.76, merge(st.input, { numFmt: '0.00' }));
C.set('B5', 'Mes actual (se muestra en Ahorros)', {}); C.set('C5', curLabel, merge(st.input, { font: { name: 'Segoe UI', b: 1 } }));
C.card('E3', 'G14');
C.set('E3', 'CATEGORÍAS', st.label); C.set('F3', 'MÉTODOS DE PAGO', st.label); C.set('G3', 'METAS DE AHORRO', st.label);
CATS.forEach((c, i) => C.set('E' + (4 + i), c, { border: { b: ROWL } })); METHODS.forEach((c, i) => C.set('F' + (4 + i), c, { border: { b: ROWL } })); GOALS.forEach((c, i) => C.set('G' + (4 + i), c, { border: { b: ROWL } }));

const sheets = [...months, A, C];
const files = {};
sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = s.xml();
  const rels = []; let rid = 1; if (s.drawing) rels.push(`<Relationship Id="rId${rid++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${s.drawing}.xml"/>`);
  s.tables.forEach(t => rels.push(`<Relationship Id="rId${rid++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${t}.xml"/>`));
  if (rels.length) files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`; });
tables.forEach((x, i) => files[`xl/tables/table${i + 1}.xml`] = x);
drawings.forEach((d, i) => { files[`xl/drawings/drawing${i + 1}.xml`] = d.xml; files[`xl/drawings/_rels/drawing${i + 1}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${d.chart}.xml"/></Relationships>`; });
charts.forEach((x, i) => files[`xl/charts/chart${i + 1}.xml`] = x);
files['xl/styles.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f).replace(/"/g, '&quot;')}"/>`).join('')}</numFmts>` : ''}<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="3"><dxf><font><b/><color rgb="FFB23A2A"/></font></dxf><dxf><font><b/><color rgb="FF23613F"/></font><fill><patternFill patternType="solid"><bgColor rgb="FFE6F0E9"/></patternFill></fill></dxf><dxf><font><color rgb="FF9A9C94"/></font></dxf></dxfs></styleSheet>`;
files['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map(x => `<si>${x}</si>`).join('')}</sst>`;
files['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="${months.length - 1}"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
files['_rels/.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${tables.map((t, i) => `<Override PartName="/xl/tables/table${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`).join('')}${drawings.map((d, i) => `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('')}${charts.map((c, i) => `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
return zip(files);
}

function zip(files) {
  const crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder(); const parts = [], central = []; let off = 0;
  const order = ['[Content_Types].xml', '_rels/.rels', ...Object.keys(files).filter(k => k !== '[Content_Types].xml' && k !== '_rels/.rels')];
  for (const name of order) { const data = enc.encode(files[name]), nb = enc.encode(name), c = crc(data);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, c, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, data);
    const cd = new DataView(new ArrayBuffer(46)); cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint32(16, c, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, nb.length, true); cd.setUint32(42, off, true);
    central.push(new Uint8Array(cd.buffer), nb); off += 30 + nb.length + data.length; }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, order.length, true); end.setUint16(10, order.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

window.buildFinanzasXlsx = build;
})();
