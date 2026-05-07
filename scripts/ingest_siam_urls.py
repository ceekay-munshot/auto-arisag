"""Ingest SIAM press-release URLs listed in scripts/siam_pending_urls.txt
and merge each parsed monthly release into data/siam_history.json.

Why this exists separately from backfill_siam_history.py:

  * backfill_siam_history.py walks the Wayback Machine CDX index. That
    coverage is patchy — many SIAM detail pages return 0 parseable rows.
  * extend_siam_history.py walks SIAM's listing page. SIAM's listing is
    JS-rendered, so the static HTML returns no detail URLs.
  * Sandbox networks (where Claude runs locally) can't reach siam.in
    at all (host on egress deny-list), so we can't even hand-walk URLs
    interactively.

This script accepts an explicit list of URLs the user (or Claude) has
already identified, fetches each from CI's runner (which has clean
egress to siam.in), runs them through the same parser
``dashboard.update_snapshot.parse_siam_release`` that ingests the
latest monthly release, and merges results into siam_history.json.

Workflow:
  1. Append URLs to scripts/siam_pending_urls.txt (one per line; blank
     and ``#``-prefixed lines ignored).
  2. Trigger the "Refresh dashboard data" workflow with
     ``target=siam_urls`` from the GitHub Actions UI.
  3. The runner runs this script, fetches each URL, parses, merges.
  4. The workflow's existing commit step auto-pushes the updated
     siam_history.json.

Idempotent — re-running with the same URLs re-parses but only writes
when the parsed record differs from what's already on disk.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import parse_siam_release  # noqa: E402


URLS_PATH = Path("scripts/siam_pending_urls.txt")
HISTORY_PATH = Path("data/siam_history.json")
SNAPSHOT_PATH = Path("data/source_snapshot.json")
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Referer": "https://www.siam.in/news-&-updates/press-releases",
}


def _read_urls() -> list[str]:
    if not URLS_PATH.exists():
        print(f"  no URLs file at {URLS_PATH}; nothing to ingest.", flush=True)
        return []
    out = []
    for raw in URLS_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


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
    return {m["month"]: m for m in months if m.get("month")}


def _save_history(by_month: dict[str, dict]) -> None:
    payload = {"months": [by_month[k] for k in sorted(by_month)]}
    HISTORY_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _merge_into_snapshot_if_recent(record: dict) -> None:
    """If the new record's month falls within the existing snapshot's
    monthly_series window (or extends it), upsert there too. Snapshot
    drives the live wholesale module path; siam_history is the merged
    deeper history. Keeping them in sync avoids 'old in snapshot, new
    in history' inconsistencies."""
    if not SNAPSHOT_PATH.exists():
        return
    snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    siam = snapshot.get("siam") or {}
    series = list(siam.get("monthly_series") or [])
    by_month = {row["month"]: row for row in series if row.get("month")}
    if record["month"] in by_month or (
        series and record["month"] >= series[0].get("month", "")
    ):
        by_month[record["month"]] = record
        siam["monthly_series"] = sorted(by_month.values(), key=lambda r: r["month"])
        if record["month"] > (siam.get("latest_month") or ""):
            siam["latest_month"] = record["month"]
            siam["latest_release_date"] = record.get("release_date") or ""
            siam["source_url"] = record.get("source_url") or ""
        snapshot["siam"] = siam
        SNAPSHOT_PATH.write_text(
            json.dumps(snapshot, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


def main() -> int:
    urls = _read_urls()
    if not urls:
        return 0
    history = _load_history()
    print(f"=== Ingesting {len(urls)} SIAM URLs ===", flush=True)
    added = 0
    updated = 0
    failed = 0
    parsed_records: list[dict] = []
    for url in urls:
        print(f"\n--- {url} ---", flush=True)
        try:
            response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
            response.raise_for_status()
            html = response.text
        except Exception as exc:
            print(f"  fetch failed: {exc}", flush=True)
            failed += 1
            continue
        try:
            record = parse_siam_release(html, url)
        except Exception as exc:
            print(f"  parse failed: {exc}", flush=True)
            failed += 1
            continue
        if not record or "month" not in record:
            print("  parse returned no record.", flush=True)
            failed += 1
            continue
        month_id = record["month"]
        existing = history.get(month_id)
        if existing == record:
            print(f"  {month_id}: already up to date.", flush=True)
            continue
        if existing:
            updated += 1
            print(f"  {month_id}: updated.", flush=True)
        else:
            added += 1
            print(f"  {month_id}: added.", flush=True)
        history[month_id] = record
        parsed_records.append(record)

    _save_history(history)
    for record in parsed_records:
        try:
            _merge_into_snapshot_if_recent(record)
        except Exception as exc:
            print(f"  snapshot merge skipped for {record.get('month')}: {exc}", flush=True)

    print(
        f"\nWrote {HISTORY_PATH} (added {added}, updated {updated}, failed {failed}). "
        f"Total months in history: {len(history)}",
        flush=True,
    )
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())
