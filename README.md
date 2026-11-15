# HWPX 일지 편집기

유치원 일지 hwpx 양식을 브라우저에서 열어 칸을 고치고, 월안과 요일별 활동으로 이번 일지를 자동으로 채운 뒤, 같은 양식의 hwpx로 저장합니다.
월안(교육계획안)은 PDF, 사진, 한글(.hwpx)로 올리면 주별 주제·목표·교구·요일별 활동으로 정리되고, 선생님은 요일마다 활동만 적으면 놀이지원과 평가가 채워집니다.
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

## 자동으로 채우기: 무료체험과 내 API 키

- **내 API 키:** 화면의 '내 API 키로 쓰기'에 키를 넣으면 그 브라우저에만 저장되고, 브라우저가 Claude(api.anthropic.com)를 바로 부릅니다(`web/direct.js`, 공식 SDK `@anthropic-ai/sdk@1.3.0`). 서버가 없는 GitHub Pages에서도 동작하고 횟수 제한이 없습니다(비용은 키 주인 부담).
- **무료체험:** 서버를 `--trial N`으로 켜면 접속한 곳(IP)마다 하루 N번까지 서버의 키로 쓸 수 있습니다. 다 쓰면 화면이 '내 API 키로 쓰기'를 안내합니다.
  ```bash
  .venv/bin/python serve.py --lan --trial 5
  ```
- 지시문과 응답 형식은 `web/prompts.json` 한 곳에 있고, 서버와 브라우저가 같은 파일을 씁니다.
- 아이 이름은 어느 쪽으로 보내든 브라우저에서 가명으로 바뀐 뒤 나갑니다.

## 예전 한글 파일(.hwp)

일지와 월안 모두 .hwp 파일을 그대로 열 수 있습니다. 브라우저 안에서 HWPX로 바꾼 뒤 열고, 파일은 어디로도 보내지 않습니다(`web/hwp-convert.js`, `web/hwp-worker.js`).
변환 엔진은 [rhwp](https://github.com/edwardkim/rhwp) 0.8.7(MIT License, © Edward Kim)이며 jsDelivr의 `@rhwp/core@0.8.7`에서 불러옵니다. Essay(essay.win/hwpx)와 같은 판입니다.
암호가 걸린 파일은 암호를 물어 연 뒤 암호를 푼 HWPX로 바꾸고, 배포용(읽기 전용) 문서는 바꾸지 않습니다.

## 메모장과 부탁하기

- 왼쪽 메모장: 우리 반 아이 이름(누르면 지금 쓰는 칸에 들어감, 이번 주 평가 아이는 요일 표시)과 나만 보는 메모. 이 브라우저에만 저장되고 메모는 어디로도 보내지 않습니다.
- 오른쪽 '부탁하기': 일지를 보면서 "수요일 평가 더 자세히 써 줘"처럼 말로 부탁하면 그 칸만 고칩니다. 대화마다 되돌리기가 있고, 지시문은 `web/prompts.json`의 `chat`입니다(`/api/chat`, 내 API 키, 무료체험 경로 공통).

## 평가 아이

'우리 반 아이 이름'에 이름 목록을 붙여 넣으면, 요일마다 평가에 나올 아이를 한 주 안에서 겹치지 않게 정합니다. 지난주까지 덜 나온 아이부터 고르고, 눌러서 다른 아이나 '반 전체'로 바꿀 수 있습니다(배정 기록은 그 브라우저에만 저장).

## GitHub Pages

`main`에 올리면 `.github/workflows/pages.yml`이 `web/` 화면을 GitHub Pages로 배포합니다.
Pages에는 서버가 없어서 무료체험은 없고, 각자 '내 API 키로 쓰기'에 키를 넣으면 월안 읽기와 자동으로 채우기까지 쓸 수 있습니다.

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
| `web/direct.js` | 내 API 키로 브라우저에서 Claude 바로 호출 |
| `web/hwp-convert.js`, `web/hwp-worker.js` | 예전 한글 파일(.hwp)을 브라우저 안에서 HWPX로 변환 |
| `web/prompts.json` | 지시문·응답 형식(서버·브라우저 공용) |
| `serve.py` | 로컬 서버, `.env` 읽기, 요청 제한·무료체험 횟수·연결 번호 |
| `ai_writer.py` | Claude API 호출: 월안 정리, 일지 채우기, 부탁하기, 응답 형식 검증 |

## 테스트

```bash
node test/engine-test.cjs <압축을 푼 hwpx 폴더>
node test/name-mask-test.cjs
```
