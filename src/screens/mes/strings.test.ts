// Los textos de la hoja "Mes" en los tres idiomas: interpolación, singular y plural, y que ninguna traducción
// pierda (o invente) un {parámetro}. Que no falte ni sobre una clave ya lo vigila el compilador (defineStrings).

import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../../../shared/i18n';
import { createI18n, translator } from '../../i18n';
import type { Entry } from '../../i18n';
import { MES } from './strings';

const en = translator(MES, 'en');
const es = translator(MES, 'es');
const tr = translator(MES, 'tr');

describe('inglés', () => {
  it('meta de los gastos mensuales', () => {
    expect(en('fixedMeta', { paid: 6, total: 11 })).toBe('6 of 11 paid · total');
    expect(en('fixedMeta', { paid: 0, total: 0 })).toBe('0 of 0 paid · total');
    expect(en('fixedMeta', { paid: 1, total: 1 })).toBe('1 of 1 paid · total');
  });

  it('meta del historial: singular solo con 1', () => {
    expect(en('txMeta', { count: 0 })).toBe('0 transactions · total');
    expect(en('txMeta', { count: 1 })).toBe('1 transaction · total');
    expect(en('txMeta', { count: 7 })).toBe('7 transactions · total');
  });

  it('textos con el mes o con el nombre de la fila', () => {
    const { label } = createI18n('en');
    expect(en('closeText', { next: label('2026-11') })).toBe(
      'Closing the month saves this summary and creates November 2026 with the same monthly expenses, not marked as paid.',
    );
    expect(en('paidNamed', { name: 'Netflix' })).toBe('Paid: Netflix');
    expect(en('amountOf', { name: 'Netflix' })).toBe('Amount of Netflix');
    expect(en('deleteTransfer', { date: '02/10' })).toBe('Delete transfer from 02/10');
  });

  it('cuentas, envíos y tasas', () => {
    expect(en('transfersTitle')).toBe('Transfers');
    expect(en('accountOf', { name: 'Netflix' })).toBe('Account of Netflix');
    expect(en('fromOf', { name: 'Remitly 02/10' })).toBe('Account Remitly 02/10 leaves from');
    expect(en('toOf', { name: 'Remitly 02/10' })).toBe('Account Remitly 02/10 goes to');
    expect(en('rateOf', { name: 'Remitly 02/10' })).toBe('Rate of Remitly 02/10');
    expect(en('pairRate', { from: 'USD', to: 'DOP' })).toBe('Rate USD → DOP');
    expect(en('deleteRate', { from: 'USD', to: 'DOP' })).toBe('Delete rate USD → DOP');
    expect(en('amountsIn', { currency: 'DOP' })).toBe('Amounts in DOP');
  });
});

describe('español: los textos de la versión 1', () => {
  it('meta de los gastos mensuales', () => {
    expect(es('fixedMeta', { paid: 6, total: 11 })).toBe('6 de 11 pagados · total');
    expect(es('fixedMeta', { paid: 0, total: 0 })).toBe('0 de 0 pagados · total');
  });

  it('meta del historial: singular solo con 1', () => {
    expect(es('txMeta', { count: 0 })).toBe('0 transacciones · total');
    expect(es('txMeta', { count: 1 })).toBe('1 transacción · total');
    expect(es('txMeta', { count: 7 })).toBe('7 transacciones · total');
  });

  it('textos con el mes o con el nombre de la fila', () => {
    const { label } = createI18n('es');
    expect(es('closeText', { next: label('2026-11') })).toBe(
      'Al cerrar el mes se guarda este resumen y se crea Noviembre 2026 con los mismos gastos mensuales, sin marcar como pagados.',
    );
    expect(es('paidNamed', { name: 'Luz' })).toBe('Pagado: Luz');
    expect(es('dayOf', { name: 'Claude' })).toBe('Día de Claude');
    expect(es('amountOf', { name: 'Luz' })).toBe('Monto de Luz');
    expect(es('deleteTransfer', { date: '02/10' })).toBe('Eliminar envío del 02/10');
  });

  it('cuentas, envíos y tasas', () => {
    expect(es('accountOf', { name: 'Luz' })).toBe('Cuenta de Luz');
    expect(es('fromOf', { name: 'Remitly 02/10' })).toBe('Cuenta de la que sale Remitly 02/10');
    expect(es('toOf', { name: 'Remitly 02/10' })).toBe('Cuenta a la que llega Remitly 02/10');
    expect(es('pairRate', { from: 'USD', to: 'DOP' })).toBe('Tasa USD → DOP');
    expect(es('deleteRate', { from: 'USD', to: 'TRY' })).toBe('Eliminar tasa USD → TRY');
    expect(es('amountsIn', { currency: 'USD' })).toBe('Importes en USD');
  });

  it('títulos, columnas y avisos', () => {
    const keys = ['fixedTitle', 'byCategory', 'transfersTitle', 'txTitle', 'noExpenses', 'closedNote', 'reopen', 'notesOptional'] as const;
    expect(keys.map((key) => es(key))).toEqual([
      'Gastos mensuales',
      'Por categoría',
      'Envíos',
      'Historial de transacciones',
      'Aún no hay gastos este mes.',
      'Mes cerrado. Los registros quedan de solo lectura.',
      'Reabrir mes',
      'Notas (opcional)',
    ]);
  });
});

describe('turco', () => {
  it('meta de los gastos mensuales', () => {
    expect(tr('fixedMeta', { paid: 6, total: 11 })).toBe('6 / 11 ödendi · toplam');
  });

  it('meta del historial: el sustantivo no cambia con el número', () => {
    expect(tr('txMeta', { count: 1 })).toBe('1 işlem · toplam');
    expect(tr('txMeta', { count: 7 })).toBe('7 işlem · toplam');
  });

  it('textos con el mes o con el nombre de la fila', () => {
    const { label } = createI18n('tr');
    expect(tr('closeText', { next: label('2026-11') })).toBe(
      'Ay kapatıldığında bu özet kaydedilir ve Kasım 2026, aynı aylık giderlerle, ödenmemiş olarak oluşturulur.',
    );
    expect(tr('paidNamed', { name: 'Netflix' })).toBe('Ödendi: Netflix');
    expect(tr('amountOf', { name: 'Netflix' })).toBe('Tutar: Netflix');
    expect(tr('deleteTransfer', { date: '02/10' })).toBe('02/10 tarihli transferi sil');
  });

  it('usa los términos acordados', () => {
    const keys = ['fixedTitle', 'paid', 'description', 'place', 'category', 'method', 'notes', 'reopen'] as const;
    expect(keys.map((key) => tr(key))).toEqual(['Aylık giderler', 'Ödendi', 'Açıklama', 'Yer', 'Kategori', 'Yöntem', 'Notlar', 'Ayı yeniden aç']);
    expect(tr('transfersTitle')).toBe('Transferler');
    expect(tr('accountOf', { name: 'Netflix' })).toBe('Hesap: Netflix');
    expect(tr('pairRate', { from: 'USD', to: 'TRY' })).toBe('Kur USD → TRY');
    expect(tr('deleteRate', { from: 'USD', to: 'TRY' })).toBe('USD → TRY kurunu sil');
    expect(tr('amountsIn', { currency: 'TRY' })).toBe('Tutarlar TRY cinsinden');
  });
});

describe('los tres diccionarios', () => {
  const langs = LANGUAGES.map((l) => l.id);
  const dicts: Record<string, Record<string, Entry>> = MES;
  const forms = (entry: Entry) => (typeof entry === 'string' ? [entry] : [entry.one, entry.other]);
  const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

  it('hay uno por cada idioma de la app', () => {
    expect(Object.keys(MES).sort()).toEqual([...langs].sort());
  });

  it('ningún texto está vacío ni lleva espacios sobrantes', () => {
    for (const lang of langs) {
      for (const [key, entry] of Object.entries(dicts[lang]!)) {
        for (const text of forms(entry)) expect(text, `${lang}.${key}`).toBe(text.trim());
        for (const text of forms(entry)) expect(text, `${lang}.${key}`).not.toBe('');
      }
    }
  });

  it('cada traducción usa los mismos {parámetros} que el inglés', () => {
    for (const [key, entry] of Object.entries(dicts.en!)) {
      const expected = params(forms(entry)[0]!);
      for (const lang of langs) {
        for (const text of forms(dicts[lang]![key]!)) expect(params(text), `${lang}.${key}`).toEqual(expected);
      }
    }
  });

  it('un texto con plural lleva {count} en sus dos formas', () => {
    for (const lang of langs) {
      for (const [key, entry] of Object.entries(dicts[lang]!)) {
        if (typeof entry === 'string') continue;
        expect(entry.one, `${lang}.${key}`).toContain('{count}');
        expect(entry.other, `${lang}.${key}`).toContain('{count}');
      }
    }
  });

  it('español y turco están traducidos: ningún texto se quedó igual que en inglés', () => {
    for (const lang of ['es', 'tr'] as const) {
      const same = Object.keys(dicts.en!).filter((key) => JSON.stringify(dicts[lang]![key]) === JSON.stringify(dicts.en![key]));
      expect(same, lang).toEqual([]);
    }
  });
});
