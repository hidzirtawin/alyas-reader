/* IndexedDB persistence: library metadata, original files, progress, marks. */

const DB_NAME = 'lumen-reader';
const DB_VERSION = 2;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('This browser does not support local storage for books.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('bookmarks')) {
        const s = db.createObjectStore('bookmarks', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('highlights')) {
        const s = db.createObjectStore('highlights', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('imports')) {
        db.createObjectStore('imports', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Could not open the library database.'));
    req.onblocked = () => reject(new Error('The library database is open in another tab. Close it and try again.'));
  });
  return dbPromise;
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Database transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('Database transaction was aborted.'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

async function getAll(name) {
  return wrap((await store(name)).getAll());
}

async function get(name, key) {
  return wrap((await store(name)).get(key));
}

async function put(name, value) {
  const db = await openDB();
  const tx = db.transaction(name, 'readwrite');
  const result = await wrap(tx.objectStore(name).put(value));
  await done(tx); // wait for the commit so a reload can't lose the write
  return result;
}

async function del(name, key) {
  const db = await openDB();
  const tx = db.transaction(name, 'readwrite');
  const result = await wrap(tx.objectStore(name).delete(key));
  await done(tx);
  return result;
}

async function byIndex(name, index, key) {
  const s = await store(name);
  return wrap(s.index(index).getAll(key));
}

export const db = {
  async addPendingImport(file) {
    const id = (crypto.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await put('imports', {
      id,
      name: file.name,
      size: file.size,
      type: file.type || '',
      blob: file,
      addedAt: Date.now(),
    });
    return id;
  },

  listPendingImports() {
    return getAll('imports').then(list => list.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)));
  },

  deletePendingImport(id) {
    return del('imports', id);
  },

  async listBooks() {
    const books = await getAll('books');
    return books.sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0));
  },

  getBook(id) { return get('books', id); },
  putBook(book) { return put('books', book); },
  updateBook(id, patch) { return db.getBook(id).then(b => b && db.putBook({ ...b, ...patch })); },

  async addFile(bookId, blob, name, type) {
    return put('files', { bookId, blob, name, type, savedAt: Date.now() });
  },

  async addBookWithFile(book, file) {
    const dbi = await openDB();
    const tx = dbi.transaction(['books', 'files'], 'readwrite');
    tx.objectStore('books').put(book);
    tx.objectStore('files').put({
      bookId: book.id, blob: file, name: file.name, type: file.type, savedAt: Date.now(),
    });
    await done(tx);
  },
  getFile(bookId) { return get('files', bookId); },
  getBlob(bookId) { return get('files', bookId).then(r => r?.blob || null); },

  listProgress() { return getAll('progress'); },
  getProgress(bookId) { return get('progress', bookId); },
  putProgress(p) { return put('progress', { ...p, updatedAt: Date.now() }); },

  listBookmarks(bookId) {
    return bookId ? byIndex('bookmarks', 'bookId', bookId) : getAll('bookmarks');
  },
  putBookmark(b) { return put('bookmarks', b); },
  deleteBookmark(id) { return del('bookmarks', id); },

  listHighlights(bookId) {
    return bookId ? byIndex('highlights', 'bookId', bookId) : getAll('highlights');
  },
  putHighlight(h) { return put('highlights', h); },
  deleteHighlight(id) { return del('highlights', id); },

  async deleteBook(id) {
    const dbi = await openDB();
    const tx = dbi.transaction(['books', 'files', 'progress', 'bookmarks', 'highlights'], 'readwrite');
    tx.objectStore('books').delete(id);
    tx.objectStore('files').delete(id);
    tx.objectStore('progress').delete(id);
    for (const name of ['bookmarks', 'highlights']) {
      const idx = tx.objectStore(name).index('bookId');
      const cur = idx.openCursor(IDBKeyRange.only(id));
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { tx.objectStore(name).delete(c.primaryKey); c.continue(); }
      };
    }
    await done(tx);
  },

  async clearAll() {
    const dbi = await openDB();
    const names = ['books', 'files', 'progress', 'bookmarks', 'highlights', 'imports'];
    const tx = dbi.transaction(names, 'readwrite');
    names.forEach(n => tx.objectStore(n).clear());
    await done(tx);
  },

  async counts() {
    const [books, bookmarks, highlights] = await Promise.all([
      getAll('books'), getAll('bookmarks'), getAll('highlights'),
    ]);
    return { books: books.length, bookmarks: bookmarks.length, highlights: highlights.length };
  },

  async estimate() {
    try {
      const est = await navigator.storage?.estimate?.();
      return { used: est?.usage || 0, quota: est?.quota || 0 };
    } catch {
      return { used: 0, quota: 0 };
    }
  },
};
