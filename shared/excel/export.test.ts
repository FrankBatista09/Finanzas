// Pruebas "golden" del port: para los mismos datos, buildFinanzasXlsx tiene que devolver exactamente los
// mismos bytes que el exportador original del prototipo (tests/reference-export.ts lo ejecuta en un vm).
// reference.test.ts ancla ese exportador a los libros de design_handoff/referencia/.
//
// El original solo sabe hacer el libro en español con las tres metas del diseño, así que todo aquí va con
// EXCEL_ES, datos en español (la entrada congelada tests/export-data-es.json) y esas metas (referenceGoals).
// Los datos no salen del estado de la app: el generador solo conoce ExportData. Lo que el original no puede
// representar se prueba aparte: los otros idiomas en export-locale.test.ts, otras listas de metas en
// export-goals.test.ts y el recálculo en una hoja de cálculo real en export-libreoffice.test.ts.

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

// ── Comparación ──────────────────────────────────────────────────────────────

/** Trozo de `s` alrededor de `i`, para ver la diferencia en contexto. */
const around = (s: string, i: number) => JSON.stringify(s.slice(Math.max(0, i - 80), i + 120));

/** Primera diferencia entre dos libros, parte por parte del zip; null si son idénticos byte a byte. */
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

/** El port con los textos en español, que es lo único que el exportador de referencia sabe generar. */
const buildEs = (data: ExportData, opts: Omit<BuildOptions, 'locale'> = {}) =>
  buildFinanzasXlsx(data, { ...opts, locale: EXCEL_ES });

/**
 * Compara el port (en español) con el exportador de referencia para `data` y devuelve los bytes.
 * El port recibe una copia congelada: si intentara modificar la entrada, la prueba falla.
 */
async function expectGolden(data: ExportData, opts: { currentKey?: string; now?: Date } = {}): Promise<Uint8Array> {
  const expected = await buildWithReference(data, { now: opts.now });
  const actual = buildEs(deepFreeze(structuredClone(data)), { currentKey: opts.currentKey });
  expectSameBytes(actual, expected);
  return actual;
}

// ── Datos ────────────────────────────────────────────────────────────────────

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

/** Libro sin meses: el generador hace la plantilla vacía del mes actual. */
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
 * Datos con la forma que tendrían en el prototipo, donde los inputs guardan texto ('' o '1500')
 * y faltan campos: se saltan los tipos a propósito para probar que el port los trata igual.
 */
const loose = (data: unknown) => data as ExportData;

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const day = (key: string, n: number) => `${key}-${String(n).padStart(2, '0')}`;

/** `n` meses seguidos a partir de `start`. */
function keysFrom(start: string, n: number): string[] {
  const [y, m] = start.split('-').map(Number) as [number, number];
  return range(n).map((i) => {
    const t = y * 12 + (m - 1) + i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

/** Los datos de ejemplo del diseño, en español: los del libro Finanzas Personales v3.xlsx. */
const seedData = () => frozenExportData('es');

// ── Pruebas ──────────────────────────────────────────────────────────────────

describe('comparación de libros', () => {
  it('detecta una diferencia y dice en qué parte está', () => {
    const data = seedData();
    const out = buildEs(data);
    expect(firstDiff(out, out.slice())).toBeNull();
    // La plantilla tiene menos hojas: la primera parte distinta es la lista de partes.
    expect(firstDiff(out, refFile(PLANTILLA))).toMatch(/^\[Content_Types\]\.xml difiere en el carácter \d+/);

    // Un solo carácter distinto en una nota basta.
    data.months[0]!.tx[0]!.notes = 'x';
    expect(firstDiff(buildEs(data), out)).toMatch(/^xl\/worksheets\/sheet1\.xml difiere/);
    data.months[0]!.tx[0]!.notes = '';
    data.defaultRate = 58.77;
    expect(firstDiff(buildEs(data), out)).toMatch(/^xl\/worksheets\/sheet5\.xml difiere/);
    // El idioma es parte de la salida: el mismo libro en inglés (el idioma por defecto) ya no es el de referencia.
    data.defaultRate = 58.76;
    expect(firstDiff(buildEs(data), out)).toBeNull();
    expect(firstDiff(buildFinanzasXlsx(data), out)).toMatch(/^xl\/worksheets\/sheet1\.xml difiere/);
  });
});

describe('buildFinanzasXlsx · libros de referencia', () => {
  it('datos de ejemplo → Finanzas Personales v3.xlsx', async () => {
    const out = await expectGolden(seedData());
    expectSameBytes(out, refFile(V3));
  });

  it('sin meses → Plantilla vacia.xlsx (currentKey 2026-10)', async () => {
    const out = await expectGolden(empty(), { currentKey: '2026-10', now: new Date(2026, 9, 7) });
    expectSameBytes(out, refFile(PLANTILLA));
  });

  it('sin meses: la plantilla es la del mes indicado', async () => {
    await expectGolden(empty(), { currentKey: '2027-01', now: new Date(2027, 0, 15) });
    await expectGolden(empty(), { currentKey: '2025-12', now: new Date(2025, 11, 31) });
  });

  it('un solo mes vacío equivale a la plantilla vacía de ese mes', async () => {
    const out = await expectGolden(book([emptyMonth('2026-10')]));
    expectSameBytes(out, refFile(PLANTILLA));
  });
});

describe('buildFinanzasXlsx · mes actual por defecto', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sin currentKey usa el mes actual en la zona horaria del usuario, no en UTC', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 1 de noviembre a las 02:30 UTC: en Santo Domingo (UTC-4) todavía es 31 de octubre.
    vi.setSystemTime(new Date('2026-11-01T02:30:00Z'));
    const data = empty();
    expectSameBytes(buildEs(data), refFile(PLANTILLA));
    expectSameBytes(buildEs(data, {}), buildEs(data, { currentKey: '2026-10' }));
    // Lo mismo sin indicar idioma (inglés).
    expectSameBytes(buildFinanzasXlsx(data), buildFinanzasXlsx(data, { currentKey: '2026-10' }));

    vi.setSystemTime(new Date('2026-11-01T04:00:00Z'));
    expectSameBytes(buildEs(data), buildEs(data, { currentKey: '2026-11' }));
    expectSameBytes(buildFinanzasXlsx(data), buildFinanzasXlsx(data, { currentKey: '2026-11' }));
  });

  it('currentKey no se usa si hay meses', () => {
    const data = seedData();
    expectSameBytes(buildEs(data, { currentKey: '2030-01' }), refFile(V3));
  });
});

describe('buildFinanzasXlsx · disposición de la hoja del mes', () => {
  // [fijos, envíos]: 12 fijos y 3 envíos caben en las filas mínimas (15 y 5); a partir de ahí las tablas
  // crecen y el historial baja. Con 16 fijos y 3 envíos las dos tarjetas terminan en la misma fila.
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

  it.each(sizes)('%i fijos y %i envíos', async (nFixed, nTransfers) => {
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

  it('más de 15 fijos y más de 5 envíos en varios meses a la vez', async () => {
    const months = ['2026-08', '2026-09', '2026-10'].map((key, k) =>
      month(key, {
        fixed: range(16 + 3 * k).map((i) => fx(`Fijo ${i + 1}`, { amount: 1000 + i, paid: i < 5 })),
        transfers: range(6 + 2 * k).map((i) => tr(day(key, 2 + i), { usd: 500 + i, rate: 58.4 + k / 10 })),
        tx: range(30 * k).map((i) => tx(day(key, 1 + (i % 28)), { desc: `Gasto ${i}`, amount: 99.99 + i })),
      }),
    );
    await expectGolden(book(months));
  });

  it('muchas transacciones', async () => {
    const key = '2026-10';
    await expectGolden(
      book([month(key, { tx: range(400).map((i) => tx(day(key, 1 + ((i * 7) % 31)), { desc: `Gasto ${i}`, amount: i + 0.25 })) })]),
    );
  });
});

describe('buildFinanzasXlsx · valores de las celdas', () => {
  it('fijos y transacciones en USD', async () => {
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

  it('montos y días null', async () => {
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

  it("montos y días '' o en texto, como los guardan los inputs del prototipo", async () => {
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

  it('día como número y como texto', async () => {
    const days: Fixed['day'][] = [5, '5', '05', 0, '0', 17.5, '17.5', 'quincena', '1 y 15', '', null, -1, '1e2'];
    await expectGolden(
      book([month('2026-10', { fixed: days.map((d, i) => fx(`Fijo ${i + 1}`, { day: d, amount: 100 * (i + 1) })) })]),
    );
  });

  it('números con decimales, negativos, enormes y diminutos', async () => {
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

  it('texto con & < > " \' y acentos', async () => {
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

  it('cuentas, fijos, envíos y transacciones repetidos comparten los mismos textos', async () => {
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

describe('buildFinanzasXlsx · hoja Ahorros', () => {
  it('aportes en DOP, metas desconocidas y fechas desordenadas', async () => {
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

  it("aportes sin moneda, sin fecha o con monto ''", async () => {
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

  it('muchos aportes', async () => {
    const goals = ['Fondo de emergencia', 'Ahorro personal', 'Viaje a Turquía'];
    await expectGolden(
      book([month('2026-10')], {
        contribs: range(150).map((i) => contrib(day('2026-10', 1 + ((i * 11) % 28)), goals[i % 3]!, 10 * i + 0.5, i % 4 ? 'USD' : 'DOP')),
      }),
    );
  });

  it('otros parámetros del plan de la meta de Turquía', async () => {
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

  it('las metas de aportes variables pueden traer el plan como null o sin los campos', async () => {
    const [emergency, personal, trip] = referenceGoals();
    const months = [month('2026-10')];
    const expected = await expectGolden(book(months));
    // Lo que el original no distingue tampoco cambia el libro.
    const bare = loose({ ...book(months), goals: [{ name: emergency!.name }, { name: personal!.name }, trip] });
    expectSameBytes(buildEs(bare), expected);
  });

  it('14 meses o más: la tabla de ingresos crece', async () => {
    for (const n of [3, 4, 14, 15, 30]) {
      await expectGolden(book(keysFrom('2026-01', n).map((key) => month(key, { transfers: [tr(day(key, 2))] }))));
    }
  });

  it('meses salteados y con cambio de año', async () => {
    await expectGolden(book(['2025-11', '2026-10', '2028-03'].map((key) => month(key))));
    await expectGolden(book(['2026-12', '2027-01'].map((key) => month(key))));
  });
});

describe('buildFinanzasXlsx · hoja Config', () => {
  it('tasa por defecto distinta, null o ausente', async () => {
    const months = [month('2026-10')];
    await expectGolden(book(months, { defaultRate: 60.123 }));
    await expectGolden(loose({ ...book(months), defaultRate: null }));
    await expectGolden(loose({ ...book(months), defaultRate: undefined }));
    await expectGolden(loose({ ...book(months), defaultRate: '' }));
  });

  it('listas ausentes: sin months, sin contribs, mes sin accounts', async () => {
    const goals = referenceGoals();
    await expectGolden(loose({ goals, defaultRate: 58.76 }), { currentKey: '2026-10', now: new Date(2026, 9, 7) });
    await expectGolden(loose({ months: [{ key: '2026-10', budget: 1, incomeUSD: 2, fixed: [], transfers: [], tx: [] }], goals, defaultRate: 58.76 }));
  });
});

describe('buildFinanzasXlsx · orden', () => {
  it('meses desordenados: las hojas salen en orden cronológico', async () => {
    const data = seedData();
    const [ago, sep, oct] = data.months as [ExportMonth, ExportMonth, ExportMonth];
    for (const months of [[oct, ago, sep], [sep, oct, ago], [oct, sep, ago]]) {
      const out = await expectGolden({ ...data, months });
      expectSameBytes(out, refFile(V3));
    }
  });

  it('transacciones y aportes desordenados o con la misma fecha conservan su orden relativo', async () => {
    const key = '2026-10';
    const dates = ['2026-10-07', '2026-10-01', '2026-10-07', '2026-09-30', '2026-10-01', '2026-11-02', '2026-10-07'];
    await expectGolden(
      book([month(key, { tx: dates.map((d, i) => tx(d, { desc: `Gasto ${i}`, amount: i + 1 })), transfers: dates.map((d, i) => tr(d, { usd: 100 + i })) })], {
        contribs: dates.map((d, i) => contrib(d, 'Ahorro personal', i + 1)),
      }),
    );
  });
});

describe('buildFinanzasXlsx · estado y efectos', () => {
  it('dos llamadas seguidas devuelven los mismos bytes', () => {
    const data = seedData();
    const first = buildEs(data);
    const second = buildEs(data);
    expect(second).not.toBe(first);
    expectSameBytes(second, first);
    expectSameBytes(first, refFile(V3));
  });

  it('una exportación no deja restos en la siguiente', async () => {
    const big = book(
      keysFrom('2025-01', 6).map((key) =>
        month(key, { fixed: range(20).map((i) => fx(`Fijo ${i}`, { cur: 'USD' })), tx: range(40).map((i) => tx(day(key, 1 + (i % 28)), { desc: `Gasto ${i}` })) }),
      ),
      { contribs: range(30).map((i) => contrib(day('2025-03', 1 + (i % 28)), `Meta ${i}`, i, 'DOP')) },
    );
    await expectGolden(big);
    expectSameBytes(buildEs(empty(), { currentKey: '2026-10' }), refFile(PLANTILLA));
    // Tampoco entre idiomas: un libro en inglés en medio no cambia los siguientes en español.
    buildFinanzasXlsx(big);
    expectSameBytes(buildEs(seedData()), refFile(V3));
    await expectGolden(big);
    expectSameBytes(buildEs(empty(), { currentKey: '2026-10' }), refFile(PLANTILLA));
  });

  it('no modifica los datos de entrada', () => {
    const data = seedData();
    // Desordenados, para que el generador tenga que ordenar meses, transacciones y aportes.
    data.months.reverse();
    data.months.forEach((m) => m.tx.reverse());
    data.contribs.reverse();
    const before = structuredClone(data);
    buildEs(deepFreeze(data));
    buildFinanzasXlsx(data);
    expect(data).toEqual(before);

    // Ni las opciones ni el idioma (los textos de EXCEL_ES son los de todas las exportaciones en español).
    const locale = structuredClone(EXCEL_ES);
    const opts = deepFreeze({ currentKey: '2026-10', locale: EXCEL_ES });
    const blank = deepFreeze(empty());
    buildFinanzasXlsx(blank, opts);
    expect(blank).toEqual(empty());
    expect(EXCEL_ES).toEqual(locale);
  });
});

describe('buildFinanzasXlsx · formato de salida', () => {
  it('devuelve un Uint8Array con un zip legible y las partes en el orden del original', () => {
    const out = buildEs(seedData());
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(out.length);
    // Firma de zip: "PK\x03\x04".
    expect([...out.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const parts = Object.keys(unzipSync(out));
    expect(parts.slice(0, 3)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/worksheets/sheet1.xml']);
    // 3 meses + Ahorros + Config; 3 tablas por mes + Aportes; una dona por mes.
    expect(parts.filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))).toHaveLength(5);
    expect(parts.filter((p) => p.startsWith('xl/tables/'))).toHaveLength(10);
    expect(parts.filter((p) => /^xl\/charts\/chart\d+\.xml$/.test(p))).toHaveLength(3);
    expect(parts.slice(-4)).toEqual(['xl/styles.xml', 'xl/sharedStrings.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']);
  });

  it('tipo del archivo', () => {
    expect(XLSX_MIME).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('nombre del archivo: el de la app y, si se indica, el del usuario', () => {
    expect(xlsxFilename()).toBe('FE Finance.xlsx');
    expect(xlsxFilename('Frank')).toBe('FE Finance - Frank.xlsx');
    expect(xlsxFilename('Eda')).toBe('FE Finance - Eda.xlsx');
    expect(xlsxFilename('Ayşe Öztürk')).toBe('FE Finance - Ayşe Öztürk.xlsx');
    // Sin nombre, o con uno que se queda en nada, no hay sufijo.
    expect(xlsxFilename('')).toBe('FE Finance.xlsx');
    expect(xlsxFilename('   ')).toBe('FE Finance.xlsx');
    expect(xlsxFilename('///')).toBe('FE Finance.xlsx');
    // Fuera lo que no admite un nombre de archivo: \ / : * ? " < > | y los caracteres de control.
    expect(xlsxFilename('a\\b/c:d*e?f"g<h>i|j')).toBe('FE Finance - abcdefghij.xlsx');
    expect(xlsxFilename('  Frank \t\n Reyes\u0000 ')).toBe('FE Finance - Frank Reyes.xlsx');
    expect(xlsxFilename('../../etc/passwd')).toBe('FE Finance - ....etcpasswd.xlsx');
  });
});

// ── Datos al azar ────────────────────────────────────────────────────────────

/** Generador pseudoaleatorio con semilla (mulberry32): las pruebas al azar son repetibles. */
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
    // El plan siempre es válido (si no, la meta dejaría de tener plan y el original no sabría dibujarla).
    goals: referenceGoals(
      pick([
        { monthlyUSD: 3000, start: '2026-08', end: '2027-10' },
        { monthlyUSD: 1 + int(9000) + int(100) / 100, start: pick(['2024-01', '2026-01', '2026-10']), end: pick(['2026-10', '2028-12', '2031-07']) },
      ]),
    ),
    defaultRate: pick<unknown>([58.76, 60, '59.1', null, '']),
  });
}

describe('buildFinanzasXlsx · datos al azar', () => {
  it.each(range(60).map((i) => i + 1))('semilla %i', async (seed) => {
    await expectGolden(randomData(seed), { currentKey: '2026-10', now: new Date(2026, 9, 7) });
  });
});
