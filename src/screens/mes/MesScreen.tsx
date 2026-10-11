// "Month" sheet (prototype, lines 336-521): fixed monthly expenses, categories, rates, transfers, income and history of the selected month.
// Everything comes from useFinanzas(); App renders the summary panel at the top and the dialogs to close and to delete the month.
// The texts live in strings.ts (English, Spanish and Turkish) and show in the user's language.

import { outsideOf } from '../../../shared/calc';
import { useI18n } from '../../i18n';
import { useFinanzas } from '../../store';
import { Stack } from '../../ui';
import { CategoriesCard } from './CategoriesCard';
import { useColumnCap } from './columnCap';
import { CloseBox } from './CloseBox';
import { ClosedBanner } from './ClosedBanner';
import { CreditCardsCard } from './CreditCardsCard';
import { FixedCard } from './FixedCard';
import { IncomeCard } from './IncomeCard';
import styles from './MesScreen.module.css';
import { OutsideCard, outsideCardVisible, useOutsideAdding } from './OutsideCard';
import { RatesCard } from './RatesCard';
import { TransactionsCard } from './TransactionsCard';
import { TransfersCard } from './TransfersCard';

export function MesScreen() {
  // A closed month is read-only: it gets the banner with its summary and loses the close box
  // (each card hides its add row and its × buttons on its own).
  const { readOnly, actions, month } = useFinanzas();
  // The screen holds it because the link in "Transaction history" opens the card even when it is not visible yet.
  const outside = useOutsideAdding();
  const { t } = useI18n();
  const { columns, left, side } = useColumnCap();
  return (
    <Stack>
      {readOnly && <ClosedBanner />}
      <div ref={columns} className={styles.columns}>
        <div ref={left} className={styles.fixed}>
          <FixedCard cardClassName={styles.capped} />
        </div>
        <div ref={side} className={styles.side}>
          <CategoriesCard />
          <RatesCard />
          <CreditCardsCard />
        </div>
      </div>
      {/* Transfers and income, side by side with the same width and height; when they do not fit, they stack. */}
      <div className={styles.pair}>
        <TransfersCard />
        <IncomeCard />
      </div>
      <TransactionsCard outside={outside} />
      {outsideCardVisible(outsideOf(month).length, outside) && <OutsideCard adding={outside} />}
      {!readOnly && <CloseBox />}
      {/* Delete the month, open or closed: discreet and at the end. It only opens the confirmation dialog, which lives in App. */}
      <div className={styles.footer}>
        <button type="button" className={styles.deleteMonth} onClick={() => actions.requestDeleteMonth()}>
          {t('deleteMonth')}
        </button>
      </div>
    </Stack>
  );
}
