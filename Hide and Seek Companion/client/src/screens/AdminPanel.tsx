import type { GameConfig, PlayerPublic, PoiCategory } from "@shared/types";
import { OBJECTIVE_CATEGORIES } from "@shared/poi-categories";
import { POI_CATEGORY_LABELS } from "@shared/types";
import { GameMap } from "../components/GameMap";
import { DualRange, Range } from "../components/RangeInputs";

export function AdminPanel({ config, estimate, roster, message, onUpdateConfig, onStartGame, onBack }: {
  config: GameConfig;
  estimate: number;
  roster: PlayerPublic[];
  message: string;
  onUpdateConfig: (partial: Partial<GameConfig>) => void;
  onStartGame: () => void;
  onBack: () => void;
}) {
  const toggleCategory = (cat: PoiCategory) => {
    const has = config.categories.includes(cat);
    if (has && config.categories.length === 1) return;
    const categories = has ? config.categories.filter(c => c !== cat) : [...config.categories, cat];
    onUpdateConfig({ categories });
  };
  const availWarning = config.objectiveCount > estimate;

  return <div className="app">
    <div className="screen">
      <div className="admin-header">
        <div className="brand">ADMIN <span className="dot">&middot;</span> GAME SETUP</div>
        <button className="btn btn-ghost back-btn" onClick={onBack}>&larr; Back</button>
      </div>
      {message && <div className="notice">{message}</div>}
      <div className="admin-grid">
        <div className="admin-map-col">
          <GameMap mode="admin" center={[config.centerLng, config.centerLat]} radiusM={config.radiusM}
            onCenterChange={([lng, lat]) => onUpdateConfig({ centerLng: lng, centerLat: lat })} />
          <div className="map-hint mono">Click or drag the pin to set the game center</div>
        </div>
        <div className="admin-form-col">
          <Range label="Map Radius" value={config.radiusM} min={500} max={5000} step={100} unit="m"
            onChange={radiusM => onUpdateConfig({ radiusM })} />
          <div className="field">
            <div className="avail-info mono">
              ~{estimate} objectives available in this area
              {availWarning && <span className="avail-warning"> &middot; reduce radius or add categories to reach {config.objectiveCount}</span>}
            </div>
          </div>
          <Range label="Objective Count" value={config.objectiveCount} min={3} max={Math.max(3, Math.min(15, estimate))} step={1} unit=""
            onChange={objectiveCount => onUpdateConfig({ objectiveCount })} />
          <DualRange label="Objective Spacing" low={config.minDistanceM} high={config.maxDistanceM} min={100} max={3000} step={50} unit="m"
            onChange={(minDistanceM, maxDistanceM) => onUpdateConfig({ minDistanceM, maxDistanceM })} />
          <Range label="Total Game Time" value={config.totalMinutes} min={10} max={120} step={5} unit=" min"
            onChange={totalMinutes => onUpdateConfig({ totalMinutes })} />
          <div className="field">
            <div className="field-label"><span>Objective Categories</span></div>
            <div className="chip-grid">
              {OBJECTIVE_CATEGORIES.map(cat => (
                <button key={cat} className={`chip${config.categories.includes(cat) ? " selected" : ""}`} onClick={() => toggleCategory(cat)}>
                  {POI_CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="roster">
        <div className="roster-title">Lobby <span className="mono">({roster.length})</span></div>
        {roster.map(p => <div className="roster-row" key={p.id}>
          <div className={`roster-avatar ${p.role === "HIDE" ? "teal" : p.role === "SEEK" ? "orange" : "grey"}`}>{p.name[0]?.toUpperCase() || "?"}</div>
          <div className="roster-name">{p.name}</div>
          {p.role && <div className={`roster-badge ${p.role === "HIDE" ? "hide" : "seek"}`}>{p.role}</div>}
          <div className={`ready-dot ${p.ready ? "on" : ""}`} />
        </div>)}
      </div>
      <button className="btn btn-primary" onClick={onStartGame}>Start Game</button>
    </div>
  </div>;
}
