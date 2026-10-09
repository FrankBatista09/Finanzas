// Prueba de humo: los componentes comunes se pintan con los datos de ejemplo y enseñan las cifras de shared/calc.ts,
// con los textos de cada idioma. Se renderiza a HTML en Node (sin DOM): no se prueban interacciones, solo que el
// marcado, los textos y los cálculos casan.

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { balances, monthCalc } from '../../shared/calc';
import { f0, f2 } from '../../shared/format';
import { seedState, setBudgets } from '../../shared/seed';
import { THEME_PRESETS } from '../../shared/theme';
import type { AppState, AppUser, BudgetEntry, Income, Language, MonthKey } from '../../shared/types';
import { I18nProvider } from '../i18n';
import { buildFinanzas, FinanzasContext, ShellContext } from '../store';
import type { Actions, Finanzas, Shell } from '../store';
import { ringShades } from '../theme';
import {
  AddButton,
  AddRow,
  AddRowsOpenContext,
  CellCheckbox,
  CellDate,
  CellNumber,
  CellSelect,
  CellText,
  CheckField,
  DeleteButton,
  Dialog,
  DialogButton,
  DialogFields,
  Field,
  Input,
  MonthPicker,
  Select,
  SheetTable,
  Td,
  Th,
  Tr,
} from '../ui';
import { BottomTabs } from './BottomTabs';
import { CloseMonthModal } from './CloseMonthModal';
import { DeleteMonthModal } from './DeleteMonthModal';
import { Notices } from './Notices';
import { SettingsPanel } from './SettingsPanel';
import { SummaryPanel } from './SummaryPanel';
import { DownloadExcelDialog, toggleMonth, TopBar } from './TopBar';

const FRANK: AppUser = { id: 'frank', name: 'Frank' };
const EDA: AppUser = { id: 'eda', name: 'Eda' };

function finanzas(monthKey: MonthKey, state: AppState = seedState(), user: AppUser = FRANK): Finanzas {
  return buildFinanzas({ user, state, monthKey, today: '2026-10-07', actions: {} as Actions })!;
}

const shell = (over: Partial<Shell> = {}): Shell => ({
  status: 'ready',
  retry: () => {},
  retrying: false,
  users: [FRANK, EDA],
  user: FRANK,
  goToUser: () => {},
  language: 'en',
  sheet: 'mes',
  goToSheet: () => {},
  goToMonth: () => {},
  devTools: false,
  excelStatus: null,
  closeDialog: null,
  confirmClose: () => {},
  cancelClose: () => {},
  deleteDialog: null,
  confirmDelete: () => {},
  cancelDelete: () => {},
  notices: [],
  dismissNotice: () => {},
  ...over,
});

interface Opts {
  monthKey?: MonthKey;
  lang?: Language;
  shell?: Partial<Shell>;
  state?: AppState;
  user?: AppUser;
  /** Las filas de agregar: abiertas (como tras pulsar su "+ Add …") salvo que se pida false, que es como nace la pantalla. */
  addRows?: boolean;
}

function render(node: ReactNode, { monthKey = '2026-10', lang = 'en', shell: over, state, user, addRows = true }: Opts = {}): string {
  return renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <ShellContext value={shell(over)}>
        <AddRowsOpenContext value={addRows}>
          <FinanzasContext value={finanzas(monthKey, state, user)}>{node}</FinanzasContext>
        </AddRowsOpenContext>
      </ShellContext>
    </I18nProvider>,
  );
}

/** Texto visible, sin etiquetas. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

/** Atributos de cada <tag> del HTML, sin depender del orden en que React los escribe. */
function els(html: string, tag: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) =>
    Object.fromEntries([...m[1]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!, a[2] ?? ''])),
  );
}

const has = (list: Record<string, string>[], attrs: Record<string, string>) => expect(list).toContainEqual(expect.objectContaining(attrs));

/** Texto de cada <button>, en orden. */
const buttonTexts = (html: string) => [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]!).trim());

/** Los datos de ejemplo con la lira como moneda principal y sus tasas escritas (las de shared/calc.test.ts). */
function tryState(): AppState {
  const s = seedState();
  s.mainCurrency = 'TRY';
  s.secondCurrency = 'USD';
  s.months['2026-10']!.rates = [
    { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
    { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' },
  ];
  return s;
}

/** Un movimiento del registro del presupuesto de octubre, en la DR account. */
const logEntry = (over: Partial<BudgetEntry> & Pick<BudgetEntry, 'id' | 'amount' | 'kind'>): BudgetEntry => ({
  date: '2026-10-07',
  accountId: 'dr',
  note: '',
  ...over,
});

/** Un ingreso de octubre con la casilla "Adds to budget", en la DR account. */
const budgetIncome = (over: Partial<Income> & Pick<Income, 'id' | 'amount'>): Income => ({
  date: '2026-10-03',
  desc: 'Refund',
  accountId: 'dr',
  cur: 'DOP',
  budget: true,
  ...over,
});

/** Los datos de ejemplo con una tercera cuenta en liras (visible) y una vieja, oculta y sin usar. */
function manyAccounts(): AppState {
  const s = seedState();
  s.accounts.push(
    { id: 'tr', name: 'TR account', currency: 'TRY', opening: 21000, hidden: false, sort: 2 },
    { id: 'old', name: 'Old savings', currency: 'USD', opening: 75, hidden: true, sort: 3 },
  );
  s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 42, date: '2026-10-01' });
  return s;
}

describe('SummaryPanel · Month: el presupuesto', () => {
  const panel = (opts: Opts = {}) => render(<SummaryPanel sheet="mes" />, opts);

  it('October 2026: las cifras de shared/calc.ts, en la moneda principal y en la segunda', () => {
    const html = panel();
    const t = text(html);
    // La primera tarjeta es el presupuesto: total, "≈" y una fila por cuenta con su parte.
    expect(t).toContain('Budget 70,000.00 DOP ≈ 1,191.29 USD');
    expect(t).toContain('US account');
    expect(t).toContain('DR account');
    expect(t).toContain('Month income − used 291,658.29 DOP');
    expect(t).toContain('Used 49,150 of 70,000 DOP');
    expect(t).toContain('Budget used Fixed paid 38,305 Transactions 10,845.00 Fixed pending 3,721 Free 17,129');
    expect(t).toContain('October 2026 Planned budget 70,000.00');
    expect(t).toContain('Used so far 49,149.71 Available 20,850.29 Available after pending fixed 17,129.43 Used in USD 836.45 USD');
    has(els(html, 'section'), { 'aria-label': 'October 2026 summary' });
    has(els(html, 'svg'), { 'aria-label': 'Budget used: 49,150 of 70,000 DOP' });
    has(els(html, 'table'), { 'aria-label': 'Budget' });
  });

  it('una fila por cuenta con parte, con su parte editable, su moneda y su ×; el presupuesto planeado ya no se escribe', () => {
    const html = panel();
    // Solo las partes son campos (más el monto de la fila de agregar): "Planned budget" es su suma.
    // La US account existe y está visible, pero sin parte este mes no tiene fila.
    const inputs = els(html, 'input');
    expect(inputs.map((i) => [i.type, i.value, i['aria-label']])).toEqual([
      ['number', '70000', 'Budget from DR account, in DOP'],
      ['number', '', 'Amount of the new budget part'],
    ]);
    expect(inputs.every((i) => i.step === 'any')).toBe(true);
    expect(html).not.toContain('readOnly');
    const rows = [...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => text(m[1]!).trim());
    expect(rows).toEqual(['DR account DOP ×', 'US account New account… USD Add']);
    // La × quita la cuenta del presupuesto (deja su parte en 0). Debajo de la tabla, el sobrante y el historial.
    expect(buttonTexts(html)).toEqual(['×', 'Add', 'Cancel', 'Add to budget', 'Budget history']);
    has(els(html, 'button'), { 'aria-label': 'Remove DR account from the budget' });
  });

  it('la fila de agregar: las cuentas visibles que aún no están en el presupuesto, "New account…" al final, el monto y "Add"', () => {
    const html = panel();
    expect(els(html, 'select')).toEqual([expect.objectContaining({ 'aria-label': 'Account to add to the budget' })]);
    // Arranca en la primera cuenta libre, y enseña su moneda.
    expect(html).toContain('<option value="us" selected="">US account</option><option value="__new__">New account…</option></select>');
    has(els(html, 'input'), { placeholder: '0.00', value: '', 'aria-label': 'Amount of the new budget part' });

    // Con varias cuentas libres salen todas las visibles, en su orden; la oculta (sin parte) no se ofrece.
    const many = panel({ state: manyAccounts() });
    expect(many).toContain(
      '<option value="us" selected="">US account</option><option value="tr">TR account</option><option value="__new__">New account…</option></select>',
    );
    expect(many).not.toContain('Old savings');

    // Con todas las visibles ya en el presupuesto solo queda "New account…", que lleva a Savings.
    const state = seedState();
    setBudgets(state.months['2026-10']!, { us: 200, dr: 58248 });
    const full = panel({ state });
    // Un select de una sola opción no dispararía nada: ahí va un botón.
    expect(els(full, 'option')).toHaveLength(0);
    expect(buttonTexts(full)).toEqual(['×', '×', 'New account…', 'Add', 'Cancel', 'Add to budget', 'Budget history']);
    has(els(full, 'button'), { 'aria-label': 'Remove US account from the budget' });
  });

  it('las partes en otra moneda suman convertidas con la tasa del mes; una cuenta oculta con parte sigue a la vista', () => {
    const state = seedState();
    setBudgets(state.months['2026-10']!, { us: 200, dr: 58248 });
    const c = monthCalc(state, '2026-10');
    expect(text(panel({ state }))).toContain(`Budget ${f2(c.budget)} DOP ≈ ${f2(c.budgetSecond)} USD`);
    expect(f2(c.budget)).toBe('70,000.00');

    // La US account se oculta: con parte, su fila se queda (suma al total); sin parte, desaparece.
    state.accounts.find((a) => a.id === 'us')!.hidden = true;
    const withPart = panel({ state });
    expect(els(withPart, 'input').map((i) => i['aria-label'])).toEqual([
      'Budget from US account, in USD',
      'Budget from DR account, in DOP',
      'Amount of the new budget part',
    ]);
    // También la oculta se puede quitar del presupuesto.
    has(els(withPart, 'button'), { 'aria-label': 'Remove US account from the budget' });
    setBudgets(state.months['2026-10']!, { dr: 70000 });
    const withoutPart = panel({ state });
    expect(els(withoutPart, 'input').map((i) => i['aria-label'])).toEqual(['Budget from DR account, in DOP', 'Amount of the new budget part']);
    // Y, oculta, tampoco se ofrece para agregarla.
    expect(els(withoutPart, 'option')).toHaveLength(0);
    expect(buttonTexts(withoutPart)).toContain('New account…');
  });

  it('con la lira como moneda principal, todo el panel va en TRY y la línea "≈" en USD', () => {
    const state = tryState();
    const c = monthCalc(state, '2026-10');
    const html = panel({ state });
    const t = text(html);
    // 70,000 DOP / 58.76 × 40
    expect(f2(c.budget)).toBe('47,651.46');
    expect(t).toContain('Budget 47,651.46 TRY ≈ 1,191.29 USD');
    expect(t).toContain(`Month income − used ${f2(c.incomeLeft)} TRY`);
    expect(t).toContain(`Used ${f0(c.used)} of ${f0(c.budget)} TRY`);
    expect(t).toContain(`Fixed paid ${f0(c.fixedPaid)} Transactions ${f2(c.varSpent)} Fixed pending ${f0(c.pending)} Free ${f0(c.free)}`);
    expect(t).toContain(`Planned budget ${f2(c.budget)} Used so far ${f2(c.used)} Available ${f2(c.avail)}`);
    expect(t).toContain('Used in USD 836.45 USD');
    has(els(html, 'svg'), { 'aria-label': `Budget used: ${f0(c.used)} of ${f0(c.budget)} TRY` });
    // Las partes siguen en la moneda de su cuenta: lo guardado no se convierte.
    // (La US account, sin parte, ya no tiene fila; el último campo es el monto vacío de la fila de agregar.)
    expect(els(html, 'input').map((i) => i.value)).toEqual(['70000', '']);
    expect(t).toContain('DR account DOP');
    expect(t).not.toContain('DOP ≈');
  });

  it('en español conserva, palabra por palabra, los textos de la versión 1', () => {
    const html = panel({ lang: 'es' });
    const t = text(html);
    expect(t).toContain('Presupuesto 70,000.00 DOP ≈ 1,191.29 USD');
    expect(t).toContain('Ingreso del mes − usado 291,658.29 DOP');
    expect(t).toContain('Usado 49,150 de 70,000 DOP');
    expect(t).toContain('Fijos pagados 38,305 Transacciones 10,845.00 Fijos pendientes 3,721 Libre 17,129');
    expect(t).toContain('Octubre 2026 Presupuesto planeado 70,000.00');
    expect(t).toContain('Usado hasta hoy 49,149.71 Disponible 20,850.29 Disponible tras fijos pendientes 17,129.43 Usado en USD 836.45 USD');
    const inputs = els(html, 'input');
    has(inputs, { 'aria-label': 'Presupuesto de DR account, en DOP' });
    // La US account solo tiene campo cuando tiene parte en el presupuesto del mes.
    expect(inputs.map((i) => i['aria-label'])).not.toContain('Presupuesto de US account, en USD');
    const state = seedState();
    setBudgets(state.months['2026-10']!, { us: 200, dr: 58248 });
    has(els(panel({ lang: 'es', state }), 'input'), { 'aria-label': 'Presupuesto de US account, en USD' });
    // Lo nuevo: quitar una cuenta del presupuesto y la fila para sumar otra.
    has(inputs, { 'aria-label': 'Monto de la nueva parte del presupuesto' });
    has(els(html, 'select'), { 'aria-label': 'Cuenta que se suma al presupuesto' });
    has(els(html, 'button'), { 'aria-label': 'Quitar DR account del presupuesto' });
    expect(html).toContain('<option value="__new__">Cuenta nueva…</option>');
    expect(buttonTexts(html)).toEqual(['×', 'Agregar', 'Cancelar', 'Sumar al presupuesto', 'Historial del presupuesto']);
    has(els(html, 'section'), { 'aria-label': 'Resumen de Octubre 2026' });
    has(els(html, 'svg'), { 'aria-label': 'Presupuesto usado: 49,150 de 70,000 DOP' });
  });

  it('en turco: los términos acordados y las mismas cifras, con el mismo formato', () => {
    const html = panel({ lang: 'tr' });
    const t = text(html);
    has(els(html, 'input'), { 'aria-label': 'Yeni bütçe payının tutarı' });
    has(els(html, 'select'), { 'aria-label': 'Bütçeye eklenecek hesap' });
    has(els(html, 'button'), { 'aria-label': 'DR account hesabını bütçeden çıkar' });
    expect(html).toContain('<option value="__new__">Yeni hesap…</option>');
    expect(t).toContain('Bütçe 70,000.00 DOP ≈ 1,191.29 USD');
    // Los nombres de las cuentas los escribe el usuario: no se traducen.
    expect(t).toContain('US account');
    expect(t).toContain('Kullanılan 49,150 / 70,000 DOP');
    expect(t).toContain('İşlemler 10,845.00');
    expect(t).toContain('Ekim 2026 Planlanan bütçe 70,000.00');
    expect(t).toContain('Kalan 20,850.29');
    expect(t).toContain('USD olarak kullanılan 836.45 USD');
  });

  it('la dona pinta fondo, pendientes, fijos y transacciones, en ese orden', () => {
    const html = panel();
    const circles = els(html, 'circle');
    expect(circles.map((c) => c.style)).toEqual([
      'stroke:var(--donut-free)',
      'stroke:var(--donut-pending)',
      'stroke:var(--donut-fixed)',
      'stroke:var(--accent)',
    ]);
    expect(circles.every((c) => c.cx === '84' && c.cy === '84' && c.r === '64' && c['stroke-width'] === '20' && c.fill === 'none')).toBe(true);
    has(els(html, 'svg'), { viewBox: '0 0 168 168', width: '168', height: '168' });
    // El fondo no lleva trazo discontinuo; fijos pagados arranca en 0 y transacciones donde acaban los fijos.
    const [track, pending, fixed, variable] = circles;
    expect(track!['stroke-dasharray']).toBeUndefined();
    expect(fixed!['stroke-dashoffset']).toBe('0');
    const len = (c: Record<string, string>) => +c['stroke-dasharray']!.split(' ')[0]!;
    expect(+variable!['stroke-dashoffset']!).toBeCloseTo(-len(fixed!), 8);
    expect(+pending!['stroke-dashoffset']!).toBeCloseTo(-(len(fixed!) + len(variable!)), 8);
  });

  it('en un mes cerrado las partes del presupuesto son de solo lectura: sin × y sin fila de agregar', () => {
    const html = panel({ monthKey: '2026-09' });
    // Solo la parte de la DR account: la US account no tiene parte en septiembre.
    expect(els(html, 'input').map((i) => i['aria-label'])).toEqual(['Budget from DR account, in DOP']);
    expect(els(html, 'input').filter((i) => 'readOnly' in i)).toHaveLength(1);
    expect(els(html, 'select')).toEqual([]);
    // Lo único que se puede pulsar es el historial, que solo se despliega.
    expect(buttonTexts(html)).toEqual(['Budget history']);
    expect(text(html)).not.toContain('New account…');
    expect(text(html)).toContain('September 2026 Planned budget 70,000.00');
  });

  it('pasado de presupuesto, el centro y el disponible van en rojo', () => {
    const state = seedState();
    setBudgets(state.months['2026-10']!, { dr: 40000 });
    const html = panel({ state });
    expect(text(html)).toContain('Available -9,149.71');
    expect([...html.matchAll(/errorText/g)].length).toBeGreaterThanOrEqual(3);
  });

  it('la × de una cuenta solo sale si su parte viene del registro: lo que ponen los ingresos no se quita desde aquí', () => {
    const state = seedState();
    // Un ingreso que sube el presupuesto y entra a la US account, que no tiene parte en el registro.
    state.incomes.push(budgetIncome({ id: 'in-us', amount: 50, cur: 'USD', accountId: 'us' }));
    const html = panel({ state });
    expect(els(html, 'input').map((i) => [i.value, i['aria-label']])).toEqual([
      ['50', 'Budget from US account, in USD'],
      ['70000', 'Budget from DR account, in DOP'],
      ['', 'Amount of the new budget part'],
    ]);
    const rows = [...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => text(m[1]!).trim());
    expect(rows.slice(0, 2)).toEqual(['US account USD', 'DR account DOP ×']);
    expect(els(html, 'button').map((b) => b['aria-label']).filter(Boolean)).toEqual(['Remove DR account from the budget']);
    // 70,000 + 50 USD × 58.76.
    expect(text(html)).toContain('Budget 72,938.00 DOP');

    // Con parte en el registro y además un ingreso, la × sigue: quita lo del registro.
    const both = seedState();
    both.incomes.push(budgetIncome({ id: 'in-dr', amount: 4000 }));
    const mixed = panel({ state: both });
    has(els(mixed, 'input'), { value: '74000', 'aria-label': 'Budget from DR account, in DOP' });
    has(els(mixed, 'button'), { 'aria-label': 'Remove DR account from the budget' });
  });

  describe('el sobrante del mes anterior', () => {
    /** La línea del sobrante: su texto, y los botones que lleva. */
    const leftover = (opts: Opts = {}) => {
      const html = panel(opts);
      const block = /<div class="[^"]*leftover[^"]*">.*?<\/div>/.exec(html)?.[0];
      return block === undefined ? null : { text: text(block).trim(), buttons: buttonTexts(block), html: block };
    };

    it('offer: lo que sobró en septiembre, con el botón para sumarlo al presupuesto de octubre', () => {
      const line = leftover();
      // 70,000 − 66,636.54.
      expect(line!.text).toBe('Leftover from last month: 3,363.46 DOP Add to budget');
      expect(line!.buttons).toEqual(['Add to budget']);
      has(els(line!.html, 'button'), { type: 'button' });
      expect(line!.html).toContain('inkText');
      // Va debajo de la tabla de las cuentas y antes del historial.
      const html = panel();
      const order = ['</table>', 'Leftover from last month:', 'Budget history', 'Month income − used'].map((x) => html.indexOf(x));
      expect(order.every((x) => x >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('added: una vez sumado, en vez del botón dice "added"', () => {
      const state = seedState();
      state.months['2026-10']!.budgetLog.push(logEntry({ id: 'bg-left', amount: 3363.46, kind: 'leftover' }));
      const line = leftover({ state });
      expect(line!.text).toBe('Leftover from last month: 3,363.46 DOP added');
      expect(line!.buttons).toEqual([]);
      // Y el presupuesto ya lo lleva.
      expect(text(panel({ state }))).toContain('Budget 73,363.46 DOP');
    });

    it('plain: en un mes cerrado, solo la cifra', () => {
      // Septiembre enseña lo que sobró en agosto.
      const avail = monthCalc(seedState(), '2026-08').avail;
      const line = leftover({ monthKey: '2026-09' });
      expect(line!.text).toBe(`Leftover from last month: ${f2(avail)} DOP`);
      expect(line!.buttons).toEqual([]);
    });

    it('plain: si sobró 0 no hay nada que sumar', () => {
      const state = seedState();
      setBudgets(state.months['2026-09']!, { dr: monthCalc(seedState(), '2026-09').used });
      const line = leftover({ state });
      expect(line!.text).toBe('Leftover from last month: 0.00 DOP');
      expect(line!.buttons).toEqual([]);
    });

    it('sin mes anterior no hay línea', () => {
      expect(leftover({ monthKey: '2026-08' })).toBeNull();
      expect(text(panel({ monthKey: '2026-08' }))).not.toContain('Leftover');
      expect(buttonTexts(panel({ monthKey: '2026-08' }))).toEqual(['Budget history']);
    });

    it('un sobrante negativo (el mes anterior se pasó) va en rojo y también se puede sumar', () => {
      const state = seedState();
      setBudgets(state.months['2026-09']!, { dr: 60000 });
      const line = leftover({ state });
      expect(line!.text).toBe('Leftover from last month: -6,636.54 DOP Add to budget');
      expect(line!.html).toContain('errorText');
      expect(line!.html).not.toContain('inkText');
    });

    it('va en la moneda principal del usuario', () => {
      const state = tryState();
      const line = leftover({ state });
      expect(line!.text).toBe(`Leftover from last month: ${f2(monthCalc(tryState(), '2026-09').avail)} TRY Add to budget`);
    });

    it('en español y en turco', () => {
      expect(leftover({ lang: 'es' })!.text).toBe('Sobrante del mes pasado: 3,363.46 DOP Sumar al presupuesto');
      expect(leftover({ lang: 'tr' })!.text).toBe('Geçen aydan kalan: 3,363.46 DOP Bütçeye ekle');
      const added = () => {
        const state = seedState();
        state.months['2026-10']!.budgetLog.push(logEntry({ id: 'bg-left', amount: 3363.46, kind: 'leftover' }));
        return state;
      };
      expect(leftover({ lang: 'es', state: added() })!.text).toBe('Sobrante del mes pasado: 3,363.46 DOP sumado');
      expect(leftover({ lang: 'tr', state: added() })!.text).toBe('Geçen aydan kalan: 3,363.46 DOP eklendi');
      expect(leftover({ lang: 'es', monthKey: '2026-09' })!.buttons).toEqual([]);
      expect(leftover({ lang: 'tr', monthKey: '2026-09' })!.text).toMatch(/^Geçen aydan kalan: [\d,.]+ DOP$/);
    });
  });

  it('el historial del presupuesto arranca plegado: solo su botón, sin tabla ni filas', () => {
    for (const monthKey of ['2026-10', '2026-09']) {
      const html = panel({ monthKey });
      const toggle = els(html, 'button').filter((b) => 'aria-controls' in b);
      expect(toggle).toEqual([expect.objectContaining({ type: 'button', 'aria-expanded': 'false' })]);
      // La única tabla es la de las partes por cuenta.
      expect(els(html, 'table').map((x) => x['aria-label'])).toEqual(['Budget']);
      const t = text(html);
      expect(t).toContain('Budget history');
      expect(t).not.toContain('Initial');
      expect(t).not.toContain('Adjustment');
      expect(t).not.toContain('Car repair');
      expect(t).not.toContain('No budget entries yet.');
    }
    expect(buttonTexts(panel({ lang: 'es' })).at(-1)).toBe('Historial del presupuesto');
    expect(buttonTexts(panel({ lang: 'tr' })).at(-1)).toBe('Bütçe geçmişi');
  });

  it('no enseña el dinero total ni los saldos: eso es de Savings', () => {
    const t = text(panel());
    expect(t).not.toContain('Total money');
    expect(t).not.toContain('Money by account');
    expect(t).not.toContain('1,012,844');
    expect(t).not.toContain('Add account');
  });
});

describe('SummaryPanel · Savings: el dinero total', () => {
  const panel = (opts: Opts = {}) => render(<SummaryPanel sheet="ahorros" />, { ...opts, shell: { sheet: 'ahorros', ...opts.shell } });

  it('October 2026: el total de las cuentas visibles y el saldo de cada una, de shared/calc.ts', () => {
    const b = balances(seedState(), '2026-10');
    const html = panel();
    const t = text(html);
    // 13,482 USD × 58.76 + 220,641.93 DOP
    expect(f2(b.totalMain)).toBe('1,012,844.25');
    expect(f2(b.totalSecond)).toBe('17,236.97');
    expect(t).toContain('Total money 1,012,844.25 DOP ≈ 17,236.97 USD');
    has(els(html, 'section'), { 'aria-label': 'October 2026 summary' });
    has(els(html, 'table'), { 'aria-label': 'Accounts' });

    // Una fila por cuenta visible: nombre editable, saldo editable (en centavos) y su moneda.
    const inputs = els(html, 'input');
    expect(inputs.slice(0, 4).map((i) => [i.type, i.value, i['aria-label']])).toEqual([
      ['text', 'US account', 'Account name'],
      ['number', '13482', 'Balance of US account, in USD'],
      ['text', 'DR account', 'Account name'],
      ['number', '220641.93', 'Balance of DR account, in DOP'],
    ]);
    // Octubre es el último mes: los saldos se pueden corregir.
    expect(html).not.toContain('readOnly');
    expect(buttonTexts(html)).toEqual(['Hide', 'Hide', 'Add', 'Cancel']);
    has(els(html, 'button'), { 'aria-label': 'Hide US account' });
    has(els(html, 'button'), { 'aria-label': 'Hide DR account' });
  });

  it('la fila de agregar: nombre, saldo inicial, moneda (arranca en la principal) y "Add account"', () => {
    const html = panel();
    const inputs = els(html, 'input');
    expect(inputs.slice(4).map((i) => [i.type, i.value, i.placeholder, i['aria-label']])).toEqual([
      ['text', '', 'Account name', 'Name of the new account'],
      ['number', '', 'Opening balance', 'Opening balance of the new account'],
    ]);
    has(els(html, 'select'), { 'aria-label': 'Currency of the new account' });
    expect(html).toContain('<option value="DOP" selected="">DOP</option><option value="USD">USD</option><option value="TRY">TRY</option>');
    expect(panel({ state: tryState() })).toContain('<option value="TRY" selected="">TRY</option>');
  });

  it('la dona del dinero por cuenta: un segmento por cuenta visible con saldo, el total en el centro y su leyenda', () => {
    const b = balances(seedState(), '2026-10');
    const html = panel();
    const t = text(html);
    expect(t).toContain('Total 1,012,844 DOP');
    expect(t).toContain('Money by account US account 792,202.32 DR account 220,641.93');
    has(els(html, 'svg'), { 'aria-label': 'Money by account: 1,012,844 DOP in total', viewBox: '0 0 168 168' });

    // Fondo y, encima, un segmento por cuenta: su largo es su parte del total, y van encadenados.
    const [track, us, dr] = els(html, 'circle');
    const circ = 2 * Math.PI * 64;
    const len = (c: Record<string, string>) => +c['stroke-dasharray']!.split(' ')[0]!;
    expect(els(html, 'circle')).toHaveLength(3);
    expect(track!.style).toBe('stroke:var(--donut-free)');
    expect(track!['stroke-dasharray']).toBeUndefined();
    expect(len(us!)).toBeCloseTo((b.accounts[0]!.inMain / b.totalMain) * circ, 6);
    expect(len(dr!)).toBeCloseTo((b.accounts[1]!.inMain / b.totalMain) * circ, 6);
    expect(us!['stroke-dashoffset']).toBe('0');
    expect(+dr!['stroke-dashoffset']!).toBeCloseTo(-len(us!), 8);
    expect(len(us!) + len(dr!)).toBeCloseTo(circ, 6);
  });

  it('los colores de los segmentos salen del tema del usuario, tantos tonos como cuentas', () => {
    const defaults = ringShades(null, 2);
    const html = panel();
    expect(els(html, 'circle').slice(1).map((c) => c.style)).toEqual(defaults.map((color) => `stroke:${color}`));
    // La leyenda usa los mismos.
    for (const color of defaults) expect(html).toContain(`background:${color}`);

    const ocean = THEME_PRESETS.find((p) => p.id === 'ocean')!.colors;
    const themed = panel({ state: { ...seedState(), theme: ocean } });
    const shades = ringShades(ocean, 2);
    expect(shades).not.toEqual(defaults);
    expect(els(themed, 'circle').slice(1).map((c) => c.style)).toEqual(shades.map((color) => `stroke:${color}`));

    // Con tres cuentas con saldo, tres tonos distintos; el del medio es el acento.
    const three = panel({ state: manyAccounts() });
    const strokes = els(three, 'circle').slice(1).map((c) => c.style);
    expect(strokes).toEqual(ringShades(null, 3).map((color) => `stroke:${color}`));
    expect(new Set(strokes).size).toBe(3);
    expect(strokes[1]).toBe('stroke:#2f7d52');
  });

  it('una cuenta sin saldo o en negativo no ocupa nada en la dona, pero sigue en la tabla y en la leyenda', () => {
    const state = seedState();
    state.accounts.find((a) => a.id === 'us')!.opening = -20000; // saldo: −8,518 USD
    const b = balances(state, '2026-10');
    const html = panel({ state });
    expect(els(html, 'circle')).toHaveLength(2);
    expect(els(html, 'circle')[1]!.style).toBe(`stroke:${ringShades(null, 1)[0]}`);
    const t = text(html);
    expect(t).toContain(`US account ${f2(b.accounts[0]!.inMain)} DR account 220,641.93`);
    expect(t).toContain(`Total money ${f2(b.totalMain)} DOP`);
    has(els(html, 'input'), { value: '-8518', 'aria-label': 'Balance of US account, in USD' });
    // Dinero total en negativo: en rojo.
    expect(b.totalMain).toBeLessThan(0);
    expect([...html.matchAll(/errorText/g)].length).toBeGreaterThanOrEqual(2);
  });

  it('con la lira como moneda principal: total, centro y leyenda en TRY; los saldos, en la moneda de cada cuenta', () => {
    const state = tryState();
    const b = balances(state, '2026-10');
    const html = panel({ state });
    const t = text(html);
    // (13,482 USD + 220,641.93 DOP / 58.76) × 40
    expect(f2(b.totalMain)).toBe('689,478.73');
    expect(t).toContain('Total money 689,478.73 TRY ≈ 17,236.97 USD');
    expect(t).toContain('Total 689,479 TRY');
    expect(t).toContain(`Money by account US account 539,280.00 DR account ${f2(b.accounts[1]!.inMain)}`);
    has(els(html, 'input'), { value: '13482', 'aria-label': 'Balance of US account, in USD' });
    has(els(html, 'input'), { value: '220641.93', 'aria-label': 'Balance of DR account, in DOP' });
    has(els(html, 'svg'), { 'aria-label': 'Money by account: 689,479 TRY in total' });
  });

  it('en un mes que no es el último los saldos son los de entonces y no se pueden corregir', () => {
    const b = balances(seedState(), '2026-08');
    const html = panel({ monthKey: '2026-08' });
    expect(text(html)).toContain(`Total money ${f2(b.totalMain)} DOP ≈ ${f2(b.totalSecond)} USD`);
    // US: 2,000 + 5,800 − 1,800 − 106. DR: 60,000 + 104,730 − 27,850 − 35,750.26.
    has(els(html, 'input'), { value: '5894', 'aria-label': 'Balance of US account, in USD' });
    has(els(html, 'input'), { value: '101129.74', 'aria-label': 'Balance of DR account, in DOP' });
    // Solo los dos saldos quedan de solo lectura: renombrar, ocultar y agregar no dependen del mes.
    expect(els(html, 'input').filter((i) => 'readOnly' in i).map((i) => i['aria-label'])).toEqual([
      'Balance of US account, in USD',
      'Balance of DR account, in DOP',
    ]);
    expect(buttonTexts(html)).toEqual(['Hide', 'Hide', 'Add', 'Cancel']);
  });

  it('las cuentas ocultas no suman ni salen en la tabla: quedan plegadas detrás de "Hidden accounts (N)"', () => {
    const state = manyAccounts();
    const b = balances(state, '2026-10');
    const html = panel({ state });
    const t = text(html);
    // Tres visibles (la TR account, en liras) y una oculta.
    expect(b.accounts).toHaveLength(4);
    expect(t).toContain(`Total money ${f2(b.totalMain)} DOP`);
    expect(b.totalMain).toBeCloseTo(13482 * 58.76 + 220641.93 + (21000 / 42) * 58.76, 6);
    // La TR account no la nombra nada (ni movimientos ni presupuesto): además de ocultarse, se puede eliminar con su ×.
    expect(buttonTexts(html)).toEqual(['Hide', 'Hide', 'Hide', '×', 'Add', 'Cancel', 'Hidden accounts (1)']);
    expect(els(html, 'button').map((b) => b['aria-label']).filter((l) => l?.startsWith('Delete '))).toEqual(['Delete TR account']);
    has(els(html, 'button'), { 'aria-expanded': 'false' });
    expect(t).not.toContain('Old savings');
    expect(t).toContain('TR account 29,380.00');
    has(els(html, 'input'), { value: '21000', 'aria-label': 'Balance of TR account, in TRY' });
  });

  it('con una sola cuenta visible no se ofrece ocultarla', () => {
    const state = seedState();
    state.accounts.find((a) => a.id === 'us')!.hidden = true;
    const html = panel({ state });
    expect(buttonTexts(html)).toEqual(['Add', 'Cancel', 'Hidden accounts (1)']);
    expect(text(html)).toContain('Total money 220,641.93 DOP');
  });

  it('en español y en turco', () => {
    const es = panel({ lang: 'es', state: manyAccounts() });
    expect(text(es)).toContain('Dinero total');
    expect(text(es)).toContain('Dinero por cuenta US account 792,202.32');
    expect(buttonTexts(es)).toEqual(['Ocultar', 'Ocultar', 'Ocultar', '×', 'Agregar', 'Cancelar', 'Cuentas ocultas (1)']);
    has(els(es, 'button'), { 'aria-label': 'Eliminar TR account' });
    has(els(es, 'input'), { 'aria-label': 'Saldo de US account, en USD' });
    has(els(es, 'input'), { placeholder: 'Saldo inicial', 'aria-label': 'Saldo inicial de la nueva cuenta' });
    has(els(es, 'button'), { 'aria-label': 'Ocultar DR account' });
    has(els(es, 'svg'), { 'aria-label': expect.stringContaining('Dinero por cuenta: ') as unknown as string });

    const tr = panel({ lang: 'tr', state: manyAccounts() });
    expect(text(tr)).toContain('Toplam para');
    expect(text(tr)).toContain('Hesaba göre para US account 792,202.32');
    expect(buttonTexts(tr)).toEqual(['Gizle', 'Gizle', 'Gizle', '×', 'Ekle', 'İptal', 'Gizli hesaplar (1)']);
    has(els(tr, 'button'), { 'aria-label': 'Sil: TR account' });
    has(els(tr, 'input'), { 'aria-label': 'US account bakiyesi, USD cinsinden' });
  });

  it('no enseña la dona de presupuesto ni la lista del presupuesto: eso es de Month', () => {
    const t = text(panel());
    expect(t).not.toContain('Budget');
    expect(t).not.toContain('Planned budget');
    expect(t).not.toContain('Fixed paid');
    expect(t).not.toContain('Used so far');
    expect(t).not.toContain('Month income');
  });
});

describe('TopBar', () => {
  it('mes en curso: marca, subtítulo, meses con su sufijo, Excel, tasa y ajustes', () => {
    const html = render(<TopBar />);
    const t = text(html);
    expect(t).toContain('FE Finance Current month');
    expect(t).toContain('August 2026 · closed September 2026 · closed October 2026');
    expect(t).toContain('Import Excel');
    expect(t).toContain('Download Excel');
    expect(t).toContain('Month rate 1 USD = 58.76 DOP');
    expect(html).toContain('<option value="2026-10" selected="">October 2026</option>');
    has(els(html, 'input'), { type: 'file', accept: '.xlsx' });
    expect(els(html, 'button').map((b) => b['aria-label'])).toEqual(['Previous month', 'Next month', undefined, undefined]);
    expect(buttonTexts(html)).toEqual(['‹', '›', 'Download Excel', 'Settings']);
    // El panel de ajustes está cerrado.
    has(els(html, 'button'), { 'aria-expanded': 'false' });
    expect(html).not.toContain('role="dialog"');
  });

  it('con varios usuarios hay un selector junto a la marca, con el actual elegido y el mismo estilo que el de mes', () => {
    const html = render(<TopBar />, { user: EDA, shell: { user: EDA } });
    const selects = els(html, 'select');
    expect(selects.map((s) => s['aria-label'])).toEqual(['User', 'Month']);
    expect(html).toContain('<option value="frank">Frank</option><option value="eda" selected="">Eda</option>');
    // Mismo estilo: el selector de mes solo añade su ancho mínimo.
    const [userSelect, monthSelect] = selects;
    expect(monthSelect!.class!.split(' ')).toContain(userSelect!.class!);
    // Va antes que el selector de mes, justo después de la marca y el subtítulo.
    expect(html.indexOf('aria-label="User"')).toBeGreaterThan(html.indexOf('Current month'));
    expect(html.indexOf('aria-label="User"')).toBeLessThan(html.indexOf('aria-label="Previous month"'));
  });

  it('con un solo usuario el selector no se muestra', () => {
    const html = render(<TopBar />, { shell: { users: [FRANK] } });
    expect(els(html, 'select').map((s) => s['aria-label'])).toEqual(['Month']);
    expect(html).not.toContain('>Frank<');
  });

  it('subtítulos de mes cerrado y de ahorros', () => {
    expect(text(render(<TopBar />, { monthKey: '2026-08' }))).toContain('FE Finance Month summary');
    expect(text(render(<TopBar />, { monthKey: '2026-08' }))).toContain('1 USD = 58.18 DOP');
    expect(text(render(<TopBar />, { shell: { sheet: 'ahorros' } }))).toContain('FE Finance Savings');
  });

  describe('la tasa del mes: 1 segunda = tasa principal, y de dónde sale', () => {
    /** El texto del bloque de la tasa y las clases de sus piezas. */
    const rate = (opts: Opts = {}) => {
      const html = render(<TopBar />, opts);
      const block = /<div class="[^"]*rate[^"]*"><span>.*?<\/div>/.exec(html)![0];
      const spans = [...block.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => ({ attrs: m[1]!, text: m[2]! }));
      return { text: text(block).trim(), chip: spans[1]!, note: spans[2] };
    };

    it('escrita para este mes: solo la tasa, sin apunte (el origen queda en el title)', () => {
      const r = rate();
      expect(r.text).toBe('Month rate 1 USD = 58.76 DOP');
      expect(r.note).toBeUndefined();
      expect(r.chip.attrs).toContain('title="typed for this month"');
      expect(r.chip.attrs).not.toContain('chipWarn');
    });

    it('de los envíos del mes: un apunte atenuado al lado', () => {
      const r = rate({ monthKey: '2026-08' });
      expect(r.text).toBe("Month rate 1 USD = 58.18 DOP from this month's transfers");
      expect(r.note!.attrs).toContain('rateHint');
      expect(r.note!.attrs).not.toContain('rateWarn');
      expect(r.chip.attrs).not.toContain('chipWarn');
    });

    it('de un mes anterior: dice de cuál', () => {
      const state = seedState();
      state.months['2026-10']!.rates = [];
      state.months['2026-10']!.transfers = [];
      const r = rate({ state });
      // Septiembre: (1,500 × 58.55 + 800 × 58.62) / 2,300
      expect(r.text).toBe('Month rate 1 USD = 58.57 DOP from September 2026');
      expect(r.note!.attrs).toContain('rateHint');
      expect(rate({ state, lang: 'es' }).text).toBe('Tasa del mes 1 USD = 58.57 DOP de septiembre 2026');
      expect(rate({ state, lang: 'tr' }).text).toBe('Ay kuru 1 USD = 58.57 DOP Eylül 2026 ayından');
    });

    it('cruzada por la tercera moneda: dice por cuál', () => {
      const state = seedState();
      state.secondCurrency = 'TRY';
      state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
      const r = rate({ state });
      // 58.76 DOP por USD / 40 TRY por USD
      expect(r.text).toBe('Month rate 1 TRY = 1.47 DOP crossed through USD');
      expect(r.note!.attrs).toContain('rateHint');
    });

    it('valor de respaldo (nadie la ha escrito): se destaca en la tasa y en el aviso', () => {
      const state = seedState();
      state.secondCurrency = 'TRY';
      const r = rate({ state });
      // DEFAULT_USD_RATES: 58.76 DOP y 42 TRY por USD.
      expect(r.text).toBe('Month rate 1 TRY = 1.40 DOP default value, not set yet');
      expect(r.chip.attrs).toContain('chipWarn');
      expect(r.note!.attrs).toContain('rateWarn');
      expect(r.note!.attrs).not.toContain('rateHint');
      expect(rate({ state, lang: 'es' }).text).toBe('Tasa del mes 1 TRY = 1.40 DOP valor por defecto, aún sin definir');
      expect(rate({ state, lang: 'tr' }).text).toBe('Ay kuru 1 TRY = 1.40 DOP varsayılan değer, henüz girilmedi');
    });

    it('sigue a las monedas del usuario; una tasa menor que 1 lleva cuatro decimales', () => {
      expect(rate({ state: tryState() }).text).toBe('Month rate 1 USD = 40.00 TRY');
      const flipped = seedState();
      flipped.mainCurrency = 'USD';
      flipped.secondCurrency = 'DOP';
      expect(rate({ state: flipped }).text).toBe('Month rate 1 DOP = 0.0170 USD');
    });
  });

  it('los dos botones de Excel avisan de que el libro es un resumen en USD y DOP', () => {
    const html = render(<TopBar />);
    const note = 'The Excel file is a summary in USD and DOP, with two accounts, until it is redesigned.';
    has(els(html, 'label'), { title: note });
    has(els(html, 'button'), { title: note });
  });

  it('estado de la carga de Excel, en el idioma actual', () => {
    const loaded = text(render(<TopBar />, { shell: { excelStatus: { kind: 'loaded', file: 'my finances.xlsx' } } }));
    expect(loaded).toContain('Loaded: my finances.xlsx');
    expect(loaded).not.toContain('Import Excel');
    expect(text(render(<TopBar />, { shell: { excelStatus: { kind: 'reading' } } }))).toContain('Reading…');
    expect(text(render(<TopBar />, { shell: { excelStatus: { kind: 'failed' } } }))).toContain('Could not read the file');
    expect(text(render(<TopBar />, { lang: 'es', shell: { excelStatus: { kind: 'loaded', file: 'mis finanzas.xlsx' } } }))).toContain(
      'Cargado: mis finanzas.xlsx',
    );
    expect(text(render(<TopBar />, { lang: 'tr', shell: { excelStatus: { kind: 'failed' } } }))).toContain('Dosya okunamadı');
  });

  it('en español: los textos de la versión 1 (la marca no se traduce)', () => {
    const html = render(<TopBar />, { lang: 'es' });
    const t = text(html);
    expect(t).toContain('FE Finance Mes en curso');
    expect(t).toContain('Agosto 2026 · cerrado Septiembre 2026 · cerrado Octubre 2026');
    expect(t).toContain('Cargar Excel');
    expect(t).toContain('Tasa del mes 1 USD = 58.76 DOP');
    expect(buttonTexts(html)).toEqual(['‹', '›', 'Descargar Excel', 'Ajustes']);
    expect(els(html, 'button').map((b) => b['aria-label'])).toEqual(['Mes anterior', 'Mes siguiente', undefined, undefined]);
    expect(text(render(<TopBar />, { lang: 'es', monthKey: '2026-08' }))).toContain('FE Finance Resumen del mes');
    expect(text(render(<TopBar />, { lang: 'es', shell: { sheet: 'ahorros' } }))).toContain('FE Finance Ahorros');
  });

  it('en turco', () => {
    const html = render(<TopBar />, { lang: 'tr' });
    const t = text(html);
    expect(t).toContain('FE Finance Bu ay');
    expect(t).toContain('Ağustos 2026 · kapalı Eylül 2026 · kapalı Ekim 2026');
    expect(t).toContain('Excel içe aktar');
    expect(buttonTexts(html)).toEqual(['‹', '›', 'Excel indir', 'Ayarlar']);
    expect(text(render(<TopBar />, { lang: 'tr', monthKey: '2026-08' }))).toContain('FE Finance Ay özeti');
    expect(text(render(<TopBar />, { lang: 'tr', shell: { sheet: 'ahorros' } }))).toContain('FE Finance Birikimler');
  });
});

describe('DownloadExcelDialog', () => {
  const KEYS: MonthKey[] = ['2026-08', '2026-09', '2026-10'];
  const noop = () => {};
  /** Las casillas del diálogo, en orden: su texto y si están marcadas. */
  const checks = (html: string) =>
    [...html.matchAll(/<label\b[^>]*><input\b([^>]*)\/><span>(.*?)<\/span><\/label>/g)].map((m) => [text(m[2]!).trim(), /\bchecked=""/.test(m[1]!)]);

  it('la barra no lo pinta hasta que se pulsa "Download Excel"', () => {
    const html = render(<TopBar />);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('type="checkbox"');
    expect(text(html)).not.toContain('All months');
  });

  it('abierto: una casilla por mes, del más reciente al más antiguo, todas marcadas, y "Download (3)"', () => {
    const html = render(<DownloadExcelDialog months={KEYS} onCancel={noop} onDownload={noop} />);
    const [dialog] = els(html, 'div').filter((d) => d.role === 'dialog');
    expect(dialog).toMatchObject({ 'aria-modal': 'true' });
    has(els(html, 'h2'), { id: dialog!['aria-labelledby']! });
    expect(text(html)).toContain('Download Excel');
    expect(checks(html)).toEqual([
      ['All months', true],
      ['October 2026', true],
      ['September 2026', true],
      ['August 2026', true],
    ]);
    expect(els(html, 'input').every((i) => i.type === 'checkbox')).toBe(true);
    // Es un formulario: Enter o el botón principal descargan.
    expect(html).toContain('<form');
    expect(buttonTexts(html)).toEqual(['Cancel', 'Download (3)']);
    expect(els(html, 'button').map((b) => b.type)).toEqual(['button', 'submit']);
    expect(html).not.toContain('disabled');
  });

  it('con algunos meses: "All months" queda sin marcar y el botón cuenta los elegidos', () => {
    const html = render(<DownloadExcelDialog months={KEYS} initial={['2026-08', '2026-10']} onCancel={noop} onDownload={noop} />);
    expect(checks(html)).toEqual([
      ['All months', false],
      ['October 2026', true],
      ['September 2026', false],
      ['August 2026', true],
    ]);
    expect(buttonTexts(html)).toEqual(['Cancel', 'Download (2)']);
    expect(html).not.toContain('disabled');
  });

  it('sin ningún mes no se puede descargar', () => {
    const html = render(<DownloadExcelDialog months={KEYS} initial={[]} onCancel={noop} onDownload={noop} />);
    expect(checks(html).map(([, on]) => on)).toEqual([false, false, false, false]);
    expect(buttonTexts(html)).toEqual(['Cancel', 'Download (0)']);
    const [cancel, download] = els(html, 'button');
    expect(cancel).not.toHaveProperty('disabled');
    expect(download).toHaveProperty('disabled');
  });

  it('en español y en turco', () => {
    const es = render(<DownloadExcelDialog months={KEYS} initial={['2026-10']} onCancel={noop} onDownload={noop} />, { lang: 'es' });
    expect(checks(es).map(([name]) => name)).toEqual(['Todos los meses', 'Octubre 2026', 'Septiembre 2026', 'Agosto 2026']);
    expect(buttonTexts(es)).toEqual(['Cancelar', 'Descargar (1)']);
    expect(text(es)).toContain('Descargar Excel');
    const tr = render(<DownloadExcelDialog months={KEYS} onCancel={noop} onDownload={noop} />, { lang: 'tr' });
    expect(checks(tr).map(([name]) => name)).toEqual(['Tüm aylar', 'Ekim 2026', 'Eylül 2026', 'Ağustos 2026']);
    expect(buttonTexts(tr).at(-1)).toBe('İndir (3)');
    expect(text(tr)).toContain('Excel indir');
  });

  it('toggleMonth: marca y desmarca un mes, siempre en el orden de la lista', () => {
    expect(toggleMonth(KEYS, KEYS, '2026-09', false)).toEqual(['2026-08', '2026-10']);
    expect(toggleMonth(KEYS, ['2026-10'], '2026-08', true)).toEqual(['2026-08', '2026-10']);
    expect(toggleMonth(KEYS, ['2026-08', '2026-10'], '2026-09', true)).toEqual(KEYS);
    // Marcar uno ya marcado o desmarcar uno que no lo estaba no cambia nada.
    expect(toggleMonth(KEYS, ['2026-10'], '2026-10', true)).toEqual(['2026-10']);
    expect(toggleMonth(KEYS, ['2026-10'], '2026-08', false)).toEqual(['2026-10']);
    expect(toggleMonth(KEYS, ['2026-10'], '2026-10', false)).toEqual([]);
  });
});

describe('SettingsPanel', () => {
  const panel = (opts: Opts = {}) => render(<SettingsPanel id="settings" opener={{ current: null }} onClose={() => {}} />, opts);

  /** Los botones de los temas: van detrás de los 3 idiomas y de las 6 monedas (3 por fila). */
  const FIRST_PRESET = 9;

  it('cuatro secciones: idioma, monedas, apariencia y la nota del Excel', () => {
    const html = panel();
    has(els(html, 'div'), { id: 'settings', role: 'dialog', 'aria-label': 'Settings' });
    expect([...html.matchAll(/<h2\b[^>]*>(.*?)<\/h2>/g)].map((m) => m[1])).toEqual(['Language', 'Currencies', 'Appearance', 'Excel']);
    expect(text(html)).toContain('Excel The Excel file is a summary in USD and DOP, with two accounts, until it is redesigned.');
  });

  it('monedas: la principal y la segunda, cada una entre las tres, con la actual marcada', () => {
    const html = panel();
    expect(text(html)).toContain('Currencies Main currency DOP USD TRY Second currency DOP USD TRY Default account');
    const codes = els(html, 'button').slice(3, FIRST_PRESET);
    expect(buttonTexts(html).slice(3, FIRST_PRESET)).toEqual(['DOP', 'USD', 'TRY', 'DOP', 'USD', 'TRY']);
    expect(codes.map((b) => b['aria-pressed'])).toEqual(['true', 'false', 'false', 'false', 'true', 'false']);
    // Cada fila es un grupo con el nombre de su ajuste.
    const groups = els(html, 'div').filter((d) => d.role === 'group' && d['aria-labelledby']);
    expect(groups).toHaveLength(2);
    for (const group of groups) has(els(html, 'span'), { id: group['aria-labelledby']! });

    const tr = els(panel({ state: tryState() }), 'button').slice(3, FIRST_PRESET);
    expect(tr.map((b) => b['aria-pressed'])).toEqual(['false', 'false', 'true', 'false', 'true', 'false']);
  });

  it('cuenta por defecto: las cuentas visibles y "Automatic", que dice a cuál equivale', () => {
    const html = panel();
    const [select] = els(html, 'select');
    has(els(html, 'label'), { for: select!.id! });
    expect(html).toContain('<option value="">Automatic (DR account)</option><option value="us">US account</option><option value="dr" selected="">DR account</option>');

    // Sin elección guardada: "Automatic" es la elegida.
    const auto = panel({ state: { ...seedState(), defaultAccountId: null } });
    expect(auto).toContain('<option value="" selected="">Automatic (DR account)</option>');

    // Una cuenta oculta no se ofrece, y si era la elegida manda la automática (shared/calc defaultAccount).
    const state = seedState();
    state.accounts.find((a) => a.id === 'dr')!.hidden = true;
    const hidden = panel({ state });
    expect(hidden).toContain('<option value="" selected="">Automatic (US account)</option><option value="us">US account</option></select>');
    expect(hidden).not.toContain('DR account');
  });

  it('los tres idiomas, cada uno con su propio nombre, y el actual marcado', () => {
    const html = panel({ state: { ...seedState(), language: 'tr' }, lang: 'tr' });
    const langs = els(html, 'button').filter((b) => 'lang' in b);
    expect(langs.map((b) => [b.lang, b['aria-pressed']])).toEqual([
      ['en', 'false'],
      ['es', 'false'],
      ['tr', 'true'],
    ]);
    expect(buttonTexts(html).slice(0, 3)).toEqual(['English', 'Español', 'Türkçe']);
  });

  it('los temas listos como muestras con nombre; sin tema propio, el original es el elegido', () => {
    const html = panel();
    const names = buttonTexts(html).slice(FIRST_PRESET, FIRST_PRESET + THEME_PRESETS.length);
    expect(names).toEqual(['Forest', 'Ocean', 'Plum', 'Terracotta', 'Rose', 'Amber', 'Slate']);
    const presets = els(html, 'button').slice(FIRST_PRESET, FIRST_PRESET + THEME_PRESETS.length);
    expect(presets.map((b) => b['aria-pressed'])).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false']);
    // Cada muestra enseña sus tres colores.
    for (const preset of THEME_PRESETS) {
      expect(html).toContain(`background:${preset.colors.header}`);
      expect(html).toContain(`background:${preset.colors.accent}`);
      expect(html).toContain(`background:${preset.colors.background}`);
    }
    has(els(html, 'div'), { role: 'group', 'aria-label': 'Themes' });
  });

  it('tres colores con su valor hexadecimal y el botón de restablecer (apagado si no hay nada que restablecer)', () => {
    const html = panel();
    const colors = els(html, 'input').filter((i) => i.type === 'color');
    expect(colors.map((c) => c.value)).toEqual(['#2f7d52', '#1d1f1c', '#efeee8']);
    const t = text(html);
    expect(t).toContain('Accent #2f7d52 Header #1d1f1c Background #efeee8');
    // Cada color tiene su etiqueta (la primera etiqueta del panel es la de la cuenta por defecto).
    const labels = els(html, 'label').map((l) => l.for);
    expect(labels.slice(1)).toEqual(colors.map((c) => c.id));
    expect(buttonTexts(html).at(-1)).toBe('Reset to default');
    expect(els(html, 'button').at(-1)).toHaveProperty('disabled');
  });

  it('con un tema propio: sus colores, su muestra marcada y restablecer disponible', () => {
    const ocean = THEME_PRESETS.find((p) => p.id === 'ocean')!.colors;
    const html = panel({ state: { ...seedState(), theme: ocean } });
    expect(els(html, 'input').filter((i) => i.type === 'color').map((c) => c.value)).toEqual([ocean.accent, ocean.header, ocean.background]);
    const presets = els(html, 'button').slice(FIRST_PRESET, FIRST_PRESET + THEME_PRESETS.length);
    expect(presets.map((b) => b['aria-pressed'])).toEqual(['false', 'true', 'false', 'false', 'false', 'false', 'false']);
    expect(els(html, 'button').at(-1)).not.toHaveProperty('disabled');

    // Colores que no son de ningún tema listo: ninguna muestra marcada.
    const custom = panel({ state: { ...seedState(), theme: { ...ocean, accent: '#123456' } } });
    expect(els(custom, 'button').slice(FIRST_PRESET, FIRST_PRESET + THEME_PRESETS.length).every((b) => b['aria-pressed'] === 'false')).toBe(true);
    expect(text(custom)).toContain('Accent #123456');
  });

  it('en español y en turco', () => {
    const es = text(panel({ lang: 'es' }));
    expect(es).toContain('Idioma');
    expect(es).toContain('Monedas Moneda principal DOP USD TRY Segunda moneda DOP USD TRY Cuenta por defecto Automática (DR account)');
    expect(es).toContain('Apariencia');
    expect(es).toContain('Acento #2f7d52 Barra superior #1d1f1c Fondo #efeee8 Restablecer');
    expect(es).toContain('Bosque');
    expect(es).toContain('El Excel es un resumen en USD y DOP, con dos cuentas, hasta que se rediseñe.');
    const tr = text(panel({ lang: 'tr' }));
    expect(tr).toContain('Dil');
    expect(tr).toContain('Para birimleri Ana para birimi DOP USD TRY İkinci para birimi DOP USD TRY Varsayılan hesap Otomatik (DR account)');
    expect(tr).toContain('Görünüm');
    expect(tr).toContain('Varsayılana dön');
  });
});

describe('BottomTabs', () => {
  it('marca la hoja activa y esconde las utilidades de desarrollo', () => {
    const html = render(<BottomTabs />, { shell: { sheet: 'ahorros' } });
    expect(els(html, 'button').map((b) => b['aria-current'])).toEqual([undefined, 'page']);
    expect(buttonTexts(html)).toEqual(['Month', 'Savings']);
    has(els(html, 'nav'), { 'aria-label': 'Sheets' });
    expect(html).not.toContain('Start blank');
  });

  it('con devTools aparecen los dos botones', () => {
    expect(buttonTexts(render(<BottomTabs />, { shell: { devTools: true } }))).toEqual(['Month', 'Savings', 'Start blank', 'Restore sample data']);
  });

  it('en español y en turco', () => {
    expect(buttonTexts(render(<BottomTabs />, { lang: 'es', shell: { devTools: true } }))).toEqual([
      'Mes',
      'Ahorros',
      'Empezar en blanco',
      'Restablecer datos de ejemplo',
    ]);
    expect(buttonTexts(render(<BottomTabs />, { lang: 'tr' }))).toEqual(['Ay', 'Birikimler']);
  });
});

describe('CloseMonthModal', () => {
  const open = { closeDialog: { key: '2026-10', busy: false } };
  /** Las etiquetas de los campos (<Field>): su texto y el id del control al que apuntan. */
  const fieldLabels = (html: string) => [...html.matchAll(/<label\b[^>]*\bfor="([^"]*)"[^>]*>(.*?)<\/label>/g)].map((m) => [text(m[2]!).trim(), m[1]!]);
  /** Las casillas con texto (<CheckField>): su texto y si están marcadas. */
  const checkTexts = (html: string) =>
    [...html.matchAll(/<label\b[^>]*><input\b([^>]*)\/><span>(.*?)<\/span><\/label>/g)].map((m) => [text(m[2]!).trim(), /\bchecked=""/.test(m[1]!)]);

  it('cerrado no pinta nada', () => {
    expect(render(<CloseMonthModal />)).toBe('');
  });

  it('abierto: diálogo con título, texto y los tres botones', () => {
    const html = render(<CloseMonthModal />, { shell: open });
    const [dialog] = els(html, 'div').filter((d) => d.role === 'dialog');
    expect(dialog).toMatchObject({ 'aria-modal': 'true', 'aria-busy': 'false' });
    // El título etiqueta el diálogo y el texto lo describe.
    has(els(html, 'h2'), { id: dialog!['aria-labelledby']! });
    has(els(html, 'p'), { id: dialog!['aria-describedby']! });
    const t = text(html);
    expect(t).toContain('Close October 2026');
    expect(t).toContain(
      'November 2026 will be created with the same monthly expenses, not marked as paid. Add it to the Excel too? The file with every month, including November 2026, will be downloaded.',
    );
    expect(buttonTexts(html)).toEqual(['Cancel', 'Only on the page', 'Yes, add to Excel']);
    expect(els(html, 'button').every((b) => b.type === 'button')).toBe(true);
    // Nada apagado: ni los botones ni los campos del presupuesto del mes siguiente.
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('aria-invalid');
    // Sigue sin ser un formulario: cada botón cierra a su manera, no hay un "enviar".
    expect(html).not.toContain('<form');
  });

  it('pregunta con qué presupuesto arranca el mes siguiente: un campo por cuenta con parte, con la de este mes', () => {
    const html = render(<CloseMonthModal />, { shell: open });
    const t = text(html);
    // Después del texto del Excel, la línea que presenta los campos.
    expect(t).toContain("will be downloaded. November 2026's budget starts with these amounts per account: Budget from DR account (DOP)");
    const inputs = els(html, 'input');
    expect(inputs.map((i) => i.type)).toEqual(['number', 'checkbox']);
    expect(inputs[0]).toMatchObject({ type: 'number', value: '70000', step: 'any', min: '0', inputMode: 'decimal', placeholder: '0.00', autoComplete: 'off' });
    // El campo lleva su etiqueta visible, con la cuenta y su moneda.
    expect(fieldLabels(html)).toEqual([['Budget from DR account (DOP)', inputs[0]!.id]]);
    // La línea de introducción no es la que describe el diálogo.
    const [dialog] = els(html, 'div').filter((d) => d.role === 'dialog');
    const described = new RegExp(`<p[^>]*id="${dialog!['aria-describedby']}"[^>]*>(.*?)</p>`).exec(html)![1]!;
    expect(described).not.toContain('budget starts');
  });

  it('la casilla del sobrante: con lo que sobra de este mes, sin marcar', () => {
    const html = render(<CloseMonthModal />, { shell: open });
    // Octubre: 70,000 − 49,149.71.
    expect(checkTexts(html)).toEqual([["Add this month's leftover (20,850.29 DOP) to November 2026's budget", false]]);

    // Si el mes se pasó, lo que se ofrece sumar es negativo.
    const over = seedState();
    setBudgets(over.months['2026-10']!, { dr: 40000 });
    expect(checkTexts(render(<CloseMonthModal />, { shell: open, state: over }))).toEqual([
      ["Add this month's leftover (-9,149.71 DOP) to November 2026's budget", false],
    ]);
  });

  it('si no sobra nada, la casilla no sale; los campos, sí', () => {
    const state = seedState();
    setBudgets(state.months['2026-10']!, { dr: monthCalc(seedState(), '2026-10').used });
    const html = render(<CloseMonthModal />, { shell: open, state });
    expect(els(html, 'input').map((i) => i.type)).toEqual(['number']);
    expect(text(html)).not.toContain('leftover');
    expect(text(html)).toContain("November 2026's budget starts with these amounts per account:");
  });

  it('varias cuentas con parte: un campo por cada una, en su moneda; lo que suman los ingresos no se hereda', () => {
    const state = seedState();
    setBudgets(state.months['2026-10']!, { us: 200, dr: 58248.5 });
    state.incomes.push(budgetIncome({ id: 'in-dr', amount: 4000 }));
    const html = render(<CloseMonthModal />, { shell: open, state });
    const numbers = els(html, 'input').filter((i) => i.type === 'number');
    expect(numbers.map((i) => i.value)).toEqual(['200', '58248.5']);
    expect(fieldLabels(html)).toEqual([
      ['Budget from US account (USD)', numbers[0]!.id],
      ['Budget from DR account (DOP)', numbers[1]!.id],
    ]);
    expect(new Set(numbers.map((i) => i.id)).size).toBe(2);
  });

  it('sin ninguna parte en el registro no hay campos ni introducción; el sobrante se sigue ofreciendo', () => {
    const state = seedState();
    setBudgets(state.months['2026-10']!, {});
    const html = render(<CloseMonthModal />, { shell: open, state });
    expect(els(html, 'input').map((i) => i.type)).toEqual(['checkbox']);
    expect(text(html)).not.toContain('budget starts with these amounts');
    expect(checkTexts(html)).toEqual([["Add this month's leftover (-49,149.71 DOP) to November 2026's budget", false]]);
  });

  it('si el mes siguiente ya existe no pregunta por su presupuesto: solo el texto del Excel y los botones', () => {
    // Se cierra septiembre (reabierto) con octubre ya creado.
    const state = seedState();
    state.months['2026-09']!.closed = false;
    const html = render(<CloseMonthModal />, { monthKey: '2026-09', state, shell: { closeDialog: { key: '2026-09', busy: false } } });
    const t = text(html);
    expect(t).toContain('Close September 2026');
    expect(t).toContain('October 2026 will be created with the same monthly expenses');
    expect(els(html, 'input')).toEqual([]);
    expect(els(html, 'label')).toEqual([]);
    expect(t).not.toContain('budget starts with these amounts');
    expect(t).not.toContain('leftover');
    expect(buttonTexts(html)).toEqual(['Cancel', 'Only on the page', 'Yes, add to Excel']);
    expect(html).not.toContain('disabled');
  });

  it('los campos son los del mes que se cierra, sea o no el que se está viendo', () => {
    // Se mira agosto y se cierra octubre.
    const html = render(<CloseMonthModal />, { monthKey: '2026-08', shell: open });
    expect(els(html, 'input').filter((i) => i.type === 'number').map((i) => i.value)).toEqual(['70000']);
    expect(checkTexts(html)[0]![0]).toContain('20,850.29 DOP');
  });

  it('en español: el texto del prototipo', () => {
    const html = render(<CloseMonthModal />, { lang: 'es', shell: open });
    const t = text(html);
    expect(t).toContain('Cerrar Octubre 2026');
    expect(t).toContain(
      'Se creará Noviembre 2026 con los mismos gastos mensuales, sin marcar como pagados. ¿Lo agrego también al Excel? Se descargará el archivo con todos los meses, incluido Noviembre 2026.',
    );
    expect(buttonTexts(html)).toEqual(['Cancelar', 'Solo en la página', 'Sí, agregar al Excel']);
    // El presupuesto del mes siguiente.
    expect(t).toContain('El presupuesto de Noviembre 2026 arranca con estos montos por cuenta: Presupuesto de DR account (DOP)');
    expect(fieldLabels(html).map(([label]) => label)).toEqual(['Presupuesto de DR account (DOP)']);
    expect(checkTexts(html)).toEqual([['Sumar el sobrante de este mes (20,850.29 DOP) al presupuesto de Noviembre 2026', false]]);
    has(els(html, 'input'), { type: 'number', value: '70000' });
  });

  it('en turco', () => {
    const html = render(<CloseMonthModal />, { lang: 'tr', shell: open });
    expect(text(html)).toContain('Ekim 2026 ayını kapat');
    expect(text(html)).toContain('Kasım 2026');
    expect(buttonTexts(html)).toEqual(['İptal', 'Yalnızca sayfada', "Evet, Excel'e ekle"]);
    expect(text(html)).toContain('Kasım 2026 bütçesi hesap başına şu tutarlarla başlar: DR account bütçesi (DOP)');
    expect(fieldLabels(html).map(([label]) => label)).toEqual(['DR account bütçesi (DOP)']);
    expect(checkTexts(html)).toEqual([['Bu ayın kalanını (20,850.29 DOP) Kasım 2026 bütçesine ekle', false]]);
  });

  it('mientras se cierra, los botones y los campos quedan deshabilitados', () => {
    const html = render(<CloseMonthModal />, { shell: { closeDialog: { key: '2026-10', busy: true } } });
    expect(els(html, 'button').filter((b) => 'disabled' in b)).toHaveLength(3);
    // El campo de la DR account y la casilla del sobrante.
    expect(els(html, 'input').map((i) => [i.type, 'disabled' in i])).toEqual([
      ['number', true],
      ['checkbox', true],
    ]);
    has(els(html, 'div'), { role: 'dialog', 'aria-busy': 'true' });
  });
});

describe('DeleteMonthModal', () => {
  const open = { deleteDialog: { key: '2026-10', busy: false } };

  it('cerrado no pinta nada', () => {
    expect(render(<DeleteMonthModal />)).toBe('');
  });

  it('abierto: pregunta por ese mes, dice qué se borra con sus cuentas y ofrece Cancel y Delete', () => {
    const html = render(<DeleteMonthModal />, { shell: open });
    const [dialog] = els(html, 'div').filter((d) => d.role === 'dialog');
    expect(dialog).toMatchObject({ 'aria-modal': 'true', 'aria-busy': 'false' });
    has(els(html, 'h2'), { id: dialog!['aria-labelledby']! });
    has(els(html, 'p'), { id: dialog!['aria-describedby']! });
    const t = text(html);
    expect(t).toContain('Delete October 2026?');
    // Octubre de los datos de ejemplo: 11 gastos mensuales, 7 transacciones y 1 envío.
    expect(t).toContain(
      'This deletes the month with its 11 monthly expenses, 7 transactions and 1 transfer. Account balances change accordingly. This cannot be undone.',
    );
    expect(buttonTexts(html)).toEqual(['Cancel', 'Delete']);
    expect(els(html, 'button').every((b) => b.type === 'button')).toBe(true);
    // El que borra va en rojo: es la acción sin vuelta atrás.
    expect(els(html, 'button')[1]!.class).toContain('destructive');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('<form');
  });

  it('las cuentas son las del mes que se va a borrar, sea el que se está viendo o no', () => {
    // Se mira octubre y se borra agosto (cerrado): 11 gastos, 10 transacciones y 2 envíos.
    const html = render(<DeleteMonthModal />, { shell: { deleteDialog: { key: '2026-08', busy: false } } });
    expect(text(html)).toContain('Delete August 2026?');
    expect(text(html)).toContain('its 11 monthly expenses, 10 transactions and 2 transfers.');

    const state = seedState();
    state.months['2026-10']!.fixed = state.months['2026-10']!.fixed.slice(0, 1);
    state.months['2026-10']!.tx = [];
    expect(text(render(<DeleteMonthModal />, { shell: open, state }))).toContain('its 1 monthly expense, 0 transactions and 1 transfer.');
  });

  it('en español y en turco', () => {
    const es = render(<DeleteMonthModal />, { lang: 'es', shell: open });
    expect(text(es)).toContain('¿Eliminar Octubre 2026?');
    expect(text(es)).toContain(
      'Se elimina el mes con sus 11 gastos mensuales, 7 transacciones y 1 envío. Los saldos de las cuentas cambian en consecuencia. Esto no se puede deshacer.',
    );
    expect(buttonTexts(es)).toEqual(['Cancelar', 'Eliminar']);
    const tr = render(<DeleteMonthModal />, { lang: 'tr', shell: open });
    expect(text(tr)).toContain('Ekim 2026 silinsin mi?');
    expect(text(tr)).toContain('Bu ay; 11 aylık gider, 7 işlem ve 1 transfer ile birlikte silinir.');
    expect(buttonTexts(tr)).toEqual(['İptal', 'Sil']);
  });

  it('mientras se borra, los botones quedan deshabilitados', () => {
    const html = render(<DeleteMonthModal />, { shell: { deleteDialog: { key: '2026-10', busy: true } } });
    expect(els(html, 'button').filter((b) => 'disabled' in b)).toHaveLength(2);
    has(els(html, 'div'), { role: 'dialog', 'aria-busy': 'true' });
  });
});

describe('Dialog y campos de formulario', () => {
  it('con onSubmit el contenido es un formulario, con su título, sus campos y su pie', () => {
    const html = renderToStaticMarkup(
      <I18nProvider lang="es">
        <Dialog
          title="Nueva meta"
          onCancel={() => {}}
          onSubmit={() => {}}
          maxWidth={480}
          footer={
            <>
              <DialogButton variant="danger" start>
                Eliminar meta
              </DialogButton>
              <DialogButton variant="quiet">Cancelar</DialogButton>
              <DialogButton variant="primary" type="submit">
                Guardar
              </DialogButton>
            </>
          }
        >
          <DialogFields>
            <Field label="Nombre" htmlFor="goal-name">
              <Input id="goal-name" value="Carro" readOnly maxLength={120} />
            </Field>
            <CheckField checked onChange={() => {}}>
              Esta meta tiene un objetivo
            </CheckField>
            <Field label="Ahorro mensual (USD)" htmlFor="goal-monthly">
              <Input id="goal-monthly" type="number" mono value={500} readOnly />
            </Field>
            <Field label="Mes objetivo" htmlFor="goal-end">
              <MonthPicker id="goal-end" label="Mes objetivo" value="2027-10" onChange={() => {}} fromYear={2026} toYear={2028} />
            </Field>
          </DialogFields>
        </Dialog>
      </I18nProvider>,
    );
    const [dialog] = els(html, 'div').filter((d) => d.role === 'dialog');
    expect(dialog).toMatchObject({ 'aria-modal': 'true', style: 'max-width:480px' });
    has(els(html, 'h2'), { id: dialog!['aria-labelledby']! });
    expect(els(html, 'form')).toHaveLength(1);
    expect(els(html, 'form')[0]).toHaveProperty('noValidate');
    // El formulario envuelve título, campos y pie: el botón de enviar queda dentro.
    expect(html.indexOf('<form')).toBeLessThan(html.indexOf('<h2'));
    expect(html.indexOf('</form>')).toBeGreaterThan(html.indexOf('Guardar'));
    expect(els(html, 'button').map((b) => b.type)).toEqual(['button', 'button', 'submit']);
    expect(buttonTexts(html)).toEqual(['Eliminar meta', 'Cancelar', 'Guardar']);

    has(els(html, 'label'), { for: 'goal-name' });
    has(els(html, 'input'), { id: 'goal-name', value: 'Carro', maxLength: '120', autoComplete: 'off' });
    has(els(html, 'input'), { type: 'checkbox', checked: '' });
    has(els(html, 'input'), { id: 'goal-monthly', type: 'number', value: '500' });
    expect(text(html)).toContain('Esta meta tiene un objetivo');
  });

  it('MonthPicker: dos listas, con los meses en el idioma actual y el valor elegido', () => {
    const picker = (lang: Language) =>
      renderToStaticMarkup(
        <I18nProvider lang={lang}>
          <MonthPicker id="end" label="Target month" value="2027-10" onChange={() => {}} fromYear={2026} toYear={2028} />
        </I18nProvider>,
      );
    const html = picker('en');
    has(els(html, 'div'), { role: 'group', 'aria-label': 'Target month' });
    expect(els(html, 'select').map((s) => [s.id, s['aria-label']])).toEqual([
      ['end', 'Target month: Month'],
      [undefined, 'Target month: Year'],
    ]);
    expect(html).toContain('<option value="10" selected="">October</option>');
    expect(html).toContain('<option value="2027" selected="">2027</option>');
    expect([...html.matchAll(/<option value="(\d{4})"/g)].map((m) => m[1])).toEqual(['2026', '2027', '2028']);
    expect([...html.matchAll(/<option value="(\d{1,2})"/g)]).toHaveLength(12);

    expect(picker('es')).toContain('<option value="10" selected="">Octubre</option>');
    expect(picker('tr')).toContain('<option value="10" selected="">Ekim</option>');
    has(els(picker('tr'), 'select'), { 'aria-label': 'Target month: Yıl' });
  });

  it('Select: una lista con el estilo de los formularios; las opciones, como las de CellSelect', () => {
    const html = renderToStaticMarkup(
      <>
        <Select id="cur" value="TRY" options={['DOP', 'USD', 'TRY']} onChange={() => {}} mono aria-label="Currency" />
        <Select value="dr" options={[{ value: 'us', label: 'US account' }, { value: 'dr', label: 'DR account' }]} onChange={() => {}} disabled />
        <Select value="gone" options={['a']} onChange={() => {}} />
      </>,
    );
    const [cur, account] = els(html, 'select');
    expect(cur).toMatchObject({ id: 'cur', 'aria-label': 'Currency' });
    expect(cur!.class).toContain('selectMono');
    expect(account).toHaveProperty('disabled');
    expect(html).toContain('<option value="DOP">DOP</option><option value="USD">USD</option><option value="TRY" selected="">TRY</option>');
    expect(html).toContain('<option value="us">US account</option><option value="dr" selected="">DR account</option>');
    // Un valor que no está entre las opciones se conserva como una más (y es la elegida).
    expect(html).toContain('<option value="gone" selected="">gone</option><option value="a">a</option>');
  });

  it('MonthPicker: el año del valor está siempre en la lista, aunque caiga fuera del rango', () => {
    const html = renderToStaticMarkup(<MonthPicker label="Start" value="2019-03" onChange={() => {}} fromYear={2026} toYear={2027} />);
    const years = [...html.matchAll(/<option value="(\d{4})"/g)].map((m) => m[1]);
    expect(years[0]).toBe('2019');
    expect(years.at(-1)).toBe('2027');
    expect(html).toContain('<option value="2019" selected="">2019</option>');
    expect(html).toContain('<option value="3" selected="">March</option>');
  });
});

describe('Notices', () => {
  it('lista los avisos con su botón de cerrar', () => {
    const notices = [{ id: 1, text: 'Could not save. The change was undone. Could not reach the server.' }];
    const html = render(<Notices />, { shell: { notices } });
    expect(html).toContain('role="status"');
    expect(text(html)).toContain('Could not save. The change was undone. Could not reach the server.');
    has(els(html, 'button'), { title: 'Close', 'aria-label': 'Dismiss notice' });
    has(els(render(<Notices />, { lang: 'es', shell: { notices } }), 'button'), { title: 'Cerrar', 'aria-label': 'Cerrar aviso' });
  });
});

describe('primitivas de tabla', () => {
  const table = (lang: Language) =>
    renderToStaticMarkup(
      <I18nProvider lang={lang}>
        <SheetTable minWidth={980} label="Monthly expenses">
          <thead>
            <tr>
              <Th align="center" width={44}>
                Paid
              </Th>
              <Th>Item</Th>
              <Th align="right" width={110}>
                Amount
              </Th>
              <Th blank width={32} />
            </tr>
          </thead>
          <tbody>
            <Tr unpaid>
              <Td kind="center">
                <CellCheckbox checked={false} label="Paid: Netflix" />
              </Td>
              <Td kind="edit">
                <CellText value="Netflix" label="Item" minWidth={120} />
              </Td>
              <Td kind="edit">
                <CellNumber value={1137.3} label="Amount" />
              </Td>
              <Td kind="action">
                <DeleteButton label="Delete Netflix" />
              </Td>
            </Tr>
            <AddRow onAdd={() => true}>
              <Td kind="edit">
                <CellDate value="2026-10-07" label="Date" />
              </Td>
              <Td kind="edit">
                <CellSelect value="Other" options={['DOP', 'USD']} label="Currency" mono />
              </Td>
              <Td kind="edit">
                <CellNumber value={0} blankZero placeholder="0.00" label="Amount" />
              </Td>
              <Td kind="add" colSpan={2}>
                <AddButton />
              </Td>
            </AddRow>
          </tbody>
        </SheetTable>
      </I18nProvider>,
    );

  it('una fila editable y una fila de agregar dan el marcado esperado', () => {
    const html = table('en');
    has(els(html, 'table'), { style: 'min-width:980px', 'aria-label': 'Monthly expenses' });

    const ths = els(html, 'th');
    expect(ths.every((th) => th.scope === 'col')).toBe(true);
    expect(ths.map((th) => th.style)).toEqual(['width:44px', undefined, 'width:110px', 'width:32px']);
    expect(ths[3]).toMatchObject({ 'aria-label': 'Actions' });

    const inputs = els(html, 'input');
    has(inputs, { type: 'checkbox', 'aria-label': 'Paid: Netflix' });
    has(inputs, { type: 'text', style: 'min-width:120px', value: 'Netflix', 'aria-label': 'Item' });
    // 1137.3, no "1,137.30": el input muestra el número tal cual, como el prototipo.
    has(inputs, { type: 'number', step: 'any', value: '1137.3', 'aria-label': 'Amount' });
    has(inputs, { type: 'date', value: '2026-10-07', 'aria-label': 'Date' });
    // blankZero: el 0 se muestra vacío para que se vea el placeholder.
    has(inputs, { type: 'number', value: '', placeholder: '0.00' });

    const buttons = els(html, 'button');
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
    has(buttons, { title: 'Delete', 'aria-label': 'Delete Netflix' });
    expect(html).toContain('>×</button>');
    expect(html).toContain('>Add</button>');
    has(els(html, 'td'), { colSpan: '2' });

    // Un valor fuera de la lista se conserva como opción (y es el seleccionado).
    expect(html).toContain('<option value="Other" selected="">Other</option><option value="DOP">DOP</option>');
  });

  it('los textos que ponen las propias primitivas salen en el idioma actual', () => {
    const es = table('es');
    expect(es).toContain('>Agregar</button>');
    has(els(es, 'button'), { title: 'Eliminar' });
    expect(els(es, 'th')[3]).toMatchObject({ 'aria-label': 'Acciones' });
    const tr = table('tr');
    expect(tr).toContain('>Ekle</button>');
    has(els(tr, 'button'), { title: 'Sil' });
  });

  it('CellText con sugerencias: sigue siendo texto libre, con su lista de valores propuestos', () => {
    const html = renderToStaticMarkup(<CellText value="Western Union" label="Via" suggestions={['Remitly', 'PayPal']} maxLength={60} />);
    const [input] = els(html, 'input');
    expect(input).toMatchObject({ type: 'text', value: 'Western Union', 'aria-label': 'Via', maxLength: '60' });
    has(els(html, 'datalist'), { id: input!.list! });
    expect(html).toContain('<option value="Remitly"></option><option value="PayPal"></option>');
    // Sin sugerencias, o en solo lectura, no hay lista.
    expect(renderToStaticMarkup(<CellText value="x" label="Item" />)).not.toContain('list');
    expect(renderToStaticMarkup(<CellText value="x" label="Via" suggestions={['Remitly']} readOnly />)).not.toContain('datalist');
  });

  it('sin <I18nProvider>, lo que cuelga de FinanzasContext sale en el idioma de su estado', () => {
    const html = renderToStaticMarkup(
      <FinanzasContext value={finanzas('2026-10', { ...seedState(), language: 'es' })}>
        <AddButton />
        <SummaryPanel sheet="ahorros" />
      </FinanzasContext>,
    );
    expect(html).toContain('>Agregar</button>');
    expect(text(html)).toContain('Dinero total');
    // Un proveedor explícito manda sobre el estado.
    const forced = renderToStaticMarkup(
      <I18nProvider lang="tr">
        <FinanzasContext value={finanzas('2026-10', { ...seedState(), language: 'es' })}>
          <AddButton />
        </FinanzasContext>
      </I18nProvider>,
    );
    expect(forced).toContain('>Ekle</button>');
  });

  it('sin proveedor de idioma ni estado salen en inglés, y un botón de eliminar sin etiqueta dice "Delete"', () => {
    const html = renderToStaticMarkup(
      <>
        <AddButton />
        <DeleteButton />
      </>,
    );
    expect(html).toContain('>Add</button>');
    has(els(html, 'button'), { title: 'Delete', 'aria-label': 'Delete' });
  });
});

describe('SummaryPanel · Month: partes del presupuesto pasadas', () => {
  /** Un envío que mueve presupuesto saca 800 USD de la parte de la US account, que no tiene nada. */
  function overrun(): AppState {
    const s = seedState();
    const m = s.months['2026-10']!;
    m.transfers = [...m.transfers, { id: 'big', monthKey: '2026-10', date: '2026-10-05', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 800, rate: 58, budget: true, fee: 0 }];
    return s;
  }
  const panel = (opts: Opts = {}) => render(<SummaryPanel sheet="mes" />, opts);

  it('una línea por cada parte en negativo, con su cuenta, y nada si ninguna lo está', () => {
    const lines = (html: string) => [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => text(m[1]!).trim());
    expect(lines(panel({ state: overrun() }))).toEqual(['Over budget by 800.00 USD · US account']);
    expect(text(panel())).not.toContain('Over budget by');
    expect(lines(panel())).toEqual([]);
  });

  it('en español y en turco', () => {
    expect(text(panel({ state: overrun(), lang: 'es' }))).toContain('Sobrepasado por 800.00 USD · US account');
    expect(text(panel({ state: overrun(), lang: 'tr' }))).toContain('Bütçe aşıldı: 800.00 USD · US account');
  });
});
