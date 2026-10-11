import { APP_NAME } from '../shared/constants';
import styles from './App.module.css';
import { BottomTabs } from './components/BottomTabs';
import { CloseMonthModal } from './components/CloseMonthModal';
import { DeleteMonthModal } from './components/DeleteMonthModal';
import { Notices } from './components/Notices';
import { SummaryPanel } from './components/SummaryPanel';
import { TopBar } from './components/TopBar';
import { useI18n } from './i18n';
import { AhorrosScreen } from './screens/ahorros/AhorrosScreen';
import { MesScreen } from './screens/mes/MesScreen';
import { useFinanzas, useShell } from './store';

/** App shell: top bar, summary panel of the active sheet, the sheet, tabs, the close-month and delete-month dialogs, and notices. */
export function App() {
  const { status } = useShell();
  return status === 'ready' ? <Ready /> : <Boot />;
}

function Ready() {
  const { sheet } = useShell();
  const { user, monthKey } = useFinanzas();
  return (
    <div className={styles.app}>
      <TopBar />
      <main className={styles.main}>
        <SummaryPanel sheet={sheet} />
        {/* key: switching user or month mounts the sheet again, so its add rows start clean and with that month's date. */}
        {sheet === 'ahorros' ? <AhorrosScreen key={user.id} /> : <MesScreen key={`${user.id}:${monthKey}`} />}
      </main>
      <CloseMonthModal />
      <DeleteMonthModal />
      <BottomTabs />
      <Notices />
    </div>
  );
}

/** Before there is any data: loading, or no connection with the retry button. In the last language used on this device. */
function Boot() {
  const { status, retry, retrying } = useShell();
  const { t } = useI18n();
  return (
    <div className={styles.app}>
      <header className={styles.bootBar}>
        <h1 className={styles.bootTitle}>{APP_NAME}</h1>
      </header>
      <main className={styles.main}>
        {status === 'loading' ? (
          <div className={styles.bootMuted} role="status">
            {t('loading')}
          </div>
        ) : (
          <div className={styles.bootCard} role="alert">
            <h2 className={styles.bootHeading}>{t('bootErrorTitle')}</h2>
            <p className={styles.bootText}>{t('bootErrorText')}</p>
            <button type="button" className={styles.retry} onClick={retry} disabled={retrying}>
              {retrying ? t('retrying') : t('retry')}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
