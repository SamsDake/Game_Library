// App.jsx
import { useEffect, useState } from 'react';
import { useStore } from './lib/store';
import { loadCountries } from './lib/countries';
import MapView from './components/MapView';
import CountrySelect from './components/CountrySelect';
import QuestionPanel from './components/QuestionPanel';
import ClueTimeline from './components/ClueTimeline';
import { initSync, syncEnabled } from './lib/sync';

// Read room ID from URL hash (#room=XXXX). If absent, generate one and write
// it into the hash so it can be shared with the second phone via copy-paste.
function getRoomId() {
  const m = window.location.hash.match(/[#&]room=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  window.location.hash = `room=${id}`;
  return id;
}

const TABS = ['Countries', 'Ask', 'Clues'];

export default function App() {
  const { setCountries, resetAll, baseArea, currentArea, applyRemoteState } = useStore();
  const [tab, setTab] = useState('Countries');
  const [open, setOpen] = useState(true); // sidebar on mobile
  const [isDesktop, setIsDesktop] = useState(
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true
  );
  const [syncStatus, setSyncStatus] = useState('disconnected');
  const [roomId] = useState(getRoomId);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    loadCountries()
      .then(setCountries)
      .catch((e) => console.error(e));
  }, [setCountries]);

  useEffect(() => {
    if (syncEnabled()) {
      initSync(roomId, applyRemoteState, setSyncStatus);
    }
  }, [roomId, applyRemoteState]);

  const pct = baseArea ? Math.round((currentArea / baseArea) * 100) : 0;

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100 md:flex-row">
      {/* Mobile top bar */}
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2 md:hidden">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-cyan-300">Hide &amp; Seek Board</h1>
          {syncEnabled() && <SyncDot status={syncStatus} roomId={roomId} />}
        </div>
        <button onClick={() => setOpen((o) => !o)} className="rounded-lg bg-slate-800 px-3 py-1 text-sm">
          {open ? 'Map' : 'Panel'}
        </button>
      </header>

      {/* Sidebar */}
      <aside
        className={`${open ? 'flex' : 'hidden'} h-full w-full flex-col border-r border-slate-800 bg-slate-900/70 backdrop-blur md:flex md:w-[360px]`}
      >
        <div className="hidden items-center gap-2 px-4 pt-4 md:flex">
          <div className="h-2.5 w-2.5 rounded-full bg-cyan-400" />
          <h1 className="text-base font-semibold tracking-tight">Hide &amp; Seek Deduction Board</h1>
          {syncEnabled() && <SyncDot status={syncStatus} roomId={roomId} />}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2 px-4 pt-3">
          <Stat label="Zone area" value={`${Math.round(currentArea).toLocaleString()} km²`} />
          <Stat label="Of original" value={`${pct}%`} accent />
        </div>

        {/* Tabs */}
        <nav className="flex gap-1 px-4 pt-3">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                tab === t ? 'bg-cyan-500 text-slate-900' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'Countries' && <CountrySelect />}
          {tab === 'Ask' && <QuestionPanel />}
          {tab === 'Clues' && <ClueTimeline />}
        </div>

        <div className="border-t border-slate-800 p-3">
          <button
            onClick={() => { if (confirm('Reset everything — countries, seeker, and all clues?')) resetAll(); }}
            className="w-full rounded-lg bg-rose-500/90 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500"
          >
            Reset map
          </button>
        </div>
      </aside>

      {/* Map */}
      <main className={`${open ? 'hidden' : 'block'} min-h-0 flex-1 md:block`}>
        <MapView visible={isDesktop || !open} />
      </main>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl bg-slate-800/60 px-3 py-2 ring-1 ring-slate-800">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-lg font-semibold ${accent ? 'text-cyan-300' : 'text-slate-100'}`}>{value}</p>
    </div>
  );
}

const DOT_COLOR = {
  connected:    'bg-green-400',
  connecting:   'bg-yellow-400 animate-pulse',
  disconnected: 'bg-slate-600',
};

function SyncDot({ status, roomId }) {
  const label = status === 'connected'
    ? `Synced — room ${roomId}`
    : status === 'connecting'
    ? 'Connecting…'
    : `Offline — room ${roomId}`;
  return (
    <span title={label} className="flex items-center gap-1.5 cursor-default select-none">
      <span className={`h-2 w-2 rounded-full ${DOT_COLOR[status] ?? DOT_COLOR.disconnected}`} />
      <span className="text-[11px] text-slate-400 hidden sm:inline">{roomId}</span>
    </span>
  );
}
