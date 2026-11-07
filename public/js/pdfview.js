/* PDF reading with pdf.js: lazy page rendering, selectable text,
   page-accurate narration highlighting, outline support. */

import { detectSentenceSegments, normalizedText, rafThrottle } from './util.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

export async function loadPdfDocument(blob, { onPassword } = {}) {
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
  });
  if (onPassword) {
    task.onPassword = (updatePassword, reason) => onPassword(updatePassword, reason);
  }
  return task.promise;
}

export class PdfView {
  constructor(pdf, container, { onPageChange, onZoom } = {}) {
    this.pdf = pdf;
    this.container = container;
    this.onPageChange = onPageChange || (() => {});
    this.onZoom = onZoom || (() => {});
    this.numPages = pdf.numPages;
    this.currentPage = 1;
    this.zoom = 1;
    this.states = [];
    this.destroyed = false;
    this._currentHighlight = null;

    container.classList.add('pdf-stage');
    container.innerHTML = '';

    this.shell = document.createElement('div');
    this.shell.className = 'pdf-shell';
    this.docEl = document.createElement('div');
    this.docEl.className = 'pdf-doc';
    this.shell.appendChild(this.docEl);
    container.appendChild(this.shell);

    this._boundScroll = rafThrottle(() => this._handleScroll());
    container.addEventListener('scroll', this._boundScroll, { passive: true });
    this._onResize = () => this._relayout();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);

    this._io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const idx = Number(entry.target.dataset.pageIndex);
          this.renderPage(idx);
        }
      }
    }, { root: container, rootMargin: '1300px 0px' });

    this.zoomUi = document.createElement('div');
    this.zoomUi.className = 'pdf-zoom';
    this.zoomUi.innerHTML = `
      <button data-pdfzoom="out" aria-label="Zoom out">−</button>
      <span class="zl">100%</span>
      <button data-pdfzoom="in" aria-label="Zoom in">+</button>`;
    this.zoomUi.addEventListener('click', e => {
      const action = e.target.closest('[data-pdfzoom]')?.dataset.pdfzoom;
      if (!action) return;
      this.setZoom(this.zoom + (action === 'in' ? 0.15 : -0.15));
    });
    container.parentElement?.appendChild(this.zoomUi) || container.appendChild(this.zoomUi);
  }

  async init() {
    const first = await this.pdf.getPage(1);
    this._baseViewport = first.getViewport({ scale: 1 });
    this._firstPage = first;
    this._measure();
    this._buildPlaceholders();
    // Rendering page 1 can take a moment (and its completion promise can be
    // delayed in throttled windows); don't block the reader on it.
    this.renderPage(0);
    this._observe();
    this._updateZoomUi();
    this._handleScroll();
  }

  _measure() {
    const w = this.container.clientWidth || window.innerWidth;
    const pad = w < 700 ? 28 : 90;
    this.fitWidth = Math.max(240, Math.min(1120, w - pad));
  }

  _pageHeightRatio() {
    const vp = this._baseViewport;
    return vp.height / vp.width;
  }

  _buildPlaceholders() {
    this.docEl.innerHTML = '';
    const ratio = this._pageHeightRatio();
    for (let i = 0; i < this.numPages; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap.dataset.pageIndex = i;
      wrap.setAttribute('aria-label', `Page ${i + 1}`);
      const width = this._cssWidth();
      wrap.style.width = `${width}px`;
      wrap.style.height = `${Math.round(width * ratio)}px`;
      wrap.innerHTML = `<div class="page-shimmer">Page ${i + 1}</div>`;
      this.docEl.appendChild(wrap);
      this.states[i] = {
        index: i,
        wrap,
        canvas: null,
        textLayer: null,
        hlLayer: null,
        rendered: false,
        rendering: false,
        page: i === 0 ? this._firstPage : null,
        items: null,
        itemSpans: null,
        sentences: null,
        text: '',
      };
    }
  }

  _cssWidth() {
    return Math.round(this.fitWidth * this.zoom);
  }

  _observe() {
    this.states.forEach(s => this._io.observe(s.wrap));
  }

  async renderPage(index) {
    const st = this.states[index];
    if (!st || st.rendered || st.rendering || this.destroyed) return;
    st.rendering = true;
    try {
      const page = st.page || await this.pdf.getPage(index + 1);
      if (this.destroyed) return;
      st.page = page;
      const base = page.getViewport({ scale: 1 });
      const cssScale = this._cssWidth() / base.width;
      const viewport = page.getViewport({ scale: cssScale });
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const renderViewport = page.getViewport({ scale: cssScale * dpr });

      st.wrap.style.width = `${Math.round(viewport.width)}px`;
      st.wrap.style.height = `${Math.round(viewport.height)}px`;

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(renderViewport.width);
      canvas.height = Math.floor(renderViewport.height);
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      st.wrap.insertBefore(canvas, st.wrap.firstChild);
      st.canvas = canvas;
      // Paint asynchronously. Some Chromium builds delay the completion
      // promise even after the canvas is fully drawn, so never block on it.
      page.render({ canvasContext: ctx, viewport: renderViewport }).promise.catch(() => {});

      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      textLayer.style.width = `${Math.round(viewport.width)}px`;
      textLayer.style.height = `${Math.round(viewport.height)}px`;
      const hlLayer = document.createElement('div');
      hlLayer.className = 'pdf-hl-layer';
      st.wrap.appendChild(hlLayer);
      st.hlLayer = hlLayer;

      const content = await page.getTextContent();
      st.items = content.items.filter(it => typeof it.str === 'string' && it.str.length);
      st.itemSpans = [];
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < st.items.length; i++) {
        const item = st.items[i];
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
        const span = document.createElement('span');
        span.textContent = item.str;
        span.style.left = `${tx[4]}px`;
        span.style.top = `${tx[5] - fontHeight * 0.86}px`;
        span.style.fontSize = `${fontHeight}px`;
        span.style.fontFamily = 'sans-serif';
        span.style.lineHeight = '1';
        span.dir = item.dir || 'ltr';
        st.itemSpans.push(span);
        fragment.appendChild(span);
        if (item.hasEOL) fragment.appendChild(document.createElement('br'));
      }
      textLayer.appendChild(fragment);
      st.wrap.appendChild(textLayer);
      st.textLayer = textLayer;

      st.text = normalizedText(st.items.map(i => i.str).join(' '));
      st.sentences = buildPageSentences(st.items).map(s => ({ ...s, page: index + 1 }));
      st.rendered = true;
      st.rendering = false;
      st.wrap.querySelector('.page-shimmer')?.remove();

      if (this._currentHighlight?.page === index) this._drawHighlight(this._currentHighlight);
      if (index === 0) this._handleScroll();
    } catch (err) {
      st.rendering = false;
      if (!this.destroyed) {
        console.warn('PDF page render failed', err);
        const shimmer = st.wrap.querySelector('.page-shimmer');
        if (shimmer) shimmer.textContent = 'Page could not be drawn';
      }
    }
  }

  /* ── page text for narration ─────────────────────────────────── */
  async getPageSentences(pageNumber) {
    const st = this.states[pageNumber - 1];
    if (!st) return [];
    if (st.sentences) return st.sentences;
    try {
      const page = st.page || await this.pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      st.items = st.items || content.items.filter(it => typeof it.str === 'string' && it.str.length);
      st.text = normalizedText(st.items.map(i => i.str).join(' '));
      st.sentences = buildPageSentences(st.items).map(s => ({ ...s, page: pageNumber }));
      return st.sentences;
    } catch {
      return [];
    }
  }

  async getPageText(pageNumber) {
    const st = this.states[pageNumber - 1];
    if (!st) return '';
    if (st.text) return st.text;
    const sentences = await this.getPageSentences(pageNumber);
    return sentences.map(s => s.text).join(' ');
  }

  /* ── highlighting ────────────────────────────────────────────── */
  showHighlight(sentence) {
    this._currentHighlight = sentence;
    this._drawHighlight(sentence);
  }

  clearHighlight() {
    this._currentHighlight = null;
    this.states.forEach(st => { if (st.hlLayer) st.hlLayer.innerHTML = ''; });
  }

  _drawHighlight(sentence) {
    const st = this.states[(sentence.page || 1) - 1];
    if (!st?.hlLayer) return;
    st.hlLayer.innerHTML = '';
    const pageRect = st.wrap.getBoundingClientRect();
    const rects = [];
    for (const idx of sentence.items || []) {
      const span = st.itemSpans?.[idx];
      if (!span) continue;
      const r = span.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      rects.push({ left: r.left - pageRect.left, top: r.top - pageRect.top, width: r.width, height: r.height });
    }
    // merge rects that share a line
    const merged = [];
    for (const r of rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.top - r.top) < 2 && r.left <= last.left + last.width + 3) {
        last.width = Math.max(last.width, r.left - last.left + r.width);
      } else {
        merged.push({ ...r });
      }
    }
    for (const r of merged) {
      const div = document.createElement('div');
      div.className = 'pdf-hl';
      div.style.left = `${r.left}px`;
      div.style.top = `${r.top}px`;
      div.style.width = `${r.width}px`;
      div.style.height = `${r.height}px`;
      st.hlLayer.appendChild(div);
    }
  }

  /* ── navigation ──────────────────────────────────────────────── */
  scrollToPage(pageNumber, { smooth = false } = {}) {
    const n = Math.max(1, Math.min(this.numPages, Math.round(pageNumber)));
    const st = this.states[n - 1];
    if (!st) return;
    const cRect = this.container.getBoundingClientRect();
    const top = this.container.scrollTop + st.wrap.getBoundingClientRect().top - cRect.top - 20;
    this.container.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    this.currentPage = n;
    this.renderPage(n - 1);
    this.onPageChange(n);
  }

  _handleScroll() {
    if (this.destroyed) return;
    const cRect = this.container.getBoundingClientRect();
    const threshold = cRect.top + 100;
    let page = 1;
    for (let i = 0; i < this.states.length; i++) {
      if (this.states[i].wrap.getBoundingClientRect().top <= threshold) page = i + 1;
      else break;
    }
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.onPageChange(page);
    }
  }

  get pageProgress() {
    if (this.numPages <= 1) return 1;
    return (this.currentPage - 1) / (this.numPages - 1);
  }

  /* ── zoom / layout ───────────────────────────────────────────── */
  setZoom(zoom) {
    const next = Math.max(0.6, Math.min(2.4, Math.round(zoom * 20) / 20));
    if (Math.abs(next - this.zoom) < 0.01) return;
    const stage = this.container;
    const oldH = stage.scrollHeight - stage.clientHeight;
    const ratio = oldH > 0 ? stage.scrollTop / oldH : 0;
    this.zoom = next;
    this._relayout(true);
    requestAnimationFrame(() => {
      const nh = stage.scrollHeight - stage.clientHeight;
      stage.scrollTop = ratio * Math.max(0, nh);
    });
    this._updateZoomUi();
  }

  _relayout(preserveRatio = false) {
    if (this.destroyed) return;
    this._measure();
    const ratio = this.container.scrollHeight - this.container.clientHeight > 0
      ? this.container.scrollTop / (this.container.scrollHeight - this.container.clientHeight)
      : 0;
    const heightRatio = this._pageHeightRatio();
    const width = this._cssWidth();
    const toRender = [];
    for (const st of this.states) {
      st.wrap.style.width = `${width}px`;
      if (st.rendered) {
        st.rendered = false;
        st.rendering = false;
        st.canvas?.remove();
        st.textLayer?.remove();
        st.hlLayer?.remove();
        st.canvas = st.textLayer = st.hlLayer = null;
        st.itemSpans = null;
        if (!st.wrap.querySelector('.page-shimmer')) {
          const sh = document.createElement('div');
          sh.className = 'page-shimmer';
          sh.textContent = `Page ${st.index + 1}`;
          st.wrap.appendChild(sh);
        }
        toRender.push(st.index);
      } else {
        st.wrap.style.height = `${Math.round(width * heightRatio)}px`;
      }
    }
    if (!preserveRatio) {
      this.container.scrollTop = ratio * Math.max(0, this.container.scrollHeight - this.container.clientHeight);
    }
    for (const i of toRender) this.renderPage(i);
    this._updateZoomUi();
  }

  _updateZoomUi() {
    const label = this.zoomUi?.querySelector('.zl');
    if (label) label.textContent = `${Math.round(this.zoom * 100)}%`;
    this.onZoom(this.zoom);
  }

  /* ── outline ─────────────────────────────────────────────────── */
  async getOutline() {
    let outline = [];
    try { outline = (await this.pdf.getOutline()) || []; } catch { return []; }
    const out = [];
    const walk = async (items, depth) => {
      for (const item of items) {
        let page = null;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await this.pdf.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) page = (await this.pdf.getPageIndex(dest[0])) + 1;
        } catch {}
        if (item.title) out.push({ label: normalizedText(item.title), page, depth: Math.min(depth, 3) });
        if (item.items?.length) await walk(item.items, depth + 1);
      }
    };
    await walk(outline, 0);
    return out.filter(x => x.page && x.page >= 1 && x.page <= this.numPages);
  }

  destroy() {
    this.destroyed = true;
    this.container.removeEventListener('scroll', this._boundScroll);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this._io.disconnect();
    this.zoomUi?.remove();
    this.zoomUi = null;
    try { this.pdf.destroy(); } catch {}
    this.states.forEach(st => { try { st.page?.cleanup?.(); } catch {} });
    this.container.classList.remove('pdf-stage');
    this.container.innerHTML = '';
  }
}

function buildPageSentences(items) {
  let text = '';
  const pieces = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const str = item.str || '';
    if (!str) continue;
    if (text && !/\s$/.test(text) && !/^\s/.test(str)) text += ' ';
    const start = text.length;
    text += str;
    pieces.push({ start, end: text.length, idx: pieces.length });
    if (item.hasEOL) text += ' ';
  }
  const sentences = [];
  for (const seg of detectSentenceSegments(text)) {
    const raw = seg.text;
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = seg.start + lead;
    const end = start + trimmed.length;
    if (trimmed.length < 2) continue;
    if (!/[\p{L}\p{N}]/u.test(trimmed)) continue;
    const itemIdxs = pieces
      .filter(p => p.end > start && p.start < end)
      .map(p => p.idx);
    sentences.push({ text: trimmed, page: 0, items: itemIdxs });
  }
  return sentences;
}
