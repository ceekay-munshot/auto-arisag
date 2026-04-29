from __future__ import annotations

import json
import re
import ssl
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from html import unescape
from typing import Any
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from .live_config import BSE_DETAIL_KEYWORDS, TRACKED_BSE_COMPANIES, SourceConfig


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
)


@dataclass
class CollectionResult:
    name: str
    status: str
    items: list[dict[str, Any]]
    message: str


def fetch_text(url: str, timeout: int = 6) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    context = ssl.create_default_context()
    with urlopen(request, timeout=timeout, context=context) as response:
        return response.read().decode("utf-8", errors="replace")


def collect_rss(source: SourceConfig, since: datetime) -> CollectionResult:
    try:
        raw_xml = fetch_text(source.url)
        root = ElementTree.fromstring(raw_xml)
        items: list[dict[str, Any]] = []
        for item in root.findall("./channel/item"):
            title = _xml_text(item.find("title"))
            link = _xml_text(item.find("link"))
            description = _xml_text(item.find("description"))
            published = _parse_date(_xml_text(item.find("pubDate")))
            if not published:
                published = _parse_date(_xml_text(item.find("{http://purl.org/dc/elements/1.1/}date")))
            if not title or not link or not published or published < since:
                continue

            media = item.find("{http://search.yahoo.com/mrss/}content")
            image_url = media.get("url") if media is not None else None
            items.append(
                _build_article(
                    source=source,
                    title=unescape(title),
                    url=link.strip(),
                    summary=_strip_html(description),
                    published_at=published,
                    image_url=image_url,
                )
            )

        items = _sort_and_limit(items, source.max_items)
        return CollectionResult(source.name, "ok" if items else "warning", items, f"{len(items)} recent items")
    except Exception as exc:  # noqa: BLE001
        return CollectionResult(source.name, "error", [], str(exc))


def collect_mobility_outlook(source: SourceConfig, since: datetime) -> CollectionResult:
    try:
        html = fetch_text(source.url)
        match = re.search(
            r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;\s*window\.__CLIENT_RENDER__",
            html,
            re.S,
        )
        if not match:
            raise ValueError("Could not locate embedded state payload.")

        payload = json.loads(match.group(1))
        seen: set[str] = set()
        items: list[dict[str, Any]] = []
        for record in _walk_mobility_payload(payload):
            article_url = urljoin(source.url, record["url"])
            if article_url in seen:
                continue
            seen.add(article_url)

            published = _parse_date(record.get("formattedDisplayDate") or record.get("displayDate"))
            if not published or published < since:
                continue

            items.append(
                _build_article(
                    source=source,
                    title=record.get("title", "").strip(),
                    url=article_url,
                    summary=(record.get("description") or "").strip(),
                    published_at=published,
                    image_url=record.get("imageUrl"),
                    author=record.get("authorName"),
                    category_hint=record.get("categoryMaskingName"),
                )
            )

        items = _sort_and_limit(items, source.max_items)
        return CollectionResult(source.name, "ok" if items else "warning", items, f"{len(items)} recent items")
    except Exception as exc:  # noqa: BLE001
        return CollectionResult(source.name, "error", [], str(exc))


def collect_siam_press_releases(source: SourceConfig, since: datetime) -> CollectionResult:
    try:
        listing_html = fetch_text(source.url)
        entries = _extract_siam_listing_entries(listing_html)
        items: list[dict[str, Any]] = []

        for entry in entries[: source.max_items]:
            detail_url = urljoin(source.url, entry["url"])
            detail_html = fetch_text(detail_url)
            published = _parse_date(_extract_first_match(detail_html, r'id="ContentPlaceHolder1_lbldate">([^<]+)<'))
            if not published or published < since:
                continue

            title = _extract_first_match(detail_html, r'id="ContentPlaceHolder1_lbltitle">([^<]+)<') or entry["title"]
            summary = _extract_siam_detail_summary(detail_html) or entry["summary"]
            items.append(
                _build_article(
                    source=source,
                    title=title,
                    url=detail_url,
                    summary=summary,
                    published_at=published,
                    article_type="industry_release",
                    segment_hints=_infer_siam_segments(summary),
                )
            )

        items = _sort_and_limit(items, source.max_items)
        return CollectionResult(source.name, "ok" if items else "warning", items, f"{len(items)} recent official releases")
    except Exception as exc:  # noqa: BLE001
        return CollectionResult(source.name, "error", [], str(exc))


def collect_siam_detail(source: SourceConfig, since: datetime) -> CollectionResult:
    try:
        detail_html = fetch_text(source.url)
        published = _parse_date(_extract_first_match(detail_html, r'id="ContentPlaceHolder1_lbldate">([^<]+)<'))
        if not published or published < since:
            return CollectionResult(source.name, "warning", [], "Current official release is outside the recent window")

        title = _extract_first_match(detail_html, r'id="ContentPlaceHolder1_lbltitle">([^<]+)<') or source.name
        summary = _extract_siam_detail_summary(detail_html)
        item = _build_article(
            source=source,
            title=title,
            url=source.url,
            summary=summary,
            published_at=published,
            article_type="industry_release",
            segment_hints=_infer_siam_segments(summary),
        )
        return CollectionResult(source.name, "ok", [item], "1 current official release")
    except Exception as exc:  # noqa: BLE001
        return CollectionResult(source.name, "error", [], str(exc))


def collect_bse_detail(source: SourceConfig, since: datetime) -> CollectionResult:
    try:
        html = fetch_text(source.url)
        published = _parse_date(_extract_first_match(html, r"&nbsp;\|&nbsp;<span class = 'anndt01'>([^<]+)</span>"))
        title = _extract_first_match(html, r"<td class='ann01'[^>]*>(.*?)&nbsp;\|&nbsp;")
        company = _extract_first_match(html, r"<a class='announcelink' target='_self'  href='StockReach.aspx\?scripcd=\d+'>([^<]+)<")
        subtitle = _extract_first_match(html, r"<td class='ann02'>(.*?)</td>")
        attachment_url = _extract_first_match(html, r"href = '([^']+\.pdf)'")
        if attachment_url:
            attachment_url = attachment_url.replace("\\", "")
        if not published or published < since or not title:
            return CollectionResult(source.name, "warning", [], "Validated BSE filing is outside the recent window")

        item = _build_article(
            source=source,
            title=title,
            url=source.url,
            summary=subtitle or title,
            published_at=published,
            article_type=_classify_bse_article_type(title),
            brand_hint="Maruti Suzuki",
            company=company or "Maruti Suzuki India Ltd",
            segment_hints=["Passenger Vehicles"],
            attachment_url=attachment_url,
        )
        return CollectionResult(source.name, "ok", [item], "1 validated official filing")
    except Exception as exc:  # noqa: BLE001
        return CollectionResult(source.name, "error", [], str(exc))


def collect_bse_announcements(source: SourceConfig, since: datetime) -> CollectionResult:
    items: list[dict[str, Any]] = []
    successful_company_pages = 0

    for company in TRACKED_BSE_COMPANIES:
        try:
            url = f"{source.url}?scripcd={company.bse_code}"
            html = fetch_text(url)
            successful_company_pages += 1
            company_name = _extract_first_match(html, r'id="spanCname" class="companyname">([^<]+)<') or company.label
            block = _extract_raw_match(html, r"<div id='divAnnText' class='announcetext'>(.*?)</div>", flags=re.S)
            if not block:
                continue

            announcement_matches = list(
                re.finditer(
                    r"<a href='(?P<link>MAnnDet\.aspx\?[^']+)'[^>]*>(?P<title>.*?)\s*,\s*(?P<date>[A-Za-z]{3}\s+\d{1,2}\s+\d{4})\s*,\s*(?P<time>[^<]+)</a>",
                    block,
                    re.S,
                )
            )[:1]
            for match in announcement_matches:
                title = _clean_html(match.group("title"))
                published = _parse_date(f"{match.group('date')} {match.group('time')}")
                if not published or published < since or not _matches_any(title, BSE_DETAIL_KEYWORDS):
                    continue

                detail_url = urljoin(url, match.group("link"))
                article_type = _classify_bse_article_type(title)
                summary = title

                items.append(
                    _build_article(
                        source=source,
                        title=title,
                        url=detail_url,
                        summary=summary,
                        published_at=published,
                        article_type=article_type,
                        brand_hint=company.label,
                        company=company_name,
                        segment_hints=list(company.segments),
                    )
                )
        except Exception:  # noqa: BLE001
            continue

    items = _sort_and_limit(items, source.max_items)
    return CollectionResult(
        source.name,
        "ok" if items else "warning",
        items,
        f"{len(items)} recent disclosures across {successful_company_pages} company pages",
    )


def _build_article(
    *,
    source: SourceConfig,
    title: str,
    url: str,
    summary: str,
    published_at: datetime,
    image_url: str | None = None,
    author: str | None = None,
    category_hint: str | None = None,
    article_type: str | None = None,
    brand_hint: str | None = None,
    segment_hints: list[str] | tuple[str, ...] | None = None,
    company: str | None = None,
    attachment_url: str | None = None,
) -> dict[str, Any]:
    return {
        "source": source.name,
        "source_type": source.source_type,
        "module_hint": source.module_hint,
        "title": title.strip(),
        "url": url.strip(),
        "summary": _condense_summary(summary),
        "published_at": published_at,
        "image_url": image_url,
        "author": author,
        "category_hint": category_hint,
        "article_type": article_type,
        "brand_hint": brand_hint,
        "segment_hints": list(segment_hints or []),
        "company": company,
        "attachment_url": attachment_url,
    }


def _sort_and_limit(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    items.sort(key=lambda item: item["published_at"], reverse=True)
    return items[:limit]


def _extract_siam_listing_entries(html: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    pattern = re.compile(
        r"<h6>\s*(?P<title>.*?)</h6>.*?<p>\s*(?P<summary>.*?)</p>.*?<a href=\"(?P<link>/news-&amp;-updates/press-releases/[^\"]+)\"",
        re.S | re.I,
    )
    for match in pattern.finditer(html):
        entries.append(
            {
                "title": _clean_html(match.group("title")),
                "summary": _clean_html(match.group("summary")),
                "url": unescape(match.group("link")),
            }
        )
    return entries


def _extract_siam_detail_summary(html: str) -> str:
    paragraphs = [_clean_html(match) for match in re.findall(r"<p[^>]*>(.*?)</p>", html, flags=re.S | re.I)]
    useful = [
        paragraph
        for paragraph in paragraphs
        if len(paragraph) > 50
        and "i/we hereby agree" not in paragraph.lower()
        and "all rights reserved" not in paragraph.lower()
        and "follow us" not in paragraph.lower()
        and "forgot your password" not in paragraph.lower()
    ]
    return " ".join(useful[:3]).strip()


def _infer_siam_segments(summary: str) -> list[str]:
    lowered = summary.lower()
    hints: list[str] = []
    if "passenger vehicle" in lowered:
        hints.append("Passenger Vehicles")
    if "two-wheeler" in lowered or "two wheeler" in lowered:
        hints.append("Two-Wheelers")
    if "three-wheeler" in lowered or "three wheeler" in lowered:
        hints.append("Commercial Vehicles")
    return hints
def _classify_bse_article_type(text: str) -> str:
    lowered = text.lower()
    if "investor presentation" in lowered:
        return "investor_presentation"
    if "annual report" in lowered:
        return "annual_report"
    if "transcript" in lowered or "conference call" in lowered or "con-call" in lowered:
        return "concall_transcript"
    if "change in management" in lowered or "management" in lowered:
        return "management_update"
    if "capacity" in lowered or "plant" in lowered or "capex" in lowered:
        return "capacity_update"
    if "results" in lowered:
        return "results_update"
    return "corporate_filing"


def _matches_any(text: str, patterns: list[str]) -> bool:
    lowered = text.lower()
    return any(re.search(pattern, lowered, re.I) for pattern in patterns)


def _extract_first_match(text: str, pattern: str, *, flags: int = 0) -> str | None:
    match = re.search(pattern, text, flags)
    if not match:
        return None
    return _clean_html(match.group(1))


def _extract_raw_match(text: str, pattern: str, *, flags: int = 0) -> str | None:
    match = re.search(pattern, text, flags)
    if not match:
        return None
    return match.group(1)


def _xml_text(node: ElementTree.Element | None) -> str | None:
    if node is None or node.text is None:
        return None
    return node.text.strip()


def _strip_html(value: str | None) -> str:
    if not value:
        return ""
    return _clean_html(value)


def _clean_html(value: str | None) -> str:
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", " ", value)
    text = text.replace("\xa0", " ")
    text = re.sub(r"\s+", " ", unescape(text))
    return text.strip()


def _condense_summary(summary: str) -> str:
    cleaned = _clean_html(summary)
    if len(cleaned) <= 420:
        return cleaned
    sentences = re.split(r"(?<=[.!?])\s+", cleaned)
    condensed = " ".join(sentences[:2]).strip()
    if condensed and len(condensed) <= 420:
        return condensed
    return cleaned[:417].rstrip() + "..."


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None

    value = re.sub(r"\s+", " ", value.strip())
    parsers = (
        lambda raw: parsedate_to_datetime(raw),
        lambda raw: datetime.fromisoformat(raw.replace("Z", "+00:00")),
        lambda raw: datetime.strptime(raw, "%m/%d/%Y %I:%M:%S %p"),
        lambda raw: datetime.strptime(raw, "%d/%m/%Y"),
        lambda raw: datetime.strptime(raw, "%d/%m/%Y %H:%M:%S"),
        lambda raw: datetime.strptime(raw, "%d/%m/%Y %I:%M:%S %p"),
        lambda raw: datetime.strptime(raw, "%b %d %Y %I:%M%p"),
        lambda raw: datetime.strptime(raw, "%d %b %Y"),
        lambda raw: datetime.strptime(raw, "%d %B %Y"),
        lambda raw: datetime.strptime(raw, "%Y-%m-%d"),
    )
    for parser in parsers:
        try:
            parsed = parser(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            return parsed.astimezone(UTC)
        except Exception:  # noqa: BLE001
            continue
    return None


def _walk_mobility_payload(payload: Any) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            looks_like_article = "title" in node and "url" in node and (
                "formattedDisplayDate" in node or "displayDate" in node or "description" in node
            )
            if looks_like_article:
                matches.append(node)
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(payload)
    return matches
