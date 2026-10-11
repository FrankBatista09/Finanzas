import { useContext, useRef } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useI18n } from '../i18n';
import { AddRowContext } from './addRowContext';
import styles from './buttons.module.css';
import { useConfirmDelete } from './confirmDelete';
import type { DeleteKind } from './confirmDelete';
import { cx } from './cx';

export interface AddButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Por defecto "Add", en el idioma actual. */
  children?: ReactNode;
}

/**
 * Botón verde de las filas de agregar. Dentro de un <AddRow> ejecuta el onAdd de la fila: no hay que pasarle onClick
 * (si se le pasa, se usa ese y el de la fila no se llama).
 */
export function AddButton({ children, className, onClick, ...rest }: AddButtonProps) {
  const { t } = useI18n();
  const row = useContext(AddRowContext);
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (onClick) onClick(e);
    else row?.submit();
  };
  return (
    <button {...rest} type="button" className={cx(styles.add, className)} onClick={handleClick}>
      {children ?? t('add')}
    </button>
  );
}

export interface DeleteButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children' | 'title' | 'onClick'> {
  /** Nombre accesible, ya traducido; conviene decir qué se elimina (t('deleteNamed', { name })). Por defecto "Delete". */
  label?: string;
  /** Padding 4px 6px en vez de 4px 8px (tablas de envíos y aportes). */
  compact?: boolean;
  /** What is deleted, for the question "Delete {kind}?". */
  kind: DeleteKind;
  /** Short description shown in the question ("Netflix · 1,137.00 DOP"). */
  item?: string;
  /** Runs only after the user confirms. */
  onConfirm: () => void;
}

/** La × de la última columna. Pregunta antes de eliminar: solo "Delete" en el diálogo llama a onConfirm. */
export function DeleteButton({ label, compact, className, kind, item = '', onConfirm, ...rest }: DeleteButtonProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLButtonElement>(null);
  const confirm = useConfirmDelete(onConfirm);
  return (
    <>
      <button
        {...rest}
        ref={ref}
        type="button"
        title={t('delete')}
        aria-label={label ?? t('delete')}
        className={cx(styles.delete, compact && styles.compact, className)}
        // Safari does not focus a button on click: the dialog gives the focus back to this one when it closes.
        onClick={() => (ref.current?.focus(), confirm.request(item))}
      >
        ×
      </button>
      {confirm.dialog(kind)}
    </>
  );
}

/** The small icon button at the top right of a table card's header: opens the card full size in a dialog. */
export function ExpandButton({ onClick }: { onClick: (button: HTMLButtonElement) => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className={styles.expand} title={t('expand')} aria-label={t('expand')} onClick={(e) => onClick(e.currentTarget)}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 1h4v4M5 11H1V7M11 1 7.2 4.8M1 11l3.8-3.8" />
      </svg>
    </button>
  );
}
