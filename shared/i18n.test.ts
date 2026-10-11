// Payment methods: today's list, how it is shown in each language and what is understood from what people type or
// dictate, including the words from when there was a single card.

import { describe, expect, it } from 'vitest';
import { METHODS } from './constants';
import { METHOD_NAMES, canonicalCat, canonicalMethod, methodLabel } from './i18n';

describe('payment methods', () => {
  it('the list, in its order; the first one is the default method', () => {
    expect(METHODS).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash']);
    expect(METHOD_NAMES.en).toEqual(METHODS);
    expect(METHOD_NAMES.es).toEqual(['Tarjeta de débito', 'Tarjeta de crédito', 'Transferencia', 'App del banco', 'Efectivo']);
    expect(METHOD_NAMES.tr).toEqual(['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit']);
  });

  it('methodLabel: each stored value in the requested language; what is not in the list, as is', () => {
    expect(METHODS.map((m) => methodLabel(m, 'en'))).toEqual([...METHODS]);
    expect(METHODS.map((m) => methodLabel(m, 'es'))).toEqual(['Tarjeta de débito', 'Tarjeta de crédito', 'Transferencia', 'App del banco', 'Efectivo']);
    expect(METHODS.map((m) => methodLabel(m, 'tr'))).toEqual(['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit']);
    // 'Card' is no longer a value in the list: if one were still stored, it is shown as it is.
    for (const lang of ['en', 'es', 'tr'] as const) expect(['Card', 'Cheque', ''].map((m) => methodLabel(m, lang))).toEqual(['Card', 'Cheque', '']);
  });

  it('canonicalMethod: plain "card", in any language, is the debit card', () => {
    for (const text of ['card', 'Card', 'CARD', ' card ', 'tarjeta', 'Tarjeta', ' TARJETA', 'kart', 'Kart', 'KART ']) {
      expect(canonicalMethod(text), text).toBe('Debit card');
    }
    for (const text of ['Debit card', 'debit card', 'Tarjeta de débito', 'tarjeta de debito', 'Banka kartı', 'banka karti', 'BANKA KARTI']) {
      expect(canonicalMethod(text), text).toBe('Debit card');
    }
  });

  it('canonicalMethod: the credit card, cash and the others, by their name in any language', () => {
    for (const text of ['credit card', 'Credit Card', 'Tarjeta de crédito', ' tarjeta de credito ', 'Kredi kartı', 'kredi karti', 'KREDİ KARTI']) {
      expect(canonicalMethod(text), text).toBe('Credit card');
    }
    for (const text of ['cash', 'Cash', 'Efectivo', ' EFECTIVO ', 'Nakit', 'nakit']) expect(canonicalMethod(text), text).toBe('Cash');
    expect(['Transferencia', 'havale', 'TRANSFER'].map(canonicalMethod)).toEqual(['Transfer', 'Transfer', 'Transfer']);
    expect(['App del banco', 'Banka uygulaması', 'banka uygulamasi', 'bank app'].map(canonicalMethod)).toEqual(['Bank app', 'Bank app', 'Bank app', 'Bank app']);
  });

  it('canonicalMethod: what is not recognized comes back as is, without extra spaces', () => {
    expect([' Cheque ', 'Tarjeta de regalo', 'Çek', 'cards', 'Débito', '', 'toString', 'constructor'].map(canonicalMethod)).toEqual([
      'Cheque',
      'Tarjeta de regalo',
      'Çek',
      'cards',
      'Débito',
      '',
      'toString',
      'constructor',
    ]);
  });

  it('categories do not change: they still require the exact name, regardless of case', () => {
    expect([' comida ', 'YEMEK', 'Other', 'Educacion'].map(canonicalCat)).toEqual(['Food', 'Food', 'Other', 'Educacion']);
  });
});
