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
// .env support (zero dependencies)
//
// Runs before CONFIG is evaluated, so PORT / HOST / ACCOUNTS_URL / API_KEY /
// ACCOUNTS_FILE / ACCOUNTS_ENV / ACCOUNT_<NAME> and the tuning knobs can all
// come from a .env file next to the app. A real environment variable always
// wins over the file, which is the usual dotenv rule.
// --------------------------------------------------------------------------

function loadDotEnv() {
  const target = process.env.ENV_FILE || path.resolve(process.cwd(), '.env');
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[gog-api]', `could not read ${target}: ${err.message}`);
    return { file: null, applied: [], kept: [] };
  }

  const lines = text.split(/\r?\n/);
  const applied = [];
  const kept = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let rest = m[2].trim();

    const unescapeDouble = (t) => t
      .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');

    // A quoted value may span lines - that is how a JSON ACCOUNTS_ENV usually
    // arrives. The closing quote must be the last thing on its line, so quotes
    // *inside* the JSON don't end the value early.
    const single = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*(?:[#;].*)?$/.exec(rest);
    if (single) {
      const raw = single[1];
      rest = raw[0] === '"' ? unescapeDouble(raw.slice(1, -1)) : raw.slice(1, -1);
    } else if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0];
      let body = rest.slice(1);
      // The value ends when the line ends with the closing quote - but for JSON
      // payloads a single line can also end in a quote (e.g. "value": "x"), so
      // keep reading until the accumulated text actually parses.
      const closed = () => {
        const t = body.trimEnd();
        if (!t.endsWith(quote)) return false;
        if (t.slice(0, -1).endsWith('\\')) return false;   // escaped quote
        const inner = t.slice(0, -1);
        const first = inner.trimStart()[0];
        if (first === '{' || first === '[') {
          try { JSON.parse(inner); return true; } catch { return false; }
        }
        return true;
      };
      while (!closed() && i + 1 < lines.length) body += '\n' + lines[++i];
      // drop the closing quote if we ended on it (whether or not JSON-validity
      // was reached - a broken payload should still arrive intact and be
      // reported by parseAccountsText, not silently truncated here)
      const tail = body.trimEnd();
      if (tail.endsWith(quote) && !tail.slice(0, -1).endsWith('\\')) body = tail.slice(0, -1);
      // escape sequences only apply to plain single-line values; a JSON payload
      // must be handed over byte for byte
      const isJsonish = /^\s*[{[]/.test(body);
      rest = quote === '"' && !isJsonish ? unescapeDouble(body) : body;
    } else {
      rest = rest.replace(/\s+#.*$/, '').trim();   // trailing "  # comment"
    }

    if (key in process.env) { kept.push(key); continue; }   // real env wins
    process.env[key] = rest;
    applied.push(key);
  }

  return { file: target, applied, kept };
}

const DOTENV = loadDotEnv();

if (DOTENV.file) {
  console.error('[gog-api]',
    `.env: ${DOTENV.applied.length} variable(s) loaded from ${path.basename(DOTENV.file)}` +
    (DOTENV.applied.length ? ` (${DOTENV.applied.join(', ')})` : '') +
    (DOTENV.kept.length ? ` | kept from real env: ${DOTENV.kept.join(', ')}` : '') +
    ' - values are never logged');
}

// --------------------------------------------------------------------------
// config
// --------------------------------------------------------------------------

const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  accountsFile: path.resolve(process.env.ACCOUNTS_FILE || './accounts.json'),
  // Remote accounts: when set, accounts are fetched from this URL (gist, S3, anything)
  // Whole accounts JSON (or one raw cookie header) straight from an env var
  accountsEnv: (process.env.ACCOUNTS_ENV || process.env.ACCOUNTS_JSON || '').trim(),
  accountsUrl: process.env.ACCOUNTS_URL || '',
  // 0 = re-fetch on every API call (default, as requested); set e.g. 15000 to cache
  accountsUrlTtl: intEnv('ACCOUNTS_URL_TTL_MS', 0),
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

// --------------------------------------------------------------------------
// cookie input normalisation
//
// Three shapes are accepted, because that is what real users can produce:
//   1. a raw Cookie header            "gog-al=abc; gog_us=def; gog_lc=BR_BRL_en-US"
//   2. a cookie-editor JSON export    [{"domain":".gog.com","name":"gog-al","value":"abc",...}, ...]
//   3. either of those wrapped in an object: {"cookie": ...} / {"cookies": [...]}
// A string that itself contains JSON is parsed too, so the array can be pasted
// into accounts.json as an escaped string without complaints.
// --------------------------------------------------------------------------

const isCookieObject = (o) => o && typeof o === 'object' && !Array.isArray(o)
  && typeof o.name === 'string' && 'value' in o;

/** True for an EditThisCookie / Cookie-Editor export (one account's whole jar). */
function isCookieArray(v, depth = 0) {
  if (!Array.isArray(v) || v.length === 0) return false;
  if (!v.every(isCookieObject)) return false;
  // a row like {name, cookie} is an account entry, not a cookie
  return v.some((c) => 'domain' in c || 'path' in c || 'httpOnly' in c || 'sameSite' in c
    || 'hostOnly' in c || 'expirationDate' in c || 'session' in c) || depth > 0;
}

/** Keep only cookies that belong to gog.com and haven't expired. */
function cookiesFromArray(arr) {
  const out = {};
  const nowSec = Date.now() / 1000;
  let skippedExpired = 0, skippedForeign = 0;
  for (const c of arr) {
    if (!isCookieObject(c)) continue;
    const host = String(c.domain || '').replace(/^\./, '').toLowerCase();
    if (host && !host.endsWith('gog.com')) { skippedForeign++; continue; }
    if (c.expirationDate && Number(c.expirationDate) < nowSec) { skippedExpired++; continue; }
    out[c.name] = c.value == null ? '' : String(c.value);
  }
  return { cookies: out, skippedExpired, skippedForeign };
}

/**
 * Normalise any accepted shape into { cookies, format }.
 * Throws on shapes we cannot understand, so the operator gets a clear message.
 */
function normalizeCookieSource(value, where = 'account') {
  if (value == null) return { cookies: {}, format: 'empty' };

  // object wrapper: {"cookie": ...} / {"cookies": [...]}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('cookie' in value || 'cookies' in value) {
      return normalizeCookieSource(value.cookie ?? value.cookies, where);
    }
    // a single cookie object is not a jar
    if (isCookieObject(value)) {
      return { cookies: { [value.name]: String(value.value ?? '') }, format: 'single-cookie' };
    }
    throw new Error(`${where}: unrecognised object - expected a Cookie header string or a cookie array`);
  }

  if (Array.isArray(value)) {
    if (!isCookieArray(value)) {
      throw new Error(`${where}: array does not look like a cookie export ` +
        '(items need "name" and "value" fields)');
    }
    return { cookies: cookiesFromArray(value).cookies, format: 'array' };
  }

  let text = String(value).trim();
  // a JSON document pasted as a string
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return normalizeCookieSource(parsed, where);
    } catch { /* not JSON after all - fall through to header parsing */ }
  }
  return { cookies: parseCookieHeader(text), format: 'header' };
}

/** Cheap stable hash of the raw cookie source, for change detection. */
function fingerprintOf(raw) {
  let text;
  try { text = typeof raw === 'string' ? raw : JSON.stringify(raw); }
  catch { text = String(raw); }
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

class Account {
  constructor(name, rawCookie) {
    this.name = name;
    // fingerprint of the *source* material, so a refresh can tell "same cookies"
    // apart from "rotated at runtime" and avoid throwing away live tokens
    this.fingerprint = fingerprintOf(rawCookie);
    const norm = normalizeCookieSource(rawCookie, `account "${name}"`);
    this.cookies = norm.cookies;
    this.format = norm.format;
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
      cookie_format: this.format,
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

/**
 * Build accounts from parsed JSON. Accepts:
 *   { "name": "<header string>" , ... }                  one entry per account
 *   { "name": [ {cookie objects} ] }                     array export inline
 *   [ { "name": "acc", "cookie": <string|array> } ]      list of accounts
 *   [ { "domain": ".gog.com", "name": ..., ... } ]       a single account's jar
 * The last form is the cookie-editor export: one account, named after the file.
 */
function loadAccountsFromJson(data, { fallbackName = 'default' } = {}) {
  const loaded = new Map();
  const errors = [];
  const push = (name, raw) => {
    if (!name) return;
    const key = String(name);
    try {
      loaded.set(key, new Account(key, raw));
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
    }
  };

  if (typeof data === 'string') {
    push(fallbackName, data); // the file is just a Cookie header
  } else if (Array.isArray(data)) {
    if (isCookieArray(data)) {
      push(fallbackName, data); // bare cookie-editor export = one account
    } else {
      for (const [i, row] of data.entries()) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          errors.push(`entry #${i + 1}: expected an object with "name" and "cookie"`);
          continue;
        }
        if (row.name && ('cookie' in row || 'cookies' in row)) push(row.name, row.cookie ?? row.cookies);
        else if (isCookieObject(row)) push(fallbackName, [row]);
        else errors.push(`entry #${i + 1}: needs a "cookie" field`);
      }
    }
  } else if (data && typeof data === 'object') {
    if (isCookieObject(data)) {
      push(fallbackName, [data]);
    } else if ('cookie' in data || 'cookies' in data) {
      push(fallbackName, data.cookie ?? data.cookies);
    } else {
      for (const [name, val] of Object.entries(data)) {
        if (name.startsWith('_') || name.startsWith('$')) continue; // comment keys
        push(name, val);
      }
    }
  } else {
    throw new Error('accounts file must contain a JSON object or array');
  }

  for (const e of errors) log(`  ! skipped ${e}`);
  return loaded;
}

/** Strip a filename down to a usable account name: main.cookies.json -> main */
function nameFromFile(file) {
  return path.basename(file)
    .replace(/\.(cookies|account)?\.?json$/i, '')
    .replace(/\.(txt|cookies)$/i, '') || 'default';
}

async function loadAccounts() {
  const target = CONFIG.accountsFile;
  const collected = new Map();
  try {
    const st = await fsp.stat(target);

    if (st.isDirectory()) {
      // accounts.d/*.json|*.txt -> one account per file, named after the file
      const files = (await fsp.readdir(target))
        .filter((f) => /\.(json|txt|cookies)$/i.test(f) && !f.startsWith('.'))
        .sort();
      if (!files.length) log(`accounts folder ${target} has no .json/.txt files`);
      for (const f of files) {
        try {
          const full = path.join(target, f);
          const txt = await fsp.readFile(full, 'utf8');
          let parsed;
          try { parsed = JSON.parse(txt); }
          catch { parsed = txt; } // a plain header string in a .txt file
          const fromFile = loadAccountsFromJson(parsed, { fallbackName: nameFromFile(f) });
          for (const [k, v] of fromFile) {
            if (collected.has(k)) log(`  ! duplicate account "${k}" in ${f} - keeping the first`);
            else collected.set(k, v);
          }
        } catch (err) {
          log(`  ! ${f}: ${err.message}`);
        }
      }
    } else {
      const txt = await fsp.readFile(target, 'utf8');
      let parsed;
      try { parsed = JSON.parse(txt); }
      catch { parsed = txt; } // whole file is a raw Cookie header
      const fallbackName = nameFromFile(target) || 'default';
      const fromFile = loadAccountsFromJson(parsed, {
        fallbackName: path.basename(target).toLowerCase().startsWith('accounts') ? 'default' : fallbackName,
      });
      for (const [k, v] of fromFile) collected.set(k, v);
    }

    accounts.clear();
    for (const [k, v] of collected) accounts.set(k, v);
    log(`loaded ${accounts.size} account(s) from ${target}`);
    for (const a of accounts.values()) {
      const bits = [`${a.cookieCount} cookies`, `format: ${a.format}`];
      if (!a.cookies['gog-al']) bits.push('NO gog-al - probably not a logged-in session');
      log(`  - ${a.name}: ${bits.join(', ')}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      log(`no accounts file or folder at ${target}`);
      log('  copy accounts.example.json -> accounts.json and paste one Cookie header (or cookie-array export) per account');
    } else {
      log(`failed to read accounts: ${err.message}`);
    }
  }
}

// --------------------------------------------------------------------------
// accounts from environment variables
//
// Two shapes, both optional and merged (the *_<NAME> vars win on name clashes):
//   ACCOUNTS_ENV='{"main": "<cookie header>", "alt": [ {cookie objects} ]}'
//   ACCOUNT_MAIN="gog-al=...; gog_us=..."        one account per variable
//   ACCOUNT_ALT='[{"domain":".gog.com", ...}]'   cookie-editor export inline
// --------------------------------------------------------------------------

const ACCOUNT_VAR = /^ACCOUNT_([A-Za-z0-9_]+)$/;

/**
 * Parse a blob that is either accounts JSON or a single raw Cookie header.
 * Text that *looks* like JSON but doesn't parse is an error, not a cookie -
 * otherwise a typo'd env var silently becomes an account with one junk cookie.
 */
function parseAccountsText(text, label) {
  const t = String(text || '').trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch (err) {
      throw new Error(`${label} looks like JSON but could not be parsed (${err.message})`);
    }
  }
  return t; // a bare Cookie header
}

/** True when any env var carries accounts (used for logging / read-only checks). */
function envHasAccounts() {
  return Boolean(CONFIG.accountsEnv) || Object.keys(process.env).some((k) => ACCOUNT_VAR.test(k));
}

function loadAccountsFromEnv() {
  const collected = new Map();

  if (CONFIG.accountsEnv) {
    try {
      const parsed = parseAccountsText(CONFIG.accountsEnv, 'ACCOUNTS_ENV');
      for (const [k, v] of loadAccountsFromJson(parsed, { fallbackName: 'default' })) {
        collected.set(k, v);
      }
    } catch (err) {
      log(`! ACCOUNTS_ENV ignored: ${err.message}`);
    }
  }

  // ACCOUNT_<NAME> -> account "<name>" (suffix lowercased)
  for (const [key, value] of Object.entries(process.env)) {
    const m = ACCOUNT_VAR.exec(key);
    if (!m || !value) continue;
    const name = m[1].toLowerCase();
    try {
      const parsed = parseAccountsText(value, key);
      const one = loadAccountsFromJson(parsed, { fallbackName: name });
      for (const [k, v] of one) collected.set(k, v);
    } catch (err) {
      log(`! ${key} ignored: ${err.message}`);
    }
  }

  return collected;
}

// --------------------------------------------------------------------------
// remote accounts (ACCOUNTS_URL) - re-fetched on demand, e.g. once per API call
// --------------------------------------------------------------------------

const acctSource = {
  source: CONFIG.accountsUrl ? 'url' : (envHasAccounts() ? 'env' : 'file'),
  last_attempt: null,
  last_success: null,
  last_error: null,
  fetching: null,
  cooldown_until: 0,
  fetches: 0,
};

/** Swap in a freshly parsed account map, keeping live objects whose cookies didn't change. */
function replaceAccounts(loaded) {
  const next = new Map();
  let reused = 0;
  for (const [name, fresh] of loaded) {
    const existing = accounts.get(name);
    // reuse when the underlying cookie source is unchanged: keeps the rotated
    // gog-al token and cached session state alive across refreshes
    if (existing && existing.fingerprint === fresh.fingerprint) {
      next.set(name, existing);
      reused++;
    } else {
      next.set(name, fresh);
    }
  }
  const added = [...next.keys()].filter((n) => !accounts.has(n));
  const removed = [...accounts.keys()].filter((n) => !next.has(n));
  accounts.clear();
  for (const [k, v] of next) accounts.set(k, v);
  for (const n of removed) { libCache.delete(`lib:${n}`); detailsCache.clear(); }
  if (added.length) log(`  + account(s) added: ${added.join(', ')}`);
  if (removed.length) log(`  - account(s) removed: ${removed.join(', ')}`);
  return { reused, added, removed };
}

/**
 * Refresh accounts from CONFIG.accountsUrl.
 *  - coalesces concurrent callers into one HTTP request
 *  - TTL 0 = talk to the URL on every call
 *  - on failure keeps the last good copy and backs off for a few seconds,
 *    so one flaky fetch never takes the API down
 */
async function refreshAccountsFromUrl({ force = false } = {}) {
  if (!CONFIG.accountsUrl) return false;
  const now = Date.now();
  if (!force) {
    if (CONFIG.accountsUrlTtl > 0 && acctSource.last_attempt &&
        now - acctSource.last_attempt < CONFIG.accountsUrlTtl) return false;
    if (now < acctSource.cooldown_until) return false;
  }
  if (acctSource.fetching) return acctSource.fetching;

  acctSource.fetching = (async () => {
    acctSource.last_attempt = Date.now();
    acctSource.fetches++;
    try {
      const res = await fetch(CONFIG.accountsUrl, {
        headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const parsed = parseAccountsText(text, 'ACCOUNTS_URL response');
      const loaded = loadAccountsFromJson(parsed, { fallbackName: 'default' });
      if (!loaded.size) throw new Error('no accounts in the remote file');
      const delta = replaceAccounts(loaded);
      acctSource.last_success = acctSource.last_attempt;
      acctSource.last_error = null;
      if (delta.added.length || delta.removed.length) {
        log(`accounts refreshed from URL: ${accounts.size} account(s) ` +
            `(+${delta.added.length} -${delta.removed.length})`);
      }
      return true;
    } catch (err) {
      acctSource.last_error = err.message;
      acctSource.cooldown_until = Date.now() + 5000; // don't hammer a dead URL
      log(`! accounts refresh failed (${err.message}) - ` +
          (accounts.size ? `keeping the previous ${accounts.size} account(s)` : 'no accounts loaded'));
      return false;
    } finally {
      acctSource.fetching = null;
    }
  })();
  return acctSource.fetching;
}

/**
 * Populate `accounts` from whichever source is configured.
 * Precedence: ACCOUNTS_URL -> ACCOUNT* env vars -> ACCOUNTS_FILE.
 */
async function loadInitialAccounts() {
  if (CONFIG.accountsUrl) {
    acctSource.source = 'url';
    await refreshAccountsFromUrl({ force: true });
    return;
  }
  const fromEnv = loadAccountsFromEnv();
  if (fromEnv.size) {
    acctSource.source = 'env';
    accounts.clear();
    for (const [k, v] of fromEnv) accounts.set(k, v);
    log(`loaded ${accounts.size} account(s) from environment variables`);
    for (const a of accounts.values()) {
      const bits = [`${a.cookieCount} cookies`, `format: ${a.format}`];
      if (!a.cookies['gog-al']) bits.push('NO gog-al - probably not a logged-in session');
      log(`  - ${a.name}: ${bits.join(', ')}`);
    }
    return;
  }
  acctSource.source = 'file';
  await loadAccounts();
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

const LEADING_ARTICLE = /^(the|a|an)\s+/;
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rank a candidate against a query. Higher is better; 0 means "no match".
 * Tuned so that "witcher" prefers "The Witcher: Enhanced Edition" over
 * "GWENT: The Witcher Card Game", and "cyberpunk 2077" prefers the base game
 * over "...: Phantom Liberty".
 */
function scoreMatch(query, item) {
  const qRaw = norm(query);
  if (!qRaw) return 0;
  const q = qRaw.replace(LEADING_ARTICLE, '');        // query without a leading the/a/an
  const titleRaw = norm(item.title);
  const slugRaw = norm(String(item.slug || '').replace(/[_-]+/g, ' '));
  const title = titleRaw.replace(LEADING_ARTICLE, '');
  const slug = slugRaw.replace(LEADING_ARTICLE, '');
  const pen = (c) => Math.min(Math.abs(c.length - q.length) / 100, 4);

  if (titleRaw === qRaw || slugRaw === qRaw || title === q || slug === q) return 100;
  if (title.startsWith(q) || slug.startsWith(q)) return 90 - pen(title);

  // whole-word match, checked against stripped *and* raw forms so that
  // "the witcher enhanced" still lines up with "The Witcher: Enhanced Edition"
  const wordRe = new RegExp(`(^|\s)${escRe(q)}($|\s|:)`);
  if (wordRe.test(title) || wordRe.test(slug) ||
      wordRe.test(titleRaw) || wordRe.test(slugRaw)) return 76 - pen(title);

  if (title.includes(q) || slug.includes(q) ||
      titleRaw.includes(qRaw) || slugRaw.includes(qRaw)) return 68 - pen(title);

  // every query word appears somewhere
  const qWords = q.split(' ').filter(Boolean);
  const hits = qWords.filter((w) => title.includes(w)).length;
  if (hits === qWords.length) return 45 - pen(title);
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
// cross-account helpers
// --------------------------------------------------------------------------

/** Load every account's library index in parallel. One dead cookie never breaks the call. */
async function allLibraries() {
  const done = new Map();
  const errors = {};
  await Promise.all([...accounts.values()].map(async (acc) => {
    try {
      done.set(acc.name, await getLibrary(acc));
      acc.sessionOk = true;
      acc.lastError = null;
    } catch (err) {
      errors[acc.name] = err.message;
      acc.sessionOk = false;
      acc.lastError = err.message;
    }
  }));
  // Rebuild in configured account order, not in promise-completion order, so
  // "which account is shown for a shared game" is identical on every request.
  const libs = new Map();
  for (const name of accounts.keys()) if (done.has(name)) libs.set(name, done.get(name));
  const orderedErrors = {};
  for (const name of accounts.keys()) if (errors[name]) orderedErrors[name] = errors[name];
  return { libs, errors: orderedErrors };
}

/** Normalised title, for spotting the same game under different regional product ids. */
function normTitleKey(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\u2122\u00ae\u00a9]/g, '')   // TM (R) (C)
    .replace(LEADING_ARTICLE, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Flatten every account's library into ONE row per game.
 *
 * This is the whole point of /api/games: a game owned by three accounts must not
 * appear three times. Every row carries `account` (the single account to show)
 * plus `accounts` / `copies` so the full ownership is still available.
 *
 * @param {Map<string,{games:Array}>} libs
 * @param {{by?:'id'|'title', split?:boolean, sharedOnly?:boolean}} opts
 *   by:'title' also collapses the same title stored under different ids
 *   split:true gives one row per (game, account) - i.e. the non-merged view
 */
function flattenLibrary(libs, { by = 'id', split = false, sharedOnly = false } = {}) {
  const rows = new Map();
  for (const [name, lib] of libs) {
    for (const g of lib.games) {
      const base = by === 'title' ? `t:${normTitleKey(g.title)}` : `i:${g.id}`;
      const key = split ? `${base}|${name}` : base;
      const cur = rows.get(key);
      if (!cur) {
        rows.set(key, {
          id: g.id,
          title: g.title,
          slug: g.slug,
          account: name,        // <- the one account displayed for this game
          accounts: [name],     // <- every account that owns it
          copies: 1,
          shared: false,
          platforms: g.platforms || [],
          release_date: g.release_date || '',
          category: g.category || '',
          dlc_count: g.dlc_count || 0,
          url: `/api/${name}/game/${g.id}`,
          urls: { [name]: `/api/${name}/game/${g.id}` },
        });
        continue;
      }
      // same game again: never a second row, just more ownership on this one
      if (!cur.accounts.includes(name)) cur.accounts.push(name);
      cur.urls[name] = `/api/${name}/game/${g.id}`;
      cur.copies = cur.accounts.length;
      cur.shared = cur.accounts.length > 1;
      if (!cur.platforms.length) cur.platforms = g.platforms || [];
      if (!cur.release_date) cur.release_date = g.release_date || '';
    }
  }
  const out = [...rows.values()];
  return sharedOnly ? out.filter((r) => r.shared) : out;
}

/** Union of matches across accounts, grouped by game id, with ownership recorded. */
function searchAcrossAccounts(libs, query, limit) {
  const byId = new Map();
  for (const [name, lib] of libs) {
    for (const hit of searchLocal(lib.games, query, limit)) {
      const cur = byId.get(hit.id) || { ...hit, owned_by: [], match_by_account: {} };
      cur.owned_by.push(name);
      cur.match_by_account[name] = hit.match_score;
      cur.match_score = Math.max(cur.match_score, hit.match_score);
      if (!cur.platforms?.length) cur.platforms = hit.platforms;
      byId.set(hit.id, cur);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.match_score - a.match_score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** Which accounts own a given product id. Index-only, so it is fast. */
function ownershipOf(libs, id) {
  const ownedBy = [];
  const notOwnedBy = [];
  for (const [name, lib] of libs) {
    if (lib.games.some((g) => g.id === id)) ownedBy.push(name);
    else notOwnedBy.push(name);
  }
  return { owned_by: ownedBy, not_owned_by: notOwnedBy };
}

/**
 * Fetch a game's file list for one account and (optionally) resolve signed
 * links. Shared by the per-account and cross-account game routes.
 */
async function collectLinks(account, gameId, params, { concurrency = 3 } = {}) {
  const { meta, files } = await getGameFileList(account, gameId, {
    dlcs: params.get('dlc') !== '0',
    refresh: params.get('refresh') === '1',
  });
  let selected = filterFiles(files, params);
  if (params.get('limit')) selected = selected.slice(0, intEnvSafe(params.get('limit'), 100));

  const resolve = wantsResolve(params);
  const out = new Array(selected.length);
  if (resolve) {
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
  const linked = filesOut.filter((f) => f.download).length;
  const totalBytes = filesOut.reduce((a, f) => a + (f.bytes || 0), 0);
  return {
    meta,
    files: filesOut,
    total_files_in_game: files.length,
    counts: {
      returned: filesOut.length,
      linked,
      failed: filesOut.length - linked,
      by_type: filesOut.reduce((acc, f) => { acc[f.type] = (acc[f.type] || 0) + 1; return acc; }, {}),
      total_bytes: totalBytes,
      total_size: humanBytes(totalBytes),
    },
  };
}

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
  const storeMatches = ranked.slice(0, 5).map((x) => ({ id: x.p.id, title: x.p.title, owned: false }));
  let list;
  try {
    list = await getGameFileList(account, candidate.id, { dlcs: params.get('dlc') !== '0' });
  } catch (err) {
    if (err.code === 'not_owned') {
      // The name exists in the store but this account does not own it. Say so
      // clearly instead of the generic "not in account" message.
      err.message =
        `"${token}" is not in account "${account.name}"'s library. ` +
        `Nothing owned matched it; the closest GOG store result was ` +
        `${candidate.title} (${candidate.id}), which this account does not own. ` +
        `This endpoint only returns files for owned games - try /api/${account.name}/search?q=...&store=1 to browse.`;
      err.extra = { query: token, store_matches: storeMatches,
                    hint: `Owned games only. Library search: /api/${account.name}/search?q=${encodeURIComponent(token)}` };
    }
    throw err;
  }
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

    // ---- static web UI, plus the un-prefixed account alias -------------
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (url.pathname === '/favicon.ico' || url.pathname === '/robots.txt') {
        res.writeHead(204, corsHeaders());
        return res.end();
      }
      if (await serveStatic(res, url.pathname)) return;

      const segs = url.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
      const first = segs[0] || '';
      const ACCOUNT_SUBROUTES = ['game', 'search', 'library', 'link', 'file'];

      if (first && accounts.has(first)) {
        // /<account>/game/<id> is accepted as an alias of /api/<account>/game/<id>
        url.pathname = '/api' + url.pathname;
      } else if (accounts.size === 1 && ACCOUNT_SUBROUTES.includes(first)) {
        // with a single account, /game/<id> is unambiguous - be forgiving
        url.pathname = `/api/${encodeURIComponent([...accounts.keys()][0])}` + url.pathname;
      } else {
        throw new HttpError(404, 'not_found', `No such page: ${url.pathname}`, {
          hint: 'Download links live under /api/<account>/game/<id-or-name>. ' +
                'Browse the UI at / .',
          examples: accounts.size
            ? [...accounts.keys()].slice(0, 5).map((a) => `/api/${a}/game/<id-or-name>`)
            : ['/api/health', '/api/accounts', '/api/catalog?q=witcher  (no cookie needed)'],
          accounts: [...accounts.keys()],
        });
      }
    }

    // ---- everything below is the API ----------------------------------
    if (!checkApiKey(req, url)) {
      throw new HttpError(401, 'unauthorized', 'Missing or wrong API key (send X-API-Key header or ?key=).');
    }

    // Accounts are re-read from ACCOUNTS_URL here, i.e. for every API call,
    // so edits to the remote file take effect immediately.
    if (CONFIG.accountsUrl) await refreshAccountsFromUrl();

    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const route = parts.slice(1);
    const params = url.searchParams;

    // GET /api/health
    if (route[0] === 'health' && req.method === 'GET') {
      return send(200, {
        status: 'ok',
        uptime_seconds: Math.round(process.uptime()),
        accounts: accounts.size,
        accounts_source: acctSource.source,
        accounts_refresh: CONFIG.accountsUrl ? {
          per_call: CONFIG.accountsUrlTtl === 0,
          ttl_ms: CONFIG.accountsUrlTtl,
          last_success: acctSource.last_success ? new Date(acctSource.last_success).toISOString() : null,
          last_error: acctSource.last_error,
          fetches: acctSource.fetches,
          accounts_readonly: true,
        } : { accounts_readonly: false },
        api_key_required: Boolean(CONFIG.apiKey),
        caching: { library_ttl_ms: CONFIG.libraryTtl, details_ttl_ms: CONFIG.detailsTtl,
                   signed_links_cached: false },
        env_file: DOTENV.file
          ? { loaded: true, variables: DOTENV.applied.length, name: path.basename(DOTENV.file) }
          : { loaded: false },
        node: process.version,
      });
    }

    // GET /api/accounts | POST /api/accounts | DELETE /api/accounts/:name
    if (route[0] === 'accounts') {
      if (req.method === 'GET' && route.length === 1) {
        if (params.get('check') === '1') {
          await Promise.all([...accounts.values()].map(async (acc) => {
            try {
              await getLibrary(acc, { refresh: true });
              acc.sessionOk = true;
              acc.lastError = null;
            } catch (err) {
              acc.sessionOk = false;
              acc.lastError = err.message;
            }
          }));
        }
        // build the list *after* checking, so session_ok is current
        const list = [...accounts.values()].map((a) => a.publicInfo());
        return send(200, {
          count: accounts.size,
          accounts: list,
          source: acctSource.source,
          readonly: CONFIG.accountsUrl ? true : acctSource.source === 'env',
          hint: CONFIG.accountsUrl
            ? 'Accounts come from ACCOUNTS_URL and are re-read on every call. Edit that file to add or remove accounts.'
            : acctSource.source === 'env'
              ? 'Accounts come from environment variables (ACCOUNTS_ENV / ACCOUNT_<NAME>). Change the variable and restart.'
              : 'Accounts come from the local accounts file (POST /api/accounts to change them).',
        });
      }
      if (req.method === 'POST' && route[1] === 'reload') {
        if (CONFIG.accountsUrl) {
          const ok = await refreshAccountsFromUrl({ force: true });
          if (!ok && acctSource.last_error) {
            throw new HttpError(502, 'accounts_refresh_failed',
              `Could not refresh from ACCOUNTS_URL: ${acctSource.last_error}` +
              (accounts.size ? ` (still serving the previous ${accounts.size} account(s))` : ''));
          }
        } else {
          await loadInitialAccounts();
        }
        return send(200, { reloaded: true, source: acctSource.source,
                           count: accounts.size, accounts: [...accounts.keys()] });
      }
      if ((req.method === 'POST' || req.method === 'DELETE') && CONFIG.accountsUrl) {
        throw new HttpError(409, 'accounts_readonly',
          'Accounts are managed by ACCOUNTS_URL, so this server will not edit them. ' +
          'Change the remote file instead - the next API call picks it up.');
      }
      if ((req.method === 'POST' || req.method === 'DELETE') &&
          acctSource.source === 'env' && !CONFIG.accountsUrl) {
        throw new HttpError(409, 'accounts_readonly',
          'Accounts are managed by environment variables (ACCOUNTS_ENV / ACCOUNT_<NAME>), ' +
          'so this server will not write them to disk. Change the variable and restart, ' +
          'or unset it to fall back to the accounts file.');
      }
      if (req.method === 'POST' && route.length === 1) {
        const body = await readBody(req);
        // {"name": "...", "cookie": <header string | cookie array | {cookie}>, ...}
        // a bare cookie array is accepted too, named by ?name= or "default"
        const isBareJar = isCookieArray(body) || isCookieObject(body);
        const name = isBareJar
          ? (params.get('name') || 'default')
          : body.name;
        const cookieSrc = isBareJar ? body : (body.cookie ?? body.cookies);
        if (!name || cookieSrc == null) {
          throw new HttpError(400, 'bad_request',
            'Body must be {"name": "...", "cookie": "<header string>" } ' +
            'or {"name": "...", "cookie": [ <cookie-editor array> ]}');
        }
        const acc = new Account(String(name), cookieSrc);
        if (!acc.cookieCount) throw new HttpError(400, 'bad_cookie', 'No cookies parsed from that payload.');
        accounts.set(acc.name, acc);
        await saveAccounts();
        libCache.delete(`lib:${acc.name}`);
        return send(201, { added: acc.name, accounts: [...accounts.keys()],
                           cookie_count: acc.cookieCount, cookie_format: acc.format,
                           has_session_token: Boolean(acc.cookies['gog-al']) });
      }
      if (req.method === 'DELETE' && route[1]) {
        const name = decodeURIComponent(route[1]);
        if (!accounts.delete(name)) throw new HttpError(404, 'unknown_account', `No account "${name}"`);
        await saveAccounts();
        libCache.delete(`lib:${name}`);
        return send(200, { deleted: name, accounts: [...accounts.keys()] });
      }
    }

    // ---- cross-account routes (no account segment) ---------------------

    // GET /api/search?q=witcher&store=1&limit=25
    if (route[0] === 'search' && req.method === 'GET' && route.length === 1) {
      const q = params.get('q') || params.get('query');
      if (!q) throw new HttpError(400, 'missing_query', 'Add ?q=<game name>');
      if (!accounts.size) throw new HttpError(409, 'no_accounts', 'No accounts configured.');
      const limit = intEnvSafe(params.get('limit'), 25);
      const { libs, errors } = await allLibraries();
      const results = searchAcrossAccounts(libs, q, limit);
      let store;
      if (params.get('store') === '1') {
        const ownedIds = new Set(results.map((r) => r.id));
        try {
          store = (await catalogSearch(q, limit))
            .map((r) => ({ ...r, owned: ownedIds.has(r.id) }));
        } catch (err) { store = { error: err.message }; }
      }
      return send(200, {
        query: q,
        accounts_searched: [...libs.keys()],
        accounts_failed: errors,
        count: results.length,
        results,
        store: store ? { count: Array.isArray(store) ? store.length : 0, results: store } : undefined,
        note: 'owned_by lists every account that has this game. ' +
              'Use /api/game/<id> to get links from each of them.',
        elapsed_ms: Date.now() - started,
      });
    }

    // GET /api/owned/1423049311   ->  which accounts own that product id
    if (route[0] === 'owned' && req.method === 'GET' && route[1]) {
      const id = intEnvSafe(route[1], NaN);
      if (!Number.isFinite(id)) {
        throw new HttpError(400, 'bad_id', 'Product id must be numeric. For a name use /api/search?q=');
      }
      const { libs, errors } = await allLibraries();
      const { owned_by, not_owned_by } = ownershipOf(libs, id);
      let game = null;
      for (const name of owned_by) {
        const hit = libs.get(name).games.find((g) => g.id === id);
        if (hit) { game = hit; break; }
      }
      return send(200, {
        id, game,
        owned_by, not_owned_by,
        accounts_failed: errors,
        links: owned_by.length
          ? owned_by.map((a) => `/api/${a}/game/${id}?resolve=1`)
          : [],
      });
    }

    // GET /api/game/1423049311  or  /api/game/cyberpunk 2077   -> every account at once
    if (route[0] === 'game' && req.method === 'GET' && route[1]) {
      const token = decodeURIComponent(route.slice(1).join('/'));
      if (!accounts.size) throw new HttpError(409, 'no_accounts', 'No accounts configured.');
      const { libs, errors } = await allLibraries();

      // 1) work out which product we are talking about
      let id;
      let via = 'id';
      let matched = null;
      if (/^\d+$/.test(token)) {
        id = Number(token);
      } else {
        const hits = searchAcrossAccounts(libs, token, 5);
        if (hits.length && hits[0].match_score >= 40) {
          id = hits[0].id;
          via = 'library';
          matched = hits[0];
        } else {
          const ranked = (await catalogSearch(token, 10))
            .map((p) => ({ p, score: scoreMatch(token, p) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score);
          if (!ranked.length) {
            throw new HttpError(404, 'no_match',
              `Nothing matched "${token}" in any account or the GOG store.`);
          }
          id = ranked[0].p.id;
          via = 'catalog';
          matched = { ...ranked[0].p, alternatives: ranked.slice(1, 4).map((x) => x.p) };
        }
      }

      // 2) who owns it
      const { owned_by, not_owned_by } = ownershipOf(libs, id);
      const game = owned_by
        .map((n) => libs.get(n).games.find((g) => g.id === id))
        .find(Boolean) || (matched ? { id, title: matched.title, slug: matched.slug } : { id, title: String(id) });

      // 3) links from every owner (only when asked - costs a request per file)
      const withLinks = params.get('links') === '1' || params.get('resolve') === '1';
      const links = {};
      if (withLinks && owned_by.length) {
        const requested = params.get('accounts');
        const targets = requested
          ? owned_by.filter((n) => csv(requested).includes(n.toLowerCase()))
          : owned_by;
        await Promise.all(targets.map(async (name) => {
          const acc = accounts.get(name);
          try {
            const r = await collectLinks(acc, id, params);
            links[name] = { counts: r.counts, files: r.files };
          } catch (err) {
            links[name] = { error: err.message };
          }
        }));
      }

      const status = owned_by.length ? 200 : 404;
      return send(status, {
        query: token,
        game,
        resolved_via: via,
        matched: matched && { id: matched.id, title: matched.title,
                              alternatives: matched.alternatives },
        owned_by,
        not_owned_by,
        accounts_failed: errors,
        owned_by_count: owned_by.length,
        links: withLinks ? links : undefined,
        links_hint: owned_by.length
          ? `Add ?links=1 to include download links, e.g. /api/game/${id}?links=1`
          : 'No account owns this game.',
        elapsed_ms: Date.now() - started,
      });
    }

    // GET /api/library  -> merged library across all accounts
    if (route[0] === 'library' && req.method === 'GET' && route.length === 1) {
      const { libs, errors } = await allLibraries();
      const byId = new Map();
      for (const [name, lib] of libs) {
        for (const g of lib.games) {
          const cur = byId.get(g.id) || { ...g, owned_by: [] };
          cur.owned_by.push(name);
          byId.set(g.id, cur);
        }
      }
      let games = [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
      const q = params.get('q');
      if (q) games = searchLocal(games, q, intEnvSafe(params.get('limit'), 50));
      return send(200, {
        accounts: [...libs.keys()],
        accounts_failed: errors,
        total_unique: byId.size,
        count: games.length,
        games,
      });
    }

    // GET /api/games  -> every game in every account, one row per game
    //   ?by=id|title      dedupe key (default id; title also folds regional ids)
    //   ?split=1         one row per (game, account) instead of one per game
    //   ?shared=1        only games owned by 2+ accounts
    //   ?account=a,b     limit to these accounts
    //   ?q=              title filter
    //   ?sort=title|account|release|id   ?limit= ?offset=
    //   ?format=json|csv|ids
    if ((route[0] === 'games' || route[0] === 'all-games') && req.method === 'GET') {
      const started = Date.now();
      const on = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

      const by = (params.get('by') || 'id').toLowerCase();
      if (!['id', 'title'].includes(by)) {
        throw new HttpError(400, 'bad_by', '?by= must be "id" (default) or "title"');
      }
      const split = on(params.get('split'));
      const format = (params.get('format') || 'json').toLowerCase();
      if (!['json', 'csv', 'ids'].includes(format)) {
        throw new HttpError(400, 'bad_format', '?format= must be json, csv or ids');
      }

      let { libs, errors } = await allLibraries();

      // optional account filter
      const wanted = (params.get('account') || params.get('accounts') || '')
        .split(',').map((x) => x.trim()).filter(Boolean);
      if (wanted.length) {
        const unknown = wanted.filter((n) => !accounts.has(n));
        if (unknown.length) {
          throw new HttpError(404, 'unknown_account', `Unknown account(s): ${unknown.join(', ')}`, {
            accounts: [...accounts.keys()],
          });
        }
        errors = Object.fromEntries(Object.entries(errors).filter(([n]) => wanted.includes(n)));
        libs = new Map(wanted.map((n) => [n, libs.get(n)]).filter(([, l]) => l));
      }

      let rows = flattenLibrary(libs, {
        by, split, sharedOnly: on(params.get('shared')),
      });

      const q = params.get('q');
      if (q) {
        const qk = normTitleKey(q);
        rows = rows.filter((r) => normTitleKey(r.title).includes(qk));
      }

      const sort = (params.get('sort') || 'title').toLowerCase();
      const cmp = {
        title: (a, b) => a.title.localeCompare(b.title),
        account: (a, b) => a.account.localeCompare(b.account) || a.title.localeCompare(b.title),
        release: (a, b) => (b.release_date || '').localeCompare(a.release_date || '') ||
                            a.title.localeCompare(b.title),
        id: (a, b) => a.id - b.id,
      }[sort];
      if (!cmp) throw new HttpError(400, 'bad_sort', '?sort= must be title, account, release or id');
      rows.sort(cmp);

      const perAccount = {};
      for (const [name, lib] of libs) perAccount[name] = lib.games.length;
      const counts = {
        games: rows.length,                                            // rows returned
        shared: rows.filter((r) => r.shared).length,                    // owned by 2+ accounts
        copies: Object.values(perAccount).reduce((a, b) => a + b, 0),   // game-account pairs
        accounts: libs.size,
      };

      // pagination only applies when asked for, so the default is the full list
      const offset = Math.max(0, intEnvSafe(params.get('offset'), 0));
      const rawLimit = params.get('limit') ?? params.get('per_page');
      const limit = rawLimit === null || rawLimit === undefined
        ? null : Math.max(0, intEnvSafe(rawLimit, 100));
      const sliced = limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);

      const head = {
        accounts: [...libs.keys()],
        accounts_failed: errors,
        dedupe: by,
        split,
        sort,
        total_games: counts.games,
        shared_games: counts.shared,
        total_copies: counts.copies,
        per_account: perAccount,
        offset,
        limit: limit === null ? 'all' : limit,
        count: sliced.length,
      };

      if (format === 'ids') {
        const body = Buffer.from(sliced.map((r) => r.id).join('\n') + '\n');
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="gog-game-ids.txt"',
          ...corsHeaders(),
        });
        return res.end(body);
      }

      if (format === 'csv') {
        const esc = (v) => {
          const t = String(v ?? '');
          return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
        };
        const lines = ['id,title,account,accounts,shared,release_date,category,url'];
        for (const r of sliced) {
          lines.push([
            r.id, esc(r.title), esc(r.account), esc(r.accounts.join(' ')),
            r.shared ? 'yes' : 'no', r.release_date, esc(r.category),
          ].join(','));
        }
        const body = Buffer.from('\ufeff' + lines.join('\n') + '\n');  // BOM so Excel reads UTF-8
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="gog-games.csv"',
          ...corsHeaders(),
        });
        return res.end(body);
      }

      return send(200, { ...head, elapsed_ms: Date.now() - started, games: sliced });
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
      const { files: filesOut } = await collectLinks(account, meta.id, params);

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

    throw new HttpError(404, 'not_found', `No route for ${req.method} ${url.pathname}`, {
      hint: 'Account routes: /api/<account>/library | /search?q= | /game/<id-or-name> | /link?path= | /file?path=',
      accounts: [...accounts.keys()],
    });
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
  if (CONFIG.accountsUrl) {
    log(`accounts source: URL (${CONFIG.accountsUrl.replace(/\?.*$/, '')})`);
    log(`  refresh policy: ${CONFIG.accountsUrlTtl === 0 ? 'on every API call' : `cached for ${CONFIG.accountsUrlTtl} ms`}`);
  }
  await loadInitialAccounts();
  server.listen(CONFIG.port, CONFIG.host, () => {
    log(`listening on http://${CONFIG.host}:${CONFIG.port}`);
    log(`accounts: ${[...accounts.keys()].join(', ') || '(none - see accounts.example.json)'}`);
    log(`signed links are resolved live per request and never cached`);
    if (!CONFIG.apiKey) log('note: no API_KEY set - anyone who can reach this port can use your accounts');
  });
})();

process.on('SIGINT', () => { log('shutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { log('shutting down'); server.close(() => process.exit(0)); });
