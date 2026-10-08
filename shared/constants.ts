import type { Currency, Goal } from './types';

export const CATS = [
  'Comida',
  'Supermercado',
  'Transporte',
  'Entretenimiento',
  'Salud',
  'Ropa',
  'Hogar',
  'Suscripciones',
  'Educación',
  'Viajes',
] as const;

export const METHODS = ['Tarjeta', 'Transferencia', 'App del banco'] as const;

export const VIAS = ['Remitly', 'PayPal'] as const;

export const CURRENCIES: readonly Currency[] = ['DOP', 'USD'];

export const MESES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
] as const;

/** Tasa Remitly de referencia: se usa cuando ningún mes (actual o anterior) tiene envíos. */
export const DEFAULT_RATE = 58.76;

/** El usuario vive en República Dominicana (UTC-4, sin horario de verano): "hoy" se calcula en esta zona. */
export const TIMEZONE = 'America/Santo_Domingo';

/** Metas iniciales (la migración de D1 inserta estas mismas filas). */
export const DEFAULT_GOALS: readonly Goal[] = [
  { id: 'emerg', name: 'Fondo de emergencia', monthlyUSD: null, start: null, end: null, sort: 0 },
  { id: 'personal', name: 'Ahorro personal', monthlyUSD: null, start: null, end: null, sort: 1 },
  { id: 'turquia', name: 'Viaje a Turquía', monthlyUSD: 3000, start: '2026-08', end: '2027-10', sort: 2 },
];
