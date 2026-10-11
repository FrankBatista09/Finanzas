import { f0 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { Card, CardHeader, cx, Num } from '../../ui';
import styles from './CategoriesCard.module.css';
import { barWidth } from './rows';
import { MES } from './strings';

/** "By category": what was spent in the month, in the main currency, from largest to smallest. Paid fixed expenses go first, as one more category. */
export function CategoriesCard() {
  const { calc, main } = useFinanzas();
  const { catLabel, fixedCategory } = useI18n();
  const s = useStrings(MES);
  return (
    <Card padded>
      <CardHeader inset title={s('byCategory')} meta={main} />
      <div className={styles.list}>
        {calc.categories.map((c) => (
          // The key tells the "Fixed expenses" row apart from an imported category with the same name.
          <div key={c.fixed ? 'fixed' : `cat:${c.name}`} className={styles.row}>
            {/* The names arrive canonical (in English) and are translated here; a category from outside the list comes out as is. */}
            <span className={styles.name}>{c.fixed ? fixedCategory : catLabel(c.name)}</span>
            {/* The bar repeats the figure next to it: it adds nothing for a screen reader. */}
            <span className={styles.track} aria-hidden="true">
              <span className={cx(styles.bar, c.fixed && styles.barFixed)} style={{ width: barWidth(c.value, calc.catMax) }} />
            </span>
            <Num className={styles.value}>{f0(c.value)}</Num>
          </div>
        ))}
        {calc.categories.length === 0 && <div className={styles.empty}>{s('noExpenses')}</div>}
      </div>
    </Card>
  );
}
