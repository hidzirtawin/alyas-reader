/* Durable whole-book MP3 export.
   Encoded chapters are written to OPFS as they are produced, so a phone
   reload cannot lose the export, and the finished file is downloaded from
   disk instead of being held in memory. */

import { db } from './db.js';
import { getPrefs } from './prefs.js';
import { buildReflowable } from './renderers.js';
import { prepareAudiobook, renderSentenceWav, Mp3StreamEncoder, safeName, createAudiobook } from './audiobook.js?v=voicecache1';
import { piperVoiceById, piperSpeakerName, onPiperProgress, piperProgressLabel } from './tts.js?v=voicecache1';
import { modal, confirmDialog, toast } from './ui.js';
import {
  downloadBlob, formatBytes, countWords, detectSentenceSegments, splitLongText,
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

async function prepareExport(book, scope = 'book', sourceState = null) {
  const built = sourceState ? { temporary: false, state: sourceState } : await buildExportState(book);
  try {
    const chapters = await prepareAudiobook(built.state, scope);
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
  if (seconds > 8 * 3600) return 32;
  if (seconds > 3 * 3600) return 48;
  if (seconds > 60 * 60) return 64;
  return 96;
}

function voiceLabel(voiceId, speaker) {
  const voice = piperVoiceById(voiceId);
  if (!voice) return '';
  return `${voice.name}${voice.num_speakers > 1 ? ` · ${piperSpeakerName(voice, speaker)}` : ''}`;
}

async function createJob(book, chapters, totalSentences, seconds, { scope = 'book', voiceId = null, speaker = null } = {}) {
  const tts = getPrefs().tts;
  voiceId = voiceId || tts.piperVoice;
  if (!piperVoiceById(voiceId)) throw new Error('Choose an available Piper voice before downloading audio.');
  speaker = Number.isFinite(Number(speaker)) ? Number(speaker) : (Number(tts.piperSpeaker) || 0);
  const bitrate = chooseBitrate(seconds);
  const id = `audio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    bookId: book.id,
    scope,
    title: book.title || 'Audiobook',
    author: book.author || '',
    filename: `${safeName(book.title || 'audiobook', 'audiobook')}${scope === 'chapter' && chapters[0]?.title ? ` - ${safeName(chapters[0].title)}` : ''}.mp3`,
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

function chapterChunks(sentences, maxChars = 800) {
  const chunks = [];
  let text = '';
  let count = 0;
  for (const sentence of sentences) {
    const clean = String(sentence || '').trim();
    if (!clean) continue;
    const fragments = splitLongText(clean, maxChars);
    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i];
      if (text && text.length + fragment.length + 1 > maxChars) {
        chunks.push({ text, count });
        text = '';
        count = 0;
      }
      text += (text ? ' ' : '') + fragment;
      if (i === fragments.length - 1) count++;
      if (text.length >= maxChars) {
        chunks.push({ text, count });
        text = '';
        count = 0;
      }
    }
  }
  if (text) chunks.push({ text, count });
  return chunks;
}

async function waitForNarration(token, onProgress, info) {
  const engine = window.lumen?.reader?.engine;
  if (!engine) return;
  let notified = false;
  while (!token.cancelled && (engine.state === 'playing' || engine.state === 'loading')) {
    if (!notified) {
      notified = true;
      onProgress({ ...info, phase: 'waiting' });
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function runJob(job, chapters, { onProgress = () => {}, token = { cancelled: false } } = {}) {
  const dir = await jobsDir(true);
  const finalHandle = await dir.getFileHandle(`${job.id}.mp3`, { create: true });

  job.attempts = (job.attempts || 0) + 1;
  job.status = 'running';
  job.error = '';
  job.updatedAt = Date.now();
  await db.putAudioExport(job);

  // If a reload happened during append, trim the output back to its last
  // committed size before regenerating that chapter.
  if (job.pendingAppend) {
    const repair = await finalHandle.createWritable({ keepExistingData: true });
    await repair.truncate(job.pendingAppend.offset);
    await repair.close();
    job.pendingAppend = null;
    await db.putAudioExport(job);
  }

  let done = job.doneSentences || 0;
  let duration = job.durationSeconds || 0;

  try {
    for (let ci = job.chapterIndex; ci < chapters.length; ci++) {
      const chapter = chapters[ci];
      const batches = chapterChunks(chapter.sentences);
      let encoder = null;
      let chapterSeconds = 0;
      let chapterDone = 0;
      for (const chunk of batches) {
        if (token.cancelled) {
          const err = new Error('Audio export cancelled.');
          err.cancelled = true;
          throw err;
        }
        await waitForNarration(token, onProgress, {
          percent: Math.min(92, Math.round(((done + chapterDone) / Math.max(1, job.totalSentences)) * 90)),
          chapter: ci + 1,
          chapters: chapters.length,
          sentence: done + chapterDone,
          sentences: job.totalSentences,
          elapsed: duration + chapterSeconds,
        });
        if (token.cancelled) {
          const err = new Error('Audio export cancelled.');
          err.cancelled = true;
          throw err;
        }
        const wav = await renderSentenceWav(chunk.text, job.voiceId, job.speaker);
        encoder ||= new Mp3StreamEncoder(wav.fmt, job.bitrate);
        encoder.push(wav.data);
        chapterSeconds += wav.seconds;
        chapterDone += chunk.count;
        const completed = done + chapterDone;
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

      if (!encoder) throw new Error('A chapter contained no encodable audio.');
      const chapterMp3 = encoder.finish();
      const existingFile = await finalHandle.getFile();
      const offset = existingFile.size;
      job.pendingAppend = { chapterIndex: ci, offset };
      await db.putAudioExport(job);
      const output = await finalHandle.createWritable({ keepExistingData: true });
      await output.seek(offset);
      await output.write(new Uint8Array(await chapterMp3.arrayBuffer()));
      await output.close();

      done += chapter.sentences.length;
      duration += chapterSeconds;
      job.chapterIndex = ci + 1;
      job.doneSentences = done;
      job.durationSeconds = duration;
      job.pendingAppend = null;
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
    const file = await finalHandle.getFile();
    job.bytes = file.size;
    job.status = 'complete';
    job.updatedAt = Date.now();
    job.durationSeconds = duration;
    job.doneSentences = done;
    job.pendingAppend = null;
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

function triggerFileDownload(url, filename) {
  // Call synchronously from the user's tap: iOS may reject a delayed anchor
  // click after an awaited OPFS read.
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'audiobook.mp3';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 60 * 1000);
}

async function showReady(job) {
  const size = job.bytes ? formatBytes(job.bytes) : '';
  const length = job.durationSeconds ? formatDuration(job.durationSeconds) : '';
  const done = modal({
    eyebrow: 'Download audio',
    title: 'MP3 ready',
    body: `<p class="hint" style="margin-bottom:12px">MP3 file${length ? ` · ${length}` : ''}${size ? ` · ${size}` : ''} · ${job.bitrate} kbps${job.voice ? ` · ${job.voice}` : ''}</p>
      <p class="hint">The file is stored on this device until you download it, clear the library, or it expires after 7 days. It will still be here after a reload.</p>`,
    foot: '<button class="btn btn-primary" data-download-book-audio disabled>Preparing download…</button>',
  });
  const button = done.footEl.querySelector('[data-download-book-audio]');
  let objectUrl = null;
  try {
    const dir = await jobsDir(false);
    const handle = await dir.getFileHandle(`${job.id}.mp3`, { create: false });
    const file = await handle.getFile();
    objectUrl = URL.createObjectURL(file);
    button.disabled = false;
    button.textContent = 'Download MP3';
  } catch (err) {
    button.textContent = 'Download unavailable';
    toast(err.message || 'Could not open the finished MP3.', 'err');
    return done;
  }
  button.onclick = () => {
    triggerFileDownload(objectUrl, job.filename);
    done.close('download');
    job.downloadedAt = Date.now();
    db.putAudioExport(job).catch(() => {});
    toast('MP3 download started', 'ok');
  };
  return done;
}

function progressModal({ title = 'Creating the MP3', status = 'Preparing the voice and first chapter…' } = {}) {
  const m = modal({
    eyebrow: 'Download audio',
    title,
    body: `<div class="backup-status"><div class="backup-pct" id="bookAudioPct">0%</div><p id="bookAudioStatus">${status}</p><button class="btn btn-sm" data-cancel-book-audio style="margin-top:14px">Cancel</button></div><p class="hint" style="margin-top:10px">Local speech generation can take a while. Progress is saved after every chapter, so a reload will not lose it. Pause narration to let the export run at full speed.</p>`,
    dismissible: false,
  });
  return m;
}

async function runWithModal(job, chapters, { progress = null, token = { cancelled: false } } = {}) {
  progress ||= progressModal();
  const pct = progress.bodyEl.querySelector('#bookAudioPct');
  const status = progress.bodyEl.querySelector('#bookAudioStatus');
  let generationStarted = false;
  const stopProgress = onPiperProgress(p => {
    if (!generationStarted && status && (p.phase === 'downloading' || p.phase === 'checking' || p.phase === 'preparing')) {
      status.textContent = piperProgressLabel(p);
    }
  });
  progress.bodyEl.querySelector('[data-cancel-book-audio]').onclick = () => {
    token.cancelled = true;
  };
  try {
    const { file } = await runJob(job, chapters, {
      token,
      onProgress: p => {
        if (token.cancelled && p.phase !== 'done') return;
        if (p.phase === 'generating' || p.phase === 'chapter' || p.phase === 'encoding') generationStarted = true;
        if (pct) pct.textContent = `${p.percent || 0}%`;
        if (!status) return;
        status.textContent = p.phase === 'encoding'
          ? 'Joining the chapters into one MP3…'
          : p.phase === 'waiting'
            ? 'Paused while narration is playing. Pause narration for a faster export.'
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
  } finally {
    stopProgress();
  }
}

async function resumeWithModal(job) {
  const book = await db.getBook(job.bookId);
  if (!book) {
    await removeJob(job);
    toast('The book for this audio export is no longer in the library.', 'err');
    return;
  }
  let prepared = null;
  let progress = progressModal({ title: 'Resuming the MP3', status: 'Reading chapters and checking saved progress…' });
  const token = { cancelled: false };
  progress.bodyEl.querySelector('[data-cancel-book-audio]').onclick = () => {
    token.cancelled = true;
    progress.close('cancel');
    toast('MP3 export paused. Use Download audio to resume it.', 'info');
  };
  try {
    prepared = await prepareExport(book, job.scope || 'book');
    if (token.cancelled) return;
    if (prepared.totalSentences !== job.totalSentences) {
      job.chapterIndex = 0;
      job.doneSentences = 0;
      job.durationSeconds = 0;
      job.totalSentences = prepared.totalSentences;
      job.chapters = prepared.chapters.length;
      job.pendingAppend = null;
      await db.putAudioExport(job);
    }
    await runWithModal(job, prepared.chapters, { progress, token });
    progress = null;
  } catch (err) {
    if (progress) progress.close('error');
    if (!token.cancelled) toast(err.message || 'Could not resume the MP3 export.', 'err');
  } finally {
    if (prepared) disposeBuilt(prepared);
  }
}

async function legacyDownload(book) {
  const prepared = await prepareExport(book, 'book');
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

export async function downloadBookAudio(book, { scope = 'book', state = null, voiceId = null, speaker = null } = {}) {
  if (!book) return;
  if (['cbz', 'cbr'].includes(book.format)) {
    toast('Comic pages are images, so there is no text to turn into an audiobook.', 'info');
    return;
  }
  if (getPrefs().tts.provider !== 'piper') {
    toast('Choose a fast Piper voice in Settings before downloading audio.', 'info');
    return;
  }
  const tts = getPrefs().tts;
  const chosenVoice = voiceId || tts.piperVoice;
  const chosenSpeaker = Number.isFinite(Number(speaker)) ? Number(speaker) : (Number(tts.piperSpeaker) || 0);
  if (!opfsAvailable()) {
    await legacyDownload(book);
    return;
  }

  window.lumen?.pauseTTS?.();
  let prepared = null;
  let progress = null;
  let token = null;
  try {
    const jobs = await db.listAudioExports();
    const matches = job => job.bookId === book.id
      && (job.scope || 'book') === scope
      && job.voiceId === chosenVoice
      && Number(job.speaker || 0) === chosenSpeaker;
    const existing = jobs.find(job => matches(job) && job.status === 'complete')
      || jobs.find(job => matches(job) && job.status === 'running' && (job.attempts || 0) < MAX_ATTEMPTS);
    if (existing?.status === 'complete') {
      try {
        const dir = await jobsDir(false);
        await dir.getFileHandle(`${existing.id}.mp3`, { create: false });
        await showReady(existing);
        return;
      } catch {
        await removeJob(existing);
      }
    }
    if (existing?.status === 'running') {
      await resumeWithModal(existing);
      return;
    }
    const stale = jobs.filter(job => matches(job));
    for (const job of stale) await removeJob(job);

    // Show work immediately; parsing a large book can take long enough that
    // an otherwise blank screen looks like a crash on iPhone.
    progress = progressModal({ title: 'Preparing the MP3', status: 'Reading the book and estimating audio length…' });
    token = { cancelled: false };
    progress.bodyEl.querySelector('[data-cancel-book-audio]').onclick = () => {
      token.cancelled = true;
      progress.close('cancel');
      toast('MP3 export cancelled', 'info');
    };
    prepared = await prepareExport(book, scope, state);
    if (token.cancelled) return;

    const bitrate = chooseBitrate(prepared.seconds);
    const estimatedMb = Math.round((prepared.seconds * bitrate * 1000) / 8 / (1024 * 1024));
    if (estimatedMb > 350) {
      progress.close('size-warning');
      progress = null;
      const proceed = await confirmDialog({
        title: 'Create a large MP3?',
        message: `This book contains about ${formatDuration(prepared.seconds)} of speech and will produce roughly ${estimatedMb} MB at ${bitrate} kbps. The source EPUB/PDF may be small; MP3 size depends on its spoken length. Piper generates audio on this device, so it can take hours. Progress resumes after a reload.`,
        confirmLabel: `Create ${estimatedMb} MB MP3`,
        cancelLabel: 'Cancel',
        danger: false,
      });
      if (!proceed) return;
      progress = progressModal({ title: 'Creating the MP3', status: 'Preparing the fast voice…' });
      token = { cancelled: false };
      progress.bodyEl.querySelector('[data-cancel-book-audio]').onclick = () => {
        token.cancelled = true;
        progress.close('cancel');
        toast('MP3 export cancelled', 'info');
      };
    }

    const job = await createJob(book, prepared.chapters, prepared.totalSentences, prepared.seconds, { scope, voiceId, speaker });
    await runWithModal(job, prepared.chapters, { progress, token });
    progress = null;
  } catch (err) {
    if (progress) progress.close('error');
    if (!token?.cancelled) toast(err.message || 'Could not start the audio export.', 'err');
  } finally {
    if (prepared) disposeBuilt(prepared);
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
        const prepared = await prepareExport(book, job.scope || 'book');
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
        onAction: () => { showReady(ready).catch(err => toast(err.message || 'Could not open the MP3.', 'err')); },
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
