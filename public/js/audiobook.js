/* Local audiobook export. Renders with the selected Piper voice and
   downloads either one MP3 file or MP3 chapters in a zip with a playlist. */

import { piperGenerate, piperVoiceById, piperSpeakerName, cleanForSpeech } from './tts.js';
import { getPrefs } from './prefs.js';
import { detectSentenceSegments } from './util.js';

function stripHtml(html = '') {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  holder.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,blockquote').forEach(el => el.append(document.createTextNode(' ')));
  return holder.textContent.replace(/\s+/g, ' ').trim();
}

function sentenceList(text) {
  return detectSentenceSegments(text)
    .map(seg => cleanForSpeech(seg.text.trim()))
    .filter(line => line.length > 1)
    .filter(line => /[\p{L}\p{N}]/u.test(line))
    .filter(line => !/^\s*(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)]?\s*$/i.test(line));
}

export function safeName(name, fallback = 'chapter') {
  return (name || fallback).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || fallback;
}

async function readWav(blob) {
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      fmt = {
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bits: view.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      data = new Uint8Array(buffer, offset + 8, Math.min(size, buffer.byteLength - offset - 8));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('A generated chapter was not valid WAV audio.');
  return { fmt, data };
}

class Mp3StreamEncoder {
  constructor(fmt, bitrate = 128) {
    const lame = window.lamejs;
    if (!lame?.Mp3Encoder) throw new Error('The MP3 encoder did not load. Reload the page and try again.');
    this.channels = Math.max(1, Math.min(2, fmt.channels || 1));
    this.encoder = new lame.Mp3Encoder(this.channels, fmt.sampleRate, bitrate);
    this.chunks = [];
    this.block = 1152;
  }

  push(bytes) {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const samples = new Int16Array(copy.buffer, 0, Math.floor(copy.length / 2));
    for (let i = 0; i < samples.length; i += this.block) {
      const encoded = this.encoder.encodeBuffer(samples.subarray(i, Math.min(i + this.block, samples.length)));
      if (encoded.length) this.chunks.push(new Uint8Array(encoded));
    }
  }

  finish() {
    const end = this.encoder.flush();
    if (end.length) this.chunks.push(new Uint8Array(end));
    return new Blob(this.chunks, { type: 'audio/mpeg' });
  }
}

function encodeMp3(parts, fmt, bitrate = 128) {
  if (!window.lamejs?.Mp3Encoder) return null;
  const encoder = new Mp3StreamEncoder(fmt, bitrate);
  for (const part of parts) encoder.push(part);
  return encoder.finish();
}

function joinWav(parts, fmt) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(44 + total);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  const blockAlign = Math.max(1, Math.round(fmt.channels * fmt.bits / 8));
  const byteRate = fmt.sampleRate * blockAlign;
  write(0, 'RIFF'); view.setUint32(4, 36 + total, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, fmt.channels, true);
  view.setUint32(24, fmt.sampleRate, true); view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, fmt.bits, true);
  write(36, 'data'); view.setUint32(40, total, true);
  let at = 44;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return {
    blob: new Blob([bytes], { type: 'audio/wav' }),
    duration: total / Math.max(1, byteRate),
  };
}

export function audiobookChapters(state, scope = 'book') {
  if (state.mode === 'pdf') {
    const pages = scope === 'chapter' ? [state.page || 1] : Array.from({ length: state.numPages || 0 }, (_, i) => i + 1);
    return pages.map(page => ({ title: `Page ${page}`, pdfPage: page, text: '' }));
  }
  if (!state.book?.chapters?.length) return [];
  const indexes = scope === 'chapter' ? [state.chapterIndex] : state.book.chapters.map((_, i) => i);
  return indexes.map(i => ({
    title: state.book.chapters[i].label || `Chapter ${i + 1}`,
    chapterIndex: i,
    text: stripHtml(state.book.chapters[i].html || ''),
  }));
}

export async function prepareAudiobook(state, scope = 'book') {
  const chapters = audiobookChapters(state, scope);
  if (!chapters.length) throw new Error('This book has no readable chapters.');
  if (state.mode === 'pdf') {
    for (const chapter of chapters) {
      const sentences = await state.pdfView.getPageSentences(chapter.pdfPage);
      chapter.text = sentences.map(s => s.text).join(' ');
    }
  }
  const prepared = chapters
    .map(chapter => ({ ...chapter, sentences: sentenceList(chapter.text) }))
    .filter(chapter => chapter.sentences.length);
  if (!prepared.length) throw new Error('No readable text was found for the audiobook.');
  return prepared;
}

/* Encode one generated WAV sentence as an independent MP3 stream. Keeping
   each sentence separate lets a long export resume without holding the whole
   book in memory. */
export async function sentenceMp3(wavBlob, bitrate = 128) {
  const wav = await readWav(wavBlob);
  const blockAlign = Math.max(1, Math.round(wav.fmt.channels * wav.fmt.bits / 8));
  const seconds = wav.data.length / Math.max(1, wav.fmt.sampleRate * blockAlign);
  if (!window.lamejs?.Mp3Encoder) throw new Error('The MP3 encoder did not load. Reload the page and try again.');
  const encoder = new Mp3StreamEncoder(wav.fmt, bitrate);
  encoder.push(wav.data);
  return { blob: encoder.finish(), seconds };
}

export async function renderSentenceMp3(text, voiceId, speaker, bitrate = 128) {
  const wav = await piperGenerate(text, voiceId, speaker);
  return sentenceMp3(wav, bitrate);
}

export async function createAudiobook(state, {
  scope = 'book', format = 'mp3', voiceId = null, speaker = null, onProgress = () => {}, token = { cancelled: false },
} = {}) {
  const tts = getPrefs().tts;
  if (tts.provider !== 'piper') throw new Error('Choose a Piper voice before creating an audiobook.');
  const voice = piperVoiceById(voiceId || tts.piperVoice);
  const speakerId = Number.isFinite(Number(speaker))
    ? Math.max(0, Math.min(Number(speaker), Math.max(0, voice.num_speakers - 1)))
    : (Number(tts.piperSpeaker) || 0);
  const prepared = await prepareAudiobook(state, scope);
  const totalSentences = prepared.reduce((sum, c) => sum + c.sentences.length, 0);

  const single = format === 'mp3';
  const mp3Available = Boolean(window.lamejs?.Mp3Encoder);
  const JSZipCtor = window.JSZip;
  if (!single && !JSZipCtor) throw new Error('The zip library did not load. Reload the page and try again.');
  const zip = single ? null : new JSZipCtor();
  const entries = [];
  const singleParts = [];
  let singleEncoder = null;
  let singlePcmBytes = 0;
  let singleFmt = null;
  let done = 0;

  for (let ci = 0; ci < prepared.length; ci++) {
    const chapter = prepared[ci];
    const parts = single ? null : [];
    let fmt = null;
    for (const sentence of chapter.sentences) {
      if (token.cancelled) throw new Error('Audiobook creation cancelled.');
      const blob = await piperGenerate(sentence, voice.id, speakerId);
      const wav = await readWav(blob);
      fmt = fmt || wav.fmt;
      if (single) {
        singleFmt ||= wav.fmt;
        singlePcmBytes += wav.data.length;
      }
      if (single && mp3Available) {
        singleEncoder ||= new Mp3StreamEncoder(fmt);
        singleEncoder.push(wav.data);
      } else if (single) {
        singleParts.push(wav.data);
      } else {
        parts.push(wav.data);
      }
      done++;
      onProgress({ phase: 'generating', percent: Math.round((done / totalSentences) * 90), chapter: ci + 1, chapters: prepared.length, sentence: done, sentences: totalSentences });
    }
    const blockAlign = Math.max(1, Math.round(fmt.channels * fmt.bits / 8));
    if (!single) {
      const totalBytes = parts.reduce((sum, part) => sum + part.length, 0);
      const duration = totalBytes / Math.max(1, fmt.sampleRate * blockAlign);
      const mp3 = encodeMp3(parts, fmt);
      const number = String(ci + 1).padStart(2, '0');
      const ext = mp3 ? 'mp3' : 'wav';
      const file = `${number} - ${safeName(chapter.title)}.${ext}`;
      zip.file(file, mp3 || joinWav(parts, fmt).blob);
      entries.push({ title: chapter.title, file, seconds: Math.round(duration) });
    }
    onProgress({ phase: 'chapter', percent: Math.round(((ci + 1) / prepared.length) * 92), chapter: ci + 1, chapters: prepared.length });
  }

  const bookTitle = state.record?.title || state.book?.title || 'Audiobook';
  const voiceLabel = `${voice.name}${voice.num_speakers > 1 ? ` · ${piperSpeakerName(voice, speakerId)}` : ''}`;
  const chapterSuffix = scope === 'chapter' && prepared[0]?.title ? ` - ${safeName(prepared[0].title)}` : '';

  if (single) {
    onProgress({ phase: 'encoding', percent: 94 });
    let blob;
    let ext;
    const outFmt = singleFmt || fmt;
    const outBlock = Math.max(1, Math.round(outFmt.channels * outFmt.bits / 8));
    const seconds = singlePcmBytes / Math.max(1, outFmt.sampleRate * outBlock);
    if (mp3Available) {
      blob = singleEncoder.finish();
      ext = 'mp3';
    } else {
      blob = joinWav(singleParts, outFmt).blob;
      ext = 'wav';
    }
    onProgress({ phase: 'done', percent: 100 });
    return {
      blob,
      filename: `${safeName(bookTitle, 'audiobook')}${chapterSuffix}.${ext}`,
      chapters: prepared.length,
      sentences: totalSentences,
      voice: voiceLabel,
      format: ext,
      duration: seconds,
    };
  }

  zip.file('chapters.json', JSON.stringify({
    app: 'Alya’s Reader',
    title: bookTitle,
    author: state.record?.author || '',
    voice: voiceLabel,
    createdAt: new Date().toISOString(),
    chapters: entries,
  }, null, 2));
  zip.file('playlist.m3u', ['#EXTM3U', ...entries.map(e => `#EXTINF:${e.seconds},${e.title}\n${e.file}`)].join('\n'));
  zip.file('README.txt', `Audiobook export from Alya’s Reader\nVoice: ${voice.name}\nCreated: ${new Date().toISOString()}\n\n${window.lamejs ? 'MP3 chapter files with an M3U playlist.' : 'WAV chapter files with an M3U playlist.'}\n`);

  onProgress({ phase: 'packing', percent: 92 });
  const out = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, meta => {
    onProgress({ phase: 'packing', percent: 92 + Math.round(meta.percent * 0.08) });
  });
  onProgress({ phase: 'done', percent: 100 });
  return {
    blob: out,
    filename: `${safeName(bookTitle, 'audiobook')}.zip`,
    chapters: entries.length,
    sentences: totalSentences,
    voice: voiceLabel,
    format: 'zip',
  };
}
