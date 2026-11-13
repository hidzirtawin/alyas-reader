/* Offline dictionary: Webster's Unabridged 1913 (public domain).
   The gzipped dataset ships with the app, so lookups work without a network.
   Source: github.com/matthewreagan/WebstersEnglishDictionary */

import { modal } from './ui.js?v=202611130021-13b8353';
import { esc, icon } from './util.js?v=202611130021-13b8353';
import { baseLanguage, languageName } from './language.js?v=202611130021-13b8353';

const SOURCE = new URL('../vendor/dictionary/webster.json.gz', import.meta.url);
const DB_NAME = 'alya-dictionary';
const DB_VERSION = 1;
const KEY = 'webster-gz';

let memory = null;
let loadPromise = null;
let currentModal = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('files')) {
        req.result.createObjectStore('files', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readCached() {
  try {
    const db = await openDb();
    return await new Promise(resolve => {
      const req = db.transaction('files').objectStore('files').get(KEY);
      req.onsuccess = () => resolve(req.result?.blob || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function writeCached(blob) {
  try {
    const db = await openDb();
    await new Promise(resolve => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ id: KEY, blob, savedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {}
}

async function fetchSource(onProgress) {
  const res = await fetch(SOURCE, { cache: 'force-cache' });
  if (!res.ok) throw new Error('dictionary-missing');
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body?.getReader) {
    const blob = await res.blob();
    onProgress?.(blob.size, blob.size);
    return blob;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let tick = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = performance.now();
    if (now - tick > 120) {
      tick = now;
      onProgress?.(loaded, total);
    }
  }
  onProgress?.(loaded, total || loaded);
  return new Blob(chunks, { type: 'application/gzip' });
}

async function loadDictionary(onProgress) {
  if (memory) return memory;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let blob = await readCached();
    if (!blob) {
      blob = await fetchSource(onProgress);
      writeCached(blob).catch(() => {});
    }
    if (typeof DecompressionStream === 'undefined') throw new Error('no-decompression');
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    memory = JSON.parse(text);
    return memory;
  })().catch(err => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

function cleanWord(input) {
  const match = String(input || '').match(/[A-Za-z][A-Za-z'’-]*/);
  return match ? match[0].replace(/’/g, "'").toLowerCase() : '';
}

function variants(word) {
  const out = [word];
  const rules = [
    [/’s$|'s$/, ''],
    [/ies$/, 'y'],
    [/ves$/, 'f'],
    [/ied$/, 'y'],
    [/ing$/, ''],
    [/ing$/, 'e'],
    [/ed$/, ''],
    [/ed$/, 'e'],
    [/es$/, ''],
    [/s$/, ''],
    [/ly$/, ''],
    [/er$/, ''],
    [/est$/, ''],
  ];
  for (const [re, replacement] of rules) {
    if (re.test(word)) out.push(word.replace(re, replacement));
  }
  return [...new Set(out.filter(Boolean))];
}

function findEntry(dict, word) {
  for (const candidate of variants(word)) {
    if (dict[candidate]) return { key: candidate, definition: dict[candidate] };
  }
  return null;
}

function suggestions(dict, word) {
  const out = [];
  for (const key of Object.keys(dict)) {
    if (key.startsWith(word)) out.push(key);
    if (out.length >= 8) break;
  }
  return out;
}

function definitionHtml(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map(part => `<p>${part.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function openDictionary(rawWord, language = 'en') {
  const word = cleanWord(rawWord);
  if (!word) return;
  const lang = baseLanguage(language) || 'en';
  const wiktionary = `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(word)}`;
  const webster = `https://www.merriam-webster.com/dictionary/${encodeURIComponent(word)}`;
  currentModal?.close?.('replace');

  const body = document.createElement('div');
  body.className = 'dict';
  body.innerHTML = `
    <div class="dict-loading">
      <div class="spinner" style="border-color:var(--line);border-top-color:var(--accent)"></div>
      <div id="dictStatus">Looking up “${esc(word)}”…</div>
      <div class="dict-track" id="dictTrack" hidden><i id="dictFill"></i></div>
      <div class="dict-hint">The dictionary is stored on your device — no network needed after the first load.</div>
    </div>`;

  const m = modal({
    eyebrow: 'Dictionary',
    title: word,
    subtitle: 'Webster’s Unabridged 1913 · public domain',
    body,
    foot: `<div style="display:flex;gap:8px;flex-wrap:wrap;width:100%">
      <a class="btn btn-sm" href="${wiktionary}" target="_blank" rel="noopener noreferrer">${icon('arrow-right')} Wiktionary${lang === 'en' ? '' : ` (${esc(languageName(lang))})`}</a>
      ${lang === 'en' ? '' : `<a class="btn btn-sm" href="${webster}" target="_blank" rel="noopener noreferrer">Merriam-Webster</a>`}
    </div>`,
    onClose: () => { if (currentModal === m) currentModal = null; },
  });
  currentModal = m;

  const status = body.querySelector('#dictStatus');
  const track = body.querySelector('#dictTrack');
  const fill = body.querySelector('#dictFill');

  loadDictionary((loaded, total) => {
    if (currentModal !== m) return;
    const pct = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
    if (status) status.textContent = pct ? `Loading dictionary · ${pct}%` : 'Loading dictionary…';
    if (track) track.hidden = false;
    if (fill) fill.style.width = `${pct}%`;
  }).then(dict => {
    if (currentModal !== m) return;
    const hit = findEntry(dict, word);
    if (hit) {
      body.innerHTML = `<div class="dict-entry">${definitionHtml(hit.definition)}</div>
        <div class="dict-source">Webster’s 1913 · headword “${esc(hit.key)}”${lang === 'en' ? '' : ` · English definition for a ${esc(languageName(lang))} book`}</div>`;
      return;
    }
    const near = suggestions(dict, word);
    body.innerHTML = `
      <p class="dict-none">No Webster’s 1913 entry for <strong>${esc(word)}</strong>.</p>
      ${near.length ? `<div class="dict-suggest-label">Did you mean</div>
        <div class="dict-suggest">${near.map(s => `<button type="button" data-dict-word="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
      <p class="dict-hint">Try the Merriam-Webster link below for a modern definition.</p>`;
    body.querySelectorAll('[data-dict-word]').forEach(btn => {
      btn.addEventListener('click', () => openDictionary(btn.dataset.dictWord, lang));
    });
  }).catch(err => {
    if (currentModal !== m) return;
    console.warn('Dictionary load failed', err);
    body.innerHTML = `<p class="dict-none">The offline dictionary could not be opened.</p>
      <p class="dict-hint">Use the Merriam-Webster link below to look up “${esc(word)}”.</p>`;
  });
}
