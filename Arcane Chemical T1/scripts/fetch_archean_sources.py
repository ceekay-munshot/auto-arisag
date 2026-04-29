from __future__ import annotations

import json
from pathlib import Path

import requests


ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = ROOT / "data" / "manual" / "source_registry.json"


def main() -> None:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})

    for source in registry:
        local_path = source.get("local_path")
        url = source.get("url")
        if not local_path or not url:
            continue
        out_path = ROOT / local_path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        response = session.get(url, timeout=120)
        response.raise_for_status()
        out_path.write_bytes(response.content)
        print(f"Downloaded {source['id']} -> {out_path}")


if __name__ == "__main__":
    main()
