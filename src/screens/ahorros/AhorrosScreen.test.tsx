// Smoke test of the whole sheet and of the goal dialog: they are rendered to HTML in Node (no DOM) with the sample
// data. It does not test interactions (the form logic is tested in goalForm.test.ts and the row logic in
// model.test.ts); it checks that the markup carries the texts, the figures and the controls, in each language.

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
  /** null = no <I18nProvider>: the state's language wins. */
  lang?: Language | null;
  /** The add rows: open (as after pressing their "+ Add …") unless false is requested, which is how the screen starts. */
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

/** Visible text, without tags. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

/** Attributes of each <tag>, regardless of the order React writes them in. */
function els(html: string, tag: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) =>
    Object.fromEntries([...m[1]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!.toLowerCase(), text(a[2] ?? '')])),
  );
}

/** Content of each <tag>…</tag>, as text. */
const inner = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 'g'))].map((m) => text(m[1]!).trim());

/** The month picker of the income table (its arrows are disabled at the ends): removed, to check that nothing else is disabled. */
const withoutPicker = (h: string) => h.replace(new RegExp(`<span class="${styles.monthPicker}">.*?</span>`), '');

const goal = (state: AppState, id: string) => state.goals.find((g) => g.id === id)!;

/** The body (<tbody>) of the table with that accessible name. */
function body(html: string, label: string): string {
  const table = html.slice(html.indexOf(`aria-label="${label}"`));
  return table.slice(table.indexOf('<tbody>'), table.indexOf('</tbody>'));
}

/** The rows of a table body, each with its markup. */
const rowsOf = (tbody: string) => tbody.split('<tr').slice(1);

/** The sample data with the main currency and the second one swapped. */
function usdMain(): AppState {
  const s = seedState();
  s.mainCurrency = 'USD';
  s.secondCurrency = 'DOP';
  return s;
}

const EN_HEADERS = ['Month', 'Income', 'Saved', '% saved', 'Date', 'Goal', 'Amount', 'Cur.', 'Rate', 'From account', 'In goal', 'DOP', '', 'Date', 'Description', 'Account', 'Amount', 'Cur.', 'Rate', 'DOP', 'Adds to budget', 'Recurring', ''];

describe('AhorrosScreen (English, the default language)', () => {
  const html = screen();
  const t = text(html);

  it('goal cards: what is saved in the goal currency and "≈" in the main one', () => {
    expect(inner(html, 'h2')).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Income by month', 'Contributions', 'Income']);
    expect(t).toContain('Emergency fund Variable contributions Edit 1,200.00 USD ≈ 70,512 DOP 3 contributions recorded');
    expect(t).toContain('Personal savings Variable contributions Edit 450.00 USD ≈ 26,442 DOP 2 contributions recorded');
    expect(t).toContain(
      'Trip to Turkey 3,000 USD / month Edit 9,000.00 USD ≈ 528,840 DOP 20% of 45,000 USD Target: October 2027 12 contributions left · 3,000 USD per month to get there',
    );
  });

  it('each card has its "Edit" and, after the last one, comes the "Add goal" card', () => {
    const buttons = els(html, 'button');
    // The icon-only expand buttons have no text: they are left out of the list.
    expect(inner(html, 'button').filter(Boolean).slice(0, 5)).toEqual(['Edit', 'Edit', 'Edit', '+ Add goal', 'Cancel']);
    expect(buttons.slice(0, 3).map((b) => b['aria-label'])).toEqual(['Edit Emergency fund', 'Edit Personal savings', 'Edit Trip to Turkey']);
    expect(buttons.slice(0, 4).every((b) => b.type === 'button')).toBe(true);
    expect(buttons[3]!.class).toBe(styles.addGoal);
    // The "+" is decoration: the button's accessible name is only "Add goal".
    expect(html).toContain('<span class="' + styles.addGoalPlus + '" aria-hidden="true">+</span>Add goal</button>');
    // The dashed card goes inside the grid, after the goals.
    const grid = html.slice(html.indexOf(`class="${styles.goals}"`), html.indexOf(`class="${styles.row}"`));
    expect(grid.indexOf(styles.addGoal!)).toBeGreaterThan(grid.lastIndexOf('Trip to Turkey'));
    // With the dialog closed there is nothing else on the sheet.
    expect(html).not.toContain('role="dialog"');
  });

  it('only the goal with a target has a bar, with the width of the percentage', () => {
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

  it('three tables, with their headers; the converted columns carry the main currency code', () => {
    expect(inner(html, 'th')).toEqual(EN_HEADERS);
    expect(els(html, 'table').map((table) => table['aria-label'])).toEqual(['Income by month', 'Contributions', 'Income']);
    expect(els(html, 'th').filter((th) => th['aria-label'] === 'Actions')).toHaveLength(2);
    // Nothing on the sheet is disabled or read-only, and with the sample data no rate is the default value.
    expect(withoutPicker(html)).not.toMatch(/\b(readonly|disabled)\b/i);
    expect(html).not.toContain(styles.fallbackNote!);
    expect(t).not.toContain('*');
  });

  it('Income by month: one row per month, all computed; nothing is typed here', () => {
    expect(t).toContain("Income by month In DOP, at each month's rate Month Income Saved % saved");
    expect(t).toContain('August 2026 337,463.33 212,369.17 62.9%');
    expect(t).toContain('September 2026 339,731.22 205,010.22 60.3%');
    expect(t).toContain('October 2026 340,808.00 205,660.00 60.3%');
    const tbody = body(html, 'Income by month');
    expect(rowsOf(tbody)).toHaveLength(3);
    expect(els(tbody, 'input')).toHaveLength(0);
    expect(els(tbody, 'select')).toHaveLength(0);
  });

  it('Contributions: total in the main currency, add row on top and editable history', () => {
    expect(t).toContain('Contributions Total 625,794.00 DOP'); // 10,650 USD × 58.76
    const tbody = body(html, 'Contributions');
    const rows = rowsOf(tbody);
    expect(rows).toHaveLength(9);

    // The add row is the first one in the table body.
    const add = rows[0]!;
    const inputs = els(add, 'input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ type: 'date', value: '2026-10-07', 'aria-label': 'Contribution date' });
    expect(inputs[1]).toMatchObject({ type: 'number', step: 'any', value: '', placeholder: '0.00', style: 'min-width:70px', 'aria-label': 'Amount' });
    // The select lists the user's goals, in the order of the cards; the currency starts as the goal's.
    expect(inner(add, 'select')).toEqual(['Emergency fund Personal savings Trip to Turkey', 'DOP USD TRY', 'Month rate Manual', '— none — US account DR account']);
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Goal', 'Currency', 'Rate (USD→DOP)', 'From account']);
    expect(add).toContain('<option value="emergency" selected="">Emergency fund</option>');
    expect(add).toContain('<option value="DOP">DOP</option><option value="USD" selected="">USD</option><option value="TRY">TRY</option>');
    expect(els(add, 'td')).toContainEqual(expect.objectContaining({ colspan: '3' }));
    expect(add).toContain('>Add</button>');

    // Each contribution is edited in its row: date, goal, amount and currency.
    const first = rows[1]!;
    expect(els(first, 'input')).toEqual([
      expect.objectContaining({ type: 'date', value: '2026-10-03', 'aria-label': 'Contribution date' }),
      expect.objectContaining({ type: 'number', value: '3000', 'aria-label': 'Amount' }),
    ]);
    expect(els(first, 'select').map((s) => s['aria-label'])).toEqual(['Goal', 'Currency', 'Rate (USD→DOP)', 'From account']);
    expect(first).toContain('<option value="turkey" selected="">Trip to Turkey</option>');
    expect(first).toContain('<option value="USD" selected="">USD</option>');
    // The two computed columns: in the goal's currency and in the main one.
    expect(text(first)).toContain('3,000.00 USD 176,280.00');
    const last = rows[8]!;
    expect(els(last, 'input').map((i) => i.value)).toEqual(['2026-08-03', '400']);
    expect(last).toContain('<option value="emergency" selected="">Emergency fund</option>');
    expect(text(last)).toContain('400.00 USD 23,273.33');
    // August's rate comes from its transfers: this is said when hovering over the converted figure.
    expect(els(last, 'td').map((td) => td.title)).toContain("from this month's transfers");
    expect(els(first, 'td').some((td) => 'title' in td)).toBe(false);

    const deletes = els(tbody, 'button').filter((b) => b.title === 'Delete');
    expect(deletes).toHaveLength(8);
    expect(deletes[0]!['aria-label']).toBe('Delete contribution of 2026-10-03 to Trip to Turkey: 3,000.00 USD');
  });

  it('Income: the income of the selected month, add row on top and the editable list, from newest to oldest', () => {
    // The month picker (previous, list of months, next) goes before the month's figure.
    expect(t).toContain('Income ‹ August 2026 September 2026 October 2026 › 340,808.00 DOP Cancel Date Description Account Amount Cur. Rate DOP Adds to budget Recurring');
    const tbody = body(html, 'Income');
    const rows = rowsOf(tbody);
    // Only October's incomes: the add row and the salary.
    expect(rows).toHaveLength(2);

    const add = rows[0]!;
    expect(els(add, 'input')).toEqual([
      expect.objectContaining({ type: 'date', value: '2026-10-07', 'aria-label': 'Income date' }),
      expect.objectContaining({ type: 'text', value: '', placeholder: 'Salary, payment…', maxlength: '200', 'aria-label': 'Description' }),
      expect.objectContaining({ type: 'number', step: 'any', value: '', placeholder: '0.00', 'aria-label': 'Amount' }),
      expect.objectContaining({ type: 'checkbox', 'aria-label': 'The new income adds to the budget' }),
      expect.objectContaining({ type: 'checkbox', 'aria-label': 'The new income repeats every month' }),
    ]);
    // The default account is in the main currency: there is no rate control.
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Account', 'Currency']);
    // The visible accounts, with the default account selected and its currency.
    expect(inner(add, 'select')).toEqual(['US account DR account', 'DOP USD TRY']);
    expect(add).toContain('<option value="dr" selected="">DR account</option>');
    expect(add).toContain('<option value="DOP" selected="">DOP</option>');
    // One cell per column: the converted figure's cell is empty and the button no longer spans two.
    expect(els(add, 'td')).toHaveLength(10);
    expect(els(add, 'td').some((td) => 'colspan' in td)).toBe(false);
    expect(inner(add, 'td')[6]).toBe('');
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
    expect(rows.slice(1).map((r) => els(r, 'input')[0]!.value)).toEqual(['2026-10-01']);
    // August is seen by choosing August; its rate comes from that month's transfers.
    const august = rowsOf(body(screen({ monthKey: '2026-08' }), 'Income'));
    expect(august.slice(1).map((r) => els(r, 'input')[0]!.value)).toEqual(['2026-08-01']);
    expect(text(august[1]!)).toContain('337,463.33');
    expect(els(august[1]!, 'td').map((td) => td.title)).toContain("from this month's transfers");

    const deletes = els(tbody, 'button').filter((b) => b.title === 'Delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!['aria-label']).toBe('Delete income of 2026-10-01: 5,800.00 USD');
  });

  it('Income: the "Adds to budget" column, one checkbox per income and another in the add row, unchecked', () => {
    const table = els(html, 'table').find((x) => x['aria-label'] === 'Income')!;
    expect(table.style).toContain('min-width:1000px');
    const headers = inner(html.slice(html.indexOf('aria-label="Income"')), 'th');
    expect(headers).toEqual(['Date', 'Description', 'Account', 'Amount', 'Cur.', 'Rate', 'DOP', 'Adds to budget', 'Recurring', '']);
    const rows = rowsOf(body(html, 'Income'));
    // Each row has as many cells as headers; the checkboxes go under "Adds to budget" and "Recurring".
    for (const row of rows) {
      expect(els(row, 'td')).toHaveLength(headers.length);
      const cells = row.split('<td').slice(1);
      expect(cells.map((c) => c.includes('type="checkbox"'))).toEqual([false, false, false, false, false, false, false, true, true, false]);
    }
    const boxes = els(body(html, 'Income'), 'input').filter((i) => i.type === 'checkbox');
    expect(boxes.map((b) => b['aria-label'])).toEqual([
      'The new income adds to the budget',
      'The new income repeats every month',
      'Adds to budget: income of 2026-10-01, 5,800.00 USD',
      'Recurring: income of 2026-10-01, 5,800.00 USD',
    ]);
    // In Savings a new income does not raise the budget unless it is checked; the sample ones do not either.
    expect(boxes.some((b) => 'checked' in b)).toBe(false);
    expect(boxes.some((b) => 'disabled' in b)).toBe(false);
    // The other two tables have no checkboxes.
    expect(els(body(html, 'Contributions'), 'input').some((i) => i.type === 'checkbox')).toBe(false);
  });

  it('Income: an income that raises the budget shows its checkbox checked; the one in the add row stays unchecked', () => {
    const s = seedState();
    s.incomes.find((i) => i.id === 'seed-in-2')!.budget = true;
    s.incomes.push({ id: 'bono', date: '2026-10-05', desc: 'Bonus', accountId: 'dr', amount: 2500, cur: 'DOP', budget: true });
    const marked = screen({ state: s });
    const boxes = els(body(marked, 'Income'), 'input').filter((i) => i.type === 'checkbox');
    expect(boxes.map((b) => `${b['aria-label']} ${'checked' in b}`).filter((x) => !x.startsWith('Recurring') && !x.includes('repeats'))).toEqual([
      'The new income adds to the budget false',
      'Adds to budget: income of 2026-10-05, 2,500.00 DOP true',
      'Adds to budget: income of 2026-10-01, 5,800.00 USD false',
    ]);
    // September's (checked) is seen by choosing September.
    const sep = els(body(screen({ state: s, monthKey: '2026-09' }), 'Income'), 'input').filter((i) => i.type === 'checkbox');
    expect(sep.map((b) => `${b['aria-label']} ${'checked' in b}`)).toContain('Adds to budget: income of 2026-09-01, 5,800.00 USD true');
    // The checkbox does not change the month's income: it is counted all the same (340,808 + 2,500).
    expect(text(marked)).toContain('› 343,308.00 DOP');
  });

  it('with a closed month selected only the month income in the header changes: nothing here depends on the month', () => {
    const closed = screen({ monthKey: '2026-08' });
    expect(text(closed)).toContain('› 337,463.33 DOP Cancel Date');
    // Everything before that header and the other two tables are the same; the income table shows that month's, just as editable.
    const before = (h: string) => h.slice(0, h.lastIndexOf('<h2'));
    expect(before(closed)).toBe(before(html));
    for (const label of ['Income by month', 'Contributions']) expect(body(closed, label)).toBe(body(html, label));
    expect(els(body(closed, 'Income'), 'input')[0]).toMatchObject({ value: '2026-08-01' });
    expect(withoutPicker(closed)).not.toMatch(/\b(readonly|disabled)\b/i);
  });

  it('a hidden account still shows with its name on the income that went into it, but is not offered for a new one', () => {
    const s = seedState();
    s.accounts.find((a) => a.id === 'us')!.hidden = true;
    const rows = rowsOf(body(screen({ state: s }), 'Income'));
    expect(inner(rows[0]!, 'select')[0]).toBe('DR account');
    expect(inner(rows[1]!, 'select')[0]).toBe('DR account US account');
    expect(rows[1]).toContain('<option value="us" selected="">US account</option>');
  });

  it('no contributions: goals at zero and the table with only the add row', () => {
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

  it('no incomes: the months at zero, with no % saved, and the table with only the add row', () => {
    const s = seedState();
    s.incomes = [];
    const empty = screen({ state: s });
    expect(text(empty)).toContain('October 2026 0.00 205,660.00 —');
    expect(text(empty)).toContain('› 0.00 DOP');
    expect(rowsOf(body(empty, 'Income'))).toHaveLength(1);
    expect(inner(body(empty, 'Income'), 'button')).toEqual(['Add']);
  });

  it('goal reached or with the target month passed: the card says so instead of asking for "0 USD per month"', () => {
    const s = seedState();
    Object.assign(goal(s, 'turkey'), { start: '2026-08', end: '2026-09' });
    expect(text(screen({ state: s }))).toContain('100% of 6,000 USD Target: September 2026 Target reached');
    goal(s, 'turkey').monthly = 10000;
    expect(text(screen({ state: s }))).toContain('45% of 20,000 USD Target: September 2026 Target month passed · 11,000.00 USD to go');
  });

  it('no goals: only the "Add goal" card, and the contributions add row disabled with the notice', () => {
    const s = seedState();
    s.goals = [];
    s.contribs = [];
    const empty = screen({ state: s });
    expect(inner(empty, 'h2')).toEqual(['Income by month', 'Contributions', 'Income']);
    expect(empty).toContain(`class="${styles.goals}"`);
    // The icon-only expand buttons have no text: they are left out of the list.
    expect(inner(empty, 'button').filter(Boolean).slice(0, 3)).toEqual(['+ Add goal', 'Cancel', 'Add']);

    // The add row has no fields: it says what is needed, and its button is disabled.
    const tbody = body(empty, 'Contributions');
    expect(text(tbody).trim()).toBe('Add a goal first to record contributions. Add');
    expect(rowsOf(tbody)).toHaveLength(1);
    expect(els(tbody, 'td').map((td) => td.colspan)).toEqual(['4', '5']);
    expect(els(tbody, 'input')).toHaveLength(0);
    expect(els(tbody, 'select')).toHaveLength(0);
    expect(els(tbody, 'button')).toEqual([expect.objectContaining({ disabled: '', class: expect.stringContaining(styles.addOff!) })]);
    // Incomes do not depend on goals: they stay just as editable.
    expect(body(empty, 'Income')).not.toMatch(/\b(readonly|disabled)\b/i);
    expect(rowsOf(body(empty, 'Income'))).toHaveLength(2);
  });
});

describe('AhorrosScreen with other currencies', () => {
  it('with USD as the main currency: the goals in USD have no "≈" and the columns and totals are in USD', () => {
    const html = screen({ state: usdMain() });
    const t = text(html);
    expect(t).toContain('Emergency fund Variable contributions Edit 1,200.00 USD 3 contributions recorded');
    expect(t).toContain('Trip to Turkey 3,000 USD / month Edit 9,000.00 USD 20% of 45,000 USD');
    expect(t).not.toContain('≈');
    expect(inner(html, 'th')).toEqual(EN_HEADERS.map((h) => (h === 'DOP' ? 'USD' : h)));
    expect(t).toContain("Income by month In USD, at each month's rate");
    expect(t).toContain('October 2026 5,800.00 3,500.00 60.3%');
    expect(t).toContain('Contributions Total 10,650.00 USD');
    expect(t).toContain('› 5,800.00 USD');
    expect(text(rowsOf(body(html, 'Contributions'))[1]!)).toContain('3,000.00 USD 3,000.00');
    // The default account is still the one chosen in Settings, and the new income's currency, that account's.
    expect(rowsOf(body(html, 'Income'))[0]).toContain('<option value="DOP" selected="">DOP</option>');
  });

  it('a goal in TRY: the card in TRY, the currency of the new contribution follows the goal and each contribution shows in TRY', () => {
    const s = seedState();
    s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    s.goals = [{ id: 'tr', name: 'Istanbul', cur: 'TRY', monthly: 10000, start: '2026-10', end: '2027-09', approxCur: null, sort: 0 }];
    s.contribs = [
      { id: 'a', goalId: 'tr', date: '2026-10-05', amount: 100, cur: 'USD' },
      { id: 'b', goalId: 'tr', date: '2026-10-04', amount: 2000, cur: 'TRY' },
    ];
    const html = screen({ state: s });
    // 100 USD × 40 + 2,000 = 6,000 TRY; in DOP, crossing through USD: 6,000 / 40 × 58.76.
    expect(text(html)).toContain(
      'Istanbul 10,000 TRY / month Edit 6,000.00 TRY ≈ 8,814 DOP 5% of 120,000 TRY Target: September 2027 11 contributions left · 10,364 TRY per month to get there',
    );
    expect(html).toContain('title="crossed through USD"');
    const rows = rowsOf(body(html, 'Contributions'));
    expect(rows[0]).toContain('<option value="TRY" selected="">TRY</option>');
    expect(text(rows[1]!)).toContain('4,000.00 TRY 5,876.00');
    expect(text(rows[2]!)).toContain('2,000.00 TRY 2,938.00');
    expect(text(html)).toContain('Contributions Total 8,814.00 DOP');
    // All the rates come from the month: nothing flagged as a default value.
    expect(html).not.toContain(styles.fallbackNote!);
  });

  it('the "≈" line of each card is in the currency the goal chose; if it chose its own, there is no line', () => {
    const s = seedState();
    s.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    goal(s, 'emergency').approxCur = 'TRY';
    goal(s, 'personal').approxCur = 'USD';
    const html = screen({ state: s });
    const t = text(html);
    // 1,200 USD × 40: in TRY, which is neither the user's main currency nor the second one.
    expect(t).toContain('Emergency fund Variable contributions Edit 1,200.00 USD ≈ 48,000 TRY 3 contributions recorded');
    expect(t).toContain('Personal savings Variable contributions Edit 450.00 USD 2 contributions recorded');
    // The one that did not choose stays in the main one.
    expect(t).toContain('Trip to Turkey 3,000 USD / month Edit 9,000.00 USD ≈ 528,840 DOP 20% of 45,000 USD');
    expect(t.split('≈')).toHaveLength(3);
    // The rest of the sheet stays in the main currency.
    expect(t).toContain('Contributions Total 625,794.00 DOP');
    expect(html).not.toContain(styles.fallbackNote!);

    // With no TRY rate typed, that card's figure is flagged as made with the default value (1 USD = 42 TRY).
    const d = seedState();
    goal(d, 'emergency').approxCur = 'TRY';
    const marked = screen({ state: d });
    expect(text(marked)).toContain('Emergency fund Variable contributions Edit 1,200.00 USD ≈ 50,400 TRY* 3 contributions recorded');
    expect(els(marked, 'div').find((x) => x.class?.includes(styles.fallback!))).toMatchObject({ title: 'default value, not set yet' });

    // With USD as the main currency, the USD goal that chose DOP keeps its line; the others have none.
    const u = usdMain();
    goal(u, 'turkey').approxCur = 'DOP';
    const usd = text(screen({ state: u }));
    expect(usd).toContain('Trip to Turkey 3,000 USD / month Edit 9,000.00 USD ≈ 528,840 DOP 20% of 45,000 USD');
    expect(usd.split('≈')).toHaveLength(2);
  });

  it('with two rates typed in the month, each row uses the one in effect on its date and the "≈" line the last one', () => {
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
    // The bonus of the 6th at 60; the salary of the 1st, at 58.76 as before.
    expect(text(incomes[1]!)).toContain('6,000.00');
    expect(text(incomes[2]!)).toContain('340,808.00');
    expect(t).toContain('› 346,808.00 DOP');
    const contribs = rowsOf(body(html, 'Contributions'));
    // 6,000 DOP of the 7th are 100 USD in the goal; the 3,000 USD of the 3rd stay at 58.76.
    expect(text(contribs[1]!)).toContain('100.00 USD 6,000.00');
    expect(text(contribs[2]!)).toContain('3,000.00 USD 176,280.00');
    expect(t).toContain('October 2026 346,808.00 211,660.00 61.0%');
    // The cards: what is saved (450 + 100 USD) at the current month's last rate, 60.
    expect(t).toContain('Personal savings Variable contributions Edit 550.00 USD ≈ 33,000 DOP 3 contributions recorded');
    expect(t).toContain('Emergency fund Variable contributions Edit 1,200.00 USD ≈ 72,000 DOP');
    // Both are month rates: nothing to note on October's rows.
    expect(els(incomes[1]!, 'td').some((td) => 'title' in td)).toBe(false);
    expect(els(contribs[1]!, 'td').some((td) => 'title' in td)).toBe(false);
  });

  it('a figure converted with the default rate is flagged, with its notice below the table', () => {
    const s = seedState();
    goal(s, 'personal').cur = 'TRY';
    s.incomes.push({ id: 'x', date: '2026-09-10', desc: 'Kira', accountId: 'dr', amount: 4200, cur: 'TRY', budget: false });
    const html = screen({ state: s, monthKey: '2026-09' });
    const t = text(html);
    const note = '* Converted with a default rate that has not been set yet.';
    expect(t.split(note)).toHaveLength(4);
    expect(els(html, 'div').filter((d) => d.class === styles.fallbackNote)).toHaveLength(3);
    // The card: 450 USD × 42 = 18,900 TRY, and back to DOP with the default values.
    expect(t).toContain('Personal savings Variable contributions Edit 18,900.00 TRY ≈ 26,442 DOP* 2 contributions recorded');
    expect(els(html, 'div').find((d) => d.class?.includes(styles.fallback!))).toMatchObject({ title: 'default value, not set yet' });
    // Income by month: only September's income, the month of the TRY income (what was saved that month was in USD).
    expect(t).toContain('September 2026 345,607.22* 205,010.22 59.3%');
    expect(t).toContain('October 2026 340,808.00 205,660.00 60.3%');
    // Contributions: the goal column of the contributions to the TRY goal.
    const contribs = rowsOf(body(html, 'Contributions'));
    expect(text(contribs[3]!)).toContain('8,400.00 TRY* 11,714.87');
    expect(els(contribs[3]!, 'td').filter((td) => td.title === 'default value, not set yet')).toHaveLength(1);
    expect(text(contribs[1]!)).not.toContain('*');
    // Income: the TRY one.
    const incomes = rowsOf(body(html, 'Income'));
    expect(text(incomes[1]!)).toContain('5,876.00*');
    expect(text(incomes[2]!)).not.toContain('*');
  });
});

const ES_HEADERS = ['Mes', 'Ingreso', 'Ahorrado', '% ahorro', 'Fecha', 'Meta', 'Monto', 'Mon.', 'Tasa', 'Desde cuenta', 'En la meta', 'DOP', '', 'Fecha', 'Descripción', 'Cuenta', 'Monto', 'Mon.', 'Tasa', 'DOP', 'Suma al presupuesto', 'Recurrente', ''];

describe('AhorrosScreen in Spanish', () => {
  // The app's data (stored in English) with the interface in Spanish: what the user types is not translated.
  const html = screen({ lang: 'es' });
  const t = text(html);

  it('cards, tables and controls', () => {
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
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Meta', 'Moneda', 'Tasa (USD→DOP)', 'Desde cuenta']);
    expect(add).toContain('>Agregar</button>');
    expect(text(rowsOf(contribs)[1]!)).toContain('3,000.00 USD 176,280.00');
    expect(els(rowsOf(contribs)[8]!, 'td').map((td) => td.title)).toContain('de los envíos de este mes');
    const deletes = els(contribs, 'button').filter((b) => b.title === 'Eliminar');
    expect(deletes).toHaveLength(8);
    expect(deletes[0]!['aria-label']).toBe('Eliminar aporte del 2026-10-03 a Trip to Turkey: 3,000.00 USD');
  });

  it('the incomes, one by one', () => {
    expect(t).toContain('Ingresos ‹ Agosto 2026 Septiembre 2026 Octubre 2026 › 340,808.00 DOP Cancelar Fecha Descripción Cuenta Monto Mon. Tasa DOP Suma al presupuesto Recurrente');
    const incomes = body(html, 'Ingresos');
    const add = rowsOf(incomes)[0]!;
    expect(els(add, 'input').map((i) => i['aria-label'])).toEqual(['Fecha del ingreso', 'Descripción', 'Monto', 'El ingreso nuevo suma al presupuesto', 'El ingreso nuevo se repite cada mes']);
    expect(els(add, 'input')[1]).toMatchObject({ placeholder: 'Sueldo, pago…' });
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Cuenta', 'Moneda']);
    expect(inner(add, 'button')).toEqual(['Agregar']);
    // The description and the account name are the user's: they show as typed.
    expect(els(rowsOf(incomes)[1]!, 'input')[1]).toMatchObject({ value: 'Salary' });
    expect(els(rowsOf(incomes)[1]!, 'input')[3]).toMatchObject({ type: 'checkbox', 'aria-label': 'Suma al presupuesto: ingreso del 2026-10-01, 5,800.00 USD' });
    expect(rowsOf(incomes)[1]).toContain('<option value="us" selected="">US account</option>');
    const deletes = els(incomes, 'button').filter((b) => b.title === 'Eliminar');
    expect(deletes.map((b) => b['aria-label'])).toEqual(['Eliminar ingreso del 2026-10-01: 5,800.00 USD']);
  });

  it('editing and adding goals', () => {
    // The icon-only expand buttons have no text: they are left out of the list.
    expect(inner(html, 'button').filter(Boolean).slice(0, 5)).toEqual(['Editar', 'Editar', 'Editar', '+ Agregar meta', 'Cancelar']);
    expect(els(html, 'button')[0]!['aria-label']).toBe('Editar Emergency fund');
  });

  it('singular and plural', () => {
    const s = seedState();
    s.contribs = s.contribs.filter((c) => c.goalId !== 'personal').concat({ id: 'x', goalId: 'personal', date: '2026-10-05', amount: 50, cur: 'USD' });
    // The trip's plan ends this month and a contribution was already made: one contribution is left.
    goal(s, 'turkey').end = '2026-10';
    const one = text(screen({ state: s, lang: 'es' }));
    expect(one).toContain('Personal savings Aportes variables Editar 50.00 USD ≈ 2,938 DOP 1 aporte registrado');
    expect(one).toContain('100% de 9,000 USD Meta: octubre 2026 Meta alcanzada');
    goal(s, 'turkey').monthly = 4000;
    expect(text(screen({ state: s, lang: 'es' }))).toContain('75% de 12,000 USD Meta: octubre 2026 Falta 1 aporte · 3,000 USD por mes para llegar');
  });

  it('without <I18nProvider> the language of the user state wins', () => {
    const s = seedState();
    s.language = 'es';
    expect(screen({ state: s, lang: null })).toBe(html);
  });

  it('with no goals, the notice in the add row; with a default rate, the notice below the table', () => {
    const s = seedState();
    s.goals = [];
    s.contribs = [];
    const empty = screen({ state: s, lang: 'es' });
    // The icon-only expand buttons have no text: they are left out of the list.
    expect(inner(empty, 'button').filter(Boolean).slice(0, 3)).toEqual(['+ Agregar meta', 'Cancelar', 'Agregar']);
    expect(text(body(empty, 'Aportes')).trim()).toBe('Agrega primero una meta para registrar aportes. Agregar');

    s.incomes.push({ id: 'x', date: '2026-09-10', desc: '', accountId: 'dr', amount: 4200, cur: 'TRY', budget: false });
    const marked = screen({ state: s, lang: 'es', monthKey: '2026-09' });
    expect(text(marked)).toContain('* Convertido con una tasa por defecto, aún sin definir.');
    expect(marked).toContain('title="valor por defecto, aún sin definir"');
  });
});

const TR_HEADERS = ['Ay', 'Gelir', 'Biriken', 'Birikim oranı', 'Tarih', 'Hedef', 'Tutar', 'Birim', 'Kur', 'Hesaptan', 'Hedefte', 'DOP', '', 'Tarih', 'Açıklama', 'Hesap', 'Tutar', 'Birim', 'Kur', 'DOP', 'Bütçeye eklenir', 'Düzenli', ''];

describe('AhorrosScreen in Turkish', () => {
  // The app's data (in English) with the interface in Turkish: the goal names are not translated.
  const html = screen({ lang: 'tr' });
  const t = text(html);

  it('cards, tables and controls', () => {
    expect(inner(html, 'h2')).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Aylara göre gelir', 'Katkılar', 'Gelirler']);
    expect(t).toContain('Emergency fund Değişken katkılar Düzenle 1,200.00 USD ≈ 70,512 DOP 3 katkı kaydedildi');
    expect(t).toContain(
      'Trip to Turkey 3,000 USD / ay Düzenle 9,000.00 USD ≈ 528,840 DOP %20 / 45,000 USD Hedef: Ekim 2027 12 katkı kaldı · hedefe ulaşmak için ayda 3,000 USD',
    );
    expect(els(html, 'div').find((d) => d.role === 'progressbar')).toMatchObject({ 'aria-label': 'Trip to Turkey ilerlemesi' });

    expect(t).toContain('Aylara göre gelir DOP cinsinden, her ayın kuruyla');
    expect(inner(html, 'th')).toEqual(TR_HEADERS);
    expect(els(html, 'table').map((table) => table['aria-label'])).toEqual(['Aylara göre gelir', 'Katkılar', 'Gelirler']);
    // Numbers use the same format in every language.
    expect(t).toContain('Ağustos 2026 337,463.33 212,369.17 62.9%');
    expect(t).toContain('Ekim 2026 340,808.00 205,660.00 60.3%');

    expect(t).toContain('Katkılar Toplam 625,794.00 DOP');
    // The icon-only expand buttons have no text: they are left out of the list.
    expect(inner(html, 'button').filter(Boolean).slice(0, 5)).toEqual(['Düzenle', 'Düzenle', 'Düzenle', '+ Hedef ekle', 'İptal']);
    expect(els(html, 'button')[2]!['aria-label']).toBe('Düzenle: Trip to Turkey');
    const contribs = body(html, 'Katkılar');
    const add = rowsOf(contribs)[0]!;
    expect(els(add, 'input').map((i) => i['aria-label'])).toEqual(['Katkı tarihi', 'Tutar']);
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Hedef', 'Para birimi', 'Kur (USD→DOP)', 'Hesaptan']);
    const deletes = els(contribs, 'button').filter((b) => b.title === 'Sil');
    expect(deletes).toHaveLength(8);
    expect(deletes[0]!['aria-label']).toBe('2026-10-03 tarihli Trip to Turkey katkısını sil: 3,000.00 USD');
  });

  it('the incomes, one by one', () => {
    expect(t).toContain('Gelirler ‹ Ağustos 2026 Eylül 2026 Ekim 2026 › 340,808.00 DOP İptal Tarih Açıklama Hesap Tutar Birim Kur DOP Bütçeye eklenir Düzenli');
    const incomes = body(html, 'Gelirler');
    const add = rowsOf(incomes)[0]!;
    expect(els(add, 'input').map((i) => i['aria-label'])).toEqual(['Gelir tarihi', 'Açıklama', 'Tutar', 'Yeni gelir bütçeye eklenir', 'Yeni gelir her ay tekrarlanır']);
    expect(els(add, 'input')[1]).toMatchObject({ placeholder: 'Maaş, ödeme…' });
    expect(els(add, 'select').map((s) => s['aria-label'])).toEqual(['Hesap', 'Para birimi']);
    expect(inner(add, 'button')).toEqual(['Ekle']);
    expect(els(rowsOf(incomes)[1]!, 'input')[3]).toMatchObject({ type: 'checkbox', 'aria-label': 'Bütçeye eklenir: 2026-10-01 geliri, 5,800.00 USD' });
    const deletes = els(incomes, 'button').filter((b) => b.title === 'Sil');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!['aria-label']).toBe('2026-10-01 tarihli geliri sil: 5,800.00 USD');
    const august = rowsOf(body(screen({ lang: 'tr', monthKey: '2026-08' }), 'Gelirler'));
    expect(els(august[1]!, 'td').map((td) => td.title)).toContain('bu ayın transferlerinden');
  });

  it('with a single contribution the text is the same (in Turkish the noun does not change after a number)', () => {
    const s = seedState();
    s.contribs = s.contribs.filter((c) => c.goalId !== 'personal').concat({ id: 'x', goalId: 'personal', date: '2026-10-05', amount: 50, cur: 'USD' });
    expect(text(screen({ state: s, lang: 'tr' }))).toContain('Personal savings Değişken katkılar Düzenle 50.00 USD ≈ 2,938 DOP 1 katkı kaydedildi');
  });

  it('goal reached, target month passed, no goals and with a default rate', () => {
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
    expect(text(screen({ state: s, lang: 'tr', monthKey: '2026-09' }))).toContain('* Henüz girilmemiş, varsayılan bir kurla çevrildi.');
  });
});

describe('GoalDialog', () => {
  const state = seedState();
  const labels = (html: string) => inner(html, 'label');
  const selected = (html: string) => [...html.matchAll(/<option value="[^"]*" selected="">(.*?)<\/option>/g)].map((m) => m[1]);

  it('new goal: empty name, in the main currency, with no target and no delete button', () => {
    const html = dialog(null);
    expect(els(html, 'div').find((d) => d.role === 'dialog')).toMatchObject({ 'aria-modal': 'true', style: 'max-width:480px' });
    expect(inner(html, 'h2')).toEqual(['New goal']);
    expect(labels(html)).toEqual(['Name', 'Currency', 'Show equivalent in', 'This goal has a target']);
    const inputs = els(html, 'input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ value: '', maxlength: '120', autocomplete: 'off' });
    expect(inputs[1]).toMatchObject({ type: 'checkbox' });
    expect('checked' in inputs[1]!).toBe(false);
    // The currency and the "≈" line's: all three in each select, with the user's main one selected in both.
    expect(inner(html, 'select')).toEqual(['DOP USD TRY', 'DOP USD TRY']);
    expect(selected(html)).toEqual(['DOP', 'DOP']);
    expect(selected(dialog(null, { state: usdMain() }))).toEqual(['USD', 'USD']);
    // Enter saves: the content is a form and "Save" is its submit button.
    expect(els(html, 'form')).toHaveLength(1);
    expect(inner(html, 'button')).toEqual(['Cancel', 'Save']);
    expect(els(html, 'button').map((b) => b.type)).toEqual(['button', 'submit']);
    // Freshly opened it shows no errors.
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/aria-invalid/);
  });

  it('variable contributions goal with contributions: it cannot be deleted and says why', () => {
    const html = dialog(goal(state, 'emergency'));
    expect(inner(html, 'h2')).toEqual(['Edit goal']);
    expect(els(html, 'input')[0]).toMatchObject({ value: 'Emergency fund' });
    expect(labels(html)).toEqual(['Name', 'Currency', 'Show equivalent in', 'This goal has a target']);
    // It opens in the goal's currency, not in the main one; the "≈" line, with nothing chosen, in the main one.
    expect(selected(html)).toEqual(['USD', 'DOP']);
    expect(inner(html, 'button')).toEqual(['Delete goal', 'Cancel', 'Save']);
    const remove = els(html, 'button')[0]!;
    expect(remove).toMatchObject({ type: 'button', disabled: '' });
    expect(text(html)).toContain('Delete goal Delete its 3 contributions first Cancel Save');
    // The reason is associated with the button.
    expect(els(html, 'span').find((span) => span.id === remove['aria-describedby'])).toBeDefined();
  });

  it('goal with a target: the currency, the four plan fields, in their order, and the summary', () => {
    const html = dialog(goal(state, 'turkey'));
    expect(labels(html)).toEqual(['Name', 'Currency', 'Show equivalent in', 'This goal has a target', 'Target amount (USD)', 'Start month', 'Target month', 'Monthly saving (USD)']);
    const inputs = els(html, 'input');
    expect(inputs.map((i) => i.value ?? '')).toEqual(['Trip to Turkey', '', '45000', '3000']);
    expect('checked' in inputs[1]!).toBe(true);
    expect(inputs[2]).toMatchObject({ type: 'number', step: 'any', inputmode: 'decimal', placeholder: '0.00' });
    expect(inputs[3]).toMatchObject({ type: 'number', step: 'any', inputmode: 'decimal', placeholder: '0.00' });
    // The currency and the "≈" line's (with its visible label); start month and year; target month and year.
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
    // Each label points to its control.
    const ids = [...inputs.map((i) => i.id), ...els(html, 'select').map((s) => s.id)];
    const targets = els(html, 'label').filter((l) => l.for);
    expect(targets).toHaveLength(7);
    for (const label of targets) expect(ids).toContain(label.for);
    expect(text(html)).toContain('Delete its 3 contributions first');
  });

  it('the amount labels and the summary carry the code of the goal currency', () => {
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

  it('the "Show equivalent in" select: next to the currency, with the one the goal chose or, if it chose none, the main one', () => {
    const s = seedState();
    const html = dialog(goal(s, 'emergency'), { state: s });
    // It is the second select, with its visible label pointing to it, and it offers the three currencies.
    const selects = els(html, 'select');
    const label = els(html, 'label')[inner(html, 'label').indexOf('Show equivalent in')]!;
    expect(label.for).toBe(selects[1]!.id);
    expect(label.for).not.toBe(selects[0]!.id);
    expect(inner(html, 'select').slice(0, 2)).toEqual(['DOP USD TRY', 'DOP USD TRY']);
    expect(text(html)).toContain('Currency DOP USD TRY Show equivalent in DOP USD TRY This goal has a target');
    // With nothing chosen: the user's main one, whichever it is.
    expect(selected(html)).toEqual(['USD', 'DOP']);
    expect(selected(dialog(goal(usdMain(), 'emergency'), { state: usdMain() }))).toEqual(['USD', 'USD']);
    // Chosen: the goal's, even if it is its own or if it matches the user's second one.
    goal(s, 'emergency').approxCur = 'TRY';
    expect(selected(dialog(goal(s, 'emergency'), { state: s }))).toEqual(['USD', 'TRY']);
    goal(s, 'emergency').approxCur = 'USD';
    expect(selected(dialog(goal(s, 'emergency'), { state: s }))).toEqual(['USD', 'USD']);
    // It does not depend on the goal's currency or on whether it has a target.
    Object.assign(goal(s, 'turkey'), { cur: 'TRY', approxCur: 'USD' });
    expect(selected(dialog(goal(s, 'turkey'), { state: s }))).toEqual(['TRY', 'USD', 'August', '2026', 'October', '2027']);
    // In the other languages the label changes, not what is chosen.
    const es = dialog(goal(s, 'turkey'), { state: s, lang: 'es' });
    expect(text(es)).toContain('Moneda DOP USD TRY Mostrar equivalente en DOP USD TRY');
    expect(selected(es).slice(0, 2)).toEqual(['TRY', 'USD']);
    expect(labels(dialog(goal(s, 'turkey'), { state: s, lang: 'tr' }))).toContain('Karşılığını göster');
  });

  it('a goal with no contributions can be deleted', () => {
    const s = seedState();
    s.contribs = s.contribs.filter((c) => c.goalId !== 'turkey');
    const html = dialog(goal(s, 'turkey'), { state: s });
    const remove = els(html, 'button')[0]!;
    expect(inner(html, 'button')).toEqual(['Delete goal', 'Cancel', 'Save']);
    expect('disabled' in remove).toBe(false);
    expect('aria-describedby' in remove).toBe(false);
    expect(text(html)).not.toContain('contribution');
  });

  it('a name already used by another goal is flagged right away', () => {
    const s = seedState();
    // Data with two goals of the same name (e.g. imported): when editing one, the warning is already there.
    goal(s, 'personal').name = 'emergency FUND';
    const html = dialog(goal(s, 'personal'), { state: s });
    expect(text(html)).toContain('Name Another goal already has this name. Currency');
    const alerts = els(html, 'div').filter((d) => d.role === 'alert');
    expect(alerts).toHaveLength(1);
    expect(els(html, 'input')[0]).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': alerts[0]!.id });
    expect(dialog(goal(s, 'turkey'), { state: s })).not.toContain('Another goal');
  });

  it('the summary with a single-month plan is in the singular, in each language', () => {
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

  it('in Spanish', () => {
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

  it('in Turkish', () => {
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
