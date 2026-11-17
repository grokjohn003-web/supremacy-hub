/* Supremacy Hub service worker: keeps the app usable on poor or no connection. */
'use strict';
const VERSION = 'sh-v1.0.1';
const SHELL_CACHE = `${VERSION}-shell`;
const CHECK_CACHE = 'sh-checks';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];
const API_TIMEOUT = 12000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.endsWith('-shell') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

// Embed checks: network first (with a timeout), fall back to the last good answer.
async function handleCheck(request) {
  const cache = await caches.open(CHECK_CACHE);
  try {
    const res = await Promise.race([fetch(request), timeout(API_TIMEOUT)]);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

// App shell: answer from cache immediately, refresh in the background.
async function handleShell(event) {
  const { request } = event;
  const cache = await caches.open(SHELL_CACHE);
  const key = request.mode === 'navigate' ? '/index.html' : request;
  const hit = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
  const refresh = fetch(request).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(key, res.clone());
    return res;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => {}));
    return hit;
  }
  return refresh.catch(async () => (await cache.match('/index.html')) || Response.error());
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch game traffic
  if (url.pathname === '/api/health') return;      // always live
  if (url.pathname === '/api/check') { event.respondWith(handleCheck(request)); return; }
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(handleShell(event));
});
