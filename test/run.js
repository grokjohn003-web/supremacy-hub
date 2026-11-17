'use strict';
// Run with: npm test   (starts the server on a spare port and checks it end to end)
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const zlib = require('zlib');
const { analyse, parseFrameAncestors, isPrivateIp, check } = require('../lib/frame-check');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1; }
}
const H = (o) => new Headers(o);
const hub = new URL('https://hub.example.com');
const target = new URL('https://www.game.com/');

(async () => {
  console.log('frame analysis');
  await t('no headers → frameable', () => assert.strictEqual(analyse(H({}), target, hub).frameable, true));
  await t('XFO DENY → blocked', () => assert.strictEqual(analyse(H({ 'x-frame-options': 'DENY' }), target, hub).frameable, false));
  await t('XFO SAMEORIGIN → blocked cross-origin', () => assert.strictEqual(analyse(H({ 'x-frame-options': 'sameorigin' }), target, hub).frameable, false));
  await t('XFO ALLOW-FROM is ignored by browsers → frameable', () => assert.strictEqual(analyse(H({ 'x-frame-options': 'ALLOW-FROM https://x.com' }), target, hub).frameable, true));
  await t("CSP frame-ancestors 'self' → blocked", () => assert.strictEqual(analyse(H({ 'content-security-policy': "default-src *; frame-ancestors 'self'" }), target, hub).frameable, false));
  await t('CSP frame-ancestors * → frameable even with XFO', () => assert.strictEqual(analyse(H({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' }), target, hub).frameable, true));
  await t('CSP wildcard host match', () => assert.strictEqual(analyse(H({ 'content-security-policy': 'frame-ancestors https://*.example.com' }), target, hub).frameable, true));
  await t('CSP host mismatch → blocked', () => assert.strictEqual(analyse(H({ 'content-security-policy': 'frame-ancestors https://other.com' }), target, hub).frameable, false));
  await t('multiple CSP policies all enforced', () => assert.strictEqual(analyse(H({ 'content-security-policy': "frame-ancestors *, frame-ancestors 'none'" }), target, hub).frameable, false));
  await t('parse frame-ancestors', () => assert.deepStrictEqual(parseFrameAncestors("a; frame-ancestors 'self' https://X.com"), [["'self'", 'https://x.com']]));

  console.log('network safety');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) {
    await t(`${ip} is private`, () => assert.ok(isPrivateIp(ip)));
  }
  await t('8.8.8.8 is public', () => assert.ok(!isPrivateIp('8.8.8.8')));
  for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'https://intranet/', 'ftp://example.com/', 'https://example.com:8443/', 'https://user:pw@example.com/']) {
    await t(`check refuses ${u}`, async () => {
      await assert.rejects(check(u, 'https://hub.example.com'), (e) => e.status === 400 || e.status === 403);
    });
  }

  console.log('server');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.once('data', r));
  const base = `http://127.0.0.1:${port}`;
  try {
    await t('GET / serves the app with security headers', async () => {
      const r = await fetch(`${base}/`);
      assert.strictEqual(r.status, 200);
      assert.match(await r.text(), /Supremacy Hub/);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    });
    await t('static files are brotli compressed and support 304', async () => {
      const http = require('http');
      const res = await new Promise((resolve) => http.get(`${base}/app.js`, { headers: { 'accept-encoding': 'br' } }, resolve));
      assert.strictEqual(res.headers['content-encoding'], 'br');
      const chunks = []; for await (const c of res) chunks.push(c);
      const body = zlib.brotliDecompressSync(Buffer.concat(chunks)).toString();
      assert.match(body, /Supremacy Hub/);
      const r2 = await fetch(`${base}/app.js`, { headers: { 'if-none-match': res.headers.etag } });
      assert.strictEqual(r2.status, 304);
    });
    await t('path traversal is refused', async () => {
      const r = await fetch(`${base}/..%2fserver.js`);
      assert.ok(r.status === 403 || r.status === 404);
    });
    await t('unknown routes fall back to the app shell', async () => {
      const r = await fetch(`${base}/games/whatever`);
      assert.match(await r.text(), /<title>Supremacy Hub/);
    });
    await t('/api/health', async () => {
      const r = await fetch(`${base}/api/health`);
      assert.strictEqual((await r.json()).ok, true);
    });
    await t('/api/check rejects missing url', async () => {
      const r = await fetch(`${base}/api/check`);
      assert.strictEqual(r.status, 400);
    });
    await t('/api/check refuses private targets', async () => {
      const r = await fetch(`${base}/api/check?url=${encodeURIComponent('http://127.0.0.1:22/')}`);
      assert.ok([400, 403].includes(r.status));
    });
  } finally {
    srv.kill();
  }
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
