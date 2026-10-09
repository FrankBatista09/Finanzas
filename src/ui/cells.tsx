// Editores de celda tipo hoja de cálculo (README, "Celdas tipo hoja de cálculo").
// Todos avisan con onCommit(valor): quien los usa decide qué hacer (la capa de datos ya agrupa y retrasa el guardado).

import { useContext, useId } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { parseAmount } from '../../shared/format';
import { isISODate } from '../../shared/month';
import type { ISODate } from '../../shared/types';
import { AddRowContext } from './addRowContext';
import styles from './cells.module.css';
import { cx } from './cx';
import type { Tone } from './cx';
import { useExpanded } from './expandContext';
import { useDraft } from './useDraft';
import type { CommitOn } from './useDraft';

interface CellBase {
  /** Nombre accesible (aria-label): las celdas no tienen etiqueta visible. */
  label: string;
  /** Ancho mínimo en px. */
  minWidth?: number;
  tone?: Tone;
  className?: string;
}

interface InputBase extends CellBase {
  /** Mes cerrado: se puede enfocar y copiar, no editar. */
  readOnly?: boolean;
  placeholder?: string;
}

const tone = (t: Tone | undefined) => (t ? styles[t] : undefined);
const width = (minWidth: number | undefined) => (minWidth ? { minWidth } : undefined);
const same = (text: string) => text;

// ── Texto ────────────────────────────────────────────────────────────────────

export interface CellTextProps extends InputBase {
  value: string;
  onCommit?: (value: string) => void;
  /** JetBrains Mono 12.5px (columna "Día"). */
  mono?: boolean;
  /** 12.5px en la fuente de la UI (columna "Notas"). */
  small?: boolean;
  /** Tope de caracteres (el servidor rechaza textos más largos). */
  maxLength?: number;
  /** Valores que el navegador ofrece al escribir (un <datalist>). El campo sigue siendo texto libre: la vía de un envío. */
  suggestions?: readonly string[];
  /** 'blur' para textos obligatorios: lo borrado a medias nunca se guarda (ni "N" al vaciar "Netflix"). */
  commitOn?: CommitOn;
}

export function CellText({
  value,
  onCommit,
  label,
  readOnly,
  placeholder,
  minWidth,
  tone: t,
  mono,
  small,
  maxLength,
  suggestions,
  commitOn,
  className,
}: CellTextProps) {
  const draft = useDraft({ value, format: same, parse: same, onCommit, commitOn });
  const listId = useId();
  const expanded = useExpanded();
  const offers = suggestions && suggestions.length > 0 && !readOnly;
  return (
    <>
      <input
        ref={draft.ref}
        type="text"
        className={cx(styles.input, mono && styles.mono, small && styles.small, expanded && styles.fit, tone(t), className)}
        style={width(minWidth)}
        value={draft.value}
        onChange={draft.onChange}
        onBlur={draft.onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') draft.commitNow();
        }}
        readOnly={readOnly}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-label={label}
        autoComplete="off"
        list={offers ? listId : undefined}
      />
      {offers && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
}

// ── Número ───────────────────────────────────────────────────────────────────

export interface NumberFieldProps {
  value: number;
  onCommit?: (value: number) => void;
  /** Muestra el campo vacío (con su placeholder) cuando el valor es 0. Para las filas de agregar. */
  blankZero?: boolean;
  /** Por defecto: 'change' con `blankZero` (filas de agregar) y 'blur' en el resto. Un valor guardado que se ve vacío en 0 (la comisión de un envío) pide 'blur'. */
  commitOn?: CommitOn;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  id?: string;
  'aria-label'?: string;
}

/**
 * <input type="number"> con borrador local y sin estilos propios: lo usan CellNumber y los campos sueltos
 * del panel resumen. Vacío o inválido se confirma como 0 (shared/format parseAmount).
 */
export function NumberField({ value, onCommit, blankZero, commitOn, ...rest }: NumberFieldProps) {
  const draft = useDraft({
    value,
    format: (v: number) => (blankZero && !v ? '' : String(v)),
    // Con algo a medio escribir que aún no es un número ("-", "1e") el navegador entrega '' y marca badInput:
    // no es un 0, así que no se confirma nada todavía.
    parse: (text, input) => (input?.validity.badInput ? undefined : parseAmount(text)),
    onCommit,
    // Una celda con valor guardado se confirma al salir: así un número a medio escribir o mal escrito ("12a")
    // nunca deja guardada la parte válida que había antes. Las filas de agregar siguen confirmando al teclear.
    commitOn: commitOn ?? (blankZero ? 'change' : 'blur'),
  });
  return (
    <input
      ref={draft.ref}
      type="number"
      step="any"
      inputMode="decimal"
      value={draft.value}
      onChange={draft.onChange}
      onBlur={draft.onBlur}
      // Las flechas y la rueda del ratón suben o bajan el número de un input numérico, y ese cambio se guardaría
      // solo: en una celda de dinero es un cambio que nadie pidió.
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
        else if (e.key === 'Enter') draft.commitNow();
      }}
      onWheel={(e) => e.currentTarget.blur()}
      autoComplete="off"
      {...rest}
    />
  );
}

export interface CellNumberProps extends InputBase {
  value: number;
  onCommit?: (value: number) => void;
  /** Vacío cuando el valor es 0 (filas de agregar: así se ve el placeholder). */
  blankZero?: boolean;
  /** Ver NumberFieldProps.commitOn. */
  commitOn?: CommitOn;
  /** Padding lateral de 8px en vez de 10px (tabla de envíos). */
  dense?: boolean;
}

export function CellNumber({ label, minWidth, tone: t, dense, className, ...rest }: CellNumberProps) {
  const expanded = useExpanded();
  return (
    <NumberField
      {...rest}
      aria-label={label}
      className={cx(styles.input, styles.number, dense && styles.dense, expanded && styles.fit, tone(t), className)}
      style={width(minWidth)}
    />
  );
}

// ── Fecha ────────────────────────────────────────────────────────────────────

export interface CellDateProps extends Omit<InputBase, 'placeholder'> {
  value: ISODate;
  onCommit?: (value: ISODate) => void;
  /**
   * Por defecto: 'change' dentro de un <AddRow> y 'blur' en el resto. En una tabla ordenada por fecha, confirmar en
   * cada cambio movería la fila (y le quitaría el foco) a media edición; al salir de la celda o con Enter no.
   */
  commitOn?: CommitOn;
}

export function CellDate({ value, onCommit, label, readOnly, minWidth, tone: t, commitOn, className }: CellDateProps) {
  const inAddRow = useContext(AddRowContext) !== null;
  const draft = useDraft<ISODate>({
    value,
    format: same,
    // Una fecha a medio escribir llega como '' y no se confirma: se conserva la anterior.
    parse: (text) => (isISODate(text) ? text : undefined),
    onCommit,
    commitOn: commitOn ?? (inAddRow ? 'change' : 'blur'),
  });
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') draft.commitNow();
  };
  return (
    <input
      ref={draft.ref}
      type="date"
      className={cx(styles.input, styles.date, tone(t), className)}
      style={width(minWidth)}
      value={draft.value}
      onChange={draft.onChange}
      onBlur={draft.onBlur}
      onKeyDown={onKeyDown}
      readOnly={readOnly}
      aria-label={label}
    />
  );
}

// ── Lista ────────────────────────────────────────────────────────────────────

export type SelectOption<T extends string = string> = T | { value: T; label: string };

export interface CellSelectProps<T extends string = string> extends CellBase {
  value: T;
  options: readonly SelectOption<T>[];
  onCommit?: (value: T) => void;
  /** Mes cerrado. (Un <select> no admite readOnly.) */
  disabled?: boolean;
  /** JetBrains Mono 12px (columnas de moneda). */
  mono?: boolean;
  /** Padding lateral de 8px en vez de 10px. */
  dense?: boolean;
}

export function CellSelect<T extends string = string>({
  value,
  options,
  onCommit,
  label,
  disabled,
  minWidth,
  tone: t,
  mono,
  dense,
  className,
}: CellSelectProps<T>) {
  const expanded = useExpanded();
  const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o as string } : o));
  // Un valor que no está en la lista (una categoría importada del Excel) se muestra tal cual en vez de
  // aparentar que es la primera opción.
  if (!items.some((o) => o.value === value)) items.unshift({ value, label: value });
  return (
    <select
      className={cx(styles.select, mono && styles.selectMono, dense && styles.dense, expanded && styles.fit, tone(t), className)}
      style={width(minWidth)}
      value={value}
      onChange={(e) => onCommit?.(e.target.value as T)}
      disabled={disabled}
      aria-label={label}
    >
      {items.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Casilla ──────────────────────────────────────────────────────────────────

export interface CellCheckboxProps {
  checked: boolean;
  onCommit?: (checked: boolean) => void;
  /** Nombre accesible (aria-label). */
  label: string;
  disabled?: boolean;
  className?: string;
  /** Casilla a medias (guion): algo hecho pero no todo. Solo se ve cuando `checked` es false. */
  indeterminate?: boolean;
}

export function CellCheckbox({ checked, onCommit, label, disabled, className, indeterminate }: CellCheckboxProps) {
  return (
    <input
      type="checkbox"
      // `indeterminate` no es un atributo: solo se fija por la propiedad del elemento (y se repone tras cada clic).
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked;
      }}
      className={cx(styles.checkbox, className)}
      checked={checked}
      onChange={(e) => onCommit?.(e.target.checked)}
      disabled={disabled}
      aria-label={label}
    />
  );
}
