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
  piperCatalogPromise = fetch(new URL('../vendor/piper/voices.json', import.meta.url))
    .then(r => r.ok ? r.json() : Promise.reject(new Error('catalog missing')))
    .then(data => {
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
      return piperVoices;
    })
    .catch(err => {
      console.warn('Piper catalog could not be loaded', err);
      piperVoices = FALLBACK_PIPER;
      return piperVoices;
    });
  return piperCatalogPromise;
}

export function piperVoiceById(id) {
  const list = getPiperVoices();
  return list.find(v => v.id === id) || list[0];
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

function emitPiperProgress(patch = {}) {
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
  {
    id: 'audiobook-warm', name: 'Audiobook · Warm', voiceId: 'en_US-lessac-high',
    speaker: 0, rate: 0.95, desc: 'Measured, warm American female narration.',
  },
  {
    id: 'audiobook-classic', name: 'Audiobook · Classic', voiceId: 'en_US-ryan-high',
    speaker: 0, rate: 0.95, desc: 'Deep, unhurried American male narrator.',
  },
  {
    id: 'audiobook-british', name: 'Audiobook · British', voiceId: 'en_GB-alan-medium',
    speaker: 0, rate: 0.95, desc: 'Dry British male voice for classic fiction.',
  },
  {
    id: 'audiobook-studio', name: 'Audiobook · Studio', voiceId: 'en_GB-cori-high',
    speaker: 0, rate: 0.97, desc: 'Crisp British female studio read.',
  },
  {
    id: 'studio-female', name: 'Studio · American', voiceId: 'en_US-hfc_female-medium',
    speaker: 0, rate: 1, desc: 'Bright, modern American female voice.',
  },
  {
    id: 'studio-male', name: 'Studio · American male', voiceId: 'en_US-hfc_male-medium',
    speaker: 0, rate: 1, desc: 'Clear, neutral American male voice.',
  },
  {
    id: 'librivox', name: 'LibriVox-style', tag: 'LibriVox',
    voiceId: 'en_US-libritts_r-medium', speaker: 0, rate: 0.96,
    desc: 'Trained on LibriVox audiobooks · 2,306 speakers.',
  },
  /* Cinema-inspired originals. Named by genre, never by a real performer. */
  {
    id: 'cinema-noir', name: 'Cinema · Noir', group: 'cinema',
    voiceId: 'en_US-joe-medium', speaker: 0, rate: 0.9,
    desc: 'Low, world-weary detective narration.',
  },
  {
    id: 'cinema-leading-lady', name: 'Cinema · Leading lady', group: 'cinema',
    voiceId: 'en_US-kristin-medium', speaker: 0, rate: 0.95,
    desc: 'Bright, cinematic American female lead.',
  },
  {
    id: 'cinema-leading-man', name: 'Cinema · Leading man', group: 'cinema',
    voiceId: 'en_US-mike-medium', speaker: 0, rate: 0.95,
    desc: 'Confident, warm American male lead.',
  },
  {
    id: 'cinema-epic', name: 'Cinema · Epic', group: 'cinema',
    voiceId: 'en_US-bryce-medium', speaker: 0, rate: 0.88,
    desc: 'Slow, widescreen trailer narration.',
  },
  {
    id: 'cinema-stage', name: 'Cinema · Stage', group: 'cinema',
    voiceId: 'en_GB-northern_english_male-medium', speaker: 0, rate: 0.9,
    desc: 'Theatrical northern British delivery.',
  },
  /* Character archetypes. Generic genres only — never a real performer. */
  {
    id: 'character-spy', name: 'Character · Suave spy', group: 'character',
    voiceId: 'en_GB-alan-medium', speaker: 0, rate: 0.93,
    desc: 'Smooth, dry British spy-thriller delivery.',
  },
  {
    id: 'character-elder', name: 'Character · Wise elder', group: 'character',
    voiceId: 'en_US-norman-medium', speaker: 0, rate: 0.9,
    desc: 'Calm, weathered storyteller with a measured pace.',
  },
  {
    id: 'character-cool', name: 'Character · West Coast cool', group: 'character',
    voiceId: 'en_US-sam-medium', speaker: 0, rate: 0.94,
    desc: 'Relaxed, laid-back American delivery.',
  },
  {
    id: 'character-anchor', name: 'Character · News anchor', group: 'character',
    voiceId: 'en_US-ljspeech-high', speaker: 0, rate: 1,
    desc: 'Crisp, neutral broadcast read.',
  },
];

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

    emitPiperProgress({
      phase: 'downloading', voiceId: id, voiceName: voice.name, loaded: 0, total, percent: 0, cached: false,
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
    await putCachedVoice(cacheKey, configData, blob);
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

export async function piperGenerate(text, voiceId, speaker = null) {
  await loadPiperCatalog();
  const voice = piperVoiceById(voiceId);
  piperBusy++;
  try {
    const { engine } = await getPiper();
    const sp = speaker == null ? (getPrefs().tts.piperSpeaker || 0) : speaker;
    emitPiperProgress({ phase: 'generating', voiceId: voice.id, voiceName: voice.name, percent: 100 });
    const result = await engine.generate(text, voice.id, Number(sp) || 0);
    return result.file; // WAV Blob
  } finally {
    piperBusy = Math.max(0, piperBusy - 1);
    if (!piperBusy) {
      emitPiperProgress({ phase: 'ready' });
      setTimeout(() => {
        if (!piperBusy && piperProgress.phase === 'ready') {
          emitPiperProgress({ phase: 'idle', loaded: 0, total: 0, percent: 0 });
        }
      }, 1200);
    }
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
    this._audioEl = null;
    this._primed = false;
    this._audioUrl = null;
    this._cache = new Map();
    this._inFlight = new Map();
    this._pauseTimer = null;
    this._wakeLock = null;

    this._onVoices = () => {
      window.dispatchEvent(new CustomEvent('lumen:voices'));
    };
    try { speechSynthesis.addEventListener?.('voiceschanged', this._onVoices); } catch {}
    this._onVisibility = () => {
      if (document.visibilityState === 'visible') this._requestWakeLock();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  get total() { return this.sentences.length; }
  get current() { return this.sentences[this.index] || null; }
  get provider() { return getPrefs().tts.provider; }
  get enabled() { return getPrefs().tts.enabled; }

  /* ── loading ─────────────────────────────────────────────────── */
  load(sentences = [], { autoplay = false, start = 0 } = {}) {
    this._invalidate();
    this.sentences = sentences;
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
    if (this.state === 'paused') {
      if (this.provider === 'system') {
        this._setPlaying();
        this._speakSystemChunk();
      } else if (this._audio) {
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
    this._token++;
    clearTimeout(this._pauseTimer);
    this._pauseTimer = null;
    if (this.provider === 'system') {
      try { speechSynthesis.cancel(); } catch {}
    } else if (this._audio) {
      try { this._audio.pause(); } catch {}
    }
    this._setState('paused');
    this._releaseWakeLock();
  }

  stop({ keepIndex = true } = {}) {
    this._invalidate();
    this._setState('idle');
    if (!keepIndex) this.index = 0;
    this._releaseWakeLock();
  }

  next() {
    if (!this.sentences.length) return;
    const wasPlaying = this.state === 'playing' || this.state === 'loading';
    this._startSentence(Math.min(this.index + 1, this.sentences.length - 1), { autoplay: wasPlaying });
  }

  prev() {
    if (!this.sentences.length) return;
    const wasPlaying = this.state === 'playing' || this.state === 'loading';
    this._startSentence(Math.max(0, this.index - 1), { autoplay: wasPlaying });
  }

  restart() {
    if (!this.sentences.length) return;
    const wasActive = this.state === 'playing' || this.state === 'loading' || this.state === 'paused';
    this._invalidate();
    this._startSentence(this.index, { autoplay: wasActive });
  }

  setRate(rate) {
    setTtsPrefs({ rate });
    if (this.provider !== 'system' && this._audio) {
      try { this._audio.playbackRate = Math.max(0.5, Math.min(2, rate)); } catch {}
    }
  }

  applyVoiceChange() {
    if (this.state === 'playing' || this.state === 'loading') this.restart();
  }

  destroy() {
    this.stop();
    try { speechSynthesis.removeEventListener?.('voiceschanged', this._onVoices); } catch {}
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._clearCache();
    this.sentences = [];
    this._releaseWakeLock();
  }

  /* ── sentence handling ───────────────────────────────────────── */
  _startSentence(i, { autoplay = true, silent = false } = {}) {
    if (!this.sentences[i]) return;
    this._invalidate();
    this.index = i;
    const sentence = this.sentences[i];
    this.onSentence(sentence, i, { silent });
    if (!autoplay) { this._setState('idle'); return; }

    const text = cleanForSpeech(sentence.text);
    if (!text) { this._advanceSentence(); return; }

    this._chunks = splitLongText(text, this.provider === 'piper' ? 800 : 240);
    this._chunkIndex = 0;
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
    const voice = findVoice(prefs.voiceURI) || englishVoices()[0] || null;
    if (voice) { utter.voice = voice; utter.lang = voice.lang; }
    utter.rate = clampNum(prefs.rate, 0.5, 2);
    utter.pitch = clampNum(prefs.pitch, 0, 2);
    utter.volume = clampNum(prefs.volume ?? 0.9, 0, 1);

    utter.onend = () => {
      if (token !== this._token) return;
      this._advanceChunk();
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
    this._setState('loading');
    let entry;
    try {
      entry = await this._getAudio(chunk);
    } catch (err) {
      if (token !== this._token) return;
      this._fail(err.message || 'The voice could not be generated.');
      return;
    }
    if (token !== this._token) return;

    const prefs = getPrefs().tts;
    const audio = this._audioEl || new Audio();
    audio.src = entry.url;
    this._audio = audio;
    this._audioUrl = entry.url;
    audio.volume = clampNum(prefs.volume ?? 0.9, 0, 1);
    audio.playbackRate = clampNum(prefs.rate, 0.5, 2);
    audio.preservesPitch = true;
    audio.onended = () => {
      if (token !== this._token) return;
      this._audio = null;
      this._advanceChunk();
    };
    audio.onerror = () => {
      if (token !== this._token) return;
      this._fail('The generated audio could not be played.');
    };
    try {
      await audio.play();
      if (token !== this._token) { audio.pause(); return; }
      this._setState('playing');
      this._requestWakeLock();
    } catch {
      if (token !== this._token) return;
      this._fail('Your browser blocked audio playback. Tap play once more.');
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
      this._setState('idle');
      this._releaseWakeLock();
      this.onEnd();
      return;
    }
    const next = this.index + 1;
    const pauseMs = Math.round(clampNum(getPrefs().tts.sentencePause ?? 0.2, 0, 1.5) * 1000);
    if (pauseMs > 0) {
      const token = this._token;
      clearTimeout(this._pauseTimer);
      this._pauseTimer = setTimeout(() => {
        if (token !== this._token) return;
        this._startSentence(next, { autoplay: true });
      }, pauseMs);
    } else {
      this._startSentence(next, { autoplay: true });
    }
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

  _fail(message) {
    this._invalidate();
    this._setState('idle');
    this._releaseWakeLock();
    this.onError(message);
  }

  _invalidate() {
    this._token++;
    clearTimeout(this._pauseTimer);
    this._pauseTimer = null;
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
    return `${tts.provider}|${tts.provider === 'piper' ? tts.piperVoice : tts.voiceURI}|${tts.rate}|${text}`;
  }

  async _getAudio(text) {
    if (this.provider !== 'piper') throw new Error('No neural voice is selected.');
    const key = this._cacheKey(text);
    const hit = this._cache.get(key);
    if (hit) { hit.at = Date.now(); return hit; }
    if (this._inFlight.has(key)) return this._inFlight.get(key);

    const tts = getPrefs().tts;
    const promise = piperGenerate(text, tts.piperVoice, tts.piperSpeaker)
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const entry = { url, at: Date.now() };
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
    // Queue the next two sentences so first-time generation has a head start.
    for (let d = 1; d <= 2; d++) {
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
    if (this._cache.size <= 18) return;
    const entries = [...this._cache.entries()].sort((a, b) => a[1].at - b[1].at);
    while (this._cache.size > 14 && entries.length) {
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

/* ── One-off preview used by settings / voice picker ───────────────── */
let previewAudio = null;
let previewUrl = null;

export function stopPreview() {
  try { speechSynthesis.cancel(); } catch {}
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
  if (!tts.enabled) return;
  if (tts.provider === 'system') {
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

  // Unlock this audio element inside the tap, before the long generation.
  const audio = new Audio(silentAudioSrc());
  previewAudio = audio;
  audio.volume = 0.0001;
  const unlock = audio.play().catch(() => {});

  const blob = await piperGenerate(text, tts.piperVoice, tts.piperSpeaker);
  if (previewAudio !== audio) return; // the preview was cancelled meanwhile
  try { await unlock; } catch {}
  try { audio.pause(); audio.currentTime = 0; } catch {}

  previewUrl = URL.createObjectURL(blob);
  audio.src = previewUrl;
  audio.volume = clampNum(tts.volume ?? 0.9, 0, 1);
  audio.playbackRate = clampNum(tts.rate, 0.5, 2);
  audio.preservesPitch = true;
  audio.onended = () => { clearPreviewAudio(); };
  await audio.play();
}

function clearPreviewAudio() {
  if (previewAudio) {
    try { previewAudio.pause(); } catch {}
    previewAudio = null;
  }
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}
