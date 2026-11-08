/* Settings: appearance, reading comfort, narration, data. */

const BUILD = document.querySelector('meta[name="app-build"]')?.content || '1.0';

import { db } from './db.js';
import {
  getPrefs, savePrefs, setReaderPrefs, FONTS, THEMES, DEFAULT_READER, DYSLEXIA_READER,
} from './prefs.js';
import {
  previewSpeech, stopPreview, describeVoice,
  getPiperVoices, loadPiperCatalog, piperVoiceById, piperSpeakerName,
  PIPER_PRESETS, OPENAI_VOICES, onPiperProgress, piperProgressLabel,
  listCachedVoices, deleteCachedVoice, clearCachedVoices,
  importCustomVoice, removeCustomVoice,
} from './tts.js';
import {
  modal, toast, confirmDialog,
} from './ui.js';
import {
  $, esc, icon, clamp, formatBytes, downloadBlob,
} from './util.js';
import { getSleepTimer, startSleepTimer, cancelSleepTimer, formatSleepRemaining } from './sleep.js';

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
  const voiceSub = !tts.enabled
    ? 'Text only · no narration'
    : tts.provider === 'openai'
      ? 'OpenAI · cloud voice'
      : 'Piper · free · offline neural voice';

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
              <div class="font-picker">
                <span class="font-aa" style="font-family:${(FONTS.find(f => f.id === r.font) || FONTS[0]).stack}">Aa</span>
                <select class="select" id="setFont" aria-label="Typeface">
                  ${FONTS.map(f => `<option value="${f.id}"${r.font === f.id ? ' selected' : ''}>${esc(f.name)} — ${esc(f.note)}</option>`).join('')}
                </select>
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
          <p class="set-desc">Listen with a free offline audiobook-style voice, or read silently.</p>
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
              <div class="set-row" style="margin-top:12px;margin-bottom:6px"><span class="set-label">Pause between sentences</span><output id="ttsPauseOut">${tts.sentencePause.toFixed(2)}s</output></div>
              <input class="range" id="setTtsPause" type="range" min="0" max="1" step="0.05" value="${tts.sentencePause}" aria-label="Pause between sentences">
              <label class="switch" style="margin-top:12px">
                <input type="checkbox" id="setAutoAdvance" ${tts.autoAdvance ? 'checked' : ''}>
                <span class="track"></span><span class="switch-label">Continue to the next chapter</span>
              </label>
              <label class="switch" style="margin-top:10px">
                <input type="checkbox" id="setHighlight" ${tts.highlight ? 'checked' : ''}>
                <span class="track"></span><span class="switch-label">Highlight the sentence being read</span>
              </label>
              <label class="switch" style="margin-top:10px">
                <input type="checkbox" id="setAutoLanguage" ${tts.autoLanguageVoice !== false ? 'checked' : ''}>
                <span class="track"></span><span class="switch-label">Use a matching voice for non-English books</span>
              </label>
              <div style="margin-top:14px"><button class="btn btn-sm" data-preview-voice>${icon('volume')} Hear a sample</button></div>
            </div>
            <p class="hint"><strong>Piper</strong> voices are free and run entirely in this browser. The first use downloads an open voice model (20–115 MB) from Hugging Face, then works offline. <strong>OpenAI</strong> voices are an optional cloud alternative that requires your API key and sends book text to OpenAI.</p>
          </div>
        </section>
      </div>

      <div class="settings-col">
        <section class="panel set-card">
          <h3>Reading comfort</h3>
          <p class="set-desc">Fine-tune the rhythm of the page.</p>
          <div class="set-body">
            <div class="dyslexia-card">
              <div class="dc-copy">
                <strong>Dyslexia-friendly reading</strong>
                <span>OpenDyslexic, roomy lines, wider spacing and left-aligned text.</span>
              </div>
              <button class="btn btn-sm" id="dyslexiaPreset">Apply</button>
            </div>
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
            <div>
              <div class="set-row"><span class="set-label">Letter spacing</span><output id="letterOut">${(r.letterSpacing || 0).toFixed(3)} em</output></div>
              <input class="range" id="setLetter" type="range" min="0" max="0.12" step="0.005" value="${r.letterSpacing || 0}" aria-label="Letter spacing">
            </div>
            <div>
              <div class="set-row"><span class="set-label">Word spacing</span><output id="wordOut">${(r.wordSpacing || 0).toFixed(2)} em</output></div>
              <input class="range" id="setWord" type="range" min="0" max="0.5" step="0.01" value="${r.wordSpacing || 0}" aria-label="Word spacing">
            </div>
            <div class="divider"></div>
            <div class="set-row" style="margin-bottom:8px">
              <div>
                <div class="set-label">Sleep timer</div>
                <div class="set-sub" id="sleepSub">${(() => { const t = getSleepTimer(); return t ? `Stops in ${formatSleepRemaining(t.remainingMs)} · screen dims` : 'Stop narration after a set time and dim the screen.'; })()}</div>
              </div>
              <select class="select" id="setSleep" aria-label="Sleep timer" style="width:118px">
                <option value="off"${!getSleepTimer() ? ' selected' : ''}>Off</option>
                ${[5, 10, 15, 20, 30, 45, 60, 90].map(m => `<option value="${m}"${getSleepTimer()?.minutes === m ? ' selected' : ''}>${m} minutes</option>`).join('')}
              </select>
            </div>
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
            <div class="set-row" style="margin-top:12px">
              <div>
                <div class="set-label">Downloaded voices</div>
                <div class="set-sub" id="voiceStoreSub">Checking…</div>
              </div>
              <button class="btn btn-sm" id="manageVoices">Manage</button>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
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
            <p class="hint" style="line-height:1.65">EPUB rendering, PDF.js, Mammoth and JSZip run entirely on your device. Natural narration uses <strong>Piper</strong> (MIT, from rhasspy/piper) locally, with optional <strong>OpenAI</strong> cloud voices if you add your own API key.</p>
            <p class="hint">Alya’s Reader · build ${BUILD}</p>
          </div>
        </section>
      </div>
    </div>
  `;

  view.onclick = e => onSettingsClick(app, e);
  view.oninput = e => onSettingsInput(app, e);
  view.onchange = e => onSettingsChange(app, e);
  refreshVoiceStore();
}

function refreshVoiceStore() {
  const sub = $('#voiceStoreSub');
  if (!sub) return;
  listCachedVoices().then(list => {
    if (!sub.isConnected) return;
    const bytes = list.reduce((sum, v) => sum + v.size, 0);
    sub.textContent = list.length
      ? `${list.length} model${list.length === 1 ? '' : 's'} · ${formatBytes(bytes)}`
      : 'None downloaded yet';
  }).catch(() => { sub.textContent = 'Could not read voice storage'; });
}

async function openVoiceManager(app) {
  const body = document.createElement('div');
  body.innerHTML = '<div class="voice-none">Reading downloaded voices…</div>';
  const foot = document.createElement('div');
  const m = modal({
    eyebrow: 'Storage',
    title: 'Downloaded voices',
    body,
    foot,
    onClose: () => renderSettings(app),
  });

  const render = async () => {
    const list = await listCachedVoices();
    if (!list.length) {
      body.innerHTML = '<div class="voice-none">No voice models are stored yet. A model downloads the first time you use that voice.</div>';
      foot.innerHTML = '';
      return;
    }
    const bytes = list.reduce((sum, v) => sum + v.size, 0);
    body.innerHTML = `<p class="hint" style="margin-bottom:10px">${list.length} model${list.length === 1 ? '' : 's'} · ${formatBytes(bytes)}. Removing one frees space; it downloads again if you use it.</p>
      <div class="voice-list">${list.map(v => `
        <div class="voice-opt" style="cursor:default">
          <span class="vname">${esc(v.name)}</span>
          <span class="vlang">${esc(v.lang || v.country || 'Voice')} · ${formatBytes(v.size)}</span>
          <button class="icon-btn" data-delete-voice="${esc(v.key)}" aria-label="Remove ${esc(v.name)}" title="Remove download">${icon('trash')}</button>
        </div>`).join('')}</div>`;
    body.querySelectorAll('[data-delete-voice]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await deleteCachedVoice(btn.dataset.deleteVoice);
        render();
      });
    });
    foot.innerHTML = `<button class="btn btn-sm btn-danger" data-clear-voices>${icon('trash')} Clear all voice downloads</button>`;
    foot.querySelector('[data-clear-voices]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Clear all voice downloads?',
        message: 'Frees the space used by voice models. Voices download again the next time you use them.',
        confirmLabel: 'Clear downloads',
      });
      if (!ok) return;
      await clearCachedVoices();
      render();
    });
  };
  render();
  return m;
}

function fontName(id) {
  return FONTS.find(f => f.id === id)?.name || 'Literata';
}

function onSettingsClick(app, e) {
  const theme = e.target.closest('[data-set-theme]');
  if (theme) { savePrefs({ theme: theme.dataset.setTheme }); renderSettings(app); return; }

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
    const stopProgress = onPiperProgress(p => {
      if (['downloading', 'preparing', 'generating'].includes(p.phase)) {
        btn.innerHTML = `<span class="busy-dot"></span> ${piperProgressLabel(p)}`;
      }
    });
    previewSpeech(getPrefs().tts)
      .catch(err => toast(err.message || 'Could not play the sample.', 'err'))
      .finally(() => { stopProgress(); btn.disabled = false; btn.innerHTML = old; });
    return;
  }
  if (e.target.closest('#dyslexiaPreset')) {
    setReaderPrefs(DYSLEXIA_READER);
    renderSettings(app);
    toast('Dyslexia-friendly reading on', 'ok');
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
  if (e.target.closest('#manageVoices')) { openVoiceManager(app); return; }
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
  if (id === 'setLetter') {
    const v = Number(e.target.value);
    setReaderPrefs({ letterSpacing: v });
    $('#letterOut').textContent = `${v.toFixed(3)} em`;
    return;
  }
  if (id === 'setWord') {
    const v = Number(e.target.value);
    setReaderPrefs({ wordSpacing: v });
    $('#wordOut').textContent = `${v.toFixed(2)} em`;
    return;
  }
  if (id === 'setTtsSpeed') {
    const v = Number(e.target.value);
    savePrefs({ tts: { rate: v } }, { silent: true });
    $('#ttsSpeedOut').textContent = `${v.toFixed(2)}×`;
    return;
  }
  if (id === 'setTtsPause') {
    const v = Number(e.target.value);
    savePrefs({ tts: { sentencePause: v } }, { silent: true });
    $('#ttsPauseOut').textContent = `${v.toFixed(2)}s`;
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
  if (id === 'setSleep') {
    const value = e.target.value;
    if (value === 'off') {
      cancelSleepTimer();
      const sub = $('#sleepSub');
      if (sub) sub.textContent = 'Stop narration after a set time and dim the screen.';
      toast('Sleep timer cancelled', 'ok');
    } else {
      const minutes = Number(value);
      startSleepTimer(minutes);
      const sub = $('#sleepSub');
      const t = getSleepTimer();
      if (sub && t) sub.textContent = `Stops in ${formatSleepRemaining(t.remainingMs)} · screen dims`;
      toast(`Sleep timer set for ${minutes} minutes`, 'ok');
    }
    return;
  }
  if (id === 'setFont') { setReaderPrefs({ font: e.target.value }); renderSettings(app); return; }
  if (id === 'setJustify') { setReaderPrefs({ justify: e.target.checked }); return; }
  if (id === 'setHyphens') { setReaderPrefs({ hyphens: e.target.checked }); return; }
  if (id === 'setAutoAdvance') { savePrefs({ tts: { autoAdvance: e.target.checked } }, { silent: true }); return; }
  if (id === 'setAutoLanguage') { savePrefs({ tts: { autoLanguageVoice: e.target.checked } }, { silent: true }); return; }
  if (id === 'setHighlight') { savePrefs({ tts: { highlight: e.target.checked } }, { silent: true }); return; }
}

/* ── Export ───────────────────────────────────────────────────────── */
function exportData(app) {
  try {
    const prefs = getPrefs();
    const safeTts = { ...prefs.tts };
    delete safeTts.openaiKey;
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

export async function openVoiceModal({ onSaved } = {}) {
  window.lumen?.pauseTTS?.();
  stopPreview();
  await loadPiperCatalog().catch(() => {});

  const original = getPrefs().tts;
  const draft = { ...original };
  let tab = draft.enabled ? draft.provider : 'silent';
  if (!['piper', 'openai'].includes(tab)) tab = 'piper';

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="provider-tabs" role="tablist" aria-label="Narration mode">
      <button class="provider-tab" data-tab="silent" role="tab">${icon('eye-off')} Silent</button>
      <button class="provider-tab" data-tab="piper" role="tab">${icon('headphones')} Piper <span class="tag">Free</span></button>
      <button class="provider-tab" data-tab="openai" role="tab">${icon('sparkles')} OpenAI <span class="tag">Cloud</span></button>
    </div>
    <div id="voiceTabBody"></div>
    <div class="divider" style="margin:18px 0 14px"></div>
    <div class="slider-line" style="margin-bottom:10px">
      <span style="font-size:11px;width:128px;color:var(--ink-3)">Pause between sentences</span>
      <input class="range" id="vmPause" type="range" min="0" max="1" step="0.05" value="${draft.sentencePause ?? 0.2}">
      <output id="vmPauseOut">${(draft.sentencePause ?? 0.2).toFixed(2)}s</output>
    </div>
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
    <div class="callout" style="margin-top:16px">${icon('shield')}<span>Piper runs entirely in this browser. Voice models download once and are cached in your browser; your book text never leaves this device. Voices are original character voices, not celebrity impersonations. A licensed Texas-drawl preset isn’t available in the open voice set.</span></div>
  `;

  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:9px;width:100%;justify-content:flex-end';
  foot.innerHTML = `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save voice</button>`;

  const m = modal({
    eyebrow: 'Narration',
    title: 'Choose how Alya’s Reader speaks',
    subtitle: 'Free, offline neural voices from Piper — audiobook, cinema and character styles.',
    body,
    foot,
    wide: true,
    onClose: () => {
      stopPreview();
    },
  });

  const tabBody = body.querySelector('#voiceTabBody');
  const tabs = Array.from(body.querySelectorAll('[data-tab]'));

  function renderTabs() {
    tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === tab));
    tabBody.innerHTML = tabMarkup(tab);
    const previewBtn = tabBody.querySelector('[data-preview]');
    previewBtn?.addEventListener('click', () => testVoice(previewBtn));
    if (tab === 'piper') renderPiperList();
    const importBtn = tabBody.querySelector('#importVoice');
    const importInput = tabBody.querySelector('#importVoiceFile');
    importBtn?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async event => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (!files.length) return;
      const old = importBtn.innerHTML;
      importBtn.disabled = true;
      importBtn.innerHTML = '<span class="busy-dot"></span> Importing…';
      try {
        const voice = await importCustomVoice(files);
        draft.piperVoice = voice.id;
        draft.piperSpeaker = 0;
        renderTabs();
        toast(`Imported ${voice.name}`, 'ok');
      } catch (err) {
        toast(err.message || 'Could not import that voice', 'err');
      } finally {
        importBtn.disabled = false;
        importBtn.innerHTML = old;
      }
    });
  }

  function tabMarkup(which) {
    if (which === 'silent') {
      return `
        <div class="voice-none" style="text-align:left;padding:8px 2px 4px">
          <div class="callout" style="margin-bottom:14px">${icon('eye-off')}<span><strong>No narration.</strong> Alya’s Reader becomes a quiet, text-only place. The Listen button and voice dock are hidden. Your saved voice choice is remembered for whenever you turn narration back on.</span></div>
          <div class="feature" style="background:var(--surface-2);border:0">
            <div class="fi">${icon('book')}</div>
            <div><strong>Silent reading</strong><p>Bookmarks, highlights, notes, progress and every appearance control still work exactly the same.</p></div>
          </div>
        </div>`;
    }

    if (which === 'openai') {
      const model = draft.openaiModel || 'gpt-4o-mini-tts';
      return `
        <div class="callout" style="margin-bottom:14px">${icon('sparkles')}<span><strong>OpenAI cloud voices.</strong> Natural GPT speech. Your API key stays in this browser; book text is sent to OpenAI only while this voice is selected. Usage is billed by OpenAI.</span></div>
        <div class="field">
          <label for="vmOpenaiKey">OpenAI API key</label>
          <input class="input" id="vmOpenaiKey" type="password" value="${esc(draft.openaiKey || '')}" placeholder="sk-…" autocomplete="off" spellcheck="false">
          <p class="hint">Create a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">platform.openai.com/api-keys</a>. It is stored locally, like your books.</p>
        </div>
        <div class="field" style="margin-top:12px">
          <label for="vmOpenaiModel">Model</label>
          <select class="select" id="vmOpenaiModel">
            <option value="gpt-4o-mini-tts"${model === 'gpt-4o-mini-tts' ? ' selected' : ''}>GPT-4o mini TTS · most natural</option>
            <option value="tts-1-hd"${model === 'tts-1-hd' ? ' selected' : ''}>TTS-1 HD · high quality</option>
            <option value="tts-1"${model === 'tts-1' ? ' selected' : ''}>TTS-1 · faster</option>
          </select>
        </div>
        <div class="field" style="margin-top:12px">
          <label for="vmOpenaiVoice">Voice</label>
          <select class="select" id="vmOpenaiVoice">
            ${OPENAI_VOICES.map(v => `<option value="${v.id}"${draft.openaiVoice === v.id ? ' selected' : ''}>${esc(v.name)} — ${esc(v.desc)}</option>`).join('')}
          </select>
        </div>
        ${model.startsWith('gpt-4o') ? `<div class="field" style="margin-top:12px">
          <label for="vmOpenaiInstructions">Delivery instructions</label>
          <textarea class="input" id="vmOpenaiInstructions" rows="3" style="height:auto;resize:vertical" spellcheck="false">${esc(draft.openaiInstructions || '')}</textarea>
          <p class="hint">Tell the voice how to read: warm, unhurried, gentle, dramatic, and so on.</p>
        </div>` : ''}
        <div class="slider-line"><span style="font-size:11px;width:84px;color:var(--ink-3)">Speed</span><input class="range" id="vmRate" type="range" min="0.5" max="2" step="0.05" value="${draft.rate}"><output id="vmRateOut">${draft.rate.toFixed(2)}×</output></div>
        <div style="margin-top:14px"><button class="btn btn-sm" data-preview>${icon('sparkles')} Generate a sample</button></div>
        <p class="hint" style="margin-top:10px">OpenAI voices need an internet connection and are billed per character. Choose Piper for free offline narration.</p>`;
    }

    // Piper — full catalog
    const all = getPiperVoices();
    const selected = piperVoiceById(draft.piperVoice);
    const languages = [...new Set(all.map(v => v.language).filter(Boolean))].sort((a, b) => (a === 'English' ? -1 : b === 'English' ? 1 : a.localeCompare(b)));
    return `
      <div class="presets">
        <div class="presets-head"><span>Narration styles</span><span class="dim">Audiobook, cinema &amp; character</span></div>
        ${[
          ['audiobook', 'Audiobook-inspired'],
          ['cinema', 'Cinema-inspired originals'],
          ['character', 'Character archetypes'],
          ['accent', 'Regional accents'],
        ].map(([group, title]) => {
          const items = PIPER_PRESETS.filter(p => (p.group || 'audiobook') === group);
          const cards = `<div class="preset-grid">
              ${items.map(p => {
                const active = p.voiceId === draft.piperVoice
                  && Number(p.speaker || 0) === Number(draft.piperSpeaker || 0)
                  && Math.abs(Number(p.rate ?? draft.rate) - Number(draft.rate)) < 0.001;
                return `<button class="preset${active ? ' is-active' : ''}" data-preset="${esc(p.id)}">
                  <span class="preset-name">${esc(p.name)}${p.tag ? `<em>${esc(p.tag)}</em>` : ''}</span>
                  <span class="preset-desc">${esc(p.desc)}</span>
                </button>`;
              }).join('')}
            </div>`;
          if (group === 'accent') {
            return `<details class="preset-details" open><summary>${title} <span>${items.length} British, African, Asian and Oceania voices · VCTK + L2-ARCTIC</span></summary>
              <p class="preset-source">Real accent characteristics from the open VCTK and L2-ARCTIC research corpora. These are original open voices, not celebrity impersonations.</p>
              ${cards}
            </details>`;
          }
          return `<div class="preset-subhead">${title}</div>${cards}`;
        }).join('')}
        <p class="preset-note">Celebrity, Audible, Libby and OverDrive narrators are real people or licensed voices. These presets are original open Piper voices — no real person is cloned or impersonated. Regional accents come from the open <strong>VCTK</strong> and <strong>L2-ARCTIC</strong> research corpora; they are real accent characteristics, not impersonations. <strong>LibriVox-style</strong> uses LibriTTS, trained on volunteer LibriVox recordings.</p>
      </div>
      <div class="custom-import">
        <button class="btn btn-sm" id="importVoice">${icon('upload')} Import a Piper voice</button>
        <input type="file" id="importVoiceFile" accept=".onnx,.json,.zip" multiple hidden>
        <p class="hint">Bring a Piper-compatible <strong>.onnx</strong> + <strong>.onnx.json</strong> (or a zip) from any open project. Models trained on <a href="https://github.com/common-voice/common-voice" target="_blank" rel="noopener noreferrer">Mozilla Common Voice</a> or other open datasets stay on this device.</p>
      </div>
      <div class="field" style="margin-bottom:10px;margin-top:12px">
        <label>Piper voices <span class="dim" style="font-weight:400">· ${all.length} voices · free · offline</span></label>
        <div style="display:flex;gap:8px;margin-top:2px">
          <input class="input" id="vmPiperSearch" placeholder="Search voices" style="flex:1;height:34px" autocomplete="off">
          <select class="select" id="vmPiperLang" style="width:150px;height:34px" aria-label="Language">
            <option value="all" selected>All languages</option>
            ${languages.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
          </select>
        </div>
        <div class="piper-note" id="piperNote" style="margin-top:8px">${selected.custom ? `Imported voice · ${selected.sizeMB} MB · stored on this device.` : `First use downloads about ${selected.sizeMB} MB for ${esc(selected.name)}. After that it is cached offline.`}</div>
        <div id="customVoiceBar"></div>
        <div class="voice-list" id="piperList" style="max-height:270px;margin-top:8px"></div>
      </div>
      <div id="piperSpeakerWrap"></div>
      <div class="slider-line"><span style="font-size:11px;width:84px;color:var(--ink-3)">Speed</span><input class="range" id="vmRate" type="range" min="0.5" max="2" step="0.05" value="${draft.rate}"><output id="vmRateOut">${draft.rate.toFixed(2)}×</output></div>
      <div style="margin-top:14px"><button class="btn btn-sm" data-preview>${icon('headphones')} Download &amp; preview</button></div>
      <div class="voice-progress" id="voiceProgress" hidden>
        <div class="voice-progress-track"><i id="voiceProgressFill"></i></div>
        <span class="voice-progress-text" id="voiceProgressText">Downloading voice…</span>
      </div>
      <p class="hint" style="margin-top:10px">The first preview loads the model and shows live progress; later sentences are generated while the previous one plays. Australian English is a community model. Texas drawl isn’t available in the open voice set; celebrity and platform narrator clones are not included. Sources: <a href="https://github.com/rhasspy/piper" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">rhasspy/piper</a> · <a href="https://huggingface.co/rhasspy/piper-voices" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">voice models</a>.</p>`;
  }

  function renderPiperList() {
    const list = tabBody.querySelector('#piperList');
    if (!list) return;
    const search = (tabBody.querySelector('#vmPiperSearch')?.value || '').trim().toLowerCase();
    const lang = tabBody.querySelector('#vmPiperLang')?.value || 'all';
    const selected = piperVoiceById(draft.piperVoice);
    let voices = getPiperVoices();
    if (lang !== 'all') voices = voices.filter(v => v.language === lang);
    if (search) {
      voices = voices.filter(v => `${v.name} ${v.language} ${v.country} ${v.accent}`.toLowerCase().includes(search));
    }
    const groups = new Map();
    for (const v of voices) {
      const key = v.language || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
    if (!voices.length) {
      list.innerHTML = '<div class="voice-none">No voices match that search.</div>';
      return;
    }
    list.innerHTML = [...groups.entries()].map(([language, items]) => `
      <div class="voice-group-label">${esc(language)}</div>
      ${items.map(v => `<button class="voice-opt${v.id === selected.id ? ' is-active' : ''}" data-piper-voice="${esc(v.id)}">
        <span class="playing-dot"></span>
        <span class="vname">${esc(v.name)}</span>
        <span class="vlang">${esc(v.country || v.accent)}${v.num_speakers > 1 ? ` · ${v.num_speakers} speakers` : ''}</span>
        ${v.custom ? '<span class="vtag">Custom</span>' : v.community ? '<span class="vtag">Community</span>' : (v.quality ? `<span class="vtag">${esc(v.quality)}</span>` : '')}
      </button>`).join('')}
    `).join('');
    renderPiperSpeaker();
    updatePiperNote();
  }

  function renderPiperSpeaker() {
    const wrap = tabBody.querySelector('#piperSpeakerWrap');
    if (!wrap) return;
    const v = piperVoiceById(draft.piperVoice);
    if (!v || v.num_speakers <= 1) { wrap.innerHTML = ''; return; }
    const entries = Object.entries(v.speaker_id_map || {}).sort((a, b) => Number(a[1]) - Number(b[1]));
    const list = entries.length ? entries : Array.from({ length: v.num_speakers }, (_, i) => [`Speaker ${i}`, i]);
    const many = list.length > 80;
    const selectedId = Number(draft.piperSpeaker) || 0;
    const label = raw => {
      const text = String(raw);
      return /^p?\d+$/i.test(text)
        ? `Voice ${text.replace(/^p/i, '')}`
        : text.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    };
    wrap.innerHTML = `<div class="field" style="margin:4px 0 12px">
      <label for="vmPiperSpeaker">Speaker <span class="dim" style="font-weight:400">· ${list.length.toLocaleString()} available</span></label>
      ${many ? `<input class="input" id="vmPiperSpeakerSearch" placeholder="Search ${list.length.toLocaleString()} speakers" autocomplete="off" style="height:34px;margin-bottom:6px">
      <div class="speaker-count" id="vmPiperSpeakerCount"></div>` : ''}
      <select class="select" id="vmPiperSpeaker"></select>
    </div>`;

    const select = wrap.querySelector('#vmPiperSpeaker');
    const search = wrap.querySelector('#vmPiperSpeakerSearch');
    const count = wrap.querySelector('#vmPiperSpeakerCount');
    const fill = (query = '') => {
      const q = query.trim().toLowerCase();
      let matches = q ? list.filter(([name, id]) => `${label(name)} ${id}`.toLowerCase().includes(q)) : list;
      const current = list.find(([, id]) => Number(id) === selectedId);
      const limit = q ? 80 : (many ? 60 : matches.length);
      const shown = matches.slice(0, limit);
      if (current && !shown.some(([, id]) => Number(id) === selectedId)) shown.unshift(current);
      select.innerHTML = shown.map(([name, id]) => `<option value="${Number(id)}"${Number(id) === selectedId ? ' selected' : ''}>${esc(label(name))}</option>`).join('');
      if (count) {
        count.textContent = q
          ? `${matches.length} matching speaker${matches.length === 1 ? '' : 's'}${matches.length > limit ? ` · showing first ${limit}` : ''}`
          : `Showing first ${shown.length} of ${list.length.toLocaleString()} — type to narrow.`;
      }
    };
    fill('');
    search?.addEventListener('input', () => fill(search.value));
  }

  function updatePiperNote() {
    const note = tabBody.querySelector('#piperNote');
    if (!note) return;
    const v = piperVoiceById(draft.piperVoice);
    const sp = piperSpeakerName(v, draft.piperSpeaker);
    note.textContent = v.custom
      ? `Imported voice${sp ? ` · ${sp}` : ''} · ${v.sizeMB} MB · stored on this device.`
      : `First use downloads about ${v.sizeMB} MB for ${v.name}${sp ? ` · ${sp}` : ''}. After that it is cached offline.`;
    renderCustomVoiceBar();
  }

  function renderCustomVoiceBar() {
    const bar = tabBody.querySelector('#customVoiceBar');
    if (!bar) return;
    const v = piperVoiceById(draft.piperVoice);
    if (!v?.custom) { bar.innerHTML = ''; return; }
    bar.innerHTML = `<button class="btn btn-sm btn-danger" id="removeCustomVoice" style="margin-top:8px">${icon('trash')} Remove imported voice</button>`;
    bar.querySelector('#removeCustomVoice').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Remove this imported voice?',
        message: 'Its model files will be deleted from this device. You can import them again later.',
        confirmLabel: 'Remove voice',
      });
      if (!ok) return;
      await removeCustomVoice(v.id);
      draft.piperVoice = 'en_US-libritts_r-medium';
      draft.piperSpeaker = 0;
      renderTabs();
      toast('Imported voice removed', 'ok');
    });
  }

  async function testVoice(btn) {
    const probe = { ...draft, enabled: true, provider: tab === 'silent' ? original.provider || 'piper' : tab };
    if (probe.provider === 'piper' && !probe.piperVoice) probe.piperVoice = 'en_US-lessac-medium';
    if (probe.provider === 'piper') probe.piperSpeaker = draft.piperSpeaker || 0;
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.innerHTML = tab === 'piper' ? '<span class="busy-dot"></span> Preparing voice…' : '<span class="busy-dot"></span> Generating voice…';
    const progress = tabBody.querySelector('#voiceProgress');
    const fill = tabBody.querySelector('#voiceProgressFill');
    const label = tabBody.querySelector('#voiceProgressText');
    const stopProgress = onPiperProgress(p => {
      if (probe.provider !== 'piper' || p.voiceId !== probe.piperVoice) return;
      const active = p.phase === 'downloading' || p.phase === 'preparing' || p.phase === 'generating';
      if (progress) progress.hidden = !active;
      if (!active) return;
      const pct = p.phase === 'downloading' ? p.percent : 100;
      if (fill) fill.style.width = `${pct}%`;
      const text = piperProgressLabel(p);
      if (label) label.textContent = text;
      btn.innerHTML = `<span class="busy-dot"></span> ${text}`;
    });
    try {
      await previewSpeech(probe);
    } catch (err) {
      toast(err.message || 'Could not play the sample.', 'err');
    } finally {
      stopProgress();
      if (progress) progress.hidden = true;
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
    const piperBtn = e.target.closest('[data-piper-voice]');
    if (piperBtn) {
      draft.piperVoice = piperBtn.dataset.piperVoice;
      draft.piperSpeaker = 0;
      renderPiperList();
      return;
    }
    const presetBtn = e.target.closest('[data-preset]');
    if (presetBtn) {
      const preset = PIPER_PRESETS.find(p => p.id === presetBtn.dataset.preset);
      if (preset) {
        draft.piperVoice = preset.voiceId;
        draft.piperSpeaker = Number(preset.speaker || 0);
        draft.rate = Number(preset.rate ?? draft.rate);
        renderTabs();
      }
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
    } else if (id === 'vmPause') {
      draft.sentencePause = Number(e.target.value);
      body.querySelector('#vmPauseOut').textContent = `${draft.sentencePause.toFixed(2)}s`;
    } else if (id === 'vmOpenaiKey') {
      draft.openaiKey = e.target.value.trim();
    } else if (id === 'vmOpenaiInstructions') {
      draft.openaiInstructions = e.target.value;
    } else if (id === 'vmPiperSearch') {
      renderPiperList();
    } else if (id === 'vmPiperSpeaker') {
      draft.piperSpeaker = Number(e.target.value);
      updatePiperNote();
    }
  });

  body.addEventListener('change', e => {
    if (e.target.id === 'vmAutoAdvance') draft.autoAdvance = e.target.checked;
    else if (e.target.id === 'vmHighlight') draft.highlight = e.target.checked;
    else if (e.target.id === 'vmPiperLang') renderPiperList();
    else if (e.target.id === 'vmOpenaiVoice') { draft.openaiVoice = e.target.value; }
    else if (e.target.id === 'vmOpenaiModel') { draft.openaiModel = e.target.value; renderTabs(); }
    else if (e.target.id === 'vmPiperSpeaker') {
      draft.piperSpeaker = Number(e.target.value);
      updatePiperNote();
    }
  });


  foot.querySelector('[data-cancel]').onclick = () => m.close('cancel');
  foot.querySelector('[data-save]').onclick = () => {
    draft.enabled = tab !== 'silent';
    draft.provider = tab === 'silent' ? (original.provider || 'piper') : tab;
    if (tab === 'piper') draft.piperSpeaker = draft.piperSpeaker || 0;
    savePrefs({ tts: draft });
    stopPreview();
    m.close('save');
    toast(tab === 'silent' ? 'Silent reading on' : 'Voice saved', 'ok');
    onSaved?.();
  };

  renderTabs();
  return m;
}
