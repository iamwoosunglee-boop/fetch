# 정적 호스팅 헤더 예시

기본 구성은 번들의 `web-server.mjs`입니다. 이 서버가 COOP와 COEP를 보내고 `/plan`과 `/phrase`를 릴레이로 넘기므로 아래 설정은 필요 없습니다. nginx나 Caddy로 대신 내보낼 때만 씁니다. 두 예시는 문법 검사를 하지 않았으므로 적용 전에 `nginx -t` 또는 `caddy validate`를 실행합니다.

꼭 지킬 점은 네 가지입니다. 모든 응답에 두 헤더를 보내고, `/plan`과 `/phrase`는 같은 주소에서 릴레이로 넘기며, 릴레이에 CORS를 켜지 않고, 실제 IP 헤더는 터널이 덮어쓴 값 하나만 넘깁니다. 아래 예시는 Cloudflare Tunnel 기준입니다. Tailscale Funnel이면 헤더 이름을 `X-Forwarded-For`로 바꿉니다. `.wasm`은 `application/wasm`으로 내보내야 합니다.

## nginx

```nginx
server {
    listen 127.0.0.1:14173;
    root /opt/proto1/web;
    include mime.types;

    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;

    location ~ ^/(plan|phrase)$ {
        proxy_pass http://127.0.0.1:18787;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        proxy_read_timeout 65s;
    }
}
```

## Caddy

```caddy
http://127.0.0.1:14173 {
    root * /opt/proto1/web
    header Cross-Origin-Opener-Policy same-origin
    header Cross-Origin-Embedder-Policy require-corp
    @relay path /plan /phrase
    reverse_proxy @relay 127.0.0.1:18787 {
        header_up CF-Connecting-IP {header.CF-Connecting-IP}
    }
    file_server
}
```

## 터널

Cloudflare Tunnel은 공개 호스트 이름의 대상을 `http://127.0.0.1:14173`로 둡니다.

Tailscale은 `tailscale funnel --bg 14173`을 씁니다. `--tcp`로 열면 HTTP 헤더가 붙지 않아 실제 IP를 알 수 없습니다.
