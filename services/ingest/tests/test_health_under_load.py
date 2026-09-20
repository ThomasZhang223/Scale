"""Does /health still answer while /extract is working? Run: python3 tests/test_health_under_load.py

A real uvicorn in a subprocess, probed over real HTTP, because that is the only way to see
this bug. TestClient runs the app in its own portal thread, so a nested probe re-enters and
passes whether or not the event loop is blocked — a test that cannot fail is worse than none.

The bug: extract_with_llm is synchronous. Awaited straight from the async handler it stopped
the process, and compose marks the container unhealthy after five consecutive 3s timeouts on
a 5s interval. At the default aiLimit of 40 a single /extract blocks well past that.
"""

import json, os, subprocess, sys, threading, time, urllib.request, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("HEALTH_TEST_PORT") or 8098)
MOCK_PORT = PORT + 1
TOKEN = "health-test-token"

# Matches the compose healthcheck: interval 5s, timeout 3s, retries 5.
HEALTH_TIMEOUT_S = 3.0
UNHEALTHY_AFTER = 5

MOCK = f'''
import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
BODY = json.dumps({{"choices": [{{"message": {{"content": json.dumps(
    {{"width_cm": 152.0, "height_cm": 74.0, "depth_cm": 76.0, "unit": "cm",
      "source_quote": "W 152 x D 76 x H 74 cm"}})}}}}]}}).encode()
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        time.sleep(0.4)
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)
    def log_message(self, *a): pass
ThreadingHTTPServer(("127.0.0.1", {MOCK_PORT}), H).serve_forever()
'''


def _health():
    t = time.time()
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=HEALTH_TIMEOUT_S)
        return time.time() - t
    except Exception:
        return None


def test_health_stays_answerable_during_an_extract():
    mock = subprocess.Popen([sys.executable, "-c", MOCK],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    env = dict(os.environ, UPSTREAM_TOKEN=TOKEN, OPENAI_API_KEY="k", OPENAI_MODEL="m",
               OPENAI_GATEWAY_URL=f"http://127.0.0.1:{MOCK_PORT}")
    srv = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
         "--port", str(PORT)],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            if _health() is not None:
                break
            time.sleep(0.5)
        else:
            raise AssertionError("service never came up")

        products = [{"id": i, "title": f"Item {i}", "handle": f"item-{i}",
                     "product_type": "Desks", "variants": [{"price": "1.00"}],
                     "options": [], "body_html": "no numbers in this description",
                     "images": [{"src": "https://cdn.example.com/a.jpg"}]} for i in range(20)]
        body = json.dumps({"merchant": "m", "storefront": "https://s.com",
                           "products": products, "llm": True, "aiLimit": 20}).encode()

        state = {}

        def fire():
            req = urllib.request.Request(
                f"http://127.0.0.1:{PORT}/extract", data=body,
                headers={"content-type": "application/json", "X-Upstream-Token": TOKEN})
            t = time.time()
            state["body"] = json.loads(urllib.request.urlopen(req, timeout=300).read())
            state["seconds"] = time.time() - t

        th = threading.Thread(target=fire)
        th.start()
        time.sleep(0.3)

        probes = []
        while th.is_alive() and len(probes) < 20:
            probes.append(_health())
            time.sleep(0.25)
        th.join()

        assert state.get("body"), "extract never returned"
        assert probes, "extract finished before any probe — raise the product count"

        worst = run = 0
        for pr in probes:
            run = run + 1 if pr is None else 0
            worst = max(worst, run)
        failed = sum(1 for pr in probes if pr is None)
        assert worst < UNHEALTHY_AFTER, (
            f"{worst} consecutive /health timeouts during /extract; compose marks the "
            f"container unhealthy at {UNHEALTHY_AFTER}")
        assert failed == 0, f"{failed}/{len(probes)} health probes timed out at {HEALTH_TIMEOUT_S}s"

        # 20 products x 0.4s serial is 8s; overlapped it should be a small fraction.
        assert state["seconds"] < 20 * 0.4 * 0.6, (
            f"/extract took {state['seconds']:.1f}s; serial would be ~8s — no overlap")
    finally:
        srv.terminate(); mock.terminate()
        srv.wait(timeout=10); mock.wait(timeout=10)


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"PASS {name}")
            except Exception as e:
                print(f"FAIL {name}: {type(e).__name__}: {e}"); fails += 1
    print(f"\n{fails} failed")
    sys.exit(1 if fails else 0)
