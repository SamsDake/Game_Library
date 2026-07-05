export function Range({ label, value, min, max, step, unit, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void;
}) {
  return <div className="field">
    <div className="field-label"><span>{label}</span><span className="field-value mono">{value}{unit}</span></div>
    <input className="slider" type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
  </div>;
}

// Two-handle slider — `low`/`high` are kept at least one `step` apart.
export function DualRange({ label, low, high, min, max, step, unit, onChange }: {
  label: string; low: number; high: number; min: number; max: number; step: number; unit: string; onChange: (low: number, high: number) => void;
}) {
  return <div className="field">
    <div className="field-label"><span>{label}</span><span className="field-value mono">{low}{unit} - {high}{unit}</span></div>
    <input className="slider" type="range" min={min} max={max} step={step} value={low} onChange={e => onChange(Math.min(Number(e.target.value), high - step), high)} />
    <input className="slider" type="range" min={min} max={max} step={step} value={high} onChange={e => onChange(low, Math.max(Number(e.target.value), low + step))} />
  </div>;
}

export function NumberField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (value: number) => void }) {
  return <div className="field"><div className="field-label"><span>{label}</span></div><input className="coord" type="number" step={step} value={value} onChange={e => onChange(Number(e.target.value))} /></div>;
}
