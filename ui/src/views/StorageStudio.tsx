import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { HardDrive, Info, Recycle, ShieldCheck, Store, Trash2 } from 'lucide-react';
import { call, errorMessage } from '../bridge/bridge';
import type { DriveInfo, Game, PlatformKey } from '../bridge/types';
import { formatBytes, formatRelative, PLATFORM_NAMES } from '../lib/format';
import { exit, pick, spring } from '../lib/motion';
import { bigAndUnplayed, driveUsage, gamesOnDrive, unplayedLabel, type DriveGame, type Suggestion } from '../lib/storage';
import { neighbor, squarify, type Direction, type TreemapRect } from '../lib/treemap';
import { useReducedMotion, useStore } from '../state/store';
import { GameCover } from '../components/game/GameCover';
import { InstallBadge } from '../components/game/InstallProgress';
import { Badge, Button, EmptyState, PlatformBadge, SectionHead, Skeleton } from '../components/ui/primitives';
import { EmptyArt } from '../components/ui/EmptyArt';
import { HoldToConfirm } from '../components/controller/HoldToConfirm';
import { Dialog } from '../components/ui/Dialog';
import './storage-studio.css';

/** Storage Studio: where installed games live, and what could be freed up through the stores. */
export function StorageStudioView() {
  const games = useStore((s) => s.library.games);
  const loaded = useStore((s) => s.libraryLoaded);
  const storeDrives = useStore((s) => s.drives);
  const [drives, setDrives] = useState<DriveInfo[] | null>(storeDrives.length ? storeDrives : null);
  const [uninstall, setUninstall] = useState<DriveGame | null>(null);

  // Refresh capacity on open; the store's list may be minutes old.
  useEffect(() => {
    let alive = true;
    call<DriveInfo[]>('system.drives')
      .then((d) => {
        if (!alive) return;
        setDrives(d);
        useStore.setState({ drives: d });
      })
      .catch(() => alive && setDrives((prev) => prev ?? []));
    return () => {
      alive = false;
    };
  }, [games]);

  const fixed = useMemo(() => (drives ?? []).filter((d) => !d.removable).sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name)), [drives]);
  const suggestions = useMemo(() => bigAndUnplayed(games), [games]);

  return (
    <div className="page storage">
      <header className="storage__head">
        <span className="caps">Storage</span>
        <h1 className="storage__title">Storage Studio</h1>
        <p className="storage__lede">
          See where your installed games live and what you could free up. VYSTRAL never deletes files: uninstalling always happens in the store that installed the game.
        </p>
      </header>

      {!loaded || drives == null ? (
        <div className="storage__layout">
          <div className="storage__drives">
            <Skeleton height={64} />
            <Skeleton height={340} />
          </div>
          <Skeleton height={420} />
        </div>
      ) : fixed.length === 0 ? (
        <EmptyState art="orbits" icon={<HardDrive size={30} />} title="No drives to show" body="VYSTRAL couldn’t read any fixed drives on this PC." />
      ) : (
        <div className="storage__layout">
          <div className="storage__drives">
            {fixed.map((d) => (
              <DriveSection key={d.name} drive={d} games={games} />
            ))}
          </div>
          <Suggestions data={suggestions} onUninstall={setUninstall} />
        </div>
      )}

      <UninstallDialog target={uninstall} onClose={() => setUninstall(null)} />
    </div>
  );
}

// ---------- Drive ----------

function DriveSection({ drive, games }: { drive: DriveInfo; games: Game[] }) {
  const onDrive = useMemo(() => gamesOnDrive(games, drive.name), [games, drive.name]);
  const usage = driveUsage(drive, onDrive);
  const pct = (n: number) => (usage.total > 0 ? (n / usage.total) * 100 : 0);
  const platforms = [...new Set(onDrive.map((g) => g.platform))];
  const label = `${drive.label || (drive.isSystem ? 'Windows' : 'Local disk')} (${drive.name})`;

  return (
    <section className="drive surface" aria-labelledby={`drive-${drive.name}`}>
      <div className="drive__head">
        <div className="drive__name">
          <HardDrive size={18} aria-hidden />
          <h2 id={`drive-${drive.name}`}>{label}</h2>
          {drive.isSystem && <Badge>System</Badge>}
        </div>
        <div className="drive__free num">{formatBytes(usage.free)} free of {formatBytes(usage.total)}</div>
      </div>

      <div
        className="capbar"
        role="img"
        aria-label={`${label}: games ${formatBytes(usage.games)}, other files ${formatBytes(usage.other)}, free ${formatBytes(usage.free)}`}
      >
        <span className="capbar__games" style={{ width: `${pct(usage.games)}%` }} />
        <span className="capbar__other" style={{ width: `${pct(usage.other)}%` }} />
      </div>
      <div className="capbar__legend">
        <span><i className="dot dot--games" aria-hidden /> Games VYSTRAL knows <b className="num">{formatBytes(usage.games)}</b></span>
        <span><i className="dot dot--other" aria-hidden /> Everything else <b className="num">{formatBytes(usage.other)}</b></span>
        <span><i className="dot dot--free" aria-hidden /> Free <b className="num">{formatBytes(usage.free)}</b></span>
      </div>

      {onDrive.length === 0 ? (
        <p className="drive__empty">No installed games with a known size on this drive.</p>
      ) : (
        <>
          <Treemap items={onDrive} driveTotal={usage.total} label={`Games on ${label}, sized by space used`} />
          <div className="drive__platforms" aria-label="Colour key">
            {platforms.map((p) => <PlatformBadge key={p} platform={p} />)}
            <span className="drive__count">{onDrive.length} {onDrive.length === 1 ? 'game' : 'games'}</span>
          </div>
        </>
      )}
    </section>
  );
}

// ---------- Treemap ----------

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function Treemap({ items, driveTotal, label }: { items: DriveGame[]; driveTotal: number; label: string }) {
  const navigate = useStore((s) => s.navigate);
  const reduce = useReducedMotion();
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = Math.round(Math.max(240, Math.min(440, width * 0.46)));
  const rects = useMemo(
    () => (width > 0 ? squarify(items.map((g) => ({ id: g.installation.id, value: g.sizeBytes, data: g })), width, height) : []),
    [items, width, height],
  );
  const [active, setActive] = useState(0);
  const [tip, setTip] = useState<{ index: number; via: 'hover' | 'focus' } | null>(null);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const gamesTotal = items.reduce((s, g) => s + g.sizeBytes, 0);

  useEffect(() => {
    if (active >= rects.length) setActive(0);
  }, [rects.length, active]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const dir: Direction | null = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : null;
    let next = i;
    if (dir) next = neighbor(rects, i, dir);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rects.length - 1;
    else return;
    e.preventDefault();
    if (next !== i) {
      setActive(next);
      tiles.current[next]?.focus();
    }
  };

  const tipRect = tip ? rects[tip.index] : null;

  return (
    <div ref={ref} className="treemap" style={{ height }} role="group" aria-label={`${label}. Use arrow keys to move between games and Enter to open one.`}>
      {rects.map((r, i) => (
        <Tile
          key={r.id}
          rect={r}
          index={i}
          reduce={reduce}
          active={i === active}
          share={driveTotal > 0 ? r.value / driveTotal : 0}
          gamesShare={gamesTotal > 0 ? r.value / gamesTotal : 0}
          refCb={(el) => (tiles.current[i] = el)}
          onKey={onKey}
          onFocus={() => {
            setActive(i);
            setTip({ index: i, via: 'focus' });
          }}
          onBlur={() => setTip((t) => (t?.via === 'focus' && t.index === i ? null : t))}
          onHover={(on) => setTip(on ? { index: i, via: 'hover' } : (t) => (t?.via === 'hover' && t.index === i ? null : t))}
          onOpen={() => navigate({ name: 'game', id: r.data.game.id })}
        />
      ))}
      <AnimatePresence>
        {tipRect && (
          <TileTip key="tip" rect={tipRect} width={width} height={height} driveTotal={driveTotal} reduce={reduce} />
        )}
      </AnimatePresence>
    </div>
  );
}

function Tile({
  rect, index, active, share, gamesShare, reduce, refCb, onKey, onFocus, onBlur, onHover, onOpen,
}: {
  rect: TreemapRect<DriveGame>;
  index: number;
  active: boolean;
  share: number;
  gamesShare: number;
  reduce: boolean;
  refCb: (el: HTMLButtonElement | null) => void;
  onKey: (e: KeyboardEvent, i: number) => void;
  onFocus: () => void;
  onBlur: () => void;
  onHover: (on: boolean) => void;
  onOpen: () => void;
}) {
  const g = rect.data;
  const gap = 3;
  const w = Math.max(0, rect.w - gap);
  const h = Math.max(0, rect.h - gap);
  const roomy = w > 110 && h > 54;
  const tiny = w < 34 || h < 24;
  // Wide tiles read best with landscape art; tall, narrow ones with the portrait cover.
  const art = w >= h * 0.9 ? g.game.art.hero ?? g.game.art.header ?? g.game.art.cover : g.game.art.cover ?? g.game.art.hero;
  return (
    <motion.button
      ref={refCb}
      type="button"
      className="tile-t"
      data-tiny={tiny || undefined}
      tabIndex={active ? 0 : -1}
      style={{ ['--pc' as string]: `var(--p-${g.platform})`, left: rect.x, top: rect.y, width: w, height: h }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? { duration: 0.15 } : { ...spring.page, delay: Math.min(index, 30) * 0.012 }}
      aria-label={`${g.game.title}, ${PLATFORM_NAMES[g.platform]}, ${formatBytes(g.sizeBytes)}, ${(share * 100).toFixed(1)} percent of the drive`}
      onKeyDown={(e) => onKey(e, index)}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={onOpen}
    >
      {!tiny && art && <img className="tile-t__art" src={art} alt="" loading="lazy" decoding="async" draggable={false} />}
      {roomy && (
        <span className="tile-t__label">
          <span className="tile-t__title">{g.game.title}</span>
          <span className="tile-t__size num">{formatBytes(g.sizeBytes)} · {(gamesShare * 100).toFixed(gamesShare < 0.1 ? 1 : 0)}%</span>
        </span>
      )}
      {!roomy && !tiny && <span className="tile-t__mini num">{formatBytes(g.sizeBytes)}</span>}
    </motion.button>
  );
}

function TileTip({ rect, width, height, driveTotal, reduce }: { rect: TreemapRect<DriveGame>; width: number; height: number; driveTotal: number; reduce: boolean }) {
  const g = rect.data;
  const tipW = 260;
  const below = rect.y + rect.h + 120 < height || rect.y < 110;
  const left = Math.max(0, Math.min(width - tipW, rect.x + rect.w / 2 - tipW / 2));
  const top = below ? Math.min(height - 8, rect.y + rect.h + 8) : Math.max(0, rect.y - 8);
  const lp = lastPlayedOf(g.game);
  return (
    <motion.div
      className="tile-tip"
      role="tooltip"
      style={{ left, top, width: tipW, translateY: below ? 0 : '-100%' }}
      initial={{ opacity: 0, scale: reduce ? 1 : 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: exit }}
      transition={pick(reduce, spring.effect)}
    >
      <div className="tile-tip__title">{g.game.title}</div>
      <div className="tile-tip__row"><PlatformBadge platform={g.platform} /></div>
      <div className="tile-tip__row num">{formatBytes(g.sizeBytes)} · {driveTotal > 0 ? `${((g.sizeBytes / driveTotal) * 100).toFixed(1)}% of the drive` : ''}</div>
      <div className="tile-tip__row">{lp ? `Last played ${formatRelative(lp).toLowerCase()}` : 'Never played'}</div>
      <div className="tile-tip__hint">Enter or click to open</div>
    </motion.div>
  );
}

function lastPlayedOf(game: Game): string | null {
  let at = game.lastTrackedPlay;
  for (const i of game.installations) if (i.importedLastPlayed && (!at || i.importedLastPlayed > at)) at = i.importedLastPlayed;
  return at;
}

// ---------- Suggestions ----------

function Suggestions({ data, onUninstall }: { data: { items: Suggestion[]; reclaimable: number }; onUninstall: (g: DriveGame) => void }) {
  const navigate = useStore((s) => s.navigate);
  const reduce = useReducedMotion();
  return (
    <aside className="suggest surface" aria-labelledby="suggest-title">
      <SectionHead title={<span id="suggest-title">Big and unplayed for 6+ months</span>} />
      {data.items.length === 0 ? (
        <div className="suggest__empty">
          <EmptyArt kind="hills" seed="storage-suggestions" icon={<Recycle size={22} aria-hidden />} />
          <p>Nothing to suggest. Every installed game over 10 GB was played in the last six months.</p>
        </div>
      ) : (
        <>
          <div className="suggest__total">
            <span className="num">{formatBytes(data.reclaimable)}</span>
            <span>could be freed by uninstalling {data.items.length === 1 ? 'this game' : `these ${data.items.length} games`} in their stores</span>
          </div>
          <ul className="suggest__list">
            {data.items.map((s, i) => (
              <motion.li
                key={s.installation.id}
                className="suggest__item"
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring.panel, delay: reduce ? 0 : Math.min(i, 12) * 0.03 }}
              >
                <button type="button" className="suggest__cover" onClick={() => navigate({ name: 'game', id: s.game.id })} aria-label={`Open ${s.game.title}`}>
                  <GameCover game={s.game} />
                  <InstallBadge gameId={s.game.id} />
                </button>
                <div className="suggest__info">
                  <div className="suggest__title truncate" title={s.game.title}>{s.game.title}</div>
                  <div className="suggest__meta">
                    <span className="num">{formatBytes(s.sizeBytes)}</span>
                    {s.installation.drive && <span>on {s.installation.drive}</span>}
                    <PlatformBadge platform={s.platform} compact />
                  </div>
                  <div className="suggest__played">{unplayedLabel(s)}</div>
                </div>
                <StoreAction item={s} onUninstall={onUninstall} />
              </motion.li>
            ))}
          </ul>
        </>
      )}
      <p className="suggest__note">
        <ShieldCheck size={14} aria-hidden /> Suggestions only. Nothing is removed unless you confirm it in the store’s own uninstall window.
      </p>
    </aside>
  );
}

function StoreAction({ item, onUninstall }: { item: DriveGame; onUninstall: (g: DriveGame) => void }) {
  const toast = useStore((s) => s.toast);
  if (item.platform === 'steam' && /^\d{1,10}$/.test(item.installation.platformGameId)) {
    return (
      <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => onUninstall(item)} aria-label={`Uninstall ${item.game.title} in Steam`}>
        Uninstall…
      </Button>
    );
  }
  if (item.platform === 'manual') {
    return <span className="suggest__manual" title="Added by you: remove it the way you installed it.">Added by you</span>;
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<Store size={14} />}
      aria-label={`Open ${item.game.title} in ${PLATFORM_NAMES[item.platform]}`}
      onClick={() =>
        void call('game.openInStore', { installationId: item.installation.id }).catch((err) =>
          toast({ tone: 'info', title: `Couldn’t open ${PLATFORM_NAMES[item.platform as PlatformKey]}`, body: errorMessage(err) }),
        )
      }
    >
      Open in {PLATFORM_NAMES[item.platform]}
    </Button>
  );
}

function UninstallDialog({ target, onClose }: { target: DriveGame | null; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<DriveGame | null>(target);
  useEffect(() => {
    if (target) setLast(target);
  }, [target]);
  const t = target ?? last;

  const confirm = async () => {
    if (!t) return;
    setBusy(true);
    try {
      await call('steam.uninstall', { gameId: t.game.id });
      onClose();
      toast({ tone: 'info', title: 'Steam’s uninstall window is open', body: `Confirm there to remove ${t.game.title}. VYSTRAL updates your library when Steam finishes.` });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t ask Steam to uninstall', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={t ? `Uninstall ${t.game.title} with Steam?` : 'Uninstall with Steam?'}
      describedBy="uninstall-desc"
      actions={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>Keep it</Button>
          <HoldToConfirm loading={busy} onConfirm={() => void confirm()}>Open Steam’s uninstall</HoldToConfirm>
        </>
      }
    >
      {t && (
        <div id="uninstall-desc" className="uninstall">
          <p>Here’s exactly what happens:</p>
          <ol className="uninstall__steps">
            <li>Steam shows its own uninstall confirmation. Nothing happens until you confirm there.</li>
            <li>If you confirm, Steam removes the game’s files{t.sizeBytes ? <> and frees about <strong className="num">{formatBytes(t.sizeBytes)}</strong></> : null}{t.installation.drive ? ` on ${t.installation.drive}` : ''}.</li>
            <li>Saves synced to Steam Cloud stay in Steam Cloud. Some games keep saves only on this PC, so check first if this game matters to you.</li>
            <li>VYSTRAL deletes nothing itself. The game stays in your library as not installed, with your notes and play history.</li>
          </ol>
          <p className="uninstall__hint"><Info size={14} aria-hidden /> You can reinstall it any time from its page in VYSTRAL.</p>
        </div>
      )}
    </Dialog>
  );
}
