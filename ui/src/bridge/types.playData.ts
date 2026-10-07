// ---------- Track Y: play data and insights (mirror of Core/Contracts/PlayDataDtos.cs) ----------

/** One finished session with the hardware it started on. Display fields are null when unknown. */
export interface HardwareSession {
  sessionId: string;
  gameId: string;
  start: string;
  durationSeconds: number;
  driver: string | null;
  gpuName: string | null;
  width: number | null;
  height: number | null;
  refreshHz: number | null;
  hdr: boolean | null;
}

export type HardwareChangeKind = 'driver' | 'gpu' | 'display' | 'hdr';

/** A change between consecutive sessions that both knew the value; `at` is the first session on the new value. */
export interface HardwareChange {
  kind: HardwareChangeKind;
  at: string;
  sessionId: string;
  from: string | null;
  to: string | null;
}

/** A stretch of sessions on one driver (lane 'driver') or one display mode (lane 'display'). */
export interface HardwareSpan {
  lane: 'driver' | 'display';
  value: string;
  from: string;
  to: string;
  sessions: number;
}

export interface HardwareHistory {
  sessions: HardwareSession[];
  changes: HardwareChange[];
  spans: HardwareSpan[];
  withDriver: number;
  withDisplay: number;
}

/** How the energy estimate was made (shown in the method popover). */
export interface EnergyMethod {
  source: 'typical' | 'manual';
  gpuName: string | null;
  gpuClass: 'desktop' | 'laptop' | 'integrated' | 'unknown';
  gpuWatts: number;
  gpuKnown: boolean;
  cpuName: string | null;
  cpuWatts: number;
  cpuKnown: boolean;
  baseWatts: number;
  laptop: boolean;
  manualWatts: number | null;
  typicalLoad: number;
}

export interface EnergySession {
  sessionId: string;
  gameId: string;
  start: string;
  durationSeconds: number;
  kWh: number;
  avgWatts: number;
  /** One of the two loads wasn't recorded and a typical load was assumed. */
  partial: boolean;
}

export interface EnergyGame { gameId: string; kWh: number; sessions: number; hours: number }
/** `month` is 'YYYY-MM' in the PC's time zone. */
export interface EnergyMonth { month: string; kWh: number; sessions: number; hours: number }

export interface EnergyReport {
  enabled: boolean;
  method: EnergyMethod | null;
  /** Price per kWh, or null when no price was entered. */
  price: number | null;
  currency: string | null;
  totalKWh: number;
  sessions: number;
  /** Sessions without load samples (metrics were off), left out of every total. */
  excluded: number;
  partial: number;
  /** Newest first. */
  sessionList: EnergySession[];
  games: EnergyGame[];
  months: EnergyMonth[];
}

export interface BatteryPoint { at: string; percent: number; charging: boolean }

export interface ControllerBattery {
  /** Opaque hash of the controller's device id. */
  pad: string;
  name: string;
  points: BatteryPoint[];
  latest: number | null;
  charging: boolean | null;
  lastSeen: string | null;
  /** Usual drain in percentage points per hour, once there's enough history. */
  drainPerHour: number | null;
  minutesLeft: number | null;
}

export interface BatteryHistory {
  enabled: boolean;
  days: number;
  pads: ControllerBattery[];
}
