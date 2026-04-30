"""Fetch historical FADA monthly PDFs and extract PV OEM rows into
data/pv_oem_history.json.

The dashboard's PV OEM table needs MoM%, 3M growth, 12M growth, 12M CAGR
and 24M CAGR. The latest FADA annexure only carries the latest month plus
the same month one year prior, so we have to walk back through individual
monthly PDFs to build a per-OEM monthly history.

Run via the `Backfill PV OEM history` GitHub Actions workflow
(workflow_dispatch) — local sandbox networks cannot reach FADA. The
script is idempotent: months already in pv_oem_history.json are skipped
unless their source URL changed.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Allow running from repo root with `python scripts/backfill_pv_oem_history.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402  (sys.path tweak above)
    extract_pdf_pages,
    parse_fada_oem_annexure_tables,
    parse_fada_pdf_header,
)


HISTORY_PATH = Path("data/pv_oem_history.json")
SNAPSHOT_PATH = Path("data/source_snapshot.json")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
)
TIMEOUT = 30

# Older FADA PDFs that aren't in source_snapshot.json. Add new pairs here when
# you need to extend the backfill window — for example, Mar 2024 unlocks the
# 24M CAGR column. URL pattern is fada.in/images/press-release/<hash>FADA...
ADDITIONAL_PDF_URLS: list[tuple[str, str]] = [
    # ("2024-03", "https://fada.in/images/press-release/...March%202024..."),
]


def fetch_pdf(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read()


def load_history() -> dict:
    if HISTORY_PATH.exists():
        try:
            return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"months": []}


def save_history(history: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(json.dumps(history, indent=2, ensure_ascii=False), encoding="utf-8")


def candidate_urls() -> list[tuple[str, str]]:
    snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    fada = snapshot.get("fada", {})
    pairs: list[tuple[str, str]] = []
    for record in fada.get("monthly_series", []):
        url = record.get("source_url")
        month = record.get("month")
        if url and month:
            pairs.append((month, url))
    if fada.get("oem_source_url") and fada.get("oem_latest_month"):
        pairs.append((fada["oem_latest_month"], fada["oem_source_url"]))
    pairs.extend(ADDITIONAL_PDF_URLS)
    seen: dict[str, str] = {}
    for month, url in pairs:
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
    existing_by_month = {item["month"]: item for item in history.get("months", []) if item.get("month")}

    targets = candidate_urls()
    added = 0
    failed = 0

    for month_id, url in sorted(targets):
        existing = existing_by_month.get(month_id)
        if existing and existing.get("source_url") == url:
            print(f"  {month_id}: already in history, skipping")
            continue
        print(f"  {month_id}: fetching")
        try:
            pdf_bytes = fetch_pdf(url)
        except urllib.error.URLError as exc:
            print(f"  {month_id}: fetch failed ({exc})", file=sys.stderr)
            failed += 1
            continue
        try:
            pages = extract_pdf_pages(pdf_bytes)
        except Exception as exc:
            print(f"  {month_id}: pdf parse failed ({exc})", file=sys.stderr)
            failed += 1
            continue
        try:
            detected_month, release_date = parse_fada_pdf_header(pages[:3])
        except Exception:
            detected_month, release_date = month_id, ""
        try:
            tables = parse_fada_oem_annexure_tables(pages, fada_snapshot, detected_month, url)
        except Exception as exc:
            print(f"  {month_id}: oem parse failed ({exc})", file=sys.stderr)
            failed += 1
            continue
        pv_rows = (tables.get("PV") or {}).get("rows") or []
        if not pv_rows:
            print(f"  {month_id}: no PV rows parsed", file=sys.stderr)
            failed += 1
            continue
        existing_by_month[detected_month] = {
            "month": detected_month,
            "release_date": release_date,
            "source_url": url,
            "rows": pv_rows,
        }
        added += 1

    out = {
        "months": [existing_by_month[k] for k in sorted(existing_by_month)],
    }
    save_history(out)
    print(
        f"\nWrote {HISTORY_PATH} with {len(out['months'])} months (added {added}, failed {failed}, "
        f"skipped {len(targets) - added - failed})"
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
