// Rutas de Excel. El generador y el lector de .xlsx (shared/excel) tienen sus propias pruebas; aquí se
// sustituyen para comprobar solo lo que hace la ruta: qué les pasa, cabeceras, errores y lo que se guarda.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportPayload, ImportResponse } from '../shared/api';
import { buildExportData } from '../shared/excel/data';
import { buildFinanzasXlsx, EXCEL_EN, EXCEL_ES, EXCEL_TR, XLSX_MIME } from '../shared/excel/export';
import { ImportError, parseFinanzasXlsx } from '../shared/excel/import';
import { currentMonthKey } from '../shared/month';
import { seedState } from '../shared/seed';
import { MAX_IMPORT_BYTES } from './app';
import { loadState, replaceAll, updateSettings } from './db';
import { client, EDA, FRANK, makeEnv, withoutTimestamps } from './test-util';

vi.mock('../shared/excel/export', async (original) => ({
  ...(await original<typeof import('../shared/excel/export')>()),
  buildFinanzasXlsx: vi.fn(),
}));

vi.mock('../shared/excel/import', async (original) => ({
  ...(await original<typeof import('../shared/excel/import')>()),
  parseFinanzasXlsx: vi.fn(),
}));

const build = vi.mocked(buildFinanzasXlsx);
const parseXlsx = vi.mocked(parseFinanzasXlsx);

// "PK\x03\x04…": lo que importa es que la ruta lo devuelva byte a byte.
const WORKBOOK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x80]);

const F = FRANK.id;
const E = EDA.id;

afterEach(() => {
  vi.resetAllMocks();
});

/** Los dos usuarios con los datos de ejemplo. `api` es Frank; `eda`, Eda. */
async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, E, seedState());
  return { ...t, api: client(t.env), eda: client(t.env, E) };
}

describe('GET /api/export.xlsx', () => {
  it('genera el libro con todo el histórico del usuario y lo entrega como descarga con su nombre', async () => {
    build.mockReturnValue(WORKBOOK);
    const { api, db } = await seeded();
    const res = await api.raw('/api/export.xlsx', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(XLSX_MIME);
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="FE Finance - Frank.xlsx"; filename*=UTF-8''FE%20Finance%20-%20Frank.xlsx`,
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Length')).toBe(String(WORKBOOK.byteLength));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WORKBOOK);

    expect(build).toHaveBeenCalledTimes(1);
    // Sin idioma elegido, el libro sale en inglés.
    expect(build).toHaveBeenCalledWith(buildExportData(await loadState(db, F)), { currentKey: currentMonthKey(), locale: EXCEL_EN });
    // Lo que recibe el generador son los datos de ejemplo tal cual.
    expect(build.mock.calls[0]![0]).toEqual(buildExportData(seedState()));
  });

  it('cada usuario descarga su libro, en su idioma', async () => {
    build.mockReturnValue(WORKBOOK);
    const { api, eda, db } = await seeded();
    await updateSettings(db, F, { language: 'es' });
    await updateSettings(db, E, { language: 'tr' });
    await eda.post('/api/transactions', { monthKey: '2026-10', date: '2026-10-07', desc: 'Simit', cat: 'Food', method: 'Card', amount: 50, cur: 'DOP' });

    const mine = await api.raw('/api/export.xlsx', { method: 'GET' });
    const hers = await eda.raw('/api/export.xlsx', { method: 'GET' });
    expect(mine.headers.get('Content-Disposition')).toContain('filename="FE Finance - Frank.xlsx"');
    expect(hers.headers.get('Content-Disposition')).toContain('filename="FE Finance - Eda.xlsx"');

    expect(build).toHaveBeenCalledTimes(2);
    const [frankData, frankOpts] = build.mock.calls[0]!;
    const [edaData, edaOpts] = build.mock.calls[1]!;
    expect(frankOpts?.locale).toBe(EXCEL_ES);
    expect(edaOpts?.locale).toBe(EXCEL_TR);
    // Lo que se guarda no depende del idioma: el generador recibe los valores canónicos y es él quien traduce.
    expect(frankData).toEqual(buildExportData(seedState()));
    expect(edaData.months[2]!.tx).toHaveLength(8);
    expect(edaData.months[2]!.tx.at(-1)).toMatchObject({ desc: 'Simit', cat: 'Food', method: 'Card' });
  });

  it('un nombre con tildes viaja en filename* y deja un nombre ASCII de respaldo', async () => {
    build.mockReturnValue(WORKBOOK);
    const { env } = makeEnv({ USERS: 'ana:Ana María' });
    const res = await client(env, 'ana').raw('/api/export.xlsx', { method: 'GET' });
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="FE Finance - Ana Mar_a.xlsx"; filename*=UTF-8''FE%20Finance%20-%20Ana%20Mar%C3%ADa.xlsx`,
    );
  });

  it('sin datos pide la plantilla vacía del mes actual y no crea nada en la base', async () => {
    build.mockReturnValue(WORKBOOK);
    const { env, db } = makeEnv();
    const res = await client(env).raw('/api/export.xlsx', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(build.mock.calls[0]![0].months).toEqual([]);
    expect(build.mock.calls[0]![1]).toEqual({ currentKey: currentMonthKey(), locale: EXCEL_EN });
    const state = await loadState(db, F);
    expect([state.months, state.accounts, state.goals]).toEqual([{}, [], []]);
  });

  it('si el generador falla: 500 sin detalles', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    build.mockImplementation(() => {
      throw new Error('detalle interno');
    });
    const { api } = await seeded();
    const r = await api.get('/api/export.xlsx');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: 'internal', message: 'Internal server error.' } });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('POST /api/import con el .xlsx crudo', () => {
  const payload: ImportPayload = {
    months: [
      {
        key: '2026-11',
        closed: false,
        budget: 70000,
        incomeUSD: 5800,
        accounts: { usd: 1, dop: 2 },
        fixed: [{ name: 'Luz', day: '', amount: 1400, cur: 'DOP', paid: false }],
        transfers: [],
        tx: [{ date: '2026-11-02', desc: 'Café', place: '', cat: 'Food', method: 'Card', amount: 200, cur: 'DOP', notes: '' }],
      },
    ],
    contribs: null,
    goals: null,
  };

  const upload = (api: ReturnType<typeof client>, type?: string) =>
    api.raw('/api/import', { method: 'POST', headers: type ? { 'Content-Type': type } : {}, body: WORKBOOK });

  it('pasa los bytes al lector y aplica lo que devuelve, solo a ese usuario', async () => {
    parseXlsx.mockReturnValue(payload);
    const { api, db } = await seeded();
    const eda = await loadState(db, E);
    for (const type of [XLSX_MIME, 'application/octet-stream', undefined]) {
      const res = await upload(api, type);
      expect(res.status).toBe(200);
      expect((await res.json()) as ImportResponse).toEqual({ months: ['2026-11'], contributions: 0 });
    }
    expect(parseXlsx).toHaveBeenCalledTimes(3);
    expect(parseXlsx.mock.calls[0]![0]).toEqual(WORKBOOK);

    const state = await loadState(db, F);
    expect(Object.keys(state.months)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    // Reimportar no duplica: el mes se sustituye entero, y su ingreso también.
    expect(state.months['2026-11']!.fixed).toHaveLength(1);
    expect(state.months['2026-11']!.tx.map((t) => [t.desc, t.accountId, t.source])).toEqual([['Café', 'dr', 'import']]);
    expect(state.months['2026-11']!.budgets).toEqual({ dr: 70000 });
    expect(state.incomes.filter((i) => i.date.startsWith('2026-11'))).toHaveLength(1);
    expect(state.contribs).toHaveLength(8);
    // Los meses que no vienen en el archivo siguen como en los datos de ejemplo, fila por fila.
    for (const key of ['2026-08', '2026-09', '2026-10']) expect(withoutTimestamps(state).months[key]).toEqual(seedState().months[key]);
    expect(await loadState(db, E)).toEqual(eda);
  });

  it('las metas y los aportes del libro van a quien lo sube', async () => {
    parseXlsx.mockReturnValue({
      months: [],
      contribs: [{ date: '2026-10-05', goalName: 'Car', amount: 100, cur: 'USD' }],
      goals: [{ name: 'Car', monthlyUSD: 200, start: '2026-10', end: '2027-09' }],
    });
    const { eda, db } = await seeded();
    const frank = await loadState(db, F);
    const res = await upload(eda, XLSX_MIME);
    expect((await res.json()) as ImportResponse).toEqual({ months: [], contributions: 1 });
    const state = await loadState(db, E);
    expect(state.goals.map((g) => [g.name, g.monthly])).toEqual([
      ['Emergency fund', null],
      ['Personal savings', null],
      ['Trip to Turkey', 3000],
      ['Car', 200],
    ]);
    expect(state.contribs.map((c) => c.goalId)).toEqual([state.goals[3]!.id]);
    expect(await loadState(db, F)).toEqual(frank);
  });

  it('con application/json no se usa el lector de Excel', async () => {
    const { api } = await seeded();
    const r = await api.post<ImportResponse>('/api/import', payload);
    expect(r.status).toBe(200);
    expect(parseXlsx).not.toHaveBeenCalled();
    const res = await api.raw('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(parseXlsx).not.toHaveBeenCalled();
  });

  it('ImportError → 400 validation con su mensaje', async () => {
    parseXlsx.mockImplementation(() => {
      throw new ImportError('The file has no month sheets.');
    });
    const { api, db } = await seeded();
    const before = await loadState(db, F);
    const res = await upload(api, XLSX_MIME);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'validation', message: 'The file has no month sheets.' } });
    expect(await loadState(db, F)).toEqual(before);
  });

  it('cualquier otro fallo del lector es un archivo ilegible (400), no un 500', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    parseXlsx.mockImplementation(() => {
      throw new TypeError('invalid zip data');
    });
    const { api } = await seeded();
    const res = await upload(api, XLSX_MIME);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'validation', message: 'Could not read the file.' } });
    log.mockRestore();
  });

  it('lo que devuelve el lector también se valida', async () => {
    parseXlsx.mockReturnValue({ ...payload, months: [{ ...payload.months[0]!, key: 'November 2026' }] });
    const { api, db } = await seeded();
    const res = await upload(api, XLSX_MIME);
    expect(res.status).toBe(400);
    expect(Object.keys((await loadState(db, F)).months)).toEqual(['2026-08', '2026-09', '2026-10']);

    // También el plan de las metas: medio plan rechaza el archivo en vez de guardarse a medias.
    parseXlsx.mockReturnValue({ ...payload, goals: [{ name: 'Trip to Turkey', monthlyUSD: null, start: '2026-08', end: '2027-10' }] });
    const partial = await upload(api, XLSX_MIME);
    expect(partial.status).toBe(400);
    expect(((await partial.json()) as { error: { message: string } }).error.message).toContain('goals.0.monthlyUSD');
    expect((await loadState(db, F)).goals).toEqual(seedState().goals);
  });

  it('más de 10 MB: 413, sin llegar a leerlo', async () => {
    const { api } = await seeded();
    const res = await api.raw('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': XLSX_MIME },
      body: new Uint8Array(MAX_IMPORT_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'validation', message: 'The file is too large (maximum 10 MB).' } });
    expect(parseXlsx).not.toHaveBeenCalled();

    // Justo en el límite sí pasa al lector.
    parseXlsx.mockReturnValue(payload);
    const atLimit = await api.raw('/api/import', { method: 'POST', body: new Uint8Array(MAX_IMPORT_BYTES) });
    expect(atLimit.status).toBe(200);
  });
});
