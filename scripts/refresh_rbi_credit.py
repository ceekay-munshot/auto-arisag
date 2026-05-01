"""Refresh RBI Vehicle Loans + Non-food Bank Credit data into
``data/rbi_credit.json`` by guessing the exact Excel attachment URL each
month.

Why URL guessing instead of scraping the listing
================================================

RBI's "Data on Sectoral Deployment of Bank Credit" listing page
(``Data_Sectoral_Deployment.aspx``) uses a server-side ASP.NET form that
injects the press-release links via JavaScript after page load. From a
non-browser HTTP client the static HTML returns a stub with zero
``BS_PressReleaseDisplay.aspx?prid=N`` anchors, so any regex-based
listing scraper finds nothing.

The Excel attachments themselves, however, follow a totally stable URL
pattern:

    https://rbi.org.in/upload/PressReleases/Excel/SIBCS<DDMMYYYY>.xlsx

Where DDMMYYYY is the publication date — always the **last 1–3 working
days of the next month** after the reference month. Examples:

    Mar 2026 reference data → published 30-Apr-2026 → SIBCS30042026.xlsx
    Feb 2026 reference data → published 30-Mar-2026 → SIBCS30032026.xlsx
    Jan 2026 reference data → published 27-Feb-2026 → SIBCS27022026.xlsx

So instead of scraping the broken listing, this script:

    1. Walks the last MAX_LOOKBACK_MONTHS reference months.
    2. For each month not already in ``data/rbi_credit.json``, generates
       up to 7 candidate publication dates (last 7 working days of the
       next month) and tries each Excel URL in turn.
    3. The first 200 OK with a valid ``.xlsx`` body wins.
    4. Parses the Excel with ``openpyxl`` — Statement 1 row 4.7 (Vehicle
       Loans) and row III (Non-food Credit). Layout-tolerant — no
       hard-coded row indices.

Idempotent: skips months already verified from rbi.org.in.

Run via the GitHub Actions cron — sandbox networks cannot reach RBI.
"""

from __future__ import annotations

import calendar
import json
import re
import sys
from datetime import date, datetime, timedelta
from io import BytesIO
from pathlib import Path

import requests
from openpyxl import load_workbook

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402
    MONTH_LOOKUP,
    to_month_id,
)


HISTORY_PATH = Path("data/rbi_credit.json")
EXCEL_URL_TEMPLATE = "https://rbi.org.in/upload/PressReleases/Excel/SIBCS{ddmmyyyy}.xlsx"
LISTING_URL = "https://rbi.org.in/Scripts/Data_Sectoral_Deployment.aspx"
MAX_LOOKBACK_MONTHS = 24  # try the last 24 months of reference data
CANDIDATE_DAYS_PER_MONTH = 7  # try last 7 working days of publication month
TIMEOUT = 60
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,"
        "application/vnd.ms-excel,*/*;q=0.8"
    ),
    "Accept-Language": "en-IN,en;q=0.9",
    "Referer": "https://rbi.org.in/Scripts/Data_Sectoral_Deployment.aspx",
}


def _candidate_publication_dates(reference_month: str) -> list[date]:
    """Return up to CANDIDATE_DAYS_PER_MONTH dates to try for the given
    reference month, ordered most-likely first.

    RBI publishes the SDBC release on the last 1–3 *working* days of the
    next month after the reference month. We yield the last
    CANDIDATE_DAYS_PER_MONTH weekdays of the publication month, latest
    first.
    """
    year, month = (int(part) for part in reference_month.split("-"))
    pub_month = month + 1
    pub_year = year
    if pub_month > 12:
        pub_month = 1
        pub_year += 1
    last_day = calendar.monthrange(pub_year, pub_month)[1]
    candidates: list[date] = []
    cur = date(pub_year, pub_month, last_day)
    seen = 0
    while seen < CANDIDATE_DAYS_PER_MONTH and cur.month == pub_month:
        if cur.weekday() < 5:  # Mon-Fri
            candidates.append(cur)
            seen += 1
        cur -= timedelta(days=1)
    return candidates


def _target_months(today: date | None = None) -> list[str]:
    """Return reference months YYYY-MM going back MAX_LOOKBACK_MONTHS,
    starting from the previous calendar month (since the current month's
    data isn't published yet)."""
    today = today or date.today()
    out: list[str] = []
    year, month = today.year, today.month - 1
    if month <= 0:
        month += 12
        year -= 1
    for _ in range(MAX_LOOKBACK_MONTHS):
        out.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month <= 0:
            month += 12
            year -= 1
    return out


def _try_fetch_excel(url: str) -> bytes | None:
    """Single GET attempt. Returns bytes only when the response is a
    valid OOXML zip (PK magic). Suppresses 404 noise — RBI returns 404
    for every wrong-date guess and we make many of those by design."""
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
    except Exception as exc:
        print(f"    {url}: connection error ({exc})", flush=True)
        return None
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        print(f"    {url}: HTTP {response.status_code}", flush=True)
        return None
    if not response.content or not response.content.startswith(b"PK"):
        return None
    return response.content


_VEHICLE_LABEL_RE = re.compile(r"(?:^|\s)(?:4\.7\.?\s*)?Vehicle\s+Loans?\b", re.IGNORECASE)
_NON_FOOD_LABEL_RE = re.compile(r"(?:III\.?\s*)?Non[-\s]?food\s+Credit\b", re.IGNORECASE)


def _parse_excel(content: bytes) -> dict[str, float | int | None] | None:
    """Pull (vehicle_outstanding, vehicle_yoy, non_food_outstanding,
    non_food_yoy) from the Excel workbook's "Statement 1" sheet."""
    workbook = load_workbook(BytesIO(content), data_only=True, read_only=True)
    statement_sheet = None
    for name in workbook.sheetnames:
        if "statement" in name.lower() and ("1" in name or "i" in name.lower()):
            statement_sheet = workbook[name]
            break
    if statement_sheet is None:
        statement_sheet = workbook[workbook.sheetnames[0]]

    veh_row: list = []
    nf_row: list = []
    for row in statement_sheet.iter_rows(values_only=True):
        if not row:
            continue
        first_cell = row[0]
        if not isinstance(first_cell, str):
            continue
        label = first_cell.strip()
        if not nf_row and _NON_FOOD_LABEL_RE.search(label):
            nf_row = list(row)
        elif not veh_row and _VEHICLE_LABEL_RE.search(label):
            veh_row = list(row)
        if veh_row and nf_row:
            break

    if not veh_row or not nf_row:
        return None

    veh_outstanding, veh_yoy = _last_outstanding_and_yoy(veh_row)
    nf_outstanding, nf_yoy = _last_outstanding_and_yoy(nf_row)
    return {
        "vehicle_outstanding_cr": veh_outstanding,
        "vehicle_yoy_pct": veh_yoy,
        "non_food_total_cr": nf_outstanding,
        "non_food_yoy_pct": nf_yoy,
    }


def _last_outstanding_and_yoy(row: list) -> tuple[int | None, float | None]:
    """In an RBI Statement-1 row, every numeric > ~50,000 is an "Outstanding"
    cell (Rs crore), and every numeric in [-100, 200] (rounded one decimal)
    is a YoY/FY variation. The right-most outstanding is the latest
    observation; the right-most variation is the YoY% RBI printed."""
    outstanding = None
    yoy = None
    for cell in row[1:]:
        if cell is None:
            continue
        try:
            value = float(cell)
        except (TypeError, ValueError):
            continue
        if abs(value) > 50_000 and float(int(value)) == value:
            outstanding = int(value)
        elif -100 <= value <= 200:
            yoy = round(value, 2)
    return outstanding, yoy


def _load_history() -> dict:
    if HISTORY_PATH.exists():
        try:
            return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {
        "source_name": "RBI — Sectoral Deployment of Bank Credit",
        "source_url": LISTING_URL,
        "concept": "Outstanding scheduled commercial bank credit for Vehicle Loans (sub-segment of Personal Loans).",
        "unit": "INR crore (outstanding)",
        "coverage_note": "",
        "is_seed": True,
        "series": [],
    }


def _save_history(payload: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _is_already_verified(record: dict | None) -> bool:
    if not record:
        return False
    src = record.get("source_url", "")
    return src.startswith("https://rbi.org.in/upload/PressReleases/Excel/")


def main() -> int:
    history = _load_history()
    by_month: dict[str, dict] = {row["month"]: row for row in history.get("series", []) if row.get("month")}

    target_months = _target_months()
    print(
        f"RBI scraper: trying {len(target_months)} reference months "
        f"({target_months[-1]} → {target_months[0]})",
        flush=True,
    )

    added = 0
    refreshed = 0
    skipped = 0
    not_yet_published = 0

    for month_id in target_months:
        existing = by_month.get(month_id)
        if _is_already_verified(existing):
            skipped += 1
            continue

        candidate_dates = _candidate_publication_dates(month_id)
        successful_url: str | None = None
        excel_bytes: bytes | None = None
        for pub_date in candidate_dates:
            ddmmyyyy = pub_date.strftime("%d%m%Y")
            url = EXCEL_URL_TEMPLATE.format(ddmmyyyy=ddmmyyyy)
            content = _try_fetch_excel(url)
            if content is not None:
                successful_url = url
                excel_bytes = content
                break

        if not excel_bytes or not successful_url:
            not_yet_published += 1
            print(f"  {month_id}: no Excel found at any of {len(candidate_dates)} candidate URLs", flush=True)
            continue

        parsed = _parse_excel(excel_bytes)
        if not parsed or not parsed.get("vehicle_outstanding_cr"):
            print(f"  {month_id}: workbook downloaded but Vehicle Loans row missing — {successful_url}", flush=True)
            continue

        as_of_date = _last_reporting_friday(month_id)
        record = {
            "month": month_id,
            "as_of_date": as_of_date,
            "outstanding_cr": parsed["vehicle_outstanding_cr"],
            "yoy_pct": parsed["vehicle_yoy_pct"],
            "non_food_total_cr": parsed["non_food_total_cr"],
            "non_food_yoy_pct": parsed["non_food_yoy_pct"],
            "source_url": successful_url,
        }
        if existing == record:
            continue
        if existing:
            refreshed += 1
        else:
            added += 1
        by_month[month_id] = record
        print(
            f"  {month_id}: VL ₹{record['outstanding_cr']:,} cr ({record['yoy_pct']}% YoY), "
            f"NF ₹{record['non_food_total_cr']:,} cr ({record['non_food_yoy_pct']}% YoY) "
            f"← {successful_url}",
            flush=True,
        )

    history["series"] = [by_month[k] for k in sorted(by_month)]
    if added or refreshed:
        history["is_seed"] = False
        history["coverage_note"] = (
            "Outstanding amount as of the last reporting Friday of each month, "
            "parsed from RBI's Sectoral Deployment of Bank Credit Excel statements."
        )
    _save_history(history)

    print(
        f"\nWrote {HISTORY_PATH}: added {added}, refreshed {refreshed}, "
        f"skipped (already verified) {skipped}, "
        f"not published yet {not_yet_published}. "
        f"Total months: {len(history['series'])}",
        flush=True,
    )
    # Exit 0 even when no months are added — most cron runs will find nothing
    # new because RBI publishes once a month. Exit non-zero only if we never
    # had any verified data in the file at all (genuine failure state).
    return 0 if (added + refreshed + skipped) > 0 else 2


def _last_reporting_friday(month_id: str) -> str:
    """Return ISO date of the last Friday of ``month_id``."""
    year, month = (int(part) for part in month_id.split("-"))
    last_day = calendar.monthrange(year, month)[1]
    cur = datetime(year, month, last_day)
    while cur.weekday() != 4:  # 4 = Friday
        cur -= timedelta(days=1)
    return cur.strftime("%Y-%m-%d")


if __name__ == "__main__":
    sys.exit(main())
