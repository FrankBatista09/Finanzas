import { useState } from 'react';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { Card, cx } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { GoalDialog } from './GoalDialog';
import { goalCards } from './model';
import { AHORROS } from './strings';

/** El diálogo de metas: cerrado (null), para una meta nueva ('new') o editando la de ese id. */
type Open = null | 'new' | { id: string };

/**
 * Una tarjeta por meta: lo ahorrado en la moneda de la meta (y, si no es la principal, su equivalente "≈" a la tasa
 * del mes en curso) y, si la meta tiene objetivo, cuánto falta para llegar. Cada una se edita desde su cabecera y,
 * después de la última, la tarjeta punteada crea una nueva.
 */
export function GoalCards() {
  const { state, main } = useFinanzas();
  const { t, lang } = useI18n();
  const s = useStrings(AHORROS);
  const [open, setOpen] = useState<Open>(null);
  const cards = goalCards(state, lang);
  const close = () => setOpen(null);
  // Si la meta que se editaba deja de existir (se recargaron los datos), el diálogo desaparece con ella.
  const editing = open !== null && open !== 'new' ? state.goals.find((g) => g.id === open.id) : undefined;

  return (
    <>
      <div className={styles.goals}>
        {cards.map((g) => (
          <Card key={g.id} className={styles.goal}>
            <div className={styles.goalHead}>
              <h2 className={styles.goalName}>{g.name}</h2>
              <div className={styles.goalMeta}>
                <span className={styles.goalKind}>{g.kind}</span>
                <button type="button" className={styles.goalEdit} onClick={() => setOpen({ id: g.id })} aria-label={s('editGoalNamed', { name: g.name })}>
                  {t('edit')}
                </button>
              </div>
            </div>
            <div>
              <div className={styles.saved}>
                {g.saved} <span className={styles.savedUnit}>{g.cur}</span>
              </div>
              {g.savedMain !== null && (
                <div className={cx(styles.savedMain, g.mainNote.fallback && styles.fallback)} title={g.mainNote.hint || undefined}>
                  ≈ {g.savedMain} {main}
                  {g.mainNote.fallback && '*'}
                </div>
              )}
            </div>
            {g.target ? (
              <div className={styles.progress}>
                <div
                  className={styles.track}
                  role="progressbar"
                  aria-label={s('progressOf', { name: g.name })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(g.target.value)}
                >
                  <div className={styles.fill} style={{ width: `${g.target.value}%` }} />
                </div>
                <div className={styles.progressText}>
                  <span>{g.target.progress}</span>
                  <span>{g.target.deadline}</span>
                </div>
                <div className={styles.plan}>{g.plan}</div>
              </div>
            ) : (
              <div className={styles.plan}>{g.plan}</div>
            )}
          </Card>
        ))}
        <button type="button" className={styles.addGoal} onClick={() => setOpen('new')}>
          <span className={styles.addGoalPlus} aria-hidden="true">
            +
          </span>
          {s('addGoal')}
        </button>
      </div>
      {open === 'new' && <GoalDialog goal={null} onClose={close} />}
      {editing && <GoalDialog key={editing.id} goal={editing} onClose={close} />}
    </>
  );
}
