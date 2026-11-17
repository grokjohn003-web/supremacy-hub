#!/usr/bin/env node
'use strict';
/**
 * Supremacy Hub server: no dependencies, Node 18+.
 *  - Serves /public with brotli/gzip, ETags and 304s (small transfers on slow links)
 *  - GET /api/check?url=...  → can this site be embedded in a frame?
 *  - GET /api/health         → liveness, used by the client's connection indicator
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { handleCheck } = require('./lib/frame-check');

if (typeof fetch !== 'function') {
  console.error('Supremacy Hub needs Node.js 18 or newer (global fetch).');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const RATE_LIMIT = Number(process.env.CHECK_RATE_LIMIT) || 60; // checks per IP per minute

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt']);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    'frame-src https: http:',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

// In-memory static cache with pre-compressed variants, invalidated on mtime change.
const fileCache = new Map();
function loadStatic(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const cached = fileCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) return cached;
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath);
  const entry = {
    mtime: stat.mtimeMs,
    type: MIME[ext] || 'application/octet-stream',
    etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`,
    raw,
    br: null,
    gzip: null,
  };
  if (COMPRESSIBLE.has(ext) && raw.length > 512) {
    entry.br = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    });
    entry.gzip = zlib.gzipSync(raw, { level: 9 });
  }
  fileCache.set(filePath, entry);
  return entry;
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(req, res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  const accepts = req.headers['accept-encoding'] || '';
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra };
  if (/\bgzip\b/.test(accepts) && body.length > 256) {
    headers['content-encoding'] = 'gzip';
    headers.vary = 'Accept-Encoding';
    return send(res, status, headers, zlib.gzipSync(body));
  }
  send(res, status, headers, body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, {}, 'Forbidden');

  let entry = loadStatic(filePath);
  // Unknown paths without an extension are app routes: serve the shell.
  if (!entry && !path.extname(rel)) entry = loadStatic(path.join(PUBLIC_DIR, 'index.html'));
  if (!entry) return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found');

  const name = path.basename(filePath);
  const headers = {
    'content-type': entry.type,
    etag: entry.etag,
    vary: 'Accept-Encoding',
    // Revalidate cheaply (304) so updates arrive; the service worker covers offline.
    'cache-control': name === 'icon.svg' ? 'public, max-age=86400' : 'no-cache',
  };
  if (name === 'sw.js') headers['service-worker-allowed'] = '/';

  if (req.headers['if-none-match'] === entry.etag) return send(res, 304, headers);

  const accepts = req.headers['accept-encoding'] || '';
  let body = entry.raw;
  if (entry.br && /\bbr\b/.test(accepts)) {
    body = entry.br;
    headers['content-encoding'] = 'br';
  } else if (entry.gzip && /\bgzip\b/.test(accepts)) {
    body = entry.gzip;
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = body.length;
  send(res, 200, headers, req.method === 'HEAD' ? undefined : body);
}

// Simple fixed-window rate limiter for /api/check.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > 60_000) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, rec] of hits) if (rec.start < cutoff) hits.delete(ip);
}, 60_000).unref();

function requestOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    return send(res, 400, {}, 'Bad request');
  }

  if (url.pathname === '/api/health') {
    return sendJson(req, res, 200, { ok: true, time: Date.now() });
  }

  if (url.pathname === '/api/check') {
    if (req.method !== 'GET') return sendJson(req, res, 405, { ok: false, error: 'Method not allowed' });
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      return sendJson(req, res, 429, { ok: false, error: 'Too many checks, try again in a minute' }, { 'retry-after': '30' });
    }
    const { status, body } = await handleCheck(url.searchParams, requestOrigin(req));
    // Successful verdicts can be reused briefly by the browser cache.
    return sendJson(req, res, status, body, status === 200 ? { 'cache-control': 'private, max-age=300' } : {});
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {}, 'Method not allowed');
  serveStatic(req, res, url.pathname);
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, HOST, () => {
  console.log(`Supremacy Hub running at http://localhost:${PORT}`);
});
