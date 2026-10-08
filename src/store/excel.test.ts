// El Excel del navegador: lo que descarga "Download Excel" y lo que lee "Import Excel".
// Se prueba en Node con los mismos Blob y File que hay en el navegador.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiErrorCode } from '../../shared/api';
import { buildExportData } from '../../shared/excel/data';
import { buildFinanzasXlsx, excelLocale } from '../../shared/excel/export';
import { ImportError } from '../../shared/excel/import';
import { LANGUAGES } from '../../shared/i18n';
import { seedState } from '../../shared/seed';
import { ApiError, NetworkError } from '../api/client';
import { createI18n } from '../i18n';
import { excelBlob, excelFilename, readExcel } from './excel';
import { describeError } from './util';

const REFERENCE = new Uint8Array(readFileSync(new URL('../../design_handoff/referencia/Finanzas Personales v3.xlsx', import.meta.url)));
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const bytes = async (blob: Blob) => Buffer.from(await blob.arrayBuffer());

describe('excelBlob', () => {
  // El libro sigue con el diseño original (USD, DOP y dos cuentas): lo que entra al generador es el estado pasado
  // por el puente de shared/excel/data.ts. Que el generador reproduce el libro de referencia y qué proyecta el
  // puente se prueba allí; aquí, que la descarga de la web es exactamente eso, en el idioma del usuario.
  it('es, byte a byte, el libro que genera shared/excel con buildExportData(state) y el idioma del usuario', async () => {
    for (const { id: language } of LANGUAGES) {
      const state = { ...seedState(), language };
      const blob = excelBlob(state);
      expect(blob.type, language).toBe(XLSX_MIME);
      const direct = buildFinanzasXlsx(buildExportData(state), { locale: excelLocale(language) });
      expect((await bytes(blob)).equals(Buffer.from(direct)), language).toBe(true);
    }
    // Un .xlsx es un zip.
    expect((await bytes(excelBlob(seedState()))).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('cambia con el estado: otra moneda principal no cambia el libro, un gasto nuevo sí', async () => {
    const base = await bytes(excelBlob(seedState()));
    // El libro es siempre USD y DOP: las monedas en las que el usuario ve la app no entran en él.
    expect((await bytes(excelBlob({ ...seedState(), mainCurrency: 'USD', secondCurrency: 'DOP' }))).equals(base)).toBe(true);
    const more = seedState();
    more.months['2026-10']!.tx.push({ ...more.months['2026-10']!.tx[0]!, id: 'extra', desc: 'One more coffee' });
    expect((await bytes(excelBlob(more))).equals(base)).toBe(false);
  });

  it('el libro sale en el idioma del usuario', async () => {
    const en = await bytes(excelBlob(seedState()));
    const tr = await bytes(excelBlob({ ...seedState(), language: 'tr' }));
    const es = await bytes(excelBlob({ ...seedState(), language: 'es' }));
    expect(en.equals(tr)).toBe(false);
    expect(en.equals(es)).toBe(false);
    // Las hojas van sin comprimir: sus nombres se leen tal cual en el archivo.
    expect(en.includes('October 2026')).toBe(true);
    expect(es.includes('Octubre 2026')).toBe(true);
    expect(tr.includes('Ekim 2026')).toBe(true);
    expect(en.includes('Octubre 2026')).toBe(false);
  });

  it('el archivo lleva el nombre del usuario', () => {
    const name = excelFilename({ id: 'eda', name: 'Eda' });
    expect(name).toMatch(/\.xlsx$/);
    expect(name).toContain('Eda');
    expect(name).toContain('FE Finance');
    expect(excelFilename({ id: 'frank', name: 'Frank' })).not.toBe(name);
  });
});

describe('readExcel', () => {
  it('lee el archivo elegido por el usuario y devuelve lo que espera POST /api/import', async () => {
    const file = new File([REFERENCE], 'Finanzas Personales v3.xlsx', { type: XLSX_MIME });
    const payload = await readExcel(file);
    expect(payload.months.map((m) => [m.key, m.closed])).toEqual([
      ['2026-08', true],
      ['2026-09', true],
      ['2026-10', false],
    ]);
    expect(payload.months[2]!.tx).toHaveLength(7);
    expect(payload.contribs).toHaveLength(8);
    // Las metas del libro, con su plan: la web solo las pasa al servidor. Este libro es de la versión 1 (en
    // español, con sus tres metas fijas) y el lector ya las trae con el nombre que tienen hoy.
    expect(payload.goals).toEqual([
      { name: 'Emergency fund', monthlyUSD: null, start: null, end: null },
      { name: 'Personal savings', monthlyUSD: null, start: null, end: null },
      { name: 'Trip to Turkey', monthlyUSD: 3000, start: '2026-08', end: '2027-10' },
    ]);
  });

  it('lo que se descarga se puede volver a cargar, en cualquier idioma', async () => {
    for (const { id: language } of LANGUAGES) {
      const seed = { ...seedState(), language };
      // Lo que el libro lleva dentro: el estado proyectado a su formato (dos monedas, dos saldos por mes).
      const book = buildExportData(seed).months.find((m) => m.key === '2026-10')!;
      const payload = await readExcel(excelBlob(seed));
      const oct = payload.months.find((m) => m.key === '2026-10')!;
      expect(oct.fixed, language).toEqual(seed.months['2026-10']!.fixed.map(({ name, day, amount, cur, paid }) => ({ name, day, amount, cur, paid })));
      // Los saldos del libro son los de la app (shared/calc balances): 13,482 USD y 220,641.93 DOP.
      expect(oct.accounts.usd, language).toBeCloseTo(book.accounts.usd!, 6);
      expect(oct.accounts.dop, language).toBeCloseTo(book.accounts.dop!, 6);
      expect(oct.accounts.usd, language).toBeCloseTo(13482, 6);
      expect(oct.accounts.dop, language).toBeCloseTo(220641.93, 6);
      expect(oct.budget, language).toBe(70000);
      expect(oct.incomeUSD, language).toBe(5800);
      // Categorías y métodos vuelven con su nombre canónico, sea cual sea el idioma del libro.
      expect(oct.tx.map((t) => [t.cat, t.method]).sort(), language).toEqual(seed.months['2026-10']!.tx.map((t) => [t.cat, t.method]).sort());
      expect(payload.goals?.map((g) => g.name), language).toEqual(seed.goals.map((g) => g.name));
    }
  });

  it('un archivo que no es un .xlsx: ImportError con su código, y al usuario se le dice en su idioma', async () => {
    const error: unknown = await readExcel(new File(['this is not an excel file'], 'notes.xlsx')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).code).toBe('not_xlsx');
    // El mensaje del lector va siempre en inglés (como los de la API): la web traduce por el código.
    expect(describeError(error, createI18n('en').t)).toBe('The file is not an Excel workbook (.xlsx).');
    expect(describeError(error, createI18n('es').t)).toBe('El archivo no es un libro de Excel (.xlsx).');
    expect(describeError(error, createI18n('tr').t)).toBe('Dosya bir Excel çalışma kitabı (.xlsx) değil.');
  });

  it('cada motivo del lector de Excel tiene su frase en los tres idiomas, y la del formato nombra la app', () => {
    const codes = ['not_xlsx', 'old_format', 'too_large', 'damaged', 'no_month_sheets', 'unreadable'] as const;
    for (const { id } of LANGUAGES) {
      const phrases = codes.map((code) => describeError(new ImportError('in English', { code }), createI18n(id).t));
      expect(new Set(phrases).size, id).toBe(codes.length);
      for (const phrase of phrases) expect(phrase, id).not.toContain('in English');
    }
    // Un zip que no es un libro de la app: ninguna hoja de mes.
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

  it('sin respuesta del servidor', () => {
    expect(describeError(new NetworkError(), en)).toBe('Could not reach the server.');
    expect(describeError(new NetworkError(), es)).toBe('No se pudo conectar con el servidor.');
    expect(describeError(new NetworkError(), tr)).toBe('Sunucuya ulaşılamadı.');
  });

  it('los errores de la API se traducen por su código: el mensaje del servidor (en inglés) no se enseña', () => {
    const closed = new ApiError(409, 'month_closed', 'October 2026 is closed.');
    expect(describeError(closed, en)).toBe('The month is closed and its records are read-only.');
    expect(describeError(closed, es)).toBe('El mes está cerrado y sus registros son de solo lectura.');
    expect(describeError(closed, tr)).toBe('Ay kapalı; kayıtları salt okunur.');
    expect(describeError(new ApiError(404, 'not_found', 'Goal not found'), es)).toBe('Ese registro ya no existe.');
  });

  it('cada código tiene su frase, distinta, en los tres idiomas', () => {
    for (const t of [en, es, tr]) {
      const phrases = CODES.map((code) => describeError(new ApiError(400, code, ''), t));
      expect(new Set(phrases).size).toBe(CODES.length);
      for (const phrase of phrases) expect(phrase).not.toBe(t('errorUnexpected'));
    }
  });

  it('en los de validación el mensaje del servidor va como detalle: dice qué dato estaba mal', () => {
    const bad = new ApiError(400, 'validation', 'months.2.tx.3.amount: must not be negative');
    expect(describeError(bad, en)).toBe('The data is not valid: months.2.tx.3.amount: must not be negative');
    expect(describeError(bad, es)).toBe('Los datos no son válidos: months.2.tx.3.amount: must not be negative');
    expect(describeError(bad, tr)).toBe('Veriler geçerli değil: months.2.tx.3.amount: must not be negative');
    expect(describeError(new ApiError(400, 'validation', ''), es)).toBe('Los datos no son válidos.');
  });

  it('un código que este cliente no conoce no rompe: frase genérica', () => {
    expect(describeError(new ApiError(418, 'teapot' as ApiErrorCode, 'x'), en)).toBe('An unexpected error occurred.');
  });

  it('no enseña mensajes que no estén pensados para el usuario', () => {
    expect(describeError(new TypeError('x is not a function'), en)).toBe('An unexpected error occurred.');
    expect(describeError(new TypeError('x is not a function'), es)).toBe('Ocurrió un error inesperado.');
    expect(describeError('boom', tr)).toBe('Beklenmeyen bir hata oluştu.');
  });
});
