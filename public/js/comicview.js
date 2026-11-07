/* Paged comic viewer for CBZ/CBR books. */

import { clamp, icon, withTimeout } from './util.js';

export class ComicView {
  constructor(container, comic, { onPageChange } = {}) {
    this.container = container;
    this.comic = comic;
    this.pageCount = comic.pageCount;
    this.page = 1;
    this.zoom = 1;
    this.destroyed = false;
    this.urls = new Map();
    this.token = 0;
    this.onPageChange = onPageChange || (() => {});
    this._build();
    this._bind();
  }

  _build() {
    this.container.classList.add('comic-stage');
    this.container.innerHTML = `
      <div class="comic-shell">
        <div class="comic-viewport" id="comicViewport">
          <div class="comic-canvas" id="comicCanvas">
            <img class="comic-page" id="comicPage" alt="" draggable="false">
          </div>
        </div>
        <button class="comic-turn prev" data-comicnav="prev" aria-label="Previous page">${icon('chevron-left')}</button>
        <button class="comic-turn next" data-comicnav="next" aria-label="Next page">${icon('chevron-right')}</button>
        <div class="comic-loading" id="comicLoading"><span class="busy-dot"></span><span>Loading page…</span></div>
      </div>`;

    this.viewport = this.container.querySelector('#comicViewport');
    this.canvas = this.container.querySelector('#comicCanvas');
    this.img = this.container.querySelector('#comicPage');
    this.loading = this.container.querySelector('#comicLoading');
    this.prevBtn = this.container.querySelector('[data-comicnav="prev"]');
    this.nextBtn = this.container.querySelector('[data-comicnav="next"]');

    this.zoomUi = document.createElement('div');
    this.zoomUi.className = 'pdf-zoom comic-zoom';
    this.zoomUi.innerHTML = `
      <button data-comiczoom="out" aria-label="Zoom out">−</button>
      <span class="zl">100%</span>
      <button data-comiczoom="in" aria-label="Zoom in">+</button>`;
    (this.container.parentElement || this.container).appendChild(this.zoomUi);

    this._resize = () => this._layout();
    window.addEventListener('resize', this._resize);
    window.addEventListener('orientationchange', this._resize);
  }

  _bind() {
    this.prevBtn.addEventListener('click', () => this.prevPage());
    this.nextBtn.addEventListener('click', () => this.nextPage());
    this.zoomUi.addEventListener('click', e => {
      const action = e.target.closest('[data-comiczoom]')?.dataset.comiczoom;
      if (!action) return;
      this.setZoom(action === 'in' ? this.zoom + 0.2 : this.zoom - 0.2);
    });
    this.img.addEventListener('dblclick', () => this.setZoom(this.zoom > 1.4 ? 1 : 2));
    this.viewport.addEventListener('dblclick', e => {
      if (e.target === this.img) return;
      this.setZoom(this.zoom > 1.4 ? 1 : 2);
    });

    let startX = 0;
    let startY = 0;
    let down = false;
    this.viewport.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      down = true;
      startX = e.clientX;
      startY = e.clientY;
    });
    this.viewport.addEventListener('pointerup', e => {
      if (!down) return;
      down = false;
      if (this.zoom > 1.05) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0) this.nextPage();
        else this.prevPage();
      }
    });
  }

  async init(startPage = 1) {
    await this.showPage(startPage);
  }

  async showPage(pageNumber) {
    if (this.destroyed) return;
    const n = clamp(Math.round(pageNumber), 1, this.pageCount);
    const token = ++this.token;
    this.page = n;
    this._updateNav();
    this.loading.hidden = false;
    this.loading.innerHTML = '<span class="busy-dot"></span><span>Loading page…</span>';
    this.img.style.opacity = '0';

    try {
      const url = await this._urlFor(n);
      if (token !== this.token) return;

      this.img.onload = null;
      this.img.onerror = null;
      const loaded = new Promise((resolve, reject) => {
        this.img.onload = resolve;
        this.img.onerror = () => reject(new Error('This page image could not be decoded.'));
      });
      this.img.src = url;
      this.img.alt = `Page ${n} of ${this.pageCount}`;
      await withTimeout(loaded, 12000).then(v => {
        if (v === null && !this.img.naturalWidth) throw new Error('This page image took too long to load.');
      });
      if (token !== this.token) return;

      this.img.style.opacity = '1';
      this.loading.hidden = true;
      this._layout(true);
      this._updateZoomLabel();
      this.onPageChange(n);
      this._updateNav();
      this._prefetch(n + 1);
      this._prefetch(n - 1);
    } catch (err) {
      if (token !== this.token) return;
      this.loading.hidden = false;
      this.loading.innerHTML = `${icon('info')}<span>${escapeText(err.message || 'This page could not be shown.')}</span>`;
    }
  }

  nextPage() {
    if (this.page < this.pageCount) this.showPage(this.page + 1);
  }

  prevPage() {
    if (this.page > 1) this.showPage(this.page - 1);
  }

  _updateNav() {
    this.prevBtn.disabled = this.page <= 1;
    this.nextBtn.disabled = this.page >= this.pageCount;
  }

  /* ── URLs ────────────────────────────────────────────────────── */
  async _urlFor(pageNumber) {
    const index = pageNumber - 1;
    const hit = this.urls.get(index);
    if (hit) {
      hit.at = Date.now();
      return hit.url;
    }
    const blob = await this.comic.getPageBlob(index);
    if (this.destroyed) throw new Error('The reader was closed.');
    const url = URL.createObjectURL(blob);
    this.urls.set(index, { url, at: Date.now() });
    this._trimUrls();
    return url;
  }

  _prefetch(pageNumber) {
    if (pageNumber < 1 || pageNumber > this.pageCount) return;
    if (this.urls.has(pageNumber - 1)) return;
    this._urlFor(pageNumber).catch(() => {});
  }

  _trimUrls() {
    if (this.urls.size <= 5) return;
    const order = [...this.urls.entries()].sort((a, b) => a[1].at - b[1].at);
    const keep = new Set([this.page - 1, this.page, this.page - 2, this.page + 1]);
    for (const [index, entry] of order) {
      if (this.urls.size <= 5) break;
      if (keep.has(index)) continue;
      this.urls.delete(index);
      URL.revokeObjectURL(entry.url);
    }
  }

  /* ── layout / zoom ───────────────────────────────────────────── */
  _layout(resetScroll = false) {
    if (this.destroyed) return;
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const iw = this.img.naturalWidth;
    const ih = this.img.naturalHeight;
    if (!iw || !ih || !vw || !vh) return;

    const fit = Math.min((vw - 36) / iw, (vh - 36) / ih);
    const width = Math.max(60, iw * fit * this.zoom);
    this.img.style.width = `${Math.round(width)}px`;
    this.img.style.height = 'auto';

    if (resetScroll) {
      this.viewport.scrollTop = 0;
      this.viewport.scrollLeft = 0;
    }
  }

  setZoom(value) {
    const next = Math.round(clamp(value, 0.5, 3) * 10) / 10;
    if (Math.abs(next - this.zoom) < 0.01) return;
    const oldW = this.viewport.scrollWidth;
    const oldH = this.viewport.scrollHeight;
    const cx = oldW ? (this.viewport.scrollLeft + this.viewport.clientWidth / 2) / oldW : 0.5;
    const cy = oldH ? (this.viewport.scrollTop + this.viewport.clientHeight / 2) / oldH : 0.5;
    this.zoom = next;
    this._layout();
    this._updateZoomLabel();
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      this.viewport.scrollLeft = cx * this.viewport.scrollWidth - this.viewport.clientWidth / 2;
      this.viewport.scrollTop = cy * this.viewport.scrollHeight - this.viewport.clientHeight / 2;
    });
  }

  _updateZoomLabel() {
    const label = this.zoomUi?.querySelector('.zl');
    if (label) label.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  destroy() {
    this.destroyed = true;
    this.token++;
    window.removeEventListener('resize', this._resize);
    window.removeEventListener('orientationchange', this._resize);
    this.zoomUi?.remove();
    for (const { url } of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.container.innerHTML = '';
    this.container.classList.remove('comic-stage');
  }
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}
