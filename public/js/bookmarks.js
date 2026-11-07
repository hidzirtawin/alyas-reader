/* Bookmarks + highlights, grouped by book. */

import { db } from './db.js';
import { toast, coverHTML } from './ui.js';
import {
  $, esc, icon, formatRelative,
} from './util.js';

export function renderMarks(app) {
  const view = $('#view');
  if (!view) return;
  const tab = app.marksTab || 'bookmarks';
  const bookmarks = [...(app.bookmarks || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const highlights = [...(app.highlights || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const items = tab === 'bookmarks' ? bookmarks : highlights;
  const groups = groupByBook(items, app);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Marks &amp; notes</h2>
        <p>Every bookmark and highlighted passage, kept on this device.</p>
      </div>
    </div>
    <div class="tabs" role="tablist">
      <button role="tab" data-marks-tab="bookmarks" class="${tab === 'bookmarks' ? 'is-active' : ''}">
        ${icon('bookmark')} Bookmarks <span class="tcount">${bookmarks.length}</span>
      </button>
      <button role="tab" data-marks-tab="highlights" class="${tab === 'highlights' ? 'is-active' : ''}">
        ${icon('highlighter')} Highlights <span class="tcount">${highlights.length}</span>
      </button>
    </div>
    ${groups.length ? groups.map(g => groupMarkup(app, g, tab)).join('') : emptyMarkup(tab)}
  `;

  view.onclick = e => onMarksClick(app, e, tab);
  view.onkeydown = e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('button')) return;
    const row = e.target.closest('[data-mark-row]');
    if (!row) return;
    e.preventDefault();
    let target = {};
    try { target = JSON.parse(row.dataset.target || '{}'); } catch {}
    app.openBook(row.dataset.book, target);
  };
}

function groupByBook(items, app) {
  const map = new Map();
  for (const item of items) {
    const book = app.books.find(b => b.id === item.bookId);
    if (!book) continue;
    if (!map.has(book.id)) map.set(book.id, { book, items: [] });
    map.get(book.id).items.push(item);
  }
  return [...map.values()].sort((a, b) => {
    const at = Math.max(...a.items.map(i => i.createdAt || 0));
    const bt = Math.max(...b.items.map(i => i.createdAt || 0));
    return bt - at;
  });
}

function groupMarkup(app, { book, items }, tab) {
  const progress = app.progress.get(book.id);
  return `
    <section class="mark-group">
      <div class="mark-group-head">
        <div class="mini-cover">${coverHTML(book, { mini: true })}</div>
        <div style="min-width:0">
          <h3>${esc(book.title || 'Untitled')}</h3>
          <span>${esc(book.author || 'Unknown author')} · ${items.length} ${tab === 'bookmarks' ? (items.length === 1 ? 'bookmark' : 'bookmarks') : (items.length === 1 ? 'highlight' : 'highlights')}</span>
        </div>
        <button class="btn btn-sm" data-open-book="${esc(book.id)}" data-has-progress="${progress ? '1' : '0'}">${icon('book')} Open</button>
      </div>
      ${items.map(item => tab === 'bookmarks' ? bookmarkRow(item, book) : highlightRow(item, book)).join('')}
    </section>`;
}

function bookmarkRow(item, book) {
  return `
    <div class="mark-row" data-mark-row data-book="${esc(book.id)}" data-target='${esc(JSON.stringify({
      chapterIndex: item.chapterIndex ?? 0,
      ratio: item.ratio ?? 0,
      page: item.page ?? undefined,
    }))}' role="button" tabindex="0">
      <div class="mark-ico">${icon('bookmark')}</div>
      <div class="mark-body">
        <div class="mark-top">
          <span class="mark-chapter">${esc(item.chapterTitle || (item.page ? `Page ${item.page}` : 'Bookmark'))}</span>
          <span class="mark-date">${formatRelative(item.createdAt)}</span>
        </div>
        <div class="mark-text">${esc(item.snippet || 'Saved spot')}</div>
      </div>
      <div class="mark-actions">
        <button class="icon-btn" data-delete-bookmark="${esc(item.id)}" aria-label="Delete bookmark" title="Delete bookmark">${icon('trash')}</button>
      </div>
    </div>`;
}

function highlightRow(item, book) {
  const swatch = `<span class="hl-swatch" style="background:${hlColor(item.color)}"></span>`;
  return `
    <div class="mark-row" data-mark-row data-book="${esc(book.id)}" data-highlight="${esc(item.id)}" data-target='${esc(JSON.stringify({
      chapterIndex: item.chapterIndex ?? 0,
      highlightId: item.id,
    }))}' role="button" tabindex="0">
      <div class="mark-ico hl">${icon('highlighter')}</div>
      <div class="mark-body">
        <div class="mark-top">
          ${swatch}
          <span class="mark-chapter">${esc(item.chapterTitle || 'Highlight')}</span>
          <span class="mark-date">${formatRelative(item.createdAt)}</span>
        </div>
        <div class="mark-text">${esc(item.text || '')}</div>
        ${item.note ? `<div class="mark-note">${esc(item.note)}</div>` : ''}
      </div>
      <div class="mark-actions">
        <button class="icon-btn" data-delete-highlight="${esc(item.id)}" aria-label="Delete highlight" title="Delete highlight">${icon('trash')}</button>
      </div>
    </div>`;
}

function hlColor(color) {
  return {
    amber: 'color-mix(in srgb, #e9b94c 60%, transparent)',
    sage: 'color-mix(in srgb, #86b48c 60%, transparent)',
    sky: 'color-mix(in srgb, #7fafd4 60%, transparent)',
    rose: 'color-mix(in srgb, #e0909d 60%, transparent)',
  }[color] || 'color-mix(in srgb, #e9b94c 60%, transparent)';
}

function emptyMarkup(tab) {
  return `
    <div class="empty-list">
      <div class="eico">${icon(tab === 'bookmarks' ? 'bookmark' : 'highlighter')}</div>
      <h3>${tab === 'bookmarks' ? 'No bookmarks yet' : 'No highlights yet'}</h3>
      <p>${tab === 'bookmarks'
        ? 'While reading, press B or tap the bookmark icon to keep your place. Bookmarks sync to this page automatically.'
        : 'Select a passage while reading to highlight it, add a thought, or listen from that exact sentence.'}</p>
      <button class="btn" style="margin-top:16px" data-go-library>${icon('book')} Go to your library</button>
    </div>`;
}

function onMarksClick(app, e, tab) {
  const tabBtn = e.target.closest('[data-marks-tab]');
  if (tabBtn) {
    app.marksTab = tabBtn.dataset.marksTab;
    renderMarks(app);
    return;
  }
  if (e.target.closest('[data-go-library]')) {
    app.go('library');
    return;
  }

  const delBm = e.target.closest('[data-delete-bookmark]');
  if (delBm) {
    e.stopPropagation();
    deleteBookmark(app, delBm.dataset.deleteBookmark);
    return;
  }
  const delHl = e.target.closest('[data-delete-highlight]');
  if (delHl) {
    e.stopPropagation();
    deleteHighlight(app, delHl.dataset.deleteHighlight);
    return;
  }

  const openBtn = e.target.closest('[data-open-book]');
  if (openBtn) {
    const progress = app.progress.get(openBtn.dataset.openBook);
    app.openBook(openBtn.dataset.openBook, progress ? {
      chapterIndex: progress.chapterIndex, ratio: progress.ratio, page: progress.page,
    } : undefined);
    return;
  }

  const row = e.target.closest('[data-mark-row]');
  if (row) {
    let target = {};
    try { target = JSON.parse(row.dataset.target || '{}'); } catch {}
    app.openBook(row.dataset.book, target);
  }
}

async function deleteBookmark(app, id) {
  const rec = (app.bookmarks || []).find(b => b.id === id);
  if (!rec) return;
  await db.deleteBookmark(id);
  app.bookmarks = app.bookmarks.filter(b => b.id !== id);
  app.counts.bookmarks = app.bookmarks.length;
  renderMarks(app);
  app.refreshRail?.();
  toast('Bookmark removed', 'ok', {
    actionLabel: 'Undo',
    onAction: async () => {
      await db.putBookmark(rec);
      app.bookmarks.push(rec);
      await app.reload();
      toast('Bookmark restored', 'ok');
    },
  });
}

async function deleteHighlight(app, id) {
  const rec = (app.highlights || []).find(h => h.id === id);
  if (!rec) return;
  await db.deleteHighlight(id);
  app.highlights = app.highlights.filter(h => h.id !== id);
  app.counts.highlights = app.highlights.length;
  renderMarks(app);
  app.refreshRail?.();
  toast('Highlight removed', 'ok', {
    actionLabel: 'Undo',
    onAction: async () => {
      await db.putHighlight(rec);
      app.highlights.push(rec);
      await app.reload();
      toast('Highlight restored', 'ok');
    },
  });
}
