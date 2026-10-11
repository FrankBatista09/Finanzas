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
 * Summary panel of the "Month" sheet: the budget split by account (with the leftover from the previous month and the
 * history of how it changed), the budget donut and the list with what is used and what is available. All figures
 * come from shared/calc.ts, in the main currency.
 */
export function BudgetPanel() {
  const { monthKey, calc, main, second, readOnly, actions, visibleAccounts } = useFinanzas();
  const { goToSheet } = useShell();
  const { t, label } = useI18n();
  // Existing in Savings does not put an account in the budget: only the ones with a part this month show here,
  // and the rest are added with the row below. The one a transfer with "Moves budget" leaves at zero or negative
  // also shows: it is the account the budget came out of.
  const parts = calc.budgetParts.filter((p) => p.amount !== 0 || p.fromLog !== 0 || p.fromTransfers !== 0);
  const free = visibleAccounts.filter((a) => !parts.some((p) => p.account.id === a.id));
  const NEW = '__new__';
  const [pick, setPick] = useState('');
  const [amount, setAmount] = useState(0);
  const adding = useAddRow(() => {
    setPick('');
    setAmount(0);
  });
  // The history is expanded for one month: on switching months it is collapsed again.
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
          {/* key: on switching months the fields mount again and do not carry over a half-typed draft. */}
          <div className={styles.accounts} key={monthKey}>
            <SheetTable label={t('budget')}>
              <tbody>
                {/* One row per account with a part this month (also a hidden one that still has one): they add up to the total above. */}
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
                      {/* The × zeroes what the budget log adds; what incomes and transfers put into it is not removed from here. */}
                      {!readOnly && fromLog !== 0 && (
                        <DeleteButton
                          compact
                          kind="kindBudgetEntry"
                          item={`${account.name} · ${f2(fromLog)} ${account.currency}`}
                          onConfirm={() => actions.setBudgetPart(account.id, amount - fromLog)}
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
                        // With no free accounts a single-option select would fire nothing: a button to Savings goes here.
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
          {/* A negative part (a transfer that moved more budget than it had) gets a written warning, on top of the red. */}
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
          {/* The order of the rings matters: background, pending, paid fixed expenses and, on top, transactions. */}
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
          {/* The planned budget is no longer typed here: it is the sum of the per-account parts of the first card. */}
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
      {/* Below the panel and full width: its six columns do not fit in the budget cell. */}
      {historyOpen && <BudgetHistory id={historyId} />}
      {extraOpen && !readOnly && <ExtraBudgetDialog onClose={() => setExtraOpen(false)} />}
    </>
  );
}

/**
 * "Leftover from last month": what was left over from the previous month (its available), always in view. Until it
 * is added to this month's budget it carries the button to do so, once only; in a closed month, only the figure.
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
 * "Budget history" (collapsed on entry; the control in the budget cell opens it): how the budget got to what it is
 * (the initial, the adjustments, the leftover, the incomes that raise it and the transfers that move it from one
 * account to another, in two rows: what leaves one and what enters the other), by date and with the running total.
 * A budget log movement is removed with × while the month is open; an income is removed or unchecked in the
 * income card.
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
                    {r.incomeName !== undefined && (
                      <span className={styles.historyNote}>{t('budgetFromIncome', { income: r.incomeName || t('extraIncomeNoDesc') })}</span>
                    )}
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
                        kind="kindBudgetEntry"
                        item={`${r.date.slice(8)}/${r.date.slice(5, 7)} · ${t(r.kindKey)} · ${r.amount} ${r.currency}`}
                        onConfirm={() => actions.removeBudgetEntry(r.id)}
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
