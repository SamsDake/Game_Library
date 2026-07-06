import { useState } from "react";
import type { LngLat, SeekerStatusPayload } from "@shared/types";
import { POI_CATEGORY_LABELS } from "@shared/types";
import { GameMap } from "../components/GameMap";
import { formatTime, googleMapsUrl } from "../format";

export function SeekerTerminal({ status, message, isAdmin, onEndGame, onOpenAdmin }: { status: SeekerStatusPayload; message: string; isAdmin: boolean; onEndGame: () => void; onOpenAdmin: () => void }) {
  const [focusOn, setFocusOn] = useState<LngLat | null>(null);
  const completedCount = status.progress.filter(p => p.status === "completed").length;

  const statusLabel = (s: "upcoming" | "in_progress" | "completed") =>
    s === "completed" ? "Completed" : s === "in_progress" ? "In Progress" : "Upcoming";

  return <div className="app">
    <div className="screen">
      <div className="terminal-header">
        <div className="role-pill seek">SEEKER</div>
        <div className="progress-pill mono">{completedCount} / {status.route.length} found</div>
        <div className="timer mono">{formatTime(status.secondsRemaining)}</div>
        {isAdmin && <button className="btn btn-ghost" onClick={onOpenAdmin}>Admin</button>}
        {isAdmin && <button className="btn btn-ghost" onClick={onEndGame}>End Game</button>}
      </div>
      {message && <div className="notice">{message}</div>}
      <div className="seeker-grid">
        <GameMap mode="seeker" route={status.route} progress={status.progress} focusOn={focusOn} />
        <div className="route-list">
          {status.route.map((o, i) => {
            const progress = status.progress[i];
            return <div key={o.id} className={`route-row ${progress?.status || "upcoming"}`} onClick={() => setFocusOn(o.coordinates)}>
              <div className="route-num mono">{i + 1}</div>
              <div className="route-info">
                <div className="route-name">{o.name}</div>
                <div className="route-cat">{POI_CATEGORY_LABELS[o.category]}</div>
              </div>
              <div className="route-time mono">{progress?.completedAt != null ? formatTime(progress.completedAt) : ""}</div>
              <div className={`status-pill ${progress?.status || "upcoming"}`}>{statusLabel(progress?.status || "upcoming")}</div>
              <a className="route-map-link" href={googleMapsUrl(o.coordinates)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Maps</a>
            </div>;
          })}
        </div>
      </div>
    </div>
  </div>;
}
