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

/** Carcasa de la app: barra superior, panel resumen de la hoja activa, la hoja, pestañas, modales de cerrar y borrar mes, y avisos. */
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
        {/* key: al cambiar de usuario o de mes la hoja se monta de nuevo, así sus filas de agregar arrancan limpias y con la fecha de ese mes. */}
        {sheet === 'ahorros' ? <AhorrosScreen key={user.id} /> : <MesScreen key={`${user.id}:${monthKey}`} />}
      </main>
      <CloseMonthModal />
      <DeleteMonthModal />
      <BottomTabs />
      <Notices />
    </div>
  );
}

/** Antes de tener datos: cargando, o sin conexión con el botón para reintentar. En el último idioma usado en este dispositivo. */
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
