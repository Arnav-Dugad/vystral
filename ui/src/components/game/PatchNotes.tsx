import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, ChevronDown, CloudOff, ExternalLink, ImageOff, Megaphone, Newspaper, RefreshCw, Sparkles, Wrench } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { Game, NewsBlock, NewsFeed, NewsPost } from '../../bridge/types';
import { formatDate, formatRelative, lastPlayed } from '../../lib/format';
import { groupNewsBlocks, sinceLastPlayed, updatedSince } from '../../lib/steamExtras';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { Badge, Button, EmptyState, Skeleton } from '../ui/primitives';
import './steam-extras.css';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; data: NewsFeed };

/**
 * Track W: the game's official Steam announcements and patch notes. Posts are sanitized natively into
 * plain text blocks (no HTML ever reaches the page); images are Steam CDN images copied into the art
 * cache when you open a post. Posts newer than your last session are highlighted.
 */
export function PatchNotes({ game }: { game: Game }) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const navigate = useStore((s) => s.navigate);
  const setSetting = useStore((s) => s.setSetting);
  const enabled = useStore((s) => s.settings?.['news.patchNotes'] ?? true);
  const last = lastPlayed(game).at;

  // Only the newest answer counts (turning the setting on and the effect can both ask).
  const seq = useRef(0);
  const load = useCallback(async (refresh = false) => {
    const mine = ++seq.current;
    if (refresh) setBusy(true);
    else setState({ kind: 'loading' });
    try {
      const data = await call<NewsFeed>('news.get', { gameId: game.id, refresh }, 60_000);
      if (mine === seq.current) setState({ kind: 'done', data });
    } catch (err) {
      if (mine === seq.current) setState({ kind: 'error', message: errorMessage(err) });
    } finally {
      if (refresh) setBusy(false);
    }
  }, [game.id]);

  useEffect(() => void load(), [load, enabled]);

  if (state.kind === 'loading') return <NewsSkeleton />;
  if (state.kind === 'error')
    return <EmptyState art="none" icon={<AlertTriangle size={30} />} title="News couldn’t be loaded" body={state.message}
      actions={<Button icon={<RefreshCw size={15} />} onClick={() => void load()}>Try again</Button>} />;
  const data = state.data;
  switch (data.status) {
    case 'off':
      return <EmptyState icon={<Newspaper size={30} />} title="News and patch notes are off" body="Turn them on to see this game’s official Steam announcements here. They come from Steam’s public news feed; no key is needed."
        actions={<Button variant="primary" onClick={() => void Promise.resolve(setSetting('news.patchNotes', true)).then(() => load())}>Show news</Button>} />;
    case 'notSteam':
      return <EmptyState icon={<Newspaper size={30} />} title="No news feed for this game" body="Patch notes come from Steam’s news for Steam games. This game isn’t from Steam." />;
    case 'offline':
      return <EmptyState icon={<CloudOff size={30} />} title="Offline mode is on" body="VYSTRAL isn’t contacting Steam, and no news was saved on this PC for this game yet."
        actions={<Button onClick={() => navigate({ name: 'settings', section: 'privacy' })}>Privacy settings</Button>} />;
    case 'unavailable':
    case 'rateLimited':
      return <EmptyState art="none" icon={<AlertTriangle size={30} />} title="Steam didn’t send the news" body={data.message ?? 'Try again in a little while.'}
        actions={<Button icon={<RefreshCw size={15} />} loading={busy} onClick={() => void load(true)}>Try again</Button>} />;
    case 'none':
      return <EmptyState art="tide" icon={<Megaphone size={30} />} title="No announcements yet" body={`${game.title} hasn’t posted official news on Steam recently.`} />;
    default:
      return <NewsList game={game} data={data} lastPlayedAt={last} busy={busy} onRefresh={() => void load(true)} onChange={(d) => setState({ kind: 'done', data: d })} />;
  }
}

function NewsList({ game, data, lastPlayedAt, busy, onRefresh, onChange }: {
  game: Game; data: NewsFeed; lastPlayedAt: string | null; busy: boolean; onRefresh: () => void; onChange: (d: NewsFeed) => void;
}) {
  const since = useMemo(() => sinceLastPlayed(data.posts, lastPlayedAt), [data.posts, lastPlayedAt]);
  // The newest post opens by itself when it's news to you.
  const [openGid, setOpenGid] = useState<string | null>(() => (data.posts[0] && updatedSince(data.posts[0], lastPlayedAt) ? data.posts[0].gid : null));

  return (
    <div className="news">
      <div className="news__head">
        {since.count > 0 ? (
          <p className="news__since" role="status">
            <Sparkles size={15} aria-hidden />
            {since.patches > 0
              ? `Updated since you last played: ${since.patches === 1 ? 'one patch' : `${since.patches} patches`}${since.count > since.patches ? ` and ${since.count - since.patches} more ${since.count - since.patches === 1 ? 'post' : 'posts'}` : ''}.`
              : `${since.count === 1 ? 'One new post' : `${since.count} new posts`} since you last played.`}
          </p>
        ) : (
          <p className="news__since news__since--quiet">{lastPlayedAt ? `Nothing new since you last played, ${formatRelative(lastPlayedAt).toLowerCase()}.` : 'Official announcements from Steam.'}</p>
        )}
        <div className="news__tools">
          {data.fetchedAt && <span className="news__when" data-stale={data.stale || undefined}>{data.stale ? 'Saved' : 'Checked'} {formatRelative(data.fetchedAt).toLowerCase()}</span>}
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={busy} onClick={onRefresh}>Refresh</Button>
        </div>
      </div>
      {data.message && <p className="news__note" role="status"><AlertTriangle size={14} aria-hidden /> {data.message}</p>}
      <ol className="news__list" aria-label={`${data.posts.length} posts from Steam`}>
        {data.posts.map((post, i) => (
          <NewsItem key={post.gid} game={game} post={post} index={i} fresh={updatedSince(post, lastPlayedAt)} open={openGid === post.gid}
            onToggle={() => setOpenGid((g) => (g === post.gid ? null : post.gid))} onChange={onChange} />
        ))}
      </ol>
      <p className="news__src">From {game.title}’s official announcements on Steam. Formatting and links are simplified; open a post on Steam to see it in full.</p>
    </div>
  );
}

function NewsItem({ game, post, index, fresh, open, onToggle, onChange }: {
  game: Game; post: NewsPost; index: number; fresh: boolean; open: boolean; onToggle: () => void; onChange: (d: NewsFeed) => void;
}) {
  const reduce = useReducedMotion();
  const toast = useStore((s) => s.toast);
  const dataSaver = useStore((s) => s.settings?.['dataSaver.enabled'] ?? false);
  const bodyId = useId();
  const [loadingImages, setLoadingImages] = useState(false);

  const loadImages = useCallback(async (force: boolean) => {
    setLoadingImages(true);
    try {
      onChange(await call<NewsFeed>('news.images', { gameId: game.id, gid: post.gid, force }, 60_000));
    } catch (err) {
      if (force) toast({ tone: 'info', title: 'Images couldn’t be loaded', body: errorMessage(err) });
    } finally {
      setLoadingImages(false);
    }
  }, [game.id, post.gid, onChange, toast]);

  // Opening a post brings its images (not with Data saver, unless asked).
  useEffect(() => {
    if (open && post.images > post.imagesLoaded && !dataSaver) void loadImages(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const openOnSteam = () => void call('news.open', { gameId: game.id, gid: post.gid }).catch((err) => toast({ tone: 'info', title: errorMessage(err) }));
  const missing = post.images - post.imagesLoaded;

  return (
    <motion.li
      className="news-item surface"
      data-fresh={fresh || undefined}
      data-open={open || undefined}
      initial={reduce || index > 8 ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.15 } : { ...spring.panel, delay: Math.min(index, 8) * 0.04 }}
    >
      <h3 className="news-item__heading">
        <button type="button" className="news-item__toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="news-item__meta">
            {post.patch ? <Badge tone="accent" icon={<Wrench size={11} />}>Patch notes</Badge> : <Badge icon={<Megaphone size={11} />}>News</Badge>}
            {fresh && <Badge tone="ok" icon={<Sparkles size={11} />}>Since you last played</Badge>}
            <time dateTime={post.date} title={formatDate(post.date, { dateStyle: 'full', timeStyle: 'short' })}>{formatRelative(post.date)}</time>
          </span>
          <span className="news-item__title">{post.title}</span>
          {!open && post.excerpt && <span className="news-item__excerpt">{post.excerpt}</span>}
          <ChevronDown size={16} className="news-item__chev" data-open={open || undefined} aria-hidden />
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={bodyId}
            className="news-item__body selectable"
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, transition: { duration: 0.18 } }}
            transition={reduce ? { duration: 0.15 } : spring.panel}
          >
            <NewsBody blocks={post.blocks} />
            <div className="news-item__foot">
              {post.author && <span className="news-item__author">Posted by {post.author}</span>}
              {missing > 0 && (loadingImages
                ? <span className="news-item__author" role="status">Loading images…</span>
                : (
                  <Button size="sm" variant="ghost" icon={<ImageOff size={14} />} onClick={() => void loadImages(true)}>
                    {`Load ${missing === 1 ? 'image' : `${missing} images`}`}{dataSaver ? ' (Data saver is on)' : ''}
                  </Button>
                ))}
              <Button size="sm" icon={<ExternalLink size={14} />} onClick={openOnSteam}>Open full post</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

/** Renders sanitized blocks as React elements; text is always text. */
function NewsBody({ blocks }: { blocks: NewsBlock[] }) {
  const groups = groupNewsBlocks(blocks);
  if (groups.length === 0) return <p className="news-body__empty">This post has no text VYSTRAL can show. Open it on Steam.</p>;
  return (
    <div className="news-body">
      {groups.map((g, i) => {
        if (g.kind === 'list') return <ul key={i}>{g.items.map((b, j) => <li key={j}><Spans block={b} /></li>)}</ul>;
        const b = g.block;
        switch (b.kind) {
          case 'h': return <h4 key={i}><Spans block={b} /></h4>;
          case 'quote': return <blockquote key={i}><Spans block={b} /></blockquote>;
          case 'code': return <pre key={i}><code>{b.spans.map((s) => s.text).join('')}</code></pre>;
          case 'hr': return <hr key={i} />;
          case 'img': return b.image ? <img key={i} className="news-body__img" src={b.image} alt="" loading="lazy" decoding="async" draggable={false} /> : null;
          default: return <p key={i}><Spans block={b} /></p>;
        }
      })}
    </div>
  );
}

function Spans({ block }: { block: NewsBlock }) {
  return (
    <>
      {block.spans.map((s, i) => {
        const text = s.text;
        if (s.bold && s.italic) return <strong key={i}><em>{text}</em></strong>;
        if (s.bold) return <strong key={i}>{text}</strong>;
        if (s.italic) return <em key={i}>{text}</em>;
        return <span key={i}>{text}</span>;
      })}
    </>
  );
}

function NewsSkeleton() {
  return (
    <div className="news" aria-busy="true" aria-label="Loading news">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="news-item surface" style={{ padding: 'var(--s-4)', display: 'grid', gap: 8 }}>
          <Skeleton width={140} height={14} />
          <Skeleton width="70%" height={18} />
          <Skeleton width="90%" height={12} />
        </div>
      ))}
    </div>
  );
}
