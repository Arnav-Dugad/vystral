import { useEffect, useState, type ReactNode } from 'react';
import { Gift, Lock } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { SteamApiStatus } from '../../bridge/types';
import { useStore } from '../../state/store';
import { Button, Toggle } from '../../components/ui/primitives';

/**
 * Track W: Settings → Library & stores → Steam extras. The wishlist and friends' recent games need the
 * Steam Web API key (both off by default); news and patch notes use Steam's public news feed.
 */
export function SteamExtrasSettings() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const navigate = useStore((s) => s.navigate);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const localOnly = settings?.['privacy.localOnly'] ?? false;

  useEffect(() => {
    let alive = true;
    call<SteamApiStatus>('steam.status').then((s) => alive && setConfigured(s.configured)).catch(() => alive && setConfigured(false));
    return () => { alive = false; };
  }, []);

  if (!settings) return null;
  const needsKey = configured === false ? ' Connect the Steam Web API above first.' : '';
  return (
    <section className="sgroup" aria-labelledby="steamextras-title">
      <h2 className="sgroup__title" id="steamextras-title">Steam extras</h2>
      <p className="sgroup__desc">Your wishlist, what friends played and each game’s news. All are read from Steam’s official Web API and cached on this PC.</p>
      <div className="sgroup__rows surface">
        <Row
          id="steamextras-wishlist"
          label="Wishlist"
          hint={<>Your Steam wishlist with today’s prices, the lowest price ever and release dates, refreshed about twice a day. VYSTRAL also keeps a price history for each game from then on.{needsKey}</>}
          control={
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {settings['wishlist.sync'] && <Button size="sm" variant="ghost" icon={<Gift size={14} />} onClick={() => navigate({ name: 'wishlist' })}>Open</Button>}
              <Toggle id="steamextras-wishlist" label="Wishlist" checked={settings['wishlist.sync']} disabled={localOnly || configured === false}
                onChange={(v) => void setSetting('wishlist.sync', v)} />
            </div>
          }
        />
        <Row
          id="steamextras-friends"
          label="Friends who played a game"
          hint={<>On game pages, which friends played it in the last two weeks and for how long. Reads each friend’s public recently-played list, slowly and at most every few hours; friends with private game details are skipped. Saved on this PC only.{needsKey}</>}
          control={<Toggle id="steamextras-friends" label="Friends who played a game" checked={settings['friends.gameHistory']} disabled={localOnly || configured === false}
            onChange={(v) => void setSetting('friends.gameHistory', v)} />}
        />
        <Row
          id="steamextras-news"
          label="News and patch notes"
          hint="A News tab on Steam game pages with the game’s official announcements, highlighting updates since you last played. Uses Steam’s public news feed (no key); images load only when you open a post."
          control={<Toggle id="steamextras-news" label="News and patch notes" checked={settings['news.patchNotes']} disabled={localOnly}
            onChange={(v) => void setSetting('news.patchNotes', v)} />}
        />
        <div className="srow steamapi__privacy">
          <Lock size={16} aria-hidden />
          <div className="srow__hint">
            Requests go to Steam (api.steampowered.com, the Steam store and its image servers) and, for the lowest price ever, to IsThereAnyDeal or CheapShark as set in Data sources. Nothing is sent while a game runs or in Offline mode.
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ label, hint, control, id }: { label: ReactNode; hint?: ReactNode; control: ReactNode; id?: string }) {
  return (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={id}>{label}</label>
        {hint && <div className="srow__hint">{hint}</div>}
      </div>
      <div className="srow__control">{control}</div>
    </div>
  );
}
