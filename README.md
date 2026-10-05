# memorIN-deploy

`memorIN`의 운영 배포 전용 저장소다. 앱 소스는 [`memorIN-backend`](https://github.com/inu-appcenter/memorIN-backend)와
[`memorIN-frontend`](https://github.com/inu-appcenter/memorIN-frontend)에 있고, 이 저장소에는 두 앱의
GHCR 이미지를 묶어 `docker compose`로 띄우는 설정만 둔다.

이 저장소는 공개되어 있다. `.env`와 `secrets/` 안의 파일은 `.gitignore`로 제외해 두었으니,
`git add -f` 등으로 억지로 커밋하지 않도록 주의한다.

## 배포 방식 요약

- 서버에서 소스를 빌드하지 않는다. 두 앱 저장소의 CI가 GHCR에 올린 이미지를 `image:`로 받아 쓰기만 하므로,
  배포는 `docker compose pull`과 `docker compose up -d` 두 명령으로 끝난다.
- 앱센터 공용 서버의 표준 방식을 따른다. frontend와 MinIO는 127.0.0.1에만 포트를 열고, 같은 서버에서
  도는 공용 [Caddy](https://caddyserver.com/) 리버스 프록시가 도메인별로 그 포트에 연결한다. 도메인은
  Cloudflare DNS에 서버로 등록한다. 관리용 SSH 접속은 이와 별개다.

## 파일 구성

```text
compose.yaml                    # Docker Compose V2 설정. postgres, minio, backend, frontend
.env.example                    # cp .env.example .env 후 채운다. .env는 커밋하지 않는다
infra/postgres/postgresql.conf  # memorIN-backend/infra/postgres/postgresql.conf를 바탕으로 한 운영용 설정
secrets/                        # firebase-service-account.json 등. 안의 파일은 커밋하지 않는다
```

## 사전 준비

### 1. 서버

- CPU가 x86_64(amd64)여야 한다. 지금 두 앱 저장소의 CI는 amd64 이미지만 만들기 때문에 ARM 서버에서는
  이미지를 받지 못한다. `uname -m` 결과가 `x86_64`인지 확인한다.
- Docker Engine과 Compose V2 플러그인이 있어야 한다. `docker compose version`으로 확인한다.
  하이픈이 들어간 `docker-compose`(V1)는 쓰지 않는다.
- 메모리는 컨테이너 상한만 더해도 약 2GB(postgres 512m, minio 512m, backend 1g)이고, frontend에는
  상한이 없다. 운영체제 몫과 공용 Caddy가 쓰는 몫까지 여유 있게 잡고, DB와 업로드 파일, 이미지, 로그를
  담을 디스크도 넉넉히 둔다. 권장 사양은 아직 정하지 않았다(확인 필요).
- 이 문서의 명령에는 `git`, `openssl`이 필요하다.
- 공용 Caddy 설정 파일(`/etc/caddy/Caddyfile`)을 수정할 SSH 권한이 있어야 한다. 다른 프로젝트도 같이
  쓰는 파일이므로, 기존 블록은 건드리지 않고 memorIN 블록만 추가한다.

### 2. 호스트네임 2개

- `memorin.inuappcenter.kr`: 웹(SPA), API, WebSocket
- `memorin-storage.inuappcenter.kr`: MinIO S3 API 전용

두 이름은 [#1](https://github.com/inu-appcenter/memorIN-deploy/issues/1) 코멘트의 제안안이며 아직 확정되지 않았다.
배포 전에 #1에서 확정된 이름을 확인하고, 다르면 Caddyfile과 `.env`의 `MINIO_PUBLIC_ENDPOINT`,
`CORS_ALLOWED_ORIGINS`에 확정된 이름을 쓴다. 배포용 Cloudflare 계정에 있는 존은 `inuappcenter.kr` 하나다
(`.co.kr`이 아니다).

스토리지에 전용 호스트네임이 필요한 이유와 두 단계 서브도메인을 쓰지 않는 이유는 '참고 > 스토리지 호스트네임을
따로 두는 이유'에 있다.

### 3. 리버스 프록시(Caddy) 설정과 DNS 등록

이 저장소는 인그레스 설정을 갖고 있지 않다. 서버의 공용 Caddyfile과 Cloudflare DNS에서 관리한다.

1. 서버에 SSH로 접속해 `/etc/caddy/Caddyfile`을 열고, 이미 쓰이고 있는 `localhost:<포트>` 값을 확인해
   겹치지 않는 포트 2개를 고른다. 고른 값을 `.env`의 `FRONTEND_PORT`, `MINIO_S3_PORT`에 넣는다.

   Caddyfile에 없는 포트도 쓰이고 있을 수 있다(Caddy를 거치지 않는 DB, 모니터링 컨테이너 등). 그리고
   compose 기본값인 postgres `5432`, MinIO 콘솔 `9001`도 다른 서비스와 겹칠 수 있다. 공용 서버에서는
   `5432`를 이미 다른 서비스가 쓰고 있으므로 `POSTGRES_PORT`를 다른 값(예: `15432`)으로 바꿔야 한다.
   고른 포트 4개가 실제로 비어 있는지 서버에서 확인한다. 아무것도 출력되지 않으면 모두 비어 있다.

   ```sh
   ss -tln | grep -E ':(<FRONTEND_PORT>|<MINIO_S3_PORT>|<POSTGRES_PORT>|<MINIO_CONSOLE_PORT>) '
   ```
2. Caddyfile에 아래 형태로 블록 2개를 추가한다(다른 프로젝트 블록은 그대로 둔다).

   ```caddyfile
   memorin.inuappcenter.kr {
       reverse_proxy localhost:<FRONTEND_PORT>
   }

   memorin-storage.inuappcenter.kr {
       reverse_proxy localhost:<MINIO_S3_PORT>
   }
   ```

   스토리지 블록은 이 형태를 그대로 유지한다. `handle_path`로 경로를 자르거나 `header_up Host`로 Host를
   바꾸지 않는다. presigned URL은 SigV4로 호스트와 경로까지 서명하므로, 둘 중 하나라도 바뀌면
   `SignatureDoesNotMatch`가 난다. CORS 헤더도 Caddy에서 따로 붙이지 않는다. Silo가 이미 CORS를
   처리하므로, 헤더가 중복되면 브라우저가 요청을 거부한다.

   presigned PUT URL은 발급 때 선언한 크기(`Content-Length`)까지 서명한다([memorIN-backend#296](https://github.com/inu-appcenter/memorIN-backend/issues/296)).
   선언과 다른 크기의 본문은 스토리지가 403으로 거절하고, 선언한 크기가 `MINIO_MAX_UPLOAD_SIZE_BYTES`를
   넘는지는 backend가 발급 때 검사한다. 프록시에서도 한 번 더 막으려면 스토리지 블록에 아래처럼
   `request_body`를 추가한다. Cloudflare 프록시가 켜져 있으면 요청 본문 100MB 제한도 함께 걸린다.

   ```caddyfile
   memorin-storage.inuappcenter.kr {
       request_body {
           max_size 50MiB
       }
       reverse_proxy localhost:<MINIO_S3_PORT>
   }
   ```

   `50MiB`는 `MINIO_MAX_UPLOAD_SIZE_BYTES` 기본값 52428800과 같은 값이다. Caddy는 `MB`를 1000 단위로,
   `MiB`를 1024 단위로 읽으므로 `50MB`로 쓰면 상한보다 작아진다. 이 값을 바꿨다면 같은 크기로 맞춘다.
   한도를 넘은 요청에 413을 돌려주는 것은 Caddy 2.7.0부터이고, 그 전 버전은 502를 준다. 서버의 Caddy
   버전은 `caddy version`으로 확인한다.

3. 설정을 반영한다(서버에 이미 Caddy가 서비스로 떠 있다면 보통 `sudo systemctl reload caddy` 계열 명령이다.
   정확한 방법은 서버 관리자나 기존 배포 사례를 따른다).
4. Cloudflare DNS 대시보드에서 두 호스트네임을 서버의 공인 IP로 등록한다(A 레코드, 프록시 켜짐). 이미
   같은 이름의 레코드가 있으면 실패하므로, 공유 존에서 이름이 비어 있는지 먼저 확인한다(사전 준비 > 2 참고).
   다른 프로젝트가 쓰는 레코드는 예시로만 참고하고 수정하지 않는다.
5. 두 호스트네임에 적용되는 Cloudflare SSL/TLS 모드가 Full(strict)인지 확인한다. Flexible이면 Cloudflare가
   서버에 http로 붙고 Caddy가 다시 https로 돌려보내면서 리디렉션이 반복된다. 두 곳을 본다.

   - SSL/TLS > Overview: 존 전체에 적용되는 값이다. 새 존은 Automatic SSL/TLS로 되어 있을 수 있다.
     다른 프로젝트도 함께 쓰는 공유 설정이라 바로 바꾸지 않는다.
   - Rules: 두 호스트네임에 걸린 Configuration Rule이나 Page Rule이 있는지 본다. 규칙의 SSL 설정은 존
     설정보다 우선한다.

   존 값을 바꾸지 않고 memorIN 두 호스트네임만 Full(strict)로 둘 수도 있다. Rules > Overview > Create rule >
   Configuration Rule에서 조건에 Hostname equals `memorin.inuappcenter.kr`와 Hostname equals
   `memorin-storage.inuappcenter.kr`를 Or로 이어 넣고, 설정 SSL에서 Strict를 고른다. Strict가 존 설정의
   Full(strict)에 해당하고, Origin Pull은 다른 모드다. Free 요금제에서도 쓸 수 있다(규칙 10개까지). 어느
   쪽으로 할지는 지금 값을 확인한 뒤 앱센터에 물어본다.
6. Always Use HTTPS(SSL/TLS > Edge Certificates)가 켜져 있는지도 SSL/TLS 모드와 함께 앱센터에 확인한다.
   켜져 있으면 Caddy가 두 호스트네임의 인증서를 처음 받을 때 실패할 수 있다. HTTP-01 검증 요청을
   Cloudflare가 https로 돌려보내는데 서버에는 아직 인증서가 없고, TLS-ALPN-01 검증은 Cloudflare 프록시
   뒤에서 동작하지 않기 때문이다. 같은 서버의 다른 사이트가 이미 프록시 뒤에서 잘 돌고 있다면 문제없을
   가능성이 높다. Caddy 로그에 발급 오류가 계속 나오면 아래 중 하나를 앱센터와 정해 쓴다. 셋 다 공유 존이나
   공용 Caddy를 건드리는 일이다.

   - Always Use HTTPS를 끄고, 인증서 검증 경로(`/.well-known/`)를 뺀 Redirect Rule로 https 리디렉션을 한다.
     조건 예: `(http.request.scheme eq "http") and not starts_with(http.request.uri.path, "/.well-known/")`
   - 첫 발급 때만 두 DNS 레코드의 프록시를 끄고, 인증서를 받은 뒤 다시 켠다.
   - DNS-01 검증으로 받는다. Caddy에 Cloudflare DNS 모듈과 API 토큰이 있어야 한다.

### 4. 이미지를 받을 수 있는지 확인

compose가 쓰는 이미지 중 하나라도 받지 못하면 `docker compose pull`이 멈춘다. 서버에서 미리 확인한다.

```sh
docker manifest inspect ghcr.io/inu-appcenter/memorin-backend:latest
docker manifest inspect ghcr.io/inu-appcenter/memorin-frontend:latest
docker manifest inspect docker.io/pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46
```

- `denied`가 나오면 이미지가 아직 없거나 패키지가 비공개다. 로그인하지 않은 상태에서는 둘을 구분할 수 없으니 GitHub 조직의
  Packages 화면에서 확인한다.
- backend 이미지는 `image` job을 담은 release PR([memorIN-backend#282](https://github.com/inu-appcenter/memorIN-backend/pull/282))이
  `main`에 병합된 뒤에 올라온다. 2026-09-29에 병합되어 지금은 받을 수 있다.
- 패키지가 비공개라면 조직 관리자에게 공개 전환을 요청한다([#1](https://github.com/inu-appcenter/memorIN-deploy/issues/1)).
  비공개로 두기로 했다면 `read:packages` 권한만 준 GitHub 개인 액세스 토큰으로 로그인한 뒤 받는다.

  ```sh
  docker login ghcr.io -u <GitHub 사용자명>   # 비밀번호 자리에 토큰을 넣는다
  ```

- MinIO 공식 이미지(`minio/minio`)는 MinIO가 커뮤니티판 배포를 끝내면서 2026-09 Docker Hub에서 삭제됐다.
  이 저장소는 MinIO 커뮤니티 포크인 Silo(`pgsty/silo`)를 버전과 digest로 고정해 쓴다. 설정, 환경변수, 데이터 형식은
  MinIO와 같다([#6](https://github.com/inu-appcenter/memorIN-deploy/issues/6)).
- Docker Hub는 로그인하지 않은 다운로드를 IP당 6시간에 100회로 제한한다(로그인하면 6시간에 200회).
  Silo와 postgres가 모두 Docker Hub에서 받아지므로, pull이 `toomanyrequests`로 실패하면 서버에서
  `docker login`을 한 뒤 다시 받는다.

## 배포

서버에서 저장소를 받고 `.env`를 만든다. `vi .env` 단계에서 아래 '`.env` 필수값' 표의 값을 모두 채운 뒤
나머지 명령을 실행한다.

```sh
git clone https://github.com/inu-appcenter/memorIN-deploy.git
cd memorIN-deploy
cp .env.example .env
vi .env   # 필수값 채우기 (아래 표)

# FCM을 쓸 때만. .env에서 FIREBASE_ENABLED=true로 바꾸고 키 파일을 둔다
cp /path/to/firebase-service-account.json secrets/
chmod 644 secrets/firebase-service-account.json   # 컨테이너는 root가 아닌 spring 사용자로 이 파일을 읽는다

docker compose pull
docker compose up -d
docker compose ps   # postgres, minio, backend, frontend가 모두 healthy면 된다
```

### `.env` 필수값

| 변수 | 채울 값 | 비어 있으면 |
|---|---|---|
| `FRONTEND_PORT` | 사전 준비에서 고른, Caddyfile과 겹치지 않는 포트 | frontend가 뜨지 않는다 |
| `MINIO_S3_PORT` | 사전 준비에서 고른, Caddyfile과 겹치지 않는 포트 | minio가 뜨지 않는다 |
| `POSTGRES_PASSWORD` | 무작위 긴 값 (`openssl rand -base64 24`) | `docker compose up`, `pull`이 시작 전에 멈춘다 |
| `MINIO_ROOT_USER` | 무작위 영숫자 3자 이상 (`openssl rand -hex 12`) | `docker compose up`, `pull`이 시작 전에 멈춘다 |
| `MINIO_ROOT_PASSWORD` | 무작위 8자 이상 (`openssl rand -base64 24`) | `docker compose up`, `pull`이 시작 전에 멈춘다 |
| `MINIO_PUBLIC_ENDPOINT` | 스토리지 공개 주소. 예: `https://memorin-storage.inuappcenter.kr` | backend가 뜨지 않는다 |
| `JWT_SECRET` | 256비트 이상 무작위 값 (`openssl rand -base64 32`) | backend가 뜨지 않는다 |
| `CORS_ALLOWED_ORIGINS` | 웹 공개 주소. 예: `https://memorin.inuappcenter.kr` | 서비스는 뜨지만 로그인 같은 POST 요청과 WebSocket 연결이 403으로 막힌다. 공개 주소와 다를 때도 같다 |

- `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`에는 기본값을 두지 않았다. 공개 저장소라
  기본값을 두면 그 값이 그대로 공개되기 때문이다. 셋 중 하나라도 비어 있으면 `docker compose up`과
  `pull`이 시작 전에 오류를 내고 멈추므로 `.env`부터 고친다.
- backend가 뜨지 않으면 backend를 기다리는 frontend도 뜨지 않는다.
- 푸시 알림은 선택이다. FCM을 쓰려면 `FIREBASE_ENABLED=true`로 바꾸고 서비스 계정 키 파일을 둔다(위 명령).
  브라우저 푸시를 쓰려면 `WEB_PUSH_ENABLED=true`로 바꾸고 VAPID 키 두 개를 채운다. VAPID 키는
  `npx web-push generate-vapid-keys`로 만든다(Node.js 필요).
- 이미 운영 중인 서버에서 `POSTGRES_PASSWORD`를 바꿀 때는 `.env`만 고치면 안 된다. '운영 > DB 비밀번호 바꾸기'를 따른다.

## 배포 후 확인

아래 순서로 확인한다. 호스트네임이 바뀌었다면 확정된 이름으로 바꿔 쓴다.

1. `docker compose ps`에서 postgres, minio, backend, frontend가 모두 `healthy`인지 본다.
   `docker compose up -d`가 `dependency failed to start`로 멈췄다면 `docker compose logs backend`부터 본다.
2. 서버 밖에서 API를 확인한다. 응답에 `"status":"UP"`이 있으면 된다. 이 경로는 인증 없이 열려 있고 DB 연결까지 확인한다.

   ```sh
   curl -fsS https://memorin.inuappcenter.kr/api/health
   ```

3. 서버 밖에서 스토리지 경로를 확인한다. 오류 없이 끝나면 된다.

   ```sh
   curl -fsS https://memorin-storage.inuappcenter.kr/minio/health/live
   ```

4. 브라우저로 웹 주소에 들어가 회원가입과 로그인을 해 본다. 403이 나오면 `CORS_ALLOWED_ORIGINS`를 확인한다.
5. 사진을 한 장 올리고 다시 열어 본다. 실패하면 `MINIO_PUBLIC_ENDPOINT`와 Caddyfile의 스토리지 블록을 확인한다.
   버킷은 첫 업로드 때 backend가 만들므로 따로 만들 필요가 없다.
6. 서버 밖에서 8080, `FRONTEND_PORT`, `MINIO_S3_PORT`, 9000 포트로 바로 접속되지 않는지 확인한다.
   Caddy가 붙는 443/80을 뺀 나머지는 전부 실패해야 정상이다(루프백에만 바인딩되어 있어서다).

   ```sh
   nc -vz -w 3 <서버IP> 8080
   nc -vz -w 3 <서버IP> 9000
   ```

## 운영

### 업데이트

업데이트 전에 지금 실행 중인 이미지의 커밋 해시를 적어 두고, '백업' 절차대로 백업한다. 적어 둔 해시는 롤백할 때 태그로 쓴다.

```sh
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' memorin_backend memorin_frontend
```

그다음 이 저장소와 이미지를 새로 받는다.

```sh
git pull              # 이 저장소의 compose.yaml, .env.example 변경을 받는다
docker compose pull
docker compose up -d
```

- `git pull` 뒤에는 `.env.example`에 새 필수값이 생겼는지 `.env`와 비교한다.
- 앱 이미지만 올릴 때는 `docker compose pull backend frontend`를 쓴다.
- MinIO(Silo)는 버전을 고정해 두었으므로 자동으로 올라가지 않는다. 올릴 때는 Silo 보안 권고
  (https://silo.pgsty.com/about/security-advisories/)와 릴리스 노트를 확인하고 `compose.yaml`의 태그와 digest를 함께 바꾼다.
  이미지는 태그에 `-distroless`가 붙지 않은 클래식 이미지를 쓴다. distroless 이미지에는 헬스체크가 쓰는 `mc`가 없다.
  digest는 `docker buildx imagetools inspect docker.io/pgsty/silo:<태그>`의 `Digest` 줄에 나오는 값을 쓴다.
- 롤백하면서 `.env`의 `BACKEND_TAG`, `FRONTEND_TAG`를 `sha-` 태그로 고정해 두었다면, 먼저 `latest`로 되돌려야
  새 이미지를 받는다.
- 이전 이미지는 `docker image prune`으로 정리한다.
- 업데이트가 끝나면 '배포 후 확인'을 다시 한다.

### 롤백

직전 이미지의 태그로 되돌리고, 되돌린 서비스만 다시 띄운다.

```sh
# .env에서 BACKEND_TAG(또는 FRONTEND_TAG)를 GHCR의 sha-<커밋 해시> 태그로 바꾼 뒤
docker compose up -d backend   # 또는 frontend
```

- 태그는 `sha-` 뒤에 커밋 해시 40자 전체가 붙는다. 짧은 해시로 된 태그는 없다.
  형식 예: `FRONTEND_TAG=sha-02d9eeb2b1d2e3f629431a685e91a1dd87ce743a` (해시는 실제 되돌릴 커밋으로 바꾼다)
- 직전 커밋은 업데이트 전에 적어 둔 값을 쓴다. GitHub 조직의 Packages 화면(`memorin-backend`, `memorin-frontend`)에서도
  태그 목록을 볼 수 있다.
- DB 마이그레이션이 들어간 릴리스는 이미지만 되돌려서는 복구되지 않을 수 있다. backend를 되돌리기 전에 backend
  담당자와 먼저 확인하고, 필요하면 업데이트 전에 받아 둔 백업으로 복원한다.
- API 형식이 바뀐 릴리스는 backend와 frontend를 같은 시점의 태그로 함께 되돌린다.
- 롤백한 뒤에는 '배포 후 확인'을 다시 한다. backend만 다시 띄운 뒤 웹의 `/api` 요청이 502로 실패하면
  `docker compose restart frontend`를 실행한다.
- 원인을 고친 새 이미지가 올라오면 `.env`의 태그를 `latest`로 되돌린다.

### DB 비밀번호 바꾸기

`postgres_data` 볼륨이 이미 있는 서버에서는 `.env`의 `POSTGRES_PASSWORD`만 바꾸면 안 된다. postgres 이미지는
데이터 디렉터리가 비어 있을 때만 이 값을 쓰기 때문에, DB 비밀번호는 이전 값으로 남고 backend만 새 값으로
접속하다 실패한다. DB 비밀번호를 먼저 바꾸고 그다음 `.env`를 고친다.

```sh
# .env에서 POSTGRES_USER, POSTGRES_DB를 바꿨다면 그 값을 쓴다
docker compose exec postgres psql -U memorin_user -d memorin_db
```

psql 프롬프트에서 아래 명령을 실행하면 새 비밀번호를 두 번 묻는다.

```text
\password memorin_user
```

`ALTER USER ... PASSWORD '...'`를 직접 실행하지 않는다. 이 저장소의 `postgresql.conf`는 `log_statement = 'ddl'`이라
새 비밀번호가 postgres 로그에 평문으로 남는다. `\password`는 암호화한 값만 서버로 보낸다.

마지막으로 `.env`의 `POSTGRES_PASSWORD`를 같은 값으로 바꾸고 다시 띄운다.

```sh
docker compose up -d
```

### 백업

지금은 자동 백업이 없다([#1](https://github.com/inu-appcenter/memorIN-deploy/issues/1)). 첫 배포 직후와 업데이트
전에는 직접 백업한다.

```sh
# DB 백업. 덤프는 이 저장소 폴더가 아니라 저장소 밖에 둔다.
# 기본값을 바꿨다면 사용자와 DB 이름을 .env 값으로 바꾼다
mkdir -p ~/memorin-backups && chmod 700 ~/memorin-backups
docker compose exec -T postgres pg_dump -U memorin_user -Fc memorin_db > ~/memorin-backups/memorin-$(date +%F).dump
```

- 덤프에는 사용자 정보와 비밀번호 해시가 들어 있다. 이 저장소는 공개 저장소라서 덤프를 저장소 폴더 안에 두지 않는다.
  실수로 커밋되지 않도록 `.gitignore`에도 `*.dump`, `*.sql`, `*.sql.gz`를 넣어 두었다.
- 업로드 파일(MinIO) 백업 방법, 복원 절차, 백업 보관 위치는 아직 정하지 않았다(확인 필요).
- `docker compose down -v`는 `postgres_data`, `minio_data` 볼륨까지 지우므로 운영 서버에서 쓰지 않는다.
  실제 볼륨 이름 앞에는 compose 프로젝트 이름(기본값은 디렉터리 이름)이 붙는다. 예: `memorin-deploy_postgres_data`

### 운영 DB와 MinIO 콘솔 접속

postgres(5432)와 MinIO 콘솔(9001)은 서버의 127.0.0.1에만 열려 있다. 내 PC에서 SSH 터널을 연 뒤 접속한다.

```sh
# 내 PC에서 실행한다. 서버의 5432, 9001을 내 PC의 15432, 9001로 연결한다
ssh -N -L 15432:127.0.0.1:5432 -L 9001:127.0.0.1:9001 <사용자>@<서버IP>
```

- DB는 DBeaver 같은 도구에서 호스트 `localhost`, 포트 `15432`로 접속한다. DB 이름, 사용자, 비밀번호는 서버
  `.env`의 `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`를 쓴다.
- MinIO 콘솔은 브라우저에서 `http://localhost:9001`로 열고 `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`로 로그인한다.
- `.env`에서 `POSTGRES_PORT`나 `MINIO_CONSOLE_PORT`를 바꿨다면 서버 쪽 포트도 그 값으로 바꾼다.
- SSH를 쓸 수 없는 망이면 서버 콘솔에서 `docker compose exec postgres psql -U memorin_user -d memorin_db`로
  접속한다. 기본값을 바꿨다면 `.env`의 `POSTGRES_USER`, `POSTGRES_DB` 값을 쓴다.

## 참고

### 포트 충돌 피하기 (공용 Caddy)

`/etc/caddy/Caddyfile`은 앱센터의 여러 프로젝트가 함께 쓰는 파일이다. `FRONTEND_PORT`, `MINIO_S3_PORT`로
고르는 포트가 다른 프로젝트가 이미 쓰는 포트와 겹치면, 두 프로젝트 중 하나가 엉뚱한 컨테이너로 요청을
받게 된다.

- 포트를 고르기 전에 Caddyfile 전체에서 `localhost:` 뒤에 오는 값을 모두 확인한다.
- 다른 프로젝트가 쓰는 블록은 절대 수정하거나 지우지 않는다. memorIN 블록만 추가한다.
- Caddy와 compose는 서로 독립적으로 재시작될 수 있다. compose를 먼저 올리고 Caddyfile을 나중에 반영해도,
  그 반대여도 상관없다. 다만 둘 다 반영돼야 실제로 도메인이 연결된다.

### 스토리지 호스트네임을 따로 두는 이유

presigned URL은 SigV4 방식이라 경로까지 서명에 들어간다. 그래서 `memorin.../storage/...`처럼 경로로 나눠 MinIO에
프록시하면 서명이 맞지 않아 `SignatureDoesNotMatch` 오류가 난다([minio/minio#7857](https://github.com/minio/minio/issues/7857),
[#20765](https://github.com/minio/minio/issues/20765)). 스토리지에만 전용 호스트네임을 두는 이유다.

스토리지 주소를 `storage.memorin.inuappcenter.kr`처럼 두 단계 서브도메인으로 만들지 않은 것은 인증서 때문이다.
Cloudflare 기본 인증서(Universal SSL)는 full setup 존에서 `*.inuappcenter.kr`, 즉 한 단계 서브도메인까지만 적용된다.
두 단계를 쓰려면 Total TLS나 Advanced Certificate Manager가 필요하다.

### 이미지 빌드와 태그

`backend`, `frontend` 이미지는 이 저장소가 아니라 각 앱 저장소의 CI가 만든다.

- `memorIN-backend`: `main` 브랜치에 푸시될 때(release PR을 병합할 때) `.github/workflows/ci.yml`의 `image` job이
  실행된다. `build`, `migrations` job을 모두 통과한 커밋만 `ghcr.io/inu-appcenter/memorin-backend`에 올린다.
- `memorIN-frontend`: `main` 브랜치에 푸시될 때 `.github/workflows/ci.yml`의 `image` job이
  `ghcr.io/inu-appcenter/memorin-frontend`에 올린다.

두 저장소 모두 `latest` 태그와, 한 번 올리면 바뀌지 않는 `sha-<커밋 해시 40자>` 태그를 함께 올린다.
평소에는 `latest`를 쓰고, 롤백 방법은 '운영 > 롤백'에 있다.

### 로컬 개발 환경과의 차이

로컬 개발에는 이 저장소가 아니라 `memorIN-backend`의 `docker-compose.yml`을 쓴다. 그쪽은 소스에서 직접 빌드하고,
pgAdmin을 포함하며, 포트를 호스트에 그대로 연다. 이 저장소는 운영 전용이라 pgAdmin이 없다. 운영 DB 접속은
'운영 > 운영 DB와 MinIO 콘솔 접속'을 따른다. 로컬 DB 접속과 권한(GRANT) 설정은
`memorIN-backend/docs/pgadmin-onboarding-grant-guide.md`를 본다.

## 라이선스

이 저장소의 배포 설정은 [MIT License](LICENSE)를 따른다. Copyright (c) 2026 INU AppCenter.

- 애플리케이션 코드는 각 저장소의 라이선스를 따른다. `memorIN-backend`는 AGPL-3.0, `memorIN-frontend`는 MIT이고,
  전문은 각 저장소의 `LICENSE`에 있다.
- 이 구성이 받아 쓰는 외부 이미지(PostgreSQL, Silo 등)는 각자의 라이선스를 따른다. Silo는 AGPL-3.0이다.
