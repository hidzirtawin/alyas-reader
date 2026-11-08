/* Settings: appearance, reading comfort, narration, data. */

const BUILD = document.querySelector('meta[name="app-build"]')?.content || '1.0';

import { db } from './db.js';
import {
  getPrefs, savePrefs, setReaderPrefs, FONTS, THEMES, DEFAULT_READER,
} from './prefs.js';
import {
  englishVoices, findVoice, previewSpeech, stopPreview, describeVoice,
  getPiperVoices, loadPiperCatalog, piperVoiceById, piperSpeakerName,
  PIPER_PRESETS, onPiperProgress, piperProgressLabel,
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
    ? (tts.provider === 'system' ? 'Free · your device’s voices' : 'Piper · free · offline neural voice')
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
          <p class="set-desc">Listen with a free offline neural voice, your device’s voices, or read silently.</p>
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
              <div style="margin-top:14px"><button class="btn btn-sm" data-preview-voice>${icon('volume')} Hear a sample</button></div>
            </div>
            <p class="hint"><strong>Piper</strong> voices are free and run entirely in this browser. The first use downloads an open voice model (20–115 MB) from Hugging Face, then works offline. No accounts or API keys. System voices are instant.</p>
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
            <p class="hint" style="line-height:1.65">EPUB rendering, PDF.js, Mammoth and JSZip run entirely on your device. Natural narration uses <strong>Piper</strong> (MIT, from rhasspy/piper) running locally in your browser, or your operating system’s voices. No accounts or API keys.</p>
            <p class="hint">Alya’s Reader · build ${BUILD}</p>
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
  if (!['piper', 'system'].includes(tab)) tab = 'piper';

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="provider-tabs" role="tablist" aria-label="Narration mode">
      <button class="provider-tab" data-tab="silent" role="tab">${icon('eye-off')} Silent</button>
      <button class="provider-tab" data-tab="system" role="tab">${icon('volume')} System</button>
      <button class="provider-tab" data-tab="piper" role="tab">${icon('headphones')} Piper <span class="tag">Free</span></button>
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
    subtitle: 'Free, offline neural voices from Piper — or your device’s own voices.',
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
    const previewBtn = tabBody.querySelector('[data-preview]');
    previewBtn?.addEventListener('click', () => testVoice(previewBtn));
    if (tab === 'system' && !draft.voiceURI) {
      draft.voiceURI = englishVoices()[0]?.voiceURI || '';
    }
    if (tab === 'piper') renderPiperList();
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

    if (which === 'system') {
      const voices = englishVoices();
      return `
        <div class="field" style="margin-bottom:14px">
          <label>Device voice <span class="dim" style="font-weight:400">· ${voices.length} English ${voices.length === 1 ? 'voice' : 'voices'} found</span></label>
          ${voices.length ? `<div class="voice-list">
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
        <div class="slider-line"><span style="font-size:11px;width:84px;color:var(--ink-3)">Speed</span><input class="range" id="vmRate" type="range" min="0.5" max="2" step="0.05" value="${draft.rate}"><output id="vmRateOut">${draft.rate.toFixed(2)}×</output></div>
        <div class="slider-line" style="margin-top:8px"><span style="font-size:11px;width:84px;color:var(--ink-3)">Pitch</span><input class="range" id="vmPitch" type="range" min="0.5" max="1.5" step="0.05" value="${draft.pitch}"><output id="vmPitchOut">${draft.pitch.toFixed(2)}</output></div>
        <div style="margin-top:14px"><button class="btn btn-sm" data-preview>${icon('volume')} Preview voice</button></div>`;
    }

    // Piper — full catalog
    const all = getPiperVoices();
    const selected = piperVoiceById(draft.piperVoice);
    const languages = [...new Set(all.map(v => v.language).filter(Boolean))].sort((a, b) => (a === 'English' ? -1 : b === 'English' ? 1 : a.localeCompare(b)));
    return `
      <div class="presets">
        <div class="presets-head"><span>Narration styles</span><span class="dim">Audiobook-inspired</span></div>
        <div class="preset-grid">
          ${PIPER_PRESETS.map(p => `<button class="preset${p.voiceId === draft.piperVoice && Number(p.speaker || 0) === Number(draft.piperSpeaker || 0) ? ' is-active' : ''}" data-preset="${esc(p.id)}">
            <span class="preset-name">${esc(p.name)}${p.tag ? `<em>${esc(p.tag)}</em>` : ''}</span>
            <span class="preset-desc">${esc(p.desc)}</span>
          </button>`).join('')}
        </div>
        <p class="preset-note">Audible, Libby and OverDrive narrators are human or proprietary. These presets use original open Piper voices with a similar audiobook feel — no narrator is cloned. <strong>LibriVox-style</strong> uses LibriTTS, trained on volunteer LibriVox recordings.</p>
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
        <div class="piper-note" id="piperNote" style="margin-top:8px">First use downloads about ${selected.sizeMB} MB for ${esc(selected.name)}. After that it is cached offline.</div>
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
        ${v.community ? '<span class="vtag">Community</span>' : (v.quality ? `<span class="vtag">${esc(v.quality)}</span>` : '')}
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
      if (current && !matches.some(([, id]) => Number(id) === selectedId)) matches = [current, ...matches];
      const limit = q ? 80 : (many ? 60 : matches.length);
      const shown = matches.slice(0, limit);
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
    note.textContent = `First use downloads about ${v.sizeMB} MB for ${v.name}${sp ? ` · ${sp}` : ''}. After that it is cached offline.`;
  }

  async function testVoice(btn) {
    const probe = { ...draft, enabled: true, provider: tab === 'silent' ? original.provider || 'piper' : tab };
    if (probe.provider === 'system' && !probe.voiceURI) probe.voiceURI = englishVoices()[0]?.voiceURI || '';
    if (probe.provider === 'piper' && !probe.piperVoice) probe.piperVoice = 'en_US-lessac-medium';
    if (probe.provider === 'piper') probe.piperSpeaker = draft.piperSpeaker || 0;
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.innerHTML = tab === 'piper' ? '<span class="busy-dot"></span> Preparing voice…' : '<span class="busy-dot"></span> Playing…';
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
    else if (e.target.id === 'vmPiperSpeaker') {
      draft.piperSpeaker = Number(e.target.value);
      updatePiperNote();
    }
  });

  const onVoices = () => { if (tab === 'system') renderTabs(); };
  window.addEventListener('lumen:voices', onVoices);

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
