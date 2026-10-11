// "Golden" tests for the port: for the same data, buildFinanzasXlsx has to return exactly the same bytes
// as the prototype's original exporter (tests/reference-export.ts runs it in a vm).
// reference.test.ts anchors that exporter to the workbooks in design_handoff/referencia/.
//
// The original only knows how to make the workbook in Spanish with the design's three goals, so everything here
// uses EXCEL_ES, data in Spanish (the frozen input tests/export-data-es.json) and those goals (referenceGoals).
// The data does not come from the app's state: the generator only knows about ExportData. What the original cannot
// represent is tested separately: the other languages in export-locale.test.ts, other goal lists in
// export-goals.test.ts and the recalculation in a real spreadsheet in export-libreoffice.test.ts.

import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWithReference, frozenExportData, referenceGoals } from '../../tests/reference-export';
import type { Currency } from '../types';
import { EXCEL_ES, XLSX_MIME, buildFinanzasXlsx, xlsxFilename } from './export';
import type { BuildOptions } from './export';
import type { ExportData, ExportMonth } from './types';

type Fixed = ExportMonth['fixed'][number];
type Transfer = ExportMonth['transfers'][number];
type Tx = ExportMonth['tx'][number];
type Contrib = ExportData['contribs'][number];

const refFile = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../design_handoff/referencia/${name}`, import.meta.url)));

const V3 = 'Finanzas Personales v3.xlsx';
const PLANTILLA = 'Plantilla vacia.xlsx';

// ── Comparison ───────────────────────────────────────────────────────────────

/** Slice of `s` around `i`, to see the difference in context. */
const around = (s: string, i: number) => JSON.stringify(s.slice(Math.max(0, i - 80), i + 120));

/** First difference between two workbooks, zip part by zip part; null if they are identical byte for byte. */
function firstDiff(actual: Uint8Array, expected: Uint8Array): string | null {
  if (Buffer.compare(actual, expected) === 0) return null;
  let a: Record<string, Uint8Array>;
  let e: Record<string, Uint8Array>;
  try {
    a = unzipSync(actual);
    e = unzipSync(expected);
  } catch (err) {
    return `zip ilegible: ${String(err)}`;
  }
  const namesA = Object.keys(a);
  const namesE = Object.keys(e);
  for (const name of namesE) {
    const pa = a[name];
    if (!pa) return `falta la parte ${name}`;
    const sa = strFromU8(pa);
    const se = strFromU8(e[name]!);
    if (sa === se) continue;
    let i = 0;
    while (i < sa.length && i < se.length && sa[i] === se[i]) i++;
    return `${name} difiere en el carácter ${i}:\n  esperado: ${around(se, i)}\n  obtenido: ${around(sa, i)}`;
  }
  const extra = namesA.find((n) => !(n in e));
  if (extra) return `sobra la parte ${extra}`;
  if (namesA.join('\n') !== namesE.join('\n')) {
    return `orden de las partes:\n  esperado: ${namesE.join(', ')}\n  obtenido: ${namesA.join(', ')}`;
  }
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  return `mismas partes, pero el zip difiere en el byte ${i} (${actual.length} bytes; se esperaban ${expected.length})`;
}

function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  const diff = firstDiff(actual, expected);
  expect(diff, diff ?? undefined).toBeNull();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** The port with the Spanish strings, which is all the reference exporter knows how to generate. */
const buildEs = (data: ExportData, opts: Omit<BuildOptions, 'locale'> = {}) =>
  buildFinanzasXlsx(data, { ...opts, locale: EXCEL_ES });

/**
 * Compares the port (in Spanish) with the reference exporter for `data` and returns the bytes.
 * The port gets a frozen copy: if it tried to modify the input, the test fails.
 */
async function expectGolden(data: ExportData, opts: { currentKey?: string; now?: Date } = {}): Promise<Uint8Array> {
  const expected = await buildWithReference(data, { now: opts.now });
  const actual = buildEs(deepFreeze(structuredClone(data)), { currentKey: opts.currentKey });
  expectSameBytes(actual, expected);
  return actual;
}

// ── Data ─────────────────────────────────────────────────────────────────────

const month = (key: string, over: Partial<ExportMonth> = {}): ExportMonth => ({
  key,
  budget: 70000,
  incomeUSD: 5800,
  accounts: { usd: 4320, dop: 86400 },
  fixed: [],
  transfers: [],
  tx: [],
  ...over,
});

const emptyMonth = (key: string): ExportMonth =>
  month(key, { budget: null, incomeUSD: null, accounts: {} });

const book = (months: ExportMonth[], over: Partial<ExportData> = {}): ExportData => ({
  months,
  goals: referenceGoals(),
  contribs: [],
  defaultRate: 58.76,
  ...over,
});

/** Workbook with no months: the generator makes the empty template for the current month. */
const empty = (): ExportData => book([]);

const fx = (name: string, over: Partial<Fixed> = {}): Fixed => ({ name, day: '', amount: 1000, cur: 'DOP', paid: false, ...over });

const tr = (date: string, over: Partial<Transfer> = {}): Transfer => ({ date, via: 'Remitly', usd: 1500, rate: 58.76, ...over });

const tx = (date: string, over: Partial<Tx> = {}): Tx => ({
  date,
  desc: 'Compra semanal',
  place: 'Supermercado Nacional',
  cat: 'Supermercado',
  method: 'Tarjeta',
  amount: 4850,
  cur: 'DOP',
  notes: '',
  ...over,
});

const contrib = (date: string, goalName: string, amount: number, cur: Currency = 'USD'): Contrib => ({ date, goalName, amount, cur });

/**
 * Data shaped the way it would be in the prototype, where the inputs store text ('' or '1500')
 * and fields are missing: the types are bypassed on purpose to test that the port treats them the same.
 */
const loose = (data: unknown) => data as ExportData;

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const day = (key: string, n: number) => `${key}-${String(n).padStart(2, '0')}`;

/** `n` consecutive months starting at `start`. */
function keysFrom(start: string, n: number): string[] {
  const [y, m] = start.split('-').map(Number) as [number, number];
  return range(n).map((i) => {
    const t = y * 12 + (m - 1) + i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

/** The design's sample data, in Spanish: the data in the workbook Finanzas Personales v3.xlsx. */
const seedData = () => frozenExportData('es');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workbook comparison', () => {
  it('detects a difference and says which part it is in', () => {
    const data = seedData();
    const out = buildEs(data);
    expect(firstDiff(out, out.slice())).toBeNull();
    // The template has fewer sheets: the first part that differs is the list of parts.
    expect(firstDiff(out, refFile(PLANTILLA))).toMatch(/^\[Content_Types\]\.xml difiere en el carácter \d+/);

    // A single different character in a note is enough.
    data.months[0]!.tx[0]!.notes = 'x';
    expect(firstDiff(buildEs(data), out)).toMatch(/^xl\/worksheets\/sheet1\.xml difiere/);
    data.months[0]!.tx[0]!.notes = '';
    data.defaultRate = 58.77;
    expect(firstDiff(buildEs(data), out)).toMatch(/^xl\/worksheets\/sheet5\.xml difiere/);
    // Language is part of the output: the same workbook in English (the default language) is no longer the reference.
    data.defaultRate = 58.76;
    expect(firstDiff(buildEs(data), out)).toBeNull();
    expect(firstDiff(buildFinanzasXlsx(data), out)).toMatch(/^xl\/worksheets\/sheet1\.xml difiere/);
  });
});

describe('buildFinanzasXlsx · reference workbooks', () => {
  it('sample data → Finanzas Personales v3.xlsx', async () => {
    const out = await expectGolden(seedData());
    expectSameBytes(out, refFile(V3));
  });

  it('no months → Plantilla vacia.xlsx (currentKey 2026-10)', async () => {
    const out = await expectGolden(empty(), { currentKey: '2026-10', now: new Date(2026, 9, 7) });
    expectSameBytes(out, refFile(PLANTILLA));
  });

  it('no months: the template is the one for the given month', async () => {
    await expectGolden(empty(), { currentKey: '2027-01', now: new Date(2027, 0, 15) });
    await expectGolden(empty(), { currentKey: '2025-12', now: new Date(2025, 11, 31) });
  });

  it('a single empty month is equivalent to the empty template for that month', async () => {
    const out = await expectGolden(book([emptyMonth('2026-10')]));
    expectSameBytes(out, refFile(PLANTILLA));
  });
});

describe('buildFinanzasXlsx · current month by default', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("without currentKey it uses the current month in the user's time zone, not in UTC", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // November 1 at 02:30 UTC: in Santo Domingo (UTC-4) it is still October 31.
    vi.setSystemTime(new Date('2026-11-01T02:30:00Z'));
    const data = empty();
    expectSameBytes(buildEs(data), refFile(PLANTILLA));
    expectSameBytes(buildEs(data, {}), buildEs(data, { currentKey: '2026-10' }));
    // The same without specifying a language (English).
    expectSameBytes(buildFinanzasXlsx(data), buildFinanzasXlsx(data, { currentKey: '2026-10' }));

    vi.setSystemTime(new Date('2026-11-01T04:00:00Z'));
    expectSameBytes(buildEs(data), buildEs(data, { currentKey: '2026-11' }));
    expectSameBytes(buildFinanzasXlsx(data), buildFinanzasXlsx(data, { currentKey: '2026-11' }));
  });

  it('currentKey is not used if there are months', () => {
    const data = seedData();
    expectSameBytes(buildEs(data, { currentKey: '2030-01' }), refFile(V3));
  });
});

describe('buildFinanzasXlsx · month sheet layout', () => {
  // [fixed expenses, transfers]: 12 fixed expenses and 3 transfers fit in the minimum rows (15 and 5); beyond that the
  // tables grow and the history moves down. With 16 fixed expenses and 3 transfers the two cards end on the same row.
  const sizes: [fixed: number, transfers: number][] = [
    [0, 0],
    [12, 3],
    [13, 3],
    [12, 4],
    [16, 3],
    [20, 9],
    [2, 20],
    [40, 30],
  ];

  it.each(sizes)('%i fixed expenses and %i transfers', async (nFixed, nTransfers) => {
    const key = '2026-10';
    await expectGolden(
      book([
        month(key, {
          fixed: range(nFixed).map((i) => fx(`Fijo ${i + 1}`, { amount: 100 + i, paid: i % 2 === 0, day: i % 3 ? String(i + 1) : '' })),
          transfers: range(nTransfers).map((i) => tr(day(key, 1 + (i % 28)), { via: i % 2 ? 'PayPal' : 'Remitly', usd: 100 * (i + 1), rate: 58 + i / 10 })),
          tx: range(7).map((i) => tx(day(key, 1 + i), { amount: 250.5 * (i + 1) })),
        }),
      ]),
    );
  });

  it('more than 15 fixed expenses and more than 5 transfers in several months at once', async () => {
    const months = ['2026-08', '2026-09', '2026-10'].map((key, k) =>
      month(key, {
        fixed: range(16 + 3 * k).map((i) => fx(`Fijo ${i + 1}`, { amount: 1000 + i, paid: i < 5 })),
        transfers: range(6 + 2 * k).map((i) => tr(day(key, 2 + i), { usd: 500 + i, rate: 58.4 + k / 10 })),
        tx: range(30 * k).map((i) => tx(day(key, 1 + (i % 28)), { desc: `Gasto ${i}`, amount: 99.99 + i })),
      }),
    );
    await expectGolden(book(months));
  });

  it('many transactions', async () => {
    const key = '2026-10';
    await expectGolden(
      book([month(key, { tx: range(400).map((i) => tx(day(key, 1 + ((i * 7) % 31)), { desc: `Gasto ${i}`, amount: i + 0.25 })) })]),
    );
  });
});

describe('buildFinanzasXlsx · cell values', () => {
  it('fixed expenses and transactions in USD', async () => {
    await expectGolden(
      book([
        month('2026-10', {
          fixed: [fx('Claude', { day: '5', amount: 106, cur: 'USD', paid: true }), fx('Luz', { amount: 1337.15 }), fx('Cursor', { amount: 20, cur: 'USD' })],
          transfers: [tr('2026-10-02')],
          tx: [
            tx('2026-10-03', { desc: 'Dominio', place: 'Namecheap', cat: 'Suscripciones', amount: 12.98, cur: 'USD' }),
            tx('2026-10-04', { amount: 4850 }),
            tx('2026-10-01', { desc: 'Vuelo', place: 'Turkish Airlines', cat: 'Viajes', method: 'App del banco', amount: 1240.5, cur: 'USD', notes: 'Escala en Madrid' }),
          ],
        }),
      ]),
    );
  });

  it('null amounts and days', async () => {
    await expectGolden(
      book([
        month('2026-10', {
          budget: null,
          incomeUSD: null,
          accounts: { usd: null, dop: null },
          fixed: [fx('Sin monto', { amount: null, day: null }), fx('Con monto', { amount: 0, day: null, paid: true })],
          transfers: [tr('2026-10-02', { usd: null, rate: null }), tr('2026-10-03', { usd: 100, rate: null })],
          tx: [tx('2026-10-05', { amount: null }), tx('2026-10-06', { amount: 0 })],
        }),
      ]),
    );
  });

  it("amounts and days as '' or as text, the way the prototype's inputs store them", async () => {
    await expectGolden(
      loose(
        book(
          [
            {
              key: '2026-10',
              budget: '',
              incomeUSD: '5800',
              accounts: { usd: '', dop: '86400.50' },
              fixed: [
                { name: 'Vacío', day: '', amount: '', cur: 'DOP', paid: false },
                { name: 'Texto numérico', day: '17', amount: '1550', cur: 'DOP', paid: true },
                { name: 'No numérico', day: 'fin de mes', amount: 'abc', cur: 'USD', paid: false },
                { name: 'Espacios', day: ' ', amount: ' 12.5 ', cur: '', paid: false },
                { name: 'Sin moneda', amount: 10, paid: false },
              ],
              transfers: [
                { date: '2026-10-02', via: '', usd: '1500', rate: '58.76' },
                { date: '2026-10-03', via: 'PayPal', usd: '', rate: '' },
                { date: '', via: 'Remitly', usd: 200, rate: 57 },
              ],
              tx: [
                { date: '2026-10-07', desc: 'Café', place: '', cat: '', method: '', amount: '385', cur: '', notes: '' },
                { date: '2026-10-06', desc: '', amount: '' },
                { date: null, desc: 'Sin fecha', place: 'X', cat: 'Comida', method: 'Tarjeta', amount: 1, cur: 'DOP', notes: null },
              ],
            },
          ] as unknown as ExportMonth[],
          { defaultRate: '58.9' as unknown as number },
        ),
      ),
    );
  });

  it('day as a number and as text', async () => {
    const days: Fixed['day'][] = [5, '5', '05', 0, '0', 17.5, '17.5', 'quincena', '1 y 15', '', null, -1, '1e2'];
    await expectGolden(
      book([month('2026-10', { fixed: days.map((d, i) => fx(`Fijo ${i + 1}`, { day: d, amount: 100 * (i + 1) })) })]),
    );
  });

  it('decimal, negative, huge and tiny numbers', async () => {
    const amounts = [0.1 + 0.2, -250.75, 1e21, 1.5e-7, 123456789.123456789, 0, -0, 58.760000000000005, Number.MAX_SAFE_INTEGER];
    await expectGolden(
      book(
        [
          month('2026-10', {
            budget: 69999.999,
            incomeUSD: 5800.005,
            accounts: { usd: -12.3, dop: 1e9 },
            fixed: amounts.map((a, i) => fx(`Fijo ${i + 1}`, { amount: a })),
            transfers: amounts.slice(0, 4).map((a, i) => tr(day('2026-10', i + 1), { usd: a, rate: 58.76 + a })),
            tx: amounts.map((a, i) => tx(day('2026-10', i + 1), { amount: a })),
          }),
        ],
        { contribs: amounts.map((a, i) => contrib(day('2026-10', i + 1), 'Ahorro personal', a)), defaultRate: 57.123456789 },
      ),
    );
  });

  it('text with & < > " \' and accents', async () => {
    const nasty = 'Tom & Jerry <b>"café"</b> \'ñandú\' ÁÉÍÓÚ áéíóú ü ¿? ¡! → ≈ − · € 😀 ]]> &amp; &lt;';
    await expectGolden(
      book(
        [
          month('2026-10', {
            fixed: [fx(nasty, { day: nasty, paid: true }), fx('  con espacios  '), fx('línea\nnueva\ty tab')],
            transfers: [tr('2026-10-02', { via: nasty })],
            tx: [
              tx('2026-10-03', { desc: nasty, place: nasty, cat: nasty, method: nasty, notes: nasty }),
              tx('2026-10-04', { desc: '<', place: '>', cat: '&', method: '"', notes: "'" }),
              tx('2026-10-05', { desc: 'Niños & niñas', place: 'Café "El Rincón"', cat: 'Educación', notes: "O'Reilly <libros>" }),
            ],
          }),
        ],
        { contribs: [contrib('2026-10-03', nasty, 100), contrib('2026-10-04', 'Viaje a Turquía', 3000)] },
      ),
    );
  });

  it('repeated accounts, fixed expenses, transfers and transactions share the same strings', async () => {
    const key = '2026-10';
    await expectGolden(
      book([
        month(key, {
          fixed: range(6).map(() => fx('Netflix', { amount: 1137.3 })),
          tx: range(20).map((i) => tx(day(key, 1 + (i % 3)), { desc: i % 2 ? 'Uber' : 'Almuerzo', place: 'Uber', cat: 'Transporte', notes: 'Uber' })),
        }),
      ]),
    );
  });
});

describe('buildFinanzasXlsx · Savings sheet', () => {
  it('contributions in DOP, unknown goals and out-of-order dates', async () => {
    await expectGolden(
      book([month('2026-09', { transfers: [tr('2026-09-02', { rate: 58.55 })] }), month('2026-10', { transfers: [tr('2026-10-02')] })], {
        contribs: [
          contrib('2026-10-03', 'Viaje a Turquía', 176280, 'DOP'),
          contrib('2026-09-18', 'Ahorro personal', 12000, 'DOP'),
          contrib('2026-10-03', 'Fondo de emergencia', 500, 'USD'),
          contrib('2026-08-03', 'Carro nuevo', 25000.5, 'DOP'),
          contrib('2026-09-18', 'Fondo de emergencia', 300),
          contrib('2025-01-15', 'Viaje a Turquía', 3000),
        ],
      }),
    );
  });

  it("contributions with no currency, with no date or with amount ''", async () => {
    await expectGolden(
      loose(
        book([month('2026-10')], {
          contribs: [
            { date: '2026-10-03', goalName: 'Ahorro personal', amount: '250', cur: '' },
            { date: '', goalName: 'Ahorro personal', amount: '', cur: 'DOP' },
            { date: '2026-10-01', goalName: '', amount: null, cur: 'USD' },
            { date: null, goalName: 'Fondo de emergencia', amount: 10 },
          ] as unknown as Contrib[],
        }),
      ),
    );
  });

  it('many contributions', async () => {
    const goals = ['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía'];
    await expectGolden(
      book([month('2026-10')], {
        contribs: range(150).map((i) => contrib(day('2026-10', 1 + ((i * 11) % 28)), goals[i % 3]!, 10 * i + 0.5, i % 4 ? 'USD' : 'DOP')),
      }),
    );
  });

  it('other plan parameters for the Turkey goal', async () => {
    const months = [month('2026-10')];
    const plans: [monthlyUSD: number, start: string, end: string][] = [
      [3000, '2026-08', '2027-10'],
      [2500, '2026-08', '2027-10'],
      [3000, '2027-01', '2029-06'],
      [1, '2026-10', '2026-10'],
      [1234.56, '2024-12', '2025-01'],
      [0.5, '1999-01', '2099-12'],
      [1e7, '2026-02', '2026-03'],
    ];
    for (const [monthlyUSD, start, end] of plans) {
      await expectGolden(book(months, { goals: referenceGoals({ monthlyUSD, start, end }) }));
    }
  });

  it('variable-contribution goals may come with the plan as null or without the fields', async () => {
    const [emergency, personal, trip] = referenceGoals();
    const months = [month('2026-10')];
    const expected = await expectGolden(book(months));
    // What the original does not distinguish does not change the workbook either.
    const bare = loose({ ...book(months), goals: [{ name: emergency!.name }, { name: personal!.name }, trip] });
    expectSameBytes(buildEs(bare), expected);
  });

  it('14 months or more: the income table grows', async () => {
    for (const n of [3, 4, 14, 15, 30]) {
      await expectGolden(book(keysFrom('2026-01', n).map((key) => month(key, { transfers: [tr(day(key, 2))] }))));
    }
  });

  it('months with gaps and across a year change', async () => {
    await expectGolden(book(['2025-11', '2026-10', '2028-03'].map((key) => month(key))));
    await expectGolden(book(['2026-12', '2027-01'].map((key) => month(key))));
  });
});

describe('buildFinanzasXlsx · Config sheet', () => {
  it('different, null or missing default rate', async () => {
    const months = [month('2026-10')];
    await expectGolden(book(months, { defaultRate: 60.123 }));
    await expectGolden(loose({ ...book(months), defaultRate: null }));
    await expectGolden(loose({ ...book(months), defaultRate: undefined }));
    await expectGolden(loose({ ...book(months), defaultRate: '' }));
  });

  it('missing lists: no months, no contribs, month without accounts', async () => {
    const goals = referenceGoals();
    await expectGolden(loose({ goals, defaultRate: 58.76 }), { currentKey: '2026-10', now: new Date(2026, 9, 7) });
    await expectGolden(loose({ months: [{ key: '2026-10', budget: 1, incomeUSD: 2, fixed: [], transfers: [], tx: [] }], goals, defaultRate: 58.76 }));
  });
});

describe('buildFinanzasXlsx · order', () => {
  it('out-of-order months: the sheets come out in chronological order', async () => {
    const data = seedData();
    const [ago, sep, oct] = data.months as [ExportMonth, ExportMonth, ExportMonth];
    for (const months of [[oct, ago, sep], [sep, oct, ago], [oct, sep, ago]]) {
      const out = await expectGolden({ ...data, months });
      expectSameBytes(out, refFile(V3));
    }
  });

  it('transactions and contributions that are out of order or share a date keep their relative order', async () => {
    const key = '2026-10';
    const dates = ['2026-10-07', '2026-10-01', '2026-10-07', '2026-09-30', '2026-10-01', '2026-11-02', '2026-10-07'];
    await expectGolden(
      book([month(key, { tx: dates.map((d, i) => tx(d, { desc: `Gasto ${i}`, amount: i + 1 })), transfers: dates.map((d, i) => tr(d, { usd: 100 + i })) })], {
        contribs: dates.map((d, i) => contrib(d, 'Ahorro personal', i + 1)),
      }),
    );
  });
});

describe('buildFinanzasXlsx · state and side effects', () => {
  it('two calls in a row return the same bytes', () => {
    const data = seedData();
    const first = buildEs(data);
    const second = buildEs(data);
    expect(second).not.toBe(first);
    expectSameBytes(second, first);
    expectSameBytes(first, refFile(V3));
  });

  it('one export leaves no trace in the next one', async () => {
    const big = book(
      keysFrom('2025-01', 6).map((key) =>
        month(key, { fixed: range(20).map((i) => fx(`Fijo ${i}`, { cur: 'USD' })), tx: range(40).map((i) => tx(day(key, 1 + (i % 28)), { desc: `Gasto ${i}` })) }),
      ),
      { contribs: range(30).map((i) => contrib(day('2025-03', 1 + (i % 28)), `Meta ${i}`, i, 'DOP')) },
    );
    await expectGolden(big);
    expectSameBytes(buildEs(empty(), { currentKey: '2026-10' }), refFile(PLANTILLA));
    // Not across languages either: an English workbook in between does not change the following Spanish ones.
    buildFinanzasXlsx(big);
    expectSameBytes(buildEs(seedData()), refFile(V3));
    await expectGolden(big);
    expectSameBytes(buildEs(empty(), { currentKey: '2026-10' }), refFile(PLANTILLA));
  });

  it('does not modify the input data', () => {
    const data = seedData();
    // Out of order, so the generator has to sort months, transactions and contributions.
    data.months.reverse();
    data.months.forEach((m) => m.tx.reverse());
    data.contribs.reverse();
    const before = structuredClone(data);
    buildEs(deepFreeze(data));
    buildFinanzasXlsx(data);
    expect(data).toEqual(before);

    // Nor the options or the language (the EXCEL_ES strings are the ones used by every Spanish export).
    const locale = structuredClone(EXCEL_ES);
    const opts = deepFreeze({ currentKey: '2026-10', locale: EXCEL_ES });
    const blank = deepFreeze(empty());
    buildFinanzasXlsx(blank, opts);
    expect(blank).toEqual(empty());
    expect(EXCEL_ES).toEqual(locale);
  });
});

describe('buildFinanzasXlsx · output format', () => {
  it('returns a Uint8Array with a readable zip and the parts in the same order as the original', () => {
    const out = buildEs(seedData());
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(out.length);
    // Zip signature: "PK\x03\x04".
    expect([...out.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const parts = Object.keys(unzipSync(out));
    expect(parts.slice(0, 3)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/worksheets/sheet1.xml']);
    // 3 months + Savings + Config; 3 tables per month + Contributions; one donut per month.
    expect(parts.filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))).toHaveLength(5);
    expect(parts.filter((p) => p.startsWith('xl/tables/'))).toHaveLength(10);
    expect(parts.filter((p) => /^xl\/charts\/chart\d+\.xml$/.test(p))).toHaveLength(3);
    expect(parts.slice(-4)).toEqual(['xl/styles.xml', 'xl/sharedStrings.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']);
  });

  it('file type', () => {
    expect(XLSX_MIME).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it("file name: the app's and, if given, the user's", () => {
    expect(xlsxFilename()).toBe('FE Finance.xlsx');
    expect(xlsxFilename('Frank')).toBe('FE Finance - Frank.xlsx');
    expect(xlsxFilename('Eda')).toBe('FE Finance - Eda.xlsx');
    expect(xlsxFilename('Ayşe Öztürk')).toBe('FE Finance - Ayşe Öztürk.xlsx');
    // With no name, or with one that is reduced to nothing, there is no suffix.
    expect(xlsxFilename('')).toBe('FE Finance.xlsx');
    expect(xlsxFilename('   ')).toBe('FE Finance.xlsx');
    expect(xlsxFilename('///')).toBe('FE Finance.xlsx');
    // Whatever a file name does not allow is dropped: \ / : * ? " < > | and control characters.
    expect(xlsxFilename('a\\b/c:d*e?f"g<h>i|j')).toBe('FE Finance - abcdefghij.xlsx');
    expect(xlsxFilename('  Frank \t\n Reyes\u0000 ')).toBe('FE Finance - Frank Reyes.xlsx');
    expect(xlsxFilename('../../etc/passwd')).toBe('FE Finance - ....etcpasswd.xlsx');
  });
});

// ── Random data ──────────────────────────────────────────────────────────────

/** Seeded pseudorandom generator (mulberry32): the random tests are repeatable. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomData(seed: number): ExportData {
  const rnd = prng(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]!;
  const words = ['Luz', 'Café & té', 'Niño <3', '"Cita"', "O'Brien", 'Ágora', 'Uber', '', ' ', 'a>b', 'x&amp;y', 'Supermercado', '日本', '😀'];
  const text = () => range(1 + int(3)).map(() => pick(words)).join(pick([' ', '', '-']));
  const amount = (): unknown =>
    pick<() => unknown>([
      () => Math.round(rnd() * 1e6) / 100,
      () => int(5000),
      () => rnd() * 1e4,
      () => -int(300),
      () => 0,
      () => null,
      () => '',
      () => String(int(9000)),
      () => `${int(90)}.${int(99)}`,
      () => 'n/a',
      () => undefined,
    ])();
  const date = (key: string): unknown =>
    pick<() => unknown>([
      () => day(key, 1 + int(28)),
      () => day(key, 1 + int(28)),
      () => day(key, 1 + int(28)),
      () => day(pick(['2025-12', '2026-02', '2027-11']), 1 + int(28)),
      () => '',
      () => null,
      () => key,
      () => 'ayer',
      () => `${key}-7`,
    ])();
  const cur = (): unknown => pick(['DOP', 'DOP', 'USD', '', undefined]);

  const keys = new Set<string>();
  const nMonths = pick([0, 1, 1, 2, 3, 5, 16]);
  while (keys.size < nMonths) keys.add(`${2024 + int(5)}-${String(1 + int(12)).padStart(2, '0')}`);

  const months = [...keys].map((key) => ({
    key,
    budget: amount(),
    incomeUSD: amount(),
    accounts: pick<unknown>([{}, { usd: amount(), dop: amount() }, { usd: amount() }, undefined]),
    fixed: range(pick([0, 1, 5, 11, 12, 13, 18, 26])).map(() => ({
      name: text(),
      day: pick<() => unknown>([() => '', () => String(1 + int(31)), () => 1 + int(31), () => null, () => text()])(),
      amount: amount(),
      cur: cur(),
      paid: rnd() < 0.5,
    })),
    transfers: range(pick([0, 1, 2, 3, 4, 7, 12])).map(() => ({
      date: date(key),
      via: pick(['Remitly', 'PayPal', '', text()]),
      usd: amount(),
      rate: amount(),
    })),
    tx: range(pick([0, 1, 7, 10, 35])).map(() => ({
      date: date(key),
      desc: text(),
      place: text(),
      cat: pick(['Comida', 'Supermercado', 'Transporte', 'Educación', '', text()]),
      method: pick(['Tarjeta', 'Transferencia', 'App del banco', '']),
      amount: amount(),
      cur: cur(),
      notes: pick(['', '', text(), undefined]),
    })),
  }));

  return loose({
    months: pick([months, months, months, [...months].reverse()]),
    contribs: range(pick([0, 1, 8, 25])).map(() => ({
      date: date(pick([...keys, '2026-10'])),
      goalName: pick(['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía', text()]),
      amount: amount(),
      cur: cur(),
    })),
    // The plan is always valid (otherwise the goal would stop having a plan and the original could not draw it).
    goals: referenceGoals(
      pick([
        { monthlyUSD: 3000, start: '2026-08', end: '2027-10' },
        { monthlyUSD: 1 + int(9000) + int(100) / 100, start: pick(['2024-01', '2026-01', '2026-10']), end: pick(['2026-10', '2028-12', '2031-07']) },
      ]),
    ),
    defaultRate: pick<unknown>([58.76, 60, '59.1', null, '']),
  });
}

describe('buildFinanzasXlsx · random data', () => {
  it.each(range(60).map((i) => i + 1))('seed %i', async (seed) => {
    await expectGolden(randomData(seed), { currentKey: '2026-10', now: new Date(2026, 9, 7) });
  });
});
