import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Hourglass, Sparkles, Ticket, X } from 'lucide-react';
import type { SubsPick } from '../../bridge/types';
import { formatHours } from '../../lib/cloud';
import { plural } from '../../lib/format';
import { spring } from '../../lib/motion';
import { titleHue } from '../../lib/palette';
import { FAMILY, formatMoney, leavingLabel, PLAN } from '../../lib/subs';
import { openIncluded, saveSubscriptions, usePlans, useSubsIncluded, useSubsValue } from '../../state/subs';
import { useReducedMotion, useStore } from '../../state/store';
import { SubsPicker, type SubsAnswer } from '../../components/subs/SubsPicker';
import { Button, IconButton, SectionHead, Toggle } from '../../components/ui/primitives';
import { ServiceLogo } from '../../components/ui/ServiceLogo';
import '../../components/game/shelf.css';
import '../../components/subs/subs.css';

/**
 * Track V: the one-time "Tell VYSTRAL your subscriptions" card for people who skipped (or predate) the onboarding
 * step. Saving or "Not now" both mark the question as asked, so it never comes back; Settings → Library & stores
 * changes the answer any time.
 */
export function SubsAskCard() {
  const asked = useStore((s) => s.settings?.['subs.asked'] ?? true);
  const onboarded = useStore((s) => s.settings?.['onboarding.completed'] ?? false);
  const gfn = useStore((s) => s.settings?.['cloud.gfnPlan'] ?? 'none');
  const catalog = useStore((s) => s.settings?.['subs.catalog'] ?? false);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const plans = usePlans();
  const reduce = useReducedMotion();
  const [answer, setAnswer] = useState<SubsAnswer>({ plans, gfn, none: false });
  const [lists, setLists] = useState(true);
  const [busy, setBusy] = useState(false);
  if (asked || !onboarded) return null;

  const save = async () => {
    setBusy(true);
    const hasList = answer.plans.some((p) => PLAN[p].hasList);
    if (hasList && lists !== catalog) await setSetting('subs.catalog', lists);
    const ok = await saveSubscriptions(answer.plans, answer.gfn);
    setBusy(false);
    if (ok) {
      toast({
        tone: 'success',
        title: answer.plans.length || answer.gfn !== 'none' ? 'Your subscriptions are saved' : 'Got it: no subscriptions',
        body: 'Change them any time in Settings → Library & stores.',
      });
    }
  };

  return (
    <motion.section
      className="subs-ask surface"
      aria-labelledby="subs-ask-title"
      data-testid="subs-ask"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.15 } : spring.panel}
    >
      <div className="subs-ask__glow" aria-hidden />
      <header className="subs-ask__head">
        <div>
          <span className="subs-ask__eyebrow caps"><Ticket size={13} aria-hidden /> Make VYSTRAL yours</span>
          <h2 className="subs-ask__title" id="subs-ask-title">Tell VYSTRAL your subscriptions</h2>
          <p className="subs-ask__lead">
            Pick what you pay for and VYSTRAL tailors itself: badges on games your plans include, a row of included games you don’t own yet,
            “leaving soon” warnings, and cloud play that only shows your services.
          </p>
        </div>
        <IconButton label="Not now" size="sm" onClick={() => void setSetting('subs.asked', true)}>
          <X size={16} />
        </IconButton>
      </header>
      <SubsPicker value={answer} onChange={setAnswer} compact />
      <div className="subs-ask__foot">
        {answer.plans.some((p) => PLAN[p].hasList) ? (
          <label className="subs-ask__opt">
            <Toggle label="Show what my plans include" checked={lists} onChange={setLists} />
            <span>Show what my plans include. Downloads Microsoft’s public Game Pass lists once a day; only your region is sent.</span>
          </label>
        ) : <span />}
        <div className="subs-ask__actions">
          <Button variant="ghost" onClick={() => void setSetting('subs.asked', true)}>Not now</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
        </div>
      </div>
    </motion.section>
  );
}

/** "Included with your subscriptions": games your plans include that aren't in your library. Opens the official page. */
export function SubsIncludedRow() {
  const picks = useSubsIncluded();
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const next = { start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 };
    setEdge((e) => (e.start === next.start && e.end === next.end ? e : next));
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    onScroll();
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => ro.disconnect();
  }, [picks?.length]);
  if (!picks?.length) return null;
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: reduce ? 'auto' : 'smooth' });
  const overflows = !(edge.start && edge.end);
  const leaving = picks.filter((p) => p.reason === 'leaving').length;

  return (
    <section className="shelf" aria-labelledby="subs-row-title" data-testid="subs-included">
      <SectionHead
        title={<span className="home__title-icon" id="subs-row-title"><Sparkles size={16} aria-hidden /> Included with your subscriptions</span>}
        meta={<span className="subs-row__meta">{leaving ? `${plural(leaving, 'game')} leaving soon · ` : ''}Games you don’t own yet · opens the official page</span>}
        action={overflows ? (
          <div style={{ display: 'flex', gap: 4 }}>
            <IconButton label="Scroll left" size="sm" aria-disabled={edge.start || undefined} onClick={() => scroll(-1)}><ChevronLeft size={16} /></IconButton>
            <IconButton label="Scroll right" size="sm" aria-disabled={edge.end || undefined} onClick={() => scroll(1)}><ChevronRight size={16} /></IconButton>
          </div>
        ) : undefined}
      />
      <div className="shelf__track shelf__track--portrait" ref={ref} onScroll={onScroll}>
        {picks.map((p) => <PickTile key={p.productId} pick={p} />)}
      </div>
    </section>
  );
}

function PickTile({ pick }: { pick: SubsPick }) {
  const [broken, setBroken] = useState(false);
  const flag = pick.reason === 'leaving' ? leavingLabel(pick.leavingEnd) : pick.reason === 'new' ? 'New in your plan' : 'Popular';
  return (
    <div className="shelf__item">
      <button
        className="subs-tile"
        onClick={() => void openIncluded(pick.productId)}
        aria-label={`${pick.title}, included with your ${pick.planName}. ${flag}. Opens its page in the Xbox app or Microsoft Store; nothing is installed.`}
      >
        <span className="subs-tile__art" style={{ ['--h' as string]: titleHue(pick.title) }}>
          {pick.poster && !broken ? (
            <img src={pick.poster} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
          ) : (
            <span className="subs-tile__gen" aria-hidden>{pick.title}</span>
          )}
          <span className="subs-tile__flag" data-reason={pick.reason} aria-hidden>
            {pick.reason === 'leaving' && <Hourglass size={11} />} {flag}
          </span>
          <span className="subs-tile__open" aria-hidden><ArrowUpRight size={16} /></span>
        </span>
        <span className="subs-tile__title truncate">{pick.title}</span>
        <span className="subs-tile__sub truncate">
          <ServiceLogo service={FAMILY[PLAN[pick.plan]?.family ?? 'gamepass'].mark} size={12} decorative /> {pick.planName}
        </span>
      </button>
    </div>
  );
}

/**
 * The subscription value card: hours this month in games your plans include (as tracked by VYSTRAL), per plan, and —
 * only if you typed what you pay — cost per hour. Renders nothing until there's time to show.
 */
export function SubsValueCard() {
  const value = useSubsValue();
  const plans = usePlans();
  const gfn = useStore((s) => s.settings?.['cloud.gfnPlan'] ?? 'none');
  const navigate = useStore((s) => s.navigate);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (!value || (plans.length === 0 && gfn === 'none') || value.seconds <= 0) return null;
  const month = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(value.monthStart));
  const max = Math.max(1, ...value.rows.map((r) => r.seconds));
  return (
    <section className="subs-value surface" aria-labelledby="subs-value-title" data-testid="subs-value">
      <div>
        <span className="subs-value__eyebrow caps"><Ticket size={13} aria-hidden /> Your subscriptions · {month}</span>
        <h2 className="subs-value__big" id="subs-value-title">{formatHours(value.seconds)}</h2>
        <p className="subs-value__sub">
          in games your plans include, across {plural(value.games, 'game')} and {plural(value.sessions, 'session')}, as tracked by VYSTRAL this month.
        </p>
        <div className="subs-value__cost">
          {value.costPerHour != null ? (
            <>
              <strong>About {formatMoney(value.costPerHour, value.currency)} an hour</strong>
              <span className="subs-value__note">
                What you entered ({formatMoney(value.price, value.currency)} a month) ÷ the hours VYSTRAL tracked. Play on other devices isn’t counted, so
                your real cost per hour is likely lower.
              </span>
            </>
          ) : value.price > 0 ? (
            <span className="subs-value__note">Cost per hour appears once you’ve played an hour this month.</span>
          ) : (
            <span className="subs-value__note">
              Want cost per hour? <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'settings', section: 'library' })}>Add what you pay</Button>
            </span>
          )}
        </div>
      </div>
      <div>
        <ul className="subs-value__rows" aria-label="Time by plan">
          {value.rows.map((r) => (
            <li key={r.plan} className="subs-value__row">
              <ServiceLogo service={r.plan === 'geforce-now' ? 'geforce-now' : FAMILY[PLAN[r.plan]?.family ?? 'gamepass'].mark} size={16} decorative />
              <span>{r.name} · {plural(r.games, 'game')}</span>
              <strong>{formatHours(r.seconds)}</strong>
              <span className="subs-value__bar" aria-hidden><span className="subs-value__fill" style={{ ['--f' as string]: shown ? r.seconds / max : 0 }} /></span>
            </li>
          ))}
        </ul>
        {value.top.length > 0 && (
          <div className="subs-value__top" aria-label="Most played">
            {value.top.map((t) => (
              <Button key={t.gameId} size="sm" onClick={() => navigate({ name: 'game', id: t.gameId })}>{t.title} · {formatHours(t.seconds)}</Button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
