"""Walk SIAM's press-release archive directly (skipping Wayback) to
build a deeper monthly history into ``data/siam_history.json``.

Why this exists
===============

The original ``backfill_siam_history.py`` used the Wayback Machine CDX
index to discover archived SIAM detail pages. That returned 0 parseable
releases consistently — Wayback's coverage of siam.in's ASP.NET URLs is
spotty. We retired that script from the cron in May 2026.

This replacement walks SIAM's own listing page at
``/news-&-updates/press-releases`` (and its paginated archive pages)
and extracts every ``press-releases-detail`` URL the listing exposes.
For each candidate page it then runs the existing
``dashboard.update_snapshot.parse_siam_release`` parser — the same one
that ingests the latest monthly release into the snapshot — so the
schema lines up perfectly with what the dashboard already consumes.

The script is idempotent: any month already in
``data/siam_history.json`` is skipped on subsequent runs. So re-runs
only fetch newly-discovered releases.

Run via the GitHub Actions cron (heavy 09:00 UTC tick). Sandbox
networks cannot reach siam.in, so this only does useful work on the
runner.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import urljoin

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402  (sys.path tweak above)
    SIAM_LATEST_URL,
    parse_siam_release,
)


HISTORY_PATH = Path("data/siam_history.json")
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Referer": "https://www.siam.in/",
}

# Detail-page hrefs on the listing look like:
#   press-releases-detail-newsdesc-NNNN-...aspx
# or with a query-string id parameter
#   press-releases-detail.aspx?id=NNNN
# Match both shapes.
DETAIL_RE = re.compile(
    r'href="([^"]*press-releases-detail[^"]*?(?:newsdesc-(\d+)|id=(\d+))[^"]*)"',
    re.IGNORECASE,
)

# SIAM paginates its archive with ?page=N. We bound the walk so a runaway
# scrape can't burn workflow time forever.
MAX_PAGES = 12


def _fetch_html(url: str) -> str | None:
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        return response.text
    except Exception as exc:
        print(f"  fetch failed {url}: {exc}", flush=True)
        return None


def _discover_detail_urls(listing_html: str, base_url: str) -> list[str]:
    """Return absolute detail URLs found on a listing page, deduped."""
    seen: set[str] = set()
    out: list[str] = []
    for match in DETAIL_RE.finditer(listing_html):
        relative = match.group(1)
        absolute = urljoin(base_url, relative)
        if absolute in seen:
            continue
        seen.add(absolute)
        out.append(absolute)
    return out


def _walk_listing() -> list[str]:
    """Walk the SIAM press-release listing across MAX_PAGES, returning
    every unique detail-page URL we can find."""
    discovered: list[str] = []
    seen: set[str] = set()
    for page in range(1, MAX_PAGES + 1):
        url = SIAM_LATEST_URL if page == 1 else f"{SIAM_LATEST_URL}?page={page}"
        html = _fetch_html(url)
        if not html:
            continue
        urls = _discover_detail_urls(html, url)
        if not urls:
            print(f"  page {page}: 0 detail URLs — stopping", flush=True)
            break
        added = 0
        for u in urls:
            if u in seen:
                continue
            seen.add(u)
            discovered.append(u)
            added += 1
        print(f"  page {page}: +{added} new detail URLs (total {len(discovered)})", flush=True)
        if added == 0:
            # Pagination wrapped or returned the same page — stop early.
            break
    return discovered


def _load_history() -> dict:
    if not HISTORY_PATH.exists():
        return {"months": []}
    try:
        return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"months": []}


def _save_history(payload: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def main() -> int:
    history = _load_history()
    by_month: dict[str, dict] = {row["month"]: row for row in history.get("months", []) if row.get("month")}

    detail_urls = _walk_listing()
    if not detail_urls:
        print("SIAM listing returned 0 detail URLs; nothing to update.", file=sys.stderr)
        return 1
    print(f"\nDiscovered {len(detail_urls)} candidate detail URLs.\n", flush=True)

    added = 0
    refreshed = 0
    skipped_known = 0
    parse_failed = 0

    for detail_url in detail_urls:
        html = _fetch_html(detail_url)
        if not html:
            continue
        try:
            release = parse_siam_release(html, detail_url)
        except (ValueError, KeyError) as exc:
            parse_failed += 1
            print(f"  parse miss: {detail_url} — {exc}", flush=True)
            continue
        month_id = release.get("month")
        if not month_id:
            parse_failed += 1
            continue
        record = {
            "month": month_id,
            "release_date": release["release_date"],
            "source_url": release["source_url"],
            "production_total": release["production_total"],
            "domestic_sales": release["domestic_sales"],
        }
        existing = by_month.get(month_id)
        if existing == record:
            skipped_known += 1
            continue
        if existing:
            refreshed += 1
        else:
            added += 1
        by_month[month_id] = record
        print(f"  {month_id}: parsed from {detail_url}", flush=True)

    history["months"] = [by_month[k] for k in sorted(by_month)]
    _save_history(history)

    print(
        f"\nWrote {HISTORY_PATH} (added {added}, refreshed {refreshed}, "
        f"skipped {skipped_known}, parse_failed {parse_failed}). "
        f"Total months: {len(history['months'])}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
