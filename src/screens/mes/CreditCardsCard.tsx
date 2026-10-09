import { useState } from 'react';
import { cardCalc, cardHint, cardUtilization } from '../../../shared/calc';
import type { CardHint } from '../../../shared/calc';
import { f2 } from '../../../shared/format';
import type { CreditCard } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { Card, CardHeader, cx } from '../../ui';
import { CardDialog } from './CardDialog';
import { arrowsOf, CARD_WINDOW, clampStart, moveWindow, windowOf } from './cardWindow';
import styles from './CreditCardsCard.module.css';
import { MES } from './strings';

/** '2026-10-13' → 'Oct 13' / '13 oct' / '13 Eki', en el idioma del usuario. */
function dayLabel(date: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * «Credit cards»: las tarjetas del usuario, de dos en dos. Cada una dice lo que se debe (del mes que se mira), cuánto es
 * del límite, y, si se conocen el límite y el corte, cuánto pagar antes del corte para cerrarlo por debajo del 10 %. Las
 * flechas mueven la ventana de dos tarjetas de una en una; las apagadas también salen, atenuadas. Las tarjetas no
 * pertenecen a un mes: se pueden crear y editar aunque el mes esté cerrado.
 */
export function CreditCardsCard({ className }: { className?: string }) {
  const { state, actions } = useFinanzas();
  const s = useStrings(MES);
  const cards = [...state.cards].sort((a, b) => a.sort - b.sort);
  const [start, setStart] = useState(0);
  const [dialog, setDialog] = useState<CreditCard | 'new' | null>(null);
  // La tarjeta que no se pudo apagar por deber algo: el aviso va en su lugar hasta que se toque otra cosa.
  const [refused, setRefused] = useState<string | null>(null);
  const from = clampStart(cards.length, start);
  const arrows = arrowsOf(cards.length, from);
  const paged = cards.length > CARD_WINDOW;

  const toggle = (card: CreditCard) => {
    setRefused(actions.patchCard(card.id, { active: !card.active }) ? null : card.id);
  };

  return (
    <Card className={className}>
      <CardHeader
        title={s('cardsTitle')}
        action={
          <button type="button" className={styles.add} onClick={() => setDialog('new')}>
            + {s('addCard')}
          </button>
        }
      />
      {cards.length === 0 ? (
        <div className={styles.empty}>
          <p>{s('cardsEmpty')}</p>
          <button type="button" className={styles.add} onClick={() => setDialog('new')}>
            + {s('addCard')}
          </button>
        </div>
      ) : (
        <div className={styles.body}>
          <div className={cx(styles.list, paged && styles.fixed)}>
            {windowOf(cards, from).map((card) => (
              <CardItem key={card.id} card={card} refused={refused === card.id} onToggle={() => toggle(card)} onEdit={() => setDialog(card)} />
            ))}
          </div>
          {paged && (
            <div className={styles.arrows}>
              <button type="button" className={styles.arrow} aria-label={s('cardsUp')} title={s('cardsUp')} disabled={!arrows.up} onClick={() => setStart(moveWindow(cards.length, from, -1))}>
                ▲
              </button>
              <button type="button" className={styles.arrow} aria-label={s('cardsDown')} title={s('cardsDown')} disabled={!arrows.down} onClick={() => setStart(moveWindow(cards.length, from, 1))}>
                ▼
              </button>
            </div>
          )}
        </div>
      )}
      {dialog && <CardDialog card={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} />}
    </Card>
  );
}

interface CardItemProps {
  card: CreditCard;
  refused: boolean;
  onToggle: () => void;
  onEdit: () => void;
}

function CardItem({ card, refused, onToggle, onEdit }: CardItemProps) {
  const { state, monthKey, latestMonth, today } = useFinanzas();
  const { lang } = useI18n();
  const s = useStrings(MES);
  const remainder = cardCalc(state, monthKey, card.id).remainder;
  const util = cardUtilization(card, remainder);
  // El aviso solo tiene sentido en el último mes: en uno anterior lo que se debe ya no es lo de hoy.
  const hint = latestMonth ? cardHint(card, remainder, today) : null;
  const pct = util === null ? null : (util * 100).toFixed(1);
  const over = util !== null && util >= 0.1;
  const detail = [card.bank, card.last4 && `•••• ${card.last4}`].filter(Boolean).join(' · ');
  const money = (n: number) => `${f2(n)} ${card.cur}`;
  const day = (d: number | null) => (d === null ? '—' : s('cardDay', { day: d }));

  return (
    <div className={cx(styles.item, !card.active && styles.off)} data-testid="credit-card">
      <div className={styles.top}>
        <button type="button" role="switch" aria-checked={card.active} aria-label={s('cardActiveNamed', { name: card.name })} className={cx(styles.switch, card.active && styles.on)} onClick={onToggle}>
          <span className={styles.knob} />
        </button>
        <div className={styles.name}>
          <span className={styles.nameText} title={card.name}>
            {card.name}
          </span>
          {detail && <span className={styles.muted}>{detail}</span>}
          {!card.active && <span className={styles.tag}>{s('cardOffTag')}</span>}
        </div>
        <button type="button" className={styles.link} aria-label={s('cardEditNamed', { name: card.name })} onClick={onEdit}>
          {s('cardEdit')}
        </button>
      </div>
      <div className={styles.fields}>
        <span>
          {s('cardLimit')} <b>{card.limit === null ? '—' : money(card.limit)}</b>
        </span>
        <span>
          {s('cardCutoff')} <b>{day(card.cutoffDay)}</b>
        </span>
        <span>
          {s('cardDue')} <b>{day(card.dueDay)}</b>
        </span>
      </div>
      <div className={styles.owe}>
        <span>{pct === null ? s('cardOwe', { amount: f2(Math.max(0, remainder)), currency: card.cur }) : s('cardOweLimit', { amount: f2(Math.max(0, remainder)), currency: card.cur, pct })}</span>
        {hint && <span className={styles.muted}>{hint.daysToCutoff === 0 ? s('cardCutoffToday') : s('cardToCutoff', { count: hint.daysToCutoff })}</span>}
      </div>
      {util !== null && (
        <div className={styles.track} role="img" aria-label={s('cardBar', { pct: pct! })}>
          <div className={cx(styles.fill, over && styles.fillOver)} style={{ width: `${Math.min(util, 1) * 100}%` }} />
          <div className={styles.marker} />
        </div>
      )}
      <div className={styles.tips}>
        {refused ? (
          <p className={styles.warn} role="alert">
            {s('cardOffBlocked', { name: card.name })}
          </p>
        ) : hint ? (
          <Tips card={card} hint={hint} lang={lang} onEdit={onEdit} />
        ) : latestMonth ? (
          <p className={styles.muted}>{s('cardTipSetup')}</p>
        ) : null}
      </div>
    </div>
  );
}

function Tips({ card, hint, lang, onEdit }: { card: CreditCard; hint: CardHint; lang: string; onEdit: () => void }) {
  const s = useStrings(MES);
  const cutoff = dayLabel(hint.nextCutoff, lang);
  return (
    <>
      {hint.payToUnder10 > 0 ? (
        <p className={styles.warn}>{s('cardTipOver', { amount: f2(hint.payToUnder10), currency: card.cur, date: cutoff })}</p>
      ) : (
        <p className={styles.good}>{s('cardTipUnder', { date: cutoff })}</p>
      )}
      {hint.upcomingDue ? (
        <p className={styles.muted}>
          {hint.upcomingDue.days === 0
            ? s('cardDueToday', { date: dayLabel(hint.upcomingDue.date, lang) })
            : s('cardDueIn', { date: dayLabel(hint.upcomingDue.date, lang), count: hint.upcomingDue.days })}
        </p>
      ) : (
        <p className={styles.muted}>
          <button type="button" className={styles.link} onClick={onEdit}>
            {s('cardAddDue')}
          </button>
        </p>
      )}
    </>
  );
}
