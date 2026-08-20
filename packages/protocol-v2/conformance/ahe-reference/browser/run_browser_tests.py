#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import http.server
import json
import os
import pathlib
import socket
import threading
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT.parent / "results" / "chromium-browser-validation.json"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


@contextlib.contextmanager
def local_server():
    class Server(http.server.ThreadingHTTPServer):
        allow_reuse_address = True

    server = Server(("127.0.0.1", 0), lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/browser/harness.html"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def write_result(result: dict) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, sort_keys=True))


def main() -> int:
    executable = os.environ.get("AHE_CHROMIUM", "/usr/bin/chromium")
    with local_server() as url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=executable,
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = browser.new_page()
        console: list[str] = []
        page.on("console", lambda message: console.append(f"{message.type}: {message.text}"))
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_function("window.__AHE_RESULTS__ !== undefined", timeout=120_000)
            result = page.evaluate("window.__AHE_RESULTS__")
            result["console"] = console
            result["browserExecutable"] = executable
            write_result(result)
            return 0 if result.get("verdict") == "pass" else 1
        except PlaywrightError as error:
            message = str(error)
            blocked = "ERR_BLOCKED_BY_ADMINISTRATOR" in message
            result = {
                "verdict": "blocked" if blocked else "fail",
                "browserExecutable": executable,
                "url": url,
                "error": message,
                "console": console,
                "note": (
                    "The managed Chromium policy in this execution environment blocks all navigation; "
                    "run this same harness in a normal secure browser profile."
                    if blocked
                    else "Browser harness failed before producing test results."
                ),
            }
            write_result(result)
            return 2 if blocked else 1
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
