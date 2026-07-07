import { useState } from "react";
import type { LngLat, SeekerStatusPayload } from "@shared/types";
import { POI_CATEGORY_LABELS } from "@shared/types";
import { GameMap } from "../components/GameMap";
import { LocationPanel } from "../components/LocationPanel";
import { formatTime, googleMapsUrl, hiderColor } from "../format";

export function SeekerTerminal({ status, message, isAdmin, onEndGame, onOpenAdmin, onBackToLobby }: { status: SeekerStatusPayload; message: string; isAdmin: boolean; onEndGame: () => void; onOpenAdmin: () => void; onBackToLobby: () => void }) {
  const [focusOn, setFocusOn] = useState<LngLat | null>(null);

  const statusLabel = (s: "upcoming" | "in_progress" | "completed") =>
    s === "completed" ? "Completed" : s === "in_progress" ? "In Progress" : "Upcoming";

  return <div className="app">
    <div className="screen">
      <div className="terminal-header">
        <button className="btn btn-ghost" onClick={onBackToLobby}>Lobby</button>
        <div className="role-pill seek">SEEKER</div>
        <div className="progress-pill mono">{status.routes.length} hider{status.routes.length === 1 ? "" : "s"} in play</div>
        <div className="timer mono">{formatTime(status.secondsRemaining)}</div>
        {isAdmin && <button className="btn btn-ghost" onClick={onOpenAdmin}>Admin</button>}
        {isAdmin && <button className="btn btn-ghost" onClick={onEndGame}>End Game</button>}
      </div>
      {message && <div className="notice">{message}</div>}
      <LocationPanel />
      <div className="seeker-grid">
        <GameMap mode="seeker" hidersRoutes={status.routes} focusOn={focusOn} />
        <div className="route-list">
          {status.routes.map(hiderRoute => <div className="hider-route-group" key={hiderRoute.hiderId}>
            <div className="hider-route-title mono">
              <span className="hider-dot" style={{ background: hiderColor(hiderRoute.hiderId) }} />
              {hiderRoute.hiderName}
            </div>
            {hiderRoute.route.map((o, i) => {
              const progress = hiderRoute.progress[i];
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
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}
