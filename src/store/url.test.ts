import { describe, expect, it } from 'vitest';
import { seedState } from '../../shared/seed';
import { buildSearch, parseUrl, resolveMonth } from './url';

const NONE = { user: null, mes: null, hoja: 'mes' } as const;

describe('parseUrl', () => {
  it('sin parámetros: sin usuario, mes en curso y hoja del mes', () => {
    expect(parseUrl('')).toEqual(NONE);
    expect(parseUrl('?')).toEqual(NONE);
  });

  it('lee usuario, mes y hoja', () => {
    expect(parseUrl('?month=2026-10')).toEqual({ ...NONE, mes: '2026-10' });
    expect(parseUrl('?sheet=savings')).toEqual({ ...NONE, hoja: 'ahorros' });
    expect(parseUrl('?user=eda')).toEqual({ ...NONE, user: 'eda' });
    expect(parseUrl('?sheet=savings&month=2026-08&user=eda')).toEqual({ user: 'eda', mes: '2026-08', hoja: 'ahorros' });
    expect(parseUrl('user=eda&month=2026-10&sheet=savings')).toEqual({ user: 'eda', mes: '2026-10', hoja: 'ahorros' });
  });

  it('descarta valores que no son un usuario, un mes o una hoja', () => {
    expect(parseUrl('?month=october')).toEqual(NONE);
    expect(parseUrl('?month=2026-13')).toEqual(NONE);
    expect(parseUrl('?month=2026-1')).toEqual(NONE);
    expect(parseUrl('?sheet=config')).toEqual(NONE);
    expect(parseUrl('?sheet=month&month=')).toEqual(NONE);
    expect(parseUrl('?user=')).toEqual(NONE);
    expect(parseUrl('?user=Eda%20Reyes')).toEqual(NONE);
    expect(parseUrl('?user=../etc')).toEqual(NONE);
  });

  it('los nombres de la versión 1 (?mes=, ?hoja=) ya no se reconocen', () => {
    expect(parseUrl('?mes=2026-10&hoja=ahorros')).toEqual(NONE);
    expect(parseUrl('?sheet=ahorros')).toEqual(NONE);
  });
});

describe('buildSearch', () => {
  it('omite el usuario y el mes vacíos y la hoja por defecto', () => {
    expect(buildSearch(NONE)).toBe('');
    expect(buildSearch({ ...NONE, mes: '2026-10' })).toBe('?month=2026-10');
    expect(buildSearch({ ...NONE, hoja: 'ahorros' })).toBe('?sheet=savings');
    expect(buildSearch({ ...NONE, user: 'eda' })).toBe('?user=eda');
  });

  it('escribe los tres en orden: user, month, sheet', () => {
    expect(buildSearch({ user: 'eda', mes: '2026-10', hoja: 'ahorros' })).toBe('?user=eda&month=2026-10&sheet=savings');
    expect(buildSearch({ user: 'frank', mes: '2026-10', hoja: 'mes' })).toBe('?user=frank&month=2026-10');
  });

  it('conserva los parámetros ajenos y reemplaza los propios', () => {
    expect(buildSearch({ ...NONE, mes: '2026-09' }, '?debug=1&month=2026-10&sheet=savings&user=eda')).toBe('?month=2026-09&debug=1');
    expect(buildSearch(NONE, '?month=2026-10&x=a%20b')).toBe('?x=a+b');
    // Un enlace viejo conserva sus parámetros como ajenos: no estorban ni se interpretan.
    expect(buildSearch({ ...NONE, user: 'eda' }, '?mes=2026-10')).toBe('?user=eda&mes=2026-10');
  });

  it('ida y vuelta', () => {
    for (const url of [
      NONE,
      { user: null, mes: '2026-10', hoja: 'mes' },
      { user: null, mes: null, hoja: 'ahorros' },
      { user: 'eda', mes: '2027-01', hoja: 'ahorros' },
      { user: 'frank-2', mes: null, hoja: 'mes' },
    ] as const) {
      expect(parseUrl(buildSearch(url))).toEqual(url);
    }
  });
});

describe('resolveMonth', () => {
  const s = seedState();

  it('usa el mes pedido si existe, aunque esté cerrado', () => {
    expect(resolveMonth('2026-08', s)).toBe('2026-08');
  });

  it('si falta o no existe, el mes en curso', () => {
    expect(resolveMonth(null, s)).toBe('2026-10');
    expect(resolveMonth('2031-05', s)).toBe('2026-10');
  });

  it('al cambiar a un usuario que no tiene ese mes, cae en su mes en curso', () => {
    // Eda acaba de empezar: solo tiene noviembre. La URL seguía en el agosto de Frank.
    const eda = { ...s, months: { '2026-11': { ...s.months['2026-10']!, key: '2026-11' } } };
    expect(resolveMonth('2026-08', eda)).toBe('2026-11');
  });

  it('con todos los meses cerrados, el último', () => {
    const closed = seedState();
    closed.months['2026-10']!.closed = true;
    expect(resolveMonth(null, closed)).toBe('2026-10');
  });

  it('sin meses, null', () => {
    expect(resolveMonth('2026-10', { ...s, months: {} })).toBeNull();
  });
});
