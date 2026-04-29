from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import UTC, datetime
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

from .live_config import (
    BRAND_ALIASES,
    HIGH_SIGNAL_PATTERNS,
    LUXURY_BRANDS,
    MAX_ARTICLES,
    SEGMENT_ALIASES,
    SIGNAL_ALIASES,
)


BRAND_PATTERNS = {label: [re.compile(pattern, re.I) for pattern in patterns] for label, patterns in BRAND_ALIASES.items()}
SEGMENT_PATTERNS = {label: [re.compile(pattern, re.I) for pattern in patterns] for label, patterns in SEGMENT_ALIASES.items()}
SIGNAL_PATTERNS = {label: [re.compile(pattern, re.I) for pattern in patterns] for label, patterns in SIGNAL_ALIASES.items()}
HIGH_SIGNAL_REGEX = [re.compile(pattern, re.I) for pattern in HIGH_SIGNAL_PATTERNS]


def normalize_articles(raw_articles: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    seen_signatures: set[tuple[str, str, str]] = set()
    duplicates_removed = 0
    unmapped_articles = 0
    filtered_low_signal = 0

    for article in raw_articles:
        canonical_url = _canonicalize_url(article["url"])
        if canonical_url in seen_urls:
            duplicates_removed += 1
            continue

        title_signature = _normalize_title(article.get("title", ""))
        published_at = article["published_at"].astimezone(UTC)
        signature_key = (article["source"], title_signature, published_at.strftime("%Y-%m-%d"))
        if signature_key in seen_signatures:
            duplicates_removed += 1
            continue

        seen_urls.add(canonical_url)
        seen_signatures.add(signature_key)

        haystack = " ".join(
            part
            for part in [
                article.get("title", ""),
                article.get("summary", ""),
                article.get("category_hint", ""),
                article.get("company", ""),
                article.get("article_type", ""),
            ]
            if part
        )
        lowered = haystack.lower()

        brands = _merge_unique([article.get("brand_hint")] if article.get("brand_hint") else [], _match_taxonomy(lowered, BRAND_PATTERNS))
        segments = _merge_unique(list(article.get("segment_hints") or []), _match_taxonomy(lowered, SEGMENT_PATTERNS))
        signals = _match_taxonomy(lowered, SIGNAL_PATTERNS)

        brands, segments, signals = _apply_source_rules(article, brands, segments, signals, lowered)
        if any(brand in LUXURY_BRANDS for brand in brands) and "Luxury" not in segments:
            segments.append("Luxury")

        if not brands and not segments and not signals:
            filtered_low_signal += 1
            continue
        if not brands:
            unmapped_articles += 1

        age_days = max((datetime.now(UTC) - published_at).days, 0)
        score = _importance_score(article, lowered, brands, segments, signals, age_days)

        normalized.append(
            {
                "source": article["source"],
                "source_type": article.get("source_type", "trade_media"),
                "module_hint": article.get("module_hint", "newsflow"),
                "title": article["title"].strip(),
                "url": canonical_url,
                "summary": article.get("summary", "").strip(),
                "published_at": published_at.isoformat(),
                "published_epoch": published_at.timestamp(),
                "published_display": published_at.strftime("%d %b %Y"),
                "brand_tags": brands or ["Unmapped"],
                "segment_tags": segments or ["General"],
                "signal_tags": signals or ["General"],
                "importance_score": score,
                "image_url": article.get("image_url"),
                "author": article.get("author"),
                "article_type": article.get("article_type"),
                "company": article.get("company"),
                "attachment_url": article.get("attachment_url"),
            }
        )

    normalized.sort(key=lambda item: (item["importance_score"], item["published_epoch"]), reverse=True)
    normalized = normalized[:MAX_ARTICLES]
    audit = {
        "duplicates_removed": duplicates_removed,
        "unmapped_articles": unmapped_articles,
        "filtered_low_signal": filtered_low_signal,
        "kept_articles": len(normalized),
    }
    return normalized, audit


def build_payload(
    articles: list[dict[str, Any]],
    source_audit: list[dict[str, Any]],
    normalization_audit: dict[str, Any],
    recent_window_days: int,
) -> dict[str, Any]:
    source_counter = Counter(article["source"] for article in articles)
    brand_counter = Counter(tag for article in articles for tag in article["brand_tags"] if tag != "Unmapped")
    segment_counter = Counter(tag for article in articles for tag in article["segment_tags"] if tag != "General")
    signal_counter = Counter(tag for article in articles for tag in article["signal_tags"] if tag != "General")

    matrix_counter: dict[str, Counter[str]] = defaultdict(Counter)
    for article in articles:
        for brand in article["brand_tags"]:
            if brand == "Unmapped":
                continue
            for segment in article["segment_tags"]:
                if segment == "General":
                    continue
                matrix_counter[brand][segment] += 1

    live_sources = [row for row in source_audit if row["status"] == "ok" and row["items"] > 0]
    official_items = [article for article in articles if article["source_type"].startswith("official")]
    high_signal_articles = [article for article in articles if article["importance_score"] >= 8]

    modules = {
        "official_filings": _unique_articles(article for article in articles if article["source_type"] == "official_filing")[:12],
        "industry_sales": _unique_articles(
            article for article in articles if article["source"] == "SIAM Press Releases" or "Monthly Sales / Demand" in article["signal_tags"]
        )[:14],
        "policy_watch": _unique_articles(article for article in articles if "Policy / Regulation" in article["signal_tags"])[:12],
        "supplier_watch": _unique_articles(
            article
            for article in articles
            if "Supply Chain / Components" in article["signal_tags"]
            or "Input Costs / Commodities" in article["signal_tags"]
            or article["module_hint"] == "supplier"
        )[:12],
        "luxury_watch": _unique_articles(article for article in articles if "Luxury" in article["segment_tags"])[:8],
        "high_signal_newsflow": high_signal_articles[:16],
    }
    module_sources = {name: sorted({article["source"] for article in items}) for name, items in modules.items() if items}

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "recent_window_days": recent_window_days,
        "summary": {
            "total_articles": len(articles),
            "high_signal_articles": len(high_signal_articles),
            "official_items": len(official_items),
            "live_sources": len(live_sources),
            "tracked_brands": len(brand_counter),
        },
        "thesis_board": build_thesis_board(articles, brand_counter, signal_counter, live_sources, official_items),
        "top_brands": top_list(brand_counter, 10),
        "top_signals": top_list(signal_counter, 8),
        "source_breakdown": top_list(source_counter, 10),
        "brand_segment_matrix": {
            "brands": [item["label"] for item in top_list(brand_counter, 12)],
            "segments": [item["label"] for item in top_list(segment_counter, 6)],
            "values": [
                {"brand": brand, "segment": segment, "count": count}
                for brand, segment_counts in matrix_counter.items()
                for segment, count in segment_counts.items()
                if count
            ],
        },
        "modules": modules,
        "module_sources": module_sources,
        "live_sources": [
            {
                "source": row["source"],
                "items": row["items"],
                "message": row["message"],
                "source_type": row["source_type"],
                "description": row["description"],
            }
            for row in live_sources
        ],
        "articles": articles,
        "audit": {
            "sources_attempted": len(source_audit),
            "sources_live": len(live_sources),
            "sources_hidden": [row["source"] for row in source_audit if row["status"] != "ok" or row["items"] == 0],
            **normalization_audit,
        },
    }


def top_list(counter: Counter[str], size: int) -> list[dict[str, Any]]:
    return [{"label": label, "count": count} for label, count in counter.most_common(size)]


def build_thesis_board(
    articles: list[dict[str, Any]],
    brand_counter: Counter[str],
    signal_counter: Counter[str],
    live_sources: list[dict[str, Any]],
    official_items: list[dict[str, Any]],
) -> list[str]:
    insights: list[str] = []
    if official_items:
        insights.append(
            f"Official filings and industry releases contribute {len(official_items)} of {len(articles)} retained items and are surfaced separately so you can cross-check trade-media flow against primary disclosures."
        )
    if signal_counter:
        label, count = signal_counter.most_common(1)[0]
        insights.append(f"{label} is the dominant signal cluster with {count} mapped items in the active 60-day window.")
    if brand_counter:
        label, count = brand_counter.most_common(1)[0]
        insights.append(f"{label} leads recent item intensity with {count} mapped mentions across disclosures, industry releases, and newsflow.")

    sales_items = sum("Monthly Sales / Demand" in article["signal_tags"] for article in articles)
    if sales_items:
        insights.append(f"Sales and channel-check coverage has {sales_items} usable items after filtering empty and low-signal entries.")

    if not insights and live_sources:
        insights.append(f"{len(live_sources)} live sources produced usable data after empty and failed collectors were removed from the UI.")
    return insights[:4]


def _match_taxonomy(haystack: str, taxonomy: dict[str, list[re.Pattern[str]]]) -> list[str]:
    hits: list[str] = []
    for label, patterns in taxonomy.items():
        if any(pattern.search(haystack) for pattern in patterns):
            hits.append(label)
    return hits


def _apply_source_rules(
    article: dict[str, Any],
    brands: list[str],
    segments: list[str],
    signals: list[str],
    haystack: str,
) -> tuple[list[str], list[str], list[str]]:
    article_type = article.get("article_type") or ""
    source_type = article.get("source_type") or ""
    module_hint = article.get("module_hint") or ""

    if article_type in {"investor_presentation", "annual_report", "concall_transcript", "corporate_filing"}:
        signals = _append_unique(signals, "Filing / Disclosure")
    if article_type == "management_update":
        signals = _append_unique(signals, "Management / Governance")
    if article_type == "capacity_update":
        signals = _append_unique(signals, "Capacity / Capex")
    if article_type == "industry_release":
        signals = _append_unique(signals, "Monthly Sales / Demand")

    if source_type == "official_industry":
        signals = _append_unique(signals, "Monthly Sales / Demand")
    if source_type == "official_filing":
        signals = _append_unique(signals, "Filing / Disclosure")

    if module_hint == "supplier":
        signals = _append_unique(signals, "Supply Chain / Components")
    if module_hint == "sales":
        signals = _append_unique(signals, "Monthly Sales / Demand")
    if "policy" in haystack or "scheme" in haystack:
        signals = _append_unique(signals, "Policy / Regulation")
    if "rail siding" in haystack or "dispatch" in haystack:
        signals = _append_unique(signals, "Monthly Sales / Demand")

    return brands, segments, signals


def _importance_score(
    article: dict[str, Any],
    haystack: str,
    brands: list[str],
    segments: list[str],
    signals: list[str],
    age_days: int,
) -> int:
    score = 1
    score += min(len(brands), 2)
    score += min(len(segments), 2)
    score += min(len([signal for signal in signals if signal != "General"]), 3)
    score += sum(1 for pattern in HIGH_SIGNAL_REGEX if pattern.search(haystack))

    source_type = article.get("source_type", "")
    if source_type == "official_filing":
        score += 3
    elif source_type == "official_industry":
        score += 2
    elif source_type == "specialist_ev":
        score += 1

    article_type = article.get("article_type") or ""
    if article_type in {"investor_presentation", "annual_report", "concall_transcript"}:
        score += 2
    if article.get("attachment_url"):
        score += 1
    if "Luxury" in segments:
        score += 1

    if age_days <= 7:
        score += 2
    elif age_days <= 30:
        score += 1
    return score


def _append_unique(items: list[str], value: str) -> list[str]:
    if value not in items:
        items.append(value)
    return items


def _merge_unique(primary: list[str], secondary: list[str]) -> list[str]:
    merged = [item for item in primary if item]
    for item in secondary:
        if item not in merged:
            merged.append(item)
    return merged


def _unique_articles(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for article in sorted(items, key=lambda item: (item["importance_score"], item["published_epoch"]), reverse=True):
        if article["url"] in seen:
            continue
        seen.add(article["url"])
        unique.append(article)
    return unique


def _canonicalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/") or parts.path
    return urlunsplit((parts.scheme, parts.netloc.lower(), path, parts.query, ""))


def _normalize_title(title: str) -> str:
    lowered = title.lower()
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    return re.sub(r"\s+", " ", lowered).strip()
