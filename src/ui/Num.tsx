import type { HTMLAttributes } from 'react';
import { cx } from './cx';
import type { Tone } from './cx';
import styles from './Num.module.css';

export interface NumProps extends HTMLAttributes<HTMLSpanElement> {
  /** 'ink' fuerza la tinta dentro de un texto atenuado (las cifras de la meta de las tarjetas). Sin tono, hereda. */
  tone?: Tone | 'ink';
  weight?: 500 | 600;
}

/** Cifra: JetBrains Mono con tabular-nums. El tamaño lo hereda de donde esté. El texto va ya formateado (f2/f0/fRate). */
export function Num({ tone, weight, className, children, ...rest }: NumProps) {
  return (
    <span {...rest} className={cx(styles.num, tone && styles[tone], weight && styles[`w${weight}`], className)}>
      {children}
    </span>
  );
}
