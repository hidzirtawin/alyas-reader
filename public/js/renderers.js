/* Document import + reflowable book building.
   EPUB is parsed directly with JSZip; DOCX via mammoth; TXT/MD natively. */

import {
  esc, countWords, normalizedText, imageToCover,
  fileExtension, titleFromFilename, withTimeout,
} from './util.js';

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
}

/* ═══════════════════════════════════════════════════════════════════
   Public API
   ═══════════════════════════════════════════════════════════════════ */

export function detectFormat(file) {
  const ext = fileExtension(file.name);
  if (ext === 'epub') return 'epub';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'txt') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'cbz' || ext === 'zip') return 'cbz';
  if (ext === 'cbr') return 'cbr';
  const t = (file.type || '').toLowerCase();
  if (t.includes('epub')) return 'epub';
  if (t.includes('pdf')) return 'pdf';
  if (t.includes('wordprocessingml')) return 'docx';
  if (t.startsWith('text/plain')) return 'txt';
  if (t.includes('comicbook') || t.includes('cbz')) return 'cbz';
  if (t.includes('x-cbr')) return 'cbr';
  return null;
}

export const isComicFormat = format => format === 'cbz' || format === 'cbr';

export function unsupportedMessage(file) {
  const ext = fileExtension(file.name);
  if (['doc', 'rtf', 'odt', 'mobi', 'azw', 'azw3', 'fb2', 'djvu'].includes(ext)) {
    return `.${ext} isn’t supported yet — try EPUB, PDF, DOCX, TXT, MD, CBZ or CBR.`;
  }
  return 'That file type isn’t supported — try EPUB, PDF, DOCX, TXT, MD, CBZ or CBR.';
}

export async function probeFile(file) {
  const format = detectFormat(file);
  if (!format) throw new Error(unsupportedMessage(file));
  let probed;
  if (format === 'epub') probed = await probeEpub(file);
  else if (format === 'pdf') probed = await probePdf(file);
  else if (format === 'docx') probed = await probeDocx(file);
  else if (isComicFormat(format)) probed = await probeComic(file, format);
  else probed = await probeText(file, format);
  return {
    format: probed.format || format,
    title: (probed.title || '').trim() || titleFromFilename(file.name),
    author: (probed.author || '').trim() || 'Unknown author',
    cover: probed.cover || null,
    description: probed.description || '',
    language: probed.language || 'en',
    meta: probed.meta || {},
  };
}

export async function buildReflowable(record, blob) {
  if (record.format === 'epub') return buildEpub(record, blob);
  if (record.format === 'docx') return buildDocx(record, blob);
  return buildText(record, blob);
}

export async function buildComicBook(record, blob) {
  return record.format === 'cbr' ? buildCbr(record, blob) : buildCbz(record, blob);
}

/* ═══════════════════════════════════════════════════════════════════
   Shared
   ═══════════════════════════════════════════════════════════════════ */

const decode = (s = '') => { try { return decodeURIComponent(s); } catch { return s; } };
const normPath = (p = '') => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
const dirname = p => { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; };

function resolveHref(baseDir, href) {
  if (!href) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  const raw = href.split('#')[0].split('?')[0];
  if (!raw) return '';
  const decoded = decode(raw);
  const absolute = decoded.startsWith('/');
  const stack = absolute ? [] : baseDir.split('/').filter(Boolean);
  for (const part of decoded.replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function zipIndex(zip) {
  const map = new Map();
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    map.set(path, entry);
    map.set(normPath(path), entry);
    map.set(path.toLowerCase(), entry);
    map.set(normPath(decode(path)), entry);
    map.set(normPath(decode(path)).toLowerCase(), entry);
  });
  return map;
}

function findZip(index, path) {
  if (!path) return null;
  return index.get(path)
    || index.get(normPath(path))
    || index.get(path.toLowerCase())
    || index.get(normPath(decode(path)))
    || index.get(normPath(decode(path)).toLowerCase())
    || null;
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
};

function extOf(p = '') {
  return (p.toLowerCase().match(/\.([a-z0-9]+)($|[?#])/) || [, ''])[1];
}

function plainDescription(html = '') {
  const div = document.createElement('div');
  div.innerHTML = html;
  return normalizedText(div.textContent || '').slice(0, 700);
}

function parseMarkup(text, preferXml = true) {
  const parser = new DOMParser();
  if (preferXml) {
    const xml = parser.parseFromString(text, 'application/xhtml+xml');
    if (!xml.querySelector('parsererror')) return xml;
  }
  return parser.parseFromString(text, 'text/html');
}

function sanitizeDocument(doc) {
  doc.querySelectorAll('script, style, link, meta, base, iframe, frame, frameset, object, embed, applet, form, input, textarea, select, button, audio, video, canvas, noscript, template, dialog').forEach(n => n.remove());
  const all = doc.querySelectorAll('*');
  for (const node of all) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') node.removeAttribute(attr.name);
      else if (name === 'href' && /^\s*javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
      else if (name === 'style') {
        const v = attr.value.toLowerCase();
        if (v.includes('position:fixed') || v.includes('position: fixed') || v.includes('expression(')) node.removeAttribute('style');
      }
    }
    if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') || '')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return doc;
}

function labelFromHref(href = '') {
  let base = (href.split('/').pop() || '').replace(/\.[^.]+$/, '').replace(/[+_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const low = base.toLowerCase();
  if (!base) return '';
  if (low === 'cover' || low === 'coverimage') return 'Cover';
  if (/^(title|titlepage|title page|halftitle)$/.test(low)) return 'Title Page';
  if (/^(toc|contents|nav|navigation)$/.test(low)) return 'Contents';
  if (/^(copyright|colophon|imprint)$/.test(low)) return 'Copyright';
  if (/^(dedication|epigraph)$/.test(low)) return base.charAt(0).toUpperCase() + base.slice(1);
  const m = low.match(/\b(chapter|chap|ch|part|book|section|prologue|epilogue|foreword|afterword|introduction|preface|appendix)[\s._-]*([0-9]+|[ivxlcdm]+)?\b/i);
  if (m) {
    base = m[0].replace(/[\s._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return base;
  }
  base = base.replace(/[-_]+/g, ' ');
  return base.length <= 60 ? base.replace(/\b\w/g, c => c.toUpperCase()) : '';
}

function chapterLabel(el) {
  if (!el) return '';
  const h = el.querySelector('h1,h2,h3,h4,title');
  const t = normalizedText(h?.textContent || '');
  return t.length >= 1 && t.length <= 120 ? t : '';
}

function rewriteLinks(doc, chapterDir, currentIndex, hrefToIndex) {
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    if (/^(https?:|mailto:|tel:)/i.test(href)) continue;
    if (/^javascript:/i.test(href)) { a.removeAttribute('href'); continue; }
    const hashAt = href.indexOf('#');
    const pathPart = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const frag = hashAt >= 0 ? decode(href.slice(hashAt + 1)) : '';
    let targetIndex = null;
    if (!pathPart) {
      targetIndex = currentIndex;
    } else {
      const resolved = resolveHref(chapterDir, pathPart).toLowerCase();
      if (hrefToIndex.has(resolved)) targetIndex = hrefToIndex.get(resolved);
    }
    if (targetIndex != null) {
      a.dataset.navChapter = String(targetIndex);
      if (frag) a.dataset.navAnchor = frag;
    } else if (!/^[a-z]+:/i.test(href)) {
      a.removeAttribute('href');
    }
  }
  // page-break markers add no value here
  doc.querySelectorAll('[epub\\:type="pagebreak"], [role="doc-pagebreak"]').forEach(n => n.remove());
}

/* ═══════════════════════════════════════════════════════════════════
   EPUB
   ═══════════════════════════════════════════════════════════════════ */

function xmlFirst(parent, localName, namespace) {
  let list = parent.getElementsByTagNameNS(namespace, localName);
  if (!list.length) list = parent.getElementsByTagName(`dc:${localName}`);
  if (!list.length) {
    list = Array.from(parent.getElementsByTagName('*')).filter(el => (el.localName || '').toLowerCase() === localName.toLowerCase());
  }
  return list[0] || null;
}

function readOpfMeta(opf) {
  const text = name => normalizedText(xmlFirst(opf, name, 'http://purl.org/dc/elements/1.1/')?.textContent || '');
  return {
    title: text('title'),
    author: text('creator'),
    language: text('language'),
    description: plainDescription(text('description')),
    publisher: text('publisher'),
    date: text('date'),
  };
}

async function loadEpubPackage(blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const index = zipIndex(zip);
  const containerFile = findZip(index, 'META-INF/container.xml');
  if (!containerFile) throw new Error('This EPUB is missing its container file — it may be corrupted.');
  const container = parseMarkup(await containerFile.async('string'), true);
  const rootfile = container.querySelector('rootfile') || container.getElementsByTagName('rootfile')[0];
  const opfPath = normPath(rootfile?.getAttribute('full-path') || '');
  if (!opfPath) throw new Error('This EPUB is missing its package file.');
  const opfFile = findZip(index, opfPath);
  if (!opfFile) throw new Error('This EPUB’s package file could not be found.');
  const opf = parseMarkup(await opfFile.async('string'), true);
  const opfDir = dirname(opfPath);

  const manifest = [];
  const byId = new Map();
  for (const item of opf.getElementsByTagName('item')) {
    const entry = {
      id: item.getAttribute('id') || '',
      href: resolveHref(opfDir, item.getAttribute('href') || ''),
      mediaType: (item.getAttribute('media-type') || '').toLowerCase(),
      properties: (item.getAttribute('properties') || '').toLowerCase(),
    };
    if (entry.href) { manifest.push(entry); byId.set(entry.id, entry); }
  }

  const spine = [];
  for (const ref of opf.getElementsByTagName('itemref')) {
    const id = ref.getAttribute('idref');
    const item = byId.get(id);
    if (item?.href) spine.push({ ...item, linear: ref.getAttribute('linear') !== 'no' });
  }

  let coverItem = null;
  for (const meta of opf.getElementsByTagName('meta')) {
    if ((meta.getAttribute('name') || '').toLowerCase() === 'cover') {
      coverItem = byId.get(meta.getAttribute('content')) || null;
      if (coverItem) break;
    }
  }
  if (!coverItem) coverItem = manifest.find(m => m.properties.split(/\s+/).includes('cover-image')) || null;
  if (!coverItem) {
    const refs = Array.from(opf.getElementsByTagName('reference'));
    const r = refs.find(x => (x.getAttribute('type') || '').toLowerCase() === 'cover');
    if (r) {
      const path = resolveHref(opfDir, r.getAttribute('href') || '');
      coverItem = manifest.find(m => m.href.toLowerCase() === path.toLowerCase()) || { href: path, mediaType: '' };
    }
  }

  const navItem = manifest.find(m => m.properties.split(/\s+/).includes('nav')) || null;
  let ncxItem = null;
  const spineEl = opf.getElementsByTagName('spine')[0];
  const tocId = spineEl?.getAttribute('toc');
  if (tocId) ncxItem = byId.get(tocId) || null;
  if (!ncxItem) ncxItem = manifest.find(m => m.mediaType === 'application/x-dtbncx+xml') || null;

  const meta = readOpfMeta(opf);
  return { zip, index, opf, opfDir, manifest, spine, coverItem, navItem, ncxItem, meta };
}

async function coverFromFile(index, item) {
  if (!item?.href) return null;
  const f = findZip(index, item.href);
  if (!f) return null;
  try {
    const ext = extOf(item.href);
    const bytes = await f.async('uint8array');
    const mime = MIME_BY_EXT[ext] || (item.mediaType === 'image/svg+xml' ? 'image/svg+xml' : 'image/jpeg');
    const blob = new Blob([bytes], { type: mime });
    return await imageToCover(blob);
  } catch {
    return null;
  }
}

async function readToc(pkg) {
  const list = [];
  const { zip, index, navItem, ncxItem } = pkg;

  if (navItem) {
    const f = findZip(index, navItem.href);
    if (f) {
      try {
        const doc = parseMarkup(await f.async('string'), true);
        const navs = Array.from(doc.getElementsByTagName('nav'));
        const tocNav = navs.find(n => ((n.getAttribute('epub:type') || n.getAttribute('type') || '').toLowerCase().includes('toc'))) || navs[0];
        if (tocNav) {
          const base = dirname(navItem.href);
          const walk = (parent, depth) => {
            if (!parent || depth > 8) return;
            for (const li of Array.from(parent.children).filter(n => n.localName?.toLowerCase() === 'li' || n.tagName === 'LI')) {
              const labelEl = Array.from(li.children).find(n => ['a', 'span'].includes((n.localName || n.tagName).toLowerCase()));
              const anchor = Array.from(li.children).find(n => (n.localName || n.tagName).toLowerCase() === 'a');
              if (labelEl) {
                const label = normalizedText(labelEl.textContent || '');
                const href = anchor?.getAttribute('href') || '';
                if (label) list.push({ label, href, base, depth });
              }
              const sub = Array.from(li.children).find(n => (n.localName || n.tagName).toLowerCase() === 'ol');
              if (sub) walk(sub, depth + 1);
            }
          };
          const ol = Array.from(tocNav.children).find(n => (n.localName || n.tagName).toLowerCase() === 'ol') || tocNav;
          walk(ol, 0);
        }
      } catch {}
    }
  }

  if (!list.length && ncxItem) {
    const f = findZip(index, ncxItem.href);
    if (f) {
      try {
        const doc = parseMarkup(await f.async('string'), true);
        const navMap = doc.getElementsByTagName('navMap')[0];
        const base = dirname(ncxItem.href);
        const walk = (parent, depth) => {
          if (!parent || depth > 8) return;
          for (const np of Array.from(parent.children).filter(n => (n.localName || '').toLowerCase() === 'navpoint')) {
            const label = normalizedText(np.getElementsByTagName('text')[0]?.textContent || '');
            const src = np.getElementsByTagName('content')[0]?.getAttribute('src') || '';
            if (label) list.push({ label, href: src, base, depth });
            walk(np, depth + 1);
          }
        };
        walk(navMap, 0);
      } catch {}
    }
  }

  return list;
}

async function probeEpub(file) {
  const pkg = await loadEpubPackage(file);
  let cover = await coverFromFile(pkg.index, pkg.coverItem);
  if (!cover) {
    // look for a sensible image near the start of the archive
    const imgs = [];
    pkg.index.forEach((entry, path) => {
      if (/\.(jpe?g|png|webp|gif)$/i.test(path) && !path.includes('__MACOSX')) imgs.push(entry);
    });
    const pick = imgs.find(f => /cover/i.test(f.name)) || imgs[0];
    if (pick) {
      try { cover = await imageToCover(new Blob([await pick.async('uint8array')], { type: MIME_BY_EXT[extOf(pick.name)] || 'image/jpeg' })); } catch {}
    }
  }
  return { ...pkg.meta, cover, meta: { chapterCount: pkg.spine.length } };
}

async function buildEpub(record, blob) {
  const pkg = await loadEpubPackage(blob);
  const { zip, index, spine, meta } = pkg;
  const imageCache = new Map();
  const objectUrls = new Set();
  const skippedChapters = [];

  const parsed = [];
  for (let i = 0; i < spine.length; i++) {
    const item = spine[i];
    if (!item.mediaType.includes('html') && !item.mediaType.includes('xml') && !/\.x?html?$/i.test(item.href)) continue;
    const f = findZip(index, item.href);
    if (!f) continue;
    let doc;
    try { doc = parseMarkup(await f.async('string'), true); } catch { continue; }
    if (!doc?.body) continue;
    sanitizeDocument(doc);

    const chapterDir = dirname(item.href);

    // inline images → object URLs
    const imgs = Array.from(doc.querySelectorAll('img[src], image'));
    await Promise.all(imgs.map(async img => {
      const attr = img.tagName.toLowerCase() === 'image'
        ? (img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '')
        : img.getAttribute('src');
      if (!attr || /^(https?:|data:|blob:)/i.test(attr)) return;
      const path = resolveHref(chapterDir, attr);
      let url = imageCache.get(path.toLowerCase());
      if (!url) {
        const imgFile = findZip(index, path);
        if (!imgFile) { img.remove(); return; }
        try {
          const bytes = await imgFile.async('uint8array');
          const mime = MIME_BY_EXT[extOf(path)] || 'image/jpeg';
          url = URL.createObjectURL(new Blob([bytes], { type: mime }));
          imageCache.set(path.toLowerCase(), url);
          objectUrls.add(url);
        } catch { img.remove(); return; }
      }
      if (img.tagName.toLowerCase() === 'image') {
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
        img.setAttribute('href', url);
      } else {
        img.setAttribute('src', url);
        img.setAttribute('loading', 'eager');
        img.setAttribute('decoding', 'async');
        img.removeAttribute('srcset');
      }
    }));

    const body = doc.body;
    const text = normalizedText(body.textContent || '');
    const hasMedia = !!body.querySelector('img,svg,image');
    const words = countWords(text);

    parsed.push({
      spineIndex: parsed.length,
      href: item.href,
      chapterDir,
      doc,
      body,
      text,
      words,
      hasMedia,
      keep: words >= 3 || hasMedia,
    });
  }

  // Map archive paths → final chapter indices (empty pages point to a neighbour)
  const kept = parsed.filter(p => p.keep);
  const keptIds = new Map();
  kept.forEach((p, i) => keptIds.set(p.spineIndex, i));
  const hrefToIndex = new Map();
  let lastKept = 0;
  parsed.forEach((p, i) => {
    if (keptIds.has(i)) lastKept = keptIds.get(i);
    else p.fallbackIndex = lastKept;
  });
  parsed.forEach(p => {
    if (!p.href) return;
    const target = p.keep ? keptIds.get(p.spineIndex) : p.fallbackIndex;
    hrefToIndex.set(p.href.toLowerCase(), target ?? 0);
  });

  // TOC
  const rawToc = await readToc(pkg);
  const toc = [];
  const labelForChapter = new Map();
  for (const item of rawToc) {
    if (!item.href) continue;
    const resolved = resolveHref(item.base, item.href.split('#')[0]).toLowerCase();
    const idx = hrefToIndex.get(resolved);
    if (idx == null) continue;
    const hashAt = item.href.indexOf('#');
    const anchor = hashAt >= 0 ? decode(item.href.slice(hashAt + 1)) : '';
    toc.push({ label: item.label, chapterIndex: idx, anchor, depth: Math.min(item.depth || 0, 3) });
    if (!labelForChapter.has(idx) && !anchor) labelForChapter.set(idx, item.label);
  }

  const chapters = kept.map((p, i) => {
    rewriteLinks(p.doc, p.chapterDir, i, hrefToIndex);
    const html = p.body ? p.body.innerHTML.trim() : '';
    const label = labelForChapter.get(i) || chapterLabel(p.body) || labelFromHref(p.href) || `Chapter ${i + 1}`;
    return { index: i, label, html, href: p.href, words: p.words, anchorIds: [] };
  });

  // ensure every chapter appears in the TOC even if the book's nav skipped it
  const tocChapters = new Set(toc.map(t => t.chapterIndex));
  chapters.forEach((ch, i) => {
    if (!tocChapters.has(i)) toc.push({ label: ch.label, chapterIndex: i, anchor: '', depth: 0, generated: true });
  });
  toc.sort((a, b) => a.chapterIndex - b.chapterIndex || (a.anchor ? 1 : 0) - (b.anchor ? 1 : 0));

  const words = chapters.reduce((n, c) => n + c.words, 0);
  return {
    format: 'epub',
    title: meta.title || record.title,
    author: meta.author || record.author,
    description: meta.description || record.description || '',
    language: meta.language || record.language || 'en',
    chapters,
    toc,
    words,
    cover: record.cover || null,
    dispose() {
      objectUrls.forEach(u => URL.revokeObjectURL(u));
      objectUrls.clear();
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════
   DOCX
   ═══════════════════════════════════════════════════════════════════ */

async function readDocxCore(file) {
  const out = {};
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const coreFile = zip.file('docProps/core.xml');
    if (coreFile) {
      const doc = parseMarkup(await coreFile.async('string'), true);
      const get = localName => normalizedText(
        Array.from(doc.getElementsByTagName('*')).find(n => (n.localName || '').toLowerCase() === localName)?.textContent || ''
      );
      out.title = get('title');
      out.author = get('creator');
      out.description = plainDescription(get('description') || get('subject'));
    }
    const media = Object.keys(zip.files)
      .filter(p => /^word\/media\/[^/]+\.(jpe?g|png|gif|webp|bmp)$/i.test(p))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (media.length) {
      const f = zip.file(media[0]);
      const bytes = await f.async('uint8array');
      out.cover = await imageToCover(new Blob([bytes], { type: MIME_BY_EXT[extOf(media[0])] || 'image/jpeg' }));
    }
  } catch {}
  return out;
}

async function probeDocx(file) {
  const core = await readDocxCore(file);
  return {
    title: core.title, author: core.author, cover: core.cover,
    description: core.description, language: 'en', meta: {},
  };
}

async function buildDocx(record, blob) {
  if (!window.mammoth) throw new Error('The Word document reader failed to load. Reload the page and try again.');
  const result = await mammoth.convertToHtml(
    { arrayBuffer: await blob.arrayBuffer() },
    {
      styleMap: [
        "p[style-name='Title'] => h1.doc-title:fresh",
        "p[style-name='Subtitle'] => p.doc-subtitle:fresh",
      ],
      convertImage: mammoth.images.imgElement(image => image.read('base64').then(b64 => ({
        src: `data:${image.contentType};base64,${b64}`,
        alt: image.alt || '',
      }))),
    }
  );
  const sanitized = sanitizeHtmlString(result.value || '');
  const doc = document.createElement('div');
  doc.innerHTML = sanitized;
  const { chapters, toc } = chapterize(doc, {
    splitLevels: ['h1'],
    fallbackLevels: ['h2'],
    defaultLabelPrefix: 'Part',
    maxChunkChars: 15000,
  });
  return {
    format: 'docx',
    title: record.title,
    author: record.author,
    description: record.description || '',
    language: record.language || 'en',
    chapters,
    toc,
    words: chapters.reduce((n, c) => n + c.words, 0),
    cover: record.cover || null,
    dispose() {},
  };
}

/* ═══════════════════════════════════════════════════════════════════
   TXT / Markdown
   ═══════════════════════════════════════════════════════════════════ */

async function probeText(file, format) {
  const raw = await file.slice(0, 8192).text().catch(() => '');
  let title = '';
  if (format === 'md') {
    const m = raw.match(/^\s*#\s+(.+)$/m);
    if (m) title = normalizedText(m[1]);
  }
  return { title, author: '', cover: null, description: '', language: 'en', meta: {} };
}

async function buildText(record, blob) {
  const buffer = await blob.arrayBuffer();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Fall back for older, non-UTF-8 plain-text books.
    text = new TextDecoder('windows-1252').decode(buffer);
  }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let html;
  if (record.format === 'md') html = markdownToHtml(text);
  else html = plainTextToHtml(text);

  const doc = document.createElement('div');
  doc.innerHTML = html;
  const { chapters, toc } = chapterize(doc, {
    splitLevels: ['h1'],
    fallbackLevels: ['h2'],
    defaultLabelPrefix: 'Part',
    maxChunkChars: 16000,
    preferLargest: true,
  });
  return {
    format: record.format,
    title: record.title,
    author: record.author,
    description: record.description || '',
    language: record.language || 'en',
    chapters,
    toc,
    words: chapters.reduce((n, c) => n + c.words, 0),
    cover: record.cover || null,
    dispose() {},
  };
}

/* Plain text → paragraphs. Detects chapter-like lines as h2. */
function plainTextToHtml(text) {
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = [];
  const isHeading = line => {
    const t = line.trim();
    if (!t || t.length > 90) return false;
    if (/^(chapter|part|book|section|prologue|epilogue|introduction|preface|afterword|appendix)\b[\s.:\-–—]*([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)?\b/i.test(t)) return true;
    if (/^[A-Z0-9][A-Z0-9\s'’\-–—:.,!?&]+$/.test(t) && t.length >= 3 && t.length <= 60 && /[A-Z]/.test(t)) return true;
    if (/^[*\-–—_=]{3,}$/.test(t)) return false;
    return false;
  };
  for (const block of paragraphs) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.length === 1 && isHeading(lines[0])) {
      out.push(`<h2>${esc(lines[0])}</h2>`);
    } else if (/^[*\-–—_=]{3,}$/.test(lines[0]) && lines.length === 1) {
      out.push('<hr>');
    } else {
      const joined = lines.join(' ');
      out.push(`<p>${esc(joined)}</p>`);
    }
  }
  return out.join('\n');
}

function inlineMarkdown(text) {
  let s = esc(text);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt) => `<em>${alt || ''}</em>`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, (m, label, href) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

function markdownToHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${inlineMarkdown(para.join(' '))}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      flush();
      const lang = line.trim().slice(3);
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code data-lang="${esc(lang)}">${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flush();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inlineMarkdown(h[2].trim())}</h${lvl}>`);
      i++; continue;
    }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote><p>${inlineMarkdown(quote.join(' '))}</p></blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      out.push(`<ul>${items.map(x => `<li>${inlineMarkdown(x)}</li>`).join('')}</ul>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ol) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      out.push(`<ol>${items.map(x => `<li>${inlineMarkdown(x)}</li>`).join('')}</ol>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}

function sanitizeHtmlString(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  sanitizeDocument(doc);
  return doc.body.innerHTML;
}

/* ═══════════════════════════════════════════════════════════════════
   Chapterization for DOCX / TXT / MD
   ═══════════════════════════════════════════════════════════════════ */

function chapterize(container, {
  splitLevels = ['h1'],
  fallbackLevels = ['h2'],
  defaultLabelPrefix = 'Part',
  maxChunkChars = 15000,
  preferLargest = false,
} = {}) {
  const nodes = Array.from(container.children);
  if (!nodes.length) return { chapters: [], toc: [] };

  // stable ids for every heading so we can build a nested contents list
  let headingCounter = 0;
  const headings = nodes.filter(n => /^H[1-4]$/.test(n.tagName));
  for (const h of headings) {
    if (!h.id) h.id = `lumen-h-${headingCounter++}`;
  }

  let splitTag = null;
  const countFor = levels => nodes.filter(n => levels.includes(n.tagName.toLowerCase())).length;
  if (countFor(splitLevels) >= 2) splitTag = splitLevels.map(s => s.toUpperCase());
  else if (countFor(fallbackLevels) >= 2) splitTag = fallbackLevels.map(s => s.toUpperCase());
  else if (countFor(splitLevels) === 1 && !preferLargest) splitTag = splitLevels.map(s => s.toUpperCase());

  let sections = [];
  if (splitTag) {
    let current = { nodes: [], headingEl: null };
    const hasContent = s => s.nodes.some(n => !/^H[1-4]$/.test(n.tagName) || normalizedText(n.textContent));
    for (const node of nodes) {
      const isSplit = splitTag.includes(node.tagName);
      if (isSplit && hasContent(current)) {
        sections.push(current);
        current = { nodes: [node], headingEl: node };
      } else {
        if (isSplit && !current.headingEl) current.headingEl = node;
        current.nodes.push(node);
      }
    }
    if (hasContent(current)) sections.push(current);
    // merge tiny front-matter section into the first real one
    if (sections.length > 1) {
      const first = sections[0];
      const textLen = first.nodes.reduce((n, x) => n + (x.textContent || '').length, 0);
      if (textLen < 500 && !first.headingEl) {
        sections[1].nodes = [...first.nodes, ...sections[1].nodes];
        sections.shift();
      }
    }
  } else {
    sections = [{ nodes, headingEl: null }];
  }

  // chunk sections that are too long (at block boundaries)
  const chunked = [];
  for (const sec of sections) {
    let buf = [];
    let chars = 0;
    const pushChunk = () => {
      if (!buf.length) return;
      chunked.push({ nodes: buf, headingEl: sec.headingEl && buf[0] === sec.headingEl ? sec.headingEl : null });
      buf = []; chars = 0;
    };
    for (const node of sec.nodes) {
      const len = (node.textContent || '').length + (node.querySelectorAll?.('img').length || 0) * 80;
      if (chars + len > maxChunkChars && buf.length > 1 && node.tagName !== 'H1' && node.tagName !== 'H2') {
        pushChunk();
      }
      buf.push(node);
      chars += len;
    }
    pushChunk();
  }

  const chapters = [];
  const toc = [];
  let partNo = 1;
  for (const sec of chunked) {
    const wrap = document.createElement('div');
    sec.nodes.forEach(n => wrap.appendChild(n.cloneNode(true)));
    const firstHeading = wrap.querySelector('h1,h2,h3');
    let label = normalizedText(firstHeading?.textContent || '');
    if (!label) label = `${defaultLabelPrefix} ${partNo++}`;
    else if (label.length > 90) label = label.slice(0, 87) + '…';

    const words = countWords(wrap.textContent || '');
    const index = chapters.length;
    const anchorIds = Array.from(wrap.querySelectorAll('h2,h3,h4')).map(h => h.id).filter(Boolean);

    chapters.push({
      index,
      label,
      html: wrap.innerHTML,
      href: null,
      words,
      anchorIds,
    });

    toc.push({ label, chapterIndex: index, anchor: '', depth: 0, generated: true });
    const chapterHeading = wrap.querySelector('h1,h2,h3,h4');
    for (const h of Array.from(wrap.querySelectorAll('h2,h3,h4'))) {
      if (h === chapterHeading) continue;
      const t = normalizedText(h.textContent || '');
      if (!t) continue;
      const lvl = Number(h.tagName[1]) - 2;
      toc.push({ label: t, chapterIndex: index, anchor: h.id, depth: Math.min(1 + lvl, 3) });
    }
  }

  return { chapters, toc };
}

/* ═══════════════════════════════════════════════════════════════════
   Comic archives (CBZ / CBR)
   ═══════════════════════════════════════════════════════════════════ */

const COMIC_IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
const comicCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function comicMime(name = '') {
  const ext = extOf(name);
  return MIME_BY_EXT[ext] || (ext === 'avif' ? 'image/avif' : 'image/jpeg');
}

function isComicImage(path = '') {
  if (!COMIC_IMAGE_RE.test(path)) return false;
  const segments = path.split('/');
  if (segments.some(s => s.startsWith('.') || s.toLowerCase() === '__macosx')) return false;
  return true;
}

function listComicPages(entries) {
  return entries
    .filter(e => isComicImage(e.path))
    .sort((a, b) => comicCollator.compare(a.path, b.path))
    .map(e => ({ ...e, name: e.path.split('/').pop() || e.path }));
}

function parseComicInfo(text = '') {
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return {};
    const get = tag => normalizedText(doc.getElementsByTagName(tag)[0]?.textContent || '');
    return {
      series: get('Series'),
      title: get('Title'),
      number: get('Number'),
      writer: get('Writer'),
      penciller: get('Penciller'),
      artist: get('Artist'),
      publisher: get('Publisher'),
      summary: get('Summary'),
      year: get('Year'),
      genre: get('Genre'),
      languageISO: get('LanguageISO'),
    };
  } catch {
    return {};
  }
}

function comicMeta(info, fileName) {
  const series = info.series || '';
  const number = info.number || '';
  let title = series ? `${series}${number ? ` #${number}` : ''}` : '';
  if (info.title && info.title.toLowerCase() !== series.toLowerCase()) {
    title = title ? `${title}: ${info.title}` : info.title;
  }
  if (!title) title = titleFromFilename(fileName);
  return {
    title,
    author: info.writer || info.penciller || info.artist || info.publisher || '',
    description: plainDescription(info.summary || ''),
    language: info.languageISO || 'en',
  };
}

let libarchivePromise = null;
function getLibarchive() {
  if (!libarchivePromise) {
    libarchivePromise = import('../vendor/libarchive/libarchive.js')
      .then(mod => {
        mod.Archive.init({
          workerUrl: new URL('../vendor/libarchive/worker-bundle.js', import.meta.url).href,
        });
        return mod;
      })
      .catch(err => {
        libarchivePromise = null;
        console.error('libarchive load failed', err);
        throw new Error('The CBR reader could not be loaded. Try converting the file to CBZ.');
      });
  }
  return libarchivePromise;
}

async function openCbrArchive(blob) {
  const { Archive } = await getLibarchive();
  let archive = null;
  try {
    archive = await Archive.open(blob);
    if (await archive.hasEncryptedData()) {
      throw new Error('Password-protected comic archives aren’t supported yet.');
    }
    const list = await archive.getFilesArray();
    const entries = list.map(({ file, path }) => {
      const full = `${path || ''}${file.name || ''}`;
      return { path: full, name: file.name, entry: file };
    }).filter(e => e.entry && typeof e.entry.extract === 'function');
    if (!entries.length) throw new Error('This comic archive appears to be empty.');
    return { archive, entries };
  } catch (err) {
    try { await archive?.close?.(); } catch {}
    if (/password|encrypt/i.test(err.message || '')) throw err;
    if (err.message?.includes('comic archive')) throw err;
    throw new Error('This CBR couldn’t be opened. It may be damaged, or use an unsupported RAR variant. Try converting it to CBZ.');
  }
}

async function probeComic(file, format) {
  if (format === 'cbr') {
    const { archive, entries } = await openCbrArchive(file);
    try {
      const pages = listComicPages(entries);
      if (!pages.length) throw new Error('This comic archive doesn’t contain any page images.');
      let info = {};
      const infoEntry = entries.find(e => /comicinfo\.xml$/i.test(e.name || e.path || ''));
      if (infoEntry) {
        try {
          const f = await infoEntry.entry.extract();
          info = parseComicInfo(await f.text());
        } catch {}
      }
      const first = await pages[0].entry.extract();
      const coverBlob = first.type ? first : new Blob([first], { type: comicMime(pages[0].path) });
      const cover = await imageToCover(coverBlob);
      return {
        ...comicMeta(info, file.name),
        cover,
        format: 'cbr',
        meta: { pageCount: pages.length, comic: true },
      };
    } finally {
      try { await archive.close(); } catch {}
    }
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = [];
  zip.forEach((path, entry) => {
    if (!entry.dir) entries.push({ path, name: path.split('/').pop(), entry });
  });
  const pages = listComicPages(entries);
  if (!pages.length) throw new Error('This comic archive doesn’t contain any page images.');
  let info = {};
  const infoEntry = entries.find(e => /^comicinfo\.xml$/i.test(e.name || ''));
  if (infoEntry) {
    try { info = parseComicInfo(await infoEntry.entry.async('string')); } catch {}
  }
  const bytes = await pages[0].entry.async('uint8array');
  const cover = await imageToCover(new Blob([bytes], { type: comicMime(pages[0].path) }));
  return {
    ...comicMeta(info, file.name),
    cover,
    format: 'cbz',
    meta: { pageCount: pages.length, comic: true },
  };
}

async function buildCbz(record, blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const entries = [];
  zip.forEach((path, entry) => {
    if (!entry.dir) entries.push({ path, name: path.split('/').pop(), entry });
  });
  const pages = listComicPages(entries);
  if (!pages.length) throw new Error('This comic archive doesn’t contain any page images.');

  return {
    format: 'cbz',
    title: record.title,
    author: record.author,
    description: record.description || '',
    cover: record.cover || null,
    pageCount: pages.length,
    pages: pages.map(p => ({ name: p.name, path: p.path })),
    async getPageBlob(index) {
      const page = pages[index];
      if (!page) throw new Error('That page is missing from the archive.');
      const bytes = await page.entry.async('uint8array');
      return new Blob([bytes], { type: comicMime(page.path) });
    },
    dispose() { /* JSZip is released with this object */ },
  };
}

async function buildCbr(record, blob) {
  const { archive, entries } = await openCbrArchive(blob);
  const pages = listComicPages(entries);
  if (!pages.length) {
    try { await archive.close(); } catch {}
    throw new Error('This comic archive doesn’t contain any page images.');
  }

  return {
    format: 'cbr',
    title: record.title,
    author: record.author,
    description: record.description || '',
    cover: record.cover || null,
    pageCount: pages.length,
    pages: pages.map(p => ({ name: p.name, path: p.path })),
    async getPageBlob(index) {
      const page = pages[index];
      if (!page) throw new Error('That page is missing from the archive.');
      const f = await page.entry.extract();
      return f.type ? f : new Blob([f], { type: comicMime(page.path) });
    },
    dispose() { archive.close().catch(() => {}); },
  };
}

/* ═══════════════════════════════════════════════════════════════════
   PDF metadata / cover thumbnail
   ═══════════════════════════════════════════════════════════════════ */

async function probePdf(file) {
  const fallback = { title: '', author: '', cover: null, description: '', language: 'en', meta: { needsPassword: false } };
  let loading = null;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    loading = pdfjsLib.getDocument({
      data,
      isEvalSupported: false,
      standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
    });
    const pdf = await loading.promise;
    let title = '';
    let author = '';
    try {
      const meta = await pdf.getMetadata();
      const info = meta?.info || {};
      title = normalizedText(info.Title || '');
      author = normalizedText(info.Author || '');
      if (/^(untitled|microsoft word|document\d*|book\d*)$/i.test(title)) title = '';
      if (/^(administrator|user|owner|microsoft|unknown)$/i.test(author)) author = '';
    } catch {}
    let cover = null;
    try {
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 640 / base.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fffdf7';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await withTimeout(page.render({ canvasContext: ctx, viewport }).promise, 2500);
      cover = canvas.toDataURL('image/jpeg', 0.8);
      page.cleanup();
    } catch {}
    const numPages = pdf.numPages;
    await pdf.destroy();
    return { ...fallback, title, author, cover, meta: { numPages, needsPassword: false } };
  } catch (err) {
    try { loading?.destroy?.(); } catch {}
    const isPassword = err?.name === 'PasswordException' || /password/i.test(err?.message || '');
    if (isPassword) {
      return { ...fallback, meta: { needsPassword: true } };
    }
    throw new Error('This PDF could not be opened — it may be damaged or use an unsupported format.');
  }
}

export { resolveHref, normPath, dirname, parseMarkup, sanitizeDocument, chapterize, labelFromHref };
