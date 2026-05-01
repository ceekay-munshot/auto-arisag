"""Walk SIAM's press-release archive (live + Wayback) to assemble a long
monthly history of PV / 2W / 3W domestic wholesale into data/siam_history.json.

The dashboard's wholesale module currently only sees what
``data/source_snapshot.json`` carries (six months by default). This script
keeps that snapshot untouched and writes a separate, deeper history file
that ``analyze.build_wholesale_module`` merges in at build time.

The script is idempotent: once a month is parsed and written it is skipped
unless its source URL changed.

Run via the GitHub Actions cron — sandbox networks cannot reach SIAM.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402  (sys.path tweak above)
    MONTH_LOOKUP,
    compact_text,
    parse_indian_number,
    parse_float_match,
    to_month_id,
)


HISTORY_PATH = Path("data/siam_history.json")
SNAPSHOT_PATH = Path("data/source_snapshot.json")
TIMEOUT = 30
MAX_HISTORY_MONTHS = 144  # 12 years
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Referer": "https://www.siam.in/news-&-updates/press-releases",
}

# Wayback CDX query for SIAM detail pages. The detail URLs look like
# ``/news-&-updates/press-releases-detail.aspx?id=NNNN`` or the URL-rewritten
# ``/news-&-updates/press-releases-detail-<slug>?id=NNNN``. Both shapes share
# the ``press-releases-detail`` token, so we use that as a literal prefix and
# filter status:200 + mimetype:text/html.
WAYBACK_CDX_URL = (
    "https://web.archive.org/cdx/search/cdx"
    "?url=siam.in/news-%26-updates/press-releases-detail"
    "&matchType=prefix"
    "&output=json"
    "&limit=8000"
    "&filter=mimetype:text/html"
    "&filter=statuscode:200"
    "&collapse=urlkey"
)
# Some Wayback rows index the canonical (non-www) host; some index www.siam.in.
WAYBACK_CDX_WWW_URL = WAYBACK_CDX_URL.replace("?url=siam.in", "?url=www.siam.in")

# When the live SIAM page returns a redirect or 404, we fall back to the
# Wayback Machine "if-available" snapshot.
WAYBACK_AVAILABLE_URL = "https://archive.org/wayback/available"


def _fetch_html(url: str) -> str | None:
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        if not response.text:
            return None
        return response.text
    except Exception as exc:
        print(f"  fetch failed for {url}: {exc}", flush=True)
        return None


def _wayback_archived_html(url: str) -> str | None:
    """Best-effort fallback: ask the Wayback Machine for the closest snapshot
    of ``url`` and return that page's HTML."""
    try:
        response = requests.get(
            WAYBACK_AVAILABLE_URL, params={"url": url}, headers=HEADERS, timeout=TIMEOUT
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        print(f"  wayback-available failed for {url}: {exc}", flush=True)
        return None
    snapshot = (
        payload.get("archived_snapshots", {})
        .get("closest", {})
        .get("url")
    )
    if not snapshot:
        return None
    return _fetch_html(snapshot)


def _discover_via_wayback(query_url: str, label: str) -> dict[str, str]:
    """Return ``{wayback_snapshot_url: original_url}`` for every detail-page
    snapshot the Wayback CDX index can find."""
    discovered: dict[str, str] = {}
    try:
        response = requests.get(query_url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        rows = response.json()
    except Exception as exc:
        print(f"  wayback ({label}) failed: {exc}", flush=True)
        return discovered
    if not isinstance(rows, list) or len(rows) < 2:
        print(f"  wayback ({label}) returned no rows", flush=True)
        return discovered
    columns = rows[0]
    try:
        timestamp_idx = columns.index("timestamp")
        original_idx = columns.index("original")
    except ValueError:
        timestamp_idx, original_idx = 1, 2
    for row in rows[1:]:
        try:
            timestamp = row[timestamp_idx]
            original = row[original_idx]
        except (IndexError, TypeError):
            continue
        snapshot_url = f"https://web.archive.org/web/{timestamp}id_/{original}"
        discovered.setdefault(snapshot_url, original)
    print(f"  wayback ({label}): {len(discovered)} snapshots", flush=True)
    return discovered


def _normalize_original_url(url: str) -> str:
    """Wayback indexes both http: and https: URLs, and varies on host. Reduce
    to a stable canonical form so we can dedupe."""
    parts = urlsplit(url)
    netloc = parts.netloc.lower().lstrip("www.")
    return urlunsplit(("https", netloc or "siam.in", parts.path, parts.query, ""))


_TITLE_PATTERNS = (
    # Modern format: "Auto Industry Performance of February-2026" / "of February 2026"
    re.compile(
        r"Auto Industry Performance of\s+([A-Za-z]+)[-\s]+(\d{4})",
        flags=re.IGNORECASE,
    ),
    # Q4 / FY bundles: "of Q4 (Jan- March 2026)" — month captured is the closing one
    re.compile(
        r"Auto Industry Performance of[^<]{0,80}?[(\-]\s*([A-Za-z]+)\s+(\d{4})",
        flags=re.IGNORECASE,
    ),
    # Legacy listing/detail format used through ~FY18: "Monthly Performance: February 2018"
    re.compile(
        r"Monthly Performance[:\s]+([A-Za-z]+)\s+(\d{4})",
        flags=re.IGNORECASE,
    ),
    # Fallback: pure body text "Domestic sales in February 2018"
    re.compile(
        r"Domestic sales in\s+([A-Za-z]+)\s+(\d{4})",
        flags=re.IGNORECASE,
    ),
)


def _detect_month(text: str) -> str | None:
    for pattern in _TITLE_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        month_name, year_text = match.groups()
        if month_name.lower() not in MONTH_LOOKUP:
            continue
        try:
            return to_month_id(month_name, int(year_text))
        except ValueError:
            continue
    return None


def _parse_release(html: str, source_url: str) -> dict | None:
    """Lenient SIAM parser. Returns None when the page is not a monthly
    performance release we can confidently parse."""
    text = compact_text(html)
    month_id = _detect_month(text)
    if not month_id:
        return None

    # Resolve the human-readable month name once so the lookups below are
    # case-insensitive but anchored to the actual month the page is talking
    # about.
    year, month_number = int(month_id[:4]), int(month_id[5:])
    month_name_lookup = next(
        (name for name, idx in MONTH_LOOKUP.items() if idx == month_number),
        None,
    )
    if not month_name_lookup:
        return None

    pv_match = re.search(
        rf"Passenger Vehicles?(?:[^.]*?)sales were\s+([\d,]+)\s+units in\s+{month_name_lookup}\s+{year}",
        text,
        flags=re.IGNORECASE,
    ) or re.search(
        rf"Passenger Vehicles?(?:[^.]*?)sold[^.]*?\b([\d,]+)\b[^.]*?{month_name_lookup}\s+{year}",
        text,
        flags=re.IGNORECASE,
    )
    two_w_match = re.search(
        rf"Two-wheelers?\s+sales were\s+([\d,]+)\s+units in\s+{month_name_lookup}\s+{year}",
        text,
        flags=re.IGNORECASE,
    ) or re.search(
        rf"Two-wheelers?(?:[^.]*?)sold[^.]*?\b([\d,]+)\b[^.]*?{month_name_lookup}\s+{year}",
        text,
        flags=re.IGNORECASE,
    )
    three_w_match = re.search(
        rf"Three-wheelers?\s+sales were\s+([\d,]+)\s+units in\s+{month_name_lookup}\s+{year}",
        text,
        flags=re.IGNORECASE,
    ) or re.search(
        rf"Three-wheelers?(?:[^.]*?)sold[^.]*?\b([\d,]+)\b[^.]*?{month_name_lookup}\s+{year}",
        text,
        flags=re.IGNORECASE,
    )

    if not pv_match or not two_w_match or not three_w_match:
        return None

    production_match = re.search(
        rf"Production[^<]*?in\s+{month_name_lookup}\s+{year}\s+was\s+([\d,]+)\s+units",
        text,
        flags=re.IGNORECASE,
    )

    date_match = re.search(
        r"(\d{1,2}[/-]\d{1,2}[/-]\d{4})", text
    )
    release_date = ""
    if date_match:
        raw = date_match.group(1).replace("-", "/")
        for fmt in ("%d/%m/%Y", "%m/%d/%Y"):
            try:
                release_date = datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
                break
            except ValueError:
                continue

    pv_yoy = parse_float_match(rf"Passenger Vehicles?[^<]*?growth of ([0-9.]+)%", text)
    two_w_yoy = parse_float_match(rf"Two-wheelers?[^<]*?(?:grew|growth of|growth) by ([0-9.]+)%", text)
    three_w_yoy = parse_float_match(rf"Three-wheelers?[^<]*?(?:growth of|grew by|grew) ([0-9.]+)%", text)

    return {
        "month": month_id,
        "release_date": release_date,
        "source_url": source_url,
        "production_total": parse_indian_number(production_match.group(1)) if production_match else 0,
        "domestic_sales": {
            "PV": {"units": parse_indian_number(pv_match.group(1)), "yoy_pct": pv_yoy},
            "2W": {"units": parse_indian_number(two_w_match.group(1)), "yoy_pct": two_w_yoy},
            "3W": {"units": parse_indian_number(three_w_match.group(1)), "yoy_pct": three_w_yoy},
        },
    }


def _within_window(month_id: str, latest_month: str | None) -> bool:
    if not latest_month:
        return True
    try:
        cur = datetime.strptime(month_id, "%Y-%m")
        ref = datetime.strptime(latest_month, "%Y-%m")
    except ValueError:
        return True
    diff = (ref.year - cur.year) * 12 + (ref.month - cur.month)
    return -1 <= diff <= MAX_HISTORY_MONTHS


def _load_history() -> dict[str, dict]:
    if not HISTORY_PATH.exists():
        return {}
    try:
        payload = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    months = payload.get("months") if isinstance(payload, dict) else None
    if not isinstance(months, list):
        return {}
    return {item["month"]: item for item in months if item.get("month")}


def _save_history(by_month: dict[str, dict]) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"months": [by_month[k] for k in sorted(by_month)]}
    HISTORY_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _seed_from_snapshot(snapshot: dict) -> dict[str, dict]:
    series = snapshot.get("siam", {}).get("monthly_series") or []
    return {
        item["month"]: {
            "month": item["month"],
            "release_date": item.get("release_date", ""),
            "source_url": item.get("source_url", ""),
            "production_total": item.get("production_total", 0),
            "domestic_sales": item.get("domestic_sales", {}),
        }
        for item in series
        if item.get("month")
    }


def main() -> int:
    if not SNAPSHOT_PATH.exists():
        print(f"missing {SNAPSHOT_PATH}", file=sys.stderr)
        return 1

    snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    latest_month = snapshot.get("siam", {}).get("latest_month")

    history = _load_history()
    seeded = _seed_from_snapshot(snapshot)
    # Snapshot wins for months it has — those are the curated, validated rows.
    for month_id, record in seeded.items():
        history[month_id] = record

    discovered = _discover_via_wayback(WAYBACK_CDX_URL, "press-release prefix")
    if not discovered:
        discovered = _discover_via_wayback(WAYBACK_CDX_WWW_URL, "www press-release prefix")

    seen_canonical: set[str] = set()
    added = 0
    skipped = 0
    failed = 0

    for snapshot_url, original_url in discovered.items():
        canonical = _normalize_original_url(original_url)
        if canonical in seen_canonical:
            continue
        seen_canonical.add(canonical)

        # Fetch the archived copy directly — this is the most reliable path
        # because the live SIAM URL may have rotated or 404'd.
        html = _fetch_html(snapshot_url)
        if html is None:
            html = _wayback_archived_html(canonical)
        if html is None:
            failed += 1
            continue

        record = _parse_release(html, canonical)
        if not record:
            skipped += 1
            continue

        month_id = record["month"]
        if not _within_window(month_id, latest_month):
            continue

        existing = history.get(month_id)
        if existing and existing.get("source_url") and existing.get("domestic_sales"):
            # Already validated (likely from snapshot). Don't overwrite curated data.
            continue
        history[month_id] = record
        added += 1
        print(f"  {month_id}: parsed from {canonical}", flush=True)

    _save_history(history)
    print(
        f"\nWrote {HISTORY_PATH} (added {added}, skipped {skipped}, failed {failed}).\n"
        f"Total months in history: {len(history)}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
