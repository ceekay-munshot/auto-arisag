"""Refresh ``data/macro_indicators.json`` with live USD/INR from Yahoo
Finance, plus a manual-update path for the slower-moving indicators.

Why a mix of live and manual:

- **USD/INR** — Yahoo Finance returns the spot rate via a free public
  endpoint that doesn't need an API key. We fetch it on every cron run.
- **RBI repo rate** — changes ~6 times a year on MPC announcement days.
  Hardcoded value updated by hand whenever the MPC moves; the scraper
  preserves whatever's currently in the file.
- **Petrol / Diesel (Delhi)** — PPAC publishes daily, but the page is
  bot-blocked. We try a best-effort fetch from a fallback source
  (Goodreturns) and fall back to the prior value on failure.

Run via the GitHub Actions cron — the runner has clean network egress.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import requests


HISTORY_PATH = Path("data/macro_indicators.json")
TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36"
    ),
    "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

YAHOO_CHART_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
    "?interval=1d&range=10y&includePrePost=false"
)


def _yahoo_daily_series(ticker: str) -> list[dict]:
    """Fetch up to 10 years of daily {date, close} pairs for a Yahoo
    ticker. Used by USD/INR and any other long-history macro indicator
    so the dashboard can chart a 6-year history. Returns chronological
    list; empty on failure."""
    from datetime import datetime as _dt
    url = YAHOO_CHART_URL.format(ticker=quote(ticker, safe=""))
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        print(f"  yahoo fetch failed for {ticker}: {exc}", flush=True)
        return []
    try:
        result = payload["chart"]["result"][0]
        timestamps = result["timestamp"]
        closes = result["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError) as exc:
        print(f"  yahoo parse failed for {ticker}: {exc}", flush=True)
        return []
    out = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        out.append({
            "date": _dt.utcfromtimestamp(ts).strftime("%Y-%m-%d"),
            "close": round(float(close), 4),
        })
    return out


def _yahoo_close_series(ticker: str) -> list[float]:
    """Backward-compat wrapper used by the existing 1D/1W delta path."""
    return [d["close"] for d in _yahoo_daily_series(ticker)]


def _delta_pct(closes: list[float], lookback: int) -> float | None:
    """Percent change from `lookback` periods ago to latest close."""
    if len(closes) <= lookback:
        return None
    latest = closes[-1]
    prior = closes[-1 - lookback]
    if prior is None or prior == 0:
        return None
    return round((latest - prior) / prior * 100, 2)


def _refresh_usd_inr(existing: dict) -> dict:
    daily = _yahoo_daily_series("USDINR=X")
    if not daily:
        return existing
    closes = [d["close"] for d in daily]
    latest = closes[-1]
    delta_value = round(latest - closes[-2], 4) if len(closes) >= 2 else 0.0
    delta_1w = _delta_pct(closes, 5)  # ~5 trading days
    if delta_1w is None:
        label = "Latest live read"
        tone = "neutral"
    else:
        sign = "+" if delta_1w >= 0 else ""
        label = f"{sign}{delta_1w:.2f}% in last week (Yahoo Finance)"
        tone = "negative" if delta_1w > 0 else ("positive" if delta_1w < 0 else "neutral")
    return {
        **existing,
        "value": round(latest, 2),
        "delta_value": delta_value,
        "delta_label": label,
        "delta_tone": tone,
        # 10y of daily closes so the dashboard can show 6Y history charts.
        "daily_closes": daily,
        "source_name": "Yahoo Finance — USDINR=X",
        "source_url": "https://finance.yahoo.com/quote/USDINR%3DX/",
    }


def _refresh_fuel_price(existing: dict, fuel_type: str) -> dict:
    """Best-effort fuel price scrape from Goodreturns (which sources from
    OMC daily price sheets). Returns the prior value on any failure so
    the dashboard never goes blank."""
    url = f"https://www.goodreturns.in/{fuel_type}-price-in-new-delhi.html"
    try:
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        text = response.text
    except Exception as exc:
        print(f"  fuel price fetch failed ({fuel_type}): {exc}", flush=True)
        return existing
    # Goodreturns embeds the current price in a header like:
    #   <span class="rupee">₹</span> 95.41 / Litre
    match = re.search(r"<span[^>]*rupee[^>]*>\s*₹\s*</span>\s*([\d.]+)\s*/\s*Litre", text)
    if not match:
        match = re.search(r"₹\s*([\d.]{4,6})\s*/\s*Litre", text)
    if not match:
        print(f"  fuel price regex miss ({fuel_type}); leaving prior value", flush=True)
        return existing
    try:
        price = round(float(match.group(1)), 2)
    except ValueError:
        return existing
    prior = existing.get("value")
    delta_value = round(price - prior, 2) if isinstance(prior, (int, float)) else 0.0
    sign = "+" if delta_value > 0 else ("−" if delta_value < 0 else "")
    label = (
        f"Unchanged" if delta_value == 0
        else f"{sign}₹{abs(delta_value):.2f} vs prior reading"
    )
    tone = "neutral" if delta_value == 0 else ("negative" if delta_value > 0 else "positive")
    return {
        **existing,
        "value": price,
        "delta_value": delta_value,
        "delta_label": label,
        "delta_tone": tone,
        "source_name": "Goodreturns (OMC daily prices)",
        "source_url": url,
    }


# Curated RBI repo-rate timeline from MPC announcements. Sourced from
# RBI's monetary policy statements and press releases. Each entry =
# {effective_date, repo_rate, change_bps, mpc_url}. Updated on each new
# MPC announcement; lets the dashboard chart a 6-year repo trajectory
# alongside the auto-credit-cycle visualisation.
REPO_RATE_HISTORY = [
    {"effective_date": "2020-03-27", "repo_rate": 4.40, "change_bps": -75, "note": "COVID emergency cut"},
    {"effective_date": "2020-05-22", "repo_rate": 4.00, "change_bps": -40, "note": "Off-cycle COVID cut"},
    {"effective_date": "2022-05-04", "repo_rate": 4.40, "change_bps": +40, "note": "Off-cycle inflation hike"},
    {"effective_date": "2022-06-08", "repo_rate": 4.90, "change_bps": +50, "note": "Inflation tightening"},
    {"effective_date": "2022-08-05", "repo_rate": 5.40, "change_bps": +50, "note": "Inflation tightening"},
    {"effective_date": "2022-09-30", "repo_rate": 5.90, "change_bps": +50, "note": "Inflation tightening"},
    {"effective_date": "2022-12-07", "repo_rate": 6.25, "change_bps": +35, "note": "Tightening pace slowed"},
    {"effective_date": "2023-02-08", "repo_rate": 6.50, "change_bps": +25, "note": "Final hike of cycle"},
    {"effective_date": "2025-02-07", "repo_rate": 6.25, "change_bps": -25, "note": "First cut of new cycle"},
    {"effective_date": "2025-04-09", "repo_rate": 6.00, "change_bps": -25, "note": "Easing continues"},
    {"effective_date": "2025-06-06", "repo_rate": 5.50, "change_bps": -50, "note": "50 bps acceleration"},
    {"effective_date": "2026-04-09", "repo_rate": 5.50, "change_bps": 0, "note": "Hold"},
]


def _refresh_repo_rate(existing: dict) -> dict:
    """Update the latest repo rate to the most recent timeline entry,
    and persist the full history array for the dashboard to chart."""
    if not REPO_RATE_HISTORY:
        return existing
    latest = REPO_RATE_HISTORY[-1]
    return {
        **existing,
        "value": latest["repo_rate"],
        "history": REPO_RATE_HISTORY,
        "source_name": "RBI MPC announcements",
        "source_url": "https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx",
    }


def _refresh_indicator(indicator: dict) -> dict:
    if indicator["id"] == "usd_inr":
        return _refresh_usd_inr(indicator)
    if indicator["id"] == "petrol_delhi":
        return _refresh_fuel_price(indicator, "petrol")
    if indicator["id"] == "diesel_delhi":
        return _refresh_fuel_price(indicator, "diesel")
    if indicator["id"] == "repo_rate":
        return _refresh_repo_rate(indicator)
    return indicator


def main() -> int:
    if not HISTORY_PATH.exists():
        print(f"missing {HISTORY_PATH}", file=sys.stderr)
        return 1
    payload = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    indicators = payload.get("indicators") or []
    refreshed = []
    changed = 0
    for ind in indicators:
        new_ind = _refresh_indicator(ind)
        if new_ind != ind:
            changed += 1
            print(f"  {ind['id']}: {ind.get('value')} -> {new_ind.get('value')}", flush=True)
        refreshed.append(new_ind)
    payload["indicators"] = refreshed
    payload["as_of_date"] = datetime.now().strftime("%Y-%m-%d")
    payload["source_note"] = "Live updates: USD/INR via Yahoo Finance, fuel prices via Goodreturns. Repo rate manually updated on RBI MPC announcements."
    HISTORY_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {HISTORY_PATH} ({changed} indicators changed).", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
