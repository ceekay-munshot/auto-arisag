"""Scrape the latest monthly EV OEM leaderboard for each segment and
update data/ev_oem_tracker.json.

Sources (one per segment):
  * E2W   — Autocar Professional analysis-sales index
  * E4W   — RushLane electric-car-sales news feed
  * E3W-G — EVReporter monthly OEM-mix posts
  * EBUS  — Sustainable Bus / Business Today FY-tally pieces

The frontend's renderEvOemTracker reads the resulting JSON. If a source
fails to parse for any reason, we leave that segment's previous rows
intact — the dashboard never renders empty. Run via the `Refresh
dashboard data` GitHub Actions workflow; local sandbox networks usually
can't reach these news sites.

Schema (data/ev_oem_tracker.json):
{
  "schema_version": 1,
  "as_of_date": "YYYY-MM-DD",
  "source_note": "...",
  "datasets": [
    {
      "id": "E2W" | "E4W" | "E3WG" | "EBUS",
      "label": "EV 2W" | ...,
      "latest_month": "Mar 2026",
      "total_units": 190941,
      "compare_label": "Mar 2025 units",
      "growth_label": "YoY growth",
      "source_name": "Autocar Professional",
      "source_url": "...",
      "note": "...",
      "rows": [
        { "oem": "TVS Motor", "units": 49304, "prior_units": 30815 },
        ...
      ]
    },
    ...
  ]
}
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests


HISTORY_PATH = Path("data/ev_oem_tracker.json")
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

# Each segment is configured with a discovery URL (a category / search
# index page) and a regex that picks the latest article URL out of that
# index. The article fetch then runs a category-specific row parser.
# Layouts evolve over time; if a parser misses, we keep the previous
# data intact so the dashboard never goes blank.
SEGMENT_CONFIG = [
    {
        "id": "E2W",
        "label": "EV 2W",
        "compare_kind": "yoy",
        "growth_label": "YoY growth",
        "source_name": "Autocar Professional",
        "discovery_url": "https://www.autocarpro.in/analysis-sales",
        # Autocar Professional's analysis-sales pieces include the headline
        # "...power record E-2W sales in <Month> <Y> NNN units" or similar.
        # We pick the most recent E-2W headline URL.
        "article_re": re.compile(
            r'href="(/analysis-sales/[^"]*?(?:e-2w|electric-two|e2w|two-wheeler)[^"]*?-units?-\d+)"',
            re.IGNORECASE,
        ),
        "host": "https://www.autocarpro.in",
    },
    {
        "id": "E4W",
        "label": "EV 4W",
        "compare_kind": "yoy",
        "growth_label": "YoY growth",
        "source_name": "RushLane",
        "discovery_url": "https://www.rushlane.com/category/news/electric-vehicle-news",
        "article_re": re.compile(
            r'href="(https?://(?:www\.)?rushlane\.com/[^"]*electric-car-sales[^"]*-\d+\.html)"',
            re.IGNORECASE,
        ),
        "host": "https://www.rushlane.com",
    },
    {
        "id": "E3WG",
        "label": "E-3W Goods",
        "compare_kind": "mom",
        "growth_label": "MoM growth",
        "source_name": "EVReporter",
        "discovery_url": "https://evreporter.com/category/india-ev-sales/",
        "article_re": re.compile(
            r'href="(https?://(?:www\.)?evreporter\.com/[^"]*india-ice-vs-ev-sales[^"]*?/?)"',
            re.IGNORECASE,
        ),
        "host": "https://evreporter.com",
    },
    {
        "id": "EBUS",
        "label": "E-Bus",
        "compare_kind": "mom",
        "growth_label": "MoM growth",
        "source_name": "Sustainable Bus / Business Today FY tally",
        "discovery_url": "https://www.businesstoday.in/topic/electric-bus",
        "article_re": re.compile(
            r'href="(https?://(?:www\.)?businesstoday\.in/[^"]*e-bus[^"]*?\d{6}-\d{4}-\d{2}-\d{2})"',
            re.IGNORECASE,
        ),
        "host": "https://www.businesstoday.in",
    },
]

# Per-segment OEM allow-list. Articles often have inline mentions of
# competitor brands ("Tata Motors continues to lead, while Mahindra...");
# the row extractor only commits a row when an allow-listed OEM appears
# next to a number. Order is preserved so the leaderboard doesn't get
# shuffled by the regex order.
OEM_ALLOWLIST = {
    "E2W": [
        "TVS Motor", "Bajaj Auto", "Ather Energy", "Hero Vida",
        "Ola Electric", "Greaves Ampere", "Ampere", "Vida",
    ],
    "E4W": [
        "Tata Motors", "Mahindra & Mahindra", "Mahindra Electric",
        "JSW MG Motor", "MG Motor", "Maruti Suzuki", "VinFast",
        "Hyundai", "Kia", "BMW", "BYD", "Mercedes-Benz", "Volvo",
    ],
    "E3WG": [
        "Mahindra Last Mile Mobility", "Mahindra Electric Automobile",
        "Bajaj Auto", "Omega Seiki", "Atul Auto", "Euler Motors",
        "Green Evolve", "Piaggio Vehicles",
    ],
    "EBUS": [
        "JBM Electric", "JBM Auto", "Switch Mobility", "PMI Electro Mobility",
        "Olectra Greentech", "Tata Motors", "Ashok Leyland",
        "Eicher Motors", "VECV",
    ],
}


def fetch(url: str) -> str | None:
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        return response.text
    except Exception as exc:
        print(f"  fetch failed for {url}: {exc}", flush=True)
        return None


def discover_latest_article(config: dict) -> str | None:
    html = fetch(config["discovery_url"])
    if not html:
        return None
    match = config["article_re"].search(html)
    if not match:
        print(f"  {config['id']}: no article URL matched on {config['discovery_url']}", flush=True)
        return None
    raw = match.group(1)
    if raw.startswith("http"):
        return raw
    return f"{config['host']}{raw}"


def extract_rows(html: str, segment_id: str) -> list[dict]:
    """Walk the article HTML and pull (OEM, units) pairs by scanning for
    allow-listed brand names appearing within ~80 chars of an int with
    a comma separator (e.g. '49,304 units'). Returns at most one row
    per OEM, prefering the largest extracted number per brand (helps
    when an article quotes prior-year + current-month side-by-side)."""
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text)
    out: dict[str, dict] = {}
    for oem in OEM_ALLOWLIST.get(segment_id, []):
        # Search for the OEM name then the next units-like number within 120 chars
        pattern = re.compile(
            rf"{re.escape(oem)}[^0-9]{{0,120}}?([\d,]{{3,}})\s*(?:units|sales)?",
            re.IGNORECASE,
        )
        match = pattern.search(text)
        if not match:
            continue
        digits = match.group(1).replace(",", "")
        try:
            units = int(digits)
        except ValueError:
            continue
        # Plausibility filter — leaderboard rows shouldn't be 1-digit or 7-digit
        if units < 50 or units > 1_000_000:
            continue
        # Take the larger value if duplicate match (article repeats brand)
        existing = out.get(oem)
        if not existing or units > existing["units"]:
            out[oem] = {"oem": oem, "units": units, "prior_units": None}
    return list(out.values())


def parse_segment(config: dict) -> dict | None:
    article_url = discover_latest_article(config)
    if not article_url:
        return None
    html = fetch(article_url)
    if not html:
        return None
    rows = extract_rows(html, config["id"])
    if len(rows) < 3:
        print(f"  {config['id']}: only {len(rows)} OEM rows extracted, treating as parse failure", flush=True)
        return None
    total_units = sum(row["units"] for row in rows)
    return {
        "id": config["id"],
        "label": config["label"],
        "source_name": config["source_name"],
        "source_url": article_url,
        "growth_label": config["growth_label"],
        "compare_label": (
            "Same month, prior year" if config["compare_kind"] == "yoy" else "Prior month"
        ),
        "rows": rows,
        "total_units": total_units,
        "note": (
            f"Auto-extracted from {config['source_name']}'s monthly leaderboard. "
            "Numbers may be revised when the next article is posted."
        ),
    }


def load_existing() -> dict:
    if not HISTORY_PATH.exists():
        return {"schema_version": 1, "datasets": []}
    try:
        return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"schema_version": 1, "datasets": []}


def save(payload: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def main() -> int:
    existing = load_existing()
    existing_by_id = {ds.get("id"): ds for ds in (existing.get("datasets") or []) if ds.get("id")}

    refreshed: list[dict] = []
    failures: list[str] = []

    for config in SEGMENT_CONFIG:
        seg_id = config["id"]
        print(f"--- {seg_id}: {config['source_name']} ---", flush=True)
        try:
            new_dataset = parse_segment(config)
        except Exception as exc:  # pragma: no cover  (network / parse oddities)
            print(f"  {seg_id}: unexpected error ({exc})", flush=True)
            new_dataset = None
        if new_dataset:
            print(f"  {seg_id}: {len(new_dataset['rows'])} rows, total {new_dataset['total_units']:,} units", flush=True)
            # Carry forward prior_units / latest_month from the previous
            # snapshot when the scraper can't infer them from the article
            # (most articles only quote current-month units, not the
            # comparison column). These get patched up by the next
            # successful extract that does pick them up.
            prior = existing_by_id.get(seg_id) or {}
            prior_rows_by_oem = {row.get("oem"): row for row in (prior.get("rows") or []) if row.get("oem")}
            for row in new_dataset["rows"]:
                if row["prior_units"] is None and row["oem"] in prior_rows_by_oem:
                    row["prior_units"] = prior_rows_by_oem[row["oem"]].get("prior_units")
            new_dataset["latest_month"] = prior.get("latest_month") or new_dataset.get("latest_month") or ""
            refreshed.append(new_dataset)
        else:
            failures.append(seg_id)
            existing_dataset = existing_by_id.get(seg_id)
            if existing_dataset:
                print(f"  {seg_id}: keeping previous {len(existing_dataset.get('rows', []))} rows from {existing_dataset.get('latest_month','?')}", flush=True)
                refreshed.append(existing_dataset)

    if not refreshed:
        print("\nAll segments failed to parse and no existing data to fall back on.", file=sys.stderr)
        return 1

    payload = {
        "schema_version": 1,
        "as_of_date": datetime.now(tz=timezone.utc).strftime("%Y-%m-%d"),
        "source_note": (
            "Per-segment monthly EV OEM leaderboards scraped from named "
            "trade-press articles. Refreshed by scripts/refresh_ev_oem_tracker.py "
            "on each CI tick; segments that fail to parse fall back to the last "
            "successful scrape so the dashboard never renders empty."
        ),
        "datasets": refreshed,
    }
    save(payload)
    print(f"\nWrote {HISTORY_PATH} ({len(refreshed)} segments, {len(failures)} fell back to cache).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
