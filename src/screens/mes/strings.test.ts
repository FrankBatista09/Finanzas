// The strings of the "Month" sheet in the three languages: interpolation, singular and plural, and that no translation
// loses (or invents) a {parameter}. That no key is missing or extra is already checked by the compiler (defineStrings).

import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../../../shared/i18n';
import { createI18n, translator } from '../../i18n';
import type { Entry } from '../../i18n';
import { MES } from './strings';

const en = translator(MES, 'en');
const es = translator(MES, 'es');
const tr = translator(MES, 'tr');

describe('English', () => {
  it('fixed expenses meta line', () => {
    expect(en('fixedMeta', { paid: 6, total: 11 })).toBe('6 of 11 paid · total');
    expect(en('fixedMeta', { paid: 0, total: 0 })).toBe('0 of 0 paid · total');
    expect(en('fixedMeta', { paid: 1, total: 1 })).toBe('1 of 1 paid · total');
  });

  it('history meta line: singular only with 1', () => {
    expect(en('txMeta', { count: 0 })).toBe('0 transactions · total');
    expect(en('txMeta', { count: 1 })).toBe('1 transaction · total');
    expect(en('txMeta', { count: 7 })).toBe('7 transactions · total');
  });

  it('strings with the month or with the row name', () => {
    const { label } = createI18n('en');
    expect(en('closeText', { next: label('2026-11') })).toBe(
      'Closing the month saves this summary and creates November 2026 with the same monthly expenses, not marked as paid.',
    );
    expect(en('paidNamed', { name: 'Netflix' })).toBe('Paid: Netflix');
    expect(en('amountOf', { name: 'Netflix' })).toBe('Amount of Netflix');
    expect(en('deleteTransfer', { date: '02/10' })).toBe('Delete transfer from 02/10');
  });

  it('accounts, transfers and rates', () => {
    expect(en('transfersTitle')).toBe('Transfers');
    expect(en('accountOf', { name: 'Netflix' })).toBe('Account of Netflix');
    expect(en('fromOf', { name: 'Remitly 02/10' })).toBe('Account Remitly 02/10 leaves from');
    expect(en('toOf', { name: 'Remitly 02/10' })).toBe('Account Remitly 02/10 goes to');
    expect(en('rateOf', { name: 'Remitly 02/10' })).toBe('Rate of Remitly 02/10');
    expect(en('pairRate', { from: 'USD', to: 'DOP' })).toBe('Rate USD → DOP');
    expect(en('pairRateSince', { from: 'USD', to: 'DOP', date: '01/10' })).toBe('Rate USD → DOP since 01/10');
    expect(en('deleteRateSince', { from: 'USD', to: 'DOP', date: '01/10' })).toBe('Delete rate USD → DOP of 01/10');
    expect(en('rateSince')).toBe('Since');
    expect(en('newRateDate')).toBe('Date the new rate applies from');
    expect(en('ratesNote')).toBe('A new rate applies from its date on. Earlier transactions keep the rate they had.');
    expect(en('amountsIn', { currency: 'DOP' })).toBe('Amounts in DOP');
  });
});

describe('Spanish: the strings from version 1', () => {
  it('fixed expenses meta line', () => {
    expect(es('fixedMeta', { paid: 6, total: 11 })).toBe('6 de 11 pagados · total');
    expect(es('fixedMeta', { paid: 0, total: 0 })).toBe('0 de 0 pagados · total');
  });

  it('history meta line: singular only with 1', () => {
    expect(es('txMeta', { count: 0 })).toBe('0 transacciones · total');
    expect(es('txMeta', { count: 1 })).toBe('1 transacción · total');
    expect(es('txMeta', { count: 7 })).toBe('7 transacciones · total');
  });

  it('strings with the month or with the row name', () => {
    const { label } = createI18n('es');
    expect(es('closeText', { next: label('2026-11') })).toBe(
      'Al cerrar el mes se guarda este resumen y se crea Noviembre 2026 con los mismos gastos mensuales, sin marcar como pagados.',
    );
    expect(es('paidNamed', { name: 'Luz' })).toBe('Pagado: Luz');
    expect(es('dayOf', { name: 'Claude' })).toBe('Día de Claude');
    expect(es('amountOf', { name: 'Luz' })).toBe('Monto de Luz');
    expect(es('deleteTransfer', { date: '02/10' })).toBe('Eliminar envío del 02/10');
  });

  it('accounts, transfers and rates', () => {
    expect(es('accountOf', { name: 'Luz' })).toBe('Cuenta de Luz');
    expect(es('fromOf', { name: 'Remitly 02/10' })).toBe('Cuenta de la que sale Remitly 02/10');
    expect(es('toOf', { name: 'Remitly 02/10' })).toBe('Cuenta a la que llega Remitly 02/10');
    expect(es('pairRate', { from: 'USD', to: 'DOP' })).toBe('Tasa USD → DOP');
    expect(es('pairRateSince', { from: 'USD', to: 'TRY', date: '06/10' })).toBe('Tasa USD → TRY desde el 06/10');
    expect(es('deleteRateSince', { from: 'USD', to: 'TRY', date: '06/10' })).toBe('Eliminar tasa USD → TRY del 06/10');
    expect(es('rateSince')).toBe('Vigente desde');
    expect(es('newRateDate')).toBe('Fecha desde la que vale la tasa nueva');
    expect(es('ratesNote')).toBe('Una tasa nueva vale desde su fecha. Las transacciones anteriores conservan la que tenían.');
    expect(es('amountsIn', { currency: 'USD' })).toBe('Importes en USD');
  });

  it('titles, columns and notices', () => {
    const keys = ['fixedTitle', 'byCategory', 'transfersTitle', 'txTitle', 'noExpenses', 'closedNote', 'reopen', 'notesOptional'] as const;
    expect(keys.map((key) => es(key))).toEqual([
      'Gastos mensuales fijos',
      'Por categoría',
      'Envíos',
      'Historial de transacciones',
      'Aún no hay gastos este mes.',
      'Mes cerrado. Los registros quedan de solo lectura.',
      'Reabrir mes',
      'Descripción (opcional)',
    ]);
    // In the history, the columns for the transaction's name and for its description (formerly "Descripción" and "Notas").
    expect([es('description'), es('notes')]).toEqual(['Nombre', 'Descripción']);
    expect(es('notesOf', { name: 'Luz' })).toBe('Descripción de Luz');
    expect(es('openNotes', { name: 'Luz' })).toBe('Abrir la descripción de Luz');
    expect(es('closeNotes')).toBe('Cerrar');
  });
});

describe('Turkish', () => {
  it('fixed expenses meta line', () => {
    expect(tr('fixedMeta', { paid: 6, total: 11 })).toBe('6 / 11 ödendi · toplam');
  });

  it('history meta line: the noun does not change with the number', () => {
    expect(tr('txMeta', { count: 1 })).toBe('1 işlem · toplam');
    expect(tr('txMeta', { count: 7 })).toBe('7 işlem · toplam');
  });

  it('strings with the month or with the row name', () => {
    const { label } = createI18n('tr');
    expect(tr('closeText', { next: label('2026-11') })).toBe(
      'Ay kapatıldığında bu özet kaydedilir ve Kasım 2026, aynı aylık giderlerle, ödenmemiş olarak oluşturulur.',
    );
    expect(tr('paidNamed', { name: 'Netflix' })).toBe('Ödendi: Netflix');
    expect(tr('amountOf', { name: 'Netflix' })).toBe('Tutar: Netflix');
    expect(tr('deleteTransfer', { date: '02/10' })).toBe('02/10 tarihli transferi sil');
  });

  it('uses the agreed terms', () => {
    const keys = ['fixedTitle', 'paid', 'description', 'place', 'category', 'method', 'notes', 'reopen'] as const;
    expect(keys.map((key) => tr(key))).toEqual(['Sabit aylık giderler', 'Ödendi', 'Ad', 'Yer', 'Kategori', 'Yöntem', 'Açıklama', 'Ayı yeniden aç']);
    expect(tr('notesOptional')).toBe('Açıklama (isteğe bağlı)');
    expect(tr('openNotes', { name: 'Netflix' })).toBe('Netflix açıklamasını aç');
    expect(tr('closeNotes')).toBe('Kapat');
    expect(tr('transfersTitle')).toBe('Transferler');
    expect(tr('accountOf', { name: 'Netflix' })).toBe('Hesap: Netflix');
    expect(tr('pairRate', { from: 'USD', to: 'TRY' })).toBe('Kur USD → TRY');
    expect(tr('pairRateSince', { from: 'USD', to: 'TRY', date: '06/10' })).toBe('Kur USD → TRY, 06/10 tarihinden itibaren');
    expect(tr('deleteRateSince', { from: 'USD', to: 'TRY', date: '06/10' })).toBe('Kuru sil: USD → TRY, 06/10');
    expect(tr('rateSince')).toBe('Başlangıç');
    expect(tr('newRateDate')).toBe('Yeni kurun geçerli olacağı tarih');
    expect(tr('ratesNote')).toBe('Yeni kur, tarihinden itibaren geçerlidir. Önceki işlemler kendi kurunu korur.');
    expect(tr('amountsIn', { currency: 'TRY' })).toBe('Tutarlar TRY cinsinden');
  });
});

describe('month income', () => {
  it('the card note names the checkbox with the text it has in each language', () => {
    expect(en('incomeNote')).toBe('Money received outside transfers. With "Adds to budget" checked, it also raises this month\'s budget.');
    expect(es('incomeNote')).toBe('Dinero recibido fuera de los envíos. Con «Suma al presupuesto» marcado, sube además el presupuesto de este mes.');
    expect(tr('incomeNote')).toBe('Transferler dışında alınan para. "Bütçeye eklenir" işaretliyse bu ayın bütçesini de artırır.');
    // The checkbox's name is the one from the common strings (its column header).
    for (const lang of ['en', 'es', 'tr'] as const) {
      expect(translator(MES, lang)('incomeNote')).toContain(createI18n(lang).t('addsToBudget'));
    }
  });

  it('the standalone rate that was removed without a date no longer exists: each rate is named with its own', () => {
    expect(Object.keys(MES.en)).not.toContain('deleteRate');
    expect(Object.keys(MES.en)).toEqual(expect.arrayContaining(['pairRate', 'pairRateSince', 'deleteRateSince', 'rateSince', 'ratesNote', 'newRateDate']));
  });
});

describe('the three dictionaries', () => {
  const langs = LANGUAGES.map((l) => l.id);
  const dicts: Record<string, Record<string, Entry>> = MES;
  const forms = (entry: Entry) => (typeof entry === 'string' ? [entry] : [entry.one, entry.other]);
  const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

  it('there is one for each language of the app', () => {
    expect(Object.keys(MES).sort()).toEqual([...langs].sort());
  });

  it('no string is empty or has extra spaces', () => {
    for (const lang of langs) {
      for (const [key, entry] of Object.entries(dicts[lang]!)) {
        for (const text of forms(entry)) expect(text, `${lang}.${key}`).toBe(text.trim());
        for (const text of forms(entry)) expect(text, `${lang}.${key}`).not.toBe('');
      }
    }
  });

  it('each translation uses the same {parameters} as the English', () => {
    for (const [key, entry] of Object.entries(dicts.en!)) {
      const expected = params(forms(entry)[0]!);
      for (const lang of langs) {
        for (const text of forms(dicts[lang]![key]!)) expect(params(text), `${lang}.${key}`).toEqual(expected);
      }
    }
  });

  it('a string with a plural has {count} in both of its forms', () => {
    for (const lang of langs) {
      for (const [key, entry] of Object.entries(dicts[lang]!)) {
        if (typeof entry === 'string') continue;
        expect(entry.one, `${lang}.${key}`).toContain('{count}');
        expect(entry.other, `${lang}.${key}`).toContain('{count}');
      }
    }
  });

  it('Spanish and Turkish are translated: no string stayed the same as in English', () => {
    for (const lang of ['es', 'tr'] as const) {
      const same = Object.keys(dicts.en!).filter((key) => JSON.stringify(dicts[lang]![key]) === JSON.stringify(dicts.en![key]));
      expect(same, lang).toEqual([]);
    }
  });
});
