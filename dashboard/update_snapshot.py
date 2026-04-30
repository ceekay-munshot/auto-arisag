from __future__ import annotations

import json
import re
import subprocess
from io import BytesIO
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from html import unescape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from .config import DATA_SNAPSHOT_PATH

FADA_HOME_URL = "https://www.fada.in/"
SIAM_LATEST_URL = "https://www.siam.in/news-&-updates/press-releases"
ACMA_PRESS_RELEASE_URL = "https://www.acma.in/press-release.php"
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}
MONTH_LOOKUP = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}


@dataclass
class SourceUpdateResult:
    source: str
    status: str
    message: str
    updated: bool = False
    latest_value: str | None = None
    checked_at: str = ""

    def to_dict(self) -> dict[str, str | bool | None]:
        payload = asdict(self)
        if not payload["checked_at"]:
            payload["checked_at"] = datetime.now(UTC).isoformat()
        return payload


def refresh_snapshot(snapshot_path: Path = DATA_SNAPSHOT_PATH) -> list[dict[str, str | bool | None]]:
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    results: list[SourceUpdateResult] = []
    changed = False

    snapshot["fada"], fada_result = update_fada(snapshot["fada"])
    results.append(fada_result)
    changed = changed or fada_result.updated

    snapshot["siam"], siam_result = update_siam(snapshot["siam"])
    results.append(siam_result)
    changed = changed or siam_result.updated

    snapshot["acma"], acma_result = update_acma(snapshot["acma"])
    results.append(acma_result)
    changed = changed or acma_result.updated

    if changed:
        snapshot["as_of_date"] = date.today().isoformat()
        snapshot_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")

    return [result.to_dict() for result in results]


def update_fada(current: dict) -> tuple[dict, SourceUpdateResult]:
    existing_pdf_url = current.get("oem_source_url")
    existing_pdf_month = current.get("oem_latest_month")

    try:
        html, _ = fetch_text(FADA_HOME_URL)
    except Exception as exc:  # pragma: no cover - defensive network path
        promoted = try_promote_fada_from_existing_pdf(current)
        if promoted:
            refreshed, promoted_month = promoted
            return refreshed, ok_result(
                "FADA",
                f"Updated FADA retail snapshot to {month_label(promoted_month)} from the latest validated official PDF already cached in the dashboard.",
                promoted_month,
                updated=True,
            )
        return current, warning_result(
            "FADA",
            f"FADA refresh failed ({describe_exception(exc)}). Retained validated retail snapshot for {month_label(current['latest_month'])}.",
            current["latest_month"],
        )

    lowered = html.lower()
    if "badbot-detected.php" in lowered or "meta http-equiv=\"refresh\"" in lowered:
        promoted = try_promote_fada_from_existing_pdf(current)
        if promoted:
            refreshed, promoted_month = promoted
            return refreshed, ok_result(
                "FADA",
                f"FADA homepage blocked automation, so the dashboard promoted the latest validated official PDF already cached and updated retail to {month_label(promoted_month)}.",
                promoted_month,
                updated=True,
            )
        return current, warning_result(
            "FADA",
            f"FADA blocked automated access and redirected to anti-bot protection. Retained validated retail snapshot for {month_label(current['latest_month'])}.",
            current["latest_month"],
        )

    pdf_candidates = [
        urljoin(FADA_HOME_URL, html_unescape(match))
        for match in re.findall(r'href="([^"]*press-release[^"]+\.pdf)"', html, flags=re.IGNORECASE)
    ]
    detected_url = select_fada_vehicle_retail_pdf(pdf_candidates, current)
    if detected_url:
        try:
            pdf_bytes, resolved_url = fetch_binary(detected_url)
            refreshed, refreshed_month = update_fada_from_pdf(current, pdf_bytes, resolved_url or detected_url)
            oem_month = refreshed.get("oem_latest_month") or refreshed_month
            previous_oem_month = current.get("oem_latest_month") or current["latest_month"]
            previous_month = current["latest_month"]
            monthly_advanced = month_key(refreshed_month) > month_key(previous_month)
            oem_advanced = month_key(oem_month) > month_key(previous_oem_month)
            if monthly_advanced or oem_advanced:
                update_bits = []
                if monthly_advanced:
                    update_bits.append(f"retail snapshot to {month_label(refreshed_month)}")
                if oem_advanced:
                    update_bits.append(f"OEM tracker data to {month_label(oem_month)}")
                return refreshed, ok_result(
                    "FADA",
                    f"Updated FADA {' and '.join(update_bits)} from the latest official PDF.",
                    refreshed_month,
                    updated=True,
                )
            if refreshed != current:
                return refreshed, ok_result(
                    "FADA",
                    f"Revalidated FADA retail and OEM data for {month_label(refreshed_month)} from the latest official PDF.",
                    refreshed_month,
                    updated=True,
                )
            return current, ok_result(
                "FADA",
                f"No newer validated FADA monthly release was found. Latest retail month remains {month_label(previous_month)} and OEM tracker month remains {month_label(previous_oem_month)}.",
                previous_month,
            )
        except Exception as exc:
            return current, warning_result(
                "FADA",
                f"FADA page was reachable and a release PDF was detected, but PDF extraction failed ({describe_exception(exc)}). Retained validated retail snapshot for {month_label(current['latest_month'])}.",
                detected_url,
            )

    promoted = try_promote_fada_from_existing_pdf(current)
    if promoted:
        refreshed, promoted_month = promoted
        return refreshed, ok_result(
            "FADA",
            f"Updated FADA retail snapshot to {month_label(promoted_month)} from the latest validated official PDF already cached in the dashboard.",
            promoted_month,
            updated=True,
        )

    return current, warning_result(
        "FADA",
        f"FADA page layout did not expose a validated retail dataset. Retained validated retail snapshot for {month_label(current['latest_month'])}.",
        current["latest_month"],
    )


def update_siam(current: dict) -> tuple[dict, SourceUpdateResult]:
    try:
        html, final_url = fetch_text(SIAM_LATEST_URL)
    except Exception as exc:  # pragma: no cover - defensive network path
        return current, warning_result(
            "SIAM",
            f"SIAM refresh failed ({describe_exception(exc)}). Retained validated wholesale snapshot for {month_label(current['latest_month'])}.",
            current["latest_month"],
        )

    detected_month = detect_siam_month(html)
    if detected_month and month_key(detected_month) > month_key(current["latest_month"]):
        try:
            latest_release = parse_siam_release(html, final_url or SIAM_LATEST_URL)
        except ValueError as exc:
            return current, warning_result(
                "SIAM",
                f"SIAM latest page indicates a newer month ({month_label(detected_month)}) but detail validation failed ({exc}). Retained validated wholesale snapshot for {month_label(current['latest_month'])}.",
                detected_month,
            )
    else:
        try:
            detail_html, detail_url = fetch_text(current["source_url"])
            latest_release = parse_siam_release(detail_html, detail_url or current["source_url"])
        except Exception as exc:  # pragma: no cover - defensive network path
            return current, warning_result(
                "SIAM",
                f"SIAM current detail page could not be revalidated ({describe_exception(exc)}). Retained validated wholesale snapshot for {month_label(current['latest_month'])}.",
                current["latest_month"],
            )

    try:
        latest_release["month"]
    except Exception as exc:
        return current, warning_result(
            "SIAM",
            f"SIAM parse validation failed ({describe_exception(exc)}). Retained validated wholesale snapshot for {month_label(current['latest_month'])}.",
            current["latest_month"],
        )

    current_month = current["latest_month"]
    release_month = latest_release["month"]

    if month_key(release_month) < month_key(current_month):
        return current, ok_result(
            "SIAM",
            f"SIAM latest parse returned {month_label(release_month)}, which is older than the stored {month_label(current_month)}. Retained the newer validated snapshot.",
            current_month,
        )

    updated = False
    monthly_series = list(current["monthly_series"])
    record = {
        "month": release_month,
        "release_date": latest_release["release_date"],
        "source_url": latest_release["source_url"],
        "production_total": latest_release["production_total"],
        "domestic_sales": latest_release["domestic_sales"],
    }

    replaced = False
    for index, existing in enumerate(monthly_series):
        if existing["month"] == release_month:
            if existing != record:
                monthly_series[index] = record
                updated = True
            replaced = True
            break
    if not replaced:
        monthly_series.append(record)
        monthly_series.sort(key=lambda item: item["month"])
        updated = True

    refreshed = dict(current)
    refreshed["source_url"] = latest_release["source_url"]
    refreshed["coverage_note"] = latest_release["coverage_note"]
    if refreshed["latest_month"] != release_month or refreshed["latest_release_date"] != latest_release["release_date"]:
        refreshed["latest_month"] = release_month
        refreshed["latest_release_date"] = latest_release["release_date"]
        updated = True
    refreshed["monthly_series"] = monthly_series

    if updated:
        return refreshed, ok_result(
            "SIAM",
            f"Updated SIAM wholesale data to {month_label(release_month)} from the latest official release.",
            release_month,
            updated=True,
        )

    return refreshed, ok_result(
        "SIAM",
        f"No newer validated SIAM monthly release was found. Latest wholesale data remains {month_label(release_month)}.",
        release_month,
    )


def update_acma(current: dict) -> tuple[dict, SourceUpdateResult]:
    try:
        html, _ = fetch_text(ACMA_PRESS_RELEASE_URL)
    except Exception as exc:  # pragma: no cover - defensive network path
        return current, warning_result(
            "ACMA",
            f"ACMA refresh failed ({describe_exception(exc)}). Retained validated component snapshot for {current['period_label']}.",
            current["period_label"],
        )

    releases = parse_acma_releases(html)
    if not releases:
        return current, warning_result(
            "ACMA",
            f"ACMA press release page was reachable but no validated releases were parsed. Retained validated component snapshot for {current['period_label']}.",
            current["period_label"],
        )

    latest_relevant = select_acma_market_release(releases)
    if not latest_relevant:
        return current, warning_result(
            "ACMA",
            f"No relevant ACMA industry performance release was found on the live page. Retained validated component snapshot for {current['period_label']}.",
            current["period_label"],
        )

    current_date = parse_iso_date(current["release_date"])
    latest_date = latest_relevant["date"]
    if current_date and latest_date and latest_date <= current_date:
        return current, ok_result(
            "ACMA",
            f"No newer validated ACMA component-sector release was found. Latest validated snapshot remains {current['period_label']}.",
            current["period_label"],
        )

    return current, warning_result(
        "ACMA",
        f"Newer ACMA release detected ({latest_relevant['title']}, {latest_relevant['date'].strftime('%d %b %Y')}) but automated metric extraction is not yet fully validated. Retained prior validated component snapshot for {current['period_label']}.",
        latest_relevant["url"],
    )


def parse_siam_release(html: str, source_url: str) -> dict:
    title_match = re.search(
        r'ContentPlaceHolder1_lbltitle">Auto Industry Performance of ([A-Za-z]+)-(\d{4})<',
        html,
        flags=re.IGNORECASE,
    )
    date_match = re.search(r'ContentPlaceHolder1_lbldate">(\d{2}/\d{2}/\d{4})<', html)

    if not title_match or not date_match:
        raise ValueError("missing SIAM title or release date")

    month_name, year_text = title_match.groups()
    month = to_month_id(month_name, int(year_text))

    production_match = re.search(
        rf"Production:\s*</strong>.*?in\s+{re.escape(month_name)}\s+{year_text}\s+was\s+([\d,]+)\s+units",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    pv_match = re.search(
        rf"Passenger Vehicles.*?sales were\s+([\d,]+)\s+units in\s+{re.escape(month_name)}\s+{year_text}",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    three_w_match = re.search(
        rf"Three-wheeler sales were\s+([\d,]+)\s+units in\s+{re.escape(month_name)}\s+{year_text}",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    two_w_match = re.search(
        rf"Two-wheeler sales were\s+([\d,]+)\s+units in\s+{re.escape(month_name)}\s+{year_text}",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not all([production_match, pv_match, three_w_match, two_w_match]):
        raise ValueError("missing one or more SIAM volume fields")

    commentary_text = compact_text(html)
    pv_yoy = parse_float_match(r"Passenger Vehicles were sold.*?growth of ([0-9.]+)%", commentary_text)
    three_w_yoy = parse_float_match(r"Three-Wheelers witnessed a strong growth of ([0-9.]+)%", commentary_text)
    two_w_yoy = parse_float_match(r"Two-Wheelers grew by ([0-9.]+)%", commentary_text)

    coverage_match = re.search(
        r"<span[^>]*font-size:9px[^>]*>(.*?)</span>",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    coverage_note = compact_text(coverage_match.group(1)) if coverage_match else ""

    return {
        "month": month,
        "release_date": datetime.strptime(date_match.group(1), "%d/%m/%Y").strftime("%Y-%m-%d"),
        "source_url": source_url,
        "production_total": parse_indian_number(production_match.group(1)),
        "domestic_sales": {
            "PV": {"units": parse_indian_number(pv_match.group(1)), "yoy_pct": pv_yoy},
            "3W": {"units": parse_indian_number(three_w_match.group(1)), "yoy_pct": three_w_yoy},
            "2W": {"units": parse_indian_number(two_w_match.group(1)), "yoy_pct": two_w_yoy},
        },
        "coverage_note": coverage_note,
    }


def detect_siam_month(html: str) -> str | None:
    text = compact_text(html)
    # Old listing format: "Monthly Performance: February 2026"
    match = re.search(r"Monthly Performance:\s*([A-Za-z]+)\s+(\d{4})", text, flags=re.IGNORECASE)
    if match:
        month_name, year_text = match.groups()
        return to_month_id(month_name, int(year_text))
    # Newer listing format: "Auto Industry Performance of February-2026"
    match = re.search(
        r"Auto Industry Performance of\s+([A-Za-z]+)[-\s]+(\d{4})",
        text,
        flags=re.IGNORECASE,
    )
    if match:
        month_name, year_text = match.groups()
        if month_name.lower() in MONTH_LOOKUP:
            return to_month_id(month_name, int(year_text))
    # SIAM sometimes bundles March into a Q4 release ("Auto Industry Performance
    # of Q4 (Jan- March 2026) & FY 2025-26"); treat the closing month as the
    # latest monthly cadence.
    match = re.search(
        r"Auto Industry Performance of[^<]{0,80}?[(\-]\s*([A-Za-z]+)\s+(\d{4})",
        text,
        flags=re.IGNORECASE,
    )
    if match:
        month_name, year_text = match.groups()
        if month_name.lower() in MONTH_LOOKUP:
            return to_month_id(month_name, int(year_text))
    return None


def parse_acma_releases(html: str) -> list[dict]:
    pattern = re.compile(
        r'<div class="row hover-list-style.*?>\s*'
        r'.*?<a href="([^"]+)"[^>]*>\s*([^<]+?)\s*</a>\s*'
        r'.*?<span>\s*([^<]+?)\s*</span>',
        flags=re.IGNORECASE | re.DOTALL,
    )

    releases = []
    for href, title, raw_date in pattern.findall(html):
        parsed_date = parse_loose_date(raw_date)
        if not parsed_date:
            continue
        releases.append(
            {
                "url": urljoin(ACMA_PRESS_RELEASE_URL, html_unescape(href)),
                "title": compact_text(title),
                "date": parsed_date,
            }
        )
    releases.sort(key=lambda item: item["date"], reverse=True)
    return releases


def select_acma_market_release(releases: list[dict]) -> dict | None:
    keywords = (
        "industry performance",
        "performance review",
        "autocomponents industry",
        "auto component industry",
        "half yearly performance",
        "half-yearly performance",
    )
    for release in releases:
        title = release["title"].lower()
        if any(keyword in title for keyword in keywords):
            return release
    return None


def fetch_text(url: str, timeout: int = 20) -> tuple[str, str]:
    normalized_url = normalize_request_url(url)
    request = Request(normalized_url, headers=DEFAULT_HEADERS)
    try:
        with urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            text = response.read().decode(charset, errors="ignore")
            return text, response.geturl()
    except Exception:
        command = [
            "curl.exe",
            "--silent",
            "--show-error",
            "--location",
            "--compressed",
            "--max-time",
            str(timeout),
        ]
        for key, value in DEFAULT_HEADERS.items():
            command.extend(["-H", f"{key}: {value}"])
        marker = "__CODEX_EFFECTIVE_URL__:"
        command.extend(["--write-out", f"\n{marker}%{{url_effective}}", normalized_url])
        completed = subprocess.run(command, capture_output=True, check=False)
        if completed.returncode != 0:
            stderr = completed.stderr.decode("utf-8", errors="ignore").strip()
            raise RuntimeError(stderr or f"curl failed for {normalized_url}")
        raw = completed.stdout.decode("utf-8", errors="ignore")
        body, _, effective = raw.rpartition(f"\n{marker}")
        return body, (effective.strip() or normalized_url)


def fetch_binary(url: str, timeout: int = 60) -> tuple[bytes, str]:
    normalized_url = normalize_request_url(url)
    request = Request(normalized_url, headers=DEFAULT_HEADERS)
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.read(), response.geturl()
    except Exception:
        command = [
            "curl.exe",
            "--silent",
            "--show-error",
            "--location",
            "--compressed",
            "--max-time",
            str(timeout),
        ]
        for key, value in DEFAULT_HEADERS.items():
            command.extend(["-H", f"{key}: {value}"])
        marker = "__CODEX_EFFECTIVE_URL__:"
        command.extend(["--write-out", f"\n{marker}%{{url_effective}}", normalized_url])
        completed = subprocess.run(command, capture_output=True, check=False)
        if completed.returncode != 0:
            stderr = completed.stderr.decode("utf-8", errors="ignore").strip()
            raise RuntimeError(stderr or f"curl failed for {normalized_url}")
        stdout = completed.stdout
        marker_bytes = f"\n{marker}".encode("utf-8")
        body, _, effective = stdout.rpartition(marker_bytes)
        return body, effective.decode("utf-8", errors="ignore").strip() or normalized_url


def normalize_request_url(url: str) -> str:
    parts = urlsplit(url.strip())
    path = quote(unquote(parts.path), safe="/%:@()+,;=-_.!~*'")
    query = quote(unquote(parts.query), safe="=&/%:@()+,;,-_.!~*'")
    fragment = quote(unquote(parts.fragment), safe="")
    return urlunsplit((parts.scheme, parts.netloc, path, query, fragment))


def update_fada_oem_tables_from_pdf(current: dict, pdf_bytes: bytes, source_url: str) -> tuple[dict, str]:
    pages = extract_pdf_pages(pdf_bytes)
    month_id, release_date = parse_fada_pdf_header(pages[:3])
    parsed_tables = parse_fada_oem_annexure_tables(pages, current, month_id, source_url)

    refreshed = dict(current)
    refreshed["latest_oem_tables"] = parsed_tables
    refreshed["oem_latest_month"] = month_id
    refreshed["oem_latest_release_date"] = release_date
    refreshed["oem_source_url"] = source_url
    return refreshed, month_id


def update_fada_from_pdf(current: dict, pdf_bytes: bytes, source_url: str) -> tuple[dict, str]:
    pages = extract_pdf_pages(pdf_bytes)
    month_id, release_date = parse_fada_pdf_header(pages[:3])
    refreshed = update_fada_monthly_snapshot_from_pdf(current, pages, month_id, release_date, source_url)
    parsed_tables = parse_fada_oem_annexure_tables(pages, refreshed, month_id, source_url)
    refreshed["latest_oem_tables"] = parsed_tables
    refreshed["oem_latest_month"] = month_id
    refreshed["oem_latest_release_date"] = release_date
    refreshed["oem_source_url"] = source_url
    return refreshed, month_id


def extract_pdf_pages(pdf_bytes: bytes) -> list[str]:
    from pypdf import PdfReader

    reader = PdfReader(BytesIO(pdf_bytes))
    return [(page.extract_text() or "") for page in reader.pages]


def parse_fada_pdf_header(pages: list[str]) -> tuple[str, str]:
    header_text = " ".join(pages)
    month_names = "|".join(MONTH_LOOKUP.keys())
    month_match = re.search(
        r"FADA Releases FY['’]?\d+\s+and\s+([A-Za-z]+)['’]?(\d{2})\s+Vehicle Retail Data",
        header_text,
        flags=re.IGNORECASE,
    )
    if not month_match:
        raise ValueError("could not detect FADA OEM annexure month")
    month_name = month_match.group(1).strip().lower()
    year = 2000 + int(month_match.group(2))
    month_number = MONTH_LOOKUP[month_name]
    month_id = f"{year}-{month_number:02d}"

    date_match = re.search(
        rf"(\d{{1,2}})(st|nd|rd|th)?\s+({month_names})[’']?(\d{{2,4}})",
        header_text,
        flags=re.IGNORECASE,
    )
    if date_match:
        day = int(date_match.group(1))
        release_month = MONTH_LOOKUP[date_match.group(3).lower()]
        release_year_value = int(date_match.group(4))
        release_year = release_year_value if release_year_value >= 1000 else 2000 + release_year_value
        release_date = f"{release_year}-{release_month:02d}-{day:02d}"
    else:
        release_date = f"{year}-{month_number:02d}-01"
    return month_id, release_date


def parse_fada_oem_annexure_tables(pages: list[str], current: dict, month_id: str, source_url: str) -> dict[str, dict]:
    # Older FADA PDFs are shorter than the FY-closing March release, so a
    # hard-coded page index fails for back-dated months. Scan every page for
    # each category's OEM annexure heading and use whichever page matches.
    category_markers = {
        "2W": ("Two-Wheeler OEM",),
        "3W": ("Three-Wheeler OEM",),
        "CV": ("Commercial Vehicle OEM",),
        "CE": ("Construction Equipment OEM",),
        "PV": ("PV OEM", "Passenger Vehicle OEM"),
        "TRACTOR": ("Tractor OEM",),
    }
    # December and March releases include cumulative annexures (CY / FY) right
    # next to the actual monthly annexure. Match the monthly heading
    # specifically — "OEM wise Market Share Data for Dec'25" — so we land on
    # the monthly page, not the cumulative one.
    monthly_heading_re = re.compile(
        r"OEM wise Market Share Data for "
        r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)['’]?\d{2}\b",
        re.IGNORECASE,
    )
    monthly_pages = [
        index for index, text in enumerate(pages) if monthly_heading_re.search(text)
    ]

    def find_page(markers: tuple[str, ...]) -> str | None:
        # Prefer pages at or after the first monthly annexure heading; otherwise
        # fall back to any page that mentions the marker, and finally accept
        # nothing if the PDF really doesn't carry that category's annexure.
        candidate_indices = range(monthly_pages[0], len(pages)) if monthly_pages else range(len(pages))
        for index in candidate_indices:
            text = pages[index]
            if any(marker in text for marker in markers):
                return text
        for index in range(len(pages)):
            text = pages[index]
            if any(marker in text for marker in markers):
                return text
        return None

    current_tables = current.get("latest_oem_tables") or {}
    result: dict[str, dict] = {}
    for category, markers in category_markers.items():
        raw_text = find_page(markers)
        previous_rows = current_tables.get(category) or []
        if isinstance(previous_rows, dict):
            previous_rows = previous_rows.get("rows") or []
        rows = parse_fada_oem_page(category, raw_text, previous_rows) if raw_text else []
        result[category] = {
            "category": category,
            "label": fada_category_label(category),
            "rows": rows,
            "source_meta": {
                "name": "FADA",
                "url": source_url,
                "latest_month": month_id,
                "latest_label": month_label(month_id),
                "note": "Official FADA OEM annexure from the latest monthly retail PDF.",
            },
        }
    return result


def update_fada_monthly_snapshot_from_pdf(
    current: dict,
    pages: list[str],
    month_id: str,
    release_date: str,
    source_url: str,
) -> dict:
    monthly_pages = compact_pdf_pages(pages[5:10])
    prose_pages = compact_pdf_pages(pages[:6])
    fuel_pages = compact_pdf_pages(pages[6:8])
    urban_rural_pages = compact_pdf_pages(pages[8:10])

    monthly_record = parse_fada_monthly_record(monthly_pages, month_id, release_date, source_url)
    monthly_fuel_mix = parse_fada_monthly_fuel_mix(fuel_pages, month_id)
    urban_rural_growth = parse_fada_urban_rural_growth(urban_rural_pages)
    coverage_note = parse_fada_coverage_note(urban_rural_pages)
    latest_commentary = parse_fada_latest_commentary(prose_pages, month_id)

    refreshed = dict(current)
    refreshed["source_url"] = source_url
    refreshed["latest_month"] = month_id
    refreshed["latest_release_date"] = release_date
    refreshed["coverage_note"] = coverage_note
    refreshed["monthly_series"] = upsert_fada_monthly_record(current.get("monthly_series") or [], monthly_record)
    refreshed["inventory_days_pv"] = upsert_month_keyed_record(
        current.get("inventory_days_pv") or [],
        {"month": month_id, "days_low": latest_commentary["inventory_days"], "days_high": latest_commentary["inventory_days"]},
    )
    refreshed["dealer_growth_expectation"] = upsert_month_keyed_record(
        current.get("dealer_growth_expectation") or [],
        {
            "month": month_id,
            "next_month_growth_pct": latest_commentary["growth_expectation_next_month_pct"],
            "next_three_months_growth_pct": latest_commentary["growth_expectation_next_three_months_pct"],
        },
    )
    refreshed["latest_commentary"] = {
        "inventory_days_pv": str(latest_commentary["inventory_days"]),
        "growth_expectation_next_month_pct": latest_commentary["growth_expectation_next_month_pct"],
        "growth_expectation_next_three_months_pct": latest_commentary["growth_expectation_next_three_months_pct"],
        "liquidity_good_pct": latest_commentary["liquidity_good_pct"],
        "sentiment_good_pct": latest_commentary["sentiment_good_pct"],
        "bullets": build_fada_bullets(month_id, monthly_record, latest_commentary["inventory_days"]),
    }
    refreshed["latest_urban_rural_growth"] = urban_rural_growth
    refreshed["latest_subsegments"] = build_fada_latest_subsegments(monthly_pages)
    refreshed["latest_fuel_mix"] = monthly_fuel_mix
    refreshed["ev_share_series"] = upsert_fada_ev_share_series(current.get("ev_share_series") or [], month_id, monthly_fuel_mix)
    return refreshed


def compact_pdf_pages(pages: list[str]) -> str:
    text = " ".join(page or "" for page in pages)
    text = text.replace("\u2019", "'").replace("\u2018", "'").replace("\u2013", "-").replace("\u2014", "-")
    return re.sub(r"\s+", " ", text).strip()


def select_fada_vehicle_retail_pdf(candidates: list[str], current: dict) -> str | None:
    vehicle_candidates = [candidate for candidate in candidates if is_fada_vehicle_retail_pdf(candidate)]
    if not vehicle_candidates:
        return None
    vehicle_candidates.sort(key=fada_pdf_sort_key, reverse=True)
    return vehicle_candidates[0]


def is_fada_vehicle_retail_pdf(url: str) -> bool:
    normalized = html_unescape(url).lower()
    return "vehicle%20retail%20data" in normalized or "vehicle retail data" in normalized


def fada_pdf_sort_key(url: str) -> tuple[int, int]:
    normalized = html_unescape(url)
    match = re.search(r"(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4}|\d{2})", normalized, flags=re.IGNORECASE)
    if not match:
        return (0, 0)
    month_number = MONTH_LOOKUP[match.group(1).lower()]
    year_value = int(match.group(2))
    year = year_value if year_value >= 1000 else 2000 + year_value
    return (year, month_number)


def try_promote_fada_from_existing_pdf(current: dict) -> tuple[dict, str] | None:
    latest_month = current.get("latest_month")
    oem_month = current.get("oem_latest_month")
    oem_url = current.get("oem_source_url")
    if not latest_month or not oem_month or not oem_url:
        return None
    if month_key(oem_month) <= month_key(latest_month):
        return None
    pdf_bytes, resolved_url = fetch_binary(oem_url)
    refreshed, promoted_month = update_fada_from_pdf(current, pdf_bytes, resolved_url or oem_url)
    if month_key(refreshed["latest_month"]) <= month_key(latest_month):
        return None
    return refreshed, promoted_month


def parse_fada_monthly_record(compact_pages: str, month_id: str, release_date: str, source_url: str) -> dict:
    month_name = datetime.strptime(month_id, "%Y-%m").strftime("%b")
    year_suffix = datetime.strptime(month_id, "%Y-%m").strftime("%y")
    start_marker = f"All India Vehicle Retail Data for {month_name}'{year_suffix}"
    start_index = compact_pages.find(start_marker)
    if start_index == -1:
        raise ValueError(f"could not locate FADA monthly retail table for {month_label(month_id)}")
    section = compact_pages[start_index:]
    end_index = section.find("Source: FADA Research")
    if end_index != -1:
        section = section[:end_index]

    category_lookup = {
        "2W": "2W",
        "3W": "3W",
        "PV": "PV",
        "TRAC": "TRACTOR",
        "CE": "CE",
        "CV": "CV",
        "Total": "TOTAL",
    }
    categories: dict[str, dict[str, float | int]] = {}
    for label, category in category_lookup.items():
        pattern = re.compile(
            rf"{re.escape(label)}\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%",
            flags=re.IGNORECASE,
        )
        match = pattern.search(section)
        if not match:
            raise ValueError(f"could not parse FADA retail row for {label}")
        categories[category] = {
            "units": parse_indian_number(match.group(1)),
            "mom_pct": float(match.group(4)),
            "yoy_pct": float(match.group(5)),
        }

    return {
        "month": month_id,
        "release_date": release_date,
        "source_url": source_url,
        "categories": categories,
    }


def parse_fada_monthly_fuel_mix(compact_pages: str, month_id: str) -> dict[str, dict[str, float]]:
    month_name = datetime.strptime(month_id, "%Y-%m").strftime("%b")
    year_suffix = datetime.strptime(month_id, "%Y-%m").strftime("%y")
    marker = f"All India Fuel Wise Vehicle Retail Data for {month_name}'{year_suffix}"
    start_index = compact_pages.find(marker)
    if start_index == -1:
        raise ValueError(f"could not locate FADA fuel-mix table for {month_label(month_id)}")
    section = compact_pages[start_index:]
    pct = r"(-?[\d.]+)%"
    pair_2w_3w_chunk = extract_between(
        section,
        f"Two-Wheeler {month_name}'{year_suffix} Feb'{year_suffix} {month_name}'25 Three-Wheeler {month_name}'{year_suffix} Feb'{year_suffix} {month_name}'25",
        "Media Contact|",
    )
    pair_cv_ce_chunk = extract_between(
        section,
        f"Commercial Vehicle {month_name}'{year_suffix} Feb'{year_suffix} {month_name}'25 Construction Equipment {month_name}'{year_suffix} Feb'{year_suffix} {month_name}'25",
        f"Passenger Vehicle {month_name}'{year_suffix} Feb'{year_suffix} {month_name}'25 Tractor {month_name}'{year_suffix} Feb'{year_suffix} {month_name}'25",
    )
    pair_pv_tractor_chunk = extract_between(
        section,
        f"Passenger Vehicle {month_name}'{year_suffix} Feb'{year_suffix} {month_name}'25 Tractor {month_name}'{year_suffix} Feb'{year_suffix} {month_name}'25",
        "Source: FADA Research",
    )

    pair_2w_3w = re.search(
        rf"PETROL/ETHANOL\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"EV\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"EV\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"CNG/LPG\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"CNG/LPG\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"DIESEL\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"Total\s+100%\s+100%\s+100%\s+"
        rf"PETROL/ETHANOL\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"Total\s+100%\s+100%\s+100%",
        pair_2w_3w_chunk,
        flags=re.IGNORECASE,
    )
    pair_cv_ce = re.search(
        rf"Diesel\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"Diesel\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"CNG/LPG\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"CNG/LPG\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"PETROL/ETHANOL\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"PETROL/ETHANOL\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"EV\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"EV\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"HYBRID\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"Total\s+100%\s+100%\s+100%\s+Total\s+100%\s+100%\s+100%",
        pair_cv_ce_chunk,
        flags=re.IGNORECASE,
    )
    pair_pv_tractor = re.search(
        rf"PETROL/ETHANOL\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"Diesel\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"Diesel\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"PETROL/ETHANOL\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"CNG/LPG\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"Total\s+100%\s+100%\s+100%\s+"
        rf"HYBRID\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"EV\s+{pct}\s+{pct}\s+{pct}\s+"
        rf"Total\s+100%\s+100%\s+100%",
        pair_pv_tractor_chunk,
        flags=re.IGNORECASE,
    )
    if not all([pair_2w_3w, pair_cv_ce, pair_pv_tractor]):
        raise ValueError(f"could not parse FADA fuel-mix pairs for {month_label(month_id)}")

    two_w_vals = [float(item) for item in pair_2w_3w.groups()]
    cv_vals = [float(item) for item in pair_cv_ce.groups()]
    pv_vals = [float(item) for item in pair_pv_tractor.groups()]
    return {
        "2W": {
            "Petrol / Ethanol": two_w_vals[0],
            "EV": two_w_vals[6],
            "CNG / LPG": two_w_vals[12],
        },
        "3W": {
            "EV": two_w_vals[3],
            "CNG / LPG": two_w_vals[9],
            "Diesel": two_w_vals[15],
            "Petrol / Ethanol": two_w_vals[18],
        },
        "CV": {
            "Diesel": cv_vals[0],
            "CNG / LPG": cv_vals[6],
            "Petrol / Ethanol": cv_vals[12],
            "EV": cv_vals[18],
            "Hybrid": cv_vals[24],
        },
        "CE": {
            "Diesel": cv_vals[3],
            "CNG / LPG": cv_vals[9],
            "Petrol / Ethanol": cv_vals[15],
            "EV": cv_vals[21],
        },
        "PV": {
            "Petrol / Ethanol": pv_vals[0],
            "Diesel": pv_vals[6],
            "CNG / LPG": pv_vals[12],
            "Hybrid": pv_vals[15],
            "EV": pv_vals[18],
        },
        "TRACTOR": {
            "Diesel": pv_vals[3],
            "Petrol / Ethanol": pv_vals[9],
        },
    }


def extract_between(value: str, start_marker: str, end_marker: str) -> str:
    start_index = value.find(start_marker)
    if start_index == -1:
        raise ValueError(f"could not locate section start: {start_marker}")
    start_index += len(start_marker)
    end_index = value.find(end_marker, start_index)
    if end_index == -1:
        raise ValueError(f"could not locate section end: {end_marker}")
    return value[start_index:end_index]


def parse_fada_urban_rural_growth(compact_pages: str) -> list[dict[str, float | str]]:
    marker = "Mar'26 Category MoM% YoY% Category MoM% YoY%"
    start_index = compact_pages.find(marker)
    if start_index == -1:
        raise ValueError("could not locate FADA urban-rural growth table")
    section = compact_pages[start_index:]
    end_index = section.find("Source: FADA Research")
    if end_index != -1:
        section = section[:end_index]

    category_pairs = [("2W", "CV"), ("3W", "CE"), ("PV", "TRAC")]
    results: list[dict[str, float | str]] = []
    pct_pattern = r"(-?[\d.]+)%"

    for left, right in category_pairs:
        pattern = re.compile(
            rf"{re.escape(left)}\s+{re.escape(right)}\s+"
            rf"Urban\s+{pct_pattern}\s+{pct_pattern}\s+Urban\s+{pct_pattern}\s+{pct_pattern}\s+"
            rf"Rural\s+{pct_pattern}\s+{pct_pattern}\s+Rural\s+{pct_pattern}\s+{pct_pattern}\s+"
            rf"Total\s+{pct_pattern}\s+{pct_pattern}\s+Total\s+{pct_pattern}\s+{pct_pattern}",
            flags=re.IGNORECASE,
        )
        match = pattern.search(section)
        if not match:
            raise ValueError(f"could not parse FADA urban-rural block for {left} / {right}")
        values = [float(item) for item in match.groups()]
        results.extend(
            [
                {
                    "category": "TRACTOR" if left == "TRAC" else left,
                    "urban_mom_pct": values[0],
                    "urban_yoy_pct": values[1],
                    "rural_mom_pct": values[4],
                    "rural_yoy_pct": values[5],
                },
                {
                    "category": "TRACTOR" if right == "TRAC" else right,
                    "urban_mom_pct": values[2],
                    "urban_yoy_pct": values[3],
                    "rural_mom_pct": values[6],
                    "rural_yoy_pct": values[7],
                },
            ]
        )

    total_match = re.search(
        rf"Total\s+Urban\s+{pct_pattern}\s+{pct_pattern}\s+Rural\s+{pct_pattern}\s+{pct_pattern}\s+Total\s+{pct_pattern}\s+{pct_pattern}",
        section,
        flags=re.IGNORECASE,
    )
    if not total_match:
        raise ValueError("could not parse FADA overall urban-rural totals")
    total_values = [float(item) for item in total_match.groups()]
    results.append(
        {
            "category": "TOTAL",
            "urban_mom_pct": total_values[0],
            "urban_yoy_pct": total_values[1],
            "rural_mom_pct": total_values[2],
            "rural_yoy_pct": total_values[3],
        }
    )
    return results


def parse_fada_coverage_note(compact_pages: str) -> str:
    match = re.search(
        r"Vehicle Retail Data has been collated as on\s+(.+?)\.\s*3- Commercial",
        compact_pages,
        flags=re.IGNORECASE,
    )
    if not match:
        raise ValueError("could not parse FADA coverage note")
    return f"Vehicle Retail Data has been collated as on {match.group(1).strip()}."


def parse_fada_latest_commentary(compact_pages: str, month_id: str) -> dict[str, float | int]:
    month_name = datetime.strptime(month_id, "%Y-%m").strftime("%B")
    month_suffix = datetime.strptime(month_id, "%Y-%m").strftime("%y")

    inventory_match = re.search(
        r"PV inventory (?:normalised|normalized) to ~?(\d+) days",
        compact_pages,
        flags=re.IGNORECASE,
    ) or re.search(
        r"inventory at approximately (\d+) days",
        compact_pages,
        flags=re.IGNORECASE,
    )
    if not inventory_match:
        raise ValueError("could not parse FADA PV inventory days")

    next_month_match = re.search(
        rf"Expectation from (?:{month_name}|[A-Za-z]+)'?{month_suffix}\s*o\s*Growth\s+([\d.]+)%",
        compact_pages,
        flags=re.IGNORECASE,
    )
    if not next_month_match:
        next_month_match = re.search(r"Expectation from [A-Za-z]+'?\d{2}\s*o\s*Growth\s+([\d.]+)%", compact_pages, flags=re.IGNORECASE)
    next_three_match = re.search(
        r"Expectation in next 3 months.*?o\s*Growth\s+([\d.]+)%",
        compact_pages,
        flags=re.IGNORECASE,
    )
    liquidity_match = re.search(r"Liquidity[:\s|o-]*Good\s+([\d.]+)%", compact_pages, flags=re.IGNORECASE)
    sentiment_match = re.search(r"Sentiment[:\s|o-]*Good\s+([\d.]+)%", compact_pages, flags=re.IGNORECASE)

    if not all([next_month_match, next_three_match, liquidity_match, sentiment_match]):
        raise ValueError("could not parse FADA dealer survey metrics")

    return {
        "inventory_days": int(inventory_match.group(1)),
        "growth_expectation_next_month_pct": float(next_month_match.group(1)),
        "growth_expectation_next_three_months_pct": float(next_three_match.group(1)),
        "liquidity_good_pct": float(liquidity_match.group(1)),
        "sentiment_good_pct": float(sentiment_match.group(1)),
    }


def build_fada_latest_subsegments(compact_pages: str) -> dict[str, list[dict[str, float | int | str]]]:
    month_name = ""
    month_match = re.search(r"All India Vehicle Retail Data for ([A-Za-z]+)'\d{2}", compact_pages)
    if month_match:
        month_name = month_match.group(1)
    marker = f"All India Vehicle Retail Data for {month_name}'" if month_name else "All India Vehicle Retail Data for "
    start_index = compact_pages.find(marker)
    section = compact_pages[start_index:] if start_index != -1 else compact_pages

    subsegment_map = {
        "3W": [
            (r"E-RICKSHAW\(P\)", "E-rickshaw passenger"),
            (r"E-RICKSHAW WITH CART \(G\)", "E-rickshaw goods"),
            ("THREE-WHEELER \\(GOODS\\)", "3W goods"),
            ("THREE ?-WHEELER \\(PASSENGER\\)", "3W passenger"),
            ("THREE-WHEELER \\(PERSONAL\\)", "3W personal"),
        ],
        "CV": [
            ("LCV", "LCV"),
            ("MCV", "MCV"),
            ("HCV", "HCV"),
            ("Others", "Others"),
        ],
    }

    result: dict[str, list[dict[str, float | int | str]]] = {}
    for category, definitions in subsegment_map.items():
        rows = []
        for raw_label, label in definitions:
            match = re.search(
                rf"{raw_label}\s+([\d,]+)\s+[\d,]+\s+[\d,]+\s+(-?[\d.]+)%\s+(-?[\d.]+)%",
                section,
                flags=re.IGNORECASE,
            )
            if not match:
                continue
            rows.append(
                {
                    "label": label,
                    "units": parse_indian_number(match.group(1)),
                    "mom_pct": float(match.group(2)),
                    "yoy_pct": float(match.group(3)),
                }
            )
        result[category] = rows
    return result


def build_fada_bullets(month_id: str, monthly_record: dict, inventory_days: int) -> list[str]:
    categories = monthly_record["categories"]
    total_units = categories["TOTAL"]["units"]
    return [
        f"{month_label(month_id)} retail closed at {total_units:,} units with {categories['TOTAL']['yoy_pct']:+.2f}% YoY growth and {categories['TOTAL']['mom_pct']:+.2f}% MoM momentum.".replace(",", ","),
        f"Two-wheelers led volumes at {categories['2W']['units']:,} units ({categories['2W']['yoy_pct']:+.2f}% YoY), while passenger vehicles hit {categories['PV']['units']:,} units ({categories['PV']['yoy_pct']:+.2f}% YoY).".replace(",", ","),
        f"PV inventory stayed healthy at about {inventory_days} days, keeping wholesale-retail alignment much tighter than a year ago.",
        "Dealer outlook stayed constructive but measured, with positive demand expectations for both the next month and the next three months.",
    ]


def upsert_fada_monthly_record(records: list[dict], new_record: dict) -> list[dict]:
    updated = [dict(item) for item in records]
    replaced = False
    for index, item in enumerate(updated):
        if item.get("month") == new_record["month"]:
            updated[index] = new_record
            replaced = True
            break
    if not replaced:
        updated.append(new_record)
    updated.sort(key=lambda item: item["month"])
    return updated


def upsert_month_keyed_record(records: list[dict], new_record: dict) -> list[dict]:
    updated = [dict(item) for item in records]
    replaced = False
    for index, item in enumerate(updated):
        if item.get("month") == new_record["month"]:
            updated[index] = new_record
            replaced = True
            break
    if not replaced:
        updated.append(new_record)
    updated.sort(key=lambda item: item["month"])
    return updated


def upsert_fada_ev_share_series(records: list[dict], month_id: str, monthly_fuel_mix: dict[str, dict[str, float]]) -> list[dict]:
    updated = [dict(item) for item in records if item.get("month") != month_id]
    for category in ["2W", "3W", "PV", "CV"]:
        ev_share = monthly_fuel_mix.get(category, {}).get("EV")
        if ev_share is None:
            continue
        updated.append({"month": month_id, "category": category, "ev_share_pct": ev_share})
    updated.sort(key=lambda item: (item["month"], item["category"]))
    return updated


def parse_fada_oem_page(category: str, text: str, previous_rows: list[dict]) -> list[dict]:
    canonical_lookup = {normalize_oem_key(item["oem"]): item["oem"] for item in previous_rows}

    # The "Others" / "Others including EV" row is title-case in FADA's PDF, so the
    # uppercase-only OEM regex below cannot capture it. Pull it out first and strip
    # it from the text — otherwise the trailing "EV" gets matched by the main regex
    # and becomes a phantom OEM named "Ev".
    others_pattern = re.compile(
        r"\bOthers(?:\s+[Ii]ncluding\s+EV)?\s+([-\d,]+)\s+([\d.]+)%\s+([-\d,]+)\s+([\d.]+)%"
    )
    others_row: dict | None = None
    others_match = others_pattern.search(text)
    if others_match:
        others_row = {
            "oem": "Others",
            "units": parse_indian_number(others_match.group(1)),
            "share_pct": float(others_match.group(2)),
            "prior_units": parse_indian_number(others_match.group(3)),
            "prior_share_pct": float(others_match.group(4)),
        }
        text = text[: others_match.start()] + text[others_match.end() :]

    row_pattern = re.compile(r"([A-Z0-9&().,'/\- ]+?)\s+([-\d,]+)\s+([\d.]+)%\s+([-\d,]+)\s+([\d.]+)%")
    parsed = []
    seen = set()
    for match in row_pattern.finditer(text):
        raw_name = " ".join(match.group(1).split())
        raw_name = re.sub(r"^['’]?\d{2}\s+", "", raw_name).strip()
        if raw_name.upper() in {"ANNEXURE 2", "TOTAL", "SOURCE: FADA RESEARCH"}:
            continue
        canonical_name = map_fada_oem_name(category, raw_name, canonical_lookup)
        if not canonical_name:
            continue
        if canonical_name in seen:
            continue
        seen.add(canonical_name)
        parsed.append(
            {
                "oem": canonical_name,
                "units": parse_indian_number(match.group(2)),
                "share_pct": float(match.group(3)),
                "prior_units": parse_indian_number(match.group(4)),
                "prior_share_pct": float(match.group(5)),
            }
        )

    if others_row and "Others" not in seen:
        parsed.append(others_row)
    return parsed


def map_fada_oem_name(category: str, raw_name: str, canonical_lookup: dict[str, str]) -> str | None:
    normalized = normalize_oem_key(raw_name)
    explicit = {
        "2W": {
            "HERO MOTOCORP LTD": "Hero MotoCorp",
            "HONDA MOTORCYCLE AND SCOOTER INDIA (P) LTD": "Honda Motorcycle & Scooter India",
            "TVS MOTOR COMPANY LTD": "TVS Motor",
            "BAJAJ AUTO GROUP": "Bajaj Auto",
            "BAJAJ AUTO LTD": None,
            "CHETAK TECHNOLOGY LIMITED": None,
            "SUZUKI MOTORCYCLE INDIA PVT LTD": "Suzuki Motorcycle India",
            "ROYAL-ENFIELD (UNIT OF EICHER LTD)": "Royal Enfield",
            "INDIA YAMAHA MOTOR PVT LTD": "India Yamaha Motor",
            "ATHER ENERGY LTD": "Ather Energy",
            "OLA ELECTRIC TECHNOLOGIES PVT LTD": "Ola Electric",
            "GREAVES ELECTRIC MOBILITY PVT LTD": "Greaves Electric Mobility",
            "CLASSIC LEGENDS PVT LTD": "Classic Legends",
            "RIVER MOBILITY PVT LTD": "River Mobility",
            "BGAUSS AUTO PRIVATE LIMITED": "BGauss Auto",
            "PIAGGIO VEHICLES PVT LTD": "Piaggio Vehicles",
            "OTHERS INCLUDING EV": "Others",
        },
        "3W": {
            "BAJAJ AUTO LTD": "Bajaj Auto",
            # FADA's 3W annexure lists Mahindra & Mahindra as a parent group whose
            # sub-rows are MAHINDRA LAST MILE MOBILITY LTD and a 34-unit M&M leaf.
            # The parent total already includes both, so drop the child rows.
            "MAHINDRA & MAHINDRA LIMITED": "Mahindra & Mahindra",
            "MAHINDRA LAST MILE MOBILITY LTD": None,
            "PIAGGIO VEHICLES PVT LTD": "Piaggio Vehicles",
            "TVS MOTOR COMPANY LTD": "TVS Motor",
            "ATUL AUTO LTD": "Atul Auto",
            "YC ELECTRIC VEHICLE": "YC Electric Vehicle",
            "DILLI ELECTRIC AUTO PVT LTD": "Dilli Electric Auto",
            "SAERA ELECTRIC AUTO PVT LTD": "Saera Electric Auto",
            "J. S. AUTO (P) LTD": "J. S. Auto",
            "OTHERS INCLUDING EV": "Others",
        },
        "CV": {
            "TATA MOTORS LTD": "Tata Motors",
            "MAHINDRA & MAHINDRA LIMITED": "Mahindra Group",
            "MAHINDRA LAST MILE MOBILITY LTD": None,
            "ASHOK LEYLAND LTD": "Ashok Leyland Group",
            "SWITCH MOBILITY AUTOMOTIVE LTD": None,
            "VE COMMERCIAL VEHICLES LTD": "VE Commercial Vehicles",
            "VE COMMERCIAL VEHICLES LTD (VOLVO BUSES DIVISION)": None,
            "MARUTI SUZUKI INDIA LTD": "Maruti Suzuki",
            "FORCE MOTORS LIMITED": "Force Motors",
            "DAIMLER INDIA COMMERCIAL VEHICLES PVT. LTD": "Daimler India Commercial Vehicles",
            "SML ISUZU LTD": "SML Isuzu",
            "OTHERS": "Others",
        },
        "CE": {
            "JCB INDIA LIMITED": "JCB India",
            "ACTION CONSTRUCTION EQUIPMENT LTD.": "Action Construction Equipment",
            "AJAX ENGINEERING LTD": "Ajax Engineering",
            "ESCORTS KUBOTA LIMITED (CONSTRUCTION EQUIPMENT)": "Escorts Kubota CE",
            "BULL MACHINES PVT LTD": "Bull Machines",
            "TATA HITACHI CONSTRUCTION MACHINERY COMP. PVT LTD": "Tata Hitachi",
            "CASE NEW HOLLAND CONSTRUCTION EQUIPMENT(I) PVT LTD": "CNH Construction Equipment",
            "CATERPILLAR INDIA PRIVATE LIMITED": "Caterpillar India",
            "M/S SCHWING STETTER (INDIA) PRIVATE LIMITED": "Schwing Stetter",
            "ALL TERRAIN CRANE": "All Terrain Crane",
            "MAHINDRA & MAHINDRA LIMITED": "Mahindra & Mahindra",
            "INDO FARM EQUIPMENT LIMITED": "Indo Farm Equipment",
            "DOOSAN BOBCAT INDIA PVT LTD": "Doosan Bobcat India",
            "OTHERS": "Others",
        },
        "PV": {
            "MARUTI SUZUKI INDIA LTD": "Maruti Suzuki",
            "TATA MOTORS LTD": "Tata Motors",
            "MAHINDRA & MAHINDRA LIMITED": "Mahindra & Mahindra",
            "HYUNDAI MOTOR INDIA LTD": "Hyundai Motor India",
            "KIA INDIA PRIVATE LIMITED": "Kia India",
            "TOYOTA KIRLOSKAR MOTOR PVT LTD": "Toyota Kirloskar Motor",
            "SKODA AUTO VOLKSWAGEN GROUP": "Skoda Auto Volkswagen Group",
            "SKODA AUTO VOLKSWAGEN INDIA PVT LTD": None,
            "VOLKSWAGEN AG/INDIA PVT. LTD.": None,
            "AUDI AG": None,
            "SKODA AUTO INDIA/AS PVT LTD": None,
            "JSW MG MOTOR INDIA PVT LTD": "JSW MG Motor India",
            "HONDA CARS INDIA LTD": "Honda Cars India",
            "RENAULT INDIA PVT LTD": "Renault India",
            "NISSAN MOTOR INDIA PVT LTD": "Nissan Motor India",
            "BMW INDIA PVT LTD": "BMW India",
            "MERCEDES -BENZ GROUP": "Mercedes-Benz Group",
            "MERCEDES-BENZ INDIA PVT LTD": None,
            "MERCEDES -BENZ AG": None,
            "DAIMLER AG": None,
            "MERCEDES BENZ": None,
            "FORCE MOTORS LIMITED": "Force Motors",
            "STELLANTIS GROUP": "Stellantis Group",
            "STELLANTIS AUTOMOBILES INDIA PVT LTD": None,
            "STELLANTIS INDIA PVT LTD": None,
            "VINFAST AUTO INDIA PVT LTD": "VinFast Auto India",
            "JAGUAR LAND ROVER INDIA LIMITED": "Jaguar Land Rover India",
            "BYD INDIA PRIVATE LIMITED": "BYD India",
            "OTHERS": "Others",
        },
        "TRACTOR": {
            "MAHINDRA & MAHINDRA LIMITED (TRACTOR)": "Mahindra Tractors",
            "MAHINDRA & MAHINDRA LIMITED (SWARAJ DIVISION)": "Swaraj",
            "INTERNATIONAL TRACTORS LIMITED": "International Tractors",
            "ESCORTS KUBOTA LIMITED (AGRI MACHINERY GROUP)": "Escorts Kubota",
            "TAFE LIMITED": "TAFE",
            "JOHN DEERE INDIA PVT LTD (TRACTOR DEVISION)": "John Deere India",
            "JOHN DEERE INDIA PVT LTD(TRACTOR DEVISION)": "John Deere India",
            "EICHER TRACTORS": "Eicher Tractors",
            "CNH INDUSTRIAL (INDIA) PVT LTD": "CNH Industrial",
            "OTHERS": "Others",
        },
    }
    category_map = explicit.get(category, {})
    if normalized in category_map:
        return category_map[normalized]
    if normalized in canonical_lookup:
        return canonical_lookup[normalized]
    return raw_name.title()


def normalize_oem_key(value: str) -> str:
    return re.sub(r"\s+", " ", value.upper()).strip()


def fada_category_label(category: str) -> str:
    labels = {
        "2W": "Two-Wheelers",
        "3W": "Three-Wheelers",
        "CV": "Commercial Vehicles",
        "CE": "Construction Equipment",
        "PV": "Passenger Vehicles",
        "TRACTOR": "Tractors",
    }
    return labels.get(category, category)


def compact_text(value: str) -> str:
    without_tags = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html_unescape(without_tags)).strip()


def html_unescape(value: str) -> str:
    return unescape(value).strip()


def parse_indian_number(value: str) -> int:
    cleaned = re.sub(r"[^\d]", "", value)
    return int(cleaned) if cleaned else 0


def parse_float_match(pattern: str, value: str) -> float | None:
    match = re.search(pattern, value, flags=re.IGNORECASE | re.DOTALL)
    return float(match.group(1)) if match else None


def parse_loose_date(value: str) -> date | None:
    cleaned = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", value.strip(), flags=re.IGNORECASE)
    cleaned = cleaned.replace("-", "/")
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue

    for fmt in ("%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue
    return None


def parse_iso_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def to_month_id(month_name: str, year: int) -> str:
    month_number = MONTH_LOOKUP.get(month_name.lower())
    if not month_number:
        raise ValueError(f"unsupported month {month_name}")
    return f"{year:04d}-{month_number:02d}"


def month_key(value: str) -> tuple[int, int]:
    year_text, month_text = value.split("-", maxsplit=1)
    return int(year_text), int(month_text)


def month_label(value: str) -> str:
    return datetime.strptime(value, "%Y-%m").strftime("%b %Y")


def ok_result(source: str, message: str, latest_value: str, updated: bool = False) -> SourceUpdateResult:
    return SourceUpdateResult(
        source=source,
        status="ok",
        message=message,
        updated=updated,
        latest_value=latest_value,
        checked_at=datetime.now(UTC).isoformat(),
    )


def warning_result(source: str, message: str, latest_value: str) -> SourceUpdateResult:
    return SourceUpdateResult(
        source=source,
        status="warning",
        message=message,
        updated=False,
        latest_value=latest_value,
        checked_at=datetime.now(UTC).isoformat(),
    )


def describe_exception(exc: Exception) -> str:
    if isinstance(exc, HTTPError):
        return f"HTTP {exc.code}"
    if isinstance(exc, URLError):
        return str(exc.reason)
    return str(exc)
