// Savings sheet with whatever goals the user has: placement of the cards in bands, each goal's formulas,
// and everything below (income by month and contributions) moving down 8 rows per band.
// export.test.ts checks byte by byte that the three goals of the design give the original workbook.

import { describe, expect, it } from 'vitest';
import { buildFinanzasXlsx, EXCEL_EN, EXCEL_ES, EXCEL_TR } from './export';
import type { ExcelLocale } from './export';
import { BAND_HEIGHTS, BAND_ROWS, BAND_TOP, GOAL_SLOTS, WIDE_SLOT, goalPlan, placeGoals } from './export-goals';
import { readBook, xmlProblem } from './export-testkit';
import type { TestSheet } from './export-testkit';
import type { ExportData, ExportGoal } from './types';

type Contrib = ExportData['contribs'][number];

/** Goal without a plan. */
const N = (name: string): ExportGoal => ({ name, monthlyUSD: null, start: null, end: null });
/** Goal with a plan. */
const P = (name: string, monthlyUSD = 500, start = '2026-09', end = '2027-02'): ExportGoal => ({ name, monthlyUSD, start, end });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const dataWith = (goals: ExportGoal[], contribs: Contrib[] = []): ExportData => ({
  months: [
    {
      key: '2026-10',
      budget: 70000,
      incomeUSD: 5800,
      accounts: { usd: 4320, dop: 86400 },
      fixed: [],
      transfers: [{ date: '2026-10-02', via: 'Remitly', usd: 1500, rate: 58.76 }],
      tx: [],
    },
  ],
  goals,
  contribs,
  defaultRate: 58.76,
});

/** Builds the workbook (with the input frozen: it cannot modify it) and opens its savings and Config sheets. */
function open(goals: ExportGoal[], contribs: Contrib[] = [], L: ExcelLocale = EXCEL_EN) {
  const bytes = buildFinanzasXlsx(deepFreeze(dataWith(goals, contribs)), { locale: L });
  const book = readBook(bytes);
  return { bytes, book, sheet: book.sheet(L.sheets.savings), config: book.sheet('Config'), table: book.table(L.tables.contribs) };
}

/** Excel serial number of day 1 of a 'YYYY-MM' month. */
const serial = (key: string) => {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return (Date.UTC(y, m - 1, 1) - Date.UTC(1899, 11, 30)) / 86400000;
};

const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** 'B8:D8' → [col1, row1, col2, row2]. */
function rect(range: string): [number, number, number, number] {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range)!;
  return [colIndex(m[1]!), +m[2]!, colIndex(m[3] ?? m[1]!), +(m[4] ?? m[2]!)];
}

/** Cells with something (a value, a formula or only a style) in the rectangle. */
function cellsIn(sheet: TestSheet, range: string): string[] {
  const [c1, r1, c2, r2] = rect(range);
  return [...sheet.cells.keys()].filter((ref) => {
    const [c, r] = rect(ref);
    return c >= c1 && c <= c2 && r >= r1 && r <= r2;
  });
}

/** Rows a formula points to, not counting what it reads from Config. */
function rowsReferenced(formula: string): number[] {
  const own = formula.replace(/"(?:[^"]|"")*"/g, '""').replace(/Config!\$?[A-Z]+\$?\d+(:\$?[A-Z]+\$?\d+)?/g, '');
  return [...own.matchAll(/(?<![A-Za-z_\d[])\$?[A-Z]{1,2}\$?(\d+)(?![\d(])/g)].map((m) => +m[1]!);
}

/** Expected position of each goal: [name, band, slot]. */
type Placement = [name: string, band: number, slot: number];

/**
 * Checks the whole savings sheet against the expected placement: each card in its slot and with its
 * formulas, the free slots empty, and the tables, row heights, dropdowns and formats where they belong.
 */
function expectSavings(sheet: TestSheet, goals: ExportGoal[], placements: Placement[], bands: number, L: ExcelLocale = EXCEL_EN): void {
  const S = L.savings;
  const AP = L.tables.contribs;
  const goalCol = `${AP}[${L.cols.goal}]`;
  const f = (ref: string) => sheet.cells.get(ref)?.formula ?? null;
  const v = (ref: string) => sheet.cells.get(ref)?.value ?? null;
  const used = new Set<string>();

  expect(placements.map(([name]) => name)).toEqual(goals.map((g) => g.name));
  placements.forEach(([name, band, slot], i) => {
    const goal = goals[i]!;
    const o = BAND_ROWS * band;
    const [c1, c2] = GOAL_SLOTS[slot]!;
    const where = `${name} (banda ${band}, hueco ${slot})`;
    expect(used.has(`${band}/${slot}`), where).toBe(false);
    used.add(`${band}/${slot}`);
    expect(band, where).toBeLessThan(bands);
    // The card: fill and border across the whole slot, rows 6 to 12 of its band.
    expect(cellsIn(sheet, `${c1}${6 + o}:${c2}${12 + o}`), where).toHaveLength((colIndex(c2) - colIndex(c1) + 1) * 7);
    expect(v(`${c1}${6 + o}`), where).toBe(name);
    const criterion = `"${name.replace(/"/g, '""')}"`;

    if (slot !== WIDE_SLOT) {
      expect(v(`${c1}${7 + o}`), where).toBe(S.variable);
      expect(f(`${c1}${8 + o}`), where).toBe(`SUMIFS(${AP}[USD],${goalCol},${criterion})`);
      expect(f(`${c1}${9 + o}`), where).toBe(`${c1}${8 + o}*$R$3`);
      expect(f(`${c1}${11 + o}`), where).toContain(`COUNTIFS(${goalCol},${criterion})`);
      for (const row of [8, 9, 11]) expect(sheet.merges, where).toContain(`${c1}${row + o}:${c2}${row + o}`);
      return;
    }

    // Goal with a plan: its three values on the card's last row and its calculations in R, two rows higher up.
    const r = 12 + o;
    const [target, saved, left, need, pct] = [4, 5, 6, 7, 8].map((n) => n + o) as [number, number, number, number, number];
    expect([v(`I${r}`), v(`K${r}`), v(`M${r}`)], where).toEqual([S.monthly, S.start, S.end]);
    expect([v(`J${r}`), v(`L${r}`), v(`N${r}`)], where).toEqual([goal.monthlyUSD, serial(goal.start!), serial(goal.end!)]);
    expect(f(`R${target}`), where).toBe(`J${r}*((YEAR(N${r})-YEAR(L${r}))*12+MONTH(N${r})-MONTH(L${r})+1)`);
    expect(f(`R${saved}`), where).toBe(`SUMIFS(${AP}[USD],${goalCol},${criterion})`);
    expect(f(`R${left}`), where).toBe(
      `MAX(1,(YEAR(N${r})-YEAR(TODAY()))*12+MONTH(N${r})-MONTH(TODAY())+1-IF(COUNTIFS(${goalCol},${criterion},${AP}[${L.cols.month}],Config!$C$5)>0,1,0))`,
    );
    expect(f(`R${need}`), where).toBe(`MAX(0,R${target}-R${saved})/R${left}`);
    expect(f(`R${pct}`), where).toBe(`IF(R${target}=0,0,R${saved}/R${target})`);
    expect(f(`I${8 + o}`), where).toBe(`$R$${saved}`);
    expect(f(`L${8 + o}`), where).toBe(`$R$${saved}*$R$3`);
    expect(f(`I${10 + o}`), where).toBe(`$R$${pct}`);
    expect(f(`L${6 + o}`), where).toContain(`FIXED(J${r},0)`);
    expect(f(`I${7 + o}`), where).toContain(`$R$${left}`);
    expect(f(`I${7 + o}`), where).toContain(`FIXED($R$${need},0)`);
    expect(f(`I${11 + o}`), where).toContain(`FIXED(100*$R$${pct},0)`);
    expect(f(`I${11 + o}`), where).toContain(`FIXED($R$${target},0)`);
    expect(f(`L${11 + o}`), where).toContain(`${S.monthCase}(CHOOSE(MONTH(N${r}),`);
    expect(f(`L${11 + o}`), where).toContain(`YEAR(N${r})`);
    expect(sheet.conditional.map((c) => c.sqref), where).toContain(`I${10 + o}:O${10 + o}`);
    for (const m of [`L${6 + o}:O${6 + o}`, `I${7 + o}:O${7 + o}`, `I${8 + o}:K${8 + o}`, `L${8 + o}:O${8 + o}`, `I${10 + o}:O${10 + o}`, `I${11 + o}:K${11 + o}`, `L${11 + o}:O${11 + o}`, `N${r}:O${r}`]) {
      expect(sheet.merges, where).toContain(m);
    }

    // Every formula of the card and of its calculations reads only from its own band: its data row, its five
    // R cells and the shared rate (R3). None points to another goal's card.
    const allowed = new Set([3, r, target, saved, left, need, pct]);
    const own = [...cellsIn(sheet, `I${6 + o}:O${12 + o}`), ...[target, saved, left, need, pct].map((n) => `R${n}`)];
    let formulas = 0;
    for (const ref of own) {
      const formula = f(ref);
      if (formula === null) continue;
      formulas++;
      for (const row of rowsReferenced(formula)) expect(allowed.has(row), `${where}: ${ref} = ${formula}`).toBe(true);
    }
    // Seven formulas in the card and five in column R.
    expect(formulas, where).toBe(12);
  });

  // Free slots: no card and no formulas.
  for (let band = 0; band < bands; band++) {
    const o = BAND_ROWS * band;
    GOAL_SLOTS.forEach(([c1, c2], slot) => {
      if (!used.has(`${band}/${slot}`)) expect(cellsIn(sheet, `${c1}${6 + o}:${c2}${12 + o}`), `banda ${band}, hueco ${slot}`).toEqual([]);
    });
    if (!used.has(`${band}/${WIDE_SLOT}`)) expect(cellsIn(sheet, `R${4 + o}:R${8 + o}`), `banda ${band}`).toEqual([]);
    // There is nothing between the slots or at the sides.
    expect(cellsIn(sheet, `A${6 + o}:A${13 + o}`)).toEqual([]);
    expect(cellsIn(sheet, `H${6 + o}:H${13 + o}`)).toEqual([]);
    expect(cellsIn(sheet, `B${13 + o}:Q${13 + o}`)).toEqual([]);
    // Row heights of the band: those of rows 6 to 13 of the design.
    expect(BAND_HEIGHTS.map((_, i) => sheet.rowHeights.get(BAND_TOP + o + i))).toEqual([...BAND_HEIGHTS]);
  }

  // Everything below moves down 8 rows per extra band.
  const shift = BAND_ROWS * (bands - 1);
  const top = 14 + shift;
  const head = top + 1;
  expect(v(`B${top}`)).toBe(S.incomeTitle);
  expect(v(`I${top}`)).toBe(S.contribsTitle);
  expect(f(`L${top}`)).toContain(`SUM(${AP}[USD])`);
  expect(sheet.merges).toContain(`L${top}:O${top}`);
  expect(sheet.rowHeights.get(top)).toBe(26);
  expect(['B', 'C', 'D', 'E', 'F', 'G'].map((col) => v(`${col}${head}`))).toEqual([...S.incomeCols]);
  expect(['I', 'J', 'K', 'L', 'M', 'N', 'O'].map((col) => v(`${col}${head}`))).toEqual([
    L.cols.date,
    L.cols.month,
    L.cols.goal,
    L.cols.amount,
    L.cols.currency,
    'USD',
    'DOP',
  ]);
  // Income: 15 rows from the first month; each one reads its month's sheet and that month's contributions.
  expect(v(`B${head + 1}`)).toBe(`${L.months[9]} 2026`);
  expect(f(`C${head + 1}`)).toBe(`IFERROR(INDIRECT("'"&B${head + 1}&"'!C10"),"")`);
  expect(f(`F${head + 15}`)).toBe(`IF(C${head + 15}="","",SUMIFS(${AP}[USD],${AP}[${L.cols.month}],B${head + 15}))`);
  expect(v(`B${head + 16}`)).toBeNull();
  expect(sheet.rowHeights.get(head + 16)).toBe(6);
  expect(cellsIn(sheet, `B${top}:G${head + 16}`)).toHaveLength(6 * 18);
  expect(cellsIn(sheet, `A${head + 17}:G${head + 400}`)).toEqual([]);

  // Conditional formats: the summary's and one bar per goal with a plan, each with its own priority.
  const planned = placements.filter(([, , slot]) => slot === WIDE_SLOT);
  expect(sheet.conditional.map((c) => c.sqref)).toEqual(['K4', ...planned.map(([, band]) => `I${10 + BAND_ROWS * band}:O${10 + BAND_ROWS * band}`)]);
  const priorities = sheet.conditional.flatMap((c) => c.priorities);
  expect(priorities).toEqual(planned.length ? [1, ...planned.map((_, i) => 2 + i)] : [1]);

  // Dropdowns of the contributions table: the goals one points to the Config list, which has one row per goal.
  const last = 2000 + shift;
  const lists = sheet.validations;
  if (goals.length) {
    expect(lists).toEqual([
      { sqref: `K${head + 1}:K${last}`, formula: `Config!$G$4:$G$${3 + goals.length}` },
      { sqref: `M${head + 1}:M${last}`, formula: '"USD,DOP"' },
    ]);
  } else {
    expect(lists).toEqual([{ sqref: `M${head + 1}:M${last}`, formula: '"USD,DOP"' }]);
  }

  // Merged cells: none repeated or overlapping another.
  expect(new Set(sheet.merges).size).toBe(sheet.merges.length);
  const rects = sheet.merges.map(rect);
  rects.forEach((a, i) =>
    rects.slice(i + 1).forEach((b, j) => {
      const apart = a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];
      expect(apart, `${sheet.merges[i]} y ${sheet.merges[i + 1 + j]}`).toBe(true);
    }),
  );
  expect(xmlProblem(sheet.xml)).toBeNull();
}

// ── Placement ────────────────────────────────────────────────────────────────

describe('placeGoals: placing the goals in bands', () => {
  const where = (goals: ExportGoal[]) => placeGoals(goals).goals.map((g) => [g.name, g.band, g.slot]);

  it('the constants describe the card strip of the design', () => {
    expect(BAND_TOP).toBe(6);
    expect(BAND_ROWS).toBe(8);
    expect(BAND_HEIGHTS).toEqual([24, 16, 28, 16, 14, 20, 24, 10]);
    expect(BAND_HEIGHTS).toHaveLength(BAND_ROWS);
    expect(GOAL_SLOTS).toEqual([
      ['B', 'D'],
      ['E', 'G'],
      ['I', 'O'],
    ]);
    expect(WIDE_SLOT).toBe(2);
  });

  it('with no goals one empty band remains', () => {
    expect(placeGoals([])).toEqual({ bands: 1, goals: [] });
  });

  it('the three goals of the design fill band 0', () => {
    expect(placeGoals([N('a'), N('b'), P('c')])).toEqual({
      bands: 1,
      goals: [
        { name: 'a', band: 0, slot: 0, plan: null },
        { name: 'b', band: 0, slot: 1, plan: null },
        { name: 'c', band: 0, slot: 2, plan: { monthlyUSD: 500, start: '2026-09', end: '2027-02' } },
      ],
    });
  });

  it('the order within the band does not change the slots', () => {
    expect(where([P('c'), N('a'), N('b')])).toEqual([['c', 0, 2], ['a', 0, 0], ['b', 0, 1]]);
    expect(where([N('a'), P('c'), N('b')])).toEqual([['a', 0, 0], ['c', 0, 2], ['b', 0, 1]]);
  });

  it('one of each kind', () => {
    expect(where([N('a'), P('b')])).toEqual([['a', 0, 0], ['b', 0, 2]]);
    expect(placeGoals([P('b'), N('a')]).bands).toBe(1);
  });

  it('five without a plan: two per band', () => {
    expect(where(['a', 'b', 'c', 'd', 'e'].map(N))).toEqual([['a', 0, 0], ['b', 0, 1], ['c', 1, 0], ['d', 1, 1], ['e', 2, 0]]);
    expect(placeGoals(['a', 'b', 'c', 'd', 'e'].map(N)).bands).toBe(3);
  });

  it('three with a plan: one per band', () => {
    expect(where(['a', 'b', 'c'].map((n) => P(n)))).toEqual([['a', 0, 2], ['b', 1, 2], ['c', 2, 2]]);
    expect(placeGoals(['a', 'b', 'c'].map((n) => P(n))).bands).toBe(3);
  });

  it('mixed list of eight', () => {
    const goals = [P('a'), N('b'), N('c'), N('d'), P('e'), P('f'), N('g'), N('h')];
    expect(where(goals)).toEqual([['a', 0, 2], ['b', 0, 0], ['c', 0, 1], ['d', 1, 0], ['e', 1, 2], ['f', 2, 2], ['g', 2, 0], ['h', 2, 1]]);
    expect(placeGoals(goals).bands).toBe(3);
  });

  it('does not go back to an earlier band even if it still has a free slot', () => {
    expect(where([N('a'), P('b'), P('c'), N('d')])).toEqual([['a', 0, 0], ['b', 0, 2], ['c', 1, 2], ['d', 1, 0]]);
  });

  it('an incomplete or inconsistent plan counts as no plan', () => {
    const base = P('x', 3000, '2026-08', '2027-10');
    expect(goalPlan(base)).toEqual({ monthlyUSD: 3000, start: '2026-08', end: '2027-10' });
    expect(goalPlan({ ...base, start: '2026-08', end: '2026-08' })).not.toBeNull();
    const broken: Partial<ExportGoal>[] = [
      { monthlyUSD: null },
      { monthlyUSD: 0 },
      { monthlyUSD: -100 },
      { monthlyUSD: NaN },
      { start: null },
      { end: null },
      { start: null, end: null },
      { monthlyUSD: null, start: null, end: null },
      { start: '2027-11' },
      { end: '2026-07' },
      { start: '2026-13' },
      { end: '2027-00' },
      { start: '2026-8' },
      { start: '' },
      { end: 'octubre' },
    ];
    for (const over of broken) {
      expect(goalPlan({ ...base, ...over }), JSON.stringify(over)).toBeNull();
      expect(where([{ ...base, ...over }]), JSON.stringify(over)).toEqual([['x', 0, 0]]);
    }
    // As in the rest of the generator, a number that arrives as text is accepted.
    expect(goalPlan({ ...base, monthlyUSD: '3000' as unknown as number })?.monthlyUSD).toBe(3000);
    expect(goalPlan({ ...base, monthlyUSD: '' as unknown as number })).toBeNull();
    expect(goalPlan({ name: 'x' } as ExportGoal)).toBeNull();
  });

  it('does not modify the list', () => {
    const goals = deepFreeze([N('a'), P('b')]);
    placeGoals(goals);
    expect(goals).toEqual([N('a'), P('b')]);
  });
});

// ── The sheet ────────────────────────────────────────────────────────────────

describe('savings sheet: goal cards', () => {
  it('no goals: one empty band and the tables in their usual place', () => {
    const { sheet, config, table } = open([]);
    expectSavings(sheet, [], [], 1);
    expect(table.ref).toBe('I15:O25');
    expect(config.cells.get('G3')?.value).toBe(EXCEL_EN.config.goals);
    expect(config.cells.get('G4')?.value ?? null).toBeNull();
    // Only the titles of the hidden calculations column remain.
    expect([...sheet.cells.keys()].filter((ref) => ref.startsWith('R'))).toEqual(['R2', 'R3']);
  });

  it('the three goals of the design: one band, like the original', () => {
    const goals = [N('Emergency fund'), N('Personal savings'), P('Trip to Turkey', 3000, '2026-08', '2027-10')];
    const { sheet, table } = open(goals);
    expectSavings(sheet, goals, [['Emergency fund', 0, 0], ['Personal savings', 0, 1], ['Trip to Turkey', 0, 2]], 1);
    expect(table.ref).toBe('I15:O25');
    expect(sheet.cells.get('J12')?.value).toBe(3000);
    expect(sheet.cells.get('R4')?.formula).toBe('J12*((YEAR(N12)-YEAR(L12))*12+MONTH(N12)-MONTH(L12)+1)');
  });

  it('the same placement gives the same sheet: [with plan, without, without] and [without, without, with plan]', () => {
    const [a, b, c] = [N('a'), N('b'), P('c')];
    const first = open([a, b, c]);
    const second = open([c, a, b]);
    expect([...second.sheet.cells].sort()).toEqual([...first.sheet.cells].sort());
    expect(second.sheet.rowHeights).toEqual(first.sheet.rowHeights);
    // What changes is the order of the Config list, which is the order of the goals.
    expect(['G4', 'G5', 'G6'].map((ref) => first.config.cells.get(ref)?.value)).toEqual(['a', 'b', 'c']);
    expect(['G4', 'G5', 'G6'].map((ref) => second.config.cells.get(ref)?.value)).toEqual(['c', 'a', 'b']);
  });

  it('one of each kind', () => {
    const goals = [N('Rainy day'), P('Laptop', 200, '2026-10', '2027-03')];
    const { sheet } = open(goals);
    expectSavings(sheet, goals, [['Rainy day', 0, 0], ['Laptop', 0, 2]], 1);
  });

  it('only one with a plan', () => {
    const goals = [P('Laptop', 200, '2026-10', '2026-10')];
    const { sheet } = open(goals);
    expectSavings(sheet, goals, [['Laptop', 0, 2]], 1);
    expect(sheet.cells.get('L12')?.value).toBe(sheet.cells.get('N12')?.value);
  });

  it('five without a plan: three bands', () => {
    const goals = ['One', 'Two', 'Three', 'Four', 'Five'].map(N);
    const { sheet, table } = open(goals);
    expectSavings(sheet, goals, [['One', 0, 0], ['Two', 0, 1], ['Three', 1, 0], ['Four', 1, 1], ['Five', 2, 0]], 3);
    expect(table.ref).toBe('I31:O41');
  });

  it('three with a plan: three bands, each with its own cells and calculations', () => {
    const goals = [P('Trip', 3000, '2026-08', '2027-10'), P('Car', 450.5, '2026-01', '2028-12'), P('House', 1000, '2027-01', '2031-12')];
    const { sheet } = open(goals);
    expectSavings(sheet, goals, [['Trip', 0, 2], ['Car', 1, 2], ['House', 2, 2]], 3);
    expect(['J12', 'J20', 'J28'].map((ref) => sheet.cells.get(ref)?.value)).toEqual([3000, 450.5, 1000]);
    expect(['R4', 'R12', 'R20'].map((ref) => sheet.cells.get(ref)?.formula)).toEqual([
      'J12*((YEAR(N12)-YEAR(L12))*12+MONTH(N12)-MONTH(L12)+1)',
      'J20*((YEAR(N20)-YEAR(L20))*12+MONTH(N20)-MONTH(L20)+1)',
      'J28*((YEAR(N28)-YEAR(L28))*12+MONTH(N28)-MONTH(L28)+1)',
    ]);
    expect(['R5', 'R13', 'R21'].map((ref) => sheet.cells.get(ref)?.formula)).toEqual([
      'SUMIFS(Contributions[USD],Contributions[Goal],"Trip")',
      'SUMIFS(Contributions[USD],Contributions[Goal],"Car")',
      'SUMIFS(Contributions[USD],Contributions[Goal],"House")',
    ]);
    expect(['I8', 'I16', 'I24'].map((ref) => sheet.cells.get(ref)?.formula)).toEqual(['$R$5', '$R$13', '$R$21']);
    // Column R stays hidden and the rate (R3) is a single one for all of them.
    expect(sheet.xml).toContain('<col min="18" max="18" width="14" style="1" customWidth="1" hidden="1"/>');
    expect([...sheet.cells.keys()].filter((ref) => ref.startsWith('R')).sort()).toEqual(
      ['R2', 'R3', ...[4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 20, 21, 22, 23, 24].map((n) => `R${n}`)].sort(),
    );
  });

  it('mixed list of eight', () => {
    const goals = [P('A', 100), N('B'), N('C'), N('D'), P('E', 200), P('F', 300), N('G'), N('H')];
    const { sheet, config, table } = open(goals);
    expectSavings(sheet, goals, [['A', 0, 2], ['B', 0, 0], ['C', 0, 1], ['D', 1, 0], ['E', 1, 2], ['F', 2, 2], ['G', 2, 0], ['H', 2, 1]], 3);
    expect(table.ref).toBe('I31:O41');
    expect([4, 5, 6, 7, 8, 9, 10, 11, 12].map((r) => config.cells.get(`G${r}`)?.value ?? null)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', null]);
  });

  it('a goal with a half-finished plan goes in as a goal with variable contributions', () => {
    const goals = [P('Sin fechas', 3000, '2026-08', '2027-10'), { ...P('Half'), start: null }, { ...P('Zero'), monthlyUSD: 0 }, { ...P('Backwards'), start: '2028-01' }];
    const { sheet } = open(goals);
    expectSavings(sheet, goals, [['Sin fechas', 0, 2], ['Half', 0, 0], ['Zero', 0, 1], ['Backwards', 1, 0]], 2);
  });

  it.each([1, 2, 3, 4, 6])('with %i bands the tables start 8 rows lower per extra band', (bands) => {
    const goals = Array.from({ length: bands }, (_, i) => P(`Goal ${i + 1}`, 100 * (i + 1)));
    const contribs: Contrib[] = [
      { date: '2026-10-03', goalName: 'Goal 1', amount: 100, cur: 'USD' },
      { date: '2026-09-03', goalName: 'Goal 1', amount: 5876, cur: 'DOP' },
    ];
    const { sheet, table, book } = open(goals, contribs);
    expectSavings(sheet, goals, goals.map((g, i) => [g.name, i, WIDE_SLOT]), bands);
    const head = 15 + 8 * (bands - 1);
    // Contributions table: header, two contributions (sorted by date) and ten blank rows.
    expect(table.ref).toBe(`I${head}:O${head + 12}`);
    expect(sheet.cells.get(`K${head + 1}`)?.value).toBe('Goal 1');
    expect(sheet.cells.get(`L${head + 1}`)?.value).toBe(5876);
    expect(sheet.cells.get(`M${head + 2}`)?.value).toBe('USD');
    expect(sheet.cells.get(`N${head + 1}`)?.formula).toBe(table.formulas.get('USD'));
    // The fill of the contributions card reaches the table's last row and no further.
    expect(sheet.cells.has(`I${head + 12}`)).toBe(true);
    expect(sheet.cells.has(`I${head + 13}`)).toBe(false);
    // The month sheets do not change with the number of goals.
    expect(book.sheet('October 2026').xml).toBe(open([]).book.sheet('October 2026').xml);
  });
});

describe('savings sheet: goal names with quotes, & and wildcards', () => {
  const names = ['Car "Tesla" & co', 'R&D <lab> >= 5', "Eda's 100%", 'What?', '5* hotel ~ maybe', '=SUM(A1)', '>1000', '<3', 'Ünïcödé 日本 😀'];

  it('the name is shown as is and goes into the formulas as an exact literal', () => {
    const goals = names.map((name, i) => (i % 3 === 2 ? P(name) : N(name)));
    const { sheet, config, book } = open(goals);
    const layout = placeGoals(goals);
    expect(layout.bands).toBe(3);
    for (const [path, xml] of book.parts) expect(xmlProblem(xml), path).toBeNull();

    // On the card and in the Config list, the name untouched.
    for (const g of layout.goals) {
      expect(sheet.cells.get(`${GOAL_SLOTS[g.slot]![0]}${6 + 8 * g.band}`)?.value).toBe(g.name);
    }
    expect(names.map((_, i) => config.cells.get(`G${4 + i}`)?.value)).toEqual(names);
    expect(sheet.validations[0]).toEqual({ sqref: 'K32:K2016', formula: 'Config!$G$4:$G$12' });

    // In SUMIFS/COUNTIFS: doubled quotes, wildcards escaped with ~ and "=" in front of a leading operator.
    const criteria = [
      '"Car ""Tesla"" & co"',
      '"R&D <lab> >= 5"',
      '"Eda\'s 100%"',
      '"What~?"',
      '"5~* hotel ~~ maybe"',
      '"==SUM(A1)"',
      '"=>1000"',
      '"=<3"',
      '"Ünïcödé 日本 😀"',
    ];
    layout.goals.forEach((g, i) => {
      const o = 8 * g.band;
      const total = g.plan ? sheet.cells.get(`R${5 + o}`)?.formula : sheet.cells.get(`${GOAL_SLOTS[g.slot]![0]}${8 + o}`)?.formula;
      expect(total, g.name).toBe(`SUMIFS(Contributions[USD],Contributions[Goal],${criteria[i]})`);
      const count = g.plan ? sheet.cells.get(`R${6 + o}`)?.formula : sheet.cells.get(`${GOAL_SLOTS[g.slot]![0]}${11 + o}`)?.formula;
      expect(count, g.name).toContain(`COUNTIFS(Contributions[Goal],${criteria[i]}`);
    });

    // In the XML, & < > are escaped inside the formula.
    expect(sheet.xml).toContain('<f>SUMIFS(Contributions[USD],Contributions[Goal],"Car ""Tesla"" &amp; co")</f>');
    expect(sheet.xml).toContain('<f>SUMIFS(Contributions[USD],Contributions[Goal],"R&amp;D &lt;lab&gt; &gt;= 5")</f>');
    expect(sheet.xml).not.toContain('"Tesla" & co');
  });

  it('an empty or repeated name does not break the sheet', () => {
    const goals = [N(''), N('Same'), N('Same'), P('')];
    const { sheet, book } = open(goals);
    for (const [path, xml] of book.parts) expect(xmlProblem(xml), path).toBeNull();
    expect(placeGoals(goals).bands).toBe(2);
    expect(sheet.cells.get('B6')?.value ?? null).toBeNull();
    expect(sheet.cells.get('E6')?.value).toBe('Same');
    expect(sheet.cells.get('B14')?.value).toBe('Same');
    expect(sheet.validations[0]?.formula).toBe('Config!$G$4:$G$7');
  });
});

describe('Config sheet: goal list', () => {
  const card = (config: TestSheet) => Math.max(...cellsIn(config, 'E3:G200').map((ref) => rect(ref)[1]));

  it.each([0, 1, 3, 10])('with %i goals the lists card reaches row 14', (n) => {
    const goals = Array.from({ length: n }, (_, i) => N(`Goal ${i + 1}`));
    const { config, sheet } = open(goals);
    expect(card(config)).toBe(14);
    expect(goals.map((_, i) => config.cells.get(`G${4 + i}`)?.value)).toEqual(goals.map((g) => g.name));
    expect(config.cells.get(`G${4 + n}`)?.value ?? null).toBeNull();
    const list = sheet.validations.find((v) => v.sqref.startsWith('K'));
    expect(list?.formula).toBe(n ? `Config!$G$4:$G$${3 + n}` : undefined);
  });

  it.each([11, 12, 25])('with %i goals the card grows so they fit', (n) => {
    const goals = Array.from({ length: n }, (_, i) => (i % 4 === 3 ? P(`Goal ${i + 1}`) : N(`Goal ${i + 1}`)));
    const { config, sheet } = open(goals);
    expect(card(config)).toBe(4 + n);
    expect(goals.map((_, i) => config.cells.get(`G${4 + i}`)?.value)).toEqual(goals.map((g) => g.name));
    // The other two lists stay the same, and the card's three columns reach the same edge.
    expect(config.cells.get('E13')?.value).toBe('Travel');
    expect(config.cells.get('E14')?.value ?? null).toBeNull();
    expect(cellsIn(config, `E${4 + n}:G${4 + n}`)).toHaveLength(3);
    expect(cellsIn(config, `E${5 + n}:G${5 + n}`)).toEqual([]);
    expect(sheet.validations.find((v) => v.sqref.startsWith('K'))?.formula).toBe(`Config!$G$4:$G$${3 + n}`);
    expect(xmlProblem(config.xml)).toBeNull();
  });
});

describe('savings sheet: languages and side effects', () => {
  const goals = [N('Fondo'), P('Viaje', 3000, '2026-08', '2027-10'), P('Carro', 400, '2026-10', '2027-09'), N('Regalos'), N('Otros')];
  const placements: Placement[] = [['Fondo', 0, 0], ['Viaje', 0, 2], ['Carro', 1, 2], ['Regalos', 1, 0], ['Otros', 1, 1]];

  it.each([
    ['es', EXCEL_ES],
    ['en', EXCEL_EN],
    ['tr', EXCEL_TR],
  ] as [string, ExcelLocale][])('several bands in %s: same cells, tables and columns with the names of that language', (_lang, L) => {
    const { sheet, table } = open(goals, [], L);
    expectSavings(sheet, goals, placements, 2, L);
    expect(table.ref).toBe('I23:O33');
    expect(sheet.cells.get('R13')?.formula).toBe(`SUMIFS(${L.tables.contribs}[USD],${L.tables.contribs}[${L.cols.goal}],"Carro")`);
  });

  it('in Spanish the formulas are those of the design, with different rows', () => {
    const { sheet } = open(goals, [], EXCEL_ES);
    expect(sheet.cells.get('L14')?.formula).toBe('FIXED(J20,0)&" USD / mes"');
    expect(sheet.cells.get('I15')?.formula).toBe('"Faltan "&$R$14&" aportes · "&FIXED($R$15,0)&" USD por mes para llegar"');
    expect(sheet.cells.get('I19')?.formula).toBe('FIXED(100*$R$16,0)&"% de "&FIXED($R$12,0)&" USD"');
    expect(sheet.cells.get('L19')?.formula).toBe(
      '"Meta: "&LOWER(CHOOSE(MONTH(N20),"Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"))&" "&YEAR(N20)',
    );
    expect(sheet.cells.get('B19')?.formula).toBe('COUNTIFS(Aportes[Meta],"Regalos")&" aportes registrados"');
    expect(sheet.cells.get('L22')?.formula).toBe('"Total "&FIXED(SUM(Aportes[USD]),2)&" USD"');
  });

  it('two calls in a row return the same bytes', () => {
    const data = dataWith(goals, [{ date: '2026-10-03', goalName: 'Viaje', amount: 3000, cur: 'USD' }]);
    for (const locale of [EXCEL_EN, EXCEL_ES, EXCEL_TR]) {
      const first = buildFinanzasXlsx(data, { locale });
      const second = buildFinanzasXlsx(data, { locale });
      expect(second).not.toBe(first);
      expect(Buffer.compare(second, first)).toBe(0);
    }
    // And a workbook with other goals in between leaves nothing behind.
    const before = buildFinanzasXlsx(data);
    buildFinanzasXlsx(dataWith([P('X'), P('Y'), P('Z')]));
    buildFinanzasXlsx(dataWith([]));
    expect(Buffer.compare(buildFinanzasXlsx(data), before)).toBe(0);
  });

  it('does not modify the input data', () => {
    const data = dataWith(goals, [
      { date: '2026-10-03', goalName: 'Viaje', amount: 3000, cur: 'USD' },
      { date: '2026-09-03', goalName: 'Fondo', amount: 100, cur: 'USD' },
    ]);
    const before = structuredClone(data);
    for (const locale of [EXCEL_EN, EXCEL_ES, EXCEL_TR]) buildFinanzasXlsx(deepFreeze(data), { locale });
    expect(data).toEqual(before);
  });

  it('without the goal list (old data) it is treated as having no goals', () => {
    const { goals: _goals, ...rest } = dataWith([]);
    const loose = rest as ExportData;
    expect(Buffer.compare(buildFinanzasXlsx(loose), buildFinanzasXlsx(dataWith([])))).toBe(0);
  });
});
