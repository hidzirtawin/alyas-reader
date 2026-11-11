/* Durable whole-book MP3 export.
   Encoded chapters are written to OPFS as they are produced, so a phone
   reload cannot lose the export, and the finished file is downloaded from
   disk instead of being held in memory. */

import { db } from './db.js';
import { getPrefs } from './prefs.js';
import { buildReflowable } from './renderers.js';
import { prepareAudiobook, renderSentenceMp3, safeName, createAudiobook } from './audiobook.js';
import { piperVoiceById, piperSpeakerName } from './tts.js';
import { modal, confirmDialog, toast } from './ui.js';
import {
  downloadBlob, formatBytes, countWords, detectSentenceSegments,
} from './util.js';

const OPFS_DIR = 'audio-exports';
const JOB_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function opfsAvailable() {
  return Boolean(navigator.storage?.getDirectory && window.lamejs?.Mp3Encoder);
}

async function jobsDir(create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create });
}

function chapterFile(index, attempt) {
  return `chapter-${String(index + 1).padStart(4, '0')}-a${attempt}.mp3`;
}

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
          .map(line => ({ text: line, page: pageNumber }));
      },
    };
    return {
      temporary: true,
      state: { mode: 'pdf', record: book, book: null, pdfView, numPages: pdf.numPages, page: 1, chapterIndex: 0 },
    };
  }

  const built = await buildReflowable(book, blob);
  return {
    temporary: true,
    state: { mode: 'reflow', record: book, book: built, chapterIndex: 0, chapter: built.chapters?.[0] || null, sentences: null },
  };
}

async function prepareExport(book) {
  const built = await buildExportState(book);
  try {
    const chapters = await prepareAudiobook(built.state, 'book');
    const totalSentences = chapters.reduce((sum, chapter) => sum + chapter.sentences.length, 0);
    const words = chapters.reduce((sum, chapter) => (
      sum + chapter.sentences.reduce((n, sentence) => n + countWords(sentence), 0)
    ), 0);
    const seconds = Math.max(60, Math.round((words / 160) * 60));
    return { ...built, chapters, totalSentences, seconds };
  } catch (err) {
    disposeBuilt(built);
    throw err;
  }
}

function disposeBuilt(built) {
  if (!built?.temporary) return;
  try { built.state.book?.dispose?.(); } catch {}
  try { built.state.pdfView?.destroy?.(); } catch {}
}

function chooseBitrate(seconds) {
  if (seconds > 8 * 3600) return 48;
  if (seconds > 3 * 3600) return 64;
  if (seconds > 60 * 60) return 96;
  return 128;
}

function voiceLabel(voiceId, speaker) {
  const voice = piperVoiceById(voiceId);
  if (!voice) return '';
  return `${voice.name}${voice.num_speakers > 1 ? ` · ${piperSpeakerName(voice, speaker)}` : ''}`;
}

async function createJob(book, chapters, totalSentences, seconds) {
  const tts = getPrefs().tts;
  const voiceId = tts.piperVoice;
  if (!piperVoiceById(voiceId)) throw new Error('Choose an available Piper voice before downloading audio.');
  const speaker = Number(tts.piperSpeaker) || 0;
  const bitrate = chooseBitrate(seconds);
  const id = `audio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    bookId: book.id,
    title: book.title || 'Audiobook',
    author: book.author || '',
    filename: `${safeName(book.title || 'audiobook', 'audiobook')}.mp3`,
    voice: voiceLabel(voiceId, speaker),
    voiceId,
    speaker,
    bitrate,
    chapters: chapters.length,
    totalSentences,
    chapterIndex: 0,
    doneSentences: 0,
    durationSeconds: 0,
    status: 'running',
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.putAudioExport(job);
  return job;
}

async function removeJob(job) {
  try { await db.deleteAudioExport(job.id); } catch {}
  try {
    const dir = await jobsDir(false);
    await dir.removeEntry(job.id, { recursive: true });
  } catch {}
  try {
    const dir = await jobsDir(false);
    await dir.removeEntry(`${job.id}.mp3`);
  } catch {}
}

async function runJob(job, chapters, { onProgress = () => {}, token = { cancelled: false } } = {}) {
  const dir = await jobsDir(true);
  let jobDir;
  try { jobDir = await dir.getDirectoryHandle(job.id, { create: false }); }
  catch { jobDir = await dir.getDirectoryHandle(job.id, { create: true }); }

  job.attempts = (job.attempts || 0) + 1;
  job.status = 'running';
  job.error = '';
  job.updatedAt = Date.now();
  await db.putAudioExport(job);

  let done = job.doneSentences || 0;
  let duration = job.durationSeconds || 0;

  try {
    for (let ci = job.chapterIndex; ci < chapters.length; ci++) {
      const chapter = chapters[ci];
      // Encode the chapter into a bounded in-memory buffer, then write it
      // once. Keeping a writable open during generation can leave a stale
      // OPFS lock after an iOS reload.
      let parts = [];
      let chapterSeconds = 0;
      for (let si = 0; si < chapter.sentences.length; si++) {
        if (token.cancelled) {
          const err = new Error('Audio export cancelled.');
          err.cancelled = true;
          throw err;
        }
        const { blob, seconds } = await renderSentenceMp3(chapter.sentences[si], job.voiceId, job.speaker, job.bitrate);
        parts.push(new Uint8Array(await blob.arrayBuffer()));
        chapterSeconds += seconds;
        const completed = done + si + 1;
        onProgress({
          phase: 'generating',
          percent: Math.min(92, Math.round((completed / Math.max(1, job.totalSentences)) * 90)),
          chapter: ci + 1,
          chapters: chapters.length,
          sentence: completed,
          sentences: job.totalSentences,
          elapsed: duration + chapterSeconds,
        });
      }
      const chapterBytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) { chapterBytes.set(part, at); at += part.length; }
      parts = null;
      const handle = await jobDir.getFileHandle(chapterFile(ci, job.attempts), { create: true });
      const writable = await handle.createWritable();
      await writable.write(chapterBytes);
      await writable.close();

      done += chapter.sentences.length;
      duration += chapterSeconds;
      job.chapterIndex = ci + 1;
      job.doneSentences = done;
      job.durationSeconds = duration;
      job.updatedAt = Date.now();
      await db.putAudioExport(job);
      onProgress({
        phase: 'chapter',
        percent: Math.min(94, Math.round((done / Math.max(1, job.totalSentences)) * 92)),
        chapter: ci + 1,
        chapters: chapters.length,
        sentence: done,
        sentences: job.totalSentences,
        elapsed: duration,
      });
    }

    onProgress({ phase: 'encoding', percent: 96, elapsed: duration });
    const chapterFiles = new Map();
    for await (const [name] of jobDir.entries()) {
      const match = /^chapter-(\d+)-a(\d+)\.mp3$/.exec(name);
      if (!match) continue;
      const index = Number(match[1]) - 1;
      const attempt = Number(match[2]);
      const current = chapterFiles.get(index);
      if (!current || attempt > current.attempt) chapterFiles.set(index, { name, attempt });
    }
    for (let ci = 0; ci < chapters.length; ci++) {
      if (!chapterFiles.has(ci)) {
        job.chapterIndex = 0;
        job.doneSentences = 0;
        job.durationSeconds = 0;
        job.updatedAt = Date.now();
        await db.putAudioExport(job);
        throw new Error('The saved audio chapters were incomplete; the export will restart.');
      }
    }

    const finalHandle = await dir.getFileHandle(`${job.id}.mp3`, { create: true });
    const out = await finalHandle.createWritable();
    try {
      for (let ci = 0; ci < chapters.length; ci++) {
        const handle = await jobDir.getFileHandle(chapterFiles.get(ci).name, { create: false });
        const file = await handle.getFile();
        const reader = file.stream().getReader();
        while (true) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          await out.write(value);
        }
      }
    } finally {
      try { await out.close(); } catch {}
    }
    try { await dir.removeEntry(job.id, { recursive: true }); } catch {}

    const file = await finalHandle.getFile();
    job.bytes = file.size;
    job.status = 'complete';
    job.updatedAt = Date.now();
    job.durationSeconds = duration;
    job.doneSentences = done;
    await db.putAudioExport(job);
    onProgress({ phase: 'done', percent: 100, elapsed: duration });
    return { job, file };
  } catch (err) {
    if (!err.cancelled) {
      job.error = err.message || 'Audio export stopped.';
      job.status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'running';
      job.updatedAt = Date.now();
      try { await db.putAudioExport(job); } catch {}
    }
    throw err;
  }
}

function saveFile(file, filename) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'audiobook.mp3';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Large files need time to be read from disk; keep the URL alive.
  setTimeout(() => URL.revokeObjectURL(url), 60 * 60 * 1000);
}

async function downloadJob(job) {
  const dir = await jobsDir(false);
  const handle = await dir.getFileHandle(`${job.id}.mp3`, { create: false });
  const file = await handle.getFile();
  saveFile(file, job.filename);
  job.downloadedAt = Date.now();
  await db.putAudioExport(job);
  toast('MP3 download started', 'ok');
}

function showReady(job) {
  const size = job.bytes ? formatBytes(job.bytes) : '';
  const length = job.durationSeconds ? formatDuration(job.durationSeconds) : '';
  const done = modal({
    eyebrow: 'Download audio',
    title: 'MP3 ready',
    body: `<p class="hint" style="margin-bottom:12px">MP3 file${length ? ` · ${length}` : ''}${size ? ` · ${size}` : ''} · ${job.bitrate} kbps${job.voice ? ` · ${job.voice}` : ''}</p>
      <p class="hint">The file is stored on this device until you download it, clear the library, or it expires after 7 days. It will still be here after a reload.</p>`,
    foot: '<button class="btn btn-primary" data-download-book-audio>Download MP3</button>',
  });
  done.footEl.querySelector('[data-download-book-audio]').onclick = () => {
    downloadJob(job).then(() => done.close('download')).catch(err => toast(err.message || 'Could not open the MP3.', 'err'));
  };
}

function progressModal() {
  const m = modal({
    eyebrow: 'Download audio',
    title: 'Creating the MP3',
    body: '<div class="backup-status"><div class="backup-pct" id="bookAudioPct">0%</div><p id="bookAudioStatus">Preparing the first chapter…</p><button class="btn btn-sm" data-cancel-book-audio style="margin-top:14px">Cancel</button></div>',
    dismissible: false,
  });
  return m;
}

async function runWithModal(job, chapters) {
  const progress = progressModal();
  const token = { cancelled: false };
  const pct = progress.bodyEl.querySelector('#bookAudioPct');
  const status = progress.bodyEl.querySelector('#bookAudioStatus');
  progress.bodyEl.querySelector('[data-cancel-book-audio]').onclick = () => {
    token.cancelled = true;
  };
  try {
    const { file } = await runJob(job, chapters, {
      token,
      onProgress: p => {
        if (token.cancelled && p.phase !== 'done') return;
        if (pct) pct.textContent = `${p.percent || 0}%`;
        if (!status) return;
        status.textContent = p.phase === 'encoding'
          ? 'Joining the chapters into one MP3…'
          : p.phase === 'done'
            ? 'MP3 ready'
            : `Chapter ${p.chapter || 1} of ${p.chapters || 1}${p.sentences ? ` · sentence ${p.sentence} of ${p.sentences}` : ''}`;
      },
    });
    progress.close('done');
    job.bytes = file.size;
    showReady(job);
  } catch (err) {
    progress.close('error');
    if (token.cancelled) {
      await removeJob(job);
      toast('MP3 creation cancelled', 'info');
    } else {
      toast(job.error || err.message || 'Audio export paused. It will resume when you reopen the app.', 'err');
    }
  }
}

async function resumeWithModal(job) {
  const book = await db.getBook(job.bookId);
  if (!book) {
    await removeJob(job);
    toast('The book for this audio export is no longer in the library.', 'err');
    return;
  }
  const prepared = await prepareExport(book);
  try {
    if (prepared.totalSentences !== job.totalSentences) {
      job.chapterIndex = 0;
      job.doneSentences = 0;
      job.durationSeconds = 0;
      job.totalSentences = prepared.totalSentences;
      job.chapters = prepared.chapters.length;
      await db.putAudioExport(job);
    }
    await runWithModal(job, prepared.chapters);
  } finally {
    disposeBuilt(prepared);
  }
}

async function legacyDownload(book) {
  const prepared = await prepareExport(book);
  const estimatedMb = Math.round((prepared.seconds * 128 * 1000) / 8 / (1024 * 1024));
  if (estimatedMb > 350) {
    disposeBuilt(prepared);
    toast('This browser cannot save a long export to disk. Use Make audiobook → MP3 chapters instead.', 'err');
    return;
  }
  const progress = progressModal();
  const token = { cancelled: false };
  const pct = progress.bodyEl.querySelector('#bookAudioPct');
  const status = progress.bodyEl.querySelector('#bookAudioStatus');
  progress.bodyEl.querySelector('[data-cancel-book-audio]').onclick = () => {
    token.cancelled = true;
    progress.close('cancel');
    toast('MP3 creation cancelled', 'info');
  };
  try {
    const result = await createAudiobook(prepared.state, {
      scope: 'book',
      format: 'mp3',
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
    const done = modal({
      eyebrow: 'Download audio',
      title: 'MP3 ready',
      body: `<p class="hint" style="margin-bottom:12px">MP3 file${result.duration ? ` · ${formatDuration(result.duration)}` : ''} · ${formatBytes(result.blob.size)}</p>
        <p class="hint">Save the file and open it in any audio or audiobook player.</p>`,
      foot: '<button class="btn btn-primary" data-download-book-audio>Download MP3</button>',
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
    disposeBuilt(prepared);
  }
}

export async function downloadBookAudio(book) {
  if (!book) return;
  if (['cbz', 'cbr'].includes(book.format)) {
    toast('Comic pages are images, so there is no text to turn into an audiobook.', 'info');
    return;
  }
  if (getPrefs().tts.provider !== 'piper') {
    toast('Choose a Piper voice in Settings before downloading audio.', 'info');
    return;
  }
  if (!opfsAvailable()) {
    await legacyDownload(book);
    return;
  }

  window.lumen?.pauseTTS?.();

  try {
    const jobs = await db.listAudioExports();
    const existing = jobs.find(job => job.bookId === book.id && job.status === 'complete')
      || jobs.find(job => job.bookId === book.id && job.status === 'running' && (job.attempts || 0) < MAX_ATTEMPTS);
    if (existing?.status === 'complete') {
      try {
        const dir = await jobsDir(false);
        await dir.getFileHandle(`${existing.id}.mp3`, { create: false });
        showReady(existing);
        return;
      } catch {
        await removeJob(existing);
      }
    }
    if (existing?.status === 'running') {
      await resumeWithModal(existing);
      return;
    }
    const stale = jobs.filter(job => job.bookId === book.id);
    for (const job of stale) await removeJob(job);

    const prepared = await prepareExport(book);
    const bitrate = chooseBitrate(prepared.seconds);
    const estimatedMb = Math.round((prepared.seconds * bitrate * 1000) / 8 / (1024 * 1024));
    let proceed = true;
    if (estimatedMb > 350) {
      proceed = await confirmDialog({
        title: 'Create a large MP3?',
        message: `This book will produce about ${estimatedMb} MB of audio (${formatDuration(prepared.seconds)}) at ${bitrate} kbps. Large exports can take a long time and need plenty of free space.`,
        confirmLabel: 'Create MP3',
        cancelLabel: 'Cancel',
        danger: false,
      });
    }
    if (!proceed) {
      disposeBuilt(prepared);
      return;
    }

    const job = await createJob(book, prepared.chapters, prepared.totalSentences, prepared.seconds);
    try {
      await runWithModal(job, prepared.chapters);
    } finally {
      disposeBuilt(prepared);
    }
  } catch (err) {
    toast(err.message || 'Could not start the audio export.', 'err');
  }
}

export async function resumeAudioExports() {
  try {
    const jobs = await db.listAudioExports();
    const now = Date.now();
    for (const job of jobs) {
      if (job.status === 'complete' && !job.downloadedAt && now - (job.updatedAt || job.createdAt) > JOB_TTL) {
        await removeJob(job);
        continue;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        if (now - (job.updatedAt || job.createdAt) > 24 * 60 * 60 * 1000) await removeJob(job);
        continue;
      }
      if (job.status === 'running' && (job.attempts || 0) >= MAX_ATTEMPTS) {
        toast(`Audio export paused · ${job.title}`, 'err', {
          actionLabel: 'Retry',
          duration: 20000,
          onAction: async () => {
            job.attempts = 0;
            await db.putAudioExport(job);
            resumeWithModal(job).catch(err => toast(err.message || 'Could not resume the export.', 'err'));
          },
        });
        continue;
      }
      if (job.status !== 'running') continue;
      const book = await db.getBook(job.bookId);
      if (!book) {
        await removeJob(job);
        continue;
      }
      toast(`Resuming interrupted MP3 export · ${job.title}`, 'info');
      try {
        const prepared = await prepareExport(book);
        if (prepared.totalSentences !== job.totalSentences) {
          job.chapterIndex = 0;
          job.doneSentences = 0;
          job.durationSeconds = 0;
          job.totalSentences = prepared.totalSentences;
          job.chapters = prepared.chapters.length;
          await db.putAudioExport(job);
        }
        const { file } = await runJob(job, prepared.chapters);
        job.bytes = file.size;
        disposeBuilt(prepared);
        showReady(job);
      } catch (err) {
        console.warn('Audio export resume paused', err);
        toast('The interrupted MP3 export could not finish yet. Use Download audio to retry.', 'err');
      }
    }
    const ready = jobs.find(job => job.status === 'complete' && !job.downloadedAt);
    if (ready && !jobs.some(job => job.status === 'running')) {
      toast('Your MP3 is ready to download.', 'ok', {
        actionLabel: 'Download',
        duration: 15000,
        onAction: () => showReady(ready),
      });
    }
  } catch (err) {
    console.warn('Could not check audio exports', err);
  }
}

export async function clearAudioExports() {
  try {
    const jobs = await db.listAudioExports();
    for (const job of jobs) await removeJob(job);
    const dir = await jobsDir(false);
    for await (const [name] of dir.entries()) {
      try { await dir.removeEntry(name, { recursive: true }); } catch {}
    }
  } catch {}
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}
