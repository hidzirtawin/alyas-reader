/* Narration engine.
   - system: Web Speech API (free, offline, instant)
   - openai / elevenlabs: neural audio via the local TTS proxy
   - narration can be switched off entirely in preferences. */

import { getPrefs, setTtsPrefs } from './prefs.js';
import { splitLongText } from './util.js';

const PREFERRED = [
  'samantha', 'ava', 'serena', 'daniel', 'karen', 'moira', 'tessa', 'alex',
  'google us english', 'google uk english female', 'aria', 'jenny', 'guy', 'sonia',
];

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

export function describeVoice() {
  const tts = getPrefs().tts;
  if (!tts.enabled) return 'Silent reading';
  if (tts.provider === 'outloud') return `Out Loud · ${outLoudVoiceName(tts.outloudVoice)}`;
  if (tts.provider === 'openai') return `OpenAI · ${cap(tts.openaiVoice)}`;
  if (tts.provider === 'elevenlabs') return `ElevenLabs · ${elevenPresetName(tts.elevenVoice)}`;
  const v = findVoice(tts.voiceURI) || englishVoices()[0];
  return v ? `System · ${v.name}` : 'System voice';
}

/* ── Out Loud (local app on 127.0.0.1:51730) ─────────────────────── */
export const OUTLOUD_DEFAULT_VOICE = 'af_heart';
let outLoudCache = null;
let outLoudSource = null;

export function outLoudVoiceName(id = '') {
  if (!id) return 'Heart';
  if (/[*+]/.test(id)) return 'Custom blend';
  const hit = outLoudCache?.find(v => v.id === id);
  if (hit) return hit.name || cap(id.split('_')[1] || id);
  const tail = id.split('_').slice(1).join(' ');
  return tail ? cap(tail) : cap(id);
}

export function cachedOutLoudVoices() {
  return outLoudCache;
}

export function outLoudEndpointSource() {
  return outLoudSource;
}

export async function fetchOutLoudVoices({ force = false } = {}) {
  if (outLoudCache && !force) return outLoudCache;
  const endpoints = [
    '/api/outloud/voices',
    'http://127.0.0.1:51730/api/v1/audio/voices',
    'http://localhost:51730/api/v1/audio/voices',
  ];
  let proxyDown = false;
  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (res.status === 502 || res.status === 503) {
        proxyDown = true;
        break;
      }
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data.voices) && data.voices.length) {
        outLoudCache = data.voices;
        outLoudSource = url;
        return outLoudCache;
      }
    } catch {
      clearTimeout(timer);
    }
  }
  if (proxyDown) throw new Error('Out Loud is not running. Open the Out Loud app, then try again.');
  throw new Error('Out Loud was not detected. Open the Out Loud app, then try again.');
}

export const ELEVEN_PRESETS = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh' },
];

export function elevenPresetName(id) {
  const found = ELEVEN_PRESETS.find(p => p.id === id);
  return found ? found.name : 'Custom voice';
}

const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

export function cleanForSpeech(text = '') {
  return String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/https?:\/\/\S+/gi, 'a link')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
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
    this._audioUrl = null;
    this._cache = new Map();
    this._inFlight = new Map();
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
    this._emitState('idle');
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
    this._startSentence(this.index);
  }

  pause() {
    if (this.state !== 'playing' && this.state !== 'loading') return;
    this._token++;
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
    const tts = { rate };
    setTtsPrefs(tts);
    if (this.provider !== 'system' && this._audio) {
      try { this._audio.playbackRate = Math.max(0.5, Math.min(4, rate)); } catch {}
    }
  }

  applyVoiceChange() {
    if (this.state === 'playing' || this.state === 'loading') {
      this.restart();
    }
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

    const cloud = this.provider !== 'system';
    this._chunks = splitLongText(text, cloud ? 1800 : 240);
    this._chunkIndex = 0;
    this._setPlaying();
    this._speakChunk();
    this._prefetch(i);
  }

  _speakChunk() {
    if (!this._chunks.length) { this._advanceSentence(); return; }
    const chunk = this._chunks[this._chunkIndex];
    if (this.provider === 'system') this._speakSystemChunk(chunk);
    else this._speakCloudChunk(chunk);
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
    }, 30);
  }

  async _speakCloudChunk(chunk) {
    const token = ++this._token;
    this._setState('loading');
    let entry;
    try {
      entry = await this._getAudio(chunk);
    } catch (err) {
      if (token !== this._token) return;
      this._fail(err.message || 'Could not generate the audio.');
      return;
    }
    if (token !== this._token) return;

    const audio = new Audio(entry.url);
    this._audio = audio;
    this._audioUrl = entry.url;
    audio.volume = clampNum(getPrefs().tts.volume ?? 0.9, 0, 1);
    if (this.provider === 'elevenlabs') {
      const rate = clampNum(getPrefs().tts.rate, 0.5, 2);
      audio.playbackRate = rate;
    }
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
    } catch (err) {
      if (token !== this._token) return;
      this._fail('Your browser blocked audio playback. Tap play once more.');
    }
  }

  _advanceChunk() {
    if (this._chunkIndex + 1 < this._chunks.length) {
      this._chunkIndex++;
      this._speakChunk();
      this._prefetch(this.index);
    } else {
      this._advanceSentence();
    }
  }

  _advanceSentence() {
    if (this.index + 1 >= this.sentences.length) {
      this._token++;
      this._setState('idle');
      this._releaseWakeLock();
      this.onEnd();
      return;
    }
    this._startSentence(this.index + 1, { autoplay: true });
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

  _emitState(state) { this._setState(state); }

  _fail(message) {
    this._invalidate();
    this._setState('idle');
    this._releaseWakeLock();
    this.onError(message);
  }

  _invalidate() {
    this._token++;
    try { speechSynthesis.cancel(); } catch {}
    if (this._audio) {
      try { this._audio.pause(); } catch {}
      this._audio.onended = null;
      this._audio.onerror = null;
      this._audio = null;
    }
  }

  /* ── cloud audio fetch / cache ───────────────────────────────── */
  _cacheKey(text) {
    const tts = getPrefs().tts;
    const voice = tts.provider === 'openai'
      ? tts.openaiVoice
      : tts.provider === 'outloud'
        ? tts.outloudVoice || OUTLOUD_DEFAULT_VOICE
        : tts.elevenVoice;
    const model = tts.provider === 'openai'
      ? tts.openaiModel
      : tts.provider === 'outloud' ? 'kokoro' : tts.elevenModel;
    return `${tts.provider}|${voice}|${model}|${tts.rate}|${text}`;
  }

  async _getAudio(text) {
    const key = this._cacheKey(text);
    const hit = this._cache.get(key);
    if (hit) { hit.at = Date.now(); return hit; }
    if (this._inFlight.has(key)) return this._inFlight.get(key);

    const tts = getPrefs().tts;
    const needsKey = tts.provider === 'openai' || tts.provider === 'elevenlabs';
    const keyName = tts.provider === 'openai' ? tts.openaiKey : tts.elevenKey;
    if (needsKey && !keyName) throw new Error(`Add your ${tts.provider === 'openai' ? 'OpenAI' : 'ElevenLabs'} API key in Voice settings.`);

    const promise = requestVoiceAudio(tts, text)
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
    if (this.provider === 'system') return;
    const tts = getPrefs().tts;
    const needsKey = tts.provider === 'openai' || tts.provider === 'elevenlabs';
    if (needsKey && !(tts.provider === 'openai' ? tts.openaiKey : tts.elevenKey)) return;
    const next = this.sentences[sentenceIndex + 1];
    if (!next) return;
    const text = cleanForSpeech(next.text);
    if (!text) return;
    const key = this._cacheKey(text.slice(0, 1800));
    if (this._cache.has(key) || this._inFlight.has(key)) return;
    this._getAudio(splitLongText(text, 1800)[0]).catch(() => {});
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

/* ── Cloud voice request ───────────────────────────────────────────
   Locally, audio is generated through /api/tts so the key stays on the
   device and never crosses CORS. On static hosts (GitHub Pages) that
   endpoint does not exist, so we fall back to a direct provider request.
   Both providers explicitly allow browser CORS. */

function voicePayload(tts, text) {
  if (tts.provider === 'outloud') {
    return {
      provider: 'outloud',
      text,
      speed: tts.rate,
      voice: tts.outloudVoice || OUTLOUD_DEFAULT_VOICE,
    };
  }
  return {
    provider: tts.provider,
    key: tts.provider === 'openai' ? tts.openaiKey : tts.elevenKey,
    text,
    speed: tts.rate,
    instructions: tts.instructions,
    model: tts.provider === 'openai' ? tts.openaiModel : tts.elevenModel,
    voice: tts.provider === 'openai' ? tts.openaiVoice : tts.elevenVoice,
  };
}

async function voiceError(res) {
  let msg = `Voice generation failed (${res.status}).`;
  try {
    const data = await res.json();
    const detail = data?.error?.message || data?.detail?.message || data?.detail || data?.message || (typeof data?.error === 'string' ? data.error : null);
    if (typeof detail === 'string' && detail.trim()) msg = detail.trim().slice(0, 400);
  } catch {}
  if (res.status === 401 || res.status === 403) msg = 'The API key was rejected. Check it in Voice settings.';
  if (res.status === 429) msg = 'The voice provider’s rate limit or allowance was reached. Try again later.';
  return new Error(msg);
}

async function directVoiceRequest(tts, body) {
  if (tts.provider === 'outloud') {
    const payload = {
      voice: body.voice,
      input: body.text,
      speed: body.speed,
      response_format: 'mp3',
    };
    let lastError = null;
    for (const base of ['http://127.0.0.1:51730', 'http://localhost:51730']) {
      try {
        return await fetch(`${base}/api/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Out Loud is not reachable.');
  }
  if (tts.provider === 'openai') {
    const payload = {
      model: body.model,
      voice: body.voice,
      input: body.text,
      speed: body.speed,
      response_format: 'mp3',
    };
    if (body.model === 'gpt-4o-mini-tts' && body.instructions) payload.instructions = body.instructions;
    return fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${body.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }
  return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(body.voice)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: {
      'xi-api-key': body.key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: body.text,
      model_id: body.model,
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.15,
        use_speaker_boost: true,
      },
    }),
  });
}

async function requestVoiceAudio(tts, text) {
  const body = voicePayload(tts, text);
  let res = null;
  try {
    res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {}

  const type = (res?.headers.get('content-type') || '').toLowerCase();
  const fromProxy = res && res.ok && /audio|octet-stream/.test(type);
  if (!fromProxy) {
    if (res && !res.ok && ![404, 405, 501].includes(res.status)) throw await voiceError(res);
    try {
      res = await directVoiceRequest(tts, body);
    } catch (err) {
      const hint = tts.provider === 'outloud'
        ? 'Open the Out Loud app and try again. On the hosted site, browser security may block localhost access — use the local version for Out Loud voices.'
        : tts.provider === 'openai'
          ? 'OpenAI voices are most reliable through the local server. On a static host, use system voices or ElevenLabs.'
          : 'Check your connection and API key.';
      throw new Error(`Could not reach the voice provider. ${hint}`);
    }
  }

  if (!res.ok) throw await voiceError(res);
  const blob = await res.blob();
  if (!blob.size) throw new Error('The voice service returned empty audio.');
  return blob;
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
  const needsKey = tts.provider === 'openai' || tts.provider === 'elevenlabs';
  const key = tts.provider === 'openai' ? tts.openaiKey : tts.elevenKey;
  if (needsKey && !key) throw new Error(`Add your ${tts.provider === 'openai' ? 'OpenAI' : 'ElevenLabs'} API key first.`);
  const blob = await requestVoiceAudio(tts, text);
  previewUrl = URL.createObjectURL(blob);
  previewAudio = new Audio(previewUrl);
  previewAudio.volume = clampNum(tts.volume ?? 0.9, 0, 1);
  previewAudio.playbackRate = tts.provider === 'elevenlabs' ? clampNum(tts.rate, 0.5, 2) : 1;
  previewAudio.onended = () => { clearPreviewAudio(); };
  await previewAudio.play();
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
