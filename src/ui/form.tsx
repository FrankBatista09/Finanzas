// Fields for forms inside a <Dialog> (the goals one) and in the settings panel. Tables don't use this: their
// editors are the cells.
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
  /** Label text, already translated. */
  label: ReactNode;
  /** id of the control the label belongs to (useId()). */
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

/** Label above its control. */
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
  /** Figure: right-aligned and in JetBrains Mono. */
  mono?: boolean;
}

/** <input> with the form styling. It is a plain input: value and onChange are handled by whoever uses it. */
export function Input({ mono, className, ...rest }: InputProps) {
  return <input autoComplete="off" {...rest} className={cx(styles.control, mono && styles.mono, className)} />;
}

export interface SelectProps<T extends string = string> extends Omit<ComponentProps<'select'>, 'value' | 'onChange' | 'children'> {
  value: T;
  /** As in CellSelect: the value as is, or { value, label } when what is shown is not what is stored. */
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** JetBrains Mono (currency codes). */
  mono?: boolean;
}

/** <select> with the form styling. A value that is not among the options is kept as one more option. */
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
  /** The checkbox text, already translated. */
  children: ReactNode;
}

/** Checkbox with its text beside it. */
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
  /** Accessible name of the pair, already translated ("Start month"); each select appends "Month" or "Year" to it. */
  label: string;
  /** id of the month select, for the htmlFor of its <Field>. */
  id?: string;
  /** First and last year of the select. By default, from 5 years back to 20 ahead; the value's year is always there. */
  fromYear?: number;
  toYear?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Month and year picker: two selects, with the month names in the current language.
 * (<input type="month"> does not exist in every browser: desktop Safari and Firefox leave it as a text field.)
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
