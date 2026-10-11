import { useContext } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Card.module.css';
import { cx } from './cx';
import { ExpandedContext, ExpandOpenContext } from './expandContext';
import { ExpandButton } from './buttons';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Padding 14px 16px 16px, for cards without a table. The ones with a table have no padding (the table reaches the border). */
  padded?: boolean;
}

/** #fffefa surface with a border and a 4px radius. The size (flex, min-width) is set by whoever uses it, with className. */
export function Card({ padded, className, children, ...rest }: CardProps) {
  return (
    <div {...rest} className={cx(styles.card, padded && styles.padded, className)}>
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Text on the right (12px, muted). The figures inside go in <Num tone="ink">. */
  meta?: ReactNode;
  /** A control at the far right, after `meta`: the "+ Add …" that opens the add row. */
  action?: ReactNode;
  /** Lets the title and the meta break into two lines (transaction history). */
  wrap?: boolean;
  /** For `padded` cards: no padding of its own and a 12px bottom margin ("By category"). */
  inset?: boolean;
  className?: string;
}

export function CardHeader({ title, meta, action, wrap, inset, className }: CardHeaderProps) {
  const expand = useContext(ExpandOpenContext);
  const expanded = useContext(ExpandedContext);
  const shown = (action != null && action !== false) || expand !== null;
  return (
    <div className={cx(styles.header, wrap && styles.wrap, inset && styles.inset, expanded && styles.expanded, className)}>
      {/* In the expanded view the dialog title already says it. */}
      {!expanded && <h2 className={styles.title}>{title}</h2>}
      {shown ? (
        <div className={styles.side}>
          {meta != null && <div className={styles.meta}>{meta}</div>}
          {action}
          {expand && <ExpandButton onClick={expand} />}
        </div>
      ) : (
        meta != null && <div className={styles.meta}>{meta}</div>
      )}
    </div>
  );
}

/** A one-line note under a card's header (12px, muted): what the things typed into the card mean. */
export function CardNote({ className, children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p {...rest} className={cx(styles.note, className)}>
      {children}
    </p>
  );
}

/** Column with a 20px gap: the root of every screen. */
export function Stack({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx(styles.stack, className)}>
      {children}
    </div>
  );
}
