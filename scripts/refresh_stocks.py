"""Refresh ``data/oem_stocks.json`` with live NSE close prices and
1D / 1W / 1M % changes from Yahoo Finance for every listed OEM and
ancillary tracked on the dashboard.

Yahoo Finance returns daily candles for any NSE ticker via the public
v8 chart API (no key, no auth). We grab a 3-month range, then compute
1D / 1W / 1M deltas from the closing series. Any ticker that fails
(delisted, bot-block, missing) keeps its prior values so the dashboard
never goes blank.

Run via the GitHub Actions cron — runner egress works.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import requests


HISTORY_PATH = Path("data/oem_stocks.json")
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}
YAHOO_CHART_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
    "?interval=1d&range=3mo&includePrePost=false"
)


def _fetch_closes(yahoo_ticker: str) -> list[float]:
    """Return chronological close-price series for a Yahoo ticker."""
    url = YAHOO_CHART_URL.format(ticker=quote(yahoo_ticker, safe=""))
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        print(f"  yahoo fetch failed for {yahoo_ticker}: {exc}", flush=True)
        return []
    try:
        result = payload["chart"]["result"][0]
        closes = result["indicators"]["quote"][0]["close"]
        return [c for c in closes if c is not None]
    except (KeyError, IndexError, TypeError) as exc:
        print(f"  yahoo parse failed for {yahoo_ticker}: {exc}", flush=True)
        return []


def _delta_pct(closes: list[float], lookback: int) -> float | None:
    if len(closes) <= lookback:
        return None
    latest = closes[-1]
    prior = closes[-1 - lookback]
    if not prior:
        return None
    return round((latest - prior) / prior * 100, 2)


def _yahoo_ticker(ticker: str) -> str:
    """Map our internal ticker (NSE symbol) to the Yahoo Finance form.
    Yahoo expects ``<SYMBOL>.NS`` for NSE stocks, with `&` URL-encoded."""
    return f"{ticker}.NS"


def main() -> int:
    if not HISTORY_PATH.exists():
        print(f"missing {HISTORY_PATH}", file=sys.stderr)
        return 1
    payload = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    stocks: dict = payload.get("stocks") or {}
    if not stocks:
        print("no stocks defined in oem_stocks.json", file=sys.stderr)
        return 1

    refreshed = 0
    failed = 0
    for company, info in stocks.items():
        ticker = info.get("ticker")
        if not ticker:
            continue
        yahoo = _yahoo_ticker(ticker)
        closes = _fetch_closes(yahoo)
        if not closes:
            failed += 1
            continue
        latest = closes[-1]
        new_info = {
            **info,
            "price": round(latest, 2),
            "change_1d_pct": _delta_pct(closes, 1),
            "change_1w_pct": _delta_pct(closes, 5),  # ~5 trading days
            "change_1m_pct": _delta_pct(closes, 21),  # ~21 trading days
            "yahoo_url": f"https://finance.yahoo.com/quote/{yahoo}/",
        }
        if new_info != info:
            stocks[company] = new_info
            refreshed += 1
            d1 = new_info.get("change_1d_pct")
            d1_text = f"{d1:+.2f}%" if d1 is not None else "—"
            print(f"  {company:30s} ₹{new_info['price']:>9,.2f}  1D {d1_text}", flush=True)

    payload["stocks"] = stocks
    payload["as_of_date"] = datetime.now().strftime("%Y-%m-%d")
    payload["source_note"] = "Live closing prices from Yahoo Finance NSE feeds. 1D / 1W / 1M deltas computed from the daily candles (5 / 21 trading-day lookback)."
    HISTORY_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(
        f"\nWrote {HISTORY_PATH} (refreshed {refreshed}, failed {failed}, "
        f"total tickers {len(stocks)}).",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
