export type Role = "HIDE" | "SEEK" | "ADMIN";
export type GamePhase = "lobby" | "countdown" | "active" | "ended";

export type LngLat = [number, number];

export type PoiCategory =
  | "park"
  | "pub"
  | "bar"
  | "restaurant"
  | "cafe"
  | "museum"
  | "library"
  | "cinema"
  | "shop"
  | "golf"
  | "aquarium"
  | "hospital"
  | "station";

export const POI_CATEGORY_LABELS: Record<PoiCategory, string> = {
  park: "Parks",
  pub: "Pubs",
  bar: "Bars",
  restaurant: "Restaurants",
  cafe: "Cafes",
  museum: "Museums",
  library: "Libraries",
  cinema: "Cinemas",
  shop: "Shops",
  golf: "Golf Courses",
  aquarium: "Aquariums",
  hospital: "Hospitals",
  station: "Train Stations"
};

export interface Objective {
  id: string;
  name: string;
  category: PoiCategory;
  coordinates: LngLat;
  osmType?: string;
  osmId?: string;
}

export interface GameConfig {
  centerLat: number;
  centerLng: number;
  radiusM: number;
  objectiveCount: number;
  minDistanceM: number;
  maxDistanceM: number;
  totalMinutes: number;
  categories: PoiCategory[];
}

export interface PlayerPublic {
  id: string;
  name: string;
  role: Role | null;
  ready: boolean;
  online: boolean;
  joinedAt: number;
}

export interface PlayerInternal extends PlayerPublic {
  secret: string;
  sockets: string[];
}

export interface ProofRecord {
  id: string;
  hiderId: string;
  hiderName: string;
  objectiveIndex: number;
  objective: Objective;
  photoUrl: string;
  submittedAt: number;
}

export interface HiderRunState {
  playerId: string;
  name: string;
  objectiveIndex: number;
  caughtAt: number | null;
  proofs: ProofRecord[];
}

export type EndReason = "caught" | "time_up";

export interface GameState {
  id: string;
  phase: GamePhase;
  route: Objective[];
  config: GameConfig;
  startedAt: number | null;
  countdownStartedAt: number | null;
  endsAt: number | null;
  endedAt: number | null;
  endReason: EndReason | null;
  hiders: Record<string, HiderRunState>;
  seekerIds: string[];
  allProofs: ProofRecord[];
}

export interface AppState {
  phase: GamePhase;
  config: GameConfig;
  players: Record<string, PlayerInternal>;
  game: GameState | null;
}

export interface JoinGamePayload {
  name: string;
  role?: Role | null;
  adminPin?: string;
  playerId?: string | null;
  playerSecret?: string | null;
}

export interface SelectRolePayload {
  role: "HIDE" | "SEEK";
}

export interface SetReadyPayload {
  ready: boolean;
}

export type AdminConfigPayload = Partial<GameConfig>;

export interface LobbyUpdatePayload {
  phase: GamePhase;
  roster: PlayerPublic[];
  config: GameConfig;
  estimate: number;
}

export interface CountdownTickPayload {
  secondsRemaining: number;
}

export interface GameStartedPayload {
  game: {
    id: string;
    route: Objective[];
    config: GameConfig;
    startedAt: number;
    endsAt: number | null;
  };
}

export interface HiderStatusPayload {
  objectiveIndex: number;
  objective: Objective | null;
  totalObjectives: number;
  secondsRemaining: number;
  allDone: boolean;
  caughtAt: number | null;
}

export interface SeekerRouteProgress {
  index: number;
  status: "upcoming" | "in_progress" | "completed";
  // Seconds elapsed since game start when the proof was submitted, not an epoch timestamp.
  completedAt: number | null;
}

export interface SeekerStatusPayload {
  route: Objective[];
  progress: SeekerRouteProgress[];
  secondsRemaining: number;
}

export interface ProofAcceptedPayload {
  proof: ProofRecord;
  hiderId: string;
}

export interface PlayerCaughtPayload {
  playerId: string;
  name: string;
}

export interface GameOverStats {
  hiders: Array<{ playerId: string; name: string; objectivesCompleted: number; caughtAt: number | null }>;
  totalObjectives: number;
  elapsedSeconds: number;
}

export interface GameOverPayload {
  endReason: EndReason;
  stats: GameOverStats;
  gallery: ProofRecord[];
}
