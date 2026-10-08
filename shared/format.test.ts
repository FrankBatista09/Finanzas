import { describe, expect, it } from 'vitest';
import { f0, f2, fPct, fRate, parseAmount } from './format';

describe('formato numérico', () => {
  it('f2: dos decimales y separador de miles', () => {
    expect(f2(42025.567)).toBe('42,025.57');
    expect(f2(1234567.5)).toBe('1,234,567.50');
    expect(f2(-850)).toBe('-850.00');
    expect(f2(-0.001)).toBe('0.00');
    expect(f2(Number.NaN)).toBe('0.00');
  });

  it('f0: entero redondeado', () => {
    expect(f0(42025.57)).toBe('42,026');
    expect(f0(-3720.4)).toBe('-3,720');
    expect(f0(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('fRate: dos decimales sin separador de miles', () => {
    expect(fRate(58.7612)).toBe('58.76');
    expect(fRate(1234.5)).toBe('1234.50');
  });

  it('fPct: un decimal y el signo de porcentaje', () => {
    expect(fPct(55.1724)).toBe('55.2%');
    expect(fPct(0)).toBe('0.0%');
    expect(fPct(250)).toBe('250.0%');
    expect(fPct(Number.NaN)).toBe('0.0%');
  });

  it('parseAmount: vacío o inválido es 0', () => {
    expect(parseAmount('1337.15')).toBe(1337.15);
    expect(parseAmount(' 12 ')).toBe(12);
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('abc')).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount(Number.NaN)).toBe(0);
  });
});
