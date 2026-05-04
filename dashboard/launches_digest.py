"""Detect recent vehicle-model launches across the existing trade-media RSS
sources (RushLane, ET Auto, Autocar Professional, EVReporter) and write a
``data/launches_snapshot.json`` consumed by the Recent Launches tab.

Strategy
========

We *don't* run a separate scraper — the news pipeline already pulls every
relevant feed and tags every article with ``brand_tags`` and ``signal_tags``.
A "launch" article is anything where:

  * ``signal_tags`` contains ``"Product / Launch"`` (matches launch / unveil /
    debut / facelift / variant / first drive), AND
  * ``brand_tags`` overlaps a brand name we map to a tracked OEM.

The window is 30 days rolling; deduped by canonical URL. Idempotent: re-runs
only update the file when the article set actually changes, so the
``commit_check`` step in the workflow stays clean.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .live_analyze import normalize_articles
from .live_collectors import collect_rss
from .news_digest import NEWS_SOURCES


LAUNCHES_SNAPSHOT_PATH = Path("data/launches_snapshot.json")
LAUNCH_WINDOW_DAYS = 30
LAUNCH_SIGNAL = "Product / Launch"
MAX_LAUNCHES = 40

# Map news-pipeline brand labels (live_config.BRAND_ALIASES) -> the
# listed-OEM display name we already use everywhere else (config.OEM_TO_LISTED).
# Brands that don't trace to a listed OEM in our dashboard are intentionally
# skipped — the tab is about companies the user actually tracks.
BRAND_TO_LISTED = {
    "Maruti Suzuki": "Maruti Suzuki",
    "Tata Motors": "Tata Motors",
    "Mahindra": "Mahindra & Mahindra",
    "Hyundai": "Hyundai Motor India",
    "TVS Motor": "TVS Motor",
    "Bajaj Auto": "Bajaj Auto",
    "Hero MotoCorp": "Hero MotoCorp",
    "Ashok Leyland": "Ashok Leyland",
    "VE Commercial": "Eicher Motors",
}

# Tone applied to each company's launch card (drives the colour bar).
# Mirrors the listed-OEM segment so PV is one tone, 2W another, etc.
LISTED_TO_SEGMENT_TONE = {
    "Maruti Suzuki": "pv",
    "Tata Motors": "pv",
    "Mahindra & Mahindra": "pv",
    "Hyundai Motor India": "pv",
    "TVS Motor": "tw",
    "Bajaj Auto": "tw",
    "Hero MotoCorp": "tw",
    "Ashok Leyland": "cv",
    "Eicher Motors": "cv",
}


def read_launches_snapshot(path: Path = LAUNCHES_SNAPSHOT_PATH) -> dict[str, Any]:
    if not path.exists():
        return {"available": False, "companies": [], "items": [], "generated_at": None}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"available": False, "companies": [], "items": [], "generated_at": None}


def refresh_launches_snapshot(path: Path = LAUNCHES_SNAPSHOT_PATH) -> tuple[dict[str, Any], dict[str, Any]]:
    since = datetime.now(UTC) - timedelta(days=LAUNCH_WINDOW_DAYS)
    raw_articles: list[dict[str, Any]] = []
    sources_attempted = 0
    sources_live = 0
    for source in NEWS_SOURCES:
        sources_attempted += 1
        result = collect_rss(source, since)
        if result.status == "ok" and result.items:
            sources_live += 1
        raw_articles.extend(result.items)

    normalized, _ = normalize_articles(raw_articles)
    digest = _build_digest(normalized, sources_attempted, sources_live)

    if digest["available"]:
        cached = read_launches_snapshot(path)
        if cached.get("available") and _same_items(cached, digest):
            return cached, {
                "source": "Recent Launches",
                "status": "ok",
                "updated": False,
                "latest_value": cached.get("generated_at"),
                "message": (
                    f"Launch refresh found no new model launches; kept existing "
                    f"snapshot with {cached.get('item_count', 0)} items."
                ),
            }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(digest, indent=2, ensure_ascii=False), encoding="utf-8")
        return digest, {
            "source": "Recent Launches",
            "status": "ok",
            "updated": True,
            "latest_value": digest["generated_at"],
            "message": (
                f"Updated launch digest with {digest['item_count']} launches "
                f"across {len(digest['companies'])} listed OEMs."
            ),
        }

    cached = read_launches_snapshot(path)
    if cached.get("available"):
        return cached, {
            "source": "Recent Launches",
            "status": "warning",
            "updated": False,
            "latest_value": cached.get("generated_at"),
            "message": "Launch refresh produced no qualifying items; kept the prior snapshot.",
        }
    return digest, {
        "source": "Recent Launches",
        "status": "warning",
        "updated": False,
        "latest_value": None,
        "message": "No launch articles detected in the 30-day window.",
    }


def _build_digest(
    articles: list[dict[str, Any]],
    sources_attempted: int,
    sources_live: int,
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    by_company: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for article in articles:
        if LAUNCH_SIGNAL not in (article.get("signal_tags") or []):
            continue
        listed = _match_listed_oem(article.get("brand_tags") or [])
        if not listed:
            continue
        item = {
            "title": article["title"],
            "summary": (article.get("summary") or "").strip(),
            "url": article["url"],
            "source": article["source"],
            "published_at": article["published_at"],
            "published_display": article["published_display"],
            "company": listed,
            "tone": LISTED_TO_SEGMENT_TONE.get(listed, "pv"),
            "segment_tags": [t for t in (article.get("segment_tags") or []) if t != "General"],
            "image_url": article.get("image_url"),
        }
        items.append(item)
        by_company[listed].append(item)

    items.sort(key=lambda x: x["published_at"], reverse=True)
    items = items[:MAX_LAUNCHES]

    companies = []
    for listed, rows in by_company.items():
        rows = sorted(rows, key=lambda x: x["published_at"], reverse=True)
        companies.append({
            "company": listed,
            "tone": LISTED_TO_SEGMENT_TONE.get(listed, "pv"),
            "count": len(rows),
            "latest_published_at": rows[0]["published_at"],
            "latest_title": rows[0]["title"],
        })
    companies.sort(key=lambda x: x["latest_published_at"], reverse=True)

    available = len(items) >= 1
    return {
        "available": available,
        "generated_at": datetime.now(UTC).isoformat(),
        "window_days": LAUNCH_WINDOW_DAYS,
        "item_count": len(items),
        "items": items,
        "companies": companies,
        "audit": {
            "sources_attempted": sources_attempted,
            "sources_live": sources_live,
        },
    }


def _match_listed_oem(brand_tags: list[str]) -> str | None:
    for tag in brand_tags:
        listed = BRAND_TO_LISTED.get(tag)
        if listed:
            return listed
    return None


def _same_items(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return _item_keys(left) == _item_keys(right)


def _item_keys(digest: dict[str, Any]) -> set[str]:
    return {str(item.get("url") or "") for item in (digest.get("items") or []) if item.get("url")}
