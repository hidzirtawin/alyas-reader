/* Whole-book MP3 export used by the library, book details and reader menus. */

import { db } from './db.js';
import { getPrefs } from './prefs.js';
import { buildReflowable } from './renderers.js';
import { createAudiobook } from './audiobook.js';
import { modal, toast } from './ui.js';
import { downloadBlob, formatBytes, detectSentenceSegments } from './util.js';

async function buildExportState(book) {
  const blob = await db.getBlob(book.id);
  if (!blob) throw new Error('This book’s file is missing from the library.');

  if (book.format === 'pdf') {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error('The PDF reader did not load. Reload the page and try again.');
    const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
    const pdfView = {
      destroy() { try { pdf.destroy(); } catch {} },
      async getPageSentences(pageNumber) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .filter(item => typeof item.str === 'string' && item.str.length)
          .map(item => item.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        return detectSentenceSegments(text)
          .map(segment => segment.text.trim())
          .filter(line => line.length > 1 && /[\p{L}\p{N}]/u.test(line))
          .map(text => ({ text, page: pageNumber }));
      },
    };
    return {
      mode: 'pdf',
      record: book,
      book: null,
      pdfView,
      numPages: pdf.numPages,
      page: 1,
      chapterIndex: 0,
    };
  }

  const built = await buildReflowable(book, blob);
  return {
    mode: 'reflow',
    record: book,
    book: built,
    chapterIndex: 0,
    chapter: built.chapters?.[0] || null,
    sentences: null,
  };
}

export async function downloadBookAudio(book, { state = null } = {}) {
  if (!book) return;
  if (['cbz', 'cbr'].includes(book.format)) {
    toast('Comic pages are images, so there is no text to turn into an audiobook.', 'info');
    return;
  }
  const tts = getPrefs().tts;
  if (tts.provider !== 'piper') {
    toast('Choose a Piper voice in Settings before downloading audio.', 'info');
    return;
  }

  window.lumen?.pauseTTS?.();

  const progress = modal({
    eyebrow: 'Download audio',
    title: 'Creating the MP3',
    body: '<div class="backup-status"><div class="backup-pct" id="bookAudioPct">0%</div><p id="bookAudioStatus">Preparing the first chapter…</p><button class="btn btn-sm" data-cancel-book-audio style="margin-top:14px">Cancel</button></div>',
    dismissible: false,
  });
  const token = { cancelled: false };
  const pct = progress.bodyEl.querySelector('#bookAudioPct');
  const status = progress.bodyEl.querySelector('#bookAudioStatus');
  progress.bodyEl.querySelector('[data-cancel-book-audio]').onclick = () => {
    token.cancelled = true;
    progress.close('cancel');
    toast('MP3 creation cancelled', 'info');
  };

  let temporaryState = null;
  try {
    const exportState = state || (temporaryState = await buildExportState(book));
    const result = await createAudiobook(exportState, {
      scope: 'book',
      format: 'mp3',
      voiceId: tts.piperVoice,
      speaker: tts.piperSpeaker,
      token,
      onProgress: p => {
        if (token.cancelled) return;
        if (pct) pct.textContent = `${p.percent || 0}%`;
        if (status) {
          status.textContent = p.phase === 'encoding'
            ? 'Finishing the MP3 file…'
            : `Chapter ${p.chapter || 1} of ${p.chapters || 1}${p.sentences ? ` · sentence ${p.sentence} of ${p.sentences}` : ''}`;
        }
      },
    });
    progress.close('done');
    const length = result.duration ? ` · ${formatAudioLength(result.duration)}` : '';
    const done = modal({
      eyebrow: 'Download audio',
      title: `${result.format === 'mp3' ? 'MP3' : 'Audio'} ready`,
      body: `<p class="hint" style="margin-bottom:12px">${result.format === 'mp3' ? 'MP3 file' : 'Audio file'}${length} · ${formatBytes(result.blob.size)} · ${result.voice || ''}</p>
        <p class="hint">Save the file and open it in any audio or audiobook player.</p>`,
      foot: `<button class="btn btn-primary" data-download-book-audio>Download ${result.format === 'mp3' ? 'MP3' : 'audio'}</button>`,
    });
    done.footEl.querySelector('[data-download-book-audio]').onclick = () => {
      downloadBlob(result.blob, result.filename);
      done.close('download');
      toast('MP3 downloaded', 'ok');
    };
  } catch (err) {
    if (!token.cancelled) {
      progress.close('error');
      toast(err.message || 'Could not create the MP3.', 'err');
    }
  } finally {
    if (temporaryState) {
      try { temporaryState.book?.dispose?.(); } catch {}
      try { temporaryState.pdfView?.destroy?.(); } catch {}
    }
  }
}

function formatAudioLength(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}
