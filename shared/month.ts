import { TIMEZONE } from './constants';
import { MONTH_NAMES } from './i18n';
import type { ISODate, Language, MonthKey } from './types';

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
  // Un año de dos cifras tecleado en una celda (0026) o absurdo no es una fecha de estas finanzas, y Excel
  // no sabe representar nada anterior a 1900.
  if (+m[1]! < 1900 || +m[1]! > 2100) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCDate() === +m[3]!;
}

/** '2026-10' → 'October 2026' (o 'Octubre 2026', 'Ekim 2026' según el idioma). */
export function label(key: MonthKey, lang: Language = 'en'): string {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[lang][+m! - 1]} ${y}`;
}

/**
 * 'October 2026' → '2026-10' (nombre de hoja del Excel); null si no es un mes.
 * Sin `months` reconoce el nombre del mes en cualquiera de los idiomas de la app.
 */
export function keyFromLabel(name: string, months?: readonly string[]): MonthKey | null {
  const mm = /^(\S+)\s+(\d{4})$/.exec(name.trim());
  if (!mm) return null;
  const lists = months ? [months] : Object.values(MONTH_NAMES);
  for (const list of lists) {
    const i = list.indexOf(mm[1]!);
    if (i >= 0) return `${mm[2]}-${String(i + 1).padStart(2, '0')}`;
  }
  return null;
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

/** Primer día del mes: '2026-10' → '2026-10-01'. */
export function firstDay(key: MonthKey): ISODate {
  return `${key}-01`;
}

/** Último día del mes: '2026-02' → '2026-02-28'. */
export function lastDay(key: MonthKey): ISODate {
  const [y, m] = key.split('-').map(Number) as [number, number];
  // El día 0 del mes siguiente es el último de este.
  return `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** true si la fecha cae dentro de ese mes. */
export function inMonth(date: ISODate, key: MonthKey): boolean {
  return monthOf(date) === key;
}

/** La fecha si cae en el mes; si es anterior, el primer día del mes; si es posterior, el último. */
export function clampToMonth(date: ISODate, key: MonthKey): ISODate {
  const k = monthOf(date);
  return k === key ? date : k < key ? firstDay(key) : lastDay(key);
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
