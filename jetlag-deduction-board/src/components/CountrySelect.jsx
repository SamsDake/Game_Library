// CountrySelect.jsx
import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';

export default function CountrySelect() {
  const { countries, selectedIds, toggleCountry } = useStore();
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? countries.filter((c) => c.name.toLowerCase().includes(needle)) : countries;
    return list.slice(0, 60);
  }, [countries, q]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Pick the countries/regions in play. Their union becomes the starting hiding zone.
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search countries…"
        className="w-full rounded-lg bg-slate-800 px-3 py-2 text-sm outline-none ring-1 ring-slate-700 focus:ring-cyan-500"
      />

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map((id) => {
            const c = countries.find((x) => x.id === id);
            return (
              <button
                key={id}
                onClick={() => toggleCountry(id)}
                className="rounded-full bg-cyan-500/20 px-2.5 py-1 text-xs text-cyan-200 ring-1 ring-cyan-500/40 hover:bg-cyan-500/30"
              >
                {c?.name || id} ✕
              </button>
            );
          })}
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-lg ring-1 ring-slate-800">
        {countries.length === 0 && <p className="p-3 text-xs text-slate-500">Loading country data…</p>}
        {filtered.map((c) => {
          const on = selectedIds.includes(c.id);
          return (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-800/60"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggleCountry(c.id)}
                className="accent-cyan-500"
              />
              <span className={on ? 'text-cyan-200' : 'text-slate-300'}>{c.name}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
