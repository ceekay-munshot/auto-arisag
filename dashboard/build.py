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


PV_OEM_HISTORY_PATH = Path("data/pv_oem_history.json")


def upsert_pv_oem_history(snapshot: dict) -> None:
    """Append the latest FADA PV OEM rows to pv_oem_history.json so the
    periodized PV table grows month-by-month even between full backfills."""
    fada = snapshot.get("fada") or {}
    pv_table = (fada.get("latest_oem_tables") or {}).get("PV") or {}
    rows = pv_table.get("rows") or []
    month_id = pv_table.get("source_meta", {}).get("latest_month") or fada.get("oem_latest_month") or fada.get("latest_month")
    source_url = pv_table.get("source_meta", {}).get("url") or fada.get("oem_source_url") or fada.get("source_url")
    release_date = fada.get("oem_latest_release_date") or fada.get("latest_release_date") or ""
    if not month_id or not rows:
        return

    history: dict
    if PV_OEM_HISTORY_PATH.exists():
        try:
            history = json.loads(PV_OEM_HISTORY_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            history = {"months": []}
    else:
        history = {"months": []}

    months = list(history.get("months") or [])
    by_month = {item["month"]: item for item in months if item.get("month")}
    existing = by_month.get(month_id)
    new_record = {
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
    if existing == new_record:
        return
    by_month[month_id] = new_record
    out = {"months": [by_month[k] for k in sorted(by_month)]}
    PV_OEM_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    PV_OEM_HISTORY_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")


def build_dashboard(output_path: Path) -> dict:
    snapshot = json.loads(DATA_SNAPSHOT_PATH.read_text(encoding="utf-8"))
    upsert_pv_oem_history(snapshot)
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
