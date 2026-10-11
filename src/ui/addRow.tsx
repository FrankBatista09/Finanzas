// The on-demand add row: no table shows an empty row with its placeholders anymore. Instead there is a
// "+ Add …" button (in the card's header or next to the table's frame); pressing it shows the row with the
// focus on its first field. Enter or its "Add" button saves and leaves it open for the next one; Esc or the same
// button at the top (which now says "Cancel") closes it and discards what was typed.
//
//   const adding = useAddRow(() => setDraft(EMPTY));
//   <CardHeader title="…" action={!readOnly && <AddRowButton control={adding}>{s('addFixed')}</AddRowButton>} />
//   …
//   {!readOnly && <AddRow control={adding} onAdd={add}>…</AddRow>}

import { useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { AddRowsOpenContext } from './addRowContext';
import type { AddRowControl } from './addRowContext';
import styles from './buttons.module.css';
import { cx } from './cx';

/** The state of an add row. `onDiscard` clears the draft when the row is closed without saving. */
export function useAddRow(onDiscard?: () => void): AddRowControl {
  const [open, setOpen] = useState(useContext(AddRowsOpenContext));
  const buttonRef = useRef<HTMLButtonElement>(null);
  return {
    open,
    show: () => setOpen(true),
    hide: () => {
      setOpen(false);
      onDiscard?.();
      // The focused field disappears with the row: the focus goes back to the button that opened it.
      buttonRef.current?.focus();
    },
    buttonRef,
  };
}

export interface AddRowButtonProps {
  control: AddRowControl;
  /** What is added, already translated: "Add transfer". The button adds the "+". */
  children: ReactNode;
  /** 'link': text without a box, for the small tables with their own frame (accounts, budget parts). */
  variant?: 'button' | 'link';
  className?: string;
}

/** The button that opens the add row; with the row open it is its "Cancel". */
export function AddRowButton({ control, children, variant = 'button', className }: AddRowButtonProps) {
  const { t } = useI18n();
  return (
    <button
      ref={control.buttonRef}
      type="button"
      className={cx(variant === 'link' ? styles.reveal : styles.revealButton, className)}
      aria-expanded={control.open}
      onClick={control.open ? control.hide : control.show}
    >
      {control.open ? t('cancel') : <>+ {children}</>}
    </button>
  );
}
