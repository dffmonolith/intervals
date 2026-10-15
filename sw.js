// Intervals -- service worker (added in 0.19). Makes Intervals installable on a phone's home
// screen and lets it run with no connection once it has been opened online.
//
// How it fits the site's versioning: the launcher (intervals.html) reads current.txt and jumps
// to the versioned file it names (intervals-x.y.html). Versioned files never change once
// released, so they are cached for good; current.txt and the launcher are fetched fresh when
// there is a network (falling back to the cached copy after a few seconds, or offline), so a
// new release is picked up on the next online launch. Releasing a version is unchanged:
// upload intervals-x.y.html, then point current.txt at it. This file does NOT need editing.
//
// Bump SW_VERSION only when this file's own logic or SHELL list changes, or when
// intervals-piano-samples.json is replaced -- the samples are cached once and never re-checked.
//
// GitHub copy: LAUNCHER = 'index.html' (the app itself) and POINTER = null.

const SW_VERSION = '1';
const LAUNCHER = 'index.html';          // start page (the manifest's start_url)
const POINTER  = null;                 // one line: the current versioned app file (null if LAUNCHER is the app)
const CACHE    = 'intervals-sw' + SW_VERSION;
const NET_WAIT = 4000;                 // ms to wait for the network before using the cached copy

const SHELL = [LAUNCHER, 'manifest.webmanifest', 'intervals-piano-samples.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
const STATIC = new Set(['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'intervals-piano-samples.json']);
const APP_RE = /^intervals-\d+\.\d+\.html$/;

const scope = self.registration.scope;                 // ends in '/'
const abs = p => new URL(p, scope).href;
const rel = href => href.startsWith(scope) ? href.slice(scope.length) : null;
const okName = n => APP_RE.test(n);

// ----- install: cache the shell, the pointer and the version it names -----
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map(p => new Request(abs(p), { cache: 'reload' })));
    if (POINTER) {
      const r = await fetch(abs(POINTER), { cache: 'no-store' });
      if (r.ok) {
        const name = (await r.clone().text()).trim();
        await cache.put(abs(POINTER), r);
        if (okName(name)) await cache.add(new Request(abs(name), { cache: 'reload' }));
      }
    }
    await self.skipWaiting();      // nothing in the page depends on the worker mid-session
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('intervals-sw') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Keep only the versioned app files we still need: `keep` plus whatever current.txt names.
async function prune(cache, keep) {
  let current = null;
  if (POINTER) { const p = await cache.match(abs(POINTER)); if (p) current = (await p.text()).trim(); }
  for (const req of await cache.keys()) {
    const n = rel(req.url);
    if (n && okName(n) && n !== keep && n !== current) await cache.delete(req);
  }
}

// Network first (bounded by NET_WAIT), cache as fallback; a late network answer still updates the cache.
function networkFirst(event, key) {
  return (async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(key, { cache: 'no-store' }).then(async r => {
      if (r.ok) {
        await cache.put(key, r.clone());
        if (POINTER && key === abs(POINTER)) {           // a new release? fetch it now, drop the old one
          const name = (await r.clone().text()).trim();
          if (okName(name)) {
            if (!(await cache.match(abs(name)))) await cache.add(new Request(abs(name), { cache: 'reload' })).catch(() => {});
            await prune(cache, name);
          }
        }
      }
      return r;
    });
    event.waitUntil(net.catch(() => {}));
    const timer = new Promise(res => setTimeout(res, NET_WAIT, null));
    const first = await Promise.race([net.catch(() => null), timer]);
    if (first && first.ok) return first;
    const hit = await cache.match(key);
    if (hit) return hit;
    return first || net;                                 // nothing cached: wait for (or fail with) the network
  })();
}

async function cacheFirst(event, key, isApp) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(key);
  if (r.ok) {
    await cache.put(key, r.clone());
    if (isApp) event.waitUntil(prune(cache, rel(key)));
  }
  return r;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  url.search = ''; url.hash = '';
  let key = url.href;
  if (key === scope) key = abs(LAUNCHER);                // the bare folder opens the launcher
  const name = rel(key);
  if (name === null) return;                             // site nav, analytics etc.: straight to the network

  if (name === LAUNCHER || name === POINTER) { event.respondWith(networkFirst(event, key)); return; }
  if (okName(name)) { event.respondWith(cacheFirst(event, key, true)); return; }
  if (STATIC.has(name)) { event.respondWith(cacheFirst(event, key, false)); return; }
  if (req.mode === 'navigate') {                         // some other page in this folder: network, else the launcher
    event.respondWith(fetch(req).catch(async () => (await caches.match(abs(LAUNCHER))) || Response.error()));
  }
});
