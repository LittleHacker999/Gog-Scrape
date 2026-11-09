#!/usr/bin/env python3
"""
gog_library.py - list your GOG library and resolve direct download links.

Standard library only. No pip installs needed.

Auth: pass the Cookie header from a logged-in gog.com session via
  --cookie "a=1; b=2"        (inline, careful: lands in shell history)
  --cookie-file cookies.txt  (raw "a=1; b=2" line OR Netscape cookies.txt)
  GOG_COOKIE="a=1; b=2"      (environment variable - recommended)

Commands:
  check      verify the session cookie works and show account info
  list       dump your library (id, title, slug, platforms, release date)
  links      produce download links for every owned game
  download   actually download the files (resumable, organised folders)

Examples:
  python3 gog_library.py list --csv library.csv
  python3 gog_library.py links --types installer --os windows --out links.json --txt aria2.txt
  python3 gog_library.py links --game "witcher|cyberpunk" --resolve
  python3 gog_library.py download --outdir ./GOG --types installer --os windows --lang english
  python3 gog_library.py download --outdir ./GOG --game observer --dry-run
"""

from __future__ import annotations

import argparse
import csv
import http.cookiejar
import json
import os
import random
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict

# --------------------------------------------------------------------------- #
# constants
# --------------------------------------------------------------------------- #

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
EMBED = "https://embed.gog.com"
WEB = "https://www.gog.com"
LIBRARY_URL = EMBED + "/account/getFilteredProducts?mediaType=1&page={page}"
DETAILS_URL = EMBED + "/account/gameDetails/{game_id}.json"
GAMES_URL = WEB + "/user/data/games"

DEFAULT_TYPES = ("installer", "patch", "extras", "dlc", "galaxy")
DEFAULT_OS = ("windows", "mac", "linux")

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# cookie handling
# --------------------------------------------------------------------------- #

class Auth:
    """Cookie-aware HTTP client. Persists rotated session cookies across requests."""

    def __init__(self, cookie_header: str | None = None,
                 netscape_path: str | None = None,
                 timeout: int = 60):
        self.jar = http.cookiejar.CookieJar()
        self.timeout = timeout
        self._lock = threading.Lock()

        if cookie_header:
            self._load_header(cookie_header)
        if netscape_path:
            self._load_netscape(netscape_path)

        # opener with a redirect handler we control
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))
        # separate opener that never follows redirects and carries no cookie jar;
        # cookies are attached by hand so nothing leaks to the CDN host.
        self._raw_opener = urllib.request.build_opener(_NoRedirect)

    # -- loading ---------------------------------------------------------- #

    def _load_header(self, header: str) -> None:
        header = header.strip()
        if header.lower().startswith("cookie:"):
            header = header.split(":", 1)[1]
        count = 0
        for part in header.split(";"):
            part = part.strip()
            if not part or "=" not in part:
                continue
            name, value = part.split("=", 1)
            name, value = name.strip(), value.strip()
            if not name:
                continue
            self._set(name, value)
            count += 1
        if count == 0:
            raise SystemExit("No cookies found in the string you supplied.")

    def _load_netscape(self, path: str) -> None:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        # Auto-detect format
        ns_lines = [ln for ln in text.splitlines()
                    if ln and (ln.startswith("#HttpOnly_") or
                               (not ln.startswith("#") and ln.count("\t") >= 6))]
        if ns_lines:
            n = 0
            for line in ns_lines:
                line = line.replace("#HttpOnly_", "", 1)
                parts = line.split("\t")
                if len(parts) < 7:
                    continue
                domain, _flag, path_, secure, expires, name, value = parts[:7]
                self._set(name, value, domain=domain, path=path_,
                          secure=(secure.upper() == "TRUE"),
                          expires=int(expires) if expires.isdigit() else None)
                n += 1
            if n == 0:
                raise SystemExit(f"No cookies parsed from Netscape file {path}")
            return
        # else treat as a raw cookie header / single line
        self._load_header(text)

    def _set(self, name, value, domain=".gog.com", path="/", secure=True, expires=None):
        c = http.cookiejar.Cookie(
            version=0, name=name, value=value, port=None, port_specified=False,
            domain=domain, domain_specified=domain.startswith("."),
            domain_initial_dot=domain.startswith("."),
            path=path, path_specified=True, secure=secure, expires=expires,
            discard=False, comment=None, comment_url=None,
            rest={"HttpOnly": None}, rfc2109=False)
        self.jar.set_cookie(c)

    # -- export ----------------------------------------------------------- #

    def cookie_header(self) -> str:
        pairs = {}
        for c in self.jar:
            if "gog" in c.domain or c.domain in (".gog.com", "www.gog.com", "embed.gog.com"):
                pairs[c.name] = c.value
        return ";".join(f"{k}={v}" for k, v in pairs.items())

    def save_netscape(self, path: str) -> None:
        lines = ["# Netscape HTTP Cookie File", "# generated by gog_library.py", ""]
        for c in self.jar:
            if "gog" not in c.domain:
                continue
            dom = ("#HttpOnly_" if c.has_nonstandard_attr("HttpOnly") else "") + c.domain
            lines.append("\t".join([
                dom, "TRUE" if c.domain.startswith(".") else "FALSE", c.path,
                "TRUE" if c.secure else "FALSE",
                str(c.expires or 0), c.name, c.value,
            ]))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        os.chmod(path, 0o600)

    def save_header(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(self.cookie_header() + "\n")
        os.chmod(path, 0o600)

    # -- requests --------------------------------------------------------- #

    def _request(self, url: str, timeout: int | None = None,
                 headers: dict | None = None) -> tuple[int, dict, bytes]:
        """GET url, following redirects, returning (status, headers, body)."""
        req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                  "Accept": "application/json",
                                                  **(headers or {})})
        try:
            with self._opener.open(req, timeout=timeout or self.timeout) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers or {}), (e.read() or b"")

    def get_json(self, url: str, retries: int = 3, delay: float = 0.0):
        last = None
        for attempt in range(retries):
            if delay:
                time.sleep(delay)
            try:
                status, headers, body = self._request(url)
            except (urllib.error.URLError, socket.timeout, ConnectionError) as e:
                last = e
                time.sleep(1.5 * (attempt + 1))
                continue
            if status == 200:
                try:
                    return json.loads(body.decode("utf-8", "replace").lstrip("\ufeff"))
                except json.JSONDecodeError:
                    last = f"bad JSON from {url}"
                    time.sleep(1.0 * (attempt + 1))
                    continue
            if status in (429, 500, 502, 503, 504):
                last = f"HTTP {status} from {url}"
                time.sleep(2.0 * (attempt + 1) + random.random())
                continue
            if status in (401, 403):
                raise SystemExit(
                    f"HTTP {status} for {url}\n"
                    "Your session cookie is invalid or expired. Log in to gog.com again,\n"
                    "copy the fresh Cookie header and retry (see: gog_library.py check).")
            last = f"HTTP {status} from {url}"
            break
        raise RuntimeError(str(last))

    def resolve(self, url: str, method: str = "HEAD",
                want_size: bool = False) -> tuple[str, int] | None:
        """Ask GOG for the signed CDN URL behind a /downloads/... path.

        Returns (cdn_url, content_length) or None.
        Does NOT follow the redirect, so the CDN is never contacted here.
        """
        for attempt in range(3):
            req = urllib.request.Request(url, headers={"User-Agent": UA}, method=method)
            # attach cookies manually (the raw opener has no cookie processor)
            req.add_header("Cookie", self.cookie_header())
            try:
                resp = self._raw_opener.open(req, timeout=self.timeout)
                # No redirect means we already got the file itself; use final URL
                return resp.geturl(), int(resp.headers.get("Content-Length") or 0)
            except urllib.error.HTTPError as e:
                if e.code in (301, 302, 303, 307, 308):
                    loc = e.headers.get("Location")
                    if not loc:
                        return None
                    # Content-Length here belongs to GOG's redirect body, not the
                    # file. Only a HEAD against the CDN gives the real size.
                    length = self._cdn_size(loc) if want_size else 0
                    return loc, length
                if e.code in (429, 500, 502, 503, 504):
                    time.sleep(2 * (attempt + 1))
                    continue
                if e.code == 405 and method == "HEAD":  # HEAD unsupported -> try GET
                    return self.resolve(url, method="GET")
                if e.code in (401, 403):
                    log(f"  ! auth rejected while resolving {url} (cookie expired?)")
                    return None
                log(f"  ! HTTP {e.code} resolving {url}")
                return None
            except (urllib.error.URLError, socket.timeout):
                time.sleep(2 * (attempt + 1))
                continue
        return None

    def _cdn_size(self, cdn_url: str) -> int:
        req = urllib.request.Request(cdn_url, headers={"User-Agent": UA}, method="HEAD")
        try:
            with self._raw_opener.open(req, timeout=self.timeout) as r:
                return int(r.headers.get("Content-Length") or 0)
        except Exception:
            return 0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse to follow redirects so we can read the Location header ourselves."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # urllib then raises HTTPError with the 3xx code


# --------------------------------------------------------------------------- #
# data model
# --------------------------------------------------------------------------- #

@dataclass
class FileEntry:
    type: str                 # installer | patch | extras | dlc | galaxy
    os: str = ""
    language: str = ""
    name: str = ""
    version: str = ""
    size: str = ""
    path: str = ""            # /downloads/<slug>/<id>
    url: str = ""             # https://www.gog.com/downloads/... (auth required)
    cdn_url: str = ""         # signed CDN link (expires)
    bytes: int = 0

    @property
    def ext(self) -> str:
        return os.path.splitext(urllib.parse.urlparse(self.cdn_url or self.path).path)[1].lower()


@dataclass
class Game:
    id: int
    title: str
    slug: str = ""
    platforms: list[str] = field(default_factory=list)
    release_date: str = ""
    category: str = ""
    dlc_count: int = 0
    files: list[FileEntry] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# scraping
# --------------------------------------------------------------------------- #

SIZE_RE = re.compile(r"([\d.]+)\s*([KMGT]i?B)?", re.I)
MULT = {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12,
        "KIB": 1024, "MIB": 1024**2, "GIB": 1024**3, "TIB": 1024**4}


def parse_size(text: str) -> int:
    m = SIZE_RE.search(text or "")
    if not m:
        return 0
    try:
        val = float(m.group(1))
    except ValueError:
        return 0
    unit = (m.group(2) or "B").upper()
    return int(val * MULT.get(unit, 1))


def classify(manual_url: str, name: str) -> str:
    u = (manual_url or "").lower()
    n = (name or "").lower()
    if "patch" in u or "patch" in n:
        return "patch"
    if "installer" in u:
        return "installer"
    return "extras"


class GOG:
    def __init__(self, auth: Auth, cache_dir: str | None = "cache",
                 delay: float = 0.15, refresh: bool = False):
        self.auth = auth
        self.cache_dir = cache_dir
        self.delay = delay
        self.refresh = refresh
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)

    # -- library ---------------------------------------------------------- #

    def library(self) -> list[Game]:
        games: dict[int, Game] = {}
        page = 1
        total_pages = 1
        total = 0
        while page <= total_pages:
            data = self.auth.get_json(LIBRARY_URL.format(page=page), delay=self.delay)
            total_pages = int(data.get("totalPages") or 1)
            total = int(data.get("totalProducts") or 0)
            for p in data.get("products") or []:
                if p.get("isMovie"):
                    continue
                works = p.get("worksOn") or {}
                games[p["id"]] = Game(
                    id=int(p["id"]),
                    title=p.get("title") or "",
                    slug=p.get("slug") or "",
                    platforms=[k.lower() for k, v in works.items() if v],
                    release_date=(p.get("releaseDate") or {}).get("date", "")[:10],
                    category=p.get("category") or "",
                    dlc_count=int(p.get("dlcCount") or 0),
                )
            log(f"  library page {page}/{total_pages}  ({len(games)} games)")
            page += 1
        if total and len(games) != total:
            log(f"  note: API reported {total} products, collected {len(games)}")
        return sorted(games.values(), key=lambda g: g.title.lower())

    # -- per-game details ------------------------------------------------- #

    def _cache_path(self, game_id: int) -> str | None:
        if not self.cache_dir:
            return None
        return os.path.join(self.cache_dir, f"details_{game_id}.json")

    def _parse_detail(self, detail: dict, force_type: str | None = None,
                      prefix: str = "") -> list[FileEntry]:
        """Turn one gameDetails payload (base game or inline DLC object) into FileEntries."""
        files: list[FileEntry] = []

        def add(f: FileEntry) -> None:
            if force_type:
                f.type = force_type
                if prefix:
                    f.name = f"{prefix}: {f.name}" if f.name else prefix
            files.append(f)

        # installers / patches / language packs: [[language, {os: [file, ...]}], ...]
        downloads = detail.get("downloads")
        if isinstance(downloads, dict):
            downloads = [["", downloads]]
        for lang, platforms in downloads or []:
            if not isinstance(platforms, dict):
                continue
            for os_name, flist in platforms.items():
                for f in flist or []:
                    mu = f.get("manualUrl") or ""
                    if not mu:
                        continue
                    add(FileEntry(
                        type=classify(mu, f.get("name", "")),
                        os=os_name.lower(),
                        language=lang or "",
                        name=f.get("name") or "",
                        version=str(f.get("version") or ""),
                        size=f.get("size") or "",
                        bytes=parse_size(f.get("size") or ""),
                        path=mu, url=WEB + mu,
                    ))

        # extras: manuals, soundtracks, artbooks, avatars, ...
        for e in detail.get("extras") or []:
            mu = e.get("manualUrl") or ""
            if not mu:
                continue
            add(FileEntry(
                type="extras", name=e.get("name") or "extra",
                size=e.get("size") or "", bytes=parse_size(e.get("size") or ""),
                path=mu, url=WEB + mu,
            ))

        # GOG Galaxy builds
        for g in detail.get("galaxyDownloads") or []:
            path_ = g.get("path") or ""
            if not path_:
                continue
            add(FileEntry(type="galaxy", os=(g.get("os") or "").lower(),
                          name=g.get("name") or g.get("installer") or "galaxy installer",
                          size=g.get("size") or "", bytes=parse_size(g.get("size") or ""),
                          path=path_, url=WEB + path_))
        for g in detail.get("simpleGalaxyInstallers") or []:
            path_ = g.get("path") or ""
            if not path_ or any(x.path == path_ for x in files):
                continue
            add(FileEntry(type="galaxy", os=(g.get("os") or "").lower(),
                          name="Galaxy build", path=path_, url=WEB + path_))
        return files

    def details(self, game: Game, include_dlcs: bool = True) -> Game:
        cp = self._cache_path(game.id)
        data = None
        if cp and os.path.exists(cp) and not self.refresh:
            try:
                with open(cp, encoding="utf-8") as fh:
                    data = json.load(fh)
            except json.JSONDecodeError:
                data = None
        if data is None:
            data = self.auth.get_json(DETAILS_URL.format(game_id=game.id), delay=self.delay)
            if cp:
                tmp = cp + ".tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(data, fh)
                os.replace(tmp, cp)

        files = self._parse_detail(data)
        if not game.slug:
            game.slug = str(game.id)

        # DLCs: GOG embeds either full detail objects or bare product ids
        if include_dlcs:
            for d in data.get("dlcs") or []:
                if isinstance(d, dict):
                    dtitle = d.get("title") or d.get("name") or "DLC"
                    if d.get("downloads") or d.get("extras") or d.get("galaxyDownloads"):
                        files.extend(self._parse_detail(d, force_type="dlc",
                                                        prefix=dtitle))
                        continue
                    did = d.get("id") or d.get("productId")
                    if d.get("manualUrl"):
                        files.append(FileEntry(type="dlc", name=dtitle,
                                               path=d["manualUrl"],
                                               url=WEB + d["manualUrl"]))
                        continue
                elif isinstance(d, (str, int)) and str(d).isdigit():
                    did, dtitle = int(d), f"DLC {d}"
                else:
                    continue
                if not did or int(did) in self.library_so_far:
                    continue
                try:
                    sub = self.details(Game(id=int(did), title=dtitle), include_dlcs=False)
                except SystemExit:
                    raise
                except Exception as exc:  # noqa: BLE001
                    log(f"  ! could not fetch DLC {did}: {exc}")
                    continue
                for f in sub.files:
                    f.type = "dlc"
                    f.name = f"{dtitle}: {f.name}" if f.name else dtitle
                    files.append(f)

        # drop duplicates (same underlying file reached via two routes)
        seen: set = set()
        unique: list[FileEntry] = []
        for f in files:
            key = (f.path, f.os, f.language, f.type)
            if key in seen:
                continue
            seen.add(key)
            unique.append(f)

        game.files = unique
        return game

    # ids already in the library -> prevents DLC self-recursion; set by callers
    library_so_far: set = set()

    # -- link resolution -------------------------------------------------- #

    def resolve_game(self, game: Game) -> Game:
        todo = [f for f in game.files if not f.cdn_url]
        for f in todo:
            got = self.auth.resolve(f.url)
            if got:
                f.cdn_url = got[0]
                if got[1]:
                    f.bytes = got[1]
            else:
                time.sleep(0.5)
        return game


# --------------------------------------------------------------------------- #
# filtering / formatting helpers
# --------------------------------------------------------------------------- #

def sanitize(name: str, maxlen: int = 120) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    name = re.sub(r"\s+", " ", name)
    return (name[:maxlen] or "unnamed").strip()


def filter_files(files, types, oses, langs) -> list[FileEntry]:
    out = []
    for f in files:
        if types and f.type not in types:
            continue
        if f.os and oses and f.os not in oses:
            continue
        if f.language and langs and f.language.lower() not in langs:
            continue
        out.append(f)
    return out


def apply_filters(files, types, oses, langs, args) -> list[FileEntry]:
    out = filter_files(files, types, oses, langs)
    rx = getattr(args, "files", None)
    if rx:
        r = re.compile(rx, re.I)
        out = [f for f in out if r.search(f.name or "") or r.search(f.path or "")]
    cap = getattr(args, "max_size", None)
    if cap:
        limit = parse_size(cap)
        out = [f for f in out if not f.bytes or f.bytes <= limit]
    return out


def human_duration(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {sec}s"
    if m:
        return f"{m}m {sec}s"
    return f"{sec}s"


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1000 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000.0
    return f"{n} B"


# --------------------------------------------------------------------------- #
# downloader
# --------------------------------------------------------------------------- #

def download_file(auth: Auth, f: FileEntry, dest_dir: str, resume: bool = True,
                  retries: int = 3, quiet: bool = False) -> str:
    os.makedirs(dest_dir, exist_ok=True)

    # resolve immediately before transfer: signed links expire
    got = auth.resolve(f.url)
    if not got:
        raise RuntimeError(f"could not resolve a download URL for {f.name or f.path}")
    cdn_url = got[0]
    total = f.bytes  # estimate parsed from the API ("4 GB"); refined below

    fname = urllib.parse.unquote(os.path.basename(urllib.parse.urlparse(cdn_url).path)) or "file.bin"
    fname = sanitize(fname, 180)
    dest = os.path.join(dest_dir, fname)
    part = dest + ".part"

    if os.path.exists(dest) and total and os.path.getsize(dest) == total:
        if not quiet:
            log(f"    = exists, skipping  {fname} ({human(total)})")
        return dest

    have = os.path.getsize(part) if (resume and os.path.exists(part)) else 0
    if total and have > total:  # stale/corrupt partial
        os.remove(part)
        have = 0

    for attempt in range(1, retries + 1):
        headers = {"User-Agent": UA, "Accept": "*/*"}
        if have:
            headers["Range"] = f"bytes={have}-"
        req = urllib.request.Request(cdn_url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=auth.timeout) as resp:
                status = resp.status
                clen = int(resp.headers.get("Content-Length") or 0)
                if status == 206:
                    mode = "ab"
                    m = re.search(r"/(\d+)\s*$", resp.headers.get("Content-Range") or "")
                    if m:
                        total = int(m.group(1))
                    elif clen:
                        total = have + clen
                else:
                    mode = "wb"
                    have = 0
                    if clen:
                        total = clen
                f.cdn_url, f.bytes = cdn_url, total
                written = have
                t0 = time.time()
                with open(part, mode) as fh:
                    while True:
                        chunk = resp.read(1024 * 512)
                        if not chunk:
                            break
                        fh.write(chunk)
                        written += len(chunk)
                        if not quiet and total:
                            pct = written * 100 / total
                            speed = written / max(time.time() - t0, 0.001)
                            with _print_lock:
                                sys.stderr.write(
                                    f"\r    {pct:5.1f}%  {human(written)}/{human(total)}"
                                    f"  {human(int(speed))}/s   ")
                                sys.stderr.flush()
                if not quiet:
                    with _print_lock:
                        sys.stderr.write("\r" + " " * 60 + "\r")
                size = os.path.getsize(part)
                if total and size != total:
                    raise IOError(f"short read: {size}/{total} bytes")
                os.replace(part, dest)
                return dest
        except (urllib.error.URLError, socket.timeout, ConnectionError, IOError) as e:
            have = os.path.getsize(part) if os.path.exists(part) else 0
            if attempt == retries:
                raise
            log(f"    ! {e} - retry {attempt}/{retries - 1} (resuming at {human(have)})")
            time.sleep(2 * attempt)
            got = auth.resolve(f.url)
            if got:
                cdn_url, total = got[0], (got[1] or total)
    return dest


def plan_paths(game: Game, f: FileEntry, out_dir: str) -> str:
    sub = {"installer": "installers", "patch": "patches", "extras": "extras",
           "dlc": "dlc", "galaxy": "galaxy"}.get(f.type, f.type)
    bits = [out_dir, sanitize(game.title, 90), sub]
    if f.type in ("installer", "patch") and f.os:
        bits.append(f.os)
    if f.type in ("installer", "patch") and f.language:
        bits.append(sanitize(f.language, 40))
    return os.path.join(*bits)


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #

def build_auth(args) -> Auth:
    header = args.cookie or os.environ.get("GOG_COOKIE")
    path = args.cookie_file
    if not header and not path:
        env_file = os.environ.get("GOG_COOKIE_FILE")
        path = env_file
    if not header and not path:
        raise SystemExit(
            "No credentials.\n"
            "Provide a session cookie in one of these ways:\n"
            '  export GOG_COOKIE="gog-al=...; gog_us=...; ..."\n'
            "  python3 gog_library.py COMMAND --cookie-file cookies.txt\n"
            '  python3 gog_library.py COMMAND --cookie "gog-al=...; ..."\n'
            "Tip: in DevTools > Network, copy the Cookie request header from any\n"
            "request to www.gog.com or embed.gog.com while logged in.")
    return Auth(cookie_header=header, netscape_path=path)


def maybe_save_cookie(auth: Auth, args) -> None:
    target = getattr(args, "save_cookie", None)
    if not target:
        return
    if getattr(args, "save_cookie_netscape", False):
        auth.save_netscape(target)
    else:
        auth.save_header(target)
    log(f"  saved refreshed cookies -> {target}")


def cmd_check(args) -> int:
    auth = build_auth(args)
    gog = GOG(auth, cache_dir=None, delay=0)
    data = auth.get_json(LIBRARY_URL.format(page=1))
    total = data.get("totalProducts")
    page = (data.get("products") or [{}])[0]
    log("Cookie OK.")
    print(json.dumps({
        "status": "ok",
        "total_products": total,
        "total_pages": data.get("totalPages"),
        "sample_product": page.get("title"),
        "session_cookies_present": sorted(
            {c.name for c in auth.jar if "gog" in c.domain}),
    }, indent=2))
    maybe_save_cookie(auth, args)
    return 0


def select_games(games: list[Game], pattern: str | None) -> list[Game]:
    if not pattern:
        return games
    rx = re.compile(pattern, re.I)
    return [g for g in games if rx.search(g.title) or rx.search(g.slug)]


def cmd_list(args) -> int:
    auth = build_auth(args)
    gog = GOG(auth, cache_dir=args.cache_dir, delay=args.delay, refresh=args.refresh)
    games = select_games(gog.library(), args.game)
    rows = [{"id": g.id, "title": g.title, "slug": g.slug,
             "platforms": ",".join(g.platforms), "release_date": g.release_date,
             "category": g.category, "dlc_count": g.dlc_count} for g in games]

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) if rows else ["id"])
            w.writeheader()
            w.writerows(rows)
        log(f"  wrote {len(rows)} rows -> {args.csv}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, indent=2, ensure_ascii=False)
        log(f"  wrote {len(rows)} rows -> {args.json}")
    if not (args.csv or args.json) or args.print:
        w = max([len(r["title"]) for r in rows] + [5]) if rows else 5
        print(f"{'ID':>12}  {'TITLE':<{w}}  {'PLATFORMS':<22} RELEASED")
        for r in rows:
            print(f"{r['id']:>12}  {r['title'][:w]:<{w}}  {r['platforms']:<22} {r['release_date']}")
        log(f"  {len(rows)} games")
    maybe_save_cookie(auth, args)
    return 0


def _load_details(args, auth, games) -> list[Game]:
    gog = GOG(auth, cache_dir=args.cache_dir, delay=args.delay, refresh=args.refresh)
    GOG.library_so_far = {g.id for g in games}
    done = 0
    errors = 0
    out: dict[int, Game] = {}
    workers = max(1, args.jobs)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(gog.details, g, not args.no_dlc): g for g in games}
        for fut in as_completed(futs):
            g = futs[fut]
            done += 1
            try:
                out[g.id] = fut.result()
            except SystemExit:
                raise
            except Exception as exc:  # noqa: BLE001
                errors += 1
                log(f"  ! {g.title}: {exc}")
            if done % 25 == 0 or done == len(games):
                log(f"  details {done}/{len(games)}  (errors: {errors})")
    maybe_save_cookie(auth, args)
    return [out[g.id] for g in games if g.id in out]


def _to_dict(g: Game, resolved: bool) -> dict:
    return {
        "id": g.id, "title": g.title, "slug": g.slug,
        "platforms": g.platforms, "release_date": g.release_date,
        "files": [
            {k: v for k, v in asdict(f).items()
             if v not in ("", 0, None) or k in ("type", "url")}
            for f in g.files
        ],
    }


def cmd_links(args) -> int:
    auth = build_auth(args)
    gog = GOG(auth, cache_dir=args.cache_dir, delay=args.delay, refresh=args.refresh)
    games = select_games(gog.library(), args.game)
    log(f"  {len(games)} games selected")
    games = _load_details(args, auth, games)

    types = set(args.types)
    oses = set(args.os)
    langs = {l.lower() for l in args.lang}

    total_files = 0
    for g in games:
        g.files = apply_filters(g.files, types, oses, langs, args)
        total_files += len(g.files)

    if args.resolve:
        log(f"  resolving {total_files} signed CDN links (slow, ~1 req/file) ...")
        rworkers = max(1, args.jobs)
        with ThreadPoolExecutor(max_workers=rworkers) as pool:
            list(pool.map(gog.resolve_game, games))
        maybe_save_cookie(auth, args)

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "resolved": bool(args.resolve),
        "note": ("cdn_url is a signed link that expires (roughly a day). "
                 "url needs your session cookie."),
        "game_count": len(games),
        "file_count": total_files,
        "games": [_to_dict(g, args.resolve) for g in games if g.files],
    }

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
        log(f"  wrote JSON -> {args.out}")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["game_id", "title", "type", "os", "language", "name",
                        "version", "size", "url", "cdn_url"])
            for g in payload["games"]:
                for f in g["files"]:
                    w.writerow([g["id"], g["title"], f.get("type", ""), f.get("os", ""),
                                f.get("language", ""), f.get("name", ""),
                                f.get("version", ""), f.get("size", ""),
                                f.get("url", ""), f.get("cdn_url", "")])
        log(f"  wrote CSV -> {args.csv}")

    if args.txt:
        # aria2c -i friendly: URL then "  out=<path>"
        lines = []
        for g in payload["games"]:
            for f in g["files"]:
                u = f.get("cdn_url") or f.get("url")
                if not u:
                    continue
                sub = {"installer": "installers", "patch": "patches", "extras": "extras",
                       "dlc": "dlc", "galaxy": "galaxy"}.get(f.get("type"), "other")
                out = "/".join(x for x in [sanitize(g["title"], 90), sub,
                                          f.get("os", ""), sanitize(f.get("name", ""), 80)] if x)
                lines.append(f"{u}\n  out={out}")
        with open(args.txt, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        log(f"  wrote aria2 input file -> {args.txt}")
        if not args.resolve:
            log("  (that file uses cookie-protected URLs: run aria2c with "
                "--load-cookies=cookies.netscape.txt --save-cookie too. "
                "Use --resolve for direct CDN links that need no cookies.)")

    if args.print or not (args.out or args.csv or args.txt):
        for g in payload["games"]:
            print(f"\n{g['title']}  [{g['id']}]  ({', '.join(g['platforms'])})")
            for f in g["files"]:
                label = "/".join(x for x in [f.get("type"), f.get("os"),
                                             f.get("language")] if x)
                print(f"  {label:<34} {f.get('size', ''):>9}  {f.get('cdn_url') or f.get('url')}")
    log(f"  {total_files} files across {len(payload['games'])} games")
    return 0


def cmd_download(args) -> int:
    auth = build_auth(args)
    gog = GOG(auth, cache_dir=args.cache_dir, delay=args.delay, refresh=args.refresh)
    games = select_games(gog.library(), args.game)
    log(f"  {len(games)} games selected")
    games = _load_details(args, auth, games)

    types = set(args.types)
    oses = set(args.os)
    langs = {l.lower() for l in args.lang}

    queue: list[tuple[Game, FileEntry]] = []
    for g in games:
        for f in apply_filters(g.files, types, oses, langs, args):
            queue.append((g, f))

    planned_bytes = sum(f.bytes for _, f in queue)
    log(f"  {len(queue)} files, about {human(planned_bytes)} total")
    if args.dry_run:
        for g, f in queue:
            dest = plan_paths(g, f, args.outdir)
            print(f"{g.title} | {f.type}/{f.os or '-'}/{f.language or '-'} | "
                  f"{f.size or human(f.bytes)} | {f.name} -> {dest}")
        maybe_save_cookie(auth, args)
        return 0

    failures = []
    done = 0
    started = time.time()
    for g, f in queue:
        dest_dir = plan_paths(g, f, args.outdir)
        label = "/".join(x for x in [f.type, f.os, f.language] if x)
        log(f"  [{done + 1}/{len(queue)}] {g.title}  ({label})  {f.name}")
        try:
            download_file(auth, f, dest_dir, resume=not args.no_resume,
                          retries=args.retries, quiet=args.quiet)
            done += 1
        except Exception as exc:  # noqa: BLE001
            failures.append((g.title, f.name or f.path, str(exc)))
            log(f"    ! FAILED: {exc}")
        time.sleep(args.delay)

    log(f"  finished {done}/{len(queue)} files in {human_duration(time.time() - started)}")
    if failures:
        log(f"  {len(failures)} failures:")
        for t, n, e in failures:
            log(f"    - {t} :: {n} :: {e}")
    maybe_save_cookie(auth, args)
    return 1 if failures else 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="gog_library.py",
        description="List your GOG library and resolve/download owned game files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp):
        sp.add_argument("--cookie", help='Cookie header string: "a=1; b=2"')
        sp.add_argument("--cookie-file", help="raw cookie line or Netscape cookies.txt")
        sp.add_argument("--save-cookie", help="write refreshed cookies here "
                                             "(use .txt + --save-cookie-netscape for Netscape)")
        sp.add_argument("--save-cookie-netscape", action="store_true",
                        help="save refreshed cookies in Netscape format")
        sp.add_argument("--cache-dir", default="cache",
                        help="where to cache per-game API responses (default: cache; '' disables)")
        sp.add_argument("--refresh", action="store_true", help="ignore cached API responses")
        sp.add_argument("--delay", type=float, default=0.15,
                        help="seconds between API requests (default 0.15)")
        sp.add_argument("--jobs", type=int, default=4, help="parallel API requests (default 4)")
        sp.add_argument("--game", help="only games whose title/slug matches this regex")

    def filters(sp):
        sp.add_argument("--types", nargs="+", default=["installer"],
                        choices=["installer", "patch", "extras", "dlc", "galaxy"],
                        help="file types to include (default: installer)")
        sp.add_argument("--os", nargs="+", default=["windows"],
                        choices=["windows", "mac", "linux"],
                        help="platforms to include (default: windows)")
        sp.add_argument("--lang", nargs="+", default=[],
                        help='languages, e.g. --lang english (default: all)')
        sp.add_argument("--files", help="only files whose name/path matches this regex")
        sp.add_argument("--max-size", help='skip files bigger than this, e.g. "2GB"')

    sp = sub.add_parser("check", help="verify the cookie works")
    common(sp)
    sp.set_defaults(func=cmd_check)

    sp = sub.add_parser("list", help="list owned games")
    common(sp)
    sp.add_argument("--csv"); sp.add_argument("--json")
    sp.add_argument("--print", action="store_true", help="print to stdout too")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("links", help="produce download links")
    common(sp); filters(sp)
    sp.add_argument("--out", help="write JSON here")
    sp.add_argument("--csv", help="write CSV here")
    sp.add_argument("--txt", help="write aria2c input file here")
    sp.add_argument("--resolve", action="store_true",
                    help="resolve signed CDN URLs (slow; they expire in ~a day)")
    sp.add_argument("--no-dlc", action="store_true", help="skip DLC sub-products")
    sp.add_argument("--print", action="store_true", help="print to stdout too")
    sp.set_defaults(func=cmd_links)

    sp = sub.add_parser("download", help="download the files")
    common(sp); filters(sp)
    sp.add_argument("--outdir", default="GOG", help="destination root (default: ./GOG)")
    sp.add_argument("--no-dlc", action="store_true", help="skip DLC sub-products")
    sp.add_argument("--no-resume", action="store_true", help="start partial files over")
    sp.add_argument("--retries", type=int, default=3)
    sp.add_argument("--dry-run", action="store_true", help="show the plan, download nothing")
    sp.add_argument("--quiet", action="store_true", help="no progress bars")
    sp.set_defaults(func=cmd_download)

    args = p.parse_args(argv)
    if getattr(args, "cache_dir", None) == "":
        args.cache_dir = None
    try:
        return args.func(args)
    except KeyboardInterrupt:
        log("\ninterrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
