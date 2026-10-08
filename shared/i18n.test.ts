// Métodos de pago: la lista de hoy, cómo se muestra en cada idioma y qué se entiende de lo que escribe o dicta
// la gente, incluidas las palabras de cuando había una sola tarjeta.

import { describe, expect, it } from 'vitest';
import { METHODS } from './constants';
import { METHOD_NAMES, canonicalCat, canonicalMethod, methodLabel } from './i18n';

describe('métodos de pago', () => {
  it('la lista, en su orden; el primero es el método por defecto', () => {
    expect(METHODS).toEqual(['Debit card', 'Credit card', 'Transfer', 'Bank app', 'Cash']);
    expect(METHOD_NAMES.en).toEqual(METHODS);
    expect(METHOD_NAMES.es).toEqual(['Tarjeta de débito', 'Tarjeta de crédito', 'Transferencia', 'App del banco', 'Efectivo']);
    expect(METHOD_NAMES.tr).toEqual(['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit']);
  });

  it('methodLabel: cada valor guardado en el idioma pedido; lo que no es de la lista, tal cual', () => {
    expect(METHODS.map((m) => methodLabel(m, 'en'))).toEqual([...METHODS]);
    expect(METHODS.map((m) => methodLabel(m, 'es'))).toEqual(['Tarjeta de débito', 'Tarjeta de crédito', 'Transferencia', 'App del banco', 'Efectivo']);
    expect(METHODS.map((m) => methodLabel(m, 'tr'))).toEqual(['Banka kartı', 'Kredi kartı', 'Havale', 'Banka uygulaması', 'Nakit']);
    // 'Card' ya no es un valor de la lista: si quedara alguno guardado, se muestra como está.
    for (const lang of ['en', 'es', 'tr'] as const) expect(['Card', 'Cheque', ''].map((m) => methodLabel(m, lang))).toEqual(['Card', 'Cheque', '']);
  });

  it('canonicalMethod: la tarjeta a secas, en cualquier idioma, es la de débito', () => {
    for (const text of ['card', 'Card', 'CARD', ' card ', 'tarjeta', 'Tarjeta', ' TARJETA', 'kart', 'Kart', 'KART ']) {
      expect(canonicalMethod(text), text).toBe('Debit card');
    }
    for (const text of ['Debit card', 'debit card', 'Tarjeta de débito', 'tarjeta de debito', 'Banka kartı', 'banka karti', 'BANKA KARTI']) {
      expect(canonicalMethod(text), text).toBe('Debit card');
    }
  });

  it('canonicalMethod: la de crédito, el efectivo y los demás, por su nombre en cualquier idioma', () => {
    for (const text of ['credit card', 'Credit Card', 'Tarjeta de crédito', ' tarjeta de credito ', 'Kredi kartı', 'kredi karti', 'KREDİ KARTI']) {
      expect(canonicalMethod(text), text).toBe('Credit card');
    }
    for (const text of ['cash', 'Cash', 'Efectivo', ' EFECTIVO ', 'Nakit', 'nakit']) expect(canonicalMethod(text), text).toBe('Cash');
    expect(['Transferencia', 'havale', 'TRANSFER'].map(canonicalMethod)).toEqual(['Transfer', 'Transfer', 'Transfer']);
    expect(['App del banco', 'Banka uygulaması', 'banka uygulamasi', 'bank app'].map(canonicalMethod)).toEqual(['Bank app', 'Bank app', 'Bank app', 'Bank app']);
  });

  it('canonicalMethod: lo que no se reconoce vuelve tal cual, sin espacios sobrantes', () => {
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

  it('las categorías no cambian: siguen pidiendo el nombre exacto, sin importar mayúsculas', () => {
    expect([' comida ', 'YEMEK', 'Other', 'Educacion'].map(canonicalCat)).toEqual(['Food', 'Food', 'Other', 'Educacion']);
  });
});
