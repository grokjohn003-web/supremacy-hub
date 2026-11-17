'use strict';
// Vercel serverless version of /api/check (same logic as server.js).
const { handleCheck } = require('../lib/frame-check');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const { status, body } = await handleCheck(url.searchParams, `${proto}://${req.headers.host}`);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', status === 200 ? 'private, max-age=300' : 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
};
