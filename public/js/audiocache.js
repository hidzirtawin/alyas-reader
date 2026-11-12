/* Device cache for generated narration clips.
   Keeping the last few minutes of speech on disk means reopening a book, a
   reload, or jumping back a sentence does not have to wake the Piper engine
   again. Clips are keyed by voice, speed and text, and the store is trimmed
   oldest-first so it cannot grow without limit. */

const DB_NAME = 'alya-narration';
const STORE = 'clips';
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('usedAt', 'usedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Narration cache unavailable.'));
  }).catch(() => null);
  return dbPromise;
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(STORE, mode); }
    catch (err) { reject(err); return; }
    const store = tx.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (err) { reject(err); return; }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function readAll(db) {
  return new Promise(resolve => {
    let request;
    try { request = db.transaction(STORE).objectStore(STORE).getAll(); }
    catch { resolve([]); return; }
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

export async function getCachedClip(key) {
  const db = await openDb();
  if (!db) return null;
  const record = await new Promise(resolve => {
    let request;
    try { request = db.transaction(STORE).objectStore(STORE).get(key); }
    catch { resolve(null); return; }
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
  if (!record?.blob) return null;
  if (record.usedAt && Date.now() - record.usedAt > MAX_AGE) {
    deleteCachedClip(key).catch(() => {});
    return null;
  }
  try { await run(db, 'readwrite', store => store.put({ ...record, usedAt: Date.now() })); } catch {}
  return record.blob;
}

export async function putCachedClip(key, blob) {
  if (!key || !blob?.size) return;
  if (blob.size > MAX_BYTES / 4) return;
  const db = await openDb();
  if (!db) return;
  try {
    await run(db, 'readwrite', store => store.put({ key, blob, bytes: blob.size, usedAt: Date.now() }));
    await trimToLimit(db);
  } catch {}
}

export async function deleteCachedClip(key) {
  const db = await openDb();
  if (!db) return;
  try { await run(db, 'readwrite', store => store.delete(key)); } catch {}
}

async function trimToLimit(db) {
  const records = await readAll(db);
  const total = records.reduce((sum, record) => sum + (record.bytes || 0), 0);
  if (total <= MAX_BYTES) return;
  records.sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0));
  let excess = total - MAX_BYTES;
  const doomed = [];
  for (const record of records) {
    if (excess <= 0) break;
    doomed.push(record.key);
    excess -= record.bytes || 0;
  }
  if (!doomed.length) return;
  try {
    await run(db, 'readwrite', store => { for (const key of doomed) store.delete(key); });
  } catch {}
}

export async function clearNarrationCache() {
  const db = await openDb();
  if (!db) return;
  try { await run(db, 'readwrite', store => store.clear()); } catch {}
}

export async function narrationCacheStats() {
  const db = await openDb();
  if (!db) return { clips: 0, bytes: 0 };
  const records = await readAll(db);
  return {
    clips: records.length,
    bytes: records.reduce((sum, record) => sum + (record.bytes || 0), 0),
  };
}
