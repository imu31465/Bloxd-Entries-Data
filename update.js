#!/usr/bin/env node
// ============================================================================
// Bloxd.io data update script (single file / zero dependencies / Node >= 18)
//
//   node update.js              check the latest bundle and update this folder if it changed
//   node update.js --force      re-extract even if the bundle is the same as last time
//   node update.js --skip-fetch re-extract from the downloaded bundle (no network)
//
// How it works:
//   1. Detect the main bundle URL from the bloxd.io HTML (the filename contains a content hash)
//   2. If the build is code-split (webpack 5), also download the async chunks declared by
//      the main bundle and merge their module tables into the main one
//   3. Execute the registry-building code inside the bundle on the same V8 the game uses
//      (the webpack runtime is reproduced on Node; both are V8, so results match the live game)
//   4. Write to a temp folder (.update_tmp) -> verify -> swap in
//      (a mid-run failure cannot corrupt the existing data in this folder)
//
// Files updated (inside this folder):
//   entries.json               id<->name map for all entries (block+item) as [{id, name}] (sorted by id, contiguous 0..N)
//   entries/                   one JSON per entry (5-digit zero-padded ID_Name.json, kind=block/item)
//   README.md / CHANGES.md     documentation / diff from the previous run
//   update-state.json          last bundle url + diff counts (committed, used by CI to skip unchanged runs)
// Compatibility: if legacy blocks.json / items.json / blocks/ / items/ exist, they are read and
//               migrated to the unified format on a successful update (legacy files are deleted).
//
// The bundle cache lives in the OS temp folder (bloxd-io-update).
// update-state.json (committed) records the last bundle + diff so that CI runs
// and other machines skip extraction when the bundle is unchanged.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const OUT = __dirname; // bloxd_data folder containing this script
const STAGING = path.join(OUT, '.update_tmp');
const REPO_STATE_PATH = path.join(OUT, 'update-state.json');
const INLINE_LIST_MAX = 15; // lists longer than this are collapsed into <details> in CHANGES.md
const CACHE = path.join(os.tmpdir(), 'bloxd-io-update');
const SRC_PATH = path.join(CACHE, 'bloxd_main.js');
const STATE_PATH = path.join(CACHE, 'state.json');
const ORIGIN = 'https://bloxd.io';
const FORCE = process.argv.includes('--force');
const SKIP_FETCH = process.argv.includes('--skip-fetch');

const AIR_NOTE = 'Air is not instantiated in the registry; id 0 is a special value in the game code (Sj: 0 === id -> "Air").';

// ---------- Logging ----------
const t0 = Date.now();
let stepNo = 0;
function logStep(title) { stepNo++; console.log(`\n[${stepNo}] ${title}`); }
function logSub(msg) { console.log(`    ${msg}`); }
function elapsed() { return ((Date.now() - t0) / 1000).toFixed(1) + 's'; }

// ============================================================================
// 1. Bundle fetch (detect the main bundle URL from the bloxd.io HTML and download it)
// ============================================================================
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://bloxd.io/',
};

async function httpGet(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { buf: Buffer.from(await res.arrayBuffer()), finalUrl: res.url || url };
}

// Example HTML: <script defer src="/static/js/6qxffk.main.5912a15f.js">
// Prefer "*.main.*.js"; fall back to /static/js/*.js if absent
function findMainBundleUrl(html) {
  const main = html.match(/["'(]?(\/static\/js\/[A-Za-z0-9_.-]*main[A-Za-z0-9_.-]*\.js)/);
  if (main) return main[1];
  const any = html.match(/["'(]?(\/static\/js\/[A-Za-z0-9_.-]+\.js)/);
  return any ? any[1] : null;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) { return {}; }
}
function writeState(st) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

function readRepoState() {
  try { return JSON.parse(fs.readFileSync(REPO_STATE_PATH, 'utf8')); } catch (_) { return {}; }
}
function writeRepoState(st) {
  fs.writeFileSync(REPO_STATE_PATH, JSON.stringify(st, null, 2) + '\n');
}

// The 8-hex content hash embedded in the bundle file name (e.g. ...main.6188124c.js)
function hash8FromUrl(url) {
  const m = String(url || '').match(/\.([0-9a-f]{8})\.js$/);
  return m ? m[1] : null;
}

// Bundle info regardless of the source (fresh fetch / cached bundle / temp cache)
function bundleInfo(fetchInfo) {
  const st = readState();
  const url = fetchInfo ? fetchInfo.url : (st.lastBundleUrl || null);
  if (!url) return null;
  const sha256 = fetchInfo ? fetchInfo.sha256 : (st.lastSha256 || null);
  return {
    url,
    file: fetchInfo ? fetchInfo.file : (st.lastBundleFile || (url.split('/').pop() || null)),
    sha256,
    hash8: hash8FromUrl(url) || (sha256 ? sha256.slice(0, 8) : null),
  };
}

async function fetchLatestBundle() {
  logStep('Checking the bloxd.io main bundle');
  fs.mkdirSync(CACHE, { recursive: true });
  const { buf: htmlBuf, finalUrl } = await httpGet(ORIGIN + '/');
  const html = htmlBuf.toString('utf8');
  const rel = findMainBundleUrl(html);
  if (!rel) throw new Error('Bundle URL not found in HTML (site structure may have changed)');
  const url = new URL(rel, finalUrl).href;
  logSub(`Detected: ${rel}`);

  // Committed repo state has priority: run only when the bundle differs from what the
  // current data was extracted from (this is what makes CI a cheap no-op loop).
  if (!FORCE) {
    const repo = readRepoState();
    if (repo && repo.lastBundle && repo.lastBundle.url === url) {
      logSub('Same bundle as the committed state -> nothing to do');
      return { changed: false, url, file: rel, sha256: repo.lastBundle.sha256 || null };
    }
  }

  const state = readState();
  if (state.lastBundleUrl === url && fs.existsSync(SRC_PATH)) {
    logSub('Bundle is new for this repo, but already cached locally');
    const chunkMap = findChunkMap(fs.readFileSync(SRC_PATH, 'utf8'));
    const chunkFiles = chunkMap ? await downloadChunkFiles(chunkMap) : [];
    return { changed: true, url, file: rel, sha256: state.lastSha256 || null, chunkFiles };
  }

  logSub('Downloading ...');
  const { buf } = await httpGet(url);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(SRC_PATH, buf);
  writeState({
    ...state,
    lastBundleUrl: url,
    lastBundleFile: rel,
    lastSha256: sha256,
    lastFetchedAt: new Date().toISOString(),
    bytes: buf.length,
  });
  logSub(`Saved: ${(buf.length / 1e6).toFixed(1)} MB / sha256 ${sha256.slice(0, 16)}...`);
  const chunkMap = findChunkMap(buf.toString('utf8'));
  const chunkFiles = chunkMap ? await downloadChunkFiles(chunkMap) : [];
  return { changed: true, url, file: rel, sha256, bytes: buf.length, chunkFiles };
}

// ============================================================================
// 2. Browser global stubs (harness to run the bundle on Node)
// ============================================================================
// NOTE: the harness only reproduces the webpack module system; async chunks are
// merged into the module table beforehand (see loadModuleTable), so chunk
// requests are stubbed and never hit the network during extraction.
function installBrowserStubs() {
  function addProp(obj, name, getter) {
    Object.defineProperty(obj, name, { get: getter, configurable: true });
  }
  const noop = () => {};
  const stubElement = () => {
    const el = {
      style: new Proxy({}, { get: () => '', set: () => true }),
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      dataset: {},
      children: [],
      appendChild: stubElement, removeChild: noop, remove: noop,
      setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
      addEventListener: noop, removeEventListener: noop,
      getContext: () => null,
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
      focus: noop, blur: noop, click: noop, attachShadow: () => stubElement(),
      querySelector: () => null, querySelectorAll: () => [],
      innerHTML: '', textContent: '', value: '', width: 0, height: 0,
    };
    el.style.setProperty = noop;
    return el;
  };
  const win = globalThis;
  const forceDef = (obj, name, value) => {
    try { Object.defineProperty(obj, name, { value, writable: true, configurable: true }); }
    catch (e) { console.log(`    [harness] failed to define global: ${name} (${e.message})`); }
  };
  forceDef(win, 'window', win);
  win.self = win;
  win.global = win;
  win.document = {
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null,
    createElement: (t) => { const el = stubElement(); if (/canvas/i.test(String(t))) { el.getContext = () => null; } return el; },
    createElementNS: () => stubElement(),
    createTextNode: () => stubElement(),
    body: stubElement(), head: stubElement(), documentElement: stubElement(),
    readyState: 'complete', cookie: '',
    hasFocus: () => true, exitFullscreen: noop, getSelection: () => null,
  };
  forceDef(win, 'navigator', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Node-harness',
    language: 'en', languages: ['en'], platform: 'Linux x86_64',
    hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    vendor: 'Google Inc.', clipboard: { writeText: async () => {} },
    getGamepads: () => [], storage: { estimate: async () => ({}) },
    mediaDevices: { enumerateDevices: async () => [] },
    userAgentData: { mobile: false, platform: 'Linux' },
    onLine: true, serviceWorker: undefined,
  });
  forceDef(win, 'location', {
    href: 'https://bloxd.io/', origin: 'https://bloxd.io', protocol: 'https:',
    host: 'bloxd.io', hostname: 'bloxd.io', port: '', pathname: '/', search: '', hash: '',
    assign: noop, replace: noop, reload: noop, toString: () => 'https://bloxd.io/',
  });
  const storageStub = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  };
  forceDef(win, 'localStorage', storageStub());
  forceDef(win, 'sessionStorage', storageStub());
  win.addEventListener = noop; win.removeEventListener = noop;
  win.dispatchEvent = () => true;
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.matchMedia = () => ({ matches: false, media: '', addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop, onchange: null, dispatchEvent: () => false });
  win.getComputedStyle = () => new Proxy({ getPropertyValue: () => '' }, { get: (t, k) => (k === 'getPropertyValue' ? t[k] : '') });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.history = { pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop, state: null, length: 1 };
  win.Image = class { set src(_) {} addEventListener() {} };
  win.Audio = class { addEventListener() {} play() { return Promise.resolve(); } };
  win.fetch = () => Promise.reject(new Error('network disabled in harness'));
  win.XMLHttpRequest = class { open() {} send() {} addEventListener() {} setRequestHeader() {} };
  win.WebSocket = class { constructor() { this.readyState = 0; } close() {} send() {} addEventListener() {} };
  win.Worker = class { constructor() {} postMessage() {} addEventListener() {} terminate() {} };
  win.Notification = undefined;
  win.sentryOnLoad = undefined;
  win.onbeforeunload = undefined;
  win.ReactNativeWebView = undefined;
  win.devicePixelRatio = 1;
  win.innerWidth = 1920; win.innerHeight = 1080;
  win.outerWidth = 1920; win.outerHeight = 1080;
  win.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0 } };
  win.visualViewport = { width: 1920, height: 1080, scale: 1, addEventListener: noop, removeEventListener: noop };
  if (!win.crypto) forceDef(win, 'crypto', require('crypto').webcrypto);
  win.alert = noop; win.confirm = () => false; win.prompt = () => null;
  win.open = () => null; win.close = noop;
  win.scrollTo = noop; win.scrollBy = noop; win.focus = noop; win.blur = noop;
  win.postMessage = noop;
  win.QueueMicrotask = queueMicrotask;
  win.DOMException = win.DOMException || class DOMException extends Error {};
  win.TextDecoder = win.TextDecoder || require('util').TextDecoder;
  win.TextEncoder = win.TextEncoder || require('util').TextEncoder;
  win.grecaptcha = { ready: (cb) => cb && cb(), execute: async () => 'stub', render: () => 0, reset: noop, getResponse: () => '' };
  win.onRecaptchaLoaded = noop;
  void addProp; // (declaration kept for compatibility with the old implementation)
}

// ============================================================================
// 3. webpack runtime reproduction + registry discovery (update-resilient)
//   - Module array bounds are detected with a regex (independent of minified names)
//   - The registry is identified by "content" (instances with name+id), not by export key names
// ============================================================================
function objectifyModules(arr) {
  const obj = Object.create(null);
  for (let i = 0; i < arr.length; i++) if (typeof arr[i] === 'function') obj[i] = arr[i];
  return obj;
}

// Detects the webpack module table in both known shapes:
//   1. classic single-bundle ARRAY:  (()=>{var X=[fn,fn,...],Y={};function Z(
//   2. webpack 5 OBJECT module map:  (()=>{var X={1476:(a,b,c)=>{...},...},Y={};function Z(
// Returns { modules } as a plain id -> function object (ids as keys).
function findModuleMapBounds(source) {
  // ---- form 1: module array (old monolithic bundles) ----
  const startRe1 = /\(\(\)=>\{var ([A-Za-z_$][\w$]*)=\[/g;
  let sm1;
  while ((sm1 = startRe1.exec(source))) {
    const arrStart = sm1.index + sm1[0].length - 1; // position of '['
    const endRe1 = /\],([A-Za-z_$][\w$]*)=\{\};function ([A-Za-z_$][\w$]*)\(/g;
    endRe1.lastIndex = arrStart;
    let em1;
    while ((em1 = endRe1.exec(source))) {
      const arrEnd = em1.index + 1; // include the closing ']'
      const arrSrc = source.slice(arrStart, arrEnd);
      try {
        const arr = new Function('return ' + arrSrc)();
        if (Array.isArray(arr) && arr.length > 500) {
          return { modules: objectifyModules(arr), form: 'array' };
        }
      } catch (_) { /* false boundary inside a module body -> try the next one */ }
    }
  }
  // ---- form 2: module object (webpack 5 code-split builds) ----
  const startRe2 = /\(\(\)=>\{var ([A-Za-z_$][\w$]*)=\{(?=(\d+):)/g;
  let sm2;
  while ((sm2 = startRe2.exec(source))) {
    const mapStart = sm2.index + sm2[0].length - 1; // position of '{'
    const firstId = sm2[2];
    const endRe2 = /\},([A-Za-z_$][\w$]*)=/g;
    endRe2.lastIndex = mapStart;
    let em2, tried = 0;
    while ((em2 = endRe2.exec(source))) {
      if (++tried > 20000) break;
      const mapEnd = em2.index + 1; // include the closing '}'
      const mapSrc = source.slice(mapStart, mapEnd);
      try {
        const map = new Function('return (' + mapSrc + ')')();
        const keys = Object.keys(map);
        if (keys.length > 100 && keys.every((k) => typeof map[k] === 'function') && map[firstId] !== undefined) {
          return { modules: map, form: 'object' };
        }
      } catch (_) { /* not the real boundary -> try the next candidate */ }
    }
  }
  return null;
}

// Detects the webpack 5 async-chunk URL builder in the main bundle:
//   .u=<id>=>"static/js/<prefix>."+({0:"name",...}[<id>]||<id>)+"."+{<id>:"hash",...}[<id>]+".chunk.js"
// Returns { urlPrefix, names, hashes } or null when the build has no async JS chunks.
function findChunkMap(source) {
  const iu = source.search(/\.u=/);
  if (iu < 0) return null;
  // 2026-11: bloxd.io grew past ~260 async chunks, so the .u= arrow function got longer
  // than the old fixed 4000-char window and the regex stopped matching (no chunks were
  // downloaded -> "Block registry not found"). Slice to the function's ".chunk.js"
  // terminator instead of a fixed window, with a generous fallback.
  let end = source.indexOf('.chunk.js"', iu);
  if (end < 0 || end - iu > 100000) end = iu + 100000;
  const seg = source.slice(iu, Math.min(end + 12, source.length));
  const m = seg.match(/^\.u=\(?[A-Za-z_$][\w$]*\)?=>("([^"]*)")\+\(?(\{[^{}]*\})\[([A-Za-z_$][\w$]*)\]\|\|([A-Za-z_$][\w$]*)\)\+"\."\+(\{[^{}]*\})\[([A-Za-z_$][\w$]*)\]\+"\.chunk\.js"/);
  if (!m) return null;
  let names, hashes;
  try {
    names = new Function('return (' + m[3] + ')')();
    hashes = new Function('return (' + m[6] + ')')();
  } catch (_) { return null; }
  return { urlPrefix: m[2], names, hashes };
}

const CHUNK_DIR = path.join(CACHE, 'chunks');

function chunkFileName(chunkMap, id) {
  const hash = chunkMap.hashes[id];
  const label = chunkMap.names[id] !== undefined ? chunkMap.names[id] : String(id);
  return `${label}.${hash}.chunk.mjs`;
}

// Paths of the async chunk files that are already present in the cache
function existingChunkFiles(chunkMap) {
  const out = [];
  for (const id of Object.keys(chunkMap.hashes)) {
    const f = path.join(CHUNK_DIR, chunkFileName(chunkMap, id));
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

// Download all async JS chunks declared by the main bundle (cached files are reused).
// Failures are non-fatal: the registries live in the main bundle; chunks only add coverage.
async function downloadChunkFiles(chunkMap) {
  fs.mkdirSync(CHUNK_DIR, { recursive: true });
  // drop files from older bundles
  const expected = new Set(Object.keys(chunkMap.hashes).map((id) => chunkFileName(chunkMap, id)));
  for (const f of fs.readdirSync(CHUNK_DIR)) {
    if (!expected.has(f)) { try { fs.rmSync(path.join(CHUNK_DIR, f), { force: true }); } catch (_) {} }
  }
  const ids = Object.keys(chunkMap.hashes).map(Number).sort((a, b) => a - b);
  const files = [];
  let downloaded = 0, missing = 0, failed = 0;
  const queue = ids.slice();
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      const fname = chunkFileName(chunkMap, id);
      const dest = path.join(CHUNK_DIR, fname);
      if (fs.existsSync(dest)) { files.push(dest); continue; }
      const label = fname.replace(/\.chunk\.mjs$/, '');
      const url = `${ORIGIN}/${chunkMap.urlPrefix}${label}.chunk.js`;
      let buf = null;
      for (let attempt = 0; attempt < 2 && !buf; attempt++) {
        try {
          const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
          if (res.status === 404) break; // not published -> not an error
          if (!res.ok) throw new Error('HTTP ' + res.status);
          buf = Buffer.from(await res.arrayBuffer());
        } catch (e) {
          if (attempt === 1) { failed++; logSub(`Warning: chunk ${label} download failed (${e.message})`); }
          else await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (buf) { fs.writeFileSync(dest, buf); downloaded++; files.push(dest); }
      else missing++;
    }
  }
  await Promise.all(Array.from({ length: 6 }, () => worker()));
  logSub(`Async chunks: ${files.length} available / ${downloaded} downloaded / ${missing} not published / ${failed} failed`);
  return files;
}

// Build the id -> module-function table from the main bundle + all cached async chunks.
async function loadModuleTable(mainPath, chunkFiles) {
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const bounds = findModuleMapBounds(mainSrc);
  if (!bounds) throw new Error('webpack module map not found (bundle structure may have changed)');
  const modules = bounds.modules;
  let fromChunks = 0, broken = 0;
  const chunkSrcs = []; // chunk texts are searched for the i18n / hardcoded-ID tables
  for (const f of chunkFiles) {
    try {
      const mod = await import(pathToFileURL(f).href);
      if (mod && mod.modules && typeof mod.modules === 'object') {
        for (const [id, fn] of Object.entries(mod.modules)) {
          if (typeof fn === 'function' && modules[id] === undefined) { modules[id] = fn; fromChunks++; }
        }
        try { chunkSrcs.push(fs.readFileSync(f, 'utf8')); } catch (_) {}
      }
    } catch (e) {
      broken++;
      logSub(`Warning: could not import chunk ${path.basename(f)} (${String(e.message).split('\n')[0]})`);
    }
  }
  logSub(`Module table: ${Object.keys(modules).length} modules` + (chunkFiles.length ? ` (main bundle + ${fromChunks} from ${chunkFiles.length - broken} chunks)` : ' (single bundle)'));
  return { modules, mainSrc, chunkSrcs };
}

function createExtractor(mainSrc, modules, chunkSrcs = []) {
  installBrowserStubs();

  if (!modules || Object.keys(modules).length === 0) throw new Error('webpack module map not found (bundle structure may have changed)');
  const cache = Object.create(null);

  // ---------- webpack require (faithfully reproduces the bundle runtime) ----------
  function Oj(id) {
    const cached = cache[id];
    if (cached !== undefined) return cached.exports;
    const mod = (cache[id] = { id, loaded: false, exports: {} });
    const fn = modules[id];
    if (typeof fn !== 'function') throw new Error('module ' + id + ' not in module table (hole/lazy chunk)');
    fn.call(mod.exports, mod, mod.exports, Oj);
    mod.loaded = true;
    return mod.exports;
  }
  Oj.m = modules;
  Oj.n = (md) => { const g = md && md.__esModule ? () => md.default : () => md; Oj.d(g, { a: g }); return g; };
  (() => { let protoChain, getProto = Object.getPrototypeOf ? (o) => Object.getPrototypeOf(o) : (o) => o.__proto__;
    Oj.t = function (value, mode) {
      if (1 & mode && (value = this(value)), 8 & mode) return value;
      if ('object' === typeof value && value) { if (4 & mode && value.__esModule) return value; if (16 & mode && 'function' === typeof value.then) return value; }
      const ns = Object.create(null); Oj.r(ns);
      const def = {}; protoChain = protoChain || [null, getProto({}), getProto([]), getProto(getProto)];
      for (let cur = 2 & mode && value; 'object' == typeof cur && !~protoChain.indexOf(cur); cur = getProto(cur))
        Object.getOwnPropertyNames(cur).forEach((k) => { def[k] = () => value[k]; });
      def.default = () => value; Oj.d(ns, def); return ns;
    }; })();
  Oj.d = (obj, def) => { for (const k in def) Oj.o(def, k) && !Oj.o(obj, k) && Object.defineProperty(obj, k, { enumerable: true, get: def[k] }); };
  Oj.f = {};
  Oj.e = (chunkId) => { console.log(`    [harness] stubbing chunk request: ${chunkId}`); return Promise.resolve(); };
  Oj.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  Oj.r = (o) => { Object.defineProperty(o, Symbol.toStringTag, { value: 'Module' }); Object.defineProperty(o, '__esModule', { value: !0 }); };
  Oj.nmd = (m) => (m.paths = [], m.children || (m.children = []), m);
  Oj.p = '/';
  Oj.u = () => { throw new Error('css chunk'); };
  Oj.miniCssF = () => 'x.css';
  Oj.h = () => {};

  // ---------- Module / registry discovery ----------
  function findModulesBySource(needle) {
    const out = [];
    for (const id of Object.keys(modules)) {
      const fn = modules[id];
      if (typeof fn === 'function' && fn.toString().includes(needle)) out.push(id);
    }
    return out;
  }

  // A registry is an object indexable by both name keys (values have id:number) and numeric ID keys (values have name:string)
  // NOTE: keys may be ordered as "all numeric IDs -> all names", so scan every key instead of sampling the head
  function looksLikeRegistry(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    let named = 0, numeric = 0;
    for (const k of Object.keys(v)) {
      const inst = v[k];
      if (!inst || typeof inst !== 'object') return false;
      if (/^\d+$/.test(k)) { numeric++; if (typeof inst.name !== 'string') return false; }
      else { named++; if (typeof inst.id !== 'number') return false; }
    }
    return named >= 20 && numeric >= 20;
  }
  function findRegistryExports(exp) {
    const found = [];
    for (const k of Object.keys(exp)) {
      try { if (looksLikeRegistry(exp[k])) found.push({ key: k, obj: exp[k] }); } catch (_) {}
    }
    return found;
  }
  function registryMaxId(reg) {
    let m = 0;
    for (const k of Object.keys(reg)) if (/^\d+$/.test(k) && +k > m) m = +k;
    return m;
  }
  function registryMinId(reg) {
    let m = Infinity;
    for (const k of Object.keys(reg)) if (/^\d+$/.test(k) && +k < m) m = +k;
    return m;
  }

  // Block module: identify it by a data string ("Unloaded" is always the first block)
  function loadBlockRegistry() {
    const needles = ['Unloaded:{ttb:100', 'Unloaded:{ttb', 'Unloaded:{'];
    const tried = new Set();
    for (const needle of needles) {
      for (const id of findModulesBySource(needle)) {
        if (tried.has(id)) continue;
        tried.add(id);
        try {
          const exp = Oj(id);
          const cands = findRegistryExports(exp);
          const pick =
            cands.find((c) => c.obj['Unloaded'] !== undefined) ||
            (looksLikeRegistry(exp.j) ? { key: 'j', obj: exp.j } : null) ||
            cands.find((c) => registryMaxId(c.obj) > 1000) || null;
          if (pick) return { id, exports: exp, registry: pick.obj };
        } catch (_) { /* different module or require failed -> continue */ }
      }
    }
    throw new Error('Block registry not found (candidate modules exhausted)');
  }

  // Item module: items occupy the ID space after all block IDs.
  // A module can contain multiple registry-like exports (item-only + unified), so
  // the one with the largest minimum numeric ID is treated as the item registry.
  function loadItemRegistries(blockMaxId, blockModuleId) {
    const needles = ['AK-47', 'AWP', 'woodPickaxe', 'Grenade', 'stonePickaxe', 'Crossbow'];
    const tried = new Set();
    for (const needle of needles) {
      for (const id of findModulesBySource(needle)) {
        if (tried.has(id)) continue;
        tried.add(id);
        if (id === blockModuleId) continue;
        try {
          const exp = Oj(id);
          let cands = findRegistryExports(exp);
          if (!cands.length && looksLikeRegistry(exp.y)) cands = [{ key: 'y', obj: exp.y }];
          if (!cands.length) continue;
          const sorted = cands.slice().sort((a, b) => registryMinId(b.obj) - registryMinId(a.obj));
          const itemReg = sorted[0].obj;
          if (registryMinId(itemReg) <= blockMaxId) continue; // not the item registry
          const unifiedCand = sorted.slice(1).find((c) => registryMaxId(c.obj) >= blockMaxId) || null;
          return { id, exports: exp, itemRegistry: itemReg, unified: unifiedCand ? unifiedCand.obj : null };
        } catch (_) { /* continue */ }
      }
    }
    throw new Error('Item registry not found (candidate modules exhausted)');
  }

  // Compare against the hardcoded ID table in the bundle (e.g. Mj={...}). Informational only in case it disappears in the future.
  // 2026-11: the table moved out of the main bundle into an async chunk -> search every source.
  function validateAgainstHardcodedMap(nameToId) {
    let mjCount = 0, mjMatch = 0;
    const mjMismatch = [];
    // the ID may drift between builds -> anchor on the name in table form ("name":<number>) and read the expected value from the table itself
    for (const src of [mainSrc, ...chunkSrcs]) {
      const tableHit = src.match(/"Patterned Yellow Glass":(\d+)/);
      if (!tableHit) continue;
      const mi = tableHit.index;
      const open = src.lastIndexOf('{', mi);
      if (!src.slice(open + 1, open + 1 + 40).startsWith('"Patterned Yellow Glass"')) continue; // wrong occurrence -> try other sources
      let depth = 0, inStr = null, mEnd = -1;
      for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { mEnd = i; break; } }
      }
      if (mEnd < 0) continue;
      try {
        const Mj = new Function('return ' + src.slice(open, mEnd + 1))();
        for (const [name, idv] of Object.entries(Mj)) {
          mjCount++;
          const base = name.split('|')[0];
          const ourId = nameToId[name] !== undefined ? nameToId[name] : (nameToId[base] !== undefined ? nameToId[base] : null);
          if (ourId === idv) mjMatch++;
          else mjMismatch.push({ name, expected: idv, got: ourId });
        }
      } catch (e) { logSub(`Failed to parse hardcoded ID table: ${e.message}`); continue; }
      logSub(`Hardcoded ID table comparison: ${mjMatch}/${mjCount} match${mjMismatch.length ? ' ' + JSON.stringify(mjMismatch.slice(0, 10)) : ''}`);
      return { count: mjCount, match: mjMatch };
    }
    logSub('Hardcoded ID table not found; skipping comparison');
    return null;
  }

  return { src: mainSrc, modules, loadBlockRegistry, loadItemRegistries, registryMaxId, validateAgainstHardcodedMap };
}

// ============================================================================
// 4. Discovery of the English translation table ("item" namespace)
// ============================================================================
function braceMatchFrom(source, open) {
  let depth = 0, inStr = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function findItemTranslationsInSource(source) {
  const patterns = [/"item":\{/g, /'item':\{/g, /item:\{/g];
  for (const re of patterns) {
    let m, best = null;
    while ((m = re.exec(source))) {
      const open = m.index + m[0].length - 1;
      const end = braceMatchFrom(source, open);
      if (end < 0) continue;
      let obj;
      try { obj = new Function('return ' + source.slice(open, end + 1))(); } catch (_) { continue; }
      const keys = Object.keys(obj);
      if (keys.length < 100) continue;
      if (obj.woodPickaxe !== undefined) return { obj, strong: true }; // strong signal: well-known item key
      const strVals = keys.filter((k) => typeof obj[k] === 'string').length;
      if (strVals / keys.length > 0.8 && (!best || keys.length > Object.keys(best).length)) best = obj;
    }
    if (best) return { obj: best, strong: false };
  }
  return null;
}

// 2026-11: the English i18n table moved out of the main bundle into an async chunk, so
// search every source (main first). A strong (woodPickaxe) hit in ANY source wins over
// heuristic hits from earlier sources.
function findItemTranslations(sources) {
  let best = null;
  for (const source of sources) {
    const hit = findItemTranslationsInSource(source);
    if (!hit) continue;
    if (hit.strong) return hit.obj;
    if (!best || Object.keys(hit.obj).length > Object.keys(best).length) best = hit.obj;
  }
  return best;
}

// ============================================================================
// 5. Serialization (plainify / i18n resolution / filenames / meta null removal)
// ============================================================================
function plainify(v, seen) {
  const t = typeof v;
  if (v === undefined) return undefined;
  if (t === 'function') return '<function>';
  if (v === null || t !== 'object') {
    if (t === 'number' && !isFinite(v)) return String(v);
    return v;
  }
  if (seen.has(v)) return '<circular>';
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => plainify(x, seen));
    const o = {};
    for (const k of Object.keys(v)) {
      const val = plainify(v[k], seen);
      if (val !== undefined) o[k] = val;
    }
    return o;
  } finally { seen.delete(v); }
}

function resolveI18n(v, itemNs) {
  if (!itemNs) return plainify(v, new Set());
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return { text: v };
  if (typeof v === 'function') return { dynamic: true };
  if (v.translationKey) {
    const key = v.translationKey;
    const ci = key.indexOf(':');
    const k2 = ci >= 0 ? key.slice(ci + 1) : key;
    const text = itemNs[k2] ?? null;
    const out = { key };
    if (text != null) out.text = text;
    else out.unresolved = true;
    if (v.params) out.params = plainify(v.params, new Set());
    return out;
  }
  return plainify(v, new Set());
}

function sanitizeFilename(name) {
  let s = String(name).replace(/\|/g, '.').replace(/[/\\:*?"<>]/g, '_').replace(/\s+/g, ' ').trim();
  if (!s) s = '_';
  if (s.length > 90) s = s.slice(0, 90);
  return s;
}

// Restore kind from entries.json ([{id,name}]) (search new format, then legacy folders)
function guessKind(baseDir, name, id) {
  const fname = `${String(id).padStart(5, '0')}_${sanitizeFilename(name)}.json`;
  for (const d of ['entries', 'blocks', 'items']) {
    try {
      const fp = path.join(baseDir, d, fname);
      if (!fs.existsSync(fp)) continue;
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (j.kind) return j.kind;
      return d === 'items' ? 'item' : 'block';
    } catch (_) {}
  }
  return '';
}

// Omit meta for base entries (only {rootName, rootId, metaStr}) and drop null keys as well
function trimMeta(entry) {
  if (!entry.meta || typeof entry.meta !== 'object' || Array.isArray(entry.meta)) return;
  for (const k of Object.keys(entry.meta)) {
    if (entry.meta[k] === null) delete entry.meta[k];
  }
  const keys = Object.keys(entry.meta);
  const baseLike = !entry.meta.metaStr && keys.every((k) => k === 'rootName' || k === 'rootId' || k === 'metaStr');
  if (baseLike) { delete entry.meta; return; }
  if (entry.meta.metaStr === '') delete entry.meta.metaStr;
}

function buildEntry(inst, kind, itemNs) {
  const entry = { id: inst.id, name: inst.name, kind };
  if (itemNs) {
    const dn = resolveI18n(inst.displayName, itemNs);
    if (dn) entry.displayName = dn;
    const desc = resolveI18n(inst.description, itemNs);
    if (desc) entry.description = desc;
  }
  for (const k of Object.keys(inst)) {
    if (/^\d+$/.test(k)) continue;
    if (k === 'displayName' || k === 'description' || k === 'name' || k === 'id') continue;
    const val = plainify(inst[k], new Set());
    if (val !== undefined) entry[k] = val;
  }
  trimMeta(entry);
  return entry;
}

// ============================================================================
// 6. Write to staging (per-entry JSON + id/name map)
// ============================================================================
function writeStagedData(staging, blockInstances, blocksWithAir, items, itemNs) {
  const entryDir = path.join(staging, 'entries');
  fs.mkdirSync(entryDir, { recursive: true });

  const usedNames = new Set();
  let n = 0;
  let nextProgress = 1000;
  const total = blocksWithAir.length + items.length;

  function writeOne(inst, kind, dir) {
    const entry = buildEntry(inst, kind, itemNs);
    const fname = `${String(inst.id).padStart(5, '0')}_${sanitizeFilename(inst.name)}.json`;
    const key = fname;
    if (usedNames.has(key)) throw new Error(`Filename collision: ${key}`);
    usedNames.add(key);
    fs.writeFileSync(path.join(dir, fname), JSON.stringify(entry, null, 2));
    n++;
    if (n >= nextProgress) { logSub(`... ${n}/${total} files`); nextProgress += 1000; }
  }

  for (const b of blockInstances) writeOne(b, 'block', entryDir);
  const airInst = blockInstances.find((b) => b.id === 0);
  if (airInst) {
    writeOne(airInst, 'block', entryDir);
  } else {
    // Air has no instance in the registry (special value id 0), so write a synthetic entry
    const air = { id: 0, name: 'Air', kind: 'block', note: AIR_NOTE };
    fs.writeFileSync(path.join(entryDir, '00000_Air.json'), JSON.stringify(air, null, 2));
    n++;
    if (n >= nextProgress) { logSub(`... ${n}/${total} files`); nextProgress += 1000; }
  }
  for (const it of items) writeOne(it, 'item', entryDir);

  const blocksArr = blocksWithAir.map((b) => ({ id: b.id, name: b.name })).sort((a, b) => a.id - b.id);
  const itemsArr = items.map((it) => ({ id: it.id, name: it.name })).sort((a, b) => a.id - b.id);
  const entriesArr = [...blocksArr, ...itemsArr].sort((a, b) => a.id - b.id);
  fs.writeFileSync(path.join(staging, 'entries.json'), JSON.stringify(entriesArr, null, 2));
  return { n, blocksArr, itemsArr, entriesArr };
}

// ============================================================================
// 7. Integrity checks (no duplicates / contiguous IDs / unified registry comparison)
// ============================================================================
function integrityCheck(blocksWithAir, items, unified) {
  const problems = [];
  const nameCount = new Map();
  for (const { id, name } of [...blocksWithAir, ...items]) {
    if (nameCount.has(name)) problems.push(`duplicate name "${name}": ${nameCount.get(name)} vs ${id}`);
    else nameCount.set(name, id);
  }
  const seenIds = new Set();
  for (const { id } of [...blocksWithAir, ...items]) {
    if (seenIds.has(id)) problems.push(`duplicate id ${id}`);
    seenIds.add(id);
  }
  const allIds = [...seenIds].sort((a, b) => a - b);
  for (let i = 0; i < allIds.length; i++) {
    if (allIds[i] !== i) { problems.push(`id gap/mismatch: expected ${i}, found ${allIds[i]}`); break; }
  }
  let unifiedChecked = 0, unifiedBad = 0;
  if (unified) {
    for (const { id, name } of [...blocksWithAir, ...items]) {
      const u = unified[id];
      if (u && u.name === name) unifiedChecked++;
      else if (!u) { /* the unified registry may not include Air */ }
      else { unifiedBad++; if (unifiedBad <= 5) problems.push(`unified mismatch @${id}: ${u.name} != ${name}`); }
    }
    logSub(`Unified registry comparison: ${unifiedChecked} OK / ${unifiedBad} mismatches`);
  } else {
    logSub('Unified registry not present in this bundle; skipping comparison');
  }
  return problems;
}

// ============================================================================
// 8. Diff (compare with the previous blocks.json / items.json and generate CHANGES.md)
// ============================================================================
function readSnapshot(dir) {
  const e = path.join(dir, 'entries.json');
  if (fs.existsSync(e)) {
    try {
      const entries = JSON.parse(fs.readFileSync(e, 'utf8'));
      return { entries, dir };
    } catch (_) { return null; }
  }
  const b = path.join(dir, 'blocks.json');
  const i = path.join(dir, 'items.json');
  if (!fs.existsSync(b) || !fs.existsSync(i)) return null;
  try {
    return { blocks: JSON.parse(fs.readFileSync(b, 'utf8')), items: JSON.parse(fs.readFileSync(i, 'utf8')), dir };
  } catch (_) { return null; }
}

function mapsFromArrays(snap) {
  if (!snap) return null;
  const nameToId = {}, idToName = {}, kindOf = {};
  if (snap.entries) {
    // entries.json only has [{id,name}], so restore kind from the per-entry JSON
    for (const e of snap.entries) { nameToId[e.name] = e.id; idToName[String(e.id)] = e.name; }
    const baseDir = snap.dir || OUT;
    for (const e of snap.entries) kindOf[e.name] = guessKind(baseDir, e.name, e.id);
    return { nameToId, idToName, kindOf };
  }
  for (const e of snap.blocks || []) { nameToId[e.name] = e.id; idToName[String(e.id)] = e.name; kindOf[e.name] = 'block'; }
  for (const e of snap.items || []) { nameToId[e.name] = e.id; idToName[String(e.id)] = e.name; kindOf[e.name] = 'item'; }
  return { nameToId, idToName, kindOf };
}

function diffNameToId(prev, next) {
  const prevMap = (prev && prev.nameToId) || {};
  const nextMap = (next && next.nameToId) || {};
  const added = [], removed = [], idChanged = [];
  for (const [name, id] of Object.entries(nextMap)) {
    if (!(name in prevMap)) added.push({ name, id });
    else if (prevMap[name] !== id) idChanged.push({ name, from: prevMap[name], to: id });
  }
  for (const [name, id] of Object.entries(prevMap)) {
    if (!(name in nextMap)) removed.push({ name, id });
  }
  added.sort((a, b) => a.id - b.id);
  removed.sort((a, b) => a.id - b.id);
  idChanged.sort((a, b) => a.to - b.to);
  return {
    firstRun: prev == null,
    added, removed, idChanged,
    summary: {
      prevCount: Object.keys(prevMap).length,
      nextCount: Object.keys(nextMap).length,
      added: added.length,
      removed: removed.length,
      idChanged: idChanged.length,
    },
  };
}

function kindOfEntry(snap, name) {
  return snap && snap.kindOf && snap.kindOf[name] ? snap.kindOf[name] : '';
}

// ============================================================================
// Minified prop stabilization
//   The minifier renames internal short props (light colors, model bounds, ...)
//   on every build (KJ->E9, tK->N9, ...), which would churn thousands of entry
//   files per update even when nothing changed. Each renamed key is resolved
//   against the previous extraction by value signature and renamed back to the
//   previous (stable) name, so entry files only change when values change.
// ============================================================================
const SHORT_KEY_RE = /^[A-Za-z]{1,2}\d?$/;

// Identity of an entry across extractions (rootMetaDesc is unique for state variants)
function entryIdent(obj) {
  return (obj && (obj.rootMetaDesc || obj.name)) || null;
}

function stabilizeMinifiedProps(instances, prevOutDir) {
  const tops = [], metas = [];
  for (const inst of instances) {
    if (!inst || typeof inst !== 'object') continue;
    const ident = entryIdent(inst);
    tops.push({ holder: inst, ident });
    if (inst.meta && typeof inst.meta === 'object') metas.push({ holder: inst.meta, ident, parent: inst, key: 'meta' });
  }
  stabilizeMinifiedLevel(tops, prevOutDir, false);
  if (metas.length) stabilizeMinifiedLevel(metas, prevOutDir, true);
}

function stabilizeMinifiedLevel(pairs, prevOutDir, isMeta) {
  const newKeys = new Set();
  for (const p of pairs) {
    for (const k of Object.keys(p.holder)) if (SHORT_KEY_RE.test(k) && k !== 'id') newKeys.add(k);
  }
  if (!newKeys.size) return;

  // previous short-key values: { oldKey: Map<entryIdent, serializedValue> }
  const prevValues = {};
  const prevKeys = new Set();
  const dir = path.join(prevOutDir, 'entries');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const id = entryIdent(j);
        const holder = isMeta ? (j.meta && typeof j.meta === 'object' ? j.meta : null) : j;
        if (!holder || !id) continue;
        for (const k of Object.keys(holder)) {
          if (!SHORT_KEY_RE.test(k) || k === 'id') continue;
          prevKeys.add(k);
          (prevValues[k] = prevValues[k] || new Map()).set(id, JSON.stringify(holder[k]));
        }
      } catch (_) { /* unreadable file -> skip */ }
    }
  }

  const rename = new Map();
  for (const k of newKeys) {
    if (prevKeys.has(k)) continue; // name unchanged since the last extraction
    let best = null;
    for (const old of prevKeys) {
      if (newKeys.has(old)) continue; // old key still exists under its own name
      const oldMap = prevValues[old];
      let total = 0, equal = 0;
      for (const p of pairs) {
        const nv = p.holder[k];
        if (nv === undefined) continue;
        const ov = oldMap.get(p.ident);
        if (ov === undefined) continue;
        total++;
        if (JSON.stringify(nv) === ov) equal++;
      }
      if (total > 0 && equal === total && (!best || total > best.total)) best = { old, total };
      else if (total >= 20 && equal / total >= 0.98 && (!best || total > best.total)) best = { old, total };
    }
    if (best) rename.set(k, best.old);
  }
  if (!rename.size) return;
  logSub(`Stabilized minified prop names (${isMeta ? 'meta' : 'entry'}): ${[...rename].map(([n, o]) => `${n} -> ${o}`).join(', ')}`);
  for (const p of pairs) {
    const keys = Object.keys(p.holder);
    if (!keys.some((k) => rename.has(k))) continue;
    const out = {};
    for (const k of keys) out[rename.has(k) ? rename.get(k) : k] = p.holder[k];
    if (p.parent) { p.parent[p.key] = out; continue; } // frozen meta objects are replaced via the parent entry
    for (const k of keys) delete p.holder[k];
    Object.assign(p.holder, out);
  }
}

// Number of per-entry files whose content differs between the staged data and the current data
function countChangedEntryFiles(stagingDir, outDir) {
  const a = path.join(stagingDir, 'entries');
  const b = path.join(outDir, 'entries');
  if (!fs.existsSync(b)) return null; // no previous data (first extraction)
  let changed = 0;
  for (const f of fs.readdirSync(a)) {
    const pb = path.join(b, f);
    if (!fs.existsSync(pb)) { changed++; continue; }
    try {
      if (!fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(pb))) changed++;
    } catch (_) { changed++; }
  }
  return changed;
}

function fmtList(rows, snap, cap = 300) {
  if (!rows.length) return '_none_';
  const lines = rows.slice(0, cap).map((r) => {
    const kind = kindOfEntry(snap, r.name);
    const tag = kind ? ` (${kind === 'block' ? 'block' : 'item'})` : '';
    if (r.from !== undefined) return `- ${r.name}${tag}: ${r.from} -> **${r.to}**`;
    return `- ${r.name}${tag}: **${r.id}**`;
  });
  if (rows.length > cap) lines.push(`- ...and ${rows.length - cap} more`);
  return lines.join('\n');
}

function sectionBlock(title, rows, snap) {
  if (!rows.length) return null;
  const label = `${title} (${rows.length})`;
  if (rows.length <= INLINE_LIST_MAX) {
    return [`## ${label}`, '', fmtList(rows, snap), ''].join('\n');
  }
  return ['<details>', `<summary>${label}</summary>`, '', fmtList(rows, snap), '', '</details>', ''].join('\n');
}

// Remove the H1 and previous check-status lines before reusing a body as history
function slimHistory(md) {
  return String(md || '')
    .replace(/^# Extraction Change Log\s*\n/, '')
    .replace(/^- (?:Last check:|\d+ entry files? changed \(property values only).*?(?:\n|$)/gm, '')
    .trim();
}

// Insert/replace the "entries still unchanged" status line and keep the last real diff body
function unchangedMarkdown(existing, info = {}) {
  if (!info.bundleHash8 && !info.bundleUrl) return existing; // no bundle info (--skip-fetch) -> keep as is
  const when = new Date().toISOString();
  const b = info.bundleHash8 && info.bundleUrl
    ? `[\`${info.bundleHash8}\`](${info.bundleUrl})`
    : info.bundleHash8 ? `\`${info.bundleHash8}\`` : '(cached bundle)';
  let lastCheck = `- Last check: ${when} — bundle ${b}: entries unchanged since the last update below.`;
  if (info.entryFilesChanged) {
    lastCheck += `\n- ${info.entryFilesChanged} entry file${info.entryFilesChanged === 1 ? '' : 's'} changed (property values only; names and IDs untouched).`;
  }
  if (!existing) {
    return ['# Extraction Change Log', '', lastCheck, '', 'No previous diff recorded (first run with no entry changes).', ''].join('\n');
  }
  const stripped = slimHistory(existing);
  return ['# Extraction Change Log', '', lastCheck, '', stripped, ''].join('\n');
}

function changesMarkdown(diff, info = {}) {
  const s = diff.summary;
  const isZeroDiff = !diff.firstRun && !s.added && !s.removed && !s.idChanged;
  // Bundle unchanged and --skip-fetch: no need to touch CHANGES.md at all
  if (isZeroDiff) return unchangedMarkdown(info.existing, info);
  const L = [];
  L.push('# Extraction Change Log');
  L.push('');
  L.push(`- Run at: ${info.runAt || new Date().toISOString()}`);
  L.push(`- Bundle: ${info.bundleUrl || '(same as previous)'}`);
  if (diff.firstRun) {
    L.push('- Baseline: none (first extraction)');
    L.push(`- Entry count: ${s.nextCount}`);
  } else {
    L.push(`- Entries: ${s.prevCount} -> ${s.nextCount}`);
  }
  L.push('');
  if (!diff.firstRun) {
    L.push('| Type | Count |');
    L.push('|---|---|');
    L.push(`| Added | ${s.added} |`);
    L.push(`| Removed | ${s.removed} |`);
    L.push(`| ID changed | ${s.idChanged} |`);
    L.push('');
    if (s.added) { L.push(sectionBlock('Added', diff.added, info.nextSnap)); L.push(''); }
    if (s.removed) { L.push(sectionBlock('Removed', diff.removed, info.prevSnap)); L.push(''); }
    if (s.idChanged) { L.push(sectionBlock('ID changed', diff.idChanged, info.nextSnap)); L.push(''); }
  }
  const history = slimHistory(info.existing);
  if (history) {
    L.push('<details>');
    L.push('<summary>Older changes</summary>');
    L.push('');
    L.push(history);
    L.push('');
    L.push('</details>');
    L.push('');
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ============================================================================
// 9. README generation
// ============================================================================
function buildReadme({ sourceLabel, extractedAt, blocksArr, itemsArr }) {
  const maxBlockId = blocksArr[blocksArr.length - 1].id;
  const firstItemId = itemsArr[0].id;
  const lastItemId = itemsArr[itemsArr.length - 1].id;
  return `# Bloxd.io Block/Item Data

Source: bloxd.io main bundle (${sourceLabel})
Extracted: ${extractedAt}

Extraction executes the registry-building code inside the bundle on the same JavaScript engine (V8) the game uses.
IDs and properties therefore match the live game (verified against the hardcoded ID table in the bundle).

## Updating

bloxd.io's main bundle is checked automatically by a GitHub Action (\`.github/workflows/update.yml\`) roughly every 5 minutes.
A run compares the bundle URL (its file name embeds a content hash) with \`update-state.json\`; if it changed, the data is
re-extracted and the diff is written to CHANGES.md. A run notes it in CHANGES.md even when the bundle changed but no entries did.
The extraction script \`update.js\` is included at the repository root (single file, zero dependencies, Node >= 18).
Run it manually with \`node update.js\`, \`--force\` (re-extract even if unchanged), or \`--skip-fetch\` (no network).

## Layout

- CHANGES.md : diff produced by the most recent update (added / removed / ID changes)
- entries.json : id↔name map for all entries (block+item) as [{id, name}] (sorted by id, contiguous 0..N)
- entries/     : one JSON per entry (file name starts with the 5-digit zero-padded ID, so name order = ID order; \`kind\` distinguishes block/item)
- update-state.json : internal state for the automatic update (bundle URL/hash of the last extraction)

State variants (orientation, open/closed, growth, charge, etc.) live in the same folder.
File names take the form \`00165_Furnace.meta.rot2.json\` (\`|\` in the original name replaced with \`.\`).
The \`meta\` field (rootName / rootId / metaStr) refers back to the base entry.

## ID Scheme

- 0 = Air (special value). 1 = Unloaded (unloaded chunk).
- Blocks: 0..${maxBlockId} / Items: ${firstItemId}..${lastItemId}
- Blocks and items share one contiguous ID space (items start at the highest block ID + 1).

## Common Fields (all entries)

| Field | Meaning |
|---|---|
| id / name / kind | Numeric ID / canonical name (for the API) / block or item |
| displayName | Display name. key=translation key, text=English display name (unresolved if lookup fails) |
| description | Description (same structure as displayName) |
| meta | State variant info {rootName, rootId, metaStr, rot, open, ...}. Null keys are removed; omitted for base entries |
| rootMetaDesc | Fully qualified variant name (e.g. "Loot Chest|meta|rot4") |
| stackable | Whether the item is stackable |

## Block Fields

| Field | Meaning |
|---|---|
| ttb | Time To Break (ms) |
| harvestType | Break type such as granule / wood / rock / cuttable |
| harvestLevel | Required tool tier |
| drops | Drops when broken (omitted = itself, null = no drops) |
| specialToolDrop | {tool, drops} special drop for a specific tool |
| specialToolBonusDrops | {tool: [{bonusDrop, probabilityOfDrop}]} bonus drops |
| textureInfo | Texture name. Array = per face. RGBA number array = solid color (e.g. Water) |
| texturePerSide | Texture assignment index for the 6 faces |
| atlasIdx | Index in the texture atlas (array for animations) |
| model | Render model such as CentreCross / rotatable / SquareSided / CustomModel |
| solid | Whether the block has collision |
| soundType | {break, place} break/place sounds |
| damage | Damage on contact (e.g. cactus) |
| stoodOnSpeedMultiplier | Movement speed multiplier while standing on the block |
| canBePlacedOver / attachedTop / slabFullBlock | Placement behavior flags |
| onMinedAura | Particle color when mined |
| kV | Door/trapdoor state -> mesh mapping |

## Item Fields

| Field | Meaning |
|---|---|
| type | Classification such as Gun / Tool / Chargeable |
| weight | Carried weight |
| damage / attackRange / secondaryDamage | Weapon damage / attack range |
| harvests / multiplier / level | Tool targets, speed multiplier, tier |
| armourReduction / knockbackReduction | Armour stats |
| eatable / eatHealAmt / afterEatenItem | Food stats |
| chargeTime / chargeStages / chargeSound | Charge behavior |
| fireRate / reloadTime / clipSize / inaccuracy* / kickback* / scopeType | Gun stats |
| fishingRodInfo / comboInfo / dashImpulse | Special action parameters |
| heldItemGlb / textureInfo | Held 3D model / texture |

## Notes

- displayName.text is resolved from the English table embedded in the bundle (other languages are fetched separately at game startup and are not included)
- atlasIdx is auxiliary info that can change with the texture pack configuration at runtime
- meta is output with null keys removed (base entries omit meta entirely)
`;
}

// ============================================================================
// 10. Main
// ============================================================================
async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`Bloxd.io data update script

Usage:
  node update.js              check the latest bundle and update this folder if it changed
  node update.js --force      re-extract even if the bundle is the same as last time
  node update.js --skip-fetch re-extract from the downloaded bundle (no network)

Files updated: entries.json / entries/ / README.md / CHANGES.md`);
    return;
  }

  console.log('Bloxd.io data update');
  console.log('Target folder: ' + OUT);

  const prevRepoState = readRepoState(); // committed state, read before anything is touched

  // ---------- 1. Bundle ----------
  let fetchInfo = null;
  let chunkFiles = [];
  if (SKIP_FETCH) {
    logStep('Using cached bundle (--skip-fetch)');
    if (!fs.existsSync(SRC_PATH)) throw new Error('No bundle in cache. Re-run without --skip-fetch');
    logSub(`Using: ${SRC_PATH} (${(fs.statSync(SRC_PATH).size / 1e6).toFixed(1)} MB)`);
    const chunkMap = findChunkMap(fs.readFileSync(SRC_PATH, 'utf8'));
    if (chunkMap) chunkFiles = existingChunkFiles(chunkMap);
  } else {
    fetchInfo = await fetchLatestBundle();
    chunkFiles = (fetchInfo && fetchInfo.chunkFiles) || [];
  }
  const changed = fetchInfo ? fetchInfo.changed : true;
  const prevSnap = readSnapshot(OUT);
  if (!changed && !FORCE && prevSnap) {
    console.log('\nBundle is unchanged since the last run -> nothing to do (use --force to re-extract)');
    return;
  }

  const state = readState();
  const sourceLabel = fetchInfo ? fetchInfo.file : (state.lastBundleFile || path.basename(SRC_PATH));
  const extractedAt = new Date().toISOString();

  // ---------- 2. Extraction ----------
  logStep('Parsing the bundle and extracting registries');
  const { modules, mainSrc, chunkSrcs } = await loadModuleTable(SRC_PATH, chunkFiles);
  const itemNs = findItemTranslations([mainSrc, ...chunkSrcs]);
  if (itemNs) logSub(`English translation table: ${Object.keys(itemNs).length} keys`);
  else logSub('Warning: English translation table not found (displayName/description omitted)');

  const extractor = createExtractor(mainSrc, modules, chunkSrcs);
  logSub(`webpack modules: ${Object.keys(extractor.modules).length}`);
  const block = extractor.loadBlockRegistry();
  const blockRegistry = block.registry;
  const maxBlockId = extractor.registryMaxId(blockRegistry);
  const item = extractor.loadItemRegistries(maxBlockId, block.id);
  logSub(`Blocks: module #${block.id} (max ID ${maxBlockId}) / Items: module #${item.id}`);

  const blockInstances = [];
  const blocksWithAir = [];
  for (let id = 0; id <= maxBlockId; id++) {
    const inst = blockRegistry[id];
    if (inst && typeof inst.name === 'string') { blockInstances.push(inst); blocksWithAir.push(inst); }
    else if (id === 0) blocksWithAir.push({ id: 0, name: 'Air' });
  }
  const items = [];
  for (const key of Object.keys(item.itemRegistry)) {
    if (/^\d+$/.test(key)) continue;
    const inst = item.itemRegistry[key];
    if (!inst || typeof inst !== 'object') continue;
    items.push(inst);
  }
  items.sort((a, b) => a.id - b.id);
  logSub(`Blocks ${blocksWithAir.length} (+Air) / Items ${items.length}`);

  // ---------- 3. Integrity checks ----------
  logStep('Integrity checks');
  const problems = integrityCheck(blocksWithAir, items, item.unified);
  extractor.validateAgainstHardcodedMap(Object.fromEntries(blocksWithAir.map((b) => [b.name, b.id])));
  if (problems.length) throw new Error('Integrity check failed:\n  ' + problems.join('\n  '));
  logSub('IDs/names: OK (no duplicates, contiguous)');

  // ---------- 4. Write to staging ----------
  logStep('Writing per-entry JSON (temp folder)');
  stabilizeMinifiedProps([...blockInstances, ...items], OUT);
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  const staged = writeStagedData(STAGING, blockInstances, blocksWithAir, items, itemNs);
  logSub(`${staged.n} files total`);

  // ---------- 5. ID/name map + README + CHANGES ----------
  logStep('Building the id/name map, README, and diff');
  const readme = buildReadme({ sourceLabel, extractedAt, blocksArr: staged.blocksArr, itemsArr: staged.itemsArr });
  fs.writeFileSync(path.join(STAGING, 'README.md'), readme);

  const prevMaps = mapsFromArrays(prevSnap);
  const nextMaps = mapsFromArrays({ blocks: staged.blocksArr, items: staged.itemsArr, dir: STAGING });
  const diff = diffNameToId(prevMaps, nextMaps);
  const s = diff.summary;
  const isZeroDiff = !diff.firstRun && !s.added && !s.removed && !s.idChanged;
  const entryFilesChanged = countChangedEntryFiles(STAGING, OUT); // property-level changes the name/ID diff cannot see
  const info = bundleInfo(fetchInfo); // current bundle {url, file, sha256, hash8}
  const existingChanges = fs.existsSync(path.join(OUT, 'CHANGES.md'))
    ? fs.readFileSync(path.join(OUT, 'CHANGES.md'), 'utf8')
    : null;
  const md = changesMarkdown(diff, {
    runAt: extractedAt,
    bundleUrl: info ? `${info.url}` : null,
    bundleHash8: info ? info.hash8 : null,
    prevSnap: prevMaps,
    nextSnap: nextMaps,
    existing: existingChanges,
    entryFilesChanged,
  });
  fs.writeFileSync(path.join(STAGING, 'CHANGES.md'), md);
  if (diff.firstRun) logSub('No baseline (first extraction)');
  else if (isZeroDiff) logSub(`Bundle changed but entries are unchanged -> CHANGES.md gets a status note only` + (entryFilesChanged ? ` (${entryFilesChanged} entry files have property updates)` : ''));
  else logSub(`Diff: added ${s.added} / removed ${s.removed} / ID changed ${s.idChanged}`);

  // ---------- 6. Swap in ----------
  logStep('Swapping in the data');
  // README is identical whenever the entry registry is unchanged -> skip to avoid timestamp churn
  const swapTargets = isZeroDiff ? ['entries', 'entries.json', 'CHANGES.md'] : ['entries', 'entries.json', 'README.md', 'CHANGES.md'];
  for (const a of swapTargets) {
    const dst = path.join(OUT, a);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(path.join(STAGING, a), dst);
    logSub(`Updated: ${a}`);
  }
  // Delete legacy layout files if present and migrate to the unified format
  for (const a of ['blocks', 'items', 'blocks.json', 'items.json']) {
    const dst = path.join(OUT, a);
    if (fs.existsSync(dst)) { fs.rmSync(dst, { recursive: true, force: true }); logSub(`Deleted legacy: ${a}`); }
  }
  fs.rmSync(STAGING, { recursive: true, force: true });

  try {
    const st = readState();
    st.lastRunAt = extractedAt;
    st.lastExtract = { blocks: staged.blocksArr.length, items: staged.itemsArr.length, files: staged.n };
    writeState(st);
  } catch (_) {}

  try {
    writeRepoState({
      lastBundle: {
        file: info ? info.file : null,
        url: info ? info.url : null,
        sha256: info ? info.sha256 : null,
      },
      lastDiff: isZeroDiff && prevRepoState && prevRepoState.lastDiff ? prevRepoState.lastDiff : {
        prevCount: s.prevCount,
        nextCount: s.nextCount,
        added: s.added,
        removed: s.removed,
        idChanged: s.idChanged,
      },
      lastRunAt: extractedAt,
    });
  } catch (_) {}

  // Optional JSON summary for CI (not written unless the caller sets the env var)
  if (process.env.BLOXD_UPDATE_OUT) {
    try {
      fs.writeFileSync(process.env.BLOXD_UPDATE_OUT, JSON.stringify({
        runAt: extractedAt,
        firstRun: !!diff.firstRun,
        prevCount: s.prevCount,
        nextCount: s.nextCount,
        added: s.added,
        removed: s.removed,
        idChanged: s.idChanged,
        entryFilesChanged: entryFilesChanged || 0,
        bundle: {
          url: info ? info.url : null,
          file: info ? info.file : null,
          hash8: info ? info.hash8 : null,
          sha256: info ? info.sha256 : null,
        },
      }, null, 2));
    } catch (_) {}
  }

  console.log('\n==========================================');
  console.log(`Done: blocks ${staged.blocksArr.length} / items ${staged.itemsArr.length} / per-entry JSON ${staged.n}`);
  console.log(diff.firstRun ? 'Diff vs previous: (first extraction)' : `Diff vs previous: added ${s.added} / removed ${s.removed} / ID changed ${s.idChanged}`);
  console.log(`Elapsed: ${elapsed()}`);
  console.log('==========================================');
}

main().catch((e) => {
  try { fs.rmSync(STAGING, { recursive: true, force: true }); } catch (_) {}
  console.error(`\n[update] failed: ${e.message}`);
  process.exit(1);
});
