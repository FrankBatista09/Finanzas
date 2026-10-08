import { f0 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { Card, CardHeader, cx, Num } from '../../ui';
import styles from './CategoriesCard.module.css';
import { barWidth } from './rows';
import { MES } from './strings';

/** "Por categoría": lo gastado en el mes, en la moneda principal, de mayor a menor. Los gastos fijos pagados van primero, como una categoría más. */
export function CategoriesCard() {
  const { calc, main } = useFinanzas();
  const { catLabel, fixedCategory } = useI18n();
  const s = useStrings(MES);
  return (
    <Card padded>
      <CardHeader inset title={s('byCategory')} meta={main} />
      <div className={styles.list}>
        {calc.categories.map((c) => (
          // La clave distingue la fila "Gastos fijos" de una categoría importada que se llame igual.
          <div key={c.fixed ? 'fixed' : `cat:${c.name}`} className={styles.row}>
            {/* Los nombres llegan canónicos (en inglés) y aquí se traducen; una categoría de fuera de la lista sale tal cual. */}
            <span className={styles.name}>{c.fixed ? fixedCategory : catLabel(c.name)}</span>
            {/* La barra repite la cifra de al lado: no aporta nada a un lector de pantalla. */}
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
