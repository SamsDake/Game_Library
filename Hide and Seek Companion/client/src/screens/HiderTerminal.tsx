import { useEffect, useState } from "react";
import type { HiderStatusPayload, LngLat } from "@shared/types";
import { POI_CATEGORY_LABELS } from "@shared/types";
import { GameMap } from "../components/GameMap";
import { LocationPanel } from "../components/LocationPanel";
import { formatTime, googleMapsUrl } from "../format";

export function HiderTerminal({ name, status, message, isAdmin, onSubmitProof, onCaught, onEndGame, onOpenAdmin, onBackToLobby }: {
  name: string;
  status: HiderStatusPayload;
  message: string;
  isAdmin: boolean;
  onSubmitProof: (objectiveIndex: number, photo: File) => Promise<{ ok: boolean; error?: string }>;
  onCaught: () => void;
  onEndGame: () => void;
  onOpenAdmin: () => void;
  onBackToLobby: () => void;
}) {
  const [photo, setPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitFlash, setSubmitFlash] = useState(false);
  const [caughtArmedUntil, setCaughtArmedUntil] = useState(0);
  const caughtArmed = caughtArmedUntil > Date.now();
  const [myLocation, setMyLocation] = useState<LngLat | null>(null);

  function pickPhoto(file: File | null) {
    setPhoto(file);
    setPreviewUrl(file ? URL.createObjectURL(file) : null);
  }

  // Revokes the previous blob URL whenever it's replaced, and on unmount.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function submit() {
    if (!photo || submitting) return;
    setSubmitting(true);
    const result = await onSubmitProof(status.objectiveIndex, photo);
    setSubmitting(false);
    if (result.ok) {
      pickPhoto(null);
      setSubmitFlash(true);
      setTimeout(() => setSubmitFlash(false), 1600);
    }
  }

  function caughtClick() {
    if (caughtArmed) {
      setCaughtArmedUntil(0);
      onCaught();
    } else {
      setCaughtArmedUntil(Date.now() + 3000);
    }
  }

  return <div className="app">
    <div className="screen">
      <div className="terminal-header">
        <button className="btn btn-ghost" onClick={onBackToLobby}>Lobby</button>
        <div className="terminal-name">{name}</div>
        <div className="role-pill hide">HIDER</div>
        <div className="progress-pill mono">{status.objective ? `Objective ${status.objectiveIndex + 1} of ${status.totalObjectives}` : ""}</div>
        <div className="timer mono">{formatTime(status.secondsRemaining)}</div>
        {isAdmin && <button className="btn btn-ghost" onClick={onOpenAdmin}>Admin</button>}
        {isAdmin && <button className="btn btn-ghost" onClick={onEndGame}>End Game</button>}
      </div>
      {message && <div className="notice">{message}</div>}
      <LocationPanel onLocationChange={setMyLocation} />
      {status.objective && !status.allDone && <div className="objective-card">
        <div className="objective-cat">{POI_CATEGORY_LABELS[status.objective.category]}</div>
        <div className="objective-name">{status.objective.name}</div>
        <a className="btn btn-ghost" href={googleMapsUrl(status.objective.coordinates)} target="_blank" rel="noreferrer">Open in Google Maps</a>
        <GameMap mode="hider" objective={status.objective} myLocation={myLocation} />
        <div className="proof-panel">
          {previewUrl ? <>
            <div className="photo-thumb-wrap"><img className="photo-thumb" src={previewUrl} /></div>
            <div className="proof-actions">
              <button className="btn btn-ghost" onClick={() => pickPhoto(null)}>Retake</button>
              <button className="btn btn-teal" disabled={submitting} onClick={() => void submit()}>Submit Proof</button>
            </div>
          </> : <label className="proof-btn">
            Upload Proof Photo
            <input type="file" accept="image/*" capture="environment" onChange={e => pickPhoto(e.target.files?.[0] || null)} />
          </label>}
        </div>
      </div>}
      {status.allDone && <div className="done-banner">Final objective complete. Survive until the clock runs out!</div>}
      {submitFlash && <div className="flash-banner">Nice! Next objective unlocked.</div>}
      <button className={`caught-btn${caughtArmed ? " armed" : ""}`} onClick={caughtClick}>
        {caughtArmed ? "Tap again to confirm" : "I'VE BEEN CAUGHT"}
      </button>
    </div>
  </div>;
}
