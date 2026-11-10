/* Local audiobook export. Renders chapters with the selected Piper voice
   and downloads them as WAV files in a zip with an M3U playlist. */

import { piperGenerate, piperVoiceById, cleanForSpeech } from './tts.js';
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

function safeName(name, fallback = 'chapter') {
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

function encodeMp3(parts, fmt) {
  const lame = window.lamejs;
  if (!lame?.Mp3Encoder) return null;
  const channels = Math.max(1, Math.min(2, fmt.channels || 1));
  const encoder = new lame.Mp3Encoder(channels, fmt.sampleRate, 128);
  const chunks = [];
  const block = 1152;
  for (const part of parts) {
    const copy = new Uint8Array(part.length);
    copy.set(part);
    const samples = new Int16Array(copy.buffer, 0, Math.floor(copy.length / 2));
    for (let i = 0; i < samples.length; i += block) {
      const encoded = encoder.encodeBuffer(samples.subarray(i, Math.min(i + block, samples.length)));
      if (encoded.length) chunks.push(new Uint8Array(encoded));
    }
  }
  const end = encoder.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: 'audio/mpeg' });
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

export async function createAudiobook(state, { scope = 'book', onProgress = () => {}, token = { cancelled: false } } = {}) {
  const tts = getPrefs().tts;
  if (tts.provider !== 'piper') throw new Error('Choose a Piper voice before creating an audiobook.');
  const voice = piperVoiceById(tts.piperVoice);
  const chapters = audiobookChapters(state, scope);
  if (!chapters.length) throw new Error('This book has no readable chapters.');

  if (state.mode === 'pdf') {
    for (const chapter of chapters) {
      const sentences = await state.pdfView.getPageSentences(chapter.pdfPage);
      chapter.text = sentences.map(s => s.text).join(' ');
    }
  }
  const prepared = chapters.map(chapter => ({ ...chapter, sentences: sentenceList(chapter.text) })).filter(c => c.sentences.length);
  if (!prepared.length) throw new Error('No readable text was found for the audiobook.');
  const totalSentences = prepared.reduce((sum, c) => sum + c.sentences.length, 0);

  const JSZipCtor = window.JSZip;
  if (!JSZipCtor) throw new Error('The zip library did not load. Reload the page and try again.');
  const zip = new JSZipCtor();
  const entries = [];
  let done = 0;
  const speaker = Number(tts.piperSpeaker) || 0;

  for (let ci = 0; ci < prepared.length; ci++) {
    const chapter = prepared[ci];
    const parts = [];
    let fmt = null;
    for (const sentence of chapter.sentences) {
      if (token.cancelled) throw new Error('Audiobook creation cancelled.');
      const blob = await piperGenerate(sentence, voice.id, speaker);
      const wav = await readWav(blob);
      fmt = fmt || wav.fmt;
      parts.push(wav.data);
      done++;
      onProgress({ phase: 'generating', percent: Math.round((done / totalSentences) * 90), chapter: ci + 1, chapters: prepared.length, sentence: done, sentences: totalSentences });
    }
    const blockAlign = Math.max(1, Math.round(fmt.channels * fmt.bits / 8));
    const totalBytes = parts.reduce((sum, part) => sum + part.length, 0);
    const duration = totalBytes / Math.max(1, fmt.sampleRate * blockAlign);
    const mp3 = encodeMp3(parts, fmt);
    const number = String(ci + 1).padStart(2, '0');
    const ext = mp3 ? 'mp3' : 'wav';
    const file = `${number} - ${safeName(chapter.title)}.${ext}`;
    zip.file(file, mp3 || joinWav(parts, fmt).blob);
    entries.push({ title: chapter.title, file, seconds: Math.round(duration) });
    onProgress({ phase: 'chapter', percent: Math.round(((ci + 1) / prepared.length) * 92), chapter: ci + 1, chapters: prepared.length });
  }

  const bookTitle = state.record?.title || state.book?.title || 'Audiobook';
  zip.file('chapters.json', JSON.stringify({
    app: 'Alya’s Reader',
    title: bookTitle,
    author: state.record?.author || '',
    voice: `${voice.name}${voice.num_speakers > 1 ? ` · ${speaker}` : ''}`,
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
  };
}
