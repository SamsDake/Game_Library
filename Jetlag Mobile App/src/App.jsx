// App.jsx — single-device web app: device gate (admin-locked) + one panel
import { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { useGameStore } from './lib/store.js';
import { HiderPanel } from './components/HiderPanel.jsx';
import { SeekerPanel } from './components/SeekerPanel.jsx';
import { AdminOverlay, AdminLock } from './components/AdminOverlay.jsx';
import { Toasts } from './components/ui.jsx';
import { HomeScreen, LobbyScreen, CountdownScreen, RelocateScreen, FoundScreen, LeaderboardScreen } from './components/screens.jsx';

const DEVICE_KEY = 'jetlag_device_v1';
const TWEAK_DEFAULTS = { countdownMins: 120, maxHand: 6, drawOverride: 0 };
const APP_BASE = import.meta.env.BASE_URL || '/';
let nativePushToken = null;
let nativePushListenersReady = false;
let nativePushRegistering = false;
let nativePushTarget = null;

function appAsset(path) {
  return `${APP_BASE}${path.replace(/^\/+/, '')}`;
}

function apiBaseUrl() {
  return (import.meta.env.VITE_SERVER_URL || '/jetlag-api').replace(/\/+$/, '');
}

function defaultWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/jetlag-ws`;
}

// VAPID public key arrives as a base64url string; the Push API wants raw bytes.
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function setupNativePush(device, serverUrl) {
  nativePushTarget = { device, serverUrl };
  await ensureNativePushListeners();
  if (nativePushToken) await sendNativePushToken(nativePushToken);
  try {
    if (Capacitor.getPlatform() === 'android') {
      await PushNotifications.createChannel({
        id: 'game',
        name: 'Game alerts',
        importance: 5,
        visibility: 1,
        lights: true,
        vibration: true,
      });
    }
    let permissions = await PushNotifications.checkPermissions();
    if (permissions.receive === 'prompt') permissions = await PushNotifications.requestPermissions();
    if (permissions.receive !== 'granted') return;
    if (!nativePushRegistering) {
      nativePushRegistering = true;
      await PushNotifications.register();
    }
  } catch {
    nativePushRegistering = false;
  }
}

async function ensureNativePushListeners() {
  if (nativePushListenersReady) return;
  nativePushListenersReady = true;
  await PushNotifications.addListener('registration', async (token) => {
    nativePushToken = token.value;
    await sendNativePushToken(token.value);
  });
  await PushNotifications.addListener('registrationError', () => {
    nativePushRegistering = false;
  });
}

async function sendNativePushToken(token) {
  if (!nativePushTarget) return;
  await fetch(`${nativePushTarget.serverUrl}/push-subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device: nativePushTarget.device,
      nativeToken: token,
      platform: Capacitor.getPlatform(),
    }),
  });
}

// ── Device gate: admin code → pick Phone A / B ──────────────────
function DeviceSetup({ current, onSelect, onCancel }) {
  const [authed, setAuthed] = useState(false);
  if (!authed) {
    return (
      <div className="device-gate">
        <AdminLock
          title="Device setup"
          sub="Enter the admin code to choose this device's phone."
          onUnlock={() => setAuthed(true)}
          onClose={current ? onCancel : null}
        />
      </div>
    );
  }
  return (
    <div className="device-gate">
      <div className="device-pick">
        <div className="device-pick-kicker">SET UP THIS DEVICE</div>
        <h2 className="device-pick-title">Which phone is this?</h2>
        <p className="device-pick-sub">Your choice is saved on this device. Changing it later needs the admin code.</p>
        <div className="device-pick-grid">
          {['A', 'B'].map(p => (
            <button key={p} className={`device-pick-card${current === p ? ' is-current' : ''}`} onClick={() => onSelect(p)}>
              <span className="device-pick-letter">{p}</span>
              <span className="device-pick-name">Phone {p}</span>
              {current === p && <span className="device-pick-tag">current</span>}
            </button>
          ))}
        </div>
        {current && <button className="admin-text-btn" style={{ marginTop: 18 }} onClick={onCancel}>Keep Phone {current}</button>}
      </div>
    </div>
  );
}

function PhonePanel({ phone, store, openAdmin }) {
  const [view, setView] = useState(null);
  const { state, actions, countdownRemaining, relocateRemaining, hideElapsed, pausedTotal } = store;
  const role = state.roles[phone];
  const common = { phone, role, state, actions, pausedTotal, onAdmin: openAdmin };

  let screen;
  if (state.phase === 'leaderboard') {
    screen = <LeaderboardScreen {...common} onHome={null} />;
  } else if (view === 'leaderboard' && state.phase === 'lobby') {
    screen = <LeaderboardScreen {...common} onHome={() => setView(null)} />;
  } else if (state.phase === 'lobby') {
    screen = role
      ? <LobbyScreen {...common} onHome={() => actions.clearRole(phone)} />
      : <HomeScreen {...common} onLeaderboard={() => setView('leaderboard')} />;
  } else if (state.phase === 'countdown') {
    screen = role
      ? <CountdownScreen {...common} countdownRemaining={countdownRemaining} />
      : <HomeScreen {...common} onLeaderboard={() => setView('leaderboard')} />;
  } else if (state.phase === 'hunt') {
    if (state.relocateEndsAt && relocateRemaining > 0 && role) {
      screen = <RelocateScreen {...common} relocateRemaining={relocateRemaining} />;
    } else if (role === 'hider') {
      screen = <HiderPanel {...common} hideElapsed={hideElapsed} maxHand={TWEAK_DEFAULTS.maxHand} />;
    } else if (role === 'seeker') {
      screen = <SeekerPanel {...common} hideElapsed={hideElapsed} drawOverride={TWEAK_DEFAULTS.drawOverride} />;
    } else {
      screen = <HomeScreen {...common} onLeaderboard={() => setView('leaderboard')} />;
    }
  } else if (state.phase === 'found') {
    screen = <FoundScreen {...common} role={role || 'seeker'} hideElapsed={hideElapsed} />;
  }

  const myToasts = role ? state.notifications.filter(n => n.to === role || n.to === 'both') : [];

  return (
    <div className="phone-app">
      <Toasts items={myToasts} onDismiss={actions.dismissNotification} />
      {screen}
    </div>
  );
}

export default function App() {
  const store = useGameStore({ countdownMins: TWEAK_DEFAULTS.countdownMins });
  const [adminOpen, setAdminOpen] = useState(false);
  const [device, setDevice] = useState(() => localStorage.getItem(DEVICE_KEY) || null);
  const [switching, setSwitching] = useState(false);

  const selectDevice = (p) => { localStorage.setItem(DEVICE_KEY, p); setDevice(p); setSwitching(false); };

  // ── Service worker + push notifications ──────────────────────────────────
  const SERVER_URL = apiBaseUrl();
  const swRegRef = useRef(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(appAsset('sw.js'), { scope: APP_BASE }).then(reg => { swRegRef.current = reg; }).catch(() => { /* service workers are optional */ });
  }, []);

  // Subscribe to Web Push once SW is ready, permission granted, and device is known.
  // Requests permission here so the subscription is created in the same flow as the
  // grant (the deps don't re-fire on a permission change, so we can't wait for it).
  useEffect(() => {
    if (!device) return;
    async function subscribe() {
      try {
        if (Capacitor.isNativePlatform()) {
          await setupNativePush(device, SERVER_URL);
          return;
        }
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        if (Notification.permission === 'default') {
          if (await Notification.requestPermission() !== 'granted') return;
        } else if (Notification.permission !== 'granted') {
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        const sub = existing || await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(
            await fetch(`${SERVER_URL}/vapid-public-key`).then(r => r.json()).then(d => d.publicKey)
          ),
        });
        await fetch(`${SERVER_URL}/push-subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device, subscription: sub }),
        });
      } catch { /* push setup is best-effort */ }
    }
    subscribe();
  }, [device]); // eslint-disable-line react-hooks/exhaustive-deps

  const seenNotif = useRef(new Set());
  useEffect(() => {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return; // requested by the subscribe effect
    const role = device ? store.state.roles[device] : null;
    store.state.notifications.forEach(n => {
      if (seenNotif.current.has(n.uid)) return;
      if (role && n.to !== role && n.to !== 'both') return;
      seenNotif.current.add(n.uid);
      const opts = { body: n.text, icon: appAsset('favicon.svg') };
      if (swRegRef.current) {
        swRegRef.current.showNotification(n.title, opts).catch(() => {});
      } else {
        try { new Notification(n.title, opts); } catch { /* notification fallback may be blocked */ }
      }
    });
  }, [store.state.notifications, store.state.roles, device]);
  // ─────────────────────────────────────────────────────────────────────────

  // ── Backend sync ──────────────────────────────────────────────────────────
  const WS_URL = import.meta.env.VITE_WS_URL || defaultWsUrl();
  const wsRef = useRef(null);
  const remoteApplying = useRef(false);
  const storeActionsRef = useRef(store.actions);
  storeActionsRef.current = store.actions;
  const storeStateRef = useRef(store.state);
  storeStateRef.current = store.state;
  const [syncConnected, setSyncConnected] = useState(false);

  useEffect(() => {
    if (!WS_URL) return;
    let reconnectTimer;
    function connect() {
      const socket = new WebSocket(WS_URL);
      wsRef.current = socket;
      socket.onopen = () => {
        setSyncConnected(true);
        // Ask server for current state; it replies with 'state' or 'empty'
        socket.send(JSON.stringify({ type: 'hello' }));
      };
      socket.onclose = () => {
        setSyncConnected(false);
        wsRef.current = null;
        reconnectTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => { /* close handler reconnects */ };
      socket.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'state') {
            remoteApplying.current = true;
            storeActionsRef.current.syncApply(msg.state);
          } else if (msg.type === 'empty') {
            // First client to connect — push our state to establish the session
            socket.send(JSON.stringify({ type: 'state', state: storeStateRef.current }));
          } else if (msg.type === 'reset') {
            remoteApplying.current = true;
            storeActionsRef.current.reset();
          }
        } catch { /* ignore malformed sync messages */ }
      };
    }
    connect();
    return () => { clearTimeout(reconnectTimer); wsRef.current?.close(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (remoteApplying.current) { remoteApplying.current = false; return; }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'state', state: store.state }));
    }
  }, [store.state]);

  // ── Kick all devices ──────────────────────────────────────────────────────
  // The kick rides the normal state sync (server is a dumb relay), so it works
  // in production without any server-side support. Every client kicks itself
  // when it observes a kickedAt newer than the one present when it loaded.
  const kickAll = () => store.actions.kickAll();
  const kickBaseRef = useRef(store.state.kickedAt || 0);
  useEffect(() => {
    const k = store.state.kickedAt || 0;
    if (k > kickBaseRef.current) {
      kickBaseRef.current = k;
      localStorage.removeItem(DEVICE_KEY);
      setDevice(null);
    }
  }, [store.state.kickedAt]);
  // ─────────────────────────────────────────────────────────────────────────


  if (!device || switching) {
    return <DeviceSetup current={device} onSelect={selectDevice} onCancel={device ? () => setSwitching(false) : undefined} />;
  }

  return (
    <div className="app-single">
      {WS_URL && (
        <div
          title={syncConnected ? 'Sync: connected' : 'Sync: reconnecting…'}
          style={{
            position: 'fixed', top: 10, right: 10, zIndex: 9999,
            width: 8, height: 8, borderRadius: '50%',
            background: syncConnected ? '#22c55e' : '#f97316',
            opacity: 0.85,
          }}
        />
      )}
      <PhonePanel phone={device} store={store} openAdmin={() => setAdminOpen(true)} />
      <AdminOverlay
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        state={store.state}
        actions={store.actions}
        countdownRemaining={store.countdownRemaining}
        hideElapsed={store.hideElapsed}
        relocateRemaining={store.relocateRemaining}
        device={device}
        syncConnected={WS_URL ? syncConnected : null}
        onSwitchDevice={() => { setAdminOpen(false); setSwitching(true); }}
        onKickAll={kickAll}
      />
    </div>
  );
}
