import { useState } from 'react';
import { ExternalLink, Link2, Terminal } from 'lucide-react';
import { call, errorMessage } from '../../../bridge/bridge';
import type { Game, ProtonSummary, ProtonTier } from '../../../bridge/types';
import { useIdentityStore } from '../../../state/identity';
import { FixMatchDialog } from '../IdentityMatch';
import { formatRelative } from '../../../lib/format';
import type { SteamLink } from '../../../lib/identity';
import { steamDataLabel } from '../../../lib/identity';
import { useStore } from '../../../state/store';
import { StatTile, type TileTone } from './StatTile';

const TIER_LABEL: Record<ProtonTier, string> = {
  platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked', pending: 'Not rated yet',
};
const TIER_HINT: Record<ProtonTier, string> = {
  platinum: 'Runs perfectly out of the box',
  gold: 'Runs perfectly after tweaks',
  silver: 'Runs with minor issues',
  bronze: 'Runs, but often crashes or has issues',
  borked: 'Doesn’t start or isn’t playable',
  pending: 'Too few reports to rate',
};
const TIER_TONE: Partial<Record<ProtonTier, TileTone>> = { platinum: 'ok', gold: 'ok', bronze: 'warn', borked: 'danger' };

/**
 * Track D4: "Runs on Linux" — ProtonDB's community rating of how well the game runs through Proton (Linux and Steam
 * Deck). Opt-in, for the game's own or matched Steam app; credited to ProtonDB (ODbL) and labelled when matched.
 */
export function ProtonTile({ p, params, link, index }: { p: ProtonSummary; params: Record<string, unknown>; link: SteamLink | null; index: number }) {
  if (p.status !== 'ok' || !p.tier) return null;
  const matched = steamDataLabel(link);
  const open = () => void call('protondb.open', params).catch((err) => useStore.getState().toast({ tone: 'info', title: errorMessage(err) }));
  return (
    <StatTile
      index={index} testId="tile-proton" label="Runs on Linux" icon={<Terminal size={15} />} tone={TIER_TONE[p.tier]}
      value={TIER_LABEL[p.tier]}
      sub={<>{TIER_HINT[p.tier]}{p.trending && p.trending !== p.tier ? <> · trending {TIER_LABEL[p.trending].toLowerCase()}</> : null}</>}
      action={<button className="gi-link gi-link--icon" onClick={open} aria-label="Open on ProtonDB (opens your browser)" title="Open on ProtonDB"><ExternalLink size={13} aria-hidden /></button>}
      visual={<p className="gi-note"><span className="num">{p.total.toLocaleString()}</span> {p.total === 1 ? 'player report' : 'player reports'} through Proton</p>}
      source={<>Rated by players on ProtonDB.com (ODbL){p.fetchedAt ? ` · checked ${formatRelative(p.fetchedAt).toLowerCase()}` : ''}{p.stale ? ' · couldn’t refresh' : ''}{matched ? <><br />{matched}</> : null}</>}
    />
  );
}

/**
 * Track D4: one quiet line above a non-Steam game's "At a glance" when Steam data is shown for its matched or chosen
 * Steam app — says so plainly and offers to fix the match.
 */
export function MatchedSteamNote({ game, link }: { game: Game; link: SteamLink | null }) {
  const [fixing, setFixing] = useState(false);
  const identity = useIdentityStore((s) => s.byGame[game.id] ?? null);
  const label = steamDataLabel(link);
  if (!label) return null;
  return (
    <p className="gi-matched" data-testid="matched-steam-note">
      <Link2 size={13} aria-hidden />
      <span>{label}.</span>
      {identity && <button type="button" className="gi-link" onClick={() => setFixing(true)}>Wrong game?</button>}
      {identity && <FixMatchDialog game={game} identity={identity} open={fixing} onClose={() => setFixing(false)} />}
    </p>
  );
}
