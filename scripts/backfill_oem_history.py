"""Fetch historical FADA monthly PDFs and extract every category's OEM rows
into data/oem_history.json.

The dashboard's periodized OEM tables (one per category) need real MoM%,
3M growth, 12M CAGR. The latest FADA annexure only carries the latest
month plus the same month one year prior, so we walk back through
individual monthly PDFs to build a per-OEM monthly history per category.

Run via the `Refresh dashboard data` GitHub Actions workflow — local
sandbox networks cannot reach FADA. The script is idempotent: months
already in oem_history.json are skipped unless their source URL changed.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import requests

# Allow running from repo root with `python scripts/backfill_oem_history.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402  (sys.path tweak above)
    extract_pdf_pages,
    parse_fada_oem_annexure_tables,
    parse_fada_pdf_header,
)


HISTORY_PATH = Path("data/oem_history.json")
LEGACY_PV_HISTORY_PATH = Path("data/pv_oem_history.json")
SNAPSHOT_PATH = Path("data/source_snapshot.json")
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "application/pdf,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Referer": "https://fada.in/research.html",
}
HTML_HEADERS = {
    **HEADERS,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}
TRACKED_CATEGORIES = ("PV", "2W", "3W", "CV", "TRACTOR", "CE")
# Cap the discovery window so the workflow runs in a reasonable time. 120 months
# unlocks a full 10-year history. Older PDFs may use a different annexure layout
# and quietly fail to parse — that's fine, they're logged and skipped.
MAX_HISTORY_MONTHS = 120

# FADA listing pages — left empty by default because the legacy paths we
# tried (research.html, press-releases.html) all return 404. The latest
# monthly URL still lands in candidate_urls() via source_snapshot.json's
# fada.monthly_series, so this fallback is only useful if FADA publishes a
# real listing in future. Drop a path here when one is found.
FADA_INDEX_URLS: tuple[str, ...] = ()

# Wayback Machine's CDX index. The API only handles literal URL prefixes (no
# wildcards in the middle of the path), so we ask for every snapshot under
# fada.in/images/press-release/ and filter for "Vehicle Retail Data" in code.
# collapse=urlkey gives one row per unique URL; statuscode:200 + mimetype:pdf
# remove broken redirects and HTML error pages.
WAYBACK_CDX_URL = (
    "https://web.archive.org/cdx/search/cdx"
    "?url=fada.in/images/press-release/"
    "&matchType=prefix"
    "&output=json"
    "&limit=4000"
    "&filter=mimetype:application/pdf"
    "&filter=statuscode:200"
    "&collapse=urlkey"
)
WAYBACK_CDX_DOMAIN_URL = (
    "https://web.archive.org/cdx/search/cdx"
    "?url=fada.in"
    "&matchType=domain"
    "&output=json"
    "&limit=4000"
    "&filter=mimetype:application/pdf"
    "&filter=statuscode:200"
    "&filter=urlkey:.*Vehicle.*Retail.*Data.*"
    "&collapse=urlkey"
)

PDF_URL_RE = re.compile(
    r"""(?:https?://(?:www\.)?fada\.in)?/images/press-release/[^"'<>\s]+?Vehicle%20Retail%20Data\.pdf""",
    re.IGNORECASE,
)
MONTH_LOOKUP_FROM_NAME = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
}
MONTH_IN_URL_RE = re.compile(
    r"(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"(?:%20|\s)+(\d{4})",
    re.IGNORECASE,
)

# Older FADA PDFs that aren't in source_snapshot.json or the index page. Add
# pairs here for any month the script can't auto-discover.
ADDITIONAL_PDF_URLS: list[tuple[str, str]] = [
    # ("2024-03", "https://fada.in/images/press-release/...March%202024..."),
]


def fetch_html(url: str) -> str | None:
    try:
        response = requests.get(url, headers=HTML_HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        return response.text
    except Exception as exc:
        print(f"  index fetch failed for {url}: {exc}", flush=True)
        return None


def normalize_pdf_url(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("/"):
        return f"https://fada.in{url}"
    return url


def parse_month_from_url(url: str) -> str | None:
    decoded = url.replace("%20", " ")
    match = MONTH_IN_URL_RE.search(decoded)
    if not match:
        return None
    month_name = match.group(1).lower()
    year = int(match.group(2))
    month_number = MONTH_LOOKUP_FROM_NAME.get(month_name)
    if not month_number:
        return None
    return f"{year:04d}-{month_number:02d}"


def discover_via_fada_listing() -> dict[str, str]:
    """Fall-back path: scrape FADA's own listing page. Usually only the latest
    6-12 months."""
    discovered: dict[str, str] = {}
    for index_url in FADA_INDEX_URLS:
        html = fetch_html(index_url)
        if not html:
            continue
        for match in PDF_URL_RE.finditer(html):
            raw = match.group(0)
            url = normalize_pdf_url(raw)
            month_id = parse_month_from_url(url)
            if not month_id:
                continue
            discovered.setdefault(month_id, url)
        if discovered:
            print(f"  fada listing: {len(discovered)} PDFs via {index_url}", flush=True)
            return discovered
    print("  fada listing: no PDFs found", flush=True)
    return {}


def _wayback_query(query_url: str, label: str) -> dict[str, str]:
    discovered: dict[str, str] = {}
    try:
        response = requests.get(query_url, headers=HTML_HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        rows = response.json()
    except Exception as exc:
        print(f"  wayback ({label}) failed: {exc}", flush=True)
        return discovered
    if not isinstance(rows, list):
        print(f"  wayback ({label}) returned non-list payload", flush=True)
        return discovered
    if len(rows) < 2:
        print(f"  wayback ({label}) returned 0 rows", flush=True)
        return discovered
    columns = rows[0]
    try:
        original_idx = columns.index("original")
    except ValueError:
        original_idx = 2
    examined = 0
    for row in rows[1:]:
        try:
            original = row[original_idx]
        except (IndexError, TypeError):
            continue
        examined += 1
        if "vehicle" not in original.lower() or "retail" not in original.lower():
            continue
        url = normalize_pdf_url(original)
        month_id = parse_month_from_url(url)
        if not month_id:
            continue
        discovered.setdefault(month_id, url)
    print(
        f"  wayback ({label}): examined {examined} rows, found {len(discovered)} retail-data PDFs",
        flush=True,
    )
    return discovered


def discover_via_wayback() -> dict[str, str]:
    """Pull every monthly retail PDF Internet Archive has crawled for FADA.
    Tries a path-prefix query first, then falls back to a domain-wide query
    if that comes up dry. Always logs an outcome so future debugging is easy."""
    discovered: dict[str, str] = {}
    discovered.update(_wayback_query(WAYBACK_CDX_URL, "press-release prefix"))
    if not discovered:
        discovered.update(_wayback_query(WAYBACK_CDX_DOMAIN_URL, "domain match"))
    return discovered


def discover_fada_pdf_urls() -> list[tuple[str, str]]:
    """Combine Wayback (deep history) with FADA's own listing (current month)
    and return (month_id, url) pairs covering as much history as possible."""
    discovered: dict[str, str] = {}
    discovered.update(discover_via_wayback())
    # FADA listing usually only adds the latest month or two on top of what
    # Wayback already has, but let it overwrite Wayback urls — those come from
    # FADA directly so they're guaranteed to still resolve.
    for month_id, url in discover_via_fada_listing().items():
        discovered[month_id] = url
    return list(discovered.items())


def within_window(month_id: str, latest_month: str | None, max_months: int) -> bool:
    if not latest_month:
        return True
    try:
        cur = datetime.strptime(month_id, "%Y-%m")
        ref = datetime.strptime(latest_month, "%Y-%m")
    except ValueError:
        return True
    diff = (ref.year - cur.year) * 12 + (ref.month - cur.month)
    return -1 <= diff <= max_months


def host_variants(url: str) -> list[str]:
    """FADA hosts the same PDFs at fada.in and www.fada.in. Some hashes only
    serve from one of the two. Try whichever the URL specifies first, then the
    sibling host as a fallback."""
    parts = urlsplit(url)
    candidates = [url]
    if parts.netloc == "fada.in":
        alt = urlunsplit((parts.scheme, "www.fada.in", parts.path, parts.query, parts.fragment))
        candidates.append(alt)
    elif parts.netloc == "www.fada.in":
        alt = urlunsplit((parts.scheme, "fada.in", parts.path, parts.query, parts.fragment))
        candidates.append(alt)
    return candidates


def fetch_pdf(url: str) -> bytes:
    last_error: Exception | None = None
    for candidate in host_variants(url):
        try:
            response = requests.get(candidate, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
            response.raise_for_status()
            if not response.content.startswith(b"%PDF"):
                raise RuntimeError(f"response is not a PDF (first bytes: {response.content[:20]!r})")
            return response.content
        except Exception as exc:
            last_error = exc
            continue
    raise RuntimeError(f"all hosts failed for {url}: {last_error}")


def load_history() -> dict:
    if HISTORY_PATH.exists():
        try:
            payload = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("categories"), dict):
                return payload
        except json.JSONDecodeError:
            pass
    if LEGACY_PV_HISTORY_PATH.exists():
        try:
            legacy = json.loads(LEGACY_PV_HISTORY_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            legacy = {}
        months = legacy.get("months") if isinstance(legacy, dict) else None
        if isinstance(months, list):
            return {"categories": {"PV": {"months": months}}}
    return {"categories": {}}


def save_history(history: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(json.dumps(history, indent=2, ensure_ascii=False), encoding="utf-8")


def candidate_urls() -> list[tuple[str, str]]:
    snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    fada = snapshot.get("fada", {})
    latest_month = fada.get("latest_month") or fada.get("oem_latest_month")

    pairs: list[tuple[str, str]] = []
    for record in fada.get("monthly_series", []):
        url = record.get("source_url")
        month = record.get("month")
        if url and month:
            pairs.append((month, url))
    if fada.get("oem_source_url") and fada.get("oem_latest_month"):
        pairs.append((fada["oem_latest_month"], fada["oem_source_url"]))
    pairs.extend(ADDITIONAL_PDF_URLS)
    pairs.extend(discover_fada_pdf_urls())

    seen: dict[str, str] = {}
    for month, url in pairs:
        if not within_window(month, latest_month, MAX_HISTORY_MONTHS):
            continue
        if month not in seen:
            seen[month] = url
    return [(month, url) for month, url in seen.items()]


def main() -> int:
    if not SNAPSHOT_PATH.exists():
        print(f"missing {SNAPSHOT_PATH}", file=sys.stderr)
        return 1

    snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    fada_snapshot = snapshot.get("fada", {})

    history = load_history()
    categories: dict[str, dict] = dict(history.get("categories") or {})
    by_category: dict[str, dict[str, dict]] = {}
    for category in TRACKED_CATEGORIES:
        bucket = categories.get(category) or {"months": []}
        by_category[category] = {
            item["month"]: item for item in (bucket.get("months") or []) if item.get("month")
        }

    targets = candidate_urls()
    added = 0
    failed = 0
    skipped = 0

    for month_id, url in sorted(targets):
        # Skip the fetch only when every tracked category already has a record
        # for this month/url combo. Otherwise we re-fetch so any newly tracked
        # category can be filled in.
        already_complete = all(
            by_category[cat].get(month_id, {}).get("source_url") == url
            for cat in TRACKED_CATEGORIES
        )
        if already_complete:
            print(f"  {month_id}: all categories already in history, skipping")
            skipped += 1
            continue
        print(f"  {month_id}: fetching {url}", flush=True)
        try:
            pdf_bytes = fetch_pdf(url)
        except Exception as exc:
            print(f"  {month_id}: fetch failed ({exc})", file=sys.stderr, flush=True)
            failed += 1
            continue
        try:
            pages = extract_pdf_pages(pdf_bytes)
        except Exception as exc:
            print(f"  {month_id}: pdf parse failed ({exc})", file=sys.stderr, flush=True)
            failed += 1
            continue
        try:
            detected_month, release_date = parse_fada_pdf_header(pages[:3])
        except Exception:
            detected_month, release_date = month_id, ""
        try:
            tables = parse_fada_oem_annexure_tables(pages, fada_snapshot, detected_month, url)
        except Exception as exc:
            print(f"  {month_id}: oem parse failed ({exc})", file=sys.stderr, flush=True)
            failed += 1
            continue
        landed: list[str] = []
        for category in TRACKED_CATEGORIES:
            cat_rows = (tables.get(category) or {}).get("rows") or []
            if not cat_rows:
                continue
            by_category[category][detected_month] = {
                "month": detected_month,
                "release_date": release_date,
                "source_url": url,
                "rows": cat_rows,
            }
            landed.append(f"{category}:{len(cat_rows)}")
        if not landed:
            print(f"  {month_id}: no rows parsed in any tracked category", file=sys.stderr, flush=True)
            failed += 1
            continue
        added += 1
        print(f"  {month_id}: {' '.join(landed)} rows added", flush=True)

    out = {
        "categories": {
            category: {"months": [by_category[category][k] for k in sorted(by_category[category])]}
            for category in TRACKED_CATEGORIES
            if by_category[category]
        }
    }
    save_history(out)
    summary = ", ".join(
        f"{cat}={len(out['categories'].get(cat, {}).get('months') or [])}m"
        for cat in TRACKED_CATEGORIES
        if cat in out["categories"]
    )
    print(f"\nWrote {HISTORY_PATH} (added {added}, failed {failed}, skipped {skipped}). Counts: {summary}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
