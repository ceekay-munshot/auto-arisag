"""Detect recent vehicle-model launches across the existing trade-media RSS
sources (RushLane, ET Auto, Autocar Professional, EVReporter) and write a
``data/launches_snapshot.json`` consumed by the Recent Launches tab.

Strategy
========

We *don't* run a separate scraper — the news pipeline already pulls every
relevant feed and tags every article with ``brand_tags``. A "launch" article
qualifies when ALL of the below are true:

  1. The article's title or summary matches any of ``LAUNCH_PATTERNS``
     (existing news-pipeline ``Product / Launch`` signal keywords PLUS the
     extras we add here: introduces / rolls out / priced at / deliveries
     begin / bookings open / new model / all-new etc.).
  2. The article does NOT match any of ``NEGATIVE_PATTERNS`` — these are
     disqualifiers like quarterly results, dealership openings, CSR /
     scholarship / training programs, etc., which would otherwise produce
     false positives ("Maruti launches scholarship program" → out).
  3. The article's ``brand_tags`` overlap a brand we explicitly cover here
     (``BRAND_DEFINITIONS``) — both listed OEMs (Maruti, Tata, M&M etc.)
     AND notable non-listed OEMs (Kia, Honda, Toyota, MG, Skoda, VW,
     Renault, Nissan, BYD, Ola Electric, Ather, plus the luxury PV set).

The window is 30 days rolling; deduped by canonical URL. Idempotent: re-runs
only update the file when the article set actually changes, so the
``commit_check`` step in the workflow stays clean.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .live_analyze import normalize_articles
from .live_collectors import collect_rss
from .news_digest import NEWS_SOURCES


LAUNCHES_SNAPSHOT_PATH = Path("data/launches_snapshot.json")
LAUNCH_WINDOW_DAYS = 30
MAX_LAUNCHES = 60

# Brand label (from live_config.BRAND_ALIASES) -> {display name shown on the
# card, segment tone driving the colour bar, scope = "listed" if the OEM
# trades on NSE and we already track it everywhere else, "tracked" for the
# import / private / luxury OEMs covered only on this tab}.
BRAND_DEFINITIONS: dict[str, dict[str, str]] = {
    # Listed OEMs (the 9 we already track everywhere else).
    "Maruti Suzuki": {"display": "Maruti Suzuki", "tone": "pv", "scope": "listed"},
    "Tata Motors": {"display": "Tata Motors", "tone": "pv", "scope": "listed"},
    "Mahindra": {"display": "Mahindra & Mahindra", "tone": "pv", "scope": "listed"},
    "Hyundai": {"display": "Hyundai Motor India", "tone": "pv", "scope": "listed"},
    "TVS Motor": {"display": "TVS Motor", "tone": "tw", "scope": "listed"},
    "Bajaj Auto": {"display": "Bajaj Auto", "tone": "tw", "scope": "listed"},
    "Hero MotoCorp": {"display": "Hero MotoCorp", "tone": "tw", "scope": "listed"},
    "Ashok Leyland": {"display": "Ashok Leyland", "tone": "cv", "scope": "listed"},
    "VE Commercial": {"display": "Eicher Motors", "tone": "cv", "scope": "listed"},
    # Tracked but non-listed PV / 2W OEMs covered in this tab so the user
    # doesn't miss e.g. a Kia Syros launch.
    "Kia": {"display": "Kia India", "tone": "pv", "scope": "tracked"},
    "Honda": {"display": "Honda Cars India", "tone": "pv", "scope": "tracked"},
    "Toyota": {"display": "Toyota Kirloskar", "tone": "pv", "scope": "tracked"},
    "MG Motor": {"display": "JSW MG Motor", "tone": "pv", "scope": "tracked"},
    "Renault": {"display": "Renault India", "tone": "pv", "scope": "tracked"},
    "Nissan": {"display": "Nissan India", "tone": "pv", "scope": "tracked"},
    "Skoda": {"display": "Skoda Auto India", "tone": "pv", "scope": "tracked"},
    "Volkswagen": {"display": "Volkswagen India", "tone": "pv", "scope": "tracked"},
    "BYD": {"display": "BYD India", "tone": "ev", "scope": "tracked"},
    "Ather": {"display": "Ather Energy", "tone": "ev", "scope": "tracked"},
    "Ola Electric": {"display": "Ola Electric", "tone": "ev", "scope": "tracked"},
    # Luxury PV — surfaced because new-model launches in this segment matter
    # for the broader auto narrative even though none of these are NSE-listed.
    "Mercedes-Benz": {"display": "Mercedes-Benz India", "tone": "pv", "scope": "tracked"},
    "BMW": {"display": "BMW India", "tone": "pv", "scope": "tracked"},
    "Audi": {"display": "Audi India", "tone": "pv", "scope": "tracked"},
    "JLR": {"display": "JLR India", "tone": "pv", "scope": "tracked"},
    "Volvo": {"display": "Volvo India", "tone": "pv", "scope": "tracked"},
    "Porsche": {"display": "Porsche India", "tone": "pv", "scope": "tracked"},
}

# --- Indirect coverage: catch model-name-only headlines -------------------
#
# The news-pipeline brand classifier is conservative; an article headlined
# "BE 6 priced at ..." doesn't always carry "Mahindra" in title or summary.
# We supplement by matching popular / recent model names per brand. Used
# *only* when ``brand_tags`` doesn't already point to a known brand.
MODEL_NAME_TO_BRAND: list[tuple[str, str]] = [
    # Maruti Suzuki — current portfolio + recent launches.
    (r"\b(?:brezza|fronx|grand\s+vitara|jimny|invicto|e-?vitara|baleno|swift|wagon[- ]r|ertiga|dzire|ignis|celerio|eeco|s[- ]presso|ciaz|xl6|victoris)\b", "Maruti Suzuki"),
    # Tata Motors.
    (r"\b(?:nexon|harrier(?:\s+ev)?|sierra|safari|punch(?:\s+ev)?|tiago(?:\s+ev)?|tigor(?:\s+ev)?|altroz|curvv|avinya)\b", "Tata Motors"),
    # Mahindra (incl. BE / XEV electric series).
    (r"\b(?:thar|scorpio(?:[- ]n)?|xuv\s?(?:3xo|300|400|500|700|9e|\.e?8)?|xev\s?(?:9e|7e)?|be\s?6|bolero|marazzo|alturas)\b", "Mahindra"),
    # Hyundai.
    (r"\b(?:creta(?:\s+ev)?|verna|venue|alcazar|tucson|kona|aura|grand\s+i10|i20|exter|ioniq|inster)\b", "Hyundai"),
    # Kia.
    (r"\b(?:seltos|sonet|carens|carnival|ev6|ev9|syros|clavis)\b", "Kia"),
    # Honda Cars.
    (r"\b(?:amaze|elevate)\b", "Honda"),
    (r"\bhonda\s+city\b", "Honda"),  # avoid catching "city" alone
    # Toyota.
    (r"\b(?:innova(?:\s+hycross)?|fortuner|hilux|hyryder|glanza|camry|vellfire|land\s+cruiser|rumion|taisor)\b", "Toyota"),
    # MG Motor.
    (r"\b(?:hector|astor|gloster|zs\s+ev|comet|windsor|cyberster|majestor|m9)\b", "MG Motor"),
    # Skoda.
    (r"\b(?:kushaq|slavia|kodiaq|kylaq)\b", "Skoda"),
    # Volkswagen.
    (r"\b(?:virtus|taigun|tiguan)\b", "Volkswagen"),
    # Renault.
    (r"\b(?:kiger|triber|kwid)\b", "Renault"),
    (r"\brenault\s+duster\b", "Renault"),
    # Nissan.
    (r"\b(?:magnite|x[- ]trail)\b", "Nissan"),
    # BYD.
    (r"\batto\s?[23]\b|\bsealion\b|\bemax\s?7\b|\bbyd\s+seal\b", "BYD"),
    # Ola Electric.
    (r"\bs1\s+(?:pro|air|x|gen)\b|\bola\s+(?:roadster|solo|s1)\b", "Ola Electric"),
    # Ather.
    (r"\bather\s?(?:450|rizta)\b|\b450\s?(?:apex|x|s|plus)\b", "Ather"),
    # TVS.
    (r"\b(?:iqube|ntorq|jupiter\s?(?:110|125)?|apache(?:\s+rtr)?|raider|ronin|tvs\s+x)\b", "TVS Motor"),
    # Bajaj.
    (r"\b(?:pulsar(?:\s+ns\s?400)?|chetak|avenger|platina|dominar|freedom\s?125)\b", "Bajaj Auto"),
    # Hero.
    (r"\b(?:splendor|passion|glamour|xtreme(?:\s?125r|\s?160r|\s?200s)?|karizma(?:\s+xmr)?|mavrick|vida(?:\s+v[12])?)\b", "Hero MotoCorp"),
    # Royal Enfield (maps to VE Commercial brand label → Eicher Motors).
    (r"\b(?:bullet\s?350|classic\s?350|hunter\s?350|himalayan\s?(?:450|411)?|meteor\s?350|interceptor\s?650|continental\s+gt|guerrilla|goan\s+classic|shotgun\s?650)\b", "VE Commercial"),
    # Ashok Leyland.
    (r"\b(?:bada\s+dost|ecomet|boss\s?lx|captain|avia|saathi|partner)\b", "Ashok Leyland"),
    # Luxury PV — only the recent / launch-relevant model names.
    (r"\b(?:eqs|eqe|amg\s+gt|gle|gls|s[- ]class)\b", "Mercedes-Benz"),
    (r"\b(?:ix1|ix3|i5|i7|x1|x3|x5|x7|7\s+series|5\s+series|3\s+series)\b", "BMW"),
    (r"\b(?:q3|q5|q7|q8|a4|a6|a8|e-tron|rs\s?[36]|rs\s?q8)\b", "Audi"),
    (r"\b(?:defender(?:\s+octa)?|range\s+rover(?:\s+(?:sport|velar|evoque))?|discovery\s+sport)\b", "JLR"),
    (r"\b(?:xc40|xc60|xc90|ex30|ex90|ex40)\b", "Volvo"),
    (r"\b(?:macan|cayenne|panamera|taycan|porsche\s+911)\b", "Porsche"),
]
MODEL_NAME_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(pattern, re.IGNORECASE), brand) for pattern, brand in MODEL_NAME_TO_BRAND
]


# --- Launch keyword patterns ----------------------------------------------
#
# Superset of the news-pipeline ``Product / Launch`` signal so we don't miss
# launches phrased with "introduces", "rolls out", "priced at", etc.
# Matched against the article's title + summary (lowercased).
LAUNCH_KEYWORDS = [
    r"\blaunch(?:es|ed|ing)?\b",
    r"\bunveil(?:s|ed|ing)?\b",
    r"\bdebut(?:s|ed|ing)?\b",
    r"\bintroduc(?:e|es|ed|ing|tion)\b",
    r"\brolls?\s+out\b",
    r"\brolled\s+out\b",
    r"\brolling\s+out\b",
    r"\bunwrap(?:s|ped|ping)?\b",
    r"\breveal(?:s|ed|ing)?\b",
    r"\bgoes?\s+on\s+sale\b",
    r"\bnow\s+on\s+sale\b",
    r"\bpriced\s+at\b",
    r"\bprice\s+revealed\b",
    r"\bex[- ]showroom\b",
    r"\bbookings?\s+(?:open|start|begin|commence|live|now)\b",
    r"\bopen\s+for\s+bookings?\b",
    r"\bdeliveries?\s+(?:begin|start|commence)\b",
    r"\bfirst\s+deliveries?\b",
    r"\bnew\s+model\b",
    r"\ball[- ]new\b",
    r"\bnext[- ]gen(?:eration)?\b",
    r"\bfacelift\b",
    r"\bnew\s+variant\b",
    r"\bnew\s+colou?r\b",
    r"\bnew\s+edition\b",
    r"\blimited\s+edition\b",
    r"\bspecial\s+edition\b",
    r"\bfirst\s+drive\b",
    r"\bspied\s+testing\b",
]
LAUNCH_RE = re.compile("|".join(LAUNCH_KEYWORDS), re.IGNORECASE)

# --- Negative keyword patterns --------------------------------------------
#
# If any of these match, the article is rejected even when a launch keyword
# fires. Designed to filter out the most common false-positive shapes:
#   * Quarterly / annual results (uses "unveils Q4 results", "launches FY26
#     report" phrasing);
#   * CSR / scholarship / training / internship announcements ("Maruti
#     launches scholarship program");
#   * Dealership / showroom / service-centre openings (often headlined as
#     "launches new dealership in <city>");
#   * Award / recognition stories.
NEGATIVE_KEYWORDS = [
    r"\bq[1-4]\s+(?:fy)?\s*(?:results?|earnings?)\b",
    r"\bquarter(?:ly)?\s+(?:results?|earnings?|profit|loss)\b",
    r"\bannual\s+(?:results?|report|general\s+meeting)\b",
    r"\bagm\b",
    r"\bdividend\b",
    r"\bbonus\s+share\b",
    r"\bearnings?\s+call\b",
    r"\bfy\d{2}\s+results?\b",
    r"\bcsr\b",
    r"\bscholarship\b",
    r"\binternship\b",
    r"\btraining\s+programme?\b",
    r"\beducation\s+programme?\b",
    r"\bdealership\s+(?:opens?|inaugurat|launches?)\b",
    r"\bshowroom\s+(?:opens?|inaugurat|launches?)\b",
    r"\bservice\s+(?:centre|center|station)\s+(?:opens?|inaugurat)\b",
    r"\bnew\s+(?:dealership|showroom|outlet|touchpoint)\b",
    r"\bbharat\s+mobility\b",  # expo coverage, not actual launches
    r"\bauto\s+expo\s+(?:preview|pavilion)\b",
    r"\baward\b",
    r"\brecognised\b",
    r"\brecognized\b",
    r"\bappoint(?:s|ed|ment)\b",
    r"\bmerger\b",
    r"\bjoint\s+venture\b",
    r"\bpartnership\s+with\b",
    r"\binvestment\s+of\s+(?:rs|inr|\$)\b",
    r"\bsponsorship\b",
    r"\bcampaign\b",
    r"\bseries\s+launch\b",  # often means a video / podcast series, not a vehicle
]
NEGATIVE_RE = re.compile("|".join(NEGATIVE_KEYWORDS), re.IGNORECASE)


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
                f"across {len(digest['companies'])} OEMs."
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
    seen_urls: set[str] = set()

    for article in articles:
        haystack = " ".join(
            part for part in [article.get("title", ""), article.get("summary", "")] if part
        )
        if not haystack:
            continue
        if NEGATIVE_RE.search(haystack):
            continue
        if not LAUNCH_RE.search(haystack):
            continue
        brand_def = _match_brand(article.get("brand_tags") or [])
        if not brand_def:
            brand_def = _match_brand_by_model_name(haystack)
        if not brand_def:
            continue
        url = article.get("url") or ""
        if url in seen_urls:
            continue
        seen_urls.add(url)

        item = {
            "title": article["title"],
            "summary": (article.get("summary") or "").strip(),
            "url": url,
            "source": article["source"],
            "published_at": article["published_at"],
            "published_display": article["published_display"],
            "company": brand_def["display"],
            "tone": brand_def["tone"],
            "scope": brand_def["scope"],
            "segment_tags": [t for t in (article.get("segment_tags") or []) if t != "General"],
            "image_url": article.get("image_url"),
        }
        items.append(item)
        by_company[brand_def["display"]].append(item)

    items.sort(key=lambda x: x["published_at"], reverse=True)
    items = items[:MAX_LAUNCHES]

    companies = []
    for company, rows in by_company.items():
        rows = sorted(rows, key=lambda x: x["published_at"], reverse=True)
        companies.append({
            "company": company,
            "tone": rows[0]["tone"],
            "scope": rows[0]["scope"],
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


def _match_brand(brand_tags: list[str]) -> dict[str, str] | None:
    for tag in brand_tags:
        definition = BRAND_DEFINITIONS.get(tag)
        if definition:
            return definition
    return None


def _match_brand_by_model_name(haystack: str) -> dict[str, str] | None:
    """Last-resort brand resolution: scan title+summary for popular model
    names. Lets us catch headlines like "BE 6 priced at ..." that don't
    spell out the brand. Order matters — first matching pattern wins, so
    keep the more-specific patterns earlier."""
    for pattern, brand_label in MODEL_NAME_PATTERNS:
        if pattern.search(haystack):
            return BRAND_DEFINITIONS.get(brand_label)
    return None


def _same_items(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return _item_keys(left) == _item_keys(right)


def _item_keys(digest: dict[str, Any]) -> set[str]:
    return {str(item.get("url") or "") for item in (digest.get("items") or []) if item.get("url")}
