import { useCallback, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { sortedKeys } from '../../shared/calc';
import { APP_NAME } from '../../shared/constants';
import { fRate } from '../../shared/format';
import { useI18n } from '../i18n';
import { useFinanzas, useShell } from '../store';
import type { MonthKey } from '../../shared/types';
import { CheckField, cx, Dialog, DialogButton, DialogFields } from '../ui';
import { SettingsPanel } from './SettingsPanel';
import styles from './TopBar.module.css';

/**
 * La tasa de la barra: dos decimales, como en toda la app. Una tasa menor que 1 (1 DOP = 0.0170 USD, cuando la
 * moneda principal es la fuerte) con dos decimales no diría nada: lleva cuatro.
 */
const chipRate = (rate: number) => (rate > 0 && rate < 1 ? rate.toFixed(4) : fRate(rate));

/** Marca o desmarca un mes de la selección, que queda siempre en el orden de `all`. */
export function toggleMonth(all: readonly MonthKey[], picked: readonly MonthKey[], key: MonthKey, on: boolean): MonthKey[] {
  return on ? all.filter((x) => x === key || picked.includes(x)) : picked.filter((x) => x !== key);
}

export interface DownloadExcelDialogProps {
  /** Los meses del usuario, del más antiguo al más reciente. */
  months: readonly MonthKey[];
  /** Los que salen marcados al abrir: todos, si no se indica. */
  initial?: readonly MonthKey[];
  onCancel: () => void;
  /** `undefined` = todos los meses (el libro completo, también con los que hayan llegado después al servidor). */
  onDownload: (months: readonly MonthKey[] | undefined) => void;
}

/** "Download Excel": qué meses van al libro. Una casilla por mes (el más reciente arriba) y otra para todos. */
export function DownloadExcelDialog({ months, initial, onCancel, onDownload }: DownloadExcelDialogProps) {
  const { t, label } = useI18n();
  const [picked, setPicked] = useState<readonly MonthKey[]>(initial ?? months);
  const all = picked.length === months.length;
  return (
    <Dialog
      title={t('downloadExcel')}
      onCancel={onCancel}
      onSubmit={() => {
        if (picked.length) onDownload(all ? undefined : picked);
      }}
      footer={
        <>
          <DialogButton onClick={onCancel}>{t('cancel')}</DialogButton>
          <DialogButton variant="primary" type="submit" disabled={!picked.length}>
            {t('downloadMonths', { count: picked.length })}
          </DialogButton>
        </>
      }
    >
      <DialogFields>
        <CheckField checked={all} onChange={(on) => setPicked(on ? months : [])}>
          {t('allMonths')}
        </CheckField>
        {[...months].reverse().map((k) => (
          <CheckField key={k} checked={picked.includes(k)} onChange={(on) => setPicked(toggleMonth(months, picked, k, on))}>
            {label(k)}
          </CheckField>
        ))}
      </DialogFields>
    </Dialog>
  );
}

/** Barra superior: marca, selector de usuario, selector de mes, Excel, tasa del mes y ajustes. */
export function TopBar() {
  const { user, state, monthKey, rate, main, second, readOnly, actions } = useFinanzas();
  const { sheet, goToMonth, excelStatus, users, goToUser } = useShell();
  const { t, label, rateHint } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsId = useId();
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [downloadOpen, setDownloadOpen] = useState(false);

  // De dónde sale la tasa. Si no es la escrita para este mes se dice al lado; si es el valor fijo de respaldo
  // se destaca: todas las cifras convertidas descansan entonces en una tasa que nadie ha escrito.
  const hint = rateHint(rate, second, main);
  const fallback = rate.source === 'default';

  const keys = sortedKeys(state);
  const idx = keys.indexOf(monthKey);
  const subtitle = sheet === 'ahorros' ? t('savings') : readOnly ? t('subtitleClosed') : t('subtitleCurrent');
  const upload = !excelStatus
    ? t('importExcel')
    : excelStatus.kind === 'reading'
      ? t('excelReading')
      : excelStatus.kind === 'loaded'
        ? t('excelLoaded', { file: excelStatus.file })
        : t('excelFailed');

  const step = (delta: number) => {
    const key = keys[idx + delta];
    if (key) goToMonth(key);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void actions.importExcel(file);
    // Permite volver a elegir el mismo archivo.
    e.target.value = '';
  };

  return (
    <header className={styles.bar}>
      <div className={styles.lead}>
        <div className={styles.brand}>
          <h1 className={styles.title}>{APP_NAME}</h1>
          <div className={styles.subtitle}>{subtitle}</div>
        </div>
        {/* Con un solo usuario no hay nada que elegir. */}
        {users.length > 1 && (
          <select className={styles.select} value={user.id} onChange={(e) => goToUser(e.target.value)} aria-label={t('user')}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className={styles.picker}>
        <button type="button" className={styles.step} onClick={() => step(-1)} aria-label={t('prevMonth')}>
          ‹
        </button>
        <select className={cx(styles.select, styles.month)} value={monthKey} onChange={(e) => goToMonth(e.target.value)} aria-label={t('month')}>
          {keys.map((k) => (
            <option key={k} value={k}>
              {state.months[k]!.closed ? t('monthClosedOption', { month: label(k) }) : label(k)}
            </option>
          ))}
        </select>
        <button type="button" className={styles.step} onClick={() => step(1)} aria-label={t('nextMonth')}>
          ›
        </button>
      </div>

      {/* title: el Excel sigue con el diseño original (USD, DOP y dos cuentas); la nota completa está en Settings. */}
      <label className={styles.upload} title={t('excelNote')}>
        <input type="file" accept=".xlsx" className={styles.file} onChange={onFile} />
        <span aria-live="polite">{upload}</span>
      </label>

      <button type="button" className={styles.download} onClick={() => setDownloadOpen(true)} title={t('excelNote')}>
        {t('downloadExcel')}
      </button>
      {downloadOpen && (
        <DownloadExcelDialog
          months={keys}
          onCancel={() => setDownloadOpen(false)}
          onDownload={(months) => {
            void actions.downloadExcel(months);
            setDownloadOpen(false);
          }}
        />
      )}

      <div className={styles.rate}>
        <span>{t('monthRate')}</span>
        <span className={cx(styles.chip, fallback && styles.chipWarn)} title={hint}>
          1 {second} = {chipRate(rate.rate)} {main}
        </span>
        {rate.source !== 'month' && <span className={fallback ? styles.rateWarn : styles.rateHint}>{hint}</span>}
      </div>

      <button
        ref={settingsButton}
        type="button"
        className={cx(styles.settings, settingsOpen && styles.settingsOn)}
        aria-expanded={settingsOpen}
        aria-controls={settingsOpen ? settingsId : undefined}
        onClick={() => setSettingsOpen((open) => !open)}
      >
        {t('settings')}
      </button>
      {settingsOpen && <SettingsPanel id={settingsId} opener={settingsButton} onClose={closeSettings} />}
    </header>
  );
}
