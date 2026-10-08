import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Card.module.css';
import { cx } from './cx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Padding 14px 16px 16px, para tarjetas sin tabla. Las que llevan tabla van sin padding (la tabla llega al borde). */
  padded?: boolean;
}

/** Superficie #fffefa con borde y radio de 4px. El tamaño (flex, min-width) lo pone quien la usa con className. */
export function Card({ padded, className, children, ...rest }: CardProps) {
  return (
    <div {...rest} className={cx(styles.card, padded && styles.padded, className)}>
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Texto a la derecha (12px, atenuado). Las cifras dentro van con <Num tone="ink">. */
  meta?: ReactNode;
  /** Un control a la derecha del todo, después de `meta`: el "+ Add …" que abre la fila de agregar. */
  action?: ReactNode;
  /** Permite que título y meta se partan en dos líneas (historial de transacciones). */
  wrap?: boolean;
  /** Para tarjetas `padded`: sin padding propio y con 12px de margen inferior ("Por categoría"). */
  inset?: boolean;
  className?: string;
}

export function CardHeader({ title, meta, action, wrap, inset, className }: CardHeaderProps) {
  const shown = action != null && action !== false;
  return (
    <div className={cx(styles.header, wrap && styles.wrap, inset && styles.inset, className)}>
      <h2 className={styles.title}>{title}</h2>
      {shown ? (
        <div className={styles.side}>
          {meta != null && <div className={styles.meta}>{meta}</div>}
          {action}
        </div>
      ) : (
        meta != null && <div className={styles.meta}>{meta}</div>
      )}
    </div>
  );
}

/** Una línea de aclaración bajo la cabecera de una tarjeta (12px, atenuada): qué significa lo que se escribe en ella. */
export function CardNote({ className, children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p {...rest} className={cx(styles.note, className)}>
      {children}
    </p>
  );
}

/** Columna con 20px de separación: la raíz de cada pantalla. */
export function Stack({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx(styles.stack, className)}>
      {children}
    </div>
  );
}
