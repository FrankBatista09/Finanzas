// Excel in the browser: what "Download Excel" downloads and what "Import Excel" reads.
// Tested in Node with the same Blob and File the browser has.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiErrorCode } from '../../shared/api';
import { buildExportData } from '../../shared/excel/data';
import { buildFinanzasXlsx, excelLocale } from '../../shared/excel/export';
import { readBook } from '../../shared/excel/export-testkit';
import { ImportError } from '../../shared/excel/import';
import { LANGUAGES } from '../../shared/i18n';
import { seedState } from '../../shared/seed';
import type { MonthKey } from '../../shared/types';
import { ApiError, NetworkError } from '../api/client';
import { createI18n } from '../i18n';
import { excelBlob, excelFilename, readExcel } from './excel';
import { describeError } from './util';

const REFERENCE = new Uint8Array(readFileSync(new URL('../../design_handoff/referencia/Finanzas Personales v3.xlsx', import.meta.url)));
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const bytes = async (blob: Blob) => Buffer.from(await blob.arrayBuffer());

describe('excelBlob', () => {
  // The workbook keeps the original design (USD, DOP and two accounts): what goes into the generator is the state run
  // through the bridge in shared/excel/data.ts. That the generator reproduces the reference workbook, and what the
  // bridge projects, is tested there; here, that the web download is exactly that, in the user's language.
  it("is, byte for byte, the workbook shared/excel builds with buildExportData(state) and the user's language", async () => {
    for (const { id: language } of LANGUAGES) {
      const state = { ...seedState(), language };
      const blob = excelBlob(state);
      expect(blob.type, language).toBe(XLSX_MIME);
      const direct = buildFinanzasXlsx(buildExportData(state), { locale: excelLocale(language) });
      expect((await bytes(blob)).equals(Buffer.from(direct)), language).toBe(true);
    }
    // An .xlsx is a zip.
    expect((await bytes(excelBlob(seedState()))).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('changes with the state: another main currency does not change the workbook, a new expense does', async () => {
    const base = await bytes(excelBlob(seedState()));
    // The workbook is always USD and DOP: the currencies the user sees the app in do not go into it.
    expect((await bytes(excelBlob({ ...seedState(), mainCurrency: 'USD', secondCurrency: 'DOP' }))).equals(base)).toBe(true);
    const more = seedState();
    more.months['2026-10']!.tx.push({ ...more.months['2026-10']!.tx[0]!, id: 'extra', desc: 'One more coffee' });
    expect((await bytes(excelBlob(more))).equals(base)).toBe(false);
  });

  it("the workbook comes out in the user's language", async () => {
    const en = await bytes(excelBlob(seedState()));
    const tr = await bytes(excelBlob({ ...seedState(), language: 'tr' }));
    const es = await bytes(excelBlob({ ...seedState(), language: 'es' }));
    expect(en.equals(tr)).toBe(false);
    expect(en.equals(es)).toBe(false);
    // The sheets are stored uncompressed: their names can be read as is in the file.
    expect(en.includes('October 2026')).toBe(true);
    expect(es.includes('Octubre 2026')).toBe(true);
    expect(tr.includes('Ekim 2026')).toBe(true);
    expect(en.includes('Octubre 2026')).toBe(false);
  });

  describe('with chosen months', () => {
    const book = async (blob: Blob) => readBook(new Uint8Array(await blob.arrayBuffer()));
    /** What each cell of the sheet holds: value and formula (the style index depends on the rest of the workbook). */
    const content = (sheet: { cells: Map<string, { formula: string | null; value: unknown }> }) =>
      [...sheet.cells].map(([ref, c]) => [ref, c.formula, c.value]);

    it('the workbook carries only the sheets of those months, plus savings and Config', async () => {
      const names = async (months?: Parameters<typeof excelBlob>[1]) => (await book(excelBlob(seedState(), months))).sheets.map((x) => x.name);
      expect(await names()).toEqual(['August 2026', 'September 2026', 'October 2026', 'Savings', 'Config']);
      expect(await names(['2026-09'])).toEqual(['September 2026', 'Savings', 'Config']);
      expect(await names(['2026-08', '2026-10'])).toEqual(['August 2026', 'October 2026', 'Savings', 'Config']);
      // The order of the selection does not matter: the sheets always go from the oldest to the most recent.
      expect(await names(['2026-10', '2026-08'])).toEqual(['August 2026', 'October 2026', 'Savings', 'Config']);
      // A month the user does not have does not make up a sheet.
      expect(await names(['2026-10', '2027-01'])).toEqual(['October 2026', 'Savings', 'Config']);
    });

    it('with all the months chosen it is, byte for byte, the full workbook', async () => {
      const full = await bytes(excelBlob(seedState()));
      expect((await bytes(excelBlob(seedState(), ['2026-08', '2026-09', '2026-10']))).equals(full)).toBe(true);
      expect((await bytes(excelBlob(seedState(), ['2026-09', '2026-10']))).equals(full)).toBe(false);
    });

    it('the figures of a month do not change by leaving the others out: they come from the whole history', async () => {
      for (const { id: language } of LANGUAGES) {
        const state = { ...seedState(), language };
        const data = buildExportData(state);
        const full = await book(excelBlob(state));
        for (const keys of [['2026-10'], ['2026-09'], ['2026-08', '2026-10']] as MonthKey[][]) {
          const blob = excelBlob(state, keys);
          // It is the shared/excel workbook with the full data, minus the months that were not chosen.
          const direct = buildFinanzasXlsx({ ...data, months: data.months.filter((m) => keys.includes(m.key)) }, { locale: excelLocale(language) });
          expect((await bytes(blob)).equals(Buffer.from(direct)), `${language} ${keys.join()}`).toBe(true);
          // Each sheet that remains is, cell by cell, the one in the full workbook.
          const part = await book(blob);
          const months = part.sheets.slice(0, -2);
          expect(months).toHaveLength(keys.length);
          for (const sheet of months) expect(content(sheet), `${language} ${sheet.name}`).toEqual(content(full.sheet(sheet.name)));
        }
      }
    });

    it('the October balances still carry August and September even when they are not in the workbook', async () => {
      const state = seedState();
      const only = await readExcel(excelBlob(state, ['2026-10']));
      expect(only.months.map((m) => m.key)).toEqual(['2026-10']);
      const all = await readExcel(excelBlob(state));
      expect(only.months[0]).toEqual(all.months.find((m) => m.key === '2026-10'));
      expect(only.months[0]!.accounts.usd).toBeCloseTo(13482, 6);
      expect(only.months[0]!.accounts.dop).toBeCloseTo(220641.93, 2);
      // An August expense, which is not in the workbook, still lowers the balance October starts with.
      const less = seedState();
      less.months['2026-08']!.tx.push({ ...less.months['2026-08']!.tx[0]!, id: 'extra', amount: 1000, cur: 'DOP', accountId: 'dr' });
      const after = await readExcel(excelBlob(less, ['2026-10']));
      expect(after.months[0]!.accounts.dop).toBeCloseTo(only.months[0]!.accounts.dop! - 1000, 6);
      // The goals and all the contributions always go in, including those of the months that were not chosen.
      expect(only.goals).toEqual(all.goals);
      expect(only.contribs).toEqual(all.contribs);
      expect(only.contribs).toHaveLength(8);
    });

    it('does not modify the state or what buildExportData returns for the full workbook', async () => {
      const state = seedState();
      const before = JSON.stringify(state);
      const full = await bytes(excelBlob(state));
      excelBlob(state, ['2026-09']);
      expect(JSON.stringify(state)).toBe(before);
      expect((await bytes(excelBlob(state))).equals(full)).toBe(true);
    });

    it('the current month in Config is the last of the chosen ones', async () => {
      const config = (await book(excelBlob(seedState(), ['2026-08', '2026-09']))).sheet('Config');
      expect(config.cells.get('C5')?.value).toBe('September 2026');
    });
  });

  it("the file carries the user's name", () => {
    const name = excelFilename({ id: 'eda', name: 'Eda' });
    expect(name).toMatch(/\.xlsx$/);
    expect(name).toContain('Eda');
    expect(name).toContain('FE Finance');
    expect(excelFilename({ id: 'frank', name: 'Frank' })).not.toBe(name);
  });
});

describe('readExcel', () => {
  it('reads the file the user chose and returns what POST /api/import expects', async () => {
    const file = new File([REFERENCE], 'Finanzas Personales v3.xlsx', { type: XLSX_MIME });
    const payload = await readExcel(file);
    expect(payload.months.map((m) => [m.key, m.closed])).toEqual([
      ['2026-08', true],
      ['2026-09', true],
      ['2026-10', false],
    ]);
    expect(payload.months[2]!.tx).toHaveLength(7);
    expect(payload.contribs).toHaveLength(8);
    // The workbook's goals, with their plan: the web only passes them on to the server. This workbook is from version 1
    // (in Spanish, with its three fixed goals) and the reader already brings them with the name they have today.
    expect(payload.goals).toEqual([
      { name: 'Emergency fund', monthlyUSD: null, start: null, end: null },
      { name: 'Personal savings', monthlyUSD: null, start: null, end: null },
      { name: 'Trip to Turkey', monthlyUSD: 3000, start: '2026-08', end: '2027-10' },
    ]);
  });

  it('what is downloaded can be loaded again, in any language', async () => {
    for (const { id: language } of LANGUAGES) {
      const seed = { ...seedState(), language };
      // What the workbook holds: the state projected to its format (two currencies, two balances per month).
      const book = buildExportData(seed).months.find((m) => m.key === '2026-10')!;
      const payload = await readExcel(excelBlob(seed));
      const oct = payload.months.find((m) => m.key === '2026-10')!;
      expect(oct.fixed, language).toEqual(seed.months['2026-10']!.fixed.map(({ name, day, amount, cur, paid }) => ({ name, day, amount, cur, paid })));
      // The workbook's balances are the app's (shared/calc balances): 13,482 USD and 220,641.93 DOP.
      expect(oct.accounts.usd, language).toBeCloseTo(book.accounts.usd!, 6);
      expect(oct.accounts.dop, language).toBeCloseTo(book.accounts.dop!, 6);
      expect(oct.accounts.usd, language).toBeCloseTo(13482, 6);
      expect(oct.accounts.dop, language).toBeCloseTo(220641.93, 6);
      expect(oct.budget, language).toBe(70000);
      expect(oct.incomeUSD, language).toBe(5800);
      // Categories and methods come back with their canonical name, whatever the workbook's language.
      expect(oct.tx.map((t) => [t.cat, t.method]).sort(), language).toEqual(seed.months['2026-10']!.tx.map((t) => [t.cat, t.method]).sort());
      expect(payload.goals?.map((g) => g.name), language).toEqual(seed.goals.map((g) => g.name));
    }
  });

  it('a file that is not an .xlsx: ImportError with its code, and the user is told in their language', async () => {
    const error: unknown = await readExcel(new File(['this is not an excel file'], 'notes.xlsx')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).code).toBe('not_xlsx');
    // The reader's message is always in English (like the API's): the web translates by the code.
    expect(describeError(error, createI18n('en').t)).toBe('The file is not an Excel workbook (.xlsx).');
    expect(describeError(error, createI18n('es').t)).toBe('El archivo no es un libro de Excel (.xlsx).');
    expect(describeError(error, createI18n('tr').t)).toBe('Dosya bir Excel çalışma kitabı (.xlsx) değil.');
  });

  it('each Excel reader reason has its phrase in the three languages, and the format one names the app', () => {
    const codes = ['not_xlsx', 'old_format', 'too_large', 'damaged', 'no_month_sheets', 'unreadable'] as const;
    for (const { id } of LANGUAGES) {
      const phrases = codes.map((code) => describeError(new ImportError('in English', { code }), createI18n(id).t));
      expect(new Set(phrases).size, id).toBe(codes.length);
      for (const phrase of phrases) expect(phrase, id).not.toContain('in English');
    }
    // A zip that is not a workbook of the app: no month sheets.
    expect(describeError(new ImportError('x', { code: 'no_month_sheets' }), createI18n('es').t)).toBe(
      'El archivo no tiene el formato de FE Finance: no tiene hojas de mes.',
    );
  });
});

describe('describeError', () => {
  const en = createI18n('en').t;
  const es = createI18n('es').t;
  const tr = createI18n('tr').t;
  const CODES: ApiErrorCode[] = ['validation', 'not_found', 'month_closed', 'conflict', 'unauthorized', 'forbidden', 'internal'];

  it('no response from the server', () => {
    expect(describeError(new NetworkError(), en)).toBe('Could not reach the server.');
    expect(describeError(new NetworkError(), es)).toBe('No se pudo conectar con el servidor.');
    expect(describeError(new NetworkError(), tr)).toBe('Sunucuya ulaşılamadı.');
  });

  it('API errors are translated by their code: the server message (in English) is not shown', () => {
    const closed = new ApiError(409, 'month_closed', 'October 2026 is closed.');
    expect(describeError(closed, en)).toBe('The month is closed and its records are read-only.');
    expect(describeError(closed, es)).toBe('El mes está cerrado y sus registros son de solo lectura.');
    expect(describeError(closed, tr)).toBe('Ay kapalı; kayıtları salt okunur.');
    expect(describeError(new ApiError(404, 'not_found', 'Goal not found'), es)).toBe('Ese registro ya no existe.');
  });

  it('each code has its own, distinct phrase in the three languages', () => {
    for (const t of [en, es, tr]) {
      const phrases = CODES.map((code) => describeError(new ApiError(400, code, ''), t));
      expect(new Set(phrases).size).toBe(CODES.length);
      for (const phrase of phrases) expect(phrase).not.toBe(t('errorUnexpected'));
    }
  });

  it('in validation errors the server message goes as the detail: it says which value was wrong', () => {
    const bad = new ApiError(400, 'validation', 'months.2.tx.3.amount: must not be negative');
    expect(describeError(bad, en)).toBe('The data is not valid: months.2.tx.3.amount: must not be negative');
    expect(describeError(bad, es)).toBe('Los datos no son válidos: months.2.tx.3.amount: must not be negative');
    expect(describeError(bad, tr)).toBe('Veriler geçerli değil: months.2.tx.3.amount: must not be negative');
    expect(describeError(new ApiError(400, 'validation', ''), es)).toBe('Los datos no son válidos.');
  });

  it('a code this client does not know does not break: generic phrase', () => {
    expect(describeError(new ApiError(418, 'teapot' as ApiErrorCode, 'x'), en)).toBe('An unexpected error occurred.');
  });

  it('does not show messages that are not meant for the user', () => {
    expect(describeError(new TypeError('x is not a function'), en)).toBe('An unexpected error occurred.');
    expect(describeError(new TypeError('x is not a function'), es)).toBe('Ocurrió un error inesperado.');
    expect(describeError('boom', tr)).toBe('Beklenmeyen bir hata oluştu.');
  });
});
