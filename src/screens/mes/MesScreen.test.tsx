// La hoja "Mes" pintada a HTML en Node (sin DOM) con los datos de ejemplo: textos, cifras y modo de solo lectura.
// Las interacciones (escribir, agregar, borrar) no se prueban aquí; su lógica está en drafts.test.ts y rows.test.ts.
//
// Casi todo se comprueba en inglés (el idioma por defecto); al final, los mismos datos en español y en turco.
// Los datos de ejemplo están en inglés y son del usuario: no cambian con el idioma.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { seedState } from '../../../shared/seed';
import type { Account, AppState, ISODate, Language, MonthKey } from '../../../shared/types';
import { I18nProvider } from '../../i18n';
import { buildFinanzas, FinanzasContext } from '../../store';
import type { Actions, Finanzas } from '../../store';
import { MesScreen } from './MesScreen';

interface RenderOptions {
  /** Idioma del usuario (state.language). Fijo en inglés para no depender del de los datos de ejemplo. */
  lang?: Language;
  state?: AppState;
  draftDate?: ISODate;
  /** Idioma forzado con <I18nProvider>, como hace FinanzasProvider en la app. */
  provider?: Language;
}

function render(monthKey: MonthKey, { lang = 'en', state = seedState(), draftDate = '2026-10-07', provider }: RenderOptions = {}): string {
  state.language = lang;
  // El mismo valor que arma FinanzasProvider; solo la fecha de los borradores se fija aparte.
  const built = buildFinanzas({ user: { id: 'frank', name: 'Frank' }, state, monthKey, today: '2026-10-07', actions: {} as Actions });
  const value: Finanzas = { ...built!, draftDate };
  const screen = (
    <FinanzasContext value={value}>
      <MesScreen />
    </FinanzasContext>
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
    expect(html).not.toContain('disabled');
  });

  it('gastos mensuales: cabecera, columnas y filas en el orden de la hoja', () => {
    const card = section(html, 'Monthly expenses', 'By category');
    const ct = text(card);
    expect(ct).toContain('Monthly expenses 6 of 11 paid · total 42,025.57 DOP');
    expect(ct).toContain('Paid Item Day Amount Currency Account DOP USD');
    expect(els(card, 'table')).toEqual([expect.objectContaining({ 'aria-label': 'Monthly expenses' })]);

    const inputs = els(card, 'input');
    const boxes = inputs.filter((i) => i.type === 'checkbox');
    expect(boxes).toHaveLength(11);
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
    const card = section(html, 'Monthly expenses', 'By category');
    // Lo que se cobra en USD sale de la US account; el resto, de la DR account.
    expect(selected(card, 'Account of Claude')).toBe('us');
    expect(selected(card, 'Account of Electricity')).toBe('dr');
    expect(card).toContain('<option value="us" selected="">US account</option><option value="dr">DR account</option>');
    // 11 filas + la de agregar.
    expect(els(card, 'select').filter((x) => x['aria-label']?.startsWith('Account of'))).toHaveLength(12);
  });

  it('los gastos sin pagar van con el fondo de pendiente', () => {
    const card = section(html, 'Monthly expenses', 'By category');
    expect(els(card, 'tr').filter((tr) => /unpaid/.test(tr.class ?? ''))).toHaveLength(5);
  });

  it('gastos mensuales: fila para agregar al final', () => {
    const card = section(html, 'Monthly expenses', 'By category');
    const inputs = els(card, 'input');
    const last = inputs.slice(-3);
    expect(last[0]).toMatchObject({ type: 'text', value: '', placeholder: 'New monthly expense', style: 'min-width:120px', maxLength: '120' });
    expect(last[1]).toMatchObject({ type: 'text', value: '', placeholder: 'Day', 'aria-label': 'Day of the new expense', maxLength: '20' });
    expect(last[2]).toMatchObject({ type: 'number', value: '', placeholder: '0.00', 'aria-label': 'Amount of the new expense' });
    expect(els(card, 'select').at(-2)).toMatchObject({ 'aria-label': 'Currency of the new expense' });
    expect(els(card, 'select').at(-1)).toMatchObject({ 'aria-label': 'Account of the new expense' });
    // Arranca en la cuenta por defecto (DR account) y en su moneda.
    expect(selected(card, 'Account of the new expense')).toBe('dr');
    expect(selected(card, 'Currency of the new expense')).toBe('DOP');
    expect(els(card, 'td')).toContainEqual(expect.objectContaining({ colSpan: '3' }));
    // 11 × de las filas y, al final, "Add".
    expect(buttons(card)).toEqual([...Array<string>(11).fill('×'), 'Add']);
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

  it('tasas del mes: el par en uso, con su tasa escrita editable, y la fila para escribir otra', () => {
    const card = section(html, 'Month rates', 'Transfers');
    expect(bare(card)).toContain('Month rates From Rate To 1 USD = DOP × Add rate');
    expect(els(card, 'table')).toEqual([expect.objectContaining({ 'aria-label': 'Month rates' })]);
    const inputs = els(card, 'input');
    expect(inputs).toHaveLength(2);
    // La tasa escrita de octubre se corrige en su celda; no lleva nota de origen porque es la del mes.
    expect(inputs[0]).toMatchObject({ type: 'number', value: '58.76', 'aria-label': 'Rate USD → DOP' });
    expect(card).not.toContain('typed for this month');
    expect(card).not.toMatch(/warn/);
    expect(els(card, 'button')[0]).toMatchObject({ 'aria-label': 'Delete rate USD → DOP' });
    // Fila de agregar: par (todas las monedas) y tasa vacía.
    expect(inputs[1]).toMatchObject({ type: 'number', value: '', placeholder: '0.00', 'aria-label': 'New rate' });
    expect(selected(card, 'Currency the new rate converts from')).toBe('USD');
    expect(selected(card, 'Currency the new rate converts to')).toBe('DOP');
    expect([...card.matchAll(/<option /g)]).toHaveLength(6);
    expect(buttons(card)).toEqual(['×', 'Add rate']);
  });

  it('envíos: cada fila se edita en su sitio, con sus cuentas, su tasa y lo recibido', () => {
    const card = section(html, 'Transfers', 'Transaction history');
    expect(bare(card)).toContain('Transfers Date Via From Amount To Rate Received USD 88,140.00 DOP × Add');
    expect(els(card, 'table')).toEqual([expect.objectContaining({ style: 'min-width:640px', 'aria-label': 'Transfers' })]);
    const inputs = els(card, 'input');
    expect(inputs).toHaveLength(8);
    expect(inputs[0]).toMatchObject({ type: 'date', value: '2026-10-02', 'aria-label': 'Date of Remitly 02/10' });
    expect(inputs[1]).toMatchObject({ type: 'text', value: 'Remitly', maxLength: '60', 'aria-label': 'Via of Remitly 02/10' });
    expect(inputs[2]).toMatchObject({ type: 'number', value: '1500', 'aria-label': 'Amount of Remitly 02/10' });
    expect(inputs[3]).toMatchObject({ type: 'number', value: '58.76', 'aria-label': 'Rate of Remitly 02/10' });
    expect(selected(card, 'Account Remitly 02/10 leaves from')).toBe('us');
    expect(selected(card, 'Account Remitly 02/10 goes to')).toBe('dr');
    expect(buttons(card)).toEqual(['×', 'Add']);
    expect(els(card, 'button')[0]).toMatchObject({ 'aria-label': 'Delete transfer from 02/10' });
  });

  it('envíos: fila para agregar con las dos cuentas y la tasa del mes para sus monedas', () => {
    const card = section(html, 'Transfers', 'Transaction history');
    const inputs = els(card, 'input').slice(4);
    expect(inputs[0]).toMatchObject({ type: 'date', value: '2026-10-07', style: 'min-width:118px', 'aria-label': 'Date of the new transfer' });
    expect(inputs[2]).toMatchObject({
      type: 'number',
      value: '',
      placeholder: '500',
      style: 'min-width:64px',
      'aria-label': 'Amount of the new transfer',
    });
    expect(inputs[3]).toMatchObject({ type: 'number', value: '58.76', style: 'min-width:64px', 'aria-label': 'Rate of the new transfer' });
    expect(inputs[3]).not.toHaveProperty('readOnly');
    // La celda de la tasa es de esta pantalla (RateCell) y toma los estilos de las celdas de src/ui: se ve como la del monto.
    expect(inputs[3]!.class).toBeTruthy();
    expect(inputs[3]!.class).toBe(inputs[2]!.class);
    expect(inputs[3]).toMatchObject({ step: 'any', inputMode: 'decimal', autoComplete: 'off' });
    // Sin tocar: de la otra cuenta a la de por defecto.
    expect(selected(card, 'Account the new transfer leaves from')).toBe('us');
    expect(selected(card, 'Account the new transfer goes to')).toBe('dr');
    expect(els(card, 'td')).toContainEqual(expect.objectContaining({ colSpan: '2' }));
  });

  it('envíos: la vía es un campo de texto libre con sugerencias, que arranca en Remitly', () => {
    const card = section(html, 'Transfers', 'Transaction history');
    const via = els(card, 'input')[5]!;
    expect(via).toMatchObject({
      type: 'text',
      value: 'Remitly',
      placeholder: 'Remitly',
      maxLength: '60',
      style: 'min-width:84px',
      'aria-label': 'Via of the new transfer',
    });
    // Cada campo de vía apunta a su <datalist>: las vías de siempre (agosto ya usó las dos).
    expect(via.list).toBeTruthy();
    expect(els(card, 'datalist').map((d) => d.id)).toContain(via.list);
    expect(offered(card)).toEqual(['Remitly', 'PayPal']);
  });

  it('historial: cabecera, fila para agregar arriba y transacciones de la más reciente a la más antigua', () => {
    const card = section(html, 'Transaction history', 'Closing the month');
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
    expect(buttons(card)).toEqual(['Add', ...Array<string[]>(7).fill(['⋯', '×']).flat()]);
    // El diálogo solo se monta al abrirlo.
    expect(card).not.toContain('<textarea');
    expect(card).not.toContain('role="dialog"');
    // El borrador arranca en Food / Card, en la cuenta por defecto y en su moneda, con todas las categorías, métodos, monedas y cuentas.
    const draftRow = section(card, '<tbody>', '</tr>');
    expect(draftRow).toContain('<option value="Food" selected="">Food</option><option value="Groceries">Groceries</option>');
    expect(draftRow).toContain(
      '<option value="Card" selected="">Card</option><option value="Transfer">Transfer</option><option value="Bank app">Bank app</option>',
    );
    expect([...draftRow.matchAll(/<option /g)]).toHaveLength(10 + 3 + 3 + 2);
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
    expect(draftDate(section(html, 'Transfers', 'Transaction history'), 'Date of the new transfer')).toBe('2026-09-01');
    expect(draftDate(section(html, 'Transaction history'), 'Date of the new transaction')).toBe('2026-09-01');
  });

  it('la tasa del borrador de envío es la del mes, a dos decimales', () => {
    // Septiembre no tiene tasa escrita: el promedio ponderado de sus envíos.
    const card = section(render('2026-09', { state: reopened(), draftDate: '2026-09-01' }), 'Transfers', 'Transaction history');
    expect(els(card, 'input').at(-1)).toMatchObject({ type: 'number', value: '58.57', 'aria-label': 'Rate of the new transfer' });
  });

  it('una tasa redonda conserva sus dos decimales en el campo (58.70, no 58.7)', () => {
    const state = seedState();
    state.months['2026-10']!.rates[0]!.rate = 58.7;
    const html = render('2026-10', { state });
    expect(els(section(html, 'Month rates', 'Transfers'), 'input')[0]).toMatchObject({ type: 'number', value: '58.70' });
    expect(els(section(html, 'Transfers', 'Transaction history'), 'input').at(-1)).toMatchObject({ type: 'number', value: '58.70' });
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

  it('las sugerencias de vía suman las ya usadas hasta ese mes, sin las de meses posteriores', () => {
    const state = reopened();
    state.months['2026-08']!.transfers[1]!.via = 'Western Union';
    state.months['2026-09']!.transfers[1]!.via = 'Wise';
    state.months['2026-10']!.transfers[0]!.via = 'Zelle';
    const september = section(render('2026-09', { state, draftDate: '2026-09-01' }), 'Transfers', 'Transaction history');
    expect(offered(september)).toEqual(['Remitly', 'PayPal', 'Wise', 'Western Union']);
    // Las filas existentes enseñan su vía en su campo, sea cual sea.
    expect(els(september, 'input')).toContainEqual(expect.objectContaining({ type: 'text', value: 'Wise', 'aria-label': 'Via of Wise 17/09' }));
    expect(bare(september)).toContain('USD 46,896.00 DOP');
    const october = section(render('2026-10', { state }), 'Transfers', 'Transaction history');
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
    expect(buttons(html)).toEqual(['Reopen month', ...Array<string>(10).fill('⋯'), 'Delete month']);
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
    expect(boxes).toHaveLength(11);
    expect(boxes.every((b) => 'disabled' in b && 'checked' in b)).toBe(true);
    // 11 fijos × (concepto, día, monto) + 2 envíos × (fecha, vía, monto, tasa) + 10 transacciones × (fecha, descripción, lugar, monto, notas).
    expect(fields).toHaveLength(11 * 3 + 2 * 4 + 10 * 5);
    expect(fields.every((f) => 'readOnly' in f)).toBe(true);
    const selects = els(html, 'select');
    // 11 fijos × (moneda, cuenta) + 2 envíos × (origen, destino) + 10 × (categoría, método, moneda, cuenta).
    expect(selects).toHaveLength(11 * 2 + 2 * 2 + 10 * 4);
    expect(selects.every((s) => 'disabled' in s)).toBe(true);
  });

  it('conserva las cifras del mes', () => {
    expect(t).toContain('Monthly expenses 11 of 11 paid · total 42,081.54 DOP');
    expect(bare(html)).toContain('Transfers Date Via From Amount To Rate Received USD 87,825.00 DOP USD 46,896.00 DOP');
    const transfers = els(section(html, 'Transfers', 'Transaction history'), 'input');
    expect(transfers.map((i) => i.value)).toEqual(['2026-09-02', 'Remitly', '1500', '58.55', '2026-09-17', 'Remitly', '800', '58.62']);
    expect(t).toContain('Transaction history 10 transactions · total 24,555.00 DOP');
  });

  it('tasas del mes: sin tasa escrita, dice de dónde sale y no se puede tocar', () => {
    const card = section(html, 'Month rates', 'Transfers');
    // 1,500 a 58.55 y 800 a 58.62.
    expect(text(card).replace(/&#x27;/g, "'")).toContain("Month rates From Rate To 1 USD = 58.57 DOP from this month's transfers");
    expect(els(card, 'input')).toEqual([]);
    expect(els(card, 'select')).toEqual([]);
    expect(buttons(card)).toEqual([]);
    expect(card).not.toMatch(/warn/);
  });

  it('pasado de presupuesto, "Vs. budget" cambia de color', () => {
    const state = seedState();
    state.months['2026-09']!.budgets = { dr: 60000 };
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
    expect(t).toContain('Monthly expenses 0 of 0 paid · total 0.00 DOP');
    expect(t).toContain('By category DOP No expenses yet this month.');
    expect(t).toContain('Transaction history 0 transactions · total 0.00 DOP');
    expect(t).toContain('Close October 2026 Delete month');
  });

  it('mes sin tasa escrita ni envíos: la tasa es la del mes anterior, y se dice', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { rates: [], transfers: [] });
    const html = render('2026-10', { state });
    const card = section(html, 'Month rates', 'Transfers');
    expect(bare(card)).toContain('1 USD = 58.57 DOP from September 2026');
    expect(card).not.toMatch(/warn/);
    // No está escrita: no hay nada que corregir ni que quitar, solo la fila para escribirla.
    expect(els(card, 'input')).toHaveLength(1);
    expect(buttons(card)).toEqual(['Add rate']);
    // El borrador de envío la propone.
    expect(els(html, 'input').find((i) => i['aria-label'] === 'Rate of the new transfer')).toMatchObject({ value: '58.57' });
  });

  it('una tasa que nadie ha escrito nunca sale del valor de respaldo, y se avisa', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY'));
    const card = section(render('2026-10', { state }), 'Month rates', 'Transfers');
    const ct = bare(card);
    expect(ct).toContain('1 USD = DOP ×');
    // 58.76 DOP y 42 TRY por dólar, los valores fijos.
    expect(ct).toContain('1 TRY = 1.40 DOP default value, not set yet');
    expect(ct).toContain('1 USD = 42.00 TRY default value, not set yet');
    expect(els(card, 'span').filter((x) => /warn/.test(x.class ?? ''))).toHaveLength(2);
    // La fila de agregar propone la primera que falta.
    expect(selected(card, 'Currency the new rate converts from')).toBe('TRY');
    expect(selected(card, 'Currency the new rate converts to')).toBe('DOP');
  });

  it('una tasa cruzada por la tercera moneda lo dice', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY'));
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40 });
    const card = section(render('2026-10', { state }), 'Month rates', 'Transfers');
    // 58.76 / 40 = 1.469.
    expect(bare(card)).toContain('1 TRY = 1.47 DOP crossed through USD');
    expect(els(card, 'input').map((i) => i['aria-label'])).toEqual(['Rate USD → DOP', 'Rate USD → TRY', 'New rate']);
    expect(card).not.toMatch(/warn/);
  });

  it('con otras monedas: las columnas, los totales y las categorías van en la principal y la segunda del usuario', () => {
    const state = seedState();
    state.mainCurrency = 'USD';
    state.secondCurrency = 'TRY';
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40 });
    const html = render('2026-10', { state });
    const t = text(html);
    expect(t).toContain('Paid Item Day Amount Currency Account USD TRY');
    expect(t).toContain('Date Name Place Category Method Amount Cur. Account USD TRY Description');
    // 42,025.57 DOP / 58.76.
    expect(t).toContain('Monthly expenses 6 of 11 paid · total 715.21 USD');
    expect(t).toContain('Transaction history 7 transactions · total 184.56 USD');
    expect(t).toContain('By category USD Fixed expenses 652');
    // Claude: 106 USD = 4,240 TRY.
    expect(bare(html)).toContain('106.00 4,240.00');
    // Las tres monedas están en uso: el par de la barra (TRY → USD) primero, en el sentido en que se escribió.
    const rates = section(html, 'Month rates', 'Transfers');
    expect(els(rates, 'input').map((i) => i['aria-label'])).toEqual(['Rate USD → TRY', 'Rate USD → DOP', 'New rate']);
    expect(bare(rates)).toContain('1 TRY = 1.47 DOP crossed through USD');
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
    expect(bare(section(html, 'Month rates', 'Transfers'))).not.toContain('TRY');
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
    });
    const card = section(render('2026-10', { state }), 'Transfers', 'Transaction history');
    const rate = els(card, 'input').find((i) => i['aria-label'] === 'Rate of PayPal 05/10')!;
    expect(rate).toMatchObject({ value: '1.00' });
    expect(rate).toHaveProperty('readOnly');
    expect(els(card, 'input').find((i) => i['aria-label'] === 'Rate of Remitly 02/10')).not.toHaveProperty('readOnly');
    expect(bare(card)).toContain('USD 200.00 USD');
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
    const card = section(render('2026-10', { state }), 'Monthly expenses', 'By category');
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
    coffee.method = 'Cash';
    const html = render('2026-10', { state });
    const card = section(html, 'Transaction history', 'Closing the month');
    // Van al final de su lista y son la opción seleccionada; el resto de las filas no las ofrece.
    expect(card).toContain('<option value="Travel">Travel</option><option value="Pets" selected="">Pets</option></select>');
    expect(card).toContain('<option value="Bank app">Bank app</option><option value="Cash" selected="">Cash</option></select>');
    expect([...card.matchAll(/value="Pets"/g)]).toHaveLength(1);
    expect([...card.matchAll(/value="Cash"/g)]).toHaveLength(1);
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

describe('en español', () => {
  const html = render('2026-10', { lang: 'es' });
  const t = text(html);

  it('títulos, columnas y metas con sus cifras', () => {
    expect(t).toContain('Gastos mensuales 6 de 11 pagados · total 42,025.57 DOP');
    expect(t).toContain('Pagado Concepto Día Monto Moneda Cuenta DOP USD');
    expect(t).toContain('Tasas del mes Desde Tasa Hacia 1 USD =');
    expect(t).toContain('Envíos Fecha Vía Desde Monto Hacia Tasa Recibido');
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
    const card = bare(section(render('2026-10', { lang: 'es', state }), 'Tasas del mes', 'Envíos'));
    expect(card).toContain('1 USD = 58.57 DOP de septiembre 2026');
    expect(card).toContain('1 USD = 42.00 TRY valor por defecto, aún sin definir');
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
      '<option value="Card" selected="">Tarjeta</option><option value="Transfer">Transferencia</option><option value="Bank app">App del banco</option>',
    );
    // Ningún nombre traducido se cuela como valor.
    expect(html).not.toContain('value="Comida"');
    expect(html).not.toContain('value="Tarjeta"');
  });

  it('un valor de fuera de la lista sale tal cual, sin traducir', () => {
    const state = seedState();
    const coffee = state.months['2026-10']!.tx.find((x) => x.desc === 'Coffee')!;
    coffee.cat = 'Pets';
    coffee.method = 'Cash';
    const out = render('2026-10', { lang: 'es', state });
    expect(out).toContain('<option value="Travel">Viajes</option><option value="Pets" selected="">Pets</option></select>');
    expect(out).toContain('<option value="Bank app">App del banco</option><option value="Cash" selected="">Cash</option></select>');
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
      'Remitly',
      '500',
      'Nueva transacción',
      'Lugar',
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
        'Tasa USD → DOP',
        'Eliminar tasa USD → DOP',
        'Nueva tasa',
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
    expect(new Set(buttons(html))).toEqual(new Set(['×', '⋯', 'Agregar', 'Agregar tasa', 'Cerrar Octubre 2026', 'Eliminar mes']));
    expect(els(html, 'button')).toContainEqual(expect.objectContaining({ title: 'Eliminar' }));
  });

  it('mes sin datos y mes cerrado', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { fixed: [], transfers: [], tx: [] });
    const empty = text(render('2026-10', { lang: 'es', state }));
    expect(empty).toContain('Gastos mensuales 0 de 0 pagados · total 0.00 DOP');
    expect(empty).toContain('Por categoría DOP Aún no hay gastos este mes.');
    expect(empty).toContain('Historial de transacciones 0 transacciones · total 0.00 DOP');

    const closed = render('2026-09', { lang: 'es' });
    expect(text(closed)).toContain(
      'Resumen de Septiembre 2026 Mes cerrado. Los registros quedan de solo lectura. Importes en DOP Ingreso 339,731 Gastado 66,636.54 Ahorrado 205,010 Vs. presupuesto 3,363.46 Reabrir mes',
    );
    expect(buttons(closed)).toEqual(['Reabrir mes', ...Array<string>(10).fill('⋯'), 'Eliminar mes']);
  });
});

describe('en turco', () => {
  const html = render('2026-10', { lang: 'tr' });
  const t = text(html);

  it('títulos, columnas y metas con sus cifras', () => {
    expect(t).toContain('Aylık giderler 6 / 11 ödendi · toplam 42,025.57 DOP');
    expect(t).toContain('Ödendi Kalem Gün Tutar Para birimi Hesap DOP USD');
    expect(t).toContain('Ay kurları Nereden Kur Nereye 1 USD =');
    expect(t).toContain('Transferler Tarih Kanal Nereden Tutar Nereye Kur Alınan');
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
    const card = bare(section(render('2026-10', { lang: 'tr', state }), 'Ay kurları', 'Transferler'));
    expect(card).toContain('1 USD = 58.57 DOP Eylül 2026 ayından');
    expect(card).toContain('1 USD = 42.00 TRY varsayılan değer, henüz girilmedi');
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
      '<option value="Card" selected="">Kart</option><option value="Transfer">Havale</option><option value="Bank app">Banka uygulaması</option>',
    );
  });

  it('etiquetas, botones y números: los números no cambian de formato', () => {
    const inputs = els(html, 'input');
    expect(placeholders(inputs)).toEqual([
      'Yeni aylık gider',
      'Gün',
      '0.00',
      '0.00',
      'Remitly',
      '500',
      'Yeni işlem',
      'Yer',
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
        'Kur USD → DOP',
        'Yeni kur',
        'Tarih: Coffee',
        'Açıklama: Coffee',
        'Yeni işlemin açıklaması',
        'Coffee açıklamasını aç',
      ]),
    );
    expect(new Set(buttons(html))).toEqual(new Set(['×', '⋯', 'Ekle', 'Kur ekle', 'Ekim 2026 ayını kapat', 'Ayı sil']));
    expect(t).toContain('88,140.00 DOP');
    expect(t).toContain('6,228.56 106.00');
  });

  it('mes sin datos y mes cerrado', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { fixed: [], transfers: [], tx: [] });
    const empty = text(render('2026-10', { lang: 'tr', state }));
    expect(empty).toContain('Aylık giderler 0 / 0 ödendi · toplam 0.00 DOP');
    expect(empty).toContain('Kategoriye göre DOP Bu ay henüz gider yok.');

    const closed = render('2026-09', { lang: 'tr' });
    expect(text(closed)).toContain(
      'Eylül 2026 özeti Ay kapalı. Kayıtlar salt okunur. Tutarlar DOP cinsinden Gelir 339,731 Harcanan 66,636.54 Biriken 205,010 Bütçeye göre 3,363.46 Ayı yeniden aç',
    );
    expect(buttons(closed)).toEqual(['Ayı yeniden aç', ...Array<string>(10).fill('⋯'), 'Ayı sil']);
  });
});

describe('de dónde sale el idioma', () => {
  it('manda <I18nProvider> (el de la app) sobre el idioma del estado', () => {
    const t = text(render('2026-10', { lang: 'en', provider: 'tr' }));
    expect(t).toContain('Aylık giderler 6 / 11 ödendi');
    expect(t).not.toContain('Monthly expenses');
  });

  it('cambiar de idioma no deja textos del anterior', () => {
    // Textos de la interfaz de cada idioma que no coinciden con ningún dato de ejemplo.
    const own: Record<Language, string[]> = {
      en: ['Monthly expenses', 'By category', 'Transaction history', 'Month rates', 'Closing the month', 'New transaction'],
      es: ['Gastos mensuales', 'Por categoría', 'Historial de transacciones', 'Tasas del mes', 'Al cerrar el mes', 'Nueva transacción'],
      tr: ['Aylık giderler', 'Kategoriye göre', 'İşlem geçmişi', 'Ay kurları', 'Ay kapatıldığında', 'Yeni işlem'],
    };
    for (const lang of ['en', 'es', 'tr'] as const) {
      const html = render('2026-10', { lang });
      for (const [other, texts] of Object.entries(own)) {
        for (const piece of texts) expect(html.includes(piece), `"${piece}" en ${lang}`).toBe(other === lang);
      }
    }
  });
});
