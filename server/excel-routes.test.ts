// Excel routes. The .xlsx generator and reader (shared/excel) have their own tests; here they are
// mocked to check only what the route does: what it passes to them, headers, errors and what gets stored.

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

// "PK\x03\x04…": what matters is that the route returns it byte for byte.
const WORKBOOK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x80]);

const F = FRANK.id;
const E = EDA.id;

afterEach(() => {
  vi.resetAllMocks();
});

/** The two users with the sample data. `api` is Frank; `eda`, Eda. */
async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, E, seedState());
  return { ...t, api: client(t.env), eda: client(t.env, E) };
}

describe('GET /api/export.xlsx', () => {
  it('generates the workbook with the whole history of the user and serves it as a download with their name', async () => {
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
    // With no language chosen, the workbook comes out in English.
    expect(build).toHaveBeenCalledWith(buildExportData(await loadState(db, F)), { currentKey: currentMonthKey(), locale: EXCEL_EN });
    // What the generator receives is the sample data as is.
    expect(build.mock.calls[0]![0]).toEqual(buildExportData(seedState()));
  });

  it('each user downloads their workbook, in their language', async () => {
    build.mockReturnValue(WORKBOOK);
    const { api, eda, db } = await seeded();
    await updateSettings(db, F, { language: 'es' });
    await updateSettings(db, E, { language: 'tr' });
    await eda.post('/api/transactions', { monthKey: '2026-10', date: '2026-10-07', desc: 'Simit', cat: 'Food', method: 'Debit card', amount: 50, cur: 'DOP' });

    const mine = await api.raw('/api/export.xlsx', { method: 'GET' });
    const hers = await eda.raw('/api/export.xlsx', { method: 'GET' });
    expect(mine.headers.get('Content-Disposition')).toContain('filename="FE Finance - Frank.xlsx"');
    expect(hers.headers.get('Content-Disposition')).toContain('filename="FE Finance - Eda.xlsx"');

    expect(build).toHaveBeenCalledTimes(2);
    const [frankData, frankOpts] = build.mock.calls[0]!;
    const [edaData, edaOpts] = build.mock.calls[1]!;
    expect(frankOpts?.locale).toBe(EXCEL_ES);
    expect(edaOpts?.locale).toBe(EXCEL_TR);
    // What is stored does not depend on the language: the generator gets the canonical values and does the translating.
    expect(frankData).toEqual(buildExportData(seedState()));
    expect(edaData.months[2]!.tx).toHaveLength(8);
    expect(edaData.months[2]!.tx.at(-1)).toMatchObject({ desc: 'Simit', cat: 'Food', method: 'Debit card' });
  });

  it('a name with accents travels in filename* and leaves an ASCII fallback name', async () => {
    build.mockReturnValue(WORKBOOK);
    const { env } = makeEnv({ USERS: 'ana:Ana María' });
    const res = await client(env, 'ana').raw('/api/export.xlsx', { method: 'GET' });
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="FE Finance - Ana Mar_a.xlsx"; filename*=UTF-8''FE%20Finance%20-%20Ana%20Mar%C3%ADa.xlsx`,
    );
  });

  it('with no data it asks for the empty template of the current month and creates nothing in the database', async () => {
    build.mockReturnValue(WORKBOOK);
    const { env, db } = makeEnv();
    const res = await client(env).raw('/api/export.xlsx', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(build.mock.calls[0]![0].months).toEqual([]);
    expect(build.mock.calls[0]![1]).toEqual({ currentKey: currentMonthKey(), locale: EXCEL_EN });
    const state = await loadState(db, F);
    expect([state.months, state.accounts, state.goals]).toEqual([{}, [], []]);
  });

  it('if the generator fails: 500 with no details', async () => {
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

describe('POST /api/import with the raw .xlsx', () => {
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
        tx: [{ date: '2026-11-02', desc: 'Café', place: '', cat: 'Food', method: 'Debit card', amount: 200, cur: 'DOP', notes: '' }],
      },
    ],
    contribs: null,
    goals: null,
  };

  const upload = (api: ReturnType<typeof client>, type?: string) =>
    api.raw('/api/import', { method: 'POST', headers: type ? { 'Content-Type': type } : {}, body: WORKBOOK });

  it('passes the bytes to the reader and applies what it returns, only to that user', async () => {
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
    // Re-importing does not duplicate: the whole month is replaced, and its income too.
    expect(state.months['2026-11']!.fixed).toHaveLength(1);
    expect(state.months['2026-11']!.tx.map((t) => [t.desc, t.accountId, t.source])).toEqual([['Café', 'dr', 'import']]);
    expect(state.months['2026-11']!.budgets).toEqual({ dr: 70000 });
    expect(state.incomes.filter((i) => i.date.startsWith('2026-11'))).toHaveLength(1);
    expect(state.contribs).toHaveLength(8);
    // The months that are not in the file stay as in the sample data, row by row.
    for (const key of ['2026-08', '2026-09', '2026-10']) expect(withoutTimestamps(state).months[key]).toEqual(seedState().months[key]);
    expect(await loadState(db, E)).toEqual(eda);
  });

  it('the goals and contributions of the workbook go to whoever uploads it', async () => {
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

  it('with application/json the Excel reader is not used', async () => {
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

  it('ImportError → 400 validation with its message', async () => {
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

  it('any other reader failure is an unreadable file (400), not a 500', async () => {
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

  it('what the reader returns is validated too', async () => {
    parseXlsx.mockReturnValue({ ...payload, months: [{ ...payload.months[0]!, key: 'November 2026' }] });
    const { api, db } = await seeded();
    const res = await upload(api, XLSX_MIME);
    expect(res.status).toBe(400);
    expect(Object.keys((await loadState(db, F)).months)).toEqual(['2026-08', '2026-09', '2026-10']);

    // The goals' plan too: half a plan rejects the file instead of being stored halfway.
    parseXlsx.mockReturnValue({ ...payload, goals: [{ name: 'Trip to Turkey', monthlyUSD: null, start: '2026-08', end: '2027-10' }] });
    const partial = await upload(api, XLSX_MIME);
    expect(partial.status).toBe(400);
    expect(((await partial.json()) as { error: { message: string } }).error.message).toContain('goals.0.monthlyUSD');
    expect((await loadState(db, F)).goals).toEqual(seedState().goals);
  });

  it('more than 10 MB: 413, without ever reading it', async () => {
    const { api } = await seeded();
    const res = await api.raw('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': XLSX_MIME },
      body: new Uint8Array(MAX_IMPORT_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'validation', message: 'The file is too large (maximum 10 MB).' } });
    expect(parseXlsx).not.toHaveBeenCalled();

    // Right at the limit it does reach the reader.
    parseXlsx.mockReturnValue(payload);
    const atLimit = await api.raw('/api/import', { method: 'POST', body: new Uint8Array(MAX_IMPORT_BYTES) });
    expect(atLimit.status).toBe(200);
  });
});
