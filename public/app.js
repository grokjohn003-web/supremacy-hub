/* Supremacy Hub — client. No dependencies. */
'use strict';
(() => {
  const VERSION = '1.0.0';
  const CHECK_TTL = 12 * 60 * 60 * 1000;
  const MAX_RECENT = 12;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const GAMES = [
    {
      id: 's1914', name: 'Supremacy 1914', era: 'WWI', mono: '1914', featured: true,
      blurb: 'The original real-time grand strategy game. Lead a nation through the Great War against up to 100 players.',
      url: 'https://www.supremacy1914.com/',
      art: 'linear-gradient(135deg,#40321c 0%,#232637 58%,#10172a 100%)',
    },
    {
      id: 'sww3', name: 'Supremacy: World War 3', era: 'Modern', mono: 'WW3', featured: true,
      blurb: 'Modern warfare on a real-world map, with coalitions, air power and nuclear options. Formerly Conflict of Nations: World War 3.',
      url: 'https://www.conflictnations.com/',
      art: 'linear-gradient(135deg,#173c4d 0%,#16233d 55%,#0e1524 100%)',
    },
    {
      id: 'cow', name: 'Supremacy: Call of War 1942', era: 'WWII', mono: '1942',
      blurb: 'Second World War strategy with research trees, resources and diplomacy.',
      url: 'https://www.callofwar.com/',
      art: 'linear-gradient(135deg,#3b3a24 0%,#1f2434 60%,#10172a 100%)',
    },
    {
      id: 'portal', name: 'Supremacy portal', era: 'Official', mono: 'S',
      blurb: 'Franchise home: news, forums and links to every Supremacy title.',
      url: 'https://www.playsupremacy.com/',
      art: 'linear-gradient(135deg,#26304a 0%,#171d2e 60%,#0e1524 100%)',
    },
  ];
  const BUILTIN_DOMAINS = ['supremacy1914.com', 'conflictnations.com', 'callofwar.com', 'playsupremacy.com', 'bytro.com'];

  /* ---------------- utilities ---------------- */
  const $ = (id) => document.getElementById(id);
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`sh:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`sh:${key}`, JSON.stringify(value)); } catch { /* storage full or blocked */ }
    },
  };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function icon(name) {
    const s = document.createElementNS(SVG_NS, 'svg');
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', `#i-${name}`);
    s.append(u);
    return s;
  }
  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  /* ---------------- state ---------------- */
  const settings = Object.assign({ preferWindow: false, slowAfter: 30, resume: false }, store.get('settings', {}));
  let customDomains = store.get('domains', []);
  let recent = store.get('recent', []);
  let checks = store.get('checks', {});
  const hist = { stack: [], index: -1 };
  const winRefs = new Map(); // host -> { w, url }
  let cur = null;            // current page in the browser panel
  let navSeq = 0;
  let pendingOnline = null;  // navigation queued until the connection returns
  const net = { online: navigator.onLine, backend: 'unknown', rtt: null };

  const els = {
    urlForm: $('urlForm'), urlInput: $('urlInput'), urlField: document.querySelector('.url-field'),
    back: $('btnBack'), fwd: $('btnFwd'), reload: $('btnReload'), home: $('btnHome'),
    popout: $('btnPopout'), full: $('btnFullscreen'), pill: $('netPill'), netText: $('netText'),
    stage: $('stage'), overlay: $('overlay'), progress: $('progress'),
    notice: $('frameNotice'), noticeText: $('frameNoticeText'), toasts: $('toasts'),
  };

  /* ---------------- connection quality ---------------- */
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  function slowLink() {
    if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return true;
    return net.rtt != null && net.rtt > 1200;
  }
  // Give slow links more time before treating a request as failed.
  const scaled = (ms) => (slowLink() ? ms * 2 : ms);

  function waitForOnline(signal) {
    if (navigator.onLine) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { window.removeEventListener('online', done); resolve(); };
      window.addEventListener('online', done);
      signal?.addEventListener('abort', () => { window.removeEventListener('online', done); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
  }

  /** fetch JSON with timeout, retries with jittered exponential backoff, and offline waiting. */
  async function fetchJSON(url, { timeout = 10000, retries = 2, signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      await waitForOnline(signal);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), scaled(timeout));
      const relay = () => ctrl.abort();
      signal?.addEventListener('abort', relay, { once: true });
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
        const data = await res.json().catch(() => null);
        if (res.ok && data) return data;
        const err = new Error(data?.error || `Server returned ${res.status}`);
        err.status = res.status;
        err.final = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
        throw err;
      } catch (e) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (e.final || attempt >= retries) {
          if (e.name === 'AbortError') { const t = new Error('Request timed out'); t.timeout = true; throw t; }
          throw e;
        }
        await sleep(Math.min(8000, 700 * 2 ** attempt) * (0.7 + Math.random() * 0.6), signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', relay);
      }
    }
  }

  /* ---------------- supported sites ---------------- */
  const allDomains = () => [...BUILTIN_DOMAINS, ...customDomains.map((d) => d.domain)];
  function isSupported(host) {
    host = host.toLowerCase().replace(/\.$/, '');
    return allDomains().some((d) => host === d || host.endsWith(`.${d}`));
  }
  function normalise(input) {
    let s = String(input || '').trim();
    if (!s) return { error: 'Enter an address to open.' };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
    let u;
    try { u = new URL(s); } catch { return { error: 'That doesn’t look like a web address.' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only web addresses (https://…) can be opened.' };
    if (!/\./.test(u.hostname)) return { error: 'That doesn’t look like a web address.' };
    // An https page can't frame http content, so upgrade.
    if (u.protocol === 'http:' && location.protocol === 'https:') u.protocol = 'https:';
    if (!isSupported(u.hostname)) return { error: `${u.hostname} isn’t on the supported sites list.`, unsupported: u.hostname };
    return { url: u.href };
  }
  function cleanDomain(input) {
    let s = String(input || '').trim().toLowerCase();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
    let host;
    try { host = new URL(s).hostname; } catch { return null; }
    host = host.replace(/^www\./, '').replace(/\.$/, '');
    return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) ? host : null;
  }
  function addDomain(input) {
    const domain = cleanDomain(input);
    if (!domain) { toast('Enter a valid domain, e.g. example.com', 'err'); return null; }
    if (allDomains().includes(domain)) { toast(`${domain} is already supported.`); return domain; }
    customDomains.push({ domain, addedAt: Date.now() });
    store.set('domains', customDomains);
    renderSites(); renderGames(); renderSuggestions();
    toast(`Added ${domain}`, 'ok');
    return domain;
  }
  function removeDomain(domain) {
    customDomains = customDomains.filter((d) => d.domain !== domain);
    store.set('domains', customDomains);
    renderSites(); renderGames(); renderSuggestions();
    toast(`Removed ${domain}`, 'ok', { label: 'Undo', fn: () => addDomain(domain) });
  }

  /* ---------------- embed checks ---------------- */
  const originOf = (url) => { try { return new URL(url).origin; } catch { return url; } };
  function cachedVerdict(url) {
    const c = checks[originOf(url)];
    return c && Date.now() - c.at < CHECK_TTL ? c : null;
  }
  async function getVerdict(url, signal) {
    const key = originOf(url);
    const fresh = cachedVerdict(url);
    if (fresh) return { ...fresh, cached: true };
    try {
      const q = `/api/check?url=${encodeURIComponent(url)}&origin=${encodeURIComponent(location.origin)}`;
      const d = await fetchJSON(q, { timeout: 9000, retries: 2, signal });
      const v = { frameable: d.frameable, reason: d.reason, at: Date.now() };
      checks[key] = v;
      store.set('checks', checks);
      updateEmbedTags();
      return v;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const old = checks[key];
      if (old) return { ...old, cached: true, stale: true };
      let reason = 'The hub server couldn’t be reached to check this site.';
      if (e.status === 502 || e.status === 504) reason = e.message;
      else if (e.status === 400 || e.status === 403) { const err = new Error(e.message); err.hard = true; throw err; }
      else if (e.timeout) reason = 'The embed check timed out on this connection.';
      return { frameable: null, reason };
    }
  }

  /* ---------------- toasts ---------------- */
  function toast(message, type = '', action = null, timeout = 5000) {
    const el = h('div', { class: `toast ${type}`, role: type === 'err' ? 'alert' : 'status' },
      h('span', { text: message }),
      action && h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { action.fn(); el.remove(); } }, action.label),
      h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Dismiss', onclick: () => el.remove() }, icon('stop')));
    els.toasts.append(el);
    while (els.toasts.children.length > 3) els.toasts.firstChild.remove();
    if (timeout) setTimeout(() => el.remove(), action ? timeout * 1.6 : timeout);
  }

  /* ---------------- views ---------------- */
  let view = 'home';
  function showView(name) {
    view = name;
    for (const v of ['home', 'browser', 'sites']) $(`view-${v}`).hidden = v !== name;
    document.querySelectorAll('.rail-btn').forEach((b) => {
      if (b.dataset.nav === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (name === 'browser' && !cur) renderEmpty();
    if (name === 'home') renderRecent();
    syncHash();
  }
  function syncHash() {
    const hash = view === 'browser' && cur ? `#open=${encodeURIComponent(cur.url)}` : `#${view}`;
    if (location.hash !== hash) {
      try { window.history.replaceState(null, '', hash); } catch { /* sandboxed */ }
    }
  }

  /* ---------------- overlay & progress ---------------- */
  function setOverlay(node, { transparent = false } = {}) {
    els.overlay.replaceChildren(...(node ? [node] : []));
    els.overlay.classList.toggle('transparent', transparent);
  }
  function progress(state) {
    const p = els.progress;
    p.classList.remove('active', 'indeterminate');
    const bar = p.firstElementChild;
    if (state === 'busy') { p.classList.add('indeterminate'); p.setAttribute('aria-hidden', 'false'); }
    else if (state === 'done') {
      p.classList.add('active'); bar.style.width = '100%';
      setTimeout(() => { p.classList.remove('active'); bar.style.width = '0'; }, 450);
      p.setAttribute('aria-hidden', 'true');
    } else { bar.style.width = '0'; p.setAttribute('aria-hidden', 'true'); }
  }
  function showNotice(text) { els.noticeText.textContent = text; els.notice.hidden = false; }
  function hideNotice() { els.notice.hidden = true; }

  function panel({ iconName, tone, title, host, text, detail, extra, actions }) {
    return h('div', { class: 'panel' },
      iconName && h('div', { class: `icon-wrap ${tone || ''}` }, icon(iconName)),
      title && h('h2', { text: title }),
      host && h('div', { class: 'host', text: host }),
      text && h('p', { text }),
      detail && h('p', { class: 'detail', text: detail }),
      extra,
      actions && h('div', { class: 'actions' }, actions));
  }
  const btn = (label, fn, cls = '', iconName = null) =>
    h('button', { type: 'button', class: `btn ${cls}`, onclick: fn }, iconName && icon(iconName), label);

  /* ---------------- browser panel rendering ---------------- */
  function renderEmpty() {
    setOverlay(h('div', { class: 'panel empty-state' },
      h('div', { class: 'icon-wrap' }, icon('globe')),
      h('h2', { text: 'Nothing open yet' }),
      h('p', { text: 'Type a supported address above, or launch a game.' }),
      h('div', { class: 'quick' }, GAMES.filter((g) => g.featured).map((g) => btn(g.name, () => launch(g.url), 'ghost sm', 'play')))));
    updateChrome();
  }

  function renderLoading() {
    if (!cur) return;
    const checkLabel = cur.verdict
      ? (cur.verdict.cached ? 'Embed check — saved result' : cur.verdict.frameable === null ? 'Embed check unavailable' : 'Embed check complete')
      : cur.skipCheck ? 'Embed check skipped' : 'Checking the site allows embedding';
    const steps = h('ul', { class: 'steps' },
      h('li', { class: cur.verdict || cur.skipCheck ? 'done' : 'active', text: checkLabel }),
      h('li', { class: cur.frameLoaded ? 'done' : 'active', text: cur.frameLoaded ? 'Page loaded' : 'Loading page' }));
    const slow = cur.slow && !cur.frameLoaded && h('p', {
      class: 'detail',
      text: slowLink()
        ? 'Your connection looks slow. It’s still loading — you can keep waiting, retry, or use a separate tab.'
        : 'This is taking longer than usual. It’s still loading — you can keep waiting, retry, or use a separate tab.',
    });
    setOverlay(h('div', { class: 'panel' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('h2', { text: `Loading ${cur.host}` }),
      steps,
      h('span', { class: 'elapsed', id: 'elapsed', text: fmtElapsed(performance.now() - cur.started) }),
      slow,
      h('div', { class: 'actions' }, cur.slow && !cur.frameLoaded
        ? [btn('Keep waiting', keepWaiting, 'ghost sm'), btn('Retry', () => reload(), 'ghost sm'), btn('Open in new tab', () => popout(), 'primary sm', 'popout')]
        : [btn('Stop', stop, 'ghost sm')])));
  }

  function renderBlocked(v) {
    setOverlay(panel({
      iconName: 'alert', tone: 'warn',
      title: 'This site can’t be shown inside the hub',
      host: cur.host,
      text: 'The site tells browsers not to display it inside other pages. Open it in its own tab instead — the hub keeps track of it here.',
      detail: v.reason,
      actions: [btn('Open in new tab', () => popout(), 'primary', 'popout'), btn('Try embedding anyway', () => load(cur.url, { forceFrame: true }), 'ghost'), btn('Back to games', () => showView('home'), 'ghost')],
    }));
  }

  function renderNeedsGesture(reason) {
    setOverlay(panel({
      iconName: 'popout', tone: '',
      title: 'Ready to open in a new tab',
      host: cur.host,
      text: settings.preferWindow ? 'Your settings open games in a separate tab.' : 'This site needs its own tab.',
      detail: reason,
      actions: [btn('Open in new tab', () => popout(), 'primary', 'popout'), btn('Embed here instead', () => load(cur.url, { forceFrame: true }), 'ghost')],
    }));
  }

  function renderPopupBlocked(url) {
    setOverlay(panel({
      iconName: 'alert', tone: 'warn',
      title: 'The new tab was blocked',
      host: new URL(url).host,
      text: 'Your browser stopped the hub from opening a tab. Use the link below, or allow pop-ups for this site in the address bar.',
      actions: [
        h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('popout'), 'Open in new tab'),
        btn('Embed here instead', () => load(url, { forceFrame: true }), 'ghost'),
      ],
    }));
  }

  function renderWindowMode() {
    const rec = winRefs.get(cur.host);
    const open = rec && !rec.w.closed;
    setOverlay(panel({
      iconName: open ? 'popout' : 'globe', tone: open ? 'ok' : '',
      title: open ? 'Playing in a separate tab' : 'The game tab was closed',
      host: cur.host,
      text: open ? 'The game keeps running in its own tab, so this hub stays free.' : 'Reopen it whenever you’re ready.',
      actions: open
        ? [btn('Switch to tab', () => focusWindow(cur.host), 'primary'), btn('Close tab', () => { closeWindow(cur.host); }, 'ghost'), btn('Embed here instead', () => load(cur.url, { forceFrame: true }), 'ghost')]
        : [btn('Reopen', () => popout(), 'primary', 'popout'), btn('Embed here instead', () => load(cur.url, { forceFrame: true }), 'ghost')],
    }));
  }

  function renderOffline() {
    setOverlay(panel({
      iconName: 'alert', tone: 'err',
      title: 'You’re offline',
      host: cur.host,
      text: 'This page will start loading by itself as soon as your connection comes back.',
      actions: [btn('Cancel', () => { pendingOnline = null; cur = null; showView('home'); updateChrome(); }, 'ghost')],
    }));
  }

  function renderError(title, message) {
    setOverlay(panel({
      iconName: 'alert', tone: 'err', title, host: cur?.host, text: message,
      actions: [btn('Retry', () => reload(), 'primary'), btn('Back to games', () => showView('home'), 'ghost')],
    }));
  }

  function renderStopped() {
    setOverlay(panel({
      iconName: 'stop', title: 'Loading stopped', host: cur.host,
      actions: [btn('Reload', () => reload(), 'primary', 'reload'), btn('Back to games', () => showView('home'), 'ghost')],
    }));
  }

  /* ---------------- navigation core ---------------- */
  function pushHistory(url) {
    hist.stack = hist.stack.slice(0, hist.index + 1);
    if (hist.stack[hist.index] !== url) hist.stack.push(url);
    if (hist.stack.length > 50) hist.stack.shift();
    hist.index = hist.stack.length - 1;
  }

  function addRecent(url) {
    recent = [{ url, at: Date.now() }, ...recent.filter((r) => r.url !== url)].slice(0, MAX_RECENT);
    store.set('recent', recent);
    store.set('last', url);
    renderSuggestions();
  }

  function flagInvalid(result) {
    els.urlField.classList.add('invalid');
    if (result.unsupported) {
      toast(result.error, 'err', { label: 'Add site', fn: () => { const d = addDomain(result.unsupported); if (d) navigate(els.urlInput.value, { gesture: true }); } }, 7000);
    } else {
      toast(result.error, 'err');
    }
    els.urlInput.focus();
  }

  /** Open an address in the browser panel. Returns false if it was rejected. */
  function navigate(input, { push = true, gesture = false, forceFrame = false } = {}) {
    const n = normalise(input);
    if (n.error) { flagInvalid(n); return false; }
    els.urlField.classList.remove('invalid');
    if (push) pushHistory(n.url);
    addRecent(n.url);
    load(n.url, { gesture, forceFrame, keepView: false });
    return true;
  }
  const launch = (url) => navigate(url, { gesture: true });

  function teardown() {
    if (!cur) return;
    cur.ctrl.abort();
    cur.timers.forEach(clearTimeout);
    cur.intervals.forEach(clearInterval);
    if (cur.frame) { cur.frame.remove(); cur.frame = null; }
  }

  function load(url, { gesture = false, forceFrame = false } = {}) {
    teardown();
    hideNotice();
    pendingOnline = null;
    const seq = ++navSeq;
    cur = {
      seq, url, host: new URL(url).host, ctrl: new AbortController(), started: performance.now(),
      timers: [], intervals: [], frame: null, verdict: null, frameLoaded: false, slow: false,
      phase: 'loading', mode: 'frame', forced: forceFrame, skipCheck: forceFrame,
    };
    els.urlInput.value = url;
    if (view !== 'browser') showView('browser'); else syncHash();

    if (!navigator.onLine) {
      cur.phase = 'offline';
      renderOffline();
      pendingOnline = () => load(url, { forceFrame });
      progress('idle'); updateChrome();
      return;
    }

    const cached = cachedVerdict(url);
    if (!forceFrame && (settings.preferWindow || cached?.frameable === false)) {
      cur.mode = 'window';
      cur.verdict = cached;
      if (gesture) popout();
      else { cur.phase = 'idle'; renderNeedsGesture(cached?.reason); updateChrome(); }
      return;
    }

    // Start the page and the embed check together: on slow links this saves a full round trip.
    progress('busy');
    startFrame(seq);
    if (forceFrame) { renderLoading(); updateChrome(); return; }
    renderLoading();
    updateChrome();
    getVerdict(url, cur.ctrl.signal).then((v) => {
      if (!cur || cur.seq !== seq) return;
      cur.verdict = v;
      if (v.frameable === false) {
        teardownFrameOnly();
        cur.phase = 'blocked';
        progress('idle');
        renderBlocked(v);
        updateChrome();
        return;
      }
      if (cur.phase === 'loaded') { if (v.frameable === null) noticeUnconfirmed(); return; }
      if (cur.frameLoaded) reveal(); else renderLoading();
    }).catch((e) => {
      if (e.name === 'AbortError' || !cur || cur.seq !== seq) return;
      teardownFrameOnly();
      cur.phase = 'error';
      progress('idle');
      renderError('This address can’t be opened', e.message);
      updateChrome();
    });
  }

  function teardownFrameOnly() {
    if (cur?.frame) { cur.frame.remove(); cur.frame = null; }
    cur.timers.forEach(clearTimeout); cur.timers = [];
    cur.intervals.forEach(clearInterval); cur.intervals = [];
  }

  function startFrame(seq) {
    const f = document.createElement('iframe');
    f.className = 'pending';
    f.title = `${cur.host} (embedded)`;
    f.allow = 'fullscreen; autoplay; clipboard-write; gamepad; screen-wake-lock';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    // No allow-top-navigation: embedded pages can't hijack the hub.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-modals allow-downloads allow-storage-access-by-user-activation');
    f.addEventListener('load', () => {
      if (!cur || cur.seq !== seq || cur.frameLoaded) return;
      cur.frameLoaded = true;
      // Give a pending embed check a moment so a refused frame isn't flashed on screen.
      if (!cur.verdict && !cur.skipCheck) {
        renderLoading();
        cur.timers.push(setTimeout(() => { if (cur && cur.seq === seq && cur.phase === 'loading') reveal(); }, scaled(3000)));
      } else {
        reveal();
      }
    });
    f.src = cur.url;
    cur.frame = f;
    els.stage.append(f);

    cur.intervals.push(setInterval(() => {
      const el = document.getElementById('elapsed');
      if (el && cur) el.textContent = fmtElapsed(performance.now() - cur.started);
    }, 1000));
    scheduleSlow(seq);
  }

  function scheduleSlow(seq) {
    const after = scaled(Number(settings.slowAfter) * 1000);
    cur.timers.push(setTimeout(() => {
      if (!cur || cur.seq !== seq || cur.phase !== 'loading' || cur.frameLoaded) return;
      cur.slow = true;
      renderLoading();
    }, after));
  }
  function keepWaiting() {
    if (!cur) return;
    cur.slow = false;
    renderLoading();
    scheduleSlow(cur.seq);
  }

  function reveal() {
    if (!cur || !cur.frame) return;
    cur.phase = 'loaded';
    cur.frame.classList.remove('pending');
    setOverlay(null);
    progress('done');
    if (cur.verdict && cur.verdict.frameable === null) {
      noticeUnconfirmed();
    } else if (cur.forced) {
      showNotice(`${cur.host} may refuse to be embedded. If the page is blank or shows an error, open it in a new tab.`);
    }
    updateChrome();
  }

  function noticeUnconfirmed() {
    showNotice(`Couldn’t confirm ${cur.host} allows embedding (${cur.verdict.reason.replace(/\.$/, '')}). If the page stays blank, open it in a new tab.`);
  }

  function stop() {
    if (!cur || cur.phase !== 'loading') return;
    teardown();
    cur.phase = 'stopped';
    progress('idle');
    renderStopped();
    updateChrome();
  }

  function reload() {
    if (!cur) return;
    load(cur.url, { forceFrame: cur.forced, gesture: true });
  }

  function back() {
    if (hist.index <= 0) return;
    hist.index -= 1;
    navigate(hist.stack[hist.index], { push: false, gesture: true });
  }
  function forward() {
    if (hist.index >= hist.stack.length - 1) return;
    hist.index += 1;
    navigate(hist.stack[hist.index], { push: false, gesture: true });
  }

  /* ---------------- separate tab handling ---------------- */
  const winName = (host) => `sh_${host.replace(/[^a-z0-9]/gi, '_')}`;

  function openWindow(url) {
    const host = new URL(url).host;
    let rec = winRefs.get(host);
    if (rec && !rec.w.closed) {
      if (rec.url !== url) { try { rec.w.location.href = url; rec.url = url; } catch { /* keep existing page */ } }
    } else {
      // Open blank first so the new tab can be cut off from this page (no window.opener).
      // '' never navigates an existing tab of the same name, so a running game is never reset.
      const w = window.open('', winName(host));
      if (!w) return null;
      let fresh = false;
      try { fresh = w.location.href === 'about:blank'; } catch { /* already showing the site */ }
      if (fresh) {
        try { w.opener = null; } catch { /* ignore */ }
        w.location.replace(url);
      }
      rec = { w, url: fresh ? url : null };
      winRefs.set(host, rec);
    }
    try { rec.w.focus(); } catch { /* ignore */ }
    return rec.w;
  }
  function focusWindow(host) {
    const rec = winRefs.get(host);
    if (!rec || rec.w.closed) return renderWindowMode();
    window.open('', winName(host)); // re-targeting a named tab brings it forward
    try { rec.w.focus(); } catch { /* ignore */ }
  }
  function closeWindow(host) {
    const rec = winRefs.get(host);
    if (rec && !rec.w.closed) rec.w.close();
    if (cur && cur.host === host && cur.mode === 'window') renderWindowMode();
    updateEmbedTags();
  }

  /** Open the current (or given) address in its own tab and show the tab's status here. Must run from a click. */
  function popout(url = cur?.url) {
    if (!url) return;
    if (!cur || cur.url !== url) {
      const n = normalise(url);
      if (n.error) return flagInvalid(n);
      pushHistory(n.url); addRecent(n.url);
      teardown();
      cur = { seq: ++navSeq, url: n.url, host: new URL(n.url).host, ctrl: new AbortController(), started: performance.now(), timers: [], intervals: [], phase: 'idle', mode: 'window' };
      els.urlInput.value = n.url;
      if (view !== 'browser') showView('browser');
    }
    const w = openWindow(cur.url);
    teardown();
    hideNotice();
    progress('idle');
    cur.mode = 'window';
    cur.phase = 'window';
    if (!w) { renderPopupBlocked(cur.url); updateChrome(); return; }
    renderWindowMode();
    const seq = cur.seq;
    let wasOpen = true;
    cur.intervals.push(setInterval(() => {
      if (!cur || cur.seq !== seq) return;
      const open = !w.closed;
      if (open !== wasOpen) { wasOpen = open; renderWindowMode(); }
    }, 1500));
    syncHash();
    updateChrome();
  }

  /* ---------------- chrome (toolbar) ---------------- */
  function updateChrome() {
    els.back.disabled = hist.index <= 0;
    els.fwd.disabled = hist.index >= hist.stack.length - 1;
    const loading = cur && cur.phase === 'loading';
    els.reload.disabled = !cur;
    els.reload.querySelector('use').setAttribute('href', loading ? '#i-stop' : '#i-reload');
    els.reload.title = loading ? 'Stop (Esc)' : 'Reload';
    els.reload.setAttribute('aria-label', loading ? 'Stop' : 'Reload');
    els.popout.disabled = !cur;
    els.full.disabled = !(cur && cur.frame && cur.phase === 'loaded');
    if (cur && document.activeElement !== els.urlInput) els.urlInput.value = cur.url;
    els.urlField.classList.toggle('secure', !!cur && cur.url.startsWith('https:'));
  }

  /* ---------------- network indicator ---------------- */
  function renderNet() {
    const p = els.pill;
    p.classList.remove('ok', 'slow', 'offline', 'degraded');
    let text, title;
    if (!navigator.onLine) {
      p.classList.add('offline'); text = 'Offline'; title = 'No connection. Pages will load when you reconnect.';
    } else if (net.backend === 'down') {
      p.classList.add('degraded'); text = 'Limited'; title = 'Hub server unreachable — embed checks are unavailable, saved results are used.';
    } else if (slowLink()) {
      p.classList.add('slow'); text = net.rtt ? `Slow · ${net.rtt} ms` : 'Slow'; title = 'Slow connection — timeouts are extended automatically.';
    } else if (net.backend === 'up') {
      p.classList.add('ok'); text = net.rtt ? `Online · ${net.rtt} ms` : 'Online'; title = 'Connected. Click to re-test.';
    } else {
      text = 'Checking…'; title = 'Testing connection…';
    }
    els.netText.textContent = text;
    p.title = `${title}${conn?.effectiveType ? ` (network: ${conn.effectiveType})` : ''}`;
  }
  let pinging = false;
  async function pingBackend(announce = false) {
    if (pinging) return;
    pinging = true;
    const t0 = performance.now();
    try {
      await fetchJSON(`/api/health?t=${Date.now()}`, { timeout: 6000, retries: 0 });
      net.backend = 'up';
      net.rtt = Math.round(performance.now() - t0);
      if (announce) toast(`Hub server reachable · ${net.rtt} ms`, 'ok');
    } catch {
      net.backend = navigator.onLine ? 'down' : net.backend;
      if (announce) toast(navigator.onLine ? 'Hub server didn’t respond. Games can still open; embed checks use saved results.' : 'You’re offline.', 'warn');
    } finally {
      pinging = false;
      renderNet();
    }
  }

  window.addEventListener('online', () => {
    renderNet();
    pingBackend();
    hideNotice();
    if (pendingOnline) { const run = pendingOnline; pendingOnline = null; toast('Back online — resuming.', 'ok'); run(); }
  });
  window.addEventListener('offline', () => {
    renderNet();
    if (cur && cur.phase === 'loading') {
      const url = cur.url, forced = cur.forced;
      pendingOnline = () => load(url, { forceFrame: forced });
      showNotice('Connection lost while loading. The page will reload automatically when you’re back online.');
    } else if (cur && cur.phase === 'loaded') {
      showNotice('Connection lost. The game will reconnect by itself once you’re back online.');
    }
  });
  conn?.addEventListener?.('change', renderNet);

  /* ---------------- home: games & recent ---------------- */
  function embedTag(url) {
    const v = cachedVerdict(url);
    if (!v || v.frameable === null) return null;
    return h('span', { class: `embed-tag ${v.frameable ? 'yes' : 'no'}`, 'data-embed': originOf(url), text: v.frameable ? 'Plays here' : 'Opens in tab' });
  }
  function updateEmbedTags() { renderGames(); }

  const prewarmed = new Set();
  function prewarm(url) {
    const origin = originOf(url);
    if (prewarmed.has(origin) || conn?.saveData) return;
    prewarmed.add(origin);
    document.head.append(h('link', { rel: 'preconnect', href: origin }));
    if (!cachedVerdict(url) && navigator.onLine) getVerdict(url).catch(() => {});
  }

  function gameCard(g, { removable = null } = {}) {
    const host = new URL(g.url).host;
    const art = h('div', { class: 'game-art' },
      h('span', { class: 'era', text: g.era }),
      h('span', { class: 'monogram', text: g.mono }));
    art.style.setProperty('--art', g.art);
    const card = h('article', { class: 'game-card' },
      art,
      h('div', { class: 'game-body' },
        h('h3', { text: g.name }),
        h('p', { text: g.blurb }),
        h('div', { class: 'game-meta' }, host.replace(/^www\./, ''), embedTag(g.url)),
        h('div', { class: 'game-actions' },
          btn('Play', () => launch(g.url), 'primary', 'play'),
          h('button', { type: 'button', class: 'btn ghost', title: 'Open in new tab', 'aria-label': `Open ${g.name} in new tab`, onclick: () => popout(g.url) }, icon('popout'), 'New tab'))),
      removable && h('button', { type: 'button', class: 'icon-btn sm remove', title: 'Remove site', 'aria-label': `Remove ${g.name}`, onclick: removable }, icon('trash')));
    card.addEventListener('pointerenter', () => prewarm(g.url), { once: true });
    card.addEventListener('focusin', () => prewarm(g.url), { once: true });
    return card;
  }

  function renderGames() {
    $('featuredGames').replaceChildren(...GAMES.filter((g) => g.featured).map((g) => gameCard(g)));
    const more = GAMES.filter((g) => !g.featured).map((g) => gameCard(g));
    for (const d of customDomains) {
      more.push(gameCard({
        name: d.domain, era: 'Added', mono: d.domain[0].toUpperCase(),
        blurb: 'A site you added to the supported list.', url: `https://${d.domain}/`,
        art: 'linear-gradient(135deg,#2a2f3a,#161a22)',
      }, { removable: () => removeDomain(d.domain) }));
    }
    $('moreGames').replaceChildren(...more);
  }

  function renderRecent() {
    const list = $('recentList');
    $('recentHead').hidden = recent.length === 0;
    list.replaceChildren(...recent.map((r) => h('li', null,
      h('button', { type: 'button', class: 'link', title: r.url, onclick: () => launch(r.url), text: r.url.replace(/^https:\/\//, '') }),
      h('time', { datetime: new Date(r.at).toISOString(), text: timeAgo(r.at) }),
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Open in new tab', 'aria-label': 'Open in new tab', onclick: () => popout(r.url) }, icon('popout')))));
  }

  function renderSuggestions() {
    const opts = new Set([...recent.map((r) => r.url), ...allDomains().map((d) => `https://${d}/`)]);
    $('urlSuggestions').replaceChildren(...[...opts].map((v) => h('option', { value: v })));
  }

  /* ---------------- sites & settings ---------------- */
  function renderSites() {
    $('siteList').replaceChildren(
      ...BUILTIN_DOMAINS.map((d) => h('li', null, h('span', { class: 'domain', text: d }), h('span', { class: 'badge', text: 'Built-in' }))),
      ...customDomains.map((d) => h('li', null,
        h('span', { class: 'domain', text: d.domain }),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => launch(`https://${d.domain}/`) }, 'Open'),
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Remove', 'aria-label': `Remove ${d.domain}`, onclick: () => removeDomain(d.domain) }, icon('trash')))));
  }

  function bindSettings() {
    const pw = $('setPreferWindow'), sa = $('setSlowAfter'), rs = $('setResume');
    pw.checked = !!settings.preferWindow;
    sa.value = String(settings.slowAfter);
    rs.checked = !!settings.resume;
    const save = () => store.set('settings', settings);
    pw.addEventListener('change', () => { settings.preferWindow = pw.checked; save(); toast(pw.checked ? 'Games will open in a separate tab.' : 'Games will play inside the hub when the site allows it.', 'ok'); });
    sa.addEventListener('change', () => { settings.slowAfter = Number(sa.value); save(); });
    rs.addEventListener('change', () => { settings.resume = rs.checked; save(); });
    $('btnClearChecks').addEventListener('click', async () => {
      checks = {};
      store.set('checks', checks);
      try { if (window.caches) await caches.delete('sh-checks'); } catch { /* ignore */ }
      renderGames();
      toast('Saved embed checks cleared.', 'ok');
    });
    $('addSiteForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (addDomain($('addSiteInput').value)) $('addSiteInput').value = '';
    });
    $('btnClearRecent').addEventListener('click', () => {
      const old = recent;
      recent = []; store.set('recent', recent);
      renderRecent(); renderSuggestions();
      toast('Recent list cleared.', 'ok', { label: 'Undo', fn: () => { recent = old; store.set('recent', recent); renderRecent(); renderSuggestions(); } });
    });
  }

  /* ---------------- events ---------------- */
  els.urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (navigate(els.urlInput.value, { gesture: true })) els.urlInput.blur();
  });
  els.urlInput.addEventListener('focus', () => els.urlInput.select());
  els.urlInput.addEventListener('input', () => els.urlField.classList.remove('invalid'));
  els.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { els.urlInput.value = cur?.url || ''; els.urlField.classList.remove('invalid'); els.urlInput.blur(); }
  });
  els.back.addEventListener('click', back);
  els.fwd.addEventListener('click', forward);
  els.reload.addEventListener('click', () => (cur && cur.phase === 'loading' ? stop() : reload()));
  els.home.addEventListener('click', () => showView('home'));
  els.popout.addEventListener('click', () => popout());
  els.full.addEventListener('click', () => {
    const req = els.stage.requestFullscreen || els.stage.webkitRequestFullscreen;
    if (req) req.call(els.stage)?.catch?.(() => toast('Fullscreen isn’t available here.', 'warn'));
  });
  els.pill.addEventListener('click', () => pingBackend(true));

  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { e.preventDefault(); showView(nav.dataset.nav); return; }
    const act = e.target.closest('[data-action]');
    if (act?.dataset.action === 'popout') popout();
    if (act?.dataset.action === 'dismiss-notice') hideNotice();
  });

  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); els.urlInput.focus(); return; }
    if (inField) return;
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); forward(); }
    else if (e.key === 'Escape' && cur?.phase === 'loading') stop();
  });

  window.addEventListener('hashchange', () => routeFromHash(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pingBackend(); });
  setInterval(() => { if (!document.hidden && navigator.onLine) pingBackend(); }, 45000);

  function routeFromHash(fromUser) {
    const hash = location.hash.slice(1);
    if (hash.startsWith('open=')) {
      const url = decodeURIComponent(hash.slice(5));
      if (!cur || cur.url !== url) { navigate(url, { gesture: false }); return true; }
      showView('browser');
      return true;
    }
    if (['home', 'browser', 'sites'].includes(hash)) { showView(hash); return true; }
    if (fromUser) showView('home');
    return false;
  }

  /* ---------------- service worker (offline shell) ---------------- */
  function registerSW() {
    const ver = $('appVersion');
    const setVer = (s) => { ver.textContent = `Supremacy Hub ${VERSION} · ${s}`; };
    if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      setVer('offline mode unavailable on this address');
      return;
    }
    setVer('preparing offline mode…');
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      navigator.serviceWorker.ready.then(() => setVer('works offline'));
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('An update is ready.', '', { label: 'Reload', fn: () => { nw.postMessage('skip-waiting'); } }, 0);
          }
        });
      });
    }).catch(() => setVer('offline mode unavailable'));
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !navigator.serviceWorker.controller) return;
      // Only reload automatically when nothing is running in the frame.
      if (cur && (cur.phase === 'loaded' || cur.phase === 'loading')) return;
      reloading = true;
      location.reload();
    });
  }

  /* ---------------- start ---------------- */
  renderGames();
  renderRecent();
  renderSites();
  renderSuggestions();
  bindSettings();
  renderNet();
  updateChrome();
  if (!routeFromHash(false)) {
    const last = store.get('last', null);
    if (settings.resume && last) navigate(last, { gesture: false });
    else showView('home');
  }
  pingBackend();
  registerSW();
})();
