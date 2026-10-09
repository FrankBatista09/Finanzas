// Marcado de tabla del prototipo: <table> real con th scope="col". Las pantallas escriben thead/tbody a mano.

import { useEffect, useRef } from 'react';
import type { HTMLAttributes, KeyboardEvent, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { useI18n } from '../i18n';
import { AddRowContext, addRowKeyAction } from './addRowContext';
import type { AddRowApi, AddRowControl } from './addRowContext';
import { cx } from './cx';
import type { Tone } from './cx';
import { useExpanded } from './expandContext';
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
  /** Extra class for the scroll wrapper (e.g. to let it shrink and scroll vertically inside a height-capped card). */
  scrollClassName?: string;
  children: ReactNode;
}

/** <table> dentro de su contenedor con scroll horizontal. */
export function SheetTable({ minWidth, label, className, scrollClassName, children }: SheetTableProps) {
  const expanded = useExpanded();
  return (
    <div className={cx(styles.scroll, scrollClassName)}>
      <table className={cx(styles.table, className)} style={minWidth && !expanded ? { minWidth } : undefined} aria-label={label}>
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
  /** The column that absorbs the table's surplus width (the others keep their content size). Expanded, all columns share it as before. */
  elastic?: boolean;
}

export function Th({ align, width, last, blank, elastic, className, style, children, ...rest }: ThProps) {
  const { t } = useI18n();
  // Expanded, columns size to their content and share the extra room instead of keeping the card's narrow widths.
  const expanded = useExpanded();
  return (
    <th
      scope="col"
      aria-label={blank ? t('actions') : undefined}
      {...rest}
      className={cx(styles.th, alignClass(align), last && styles.last, blank && styles.thBlank, elastic && !expanded && styles.elastic, className)}
      style={width && !expanded ? { width, ...style } : style}
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
  const expanded = useExpanded();
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
        expanded && styles.full,
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
  /**
   * La fila se abre a petición (useAddRow + <AddRowButton>): cerrada no se pinta; al abrirla el foco va a su primer
   * campo y Esc la cierra. Sin él, la fila está siempre a la vista.
   */
  control?: AddRowControl;
}

/**
 * El campo en el que se empieza a escribir una fila nueva: el primero que no sea la fecha (ya trae la de hoy) ni
 * una casilla. Un campo con sugerencias (la vía de un envío) conserva su valor de una fila a la siguiente, así
 * que tampoco es lo que toca escribir: se salta, salvo que no haya otro. Sin campos de texto, la primera lista.
 */
function firstField(row: HTMLTableRowElement | null): HTMLElement | null {
  const typed = 'input:not([type="date"]):not([type="checkbox"])';
  return (
    row?.querySelector<HTMLElement>(`${typed}:not([list])`) ?? row?.querySelector<HTMLElement>(typed) ?? row?.querySelector<HTMLElement>('select') ?? null
  );
}

/** Fila para agregar: fondo #f9f8f3 y borde inferior #e3e1d8 en sus celdas. */
export function AddRow({ control, ...rest }: AddRowProps) {
  // Cerrada no hay fila. Abrirla la monta de nuevo: de ahí que el foco inicial vaya en un efecto de montaje.
  if (control && !control.open) return null;
  return <OpenAddRow control={control} {...rest} />;
}

function OpenAddRow({ onAdd, control, className, children, ...rest }: AddRowProps) {
  const ref = useRef<HTMLTableRowElement>(null);

  // Solo las filas que se abren a petición piden el foco: es la respuesta al clic en "+ Add …".
  const closable = control !== undefined;
  useEffect(() => {
    if (closable) firstField(ref.current)?.focus();
  }, [closable]);

  const api: AddRowApi = {
    submit() {
      if (onAdd() === false) return;
      // Soltar el foco descarta el borrador local de la celda (la pantalla acaba de limpiar el suyo);
      // después se deja el cursor en el primer campo, listo para la siguiente fila.
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      firstField(ref.current)?.focus();
    },
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    const action = addRowKeyAction({
      key: e.key,
      isComposing: e.nativeEvent.isComposing,
      inInput: e.target instanceof HTMLInputElement,
      closable,
    });
    if (!action) return;
    e.preventDefault();
    if (action === 'submit') api.submit();
    else control?.hide();
  };

  return (
    <AddRowContext value={api}>
      <tr {...rest} ref={ref} className={cx(styles.addRow, className)} onKeyDown={onKeyDown}>
        {children}
      </tr>
    </AddRowContext>
  );
}
