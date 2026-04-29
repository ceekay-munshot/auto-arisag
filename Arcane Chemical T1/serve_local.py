from __future__ import annotations

import http.server
import json
import socket
import socketserver
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DIST_DIR = ROOT / "dist"
SOURCE_DOCS_DIR = ROOT / "data" / "source_docs"
EXTRACTED_TEXT_DIR = ROOT / "data" / "cache" / "extracted_text"
SOURCE_REGISTRY_PATH = ROOT / "data" / "manual" / "source_registry.json"
BUILD_LOCK = threading.Lock()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST_DIR), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/source":
            self.handle_source_lookup(parsed)
            return
        if parsed.path.startswith("/local-source/"):
            self.handle_local_file(SOURCE_DOCS_DIR, parsed.path.removeprefix("/local-source/"))
            return
        if parsed.path.startswith("/local-text/"):
            self.handle_local_file(EXTRACTED_TEXT_DIR, parsed.path.removeprefix("/local-text/"), content_type="text/plain; charset=utf-8")
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.rstrip("/") == "/api/refresh-event":
            self.handle_refresh_event()
            return
        self.send_error(404, "Endpoint not found")

    def handle_refresh_event(self) -> None:
        if BUILD_LOCK.locked():
            self.send_json(409, {"ok": False, "error": "A dashboard refresh is already running."})
            return
        with BUILD_LOCK:
            try:
                completed = subprocess.run(
                    [sys.executable, str(ROOT / "scripts" / "build_dashboard.py"), "--refresh-live"],
                    cwd=str(ROOT),
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.send_json(
                    200,
                    {
                        "ok": True,
                        "message": "Dashboard live data refreshed.",
                        "stdout": completed.stdout.strip(),
                    },
                )
            except subprocess.CalledProcessError as exc:
                self.send_json(
                    500,
                    {
                        "ok": False,
                        "error": "Dashboard refresh failed.",
                        "stdout": (exc.stdout or "").strip(),
                        "stderr": (exc.stderr or "").strip(),
                    },
                )

    def handle_source_lookup(self, parsed) -> None:
        source_id = parse_qs(parsed.query).get("id", [""])[0]
        if not source_id:
            self.send_json(400, {"ok": False, "error": "Missing source id."})
            return
        sources = json.loads(SOURCE_REGISTRY_PATH.read_text(encoding="utf-8")) if SOURCE_REGISTRY_PATH.exists() else []
        source = next((item for item in sources if item.get("id") == source_id), None)
        if not source:
            self.send_json(404, {"ok": False, "error": "Source not found."})
            return

        local_doc_url = None
        local_text_url = None
        excerpt = None

        local_path = source.get("local_path")
        if local_path:
            doc_path = (ROOT / local_path).resolve()
            if doc_path.exists() and SOURCE_DOCS_DIR.resolve() in doc_path.parents:
                local_doc_url = f"/local-source/{doc_path.name}"
                text_path = EXTRACTED_TEXT_DIR / f"{doc_path.stem}.txt"
                if text_path.exists():
                    local_text_url = f"/local-text/{text_path.name}"
                    excerpt = build_excerpt(text_path)

        payload = dict(source)
        payload["local_doc_url"] = local_doc_url
        payload["local_text_url"] = local_text_url
        payload["excerpt"] = excerpt
        self.send_json(200, payload)

    def handle_local_file(self, base_dir: Path, filename: str, content_type: str | None = None) -> None:
        safe_name = Path(filename).name
        target = (base_dir / safe_name).resolve()
        if not target.exists() or base_dir.resolve() not in target.parents:
            self.send_error(404, "File not found")
            return
        body = target.read_bytes()
        guessed = content_type or self.guess_type(str(target))
        self.send_response(200)
        self.send_header("Content-Type", guessed)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def build_excerpt(path: Path, limit: int = 28) -> str:
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    cleaned = [line.strip() for line in lines if line.strip()]
    return "\n".join(cleaned[:limit]) if cleaned else ""


def main() -> None:
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_dashboard.py")], check=True)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    host = "0.0.0.0"
    with ReusableTCPServer((host, port), DashboardHandler) as httpd:
        try:
            lan_ip = socket.gethostbyname(socket.gethostname())
        except OSError:
            lan_ip = None
        print(f"Serving Arcane Chemical dashboard at http://localhost:{port}")
        print(f"Loopback URL: http://127.0.0.1:{port}")
        if lan_ip and lan_ip != "127.0.0.1":
            print(f"LAN URL: http://{lan_ip}:{port}")
        print("Use HTTP, not file://, so the frontend can fetch the canonical JSON payload.")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
