# GOG library scraper — download links for the games you own

> **Two tools live here.** `gog_library.py` (below) is a single-account batch
> downloader. The multi-account **API server** you asked for is `server.js` —
> see **[API.md](API.md)**: per-account routes (`/api/<account>/game/<id-or-name>`),
> live scraping with no stored links, a search endpoint and a web UI.
> Accounts can come from a local file **or a remote URL re-read on every call**
> (`ACCOUNTS_URL=…`). The whole project also ships as `gog-link-api.zip`.

A single-file, dependency-free Python tool that logs in with your existing GOG
session cookie, walks your **purchased library**, and gives you the **direct
download links** for every installer, patch, DLC, soundtrack/manual and Galaxy
build — plus a resumable downloader if you'd rather pull the files than paste
links.

Works against GOG's own internal endpoints (the same ones the site's
"My collection" page calls):

| purpose | endpoint |
|---|---|
| list owned products | `embed.gog.com/account/getFilteredProducts?mediaType=1&page=N` |
| per-game files | `embed.gog.com/account/gameDetails/{id}.json` |
| signed CDN link | `www.gog.com/downloads/{slug}/{fileId}` → `302` → CDN URL |

```
gog_library.py       # the tool (stdlib only, Python 3.9+)
gog_links.json       # full catalog of your library + links  (already generated)
gog_links.csv        # same data, spreadsheet-friendly
gog_aria2.txt        # aria2c input file
cache/               # per-game API responses, makes re-runs instant
```

Your last full run: **445 games → 4,698 files, ≈4.2 TB** if you grabbed literally everything
(installers + patches + DLC + extras + Galaxy builds, all platforms, all languages).

---

## ⚠️ Read this first — about the cookie

The `Cookie:` header you paste **is your account**. Anyone holding it can browse
your library, change your data and spend your wallet — no password needed. Treat
it like a password, because it is one.

* **You pasted a live cookie into this chat**, so treat that session as exposed.
  When you're done experimenting: change your GOG password and, if offered, use
  "log out of all devices", then grab a fresh cookie. Everything below keeps
  working with the new one.
* I deliberately did **not** write your cookie into any file in this workspace —
  the tests above read it from `/tmp`, which isn't part of the saved project.
  Nothing in `gog_library.py`, the README, or the generated JSON/CSV contains it.
* Prefer the environment variable over the inline `--cookie` flag: command-line
  arguments end up in shell history and in `ps` output.
* `--save-cookie` writes refreshed cookies with `chmod 600`. Keep that file
  outside your repos — `.gitignore` here already covers the usual names.

Only download what you paid for, keep it for yourself, and don't hammer the API.
GOG rotates the `gog-al` session token on every response; the tool carries
rotations forward in memory, and `--save-cookie` lets you persist them.

---

## Quick start

```bash
# 1. put the cookie in the environment (quotes matter — it contains ; and spaces)
export GOG_COOKIE='gog-al=…; gog_us=…; gog_lc=SG_USD_en-US; …'

# 2. sanity check + see what you own
python3 gog_library.py check
python3 gog_library.py list --print

# 3. build the link catalog
python3 gog_library.py links --out gog_links.json --csv gog_links.csv

# 4. or just download
python3 gog_library.py download --outdir ./GOG --types installer --os windows --lang english
```

Where to find the cookie: log in at gog.com → DevTools → **Network** tab → click
any request to `www.gog.com` or `embed.gog.com` → **Request Headers** →
right-click the `Cookie:` value → *Copy value*.

Cheaper alternative: export the cookies with a browser extension and pass the file
to `--cookie-file`. Three formats are auto-detected: a plain `a=1; b=2` header line,
a Netscape `cookies.txt`, or a cookie-editor **JSON export** (the `[{domain, name,
value, …}]` array).

---

## Commands

### `check`
Verifies the session and prints product counts. Good first move after any
cookie change.

### `list`
```bash
python3 gog_library.py list --csv library.csv --json library.json
```
Columns: `id, title, slug, platforms, release_date, category, dlc_count`.

### `links` — the thing you actually asked for
```bash
# everything, all platforms, machine-readable
python3 gog_library.py links --types installer patch extras dlc galaxy \
        --os windows mac linux --out gog_links.json --csv gog_links.csv

# one game, with real signed CDN URLs
python3 gog_library.py links --game "cyberpunk" --resolve --print

# feed to a download manager (aria2c -i gog_aria2.txt)
python3 gog_library.py links --txt gog_aria2.txt
```

Output shape:

```json
{ "generated": "…", "resolved": false, "game_count": 445, "file_count": 4698,
  "games": [ { "id": 1207660773, "title": "7th Legion", "slug": "7th_legion",
    "platforms": ["windows"], "release_date": "1997-09-30",
    "files": [ { "type": "installer", "os": "windows", "language": "English",
                 "name": "7th Legion", "size": "255 MB", "bytes": 255000000,
                 "path": "/downloads/7th_legion/en1installer1",
                 "url": "https://www.gog.com/downloads/7th_legion/en1installer1" } ] } ] }
```

**Two kinds of link — pick deliberately:**

| | `url` (default) | `--resolve` |
|---|---|---|
| form | `https://www.gog.com/downloads/…` | `https://gog-cdn-fastly.gog.com/token=…/secure/…/setup_x.exe` |
| needs your cookie | yes | no |
| lifetime | as long as your session | **~24 h**, then re-run |
| speed of generation | seconds (cached) | ~1 request per file, so minutes |

So: for archiving a page of clickable links → leave `url` (works in your logged-in
browser, never expires). For feeding a download manager you don't want to give
cookies to, or scripts on another box → `--resolve` and use it quickly.

### `download`
Resumable, organised, and re-resolves the signed link *immediately before* each
transfer so long queues never hit an expired token.

```bash
python3 gog_library.py download --outdir ./GOG \
        --types installer --os windows --lang english \
        --game "witcher|cyberpunk" --max-size 20GB

python3 gog_library.py download --outdir ./GOG --types extras --dry-run
```

Layout:

```
GOG/
  The Witcher 3 Wild Hunt/
    installers/windows/English/setup_the_witcher_3_wild_hunt_4.04_(64bit)_(71287).exe
    patches/windows/English/patch_…
    extras/the_witcher_3_wild_hunt_soundtrack_flac.zip
    dlc/…
    galaxy/…
```

Behaviour: real filenames come from the CDN redirect; `.part` files resume with
HTTP `Range`; a file is only renamed when its byte count matches; failures are
retried with backoff and summarised at the end (exit code 1); files already
complete are skipped, so re-running the same command is the way to pick up after
a crash.

---

## Filters (shared by `links` and `download`)

| flag | meaning |
|---|---|
| `--types installer patch extras dlc galaxy` | what to include (default `installer`) |
| `--os windows mac linux` | platform filter (default `windows`; `extras` have no OS) |
| `--lang english german …` | language filter, case-insensitive (default all) |
| `--game REGEX` | match on title or slug |
| `--files REGEX` | match on file name/path, e.g. `--files "Part 1 of"` |
| `--max-size 2GB` | skip anything estimated bigger |
| `--no-dlc` | don't expand DLC sub-products |
| `--refresh` | ignore `cache/` and re-fetch details |

Plumbing: `--jobs N` (parallel API calls, default 4), `--delay S` (default 0.15 s
between requests), `--cache-dir ''` to disable caching, `--retries N`,
`--no-resume`, `--quiet`, `--dry-run`.

---

## Using the links elsewhere

**Browser** — default `url` values just work while you're logged in at gog.com.

**aria2c** (fastest, multi-connection):
```bash
python3 gog_library.py links --txt gog_aria2.txt \
        --save-cookie cookies.netscape.txt --save-cookie-netscape
aria2c -i gog_aria2.txt -c -x8 -s8 -j4 \
       --load-cookies=cookies.netscape.txt --save-cookie=cookies.netscape.txt
```

**curl** — follow the redirect yourself:
```bash
curl -L -C - -b "$GOG_COOKIE" \
     "https://www.gog.com/downloads/7th_legion/en1installer1" -o part1.exe
```

---

## How it handles GOG's quirks

* `downloads` arrives as `[[language, {os: [files]}], …]`, sometimes as a dict —
  both are normalised.
* `dlcs` embeds **full detail objects**, not ids; those are parsed inline so DLC
  installers and DLC soundtracks show up (73 files in your library). Bare ids are
  fetched separately and guarded against recursion.
* `galaxyDownloads` + `simpleGalaxyInstallers` are deduplicated by path.
* GOG rotates `gog-al` on each response; the client keeps the rotated jar.
* A redirect's `Content-Length` is the HTML stub, not the file — sizes come from
  the API estimate and are corrected from the actual transfer.
* `401/403` stops with a clear "cookie expired" message instead of silently
  producing an empty catalog.
* Signed links embed `nva=<unix ts>` — that's the expiry, ~24 h out.

## Troubleshooting

| symptom | fix |
|---|---|
| `401/403` | cookie expired → log in again, copy a fresh `Cookie:` header |
| `total_products: 0` | wrong cookie (pre-login session) or you're not logged in |
| empty `files` for one game | Galaxy-only title or a movie; check `--types galaxy` |
| `429` / slow | lower `--jobs` to 2 and raise `--delay` to 0.5 |
| links stop after a day | expected for `--resolve`; regenerate |
| disk full | `--max-size`, or `--types installer --os windows` |

Cached API responses live in `cache/details_<id>.json` (plain JSON, 3.5 MB for
445 games, no secrets). Delete the folder or pass `--refresh` to start clean.
