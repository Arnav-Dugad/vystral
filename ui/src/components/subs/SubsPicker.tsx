import { useId } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, CircleSlash, Lock } from 'lucide-react';
import type { GfnPlanId, SubsPlanId } from '../../bridge/types';
import { FAMILIES, familyPlan, GFN_TIERS, PLAN, togglePlan, type FamilyMeta } from '../../lib/subs';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import { ServiceLogo } from '../ui/ServiceLogo';
import './subs.css';

export interface SubsAnswer {
  plans: SubsPlanId[];
  gfn: GfnPlanId;
  /** "None of these" was pressed. Unset = derived (nothing picked); a fresh question starts false, so nothing looks chosen. */
  none?: boolean;
}

const GFN_BLURB: Record<GfnPlanId, string> = {
  none: '',
  free: 'Free: basic rigs, one-hour sessions, queues at busy times.',
  performance: 'Performance: up to 1440p, 100 hours a month.',
  ultimate: 'Ultimate: RTX rigs, up to 4K and 120 fps, 100 hours a month.',
  daypass: 'Day pass: 24 hours of Performance or Ultimate.',
};

/**
 * Track V: "Which subscriptions do you have?" — one card per service with its tiers as chips (one tier per service),
 * GeForce NOW's membership (the same setting as Cloud play), and "None of these". Controlled; used by onboarding,
 * the Home card and Settings. Cards are buttons (aria-pressed), so keyboard, controller and screen readers all work.
 */
export function SubsPicker({ value, onChange, compact }: { value: SubsAnswer; onChange: (v: SubsAnswer) => void; compact?: boolean }) {
  const empty = value.plans.length === 0 && value.gfn === 'none';
  const none = empty && value.none !== false;
  return (
    <div className="subs-picker" data-compact={compact || undefined}>
      <div className="subs-grid">
        {FAMILIES.map((f) => (
          <FamilyCard key={f.family} f={f} plans={value.plans} onPick={(p) => onChange({ ...value, plans: togglePlan(value.plans, p), none: false })} />
        ))}
        <GfnCard gfn={value.gfn} onPick={(g) => onChange({ ...value, gfn: value.gfn === g ? 'none' : g, none: false })} />
        <button type="button" className="subs-card subs-card--none" aria-pressed={none} onClick={() => onChange({ plans: [], gfn: 'none', none: true })}>
          <span className="subs-card__mark" aria-hidden><CircleSlash size={20} /></span>
          <span className="subs-card__body">
            <span className="subs-card__name">None of these</span>
            <span className="subs-card__blurb">VYSTRAL works the same for games you own.</span>
          </span>
          <Tick on={none} />
        </button>
      </div>
      <p className="subs-privacy">
        <Lock size={13} aria-hidden /> Your answer stays on this PC. VYSTRAL never signs in to these services or checks your accounts. Netflix Games are
        mobile only, so they aren’t listed.
      </p>
    </div>
  );
}

function Tick({ on }: { on: boolean }) {
  const reduce = useReducedMotion();
  return (
    <span className="subs-card__tick" aria-hidden data-on={on || undefined}>
      <AnimatePresence initial={false}>
        {on && (
          <motion.span
            key="t"
            initial={reduce ? { opacity: 0 } : { scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { scale: 0.4, opacity: 0 }}
            transition={pick(reduce, spring.micro)}
          >
            <Check size={13} strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function FamilyCard({ f, plans, onPick }: { f: FamilyMeta; plans: SubsPlanId[]; onPick: (p: SubsPlanId) => void }) {
  const id = useId();
  const chosen = familyPlan(plans, f.family);
  const single = f.plans.length === 1;
  if (single) {
    const plan = PLAN[f.plans[0]];
    return (
      <button type="button" className="subs-card" aria-pressed={!!chosen} data-family={f.family} onClick={() => onPick(plan.id)}
        aria-describedby={`${id}-b`}>
        <span className="subs-card__mark"><ServiceLogo service={f.mark} size={20} brand={!!chosen} decorative /></span>
        <span className="subs-card__body">
          <span className="subs-card__name">{plan.name}</span>
          <span className="subs-card__blurb" id={`${id}-b`}>{plan.blurb}{plan.hasList ? '' : ' No public game list yet, so no badges.'}</span>
        </span>
        <Tick on={!!chosen} />
      </button>
    );
  }
  return (
    <div className="subs-card subs-card--tiers" role="group" aria-labelledby={`${id}-n`} data-on={chosen ? true : undefined} data-family={f.family}>
      <span className="subs-card__mark"><ServiceLogo service={f.mark} size={20} brand={!!chosen} decorative /></span>
      <span className="subs-card__body">
        <span className="subs-card__name" id={`${id}-n`}>{f.name}</span>
        <span className="subs-tiers">
          {f.plans.map((p) => (
            <button key={p} type="button" className="subs-tier" aria-pressed={chosen === p} onClick={() => onPick(p)}
              aria-label={`${PLAN[p].name}. ${PLAN[p].blurb}`}>
              {PLAN[p].tier}
            </button>
          ))}
        </span>
        <span className="subs-card__blurb" aria-live="polite">{chosen ? PLAN[chosen].blurb : 'Pick your tier, if you have it.'}</span>
      </span>
      <Tick on={!!chosen} />
    </div>
  );
}

function GfnCard({ gfn, onPick }: { gfn: GfnPlanId; onPick: (g: GfnPlanId) => void }) {
  const id = useId();
  const on = gfn !== 'none';
  return (
    <div className="subs-card subs-card--tiers" role="group" aria-labelledby={`${id}-n`} data-on={on || undefined} data-family="gfn">
      <span className="subs-card__mark"><ServiceLogo service="geforce-now" size={20} brand={on} decorative /></span>
      <span className="subs-card__body">
        <span className="subs-card__name" id={`${id}-n`}>GeForce NOW</span>
        <span className="subs-tiers">
          {GFN_TIERS.filter((t) => t.value !== 'none').map((t) => (
            <button key={t.value} type="button" className="subs-tier" aria-pressed={gfn === t.value} onClick={() => onPick(t.value)}
              aria-label={`GeForce NOW ${t.label}. ${GFN_BLURB[t.value]}`}>
              {t.label}
            </button>
          ))}
        </span>
        <span className="subs-card__blurb" aria-live="polite">{on ? `${GFN_BLURB[gfn]} Also sets Cloud play’s hours meter.` : 'Your membership, if you stream with NVIDIA.'}</span>
      </span>
      <Tick on={on} />
    </div>
  );
}
