// idbState.js
// Persists game state (selectedIds, seeker, clues) in IndexedDB.
// IndexedDB uses structured clone — GeoJSON is stored as-is, no JSON overhead,
// and the quota is orders of magnitude larger than localStorage (~5MB limit).
// All calls degrade silently to null/no-op if IndexedDB is unavailable.

const DB_NAME = 'jetlag-game-state';
const STORE = 'state';
const DB_VERSION = 1;
const KEY = 'v1';

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error || new Error('IDB open failed'));
  });
}

export async function idbStateGet() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function idbStateSet(data) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(data, KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* fire-and-forget; degrade silently */ }
}
