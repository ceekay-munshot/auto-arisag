"""Walk RBI's Sectoral Deployment of Bank Credit press releases and append
each new monthly Vehicle Loans observation into ``data/rbi_credit.json``.

RBI publishes the SDBC release every month roughly 4–5 weeks after the
reference period. The release page is ``BS_PressReleaseDisplay.aspx`` and
each release carries a numeric ``Id``. We:

1. Hit the listing page (``BS_PressReleasesView.aspx``) and pick out detail
   URLs whose title mentions "Sectoral Deployment of Bank Credit".
2. For each detail URL not already in the history, fetch and parse the
   "Vehicle Loans" line out of the embedded HTML table.
3. Append/update ``data/rbi_credit.json`` and clear ``is_seed`` once we
   have a verified live row covering the reference month.

The script is idempotent: months already present (with the same source URL)
are skipped, and the seed month gets overwritten by the live release once
RBI publishes it.

Run via the GitHub Actions cron — sandbox networks cannot reach RBI.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urljoin

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402
    MONTH_LOOKUP,
    compact_text,
    parse_indian_number,
    to_month_id,
)


HISTORY_PATH = Path("data/rbi_credit.json")
LISTING_URL = "https://www.rbi.org.in/Scripts/BS_PressReleasesView.aspx"
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

# Listing page links to detail pages with this URL pattern.
DETAIL_HREF_RE = re.compile(
    r"BS_PressReleaseDisplay\.aspx\?prid=(\d+)",
    flags=re.IGNORECASE,
)

# RBI prefixes the SDBC release title consistently across years.
TITLE_PATTERNS = (
    re.compile(r"Sectoral Deployment of Bank Credit[^<]*?\b([A-Za-z]+)\s+(\d{4})", re.IGNORECASE),
    re.compile(r"Bank Credit[^<]*?Sectoral Deployment[^<]*?\b([A-Za-z]+)\s+(\d{4})", re.IGNORECASE),
)

# Within the table, the Vehicle Loans row carries the outstanding amount.
# RBI tables are HTML so we match the row by anchor text and pick the next
# numeric cell. The exact column we want is typically "Outstanding as on
# <last reporting Friday>".
VEHICLE_LOANS_ROW_RE = re.compile(
    r"Vehicle\s+Loans?\s*</[a-zA-Z]+>(?:\s|<[^>]+>)*?([\d,\.]+)\s*</[a-zA-Z]+>(?:\s|<[^>]+>)*?([\d,\.]+)",
    flags=re.IGNORECASE,
)
# YoY growth often appears in the same row a few cells later.
VEHICLE_YOY_RE = re.compile(
    r"Vehicle\s+Loans?(?:.*?)(?:Growth|Y[-\s]?o[-\s]?Y)[^%]*?([0-9]+\.\d+)\s*%",
    flags=re.IGNORECASE | re.DOTALL,
)


def _fetch_html(url: str) -> str | None:
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        return response.text
    except Exception as exc:
        print(f"  fetch failed {url}: {exc}", flush=True)
        return None


def _detail_urls(listing_html: str) -> list[str]:
    """Extract the unique SDBC detail URLs from the listing HTML."""
    out: list[str] = []
    seen: set[str] = set()
    for match in DETAIL_HREF_RE.finditer(listing_html):
        prid = match.group(1)
        url = f"https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid={prid}"
        if url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out


def _detect_month_from_html(html: str) -> str | None:
    text = compact_text(html)
    for pattern in TITLE_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        try:
            return to_month_id(match.group(1), int(match.group(2)))
        except ValueError:
            continue
    return None


def _parse_vehicle_loans(html: str) -> tuple[int | None, float | None]:
    """Return (outstanding_cr, yoy_pct) parsed from the SDBC HTML table.
    Both pieces are best-effort — RBI table layouts shift slightly between
    years, so callers must tolerate a None on either field."""
    outstanding = None
    yoy = None
    row_match = VEHICLE_LOANS_ROW_RE.search(html)
    if row_match:
        # The table typically has prior-month-end and current-month-end
        # outstanding side by side. We want the latter (later in the row).
        outstanding = parse_indian_number(row_match.group(2))
    yoy_match = VEHICLE_YOY_RE.search(html)
    if yoy_match:
        try:
            yoy = float(yoy_match.group(1))
        except ValueError:
            yoy = None
    return outstanding, yoy


def _load_history() -> dict:
    if HISTORY_PATH.exists():
        try:
            return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {
        "source_name": "RBI — Sectoral Deployment of Bank Credit",
        "source_url": LISTING_URL,
        "concept": "Outstanding scheduled commercial bank credit for Vehicle Loans.",
        "unit": "INR crore (outstanding)",
        "coverage_note": "",
        "is_seed": True,
        "series": [],
    }


def _save_history(payload: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    listing_html = _fetch_html(LISTING_URL)
    if not listing_html:
        print("RBI listing fetch failed; nothing to update.", file=sys.stderr)
        return 1

    detail_urls = _detail_urls(listing_html)
    if not detail_urls:
        print("RBI listing returned 0 detail URLs.", file=sys.stderr)
        return 1
    print(f"RBI listing: {len(detail_urls)} detail URLs", flush=True)

    history = _load_history()
    by_month: dict[str, dict] = {row["month"]: row for row in history.get("series", []) if row.get("month")}

    added = 0
    refreshed = 0
    skipped = 0
    parse_failed = 0

    for detail_url in detail_urls:
        html = _fetch_html(detail_url)
        if not html:
            continue
        text = compact_text(html)
        if "sectoral deployment" not in text.lower():
            skipped += 1
            continue
        month_id = _detect_month_from_html(html)
        if not month_id:
            parse_failed += 1
            print(f"  {detail_url}: no month detected", flush=True)
            continue
        outstanding, yoy = _parse_vehicle_loans(html)
        if outstanding is None:
            parse_failed += 1
            print(f"  {detail_url} ({month_id}): vehicle loans row not found", flush=True)
            continue
        record = {
            "month": month_id,
            "outstanding_cr": outstanding,
            "yoy_pct": yoy,
            "source_url": detail_url,
        }
        existing = by_month.get(month_id)
        if existing == record:
            continue
        if existing and existing.get("source_url", "").startswith("https://www.rbi.org.in"):
            refreshed += 1
        else:
            added += 1
        by_month[month_id] = record
        print(f"  {month_id}: {outstanding} cr ({yoy}% YoY)", flush=True)

    history["series"] = [by_month[k] for k in sorted(by_month)]
    history["source_url"] = LISTING_URL
    if added or refreshed:
        # We have at least one verified live row — drop the seed flag.
        history["is_seed"] = False
        history["coverage_note"] = (
            "Outstanding amount as of the last reporting Friday of each month, "
            "sourced from RBI Sectoral Deployment of Bank Credit press releases."
        )
    _save_history(history)

    print(
        f"\nWrote {HISTORY_PATH} (added {added}, refreshed {refreshed}, "
        f"skipped {skipped}, parse_failed {parse_failed}). "
        f"Total months: {len(history['series'])}",
        flush=True,
    )
    return 0 if (added + refreshed) > 0 or parse_failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
