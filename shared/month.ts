import { MESES, TIMEZONE } from './constants';
import type { ISODate, MonthKey } from './types';

const KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isMonthKey(v: unknown): v is MonthKey {
  return typeof v === 'string' && KEY_RE.test(v);
}

/** Valida formato y que el día exista en ese mes (rechaza 2026-02-30). */
export function isISODate(v: unknown): v is ISODate {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCDate() === +m[3]!;
}

/** '2026-10' → 'Octubre 2026' */
export function label(key: MonthKey): string {
  const [y, m] = key.split('-');
  return `${MESES[+m! - 1]} ${y}`;
}

/** 'Octubre 2026' → '2026-10' (nombre de hoja del Excel); null si no es un mes. */
export function keyFromLabel(name: string): MonthKey | null {
  const mm = /^(\S+)\s+(\d{4})$/.exec(name.trim());
  if (!mm) return null;
  const i = (MESES as readonly string[]).indexOf(mm[1]!);
  return i < 0 ? null : `${mm[2]}-${String(i + 1).padStart(2, '0')}`;
}

export function nextKey(key: MonthKey): MonthKey {
  let [y, m] = key.split('-').map(Number) as [number, number];
  m++;
  if (m > 12) {
    m = 1;
    y++;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function prevKey(key: MonthKey): MonthKey {
  let [y, m] = key.split('-').map(Number) as [number, number];
  m--;
  if (m < 1) {
    m = 12;
    y--;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** '2026-10-07' → '2026-10' */
export function monthOf(date: ISODate): MonthKey {
  return date.slice(0, 7);
}

/** Meses entre dos claves, ambos incluidos ('2026-08'..'2027-10' → 15). */
export function monthSpan(start: MonthKey, end: MonthKey): number {
  const [sy, sm] = start.split('-').map(Number) as [number, number];
  const [ey, em] = end.split('-').map(Number) as [number, number];
  return (ey - sy) * 12 + (em - sm) + 1;
}

/** Fecha de hoy en la zona horaria del usuario (no la del servidor ni UTC). */
export function todayISO(now: Date = new Date(), timeZone: string = TIMEZONE): ISODate {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function currentMonthKey(now: Date = new Date(), timeZone: string = TIMEZONE): MonthKey {
  return monthOf(todayISO(now, timeZone));
}
