import type { Feature, Point, Polygon } from "geojson";

export type Role = "HIDER" | "SEEKER" | "ADMIN";
export type GamePhase = "setup" | "active" | "ended";
export type ProximityStatus = "Near" | "Far" | "Distant";
export type ClaimStatus = "accepted" | "disallowed";

export type GameMode = "CLASSIC" | "VIP_ESCORT" | "SAFEHOUSES";
export type HiderTeamRole = "VIP" | "BODYGUARD";
export type SafehouseState = "idle" | "breached" | "contested";

export type LngLat = [number, number];

export interface GameConfig {
  pingIntervalMinutes: number;
  locationDelayMinutes: number;
  lockdownIntervalCount: number;
  globalSqueezePercentage: number;
  lockdownRadius: number;
  lockdownForecastDistance: number;
  lockdownDurationSeconds: number;
  shrinkIntervalSeconds: number;
  gameDurationMinutes: number;
  objectiveMinDistance: number;
  objectiveMaxDistance: number;
  regularObjectivePoints: number;
  lockdownObjectivePoints: number;
  proximityThresholds: {
    near: number;
    far: number;
  };
  claimRadius: number;
  mode: GameMode;
  vipObjectiveTarget: number;
  safehouseRadius: number;
  safehouseCaptureTargetSeconds: number;
}

export interface PlayerPublic {
  id: string;
  name: string;
  role: Role;
  online: boolean;
  joinedAt: number;
  lastSeen: number | null;
}

export interface PlayerInternal extends PlayerPublic {
  secret: string;
  sockets: string[];
  coords?: LngLat;
  accuracy?: number | null;
}

export interface Objective {
  id: string;
  name: string;
  category: PoiCategory;
  coordinates: LngLat;
  source?: "postgis" | "overpass" | "fallback";
  osmType?: string;
  osmId?: string;
}

export type ObjectiveKind = "regular" | "lockdown";

export interface ObjectiveSlot {
  slotId: string;
  kind: ObjectiveKind;
  objective: Objective;
  scoreValue: number;
  createdAt: number;
  expiresAt: number | null;
}

export type PoiCategory =
  | "library"
  | "museum"
  | "station"
  | "cinema"
  | "hospital"
  | "park"
  | "restaurant"
  | "consulate"
  | "golf";

export interface HiderState {
  playerId: string;
  name: string;
  coords: LngLat;
  delayedCoordinates: LngLat;
  timestampOfCapture: string;
  history: Array<{ coordinates: LngLat; timestamp: number }>;
  pingCount: number;
  objectiveIndex: number;
  activeObjective: Objective;
  activeObjectives: ObjectiveSlot[];
  score: number;
  caughtAt: number | null;
  lockdownCircleGeoJSON: Feature<Polygon> | null;
  lastLockdownCircleGeoJSON: Feature<Polygon> | null;
  lockdownExpiresAt: number | null;
  nextLockdownCircleGeoJSON: Feature<Polygon> | null;
  nextLockdownStartsAt: number | null;
  lockdownTravelStartedAt: number | null;
  legalAreaGeoJSON: Feature<Polygon>;
  proximityStatus: ProximityStatus;
  isOutOfBounds: boolean;
  oobSamples: number;
  claims: ClaimRecord[];
  hiderRole?: HiderTeamRole;
  targetLabel?: string;
}

export interface SeekerState {
  playerId: string;
  name: string;
  coords: LngLat;
  history: Array<{ coordinates: LngLat; timestamp: number }>;
}

export interface ClaimRecord {
  id: string;
  hiderId: string;
  hiderName: string;
  objective: Objective;
  objectiveKind: ObjectiveKind;
  coordinates: LngLat;
  distanceMeters: number;
  photoUrl: string;
  status: ClaimStatus;
  scoreValue: number;
  createdAt: number;
  reason?: string;
  disallowedAt?: number;
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  score: number;
  caughtAt: number | null;
  becameSeekerAt: number | null;
}

export interface GameHistoryEntry {
  id: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  hiders: LeaderboardEntry[];
  seekers: Array<{ playerId: string; name: string }>;
  claims: ClaimRecord[];
}

export interface Safehouse {
  id: string;
  label: string;
  objective: Objective;
  center: LngLat;
  circleGeoJSON: Feature<Polygon>;
  state: SafehouseState;
}

export interface GameState {
  id: string;
  phase: GamePhase;
  startedAt: number;
  endedAt: number | null;
  leaderboard: LeaderboardEntry[];
  globalSafeZoneGeoJSON: Feature<Polygon>;
  config: GameConfig;
  shrinkCountdown: number;
  hiders: Record<string, HiderState>;
  seekers: Record<string, SeekerState>;
  claims: ClaimRecord[];
  oobCount: number;
  paused: boolean;
  safehouses?: Safehouse[];
  totalCaptureSeconds?: number;
}

export interface SetupState {
  center: LngLat;
  radius: number;
  globalSafeZoneGeoJSON: Feature<Polygon>;
  config: GameConfig;
}

export interface AppState {
  phase: GamePhase;
  setup: SetupState;
  players: Record<string, PlayerInternal>;
  game: GameState | null;
  winner: "HIDERS" | "SEEKERS" | null;
  history: GameHistoryEntry[];
}

export interface JoinGamePayload {
  name: string;
  role: Role;
  adminPin?: string;
  playerId?: string | null;
  playerSecret?: string | null;
}

export interface LocationUpdatePayload {
  gameId?: string;
  playerId?: string;
  coordinates: LngLat;
  accuracy?: number | null;
  timestamp: string;
}

export interface AdminConfigPayload {
  gameId?: string;
  center?: LngLat;
  radius?: number;
  pingIntervalMinutes?: number;
  locationDelayMinutes?: number;
  lockdownIntervalCount?: number;
  globalSqueezePercentage?: number;
  lockdownRadius?: number;
  lockdownForecastDistance?: number;
  lockdownDurationSeconds?: number;
  shrinkIntervalSeconds?: number;
  gameDurationMinutes?: number;
  objectiveMinDistance?: number;
  objectiveMaxDistance?: number;
  regularObjectivePoints?: number;
  lockdownObjectivePoints?: number;
  proximityThresholds?: {
    near?: number;
    far?: number;
  };
  claimRadius?: number;
  mode?: GameMode;
  vipObjectiveTarget?: number;
  safehouseRadius?: number;
  safehouseCaptureTargetSeconds?: number;
}

export interface SeekerPingPayload {
  phase: GamePhase;
  roster: PlayerPublic[];
  globalSafeZoneGeoJSON: Feature<Polygon> | null;
  gameSecondsRemaining: number | null;
  mode: GameMode;
  safehouses?: Safehouse[];
  totalCaptureSeconds?: number;
  captureTargetSeconds?: number;
  seekers: Array<{ playerId: string; name: string; coordinates: LngLat }>;
  hiders: Array<{
    hiderId: string;
    name: string;
    delayedCoordinates: LngLat;
    delayedTrail: LngLat[];
    timestampOfCapture: string;
    lockdownCircleGeoJSON: Feature<Polygon> | null;
    nextLockdownCircleGeoJSON: Feature<Polygon> | null;
    activeObjective: {
      id: string;
      name: string;
      category: PoiCategory;
      coordinates: LngLat;
    };
    activeObjectives: ObjectiveSlot[];
  }>;
}

export interface HiderStatusPayload {
  phase: GamePhase;
  roster: PlayerPublic[];
  gameId: string | null;
  me: {
    hiderId: string;
    name: string;
    coordinates: LngLat;
    proximityStatus: ProximityStatus;
    globalSafeZoneGeoJSON: Feature<Polygon>;
    myLockdownCircleGeoJSON: Feature<Polygon> | null;
    nextLockdownCircleGeoJSON: Feature<Polygon> | null;
    lockdownExpiresAt: number | null;
    nextLockdownStartsAt: number | null;
    lockdownTravelStartedAt: number | null;
    legalAreaGeoJSON: Feature<Polygon>;
    activeObjective: Objective;
    activeObjectives: ObjectiveSlot[];
    score: number;
    isOutOfBounds: boolean;
    shrinkCountdown: number;
    gameSecondsRemaining: number | null;
    config: GameConfig;
    mode: GameMode;
    hiderRole?: HiderTeamRole;
    teammates?: Array<{ hiderId: string; name: string; hiderRole?: HiderTeamRole; coordinates: LngLat }>;
    safehouses?: Safehouse[];
    totalCaptureSeconds?: number;
    captureTargetSeconds?: number;
  } | null;
}

export interface AdminStatePayload {
  phase: GamePhase;
  roster: PlayerPublic[];
  setup: SetupState;
  game: Omit<GameState, "hiders" | "seekers"> & {
    hiders: Array<Omit<HiderState, "proximityStatus">>;
    seekers: SeekerState[];
  } | null;
  winner: "HIDERS" | "SEEKERS" | null;
  history: GameHistoryEntry[];
}

export interface ClaimUploadResponse {
  ok: boolean;
  error?: string;
  claim?: ClaimRecord;
  nextObjective?: Objective;
  nextObjectives?: ObjectiveSlot[];
}

export const POI_CATEGORY_LABELS: Record<PoiCategory, string> = {
  library: "Library",
  museum: "Museum",
  station: "Train Station",
  cinema: "Cinema",
  hospital: "Hospital",
  park: "Park",
  restaurant: "Restaurant",
  consulate: "Consulate",
  golf: "Golf Course"
};

export type PointFeature = Feature<Point>;
