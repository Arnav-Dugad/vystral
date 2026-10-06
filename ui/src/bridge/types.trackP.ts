// ---------- Track P: friends playing now, update-space forecast (mirror of FriendsActivityService / UpdateSpaceForecast) ----------

/** Steam persona states, named. */
export type PersonaState = 'online' | 'busy' | 'away' | 'snooze' | 'trade' | 'play' | 'offline';

/** One friend. `key` is an opaque hash (the page never sees SteamIDs); `avatar` is an art-host URL or null. */
export interface Friend {
  key: string;
  name: string;
  state: PersonaState;
  avatar: string | null;
  /** Steam appid of the game they're in (null for non-Steam games and when not playing). */
  appId: string | null;
  /** Steam's name for the game, when it sent one. */
  gameName: string | null;
  /** The VYSTRAL game when that game is in this library. */
  gameId: string | null;
  lastOnline: string | null;
}

export type FriendsStatus =
  | 'ok' | 'off' | 'notConnected' | 'noAccount' | 'offline' | 'dataSaver' | 'private' | 'invalidKey' | 'unavailable' | 'rateLimited';

export interface FriendsActivity {
  status: FriendsStatus;
  message: string | null;
  fetchedAt: string | null;
  friendCount: number;
  /** Online friends only (playing first). */
  friends: Friend[];
  /** Up to six friends seen in the last two days, only when nobody is online. */
  recentlyOnline: Friend[];
  /** These are the last results VYSTRAL got, not fresh ones. */
  stale: boolean;
  retryAt: string | null;
}

export type UpdateFit = 'ok' | 'tight' | 'short' | 'unknown';

export interface PendingUpdate {
  appId: string;
  gameId: string | null;
  name: string;
  kind: 'update' | 'install';
  phase: 'queued' | 'downloading' | 'staging' | 'paused';
  /** Room it still needs: remaining download + remaining staging. Null while Steam hasn't sized it yet. */
  needBytes: number | null;
  downloadRemaining: number;
  stageRemaining: number;
  sizeOnDisk: number;
  /** Rated on its own against the drive's free space today. */
  fit: UpdateFit;
  /** Steam is set to update this game only when it's launched. */
  whenLaunched: boolean;
  scheduledAt: string | null;
  /** Steam's code for the last update attempt, when it wasn't success. */
  lastResult: number | null;
}

export interface DriveForecast {
  /** "D:" or a mount folder. */
  drive: string;
  label: string | null;
  freeBytes: number;
  totalBytes: number;
  needBytes: number;
  /** Free space once every pending update with a known size has its room (negative = short). */
  afterBytes: number;
  /** Below this much free is "tight" (≈5 % of the drive, 1–50 GB). */
  tightBelowBytes: number;
  status: 'ok' | 'tight' | 'short';
  updates: PendingUpdate[];
}

export interface DiskForecast {
  /** Steam was found on this PC. */
  available: boolean;
  status: 'none' | 'ok' | 'tight' | 'short';
  scannedAt: string;
  pendingCount: number;
  drives: DriveForecast[];
}
