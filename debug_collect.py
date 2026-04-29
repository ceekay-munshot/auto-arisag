from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from dashboard.live_collectors import (
    collect_bse_detail,
    collect_bse_announcements,
    collect_mobility_outlook,
    collect_rss,
    collect_siam_detail,
    collect_siam_press_releases,
)
from dashboard.live_config import SOURCES


LOG_PATH = Path("debug_collect.log")


def log(message: str) -> None:
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(message + "\n")


def main() -> None:
    LOG_PATH.write_text("", encoding="utf-8")
    since = datetime.now(UTC) - timedelta(days=60)
    funcs = {
        "bse_detail": collect_bse_detail,
        "rss": collect_rss,
        "mobility_json": collect_mobility_outlook,
        "siam_press": collect_siam_press_releases,
        "siam_detail": collect_siam_detail,
        "bse_announcements": collect_bse_announcements,
    }
    for source in SOURCES:
        log(f"START {source.name} {datetime.now(UTC).isoformat()}")
        result = funcs[source.kind](source, since)
        log(f"DONE {source.name} {result.status} {len(result.items)} {result.message} {datetime.now(UTC).isoformat()}")


if __name__ == "__main__":
    main()
