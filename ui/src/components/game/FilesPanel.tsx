import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, CloudOff, ExternalLink, FileSearch, FolderOpen, Package, RefreshCw, Save, ShieldCheck,
} from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { Game, ModItem, ModsList, ModSource, SaveLocation, SavesLookup } from '../../bridge/types';
import { modName, modsTotal, SAVE_PLATFORM, savesSummary, sortMods, sourceSummary, type ModSort } from '../../lib/libraryTools';
import { formatBytes, formatRelative, plural } from '../../lib/format';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { Badge, Button, IconButton, Segmented, Skeleton } from '../ui/primitives';
import { StoreLogo } from '../ui/StoreLogo';
import { ServiceLogo } from '../ui/ServiceLogo';
import './files-panel.css';

const PAGE = 40;

/**
 * Track X: a game's files — where it keeps its saves (PCGamingWiki, opt-in, checked on this PC) and its mods (Steam
 * Workshop, Vortex and Mod Organizer 2 in their default places). Everything here only reads: the one action is
 * "Open folder", which opens Explorer.
 */
export function FilesPanel({ game }: { game: Game }) {
  return (
    <div className="files">
      <SavesSection game={game} />
      <ModsSection game={game} />
    </div>
  );
}

// ---------- Saves ----------

function SavesSection({ game }: { game: Game }) {
  const [data, setData] = useState<SavesLookup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  const setSetting = useStore((s) => s.setSetting);
  const reduce = useReducedMotion();

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setData(await call<SavesLookup>('saves.lookup', { gameId: game.id, refresh }, 60_000));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [game.id]);

  useEffect(() => { void load(); }, [load]);

  const turnOn = async () => {
    await setSetting('dataSources.pcgamingwiki', true);
    await load();
  };
  const open = (l: SaveLocation) =>
    void call('saves.open', { gameId: game.id, locationId: l.id }).catch((err) => toast({ tone: 'info', title: 'Couldn’t open that folder', body: errorMessage(err) }));
  const article = () => void call('saves.openArticle', { gameId: game.id }).catch(() => undefined);

  return (
    <section className="files__section surface" aria-labelledby="files-saves">
      <header className="files__head">
        <span className="files__icon" aria-hidden><Save size={18} /></span>
        <div className="files__titles">
          <h3 id="files-saves" className="files__title">Save files</h3>
          <p className="files__lede" aria-live="polite">
            {loading && !data ? 'Looking…' : data?.status === 'ok' ? savesSummary(data) : 'Where this game keeps its saves on this PC.'}
          </p>
        </div>
        {data && ['ok', 'none', 'notFound', 'error'].includes(data.status) && (
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void load(true)}>Check again</Button>
        )}
      </header>

      {error && <Notice icon={<AlertTriangle size={18} />} title="Couldn’t look that up" body={error} action={<Button size="sm" onClick={() => void load()}>Try again</Button>} />}
      {!error && loading && !data && <div className="files__skeleton" aria-hidden><Skeleton height={56} radius={12} /><Skeleton height={56} radius={12} /></div>}
      {!error && data && (
        <>
          {data.status === 'off' && (
            <div className="files__optin">
              <span className="files__optin-mark" aria-hidden><ServiceLogo service="pcgamingwiki" size={20} decorative /></span>
              <div>
                <p className="files__optin-title">See where {game.title} saves</p>
                <p className="files__optin-body">
                  PCGamingWiki, a community wiki, lists where games keep their saves. With it on, VYSTRAL sends this game’s Steam app ID to
                  pcgamingwiki.com, then checks those folders on this PC (it only reads). Answers are kept on this PC for two weeks.
                </p>
              </div>
              <Button size="sm" variant="primary" icon={<FileSearch size={14} />} onClick={() => void turnOn()}>Look up save locations</Button>
            </div>
          )}
          {data.status === 'noSteamApp' && <Notice icon={<CircleDashed size={18} />} title="No save locations for this one" body={data.message ?? ''} />}
          {(data.status === 'offline' || data.status === 'busy') && <Notice icon={<CloudOff size={18} />} title={data.status === 'busy' ? 'After you play' : 'Offline'} body={data.message ?? ''} />}
          {data.status === 'notFound' && <Notice icon={<CircleDashed size={18} />} title="PCGamingWiki has no article for this game yet" body="It may be listed under another name. Nothing was checked on this PC." />}
          {data.status === 'none' && <Notice icon={<CircleDashed size={18} />} title="No Windows save location listed" body={`PCGamingWiki’s article doesn’t say where ${game.title} saves on Windows yet.`} />}
          {data.status === 'ok' && (
            <ul className="saves">
              <AnimatePresence initial={false}>
                {data.locations.map((l, i) => (
                  <motion.li
                    key={l.id}
                    className="saves__row"
                    data-state={l.exists ? 'found' : l.problem ? 'unsupported' : 'missing'}
                    initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={reduce ? { duration: 0.15 } : { ...spring.panel, delay: Math.min(i, 8) * 0.04 }}
                  >
                    <span className="saves__state" aria-hidden>
                      {l.exists ? <CheckCircle2 size={16} /> : l.problem ? <AlertTriangle size={16} /> : <CircleDashed size={16} />}
                    </span>
                    <div className="saves__text">
                      <div className="saves__meta">
                        <span className="saves__platform">{SAVE_PLATFORM[l.platform]}</span>
                        <span className="saves__status">
                          {l.exists
                            ? <>Found · {l.partial ? 'at least ' : ''}{formatBytes(l.bytes)}{l.files > 1 ? ` · ${plural(l.files, 'file')}` : ''}{l.modified ? ` · changed ${formatRelative(l.modified).toLowerCase()}` : ''}</>
                            : l.problem === 'unsupported' ? 'Can’t be checked (a registry key or an unusual path)'
                              : l.problem === 'noRoot' ? 'Its starting folder isn’t on this PC'
                                : 'Not on this PC'}
                        </span>
                      </div>
                      <code className="saves__path selectable" title={l.path ?? l.raw}>{l.path ?? l.display}</code>
                    </div>
                    {l.exists && <Button size="sm" variant="secondary" icon={<FolderOpen size={14} />} onClick={() => open(l)} aria-label={`Open folder: ${l.path}`}>Open folder</Button>}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
          {(data.status === 'ok' || data.status === 'none') && (
            <p className="files__credit">
              <ServiceLogo service="pcgamingwiki" size={14} decorative /> Save locations from{' '}
              <button type="button" className="files__link" onClick={article}>
                PCGamingWiki{data.article ? ` · ${data.article}` : ''} <ExternalLink size={11} aria-hidden />
              </button>
              , CC BY-NC-SA 3.0.{data.fetched ? ` Looked up ${formatRelative(data.fetched).toLowerCase()}.` : ''}{data.stale ? ' Couldn’t refresh just now, so this is the last answer.' : ''}
              {data.message ? ` ${data.message}` : ''}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ---------- Mods ----------

function ModsSection({ game }: { game: Game }) {
  const [data, setData] = useState<ModsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const toast = useStore((s) => s.toast);
  const setSetting = useStore((s) => s.setSetting);

  useEffect(() => {
    let live = true;
    setData(null);
    call<ModsList>('mods.list', { gameId: game.id }, 120_000)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(errorMessage(err)));
    return () => { live = false; };
  }, [game.id]);

  const fetchTitles = useCallback(async () => {
    setNaming(true);
    try {
      setData(await call<ModsList>('mods.titles', { gameId: game.id }, 60_000));
    } catch (err) {
      toast({ tone: 'info', title: 'Couldn’t get Workshop names', body: errorMessage(err) });
    } finally {
      setNaming(false);
    }
  }, [game.id, toast]);

  // Titles were turned on before: fill them in quietly.
  useEffect(() => {
    if (data?.titles === 'ready' && !naming) void fetchTitles();
  }, [data?.titles]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = data ? modsTotal(data.sources) : null;
  return (
    <section className="files__section surface" aria-labelledby="files-mods">
      <header className="files__head">
        <span className="files__icon" aria-hidden><Package size={18} /></span>
        <div className="files__titles">
          <h3 id="files-mods" className="files__title">Mods</h3>
          <p className="files__lede" aria-live="polite">
            {!data && !error ? 'Looking in the usual places…'
              : total && total.count ? `${plural(total.count, 'mod')} · ${formatBytes(total.bytes)} on this PC`
                : 'Steam Workshop items and mods staged by Vortex or Mod Organizer 2.'}
          </p>
        </div>
        {data?.titles === 'off' && (
          <Button size="sm" variant="ghost" loading={naming} onClick={() => void setSetting('dataSources.workshopTitles', true).then(fetchTitles)}>Show Workshop names</Button>
        )}
      </header>
      {error && <Notice icon={<AlertTriangle size={18} />} title="Couldn’t read the mod folders" body={error} />}
      {!error && !data && <div className="files__skeleton" aria-hidden><Skeleton height={72} radius={12} /></div>}
      {data && data.sources.length === 0 && (
        <Notice
          icon={<Package size={18} />}
          title="No mods found"
          body="VYSTRAL looked for Steam Workshop items, Vortex’s default staging folder and Mod Organizer 2 instances in their default place. Mods installed another way don’t show up here."
        />
      )}
      {data?.sources.map((s) => <SourceCard key={s.id} gameId={game.id} source={s} naming={naming} />)}
      {data && data.titles === 'off' && data.sources.some((s) => s.kind === 'workshop') && (
        <p className="files__credit">Workshop items show their numbers. “Show Workshop names” asks Steam’s public Workshop service for their titles (only the item numbers are sent).</p>
      )}
      {data && (data.titles === 'done' || naming) && data.sources.some((s) => s.kind === 'workshop') && (
        <p className="files__credit"><StoreLogo platform="steam" size={14} decorative /> Workshop titles from Steam.</p>
      )}
      <p className="files__safe"><ShieldCheck size={13} aria-hidden /> Read-only: VYSTRAL never changes, moves or deletes mods. Manage them in Steam or your mod manager.</p>
    </section>
  );
}

function SourceCard({ gameId, source, naming }: { gameId: string; source: ModSource; naming: boolean }) {
  const [open, setOpen] = useState(source.items.length <= 12);
  const [sort, setSort] = useState<ModSort>(source.kind === 'workshop' ? 'updated' : 'name');
  const [limit, setLimit] = useState(PAGE);
  const toast = useStore((s) => s.toast);
  const reduce = useReducedMotion();
  const id = useId();
  const items = sortMods(source.items, sort);
  const openFolder = (item?: ModItem) =>
    void call('mods.open', { gameId, sourceId: source.id, itemId: item?.id ?? null }).catch((err) => toast({ tone: 'info', title: 'Couldn’t open that folder', body: errorMessage(err) }));

  return (
    <article className="msrc" data-kind={source.kind} aria-labelledby={`${id}-t`}>
      <div className="msrc__head">
        <span className="msrc__mark" aria-hidden>{source.kind === 'workshop' ? <StoreLogo platform="steam" size={20} decorative /> : <Package size={18} />}</span>
        <div className="msrc__titles">
          <h4 id={`${id}-t`} className="msrc__title">{source.label}</h4>
          <p className="msrc__summary">{sourceSummary(source)}{source.detail ? ` · ${source.detail}` : ''}</p>
          <code className="msrc__path selectable" title={source.folder}>{source.folder}</code>
        </div>
        <div className="msrc__actions">
          <Button size="sm" variant="secondary" icon={<FolderOpen size={14} />} onClick={() => openFolder()}>Open folder</Button>
          {source.items.length > 0 && (
            <button className="msrc__toggle" aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen(!open)}>
              {open ? 'Hide list' : 'Show list'} <ChevronDown size={14} aria-hidden data-open={open || undefined} />
            </button>
          )}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`${id}-list`}
            className="msrc__body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={pick(reduce, spring.panel)}
          >
            <div className="msrc__tools">
              <Segmented label={`Sort ${source.label}`} value={sort} onChange={setSort} options={[{ value: 'name', label: 'Name' }, { value: 'size', label: 'Size' }, { value: 'updated', label: 'Updated' }]} />
            </div>
            <ul className="mods">
              {items.slice(0, limit).map((m) => (
                <li key={m.id} className="mods__row" data-present={m.present || undefined} data-enabled={m.enabled ?? undefined}>
                  <div className="mods__name">
                    <span className="mods__title" data-pending={(naming && source.kind === 'workshop' && !m.title) || undefined}>{modName(m)}</span>
                    {source.kind === 'workshop' && m.title && <span className="mods__id num">{m.id}</span>}
                  </div>
                  <div className="mods__facts">
                    {m.enabled != null && <Badge tone={m.enabled ? 'ok' : undefined}>{m.enabled ? 'On' : 'Off'}</Badge>}
                    {!m.present && <Badge tone="warn">Not downloaded yet</Badge>}
                    <span className="num mods__size">{formatBytes(m.bytes)}</span>
                    <span className="mods__date">{m.updated ? formatRelative(m.updated) : '—'}</span>
                    {m.present ? (
                      <IconButton label={`Open the folder of ${modName(m)}`} size="sm" onClick={() => openFolder(m)}><FolderOpen size={14} /></IconButton>
                    ) : <span className="mods__spacer" aria-hidden />}
                  </div>
                </li>
              ))}
            </ul>
            {items.length > limit && (
              <div className="msrc__more">
                <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, items.length - limit)} more of {items.length - limit}</Button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function Notice({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="files__notice" role="status">
      <span className="files__notice-icon" aria-hidden>{icon}</span>
      <div>
        <p className="files__notice-title">{title}</p>
        {body && <p className="files__notice-body">{body}</p>}
      </div>
      {action}
    </div>
  );
}
