import { Fragment, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { cardCalc, cardHint, cardUtilization } from '../../../shared/calc';
import type { CardHint } from '../../../shared/calc';
import { f2 } from '../../../shared/format';
import type { CreditCard } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { Card, CardHeader, cx } from '../../ui';
import { CardDialog } from './CardDialog';
import { carouselIndex } from './cardCarousel';
import styles from './CreditCardsCard.module.css';
import { MES } from './strings';

/** '2026-10-13' → 'Oct 13' / '13 oct' / '13 Eki', en el idioma del usuario. */
function dayLabel(date: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

/** Numbers in the app's mono face, the rest of the sentence untouched (the text content stays the translated string). */
function monoNumbers(text: string, className: string) {
  return text.split(/(\d[\d.,]*)/).map((part, i) => (i % 2 === 1 ? <span key={i} className={className}>{part}</span> : <Fragment key={i}>{part}</Fragment>));
}

/** How much to pay before the cutoff to end it under 10 %, or that it already is. Shared with the card details dialog. */
export function PayHint({ card, hint, lang }: { card: CreditCard; hint: CardHint; lang: string }) {
  const s = useStrings(MES);
  const cutoff = dayLabel(hint.nextCutoff, lang);
  return hint.payToUnder10 > 0 ? (
    <p className={styles.warn}>{s('cardTipOver', { amount: f2(hint.payToUnder10), currency: card.cur, date: cutoff })}</p>
  ) : (
    <p className={styles.good}>{s('cardTipUnder', { date: cutoff })}</p>
  );
}

/**
 * "Credit cards": the user's cards. Each one shows what is owed (for the month being viewed), how much of that is the
 * limit, and, when the limit and cutoff are known, how much to pay before the cutoff to close below 10 %. One card is
 * shown at a time; with more than one, arrows (or the keyboard ones) move between them. Cards do not belong to a
 * month: they can be created and edited even when the month is closed.
 */
export function CreditCardsCard({ className }: { className?: string }) {
  const { state, actions } = useFinanzas();
  const s = useStrings(MES);
  const cards = [...state.cards].sort((a, b) => a.sort - b.sort);
  const [dialog, setDialog] = useState<CreditCard | 'new' | null>(null);
  // La tarjeta que no se pudo apagar por deber algo: el aviso va en su lugar hasta que se toque otra cosa.
  const [refused, setRefused] = useState<string | null>(null);
  const ids = cards.map((c) => c.id);
  const [index, setIndex] = useState(0);
  const [seenIds, setSeenIds] = useState(ids);
  // Adjusting state while rendering (instead of in an effect) avoids a frame showing the wrong card.
  let shown = index;
  if (ids.length !== seenIds.length || ids.some((id, i) => id !== seenIds[i])) {
    shown = carouselIndex(seenIds, ids, index);
    setIndex(shown);
    setSeenIds(ids);
  }
  const current = cards[Math.min(shown, cards.length - 1)];
  const many = cards.length > 1;
  const go = (delta: number) => setIndex(Math.min(Math.max(shown + delta, 0), cards.length - 1));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };

  const toggle = (card: CreditCard) => {
    setRefused(actions.patchCard(card.id, { active: !card.active }) ? null : card.id);
  };

  return (
    <Card className={className}>
      <CardHeader
        title={
          <>
            {s('cardsTitle')}
            {many && <span className={styles.counter} aria-hidden="true">{shown + 1} / {cards.length}</span>}
          </>
        }
        action={
          <>
            {many && (
              <span className={styles.nav}>
                <button type="button" className={styles.arrow} aria-label={s('cardsPrev')} title={s('cardsPrev')} disabled={shown === 0} onClick={() => go(-1)}>
                  <Chevron dir="left" />
                </button>
                <button type="button" className={styles.arrow} aria-label={s('cardsNext')} title={s('cardsNext')} disabled={shown === cards.length - 1} onClick={() => go(1)}>
                  <Chevron dir="right" />
                </button>
              </span>
            )}
            <button type="button" className={styles.add} onClick={() => setDialog('new')}>
              + {s('addCard')}
            </button>
          </>
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
          <div className={styles.list} tabIndex={many ? 0 : undefined} aria-label={many ? s('cardsTitle') : undefined} role={many ? 'region' : undefined} onKeyDown={many ? onKeyDown : undefined}>
            <CardItem key={current!.id} card={current!} refused={refused === current!.id} onToggle={() => toggle(current!)} onEdit={() => setDialog(current!)} />
          </div>
        </div>
      )}
      {dialog && <CardDialog card={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} />}
    </Card>
  );
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === 'left' ? 'M7.5 2.5 4 6l3.5 3.5' : 'M4.5 2.5 8 6 4.5 9.5'} />
    </svg>
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
      <div className={styles.owe}>
        <div className={styles.main}>
          <span className={styles.fields}>
            {s('cardLimit')} <b>{card.limit === null ? '—' : money(card.limit)}</b>
          </span>
          <span>{monoNumbers(pct === null ? s('cardOwe', { amount: f2(Math.max(0, remainder)), currency: card.cur }) : s('cardOweLimit', { amount: f2(Math.max(0, remainder)), currency: card.cur, pct }), styles.num)}</span>
        </div>
        <div className={styles.side}>
          <span>
            {s('cardCutoff')} <b>{day(card.cutoffDay)}</b>
          </span>
          <span>
            {s('cardDue')} <b>{day(card.dueDay)}</b>
          </span>
          {hint && <span>{hint.daysToCutoff === 0 ? s('cardCutoffToday') : s('cardToCutoff', { count: hint.daysToCutoff })}</span>}
        </div>
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
  return (
    <>
      <PayHint card={card} hint={hint} lang={lang} />
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
