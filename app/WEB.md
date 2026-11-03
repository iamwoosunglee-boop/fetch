# 웹 빌드

웹 빌드는 데스크톱 앱과 같은 기능을 브라우저에서 제공합니다. 폴더 가져오기, 분석, 즐겨찾기, 모음, 검색, 챗봇 찾기(릴레이 경유)가 됩니다. DAW로 끌어다 놓는 대신 원본 파일을 내려받습니다. 데모 소리와 미리 계산한 좌표는 넣지 않습니다.

## 실행

`app`에서 실행합니다.

```sh
npm run build:web
RELAY_URL=http://127.0.0.1:<릴레이 포트> npm run serve:web
```

주소는 `http://127.0.0.1:4173`이고 `PORT`로 바꿉니다. 정적 서버는 COOP `same-origin`과 COEP `require-corp`를 보내고, 같은 출처의 `POST /plan`을 `RELAY_URL`(루프백 HTTP만 허용)에 전달합니다. 명령줄에서 `RELAY_URL`이 없으면 `http://127.0.0.1:8787`을 씁니다. `createWebServer()`를 코드에서 부를 때는 릴레이 기본값이 없어 `/plan`이 502를 돌려주므로, 시험은 자기가 띄운 릴레이 주소를 넘깁니다.

## 구조

`src/platform/web.ts`가 `webPlatform`(`kind: 'web'`)을 내보냅니다. 구현은 `src/platform/web/`에 있습니다.

- `library.ts`: 폴더 연결. `showDirectoryPicker`, 끌어 놓은 폴더(`getAsFileSystemHandle`, drop 이벤트 안에서 바로 호출), IndexedDB에 저장한 폴더 핸들, 다시 열 때 `queryPermission`(허용이 필요하면 `needsPermission`), `reauthorize`의 `requestPermission`. 훑기는 WAV, MP3, OGG, FLAC를 찾고 `src/main/scan.ts`와 같은 지문(크기, 앞뒤 64KiB SHA-256, 전체 SHA-256)을 씁니다. 경로, 크기, 수정 시각이 같으면 파일을 읽지 않고, 전체 해시가 같은 분석이 있으면 다시 분석하지 않습니다. 100MB가 넘는 파일은 분석하지 않고 `skipped`로 셉니다.
- `analysis.ts`: 파일 하나씩 전체를 디코드해 길이와 48개 파형 값을 만들고 `src/model`의 `embedAudio`로 좌표를 만듭니다. 파일 사이마다 페이지에 차례를 넘깁니다.
- `search.ts`: IndexedDB의 소리 목록, `/plan`(릴레이가 `result_count`를 주면 `count`로 전달), 글 좌표, 외부 기준 소리, Web Audio 재생, 모델 받기 진행, 원본 내려받기, 끌어 놓은 파일을 라이브러리 소리로 찾기(이름과 크기로 후보를 좁히고 전체 해시로 확정).
- `db.ts`: IndexedDB 저장소 `fetch-app`(folders, sounds, settings). 모음과 즐겨찾기는 settings에 있고 폴더를 빼도 남습니다.
- `support.ts`: `supportedWebEnvironment`(데스크톱 Chrome과 Edge, 너비 800픽셀 이상).

## 시험

```sh
npx vitest run src/platform/web
npm run build:web
nice -n 15 node scripts/web-qa.mjs
```

`web-qa.mjs`는 빌드하지 않습니다. `dist/web`(또는 `WEB_ROOT`)을 임시 포트로 띄우고, 고정 계획을 돌려주는 가짜 릴레이를 다른 임시 포트에 띄웁니다. 임시 프로필의 헤드리스 Chromium(`CHROMIUM_PATH`, 기본은 `../_experiments/e4_browser/browsers/chromium-1194`)에서 `?proto1-test-opfs=1`로 열고, `web-demo/sounds`의 WAV 12개를 OPFS에 쓴 뒤 `window.__proto1TestConnectOpfs`로 연결합니다. 분석 완료, 소리 줄의 파형과 좌표, 다시 열었을 때 폴더와 소리와 즐겨찾기 유지, 내려받은 파일의 SHA-256을 확인합니다. 모델은 받지 않습니다. 대역 워커가 좌표를 돌려주고 외부 주소는 막습니다. 기록은 `../../.omo/evidence/v3-lane-d/`에 남깁니다.

`proto1-test-opfs=1`이 주소에 있을 때만 `window.__proto1Platform`과 `window.__proto1TestConnectOpfs`가 생깁니다. 보통 화면에는 나타나지 않습니다.

공개 주소 배포와 PRD 7.7의 다른 회선 확인은 이 문서의 범위가 아닙니다.
