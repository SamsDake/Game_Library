// idbCache.js
// A tiny promise-based IndexedDB wrapper for persisting Overpass results across
// page refreshes and browser restarts. No external library — the native API is
// verbose but stable in every browser (incl. mobile).
//
// Design notes:
//   - One database ("jetlag-cache"), one object store ("features") keyed by the
//     same string key the in-memory cache uses (feature|bbox|adminLevel).
//   - Stored value is a plain record: { fc, geom, complete, savedAt }. GeoJSON
//     is structured-cloneable, so it persists as-is (no JSON.stringify needed).
//   - SCHEMA_VERSION lets us invalidate everything if the query logic changes
//     (a record written by an older app version is ignored, not trusted).
//   - Every call is wrapped so a browser without IndexedDB (or private-mode
//     quirks, e.g. older iOS Safari) degrades silently to "no persistent cache"
//     rather than throwing — the in-memory cache still works.

const DB_NAME = 'jetlag-cache';
const STORE = 'features';
const DB_VERSION = 1;

// Bump this whenever fetch/query logic changes in a way that invalidates old
// cached geometry (e.g. a filter or element-cap change). Old records are skipped.
export const SCHEMA_VERSION = 2;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  }).catch((e) => { _dbPromise = null; throw e; });
  return _dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

// Returns the stored record for `key`, or null. Records from a different
// SCHEMA_VERSION are treated as a miss (and not trusted).
export async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = tx(db, 'readonly').get(key);
      req.onsuccess = () => {
        const v = req.result;
        if (!v || v.schema !== SCHEMA_VERSION) return resolve(null);
        resolve(v);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

// Persist a record. Caller is responsible for only storing trustworthy data.
export async function idbSet(key, record) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const req = tx(db, 'readwrite').put({ ...record, schema: SCHEMA_VERSION, savedAt: Date.now() }, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch { return false; }
}

// Delete every record whose key starts with `prefix` (used by per-feature
// refresh). With no prefix, clears the whole store.
export async function idbClear(prefix = '') {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const store = tx(db, 'readwrite');
      if (!prefix) {
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        return;
      }
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        if (typeof cur.key === 'string' && cur.key.startsWith(prefix)) cur.delete();
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch { return false; }
}

// Lightweight introspection for a "cached features" UI / debugging.
export async function idbList() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const out = [];
      const req = tx(db, 'readonly').openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out);
        const v = cur.value || {};
        out.push({ key: cur.key, count: v.fc?.features?.length ?? 0, savedAt: v.savedAt });
        cur.continue();
      };
      req.onerror = () => resolve(out);
    });
  } catch { return []; }
}
