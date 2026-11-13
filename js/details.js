/* Shared book details dialog (library + reader). */

import { db } from './db.js?v=202611130021-13b8353';
import { getPrefs } from './prefs.js?v=202611130021-13b8353';
import { modal, confirmDialog, toast, coverBox, formatLabel } from './ui.js?v=202611130021-13b8353';
import { formatDate, formatRelative } from './util.js?v=202611130021-13b8353';
import { downloadBookAudio } from './audioexport.js?v=202611130021-13b8353';

export function openBookDetails(app, book, { fromReader = false } = {}) {
  if (!book) return;
  const progress = app.progress?.get(book.id);
  const percent = progress?.percent || 0;
  const narration = getPrefs().tts.enabled && !['cbz', 'cbr'].includes(book.format);
  const canExportAudio = !['cbz', 'cbr'].includes(book.format);
  const numPages = book.meta?.numPages || book.meta?.pageCount;
  const chapters = book.meta?.chapterCount;
  const lengthLabel = numPages
    ? `${numPages} ${numPages === 1 ? 'page' : 'pages'}`
    : chapters
      ? `${chapters} ${chapters === 1 ? 'chapter' : 'chapters'}`
      : '—';

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-cover">${coverBox(book)}</div>
      <div class="detail-meta">
        <h3></h3>
        <div class="da"></div>
        <div class="detail-list">
          <div class="detail-row"><span>Format</span><span>${formatLabel(book.format)}</span></div>
          <div class="detail-row"><span>File</span><span class="detail-file"></span></div>
          <div class="detail-row"><span>Length</span><span>${lengthLabel}</span></div>
          <div class="detail-row"><span>Added</span><span>${formatDate(book.addedAt)}</span></div>
          <div class="detail-row"><span>Last opened</span><span>${book.lastOpenedAt ? formatRelative(book.lastOpenedAt) : 'Not yet'}</span></div>
          <div class="detail-row"><span>Progress</span><span>${percent ? `${Math.round(percent)}%` : 'Not started'}</span></div>
        </div>
        ${progress ? `<div class="hero-meter" style="margin-top:16px"><div class="bar"><i style="width:${Math.min(100, percent)}%"></i></div><span>${Math.round(percent)}%</span></div>` : ''}
      </div>
    </div>
    ${book.description ? `<p class="hint" style="margin-top:18px;font-size:12px;line-height:1.6">${escapeText(book.description)}</p>` : ''}
  `;
  body.querySelector('h3').textContent = book.title || 'Untitled';
  body.querySelector('.da').textContent = book.author || 'Unknown author';
  body.querySelector('.detail-file').textContent = book.fileName || '';

  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%';
  foot.innerHTML = `
    <button class="btn btn-danger btn-sm" data-remove>Remove</button>
    <span style="flex:1"></span>
    ${canExportAudio ? '<button class="btn btn-sm" data-download>Download audio</button>' : ''}
    ${narration ? '<button class="btn btn-sm" data-listen>Listen</button>' : ''}
    <button class="btn btn-primary btn-sm" data-read>${percent > 0 ? 'Continue' : 'Read'}</button>`;

  const m = modal({
    eyebrow: formatLabel(book.format) + ' · your library',
    title: 'Book details',
    body,
    foot,
    wide: true,
  });

  const openBook = (autoplay = false) => {
    m.close('open');
    app.openBook(book.id, autoplay ? { autoplay: true } : undefined);
  };

  foot.querySelector('[data-read]').onclick = () => openBook(false);
  foot.querySelector('[data-listen]')?.addEventListener('click', () => openBook(true));
  foot.querySelector('[data-download]')?.addEventListener('click', () => downloadBookAudio(book));
  foot.querySelector('[data-remove]').onclick = async () => {
    const ok = await confirmDialog({
      title: 'Remove this book?',
      message: 'The file, reading position, bookmarks and highlights will be deleted from this device.',
      confirmLabel: 'Remove book',
    });
    if (!ok) return;
    m.close('remove');
    await db.deleteBook(book.id);
    app.bookmarks = (app.bookmarks || []).filter(b => b.bookId !== book.id);
    app.highlights = (app.highlights || []).filter(h => h.bookId !== book.id);
    app.progress?.delete(book.id);
    if (fromReader) app.closeReader?.({ skipReload: true });
    await app.reload?.();
    toast('Book removed', 'ok');
  };
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
