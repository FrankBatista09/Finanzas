// Marcado de tabla del prototipo: <table> real con th scope="col". Las pantallas escriben thead/tbody a mano.

import { useRef } from 'react';
import type { HTMLAttributes, KeyboardEvent, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { useI18n } from '../i18n';
import { AddRowContext } from './addRowContext';
import type { AddRowApi } from './addRowContext';
import { cx } from './cx';
import type { Tone } from './cx';
import styles from './table.module.css';

type Align = 'left' | 'right' | 'center';

const alignClass = (align: Align | undefined) => (align === 'right' ? styles.right : align === 'center' ? styles.alignCenter : undefined);

// ── Tabla ────────────────────────────────────────────────────────────────────

export interface SheetTableProps {
  /** Ancho mínimo en px; por debajo aparece el scroll horizontal (980 en el historial). */
  minWidth?: number;
  /** Nombre accesible de la tabla. */
  label?: string;
  className?: string;
  children: ReactNode;
}

/** <table> dentro de su contenedor con scroll horizontal. */
export function SheetTable({ minWidth, label, className, children }: SheetTableProps) {
  return (
    <div className={styles.scroll}>
      <table className={cx(styles.table, className)} style={minWidth ? { minWidth } : undefined} aria-label={label}>
        {children}
      </table>
    </div>
  );
}

// ── Encabezado ───────────────────────────────────────────────────────────────

export interface ThProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'align' | 'width'> {
  align?: Align;
  /** Ancho en px del contenido, como en el prototipo (el padding se suma). */
  width?: number;
  /** Última columna con título: sin borde derecho. */
  last?: boolean;
  /** Columna sin título (la de eliminar): sin padding ni borde derecho. */
  blank?: boolean;
}

export function Th({ align, width, last, blank, className, style, children, ...rest }: ThProps) {
  const { t } = useI18n();
  return (
    <th
      scope="col"
      aria-label={blank ? t('actions') : undefined}
      {...rest}
      className={cx(styles.th, alignClass(align), last && styles.last, blank && styles.thBlank, className)}
      style={width ? { width, ...style } : style}
    >
      {children}
    </th>
  );
}

// ── Celda ────────────────────────────────────────────────────────────────────

/**
 * text    texto con padding de celda (por defecto)
 * num     cifra calculada: derecha, JetBrains Mono 12.5px
 * mono    texto en JetBrains Mono 12px (fecha corta, moneda)
 * edit    sin padding: dentro va un editor Cell*
 * center  centrado sin padding: casilla "Pagado" o el "+" de la fila de agregar
 * action  última columna: botón de eliminar (sin borde derecho)
 * add     celda del botón "Add" (sin borde derecho; suele llevar colSpan)
 */
export type TdKind = 'text' | 'num' | 'mono' | 'edit' | 'center' | 'action' | 'add';

export interface TdProps extends Omit<TdHTMLAttributes<HTMLTableCellElement>, 'align'> {
  kind?: TdKind;
  align?: Align;
  tone?: Tone;
  nowrap?: boolean;
  /** Peso 500 (la columna DOP del historial). */
  medium?: boolean;
  /** Última columna: sin borde derecho. */
  last?: boolean;
}

export function Td({ kind = 'text', align, tone, nowrap, medium, last, className, children, ...rest }: TdProps) {
  return (
    <td
      {...rest}
      className={cx(
        styles.td,
        kind !== 'text' && styles[kind],
        alignClass(align),
        nowrap && styles.nowrap,
        medium && styles.medium,
        last && styles.last,
        tone && styles[tone],
        className,
      )}
    >
      {children}
    </td>
  );
}

// ── Filas ────────────────────────────────────────────────────────────────────

export interface TrProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Gasto fijo sin pagar: fondo #fbfaf5. */
  unpaid?: boolean;
}

export function Tr({ unpaid, className, children, ...rest }: TrProps) {
  return (
    <tr {...rest} className={cx(unpaid && styles.unpaid, className)}>
      {children}
    </tr>
  );
}

export interface AddRowProps extends Omit<HTMLAttributes<HTMLTableRowElement>, 'onKeyDown'> {
  /**
   * Agrega la fila con el borrador actual. Devuelve false si no se agregó (faltan datos): el foco se queda donde está.
   * La llaman Enter en cualquier input de la fila y el <AddButton /> que haya dentro.
   */
  onAdd: () => boolean | void;
}

/** Fila para agregar: fondo #f9f8f3 y borde inferior #e3e1d8 en sus celdas. */
export function AddRow({ onAdd, className, children, ...rest }: AddRowProps) {
  const ref = useRef<HTMLTableRowElement>(null);

  const api: AddRowApi = {
    submit(fromKeyboard) {
      if (onAdd() === false || !fromKeyboard) return;
      // Soltar el foco descarta el borrador local de la celda (la pantalla acaba de limpiar el suyo);
      // después se deja el cursor en el primer campo que no sea la fecha, listo para la siguiente fila.
      // Un campo con sugerencias (la vía de un envío) conserva su valor de una fila a la siguiente, así que
      // tampoco es lo que toca escribir: se salta, salvo que no haya otro.
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      const typed = 'input:not([type="date"]):not([type="checkbox"])';
      const row = ref.current;
      (row?.querySelector<HTMLInputElement>(`${typed}:not([list])`) ?? row?.querySelector<HTMLInputElement>(typed))?.focus();
    },
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    // Los select y el botón ya tienen su propio Enter.
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    api.submit(true);
  };

  return (
    <AddRowContext value={api}>
      <tr {...rest} ref={ref} className={cx(styles.addRow, className)} onKeyDown={onKeyDown}>
        {children}
      </tr>
    </AddRowContext>
  );
}
