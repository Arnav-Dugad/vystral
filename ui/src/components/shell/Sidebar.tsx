import { motion } from 'motion/react';
import { HardDrive, BarChart3, BookOpen, Bot, Compass, Home, Images, LibraryBig, Settings2, Sparkles, Folder, Plus, Gift } from 'lucide-react';
import type { ReactNode } from 'react';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore, type Route } from '../../state/store';
import { NewBadge } from '../../whatsnew/NewBadge';

const NAV: { route: Route; label: string; icon: ReactNode }[] = [
  { route: { name: 'home' }, label: 'Home', icon: <Home size={18} /> },
  { route: { name: 'library' }, label: 'Library', icon: <LibraryBig size={18} /> },
  // Track U: search every connected source for any game, owned or not.
  { route: { name: 'discover' }, label: 'Discover', icon: <Compass size={18} /> },
  // Track W: shown once the (opt-in) wishlist is on, or while it's open (from the command bar, Settings or a notification).
  { route: { name: 'wishlist' }, label: 'Wishlist', icon: <Gift size={18} /> },
  { route: { name: 'journal' }, label: 'Journal', icon: <BookOpen size={18} /> },
  { route: { name: 'performance' }, label: 'Performance', icon: <BarChart3 size={18} /> },
  { route: { name: 'moments' }, label: 'Moments', icon: <Images size={18} /> },
  { route: { name: 'storage' }, label: 'Storage', icon: <HardDrive size={18} /> },
  { route: { name: 'constellation' }, label: 'Constellation', icon: <Sparkles size={18} /> },
  { route: { name: 'assistant' }, label: 'Assistant', icon: <Bot size={18} /> },
];

export function Sidebar() {
  const route = useStore((s) => s.route);
  const navigate = useStore((s) => s.navigate);
  const collections = useStore((s) => s.library.collections);
  const count = useStore((s) => s.library.games.filter((g) => !g.hidden).length);
  const reduce = useReducedMotion();
  const wishlistOn = useStore((s) => s.settings?.['wishlist.sync'] ?? false) || route.name === 'wishlist';

  const isActive = (r: Route) =>
    r.name === route.name && (r.name !== 'library' || !(route as { collectionId?: string }).collectionId);

  const item = (r: Route, label: string, icon: ReactNode, extra?: ReactNode, key = label) => {
    const active = r.name === 'library' && 'collectionId' in r ? route.name === 'library' && route.collectionId === r.collectionId : isActive(r);
    return (
      <button key={key} className="nav-item" aria-current={active ? 'page' : undefined} onClick={() => navigate(r)} title={label}>
        {active && (
          <>
            <motion.span layoutId="nav-pill" className="nav-item__pill" transition={reduce ? { duration: 0 } : spring.focus} />
            <motion.span layoutId="nav-bar" className="nav-item__bar" transition={reduce ? { duration: 0 } : spring.focus} />
          </>
        )}
        {icon}
        <span>{label}</span>
        {extra}
      </button>
    );
  };

  return (
    <nav className="sidebar" aria-label="Main">
      {NAV.filter((n) => n.route.name !== 'wishlist' || wishlistOn).map((n) => item(n.route, n.label, n.icon, n.route.name === 'library' ? <span className="nav-item__count">{count}</span> : <NewBadge k={`nav.${n.route.name}`} />))}
      <div className="sidebar__group">
        <div className="caps">Collections</div>
        {collections.map((c) => item({ name: 'library', collectionId: c.id }, c.name, <Folder size={17} />, <span className="nav-item__count">{c.count}</span>, c.id))}
        <button className="nav-item" aria-label="New collection" title="New collection" onClick={() => window.dispatchEvent(new CustomEvent('vystral:new-collection'))}>
          <Plus size={17} />
          <span>New collection</span>
        </button>
      </div>
      <div className="sidebar__spacer" />
      {item({ name: 'settings' }, 'Settings', <Settings2 size={18} />)}
    </nav>
  );
}
