/* Narration engine.
   - piper: free, offline neural voices running in this browser
   - system: the operating system's installed voices
   - narration can be disabled entirely in preferences. */

import { getPrefs, setTtsPrefs } from './prefs.js';
import { splitLongText } from './util.js';

const PREFERRED = [
  'samantha', 'ava', 'serena', 'daniel', 'karen', 'moira', 'tessa', 'alex',
  'google us english', 'google uk english female', 'aria', 'jenny', 'guy', 'sonia',
];

/* ── System voices ───────────────────────────────────────────────── */
export function englishVoices() {
  if (!('speechSynthesis' in window)) return [];
  let voices = [];
  try { voices = speechSynthesis.getVoices() || []; } catch {}
  return voices
    .filter(v => /^en([-_]|$)/i.test(v.lang || ''))
    .map(v => {
      const name = v.name || '';
      let score = 0;
      if (/^en[-_]US/i.test(v.lang)) score += 4;
      else if (/^en[-_]GB/i.test(v.lang)) score += 3;
      else score += 2;
      if (/natural|premium|enhanced|neural/i.test(name)) score += 8;
      if (PREFERRED.some(p => name.toLowerCase().includes(p))) score += 5;
      if (v.localService) score += 1;
      if (/compact|eloquence/i.test(name)) score -= 2;
      return { voice: v, score };
    })
    .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name))
    .map(x => x.voice);
}

export function findVoice(uri) {
  if (!uri) return null;
  const all = (() => { try { return speechSynthesis.getVoices() || []; } catch { return []; } })();
  return all.find(v => v.voiceURI === uri) || null;
}

export function defaultVoiceURI() {
  return englishVoices()[0]?.voiceURI || '';
}

/* ── Piper voices ───────────────────────────────────────────────── */
/* Single-speaker English voices from rhasspy/piper-voices.
   Names describe tone and accent; these are not celebrity voices. */
/* Full Piper catalog: 178 official voices plus the Australian community model.
   The catalog is served locally; only the voice model is fetched from Hugging Face. */
const FALLBACK_PIPER = [{
  id: 'en_US-lessac-medium', name: 'Lessac', lang: 'en_US', language: 'English',
  country: 'United States', quality: 'medium', num_speakers: 1, speaker_id_map: {},
  size_bytes: 63201294,
  modelUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
  configUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json',
  accent: 'American', sizeMB: 60, community: false,
}];

let piperVoices = [];
let piperCatalogPromise = null;

export function getPiperVoices() {
  return piperVoices.length ? piperVoices : FALLBACK_PIPER;
}

export function loadPiperCatalog() {
  if (piperCatalogPromise) return piperCatalogPromise;
  const build = document.querySelector('meta[name="app-build"]')?.content || 'dev';
  piperCatalogPromise = fetch(new URL(`../vendor/piper/voices.json?v=${build}`, import.meta.url), { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('catalog missing')))
    .then(async data => {
      const list = Array.isArray(data) ? data : data.voices || [];
      piperVoices = list.map(v => ({
        ...v,
        accent: v.accent || (
          v.lang === 'en_US' ? 'American'
            : v.lang === 'en_GB' ? 'British'
              : v.lang === 'en_AU' ? 'Australian'
                : (v.country || v.language || 'World')
        ),
        sizeMB: Math.max(1, Math.round((v.size_bytes || 0) / 1048576)),
      }));
      await loadCustomVoices();
      return piperVoices;
    })
    .catch(async err => {
      console.warn('Piper catalog could not be loaded', err);
      piperVoices = FALLBACK_PIPER;
      await loadCustomVoices();
      return piperVoices;
    });
  return piperCatalogPromise;
}

export function piperVoiceById(id) {
  const list = getPiperVoices();
  return list.find(v => v.id === id) || list[0];
}

async function allVoiceRecords() {
  try {
    const db = await piperDb();
    if (!db) return [];
    return await new Promise(resolve => {
      try {
        const req = db.transaction('voices').objectStore('voices').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
  } catch { return []; }
}

async function loadCustomVoices() {
  const records = (await allVoiceRecords()).filter(rec => rec.custom);
  const customs = records.map(rec => ({
    id: rec.id,
    name: rec.name || 'Imported voice',
    lang: rec.lang || '',
    language: rec.language || 'Imported',
    country: rec.country || 'Imported',
    quality: 'custom',
    num_speakers: Number(rec.num_speakers) || 1,
    speaker_id_map: rec.speaker_id_map || {},
    size_bytes: rec.blob?.size || 0,
    sizeMB: Math.max(1, Math.round((rec.blob?.size || 0) / 1048576)),
    modelUrl: rec.id,
    configUrl: rec.id,
    custom: true,
    community: false,
  }));
  piperVoices = piperVoices.filter(v => !v.custom).concat(customs);
}

/* Import a Piper-compatible .onnx + .onnx.json (or a zip) from this device. */
export async function importCustomVoice(files = []) {
  const chosen = Array.from(files);
  if (!chosen.length) throw new Error('Choose a .onnx model and its .onnx.json config.');
  let modelFile = chosen.find(f => /\.onnx$/i.test(f.name));
  let configFile = chosen.find(f => /\.onnx\.json$/i.test(f.name) || /\.json$/i.test(f.name));
  const zipFile = chosen.find(f => /\.zip$/i.test(f.name));
  if (zipFile && window.JSZip) {
    const archive = await window.JSZip.loadAsync(await zipFile.arrayBuffer());
    const entries = Object.values(archive.files).filter(entry => !entry.dir);
    const modelEntry = entries.find(entry => /\.onnx$/i.test(entry.name));
    const configEntry = entries.find(entry => /\.onnx\.json$/i.test(entry.name));
    if (modelEntry) {
      const bytes = await modelEntry.async('uint8array');
      modelFile = new File([bytes], modelEntry.name.split('/').pop(), { type: 'application/octet-stream' });
    }
    if (configEntry) {
      configFile = new File([await configEntry.async('string')], configEntry.name.split('/').pop(), { type: 'application/json' });
    }
  }
  if (!modelFile || !configFile) throw new Error('Include both the .onnx model and its .onnx.json config.');
  let config;
  try { config = JSON.parse(await configFile.text()); }
  catch { throw new Error('That voice config is not valid JSON.'); }
  if (!config?.audio?.sample_rate) throw new Error('That config does not look like a Piper voice.');

  const stem = modelFile.name.replace(/\.onnx$/i, '');
  const match = stem.match(/^([a-z]{2,3})[_-]([A-Z]{2})/);
  const lang = match ? `${match[1]}_${match[2]}` : 'und';
  let language = 'Imported';
  try {
    language = new Intl.DisplayNames(['en'], { type: 'language' }).of(match ? match[1] : 'und') || 'Imported';
  } catch {}
  const pretty = stem
    .replace(/^[a-z]{2,3}[_-][A-Z]{2}-/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
  const id = `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const record = {
    id,
    custom: true,
    name: pretty || 'Imported voice',
    lang,
    language,
    country: 'Imported',
    num_speakers: Number(config.num_speakers) || 1,
    speaker_id_map: config.speaker_id_map || {},
    config,
    blob: modelFile,
    savedAt: Date.now(),
  };
  const db = await piperDb();
  if (!db) throw new Error('Browser storage is unavailable.');
  await new Promise((resolve, reject) => {
    const tx = db.transaction('voices', 'readwrite');
    tx.objectStore('voices').put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Could not save the voice.'));
  });
  await loadCustomVoices();
  return piperVoiceById(id);
}

export async function removeCustomVoice(id) {
  await deleteCachedVoice(id);
  piperVoices = piperVoices.filter(v => v.id !== id);
}

/* ── Piper progress ───────────────────────────────────────────────── */
/* Phases: idle | checking | downloading | preparing | generating | ready */
let piperProgress = {
  phase: 'idle', voiceId: '', voiceName: '', loaded: 0, total: 0, percent: 0, cached: false,
};
const piperProgressListeners = new Set();

export function getPiperProgress() {
  return piperProgress;
}

export function onPiperProgress(fn) {
  if (typeof fn !== 'function') return () => {};
  piperProgressListeners.add(fn);
  try { fn(piperProgress); } catch {}
  return () => piperProgressListeners.delete(fn);
}

let piperActivityAt = Date.now();

function notePiperActivity() { piperActivityAt = Date.now(); }

function emitPiperProgress(patch = {}) {
  notePiperActivity();
  piperProgress = { ...piperProgress, ...patch };
  for (const fn of piperProgressListeners) {
    try { fn(piperProgress); } catch {}
  }
  try {
    window.dispatchEvent(new CustomEvent('lumen:piperprogress', { detail: piperProgress }));
  } catch {}
}

export function piperProgressLabel(p = piperProgress) {
  if (p.phase === 'downloading') {
    const pct = p.total ? Math.min(99, Math.round((p.loaded / p.total) * 100)) : 0;
    if (!pct) return 'Downloading voice…';
    const mb = n => `${Math.round(n / 1048576)} MB`;
    return p.total ? `Downloading voice · ${pct}% (${mb(p.loaded)} / ${mb(p.total)})` : `Downloading voice · ${pct}%`;
  }
  if (p.phase === 'preparing') return 'Preparing voice…';
  if (p.phase === 'generating') return 'Generating speech…';
  if (p.phase === 'ready') return 'Voice ready';
  return '';
}

/* Audiobook-style presets built from original Piper voices. These are not
   clones of Audible, Libby or OverDrive narrators — those are human or
   proprietary voices. The LibriVox preset uses LibriTTS, a model trained
   on LibriVox volunteer audiobook recordings. */
export const PIPER_PRESETS = [
  /* Regional and L2 English accents from the open VCTK and L2-ARCTIC corpora. */
  { id: 'accent-british-london', name: 'British · London', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 81, rate: 0.96, desc: 'London English, male speaker.' },
  { id: 'accent-british-birmingham', name: 'British · Birmingham', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 104, rate: 0.96, desc: 'Birmingham English, male speaker.' },
  { id: 'accent-british-manchester', name: 'British · Manchester', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 1, rate: 0.97, desc: 'Manchester English, female speaker.' },
  { id: 'accent-british-yorkshire', name: 'British · Yorkshire', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 12, rate: 0.96, desc: 'Yorkshire English, male speaker.' },
  { id: 'accent-scottish', name: 'Scottish · Edinburgh', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 79, rate: 0.96, desc: 'Scottish English, male speaker.' },
  { id: 'accent-northern-irish', name: 'Northern Irish · Belfast', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 17, rate: 0.96, desc: 'Northern Irish English, female speaker.' },
  { id: 'accent-irish', name: 'Irish · Dublin', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 97, rate: 0.96, desc: 'Irish English, male speaker.' },
  { id: 'accent-welsh', name: 'Welsh · Cardiff', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 88, rate: 0.97, desc: 'Welsh English, female speaker.' },
  { id: 'accent-south-african-f', name: 'South African · Cape Town', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 35, rate: 0.96, desc: 'South African English, female speaker.' },
  { id: 'accent-south-african-m', name: 'South African · Johannesburg', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 32, rate: 0.95, desc: 'South African English, male speaker.' },
  { id: 'accent-indian', name: 'Indian English', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 92, rate: 0.96, desc: 'Indian English, male speaker.' },
  { id: 'accent-australian', name: 'Australian · Sydney', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 71, rate: 0.96, desc: 'Australian English, male speaker.' },
  { id: 'accent-new-zealand', name: 'New Zealand English', group: 'accent', tag: 'VCTK', voiceId: 'en_GB-vctk-medium', speaker: 42, rate: 0.96, desc: 'New Zealand English, female speaker.' },
  { id: 'accent-mandarin', name: 'English · Mandarin accent', group: 'accent', tag: 'L2-ARCTIC', voiceId: 'en_US-l2arctic-medium', speaker: 0, rate: 0.95, desc: 'English with a Mandarin Chinese accent, male.' },
  { id: 'accent-hindi', name: 'English · Hindi accent', group: 'accent', tag: 'L2-ARCTIC', voiceId: 'en_US-l2arctic-medium', speaker: 2, rate: 0.95, desc: 'English with a Hindi accent, female.' },
  { id: 'accent-vietnamese', name: 'English · Vietnamese accent', group: 'accent', tag: 'L2-ARCTIC', voiceId: 'en_US-l2arctic-medium', speaker: 1, rate: 0.95, desc: 'English with a Vietnamese accent, female.' },
  { id: 'accent-korean', name: 'English · Korean accent', group: 'accent', tag: 'L2-ARCTIC', voiceId: 'en_US-l2arctic-medium', speaker: 11, rate: 0.95, desc: 'English with a Korean accent, female.' },
  { id: 'accent-au-matilda', name: 'Australian · Matilda', group: 'accent', tag: 'AU', voiceId: 'au_librivox', speaker: 7, rate: 0.96, desc: 'Australian English, female narrator.' },
  { id: 'accent-au-marlo', name: 'Australian · Marlo', group: 'accent', tag: 'AU', voiceId: 'au_librivox', speaker: 2, rate: 0.93, desc: 'Warmer Australian female narrator, slightly slower.' },
  { id: 'accent-au-banjo', name: 'Australian · Banjo', group: 'accent', tag: 'AU', voiceId: 'au_librivox', speaker: 5, rate: 0.95, desc: 'Australian English, male narrator.' },
  { id: 'accent-au-flynn', name: 'Australian · Flynn', group: 'accent', tag: 'AU', voiceId: 'au_librivox', speaker: 6, rate: 0.95, desc: 'Classic Australian male narrator.' },
];

export function piperVoiceForLanguage(language = '') {
  const base = String(language).toLowerCase().replace('_', '-').split('-')[0];
  if (!base) return null;
  const voices = getPiperVoices();
  const match = voices.filter(v => String(v.lang || '').toLowerCase().replace('-', '_').split('_')[0] === base);
  if (!match.length) return null;
  const rank = v => (v.quality === 'high' ? 0 : v.quality === 'medium' ? 1 : 2);
  return match.slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))[0];
}

export function piperSpeakerName(voice, speaker = 0) {
  if (!voice || voice.num_speakers <= 1) return '';
  const entry = Object.entries(voice.speaker_id_map || {}).find(([, id]) => Number(id) === Number(speaker));
  if (entry) {
    const raw = String(entry[0]);
    if (/^p?\d+$/i.test(raw)) return `Voice ${raw.replace(/^p/i, '')}`;
    return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  return `Speaker ${speaker}`;
}

export function describeVoice() {
  const tts = getPrefs().tts;
  if (!tts.enabled) return 'Silent reading';
  if (tts.provider === 'piper') {
    const v = piperVoiceById(tts.piperVoice);
    const sp = piperSpeakerName(v, tts.piperSpeaker);
    return `Piper · ${v.name}${sp ? ` · ${sp}` : ''}`;
  }
  const v = findVoice(tts.voiceURI) || englishVoices()[0];
  return v ? `System · ${v.name}` : 'System voice';
}

export function cleanForSpeech(text = '') {
  return String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/https?:\/\/\S+/gi, 'a link')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/* ── Piper engine (lazy-loaded) ─────────────────────────────────── */
/* Custom provider: official rhasspy voices + community Australian voices.
   Models are cached in IndexedDB so a downloaded voice works offline. */
let piperDbPromise = null;
function piperDb() {
  if (piperDbPromise) return piperDbPromise;
  piperDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('alya-piper', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('voices')) req.result.createObjectStore('voices', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return piperDbPromise;
}

async function getCachedVoice(id) {
  try {
    const db = await piperDb();
    if (!db) return null;
    return await new Promise(resolve => {
      const req = db.transaction('voices').objectStore('voices').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function putCachedVoice(id, config, blob) {
  try {
    const db = await piperDb();
    if (!db) return;
    await new Promise(resolve => {
      const tx = db.transaction('voices', 'readwrite');
      tx.objectStore('voices').put({ id, config, blob, savedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {}
}

export async function listCachedVoices() {
  await loadPiperCatalog();
  const db = await piperDb();
  if (!db) return [];
  const records = await new Promise(resolve => {
    try {
      const req = db.transaction('voices').objectStore('voices').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
  const voices = getPiperVoices();
  return records.filter(rec => !rec.custom).map(rec => {
    const voice = voices.find(v => v.modelUrl === rec.id);
    return {
      key: rec.id,
      name: voice?.name || 'Voice',
      lang: voice?.language || '',
      country: voice?.country || '',
      size: rec.blob?.size || 0,
      savedAt: rec.savedAt || 0,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export async function deleteCachedVoice(key) {
  const db = await piperDb();
  if (!db) return;
  await new Promise(resolve => {
    const tx = db.transaction('voices', 'readwrite');
    tx.objectStore('voices').delete(key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

export async function clearCachedVoices() {
  const db = await piperDb();
  if (!db) return;
  await new Promise(resolve => {
    const tx = db.transaction('voices', 'readwrite');
    const store = tx.objectStore('voices');
    const req = store.getAll();
    req.onsuccess = () => {
      for (const rec of req.result || []) {
        if (!rec.custom) store.delete(rec.id);
      }
    };
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

async function fetchModelWithProgress(url, expectedBytes, onProgress) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error('The Piper voice model could not be downloaded. Check your connection and try again.');
  const headerTotal = Number(res.headers.get('content-length')) || 0;
  const total = expectedBytes || headerTotal || 0;
  if (!res.body?.getReader) {
    const blob = await res.blob();
    onProgress(blob.size, blob.size || total);
    return blob;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastTick = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = performance.now();
    if (now - lastTick > 90) {
      lastTick = now;
      onProgress(loaded, total);
    }
  }
  onProgress(loaded, total || loaded);
  res.body.cancel?.().catch?.(() => {});
  return new Blob(chunks, { type: 'application/octet-stream' });
}

async function downloadVoiceData(voice) {
  const total = voice.size_bytes || 0;
  emitPiperProgress({
    phase: 'downloading', voiceId: voice.id, voiceName: voice.name,
    loaded: 0, total, percent: 0, cached: false,
  });
  const configRes = await fetch(voice.configUrl, { cache: 'force-cache' });
  if (!configRes.ok) {
    throw new Error('The Piper voice model could not be downloaded. Check your connection and try again.');
  }
  const configData = await configRes.json();
  const blob = await fetchModelWithProgress(voice.modelUrl, total, (loaded, size) => {
    emitPiperProgress({
      loaded,
      total: size || total,
      percent: size ? Math.min(99, Math.round((loaded / size) * 100)) : 0,
    });
  });
  emitPiperProgress({ phase: 'preparing', percent: 100 });
  await putCachedVoice(voice.modelUrl, configData, blob);
  return { configData, blob };
}

class PiperVoiceProvider {
  constructor() {
    this.memory = new Map();
    this.urls = [];
  }

  async fetch(id) {
    const voice = piperVoiceById(id);
    if (!voice || voice.id !== id) throw new Error('That Piper voice is not available.');
    const cacheKey = voice.modelUrl;
    const total = voice.size_bytes || 0;
    emitPiperProgress({
      phase: 'checking', voiceId: id, voiceName: voice.name, loaded: 0, total, percent: 0, cached: false,
    });
    if (this.memory.has(cacheKey)) {
      emitPiperProgress({ phase: 'preparing', cached: true, percent: 100 });
      return this.memory.get(cacheKey);
    }

    const cached = await getCachedVoice(cacheKey);
    if (cached?.blob && cached?.config) {
      const url = URL.createObjectURL(cached.blob);
      this.urls.push(url);
      const data = [cached.config, url];
      this.memory.set(cacheKey, data);
      emitPiperProgress({ phase: 'preparing', cached: true, percent: 100 });
      return data;
    }

    if (voice.custom) throw new Error('This imported voice is missing its files. Import it again.');
    const { configData, blob } = await downloadVoiceData(voice);
    const url = URL.createObjectURL(blob);
    this.urls.push(url);
    const data = [configData, url];
    this.memory.set(cacheKey, data);
    return data;
  }

  destroy() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.memory.clear();
  }
}

let piperPromise = null;
let piperEngine = null;

function resetPiperEngine() {
  try { piperEngine?.destroy?.(); } catch {}
  piperEngine = null;
  piperPromise = null;
}

async function getPiper() {
  if (piperPromise) return piperPromise;
  piperPromise = (async () => {
    emitPiperProgress({ phase: 'preparing', percent: 100 });
    await loadPiperCatalog();
    const mod = await import('../vendor/piper/piper-tts-web.js');
    const base = new URL('../vendor/piper/', import.meta.url).href;
    const voiceProvider = new PiperVoiceProvider();
    const engine = new mod.PiperWebWorkerEngine({
      onnxRuntime: new mod.OnnxWebWorkerRuntime({
        basePath: `${base}onnx/`,
        numThreads: 1,
      }),
      phonemizeRuntime: new mod.PhonemizeWebWorkerRuntime({
        basePath: `${base}piper/`,
      }),
      voiceProvider,
      expressionRuntime: { destroy() {} },
    });
    piperEngine = engine;
    return { mod, engine, voiceProvider };
  })().catch(err => {
    piperPromise = null;
    console.error('Piper load failed', err);
    throw new Error('The Piper voice engine could not load. Check your connection and try again.');
  });
  return piperPromise;
}

let piperBusy = 0;

function settlePiperProgress() {
  emitPiperProgress({ phase: 'ready' });
  setTimeout(() => {
    if (!piperBusy && piperProgress.phase === 'ready') {
      emitPiperProgress({ phase: 'idle', loaded: 0, total: 0, percent: 0 });
    }
  }, 1400);
}

/* Download and cache a voice without starting the speech engine. */
export async function preloadPiperVoice(voiceId) {
  await loadPiperCatalog();
  const voice = piperVoiceById(voiceId);
  if (!voice || voice.id !== voiceId) return 'missing';
  const cached = await getCachedVoice(voice.modelUrl);
  if (cached?.blob && cached?.config) {
    emitPiperProgress({ phase: 'ready', voiceId: voice.id, voiceName: voice.name, cached: true, percent: 100 });
    settlePiperProgress();
    return 'cached';
  }
  if (voice.custom) return 'missing';
  await downloadVoiceData(voice);
  emitPiperProgress({ phase: 'ready', voiceId: voice.id, voiceName: voice.name, percent: 100 });
  settlePiperProgress();
  return 'downloaded';
}

/* Piper should only run one synthesis at a time. Running a prefetch and
   the audible sentence together can exhaust the WASM heap on iOS. */
let piperQueue = Promise.resolve();

function enqueuePiper(task) {
  const run = piperQueue.then(task, task);
  piperQueue = run.catch(() => {});
  return run;
}

/* A stalled worker never rejects on its own, which looked like narration
   randomly stopping. Reject after 60s without any engine progress. */
function awaitPiperJob(promise, idleLimitMs = 60000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setInterval(() => {
      if (settled) return;
      if (Date.now() - piperActivityAt > idleLimitMs) {
        settled = true;
        clearInterval(timer);
        const err = new Error('The voice engine stopped responding.');
        err.code = 'stalled';
        reject(err);
      }
    }, 2000);
    promise.then(
      value => { if (settled) return; settled = true; clearInterval(timer); resolve(value); },
      err => { if (settled) return; settled = true; clearInterval(timer); reject(err); },
    );
  });
}

export async function piperGenerate(text, voiceId, speaker = null) {
  await loadPiperCatalog();
  const voice = piperVoiceById(voiceId);
  piperBusy++;
  try {
    return await enqueuePiper(async () => {
      notePiperActivity();
      const { engine } = await getPiper();
      const sp = speaker == null ? (getPrefs().tts.piperSpeaker || 0) : speaker;
      emitPiperProgress({ phase: 'generating', voiceId: voice.id, voiceName: voice.name, percent: 100 });
      const result = await awaitPiperJob(engine.generate(text, voice.id, Number(sp) || 0));
      return result.file; // WAV Blob
    });
  } catch (err) {
    if (err?.code === 'stalled') {
      console.warn('Piper stopped responding; restarting the engine');
      resetPiperEngine();
    }
    throw err;
  } finally {
    piperBusy = Math.max(0, piperBusy - 1);
    if (!piperBusy) settlePiperProgress();
  }
}

/* A tiny silent WAV, played on the user's tap to unlock audio on iOS.
   The same <audio> element is reused, so later async playback is allowed. */
let silentWavUrl = null;
function silentAudioSrc() {
  if (silentWavUrl) return silentWavUrl;
  const rate = 8000;
  const samples = 480;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples * 2, true);
  silentWavUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  return silentWavUrl;
}

/* ── iOS-safe audio ───────────────────────────────────────────────
   Safari blocks media elements that were not started by a tap, which
   made narration stop after a refresh, a phone call or a lock screen.
   Web Audio stays unlocked once it has been resumed inside a gesture,
   so narration and previews keep playing through async generation. */
let sharedAudioCtx = null;
let gestureUnlockBound = false;

function configureAudioSession() {
  try {
    // iOS 17+: play as a media app, ignoring the ring/silent switch and
    // keeping audio alive when the screen locks.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {}
}

try { configureAudioSession(); } catch {}

export function audioContext() {
  if (sharedAudioCtx && sharedAudioCtx.state === 'closed') sharedAudioCtx = null;
  if (sharedAudioCtx) return sharedAudioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try { sharedAudioCtx = new Ctx(); } catch { return null; }
  sharedAudioCtx.addEventListener?.('statechange', () => {
    if (sharedAudioCtx.state === 'interrupted') {
      try { sharedAudioCtx.resume(); } catch {}
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sharedAudioCtx.state !== 'running') {
      try { sharedAudioCtx.resume(); } catch {}
    }
  });
  return sharedAudioCtx;
}

/* Call synchronously from a tap/click. It primes Web Audio and installs
   a page-wide gesture listener, so a suspended session self-heals the
   next time the user touches the screen. */
export function unlockAudio() {
  configureAudioSession();
  const ctx = audioContext();
  if (!ctx) return null;
  const kick = () => {
    try { ctx.resume(); } catch {}
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
    } catch {}
  };
  kick();
  if (!gestureUnlockBound) {
    gestureUnlockBound = true;
    const resume = () => {
      configureAudioSession();
      try { sharedAudioCtx.resume(); } catch {}
    };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('touchstart', resume, true);
    document.addEventListener('keydown', resume, true);
  }
  return ctx;
}

/* Unlock on the very first interaction anywhere in the app, so playback
   started later (after a fetch or a chapter change) is never blocked. */
if (typeof document !== 'undefined') {
  const firstGesture = () => unlockAudio();
  document.addEventListener('pointerdown', firstGesture, { capture: true, once: true });
  document.addEventListener('touchstart', firstGesture, { capture: true, once: true });
  document.addEventListener('keydown', firstGesture, { capture: true, once: true });
}

function decodeAudioBlob(ctx, blob) {
  return blob.arrayBuffer().then(bytes => new Promise((resolve, reject) => {
    let settled = false;
    const ok = buffer => { if (!settled) { settled = true; resolve(buffer); } };
    const bad = err => { if (!settled) { settled = true; reject(err); } };
    try {
      const maybe = ctx.decodeAudioData(bytes.slice(0), ok, bad);
      if (maybe?.then) maybe.then(ok, bad);
    } catch (err) { bad(err); }
  }));
}

/* ═══════════════════════════════════════════════════════════════════ */

export class SpeechEngine {
  constructor({ onState, onSentence, onEnd, onError } = {}) {
    this.onState = onState || (() => {});
    this.onSentence = onSentence || (() => {});
    this.onEnd = onEnd || (() => {});
    this.onError = onError || (() => {});

    this.sentences = [];
    this.index = 0;
    this.state = 'idle'; // idle | loading | playing | paused
    this._chunks = [];
    this._chunkIndex = 0;
    this._token = 0;
    this._audio = null;
    this.voice = null;
    this._audioEl = null;
    this._keepAlive = null;
    this._primed = false;
    this._audioSource = null;
    this._audioBuffer = null;
    this._audioGain = null;
    this._audioOffset = 0;
    this._audioStartedAt = 0;
    this._audioRate = 1;
    this._seekFraction = null;
    this._chunkSeekFraction = null;
    this._completed = false;
    this._stalledAt = 0;
    this._pendingAdvance = null;
    this._retryTimer = null;
    this._wantPlaying = false;
    this._chunkStartedAt = 0;
    this._audioUrl = null;
    this._cache = new Map();
    this._inFlight = new Map();
    this._pauseTimer = null;
    this._wakeLock = null;
    this._errorStreak = 0;

    this._onVoices = () => {
      window.dispatchEvent(new CustomEvent('lumen:voices'));
    };
    try { speechSynthesis.addEventListener?.('voiceschanged', this._onVoices); } catch {}
    this._onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      this._requestWakeLock();
      if (sharedAudioCtx && sharedAudioCtx.state !== 'running') {
        try { sharedAudioCtx.resume(); } catch {}
      }
      this._runPendingAdvance();
      // If the OS killed playback while we were away, pick the book back up.
      if (this._wantPlaying && this.state === 'idle' && this.sentences.length) this.play();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    // If the OS or a headset pauses audio without pausing the session,
    // keep narration alive instead of silently stopping.
    this._watchdog = setInterval(() => {
      if (this.state === 'playing' && this._pendingAdvance) {
        this._runPendingAdvance();
      } else if (this.state === 'playing' && this._audioSource) {
        this._requestWakeLock();
        if (sharedAudioCtx && sharedAudioCtx.state !== 'running') {
          try { sharedAudioCtx.resume(); } catch {}
        }
        // If iOS swallowed the `ended` callback, move on instead of dying.
        if (sharedAudioCtx && this._audioBuffer) {
          const elapsed = (sharedAudioCtx.currentTime - this._audioStartedAt) * this._audioRate;
          if (elapsed > this._audioBuffer.duration - this._audioOffset + 10) {
            this._audioSource.onended = null;
            this._stopWebAudio(true);
            this._advanceChunk();
          }
        }
      } else if (this.state === 'playing' && !this._audio) {
        // Playback state without a source: audio was interrupted before it
        // could start. Give it a moment, then restart the current chunk.
        this._requestWakeLock();
        if (!this._stalledAt) this._stalledAt = Date.now();
        else if (Date.now() - this._stalledAt > 9000) {
          this._stalledAt = 0;
          if (this.provider === 'piper') this._speakChunk();
        }
      } else if (this.state === 'playing' && this._audio) {
        this._requestWakeLock();
        if (this._audio.ended) {
          this._audio.onended = null;
          this._advanceChunk();
        } else if (this._audio.paused) {
          this._audio.play().catch(() => {});
        }
      } else if (this.state === 'loading') {
        this._requestWakeLock();
        // A worker that never answers would otherwise sit in "Preparing"
        // forever on a locked phone.
        if (this.provider === 'piper' && this._chunkStartedAt
          && Date.now() - this._chunkStartedAt > 90000) {
          this._chunkStartedAt = 0;
          resetPiperEngine();
          this._skipUnreadable(new Error('Voice generation stalled.'));
        }
      }
    }, 2000);
  }

  get total() { return this.sentences.length; }
  get current() { return this.sentences[this.index] || null; }
  get provider() { return getPrefs().tts.provider; }
  get enabled() { return getPrefs().tts.enabled; }

  /* ── loading ─────────────────────────────────────────────────── */
  load(sentences = [], { autoplay = false, start = 0, startFraction = null, paused = false } = {}) {
    this._invalidate();
    this._wantPlaying = false;
    this.sentences = sentences;
    this._seekFraction = startFraction == null ? null : clampNum(startFraction, 0, 0.999);
    this._chunkSeekFraction = null;
    this._completed = false;
    this.index = Math.max(0, Math.min(start, sentences.length - 1));
    this._setState('idle');
    if (autoplay && sentences.length) this.play();
    else if (sentences.length) this.onSentence(sentences[this.index], this.index, { silent: true });
  }

  play() {
    if (!this.enabled) {
      this.onError('Narration is off. Turn it on in Settings → Voice & narration.');
      return;
    }
    if (!this.sentences.length) return;
    unlockAudio();
    if (this.state === 'paused') {
      if (this.provider === 'system') {
        this._setPlaying();
        this._speakSystemChunk();
      } else if (this._resumeWebAudio()) {
        // resumed from the exact spot inside the generated clip
      } else if (this._audio) {
        this._startKeepAlive();
        this._setPlaying();
        this._audio.play().catch(err => this._fail(err.message));
      } else {
        this._startSentence(this.index);
      }
      return;
    }
    if (this.state === 'playing' || this.state === 'loading') return;
    this._primeAudio();
    this._startSentence(this.index);
  }

  // Called synchronously from a tap so iOS allows the later async playback.
  _primeAudio() {
    if (this.provider !== 'piper') return;
    unlockAudio();
    this._startKeepAlive();
    if (!this._audioEl) this._audioEl = new Audio();
    if (this._primed) return;
    const audio = this._audioEl;
    this._primed = true;
    try {
      const silent = silentAudioSrc();
      audio.src = silent;
      audio.volume = 0.0001;
      const p = audio.play();
      p?.then?.(() => {
        if (audio.src === silent) {
          try { audio.pause(); audio.currentTime = 0; } catch {}
        }
      }).catch?.(() => { this._primed = false; });
    } catch {
      this._primed = false;
    }
  }

  pause() {
    if (this.state !== 'playing' && this.state !== 'loading') return;
    this._wantPlaying = false;
    this._token++;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    clearTimeout(this._resumeTimer);
    this._resumeTimer = null;
    clearTimeout(this._pauseTimer);
    this._pauseTimer = null;
    this._pendingAdvance = null;
    this._stopKeepAlive();
    if (this.provider === 'system') {
      try { speechSynthesis.cancel(); } catch {}
    } else {
      this._pauseWebAudio();
      if (this._audio) {
        try { this._audio.pause(); } catch {}
      }
    }
    this._setState('paused');
    this._releaseWakeLock();
  }

  stop({ keepIndex = true } = {}) {
    this._wantPlaying = false;
    this._invalidate();
    this._stopKeepAlive();
    this._setState('idle');
    // A stop at the end of a chapter/book can happen while already idle;
    // notify the UI anyway so it does not keep claiming that it is listening.
    this.onState('idle');
    if (!keepIndex) this.index = 0;
    this._releaseWakeLock();
  }

  next() {
    if (!this.sentences.length) return;
    this._seekFraction = null;
    this._chunkSeekFraction = null;
    const wasPlaying = this.state === 'playing' || this.state === 'loading';
    this._startSentence(Math.min(this.index + 1, this.sentences.length - 1), { autoplay: wasPlaying });
  }

  prev() {
    if (!this.sentences.length) return;
    this._seekFraction = null;
    this._chunkSeekFraction = null;
    const wasPlaying = this.state === 'playing' || this.state === 'loading';
    this._startSentence(Math.max(0, this.index - 1), { autoplay: wasPlaying });
  }

  restart() {
    if (!this.sentences.length) return;
    this._seekFraction = null;
    this._chunkSeekFraction = null;
    const wasActive = this.state === 'playing' || this.state === 'loading' || this.state === 'paused';
    this._invalidate();
    this._startSentence(this.index, { autoplay: wasActive });
  }

  setRate(rate) {
    setTtsPrefs({ rate });
    const r = Math.max(0.5, Math.min(2, Number(rate) || 1));
    if (this.provider !== 'system' && this._audioSource) {
      try { this._audioSource.playbackRate.value = r; this._audioRate = r; } catch {}
    }
    if (this.provider !== 'system' && this._audio) {
      try { this._audio.playbackRate = r; } catch {}
    }
  }

  _getClipProgress() {
    if (this._audioBuffer && sharedAudioCtx) {
      let position = this._audioOffset;
      if (this._audioSource && sharedAudioCtx.state === 'running') {
        position += Math.max(0, sharedAudioCtx.currentTime - this._audioStartedAt) * this._audioRate;
      }
      return { position: Math.min(position, this._audioBuffer.duration), duration: this._audioBuffer.duration };
    }
    if (this._audio && Number.isFinite(this._audio.duration) && this._audio.duration > 0) {
      return { position: this._audio.currentTime || 0, duration: this._audio.duration };
    }
    return null;
  }

  getSentenceProgress() {
    if (this._completed) return 1;
    if (!this._chunks.length) return this._seekFraction ?? 0;
    const units = this._chunks.map(speechUnits);
    const total = units.reduce((sum, value) => sum + value, 0) || 1;
    let local = this._seekFraction ?? this._chunkSeekFraction ?? 0;
    const clip = this._getClipProgress();
    if (clip) local = clip.position / clip.duration;
    if (this.provider === 'system' && Number.isFinite(this._systemChunkFraction)) local = this._systemChunkFraction;
    const before = units.slice(0, this._chunkIndex).reduce((sum, value) => sum + value, 0);
    return Math.max(0, Math.min(1, (before + units[this._chunkIndex] * local) / total));
  }

  seekToSentence(index, fraction = 0) {
    if (!this.sentences.length) return false;
    const target = Math.max(0, Math.min(this.sentences.length - 1, Math.floor(Number(index) || 0)));
    const wasPlaying = this.state === 'playing' || this.state === 'loading';
    const wasPaused = this.state === 'paused';
    this._seekFraction = clampNum(fraction, 0, 0.999);
    this._completed = false;
    this._startSentence(target, { autoplay: wasPlaying, silent: !wasPlaying });
    if (wasPaused) this._setState('paused');
    return true;
  }

  setVoiceOverride(voice) {
    const next = voice?.voiceId ? voice : null;
    const same = JSON.stringify(next) === JSON.stringify(this.voice);
    this.voice = next;
    if (!same) this._cache.clear();
  }

  applyVoiceChange() {
    this.voice = null;
    this._cache.clear();
    if (this.state === 'playing' || this.state === 'loading') this.restart();
  }

  destroy() {
    this.stop();
    this._stopWebAudio(true);
    try { this._audioGain?.disconnect(); } catch {}
    this._audioGain = null;
    try { speechSynthesis.removeEventListener?.('voiceschanged', this._onVoices); } catch {}
    document.removeEventListener('visibilitychange', this._onVisibility);
    clearInterval(this._watchdog);
    this._clearCache();
    this.sentences = [];
    this._releaseWakeLock();
  }

  /* ── sentence handling ───────────────────────────────────────── */
  _startSentence(i, { autoplay = true, silent = false } = {}) {
    if (!this.sentences[i]) return;
    this._invalidate();
    this._chunks = [];
    this._chunkIndex = 0;
    this._chunkSeekFraction = null;
    this._systemChunkFraction = null;
    this._completed = false;
    this.index = i;
    const sentence = this.sentences[i];
    this.onSentence(sentence, i, { silent });
    if (!autoplay) { this._setState('idle'); return; }

    const text = cleanForSpeech(sentence.text);
    this._wantPlaying = true;
    if (!text) {
      this._seekFraction = null;
      this._advanceSentence();
      return;
    }

    this._chunks = splitLongText(text, this.provider === 'piper' ? 800 : 240);
    const seekFraction = this._seekFraction;
    this._seekFraction = null;
    this._chunkIndex = 0;
    this._chunkSeekFraction = null;
    if (seekFraction != null && this.provider !== 'system') {
      const chunkUnits = this._chunks.map(speechUnits);
      const totalUnits = chunkUnits.reduce((sum, units) => sum + units, 0) || 1;
      let targetUnits = seekFraction * totalUnits;
      while (this._chunkIndex < chunkUnits.length - 1 && targetUnits >= chunkUnits[this._chunkIndex]) {
        targetUnits -= chunkUnits[this._chunkIndex];
        this._chunkIndex++;
      }
      this._chunkSeekFraction = clampNum(targetUnits / chunkUnits[this._chunkIndex], 0, 0.999);
    }
    this._setPlaying();
    this._speakChunk();
    this._prefetch(i);
  }

  _speakChunk() {
    if (!this._chunks.length) { this._advanceSentence(); return; }
    const chunk = this._chunks[this._chunkIndex];
    if (this.provider === 'system') this._speakSystemChunk(chunk);
    else this._speakAudioChunk(chunk);
  }

  _speakSystemChunk(chunkOverride) {
    const chunk = chunkOverride || this._chunks[this._chunkIndex];
    if (!chunk) { this._advanceSentence(); return; }
    const prefs = getPrefs().tts;
    if (!('speechSynthesis' in window)) {
      this._fail('This browser does not support speech synthesis. Try Safari, Chrome or Edge.');
      return;
    }
    try { speechSynthesis.cancel(); } catch {}

    const token = ++this._token;
    const utter = new SpeechSynthesisUtterance(chunk);
    this._systemChunkFraction = 0;
    const voice = findVoice(prefs.voiceURI) || englishVoices()[0] || null;
    if (voice) { utter.voice = voice; utter.lang = voice.lang; }
    utter.rate = clampNum(prefs.rate, 0.5, 2);
    utter.pitch = clampNum(prefs.pitch, 0, 2);
    utter.volume = clampNum(prefs.volume ?? 0.9, 0, 1);

    utter.onend = () => {
      if (token !== this._token) return;
      this._systemChunkFraction = 1;
      this._advanceChunk();
    };
    utter.onboundary = event => {
      if (token !== this._token || !Number.isFinite(event.charIndex)) return;
      this._systemChunkFraction = Math.max(0, Math.min(1, event.charIndex / Math.max(1, chunk.length)));
    };
    utter.onerror = e => {
      if (token !== this._token) return;
      if (['canceled', 'interrupted', 'not-allowed'].includes(e.error)) return;
      this._fail(`Speech stopped: ${e.error || 'unknown error'}`);
    };
    setTimeout(() => {
      if (token !== this._token) return;
      try { speechSynthesis.speak(utter); } catch (e) { this._fail(e.message); }
    }, 20);
  }

  async _speakAudioChunk(chunk) {
    const token = ++this._token;
    this._chunkStartedAt = Date.now();
    this._setState('loading');
    let entry;
    try {
      entry = await this._getAudio(chunk);
    } catch (err) {
      if (token !== this._token) return;
      // iOS can drop the first wasm generation after an interruption;
      // retry once before treating the sentence as unreadable.
      try {
        await new Promise(r => setTimeout(r, 700));
        if (token !== this._token) return;
        entry = await this._getAudio(chunk);
      } catch (err2) {
        if (token !== this._token) return;
        this._skipUnreadable(err2 || err);
        return;
      }
    }
    if (token !== this._token) return;

    if (await this._playAudioBuffer(entry, token)) return;
    if (token !== this._token) return;

    const prefs = getPrefs().tts;
    const audio = this._audioEl || new Audio();
    const seekFraction = this._chunkSeekFraction;
    this._chunkSeekFraction = null;
    try { audio.setAttribute('playsinline', ''); } catch {}
    audio.src = entry.url;
    this._audio = audio;
    this._audioUrl = entry.url;
    audio.volume = clampNum(prefs.volume ?? 0.9, 0, 1);
    audio.playbackRate = clampNum(prefs.rate, 0.5, 2);
    audio.preservesPitch = true;
    if (seekFraction != null && seekFraction > 0) {
      const seekWhenReady = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = audio.duration * seekFraction;
      };
      if (Number.isFinite(audio.duration) && audio.duration > 0) seekWhenReady();
      else audio.addEventListener('loadedmetadata', seekWhenReady, { once: true });
    }
    audio.onended = () => {
      if (token !== this._token) return;
      this._audio = null;
      this._advanceChunk();
    };
    audio.onerror = () => {
      if (token !== this._token) return;
      this._skipUnreadable(new Error('The generated audio could not be played.'));
    };
    try {
      await audio.play();
      if (token !== this._token) { audio.pause(); return; }
      this._errorStreak = 0;
      this._stalledAt = 0;
      this._chunkStartedAt = 0;
      this._startKeepAlive();
      this._setState('playing');
      this._requestWakeLock();
    } catch {
      if (token !== this._token) return;
      // Keep trying: a later touch resumes the audio session.
      this._skipUnreadable(new Error('The browser paused audio playback.'));
    }
  }

  /* Web Audio playback. Unlike <audio>, an unlocked AudioContext keeps
     playing after a long async gap, a phone call or a screen lock. */
  async _playAudioBuffer(entry, token) {
    const ctx = audioContext();
    if (!ctx) return false;
    let buffer = entry.buffer;
    if (!buffer) {
      try {
        const blob = entry.blob || await (await fetch(entry.url)).blob();
        buffer = await decodeAudioBlob(ctx, blob);
        // Keep the decoded PCM only while this clip is playing; holding a
        // buffer for every cached sentence is too much memory on iOS.
        entry.buffer = null;
      } catch {
        return false;
      }
    }
    if (token !== this._token) return true;
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch {}
    }
    const seekFraction = this._chunkSeekFraction;
    this._chunkSeekFraction = null;
    const offset = seekFraction == null ? 0 : buffer.duration * seekFraction;
    this._audio = null;
    this._stalledAt = 0;
    this._chunkStartedAt = 0;
    this._errorStreak = 0;
    this._playBufferSource(buffer, offset, token);
    this._startKeepAlive();
    this._setState('playing');
    this._requestWakeLock();
    return true;
  }

  _playBufferSource(buffer, offset, token) {
    const ctx = sharedAudioCtx;
    if (!ctx) return false;
    this._stopWebAudio(false);
    const prefs = getPrefs().tts;
    if (!this._audioGain) {
      this._audioGain = ctx.createGain();
      this._audioGain.connect(ctx.destination);
    }
    this._audioGain.gain.value = clampNum(prefs.volume ?? 0.9, 0, 1);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    this._audioRate = clampNum(prefs.rate, 0.5, 2);
    src.playbackRate.value = this._audioRate;
    src.connect(this._audioGain);
    src.onended = () => {
      if (token !== this._token) return;
      const elapsed = Math.max(0, (ctx.currentTime - this._audioStartedAt) * this._audioRate);
      const remaining = buffer.duration - this._audioOffset;
      this._audioSource = null;
      try { src.disconnect(); } catch {}
      // iOS may end a Web Audio source when an audio interruption occurs.
      // Do not interpret an early end as a completed sentence: continue the
      // same decoded clip from the point where the audio clock stopped.
      if (elapsed + 0.35 < remaining) {
        const offset = this._audioOffset + elapsed;
        this._audioOffset = offset;
        this._stalledAt = Date.now();
        const resume = () => {
          if (token !== this._token || !this._wantPlaying || this.state === 'paused') return;
          if (sharedAudioCtx?.state !== 'running') {
            this._resumeTimer = setTimeout(resume, 1200);
            return;
          }
          this._stalledAt = 0;
          this._playBufferSource(buffer, offset, token);
        };
        this._resumeTimer = setTimeout(resume, 250);
        return;
      }
      this._audioBuffer = null;
      this._audioOffset = 0;
      this._advanceChunk();
    };
    this._audioSource = src;
    this._audioBuffer = buffer;
    this._audioOffset = Math.max(0, Math.min(offset, Math.max(0, buffer.duration - 0.01)));
    this._audioStartedAt = ctx.currentTime;
    try { src.start(0, this._audioOffset); } catch { try { src.start(0); } catch {} }
    return true;
  }

  _pauseWebAudio() {
    const src = this._audioSource;
    if (!src) return;
    if (sharedAudioCtx) {
      this._audioOffset += Math.max(0, sharedAudioCtx.currentTime - this._audioStartedAt) * this._audioRate;
    }
    this._stopWebAudio(false);
  }

  _resumeWebAudio() {
    const buffer = this._audioBuffer;
    if (!buffer || !sharedAudioCtx) return false;
    if (this._audioOffset >= buffer.duration - 0.05) return false;
    const token = ++this._token;
    this._stalledAt = 0;
    this._playBufferSource(buffer, this._audioOffset, token);
    this._startKeepAlive();
    this._setState('playing');
    this._requestWakeLock();
    return true;
  }

  _stopWebAudio(clearBuffer = true) {
    const src = this._audioSource;
    this._audioSource = null;
    if (src) {
      src.onended = null;
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
    if (clearBuffer) {
      this._audioBuffer = null;
      this._audioOffset = 0;
    }
  }

  _advanceChunk() {
    if (this._chunkIndex + 1 < this._chunks.length) {
      this._chunkIndex++;
      this._speakChunk();
      return;
    }
    this._advanceSentence();
  }

  _advanceSentence() {
    if (this.index + 1 >= this.sentences.length) {
      this._token++;
      this._completed = true;
      // Keep the intent alive across the chapter hand-off; the reader stops
      // the engine explicitly when the book itself is finished.
      this._stopKeepAlive();
      this._setState('idle');
      this._releaseWakeLock();
      this.onEnd();
      return;
    }
    const next = this.index + 1;
    // A timer between sentences can be frozen on a locked phone, which made
    // narration stop at the end of a page. In the background, continue now.
    const background = document.visibilityState === 'hidden' || !document.hasFocus();
    // Neural narration is already paced by generation time. A JS timer here
    // is frozen when iOS locks the screen, which made playback stop randomly.
    const pauseMs = background || this.provider === 'piper'
      ? 0
      : Math.round(clampNum(getPrefs().tts.sentencePause ?? 0.2, 0, 1.5) * 1000);
    if (pauseMs > 0) {
      const token = this._token;
      clearTimeout(this._pauseTimer);
      this._pendingAdvance = { index: next, token, at: Date.now() + pauseMs + 400 };
      this._pauseTimer = setTimeout(() => {
        if (token !== this._token) return;
        this._pendingAdvance = null;
        this._startSentence(next, { autoplay: true });
      }, pauseMs);
    } else {
      this._pendingAdvance = null;
      this._startSentence(next, { autoplay: true });
    }
  }

  _runPendingAdvance() {
    const pending = this._pendingAdvance;
    if (!pending) return;
    if (Date.now() < pending.at) return;
    this._pendingAdvance = null;
    clearTimeout(this._pauseTimer);
    this._pauseTimer = null;
    if (pending.token !== this._token) return;
    this._startSentence(pending.index, { autoplay: true });
  }

  _setPlaying() {
    this._audio = null;
    this._setState('playing');
    this._requestWakeLock();
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  _skipUnreadable(err) {
    this._errorStreak = (this._errorStreak || 0) + 1;
    console.warn('Narration problem, retrying', err);
    if (this._errorStreak % 2 === 0) resetPiperEngine();
    const attempt = this._errorStreak;
    const delay = Math.min(10000, 700 * attempt);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this.state === 'paused' || this.state === 'idle' || !this.sentences.length) return;
      if (attempt > 3) {
        // This sentence refuses to render; skip it but keep the book going.
        this._errorStreak = 0;
        this._advanceSentence();
      } else {
        this._speakChunk();
      }
    }, delay);
  }

  _fail(message) {
    this._wantPlaying = false;
    this._invalidate();
    this._stopKeepAlive();
    this._setState('idle');
    this._releaseWakeLock();
    this.onError(message);
  }

  _invalidate() {
    this._token++;
    clearTimeout(this._pauseTimer);
    this._pauseTimer = null;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    clearTimeout(this._resumeTimer);
    this._resumeTimer = null;
    this._pendingAdvance = null;
    this._chunkStartedAt = 0;
    this._stopWebAudio(true);
    this._stalledAt = 0;
    try { speechSynthesis.cancel(); } catch {}
    if (this._audio) {
      try { this._audio.pause(); } catch {}
      this._audio.onended = null;
      this._audio.onerror = null;
      this._audio = null;
    }
  }

  /* ── Piper audio fetch / cache ──────────────────────────────── */
  _cacheKey(text) {
    const tts = getPrefs().tts;
    const voice = this.voice?.voiceId || tts.piperVoice;
    return `${tts.provider}|${voice}|${tts.rate}|${text}`;
  }

  /* Generate upcoming text without changing the current sentence. */
  prefetchTexts(texts = []) {
    if (this.provider !== 'piper') return;
    for (const text of texts.slice(0, 1)) {
      const clean = cleanForSpeech(text);
      if (!clean) continue;
      const chunk = splitLongText(clean, 800)[0];
      const key = this._cacheKey(chunk);
      if (this._cache.has(key) || this._inFlight.has(key)) continue;
      this._getAudio(chunk).catch(() => {});
    }
  }

  async _getAudio(text) {
    if (this.provider !== 'piper') throw new Error('No neural voice is selected.');
    const key = this._cacheKey(text);
    const hit = this._cache.get(key);
    if (hit) { hit.at = Date.now(); return hit; }
    if (this._inFlight.has(key)) return this._inFlight.get(key);

    const tts = getPrefs().tts;
    const voiceId = this.voice?.voiceId || tts.piperVoice;
    const speaker = this.voice?.voiceId ? (this.voice.speaker ?? 0) : tts.piperSpeaker;
    const promise = piperGenerate(text, voiceId, speaker)
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const entry = { url, blob, at: Date.now() };
        this._cache.set(key, entry);
        this._trimCache();
        return entry;
      })
      .finally(() => this._inFlight.delete(key));

    this._inFlight.set(key, promise);
    return promise;
  }

  _prefetch(sentenceIndex) {
    if (this.provider !== 'piper') return;
    // Queue only the next sentence so a long-book seek is never buried behind prefetch work.
    for (let d = 1; d <= 1; d++) {
      const next = this.sentences[sentenceIndex + d];
      if (!next) break;
      const text = cleanForSpeech(next.text);
      if (!text) continue;
      const key = this._cacheKey(text.slice(0, 800));
      if (this._cache.has(key) || this._inFlight.has(key)) continue;
      this._getAudio(splitLongText(text, 800)[0]).catch(() => {});
    }
  }

  _trimCache() {
    if (this._cache.size <= 10) return;
    const entries = [...this._cache.entries()].sort((a, b) => a[1].at - b[1].at);
    while (this._cache.size > 7 && entries.length) {
      const [key, entry] = entries.shift();
      this._cache.delete(key);
      if (entry.url !== this._audioUrl) URL.revokeObjectURL(entry.url);
    }
  }

  _clearCache() {
    for (const entry of this._cache.values()) URL.revokeObjectURL(entry.url);
    this._cache.clear();
  }

  /* ── wake lock ───────────────────────────────────────────────── */
  _startKeepAlive() {
    if (this.provider !== 'piper') return;
    if (!this._keepAlive) {
      const audio = new Audio(silentAudioSrc());
      audio.loop = true;
      audio.volume = 0.0001;
      audio.setAttribute('playsinline', '');
      this._keepAlive = audio;
    }
    if (this._keepAlive.paused) this._keepAlive.play().catch(() => {});
  }

  _stopKeepAlive() {
    if (!this._keepAlive) return;
    try { this._keepAlive.pause(); } catch {}
    this._keepAlive = null;
  }

  async _requestWakeLock() {
    if (!('wakeLock' in navigator) || this._wakeLock) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener?.('release', () => { this._wakeLock = null; });
    } catch {}
  }

  _releaseWakeLock() {
    try { this._wakeLock?.release?.(); } catch {}
    this._wakeLock = null;
  }
}

function clampNum(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function speechUnits(text) {
  return Math.max(1, (String(text || '').match(/[\p{L}\p{M}\p{N}]/gu) || []).length);
}

/* ── One-off preview used by settings / voice picker ───────────────── */
let previewAudio = null;
let previewUrl = null;
let previewSource = null;
let previewGain = null;
let previewToken = 0;

export function stopPreview() {
  previewToken++;
  try { speechSynthesis.cancel(); } catch {}
  if (previewSource) {
    try { previewSource.onended = null; previewSource.stop(); } catch {}
    try { previewSource.disconnect(); } catch {}
    previewSource = null;
  }
  if (previewGain) {
    try { previewGain.disconnect(); } catch {}
    previewGain = null;
  }
  if (previewAudio) {
    try { previewAudio.pause(); } catch {}
    previewAudio = null;
  }
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

export async function previewSpeech(tts, text = 'This is how I’ll read your book — warm, clear, and unhurried.') {
  stopPreview();
  const token = previewToken;
  if (!tts.enabled) return;
  configureAudioSession();

  if (tts.provider === 'system') {
    unlockAudio();
    if (!('speechSynthesis' in window)) throw new Error('Speech synthesis is not available in this browser.');
    const utter = new SpeechSynthesisUtterance(text);
    const voice = findVoice(tts.voiceURI) || englishVoices()[0] || null;
    if (voice) { utter.voice = voice; utter.lang = voice.lang; }
    utter.rate = clampNum(tts.rate, 0.5, 2);
    utter.pitch = clampNum(tts.pitch, 0, 2);
    utter.volume = clampNum(tts.volume ?? 0.9, 0, 1);
    speechSynthesis.speak(utter);
    return;
  }

  // Unlock audio inside the tap, before the long generation. Web Audio
  // survives the async gap; the media element is only a fallback.
  const ctx = unlockAudio();
  let audio = null;
  if (!ctx) {
    audio = new Audio(silentAudioSrc());
    previewAudio = audio;
    audio.volume = 0.0001;
    audio.play().catch(() => {});
  }

  const blob = await piperGenerate(text, tts.piperVoice, tts.piperSpeaker);
  if (token !== previewToken) return; // cancelled while generating

  if (ctx) {
    try {
      const buffer = await decodeAudioBlob(ctx, blob);
      if (token !== previewToken) return;
      if (ctx.state !== 'running') {
        try { await ctx.resume(); } catch {}
      }
      previewGain = ctx.createGain();
      previewGain.gain.value = clampNum(tts.volume ?? 0.9, 0, 1);
      previewGain.connect(ctx.destination);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = clampNum(tts.rate, 0.5, 2);
      src.connect(previewGain);
      src.onended = () => { clearPreviewAudio(); };
      previewSource = src;
      src.start(0);
      return;
    } catch {
      // fall through to the media element path
    }
  }

  const fallback = audio || new Audio(silentAudioSrc());
  previewAudio = fallback;
  try { fallback.pause(); fallback.currentTime = 0; } catch {}
  previewUrl = URL.createObjectURL(blob);
  try { fallback.setAttribute('playsinline', ''); } catch {}
  fallback.src = previewUrl;
  fallback.volume = clampNum(tts.volume ?? 0.9, 0, 1);
  fallback.playbackRate = clampNum(tts.rate, 0.5, 2);
  fallback.preservesPitch = true;
  fallback.onended = () => { clearPreviewAudio(); };
  await fallback.play();
}

function clearPreviewAudio() {
  if (previewSource) {
    try { previewSource.onended = null; previewSource.stop(); } catch {}
    try { previewSource.disconnect(); } catch {}
    previewSource = null;
  }
  if (previewGain) {
    try { previewGain.disconnect(); } catch {}
    previewGain = null;
  }
  if (previewAudio) {
    try { previewAudio.pause(); } catch {}
    previewAudio = null;
  }
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}
