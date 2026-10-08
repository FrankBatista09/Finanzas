import type { ReactNode } from 'react';
import { DONUT } from '../../shared/calc';
import type { DonutSegment } from '../../shared/calc';
import { cx } from '../ui';
import styles from './SummaryPanel.module.css';

const C = DONUT.size / 2;

export interface DonutRing {
  /** Color del trazo: una variable del tema (`var(--accent)`) o un color ya resuelto. */
  color: string;
  /** Sin segmento, el anillo entero: el fondo de la dona. */
  segment?: DonutSegment;
}

export interface DonutProps {
  /** Los anillos en el orden en que se pintan: cada uno queda encima de los anteriores. */
  rings: readonly DonutRing[];
  /** Lo que dice la dona, para quien no la ve. */
  label: string;
  /** El centro: <DonutCenter>. */
  children: ReactNode;
}

/** Dona de 168px con su texto en el centro. Los segmentos salen de shared/calc.ts (donut, ring). */
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
  /** La cifra grande, ya formateada. */
  figure: string;
  /** La línea pequeña de debajo. Va en una sola cadena, como en el prototipo: partirla en varios nodos de texto mueve las letras medio píxel. */
  note: string;
  /** La cifra en rojo (pasado de presupuesto, dinero total en negativo). */
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
  /** Muestra con borde: el color del fondo de la dona ("Free", una cuenta sin segmento). */
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
