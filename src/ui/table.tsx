// Table markup from the prototype: a real <table> with th scope="col". The screens write thead/tbody by hand.

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

// ── Table ────────────────────────────────────────────────────────────────────

export interface SheetTableProps {
  /** Minimum width in px; below it the horizontal scroll appears (980 in the history). */
  minWidth?: number;
  /** Accessible name of the table. */
  label?: string;
  className?: string;
  /** Extra class for the scroll wrapper (e.g. to let it shrink and scroll vertically inside a height-capped card). */
  scrollClassName?: string;
  children: ReactNode;
}

/** <table> inside its horizontally scrolling container. */
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

// ── Header ───────────────────────────────────────────────────────────────────

export interface ThProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, 'align' | 'width'> {
  align?: Align;
  /** Content width in px, as in the prototype (the padding is added on top). */
  width?: number;
  /** Last titled column: no right border. */
  last?: boolean;
  /** Untitled column (the delete one): no padding and no right border. */
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

// ── Cell ─────────────────────────────────────────────────────────────────────

/**
 * text    text with cell padding (default)
 * num     computed figure: right-aligned, JetBrains Mono 12.5px
 * mono    text in JetBrains Mono 12px (short date, currency)
 * edit    no padding: a Cell* editor goes inside
 * center  centered with no padding: "Paid" checkbox or the "+" of the add row
 * action  last column: delete button (no right border)
 * add     cell of the "Add" button (no right border; usually takes a colSpan)
 */
export type TdKind = 'text' | 'num' | 'mono' | 'edit' | 'center' | 'action' | 'add';

export interface TdProps extends Omit<TdHTMLAttributes<HTMLTableCellElement>, 'align'> {
  kind?: TdKind;
  align?: Align;
  tone?: Tone;
  nowrap?: boolean;
  /** Weight 500 (the DOP column of the history). */
  medium?: boolean;
  /** Last column: no right border. */
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

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface TrProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Unpaid fixed expense: background #fbfaf5. */
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
   * Adds the row with the current draft. Returns false if it was not added (data is missing): the focus stays where it is.
   * It is called by Enter in any input of the row and by any <AddButton /> inside it.
   */
  onAdd: () => boolean | void;
  /**
   * The row opens on demand (useAddRow + <AddRowButton>): closed, it is not rendered; on opening, the focus goes to its
   * first field and Esc closes it. Without a control, the row is always in view.
   */
  control?: AddRowControl;
}

/**
 * The field where typing a new row starts: the first one that is neither the date (it already holds today's) nor
 * a checkbox. A field with suggestions (the via of a transfer) keeps its value from one row to the next, so
 * it is not what needs typing either: it is skipped, unless there is no other. With no text fields, the first select.
 */
function firstField(row: HTMLTableRowElement | null): HTMLElement | null {
  const typed = 'input:not([type="date"]):not([type="checkbox"])';
  return (
    row?.querySelector<HTMLElement>(`${typed}:not([list])`) ?? row?.querySelector<HTMLElement>(typed) ?? row?.querySelector<HTMLElement>('select') ?? null
  );
}

/** Add row: background #f9f8f3 and bottom border #e3e1d8 on its cells. */
export function AddRow({ control, ...rest }: AddRowProps) {
  // Closed, there is no row. Opening it mounts it again: hence the initial focus goes in a mount effect.
  if (control && !control.open) return null;
  return <OpenAddRow control={control} {...rest} />;
}

function OpenAddRow({ onAdd, control, className, children, ...rest }: AddRowProps) {
  const ref = useRef<HTMLTableRowElement>(null);

  // Only rows that open on demand ask for the focus: it is the response to the click on "+ Add …".
  const closable = control !== undefined;
  useEffect(() => {
    if (closable) firstField(ref.current)?.focus();
  }, [closable]);

  const api: AddRowApi = {
    submit() {
      if (onAdd() === false) return;
      // Dropping the focus discards the cell's local draft (the screen has just cleared its own);
      // then the cursor is left in the first field, ready for the next row.
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
