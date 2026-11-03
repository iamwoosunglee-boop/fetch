#!/usr/bin/env bash
# 올린 뒤 확인 명령 모음입니다. 키를 읽지 않고 공개 주소로만 요청합니다.
#   basic URL  페이지, 헤더, 오류 응답, 실제 요청 한 건을 확인합니다. 하이쿠를 한 번 부릅니다.
#   fill URL   이 회선의 시간당 한도를 잘못된 본문으로 채웁니다. 하이쿠를 부르지 않습니다.
#   probe URL  이 회선이 막혔는지 한 번 봅니다. 하이쿠를 부르지 않습니다.
#   forge URL  위조한 IP 헤더를 붙여 같은 확인을 합니다. 하이쿠를 부르지 않습니다.
set -u
mode="${1:-}"
base="${2:-}"
base="${base%/}"
if [ -z "$mode" ] || [ -z "$base" ]; then
  echo "usage: post-deploy-check.sh basic|fill|probe|forge URL" >&2
  exit 2
fi

status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
post_empty() { status -X POST -H 'content-type: application/json' -d '{}' "$@" "$base/plan"; }
failed=0
expect() {
  if [ "$2" = "$3" ]; then echo "PASS $1: $2"; else echo "FAIL $1: expected $2, got $3"; failed=1; fi
}

case "$mode" in
  basic)
    expect 'index' 200 "$(status "$base/")"
    entry="$(curl -fsS "$base/")"
    assets="$(printf '%s\n' "$entry" | grep -oE '(src|href)="/assets/[^"]+\.(js|css)"' | cut -d '"' -f 2)"
    if [ -z "$assets" ]; then echo 'FAIL built assets: none in entry'; failed=1; fi
    while IFS= read -r asset; do
      [ -z "$asset" ] || expect "built asset $asset" 200 "$(status "$base$asset")"
    done <<< "$assets"
    head="$(curl -sS -I "$base/" | tr -d '\r' | tr 'A-Z' 'a-z')"
    expect 'coop' 1 "$(printf '%s\n' "$head" | grep -c '^cross-origin-opener-policy: same-origin$')"
    expect 'coep' 1 "$(printf '%s\n' "$head" | grep -c '^cross-origin-embedder-policy: require-corp$')"
    expect 'plan GET' 405 "$(status "$base/plan")"
    expect 'plan bad JSON' 400 "$(status -X POST -H 'content-type: application/json' -d '{' "$base/plan")"
    expect 'phrase bad JSON' 400 "$(status -X POST -H 'content-type: application/json' -d '{' "$base/phrase")"
    body='{"text":"금속이 부딪히는 소리","has_reference":false,"reference_duration_seconds":null,"previous_plan":null}'
    answer="$(curl -sS -m 65 -w '\n%{http_code}' -X POST -H 'content-type: application/json' -d "$body" "$base/plan")"
    expect 'plan real request' 200 "$(printf '%s\n' "$answer" | tail -n 1)"
    printf '%s\n' "$answer" | head -n 1 | grep -q '"english_queries":\["' \
      && echo 'PASS plan fields: english_queries present' \
      || { echo 'FAIL plan fields: english_queries missing'; failed=1; }
    ;;
  fill)
    codes="$(for _ in $(seq 1 121); do post_empty; echo; done | sort | uniq -c | tr -s ' ')"
    echo "codes:$codes"
    expect 'last fill request' 429 "$(post_empty)"
    ;;
  probe)
    echo "CODE $(post_empty)  (400은 한도가 남은 회선, 429는 막힌 회선)"
    ;;
  forge)
    for name in CF-Connecting-IP X-Forwarded-For; do
      echo "CODE $name $(post_empty -H "$name: 203.0.113.9")  (채운 회선이면 429여야 합니다)"
    done
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
exit "$failed"
