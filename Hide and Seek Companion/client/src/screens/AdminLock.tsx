import { useState } from "react";

export function AdminLock({ message, onSubmit, onBack }: {
  message: string;
  onSubmit: (pin: string) => void;
  onBack: () => void;
}) {
  const [pin, setPin] = useState("");
  return <div className="app">
    <div className="glow" />
    <div className="screen center-wrap">
      <button className="btn btn-ghost back-btn" onClick={onBack}>&larr; Back</button>
      <div className="lock-card">
        <div className="lock-title">Admin Access</div>
        {message && <div className="notice">{message}</div>}
        <input className="name-input" type="password" placeholder="Admin PIN" value={pin} autoFocus
          onChange={e => setPin(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") onSubmit(pin); }} />
        <button className="btn btn-primary" onClick={() => onSubmit(pin)}>Access</button>
      </div>
    </div>
  </div>;
}
