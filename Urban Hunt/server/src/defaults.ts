import type { GameConfig, Objective, PoiCategory } from "../../shared/types";

export const DEFAULT_CONFIG: GameConfig = {
  pingIntervalMinutes: 3,
  locationDelayMinutes: 3,
  lockdownIntervalCount: 3,
  globalSqueezePercentage: 10,
  lockdownRadius: 500,
  lockdownForecastDistance: 250,
  lockdownDurationSeconds: 120,
  shrinkIntervalSeconds: 120,
  gameDurationMinutes: 60,
  objectiveMinDistance: 150,
  objectiveMaxDistance: 1500,
  regularObjectivePoints: 1,
  lockdownObjectivePoints: 2,
  proximityThresholds: { near: 200, far: 1000 },
  claimRadius: 40,
  mode: "CLASSIC",
  vipObjectiveTarget: 5,
  safehouseRadius: 40,
  safehouseCaptureTargetSeconds: 600
};

const london: Array<[PoiCategory, string, number, number]> = [
  ["library", "Barbican Library", -0.0867, 51.5199],
  ["museum", "Museum of London", -0.0966, 51.5177],
  ["station", "London Bridge Station", -0.0872, 51.5031],
  ["cinema", "Barbican Cinema", -0.0930, 51.5203],
  ["hospital", "St Bartholomews Hospital", -0.1001, 51.5174],
  ["park", "Postmans Park", -0.0974, 51.5169],
  ["restaurant", "Borough Market", -0.0910, 51.5055],
  ["museum", "Tate Modern", -0.0994, 51.5076],
  ["station", "Cannon Street Station", -0.0904, 51.5113],
  ["library", "Guildhall Library", -0.0922, 51.5155],
  ["cinema", "Everyman Barbican", -0.0951, 51.5201],
  ["park", "Finsbury Circus Gardens", -0.0857, 51.5172],
  ["restaurant", "Sweetings", -0.0922, 51.5121],
  ["hospital", "Moorfields Eye Hospital", -0.0894, 51.5263]
];

export const FALLBACK_OBJECTIVES: Objective[] = london.map(([category, name, lon, lat], index) => ({
  id: `fallback-${category}-${index}`,
  name,
  category,
  coordinates: [lon, lat],
  source: "fallback"
}));
