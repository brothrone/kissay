"""자동 채우기: 월안(교육계획안)을 주별로 정리하고, 양식 칸 구조와 교사 메모로 새로 써야 할 칸의 내용을 돌려준다.

- API 키는 환경 변수(ANTHROPIC_API_KEY)에서만 읽는다. 코드와 응답 어디에도 키를 넣지 않는다.
- 아이 이름은 브라우저에서 가명으로 바뀐 뒤 들어온다. 이 모듈은 실명을 보지 않는다.
- mode="mock"이면 Claude를 부르지 않고 규칙으로 만든 가짜 응답을 돌려준다(키 없이 흐름 시험용).
"""
from __future__ import annotations

import json
import os
import re

DEFAULT_MODEL = "claude-opus-5-5"  # web/prompts.json의 model과 같게 둔다
# 서버 쪽 거절 대비(fallbacks)를 지원하는 모델. 그 밖의 모델에는 보내지 않는다.
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}

MAX_MEMO_CHARS = 12000
MAX_PLAN_FILES = 40
PLAN_MEDIA = {"application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_CELLS = 400

# 지시문과 응답 형식은 web/prompts.json 한 곳에 둔다(브라우저도 같은 파일을 쓴다).
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "prompts.json"), encoding="utf-8") as _f:
    PROMPTS = json.load(_f)
SYSTEM_PROMPT = PROMPTS["draft"]["system"]
OUTPUT_SCHEMA = PROMPTS["draft"]["schema"]
PLAN_SYSTEM_PROMPT = PROMPTS["plan"]["system"]
PLAN_SCHEMA = PROMPTS["plan"]["schema"]
CHAT_SYSTEM_PROMPT = PROMPTS["chat"]["system"]
CHAT_SCHEMA = PROMPTS["chat"]["schema"]
MAX_CHAT_TURNS = 12
MAX_CHAT_CHARS = 2000


class AIError(Exception):
    """교사에게 그대로 보여 줄 수 있는 오류. status는 HTTP 상태 코드."""

    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


def _validate_request(form: object, memo: object) -> tuple[list[dict], str]:
    if not isinstance(memo, str) or not memo.strip():
        raise AIError("이번 주 메모를 적어 주세요.", 400)
    if len(memo) > MAX_MEMO_CHARS:
        raise AIError(f"메모가 너무 길어요. {MAX_MEMO_CHARS}자 안으로 줄여 주세요.", 400)
    if not isinstance(form, dict) or not isinstance(form.get("cells"), list):
        raise AIError("일지 파일을 다시 열어 주세요.", 400)
    cells = form["cells"]
    if not cells or len(cells) > MAX_CELLS:
        raise AIError("일지 파일을 다시 열어 주세요.", 400)
    clean = []
    for c in cells:
        if not isinstance(c, dict) or not isinstance(c.get("id"), str) or not isinstance(c.get("lines"), list):
            raise AIError("일지 파일을 다시 열어 주세요.", 400)
        clean.append({
            "id": c["id"][:40],
            "row": int(c.get("row", 0)), "col": int(c.get("col", 0)),
            "rowSpan": int(c.get("rowSpan", 1)), "colSpan": int(c.get("colSpan", 1)),
            "editable": bool(c.get("editable", True)),
            "lines": [str(x)[:2000] for x in c["lines"]][:60],
        })
    return clean, memo.strip()


def _user_message(cells: list[dict], memo: str) -> str:
    form_json = json.dumps({"cells": cells}, ensure_ascii=False)
    return f"<form>\n{form_json}\n</form>\n\n<memo>\n{memo}\n</memo>"


def _clean_result(data: object, cells: list[dict]) -> dict:
    allowed = {c["id"] for c in cells if c["editable"]}
    if not isinstance(data, dict):
        raise AIError("채우지 못했어요. 한 번 더 눌러 주세요.", 502)
    out_cells, seen = [], set()
    for item in data.get("cells", []):
        if not isinstance(item, dict):
            continue
        cid, lines = item.get("id"), item.get("lines")
        if cid not in allowed or cid in seen or not isinstance(lines, list):
            continue
        seen.add(cid)
        flat: list[str] = []
        for line in lines:
            flat.extend(str(line).replace("\r", "").split("\n"))
        out_cells.append({"id": cid, "lines": flat or [""]})
    notes = [str(n) for n in data.get("notes", []) if str(n).strip()][:20]
    return {"cells": out_cells, "notes": notes}


def _ask_claude(system: str, content, schema: dict, max_tokens: int = 16000, history: list | None = None) -> tuple[dict, dict]:
    """Claude에 한 번 물어 JSON(스키마 고정)을 받는다. 교사에게 보여 줄 수 있는 AIError로만 실패한다."""
    try:
        import anthropic
    except ImportError as e:  # 서버를 .venv의 파이썬으로 켜지 않은 경우
        raise AIError("자동으로 채우기 준비가 아직 안 됐어요. 일지 도우미를 설치한 분께 알려 주세요.", 503) from e

    model = os.environ.get("KISSAY_MODEL", DEFAULT_MODEL)
    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY 환경 변수에서 키를 읽는다
    params = dict(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=(history or []) + [{"role": "user", "content": content}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
    )
    if os.environ.get("KISSAY_THINKING") == "off":  # 선택: 생각 끄기(무료체험과 같은 조건 시험용)
        params["thinking"] = {"type": "disabled"}
    if model in FALLBACK_MODELS:
        params["betas"] = ["server-side-fallback-2026-07-01"]
        params["fallbacks"] = "default"
    try:
        # 입력(월안 PDF 등)과 출력이 길 수 있어 스트리밍으로 받고, 끝난 뒤 완성된 응답만 쓴다.
        with client.beta.messages.stream(**params) as stream:
            response = stream.get_final_message()
    except anthropic.AuthenticationError as e:
        raise AIError("자동으로 채우기 설정에 문제가 있어요. 일지 도우미를 설치한 분께 알려 주세요.", 502) from e
    except anthropic.PermissionDeniedError as e:
        raise AIError("자동으로 채우기 설정에 문제가 있어요. 일지 도우미를 설치한 분께 알려 주세요.", 502) from e
    except anthropic.RateLimitError as e:
        raise AIError("지금 사용하는 분이 많아요. 1분 뒤에 다시 눌러 주세요.", 429) from e
    except anthropic.BadRequestError as e:
        raise AIError("채우지 못했어요. 메모를 조금 바꿔서 다시 눌러 주세요.", 502) from e
    except anthropic.APIStatusError as e:
        raise AIError("잠깐 연결이 고르지 않아요. 잠시 뒤 다시 눌러 주세요.", 502) from e
    except anthropic.APIConnectionError as e:
        raise AIError("인터넷 연결을 확인한 뒤 다시 눌러 주세요.", 502) from e

    if response.stop_reason == "refusal":
        raise AIError("이 메모로는 채우지 못했어요. 메모를 조금 바꿔서 다시 눌러 주세요.", 422)
    if response.stop_reason == "max_tokens":
        raise AIError("내용이 너무 길어서 다 채우지 못했어요. 메모를 조금 줄여서 다시 눌러 주세요.", 502)
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise AIError("채우지 못했어요. 한 번 더 눌러 주세요.", 502) from e
    usage = response.usage
    meta = {
        "model": response.model,
        "input_tokens": getattr(usage, "input_tokens", None),
        "output_tokens": getattr(usage, "output_tokens", None),
    }
    return data, meta


def _call_claude(cells: list[dict], memo: str) -> dict:
    data, meta = _ask_claude(SYSTEM_PROMPT, _user_message(cells, memo), OUTPUT_SCHEMA)
    result = _clean_result(data, cells)
    result["meta"] = meta
    return result


WEEKDAYS = "월화수목금토일"


def _mock(cells: list[dict], memo: str) -> dict:
    """키 없이 흐름을 시험하기 위한 가짜 응답. 메모의 요일 줄을 같은 요일 행의 관찰 칸에 넣는다."""
    by_day: dict[str, str] = {}
    first_line = memo.splitlines()[0].strip() if memo.strip() else ""
    for line in memo.splitlines():
        m = re.match(r"\s*([월화수목금토일])\s*[:：)\-]\s*(.+)", line)
        if m:
            by_day[m.group(1)] = m.group(2).strip()
    row_day: dict[int, str] = {}
    for c in cells:
        if c["col"] == 0 and c["lines"] and c["lines"][0].strip()[:1] in WEEKDAYS:
            row_day[c["row"]] = c["lines"][0].strip()[:1]
    out = []
    for c in cells:
        if not c["editable"]:
            continue
        text = " ".join(c["lines"])
        if re.search(r"\d+\s*월\s*\d+\s*주", text) and len(text) < 60:
            out.append({"id": c["id"], "lines": [first_line or "[입력 필요: 시기]"]})
        elif c["row"] in row_day and len(text) >= 60:
            fact = by_day.get(row_day[c["row"]])
            out.append({"id": c["id"], "lines": [f"[연습] {fact}" if fact else "[입력 필요: 관찰 내용]"]})
    return {"cells": out, "notes": ["연습 모드라서 예시 문장만 넣었어요."],
            "meta": {"model": "mock", "input_tokens": 0, "output_tokens": 0}}


def draft(form: object, memo: object, mode: str) -> dict:
    cells, memo_s = _validate_request(form, memo)
    if mode == "mock":
        return _clean_result(_mock(cells, memo_s), cells) | {"meta": {"model": "mock"}}
    if mode != "api":
        raise AIError("자동으로 채우기 준비가 아직 안 됐어요. 일지 도우미를 설치한 분께 알려 주세요.", 503)
    return _call_claude(cells, memo_s)


# ---------- 월안(교육계획안) 정리 ----------

def _clean_plan(data: object) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get("weeks"), list):
        raise AIError("월안을 읽지 못했어요. 다른 파일로 다시 올려 주세요.", 502)
    weeks = [w for w in data["weeks"] if isinstance(w, dict) and str(w.get("label", "")).strip()][:8]
    if not weeks:
        raise AIError("월안에서 주별 계획표를 찾지 못했어요. 교육계획안 쪽이 들어 있는지 확인해 주세요.", 422)
    notes = [str(n) for n in data.get("notes", []) if str(n).strip()][:10]
    return {"weeks": weeks, "notes": notes}


def _mock_plan() -> dict:
    days = [("월", "11.2"), ("화", "11.3"), ("수", "11.4"), ("목", "11.5"), ("금", "11.6")]
    week = {
        "label": "11월 1주", "start": "11.2", "end": "11.6",
        "theme": "생활도구", "subtheme": "편리한 생활 도구",
        "goals": ["생활 도구의 이름과 쓰임을 안다.", "생활 도구를 소중히 다룬다."],
        "free_play": ["뚜껑 열고 닫기", "나사 돌리기", "젓가락으로 옮기기"],
        "areas": [{"name": "언어놀이", "activity": "생활도구 이름 맞추기"}, {"name": "예술놀이", "activity": "재활용품으로 도구 만들기"}],
        "days": [{"day": d, "date": dt, "items": [{"category": "바깥놀이", "activity": a}]}
                 for (d, dt), a in zip(days, ["친구와 손잡고 뛰기", "모래놀이", "컵으로 옮기기", "보물 담기", "물 그림"])],
        "weekly": [{"category": "기본생활습관", "activity": "높임말을 사용해요"}],
    }
    return {"weeks": [week], "notes": ["연습 모드라서 예시 월안을 넣었어요."], "meta": {"model": "mock"}}


def read_plan(files: object, text: object, mode: str) -> dict:
    """월안 파일(PDF·사진) 또는 한글 파일에서 뽑은 글을 받아 주별 계획으로 정리한다."""
    blocks = []
    if isinstance(files, list):
        if len(files) > MAX_PLAN_FILES:
            raise AIError(f"파일은 한 번에 {MAX_PLAN_FILES}개까지 올릴 수 있어요.", 400)
        for f in files:
            if not isinstance(f, dict):
                continue
            media, data = f.get("mediaType"), f.get("data")
            if media not in PLAN_MEDIA or not isinstance(data, str) or not data:
                raise AIError("PDF, 사진(JPG·PNG), 한글(.hwpx) 파일만 올릴 수 있어요.", 400)
            if media == "application/pdf":
                blocks.append({"type": "document", "source": {"type": "base64", "media_type": media, "data": data}})
            else:
                blocks.append({"type": "image", "source": {"type": "base64", "media_type": media, "data": data}})
    if isinstance(text, str) and text.strip():
        blocks.append({"type": "text", "text": "<plan_text>\n" + text[:60000] + "\n</plan_text>"})
    if not blocks:
        raise AIError("월안 파일을 골라 주세요.", 400)
    if mode == "mock":
        return _mock_plan()
    if mode != "api":
        raise AIError("자동으로 채우기 준비가 아직 안 됐어요. 일지 도우미를 설치한 분께 알려 주세요.", 503)
    blocks.append({"type": "text", "text": PROMPTS["plan"]["instruction"]})
    data, meta = _ask_claude(PLAN_SYSTEM_PROMPT, blocks, PLAN_SCHEMA, max_tokens=PROMPTS["plan"]["max_tokens"])
    result = _clean_plan(data)
    result["meta"] = meta
    return result


# ---------- 부탁하기(대화) ----------

def _clean_history(messages: object) -> tuple[list[dict], str]:
    """앞선 대화(글만)와 이번 부탁을 나눈다. 대화는 user로 시작해 user/assistant가 번갈아야 한다."""
    if not isinstance(messages, list) or not messages:
        raise AIError("부탁할 내용을 적어 주세요.", 400)
    items = []
    for m in messages[-MAX_CHAT_TURNS:]:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        text = str(m.get("content", ""))[:MAX_CHAT_CHARS].strip()
        if text:
            items.append({"role": m["role"], "content": text})
    while items and items[0]["role"] != "user":
        items.pop(0)
    merged: list[dict] = []
    for m in items:  # 같은 역할이 이어지면 합친다
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] += "\n" + m["content"]
        else:
            merged.append(dict(m))
    if not merged or merged[-1]["role"] != "user":
        raise AIError("부탁할 내용을 적어 주세요.", 400)
    request = merged.pop()["content"]
    return merged, request


def _mock_chat(cells: list[dict], request: str) -> dict:
    target = next((c for c in cells if c["editable"] and len(" ".join(c["lines"])) >= 60), None)
    if target and ("평가" in request or "자세히" in request or "줄여" in request):
        return {"reply": "연습 모드라서 첫 평가 칸에 예시 문장만 넣었어요.",
                "cells": [{"id": target["id"], "lines": ["[연습] " + request[:40]]}]}
    return {"reply": "연습 모드라서 실제로 고치지는 않았어요. 부탁: " + request[:40], "cells": []}


def chat(form: object, memo: object, messages: object, mode: str) -> dict:
    memo_s = memo if isinstance(memo, str) else ""
    cells, _ = _validate_request(form, memo_s or "-")
    history, request = _clean_history(messages)
    if len(memo_s) > MAX_MEMO_CHARS:
        memo_s = memo_s[:MAX_MEMO_CHARS]
    if mode == "mock":
        data = _mock_chat(cells, request)
        meta = {"model": "mock"}
    elif mode == "api":
        content = _user_message(cells, memo_s or "(없음)") + "\n\n<request>\n" + request + "\n</request>"
        data, meta = _ask_claude(CHAT_SYSTEM_PROMPT, content, CHAT_SCHEMA, PROMPTS["chat"]["max_tokens"], history)
    else:
        raise AIError("자동으로 채우기 준비가 아직 안 됐어요. 일지 도우미를 설치한 분께 알려 주세요.", 503)
    result = _clean_result(data, cells)
    reply = str((data or {}).get("reply", "")).strip() if isinstance(data, dict) else ""
    return {"reply": reply or ("고쳤어요." if result["cells"] else "어떤 칸을 고칠지 한 번 더 알려 주세요."),
            "cells": result["cells"], "meta": meta}
