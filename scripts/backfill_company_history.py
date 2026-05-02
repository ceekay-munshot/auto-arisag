"""Walk listed-OEM investor / press-release pages to build a long monthly
volume history per company into data/company_unit_history.json.

Each company publishes monthly volumes in slightly different shapes
(Maruti / TVS / Mahindra: HTML press releases; Hero / Eicher / Atul Auto /
Bajaj: PDFs; Tata Motors CV: HTML on cv.tatamotors.com). Rather than fight a
single generic scraper, this script keeps a tiny per-company adapter that
knows where the volumes live and how to extract them. The output schema is
shared:

    {
      "companies": {
        "Maruti Suzuki": [
            {"month": "2023-04", "units": 137320, "source_url": "..."},
            ...
        ],
        ...
      }
    }

The dashboard's ``analyze._build_company_unit_trends`` merges this on top of
the static config series — config rows always win for the months they cover.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlsplit, urlunsplit

import requests
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402
    MONTH_LOOKUP,
    compact_text,
    parse_indian_number,
    to_month_id,
)


HISTORY_PATH = Path("data/company_unit_history.json")
TIMEOUT = 30
MAX_HISTORY_MONTHS = 60  # 5 years per company
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}
PDF_HEADERS = {**HEADERS, "Accept": "application/pdf,*/*;q=0.8"}

MONTH_NAMES = (
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
)
MONTH_ABBR = {name[:3]: name for name in MONTH_NAMES}


def _fetch_html(url: str) -> str | None:
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        return response.text
    except Exception as exc:
        print(f"  fetch html failed: {url} ({exc})", flush=True)
        return None


def _fetch_pdf_text(url: str) -> str | None:
    try:
        response = requests.get(url, headers=PDF_HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        if not response.content.startswith(b"%PDF"):
            return None
        reader = PdfReader(BytesIO(response.content))
        chunks = []
        for page in reader.pages[:6]:
            try:
                chunks.append(page.extract_text() or "")
            except Exception:
                continue
        return "\n".join(chunks)
    except Exception as exc:
        print(f"  fetch pdf failed: {url} ({exc})", flush=True)
        return None


def _wayback_cdx(prefix_url: str, limit: int = 4000, mime: str = "text/html") -> list[tuple[str, str]]:
    """Return ``[(snapshot_url, original_url), ...]`` for Wayback CDX hits
    under ``prefix_url``."""
    cdx = (
        "https://web.archive.org/cdx/search/cdx"
        f"?url={quote_plus(prefix_url)}"
        "&matchType=prefix"
        "&output=json"
        f"&limit={limit}"
        f"&filter=mimetype:{mime}"
        "&filter=statuscode:200"
        "&collapse=urlkey"
    )
    try:
        response = requests.get(cdx, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        rows = response.json()
    except Exception as exc:
        print(f"  wayback cdx failed for {prefix_url}: {exc}", flush=True)
        return []
    if not isinstance(rows, list) or len(rows) < 2:
        return []
    out: list[tuple[str, str]] = []
    for row in rows[1:]:
        try:
            timestamp, original = row[1], row[2]
        except (IndexError, TypeError):
            continue
        snapshot = f"https://web.archive.org/web/{timestamp}id_/{original}"
        out.append((snapshot, original))
    return out


def _within_window(month_id: str, today: date) -> bool:
    try:
        cur = datetime.strptime(month_id, "%Y-%m").date()
    except ValueError:
        return False
    diff = (today.year - cur.year) * 12 + (today.month - cur.month)
    return -1 <= diff <= MAX_HISTORY_MONTHS


def _extract_month_from_text(text: str) -> str | None:
    """Best-effort: find the first 'Month YYYY' phrase in arbitrary text and
    return YYYY-MM."""
    match = re.search(
        r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s*[,-]?\s*(\d{4})",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    try:
        return to_month_id(match.group(1), int(match.group(2)))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Per-company adapters. Each returns a list of {month, units, source_url}.
# ---------------------------------------------------------------------------


def fetch_maruti() -> list[dict]:
    """Maruti Suzuki press releases use a stable URL pattern. Walk the last
    ``MAX_HISTORY_MONTHS`` of candidate URLs and parse each release for the
    monthly total volume."""
    today = date.today()
    rows: list[dict] = []
    for offset in range(MAX_HISTORY_MONTHS):
        year = today.year - ((today.month - 1 - offset) // 12) if today.month - offset <= 0 else today.year
        month_index = ((today.month - offset - 1) % 12)
        # The press release for month M is usually published on the 1st of M+1.
        target_month = today.month - offset
        target_year = today.year
        while target_month <= 0:
            target_month += 12
            target_year -= 1
        publish_month = target_month + 1
        publish_year = target_year
        if publish_month > 12:
            publish_month = 1
            publish_year += 1
        month_name = MONTH_NAMES[target_month - 1]
        publish_month_name = MONTH_NAMES[publish_month - 1]
        url = (
            f"https://www.marutisuzuki.com/corporate/media/press-releases/"
            f"{publish_year}/{publish_month_name}/maruti-suzuki-sales-in-{month_name}-{target_year}"
        )
        html = _fetch_html(url)
        if not html:
            continue
        text = compact_text(html)
        # The release headline mentions "Total Sales" or "Total" with the volume.
        match = re.search(
            r"Total(?:\s+Sales)?\s*[:\-]?\s*([\d,]+)\s*(?:units|vehicles)?\b",
            text,
            flags=re.IGNORECASE,
        )
        if not match:
            # Some releases use "monthly total of X units"
            match = re.search(r"monthly total[^.]*?\b([\d,]+)\b", text, flags=re.IGNORECASE)
        if not match:
            continue
        units = parse_indian_number(match.group(1))
        if units < 50_000:  # Maruti monthlies are 100K+; reject obvious mis-parses.
            continue
        month_id = to_month_id(month_name, target_year)
        rows.append({"month": month_id, "units": units, "source_url": url})
        print(f"  Maruti {month_id}: {units}", flush=True)
    return rows


def fetch_tvs() -> list[dict]:
    """TVS Motor monthly URLs follow ``tvs-motor-company-sales-...-<month>-<year>``.
    Wayback discovery is more reliable than guessing the slug because the
    headline (and slug) varies month to month."""
    rows: list[dict] = []
    today = date.today()
    snapshots = _wayback_cdx("tvsmotor.com/Media/Press-Release/", limit=2000, mime="text/html")
    snapshots += _wayback_cdx("www.tvsmotor.com/Media/Press-Release/", limit=2000, mime="text/html")
    seen_months: set[str] = set()
    for snapshot_url, original in snapshots:
        slug_lower = original.lower()
        if "sales" not in slug_lower and "growth" not in slug_lower:
            continue
        month_match = re.search(
            r"-(january|february|march|april|may|june|july|august|september|october|november|december)-(\d{4})",
            slug_lower,
        )
        if not month_match:
            continue
        try:
            month_id = to_month_id(month_match.group(1), int(month_match.group(2)))
        except ValueError:
            continue
        if not _within_window(month_id, today) or month_id in seen_months:
            continue
        html = _fetch_html(snapshot_url)
        if not html:
            continue
        text = compact_text(html)
        match = re.search(
            r"Total(?:\s+Sales|\s+two-wheeler|\s+volumes?)?[^.]*?\b([\d,]{5,})\s*(?:units|vehicles)?\b",
            text,
            flags=re.IGNORECASE,
        )
        if not match:
            continue
        units = parse_indian_number(match.group(1))
        if units < 100_000:
            continue
        seen_months.add(month_id)
        rows.append({"month": month_id, "units": units, "source_url": original})
        print(f"  TVS {month_id}: {units}", flush=True)
    return rows


def fetch_hero() -> list[dict]:
    """Hero MotoCorp publishes per-month PDFs under ``/content/dam/...``.
    Discover via Wayback; URL shapes vary heavily so parse the PDF bytes
    to extract the dispatch number."""
    rows: list[dict] = []
    today = date.today()
    snapshots = _wayback_cdx(
        "heromotocorp.com/content/dam/hero-aem-website/in/en-in/company-section",
        limit=4000,
        mime="application/pdf",
    )
    snapshots += _wayback_cdx(
        "www.heromotocorp.com/content/dam/hero-aem-website/in/en-in/company-section",
        limit=4000,
        mime="application/pdf",
    )
    seen_months: set[str] = set()
    for snapshot_url, original in snapshots:
        slug = original.lower()
        if "press" not in slug and "sales" not in slug and "dispatch" not in slug:
            continue
        month_match = re.search(
            r"(january|february|march|april|may|june|july|august|september|october|november|december)[-_\s]*(\d{4})",
            slug,
        )
        if not month_match:
            continue
        try:
            month_id = to_month_id(month_match.group(1), int(month_match.group(2)))
        except ValueError:
            continue
        if not _within_window(month_id, today) or month_id in seen_months:
            continue
        text = _fetch_pdf_text(snapshot_url)
        if not text:
            continue
        # Hero PDFs commonly say "<X> units in <Month> <Year>" or "dispatch volume of <X>".
        match = re.search(
            r"\b([\d,]{5,})\b[^.]*?units(?:[^.]*?(?:dispatch|sales|sold))?",
            text,
            flags=re.IGNORECASE,
        )
        if not match:
            continue
        units = parse_indian_number(match.group(1))
        if units < 200_000 or units > 1_500_000:
            continue
        seen_months.add(month_id)
        rows.append({"month": month_id, "units": units, "source_url": original})
        print(f"  Hero {month_id}: {units}", flush=True)
    return rows


def fetch_eicher() -> list[dict]:
    """Eicher / Royal Enfield publishes one-page PDFs per month under
    ``/content/dam/eicher-motors/investor/.../monthly-sales-volume/``."""
    rows: list[dict] = []
    today = date.today()
    snapshots = _wayback_cdx(
        "eicher.in/content/dam/eicher-motors/investor",
        limit=2000,
        mime="application/pdf",
    )
    seen_months: set[str] = set()
    for snapshot_url, original in snapshots:
        slug = original.lower()
        if "monthly-sales" not in slug and "sales-volume" not in slug:
            continue
        month_match = re.search(
            r"(january|february|march|april|may|june|july|august|september|october|november|december)[-_]*(\d{4})",
            slug,
        )
        if not month_match:
            continue
        try:
            month_id = to_month_id(month_match.group(1), int(month_match.group(2)))
        except ValueError:
            continue
        if not _within_window(month_id, today) or month_id in seen_months:
            continue
        text = _fetch_pdf_text(snapshot_url)
        if not text:
            continue
        # Royal Enfield monthly PDFs report a "Total" row.
        match = re.search(r"Total[^\n]*?\b([\d,]{5,})\b", text, flags=re.IGNORECASE)
        if not match:
            continue
        units = parse_indian_number(match.group(1))
        if units < 30_000 or units > 200_000:
            continue
        seen_months.add(month_id)
        rows.append({"month": month_id, "units": units, "source_url": original})
        print(f"  Eicher {month_id}: {units}", flush=True)
    return rows


def fetch_atul_auto() -> list[dict]:
    rows: list[dict] = []
    today = date.today()
    snapshots = _wayback_cdx(
        "atulauto.co.in/wp-content/uploads",
        limit=2000,
        mime="application/pdf",
    )
    seen_months: set[str] = set()
    for snapshot_url, original in snapshots:
        slug = original.lower()
        if "salesperformance" not in slug and "sales_performance" not in slug:
            continue
        month_match = re.search(
            r"(january|february|march|april|may|june|july|august|september|october|november|december)(\d{4})",
            slug,
        )
        if not month_match:
            continue
        try:
            month_id = to_month_id(month_match.group(1), int(month_match.group(2)))
        except ValueError:
            continue
        if not _within_window(month_id, today) or month_id in seen_months:
            continue
        text = _fetch_pdf_text(snapshot_url)
        if not text:
            continue
        match = re.search(r"Total[^\n]*?\b([\d,]{4,})\b", text, flags=re.IGNORECASE)
        if not match:
            continue
        units = parse_indian_number(match.group(1))
        if units < 1_000 or units > 50_000:
            continue
        seen_months.add(month_id)
        rows.append({"month": month_id, "units": units, "source_url": original})
        print(f"  Atul Auto {month_id}: {units}", flush=True)
    return rows


def fetch_mahindra_auto() -> list[dict]:
    """Mahindra publishes monthly auto sales releases under
    ``/news-room/press-release/``. Slugs embed the volumes verbatim, so we can
    parse most without even fetching the page (but we fetch to be safe)."""
    rows: list[dict] = []
    today = date.today()
    snapshots = _wayback_cdx("mahindra.com/news-room/press-release", limit=4000, mime="text/html")
    snapshots += _wayback_cdx("www.mahindra.com/news-room/press-release", limit=4000, mime="text/html")
    seen_months: set[str] = set()
    for snapshot_url, original in snapshots:
        slug = original.lower()
        if "auto" not in slug or ("clocks" not in slug and "records" not in slug and "sales" not in slug):
            continue
        month_match = re.search(
            r"(january|february|march|april|may|june|july|august|september|october|november|december)[-_\s]*(\d{4})",
            slug,
        )
        if not month_match:
            continue
        try:
            month_id = to_month_id(month_match.group(1), int(month_match.group(2)))
        except ValueError:
            continue
        if not _within_window(month_id, today) or month_id in seen_months:
            continue
        # Slug commonly contains the volume (e.g. ``-92670-total-vehicle-sales-``).
        units = None
        slug_match = re.search(r"-(\d{5,7})-total-vehicle-sales", slug)
        if slug_match:
            units = int(slug_match.group(1))
        if units is None:
            html = _fetch_html(snapshot_url)
            if not html:
                continue
            text = compact_text(html)
            match = re.search(r"\b([\d,]{5,})\b\s*total vehicle sales", text, flags=re.IGNORECASE)
            if match:
                units = parse_indian_number(match.group(1))
        if not units or units < 30_000 or units > 200_000:
            continue
        seen_months.add(month_id)
        rows.append({"month": month_id, "units": units, "source_url": original})
        print(f"  M&M {month_id}: {units}", flush=True)
    return rows


def fetch_tata_motors_cv() -> list[dict]:
    """Tata Motors CV monthly news posts at ``cv.tatamotors.com/news/``."""
    rows: list[dict] = []
    today = date.today()
    snapshots = _wayback_cdx("cv.tatamotors.com/news", limit=2000, mime="text/html")
    seen_months: set[str] = set()
    for snapshot_url, original in snapshots:
        slug = original.lower()
        if "commercial" not in slug and "cv" not in slug:
            continue
        month_match = re.search(
            r"(january|february|march|april|may|june|july|august|september|october|november|december)[-_\s]*(\d{4})",
            slug,
        )
        if not month_match:
            continue
        try:
            month_id = to_month_id(month_match.group(1), int(month_match.group(2)))
        except ValueError:
            continue
        if not _within_window(month_id, today) or month_id in seen_months:
            continue
        html = _fetch_html(snapshot_url)
        if not html:
            continue
        text = compact_text(html)
        match = re.search(
            r"\b([\d,]{4,})\b\s*commercial\s+vehicle\s+units",
            text,
            flags=re.IGNORECASE,
        )
        if not match:
            continue
        units = parse_indian_number(match.group(1))
        if units < 10_000 or units > 80_000:
            continue
        seen_months.add(month_id)
        rows.append({"month": month_id, "units": units, "source_url": original})
        print(f"  Tata CV {month_id}: {units}", flush=True)
    return rows


def fetch_bajaj() -> list[dict]:
    """Bajaj's monthly sales PDFs live at
    ``bajajauto.com/-/media/images/bajajauto/media-kit/press-release/<year>/press-release-<month>-<year>.pdf``."""
    rows: list[dict] = []
    today = date.today()
    snapshots = _wayback_cdx(
        "bajajauto.com/-/media/images/bajajauto/media-kit/press-release",
        limit=2000,
        mime="application/pdf",
    )
    seen_months: set[str] = set()
    for snapshot_url, original in snapshots:
        slug = original.lower()
        month_match = re.search(
            r"press-release-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*-?(\d{4})",
            slug,
        )
        if not month_match:
            continue
        month_token = month_match.group(1)
        full_name = MONTH_ABBR.get(month_token, month_token)
        try:
            month_id = to_month_id(full_name, int(month_match.group(2)))
        except ValueError:
            continue
        if not _within_window(month_id, today) or month_id in seen_months:
            continue
        text = _fetch_pdf_text(snapshot_url)
        if not text:
            continue
        match = re.search(r"Total[^\n]*?\b([\d,]{5,})\b", text, flags=re.IGNORECASE)
        if not match:
            continue
        units = parse_indian_number(match.group(1))
        if units < 200_000 or units > 800_000:
            continue
        seen_months.add(month_id)
        rows.append({"month": month_id, "units": units, "source_url": original})
        print(f"  Bajaj {month_id}: {units}", flush=True)
    return rows


# Active adapters. As of 2026-05, only these three produce data via Wayback
# CDX consistently:
#   - TVS Motor       (~18 months of history)
#   - Mahindra & Mahindra (~4 months, slug-embedded volumes)
#   - Atul Auto       (~10 months)
#
# The five commented-out adapters below were retired because Wayback
# returned 0 parseable releases per run, churning workflow time for no
# gain. They stay in the file (just unwired) so the discovery code can be
# re-enabled by uncommenting if any of these companies' Wayback footprint
# improves later, or if we get paid feeds.
COMPANY_FETCHERS = {
    # "Maruti Suzuki": fetch_maruti,            # disabled (URL guess fails for old months)
    "Mahindra & Mahindra": fetch_mahindra_auto,
    # "Hero MotoCorp": fetch_hero,              # disabled (slug filter too strict)
    "TVS Motor": fetch_tvs,
    # "Bajaj Auto": fetch_bajaj,                # disabled (Wayback returns nothing)
    # "Eicher Motors": fetch_eicher,            # disabled (Wayback returns nothing)
    # "Tata Motors": fetch_tata_motors_cv,      # disabled (cv.tatamotors.com slug shift)
    "Atul Auto": fetch_atul_auto,
}


def _load_history() -> dict[str, list[dict]]:
    if not HISTORY_PATH.exists():
        return {}
    try:
        payload = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    raw = payload.get("companies") if isinstance(payload, dict) else None
    if not isinstance(raw, dict):
        return {}
    return {company: list(series) for company, series in raw.items() if isinstance(series, list)}


def _save_history(by_company: dict[str, list[dict]]) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"companies": by_company}
    HISTORY_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    history = _load_history()
    for company, fetcher in COMPANY_FETCHERS.items():
        print(f"\n[{company}] backfilling…", flush=True)
        try:
            new_rows = fetcher()
        except Exception as exc:
            print(f"  {company}: fetch errored ({exc})", flush=True)
            continue
        existing = {row.get("month"): row for row in history.get(company, []) if row.get("month")}
        for row in new_rows:
            month_id = row.get("month")
            if not month_id:
                continue
            existing.setdefault(month_id, row)
        history[company] = sorted(existing.values(), key=lambda r: r["month"])
        print(f"  {company}: history now {len(history[company])} months", flush=True)
    _save_history(history)
    print(
        f"\nWrote {HISTORY_PATH}.\nSummary: " + ", ".join(
            f"{c}={len(rows)}m" for c, rows in history.items()
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
