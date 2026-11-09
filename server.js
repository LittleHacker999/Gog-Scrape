#!/usr/bin/env node
/**
 * GOG Multi-Account Link API
 * ------------------------------------------------------------------
 * Zero dependencies. Node >= 18 (uses global fetch).
 *
 * - Accounts + cookie headers live in a JSON file (see accounts.example.json)
 * - Every route is namespaced per account:  /api/<account>/game/<id-or-name>
 * - Download links are NEVER stored: the signed CDN URL is produced by
 *   scraping GOG live on each request.
 *
 * Run:  node server.js
 * Env:  PORT=3000  ACCOUNTS_FILE=./accounts.json  API_KEY=<optional>
 *       CACHE_TTL_MS=300000 (library index)  DETAILS_TTL_MS=30000 (0 = strict live)
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

// --------------------------------------------------------------------------
// config
// --------------------------------------------------------------------------

const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  accountsFile: path.resolve(process.env.ACCOUNTS_FILE || './accounts.json'),
  apiKey: process.env.API_KEY || '',
  libraryTtl: intEnv('CACHE_TTL_MS', 300_000),   // owned-games index (metadata only)
  detailsTtl: intEnv('DETAILS_TTL_MS', 30_000),  // per-game file list (metadata only)
  maxOutbound: intEnv('MAX_OUTBOUND', 6),        // concurrent requests to gog.com
  rateLimit: intEnv('RATE_LIMIT_PER_MIN', 240),  // per client IP
  allowOrigin: process.env.CORS_ORIGIN || '',    // e.g. "*" to allow browsers elsewhere
  defaultResolve: process.env.RESOLVE_BY_DEFAULT !== '0',
  logRequests: process.env.QUIET !== '1',
};

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : dflt;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EMBED = 'https://embed.gog.com';
const WEB = 'https://www.gog.com';
const CATALOG = 'https://catalog.gog.com/v1/catalog';

// --------------------------------------------------------------------------
// tiny utilities
// --------------------------------------------------------------------------

const log = (...a) => console.error('[gog-api]', ...a);

function intEnvSafe(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }

/** Parse "a=1; b=2" or "Cookie: a=1; b=2" into an object (first "=" only). */
function parseCookieHeader(raw) {
  const out = {};
  if (!raw || typeof raw !== 'string') return out;
  let s = raw.trim();
  if (/^cookie:/i.test(s)) s = s.slice(7);
  for (const part of s.split(';')) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function sizeToBytes(text) {
  const m = /([\d.]+)\s*([KMGT]i?B)?/i.exec(text || '');
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
                 KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * (mult[(m[2] || 'B').toUpperCase()] || 1));
}

function humanBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status; this.code = code; this.extra = extra || {};
  }
}

// --------------------------------------------------------------------------
// TTL cache (metadata only - never signed download links)
// --------------------------------------------------------------------------

class TtlCache {
  constructor() { this.map = new Map(); }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp && hit.exp < Date.now()) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  set(key, value, ttlMs) {
    if (ttlMs <= 0) return value;
    this.map.set(key, { value, exp: Date.now() + ttlMs });
    return value;
  }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

const libCache = new TtlCache();
const detailsCache = new TtlCache();
const inflight = new Map(); // key -> Promise, coalesces concurrent scrapes

async function coalesce(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

// --------------------------------------------------------------------------
// outbound concurrency guard
// --------------------------------------------------------------------------

class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.queue = []; }
  async run(fn) {
    if (this.active >= this.max) await new Promise((r) => this.queue.push(r));
    this.active++;
    try { return await fn(); }
    finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
const gogSem = new Semaphore(CONFIG.maxOutbound);

// --------------------------------------------------------------------------
// accounts
// --------------------------------------------------------------------------

class Account {
  constructor(name, rawCookie) {
    this.name = name;
    if (rawCookie && typeof rawCookie === 'object') rawCookie = rawCookie.cookie || rawCookie.cookies;
    this.cookies = parseCookieHeader(rawCookie);
    this.rotations = 0;
    this.lastUsed = null;
    this.lastError = null;
    this.sessionOk = null;
  }
  get cookieCount() { return Object.keys(this.cookies).length; }
  header() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  /** Carry GOG's rotating gog-al token forward, like a browser would. */
  absorb(setCookies) {
    if (!setCookies || !setCookies.length) return;
    for (const sc of setCookies) {
      const first = sc.split(';')[0];
      const i = first.indexOf('=');
      if (i < 1) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      if (!name) continue;
      if (this.cookies[name] !== value) {
        this.cookies[name] = value;
        this.rotations++;
      }
    }
  }
  publicInfo() {
    return {
      name: this.name,
      cookie_count: this.cookieCount,
      has_session_token: Boolean(this.cookies['gog-al']),
      token_rotations: this.rotations,
      last_used: this.lastUsed,
      session_ok: this.sessionOk,
      last_error: this.lastError,
    };
  }
}

const accounts = new Map();

/** Accepts {"name": "cookie"} or {"name": {"cookie": "..."}} or [{"name","cookie"}]. */
function loadAccountsFromJson(data) {
  const loaded = new Map();
  const push = (name, cookie) => {
    if (!name) return;
    loaded.set(String(name), new Account(String(name), cookie));
  };
  if (Array.isArray(data)) {
    for (const row of data) if (row && row.name) push(row.name, row.cookie || row.cookies);
  } else if (data && typeof data === 'object') {
    for (const [name, val] of Object.entries(data)) {
      if (name.startsWith('_') || name.startsWith('$')) continue; // comment keys
      push(name, val);
    }
  } else {
    throw new Error('accounts file must contain a JSON object or array');
  }
  return loaded;
}

async function loadAccounts() {
  try {
    const txt = await fsp.readFile(CONFIG.accountsFile, 'utf8');
    const loaded = loadAccountsFromJson(JSON.parse(txt));
    accounts.clear();
    for (const [k, v] of loaded) accounts.set(k, v);
    log(`loaded ${accounts.size} account(s) from ${CONFIG.accountsFile}`);
    for (const a of accounts.values()) {
      if (!a.cookies['gog-al']) log(`  ! ${a.name}: no gog-al cookie found - is this a logged-in session?`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      log(`no accounts file at ${CONFIG.accountsFile}`);
      log('  copy accounts.example.json -> accounts.json and paste your Cookie headers');
    } else {
      log(`failed to read accounts file: ${err.message}`);
    }
  }
}

async function saveAccounts() {
  const out = {};
  for (const [name, a] of accounts) out[name] = a.header();
  const tmp = CONFIG.accountsFile + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, CONFIG.accountsFile);
}

function getAccount(name, res) {
  const acc = accounts.get(name);
  if (!acc) {
    throw new HttpError(404, 'unknown_account',
      `No account named "${name}". Known accounts: ${[...accounts.keys()].join(', ') || '(none)'}`);
  }
  return acc;
}

// --------------------------------------------------------------------------
// GOG client
// --------------------------------------------------------------------------

async function gogFetch(account, url, opts = {}) {
  const { method = 'GET', redirect = 'follow', headers = {}, timeout = 30_000 } = opts;
  return gogSem.run(async () => {
    let res;
    try {
      res = await fetch(url, {
        method,
        redirect,
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          cookie: account ? account.header() : '',
          ...headers,
        },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new HttpError(504, 'upstream_unreachable', `gog.com unreachable: ${err.message}`);
    }
    if (account) {
      const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      account.absorb(sc);
      account.lastUsed = new Date().toISOString();
    }
    if (res.status === 401 || res.status === 403) {
      if (account) { account.sessionOk = false; account.lastError = `HTTP ${res.status}`; }
      throw new HttpError(502, 'cookie_expired',
        `GOG rejected the session cookie for account "${account?.name}". ` +
        'Log in again, copy a fresh Cookie header, update the accounts file and call POST /api/accounts/reload.');
    }
    return res;
  });
}

async function gogJson(account, url, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await gogFetch(account, url);
    if (res.status === 429 || res.status >= 500) {
      lastErr = new HttpError(502, 'upstream_busy', `GOG returned HTTP ${res.status}`);
      await sleep(800 * (attempt + 1) + Math.random() * 400);
      continue;
    }
    if (!res.ok) {
      throw new HttpError(502, 'upstream_error', `GOG returned HTTP ${res.status} for ${url}`);
    }
    const text = await res.text();
    try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new HttpError(502, 'bad_upstream_json', `Unparseable response from ${url}`); }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// library index (owned games) - cached metadata, contains no links
// --------------------------------------------------------------------------

async function fetchLibrary(account) {
  const games = new Map();
  let page = 1, pages = 1, total = 0;
  do {
    const data = await gogJson(account, `${EMBED}/account/getFilteredProducts?mediaType=1&page=${page}`);
    pages = data.totalPages || 1;
    total = data.totalProducts || 0;
    for (const p of data.products || []) {
      if (p.isMovie) continue;
      games.set(Number(p.id), {
        id: Number(p.id),
        title: p.title || '',
        slug: p.slug || '',
        platforms: Object.entries(p.worksOn || {}).filter(([, v]) => v).map(([k]) => k.toLowerCase()),
        release_date: (p.releaseDate?.date || '').slice(0, 10),
        category: p.category || '',
        dlc_count: p.dlcCount || 0,
      });
    }
    page++;
  } while (page <= pages);
  const list = [...games.values()].sort((a, b) => a.title.localeCompare(b.title));
  account.sessionOk = true;
  account.lastError = null;
  return { total, games: list, fetched_at: new Date().toISOString() };
}

async function getLibrary(account, { refresh = false } = {}) {
  const key = `lib:${account.name}`;
  if (refresh) { libCache.delete(key); detailsCache.clear(); }
  const hit = libCache.get(key);
  if (hit) return hit;
  return coalesce(key, async () => {
    const fresh = await fetchLibrary(account);
    return libCache.set(key, fresh, CONFIG.libraryTtl);
  });
}

function scoreMatch(query, item) {
  const q = norm(query);
  const t = norm(item.title);
  const s = norm(item.slug);
  if (!q) return 0;
  if (t === q || s === q) return 100;
  if (s === q.replace(/ /g, '_')) return 100;
  if (t.startsWith(q)) return 80 - Math.abs(t.length - q.length) / 50;
  if (t.includes(q)) return 60 - Math.abs(t.length - q.length) / 50;
  const qWords = q.split(' ');
  const hits = qWords.filter((w) => t.includes(w)).length;
  if (hits && hits === qWords.length) return 40;
  if (hits) return (hits / qWords.length) * 30;
  return 0;
}

function searchLocal(games, query, limit) {
  return games
    .map((g) => ({ g, score: scoreMatch(query, g) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ g, score }) => ({ ...g, match_score: Math.round(score) }));
}

// --------------------------------------------------------------------------
// store catalog search (no cookie needed)
// --------------------------------------------------------------------------

async function catalogSearch(query, limit = 10) {
  const url = new URL(CATALOG);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 48)));
  url.searchParams.set('page', '1');
  url.searchParams.set('countryCode', process.env.COUNTRY || 'US');
  url.searchParams.set('locale', process.env.LOCALE || 'en-US');
  url.searchParams.set('currencyCode', process.env.CURRENCY || 'USD');
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => { throw new HttpError(504, 'catalog_unreachable', e.message); });
  if (!res.ok) throw new HttpError(502, 'catalog_error', `catalog.gog.com HTTP ${res.status}`);
  const data = await res.json();
  return (data.products || []).map((p) => ({
    id: Number(p.id),
    title: p.title,
    slug: p.slug,
    product_type: p.productType,
    release_date: (p.releaseDate || '').slice(0, 10),
    platforms: (p.operatingSystems || []).map((o) => String(o).toLowerCase()),
    cover: p.coverVertical ? `https:${p.coverVertical}`.replace('{formatter}', 'product_card_v2_mobile_slider_639') : null,
    store_link: p.storeLink ? `https:${p.storeLink}` : null,
    price: p.price?.finalAmount || p.price?.amount || null,
    developers: (p.developers || []).slice(0, 3),
  }));
}

// --------------------------------------------------------------------------
// game details -> file entries
// --------------------------------------------------------------------------

function classifyFile(manualUrl, name) {
  const u = String(manualUrl || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (u.includes('patch') || n.includes('patch')) return 'patch';
  if (u.includes('installer')) return 'installer';
  return 'extras';
}

function parseDetail(detail, { forceType = null, prefix = '' } = {}) {
  const files = [];
  const push = (f) => {
    if (forceType) {
      f.type = forceType;
      if (prefix) f.name = f.name ? `${prefix}: ${f.name}` : prefix;
    }
    files.push(f);
  };

  let downloads = detail.downloads;
  if (downloads && !Array.isArray(downloads)) downloads = [['', downloads]];
  for (const entry of downloads || []) {
    const [lang, platforms] = Array.isArray(entry) ? entry : ['', entry];
    if (!platforms || typeof platforms !== 'object') continue;
    for (const [osName, list] of Object.entries(platforms)) {
      for (const f of list || []) {
        const mu = f.manualUrl;
        if (!mu) continue;
        push({
          type: classifyFile(mu, f.name),
          os: String(osName).toLowerCase(),
          language: lang || '',
          name: f.name || '',
          version: f.version ? String(f.version) : '',
          size: f.size || '',
          bytes: sizeToBytes(f.size),
          path: mu,
        });
      }
    }
  }

  for (const e of detail.extras || []) {
    if (!e.manualUrl) continue;
    push({
      type: 'extras', os: '', language: '',
      name: e.name || 'extra', version: '', size: e.size || '',
      bytes: sizeToBytes(e.size), path: e.manualUrl,
    });
  }

  for (const g of detail.galaxyDownloads || []) {
    if (!g.path) continue;
    push({
      type: 'galaxy', os: String(g.os || '').toLowerCase(), language: '',
      name: g.name || g.installer || 'galaxy installer', version: '',
      size: g.size || '', bytes: sizeToBytes(g.size), path: g.path,
    });
  }
  for (const g of detail.simpleGalaxyInstallers || []) {
    if (!g.path || files.some((f) => f.path === g.path)) continue;
    push({
      type: 'galaxy', os: String(g.os || '').toLowerCase(), language: '',
      name: 'Galaxy build', version: '', size: '', bytes: 0, path: g.path,
    });
  }
  return files;
}

async function fetchGameFiles(account, gameId, { dlcs = true, knownIds = null } = {}) {
  const detail = await gogJson(account, `${EMBED}/account/gameDetails/${gameId}.json`);
  // GOG answers "not in this library" with HTTP 200 and an empty array
  if (Array.isArray(detail) || !detail || typeof detail !== 'object' ||
      (!detail.title && !detail.downloads)) {
    throw new HttpError(404, 'not_owned',
      `Game ${gameId} is not in account "${account.name}" (or has no downloadable files).`);
  }

  let files = parseDetail(detail);
  const meta = {
    id: Number(gameId),
    title: detail.title || String(gameId),
    slug: (detail.forumLink || '').split('/').pop() || '',
    cd_keys: (detail.cdKeys || []).map((k) => k.cdKey || k).filter(Boolean),
    changelog: detail.changelog || '',
  };

  if (dlcs) {
    for (const d of detail.dlcs || []) {
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const title = d.title || d.name || 'DLC';
        if (d.downloads || d.extras || d.galaxyDownloads) {
          files = files.concat(parseDetail(d, { forceType: 'dlc', prefix: title }));
          continue;
        }
        if (d.manualUrl) {
          files.push({ type: 'dlc', os: '', language: '', name: title, version: '',
                       size: '', bytes: 0, path: d.manualUrl });
          continue;
        }
        const did = d.id || d.productId;
        if (!did || (knownIds && knownIds.has(Number(did)))) continue;
        try {
          const sub = await fetchGameFiles(account, Number(did), { dlcs: false });
          for (const f of sub.files) {
            files.push({ ...f, type: 'dlc', name: `${title}: ${f.name}` });
          }
        } catch { /* DLC not accessible - ignore */ }
      } else if (d && String(d).match(/^\d+$/)) {
        if (knownIds && knownIds.has(Number(d))) continue;
        try {
          const sub = await fetchGameFiles(account, Number(d), { dlcs: false });
          for (const f of sub.files) files.push({ ...f, type: 'dlc' });
        } catch { /* ignore */ }
      }
    }
  }

  const seen = new Set();
  files = files.filter((f) => {
    const k = `${f.type}|${f.path}|${f.os}|${f.language}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { meta, files, raw_keys: Object.keys(detail) };
}

async function getGameFileList(account, gameId, { dlcs = true, refresh = false } = {}) {
  const key = `details:${account.name}:${gameId}:${dlcs ? 1 : 0}`;
  if (refresh) detailsCache.delete(key);
  const hit = detailsCache.get(key);
  if (hit) return hit;
  return coalesce(key, async () => {
    const known = libCache.get(`lib:${account.name}`);
    const knownIds = known ? new Set(known.games.map((g) => g.id)) : null;
    const result = await fetchGameFiles(account, gameId, { dlcs, knownIds });
    return detailsCache.set(key, result, CONFIG.detailsTtl);
  });
}

// --------------------------------------------------------------------------
// live link resolution (never cached: signed URLs expire)
// --------------------------------------------------------------------------

async function resolveDownloadUrl(account, gogPath) {
  const url = /^https?:/i.test(gogPath) ? gogPath : WEB + gogPath;
  const res = await gogFetch(account, url, { method: 'HEAD', redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    if (!loc) throw new HttpError(502, 'no_redirect_location', 'GOG did not return a download location');
    return loc;
  }
  if (res.status === 200) return url;
  if (res.status === 404) throw new HttpError(404, 'file_not_found', `No such file: ${gogPath}`);
  throw new HttpError(502, 'resolve_failed', `GOG returned HTTP ${res.status} for ${gogPath}`);
}

/** Expiry hint from the signed URL: token=nva=<unix seconds> */
function linkExpiry(url) {
  const m = /nva=(\d{10})/.exec(url || '');
  if (!m) return null;
  const ts = Number(m[1]) * 1000;
  return { expires_at: new Date(ts).toISOString(), expires_in_seconds: Math.max(0, Math.round((ts - Date.now()) / 1000)) };
}

function wantsResolve(params) {
  const v = params.get('resolve');
  if (v === null) return CONFIG.defaultResolve;
  return !['0', 'false', 'no'].includes(v.toLowerCase());
}

function filterFiles(files, params) {
  const types = csv(params.get('types') || params.get('type'));
  const oses = csv(params.get('os'));
  const langs = csv(params.get('lang') || params.get('language')).map((s) => s.toLowerCase());
  const nameRx = params.get('files');
  let out = files;
  if (types.length) out = out.filter((f) => types.includes(f.type));
  if (oses.length) out = out.filter((f) => !f.os || oses.includes(f.os));
  if (langs.length) out = out.filter((f) => !f.language || langs.includes(String(f.language).toLowerCase()));
  if (nameRx) {
    const rx = new RegExp(nameRx, 'i');
    out = out.filter((f) => rx.test(f.name || '') || rx.test(f.path || ''));
  }
  return out;
}

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);

// --------------------------------------------------------------------------
// name -> id resolution
// --------------------------------------------------------------------------

async function resolveGame(account, token, params) {
  const liked = /^\d+$/.test(token) ? { id: Number(token), via: 'id' } : null;
  if (liked) {
    const list = await getGameFileList(account, liked.id, { dlcs: params.get('dlc') !== '0', refresh: params.get('refresh') === '1' });
    return { ...liked, ...list };
  }

  const lib = await getLibrary(account);
  const local = searchLocal(lib.games, token, 5);
  if (local.length && local[0].match_score >= 40) {
    const picked = local[0];
    const list = await getGameFileList(account, picked.id, { dlcs: params.get('dlc') !== '0', refresh: params.get('refresh') === '1' });
    return { id: picked.id, via: 'library', matched: { ...picked, alternatives: local.slice(1) }, ...list };
  }

  const store = await catalogSearch(token, 10);
  const ranked = store
    .map((p) => ({ p, score: scoreMatch(token, p) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    throw new HttpError(404, 'no_match', `Nothing matched "${token}" in account "${account.name}" or the GOG store.`);
  }
  const candidate = ranked[0].p;
  const list = await getGameFileList(account, candidate.id, { dlcs: params.get('dlc') !== '0' });
  return {
    id: candidate.id, via: 'catalog',
    matched: { ...candidate, alternatives: ranked.slice(1, 4).map((x) => x.p) },
    ...list,
  };
}

// --------------------------------------------------------------------------
// HTTP plumbing
// --------------------------------------------------------------------------

const rateBuckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const b = rateBuckets.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > b.reset) { b.count = 0; b.reset = now + 60_000; }
  b.count++;
  rateBuckets.set(ip, b);
  return b.count > CONFIG.rateLimit;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders,
  });
  res.end(payload);
}

function corsHeaders() {
  if (!CONFIG.allowOrigin) return {};
  return {
    'access-control-allow-origin': CONFIG.allowOrigin,
    'access-control-allow-headers': 'content-type, x-api-key, range',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  };
}

function checkApiKey(req, url) {
  if (!CONFIG.apiKey) return true;
  const given = req.headers['x-api-key'] || url.searchParams.get('key') || '';
  return given === CONFIG.apiKey;
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body_too_large', 'request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'bad_json', 'request body must be valid JSON'); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
               '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const body = await fsp.readFile(full);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// routes
// --------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const send = (status, body, extra) => sendJson(res, status, body, extra);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  try {
    if (rateLimited(ip)) {
      throw new HttpError(429, 'rate_limited', `Too many requests (limit ${CONFIG.rateLimit}/min).`);
    }

    // ---- static web UI -------------------------------------------------
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (await serveStatic(res, url.pathname)) return;
      throw new HttpError(404, 'not_found', 'Not found');
    }

    // ---- everything below is the API ----------------------------------
    if (!checkApiKey(req, url)) {
      throw new HttpError(401, 'unauthorized', 'Missing or wrong API key (send X-API-Key header or ?key=).');
    }

    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const route = parts.slice(1);
    const params = url.searchParams;

    // GET /api/health
    if (route[0] === 'health' && req.method === 'GET') {
      return send(200, {
        status: 'ok',
        uptime_seconds: Math.round(process.uptime()),
        accounts: accounts.size,
        api_key_required: Boolean(CONFIG.apiKey),
        caching: { library_ttl_ms: CONFIG.libraryTtl, details_ttl_ms: CONFIG.detailsTtl,
                   signed_links_cached: false },
        node: process.version,
      });
    }

    // GET /api/accounts | POST /api/accounts | DELETE /api/accounts/:name
    if (route[0] === 'accounts') {
      if (req.method === 'GET' && route.length === 1) {
        const list = [...accounts.values()].map((a) => a.publicInfo());
        if (params.get('check') === '1') {
          for (const acc of accounts.values()) {
            try {
              await getLibrary(acc, { refresh: true });
              acc.sessionOk = true;
            } catch (err) {
              acc.sessionOk = false;
              acc.lastError = err.message;
            }
          }
        }
        return send(200, { count: accounts.size, accounts: list });
      }
      if (req.method === 'POST' && route[1] === 'reload') {
        await loadAccounts();
        return send(200, { reloaded: true, count: accounts.size,
                           accounts: [...accounts.keys()] });
      }
      if (req.method === 'POST' && route.length === 1) {
        const body = await readBody(req);
        if (!body.name || typeof body.cookie !== 'string') {
          throw new HttpError(400, 'bad_request', 'Body must be {"name": "...", "cookie": "gog-al=...; ..."}');
        }
        const acc = new Account(String(body.name), body.cookie);
        if (!acc.cookieCount) throw new HttpError(400, 'bad_cookie', 'No cookies parsed from that string.');
        accounts.set(acc.name, acc);
        await saveAccounts();
        libCache.delete(`lib:${acc.name}`);
        return send(201, { added: acc.name, accounts: [...accounts.keys()], cookie_count: acc.cookieCount });
      }
      if (req.method === 'DELETE' && route[1]) {
        const name = decodeURIComponent(route[1]);
        if (!accounts.delete(name)) throw new HttpError(404, 'unknown_account', `No account "${name}"`);
        await saveAccounts();
        libCache.delete(`lib:${name}`);
        return send(200, { deleted: name, accounts: [...accounts.keys()] });
      }
    }

    // GET /api/catalog?q=...&limit=10   (store search, no cookie needed)
    if (route[0] === 'catalog' && req.method === 'GET') {
      const q = params.get('q') || params.get('query');
      if (!q) throw new HttpError(400, 'missing_query', 'Add ?q=<game name>');
      const limit = intEnvSafe(params.get('limit'), 12);
      const results = await catalogSearch(q, limit);
      const acc = params.get('account') ? getAccount(params.get('account')) : null;
      let ownedIds = null;
      if (acc) {
        const lib = await getLibrary(acc);
        ownedIds = new Set(lib.games.map((g) => g.id));
      }
      return send(200, {
        query: q,
        count: results.length,
        account: acc?.name || null,
        results: results.map((r) => ({ ...r, owned: ownedIds ? ownedIds.has(r.id) : null })),
      });
    }

    // /api/:account/...
    const accountName = decodeURIComponent(route[0] || '');
    const account = getAccount(accountName);
    const sub = route[1] || '';

    // GET /api/:account                 -> account overview
    if (req.method === 'GET' && !sub) {
      let lib = null;
      try { lib = await getLibrary(account); account.sessionOk = true; }
      catch (err) { account.sessionOk = false; account.lastError = err.message; }
      return send(200, {
        ...account.publicInfo(),
        owned_games: lib ? lib.games.length : null,
        library_fetched_at: lib ? lib.fetched_at : null,
        error: lib ? undefined : account.lastError,
        endpoints: {
          library: `/api/${account.name}/library`,
          search: `/api/${account.name}/search?q=witcher`,
          game: `/api/${account.name}/game/1207667203`,
          game_by_name: `/api/${account.name}/game/cyberpunk%202077`,
          link: `/api/${account.name}/link?path=/downloads/<slug>/<fileId>`,
          file: `/api/${account.name}/file?path=/downloads/<slug>/<fileId>`,
        },
      });
    }

    // GET /api/:account/library[?q=]
    if (sub === 'library' && req.method === 'GET') {
      const lib = await getLibrary(account, { refresh: params.get('refresh') === '1' });
      const q = params.get('q');
      let games = lib.games;
      if (q) games = searchLocal(lib.games, q, intEnvSafe(params.get('limit'), 50));
      return send(200, {
        account: account.name,
        total: lib.games.length,
        count: games.length,
        fetched_at: lib.fetched_at,
        games,
      });
    }

    // GET /api/:account/search?q=...[&store=1]
    if (sub === 'search' && req.method === 'GET') {
      const q = params.get('q') || params.get('query');
      if (!q) throw new HttpError(400, 'missing_query', 'Add ?q=<game name>');
      const limit = intEnvSafe(params.get('limit'), 15);
      const lib = await getLibrary(account);
      const owned = searchLocal(lib.games, q, limit);
      const ownedIds = new Set(lib.games.map((g) => g.id));
      let store = null;
      if (params.get('store') === '1') {
        try {
          store = (await catalogSearch(q, limit)).map((r) => ({ ...r, owned: ownedIds.has(r.id) }));
        } catch (err) {
          store = { error: err.message };
        }
      }
      return send(200, {
        account: account.name, query: q,
        library: { count: owned.length, results: owned },
        store: store ? { count: Array.isArray(store) ? store.length : 0, results: store } : undefined,
      });
    }

    // GET /api/:account/game/:idOrName
    if (sub === 'game' && req.method === 'GET' && route[2]) {
      const token = decodeURIComponent(route.slice(2).join('/'));
      const resolve = wantsResolve(params);
      const dlcs = params.get('dlc') !== '0';
      const started2 = Date.now();
      const { meta, files, via, matched } = await resolveGame(account, token, params);
      let selected = filterFiles(files, params);

      if (params.get('limit')) selected = selected.slice(0, intEnvSafe(params.get('limit'), 100));

      const out = new Array(selected.length);
      if (resolve) {
        // resolve a few files at a time; keep the original ordering in `out`
        const concurrency = Math.min(4, CONFIG.maxOutbound);
        let cursor = 0;
        const runner = async () => {
          while (true) {
            const i = cursor++;
            if (i >= selected.length) return;
            const f = selected[i];
            try {
              const download = await resolveDownloadUrl(account, f.path);
              out[i] = { ...f, url: WEB + f.path, download, ...linkExpiry(download) };
            } catch (err) {
              out[i] = { ...f, url: WEB + f.path, download: null, error: err.message };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, selected.length || 1) }, runner));
      } else {
        selected.forEach((f, i) => { out[i] = { ...f, url: WEB + f.path, download: null }; });
      }
      const filesOut = out.filter(Boolean);

      const ok = filesOut.filter((f) => f.download).length;
      return send(200, {
        account: account.name,
        game: meta,
        matched,
        resolved_via: via,
        resolved_links: resolve,
        scraped_at: new Date().toISOString(),
        elapsed_ms: Date.now() - started2,
        counts: {
          total_files_in_game: files.length,
          returned: filesOut.length,
          linked: ok,
          failed: filesOut.length - ok,
          by_type: filesOut.reduce((acc, f) => { acc[f.type] = (acc[f.type] || 0) + 1; return acc; }, {}),
          total_bytes: filesOut.reduce((a, f) => a + (f.bytes || 0), 0),
          total_size: humanBytes(filesOut.reduce((a, f) => a + (f.bytes || 0), 0)),
        },
        files: filesOut,
        note: resolve
          ? 'download = signed CDN URL, generated live and valid ~24h. Never cached by this server.'
          : 'download is null because resolve=0; use url with your cookie, or add resolve=1.',
      });
    }

    // GET /api/:account/link?path=/downloads/...  -> one signed URL
    if (sub === 'link' && req.method === 'GET') {
      const p = params.get('path');
      if (!p) throw new HttpError(400, 'missing_path', 'Add ?path=/downloads/<slug>/<fileId>');
      const t0 = Date.now();
      const download = await resolveDownloadUrl(account, p);
      return send(200, {
        account: account.name, path: p, download,
        ...linkExpiry(download), elapsed_ms: Date.now() - t0,
      });
    }

    // GET /api/:account/file?path=/downloads/...  -> stream the bytes through this server
    if (sub === 'file' && req.method === 'GET') {
      const p = params.get('path');
      if (!p) throw new HttpError(400, 'missing_path', 'Add ?path=/downloads/<slug>/<fileId>');
      const download = await resolveDownloadUrl(account, p);
      const range = req.headers.range;
      const upstream = await fetch(download, {
        headers: { 'user-agent': UA, ...(range ? { range } : {}) },
        signal: AbortSignal.timeout(120_000),
      });
      if (!upstream.ok && upstream.status !== 206) {
        throw new HttpError(502, 'cdn_error', `CDN returned HTTP ${upstream.status}`);
      }
      const name = decodeURIComponent(new URL(download).pathname.split('/').pop() || 'download');
      const headers = {
        'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
        'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
        'cache-control': 'no-store',
        ...corsHeaders(),
      };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      res.writeHead(upstream.status === 206 ? 206 : 200, headers);
      await pipeline(upstream.body, res);
      return;
    }

    throw new HttpError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) log(`${req.method} ${url.pathname} -> ${status} ${err.message}`);
    if (!res.headersSent) {
      sendJson(res, status, {
        error: err.code || 'internal_error',
        message: err.message,
        ...(err.extra || {}),
      });
    } else {
      res.destroy();
    }
  } finally {
    if (CONFIG.logRequests) {
      log(`${req.method} ${url.pathname}${url.search} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------

(async () => {
  await loadAccounts();
  server.listen(CONFIG.port, CONFIG.host, () => {
    log(`listening on http://${CONFIG.host}:${CONFIG.port}`);
    log(`accounts: ${[...accounts.keys()].join(', ') || '(none - see accounts.example.json)'}`);
    log(`signed links are resolved live per request and never cached`);
    if (!CONFIG.apiKey) log('note: no API_KEY set - anyone who can reach this port can use your accounts');
  });
})();

process.on('SIGINT', () => { log('shutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { log('shutting down'); server.close(() => process.exit(0)); });
