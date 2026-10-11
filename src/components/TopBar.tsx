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
 * The rate in the bar: two decimals, as everywhere in the app. A rate below 1 (1 DOP = 0.0170 USD, when the
 * main currency is the strong one) would say nothing with two decimals: it gets four.
 */
const chipRate = (rate: number) => (rate > 0 && rate < 1 ? rate.toFixed(4) : fRate(rate));

/** Checks or unchecks a month in the selection, which always stays in the order of `all`. */
export function toggleMonth(all: readonly MonthKey[], picked: readonly MonthKey[], key: MonthKey, on: boolean): MonthKey[] {
  return on ? all.filter((x) => x === key || picked.includes(x)) : picked.filter((x) => x !== key);
}

export interface DownloadExcelDialogProps {
  /** The user's months, from oldest to most recent. */
  months: readonly MonthKey[];
  /** The ones that are checked on open: all of them, if not given. */
  initial?: readonly MonthKey[];
  onCancel: () => void;
  /** `undefined` = all the months (the whole workbook, including any that reached the server later). */
  onDownload: (months: readonly MonthKey[] | undefined) => void;
}

/** "Download Excel": which months go into the workbook. One checkbox per month (most recent on top) and one for all. */
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

/** Top bar: brand, user select, month select, Excel, month rate and settings. */
export function TopBar() {
  const { user, state, monthKey, barRate: bar, readOnly, actions } = useFinanzas();
  const { sheet, goToMonth, excelStatus, users, goToUser } = useShell();
  const { t, label, rateHint } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsId = useId();
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [downloadOpen, setDownloadOpen] = useState(false);

  // Where the rate comes from. If it is not the one typed for this month, that is said next to it; if it is the fixed
  // default value it is highlighted: every converted figure then rests on a rate nobody has typed.
  const hint = bar ? rateHint(bar, bar.from, bar.to) : '';
  const fallback = bar?.source === 'default';

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
    // Lets the same file be picked again.
    e.target.value = '';
  };

  return (
    <header className={styles.bar}>
      <div className={styles.lead}>
        <div className={styles.brand}>
          <h1 className={styles.title}>{APP_NAME}</h1>
          <div className={styles.subtitle}>{subtitle}</div>
        </div>
        {/* With a single user there is nothing to choose. */}
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

      {/* title: the Excel file still has the original design (USD, DOP and two accounts); the full note is in Settings. */}
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

      {/* With no rate needed (all the money in one currency) there is nothing to show. */}
      {bar && (
        <div className={styles.rate}>
          <span>{t('monthRate')}</span>
          <span className={cx(styles.chip, fallback && styles.chipWarn)} title={hint}>
            1 {bar.from} = {chipRate(bar.rate)} {bar.to}
          </span>
          {bar.source !== 'month' && <span className={fallback ? styles.rateWarn : styles.rateHint}>{hint}</span>}
        </div>
      )}

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
