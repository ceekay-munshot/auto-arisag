from __future__ import annotations

import argparse
from pathlib import Path

from dashboard.build import build_dashboard, refresh_dashboard


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the India Auto Demand Monitor dataset.")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/investor_dashboard.json"),
        help="Where the dashboard JSON should be written.",
    )
    parser.add_argument(
        "--refresh-live",
        action="store_true",
        help="Try to fetch fresher official source data before rebuilding the dashboard.",
    )
    args = parser.parse_args()

    if args.refresh_live:
        payload, source_updates = refresh_dashboard(args.output)
        updated = sum(1 for item in source_updates if item.get("updated"))
        warnings = sum(1 for item in source_updates if item.get("status") == "warning")
        print(f"Live refresh checked {len(source_updates)} sources, updated {updated}, warnings {warnings}.")
    else:
        payload = build_dashboard(args.output)
    print(f"Wrote dashboard with {payload['summary']['active_module_count']} active modules to {args.output}")


if __name__ == "__main__":
    main()
