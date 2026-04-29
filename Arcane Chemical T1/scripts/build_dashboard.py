from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Any

import pandas as pd
import requests

from archean_seed import (
    COMPANY,
    COMPANY_CAPACITY_UTILIZATION,
    COMPANY_CAPEX_PROJECTS,
    COMPANY_QUARTERLY_FINANCIALS,
    COMPANY_SEGMENT_METRICS,
    COMPANY_SUBSIDIARIES_AND_INVESTMENTS,
    CUSTOMER_DISCLOSURE,
    IRAN_ISRAEL_WAR_2026_CURRENT,
    IRAN_ISRAEL_WAR_2025,
    MARKET_CONTEXT_FALLBACK,
    OVERVIEW_FACTS,
    OVERVIEW_REVENUE_MIX_HISTORY,
    PEER_METRICS,
    PLANT_ASSET_REGISTER,
)


ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"
DIST_DIR = ROOT / "dist"
DIST_ASSETS_DIR = DIST_DIR / "assets"
DIST_DATA_DIR = DIST_DIR / "data"
DIST_EXPORTS_DIR = DIST_DATA_DIR / "exports"
DIST_SOURCE_DOCS_DIR = DIST_DIR / "source_docs"
DIST_SOURCE_TEXT_DIR = DIST_DIR / "source_text"
CACHE_DIR = ROOT / "data" / "cache"
MANUAL_DIR = ROOT / "data" / "manual"
SOURCE_DOCS_DIR = ROOT / "data" / "source_docs"
DB_PATH = CACHE_DIR / "archean_research.sqlite"
TRADE_CACHE_PATH = CACHE_DIR / "market_cache.json"
DOWNLOADS_DIR = Path.home() / "Downloads"
PRICE_FILES = {
    "bromine": DOWNLOADS_DIR / "bromine_daily_actual_fx_approx.xlsx",
    "salt": DOWNLOADS_DIR / "industrial_salt_daily_inr_assumed_rmb.xlsx",
}
BROMINE_LIVE_URL = "https://www.sunsirs.com/uk/prodetail-643.html"
SALT_LIVE_URL = "https://www.sunsirs.com/uk/prodetail-1520.html"
INVESTING_BRENT_URL = "https://www.investing.com/commodities/brent-oil-historical-data"
INVESTING_ARCHEAN_URL = "https://www.investing.com/equities/archean-chemical-industries-historical-data"
INVESTING_AU_COMMODITIES_NEWS_URL = "https://au.investing.com/news/commodities-news"
FIRECRAWL_API_KEY = os.getenv("FIRECRAWL_API_KEY", "fc-203d41c5b1984cdabee2a7564572efea")
BROMINE_MANUAL_SUPPLEMENT = [
    ("2026-04-02", 938458),
    ("2026-04-03", 936721),
    ("2026-04-04", 936721),
    ("2026-04-05", 936721),
    ("2026-04-06", 938736),
    ("2026-04-07", 941169),
    ("2026-04-08", 935752),
]


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def quarter_sort_key(period: str) -> tuple[int, int, int]:
    if period.startswith("Q") and "FY" in period:
        return (2000 + int(period.split("FY")[1]), int(period[1]), 0)
    if period.startswith("9MFY"):
        return (2000 + int(period.replace("9MFY", "")), 9, 1)
    if period.startswith("FY"):
        return (2000 + int(period.replace("FY", "")), 10, 2)
    return (9999, 99, 99)


def parse_quarter(period: str) -> tuple[int, int] | None:
    if not period.startswith("Q") or "FY" not in period:
        return None
    return int(period[1]), 2000 + int(period.split("FY")[1])


def prev_quarter(period: str) -> str | None:
    parsed = parse_quarter(period)
    if not parsed:
        return None
    quarter, fiscal_year = parsed
    if quarter == 1:
        return f"Q4FY{str(fiscal_year - 1)[-2:]}"
    return f"Q{quarter - 1}FY{str(fiscal_year)[-2:]}"


def yoy_quarter(period: str) -> str | None:
    parsed = parse_quarter(period)
    if not parsed:
        return None
    quarter, fiscal_year = parsed
    return f"Q{quarter}FY{str(fiscal_year - 1)[-2:]}"


def next_period_labels(length: int) -> list[str]:
    quarter = 4
    fiscal_year = 2026
    labels: list[str] = []
    for _ in range(length):
        labels.append(f"Q{quarter}FY{str(fiscal_year)[-2:]}")
        quarter += 1
        if quarter == 5:
            quarter = 1
            fiscal_year += 1
    return labels


def compute_segment_metrics(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        cloned = dict(row)
        cloned["implied_realization_per_ton"] = (
            (cloned["revenue"] * 1_000_000.0) / cloned["volume_tons"] if cloned.get("volume_tons") else None
        )
        grouped[cloned["product_segment"]].append(cloned)

    enriched: list[dict[str, Any]] = []
    for segment_rows in grouped.values():
        segment_rows.sort(key=lambda item: quarter_sort_key(item["period"]))
        row_map = {row["period"]: row for row in segment_rows}
        for row in segment_rows:
            for prefix, prior in (("qoq", row_map.get(prev_quarter(row["period"]) or "")), ("yoy", row_map.get(yoy_quarter(row["period"]) or ""))):
                for key, label in (
                    ("revenue", "revenue"),
                    ("volume_tons", "volume"),
                    ("implied_realization_per_ton", "realization"),
                ):
                    current = row.get(key)
                    prior_value = prior.get(key) if prior else None
                    out_key = f"{prefix}_{label}"
                    if current is None or prior_value in (None, 0):
                        row[out_key] = None
                    else:
                        row[out_key] = round(((current - prior_value) / prior_value) * 100.0, 1)
            enriched.append(row)
    enriched.sort(key=lambda item: (item["product_segment"], quarter_sort_key(item["period"])))
    return enriched


def build_snapshots(financials: list[dict[str, Any]], segment_rows: list[dict[str, Any]]) -> dict[str, Any]:
    consolidated = {
        row["period"]: row for row in financials if row["reported_basis"] == "consolidated" and row["period_type"] == "quarter"
    }
    q3 = consolidated["Q3FY26"]
    q2 = consolidated["Q2FY26"]
    q1 = consolidated["Q1FY26"]

    def pick(period: str, segment: str) -> dict[str, Any]:
        return next(row for row in segment_rows if row["period"] == period and row["product_segment"] == segment)

    brom_q1 = pick("Q1FY26", "Bromine")
    brom_q3 = pick("Q3FY26", "Bromine")
    salt_q2 = pick("Q2FY26", "Industrial Salt")
    salt_q3 = pick("Q3FY26", "Industrial Salt")

    return {
        "revenue_change_qoq_pct": round(((q3["revenue_total"] - q2["revenue_total"]) / q2["revenue_total"]) * 100.0, 1),
        "ebitda_margin_change_bps": round((q3["ebitda_margin"] - q2["ebitda_margin"]) * 100.0, 0),
        "pat_change_qoq_pct": round(((q3["pat"] - q2["pat"]) / q2["pat"]) * 100.0, 1),
        "bromine_volume_change_q1_to_q3_pct": round(((brom_q3["volume_tons"] - brom_q1["volume_tons"]) / brom_q1["volume_tons"]) * 100.0, 1),
        "bromine_realization_change_q1_to_q3_pct": round(
            ((brom_q3["implied_realization_per_ton"] - brom_q1["implied_realization_per_ton"]) / brom_q1["implied_realization_per_ton"]) * 100.0,
            1,
        ),
        "salt_volume_change_q2_to_q3_pct": round(((salt_q3["volume_tons"] - salt_q2["volume_tons"]) / salt_q2["volume_tons"]) * 100.0, 1),
    }


def fallback_market_cache() -> dict[str, Any]:
    return {
        "fetched_at": "2026-03-28T00:00:00+00:00",
        "trade_bromine_country": [
            {"year": 2024, "month_if_available": None, "exporter_country": "India", "importer_country": "World", "trade_value_usd": 16819570, "trade_volume_kg": 7239320, "unit_value_usd_per_ton": 2323.9},
            {"year": 2024, "month_if_available": None, "exporter_country": "India", "importer_country": "China", "trade_value_usd": 15625450, "trade_volume_kg": 6987800, "unit_value_usd_per_ton": 2236.7},
            {"year": 2024, "month_if_available": None, "exporter_country": "Jordan", "importer_country": "India", "trade_value_usd": 10587500, "trade_volume_kg": 4238030, "unit_value_usd_per_ton": 2498.7},
            {"year": 2024, "month_if_available": None, "exporter_country": "Israel", "importer_country": "India", "trade_value_usd": 9271130, "trade_volume_kg": 3802900, "unit_value_usd_per_ton": 2437.7},
            {"year": 2024, "month_if_available": None, "exporter_country": "Israel", "importer_country": "World", "trade_value_usd": 126935000, "trade_volume_kg": 55086500, "unit_value_usd_per_ton": 2304.2},
            {"year": 2024, "month_if_available": None, "exporter_country": "Jordan", "importer_country": "World", "trade_value_usd": 48108740, "trade_volume_kg": 20048400, "unit_value_usd_per_ton": 2399.6},
            {"year": 2024, "month_if_available": None, "exporter_country": "Japan", "importer_country": "World", "trade_value_usd": 41447960, "trade_volume_kg": 10418500, "unit_value_usd_per_ton": 3978.2},
            {"year": 2024, "month_if_available": None, "exporter_country": "United States", "importer_country": "World", "trade_value_usd": 18081090, "trade_volume_kg": 4847770, "unit_value_usd_per_ton": 3730.8},
            {"year": 2024, "month_if_available": None, "exporter_country": "India", "importer_country": "World", "trade_value_usd": 16819570, "trade_volume_kg": 7239320, "unit_value_usd_per_ton": 2323.9},
        ],
        "trade_salt_country": [
            {"year": 2024, "month_if_available": None, "exporter_country": "India", "importer_country": "World", "trade_value_usd": 431422300, "trade_volume_kg": 20292700000, "unit_value_usd_per_ton": 21.3},
            {"year": 2024, "month_if_available": None, "exporter_country": "India", "importer_country": "China", "trade_value_usd": 216923800, "trade_volume_kg": 11828100000, "unit_value_usd_per_ton": 18.3},
            {"year": 2024, "month_if_available": None, "exporter_country": "India", "importer_country": "Korea, Rep.", "trade_value_usd": 59879770, "trade_volume_kg": 3038400000, "unit_value_usd_per_ton": 19.7},
            {"year": 2024, "month_if_available": None, "exporter_country": "India", "importer_country": "Japan", "trade_value_usd": 23935590, "trade_volume_kg": 1063470000, "unit_value_usd_per_ton": 22.5},
            {"year": 2024, "month_if_available": None, "exporter_country": "India", "importer_country": "Indonesia", "trade_value_usd": 17447300, "trade_volume_kg": 758768000, "unit_value_usd_per_ton": 23.0},
            {"year": 2024, "month_if_available": None, "exporter_country": "India", "importer_country": "Qatar", "trade_value_usd": 16829100, "trade_volume_kg": 717758000, "unit_value_usd_per_ton": 23.4},
            {"year": 2024, "month_if_available": None, "exporter_country": "Germany", "importer_country": "World", "trade_value_usd": 375419180, "trade_volume_kg": 3862560000, "unit_value_usd_per_ton": 97.2},
            {"year": 2024, "month_if_available": None, "exporter_country": "Netherlands", "importer_country": "World", "trade_value_usd": 331186910, "trade_volume_kg": 3100960000, "unit_value_usd_per_ton": 106.8},
            {"year": 2024, "month_if_available": None, "exporter_country": "United States", "importer_country": "World", "trade_value_usd": 244244250, "trade_volume_kg": 1948320000, "unit_value_usd_per_ton": 125.4},
        ],
        "market_context": MARKET_CONTEXT_FALLBACK,
    }


def parse_trade_table(df: pd.DataFrame, flow: str) -> list[dict[str, Any]]:
    df.columns = df.iloc[0]
    rows = df.iloc[1:].reset_index(drop=True)
    parsed: list[dict[str, Any]] = []
    for _, row in rows.iterrows():
        reporter = text(row.get("Reporter"))
        partner = text(row.get("Partner"))
        year = int(float(row.get("Year")))
        value = float(row.get("Trade Value 1000USD")) * 1000.0
        quantity = float(row.get("Quantity")) if pd.notna(row.get("Quantity")) else None
        exporter, importer = (reporter, partner) if flow == "export" else (partner, reporter)
        parsed.append(
            {
                "year": year,
                "month_if_available": None,
                "exporter_country": exporter,
                "importer_country": importer,
                "trade_value_usd": value,
                "trade_volume_kg": quantity,
                "unit_value_usd_per_ton": round(value / (quantity / 1000.0), 1) if quantity else None,
            }
        )
    return parsed


def fetch_market_cache() -> dict[str, Any]:
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9"})
    bromine_rows: list[dict[str, Any]] = []
    salt_rows: list[dict[str, Any]] = []

    for year in (2022, 2023, 2024, 2025):
        for flow, url in (
            ("export", f"https://wits.worldbank.org/trade/comtrade/en/country/IND/year/{year}/tradeflow/Exports/partner/ALL/product/280130"),
            ("import", f"https://wits.worldbank.org/trade/comtrade/en/country/IND/year/{year}/tradeflow/Imports/partner/ALL/product/280130"),
            ("export", f"https://wits.worldbank.org/trade/comtrade/en/country/ALL/year/{year}/tradeflow/Exports/partner/WLD/product/280130"),
        ):
            html = session.get(url, timeout=60).text
            bromine_rows.extend(parse_trade_table(pd.read_html(StringIO(html))[0], flow))
    for year in (2022, 2023, 2024):
        for flow, url in (
            ("export", f"https://wits.worldbank.org/trade/comtrade/en/country/IND/year/{year}/tradeflow/Exports/partner/ALL/product/250100"),
            ("export", f"https://wits.worldbank.org/trade/comtrade/en/country/ALL/year/{year}/tradeflow/Exports/partner/WLD/product/250100"),
        ):
            html = session.get(url, timeout=60).text
            salt_rows.extend(parse_trade_table(pd.read_html(StringIO(html))[0], flow))

    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "trade_bromine_country": bromine_rows,
        "trade_salt_country": salt_rows,
        "market_context": MARKET_CONTEXT_FALLBACK,
    }
    write_json(TRADE_CACHE_PATH, payload)
    return payload


def load_market_cache(refresh_live: bool) -> dict[str, Any]:
    if refresh_live:
        return fetch_market_cache()
    return read_json(TRADE_CACHE_PATH, fallback_market_cache())


def build_trade_summary(trade_cache: dict[str, Any]) -> dict[str, Any]:
    bromine = trade_cache["trade_bromine_country"]
    salt = trade_cache["trade_salt_country"]
    bromine_years = sorted({r["year"] for r in bromine})
    latest_bromine_year = max(bromine_years) if bromine_years else None

    def dedupe_trade_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        unique: dict[tuple[Any, Any, Any, Any], dict[str, Any]] = {}
        for row in rows:
            key = (row.get("year"), row.get("exporter_country"), row.get("importer_country"), row.get("trade_value_usd"))
            unique[key] = row
        return list(unique.values())

    def bromine_rows_for(year: int, *, importer: str | None = None, exporter: str | None = None) -> list[dict[str, Any]]:
        rows = [r for r in bromine if r["year"] == year]
        if importer is not None:
            rows = [r for r in rows if r["importer_country"] == importer]
        if exporter is not None:
            rows = [r for r in rows if r["exporter_country"] == exporter]
        return dedupe_trade_rows(rows)

    def first_bromine(year: int, *, importer: str, exporter: str) -> dict[str, Any] | None:
        return next((r for r in bromine if r["year"] == year and r["importer_country"] == importer and r["exporter_country"] == exporter), None)

    def is_reliable_bromine_year(year: int) -> bool:
        world_rows = bromine_rows_for(year, importer="World")
        exporters = {r["exporter_country"] for r in world_rows}
        india_export_world = first_bromine(year, importer="World", exporter="India")
        india_import_world = first_bromine(year, importer="India", exporter="World")
        return bool(
            world_rows
            and india_export_world
            and india_import_world
            and {"Israel", "Jordan"}.issubset(exporters)
        )

    reliable_bromine_year = next((year for year in sorted(bromine_years, reverse=True) if is_reliable_bromine_year(year)), latest_bromine_year)
    reliable_bromine_year = reliable_bromine_year or 2024
    reliable_import_source = f"wits-ind-bromine-{reliable_bromine_year}-import"
    reliable_export_source = f"wits-ind-bromine-{reliable_bromine_year}-export"
    reliable_world_source = f"wits-world-bromine-{reliable_bromine_year}-export"
    summary = {
        "bromine_latest_available_year": latest_bromine_year,
        "bromine_latest_reliable_year": reliable_bromine_year,
        "bromine_latest_reliable_import_source_id": reliable_import_source,
        "bromine_latest_reliable_export_source_id": reliable_export_source,
        "bromine_latest_reliable_world_export_source_id": reliable_world_source,
        "india_bromine_exports_2024": sorted(
            [r for r in bromine if r["year"] == 2024 and r["exporter_country"] == "India" and r["importer_country"] != "World"],
            key=lambda item: item["trade_value_usd"],
            reverse=True,
        )[:8],
        "india_bromine_imports_2024": sorted(
            [r for r in bromine if r["year"] == 2024 and r["importer_country"] == "India" and r["exporter_country"] != "World"],
            key=lambda item: item["trade_value_usd"],
            reverse=True,
        )[:6],
        "world_bromine_exports_2024": sorted(
            [r for r in bromine if r["year"] == 2024 and r["importer_country"] == "World"],
            key=lambda item: item["trade_value_usd"],
            reverse=True,
        )[:8],
        "india_salt_exports_2024": sorted(
            [r for r in salt if r["year"] == 2024 and r["exporter_country"] == "India" and r["importer_country"] != "World"],
            key=lambda item: item["trade_value_usd"],
            reverse=True,
        )[:8],
        "world_salt_exports_2024": sorted(
            [r for r in salt if r["year"] == 2024 and r["importer_country"] == "World"],
            key=lambda item: item["trade_value_usd"],
            reverse=True,
        )[:8],
        "india_bromine_exports_latest_reliable": sorted(
            [r for r in bromine_rows_for(reliable_bromine_year, exporter="India") if r["importer_country"] != "World"],
            key=lambda item: item["trade_value_usd"],
            reverse=True,
        )[:8],
        "india_bromine_imports_latest_reliable": sorted(
            [r for r in bromine_rows_for(reliable_bromine_year, importer="India") if r["exporter_country"] != "World"],
            key=lambda item: item["trade_value_usd"],
            reverse=True,
        )[:8],
        "world_bromine_exports_latest_reliable": sorted(
            bromine_rows_for(reliable_bromine_year, importer="World"),
            key=lambda item: item["trade_value_usd"],
            reverse=True,
        )[:8],
        "india_bromine_world_latest_reliable": first_bromine(reliable_bromine_year, importer="World", exporter="India"),
        "india_bromine_import_world_latest_reliable": first_bromine(reliable_bromine_year, importer="India", exporter="World"),
    }
    summary["india_bromine_net_trade_series"] = [
        {
            "year": year,
            "exports_usd_mn": round(((first_bromine(year, importer="World", exporter="India") or {}).get("trade_value_usd", 0.0)) / 1_000_000.0, 1),
            "imports_usd_mn": round(((first_bromine(year, importer="India", exporter="World") or {}).get("trade_value_usd", 0.0)) / 1_000_000.0, 1),
            "net_import_gap_usd_mn": round(
                (
                    ((first_bromine(year, importer="India", exporter="World") or {}).get("trade_value_usd", 0.0))
                    - ((first_bromine(year, importer="World", exporter="India") or {}).get("trade_value_usd", 0.0))
                )
                / 1_000_000.0,
                1,
            ),
        }
        for year in bromine_years
        if year <= reliable_bromine_year
    ]
    share_series = []
    for year in bromine_years:
        if year > reliable_bromine_year:
            continue
        year_rows = [r for r in bromine if r["year"] == year and r["importer_country"] == "World" and r["trade_volume_kg"]]
        total_qty = sum(r["trade_volume_kg"] for r in year_rows if r["trade_volume_kg"])
        india_row = next((r for r in year_rows if r["exporter_country"] == "India"), None)
        share_series.append(
            {
                "year": year,
                "india_bromine_export_share_pct": round((india_row["trade_volume_kg"] / total_qty) * 100.0, 1) if india_row and total_qty else None,
            }
        )
    summary["india_bromine_share_series"] = share_series
    summary["india_bromine_world_2024"] = next(
        (r for r in bromine if r["year"] == 2024 and r["exporter_country"] == "India" and r["importer_country"] == "World"),
        None,
    )
    summary["india_bromine_import_world_2024"] = next(
        (r for r in bromine if r["year"] == 2024 and r["exporter_country"] == "World" and r["importer_country"] == "India"),
        None,
    )
    if latest_bromine_year and latest_bromine_year > reliable_bromine_year:
        summary["bromine_trade_warning"] = (
            f"WITS annual bromine trade pages for {latest_bromine_year} are still incomplete. "
            f"India import and export pages are blank, and the world table excludes Israel and Jordan, "
            f"so {reliable_bromine_year} is the latest reliable full-year set."
        )
        summary["bromine_trade_warning_source_ids"] = [
            f"wits-ind-bromine-{latest_bromine_year}-import",
            f"wits-ind-bromine-{latest_bromine_year}-export",
            f"wits-world-bromine-{latest_bromine_year}-export",
        ]
    summary["india_salt_world_2024"] = next(
        (r for r in salt if r["year"] == 2024 and r["exporter_country"] == "India" and r["importer_country"] == "World"),
        None,
    )
    return summary


def build_macro_rows(trade_cache: dict[str, Any]) -> list[dict[str, Any]]:
    bromine_rows = trade_cache["trade_bromine_country"]
    salt_rows = trade_cache["trade_salt_country"]
    rows: list[dict[str, Any]] = []
    for year in sorted({row["year"] for row in bromine_rows + salt_rows}):
        brom_row = next((r for r in bromine_rows if r["year"] == year and r["exporter_country"] == "World" and r["importer_country"] == "India"), None)
        salt_row = next((r for r in salt_rows if r["year"] == year and r["exporter_country"] == "India" and r["importer_country"] == "World"), None)
        rows.append(
            {
                "date": f"{year}-12-31",
                "usd_inr": None,
                "crude_proxy": None,
                "freight_index": None,
                "power_tariff_proxy": None,
                "diesel_proxy": None,
                "bromine_market_price_proxy": brom_row["unit_value_usd_per_ton"] if brom_row else None,
                "salt_trade_unit_value_proxy": salt_row["unit_value_usd_per_ton"] if salt_row else None,
                "rainfall_proxy": None,
                "monsoon_intensity_proxy": None,
                "source_id": "wits-ind-bromine-2024-import" if year <= 2024 else "wits-ind-bromine-2025-import",
            }
        )
    return rows


def build_model_output(segment_rows: list[dict[str, Any]], assumptions: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    bromine_q3 = next(row for row in segment_rows if row["period"] == "Q3FY26" and row["product_segment"] == "Bromine")
    salt_q3 = next(row for row in segment_rows if row["period"] == "Q3FY26" and row["product_segment"] == "Industrial Salt")
    deriv_q3 = next(row for row in segment_rows if row["period"] == "Q3FY26" and row["product_segment"] == "Bromine Derivatives")
    model_rows: list[dict[str, Any]] = []
    for name, config in assumptions.items():
        brom_price = bromine_q3["implied_realization_per_ton"] * (1 + config["bromine_realization_growth_qoq_pct"] / 100.0)
        brom_vol = float(config["bromine_volume_start_tons"])
        salt_price = salt_q3["implied_realization_per_ton"] * (1 + config["salt_realization_growth_qoq_pct"] / 100.0)
        salt_vol = float(config["salt_volume_start_tons"])
        deriv_rev = float(config["derivatives_revenue_start_mn"])
        for period in next_period_labels(8):
            brom_rev = brom_price * brom_vol / 1_000_000.0
            salt_rev = salt_price * salt_vol / 1_000_000.0
            revenue = brom_rev + salt_rev + deriv_rev
            ebitda = (
                brom_rev * (config["bromine_ebitda_margin_pct"] / 100.0)
                + salt_rev * (config["salt_ebitda_margin_pct"] / 100.0)
                + deriv_rev * (config["derivatives_ebitda_margin_pct"] / 100.0)
                - config["corporate_cost_mn"]
            )
            stress_bps = config["freight_stress_bps"] + config["fx_stress_bps"] + config["power_stress_bps"] + config["monsoon_stress_bps"]
            ebitda *= 1 - stress_bps / 10000.0
            pbt = ebitda - 238.0 - 45.0
            pat = pbt * (1 - config["tax_rate_pct"] / 100.0)
            model_rows.append(
                {
                    "period": period,
                    "scenario_name": name,
                    "bromine_price_assumption": round(brom_price / 1000.0, 1),
                    "bromine_volume_assumption": round(brom_vol, 0),
                    "salt_volume_assumption": round(salt_vol, 0),
                    "salt_realization_assumption": round(salt_price, 1),
                    "derivative_utilization_assumption": round(min(85.0, (deriv_rev / 137.0) * 35.0), 1),
                    "fx_assumption": round(83.0 + config["fx_stress_bps"] / 100.0, 2),
                    "freight_assumption": config["freight_stress_bps"],
                    "predicted_revenue": round(revenue, 1),
                    "predicted_ebitda": round(ebitda, 1),
                    "predicted_margin": round((ebitda / revenue) * 100.0, 1),
                    "predicted_pat": round(pat, 1),
                }
            )
            brom_price *= 1 + config["bromine_realization_growth_qoq_pct"] / 100.0
            brom_vol *= 1 + config["bromine_volume_growth_qoq_pct"] / 100.0
            salt_price *= 1 + config["salt_realization_growth_qoq_pct"] / 100.0
            salt_vol *= 1 + config["salt_volume_growth_qoq_pct"] / 100.0
            deriv_rev *= 1 + config["derivatives_growth_qoq_pct"] / 100.0

    sensitivity = {"bromine_price_vs_utilization": [], "salt_volume_vs_freight": []}
    for price_shift in (-15, -10, -5, 0, 5, 10, 15):
        for util in (60, 70, 80, 90, 100):
            brom_rev = bromine_q3["revenue"] * (1 + price_shift / 100.0) * (util / 100.0)
            salt_rev = salt_q3["revenue"]
            ebitda = brom_rev * 0.52 + salt_rev * 0.20 + deriv_q3["revenue"] * 0.18 - 140.0
            sensitivity["bromine_price_vs_utilization"].append(
                {"price_shift_pct": price_shift, "utilization_pct": util, "ebitda_mn": round(ebitda, 1)}
            )
    for salt_shift in (-10, -5, 0, 5, 10):
        for freight_bps in (0, 40, 80, 120, 160):
            salt_rev = salt_q3["revenue"] * (1 + salt_shift / 100.0)
            ebitda = bromine_q3["revenue"] * 0.52 + salt_rev * 0.20 + deriv_q3["revenue"] * 0.18 - 140.0
            ebitda *= 1 - freight_bps / 10000.0
            sensitivity["salt_volume_vs_freight"].append(
                {"salt_volume_shift_pct": salt_shift, "freight_bps": freight_bps, "ebitda_mn": round(ebitda, 1)}
            )
    return model_rows, sensitivity


def build_business_map() -> list[dict[str, str]]:
    return [
        {"name": "Bromine", "stage": "Core earnings", "note": "Healthy demand, but FY26 output constrained by utilization problems."},
        {"name": "Industrial Salt", "stage": "Throughput anchor", "note": "Long-term offtake and scale support fixed-cost absorption."},
        {"name": "Bromine Derivatives", "stage": "Early commercial", "note": "Acume is running at 30% to 40% utilization and still qualifying products."},
        {"name": "SOP", "stage": "Pilot / plant-trial", "note": "Pilot trials are complete; plant-scale trials are the key gating item."},
        {"name": "Mudchemie", "stage": "Early commercial", "note": "Restart path is tied to approvals and oilfield demand."},
        {"name": "SiCSem", "stage": "Optionality", "note": "Approved long-gestation capex, not current operating earnings."},
        {"name": "Offgrid", "stage": "Optionality", "note": "Direct bromine chemistry adjacency via zinc-bromide batteries."},
    ]


def copy_price_source(path: Path) -> str | None:
    if not path.exists():
        return None
    SOURCE_DOCS_DIR.mkdir(parents=True, exist_ok=True)
    target = SOURCE_DOCS_DIR / path.name
    shutil.copy2(path, target)
    return str(target.relative_to(ROOT)).replace("\\", "/")


def fallback_price_module() -> dict[str, Any]:
    return {
        "frequency": "weekly",
        "bromine": {
            "label": "Bromine",
            "series_name": "Bromine price (Rs/ton)",
            "source_id": "derived-model",
            "history": [
                {"period": "03 Jan", "date": "2026-01-03", "price": 463356},
                {"period": "10 Jan", "date": "2026-01-10", "price": 464796},
                {"period": "17 Jan", "date": "2026-01-17", "price": 470556},
                {"period": "24 Jan", "date": "2026-01-24", "price": 479736},
                {"period": "31 Jan", "date": "2026-01-31", "price": 484380},
                {"period": "07 Feb", "date": "2026-02-07", "price": 488700},
                {"period": "14 Feb", "date": "2026-02-14", "price": 490356},
                {"period": "21 Feb", "date": "2026-02-21", "price": 492120},
                {"period": "28 Feb", "date": "2026-02-28", "price": 493380},
                {"period": "07 Mar", "date": "2026-03-07", "price": 494136},
                {"period": "14 Mar", "date": "2026-03-14", "price": 494964},
                {"period": "21 Mar", "date": "2026-03-21", "price": 495144},
                {"period": "28 Mar", "date": "2026-03-28", "price": 495720},
                {"period": "04 Apr", "date": "2026-04-04", "price": 496404},
            ],
            "stats": {
                "latest": 496404,
                "change_pct": 0.1,
                "high": 496404,
                "low": 463104,
                "latest_label": "04 Apr 2026 weekly close",
                "change_label": "vs prior weekly close",
                "range_label": "Sample fallback range",
            },
            "inputs": {
                "startingPrice": "Rs 496,404/ton",
                "lookback": "14 weekly points",
                "bullGrowth": "+5.0% per quarter",
                "baseGrowth": "+2.0% per quarter",
                "bearGrowth": "-3.0% per quarter",
                "volatility": "8% placeholder range",
                "bull_growth_pct": 5.0,
                "base_growth_pct": 2.0,
                "bear_growth_pct": -3.0,
            },
        },
        "salt": {
            "label": "Industrial Salt",
            "series_name": "Industrial salt price (Rs/ton)",
            "source_id": "derived-model",
            "history": [
                {"period": "09 Jan", "date": "2026-01-09", "price": 5175},
                {"period": "16 Jan", "date": "2026-01-16", "price": 5188},
                {"period": "23 Jan", "date": "2026-01-23", "price": 5203},
                {"period": "30 Jan", "date": "2026-01-30", "price": 5214},
                {"period": "06 Feb", "date": "2026-02-06", "price": 5227},
                {"period": "13 Feb", "date": "2026-02-13", "price": 5230},
                {"period": "20 Feb", "date": "2026-02-20", "price": 5234},
                {"period": "27 Feb", "date": "2026-02-27", "price": 5239},
                {"period": "06 Mar", "date": "2026-03-06", "price": 5245},
                {"period": "13 Mar", "date": "2026-03-13", "price": 5249},
                {"period": "20 Mar", "date": "2026-03-20", "price": 5252},
                {"period": "27 Mar", "date": "2026-03-27", "price": 5258},
                {"period": "03 Apr", "date": "2026-04-03", "price": 5262},
            ],
            "stats": {
                "latest": 5262,
                "change_pct": 0.1,
                "high": 5262,
                "low": 5149,
                "latest_label": "03 Apr 2026 weekly close",
                "change_label": "vs prior weekly close",
                "range_label": "Sample fallback range",
            },
            "inputs": {
                "startingPrice": "Rs 5,262/ton",
                "lookback": "13 weekly points",
                "bullGrowth": "+3.0% per quarter",
                "baseGrowth": "+1.0% per quarter",
                "bearGrowth": "-2.0% per quarter",
                "volatility": "5% placeholder range",
                "bull_growth_pct": 3.0,
                "base_growth_pct": 1.0,
                "bear_growth_pct": -2.0,
            },
        },
    }


def latest_cny_inr_rate() -> tuple[float | None, str | None]:
    candidates: list[tuple[pd.Timestamp, float]] = []
    for path, rate_col in (
        (PRICE_FILES["bromine"], "CNY_INR_rate_used"),
        (PRICE_FILES["salt"], "CNY_INR_Rate_Used"),
    ):
        if not path.exists():
            continue
        try:
            df = pd.read_excel(path, sheet_name="daily_series")
        except Exception:
            continue
        if "Date" not in df.columns or rate_col not in df.columns:
            continue
        temp = df[["Date", rate_col]].copy()
        temp["Date"] = pd.to_datetime(temp["Date"], errors="coerce")
        temp[rate_col] = pd.to_numeric(temp[rate_col], errors="coerce")
        temp = temp.dropna(subset=["Date", rate_col]).sort_values("Date")
        if temp.empty:
            continue
        last = temp.iloc[-1]
        candidates.append((last["Date"], float(last[rate_col])))
    if not candidates:
        return None, None
    latest_date, latest_rate = sorted(candidates, key=lambda item: item[0])[-1]
    return latest_rate, latest_date.strftime("%d %b %Y")


def parse_sunsirs_rows(text: str, commodity_label: str) -> list[dict[str, Any]]:
    rows = []
    commodity = re.escape(commodity_label)
    patterns = [
        re.compile(rf"\|\s*{commodity}\s*\|\s*Chemical\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*(\d{{4}}-\d{{2}}-\d{{2}})\s*\|", re.I),
        re.compile(rf"<td>\s*{commodity}\s*</td>\s*<td>\s*Chemical\s*</td>\s*<td>\s*([0-9]+(?:\.[0-9]+)?)\s*</td>\s*<td>\s*(\d{{4}}-\d{{2}}-\d{{2}})\s*</td>", re.I | re.S),
        re.compile(rf"{commodity}\s+Chemical\s+([0-9]+(?:\.[0-9]+)?)\s+(\d{{4}}-\d{{2}}-\d{{2}})", re.I),
    ]
    for pattern in patterns:
        matches = pattern.findall(text or "")
        if matches:
            for price, iso_date in matches:
                rows.append({"date": iso_date, "price_cny_per_ton": float(price)})
            break
    return rows


def fetch_latest_sunsirs_row(url: str, commodity_label: str) -> dict[str, Any] | None:
    session = requests.Session()
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        response = session.get(url, headers=headers, timeout=20)
        response.raise_for_status()
        rows = parse_sunsirs_rows(response.text, commodity_label)
        if rows:
            latest = sorted(rows, key=lambda row: row["date"])[-1]
            latest["fetch_method"] = "direct"
            return latest
    except Exception:
        pass

    if not FIRECRAWL_API_KEY:
        return None

    try:
        response = session.post(
            "https://api.firecrawl.dev/v1/scrape",
            headers={
                "Authorization": f"Bearer {FIRECRAWL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"url": url, "formats": ["markdown", "html"]},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        data = payload.get("data") or {}
        combined_text = "\n".join(
            part for part in [data.get("markdown"), data.get("html"), json.dumps(data, ensure_ascii=False)] if part
        )
        rows = parse_sunsirs_rows(combined_text, commodity_label)
        if rows:
            latest = sorted(rows, key=lambda row: row["date"])[-1]
            latest["fetch_method"] = "firecrawl"
            return latest
    except Exception:
        return None
    return None


def parse_investing_date(raw: str) -> str | None:
    try:
        return datetime.strptime(text(raw), "%b %d, %Y").strftime("%Y-%m-%d")
    except Exception:
        return None


def parse_investing_volume(raw: Any) -> float | None:
    value = text(raw).replace(",", "")
    if not value:
        return None
    multiplier = 1.0
    if value.endswith("K"):
        multiplier = 1_000.0
        value = value[:-1]
    elif value.endswith("M"):
        multiplier = 1_000_000.0
        value = value[:-1]
    elif value.endswith("B"):
        multiplier = 1_000_000_000.0
        value = value[:-1]
    value = value.replace("+", "").replace("-", "")
    try:
        return float(value) * multiplier
    except Exception:
        return None


def parse_investing_history_table(table: pd.DataFrame, kind: str) -> list[dict[str, Any]]:
    normalized = {text(col).lower(): col for col in table.columns}
    date_col = normalized.get("date")
    price_col = normalized.get("price")
    if not date_col or not price_col:
        return []
    vol_col = normalized.get("vol.")
    rows: list[dict[str, Any]] = []
    for _, row in table.iterrows():
        iso_date = parse_investing_date(row.get(date_col))
        if not iso_date:
            continue
        try:
            price = float(str(row.get(price_col)).replace(",", ""))
        except Exception:
            continue
        parsed = {
            "date": iso_date,
            "source_kind": kind,
        }
        if kind == "equity":
            parsed["close_price_inr"] = round(price, 2)
            parsed["volume"] = parse_investing_volume(row.get(vol_col)) if vol_col else None
        else:
            parsed["brent_usd_per_bbl"] = round(price, 2)
            parsed["label"] = datetime.strptime(iso_date, "%Y-%m-%d").strftime("%d %b")
        rows.append(parsed)
    return rows


def parse_investing_history_text(text_blob: str, kind: str) -> list[dict[str, Any]]:
    pattern = re.compile(
        r"\|\s*([A-Z][a-z]{2}\s+\d{2},\s+\d{4})\s*\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\|\s*([^|]*)\|\s*([+\-]?[0-9.]+%)\s*\|",
        re.M,
    )
    rows: list[dict[str, Any]] = []
    for raw_date, price, _open, _high, _low, vol, _change in pattern.findall(text_blob or ""):
        iso_date = parse_investing_date(raw_date)
        if not iso_date:
            continue
        parsed = {"date": iso_date, "source_kind": kind}
        if kind == "equity":
            parsed["close_price_inr"] = round(float(price.replace(",", "")), 2)
            parsed["volume"] = parse_investing_volume(vol)
        else:
            parsed["brent_usd_per_bbl"] = round(float(price.replace(",", "")), 2)
            parsed["label"] = datetime.strptime(iso_date, "%Y-%m-%d").strftime("%d %b")
        rows.append(parsed)
    return rows


def fetch_investing_history(url: str, kind: str) -> tuple[list[dict[str, Any]], str | None]:
    session = requests.Session()
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }
    source_id = "investing-archean-history-live" if kind == "equity" else "investing-brent-history-live"
    try:
        response = session.get(url, headers=headers, timeout=30)
        if response.ok:
            try:
                tables = pd.read_html(StringIO(response.text))
                for table in tables:
                    rows = parse_investing_history_table(table, kind)
                    if rows:
                        for row in rows:
                            row["source_id"] = source_id
                        return rows, "direct"
            except Exception:
                rows = parse_investing_history_text(response.text, kind)
                if rows:
                    for row in rows:
                        row["source_id"] = source_id
                    return rows, "direct"
    except Exception:
        pass

    if not FIRECRAWL_API_KEY:
        return [], None

    firecrawl_formats = ["markdown"] if kind == "equity" else ["markdown", "html"]
    for _ in range(2):
        try:
            response = session.post(
                "https://api.firecrawl.dev/v1/scrape",
                headers={
                    "Authorization": f"Bearer {FIRECRAWL_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={"url": url, "formats": firecrawl_formats},
                timeout=45,
            )
            response.raise_for_status()
            payload = response.json()
            data = payload.get("data") or {}
            combined_text = "\n".join(part for part in [data.get("markdown"), data.get("html")] if part)
            rows = parse_investing_history_text(combined_text, kind)
            if rows:
                for row in rows:
                    row["source_id"] = source_id
                return rows, "firecrawl"
        except Exception:
            continue
    return [], None


def merge_time_series_rows(base_rows: list[dict[str, Any]], live_rows: list[dict[str, Any]], date_key: str = "date") -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {text(row.get(date_key)): dict(row) for row in base_rows}
    for row in live_rows:
        merged[text(row.get(date_key))] = dict(row)
    return [merged[key] for key in sorted(merged.keys()) if key]


def fetch_au_investing_war_headlines(limit: int = 4) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not FIRECRAWL_API_KEY:
        return [], []
    session = requests.Session()
    try:
        response = session.post(
            "https://api.firecrawl.dev/v1/scrape",
            headers={
                "Authorization": f"Bearer {FIRECRAWL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"url": INVESTING_AU_COMMODITIES_NEWS_URL, "formats": ["markdown"]},
            timeout=45,
        )
        response.raise_for_status()
        payload = response.json()
        markdown = (payload.get("data") or {}).get("markdown", "")
    except Exception:
        return [], []

    pattern = re.compile(
        r"- \[(?P<title>[^\]]+)\]\((?P<url>https://au\.investing\.com/news/commodities-news/[^\)]+)\)\s+(?P<summary>.*?)(?:\n\s*-\s*By(?P<publisher>[^•\n]+)•(?P<age>[^\n]+))",
        re.S,
    )
    keywords = ("iran", "israel", "hormuz", "gulf", "shipping", "ceasefire", "oil", "middle east", "lebanon")
    rows: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = [
        {
            "id": "investing-au-commodities-feed-live",
            "name": "Investing.com AU Commodities News feed",
            "type": "news_feed",
            "reporting_period": datetime.now(timezone.utc).date().isoformat(),
            "published_date": datetime.now(timezone.utc).date().isoformat(),
            "fetch_date": datetime.now(timezone.utc).date().isoformat(),
            "url": INVESTING_AU_COMMODITIES_NEWS_URL,
            "local_path": None,
            "fields_extracted": [
                "latest war-linked commodities headlines",
                "headline summary",
                "publisher tag",
                "relative publish age",
            ],
        }
    ]
    seen: set[str] = set()
    for match in pattern.finditer(markdown):
        title = text(match.group("title"))
        summary = re.sub(r"\s+", " ", text(match.group("summary")))
        blob = f"{title} {summary}".lower()
        if not any(keyword in blob for keyword in keywords):
            continue
        url = text(match.group("url"))
        if not url or url in seen:
            continue
        seen.add(url)
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60] or f"headline-{len(rows)+1}"
        source_id = f"investing-au-war-news-{slug}"
        rows.append(
            {
                "title": title,
                "url": url,
                "publisher": text(match.group("publisher")) or "Investing.com / Reuters",
                "age": text(match.group("age")) or "Latest",
                "summary": summary[:220] + ("..." if len(summary) > 220 else ""),
                "source_id": source_id,
            }
        )
        sources.append(
            {
                "id": source_id,
                "name": title,
                "type": "news_article",
                "reporting_period": "Latest Investing AU commodities-news war update",
                "published_date": datetime.now(timezone.utc).date().isoformat(),
                "fetch_date": datetime.now(timezone.utc).date().isoformat(),
                "url": url,
                "local_path": None,
                "fields_extracted": [
                    "headline",
                    "summary snippet",
                    "publisher",
                    "relative publish age",
                ],
            }
        )
        if len(rows) >= limit:
            break
    return rows, sources


def build_price_module(refresh_live: bool = False) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    config = {
        "bromine": {
            "path": PRICE_FILES["bromine"],
            "date_col": "Date",
            "price_col": "Approx_Bromine_INR_per_ton",
            "source_id": "price-bromine-local-file",
            "supplement_source_id": "price-bromine-manual-apr-2026",
            "live_source_id": "sunsirs-bromine-live",
            "name": "Bromine daily INR workbook",
            "reporting_period": "Daily series through supplied workbook end date",
            "fields": ["daily date", "approx bromine INR per ton", "CNY/INR rate used", "FX note"],
            "label": "Bromine",
            "series_name": "Bromine price (Rs/ton)",
            "inputs": {"bull": 5.0, "base": 2.0, "bear": -3.0, "volatility": "8% placeholder range"},
        },
        "salt": {
            "path": PRICE_FILES["salt"],
            "date_col": "Date",
            "price_col": "Approx_INR_per_ton",
            "source_id": "price-salt-local-file",
            "live_source_id": "sunsirs-salt-live",
            "name": "Industrial salt daily INR workbook",
            "reporting_period": "Daily series through supplied workbook end date",
            "fields": ["daily date", "approx industrial salt INR per ton", "assumed unit", "CNY/INR rate used", "FX note"],
            "label": "Industrial Salt",
            "series_name": "Industrial salt price (Rs/ton)",
            "inputs": {"bull": 3.0, "base": 1.0, "bear": -2.0, "volatility": "5% placeholder range"},
        },
    }

    module = {"frequency": "weekly"}
    sources: list[dict[str, Any]] = []
    missing = False
    live_bromine_row = fetch_latest_sunsirs_row(BROMINE_LIVE_URL, "Bromine") if refresh_live else None
    live_salt_row = fetch_latest_sunsirs_row(SALT_LIVE_URL, "industrial salt") if refresh_live else None
    fx_rate, fx_rate_label = latest_cny_inr_rate() if refresh_live else (None, None)

    for key, cfg in config.items():
        path = cfg["path"]
        if not path.exists():
            missing = True
            break
        df = pd.read_excel(path, sheet_name="daily_series")
        if cfg["date_col"] not in df.columns or cfg["price_col"] not in df.columns:
            missing = True
            break
        df = df[[cfg["date_col"], cfg["price_col"]]].copy()
        df.columns = ["date", "price"]
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df["price"] = pd.to_numeric(df["price"], errors="coerce")
        supplement_applied = False
        if key == "bromine" and BROMINE_MANUAL_SUPPLEMENT:
            supplement = pd.DataFrame(BROMINE_MANUAL_SUPPLEMENT, columns=["date", "price"])
            supplement["date"] = pd.to_datetime(supplement["date"], errors="coerce")
            supplement["price"] = pd.to_numeric(supplement["price"], errors="coerce")
            df = pd.concat([df, supplement], ignore_index=True)
            supplement_applied = True
        live_applied = False
        live_row = live_bromine_row if key == "bromine" else live_salt_row if key == "salt" else None
        live_url = BROMINE_LIVE_URL if key == "bromine" else SALT_LIVE_URL if key == "salt" else None
        if live_row and fx_rate:
            live_date = pd.to_datetime(live_row["date"], errors="coerce")
            live_price_inr = float(live_row["price_cny_per_ton"]) * float(fx_rate)
            live_df = pd.DataFrame([{"date": live_date, "price": live_price_inr}])
            df = pd.concat([df, live_df], ignore_index=True)
            live_applied = True
        df = df.dropna(subset=["date", "price"]).sort_values("date")
        df = df.drop_duplicates(subset=["date"], keep="last")
        if df.empty:
            missing = True
            break
        weekly = (
            df.assign(
                week_end=df["date"].dt.to_period("W-FRI").apply(lambda p: p.end_time.normalize())
            )
            .groupby("week_end", as_index=False)
            .agg(actual_date=("date", "max"), price=("price", "last"))
            .sort_values("actual_date")
        )
        if weekly.empty:
            missing = True
            break
        latest = float(df.iloc[-1]["price"])
        previous = float(df.iloc[-2]["price"]) if len(df) > 1 else latest
        local_path = copy_price_source(path)
        sources.append(
            {
                "id": cfg["source_id"],
                "name": cfg["name"],
                "type": "local_price_workbook",
                "reporting_period": f"{df.iloc[0]['date'].strftime('%Y-%m-%d')} to {df.iloc[-1]['date'].strftime('%Y-%m-%d')}",
                "published_date": df.iloc[-1]["date"].strftime("%Y-%m-%d"),
                "fetch_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                "url": None,
                "local_path": local_path,
                "fields_extracted": cfg["fields"],
            }
        )
        if key == "bromine" and supplement_applied:
            sources.append(
                {
                    "id": cfg["supplement_source_id"],
                    "name": "Bromine manual update through 08 Apr 2026",
                    "type": "manual_price_update",
                    "reporting_period": "2026-04-02 to 2026-04-08",
                    "published_date": "2026-04-08",
                    "fetch_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                    "url": None,
                    "local_path": None,
                    "fields_extracted": ["daily date", "bromine INR per ton"],
                }
            )
        if live_applied:
            live_source = {
                "id": cfg["live_source_id"],
                "name": f"SunSirs China {cfg['label']} Spot Price (live daily pull)",
                "type": "live_price_scrape",
                "reporting_period": live_row["date"],
                "published_date": live_row["date"],
                "fetch_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                "url": live_url,
                "local_path": None,
                "fields_extracted": [
                    f"China {cfg['label'].lower()} price {round(live_row['price_cny_per_ton'], 2)} CNY/ton",
                    f"Converted with latest workbook FX {round(float(fx_rate), 3)} INR/CNY",
                    f"Implied INR price {round(float(live_price_inr), 0):,.0f} per ton",
                    f"Fetch method {live_row.get('fetch_method', 'direct')}",
                ],
            }
            sources.append(live_source)
        module[key] = {
            "label": cfg["label"],
            "series_name": cfg["series_name"],
            "source_id": cfg["live_source_id"] if live_applied else (cfg["supplement_source_id"] if key == "bromine" and supplement_applied else cfg["source_id"]),
            "source_ids": ([cfg["source_id"]] + ([cfg["supplement_source_id"]] if key == "bromine" and supplement_applied else []) + ([cfg["live_source_id"]] if live_applied else [])),
            "history": [
                {
                    "period": row["actual_date"].strftime("%d %b"),
                    "date": row["actual_date"].strftime("%Y-%m-%d"),
                    "price": round(float(row["price"]), 0),
                }
                for _, row in weekly.iterrows()
            ],
            "stats": {
                "latest": round(latest, 0),
                "change_pct": round(((latest - previous) / previous) * 100.0, 1) if previous else None,
                "high": round(float(df["price"].max()), 0),
                "low": round(float(df["price"].min()), 0),
                "latest_label": f"{df.iloc[-1]['date'].strftime('%d %b %Y')} {'SunSirs spot update' if live_applied else 'daily close'}",
                "change_label": f"vs {df.iloc[-2]['date'].strftime('%d %b %Y')}" if len(df) > 1 else "vs prior point",
                "range_label": f"{df.iloc[0]['date'].strftime('%d %b %Y')} to {df.iloc[-1]['date'].strftime('%d %b %Y')}",
                "fx_label": f"Latest workbook FX used: {round(float(fx_rate), 3)} INR/CNY on {fx_rate_label}" if live_applied and fx_rate_label else None,
                "fx_rate": round(float(fx_rate), 3) if fx_rate else None,
            },
            "inputs": {
                "startingPrice": f"Rs {round(latest, 0):,.0f}/ton",
                "lookback": f"{len(weekly)} weekly points",
                "bullGrowth": f"+{cfg['inputs']['bull']:.1f}% per quarter",
                "baseGrowth": f"+{cfg['inputs']['base']:.1f}% per quarter",
                "bearGrowth": f"{cfg['inputs']['bear']:.1f}% per quarter",
                "volatility": cfg["inputs"]["volatility"],
                "bull_growth_pct": cfg["inputs"]["bull"],
                "base_growth_pct": cfg["inputs"]["base"],
                "bear_growth_pct": cfg["inputs"]["bear"],
            },
        }
    if missing:
        return fallback_price_module(), []
    return module, sources


def load_sources() -> list[dict[str, Any]]:
    return read_json(MANUAL_DIR / "source_registry.json", [])


def build_source_excerpt(path: Path, limit: int = 28) -> str:
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    cleaned = [line.strip() for line in lines if line.strip()]
    return "\n".join(cleaned[:limit]) if cleaned else ""


def enrich_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    for source in sources:
        item = dict(source)
        local_path = text(item.get("local_path"))
        if local_path:
            doc_path = ROOT / local_path
            if doc_path.exists():
                item["local_doc_url"] = f"./source_docs/{doc_path.name}"
                text_path = CACHE_DIR / "extracted_text" / f"{doc_path.stem}.txt"
                if text_path.exists():
                    item["local_text_url"] = f"./source_text/{text_path.name}"
                    item["excerpt"] = build_source_excerpt(text_path)
        enriched.append(item)
    return enriched


def load_assumptions() -> dict[str, Any]:
    return read_json(MANUAL_DIR / "forecast_assumptions.json", {})


def load_methodology() -> dict[str, str]:
    return {
        "methodology_markdown": (MANUAL_DIR / "methodology.md").read_text(encoding="utf-8"),
        "data_dictionary_markdown": (MANUAL_DIR / "data_dictionary.md").read_text(encoding="utf-8"),
    }


def build_event_trade_context(trade_cache: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    trade_rows = trade_cache["trade_bromine_country"]
    import_dependency: list[dict[str, Any]] = []
    trade_balance: list[dict[str, Any]] = []
    for year in (2022, 2023, 2024):
        imports = [row for row in trade_rows if row["year"] == year and row["importer_country"] == "India"]
        exports = [row for row in trade_rows if row["year"] == year and row["exporter_country"] == "India"]
        world_import = next((row for row in imports if row["exporter_country"] == "World"), None)
        world_export = next((row for row in exports if row["importer_country"] == "World"), None)
        israel = next((row for row in imports if row["exporter_country"] == "Israel"), None)
        jordan = next((row for row in imports if row["exporter_country"] == "Jordan"), None)
        israel_value = israel["trade_value_usd"] if israel else 0.0
        jordan_value = jordan["trade_value_usd"] if jordan else 0.0
        world_value = world_import["trade_value_usd"] if world_import else 0.0
        import_dependency.append(
            {
                "year": year,
                "israel_usd_mn": round(israel_value / 1_000_000, 2),
                "jordan_usd_mn": round(jordan_value / 1_000_000, 2),
                "other_usd_mn": round(max(world_value - israel_value - jordan_value, 0.0) / 1_000_000, 2),
                "israel_share_pct": round((israel_value / world_value) * 100.0, 1) if world_value else None,
                "jordan_share_pct": round((jordan_value / world_value) * 100.0, 1) if world_value else None,
                "other_share_pct": round((max(world_value - israel_value - jordan_value, 0.0) / world_value) * 100.0, 1) if world_value else None,
                "israel_jordan_share_pct": round(((israel_value + jordan_value) / world_value) * 100.0, 1) if world_value else None,
                "source_id": f"wits-ind-bromine-{year}-import",
            }
        )
        trade_balance.append(
            {
                "year": year,
                "imports_usd_mn": round((world_import["trade_value_usd"] if world_import else 0.0) / 1_000_000, 2),
                "exports_usd_mn": round((world_export["trade_value_usd"] if world_export else 0.0) / 1_000_000, 2),
                "net_exports_usd_mn": round((((world_export["trade_value_usd"] if world_export else 0.0) - (world_import["trade_value_usd"] if world_import else 0.0)) / 1_000_000), 2),
                "source_id": f"wits-ind-bromine-{year}-export",
            }
        )
    return import_dependency, trade_balance


def build_event_2025(
    segment_rows: list[dict[str, Any]],
    financials: list[dict[str, Any]],
    trade_cache: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    bromine_segments = [
        row for row in segment_rows
        if row["product_segment"] == "Bromine" and row["period"] in {"Q3FY25", "Q1FY26", "Q2FY26", "Q3FY26"}
    ]
    bromine_segments.sort(key=lambda item: quarter_sort_key(item["period"]))
    consolidated = [
        row for row in financials
        if row["reported_basis"] == "consolidated" and row["period"] in {"Q4FY25", "Q1FY26", "Q2FY26", "Q3FY26"}
    ]
    consolidated.sort(key=lambda item: quarter_sort_key(item["period"]))

    price_window = IRAN_ISRAEL_WAR_2025["share_price_window"]
    price_before = next((row for row in price_window if row["date"] == "2025-06-12"), price_window[0])
    price_ceasefire = next((row for row in price_window if row["date"] == "2025-06-24"), price_window[-1])
    price_recovery = next((row for row in price_window if row["date"] == "2025-06-30"), price_window[-1])
    price_low = min(price_window, key=lambda row: row["close_price_inr"])

    import_dependency, trade_balance = build_event_trade_context(trade_cache)

    share_move_to_ceasefire = round(((price_ceasefire["close_price_inr"] - price_before["close_price_inr"]) / price_before["close_price_inr"]) * 100.0, 1)
    share_move_to_recovery = round(((price_recovery["close_price_inr"] - price_before["close_price_inr"]) / price_before["close_price_inr"]) * 100.0, 1)
    low_drawdown = round(((price_low["close_price_inr"] - price_before["close_price_inr"]) / price_before["close_price_inr"]) * 100.0, 1)

    q3fy25_brom = next(row for row in bromine_segments if row["period"] == "Q3FY25")
    q1fy26_brom = next(row for row in bromine_segments if row["period"] == "Q1FY26")
    q3fy26_brom = next(row for row in bromine_segments if row["period"] == "Q3FY26")
    q4fy25_margin = next(row for row in consolidated if row["period"] == "Q4FY25")
    q1fy26_margin = next(row for row in consolidated if row["period"] == "Q1FY26")
    q3fy26_margin = next(row for row in consolidated if row["period"] == "Q3FY26")

    before_after = [
        {
            "metric": "Archean share price",
            "before": f"Rs {price_before['close_price_inr']}",
            "event_window": f"Rs {price_ceasefire['close_price_inr']}",
            "after": f"Rs {price_recovery['close_price_inr']}",
            "change_read": f"{share_move_to_ceasefire}% by ceasefire, {share_move_to_recovery}% by month-end",
            "source_id": "equitypandit-aci-history",
        },
        {
            "metric": "Bromine sales volume",
            "before": f"{round(q3fy25_brom['volume_tons'], 0)} tons in Q3FY25",
            "event_window": f"{round(q1fy26_brom['volume_tons'], 0)} tons in Q1FY26",
            "after": f"{round(q3fy26_brom['volume_tons'], 0)} tons in Q3FY26",
            "change_read": f"{round(((q3fy26_brom['volume_tons'] - q1fy26_brom['volume_tons']) / q1fy26_brom['volume_tons']) * 100.0, 1)}% versus Q1FY26",
            "source_id": q3fy26_brom["source_id"],
        },
        {
            "metric": "Bromine realization",
            "before": f"Rs {round(q3fy25_brom['implied_realization_per_ton'], 0)} per ton",
            "event_window": f"Rs {round(q1fy26_brom['implied_realization_per_ton'], 0)} per ton",
            "after": f"Rs {round(q3fy26_brom['implied_realization_per_ton'], 0)} per ton",
            "change_read": f"+{round(((q3fy26_brom['implied_realization_per_ton'] - q1fy26_brom['implied_realization_per_ton']) / q1fy26_brom['implied_realization_per_ton']) * 100.0, 1)}% versus Q1FY26",
            "source_id": q3fy26_brom["source_id"],
        },
        {
            "metric": "Consolidated EBITDA margin",
            "before": f"{round(q4fy25_margin['ebitda_margin'], 1)}% in Q4FY25",
            "event_window": f"{round(q1fy26_margin['ebitda_margin'], 1)}% in Q1FY26",
            "after": f"{round(q3fy26_margin['ebitda_margin'], 1)}% in Q3FY26",
            "change_read": f"{round((q3fy26_margin['ebitda_margin'] - q1fy26_margin['ebitda_margin']) * 100, 0)} bps versus Q1FY26",
            "source_id": q3fy26_margin["source_id"],
        },
        {
            "metric": "India bromine import dependence on Israel + Jordan",
            "before": f"{import_dependency[0]['israel_jordan_share_pct']}% in 2022",
            "event_window": f"{import_dependency[-1]['israel_jordan_share_pct']}% in 2024",
            "after": "2025 annual India import page still blank",
            "change_read": "Direct post-war customs shift cannot yet be verified from official annual India data",
            "source_id": "wits-ind-bromine-2024-import",
        },
        {
            "metric": "What management said",
            "before": "No pre-war repivot signal disclosed",
            "event_window": "Demand stable, no immediate upside",
            "after": "Customers did not dramatically change sourcing toward India",
            "change_read": "Company commentary points to internal output limits as the bigger issue",
            "source_id": "archean-q3fy26-transcript",
        },
    ]

    summary_table = [
        {"label": "Conflict window", "value": IRAN_ISRAEL_WAR_2025["analysis_window_label"], "source_id": "cfr-iran-israel-july-2025"},
        {"label": "ACI share-price move to ceasefire", "value": f"{share_move_to_ceasefire}%", "source_id": "equitypandit-aci-history"},
        {"label": "Deepest event-window drawdown", "value": f"{low_drawdown}%", "source_id": "equitypandit-aci-history"},
        {"label": "Israel + Jordan share of India bromine imports", "value": f"{import_dependency[-1]['israel_jordan_share_pct']}% in CY2024", "source_id": "wits-ind-bromine-2024-import"},
        {"label": "Q1FY26 Archean bromine realization", "value": f"Rs {round(q1fy26_brom['implied_realization_per_ton'], 0)}/ton", "source_id": q1fy26_brom["source_id"]},
        {"label": "Q3FY26 Archean bromine volume", "value": f"{round(q3fy26_brom['volume_tons'], 0)} tons", "source_id": q3fy26_brom["source_id"]},
    ]

    summary_table_name = "event_iran_israel_2025_summary"
    timeline_table_name = "event_iran_israel_2025_timeline"
    event_page = {
        **IRAN_ISRAEL_WAR_2025,
        "summary_table_name": summary_table_name,
        "timeline_table_name": timeline_table_name,
        "share_price_move_to_ceasefire_pct": share_move_to_ceasefire,
        "share_price_move_to_month_end_pct": share_move_to_recovery,
        "share_price_low_drawdown_pct": low_drawdown,
        "import_dependency": import_dependency,
        "trade_balance": trade_balance,
        "archean_bromine_quarters": bromine_segments,
        "archean_margin_quarters": consolidated,
        "before_after": before_after,
        "summary_table": summary_table,
        "hero_metrics": [
            {"label": "Conflict window", "value": IRAN_ISRAEL_WAR_2025["analysis_window_label"], "note": "Completed event window used for this page", "source_id": "cfr-iran-israel-july-2025"},
            {"label": "ACI move to ceasefire", "value": f"{share_move_to_ceasefire}%", "note": "From Jun 12 close to Jun 24 close", "source_id": "equitypandit-aci-history"},
            {"label": "Deepest drawdown", "value": f"{low_drawdown}%", "note": "Lowest close during the event window", "source_id": "equitypandit-aci-history"},
            {"label": "Israel + Jordan import share", "value": f"{import_dependency[-1]['israel_jordan_share_pct']}%", "note": "Share of India's bromine imports in CY2024", "source_id": "wits-ind-bromine-2024-import"},
        ],
        "hero_updates": [
            {"text": "Archean said it had not heard any significant customer shift from Israel to India and saw no immediate upside from the conflict.", "source_id": "archean-q3fy26-transcript"},
            {"text": "ICL's Industrial Products business stayed relatively stable through 2025, which argues against a major physical bromine supply collapse in Israel.", "source_id": "icl-q3-2025-results"},
            {"text": "India's bromine import dependence on Israel and Jordan was already above 90% in CY2024, so the exposure was real even before the war.", "source_id": "wits-ind-bromine-2024-import"},
        ],
    }
    return event_page, {summary_table_name: before_after, timeline_table_name: IRAN_ISRAEL_WAR_2025["timeline"]}


def build_event_2026_current(
    segment_rows: list[dict[str, Any]],
    financials: list[dict[str, Any]],
    trade_cache: dict[str, Any],
    refresh_live: bool = False,
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    bromine_segments = [
        row for row in segment_rows
        if row["product_segment"] == "Bromine" and row["period"] in {"Q3FY25", "Q1FY26", "Q2FY26", "Q3FY26"}
    ]
    bromine_segments.sort(key=lambda item: quarter_sort_key(item["period"]))
    consolidated = [
        row for row in financials
        if row["reported_basis"] == "consolidated" and row["period"] in {"Q4FY25", "Q1FY26", "Q2FY26", "Q3FY26"}
    ]
    consolidated.sort(key=lambda item: quarter_sort_key(item["period"]))

    import_dependency, trade_balance = build_event_trade_context(trade_cache)
    import_2024 = next((row for row in import_dependency if row["year"] == 2024), import_dependency[-1])
    live_sources: list[dict[str, Any]] = []
    live_timeline: list[dict[str, Any]] = []
    price_window = list(IRAN_ISRAEL_WAR_2026_CURRENT["share_price_window"])
    oil_window = list(IRAN_ISRAEL_WAR_2026_CURRENT["oil_shock_window"])
    if refresh_live:
        live_share_rows, share_method = fetch_investing_history(INVESTING_ARCHEAN_URL, "equity")
        live_oil_rows, oil_method = fetch_investing_history(INVESTING_BRENT_URL, "oil")
        if live_share_rows:
            price_window = merge_time_series_rows(price_window, [row for row in live_share_rows if row["date"] >= "2026-02-20"])
            latest_share = price_window[-1]
            live_sources.append(
                {
                    "id": "investing-archean-history-live",
                    "name": "Investing.com Archean Chemical Industries historical data",
                    "type": "market_price_history",
                    "reporting_period": f"Daily prices through {latest_share['date']}",
                    "published_date": latest_share["date"],
                    "fetch_date": datetime.now(timezone.utc).date().isoformat(),
                    "url": INVESTING_ARCHEAN_URL,
                    "local_path": None,
                    "fields_extracted": [
                        "daily close price",
                        "daily volume",
                        f"refresh method: {share_method or 'unknown'}",
                    ],
                }
            )
        if live_oil_rows:
            oil_window = merge_time_series_rows(oil_window, [row for row in live_oil_rows if row["date"] >= "2026-02-20"])
            latest_oil = oil_window[-1]
            live_sources.append(
                {
                    "id": "investing-brent-history-live",
                    "name": "Investing.com Brent Oil historical data",
                    "type": "market_price_history",
                    "reporting_period": f"Daily prices through {latest_oil['date']}",
                    "published_date": latest_oil["date"],
                    "fetch_date": datetime.now(timezone.utc).date().isoformat(),
                    "url": INVESTING_BRENT_URL,
                    "local_path": None,
                    "fields_extracted": [
                        "daily Brent close",
                        f"refresh method: {oil_method or 'unknown'}",
                    ],
                }
            )
        live_headlines, headline_sources = fetch_au_investing_war_headlines()
        if headline_sources:
            live_sources.extend(headline_sources)
        for row in live_headlines:
            live_timeline.append(
                {
                    "date": datetime.now(timezone.utc).date().isoformat(),
                    "title": row["title"],
                    "detail": f"Investing AU commodities news: {row['summary']}",
                    "source_id": row["source_id"],
                }
            )
    else:
        live_headlines = []

    price_before = next((row for row in price_window if row["date"] == "2026-02-26"), price_window[0])
    price_first = next((row for row in price_window if row["date"] == "2026-03-02"), price_window[0])
    price_latest = price_window[-1]
    price_low = min(price_window, key=lambda row: row["close_price_inr"])
    oil_before = next((row for row in oil_window if row["date"] == "2026-02-20"), oil_window[0])
    oil_first = next((row for row in oil_window if row["date"] == "2026-03-02"), oil_window[1])
    oil_latest = oil_window[-1]
    oil_peak = max(oil_window, key=lambda row: row["brent_usd_per_bbl"])

    bromine_proxy = IRAN_ISRAEL_WAR_2026_CURRENT["bromine_price_proxy"]
    global_feb = next(row for row in bromine_proxy if row["market"] == "Global bromine index" and row["period"] == "Feb 2026")
    global_mar = next(row for row in bromine_proxy if row["market"] == "Global bromine index" and row["period"] == "Mar 2026")
    me_feb = next(row for row in bromine_proxy if row["market"] == "Middle East bromine index" and row["period"] == "Feb 2026")
    me_mar = next(row for row in bromine_proxy if row["market"] == "Middle East bromine index" and row["period"] == "Mar 2026")
    shipping_rows = IRAN_ISRAEL_WAR_2026_CURRENT["shipping_stress"]
    q1fy26_brom = next(row for row in bromine_segments if row["period"] == "Q1FY26")
    q3fy26_brom = next(row for row in bromine_segments if row["period"] == "Q3FY26")
    q3fy26_margin = next(row for row in consolidated if row["period"] == "Q3FY26")

    share_move_first = round(((price_first["close_price_inr"] - price_before["close_price_inr"]) / price_before["close_price_inr"]) * 100.0, 1)
    share_move_latest = round(((price_latest["close_price_inr"] - price_before["close_price_inr"]) / price_before["close_price_inr"]) * 100.0, 1)
    low_drawdown = round(((price_low["close_price_inr"] - price_before["close_price_inr"]) / price_before["close_price_inr"]) * 100.0, 1)
    oil_first_jump = round(((oil_first["brent_usd_per_bbl"] - oil_before["brent_usd_per_bbl"]) / oil_before["brent_usd_per_bbl"]) * 100.0, 1)
    oil_peak_jump = round(((oil_peak["brent_usd_per_bbl"] - oil_before["brent_usd_per_bbl"]) / oil_before["brent_usd_per_bbl"]) * 100.0, 1)
    global_bromine_move = round(((global_mar["price_usd_per_kg"] - global_feb["price_usd_per_kg"]) / global_feb["price_usd_per_kg"]) * 100.0, 1)
    me_bromine_move = round(((me_mar["price_usd_per_kg"] - me_feb["price_usd_per_kg"]) / me_feb["price_usd_per_kg"]) * 100.0, 1)

    before_after = [
        {
            "metric": "Archean share price",
            "before": f"Rs {price_before['close_price_inr']} on Feb 26",
            "event_window": f"Rs {price_first['close_price_inr']} on Mar 2",
            "after": f"Rs {price_latest['close_price_inr']} on {datetime.strptime(price_latest['date'], '%Y-%m-%d').strftime('%b %d')}",
            "change_read": f"{share_move_first}% on the first war session, {low_drawdown}% at the low, {share_move_latest}% by the latest accessible close",
            "source_id": price_latest.get("source_id", "equitypandit-aci-history"),
        },
        {
            "metric": "Brent crude",
            "before": f"${oil_before['brent_usd_per_bbl']}/bbl on Feb 20",
            "event_window": f"${oil_first['brent_usd_per_bbl']}/bbl on Mar 2",
            "after": f"${oil_latest['brent_usd_per_bbl']}/bbl on {datetime.strptime(oil_latest['date'], '%Y-%m-%d').strftime('%b %d')}",
            "change_read": f"+{oil_first_jump}% immediately, +{oil_peak_jump}% to the peak, latest close ${oil_latest['brent_usd_per_bbl']}/bbl",
            "source_id": oil_latest.get("source_id", "reuters-oil-energy-facilities-mar19-2026"),
        },
        {
            "metric": "Bromine price proxy",
            "before": f"${global_feb['price_usd_per_kg']}/kg global in Feb 2026",
            "event_window": f"${global_mar['price_usd_per_kg']}/kg global in Mar 2026",
            "after": f"${me_mar['price_usd_per_kg']}/kg Middle East in Mar 2026",
            "change_read": f"Global bromine proxy only moved +{global_bromine_move}% month on month, while the Middle East proxy moved {me_bromine_move}%",
            "source_id": "businessanalytiq-bromine-mar-2026",
        },
        {
            "metric": "Shipping and insurance shock",
            "before": "Normal Hormuz traffic before Feb 28",
            "event_window": "150 ships stranded by Mar 2",
            "after": "Traffic down 97% and U.S. reinsurance support at USD 20 bn by mid-March",
            "change_read": "Logistics stress moved much more than bromine price itself",
            "source_id": "reuters-hormuz-closure-2026",
        },
        {
            "metric": "India bromine import dependence",
            "before": f"{import_2024['israel_share_pct']}% from Israel and {import_2024['jordan_share_pct']}% from Jordan in CY2024",
            "event_window": f"{import_2024['israel_jordan_share_pct']}% combined pre-war dependence",
            "after": "2026 customs shift is still not published",
            "change_read": "Import exposure is measurable; post-war rerouting is not yet measurable from official trade tables",
            "source_id": "wits-ind-bromine-2024-import",
        },
        {
            "metric": "Archean margin exposure",
            "before": f"{OVERVIEW_FACTS['export_share_pct']}% export mix and {q3fy26_margin['ebitda_margin']}% EBITDA margin in the latest reported quarter",
            "event_window": f"Bromine volume was already down to {round(q3fy26_brom['volume_tons'], 0)} tons in Q3FY26",
            "after": "No post-war reported quarter yet",
            "change_read": "The current war can help only if Archean has output to sell and contracts can reprice faster than freight and energy costs rise",
            "source_id": "archean-q3fy26-presentation",
        },
    ]

    summary_table_name = "event_iran_israel_2026_current_summary"
    timeline_table_name = "event_iran_israel_2026_current_timeline"
    event_page = {
        **IRAN_ISRAEL_WAR_2026_CURRENT,
        "summary_table_name": summary_table_name,
        "timeline_table_name": timeline_table_name,
        "share_price_move_first_session_pct": share_move_first,
        "share_price_move_latest_pct": share_move_latest,
        "share_price_low_drawdown_pct": low_drawdown,
        "brent_first_jump_pct": oil_first_jump,
        "brent_peak_jump_pct": oil_peak_jump,
        "global_bromine_proxy_move_pct": global_bromine_move,
        "me_bromine_proxy_move_pct": me_bromine_move,
        "import_dependency": import_dependency,
        "trade_balance": trade_balance,
        "archean_bromine_quarters": bromine_segments,
        "archean_margin_quarters": consolidated,
        "before_after": before_after,
        "hero_metrics": [
            {"label": "Latest ACI close", "value": f"Rs {round(price_latest['close_price_inr'], 2)}", "note": f"As of {datetime.strptime(price_latest['date'], '%Y-%m-%d').strftime('%b %d')}", "source_id": price_latest.get("source_id", "equitypandit-aci-history")},
            {"label": "Latest Brent close", "value": f"${round(oil_latest['brent_usd_per_bbl'], 2)}/bbl", "note": f"As of {datetime.strptime(oil_latest['date'], '%Y-%m-%d').strftime('%b %d')}", "source_id": oil_latest.get("source_id", "reuters-oil-energy-facilities-mar19-2026")},
            {"label": "ACI since pre-war close", "value": f"{share_move_latest}%", "note": f"From Feb 26 to latest accessible close on {datetime.strptime(price_latest['date'], '%Y-%m-%d').strftime('%b %d')}", "source_id": price_latest.get("source_id", "equitypandit-aci-history")},
            {"label": "Fresh war headlines", "value": len(live_headlines), "note": "Loaded by the refresh button from Investing AU", "source_id": "investing-au-commodities-feed-live" if live_headlines else "reuters-hormuz-closure-2026"},
        ],
        "hero_updates": [
            {"text": f"ACI fell {abs(share_move_first)}% on the first war session and {abs(low_drawdown)}% at the low, and the latest accessible close on {datetime.strptime(price_latest['date'], '%Y-%m-%d').strftime('%b %d')} is {share_move_latest}% versus the pre-war close.", "source_id": price_latest.get("source_id", "equitypandit-aci-history")},
            {"text": f"Brent crude rose from ${oil_before['brent_usd_per_bbl']}/bbl before the war to ${oil_peak['brent_usd_per_bbl']}/bbl at the peak, and the latest accessible close on {datetime.strptime(oil_latest['date'], '%Y-%m-%d').strftime('%b %d')} is ${oil_latest['brent_usd_per_bbl']}/bbl while the March bromine price proxy moved only {global_bromine_move}% month on month.", "source_id": oil_latest.get("source_id", "reuters-oil-energy-facilities-mar19-2026")},
            {"text": "India still depended on Israel and Jordan for 91.9% of bromine imports in the latest reliable full year, but official 2026 customs data is not yet published.", "source_id": "wits-ind-bromine-2024-import"},
        ],
        "live_market_headlines": live_headlines,
        "data_cutoff_label": f"Latest accessible market cut-off: {datetime.strptime(price_latest['date'], '%Y-%m-%d').strftime('%B %d, %Y')} for Archean share price; {datetime.strptime(oil_latest['date'], '%Y-%m-%d').strftime('%B %d, %Y')} for Brent oil.",
        "share_price_source_ids": list(dict.fromkeys(row.get("source_id") for row in price_window if row.get("source_id"))),
        "oil_price_source_ids": list(dict.fromkeys(row.get("source_id") for row in oil_window if row.get("source_id"))),
        "share_price_window": price_window,
        "oil_shock_window": oil_window,
    }
    if price_latest["date"] > "2026-03-24":
        event_page["timeline"] = [*IRAN_ISRAEL_WAR_2026_CURRENT["timeline"], {
            "date": price_latest["date"],
            "title": "Latest live Archean market read",
            "detail": f"Investing historical data shows Archean at Rs {price_latest['close_price_inr']} on {datetime.strptime(price_latest['date'], '%Y-%m-%d').strftime('%B %d, %Y')}.",
            "source_id": price_latest.get("source_id", "equitypandit-aci-history"),
        }]
    if oil_latest["date"] > "2026-03-19":
        event_page["timeline"] = event_page.get("timeline", [*IRAN_ISRAEL_WAR_2026_CURRENT["timeline"]]) + [{
            "date": oil_latest["date"],
            "title": "Latest live Brent checkpoint",
            "detail": f"Investing historical data shows Brent at ${oil_latest['brent_usd_per_bbl']}/bbl on {datetime.strptime(oil_latest['date'], '%Y-%m-%d').strftime('%B %d, %Y')}.",
            "source_id": oil_latest.get("source_id", "reuters-oil-energy-facilities-mar19-2026"),
        }] 
    if live_timeline:
        event_page["timeline"] = event_page.get("timeline", [*IRAN_ISRAEL_WAR_2026_CURRENT["timeline"]]) + live_timeline
    return event_page, {summary_table_name: before_after, timeline_table_name: event_page.get("timeline", IRAN_ISRAEL_WAR_2026_CURRENT["timeline"])}, live_sources


def build_event_library(
    segment_rows: list[dict[str, Any]],
    financials: list[dict[str, Any]],
    trade_cache: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    current_event, current_tables, current_sources = build_event_2026_current(segment_rows, financials, trade_cache, refresh_live=trade_cache.get("_refresh_live", False))
    historical_event, historical_tables = build_event_2025(segment_rows, financials, trade_cache)
    event_tables = {}
    event_tables.update(current_tables)
    event_tables.update(historical_tables)
    return {
        "default_event_id": current_event["id"],
        "items": [current_event, historical_event],
    }, event_tables, current_sources


def build_dashboard_payload(refresh_live: bool) -> dict[str, Any]:
    segment_rows = compute_segment_metrics(COMPANY_SEGMENT_METRICS)
    market_cache = load_market_cache(refresh_live)
    trade_summary = build_trade_summary(market_cache)
    macro_rows = build_macro_rows(market_cache)
    model_rows, sensitivity = build_model_output(segment_rows, load_assumptions())
    market_cache["_refresh_live"] = refresh_live
    event_library, event_tables, event_sources = build_event_library(segment_rows, COMPANY_QUARTERLY_FINANCIALS, market_cache)
    price_module, price_sources = build_price_module(refresh_live)
    latest_brom = next(row for row in segment_rows if row["period"] == "Q3FY26" and row["product_segment"] == "Bromine")
    latest_salt = next(row for row in segment_rows if row["period"] == "Q3FY26" and row["product_segment"] == "Industrial Salt")
    q3_fin = next(row for row in COMPANY_QUARTERLY_FINANCIALS if row["period"] == "Q3FY26" and row["reported_basis"] == "consolidated")

    dashboard = {
        "meta": {
            "build_id": datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "title": COMPANY["display_name"],
            "latest_period": COMPANY["latest_period"],
            "latest_update_label": COMPANY["latest_update_label"],
            "refresh_mode": "live" if refresh_live else "cached",
        },
        "company": COMPANY,
        "overview": {
            "facts": OVERVIEW_FACTS,
            "business_map": build_business_map(),
            "mix_history": OVERVIEW_REVENUE_MIX_HISTORY,
            "snapshots": build_snapshots(COMPANY_QUARTERLY_FINANCIALS, segment_rows),
            "kpis": [
                {"label": "Bromine volume", "value": latest_brom["volume_tons"], "unit": "tons", "source_id": latest_brom["source_id"]},
                {"label": "Bromine realization", "value": round(latest_brom["implied_realization_per_ton"], 0), "unit": "Rs/ton", "source_id": latest_brom["source_id"]},
                {"label": "Industrial salt volume", "value": latest_salt["volume_tons"], "unit": "tons", "source_id": latest_salt["source_id"]},
                {"label": "Industrial salt realization", "value": round(latest_salt["implied_realization_per_ton"], 1), "unit": "Rs/ton", "source_id": latest_salt["source_id"]},
                {"label": "Consolidated EBITDA margin", "value": q3_fin["ebitda_margin"], "unit": "%", "source_id": q3_fin["source_id"]},
                {"label": "Acume utilization", "value": "30-40", "unit": "%", "source_id": "archean-q3fy26-transcript"},
                {"label": "Bromine backlog", "value": OVERVIEW_FACTS["bromine_backlog_tons"], "unit": "tons", "source_id": "archean-q3fy26-transcript"},
                {
                    "label": "India bromine trade position",
                    "value": "Net importer",
                    "unit": "",
                    "source_id": trade_summary.get("bromine_latest_reliable_import_source_id", "wits-ind-bromine-2024-import"),
                },
            ],
        },
        "tables": {
            "company_quarterly_financials": COMPANY_QUARTERLY_FINANCIALS,
            "company_segment_metrics": segment_rows,
            "company_capacity_utilization": COMPANY_CAPACITY_UTILIZATION,
            "plant_asset_register": PLANT_ASSET_REGISTER,
            "company_capex_projects": COMPANY_CAPEX_PROJECTS,
            "company_subsidiaries_and_investments": COMPANY_SUBSIDIARIES_AND_INVESTMENTS,
            "trade_bromine_country": market_cache["trade_bromine_country"],
            "trade_salt_country": market_cache["trade_salt_country"],
            "peer_metrics": PEER_METRICS,
            "macro_and_cost_proxies": macro_rows,
            "customer_disclosure": CUSTOMER_DISCLOSURE,
            **event_tables,
            "model_output": model_rows,
        },
        "trade_summary": trade_summary,
        "events": event_library,
        "market_context": market_cache["market_context"],
        "peer_context": PEER_METRICS,
        "price_module": price_module,
        "sensitivity": sensitivity,
        "forecast_assumptions": load_assumptions(),
        "methodology": load_methodology(),
        "sources": enrich_sources(load_sources() + price_sources + event_sources),
    }
    return dashboard


def write_sqlite(dashboard: dict[str, Any]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()
    conn = sqlite3.connect(DB_PATH)
    try:
        for table_name, rows in dashboard["tables"].items():
            serialized_rows = []
            for row in rows:
                serialized_rows.append(
                    {
                        key: json.dumps(value, ensure_ascii=False) if isinstance(value, (list, dict)) else value
                        for key, value in row.items()
                    }
                )
            pd.DataFrame(serialized_rows).to_sql(table_name, conn, if_exists="replace", index=False)
    finally:
        conn.close()


def write_csv_exports(dashboard: dict[str, Any]) -> None:
    DIST_EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    for table_name, rows in dashboard["tables"].items():
        if not rows:
            continue
        fieldnames = list(dict.fromkeys(key for row in rows for key in row.keys()))
        serialized_rows = []
        for row in rows:
            serialized_rows.append(
                {
                    key: json.dumps(row.get(key), ensure_ascii=False) if isinstance(row.get(key), (list, dict)) else row.get(key)
                    for key in fieldnames
                }
            )
        with (DIST_EXPORTS_DIR / f"{table_name}.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(serialized_rows)


def render_index(build_id: str, title: str) -> None:
    template = (SRC_DIR / "index.template.html").read_text(encoding="utf-8")
    rendered = template.replace("__BUILD_TOKEN__", build_id).replace("__APP_TITLE__", title)
    (DIST_DIR / "index.html").write_text(rendered, encoding="utf-8")


def copy_assets() -> None:
    DIST_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SRC_DIR / "app.css", DIST_ASSETS_DIR / "app.css")
    shutil.copy2(SRC_DIR / "app.js", DIST_ASSETS_DIR / "app.js")
    shutil.copy2(SRC_DIR / "vendor" / "echarts.min.js", DIST_ASSETS_DIR / "echarts.min.js")


def write_supporting_files(dashboard: dict[str, Any]) -> None:
    DIST_DATA_DIR.mkdir(parents=True, exist_ok=True)
    write_json(DIST_DATA_DIR / "dashboard.json", dashboard)
    write_json(DIST_DATA_DIR / "source_registry.json", dashboard["sources"])
    write_json(DIST_DATA_DIR / "forecast_assumptions.json", dashboard["forecast_assumptions"])
    (DIST_DATA_DIR / "methodology.md").write_text(dashboard["methodology"]["methodology_markdown"], encoding="utf-8")
    (DIST_DATA_DIR / "data_dictionary.md").write_text(dashboard["methodology"]["data_dictionary_markdown"], encoding="utf-8")
    DIST_SOURCE_DOCS_DIR.mkdir(parents=True, exist_ok=True)
    DIST_SOURCE_TEXT_DIR.mkdir(parents=True, exist_ok=True)
    seen_docs: set[str] = set()
    seen_text: set[str] = set()
    for source in dashboard.get("sources", []):
        local_path = text(source.get("local_path"))
        if not local_path:
            continue
        doc_path = ROOT / local_path
        if doc_path.exists() and doc_path.name not in seen_docs:
            shutil.copy2(doc_path, DIST_SOURCE_DOCS_DIR / doc_path.name)
            seen_docs.add(doc_path.name)
        text_path = CACHE_DIR / "extracted_text" / f"{doc_path.stem}.txt"
        if text_path.exists() and text_path.name not in seen_text:
            shutil.copy2(text_path, DIST_SOURCE_TEXT_DIR / text_path.name)
            seen_text.add(text_path.name)


def write_manifest(dashboard: dict[str, Any]) -> None:
    write_json(
        DIST_DIR / "build-manifest.json",
        {
            "build_id": dashboard["meta"]["build_id"],
            "generated_at": dashboard["meta"]["generated_at"],
            "files": {
                "index": "dist/index.html",
                "dashboard": "dist/data/dashboard.json",
                "sqlite": str(DB_PATH.relative_to(ROOT)),
                "exports": "dist/data/exports/",
            },
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh-live", action="store_true", help="Refresh WITS-based trade tables.")
    args = parser.parse_args()

    dashboard = build_dashboard_payload(refresh_live=args.refresh_live)
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    write_sqlite(dashboard)
    render_index(dashboard["meta"]["build_id"], dashboard["meta"]["title"])
    copy_assets()
    write_supporting_files(dashboard)
    write_csv_exports(dashboard)
    write_manifest(dashboard)
    print(f"Built Archean dashboard bundle at {DIST_DIR}")
    print(f"SQLite cache: {DB_PATH}")
    print(f"Refresh mode: {'live' if args.refresh_live else 'cached'}")


if __name__ == "__main__":
    main()
