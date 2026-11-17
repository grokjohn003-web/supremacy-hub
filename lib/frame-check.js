'use strict';
/**
 * Frame check: asks a remote site (server-side) whether it allows itself to be
 * shown inside an <iframe> on the hub's origin, by reading its
 * X-Frame-Options and Content-Security-Policy frame-ancestors headers.
 *
 * Browsers hide this information from page scripts, so without this check the
 * hub could only show a blank frame when a site refuses embedding.
 */
const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 500;
const cache = new Map();

class CheckError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

// Refuse anything that is not a public web host (prevents the check endpoint
// being used to probe the server's own network).
async function assertPublic(url) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CheckError(400, 'Only http and https addresses are supported');
  }
  if (url.username || url.password) throw new CheckError(400, 'Addresses with credentials are not supported');
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new CheckError(400, 'Non-standard ports are not supported');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new CheckError(403, 'Private network addresses are not allowed');
    return;
  }
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|home)$/i.test(host)) {
    throw new CheckError(403, 'Private network addresses are not allowed');
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new CheckError(502, `Could not find ${host} (DNS lookup failed)`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new CheckError(403, 'Private network addresses are not allowed');
  }
}

function parseFrameAncestors(csp) {
  if (!csp) return null;
  const lists = [];
  // Several CSP headers arrive comma-joined; every policy is enforced.
  for (const policy of csp.split(',')) {
    for (const directive of policy.split(';')) {
      const parts = directive.trim().split(/\s+/).filter(Boolean);
      if (parts.length && parts[0].toLowerCase() === 'frame-ancestors') {
        lists.push(parts.slice(1).map((s) => s.toLowerCase()));
      }
    }
  }
  return lists.length ? lists : null;
}

function sourceAllows(src, hub, target) {
  if (src === '*') return true;
  if (src === "'none'") return false;
  if (src === "'self'") return hub.origin === target.origin;
  if (/^[a-z][a-z0-9+.-]*:$/.test(src)) return hub.protocol === src;
  const m = src.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:]+)(?::(\d+|\*))?/);
  if (!m) return false;
  const [, scheme, hostPat, port] = m;
  if (scheme && `${scheme}:` !== hub.protocol && !(scheme === 'http' && hub.protocol === 'https:')) return false;
  const h = hub.hostname.toLowerCase();
  if (hostPat.startsWith('*.')) {
    if (!h.endsWith(hostPat.slice(1))) return false;
  } else if (hostPat !== h) {
    return false;
  }
  if (port && port !== '*') {
    const hubPort = hub.port || (hub.protocol === 'https:' ? '443' : '80');
    if (port !== hubPort) return false;
  }
  return true;
}

function analyse(headers, target, hub) {
  const lists = parseFrameAncestors(headers.get('content-security-policy'));
  if (lists) {
    for (const list of lists) {
      if (!list.some((s) => sourceAllows(s, hub, target))) {
        return {
          frameable: false,
          reason: `The site only allows itself to be embedded by: ${list.join(' ') || "'none'"}`,
        };
      }
    }
    return { frameable: true, reason: 'The site allows embedding (CSP frame-ancestors).' };
  }
  const xfo = (headers.get('x-frame-options') || '').split(',')[0].trim().toLowerCase();
  if (xfo === 'deny') {
    return { frameable: false, reason: 'The site forbids embedding (X-Frame-Options: DENY).' };
  }
  if (xfo === 'sameorigin' && hub.origin !== target.origin) {
    return { frameable: false, reason: 'The site only allows embedding on its own pages (X-Frame-Options: SAMEORIGIN).' };
  }
  return { frameable: true, reason: 'No embedding restrictions were found.' };
}

async function request(url, method) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SupremacyHub/1.0; +frame-check)',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });
    // Only headers are needed; drop the body straight away to save bandwidth.
    if (res.body) res.body.cancel().catch(() => {});
    return res;
  } catch (e) {
    if (e.name === 'AbortError') throw new CheckError(504, 'The site took too long to respond');
    throw new CheckError(502, 'Could not reach the site');
  } finally {
    clearTimeout(timer);
  }
}

async function run(url, hub) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(current);
    let res = await request(current, 'HEAD');
    // Some servers and CDNs mishandle HEAD; retry those with GET.
    if ([400, 403, 405, 501].includes(res.status)) res = await request(current, 'GET');
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current);
      continue;
    }
    return {
      ok: true,
      url: url.href,
      finalUrl: current.href,
      status: res.status,
      ...analyse(res.headers, current, hub),
      checkedAt: new Date().toISOString(),
    };
  }
  throw new CheckError(502, 'The site redirected too many times');
}

async function check(rawUrl, hubOrigin) {
  let url, hub;
  try {
    url = new URL(rawUrl);
    hub = new URL(hubOrigin);
  } catch {
    throw new CheckError(400, 'That is not a valid address');
  }
  url.hash = '';
  const key = `${url.href}|${hub.origin}`;
  const hit = cache.get(key);
  if (hit) {
    if (hit.promise) return hit.promise; // de-duplicate concurrent checks
    if (Date.now() - hit.at < TTL_MS) return hit.value;
    cache.delete(key);
  }
  const promise = run(url, hub).then(
    (value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    },
    (err) => {
      cache.delete(key);
      throw err;
    }
  );
  cache.set(key, { promise });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return promise;
}

/** Shared HTTP handler used by both server.js and the Vercel function. */
async function handleCheck(searchParams, fallbackOrigin) {
  const target = searchParams.get('url');
  if (!target) return { status: 400, body: { ok: false, error: 'Missing url parameter' } };
  let origin = fallbackOrigin;
  const given = searchParams.get('origin');
  if (given) {
    try {
      origin = new URL(given).origin;
    } catch { /* fall back to request origin */ }
  }
  try {
    return { status: 200, body: await check(target, origin) };
  } catch (e) {
    const status = e instanceof CheckError ? e.status : 500;
    return { status, body: { ok: false, error: e instanceof CheckError ? e.message : 'Check failed' } };
  }
}

module.exports = { check, handleCheck, analyse, parseFrameAncestors, isPrivateIp, CheckError };
