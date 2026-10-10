/**
 * What Immersive's voice-over says for the focused tile (Track T). Pure, so the wording is
 * unit-tested: a name, then a short state — never the whole description.
 */
import { PLATFORM_NAMES, plural } from '../../lib/format';
import { progressFraction } from '../../lib/installProgress';
import { gameState, sentence, spokenDuration } from '../../lib/voiceover';
import { SORT_LABEL, type Row, type Tile } from './rows';
import { discoverItemSpeech } from './discoverRows';

export function tileSpeech(tile: Tile, now = Date.now()): string {
  switch (tile.kind) {
    case 'game':
      return sentence(tile.game.title, tile.pinned ? `Jump back in. ${gameState(tile.game, { lastPlayed: true })}` : gameState(tile.game));
    case 'store':
      return sentence(PLATFORM_NAMES[tile.platform], `${plural(tile.count, 'game')}. Press A to browse`);
    case 'genre':
      return sentence(tile.genre, `${plural(tile.count, 'game')}. Press A to browse`);
    case 'playing': {
      if (tile.phase !== 'running') return sentence(`Starting ${tile.game.title}`);
      const start = tile.startedAt ? Date.parse(tile.startedAt) : NaN;
      const length = Number.isFinite(start) ? `, ${spokenDuration((now - start) / 1000)} so far` : '';
      return sentence(`Now playing: ${tile.game.title}${length}`, 'Press A to return to the game');
    }
    case 'download': {
      const f = progressFraction(tile.progress);
      const what = tile.progress.kind === 'update' ? 'Updating' : tile.progress.phase === 'paused' ? 'Paused' : tile.progress.phase === 'queued' ? 'Queued' : 'Installing';
      return sentence(tile.game.title, `${what}${f != null ? `, ${Math.round(f * 100)} percent` : ''}`);
    }
    case 'tool':
      if (tile.tool.type === 'sort') return sentence(`Sort: ${SORT_LABEL[tile.tool.sort]}`, 'Press A to change');
      return sentence(`Show ${tile.tool.label}`, `${plural(tile.tool.count, 'game')}${tile.tool.active ? ', selected' : ''}`);
    // Track C6: Immersive Discover.
    case 'discover':
      return sentence(discoverItemSpeech(tile.item), 'Press A for details');
    case 'search':
      return tile.query ? sentence(`Search for ${tile.query}`, 'Press A to search') : sentence('Search any game', 'Press A to type');
    case 'note':
      return sentence(tile.title, tile.busy ? null : tile.body);
  }
}

/** Focus speech: the row's name first when the row changed (or the section changed). */
export function focusSpeech(row: Row, tile: Tile, opts: { rowChanged: boolean; now?: number }): string {
  const head = opts.rowChanged && row.kind !== 'library' ? row.title : '';
  return sentence(head, tileSpeech(tile, opts.now));
}
