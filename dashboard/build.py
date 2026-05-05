from __future__ import annotations

import json
from pathlib import Path

from .analyze import build_payload
from .collectors import (
    collect_dataful_ev_previews,
    collect_vahan_imports,
    collect_vahan_segment_market_dump,
    collect_vahan_state_registration_dump,
)
from .config import DATA_SNAPSHOT_PATH
from .news_digest import read_news_snapshot, refresh_news_snapshot
from .update_snapshot import refresh_snapshot
from .vahan_oem import read_vahan_oem_cache, refresh_vahan_oem_cache


OEM_HISTORY_PATH = Path("data/oem_history.json")
LEGACY_PV_HISTORY_PATH = Path("data/pv_oem_history.json")
FADA_HISTORY_PATH = Path("data/fada_history.json")
TRACKED_OEM_CATEGORIES = ("PV", "2W", "3W", "CV", "TRACTOR", "CE")


def _load_fada_history() -> dict:
    """Reads the historical fuel-mix + urban/rural splits backfilled by
    scripts/backfill_fada_history.py. Tolerates a missing file (the live
    refresh path on its own only carries the latest month)."""
    if not FADA_HISTORY_PATH.exists():
        return {"monthly_fuel_mix": {}, "urban_rural_growth_series": [], "sources": {}}
    try:
        payload = json.loads(FADA_HISTORY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"monthly_fuel_mix": {}, "urban_rural_growth_series": [], "sources": {}}
    if not isinstance(payload, dict):
        return {"monthly_fuel_mix": {}, "urban_rural_growth_series": [], "sources": {}}
    payload.setdefault("monthly_fuel_mix", {})
    payload.setdefault("urban_rural_growth_series", [])
    payload.setdefault("sources", {})
    return payload


def _merge_fada_history(snapshot: dict) -> None:
    """Folds backfilled fuel-mix + urban/rural history into the live FADA
    snapshot so analyze.py automatically picks up the longer timelines.

    Two surfaces are extended:
      * `fada.ev_share_series` — appended one row per (month, category) for
        every historical month not already in the live series. The EV
        penetration chart on the dashboard is computed from this, so adding
        rows extends the chart timeline with no frontend change required.
      * `fada.urban_rural_growth_series` — a new field carrying the full
        monthly history of urban-vs-rural growth (the live snapshot only
        carries the latest month under `latest_urban_rural_growth`). The
        frontend reads this to render a historical chart.
    """
    history = _load_fada_history()
    fada = snapshot.setdefault("fada", {})

    monthly_fuel_mix = history.get("monthly_fuel_mix") or {}
    if monthly_fuel_mix:
        existing_series = list(fada.get("ev_share_series") or [])
        existing_keys = {(row.get("month"), row.get("category")) for row in existing_series}
        for month_id in sorted(monthly_fuel_mix):
            mix = monthly_fuel_mix[month_id] or {}
            for category, fuels in mix.items():
                if (month_id, category) in existing_keys:
                    continue
                share = (fuels or {}).get("EV") or (fuels or {}).get("Electric") or 0.0
                existing_series.append({
                    "month": month_id,
                    "category": category,
                    "ev_share_pct": share,
                })
                existing_keys.add((month_id, category))
        existing_series.sort(key=lambda row: (row.get("month") or "", row.get("category") or ""))
        fada["ev_share_series"] = existing_series

    urban_rural_history = list(history.get("urban_rural_growth_series") or [])
    latest_rows = list(fada.get("latest_urban_rural_growth") or [])
    latest_month = fada.get("latest_month")
    if latest_month:
        # Mirror the live latest-month snapshot into the historical series so
        # the chart stops at the same point as every other lens.
        existing_keys = {
            (row.get("month"), row.get("category"))
            for row in urban_rural_history
        }
        for row in latest_rows:
            key = (latest_month, row.get("category"))
            if key in existing_keys:
                continue
            urban_rural_history.append({"month": latest_month, **{k: v for k, v in row.items() if k != "month"}})
            existing_keys.add(key)
    urban_rural_history.sort(key=lambda row: (row.get("month") or "", row.get("category") or ""))
    fada["urban_rural_growth_series"] = urban_rural_history


def _load_oem_history() -> dict:
    if OEM_HISTORY_PATH.exists():
        try:
            payload = json.loads(OEM_HISTORY_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict) and isinstance(payload.get("categories"), dict):
            return payload
    # First-time migration: lift the legacy PV file into the new shape.
    if LEGACY_PV_HISTORY_PATH.exists():
        try:
            legacy = json.loads(LEGACY_PV_HISTORY_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            legacy = {}
        months = legacy.get("months") if isinstance(legacy, dict) else None
        if isinstance(months, list):
            return {"categories": {"PV": {"months": months}}}
    return {"categories": {}}


def upsert_oem_history(snapshot: dict) -> None:
    """Append the latest FADA OEM rows for every tracked category into the
    unified data/oem_history.json so the periodized OEM tables stay current
    month-by-month even between full backfills."""
    fada = snapshot.get("fada") or {}
    tables = fada.get("latest_oem_tables") or {}
    fallback_url = fada.get("oem_source_url") or fada.get("source_url")
    fallback_month = fada.get("oem_latest_month") or fada.get("latest_month")
    release_date = fada.get("oem_latest_release_date") or fada.get("latest_release_date") or ""

    history = _load_oem_history()
    categories = dict(history.get("categories") or {})
    changed = False

    for category in TRACKED_OEM_CATEGORIES:
        table = tables.get(category) or {}
        rows = table.get("rows") or []
        if not rows:
            continue
        meta = table.get("source_meta") or {}
        month_id = meta.get("latest_month") or fallback_month
        source_url = meta.get("url") or fallback_url
        if not month_id:
            continue
        record = {
            "month": month_id,
            "release_date": release_date,
            "source_url": source_url,
            "rows": [
                {
                    "oem": row.get("oem"),
                    "units": row.get("units"),
                    "share_pct": row.get("share_pct"),
                    "prior_units": row.get("prior_units"),
                    "prior_share_pct": row.get("prior_share_pct"),
                }
                for row in rows
            ],
        }
        bucket = categories.setdefault(category, {"months": []})
        months = list(bucket.get("months") or [])
        by_month = {item["month"]: item for item in months if item.get("month")}
        if by_month.get(month_id) == record:
            continue
        by_month[month_id] = record
        bucket["months"] = [by_month[key] for key in sorted(by_month)]
        categories[category] = bucket
        changed = True

    if not changed:
        return
    out = {"categories": categories}
    OEM_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    OEM_HISTORY_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")


def build_dashboard(output_path: Path) -> dict:
    snapshot = json.loads(DATA_SNAPSHOT_PATH.read_text(encoding="utf-8"))
    upsert_oem_history(snapshot)
    _merge_fada_history(snapshot)
    news_snapshot = read_news_snapshot()
    vahan_oem_cache = read_vahan_oem_cache(output_path.parent / "vahan_oem_live.json")
    vahan_result = collect_vahan_imports(output_path.parent / "vahan")
    state_registration_result = collect_vahan_state_registration_dump(output_path.parent / "vahan_vehicle_class_dump.csv")
    segment_market_result = collect_vahan_segment_market_dump(
        output_path.parent / "vahan_vehicle_class_dump.csv",
        output_path.parent / "dataful_dataset_18262.json",
    )
    ev_preview_result = collect_dataful_ev_previews(
        output_path.parent / "ev_all_india_21141.html",
        output_path.parent / "ev_all_india_21144.html",
    )

    source_health = [
        {
            "source": vahan_result.name,
            "status": vahan_result.status,
            "items": len(vahan_result.items),
            "message": vahan_result.message,
        },
        {
            "source": state_registration_result.name,
            "status": state_registration_result.status,
            "items": len(state_registration_result.items),
            "message": state_registration_result.message,
        },
        {
            "source": segment_market_result.name,
            "status": segment_market_result.status,
            "items": len(segment_market_result.items),
            "message": segment_market_result.message,
        },
        {
            "source": ev_preview_result.name,
            "status": ev_preview_result.status,
            "items": len(ev_preview_result.items),
            "message": ev_preview_result.message,
        },
    ]

    payload = build_payload(
        snapshot,
        source_health,
        vahan_result.items,
        state_registration_result.items,
        state_registration_result.message,
        segment_market_result.items,
        segment_market_result.message,
        segment_market_result.meta or {},
        ev_preview_result.items,
        vahan_oem_cache,
        news_snapshot,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def refresh_dashboard(output_path: Path) -> tuple[dict, list[dict[str, str | bool | None]]]:
    source_updates = refresh_snapshot(DATA_SNAPSHOT_PATH)
    source_updates.append(
        refresh_vahan_oem_cache(
            output_path.parent / "vahan_oem_live.json",
            ["2W", "3W", "CV", "TRACTOR", "CE", "E2W", "E3W", "EPV", "ECV"],
        )
    )
    _, news_update = refresh_news_snapshot()
    source_updates.append(news_update)
    payload = build_dashboard(output_path)
    return payload, source_updates
