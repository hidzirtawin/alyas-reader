/* Library: hero, book grid, import pipeline, drag & drop. */

import { db } from './db.js';
import { detectFormat, unsupportedMessage, probeFile } from './renderers.js';
import { getPrefs, savePrefs } from './prefs.js';
import { openBookDetails } from './details.js';
import { downloadBookAudio } from './audioexport.js?v=voicecache1';
import {
  toast, modal, contextMenu, confirmDialog, coverBox, coverHTML, formatLabel,
} from './ui.js';
import {
  $, esc, uid, icon, formatRelative, clamp,
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
      <button class="btn btn-sm" data-voice-generator>${icon('sparkles')} Voice-Generator</button>
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
    <section class="hero" aria-label="Audiobook actions">
      ${book.cover ? `<div class="hero-wash"${wash}></div>` : ''}
      <div class="hero-cover">${coverBox(book)}</div>
      <div class="hero-body">
        <div class="hero-kicker">${icon(started ? 'clock' : 'loudhailer')} ${started ? 'Continue listening' : 'Ready to make audio'}</div>
        <h2 class="hero-title">${esc(book.title || 'Untitled')}</h2>
        <p class="hero-author">${esc(book.author || 'Unknown author')}</p>
        ${started ? `<div class="hero-meter"><div class="bar"><i style="width:${percent}%"></i></div><span>${percent}% complete</span></div>` : ''}
        <div class="hero-actions">
          ${!['cbz', 'cbr'].includes(book.format) ? `<button class="btn btn-primary" data-hero-audio>${icon('download')} Download MP3</button>` : ''}
          ${narration ? `<button class="btn" data-hero-listen>${icon('loudhailer')} Listen</button>` : ''}
          <button class="btn btn-quiet" data-hero-open>${icon('book')} ${started ? 'Continue reading' : 'Read'}</button>
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
      <button class="book-cover" data-add aria-label="Add files to make an audiobook">
        <span class="add-tile-inner">
          <span class="plus-ring">${icon('plus')}</span>
          <strong>Add files</strong>
          <small>EPUB · PDF · DOCX<br>HTML · RTF · ODT · FB2</small>
        </span>
      </button>
      <div class="book-info">
        <div class="book-title" style="color:var(--ink-3);font-weight:500">Make an audiobook</div>
        <div class="book-author">Upload files · export one MP3</div>
      </div>
    </article>`;
}

function emptyStateMarkup() {
  return `
    <section class="empty-hero">
      <div class="empty-copy">
        <div class="eyebrow">Private audiobook studio</div>
        <p>Turn your own EPUB, PDF, Word, ODT, RTF, HTML, FB2, Markdown or text files into a single MP3 audiobook. Fast voices run on this device by default. You can also open Voice-Generator here as an optional outside tool.</p>
        <div class="empty-actions">
          <button class="btn btn-primary" data-add>${icon('download')} Add files to make an MP3</button>
          <button class="btn" data-voice-generator>${icon('sparkles')} Use Voice-Generator</button>
          <button class="btn" data-free-books>${icon('book')} Free books</button>
          <button class="btn btn-quiet" data-demo-shortcuts>${icon('keyboard')} Shortcuts</button>
        </div>
        <div class="empty-formats">
          ${['EPUB', 'PDF', 'DOCX', 'ODT', 'RTF', 'HTML', 'FB2', 'TXT', 'MD'].map(f => `<span class="format-pill">${icon('file')}${f}</span>`).join('')}
        </div>
      </div>
      <div class="empty-art" aria-hidden="true">
        <div class="halo"></div>
        <div class="halo"></div>
        <div class="art-book">
          <div class="art-kicker">Alya’s Reader</div>
          <div>
            <div class="art-title">Your next<br>audiobook.</div>
            <div class="art-author">Made on this device</div>
          </div>
        </div>
        <div class="art-wave"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>
    </section>
    <div class="feature-strip">
      <div class="feature"><div class="fi">${icon('download')}</div><div><strong>One whole-book MP3</strong><p>Download a single audiobook file, or make a chapter ZIP with a playlist.</p></div></div>
      <div class="feature"><div class="fi">${icon('volume')}</div><div><strong>Fast local voices</strong><p>26 low-latency Piper voices create audio offline. Progress survives a reload.</p></div></div>
      <div class="feature"><div class="fi">${icon('shield')}</div><div><strong>Private by default</strong><p>Local Piper stays on-device; Voice-Generator is optional and clearly labeled.</p></div></div>
    </div>`;
}

/* ── Events ───────────────────────────────────────────────────────── */
function onLibraryClick(app, e) {
  if (e.target.closest('[data-voice-generator]')) {
    openVoiceGenerator();
    return;
  }
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
  if (e.target.closest('[data-hero-audio]')) {
    const recent = pickRecent(app);
    if (recent) downloadBookAudio(recent.book);
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

function openVoiceGenerator() {
  const url = 'https://voice-generator.com/epub-to-audio';
  const consent = modal({
    eyebrow: 'Third-party audiobook tool',
    title: 'Voice-Generator.com',
    subtitle: 'Opens inside Alya’s Reader. Close the panel to return to your book.',
    body: `<div class="voice-generator-disclosure">
      <p>Choose an EPUB or PDF using the embedded page’s file picker. Alya’s Reader stays open behind this panel; a book in the Reader library is <strong>not transferred automatically</strong>.</p>
      <p><strong>Privacy:</strong> Voice-Generator extracts EPUB text in your browser, then sends text chunks to its hosted text-to-speech service. Its PDF converter uploads the PDF to a service for text extraction. This is a third-party service, not your device.</p>
      <p>For a very long book, the resulting audiobook can take a while and may be a large download.</p>
    </div>`,
    foot: `<button class="btn" data-vg-cancel>Cancel</button><button class="btn btn-primary" data-vg-continue>${icon('sparkles')} Continue to Voice-Generator</button>`,
    wide: true,
  });
  consent.footEl.querySelector('[data-vg-cancel]')?.addEventListener('click', () => consent.close('cancel'));
  consent.footEl.querySelector('[data-vg-continue]')?.addEventListener('click', () => {
    consent.close('continue');
    const body = document.createElement('div');
    body.className = 'voice-generator-embed';
    body.innerHTML = '<p class="hint">Voice-Generator is a separate service embedded here. Your Reader will still be here when you close this panel.</p>';
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.title = 'Voice-Generator EPUB to Audio';
    frame.referrerPolicy = 'no-referrer';
    frame.loading = 'eager';
    body.append(frame);
    const embedded = modal({
      eyebrow: 'Third-party service',
      title: 'Voice-Generator',
      subtitle: 'Choose an EPUB or PDF below. Alya’s Reader stays open behind this panel.',
      body,
      foot: `<a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">Open separately</a><button class="btn btn-primary" data-vg-done>Return to Alya’s Reader</button>`,
      wide: true,
    });
    embedded.panel.classList.add('voice-generator-modal');
    embedded.footEl.querySelector('[data-vg-done]')?.addEventListener('click', () => embedded.close('done'));
  });
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
    ...(!['cbz', 'cbr'].includes(book.format) ? [{ label: 'Make audiobook chapters…', icon: 'loudhailer', onSelect: () => app.openBook(book.id, { audiobook: true }) }] : []),
    ...(!['cbz', 'cbr'].includes(book.format) ? [{ label: 'Download audio', icon: 'download', onSelect: () => downloadBookAudio(book) }] : []),
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

export async function importFiles(app, fileList, pendingIds = []) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;

  if (app.view !== 'library') app.go('library');

  // Persist the incoming files before doing any work, so a refresh while
  // an import is being prepared can resume it instead of losing it.
  const importIds = Array.from({ length: files.length }, (_, i) => pendingIds[i] || null);
  for (let i = 0; i < files.length; i++) {
    if (importIds[i]) continue;
    try { importIds[i] = await db.addPendingImport(files[i]); } catch {}
  }

  const jobs = files.map((file, i) => ({
    id: uid(),
    file,
    pendingId: importIds[i],
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
    } finally {
      if (job.pendingId) {
        try { await db.deletePendingImport(job.pendingId); } catch {}
      }
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
