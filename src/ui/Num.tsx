import type { HTMLAttributes } from 'react';
import { cx } from './cx';
import type { Tone } from './cx';
import styles from './Num.module.css';

export interface NumProps extends HTMLAttributes<HTMLSpanElement> {
  /** 'ink' forces the ink color inside muted text (the figures in the cards' meta). Without a tone, it inherits. */
  tone?: Tone | 'ink';
  weight?: 500 | 600;
}

/** Figure: JetBrains Mono with tabular-nums. It inherits its size from wherever it is. The text comes preformatted (f2/f0/fRate). */
export function Num({ tone, weight, className, children, ...rest }: NumProps) {
  return (
    <span {...rest} className={cx(styles.num, tone && styles[tone], weight && styles[`w${weight}`], className)}>
      {children}
    </span>
  );
}
