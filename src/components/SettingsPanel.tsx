import { useEffect, useId, useRef } from 'react';
import type { RefObject } from 'react';
import { defaultAccount } from '../../shared/calc';
import { CURRENCIES } from '../../shared/constants';
import { LANGUAGES } from '../../shared/i18n';
import { DEFAULT_THEME, THEME_PRESETS } from '../../shared/theme';
import type { ThemePreset } from '../../shared/theme';
import type { Currency, ThemeColors } from '../../shared/types';
import { useI18n } from '../i18n';
import type { CoreKey } from '../i18n';
import { useFinanzas } from '../store';
import { cx, Select } from '../ui';
import styles from './SettingsPanel.module.css';

/** Nombre traducido de cada tema de shared/theme.ts; uno que no esté aquí se muestra con su `name`. */
const PRESET_NAMES: Record<string, CoreKey> = {
  forest: 'themeForest',
  ocean: 'themeOcean',
  plum: 'themePlum',
  terracotta: 'themeTerracotta',
  rose: 'themeRose',
  amber: 'themeAmber',
  slate: 'themeSlate',
};

const COLORS: readonly { key: keyof ThemeColors; name: CoreKey }[] = [
  { key: 'accent', name: 'themeAccent' },
  { key: 'header', name: 'themeHeader' },
  { key: 'background', name: 'themeBackground' },
];

const sameColors = (a: ThemeColors, b: ThemeColors) => a.accent === b.accent && a.header === b.header && a.background === b.background;

export interface SettingsPanelProps {
  id: string;
  /** El botón que lo abre: un clic en él no cuenta como "fuera" (ya lo cierra el botón) y recupera el foco con Escape. */
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/** Valor de la lista "Default account" para la cuenta automática (ningún id de cuenta es una cadena vacía). */
const AUTOMATIC = '';

/**
 * Ajustes del usuario actual: idioma, monedas, cuenta por defecto y colores. Cada cambio se ve en el acto y se
 * guarda solo (actions.setLanguage, setMainCurrency, setSecondCurrency, setDefaultAccount, setTheme). Escape y un
 * clic fuera lo cierran. Va dentro de la barra superior, que es su referencia de posición.
 */
export function SettingsPanel({ id, opener, onClose }: SettingsPanelProps) {
  const { state, main, second, visibleAccounts, actions } = useFinanzas();
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const languageId = useId();
  const currenciesId = useId();
  const mainId = useId();
  const secondId = useId();
  const accountId = useId();
  const appearanceId = useId();
  const excelId = useId();
  const colors = state.theme ?? DEFAULT_THEME;

  // La cuenta elegida solo cuenta mientras siga visible (shared/calc defaultAccount); si no, manda la automática,
  // y la lista dice cuál es para que "Automatic" no sea un misterio.
  const chosen = visibleAccounts.some((a) => a.id === state.defaultAccountId) ? state.defaultAccountId : null;
  const automatic = defaultAccount({ ...state, defaultAccountId: null });
  const accountOptions = [
    { value: AUTOMATIC, label: automatic ? t('automaticNamed', { name: automatic.name }) : t('automatic') },
    ...visibleAccounts.map((a) => ({ value: a.id, label: a.name })),
  ];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      opener.current?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Node && (panel.current?.contains(target) || opener.current?.contains(target))) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [opener, onClose]);

  const presetName = (preset: ThemePreset) => {
    const key = PRESET_NAMES[preset.id];
    return key ? t(key) : preset.name;
  };

  return (
    <div ref={panel} id={id} className={styles.panel} role="dialog" aria-label={t('settings')}>
      <section className={styles.section} aria-labelledby={languageId}>
        <h2 id={languageId} className={styles.heading}>
          {t('language')}
        </h2>
        <div className={styles.languages}>
          {LANGUAGES.map((l) => (
            // Cada idioma se llama a sí mismo en su idioma: `lang` hace que un lector de pantalla lo pronuncie bien.
            <button
              key={l.id}
              type="button"
              lang={l.id}
              className={cx(styles.choice, l.id === state.language && styles.choiceOn)}
              aria-pressed={l.id === state.language}
              onClick={() => actions.setLanguage(l.id)}
            >
              {l.name}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby={currenciesId}>
        <h2 id={currenciesId} className={styles.heading}>
          {t('currencies')}
        </h2>
        {/* Las dos tienen que ser distintas: elegir como segunda la principal las intercambia; elegir como principal la segunda deja la segunda en "None". */}
        <CurrencyRow id={mainId} name={t('mainCurrency')} value={main} onPick={(c) => c && actions.setMainCurrency(c)} />
        <CurrencyRow id={secondId} name={t('secondCurrency')} value={second} onPick={actions.setSecondCurrency} none={t('noSecondCurrency')} />
        <div className={styles.field}>
          <label htmlFor={accountId}>{t('defaultAccount')}</label>
          <Select
            id={accountId}
            className={styles.account}
            value={chosen ?? AUTOMATIC}
            options={accountOptions}
            onChange={(value) => actions.setDefaultAccount(value === AUTOMATIC ? null : value)}
          />
        </div>
      </section>

      <section className={styles.section} aria-labelledby={appearanceId}>
        <h2 id={appearanceId} className={styles.heading}>
          {t('appearance')}
        </h2>
        <div className={styles.presets} role="group" aria-label={t('themes')}>
          {THEME_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cx(styles.choice, styles.preset, sameColors(p.colors, colors) && styles.choiceOn)}
              aria-pressed={sameColors(p.colors, colors)}
              onClick={() => actions.setTheme(p.colors)}
            >
              <span className={styles.chips} aria-hidden="true">
                <span style={{ background: p.colors.header }} />
                <span style={{ background: p.colors.accent }} />
                <span style={{ background: p.colors.background }} />
              </span>
              <span className={styles.presetName}>{presetName(p)}</span>
            </button>
          ))}
        </div>
        <div className={styles.colors}>
          {COLORS.map(({ key, name }) => (
            <ColorRow key={key} name={t(name)} value={colors[key]} onChange={(value) => actions.setTheme({ ...colors, [key]: value })} />
          ))}
        </div>
        <button type="button" className={styles.reset} onClick={() => actions.setTheme(null)} disabled={state.theme === null}>
          {t('themeReset')}
        </button>
      </section>

      <section className={styles.section} aria-labelledby={excelId}>
        <h2 id={excelId} className={styles.heading}>
          {t('excel')}
        </h2>
        <p className={styles.note}>{t('excelNote')}</p>
      </section>
    </div>
  );
}

/** Una moneda a elegir entre las tres, como el idioma: los códigos se ven igual en todos los idiomas. */
function CurrencyRow({
  id,
  name,
  value,
  onPick,
  none,
}: {
  id: string;
  name: string;
  value: Currency | null;
  onPick: (currency: Currency | null) => void;
  /** Texto de la opción "ninguna"; sin él la fila no la ofrece. */
  none?: string;
}) {
  return (
    <div className={styles.field}>
      <span id={id}>{name}</span>
      <div className={styles.currencies} role="group" aria-labelledby={id}>
        {CURRENCIES.map((c) => (
          <button key={c} type="button" className={cx(styles.choice, styles.code, c === value && styles.choiceOn)} aria-pressed={c === value} onClick={() => onPick(c)}>
            {c}
          </button>
        ))}
        {none !== undefined && (
          <button type="button" className={cx(styles.choice, value === null && styles.choiceOn)} aria-pressed={value === null} onClick={() => onPick(null)}>
            {none}
          </button>
        )}
      </div>
    </div>
  );
}

function ColorRow({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{name}</label>
      {/* El selector nativo avisa en cada movimiento: los colores de la página lo siguen en directo. */}
      <input id={id} type="color" className={styles.colorInput} value={value} onChange={(e) => onChange(e.target.value)} />
      <span className={styles.hex}>{value}</span>
    </>
  );
}
