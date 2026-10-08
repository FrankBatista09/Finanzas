// La fila de agregar a petición: ninguna tabla enseña ya una fila vacía con sus placeholders. En su lugar hay un
// botón "+ Add …" (en la cabecera de la tarjeta o junto al marco de la tabla); al pulsarlo aparece la fila con el
// foco en su primer campo. Enter o su botón "Add" guardan y la dejan abierta para la siguiente; Esc o el mismo
// botón de arriba (que pasa a decir "Cancel") la cierran y descartan lo escrito.
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

/** El estado de una fila de agregar. `onDiscard` limpia el borrador cuando la fila se cierra sin guardar. */
export function useAddRow(onDiscard?: () => void): AddRowControl {
  const [open, setOpen] = useState(useContext(AddRowsOpenContext));
  const buttonRef = useRef<HTMLButtonElement>(null);
  return {
    open,
    show: () => setOpen(true),
    hide: () => {
      setOpen(false);
      onDiscard?.();
      // El campo con el foco desaparece con la fila: el foco vuelve al botón que la abrió.
      buttonRef.current?.focus();
    },
    buttonRef,
  };
}

export interface AddRowButtonProps {
  control: AddRowControl;
  /** Qué se agrega, ya traducido: "Add transfer". El "+" lo pone el botón. */
  children: ReactNode;
  /** 'link': texto sin caja, para las tablas pequeñas con marco propio (cuentas, partes del presupuesto). */
  variant?: 'button' | 'link';
  className?: string;
}

/** El botón que abre la fila de agregar; con la fila abierta es su "Cancel". */
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
