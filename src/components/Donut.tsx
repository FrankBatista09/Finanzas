import type { ReactNode } from 'react';
import { DONUT } from '../../shared/calc';
import type { DonutSegment } from '../../shared/calc';
import { cx } from '../ui';
import styles from './SummaryPanel.module.css';

const C = DONUT.size / 2;

export interface DonutRing {
  /** Stroke color: a theme variable (`var(--accent)`) or an already resolved color. */
  color: string;
  /** With no segment, the whole ring: the donut's background. */
  segment?: DonutSegment;
}

export interface DonutProps {
  /** The rings in the order they are painted: each one sits on top of the previous ones. */
  rings: readonly DonutRing[];
  /** What the donut says, for those who cannot see it. */
  label: string;
  /** The center: <DonutCenter>. */
  children: ReactNode;
}

/** 168px donut with its text in the center. The segments come from shared/calc.ts (donut, ring). */
export function Donut({ rings, label, children }: DonutProps) {
  return (
    <div className={styles.donut}>
      <svg className={styles.donutSvg} viewBox={`0 0 ${DONUT.size} ${DONUT.size}`} width={DONUT.size} height={DONUT.size} role="img" aria-label={label}>
        {rings.map((ring, i) => (
          <circle
            key={i}
            cx={C}
            cy={C}
            r={DONUT.r}
            fill="none"
            style={{ stroke: ring.color }}
            strokeWidth={DONUT.stroke}
            strokeDasharray={ring.segment?.dash}
            strokeDashoffset={ring.segment?.offset}
          />
        ))}
      </svg>
      <div className={styles.center}>{children}</div>
    </div>
  );
}

export interface DonutCenterProps {
  label: string;
  /** The big figure, already formatted. */
  figure: string;
  /** The small line below. It goes in a single string, as in the prototype: splitting it into several text nodes shifts the letters half a pixel. */
  note: string;
  /** The figure in red (over budget, negative total money). */
  alert?: boolean;
}

export function DonutCenter({ label, figure, note, alert }: DonutCenterProps) {
  return (
    <>
      <div className={styles.centerLabel}>{label}</div>
      <div className={cx(styles.centerBig, alert ? styles.errorText : styles.inkText)}>{figure}</div>
      <div className={styles.centerSmall}>{note}</div>
    </>
  );
}

export interface LegendRowProps {
  color: string;
  name: string;
  value: string;
  /** Swatch with a border: the color of the donut's background ("Free", an account with no segment). */
  outlined?: boolean;
}

export function LegendRow({ color, name, value, outlined }: LegendRowProps) {
  return (
    <div className={styles.legendRow}>
      <span className={cx(styles.swatch, outlined && styles.swatchFree)} style={{ background: color }} />
      <span className={styles.legendName}>{name}</span>
      <span className={styles.mono}>{value}</span>
    </div>
  );
}
