"""자동 채우기: 월안(교육계획안)을 주별로 정리하고, 양식 칸 구조와 교사 메모로 새로 써야 할 칸의 내용을 돌려준다.

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

MAX_MEMO_CHARS = 12000
MAX_PLAN_FILES = 40
PLAN_MEDIA = {"application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_CELLS = 400

SYSTEM_PROMPT = """당신은 한국 유치원 교사가 일지(놀이 계획과 관찰 기록)를 쓰는 일을 돕습니다.

입력은 두 가지입니다.
1. form: 이 유치원의 일지 양식입니다. hwpx 표의 칸 목록이고, 각 칸에는 지난번 일지 내용이 들어 있습니다. 이 내용은 이 유치원이 쓰는 문체, 분량, 줄 구성을 보여 주는 예시입니다.
2. memo: 교사가 이번 일지를 위해 준 정보입니다. 다음 부분이 있을 수 있습니다.
   - [이번 주 월안]: 유치원 교육계획안에서 이번 주 부분입니다(시기, 놀이주제, 기대되는 우리, 교구, 영역별 놀이, 요일별 바깥놀이·안전교육·행사 등).
   - [요일별 활동]: 교사가 그날 하기로 정한 활동과, 적었다면 아이 모습입니다.
   - [더 적을 말]: 그 밖의 메모입니다.

할 일은 이 정보로 이번 일지의 칸 내용을 새로 쓰는 것입니다. 내용이 바뀌어야 하는 칸만 돌려주세요.

원칙
- 항목 이름 칸(시기, 주 제, 요일, 놀이 활동 같은 머리글)은 그대로 둡니다. 돌려주지 않습니다.
- 메모에 바뀐다는 말이 없고 매번 같은 내용이 들어가는 칸(하루 일과 시간표, 일과 안내 등)은 그대로 둡니다.
- 시기, 주제와 소주제, 이주의 목표(기대되는 우리 같은 칸)는 [이번 주 월안]의 글을 그대로 옮기되, 양식의 지난 내용과 같은 모양(글머리 기호, 괄호 속 날짜 표기 등)으로 맞춥니다.
- 요일별 놀이 활동 칸은 교사가 정한 그날 활동으로 씁니다. 양식의 지난 내용처럼 "자유놀이 – 영역(활동)", "수업 이름 : 내용" 같은 모양을 따릅니다. 교사가 그날 활동을 비워 두었으면 [이번 주 월안]에서 그날에 맞는 활동(교구, 그날 바깥놀이, 영역별 놀이)을 골라 쓰고 notes에 알립니다. 그날이 휴원이나 행사로 적혀 있으면 그대로 반영합니다.
- 놀이지원 칸은 그날 활동에 필요한 자료, 교구, 교사의 지원을 지난 내용과 비슷한 분량으로 씁니다.
- 평가·관찰 칸(놀이를 통해 알게되었어요 같은 칸)은 이렇게 씁니다.
  · 교사가 아이 모습을 적었으면 그 사실을 바탕으로 그 아이의 관찰 기록을 씁니다.
  · 적지 않았으면 그날 활동을 바탕으로 "유아들은 ~" 처럼 반 전체가 경험하고 배운 점을 씁니다.
  · 일지는 교사가 남기는 공식 기록입니다. memo에 없는 아이 이름을 만들지 않고, 특정 아이가 하지 않은 말이나 행동을 지어 붙이지 않습니다. 교육적 의미는 활동과 적힌 사실에서 자연스럽게 이어지는 만큼만 덧붙입니다.
- 이번 일지에 새로 들어가야 하는데 정보가 전혀 없는 칸은 지난 내용을 남기지 말고 "[입력 필요: 필요한 내용]" 한 줄로 채운 뒤 notes에 적습니다.
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


PLAN_SYSTEM_PROMPT = """당신은 한국 유치원의 월간·주간 교육계획안(월안) 문서를 읽고 주별 계획을 정리합니다.

- 교육계획안 표가 있는 쪽만 읽습니다. 동시, 새노래, 가정통신문 같은 다른 쪽은 무시합니다.
- 표에 적힌 글자를 그대로 옮깁니다. 지어내거나 요약하거나 고치지 않습니다. 글자가 흐려 확실하지 않으면 notes에 적습니다.
- "*", "-", 빈 칸은 그 항목이 없는 것으로 보고 넣지 않습니다.
- 한 주 전체에 공통인 칸(기본생활습관, 인성교육, 숲체험, 다문화 교육 등)은 weekly에, 요일마다 다른 칸(바깥놀이, 그날의 안전교육 등)은 그 요일의 days.items에 넣습니다.
- 행사 칸의 "5일: 가을소풍"처럼 날짜가 붙은 항목은 그 날짜 요일의 items에 category "행사"로 넣습니다.
- 놀이주제가 "큰 주제 / 작은 주제" 꼴이면 theme과 subtheme으로 나눕니다.
- 자유놀이 교구처럼 "/"로 나열된 활동은 하나씩 나눠 free_play에 넣습니다.
- 아름드리놀이처럼 영역별 놀이(언어놀이, 수·과학놀이, 신체놀이, 예술놀이 등)는 areas에 넣습니다.
- 날짜는 "11.2"처럼 월.일로, 요일은 "월"처럼 한 글자로 씁니다.
- 주는 문서에 나온 순서대로 씁니다.
- notes에는 선생님이 확인해야 할 점(흐리거나 가려져 확실하지 않은 글자 등)만 짧은 해요체 문장으로 적습니다. free_play 같은 항목 이름이나 정리한 방법 설명은 쓰지 않습니다."""

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "weeks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "start": {"type": "string"},
                    "end": {"type": "string"},
                    "theme": {"type": "string"},
                    "subtheme": {"type": "string"},
                    "goals": {"type": "array", "items": {"type": "string"}},
                    "free_play": {"type": "array", "items": {"type": "string"}},
                    "areas": {"type": "array", "items": {
                        "type": "object",
                        "properties": {"name": {"type": "string"}, "activity": {"type": "string"}},
                        "required": ["name", "activity"], "additionalProperties": False}},
                    "days": {"type": "array", "items": {
                        "type": "object",
                        "properties": {
                            "day": {"type": "string"}, "date": {"type": "string"},
                            "items": {"type": "array", "items": {
                                "type": "object",
                                "properties": {"category": {"type": "string"}, "activity": {"type": "string"}},
                                "required": ["category", "activity"], "additionalProperties": False}},
                        },
                        "required": ["day", "date", "items"], "additionalProperties": False}},
                    "weekly": {"type": "array", "items": {
                        "type": "object",
                        "properties": {"category": {"type": "string"}, "activity": {"type": "string"}},
                        "required": ["category", "activity"], "additionalProperties": False}},
                },
                "required": ["label", "start", "end", "theme", "subtheme", "goals", "free_play", "areas", "days", "weekly"],
                "additionalProperties": False,
            },
        },
        "notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["weeks", "notes"],
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


def _ask_claude(system: str, content, schema: dict, max_tokens: int = 16000) -> tuple[dict, dict]:
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
        messages=[{"role": "user", "content": content}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
    )
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
    blocks.append({"type": "text", "text": "이 월안에서 주별 교육계획을 정리해 주세요."})
    data, meta = _ask_claude(PLAN_SYSTEM_PROMPT, blocks, PLAN_SCHEMA, max_tokens=32000)
    result = _clean_plan(data)
    result["meta"] = meta
    return result
