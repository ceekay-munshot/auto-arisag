"""Re-extract FADA fuel-mix annexures across every PDF on disk.

Earlier ingest runs only retained the latest month's fuel mix in
``data/fada_history.json::monthly_fuel_mix`` and a 6-month tail in
``data/source_snapshot.json::fada.ev_share_series``. The annexure has
been part of FADA monthly releases for ~24 months — long enough that an
Oct 2025 → latest EV-penetration chart was misleadingly short.

The strict parser inside ``dashboard.update_snapshot`` only recognises
one specific row order (the layout of the Mar 2026 PDF). FADA shuffles
rows whenever a category's set of non-zero fuels changes (e.g. Tractor
gained an EV row in Apr 2026), so the strict parser silently drops
months. This script falls back to a lenient parser that uses the
"each category's first-column percentages sum to 100%" invariant to
assign rows back to categories regardless of order.

Run from repo root::

    python -u scripts/refresh_fuel_mix_history.py
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.update_snapshot import (  # noqa: E402
    compact_pdf_pages,
    extract_between,
    extract_pdf_pages,
    parse_fada_monthly_fuel_mix,
    upsert_fada_ev_share_series,
)
from scripts.bulk_ingest_fada_pdfs import _gather_pdfs  # noqa: E402

SNAPSHOT_PATH = Path("data/source_snapshot.json")
FADA_HISTORY_PATH = Path("data/fada_history.json")
FADA_PDF_DIR = Path("data/fada_pdfs")

# Canonical fuel-name normalization. FADA mixes case ("PETROL/ETHANOL"
# vs "Petrol/Ethanol") inside the same PDF; the dashboard keys are
# title-cased with a space around the slash.
FUEL_DISPLAY = {
    "PETROL/ETHANOL": "Petrol / Ethanol",
    "DIESEL": "Diesel",
    "CNG/LPG": "CNG / LPG",
    "EV": "EV",
    "HYBRID": "Hybrid",
}


def _split_pair_chunk(chunk: str) -> tuple[list, list] | None:
    """Split an interleaved two-category fuel-mix chunk back into the
    two category row-lists. Uses the column-1 sum-to-100% invariant
    plus row alternation; tolerates either category having more or
    fewer fuels than the other (e.g. April 2026 added an EV row to
    Tractor without changing PV's row count)."""
    pct = r"(-?[\d.]+)%"
    label_re = r"([A-Za-z][A-Za-z/]+(?:\s+[A-Za-z][A-Za-z/]+)?)"
    tuples = []
    for m in re.finditer(rf"{label_re}\s+{pct}\s+{pct}\s+{pct}", chunk):
        label = m.group(1).strip()
        # The label can occasionally swallow trailing junk like
        # "Apr'25" if a header re-inserts itself; drop those by
        # ignoring unknown labels.
        canonical = label.upper().replace(" ", "")
        if canonical not in {"PETROL/ETHANOL", "DIESEL", "CNG/LPG", "EV", "HYBRID", "TOTAL"}:
            continue
        try:
            tuples.append((canonical, float(m.group(2)), float(m.group(3)), float(m.group(4))))
        except ValueError:
            continue
    if not tuples:
        return None
    a_rows: list[tuple[str, float, float, float]] = []
    b_rows: list[tuple[str, float, float, float]] = []
    a_done = False
    b_done = False
    turn = "A"
    for label, p1, p2, p3 in tuples:
        if label == "TOTAL":
            # The Total row marks the end of whichever category we
            # were filling on this turn. If the expected side was
            # already done, mark the other side done instead.
            if turn == "A" and not a_done:
                a_done = True
            elif turn == "B" and not b_done:
                b_done = True
            elif not a_done:
                a_done = True
            elif not b_done:
                b_done = True
            turn = "B" if turn == "A" else "A"
            continue
        if a_done and not b_done:
            b_rows.append((label, p1, p2, p3))
            turn = "A"  # next non-total stays with B since A is done
            continue
        if b_done and not a_done:
            a_rows.append((label, p1, p2, p3))
            turn = "B"
            continue
        if turn == "A":
            a_rows.append((label, p1, p2, p3))
            turn = "B"
        else:
            b_rows.append((label, p1, p2, p3))
            turn = "A"
    if not a_rows or not b_rows:
        return None
    # Validate each side's column-1 sum hits ~100% (FADA rounds to two
    # decimals so allow a small drift).
    for rows in (a_rows, b_rows):
        s = sum(row[1] for row in rows)
        if abs(s - 100.0) > 1.0:
            return None
    return a_rows, b_rows


def _rows_to_dict(rows: list) -> dict[str, float]:
    """Convert (LABEL, p1, p2, p3) rows to {fuel_display_name: p1}."""
    out: dict[str, float] = {}
    for label, p1, _, _ in rows:
        display = FUEL_DISPLAY.get(label, label.title())
        out[display] = p1
    return out


CATEGORY_LABELS = {
    "Two-Wheeler": "2W",
    "Three-Wheeler": "3W",
    "Passenger Vehicle": "PV",
    "Commercial Vehicle": "CV",
    "Tractor": "TRACTOR",
    "Construction Equipment": "CE",
}


def parse_fuel_mix_lenient(compact_pages: str, month_id: str) -> dict | None:
    """Lenient backup of dashboard.update_snapshot.parse_fada_monthly_fuel_mix.

    Tolerates:
      * Either prefix: "All India Fuel Wise Vehicle Retail Data for X"
        (mid-2026 onwards) or "Fuel Wise Vehicle Retail Market Share
        for X" (older releases).
      * Any pairing of categories per side-by-side table (FADA shuffles
        which two categories share a printed row across releases).
      * Variable per-category fuel rows (Hydrogen / Hybrid / EV / etc).
      * Row reordering inside a chunk — the row-by-row walker uses
        each category's first-column percentages summing to ~100% as
        the invariant, not a hardcoded fuel sequence.

    Returns the same dict shape as the strict parser
    (``{category: {fuel: pct}}``) so downstream callers (``ev_share_series``
    builder, ``latest_fuel_mix`` consumer) are unchanged."""
    parsed = datetime.strptime(month_id, "%Y-%m")
    cur_marker = f"{parsed.strftime('%b')}'{parsed.strftime('%y')}"
    prior_dt = (parsed - timedelta(days=1)).replace(day=1)
    prior_marker = f"{prior_dt.strftime('%b')}'{prior_dt.strftime('%y')}"
    yoy_dt = parsed.replace(year=parsed.year - 1)
    yoy_marker = f"{yoy_dt.strftime('%b')}'{yoy_dt.strftime('%y')}"

    # Try each known prefix until one lands.
    candidates = [
        f"All India Fuel Wise Vehicle Retail Data for {cur_marker}",
        f"Fuel Wise Vehicle Retail Market Share for {cur_marker}",
    ]
    start = -1
    for marker in candidates:
        start = compact_pages.find(marker)
        if start != -1:
            break
    if start == -1:
        return None
    # Limit to the next ~3000 chars so we don't scan into the urban /
    # rural retail strength tables that follow.
    section = compact_pages[start:start + 3000]

    cat_alt = "|".join(re.escape(name) for name in CATEGORY_LABELS)
    triplet = re.escape(f" {cur_marker} {prior_marker} {yoy_marker}")
    pair_header_re = re.compile(
        rf"({cat_alt}){triplet}\s+({cat_alt}){triplet}"
    )
    pair_starts = [
        (m.start(), m.end(), m.group(1), m.group(2))
        for m in pair_header_re.finditer(section)
    ]
    if not pair_starts:
        return None

    fuel_mix: dict[str, dict[str, float]] = {}
    for index, (start_pos, end_pos, cat_a, cat_b) in enumerate(pair_starts):
        chunk_start = end_pos
        chunk_end = (
            pair_starts[index + 1][0] if index + 1 < len(pair_starts) else len(section)
        )
        chunk = section[chunk_start:chunk_end]
        # Trim the trailing "Source: FADA Research" + everything after,
        # which tends to live in the last chunk.
        cut = chunk.find("Source: FADA Research")
        if cut != -1:
            chunk = chunk[:cut]
        split = _split_pair_chunk(chunk)
        if not split:
            return None
        a_rows, b_rows = split
        cat_a_id = CATEGORY_LABELS.get(cat_a)
        cat_b_id = CATEGORY_LABELS.get(cat_b)
        if not cat_a_id or not cat_b_id:
            return None
        fuel_mix[cat_a_id] = _rows_to_dict(a_rows)
        fuel_mix[cat_b_id] = _rows_to_dict(b_rows)

    # Require every primary category we plan to surface in
    # ``ev_share_series`` (2W / 3W / PV / CV) so we don't ship a
    # half-month with EV % missing.
    if not all(cat in fuel_mix for cat in ("2W", "3W", "PV", "CV")):
        return None
    return fuel_mix


def main() -> None:
    snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    history = json.loads(FADA_HISTORY_PATH.read_text(encoding="utf-8"))
    fada = snapshot.setdefault("fada", {})
    monthly_fuel_mix = history.setdefault("monthly_fuel_mix", {})
    ev_share_series = list(fada.get("ev_share_series") or [])

    pdfs_by_month = _gather_pdfs(FADA_PDF_DIR, Path("."))
    if not pdfs_by_month:
        print(f"No FADA PDFs found under {FADA_PDF_DIR}", file=sys.stderr)
        sys.exit(1)

    parsed_strict = 0
    parsed_lenient = 0
    skipped = 0
    extract_failed = 0

    for month_id, path in pdfs_by_month.items():
        try:
            pdf_bytes = path.read_bytes()
            pages = extract_pdf_pages(pdf_bytes)
        except Exception as exc:
            extract_failed += 1
            print(f"  [{month_id}] extract failed: {exc}", flush=True)
            continue

        compact = compact_pdf_pages(pages)
        fuel_mix = None
        try:
            fuel_mix = parse_fada_monthly_fuel_mix(compact, month_id)
            if fuel_mix:
                parsed_strict += 1
        except Exception:
            fuel_mix = None
        if not fuel_mix:
            try:
                fuel_mix = parse_fuel_mix_lenient(compact, month_id)
            except Exception as exc:
                print(f"  [{month_id}] lenient parser raised: {exc}", flush=True)
                fuel_mix = None
            if fuel_mix:
                parsed_lenient += 1

        if not fuel_mix:
            skipped += 1
            continue

        monthly_fuel_mix[month_id] = fuel_mix
        ev_share_series = upsert_fada_ev_share_series(ev_share_series, month_id, fuel_mix)
        print(f"  [{month_id}] fuel_mix: {len(fuel_mix)} categories", flush=True)

    fada["ev_share_series"] = ev_share_series
    if monthly_fuel_mix:
        latest_month = max(monthly_fuel_mix.keys())
        fada["latest_fuel_mix"] = monthly_fuel_mix[latest_month]

    snapshot["fada"] = fada
    SNAPSHOT_PATH.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    FADA_HISTORY_PATH.write_text(json.dumps(history, indent=2), encoding="utf-8")

    months_in_history = sorted(monthly_fuel_mix.keys())
    months_in_share = sorted({r["month"] for r in ev_share_series})
    print("\n=== Summary ===")
    print(f"  PDFs scanned: {len(pdfs_by_month)}")
    print(f"  fuel_mix parsed (strict): {parsed_strict}")
    print(f"  fuel_mix parsed (lenient): {parsed_lenient}")
    print(f"  no annexure / unparseable: {skipped}")
    print(f"  PDF extract failed: {extract_failed}")
    print(f"  monthly_fuel_mix months: {len(months_in_history)}")
    if months_in_history:
        print(f"    range: {months_in_history[0]} → {months_in_history[-1]}")
    print(f"  ev_share_series rows: {len(ev_share_series)}")
    if months_in_share:
        print(f"    months: {months_in_share[0]} → {months_in_share[-1]}")


if __name__ == "__main__":
    main()
