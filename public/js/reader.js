/* The reader: reflowable EPUB/DOCX/TXT + PDF, narration, marks, appearance. */

import { db } from './db.js';
import {
  getPrefs, setReaderPrefs, savePrefs, DEFAULT_READER,
  FONTS, THEMES, DYSLEXIA_READER,
} from './prefs.js';
import { buildReflowable, buildComicBook, isComicFormat } from './renderers.js';
import { PdfView } from './pdfview.js';
import { ComicView } from './comicview.js';
import { SpeechEngine, describeVoice, onPiperProgress, piperProgressLabel, piperVoiceById, piperVoiceForLanguage, piperSpeakerName, getPiperVoices, previewSpeech, stopPreview, warmPiperEngine } from './tts.js';
import {
  toast, modal, confirmDialog, contextMenu, closeAllModals, shortcutsModal,
  formatLabel, isModalOpen,
} from './ui.js';
import { openBookDetails } from './details.js';
import { downloadBookAudio } from './audioexport.js';
import { openVoiceModal } from './settings.js';
import { openDictionary } from './dictionary.js';
import { getSleepTimer, startSleepTimer, cancelSleepTimer, formatSleepRemaining } from './sleep.js';
import { createAudiobook, audiobookChapters } from './audiobook.js';
import { baseLanguage, languageName, languageMatches } from './language.js';
import {
  $, esc, icon, clamp, debounce, uid, normalizedText,
  detectSentenceSegments, formatTimeLeft, copyText, isEditable, downloadBlob, formatBytes, rafThrottle,
} from './util.js';

let S = null;
let refs = null;
const READER_SESSION = 'alya.reader.session';

function rememberReadingSession(state) {
  if (!state || state.destroyed || !state.bookId) return;
  const engine = state.engine;
  let sentenceIndex = null;
  let sentenceFraction = 0;
  try {
    if (engine?.sentences?.length) {
      sentenceIndex = Number.isFinite(engine.index) ? engine.index : null;
      sentenceFraction = Number(engine.getSentenceProgress?.() || 0);
    }
  } catch {}
  const resume = state.resumePoint;
  if (sentenceIndex == null && resume) {
    sentenceIndex = resume.sentenceIndex;
    sentenceFraction = resume.fraction || 0;
  }
  try {
    sessionStorage.setItem(READER_SESSION, JSON.stringify({
      bookId: state.bookId,
      chapterIndex: state.chapterIndex || 0,
      page: state.mode === 'pdf' ? (state.ttsPage || resume?.page || state.page || null) : (state.page || null),
      ratio: state.ratio || 0,
      at: Date.now(),
      playing: engine?.state === 'playing' || engine?.state === 'loading' || state.resumePending === true,
      ttsSentenceIndex: sentenceIndex,
      ttsFraction: sentenceFraction,
      ttsPage: state.ttsPage || resume?.page || null,
    }));
  } catch {}
}

function clearReadingSession() {
  try { sessionStorage.removeItem(READER_SESSION); } catch {}
}

export function restoreReadingSession(app) {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(READER_SESSION) || 'null'); } catch {}
  if (!saved?.bookId || !saved.at) return false;
  if (Date.now() - saved.at > 30 * 60 * 1000 || !app.books.some(b => b.id === saved.bookId)) {
    clearReadingSession();
    return false;
  }
  const target = {
    chapterIndex: saved.chapterIndex || 0,
    page: saved.ttsPage || saved.page || undefined,
    ratio: saved.ratio || 0,
    ttsSentenceIndex: saved.ttsSentenceIndex ?? null,
    ttsFraction: saved.ttsFraction || 0,
    ttsPage: saved.ttsPage || null,
  };
  setTimeout(() => { app.openBook(saved.bookId, target); }, 250);
  if (saved.playing) {
    // A reload has no user gesture, and iOS will not unlock audio. Prepare
    // the saved sentence paused so the first tap starts narration immediately
    // instead of silently loading the voice for minutes.
    setTimeout(() => {
      if (!window.lumen?.reader) return;
      try {
        window.lumen.prepareTTS?.();
        window.lumen.showResumeBanner?.();
      } catch {}
    }, 1600);
  }
  return true;
}

export async function openReader(app, bookId, target = {}) {
  if (S) await closeReader({ skipReload: true });

  let record;
  let blob;
  try {
    record = await db.getBook(bookId);
    blob = await db.getBlob(bookId);
  } catch (err) {
    toast(err.message || 'Could not open this book.', 'err');
    return;
  }
  if (!record || !blob) {
    toast('This book’s file is missing from the library.', 'err');
    await app.reload();
    return;
  }

  const state = {
    app,
    bookId,
    record,
    blob,
    target: target || {},
    resumePoint: target && target.ttsSentenceIndex != null ? {
      chapterIndex: target.chapterIndex || 0,
      page: target.ttsPage || target.page || null,
      sentenceIndex: Number(target.ttsSentenceIndex) || 0,
      fraction: Number(target.ttsFraction) || 0,
    } : null,
    mode: record.format === 'pdf' ? 'pdf' : isComicFormat(record.format) ? 'comic' : 'reflow',
    book: null,
    pdfView: null,
    pdfTask: null,
    pdfOutline: null,
    comic: null,
    comicView: null,
    toc: [],
    page: 1,
    numPages: null,
    chapterIndex: 0,
    chapter: null,
    article: null,
    ratio: 0,
    percent: 0,
    sentences: null,
    continuous: false,
    continuousBook: null,
    bookmarks: [],
    highlights: [],
    engine: null,
    ttsPage: null,
    ttsAdvancing: false,
    destroyed: false,
    userScrolled: false,
    programmatic: false,
    pendingSel: null,
    typeOpen: false,
    cleanup: [],
    renderToken: 0,
  };

  S = state;
  app.reader = state;
  refs = getRefs();
  resetReaderUI(state);
  document.body.classList.add('reader-open');
  refs.reader.classList.add('is-open');
  refs.reader.setAttribute('aria-hidden', 'false');
  refs.reader.inert = false;
  const shell = document.querySelector('.shell');
  if (shell) shell.inert = true;
  setTimeout(() => { try { refs.stage.focus({ preventScroll: true }); } catch {} }, 50);

  refs.readerBookTitle.textContent = record.title || 'Untitled';
  refs.readerChapterTitle.textContent = '';
  refs.footLeft.textContent = formatLabel(record.format);
  refs.ttsBtn.hidden = !getPrefs().tts.enabled || state.mode === 'comic';
  refs.stage.innerHTML = loadingMarkup(record.title);

  if (state.mode !== 'comic' && getPrefs().tts.enabled && getPrefs().tts.provider === 'piper') {
    const voiceId = getPrefs().tts.piperVoice;
    setTimeout(() => {
      if (!state.destroyed) warmPiperEngine(voiceId).catch(() => {});
    }, 1200);
  }

  state.bookmarks = (app.bookmarks || []).filter(b => b.bookId === bookId);
  state.highlights = (app.highlights || []).filter(h => h.bookId === bookId);
  state.progressRec = await db.getProgress(bookId);

  const now = Date.now();
  record.lastOpenedAt = now;
  const libBook = app.books.find(b => b.id === bookId);
  if (libBook) libBook.lastOpenedAt = now;
  db.updateBook(bookId, { lastOpenedAt: now }).catch(() => {});

  state.engine = new SpeechEngine({
    onState: st => updateTTSState(state, st),
    onSentence: (sentence, index) => onTTSSentence(state, sentence, index),
    onEnd: () => onTTSEnd(state),
    onError: msg => {
      toast(msg, 'err');
      updateTTSState(state, 'idle');
    },
  });

  wireEvents(state);
  updateReaderVoiceChip(state);
  app.pauseTTS = () => state.engine?.pause();
  app.resumeTTS = () => {
    state.resumePending = false;
    const engine = state.engine;
    if (engine?.sentences?.length && engine.state !== 'playing' && engine.state !== 'loading') {
      hideResumeBanner();
      engine.play();
      updateMediaSession(state);
      return true;
    }
    return startTTS(state, { autoplay: true });
  };
  app.prepareTTS = () => {
    state.resumePending = true;
    return startTTS(state, { autoplay: false, paused: true });
  };
  app.showResumeBanner = () => showResumeBanner(state);
  app.stopTTS = () => { state.engine?.stop(); closeTTS(state); };

  try {
    if (state.mode === 'pdf') await openPdfBook(state);
    else if (state.mode === 'comic') await openComicBook(state);
    else await openReflowBook(state);
    rememberReadingSession(state);
    if (state.target.audiobook) setTimeout(() => { if (S === state) openAudiobookDialog(state); }, 650);
    setTimeout(() => { if (!state.destroyed) prefetchOpeningAudio(state).catch(() => {}); }, 1100);
  } catch (err) {
    console.error('Could not open book', err);
    if (!state.destroyed) showReaderError(state, err.message || 'This book could not be opened.');
  }
}

export async function closeReader({ skipReload = false, skipSave = false } = {}) {
  const state = S;
  if (!state) return;
  if (!skipSave) {
    try { await saveProgressNow(state); } catch {}
  }
  state.destroyed = true;
  S = null;
  if (state.app) state.app.reader = null;
  clearInterval(state.ttsUiTimer);
  state.ttsUiTimer = null;
  state.queueSave?.cancel?.();
  try { closeAllModals(); } catch {}
  try { state.cleanup.forEach(fn => fn()); } catch {}

  hideResumeBanner();
  if (state.resumeBannerTimer) clearTimeout(state.resumeBannerTimer);
  try { state.engine?.destroy(); } catch {}
  try { state.pdfView?.destroy(); } catch {}
  try { state.comicView?.destroy(); } catch {}
  try { state.pdfTask?.destroy?.(); } catch {}
  try { state.book?.dispose?.(); } catch {}
  try { state.comic?.dispose?.(); } catch {}
  clearTTSHighlight(state);
  clearMediaSession();

  if (refs) {
    refs.reader.classList.remove('is-open');
    refs.reader.setAttribute('aria-hidden', 'true');
    refs.reader.inert = true;
    refs.stage.innerHTML = '';
    refs.stage.classList.remove('pdf-stage', 'comic-stage');
    refs.stage.onclick = null;
    refs.stage.onpointerup = null;
    refs.tocDrawer.classList.remove('is-open');
    refs.tocDrawer.setAttribute('aria-hidden', 'true');
    refs.tocScrim.classList.remove('is-open');
    refs.typePanel.hidden = true;
    refs.selBar.hidden = true;
    refs.ttsDock.classList.remove('is-open');
    refs.ttsDock.hidden = true;
    refs.ttsSpeedPanel.hidden = true;
    refs.ttsSpeedBtn.setAttribute('aria-expanded', 'false');
    refs.ttsSeek.disabled = true;
    refs.ttsSeek.value = '0';
    refs.ttsElapsed.textContent = '0:00';
    refs.ttsDuration.textContent = '0:00';
    refs.ttsBtn.classList.remove('is-live');
    refs.ttsBtn.querySelector('span').textContent = 'Listen';
    refs.ttsEq.classList.remove('is-live');
    refs.progressFill.style.width = '0%';
    refs.ttsPos.textContent = '—';
  }
  document.body.classList.remove('reader-open');
  const shell = document.querySelector('.shell');
  if (shell) shell.inert = false;
  if (state.app) { state.app.pauseTTS = null; state.app.resumeTTS = null; state.app.prepareTTS = null; state.app.showResumeBanner = null; state.app.stopTTS = null; }
  clearReadingSession();
  if (!skipReload) await state.app.reload();
}

/* ═══════════════════════════════════════════════════════════════════
   Setup / wiring
   ═══════════════════════════════════════════════════════════════════ */

function getRefs() {
  return {
    reader: $('#reader'),
    stage: $('#readerStage'),
    readerBookTitle: $('#readerBookTitle'),
    readerChapterTitle: $('#readerChapterTitle'),
    readerVoiceChip: $('#readerVoiceChip'),
    readerBack: $('#readerBack'),
    tocBtn: $('#tocBtn'),
    bmBtn: $('#bmBtn'),
    ttsBtn: $('#ttsBtn'),
    typeBtn: $('#typeBtn'),
    moreBtn: $('#moreBtn'),
    footLeft: $('#footLeft'),
    footRight: $('#footRight'),
    footPrev: $('#footPrev'),
    footNext: $('#footNext'),
    progressFill: $('#progressFill'),
    ttsDock: $('#ttsDock'),
    ttsEq: $('#ttsEq'),
    ttsPercent: $('#ttsPercent'),
    ttsVoiceLabel: $('#ttsVoiceLabel'),
    ttsPos: $('#ttsPos'),
    ttsSpeedBtn: $('#ttsSpeedBtn'),
    ttsSpeedPanel: $('#ttsSpeedPanel'),
    ttsSpeedRange: $('#ttsSpeedRange'),
    ttsSpeedValue: $('#ttsSpeedValue'),
    ttsSeek: $('#ttsSeek'),
    ttsElapsed: $('#ttsElapsed'),
    ttsDuration: $('#ttsDuration'),
    tocDrawer: $('#tocDrawer'),
    tocScrim: $('#tocScrim'),
    tocTitle: $('#tocTitle'),
    tocList: $('#tocList'),
    tocClose: $('#tocClose'),
    typePanel: $('#typePanel'),
    typePanelBody: $('#typePanelBody'),
    typeClose: $('#typeClose'),
    selBar: $('#selBar'),
    toastRoot: $('#toastRoot'),
  };
}

function resetReaderUI(state) {
  hideResumeBanner();
  if (state.resumeBannerTimer) { clearTimeout(state.resumeBannerTimer); state.resumeBannerTimer = null; }
  refs.bmBtn.classList.remove('is-on');
  refs.bmBtn.setAttribute('aria-pressed', 'false');
  refs.tocDrawer.classList.remove('is-open');
  refs.tocDrawer.setAttribute('aria-hidden', 'true');
  refs.tocScrim.classList.remove('is-open');
  refs.typePanel.hidden = true;
  refs.selBar.hidden = true;
  refs.ttsDock.classList.remove('is-open');
  refs.ttsDock.hidden = true;
  refs.ttsSpeedPanel.hidden = true;
  refs.ttsSpeedBtn.setAttribute('aria-expanded', 'false');
  clearInterval(state.ttsUiTimer);
  state.ttsUiTimer = null;
  state.ttsSeeking = false;
  state.ttsSeekRequested = null;
  refs.ttsBtn.classList.remove('is-live');
  refs.ttsBtn.querySelector('span').textContent = 'Listen';
  refs.ttsEq.classList.remove('is-live');
  refs.ttsPos.textContent = '—';
  updateSpeedLabel();
  updateTTSTimeline(state);
  if (refs.ttsPercent) refs.ttsPercent.hidden = true;
  refs.progressFill.style.width = '0%';
  refs.footLeft.textContent = '';
  refs.footRight.textContent = '';
  if (refs.stage) {
    refs.stage.classList.remove('pdf-stage', 'comic-stage');
    refs.stage.scrollTop = 0;
  }
}

function wireEvents(state) {
  refs.readerBack.onclick = () => closeReader();
  refs.tocBtn.onclick = () => toggleToc(state);
  refs.bmBtn.onclick = () => toggleBookmark(state);
  refs.ttsBtn.onclick = () => toggleListen(state);
  refs.typeBtn.onclick = e => { e.stopPropagation(); toggleTypePanel(state); };
  refs.moreBtn.onclick = () => openMoreMenu(state);
  refs.tocClose.onclick = () => closeToc(state);
  refs.tocScrim.onclick = () => closeToc(state);
  refs.typeClose.onclick = () => closeTypePanel(state);

  refs.stage.onclick = e => handleStageClick(state, e);
  refs.stage.onpointerup = () => setTimeout(() => showSelection(state), 30);

  const onScroll = rafThrottle(() => handleScroll(state));
  refs.stage.addEventListener('scroll', onScroll, { passive: true });
  state.cleanup.push(() => refs.stage.removeEventListener('scroll', onScroll));

  const stopProgress = onPiperProgress(p => {
    const eng = state.engine;
    if (!eng || eng.provider !== 'piper' || !refs.ttsPercent) return;
    if (eng.state !== 'loading') { refs.ttsPercent.hidden = true; return; }
    const active = p.phase === 'downloading' || p.phase === 'preparing' || p.phase === 'generating';
    refs.ttsPercent.hidden = !active;
    if (!active) return;
    refs.ttsPercent.textContent = p.phase === 'downloading' ? `${p.percent}%` : '…';
    refs.ttsPos.textContent = piperProgressLabel(p);
  });
  state.cleanup.push(stopProgress);

  const onKey = e => handleKey(state, e);
  document.addEventListener('keydown', onKey);
  state.cleanup.push(() => document.removeEventListener('keydown', onKey));

  const onSelChange = () => {
    const sel = window.getSelection();
    if ((!sel || sel.isCollapsed) && !refs.selBar.hidden) hideSelection(state);
  };
  document.addEventListener('selectionchange', onSelChange);
  state.cleanup.push(() => document.removeEventListener('selectionchange', onSelChange));

  const onDblClick = e => {
    if (state.mode !== 'reflow' || !state.article) return;
    if (!state.article.contains(e.target)) return;
    const text = (window.getSelection()?.toString() || '').trim();
    if (!text || /\s/.test(text)) return;
    openDictionary(text, state.book?.language || 'en');
  };
  refs.stage.addEventListener('dblclick', onDblClick);
  state.cleanup.push(() => refs.stage.removeEventListener('dblclick', onDblClick));

  const onDocDown = e => {
    if (!refs.typePanel.hidden && !refs.typePanel.contains(e.target) && !refs.typeBtn.contains(e.target)) closeTypePanel(state);
  };
  document.addEventListener('mousedown', onDocDown, true);
  state.cleanup.push(() => document.removeEventListener('mousedown', onDocDown, true));

  const onVis = () => { if (document.visibilityState === 'hidden') { saveProgressNow(state); rememberReadingSession(state); } };
  const onUnload = () => { saveProgressNow(state); rememberReadingSession(state); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('beforeunload', onUnload);
  state.cleanup.push(() => document.removeEventListener('visibilitychange', onVis));
  state.cleanup.push(() => window.removeEventListener('beforeunload', onUnload));

  refs.selBar.onmousedown = e => e.preventDefault();
  refs.selBar.onclick = e => handleSelectionAction(state, e);

  refs.ttsDock.onclick = e => {
    const btn = e.target.closest('[data-tts]');
    if (!btn) return;
    handleDockAction(state, btn.dataset.tts);
  };

  refs.ttsSpeedRange.addEventListener('input', () => {
    state.engine?.setRate(Number(refs.ttsSpeedRange.value));
    updateSpeedLabel();
  });
  refs.ttsSeek.addEventListener('input', () => {
    state.ttsSeeking = true;
    state.ttsSeekRequested = Number(refs.ttsSeek.value);
    const progress = readerTimelineProgress(state);
    if (!progress) return;
    refs.ttsElapsed.textContent = formatAudioTime(progress.duration * state.ttsSeekRequested / 1000);
  });
  refs.ttsSeek.addEventListener('change', () => {
    const progress = readerTimelineProgress(state);
    const requested = Number.isFinite(state.ttsSeekRequested) ? state.ttsSeekRequested : Number(refs.ttsSeek.value);
    if (progress) seekReaderTimeline(state, progress.duration * requested / 1000);
    state.ttsSeekRequested = null;
    state.ttsSeeking = false;
    updateTTSTimeline(state);
  });
  refs.ttsSeek.addEventListener('pointercancel', () => {
    state.ttsSeeking = false;
    state.ttsSeekRequested = null;
    updateTTSTimeline(state);
  });

  const closeSpeedPanel = e => {
    if (refs.ttsSpeedPanel.hidden || refs.ttsSpeedPanel.contains(e.target) || refs.ttsSpeedBtn.contains(e.target)) return;
    refs.ttsSpeedPanel.hidden = true;
    refs.ttsSpeedBtn.setAttribute('aria-expanded', 'false');
  };
  document.addEventListener('pointerdown', closeSpeedPanel, true);
  state.cleanup.push(() => document.removeEventListener('pointerdown', closeSpeedPanel, true));

  refs.tocList.onclick = e => handleTocClick(state, e);
  refs.tocList.onsubmit = e => {
    e.preventDefault();
    if (state.mode === 'reflow') {
      const idx = Number(refs.tocList.querySelector('#chapterJump')?.value);
      if (Number.isFinite(idx)) {
        closeToc(state);
        gotoChapter(state, idx);
      }
      return;
    }
    const input = refs.tocList.querySelector('#pageJump');
    const p = Number(input?.value);
    if (Number.isFinite(p) && p >= 1) {
      if (state.mode === 'pdf') state.pdfView?.scrollToPage(p, { smooth: true });
      else state.comicView?.showPage(p);
      closeToc(state);
    }
  };

  refs.readerVoiceChip.onclick = () => {
    openVoiceModal({
      onSaved: () => {
        updateVoiceLabel(state);
        updateReaderVoiceChip(state);
        state.engine.applyVoiceChange();
        applyBookVoice(state);
      },
    });
  };
  refs.readerVoiceChip.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refs.readerVoiceChip.click(); }
  };
  refs.footLeft.onclick = () => openToc(state);
  refs.footPrev.onclick = () => {
    if (state.mode === 'pdf') state.pdfView?.scrollToPage(Math.max(1, (state.page || 1) - 1), { smooth: true });
    else if (state.mode === 'comic') state.comicView?.prevPage();
    else gotoChapter(state, state.chapterIndex - 1);
  };
  refs.footNext.onclick = () => {
    if (state.mode === 'pdf') state.pdfView?.scrollToPage(Math.min(state.numPages || 1, (state.page || 1) + 1), { smooth: true });
    else if (state.mode === 'comic') state.comicView?.nextPage();
    else gotoChapter(state, state.chapterIndex + 1);
  };

  refs.typePanelBody.onclick = e => handleTypeClick(state, e);
  refs.typePanelBody.oninput = e => handleTypeInput(state, e);
  refs.typePanelBody.onchange = e => handleTypeChange(state, e);

  state.queueSave = debounce(() => saveProgressNow(state), 650);
}

function loadingMarkup(title) {
  return `<div class="pdf-loading">
    <div class="spinner"></div>
    <div>Preparing “${esc(title || 'your book')}”…</div>
  </div>`;
}

function showReaderError(state, message) {
  refs.stage.innerHTML = `<div class="pdf-loading">
    <div class="eico" style="width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:var(--reader-bg-2);color:var(--reader-ink-2)">${icon('info')}</div>
    <div class="pdf-err">${esc(message)}</div>
    <button class="btn btn-sm" id="readerErrorBack">Back to library</button>
  </div>`;
  $('#readerErrorBack')?.addEventListener('click', () => closeReader());
  toast(message, 'err');
}

/* ═══════════════════════════════════════════════════════════════════
   Reflowable books
   ═══════════════════════════════════════════════════════════════════ */

async function openReflowBook(state) {
  const book = await buildReflowable(state.record, state.blob);
  if (state.destroyed) { book.dispose?.(); return; }
  state.book = book;
  state.toc = book.toc?.length
    ? book.toc
    : book.chapters.map((c, i) => ({ label: c.label, chapterIndex: i, anchor: '', depth: 0 }));

  const meta = { ...(state.record.meta || {}), chapterCount: book.chapters.length, words: book.words };
  state.record.meta = meta;
  const libBook = state.app.books.find(b => b.id === state.bookId);
  if (libBook) libBook.meta = meta;
  db.updateBook(state.bookId, { meta }).catch(() => {});

  const progress = state.progressRec;
  const hasPosition = state.target.chapterIndex != null
    || (progress && ((progress.percent || 0) > 0.5 || (progress.chapterIndex || 0) > 0 || (progress.page || 1) > 1));
  let targetChapter = state.target.chapterIndex ?? progress?.chapterIndex;
  if (!hasPosition || targetChapter == null) targetChapter = defaultStartChapter(book);
  targetChapter = clamp(targetChapter, 0, book.chapters.length - 1);
  const ratio = state.target.ratio ?? progress?.ratio ?? 0;
  state.chapterIndex = targetChapter;

  state.continuous = !!getPrefs().reader.continuous;
  if (state.continuous) {
    refs.stage.innerHTML = '<div class="continuous-book" id="continuousBook"></div>';
    state.continuousBook = refs.stage.querySelector('#continuousBook');
  }

  renderChapter(state, targetChapter, {
    ratio: state.target.ratio != null ? state.target.ratio : ratio,
    anchor: state.target.anchor,
    highlightId: state.target.highlightId,
    keepDock: false,
    autoplayTTS: false,
  });

  if (state.target.autoplay) setTimeout(() => { if (S === state) startTTS(state, { autoplay: true }); }, 380);
}

function defaultStartChapter(book) {
  const frontMatter = /^(cover|title ?page|contents|table of contents|copyright|colophon|dedication|epigraph|half ?title|frontispiece)$/i;
  const bookTitle = normalizedText(book.title || '').toLowerCase();
  const isFront = (c, i) => {
    const label = normalizedText(c.label || '');
    if (frontMatter.test(label)) return true;
    if (i === 0 && bookTitle && label.toLowerCase() === bookTitle) return true;
    return false;
  };
  let idx = book.chapters.findIndex((c, i) => !isFront(c, i) && (c.words || 0) >= 8);
  if (idx < 0) idx = book.chapters.findIndex((c, i) => !isFront(c, i) && (c.words || 0) > 0);
  if (idx < 0) idx = book.chapters.findIndex(c => (c.words || 0) > 0);
  return Math.max(0, idx);
}

function ensureContinuousSection(state, index) {
  const container = state.continuousBook;
  if (!container || !state.book) return null;
  const existing = container.querySelector(`.chapter-section[data-chapter-index="${index}"]`);
  if (existing) return existing;
  const chapter = state.book.chapters[index];
  if (!chapter) return null;
  const section = document.createElement('section');
  section.className = 'chapter-section';
  section.dataset.chapterIndex = String(index);
  section.innerHTML = chapterMarkup(state, chapter, index);
  const after = Array.from(container.children).find(el => Number(el.dataset.chapterIndex) > index);
  if (after) container.insertBefore(section, after);
  else container.appendChild(section);
  return section;
}

function activateContinuousChapter(state, index, opts = {}) {
  if (!state.book) return;
  const n = state.book.chapters.length;
  index = clamp(index, 0, n - 1);
  const chapter = state.book.chapters[index];
  if (!chapter) return;
  if (!opts.keepDock) closeTTS(state);

  const section = ensureContinuousSection(state, index);
  if (!section) return;
  ensureContinuousSection(state, index + 1);

  state.chapterIndex = index;
  state.chapter = chapter;
  state.sentences = null;
  state.prefetchedChapter = null;
  state.wordsBefore = state.book.chapters.slice(0, index).reduce((sum, c) => sum + (c.words || 0), 0);
  state.ratio = opts.ratio || 0;
  state.renderToken++;
  state.article = section.querySelector('.reading');
  if (state.article) state.article.lang = baseLanguage(state.book?.language || 'en') || 'en';
  refs.readerChapterTitle.textContent = chapter.label || `Chapter ${index + 1}`;
  hideSelection(state);

  if (section.dataset.hlApplied !== '1') {
    applyStoredHighlights(state);
    section.dataset.hlApplied = '1';
  }
  updateTocActive(state);

  const stage = refs.stage;
  const stageRect = stage.getBoundingClientRect();
  const secRect = section.getBoundingClientRect();
  const base = stage.scrollTop + (secRect.top - stageRect.top);
  const extra = (opts.ratio || 0) * Math.max(0, section.offsetHeight - stage.clientHeight);
  state.programmatic = true;
  stage.scrollTo({ top: Math.max(0, base + extra), behavior: 'auto' });
  setTimeout(() => { state.programmatic = false; }, 100);

  const restored = () => {
    if (state.destroyed) return;
    if (opts.anchor) scrollToAnchor(state, opts.anchor);
    else if (opts.highlightId) scrollToMark(state, opts.highlightId);
  };
  if (opts.anchor || opts.highlightId) setTimeout(restored, 60);

  updateReflowProgress(state);
  updateBookmarkButton(state);
  if (!opts.keepDock) state.queueSave?.();
}

function updateContinuousActiveFromScroll(state) {
  const container = state.continuousBook;
  if (!container || state.engine?.state !== 'idle') return;
  const marker = refs.stage.scrollTop + 80;
  const base = container.offsetTop || 0;
  let active = null;
  for (const section of container.children) {
    if (section.offsetTop - base <= marker) active = section;
    else break;
  }
  if (refs.stage.scrollTop + refs.stage.clientHeight >= refs.stage.scrollHeight - 2) {
    active = container.lastElementChild || active;
  }
  if (!active) active = container.firstElementChild;
  if (!active) return;
  const index = Number(active.dataset.chapterIndex);
  if (index === state.chapterIndex) return;
  state.chapterIndex = index;
  state.chapter = state.book.chapters[index] || null;
  state.article = active.querySelector('.reading');
  state.wordsBefore = state.book.chapters.slice(0, index).reduce((sum, c) => sum + (c.words || 0), 0);
  state.sentences = null;
  state.prefetchedChapter = null;
  if (state.chapter) refs.readerChapterTitle.textContent = state.chapter.label || `Chapter ${index + 1}`;
  if (active.dataset.hlApplied !== '1') {
    applyStoredHighlights(state);
    active.dataset.hlApplied = '1';
  }
  updateTocActive(state);
  ensureContinuousSection(state, index + 1);
}

function chapterMarkup(state, chapter, index) {  const book = state.book;
  const n = book.chapters.length;
  const prev = book.chapters[index - 1];
  const next = book.chapters[index + 1];
  const words = new Intl.NumberFormat().format(chapter.words || 0);
  const nav = n > 1 ? `
    <nav class="chapter-nav" aria-label="Chapter navigation">
      <button class="prev" ${prev ? '' : 'disabled'} data-chapter-nav="${index - 1}" aria-label="Previous chapter">
        <span class="cn-label">Previous</span><span class="cn-title">${prev ? esc(prev.label) : '—'}</span>
      </button>
      <button class="next" ${next ? '' : 'disabled'} data-chapter-nav="${index + 1}" aria-label="Next chapter">
        <span class="cn-label">Next</span><span class="cn-title">${next ? esc(next.label) : '—'}</span>
      </button>
    </nav>` : '';
  return `
    <div class="reading-wrap">
      <div class="chapter-head">
        <div class="ch-eyebrow">${esc(chapter.label || `Chapter ${index + 1}`)} · ${index + 1} / ${n} · ${words} words</div>
      </div>
      <article class="reading" id="readingContent">${chapter.html || '<p class="muted">This page is blank.</p>'}</article>
      <div class="chapter-end" aria-hidden="true"><span class="rule"></span>${icon('book')}<span class="rule"></span></div>
      ${nav}
    </div>`;
}

function renderChapter(state, index, opts = {}) {
  if (state.mode !== 'reflow' || !state.book) return;
  if (state.continuous) { activateContinuousChapter(state, index, opts); return; }
  const n = state.book.chapters.length;
  index = clamp(index, 0, n - 1);
  const chapter = state.book.chapters[index];
  if (!chapter) return;

  if (!opts.keepDock) closeTTS(state);

  state.chapterIndex = index;
  state.chapter = chapter;
  state.sentences = null;
  state.wordsBefore = state.book.chapters.slice(0, index).reduce((sum, c) => sum + (c.words || 0), 0);
  state.ratio = 0;
  state.userScrolled = false;
  state.renderToken++;
  const token = state.renderToken;

  refs.stage.innerHTML = chapterMarkup(state, chapter, index);
  state.article = refs.stage.querySelector('.reading');
  if (state.article) state.article.lang = baseLanguage(state.book?.language || 'en') || 'en';
  refs.readerChapterTitle.textContent = chapter.label || `Chapter ${index + 1}`;
  hideSelection(state);

  applyStoredHighlights(state);
  updateTocActive(state);

  const setTop = (top) => {
    state.programmatic = true;
    refs.stage.scrollTop = top;
    setTimeout(() => { if (state.renderToken === token) state.programmatic = false; }, 80);
  };

  const doRestore = () => {
    if (state.destroyed || state.renderToken !== token) return;
    if (opts.anchor) {
      scrollToAnchor(state, opts.anchor);
    } else if (opts.highlightId) {
      scrollToMark(state, opts.highlightId);
    } else if (opts.ratio) {
      const max = Math.max(0, refs.stage.scrollHeight - refs.stage.clientHeight);
      setTop(clamp(opts.ratio, 0, 1) * max);
    } else {
      setTop(0);
    }
    updateReflowProgress(state);
    updateBookmarkButton(state);
    if (!opts.keepDock) state.queueSave?.();
    else updateReflowProgress(state);
  };

  requestAnimationFrame(doRestore);
  const started = Date.now();
  // rAF can be paused in a background/occluded tab; a timer keeps the
  // position and progress correct even before the tab is focused.
  setTimeout(doRestore, 80);
  state.article.querySelectorAll('img').forEach(img => {
    if (img.complete) return;
    img.addEventListener('load', () => {
      if (state.destroyed || state.renderToken !== token || state.userScrolled) return;
      if (Date.now() - started > 1800) return;
      doRestore();
    }, { once: true });
  });

}

/* ── text maps / sentences ───────────────────────────────────────── */
function buildTextMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue;
      if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script,style,noscript')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let text = '';
  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue;
    if (text && /\S$/.test(text) && /^\S/.test(value)) text += ' ';
    const start = text.length;
    text += value;
    nodes.push({ node, start, end: text.length });
  }
  return { text, nodes };
}

function pointForOffset(map, offset) {
  if (!map.nodes.length) return null;
  let lo = 0;
  let hi = map.nodes.length - 1;
  let found = map.nodes[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map.nodes[mid].start <= offset) { found = map.nodes[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return { node: found.node, offset: clamp(offset - found.start, 0, found.node.nodeValue.length) };
}

function rangeFromOffsets(map, start, end) {
  const a = pointForOffset(map, start);
  const b = pointForOffset(map, end);
  if (!a || !b) return null;
  try {
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  } catch {
    return null;
  }
}

function offsetForPoint(map, container, offset) {
  if (container?.nodeType === Node.TEXT_NODE) {
    const rec = map.nodes.find(n => n.node === container);
    if (rec) return rec.start + offset;
  }
  return null;
}

function resolveTextPoint(container, offset) {
  if (!container) return null;
  if (container.nodeType === Node.TEXT_NODE) return { node: container, offset };
  if (container.nodeType === Node.ELEMENT_NODE) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode();
    if (first) return { node: first, offset: 0 };
  }
  return null;
}

function rangeForText(map, text, preferredOffset) {
  if (!text) return null;
  let start = -1;
  if (typeof preferredOffset === 'number' && preferredOffset >= 0) {
    if (map.text.slice(preferredOffset, preferredOffset + text.length) === text) start = preferredOffset;
  }
  if (start < 0) start = map.text.indexOf(text);
  if (start < 0) return null;
  return { start, end: start + text.length, range: rangeFromOffsets(map, start, start + text.length) };
}

function wordTokens(text) {
  const out = [];
  const re = /[\p{L}\p{M}\p{N}]+(?:[’'\-][\p{L}\p{M}\p{N}]+)*/gu;
  let match;
  while ((match = re.exec(text))) {
    out.push({ text: match[0], start: match.index, end: match.index + match[0].length, weight: Math.max(1, match[0].length) });
  }
  return out;
}

function sentenceRecordsFromMap(map, chapterIndex, { includeRanges = true } = {}) {
  const out = [];
  for (const seg of detectSentenceSegments(map.text)) {
    const raw = seg.text;
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text || text.length < 2 || !/[\p{L}\p{N}]/u.test(text)) continue;
    if (/^\s*(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)]?\s*$/i.test(text)) continue;
    const start = seg.start + lead;
    const tokens = wordTokens(text);
    const wordRanges = includeRanges
      ? tokens.map(word => ({ ...word, range: rangeFromOffsets(map, start + word.start, start + word.end) })).filter(word => word.range)
      : tokens;
    const range = rangeFromOffsets(map, start, start + text.length);
    if (range && wordRanges.length) {
      out.push({ text, range, wordRanges, meta: { chapterIndex, localIndex: out.length } });
    }
  }
  return out;
}

function buildReflowTimeline(state) {
  if (state.bookTimeline?.book === state.book) return state.bookTimeline;
  const entries = [];
  const byChapter = state.book.chapters.map(() => []);
  for (let chapterIndex = 0; chapterIndex < state.book.chapters.length; chapterIndex++) {
    const chapter = state.book.chapters[chapterIndex];
    const holder = document.createElement('div');
    holder.className = 'reading';
    holder.innerHTML = chapter.html || '';
    const map = buildTextMap(holder);
    const records = sentenceRecordsFromMap(map, chapterIndex, { includeRanges: false });
    for (const record of records) {
      const weights = record.wordRanges.map(word => word.weight);
      const entry = {
        chapterIndex,
        sentenceIndex: record.meta.localIndex,
        wordCount: weights.length,
        weight: weights.length * 5,
      };
      byChapter[chapterIndex].push(entries.length);
      entries.push(entry);
    }
  }
  const prefix = [0];
  for (const entry of entries) prefix.push(prefix[prefix.length - 1] + entry.weight);
  state.bookTimeline = { book: state.book, entries, byChapter, prefix, totalWeight: prefix[prefix.length - 1] || 0 };
  return state.bookTimeline;
}

async function ensurePdfTimeline(state) {
  if (state.pdfTimeline) return state.pdfTimeline;
  if (state.pdfTimelinePromise) return state.pdfTimelinePromise;
  state.pdfTimelinePromise = (async () => {
    const entries = [];
    const byPage = Array.from({ length: state.numPages || 0 }, () => []);
    for (let page = 1; page <= (state.numPages || 0); page++) {
      if (state.destroyed) return null;
      const sentences = await state.pdfView.getPageSentences(page);
      for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex++) {
        const text = String(sentences[sentenceIndex].text || '').trim();
        const weights = wordTokens(text).map(word => word.weight);
        if (!weights.length) continue;
        byPage[page - 1].push(entries.length);
        entries.push({ page, sentenceIndex, wordCount: weights.length, weight: weights.length * 5 });
      }
      if (page % 12 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (state.destroyed) return null;
    const prefix = [0];
    for (const entry of entries) prefix.push(prefix[prefix.length - 1] + entry.weight);
    state.pdfTimeline = { entries, byPage, prefix, totalWeight: prefix[prefix.length - 1] || 0 };
    const page = state.ttsPage || state.page || 1;
    const local = state.engine?.index || 0;
    state.timelineEntryIndex = byPage[page - 1]?.[local] ?? null;
    updateTTSTimeline(state);
    return state.pdfTimeline;
  })().finally(() => { state.pdfTimelinePromise = null; });
  return state.pdfTimelinePromise;
}

function buildChapterSentences(state) {
  if (state.sentences) return state.sentences;
  const article = state.article;
  if (!article) return [];
  const map = buildTextMap(article);
  const out = sentenceRecordsFromMap(map, state.chapterIndex);
  const globalEntries = buildReflowTimeline(state).byChapter[state.chapterIndex] || [];
  out.forEach((sentence, index) => { sentence.meta.timelineIndex = globalEntries[index]; });
  state.sentences = out;
  return out;
}

/* ── highlights in the page ──────────────────────────────────────── */
function markClass(color) {
  return ['amber', 'sage', 'sky', 'rose'].includes(color) ? `hl-${color}` : 'hl-amber';
}

function wrapOffsets(state, map, start, end, color, id) {
  const affected = map.nodes
    .filter(rec => rec.end > start && rec.start < end)
    .filter(rec => !rec.node.parentElement?.closest('mark.hl'))
    .reverse();
  let made = 0;
  for (const rec of affected) {
    const localStart = Math.max(start - rec.start, 0);
    const localEnd = Math.min(end - rec.start, rec.node.nodeValue.length);
    if (localEnd <= localStart) continue;
    try {
      let node = rec.node;
      const originalLength = node.nodeValue.length;
      if (localStart > 0) node = node.splitText(localStart);
      if (localEnd < originalLength) node.splitText(localEnd - localStart);
      const mark = document.createElement('mark');
      mark.className = `hl ${markClass(color)}`;
      mark.dataset.hlId = id;
      node.parentNode.insertBefore(mark, node);
      mark.appendChild(node);
      made++;
    } catch {}
  }
  return made;
}

function applyStoredHighlights(state) {
  if (!state.article) return;
  const recs = state.highlights
    .filter(h => h.chapterIndex === state.chapterIndex)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const h of recs) {
    if (!h.text) continue;
    const map = buildTextMap(state.article);
    const found = rangeForText(map, h.text, h.offset);
    if (!found) continue;
    if (h.offset !== found.start) {
      h.offset = found.start;
      db.putHighlight(h).catch(() => {});
    }
    wrapOffsets(state, map, found.start, found.end, h.color, h.id);
  }
}

function applyOneHighlight(state, h) {
  if (!state.article) return;
  const map = buildTextMap(state.article);
  const found = rangeForText(map, h.text, h.offset);
  if (!found) return;
  wrapOffsets(state, map, found.start, found.end, h.color, h.id);
}

function removeMark(state, id) {
  const marks = Array.from(state.article?.querySelectorAll(`mark[data-hl-id="${CSS.escape(id)}"]`) || []);
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

/* ── progress + navigation ───────────────────────────────────────── */
function reflowRatio(state) {
  const stage = refs.stage;
  if (state.continuous && state.continuousBook) {
    const section = state.continuousBook.querySelector(`.chapter-section[data-chapter-index="${state.chapterIndex}"]`);
    if (section) {
      const secTop = stage.scrollTop + section.getBoundingClientRect().top - stage.getBoundingClientRect().top;
      const max = Math.max(1, section.offsetHeight - stage.clientHeight);
      return clamp((stage.scrollTop - secTop) / max, 0, 1);
    }
  }
  const max = stage.scrollHeight - stage.clientHeight;
  return max > 0 ? clamp(stage.scrollTop / max, 0, 1) : 0;
}

function updateReflowProgress(state, { queue = true } = {}) {
  if (state.mode !== 'reflow' || !state.book) return;
  const ratio = reflowRatio(state);
  state.ratio = ratio;
  const n = state.book.chapters.length;
  const words = state.chapter?.words || 0;
  const wordsBefore = state.wordsBefore || 0;
  const done = wordsBefore + words * ratio;
  const totalWords = state.book.words || 0;
  const pct = totalWords > 0
    ? clamp((done / totalWords) * 100, 0, 100)
    : clamp(((state.chapterIndex + ratio) / Math.max(1, n)) * 100, 0, 100);
  state.percent = pct;
  const remaining = Math.max(0, totalWords - done);

  refs.progressFill.style.width = `${pct}%`;
  refs.footLeft.textContent = `Chapter ${state.chapterIndex + 1} of ${n}`;
  refs.footRight.textContent = pct >= 99.9 ? 'Finished' : `${Math.round(pct)}% · ${formatTimeLeft(remaining)}`;
  updateFootNav(state);
  if (queue) state.queueSave?.();
}

function updateFootNav(state) {
  if (!refs?.footPrev) return;
  const reflow = state.mode === 'reflow';
  const total = reflow ? (state.book?.chapters?.length || 1) : (state.numPages || 1);
  const current = reflow ? (state.chapterIndex + 1) : (state.page || 1);
  refs.footPrev.disabled = current <= 1;
  refs.footNext.disabled = current >= total;
  refs.footLeft.title = reflow ? 'Open contents and jump to a chapter' : 'Open pages and jump to a page';
}

function updateBookmarkButton(state) {
  const rec = findBookmarkAt(state);
  refs.bmBtn.classList.toggle('is-on', !!rec);
  refs.bmBtn.setAttribute('aria-pressed', rec ? 'true' : 'false');
}

function currentLocation(state) {
  if (state.mode === 'pdf' || state.mode === 'comic') {
    return {
      chapterIndex: Math.max(0, (state.page || 1) - 1),
      page: state.page || 1,
      ratio: state.numPages > 1 ? ((state.page || 1) - 1) / (state.numPages - 1) : 0,
      percent: state.numPages ? clamp(((state.page || 1) / state.numPages) * 100, 0, 100) : 0,
      chapterTitle: `Page ${state.page || 1}`,
    };
  }
  if (!state.book) return null;
  return {
    chapterIndex: state.chapterIndex,
    ratio: state.ratio || 0,
    percent: state.percent || 0,
    chapterTitle: state.chapter?.label || `Chapter ${state.chapterIndex + 1}`,
  };
}

async function saveProgressNow(state) {
  if (!state || state.destroyed) return;
  if (state.mode === 'reflow') updateReflowProgress(state, { queue: false });
  const loc = currentLocation(state);
  if (!loc) return;
  const rec = {
    bookId: state.bookId,
    chapterIndex: loc.chapterIndex,
    ratio: loc.ratio,
    percent: loc.percent,
    chapterTitle: loc.chapterTitle,
    updatedAt: Date.now(),
  };
  if (loc.page) rec.page = loc.page;
  state.progressRec = rec;
  state.app.progress.set(state.bookId, rec);
  rememberReadingSession(state);
  try { await db.putProgress(rec); } catch {}
}

function handleScroll(state) {
  if (state.destroyed) return;
  if (!state.programmatic) state.userScrolled = true;
  if (!refs.selBar.hidden) hideSelection(state);
  if (state.mode === 'reflow') {
    if (state.continuous) updateContinuousActiveFromScroll(state);
    updateReflowProgress(state);
    updateBookmarkButton(state);
  }
}

function gotoChapter(state, index, opts = {}) {
  if (state.mode !== 'reflow') return;
  const n = state.book.chapters.length;
  const next = clamp(index, 0, n - 1);
  if (next === state.chapterIndex) {
    if (opts.anchor) { scrollToAnchor(state, opts.anchor); return; }
    if (opts.highlightId) { scrollToMark(state, opts.highlightId); return; }
    if (opts.ratio != null) { scrollToRatio(state, opts.ratio); return; }
    return;
  }
  closeTTS(state);
  renderChapter(state, next, { ratio: opts.ratio || 0, anchor: opts.anchor, highlightId: opts.highlightId, keepDock: false });
}

function scrollToRatio(state, ratio) {
  let top;
  if (state.continuous) {
    const section = state.continuousBook?.querySelector(`.chapter-section[data-chapter-index="${state.chapterIndex}"]`);
    if (section) {
      const stage = refs.stage;
      const base = stage.scrollTop + section.getBoundingClientRect().top - stage.getBoundingClientRect().top;
      top = base + clamp(ratio, 0, 1) * Math.max(0, section.offsetHeight - stage.clientHeight);
    }
  }
  if (top == null) top = Math.max(0, refs.stage.scrollHeight - refs.stage.clientHeight) * clamp(ratio, 0, 1);
  state.programmatic = true;
  refs.stage.scrollTo({ top, behavior: 'auto' });
  setTimeout(() => { state.programmatic = false; }, 100);
}

function scrollToAnchor(state, anchor) {
  if (!state.article || !anchor) return;
  let el = null;
  try { el = state.article.querySelector(`#${CSS.escape(anchor)}`); } catch {}
  if (!el) {
    try { el = state.article.querySelector(`[name="${CSS.escape(anchor)}"]`); } catch {}
  }
  if (!el) return;
  const stageRect = refs.stage.getBoundingClientRect();
  const top = refs.stage.scrollTop + el.getBoundingClientRect().top - stageRect.top - 80;
  state.programmatic = true;
  refs.stage.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  setTimeout(() => { state.programmatic = false; }, 100);
}

function scrollToMark(state, id) {
  const mark = state.article?.querySelector(`mark[data-hl-id="${CSS.escape(id)}"]`);
  if (!mark) return;
  const stageRect = refs.stage.getBoundingClientRect();
  const top = refs.stage.scrollTop + mark.getBoundingClientRect().top - stageRect.top - refs.stage.clientHeight * 0.32;
  state.programmatic = true;
  refs.stage.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  setTimeout(() => { state.programmatic = false; }, 100);
}

/* ── bookmarks ───────────────────────────────────────────────────── */
function findBookmarkAt(state) {
  const list = state.bookmarks || [];
  if (state.mode === 'pdf' || state.mode === 'comic') {
    return list.find(b => b.page === (state.page || 1)) || null;
  }
  return list.find(b => b.chapterIndex === state.chapterIndex && Math.abs((b.ratio || 0) - (state.ratio || 0)) < 0.018) || null;
}

function snippetAtViewport(state) {
  if (!state.article) return '';
  const stageRect = refs.stage.getBoundingClientRect();
  let nodes = Array.from(state.article.querySelectorAll('p,li,blockquote')).filter(el => (el.textContent || '').trim().length >= 16);
  if (!nodes.length) nodes = Array.from(state.article.querySelectorAll('h1,h2,h3,h4'));
  let fallback = '';
  for (const el of nodes) {
    const t = normalizedText(el.textContent || '');
    if (!t) continue;
    if (!fallback) fallback = t;
    const r = el.getBoundingClientRect();
    if (r.height && r.bottom > stageRect.top + 58) return t.slice(0, 190);
  }
  return (fallback || normalizedText(state.chapter?.html?.replace(/<[^>]+>/g, ' ') || '')).slice(0, 190);
}

async function toggleBookmark(state) {
  const existing = findBookmarkAt(state);
  if (existing) {
    await db.deleteBookmark(existing.id);
    state.bookmarks = state.bookmarks.filter(b => b.id !== existing.id);
    state.app.bookmarks = state.app.bookmarks.filter(b => b.id !== existing.id);
    updateBookmarkButton(state);
    updateCounts(state);
    toast('Bookmark removed', 'ok');
    return;
  }

  const loc = currentLocation(state);
  if (!loc) return;
  let snippet = '';
  if (state.mode === 'pdf') {
    snippet = (await state.pdfView?.getPageText(state.page || 1)) || '';
  } else if (state.mode === 'comic') {
    snippet = state.comic?.pages[(state.page || 1) - 1]?.name || `Page ${state.page || 1}`;
  } else {
    snippet = snippetAtViewport(state);
  }
  const rec = {
    id: uid(),
    bookId: state.bookId,
    chapterIndex: loc.chapterIndex,
    ratio: loc.ratio,
    page: loc.page,
    chapterTitle: loc.chapterTitle,
    snippet: snippet.slice(0, 200),
    createdAt: Date.now(),
  };
  if (!rec.page) delete rec.page;
  await db.putBookmark(rec);
  state.bookmarks.unshift(rec);
  state.app.bookmarks.unshift(rec);
  updateBookmarkButton(state);
  updateCounts(state);
  toast('Bookmark saved', 'ok');
}

function updateCounts(state) {
  if (!state.app) return;
  state.app.counts = {
    books: state.app.books.length,
    bookmarks: (state.app.bookmarks || []).length,
    highlights: (state.app.highlights || []).length,
  };
  state.app.refreshRail?.();
}

/* ═══════════════════════════════════════════════════════════════════
   Selection + highlights
   ═══════════════════════════════════════════════════════════════════ */

function showSelection(state) {
  if (state.destroyed || state.mode !== 'reflow' || !state.article) return;
  if (isModalOpen()) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideSelection(state); return; }
  const range = sel.getRangeAt(0);
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2) { hideSelection(state); return; }
  if (!state.article.contains(range.commonAncestorContainer)) { hideSelection(state); return; }
  if (text.length > 20000) { hideSelection(state); return; }

  state.pendingSel = { range: range.cloneRange(), text };
  refs.selBar.hidden = false;
  refs.selBar.classList.remove('is-below');

  const r = range.getBoundingClientRect();
  if (!r.width && !r.height) { hideSelection(state); return; }
  const br = refs.selBar.getBoundingClientRect();
  let left = r.left + r.width / 2 - br.width / 2;
  let top = r.top - br.height - 12;
  if (top < 8) { top = r.bottom + 12; refs.selBar.classList.add('is-below'); }
  left = clamp(left, 8, window.innerWidth - br.width - 8);
  top = clamp(top, 8, window.innerHeight - br.height - 8);
  refs.selBar.style.left = `${Math.round(left)}px`;
  refs.selBar.style.top = `${Math.round(top)}px`;
}

function hideSelection(state, { clear = true } = {}) {
  if (refs) refs.selBar.hidden = true;
  if (clear) state.pendingSel = null;
}

async function handleSelectionAction(state, e) {
  const colorBtn = e.target.closest('[data-hlcolor]');
  if (colorBtn) {
    if (!state.pendingSel) return;
    await createHighlightFromSelection(state, colorBtn.dataset.hlcolor, '');
    return;
  }
  const action = e.target.closest('[data-sel]')?.dataset.sel;
  if (!action) return;
  if (action === 'define') {
    const text = state.pendingSel?.text || window.getSelection()?.toString() || '';
    hideSelection(state);
    window.getSelection()?.removeAllRanges();
    openDictionary(text, state.book?.language || 'en');
    return;
  }
  if (action === 'copy') {
    const ok = await copyText(state.pendingSel?.text || '');
    toast(ok ? 'Copied' : 'Could not copy', ok ? 'ok' : 'err');
    hideSelection(state);
    window.getSelection()?.removeAllRanges();
    return;
  }
  if (action === 'note') {
    openNoteDialog(state, { color: 'amber' });
    return;
  }
  if (action === 'listen') {
    if (!getPrefs().tts.enabled) { toast('Narration is off. Turn it on in Settings → Voice.', 'info'); return; }
    const snapshot = state.pendingSel;
    if (!snapshot) return;
    const sentences = buildChapterSentences(state);
    let index = 0;
    try {
      const point = resolveTextPoint(snapshot.range.startContainer, snapshot.range.startOffset);
      if (point) {
        const found = sentences.findIndex(s => {
          try { return s.range.comparePoint(point.node, point.offset) === 0; } catch { return false; }
        });
        if (found >= 0) index = found;
      }
    } catch {}
    hideSelection(state);
    if (!refs.ttsDock.classList.contains('is-open')) openDock(state);
    startTTS(state, { autoplay: true, start: index });
  }
}

async function createHighlightFromSelection(state, color, note, snapshotOverride = null) {
  const snapshot = snapshotOverride || state.pendingSel;
  if (!snapshot) return;
  const map = buildTextMap(state.article);
  const point = resolveTextPoint(snapshot.range.startContainer, snapshot.range.startOffset);
  let offset = point ? offsetForPoint(map, point.node, point.offset) : null;
  if (offset == null) offset = map.text.indexOf(snapshot.text);
  if (offset == null) offset = 0;

  const rec = {
    id: uid(),
    bookId: state.bookId,
    chapterIndex: state.chapterIndex,
    chapterTitle: state.chapter?.label || `Chapter ${state.chapterIndex + 1}`,
    text: snapshot.text,
    color: color || 'amber',
    note: note || '',
    offset,
    createdAt: Date.now(),
  };
  try {
    await db.putHighlight(rec);
  } catch (err) {
    toast(err.message || 'Could not save the highlight.', 'err');
    return;
  }
  state.highlights.push(rec);
  state.app.highlights.push(rec);
  updateCounts(state);

  const found = rangeForText(map, rec.text, offset);
  if (found) wrapOffsets(state, map, found.start, found.end, rec.color, rec.id);

  hideSelection(state);
  window.getSelection()?.removeAllRanges();
  toast(note ? 'Highlight and note saved' : 'Highlight saved', 'ok');
  return rec;
}

function openNoteDialog(state, { color = 'amber', existing = null } = {}) {
  if (!existing && !state.pendingSel) return;
  const snapshot = existing ? null : state.pendingSel;
  const text = existing?.text || snapshot.text;
  let chosen = existing?.color || color;

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="form-stack">
      <div class="callout" style="max-height:110px;overflow:auto;font-family:var(--font-read);font-size:13px;line-height:1.6">“${esc(text)}”</div>
      <div class="field">
        <label>Highlight colour</label>
        <div style="display:flex;gap:9px">
          ${['amber', 'sage', 'sky', 'rose'].map(c => `<button class="dot ${c}" data-note-color="${c}" style="width:26px;height:26px;border-color:${c === chosen ? 'var(--ink)' : 'transparent'}" aria-label="${c}"></button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label for="noteText">Your note <span class="dim" style="font-weight:400">· optional</span></label>
        <textarea class="input" id="noteText" rows="4" placeholder="A thought to keep with this passage…">${esc(existing?.note || '')}</textarea>
      </div>
    </div>`;
  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:9px;width:100%;justify-content:flex-end';
  foot.innerHTML = `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>`;

  const m = modal({
    eyebrow: 'Highlight',
    title: existing ? 'Edit note' : 'Add a note',
    body,
    foot,
    onMount: ({ close }) => {
      body.querySelectorAll('[data-note-color]').forEach(btn => {
        btn.onclick = () => {
          chosen = btn.dataset.noteColor;
          body.querySelectorAll('[data-note-color]').forEach(b => {
            b.style.borderColor = b === btn ? 'var(--ink)' : 'transparent';
          });
        };
      });
      foot.querySelector('[data-cancel]').onclick = () => { hideSelection(state); close('cancel'); };
      foot.querySelector('[data-save]').onclick = async () => {
        const note = body.querySelector('#noteText').value.trim();
        if (existing) {
          existing.note = note;
          existing.color = chosen;
          close('save');
          await db.putHighlight(existing);
          const marks = state.article?.querySelectorAll(`mark[data-hl-id="${CSS.escape(existing.id)}"]`) || [];
          marks.forEach(mark => { mark.className = `hl ${markClass(chosen)}`; });
          toast('Note saved', 'ok');
        } else {
          const rec = await createHighlightFromSelection(state, chosen, note, snapshot);
          close('save');
          if (!rec) hideSelection(state);
        }
      };
      setTimeout(() => body.querySelector('#noteText')?.focus(), 30);
    },
    onClose: () => { if (!existing) hideSelection(state); },
  });
  return m;
}

function openHighlightMenu(state, rec, x, y) {
  contextMenu(x, y, [
    { label: rec.note ? 'Edit note' : 'Add a note', icon: 'note', onSelect: () => openNoteDialog(state, { existing: rec }) },
    { label: 'Copy passage', icon: 'copy', onSelect: async () => { const ok = await copyText(rec.text); toast(ok ? 'Copied' : 'Could not copy', ok ? 'ok' : 'err'); } },
    { sep: true },
    {
      label: 'Remove highlight', icon: 'trash', danger: true, onSelect: async () => {
        await db.deleteHighlight(rec.id);
        state.highlights = state.highlights.filter(h => h.id !== rec.id);
        state.app.highlights = state.app.highlights.filter(h => h.id !== rec.id);
        removeMark(state, rec.id);
        updateCounts(state);
        toast('Highlight removed', 'ok');
      },
    },
  ]);
}

/* ═══════════════════════════════════════════════════════════════════
   TTS
   ═══════════════════════════════════════════════════════════════════ */

function openDock(state) {
  refs.ttsDock.hidden = false;
  // Force a layout read so the transition still runs, but don't depend on rAF
  // (it can be paused in background windows).
  void refs.ttsDock.offsetWidth;
  refs.ttsDock.classList.add('is-open');
  updateTTSState(state, state.engine?.state || 'idle');
  if (!state.ttsUiTimer) state.ttsUiTimer = setInterval(() => updateTTSTimeline(state), 200);
  updateTTSTimeline(state);
  updateVoiceLabel(state);
  updateSpeedLabel();
}

function closeTTS(state, { hideDock = true } = {}) {
  state.resumePending = false;
  state.engine?.stop();
  rememberReadingSession(state);
  clearTTSHighlight(state);
  state.ttsPage = null;
  state.ttsAdvancing = false;
  if (hideDock) {
    clearInterval(state.ttsUiTimer);
    state.ttsUiTimer = null;
    refs.ttsSpeedPanel.hidden = true;
    refs.ttsSpeedBtn.setAttribute('aria-expanded', 'false');
    refs.ttsDock.classList.remove('is-open');
    refs.ttsEq.classList.remove('is-live');
    refs.ttsBtn.classList.remove('is-live');
    refs.ttsBtn.querySelector('span').textContent = 'Listen';
    refs.ttsPos.textContent = '—';
    setTimeout(() => {
      if (S === state && !refs.ttsDock.classList.contains('is-open')) refs.ttsDock.hidden = true;
    }, 260);
  }
  clearMediaSession();
}

async function toggleListen(state) {
  state.engine?._primeAudio?.();
  applyBookVoice(state);
  if (state.mode === 'comic') {
    toast('Comic pages are images, so there’s no text to narrate.', 'info');
    return;
  }
  if (!getPrefs().tts.enabled) {
    toast('Narration is off. Turn it on in Settings → Voice.', 'info');
    return;
  }
  if (state.mode === 'reflow' && !state.book) return;
  if (state.mode === 'pdf' && !state.pdfView) return;

  if (!refs.ttsDock.classList.contains('is-open')) {
    await startTTS(state, { autoplay: true });
    return;
  }
  const st = state.engine?.state;
  if (st === 'playing' || st === 'loading') {
    state.resumePending = false;
    state.engine.pause();
  } else state.engine.play();
}

function applyBookVoice(state) {
  const engine = state.engine;
  if (!engine) return;
  const tts = getPrefs().tts;
  const bookLang = baseLanguage(state.book?.language || state.record?.language || '');
  if (!tts.enabled || tts.provider !== 'piper' || tts.autoLanguageVoice === false || !bookLang || bookLang === 'en') {
    engine.setVoiceOverride(null);
    updateReaderVoiceChip(state);
    return;
  }
  const current = piperVoiceById(tts.piperVoice);
  if (languageMatches(current?.lang, bookLang)) {
    engine.setVoiceOverride(null);
    updateReaderVoiceChip(state);
    return;
  }
  const match = piperVoiceForLanguage(bookLang);
  if (!match) {
    engine.setVoiceOverride(null);
    updateReaderVoiceChip(state);
    return;
  }
  engine.setVoiceOverride({ voiceId: match.id, speaker: 0, name: match.name });
  updateReaderVoiceChip(state);
  if (!state.languageVoiceNotice) {
    toast(`Using ${match.name} for this ${languageName(bookLang)} book`, 'info');
    state.languageVoiceNotice = true;
  }
}

async function prefetchOpeningAudio(state) {
  if (!state || state.destroyed || state.mode === 'comic') return;
  const tts = getPrefs().tts;
  if (!tts.enabled || tts.provider !== 'piper') return;
  applyBookVoice(state);
  try {
    let sentences = [];
    if (state.mode === 'pdf') {
      sentences = await state.pdfView.getPageSentences(state.page || 1);
    } else {
      sentences = buildChapterSentences(state);
    }
    if (!sentences.length) return;
    let start = state.mode === 'pdf' ? 0 : firstVisibleSentence(state, sentences);
    if (state.resumePoint && state.resumePoint.chapterIndex === state.chapterIndex) {
      start = Math.max(0, state.resumePoint.sentenceIndex || 0);
    }
    const texts = sentences.slice(start, start + 3).map(sentence => sentence.text);
    if (!texts.length) return;
    state.engine?.prefetchTexts(texts);
  } catch {}
}

async function startTTS(state, { autoplay = true, start = null, startFraction = null, paused = false } = {}) {
  applyBookVoice(state);
  if (state.mode === 'comic') {
    toast('Comic pages are images, so there’s no text to narrate.', 'info');
    return;
  }
  if (!getPrefs().tts.enabled) {
    toast('Narration is off. Turn it on in Settings → Voice.', 'info');
    return;
  }
  if (state.mode === 'pdf') {
    const point = start == null && state.resumePoint && (!state.resumePoint.page || state.resumePoint.page === (state.page || 1))
      ? state.resumePoint
      : null;
    return startPdfTTS(state, {
      autoplay,
      paused,
      page: point?.page || state.page || 1,
      start: point?.sentenceIndex ?? start,
      startFraction: point?.fraction ?? startFraction,
    });
  }
  buildReflowTimeline(state);
  const sentences = buildChapterSentences(state);
  if (!sentences.length) return false;
  let index = start;
  let fraction = startFraction;
  if (index == null && state.resumePoint && state.resumePoint.chapterIndex === state.chapterIndex) {
    index = state.resumePoint.sentenceIndex;
    if (fraction == null) fraction = state.resumePoint.fraction;
  }
  if (index == null) index = firstVisibleSentence(state, sentences);
  openDock(state);
  state.ttsPage = null;
  state.engine.load(sentences, {
    autoplay,
    paused,
    start: clamp(index || 0, 0, sentences.length - 1),
    startFraction: fraction,
  });
  state.resumePoint = null;
  updateMediaSession(state);
  return true;
}

async function startPdfTTS(state, { autoplay = true, page = null, start = null, startFraction = null, paused = false } = {}) {
  if (!state.pdfView) return;
  ensurePdfTimeline(state).catch(err => console.warn('Could not prepare the PDF seek timeline', err));
  let p = clamp(page || state.page || 1, 1, state.numPages || 1);
  let sentences = await state.pdfView.getPageSentences(p);
  let tries = 0;
  while (!sentences.length && p < (state.numPages || 1) && tries < 6) {
    p++;
    tries++;
    sentences = await state.pdfView.getPageSentences(p);
  }
  if (!sentences.length) return false;
  if (p !== state.page) {
    state.ttsAdvancing = true;
    state.pdfView.scrollToPage(p, { smooth: false });
    setTimeout(() => { state.ttsAdvancing = false; }, 250);
  }
  sentences = sentences.map(s => ({ ...s, page: p }));
  let startIndex = start;
  let fraction = startFraction;
  if (startIndex == null && state.resumePoint && (!state.resumePoint.page || state.resumePoint.page === p)) {
    startIndex = state.resumePoint.sentenceIndex;
    if (fraction == null) fraction = state.resumePoint.fraction;
  }
  openDock(state);
  state.ttsPage = p;
  state.engine.load(sentences, {
    autoplay,
    paused,
    start: clamp(startIndex || 0, 0, sentences.length - 1),
    startFraction: fraction,
  });
  state.resumePoint = null;
  updateMediaSession(state);
  return true;
}

function firstVisibleSentence(state, sentences) {
  const stageRect = refs.stage.getBoundingClientRect();
  const top = stageRect.top + 70;
  for (let i = 0; i < sentences.length; i++) {
    const r = sentences[i].range?.getBoundingClientRect();
    if (r && r.bottom > top) return i;
  }
  return 0;
}

function onTTSSentence(state, sentence, index) {
  refs.ttsPos.textContent = `${index + 1} / ${state.engine.total}`;
  state.ttsCurrentSentence = sentence;
  state.ttsCurrentWordIndex = -1;
  if (state.mode === 'pdf') {
    const page = sentence.page || state.ttsPage || state.page || 1;
    state.timelineEntryIndex = state.pdfTimeline?.byPage?.[page - 1]?.[index] ?? null;
  } else {
    const chapter = sentence.meta?.chapterIndex ?? state.chapterIndex;
    state.timelineEntryIndex = state.bookTimeline?.byChapter?.[chapter]?.[sentence.meta?.localIndex ?? index] ?? null;
  }
  state.lastSessionSave = Date.now();
  rememberReadingSession(state);
  prefetchNextChapter(state, index);
  if (!getPrefs().tts.highlight) return;
  if (state.mode === 'pdf') {
    state.pdfView?.showHighlight(sentence);
    return;
  }
  showTTSHighlight(state, sentence);
}

function chapterHasBody(chapter) {
  if (!chapter?.html) return false;
  const holder = document.createElement('div');
  holder.innerHTML = chapter.html;
  holder.querySelectorAll('h1,h2,h3,h4,h5,h6,figcaption').forEach(el => el.remove());
  return normalizedText(holder.textContent || '').replace(/\s+/g, ' ').trim().length >= 20;
}

function sentencesFromChapter(chapter) {
  if (!chapter?.html) return [];
  const holder = document.createElement('div');
  holder.className = 'reading';
  holder.innerHTML = chapter.html;
  const map = buildTextMap(holder);
  return detectSentenceSegments(map.text)
    .map(seg => seg.text.trim())
    .filter(text => text.length >= 2 && /[\p{L}\p{N}]/u.test(text));
}

function prefetchNextChapter(state, index) {
  if (state.mode !== 'reflow' || !state.book?.chapters?.length) return;
  if (index < (state.engine?.total || 0) - 2) return;
  const nextIndex = state.chapterIndex + 1;
  if (nextIndex >= state.book.chapters.length || state.prefetchedChapter === nextIndex) return;
  if (!chapterHasBody(state.book.chapters[nextIndex])) return;
  const texts = sentencesFromChapter(state.book.chapters[nextIndex]).slice(0, 3);
  if (!texts.length) return;
  state.prefetchedChapter = nextIndex;
  state.engine?.prefetchTexts(texts);
}

function showTTSHighlight(state, sentence) {
  clearTTSHighlight(state);
  if (!sentence?.range) return;
  if (window.CSS?.highlights && window.Highlight) {
    try {
      const hi = new Highlight(sentence.range);
      CSS.highlights.set('lumen-tts', hi);
      state.ttsHighlight = hi;
    } catch {}
  } else {
    const el = blockOfRange(sentence.range);
    if (el) { el.classList.add('tts-block-hl'); state.ttsBlock = el; }
  }
  scrollRangeIntoView(sentence.range);
}

function clearTTSHighlight(state) {
  try { CSS.highlights?.delete('lumen-tts'); } catch {}
  try { CSS.highlights?.delete('lumen-tts-word'); } catch {}
  state.ttsHighlight = null;
  state.ttsWordHighlight = null;
  state.ttsCurrentWordIndex = -1;
  if (state.ttsBlock) { state.ttsBlock.classList.remove('tts-block-hl'); state.ttsBlock = null; }
  if (state.mode === 'pdf') state.pdfView?.clearHighlight?.();
}

function blockOfRange(range) {
  let node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  return node?.closest('p,li,blockquote,h1,h2,h3,h4,div') || null;
}

function scrollRangeIntoView(range) {
  if (!range) return;
  const rects = range.getClientRects();
  if (!rects.length) return;
  const r = rects[0];
  const stageRect = refs.stage.getBoundingClientRect();
  if (r.top < stageRect.top + 64 || r.bottom > stageRect.bottom - 130) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const top = refs.stage.scrollTop + (r.top - stageRect.top) - refs.stage.clientHeight * 0.32;
    refs.stage.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
  }
}

function showResumeBanner(state) {
  if (!state || state.destroyed || !refs?.reader) return;
  let banner = document.getElementById('resumeBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'resumeBanner';
    banner.className = 'resume-banner';
    banner.innerHTML = '<span>Narration paused at your saved place.</span><button class="btn btn-sm btn-primary" data-resume-play>Play</button><button class="icon-btn" data-resume-dismiss aria-label="Dismiss">×</button>';
    refs.reader.appendChild(banner);
    banner.querySelector('[data-resume-play]').onclick = () => {
      hideResumeBanner();
      window.lumen?.resumeTTS?.();
    };
    banner.querySelector('[data-resume-dismiss]').onclick = () => hideResumeBanner();
  }
  banner.hidden = false;
}

function hideResumeBanner() {
  const banner = document.getElementById('resumeBanner');
  if (banner) banner.hidden = true;
}

function updateTTSState(state, st) {
  if (!refs) return;
  const btn = refs.ttsDock.querySelector('.tts-play');
  const transitioning = st === 'idle' && state.engine?._wantPlaying;
  const playing = st === 'playing' || st === 'loading' || transitioning;
  if (btn) {
    btn.innerHTML = icon(playing ? 'pause' : 'loudhailer');
    btn.classList.toggle('is-playing', st === 'playing');
    btn.setAttribute('aria-label', playing ? 'Pause narration' : 'Play narration');
  }
  refs.ttsBtn.classList.toggle('is-live', playing);
  refs.ttsBtn.querySelector('span').textContent = playing ? 'Listening' : 'Listen';
  refs.ttsEq.classList.toggle('is-live', st === 'playing' || transitioning);
  if (st === 'playing') refs.ttsEq.classList.add('is-live');
  if (st === 'paused') rememberReadingSession(state);
  if (st === 'playing' || st === 'loading') {
    state.resumePending = false;
    hideResumeBanner();
    if (state.resumeBannerTimer) { clearTimeout(state.resumeBannerTimer); state.resumeBannerTimer = null; }
  } else if (st === 'idle' && state.engine?._wantPlaying && state.engine?.sentences?.length) {
    if (!state.resumeBannerTimer) {
      state.resumeBannerTimer = setTimeout(() => {
        state.resumeBannerTimer = null;
        if (state.engine?.state === 'idle' && state.engine?._wantPlaying) showResumeBanner(state);
      }, 1600);
    }
  }
  if (refs.ttsPercent && st !== 'loading') refs.ttsPercent.hidden = true;
  if (st === 'loading') {
    const e = state.engine;
    refs.ttsPos.textContent = e?.total && (e.index || 0) > 0
      ? `Preparing ${Math.min(e.index + 1, e.total)} / ${e.total}…`
      : 'Preparing voice…';
  } else if (st === 'playing' && state.engine?.total) {
    refs.ttsPos.textContent = `${Math.min((state.engine.index || 0) + 1, state.engine.total)} / ${state.engine.total}`;
  }
  if (navigator.mediaSession) {
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : st === 'paused' ? 'paused' : 'none';
    } catch {}
  }
  if (st === 'playing') updateMediaSession(state);
}

function updateTTSWordHighlight(state) {
  if (!getPrefs().tts.highlight || !state?.ttsCurrentSentence) return;
  const words = state.ttsCurrentSentence.wordRanges || state.ttsCurrentSentence.words;
  if (!words?.length) return;
  const weights = words.map(word => word.weight || 1);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const target = (state.engine?.getSentenceProgress?.() || 0) * total;
  let sum = 0;
  let index = words.length - 1;
  for (let i = 0; i < words.length; i++) {
    sum += weights[i];
    if (target < sum) { index = i; break; }
  }
  if (index === state.ttsCurrentWordIndex) return;
  state.ttsCurrentWordIndex = index;
  if (state.mode === 'pdf') {
    state.pdfView?.showWordHighlight(state.ttsCurrentSentence, index);
    return;
  }
  const range = words[index]?.range;
  if (range && window.CSS?.highlights && window.Highlight) {
    try {
      const highlight = new Highlight(range);
      CSS.highlights.set('lumen-tts-word', highlight);
      state.ttsWordHighlight = highlight;
    } catch {}
  }
}

function onTTSEnd(state) {
  updateTTSState(state, 'idle');
  // There is a short asynchronous gap while extracting the next page or
  // chapter. Keep iOS's media session active throughout that hand-off.
  if (state.engine?._wantPlaying && 'mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = 'playing'; } catch {}
  }
  state.engine?._requestWakeLock?.();
  if (state.mode === 'pdf') {
    if (state.page < state.numPages) advancePdfTTS(state);
    else {
      state.engine?.stop();
      if ('mediaSession' in navigator) {
        try { navigator.mediaSession.playbackState = 'none'; } catch {}
      }
      toast('You’ve reached the end of the book.', 'ok');
    }
    return;
  }
  if (state.chapterIndex < state.book.chapters.length - 1) {
    advanceReflowTTS(state).catch(err => {
      console.error('Could not continue narration', err);
      toast('Narration could not continue to the next chapter.', 'err');
    });
  } else if (state.chapterIndex >= state.book.chapters.length - 1) {
    state.engine?.stop();
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'none'; } catch {}
    }
    toast('You’ve reached the end of the book.', 'ok');
  }
}

async function advanceReflowTTS(state) {
  for (let i = state.chapterIndex + 1; i < state.book.chapters.length; i++) {
    if (!chapterHasBody(state.book.chapters[i])) continue;
    renderChapter(state, i, { ratio: 0, keepDock: true });
    const started = await startTTS(state, { autoplay: true });
    if (started) return;
  }
  state.engine?.stop();
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = 'none'; } catch {}
  }
  toast('You’ve reached the end of the book.', 'ok');
}

async function advancePdfTTS(state) {
  if (state.ttsAdvancing) return;
  state.ttsAdvancing = true;
  try {
    let p = (state.page || 1) + 1;
    let sentences = [];
    while (p <= state.numPages) {
      sentences = await state.pdfView.getPageSentences(p);
      if (sentences.length) break;
      p++;
    }
    if (!sentences.length) {
      state.engine?.stop();
      if ('mediaSession' in navigator) {
        try { navigator.mediaSession.playbackState = 'none'; } catch {}
      }
      toast('You’ve reached the end of the book.', 'ok');
      return;
    }
    state.pdfView.scrollToPage(p, { smooth: false });
    state.ttsPage = p;
    openDock(state);
    state.engine.load(sentences.map(s => ({ ...s, page: p })), { autoplay: true, start: 0 });
    updateMediaSession(state);
  } catch (err) {
    console.error('Could not continue PDF narration', err);
    toast('Narration could not continue to the next page.', 'err');
  } finally {
    setTimeout(() => { state.ttsAdvancing = false; }, 300);
  }
}

function handleDockAction(state, action) {
  if (action === 'toggle') {
    state.engine?._primeAudio?.();
    const st = state.engine.state;
    if (st === 'playing' || st === 'loading') {
      state.resumePending = false;
      state.engine.pause();
    } else state.engine.play();
    return;
  }
  if (action === 'prev') { state.engine.prev(); return; }
  if (action === 'next') { state.engine.next(); return; }
  if (action === 'speed') {
    refs.ttsSpeedPanel.hidden = !refs.ttsSpeedPanel.hidden;
    refs.ttsSpeedBtn.setAttribute('aria-expanded', String(!refs.ttsSpeedPanel.hidden));
    refs.ttsSpeedRange.value = String(getPrefs().tts.rate);
    updateSpeedLabel();
    return;
  }
  if (action === 'settings') {
    openVoiceModal({
      onSaved: () => {
        refs.ttsBtn.hidden = !getPrefs().tts.enabled || state.mode === 'comic';
        if (!getPrefs().tts.enabled) closeTTS(state);
        updateVoiceLabel(state);
        updateSpeedLabel();
        state.engine.applyVoiceChange();
      },
    });
    return;
  }
  if (action === 'close') closeTTS(state);
}

function updateVoiceLabel(state) {
  if (!refs) return;
  const override = state?.engine?.voice;
  refs.ttsVoiceLabel.textContent = override?.name ? `Piper · ${override.name}` : describeVoice();
  updateReaderVoiceChip(state);
}

function updateReaderVoiceChip(state) {
  if (!refs?.readerVoiceChip) return;
  const tts = getPrefs().tts;
  let label;
  if (!tts.enabled) {
    label = 'Silent reading';
  } else {
    const override = state?.engine?.voice;
    if (override?.name) {
      label = `Piper · ${override.name}`;
    } else {
      const v = piperVoiceById(tts.piperVoice);
      const sp = piperSpeakerName(v, tts.piperSpeaker);
      label = `Piper · ${v.name}${sp ? ` · ${sp}` : ''}`;
    }
  }
  refs.readerVoiceChip.innerHTML = `${icon('volume')}<span>${esc(label)}</span>`;
  refs.readerVoiceChip.title = `Voice: ${label} · Click to change`;
}

function updateSpeedLabel() {
  if (!refs) return;
  const label = formatSpeed(getPrefs().tts.rate);
  refs.ttsSpeedBtn.textContent = label;
  refs.ttsSpeedRange.value = String(getPrefs().tts.rate);
  refs.ttsSpeedValue.textContent = label;
}

function formatSpeed(n) {
  return `${clamp(Number(n) || 1, 0.5, 2).toFixed(2)}×`;
}

function formatAudioTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60);
  if (hours) return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return `${minutes}:${String(value % 60).padStart(2, '0')}`;
}

function readerTimelineProgress(state) {
  const timeline = state?.mode === 'pdf' ? state.pdfTimeline : state.bookTimeline;
  const index = state?.timelineEntryIndex;
  const entry = timeline?.entries?.[index];
  if (!timeline || !entry || !timeline.totalWeight) return null;
  const rate = clamp(Number(getPrefs().tts.rate) || 1, 0.5, 2);
  const secondsPerWeight = 60 / (160 * 5 * rate);
  const fraction = state.engine?.getSentenceProgress?.() || 0;
  const position = ((timeline.prefix[index] || 0) + entry.weight * fraction) * secondsPerWeight;
  return { position, duration: timeline.totalWeight * secondsPerWeight };
}

async function seekReaderTimeline(state, seconds) {
  state.engine?.cancelPrefetch?.();
  let timeline = state.mode === 'pdf' ? state.pdfTimeline : state.bookTimeline;
  if (!timeline && state.mode === 'pdf') timeline = await ensurePdfTimeline(state);
  if (!timeline?.entries?.length || !timeline.totalWeight) return false;
  const rate = clamp(Number(getPrefs().tts.rate) || 1, 0.5, 2);
  const totalSeconds = timeline.totalWeight * 60 / (160 * 5 * rate);
  let target = clamp(Number(seconds) || 0, 0, totalSeconds) * (160 * 5 * rate / 60);
  let lo = 0;
  let hi = timeline.entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeline.prefix[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const index = lo;
  const entry = timeline.entries[index];
  const fraction = clamp((target - timeline.prefix[index]) / Math.max(1, entry.weight), 0, 0.999);
  const engineState = state.engine?.state;
  const autoplay = engineState === 'playing' || engineState === 'loading';
  const paused = engineState === 'paused';

  if (state.mode === 'pdf') {
    if ((state.ttsPage || state.page) === entry.page) {
      state.timelineEntryIndex = index;
      return state.engine.seekToSentence(entry.sentenceIndex, fraction);
    }
    return startPdfTTS(state, { page: entry.page, start: entry.sentenceIndex, startFraction: fraction, autoplay, paused });
  }

  if (state.chapterIndex !== entry.chapterIndex) {
    renderChapter(state, entry.chapterIndex, { ratio: 0, keepDock: true });
    return startTTS(state, { start: entry.sentenceIndex, startFraction: fraction, autoplay, paused });
  }
  state.timelineEntryIndex = index;
  return state.engine.seekToSentence(entry.sentenceIndex, fraction);
}

function updateTTSTimeline(state) {
  if (!refs?.ttsSeek) return;
  if (state?.ttsSeeking) return;
  if (state?.engine?.state === 'playing' && Date.now() - (state.lastSessionSave || 0) > 2000) {
    state.lastSessionSave = Date.now();
    rememberReadingSession(state);
  }
  if (state?.mode === 'reflow' && state.book && !state.bookTimeline) buildReflowTimeline(state);
  const progress = readerTimelineProgress(state);
  if (!progress || !Number.isFinite(progress.duration) || progress.duration <= 0) {
    refs.ttsSeek.disabled = true;
    refs.ttsSeek.value = '0';
    refs.ttsElapsed.textContent = '0:00';
    refs.ttsDuration.textContent = state?.mode === 'pdf' && state.pdfTimelinePromise ? '…' : '0:00';
    updateTTSWordHighlight(state);
    return;
  }
  refs.ttsSeek.disabled = false;
  refs.ttsSeek.value = String(Math.round(1000 * progress.position / progress.duration));
  refs.ttsElapsed.textContent = formatAudioTime(progress.position);
  refs.ttsDuration.textContent = formatAudioTime(progress.duration);
  updateTTSWordHighlight(state);
}

function updateMediaSession(state) {
  if (!('mediaSession' in navigator)) return;
  try {
    const chapter = state.mode === 'pdf' ? `Page ${state.page}` : (state.chapter?.label || state.record.title);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter || state.record.title || 'Alya’s Reader',
      artist: state.record.author || 'Unknown author',
      album: state.record.title || 'Alya’s Reader',
    });
    navigator.mediaSession.setActionHandler('play', () => state.engine.play());
    navigator.mediaSession.setActionHandler('pause', () => {
      state.resumePending = false;
      state.engine.pause();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => state.engine.prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => state.engine.next());
    navigator.mediaSession.setActionHandler('stop', () => state.engine.pause());
  } catch {}
}

function clearMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
    ['play', 'pause', 'previoustrack', 'nexttrack', 'stop'].forEach(a => navigator.mediaSession.setActionHandler(a, null));
  } catch {}
}

/* ═══════════════════════════════════════════════════════════════════
   PDF
   ═══════════════════════════════════════════════════════════════════ */

async function openComicBook(state) {
  const comic = await buildComicBook(state.record, state.blob);
  if (state.destroyed) { comic.dispose?.(); return; }
  state.comic = comic;
  state.numPages = comic.pageCount;

  const meta = { ...(state.record.meta || {}), pageCount: comic.pageCount, comic: true };
  state.record.meta = meta;
  const libBook = state.app.books.find(b => b.id === state.bookId);
  if (libBook) libBook.meta = meta;
  db.updateBook(state.bookId, { meta }).catch(() => {});

  const view = new ComicView(refs.stage, comic, {
    onPageChange: page => handleComicPage(state, page),
  });
  state.comicView = view;

  refs.ttsBtn.hidden = true;
  closeTTS(state);

  const progress = state.progressRec;
  const startPage = clamp(state.target.page || progress?.page || 1, 1, comic.pageCount);
  state.page = startPage;
  await view.init(startPage);
  if (state.destroyed) return;
  updatePageProgress(state);
  updateBookmarkButton(state);
}

function handleComicPage(state, page) {
  state.page = page;
  updatePageProgress(state);
  updateBookmarkButton(state);
  state.queueSave?.();
  if (refs.tocDrawer.classList.contains('is-open')) updateTocActive(state);
}

async function openPdfBook(state) {
  const data = new Uint8Array(await state.blob.arrayBuffer());
  const task = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
  });
  state.pdfTask = task;
  task.onPassword = async (updatePassword, reason) => {
    const retry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    const pw = await askPdfPassword(state, retry);
    if (pw == null) {
      try { task.destroy(); } catch {}
      return;
    }
    updatePassword(pw);
  };

  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    if (state.destroyed) return;
    throw new Error(/password/i.test(err?.message || '') ? 'This PDF needs a password to open.' : 'This PDF could not be opened.');
  }
  if (state.destroyed) { try { pdf.destroy(); } catch {} return; }

  const view = new PdfView(pdf, refs.stage, {
    onPageChange: p => handlePdfPage(state, p),
    onZoom: () => {},
  });
  state.pdfView = view;
  state.numPages = pdf.numPages;
  await view.init();
  if (state.destroyed) return;

  const meta = { ...(state.record.meta || {}), numPages: pdf.numPages };
  state.record.meta = meta;
  const libBook = state.app.books.find(b => b.id === state.bookId);
  if (libBook) libBook.meta = meta;
  db.updateBook(state.bookId, { meta }).catch(() => {});

  const progress = state.progressRec;
  const startPage = clamp(state.target.page || progress?.page || 1, 1, pdf.numPages);
  state.page = startPage;
  view.scrollToPage(startPage);
  updatePageProgress(state);
  updateBookmarkButton(state);

  state.pdfOutline = null;
  view.getOutline().then(list => {
    state.pdfOutline = list;
    if (refs.tocDrawer.classList.contains('is-open')) renderToc(state);
  }).catch(() => { state.pdfOutline = []; });

  if (state.target.autoplay) setTimeout(() => { if (S === state) startTTS(state, { autoplay: true }); }, 500);
}

function askPdfPassword(state, retry = false) {
  return new Promise(resolve => {
    let settled = false;
    const done = val => { if (!settled) { settled = true; resolve(val); } };
    const body = document.createElement('div');
    body.innerHTML = `<div class="form-stack">
      <div class="callout">${icon('shield')}<span>This PDF is encrypted. The password is used only to unlock it in this browser.</span></div>
      <div class="field">
        <label for="pdfPassword">Password</label>
        <input class="input" id="pdfPassword" type="password" autocomplete="off" autofocus placeholder="Enter the PDF password">
      </div>
      ${retry ? '<p class="hint" style="color:#b23c2e">That password didn’t work. Try again.</p>' : ''}
    </div>`;
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:9px;width:100%;justify-content:flex-end';
    foot.innerHTML = '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-unlock>Unlock</button>';
    const m = modal({
      eyebrow: 'Locked PDF',
      title: 'This book is password-protected',
      body,
      foot,
      onClose: () => done(null),
    });
    const input = body.querySelector('#pdfPassword');
    const unlock = () => {
      const val = input.value;
      if (!val) { input.focus(); return; }
      done(val);
      m.close('unlock');
    };
    foot.querySelector('[data-cancel]').onclick = () => { done(null); m.close('cancel'); };
    foot.querySelector('[data-unlock]').onclick = unlock;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); unlock(); } });
    setTimeout(() => input.focus(), 60);
  });
}

function handlePdfPage(state, page) {
  state.page = page;
  updatePageProgress(state);
  updateBookmarkButton(state);
  state.queueSave?.();
  if (refs.tocDrawer.classList.contains('is-open')) updateTocActive(state);
  if (state.engine && state.ttsPage && page !== state.ttsPage && !state.ttsAdvancing && ['playing', 'loading', 'paused'].includes(state.engine.state)) {
    closeTTS(state);
  }
}

function updatePageProgress(state) {
  if (!state.numPages) return;
  const pct = clamp((state.page / state.numPages) * 100, 0, 100);
  state.percent = pct;
  state.ratio = state.numPages > 1 ? (state.page - 1) / (state.numPages - 1) : 0;
  refs.progressFill.style.width = `${pct}%`;
  refs.footLeft.textContent = `Page ${state.page} of ${state.numPages}`;
  refs.footRight.textContent = `${Math.round(pct)}%`;
  refs.readerChapterTitle.textContent = `Page ${state.page}`;
  rememberReadingSession(state);
  updateFootNav(state);
  updateTocActive(state);
}

/* ═══════════════════════════════════════════════════════════════════
   Contents drawer
   ═══════════════════════════════════════════════════════════════════ */

function toggleToc(state) {
  if (refs.tocDrawer.classList.contains('is-open')) closeToc(state);
  else openToc(state);
}

function openToc(state) {
  closeTypePanel(state);
  hideSelection(state);
  refs.tocDrawer.classList.add('is-open');
  refs.tocDrawer.setAttribute('aria-hidden', 'false');
  refs.tocScrim.classList.add('is-open');
  renderToc(state);
}

function closeToc(state) {
  refs.tocDrawer.classList.remove('is-open');
  refs.tocDrawer.setAttribute('aria-hidden', 'true');
  refs.tocScrim.classList.remove('is-open');
}

function renderToc(state) {
  if (state.mode === 'comic') {
    refs.tocTitle.textContent = 'Pages';
    const jump = `<form class="pdf-jump" autocomplete="off">
      <label for="pageJump">Go to page</label>
      <div><input class="input" id="pageJump" type="number" min="1" max="${state.numPages || 1}" value="${state.page || 1}">
      <button class="btn btn-sm btn-primary" type="submit">Go</button></div>
    </form>`;
    const cells = Array.from({ length: state.numPages || 0 }, (_, i) => `
      <button class="comic-page-num${state.page === i + 1 ? ' is-active' : ''}" data-comic-page="${i + 1}">${i + 1}</button>`).join('');
    refs.tocList.innerHTML = `${jump}<div class="comic-toc-grid">${cells}</div>`;
    setTimeout(() => {
      refs.tocList.querySelector('.comic-page-num.is-active')?.scrollIntoView({ block: 'center' });
    }, 60);
    return;
  }

  if (state.mode === 'pdf') {
    refs.tocTitle.textContent = 'Pages & contents';
    const outline = state.pdfOutline;
    const jump = `<form class="pdf-jump" autocomplete="off">
      <label for="pageJump">Go to page</label>
      <div><input class="input" id="pageJump" type="number" min="1" max="${state.numPages || 1}" value="${state.page || 1}">
      <button class="btn btn-sm btn-primary" type="submit">Go</button></div>
    </form>`;
    if (!outline) {
      refs.tocList.innerHTML = `${jump}<div class="toc-empty"><span class="busy-dot"></span> Reading the outline…</div>`;
      return;
    }
    refs.tocList.innerHTML = `${jump}${outline.length ? outline.map((item, i) => `
      <button class="toc-item depth-${Math.min(item.depth, 2)}${item.page === state.page ? ' is-active' : ''}" data-toc-page="${item.page}">
        <span class="toc-num">${item.depth === 0 ? String(i + 1).padStart(2, '0') : ''}</span>
        <span>${esc(item.label)}</span><span class="toc-page">${item.page}</span>
      </button>`).join('') : '<div class="toc-empty">This PDF doesn’t include a chapter outline. Use the page box above to move around.</div>'}`;
    return;
  }

  refs.tocTitle.textContent = 'Contents';
  if (!state.book?.chapters?.length) {
    refs.tocList.innerHTML = '<div class="toc-empty">This book doesn’t include a table of contents.</div>';
    return;
  }
  const jump = `<form class="pdf-jump chapter-jump" autocomplete="off">
    <label for="chapterJump">Jump to chapter</label>
    <div>
      <select class="select" id="chapterJump" style="flex:1">
        ${state.book.chapters.map((c, i) => `<option value="${i}"${i === state.chapterIndex ? ' selected' : ''}>${esc(c.label || `Chapter ${i + 1}`)}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-primary" type="submit">Go</button>
    </div>
  </form>`;
  refs.tocList.innerHTML = jump + state.toc.map(item => `
    <button class="toc-item depth-${Math.min(item.depth || 0, 2)}${item.chapterIndex === state.chapterIndex ? ' is-active' : ''}"
      data-toc-chapter="${item.chapterIndex}"${item.anchor ? ` data-toc-anchor="${esc(item.anchor)}"` : ''}>
      <span class="toc-num">${(item.depth || 0) === 0 ? String(item.chapterIndex + 1).padStart(2, '0') : ''}</span>
      <span>${esc(item.label || `Chapter ${item.chapterIndex + 1}`)}</span>
    </button>`).join('');
}

function updateTocActive(state) {
  if (!refs?.tocList) return;
  if (state.mode === 'comic') {
    refs.tocList.querySelectorAll('[data-comic-page]').forEach(btn => {
      btn.classList.toggle('is-active', Number(btn.dataset.comicPage) === state.page);
    });
    return;
  }
  if (state.mode === 'pdf') {
    refs.tocList.querySelectorAll('[data-toc-page]').forEach(btn => {
      btn.classList.toggle('is-active', Number(btn.dataset.tocPage) === state.page);
    });
    return;
  }
  refs.tocList.querySelectorAll('[data-toc-chapter]').forEach(btn => {
    btn.classList.toggle('is-active', Number(btn.dataset.tocChapter) === state.chapterIndex);
  });
}

function handleTocClick(state, e) {
  const comicBtn = e.target.closest('[data-comic-page]');
  if (comicBtn) {
    state.comicView?.showPage(Number(comicBtn.dataset.comicPage));
    closeToc(state);
    return;
  }
  const pageBtn = e.target.closest('[data-toc-page]');
  if (pageBtn) {
    state.pdfView?.scrollToPage(Number(pageBtn.dataset.tocPage), { smooth: true });
    closeToc(state);
    return;
  }
  const chBtn = e.target.closest('[data-toc-chapter]');
  if (chBtn) {
    const index = Number(chBtn.dataset.tocChapter);
    const anchor = chBtn.dataset.tocAnchor || '';
    closeToc(state);
    if (index === state.chapterIndex && anchor) scrollToAnchor(state, anchor);
    else gotoChapter(state, index, { anchor });
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Appearance panel
   ═══════════════════════════════════════════════════════════════════ */

function toggleTypePanel(state) {
  if (!refs.typePanel.hidden) { closeTypePanel(state); return; }
  closeToc(state);
  hideSelection(state);
  buildTypePanel(state);
  refs.typePanel.hidden = false;
}

function closeTypePanel() {
  if (refs) refs.typePanel.hidden = true;
}

function buildTypePanel(state) {
  const prefs = getPrefs();
  const r = prefs.reader;
  if (state.mode === 'pdf') {
    refs.typePanelBody.innerHTML = `
      <div class="tp-section">
        <div class="tp-label">Theme</div>
        <div class="tp-themes">${THEMES.map(t => `<button class="tp-theme${prefs.theme === t.id ? ' is-active' : ''}" data-tp-theme="${t.id}"><span class="sw ${t.sw}"></span>${t.name}</button>`).join('')}</div>
      </div>
      <div class="tp-section">
        <div class="tp-label">PDF pages</div>
        <p class="hint" style="line-height:1.6">PDFs keep their original layout. Use the zoom controls at the bottom right to make pages larger or smaller.</p>
      </div>
      <div class="tp-section">
        <div class="tp-inline"><span>Narration</span><span class="dim">${getPrefs().tts.enabled ? 'On' : 'Silent'}</span></div>
        <button class="btn btn-sm btn-block" style="margin-top:10px" data-tp-voice>${icon('headphones')} Voice settings</button>
      </div>`;
    return;
  }

  if (state.mode === 'comic') {
    refs.typePanelBody.innerHTML = `
      <div class="tp-section">
        <div class="tp-label">Theme</div>
        <div class="tp-themes">${THEMES.map(t => `<button class="tp-theme${prefs.theme === t.id ? ' is-active' : ''}" data-tp-theme="${t.id}"><span class="sw ${t.sw}"></span>${t.name}</button>`).join('')}</div>
      </div>
      <div class="tp-section">
        <div class="tp-label">Comic</div>
        <div class="tp-inline"><span>Pages</span><span class="dim">${state.numPages || 0}</span></div>
        <button class="btn btn-sm btn-block" style="margin-top:10px" data-tp-pages>${icon('list')} Page grid</button>
        <p class="hint" style="margin-top:10px;line-height:1.6">Pages fit the screen. Use the +/− controls or double-click to zoom, then drag or scroll the page. Swipe or use ← → to turn pages.</p>
      </div>
      <div class="tp-section">
        <div class="tp-label">Narration</div>
        <p class="hint" style="line-height:1.6">Comic pages are images, so there’s no text to read aloud. Bookmarks and progress work page by page.</p>
      </div>`;
    return;
  }

  refs.typePanelBody.innerHTML = `
    <div class="tp-section">
      <div class="tp-label">Theme</div>
      <div class="tp-themes">
        ${THEMES.map(t => `<button class="tp-theme${prefs.theme === t.id ? ' is-active' : ''}" data-tp-theme="${t.id}"><span class="sw ${t.sw}"></span>${t.name}</button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">Typeface</div>
      <select class="select" data-tp-font-select aria-label="Typeface" style="width:100%">
        ${FONTS.map(f => `<option value="${f.id}"${r.font === f.id ? ' selected' : ''}>${esc(f.name)} — ${esc(f.note)}</option>`).join('')}
      </select>
    </div>
    <div class="tp-section">
      <div class="tp-label">Text size <output id="tpSizeOut">${r.size}px</output></div>
      <div class="tp-slider-row">
        <button class="tp-step" data-tp-size-step="-1" aria-label="Decrease text size">−</button>
        <input class="range" data-rs="size" type="range" min="14" max="28" step="1" value="${r.size}" aria-label="Text size">
        <button class="tp-step" data-tp-size-step="1" aria-label="Increase text size">+</button>
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">Line height <output id="tpLhOut">${r.lineHeight.toFixed(2)}</output></div>
      <input class="range" data-rs="lineHeight" type="range" min="1.3" max="2.1" step="0.02" value="${r.lineHeight}" aria-label="Line height">
    </div>
    <div class="tp-section">
      <div class="tp-label">Width <output id="tpMeasureOut">${r.measure}px</output></div>
      <input class="range" data-rs="measure" type="range" min="480" max="900" step="20" value="${r.measure}" aria-label="Text width">
    </div>
    <div class="tp-section">
      <div class="tp-label">Paragraphs <output id="tpParaOut">${r.para.toFixed(2)}em</output></div>
      <input class="range" data-rs="para" type="range" min="0.4" max="1.6" step="0.05" value="${r.para}" aria-label="Paragraph spacing">
    </div>
    <div class="tp-section">
      <div class="tp-label">Letter spacing <output id="tpLetterOut">${(r.letterSpacing || 0).toFixed(3)}em</output></div>
      <input class="range" data-rs="letterSpacing" type="range" min="0" max="0.12" step="0.005" value="${r.letterSpacing || 0}" aria-label="Letter spacing">
    </div>
    <div class="tp-section">
      <div class="tp-label">Word spacing <output id="tpWordOut">${(r.wordSpacing || 0).toFixed(2)}em</output></div>
      <input class="range" data-rs="wordSpacing" type="range" min="0" max="0.5" step="0.01" value="${r.wordSpacing || 0}" aria-label="Word spacing">
      <button class="btn btn-sm btn-block" style="margin-top:10px" data-tp-dyslexia>${icon('type')} Dyslexia-friendly setup</button>
    </div>
    <div class="tp-section">
      <label class="tp-inline"><span>Justify text</span><span class="switch"><input type="checkbox" data-rt="justify" ${r.justify ? 'checked' : ''}><span class="track"></span></span></label>
      <label class="tp-inline" style="margin-top:9px"><span>Hyphenation</span><span class="switch"><input type="checkbox" data-rt="hyphens" ${r.hyphens ? 'checked' : ''}><span class="track"></span></span></label>
      <label class="tp-inline" style="margin-top:9px"><span>Continuous chapters</span><span class="switch"><input type="checkbox" data-rt="continuous" ${r.continuous ? 'checked' : ''}><span class="track"></span></span></label>
    </div>
    <div class="tp-section">
      <div class="tp-inline"><span>Narration</span><span class="dim">${prefs.tts.enabled ? 'On' : 'Silent'}</span></div>
      <button class="btn btn-sm btn-block" style="margin-top:10px" data-tp-voice>${icon('headphones')} Voice settings</button>
    </div>
    <button class="btn btn-sm tp-reset" data-tp-reset>${icon('refresh')} Reset appearance</button>`;
}

function handleTypeClick(state, e) {
  const theme = e.target.closest('[data-tp-theme]');
  if (theme) {
    savePrefs({ theme: theme.dataset.tpTheme });
    buildTypePanel(state);
    return;
  }
  const step = e.target.closest('[data-tp-size-step]');
  if (step) {
    const size = clamp(getPrefs().reader.size + Number(step.dataset.tpSizeStep), 14, 28);
    setReaderPrefs({ size });
    buildTypePanel(state);
    return;
  }
  if (e.target.closest('[data-tp-dyslexia]')) {
    setReaderPrefs(DYSLEXIA_READER);
    buildTypePanel(state);
    toast('Dyslexia-friendly reading on', 'ok');
    return;
  }
  if (e.target.closest('[data-tp-reset]')) {
    setReaderPrefs({ ...DEFAULT_READER });
    buildTypePanel(state);
    return;
  }
  if (e.target.closest('[data-tp-pages]')) {
    closeTypePanel(state);
    openToc(state);
    return;
  }
  if (e.target.closest('[data-tp-voice]')) {
    closeTypePanel(state);
    openVoiceModal({
      onSaved: () => {
        refs.ttsBtn.hidden = !getPrefs().tts.enabled || state.mode === 'comic';
        if (!getPrefs().tts.enabled) closeTTS(state);
        updateVoiceLabel(state);
        updateSpeedLabel();
        state.engine.applyVoiceChange();
        applyBookVoice(state);
      },
    });
  }
}

function handleTypeInput(state, e) {
  const key = e.target.dataset.rs;
  if (!key) return;
  const value = Number(e.target.value);
  setReaderPrefs({ [key]: value });
  const out = {
    size: ['tpSizeOut', `${value}px`],
    lineHeight: ['tpLhOut', value.toFixed(2)],
    measure: ['tpMeasureOut', `${value}px`],
    para: ['tpParaOut', `${value.toFixed(2)}em`],
    letterSpacing: ['tpLetterOut', `${value.toFixed(3)}em`],
    wordSpacing: ['tpWordOut', `${value.toFixed(2)}em`],
  }[key];
  if (out) {
    const el = $(`#${out[0]}`);
    if (el) el.textContent = out[1];
  }
}

function handleTypeChange(state, e) {
  if (e.target.matches('[data-rt="continuous"]')) {
    setReaderPrefs({ continuous: e.target.checked });
    toast(e.target.checked ? 'Continuous layout on — reopen the book to apply.' : 'Continuous layout off — reopen the book to apply.', 'info');
    return;
  }
  if (e.target.matches('[data-tp-font-select]')) {
    setReaderPrefs({ font: e.target.value });
    buildTypePanel(state);
    return;
  }
  const key = e.target.dataset.rt;
  if (key) setReaderPrefs({ [key]: e.target.checked });
}

/* ═══════════════════════════════════════════════════════════════════
   Menus / actions
   ═══════════════════════════════════════════════════════════════════ */

function chapterSearchText(chapter) {
  if (!chapter?.html) return '';
  const holder = document.createElement('div');
  holder.innerHTML = chapter.html;
  holder.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,blockquote').forEach(el => el.append(document.createTextNode(' ')));
  return normalizedText(holder.textContent || '');
}

function snippetHtml(text, at, length) {
  const start = Math.max(0, at - 48);
  const end = Math.min(text.length, at + length + 56);
  const before = text.slice(start, at).replace(/\s+/g, ' ');
  const match = text.slice(at, at + length);
  const after = text.slice(at + length, end).replace(/\s+/g, ' ');
  return `${start > 0 ? '…' : ''}${esc(before)}<mark>${esc(match)}</mark>${esc(after)}${end < text.length ? '…' : ''}`;
}

function searchBookText(state, query) {
  if (!state.searchTexts) {
    state.searchTexts = state.book.chapters.map(chapterSearchText);
  }
  const needle = query.toLowerCase();
  const results = [];
  for (let ci = 0; ci < state.searchTexts.length; ci++) {
    const text = state.searchTexts[ci];
    const lower = text.toLowerCase();
    let from = 0;
    let occurrence = 0;
    while (occurrence < 5) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      results.push({
        chapterIndex: ci,
        chapterLabel: state.book.chapters[ci].label || `Chapter ${ci + 1}`,
        snippet: snippetHtml(text, at, needle.length),
        occurrence,
      });
      occurrence++;
      from = at + needle.length;
      if (results.length >= 80) return results;
    }
  }
  return results;
}

function scrollToSearchHit(state, query, occurrence) {
  const article = state.article;
  if (!article) return;
  const map = buildTextMap(article);
  const lower = map.text.toLowerCase();
  const needle = query.toLowerCase();
  let at = -1;
  for (let i = 0; i <= occurrence; i++) {
    at = lower.indexOf(needle, at + 1);
    if (at < 0) break;
  }
  if (at < 0) return;
  const range = rangeFromOffsets(map, at, at + needle.length);
  if (!range) return;
  scrollRangeIntoView(range);
  if (window.CSS?.highlights && window.Highlight) {
    try {
      CSS.highlights.set('lumen-search', new Highlight(range));
      setTimeout(() => { CSS.highlights.delete('lumen-search'); }, 2600);
    } catch {}
  }
}

function jumpToSearchHit(state, chapterIndex, query, occurrence) {
  if (chapterIndex !== state.chapterIndex) renderChapter(state, chapterIndex, { ratio: 0, keepDock: true });
  setTimeout(() => scrollToSearchHit(state, query, occurrence), 90);
}

async function searchPdfBook(state, query, token, meta) {
  const needle = query.toLowerCase();
  const results = [];
  const total = state.numPages || 1;
  for (let page = 1; page <= total; page++) {
    if (token.cancelled) return null;
    let sentences = [];
    try { sentences = await state.pdfView.getPageSentences(page); } catch {}
    if (sentences.length) {
      const text = sentences.map(s => s.text).join(' ');
      const lower = text.toLowerCase();
      let from = 0;
      let occurrence = 0;
      while (occurrence < 4) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        const sentence = sentences.find(s => s.text.toLowerCase().includes(needle)) || sentences[0];
        results.push({
          page,
          sentence,
          snippet: snippetHtml(text, at, needle.length),
        });
        occurrence++;
        from = at + needle.length;
        if (results.length >= 80) break;
      }
    }
    if (meta) meta.textContent = `Searching page ${page} of ${total}…`;
    if (results.length >= 80) break;
    if (page % 3 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return results;
}

function openBookSearch(state) {
  const body = document.createElement('div');
  body.innerHTML = `
    <form class="book-search-form" autocomplete="off">
      <input class="input" id="bookSearchInput" placeholder="Search this ${state.mode === 'pdf' ? 'PDF' : 'book'}" spellcheck="false" aria-label="Search in book">
      <button class="btn btn-sm btn-primary" type="submit">Find</button>
    </form>
    <div class="book-search-meta" id="bookSearchMeta">Type at least two letters.</div>
    <div class="book-search-results" id="bookSearchResults"></div>`;
  const m = modal({ eyebrow: 'Search', title: 'Search in book', body, wide: true, onClose: () => { token.cancelled = true; } });
  const input = body.querySelector('#bookSearchInput');
  const meta = body.querySelector('#bookSearchMeta');
  const list = body.querySelector('#bookSearchResults');
  let found = [];
  let token = { cancelled: false };

  const render = async () => {
    token.cancelled = true;
    const current = { cancelled: false };
    token = current;
    const query = input.value.trim();
    if (query.length < 2) {
      found = [];
      meta.textContent = 'Type at least two letters.';
      list.innerHTML = '';
      return;
    }

    if (state.mode === 'pdf') {
      found = [];
      list.innerHTML = '';
      meta.textContent = `Searching page 1 of ${state.numPages || 1}…`;
      const results = await searchPdfBook(state, query, current, meta);
      if (current.cancelled) return;
      found = results || [];
      meta.textContent = found.length
        ? `${found.length}${found.length >= 80 ? '+' : ''} match${found.length === 1 ? '' : 'es'}`
        : `No matches for “${query}”. This PDF may not contain selectable text.`;
      list.innerHTML = found.map((r, i) => `
        <button class="search-result" data-search-result="${i}">
          <span class="sr-chapter">Page ${r.page}</span>
          <span class="sr-snippet">${r.snippet}</span>
        </button>`).join('');
      return;
    }

    found = searchBookText(state, query);
    meta.textContent = found.length
      ? `${found.length}${found.length >= 80 ? '+' : ''} match${found.length === 1 ? '' : 'es'}`
      : `No matches for “${query}”.`;
    list.innerHTML = found.map(r => `
      <button class="search-result" data-search-chapter="${r.chapterIndex}" data-search-occurrence="${r.occurrence}">
        <span class="sr-chapter">${esc(r.chapterLabel)}</span>
        <span class="sr-snippet">${r.snippet}</span>
      </button>`).join('');
  };

  const run = debounce(render, 220);
  input.addEventListener('input', run);
  body.querySelector('.book-search-form').addEventListener('submit', event => {
    event.preventDefault();
    render();
  });
  list.addEventListener('click', event => {
    const resultBtn = event.target.closest('[data-search-result]');
    if (resultBtn) {
      const result = found[Number(resultBtn.dataset.searchResult)];
      if (!result) return;
      m.close();
      state.pdfView?.scrollToPage(result.page, { smooth: true });
      state.page = result.page;
      setTimeout(() => state.pdfView?.showHighlight(result.sentence), 500);
      return;
    }
    const btn = event.target.closest('[data-search-chapter]');
    if (!btn) return;
    const query = input.value.trim();
    m.close();
    jumpToSearchHit(state, Number(btn.dataset.searchChapter), query, Number(btn.dataset.searchOccurrence));
  });
  setTimeout(() => input.focus(), 60);
}

function openAudiobookDialog(state) {
  if (state.mode === 'comic') {
    toast('Comic pages are images, so there is no text to turn into an audiobook.', 'info');
    return;
  }
  const tts = getPrefs().tts;
  const allVoices = getPiperVoices();
  const whole = audiobookChapters(state, 'book');
  const single = audiobookChapters(state, 'chapter');
  if (!whole.length) { toast('No readable text was found for an audiobook.', 'err'); return; }
  let audioVoiceId = allVoices.some(v => v.id === tts.piperVoice) ? tts.piperVoice : (allVoices[0]?.id || 'en_US-libritts_r-medium');
  let audioSpeaker = Number(tts.piperSpeaker) || 0;

  const body = document.createElement('div');
  const chapterTitle = state.mode === 'pdf' ? `Page ${state.page || 1}` : (single[0]?.title || 'This chapter');
  const estimate = scope => {
    const words = scope === 'chapter'
      ? (state.mode === 'pdf' ? 250 : (state.chapter?.words || 0))
      : (state.mode === 'pdf' ? (state.numPages || 1) * 250 : (state.book?.words || 0));
    const minutes = Math.max(1, Math.round(words / 160));
    const count = scope === 'chapter' ? 1 : whole.length;
    return `About ${minutes} min of audio · ${count} chapter${count === 1 ? '' : 's'} · MP3`;
  };
  body.innerHTML = `
    <div class="audiobook-card">
      <div class="field">
        <label for="audioVoice">Voice</label>
        <select class="select" id="audioVoice">
          ${allVoices.map(v => `<option value="${esc(v.id)}"${v.id === audioVoiceId ? ' selected' : ''}>${esc(v.name)} · ${esc(v.language || 'Voice')}${v.country ? ` · ${esc(v.country)}` : ''}</option>`).join('')}
        </select>
        <p class="hint" id="audioVoiceNote"></p>
      </div>
      <div id="audioSpeakerWrap"></div>
      <div class="field" style="margin-top:12px">
        <label for="audioScope">Export</label>
        <select class="select" id="audioScope">
          <option value="book">Whole book · ${whole.length} chapter${whole.length === 1 ? '' : 's'}</option>
          <option value="chapter">${state.mode === 'pdf' ? 'This page' : 'This chapter'} · ${esc(chapterTitle)}</option>
        </select>
      </div>
      <div class="field" style="margin-top:12px">
        <label for="audioFile">File</label>
        <select class="select" id="audioFile">
          <option value="mp3">Single MP3 file</option>
          <option value="zip">MP3 chapters · zip with playlist</option>
        </select>
      </div>
      <div class="audiobook-estimate" id="audioEstimate">${estimate('book')}</div>
      <p class="hint">Piper runs on your device. A full book can take hours; you can cancel at any time. Choose one MP3 for the whole export, or a zip of MP3 chapters with a playlist.</p>
    </div>`;

  const voiceSelect = body.querySelector('#audioVoice');
  const speakerWrap = body.querySelector('#audioSpeakerWrap');

  const voiceNote = () => {
    const v = piperVoiceById(audioVoiceId);
    const note = body.querySelector('#audioVoiceNote');
    if (!note) return;
    note.textContent = v.custom
      ? `Imported voice · ${v.sizeMB} MB · stored on this device.`
      : `First use downloads about ${v.sizeMB} MB for ${v.name}; later exports use the browser cache.`;
  };

  const renderSpeakers = () => {
    const v = piperVoiceById(audioVoiceId);
    audioSpeaker = Math.max(0, Math.min(audioSpeaker, Math.max(0, (v.num_speakers || 1) - 1)));
    if (!v || v.num_speakers <= 1) { speakerWrap.innerHTML = ''; audioSpeaker = 0; return; }
    const entries = Object.entries(v.speaker_id_map || {}).sort((a, b) => Number(a[1]) - Number(b[1]));
    const options = entries.length ? entries : Array.from({ length: v.num_speakers }, (_, i) => [`Speaker ${i}`, i]);
    const many = options.length > 80;
    speakerWrap.innerHTML = `<div class="field" style="margin-top:12px">
      <label for="audioSpeaker">Speaker <span class="dim" style="font-weight:400">· ${options.length.toLocaleString()} available</span></label>
      ${many ? `<input class="input" id="audioSpeakerSearch" placeholder="Search ${options.length.toLocaleString()} speakers" autocomplete="off" spellcheck="false" style="margin-bottom:6px">` : ''}
      <select class="select" id="audioSpeaker"></select>
      <div class="hint" id="audioSpeakerCount"></div>
    </div>`;
    const select = speakerWrap.querySelector('#audioSpeaker');
    const search = speakerWrap.querySelector('#audioSpeakerSearch');
    const count = speakerWrap.querySelector('#audioSpeakerCount');
    const fill = (query = '') => {
      const q = query.trim().toLowerCase();
      const label = name => {
        const raw = String(name);
        return /^p?\d+$/i.test(raw) ? `Voice ${raw.replace(/^p/i, '')}` : raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      };
      let matches = q ? options.filter(([name, id]) => `${label(name)} ${id}`.toLowerCase().includes(q)) : options;
      const current = options.find(([, id]) => Number(id) === audioSpeaker);
      const limit = q ? 80 : (many ? 80 : options.length);
      let shown = matches.slice(0, limit);
      if (current && !shown.some(([, id]) => Number(id) === audioSpeaker)) shown = [current, ...shown];
      select.innerHTML = shown.map(([name, id]) => `<option value="${Number(id)}"${Number(id) === audioSpeaker ? ' selected' : ''}>${esc(label(name))}</option>`).join('');
      if (count) count.textContent = q ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : `Showing ${shown.length} of ${options.length.toLocaleString()} — search to narrow.`;
    };
    select.onchange = () => { audioSpeaker = Number(select.value); };
    search?.addEventListener('input', () => fill(search.value));
    fill('');
  };

  voiceSelect.addEventListener('change', () => {
    audioVoiceId = voiceSelect.value;
    audioSpeaker = 0;
    renderSpeakers();
    voiceNote();
  });
  renderSpeakers();
  voiceNote();

  const foot = document.createElement('div');
  foot.style.flexWrap = 'wrap';
  foot.innerHTML = `<button class="btn" data-cancel>Cancel</button><button class="btn" data-test-voice type="button">${icon('loudhailer')} Test voice</button><button class="btn btn-primary" data-start-audio>Create audiobook</button>`;
  const m = modal({ eyebrow: 'Audiobook', title: 'Make an audiobook', body, foot, wide: true, onClose: () => stopPreview() });

  const testBtn = foot.querySelector('[data-test-voice]');
  testBtn.addEventListener('click', async () => {
    const old = testBtn.innerHTML;
    let played = false;
    testBtn.disabled = true;
    testBtn.innerHTML = '<span class="busy-dot"></span> Preparing…';
    const stopProgress = onPiperProgress(p => {
      if (p.phase === 'downloading') testBtn.innerHTML = `<span class="busy-dot"></span> Downloading ${p.percent || 0}%…`;
      else if (p.phase === 'preparing') testBtn.innerHTML = '<span class="busy-dot"></span> Preparing…';
    });
    try {
      await previewSpeech({
        ...getPrefs().tts,
        enabled: true,
        provider: 'piper',
        piperVoice: audioVoiceId,
        piperSpeaker: audioSpeaker,
      }, 'This is how your audiobook will sound — warm, clear, and unhurried.');
      played = true;
      testBtn.innerHTML = '<span class="busy-dot"></span> Playing…';
      setTimeout(() => { if (!testBtn.disabled) testBtn.innerHTML = old; }, 2600);
    } catch (err) {
      toast(err.message || 'Could not play that voice sample.', 'err');
    } finally {
      stopProgress();
      testBtn.disabled = false;
      if (!played) testBtn.innerHTML = old;
    }
  });

  const scopeSelect = body.querySelector('#audioScope');
  const fileSelect = body.querySelector('#audioFile');
  scopeSelect.addEventListener('change', () => {
    body.querySelector('#audioEstimate').textContent = estimate(scopeSelect.value);
  });
  foot.querySelector('[data-cancel]').onclick = () => m.close('cancel');
  foot.querySelector('[data-start-audio]').onclick = () => {
    const scope = scopeSelect.value;
    const format = fileSelect.value;
    const voiceId = audioVoiceId;
    const speaker = audioSpeaker;
    m.close('start');
    window.lumen?.pauseTTS?.();
    const progress = modal({
      eyebrow: 'Audiobook',
      title: 'Creating audiobook',
      body: '<div class="backup-status"><div class="backup-pct" id="audioPct">0%</div><p id="audioStatus">Preparing the first chapter…</p><button class="btn btn-sm" data-cancel-audio style="margin-top:14px">Cancel</button></div>',
      dismissible: false,
    });
    const token = { cancelled: false };
    const pct = progress.bodyEl.querySelector('#audioPct');
    const status = progress.bodyEl.querySelector('#audioStatus');
    let generationStarted = false;
    const stopVoiceProgress = onPiperProgress(p => {
      if (!generationStarted && status && (p.phase === 'downloading' || p.phase === 'preparing')) {
        status.textContent = piperProgressLabel(p);
      }
    });
    progress.bodyEl.querySelector('[data-cancel-audio]').onclick = () => {
      token.cancelled = true;
      stopVoiceProgress();
      progress.close('cancel');
      toast('Audiobook creation cancelled', 'info');
    };
    createAudiobook(state, {
      scope,
      format,
      voiceId,
      speaker,
      token,
      onProgress: p => {
        if (token.cancelled) return;
        if (p.phase === 'generating' || p.phase === 'chapter' || p.phase === 'encoding' || p.phase === 'packing') generationStarted = true;
        if (pct) pct.textContent = `${p.percent || 0}%`;
        if (status) {
          status.textContent = p.phase === 'encoding'
            ? (format === 'mp3' ? 'Finishing the MP3 file…' : 'Finishing the audio file…')
            : p.phase === 'packing'
              ? 'Packing MP3 chapters into a zip…'
              : `Chapter ${p.chapter || 1} of ${p.chapters || 1}${p.sentences ? ` · sentence ${p.sentence} of ${p.sentences}` : ''}`;
        }
      },
    }).then(result => {
      stopVoiceProgress();
      progress.close('done');
      const isSingle = result.format !== 'zip';
      const kind = result.format === 'mp3' ? 'MP3' : result.format === 'wav' ? 'WAV' : 'Audiobook';
      const length = isSingle && result.duration ? ` · ${formatAudioTime(result.duration)}` : '';
      const done = modal({
        eyebrow: 'Audiobook',
        title: isSingle ? `${kind} audio ready` : 'Audiobook ready',
        body: isSingle
          ? `<p class="hint" style="margin-bottom:12px">${kind} file${length} · ${formatBytes(result.blob.size)} · ${esc(result.voice || '')}</p>
            <p class="hint">Save the file and open it in any audio or audiobook player.</p>`
          : `<p class="hint" style="margin-bottom:12px">${result.chapters} chapter${result.chapters === 1 ? '' : 's'} · ${formatBytes(result.blob.size)} · ${esc(result.voice || '')}</p>
            <p class="hint">Save the zip and unzip it into your audiobook player. The playlist keeps chapter order.</p>`,
        foot: `<button class="btn btn-primary" data-download-audiobook>${icon('download')} Download ${isSingle ? kind : 'audiobook'}</button>`,
      });
      done.footEl.querySelector('[data-download-audiobook]').onclick = () => {
        downloadBlob(result.blob, result.filename);
        done.close('download');
        toast(`${isSingle ? kind : 'Audiobook'} downloaded`, 'ok');
      };
    }).catch(err => {
      stopVoiceProgress();
      if (!token.cancelled) progress.close('error');
      if (!token.cancelled) toast(err.message || 'Could not create the audiobook.', 'err');
    });
  };
}

function openSleepDialog(state) {
  const active = getSleepTimer();
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="sleep-lead">Narration and audio stop when the timer ends. The screen dims so you can settle.</p>
    <div class="sleep-grid">
      ${[5, 10, 15, 20, 30, 45, 60, 90].map(m => `<button class="sleep-opt" data-sleep-min="${m}"><strong>${m}</strong><span>min</span></button>`).join('')}
    </div>
    ${active ? `<div class="sleep-active">Running · ${formatSleepRemaining(active.remainingMs)} left</div>` : ''}`;
  const foot = document.createElement('div');
  foot.innerHTML = active ? '<button class="btn btn-sm btn-danger" data-sleep-cancel>Cancel timer</button>' : '';
  const m = modal({ eyebrow: 'Bedtime', title: 'Sleep timer', body, foot });
  body.querySelectorAll('[data-sleep-min]').forEach(btn => {
    btn.addEventListener('click', () => {
      const minutes = Number(btn.dataset.sleepMin);
      startSleepTimer(minutes);
      m.close();
      toast(`Sleep timer set for ${minutes} minutes`, 'ok');
    });
  });
  foot.querySelector('[data-sleep-cancel]')?.addEventListener('click', () => {
    cancelSleepTimer();
    m.close();
    toast('Sleep timer cancelled', 'ok');
  });
}

function openGoTo(state) {
  if (state.mode === 'pdf' || state.mode === 'comic') {
    const max = state.numPages || 1;
    const body = document.createElement('div');
    body.innerHTML = `<div class="field">
      <label for="goPage">Page number <span class="dim" style="font-weight:400">· 1–${max}</span></label>
      <input class="input" id="goPage" type="number" min="1" max="${max}" value="${state.page || 1}" autofocus>
    </div>
    <p class="hint">Jump straight to a page, even if it belongs to another chapter.</p>`;
    const foot = document.createElement('div');
    foot.innerHTML = `<button class="btn btn-primary" data-go-page>Go to page</button>`;
    const m = modal({ eyebrow: 'Jump', title: 'Go to page', body, foot });
    const go = () => {
      const n = clamp(parseInt(body.querySelector('#goPage')?.value, 10) || 1, 1, max);
      m.close();
      if (state.mode === 'pdf') state.pdfView?.scrollToPage(n, { smooth: false });
      else state.comicView?.showPage(n);
    };
    foot.querySelector('[data-go-page]').onclick = go;
    body.querySelector('#goPage').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
    });
    return;
  }

  const chapters = state.book?.chapters || [];
  if (!chapters.length) return;
  const currentPct = Math.round((state.ratio || 0) * 100);
  const body = document.createElement('div');
  body.innerHTML = `<div class="field">
    <label for="goChapter">Chapter</label>
    <select class="select" id="goChapter">
      ${chapters.map((c, i) => `<option value="${i}"${i === state.chapterIndex ? ' selected' : ''}>${esc(c.label || `Chapter ${i + 1}`)}</option>`).join('')}
    </select>
  </div>
  <div class="field" style="margin-top:14px">
    <label for="goPos">Position in chapter <span class="dim" id="goPosOut" style="font-weight:400">${currentPct}%</span></label>
    <input class="range" id="goPos" type="range" min="0" max="100" step="1" value="${currentPct}">
  </div>
  <p class="hint">Reflowable pages change with type size, so jump by chapter and position.</p>`;
  const foot = document.createElement('div');
  foot.innerHTML = '<button class="btn btn-primary" data-go-chapter>Jump</button>';
  const m = modal({ eyebrow: 'Jump', title: 'Go to another chapter', body, foot });
  const pos = body.querySelector('#goPos');
  pos.addEventListener('input', () => { body.querySelector('#goPosOut').textContent = `${pos.value}%`; });
  const go = () => {
    m.close();
    gotoChapter(state, Number(body.querySelector('#goChapter').value), { ratio: Number(pos.value) / 100 });
  };
  foot.querySelector('[data-go-chapter]').onclick = go;
}

function openMoreMenu(state) {
  const rect = refs.moreBtn.getBoundingClientRect();
  contextMenu(rect.right - 8, rect.bottom + 8, [
    { label: 'Go to page…', icon: 'list', onSelect: () => openGoTo(state) },
    ...(state.mode !== 'comic' ? [{ label: 'Search in book…', icon: 'search', onSelect: () => openBookSearch(state) }] : []),
    ...(state.mode !== 'comic' ? [{ label: 'Make audiobook…', icon: 'loudhailer', onSelect: () => openAudiobookDialog(state) }] : []),
    {
      label: getSleepTimer() ? `Sleep timer · ${formatSleepRemaining(getSleepTimer().remainingMs)}` : 'Sleep timer…',
      icon: 'moon',
      onSelect: () => openSleepDialog(state),
    },
    { label: 'Book details', icon: 'info', onSelect: () => openBookDetails(state.app, state.record, { fromReader: true }) },
    { label: 'Download audio', icon: 'download', onSelect: () => downloadBookAudio(state.record) },
    { label: 'Keyboard shortcuts', icon: 'keyboard', onSelect: () => shortcutsModal() },
    { sep: true },
    {
      label: 'Remove from library', icon: 'trash', danger: true, onSelect: async () => {
        const ok = await confirmDialog({
          title: 'Remove this book?',
          message: 'The file, reading position, bookmarks and highlights will be deleted from this device.',
          confirmLabel: 'Remove book',
        });
        if (!ok) return;
        await closeReader({ skipReload: true, skipSave: true });
        await db.deleteBook(state.bookId);
        state.app.bookmarks = state.app.bookmarks.filter(b => b.bookId !== state.bookId);
        state.app.highlights = state.app.highlights.filter(h => h.bookId !== state.bookId);
        state.app.progress.delete(state.bookId);
        await state.app.reload();
        toast('Book removed', 'ok');
      },
    },
  ]);
}

/* ═══════════════════════════════════════════════════════════════════
   Stage clicks / keyboard
   ═══════════════════════════════════════════════════════════════════ */

function handleStageClick(state, e) {
  if (state.mode === 'pdf' || state.mode === 'comic') return;

  const nav = e.target.closest('[data-chapter-nav]');
  if (nav) {
    e.preventDefault();
    gotoChapter(state, Number(nav.dataset.chapterNav));
    return;
  }

  const link = e.target.closest('a[href], a[data-nav-chapter]');
  if (link) {
    if (link.dataset.navChapter != null) {
      e.preventDefault();
      const index = Number(link.dataset.navChapter);
      const anchor = link.dataset.navAnchor || '';
      gotoChapter(state, index, { anchor });
      return;
    }
    if (/^(https?:|mailto:)/i.test(link.getAttribute('href') || '')) return;
    e.preventDefault();
    return;
  }

  const mark = e.target.closest('mark.hl');
  if (mark) {
    const rec = state.highlights.find(h => h.id === mark.dataset.hlId);
    if (rec) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      openHighlightMenu(state, rec, e.clientX, e.clientY);
    }
  }
}

function handleKey(state, e) {
  if (state.destroyed || isModalOpen()) return;
  if (isEditable(e.target)) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && state.mode !== 'comic') {
    e.preventDefault();
    openBookSearch(state);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const drawer = refs.tocDrawer.classList.contains('is-open');
  const panel = !refs.typePanel.hidden;

  if (e.key === 'Escape') {
    e.preventDefault();
    if (!refs.selBar.hidden) hideSelection(state);
    else if (panel) closeTypePanel(state);
    else if (drawer) closeToc(state);
    else closeReader();
    return;
  }

  if (drawer || panel) return;

  const k = e.key.toLowerCase();
  if (k === 't') { e.preventDefault(); toggleListen(state); return; }
  if (k === 'b') { e.preventDefault(); toggleBookmark(state); return; }
  if (k === 'c') { e.preventDefault(); toggleToc(state); return; }
  if (k === 'a') { e.preventDefault(); toggleTypePanel(state); return; }
  if (k === 'g') { e.preventDefault(); openGoTo(state); return; }
  if (e.key === '?') { e.preventDefault(); shortcutsModal(); return; }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (state.mode === 'pdf') state.pdfView?.scrollToPage((state.page || 1) + 1, { smooth: false });
    else if (state.mode === 'comic') state.comicView?.nextPage();
    else gotoChapter(state, state.chapterIndex + 1);
    return;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (state.mode === 'pdf') state.pdfView?.scrollToPage((state.page || 1) - 1, { smooth: false });
    else if (state.mode === 'comic') state.comicView?.prevPage();
    else gotoChapter(state, state.chapterIndex - 1);
    return;
  }
  if (state.mode === 'comic' && (e.key === ' ' || e.key === 'PageDown')) {
    if (e.target.closest?.('button, a, input, textarea, select')) return;
    e.preventDefault();
    if (e.shiftKey) state.comicView?.prevPage();
    else state.comicView?.nextPage();
    return;
  }
  if (state.mode === 'comic' && e.key === 'PageUp') {
    e.preventDefault();
    state.comicView?.prevPage();
    return;
  }
  if (e.key === ' ' || e.key === 'PageDown') {
    if (e.target.closest?.('button, a, input, textarea, select')) return;
    e.preventDefault();
    refs.stage.scrollBy({ top: refs.stage.clientHeight * 0.82, behavior: 'smooth' });
    return;
  }
  if (e.key === 'PageUp') {
    e.preventDefault();
    refs.stage.scrollBy({ top: -refs.stage.clientHeight * 0.82, behavior: 'smooth' });
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    if (state.mode === 'comic') state.comicView?.showPage(1);
    else if (state.mode === 'pdf') state.pdfView?.scrollToPage(1, { smooth: false });
    else refs.stage.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (e.key === 'End') {
    e.preventDefault();
    if (state.mode === 'comic') state.comicView?.showPage(state.numPages || 1);
    else if (state.mode === 'pdf') state.pdfView?.scrollToPage(state.numPages || 1, { smooth: false });
    else refs.stage.scrollTo({ top: refs.stage.scrollHeight, behavior: 'smooth' });
  }
}
