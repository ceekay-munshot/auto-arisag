"""Refresh ``data/oem_earnings_calendar.json`` with upcoming OEM result
announcement dates from the NSE corporate-filings event calendar.

NSE publishes a public JSON feed of board-meeting / earnings event
announcements at:

    https://www.nseindia.com/api/event-calendar?index=equities

That endpoint enforces a Cookie-based auth flow (you have to load the
homepage first to get the session cookie), but it returns JSON when
the dance is done. Each row has: symbol, company name, board-meeting
purpose (e.g. "Quarterly Results"), and the meeting date.

This scraper is best-effort. If the NSE flow blocks the runner (it
sometimes does on cloud IPs), we keep the existing hand-seeded events.
Idempotent — known events stay, new ones are appended.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import requests


HISTORY_PATH = Path("data/oem_earnings_calendar.json")
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-event-calendar",
}

NSE_HOME_URL = "https://www.nseindia.com"
NSE_EVENTS_URL = "https://www.nseindia.com/api/event-calendar?index=equities"

# Map NSE ticker → our internal company name. Lets the scraper match
# rows from NSE back to the companies we already track on the dashboard.
TICKER_TO_COMPANY = {
    "MARUTI": "Maruti Suzuki",
    "M&M": "Mahindra & Mahindra",
    "HEROMOTOCO": "Hero MotoCorp",
    "TVSMOTOR": "TVS Motor",
    "BAJAJ-AUTO": "Bajaj Auto",
    "HYUNDAI": "Hyundai Motor India",
    "EICHERMOT": "Eicher Motors",
    "TMPV": "Tata Motors",
    "TMCV": "Tata Motors CV",
    "ASHOKLEY": "Ashok Leyland",
    "ESCORTS": "Escorts Kubota",
    "ACE": "Action Construction Equipment",
    "ATULAUTO": "Atul Auto",
}


def _nse_session() -> requests.Session | None:
    """Establish a Cookie-bearing session with NSE. Without this the
    JSON API returns 401."""
    session = requests.Session()
    session.headers.update(HEADERS)
    try:
        session.get(NSE_HOME_URL, timeout=TIMEOUT)
        return session
    except Exception as exc:
        print(f"  NSE home fetch failed: {exc}", flush=True)
        return None


def _fetch_nse_events(session: requests.Session) -> list[dict]:
    try:
        response = session.get(NSE_EVENTS_URL, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        print(f"  NSE events fetch failed: {exc}", flush=True)
        return []
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return payload.get("data") or payload.get("events") or []
    return []


def _normalise_date(raw: str) -> str | None:
    """NSE returns dates like '14-May-2026'; coerce to YYYY-MM-DD."""
    raw = (raw or "").strip()
    for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _is_earnings_purpose(purpose: str) -> bool:
    return bool(re.search(r"financial result|quarterly result|audited result|unaudited result", purpose or "", re.IGNORECASE))


def _load_existing() -> dict:
    if not HISTORY_PATH.exists():
        return {"as_of_date": "", "source_note": "", "events": []}
    try:
        return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"as_of_date": "", "source_note": "", "events": []}


def _save(payload: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    payload = _load_existing()
    existing_events: list[dict] = payload.get("events") or []
    # Dedupe key: company + date + period_label
    seen = {(e.get("company"), e.get("date"), e.get("period_label")) for e in existing_events}

    session = _nse_session()
    if session is None:
        print("NSE session not established — keeping existing seeded events.", flush=True)
        return 0

    rows = _fetch_nse_events(session)
    if not rows:
        print("NSE returned 0 event rows — keeping existing seeded events.", flush=True)
        return 0

    added = 0
    for row in rows:
        ticker = (row.get("symbol") or row.get("scrip") or "").strip().upper()
        if ticker not in TICKER_TO_COMPANY:
            continue
        purpose = row.get("purpose") or row.get("subject") or ""
        if not _is_earnings_purpose(purpose):
            continue
        date_iso = _normalise_date(row.get("date") or row.get("bm_date") or row.get("meetingDate") or "")
        if not date_iso:
            continue
        company = TICKER_TO_COMPANY[ticker]
        period_label = re.sub(r"\s+", " ", purpose).strip()
        key = (company, date_iso, period_label)
        if key in seen:
            continue
        seen.add(key)
        existing_events.append({
            "company": company,
            "ticker": ticker,
            "date": date_iso,
            "period_label": period_label,
            "event_type": "earnings",
            "source_url": f"https://www.nseindia.com/get-quotes/equity?symbol={ticker}",
        })
        added += 1
        print(f"  + {date_iso}  {company:30s}  {period_label}", flush=True)

    # Drop events older than 60 days so the file doesn't grow forever.
    cutoff = (datetime.utcnow() - timedelta(days=60)).strftime("%Y-%m-%d")
    pruned = [e for e in existing_events if e.get("date", "") >= cutoff]
    dropped = len(existing_events) - len(pruned)
    pruned.sort(key=lambda e: e.get("date", ""))

    payload["events"] = pruned
    payload["as_of_date"] = datetime.utcnow().strftime("%Y-%m-%d")
    if added:
        payload["source_note"] = (
            "Auto-extended by the NSE corporate-filings scraper "
            "(scripts/refresh_earnings_calendar.py). Hand-seeded fallbacks remain when NSE is unreachable."
        )
    _save(payload)
    print(f"\nWrote {HISTORY_PATH} (added {added}, pruned {dropped}, total {len(pruned)}).", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
