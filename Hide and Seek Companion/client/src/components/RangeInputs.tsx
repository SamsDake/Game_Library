import { useEffect, useState } from "react";

// Local state gives the thumb instant visual feedback while dragging — the `value` prop is
// server-confirmed and arrives after a network round trip, which is too slow to drive the drag directly.
export function Range({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const clamped = Math.min(Math.max(local, min), max);
  return <div className="field">
    <div className="field-label"><span>{label}</span><span className="field-value mono">{clamped}{unit}</span></div>
    <input className="slider" type="range" min={min} max={max} step={step} value={clamped} onChange={e => { const v = Number(e.target.value); setLocal(v); onChange(v); }} />
  </div>;
}

// Two-handle slider — `low`/`high` are kept at least one `step` apart.
export function DualRange({ label, low, high, min, max, step, unit, onChange }: {
  label: string; low: number; high: number; min: number; max: number; step: number; unit: string; onChange: (low: number, high: number) => void;
}) {
  const [localLow, setLocalLow] = useState(low);
  const [localHigh, setLocalHigh] = useState(high);
  useEffect(() => setLocalLow(low), [low]);
  useEffect(() => setLocalHigh(high), [high]);
  return <div className="field">
    <div className="field-label"><span>{label}</span><span className="field-value mono">{localLow}{unit} - {localHigh}{unit}</span></div>
    <input className="slider" type="range" min={min} max={max} step={step} value={localLow} onChange={e => { const v = Math.min(Number(e.target.value), localHigh - step); setLocalLow(v); onChange(v, localHigh); }} />
    <input className="slider" type="range" min={min} max={max} step={step} value={localHigh} onChange={e => { const v = Math.max(Number(e.target.value), localLow + step); setLocalHigh(v); onChange(localLow, v); }} />
  </div>;
}

export function NumberField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (value: number) => void }) {
  return <div className="field"><div className="field-label"><span>{label}</span></div><input className="coord" type="number" step={step} value={value} onChange={e => onChange(Number(e.target.value))} /></div>;
}
