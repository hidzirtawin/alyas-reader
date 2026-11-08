#!/usr/bin/env node
/* Alya’s Reader — a zero-dependency local server.
   Serves the app and proxies optional neural-voice requests so browser
   API keys are never exposed to CORS workarounds or third-party pages. */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self' https://api.openai.com https://api.elevenlabs.io http://127.0.0.1:51730 http://localhost:51730",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

/* ── Static files ─────────────────────────────────────────────────── */

function safePath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const resolved = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) return null;
  return resolved;
}

async function serveStatic(req, res, urlPath) {
  let filePath = safePath(urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath) return send(res, 403, 'Forbidden');

  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fsp.stat(filePath);
    }
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!stat.isFile()) return send(res, 404, 'Not found');

  const ext = path.extname(filePath).toLowerCase();
  const immutable = urlPath.startsWith('/vendor/') || urlPath.startsWith('/fonts/');
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}

function send(res, status, text, extra = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(text);
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/* ── Request helpers ──────────────────────────────────────────────── */

function readBody(req, limit = 600 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('Request body is too large.');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { const e = new Error('Invalid JSON body.'); e.status = 400; reject(e); }
    });
    req.on('error', reject);
  });
}

function httpsRequest({ hostname, path: reqPath, method = 'POST', headers, body, timeout = 65000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, method, headers }, resolve);
    req.setTimeout(timeout, () => req.destroy(new Error('The voice service took too long to respond.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function localRequest({ hostname = '127.0.0.1', port = 51730, path: reqPath, method = 'GET', headers, body, timeout = 45000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: reqPath, method, headers }, resolve);
    req.setTimeout(timeout, () => req.destroy(new Error('Out Loud took too long to respond.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function collect(stream, limit = 16 * 1024) {
  return new Promise(resolve => {
    let text = '';
    let size = 0;
    stream.on('data', chunk => {
      size += chunk.length;
      if (size <= limit) text += chunk.toString('utf8');
    });
    stream.on('end', () => resolve(text));
    stream.on('error', () => resolve(text));
  });
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, limit) {
  return String(value || '').replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/* ── Neural voice proxy ──────────────────────────────────────────── */

const OPENAI_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);
const OPENAI_MODELS = new Set(['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1']);
const ELEVEN_MODELS = new Set(['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_v3']);

async function handleTTS(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Use POST.' });

  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host || '';
    const allowed = new Set([`http://${host}`, `https://${host}`]);
    if (!allowed.has(origin)) return sendJSON(res, 403, { error: 'Cross-origin requests are not allowed.' });
  }

  let payload;
  try { payload = await readBody(req); }
  catch (err) { return sendJSON(res, err.status || 400, { error: err.message }); }

  const provider = String(payload.provider || '').toLowerCase();
  const key = String(payload.key || '').trim();
  const text = cleanText(payload.text, provider === 'elevenlabs' ? 5000 : 4000);
  const speed = clampNumber(payload.speed, 0.25, 4, 1);
  const isOutLoud = provider === 'outloud';

  if (!isOutLoud && (!key || key.length < 12 || key.length > 300 || /[\s]/.test(key))) {
    return sendJSON(res, 400, { error: 'Add a valid API key in Voice settings.' });
  }
  if (!text) return sendJSON(res, 400, { error: 'There is no text to read.' });

  try {
    if (provider === 'outloud') {
      const voice = String(payload.voice || 'af_heart').trim();
      if (!/^[A-Za-z0-9_*+.\- ]{1,200}$/.test(voice)) {
        return sendJSON(res, 400, { error: 'Choose a valid Out Loud voice.' });
      }
      const body = JSON.stringify({
        voice,
        input: text,
        speed: clampNumber(payload.speed, 0.5, 2, 1),
        response_format: 'mp3',
      });
      let upstream;
      try {
        upstream = await localRequest({
          path: '/api/v1/audio/speech',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Accept': 'audio/mpeg',
          },
          body,
          timeout: 90000,
        });
      } catch {
        return sendJSON(res, 503, { error: 'Out Loud isn’t running. Open the Out Loud app, then try again.' });
      }
      return pipeAudio(upstream, res, 'Out Loud');
    }

    if (provider === 'openai') {
      const voice = OPENAI_VOICES.has(payload.voice) ? payload.voice : 'nova';
      const model = OPENAI_MODELS.has(payload.model) ? payload.model : 'gpt-4o-mini-tts';
      const body = {
        model,
        voice,
        input: text,
        speed,
        response_format: 'mp3',
      };
      if (model === 'gpt-4o-mini-tts' && payload.instructions) {
        body.instructions = cleanText(payload.instructions, 600);
      }
      const upstream = await httpsRequest({
        hostname: 'api.openai.com',
        path: '/v1/audio/speech',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(JSON.stringify(body)),
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify(body),
      });
      return pipeAudio(upstream, res, 'OpenAI');
    }

    if (provider === 'elevenlabs') {
      const voiceId = /^[A-Za-z0-9_-]{8,64}$/.test(String(payload.voice || '')) ? String(payload.voice) : '';
      if (!voiceId) return sendJSON(res, 400, { error: 'Choose a valid ElevenLabs voice.' });
      const model = ELEVEN_MODELS.has(payload.model) ? payload.model : 'eleven_multilingual_v2';
      const body = {
        text,
        model_id: model,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0.15,
          use_speaker_boost: true,
        },
      };
      const upstream = await httpsRequest({
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        headers: {
          'xi-api-key': key,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(JSON.stringify(body)),
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify(body),
      });
      return pipeAudio(upstream, res, 'ElevenLabs');
    }

    return sendJSON(res, 400, { error: 'Choose a voice provider first.' });
  } catch (err) {
    console.error('[tts]', provider, err.message);
    return sendJSON(res, 502, { error: err.message || 'The voice service could not be reached.' });
  }
}

async function pipeAudio(upstream, res, label) {
  const status = upstream.statusCode || 502;
  if (status < 200 || status >= 300) {
    const raw = await collect(upstream);
    let message = `${label} returned an error (${status}).`;
    try {
      const data = JSON.parse(raw);
      const detail = data?.error?.message || data?.detail?.message || data?.detail || data?.message || (typeof data?.error === 'string' ? data.error : null);
      if (typeof detail === 'string' && detail.trim()) message = detail.trim().slice(0, 400);
    } catch {
      if (raw && raw.length < 300 && !raw.includes('<')) message = raw.trim();
    }
    if (status === 401 || status === 403) message = `${label}: the API key was rejected. Check it and try again.`;
    if (status === 429) message = `${label}: rate limit or allowance reached. Try again later.`;
    return sendJSON(res, 502, { error: message });
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': upstream.headers['content-type'] || 'audio/mpeg',
    'Cache-Control': 'no-store',
  });
  upstream.pipe(res);
  upstream.on('error', () => res.destroy());
  res.on('close', () => { try { upstream.destroy(); } catch {} });
}

async function handleOutLoudVoices(req, res) {
  if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Use GET.' });
  try {
    const upstream = await localRequest({
      path: '/api/v1/audio/voices',
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 4000,
    });
    if ((upstream.statusCode || 500) >= 400) {
      return sendJSON(res, 503, { error: 'Out Loud is not ready yet.' });
    }
    const raw = await collect(upstream, 2 * 1024 * 1024);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(raw);
  } catch {
    return sendJSON(res, 503, { error: 'Out Loud is not running on port 51730. Open the Out Loud app first.' });
  }
}

/* ── Server ──────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    return send(res, 400, 'Bad request');
  }

  if (urlPath === '/api/health') return sendJSON(res, 200, { ok: true, app: "Alya's Reader" });
  if (urlPath === '/api/tts') return handleTTS(req, res);
  if (urlPath === '/api/outloud/voices') return handleOutLoudVoices(req, res);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }
  return serveStatic(req, res, urlPath);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Try:  PORT=${PORT + 1} npm start\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('');
  console.log('  Alya’s Reader');
  console.log('  ─────────────');
  console.log('  Your reading room is ready.');
  console.log('');
  console.log(`  http://${shownHost}:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop. Your books stay in this browser.');
  console.log('');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
