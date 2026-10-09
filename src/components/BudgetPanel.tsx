import { useId, useState } from 'react';
import { donut } from '../../shared/calc';
import { f0, f2 } from '../../shared/format';
import { useI18n } from '../i18n';
import { useFinanzas, useShell } from '../store';
import { AddButton, AddRow, AddRowButton, CellNumber, CellSelect, cx, DeleteButton, SheetTable, Td, Th, useAddRow } from '../ui';
import { budgetHistoryRows, fieldAmount, leftoverView, overrunLines } from './budgetModel';
import { ExtraBudgetDialog } from './ExtraBudgetDialog';
import { Donut, DonutCenter, LegendRow } from './Donut';
import styles from './SummaryPanel.module.css';

/**
 * Panel resumen de la hoja "Mes": el presupuesto repartido por cuenta (con el sobrante del mes anterior y la
 * historia de cómo fue cambiando), la dona de presupuesto y la lista con lo usado y lo disponible. Todas las cifras
 * salen de shared/calc.ts, en la moneda principal.
 */
export function BudgetPanel() {
  const { monthKey, calc, main, second, readOnly, actions, visibleAccounts } = useFinanzas();
  const { goToSheet } = useShell();
  const { t, label } = useI18n();
  // Que una cuenta exista en Savings no la mete en el presupuesto: aquí solo salen las que tienen parte este mes,
  // y las demás se suman con la fila de abajo. También sale la que un envío con "Moves budget" deja en cero o en
  // negativo: es la cuenta de la que salió el presupuesto.
  const parts = calc.budgetParts.filter((p) => p.amount !== 0 || p.fromLog !== 0 || p.fromTransfers !== 0);
  const free = visibleAccounts.filter((a) => !parts.some((p) => p.account.id === a.id));
  const NEW = '__new__';
  const [pick, setPick] = useState('');
  const [amount, setAmount] = useState(0);
  const adding = useAddRow(() => {
    setPick('');
    setAmount(0);
  });
  // El historial se despliega para un mes: al cambiar de mes vuelve a estar plegado.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const historyOpen = historyFor === monthKey;
  const [extraOpen, setExtraOpen] = useState(false);
  const chosen = free.find((a) => a.id === pick) ?? free[0];
  const add = () => {
    if (!chosen || !(amount > 0) || !actions.setBudgetPart(chosen.id, amount)) return false;
    setPick('');
    setAmount(0);
  };
  const historyId = useId();
  const dn = donut(calc);
  const over = calc.avail < 0;
  const overruns = overrunLines(calc.budgetParts);

  return (
    <>
      <section className={styles.panel} aria-label={t('summaryOf', { month: label(monthKey) })}>
        <div className={cx(styles.cell, styles.money)}>
          <div className={styles.label}>{t('budget')}</div>
          <div>
            <div className={styles.total}>
              {f2(calc.budget)} <span className={styles.totalUnit}>{main}</span>
            </div>
            {second && calc.budgetSecond !== null && (
              <div className={styles.totalSecond}>
                ≈ {f2(calc.budgetSecond)} {second}
              </div>
            )}
          </div>
          {/* key: al cambiar de mes los campos se montan de nuevo y no arrastran un borrador a medias. */}
          <div className={styles.accounts} key={monthKey}>
            <SheetTable label={t('budget')}>
              <tbody>
                {/* Una fila por cuenta con parte este mes (también una oculta que aún la tenga): suman el total de arriba. */}
                {parts.map(({ account, amount, fromLog }) => (
                  <tr key={account.id}>
                    <Td tone="soft">{account.name}</Td>
                    <Td kind="edit" className={styles.amountCol}>
                      <CellNumber
                        value={fieldAmount(amount)}
                        onCommit={(value) => actions.setBudgetPart(account.id, value)}
                        readOnly={readOnly}
                        label={t('budgetOf', { account: account.name, currency: account.currency })}
                      />
                    </Td>
                    <Td kind="mono" tone="muted">
                      {account.currency}
                    </Td>
                    <Td kind="action" last>
                      {/* La × deja en cero lo que suma el registro; lo que le ponen los ingresos y los envíos no se quita desde aquí. */}
                      {!readOnly && fromLog !== 0 && (
                        <DeleteButton
                          compact
                          onClick={() => actions.setBudgetPart(account.id, amount - fromLog)}
                          label={t('removeFromBudget', { name: account.name })}
                        />
                      )}
                    </Td>
                  </tr>
                ))}
                {!readOnly && (
                  <AddRow control={adding} onAdd={add}>
                    <Td kind="edit">
                      {free.length > 0 ? (
                        <CellSelect
                          value={chosen?.id ?? NEW}
                          options={[...free.map((a) => ({ value: a.id, label: a.name })), { value: NEW, label: t('newAccountOption') }]}
                          onCommit={(id) => (id === NEW ? goToSheet('ahorros') : setPick(id))}
                          label={t('budgetAccount')}
                        />
                      ) : (
                        // Sin cuentas libres un select de una sola opción no dispararía nada: va un botón a Savings.
                        <button type="button" className={styles.link} style={{ padding: '7px 10px' }} onClick={() => goToSheet('ahorros')}>
                          {t('newAccountOption')}
                        </button>
                      )}
                    </Td>
                    <Td kind="edit" className={styles.amountCol}>
                      <CellNumber value={amount} onCommit={setAmount} blankZero placeholder="0.00" label={t('budgetAmount')} />
                    </Td>
                    <Td kind="mono" tone="muted">
                      {chosen?.currency ?? ''}
                    </Td>
                    <Td kind="add" last>
                      <AddButton />
                    </Td>
                  </AddRow>
                )}
              </tbody>
            </SheetTable>
          </div>
          {/* Una parte en negativo (un envío que movió más presupuesto del que tenía) se avisa por escrito, además del rojo. */}
          {overruns.length > 0 && (
            <ul className={styles.overrun}>
              {overruns.map((o) => (
                <li key={o.id}>{t('overBudgetBy', { amount: o.amount, currency: o.currency, account: o.account })}</li>
              ))}
            </ul>
          )}
          {!readOnly && (
            <div className={styles.revealRow}>
              <AddRowButton control={adding} variant="link">
                {t('addBudgetPart')}
              </AddRowButton>
              {visibleAccounts.length > 0 && (
                <button type="button" className={styles.extraButton} onClick={() => setExtraOpen(true)}>
                  + {t('addBudgetExtra')}
                </button>
              )}
            </div>
          )}
          <BudgetLeftover />
          <div>
            <button
              type="button"
              className={styles.link}
              aria-expanded={historyOpen}
              aria-controls={historyId}
              onClick={() => setHistoryFor(historyOpen ? null : monthKey)}
            >
              {t('budgetHistory')}
            </button>
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
          {second && calc.usedSecond !== null && (
            <div className={cx(styles.row, styles.rowSecond)}>
              <span>{t('usedIn', { currency: second })}</span>
              <span className={styles.mono}>
                {f2(calc.usedSecond)} {second}
              </span>
            </div>
          )}
        </div>
      </section>
      {/* Debajo del panel y a todo el ancho: sus seis columnas no caben en la celda del presupuesto. */}
      {historyOpen && <BudgetHistory id={historyId} />}
      {extraOpen && !readOnly && <ExtraBudgetDialog onClose={() => setExtraOpen(false)} />}
    </>
  );
}

/**
 * "Leftover from last month": lo que sobró del mes anterior (su disponible), siempre a la vista. Mientras no se
 * haya sumado al presupuesto de este mes lleva el botón para hacerlo, una sola vez; en un mes cerrado, solo la cifra.
 */
function BudgetLeftover() {
  const { leftover, main, readOnly, actions } = useFinanzas();
  const { t } = useI18n();
  const view = leftoverView(leftover, readOnly);
  if (!view) return null;
  return (
    <div className={styles.leftover}>
      <span>
        {t('leftoverFromLast')}{' '}
        <span className={cx(styles.mono, view.amount < 0 ? styles.errorText : styles.inkText)}>
          {f2(view.amount)} {main}
        </span>
      </span>
      {view.status === 'offer' && (
        <button type="button" className={styles.leftoverAdd} onClick={() => actions.addLeftover()}>
          {t('addToBudget')}
        </button>
      )}
      {view.status === 'added' && <span className={styles.leftoverAdded}>{t('leftoverAdded')}</span>}
    </div>
  );
}

/**
 * "Budget history" (plegado al entrar; lo abre el control de la celda del presupuesto): cómo llegó el presupuesto
 * a lo que es (el inicial, los ajustes, el sobrante, los ingresos que lo suben y los envíos que lo mueven de una
 * cuenta a otra, en dos filas: lo que sale de una y lo que entra a la otra), por fecha y con el total acumulado. Un movimiento del registro se quita con × mientras el mes esté abierto; un ingreso se quita o se
 * desmarca en la tarjeta de ingresos.
 */
function BudgetHistory({ id }: { id: string }) {
  const { state, monthKey, main, actions } = useFinanzas();
  const { t } = useI18n();
  const rows = budgetHistoryRows(state, monthKey);
  return (
    <div id={id} className={styles.history}>
      <div className={styles.label}>{t('budgetHistory')}</div>
      {rows.length === 0 ? (
        <div className={styles.historyEmpty}>{t('budgetHistoryEmpty')}</div>
      ) : (
        <div className={styles.accounts}>
          <SheetTable label={t('budgetHistory')} minWidth={560}>
            <thead>
              <tr>
                <Th width={52}>{t('date')}</Th>
                <Th>{t('budgetKind')}</Th>
                <Th>{t('account')}</Th>
                <Th align="right">{t('amount')}</Th>
                <Th align="right">
                  {t('total')} {main}
                </Th>
                <Th blank width={24} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <Td kind="mono" nowrap>
                    {r.date.slice(8)}/{r.date.slice(5, 7)}
                  </Td>
                  <Td>
                    {t(r.kindKey)}
                    {r.note && <span className={styles.historyNote}>{r.note}</span>}
                  </Td>
                  <Td tone="soft">{r.account}</Td>
                  <Td kind="num" nowrap tone={r.negative ? 'error' : undefined}>
                    {r.amount} {r.currency}
                  </Td>
                  <Td kind="num" nowrap>
                    {r.total}
                  </Td>
                  <Td kind="action" last>
                    {r.deletable && (
                      <DeleteButton
                        compact
                        onClick={() => actions.removeBudgetEntry(r.id)}
                        label={t('deleteBudgetEntry', { kind: t(r.kindKey), date: `${r.date.slice(8)}/${r.date.slice(5, 7)}`, amount: r.amount, currency: r.currency })}
                      />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </SheetTable>
        </div>
      )}
    </div>
  );
}
