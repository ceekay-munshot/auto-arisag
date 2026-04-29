from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .live_analyze import normalize_articles
from .live_collectors import CollectionResult, collect_rss
from .live_config import SourceConfig


NEWS_SNAPSHOT_PATH = Path("data/news_snapshot.json")
NEWS_WINDOW_DAYS = 45
MAX_ITEMS_PER_GROUP = 5

NEWS_SOURCES = [
    SourceConfig(
        name="ET Auto Passenger Vehicles",
        kind="rss",
        url="https://auto.economictimes.indiatimes.com/rss/passenger-vehicle",
        description="Passenger vehicle market and OEM updates from ET Auto.",
        source_type="trade_media",
        module_hint="newsflow",
        max_items=20,
    ),
    SourceConfig(
        name="ET Auto Two Wheelers",
        kind="rss",
        url="https://auto.economictimes.indiatimes.com/rss/two-wheelers",
        description="Two-wheeler industry coverage from ET Auto.",
        source_type="trade_media",
        module_hint="newsflow",
        max_items=20,
    ),
    SourceConfig(
        name="ET Auto Commercial Vehicles",
        kind="rss",
        url="https://auto.economictimes.indiatimes.com/rss/commercial-vehicle",
        description="Commercial vehicle and fleet coverage from ET Auto.",
        source_type="trade_media",
        module_hint="newsflow",
        max_items=20,
    ),
    SourceConfig(
        name="ET Auto Policy",
        kind="rss",
        url="https://auto.economictimes.indiatimes.com/rss/policy",
        description="Auto policy and regulatory news from ET Auto.",
        source_type="trade_media",
        module_hint="policy",
        max_items=20,
    ),
    SourceConfig(
        name="ET Auto Components",
        kind="rss",
        url="https://auto.economictimes.indiatimes.com/rss/auto-components",
        description="Components and supplier coverage from ET Auto.",
        source_type="trade_media",
        module_hint="supplier",
        max_items=20,
    ),
    SourceConfig(
        name="Autocar Professional Sales",
        kind="rss",
        url="https://www.autocarpro.in/rssfeeds/analysis-sales",
        description="Sales and channel analysis from Autocar Professional.",
        source_type="trade_media",
        module_hint="sales",
        max_items=20,
    ),
    SourceConfig(
        name="Autocar Professional EV",
        kind="rss",
        url="https://www.autocarpro.in/rssfeeds/category-ev",
        description="EV and transition coverage from Autocar Professional.",
        source_type="trade_media",
        module_hint="policy",
        max_items=20,
    ),
    SourceConfig(
        name="Autocar Professional Components",
        kind="rss",
        url="https://www.autocarpro.in/rssfeeds/category-auto-components",
        description="Component and supplier news from Autocar Professional.",
        source_type="trade_media",
        module_hint="supplier",
        max_items=20,
    ),
    SourceConfig(
        name="RushLane",
        kind="rss",
        url="https://www.rushlane.com/feed",
        description="OEM launches, sales commentary, and segment news from RushLane.",
        source_type="trade_media",
        module_hint="newsflow",
        max_items=25,
    ),
    SourceConfig(
        name="EVReporter",
        kind="rss",
        url="https://evreporter.com/feed/",
        description="EV ecosystem, battery, and supply chain coverage from EVReporter.",
        source_type="specialist_ev",
        module_hint="supplier",
        max_items=20,
    ),
]

GROUP_DEFINITIONS = [
    {"id": "pv", "label": "Passenger Vehicles"},
    {"id": "2w", "label": "Two-Wheelers"},
    {"id": "cv", "label": "Commercial Vehicles"},
    {"id": "ev", "label": "EV / Transition"},
    {"id": "components", "label": "Components"},
    {"id": "policy", "label": "Policy / Regulation"},
]


def read_news_snapshot(snapshot_path: Path = NEWS_SNAPSHOT_PATH) -> dict[str, Any]:
    if not snapshot_path.exists():
        return {"available": False, "groups": [], "generated_at": None}
    return json.loads(snapshot_path.read_text(encoding="utf-8"))


def refresh_news_snapshot(snapshot_path: Path = NEWS_SNAPSHOT_PATH) -> tuple[dict[str, Any], dict[str, Any]]:
    since = datetime.now(UTC) - timedelta(days=NEWS_WINDOW_DAYS)
    raw_articles: list[dict[str, Any]] = []
    source_audit: list[dict[str, Any]] = []

    for source in NEWS_SOURCES:
        result = collect_rss(source, since)
        raw_articles.extend(result.items)
        source_audit.append(_audit_row(result))

    normalized_articles, normalization_audit = normalize_articles(raw_articles)
    digest = build_news_digest(normalized_articles, source_audit, normalization_audit)

    if digest["available"]:
        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        snapshot_path.write_text(json.dumps(digest, indent=2), encoding="utf-8")
        return digest, {
            "source": "Live News",
            "status": "ok",
            "updated": True,
            "latest_value": digest["generated_at"],
            "message": f"Updated live news digest with {digest['item_count']} curated items across {digest['group_count']} segment groups.",
        }

    cached = read_news_snapshot(snapshot_path)
    if cached.get("available"):
        return cached, {
            "source": "Live News",
            "status": "warning",
            "updated": False,
            "latest_value": cached.get("generated_at"),
            "message": "Live news refresh did not clear validation thresholds, so the dashboard kept the last curated news snapshot.",
        }

    return digest, {
        "source": "Live News",
        "status": "warning",
        "updated": False,
        "latest_value": None,
        "message": "Live news refresh did not produce enough validated segment news, so the news panel stays hidden.",
    }


def build_news_digest(
    articles: list[dict[str, Any]],
    source_audit: list[dict[str, Any]],
    normalization_audit: dict[str, Any],
) -> dict[str, Any]:
    groups = {definition["id"]: {"id": definition["id"], "label": definition["label"], "items": []} for definition in GROUP_DEFINITIONS}
    used_urls: set[str] = set()

    for article in articles:
        buckets = candidate_buckets(article)
        if not buckets or article["url"] in used_urls:
            continue

        for bucket in buckets:
            if len(groups[bucket]["items"]) >= MAX_ITEMS_PER_GROUP:
                continue

            groups[bucket]["items"].append(
                {
                    "title": article["title"],
                    "url": article["url"],
                    "summary": article["summary"],
                    "source": article["source"],
                    "published_at": article["published_at"],
                    "published_display": article["published_display"],
                    "importance_score": article["importance_score"],
                    "segment_tags": article["segment_tags"],
                    "signal_tags": article["signal_tags"],
                }
            )
            used_urls.add(article["url"])
            break

    populated_groups = [groups[definition["id"]] for definition in GROUP_DEFINITIONS if groups[definition["id"]]["items"]]
    item_count = sum(len(group["items"]) for group in populated_groups)
    live_sources = [row for row in source_audit if row["status"] == "ok" and row["items"] > 0]
    available = len(populated_groups) >= 4 and item_count >= 6 and len(live_sources) >= 4

    return {
        "available": available,
        "generated_at": datetime.now(UTC).isoformat(),
        "window_days": NEWS_WINDOW_DAYS,
        "group_count": len(populated_groups),
        "item_count": item_count,
        "groups": populated_groups,
        "sources_live": [row["source"] for row in live_sources],
        "audit": {
            "sources_attempted": len(source_audit),
            "sources_live": len(live_sources),
            "sources_hidden": [row["source"] for row in source_audit if row["status"] != "ok" or row["items"] == 0],
            **normalization_audit,
        },
    }


def candidate_buckets(article: dict[str, Any]) -> list[str]:
    segments = set(article.get("segment_tags", []))
    signals = set(article.get("signal_tags", []))
    source = (article.get("source") or "").lower()
    buckets: list[str] = []

    if "Components" in segments or "Supply Chain / Components" in signals:
        buckets.append("components")
    if "EV" in segments:
        buckets.append("ev")
    if "Policy / Regulation" in signals:
        buckets.append("policy")
    if "Passenger Vehicles" in segments:
        buckets.append("pv")
    if "Two-Wheelers" in segments:
        buckets.append("2w")
    if "Commercial Vehicles" in segments:
        buckets.append("cv")

    if "components" in source and "components" not in buckets:
        buckets.append("components")
    if "policy" in source and "policy" not in buckets:
        buckets.append("policy")
    if "commercial" in source and "cv" not in buckets:
        buckets.append("cv")
    if ("two wheel" in source or "two-wheel" in source) and "2w" not in buckets:
        buckets.append("2w")
    if "passenger" in source and "pv" not in buckets:
        buckets.append("pv")

    return buckets


def _audit_row(result: CollectionResult) -> dict[str, Any]:
    return {
        "source": result.name,
        "status": result.status,
        "items": len(result.items),
        "message": result.message,
    }
