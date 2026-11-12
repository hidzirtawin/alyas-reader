/* UI primitives: toasts, modals, menus, covers. */

import { $, icon, esc, hashStr, isImageDataUrl, uid } from './util.js';

const toastRoot = () => $('#toastRoot');
const modalRoot = () => $('#modalRoot');
const openModals = [];

/* ── Toasts ───────────────────────────────────────────────────────── */
export function toast(message, type = 'info', opts = {}) {
  const root = toastRoot();
  if (!root) return { close() {} };
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  const ico = type === 'ok' ? 'check' : type === 'err' ? 'info' : 'sparkles';
  node.innerHTML = `${icon(ico)}<span class="toast-text"></span>`;
  node.querySelector('.toast-text').textContent = message;
  if (opts.actionLabel && typeof opts.onAction === 'function') {
    const btn = document.createElement('button');
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => {
      close();
      opts.onAction();
    });
    node.appendChild(btn);
  }
  root.appendChild(node);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 260);
  };
  const ttl = opts.duration ?? (opts.actionLabel ? 6000 : 3400);
  const timer = setTimeout(close, ttl);
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', () => setTimeout(close, 1200));
  return { close, node };
}

/* ── Modal ────────────────────────────────────────────────────────── */
export function modal({
  title = '',
  eyebrow = '',
  subtitle = '',
  body = '',
  foot = '',
  wide = false,
  dismissible = true,
  onMount,
  onClose,
} = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      ${title || eyebrow ? `<div class="modal-head">
        <div>
          ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
          ${title ? `<h2></h2>` : ''}
          ${subtitle ? `<p class="modal-sub"></p>` : ''}
        </div>
        ${dismissible ? `<button class="icon-btn modal-x" aria-label="Close">${icon('x')}</button>` : ''}
      </div>` : ''}
      <div class="modal-body"></div>
      ${foot ? `<div class="modal-foot"></div>` : ''}
    </div>`;

  if (title) backdrop.querySelector('h2').textContent = title;
  if (subtitle) backdrop.querySelector('.modal-sub').textContent = subtitle;
  const bodyEl = backdrop.querySelector('.modal-body');
  const footEl = backdrop.querySelector('.modal-foot');
  const panel = backdrop.querySelector('.modal');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  if (typeof foot === 'string') { if (footEl) footEl.innerHTML = foot; }
  else if (foot && footEl) footEl.appendChild(foot);

  const prevFocus = document.activeElement;
  let closed = false;

  function close(reason = 'api') {
    if (closed) return;
    closed = true;
    const idx = openModals.indexOf(entry);
    if (idx >= 0) openModals.splice(idx, 1);
    if (!openModals.length) document.body.classList.remove('modal-open');
    backdrop.style.opacity = '0';
    backdrop.style.transition = 'opacity .16s';
    setTimeout(() => backdrop.remove(), 170);
    document.removeEventListener('keydown', onKey);
    try { prevFocus?.focus?.({ preventScroll: true }); } catch {}
    onClose?.(reason);
  }

  const entry = { close, backdrop, panel, bodyEl, footEl };

  function onKey(e) {
    if (e.key === 'Escape' && dismissible && openModals[openModals.length - 1] === entry) {
      e.stopPropagation();
      close('escape');
    }
    if (e.key === 'Tab') {
      const focusables = Array.from(panel.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      )).filter(n => n.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  backdrop.addEventListener('mousedown', e => {
    if (e.target === backdrop && dismissible) close('backdrop');
  });
  backdrop.querySelector('.modal-x')?.addEventListener('click', () => close('x'));
  document.addEventListener('keydown', onKey);

  modalRoot().appendChild(backdrop);
  document.body.classList.add('modal-open');
  openModals.push(entry);

  requestAnimationFrame(() => {
    const auto = bodyEl.querySelector('[autofocus]');
    (auto || panel.querySelector('button, input, select, textarea') || panel).focus?.({ preventScroll: true });
  });

  onMount?.({ bodyEl, footEl, panel, close });
  return entry;
}

export function closeAllModals() {
  [...openModals].reverse().forEach(m => m.close('all'));
}

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:10px;width:100%;justify-content:flex-end;align-items:center';
    foot.innerHTML = `
      <button class="btn" data-cancel>${esc(cancelLabel)}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmLabel)}</button>`;
    const m = modal({
      title,
      subtitle: message,
      body: '<div style="height:4px"></div>',
      foot,
      onClose: () => finish(false),
    });
    foot.querySelector('[data-cancel]').onclick = () => { finish(false); m.close('cancel'); };
    foot.querySelector('[data-ok]').onclick = () => { finish(true); m.close('ok'); };
    requestAnimationFrame(() => foot.querySelector('[data-ok]')?.focus());
  });
}

/* ── Context menu ─────────────────────────────────────────────────── */
export function contextMenu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach(n => n.remove());
  const menu = document.createElement('div');
  menu.className = 'menu ctx-menu';
  menu.style.visibility = 'hidden';
  menu.style.position = 'fixed';

  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
  };
  const onDown = e => { if (!menu.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') close(); };

  for (const item of items) {
    if (!item || item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.innerHTML = `${item.icon ? icon(item.icon) : ''}<span>${esc(item.label)}</span>`;
    if (item.danger) btn.classList.add('danger');
    btn.addEventListener('click', () => { close(); item.onSelect?.(); });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = `${Math.max(8, Math.min(x, vw - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, vh - r.height - 8))}px`;
  menu.style.visibility = 'visible';
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
  }, 0);
  return { close };
}

/* ── Covers ───────────────────────────────────────────────────────── */
export function coverHTML(book, { mini = false } = {}) {
  const title = book.title || book.fileName || 'Untitled';
  const author = book.author || 'Unknown author';
  if (isImageDataUrl(book.cover)) {
    return `<img src="${book.cover}" alt="" ${mini ? '' : 'loading="lazy"'} draggable="false">`;
  }
  const g = hashStr(`${title}${author}`) % 8;
  return `<div class="cover-gen g${g}">
    <div class="cg-top">${mini ? '' : 'Alya’s Reader'}</div>
    <div>
      <div class="cg-title">${esc(title)}</div>
      <div class="cg-author">${esc(author)}</div>
    </div>
    <div class="cg-mark">${mini ? '' : icon('book')}</div>
  </div>`;
}

export function coverBox(book, cls = '', mini = false) {
  return `<div class="book-cover ${cls}">${coverHTML(book, { mini })}</div>`;
}

export function formatLabel(format = '') {
  const map = { epub: 'EPUB', pdf: 'PDF', docx: 'DOCX', odt: 'ODT', rtf: 'RTF', html: 'HTML', fb2: 'FB2', txt: 'TXT', md: 'MD', cbz: 'CBZ', cbr: 'CBR' };
  return map[format] || String(format || 'BOOK').toUpperCase();
}

export function suggestName(name = 'book') {
  return `${name.replace(/[^\w\-. ]+/g, '').replace(/\s+/g, ' ').trim() || 'book'}-${uid().slice(0, 6)}`;
}

/* ── Focus helpers ────────────────────────────────────────────────── */
export function trapFocus(container) {
  const handler = e => {
    if (e.key !== 'Tab') return;
    const f = Array.from(container.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )).filter(n => n.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  };
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

/* Global "click outside closes" for simple popovers is handled by callers. */
export function isModalOpen() {
  return openModals.length > 0;
}

export function shortcutsModal() {
  const rows = [
    ['Turn pages back / forward', ['←', '→']],
    ['Scroll', ['↑', '↓', 'Space']],
    ['Listen / pause narration', ['T']],
    ['Bookmark this spot', ['B']],
    ['Open contents', ['C']],
    ['Reading appearance', ['A']],
    ['Jump to a page or chapter', ['G']],
    ['Close panels / reader', ['Esc']],
    ['Add files (library)', ['⌘', 'O']],
    ['Search library', ['/']],
  ];
  modal({
    eyebrow: 'Alya’s Reader',
    title: 'Keyboard shortcuts',
    body: `<div class="kbd-grid">${rows.map(([label, keys]) => `
      <div class="kbd-row"><span>${esc(label)}</span>${keys.map(k => `<kbd>${esc(k)}</kbd>`).join('')}</div>
    `).join('')}</div>`,
  });
}
