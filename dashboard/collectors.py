from __future__ import annotations

import csv
import html
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import STATE_REGISTRATION_TYPE_MAP


@dataclass
class CollectionResult:
    name: str
    status: str
    items: list[dict[str, Any]]
    message: str
    meta: dict[str, Any] | None = None


def collect_vahan_imports(directory: Path) -> CollectionResult:
    items: list[dict[str, Any]] = []
    csv_files = sorted(
        path
        for path in directory.glob("*.csv")
        if path.is_file() and path.name.lower() != "sample_vahan_template.csv"
    )
    if not csv_files:
        return CollectionResult(
            name="Vahan",
            status="warning",
            items=[],
            message="No validated Vahan CSV imports were found in data/vahan.",
        )

    for csv_path in csv_files:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row_number, row in enumerate(reader, start=2):
                month = _pick(row, "month", "month_name", "report_month")
                maker = _pick(row, "maker", "oem", "brand", "manufacturer")
                category = _pick(row, "category", "vehicle_category", "segment")
                registrations = _pick(row, "registrations", "retail", "sales", "units", "volume")
                if not month or not maker or not category or not registrations:
                    continue

                units = _safe_int(registrations)
                if units is None:
                    continue

                items.append(
                    {
                        "month": month.strip(),
                        "maker": maker.strip(),
                        "category": category.strip(),
                        "registrations": units,
                        "state": (_pick(row, "state", "region") or "").strip(),
                        "fuel": (_pick(row, "fuel", "fuel_type") or "").strip(),
                        "file": csv_path.name,
                        "row_number": row_number,
                    }
                )

    status = "ok" if items else "warning"
    message = f"Loaded {len(items)} Vahan rows from {len(csv_files)} file(s)." if items else "CSV files were present, but no rows matched the expected schema."
    return CollectionResult(name="Vahan", status=status, items=items, message=message)


def collect_vahan_state_registration_dump(csv_path: Path) -> CollectionResult:
    if not csv_path.exists():
        return CollectionResult(
            name="Vahan state registrations",
            status="warning",
            items=[],
            message="No validated all-state Vahan vehicle-class dump was found.",
        )

    type_to_segment = {
        vehicle_type: segment
        for segment, vehicle_types in STATE_REGISTRATION_TYPE_MAP.items()
        for vehicle_type in vehicle_types
    }

    aggregated: dict[tuple[str, str, str], int] = {}
    matched_units = 0.0
    total_units = 0.0
    raw_rows = 0

    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            month = _pick(row, "date", "month", "report_month")
            state_name = _pick(row, "state_name", "state")
            vehicle_type = _pick(row, "type", "vehicle_type")
            registrations = _pick(row, "registrations", "units", "sales")
            if not month or not state_name or not vehicle_type or not registrations:
                continue

            units = _safe_float(registrations)
            if units is None:
                continue

            raw_rows += 1
            total_units += units
            segment = type_to_segment.get(vehicle_type.strip())
            if not segment:
                continue

            rounded_units = int(round(units))
            matched_units += rounded_units
            normalized_month = month.strip()[:7]
            key = (state_name.strip(), normalized_month, segment)
            aggregated[key] = aggregated.get(key, 0) + rounded_units

    items = [
        {
            "state": state,
            "month": month,
            "segment": segment,
            "registrations": units,
        }
        for (state, month, segment), units in sorted(aggregated.items())
    ]

    status = "ok" if items else "warning"
    coverage_pct = (matched_units / total_units * 100) if total_units else 0.0
    message = (
        f"Rolled {raw_rows:,} raw Vahan rows into {len(items):,} state-month-segment points. "
        f"Mapped {coverage_pct:.1f}% of registrations into PV, 2W, 3W and CV; tractors, CE and special classes stay excluded."
        if items
        else "The Vahan state dump was present, but no rows matched the expected schema."
    )
    return CollectionResult(name="Vahan state registrations", status=status, items=items, message=message)


def collect_vahan_segment_market_dump(csv_path: Path, metadata_path: Path | None = None) -> CollectionResult:
    if not csv_path.exists():
        return CollectionResult(
            name="Vahan segment market share",
            status="warning",
            items=[],
            message="No validated all-India Vahan class dump was found for the segment market-share explorer.",
        )

    aggregated: dict[tuple[str, str], int] = {}
    raw_rows = 0

    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            month = _pick(row, "date", "month", "report_month")
            vehicle_class = _pick(row, "type", "vehicle_class")
            registrations = _pick(row, "registrations", "value", "units", "sales")
            if not month or not vehicle_class or not registrations:
                continue

            units = _safe_float(registrations)
            if units is None:
                continue

            raw_rows += 1
            key = (month.strip()[:7], vehicle_class.strip())
            aggregated[key] = aggregated.get(key, 0) + int(round(units))

    items = [
        {
            "month": month,
            "vehicle_class": vehicle_class,
            "registrations": units,
        }
        for (month, vehicle_class), units in sorted(aggregated.items())
    ]

    metadata: dict[str, Any] = {}
    if metadata_path and metadata_path.exists():
        try:
            metadata_json = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata = {
                "source_name": metadata_json.get("source"),
                "source_url": metadata_json.get("source_link") or metadata_json.get("schema", {}).get("url"),
                "dataset_url": metadata_json.get("schema", {}).get("url") or metadata_json.get("source_link"),
                "latest_public_update": metadata_json.get("updated_at"),
                "csv_updated_at": metadata_json.get("csv_updated_at"),
                "title": metadata_json.get("title"),
            }
        except Exception:
            metadata = {}

    status = "ok" if items else "warning"
    message = (
        f"Rolled {raw_rows:,} raw Vahan rows into {len(items):,} class-month points for the segment-share explorer."
        if items
        else "The Vahan class dump was present, but no rows matched the expected schema."
    )
    return CollectionResult(
        name="Vahan segment market share",
        status=status,
        items=items,
        message=message,
        meta=metadata,
    )


def collect_dataful_ev_previews(norms_path: Path, category_path: Path) -> CollectionResult:
    datasets = [
        (
            "norms",
            "Dataful EV norms preview",
            "https://dataful.in/datasets/21141/",
            norms_path,
            ("year", "month", "state", "rto", "norms", "fuel", "value", "unit", "note"),
        ),
        (
            "category",
            "Dataful EV category preview",
            "https://dataful.in/datasets/21144/",
            category_path,
            ("year", "month", "state", "rto", "vehicle_category", "fuel", "value", "unit", "note"),
        ),
    ]

    items: list[dict[str, Any]] = []
    missing = []
    for dataset_id, label, url, path, fields in datasets:
        if not path.exists():
            missing.append(path.name)
            continue

        text = path.read_text(encoding="utf-8", errors="ignore")
        rows = _extract_preview_rows(text, fields)
        latest_month = _latest_preview_month(rows)
        latest_rows = [row for row in rows if row.get("month_key") == latest_month] if latest_month else []
        latest_rows.sort(key=lambda row: row.get("value", 0), reverse=True)

        last_updated_match = re.search(r'Last Updated</h3></div><span><span>([^<]+)</span>', text)
        last_updated = last_updated_match.group(1).strip() if last_updated_match else None

        if latest_rows:
            items.append(
                {
                    "dataset": dataset_id,
                    "label": label,
                    "url": url,
                    "last_updated": last_updated,
                    "latest_month": latest_month,
                    "rows": latest_rows,
                }
            )

    if not items:
        return CollectionResult(
            name="Official EV preview",
            status="warning",
            items=[],
            message=(
                "No recent public EV preview pages were available locally."
                if not missing
                else f"EV preview pages missing: {', '.join(missing)}."
            ),
        )

    latest_months = sorted({item["latest_month"] for item in items if item.get("latest_month")})
    message = (
        f"Loaded {len(items)} recent EV preview page(s) through {latest_months[-1]}."
        if latest_months
        else f"Loaded {len(items)} recent EV preview page(s)."
    )
    return CollectionResult(name="Official EV preview", status="ok", items=items, message=message)


def _pick(row: dict[str, str], *aliases: str) -> str | None:
    lowered = {key.lower(): value for key, value in row.items() if key}
    for alias in aliases:
        value = lowered.get(alias.lower())
        if value:
            return value
    return None


def _safe_int(value: str) -> int | None:
    cleaned = re.sub(r"[,\s]", "", value)
    if not cleaned or not re.fullmatch(r"-?\d+", cleaned):
        return None
    return int(cleaned)


def _safe_float(value: str) -> float | None:
    cleaned = re.sub(r"[,\s]", "", value)
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _extract_preview_rows(text: str, fields: tuple[str, ...]) -> list[dict[str, Any]]:
    table_match = re.search(r'<h2 class="heading">Data Preview</h2><div class="tableContainer"><table.*?<tbody>(.*?)</tbody></table>', text, re.DOTALL)
    if not table_match:
        return []

    rows: list[dict[str, Any]] = []
    row_pattern = re.compile(r"<tr>(.*?)</tr>", re.DOTALL)
    cell_pattern = re.compile(r'<td align="left">(.*?)</td>', re.DOTALL)
    for row_html in row_pattern.findall(table_match.group(1)):
        cells = [html.unescape(re.sub(r"<.*?>", "", cell)).strip() for cell in cell_pattern.findall(row_html)]
        if len(cells) != len(fields):
            continue
        row = dict(zip(fields, cells, strict=False))
        row["value"] = _safe_int(row.get("value", "") or "") or 0
        month_text = row.get("month", "")
        year_text = row.get("year", "")
        row["month_key"] = _month_key(year_text, month_text)
        rows.append(row)
    return rows


def _latest_preview_month(rows: list[dict[str, Any]]) -> str | None:
    month_keys = sorted({row.get("month_key") for row in rows if row.get("month_key")})
    return month_keys[-1] if month_keys else None


def _month_key(year: str, month_name: str) -> str | None:
    month_map = {
        "January": "01",
        "February": "02",
        "March": "03",
        "April": "04",
        "May": "05",
        "June": "06",
        "July": "07",
        "August": "08",
        "September": "09",
        "October": "10",
        "November": "11",
        "December": "12",
    }
    if not year or month_name not in month_map:
        return None
    return f"{year}-{month_map[month_name]}"
