"""HWPX 일지 편집기 로컬 서버.

사용법 (AI 작성까지 쓰려면 .venv의 파이썬으로 켭니다):
  .venv/bin/python serve.py              # 이 컴퓨터에서만: http://127.0.0.1:8765
  .venv/bin/python serve.py --lan        # 같은 와이파이의 다른 PC에서도 접속 (AI는 접속 코드 필요)
  .venv/bin/python serve.py --mock-ai    # API 키 없이 가짜 AI 응답으로 흐름 시험
  .venv/bin/python serve.py --dev SAMPLE # 개발용: 샘플 자동 열기(?sample), 결과 저장(POST /__save)

API 키는 프로젝트 폴더의 .env 파일(ANTHROPIC_API_KEY=...)에만 둡니다. .env는 git에 올라가지 않습니다.
키는 서버 안에서만 쓰이고 브라우저로 보내지 않습니다.
"""
import argparse
import collections
import hmac
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import time
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(BASE, "web")
OUT = os.path.join(BASE, "test_output")
HEAD = (b'<!doctype html><html lang="ko"><head><meta charset="utf-8">'
        b'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        b'</head><body>')
TAIL = b"</body></html>"
MAX_BODY = 512 * 1024          # 일지 채우기 요청 본문 최대 크기
MAX_PLAN_BODY = 30 * 1024 * 1024  # 월안(PDF·사진) 요청 본문 최대 크기
RATE_PER_MINUTE = 6            # 1분에 받을 AI 요청 수
MAX_CONCURRENT = 2             # 동시에 처리할 AI 요청 수


def load_env(path):
    """.env 파일을 읽어 아직 없는 환경 변수만 채운다. 값은 출력하지 않는다."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def ai_mode(mock):
    if mock:
        return "mock", "연습 모드입니다. 자동 작성 서비스를 부르지 않습니다."
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key or key.startswith("여기에"):
        return "off", ".env 파일에 ANTHROPIC_API_KEY를 넣고 서버를 다시 켜면 자동 채우기를 쓸 수 있습니다."
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return "off", "Anthropic SDK가 없습니다. .venv/bin/python serve.py 로 서버를 켜 주세요."
    return "api", ""


class RateLimiter:
    def __init__(self, per_minute, concurrent):
        self.per_minute = per_minute
        self.times = collections.deque()
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(concurrent)

    def allow(self):
        now = time.monotonic()
        with self.lock:
            while self.times and now - self.times[0] > 60:
                self.times.popleft()
            if len(self.times) >= self.per_minute:
                return False
            self.times.append(now)
            return True


class Server(http.server.ThreadingHTTPServer):
    # 같은 포트를 다른 프로그램과 함께 쓰지 않는다(다른 프로세스가 요청을 가로채지 못하게).
    allow_reuse_port = False
    daemon_threads = True


class TrialCounter:
    """무료체험: 접속한 곳(IP)마다 하루에 쓴 횟수를 센다. limit 0이면 제한 없음."""

    def __init__(self, limit):
        self.limit = limit
        self.used = {}
        self.lock = threading.Lock()

    def _key(self, who):
        return (who, time.strftime("%Y-%m-%d"))

    def remaining(self, who):
        if not self.limit:
            return None
        with self.lock:
            return max(0, self.limit - self.used.get(self._key(who), 0))

    def take(self, who):
        """한 번 쓸 수 있으면 True. 실패하면 give_back으로 돌려준다."""
        if not self.limit:
            return True
        with self.lock:
            k = self._key(who)
            if self.used.get(k, 0) >= self.limit:
                return False
            self.used[k] = self.used.get(k, 0) + 1
            # 지난 날짜 기록은 정리한다
            today = k[1]
            for old in [x for x in self.used if x[1] != today]:
                del self.used[old]
            return True

    def give_back(self, who):
        if not self.limit:
            return
        with self.lock:
            k = self._key(who)
            if self.used.get(k, 0) > 0:
                self.used[k] -= 1


def make_handler(cfg):
    import ai_writer

    limiter = RateLimiter(RATE_PER_MINUTE, MAX_CONCURRENT)
    trial = TrialCounter(cfg["trial"])

    class Handler(http.server.SimpleHTTPRequestHandler):
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                          ".js": "text/javascript; charset=utf-8",
                          ".hwpx": "application/hwp+zip"}

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ROOT, **kw)

        def log_message(self, fmt, *args):
            # 요청 본문(일지 내용)과 헤더는 기록하지 않는다. 경로와 상태만 남긴다.
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

        def _local(self):
            return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _code_ok(self):
            if self._local() or not cfg["code"]:
                return True
            given = self.headers.get("X-Access-Code", "")
            return hmac.compare_digest(given.encode(), cfg["code"].encode())

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            super().end_headers()

        def do_GET(self):
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                with open(os.path.join(ROOT, "index.html"), "rb") as f:
                    return self._send(200, HEAD + f.read() + TAIL, "text/html; charset=utf-8")
            if path == "/api/status":
                return self._json(200, {
                    "mode": cfg["mode"], "reason": cfg["reason"],
                    "model": "mock" if cfg["mode"] == "mock" else os.environ.get("KISSAY_MODEL", ai_writer.DEFAULT_MODEL),
                    "needsCode": bool(cfg["code"]) and not self._local(),
                    "trial": ({"limit": cfg["trial"], "remaining": trial.remaining(self.client_address[0])}
                              if cfg["trial"] and cfg["mode"] != "off" else None),
                })
            if path == "/__sample.hwpx":
                if not (cfg["sample"] and self._local()):
                    return self._send(404, b"not found", "text/plain")
                with open(cfg["sample"], "rb") as f:
                    return self._send(200, f.read(), "application/hwp+zip")
            return super().do_GET()

        def do_POST(self):
            u = urlparse(self.path)
            if u.path == "/api/draft":
                return self._api(MAX_BODY, lambda b: ai_writer.draft(b.get("form"), b.get("memo"), cfg["mode"]))
            if u.path == "/api/chat":
                return self._api(MAX_BODY, lambda b: ai_writer.chat(b.get("form"), b.get("memo"), b.get("messages"), cfg["mode"]))
            if u.path == "/api/plan":
                return self._api(MAX_PLAN_BODY, lambda b: ai_writer.read_plan(b.get("files"), b.get("text"), cfg["mode"]))
            if u.path == "/__save" and cfg["sample"] and self._local():
                name = os.path.basename(parse_qs(u.query).get("name", ["result.hwpx"])[0])
                if not name.endswith(".hwpx"):
                    name += ".hwpx"
                n = int(self.headers.get("Content-Length", "0"))
                os.makedirs(OUT, exist_ok=True)
                with open(os.path.join(OUT, name), "wb") as f:
                    f.write(self.rfile.read(n))
                return self._send(200, b"saved", "text/plain")
            return self._send(404, b"not found", "text/plain")

        def _api(self, max_body, run):
            if not self._code_ok():
                return self._json(403, {"error": "연결 번호가 맞지 않아요. 일지 도우미를 켠 컴퓨터 화면의 6자리 숫자를 넣어 주세요."})
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                n = -1
            if n <= 0 or n > max_body:
                return self._json(413, {"error": "내용이 너무 커요. 파일 수를 줄이거나 메모를 조금 줄여 주세요."})
            try:
                body = json.loads(self.rfile.read(n).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return self._json(400, {"error": "채우지 못했어요. 새로고침한 뒤 다시 눌러 주세요."})
            if not limiter.allow():
                return self._json(429, {"error": "조금 쉬었다가 1분 뒤에 다시 눌러 주세요."})
            who = self.client_address[0]
            if not trial.take(who):
                return self._json(429, {"error": f"오늘 무료체험 {cfg['trial']}번을 다 썼어요. 내 API 키를 넣으면 계속 쓸 수 있어요.",
                                        "code": "trial_used_up", "trial": {"limit": cfg["trial"], "remaining": 0}})
            if not limiter.slots.acquire(blocking=False):
                trial.give_back(who)
                return self._json(429, {"error": "다른 일지를 채우는 중이에요. 잠시 뒤 다시 눌러 주세요."})
            ok = False
            try:
                result = run(body)
                ok = True
                if cfg["trial"]:
                    result["trial"] = {"limit": cfg["trial"], "remaining": trial.remaining(who)}
                return self._json(200, result)
            except ai_writer.AIError as e:
                return self._json(e.status, {"error": str(e)})
            except Exception as e:  # 예상하지 못한 오류: 내용은 서버 화면에만 남긴다
                sys.stderr.write("자동 채우기 오류: %s\n" % type(e).__name__)
                return self._json(500, {"error": "채우지 못했어요. 잠시 뒤 다시 눌러 주세요."})
            finally:
                if not ok:
                    trial.give_back(who)  # 실패한 요청은 횟수에서 빼지 않는다
                limiter.slots.release()

    return Handler


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except OSError:
        ip = ""
    finally:
        s.close()
    if not ip or ip.startswith("127."):
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except OSError:
            ip = ""
    return "" if ip.startswith("127.") else ip


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None, help="포트 번호 (기본 8765, 쓰이고 있으면 다음 빈 번호)")
    ap.add_argument("--lan", action="store_true", help="같은 네트워크의 다른 기기에서 접속 허용")
    ap.add_argument("--mock-ai", action="store_true", help="API 키 없이 연습 모드(예시 응답)로 켜기")
    ap.add_argument("--dev", metavar="SAMPLE", help="개발용 샘플 hwpx 경로")
    ap.add_argument("--trial", type=int, default=0, metavar="N",
                    help="무료체험: 접속한 곳마다 하루 N번까지 서버 키로 쓰게 함 (0이면 제한 없음)")
    a = ap.parse_args()

    load_env(os.path.join(BASE, ".env"))
    sys.path.insert(0, BASE)
    mode, reason = ai_mode(a.mock_ai)
    cfg = {"mode": mode, "reason": reason, "sample": a.dev, "trial": max(0, a.trial),
           "code": f"{secrets.randbelow(10**6):06d}" if a.lan else ""}

    host = "0.0.0.0" if a.lan else "127.0.0.1"
    handler = make_handler(cfg)
    ports = [a.port] if a.port else list(range(8765, 8800))
    srv = None
    for port in ports:
        try:
            srv = Server((host, port), handler)
            break
        except OSError:
            continue
    if srv is None:
        print(f"포트 {ports[0]}을(를) 다른 프로그램이 쓰고 있습니다. --port 8800 처럼 다른 번호로 켜 주세요.")
        sys.exit(1)
    if port != ports[0] or not a.port and port != 8765:
        print(f"8765 포트는 다른 프로그램(예전에 켠 서버일 수 있음)이 쓰고 있어서 {port} 포트로 켰습니다.")
    a.port = port
    print(f"HWPX 일지 편집기: http://127.0.0.1:{a.port}")
    print({"api": "자동 채우기: 켜짐 (Claude API)", "mock": "자동 채우기: 연습 모드", "off": "자동 채우기: 꺼짐 - " + reason}[mode])
    if cfg["trial"] and mode != "off":
        print(f"무료체험: 접속한 곳마다 하루 {cfg['trial']}번 (그 뒤에는 각자 API 키를 넣어 사용)")
    if a.lan:
        ip = lan_ip()
        if ip:
            print(f"다른 PC에서 접속: http://{ip}:{a.port}")
        else:
            print(f"다른 PC에서 접속: http://(이 맥의 IP 주소):{a.port}  - IP는 시스템 설정 > Wi-Fi > 세부사항에서 확인")
        print(f"다른 PC에서 자동 채우기를 쓸 때 넣을 연결 번호: {cfg['code']}")
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
