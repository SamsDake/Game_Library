import type { GameOverStats, ProofRecord } from "@shared/types";
import { assetUrl } from "../api";
import { formatTime } from "../format";

export function GameEnd({ endReason, stats, gallery, isAdmin, onPlayAgain }: {
  endReason: "caught" | "time_up";
  stats: GameOverStats;
  gallery: ProofRecord[];
  isAdmin: boolean;
  onPlayAgain: () => void;
}) {
  const headline = endReason === "caught" ? "CAUGHT!" : "TIME'S UP";
  const sub = endReason === "caught"
    ? "One or more hiders were caught before the clock ran out."
    : "The hiders survived the full game without being caught.";

  return <div className="app">
    <div className="glow" />
    <div className="screen center-wrap">
      <div className={`end-headline ${endReason === "caught" ? "caught" : "timeup"}`}>{headline}</div>
      <div className="end-sub">{sub}</div>
      <div className="end-stats">
        <div className="stat"><div className="stat-value mono">{formatTime(stats.elapsedSeconds)}</div><div className="stat-label">Time Elapsed</div></div>
        <div className="stat"><div className="stat-value mono">{stats.totalObjectives}</div><div className="stat-label">Total Objectives</div></div>
      </div>
      <div className="roster">
        <div className="roster-title">Hiders</div>
        {stats.hiders.map(h => <div className="roster-row" key={h.playerId}>
          <div className="roster-name">{h.name}</div>
          <div className="mono">{h.objectivesCompleted}/{stats.totalObjectives}</div>
          <div className={`ready-dot ${h.caughtAt ? "on" : ""}`} />
        </div>)}
      </div>
      {gallery.length > 0 && <>
        <div className="gallery-title mono">Submitted Proof</div>
        <div className="gallery-grid">
          {gallery.map(g => <div className="gallery-item" key={g.id}>
            <img className="gallery-thumb" src={assetUrl(g.photoUrl)} />
            <div className="gallery-name">{g.objective.name}</div>
            <div className="gallery-time mono">{g.hiderName}</div>
          </div>)}
        </div>
      </>}
      {isAdmin && <button className="btn btn-primary" onClick={onPlayAgain}>Play Again</button>}
    </div>
  </div>;
}
