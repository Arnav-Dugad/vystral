import { useCallback, useState } from 'react';
import { EyeOff, Eye, FolderOpen, Heart, Info, Play, FolderPlus, Check } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { isInstalled } from '../../lib/format';
import { openFolder, setCollection, setHidden, toggleFavorite } from '../../state/actions';
import { useStore } from '../../state/store';
import { Menu, type MenuEntry } from '../ui/Menu';

export function useGameMenu(game: Game) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAt(null), []);
  const navigate = useStore((s) => s.navigate);
  const launchGame = useStore((s) => s.launchGame);
  const collections = useStore((s) => s.library.collections);
  const installed = isInstalled(game);

  const entries: MenuEntry[] = [
    { label: installed ? 'Play' : 'Not installed', icon: <Play size={16} />, onSelect: () => void launchGame(game.id), disabled: !installed },
    { label: 'Details', icon: <Info size={16} />, onSelect: () => navigate({ name: 'game', id: game.id }) },
    { kind: 'separator' },
    { label: game.favorite ? 'Remove from favorites' : 'Add to favorites', icon: <Heart size={16} />, onSelect: () => void toggleFavorite(game) },
    ...(collections.length
      ? ([{ kind: 'label', label: 'Collections' }] as MenuEntry[]).concat(
          collections.slice(0, 8).map((c) => {
            const member = game.collections.includes(c.id);
            return { label: c.name, icon: member ? <Check size={16} /> : <FolderPlus size={16} />, onSelect: () => void setCollection(game, c.id, !member) };
          }),
        )
      : []),
    { kind: 'separator' },
    { label: 'Open install folder', icon: <FolderOpen size={16} />, onSelect: () => void openFolder(game), disabled: !installed },
    game.hidden
      ? { label: 'Show in library', icon: <Eye size={16} />, onSelect: () => void setHidden(game, false) }
      : { label: 'Hide from library', icon: <EyeOff size={16} />, onSelect: () => void setHidden(game, true) },
  ];

  return { open: setAt, element: <Menu at={at} entries={entries} onClose={close} label={`${game.title} actions`} /> };
}
