"""Fetch historical FADA monthly PDFs and extract fuel-mix + urban/rural
splits per category into data/fada_history.json.

The latest FADA snapshot in source_snapshot.json only carries the most
recent month's fuel mix and a single-month urban/rural split. The
dashboard's EV-penetration chart and the urban/rural panel both want a
multi-month history, so we walk back through every retail PDF the
discovery layer can reach (FADA listing + Wayback Machine) and persist
both series.

Run via the `Refresh dashboard data` GitHub Actions workflow — local
sandbox networks can't reach FADA. Idempotent: months already in
fada_history.json with the same source URL are skipped.

Output schema (data/fada_history.json):
{
  "monthly_fuel_mix": {
    "2025-10": {
      "PV":       {"Petrol / Ethanol": 51.2, "Diesel": 41.0, "EV": 3.24, ...},
      "2W":       { ... },
      ...
    },
    ...
  },
  "urban_rural_growth_series": [
    {"month": "2025-10", "category": "PV",
     "urban_mom_pct": 8.7, "urban_yoy_pct": 11.3,
     "rural_mom_pct": 9.1, "rural_yoy_pct": 13.0},
    ...
  ],
  "sources": { "2025-10": "https://fada.in/images/press-release/...pdf", ... }
}
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow running from repo root with `python scripts/backfill_fada_history.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402  (sys.path tweak above)
    build_fada_latest_subsegments,
    compact_pdf_pages,
    extract_pdf_pages,
    parse_fada_monthly_fuel_mix,
    parse_fada_pdf_header,
    parse_fada_urban_rural_growth,
)

# Reuse the exact discovery + fetch primitives from the OEM backfill so we
# inherit Wayback CDX + listing-page logic and don't fork URL handling.
from scripts.backfill_oem_history import (  # noqa: E402
    candidate_urls,
    fetch_pdf,
    SNAPSHOT_PATH,
)


HISTORY_PATH = Path("data/fada_history.json")


def load_history() -> dict:
    if HISTORY_PATH.exists():
        try:
            payload = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                payload.setdefault("monthly_fuel_mix", {})
                payload.setdefault("urban_rural_growth_series", [])
                payload.setdefault("subsegment_series", {"CV": [], "3W": []})
                payload.setdefault("sources", {})
                return payload
        except json.JSONDecodeError:
            pass
    return {
        "monthly_fuel_mix": {},
        "urban_rural_growth_series": [],
        "subsegment_series": {"CV": [], "3W": []},
        "sources": {},
    }


def save_history(history: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(
        json.dumps(history, indent=2, ensure_ascii=False, sort_keys=False),
        encoding="utf-8",
    )


def upsert_urban_rural(
    series: list[dict],
    month_id: str,
    rows: list[dict],
) -> list[dict]:
    """Replace any existing rows for `month_id` with `rows` (each row already
    carries a `category` key from the parser); append new rows otherwise."""
    kept = [item for item in series if item.get("month") != month_id]
    for row in rows:
        if not row.get("category"):
            continue
        kept.append({"month": month_id, **{k: v for k, v in row.items() if k != "month"}})
    return sorted(kept, key=lambda item: (item.get("month") or "", item.get("category") or ""))


def upsert_subsegment_series(
    series: list[dict],
    month_id: str,
    rows: list[dict],
) -> list[dict]:
    """Replace any subsegment rows for `month_id` with `rows`. Each row already
    carries a `label` key (e.g. "LCV" / "MCV" / "HCV") from the parser. The
    subsegment series is per-category (CV or 3W); the caller picks which list
    to upsert into."""
    kept = [item for item in series if item.get("month") != month_id]
    for row in rows:
        if not row.get("label"):
            continue
        kept.append({"month": month_id, **{k: v for k, v in row.items() if k != "month"}})
    return sorted(kept, key=lambda item: (item.get("month") or "", item.get("label") or ""))


def main() -> int:
    if not SNAPSHOT_PATH.exists():
        print(f"missing {SNAPSHOT_PATH}", file=sys.stderr)
        return 1

    history = load_history()
    targets = candidate_urls()
    if not targets:
        print("no FADA PDF URLs discovered (Wayback + listing both empty)")
        return 0

    added = 0
    failed = 0
    skipped = 0

    for month_id, url in sorted(targets):
        # Skip the fetch when fuel-mix, urban-rural, AND subsegments are all
        # cached at the same source URL. Otherwise re-fetch so any newly added
        # parser surfaces a previously-missing layer.
        already_fuel = month_id in history["monthly_fuel_mix"]
        already_urban = any(
            row.get("month") == month_id for row in history["urban_rural_growth_series"]
        )
        already_subseg = any(
            row.get("month") == month_id
            for cat_rows in (history.get("subsegment_series") or {}).values()
            for row in cat_rows
        )
        same_source = history["sources"].get(month_id) == url
        if already_fuel and already_urban and already_subseg and same_source:
            print(f"  {month_id}: already cached, skipping")
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
            detected_month, _release_date = parse_fada_pdf_header(pages[:3])
        except Exception:
            detected_month = month_id

        # The fuel-mix and urban-rural sections aren't always on the same
        # absolute page indices (older PDFs are shorter). Sweep a wider page
        # range than the live-refresh path and rely on the parsers' own text
        # markers to find the right table.
        wide_pages = compact_pdf_pages(pages)

        landed = []
        try:
            fuel_mix = parse_fada_monthly_fuel_mix(wide_pages, detected_month)
            if fuel_mix:
                history["monthly_fuel_mix"][detected_month] = fuel_mix
                landed.append(f"fuel_mix({len(fuel_mix)})")
        except Exception as exc:
            print(f"  {month_id}: fuel_mix parse failed ({exc})", file=sys.stderr, flush=True)

        try:
            urban_rural_rows = parse_fada_urban_rural_growth(wide_pages)
            if urban_rural_rows:
                history["urban_rural_growth_series"] = upsert_urban_rural(
                    history["urban_rural_growth_series"],
                    detected_month,
                    urban_rural_rows,
                )
                landed.append(f"urban_rural({len(urban_rural_rows)})")
        except Exception as exc:
            print(f"  {month_id}: urban_rural parse failed ({exc})", file=sys.stderr, flush=True)

        try:
            subsegments = build_fada_latest_subsegments(wide_pages) or {}
            for cat in ("CV", "3W"):
                cat_rows = subsegments.get(cat) or []
                if not cat_rows:
                    continue
                bucket = history["subsegment_series"].setdefault(cat, [])
                history["subsegment_series"][cat] = upsert_subsegment_series(
                    bucket, detected_month, cat_rows,
                )
                landed.append(f"{cat}_subsegments({len(cat_rows)})")
        except Exception as exc:
            print(f"  {month_id}: subsegment parse failed ({exc})", file=sys.stderr, flush=True)

        if not landed:
            print(f"  {month_id}: nothing parsed", file=sys.stderr, flush=True)
            failed += 1
            continue

        history["sources"][detected_month] = url
        added += 1
        print(f"  {month_id}: {' '.join(landed)} added", flush=True)

    save_history(history)
    fuel_count = len(history["monthly_fuel_mix"])
    urban_months = len({row.get("month") for row in history["urban_rural_growth_series"]})
    subseg_counts = {
        cat: len({row.get("month") for row in (history.get("subsegment_series") or {}).get(cat, [])})
        for cat in ("CV", "3W")
    }
    print(
        f"\nWrote {HISTORY_PATH} "
        f"(added {added}, failed {failed}, skipped {skipped}). "
        f"Coverage: {fuel_count} fuel-mix months, {urban_months} urban-rural months, "
        f"CV subseg {subseg_counts['CV']}m, 3W subseg {subseg_counts['3W']}m."
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
