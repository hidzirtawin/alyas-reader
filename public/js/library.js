/* Library: hero, book grid, import pipeline, drag & drop. */

import { db } from './db.js';
import { detectFormat, unsupportedMessage, probeFile } from './renderers.js';
import { getPrefs, savePrefs } from './prefs.js';
import { openBookDetails } from './details.js';
import {
  toast, modal, contextMenu, confirmDialog, coverBox, coverHTML, formatLabel,
} from './ui.js';
import {
  $, esc, uid, icon, formatRelative, downloadBlob, clamp,
} from './util.js';

export function renderLibrary(app) {
  const view = $('#view');
  if (!view) return;
  const prefs = getPrefs();
  const query = (app.search || '').trim();
  const all = sortBooks(app.books, prefs.librarySort);
  const collections = [...new Set(all.flatMap(b => b.collections || []))].sort((a, b) => a.localeCompare(b));
  let activeCollection = app.collectionFilter || '';
  if (activeCollection && !collections.includes(activeCollection)) {
    activeCollection = '';
    app.collectionFilter = '';
  }
  const inCollection = activeCollection
    ? all.filter(b => (b.collections || []).includes(activeCollection))
    : all;
  const filtered = query
    ? inCollection.filter(b => `${b.title} ${b.author} ${b.fileName}`.toLowerCase().includes(query.toLowerCase()))
    : inCollection;

  const recent = pickRecent(app);
  const importQueue = importQueueMarkup(app);

  if (!app.books.length) {
    view.innerHTML = `${importQueue}${emptyStateMarkup()}`;
    view.onclick = e => onLibraryClick(app, e);
    refreshImportQueue(app);
    return;
  }

  const hero = recent ? heroMarkup(app, recent) : '';
  const grid = filtered.length
    ? `<div class="book-grid">${filtered.map((b, i) => cardMarkup(app, b, i)).join('')}${query ? '' : addTileMarkup()}</div>`
    : `<div class="no-results">${icon('search')}<h3>${activeCollection ? 'This collection is empty' : 'No books match that search'}</h3><p>${activeCollection ? 'Add books to it from the book menu.' : 'Try a different title, author or file name.'}</p></div>`;
  const collectionBar = collections.length ? `<div class="collection-bar">
    <button class="collection-chip${!activeCollection ? ' is-active' : ''}" data-collection="">All books <span>${all.length}</span></button>
    ${collections.map(c => {
      const count = all.filter(b => (b.collections || []).includes(c)).length;
      return `<button class="collection-chip${activeCollection === c ? ' is-active' : ''}" data-collection="${esc(c)}">${esc(c)} <span>${count}</span></button>`;
    }).join('')}
  </div>` : '';

  view.innerHTML = `
    ${importQueue}
    ${hero}
    ${collectionBar}
    <div class="section-head">
      <h2>${query ? 'Search results' : (activeCollection || 'All books')}</h2>
      <span class="count">${filtered.length}${query ? ` of ${inCollection.length}` : ''}</span>
      <span class="spacer"></span>
      ${query ? '' : `<label class="sort-wrap">
        <select id="librarySort" aria-label="Sort library">
          <option value="recent"${prefs.librarySort === 'recent' ? ' selected' : ''}>Recently read</option>
          <option value="added"${prefs.librarySort === 'added' ? ' selected' : ''}>Recently added</option>
          <option value="title"${prefs.librarySort === 'title' ? ' selected' : ''}>Title A–Z</option>
          <option value="author"${prefs.librarySort === 'author' ? ' selected' : ''}>Author A–Z</option>
        </select>${icon('chevron-down')}
      </label>`}
    </div>
    ${grid}
  `;

  view.onclick = e => onLibraryClick(app, e);
  view.onkeydown = e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const openTarget = e.target.closest('[data-open]');
    if (!openTarget || e.target.closest('[data-menu]') || e.target.closest('button:not([data-open])')) return;
    e.preventDefault();
    const card = openTarget.closest('[data-book-id]');
    const book = app.books.find(b => b.id === card?.dataset.bookId);
    if (book) app.openBook(book.id, targetFromProgress(app.progress.get(book.id), false));
  };
  view.onchange = e => {
    if (e.target.id === 'librarySort') {
      savePrefs({ librarySort: e.target.value }, { silent: true });
      renderLibrary(app);
    }
  };
  refreshImportQueue(app);
}

/* ── Sorting / recent ─────────────────────────────────────────────── */
function sortBooks(books, mode = 'recent') {
  const copy = [...books];
  switch (mode) {
    case 'title': return copy.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
    case 'author': return copy.sort((a, b) => (a.author || '').localeCompare(b.author || '', undefined, { sensitivity: 'base' }) || (a.title || '').localeCompare(b.title || ''));
    case 'added': return copy.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    default: return copy.sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0));
  }
}

function pickRecent(app) {
  const withProgress = app.books
    .map(book => ({ book, progress: app.progress.get(book.id) }))
    .filter(x => x.progress)
    .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0));
  if (withProgress.length) return withProgress[0];
  const newest = [...app.books].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))[0];
  return newest ? { book: newest, progress: null } : null;
}

/* ── Markup ───────────────────────────────────────────────────────── */
function heroMarkup(app, { book, progress }) {
  const percent = clamp(Math.round(progress?.percent || 0), 0, 100);
  const started = !!progress && percent > 0;
  const narration = getPrefs().tts.enabled && !['cbz', 'cbr'].includes(book.format);
  const wash = book.cover ? ` style="background-image:url('${esc(book.cover)}')"` : '';
  return `
    <section class="hero" aria-label="Continue reading">
      ${book.cover ? `<div class="hero-wash"${wash}></div>` : ''}
      <div class="hero-cover">${coverBox(book)}</div>
      <div class="hero-body">
        <div class="hero-kicker">${icon(started ? 'clock' : 'book')} ${started ? 'Continue reading' : 'From your library'}</div>
        <h2 class="hero-title">${esc(book.title || 'Untitled')}</h2>
        <p class="hero-author">${esc(book.author || 'Unknown author')}</p>
        ${started ? `<div class="hero-meter"><div class="bar"><i style="width:${percent}%"></i></div><span>${percent}% read</span></div>` : ''}
        <div class="hero-actions">
          <button class="btn btn-primary" data-hero-open>${icon('play')} ${started ? 'Continue reading' : 'Start reading'}</button>
          ${narration ? `<button class="btn" data-hero-listen>${icon('loudhailer')} Listen</button>` : ''}
        </div>
      </div>
      <div class="hero-meta">
        <span>${formatLabel(book.format)}</span>
        <span>${formatRelative(progress?.updatedAt || book.addedAt)}</span>
      </div>
    </section>`;
}

function cardMarkup(app, book, i) {
  const progress = app.progress.get(book.id);
  const percent = progress ? clamp(progress.percent || 0, 0, 100) : 0;
  const finished = percent >= 99.5;
  const sub = `${formatLabel(book.format)} <span class="dot"></span> ${finished ? 'Finished' : percent > 0 ? `${Math.round(percent)}%` : 'New'}`;
  return `
    <article class="book-card" data-book-id="${esc(book.id)}" style="animation-delay:${Math.min(i * 24, 360)}ms">
      <div class="book-cover" data-open tabindex="0" role="button" aria-label="Read ${esc(book.title || 'this book')}" title="Read ${esc(book.title || '')}">
        ${coverHTML(book)}
        <span class="book-badge">${formatLabel(book.format)}</span>
        ${percent > 0 ? `<span class="book-progress"><i style="width:${percent}%"></i></span>` : ''}
        <button class="card-menu-btn" data-menu aria-label="Book options">${icon('more')}</button>
      </div>
      <div class="book-info" data-open>
        <div class="book-title">${esc(book.title || 'Untitled')}</div>
        <div class="book-author">${esc(book.author || 'Unknown author')}</div>
        <div class="book-sub">${sub}</div>
      </div>
    </article>`;
}

function addTileMarkup() {
  return `
    <article class="book-card add-tile">
      <button class="book-cover" data-add aria-label="Add a book">
        <span class="add-tile-inner">
          <span class="plus-ring">${icon('plus')}</span>
          <strong>Add a book</strong>
          <small>EPUB · PDF · DOCX<br>HTML · RTF · ODT · FB2</small>
        </span>
      </button>
      <div class="book-info">
        <div class="book-title" style="color:var(--ink-3);font-weight:500">Your own files</div>
        <div class="book-author">Everything stays on this device</div>
      </div>
    </article>`;
}

function emptyStateMarkup() {
  return `
    <section class="empty-hero">
      <div class="empty-copy">
        <div class="eyebrow">A quiet place to read</div>
        <p>Drop in an EPUB, PDF, Word document, ODT, RTF, HTML, FB2, comic archive or plain text file. Settle into a typeface you love — or let a natural voice read it aloud while you listen.</p>
        <div class="empty-actions">
          <button class="btn btn-primary" data-add>${icon('plus')} Add your first book</button>
          <button class="btn" data-free-books>${icon('book')} Free books</button>
          <button class="btn" data-demo-shortcuts>${icon('keyboard')} Shortcuts</button>
        </div>
        <div class="empty-formats">
          ${['EPUB', 'PDF', 'DOCX', 'TXT', 'CBZ', 'CBR'].map(f => `<span class="format-pill">${icon('file')}${f}</span>`).join('')}
        </div>
      </div>
      <div class="empty-art" aria-hidden="true">
        <div class="halo"></div>
        <div class="halo"></div>
        <div class="art-book">
          <div class="art-kicker">Alya’s Reader</div>
          <div>
            <div class="art-title">Your next<br>book.</div>
            <div class="art-author">Ready when you are</div>
          </div>
        </div>
        <div class="art-wave"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>
    </section>
    <div class="feature-strip">
      <div class="feature"><div class="fi">${icon('loudhailer')}</div><div><strong>Natural narration</strong><p>Free Piper neural voices read with you — offline, with American, British, Scottish and Australian accents.</p></div></div>
      <div class="feature"><div class="fi">${icon('shield')}</div><div><strong>Everything stays local</strong><p>Your files, progress, bookmarks and notes live in this browser. Nothing is uploaded.</p></div></div>
      <div class="feature"><div class="fi">${icon('type')}</div><div><strong>Made for long reads</strong><p>Thirteen typefaces, a dyslexia-friendly mode, four themes, and comfortable control over size and spacing.</p></div></div>
    </div>`;
}

/* ── Events ───────────────────────────────────────────────────────── */
function onLibraryClick(app, e) {
  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) {
    e.preventDefault();
    e.stopPropagation();
    const card = menuBtn.closest('[data-book-id]');
    const book = app.books.find(b => b.id === card?.dataset.bookId);
    if (book) openCardMenu(app, book, menuBtn);
    return;
  }
  if (e.target.closest('[data-add]')) {
    $('#fileInput')?.click();
    return;
  }
  if (e.target.closest('[data-free-books]')) {
    app.openBookSources?.();
    return;
  }
  const collectionChip = e.target.closest('[data-collection]');
  if (collectionChip) {
    app.collectionFilter = collectionChip.dataset.collection || '';
    renderLibrary(app);
    return;
  }
  if (e.target.closest('[data-demo-shortcuts]')) {
    app.showShortcuts?.();
    return;
  }
  if (e.target.closest('[data-hero-open]') || e.target.closest('[data-hero-listen]')) {
    const recent = pickRecent(app);
    if (!recent) return;
    const listen = !!e.target.closest('[data-hero-listen]');
    app.openBook(recent.book.id, targetFromProgress(recent.progress, listen));
    return;
  }
  const openTarget = e.target.closest('[data-open]');
  if (openTarget) {
    const card = openTarget.closest('[data-book-id]');
    const book = app.books.find(b => b.id === card?.dataset.bookId);
    if (book) app.openBook(book.id, targetFromProgress(app.progress.get(book.id), false));
  }
}

function targetFromProgress(progress, autoplay) {
  const meaningful = progress && ((progress.percent || 0) > 0.5 || (progress.chapterIndex || 0) > 0 || (progress.page || 1) > 1);
  if (!meaningful) return autoplay ? { autoplay: true } : undefined;
  return {
    chapterIndex: progress.chapterIndex,
    ratio: progress.ratio,
    page: progress.page,
    autoplay,
  };
}

function openCardMenu(app, book, anchor) {
  const rect = anchor.getBoundingClientRect();
  const narration = getPrefs().tts.enabled && !['cbz', 'cbr'].includes(book.format);
  const progress = app.progress.get(book.id);
  const items = [
    { label: progress ? 'Continue reading' : 'Read', icon: 'book', onSelect: () => app.openBook(book.id, targetFromProgress(progress, false)) },
    ...(narration ? [{ label: 'Listen from here', icon: 'loudhailer', onSelect: () => app.openBook(book.id, targetFromProgress(progress, true)) }] : []),
    { sep: true },
    { label: 'Book details', icon: 'info', onSelect: () => openBookDetails(app, book) },
    { label: 'Collections…', icon: 'folder', onSelect: () => openCollections(app, book) },
    {
      label: 'Download original', icon: 'download', onSelect: async () => {
        try {
          const blob = await db.getBlob(book.id);
          if (!blob) throw new Error('The original file is missing.');
          downloadBlob(blob, book.fileName || `${book.title}.${book.format}`);
        } catch (err) { toast(err.message, 'err'); }
      },
    },
    { sep: true },
    {
      label: 'Remove from library', icon: 'trash', danger: true, onSelect: async () => {
        const ok = await confirmDialog({
          title: 'Remove this book?',
          message: 'The file, reading position, bookmarks and highlights will be deleted from this device.',
          confirmLabel: 'Remove book',
        });
        if (!ok) return;
        await db.deleteBook(book.id);
        app.bookmarks = app.bookmarks.filter(b => b.bookId !== book.id);
        app.highlights = app.highlights.filter(h => h.bookId !== book.id);
        app.progress.delete(book.id);
        await app.reload();
        toast('Book removed', 'ok');
      },
    },
  ];
  contextMenu(rect.right - 8, rect.bottom + 6, items);
}

function openCollections(app, book) {
  const all = [...new Set(app.books.flatMap(b => b.collections || []))].sort((a, b) => a.localeCompare(b));
  const current = new Set(book.collections || []);
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="hint" style="margin-bottom:10px">Choose collections for “${esc(book.title)}”.</p>
    ${all.length ? `<div class="collection-picker">${all.map(name => `
      <label class="collection-check">
        <input type="checkbox" value="${esc(name)}"${current.has(name) ? ' checked' : ''}>
        <span>${esc(name)}</span>
      </label>`).join('')}</div>` : '<div class="voice-none">No collections yet.</div>'}
    <div class="field" style="margin-top:14px">
      <label for="newCollection">New collection</label>
      <input class="input" id="newCollection" placeholder="e.g. Bedtime reading" autocomplete="off">
    </div>`;
  const foot = document.createElement('div');
  foot.innerHTML = '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save collections</button>';
  const m = modal({ eyebrow: 'Library', title: 'Collections', body, foot });
  foot.querySelector('[data-cancel]').onclick = () => m.close('cancel');
  foot.querySelector('[data-save]').onclick = async () => {
    const chosen = new Set([...body.querySelectorAll('input[type="checkbox"]:checked')].map(i => i.value));
    const fresh = body.querySelector('#newCollection')?.value.trim();
    if (fresh) chosen.add(fresh);
    const collections = [...chosen].sort((a, b) => a.localeCompare(b));
    await db.updateBook(book.id, { collections });
    book.collections = collections;
    m.close('save');
    renderLibrary(app);
    toast(collections.length ? 'Collections updated' : 'Removed from all collections', 'ok');
  };
}

/* ── Import ───────────────────────────────────────────────────────── */
export function importQueueMarkup(app) {
  if (!app.imports?.length) return '';
  return `<div class="import-queue" id="importQueue">${app.imports.map(importRowMarkup).join('')}</div>`;
}

function importRowMarkup(job) {
  const iconMarkup = job.status === 'working'
    ? '<span class="spin"></span>'
    : job.status === 'done'
      ? `<span class="ok">${icon('check')}</span>`
      : job.status === 'error'
        ? `<span class="err">${icon('info')}</span>`
        : `<span class="dim">${icon('file')}</span>`;
  return `<div class="import-row" data-import="${job.id}">
    ${iconMarkup}
    <span class="name">${esc(job.file.name)}</span>
    <span class="${job.status === 'error' ? 'err' : 'muted'}" style="font-size:11px">${esc(job.message || '')}</span>
  </div>`;
}

export function refreshImportQueue(app) {
  const el = document.getElementById('importQueue');
  if (!el) return;
  if (!app.imports?.length) { el.remove(); return; }
  el.innerHTML = app.imports.map(importRowMarkup).join('');
}

export async function importFiles(app, fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;

  if (app.view !== 'library') app.go('library');

  const jobs = files.map(file => ({
    id: uid(),
    file,
    status: 'pending',
    message: 'Waiting…',
  }));
  app.imports = [...(app.imports || []), ...jobs];
  refreshImportQueue(app);
  if (!document.getElementById('importQueue')) {
    // view was empty / not rendered yet
    app.renderCurrent?.();
  }

  const known = new Set(app.books.map(b => `${b.fileName}|${b.size}`));
  let added = 0;
  let failed = 0;

  for (const job of jobs) {
    const file = job.file;
    try {
      if (file.size > 400 * 1024 * 1024) throw new Error('File is larger than 400 MB.');
      if (!detectFormat(file)) throw new Error(unsupportedMessage(file));
      if (known.has(`${file.name}|${file.size}`)) {
        job.status = 'done';
        job.message = 'Already in library';
        refreshImportQueue(app);
        continue;
      }
      job.status = 'working';
      job.message = 'Preparing…';
      refreshImportQueue(app);

      const probe = await probeFile(file);
      job.message = 'Saving…';
      refreshImportQueue(app);

      const record = {
        id: uid(),
        title: probe.title,
        author: probe.author,
        cover: probe.cover,
        description: probe.description,
        language: probe.language,
        format: probe.format,
        fileName: file.name,
        size: file.size,
        mime: file.type || '',
        addedAt: Date.now(),
        lastOpenedAt: null,
        meta: probe.meta || {},
      };
      // Metadata and file commit together, so a failed write can't leave a ghost book.
      await db.addBookWithFile(record, file);
      known.add(`${file.name}|${file.size}`);
      added++;
      job.status = 'done';
      job.message = 'Added to library';
      refreshImportQueue(app);
    } catch (err) {
      console.error('Import failed', file?.name, err);
      failed++;
      job.status = 'error';
      job.message = friendlyError(err);
      refreshImportQueue(app);
    }
  }

  if (added) {
    // Ask the browser to keep this origin's storage instead of evicting it.
    navigator.storage?.persist?.().catch?.(() => {});
    await app.reload({ render: false });
    app.renderCurrent?.();
    toast(added === 1 ? 'Book added to your library' : `${added} books added`, 'ok');
  }
  if (failed && !added) toast('That file could not be imported', 'err');

  const settled = new Set(jobs);
  setTimeout(() => {
    app.imports = (app.imports || []).filter(j => !settled.has(j));
    refreshImportQueue(app);
  }, 4500);
}

function friendlyError(err) {
  const msg = String(err?.message || err || 'Unknown error');
  if (/quota|storage|space/i.test(msg)) return 'Not enough browser storage for this file.';
  if (/database|indexeddb/i.test(msg)) return 'Browser storage is unavailable.';
  return msg.length > 90 ? msg.slice(0, 87) + '…' : msg;
}
