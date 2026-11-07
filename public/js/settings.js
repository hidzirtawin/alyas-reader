/* Settings: appearance, reading comfort, narration, data. */

import { db } from './db.js';
import {
  getPrefs, savePrefs, setReaderPrefs, FONTS, THEMES, DEFAULT_READER,
} from './prefs.js';
import {
  englishVoices, findVoice, previewSpeech, stopPreview, describeVoice,
  ELEVEN_PRESETS,
} from './tts.js';
import {
  modal, toast, confirmDialog,
} from './ui.js';
import {
  $, esc, icon, clamp, formatBytes, downloadBlob,
} from './util.js';

export function renderSettings(app) {
  const view = $('#view');
  if (!view) return;
  const prefs = getPrefs();
  const r = prefs.reader;
  const tts = prefs.tts;
  const counts = app.counts || { books: app.books.length, bookmarks: 0, highlights: 0 };
  const storage = app.storage || { used: 0, quota: 0 };
  const usedPct = storage.quota ? clamp((storage.used / storage.quota) * 100, 0.5, 100) : 0;
  const voiceName = describeVoice();
  const voiceSub = tts.enabled
    ? (tts.provider === 'system'
      ? 'Free · reads on this device'
      : tts.provider === 'openai' ? 'Neural · OpenAI API key' : 'Neural · ElevenLabs API key')
    : 'Text only · no narration';

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Make Alya’s Reader yours</h2>
        <p>Small choices that make a long read feel effortless. Everything is saved automatically.</p>
      </div>
    </div>
    <div class="settings-grid">
      <div class="settings-col">

        <section class="panel set-card">
          <h3>Appearance</h3>
          <p class="set-desc">The mood of the page — and the shape of the words.</p>
          <div class="set-body">
            <div>
              <div class="field-label" style="margin-bottom:9px">Theme</div>
              <div class="theme-options">
                ${THEMES.map(t => `
                  <button class="theme-card${prefs.theme === t.id ? ' is-active' : ''}" data-set-theme="${t.id}" aria-pressed="${prefs.theme === t.id}">
                    <span class="swatch ${t.sw}">Aa</span>
                    <span>${t.name}</span>
                  </button>`).join('')}
              </div>
            </div>
            <div>
              <div class="field-label" style="margin-bottom:9px">Typeface</div>
              <div class="font-options">
                ${FONTS.map(f => `
                  <button class="font-btn${r.font === f.id ? ' is-active' : ''}" data-set-font="${f.id}" aria-pressed="${r.font === f.id}">
                    <span class="aa" style="font-family:${f.stack}">Aa</span>
                    <span class="nm">${f.name}</span>
                  </button>`).join('')}
              </div>
            </div>
            <div>
              <div class="set-row"><span class="set-label">Text size</span><output id="sizeOut">${r.size} px</output></div>
              <input class="range" id="setSize" type="range" min="14" max="28" step="1" value="${r.size}" aria-label="Text size">
            </div>
            <div class="sample-card" aria-hidden="true">
              <div class="sample-cap"><span>Preview</span><span id="sampleMeta">${fontName(r.font)} · ${r.size}px</span></div>
              <p>There is a particular quiet that arrives when a story takes hold — the room recedes, and the page becomes the whole world.</p>
              <p>Alya’s Reader keeps that quiet. Set the type, soften the light, and stay a while.</p>
            </div>
          </div>
        </section>

        <section class="panel set-card">
          <h3>Voice &amp; narration</h3>
          <p class="set-desc">Listen with a free system voice, a studio voice, or read silently.</p>
          <div class="set-body">
            <div class="set-row">
              <div>
                <div class="set-label">Read aloud</div>
                <div class="set-sub">${tts.enabled ? 'Narration controls appear in the reader.' : 'Silent reading — the reader stays text-only.'}</div>
              </div>
              <label class="switch">
                <input type="checkbox" id="setNarration" ${tts.enabled ? 'checked' : ''}>
                <span class="track"></span>
              </label>
            </div>
            <div class="voice-summary">
              <div class="vico">${icon(tts.enabled ? 'headphones' : 'eye-off')}</div>
              <div class="vtxt"><strong>${esc(voiceName)}</strong><span>${esc(voiceSub)}</span></div>
              <button class="btn btn-sm" data-open-voice>Configure</button>
            </div>
            <div id="voiceDetails"${tts.enabled ? '' : ' style="display:none"'} >
              <div class="set-row" style="margin-bottom:6px"><span class="set-label">Default speed</span><output id="ttsSpeedOut">${tts.rate.toFixed(2)}×</output></div>
              <input class="range" id="setTtsSpeed" type="range" min="0.5" max="2" step="0.05" value="${tts.rate}" aria-label="Default narration speed">
              <label class="switch" style="margin-top:12px">
                <input type="checkbox" id="setAutoAdvance" ${tts.autoAdvance ? 'checked' : ''}>
                <span class="track"></span><span class="switch-label">Continue to the next chapter</span>
              </label>
              <label class="switch" style="margin-top:10px">
                <input type="checkbox" id="setHighlight" ${tts.highlight ? 'checked' : ''}>
                <span class="track"></span><span class="switch-label">Highlight the sentence being read</span>
              </label>
              <div style="margin-top:14px"><button class="btn btn-sm" data-preview-voice>${icon('volume')} Hear a sample</button></div>
            </div>
            <p class="hint">System voices are free and instant. OpenAI and ElevenLabs voices need an API key, stored only in this browser and sent only to the provider you choose.</p>
          </div>
        </section>
      </div>

      <div class="settings-col">
        <section class="panel set-card">
          <h3>Reading comfort</h3>
          <p class="set-desc">Fine-tune the rhythm of the page.</p>
          <div class="set-body">
            <div>
              <div class="set-row"><span class="set-label">Line height</span><output id="lhOut">${r.lineHeight.toFixed(2)}</output></div>
              <input class="range" id="setLineHeight" type="range" min="1.3" max="2.1" step="0.02" value="${r.lineHeight}" aria-label="Line height">
            </div>
            <div>
              <div class="set-row"><span class="set-label">Text width</span><output id="measureOut">${r.measure} px</output></div>
              <input class="range" id="setMeasure" type="range" min="480" max="900" step="20" value="${r.measure}" aria-label="Text width">
            </div>
            <div>
              <div class="set-row"><span class="set-label">Paragraph spacing</span><output id="paraOut">${r.para.toFixed(2)} em</output></div>
              <input class="range" id="setPara" type="range" min="0.4" max="1.6" step="0.05" value="${r.para}" aria-label="Paragraph spacing">
            </div>
            <div class="divider"></div>
            <label class="switch">
              <input type="checkbox" id="setJustify" ${r.justify ? 'checked' : ''}>
              <span class="track"></span><span class="switch-label">Justify text</span>
            </label>
            <label class="switch">
              <input type="checkbox" id="setHyphens" ${r.hyphens ? 'checked' : ''}>
              <span class="track"></span><span class="switch-label">Hyphenate long lines</span>
            </label>
            <div class="divider"></div>
            <button class="btn btn-sm" id="resetReader">${icon('refresh')} Reset reading appearance</button>
          </div>
        </section>

        <section class="panel set-card">
          <h3>Your data</h3>
          <p class="set-desc">Local, private, and yours to keep.</p>
          <div class="set-body">
            <div class="storage-card">
              <div class="storage-ring">
                <svg viewBox="0 0 64 64" aria-hidden="true">
                  <circle class="bg" cx="32" cy="32" r="26"></circle>
                  <circle class="fg" cx="32" cy="32" r="26" stroke-dasharray="163.36" stroke-dashoffset="${163.36 * (1 - usedPct / 100)}"></circle>
                </svg>
                <span>${formatBytes(storage.used)}</span>
              </div>
              <div>
                <div class="set-label">${storage.quota ? `${Math.round(usedPct)}% of available browser storage` : 'Local browser storage'}</div>
                <div class="set-sub">${counts.books} ${counts.books === 1 ? 'book' : 'books'} · ${counts.bookmarks} bookmarks · ${counts.highlights} highlights</div>
              </div>
            </div>
            <div class="callout" style="display:flex;gap:9px;padding:10px 12px;border-radius:9px;background:var(--surface-2);font-size:11px;line-height:1.5;color:var(--ink-2)">
              ${icon('shield')}
              <span>Files are saved in this browser’s local database. They are never uploaded to Alya’s Reader or anyone else.</span>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-sm" id="exportData">${icon('download')} Export notes &amp; data</button>
            </div>
            <div class="divider"></div>
            <button class="btn btn-sm btn-danger" id="clearLibrary">${icon('trash')} Delete all books &amp; marks</button>
          </div>
        </section>

        <section class="panel set-card">
          <h3>About Alya’s Reader</h3>
          <p class="set-desc">A calm, local-first reading room.</p>
          <div class="set-body">
            <div class="set-row">
              <div><div class="set-label">Keyboard shortcuts</div><div class="set-sub">Move through a book without leaving the page.</div></div>
              <button class="btn btn-sm" id="showShortcuts">${icon('keyboard')} View</button>
            </div>
            <div class="divider"></div>
            <p class="hint" style="line-height:1.65">EPUB rendering, PDF.js, Mammoth and JSZip run entirely on your device. Natural narration uses your operating system’s voices, or an optional neural voice key that never leaves your browser except to reach its provider.</p>
            <p class="hint">Alya’s Reader · version 1.0</p>
          </div>
        </section>
      </div>
    </div>
  `;

  view.onclick = e => onSettingsClick(app, e);
  view.oninput = e => onSettingsInput(app, e);
  view.onchange = e => onSettingsChange(app, e);
}

function fontName(id) {
  return FONTS.find(f => f.id === id)?.name || 'Literata';
}

function onSettingsClick(app, e) {
  const theme = e.target.closest('[data-set-theme]');
  if (theme) { savePrefs({ theme: theme.dataset.setTheme }); renderSettings(app); return; }
  const font = e.target.closest('[data-set-font]');
  if (font) { setReaderPrefs({ font: font.dataset.setFont }); renderSettings(app); return; }

  if (e.target.closest('[data-open-voice]')) {
    openVoiceModal({ onSaved: () => renderSettings(app) });
    return;
  }
  if (e.target.closest('[data-preview-voice]')) {
    const btn = e.target.closest('[data-preview-voice]');
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.innerHTML = `<span class="busy-dot"></span> Playing…`;
    window.lumen?.pauseTTS?.();
    previewSpeech(getPrefs().tts)
      .catch(err => toast(err.message || 'Could not play the sample.', 'err'))
      .finally(() => { btn.disabled = false; btn.innerHTML = old; });
    return;
  }
  if (e.target.closest('#resetReader')) {
    setReaderPrefs({ ...DEFAULT_READER });
    savePrefs({ theme: 'paper' });
    renderSettings(app);
    toast('Reading appearance reset', 'ok');
    return;
  }
  if (e.target.closest('#showShortcuts')) { app.showShortcuts?.(); return; }
  if (e.target.closest('#exportData')) { exportData(app); return; }
  if (e.target.closest('#clearLibrary')) {
    confirmDialog({
      title: 'Delete all books and marks?',
      message: 'Every uploaded file, reading position, bookmark and highlight will be erased from this browser. Your settings are kept.',
      confirmLabel: 'Delete everything',
    }).then(async ok => {
      if (!ok) return;
      await db.clearAll();
      app.bookmarks = [];
      app.highlights = [];
      app.progress.clear();
      await app.reload();
      toast('Library cleared', 'ok');
    });
  }
}

function onSettingsInput(app, e) {
  const id = e.target.id;
  if (!id) return;
  if (id === 'setSize') {
    const v = Number(e.target.value);
    setReaderPrefs({ size: v });
    $('#sizeOut').textContent = `${v} px`;
    $('#sampleMeta').textContent = `${fontName(getPrefs().reader.font)} · ${v}px`;
    return;
  }
  if (id === 'setLineHeight') {
    const v = Number(e.target.value);
    setReaderPrefs({ lineHeight: v });
    $('#lhOut').textContent = v.toFixed(2);
    return;
  }
  if (id === 'setMeasure') {
    const v = Number(e.target.value);
    setReaderPrefs({ measure: v });
    $('#measureOut').textContent = `${v} px`;
    return;
  }
  if (id === 'setPara') {
    const v = Number(e.target.value);
    setReaderPrefs({ para: v });
    $('#paraOut').textContent = `${v.toFixed(2)} em`;
    return;
  }
  if (id === 'setTtsSpeed') {
    const v = Number(e.target.value);
    savePrefs({ tts: { rate: v } }, { silent: true });
    $('#ttsSpeedOut').textContent = `${v.toFixed(2)}×`;
  }
}

function onSettingsChange(app, e) {
  const id = e.target.id;
  if (!id) return;
  if (id === 'setNarration') {
    savePrefs({ tts: { enabled: e.target.checked } });
    renderSettings(app);
    toast(e.target.checked ? 'Narration on' : 'Silent reading on', 'ok');
    return;
  }
  if (id === 'setJustify') { setReaderPrefs({ justify: e.target.checked }); return; }
  if (id === 'setHyphens') { setReaderPrefs({ hyphens: e.target.checked }); return; }
  if (id === 'setAutoAdvance') { savePrefs({ tts: { autoAdvance: e.target.checked } }, { silent: true }); return; }
  if (id === 'setHighlight') { savePrefs({ tts: { highlight: e.target.checked } }, { silent: true }); return; }
}

/* ── Export ───────────────────────────────────────────────────────── */
function exportData(app) {
  try {
    const prefs = getPrefs();
    const safeTts = { ...prefs.tts };
    delete safeTts.openaiKey;
    delete safeTts.elevenKey;
    const payload = {
      app: 'Alya’s Reader',
      version: 1,
      exportedAt: new Date().toISOString(),
      note: 'This backup contains metadata, reading positions, bookmarks and notes. Original book files are not included.',
      books: app.books.map(b => ({
        id: b.id, title: b.title, author: b.author, format: b.format,
        fileName: b.fileName, size: b.size, addedAt: b.addedAt, lastOpenedAt: b.lastOpenedAt,
      })),
      progress: [...app.progress.values()],
      bookmarks: app.bookmarks,
      highlights: app.highlights,
      settings: { theme: prefs.theme, reader: prefs.reader, tts: safeTts },
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `alyas-reader-notes-${new Date().toISOString().slice(0, 10)}.json`);
    toast('Notes and data exported', 'ok');
  } catch (err) {
    toast(err.message || 'Could not export.', 'err');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Voice picker
   ═══════════════════════════════════════════════════════════════════ */

export function openVoiceModal({ onSaved } = {}) {
  window.lumen?.pauseTTS?.();
  stopPreview();

  const original = getPrefs().tts;
  const draft = JSON.parse(JSON.stringify(original));
  let tab = draft.enabled ? draft.provider : 'silent';

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="provider-tabs" role="tablist" aria-label="Narration mode">
      <button class="provider-tab" data-tab="silent" role="tab">${icon('eye-off')} Silent</button>
      <button class="provider-tab" data-tab="system" role="tab">${icon('volume')} System</button>
      <button class="provider-tab" data-tab="openai" role="tab">${icon('sparkles')} OpenAI <span class="tag">AI</span></button>
      <button class="provider-tab" data-tab="elevenlabs" role="tab">${icon('mic')} ElevenLabs <span class="tag">AI</span></button>
    </div>
    <div id="voiceTabBody"></div>
    <div class="divider" style="margin:18px 0 14px"></div>
    <div style="display:flex;flex-direction:column;gap:11px">
      <label class="switch">
        <input type="checkbox" id="vmAutoAdvance" ${draft.autoAdvance ? 'checked' : ''}>
        <span class="track"></span><span class="switch-label">Continue to the next chapter automatically</span>
      </label>
      <label class="switch">
        <input type="checkbox" id="vmHighlight" ${draft.highlight ? 'checked' : ''}>
        <span class="track"></span><span class="switch-label">Highlight the sentence being read</span>
      </label>
    </div>
    <div class="callout" style="margin-top:16px">${icon('shield')}<span>Voice keys are stored only in this browser. Locally they pass through this app’s own proxy; on a hosted site they go directly to the provider over HTTPS. They are never sent anywhere else.</span></div>
  `;

  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:9px;width:100%;justify-content:flex-end';
  foot.innerHTML = `
    <button class="btn" data-cancel>Cancel</button>
    <button class="btn btn-primary" data-save>Save voice</button>`;

  const m = modal({
    eyebrow: 'Narration',
    title: 'Choose how Alya’s Reader reads',
    subtitle: 'A free voice on this device, a neural voice from the cloud, or no voice at all.',
    body,
    foot,
    wide: true,
    onClose: () => {
      stopPreview();
      window.removeEventListener('lumen:voices', onVoices);
    },
  });

  const tabBody = body.querySelector('#voiceTabBody');
  const tabs = Array.from(body.querySelectorAll('[data-tab]'));

  function renderTabs() {
    tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === tab));
    tabBody.innerHTML = tabMarkup(tab);
    syncTabLabels();
    const previewBtn = tabBody.querySelector('[data-preview]');
    previewBtn?.addEventListener('click', () => testVoice(previewBtn));
  }

  function syncTabLabels() {
    if (tab === 'system') {
      const v = findVoice(draft.voiceURI) || englishVoices()[0];
      if (v && !draft.voiceURI) draft.voiceURI = v.voiceURI;
    }
  }

  function tabMarkup(which) {
    if (which === 'silent') {
      return `
        <div class="voice-none" style="text-align:left;padding:8px 2px 4px">
          <div class="callout" style="margin-bottom:14px">${icon('eye-off')}<span><strong>No narration.</strong> The reader becomes a quiet, text-only place. The Listen button and voice dock are hidden. Your saved voice choice is remembered for whenever you turn narration back on.</span></div>
          <div class="feature" style="background:var(--surface-2);border:0">
            <div class="fi">${icon('book')}</div>
            <div><strong>Silent reading</strong><p>Bookmarks, highlights, notes, progress and every appearance control still work exactly the same.</p></div>
          </div>
        </div>`;
    }
    if (which === 'system') {
      const voices = englishVoices();
      return `
        <div class="field" style="margin-bottom:14px">
          <label>System voice <span class="dim" style="font-weight:400">· ${voices.length} English ${voices.length === 1 ? 'voice' : 'voices'} found</span></label>
          ${voices.length ? `<div class="voice-list" id="vmVoiceList">
            ${voices.map(v => {
              const active = v.voiceURI === draft.voiceURI || (!draft.voiceURI && v === voices[0]);
              const enhanced = /natural|premium|enhanced|neural/i.test(v.name);
              return `<button class="voice-opt${active ? ' is-active' : ''}" data-voice-uri="${esc(v.voiceURI)}">
                <span class="playing-dot"></span>
                <span class="vname">${esc(v.name)}</span>
                <span class="vlang">${esc(v.lang)}</span>
                ${enhanced ? '<span class="vtag">Natural</span>' : ''}
              </button>`;
            }).join('')}
          </div>` : `<div class="voice-none">No system voices were found. On macOS, open <strong>System Settings → Accessibility → Spoken Content → System Voice → Manage Voices</strong> and download an English voice, then reload Alya’s Reader.</div>`}
        </div>
        <div class="slider-line" style="margin-top:4px"><span style="font-size:11px;width:84px;color:var(--ink-3)">Speed</span><input class="range" id="vmRate" type="range" min="0.5" max="2" step="0.05" value="${draft.rate}"><output id="vmRateOut">${draft.rate.toFixed(2)}×</output></div>
        <div class="slider-line" style="margin-top:8px"><span style="font-size:11px;width:84px;color:var(--ink-3)">Pitch</span><input class="range" id="vmPitch" type="range" min="0.5" max="1.5" step="0.05" value="${draft.pitch}"><output id="vmPitchOut">${draft.pitch.toFixed(2)}</output></div>
        <div style="margin-top:14px"><button class="btn btn-sm" data-preview>${icon('volume')} Preview voice</button></div>`;
    }
    if (which === 'openai') {
      return `
        <div class="form-stack">
          <div class="field">
            <label for="vmOpenaiKey">OpenAI API key</label>
            <div class="key-row">
              <input class="input" id="vmOpenaiKey" type="password" spellcheck="false" autocomplete="off" placeholder="sk-…" value="${esc(draft.openaiKey)}">
              <button class="btn btn-sm" data-toggle-key="vmOpenaiKey" type="button" title="Show key">${icon('key')}</button>
            </div>
            <span class="hint">Create a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">platform.openai.com</a>. Billed by OpenAI per character.</span>
          </div>
          <div class="field">
            <label>Voice</label>
            <div class="voice-grid">
              ${['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map(v =>
                `<button class="voice-chip${draft.openaiVoice === v ? ' is-active' : ''}" data-oa-voice="${v}">${v.charAt(0).toUpperCase() + v.slice(1)}</button>`
              ).join('')}
            </div>
          </div>
          <div class="tp-grid2">
            <div class="field">
              <label for="vmOpenaiModel">Model</label>
              <select class="select" id="vmOpenaiModel">
                <option value="gpt-4o-mini-tts"${draft.openaiModel === 'gpt-4o-mini-tts' ? ' selected' : ''}>gpt-4o-mini-tts · expressive</option>
                <option value="tts-1-hd"${draft.openaiModel === 'tts-1-hd' ? ' selected' : ''}>tts-1-hd · high quality</option>
                <option value="tts-1"${draft.openaiModel === 'tts-1' ? ' selected' : ''}>tts-1 · fast</option>
              </select>
            </div>
            <div class="field">
              <label>Speed</label>
              <div class="slider-line" style="height:40px"><input class="range" id="vmRate" type="range" min="0.5" max="2" step="0.05" value="${draft.rate}"><output id="vmRateOut">${draft.rate.toFixed(2)}×</output></div>
            </div>
          </div>
          <div class="field">
            <label for="vmInstructions">Narration style <span class="dim" style="font-weight:400">· optional</span></label>
            <textarea class="input" id="vmInstructions" rows="2" placeholder="Warm, clear audiobook narration. Unhurried but engaged.">${esc(draft.instructions)}</textarea>
          </div>
          <div><button class="btn btn-sm" data-preview>${icon('sparkles')} Preview voice</button></div>
        </div>`;
    }
    // elevenlabs
    return `
      <div class="form-stack">
        <div class="field">
          <label for="vmElevenKey">ElevenLabs API key</label>
          <div class="key-row">
            <input class="input" id="vmElevenKey" type="password" spellcheck="false" autocomplete="off" placeholder="xi-…" value="${esc(draft.elevenKey)}">
            <button class="btn btn-sm" data-toggle-key="vmElevenKey" type="button" title="Show key">${icon('key')}</button>
          </div>
          <span class="hint">Create a key at <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">elevenlabs.io</a>. The free tier includes a monthly character allowance.</span>
        </div>
        <div class="field">
          <label>Voice preset</label>
          <div class="voice-grid">
            ${ELEVEN_PRESETS.map(v => `<button class="voice-chip${draft.elevenVoice === v.id ? ' is-active' : ''}" data-el-voice="${v.id}">${v.name}</button>`).join('')}
          </div>
          <input class="input" id="vmElevenVoice" placeholder="Or paste a voice ID" value="${esc(draft.elevenVoice)}" style="margin-top:8px;font-size:12px">
        </div>
        <div class="tp-grid2">
          <div class="field">
            <label for="vmElevenModel">Model</label>
            <select class="select" id="vmElevenModel">
              <option value="eleven_multilingual_v2"${draft.elevenModel === 'eleven_multilingual_v2' ? ' selected' : ''}>multilingual v2 · natural</option>
              <option value="eleven_turbo_v2_5"${draft.elevenModel === 'eleven_turbo_v2_5' ? ' selected' : ''}>turbo v2.5 · fast</option>
              <option value="eleven_flash_v2_5"${draft.elevenModel === 'eleven_flash_v2_5' ? ' selected' : ''}>flash v2.5 · fastest</option>
            </select>
          </div>
          <div class="field">
            <label>Speed</label>
            <div class="slider-line" style="height:40px"><input class="range" id="vmRate" type="range" min="0.5" max="2" step="0.05" value="${draft.rate}"><output id="vmRateOut">${draft.rate.toFixed(2)}×</output></div>
          </div>
        </div>
        <div><button class="btn btn-sm" data-preview>${icon('mic')} Preview voice</button></div>
      </div>`;
  }

  async function testVoice(btn) {
    const probe = { ...draft, enabled: true, provider: tab === 'silent' ? original.provider : tab };
    if (tab === 'system' && !probe.voiceURI) probe.voiceURI = englishVoices()[0]?.voiceURI || '';
    if (tab === 'openai' && !draft.openaiKey) { toast('Add your OpenAI API key to preview this voice.', 'err'); return; }
    if (tab === 'elevenlabs' && !draft.elevenKey) { toast('Add your ElevenLabs API key to preview this voice.', 'err'); return; }
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.innerHTML = '<span class="busy-dot"></span> Generating…';
    try {
      await previewSpeech(probe);
    } catch (err) {
      toast(err.message || 'Could not play the sample.', 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  body.addEventListener('click', e => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab;
      renderTabs();
      return;
    }
    const voiceBtn = e.target.closest('[data-voice-uri]');
    if (voiceBtn) {
      draft.voiceURI = voiceBtn.dataset.voiceUri;
      tabBody.querySelectorAll('[data-voice-uri]').forEach(b => b.classList.toggle('is-active', b === voiceBtn));
      return;
    }
    const oa = e.target.closest('[data-oa-voice]');
    if (oa) {
      draft.openaiVoice = oa.dataset.oaVoice;
      tabBody.querySelectorAll('[data-oa-voice]').forEach(b => b.classList.toggle('is-active', b === oa));
      return;
    }
    const el = e.target.closest('[data-el-voice]');
    if (el) {
      draft.elevenVoice = el.dataset.elVoice;
      tabBody.querySelectorAll('[data-el-voice]').forEach(b => b.classList.toggle('is-active', b === el));
      const input = tabBody.querySelector('#vmElevenVoice');
      if (input) input.value = draft.elevenVoice;
      return;
    }
    const toggle = e.target.closest('[data-toggle-key]');
    if (toggle) {
      const input = tabBody.querySelector(`#${toggle.dataset.toggleKey}`);
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    }
  });

  body.addEventListener('input', e => {
    const id = e.target.id;
    if (id === 'vmRate') {
      draft.rate = Number(e.target.value);
      const out = tabBody.querySelector('#vmRateOut');
      if (out) out.textContent = `${draft.rate.toFixed(2)}×`;
    } else if (id === 'vmPitch') {
      draft.pitch = Number(e.target.value);
      const out = tabBody.querySelector('#vmPitchOut');
      if (out) out.textContent = draft.pitch.toFixed(2);
    } else if (id === 'vmOpenaiKey') draft.openaiKey = e.target.value.trim();
    else if (id === 'vmElevenKey') draft.elevenKey = e.target.value.trim();
    else if (id === 'vmInstructions') draft.instructions = e.target.value;
    else if (id === 'vmElevenVoice') draft.elevenVoice = e.target.value.trim();
  });

  body.addEventListener('change', e => {
    const id = e.target.id;
    if (id === 'vmOpenaiModel') draft.openaiModel = e.target.value;
    else if (id === 'vmElevenModel') draft.elevenModel = e.target.value;
    else if (id === 'vmAutoAdvance') draft.autoAdvance = e.target.checked;
    else if (id === 'vmHighlight') draft.highlight = e.target.checked;
  });

  const onVoices = () => { if (tab === 'system') renderTabs(); };
  window.addEventListener('lumen:voices', onVoices);

  foot.querySelector('[data-cancel]').onclick = () => m.close('cancel');
  foot.querySelector('[data-save]').onclick = () => {
    draft.enabled = tab !== 'silent';
    draft.provider = tab === 'silent' ? (original.provider || 'system') : tab;
    savePrefs({ tts: draft });
    stopPreview();
    m.close('save');
    toast(tab === 'silent' ? 'Silent reading on' : 'Voice saved', 'ok');
    onSaved?.();
  };

  renderTabs();
  return m;
}
