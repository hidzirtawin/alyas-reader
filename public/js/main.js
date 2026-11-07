/* Alya’s Reader — application shell. */

import { db } from './db.js';
import { applyPrefs } from './prefs.js';
import { renderLibrary, importFiles, refreshImportQueue } from './library.js';
import { renderMarks } from './bookmarks.js';
import { renderSettings } from './settings.js';
import { openReader, closeReader } from './reader.js';
import { shortcutsModal, toast } from './ui.js';
import { $, $$, clamp, formatBytes, debounce, icon } from './util.js';

const app = {
  view: 'library',
  books: [],
  progress: new Map(),
  bookmarks: [],
  highlights: [],
  imports: [],
  counts: { books: 0, bookmarks: 0, highlights: 0 },
  storage: { used: 0, quota: 0 },
  search: '',
  marksTab: 'bookmarks',
  pauseTTS: null,

  async reload({ render = true } = {}) {
    const [books, progress, bookmarks, highlights] = await Promise.all([
      db.listBooks(),
      db.listProgress(),
      db.listBookmarks(),
      db.listHighlights(),
    ]);
    app.books = books;
    app.progress = new Map(progress.map(p => [p.bookId, p]));
    app.bookmarks = bookmarks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    app.highlights = highlights.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    app.counts = { books: books.length, bookmarks: bookmarks.length, highlights: highlights.length };
    app.storage = await db.estimate();
    app.refreshRail();
    if (render) app.renderCurrent();
    return app;
  },

  renderCurrent() {
    try {
      if (app.view === 'bookmarks') renderMarks(app);
      else if (app.view === 'settings') renderSettings(app);
      else renderLibrary(app);
    } catch (err) {
      console.error('View render failed', err);
      toast('Something went wrong while drawing this view.', 'err');
    }
  },

  go(view) {
    if (!['library', 'bookmarks', 'settings'].includes(view)) return;
    if (view !== 'library') {
      app.search = '';
      const s = $('#librarySearch');
      if (s) s.value = '';
    }
    app.view = view;
    const meta = {
      library: ['Library', 'Everything you’re reading, in one quiet place.'],
      bookmarks: ['Marks & notes', 'Bookmarks, highlights and thoughts — kept locally.'],
      settings: ['Settings', 'Make Alya’s Reader yours.'],
    }[view];
    $('#viewTitle').textContent = meta[0];
    $('#viewSubtitle').textContent = meta[1];
    $('#searchWrap').hidden = view !== 'library';
    $$('.rail-link').forEach(btn => {
      const active = btn.dataset.view === view;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    });
    document.title = `Alya’s Reader — ${meta[0]}`;
    app.renderCurrent();
    closeRail();
    $('#view')?.focus?.({ preventScroll: true });
  },

  refreshRail() {
    const bookCount = $('#railBookCount');
    const markCount = $('#railMarkCount');
    if (bookCount) bookCount.textContent = app.books.length ? String(app.books.length) : '';
    if (markCount) markCount.textContent = (app.bookmarks.length + app.highlights.length) || '';

    const storageLabel = $('#storageLabel');
    const storageFill = $('#storageFill');
    if (storageLabel) storageLabel.textContent = formatBytes(app.storage.used);
    if (storageFill) {
      const pct = app.storage.quota ? clamp((app.storage.used / app.storage.quota) * 100, app.storage.used ? 3 : 0, 100) : 0;
      storageFill.style.width = `${pct}%`;
    }
    const railAdd = $('#railAdd');
    if (railAdd) railAdd.style.display = '';
    refreshImportQueue(app);
  },

  openBook(id, target) { return openReader(app, id, target); },
  closeReader(opts) { return closeReader(opts); },
  showShortcuts: shortcutsModal,
  pickFiles() { $('#fileInput')?.click(); },
};

window.lumen = app;

/* ── Rail / navigation ───────────────────────────────────────────── */
const rail = $('#rail');
const railScrim = document.createElement('div');
railScrim.className = 'rail-scrim';
document.body.appendChild(railScrim);

function openRail() {
  rail.classList.add('open');
  railScrim.classList.add('open');
}
function closeRail() {
  rail.classList.remove('open');
  railScrim.classList.remove('open');
}
railScrim.addEventListener('click', closeRail);
$('#navToggle').addEventListener('click', openRail);
$('.brand')?.addEventListener('click', () => app.go('library'));

$$('[data-view]').forEach(btn => btn.addEventListener('click', () => app.go(btn.dataset.view)));

window.addEventListener('resize', () => {
  if (window.innerWidth > 900) closeRail();
});

/* ── Add books ───────────────────────────────────────────────────── */
$('#addBookBtn').addEventListener('click', () => app.pickFiles());
$('#railAdd').addEventListener('click', () => app.pickFiles());
$('#fileInput').addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) importFiles(app, files);
});

/* ── Search ──────────────────────────────────────────────────────── */
const searchInput = $('#librarySearch');
const applySearch = debounce(() => {
  app.search = searchInput.value;
  if (app.view === 'library') renderLibrary(app);
}, 70);
searchInput.addEventListener('input', applySearch);
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    app.search = '';
    renderLibrary(app);
    searchInput.blur();
  }
});

/* ── Drag & drop ─────────────────────────────────────────────────── */
let dragDepth = 0;
const veil = $('#dropVeil');

function hasFiles(e) {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}
window.addEventListener('dragenter', e => {
  if (!hasFiles(e) || document.body.classList.contains('reader-open')) return;
  e.preventDefault();
  dragDepth++;
  veil.classList.add('is-visible');
});
window.addEventListener('dragover', e => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) veil.classList.remove('is-visible');
});
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  veil.classList.remove('is-visible');
  if (document.body.classList.contains('reader-open')) {
    toast('Close the reader to add a book.', 'info');
    return;
  }
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) importFiles(app, files);
});

/* ── Global shortcuts ────────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  if (document.body.classList.contains('reader-open')) return;
  if (e.key === 'Escape') { closeRail(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    app.pickFiles();
    return;
  }
  if (e.key === '/' && !isEditable(e.target) && app.view === 'library') {
    e.preventDefault();
    searchInput.focus();
  }
});

function isEditable(node) {
  return node && ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName);
}

/* ── Voices availability ─────────────────────────────────────────── */
if ('speechSynthesis' in window) {
  try { speechSynthesis.getVoices(); } catch {}
  try {
    speechSynthesis.addEventListener?.('voiceschanged', () => window.dispatchEvent(new CustomEvent('lumen:voices')));
  } catch {}
}

/* ── Boot ────────────────────────────────────────────────────────── */
async function boot() {
  applyPrefs();
  app.refreshRail();
  $('#view').innerHTML = `<div class="pdf-loading" style="min-height:44vh;color:var(--ink-3)">
    <div class="spinner" style="border-color:var(--line);border-top-color:var(--accent)"></div>
    <div>Opening your library…</div>
  </div>`;

  try {
    await app.reload({ render: false });
    app.go('library');
    navigator.storage?.persist?.().catch?.(() => {});
  } catch (err) {
    console.error(err);
    $('#view').innerHTML = `<div class="empty-list" style="margin-top:40px">
      <div class="eico" style="width:52px;height:52px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;background:var(--surface-2)">${icon('info')}</div>
      <h3>Your library couldn’t be opened</h3>
      <p>${err.message || 'Browser storage is unavailable.'} Try closing other tabs of Alya’s Reader, or a different browser.</p>
    </div>`;
    toast('Could not open the local library.', 'err');
  }
}

boot();

/* Let the reader/tools reach the shell helpers. */
app.closeRail = closeRail;
