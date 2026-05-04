"""Headless-Chromium scraper for India's Vahan / PARIVAHAN registration
dashboard at ``vahan.parivahan.gov.in/vahan4dashboard/``. Pulls all-India,
maker-wise monthly registrations for every tracked vehicle segment (PV / 2W /
3W / CV / Tractor / CE) and persists them as monthly CSVs under
``data/vahan/`` so the existing analyzer (``dashboard/collectors.collect_vahan_imports``)
can light up the Vahan registrations tab on the dashboard.

Why Playwright instead of the existing requests-based ``VahanOemClient``
========================================================================

``dashboard/vahan_oem.py`` already drives the same dashboard via JSF / curl.
That client has been wired into the cron for months but ``data/vahan_oem_live.json``
is still missing on main, suggesting the static-HTTP path silently fails on
the GitHub Actions runner (likely a JSF view-state extraction issue, an
anti-bot redirect, or a SPA redraw the requests client can't follow). A
headless Chromium navigation is sturdier — it executes the dashboard's
PrimeFaces JS exactly as a real browser would, and the Excel download endpoint
is the same regardless of how we got there.

Forward retention
=================

Each cron run fetches the last 2 calendar months (typically the freshly
published month plus one prior, in case the previous month's row count was
revised). Existing per-month CSVs are not re-written when content matches —
so the workflow's commit-check stays clean unless something actually changed.
History deepens automatically as months accumulate.

Sandbox networks cannot reach vahan.parivahan.gov.in, so this only does
useful work on the runner. The workflow step is gated to the heavy 09:00
UTC tick to keep the lighter ticks fast.
"""

from __future__ import annotations

import csv
import sys
import tempfile
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.vahan_oem import (  # noqa: E402  (sys.path tweak above)
    SEGMENT_FILTERS,
    parse_vahan_workbook,
)


DASHBOARD_URL = "https://vahan.parivahan.gov.in/vahan4dashboard/vahan/view/reportview.xhtml"
OUTPUT_DIR = Path("data/vahan")
NAVIGATION_TIMEOUT = 120_000  # ms — Vahan can be slow first-load
ACTION_TIMEOUT = 60_000        # ms — clicks / waits

# Vehicle-class labels in the multiselect that map to each segment. The label
# strings come from the dashboard UI; the upstream class_codes in
# vahan_oem.SEGMENT_FILTERS are the form values, but Playwright clicks by
# visible label so we keep both worlds in sync here.
SEGMENT_VEHICLE_CLASS_LABELS: dict[str, list[str]] = {
    "PV": [
        "MOTOR CAR",
        "OMNI BUS",
        "OMNI BUS (PRIVATE USE)",
    ],
    "2W": [
        "M-CYCLE/SCOOTER",
        "MOPED",
        "MOTOR CYCLE/SCOOTER-WITH SIDE CAR",
        "MOTOR CYCLE/SCOOTER-USED FOR HIRE",
    ],
    "3W": [
        "THREE WHEELER (PASSENGER)",
        "THREE WHEELER (GOODS)",
        "E-RICKSHAW(P)",
        "E-RICKSHAW WITH CART (G)",
    ],
    "CV": [
        "GOODS CARRIER",
        "ARTICULATED VEHICLE",
        "TRUCK",
        "MOTOR CAB",
        "MAXI CAB",
        "BUS",
        "PRIVATE SERVICE VEHICLE",
        "PRIVATE SERVICE VEHICLE (INDIVIDUAL USE)",
    ],
    "TRACTOR": [
        "TRACTOR (COMMERCIAL)",
        "TRACTOR (NON COMMERCIAL)",
    ],
    "CE": [
        "EXCAVATOR (COMMERCIAL)",
        "DUMPER (COMMERCIAL)",
        "CRANE MOUNTED VEHICLE (COMMERCIAL)",
    ],
}

# Map internal segment id → the canonical category string the dashboard
# analyzer expects in the CSV output (matches CATEGORY_LABELS in
# dashboard/config.py).
SEGMENT_CSV_CATEGORY: dict[str, str] = {
    "PV": "Passenger Vehicles",
    "2W": "Two-Wheelers",
    "3W": "Three-Wheelers",
    "CV": "Commercial Vehicles",
    "TRACTOR": "Tractors",
    "CE": "Construction Equipment",
}


def _select_primefaces_dropdown(page, hidden_input_selector: str, value: str, ajax_script: str, settle_ms: int = 2000) -> None:
    """Set a PrimeFaces select-one dropdown to ``value`` and trigger its
    change-handler. The dashboard uses PrimeFaces.ab() AJAX to refresh
    dependent dropdowns, so we have to dispatch the right script per field."""
    page.wait_for_selector(hidden_input_selector, timeout=ACTION_TIMEOUT, state="attached")
    page.eval_on_selector(
        hidden_input_selector,
        f"(el, value) => {{ el.value = value; {ajax_script} }}",
        value,
    )
    page.wait_for_timeout(settle_ms)


def _click_vehicle_class_labels(page, labels: list[str]) -> None:
    """Tick each vehicle-class label in the multiselect. Vahan renders these
    as clickable text inside ``ui-selectcheckboxmenu`` widgets."""
    for label in labels:
        try:
            target = page.get_by_text(label, exact=True).first
            target.click(timeout=5_000)
            page.wait_for_timeout(120)
        except Exception:
            # Some labels may not exist for the current dashboard build;
            # silently skip them — coverage still works for the others.
            continue


def _download_grouping_excel(page, dest: Path) -> None:
    """Click the Excel-export button and save the resulting download."""
    with page.expect_download(timeout=ACTION_TIMEOUT) as download_info:
        page.locator("#groupingTable\\:xls").first.click()
    download = download_info.value
    download.save_as(str(dest))


def _fetch_segment_year(page, segment_id: str, year: int) -> dict[str, Any] | None:
    """Drive the dashboard for ``segment_id`` + ``year`` and return the parsed
    workbook payload, or None on failure."""
    page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT)

    # Set Y-axis to "Maker", X-axis to "Month Wise", year-type to Calendar,
    # then year. Each step fires a PrimeFaces AJAX update.
    _select_primefaces_dropdown(
        page, "#yaxisVar_input", "Maker",
        "PrimeFaces.ab({s:'yaxisVar',e:'change',f:'masterLayout_formlogin',p:'yaxisVar',u:'xaxisVar'});",
        2_500,
    )
    _select_primefaces_dropdown(
        page, "#xaxisVar_input", "Month Wise",
        "PrimeFaces.ab({s:'xaxisVar',e:'change',f:'masterLayout_formlogin',p:'xaxisVar',u:'multipleYear'});",
        2_500,
    )
    _select_primefaces_dropdown(
        page, "#selectedYearType_input", "C",
        "PrimeFaces.ab({s:'selectedYearType',e:'change',f:'masterLayout_formlogin',p:'selectedYearType',u:'selectedYear'});",
        1_000,
    )
    _select_primefaces_dropdown(
        page, "#selectedYear_input", str(year),
        "PrimeFaces.ab({s:'selectedYear',e:'change',f:'masterLayout_formlogin',p:'selectedYear',u:'selectedYear'});",
        1_500,
    )

    # Tick the right vehicle classes for this segment.
    labels = SEGMENT_VEHICLE_CLASS_LABELS.get(segment_id, [])
    if labels:
        _click_vehicle_class_labels(page, labels)

    # Refresh the chart / table.
    try:
        page.get_by_role("button", name="Refresh").first.click(timeout=ACTION_TIMEOUT)
    except Exception:
        # Some Vahan builds expose the button as Submit; try fallback.
        try:
            page.get_by_role("button", name="Submit").first.click(timeout=ACTION_TIMEOUT)
        except Exception:
            return None
    page.wait_for_timeout(5_000)

    # Pull the Excel export.
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as handle:
        dest = Path(handle.name)
    try:
        _download_grouping_excel(page, dest)
        content = dest.read_bytes()
    finally:
        dest.unlink(missing_ok=True)
    if not content or len(content) < 1024:
        return None
    try:
        return parse_vahan_workbook(content, segment_id, year)
    except Exception as exc:
        print(f"  parse failed for {segment_id} {year}: {exc}", flush=True)
        return None


def _emit_monthly_csvs(workbook_payloads: list[dict[str, Any]]) -> tuple[int, int]:
    """Pivot ``[{segment, year, months, rows}, ...]`` into per-month CSVs
    under ``data/vahan/{YYYY-MM}.csv``. Existing files are overwritten only
    when content actually differs. Returns (months_written, rows_written)."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    rows_by_month: dict[str, list[dict[str, Any]]] = {}
    for payload in workbook_payloads:
        if not payload:
            continue
        segment_id = payload["segment"]
        category = SEGMENT_CSV_CATEGORY.get(segment_id, segment_id)
        for month_id in payload.get("months", []):
            for row in payload.get("rows", []):
                units = (row.get("months") or {}).get(month_id, 0) or 0
                if units <= 0:
                    continue
                rows_by_month.setdefault(month_id, []).append({
                    "month": month_id,
                    "maker": row.get("maker", "").strip(),
                    "category": category,
                    "registrations": units,
                })

    months_written = 0
    total_rows = 0
    for month_id, rows in sorted(rows_by_month.items()):
        rows = sorted(rows, key=lambda r: (r["category"], -r["registrations"]))
        target = OUTPUT_DIR / f"{month_id}.csv"
        # Build CSV in memory first so we can compare with existing.
        buf: list[str] = ["month,maker,category,registrations\n"]
        for r in rows:
            maker = r["maker"].replace('"', "'").replace(",", " ")
            buf.append(f"{r['month']},{maker},{r['category']},{r['registrations']}\n")
        new_content = "".join(buf)
        if target.exists() and target.read_text(encoding="utf-8") == new_content:
            continue
        target.write_text(new_content, encoding="utf-8")
        months_written += 1
        total_rows += len(rows)
        print(f"  wrote {target} ({len(rows)} rows)", flush=True)
    return months_written, total_rows


def _months_to_fetch(today: date | None = None) -> list[tuple[int, str]]:
    """Return [(year, month_id), ...] for the latest 2 calendar months. We
    grab the current and prior month so freshly-revised numbers from Vahan
    overwrite our stored CSV cleanly."""
    today = today or date.today()
    current = (today.year, f"{today.year}-{today.month:02d}")
    if today.month == 1:
        prior = (today.year - 1, f"{today.year - 1}-12")
    else:
        prior = (today.year, f"{today.year}-{today.month - 1:02d}")
    return [prior, current]


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright is not installed. Install via `pip install playwright && playwright install chromium`.", file=sys.stderr)
        return 1

    targets = _months_to_fetch()
    target_years = sorted({year for year, _ in targets})
    target_month_ids = {month_id for _, month_id in targets}
    print(f"Vahan refresh: targeting months {sorted(target_month_ids)}", flush=True)

    workbook_payloads: list[dict[str, Any]] = []
    failures: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1600, "height": 1200},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
            ),
        )
        page = context.new_page()
        page.set_default_timeout(ACTION_TIMEOUT)
        try:
            # Iterate segments × years. Each fetch is a fresh navigation so
            # state from the prior segment doesn't bleed across.
            for segment_id in ["PV", "2W", "3W", "CV", "TRACTOR", "CE"]:
                if segment_id not in SEGMENT_FILTERS:
                    continue
                for year in target_years:
                    print(f"  fetching {segment_id} {year}...", flush=True)
                    try:
                        payload = _fetch_segment_year(page, segment_id, year)
                    except Exception as exc:
                        payload = None
                        print(f"    error: {exc}", flush=True)
                    if not payload:
                        failures.append(f"{segment_id} {year}")
                        continue
                    # Only keep months we actually targeted, so older months
                    # in the workbook don't accidentally overwrite stable
                    # historical CSVs.
                    payload["months"] = [m for m in payload.get("months", []) if m in target_month_ids]
                    if payload["months"]:
                        workbook_payloads.append(payload)
        finally:
            context.close()
            browser.close()

    months_written, total_rows = _emit_monthly_csvs(workbook_payloads)
    print(
        f"\nVahan refresh complete: {months_written} CSV(s) written, {total_rows} rows. "
        f"Failures: {len(failures)} ({', '.join(failures) if failures else 'none'}).",
        flush=True,
    )
    # Exit 0 even on partial failure — continue-on-error in the workflow
    # would catch a non-zero anyway, but a zero exit lets the rebuild step
    # consume whatever did succeed.
    return 0


if __name__ == "__main__":
    sys.exit(main())
