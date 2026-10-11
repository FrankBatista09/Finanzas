import { useContext, useRef } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useI18n } from '../i18n';
import { AddRowContext } from './addRowContext';
import styles from './buttons.module.css';
import { useConfirmDelete } from './confirmDelete';
import type { DeleteKind } from './confirmDelete';
import { cx } from './cx';

export interface AddButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** By default "Add", in the current language. */
  children?: ReactNode;
}

/**
 * Green button of the add rows. Inside an <AddRow> it runs the row's onAdd: there is no need to pass it onClick
 * (if one is passed, that one is used and the row's is not called).
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
  /** Accessible name, already translated; it is best to say what is deleted (t('deleteNamed', { name })). By default "Delete". */
  label?: string;
  /** Padding 4px 6px instead of 4px 8px (transfers and contributions tables). */
  compact?: boolean;
  /** What is deleted, for the question "Delete {kind}?". */
  kind: DeleteKind;
  /** Short description shown in the question ("Netflix · 1,137.00 DOP"). */
  item?: string;
  /** Runs only after the user confirms. */
  onConfirm: () => void;
}

/** The × in the last column. It asks before deleting: only "Delete" in the dialog calls onConfirm. */
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
