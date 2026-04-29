from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .live_analyze import build_payload, normalize_articles
from .live_config import RECENT_WINDOW_DAYS, SOURCES
from .live_collectors import (
    collect_bse_detail,
    collect_bse_announcements,
    collect_mobility_outlook,
    collect_rss,
    collect_siam_detail,
    collect_siam_press_releases,
)


def build_dashboard(output_path: Path, recent_window_days: int = RECENT_WINDOW_DAYS) -> dict:
    since = datetime.now(UTC) - timedelta(days=recent_window_days)
    raw_articles = []
    source_audit = []

    for source in SOURCES:
        if source.kind == "rss":
            result = collect_rss(source, since)
        elif source.kind == "mobility_json":
            result = collect_mobility_outlook(source, since)
        elif source.kind == "siam_press":
            result = collect_siam_press_releases(source, since)
        elif source.kind == "siam_detail":
            result = collect_siam_detail(source, since)
        elif source.kind == "bse_detail":
            result = collect_bse_detail(source, since)
        elif source.kind == "bse_announcements":
            result = collect_bse_announcements(source, since)
        else:
            raise ValueError(f"Unsupported source kind: {source.kind}")

        raw_articles.extend(result.items)
        source_audit.append(
            {
                "source": result.name,
                "status": result.status,
                "items": len(result.items),
                "message": result.message,
                "description": source.description,
                "source_type": source.source_type,
                "module_hint": source.module_hint,
            }
        )

    normalized_articles, normalization_audit = normalize_articles(raw_articles)
    payload = build_payload(normalized_articles, source_audit, normalization_audit, recent_window_days)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload
