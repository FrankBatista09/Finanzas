// Prueba de humo de la hoja completa y del diálogo de metas: se pintan a HTML en Node (sin DOM) con los datos de
// ejemplo. No prueba interacciones (la lógica del formulario se prueba en goalForm.test.ts y la de las filas en
// model.test.ts); comprueba que el marcado lleva los textos, las cifras y los controles, en cada idioma.

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { seedState } from '../../../shared/seed';
import type { AppState, Goal, Language, MonthKey } from '../../../shared/types';
import { I18nProvider } from '../../i18n';
import { buildFinanzas, FinanzasContext } from '../../store';
import type { Actions } from '../../store';
import { AddRowsOpenContext } from '../../ui';
import { AhorrosScreen } from './AhorrosScreen';
import styles from './AhorrosScreen.module.css';
import { GoalDialog } from './GoalDialog';

interface Opts {
  state?: AppState;
  monthKey?: MonthKey;
  /** null = sin <I18nProvider>: manda el idioma del estado. */
  lang?: Language | null;
  /** Las filas de agregar: abiertas (como tras pulsar su "+ Add …") salvo que se pida false, que es como nace la pantalla. */
  addRows?: boolean;
}

function render(node: ReactNode, { state = seedState(), monthKey = '2026-10', lang = 'en', addRows = true }: Opts = {}): string {
  const value = buildFinanzas({ user: { id: 'frank', name: 'Frank' }, state, monthKey, today: '2026-10-07', actions: {} as Actions });
  const tree = (
    <AddRowsOpenContext value={addRows}>
      <FinanzasContext value={value}>{node}</FinanzasContext>
    </AddRowsOpenContext>
  );
  return renderToStaticMarkup(lang ? <I18nProvider lang={lang}>{tree}</I18nProvider> : tree);
}

const screen = (opts?: Opts) => render(<AhorrosScreen />, opts);
const dialog = (goal: Goal | null, opts?: Opts) => render(<GoalDialog goal={goal} onClose={() => {}} />, opts);

/** Texto visible, sin etiquetas. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

/** Atributos de cada <tag>, sin depender del orden en que React los escribe. */
function els(html: string, tag: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) =>
    Object.fromEntries([...m[1]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!.toLowerCase(), text(a[2] ?? '')])),
  );
}

/** Contenido de cada <tag>…</tag>, como texto. */
const inner = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 'g'))].map((m) => text(m[1]!).trim());

const goal = (state: AppState, id: string) => state.goals.find((g) => g.id === id)!;

/** El cuerpo (<tbody>) de la tabla con ese nombre accesible. */
function body(html: string, label: string): string {
  const table = html.slice(html.indexOf(`aria-label="${label}"`));
  return table.slice(table.indexOf('<tbody>'), table.indexOf('</tbody>'));
}

/** Las filas de un cuerpo de tabla, cada una con su marcado. */
const rowsOf = (tbody: string) => tbody.split('<tr').slice(1);

/** Los datos de ejemplo con la moneda principal y la segunda al revés. */
function usdMain(): AppState {
  const s = seedState();
  s.mainCurrency = 'USD';
  s.secondCurrency = 'DOP';
  return s;
}

const EN_HEADERS = ['Month', 'Income', 'Saved', '% saved', 'Date', 'Goal', 'Amount', 'Cur.', 'In goal', 'DOP', '', 'Date', 'Description', 'Account', 'Amount', 'Cur.', 'DOP', 'Adds to budget', ''];

describe('AhorrosScreen (inglés, el idioma por defecto)', () => {
  const html = screen();
  const t = text(html);

  it('tarjetas de metas: lo ahorrado en la moneda de la meta y "≈" en la principal', () => {
    expect(inner(html, 'h2')).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Income by month', 'Contributions', 'Income']);
    expect(t).toContain('Emergency fund Variable contributions Edit 1,200.00 USD ≈ 70,512 DOP 3 contributions recorded');
    expect(t).toContain('Personal savings Variable contributions Edit 450.00 USD ≈ 26,442 DOP 2 contributions recorded');
    expect(t).toContain(
      'Trip to Turkey 3,000 USD / month Edit 9,000.00 USD ≈ 528,840 DOP 20% of 45,000 USD Target: October 2027 12 contributions left · 3,000 USD per month to get there',
    );
  });

  it('cada tarjeta lleva su "Edit" y, después de la última, va la de "Add goal"', () => {
    const buttons = els(html, 'button');
    expect(inner(html, 'button').slice(0, 5)).toEqual(['Edit', 'Edit', 'Edit', '+ Add goal', 'Cancel']);
    expect(buttons.slice(0, 3).map((b) => b['aria-label'])).toEqual(['Edit Emergency fund', 'Edit Personal savings', 'Edit Trip to Turkey']);
    expect(buttons.slice(0, 4).every((b) => b.type === 'button')).toBe(true);
    expect(buttons[3]!.class).toBe(styles.addGoal);
    // El "+" es un adorno: el nombre accesible del botón es solo "Add goal".
    expect(html).toContain('<span class="' + styles.addGoalPlus + '" aria-hidden="true">+</span>Add goal</button>');
    // La tarjeta punteada va dentro de la rejilla, detrás de las metas.
    const grid = html.slice(html.indexOf(`class="${styles.goals}"`), html.indexOf(`class="${styles.row}"`));
    expect(grid.indexOf(styles.addGoal!)).toBeGreaterThan(grid.lastIndexOf('Trip to Turkey'));
    // Con el diálogo cerrado no hay nada más en la hoja.
    expect(html).not.toContain('role="dialog"');
  });

  it('solo la meta con objetivo lleva barra, con el ancho del porcentaje', () => {
    const bars = els(html, 'div').filter((d) => d.role === 'progressbar');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      'aria-valuenow': '20',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': 'Progress toward Trip to Turkey',
    });
    expect(html).toContain('style="width:20%"');
  });

  it('tres tablas, con sus encabezados; las columnas convertidas llevan el código de la moneda principal', () => {
    expect(inner(html, 'th')).toEqual(EN_HEADERS);
    expect(els(html, 'table').map((table) => table['aria-label'])).toEqual(['Income by month', 'Contributions', 'Income']);
    expect(els(html, 'th').filter((th) => th['aria-label'] === 'Actions')).toHaveLength(2);
    // Nada en la hoja está apagado ni es de solo lectura, y con los datos de ejemplo ninguna tasa es la de respaldo.
    expect(html).not.toMatch(/\b(readonly|disabled)\b/i);
    expect(html).not.toContain(styles.fallbackNote!);
    expect(t).not.toContain('*');
  });

  it('Income by month: una fila por mes, todo calculado; aquí no se escribe nada', () => {
    expect(t).toContain("Income by month In DOP, at each month's rate Month Income Saved % saved");
    expect(t).toContain('August 2026 337,463.33 212,369.17 62.9%');
    expect(t).toContain('September 2026 339,731.22 205,010.22 60.3%');
    expect(t).toContain('October 2026 340,808.00 205,660.00 60.3%');
    const tbody = body(html, 'Income by month');
    expect(rowsOf(tbody)).toHaveLength(3);
    expect(els(tbody, 'input')).toHaveLength(0);
    expect(els(tbody, 'select')).toHaveLength(0);
  });

  it('Contributions: total en la moneda principal, fila de agregar arriba e historial editable', () => {
    expect(t).toContain('Contributions Total 625,794.00 DOP'); // 10,650 USD × 58.76
    const tbody = body(html, 'Contributions');
    const rows = rowsOf(tbody);
    expect(rows).toHaveLength(9);

    // La fila de agregar es la primera del cuerpo de la tabla.
    const add = rows[0]!;
    const inputs = els(add, 'input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ type: 'date', value: '2026-10-07', 'aria-label': 'Contribution date' });
    expect(inputs[1]).toMatchObject({ type: 'number', step: 'any', value: '', placeholder: '0.00', style: 'min-width:70px', 'aria-label': 'Amount' });
    // El selector lleva las metas del usuario, en el orden de las tarjetas; la moneda arranca en la de la meta.
    expect(inner(add, 'select')).toEqual(['Emergency fund Personal savings Trip to Turkey', 'DOP USD TRY']);
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Goal', 'Currency']);
    expect(add).toContain('<option value="emergency" selected="">Emergency fund</option>');
    expect(add).toContain('<option value="DOP">DOP</option><option value="USD" selected="">USD</option><option value="TRY">TRY</option>');
    expect(els(add, 'td')).toContainEqual(expect.objectContaining({ colspan: '3' }));
    expect(add).toContain('>Add</button>');

    // Cada aporte se edita en su fila: fecha, meta, monto y moneda.
    const first = rows[1]!;
    expect(els(first, 'input')).toEqual([
      expect.objectContaining({ type: 'date', value: '2026-10-03', 'aria-label': 'Contribution date' }),
      expect.objectContaining({ type: 'number', value: '3000', 'aria-label': 'Amount' }),
    ]);
    expect(els(first, 'select').map((s) => s['aria-label'])).toEqual(['Goal', 'Currency']);
    expect(first).toContain('<option value="turkey" selected="">Trip to Turkey</option>');
    expect(first).toContain('<option value="USD" selected="">USD</option>');
    // Las dos columnas calculadas: en la moneda de la meta y en la principal.
    expect(text(first)).toContain('3,000.00 USD 176,280.00');
    const last = rows[8]!;
    expect(els(last, 'input').map((i) => i.value)).toEqual(['2026-08-03', '400']);
    expect(last).toContain('<option value="emergency" selected="">Emergency fund</option>');
    expect(text(last)).toContain('400.00 USD 23,273.33');
    // La tasa de agosto sale de sus envíos: se dice al pasar el cursor por la cifra convertida.
    expect(els(last, 'td').map((td) => td.title)).toContain("from this month's transfers");
    expect(els(first, 'td').some((td) => 'title' in td)).toBe(false);

    const deletes = els(tbody, 'button').filter((b) => b.title === 'Delete');
    expect(deletes).toHaveLength(8);
    expect(deletes[0]!['aria-label']).toBe('Delete contribution of 2026-10-03 to Trip to Turkey: 3,000.00 USD');
  });

  it('Income: el ingreso del mes seleccionado, fila de agregar arriba y la lista editable, del más reciente al más antiguo', () => {
    expect(t).toContain('Income October 2026 340,808.00 DOP Cancel Date Description Account Amount Cur. DOP Adds to budget');
    const tbody = body(html, 'Income');
    const rows = rowsOf(tbody);
    expect(rows).toHaveLength(4);

    const add = rows[0]!;
    expect(els(add, 'input')).toEqual([
      expect.objectContaining({ type: 'date', value: '2026-10-07', 'aria-label': 'Income date' }),
      expect.objectContaining({ type: 'text', value: '', placeholder: 'Salary, payment…', maxlength: '200', 'aria-label': 'Description' }),
      expect.objectContaining({ type: 'number', step: 'any', value: '', placeholder: '0.00', 'aria-label': 'Amount' }),
      expect.objectContaining({ type: 'checkbox', 'aria-label': 'The new income adds to the budget' }),
    ]);
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Account', 'Currency']);
    // Las cuentas visibles, con la cuenta por defecto elegida y su moneda.
    expect(inner(add, 'select')).toEqual(['US account DR account', 'DOP USD TRY']);
    expect(add).toContain('<option value="dr" selected="">DR account</option>');
    expect(add).toContain('<option value="DOP" selected="">DOP</option>');
    // Una celda por columna: la de la cifra convertida va vacía y el botón ya no ocupa dos.
    expect(els(add, 'td')).toHaveLength(8);
    expect(els(add, 'td').some((td) => 'colspan' in td)).toBe(false);
    expect(inner(add, 'td')[5]).toBe('');
    expect(inner(add, 'button')).toEqual(['Add']);

    const first = rows[1]!;
    expect(
      els(first, 'input')
        .filter((i) => i.type !== 'checkbox')
        .map((i) => `${i['aria-label']}=${i.value}`),
    ).toEqual(['Income date=2026-10-01', 'Description=Salary', 'Amount=5800']);
    expect(els(first, 'input')[1]).not.toHaveProperty('placeholder');
    expect(first).toContain('<option value="us" selected="">US account</option>');
    expect(first).toContain('<option value="USD" selected="">USD</option>');
    expect(text(first)).toContain('340,808.00');
    expect(rows.slice(1).map((r) => els(r, 'input')[0]!.value)).toEqual(['2026-10-01', '2026-09-01', '2026-08-01']);
    expect(text(rows[3]!)).toContain('337,463.33');
    expect(els(rows[3]!, 'td').map((td) => td.title)).toContain("from this month's transfers");

    const deletes = els(tbody, 'button').filter((b) => b.title === 'Delete');
    expect(deletes).toHaveLength(3);
    expect(deletes[0]!['aria-label']).toBe('Delete income of 2026-10-01: 5,800.00 USD');
  });

  it('Income: la columna "Adds to budget", una casilla por ingreso y otra en la fila de agregar, desmarcadas', () => {
    const table = els(html, 'table').find((x) => x['aria-label'] === 'Income')!;
    expect(table.style).toContain('min-width:820px');
    const headers = inner(html.slice(html.indexOf('aria-label="Income"')), 'th');
    expect(headers).toEqual(['Date', 'Description', 'Account', 'Amount', 'Cur.', 'DOP', 'Adds to budget', '']);
    const rows = rowsOf(body(html, 'Income'));
    // Cada fila tiene tantas celdas como encabezados, y la casilla va en la penúltima, bajo "Adds to budget".
    for (const row of rows) {
      expect(els(row, 'td')).toHaveLength(headers.length);
      const cells = row.split('<td').slice(1);
      expect(cells.map((c) => c.includes('type="checkbox"'))).toEqual([false, false, false, false, false, false, true, false]);
    }
    const boxes = els(body(html, 'Income'), 'input').filter((i) => i.type === 'checkbox');
    expect(boxes.map((b) => b['aria-label'])).toEqual([
      'The new income adds to the budget',
      'Adds to budget: income of 2026-10-01, 5,800.00 USD',
      'Adds to budget: income of 2026-09-01, 5,800.00 USD',
      'Adds to budget: income of 2026-08-01, 5,800.00 USD',
    ]);
    // En Savings un ingreso nuevo no sube el presupuesto salvo que se marque; los de ejemplo tampoco.
    expect(boxes.some((b) => 'checked' in b)).toBe(false);
    expect(boxes.some((b) => 'disabled' in b)).toBe(false);
    // Las otras dos tablas no tienen casillas.
    expect(els(body(html, 'Contributions'), 'input').some((i) => i.type === 'checkbox')).toBe(false);
  });

  it('Income: un ingreso que sube el presupuesto sale con su casilla marcada; la de la fila de agregar sigue desmarcada', () => {
    const s = seedState();
    s.incomes.find((i) => i.id === 'seed-in-2')!.budget = true;
    s.incomes.push({ id: 'bono', date: '2026-10-05', desc: 'Bonus', accountId: 'dr', amount: 2500, cur: 'DOP', budget: true });
    const marked = screen({ state: s });
    const boxes = els(body(marked, 'Income'), 'input').filter((i) => i.type === 'checkbox');
    expect(boxes.map((b) => `${b['aria-label']} ${'checked' in b}`)).toEqual([
      'The new income adds to the budget false',
      'Adds to budget: income of 2026-10-05, 2,500.00 DOP true',
      'Adds to budget: income of 2026-10-01, 5,800.00 USD false',
      'Adds to budget: income of 2026-09-01, 5,800.00 USD true',
      'Adds to budget: income of 2026-08-01, 5,800.00 USD false',
    ]);
    // La casilla no cambia el ingreso del mes: entra a la cuenta igual (340,808 + 2,500).
    expect(text(marked)).toContain('Income October 2026 343,308.00 DOP');
  });

  it('con un mes cerrado seleccionado solo cambia el ingreso del mes de la cabecera: nada aquí depende del mes', () => {
    const closed = screen({ monthKey: '2026-08' });
    expect(text(closed)).toContain('Income August 2026 337,463.33 DOP Cancel Date');
    // Todo lo anterior a esa cabecera y las tres tablas son iguales, igual de editables.
    const before = (h: string) => h.slice(0, h.lastIndexOf('<h2'));
    expect(before(closed)).toBe(before(html));
    for (const label of ['Income by month', 'Contributions', 'Income']) expect(body(closed, label)).toBe(body(html, label));
    expect(closed).not.toMatch(/\b(readonly|disabled)\b/i);
  });

  it('una cuenta oculta sigue saliendo con su nombre en el ingreso que entró en ella, pero no se ofrece para uno nuevo', () => {
    const s = seedState();
    s.accounts.find((a) => a.id === 'us')!.hidden = true;
    const rows = rowsOf(body(screen({ state: s }), 'Income'));
    expect(inner(rows[0]!, 'select')[0]).toBe('DR account');
    expect(inner(rows[1]!, 'select')[0]).toBe('DR account US account');
    expect(rows[1]).toContain('<option value="us" selected="">US account</option>');
  });

  it('sin aportes: metas en cero y la tabla solo con la fila de agregar', () => {
    const s = seedState();
    s.contribs = [];
    const empty = screen({ state: s });
    expect(text(empty)).toContain('Emergency fund Variable contributions Edit 0.00 USD ≈ 0 DOP 0 contributions recorded');
    expect(text(empty)).toContain('0% of 45,000 USD Target: October 2027 13 contributions left · 3,462 USD per month to get there');
    expect(text(empty)).toContain('Contributions Total 0.00 DOP');
    expect(text(empty)).toContain('October 2026 340,808.00 0.00 0.0%');
    const tbody = body(empty, 'Contributions');
    expect(rowsOf(tbody)).toHaveLength(1);
    expect(els(tbody, 'button').filter((b) => b.title === 'Delete')).toHaveLength(0);
    expect(tbody).toContain('>Add</button>');
  });

  it('sin ingresos: los meses en cero, sin % de ahorro, y la tabla solo con la fila de agregar', () => {
    const s = seedState();
    s.incomes = [];
    const empty = screen({ state: s });
    expect(text(empty)).toContain('October 2026 0.00 205,660.00 —');
    expect(text(empty)).toContain('Income October 2026 0.00 DOP');
    expect(rowsOf(body(empty, 'Income'))).toHaveLength(1);
    expect(inner(body(empty, 'Income'), 'button')).toEqual(['Add']);
  });

  it('meta cumplida o con el mes objetivo pasado: la tarjeta lo dice en vez de pedir "0 USD por mes"', () => {
    const s = seedState();
    Object.assign(goal(s, 'turkey'), { start: '2026-08', end: '2026-09' });
    expect(text(screen({ state: s }))).toContain('100% of 6,000 USD Target: September 2026 Target reached');
    goal(s, 'turkey').monthly = 10000;
    expect(text(screen({ state: s }))).toContain('45% of 20,000 USD Target: September 2026 Target month passed · 11,000.00 USD to go');
  });

  it('sin metas: solo la tarjeta de "Add goal", y la fila de agregar aportes apagada con el aviso', () => {
    const s = seedState();
    s.goals = [];
    s.contribs = [];
    const empty = screen({ state: s });
    expect(inner(empty, 'h2')).toEqual(['Income by month', 'Contributions', 'Income']);
    expect(empty).toContain(`class="${styles.goals}"`);
    expect(inner(empty, 'button').slice(0, 3)).toEqual(['+ Add goal', 'Cancel', 'Add']);

    // La fila de agregar no tiene campos: dice qué hace falta, y su botón está apagado.
    const tbody = body(empty, 'Contributions');
    expect(text(tbody).trim()).toBe('Add a goal first to record contributions. Add');
    expect(rowsOf(tbody)).toHaveLength(1);
    expect(els(tbody, 'td').map((td) => td.colspan)).toEqual(['4', '3']);
    expect(els(tbody, 'input')).toHaveLength(0);
    expect(els(tbody, 'select')).toHaveLength(0);
    expect(els(tbody, 'button')).toEqual([expect.objectContaining({ disabled: '', class: expect.stringContaining(styles.addOff!) })]);
    // Los ingresos no dependen de las metas: siguen igual de editables.
    expect(body(empty, 'Income')).not.toMatch(/\b(readonly|disabled)\b/i);
    expect(rowsOf(body(empty, 'Income'))).toHaveLength(4);
  });
});

describe('AhorrosScreen con otras monedas', () => {
  it('con USD de moneda principal: las metas en USD no llevan "≈" y las columnas y los totales van en USD', () => {
    const html = screen({ state: usdMain() });
    const t = text(html);
    expect(t).toContain('Emergency fund Variable contributions Edit 1,200.00 USD 3 contributions recorded');
    expect(t).toContain('Trip to Turkey 3,000 USD / month Edit 9,000.00 USD 20% of 45,000 USD');
    expect(t).not.toContain('≈');
    expect(inner(html, 'th')).toEqual(EN_HEADERS.map((h) => (h === 'DOP' ? 'USD' : h)));
    expect(t).toContain("Income by month In USD, at each month's rate");
    expect(t).toContain('October 2026 5,800.00 3,500.00 60.3%');
    expect(t).toContain('Contributions Total 10,650.00 USD');
    expect(t).toContain('Income October 2026 5,800.00 USD');
    expect(text(rowsOf(body(html, 'Contributions'))[1]!)).toContain('3,000.00 USD 3,000.00');
    // La cuenta por defecto sigue siendo la elegida en Settings, y la moneda del ingreso nuevo, la de esa cuenta.
    expect(rowsOf(body(html, 'Income'))[0]).toContain('<option value="DOP" selected="">DOP</option>');
  });

  it('una meta en TRY: la tarjeta en TRY, la moneda del aporte nuevo sigue a la meta y cada aporte sale en TRY', () => {
    const s = seedState();
    s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    s.goals = [{ id: 'tr', name: 'Istanbul', cur: 'TRY', monthly: 10000, start: '2026-10', end: '2027-09', approxCur: null, sort: 0 }];
    s.contribs = [
      { id: 'a', goalId: 'tr', date: '2026-10-05', amount: 100, cur: 'USD' },
      { id: 'b', goalId: 'tr', date: '2026-10-04', amount: 2000, cur: 'TRY' },
    ];
    const html = screen({ state: s });
    // 100 USD × 40 + 2,000 = 6,000 TRY; en DOP, cruzando por USD: 6,000 / 40 × 58.76.
    expect(text(html)).toContain(
      'Istanbul 10,000 TRY / month Edit 6,000.00 TRY ≈ 8,814 DOP 5% of 120,000 TRY Target: September 2027 11 contributions left · 10,364 TRY per month to get there',
    );
    expect(html).toContain('title="crossed through USD"');
    const rows = rowsOf(body(html, 'Contributions'));
    expect(rows[0]).toContain('<option value="TRY" selected="">TRY</option>');
    expect(text(rows[1]!)).toContain('4,000.00 TRY 5,876.00');
    expect(text(rows[2]!)).toContain('2,000.00 TRY 2,938.00');
    expect(text(html)).toContain('Contributions Total 8,814.00 DOP');
    // Todas las tasas salen del mes: nada marcado como de respaldo.
    expect(html).not.toContain(styles.fallbackNote!);
  });

  it('la línea "≈" de cada tarjeta va en la moneda que eligió la meta; si eligió la suya, no hay línea', () => {
    const s = seedState();
    s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    goal(s, 'emergency').approxCur = 'TRY';
    goal(s, 'personal').approxCur = 'USD';
    const html = screen({ state: s });
    const t = text(html);
    // 1,200 USD × 40: en TRY, que no es ni la principal ni la segunda del usuario.
    expect(t).toContain('Emergency fund Variable contributions Edit 1,200.00 USD ≈ 48,000 TRY 3 contributions recorded');
    expect(t).toContain('Personal savings Variable contributions Edit 450.00 USD 2 contributions recorded');
    // La que no eligió sigue en la principal.
    expect(t).toContain('Trip to Turkey 3,000 USD / month Edit 9,000.00 USD ≈ 528,840 DOP 20% of 45,000 USD');
    expect(t.split('≈')).toHaveLength(3);
    // El resto de la hoja sigue en la moneda principal.
    expect(t).toContain('Contributions Total 625,794.00 DOP');
    expect(html).not.toContain(styles.fallbackNote!);

    // Sin tasa de TRY escrita, la cifra de esa tarjeta se marca como hecha con la de respaldo (1 USD = 42 TRY).
    const d = seedState();
    goal(d, 'emergency').approxCur = 'TRY';
    const marked = screen({ state: d });
    expect(text(marked)).toContain('Emergency fund Variable contributions Edit 1,200.00 USD ≈ 50,400 TRY* 3 contributions recorded');
    expect(els(marked, 'div').find((x) => x.class?.includes(styles.fallback!))).toMatchObject({ title: 'default value, not set yet' });

    // Con USD de principal, la meta en USD que eligió DOP conserva su línea; las demás no tienen.
    const u = usdMain();
    goal(u, 'turkey').approxCur = 'DOP';
    const usd = text(screen({ state: u }));
    expect(usd).toContain('Trip to Turkey 3,000 USD / month Edit 9,000.00 USD ≈ 528,840 DOP 20% of 45,000 USD');
    expect(usd.split('≈')).toHaveLength(2);
  });

  it('con dos tasas escritas en el mes, cada fila usa la vigente en su fecha y la línea "≈" la última', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' },
    ];
    s.incomes.push({ id: 'x', date: '2026-10-06', desc: 'Bonus', accountId: 'us', amount: 100, cur: 'USD', budget: false });
    s.contribs.push({ id: 'y', goalId: 'personal', date: '2026-10-07', amount: 6000, cur: 'DOP' });
    const html = screen({ state: s });
    const t = text(html);
    const incomes = rowsOf(body(html, 'Income'));
    // El bono del día 6 a 60; el sueldo del día 1, a 58.76 como antes.
    expect(text(incomes[1]!)).toContain('6,000.00');
    expect(text(incomes[2]!)).toContain('340,808.00');
    expect(t).toContain('Income October 2026 346,808.00 DOP');
    const contribs = rowsOf(body(html, 'Contributions'));
    // 6,000 DOP del día 7 son 100 USD en la meta; los 3,000 USD del día 3 siguen a 58.76.
    expect(text(contribs[1]!)).toContain('100.00 USD 6,000.00');
    expect(text(contribs[2]!)).toContain('3,000.00 USD 176,280.00');
    expect(t).toContain('October 2026 346,808.00 211,660.00 61.0%');
    // Las tarjetas: lo ahorrado (450 + 100 USD) a la última tasa del mes en curso, 60.
    expect(t).toContain('Personal savings Variable contributions Edit 550.00 USD ≈ 33,000 DOP 3 contributions recorded');
    expect(t).toContain('Emergency fund Variable contributions Edit 1,200.00 USD ≈ 72,000 DOP');
    // Las dos son tasas del mes: nada que anotar en las filas de octubre.
    expect(els(incomes[1]!, 'td').some((td) => 'title' in td)).toBe(false);
    expect(els(contribs[1]!, 'td').some((td) => 'title' in td)).toBe(false);
  });

  it('una cifra convertida con la tasa de respaldo va marcada, con su aviso al pie de la tabla', () => {
    const s = seedState();
    goal(s, 'personal').cur = 'TRY';
    s.incomes.push({ id: 'x', date: '2026-09-10', desc: 'Kira', accountId: 'dr', amount: 4200, cur: 'TRY', budget: false });
    const html = screen({ state: s });
    const t = text(html);
    const note = '* Converted with a default rate that has not been set yet.';
    expect(t.split(note)).toHaveLength(4);
    expect(els(html, 'div').filter((d) => d.class === styles.fallbackNote)).toHaveLength(3);
    // La tarjeta: 450 USD × 42 = 18,900 TRY, y de vuelta a DOP con los valores de respaldo.
    expect(t).toContain('Personal savings Variable contributions Edit 18,900.00 TRY ≈ 26,442 DOP* 2 contributions recorded');
    expect(els(html, 'div').find((d) => d.class?.includes(styles.fallback!))).toMatchObject({ title: 'default value, not set yet' });
    // Ingresos por mes: solo el ingreso de septiembre, el mes del ingreso en TRY (lo ahorrado ese mes fue en USD).
    expect(t).toContain('September 2026 345,607.22* 205,010.22 59.3%');
    expect(t).toContain('October 2026 340,808.00 205,660.00 60.3%');
    // Aportes: la columna de la meta de los aportes a la meta en TRY.
    const contribs = rowsOf(body(html, 'Contributions'));
    expect(text(contribs[3]!)).toContain('8,400.00 TRY* 11,714.87');
    expect(els(contribs[3]!, 'td').filter((td) => td.title === 'default value, not set yet')).toHaveLength(1);
    expect(text(contribs[1]!)).not.toContain('*');
    // Ingresos: el de TRY.
    const incomes = rowsOf(body(html, 'Income'));
    expect(text(incomes[2]!)).toContain('5,876.00*');
    expect(text(incomes[1]!)).not.toContain('*');
  });
});

const ES_HEADERS = ['Mes', 'Ingreso', 'Ahorrado', '% ahorro', 'Fecha', 'Meta', 'Monto', 'Mon.', 'En la meta', 'DOP', '', 'Fecha', 'Descripción', 'Cuenta', 'Monto', 'Mon.', 'DOP', 'Suma al presupuesto', ''];

describe('AhorrosScreen en español', () => {
  // Los datos de la app (guardados en inglés) con la interfaz en español: lo que escribe el usuario no se traduce.
  const html = screen({ lang: 'es' });
  const t = text(html);

  it('tarjetas, tablas y controles', () => {
    expect(inner(html, 'h2')).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Ingresos por mes', 'Aportes', 'Ingresos']);
    expect(t).toContain('Emergency fund Aportes variables Editar 1,200.00 USD ≈ 70,512 DOP 3 aportes registrados');
    expect(t).toContain('Personal savings Aportes variables Editar 450.00 USD ≈ 26,442 DOP 2 aportes registrados');
    expect(t).toContain(
      'Trip to Turkey 3,000 USD / mes Editar 9,000.00 USD ≈ 528,840 DOP 20% de 45,000 USD Meta: octubre 2027 Faltan 12 aportes · 3,000 USD por mes para llegar',
    );
    expect(els(html, 'div').find((d) => d.role === 'progressbar')).toMatchObject({ 'aria-label': 'Progreso de Trip to Turkey' });

    expect(t).toContain('Ingresos por mes En DOP, a la tasa de cada mes');
    expect(inner(html, 'th')).toEqual(ES_HEADERS);
    expect(els(html, 'table').map((table) => table['aria-label'])).toEqual(['Ingresos por mes', 'Aportes', 'Ingresos']);
    expect(t).toContain('Agosto 2026 337,463.33 212,369.17 62.9%');
    expect(t).toContain('Septiembre 2026 339,731.22 205,010.22 60.3%');
    expect(t).toContain('Octubre 2026 340,808.00 205,660.00 60.3%');

    expect(t).toContain('Aportes Total 625,794.00 DOP');
    const contribs = body(html, 'Aportes');
    const add = rowsOf(contribs)[0]!;
    expect(els(add, 'input').map((i) => i['aria-label'])).toEqual(['Fecha del aporte', 'Monto']);
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Meta', 'Moneda']);
    expect(add).toContain('>Agregar</button>');
    expect(text(rowsOf(contribs)[1]!)).toContain('3,000.00 USD 176,280.00');
    expect(els(rowsOf(contribs)[8]!, 'td').map((td) => td.title)).toContain('de los envíos de este mes');
    const deletes = els(contribs, 'button').filter((b) => b.title === 'Eliminar');
    expect(deletes).toHaveLength(8);
    expect(deletes[0]!['aria-label']).toBe('Eliminar aporte del 2026-10-03 a Trip to Turkey: 3,000.00 USD');
  });

  it('los ingresos, uno por uno', () => {
    expect(t).toContain('Ingresos Octubre 2026 340,808.00 DOP Cancelar Fecha Descripción Cuenta Monto Mon. DOP Suma al presupuesto');
    const incomes = body(html, 'Ingresos');
    const add = rowsOf(incomes)[0]!;
    expect(els(add, 'input').map((i) => i['aria-label'])).toEqual(['Fecha del ingreso', 'Descripción', 'Monto', 'El ingreso nuevo suma al presupuesto']);
    expect(els(add, 'input')[1]).toMatchObject({ placeholder: 'Sueldo, pago…' });
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Cuenta', 'Moneda']);
    expect(inner(add, 'button')).toEqual(['Agregar']);
    // La descripción y el nombre de la cuenta son del usuario: salen como los escribió.
    expect(els(rowsOf(incomes)[1]!, 'input')[1]).toMatchObject({ value: 'Salary' });
    expect(els(rowsOf(incomes)[1]!, 'input')[3]).toMatchObject({ type: 'checkbox', 'aria-label': 'Suma al presupuesto: ingreso del 2026-10-01, 5,800.00 USD' });
    expect(rowsOf(incomes)[1]).toContain('<option value="us" selected="">US account</option>');
    const deletes = els(incomes, 'button').filter((b) => b.title === 'Eliminar');
    expect(deletes.map((b) => b['aria-label'])).toEqual([
      'Eliminar ingreso del 2026-10-01: 5,800.00 USD',
      'Eliminar ingreso del 2026-09-01: 5,800.00 USD',
      'Eliminar ingreso del 2026-08-01: 5,800.00 USD',
    ]);
  });

  it('editar y agregar metas', () => {
    expect(inner(html, 'button').slice(0, 5)).toEqual(['Editar', 'Editar', 'Editar', '+ Agregar meta', 'Cancelar']);
    expect(els(html, 'button')[0]!['aria-label']).toBe('Editar Emergency fund');
  });

  it('singular y plural', () => {
    const s = seedState();
    s.contribs = s.contribs.filter((c) => c.goalId !== 'personal').concat({ id: 'x', goalId: 'personal', date: '2026-10-05', amount: 50, cur: 'USD' });
    // El plan del viaje acaba este mes y ya se aportó: queda un aporte.
    goal(s, 'turkey').end = '2026-10';
    const one = text(screen({ state: s, lang: 'es' }));
    expect(one).toContain('Personal savings Aportes variables Editar 50.00 USD ≈ 2,938 DOP 1 aporte registrado');
    expect(one).toContain('100% de 9,000 USD Meta: octubre 2026 Meta alcanzada');
    goal(s, 'turkey').monthly = 4000;
    expect(text(screen({ state: s, lang: 'es' }))).toContain('75% de 12,000 USD Meta: octubre 2026 Falta 1 aporte · 3,000 USD por mes para llegar');
  });

  it('sin <I18nProvider> manda el idioma del estado del usuario', () => {
    const s = seedState();
    s.language = 'es';
    expect(screen({ state: s, lang: null })).toBe(html);
  });

  it('sin metas, el aviso de la fila de agregar; con una tasa de respaldo, el aviso al pie', () => {
    const s = seedState();
    s.goals = [];
    s.contribs = [];
    const empty = screen({ state: s, lang: 'es' });
    expect(inner(empty, 'button').slice(0, 3)).toEqual(['+ Agregar meta', 'Cancelar', 'Agregar']);
    expect(text(body(empty, 'Aportes')).trim()).toBe('Agrega primero una meta para registrar aportes. Agregar');

    s.incomes.push({ id: 'x', date: '2026-09-10', desc: '', accountId: 'dr', amount: 4200, cur: 'TRY', budget: false });
    const marked = screen({ state: s, lang: 'es' });
    expect(text(marked)).toContain('* Convertido con una tasa por defecto, aún sin definir.');
    expect(marked).toContain('title="valor por defecto, aún sin definir"');
  });
});

const TR_HEADERS = ['Ay', 'Gelir', 'Biriken', 'Birikim oranı', 'Tarih', 'Hedef', 'Tutar', 'Birim', 'Hedefte', 'DOP', '', 'Tarih', 'Açıklama', 'Hesap', 'Tutar', 'Birim', 'DOP', 'Bütçeye eklenir', ''];

describe('AhorrosScreen en turco', () => {
  // Los datos de la app (en inglés) con la interfaz en turco: los nombres de las metas no se traducen.
  const html = screen({ lang: 'tr' });
  const t = text(html);

  it('tarjetas, tablas y controles', () => {
    expect(inner(html, 'h2')).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Aylara göre gelir', 'Katkılar', 'Gelirler']);
    expect(t).toContain('Emergency fund Değişken katkılar Düzenle 1,200.00 USD ≈ 70,512 DOP 3 katkı kaydedildi');
    expect(t).toContain(
      'Trip to Turkey 3,000 USD / ay Düzenle 9,000.00 USD ≈ 528,840 DOP %20 / 45,000 USD Hedef: Ekim 2027 12 katkı kaldı · hedefe ulaşmak için ayda 3,000 USD',
    );
    expect(els(html, 'div').find((d) => d.role === 'progressbar')).toMatchObject({ 'aria-label': 'Trip to Turkey ilerlemesi' });

    expect(t).toContain('Aylara göre gelir DOP cinsinden, her ayın kuruyla');
    expect(inner(html, 'th')).toEqual(TR_HEADERS);
    expect(els(html, 'table').map((table) => table['aria-label'])).toEqual(['Aylara göre gelir', 'Katkılar', 'Gelirler']);
    // Los números llevan el mismo formato en todos los idiomas.
    expect(t).toContain('Ağustos 2026 337,463.33 212,369.17 62.9%');
    expect(t).toContain('Ekim 2026 340,808.00 205,660.00 60.3%');

    expect(t).toContain('Katkılar Toplam 625,794.00 DOP');
    expect(inner(html, 'button').slice(0, 5)).toEqual(['Düzenle', 'Düzenle', 'Düzenle', '+ Hedef ekle', 'İptal']);
    expect(els(html, 'button')[2]!['aria-label']).toBe('Düzenle: Trip to Turkey');
    const contribs = body(html, 'Katkılar');
    const add = rowsOf(contribs)[0]!;
    expect(els(add, 'input').map((i) => i['aria-label'])).toEqual(['Katkı tarihi', 'Tutar']);
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Hedef', 'Para birimi']);
    const deletes = els(contribs, 'button').filter((b) => b.title === 'Sil');
    expect(deletes).toHaveLength(8);
    expect(deletes[0]!['aria-label']).toBe('2026-10-03 tarihli Trip to Turkey katkısını sil: 3,000.00 USD');
  });

  it('los ingresos, uno por uno', () => {
    expect(t).toContain('Gelirler Ekim 2026 340,808.00 DOP İptal Tarih Açıklama Hesap Tutar Birim DOP Bütçeye eklenir');
    const incomes = body(html, 'Gelirler');
    const add = rowsOf(incomes)[0]!;
    expect(els(add, 'input').map((i) => i['aria-label'])).toEqual(['Gelir tarihi', 'Açıklama', 'Tutar', 'Yeni gelir bütçeye eklenir']);
    expect(els(add, 'input')[1]).toMatchObject({ placeholder: 'Maaş, ödeme…' });
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Hesap', 'Para birimi']);
    expect(inner(add, 'button')).toEqual(['Ekle']);
    expect(els(rowsOf(incomes)[1]!, 'input')[3]).toMatchObject({ type: 'checkbox', 'aria-label': 'Bütçeye eklenir: 2026-10-01 geliri, 5,800.00 USD' });
    const deletes = els(incomes, 'button').filter((b) => b.title === 'Sil');
    expect(deletes).toHaveLength(3);
    expect(deletes[0]!['aria-label']).toBe('2026-10-01 tarihli geliri sil: 5,800.00 USD');
    expect(els(rowsOf(incomes)[3]!, 'td').map((td) => td.title)).toContain('bu ayın transferlerinden');
  });

  it('con un solo aporte el texto es el mismo (en turco el sustantivo no cambia tras un número)', () => {
    const s = seedState();
    s.contribs = s.contribs.filter((c) => c.goalId !== 'personal').concat({ id: 'x', goalId: 'personal', date: '2026-10-05', amount: 50, cur: 'USD' });
    expect(text(screen({ state: s, lang: 'tr' }))).toContain('Personal savings Değişken katkılar Düzenle 50.00 USD ≈ 2,938 DOP 1 katkı kaydedildi');
  });

  it('meta cumplida, mes objetivo pasado, sin metas y con una tasa de respaldo', () => {
    const s = seedState();
    Object.assign(goal(s, 'turkey'), { start: '2026-08', end: '2026-09' });
    expect(text(screen({ state: s, lang: 'tr' }))).toContain('%100 / 6,000 USD Hedef: Eylül 2026 Hedefe ulaşıldı');
    goal(s, 'turkey').monthly = 10000;
    expect(text(screen({ state: s, lang: 'tr' }))).toContain('%45 / 20,000 USD Hedef: Eylül 2026 Hedef ay geçti · 11,000.00 USD kaldı');

    s.goals = [];
    s.contribs = [];
    const empty = screen({ state: s, lang: 'tr' });
    expect(text(body(empty, 'Katkılar')).trim()).toBe('Katkı kaydetmek için önce bir hedef ekleyin. Ekle');

    s.incomes.push({ id: 'x', date: '2026-09-10', desc: '', accountId: 'dr', amount: 4200, cur: 'TRY', budget: false });
    expect(text(screen({ state: s, lang: 'tr' }))).toContain('* Henüz girilmemiş, varsayılan bir kurla çevrildi.');
  });
});

describe('GoalDialog', () => {
  const state = seedState();
  const labels = (html: string) => inner(html, 'label');
  const selected = (html: string) => [...html.matchAll(/<option value="[^"]*" selected="">(.*?)<\/option>/g)].map((m) => m[1]);

  it('meta nueva: nombre vacío, en la moneda principal, sin objetivo y sin botón de eliminar', () => {
    const html = dialog(null);
    expect(els(html, 'div').find((d) => d.role === 'dialog')).toMatchObject({ 'aria-modal': 'true', style: 'max-width:480px' });
    expect(inner(html, 'h2')).toEqual(['New goal']);
    expect(labels(html)).toEqual(['Name', 'Currency', 'Show equivalent in', 'This goal has a target']);
    const inputs = els(html, 'input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ value: '', maxlength: '120', autocomplete: 'off' });
    expect(inputs[1]).toMatchObject({ type: 'checkbox' });
    expect('checked' in inputs[1]!).toBe(false);
    // La moneda y la de la línea "≈": las tres en cada selector, con la principal del usuario elegida en los dos.
    expect(inner(html, 'select')).toEqual(['DOP USD TRY', 'DOP USD TRY']);
    expect(selected(html)).toEqual(['DOP', 'DOP']);
    expect(selected(dialog(null, { state: usdMain() }))).toEqual(['USD', 'USD']);
    // Enter guarda: el contenido es un formulario y "Save" es su botón de envío.
    expect(els(html, 'form')).toHaveLength(1);
    expect(inner(html, 'button')).toEqual(['Cancel', 'Save']);
    expect(els(html, 'button').map((b) => b.type)).toEqual(['button', 'submit']);
    // Recién abierto no enseña errores.
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/aria-invalid/);
  });

  it('meta de aportes variables con aportes: no se puede eliminar y dice por qué', () => {
    const html = dialog(goal(state, 'emergency'));
    expect(inner(html, 'h2')).toEqual(['Edit goal']);
    expect(els(html, 'input')[0]).toMatchObject({ value: 'Emergency fund' });
    expect(labels(html)).toEqual(['Name', 'Currency', 'Show equivalent in', 'This goal has a target']);
    // Se abre en la moneda de la meta, no en la principal; la línea "≈", sin elegir, en la principal.
    expect(selected(html)).toEqual(['USD', 'DOP']);
    expect(inner(html, 'button')).toEqual(['Delete goal', 'Cancel', 'Save']);
    const remove = els(html, 'button')[0]!;
    expect(remove).toMatchObject({ type: 'button', disabled: '' });
    expect(text(html)).toContain('Delete goal Delete its 3 contributions first Cancel Save');
    // El motivo queda asociado al botón.
    expect(els(html, 'span').find((span) => span.id === remove['aria-describedby'])).toBeDefined();
  });

  it('meta con objetivo: la moneda, los cuatro campos del plan, en su orden, y el resumen', () => {
    const html = dialog(goal(state, 'turkey'));
    expect(labels(html)).toEqual(['Name', 'Currency', 'Show equivalent in', 'This goal has a target', 'Target amount (USD)', 'Start month', 'Target month', 'Monthly saving (USD)']);
    const inputs = els(html, 'input');
    expect(inputs.map((i) => i.value ?? '')).toEqual(['Trip to Turkey', '', '45000', '3000']);
    expect('checked' in inputs[1]!).toBe(true);
    expect(inputs[2]).toMatchObject({ type: 'number', step: 'any', inputmode: 'decimal', placeholder: '0.00' });
    expect(inputs[3]).toMatchObject({ type: 'number', step: 'any', inputmode: 'decimal', placeholder: '0.00' });
    // La moneda y la de la línea "≈" (con su etiqueta visible); mes y año de inicio; mes y año objetivo.
    expect(els(html, 'select').map((s) => s['aria-label'])).toEqual([
      undefined,
      undefined,
      'Start month: Month',
      'Start month: Year',
      'Target month: Month',
      'Target month: Year',
    ]);
    expect(selected(html)).toEqual(['USD', 'DOP', 'August', '2026', 'October', '2027']);
    expect(text(html)).toContain('15 months · 3,000 USD / month');
    // Cada etiqueta apunta a su control.
    const ids = [...inputs.map((i) => i.id), ...els(html, 'select').map((s) => s.id)];
    const targets = els(html, 'label').filter((l) => l.for);
    expect(targets).toHaveLength(7);
    for (const label of targets) expect(ids).toContain(label.for);
    expect(text(html)).toContain('Delete its 3 contributions first');
  });

  it('los rótulos de los montos y el resumen llevan el código de la moneda de la meta', () => {
    const s = seedState();
    goal(s, 'turkey').cur = 'TRY';
    const html = dialog(goal(s, 'turkey'), { state: s });
    expect(labels(html)).toEqual(['Name', 'Currency', 'Show equivalent in', 'This goal has a target', 'Target amount (TRY)', 'Start month', 'Target month', 'Monthly saving (TRY)']);
    expect(selected(html)[0]).toBe('TRY');
    expect(text(html)).toContain('15 months · 3,000 TRY / month');
    expect(text(html)).not.toContain('USD / month');
    goal(s, 'turkey').cur = 'DOP';
    const es = dialog(goal(s, 'turkey'), { state: s, lang: 'es' });
    expect(labels(es)).toContain('Monto objetivo (DOP)');
    expect(labels(es)).toContain('Ahorro mensual (DOP)');
    expect(text(es)).toContain('15 meses · 3,000 DOP / mes');
    const tr = dialog(goal(s, 'turkey'), { state: s, lang: 'tr' });
    expect(labels(tr)).toContain('Hedef tutar (DOP)');
    expect(labels(tr)).toContain('Aylık birikim (DOP)');
    expect(text(tr)).toContain('15 ay · 3,000 DOP / ay');
  });

  it('el selector "Show equivalent in": al lado de la moneda, con la que eligió la meta o, si no eligió, la principal', () => {
    const s = seedState();
    const html = dialog(goal(s, 'emergency'), { state: s });
    // Es el segundo selector, con su etiqueta visible apuntándole, y ofrece las tres monedas.
    const selects = els(html, 'select');
    const label = els(html, 'label')[inner(html, 'label').indexOf('Show equivalent in')]!;
    expect(label.for).toBe(selects[1]!.id);
    expect(label.for).not.toBe(selects[0]!.id);
    expect(inner(html, 'select').slice(0, 2)).toEqual(['DOP USD TRY', 'DOP USD TRY']);
    expect(text(html)).toContain('Currency DOP USD TRY Show equivalent in DOP USD TRY This goal has a target');
    // Sin elegir: la principal del usuario, sea cual sea.
    expect(selected(html)).toEqual(['USD', 'DOP']);
    expect(selected(dialog(goal(usdMain(), 'emergency'), { state: usdMain() }))).toEqual(['USD', 'USD']);
    // Elegida: la de la meta, también si es la suya propia o si coincide con la segunda del usuario.
    goal(s, 'emergency').approxCur = 'TRY';
    expect(selected(dialog(goal(s, 'emergency'), { state: s }))).toEqual(['USD', 'TRY']);
    goal(s, 'emergency').approxCur = 'USD';
    expect(selected(dialog(goal(s, 'emergency'), { state: s }))).toEqual(['USD', 'USD']);
    // No depende de la moneda de la meta ni de que tenga objetivo.
    Object.assign(goal(s, 'turkey'), { cur: 'TRY', approxCur: 'USD' });
    expect(selected(dialog(goal(s, 'turkey'), { state: s }))).toEqual(['TRY', 'USD', 'August', '2026', 'October', '2027']);
    // En los otros idiomas cambia el rótulo, no lo elegido.
    const es = dialog(goal(s, 'turkey'), { state: s, lang: 'es' });
    expect(text(es)).toContain('Moneda DOP USD TRY Mostrar equivalente en DOP USD TRY');
    expect(selected(es).slice(0, 2)).toEqual(['TRY', 'USD']);
    expect(labels(dialog(goal(s, 'turkey'), { state: s, lang: 'tr' }))).toContain('Karşılığını göster');
  });

  it('una meta sin aportes sí se puede eliminar', () => {
    const s = seedState();
    s.contribs = s.contribs.filter((c) => c.goalId !== 'turkey');
    const html = dialog(goal(s, 'turkey'), { state: s });
    const remove = els(html, 'button')[0]!;
    expect(inner(html, 'button')).toEqual(['Delete goal', 'Cancel', 'Save']);
    expect('disabled' in remove).toBe(false);
    expect('aria-describedby' in remove).toBe(false);
    expect(text(html)).not.toContain('contribution');
  });

  it('un nombre que ya usa otra meta se avisa en el acto', () => {
    const s = seedState();
    // Datos con dos metas del mismo nombre (p. ej. importados): al editar una, el aviso ya está ahí.
    goal(s, 'personal').name = 'emergency FUND';
    const html = dialog(goal(s, 'personal'), { state: s });
    expect(text(html)).toContain('Name Another goal already has this name. Currency');
    const alerts = els(html, 'div').filter((d) => d.role === 'alert');
    expect(alerts).toHaveLength(1);
    expect(els(html, 'input')[0]).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': alerts[0]!.id });
    expect(dialog(goal(s, 'turkey'), { state: s })).not.toContain('Another goal');
  });

  it('el resumen con un plan de un solo mes va en singular, en cada idioma', () => {
    const s = seedState();
    s.contribs = [{ id: 'x', goalId: 'turkey', date: '2026-10-05', amount: 50, cur: 'USD' }];
    Object.assign(goal(s, 'turkey'), { monthly: 500, start: '2026-10', end: '2026-10' });
    const en = text(dialog(goal(s, 'turkey'), { state: s }));
    expect(en).toContain('1 month · 500 USD / month');
    expect(en).toContain('Delete its 1 contribution first');
    const es = text(dialog(goal(s, 'turkey'), { state: s, lang: 'es' }));
    expect(es).toContain('1 mes · 500 USD / mes');
    expect(es).toContain('Elimina primero su 1 aporte');
    const tr = text(dialog(goal(s, 'turkey'), { state: s, lang: 'tr' }));
    expect(tr).toContain('1 ay · 500 USD / ay');
    expect(tr).toContain('Önce 1 katkısını silin');
  });

  it('en español', () => {
    expect(inner(dialog(null, { lang: 'es' }), 'h2')).toEqual(['Nueva meta']);
    expect(inner(dialog(null, { lang: 'es' }), 'button')).toEqual(['Cancelar', 'Guardar']);
    expect(labels(dialog(null, { lang: 'es' }))).toEqual(['Nombre', 'Moneda', 'Mostrar equivalente en', 'Esta meta tiene un objetivo']);
    const html = dialog(goal(state, 'turkey'), { lang: 'es' });
    expect(inner(html, 'h2')).toEqual(['Editar meta']);
    expect(labels(html)).toEqual([
      'Nombre',
      'Moneda',
      'Mostrar equivalente en',
      'Esta meta tiene un objetivo',
      'Monto objetivo (USD)',
      'Mes de inicio',
      'Mes objetivo',
      'Ahorro mensual (USD)',
    ]);
    expect(els(html, 'select').map((sel) => sel['aria-label'])).toEqual([
      undefined,
      undefined,
      'Mes de inicio: Mes',
      'Mes de inicio: Año',
      'Mes objetivo: Mes',
      'Mes objetivo: Año',
    ]);
    expect(selected(html)).toEqual(['USD', 'DOP', 'Agosto', '2026', 'Octubre', '2027']);
    expect(text(html)).toContain('15 meses · 3,000 USD / mes');
    expect(text(html)).toContain('Eliminar meta Elimina primero sus 3 aportes Cancelar Guardar');
  });

  it('en turco', () => {
    expect(inner(dialog(null, { lang: 'tr' }), 'h2')).toEqual(['Yeni hedef']);
    expect(inner(dialog(null, { lang: 'tr' }), 'button')).toEqual(['İptal', 'Kaydet']);
    const html = dialog(goal(state, 'turkey'), { lang: 'tr' });
    expect(inner(html, 'h2')).toEqual(['Hedefi düzenle']);
    expect(labels(html)).toEqual([
      'Ad',
      'Para birimi',
      'Karşılığını göster',
      'Bu hedefin belirli bir tutarı ve tarihi var',
      'Hedef tutar (USD)',
      'Başlangıç ayı',
      'Hedef ay',
      'Aylık birikim (USD)',
    ]);
    expect(els(html, 'select').map((sel) => sel['aria-label'])).toEqual([
      undefined,
      undefined,
      'Başlangıç ayı: Ay',
      'Başlangıç ayı: Yıl',
      'Hedef ay: Ay',
      'Hedef ay: Yıl',
    ]);
    expect(selected(html)).toEqual(['USD', 'DOP', 'Ağustos', '2026', 'Ekim', '2027']);
    expect(text(html)).toContain('15 ay · 3,000 USD / ay');
    expect(text(html)).toContain('Hedefi sil Önce 3 katkısını silin İptal Kaydet');
  });
});
