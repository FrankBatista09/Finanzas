import { useState } from 'react';
import { ring } from '../../shared/calc';
import type { AccountBalance } from '../../shared/calc';
import { ACCOUNT_CURRENCIES, CURRENCIES, GOLD_DECIMALS, GOLD_UNIT, isGold, MAX_LEN } from '../../shared/constants';
import { f0, f2, fGrams } from '../../shared/format';
import type { AccountCurrency, Currency } from '../../shared/types';
import { useI18n } from '../i18n';
import { canHideAccount, canRemoveAccount, useFinanzas } from '../store';
import { ringShades } from '../theme';
import { AddButton, AddRow, AddRowButton, CellNumber, CellSelect, CellText, cx, SheetTable, Td, DeleteButton, useAddRow, useConfirmDelete } from '../ui';
import { Donut, DonutCenter, LegendRow } from './Donut';
import styles from './SummaryPanel.module.css';

/**
 * The balance inside its field, in cents: the balance is a sum of converted movements and can carry
 * extra decimals (220641.93000000002), which would be noise in an editable field.
 */
const cents = (n: number) => Math.round(n * 100) / 100;

/** The same for the grams of a gold account, which allow one more decimal. */
const milligrams = (n: number) => Math.round(n * 10 ** GOLD_DECIMALS) / 10 ** GOLD_DECIMALS;

/** An account's balance with its unit: "1,250.00 USD"; for a gold one, its grams: "125.50 g". */
const withUnit = (balance: number, currency: AccountCurrency) => (isGold(currency) ? `${fGrams(balance)} ${GOLD_UNIT}` : `${f2(balance)} ${currency}`);

/**
 * Summary panel of the "Savings" sheet: the total money with each account's balance (here they are renamed, hidden,
 * added and have their balance corrected) and the donut of the money by account. The balances are those at the end
 * of the selected month (shared/calc balances): they are not typed month by month, they come from the movements.
 */
export function MoneyPanel() {
  const { state, monthKey, main, second, balances } = useFinanzas();
  const { t, label } = useI18n();
  const visible = balances.accounts.filter((b) => !b.account.hidden);
  const hidden = balances.accounts.filter((b) => b.account.hidden);

  // One segment per visible account with money; one at zero or negative takes up nothing in the donut, and neither
  // does a gold one with no price: there is no telling what it is worth.
  const funded = visible.filter((b) => b.valued && b.inMain > 0);
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
          {second && balances.totalSecond !== null && (
            <div className={styles.totalSecond}>
              ≈ {f2(balances.totalSecond)} {second}
            </div>
          )}
          {balances.goldExcluded && <div className={styles.totalNote}>{t('goldNotIncluded')}</div>}
        </div>
        {/* key: on switching months the fields mount again and do not carry over a half-typed draft. */}
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
              value={b.valued ? f2(b.inMain) : withUnit(b.balance, b.account.currency)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

const NEW_ACCOUNT = { name: '', opening: 0 };

// On narrow screens the accounts table does not fit: without this minimum the balance was left with no room (only
// the field's arrows showed). With it, the table scrolls horizontally inside its frame.
const BALANCE_MIN_WIDTH = 104;

/** The visible accounts with their balance and, at the end, the add row for another one, which the "+ Add account" below the frame opens. */
function AccountsTable({ rows }: { rows: readonly AccountBalance[] }) {
  const { state, main, latestMonth, actions } = useFinanzas();
  const { t } = useI18n();
  const [draft, setDraft] = useState(NEW_ACCOUNT);
  // The new account's currency starts as the main one; null = the user has not touched it.
  const [currency, setCurrency] = useState<AccountCurrency | null>(null);
  const adding = useAddRow(() => {
    setDraft(NEW_ACCOUNT);
    setCurrency(null);
  });
  // Gold is offered only here: an account is the only thing that can be in grams.
  const currencyOptions = ACCOUNT_CURRENCIES.map((c) => (isGold(c) ? { value: c, label: t('goldGrams') } : c));
  const hasGold = state.accounts.some((a) => isGold(a.currency));

  const add = () => {
    if (!actions.addAccount({ ...draft, currency: currency ?? main })) return false;
    setDraft(NEW_ACCOUNT);
    return true;
  };

  return (
    <>
    <div className={styles.accounts}>
      <SheetTable label={t('accounts')}>
        <tbody>
          {rows.map(({ account, balance }) => {
            const gold = isGold(account.currency);
            return (
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
                {/* Typing here corrects the balance. Only in the latest month: the balances of past months are history. */}
                <CellNumber
                  value={gold ? milligrams(balance) : cents(balance)}
                  onCommit={(value) => actions.setAccountBalance(account.id, value)}
                  readOnly={!latestMonth}
                  minWidth={BALANCE_MIN_WIDTH}
                  label={gold ? t('balanceOfGold', { account: account.name }) : t('balanceOf', { account: account.name, currency: account.currency })}
                />
              </Td>
              <Td kind="mono" tone="muted">{gold ? t('goldGrams') : account.currency}</Td>
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
                {/* An account nothing uses can be deleted directly; one with movements can only be hidden. */}
                {canRemoveAccount(state, account.id) && (
                  <DeleteButton compact kind="kindAccount" item={account.name} onConfirm={() => actions.removeAccount(account.id)} label={t('deleteNamed', { name: account.name })} />
                )}
              </Td>
            </tr>
            );
          })}
          <AddRow control={adding} onAdd={add}>
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
              <CellSelect value={currency ?? main} options={currencyOptions} onCommit={setCurrency} mono dense label={t('newAccountCurrency')} />
            </Td>
            <Td kind="add">
              <AddButton />
            </Td>
          </AddRow>
        </tbody>
      </SheetTable>
    </div>
    <AddRowButton control={adding} variant="link" className={styles.reveal}>
      {t('addAccount')}
    </AddRowButton>
    {/* Separate from the accounts: inside the table it looked like one more account, half filled in. */}
    {hasGold && (
      <div className={`${styles.accounts} ${styles.goldPrice}`}>
        <SheetTable label={t('goldPriceAmount')}>
          <tbody>
            <GoldPriceRow />
          </tbody>
        </SheetTable>
      </div>
    )}
    </>
  );
}

/**
 * The gold price, next to the accounts: what 1 gram is worth, typed by hand in the chosen currency. With it
 * the gold accounts add to the total money; when empty, they show only in grams. It only shows if the user has
 * a gold account.
 */
function GoldPriceRow() {
  const { state, main, actions } = useFinanzas();
  const { t } = useI18n();
  const price = state.goldPrice;
  // While there is no price, the chosen currency lives here: there is nothing to save yet.
  const [picked, setPicked] = useState<Currency | null>(null);
  const currency = price?.currency ?? picked ?? main;

  return (
    <tr>
      <Td tone="muted">{t('goldPriceLabel', { unit: GOLD_UNIT })}</Td>
      <Td kind="edit" className={styles.amountCol}>
        <CellNumber
          value={price?.amount ?? 0}
          onCommit={(amount) => actions.setGoldPrice(amount, currency)}
          blankZero
          minWidth={BALANCE_MIN_WIDTH}
          placeholder="0.00"
          label={t('goldPriceAmount')}
        />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={currency}
          options={CURRENCIES}
          onCommit={(next) => {
            setPicked(next);
            if (price) actions.setGoldPrice(price.amount, next);
          }}
          mono
          dense
          label={t('goldPriceCurrency')}
        />
      </Td>
    </tr>
  );
}

/** The hidden accounts, collapsed: they can be shown again and, if nothing uses them, deleted. */
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
              <span className={styles.mono}>{withUnit(balance, account.currency)}</span>
              <button
                type="button"
                className={styles.link}
                onClick={() => actions.setAccountHidden(account.id, false)}
                aria-label={t('showNamed', { name: account.name })}
              >
                {t('show')}
              </button>
              {/* An account with movements is not deleted (the server would respond 409): it stays hidden. */}
              {canRemoveAccount(state, account.id) && (
                <HiddenDelete name={account.name} onConfirm={() => actions.removeAccount(account.id)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The "Delete account" link of a hidden account: asks before removing it. */
function HiddenDelete({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  const { t } = useI18n();
  const confirm = useConfirmDelete(onConfirm);
  return (
    <>
      <button
        type="button"
        className={cx(styles.link, styles.linkDanger)}
        onClick={() => confirm.request(name)}
        aria-label={t('deleteNamed', { name })}
      >
        {t('deleteAccount')}
      </button>
      {confirm.dialog('kindAccount')}
    </>
  );
}
