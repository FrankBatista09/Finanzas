// The "Month" sheet rendered to HTML in Node (no DOM) with the sample data: texts, figures and read-only mode.
// Interactions (typing, adding, deleting) are not tested here; their logic lives in drafts.test.ts and rows.test.ts.
//
// Almost everything is checked in English (the default language); at the end, the same data in Spanish and in Turkish.
// The sample data is in English and belongs to the user: it does not change with the language.

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
  /** The user's language (state.language). Fixed to English so it does not depend on the one in the sample data. */
  lang?: Language;
  state?: AppState;
  /** Date of the add rows. By default the one the app builds: today if the month is today's; otherwise, its day 1. */
  draftDate?: ISODate;
  /** Language forced with <I18nProvider>, as FinanzasProvider does in the app. */
  provider?: Language;
  /** The add rows: open (as after pressing their "+ Add …") unless false is requested, which is how the screen starts out. */
  addRows?: boolean;
}

/** The usual single credit card: the sample data has none and without it there is no credit card row. */
const CARD: CreditCard = { id: 'card', name: 'Credit card', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
const withCard = (state: AppState = seedState()): AppState => ({ ...state, cards: [CARD] });

function render(monthKey: MonthKey, { lang = 'en', state = withCard(), draftDate, provider, addRows = true }: RenderOptions = {}): string {
  state.language = lang;
  // The same value FinanzasProvider builds (today is October 7); the date of the drafts can be set separately.
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

/** Visible text, without tags. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** Attributes of each <tag> in the HTML, without depending on the order React writes them in. */
function els(html: string, tag: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) =>
    Object.fromEntries([...m[1]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!, a[2] ?? ''])),
  );
}

/** The same HTML without the options of the selects: only the figures and the labels remain in the text. */
const bare = (html: string) => text(html.replace(/<option\b[^>]*>[^<]*<\/option>/g, ''));

/** One more account for the sample data. */
const account = (id: string, name: string, currency: Account['currency'], over: Partial<Account> = {}): Account => ({
  id,
  name,
  currency,
  opening: 0,
  hidden: false,
  sort: 9,
  ...over,
});

/** One more income for the sample data: from October, in pesos and in the DR account. */
const income = (over: Partial<Income> & Pick<Income, 'id' | 'amount'>): Income => ({
  date: '2026-10-03',
  desc: 'Refund',
  accountId: 'dr',
  cur: 'DOP',
  budget: false,
  ...over,
});

/** End-of-section markers: the title of the next card (the bare text also shows up in notes and labels). */
const INCOME = '>Income</h2>';
const HISTORY = '>Transaction history</h2>';

/** The selected option of the select with that label. */
function selected(html: string, label: string): string | undefined {
  const m = html.match(new RegExp(`<select\\b[^>]*aria-label="${label}"[^>]*>(.*?)</select>`));
  expect(m, label).not.toBeNull();
  return m![1]!.match(/<option value="([^"]*)" selected="">/)?.[1];
}

/** The HTML of the card (or box) that contains that text, up to the next one. */
function section(html: string, from: string, to?: string): string {
  const start = html.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = to ? html.indexOf(to, start) : html.length;
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);

/** The placeholders with text, in order: those of the add rows (the "—" of an empty day does not count). */
const placeholders = (inputs: Record<string, string>[]) => inputs.map((i) => i.placeholder).filter((p) => p && p !== '—');

/** The values a <datalist> offers, in order. */
const offered = (html: string) => els(section(html, '<datalist', '</datalist>'), 'option').map((o) => o.value);

describe('open month · October 2026', () => {
  const html = render('2026-10');
  const t = text(html);

  it('has no banner but does have the box to close the month', () => {
    expect(t).not.toContain('October 2026 summary');
    expect(t).not.toContain('Reopen month');
    expect(t).toContain(
      'Closing the month saves this summary and creates November 2026 with the same monthly expenses, not marked as paid. Close October 2026',
    );
  });

  it('nothing is read-only', () => {
    expect(html).not.toContain('readOnly');
    // Except the credit card checkbox when there is nothing to pay (checking it would make no sense).
    expect(html.replace(/<input[^>]*aria-label="Paid: Credit card"[^>]*>/, '')).not.toContain('disabled');
  });

  it('fixed expenses: header, columns and rows in the order of the sheet', () => {
    const card = section(html, 'Fixed monthly expenses', 'By category');
    const ct = text(card);
    expect(ct).toContain('Fixed monthly expenses 6 of 11 paid · total 42,025.57 DOP');
    expect(ct).toContain('Paid Item Day Amount Currency Pay with Account DOP USD');
    expect(els(card, 'table')).toEqual([expect.objectContaining({ 'aria-label': 'Fixed monthly expenses' })]);

    const inputs = els(card, 'input');
    const boxes = inputs.filter((i) => i.type === 'checkbox');
    // 11 expenses and the credit card.
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
    // The input shows the number as is; the computed columns are formatted.
    expect(inputs).toContainEqual(expect.objectContaining({ type: 'number', value: '1337.15', 'aria-label': 'Amount of Electricity' }));
    expect(inputs).toContainEqual(expect.objectContaining({ type: 'text', value: '5', placeholder: '—', 'aria-label': 'Day of Claude' }));
    expect(ct).toContain('1,337.15 22.76');
    // Claude: 106 USD × 58.76 = 6,228.56 DOP; back to USD, 106.00.
    expect(ct).toContain('6,228.56 106.00');
    expect(card).toContain('<option value="USD" selected="">USD</option>');
    expect(els(card, 'select')).toContainEqual(expect.objectContaining({ 'aria-label': 'Currency of Claude' }));
    // The three currencies, in every currency select.
    expect(card).toContain('<option value="DOP" selected="">DOP</option><option value="USD">USD</option><option value="TRY">TRY</option>');
  });

  it('fixed expenses: each expense carries the account it is paid from', () => {
    const card = section(html, 'Fixed monthly expenses', 'By category');
    // What is billed in USD comes out of the US account; the rest, out of the DR account.
    expect(selected(card, 'Account of Claude')).toBe('us');
    expect(selected(card, 'Account of Electricity')).toBe('dr');
    expect(card).toContain('<option value="us" selected="">US account</option><option value="dr">DR account</option>');
    // 11 rows + the add row.
    expect(els(card, 'select').filter((x) => x['aria-label']?.startsWith('Account of'))).toHaveLength(12);
  });

  it('unpaid expenses get the pending background', () => {
    const card = section(html, 'Fixed monthly expenses', 'By category');
    expect(els(card, 'tr').filter((tr) => /unpaid/.test(tr.class ?? ''))).toHaveLength(5);
  });

  it('fixed expenses: add row at the end', () => {
    const card = section(html, 'Fixed monthly expenses', 'By category');
    const inputs = els(card, 'input');
    // The credit card row is above the expenses, so the add row is the last one.
    const last = inputs.slice(-3);
    expect(last[0]).toMatchObject({ type: 'text', value: '', placeholder: 'New monthly expense', style: 'min-width:60px', maxLength: '120' });
    expect(last[1]).toMatchObject({ type: 'text', value: '', placeholder: 'Day', 'aria-label': 'Day of the new expense', maxLength: '20' });
    expect(last[2]).toMatchObject({ type: 'number', value: '', placeholder: '0.00', 'aria-label': 'Amount of the new expense' });
    expect(els(card, 'select').at(-3)).toMatchObject({ 'aria-label': 'Currency of the new expense' });
    expect(els(card, 'select').at(-2)).toMatchObject({ 'aria-label': 'How the new expense is paid' });
    expect(els(card, 'select').at(-1)).toMatchObject({ 'aria-label': 'Account of the new expense' });
    // It starts on the default account (DR account) and in its currency.
    expect(selected(card, 'Account of the new expense')).toBe('dr');
    expect(selected(card, 'Currency of the new expense')).toBe('DOP');
    expect(els(card, 'td')).toContainEqual(expect.objectContaining({ colSpan: '3' }));
    // The header button (with the row open, its "Cancel"), 11 × from the rows and, at the end, "Add".
    // 'Credit card' is the name of the credit card's derived row (first in the body), a button that opens its details.
    expect(buttons(card)).toEqual(['Cancel', 'Credit card', ...Array<string>(11).fill('×'), 'Add']);
    expect(card.indexOf('Paid: Credit card')).toBeLessThan(card.indexOf('Paid: Electricity'));
    expect(els(card, 'button')).toContainEqual(expect.objectContaining({ title: 'Delete', 'aria-label': 'Delete Netflix' }));
  });

  it('by category: fixed expenses first and the rest from largest to smallest', () => {
    const card = section(html, 'By category', 'Month rates');
    expect(text(card)).toContain('By category DOP Fixed expenses 38,305 Groceries 4,850 Transport 2,320 Food 1,535 Health 1,240 Entertainment 900');
    expect(text(card)).not.toContain('No expenses yet');
    const bars = els(card, 'span').filter((s) => s.style?.startsWith('width:'));
    expect(bars).toHaveLength(6);
    expect(bars[0]!.style).toBe('width:100%');
    expect(bars[0]!.class).toMatch(/barFixed/);
    expect(bars.slice(1).every((b) => !/barFixed/.test(b.class!))).toBe(true);
    // Groceries: 4,850 of 38,304.71.
    expect(Number.parseFloat(bars[1]!.style!.slice('width:'.length))).toBeCloseTo((4850 / 38304.71) * 100, 6);
  });

  it('month rates: the pair in use, with its typed rates editable (one per date), and the add row for another', () => {
    const card = section(html, 'Month rates', '>Credit cards</h2>');
    // Under the title, the note that explains from when a rate applies; the first column is its date.
    expect(bare(card)).toContain(
      'Month rates Cancel A new rate applies from its date on. Earlier transactions keep the rate they had. Since From Rate To 01/10 1 USD = DOP × 06/10 1 USD = DOP × Add',
    );
    expect(els(card, 'p')).toHaveLength(1);
    expect(els(card, 'table')).toEqual([expect.objectContaining({ 'aria-label': 'Month rates' })]);
    const inputs = els(card, 'input');
    expect(inputs).toHaveLength(4);
    // October has the rate typed twice (on the 1st and the 6th): each one is corrected in its cell and says from when it applies.
    // They carry no source note because they are the month's own.
    expect(inputs[0]).toMatchObject({ type: 'number', value: '58.76', 'aria-label': 'Rate USD → DOP since 01/10' });
    expect(inputs[1]).toMatchObject({ type: 'number', value: '58.76', 'aria-label': 'Rate USD → DOP since 06/10' });
    expect(card).not.toContain('typed for this month');
    expect(card).not.toMatch(/warn/);
    expect(els(card, 'button').map((b) => b['aria-label'])).toEqual([undefined, 'Expand', 'Delete rate USD → DOP of 01/10', 'Delete rate USD → DOP of 06/10', undefined]);
    // Add row: date, pair (all the currencies) and empty rate.
    expect(inputs[2]).toMatchObject({ type: 'date', value: '2026-10-07', 'aria-label': 'Date the new rate applies from' });
    expect(inputs[3]).toMatchObject({ type: 'number', value: '', placeholder: '0.00', 'aria-label': 'New rate' });
    expect(selected(card, 'Currency the new rate converts from')).toBe('USD');
    expect(selected(card, 'Currency the new rate converts to')).toBe('DOP');
    expect([...card.matchAll(/<option /g)]).toHaveLength(6);
    expect(buttons(card)).toEqual(['Cancel', '×', '×', 'Add']);
  });

  it('transfers and income: side by side in the same grid, after the two columns and before the history', () => {
    // The two cards are direct children of the `pair` grid, in that order, and nothing else lives there.
    const pair = section(html, '<div class="_pair_', HISTORY);
    expect(pair).toMatch(/^<div class="_pair_\w+"><div class="_card_\w+[^"]*">/);
    expect(pair).toContain('>Transfers</h2>');
    expect(pair).toContain(INCOME);
    expect(pair).not.toContain('>Month rates</h2>');
    const order = ['>Fixed monthly expenses</h2>', '>By category</h2>', '>Month rates</h2>', '<div class="_pair_', '>Transfers</h2>', INCOME, HISTORY].map((x) => html.indexOf(x));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('transfers: each row is edited in place, with its accounts, its rate, the amount received and its checkbox', () => {
    const card = section(html, 'Transfers', INCOME);
    // Origin and destination share a column (with the arrow between the two selects) and the amount received goes under the amount.
    // The fee goes under the rate, with its label.
    expect(bare(card)).toContain('Date Via From → To Amount Rate Budget → USD = 88,140.00 DOP Fee × → Fee Add');
    expect(bare(card)).not.toContain('Received');
    expect(els(card, 'table')).toEqual([expect.objectContaining({ style: 'min-width:520px', 'aria-label': 'Transfers' })]);
    expect(els(card, 'th').find((th) => th.title === 'Moves budget')).toMatchObject({ 'aria-label': 'Moves budget' });
    const inputs = els(card, 'input');
    expect(inputs).toHaveLength(12);
    // The sample data checks no transfer and carries no fee (empty, with its placeholder).
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

  it('transfers: add row with the two accounts and the month rate for their currencies', () => {
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
    // The rate cell belongs to this screen (RateCell) and takes the styles of the src/ui cells: it looks like the amount one.
    expect(inputs[3]!.class).toBeTruthy();
    expect(inputs[3]!.class).toBe(inputs[2]!.class);
    expect(inputs[3]).toMatchObject({ step: 'any', inputMode: 'decimal', autoComplete: 'off' });
    // Untouched: from the other account to the default one.
    expect(selected(card, 'Account the new transfer leaves from')).toBe('us');
    expect(selected(card, 'Account the new transfer goes to')).toBe('dr');
    // The fee starts as that of the last transfer via Remitly: none has one, so it is empty.
    expect(inputs[4]).toMatchObject({ type: 'number', value: '', placeholder: '0.00', 'aria-label': 'Fee of the new transfer' });
    // The "Moves budget" checkbox of the new transfer starts checked.
    expect(inputs[5]).toMatchObject({ type: 'checkbox', checked: '', 'aria-label': 'The new transfer moves budget' });
  });

  it('transfers: the via is a free-text field with suggestions, which starts at Remitly', () => {
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
    // Each via field points to its <datalist>: the usual vias (August already used both).
    expect(via.list).toBeTruthy();
    expect(els(card, 'datalist').map((d) => d.id)).toContain(via.list);
    expect(offered(card)).toEqual(['Remitly', 'PayPal']);
  });

  it('history: header, add row on top and transactions from the most recent to the oldest', () => {
    // Up to "Outside budget": its card (which shows when the add rows are open) has its own test.
    const card = section(html, 'Transaction history', 'Outside budget');
    const ct = text(card);
    expect(ct).toContain('Transaction history 7 transactions · total 10,845.00 DOP');
    expect(ct).toContain('Date Name Place Category Method Amount Cur. Account DOP USD Description');
    expect(els(card, 'table')).toContainEqual(expect.objectContaining({ style: 'min-width:1100px', 'aria-label': 'Transaction history' }));

    const inputs = els(card, 'input');
    expect(inputs.filter((i) => i.type === 'date').map((i) => i.value)).toEqual([
      '2026-10-07', // draft
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
    // Each row has "⋯" (opens its description in a dialog) and its ×.
    expect(buttons(card)).toEqual(['Cancel', 'Add', ...Array<string[]>(7).fill(['⋯', '↘', '×']).flat()]);
    // The dialog is only mounted when it is opened.
    expect(card).not.toContain('<textarea');
    expect(card).not.toContain('role="dialog"');
    // The draft starts on Food / Debit card, on the default account and in its currency, with all the categories, methods, currencies and accounts.
    const draftRow = section(card, '<tbody>', '</tr>');
    expect(draftRow).toContain('<option value="Food" selected="">Food</option><option value="Groceries">Groceries</option>');
    expect(draftRow).toContain(
      '<option value="Debit card" selected="">Debit card</option><option value="Credit card">Credit card</option><option value="Transfer">Transfer</option><option value="Bank app">Bank app</option><option value="Cash">Cash</option></select>',
    );
    // 11 categories, 5 methods, 3 currencies and 2 accounts.
    expect([...draftRow.matchAll(/<option /g)]).toHaveLength(11 + 5 + 3 + 2);
    expect(draftRow).toContain('<option value="Travel">Travel</option><option value="Other">Other</option></select>');
    expect(selected(draftRow, 'Account of the new transaction')).toBe('dr');
    expect(selected(draftRow, 'Currency of the new transaction')).toBe('DOP');
    expect(selected(card, 'Account of Coffee')).toBe('dr');
    expect(els(draftRow, 'td').filter((td) => td.colSpan === '2')).toHaveLength(2);
  });

  it('history: each cell says which transaction it belongs to', () => {
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
    // The "⋯" of each row says which transaction it opens the description of, also on hover.
    const dots = els(card, 'button').filter((b) => b['aria-label']?.startsWith('Open the description of '));
    expect(dots.map((b) => b['aria-label'])).toEqual(
      ['Coffee', 'Gas', 'Pharmacy', 'Movies', 'Lunch', 'Uber to work', 'Weekly groceries'].map((name) => `Open the description of ${name}`),
    );
    expect(dots.every((b) => b.title === b['aria-label'] && b.type === 'button')).toBe(true);
  });
});

describe('drafts of the add rows', () => {
  const reopened = () => {
    const state = seedState();
    state.months['2026-09']!.closed = false;
    return state;
  };

  it("the dates follow the one from the shell: day 1 when the selected month is not today's", () => {
    const html = render('2026-09', { state: reopened(), draftDate: '2026-09-01' });
    const draftDate = (card: string, label: string) => els(card, 'input').find((i) => i['aria-label'] === label)!.value;
    expect(draftDate(section(html, 'Transfers', INCOME), 'Date of the new transfer')).toBe('2026-09-01');
    expect(draftDate(section(html, 'Transaction history'), 'Date of the new transaction')).toBe('2026-09-01');
    // Also those of a new income and a new rate.
    expect(els(section(html, INCOME, HISTORY), 'input')[0]).toMatchObject({ type: 'date', value: '2026-09-01', 'aria-label': 'Income date' });
    expect(draftDate(section(html, 'Month rates', '>Credit cards</h2>'), 'Date the new rate applies from')).toBe('2026-09-01');
    // It is the date the app builds when nobody sets it: today (October 7) does not fall in September.
    const own = render('2026-09', { state: reopened() });
    expect(draftDate(section(own, 'Transfers', INCOME), 'Date of the new transfer')).toBe('2026-09-01');
    expect(draftDate(section(render('2026-10'), 'Transfers', INCOME), 'Date of the new transfer')).toBe('2026-10-07');
  });

  it('the rate of the transfer draft is the month rate, to two decimals', () => {
    // September has no typed rate: the weighted average of its transfers.
    const card = section(render('2026-09', { state: reopened(), draftDate: '2026-09-01' }), 'Transfers', INCOME);
    expect(els(card, 'input').at(-3)).toMatchObject({ type: 'number', value: '58.57', 'aria-label': 'Rate of the new transfer' });
  });

  it('a round rate keeps its two decimals in the field (58.70, not 58.7)', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 58.7, date: '2026-10-01' }];
    const html = render('2026-10', { state });
    expect(els(section(html, 'Month rates', '>Credit cards</h2>'), 'input')[0]).toMatchObject({ type: 'number', value: '58.70' });
    expect(els(section(html, 'Transfers', INCOME), 'input').at(-3)).toMatchObject({ type: 'number', value: '58.70' });
  });

  it('with another default account, the drafts follow it: account, currency and direction of the transfer', () => {
    const state = seedState();
    state.defaultAccountId = 'us';
    const html = render('2026-10', { state });
    expect(selected(html, 'Account of the new expense')).toBe('us');
    expect(selected(html, 'Currency of the new expense')).toBe('USD');
    expect(selected(html, 'Account of the new transaction')).toBe('us');
    expect(selected(html, 'Currency of the new transaction')).toBe('USD');
    // The transfer arrives at the default account: DR → US, with the inverse of the typed rate.
    expect(selected(html, 'Account the new transfer leaves from')).toBe('dr');
    expect(selected(html, 'Account the new transfer goes to')).toBe('us');
    expect(els(html, 'input').find((i) => i['aria-label'] === 'Rate of the new transfer')).toMatchObject({ value: '0.01702' });
  });

  it('between two accounts of the same currency the draft rate is 1 and is not typed', () => {
    const state = seedState();
    state.accounts = [account('a', 'Cash', 'DOP', { sort: 0 }), account('dr', 'DR account', 'DOP', { sort: 1 })];
    const rate = els(render('2026-10', { state }), 'input').find((i) => i['aria-label'] === 'Rate of the new transfer')!;
    expect(rate).toMatchObject({ value: '1.00' });
    expect(rate).toHaveProperty('readOnly');
  });

  it('the rate of the transfer draft is the one in effect on its date, not the last one of the month', () => {
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
    // Today (the 7th) the one from the 5th already applies; a transfer dated the 3rd is proposed with the one from the 1st.
    expect(draftRate()).toBe('60.00');
    expect(draftRate('2026-10-05')).toBe('60.00');
    expect(draftRate('2026-10-03')).toBe('58.00');
  });

  it('the via suggestions add the ones already used up to that month, without those of later months', () => {
    const state = reopened();
    state.months['2026-08']!.transfers[1]!.via = 'Western Union';
    state.months['2026-09']!.transfers[1]!.via = 'Wise';
    state.months['2026-10']!.transfers[0]!.via = 'Zelle';
    const september = section(render('2026-09', { state, draftDate: '2026-09-01' }), 'Transfers', INCOME);
    expect(offered(september)).toEqual(['Remitly', 'PayPal', 'Wise', 'Western Union']);
    // The existing rows show their via in its field, whatever it is.
    expect(els(september, 'input')).toContainEqual(expect.objectContaining({ type: 'text', value: 'Wise', 'aria-label': 'Via of Wise 17/09' }));
    expect(bare(september)).toContain('USD = 46,896.00 DOP');
    const october = section(render('2026-10', { state }), 'Transfers', INCOME);
    expect(offered(october)).toEqual(['Remitly', 'PayPal', 'Zelle', 'Wise', 'Western Union']);
  });
});

describe('closed month · September 2026', () => {
  const html = render('2026-09');
  const t = text(html);

  it('banner with the month summary', () => {
    // Rate 58.5743 (1,500 at 58.55 and 800 at 58.62): income 5,800 USD; fixed 42,081.54 + transactions 24,555; saved 3,500 USD.
    expect(t).toContain(
      'September 2026 summary Month closed. Records are read-only. Amounts in DOP Income 339,731 Spent 66,636.54 Saved 205,010 Vs. budget 3,363.46 Reopen month',
    );
    expect(html).toMatch(/valueOk/);
    expect(html).not.toMatch(/valueOver/);
  });

  it('no add rows, no × and no close box; deleting the month is still there', () => {
    // The descriptions can still be opened to read them: one "⋯" per transaction (10 in September).
    // And the credit card, which can be created and edited even if the month is closed (it does not belong to a month).
    expect(buttons(html)).toEqual(['Reopen month', 'Credit card', '+ Add card', 'Edit', 'View transactions', ...Array<string>(10).fill('⋯'), 'Delete month']);
    expect(buttons(html)).not.toContain('×');
    expect(els(html, 'button').filter((b) => b['aria-label']?.startsWith('Open the description of '))).toHaveLength(10);
    expect(t).not.toContain('Closing the month');
    expect(els(html, 'input').filter((i) => i.placeholder && i.placeholder !== '—')).toEqual([]);
    expect(els(html, 'td').filter((td) => 'colSpan' in td)).toEqual([]);
    expect(els(html, 'datalist')).toEqual([]);
  });

  it('everything becomes read-only: readOnly inputs, disabled selects and checkboxes', () => {
    const inputs = els(html, 'input');
    const boxes = inputs.filter((i) => i.type === 'checkbox');
    const fields = inputs.filter((i) => i.type !== 'checkbox');
    // The 11 "Paid" (all checked), the credit card one (with nothing to pay), the "Moves budget" checkboxes of the 2 transfers and the "Adds to budget" one of the salary (unchecked).
    expect(boxes).toHaveLength(11 + 1 + 2 + 1);
    expect(boxes.every((b) => 'disabled' in b)).toBe(true);
    expect(boxes.filter((b) => 'checked' in b)).toHaveLength(11);
    // 11 fixed × (item, day, amount) (the credit card's amount is text: its total) + 2 transfers × (date, via, amount, rate, fee) + 1 income × (date, description, amount)
    // + 10 transactions × (date, description, place, amount, notes). The month rates go as text.
    expect(fields).toHaveLength(11 * 3 + 2 * 5 + 1 * 3 + 10 * 5);
    expect(fields.every((f) => 'readOnly' in f)).toBe(true);
    const selects = els(html, 'select');
    // 11 fixed × (currency, pay with, account) + 2 transfers × (origin, destination) + 1 income × (account, currency) + 10 × (category, method, currency, account).
    expect(selects).toHaveLength(11 * 3 + 2 * 2 + 1 * 2 + 10 * 4);
    expect(selects.every((s) => 'disabled' in s)).toBe(true);
  });

  it('keeps the figures of the month', () => {
    expect(t).toContain('Fixed monthly expenses 11 of 11 paid · total 42,081.54 DOP');
    expect(bare(html)).toContain('Date Via From → To Amount Rate Budget → USD = 87,825.00 DOP Fee → USD = 46,896.00 DOP Fee Income Total 339,731.22 DOP');
    const transfers = els(section(html, 'Transfers', INCOME), 'input').filter((i) => i.type !== 'checkbox');
    expect(transfers.map((i) => i.value)).toEqual(['2026-09-02', 'Remitly', '1500', '58.55', '', '2026-09-17', 'Remitly', '800', '58.62', '']);
    expect(t).toContain('Transaction history 10 transactions · total 24,555.00 DOP');
  });

  it('month rates: with no typed rate, it says where it comes from and cannot be touched', () => {
    const card = section(html, 'Month rates', '>Credit cards</h2>');
    // 1,500 at 58.55 and 800 at 58.62.
    // The row is not a typed rate: the date column holds a dash, and the figure is text.
    expect(text(card).replace(/&#x27;/g, "'")).toContain(
      "Month rates A new rate applies from its date on. Earlier transactions keep the rate they had. Since From Rate To — 1 USD = 58.57 DOP from this month's transfers",
    );
    expect(els(card, 'input')).toEqual([]);
    expect(els(card, 'select')).toEqual([]);
    expect(buttons(card)).toEqual([]);
    expect(card).not.toMatch(/warn/);
  });

  it('over budget, "Vs. budget" changes color', () => {
    const state = seedState();
    setBudgets(state.months['2026-09']!, { dr: 60000 });
    const over = render('2026-09', { state });
    expect(text(over)).toContain('Vs. budget -6,636.54');
    expect(over).toMatch(/valueOver/);
    expect(over).not.toMatch(/valueOk/);
  });
});

describe('edge cases', () => {
  it('month with no data: counters at zero and the categories notice', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { fixed: [], transfers: [], tx: [] });
    const t = text(render('2026-10', { state }));
    expect(t).toContain('Fixed monthly expenses 0 of 0 paid · total 0.00 DOP');
    expect(t).toContain('By category DOP No expenses yet this month.');
    expect(t).toContain('Transaction history 0 transactions · total 0.00 DOP');
    expect(t).toContain('Close October 2026 Delete month');
  });

  it('month with no typed rate and no transfers: the rate is that of the previous month, and it says so', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { rates: [], transfers: [] });
    const html = render('2026-10', { state });
    const card = section(html, 'Month rates', '>Credit cards</h2>');
    expect(bare(card)).toContain('Since From Rate To — 1 USD = DOP from September 2026 Add');
    expect(card).not.toMatch(/warn/);
    // It is not typed: there is nothing to remove. The figure goes in a cell (typing in it creates the month rate), with
    // two decimals even if the computed one has more, and below it the add row for the rate of any pair is still there.
    expect(els(card, 'input').map((i) => [i.type, i.value, i['aria-label']])).toEqual([
      ['number', '58.57', 'Rate USD → DOP'],
      ['date', '2026-10-01', 'Date the new rate applies from'],
      ['number', '', 'New rate'],
    ]);
    expect(els(card, 'input')[0]).not.toHaveProperty('readOnly');
    expect(buttons(card)).toEqual(['Cancel', 'Add']);
    // The transfer draft proposes it.
    expect(els(html, 'input').find((i) => i['aria-label'] === 'Rate of the new transfer')).toMatchObject({ value: '58.57' });
  });

  it('a rate nobody has ever typed comes from the default value, and a warning says so', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY', { opening: 1000 }));
    const card = section(render('2026-10', { state }), 'Month rates', '>Credit cards</h2>');
    const ct = bare(card);
    expect(ct).toContain('01/10 1 USD = DOP × 06/10 1 USD = DOP ×');
    // No date (dash) and no ×: they are not typed rates. The figure goes in its cell.
    // With DOP as the main currency only TRY → DOP is asked for: USD → TRY is no longer a row, it is crossed through DOP.
    expect(ct).toContain('— 1 TRY = DOP default value, not set yet Add');
    expect(ct).not.toContain('1 USD = TRY');
    // 58.76 DOP and 42 TRY per dollar, the fixed values.
    expect(els(card, 'input').slice(2, 3).map((i) => [i.value, i['aria-label']])).toEqual([['1.40', 'Rate TRY → DOP']]);
    expect(els(card, 'span').filter((x) => /warn/.test(x.class ?? ''))).toHaveLength(1);
    // The add row proposes the first one that is missing.
    expect(selected(card, 'Currency the new rate converts from')).toBe('TRY');
    expect(selected(card, 'Currency the new rate converts to')).toBe('DOP');
  });

  it('no second currency and everything in one currency: the card has no table, only the note', () => {
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
    // Adding a standalone rate is still available.
    expect(buttons(card)).toEqual(['+ Add rate']);
  });

  it('a rate crossed through the third currency says so', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY', { opening: 1000 }));
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

  it('with other currencies: the columns, the totals and the categories use the main and the second currency of the user', () => {
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
    // The three currencies are in use, with USD as the main one: only TRY and DOP against USD are asked for (the top bar's
    // pair first, in the direction it was typed). TRY → DOP is crossed through USD and is not a row.
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

  it('an account hidden later still shows in its rows, and only in them', () => {
    const state = seedState();
    state.accounts.push(account('old', 'Old wallet', 'DOP', { hidden: true }));
    const month = state.months['2026-10']!;
    month.tx.find((x) => x.desc === 'Coffee')!.accountId = 'old';
    month.fixed.find((f) => f.name === 'Netflix')!.accountId = 'old';
    const html = render('2026-10', { state });
    expect(selected(html, 'Account of Coffee')).toBe('old');
    expect(selected(html, 'Account of Netflix')).toBe('old');
    expect([...html.matchAll(/<option value="old"[^>]*>Old wallet<\/option>/g)]).toHaveLength(2);
    // A hidden account in another currency does not bring its currency into the month rates.
    expect(bare(section(html, 'Month rates', '>Credit cards</h2>'))).not.toContain('TRY');
  });

  it('a transfer between accounts of the same currency: rate 1, which is not typed', () => {
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

  it('a single transaction uses the singular', () => {
    const state = seedState();
    const month = state.months['2026-10']!;
    month.tx = month.tx.slice(0, 1);
    expect(text(render('2026-10', { state }))).toContain('1 transaction · total 4,850.00 DOP');
  });

  it('fixed expenses are rendered by `sort`, not by position', () => {
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

  it('a category or a method from outside the list is kept as an option', () => {
    const state = seedState();
    const coffee = state.months['2026-10']!.tx.find((x) => x.desc === 'Coffee')!;
    coffee.cat = 'Pets';
    coffee.method = 'Cheque';
    // A row from before there were two card methods: its 'Card' is kept, it does not become the debit card on its own.
    state.months['2026-10']!.tx.find((x) => x.desc === 'Gas')!.method = 'Card';
    const html = render('2026-10', { state });
    const card = section(html, 'Transaction history', 'Closing the month');
    // They go at the end of their select and are the selected option; the rest of the rows do not offer them.
    expect(card).toContain('<option value="Other">Other</option><option value="Pets" selected="">Pets</option></select>');
    expect(card).toContain('<option value="Cash">Cash</option><option value="Cheque" selected="">Cheque</option></select>');
    expect(card).toContain('<option value="Cash">Cash</option><option value="Card" selected="">Card</option></select>');
    expect([...card.matchAll(/value="Pets"/g)]).toHaveLength(1);
    expect([...card.matchAll(/value="Cheque"/g)]).toHaveLength(1);
    expect([...card.matchAll(/value="Card"/g)]).toHaveLength(1);
    expect(selected(card, 'Method of Gas')).toBe('Card');
    expect(selected(card, 'Method of Lunch')).toBe('Debit card');
    // The new category also counts in "By category".
    expect(text(html)).toContain('Pets 385');
  });

  it('a transaction in USD is converted with the month rate', () => {
    const state = seedState();
    const coffee = state.months['2026-10']!.tx.find((x) => x.desc === 'Coffee')!;
    coffee.amount = 10;
    coffee.cur = 'USD';
    const card = section(render('2026-10', { state }), 'Transaction history', 'Closing the month');
    expect(text(card)).toContain('587.60 10.00');
    expect(text(card)).toContain('7 transactions · total 11,047.60 DOP');
  });
});

describe('month rates: one rate per date', () => {
  /** The body rows of the rates table, each with its HTML. */
  const bodyRows = (card: string) => [...section(card, '<tbody>', '</tbody>').matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!);
  const ratesCard = (html: string) => section(html, 'Month rates', '>Credit cards</h2>');

  it('several typed rates of the same pair show by date, each with its cell and its ×', () => {
    const state = seedState();
    // They arrive out of order: the card puts them from the oldest to the most recent.
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
    // None carries a source note: they are the ones typed for this month.
    expect(els(card, 'span').filter((x) => /hint/.test(x.class ?? ''))).toEqual([]);
  });

  it('a rate typed in the other direction shows as it was typed', () => {
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

  it('a pair with no typed rate in the month: a single row, with no date and no ×, with the source and the editable cell', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY', { opening: 1000 }));
    const rows = bodyRows(ratesCard(render('2026-10', { state })));
    // Two typed ones of USD → DOP, one row for the only untyped pair that is needed (TRY → DOP; USD → TRY is
    // crossed through the main currency) and the add row.
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
      // The dash in the date column, dimmed.
      expect(els(row, 'td')[0]!.class).toMatch(/faint/);
      expect(text(row).trim().startsWith('—')).toBe(true);
      expect(text(row)).toContain('default value, not set yet');
      // No ×: there is nothing stored to remove.
      expect(els(row, 'button')).toEqual([]);
      // But it can be typed in: that creates the typed rate of the pair.
      const [cell, ...rest] = els(row, 'input');
      expect(rest).toEqual([]);
      expect(cell).toMatchObject({ type: 'number', value, 'aria-label': label, step: 'any' });
      expect(cell).not.toHaveProperty('readOnly');
      expect(cell).not.toHaveProperty('disabled');
    }
  });

  it('the cell of an untyped rate shows the figure like the rest of the card: two decimals, or four if it is less than 1', () => {
    const state = seedState();
    // With no typed rate and no transfers in October or in September, the rate comes from the only transfer of August: 58.123456.
    Object.assign(state.months['2026-10']!, { rates: [], transfers: [] });
    Object.assign(state.months['2026-09']!, { transfers: [] });
    Object.assign(state.months['2026-08']!, { transfers: [{ ...state.months['2026-08']!.transfers[0]!, rate: 58.123456 }] });
    const card = ratesCard(render('2026-10', { state }));
    expect(els(card, 'input')[0]).toMatchObject({ value: '58.12', 'aria-label': 'Rate USD → DOP' });
    expect(bare(card)).toContain('— 1 USD = DOP from August 2026');
  });

  it('closed month: the typed rates go as text with their date, with no ×, no cells and no add row', () => {
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
    // The card's note stays: it explains what is shown.
    expect(text(card)).toContain('A new rate applies from its date on.');
  });

  it('no second currency: the tables have no second amount column', () => {
    const t = text(render('2026-10', { state: { ...seedState(), secondCurrency: null } }));
    expect(t).toContain('Pay with Account DOP');
    expect(t).not.toContain('Account DOP USD');
    expect(t).not.toContain('Used in USD');
  });

  it('closed month with no typed rate, with a third currency: each pair as text, with the dash and its source', () => {
    const state = seedState();
    state.accounts.push(account('tr', 'TR account', 'TRY', { opening: 1000 }));
    const card = ratesCard(render('2026-09', { state }));
    const ct = text(card).replace(/&#x27;/g, "'");
    expect(ct).toContain("— 1 USD = 58.57 DOP from this month's transfers — 1 TRY = 1.40 DOP default value, not set yet");
    expect(ct).not.toContain('1 USD = 42.00 TRY');
    expect(els(card, 'input')).toEqual([]);
    expect(buttons(card)).toEqual([]);
    expect(els(card, 'span').filter((x) => /warn/.test(x.class ?? ''))).toHaveLength(1);
  });

  describe('the date the add row proposes', () => {
    const newRateDate = (html: string) => els(ratesCard(html), 'input').find((i) => i['aria-label'] === 'Date the new rate applies from')!;

    it('today, if the selected month is the current one and the pair already has a typed rate in effect', () => {
      const html = render('2026-10');
      expect(selected(ratesCard(html), 'Currency the new rate converts from')).toBe('USD');
      expect(newRateDate(html)).toMatchObject({ type: 'date', value: '2026-10-07' });
      expect(newRateDate(html)).not.toHaveProperty('readOnly');
    });

    it('today too if the one in effect was typed in an earlier month', () => {
      const state = seedState();
      state.months['2026-09']!.rates = [{ from: 'USD', to: 'DOP', rate: 58.5, date: '2026-09-10' }];
      state.months['2026-10']!.rates = [];
      const html = render('2026-10', { state });
      const card = ratesCard(html);
      // October has none: it shows the one from September, which still applies (even though October has transfers).
      expect(bare(card)).toContain('— 1 USD = DOP from September 2026 Add');
      expect(els(card, 'input')[0]).toMatchObject({ value: '58.50', 'aria-label': 'Rate USD → DOP' });
      expect(newRateDate(html).value).toBe('2026-10-07');
    });

    it('the first day of the month, if the selected month is not the current one', () => {
      const state = seedState();
      state.months['2026-09']!.closed = false;
      state.months['2026-09']!.rates = [{ from: 'USD', to: 'DOP', rate: 58.5, date: '2026-09-10' }];
      // Today is October 7: in September the drafts start on day 1.
      expect(newRateDate(render('2026-09', { state })).value).toBe('2026-09-01');
    });

    it('the first day of the month, even if today is another day, if the pair has no typed rate at all', () => {
      const state = seedState();
      state.accounts.push(account('tr', 'TR account', 'TRY', { opening: 1000 }));
      const html = render('2026-10', { state });
      // The row proposes the first untyped pair (TRY → DOP): that way the rate also covers the rows from the 1st to the 6th.
      expect(selected(ratesCard(html), 'Currency the new rate converts from')).toBe('TRY');
      expect(selected(ratesCard(html), 'Currency the new rate converts to')).toBe('DOP');
      expect(newRateDate(html).value).toBe('2026-10-01');
      // The other add rows stay on today.
      expect(els(html, 'input').find((i) => i['aria-label'] === 'Date of the new transaction')!.value).toBe('2026-10-07');

      // The same with the top bar's pair when nobody has ever typed it: it comes from the month's transfers.
      const none = seedState();
      none.months['2026-10']!.rates = [];
      const transfers = render('2026-10', { state: none });
      expect(text(ratesCard(transfers)).replace(/&#x27;/g, "'")).toContain("— 1 USD = DOP from this month's transfers");
      expect(newRateDate(transfers).value).toBe('2026-10-01');
    });
  });
});

describe('conversion with the rate of the date', () => {
  /** October with two rates: 58 from day 1 and 60 from day 5. */
  const dated = () => {
    const state = seedState();
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
    ];
    return state;
  };
  /** The history row of that transaction, as text without the selects. */
  const txRow = (html: string, name: string) => {
    const card = section(html, HISTORY, 'Closing the month');
    const row = [...card.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!).find((r) => r.includes(`aria-label="Date of ${name}"`));
    expect(row, name).toBeDefined();
    return bare(row!).trim();
  };

  it('a transaction in USD is converted with the rate in effect on its date: the new one does not change the earlier rows', () => {
    const state = dated();
    const tx = state.months['2026-10']!.tx;
    // Uber (day 2) and Coffee (day 7), both 10 USD.
    Object.assign(tx.find((x) => x.desc === 'Uber to work')!, { amount: 10, cur: 'USD' });
    Object.assign(tx.find((x) => x.desc === 'Coffee')!, { amount: 10, cur: 'USD' });
    const html = render('2026-10', { state });
    expect(txRow(html, 'Uber to work')).toBe('580.00 10.00 ⋯ ↘ ×');
    expect(txRow(html, 'Coffee')).toBe('600.00 10.00 ⋯ ↘ ×');
    // The history total adds each one with its own: 10,845 − 320 − 385 + 580 + 600.
    expect(text(html)).toContain('7 transactions · total 11,320.00 DOP');
  });

  it('on the day the rate changes the new one already applies', () => {
    const state = dated();
    // Pharmacy is from day 5; Movies, from day 4.
    Object.assign(state.months['2026-10']!.tx.find((x) => x.desc === 'Pharmacy')!, { amount: 10, cur: 'USD' });
    Object.assign(state.months['2026-10']!.tx.find((x) => x.desc === 'Movies')!, { amount: 10, cur: 'USD' });
    const html = render('2026-10', { state });
    expect(txRow(html, 'Pharmacy')).toBe('600.00 10.00 ⋯ ↘ ×');
    expect(txRow(html, 'Movies')).toBe('580.00 10.00 ⋯ ↘ ×');
  });

  it('also the second-currency column of a transaction in pesos', () => {
    const html = render('2026-10', { state: dated() });
    // Lunch (day 3): 1,150 / 58. Gas (day 6): 2,000 / 60.
    expect(txRow(html, 'Lunch')).toBe('1,150.00 19.83 ⋯ ↘ ×');
    expect(txRow(html, 'Gas')).toBe('2,000.00 33.33 ⋯ ↘ ×');
  });

  it('a fixed expense has no date: it uses the last rate of the month', () => {
    const html = render('2026-10', { state: dated() });
    // Claude: 106 USD × 60.
    expect(bare(section(html, 'Fixed monthly expenses', 'By category'))).toContain('6,360.00 106.00');
    // Electricity: 1,337.15 / 60.
    expect(bare(section(html, 'Fixed monthly expenses', 'By category'))).toContain('1,337.15 22.29');
  });

  it('an income of the month also uses the rate of its date', () => {
    const state = dated();
    state.incomes.push(income({ id: 'in-3', amount: 100, cur: 'USD', date: '2026-10-03' }), income({ id: 'in-6', amount: 100, cur: 'USD', date: '2026-10-06' }));
    const card = section(render('2026-10', { state }), INCOME, HISTORY);
    // The salary of day 1 (5,800 × 58), 100 USD from the 3rd (× 58) and 100 USD from the 6th (× 60): 336,400 + 5,800 + 6,000. The
    // month's card no longer shows the equivalent of each row (the Savings table does); the total remains.
    expect(bare(card)).toContain('Income Total 348,200.00 DOP');
  });
});

describe('income of the month', () => {
  const incomeCard = (html: string, title = 'Income', next = 'Transaction history') => section(html, `>${title}</h2>`, `>${next}</h2>`);
  const bodyRows = (card: string) => [...section(card, '<tbody>', '</tbody>').matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!);

  it('the card goes next to the transfers one, before the history, with the month total and its note', () => {
    const html = render('2026-10');
    const card = incomeCard(html);
    const ct = bare(card).replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
    // October's salary: 5,800 USD × 58.76.
    expect(ct).toContain(
      'Income Total 340,808.00 DOP Cancel Money received outside transfers. With "Adds to budget" checked, it also raises this month\'s budget. Date Description Account Amount Cur. Budget',
    );
    // Half a card: without the equivalent column and with the checkbox under a short header, which says in full what it is.
    expect(els(card, 'th').find((th) => th.title === 'Adds to budget')).toMatchObject({ 'aria-label': 'Adds to budget' });
    expect(els(card, 'table')).toEqual([expect.objectContaining({ style: 'min-width:560px', 'aria-label': 'Income' })]);
    // A direct child of the sheet's stack, like the transfers one and the history.
    const before = html.slice(0, html.indexOf(INCOME));
    expect(before.slice(before.lastIndexOf('<div class="_card_'))).toMatch(/^<div class="_card_\w+"><div class="_header_\w+"><h2 class="_title_\w+"$/);
    expect(html.indexOf('>Transfers</h2>')).toBeLessThan(html.indexOf(INCOME));
    expect(html.indexOf(INCOME)).toBeLessThan(html.indexOf(HISTORY));
  });

  it('add row: current date, description, default account, amount, its currency and "Adds to budget" checked', () => {
    const card = incomeCard(render('2026-10'));
    const draft = bodyRows(card)[0]!;
    const inputs = els(draft, 'input');
    expect(inputs.map((i) => i.type)).toEqual(['date', 'text', 'number', 'checkbox']);
    expect(inputs[0]).toMatchObject({ value: '2026-10-07', 'aria-label': 'Income date' });
    expect(inputs[1]).toMatchObject({ value: '', placeholder: 'Salary, payment…', maxLength: '200', 'aria-label': 'Description' });
    expect(inputs[2]).toMatchObject({ value: '', placeholder: '0.00', 'aria-label': 'Amount' });
    // On the Month sheet a new income raises the budget, unless it is unchecked.
    expect(inputs[3]).toMatchObject({ 'aria-label': 'The new income adds to the budget' });
    expect(inputs[3]).toHaveProperty('checked');
    expect(inputs[3]).not.toHaveProperty('disabled');
    expect(selected(draft, 'Account')).toBe('dr');
    expect(selected(draft, 'Currency')).toBe('DOP');
    // The button is short to fit in half a card; its accessible name is still the full one.
    expect(buttons(draft)).toEqual(['Add']);
    expect(els(draft, 'button')).toEqual([expect.objectContaining({ 'aria-label': 'Add income' })]);
  });

  it('the add row follows the default account and its currency', () => {
    const state = seedState();
    state.defaultAccountId = 'us';
    const draft = bodyRows(incomeCard(render('2026-10', { state })))[0]!;
    expect(selected(draft, 'Account')).toBe('us');
    expect(selected(draft, 'Currency')).toBe('USD');
  });

  it('each income of the month is edited in its row, with its checkbox and its ×', () => {
    const card = incomeCard(render('2026-10'));
    const rows = bodyRows(card);
    // The add row and October's salary.
    expect(rows).toHaveLength(2);
    const salary = rows[1]!;
    expect(els(salary, 'input').map((i) => [i.type, i.value ?? '', i['aria-label']])).toEqual([
      ['date', '2026-10-01', 'Income date'],
      ['text', 'Salary', 'Description'],
      ['number', '5800', 'Amount'],
      ['checkbox', '', 'Adds to budget: income of 2026-10-01, 5,800.00 USD'],
    ]);
    // The sample salaries do not raise the budget.
    expect(els(salary, 'input')[3]).not.toHaveProperty('checked');
    expect(selected(salary, 'Account')).toBe('us');
    expect(selected(salary, 'Currency')).toBe('USD');
    expect(bare(salary).trim()).toBe('×');
    expect(els(salary, 'button')).toEqual([expect.objectContaining({ title: 'Delete', 'aria-label': 'Delete income of 2026-10-01: 5,800.00 USD' })]);
    expect(buttons(card)).toEqual(['Cancel', 'Add', '×']);
  });

  it('only the incomes dated in the selected month, from the most recent to the oldest', () => {
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
    // The first one is the add row.
    expect(descriptions(october)).toEqual(['', 'Last day', 'Refund', 'Salary']);
    // The total is that of those three: 340,808 + 2,500 + 100.
    expect(bare(october)).toContain('Income Total 343,408.00 DOP');
    expect(october).not.toContain('September gift');
    expect(october).not.toContain('November gift');
    // The checkbox of each row says whether that income raises the budget.
    const boxes = els(october, 'input').filter((i) => i.type === 'checkbox');
    expect(boxes.map((b) => [b['aria-label'], 'checked' in b])).toEqual([
      ['The new income adds to the budget', true],
      ['Adds to budget: income of 2026-10-31, 100.00 DOP', false],
      ['Adds to budget: income of 2026-10-05, 2,500.00 DOP', true],
      ['Adds to budget: income of 2026-10-01, 5,800.00 USD', false],
    ]);

    // September (closed) shows its own.
    const september = incomeCard(render('2026-09', { state: state() }));
    expect(descriptions(september)).toEqual(['September gift', 'Salary']);
    // August, only its salary.
    expect(descriptions(incomeCard(render('2026-08', { state: state() })))).toEqual(['Salary']);
  });

  it('month with no income: total at zero and only the add row', () => {
    const state = seedState();
    state.incomes = state.incomes.filter((i) => !i.date.startsWith('2026-10'));
    const card = incomeCard(render('2026-10', { state }));
    expect(bare(card)).toContain('Income Total 0.00 DOP');
    expect(bodyRows(card)).toHaveLength(1);
    expect(buttons(card)).toEqual(['Cancel', 'Add']);
  });

  it('closed month: they show, but with no add row, no × and everything disabled', () => {
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
    // 2 incomes × (date, description, amount), read-only.
    expect(fields).toHaveLength(2 * 3);
    expect(fields.every((f) => 'readOnly' in f)).toBe(true);
    // The checkboxes say what is there, with no way to change it.
    expect(boxes.map((b) => ['checked' in b, 'disabled' in b])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(els(card, 'select')).toHaveLength(2 * 2);
    expect(els(card, 'select').every((x) => 'disabled' in x)).toBe(true);
    // The action column is left empty.
    expect(els(rows[0]!, 'button')).toEqual([]);
  });

  it('in Spanish and in Turkish: title, total, note, columns and labels', () => {
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

    // Closed, in both: without the add button.
    expect(buttons(incomeCard(render('2026-09', { lang: 'es' }), 'Ingreso', 'Historial de transacciones'))).toEqual([]);
    expect(buttons(incomeCard(render('2026-09', { lang: 'tr' }), 'Gelir', 'İşlem geçmişi'))).toEqual([]);
  });

  it('with another main currency, the total is in it', () => {
    const state = seedState();
    state.mainCurrency = 'USD';
    state.secondCurrency = 'DOP';
    const card = incomeCard(render('2026-10', { state }));
    expect(bare(card)).toContain('Income Total 5,800.00 USD');
    expect(bare(card)).toContain('Date Description Account Amount Cur. Budget');
  });
});

describe('payment methods in the history', () => {
  /** The options (value and text) of the select with that label. */
  const options = (html: string, label: string) => {
    const m = html.match(new RegExp(`<select\\b[^>]*aria-label="${label}"[^>]*>(.*?)</select>`));
    expect(m, label).not.toBeNull();
    return [...m![1]!.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((o) => [o[1]!, o[2]!]);
  };
  const VALUES = ['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash'];

  it('all five, in their order, with the debit card selected in the add row', () => {
    const html = render('2026-10');
    expect(options(html, 'Method of the new transaction')).toEqual(VALUES.map((v) => [v, v]));
    expect(selected(html, 'Method of the new transaction')).toBe('Debit card');
    // The rows offer the same ones; the sample data uses the debit card and the bank app.
    expect(options(html, 'Method of Coffee')).toEqual(VALUES.map((v) => [v, v]));
    expect(selected(html, 'Method of Coffee')).toBe('Debit card');
    expect(selected(html, 'Method of Movies')).toBe('Bank app');
  });

  it('in Spanish and in Turkish the translated name shows and the same value is stored', () => {
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

  it('a row with credit card or cash has it selected, in any language', () => {
    const state = () => {
      const s = seedState();
      s.months['2026-10']!.tx.find((x) => x.desc === 'Coffee')!.method = 'Credit card';
      s.months['2026-10']!.tx.find((x) => x.desc === 'Gas')!.method = 'Cash';
      return s;
    };
    const en = render('2026-10', { state: state() });
    expect(selected(en, 'Method of Coffee')).toBe('Credit card');
    expect(selected(en, 'Method of Gas')).toBe('Cash');
    // They are from the list: they are not added again at the end.
    expect(options(en, 'Method of Coffee')).toHaveLength(5);
    const es = render('2026-10', { lang: 'es', state: state() });
    expect(es).toContain('<option value="Credit card" selected="">Tarjeta de crédito</option>');
    expect(es).toContain('<option value="Cash" selected="">Efectivo</option>');
    const tr = render('2026-10', { lang: 'tr', state: state() });
    expect(tr).toContain('<option value="Credit card" selected="">Kredi kartı</option>');
    expect(tr).toContain('<option value="Cash" selected="">Nakit</option>');
  });

  it('with the month closed the select looks the same, disabled', () => {
    const html = render('2026-09');
    expect(options(html, 'Method of Movies')).toEqual(VALUES.map((v) => [v, v]));
    expect(selected(html, 'Method of Movies')).toBe('Bank app');
    expect(els(html, 'select').find((x) => x['aria-label'] === 'Method of Movies')).toHaveProperty('disabled');
  });
});

describe('in Spanish', () => {
  const html = render('2026-10', { lang: 'es' });
  const t = text(html);

  it('titles, columns and goals with their figures', () => {
    expect(t).toContain('Gastos mensuales fijos 6 de 11 pagados · total 42,025.57 DOP');
    expect(t).toContain('Pago Concepto Día Monto Moneda Pagar con Cuenta DOP USD');
    // The rates note and, in the first column, the date each one applies from.
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

  it('the source of a rate shows in Spanish; the currency codes do not change', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { rates: [], transfers: [] });
    state.accounts.push(account('tr', 'TR account', 'TRY', { opening: 1000 }));
    const html = section(render('2026-10', { lang: 'es', state }), 'Tasas del mes', '>Envíos</h2>');
    const card = bare(html);
    // With the month open the figure goes in its cell (58.57, 1.39, 42.00); next to it, where it comes from.
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

  it('a single transaction uses the singular', () => {
    const state = seedState();
    const month = state.months['2026-10']!;
    month.tx = month.tx.slice(0, 1);
    expect(text(render('2026-10', { lang: 'es', state }))).toContain('Historial de transacciones 1 transacción · total 4,850.00 DOP');
  });

  it('categories and methods: the Spanish name shows and the canonical one is stored', () => {
    expect(text(section(html, 'Por categoría', 'Tasas del mes'))).toContain(
      'Por categoría DOP Gastos fijos 38,305 Supermercado 4,850 Transporte 2,320 Comida 1,535 Salud 1,240 Entretenimiento 900',
    );
    const draftRow = section(section(html, 'Historial de transacciones', 'Al cerrar el mes'), '<tbody>', '</tr>');
    expect(draftRow).toContain('<option value="Food" selected="">Comida</option><option value="Groceries">Supermercado</option>');
    expect(draftRow).toContain(
      '<option value="Debit card" selected="">Tarjeta de débito</option><option value="Credit card">Tarjeta de crédito</option><option value="Transfer">Transferencia</option><option value="Bank app">App del banco</option><option value="Cash">Efectivo</option></select>',
    );
    // No translated name slips in as a value.
    expect(html).not.toContain('value="Comida"');
    expect(html).not.toContain('value="Tarjeta');
    expect(html).not.toContain('value="Efectivo"');
  });

  it('a value from outside the list shows as is, untranslated', () => {
    const state = seedState();
    const coffee = state.months['2026-10']!.tx.find((x) => x.desc === 'Coffee')!;
    coffee.cat = 'Pets';
    coffee.method = 'Cheque';
    const out = render('2026-10', { lang: 'es', state });
    expect(out).toContain('<option value="Other">Otros</option><option value="Pets" selected="">Pets</option></select>');
    expect(out).toContain('<option value="Cash">Efectivo</option><option value="Cheque" selected="">Cheque</option></select>');
    expect(text(out)).toContain('Pets 385');
  });

  it('what the user typed is not translated; the labels and the buttons are', () => {
    const inputs = els(html, 'input');
    expect(inputs.filter((i) => i['aria-label'] === 'Concepto').map((i) => i.value)).toContain('Health insurance');
    expect(inputs.filter((i) => i['aria-label'] === 'Nombre').map((i) => i.value)).toContain('Weekly groceries');
    // Without the "—" of the Day column, which is not text.
    expect(placeholders(inputs)).toEqual([
      'Nuevo gasto mensual',
      'Día',
      '0.00',
      '0.00',
      // The fee of the sample transfer, empty, and after the draft's amount, that of the new transfer.
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
    expect(new Set(buttons(html))).toEqual(new Set(['Cancelar', '×', '↘', '⋯', 'Agregar', '+ Agregar tarjeta', 'Editar', 'Ver transacciones', 'Cerrar Octubre 2026', 'Eliminar mes', 'Credit card']));
    expect(els(html, 'button')).toContainEqual(expect.objectContaining({ title: 'Eliminar' }));
  });

  it('month with no data and closed month', () => {
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
    expect(buttons(closed)).toEqual(['Reabrir mes', 'Credit card', '+ Agregar tarjeta', 'Editar', 'Ver transacciones', ...Array<string>(10).fill('⋯'), 'Eliminar mes']);
  });
});

describe('in Turkish', () => {
  const html = render('2026-10', { lang: 'tr' });
  const t = text(html);

  it('titles, columns and goals with their figures', () => {
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

  it('the source of a rate shows in Turkish', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { rates: [], transfers: [] });
    state.accounts.push(account('tr', 'TR account', 'TRY', { opening: 1000 }));
    const html = section(render('2026-10', { lang: 'tr', state }), 'Ay kurları', '>Transferler</h2>');
    const card = bare(html);
    expect(card).toContain('— 1 USD = DOP Eylül 2026 ayından');
    expect(card).toContain('— 1 TRY = DOP varsayılan değer, henüz girilmedi');
    expect(els(html, 'input').slice(0, 2).map((i) => [i.value, i['aria-label']])).toEqual([
      ['58.57', 'Kur USD → DOP'],
      ['1.40', 'Kur TRY → DOP'],
    ]);
    // With the month closed the figure is text.
    expect(text(render('2026-09', { lang: 'tr' }))).toContain('— 1 USD = 58.57 DOP bu ayın transferlerinden');
  });

  it('a single transaction: in Turkish the noun does not change with the number', () => {
    const state = seedState();
    const month = state.months['2026-10']!;
    month.tx = month.tx.slice(0, 1);
    expect(text(render('2026-10', { lang: 'tr', state }))).toContain('İşlem geçmişi 1 işlem · toplam 4,850.00 DOP');
  });

  it('categories and methods: the Turkish name shows and the canonical one is stored', () => {
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

  it('labels, buttons and numbers: the numbers do not change format', () => {
    const inputs = els(html, 'input');
    expect(placeholders(inputs)).toEqual([
      'Yeni aylık gider',
      'Gün',
      '0.00',
      '0.00',
      // The fee of the sample transfer, empty, and after the draft's amount, that of the new transfer.
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
    expect(new Set(buttons(html))).toEqual(new Set(['İptal', '×', '↘', '⋯', 'Ekle', '+ Kart ekle', 'Düzenle', 'İşlemleri gör', 'Ekim 2026 ayını kapat', 'Ayı sil', 'Credit card']));
    expect(t).toContain('88,140.00 DOP');
    expect(t).toContain('6,228.56 106.00');
  });

  it('month with no data and closed month', () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!, { fixed: [], transfers: [], tx: [] });
    const empty = text(render('2026-10', { lang: 'tr', state }));
    expect(empty).toContain('Sabit aylık giderler 0 / 0 ödendi · toplam 0.00 DOP');
    expect(empty).toContain('Kategoriye göre DOP Bu ay henüz gider yok.');

    const closed = render('2026-09', { lang: 'tr' });
    expect(text(closed)).toContain(
      'Eylül 2026 özeti Ay kapalı. Kayıtlar salt okunur. Tutarlar DOP cinsinden Gelir 339,731 Harcanan 66,636.54 Biriken 205,010 Bütçeye göre 3,363.46 Ayı yeniden aç',
    );
    expect(buttons(closed)).toEqual(['Ayı yeniden aç', 'Credit card', '+ Kart ekle', 'Düzenle', 'İşlemleri gör', ...Array<string>(10).fill('⋯'), 'Ayı sil']);
  });
});

describe('the add rows open on demand', () => {
  it('on entering there are none: only the "+ Add …" of each card, collapsed', () => {
    const html = render('2026-10', { addRows: false });
    expect(els(html, 'input').filter((i) => i['aria-label']?.includes('new '))).toEqual([]);
    expect(html).not.toContain('New transaction');
    // With no outside-budget expenses and with its row closed, the card does not exist: no empty table and no notice.
    expect(html).not.toContain('Outside budget');
    const reveal = els(html, 'button').filter((b) => 'aria-expanded' in b);
    expect(reveal.every((b) => b['aria-expanded'] === 'false')).toBe(true);
    expect(buttons(html).filter((b) => b.startsWith('+ '))).toEqual(['+ Add expense', '+ Add rate', '+ Add card', '+ Add transfer', '+ Add income', '+ Add outside-budget expense', '+ Add transaction']);
    expect(buttons(html)).not.toContain('Add');
    expect(buttons(html)).not.toContain('Cancel');
  });

  it('in Spanish and in Turkish, each button says what it adds', () => {
    const plus = (lang: Language) => buttons(render('2026-10', { lang, addRows: false })).filter((b) => b.startsWith('+ '));
    expect(plus('es')).toEqual(['+ Agregar gasto', '+ Agregar tasa', '+ Agregar tarjeta', '+ Agregar envío', '+ Agregar ingreso', '+ Agregar gasto fuera de presupuesto', '+ Agregar transacción']);
    expect(plus('tr')).toEqual(['+ Gider ekle', '+ Kur ekle', '+ Kart ekle', '+ Transfer ekle', '+ Gelir ekle', '+ Bütçe dışı gider ekle', '+ İşlem ekle']);
  });

  it('a closed month does not offer them', () => {
    const html = render('2026-09', { addRows: false });
    expect(els(html, 'button').filter((b) => 'aria-expanded' in b)).toEqual([]);
  });
});

describe('the fee of a transfer in the history', () => {
  const withFee = () => {
    const state = seedState();
    Object.assign(state.months['2026-10']!.transfers[0]!, { fee: 2.99 });
    return state;
  };

  it('shows as a read-only row, marked, and counts in the number and in the total of the header', () => {
    const html = render('2026-10', { state: withFee() });
    const card = section(html, 'Transaction history');
    // 7 transactions + the fee: 10,845 + 2.99 × 58.76.
    expect(text(card)).toContain('Transaction history 8 transactions · total 11,020.69 DOP');
    const row = [...card.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => m[1]!).find((r) => r.includes('Remitly fee'))!;
    expect(bare(row)).toContain('Remitly fee from transfer Remitly Other 2.99 USD US account 175.69 2.99');
    // No editable fields and no ×: it is changed in the transfer.
    expect(els(row, 'input')).toEqual([expect.objectContaining({ type: 'date', value: '2026-10-02', readOnly: '' })]);
    expect(els(row, 'select')).toEqual([]);
    expect(els(row, 'button')).toEqual([]);
    expect(row).toContain('title="From the transfer of 02/10. Change it in Transfers."');
    // And it counts in "By category" as "Other".
    expect(bare(section(html, 'By category', 'Month rates'))).toContain('Other 176');
  });

  it('the draft of a transfer proposes the fee of the last one sent through that via', () => {
    const card = section(render('2026-10', { state: withFee() }), 'Transfers', INCOME);
    expect(els(card, 'input').find((i) => i['aria-label'] === 'Fee of the new transfer')).toMatchObject({ value: '2.99' });
    expect(els(card, 'input').find((i) => i['aria-label'] === 'Fee of Remitly 02/10')).toMatchObject({ value: '2.99' });
  });
});

describe('where the language comes from', () => {
  it('<I18nProvider> (the one from the app) wins over the language of the state', () => {
    const t = text(render('2026-10', { lang: 'en', provider: 'tr' }));
    expect(t).toContain('Sabit aylık giderler 6 / 11 ödendi');
    expect(t).not.toContain('Fixed monthly expenses');
  });

  it('switching language leaves no texts of the previous one', () => {
    // Interface texts of each language that match none of the sample data.
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

  it('with rows: the header counts and sums in the main currency, and each row has its move and delete buttons', () => {
    const html = render('2026-10', { state: withOutside(), addRows: false });
    const card = section(html, 'Outside budget', 'Closing the month');
    // 4,500 DOP + 10 USD at 58.76 (the rate of October 6).
    expect(text(card)).toContain('Outside budget 2 expenses · total 5,087.60 DOP');
    expect(els(card, 'button').filter((b) => b['aria-label']?.startsWith('Move'))).toEqual([
      expect.objectContaining({ 'aria-label': 'Move Gift back to the budget', title: 'Move Gift back to the budget' }),
      expect.objectContaining({ 'aria-label': 'Move Car repair back to the budget', title: 'Move Car repair back to the budget' }),
    ]);
    // The link in the "Transaction history" header is not needed: the card already has its own "+ Add".
    expect(buttons(html).filter((b) => b === '+ Add outside-budget expense')).toEqual(['+ Add outside-budget expense']);
    expect(buttons(section(html, 'Transaction history', 'Outside budget'))).not.toContain('+ Add outside-budget expense');
    // After "Transaction history", and its button to move each transaction outside.
    expect(html.indexOf('Transaction history')).toBeLessThan(html.indexOf('Outside budget'));
    expect(els(section(html, 'Transaction history', 'Outside budget'), 'button').filter((b) => b['aria-label']?.endsWith('outside the budget'))).toHaveLength(7);
    // What is used of the budget does not change.
    expect(text(html)).toContain('Transaction history 7 transactions · total 10,845.00 DOP');
  });

  it('the "+ Add outside-budget expense" link is in the Transaction history header even when the card is not shown', () => {
    const html = render('2026-10', { addRows: false });
    expect(html).not.toContain('Outside budget');
    expect(buttons(section(html, 'Transaction history')).slice(0, 2)).toEqual(['+ Add outside-budget expense', '+ Add transaction']);
  });

  it('a closed month offers neither the link nor the move buttons', () => {
    const state = withOutside();
    state.months['2026-10']!.closed = true;
    const html = render('2026-10', { state, addRows: false });
    expect(html).toContain('Outside budget');
    expect(html).not.toContain('+ Add outside-budget expense');
    expect(els(html, 'button').filter((b) => b['aria-label']?.startsWith('Move'))).toEqual([]);
  });
});

describe('credit cards', () => {
  const card = (id: string, name: string, over: Partial<CreditCard> = {}): CreditCard => ({ ...CARD, id, name, sort: id === 'a' ? 0 : id === 'b' ? 1 : 2, ...over });
  const owing = (cards: CreditCard[], other = 12000): AppState => {
    const s = { ...seedState(), cards };
    s.months['2026-10'] = { ...s.months['2026-10']!, cards: [{ cardId: cards[0]!.id, other, payments: [] }] };
    return s;
  };
  const cardsCard = (html: string) => section(html, '>Credit cards', '>Transfers</h2>');

  it('no credit cards: the invitation with its button, no credit card row in the expenses and "Credit card" out of the methods', () => {
    const html = render('2026-10', { state: seedState() });
    const ct = text(cardsCard(html));
    expect(ct).toContain('Credit cards + Add card Add a credit card to track what you owe + Add card');
    expect(html).not.toContain('from card');
    expect(html).not.toContain('Paid: Credit card');
    expect(html).not.toContain('<option value="Credit card"');
    // The "Pay with" select only offers the account.
    expect(els(section(html, 'Fixed monthly expenses', 'By category'), 'option').map((o) => o.value)).not.toContain('card:a');
  });

  it('one credit card: name, limit, cutoff, what is owed, the notice in red and the link for the due day; its row in the expenses', () => {
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
    // The Amount cell shows the total owed (here 12,000.00), not an input for "other charges".
    expect(fixed).not.toContain('aria-label="Other charges on Visa"');
    expect(text(fixed)).toContain('Visa from card — 12,000.00 DOP');
  });

  it('under 10 % the notice is calm; with a due day, it says when; in a month that is not the latest one, there is no notice', () => {
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

  it('with no limit or no cutoff, instead of the notice it asks for that data', () => {
    const ct = text(cardsCard(render('2026-10', { state: owing([card('a', 'Visa')]) })));
    expect(ct).toContain('Add a limit and a cutoff day to see how much to pay.');
    expect(ct).toContain('Limit — You owe 12,000.00 DOP Cutoff — Due —');
  });

  it('with three credit cards one shows at a time, with a counter and arrows; no back arrow on the first one', () => {
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
    // With a single one there is no counter, no arrows and no region.
    const one = cardsCard(render('2026-10', { state: owing(cards.slice(0, 1), 0) }));
    expect(one).not.toContain('role="region"');
    expect(one).not.toContain('Next card');
    expect(text(one)).not.toContain(' / ');
    // The one that is off has no row in the fixed expenses.
    expect(section(html, 'Fixed monthly expenses', 'By category')).not.toContain('Paid: Gold');
    expect(text(section(html, 'Fixed monthly expenses', 'By category'))).toContain('Master from card');
  });

  it('"Pay with" offers the account and each active credit card; the credit method picks the credit card on the transaction', () => {
    const cards = [card('a', 'Visa'), card('b', 'Master'), card('c', 'Gold', { active: false })];
    const html = render('2026-10', { state: owing(cards, 0) });
    const fixed = section(html, 'Fixed monthly expenses', 'By category');
    const select = fixed.match(/<select\b[^>]*aria-label="Pay with of Claude"[^>]*>(.*?)<\/select>/)![1]!;
    expect(els(select, 'option').map((o) => o.value)).toEqual(['account', 'card:a', 'card:b']);
    expect(text(select)).toBe(' Account Visa Master ');
    // A new transaction row with the credit method (the draft starts on debit: no credit card select yet).
    expect(section(html, '>Transaction history</h2>', '</table>')).not.toContain('Card of the new transaction');
  });
});
