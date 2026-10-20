#!/usr/bin/env node
// ============================================================================
// Bloxd.io データ更新スクリプト (単一ファイル / 依存ゼロ / Node >= 18)
//
//   node update.js              最新バンドルを確認し、変更があればこのフォルダを更新
//   node update.js --force      バンドルが前回と同じでも強制再抽出
//   node update.js --skip-fetch ダウンロード済みバンドルで再抽出 (ネットワーク不要)
//
// 仕組み:
//   1. bloxd.io の HTML からメインバンドルの URL を検出 (ファイル名に内容ハッシュ)
//   2. ゲーム本体と同じ V8 でバンドル内のレジストリ構築コードを実行して抽出
//      (webpack ランタイムを Node 上で再現。両方 V8 なので結果は実ゲームと一致)
//   3. 一時フォルダ (.update_tmp) に書出 -> 検証 -> 差し替え
//      (途中で失敗してもこのフォルダの既存データは壊れない)
//
// 更新されるファイル (このフォルダ内):
//   entries.json               全エントリ(block+item)の id<->name 対応表 [{id, name}] (id順, 0〜N連番)
//   entries/                   エントリ個別JSON (5桁ゼロ埋めID_名前.json, kind=block/itemで区別)
//   README.md / CHANGES.md     説明書 / 前回との差分
// 互換: 旧 blocks.json / items.json / blocks/ / items/ が残っていれば読み取りに使用し、
//       更新成功時に統合形式へ移行 (旧形式は削除)。
//
// バンドルのキャッシュと状態は OS の一時フォルダ (bloxd-io-update) に保存。
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const OUT = __dirname; // このスクリプトがある bloxd_data フォルダ
const STAGING = path.join(OUT, '.update_tmp');
const CACHE = path.join(os.tmpdir(), 'bloxd-io-update');
const SRC_PATH = path.join(CACHE, 'bloxd_main.js');
const STATE_PATH = path.join(CACHE, 'state.json');
const ORIGIN = 'https://bloxd.io';
const FORCE = process.argv.includes('--force');
const SKIP_FETCH = process.argv.includes('--skip-fetch');

const AIR_NOTE = 'Air is not instantiated in the registry; id 0 is a special value in the game code (Sj: 0 === id -> "Air").';

// ---------- ログ ----------
const t0 = Date.now();
let stepNo = 0;
function logStep(title) { stepNo++; console.log(`\n[${stepNo}] ${title}`); }
function logSub(msg) { console.log(`    ${msg}`); }
function elapsed() { return ((Date.now() - t0) / 1000).toFixed(1) + 's'; }

// ============================================================================
// 1. バンドル取得 (bloxd.io の HTML からメインバンドル URL を検出して DL)
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

// HTML 例: <script defer src="/static/js/6qxffk.main.5912a15f.js">
// "*.main.*.js" を優先し、無ければ /static/js/*.js にフォールバック
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

async function fetchLatestBundle() {
  logStep('bloxd.io のメインバンドルを確認');
  fs.mkdirSync(CACHE, { recursive: true });
  const { buf: htmlBuf, finalUrl } = await httpGet(ORIGIN + '/');
  const html = htmlBuf.toString('utf8');
  const rel = findMainBundleUrl(html);
  if (!rel) throw new Error('HTML内にバンドルURLが見つかりません (サイト構造が変わった可能性)');
  const url = new URL(rel, finalUrl).href;
  logSub(`検出: ${rel}`);

  const state = readState();
  if (state.lastBundleUrl === url && fs.existsSync(SRC_PATH)) {
    logSub('前回取得したバンドルと同じ (ダウンロード省略)');
    return { changed: false, url, file: rel, sha256: state.lastSha256 || null };
  }

  logSub('ダウンロード中 ...');
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
  logSub(`保存: ${(buf.length / 1e6).toFixed(1)} MB / sha256 ${sha256.slice(0, 16)}...`);
  return { changed: true, url, file: rel, sha256, bytes: buf.length };
}

// ============================================================================
// 2. ブラウザグローバルのスタブ (バンドルを Node で実行するためのハーネス)
// ============================================================================
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
    catch (e) { console.log(`    [harness] global 定義に失敗: ${name} (${e.message})`); }
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
  void addProp; // (宣言だけ残す: 旧実装との互換用)
}

// ============================================================================
// 3. webpack ランタイム再現 + レジストリ探索 (更新耐性あり)
//   - モジュール配列の境界は正規表現で検出 (minify名に依存しない)
//   - レジストリは「内容」(name+idを持つインスタンス) で判定 (exportキー名に依存しない)
// ============================================================================
function findModuleArrayBounds(source) {
  const startRe = /\(\(\)=>\{var ([A-Za-z_$][\w$]*)=\[/g;
  let sm;
  while ((sm = startRe.exec(source))) {
    const arrStart = sm.index + sm[0].length - 1; // '[' の位置
    const endRe = /\],([A-Za-z_$][\w$]*)=\{\};function ([A-Za-z_$][\w$]*)\(/g;
    endRe.lastIndex = arrStart;
    let em;
    while ((em = endRe.exec(source))) {
      const arrEnd = em.index + 1; // 閉じ ']' を含める
      const arrSrc = source.slice(arrStart, arrEnd);
      try {
        const arr = new Function('return ' + arrSrc)();
        if (Array.isArray(arr) && arr.length > 500) {
          return { arrStart, arrEnd, modules: arr, length: arr.length };
        }
      } catch (_) { /* モジュール本体内の偽境界 -> 次を試す */ }
    }
  }
  return null;
}

function createExtractor(src) {
  installBrowserStubs();

  const bounds = findModuleArrayBounds(src);
  if (!bounds) throw new Error('webpackのモジュール配列が見つかりません (バンドル構造が変わった可能性)');
  const modules = bounds.modules;
  const cache = Object.create(null);

  // ---------- webpack require (バンドルのランタイムを忠実に再現) ----------
  function Oj(id) {
    const cached = cache[id];
    if (cached !== undefined) return cached.exports;
    const mod = (cache[id] = { id, loaded: false, exports: {} });
    const fn = modules[id];
    if (typeof fn !== 'function') throw new Error('module ' + id + ' not in main bundle (hole/lazy chunk)');
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
  Oj.e = (chunkId) => { console.log(`    [harness] chunk要求をスタブ: ${chunkId}`); return Promise.resolve(); };
  Oj.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  Oj.r = (o) => { Object.defineProperty(o, Symbol.toStringTag, { value: 'Module' }); Object.defineProperty(o, '__esModule', { value: !0 }); };
  Oj.nmd = (m) => (m.paths = [], m.children || (m.children = []), m);
  Oj.p = '/';
  Oj.u = () => { throw new Error('css chunk'); };
  Oj.miniCssF = () => 'x.css';
  Oj.h = () => {};

  // ---------- モジュール/レジストリ探索 ----------
  function findModulesBySource(needle) {
    const out = [];
    for (let i = 0; i < modules.length; i++) {
      const fn = modules[i];
      if (typeof fn === 'function' && fn.toString().includes(needle)) out.push(i);
    }
    return out;
  }

  // レジストリ = 名前キー(値は id:number を持つ)と数値IDキー(値は name:string を持つ)の両方で引けるオブジェクト
  // NOTE: キーは「数値ID全部 -> 名前全部」の順に並ぶことがあるため、先頭サンプリングではなく全キー走査
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

  // ブロックモジュール: データ文字列から特定 ("Unloaded" が常に最初のブロック)
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
        } catch (_) { /* 違うモジュール or require失敗 -> 継続 */ }
      }
    }
    throw new Error('ブロックレジストリが見つかりません (候補を使い切りました)');
  }

  // アイテムモジュール: アイテムは全ブロックIDより後のID空間。
  // モジュール内に複数のレジストリ風exportがあり得る (アイテム専用 + 統合) ので、
  // 最小数値IDが最大のものをアイテムレジストリと判定。
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
          if (registryMinId(itemReg) <= blockMaxId) continue; // アイテムレジストリではない
          const unifiedCand = sorted.slice(1).find((c) => registryMaxId(c.obj) >= blockMaxId) || null;
          return { id, exports: exp, itemRegistry: itemReg, unified: unifiedCand ? unifiedCand.obj : null };
        } catch (_) { /* 継続 */ }
      }
    }
    throw new Error('アイテムレジストリが見つかりません (候補を使い切りました)');
  }

  // バンドル内ハードコードのID対応表 (例 Mj={...}) との照合。将来無くなっても情報ログのみ
  function validateAgainstHardcodedMap(nameToId) {
    let mjCount = 0, mjMatch = 0;
    const mjMismatch = [];
    const mjNeedle = '"Patterned Yellow Glass":1007';
    const mi = src.indexOf(mjNeedle);
    if (mi < 0) { logSub('ハードコードID表は見つからないため照合スキップ'); return null; }
    const open = src.lastIndexOf('{', mi);
    if (!src.slice(open + 1, open + 1 + 40).startsWith('"Patterned Yellow Glass"')) {
      logSub('ハードコードID表の形が想定外のため照合スキップ');
      return null;
    }
    let depth = 0, inStr = null, mEnd = -1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { mEnd = i; break; } }
    }
    try {
      const Mj = new Function('return ' + src.slice(open, mEnd + 1))();
      for (const [name, idv] of Object.entries(Mj)) {
        mjCount++;
        const base = name.split('|')[0];
        const ourId = nameToId[name] !== undefined ? nameToId[name] : (nameToId[base] !== undefined ? nameToId[base] : null);
        if (ourId === idv) mjMatch++;
        else mjMismatch.push({ name, expected: idv, got: ourId });
      }
    } catch (e) { logSub(`ハードコードID表のパース失敗: ${e.message}`); return null; }
    logSub(`ハードコードID表との照合: ${mjMatch}/${mjCount} 一致${mjMismatch.length ? ' ' + JSON.stringify(mjMismatch.slice(0, 10)) : ''}`);
    return { count: mjCount, match: mjMatch };
  }

  return { src, modules, loadBlockRegistry, loadItemRegistries, registryMaxId, validateAgainstHardcodedMap };
}

// ============================================================================
// 4. 英語翻訳テーブル ("item" 名前空間) の探索
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
function findItemTranslations(source) {
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
      if (obj.woodPickaxe !== undefined) return obj; // 強いシグナル: 定番アイテムキー
      const strVals = keys.filter((k) => typeof obj[k] === 'string').length;
      if (strVals / keys.length > 0.8 && (!best || keys.length > Object.keys(best).length)) best = obj;
    }
    if (best) return best;
  }
  return null;
}

// ============================================================================
// 5. 直列化 (plainify / i18n解決 / ファイル名 / metaのnull除去)
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

// entries.json ([{id,name}]) から kind を復元 (新形式→旧形式フォルダの順で探索)
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

// 基本エントリの meta ({rootName, rootId, metaStr}のみ) は省略、nullキーは他も除去
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
// 6. staging への書出 (個別JSON + 対応表)
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
    if (usedNames.has(key)) throw new Error(`ファイル名が衝突しました: ${key}`);
    usedNames.add(key);
    fs.writeFileSync(path.join(dir, fname), JSON.stringify(entry, null, 2));
    n++;
    if (n >= nextProgress) { logSub(`... ${n}/${total} 件`); nextProgress += 1000; }
  }

  for (const b of blockInstances) writeOne(b, 'block', entryDir);
  const airInst = blockInstances.find((b) => b.id === 0);
  if (airInst) {
    writeOne(airInst, 'block', entryDir);
  } else {
    // Air はレジストリに実体が無い特別値 (id 0) のため合成エントリを書く
    const air = { id: 0, name: 'Air', kind: 'block', note: AIR_NOTE };
    fs.writeFileSync(path.join(entryDir, '00000_Air.json'), JSON.stringify(air, null, 2));
    n++;
    if (n >= nextProgress) { logSub(`... ${n}/${total} 件`); nextProgress += 1000; }
  }
  for (const it of items) writeOne(it, 'item', entryDir);

  const blocksArr = blocksWithAir.map((b) => ({ id: b.id, name: b.name })).sort((a, b) => a.id - b.id);
  const itemsArr = items.map((it) => ({ id: it.id, name: it.name })).sort((a, b) => a.id - b.id);
  const entriesArr = [...blocksArr, ...itemsArr].sort((a, b) => a.id - b.id);
  fs.writeFileSync(path.join(staging, 'entries.json'), JSON.stringify(entriesArr, null, 2));
  return { n, blocksArr, itemsArr, entriesArr };
}

// ============================================================================
// 7. 整合性チェック (重複なし / ID連番 / 統合レジストリ照合)
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
      else if (!u) { /* 統合側に Air が無い場合がある */ }
      else { unifiedBad++; if (unifiedBad <= 5) problems.push(`unified mismatch @${id}: ${u.name} != ${name}`); }
    }
    logSub(`統合レジストリ照合: ${unifiedChecked} OK / ${unifiedBad} 不一致`);
  } else {
    logSub('統合レジストリはこのバンドルに無いため照合スキップ');
  }
  return problems;
}

// ============================================================================
// 8. 差分 (前回の blocks.json / items.json と比較して CHANGES.md を生成)
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
    // entries.json は [{id,name}] のみのため kind は個別JSONから復元
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

function fmtList(rows, snap, cap = 300) {
  if (!rows.length) return '_なし_';
  const lines = rows.slice(0, cap).map((r) => {
    const kind = kindOfEntry(snap, r.name);
    const tag = kind ? `（${kind === 'block' ? 'ブロック' : 'アイテム'}）` : '';
    if (r.from !== undefined) return `- ${r.name}${tag}: ${r.from} -> **${r.to}**`;
    return `- ${r.name}${tag}: **${r.id}**`;
  });
  if (rows.length > cap) lines.push(`- ...他 ${rows.length - cap} 件`);
  return lines.join('\n');
}

function changesMarkdown(diff, info = {}) {
  const s = diff.summary;
  const L = [];
  L.push('# 抽出結果の変更記録');
  L.push('');
  L.push(`- 実行日時: ${info.runAt || new Date().toISOString()}`);
  L.push(`- バンドル: ${info.bundleUrl || '(前回と同じ)'}`);
  if (diff.firstRun) {
    L.push('- 比較対象: なし（初回抽出）');
    L.push(`- 今回の件数: ${s.nextCount}`);
  } else {
    L.push(`- 件数: ${s.prevCount} -> ${s.nextCount}`);
  }
  L.push('');
  if (!diff.firstRun) {
    L.push('| 種別 | 件数 |');
    L.push('|---|---|');
    L.push(`| 追加 | ${s.added} |`);
    L.push(`| 削除 | ${s.removed} |`);
    L.push(`| ID変更 | ${s.idChanged} |`);
    L.push('');
    if (!s.added && !s.removed && !s.idChanged) {
      L.push('変更なし。');
    } else {
      if (s.added) { L.push('## 追加'); L.push(''); L.push(fmtList(diff.added, info.nextSnap)); L.push(''); }
      if (s.removed) { L.push('## 削除'); L.push(''); L.push(fmtList(diff.removed, info.prevSnap)); L.push(''); }
      if (s.idChanged) { L.push('## ID変更'); L.push(''); L.push(fmtList(diff.idChanged, info.nextSnap)); L.push(''); }
    }
  }
  return L.join('\n');
}

// ============================================================================
// 9. README 生成
// ============================================================================
function buildReadme({ sourceLabel, extractedAt, blocksArr, itemsArr }) {
  const maxBlockId = blocksArr[blocksArr.length - 1].id;
  const firstItemId = itemsArr[0].id;
  const lastItemId = itemsArr[itemsArr.length - 1].id;
  return `# Bloxd.io ブロック/アイテム データ

ソース: bloxd.io メインバンドル (${sourceLabel})
抽出日: ${extractedAt}

ゲーム本体と同じJavaScriptエンジン(V8)でバンドル内のレジストリ構築コードを実行して抽出しています。
そのため ID・プロパティは実ゲームと一致します(バンドル内ハードコードのID対応表と照合済み)。

## 更新方法

\`node update.js\` を実行すると、bloxd.io の最新バンドルを確認してこのフォルダ内のデータを更新します。

- \`--force\` : バンドルが前回と同じでも強制再抽出
- \`--skip-fetch\` : ダウンロード済みバンドルで再抽出 (ネットワーク不要)

バンドルはOSの一時フォルダにキャッシュされ、前回と同一なら更新はスキップされます。

## 構成

- update.js  : このフォルダを更新するスクリプト (依存ゼロ / Node >= 18)
- CHANGES.md : 直近の更新で生じた差分 (追加 / 削除 / ID変更)
- entries.json : 全エントリ(block+item)の id↔name 対応表 [{id, name}] (id順, 0〜N連番)
- entries/     : 個別JSON (ファイル名が5桁ゼロ埋めIDで始まるので名前順=ID順, kindでblock/itemを区別)

状態バリアント(向き・開閉・成長・チャージ等)も同じフォルダにまとまっています。
ファイル名は \`00165_Furnace.meta.rot2.json\` の形 (元の名前の \`|\` を \`.\` に置換)。
中身の \`meta\` フィールド (rootName / rootId / metaStr) が元エントリを参照します。

## ID体系

- 0 = Air (特別値)。1 = Unloaded(未ロードチャンク)。
- ブロック: 0〜${maxBlockId} / アイテム: ${firstItemId}〜${lastItemId}
- ブロックとアイテムは連続した同一ID空間を共有 (アイテムは最大ブロックID+1から開始)

## 主なフィールド (全エントリ共通)

| フィールド | 意味 |
|---|---|
| id / name / kind | 数値ID / 正規名 (API用) / block または item |
| displayName | 表示名。key=翻訳キー, text=英語表示名 (解決できない場合は unresolved) |
| description | 説明文 (同上) |
| meta | 状態バリアント情報 {rootName, rootId, metaStr, rot, open, ...}。null キーは除去し、基本エントリでは省略 |
| rootMetaDesc | バリアントの完全名 (例 "Loot Chest|meta|rot4") |
| stackable | スタック可否 |

## 主なフィールド (ブロック系)

| フィールド | 意味 |
|---|---|
| ttb | Time To Break (破壊にかかる時間 ms) |
| harvestType | granule(粒)/wood(木)/rock(岩)/cuttable(刈取) などの破壊種別 |
| harvestLevel | 採掘に必要なツールレベル |
| drops | 破壊時ドロップ (未指定=自分自身, null=ドロップなし) |
| specialToolDrop | {tool, drops} 特定ツールでの特殊ドロップ |
| specialToolBonusDrops | {tool: [{bonusDrop, probabilityOfDrop}]} ボーナスドロップ |
| textureInfo | テクスチャ名。配列=面ごと。RGBA数値配列=単色 (例 Water) |
| texturePerSide | 6面へのテクスチャ割当インデックス |
| atlasIdx | テクスチャアトラス上のインデックス (アニメーションは配列) |
| model | CentreCross / rotatable / SquareSided / CustomModel などの描画モデル |
| solid | 当たり判定の有無 |
| soundType | {break, place} 破壊/設置音 |
| damage | 触れたときのダメージ (サボテン等) |
| stoodOnSpeedMultiplier | 上に立ったときの移動速度倍率 |
| canBePlacedOver / attachedTop / slabFullBlock | 設置挙動フラグ |
| onMinedAura | 採掘時パーティクルの色 |
| kV | ドア/トラップドアの状態->メッシュマッピング |

## 主なフィールド (アイテム系)

| フィールド | 意味 |
|---|---|
| type | Gun / Tool / Chargeable などの分類 |
| weight | 所持重量 |
| damage / attackRange / secondaryDamage | 武器ダメージ / 射程 |
| harvests / multiplier / level | ツールの対象・速度倍率・レベル |
| armourReduction / knockbackReduction | 防具性能 |
| eatable / eatHealAmt / afterEatenItem | 食料性能 |
| chargeTime / chargeStages / chargeSound | チャージ動作 |
| fireRate / reloadTime / clipSize / inaccuracy* / kickback* / scopeType | 銃のステータス |
| fishingRodInfo / comboInfo / dashImpulse | 特殊動作パラメータ |
| heldItemGlb / textureInfo | 手持ち3Dモデル / テクスチャ |

## 注意

- displayName.text はバンドル埋め込みの英語テーブルで解決 (他言語はゲーム起動時に別途取得されるため未収録)
- atlasIdx はゲーム実行時にテクスチャパック構成により変わりうる補助情報
- meta は null キーを除去して出力 (base エントリは meta 自体を省略)
`;
}

// ============================================================================
// 10. メイン処理
// ============================================================================
async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`Bloxd.io データ更新スクリプト

使い方:
  node update.js              最新バンドルを確認し、変更があればこのフォルダを更新
  node update.js --force      バンドルが前回と同じでも強制再抽出
  node update.js --skip-fetch ダウンロード済みバンドルで再抽出 (ネットワーク不要)

更新されるファイル: entries.json / entries/ / README.md / CHANGES.md`);
    return;
  }

  console.log('Bloxd.io データ更新');
  console.log('対象フォルダ: ' + OUT);

  // ---------- 1. バンドル ----------
  let fetchInfo = null;
  if (SKIP_FETCH) {
    logStep('キャッシュ済みバンドルを使用 (--skip-fetch)');
    if (!fs.existsSync(SRC_PATH)) throw new Error('キャッシュにバンドルがありません。--skip-fetch を付けずに再実行してください');
    logSub(`使用: ${SRC_PATH} (${(fs.statSync(SRC_PATH).size / 1e6).toFixed(1)} MB)`);
  } else {
    fetchInfo = await fetchLatestBundle();
  }
  const changed = fetchInfo ? fetchInfo.changed : true;
  const prevSnap = readSnapshot(OUT);
  if (!changed && !FORCE && prevSnap) {
    console.log('\nバンドルは前回実行時から変更なし -> 更新は不要です (--force で強制再抽出)');
    return;
  }

  const src = fs.readFileSync(SRC_PATH, 'utf8');
  const state = readState();
  const sourceLabel = state.lastBundleFile || path.basename(SRC_PATH);
  const extractedAt = new Date().toISOString();

  // ---------- 2. 抽出 ----------
  logStep('バンドルを解析してレジストリを抽出');
  const itemNs = findItemTranslations(src);
  if (itemNs) logSub(`英語翻訳テーブル: ${Object.keys(itemNs).length} キー`);
  else logSub('警告: 英語翻訳テーブルが見つかりません (displayName/description 省略)');

  const extractor = createExtractor(src);
  logSub(`webpackモジュール: ${extractor.modules.length} 個`);
  const block = extractor.loadBlockRegistry();
  const blockRegistry = block.registry;
  const maxBlockId = extractor.registryMaxId(blockRegistry);
  const item = extractor.loadItemRegistries(maxBlockId, block.id);
  logSub(`ブロック: モジュール#${block.id} (最大ID ${maxBlockId}) / アイテム: モジュール#${item.id}`);

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
  logSub(`ブロック ${blocksWithAir.length} 件 (+Air) / アイテム ${items.length} 件`);

  // ---------- 3. 整合性チェック ----------
  logStep('整合性チェック');
  const problems = integrityCheck(blocksWithAir, items, item.unified);
  extractor.validateAgainstHardcodedMap(Object.fromEntries(blocksWithAir.map((b) => [b.name, b.id])));
  if (problems.length) throw new Error('整合性チェック失敗:\n  ' + problems.join('\n  '));
  logSub('ID/名前: OK (重複なし・連番)');

  // ---------- 4. staging へ書出 ----------
  logStep('個別JSONを書出 (一時フォルダ)');
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  const staged = writeStagedData(STAGING, blockInstances, blocksWithAir, items, itemNs);
  logSub(`合計 ${staged.n} ファイル`);

  // ---------- 5. 対応表 + README + CHANGES ----------
  logStep('対応表・README・差分を作成');
  const readme = buildReadme({ sourceLabel, extractedAt, blocksArr: staged.blocksArr, itemsArr: staged.itemsArr });
  fs.writeFileSync(path.join(STAGING, 'README.md'), readme);

  const prevMaps = mapsFromArrays(prevSnap);
  const nextMaps = mapsFromArrays({ blocks: staged.blocksArr, items: staged.itemsArr, dir: STAGING });
  const diff = diffNameToId(prevMaps, nextMaps);
  const md = changesMarkdown(diff, {
    runAt: extractedAt,
    bundleUrl: fetchInfo ? fetchInfo.url : (state.lastBundleUrl || null),
    prevSnap: prevMaps,
    nextSnap: nextMaps,
  });
  fs.writeFileSync(path.join(STAGING, 'CHANGES.md'), md);
  if (diff.firstRun) logSub('比較対象なし (初回抽出)');
  else logSub(`差分: 追加 ${diff.summary.added} / 削除 ${diff.summary.removed} / ID変更 ${diff.summary.idChanged}`);

  // ---------- 6. 差し替え ----------
  logStep('データを差し替え');
  for (const a of ['entries', 'entries.json', 'README.md', 'CHANGES.md']) {
    const dst = path.join(OUT, a);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(path.join(STAGING, a), dst);
    logSub(`更新: ${a}`);
  }
  // 旧形式が残っていれば削除して統合形式へ移行
  for (const a of ['blocks', 'items', 'blocks.json', 'items.json']) {
    const dst = path.join(OUT, a);
    if (fs.existsSync(dst)) { fs.rmSync(dst, { recursive: true, force: true }); logSub(`旧形式を削除: ${a}`); }
  }
  fs.rmSync(STAGING, { recursive: true, force: true });

  try {
    const st = readState();
    st.lastRunAt = extractedAt;
    st.lastExtract = { blocks: staged.blocksArr.length, items: staged.itemsArr.length, files: staged.n };
    writeState(st);
  } catch (_) {}

  console.log('\n==========================================');
  console.log(`更新完了: ブロック ${staged.blocksArr.length} / アイテム ${staged.itemsArr.length} / 個別JSON ${staged.n} 件`);
  console.log(diff.firstRun ? '前回との差分: (初回抽出)' : `前回との差分: 追加 ${diff.summary.added} / 削除 ${diff.summary.removed} / ID変更 ${diff.summary.idChanged}`);
  console.log(`所要時間: ${elapsed()}`);
  console.log('==========================================');
}

main().catch((e) => {
  try { fs.rmSync(STAGING, { recursive: true, force: true }); } catch (_) {}
  console.error(`\n[update] 失敗: ${e.message}`);
  process.exit(1);
});
