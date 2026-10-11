import { describe, expect, it } from 'vitest';
import { rateFor } from '../../shared/calc';
import type { RateInfo } from '../../shared/calc';
import { METHODS } from '../../shared/constants';
import { canonicalMethod, LANGUAGES } from '../../shared/i18n';
import { seedState } from '../../shared/seed';
import type { Language } from '../../shared/types';
import { CORE, createI18n } from './core';
import { defineStrings, interpolate, translator } from './define';
import type { Entry } from './define';

const LANGS = LANGUAGES.map((l) => l.id);
const dict = (lang: Language): Record<string, Entry> => CORE[lang];
const texts = (entry: Entry) => (typeof entry === 'string' ? [entry] : [entry.one, entry.other]);
const placeholders = (entry: Entry) => [...new Set(texts(entry).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();

describe('common dictionaries', () => {
  it('there is one for each language of the app', () => {
    expect(Object.keys(CORE).sort()).toEqual([...LANGS].sort());
  });

  it('all three have exactly the same keys', () => {
    const keys = Object.keys(dict('en')).sort();
    expect(keys.length).toBeGreaterThan(80);
    for (const lang of LANGS) expect(Object.keys(dict(lang)).sort(), lang).toEqual(keys);
  });

  it('no string is empty or has extra spaces', () => {
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(dict(lang))) {
        for (const text of texts(entry)) {
          expect(text.trim(), `${lang}.${key}`).not.toBe('');
          expect(text, `${lang}.${key}`).toBe(text.trim());
        }
      }
    }
  });

  it('each key uses the same {parameters} in all three languages', () => {
    for (const [key, entry] of Object.entries(dict('en'))) {
      for (const lang of LANGS) expect(placeholders(dict(lang)[key]!), `${lang}.${key}`).toEqual(placeholders(entry));
    }
  });

  it('a key with a plural has one in all three languages', () => {
    for (const [key, entry] of Object.entries(dict('en'))) {
      for (const lang of LANGS) expect(typeof dict(lang)[key], `${lang}.${key}`).toBe(typeof entry);
    }
  });

  it('Spanish keeps the strings of version 1 and English follows the glossary', () => {
    const es = translator(CORE, 'es');
    expect(es('importExcel')).toBe('Cargar Excel');
    expect(es('subtitleCurrent')).toBe('Mes en curso');
    expect(es('availableAfterFixed')).toBe('Disponible tras fijos pendientes');
    expect(es('closeWithExcel')).toBe('Sí, agregar al Excel');
    const en = translator(CORE, 'en');
    expect(en('importExcel')).toBe('Import Excel');
    expect(en('subtitleClosed')).toBe('Month summary');
    expect(en('availableAfterFixed')).toBe('Available after pending fixed');
    expect(en('themeReset')).toBe('Reset to default');
    expect(en('saveFailed')).toBe('Could not save. The change was undone.');
  });

  it('Turkish uses the agreed terms', () => {
    const tr = translator(CORE, 'tr');
    expect([tr('month'), tr('savings'), tr('subtitleCurrent'), tr('subtitleClosed')]).toEqual(['Ay', 'Birikimler', 'Bu ay', 'Ay özeti']);
    expect([tr('totalMoney'), tr('budget'), tr('account'), tr('balance'), tr('used'), tr('available')]).toEqual([
      'Toplam para',
      'Bütçe',
      'Hesap',
      'Bakiye',
      'Kullanılan',
      'Kalan',
    ]);
    expect([tr('add'), tr('delete'), tr('cancel'), tr('save'), tr('edit')]).toEqual(['Ekle', 'Sil', 'İptal', 'Kaydet', 'Düzenle']);
    expect([tr('settings'), tr('language'), tr('appearance')]).toEqual(['Ayarlar', 'Dil', 'Görünüm']);
    expect([tr('importExcel'), tr('downloadExcel')]).toEqual(['Excel içe aktar', 'Excel indir']);
    expect(tr('closeMonth', { month: 'Ekim 2026' })).toBe('Ekim 2026 ayını kapat');
    expect(tr('monthClosedOption', { month: 'Ekim 2026' })).toBe('Ekim 2026 · kapalı');
  });
});

describe('glossary of the accounts and currencies model', () => {
  const en = translator(CORE, 'en');
  const es = translator(CORE, 'es');
  const tr = translator(CORE, 'tr');

  it('English: the glossary terms, as is', () => {
    expect([en('budget'), en('accounts'), en('account'), en('addAccount'), en('accountName'), en('openingBalance'), en('balance')]).toEqual([
      'Budget',
      'Accounts',
      'Account',
      'Add account',
      'Account name',
      'Opening balance',
      'Balance',
    ]);
    expect([en('hide'), en('show'), en('hiddenAccounts', { count: 2 }), en('deleteAccount')]).toEqual(['Hide', 'Show', 'Hidden accounts (2)', 'Delete account']);
    expect([en('totalMoney'), en('moneyByAccount')]).toEqual(['Total money', 'Money by account']);
    expect([en('currencies'), en('mainCurrency'), en('secondCurrency'), en('defaultAccount'), en('automatic')]).toEqual([
      'Currencies',
      'Main currency',
      'Second currency',
      'Default account',
      'Automatic',
    ]);
    expect([en('monthRates'), en('from'), en('to'), en('rate'), en('received'), en('addRate')]).toEqual(['Month rates', 'From', 'To', 'Rate', 'Received', 'Add rate']);
    expect([en('income'), en('addIncome'), en('incomeByMonth'), en('saved'), en('pctSaved')]).toEqual(['Income', 'Add income', 'Income by month', 'Saved', '% saved']);
    expect([en('deleteMonth'), en('deleteMonthTitle', { month: 'October 2026' }), en('delete')]).toEqual(['Delete month', 'Delete October 2026?', 'Delete']);
  });

  it('the delete-month text is built from its three counts, each with its singular and its plural', () => {
    const body = (t: typeof en, fixed: number, tx: number, transfers: number) =>
      t('deleteMonthBody', {
        fixed: t('countFixed', { count: fixed }),
        transactions: t('countTransactions', { count: tx }),
        transfers: t('countTransfers', { count: transfers }),
      });
    expect(body(en, 11, 7, 1)).toBe(
      'This deletes the month with its 11 monthly expenses, 7 transactions and 1 transfer. Account balances change accordingly. This cannot be undone.',
    );
    expect(body(en, 1, 1, 0)).toContain('its 1 monthly expense, 1 transaction and 0 transfers.');
    expect(body(es, 11, 7, 1)).toBe(
      'Se elimina el mes con sus 11 gastos mensuales, 7 transacciones y 1 envío. Los saldos de las cuentas cambian en consecuencia. Esto no se puede deshacer.',
    );
    expect(body(tr, 11, 7, 1)).toBe('Bu ay; 11 aylık gider, 7 işlem ve 1 transfer ile birlikte silinir. Hesap bakiyeleri buna göre değişir. Bu işlem geri alınamaz.');
  });

  it('Spanish and Turkish: the same terms, in their language', () => {
    expect([es('budget'), es('accounts'), es('addAccount'), es('openingBalance'), es('balance'), es('hide'), es('show')]).toEqual([
      'Presupuesto',
      'Cuentas',
      'Agregar cuenta',
      'Saldo inicial',
      'Saldo',
      'Ocultar',
      'Mostrar',
    ]);
    expect([es('mainCurrency'), es('secondCurrency'), es('defaultAccount'), es('monthRates'), es('addIncome'), es('deleteMonth')]).toEqual([
      'Moneda principal',
      'Segunda moneda',
      'Cuenta por defecto',
      'Tasas del mes',
      'Agregar ingreso',
      'Eliminar mes',
    ]);
    expect(es('deleteMonthTitle', { month: 'Octubre 2026' })).toBe('¿Eliminar Octubre 2026?');
    expect([tr('accounts'), tr('addAccount'), tr('openingBalance'), tr('hide'), tr('show'), tr('deleteAccount')]).toEqual([
      'Hesaplar',
      'Hesap ekle',
      'Açılış bakiyesi',
      'Gizle',
      'Göster',
      'Hesabı sil',
    ]);
    expect([tr('mainCurrency'), tr('secondCurrency'), tr('defaultAccount'), tr('monthRates'), tr('addIncome'), tr('deleteMonth')]).toEqual([
      'Ana para birimi',
      'İkinci para birimi',
      'Varsayılan hesap',
      'Ay kurları',
      'Gelir ekle',
      'Ayı sil',
    ]);
    expect(tr('deleteMonthTitle', { month: 'Ekim 2026' })).toBe('Ekim 2026 silinsin mi?');
  });

  it('currency codes go in as a parameter: they look the same in all three languages', () => {
    expect(en('usedIn', { currency: 'TRY' })).toBe('Used in TRY');
    expect(es('usedIn', { currency: 'TRY' })).toBe('Usado en TRY');
    expect(tr('usedIn', { currency: 'TRY' })).toBe('TRY olarak kullanılan');
    expect(en('ofBudget', { budget: '70,000', currency: 'DOP' })).toBe('of 70,000 DOP');
    expect(es('budgetUsedOf', { used: '49,150', budget: '70,000', currency: 'DOP' })).toBe('Presupuesto usado: 49,150 de 70,000 DOP');
    expect(en('balanceOf', { account: 'US account', currency: 'USD' })).toBe('Balance of US account, in USD');
  });

  it('the Excel note says it is a summary in USD and DOP', () => {
    for (const t of [en, es, tr]) {
      expect(t('excelNote')).toContain('USD');
      expect(t('excelNote')).toContain('DOP');
    }
    expect(en('excelNote')).toBe('The Excel file is a summary in USD and DOP, with two accounts, until it is redesigned.');
  });
});

describe('rateHint: where a rate came from', () => {
  const hints = (lang: Language) => {
    const { rateHint } = createI18n(lang);
    const s = seedState();
    // October: typed by hand. August: from its transfers. USD → TRY has never been typed: default value.
    const typed = rateHint(rateFor(s, '2026-10', 'USD', 'DOP'), 'USD', 'DOP');
    const transfers = rateHint(rateFor(s, '2026-08', 'USD', 'DOP'), 'USD', 'DOP');
    const fallback = rateHint(rateFor(s, '2026-10', 'USD', 'TRY'), 'USD', 'TRY');
    // With USD → DOP and USD → TRY typed, TRY → DOP comes from crossing through USD. (Another state: the one above was
    // already used to compute and is not mutated, since shared/calc.ts memoizes the rates per state object.)
    const both = seedState();
    both.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    const crossed = rateHint(rateFor(both, '2026-10', 'TRY', 'DOP'), 'TRY', 'DOP');
    // A later month with no rate of its own keeps the last typed one, which is from an earlier month.
    const previous = rateHint(rateFor(s, '2027-03', 'USD', 'DOP'), 'USD', 'DOP');
    const same = rateHint(rateFor(s, '2026-10', 'DOP', 'DOP'), 'DOP', 'DOP');
    return { typed, transfers, fallback, crossed, previous, same };
  };

  it('in English, the glossary phrases', () => {
    expect(hints('en')).toEqual({
      typed: 'typed for this month',
      transfers: "from this month's transfers",
      fallback: 'default value, not set yet',
      crossed: 'crossed through USD',
      previous: 'from October 2026',
      same: '',
    });
  });

  it('in Spanish (the month, in lower case inside the phrase) and in Turkish', () => {
    expect(hints('es')).toEqual({
      typed: 'escrita para este mes',
      transfers: 'de los envíos de este mes',
      fallback: 'valor por defecto, aún sin definir',
      crossed: 'cruzada por USD',
      previous: 'de octubre 2026',
      same: '',
    });
    expect(hints('tr')).toEqual({
      typed: 'bu ay için girildi',
      transfers: 'bu ayın transferlerinden',
      fallback: 'varsayılan değer, henüz girilmedi',
      crossed: 'USD üzerinden çapraz kur',
      previous: 'Ekim 2026 ayından',
      same: '',
    });
  });
});

describe('rateHint with the date of the rate (RateInfo.date)', () => {
  it('the date does not change the phrase: one typed this month, whatever the day, is "typed for this month"', () => {
    const { rateHint } = createI18n('en');
    const first: RateInfo = { rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-01' };
    const later: RateInfo = { ...first, rate: 60, date: '2026-10-06' };
    expect(rateHint(first, 'USD', 'DOP')).toBe('typed for this month');
    expect(rateHint(later, 'USD', 'DOP')).toBe('typed for this month');
  });

  it('one typed in an earlier month that is still in effect says which month it is from, not the day', () => {
    const info: RateInfo = { rate: 58.76, source: 'previous', monthKey: '2026-10', date: '2026-10-06' };
    expect(createI18n('en').rateHint(info, 'USD', 'DOP')).toBe('from October 2026');
    expect(createI18n('es').rateHint(info, 'USD', 'DOP')).toBe('de octubre 2026');
    expect(createI18n('tr').rateHint(info, 'USD', 'DOP')).toBe('Ekim 2026 ayından');
    // What does not come from a typed one carries no date.
    const fromTransfers: RateInfo = { rate: 58.57, source: 'previous', monthKey: '2026-09', date: null };
    expect(createI18n('en').rateHint(fromTransfers, 'USD', 'DOP')).toBe('from September 2026');
  });

  it('with the sample data: a row earlier than the first typed rate of the month does not use it', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' }];
    const { rateHint } = createI18n('en');
    // On the 3rd the one typed for the 5th does not apply yet and nobody typed one before: October's transfers are used.
    const before = rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-03');
    expect(before).toMatchObject({ source: 'transfers', date: null });
    expect(rateHint(before, 'USD', 'DOP')).toBe("from this month's transfers");
    const after = rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-05');
    expect(after).toEqual({ rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-05' });
    expect(rateHint(after, 'USD', 'DOP')).toBe('typed for this month');
  });
});

describe('payment methods', () => {
  it('all five, in the order of the list and in each language', () => {
    expect([...METHODS]).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash']);
    const labels = (lang: Language) => METHODS.map((m) => createI18n(lang).methodLabel(m));
    expect(labels('en')).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash']);
    expect(labels('es')).toEqual(['Tarjeta de débito', 'Tarjeta de crédito', 'Transferencia', 'App del banco', 'Efectivo']);
    expect(labels('tr')).toEqual(['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit']);
  });

  it('the default method is the debit card', () => {
    expect(METHODS[0]).toBe('Debit card');
  });

  it('the old card method (Card / Tarjeta / Kart) counts as the debit card when read; when displayed, an old row comes out as is', () => {
    expect(['Card', 'tarjeta', ' KART '].map(canonicalMethod)).toEqual(['Debit card', 'Debit card', 'Debit card']);
    expect(['Tarjeta de crédito', 'kredi kartı', 'credit card', 'tarjeta de credito'].map(canonicalMethod)).toEqual(Array(4).fill('Credit card'));
    expect(['Efectivo', 'Nakit', 'cash'].map(canonicalMethod)).toEqual(['Cash', 'Cash', 'Cash']);
    expect(canonicalMethod(' Cheque ')).toBe('Cheque');
    for (const lang of LANGS) expect(createI18n(lang).methodLabel('Card')).toBe('Card');
  });
});

describe('budget: leftover, history and closing the month', () => {
  const en = translator(CORE, 'en');
  const es = translator(CORE, 'es');
  const tr = translator(CORE, 'tr');

  it('the checkbox of an income', () => {
    expect([en('addsToBudget'), es('addsToBudget'), tr('addsToBudget')]).toEqual(['Adds to budget', 'Suma al presupuesto', 'Bütçeye eklenir']);
  });

  it('the leftover from the previous month', () => {
    expect([en('leftoverFromLast'), en('addToBudget'), en('leftoverAdded')]).toEqual(['Leftover from last month:', 'Add to budget', 'added']);
    expect([es('leftoverFromLast'), es('addToBudget'), es('leftoverAdded')]).toEqual(['Sobrante del mes pasado:', 'Sumar al presupuesto', 'sumado']);
    expect([tr('leftoverFromLast'), tr('addToBudget'), tr('leftoverAdded')]).toEqual(['Geçen aydan kalan:', 'Bütçeye ekle', 'eklendi']);
    // The button does not say the same as the checkbox of an income ("Adds to budget"), in any language.
    for (const t of [en, es, tr]) expect(t('addToBudget')).not.toBe(t('addsToBudget'));
  });

  it('the budget history and its kinds of movement', () => {
    const kinds = ['budgetKindInitial', 'budgetKindAdjust', 'budgetKindLeftover', 'budgetKindIncome'] as const;
    expect([en('budgetHistory'), en('budgetHistoryEmpty'), en('budgetKind')]).toEqual(['Budget history', 'No budget entries yet.', 'Kind']);
    expect(kinds.map((k) => en(k))).toEqual(['Initial', 'Adjustment', 'Leftover', 'Income']);
    expect([es('budgetHistory'), es('budgetHistoryEmpty'), es('budgetKind')]).toEqual([
      'Historial del presupuesto',
      'Aún no hay movimientos del presupuesto.',
      'Tipo',
    ]);
    expect(kinds.map((k) => es(k))).toEqual(['Inicial', 'Ajuste', 'Sobrante', 'Ingreso']);
    expect([tr('budgetHistory'), tr('budgetHistoryEmpty'), tr('budgetKind')]).toEqual(['Bütçe geçmişi', 'Henüz bütçe hareketi yok.', 'Tür']);
    expect(kinds.map((k) => tr(k))).toEqual(['Başlangıç', 'Düzeltme', 'Devreden', 'Gelir']);
    // Each kind is distinct from the others.
    for (const t of [en, es, tr]) expect(new Set(kinds.map((k) => t(k))).size).toBe(4);
  });

  it('extra budget and the month summary', () => {
    expect([en('addBudgetExtra'), es('addBudgetExtra'), tr('addBudgetExtra')]).toEqual(['Extra budget', 'Presupuesto extra', 'Ek bütçe']);
    expect([en('budgetKindExtra'), es('budgetKindExtra'), tr('budgetKindExtra')]).toEqual(['Extra', 'Extra', 'Ek']);
    expect([en('budgetSummary'), es('budgetSummary'), tr('budgetSummary')]).toEqual(['Month summary', 'Resumen del mes', 'Ay özeti']);
  });

  it('the × of a movement says which one it removes', () => {
    const entry = { kind: 'Adjustment', date: '2026-10-05', amount: '5,000.00', currency: 'DOP' };
    expect(en('deleteBudgetEntry', entry)).toBe('Delete Adjustment of 2026-10-05: 5,000.00 DOP');
    expect(es('deleteBudgetEntry', { ...entry, kind: 'Ajuste' })).toBe('Eliminar Ajuste del 2026-10-05: 5,000.00 DOP');
    expect(tr('deleteBudgetEntry', { ...entry, kind: 'Düzeltme' })).toBe('Sil: Düzeltme, 2026-10-05, 5,000.00 DOP');
  });

  it('the close dialog asks for the budget of the next month', () => {
    expect(en('closeBudgetIntro', { next: 'November 2026' })).toBe("November 2026's budget starts with these amounts per account:");
    expect(en('closeBudgetOf', { account: 'DR account', currency: 'DOP' })).toBe('Budget from DR account (DOP)');
    expect(en('closeAddLeftover', { amount: '20,850.29', currency: 'DOP', next: 'November 2026' })).toBe(
      "Add this month's leftover (20,850.29 DOP) to November 2026's budget",
    );
    expect(es('closeBudgetIntro', { next: 'Noviembre 2026' })).toBe('El presupuesto de Noviembre 2026 arranca con estos montos por cuenta:');
    expect(es('closeBudgetOf', { account: 'DR account', currency: 'DOP' })).toBe('Presupuesto de DR account (DOP)');
    expect(es('closeAddLeftover', { amount: '20,850.29', currency: 'DOP', next: 'Noviembre 2026' })).toBe(
      'Sumar el sobrante de este mes (20,850.29 DOP) al presupuesto de Noviembre 2026',
    );
    expect(tr('closeBudgetIntro', { next: 'Kasım 2026' })).toBe('Kasım 2026 bütçesi hesap başına şu tutarlarla başlar:');
    expect(tr('closeBudgetOf', { account: 'DR account', currency: 'DOP' })).toBe('DR account bütçesi (DOP)');
    expect(tr('closeAddLeftover', { amount: '20,850.29', currency: 'DOP', next: 'Kasım 2026' })).toBe(
      'Bu ayın kalanını (20,850.29 DOP) Kasım 2026 bütçesine ekle',
    );
  });
});

describe('interpolation', () => {
  it('replaces each {parameter}, as many times as it appears', () => {
    expect(interpolate('{next} y otra vez {next}', { next: 'Noviembre 2026' })).toBe('Noviembre 2026 y otra vez Noviembre 2026');
    expect(interpolate('{used} of {budget} {currency}', { used: '49,150', budget: 70000, currency: 'DOP' })).toBe('49,150 of 70000 DOP');
  });

  it('a parameter that is not provided is left in plain sight, and an extra one does no harm', () => {
    expect(interpolate('Close {month}', {})).toBe('Close {month}');
    expect(interpolate('Close', { month: 'x' })).toBe('Close');
  });

  it('the value is not interpreted again', () => {
    expect(interpolate('Loaded: {file}', { file: '{file}.xlsx', other: 'no' })).toBe('Loaded: {file}.xlsx');
    expect(interpolate('{a}', { a: '$& $1' })).toBe('$& $1');
  });

  it('the translator interpolates in the requested language', () => {
    expect(translator(CORE, 'en')('closeMonth', { month: 'October 2026' })).toBe('Close October 2026');
    expect(translator(CORE, 'es')('closeMonth', { month: 'Octubre 2026' })).toBe('Cerrar Octubre 2026');
    expect(translator(CORE, 'en')('devResetConfirm', { name: 'Eda' })).toBe("Start blank? All of Eda's data on the page will be deleted.");
  });
});

describe('strings specific to a screen (defineStrings)', () => {
  const SCREEN = defineStrings({
    en: { title: 'Transaction history', count: { one: '{count} transaction', other: '{count} transactions' } },
    es: { title: 'Historial de transacciones', count: { one: '{count} transacción', other: '{count} transacciones' } },
    tr: { title: 'İşlem geçmişi', count: { one: '{count} işlem', other: '{count} işlem' } },
  });

  it('singular only with 1; plural with 0 and with everything else', () => {
    const en = translator(SCREEN, 'en');
    expect([0, 1, 2, 7].map((count) => en('count', { count }))).toEqual(['0 transactions', '1 transaction', '2 transactions', '7 transactions']);
    const es = translator(SCREEN, 'es');
    expect([1, 7].map((count) => es('count', { count }))).toEqual(['1 transacción', '7 transacciones']);
    const tr = translator(SCREEN, 'tr');
    expect([1, 7].map((count) => tr('count', { count }))).toEqual(['1 işlem', '7 işlem']);
  });

  it('strings with no plural are translated the same way', () => {
    expect(LANGS.map((lang) => translator(SCREEN, lang)('title'))).toEqual(['Transaction history', 'Historial de transacciones', 'İşlem geçmişi']);
  });

  it('the translator of a language is always the same function', () => {
    expect(translator(SCREEN, 'es')).toBe(translator(SCREEN, 'es'));
    expect(translator(SCREEN, 'es')).not.toBe(translator(SCREEN, 'tr'));
  });

  it('the types require the same keys and the same shape in each language', () => {
    // @ts-expect-error `title` is missing in Turkish
    defineStrings({ en: { title: 'A' }, es: { title: 'B' }, tr: {} });
    // @ts-expect-error `extra` is an extra key in Spanish
    defineStrings({ en: { title: 'A' }, es: { title: 'B', extra: 'C' }, tr: { title: 'D' } });
    // @ts-expect-error `count` is plural in English: it cannot be a plain string in Spanish
    defineStrings({ en: { count: { one: 'a', other: 'b' } }, es: { count: 'c' }, tr: { count: { one: 'd', other: 'e' } } });
    const t = translator(SCREEN, 'en');
    // @ts-expect-error the key does not exist
    t('nope');
    // @ts-expect-error a key with a plural requires `count`
    t('count');
    expect(t('title')).toBe('Transaction history');
  });
});

describe('createI18n', () => {
  it('binds the months, the categories and the methods to the language', () => {
    const es = createI18n('es');
    expect(es.lang).toBe('es');
    expect(es.label('2026-10')).toBe('Octubre 2026');
    expect(es.catLabel('Food')).toBe('Comida');
    expect(es.methodLabel('Bank app')).toBe('App del banco');
    expect(es.fixedCategory).toBe('Gastos fijos');
    expect(es.monthNames).toHaveLength(12);
    expect(es.t('add')).toBe('Agregar');

    const tr = createI18n('tr');
    expect([tr.label('2026-10'), tr.catLabel('Food'), tr.methodLabel('Debit card'), tr.fixedCategory]).toEqual(['Ekim 2026', 'Yemek', 'Banka kartı', 'Sabit giderler']);
    expect(createI18n('en').label('2026-10')).toBe('October 2026');
  });

  it('a value outside the list (free text, imported data) is displayed as is', () => {
    expect(createI18n('tr').catLabel('Mascotas')).toBe('Mascotas');
    expect(createI18n('es').methodLabel('Efectivo')).toBe('Efectivo');
  });

  it('it is the same object for the same language', () => {
    expect(createI18n('es')).toBe(createI18n('es'));
  });
});
