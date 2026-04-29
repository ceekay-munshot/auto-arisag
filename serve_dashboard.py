from __future__ import annotations

import argparse
import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from dashboard.build import build_dashboard, refresh_dashboard


class DashboardHandler(SimpleHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/refresh":
            self.send_error(404, "Not found")
            return

        try:
            payload, source_updates = refresh_dashboard(Path("data/investor_dashboard.json"))
            body = json.dumps(
                {
                    "ok": True,
                    "generated_at": payload.get("generated_at"),
                    "payload": payload,
                    "source_updates": source_updates,
                }
            ).encode("utf-8")
            self.send_response(200)
        except Exception as exc:  # pragma: no cover
            body = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
            self.send_response(500)

        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the investor dashboard locally.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8000, type=int)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"Serving dashboard at http://{args.host}:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
