# 하이쿠 중계

`app`에서 빌드하고 실행합니다. 런타임 의존성은 Node 표준 모듈뿐입니다.

```sh
npx tsc -p server
ANTHROPIC_API_KEY_FILE=~/.config/fetch/anthropic_api_key node server/dist/server/main.js
```

기본 주소는 `127.0.0.1:8787`입니다. `PORT`로 포트를 지정할 수 있습니다.
시작할 때 키 파일이 없거나 비어 있으면 `KEY_FILE_UNAVAILABLE`을 출력하고 종료 코드 1로 멈춥니다.
실행 중에 키 파일이 사라지면 요청에 `503 KEY_UNAVAILABLE`을 반환합니다.
키와 요청 본문은 로그에 남기지 않고, 일별 요청 횟수만 기록합니다.

## 계약

`POST /plan`에 아래 필드를 모두 보냅니다. 다른 필드는 거부합니다.
`src/core/plan.ts`의 `PlanRequest`, `SearchPlan`, `requestPlan`을 클라이언트와 공유합니다.

- `text`: 비어 있지 않은 요청
- `has_reference`: 기준 소리 유무
- `reference_duration_seconds`: 기준 길이 또는 `null`
- `previous_plan`: 직전 `SearchPlan` 또는 `null`

요청 JSON 전체가 공백과 필드 이름을 포함해 유니코드 코드 포인트 500개 이하여야 합니다.
응답은 `english_queries`, `name_keywords`, `min_duration_seconds`, `max_duration_seconds`, `explanation`과 `result_count`만 포함합니다.
`result_count`는 사용자가 개수를 말했을 때만 1에서 10 사이 정수로 들어가고, 이 범위를 벗어나면 `INVALID_PLAN`입니다.
길이만 바꾸는 요청에는 검색 문장 배열이 비어 있을 수 있습니다.
이 경우 호출자가 기준 소리나 직전 문장 점수를 유지합니다.
직전 결과의 중앙값을 사용하는 상대 길이 계산은 기존 검색 코어에서 처리합니다.

| HTTP | error |
|---|---|
| 400 | INVALID_JSON, INVALID_REQUEST |
| 404 | NOT_FOUND |
| 405 | METHOD_NOT_ALLOWED |
| 413 | INPUT_TOO_LONG |
| 429 | RATE_LIMITED, DAILY_LIMIT |
| 503 | BUSY, KEY_UNAVAILABLE |
| 504 | TIMEOUT |
| 502 | UPSTREAM_ERROR, INVALID_PLAN |

클라이언트는 같은 오류 코드의 `Error`를 던지고, 접속 실패는 `OFFLINE`으로 알립니다.
화면의 글자 검색 전환은 호출자가 처리합니다.
서버와 클라이언트의 시간 제한은 각각 15초이며 자동 재시도는 없습니다.

## 배포 경계

기본 실행은 프록시 헤더를 전부 무시합니다.
`TRUSTED_PROXY_ADDRESS`와 `TRUSTED_PROXY_HEADER`는 운영자가 확인한 바로 앞 프록시의 정확한 소켓 주소와
`cf-connecting-ip` 또는 `x-forwarded-for` 헤더 한 개를 지정할 때만 사용합니다.
둘 중 하나만 있거나 값이 틀리면 `TRUSTED_PROXY_INVALID`를 출력하고 멈춥니다. 실제 구성은 `deploy/SERVER_BRIEF.md`를 따릅니다.
헤더 값이 IP 한 개가 아니거나 소켓 주소가 다르면 믿지 않습니다.
프록시가 외부에서 받은 해당 헤더를 제거하고 직접 덮어쓰며, 이 서버에 직접 접근할 수 없는 구성이어야 합니다.
Cloudflare와 Tailscale 터널을 지났다는 이유만으로 헤더를 믿지는 않습니다.

IP당 1시간 120건, UTC 하루 전체 5,000건, 동시 5건을 제한합니다.
잘못된 본문도 요청 횟수에 포함하며, 카운터는 프로세스 메모리에 있어 재시작하면 초기화됩니다.
다중 프로세스로 실행하지 않습니다.
공개 주소와 두 회선의 실제 IP 확인은 배포 작업에서 수행합니다.
