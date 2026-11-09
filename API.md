# GOG Link API — complete reference

Every endpoint, parameter, response shape and error the server implements, verified against a
running instance. Base URL is wherever you run it, e.g. `http://localhost:3000`.

- Zero dependencies, Node 18+ (uses global `fetch`).
- Accounts come from a URL, environment variables or a file — no login step, you paste cookies.
- **Download links are never stored.** They are minted live per request and expire in ~24 h.

```
All routes                          JSON unless stated
──────────────────────────────────────────────────────────────────────────
GET  /api/health                    GET    /api/accounts
POST /api/accounts                  DELETE /api/accounts/:name
POST /api/accounts/reload
GET  /api/search                    GET    /api/owned/:id
GET  /api/game/:idOrName            GET    /api/library
GET  /api/games                     GET    /api/catalog
GET  /api/:account                  GET    /api/:account/library
GET  /api/:account/search           GET    /api/:account/game/:idOrName
GET  /api/:account/link             GET    /api/:account/file      (binary stream)
```

---

## 1. Conventions

| | |
|---|---|
| Content type | `application/json; charset=utf-8`, except `/api/:account/file` (binary) and `?format=csv\|ids` |
| Caching | `cache-control: no-store` on every API response |
| Auth | optional `X-API-Key: <key>` header, or `?key=<key>`. Only enforced when `API_KEY` is set |
| CORS | off by default; set `CORS_ORIGIN=*` (or an origin) to allow browser calls |
| Errors | `{ "error": "<code>", "message": "<human text>", ...extra }` |
| IDs | GOG product ids are integers and interchangeable between the library, the store and `gameDetails` |

---

## 2. Configuration

All of these can be set as environment variables **or** in a `.env` file next to the app. A real
environment variable always wins over the file.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `ACCOUNTS_URL` | — | Fetch accounts from a URL (gist, S3, any JSON). Re-read on **every API call** |
| `ACCOUNTS_URL_TTL_MS` | `0` | `0` = fetch per call; e.g. `15000` caches for 15 s |
| `ACCOUNTS_ENV` | — | Whole accounts JSON, or one raw cookie header, in a variable. Alias: `ACCOUNTS_JSON` |
| `ACCOUNT_<NAME>` | — | One account per variable, named after the suffix (lowercased) |
| `ACCOUNTS_FILE` | `./accounts.json` | Accounts file — or a folder with one file per account |
| `API_KEY` | — | When set, every API call must present it |
| `CACHE_TTL_MS` | `300000` | Library index cache (metadata only) |
| `DETAILS_TTL_MS` | `30000` | Per-game file list cache; `0` = strict live |
| `MAX_OUTBOUND` | `6` | Concurrent requests to gog.com |
| `RATE_LIMIT_PER_MIN` | `240` | Per client IP |
| `CORS_ORIGIN` | — | e.g. `*` to allow cross-origin browser calls |
| `RESOLVE_BY_DEFAULT` | `1` | `0` makes link resolution opt-in (`?resolve=1`) |
| `ENV_FILE` | `./.env` | Read a different env file |
| `QUIET` | `0` | `1` disables per-request logging |
| `COUNTRY` / `LOCALE` / `CURRENCY` | `US` / `en-US` / `USD` | Store catalog region |

**Account source precedence:** `ACCOUNTS_URL` → `ACCOUNT*` env vars → `ACCOUNTS_FILE`.

```ini
# .env
ACCOUNTS_URL=https://gist.githubusercontent.com/USER/GISTID/raw/accounts.json
API_KEY=choose-a-long-random-string
PORT=3000
```

> Use the **unpinned** gist URL (`/raw/accounts.json`). A URL containing a commit hash serves that
> old revision forever, so later edits never reach the server.

---

## 3. Cookie formats

Any of these is accepted wherever a cookie is expected (`accounts.json`, `ACCOUNTS_ENV`,
`ACCOUNT_<NAME>`, `POST /api/accounts`):

| Shape | Example |
|---|---|
| Raw `Cookie` header | `gog-al=…; gog_us=…; gog_lc=US_USD_en-US` |
| Cookie-Editor JSON array | `[{"domain":".gog.com","name":"gog-al","value":"…","path":"/"}, …]` |
| Wrapped | `{"cookie": …}` or `{"cookies": […]}`, and `{"name": "acc", "cookie": …}` |
| JSON as a string | the array pasted as an escaped string — parsed automatically |

Only `gog.com` cookies are kept; expired ones are dropped. `gog-al` is the session token and is
required; `gog_us` is also needed. GOG rotates `gog-al` on responses and the server carries the new
value forward like a browser would (`token_rotations` counts that).

---

## 4. `GET /api/health`

No cookie, no key needed (unless `API_KEY` is set). Use it as a readiness probe.

```json
{
  "status": "ok",
  "uptime_seconds": 104,
  "accounts": 7,
  "accounts_source": "url",
  "accounts_refresh": {
    "per_call": true, "ttl_ms": 0,
    "last_success": "2026-11-09T15:57:48.837Z",
    "last_error": null, "fetches": 22, "accounts_readonly": true
  },
  "api_key_required": false,
  "caching": { "library_ttl_ms": 300000, "details_ttl_ms": 30000, "signed_links_cached": false },
  "env_file": { "loaded": true, "variables": 1, "name": ".env" },
  "node": "v20.20.2"
}
```

`accounts_source` is `url`, `env` or `file`. `accounts_refresh` is only present for URL mode.

---

## 5. Account management

### `GET /api/accounts`

Cookie **values are never returned** — only names, counts and formats.

| Param | | |
|---|---|---|
| `check=1` | off | verify every session against GOG first (slower, one request per account) |

```json
{
  "count": 2,
  "accounts": [
    { "name": "main", "cookie_format": "array", "cookie_count": 33,
      "has_session_token": true, "token_rotations": 4,
      "last_used": "2026-11-09T15:30:02.101Z", "session_ok": true, "last_error": null }
  ],
  "source": "url",
  "readonly": true,
  "hint": "Accounts come from ACCOUNTS_URL and are re-read on every call. …"
}
```

`readonly` is `true` whenever accounts come from `ACCOUNTS_URL` or env vars.

### `POST /api/accounts`

Adds or replaces one account. **File mode only.**

```json
{ "name": "main", "cookie": "gog-al=…; gog_us=…" }
{ "name": "alt",  "cookie": [ { "domain": ".gog.com", "name": "gog-al", "value": "…" } ] }
```

A bare cookie array (no `name`) is also accepted and named by `?name=` or `default`.
`201` on success:

```json
{ "added": "main", "accounts": ["main","alt"], "cookie_count": 36,
  "cookie_format": "header", "has_session_token": true }
```

`409 accounts_readonly` when accounts come from a URL or env vars; `400 bad_cookie` if nothing parses.

### `DELETE /api/accounts/:name`

Removes the account from the local file. Same read-only rule. → `{ "deleted": "main", "accounts": [...] }`

### `POST /api/accounts/reload`

Re-reads accounts from the configured source; with `ACCOUNTS_URL` it forces a fetch.

```json
{ "reloaded": true, "source": "url", "count": 2, "accounts": ["main","alt"] }
```

`502 accounts_refresh_failed` if the forced fetch fails (the previous accounts keep serving).

---

## 6. Cross-account routes (no account segment)

### `GET /api/search?q=`

Search by name across every account; reports who owns each hit.

| Param | Default | |
|---|---|---|
| `q` / `query` | **required** | search text |
| `limit` | `25` | max results |
| `store` | off | `1` adds GOG store matches that nobody owns |

```json
{
  "query": "witcher",
  "accounts_searched": ["account1","account4","account7"],
  "accounts_failed": {},
  "count": 2,
  "results": [
    { "id": 1207658924, "title": "The Witcher: Enhanced Edition",
      "slug": "the_witcher", "platforms": ["windows","mac"],
      "release_date": "2007-10-26", "category": "Role-playing", "dlc_count": 0,
      "owned_by": ["account1","account4","account7"],
      "match_by_account": { "account1": 100, "account4": 100, "account7": 100 },
      "match_score": 100 }
  ],
  "store": { "count": 12, "results": [ { "id": 1423049311, "title": "…", "owned": false } ] },
  "note": "owned_by lists every account that has this game. …",
  "elapsed_ms": 212
}
```

`store` appears only with `store=1`. Results are ranked by `match_score` (exact 100, prefix 90,
word 76, substring 68).

### `GET /api/owned/:id`

Who owns a product id. Index-only — no GOG request beyond the cached library.

```json
{
  "id": 1207658924,
  "game": { "id": 1207658924, "title": "The Witcher: Enhanced Edition", "slug": "the_witcher" },
  "owned_by": ["account1","account4","account7"],
  "not_owned_by": ["account2","account3","account5","account6"],
  "accounts_failed": {},
  "links": ["/api/account1/game/1207658924?resolve=1", "…"]
}
```

`400 bad_id` for a non-numeric id. A valid-but-unowned id is `200` with `owned_by: []`.

### `GET /api/game/:idOrName`

Resolve a name **or** id once, then report ownership everywhere and optionally mint links from every
owner. `404` (with `owned_by: []`) when no account owns it.

| Param | Default | |
|---|---|---|
| `links` / `resolve` | off | `1` includes file lists **and signed links** per owning account |
| `accounts` | all owners | `a,b` restricts which owners are queried |
| `types` / `type` | all | `installer,patch,dlc,extras,galaxy` |
| `os` | all | `windows,mac,linux` |
| `lang` / `language` | all | e.g. `en,fr` |
| `files` | — | regex on file name/path |
| `limit` | 100 | cap files per account |
| `dlc` | `1` | `0` skips DLC files |
| `resolve` | `1` | `0` lists files without minting links |

```json
{
  "query": "1207658924",
  "game": { "id": 1207658924, "title": "The Witcher: Enhanced Edition",
            "slug": "the_witcher", "platforms": ["windows","mac"],
            "release_date": "2007-10-26", "category": "Role-playing" },
  "resolved_via": "id",
  "matched": null,
  "owned_by": ["account1","account4","account7"],
  "not_owned_by": ["account2","account3"],
  "accounts_failed": {},
  "owned_by_count": 3,
  "links": {
    "account1": { "counts": { "returned": 1, "linked": 1, "failed": 0,
                              "by_type": { "installer": 1 },
                              "total_bytes": 1000000, "total_size": "1.0 MB" },
                  "files": [ /* file objects, see §11 */ ] }
  },
  "links_hint": "Add ?links=1 to include download links, e.g. /api/game/1207658924?links=1",
  "elapsed_ms": 365
}
```

`resolved_via` is `id` (numeric input), `library` (matched an owned title) or `catalog` (matched the
store only). `matched.alternatives` lists near misses.

> **Cost:** without `links=1` this is index-only and free. With `links=1` it costs one GOG request
> per file **per owning account** — always combine it with `limit`, `types` or `os`.

### `GET /api/library`

Merged library, one entry per product id, each carrying `owned_by`.

| Param | Default | |
|---|---|---|
| `q` | — | filter titles |
| `limit` | 50 | only applies when `q` is given |

```json
{ "accounts": ["account1","account3"], "accounts_failed": {},
  "total_unique": 347, "count": 347,
  "games": [ { "id": 1207658924, "title": "…", "slug": "…", "platforms": ["windows"],
               "release_date": "2007-10-26", "category": "…", "dlc_count": 0,
               "owned_by": ["account1","account3"] } ] }
```

### `GET /api/games` (alias `/api/all-games`)

**Every game in every account, one row per game.** A title owned by three accounts appears once,
with a single `account` displayed and the full ownership in `accounts`.

| Param | Default | |
|---|---|---|
| `account` | all | `a,b` limits the list to those accounts |
| `q` | — | title filter (punctuation/“The ” insensitive) |
| `shared` | off | `1` = only games owned by 2+ accounts |
| `split` | off | `1` = unmerged view, one row per (game, account) |
| `by` | `id` | `title` also folds the same title stored under different regional ids |
| `sort` | `title` | `title`, `account`, `release`, `id` |
| `limit` / `offset` | all | paging is opt-in — omit `limit` for the whole list |
| `format` | `json` | `csv` (UTF-8 + BOM, Excel-safe) or `ids` (one id per line) |

```json
{
  "accounts": ["account1","account3","account2"],
  "accounts_failed": {},
  "dedupe": "id", "split": false, "sort": "title",
  "total_games": 347, "shared_games": 179, "total_copies": 534,
  "per_account": { "account1": 314, "account3": 205, "account2": 15 },
  "offset": 0, "limit": "all", "count": 347,
  "elapsed_ms": 240,
  "games": [
    { "id": 2099051765, "title": "9 Years of Shadows", "slug": "9_years_of_shadows",
      "account": "account1", "accounts": ["account1","account3"],
      "copies": 2, "shared": true,
      "platforms": ["windows"], "release_date": "2023-03-27",
      "category": "Action", "dlc_count": 0,
      "url": "/api/account1/game/2099051765",
      "urls": { "account1": "/api/account1/game/2099051765",
                "account3": "/api/account3/game/2099051765" } }
  ]
}
```

- `total_copies` (game-account pairs) minus `total_games` is exactly the duplication this endpoint removes.
- `account` is deterministic: the first owning account in your configured order, identical on every call.
- `format=csv` sends `content-disposition: attachment; filename="gog-games.csv"`.

### `GET /api/catalog?q=`

GOG store search. **No cookie needed** — also the name→id resolver used internally.

| Param | Default | |
|---|---|---|
| `q` / `query` | **required** | search text |
| `limit` | `12` | max 48 |
| `account` | — | marks each result `owned: true/false` for that account |

```json
{ "query": "cyberpunk", "count": 2, "account": null,
  "results": [ { "id": 1423049311, "title": "Cyberpunk 2077", "slug": "cyberpunk_2077",
                 "product_type": "game", "release_date": "2020-12-10",
                 "platforms": ["windows"], "cover": "https://…", "store_link": "https://…",
                 "price": { "amount": "59.99", "currency": "USD" },
                 "developers": ["CD PROJEKT RED"], "owned": null } ] }
```

`owned` is `null` unless `?account=` is supplied.

---

## 7. Per-account routes

Everything is namespaced `/api/<account>/…`. The un-prefixed form `/<account>/game/…` works as an
alias, and with a single configured account `/game/…` is accepted too.

### `GET /api/:account`

Overview of one account.

```json
{ "name": "account1", "cookie_format": "array", "cookie_count": 33,
  "has_session_token": true, "token_rotations": 3,
  "last_used": "2026-11-09T15:57:02.000Z", "session_ok": true, "last_error": null,
  "owned_games": 314, "library_fetched_at": "2026-11-09T15:52:11.000Z",
  "endpoints": { "library": "/api/account1/library", "search": "/api/account1/search?q=witcher",
                 "game": "/api/account1/game/1207667203",
                 "game_by_name": "/api/account1/game/cyberpunk%202077",
                 "link": "/api/account1/link?path=/downloads/<slug>/<fileId>",
                 "file": "/api/account1/file?path=/downloads/<slug>/<fileId>" } }
```

### `GET /api/:account/library`

| Param | | |
|---|---|---|
| `q` | filter titles (max 50 unless `limit` given) |
| `limit` | max items when `q` is present |
| `refresh` | `1` bypasses the cache |

```json
{ "account": "account1", "total": 314, "count": 200,
  "fetched_at": "2026-11-09T15:52:11.000Z",
  "games": [ { "id": 1207658924, "title": "…", "slug": "…", "platforms": ["windows"],
               "release_date": "2007-10-26", "category": "…", "dlc_count": 0 } ] }
```

### `GET /api/:account/search?q=`

| Param | | |
|---|---|---|
| `q` | **required** |
| `limit` | default 15 |
| `store` | `1` adds store results with `owned: true/false` |

```json
{ "account": "account1", "query": "witcher",
  "library": { "count": 2, "results": [ { "id": 1207658924, "title": "…", "match_score": 100 } ] },
  "store": { "count": 15, "results": [ { "id": 1423049311, "owned": false } ] } }
```

### `GET /api/:account/game/:idOrName`

**The main endpoint.** Every installer, patch, DLC, extra and Galaxy build for one game, each with a
freshly signed CDN link. Accepts the same filter parameters as `/api/game/:idOrName`.

```
GET /api/account1/game/cyberpunk%202077?types=installer&os=windows&limit=5
```

```json
{
  "account": "account1",
  "game": { "id": 1207667203, "title": "The Witcher 2: Assassins of Kings Enhanced Edition",
            "slug": "the_witcher_2", "cd_keys": ["…"], "changelog": "" },
  "matched": { "id": 1207667203, "title": "…", "match_score": 90, "alternatives": [] },
  "resolved_via": "library",
  "resolved_links": true,
  "scraped_at": "2026-11-09T16:02:44.512Z",
  "elapsed_ms": 812,
  "counts": { "total_files_in_game": 24, "returned": 5, "linked": 5, "failed": 0,
              "by_type": { "installer": 5 }, "total_bytes": 12884901888,
              "total_size": "12.9 GB" },
  "files": [ /* file objects, see §11 */ ],
  "note": "download = signed CDN URL, generated live and valid ~24h. Never cached by this server."
}
```

Name resolution order: exact id → your library (scored, threshold 40) → GOG store. `resolved_via`
tells you which one matched. If the name exists in the store but this account does not own it, you
get `404 not_owned` with a message naming the closest store result — deliberately different from
`404 no_match`.

### `GET /api/:account/link?path=`

One signed URL for a known GOG path. Cheapest way to refresh a single link.

```
GET /api/account1/link?path=/downloads/the_witcher/1423049311
```

```json
{ "account": "account1",
  "path": "/downloads/the_witcher/1423049311",
  "download": "https://gog-cdn-fastly.gog.com/content-system/v2/…?token=nva=1762…",
  "expires_at": "2026-11-10T16:02:44.000Z",
  "expires_in_seconds": 86400,
  "elapsed_ms": 210 }
```

`400 missing_path` if absent, `404 file_not_found` if GOG has no such file.

### `GET /api/:account/file?path=`

Streams the file **through** the server instead of redirecting to the CDN. Supports HTTP `Range`
(`206 Partial Content`), so download managers can resume/parallelise. Response is binary with
`content-disposition: attachment`.

Because a browser `<a href>` cannot send headers, pass the key in the query string:

```
/api/account1/file?path=/downloads/the_witcher/<fileId>&key=<API_KEY>
```

---

## 8. File object

Returned in `files` everywhere.

| Field | Meaning |
|---|---|
| `type` | `installer`, `patch`, `extras`, `dlc` or `galaxy` |
| `os` | `windows`, `mac`, `linux`, or `""` |
| `language` | `en`, `fr`, … or `""` |
| `name` | human name, DLC files are prefixed `"<DLC title>: "` |
| `version` | version string when GOG provides one |
| `size` / `bytes` | pretty size and exact bytes |
| `path` | canonical GOG path, e.g. `/downloads/the_witcher/1423049311` |
| `url` | `https://www.gog.com` + `path` — works with a cookie, no signature |
| `download` | **signed CDN URL**, valid ~24 h; `null` with `resolve=0` |
| `expires_at` / `expires_in_seconds` | parsed from the signed token (`nva=`) |
| `error` | present instead of `download` when that one file failed |

---

## 9. Error codes

```json
{ "error": "not_owned", "message": "\"x\" is not in account \"main\"'s library. …",
  "query": "x", "store_matches": [ … ], "hint": "…" }
```

| Code | HTTP | Cause |
|---|---|---|
| `unauthorized` | 401 | missing/wrong API key |
| `bad_request` | 400 | POST body without `name`/`cookie` |
| `bad_json` | 400 | body is not valid JSON |
| `bad_cookie` | 400 | no cookies parsed from the payload |
| `bad_id` | 400 | `/api/owned/:id` with a non-numeric id |
| `bad_by` / `bad_sort` / `bad_format` | 400 | invalid `?by=`, `?sort=`, `?format=` |
| `missing_query` | 400 | `?q=` required |
| `missing_path` | 400 | `?path=` required |
| `not_found` | 404 | unknown route; body includes `hint`, `examples`, `accounts` |
| `unknown_account` | 404 | no account with that name |
| `no_match` | 404 | name matched neither any library nor the store |
| `not_owned` | 404 | game exists but this account does not own it |
| `file_not_found` | 404 | GOG has no such file path |
| `accounts_readonly` | 409 | accounts come from `ACCOUNTS_URL` / env vars |
| `no_accounts` | 409 | no accounts configured at all |
| `rate_limited` | 429 | per-IP limit (`RATE_LIMIT_PER_MIN`) |
| `accounts_refresh_failed` | 502 | forced reload of `ACCOUNTS_URL` failed |
| `cookie_expired` | 502 | GOG rejected the session (401/403 upstream) |
| `upstream_busy` | 502 | GOG returned 429/5xx after retries |
| `upstream_error` | 502 | GOG returned another non-OK status |
| `upstream_unreachable` | 504 | network failure / timeout to gog.com |
| `resolve_failed` / `cdn_error` / `no_redirect_location` | 502 | couldn't mint or fetch a signed URL |
| `catalog_unreachable` / `catalog_error` | 504/502 | catalog.gog.com failed |
| `bad_upstream_json` | 502 | GOG returned unparseable JSON |
| `body_too_large` | 413 | POST body > 1 MB |
| `internal_error` | 500 | unexpected |

**One dead account never breaks a call:** it lands in `accounts_failed` and every other account
still returns data.

---

## 10. Client examples

```bash
# everything, one row per game
curl "localhost:3000/api/games?shared=1&format=csv" -o games.csv

# who owns it
curl "localhost:3000/api/owned/1207658924"

# links from every owner, filtered
curl "localhost:3000/api/game/the%20witcher%20enhanced?links=1&types=installer&os=windows&limit=2"

# one account, streaming through the server (resumable)
curl -L -o game.bin "localhost:3000/api/main/file?path=/downloads/x/y"

# with an API key
curl -H "X-API-Key: $KEY" "localhost:3000/api/accounts"
```

```js
const r = await fetch('http://localhost:3000/api/account1/game/1207667203?types=installer', {
  headers: { 'X-API-Key': process.env.KEY },
});
const { files } = await r.json();
for (const f of files) console.log(f.name, f.download);
```

```python
import requests
B = "http://localhost:3000"
h = {"X-API-Key": KEY}
lib = requests.get(f"{B}/api/games", headers=h).json()
print(lib["total_games"], "unique games across", len(lib["accounts"]), "accounts")
g = requests.get(f"{B}/api/game/1091500", params={"links": 1, "os": "windows"}, headers=h).json()
print(g["owned_by"], [f["name"] for f in g["links"][g["owned_by"][0]]["files"]])
```

---

## 11. Limits & behaviour

| | |
|---|---|
| Cost of ownership | one GOG library request per account per `CACHE_TTL_MS` (5 min) |
| Cost of links | one GOG request **per file** — cap with `limit`, `types`, `os` |
| Link lifetime | ~24 h (`expires_in_seconds`); never cached, never logged |
| Concurrency | `MAX_OUTBOUND` (6) requests to gog.com at once, queueing the rest |
| File-list cache | `DETAILS_TTL_MS` (30 s); `?refresh=1` bypasses it |
| Rate limit | `RATE_LIMIT_PER_MIN` (240) per IP → `429` |
| Reserved names | `search`, `game`, `owned`, `library`, `games`, `catalog`, `accounts`, `health` — an account with one of these names would shadow a route |

---

## 12. Security

A cookie is **full account access**. The API never echoes cookie values, but:

- Keep `ACCOUNTS_URL` / `.env` out of public repos. A public gist holds live sessions.
- Set `API_KEY` and put the service behind HTTPS before exposing it.
- Prefer `?key=` only for browser stream links; use the `X-API-Key` header everywhere else, so the
  key stays out of access logs.
- Rotate `gog-al` for any account whose cookies were shared in a chat or screenshot.
