/* Preferences: persisted in localStorage, applied to the document. */

const KEY = 'lumen.prefs.v1';

export const FONTS = [
  { id: 'literata', name: 'Literata', stack: "'Literata', Georgia, 'Times New Roman', serif", note: 'Bookish' },
  { id: 'merriweather', name: 'Merriweather', stack: "'Merriweather', Georgia, serif", note: 'Sturdy serif' },
  { id: 'lora', name: 'Lora', stack: "'Lora', Georgia, serif", note: 'Story serif' },
  { id: 'ebgaramond', name: 'EB Garamond', stack: "'EB Garamond', 'Iowan Old Style', Georgia, serif", note: 'Old-style' },
  { id: 'librebaskerville', name: 'Libre Baskerville', stack: "'Libre Baskerville', Georgia, serif", note: 'Book classic' },
  { id: 'sourceserif', name: 'Source Serif 4', stack: "'Source Serif 4', Georgia, serif", note: 'Editorial' },
  { id: 'georgia', name: 'Georgia', stack: "Georgia, 'Iowan Old Style', 'Times New Roman', serif", note: 'Classic' },
  { id: 'palatino', name: 'Palatino', stack: "'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif", note: 'Warm' },
  { id: 'atkinson', name: 'Atkinson', stack: "'Atkinson Hyperlegible', Verdana, sans-serif", note: 'Clear' },
  { id: 'lexend', name: 'Lexend', stack: "'Lexend', Verdana, sans-serif", note: 'Readable sans' },
  { id: 'inter', name: 'Inter', stack: "'Inter', -apple-system, system-ui, sans-serif", note: 'Modern' },
  { id: 'opendyslexic', name: 'OpenDyslexic', stack: "'OpenDyslexic', Verdana, sans-serif", note: 'Dyslexia-friendly' },
  { id: 'system', name: 'System', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", note: 'Native' },
];

export const THEMES = [
  { id: 'paper', name: 'Paper', sw: 'sw-paper' },
  { id: 'sepia', name: 'Sepia', sw: 'sw-sepia' },
  { id: 'night', name: 'Night', sw: 'sw-night' },
  { id: 'black', name: 'Black', sw: 'sw-black' },
];

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const DEFAULTS = {
  theme: 'paper',
  librarySort: 'recent',
  reader: {
    font: 'literata',
    size: 19,
    lineHeight: 1.68,
    measure: 680,
    justify: false,
    hyphens: true,
    para: 0.95,
    indent: 0,
    letterSpacing: 0,
    wordSpacing: 0,
  },
  tts: {
    enabled: true,
    provider: 'piper',
    piperVoice: 'en_US-libritts_r-medium',
    piperSpeaker: 0,
    voiceURI: '',
    rate: 0.96,
    pitch: 1,
    volume: 0.9,
    autoLanguageVoice: true,
    highlight: true,
    sentencePause: 0.2,
  },
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (isObject(v) && isObject(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function load() {
  let merged;
  try {
    merged = merge(DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    merged = merge(DEFAULTS, {});
  }
  // Migrate older provider settings to the free local engine.
  const old = merged.tts || {};
  // The old bundled default was Lessac; move that (and blank values) to the
  // new audiobook narrator. An explicitly chosen Piper voice is kept.
  const useNewDefault = !old.piperVoice || old.piperVoice === 'en_US-lessac-medium';
  const provider = 'piper';
  merged.tts = {
    enabled: old.enabled !== false,
    provider,
    piperVoice: useNewDefault ? DEFAULTS.tts.piperVoice : old.piperVoice,
    piperSpeaker: Number.isFinite(Number(old.piperSpeaker)) ? Number(old.piperSpeaker) : 0,
    voiceURI: typeof old.voiceURI === 'string' ? old.voiceURI : '',
    rate: Number.isFinite(Number(old.rate)) ? Number(old.rate) : DEFAULTS.tts.rate,
    pitch: Number.isFinite(Number(old.pitch)) ? Number(old.pitch) : 1,
    volume: Number.isFinite(Number(old.volume)) ? Number(old.volume) : 0.9,
    autoLanguageVoice: old.autoLanguageVoice !== false,
    highlight: old.highlight !== false,
    sentencePause: Number.isFinite(Number(old.sentencePause)) ? Number(old.sentencePause) : 0.2,
  };
  return merged;
}

export const DEFAULT_READER = { ...DEFAULTS.reader };

/* One tap: a comfortable setup for dyslexic readers. */
export const DYSLEXIA_READER = {
  font: 'opendyslexic',
  size: 21,
  lineHeight: 1.95,
  measure: 640,
  justify: false,
  hyphens: false,
  para: 1.1,
  indent: 0,
  letterSpacing: 0.035,
  wordSpacing: 0.16,
};

let prefs = load();
const listeners = new Set();

export function getPrefs() {
  return prefs;
}

export function savePrefs(patch, { silent = false } = {}) {
  prefs = merge(prefs, patch);
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
  applyPrefs();
  if (!silent) listeners.forEach(fn => fn(prefs));
  window.dispatchEvent(new CustomEvent('lumen:prefs', { detail: prefs }));
  return prefs;
}

export function onPrefs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setReaderPrefs(patch) {
  return savePrefs({ reader: patch });
}

export function setTtsPrefs(patch) {
  return savePrefs({ tts: patch });
}

export function fontById(id) {
  return FONTS.find(f => f.id === id) || FONTS[0];
}

export function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme || 'paper';
  const r = prefs.reader;
  root.style.setProperty('--reader-font', fontById(r.font).stack);
  root.style.setProperty('--reader-size', `${r.size}px`);
  root.style.setProperty('--reader-lh', String(r.lineHeight));
  root.style.setProperty('--reader-measure', `${r.measure}px`);
  root.style.setProperty('--reader-justify', r.justify ? 'justify' : 'left');
  root.style.setProperty('--reader-hyphens', r.hyphens ? 'auto' : 'manual');
  root.style.setProperty('--reader-para', `${r.para}em`);
  root.style.setProperty('--reader-letter-spacing', `${Number(r.letterSpacing) || 0}em`);
  root.style.setProperty('--reader-word-spacing', `${Number(r.wordSpacing) || 0}em`);
  root.style.setProperty('--reader-indent', `${r.indent}em`);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', prefs.theme === 'paper' || prefs.theme === 'sepia' ? '#1b1814' : '#0d0f11');
}

export function cycleSpeed(current) {
  const idx = SPEEDS.findIndex(s => Math.abs(s - current) < 0.01);
  return SPEEDS[(idx + 1) % SPEEDS.length];
}
