# StratFinder

A lightweight, dark-themed personal start page and browser for a short list of bookmarked sites, plus any site you add.

No build step, no dependencies. The whole client is about 20 KB compressed.

## Run it

Requires Node.js 18 or newer.

```bash
npm start            # or: node server.js
# → http://localhost:8080
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `CHECK_RATE_LIMIT` | `60` | Embed checks allowed per IP per minute |

### Deploy

- **Any Node host** (Render, Railway, Fly.io, a VPS): run `node server.js`. Put it behind HTTPS so offline mode (service worker) is enabled.
- **Vercel**: import the folder as-is. `vercel.json` serves `public/` statically, and `api/check.js` / `api/health.js` run as serverless functions using the same logic as `server.js`.
- **Static-only hosting** also works. Without the API, the hub skips the embed check, tries the frame, and shows an "open in a new tab" fallback.

## What it does

- **Games**: launch cards for the Supremacy titles, plus any sites you add. **Play** embeds the game if the site allows it, otherwise opens it in its own tab. **New tab** always opens a separate tab.
- **Browser panel**: address bar with Back / Forward / Reload / Stop / Home, open-in-new-tab and fullscreen. Only supported domains (and their subdomains) can be opened.
- **Sites**: add or remove supported domains, and change settings: always use a separate tab, slow-load threshold, and resume last page on start.
- **Keyboard**: `Ctrl/⌘+L` focuses the address bar, `Alt+←/→` go back/forward, `Esc` stops loading.

### Embedding: what to expect

Browsers let a website refuse to be shown inside another page (via the `X-Frame-Options` or CSP `frame-ancestors` headers). Page scripts can't see those headers, so the server reads them through `/api/check` and tells the client the result before showing a broken blank frame:

- **Allowed**: the game plays inside the hub.
- **Refused**: the hub explains why and opens the game in its own tab. It then shows the tab's status (Switch to tab / Close tab / Reopen) and notices when the tab is closed.
- **Unknown** (server unreachable): the hub tries the frame and shows a notice with a one-click tab fallback.

The hub never strips or bypasses a site's protections. If you sign in inside the frame and it doesn't stay signed in, your browser is blocking third-party cookies; use **New tab** or turn on *Always open games in a separate tab*.

## Built for bad networks

- **Works offline**: a service worker caches the app shell, so the hub opens instantly with no connection.
- **Navigations queue while offline** and start automatically when the connection returns.
- **Embed check and page load run in parallel**, which saves a round trip on high-latency links.
- **Timeouts and retries**: all API calls use timeouts, retries with jittered exponential backoff, and wait for the connection to return. Timeouts double automatically on 2G / Save-Data / high-latency connections.
- **Slow loads aren't killed.** After the threshold you're offered Keep waiting / Retry / Open in new tab while loading continues.
- **Embed results are cached at three levels**: server for 10 minutes, browser for 12 hours, plus the service worker's last-known answer. A flaky connection means fewer requests.
- **Small transfers**: brotli/gzip, ETag/304 revalidation, system fonts, no images or third-party requests.
- **Running games are never reset** by switching views, and connection drops show a notice rather than reloading the game.
- The **connection pill** shows Online / Slow / Limited / Offline with measured latency. Click it to re-test.

## Customising

Games and built-in domains live at the top of `public/app.js` (`GAMES`, `BUILTIN_DOMAINS`). Add an entry with a name, URL, era label, short code and gradient. After changing files in `public/`, bump `VERSION` in `public/sw.js` so returning visitors get the update; the hub shows an "Update ready" prompt.

## Security notes

- `/api/check` only reads response headers. It refuses private/loopback/link-local addresses, non-standard ports and credentials in URLs, and re-checks every redirect hop. It is rate-limited per IP.
- Embedded pages are sandboxed without `allow-top-navigation`, so they can't take over the hub. Tabs are opened without `window.opener`.
- Strict Content-Security-Policy on the hub itself (no inline script, no third-party resources).

## Tests

```bash
npm test
```

Covers the frame-header analysis, the private-network guard, and the server's static/API behaviour. The UI was also verified end to end in headless Chrome: embedding, refused sites, tab hand-off, back/forward, unsupported and invalid addresses, offline queueing and auto-resume, slow-load handling, stop, settings, persistence, mobile layout, and fully-offline start-up.
