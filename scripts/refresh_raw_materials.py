"""Refresh data/raw_material_history.json with monthly commodity prices
from FRED (St. Louis Fed). FRED republishes the IMF / World Bank monthly
commodity series under simple URL endpoints with no API key required.

Series pulled (all monthly, USD-denominated):
  PALUMUSDM   — Aluminum,   USD / metric ton
  PCOPPUSDM   — Copper,     USD / metric ton
  PNICKUSDM   — Nickel,     USD / metric ton
  PLEADUSDM   — Lead,       USD / metric ton
  PIORECRUSDM — Iron Ore,   USD / dry metric ton
  PRUBBUSDM   — Rubber,     US cents / lb (we convert to USD/kg
                            for compatibility with the legacy hardcoded
                            "Natural Rubber TSR20" series in analyze.py)

Output schema:
  {
    "schema_version": 1,
    "as_of_date": "YYYY-MM-DD",
    "source_name": "FRED — IMF/World Bank Commodity Prices",
    "source_url": "https://fred.stlouisfed.org/",
    "materials": [
      {
        "id": "aluminum", "label": "Aluminum",
        "unit_label": "USD / metric ton", "axis_suffix": "/mt",
        "fred_series": "PALUMUSDM",
        "series": [
          {"period": "2020-04", "label": "Apr 2020", "value": 1483.4},
          ...
        ]
      },
      ...
    ]
  }

Run via the Refresh dashboard data CI workflow. FRED has clean public
egress and no rate limit on the static-CSV endpoint.
"""
from __future__ import annotations

import csv
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests


HISTORY_PATH = Path("data/raw_material_history.json")
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "text/csv,*/*;q=0.8",
}

# Earliest month we want in the persisted file. FRED has data going back
# to 1990 for most of these series; we keep the file slim by clipping to
# 2018-onward (still gives the dashboard 8+ years which exceeds the 6-year
# target). Bump back if a future analysis wants longer history.
START_MONTH = "2018-01"

FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"

MATERIALS = [
    {
        "id": "aluminum",
        "label": "Aluminum",
        "unit_label": "USD / metric ton",
        "axis_suffix": "/mt",
        "fred_series": "PALUMUSDM",
        "convert": None,  # FRED already in USD/mt
    },
    {
        "id": "copper",
        "label": "Copper",
        "unit_label": "USD / metric ton",
        "axis_suffix": "/mt",
        "fred_series": "PCOPPUSDM",
        "convert": None,
    },
    {
        "id": "nickel",
        "label": "Nickel",
        "unit_label": "USD / metric ton",
        "axis_suffix": "/mt",
        "fred_series": "PNICKUSDM",
        "convert": None,
    },
    {
        "id": "lead",
        "label": "Lead",
        "unit_label": "USD / metric ton",
        "axis_suffix": "/mt",
        "fred_series": "PLEADUSDM",
        "convert": None,
    },
    {
        "id": "iron_ore",
        "label": "Iron Ore (steel proxy)",
        "unit_label": "USD / dry metric ton",
        "axis_suffix": "/dmt",
        "fred_series": "PIORECRUSDM",
        "convert": None,
    },
    {
        "id": "natural_rubber",
        "label": "Natural Rubber (RSS3 proxy)",
        "unit_label": "USD / kg",
        "axis_suffix": "/kg",
        "fred_series": "PRUBBUSDM",
        # FRED's PRUBBUSDM is RSS3 in US cents per lb. Convert to USD/kg
        # by × 0.01 (cents → dollars) × 2.20462 (lb → kg). Note: TSR20
        # (the dashboard's previous label) trades at a slight discount
        # to RSS3 — typically 5-10% — but for trend-reading purposes
        # they move in lockstep.
        "convert": "rubber_cents_lb_to_usd_kg",
    },
]


def _fred_url(series: str) -> str:
    return FRED_CSV_URL.format(series=series)


def _fetch_series(series_id: str) -> list[tuple[str, float]]:
    """Returns chronological [(YYYY-MM, value), ...] pairs from FRED."""
    url = _fred_url(series_id)
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
    except Exception as exc:
        print(f"  FRED fetch failed for {series_id}: {exc}", flush=True)
        return []
    reader = csv.reader(io.StringIO(response.text))
    rows = list(reader)
    if not rows or len(rows) < 2:
        print(f"  FRED returned empty CSV for {series_id}", flush=True)
        return []
    out: list[tuple[str, float]] = []
    for row in rows[1:]:
        if len(row) < 2:
            continue
        date_str, val_str = row[0], row[1]
        if val_str == "." or not val_str:
            continue
        try:
            month_id = date_str[:7]  # YYYY-MM
            value = float(val_str)
        except (ValueError, IndexError):
            continue
        out.append((month_id, value))
    return out


def _convert_value(value: float, mode: str | None) -> float:
    if mode is None:
        return value
    if mode == "rubber_cents_lb_to_usd_kg":
        # cents/lb → USD/lb → USD/kg
        return value * 0.01 * 2.20462
    return value


def _month_label(month_id: str) -> str:
    try:
        d = datetime.strptime(month_id, "%Y-%m")
    except ValueError:
        return month_id
    return d.strftime("%b %Y")


def main() -> int:
    materials_out: list[dict] = []
    failed: list[str] = []
    for material in MATERIALS:
        print(f"--- {material['id']} ({material['fred_series']}) ---", flush=True)
        raw_pairs = _fetch_series(material["fred_series"])
        if not raw_pairs:
            failed.append(material["id"])
            continue
        clipped = [
            (month, val) for (month, val) in raw_pairs
            if month >= START_MONTH
        ]
        series = [
            {
                "period": month,
                "label": _month_label(month),
                "value": round(_convert_value(val, material.get("convert")), 4),
            }
            for (month, val) in clipped
        ]
        if not series:
            print(f"  {material['id']}: no rows >= {START_MONTH}", flush=True)
            failed.append(material["id"])
            continue
        print(
            f"  {material['id']}: {len(series)} months "
            f"({series[0]['period']} → {series[-1]['period']}); "
            f"latest {series[-1]['value']:,.2f} {material['axis_suffix']}",
            flush=True,
        )
        materials_out.append({
            "id": material["id"],
            "label": material["label"],
            "unit_label": material["unit_label"],
            "axis_suffix": material["axis_suffix"],
            "fred_series": material["fred_series"],
            "series": series,
        })

    if not materials_out:
        print("\nNo materials fetched successfully.", file=sys.stderr)
        return 1

    payload = {
        "schema_version": 1,
        "as_of_date": datetime.now(tz=timezone.utc).strftime("%Y-%m-%d"),
        "source_name": "FRED (St. Louis Fed) — IMF / World Bank Commodity Prices",
        "source_url": "https://fred.stlouisfed.org/",
        "source_note": (
            "Monthly commodity prices fetched from the FRED public CSV endpoint. "
            "Aluminum / Copper / Nickel / Lead / Iron Ore are direct USD-per-metric-ton "
            "series. Natural Rubber is FRED's RSS3 cents-per-pound (PRUBBUSDM), converted "
            "to USD/kg for compatibility with the dashboard's previous TSR20 axis (RSS3 "
            "and TSR20 trade in lockstep — TSR20 typically 5-10% discount)."
        ),
        "materials": materials_out,
    }

    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"\nWrote {HISTORY_PATH} ({len(materials_out)} materials, {len(failed)} failed).")
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())
