/* Device cache for generated narration clips.
   Keeping recently spoken sentences on disk means reopening a book, a reload,
   or a step back does not have to wake the Piper engine again.

   Clips live in one store and their sizes in a small index beside them, so the
   trim pass never has to pull megabytes of audio into memory. Every read is
   bounded: looking in the cache must never delay the sentence being spoken. */

const DB_NAME = 'alya-narration';
const CLIPS = 'clips';
const META = 'meta';
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const READ_BUDGET_MS = 120;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, 2);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CLIPS)) db.createObjectStore(CLIPS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      // Version 1 kept size and time on the clip itself; that index replaces it.
      if (db.objectStoreNames.contains('clips') && !db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Narration cache unavailable.'));
  }).catch(() => null);
  return dbPromise;
}

function timed(promise, ms = READ_BUDGET_MS) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => done(null), ms);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); done(value); },
      () => { clearTimeout(timer); done(null); },
    );
  });
}

function request(store, method, arg) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = store[method](arg); } catch (err) { reject(err); return; }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getCachedClip(key) {
  const db = await timed(openDb());
  if (!db || !key) return null;
  try {
    const tx = db.transaction([META, CLIPS], 'readonly');
    const meta = await timed(request(tx.objectStore(META), 'get', key));
    if (!meta) return null;
    if (meta.usedAt && Date.now() - meta.usedAt > MAX_AGE) {
      deleteCachedClip(key).catch(() => {});
      return null;
    }
    const record = await timed(request(tx.objectStore(CLIPS), 'get', key));
    if (!record?.blob) return null;
    touch(key).catch(() => {});
    return record.blob;
  } catch {
    return null;
  }
}

async function touch(key) {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    const meta = await request(store, 'get', key);
    if (meta) store.put({ ...meta, usedAt: Date.now() });
    await finished(tx);
  } catch {}
}

export async function putCachedClip(key, blob) {
  if (!key || !blob?.size) return;
  if (blob.size > MAX_BYTES / 4) return;
  const db = await timed(openDb(), 1500);
  if (!db) return;
  try {
    const tx = db.transaction([META, CLIPS], 'readwrite');
    tx.objectStore(CLIPS).put({ key, blob });
    tx.objectStore(META).put({ key, bytes: blob.size, usedAt: Date.now() });
    await finished(tx);
    await trimToLimit(db);
  } catch {}
}

/* Writes are queued and spaced out: a burst of IndexedDB commits while speech
   is playing is what made playback stutter. */
let writeChain = Promise.resolve();
let pendingWrites = 0;

export function queueClipWrite(key, blob) {
  if (!key || !blob?.size || blob.size > 2 * 1024 * 1024) return;
  if (pendingWrites >= 12) return;
  pendingWrites++;
  writeChain = writeChain
    .then(() => putCachedClip(key, blob))
    .then(() => new Promise(resolve => setTimeout(resolve, 250)))
    .catch(() => {})
    .finally(() => { pendingWrites--; });
}

export async function deleteCachedClip(key) {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([META, CLIPS], 'readwrite');
    tx.objectStore(CLIPS).delete(key);
    tx.objectStore(META).delete(key);
    await finished(tx);
  } catch {}
}

/* Trim from the small index only, so no audio is read back into memory. */
async function trimToLimit(db) {
  let entries;
  try {
    const tx = db.transaction(META, 'readonly');
    entries = await timed(request(tx.objectStore(META), 'getAll'), 1500);
  } catch {
    return;
  }
  if (!Array.isArray(entries) || !entries.length) return;
  let total = entries.reduce((sum, meta) => sum + (meta.bytes || 0), 0);
  if (total <= MAX_BYTES) return;
  entries.sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0));
  const doomed = [];
  for (const meta of entries) {
    if (total <= MAX_BYTES) break;
    doomed.push(meta.key);
    total -= meta.bytes || 0;
  }
  if (!doomed.length) return;
  try {
    const tx = db.transaction([META, CLIPS], 'readwrite');
    for (const key of doomed) {
      tx.objectStore(META).delete(key);
      tx.objectStore(CLIPS).delete(key);
    }
    await finished(tx);
  } catch {}
}

export async function clearNarrationCache() {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([META, CLIPS], 'readwrite');
    tx.objectStore(META).clear();
    tx.objectStore(CLIPS).clear();
    await finished(tx);
  } catch {}
}

export async function narrationCacheStats() {
  const db = await openDb();
  if (!db) return { clips: 0, bytes: 0 };
  try {
    const tx = db.transaction(META, 'readonly');
    const entries = await timed(request(tx.objectStore(META), 'getAll'), 1500);
    const list = Array.isArray(entries) ? entries : [];
    return {
      clips: list.length,
      bytes: list.reduce((sum, meta) => sum + (meta.bytes || 0), 0),
    };
  } catch {
    return { clips: 0, bytes: 0 };
  }
}
