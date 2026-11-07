/* Small shared helpers — no dependencies. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, html) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  if (html != null) node.innerHTML = html;
  return node;
}

export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const escAttr = esc;

export function icon(name, cls = '') {
  return `<svg${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function hashStr(str = '') {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function debounce(fn, ms = 300) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

export function rafThrottle(fn) {
  let queued = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatTimeLeft(words = 0) {
  const mins = Math.max(1, Math.round(words / 230));
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m ? `${m}m` : ''} left`.replace('  ', ' ');
}

export function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60e3) return 'just now';
  if (abs < 3600e3) return rtf.format(-Math.round(diff / 60e3), 'minute');
  if (abs < 864e5) return rtf.format(-Math.round(diff / 3600e3), 'hour');
  if (abs < 6048e5) return rtf.format(-Math.round(diff / 864e5), 'day');
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: abs >= 31536e6 ? 'numeric' : undefined });
}

export function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function titleFromFilename(name = 'Untitled') {
  let base = name.replace(/\.[^.]+$/, '')
    .replace(/[_+]+/g, ' ')
    .replace(/\s*[-–—]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return 'Untitled';
  base = base
    .replace(/\s*\((z-lib\.org|1lib|libgen|annas-archive)[^)]*\)\s*/gi, ' ')
    .replace(/\s*[\[(](epub|pdf|mobi|azw3|retail|scan|ocr)[\])]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const mostlyLower = !/[A-Z]{2,}/.test(base) && base === base.toLowerCase();
  if (mostlyLower) {
    base = base.replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\b(A|An|The|Of|And|In|On|To|For|With)\b/g, w => w.toLowerCase());
    base = base.charAt(0).toUpperCase() + base.slice(1);
  }
  return base;
}

export function fileExtension(name = '') {
  return (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [, ''])[1];
}

export function isEditable(node) {
  if (!node) return false;
  const t = node.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || node.isContentEditable;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'book';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export function dataUrlToBlob(dataUrl) {
  if (!dataUrl?.startsWith('data:')) return null;
  const [head, body] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function imageToCover(blob, maxW = 560) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    try { return await blobToDataURL(blob); } catch { return null; }
  }
}

export function isImageDataUrl(s) {
  return typeof s === 'string' && /^data:image\//.test(s);
}

export function countWords(text = '') {
  const m = text.match(/[\p{L}\p{N}'’$-]+/gu);
  return m ? m.length : 0;
}

export function normalizedText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

export function splitLongText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = -1;
    const window = rest.slice(0, maxLen);
    for (const re of [/[.!?]["'”’)]?\s+/g, /[;:]\s+/g, /,\s+/g, /\s+/g]) {
      let m;
      const rx = new RegExp(re.source, re.flags);
      while ((m = rx.exec(window))) cut = m.index + m[0].length - 1;
      if (cut > maxLen * 0.35) break;
    }
    if (cut <= 0) cut = rest.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

export function detectSentenceSegments(text) {
  const out = [];
  if (window.Intl?.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
    for (const s of seg.segment(text)) out.push({ text: s.segment, start: s.index });
  } else {
    const re = /[^.!?]+[.!?]+(?:["'”’)]+)?\s*|[^.!?]+$/g;
    let m;
    while ((m = re.exec(text))) out.push({ text: m[0], start: m.index });
  }
  return out;
}
