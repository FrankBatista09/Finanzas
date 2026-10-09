// Lógica pura del diálogo «Pagar la tarjeta de crédito».

import { describe, expect, it } from 'vitest';
import { seedState } from '../../../shared/seed';
import type { AppState } from '../../../shared/types';
import { isFullyPaid, payAmount, payForm, payRest } from './cardPay';

const OCT = '2026-10';
const owing = (other: number): AppState => {
  const s = seedState();
  s.months[OCT] = { ...s.months[OCT]!, card: { other, payments: [] } };
  return s;
};

describe('payForm', () => {
  it('propone pagar todo, con dos decimales, desde la cuenta por defecto', () => {
    expect(payForm(owing(1234.5), OCT)).toEqual({ amount: '1234.50', accountId: 'dr' });
  });

  it('propone pagar solo lo que falta', () => {
    const s = owing(1000);
    s.months[OCT] = { ...s.months[OCT]!, card: { other: 1000, payments: [{ id: 'p', date: '2026-10-05', accountId: 'dr', amount: 400 }] } };
    expect(payForm(s, OCT).amount).toBe('600.00');
  });

  it('propone la cuenta del último pago de la tarjeta', () => {
    const s = owing(100);
    s.months['2026-09'] = { ...s.months['2026-09']!, card: { other: 5, payments: [{ id: 'p', date: '2026-09-30', accountId: 'us', amount: 5 }] } };
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
  it('lo que quedará por pagar; con un monto que no vale, todo lo que falta', () => {
    expect(payRest('400', 1000)).toBe(600);
    expect(payRest('1000', 1000)).toBe(0);
    expect(payRest('2000', 1000)).toBe(1000);
    expect(payRest('', 1000)).toBe(1000);
  });
});

describe('isFullyPaid', () => {
  it('con menos de medio centavo por pagar está pagada', () => {
    expect(isFullyPaid(0)).toBe(true);
    expect(isFullyPaid(0.004)).toBe(true);
    expect(isFullyPaid(0.01)).toBe(false);
  });
});
