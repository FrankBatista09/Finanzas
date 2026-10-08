import { useState } from 'react';
import { ring } from '../../shared/calc';
import type { AccountBalance } from '../../shared/calc';
import { CURRENCIES, MAX_LEN } from '../../shared/constants';
import { f0, f2 } from '../../shared/format';
import type { Currency } from '../../shared/types';
import { useI18n } from '../i18n';
import { canHideAccount, canRemoveAccount, useFinanzas } from '../store';
import { ringShades } from '../theme';
import { AddButton, AddRow, CellNumber, CellSelect, CellText, cx, SheetTable, Td } from '../ui';
import { Donut, DonutCenter, LegendRow } from './Donut';
import styles from './SummaryPanel.module.css';

/**
 * El saldo dentro de su campo, en centavos: el saldo es una suma de movimientos convertidos y puede traer
 * decimales de más (220641.93000000002), que en un campo editable serían ruido.
 */
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Panel resumen de la hoja "Savings": el dinero total con el saldo de cada cuenta (aquí se renombran, se ocultan,
 * se agregan y se les corrige el saldo) y la dona del dinero por cuenta. Los saldos son los del final del mes
 * seleccionado (shared/calc balances): no se escriben mes a mes, salen de los movimientos.
 */
export function MoneyPanel() {
  const { state, monthKey, main, second, balances } = useFinanzas();
  const { t, label } = useI18n();
  const visible = balances.accounts.filter((b) => !b.account.hidden);
  const hidden = balances.accounts.filter((b) => b.account.hidden);

  // Un segmento por cuenta visible con dinero; una en cero o en negativo no ocupa nada en la dona.
  const funded = visible.filter((b) => b.inMain > 0);
  const shades = ringShades(state.theme, funded.length);
  const segments = ring(funded.map((b) => b.inMain));
  const colorOf = (b: AccountBalance) => shades[funded.indexOf(b)];

  return (
    <section className={styles.panel} aria-label={t('summaryOf', { month: label(monthKey) })}>
      <div className={cx(styles.cell, styles.money)}>
        <div className={styles.label}>{t('totalMoney')}</div>
        <div>
          <div className={cx(styles.total, balances.totalMain < 0 && styles.errorText)}>
            {f2(balances.totalMain)} <span className={styles.totalUnit}>{main}</span>
          </div>
          <div className={styles.totalSecond}>
            ≈ {f2(balances.totalSecond)} {second}
          </div>
        </div>
        {/* key: al cambiar de mes los campos se montan de nuevo y no arrastran un borrador a medias. */}
        <AccountsTable key={monthKey} rows={visible} />
        {hidden.length > 0 && <HiddenAccounts rows={hidden} />}
      </div>

      <div className={cx(styles.cell, styles.ringCell)}>
        <Donut
          label={t('moneyByAccountOf', { total: f0(balances.totalMain), currency: main })}
          rings={[{ color: 'var(--donut-free)' }, ...shades.map((color, i) => ({ color, segment: segments[i] }))]}
        >
          <DonutCenter label={t('total')} figure={f0(balances.totalMain)} note={main} alert={balances.totalMain < 0} />
        </Donut>
        <div className={styles.legend}>
          <div className={cx(styles.label, styles.legendTitle)}>{t('moneyByAccount')}</div>
          {visible.map((b) => (
            <LegendRow
              key={b.account.id}
              color={colorOf(b) ?? 'var(--donut-free)'}
              outlined={colorOf(b) === undefined}
              name={b.account.name}
              value={f2(b.inMain)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

const NEW_ACCOUNT = { name: '', opening: 0 };

// En pantallas estrechas la tabla de cuentas no cabe: sin este mínimo el saldo se quedaba sin sitio (solo se veían
// las flechas del campo). Con él, la tabla se desplaza en horizontal dentro de su marco.
const BALANCE_MIN_WIDTH = 104;

/** Las cuentas visibles con su saldo y, al final, la fila para agregar otra. */
function AccountsTable({ rows }: { rows: readonly AccountBalance[] }) {
  const { state, main, latestMonth, actions } = useFinanzas();
  const { t } = useI18n();
  const [draft, setDraft] = useState(NEW_ACCOUNT);
  // La moneda de la cuenta nueva arranca en la principal; null = el usuario no la ha tocado.
  const [currency, setCurrency] = useState<Currency | null>(null);

  const add = () => {
    if (!actions.addAccount({ ...draft, currency: currency ?? main })) return false;
    setDraft(NEW_ACCOUNT);
    return true;
  };

  return (
    <div className={styles.accounts}>
      <SheetTable label={t('accounts')}>
        <tbody>
          {rows.map(({ account, balance }) => (
            <tr key={account.id}>
              <Td kind="edit">
                <CellText
                  value={account.name}
                  onCommit={(name) => actions.renameAccount(account.id, name)}
                  minWidth={96}
                  maxLength={MAX_LEN.name}
                  label={t('accountName')}
                />
              </Td>
              <Td kind="edit" className={styles.amountCol}>
                {/* Escribir aquí corrige el saldo. Solo en el último mes: los saldos de meses pasados son historia. */}
                <CellNumber
                  value={cents(balance)}
                  onCommit={(value) => actions.setAccountBalance(account.id, value)}
                  readOnly={!latestMonth}
                  minWidth={BALANCE_MIN_WIDTH}
                  label={t('balanceOf', { account: account.name, currency: account.currency })}
                />
              </Td>
              <Td kind="mono" tone="muted">
                {account.currency}
              </Td>
              <Td kind="action" className={styles.linkCol}>
                {canHideAccount(state, account.id) && (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => actions.setAccountHidden(account.id, true)}
                    aria-label={t('hideNamed', { name: account.name })}
                  >
                    {t('hide')}
                  </button>
                )}
              </Td>
            </tr>
          ))}
          <AddRow onAdd={add}>
            <Td kind="edit">
              <CellText
                value={draft.name}
                onCommit={(name) => setDraft((d) => ({ ...d, name }))}
                placeholder={t('accountName')}
                minWidth={96}
                maxLength={MAX_LEN.name}
                label={t('newAccountName')}
              />
            </Td>
            <Td kind="edit" className={styles.amountCol}>
              <CellNumber
                value={draft.opening}
                onCommit={(opening) => setDraft((d) => ({ ...d, opening }))}
                blankZero
                minWidth={BALANCE_MIN_WIDTH}
                placeholder={t('openingBalance')}
                label={t('newAccountOpening')}
              />
            </Td>
            <Td kind="edit">
              <CellSelect value={currency ?? main} options={CURRENCIES} onCommit={setCurrency} mono dense label={t('newAccountCurrency')} />
            </Td>
            <Td kind="add">
              <AddButton className={styles.addAccount}>{t('addAccount')}</AddButton>
            </Td>
          </AddRow>
        </tbody>
      </SheetTable>
    </div>
  );
}

/** Las cuentas ocultas, plegadas: se vuelven a mostrar y, si nada las usa, se pueden eliminar. */
function HiddenAccounts({ rows }: { rows: readonly AccountBalance[] }) {
  const { state, actions } = useFinanzas();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.hidden}>
      <button type="button" className={styles.link} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t('hiddenAccounts', { count: rows.length })}
      </button>
      {open && (
        <ul className={styles.hiddenList}>
          {rows.map(({ account, balance }) => (
            <li key={account.id} className={styles.hiddenRow}>
              <span className={styles.hiddenName}>{account.name}</span>
              <span className={styles.mono}>
                {f2(balance)} {account.currency}
              </span>
              <button
                type="button"
                className={styles.link}
                onClick={() => actions.setAccountHidden(account.id, false)}
                aria-label={t('showNamed', { name: account.name })}
              >
                {t('show')}
              </button>
              {/* Una cuenta con movimientos no se elimina (el servidor respondería 409): se queda oculta. */}
              {canRemoveAccount(state, account.id) && (
                <button
                  type="button"
                  className={cx(styles.link, styles.linkDanger)}
                  onClick={() => actions.removeAccount(account.id)}
                  aria-label={t('deleteNamed', { name: account.name })}
                >
                  {t('deleteAccount')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
