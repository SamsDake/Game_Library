// sync.js
// WebSocket sync — keeps two phones in lock-step by broadcasting the full
// game state to a shared room on the VPS. The connection is optional: if
// VITE_SYNC_URL is not set, or the server is unreachable, everything works
// offline and reconnects silently when the server comes back.

function defaultSyncUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/deduction-sync`;
}

function configuredSyncUrl() {
  const configured = import.meta.env.VITE_SYNC_URL;
  if (configured === 'off') return '';
  return (configured || defaultSyncUrl()).replace(/\/+$/, '');
}

const WS_URL = configuredSyncUrl();

let _ws = null;
let _roomId = null;
let _onRemote = null;    // (data: {selectedIds, seeker, clues}) => void
let _onStatus = null;    // ('connecting' | 'connected' | 'disconnected') => void
let _retryTimer = null;
let _lastState = null;
let _readyToPush = false;

function setStatus(s) {
  _onStatus?.(s);
}

function connect() {
  if (!WS_URL || !_roomId) return;
  if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) return; // already open/connecting

  setStatus('connecting');
  _readyToPush = false;
  _ws = new WebSocket(`${WS_URL}/room/${_roomId}`);

  _ws.onopen = () => {
    clearTimeout(_retryTimer);
    setStatus('connected');
  };

  _ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        _readyToPush = true;
        // Remote applies suppress pushState, so record the applied state here —
        // otherwise a later 'empty' (server lost the room) would re-seed the
        // room from a pre-remote snapshot.
        _lastState = msg.data;
        if (_onRemote) _onRemote(msg.data);
      } else if (msg.type === 'empty') {
        _readyToPush = true;
        if (_lastState) pushState(_lastState);
      }
    } catch { /* malformed message, ignore */ }
  };

  _ws.onclose = () => {
    setStatus('disconnected');
    _retryTimer = setTimeout(connect, 3000);
  };

  _ws.onerror = () => _ws.close();
}

// Call once from App on mount with the room ID and callbacks.
export function initSync(roomId, onRemote, onStatus) {
  _roomId = roomId;
  _onRemote = onRemote;
  _onStatus = onStatus;
  connect();
}

// Tear down the socket and stop reconnecting (App effect cleanup).
export function disconnect() {
  clearTimeout(_retryTimer);
  if (_ws) {
    _ws.onclose = null; // closing ourselves must not schedule a reconnect
    _ws.close();
    _ws = null;
  }
  _onRemote = null;
  _onStatus = null;
  _readyToPush = false;
}

// Called by store.persist after every local state change.
export function pushState(data) {
  _lastState = data;
  if (_readyToPush && _ws?.readyState === 1 /* OPEN */) {
    _ws.send(JSON.stringify({ type: 'state', data }));
  }
}

// Returns whether VITE_SYNC_URL is configured at all.
export function syncEnabled() {
  return !!WS_URL;
}
