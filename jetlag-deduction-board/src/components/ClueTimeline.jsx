// ClueTimeline.jsx
import { useStore } from '../lib/store';
import { areaKm2, computeZone } from '../lib/geometry';

export default function ClueTimeline() {
  const { clues, baseZone, undoLastClue, deleteClue, baseArea } = useStore();

  // Show how much each clue cut, by replaying the pipeline up to and through it.
  function reductionAt(index) {
    const before = areaKm2(computeZone(baseZone, clues.slice(0, index)));
    const after = areaKm2(computeZone(baseZone, clues.slice(0, index + 1)));
    if (!before) return 0;
    return Math.max(0, Math.round((1 - after / before) * 100));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">{clues.length} clue{clues.length !== 1 ? 's' : ''} logged</p>
        <button onClick={undoLastClue} disabled={!clues.length}
          className="rounded-lg bg-slate-700 px-2.5 py-1 text-xs hover:bg-slate-600 disabled:opacity-40">
          ↶ Undo last
        </button>
      </div>

      {clues.length === 0 && <p className="text-xs text-slate-500">No clues yet. Ask the hider a question.</p>}

      <ol className="space-y-1.5">
        {clues.map((c, i) => (
          <li key={c.id} className="flex items-start gap-2 rounded-lg bg-slate-800/50 p-2 ring-1 ring-slate-800">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-500/20 text-[11px] text-cyan-300">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-slate-200">{c.label}</p>
              <p className="text-[11px] text-slate-500">
                {c.mode === 'intersect' ? 'kept inside' : 'cut out'} • −{reductionAt(i)}%
              </p>
            </div>
            <button onClick={() => deleteClue(c.id)}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20">
              Delete
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
