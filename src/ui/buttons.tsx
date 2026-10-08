import { useContext } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useI18n } from '../i18n';
import { AddRowContext } from './addRowContext';
import styles from './buttons.module.css';
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

export interface DeleteButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children' | 'title'> {
  /** Nombre accesible, ya traducido; conviene decir qué se elimina (t('deleteNamed', { name })). Por defecto "Delete". */
  label?: string;
  /** Padding 4px 6px en vez de 4px 8px (tablas de envíos y aportes). */
  compact?: boolean;
}

/** La × de la última columna. */
export function DeleteButton({ label, compact, className, ...rest }: DeleteButtonProps) {
  const { t } = useI18n();
  return (
    <button
      {...rest}
      type="button"
      title={t('delete')}
      aria-label={label ?? t('delete')}
      className={cx(styles.delete, compact && styles.compact, className)}
    >
      ×
    </button>
  );
}
