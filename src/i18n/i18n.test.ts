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

describe('diccionarios comunes', () => {
  it('hay uno por cada idioma de la app', () => {
    expect(Object.keys(CORE).sort()).toEqual([...LANGS].sort());
  });

  it('los tres tienen exactamente las mismas claves', () => {
    const keys = Object.keys(dict('en')).sort();
    expect(keys.length).toBeGreaterThan(80);
    for (const lang of LANGS) expect(Object.keys(dict(lang)).sort(), lang).toEqual(keys);
  });

  it('ningún texto está vacío ni lleva espacios sobrantes', () => {
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(dict(lang))) {
        for (const text of texts(entry)) {
          expect(text.trim(), `${lang}.${key}`).not.toBe('');
          expect(text, `${lang}.${key}`).toBe(text.trim());
        }
      }
    }
  });

  it('cada clave usa los mismos {parámetros} en los tres idiomas', () => {
    for (const [key, entry] of Object.entries(dict('en'))) {
      for (const lang of LANGS) expect(placeholders(dict(lang)[key]!), `${lang}.${key}`).toEqual(placeholders(entry));
    }
  });

  it('una clave con plural lo es en los tres idiomas', () => {
    for (const [key, entry] of Object.entries(dict('en'))) {
      for (const lang of LANGS) expect(typeof dict(lang)[key], `${lang}.${key}`).toBe(typeof entry);
    }
  });

  it('el español conserva los textos de la versión 1 y el inglés sigue el glosario', () => {
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

  it('el turco usa los términos acordados', () => {
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

describe('glosario del modelo de cuentas y monedas', () => {
  const en = translator(CORE, 'en');
  const es = translator(CORE, 'es');
  const tr = translator(CORE, 'tr');

  it('inglés: los términos del glosario, tal cual', () => {
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

  it('el texto de borrar un mes se arma con sus tres cuentas, cada una con su singular y su plural', () => {
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

  it('español y turco: los mismos términos, en su idioma', () => {
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

  it('los códigos de moneda van como parámetro: se ven igual en los tres idiomas', () => {
    expect(en('usedIn', { currency: 'TRY' })).toBe('Used in TRY');
    expect(es('usedIn', { currency: 'TRY' })).toBe('Usado en TRY');
    expect(tr('usedIn', { currency: 'TRY' })).toBe('TRY olarak kullanılan');
    expect(en('ofBudget', { budget: '70,000', currency: 'DOP' })).toBe('of 70,000 DOP');
    expect(es('budgetUsedOf', { used: '49,150', budget: '70,000', currency: 'DOP' })).toBe('Presupuesto usado: 49,150 de 70,000 DOP');
    expect(en('balanceOf', { account: 'US account', currency: 'USD' })).toBe('Balance of US account, in USD');
  });

  it('la nota del Excel dice que es un resumen en USD y DOP', () => {
    for (const t of [en, es, tr]) {
      expect(t('excelNote')).toContain('USD');
      expect(t('excelNote')).toContain('DOP');
    }
    expect(en('excelNote')).toBe('The Excel file is a summary in USD and DOP, with two accounts, until it is redesigned.');
  });
});

describe('rateHint: de dónde salió una tasa', () => {
  const hints = (lang: Language) => {
    const { rateHint } = createI18n(lang);
    const s = seedState();
    // Octubre: escrita a mano. Agosto: de sus envíos. USD → TRY nunca se ha escrito: valor de respaldo.
    const typed = rateHint(rateFor(s, '2026-10', 'USD', 'DOP'), 'USD', 'DOP');
    const transfers = rateHint(rateFor(s, '2026-08', 'USD', 'DOP'), 'USD', 'DOP');
    const fallback = rateHint(rateFor(s, '2026-10', 'USD', 'TRY'), 'USD', 'TRY');
    // Con USD → DOP y USD → TRY escritas, TRY → DOP sale cruzando por USD. (Otro estado: el de arriba ya se usó
    // para calcular y no se muta, que shared/calc.ts memoriza las tasas por objeto de estado.)
    const both = seedState();
    both.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    const crossed = rateHint(rateFor(both, '2026-10', 'TRY', 'DOP'), 'TRY', 'DOP');
    // Un mes posterior sin tasa propia sigue con la última escrita, que es de un mes anterior.
    const previous = rateHint(rateFor(s, '2027-03', 'USD', 'DOP'), 'USD', 'DOP');
    const same = rateHint(rateFor(s, '2026-10', 'DOP', 'DOP'), 'DOP', 'DOP');
    return { typed, transfers, fallback, crossed, previous, same };
  };

  it('en inglés, las frases del glosario', () => {
    expect(hints('en')).toEqual({
      typed: 'typed for this month',
      transfers: "from this month's transfers",
      fallback: 'default value, not set yet',
      crossed: 'crossed through USD',
      previous: 'from October 2026',
      same: '',
    });
  });

  it('en español (el mes, en minúscula dentro de la frase) y en turco', () => {
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

describe('rateHint con la fecha de la tasa (RateInfo.date)', () => {
  it('la fecha no cambia la frase: una escrita de este mes, sea del día que sea, es "typed for this month"', () => {
    const { rateHint } = createI18n('en');
    const first: RateInfo = { rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-01' };
    const later: RateInfo = { ...first, rate: 60, date: '2026-10-06' };
    expect(rateHint(first, 'USD', 'DOP')).toBe('typed for this month');
    expect(rateHint(later, 'USD', 'DOP')).toBe('typed for this month');
  });

  it('una escrita en un mes anterior que sigue vigente dice de qué mes es, no el día', () => {
    const info: RateInfo = { rate: 58.76, source: 'previous', monthKey: '2026-10', date: '2026-10-06' };
    expect(createI18n('en').rateHint(info, 'USD', 'DOP')).toBe('from October 2026');
    expect(createI18n('es').rateHint(info, 'USD', 'DOP')).toBe('de octubre 2026');
    expect(createI18n('tr').rateHint(info, 'USD', 'DOP')).toBe('Ekim 2026 ayından');
    // Lo que no sale de una escrita no trae fecha.
    const fromTransfers: RateInfo = { rate: 58.57, source: 'previous', monthKey: '2026-09', date: null };
    expect(createI18n('en').rateHint(fromTransfers, 'USD', 'DOP')).toBe('from September 2026');
  });

  it('con los datos de ejemplo: una fila anterior a la primera tasa escrita del mes no la usa', () => {
    const s = seedState();
    s.months['2026-10']!.rates = [{ from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' }];
    const { rateHint } = createI18n('en');
    // El día 3 la escrita del 5 aún no vale y antes nadie escribió ninguna: salen los envíos de octubre.
    const before = rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-03');
    expect(before).toMatchObject({ source: 'transfers', date: null });
    expect(rateHint(before, 'USD', 'DOP')).toBe("from this month's transfers");
    const after = rateFor(s, '2026-10', 'USD', 'DOP', '2026-10-05');
    expect(after).toEqual({ rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-05' });
    expect(rateHint(after, 'USD', 'DOP')).toBe('typed for this month');
  });
});

describe('métodos de pago', () => {
  it('los cinco, en el orden de la lista y en cada idioma', () => {
    expect([...METHODS]).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash']);
    const labels = (lang: Language) => METHODS.map((m) => createI18n(lang).methodLabel(m));
    expect(labels('en')).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash']);
    expect(labels('es')).toEqual(['Tarjeta de débito', 'Tarjeta de crédito', 'Transferencia', 'App del banco', 'Efectivo']);
    expect(labels('tr')).toEqual(['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit']);
  });

  it('el método por defecto es la tarjeta de débito', () => {
    expect(METHODS[0]).toBe('Debit card');
  });

  it('la tarjeta de antes (Card / Tarjeta / Kart) vale por la de débito al leerla; al mostrarla, una fila vieja sale tal cual', () => {
    expect(['Card', 'tarjeta', ' KART '].map(canonicalMethod)).toEqual(['Debit card', 'Debit card', 'Debit card']);
    expect(['Tarjeta de crédito', 'kredi kartı', 'credit card', 'tarjeta de credito'].map(canonicalMethod)).toEqual(Array(4).fill('Credit card'));
    expect(['Efectivo', 'Nakit', 'cash'].map(canonicalMethod)).toEqual(['Cash', 'Cash', 'Cash']);
    expect(canonicalMethod(' Cheque ')).toBe('Cheque');
    for (const lang of LANGS) expect(createI18n(lang).methodLabel('Card')).toBe('Card');
  });
});

describe('presupuesto: sobrante, historial y cierre del mes', () => {
  const en = translator(CORE, 'en');
  const es = translator(CORE, 'es');
  const tr = translator(CORE, 'tr');

  it('la casilla de un ingreso', () => {
    expect([en('addsToBudget'), es('addsToBudget'), tr('addsToBudget')]).toEqual(['Adds to budget', 'Suma al presupuesto', 'Bütçeye eklenir']);
  });

  it('el sobrante del mes anterior', () => {
    expect([en('leftoverFromLast'), en('addToBudget'), en('leftoverAdded')]).toEqual(['Leftover from last month:', 'Add to budget', 'added']);
    expect([es('leftoverFromLast'), es('addToBudget'), es('leftoverAdded')]).toEqual(['Sobrante del mes pasado:', 'Sumar al presupuesto', 'sumado']);
    expect([tr('leftoverFromLast'), tr('addToBudget'), tr('leftoverAdded')]).toEqual(['Geçen aydan kalan:', 'Bütçeye ekle', 'eklendi']);
    // El botón no dice lo mismo que la casilla de un ingreso ("Adds to budget"), en ningún idioma.
    for (const t of [en, es, tr]) expect(t('addToBudget')).not.toBe(t('addsToBudget'));
  });

  it('el historial del presupuesto y sus clases de movimiento', () => {
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
    // Cada clase se distingue de las demás.
    for (const t of [en, es, tr]) expect(new Set(kinds.map((k) => t(k))).size).toBe(4);
  });

  it('extra budget and the month summary', () => {
    expect([en('addBudgetExtra'), es('addBudgetExtra'), tr('addBudgetExtra')]).toEqual(['Extra budget', 'Presupuesto extra', 'Ek bütçe']);
    expect([en('budgetKindExtra'), es('budgetKindExtra'), tr('budgetKindExtra')]).toEqual(['Extra', 'Extra', 'Ek']);
    expect([en('budgetSummary'), es('budgetSummary'), tr('budgetSummary')]).toEqual(['Month summary', 'Resumen del mes', 'Ay özeti']);
  });

  it('la × de un movimiento dice cuál quita', () => {
    const entry = { kind: 'Adjustment', date: '2026-10-05', amount: '5,000.00', currency: 'DOP' };
    expect(en('deleteBudgetEntry', entry)).toBe('Delete Adjustment of 2026-10-05: 5,000.00 DOP');
    expect(es('deleteBudgetEntry', { ...entry, kind: 'Ajuste' })).toBe('Eliminar Ajuste del 2026-10-05: 5,000.00 DOP');
    expect(tr('deleteBudgetEntry', { ...entry, kind: 'Düzeltme' })).toBe('Sil: Düzeltme, 2026-10-05, 5,000.00 DOP');
  });

  it('el diálogo de cierre pregunta por el presupuesto del mes siguiente', () => {
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

describe('interpolación', () => {
  it('sustituye cada {parámetro}, las veces que aparezca', () => {
    expect(interpolate('{next} y otra vez {next}', { next: 'Noviembre 2026' })).toBe('Noviembre 2026 y otra vez Noviembre 2026');
    expect(interpolate('{used} of {budget} {currency}', { used: '49,150', budget: 70000, currency: 'DOP' })).toBe('49,150 of 70000 DOP');
  });

  it('un parámetro que no viene se deja a la vista, y uno de más no molesta', () => {
    expect(interpolate('Close {month}', {})).toBe('Close {month}');
    expect(interpolate('Close', { month: 'x' })).toBe('Close');
  });

  it('el valor no se vuelve a interpretar', () => {
    expect(interpolate('Loaded: {file}', { file: '{file}.xlsx', other: 'no' })).toBe('Loaded: {file}.xlsx');
    expect(interpolate('{a}', { a: '$& $1' })).toBe('$& $1');
  });

  it('el traductor interpola en el idioma pedido', () => {
    expect(translator(CORE, 'en')('closeMonth', { month: 'October 2026' })).toBe('Close October 2026');
    expect(translator(CORE, 'es')('closeMonth', { month: 'Octubre 2026' })).toBe('Cerrar Octubre 2026');
    expect(translator(CORE, 'en')('devResetConfirm', { name: 'Eda' })).toBe("Start blank? All of Eda's data on the page will be deleted.");
  });
});

describe('textos propios de una pantalla (defineStrings)', () => {
  const SCREEN = defineStrings({
    en: { title: 'Transaction history', count: { one: '{count} transaction', other: '{count} transactions' } },
    es: { title: 'Historial de transacciones', count: { one: '{count} transacción', other: '{count} transacciones' } },
    tr: { title: 'İşlem geçmişi', count: { one: '{count} işlem', other: '{count} işlem' } },
  });

  it('singular solo con 1; plural con 0 y con todo lo demás', () => {
    const en = translator(SCREEN, 'en');
    expect([0, 1, 2, 7].map((count) => en('count', { count }))).toEqual(['0 transactions', '1 transaction', '2 transactions', '7 transactions']);
    const es = translator(SCREEN, 'es');
    expect([1, 7].map((count) => es('count', { count }))).toEqual(['1 transacción', '7 transacciones']);
    const tr = translator(SCREEN, 'tr');
    expect([1, 7].map((count) => tr('count', { count }))).toEqual(['1 işlem', '7 işlem']);
  });

  it('los textos sin plural se traducen igual', () => {
    expect(LANGS.map((lang) => translator(SCREEN, lang)('title'))).toEqual(['Transaction history', 'Historial de transacciones', 'İşlem geçmişi']);
  });

  it('el traductor de un idioma es siempre la misma función', () => {
    expect(translator(SCREEN, 'es')).toBe(translator(SCREEN, 'es'));
    expect(translator(SCREEN, 'es')).not.toBe(translator(SCREEN, 'tr'));
  });

  it('los tipos exigen las mismas claves y la misma forma en cada idioma', () => {
    // @ts-expect-error falta `title` en turco
    defineStrings({ en: { title: 'A' }, es: { title: 'B' }, tr: {} });
    // @ts-expect-error sobra `extra` en español
    defineStrings({ en: { title: 'A' }, es: { title: 'B', extra: 'C' }, tr: { title: 'D' } });
    // @ts-expect-error `count` es plural en inglés: no puede ser un texto suelto en español
    defineStrings({ en: { count: { one: 'a', other: 'b' } }, es: { count: 'c' }, tr: { count: { one: 'd', other: 'e' } } });
    const t = translator(SCREEN, 'en');
    // @ts-expect-error la clave no existe
    t('nope');
    // @ts-expect-error una clave con plural exige `count`
    t('count');
    expect(t('title')).toBe('Transaction history');
  });
});

describe('createI18n', () => {
  it('ata al idioma los meses, las categorías y los métodos', () => {
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

  it('un valor fuera de la lista (texto libre, datos importados) se muestra tal cual', () => {
    expect(createI18n('tr').catLabel('Mascotas')).toBe('Mascotas');
    expect(createI18n('es').methodLabel('Efectivo')).toBe('Efectivo');
  });

  it('es el mismo objeto para el mismo idioma', () => {
    expect(createI18n('es')).toBe(createI18n('es'));
  });
});
