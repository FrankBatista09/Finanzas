// Hoja "Savings" (prototipo, líneas 523-621): tarjetas de metas (con su diálogo para crearlas y editarlas),
// ingresos por mes, aportes y los ingresos uno por uno. Todo sale de useFinanzas(); los textos están en ./strings
// y las frases se arman en ./model. Arriba de la hoja, el dinero total y las cuentas son del panel resumen (src/components).

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
