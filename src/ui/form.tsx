// Campos para formularios dentro de un <Dialog> (el de metas) y del panel de ajustes. Las tablas no usan esto: sus
// editores son las celdas.
//
//   const nameId = useId();
//   <DialogFields>
//     <Field label={s('name')} htmlFor={nameId}><Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} /></Field>
//     <Field label={t('currency')} htmlFor={curId}><Select id={curId} value={cur} options={CURRENCIES} onChange={setCur} mono /></Field>
//     <CheckField checked={planned} onChange={setPlanned}>{s('hasTarget')}</CheckField>
//     <Field label={s('startMonth')} htmlFor={startId}><MonthPicker id={startId} label={s('startMonth')} value={start} onChange={setStart} /></Field>
//   </DialogFields>

import type { ComponentProps, ReactNode } from 'react';
import { currentMonthKey, isMonthKey } from '../../shared/month';
import type { MonthKey } from '../../shared/types';
import { useI18n } from '../i18n';
import type { SelectOption } from './cells';
import { cx } from './cx';
import styles from './form.module.css';

export interface FieldProps {
  /** Texto de la etiqueta, ya traducido. */
  label: ReactNode;
  /** id del control al que pertenece la etiqueta (useId()). */
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

/** Etiqueta encima de su control. */
export function Field({ label, htmlFor, className, children }: FieldProps) {
  return (
    <div className={cx(styles.field, className)}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

export interface InputProps extends ComponentProps<'input'> {
  /** Cifra: alineada a la derecha y en JetBrains Mono. */
  mono?: boolean;
}

/** <input> con el estilo de los formularios. Es un input corriente: value y onChange los lleva quien lo usa. */
export function Input({ mono, className, ...rest }: InputProps) {
  return <input autoComplete="off" {...rest} className={cx(styles.control, mono && styles.mono, className)} />;
}

export interface SelectProps<T extends string = string> extends Omit<ComponentProps<'select'>, 'value' | 'onChange' | 'children'> {
  value: T;
  /** Como en CellSelect: el valor tal cual o { value, label } cuando lo que se ve no es lo que se guarda. */
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** JetBrains Mono (códigos de moneda). */
  mono?: boolean;
}

/** <select> con el estilo de los formularios. Un valor que no esté entre las opciones se conserva como una más. */
export function Select<T extends string = string>({ value, options, onChange, mono, className, ...rest }: SelectProps<T>) {
  const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o as string } : o));
  if (!items.some((o) => o.value === value)) items.unshift({ value, label: value });
  return (
    <select {...rest} className={cx(styles.control, mono && styles.selectMono, className)} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {items.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export interface CheckFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  /** El texto de la casilla, ya traducido. */
  children: ReactNode;
}

/** Casilla con su texto al lado. */
export function CheckField({ checked, onChange, disabled, className, children }: CheckFieldProps) {
  return (
    <label className={cx(styles.check, className)}>
      <input type="checkbox" className={styles.checkbox} checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>{children}</span>
    </label>
  );
}

export interface MonthPickerProps {
  value: MonthKey;
  onChange: (value: MonthKey) => void;
  /** Nombre accesible del par, ya traducido ("Start month"); cada lista le añade "Month" o "Year". */
  label: string;
  /** id de la lista de meses, para el htmlFor de su <Field>. */
  id?: string;
  /** Primer y último año de la lista. Por defecto, de 5 años atrás a 20 adelante; el año del valor está siempre. */
  fromYear?: number;
  toYear?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Selector de mes y año: dos listas, con los nombres de los meses en el idioma actual.
 * (<input type="month"> no existe en todos los navegadores: Safari y Firefox de escritorio lo dejan en un campo de texto.)
 */
export function MonthPicker({ value, onChange, label, id, fromYear, toYear, disabled, className }: MonthPickerProps) {
  const { t, monthNames } = useI18n();
  const today = currentMonthKey();
  const [year, month] = (isMonthKey(value) ? value : today).split('-').map(Number) as [number, number];
  const thisYear = +today.slice(0, 4);
  const first = Math.min(fromYear ?? thisYear - 5, year);
  const last = Math.max(toYear ?? thisYear + 20, year);
  const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const pick = (y: number, m: number) => onChange(`${y}-${String(m).padStart(2, '0')}`);

  return (
    <div className={cx(styles.monthPicker, className)} role="group" aria-label={label}>
      <select
        id={id}
        className={styles.control}
        value={month}
        onChange={(e) => pick(year, +e.target.value)}
        disabled={disabled}
        aria-label={`${label}: ${t('month')}`}
      >
        {monthNames.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </select>
      <select
        className={styles.control}
        value={year}
        onChange={(e) => pick(+e.target.value, month)}
        disabled={disabled}
        aria-label={`${label}: ${t('year')}`}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}
