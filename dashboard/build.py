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


def build_dashboard(output_path: Path) -> dict:
    snapshot = json.loads(DATA_SNAPSHOT_PATH.read_text(encoding="utf-8"))
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
