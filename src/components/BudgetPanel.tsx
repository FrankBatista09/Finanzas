import { donut } from '../../shared/calc';
import { f0, f2 } from '../../shared/format';
import { useI18n } from '../i18n';
import { useFinanzas } from '../store';
import { CellNumber, cx, SheetTable, Td } from '../ui';
import { Donut, DonutCenter, LegendRow } from './Donut';
import styles from './SummaryPanel.module.css';

/**
 * Panel resumen de la hoja "Mes": el presupuesto repartido por cuenta, la dona de presupuesto y la lista con lo
 * usado y lo disponible. Todas las cifras salen de monthCalc (shared/calc.ts), en la moneda principal.
 */
export function BudgetPanel() {
  const { monthKey, calc, main, second, readOnly, actions } = useFinanzas();
  const { t, label } = useI18n();
  const dn = donut(calc);
  const over = calc.avail < 0;

  return (
    <section className={styles.panel} aria-label={t('summaryOf', { month: label(monthKey) })}>
      <div className={cx(styles.cell, styles.money)}>
        <div className={styles.label}>{t('budget')}</div>
        <div>
          <div className={styles.total}>
            {f2(calc.budget)} <span className={styles.totalUnit}>{main}</span>
          </div>
          <div className={styles.totalSecond}>
            ≈ {f2(calc.budgetSecond)} {second}
          </div>
        </div>
        {/* key: al cambiar de mes los campos se montan de nuevo y no arrastran un borrador a medias. */}
        <div className={styles.accounts} key={monthKey}>
          <SheetTable label={t('budget')}>
            <tbody>
              {/* Una fila por cuenta visible y por cualquier oculta que aún tenga parte: suman el total de arriba. */}
              {calc.budgetParts.map(({ account, amount }) => (
                <tr key={account.id}>
                  <Td tone="soft">{account.name}</Td>
                  <Td kind="edit" className={styles.amountCol}>
                    <CellNumber
                      value={amount}
                      onCommit={(value) => actions.setBudgetPart(account.id, value)}
                      readOnly={readOnly}
                      label={t('budgetOf', { account: account.name, currency: account.currency })}
                    />
                  </Td>
                  <Td kind="mono" tone="muted" last>
                    {account.currency}
                  </Td>
                </tr>
              ))}
            </tbody>
          </SheetTable>
        </div>
        <div className={styles.incomeLeft}>
          <span>{t('incomeMinusUsed')}</span>
          <span className={cx(styles.mono, calc.incomeLeft < 0 ? styles.errorText : styles.inkText)}>
            {f2(calc.incomeLeft)} {main}
          </span>
        </div>
      </div>

      <div className={cx(styles.cell, styles.ringCell)}>
        {/* El orden de los anillos importa: fondo, pendientes, fijos pagados y, encima, transacciones. */}
        <Donut
          label={t('budgetUsedOf', { used: f0(calc.used), budget: f0(calc.budget), currency: main })}
          rings={[
            { color: 'var(--donut-free)' },
            { color: 'var(--donut-pending)', segment: dn.pending },
            { color: 'var(--donut-fixed)', segment: dn.fixed },
            { color: 'var(--accent)', segment: dn.variable },
          ]}
        >
          <DonutCenter label={t('used')} figure={f0(calc.used)} note={t('ofBudget', { budget: f0(calc.budget), currency: main })} alert={over} />
        </Donut>
        <div className={styles.legend}>
          <div className={cx(styles.label, styles.legendTitle)}>{t('budgetUsed')}</div>
          <LegendRow color="var(--donut-fixed)" name={t('fixedPaid')} value={f0(calc.fixedPaid)} />
          <LegendRow color="var(--accent)" name={t('transactions')} value={f2(calc.varSpent)} />
          <LegendRow color="var(--donut-pending)" name={t('fixedPending')} value={f0(calc.pending)} />
          <LegendRow color="var(--donut-free)" name={t('free')} value={f0(calc.free)} outlined />
        </div>
      </div>

      <div className={cx(styles.cell, styles.budget)}>
        <div className={cx(styles.label, styles.budgetTitle)}>{label(monthKey)}</div>
        {/* El presupuesto planeado ya no se escribe aquí: es la suma de las partes por cuenta de la primera tarjeta. */}
        <div className={styles.row}>
          <span>{t('plannedBudget')}</span>
          <span className={cx(styles.mono, styles.strong)}>{f2(calc.budget)}</span>
        </div>
        <div className={styles.row}>
          <span>{t('usedSoFar')}</span>
          <span className={cx(styles.mono, styles.strong)}>{f2(calc.used)}</span>
        </div>
        <div className={styles.row}>
          <span>{t('available')}</span>
          <span className={cx(styles.mono, styles.strong, over ? styles.errorText : styles.okText)}>{f2(calc.avail)}</span>
        </div>
        <div className={cx(styles.row, styles.rowSoft)}>
          <span>{t('availableAfterFixed')}</span>
          <span className={cx(styles.mono, calc.after < 0 ? styles.errorText : styles.softText)}>{f2(calc.after)}</span>
        </div>
        <div className={cx(styles.row, styles.rowSecond)}>
          <span>{t('usedIn', { currency: second })}</span>
          <span className={styles.mono}>
            {f2(calc.usedSecond)} {second}
          </span>
        </div>
      </div>
    </section>
  );
}
