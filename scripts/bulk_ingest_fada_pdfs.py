"""One-shot bulk ingest of FADA monthly retail PDFs.

Walks every *.pdf in the supplied directory (default: repo root + data/fada_pdfs/),
parses each via the existing FADA pipeline in dashboard.update_snapshot, and
merges every layer of data into the right persistent file:

  data/source_snapshot.json   (fada.monthly_series, ev_share_series,
                               inventory_days_pv, dealer_growth_expectation,
                               latest_*)
  data/fada_history.json      (monthly_fuel_mix, urban_rural_growth_series,
                               subsegment_series for CV / 3W)
  data/oem_history.json       (per-category OEM annexure rows per month)

Order of processing matters: PDFs are sorted oldest → newest before parsing
so that "latest_*" fields land on the actual latest month at the end.

Older PDFs (pre-2020) often have a different layout — annexures may not
parse, urban-rural may be missing. The script tolerates partial failures
(logs and continues) so a few unrecoverable PDFs don't block the rest.

After processing, the script:
  * moves the originals into data/fada_pdfs/ for cleanliness
  * deletes obvious "(1)" duplicate files when a same-month non-(1) version
    has already been processed

Run from repo root:  python -u scripts/bulk_ingest_fada_pdfs.py
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import traceback
from datetime import datetime
from pathlib import Path

# Allow running from repo root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402
    build_fada_latest_subsegments,
    compact_pdf_pages,
    extract_pdf_pages,
    parse_fada_monthly_fuel_mix,
    parse_fada_oem_annexure_tables,
    parse_fada_urban_rural_growth,
    update_fada_monthly_snapshot_from_pdf,
    upsert_fada_monthly_record,
)


def _parse_old_format_volumes(pdf_text: str) -> dict | None:
    """Fallback parser for FADA PDFs the modern pipeline can't locate.

    Handles two layouts depending on era:
      * **Old (pre-Sep 2024)**: 3 columns →  `<CAT> <units> <prior_units> <YoY>%`
      * **New (Sep 2024 onward)**: 5 columns → `<CAT> <units> <prior_month> <prior_year> <MoM>% <YoY>%`

    Detected per-PDF by trying the new-format regex first (which is
    strictly stricter — 3 numbers + 2 percents) and only falling back
    to the old format if no rows matched. Critically scoped to the
    MONTHLY table section so cumulative FY-YTD / CY-YTD tables in the
    same PDF don't get misread as monthly volumes."""
    # Normalise smart quotes ('’', '‘') so 'September’24'
    # matches our straight-apostrophe anchor pattern.
    text = pdf_text.replace("’", "'").replace("‘", "'")
    compact = re.sub(r"\s+", " ", text).strip()
    # Anchor specifically on month-name-bearing headers — NOT "YTD", "CY",
    # or "FY" cumulative-table headers. CY-end / FY-end FADA PDFs publish
    # three "All India Vehicle Retail Data for ..." sections in the same
    # PDF (YTD FY'XX, CY'XX, then the actual monthly), and a generic
    # "[A-Za-z]+" anchor was grabbing the cumulative table first.
    month_words = (
        "January|February|March|April|May|June|July|August|September|October|November|December"
        "|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec"
    )
    anchor_patterns = [
        rf"All India Vehicle Retail Data for ({month_words})['']?\d{{2}}",
        rf"Vehicle Retail Data for ({month_words})['']?\d{{2}}",
        # Older (2019 / 2020 / early-2021) PDFs use a bare "CATEGORY
        # <MONTH>'YY" header for the monthly table, with no "All India
        # Vehicle Retail Data" preamble. Pick that up too.
        rf"(?:CATEGORY|Category)\s+({month_words})['']?\d{{2}}",
    ]
    section_text = None
    for pat in anchor_patterns:
        m = re.search(pat, compact, flags=re.IGNORECASE)
        if m:
            start = m.end()
            # Scan up to 3000 chars OR until next major section header.
            # Cumulative / half-yearly tables APPEAR LATER in the same
            # PDF for FY-end / mid-year releases (e.g. Sep 2021's
            # "Apr-September'21 (1st Half FY21)" table) — those would
            # poison the parser by satisfying the 3-num + 2-pct pattern
            # the new format regex looks for. Aggressive truncation here
            # is the cheapest defence.
            end_markers = [
                r"Annexure\s+\d",
                r"Source:\s*FADA Research",
                r"Disclaimer:",
                r"End of Press Release",
                r"Cumulative",
                r"CY['']?\d{2}\s+CY['']?\d{2}",
                r"FY['']?\d{2}\s+FY['']?\d{2}",
                # Half-year / cumulative table headers in older PDFs.
                r"\(1st\s*Half",
                r"\(H1\s*FY",
                r"\(YTD",
                r"YTD\s*FY",
                # Range-style "Apr-September'21" or "Apr - Sep'21"
                # cumulative headers that follow the monthly section.
                rf"All India Vehicle Retail Data for ({month_words})\s*-",
                rf"({month_words})\s*-\s*({month_words})['']?\d{{2}}",
            ]
            section = compact[start:start + 3000]
            # Truncate at the EARLIEST end-marker hit, not the first in
            # iteration order. Sep 2021's PDF triggers `Annexure 1` at
            # position 1870 and `Source: FADA Research` at position 466
            # — taking the first by iteration order kept the cumulative
            # half-year table in scope, poisoning the parse.
            earliest_end = None
            for em in end_markers:
                em_match = re.search(em, section, flags=re.IGNORECASE)
                if em_match and (earliest_end is None or em_match.start() < earliest_end):
                    earliest_end = em_match.start()
            if earliest_end is not None:
                section = section[:earliest_end]
            section_text = section
            break
    if section_text is None:
        # No anchor found — fall back to the full text, but with the
        # earlier scan-everything behaviour. Less reliable but better
        # than nothing for malformed PDFs.
        section_text = compact[:6000]
    cat_aliases = [
        ("PV", "PV"),
        ("2W", "2W"),
        ("3W", "3W"),
        ("CV", "CV"),
        ("TRAC", "TRACTOR"),
        ("TRACTOR", "TRACTOR"),
        ("CE", "CE"),
        ("Total", "TOTAL"),
        # Long-form labels (used in some 2022-2023 PDFs and in the
        # Jan 2023 release specifically). The "2- Wheeler" form (dash
        # then space) is a PDF text-extraction artifact of "2-Wheeler"
        # in the source.
        (r"2\s*-\s*Wheeler", "2W"),
        (r"Two\s*-?\s*Wheeler", "2W"),
        (r"3\s*-\s*Wheeler", "3W"),
        (r"Three\s*-?\s*Wheeler", "3W"),
        (r"Passenger\s+Vehicle", "PV"),
        (r"Commercial\s+Vehicle", "CV"),
        (r"Tractor", "TRACTOR"),
        (r"Construction\s+Equipment", "CE"),
    ]
    out: dict = {}
    # Try the NEW format first (5 columns: 3 units + MoM% + YoY%) — it's
    # stricter so a false match is far less likely to land cumulative
    # numbers from a 3-column table.
    for label, canonical in cat_aliases:
        if canonical in out:
            continue
        # New format pattern: <CAT> <curr_units> <prior_month_units> <prior_year_units> <MoM%> <YoY%>
        # Allow optional '*' / '**' footnote markers right after the
        # category label — older FADA PDFs (Jul 2019 e.g.) print 'PV**'
        # and 'CV*' next to a footnote about RTO coverage. \*+ swallows
        # any number of trailing asterisks; \s+ then anchors on the
        # space before the units number.
        pattern_new = (
            rf"(?<![\w/.])({label})\**\s+([\d,]{{3,}})\s+([\d,]{{3,}})\s+([\d,]{{3,}})"
            rf"\s+(-?[\d.]+)\s*%\s+(-?[\d.]+)\s*%"
        )
        m = re.search(pattern_new, section_text)
        if not m:
            continue
        try:
            units = int(m.group(2).replace(",", ""))
            mom_pct = float(m.group(5))
            yoy_pct = float(m.group(6))
        except ValueError:
            continue
        if units > 50_000_000 or units < 100:
            continue
        out[canonical] = {"units": units, "yoy_pct": yoy_pct, "mom_pct": mom_pct}

    # Old-format fallback for categories the new-format pattern didn't catch.
    for label, canonical in cat_aliases:
        if canonical in out:
            continue
        pattern_old = rf"(?<![\w/.])({label})\**\s+([\d,]{{3,}})\s+([\d,]{{3,}})\s+(-?[\d.]+)\s*%"
        m = re.search(pattern_old, section_text)
        if not m:
            continue
        try:
            units = int(m.group(2).replace(",", ""))
            yoy_pct = float(m.group(4))
        except ValueError:
            continue
        if units > 50_000_000 or units < 100:
            continue
        out[canonical] = {"units": units, "yoy_pct": yoy_pct, "mom_pct": None}
    if not out:
        return None
    if "TOTAL" not in out:
        try:
            total = sum(
                out[c]["units"] for c in ("PV", "2W", "3W", "CV", "TRACTOR", "CE")
                if c in out
            )
            if total:
                out["TOTAL"] = {"units": total, "yoy_pct": None, "mom_pct": None}
        except Exception:
            pass
    return out


SNAPSHOT_PATH = Path("data/source_snapshot.json")
FADA_HISTORY_PATH = Path("data/fada_history.json")
OEM_HISTORY_PATH = Path("data/oem_history.json")
FADA_PDF_DIR = Path("data/fada_pdfs")

# Month-name → number for filename parsing.
MONTH_MAP = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
    'january': 1, 'february': 2, 'march': 3, 'april': 4, 'june': 6,
    'july': 7, 'august': 8, 'september': 9, 'october': 10,
    'november': 11, 'december': 12,
}

TRACKED_OEM_CATEGORIES = ("PV", "2W", "3W", "CV", "TRACTOR", "CE")


def _detect_month_from_filename(filename: str) -> str | None:
    """Best-effort YYYY-MM detection from FADA filename. Falls back to
    parsing the PDF header inside the file when the filename is too
    cryptic — this function is just a fast pre-screen."""
    fl = re.sub(r'[_]', ' ', filename.lower())
    for name, num in MONTH_MAP.items():
        # Pattern: <month_name>[ \-,'"]<digits>
        m = re.search(rf'\b{name}[\s\-,\']{{0,3}}(\d{{2,4}})\b', fl)
        if m:
            yr = int(m.group(1))
            if yr < 100:
                yr = 2000 + yr
            return f"{yr:04d}-{num:02d}"
    # Fallback: <month_name><2-digit year>
    for name, num in MONTH_MAP.items():
        m = re.search(rf'\b{name}(\d{{2}})\b', fl)
        if m:
            yr = 2000 + int(m.group(1))
            return f"{yr:04d}-{num:02d}"
    # Fallback: month_name + nearest 4-digit year anywhere
    for name, num in MONTH_MAP.items():
        if re.search(rf'\b{name}\b', fl):
            yr_m = re.search(r'\b(20\d{2})\b', fl)
            if yr_m:
                return f"{int(yr_m.group(1)):04d}-{num:02d}"
    return None


def _gather_pdfs(*search_dirs: Path) -> dict[str, Path]:
    """Group PDFs by detected month, preferring non-(1) duplicates."""
    by_month: dict[str, Path] = {}
    candidates: list[Path] = []
    for d in search_dirs:
        if not d.exists():
            continue
        candidates.extend(sorted(d.glob("*.pdf")))
    for path in candidates:
        month = _detect_month_from_filename(path.name)
        if not month:
            print(f"  (skip) couldn't detect month from filename: {path.name}", flush=True)
            continue
        existing = by_month.get(month)
        if existing is None:
            by_month[month] = path
            continue
        # Both files for same month — prefer the one without "(1)"
        if "(1)" in existing.name and "(1)" not in path.name:
            by_month[month] = path
        # otherwise keep existing
    return dict(sorted(by_month.items()))


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def _save_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _upsert_urban_rural(series: list[dict], month_id: str, rows: list[dict]) -> list[dict]:
    kept = [item for item in series if item.get("month") != month_id]
    for row in rows:
        if not row.get("category"):
            continue
        kept.append({"month": month_id, **{k: v for k, v in row.items() if k != "month"}})
    return sorted(kept, key=lambda x: (x.get("month") or "", x.get("category") or ""))


def _upsert_subseg(series: list[dict], month_id: str, rows: list[dict]) -> list[dict]:
    kept = [item for item in series if item.get("month") != month_id]
    for row in rows:
        if not row.get("label"):
            continue
        kept.append({"month": month_id, **{k: v for k, v in row.items() if k != "month"}})
    return sorted(kept, key=lambda x: (x.get("month") or "", x.get("label") or ""))


def _upsert_month_keyed(series: list[dict], record: dict) -> list[dict]:
    """Drop any prior entry for record['month'] and re-add the new one,
    keeping the list sorted by month."""
    month = record.get("month")
    kept = [item for item in series if item.get("month") != month]
    kept.append(record)
    return sorted(kept, key=lambda x: x.get("month") or "")


def _extract_old_commentary(pdf_text: str) -> dict:
    """Best-effort inventory / dealer-survey extraction for older FADA
    PDFs whose phrasings differ from the modern release format. The
    modern parser dashboard.update_snapshot.parse_fada_latest_commentary
    is strict (raises on miss) and tied to the latest layout; this is a
    forgiving fallback that captures whatever's present and returns
    None for the rest. Designed to deepen inventory_trend and
    dealer_expectation_trend back across 7 years of history."""
    # Normalise smart quotes and dashes so the regexes don't have to
    # branch for typographic variants.
    text = (
        pdf_text
        .replace("’", "'")
        .replace("‘", "'")
        .replace("–", "-")
        .replace("—", "-")
    )

    out: dict = {
        "inventory_days_low": None,
        "inventory_days_high": None,
        "next_month_growth_pct": None,
        "next_three_months_growth_pct": None,
        "liquidity_good_pct": None,
        "sentiment_good_pct": None,
    }

    # Inventory: try modern "PV inventory normalised to ~28 days" first,
    # then a "<low>-<high> days" range pattern, then a "ranges from X to Y"
    # pattern. Constrain the leading context to "inventory" so we don't
    # accidentally capture date ranges elsewhere.
    inv_modern = re.search(r"PV inventory (?:normalised|normalized) to ~?(\d+)\s*days", text, re.IGNORECASE)
    if inv_modern:
        n = int(inv_modern.group(1))
        out["inventory_days_low"], out["inventory_days_high"] = n, n
    else:
        inv_range = re.search(
            r"(?:PV\s+)?inventory[^.]{0,200}?(\d{2,3})\s*[-to ]+\s*(\d{2,3})\s*days",
            text,
            re.IGNORECASE,
        )
        if inv_range:
            lo, hi = int(inv_range.group(1)), int(inv_range.group(2))
            if 5 <= lo <= 200 and 5 <= hi <= 200 and hi >= lo:
                out["inventory_days_low"], out["inventory_days_high"] = lo, hi

    # Growth expectation phrasings vary:
    #   "Expectation from <Month>'<YY> o Growth  55"   (modern)
    #   "Expectation from July o Growth  42"           (older)
    next_month_match = re.search(
        r"Expectation from\s+[A-Za-z]+(?:'?\d{2})?\s*o?\s*Growth\s+([\d.]+)",
        text,
        re.IGNORECASE,
    )
    if next_month_match:
        out["next_month_growth_pct"] = float(next_month_match.group(1))

    next_three_match = re.search(
        r"Expectation\s+(?:in|for)\s+next\s+3\s+months[^o]*o?\s*Growth\s+([\d.]+)",
        text,
        re.IGNORECASE,
    )
    if next_three_match:
        out["next_three_months_growth_pct"] = float(next_three_match.group(1))

    liq_match = re.search(r"Liquidity[\s|:o-]*(?:Good|Neutral)\s+([\d.]+)", text, re.IGNORECASE)
    if liq_match:
        out["liquidity_good_pct"] = float(liq_match.group(1))

    sent_match = re.search(r"Sentiment[\s|:o-]*(?:Good|Neutral)\s+([\d.]+)", text, re.IGNORECASE)
    if sent_match:
        out["sentiment_good_pct"] = float(sent_match.group(1))

    return out


def _merge_oem_tables_per_month(
    oem_history: dict, month_id: str, release_date: str, source_url: str, tables: dict
) -> int:
    """Merge a single PDF's parsed OEM annexures into oem_history.json
    structure: categories.<CAT>.months[] keyed by month. Returns the
    number of categories that landed rows."""
    categories = oem_history.setdefault("categories", {})
    landed = 0
    for cat in TRACKED_OEM_CATEGORIES:
        cat_table = (tables.get(cat) or {})
        rows = cat_table.get("rows") or []
        if not rows:
            continue
        bucket = categories.setdefault(cat, {"months": []})
        months_list = bucket.setdefault("months", [])
        # Replace any existing record for this month
        new_record = {
            "month": month_id,
            "release_date": release_date,
            "source_url": source_url,
            "rows": rows,
        }
        existing_idx = next(
            (i for i, m in enumerate(months_list) if m.get("month") == month_id), None
        )
        if existing_idx is not None:
            months_list[existing_idx] = new_record
        else:
            months_list.append(new_record)
        bucket["months"] = sorted(months_list, key=lambda m: m.get("month") or "")
        landed += 1
    return landed


def main() -> int:
    print(f"=== FADA bulk ingest — scanning for PDFs ===", flush=True)
    pdfs_by_month = _gather_pdfs(Path("."), FADA_PDF_DIR)
    if not pdfs_by_month:
        print("No FADA PDFs found.", file=sys.stderr)
        return 1
    print(f"Found {len(pdfs_by_month)} unique months of PDFs to ingest.", flush=True)
    print(f"  span: {min(pdfs_by_month.keys())} → {max(pdfs_by_month.keys())}", flush=True)

    snapshot = _load_json(SNAPSHOT_PATH, {})
    if "fada" not in snapshot:
        print("No fada block in source_snapshot.json — aborting.", file=sys.stderr)
        return 1

    history = _load_json(FADA_HISTORY_PATH, {
        "monthly_fuel_mix": {},
        "urban_rural_growth_series": [],
        "subsegment_series": {"CV": [], "3W": []},
        "sources": {},
    })
    history.setdefault("monthly_fuel_mix", {})
    history.setdefault("urban_rural_growth_series", [])
    history.setdefault("subsegment_series", {"CV": [], "3W": []})
    history["subsegment_series"].setdefault("CV", [])
    history["subsegment_series"].setdefault("3W", [])
    history.setdefault("sources", {})

    oem_history = _load_json(OEM_HISTORY_PATH, {"categories": {}})

    succeeded = 0
    failed: list[tuple[str, str]] = []  # (month_id, reason)
    fada = snapshot["fada"]

    # Process oldest → newest so latest_* fields land on the actual latest month
    for month_id in sorted(pdfs_by_month.keys()):
        path = pdfs_by_month[month_id]
        print(f"\n--- {month_id} ({path.name[:80]}) ---", flush=True)
        try:
            pdf_bytes = path.read_bytes()
        except Exception as exc:
            failed.append((month_id, f"read fail: {exc}"))
            continue

        # Use filename-detected month rather than relying on parse_fada_pdf_header,
        # which only recognises the current FADA header format. We still try to
        # extract a publication date from the PDF prose if possible —
        # otherwise fall back to the first day of the *following* month
        # (FADA's typical release cadence) rather than the 15th of the data
        # month, which mid-2026 was rendering an "April 2026 PDF, released
        # 15-Apr-2026" tag that's physically impossible.
        detected_month = month_id
        det_y, det_m = int(month_id[:4]), int(month_id[5:7])
        next_y, next_m = (det_y + 1, 1) if det_m == 12 else (det_y, det_m + 1)
        release_date = f"{next_y:04d}-{next_m:02d}-01"

        try:
            pages = extract_pdf_pages(pdf_bytes)
        except Exception as exc:
            failed.append((month_id, f"page extract fail: {exc}"))
            continue

        # Try to refine release_date from page text — look for "1st [Month] [Year]"
        # style date strings near the top of the doc. Reject any date older
        # than the data month itself; previously the regex would happily
        # capture YoY comparison references like "vs May'18" inside the
        # body of a May 2019 release and stamp a 2018 release_date on it.
        try:
            head_text = " ".join(pages[:3]) if pages else ""
            month_to_num = {
                'january': 1, 'february': 2, 'march': 3, 'april': 4, 'may': 5,
                'june': 6, 'july': 7, 'august': 8, 'september': 9, 'october': 10,
                'november': 11, 'december': 12,
            }
            best_iso = None
            best_distance = None
            target_iso = release_date  # fallback (1st of next month) is the ideal target
            for date_match in re.finditer(
                r"(\d{1,2})(st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*[,'']?\s*(\d{2,4})",
                head_text,
                flags=re.IGNORECASE,
            ):
                try:
                    day = int(date_match.group(1))
                    if not (1 <= day <= 31):
                        continue
                    mname = date_match.group(3).lower()
                    yr_str = date_match.group(4)
                    yr = int(yr_str) if len(yr_str) == 4 else 2000 + int(yr_str)
                    candidate = f"{yr:04d}-{month_to_num[mname]:02d}-{day:02d}"
                except (ValueError, KeyError):
                    continue
                # A release date earlier than the data month is by
                # definition not a release date — drop it.
                if candidate < f"{detected_month}-01":
                    continue
                # Pick the candidate closest to the expected release window
                # (1st of the following month) so we prefer the actual
                # publication header over any forward-looking date in the
                # body.
                distance = abs(
                    (
                        datetime.strptime(candidate, "%Y-%m-%d")
                        - datetime.strptime(target_iso, "%Y-%m-%d")
                    ).days
                )
                if best_distance is None or distance < best_distance:
                    best_iso = candidate
                    best_distance = distance
            if best_iso is not None:
                release_date = best_iso
        except Exception:
            pass

        # Try the full monthly record snapshot (monthly_series + fuel_mix
        # + ev_share_series + inventory_days + dealer_growth). This is
        # the largest single chunk; failure here means just monthly
        # volumes don't land — other layers below still try.
        modern_ok = False
        try:
            fada = update_fada_monthly_snapshot_from_pdf(
                fada, pages, detected_month, release_date,
                source_url=f"file://{path.name}",
            )
            modern_ok = True
            print(f"  monthly_series + ev_share_series + commentary merged", flush=True)
        except Exception as exc:
            print(f"  modern monthly_snapshot parser failed ({exc}); trying fallback", flush=True)

        # Fallback: older PDF retail-volume table format. Parse just the
        # category × units × YoY% rows manually and inject a synthetic
        # monthly_record so the chart still extends. Old PDFs don't carry
        # commentary / fuel-mix / urban-rural / inventory-days, so those
        # remain n.m. for that month — that's fine, the volume line is
        # the most important read.
        if not modern_ok:
            fallback_text = "\n".join(pages)
            fallback_cats = _parse_old_format_volumes(fallback_text)
            # Sanity check: a real monthly TOTAL never exceeds ~5M units in
            # India. If we got anything above 5M (or any single category
            # over 1M), the parser most likely grabbed a cumulative FY/CY
            # table — drop the parse rather than poison the chart with a
            # 10× outlier point.
            if fallback_cats:
                tot = (fallback_cats.get("TOTAL") or {}).get("units") or 0
                pv = (fallback_cats.get("PV") or {}).get("units") or 0
                tw = (fallback_cats.get("2W") or {}).get("units") or 0
                if tot > 5_000_000 or pv > 1_000_000 or tw > 4_000_000:
                    print(f"  fallback rejected (totals look cumulative: TOTAL={tot:,} PV={pv:,} 2W={tw:,})", flush=True)
                    fallback_cats = None
            if fallback_cats:
                # Ensure every record carries all 6 categories + TOTAL —
                # downstream analyze.build_retail_module hard-indexes them.
                for required_cat in ("PV", "2W", "3W", "CV", "TRACTOR", "CE", "TOTAL"):
                    fallback_cats.setdefault(required_cat, {
                        "units": 0, "yoy_pct": None, "mom_pct": None,
                    })
                synthetic_record = {
                    "month": detected_month,
                    "release_date": release_date,
                    "source_url": f"file://{path.name}",
                    "categories": fallback_cats,
                }
                fada["monthly_series"] = upsert_fada_monthly_record(
                    fada.get("monthly_series") or [],
                    synthetic_record,
                )
                cats_str = " ".join(sorted(fallback_cats.keys()))
                print(f"  fallback monthly_series merged ({cats_str})", flush=True)
            else:
                print(f"  fallback parser also missed — no volumes for {detected_month}", flush=True)

        # Per-month layers — parse independently so partial successes count.
        wide = compact_pdf_pages(pages)
        try:
            fuel_mix = parse_fada_monthly_fuel_mix(wide, detected_month)
            if fuel_mix:
                history["monthly_fuel_mix"][detected_month] = fuel_mix
                print(f"  fuel_mix: {len(fuel_mix)} categories", flush=True)
        except Exception as exc:
            print(f"  fuel_mix parse skipped: {exc}", flush=True)
        try:
            urban_rural_rows = parse_fada_urban_rural_growth(wide)
            if urban_rural_rows:
                history["urban_rural_growth_series"] = _upsert_urban_rural(
                    history["urban_rural_growth_series"], detected_month, urban_rural_rows,
                )
                print(f"  urban_rural: {len(urban_rural_rows)} categories", flush=True)
        except Exception as exc:
            print(f"  urban_rural parse skipped: {exc}", flush=True)
        try:
            subsegs = build_fada_latest_subsegments(wide) or {}
            landed_subsegs = []
            for cat in ("CV", "3W"):
                rows = subsegs.get(cat) or []
                if rows:
                    history["subsegment_series"][cat] = _upsert_subseg(
                        history["subsegment_series"].get(cat) or [],
                        detected_month, rows,
                    )
                    landed_subsegs.append(f"{cat}:{len(rows)}")
            if landed_subsegs:
                print(f"  subsegments: {' '.join(landed_subsegs)}", flush=True)
        except Exception as exc:
            print(f"  subsegment parse skipped: {exc}", flush=True)
        try:
            oem_tables = parse_fada_oem_annexure_tables(
                pages, fada, detected_month, source_url=f"file://{path.name}"
            )
            landed_cats = _merge_oem_tables_per_month(
                oem_history, detected_month, release_date=release_date,
                source_url=path.name, tables=oem_tables,
            )
            if landed_cats:
                print(f"  OEM annexures: {landed_cats} categories merged", flush=True)
        except Exception as exc:
            print(f"  OEM annexure parse skipped: {exc}", flush=True)

        # Best-effort commentary extraction independent of the modern
        # parser — covers the wider phrasing range used in pre-2024 PDFs
        # so PV inventory + dealer-growth-expectation trends can deepen
        # back across the full 7 years of history rather than the last
        # few months only.
        try:
            full_text = "\n".join(pages)
            comm = _extract_old_commentary(full_text)
            inv_lo = comm.get("inventory_days_low")
            inv_hi = comm.get("inventory_days_high")
            if inv_lo is not None and inv_hi is not None:
                fada["inventory_days_pv"] = _upsert_month_keyed(
                    fada.get("inventory_days_pv") or [],
                    {"month": detected_month, "days_low": inv_lo, "days_high": inv_hi},
                )
            growth_next = comm.get("next_month_growth_pct")
            growth_q = comm.get("next_three_months_growth_pct")
            if growth_next is not None or growth_q is not None:
                fada["dealer_growth_expectation"] = _upsert_month_keyed(
                    fada.get("dealer_growth_expectation") or [],
                    {
                        "month": detected_month,
                        "next_month_growth_pct": growth_next,
                        "next_three_months_growth_pct": growth_q,
                    },
                )
            landed = []
            if inv_lo is not None:
                landed.append(f"inv={inv_lo}-{inv_hi}d")
            if growth_next is not None:
                landed.append(f"next_growth={growth_next}%")
            if landed:
                print(f"  commentary (best-effort): {' '.join(landed)}", flush=True)
        except Exception as exc:
            print(f"  commentary parse skipped: {exc}", flush=True)

        history["sources"][detected_month] = path.name
        succeeded += 1

    # Refresh fada.latest_month and fada.latest_release_date to match the
    # newest record in monthly_series. Without this the snapshot header
    # would lag behind the ingested data — which then bleeds into the
    # dashboard's "Latest:" pill and into retail_vs_wholesale alignment.
    series_sorted = sorted(
        fada.get("monthly_series") or [],
        key=lambda rec: rec.get("month") or "",
    )
    if series_sorted:
        tail = series_sorted[-1]
        fada["latest_month"] = tail.get("month") or fada.get("latest_month")
        if tail.get("release_date"):
            fada["latest_release_date"] = tail["release_date"]

    # Persist everything
    snapshot["fada"] = fada
    _save_json(SNAPSHOT_PATH, snapshot)
    _save_json(FADA_HISTORY_PATH, history)
    _save_json(OEM_HISTORY_PATH, oem_history)

    print("\n=== Summary ===")
    print(f"  PDFs processed: {succeeded}/{len(pdfs_by_month)}")
    if failed:
        print(f"  Failed: {len(failed)}")
        for m, r in failed:
            print(f"    {m}: {r}")
    print(f"  fada.monthly_series months: {len(fada.get('monthly_series') or [])}")
    print(f"  fada.ev_share_series rows: {len(fada.get('ev_share_series') or [])}")
    print(f"  fada_history.monthly_fuel_mix months: {len(history['monthly_fuel_mix'])}")
    urban_months = len({r['month'] for r in history['urban_rural_growth_series']})
    print(f"  fada_history.urban_rural_growth_series months: {urban_months}")
    for cat in ("CV", "3W"):
        cm = len({r['month'] for r in history['subsegment_series'].get(cat, [])})
        print(f"  fada_history.subsegment_series[{cat}] months: {cm}")
    for cat in TRACKED_OEM_CATEGORIES:
        cm = len((oem_history.get('categories', {}).get(cat) or {}).get('months', []))
        print(f"  oem_history.categories[{cat}] months: {cm}")

    # Move processed PDFs into data/fada_pdfs/ and clean (1) duplicates
    FADA_PDF_DIR.mkdir(parents=True, exist_ok=True)
    moved = 0
    deleted = 0
    seen_target_names = set()
    for month_id, path in pdfs_by_month.items():
        target = FADA_PDF_DIR / path.name
        if path.resolve() == target.resolve():
            seen_target_names.add(target.name)
            continue
        try:
            shutil.move(str(path), str(target))
            seen_target_names.add(target.name)
            moved += 1
        except Exception as exc:
            print(f"  move failed for {path.name}: {exc}", flush=True)
    # Delete leftover root-level PDFs (the (1) duplicates that lost the dedup race)
    for path in Path(".").glob("*.pdf"):
        try:
            path.unlink()
            deleted += 1
        except Exception:
            pass

    print(f"  Moved {moved} PDFs into {FADA_PDF_DIR}, deleted {deleted} duplicate(s) at repo root.")
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())
