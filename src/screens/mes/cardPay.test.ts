// Lógica pura del diálogo «Pagar la tarjeta de crédito».

import { describe, expect, it } from 'vitest';
import { seedState } from '../../../shared/seed';
import type { AppState } from '../../../shared/types';
import { payAmount, payForm, payRest } from './cardPay';

const OCT = '2026-10';
const owing = (other: number): AppState => {
  const s = seedState();
  s.months[OCT] = { ...s.months[OCT]!, card: { other, paid: null, accountId: null } };
  return s;
};

describe('payForm', () => {
  it('propone pagar todo, con dos decimales, desde la cuenta por defecto', () => {
    expect(payForm(owing(1234.5), OCT)).toEqual({ amount: '1234.50', accountId: 'dr' });
  });

  it('propone la cuenta del último pago de la tarjeta', () => {
    const s = owing(100);
    s.months['2026-09'] = { ...s.months['2026-09']!, card: { other: 5, paid: 5, accountId: 'us' } };
    expect(payForm(s, OCT).accountId).toBe('us');
  });
});

describe('payAmount', () => {
  it('> 0 y como mucho el total; el total redondeado cuenta como el total', () => {
    expect(payAmount('500', 1000)).toBe(500);
    expect(payAmount('1000', 1000)).toBe(1000);
    expect(payAmount('1000.01', 1000)).toBeNull();
    expect(payAmount('0', 1000)).toBeNull();
    expect(payAmount('-3', 1000)).toBeNull();
    expect(payAmount('', 1000)).toBeNull();
    expect(payAmount('abc', 1000)).toBeNull();
    expect(payAmount('100.00', 100.004)).toBe(100.004);
  });
});

describe('payRest', () => {
  it('lo que pasa al mes siguiente; con un monto que no vale, todo el total', () => {
    expect(payRest('400', 1000)).toBe(600);
    expect(payRest('1000', 1000)).toBe(0);
    expect(payRest('2000', 1000)).toBe(1000);
    expect(payRest('', 1000)).toBe(1000);
  });
});
