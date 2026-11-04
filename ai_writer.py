"""AI 일지 작성: 양식 칸 구조와 교사 메모를 받아, 새로 써야 할 칸의 내용을 돌려준다.

- API 키는 환경 변수(ANTHROPIC_API_KEY)에서만 읽는다. 코드와 응답 어디에도 키를 넣지 않는다.
- 아이 이름은 브라우저에서 가명으로 바뀐 뒤 들어온다. 이 모듈은 실명을 보지 않는다.
- mode="mock"이면 Claude를 부르지 않고 규칙으로 만든 가짜 응답을 돌려준다(키 없이 흐름 시험용).
"""
from __future__ import annotations

import json
import os
import re

DEFAULT_MODEL = "claude-opus-5-5"
# 서버 쪽 거절 대비(fallbacks)를 지원하는 모델. 그 밖의 모델에는 보내지 않는다.
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}

MAX_MEMO_CHARS = 8000
MAX_CELLS = 400

SYSTEM_PROMPT = """당신은 한국 유치원 교사가 일지(놀이 계획과 관찰 기록)를 쓰는 일을 돕습니다.

입력은 두 가지입니다.
1. form: 이 유치원의 일지 양식입니다. hwpx 표의 칸 목록이고, 각 칸에는 지난번 일지 내용이 들어 있습니다. 이 내용은 이 유치원이 쓰는 문체, 분량, 줄 구성을 보여 주는 예시입니다.
2. memo: 교사가 이번 일지를 위해 적은 메모입니다.

할 일은 memo를 바탕으로 이번 일지의 칸 내용을 새로 쓰는 것입니다. 내용이 바뀌어야 하는 칸만 돌려주세요.

원칙
- 항목 이름 칸(시기, 주 제, 요일, 놀이 활동 같은 머리글)은 그대로 둡니다. 돌려주지 않습니다.
- 메모에 바뀐다는 말이 없고 매번 같은 내용이 들어가는 칸(하루 일과 시간표, 일과 안내 등)은 그대로 둡니다.
- 일지는 교사가 남기는 공식 기록입니다. 관찰 기록은 memo에 적힌 사실로만 씁니다. 메모에 없는 아이의 행동, 말, 감정을 지어내지 않습니다. 메모가 짧으면 그 사실을 이 양식의 문체로 다듬고, 교육적 의미는 그 사실에서 자연스럽게 이어지는 만큼만 덧붙입니다.
- 이번 일지에 새로 들어가야 하는데 memo에 정보가 없는 칸은 지난 내용을 남기지 말고 "[입력 필요: 필요한 내용]" 한 줄로 채운 뒤 notes에 적습니다.
- 지난 내용의 문체를 따릅니다. 문장 끝맺음(예: "~함.", "~보임."), 글머리 기호(ㆍ, -), 칸의 줄 수와 분량(지난 글자 수의 0.7~1.3배 정도)을 맞춥니다.
- lines의 한 항목은 한 문단(한 줄)이 됩니다. 항목 안에 줄바꿈 문자를 넣지 않습니다.
- 수업일수처럼 이어지는 숫자는 지난 값에서 이어서 셉니다. 메모에 휴일이나 다른 값이 있으면 메모를 따릅니다.
- 아이 이름은 가명으로 바뀌어 있습니다. 가명을 글자 그대로 쓰고, 조사는 그 이름의 받침에 맞게 붙입니다.
- 칸 id는 form에 있고 editable이 true인 것만 씁니다.

notes에는 교사가 확인해야 할 점(메모에 없어 비워 둔 칸, 추정한 부분 등)을 적습니다. 선생님께 드리는 짧은 해요체 문장으로 쓰고, 자신을 AI나 모델이라고 부르지 않습니다. 없으면 빈 배열로 둡니다."""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "cells": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "lines": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["id", "lines"],
                "additionalProperties": False,
            },
        },
        "notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["cells", "notes"],
    "additionalProperties": False,
}


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


def _call_claude(cells: list[dict], memo: str) -> dict:
    try:
        import anthropic
    except ImportError as e:  # 서버를 .venv의 파이썬으로 켜지 않은 경우
        raise AIError("자동으로 채우기 준비가 아직 안 됐어요. 일지 도우미를 설치한 분께 알려 주세요.", 503) from e

    model = os.environ.get("KISSAY_MODEL", DEFAULT_MODEL)
    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY 환경 변수에서 키를 읽는다
    params = dict(
        model=model,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": _user_message(cells, memo)}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    )
    if model in FALLBACK_MODELS:
        params["betas"] = ["server-side-fallback-2026-07-01"]
        params["fallbacks"] = "default"
    try:
        response = client.beta.messages.create(**params)
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
    result = _clean_result(data, cells)
    usage = response.usage
    result["meta"] = {
        "model": response.model,
        "input_tokens": getattr(usage, "input_tokens", None),
        "output_tokens": getattr(usage, "output_tokens", None),
    }
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
