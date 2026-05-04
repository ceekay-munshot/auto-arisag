"""Refresh ``data/launches_snapshot.json`` with the latest model-launch
articles from the trade-media RSS feeds (RushLane, ET Auto, Autocar
Professional, EVReporter).

The actual heavy lifting is in ``dashboard.launches_digest`` — this is just a
thin entry point so the GitHub Actions cron can run it directly. Idempotent:
when the article set is unchanged the snapshot file is not rewritten, so the
workflow's commit_check step stays clean.

Run via the GitHub Actions cron — sandbox networks usually can't reach
RushLane / EVReporter, so this only does useful work on the runner.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dashboard.launches_digest import refresh_launches_snapshot  # noqa: E402


def main() -> int:
    digest, update = refresh_launches_snapshot()
    print(f"[{update['status'].upper()}] {update['message']}", flush=True)
    if digest.get("available"):
        print(
            f"  total items: {digest['item_count']} across {len(digest['companies'])} companies "
            f"(window {digest['window_days']}d)",
            flush=True,
        )
        for company in digest["companies"]:
            print(
                f"    {company['company']}: {company['count']} launch(es), "
                f"latest \"{company['latest_title'][:60]}\"",
                flush=True,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
