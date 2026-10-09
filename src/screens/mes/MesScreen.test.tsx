// La hoja "Mes" pintada a HTML en Node (sin DOM) con los datos de ejemplo: textos, cifras y modo de solo lectura.
// Las interacciones (escribir, agregar, borrar) no se prueban aquí; su lógica está en drafts.test.ts y rows.test.ts.
//
// Casi todo se comprueba en inglés (el idioma por defecto); al final, los mismos datos en español y en turco.
// Los datos de ejemplo están en inglés y son del usuario: no cambian con el idioma.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { seedState, setBudgets } from '../../../shared/seed';
import type { Account, AppState, CreditCard, Income, ISODate, Language, MonthKey } from '../../../shared/types';
import { I18nProvider } from '../../i18n';
import { buildFinanzas, FinanzasContext } from '../../store';
import type { Actions, Finanzas } from '../../store';
import { AddRowsOpenContext } from '../../ui';
import { MesScreen } from './MesScreen';

interface RenderOptions {
  /** Idioma del usuario (state.language). Fijo en inglés para no depender del de los datos de ejemplo. */
  lang?: Language;
  state?: AppState;
  /** Fecha de las filas de agregar. Por defecto la que arma la app: hoy si el mes es el de hoy; si no, su día 1. */
  draftDate?: ISODate;
  /** Idioma forzado con <I18nProvider>, como hace FinanzasProvider en la app. */
  provider?: Language;
  /** Las filas de agregar: abiertas (como tras pulsar su "+ Add …") salvo que se pida false, que es como nace la pantalla. */
  addRows?: boolean;
}

/** La tarjeta única de siempre: los datos de ejemplo no traen ninguna y sin ella no hay fila de tarjeta. */
const CARD: CreditCard = { id: 'card', name: 'Credit card', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
const withCard = (state: AppState = seedState()): AppState => ({ ...state, cards: [CARD] });

function render(monthKey: MonthKey, { lang = 'en', state = withCard(), draftDate, provider, addRows = true }: RenderOptions = {}): string {
  state.language = lang;
  // El mismo valor que arma FinanzasProvider (hoy es el 7 de octubre); la fecha de los borradores se puede fijar aparte.
  const built = buildFinanzas({ user: { id: 'frank', name: 'Frank' }, state, monthKey, today: '2026-10-07', actions: {} as Actions });
  const value: Finanzas = { ...built!, draftDate: draftDate ?? built!.draftDate };
  const screen = (
    <AddRowsOpenContext value={addRows}>
      <FinanzasContext value={value}>
        <MesScreen />
      </FinanzasContext>
    </AddRowsOpenContext>
  );
  return renderToStaticMarkup(provider ? <I18nProvider lang={provider}>{screen}</I18nProvider> : screen);
}

/** Texto visible, sin etiquetas. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** Atributos de cada <tag> del HTML, sin depender del orden en que React los escribe. */
function els(html: string, tag: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) =>
    Object.fromEntries([...m[1]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!, a[2] ?? ''])),
  );
}

/** El mismo HTML sin las opciones de las listas: en el texto quedan solo las cifras y los rótulos. */
const bare = (html: string) => text(html.replace(/<option\b[^>]*>[^<]*<\/option>/g, ''));

/** Una cuenta más para los datos de ejemplo. */
const account = (id: string, name: string, currency: Account['currency'], over: Partial<Account> = {}): Account => ({
  id,
  name,
  currency,
  opening: 0,
  hidden: false,
  sort: 9,
  ...over,
});

/** Un ingreso más para los datos de ejemplo: de octubre, en pesos y en la DR account. */
const income = (over: Partial<Income> & Pick<Income, 'id' | 'amount'>): Income => ({
  date: '2026-10-03',
  desc: 'Refund',
  accountId: 'dr',
  cur: 'DOP',
  budget: false,
  ...over,
});

/** Marcas de fin de sección: el título de la tarjeta siguiente (el texto suelto también sale en notas y etiquetas). */
const INCOME = '>Income</h2>';
const HISTORY = '>Transaction history</h2>';

/** La opción seleccionada de la lista con esa etiqueta. */
function selected(html: string, label: string): string | undefined {
  const m = html.match(new RegExp(`<select\\b[^>]*aria-label="${label}"[^>]*>(.*?)</select>`));
  expect(m, label).not.toBeNull();
  return m![1]!.match(/<option value="([^"]*)" selected="">/)?.[1];
}

/** El HTML de la tarjeta (o caja) que contiene ese texto, hasta la siguiente. */
function section(html: string, from: string, to?: string): string {
  const start = html.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = to ? html.indexOf(to, start) : html.length;
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);

/** Los placeholders con texto, en orden: los de las filas de agregar (el «—» de un día vacío no cuenta). */
const placeholders = (inputs: Record<string, string>[]) => inputs.map((i) => i.placeholder).filter((p) => p && p !== '—');

/** Los valores que ofrece un <datalist>, en orden. */
const offered = (html: string) => els(section(html, '<datalist', '</datalist>'), 'option').map((o) => o.value);

describe('mes abierto · October 2026', () => {
  const html = render('2026-10');
  const t = text(html);

  it('no lleva banner y sí la caja para cerrar el mes', () => {
    expect(t).not.toContain('October 2026 summary');
    expect(t).not.toContain('Reopen month');
    expect(t).toContain(
      'Closing the month saves this summary and creates November 2026 with the same monthly expenses, not marked as paid. Close October 2026',
    );
  });

  it('nada es de solo lectura', () => {
    expect(html).not.toContain('readOnly');
    // Salvo la casilla de la tarjeta de crédito cuando no hay nada que pagar (marcarla no tendría sentido).
    expect(html.replace(/<input[^>]*aria-label="Paid: Credit card"[^>]*>/, '')).not.toContain('disabled');
  });

  it('gastos mensuales: cabecera, columnas y filas en el orden de la hoja', () => {
    const card = section(html, 'Fixed monthly expenses', 'By category');
    const ct = text(card);
    expect(ct).toContain('Fixed monthly expenses 6 of 11 paid · total 42,025.57 DOP');
    expect(ct).toContain('Paid Item Day Amount Currency Pay with Account DOP USD');
    expect(els(card, 'table')).toEqual([expect.objectContaining({ 'aria-label': 'Fixed monthly expenses' })]);

    const inputs = els(card, 'input');
    const boxes = inputs.filter((i) => i.type === 'checkbox');
    // 11 gastos y la tarjeta de crédito.
    expect(boxes).toHaveLength(12);
    expect(boxes.filter((b) => 'checked' in b).map((b) => b['aria-label'])).toEqual([
      'Paid: Electricity',
      'Paid: Internet',
      'Paid: Health insurance',
      'Paid: Fridge payment',
      'Paid: Claude',
      'Paid: Unicaribe',
    ]);
    expect(inputs.filter((i) => i['aria-label'] === 'Item').map((i) => i.value)).toEqual([
      'Electricity',
      'Internet',
      'Health insurance',
      'Fridge payment',
      'Claude',
      'Google One',
      'iCloud+',
      'Cluely',
      'Smartfit',
      'Netflix',
      'Unicaribe',
    ]);
    // El input enseña el número tal cual; las columnas calculadas van con formato.
    expect(inputs).toContainEqual(expect.objectContaining({ type: 'number', value: '1337.15', 'aria-label': 'Amount of Electricity' }));
    expect(inputs).toContainEqual(expect.objectContaining({ type: 'text', value: '5', placeholder: '—', 'aria-label': 'Day of Claude' }));
    expect(ct).toContain('1,337.15 22.76');
    // Claude: 106 USD × 58.76 = 6,228.56 DOP; de vuelta a USD, 106.00.
    expect(ct).toContain('6,228.56 106.00');
    expect(card).toContain('<option value="USD" selected="">USD</option>');
    expect(els(card, 'select')).toContainEqual(expect.objectContaining({ 'aria-label': 'Currency of Claude' }));
    // Las tres monedas, en todas las listas de moneda.
    expect(card).toContain('<option value="DOP" selected="">DOP</option><option value="USD">USD</option><option value="TRY">TRY</option>');
  });

  it('gastos mensuales: cada gasto lleva la cuenta de la que se paga', () => {
    const card = section(html, 'Fixed monthly expenses', 'By category');
    // Lo que se cobra en USD sale de la US account; el resto, de la DR account.
    expect(selected(card, 'Account of Claude')).toBe('us');
    expect(selected(card, 'Account of Electricity')).toBe('dr');
    expect(card).toContain('<option value="us" selected="">US account</option><option value="dr">DR account</option>');
    // 11 filas + la de agregar.
    expect(els(card, 'select').filter((x) => x['aria-label']?.startsWith('Account of'))).toHaveLength(12);
  });

  it('los gastos sin pagar van con el fondo de pendiente', () => {
    const card = section(html, 'Fixed monthly expenses', 'By category');
    expect(els(card, 'tr').filter((tr) => /unpaid/.test(tr.class ?? ''))).toHaveLength(5);
  });

  it('gastos mensuales: fila para agregar al final', () => {
    const card = section(html, 'Fixed monthly expenses', 'By category');
    const inputs = els(card, 'input');
    // The card row is above the expenses, so the add row is the last one.
    const last = inputs.slice(-3);
    expect(last[0]).toMatchObject({ type: 'text', value: '', placeholder: 'New monthly expense', style: 'min-width:60px', maxLength: '120' });
    expect(last[1]).toMatchObject({ type: 'text', value: '', placeholder: 'Day', 'aria-label': 'Day of the new expense', maxLength: '20' });
    expect(last[2]).toMatchObject({ type: 'number', value: '', placeholder: '0.00', 'aria-label': 'Amount of the new expense' });
    expect(els(card, 'select').at(-3)).toMatchObject({ 'aria-label': 'Currency of the new expense' });
    expect(els(card, 'select').at(-2)).toMatchObject({ 'aria-label': 'How the new expense is paid' });
    expect(els(card, 'select').at(-1)).toMatchObject({ 'aria-label': 'Account of the new expense' });
    // Arranca en la cuenta por defecto (DR account) y en su moneda.
    expect(selected(card, 'Account of the new expense')).toBe('dr');
    expect(selected(card, 'Currency of the new expense')).toBe('DOP');
    expect(els(card, 'td')).toContainEqual(expect.objectContaining({ colSpan: '3' }));
    // El botón de la cabecera (con la fila abierta, su "Cancel"), 11 × de las filas y, al final, "Add".
    // 'Credit card' is the name of the card's derived row (first in the body), a button that opens its details.
    expect(buttons(card)).toEqual(['Cancel', 'Credit card', ...Array<string>(11).fill('×'), 'Add']);
    expect(card.indexOf('Paid: Credit card')).toBeLessThan(card.indexOf('Paid: Electricity'));
    expect(els(card, 'button')).toContainEqual(expect.objectContaining({ title: 'Delete', 'aria-label': 'Delete Netflix' }));
  });

  it('por categoría: gastos fijos primero y el resto de mayor a menor', () => {
    const card = section(html, 'By category', 'Month rates');
    expect(text(card)).toContain('By category DOP Fixed expenses 38,305 Groceries 4,850 Transport 2,320 Food 1,535 Health 1,240 Entertainment 900');
    expect(text(card)).not.toContain('No expenses yet');
    const bars = els(card, 'span').filter((s) => s.style?.startsWith('width:'));
    expect(bars).toHaveLength(6);
    expect(bars[0]!.style).toBe('width:100%');
    expect(bars[0]!.class).toMatch(/barFixed/);
    expect(bars.slice(1).every((b) => !/barFixed/.test(b.class!))).toBe(true);
    // Groceries: 4,850 de 38,304.71.
    expect(Number.parseFloat(bars[1]!.style!.slice('width:'.length))).toBeCloseTo((4850 / 38304.71) * 100, 6);
  });

  it('tasas del mes: el par en uso, con sus tasas escritas editables (una por fecha), y la fila para escribir otra', () => {
    const card = section(html, 'Month rates', '>Credit cards</h2>');
    // Bajo el título, la nota que explica desde cuándo vale una tasa; la primera columna es su fecha.
    expect(bare(card)).toContain(
      'Month rates Cancel A new rate applies from its date on. Earlier transactions keep the rate they had. Since From Rate To 01/10 1 USD = DOP × 06/10 1 USD = DOP × Add',
    );
    expect(els(card, 'p')).toHaveLength(1);
    expect(els(card, 'table')).toEqual([expect.objectContaining({ 'aria-label': 'Month rates' })]);
    const inputs = els(card, 'input');
    expect(inputs).toHaveLength(4);
    // Octubre tiene la tasa escrita dos veces (el 1 y el 6): cada una se corrige en su celda y dice desde cuándo vale.
    // No llevan nota de origen porque son las del mes.
    expect(inputs[0]).toMatchObject({ type: 'number', value: '58.76', 'aria-label': 'Rate USD → DOP since 01/10' });
    expect(inputs[1]).toMatchObject({ type: 'number', value: '58.76', 'aria-label': 'Rate USD → DOP since 06/10' });
    expect(card).not.toContain('typed for this month');
    expect(card).not.toMatch(/warn/);
    expect(els(card, 'button').map((b) => b['aria-label'])).toEqual([undefined, 'Expand', 'Delete rate USD → DOP of 01/10', 'Delete rate USD → DOP of 06/10', undefined]);
    // Fila de agregar: fecha, par (todas las monedas) y tasa vacía.
    expect(inputs[2]).toMatchObject({ type: 'date', value: '2026-10-07', 'aria-label': 'Date the new rate applies from' });
    expect(inputs[3]).toMatchObject({ type: 'number', value: '', placeholder: '0.00', 'aria-label': 'New rate' });
    expect(selected(card, 'Currency the new rate converts from')).toBe('USD');
    expect(selected(card, 'Currency the new rate converts to')).toBe('DOP');
    expect([...card.matchAll(/<option /g)]).toHaveLength(6);
    expect(buttons(card)).toEqual(['Cancel', '×', '×', 'Add']);
  });

  it('envíos e ingresos: una al lado de la otra en la misma rejilla, después de las dos columnas y antes del historial', () => {
    // Las dos tarjetas son hijas directas de la rejilla `pair`, en ese orden, y nada más vive ahí.
    const pair = section(html, '<div class="_pair_', HISTORY);
    expect(pair).toMatch(/^<div class="_pair_\w+"><div class="_card_\w+[^"]*">/);
    expect(pair).toContain('>Transfers</h2>');
    expect(pair).toContain(INCOME);
    expect(pair).not.toContain('>Month rates</h2>');
    const order = ['>Fixed monthly expenses</h2>', '>By category</h2>', '>Month rates</h2>', '<div class="_pair_', '>Transfers</h2>', INCOME, HISTORY].map((x) => html.indexOf(x));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('envíos: cada fila se edita en su sitio, con sus cuentas, su tasa, lo recibido y su casilla', () => {
    const card = section(html, 'Transfers', INCOME);
    // Origen y destino comparten columna (con la flecha entre las dos listas) y lo recibido va bajo el monto.
    // La comisión va bajo la tasa, con su rótulo.
    expect(bare(card)).toContain('Date Via From → To Amount Rate Budget → USD = 88,140.00 DOP Fee × → Fee Add');
    expect(bare(card)).not.toContain('Received');
    expect(els(card, 'table')).toEqual([expect.objectContaining({ style: 'min-width:520px', 'aria-label': 'Transfers' })]);
    expect(els(card, 'th').find((th) => th.title === 'Moves budget')).toMatchObject({ 'aria-label': 'Moves budget' });
    const inputs = els(card, 'input');
    expect(inputs).toHaveLength(12);
    // Los datos de ejemplo no marcan ningún envío ni llevan comisión (vacía, con su placeholder).
    expect(inputs[4]).toMatchObject({ type: 'number', value: '', placeholder: '0.00', 'aria-label': 'Fee of Remitly 02/10' });
    expect(inputs[5]).toMatchObject({ type: 'checkbox', 'aria-label': 'Moves budget: Remitly 02/10' });
    expect(inputs[5]).not.toHaveProperty('checked');
    expect(inputs[0]).toMatchObject({ type: 'date', value: '2026-10-02', 'aria-label': 'Date of Remitly 02/10' });
    expect(inputs[1]).toMatchObject({ type: 'text', value: 'Remitly', maxLength: '60', 'aria-label': 'Via of Remitly 02/10' });
    expect(inputs[2]).toMatchObject({ type: 'number', value: '1500', 'aria-label': 'Amount of Remitly 02/10' });
    expect(inputs[3]).toMatchObject({ type: 'number', value: '58.76', 'aria-label': 'Rate of Remitly 02/10' });
    expect(selected(card, 'Account Remitly 02/10 leaves from')).toBe('us');
    expect(selected(card, 'Account Remitly 02/10 goes to')).toBe('dr');
    expect(buttons(card)).toEqual(['Cancel', '×', 'Add']);
    expect(els(card, 'button').find((b) => b['aria-label']?.startsWith('Delete'))).toMatchObject({ 'aria-label': 'Delete transfer from 02/10' });
  });

  it('envíos: fila para agregar con las dos cuentas y la tasa del mes para sus monedas', () => {
    const card = section(html, 'Transfers', INCOME);
    const inputs = els(card, 'input').slice(6);
    expect(inputs[0]).toMatchObject({ type: 'date', value: '2026-10-07', style: 'min-width:112px', 'aria-label': 'Date of the new transfer' });
    expect(inputs[2]).toMatchObject({
      type: 'number',
      value: '',
      placeholder: '500',
      style: 'min-width:64px',
      'aria-label': 'Amount of the new transfer',
    });
    expect(inputs[3]).toMatchObject({ type: 'number', value: '58.76', style: 'min-width:68px', 'aria-label': 'Rate of the new transfer' });
    expect(inputs[3]).not.toHaveProperty('readOnly');
    // La celda de la tasa es de esta pantalla (RateCell) y toma los estilos de las celdas de src/ui: se ve como la del monto.
    expect(inputs[3]!.class).toBeTruthy();
    expect(inputs[3]!.class).toBe(inputs[2]!.class);
    expect(inputs[3]).toMatchObject({ step: 'any', inputMode: 'decimal', autoComplete: 'off' });
    // Sin tocar: de la otra cuenta a la de por defecto.
    expect(selected(card, 'Account the new transfer leaves from')).toBe('us');
    expect(selected(card, 'Account the new transfer goes to')).toBe('dr');
    // La comisión arranca en la del último envío por Remitly: ninguno la tiene, así que vacía.
    expect(inputs[4]).toMatchObject({ type: 'number', value: '', placeholder: '0.00', 'aria-label': 'Fee of the new transfer' });
    // La casilla "Moves budget" del envío nuevo arranca marcada.
    expect(inputs[5]).toMatchObject({ type: 'checkbox', checked: '', 'aria-label': 'The new transfer moves budget' });
  });

  it('envíos: la vía es un campo de texto libre con sugerencias, que arranca en Remitly', () => {
    const card = section(html, 'Transfers', INCOME);
    const via = els(card, 'input')[7]!;
    expect(via).toMatchObject({
      type: 'text',
      value: 'Remitly',
      placeholder: 'Remitly',
      maxLength: '60',
      style: 'min-width:80px',
      'aria-label': 'Via of the new transfer',
    });
    // Cada campo de vía apunta a su <datalist>: las vías de siempre (agosto ya usó las dos).
    expect(via.list).toBeTruthy();
    expect(els(card, 'datalist').map((d) => d.id)).toContain(via.list);
    expect(offered(card)).toEqual(['Remitly', 'PayPal']);
  });

  it('historial: cabecera, fila para agregar arriba y transacciones de la más reciente a la más antigua', () => {
    // Hasta "Outside budget": su tarjeta (que con las filas de agregar abiertas se ve) tiene su propia prueba.
    const card = section(html, 'Transaction history', 'Outside budget');
    const ct = text(card);
    expect(ct).toContain('Transaction history 7 transactions · total 10,845.00 DOP');
    expect(ct).toContain('Date Name Place Category Method Amount Cur. Account DOP USD Description');
    expect(els(card, 'table')).toContainEqual(expect.objectContaining({ style: 'min-width:1100px', 'aria-label': 'Transaction history' }));

    const inputs = els(card, 'input');
    expect(inputs.filter((i) => i.type === 'date').map((i) => i.value)).toEqual([
      '2026-10-07', // borrador
      '2026-10-07',
      '2026-10-06',
      '2026-10-05',
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
      '2026-10-01',
    ]);
    expect(inputs.filter((i) => i.placeholder).map((i) => i.placeholder)).toEqual(['New transaction', 'Place', '0.00', 'Description (optional)']);
    expect(inputs.filter((i) => i['aria-label'] === 'Name').map((i) => i.value)).toEqual([
      'Coffee',
      'Gas',
      'Pharmacy',
      'Movies',
      'Lunch',
      'Uber to work',
      'Weekly groceries',
    ]);
    // Coffee: 385 DOP = 6.55 USD.
    expect(ct).toContain('385.00 6.55');
    // Cada fila lleva "⋯" (abre su descripción en un diálogo) y su ×.
    expect(buttons(card)).toEqual(['Cancel', 'Add', ...Array<string[]>(7).fill(['⋯', '↘', '×']).flat()]);
    // El diálogo solo se monta al abrirlo.
    expect(card).not.toContain('<textarea');
    expect(card).not.toContain('role="dialog"');
    // El borrador arranca en Food / Debit card, en la cuenta por defecto y en su moneda, con todas las categorías, métodos, monedas y cuentas.
    const draftRow = section(card, '<tbody>', '</tr>');
    expect(draftRow).toContain('<option value="Food" selected="">Food</option><option value="Groceries">Groceries</option>');
    expect(draftRow).toContain(
      '<option value="Debit card" selected="">Debit card</option><option value="Credit card">Credit card</option><option value="Transfer">Transfer</option><option value="Bank app">Bank app</option><option value="Cash">Cash</option></select>',
    );
    // 11 categorías, 5 métodos, 3 monedas y 2 cuentas.
    expect([...draftRow.matchAll(/<option /g)]).toHaveLength(11 + 5 + 3 + 2);
    expect(draftRow).toContain('<option value="Travel">Travel</option><option value="Other">Other</option></select>');
    expect(selected(draftRow, 'Account of the new transaction')).toBe('dr');
    expect(selected(draftRow, 'Currency of the new transaction')).toBe('DOP');
    expect(selected(card, 'Account of Coffee')).toBe('dr');
    expect(els(draftRow, 'td').filter((td) => td.colSpan === '2')).toHaveLength(2);
  });

  it('historial: cada celda dice de qué transacción es', () => {
    const card = section(html, 'Transaction history', 'Closing the month');
    const labels = [...els(card, 'input'), ...els(card, 'select'), ...els(card, 'button')].map((e) => e['aria-label']);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Date of the new transaction',
        'New transaction',
        'Place of the new transaction',
        'Category of the new transaction',
        'Method of the new transaction',
        'Amount of the new transaction',
        'Currency of the new transaction',
        'Account of the new transaction',
        'Description of the new transaction',
        'Date of Coffee',
        'Place of Coffee',
        'Category of Coffee',
        'Method of Coffee',
        'Amount of Coffee',
        'Currency of Coffee',
        'Account of Coffee',
        'Description of Coffee',
        'Open the description of Coffee',
        'Delete Coffee',
      ]),
    );
    // El "⋯" de cada fila dice de qué transacción abre la descripción, también al pasar el cursor.
    const dots = els(card, 'button').filter((b) => b['aria-label']?.startsWith('Open the description of '));
    expect(dots.map((b) => b['aria-label'])).toEqual(
      ['Coffee', 'Gas', 'Pharmacy', 'Movies', 'Lunch', 'Uber to work', 'Weekly groceries'].map((name) => `Open the description of ${name}`),
    );
    expect(dots.every((b) => b.title === b['aria-label'] && b.type === 'button')).toBe(true);
  });
});

describe('borradores de las filas de agregar', () => {
  const reopened = () => {
    const state = seedState();
    state.months['2026-09']!.closed = false;
    return state;
  };

  it('las fechas siguen la del shell: el día 1 cuando el mes seleccionado no es el de hoy', () => {
    const html = render('2026-09', { state: reopened(), draftDate: '2026-09-01' });
    const draftDate = (card: string, label: string) => els(card, 'input').find((i) => i['aria-label'] === label)!.value;
    expect(draftDate(section(html, 'Transfers', INCOME), 'Date of the new transfer')).toBe('2026-09-01');
    expect(draftDate(section(html, 'Transaction history'), 'Date of the new transaction')).toBe('2026-09-01');
    // También las de un ingreso y una tasa nuevos.
    expect(els(section(html, INCOME, HISTORY), 'input')[0]).toMatchObject({ type: 'date', value: '2026-09-01', 'aria-label': 'Income date' });
    expect(draftDate(section(html, 'Month rates', '>Credit cards</h2>'), 'Date the new rate applies from')).toBe('2026-09-01');
    // Es la fecha que arma la app sin que nadie la fije: hoy (7 de octubre) no cae en septiembre.
    const own = render('2026-09', { state: reopened() });
    expect(draftDate(section(own, 'Transfers', INCOME), 'Date of the new transfer')).toBe('2026-09-01');
    expect(draftDate(section(render('2026-10'), 'Transfers', INCOME), 'Date of the new transfer')).toBe('2026-10-07');
  });

  it('la tasa del borrador de envío es la del mes, a dos decimales', () => {
    // Septiembre no tiene tasa escrita: el promedio ponderado de sus envíos.
    const card = section(render('2026-09', { state: reopened(), draftDate: '2026-09-01' }), 'Transfers', INCOME);
    expect(els(card, 'input').at(-3)).toMatchObject({ type: 'number', value: '58.57', 'aria-label': 'Rate of the new transfer' });
  });

  it('una tasa redonda conserva sus dos decimales en el campo (58.70, no 58.7)', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 58.7, date: '2026-10-01' }];
    const html = render('2026-10', { state });
    expect(els(section(html, 'Month rates', '>Credit cards</h2>'), 'input')[0]).toMatchObject({ type: 'number', value: '58.70' });
    expect(els(section(html, 'Transfers', INCOME), 'input').at(-3)).toMatchObject({ type: 'number', value: '58.70' });
  });

  it('con otra cuenta por defecto, los borradores la siguen: cuenta, moneda y sentido del envío', () => {
    const state = seedState();
    state.defaultAccountId = 'us';
    const html = render('2026-10', { state });
    expect(selected(html, 'Account of the new expense')).toBe('us');
    expect(selected(html, 'Currency of the new expense')).toBe('USD');
    expect(selected(html, 'Account of the new transaction')).toBe('us');
    expect(selected(html, 'Currency of the new transaction')).toBe('USD');
    // El envío llega a la cuenta por defecto: DR → US, con la inversa de la tasa escrita.
    expect(selected(html, 'Account the new transfer leaves from')).toBe('dr');
    expect(selected(html, 'Account the new transfer goes to')).toBe('us');
    expect(els(html, 'input').find((i) => i['aria-label'] === 'Rate of the new transfer')).toMatchObject({ value: '0.01702' });
  });

  it('entre dos cuentas de la misma moneda la tasa del borrador es 1 y no se escribe', () => {
    const state = seedState();
    state.accounts = [account('a', 'Cash', 'DOP', { sort: 0 }), account('dr', 'DR account', 'DOP', { sort: 1 })];
    const rate = els(render('2026-10', { state }), 'input').find((i) => i['aria-label'] === 'Rate of the new transfer')!;
    expect(rate).toMatchObject({ value: '1.00' });
    expect(rate).toHaveProperty('readOnly');
  });

  it('la tasa del borrador de envío es la vigente en su fecha, no la última del mes', () => {
    const state = () => {
      const s = seedState();
      s.months['2026-10']!.rates = [
        { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
        { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
      ];
      return s;
    };
    const draftRate = (draftDate?: ISODate) =>
      els(render('2026-10', { state: state(), draftDate }), 'input').find((i) => i['aria-label'] === 'Rate of the new transfer')!.value;
    // Hoy (día 7) ya vale la del 5; un envío con fecha del 3 se propone con la del 1.
    expect(draftRate()).toBe('60.00');
    expect(draftRate('2026-10-05')).toBe('60.00');
    expect(draftRate('2026-10-03')).toBe('58.00');
  });

  it('las sugerencias de vía suman las ya usadas hasta ese mes, sin las de meses posteriores', () => {
    const state = reopened();
    state.months['2026-08']!.transfers[1]!.via = 'Western Union';
    state.months['2026-09']!.transfers[1]!.via = 'Wise';
    state.months['2026-10']!.transfers[0]!.via = 'Zelle';
    const september = section(render('2026-09', { state, draftDate: '2026-09-01' }), 'Transfers', INCOME);
    expect(offered(september)).toEqual(['Remitly', 'PayPal', 'Wise', 'Western Union']);
    // Las filas existentes enseñan su vía en su campo, sea cual sea.
    expect(els(september, 'input')).toContainEqual(expect.objectContaining({ type: 'text', value: 'Wise', 'aria-label': 'Via of Wise 17/09' }));
    expect(bare(september)).toContain('USD = 46,896.00 DOP');
    const october = section(render('2026-10', { state }), 'Transfers', INCOME);
    expect(offered(october)).toEqual(['Remitly', 'PayPal', 'Zelle', 'Wise', 'Western Union']);
  });
});

describe('mes cerrado · September 2026', () => {
  const html = render('2026-09');
  const t = text(html);

  it('banner con el resumen del mes', () => {
    // Tasa 58.5743 (1,500 a 58.55 y 800 a 58.62): ingreso 5,800 USD; fijos 42,081.54 + transacciones 24,555; ahorrado 3,500 USD.
    expect(t).toContain(
      'September 2026 summary Month closed. Records are read-only. Amounts in DOP Income 339,731 Spent 66,636.54 Saved 205,010 Vs. budget 3,363.46 Reopen month',
    );
    expect(html).toMatch(/valueOk/);
    expect(html).not.toMatch(/valueOver/);
  });

  it('sin filas de agregar, sin × y sin caja de cerrar; borrar el mes sigue estando', () => {
    // Las descripciones se siguen pudiendo abrir para leerlas: un "⋯" por transacción (10 en septiembre).
    // Y la tarjeta de crédito, que se puede crear y editar aunque el mes esté cerrado (no pertenece a un mes).
    expect(buttons(html)).toEqual(['Reopen month', 'Credit card', '+ Add card', 'Edit', ...Array<string>(10).fill('⋯'), 'Delete month']);
    expect(buttons(html)).not.toContain('×');
    expect(els(html, 'button').filter((b) => b['aria-label']?.startsWith('Open the description of '))).toHaveLength(10);
    expect(t).not.toContain('Closing the month');
    expect(els(html, 'input').filter((i) => i.placeholder && i.placeholder !== '—')).toEqual([]);
    expect(els(html, 'td').filter((td) => 'colSpan' in td)).toEqual([]);
    expect(els(html, 'datalist')).toEqual([]);
  });

  it('todo queda de solo lectura: inputs readOnly, listas y casillas deshabilitadas', () => {
    const inputs = els(html, 'input');
    const boxes = inputs.filter((i) => i.type === 'checkbox');
    const fields = inputs.filter((i) => i.type !== 'checkbox');
    // Los 11 "Paid" (todos marcados), la de la tarjeta de crédito (sin nada que pagar), las casillas "Moves budget" de los 2 envíos y la "Adds to budget" del sueldo (sin marcar).
    expect(boxes).toHaveLength(11 + 1 + 2 + 1);
    expect(boxes.every((b) => 'disabled' in b)).toBe(true);
    expect(boxes.filter((b) => 'checked' in b)).toHaveLength(11);
    // 11 fijos × (concepto, día, monto) + los otros cargos de la tarjeta + 2 envíos × (fecha, vía, monto, tasa, comisión) + 1 ingreso × (fecha, descripción, monto)
    // + 10 transacciones × (fecha, descripción, lugar, monto, notas). Las tasas del mes van como texto.
    expect(fields).toHaveLength(11 * 3 + 1 + 2 * 5 + 1 * 3 + 10 * 5);
    expect(fields.every((f) => 'readOnly' in f)).toBe(true);
    const selects = els(html, 'select');
    // 11 fijos × (moneda, pagar con, cuenta) + 2 envíos × (origen, destino) + 1 ingreso × (cuenta, moneda) + 10 × (categoría, método, moneda, cuenta).
    expect(selects).toHaveLength(11 * 3 + 2 * 2 + 1 * 2 + 10 * 4);
    expect(selects.every((s) => 'disabled' in s)).toBe(true);
  });

  it('conserva las cifras del mes', () => {
    expect(t).toContain('Fixed monthly expenses 11 of 11 paid · total 42,081.54 DOP');
    expect(bare(html)).toContain('Date Via From → To Amount Rate Budget → USD = 87,825.00 DOP Fee → USD = 46,896.00 DOP Fee Income Total 339,731.22 DOP');
    const transfers = els(section(html, 'Transfers', INCOME), 'input').filter((i) => i.type !== 'checkbox');
    expect(transfers.map((i) => i.value)).toEqual(['2026-09-02', 'Remitly', '1500', '58.55', '', '2026-09-17', 'Remitly', '800', '58.62', '']);
    expect(t).toContain('Transaction history 10 transactions · total 24,555.00 DOP');
  });

  it('tasas del mes: sin tasa escrita, dice de dónde sale y no se puede tocar', () => {
    const card = section(html, 'Month rates', '>Credit cards</h2>');
    // 1,500 a 58.55 y 800 a 58.62.
    // La fila no es una tasa escrita: en la columna de la fecha va una raya, y la cifra es texto.
    expect(text(card).replace(/&#x27;/g, "'")).toContain(
      "Month rates A new rate applies from its date on. Earlier transactions keep the rate they had. Since From Rate To — 1 USD = 58.57 DOP from this month's transfers",
    );
    expect(els(card, 'input')).toEqual([]);
    expect(els(card, 'select')).toEqual([]);
    expect(buttons(card)).toEqual([]);
    expect(card).not.toMatch(/warn/);
  });

  it('pasado de presupuesto, "Vs. budget" cambia de color', () => {
    const state = seedState();
    setBudgets(state.months['2026-09']!, { dr: 60000 });
    const over = render('2026-09', { state });
    expect(text(over)).toContain('Vs. budget -6,636.54');
    expect(over).toMatch(/valueOver/);
    expect(over).not.toMatch(/valueOk/);
  });
});

describe('casos límite', () => {
  it('mes sin datos: contadores en cero y el aviso de categorías', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { fixed: [], transfers: [], tx: [] });
    const t = text(render('2026-10', { state }));
    expect(t).toContain('Fixed monthly expenses 0 of 0 paid · total 0.00 DOP');
    expect(t).toContain('By category DOP No expenses yet this month.');
    expect(t).toContain('Transaction history 0 transactions · total 0.00 DOP');
    expect(t).toContain('Close October 2026 Delete month');
  });

  it('mes sin tasa escrita ni envíos: la tasa es la del mes anterior, y se dice', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { rates: [], transfers: [] });
    const html = render('2026-10', { state });
    const card = section(html, 'Month rates', '>Credit cards</h2>');
    expect(bare(card)).toContain('Since From Rate To — 1 USD = DOP from September 2026 Add');
    expect(card).not.toMatch(/warn/);
    // No está escrita: no hay nada que quitar. La cifra va en una celda (escribir en ella crea la tasa del mes), con
    // dos decimales aunque la calculada traiga más, y debajo sigue la fila para escribir la de cualquier par.
    expect(els(card, 'input').map((i) => [i.type, i.value, i['aria-label']])).toEqual([
      ['number', '58.57', 'Rate USD → DOP'],
      ['date', '2026-10-01', 'Date the new rate applies from'],
      ['number', '', 'New rate'],
    ]);
    expect(els(card, 'input')[0]).not.toHaveProperty('readOnly');
    expect(buttons(card)).toEqual(['Cancel', 'Add']);
    // El borrador de envío la propone.
    expect(els(html, 'input').find((i) => i['aria-label'] === 'Rate of the new transfer')).toMatchObject({ value: '58.57' });
  });

  it('una tasa que nadie ha escrito nunca sale del valor de respaldo, y se avisa', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY'));
    const card = section(render('2026-10', { state }), 'Month rates', '>Credit cards</h2>');
    const ct = bare(card);
    expect(ct).toContain('01/10 1 USD = DOP × 06/10 1 USD = DOP ×');
    // Sin fecha (raya) y sin ×: no son tasas escritas. La cifra va en su celda.
    // Con la principal DOP solo se pide TRY → DOP: USD → TRY ya no es una fila, se cruza por DOP.
    expect(ct).toContain('— 1 TRY = DOP default value, not set yet Add');
    expect(ct).not.toContain('1 USD = TRY');
    // 58.76 DOP y 42 TRY por dólar, los valores fijos.
    expect(els(card, 'input').slice(2, 3).map((i) => [i.value, i['aria-label']])).toEqual([['1.40', 'Rate TRY → DOP']]);
    expect(els(card, 'span').filter((x) => /warn/.test(x.class ?? ''))).toHaveLength(1);
    // La fila de agregar propone la primera que falta.
    expect(selected(card, 'Currency the new rate converts from')).toBe('TRY');
    expect(selected(card, 'Currency the new rate converts to')).toBe('DOP');
  });

  it('sin segunda moneda y todo en una moneda: la tarjeta no lleva tabla, solo la nota', () => {
    const state = { ...seedState(), secondCurrency: null };
    state.accounts = state.accounts.filter((a) => a.currency === 'DOP');
    for (const m of Object.values(state.months)) {
      m.rates = [];
      m.fixed = m.fixed.map((f) => ({ ...f, cur: 'DOP' }));
      m.tx = m.tx.map((tx) => ({ ...tx, cur: 'DOP' }));
    }
    const card = section(render('2026-10', { state, addRows: false }), 'Month rates', '>Credit cards</h2>');
    expect(text(card)).toContain('All your money is in DOP: no rates needed.');
    expect(els(card, 'table')).toEqual([]);
    expect(els(card, 'input')).toEqual([]);
    // Agregar una tasa suelta sigue disponible.
    expect(buttons(card)).toEqual(['+ Add rate']);
  });

  it('una tasa cruzada por la tercera moneda lo dice', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY'));
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-03' });
    const card = section(render('2026-10', { state }), 'Month rates', '>Credit cards</h2>');
    expect(bare(card)).toContain('— 1 TRY = DOP crossed through USD 03/10 1 USD = TRY ×');
    // 58.76 / 40 = 1.469.
    expect(els(card, 'input').map((i) => [i.value, i['aria-label']])).toEqual([
      ['58.76', 'Rate USD → DOP since 01/10'],
      ['58.76', 'Rate USD → DOP since 06/10'],
      ['1.47', 'Rate TRY → DOP'],
      ['40.00', 'Rate USD → TRY since 03/10'],
      ['2026-10-01', 'Date the new rate applies from'],
      ['', 'New rate'],
    ]);
    expect(card).not.toMatch(/warn/);
  });

  it('con otras monedas: las columnas, los totales y las categorías van en la principal y la segunda del usuario', () => {
    const state = seedState();
    state.mainCurrency = 'USD';
    state.secondCurrency = 'TRY';
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    const html = render('2026-10', { state });
    const t = text(html);
    expect(t).toContain('Paid Item Day Amount Currency Pay with Account USD TRY');
    expect(t).toContain('Date Name Place Category Method Amount Cur. Account USD TRY Description');
    // 42,025.57 DOP / 58.76.
    expect(t).toContain('Fixed monthly expenses 6 of 11 paid · total 715.21 USD');
    expect(t).toContain('Transaction history 7 transactions · total 184.56 USD');
    expect(t).toContain('By category USD Fixed expenses 652');
    // Claude: 106 USD = 4,240 TRY.
    expect(bare(html)).toContain('106.00 4,240.00');
    // Las tres monedas están en uso, con la principal USD: solo se piden TRY y DOP contra USD (el par de la barra
    // primero, en el sentido en que se escribió). TRY → DOP se cruza por USD y no es una fila.
    const rates = section(html, 'Month rates', '>Credit cards</h2>');
    expect(els(rates, 'input').map((i) => i['aria-label'])).toEqual([
      'Rate USD → TRY since 01/10',
      'Rate USD → DOP since 01/10',
      'Rate USD → DOP since 06/10',
      'Date the new rate applies from',
      'New rate',
    ]);
    expect(bare(rates)).not.toContain('1 TRY = DOP');
  });

  it('una cuenta que se ocultó después sigue viéndose en sus filas, y solo en ellas', () => {
    const state = seedState();
    state.accounts.push(account('old', 'Old wallet', 'DOP', { hidden: true }));
    const month = state.months['2026-10']!;
    month.tx.find((x) => x.desc === 'Coffee')!.accountId = 'old';
    month.fixed.find((f) => f.name === 'Netflix')!.accountId = 'old';
    const html = render('2026-10', { state });
    expect(selected(html, 'Account of Coffee')).toBe('old');
    expect(selected(html, 'Account of Netflix')).toBe('old');
    expect([...html.matchAll(/<option value="old"[^>]*>Old wallet<\/option>/g)]).toHaveLength(2);
    // Una cuenta oculta en otra moneda no trae su moneda a las tasas del mes.
    expect(bare(section(html, 'Month rates', '>Credit cards</h2>'))).not.toContain('TRY');
  });

  it('un envío entre cuentas de la misma moneda: tasa 1, que no se escribe', () => {
    const state = seedState();
    state.accounts.push(account('paypal', 'PayPal', 'USD'));
    state.months['2026-10']!.transfers.push({
      id: 'tr-same',
      monthKey: '2026-10',
      date: '2026-10-05',
      via: 'PayPal',
      fromAccountId: 'us',
      toAccountId: 'paypal',
      amount: 200,
      rate: 1,
      budget: false, fee: 0,
    });
    const card = section(render('2026-10', { state }), 'Transfers', INCOME);
    const rate = els(card, 'input').find((i) => i['aria-label'] === 'Rate of PayPal 05/10')!;
    expect(rate).toMatchObject({ value: '1.00' });
    expect(rate).toHaveProperty('readOnly');
    expect(els(card, 'input').find((i) => i['aria-label'] === 'Rate of Remitly 02/10')).not.toHaveProperty('readOnly');
    expect(bare(card)).toContain('USD = 200.00 USD');
  });

  it('una sola transacción va en singular', () => {
    const state = seedState();
    const month = state.months['2026-10']!;
    month.tx = month.tx.slice(0, 1);
    expect(text(render('2026-10', { state }))).toContain('1 transaction · total 4,850.00 DOP');
  });

  it('los gastos fijos se pintan por `sort`, no por posición', () => {
    const state = seedState();
    const month = state.months['2026-10']!;
    month.fixed = [...month.fixed].reverse();
    const card = section(render('2026-10', { state }), 'Fixed monthly expenses', 'By category');
    const names = els(card, 'input')
      .filter((i) => i['aria-label'] === 'Item')
      .map((i) => i.value);
    expect(names[0]).toBe('Electricity');
    expect(names[10]).toBe('Unicaribe');
  });

  it('una categoría o un método de fuera de la lista se conserva como opción', () => {
    const state = seedState();
    const coffee = state.months['2026-10']!.tx.find((x) => x.desc === 'Coffee')!;
    coffee.cat = 'Pets';
    coffee.method = 'Cheque';
    // Una fila de antes de que hubiera dos tarjetas: su 'Card' se conserva, no pasa sola a ser la de débito.
    state.months['2026-10']!.tx.find((x) => x.desc === 'Gas')!.method = 'Card';
    const html = render('2026-10', { state });
    const card = section(html, 'Transaction history', 'Closing the month');
    // Van al final de su lista y son la opción seleccionada; el resto de las filas no las ofrece.
    expect(card).toContain('<option value="Other">Other</option><option value="Pets" selected="">Pets</option></select>');
    expect(card).toContain('<option value="Cash">Cash</option><option value="Cheque" selected="">Cheque</option></select>');
    expect(card).toContain('<option value="Cash">Cash</option><option value="Card" selected="">Card</option></select>');
    expect([...card.matchAll(/value="Pets"/g)]).toHaveLength(1);
    expect([...card.matchAll(/value="Cheque"/g)]).toHaveLength(1);
    expect([...card.matchAll(/value="Card"/g)]).toHaveLength(1);
    expect(selected(card, 'Method of Gas')).toBe('Card');
    expect(selected(card, 'Method of Lunch')).toBe('Debit card');
    // La categoría nueva también suma en "By category".
    expect(text(html)).toContain('Pets 385');
  });

  it('una transacción en USD se convierte con la tasa del mes', () => {
    const state = seedState();
    const coffee = state.months['2026-10']!.tx.find((x) => x.desc === 'Coffee')!;
    coffee.amount = 10;
    coffee.cur = 'USD';
    const card = section(render('2026-10', { state }), 'Transaction history', 'Closing the month');
    expect(text(card)).toContain('587.60 10.00');
    expect(text(card)).toContain('7 transactions · total 11,047.60 DOP');
  });
});

describe('tasas del mes: una tasa por fecha', () => {
  /** Las filas del cuerpo de la tabla de tasas, cada una con su HTML. */
  const bodyRows = (card: string) => [...section(card, '<tbody>', '</tbody>').matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!);
  const ratesCard = (html: string) => section(html, 'Month rates', '>Credit cards</h2>');

  it('varias tasas escritas del mismo par salen por fecha, cada una con su celda y su ×', () => {
    const state = seedState();
    // Llegan desordenadas: la tarjeta las pone de la más antigua a la más reciente.
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-20' },
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 59.5, date: '2026-10-08' },
    ];
    const card = ratesCard(render('2026-10', { state }));
    expect(bare(card)).toContain('Since From Rate To 01/10 1 USD = DOP × 08/10 1 USD = DOP × 20/10 1 USD = DOP × Add');
    expect(els(card, 'input').slice(0, 3).map((i) => [i.type, i.value, i['aria-label']])).toEqual([
      ['number', '58.00', 'Rate USD → DOP since 01/10'],
      ['number', '59.50', 'Rate USD → DOP since 08/10'],
      ['number', '60.00', 'Rate USD → DOP since 20/10'],
    ]);
    expect(els(card, 'button').map((b) => b['aria-label'])).toEqual([
      undefined,
      'Expand',
      'Delete rate USD → DOP of 01/10',
      'Delete rate USD → DOP of 08/10',
      'Delete rate USD → DOP of 20/10',
      undefined,
    ]);
    expect(buttons(card)).toEqual(['Cancel', '×', '×', '×', 'Add']);
    // Ninguna lleva nota de origen: son las escritas de este mes.
    expect(els(card, 'span').filter((x) => /hint/.test(x.class ?? ''))).toEqual([]);
  });

  it('una tasa escrita en el otro sentido sale como se escribió', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 0.0165, date: '2026-10-04' },
    ];
    const card = ratesCard(render('2026-10', { state }));
    expect(bare(card)).toContain('01/10 1 USD = DOP × 04/10 1 DOP = USD ×');
    expect(els(card, 'input').slice(0, 2).map((i) => [i.value, i['aria-label']])).toEqual([
      ['58.00', 'Rate USD → DOP since 01/10'],
      ['0.0165', 'Rate DOP → USD since 04/10'],
    ]);
  });

  it('un par sin tasa escrita en el mes: una sola fila, sin fecha ni ×, con el origen y la celda editable', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY'));
    const rows = bodyRows(ratesCard(render('2026-10', { state })));
    // Dos escritas de USD → DOP, una fila por el único par sin escribir que hace falta (TRY → DOP; USD → TRY se
    // cruza por la principal) y la fila de agregar.
    expect(rows).toHaveLength(2 + 1 + 1);
    const [first, second, tryDop] = rows;
    for (const typed of [first!, second!]) {
      expect(buttons(typed)).toEqual(['×']);
      expect(typed).not.toMatch(/hint/);
      expect(typed).not.toMatch(/faint/);
    }
    for (const [row, label, value] of [
      [tryDop!, 'Rate TRY → DOP', '1.40'],
    ] as const) {
      // La raya en la columna de la fecha, atenuada.
      expect(els(row, 'td')[0]!.class).toMatch(/faint/);
      expect(text(row).trim().startsWith('—')).toBe(true);
      expect(text(row)).toContain('default value, not set yet');
      // Sin ×: no hay nada guardado que quitar.
      expect(els(row, 'button')).toEqual([]);
      // Pero se escribe en ella: crea la tasa escrita del par.
      const [cell, ...rest] = els(row, 'input');
      expect(rest).toEqual([]);
      expect(cell).toMatchObject({ type: 'number', value, 'aria-label': label, step: 'any' });
      expect(cell).not.toHaveProperty('readOnly');
      expect(cell).not.toHaveProperty('disabled');
    }
  });

  it('la celda de una tasa sin escribir enseña la cifra como el resto de la tarjeta: dos decimales, o cuatro si es menor que 1', () => {
    const state = seedState();
    // Sin tasa escrita ni envíos en octubre ni en septiembre, la tasa sale del único envío de agosto: 58.123456.
    Object.assign(state.months['2026-10']!, { rates: [], transfers: [] });
    Object.assign(state.months['2026-09']!, { transfers: [] });
    Object.assign(state.months['2026-08']!, { transfers: [{ ...state.months['2026-08']!.transfers[0]!, rate: 58.123456 }] });
    const card = ratesCard(render('2026-10', { state }));
    expect(els(card, 'input')[0]).toMatchObject({ value: '58.12', 'aria-label': 'Rate USD → DOP' });
    expect(bare(card)).toContain('— 1 USD = DOP from August 2026');
  });

  it('mes cerrado: las tasas escritas van como texto con su fecha, sin ×, sin celdas y sin fila de agregar', () => {
    const state = seedState();
    state.months['2026-09']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58.5, date: '2026-09-01' },
      { from: 'USD', to: 'DOP', rate: 58.6, date: '2026-09-15' },
    ];
    const card = ratesCard(render('2026-09', { state }));
    expect(text(card)).toContain('Since From Rate To 01/09 1 USD = 58.50 DOP 15/09 1 USD = 58.60 DOP');
    expect(els(card, 'input')).toEqual([]);
    expect(els(card, 'select')).toEqual([]);
    expect(buttons(card)).toEqual([]);
    expect(bodyRows(card)).toHaveLength(2);
    expect(card).not.toMatch(/hint/);
    // La nota de la tarjeta se queda: explica lo que se ve.
    expect(text(card)).toContain('A new rate applies from its date on.');
  });

  it('sin segunda moneda: las tablas no llevan la segunda columna de importes', () => {
    const t = text(render('2026-10', { state: { ...seedState(), secondCurrency: null } }));
    expect(t).toContain('Pay with Account DOP');
    expect(t).not.toContain('Account DOP USD');
    expect(t).not.toContain('Used in USD');
  });

  it('mes cerrado sin tasa escrita, con una tercera moneda: cada par como texto, con la raya y su origen', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY'));
    const card = ratesCard(render('2026-09', { state }));
    const ct = text(card).replace(/&#x27;/g, "'");
    expect(ct).toContain("— 1 USD = 58.57 DOP from this month's transfers — 1 TRY = 1.40 DOP default value, not set yet");
    expect(ct).not.toContain('1 USD = 42.00 TRY');
    expect(els(card, 'input')).toEqual([]);
    expect(buttons(card)).toEqual([]);
    expect(els(card, 'span').filter((x) => /warn/.test(x.class ?? ''))).toHaveLength(1);
  });

  describe('la fecha que propone la fila de agregar', () => {
    const newRateDate = (html: string) => els(ratesCard(html), 'input').find((i) => i['aria-label'] === 'Date the new rate applies from')!;

    it('hoy, si el mes seleccionado es el actual y el par ya tiene una tasa escrita vigente', () => {
      const html = render('2026-10');
      expect(selected(ratesCard(html), 'Currency the new rate converts from')).toBe('USD');
      expect(newRateDate(html)).toMatchObject({ type: 'date', value: '2026-10-07' });
      expect(newRateDate(html)).not.toHaveProperty('readOnly');
    });

    it('hoy también si la vigente se escribió en un mes anterior', () => {
      const state = seedState();
      state.months['2026-09']!.rates = [{ from: 'USD', to: 'DOP', rate: 58.5, date: '2026-09-10' }];
      state.months['2026-10']!.rates = [];
      const html = render('2026-10', { state });
      const card = ratesCard(html);
      // Octubre no tiene ninguna: enseña la de septiembre, que sigue valiendo (aunque octubre tenga envíos).
      expect(bare(card)).toContain('— 1 USD = DOP from September 2026 Add');
      expect(els(card, 'input')[0]).toMatchObject({ value: '58.50', 'aria-label': 'Rate USD → DOP' });
      expect(newRateDate(html).value).toBe('2026-10-07');
    });

    it('el primer día del mes, si el mes seleccionado no es el actual', () => {
      const state = seedState();
      state.months['2026-09']!.closed = false;
      state.months['2026-09']!.rates = [{ from: 'USD', to: 'DOP', rate: 58.5, date: '2026-09-10' }];
      // Hoy es 7 de octubre: en septiembre los borradores arrancan el día 1.
      expect(newRateDate(render('2026-09', { state })).value).toBe('2026-09-01');
    });

    it('el primer día del mes, aunque hoy sea otro, si el par no tiene ninguna tasa escrita', () => {
      const state = seedState();
      state.accounts.push(account('tr', 'TR account', 'TRY'));
      const html = render('2026-10', { state });
      // La fila propone el primer par sin escribir (TRY → DOP): así la tasa cubre también las filas del 1 al 6.
      expect(selected(ratesCard(html), 'Currency the new rate converts from')).toBe('TRY');
      expect(selected(ratesCard(html), 'Currency the new rate converts to')).toBe('DOP');
      expect(newRateDate(html).value).toBe('2026-10-01');
      // Las demás filas de agregar siguen en hoy.
      expect(els(html, 'input').find((i) => i['aria-label'] === 'Date of the new transaction')!.value).toBe('2026-10-07');

      // Lo mismo con el par de la barra cuando nadie lo ha escrito nunca: sale de los envíos del mes.
      const none = seedState();
      none.months['2026-10']!.rates = [];
      const transfers = render('2026-10', { state: none });
      expect(text(ratesCard(transfers)).replace(/&#x27;/g, "'")).toContain("— 1 USD = DOP from this month's transfers");
      expect(newRateDate(transfers).value).toBe('2026-10-01');
    });
  });
});

describe('conversión con la tasa de la fecha', () => {
  /** Octubre con dos tasas: 58 desde el día 1 y 60 desde el día 5. */
  const dated = () => {
    const state = seedState();
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
    ];
    return state;
  };
  /** La fila del historial de esa transacción, como texto sin las listas. */
  const txRow = (html: string, name: string) => {
    const card = section(html, HISTORY, 'Closing the month');
    const row = [...card.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!).find((r) => r.includes(`aria-label="Date of ${name}"`));
    expect(row, name).toBeDefined();
    return bare(row!).trim();
  };

  it('una transacción en USD se convierte con la tasa vigente en su fecha: la nueva no cambia las filas anteriores', () => {
    const state = dated();
    const tx = state.months['2026-10']!.tx;
    // Uber (día 2) y Coffee (día 7), las dos de 10 USD.
    Object.assign(tx.find((x) => x.desc === 'Uber to work')!, { amount: 10, cur: 'USD' });
    Object.assign(tx.find((x) => x.desc === 'Coffee')!, { amount: 10, cur: 'USD' });
    const html = render('2026-10', { state });
    expect(txRow(html, 'Uber to work')).toBe('580.00 10.00 ⋯ ↘ ×');
    expect(txRow(html, 'Coffee')).toBe('600.00 10.00 ⋯ ↘ ×');
    // El total del historial suma cada una con la suya: 10,845 − 320 − 385 + 580 + 600.
    expect(text(html)).toContain('7 transactions · total 11,320.00 DOP');
  });

  it('el día en que cambia la tasa ya vale la nueva', () => {
    const state = dated();
    // Pharmacy es del día 5; Movies, del 4.
    Object.assign(state.months['2026-10']!.tx.find((x) => x.desc === 'Pharmacy')!, { amount: 10, cur: 'USD' });
    Object.assign(state.months['2026-10']!.tx.find((x) => x.desc === 'Movies')!, { amount: 10, cur: 'USD' });
    const html = render('2026-10', { state });
    expect(txRow(html, 'Pharmacy')).toBe('600.00 10.00 ⋯ ↘ ×');
    expect(txRow(html, 'Movies')).toBe('580.00 10.00 ⋯ ↘ ×');
  });

  it('también la columna en la segunda moneda de una transacción en pesos', () => {
    const html = render('2026-10', { state: dated() });
    // Lunch (día 3): 1,150 / 58. Gas (día 6): 2,000 / 60.
    expect(txRow(html, 'Lunch')).toBe('1,150.00 19.83 ⋯ ↘ ×');
    expect(txRow(html, 'Gas')).toBe('2,000.00 33.33 ⋯ ↘ ×');
  });

  it('un gasto fijo no tiene fecha: va con la última tasa del mes', () => {
    const html = render('2026-10', { state: dated() });
    // Claude: 106 USD × 60.
    expect(bare(section(html, 'Fixed monthly expenses', 'By category'))).toContain('6,360.00 106.00');
    // Electricity: 1,337.15 / 60.
    expect(bare(section(html, 'Fixed monthly expenses', 'By category'))).toContain('1,337.15 22.29');
  });

  it('un ingreso del mes también va con la de su fecha', () => {
    const state = dated();
    state.incomes.push(income({ id: 'in-3', amount: 100, cur: 'USD', date: '2026-10-03' }), income({ id: 'in-6', amount: 100, cur: 'USD', date: '2026-10-06' }));
    const card = section(render('2026-10', { state }), INCOME, HISTORY);
    // El sueldo del día 1 (5,800 × 58), 100 USD del 3 (× 58) y 100 USD del 6 (× 60): 336,400 + 5,800 + 6,000. La
    // tarjeta del mes ya no enseña el equivalente de cada fila (sí la tabla de Savings); queda el total.
    expect(bare(card)).toContain('Income Total 348,200.00 DOP');
  });
});

describe('ingresos del mes', () => {
  const incomeCard = (html: string, title = 'Income', next = 'Transaction history') => section(html, `>${title}</h2>`, `>${next}</h2>`);
  const bodyRows = (card: string) => [...section(card, '<tbody>', '</tbody>').matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!);

  it('la tarjeta va junto a la de envíos, antes del historial, con el total del mes y su nota', () => {
    const html = render('2026-10');
    const card = incomeCard(html);
    const ct = bare(card).replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
    // El sueldo de octubre: 5,800 USD × 58.76.
    expect(ct).toContain(
      'Income Total 340,808.00 DOP Cancel Money received outside transfers. With "Adds to budget" checked, it also raises this month\'s budget. Date Description Account Amount Cur. Budget',
    );
    // Media tarjeta: sin la columna del equivalente y con la casilla bajo un encabezado corto, que dice entero qué es.
    expect(els(card, 'th').find((th) => th.title === 'Adds to budget')).toMatchObject({ 'aria-label': 'Adds to budget' });
    expect(els(card, 'table')).toEqual([expect.objectContaining({ style: 'min-width:560px', 'aria-label': 'Income' })]);
    // Hija directa de la pila de la hoja, como la de envíos y el historial.
    const before = html.slice(0, html.indexOf(INCOME));
    expect(before.slice(before.lastIndexOf('<div class="_card_'))).toMatch(/^<div class="_card_\w+"><div class="_header_\w+"><h2 class="_title_\w+"$/);
    expect(html.indexOf('>Transfers</h2>')).toBeLessThan(html.indexOf(INCOME));
    expect(html.indexOf(INCOME)).toBeLessThan(html.indexOf(HISTORY));
  });

  it('fila de agregar: fecha del día, descripción, cuenta por defecto, monto, su moneda y "Adds to budget" marcada', () => {
    const card = incomeCard(render('2026-10'));
    const draft = bodyRows(card)[0]!;
    const inputs = els(draft, 'input');
    expect(inputs.map((i) => i.type)).toEqual(['date', 'text', 'number', 'checkbox']);
    expect(inputs[0]).toMatchObject({ value: '2026-10-07', 'aria-label': 'Income date' });
    expect(inputs[1]).toMatchObject({ value: '', placeholder: 'Salary, payment…', maxLength: '200', 'aria-label': 'Description' });
    expect(inputs[2]).toMatchObject({ value: '', placeholder: '0.00', 'aria-label': 'Amount' });
    // En la hoja del mes un ingreso nuevo sube el presupuesto, salvo que se desmarque.
    expect(inputs[3]).toMatchObject({ 'aria-label': 'The new income adds to the budget' });
    expect(inputs[3]).toHaveProperty('checked');
    expect(inputs[3]).not.toHaveProperty('disabled');
    expect(selected(draft, 'Account')).toBe('dr');
    expect(selected(draft, 'Currency')).toBe('DOP');
    // El botón va corto para caber en media tarjeta; su nombre accesible sigue siendo el completo.
    expect(buttons(draft)).toEqual(['Add']);
    expect(els(draft, 'button')).toEqual([expect.objectContaining({ 'aria-label': 'Add income' })]);
  });

  it('la fila de agregar sigue a la cuenta por defecto y a su moneda', () => {
    const state = seedState();
    state.defaultAccountId = 'us';
    const draft = bodyRows(incomeCard(render('2026-10', { state })))[0]!;
    expect(selected(draft, 'Account')).toBe('us');
    expect(selected(draft, 'Currency')).toBe('USD');
  });

  it('cada ingreso del mes se edita en su fila, con su casilla y su ×', () => {
    const card = incomeCard(render('2026-10'));
    const rows = bodyRows(card);
    // La de agregar y el sueldo de octubre.
    expect(rows).toHaveLength(2);
    const salary = rows[1]!;
    expect(els(salary, 'input').map((i) => [i.type, i.value ?? '', i['aria-label']])).toEqual([
      ['date', '2026-10-01', 'Income date'],
      ['text', 'Salary', 'Description'],
      ['number', '5800', 'Amount'],
      ['checkbox', '', 'Adds to budget: income of 2026-10-01, 5,800.00 USD'],
    ]);
    // Los sueldos de ejemplo no suben el presupuesto.
    expect(els(salary, 'input')[3]).not.toHaveProperty('checked');
    expect(selected(salary, 'Account')).toBe('us');
    expect(selected(salary, 'Currency')).toBe('USD');
    expect(bare(salary).trim()).toBe('×');
    expect(els(salary, 'button')).toEqual([expect.objectContaining({ title: 'Delete', 'aria-label': 'Delete income of 2026-10-01: 5,800.00 USD' })]);
    expect(buttons(card)).toEqual(['Cancel', 'Add', '×']);
  });

  it('solo los ingresos con fecha en el mes seleccionado, del más reciente al más antiguo', () => {
    const state = () => {
      const s = seedState();
      s.incomes.push(
        income({ id: 'in-refund', amount: 2500, date: '2026-10-05', desc: 'Refund', budget: true }),
        income({ id: 'in-sep', amount: 999, date: '2026-09-20', desc: 'September gift' }),
        income({ id: 'in-nov', amount: 777, date: '2026-11-02', desc: 'November gift' }),
        income({ id: 'in-last', amount: 100, date: '2026-10-31', desc: 'Last day' }),
      );
      return s;
    };
    const descriptions = (card: string) =>
      els(card, 'input')
        .filter((i) => i['aria-label'] === 'Description')
        .map((i) => i.value);

    const october = incomeCard(render('2026-10', { state: state() }));
    // La primera es la fila de agregar.
    expect(descriptions(october)).toEqual(['', 'Last day', 'Refund', 'Salary']);
    // El total es el de esos tres: 340,808 + 2,500 + 100.
    expect(bare(october)).toContain('Income Total 343,408.00 DOP');
    expect(october).not.toContain('September gift');
    expect(october).not.toContain('November gift');
    // La casilla de cada fila dice si ese ingreso sube el presupuesto.
    const boxes = els(october, 'input').filter((i) => i.type === 'checkbox');
    expect(boxes.map((b) => [b['aria-label'], 'checked' in b])).toEqual([
      ['The new income adds to the budget', true],
      ['Adds to budget: income of 2026-10-31, 100.00 DOP', false],
      ['Adds to budget: income of 2026-10-05, 2,500.00 DOP', true],
      ['Adds to budget: income of 2026-10-01, 5,800.00 USD', false],
    ]);

    // Septiembre (cerrado) enseña los suyos.
    const september = incomeCard(render('2026-09', { state: state() }));
    expect(descriptions(september)).toEqual(['September gift', 'Salary']);
    // Agosto, solo su sueldo.
    expect(descriptions(incomeCard(render('2026-08', { state: state() })))).toEqual(['Salary']);
  });

  it('mes sin ingresos: total en cero y solo la fila de agregar', () => {
    const state = seedState();
    state.incomes = state.incomes.filter((i) => !i.date.startsWith('2026-10'));
    const card = incomeCard(render('2026-10', { state }));
    expect(bare(card)).toContain('Income Total 0.00 DOP');
    expect(bodyRows(card)).toHaveLength(1);
    expect(buttons(card)).toEqual(['Cancel', 'Add']);
  });

  it('mes cerrado: se ven, pero sin fila de agregar, sin × y con todo apagado', () => {
    const state = seedState();
    state.incomes.push(income({ id: 'in-sep', amount: 999, date: '2026-09-20', desc: 'September gift', budget: true }));
    const card = incomeCard(render('2026-09', { state }));
    expect(bare(card)).toContain('Income Total 340,730.22 DOP');
    const rows = bodyRows(card);
    expect(rows).toHaveLength(2);
    expect(buttons(card)).toEqual([]);
    expect(card).not.toContain('Add income');
    expect(card).not.toContain('placeholder=');
    const inputs = els(card, 'input');
    const boxes = inputs.filter((i) => i.type === 'checkbox');
    const fields = inputs.filter((i) => i.type !== 'checkbox');
    // 2 ingresos × (fecha, descripción, monto), de solo lectura.
    expect(fields).toHaveLength(2 * 3);
    expect(fields.every((f) => 'readOnly' in f)).toBe(true);
    // Las casillas dicen lo que hay, sin poder cambiarlo.
    expect(boxes.map((b) => ['checked' in b, 'disabled' in b])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(els(card, 'select')).toHaveLength(2 * 2);
    expect(els(card, 'select').every((x) => 'disabled' in x)).toBe(true);
    // La columna de la acción queda vacía.
    expect(els(rows[0]!, 'button')).toEqual([]);
  });

  it('en español y en turco: título, total, nota, columnas y etiquetas', () => {
    const es = incomeCard(render('2026-10', { lang: 'es' }), 'Ingreso', 'Historial de transacciones');
    expect(bare(es)).toContain(
      'Ingreso Total 340,808.00 DOP Cancelar Dinero recibido fuera de los envíos. Con «Suma al presupuesto» marcado, sube además el presupuesto de este mes. Fecha Descripción Cuenta Monto Mon. Presup.',
    );
    expect(els(es, 'th').find((th) => th.title === 'Suma al presupuesto')).toMatchObject({ 'aria-label': 'Suma al presupuesto' });
    expect(els(es, 'table')).toEqual([expect.objectContaining({ 'aria-label': 'Ingreso' })]);
    expect(buttons(es)).toEqual(['Cancelar', 'Agregar', '×']);
    const esLabels = [...els(es, 'input'), ...els(es, 'select'), ...els(es, 'button')].map((e) => e['aria-label']);
    expect(esLabels).toEqual(
      expect.arrayContaining([
        'Fecha del ingreso',
        'Descripción',
        'Cuenta',
        'Monto',
        'Moneda',
        'El ingreso nuevo suma al presupuesto',
        'Suma al presupuesto: ingreso del 2026-10-01, 5,800.00 USD',
        'Eliminar ingreso del 2026-10-01: 5,800.00 USD',
      ]),
    );
    expect(els(es, 'input').find((i) => i['aria-label'] === 'El ingreso nuevo suma al presupuesto')).toHaveProperty('checked');
    expect(els(es, 'input')).toContainEqual(expect.objectContaining({ placeholder: 'Sueldo, pago…' }));

    const tr = incomeCard(render('2026-10', { lang: 'tr' }), 'Gelir', 'İşlem geçmişi');
    expect(bare(tr).replace(/&quot;/g, '"')).toContain(
      'Gelir Toplam 340,808.00 DOP İptal Transferler dışında alınan para. "Bütçeye eklenir" işaretliyse bu ayın bütçesini de artırır. Tarih Açıklama Hesap Tutar Birim Bütçe',
    );
    expect(els(tr, 'table')).toEqual([expect.objectContaining({ 'aria-label': 'Gelir' })]);
    expect(buttons(tr)).toEqual(['İptal', 'Ekle', '×']);
    expect(els(tr, 'input').find((i) => i['aria-label'] === 'Yeni gelir bütçeye eklenir')).toHaveProperty('checked');
    expect(els(tr, 'input')).toContainEqual(expect.objectContaining({ 'aria-label': 'Bütçeye eklenir: 2026-10-01 geliri, 5,800.00 USD' }));

    // Cerrado, en los dos: sin el botón de agregar.
    expect(buttons(incomeCard(render('2026-09', { lang: 'es' }), 'Ingreso', 'Historial de transacciones'))).toEqual([]);
    expect(buttons(incomeCard(render('2026-09', { lang: 'tr' }), 'Gelir', 'İşlem geçmişi'))).toEqual([]);
  });

  it('con otra moneda principal, el total va en ella', () => {
    const state = seedState();
    state.mainCurrency = 'USD';
    state.secondCurrency = 'DOP';
    const card = incomeCard(render('2026-10', { state }));
    expect(bare(card)).toContain('Income Total 5,800.00 USD');
    expect(bare(card)).toContain('Date Description Account Amount Cur. Budget');
  });
});

describe('métodos de pago en el historial', () => {
  /** Las opciones (valor y texto) de la lista con esa etiqueta. */
  const options = (html: string, label: string) => {
    const m = html.match(new RegExp(`<select\\b[^>]*aria-label="${label}"[^>]*>(.*?)</select>`));
    expect(m, label).not.toBeNull();
    return [...m![1]!.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((o) => [o[1]!, o[2]!]);
  };
  const VALUES = ['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash'];

  it('los cinco, en su orden, con la tarjeta de débito elegida en la fila de agregar', () => {
    const html = render('2026-10');
    expect(options(html, 'Method of the new transaction')).toEqual(VALUES.map((v) => [v, v]));
    expect(selected(html, 'Method of the new transaction')).toBe('Debit card');
    // Las filas ofrecen los mismos; los datos de ejemplo usan la de débito y la app del banco.
    expect(options(html, 'Method of Coffee')).toEqual(VALUES.map((v) => [v, v]));
    expect(selected(html, 'Method of Coffee')).toBe('Debit card');
    expect(selected(html, 'Method of Movies')).toBe('Bank app');
  });

  it('en español y en turco se ve el nombre traducido y se guarda el mismo valor', () => {
    const es = render('2026-10', { lang: 'es' });
    const esNames = ['Tarjeta de débito', 'Tarjeta de crédito', 'Transferencia', 'App del banco', 'Efectivo'];
    expect(options(es, 'Método de la nueva transacción')).toEqual(VALUES.map((v, i) => [v, esNames[i]]));
    expect(options(es, 'Método de Coffee')).toEqual(VALUES.map((v, i) => [v, esNames[i]]));
    expect(selected(es, 'Método de la nueva transacción')).toBe('Debit card');

    const tr = render('2026-10', { lang: 'tr' });
    const trNames = ['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit'];
    expect(options(tr, 'Yeni işlemin yöntemi')).toEqual(VALUES.map((v, i) => [v, trNames[i]]));
    expect(options(tr, 'Yöntem: Coffee')).toEqual(VALUES.map((v, i) => [v, trNames[i]]));
    expect(selected(tr, 'Yeni işlemin yöntemi')).toBe('Debit card');
  });

  it('una fila con tarjeta de crédito o en efectivo la trae elegida, en cualquier idioma', () => {
    const state = () => {
      const s = seedState();
      s.months['2026-10']!.tx.find((x) => x.desc === 'Coffee')!.method = 'Credit card';
      s.months['2026-10']!.tx.find((x) => x.desc === 'Gas')!.method = 'Cash';
      return s;
    };
    const en = render('2026-10', { state: state() });
    expect(selected(en, 'Method of Coffee')).toBe('Credit card');
    expect(selected(en, 'Method of Gas')).toBe('Cash');
    // Son de la lista: no se agregan otra vez al final.
    expect(options(en, 'Method of Coffee')).toHaveLength(5);
    const es = render('2026-10', { lang: 'es', state: state() });
    expect(es).toContain('<option value="Credit card" selected="">Tarjeta de crédito</option>');
    expect(es).toContain('<option value="Cash" selected="">Efectivo</option>');
    const tr = render('2026-10', { lang: 'tr', state: state() });
    expect(tr).toContain('<option value="Credit card" selected="">Kredi kartı</option>');
    expect(tr).toContain('<option value="Cash" selected="">Nakit</option>');
  });

  it('con el mes cerrado la lista se ve igual, apagada', () => {
    const html = render('2026-09');
    expect(options(html, 'Method of Movies')).toEqual(VALUES.map((v) => [v, v]));
    expect(selected(html, 'Method of Movies')).toBe('Bank app');
    expect(els(html, 'select').find((x) => x['aria-label'] === 'Method of Movies')).toHaveProperty('disabled');
  });
});

describe('en español', () => {
  const html = render('2026-10', { lang: 'es' });
  const t = text(html);

  it('títulos, columnas y metas con sus cifras', () => {
    expect(t).toContain('Gastos mensuales fijos 6 de 11 pagados · total 42,025.57 DOP');
    expect(t).toContain('Pago Concepto Día Monto Moneda Pagar con Cuenta DOP USD');
    // La nota de las tasas y, en la primera columna, la fecha desde la que vale cada una.
    expect(t).toContain('Tasas del mes Cancelar Una tasa nueva vale desde su fecha. Las transacciones anteriores conservan la que tenían. Vigente desde Desde');
    expect(t).toContain('Tasa Hacia 01/10 1 USD =');
    expect(els(section(html, 'Tasas del mes', '>Envíos</h2>'), 'th')).toHaveLength(5);
    expect(t).toContain('Fecha Vía Desde → Hacia Monto Tasa Presup.');
    expect(t).toContain(
      'Ingreso Total 340,808.00 DOP Cancelar Dinero recibido fuera de los envíos. Con «Suma al presupuesto» marcado, sube además el presupuesto de este mes. Fecha Descripción Cuenta Monto Mon. Presup.',
    );
    expect(t).toContain('Historial de transacciones 7 transacciones · total 10,845.00 DOP');
    expect(t).toContain('Fecha Nombre Lugar Categoría Método Monto Mon. Cuenta DOP USD Descripción');
    expect(t).toContain(
      'Al cerrar el mes se guarda este resumen y se crea Noviembre 2026 con los mismos gastos mensuales, sin marcar como pagados. Cerrar Octubre 2026 Eliminar mes',
    );
  });

  it('el origen de una tasa sale en español; los códigos de moneda no cambian', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { rates: [], transfers: [] });
    state.accounts.push(account('tr', 'TR account', 'TRY'));
    const html = section(render('2026-10', { lang: 'es', state }), 'Tasas del mes', '>Envíos</h2>');
    const card = bare(html);
    // Con el mes abierto la cifra va en su celda (58.57, 1.39, 42.00); al lado, de dónde sale.
    expect(card).toContain('— 1 USD = DOP de septiembre 2026');
    expect(card).toContain('— 1 TRY = DOP valor por defecto, aún sin definir');
    expect(els(html, 'input').map((i) => [i.value, i['aria-label']])).toEqual([
      ['58.57', 'Tasa USD → DOP'],
      ['1.40', 'Tasa TRY → DOP'],
      ['2026-10-01', 'Fecha desde la que vale la tasa nueva'],
      ['', 'Nueva tasa'],
    ]);
    expect(text(render('2026-09', { lang: 'es' }))).toContain('1 USD = 58.57 DOP de los envíos de este mes');
  });

  it('una sola transacción va en singular', () => {
    const state = seedState();
    const month = state.months['2026-10']!;
    month.tx = month.tx.slice(0, 1);
    expect(text(render('2026-10', { lang: 'es', state }))).toContain('Historial de transacciones 1 transacción · total 4,850.00 DOP');
  });

  it('categorías y métodos: se ve el nombre en español y se guarda el canónico', () => {
    expect(text(section(html, 'Por categoría', 'Tasas del mes'))).toContain(
      'Por categoría DOP Gastos fijos 38,305 Supermercado 4,850 Transporte 2,320 Comida 1,535 Salud 1,240 Entretenimiento 900',
    );
    const draftRow = section(section(html, 'Historial de transacciones', 'Al cerrar el mes'), '<tbody>', '</tr>');
    expect(draftRow).toContain('<option value="Food" selected="">Comida</option><option value="Groceries">Supermercado</option>');
    expect(draftRow).toContain(
      '<option value="Debit card" selected="">Tarjeta de débito</option><option value="Credit card">Tarjeta de crédito</option><option value="Transfer">Transferencia</option><option value="Bank app">App del banco</option><option value="Cash">Efectivo</option></select>',
    );
    // Ningún nombre traducido se cuela como valor.
    expect(html).not.toContain('value="Comida"');
    expect(html).not.toContain('value="Tarjeta');
    expect(html).not.toContain('value="Efectivo"');
  });

  it('un valor de fuera de la lista sale tal cual, sin traducir', () => {
    const state = seedState();
    const coffee = state.months['2026-10']!.tx.find((x) => x.desc === 'Coffee')!;
    coffee.cat = 'Pets';
    coffee.method = 'Cheque';
    const out = render('2026-10', { lang: 'es', state });
    expect(out).toContain('<option value="Other">Otros</option><option value="Pets" selected="">Pets</option></select>');
    expect(out).toContain('<option value="Cash">Efectivo</option><option value="Cheque" selected="">Cheque</option></select>');
    expect(text(out)).toContain('Pets 385');
  });

  it('lo que escribió el usuario no se traduce; las etiquetas y los botones, sí', () => {
    const inputs = els(html, 'input');
    expect(inputs.filter((i) => i['aria-label'] === 'Concepto').map((i) => i.value)).toContain('Health insurance');
    expect(inputs.filter((i) => i['aria-label'] === 'Nombre').map((i) => i.value)).toContain('Weekly groceries');
    // Sin el «—» de la columna Día, que no es un texto.
    expect(placeholders(inputs)).toEqual([
      'Nuevo gasto mensual',
      'Día',
      '0.00',
      '0.00',
      // La comisión del envío de ejemplo, vacía, y después del monto del borrador, la del envío nuevo.
      '0.00',
      'Remitly',
      '500',
      '0.00',
      'Sueldo, pago…',
      '0.00',
      'Nueva transacción',
      'Lugar',
      '0.00',
      'Descripción (opcional)',
      'Nuevo gasto fuera de presupuesto',
      '0.00',
      'Descripción (opcional)',
    ]);
    const labels = [...inputs, ...els(html, 'select'), ...els(html, 'button')].map((e) => e['aria-label']);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Pagado: Electricity',
        'Día de Claude',
        'Monto de Electricity',
        'Moneda de Claude',
        'Cuenta de Claude',
        'Cuenta del nuevo gasto',
        'Cuenta de la nueva transacción',
        'Tasa USD → DOP desde el 01/10',
        'Tasa USD → DOP desde el 06/10',
        'Eliminar tasa USD → DOP del 01/10',
        'Eliminar tasa USD → DOP del 06/10',
        'Fecha desde la que vale la tasa nueva',
        'Nueva tasa',
        'Fecha del ingreso',
        'El ingreso nuevo suma al presupuesto',
        'Suma al presupuesto: ingreso del 2026-10-01, 5,800.00 USD',
        'Eliminar ingreso del 2026-10-01: 5,800.00 USD',
        'Cuenta de la que sale el nuevo envío',
        'Cuenta a la que llega el nuevo envío',
        'Monto del nuevo envío',
        'Tasa de Remitly 02/10',
        'Eliminar Netflix',
        'Eliminar envío del 02/10',
        'Vía del nuevo envío',
        'Tasa del nuevo envío',
        'Fecha de Coffee',
        'Categoría de Coffee',
        'Descripción de Coffee',
        'Descripción de la nueva transacción',
        'Abrir la descripción de Coffee',
      ]),
    );
    expect(new Set(buttons(html))).toEqual(new Set(['Cancelar', '×', '↘', '⋯', 'Agregar', '+ Agregar tarjeta', 'Editar', 'Cerrar Octubre 2026', 'Eliminar mes', 'Credit card']));
    expect(els(html, 'button')).toContainEqual(expect.objectContaining({ title: 'Eliminar' }));
  });

  it('mes sin datos y mes cerrado', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { fixed: [], transfers: [], tx: [] });
    const empty = text(render('2026-10', { lang: 'es', state }));
    expect(empty).toContain('Gastos mensuales fijos 0 de 0 pagados · total 0.00 DOP');
    expect(empty).toContain('Por categoría DOP Aún no hay gastos este mes.');
    expect(empty).toContain('Historial de transacciones 0 transacciones · total 0.00 DOP');

    const closed = render('2026-09', { lang: 'es' });
    expect(text(closed)).toContain(
      'Resumen de Septiembre 2026 Mes cerrado. Los registros quedan de solo lectura. Importes en DOP Ingreso 339,731 Gastado 66,636.54 Ahorrado 205,010 Vs. presupuesto 3,363.46 Reabrir mes',
    );
    expect(buttons(closed)).toEqual(['Reabrir mes', 'Credit card', '+ Agregar tarjeta', 'Editar', ...Array<string>(10).fill('⋯'), 'Eliminar mes']);
  });
});

describe('en turco', () => {
  const html = render('2026-10', { lang: 'tr' });
  const t = text(html);

  it('títulos, columnas y metas con sus cifras', () => {
    expect(t).toContain('Sabit aylık giderler 6 / 11 ödendi · toplam 42,025.57 DOP');
    expect(t).toContain('Ödendi Kalem Gün Tutar Para birimi Ödeme şekli Hesap DOP USD');
    expect(t).toContain('Ay kurları İptal Yeni kur, tarihinden itibaren geçerlidir. Önceki işlemler kendi kurunu korur. Başlangıç Nereden Kur Nereye 01/10 1 USD =');
    expect(t.replace(/&quot;/g, '"')).toContain(
      'Gelir Toplam 340,808.00 DOP İptal Transferler dışında alınan para. "Bütçeye eklenir" işaretliyse bu ayın bütçesini de artırır. Tarih Açıklama Hesap Tutar Birim Bütçe',
    );
    expect(t).toContain('Tarih Kanal Nereden → Nereye Tutar Kur Bütçe');
    expect(t).toContain('İşlem geçmişi 7 işlem · toplam 10,845.00 DOP');
    expect(t).toContain('Tarih Ad Yer Kategori Yöntem Tutar Birim Hesap DOP USD Açıklama');
    expect(t).toContain(
      'Ay kapatıldığında bu özet kaydedilir ve Kasım 2026, aynı aylık giderlerle, ödenmemiş olarak oluşturulur. Ekim 2026 ayını kapat Ayı sil',
    );
  });

  it('el origen de una tasa sale en turco', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { rates: [], transfers: [] });
    state.accounts.push(account('tr', 'TR account', 'TRY'));
    const html = section(render('2026-10', { lang: 'tr', state }), 'Ay kurları', '>Transferler</h2>');
    const card = bare(html);
    expect(card).toContain('— 1 USD = DOP Eylül 2026 ayından');
    expect(card).toContain('— 1 TRY = DOP varsayılan değer, henüz girilmedi');
    expect(els(html, 'input').slice(0, 2).map((i) => [i.value, i['aria-label']])).toEqual([
      ['58.57', 'Kur USD → DOP'],
      ['1.40', 'Kur TRY → DOP'],
    ]);
    // Con el mes cerrado la cifra es texto.
    expect(text(render('2026-09', { lang: 'tr' }))).toContain('— 1 USD = 58.57 DOP bu ayın transferlerinden');
  });

  it('una sola transacción: en turco el sustantivo no cambia con el número', () => {
    const state = seedState();
    const month = state.months['2026-10']!;
    month.tx = month.tx.slice(0, 1);
    expect(text(render('2026-10', { lang: 'tr', state }))).toContain('İşlem geçmişi 1 işlem · toplam 4,850.00 DOP');
  });

  it('categorías y métodos: se ve el nombre en turco y se guarda el canónico', () => {
    expect(text(section(html, 'Kategoriye göre', 'Ay kurları'))).toContain(
      'Kategoriye göre DOP Sabit giderler 38,305 Market 4,850 Ulaşım 2,320 Yemek 1,535 Sağlık 1,240 Eğlence 900',
    );
    const draftRow = section(section(html, 'İşlem geçmişi', 'Ay kapatıldığında'), '<tbody>', '</tr>');
    expect(draftRow).toContain('<option value="Food" selected="">Yemek</option><option value="Groceries">Market</option>');
    expect(draftRow).toContain(
      '<option value="Debit card" selected="">Banka kartı</option><option value="Credit card">Kredi kartı</option><option value="Transfer">Havale</option><option value="Bank app">Banka uygulaması</option><option value="Cash">Nakit</option></select>',
    );
    expect(html).not.toContain('value="Nakit"');
  });

  it('etiquetas, botones y números: los números no cambian de formato', () => {
    const inputs = els(html, 'input');
    expect(placeholders(inputs)).toEqual([
      'Yeni aylık gider',
      'Gün',
      '0.00',
      '0.00',
      // La comisión del envío de ejemplo, vacía, y después del monto del borrador, la del envío nuevo.
      '0.00',
      'Remitly',
      '500',
      '0.00',
      'Maaş, ödeme…',
      '0.00',
      'Yeni işlem',
      'Yer',
      '0.00',
      'Açıklama (isteğe bağlı)',
      'Yeni bütçe dışı gider',
      '0.00',
      'Açıklama (isteğe bağlı)',
    ]);
    const labels = [...inputs, ...els(html, 'select'), ...els(html, 'button')].map((e) => e['aria-label']);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Ödendi: Electricity',
        'Tutar: Electricity',
        'Sil: Netflix',
        '02/10 tarihli transferi sil',
        'Yeni transferin kanalı',
        'Yeni transferin çıktığı hesap',
        'Hesap: Coffee',
        'Kur USD → DOP, 01/10 tarihinden itibaren',
        'Kuru sil: USD → DOP, 06/10',
        'Yeni kurun geçerli olacağı tarih',
        'Yeni kur',
        'Gelir tarihi',
        'Yeni gelir bütçeye eklenir',
        'Bütçeye eklenir: 2026-10-01 geliri, 5,800.00 USD',
        '2026-10-01 tarihli geliri sil: 5,800.00 USD',
        'Tarih: Coffee',
        'Açıklama: Coffee',
        'Yeni işlemin açıklaması',
        'Coffee açıklamasını aç',
      ]),
    );
    expect(new Set(buttons(html))).toEqual(new Set(['İptal', '×', '↘', '⋯', 'Ekle', '+ Kart ekle', 'Düzenle', 'Ekim 2026 ayını kapat', 'Ayı sil', 'Credit card']));
    expect(t).toContain('88,140.00 DOP');
    expect(t).toContain('6,228.56 106.00');
  });

  it('mes sin datos y mes cerrado', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { fixed: [], transfers: [], tx: [] });
    const empty = text(render('2026-10', { lang: 'tr', state }));
    expect(empty).toContain('Sabit aylık giderler 0 / 0 ödendi · toplam 0.00 DOP');
    expect(empty).toContain('Kategoriye göre DOP Bu ay henüz gider yok.');

    const closed = render('2026-09', { lang: 'tr' });
    expect(text(closed)).toContain(
      'Eylül 2026 özeti Ay kapalı. Kayıtlar salt okunur. Tutarlar DOP cinsinden Gelir 339,731 Harcanan 66,636.54 Biriken 205,010 Bütçeye göre 3,363.46 Ayı yeniden aç',
    );
    expect(buttons(closed)).toEqual(['Ayı yeniden aç', 'Credit card', '+ Kart ekle', 'Düzenle', ...Array<string>(10).fill('⋯'), 'Ayı sil']);
  });
});

describe('las filas de agregar se abren a petición', () => {
  it('al entrar no hay ninguna: solo el "+ Add …" de cada tarjeta, plegado', () => {
    const html = render('2026-10', { addRows: false });
    expect(els(html, 'input').filter((i) => i['aria-label']?.includes('new '))).toEqual([]);
    expect(html).not.toContain('New transaction');
    // Sin gastos fuera de presupuesto y con su fila cerrada, la tarjeta no existe: ni tabla vacía ni aviso.
    expect(html).not.toContain('Outside budget');
    const reveal = els(html, 'button').filter((b) => 'aria-expanded' in b);
    expect(reveal.every((b) => b['aria-expanded'] === 'false')).toBe(true);
    expect(buttons(html).filter((b) => b.startsWith('+ '))).toEqual(['+ Add expense', '+ Add rate', '+ Add card', '+ Add transfer', '+ Add income', '+ Add outside-budget expense', '+ Add transaction']);
    expect(buttons(html)).not.toContain('Add');
    expect(buttons(html)).not.toContain('Cancel');
  });

  it('en español y en turco, cada botón dice qué agrega', () => {
    const plus = (lang: Language) => buttons(render('2026-10', { lang, addRows: false })).filter((b) => b.startsWith('+ '));
    expect(plus('es')).toEqual(['+ Agregar gasto', '+ Agregar tasa', '+ Agregar tarjeta', '+ Agregar envío', '+ Agregar ingreso', '+ Agregar gasto fuera de presupuesto', '+ Agregar transacción']);
    expect(plus('tr')).toEqual(['+ Gider ekle', '+ Kur ekle', '+ Kart ekle', '+ Transfer ekle', '+ Gelir ekle', '+ Bütçe dışı gider ekle', '+ İşlem ekle']);
  });

  it('un mes cerrado no las ofrece', () => {
    const html = render('2026-09', { addRows: false });
    expect(els(html, 'button').filter((b) => 'aria-expanded' in b)).toEqual([]);
  });
});

describe('la comisión de un envío en el historial', () => {
  const withFee = () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!.transfers[0]!, { fee: 2.99 });
    return state;
  };

  it('sale como una fila de solo lectura, marcada, y cuenta en el número y en el total de la cabecera', () => {
    const html = render('2026-10', { state: withFee() });
    const card = section(html, 'Transaction history');
    // 7 transacciones + la comisión: 10,845 + 2.99 × 58.76.
    expect(text(card)).toContain('Transaction history 8 transactions · total 11,020.69 DOP');
    const row = [...card.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!).find((r) => r.includes('Remitly fee'))!;
    expect(bare(row)).toContain('Remitly fee from transfer Remitly Other 2.99 USD US account 175.69 2.99');
    // Ni campos editables ni ×: se cambia en el envío.
    expect(els(row, 'input')).toEqual([expect.objectContaining({ type: 'date', value: '2026-10-02', readOnly: '' })]);
    expect(els(row, 'select')).toEqual([]);
    expect(els(row, 'button')).toEqual([]);
    expect(row).toContain('title="From the transfer of 02/10. Change it in Transfers."');
    // Y baja en "By category" como "Other".
    expect(bare(section(html, 'By category', 'Month rates'))).toContain('Other 176');
  });

  it('el borrador de un envío propone la comisión del último por esa vía', () => {
    const card = section(render('2026-10', { state: withFee() }), 'Transfers', INCOME);
    expect(els(card, 'input').find((i) => i['aria-label'] === 'Fee of the new transfer')).toMatchObject({ value: '2.99' });
    expect(els(card, 'input').find((i) => i['aria-label'] === 'Fee of Remitly 02/10')).toMatchObject({ value: '2.99' });
  });
});

describe('de dónde sale el idioma', () => {
  it('manda <I18nProvider> (el de la app) sobre el idioma del estado', () => {
    const t = text(render('2026-10', { lang: 'en', provider: 'tr' }));
    expect(t).toContain('Sabit aylık giderler 6 / 11 ödendi');
    expect(t).not.toContain('Fixed monthly expenses');
  });

  it('cambiar de idioma no deja textos del anterior', () => {
    // Textos de la interfaz de cada idioma que no coinciden con ningún dato de ejemplo.
    const own: Record<Language, string[]> = {
      en: ['Fixed monthly expenses', 'By category', 'Transaction history', 'Month rates', 'Closing the month', 'New transaction', 'Adds to budget', 'Moves budget'],
      es: ['Gastos mensuales fijos', 'Por categoría', 'Historial de transacciones', 'Tasas del mes', 'Al cerrar el mes', 'Nueva transacción', 'Suma al presupuesto', 'Mueve presupuesto'],
      tr: ['Sabit aylık giderler', 'Kategoriye göre', 'İşlem geçmişi', 'Ay kurları', 'Ay kapatıldığında', 'Yeni işlem', 'Bütçeye eklenir', 'Bütçeyi taşır'],
    };
    for (const lang of ['en', 'es', 'tr'] as const) {
      const html = render('2026-10', { lang });
      for (const [other, texts] of Object.entries(own)) {
        for (const piece of texts) expect(html.includes(piece), `"${piece}" en ${lang}`).toBe(other === lang);
      }
    }
  });
});

describe('Outside budget', () => {
  const withOutside = () => {
    const state = seedState();
    state.months['2026-10']!.outside = [
      { id: 'o1', monthKey: '2026-10', date: '2026-10-05', name: 'Car repair', desc: 'radiator', accountId: 'dr', amount: 4500, cur: 'DOP' },
      { id: 'o2', monthKey: '2026-10', date: '2026-10-06', name: 'Gift', desc: '', accountId: 'us', amount: 10, cur: 'USD' },
    ];
    return state;
  };

  it('con filas: la cabecera cuenta y suma en la moneda principal, y cada fila tiene sus botones de mover y borrar', () => {
    const html = render('2026-10', { state: withOutside(), addRows: false });
    const card = section(html, 'Outside budget', 'Closing the month');
    // 4,500 DOP + 10 USD a 58.76 (la tasa del 6 de octubre).
    expect(text(card)).toContain('Outside budget 2 expenses · total 5,087.60 DOP');
    expect(els(card, 'button').filter((b) => b['aria-label']?.startsWith('Move'))).toEqual([
      expect.objectContaining({ 'aria-label': 'Move Gift back to the budget', title: 'Move Gift back to the budget' }),
      expect.objectContaining({ 'aria-label': 'Move Car repair back to the budget', title: 'Move Car repair back to the budget' }),
    ]);
    // El enlace de la cabecera de "Transaction history" sobra: la tarjeta ya tiene su propio "+ Add".
    expect(buttons(html).filter((b) => b === '+ Add outside-budget expense')).toEqual(['+ Add outside-budget expense']);
    expect(buttons(section(html, 'Transaction history', 'Outside budget'))).not.toContain('+ Add outside-budget expense');
    // Después de "Transaction history", y su botón para mover cada transacción fuera.
    expect(html.indexOf('Transaction history')).toBeLessThan(html.indexOf('Outside budget'));
    expect(els(section(html, 'Transaction history', 'Outside budget'), 'button').filter((b) => b['aria-label']?.endsWith('outside the budget'))).toHaveLength(7);
    // Lo usado del presupuesto no cambia.
    expect(text(html)).toContain('Transaction history 7 transactions · total 10,845.00 DOP');
  });

  it('el enlace "+ Add outside-budget expense" está en la cabecera de Transaction history aunque la tarjeta no se vea', () => {
    const html = render('2026-10', { addRows: false });
    expect(html).not.toContain('Outside budget');
    expect(buttons(section(html, 'Transaction history')).slice(0, 2)).toEqual(['+ Add outside-budget expense', '+ Add transaction']);
  });

  it('un mes cerrado no ofrece ni el enlace ni los botones de mover', () => {
    const state = withOutside();
    state.months['2026-10']!.closed = true;
    const html = render('2026-10', { state, addRows: false });
    expect(html).toContain('Outside budget');
    expect(html).not.toContain('+ Add outside-budget expense');
    expect(els(html, 'button').filter((b) => b['aria-label']?.startsWith('Move'))).toEqual([]);
  });
});

describe('tarjetas de crédito', () => {
  const card = (id: string, name: string, over: Partial<CreditCard> = {}): CreditCard => ({ ...CARD, id, name, sort: id === 'a' ? 0 : id === 'b' ? 1 : 2, ...over });
  const owing = (cards: CreditCard[], other = 12000): AppState => {
    const s = { ...seedState(), cards };
    s.months['2026-10'] = { ...s.months['2026-10']!, cards: [{ cardId: cards[0]!.id, other, payments: [] }] };
    return s;
  };
  const cardsCard = (html: string) => section(html, '>Credit cards', '>Transfers</h2>');

  it('sin tarjetas: la invitación con su botón, ninguna fila de tarjeta en los gastos y «Credit card» fuera de los métodos', () => {
    const html = render('2026-10', { state: seedState() });
    const ct = text(cardsCard(html));
    expect(ct).toContain('Credit cards + Add card Add a credit card to track what you owe + Add card');
    expect(html).not.toContain('from card');
    expect(html).not.toContain('Paid: Credit card');
    expect(html).not.toContain('<option value="Credit card"');
    // El selector «Pagar con» solo ofrece la cuenta.
    expect(els(section(html, 'Fixed monthly expenses', 'By category'), 'option').map((o) => o.value)).not.toContain('card:a');
  });

  it('una tarjeta: nombre, límite, corte, lo que se debe, el aviso en rojo y el enlace para el día de pago; su fila en los gastos', () => {
    const html = render('2026-10', { state: owing([card('a', 'Visa', { bank: 'Popular', last4: '4242', limit: 60000, cutoffDay: 13 })]) });
    const ct = text(cardsCard(html));
    expect(ct).toContain('Visa Popular · •••• 4242 Edit');
    expect(ct).toContain('Limit 60,000.00 DOP');
    expect(ct).toContain('You owe 12,000.00 DOP · 20.0 % of limit Cutoff day 13 Due — cutoff in 6 days');
    expect(ct).toContain('To end the cutoff under 10 %, pay at least 6,000.01 DOP before Oct 13.');
    expect(ct).toContain('Add the due date');
    expect(cardsCard(html)).toContain('aria-label="20.0 % of the limit used; the marker is at 10 %"');
    expect(els(cardsCard(html), 'button').find((b) => b.role === 'switch')).toMatchObject({ 'aria-checked': 'true', 'aria-label': 'Card on: Visa' });
    const fixed = section(html, 'Fixed monthly expenses', 'By category');
    expect(text(fixed)).toContain('Visa from card');
    expect(fixed).toContain('aria-label="Paid: Visa"');
    expect(fixed).toContain('aria-label="Other charges on Visa"');
  });

  it('por debajo del 10 % el aviso es tranquilo; con día de pago, dice cuándo; en un mes que no es el último, no hay aviso', () => {
    const calm = text(cardsCard(render('2026-10', { state: owing([card('a', 'Visa', { limit: 60000, cutoffDay: 13, dueDay: 28 })], 3000) })));
    expect(calm).toContain('You owe 3,000.00 DOP · 5.0 % of limit');
    expect(calm).toContain('Under 10 % of the limit. Keep it there until the cutoff on Oct 13.');
    expect(calm).toContain('Payment due Oct 28 (in 21 days)');
    expect(calm).not.toContain('Add the due date');
    const past = text(cardsCard(render('2026-09', { state: owing([card('a', 'Visa', { limit: 60000, cutoffDay: 13 })]) })));
    expect(past).toContain('Visa');
    expect(past).not.toContain('To end the cutoff');
    expect(past).not.toContain('Add the due date');
  });

  it('sin límite o sin corte, en vez del aviso pide esos datos', () => {
    const ct = text(cardsCard(render('2026-10', { state: owing([card('a', 'Visa')]) })));
    expect(ct).toContain('Add a limit and a cutoff day to see how much to pay.');
    expect(ct).toContain('Limit — You owe 12,000.00 DOP Cutoff — Due —');
  });

  it('con tres tarjetas se ve una a la vez, con contador y flechas; sin flecha atrás en la primera', () => {
    const cards = [card('a', 'Visa'), card('b', 'Master'), card('c', 'Gold', { active: false })];
    const html = render('2026-10', { state: owing(cards, 0) });
    const box = cardsCard(html);
    expect(text(box)).toContain('Credit cards 1 / 3');
    expect(text(box)).toContain('Visa');
    expect(text(box)).not.toContain('Master');
    expect(els(box, 'div').filter((d) => d['data-testid'] === 'credit-card')).toHaveLength(1);
    const arrow = (label: string) => els(box, 'button').find((b) => b['aria-label'] === label);
    expect(arrow('Previous card')).toHaveProperty('disabled');
    expect(arrow('Next card')).toBeDefined();
    expect(arrow('Next card')).not.toHaveProperty('disabled');
    expect(box).toContain('role="region"');
    // Con una sola no hay contador, flechas ni región.
    const one = cardsCard(render('2026-10', { state: owing(cards.slice(0, 1), 0) }));
    expect(one).not.toContain('role="region"');
    expect(one).not.toContain('Next card');
    expect(text(one)).not.toContain(' / ');
    // La apagada no tiene fila en los gastos mensuales.
    expect(section(html, 'Fixed monthly expenses', 'By category')).not.toContain('Paid: Gold');
    expect(text(section(html, 'Fixed monthly expenses', 'By category'))).toContain('Master from card');
  });

  it('«Pagar con» ofrece la cuenta y cada tarjeta activa; el método de crédito elige la tarjeta en la transacción', () => {
    const cards = [card('a', 'Visa'), card('b', 'Master'), card('c', 'Gold', { active: false })];
    const html = render('2026-10', { state: owing(cards, 0) });
    const fixed = section(html, 'Fixed monthly expenses', 'By category');
    const select = fixed.match(/<select\b[^>]*aria-label="Pay with of Claude"[^>]*>(.*?)<\/select>/)![1]!;
    expect(els(select, 'option').map((o) => o.value)).toEqual(['account', 'card:a', 'card:b']);
    expect(text(select)).toBe(' Account Visa Master ');
    // Una fila nueva de transacción con método de crédito (el borrador nace en débito: aún sin selector de tarjeta).
    expect(section(html, '>Transaction history</h2>', '</table>')).not.toContain('Card of the new transaction');
  });
});
