// Smoke test: the common components render with the sample data and show the figures from shared/calc.ts,
// with each language's texts. It renders to HTML in Node (no DOM): interactions are not tested, only that the
// markup, the texts and the calculations match.

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
  /** The add rows: open (as after pressing their "+ Add …") unless false is requested, which is how the screen starts. */
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

/** Visible text, without tags. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

/** Attributes of each <tag> in the HTML, regardless of the order React writes them in. */
function els(html: string, tag: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) =>
    Object.fromEntries([...m[1]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!, a[2] ?? ''])),
  );
}

const has = (list: Record<string, string>[], attrs: Record<string, string>) => expect(list).toContainEqual(expect.objectContaining(attrs));

/** Text of each <button>, in order. */
const buttonTexts = (html: string) => [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]!).trim());

/** The sample data with the lira as the main currency and its typed rates (the ones in shared/calc.test.ts). */
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

/** A movement in October's budget log, in the DR account. */
const logEntry = (over: Partial<BudgetEntry> & Pick<BudgetEntry, 'id' | 'amount' | 'kind'>): BudgetEntry => ({
  date: '2026-10-07',
  accountId: 'dr',
  note: '',
  ...over,
});

/** An October income with the "Adds to budget" checkbox, in the DR account. */
const budgetIncome = (over: Partial<Income> & Pick<Income, 'id' | 'amount'>): Income => ({
  date: '2026-10-03',
  desc: 'Refund',
  accountId: 'dr',
  cur: 'DOP',
  budget: true,
  ...over,
});

/** The sample data with a third account in liras (visible) and an old one, hidden and unused. */
function manyAccounts(): AppState {
  const s = seedState();
  s.accounts.push(
    { id: 'tr', name: 'TR account', currency: 'TRY', opening: 21000, hidden: false, sort: 2 },
    { id: 'old', name: 'Old savings', currency: 'USD', opening: 75, hidden: true, sort: 3 },
  );
  s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 42, date: '2026-10-01' });
  return s;
}

describe('SummaryPanel · Month: the budget', () => {
  const panel = (opts: Opts = {}) => render(<SummaryPanel sheet="mes" />, opts);

  it('October 2026: the figures from shared/calc.ts, in the main currency and in the second one', () => {
    const html = panel();
    const t = text(html);
    // The first card is the budget: total, "≈" and one row per account with its part.
    expect(t).toContain('Budget 70,000.00 DOP ≈ 1,191.29 USD');
    expect(t).toContain('US account');
    expect(t).toContain('DR account');
    expect(t).not.toContain('Month income − used');
    expect(t).toContain('Used 49,150 of 70,000 DOP');
    expect(t).toContain('Budget used Fixed paid 38,305 Transactions 10,845.00 Fixed pending 3,721 Free 17,129');
    expect(t).toContain('October 2026 Planned budget 70,000.00');
    expect(t).toContain('Used so far 49,149.71 Available 20,850.29 Available after pending fixed 17,129.43 Used in USD 836.45 USD');
    has(els(html, 'section'), { 'aria-label': 'October 2026 summary' });
    has(els(html, 'svg'), { 'aria-label': 'Budget used: 49,150 of 70,000 DOP' });
    has(els(html, 'table'), { 'aria-label': 'Budget' });
  });

  it('one row per account with a part: its editable part, its currency and its ×; the planned budget is no longer typed', () => {
    const html = panel();
    // Only the parts are fields (plus the amount in the add row): "Planned budget" is their sum.
    // The US account exists and is visible, but with no part this month it has no row.
    const inputs = els(html, 'input');
    expect(inputs.map((i) => [i.type, i.value, i['aria-label']])).toEqual([
      ['number', '70000', 'Budget from DR account, in DOP'],
      ['number', '', 'Amount of the new budget part'],
    ]);
    expect(inputs.every((i) => i.step === 'any')).toBe(true);
    expect(html).not.toContain('readOnly');
    const rows = [...html.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => text(m[1]!).trim());
    expect(rows).toEqual(['DR account DOP ×', 'US account New account… USD Add']);
    // The × removes the account from the budget (leaves its part at 0). Below the table, the leftover and the history.
    expect(buttonTexts(html)).toEqual(['×', 'Add', 'Cancel', '+ Extra budget', 'Add to budget', 'Budget history']);
    has(els(html, 'button'), { 'aria-label': 'Remove DR account from the budget' });
  });

  it('the add row: the visible accounts not yet in the budget, "New account…" at the end, the amount and "Add"', () => {
    const html = panel();
    expect(els(html, 'select')).toEqual([expect.objectContaining({ 'aria-label': 'Account to add to the budget' })]);
    // It starts on the first free account, and shows its currency.
    expect(html).toContain('<option value="us" selected="">US account</option><option value="__new__">New account…</option></select>');
    has(els(html, 'input'), { placeholder: '0.00', value: '', 'aria-label': 'Amount of the new budget part' });

    // With several free accounts all the visible ones appear, in their order; the hidden one (with no part) is not offered.
    const many = panel({ state: manyAccounts() });
    expect(many).toContain(
      '<option value="us" selected="">US account</option><option value="tr">TR account</option><option value="__new__">New account…</option></select>',
    );
    expect(many).not.toContain('Old savings');

    // With all the visible ones already in the budget only "New account…" is left, which leads to Savings.
    const state = seedState();
    setBudgets(state.months['2026-10']!, { us: 200, dr: 58248 });
    const full = panel({ state });
    // A select with a single option would not trigger anything: a button goes there.
    expect(els(full, 'option')).toHaveLength(0);
    expect(buttonTexts(full)).toEqual(['×', '×', 'New account…', 'Add', 'Cancel', '+ Extra budget', 'Add to budget', 'Budget history']);
    has(els(full, 'button'), { 'aria-label': 'Remove US account from the budget' });
  });

  it('no second currency: no "≈", no "Used in" and no figures in another currency in the month panel', () => {
    const state = { ...seedState(), secondCurrency: null };
    const t = text(panel({ state }));
    expect(t).toContain('Budget 70,000.00 DOP');
    expect(t).toContain('Used so far');
    expect(t).not.toContain('≈');
    expect(t).not.toContain('Used in');
  });

  it('parts in another currency add up converted at the month rate; a hidden account with a part stays in view', () => {
    const state = seedState();
    setBudgets(state.months['2026-10']!, { us: 200, dr: 58248 });
    const c = monthCalc(state, '2026-10');
    expect(text(panel({ state }))).toContain(`Budget ${f2(c.budget)} DOP ≈ ${f2(c.budgetSecond!)} USD`);
    expect(f2(c.budget)).toBe('70,000.00');

    // The US account gets hidden: with a part, its row stays (it adds to the total); without a part, it disappears.
    state.accounts.find((a) => a.id === 'us')!.hidden = true;
    const withPart = panel({ state });
    expect(els(withPart, 'input').map((i) => i['aria-label'])).toEqual([
      'Budget from US account, in USD',
      'Budget from DR account, in DOP',
      'Amount of the new budget part',
    ]);
    // The hidden one can also be removed from the budget.
    has(els(withPart, 'button'), { 'aria-label': 'Remove US account from the budget' });
    setBudgets(state.months['2026-10']!, { dr: 70000 });
    const withoutPart = panel({ state });
    expect(els(withoutPart, 'input').map((i) => i['aria-label'])).toEqual(['Budget from DR account, in DOP', 'Amount of the new budget part']);
    // And, hidden, it is not offered for adding either.
    expect(els(withoutPart, 'option')).toHaveLength(0);
    expect(buttonTexts(withoutPart)).toContain('New account…');
  });

  it('with the lira as the main currency, the whole panel is in TRY and the "≈" line in USD', () => {
    const state = tryState();
    const c = monthCalc(state, '2026-10');
    const html = panel({ state });
    const t = text(html);
    // 70,000 DOP / 58.76 × 40
    expect(f2(c.budget)).toBe('47,651.46');
    expect(t).toContain('Budget 47,651.46 TRY ≈ 1,191.29 USD');
    expect(t).not.toContain('Month income − used');
    expect(t).toContain(`Used ${f0(c.used)} of ${f0(c.budget)} TRY`);
    expect(t).toContain(`Fixed paid ${f0(c.fixedPaid)} Transactions ${f2(c.varSpent)} Fixed pending ${f0(c.pending)} Free ${f0(c.free)}`);
    expect(t).toContain(`Planned budget ${f2(c.budget)} Used so far ${f2(c.used)} Available ${f2(c.avail)}`);
    expect(t).toContain('Used in USD 836.45 USD');
    has(els(html, 'svg'), { 'aria-label': `Budget used: ${f0(c.used)} of ${f0(c.budget)} TRY` });
    // The parts stay in their account's currency: what is stored is not converted.
    // (The US account, with no part, no longer has a row; the last field is the empty amount of the add row.)
    expect(els(html, 'input').map((i) => i.value)).toEqual(['70000', '']);
    expect(t).toContain('DR account DOP');
    expect(t).not.toContain('DOP ≈');
  });

  it('in Spanish it keeps, word for word, the texts of version 1', () => {
    const html = panel({ lang: 'es' });
    const t = text(html);
    expect(t).toContain('Presupuesto 70,000.00 DOP ≈ 1,191.29 USD');
    expect(t).not.toContain('Ingreso del mes − usado');
    expect(t).toContain('Usado 49,150 de 70,000 DOP');
    expect(t).toContain('Fijos pagados 38,305 Transacciones 10,845.00 Fijos pendientes 3,721 Libre 17,129');
    expect(t).toContain('Octubre 2026 Presupuesto planeado 70,000.00');
    expect(t).toContain('Usado hasta hoy 49,149.71 Disponible 20,850.29 Disponible tras fijos pendientes 17,129.43 Usado en USD 836.45 USD');
    const inputs = els(html, 'input');
    has(inputs, { 'aria-label': 'Presupuesto de DR account, en DOP' });
    // The US account only has a field when it has a part in the month's budget.
    expect(inputs.map((i) => i['aria-label'])).not.toContain('Presupuesto de US account, en USD');
    const state = seedState();
    setBudgets(state.months['2026-10']!, { us: 200, dr: 58248 });
    has(els(panel({ lang: 'es', state }), 'input'), { 'aria-label': 'Presupuesto de US account, en USD' });
    // What is new: removing an account from the budget and the add row for another.
    has(inputs, { 'aria-label': 'Monto de la nueva parte del presupuesto' });
    has(els(html, 'select'), { 'aria-label': 'Cuenta que se suma al presupuesto' });
    has(els(html, 'button'), { 'aria-label': 'Quitar DR account del presupuesto' });
    expect(html).toContain('<option value="__new__">Cuenta nueva…</option>');
    expect(buttonTexts(html)).toEqual(['×', 'Agregar', 'Cancelar', '+ Presupuesto extra', 'Sumar al presupuesto', 'Historial del presupuesto']);
    has(els(html, 'section'), { 'aria-label': 'Resumen de Octubre 2026' });
    has(els(html, 'svg'), { 'aria-label': 'Presupuesto usado: 49,150 de 70,000 DOP' });
  });

  it('in Turkish: the agreed terms and the same figures, in the same format', () => {
    const html = panel({ lang: 'tr' });
    const t = text(html);
    has(els(html, 'input'), { 'aria-label': 'Yeni bütçe payının tutarı' });
    has(els(html, 'select'), { 'aria-label': 'Bütçeye eklenecek hesap' });
    has(els(html, 'button'), { 'aria-label': 'DR account hesabını bütçeden çıkar' });
    expect(html).toContain('<option value="__new__">Yeni hesap…</option>');
    expect(t).toContain('Bütçe 70,000.00 DOP ≈ 1,191.29 USD');
    // Account names are typed by the user: they are not translated.
    expect(t).toContain('US account');
    expect(t).toContain('Kullanılan 49,150 / 70,000 DOP');
    expect(t).toContain('İşlemler 10,845.00');
    expect(t).toContain('Ekim 2026 Planlanan bütçe 70,000.00');
    expect(t).toContain('Kalan 20,850.29');
    expect(t).toContain('USD olarak kullanılan 836.45 USD');
  });

  it('the donut draws background, pending, fixed and transactions, in that order', () => {
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
    // The background has no dashed stroke; fixed paid starts at 0 and transactions where the fixed ones end.
    const [track, pending, fixed, variable] = circles;
    expect(track!['stroke-dasharray']).toBeUndefined();
    expect(fixed!['stroke-dashoffset']).toBe('0');
    const len = (c: Record<string, string>) => +c['stroke-dasharray']!.split(' ')[0]!;
    expect(+variable!['stroke-dashoffset']!).toBeCloseTo(-len(fixed!), 8);
    expect(+pending!['stroke-dashoffset']!).toBeCloseTo(-(len(fixed!) + len(variable!)), 8);
  });

  it('in a closed month the budget parts are read-only: no × and no add row', () => {
    const html = panel({ monthKey: '2026-09' });
    // Only the DR account's part: the US account has no part in September.
    expect(els(html, 'input').map((i) => i['aria-label'])).toEqual(['Budget from DR account, in DOP']);
    expect(els(html, 'input').filter((i) => 'readOnly' in i)).toHaveLength(1);
    expect(els(html, 'select')).toEqual([]);
    // The only thing that can be pressed is the history, which only expands.
    expect(buttonTexts(html)).toEqual(['Budget history']);
    expect(text(html)).not.toContain('New account…');
    expect(text(html)).toContain('September 2026 Planned budget 70,000.00');
  });

  it('over budget, the center and the available figure are in red', () => {
    const state = seedState();
    setBudgets(state.months['2026-10']!, { dr: 40000 });
    const html = panel({ state });
    expect(text(html)).toContain('Available -9,149.71');
    expect([...html.matchAll(/errorText/g)].length).toBeGreaterThanOrEqual(3);
  });

  it("an account's × only shows if its part comes from the log: what incomes put in is not removed from here", () => {
    const state = seedState();
    // An income that raises the budget and goes into the US account, which has no part in the log.
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

    // With a part in the log and also an income, the × stays: it removes what is in the log.
    const both = seedState();
    both.incomes.push(budgetIncome({ id: 'in-dr', amount: 4000 }));
    const mixed = panel({ state: both });
    has(els(mixed, 'input'), { value: '74000', 'aria-label': 'Budget from DR account, in DOP' });
    has(els(mixed, 'button'), { 'aria-label': 'Remove DR account from the budget' });
  });

  describe('the leftover from the previous month', () => {
    /** The leftover line: its text, and the buttons it carries. */
    const leftover = (opts: Opts = {}) => {
      const html = panel(opts);
      const block = /<div class="[^"]*leftover[^"]*">.*?<\/div>/.exec(html)?.[0];
      return block === undefined ? null : { text: text(block).trim(), buttons: buttonTexts(block), html: block };
    };

    it("offer: what was left over in September, with the button to add it to October's budget", () => {
      const line = leftover();
      // 70,000 − 66,636.54.
      expect(line!.text).toBe('Leftover from last month: 3,363.46 DOP Add to budget');
      expect(line!.buttons).toEqual(['Add to budget']);
      has(els(line!.html, 'button'), { type: 'button' });
      expect(line!.html).toContain('inkText');
      // It goes below the accounts table and before the history.
      const html = panel();
      const order = ['</table>', 'Leftover from last month:', 'Budget history'].map((x) => html.indexOf(x));
      expect(order.every((x) => x >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('added: once added, it says "added" instead of the button', () => {
      const state = seedState();
      state.months['2026-10']!.budgetLog.push(logEntry({ id: 'bg-left', amount: 3363.46, kind: 'leftover' }));
      const line = leftover({ state });
      expect(line!.text).toBe('Leftover from last month: 3,363.46 DOP added');
      expect(line!.buttons).toEqual([]);
      // And the budget already includes it.
      expect(text(panel({ state }))).toContain('Budget 73,363.46 DOP');
    });

    it('plain: in a closed month, only the figure', () => {
      // September shows what was left over in August.
      const avail = monthCalc(seedState(), '2026-08').avail;
      const line = leftover({ monthKey: '2026-09' });
      expect(line!.text).toBe(`Leftover from last month: ${f2(avail)} DOP`);
      expect(line!.buttons).toEqual([]);
    });

    it('plain: if 0 was left over there is nothing to add', () => {
      const state = seedState();
      setBudgets(state.months['2026-09']!, { dr: monthCalc(seedState(), '2026-09').used });
      const line = leftover({ state });
      expect(line!.text).toBe('Leftover from last month: 0.00 DOP');
      expect(line!.buttons).toEqual([]);
    });

    it('with no previous month there is no line', () => {
      expect(leftover({ monthKey: '2026-08' })).toBeNull();
      expect(text(panel({ monthKey: '2026-08' }))).not.toContain('Leftover');
      expect(buttonTexts(panel({ monthKey: '2026-08' }))).toEqual(['Budget history']);
    });

    it('a negative leftover (the previous month went over) is in red and can also be added', () => {
      const state = seedState();
      setBudgets(state.months['2026-09']!, { dr: 60000 });
      const line = leftover({ state });
      expect(line!.text).toBe('Leftover from last month: -6,636.54 DOP Add to budget');
      expect(line!.html).toContain('errorText');
      expect(line!.html).not.toContain('inkText');
    });

    it("it is in the user's main currency", () => {
      const state = tryState();
      const line = leftover({ state });
      expect(line!.text).toBe(`Leftover from last month: ${f2(monthCalc(tryState(), '2026-09').avail)} TRY Add to budget`);
    });

    it('in Spanish and in Turkish', () => {
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

  it('the budget history starts collapsed: only its button, no table or rows', () => {
    for (const monthKey of ['2026-10', '2026-09']) {
      const html = panel({ monthKey });
      const toggle = els(html, 'button').filter((b) => 'aria-controls' in b);
      expect(toggle).toEqual([expect.objectContaining({ type: 'button', 'aria-expanded': 'false' })]);
      // The only table is the one with the parts per account.
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

  it('does not show the total money or the balances: that belongs to Savings', () => {
    const t = text(panel());
    expect(t).not.toContain('Total money');
    expect(t).not.toContain('Money by account');
    expect(t).not.toContain('1,012,844');
    expect(t).not.toContain('Add account');
  });
});

describe('SummaryPanel · Savings: the total money', () => {
  const panel = (opts: Opts = {}) => render(<SummaryPanel sheet="ahorros" />, { ...opts, shell: { sheet: 'ahorros', ...opts.shell } });

  it('October 2026: the total of the visible accounts and the balance of each one, from shared/calc.ts', () => {
    const b = balances(seedState(), '2026-10');
    const html = panel();
    const t = text(html);
    // 13,482 USD × 58.76 + 220,641.93 DOP
    expect(f2(b.totalMain)).toBe('1,012,844.25');
    expect(f2(b.totalSecond!)).toBe('17,236.97');
    expect(t).toContain('Total money 1,012,844.25 DOP ≈ 17,236.97 USD');
    has(els(html, 'section'), { 'aria-label': 'October 2026 summary' });
    has(els(html, 'table'), { 'aria-label': 'Accounts' });

    // One row per visible account: editable name, editable balance (to the cent) and its currency.
    const inputs = els(html, 'input');
    expect(inputs.slice(0, 4).map((i) => [i.type, i.value, i['aria-label']])).toEqual([
      ['text', 'US account', 'Account name'],
      ['number', '13482', 'Balance of US account, in USD'],
      ['text', 'DR account', 'Account name'],
      ['number', '220641.93', 'Balance of DR account, in DOP'],
    ]);
    // October is the last month: the balances can be corrected.
    expect(html).not.toContain('readOnly');
    expect(buttonTexts(html)).toEqual(['Hide', 'Hide', 'Add', 'Cancel']);
    has(els(html, 'button'), { 'aria-label': 'Hide US account' });
    has(els(html, 'button'), { 'aria-label': 'Hide DR account' });
  });

  it('the add row: name, opening balance, currency (starts on the main one) and "Add account"', () => {
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

  it('the money-by-account donut: one segment per visible account with a balance, the total in the center and its legend', () => {
    const b = balances(seedState(), '2026-10');
    const html = panel();
    const t = text(html);
    expect(t).toContain('Total 1,012,844 DOP');
    expect(t).toContain('Money by account US account 792,202.32 DR account 220,641.93');
    has(els(html, 'svg'), { 'aria-label': 'Money by account: 1,012,844 DOP in total', viewBox: '0 0 168 168' });

    // Background and, on top, one segment per account: its length is its share of the total, and they are chained.
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

  it("the segment colors come from the user's theme, as many shades as accounts", () => {
    const defaults = ringShades(null, 2);
    const html = panel();
    expect(els(html, 'circle').slice(1).map((c) => c.style)).toEqual(defaults.map((color) => `stroke:${color}`));
    // The legend uses the same ones.
    for (const color of defaults) expect(html).toContain(`background:${color}`);

    const ocean = THEME_PRESETS.find((p) => p.id === 'ocean')!.colors;
    const themed = panel({ state: { ...seedState(), theme: ocean } });
    const shades = ringShades(ocean, 2);
    expect(shades).not.toEqual(defaults);
    expect(els(themed, 'circle').slice(1).map((c) => c.style)).toEqual(shades.map((color) => `stroke:${color}`));

    // With three accounts with a balance, three different shades; the middle one is the accent.
    const three = panel({ state: manyAccounts() });
    const strokes = els(three, 'circle').slice(1).map((c) => c.style);
    expect(strokes).toEqual(ringShades(null, 3).map((color) => `stroke:${color}`));
    expect(new Set(strokes).size).toBe(3);
    expect(strokes[1]).toBe('stroke:#2f7d52');
  });

  it('an account with no balance or a negative one takes up nothing in the donut, but stays in the table and the legend', () => {
    const state = seedState();
    state.accounts.find((a) => a.id === 'us')!.opening = -20000; // balance: −8,518 USD
    const b = balances(state, '2026-10');
    const html = panel({ state });
    expect(els(html, 'circle')).toHaveLength(2);
    expect(els(html, 'circle')[1]!.style).toBe(`stroke:${ringShades(null, 1)[0]}`);
    const t = text(html);
    expect(t).toContain(`US account ${f2(b.accounts[0]!.inMain)} DR account 220,641.93`);
    expect(t).toContain(`Total money ${f2(b.totalMain)} DOP`);
    has(els(html, 'input'), { value: '-8518', 'aria-label': 'Balance of US account, in USD' });
    // Negative total money: in red.
    expect(b.totalMain).toBeLessThan(0);
    expect([...html.matchAll(/errorText/g)].length).toBeGreaterThanOrEqual(2);
  });

  it("with the lira as the main currency: total, center and legend in TRY; the balances, in each account's currency", () => {
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

  it('in a month that is not the last one the balances are those of that time and cannot be corrected', () => {
    const b = balances(seedState(), '2026-08');
    const html = panel({ monthKey: '2026-08' });
    expect(text(html)).toContain(`Total money ${f2(b.totalMain)} DOP ≈ ${f2(b.totalSecond!)} USD`);
    // US: 2,000 + 5,800 − 1,800 − 106. DR: 60,000 + 104,730 − 27,850 − 35,750.26.
    has(els(html, 'input'), { value: '5894', 'aria-label': 'Balance of US account, in USD' });
    has(els(html, 'input'), { value: '101129.74', 'aria-label': 'Balance of DR account, in DOP' });
    // Only the two balances become read-only: renaming, hiding and adding do not depend on the month.
    expect(els(html, 'input').filter((i) => 'readOnly' in i).map((i) => i['aria-label'])).toEqual([
      'Balance of US account, in USD',
      'Balance of DR account, in DOP',
    ]);
    expect(buttonTexts(html)).toEqual(['Hide', 'Hide', 'Add', 'Cancel']);
  });

  it('hidden accounts neither add to the total nor appear in the table: they stay collapsed behind "Hidden accounts (N)"', () => {
    const state = manyAccounts();
    const b = balances(state, '2026-10');
    const html = panel({ state });
    const t = text(html);
    // Three visible (the TR account, in liras) and one hidden.
    expect(b.accounts).toHaveLength(4);
    expect(t).toContain(`Total money ${f2(b.totalMain)} DOP`);
    expect(b.totalMain).toBeCloseTo(13482 * 58.76 + 220641.93 + (21000 / 42) * 58.76, 6);
    // Nothing references the TR account (neither movements nor budget): besides hiding it, it can also be deleted with its ×.
    expect(buttonTexts(html)).toEqual(['Hide', 'Hide', 'Hide', '×', 'Add', 'Cancel', 'Hidden accounts (1)']);
    expect(els(html, 'button').map((b) => b['aria-label']).filter((l) => l?.startsWith('Delete '))).toEqual(['Delete TR account']);
    has(els(html, 'button'), { 'aria-expanded': 'false' });
    expect(t).not.toContain('Old savings');
    expect(t).toContain('TR account 29,380.00');
    has(els(html, 'input'), { value: '21000', 'aria-label': 'Balance of TR account, in TRY' });
  });

  it('with a single visible account, hiding it is not offered', () => {
    const state = seedState();
    state.accounts.find((a) => a.id === 'us')!.hidden = true;
    const html = panel({ state });
    expect(buttonTexts(html)).toEqual(['Add', 'Cancel', 'Hidden accounts (1)']);
    expect(text(html)).toContain('Total money 220,641.93 DOP');
  });

  it('with no second currency the total has no "≈" line', () => {
    const t = text(panel({ state: { ...seedState(), secondCurrency: null } }));
    expect(t).toContain('Total money 1,012,844.25 DOP');
    expect(t).not.toContain('≈');
  });

  it('in Spanish and in Turkish', () => {
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

  it('does not show the budget donut or the budget list: that belongs to Month', () => {
    const t = text(panel());
    expect(t).not.toContain('Budget');
    expect(t).not.toContain('Planned budget');
    expect(t).not.toContain('Fixed paid');
    expect(t).not.toContain('Used so far');
    expect(t).not.toContain('Month income');
  });
});

describe('TopBar', () => {
  it('current month: brand, subtitle, months with their suffix, Excel, rate and settings', () => {
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
    // The settings panel is closed.
    has(els(html, 'button'), { 'aria-expanded': 'false' });
    expect(html).not.toContain('role="dialog"');
  });

  it('no second currency: the rate needed (the USD one, with accounts in USD) or none if everything is in one currency', () => {
    const state = { ...seedState(), secondCurrency: null };
    expect(text(render(<TopBar />, { state }))).toContain('Month rate 1 USD = 58.76 DOP');

    const single = { ...seedState(), secondCurrency: null };
    single.accounts = single.accounts.filter((a) => a.currency === 'DOP');
    for (const m of Object.values(single.months)) {
      m.rates = [];
      m.fixed = m.fixed.map((f) => ({ ...f, cur: 'DOP' }));
      m.tx = m.tx.map((tx) => ({ ...tx, cur: 'DOP' }));
    }
    expect(text(render(<TopBar />, { state: single }))).not.toContain('Month rate');
  });

  it('with several users there is a select next to the brand, with the current one chosen and styled like the month one', () => {
    const html = render(<TopBar />, { user: EDA, shell: { user: EDA } });
    const selects = els(html, 'select');
    expect(selects.map((s) => s['aria-label'])).toEqual(['User', 'Month']);
    expect(html).toContain('<option value="frank">Frank</option><option value="eda" selected="">Eda</option>');
    // Same style: the month select only adds its minimum width.
    const [userSelect, monthSelect] = selects;
    expect(monthSelect!.class!.split(' ')).toContain(userSelect!.class!);
    // It goes before the month select, right after the brand and the subtitle.
    expect(html.indexOf('aria-label="User"')).toBeGreaterThan(html.indexOf('Current month'));
    expect(html.indexOf('aria-label="User"')).toBeLessThan(html.indexOf('aria-label="Previous month"'));
  });

  it('with a single user the select is not shown', () => {
    const html = render(<TopBar />, { shell: { users: [FRANK] } });
    expect(els(html, 'select').map((s) => s['aria-label'])).toEqual(['Month']);
    expect(html).not.toContain('>Frank<');
  });

  it('subtitles for a closed month and for savings', () => {
    expect(text(render(<TopBar />, { monthKey: '2026-08' }))).toContain('FE Finance Month summary');
    expect(text(render(<TopBar />, { monthKey: '2026-08' }))).toContain('1 USD = 58.18 DOP');
    expect(text(render(<TopBar />, { shell: { sheet: 'ahorros' } }))).toContain('FE Finance Savings');
  });

  describe('the month rate: 1 second = rate main, and where it comes from', () => {
    /** The text of the rate block and the classes of its pieces. */
    const rate = (opts: Opts = {}) => {
      const html = render(<TopBar />, opts);
      const block = /<div class="[^"]*rate[^"]*"><span>.*?<\/div>/.exec(html)![0];
      const spans = [...block.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => ({ attrs: m[1]!, text: m[2]! }));
      return { text: text(block).trim(), chip: spans[1]!, note: spans[2] };
    };

    it('typed for this month: only the rate, with no note (the source stays in the title)', () => {
      const r = rate();
      expect(r.text).toBe('Month rate 1 USD = 58.76 DOP');
      expect(r.note).toBeUndefined();
      expect(r.chip.attrs).toContain('title="typed for this month"');
      expect(r.chip.attrs).not.toContain('chipWarn');
    });

    it("from the month's transfers: a dimmed note next to it", () => {
      const r = rate({ monthKey: '2026-08' });
      expect(r.text).toBe("Month rate 1 USD = 58.18 DOP from this month's transfers");
      expect(r.note!.attrs).toContain('rateHint');
      expect(r.note!.attrs).not.toContain('rateWarn');
      expect(r.chip.attrs).not.toContain('chipWarn');
    });

    it('from an earlier month: it says which one', () => {
      const state = seedState();
      state.months['2026-10']!.rates = [];
      state.months['2026-10']!.transfers = [];
      const r = rate({ state });
      // September: (1,500 × 58.55 + 800 × 58.62) / 2,300
      expect(r.text).toBe('Month rate 1 USD = 58.57 DOP from September 2026');
      expect(r.note!.attrs).toContain('rateHint');
      expect(rate({ state, lang: 'es' }).text).toBe('Tasa del mes 1 USD = 58.57 DOP de septiembre 2026');
      expect(rate({ state, lang: 'tr' }).text).toBe('Ay kuru 1 USD = 58.57 DOP Eylül 2026 ayından');
    });

    it('crossed through the third currency: it says which one', () => {
      const state = seedState();
      state.secondCurrency = 'TRY';
      state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
      const r = rate({ state });
      // 58.76 DOP per USD / 40 TRY per USD
      expect(r.text).toBe('Month rate 1 TRY = 1.47 DOP crossed through USD');
      expect(r.note!.attrs).toContain('rateHint');
    });

    it('default value (nobody has typed it): it is highlighted in the rate and in the warning', () => {
      const state = seedState();
      state.secondCurrency = 'TRY';
      const r = rate({ state });
      // DEFAULT_USD_RATES: 58.76 DOP and 42 TRY per USD.
      expect(r.text).toBe('Month rate 1 TRY = 1.40 DOP default value, not set yet');
      expect(r.chip.attrs).toContain('chipWarn');
      expect(r.note!.attrs).toContain('rateWarn');
      expect(r.note!.attrs).not.toContain('rateHint');
      expect(rate({ state, lang: 'es' }).text).toBe('Tasa del mes 1 TRY = 1.40 DOP valor por defecto, aún sin definir');
      expect(rate({ state, lang: 'tr' }).text).toBe('Ay kuru 1 TRY = 1.40 DOP varsayılan değer, henüz girilmedi');
    });

    it("follows the user's currencies; a rate below 1 has four decimals", () => {
      expect(rate({ state: tryState() }).text).toBe('Month rate 1 USD = 40.00 TRY');
      const flipped = seedState();
      flipped.mainCurrency = 'USD';
      flipped.secondCurrency = 'DOP';
      expect(rate({ state: flipped }).text).toBe('Month rate 1 DOP = 0.0170 USD');
    });
  });

  it('both Excel buttons warn that the workbook is a summary in USD and DOP', () => {
    const html = render(<TopBar />);
    const note = 'The Excel file is a summary in USD and DOP, with two accounts, until it is redesigned.';
    has(els(html, 'label'), { title: note });
    has(els(html, 'button'), { title: note });
  });

  it('status of the Excel import, in the current language', () => {
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

  it('in Spanish: the texts of version 1 (the brand is not translated)', () => {
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

  it('in Turkish', () => {
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
  /** The dialog's checkboxes, in order: their text and whether they are checked. */
  const checks = (html: string) =>
    [...html.matchAll(/<label\b[^>]*><input\b([^>]*)\/><span>(.*?)<\/span><\/label>/g)].map((m) => [text(m[2]!).trim(), /\bchecked=""/.test(m[1]!)]);

  it('the bar does not render it until "Download Excel" is pressed', () => {
    const html = render(<TopBar />);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('type="checkbox"');
    expect(text(html)).not.toContain('All months');
  });

  it('open: one checkbox per month, from newest to oldest, all checked, and "Download (3)"', () => {
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
    // It is a form: Enter or the primary button downloads.
    expect(html).toContain('<form');
    expect(buttonTexts(html)).toEqual(['Cancel', 'Download (3)']);
    expect(els(html, 'button').map((b) => b.type)).toEqual(['button', 'submit']);
    expect(html).not.toContain('disabled');
  });

  it('with some months: "All months" stays unchecked and the button counts the chosen ones', () => {
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

  it('with no month chosen it cannot be downloaded', () => {
    const html = render(<DownloadExcelDialog months={KEYS} initial={[]} onCancel={noop} onDownload={noop} />);
    expect(checks(html).map(([, on]) => on)).toEqual([false, false, false, false]);
    expect(buttonTexts(html)).toEqual(['Cancel', 'Download (0)']);
    const [cancel, download] = els(html, 'button');
    expect(cancel).not.toHaveProperty('disabled');
    expect(download).toHaveProperty('disabled');
  });

  it('in Spanish and in Turkish', () => {
    const es = render(<DownloadExcelDialog months={KEYS} initial={['2026-10']} onCancel={noop} onDownload={noop} />, { lang: 'es' });
    expect(checks(es).map(([name]) => name)).toEqual(['Todos los meses', 'Octubre 2026', 'Septiembre 2026', 'Agosto 2026']);
    expect(buttonTexts(es)).toEqual(['Cancelar', 'Descargar (1)']);
    expect(text(es)).toContain('Descargar Excel');
    const tr = render(<DownloadExcelDialog months={KEYS} onCancel={noop} onDownload={noop} />, { lang: 'tr' });
    expect(checks(tr).map(([name]) => name)).toEqual(['Tüm aylar', 'Ekim 2026', 'Eylül 2026', 'Ağustos 2026']);
    expect(buttonTexts(tr).at(-1)).toBe('İndir (3)');
    expect(text(tr)).toContain('Excel indir');
  });

  it("toggleMonth: checks and unchecks a month, always in the list's order", () => {
    expect(toggleMonth(KEYS, KEYS, '2026-09', false)).toEqual(['2026-08', '2026-10']);
    expect(toggleMonth(KEYS, ['2026-10'], '2026-08', true)).toEqual(['2026-08', '2026-10']);
    expect(toggleMonth(KEYS, ['2026-08', '2026-10'], '2026-09', true)).toEqual(KEYS);
    // Checking one already checked or unchecking one that was not checked changes nothing.
    expect(toggleMonth(KEYS, ['2026-10'], '2026-10', true)).toEqual(['2026-10']);
    expect(toggleMonth(KEYS, ['2026-10'], '2026-08', false)).toEqual(['2026-10']);
    expect(toggleMonth(KEYS, ['2026-10'], '2026-10', false)).toEqual([]);
  });
});

describe('SettingsPanel', () => {
  const panel = (opts: Opts = {}) => render(<SettingsPanel id="settings" opener={{ current: null }} onClose={() => {}} />, opts);

  /** The theme buttons: they come after the 3 languages, the 6 currencies (3 per row) and the "None" option of the second one. */
  const FIRST_PRESET = 10;

  it('four sections: language, currencies, appearance and the Excel note', () => {
    const html = panel();
    has(els(html, 'div'), { id: 'settings', role: 'dialog', 'aria-label': 'Settings' });
    expect([...html.matchAll(/<h2\b[^>]*>(.*?)<\/h2>/g)].map((m) => m[1])).toEqual(['Language', 'Currencies', 'Appearance', 'Excel']);
    expect(text(html)).toContain('Excel The Excel file is a summary in USD and DOP, with two accounts, until it is redesigned.');
  });

  it('currencies: the main one and the second one, each among the three, with the current one marked', () => {
    const html = panel();
    expect(text(html)).toContain('Currencies Main currency DOP USD TRY Second currency DOP USD TRY None Default account');
    const codes = els(html, 'button').slice(3, FIRST_PRESET);
    expect(buttonTexts(html).slice(3, FIRST_PRESET)).toEqual(['DOP', 'USD', 'TRY', 'DOP', 'USD', 'TRY', 'None']);
    expect(codes.map((b) => b['aria-pressed'])).toEqual(['true', 'false', 'false', 'false', 'true', 'false', 'false']);
    // Each row is a group with the name of its setting.
    const groups = els(html, 'div').filter((d) => d.role === 'group' && d['aria-labelledby']);
    expect(groups).toHaveLength(2);
    for (const group of groups) has(els(html, 'span'), { id: group['aria-labelledby']! });

    const tr = els(panel({ state: tryState() }), 'button').slice(3, FIRST_PRESET);
    expect(tr.map((b) => b['aria-pressed'])).toEqual(['false', 'false', 'true', 'false', 'true', 'false', 'false']);

    // With no second currency, "None" is the marked one.
    const none = els(panel({ state: { ...seedState(), secondCurrency: null } }), 'button').slice(3, FIRST_PRESET);
    expect(none.map((b) => b['aria-pressed'])).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'true']);
  });

  it('default account: the visible accounts and "Automatic", which says which one it stands for', () => {
    const html = panel();
    const [select] = els(html, 'select');
    has(els(html, 'label'), { for: select!.id! });
    expect(html).toContain('<option value="">Automatic (DR account)</option><option value="us">US account</option><option value="dr" selected="">DR account</option>');

    // With no saved choice: "Automatic" is the chosen one.
    const auto = panel({ state: { ...seedState(), defaultAccountId: null } });
    expect(auto).toContain('<option value="" selected="">Automatic (DR account)</option>');

    // A hidden account is not offered, and if it was the chosen one the automatic one wins (shared/calc defaultAccount).
    const state = seedState();
    state.accounts.find((a) => a.id === 'dr')!.hidden = true;
    const hidden = panel({ state });
    expect(hidden).toContain('<option value="" selected="">Automatic (US account)</option><option value="us">US account</option></select>');
    expect(hidden).not.toContain('DR account');
  });

  it('the three languages, each with its own name, and the current one marked', () => {
    const html = panel({ state: { ...seedState(), language: 'tr' }, lang: 'tr' });
    const langs = els(html, 'button').filter((b) => 'lang' in b);
    expect(langs.map((b) => [b.lang, b['aria-pressed']])).toEqual([
      ['en', 'false'],
      ['es', 'false'],
      ['tr', 'true'],
    ]);
    expect(buttonTexts(html).slice(0, 3)).toEqual(['English', 'Español', 'Türkçe']);
  });

  it('the preset themes as named swatches; with no custom theme, the original is the chosen one', () => {
    const html = panel();
    const names = buttonTexts(html).slice(FIRST_PRESET, FIRST_PRESET + THEME_PRESETS.length);
    expect(names).toEqual(['Forest', 'Ocean', 'Plum', 'Terracotta', 'Rose', 'Amber', 'Slate']);
    const presets = els(html, 'button').slice(FIRST_PRESET, FIRST_PRESET + THEME_PRESETS.length);
    expect(presets.map((b) => b['aria-pressed'])).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false']);
    // Each swatch shows its three colors.
    for (const preset of THEME_PRESETS) {
      expect(html).toContain(`background:${preset.colors.header}`);
      expect(html).toContain(`background:${preset.colors.accent}`);
      expect(html).toContain(`background:${preset.colors.background}`);
    }
    has(els(html, 'div'), { role: 'group', 'aria-label': 'Themes' });
  });

  it('three colors with their hex value and the reset button (disabled if there is nothing to reset)', () => {
    const html = panel();
    const colors = els(html, 'input').filter((i) => i.type === 'color');
    expect(colors.map((c) => c.value)).toEqual(['#2f7d52', '#1d1f1c', '#efeee8']);
    const t = text(html);
    expect(t).toContain('Accent #2f7d52 Header #1d1f1c Background #efeee8');
    // Each color has its label (the panel's first label is the default account's).
    const labels = els(html, 'label').map((l) => l.for);
    expect(labels.slice(1)).toEqual(colors.map((c) => c.id));
    expect(buttonTexts(html).at(-1)).toBe('Reset to default');
    expect(els(html, 'button').at(-1)).toHaveProperty('disabled');
  });

  it('with a custom theme: its colors, its swatch marked and reset available', () => {
    const ocean = THEME_PRESETS.find((p) => p.id === 'ocean')!.colors;
    const html = panel({ state: { ...seedState(), theme: ocean } });
    expect(els(html, 'input').filter((i) => i.type === 'color').map((c) => c.value)).toEqual([ocean.accent, ocean.header, ocean.background]);
    const presets = els(html, 'button').slice(FIRST_PRESET, FIRST_PRESET + THEME_PRESETS.length);
    expect(presets.map((b) => b['aria-pressed'])).toEqual(['false', 'true', 'false', 'false', 'false', 'false', 'false']);
    expect(els(html, 'button').at(-1)).not.toHaveProperty('disabled');

    // Colors that belong to no preset theme: no swatch marked.
    const custom = panel({ state: { ...seedState(), theme: { ...ocean, accent: '#123456' } } });
    expect(els(custom, 'button').slice(FIRST_PRESET, FIRST_PRESET + THEME_PRESETS.length).every((b) => b['aria-pressed'] === 'false')).toBe(true);
    expect(text(custom)).toContain('Accent #123456');
  });

  it('in Spanish and in Turkish', () => {
    const es = text(panel({ lang: 'es' }));
    expect(es).toContain('Idioma');
    expect(es).toContain('Monedas Moneda principal DOP USD TRY Segunda moneda DOP USD TRY Ninguna Cuenta por defecto Automática (DR account)');
    expect(es).toContain('Apariencia');
    expect(es).toContain('Acento #2f7d52 Barra superior #1d1f1c Fondo #efeee8 Restablecer');
    expect(es).toContain('Bosque');
    expect(es).toContain('El Excel es un resumen en USD y DOP, con dos cuentas, hasta que se rediseñe.');
    const tr = text(panel({ lang: 'tr' }));
    expect(tr).toContain('Dil');
    expect(tr).toContain('Para birimleri Ana para birimi DOP USD TRY İkinci para birimi DOP USD TRY Yok Varsayılan hesap Otomatik (DR account)');
    expect(tr).toContain('Görünüm');
    expect(tr).toContain('Varsayılana dön');
  });
});

describe('BottomTabs', () => {
  it('marks the active sheet and hides the development utilities', () => {
    const html = render(<BottomTabs />, { shell: { sheet: 'ahorros' } });
    expect(els(html, 'button').map((b) => b['aria-current'])).toEqual([undefined, 'page']);
    expect(buttonTexts(html)).toEqual(['Month', 'Savings']);
    has(els(html, 'nav'), { 'aria-label': 'Sheets' });
    expect(html).not.toContain('Start blank');
  });

  it('with devTools the two buttons appear', () => {
    expect(buttonTexts(render(<BottomTabs />, { shell: { devTools: true } }))).toEqual(['Month', 'Savings', 'Start blank', 'Restore sample data']);
  });

  it('in Spanish and in Turkish', () => {
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
  /** The field labels (<Field>): their text and the id of the control they point to. */
  const fieldLabels = (html: string) => [...html.matchAll(/<label\b[^>]*\bfor="([^"]*)"[^>]*>(.*?)<\/label>/g)].map((m) => [text(m[2]!).trim(), m[1]!]);
  /** The checkboxes with text (<CheckField>): their text and whether they are checked. */
  const checkTexts = (html: string) =>
    [...html.matchAll(/<label\b[^>]*><input\b([^>]*)\/><span>(.*?)<\/span><\/label>/g)].map((m) => [text(m[2]!).trim(), /\bchecked=""/.test(m[1]!)]);

  it('closed, it renders nothing', () => {
    expect(render(<CloseMonthModal />)).toBe('');
  });

  it('open: dialog with title, text and the three buttons', () => {
    const html = render(<CloseMonthModal />, { shell: open });
    const [dialog] = els(html, 'div').filter((d) => d.role === 'dialog');
    expect(dialog).toMatchObject({ 'aria-modal': 'true', 'aria-busy': 'false' });
    // The title labels the dialog and the text describes it.
    has(els(html, 'h2'), { id: dialog!['aria-labelledby']! });
    has(els(html, 'p'), { id: dialog!['aria-describedby']! });
    const t = text(html);
    expect(t).toContain('Close October 2026');
    expect(t).toContain(
      'November 2026 will be created with the same monthly expenses, not marked as paid. Add it to the Excel too? The file with every month, including November 2026, will be downloaded.',
    );
    expect(buttonTexts(html)).toEqual(['Cancel', 'Only on the page', 'Yes, add to Excel']);
    expect(els(html, 'button').every((b) => b.type === 'button')).toBe(true);
    // Nothing disabled: neither the buttons nor the next month's budget fields.
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('aria-invalid');
    // Still not a form: each button closes in its own way, there is no "submit".
    expect(html).not.toContain('<form');
  });

  it("asks which budget the next month starts with: one field per account with a part, with this month's part", () => {
    const html = render(<CloseMonthModal />, { shell: open });
    const t = text(html);
    // Between the Excel text and the fields: the compact month summary (initial, added, total, spent, remaining).
    expect(t).toContain(
      'will be downloaded. Initial budget 65,000.00 DOP Added during the month 5,000.00 DOP Total budget 70,000.00 DOP ≈ 1,191.29 USD Spent 49,149.71 DOP ≈ 836.45 USD Remaining 20,850.29 DOP ≈ 354.84 USD',
    );
    expect(t).toContain("November 2026's budget starts with these amounts per account: Budget from DR account (DOP)");
    const inputs = els(html, 'input');
    expect(inputs.map((i) => i.type)).toEqual(['number', 'checkbox']);
    expect(inputs[0]).toMatchObject({ type: 'number', value: '70000', step: 'any', min: '0', inputMode: 'decimal', placeholder: '0.00', autoComplete: 'off' });
    // The field has its visible label, with the account and its currency.
    expect(fieldLabels(html)).toEqual([['Budget from DR account (DOP)', inputs[0]!.id]]);
    // The intro line is not the one that describes the dialog.
    const [dialog] = els(html, 'div').filter((d) => d.role === 'dialog');
    const described = new RegExp(`<p[^>]*id="${dialog!['aria-describedby']}"[^>]*>(.*?)</p>`).exec(html)![1]!;
    expect(described).not.toContain('budget starts');
  });

  it('the leftover checkbox: with what is left over from this month, unchecked', () => {
    const html = render(<CloseMonthModal />, { shell: open });
    // October: 70,000 − 49,149.71.
    expect(checkTexts(html)).toEqual([["Add this month's leftover (20,850.29 DOP) to November 2026's budget", false]]);

    // If the month went over, what is offered to add is negative.
    const over = seedState();
    setBudgets(over.months['2026-10']!, { dr: 40000 });
    expect(checkTexts(render(<CloseMonthModal />, { shell: open, state: over }))).toEqual([
      ["Add this month's leftover (-9,149.71 DOP) to November 2026's budget", false],
    ]);
  });

  it('if nothing is left over, the checkbox does not show; the fields do', () => {
    const state = seedState();
    setBudgets(state.months['2026-10']!, { dr: monthCalc(seedState(), '2026-10').used });
    const html = render(<CloseMonthModal />, { shell: open, state });
    expect(els(html, 'input').map((i) => i.type)).toEqual(['number']);
    expect(text(html)).not.toContain('leftover');
    expect(text(html)).toContain("November 2026's budget starts with these amounts per account:");
  });

  it('several accounts with a part: one field for each, in its currency; what incomes add is not inherited', () => {
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

  it('with no part in the log there are no fields or intro; the leftover is still offered', () => {
    const state = seedState();
    setBudgets(state.months['2026-10']!, {});
    const html = render(<CloseMonthModal />, { shell: open, state });
    expect(els(html, 'input').map((i) => i.type)).toEqual(['checkbox']);
    expect(text(html)).not.toContain('budget starts with these amounts');
    expect(checkTexts(html)).toEqual([["Add this month's leftover (-49,149.71 DOP) to November 2026's budget", false]]);
  });

  it('if the next month already exists it does not ask about its budget: only the Excel text and the buttons', () => {
    // September (reopened) is being closed with October already created.
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

  it('the fields are those of the month being closed, whether or not it is the one being viewed', () => {
    // August is being viewed and October is being closed.
    const html = render(<CloseMonthModal />, { monthKey: '2026-08', shell: open });
    expect(els(html, 'input').filter((i) => i.type === 'number').map((i) => i.value)).toEqual(['70000']);
    expect(checkTexts(html)[0]![0]).toContain('20,850.29 DOP');
  });

  it("in Spanish: the prototype's text", () => {
    const html = render(<CloseMonthModal />, { lang: 'es', shell: open });
    const t = text(html);
    expect(t).toContain('Cerrar Octubre 2026');
    expect(t).toContain(
      'Se creará Noviembre 2026 con los mismos gastos mensuales, sin marcar como pagados. ¿Lo agrego también al Excel? Se descargará el archivo con todos los meses, incluido Noviembre 2026.',
    );
    expect(buttonTexts(html)).toEqual(['Cancelar', 'Solo en la página', 'Sí, agregar al Excel']);
    // The next month's budget.
    expect(t).toContain('El presupuesto de Noviembre 2026 arranca con estos montos por cuenta: Presupuesto de DR account (DOP)');
    expect(fieldLabels(html).map(([label]) => label)).toEqual(['Presupuesto de DR account (DOP)']);
    expect(checkTexts(html)).toEqual([['Sumar el sobrante de este mes (20,850.29 DOP) al presupuesto de Noviembre 2026', false]]);
    has(els(html, 'input'), { type: 'number', value: '70000' });
  });

  it('in Turkish', () => {
    const html = render(<CloseMonthModal />, { lang: 'tr', shell: open });
    expect(text(html)).toContain('Ekim 2026 ayını kapat');
    expect(text(html)).toContain('Kasım 2026');
    expect(buttonTexts(html)).toEqual(['İptal', 'Yalnızca sayfada', "Evet, Excel'e ekle"]);
    expect(text(html)).toContain('Kasım 2026 bütçesi hesap başına şu tutarlarla başlar: DR account bütçesi (DOP)');
    expect(fieldLabels(html).map(([label]) => label)).toEqual(['DR account bütçesi (DOP)']);
    expect(checkTexts(html)).toEqual([['Bu ayın kalanını (20,850.29 DOP) Kasım 2026 bütçesine ekle', false]]);
  });

  it('while closing, the buttons and the fields are disabled', () => {
    const html = render(<CloseMonthModal />, { shell: { closeDialog: { key: '2026-10', busy: true } } });
    expect(els(html, 'button').filter((b) => 'disabled' in b)).toHaveLength(3);
    // The DR account's field and the leftover checkbox.
    expect(els(html, 'input').map((i) => [i.type, 'disabled' in i])).toEqual([
      ['number', true],
      ['checkbox', true],
    ]);
    has(els(html, 'div'), { role: 'dialog', 'aria-busy': 'true' });
  });
});

describe('DeleteMonthModal', () => {
  const open = { deleteDialog: { key: '2026-10', busy: false } };

  it('closed, it renders nothing', () => {
    expect(render(<DeleteMonthModal />)).toBe('');
  });

  it('open: asks about that month, says what gets deleted with its counts and offers Cancel and Delete', () => {
    const html = render(<DeleteMonthModal />, { shell: open });
    const [dialog] = els(html, 'div').filter((d) => d.role === 'dialog');
    expect(dialog).toMatchObject({ 'aria-modal': 'true', 'aria-busy': 'false' });
    has(els(html, 'h2'), { id: dialog!['aria-labelledby']! });
    has(els(html, 'p'), { id: dialog!['aria-describedby']! });
    const t = text(html);
    expect(t).toContain('Delete October 2026?');
    // October in the sample data: 11 fixed expenses, 7 transactions and 1 transfer.
    expect(t).toContain(
      'This deletes the month with its 11 monthly expenses, 7 transactions and 1 transfer. Account balances change accordingly. This cannot be undone.',
    );
    expect(buttonTexts(html)).toEqual(['Cancel', 'Delete']);
    expect(els(html, 'button').every((b) => b.type === 'button')).toBe(true);
    // The one that deletes is in red: it is the action with no way back.
    expect(els(html, 'button')[1]!.class).toContain('destructive');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('<form');
  });

  it('the counts are those of the month to be deleted, whether it is the one being viewed or not', () => {
    // October is being viewed and August (closed) is being deleted: 11 expenses, 10 transactions and 2 transfers.
    const html = render(<DeleteMonthModal />, { shell: { deleteDialog: { key: '2026-08', busy: false } } });
    expect(text(html)).toContain('Delete August 2026?');
    expect(text(html)).toContain('its 11 monthly expenses, 10 transactions and 2 transfers.');

    const state = seedState();
    state.months['2026-10']!.fixed = state.months['2026-10']!.fixed.slice(0, 1);
    state.months['2026-10']!.tx = [];
    expect(text(render(<DeleteMonthModal />, { shell: open, state }))).toContain('its 1 monthly expense, 0 transactions and 1 transfer.');
  });

  it('in Spanish and in Turkish', () => {
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

  it('while deleting, the buttons are disabled', () => {
    const html = render(<DeleteMonthModal />, { shell: { deleteDialog: { key: '2026-10', busy: true } } });
    expect(els(html, 'button').filter((b) => 'disabled' in b)).toHaveLength(2);
    has(els(html, 'div'), { role: 'dialog', 'aria-busy': 'true' });
  });
});

describe('Dialog and form fields', () => {
  it('with onSubmit the content is a form, with its title, its fields and its footer', () => {
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
    // The form wraps title, fields and footer: the submit button stays inside.
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

  it('MonthPicker: two selects, with the months in the current language and the chosen value', () => {
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

  it("Select: a select with the forms' style; the options, like CellSelect's", () => {
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
    // A value that is not among the options is kept as one more (and is the chosen one).
    expect(html).toContain('<option value="gone" selected="">gone</option><option value="a">a</option>');
  });

  it("MonthPicker: the value's year is always in the list, even if it falls outside the range", () => {
    const html = renderToStaticMarkup(<MonthPicker label="Start" value="2019-03" onChange={() => {}} fromYear={2026} toYear={2027} />);
    const years = [...html.matchAll(/<option value="(\d{4})"/g)].map((m) => m[1]);
    expect(years[0]).toBe('2019');
    expect(years.at(-1)).toBe('2027');
    expect(html).toContain('<option value="2019" selected="">2019</option>');
    expect(html).toContain('<option value="3" selected="">March</option>');
  });
});

describe('Notices', () => {
  it('lists the notices with their close button', () => {
    const notices = [{ id: 1, text: 'Could not save. The change was undone. Could not reach the server.' }];
    const html = render(<Notices />, { shell: { notices } });
    expect(html).toContain('role="status"');
    expect(text(html)).toContain('Could not save. The change was undone. Could not reach the server.');
    has(els(html, 'button'), { title: 'Close', 'aria-label': 'Dismiss notice' });
    has(els(render(<Notices />, { lang: 'es', shell: { notices } }), 'button'), { title: 'Cerrar', 'aria-label': 'Cerrar aviso' });
  });
});

describe('table primitives', () => {
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
                <DeleteButton kind="kindExpense" onConfirm={() => {}} label="Delete Netflix" />
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

  it('an editable row and an add row produce the expected markup', () => {
    const html = table('en');
    has(els(html, 'table'), { style: 'min-width:980px', 'aria-label': 'Monthly expenses' });

    const ths = els(html, 'th');
    expect(ths.every((th) => th.scope === 'col')).toBe(true);
    expect(ths.map((th) => th.style)).toEqual(['width:44px', undefined, 'width:110px', 'width:32px']);
    expect(ths[3]).toMatchObject({ 'aria-label': 'Actions' });

    const inputs = els(html, 'input');
    has(inputs, { type: 'checkbox', 'aria-label': 'Paid: Netflix' });
    has(inputs, { type: 'text', style: 'min-width:120px', value: 'Netflix', 'aria-label': 'Item' });
    // 1137.3, not "1,137.30": the input shows the number as is, like the prototype.
    has(inputs, { type: 'number', step: 'any', value: '1137.3', 'aria-label': 'Amount' });
    has(inputs, { type: 'date', value: '2026-10-07', 'aria-label': 'Date' });
    // blankZero: the 0 is shown empty so the placeholder is visible.
    has(inputs, { type: 'number', value: '', placeholder: '0.00' });

    const buttons = els(html, 'button');
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
    has(buttons, { title: 'Delete', 'aria-label': 'Delete Netflix' });
    expect(html).toContain('>×</button>');
    expect(html).toContain('>Add</button>');
    has(els(html, 'td'), { colSpan: '2' });

    // A value outside the list is kept as an option (and is the selected one).
    expect(html).toContain('<option value="Other" selected="">Other</option><option value="DOP">DOP</option>');
  });

  it('the texts the primitives themselves add come out in the current language', () => {
    const es = table('es');
    expect(es).toContain('>Agregar</button>');
    has(els(es, 'button'), { title: 'Eliminar' });
    expect(els(es, 'th')[3]).toMatchObject({ 'aria-label': 'Acciones' });
    const tr = table('tr');
    expect(tr).toContain('>Ekle</button>');
    has(els(tr, 'button'), { title: 'Sil' });
  });

  it('CellText with suggestions: still free text, with its list of proposed values', () => {
    const html = renderToStaticMarkup(<CellText value="Western Union" label="Via" suggestions={['Remitly', 'PayPal']} maxLength={60} />);
    const [input] = els(html, 'input');
    expect(input).toMatchObject({ type: 'text', value: 'Western Union', 'aria-label': 'Via', maxLength: '60' });
    has(els(html, 'datalist'), { id: input!.list! });
    expect(html).toContain('<option value="Remitly"></option><option value="PayPal"></option>');
    // With no suggestions, or when read-only, there is no list.
    expect(renderToStaticMarkup(<CellText value="x" label="Item" />)).not.toContain('list');
    expect(renderToStaticMarkup(<CellText value="x" label="Via" suggestions={['Remitly']} readOnly />)).not.toContain('datalist');
  });

  it("without <I18nProvider>, whatever sits under FinanzasContext comes out in its state's language", () => {
    const html = renderToStaticMarkup(
      <FinanzasContext value={finanzas('2026-10', { ...seedState(), language: 'es' })}>
        <AddButton />
        <SummaryPanel sheet="ahorros" />
      </FinanzasContext>,
    );
    expect(html).toContain('>Agregar</button>');
    expect(text(html)).toContain('Dinero total');
    // An explicit provider overrides the state.
    const forced = renderToStaticMarkup(
      <I18nProvider lang="tr">
        <FinanzasContext value={finanzas('2026-10', { ...seedState(), language: 'es' })}>
          <AddButton />
        </FinanzasContext>
      </I18nProvider>,
    );
    expect(forced).toContain('>Ekle</button>');
  });

  it('with no language provider or state they come out in English, and a delete button with no label says "Delete"', () => {
    const html = renderToStaticMarkup(
      <>
        <AddButton />
        <DeleteButton kind="kindExpense" onConfirm={() => {}} />
      </>,
    );
    expect(html).toContain('>Add</button>');
    has(els(html, 'button'), { title: 'Delete', 'aria-label': 'Delete' });
  });
});

describe('SummaryPanel · Month: overrun budget parts', () => {
  /** A transfer that moves budget takes 800 USD out of the US account's part, which has nothing. */
  function overrun(): AppState {
    const s = seedState();
    const m = s.months['2026-10']!;
    m.transfers = [...m.transfers, { id: 'big', monthKey: '2026-10', date: '2026-10-05', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 800, rate: 58, budget: true, fee: 0 }];
    return s;
  }
  const panel = (opts: Opts = {}) => render(<SummaryPanel sheet="mes" />, opts);

  it('one line per negative part, with its account, and nothing if none is', () => {
    const lines = (html: string) => [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => text(m[1]!).trim());
    expect(lines(panel({ state: overrun() }))).toEqual(['Over budget by 800.00 USD · US account']);
    expect(text(panel())).not.toContain('Over budget by');
    expect(lines(panel())).toEqual([]);
  });

  it('in Spanish and in Turkish', () => {
    expect(text(panel({ state: overrun(), lang: 'es' }))).toContain('Sobrepasado por 800.00 USD · US account');
    expect(text(panel({ state: overrun(), lang: 'tr' }))).toContain('Bütçe aşıldı: 800.00 USD · US account');
  });
});
