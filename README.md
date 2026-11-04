# HWPX 일지 편집기

유치원 일지 hwpx 양식을 브라우저에서 열어 칸을 고치고, 메모로 이번 일지를 자동으로 채운 뒤, 같은 양식의 hwpx로 저장합니다.
표와 서식은 원본 그대로 두고, 바뀐 칸의 문단만 다시 씁니다.

## 처음 한 번 설정

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

`.env` 파일을 열어 `ANTHROPIC_API_KEY=` 뒤에 API 키를 붙여 넣습니다.

## 실행

```bash
.venv/bin/python serve.py
```

브라우저에서 http://127.0.0.1:8765 를 엽니다. 같은 와이파이의 윈도우 PC에서 쓰려면 `--lan`을 붙입니다.
이때 서버 화면에 나오는 6자리 연결 번호를 다른 PC의 '이번 주 메모' 카드에 넣어야 자동으로 채우기를 쓸 수 있습니다.

키 없이 화면 흐름만 시험하려면 `--mock-ai`를 붙입니다(연습 모드). 자동 작성 서비스를 부르지 않고 예시 문장이 들어갑니다.

## GitHub Pages

`main`에 올리면 `.github/workflows/pages.yml`이 `web/` 화면을 GitHub Pages로 배포합니다.
Pages에는 서버가 없어서 파일 열기, 칸 고치기, 한글 파일 저장만 됩니다. 자동으로 채우기는 API 키를 둔 로컬 서버에서만 동작합니다.

## API 키와 개인정보

- API 키는 `.env`에만 둡니다. 서버 안에서만 쓰이고 브라우저로 보내지 않습니다.
- `.env`, hwp/hwpx 파일, `test_output/`은 `.gitignore`로 git에서 제외됩니다.
- `.githooks/pre-commit`이 `sk-ant-`로 시작하는 키나 `.env`, 일지 파일이 커밋에 섞이면 커밋을 막습니다.
  새로 clone한 곳에서는 `git config core.hooksPath .githooks`를 한 번 실행해야 이 검사가 켜집니다.
- 아이 이름은 브라우저에서 가명으로 바뀐 뒤 서버와 AI로 갑니다. 결과가 오면 브라우저에서 다시 실명으로 돌아옵니다.
- 서버 기록에는 요청 경로와 상태만 남고, 일지 내용과 키는 남지 않습니다.

## 파일

| 파일 | 역할 |
|---|---|
| `web/hwpx-engine.js` | hwpx 읽기, 표 모델 만들기, 바뀐 문단만 교체해 저장 |
| `web/app.js` | 화면 그리기, 칸 편집, 저장, 자동으로 채우기 |
| `web/name-mask.js` | 아이 이름 가명 처리 |
| `serve.py` | 로컬 서버, `.env` 읽기, AI 요청 제한과 접속 코드 |
| `ai_writer.py` | Claude API 호출, 지시문, 응답 형식 검증 |

## 테스트

```bash
node test/engine-test.cjs <압축을 푼 hwpx 폴더>
node test/name-mask-test.cjs
```
