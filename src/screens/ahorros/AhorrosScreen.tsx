// "Savings" sheet (prototype, lines 523-621): goal cards (with their dialog to create and edit them), income by month,
// contributions and the incomes one by one. Everything comes from useFinanzas(); the texts are in ./strings and the
// sentences are built in ./model. Above the sheet, the total money and the accounts belong to the summary panel (src/components).

import { Stack } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { ContributionsCard } from './ContributionsCard';
import { GoalCards } from './GoalCards';
import { IncomeCard } from './IncomeCard';
import { IncomesCard } from './IncomesCard';

export function AhorrosScreen() {
  return (
    <Stack>
      <GoalCards />
      <div className={styles.row}>
        <IncomeCard />
        <ContributionsCard />
      </div>
      <IncomesCard />
    </Stack>
  );
}
