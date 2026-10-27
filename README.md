# memorIN-deploy

`memorIN` 운영 배포 전용 저장소다. 앱 소스는 [`memorIN-backend`](https://github.com/inu-appcenter/memorIN-backend)와
[`memorIN-frontend`](https://github.com/inu-appcenter/memorIN-frontend)에 있고, 여기에는 두 앱의 GHCR 이미지를
`docker compose`로 띄우는 설정만 둔다.

공개 저장소다. `.env`와 `secrets/` 안의 파일은 `.gitignore`로 제외했으니 `git add -f`로 커밋하지 않는다.

## 배포 방식

- 서버에서 빌드하지 않는다. 앱 저장소 CI가 GHCR에 올린 이미지를 받아 `docker compose pull`, `docker compose up -d`로 띄운다.
- 앱센터 공용 서버 표준을 따른다. frontend와 스토리지는 127.0.0.1에만 포트를 열고, 공용 [Caddy](https://caddyserver.com/)가
  도메인별로 연결한다. 도메인은 Cloudflare DNS에 등록한다.

```text
compose.yaml                    # postgres, minio(Silo), backend, frontend
.env.example                    # cp .env.example .env 후 채운다
infra/postgres/postgresql.conf  # 운영용 PostgreSQL 설정
secrets/                        # firebase-service-account.json 등(커밋 금지)
```

## 사전 준비

### 1. 서버

- CPU x86_64(`uname -m`). CI가 amd64 이미지만 만든다.
- Docker Engine과 Compose V2(`docker compose version`). `docker-compose`(V1)는 쓰지 않는다.
- 메모리는 컨테이너 상한 합이 약 2GB(postgres 512m, minio 512m, backend 1g)다. OS와 Caddy 몫, DB·업로드·이미지·로그용 디스크를 여유 있게 둔다.
- `git`, `openssl`, 공용 Caddyfile(`/etc/caddy/Caddyfile`)을 고칠 SSH 권한.

### 2. 호스트네임

- `memorin.inuappcenter.kr`: 웹, API, WebSocket
- `memorin-storage.inuappcenter.kr`: 스토리지 S3 API

[#1](https://github.com/inu-appcenter/memorIN-deploy/issues/1)의 제안안이며 아직 확정 전이다. 확정된 이름이 다르면 Caddyfile과
`.env`의 `MINIO_PUBLIC_ENDPOINT`, `CORS_ALLOWED_ORIGINS`에 그 이름을 쓴다. Cloudflare 존은 `inuappcenter.kr`(`.co.kr` 아님)이다.
스토리지를 따로 두는 이유는 '참고'에 있다.

### 3. Caddy와 DNS

1. **포트 고르기**: Caddyfile의 `localhost:<포트>`와 겹치지 않는 포트 2개를 `.env`의 `FRONTEND_PORT`, `MINIO_S3_PORT`에 넣는다.
   공용 서버에서는 `5432`를 이미 쓰므로 `POSTGRES_PORT`도 바꾼다(예: `15432`). Caddy를 거치지 않는 서비스도 있으니 실제로 비었는지 확인한다.

   ```sh
   ss -tln | grep -E ':(<FRONTEND_PORT>|<MINIO_S3_PORT>|<POSTGRES_PORT>|<MINIO_CONSOLE_PORT>) '   # 출력이 없으면 비어 있다
   ```

2. **Caddyfile에 블록 2개 추가**(다른 프로젝트 블록은 건드리지 않는다).

   ```caddyfile
   memorin.inuappcenter.kr {
       reverse_proxy localhost:<FRONTEND_PORT>
   }

   memorin-storage.inuappcenter.kr {
       request_body {
           max_size 50MiB   # 선택. MINIO_MAX_UPLOAD_SIZE_BYTES(기본 52428800)와 같게. MB가 아니라 MiB
       }
       reverse_proxy localhost:<MINIO_S3_PORT>
   }
   ```

   - 스토리지 블록에서 `handle_path`로 경로를 자르거나 `header_up Host`로 Host를 바꾸지 않는다. presigned URL은 호스트와 경로까지 서명해
     `SignatureDoesNotMatch`가 난다. CORS 헤더도 붙이지 않는다(Silo가 처리, 중복되면 브라우저가 거부).
   - presigned PUT은 선언한 `Content-Length`까지 서명하고 backend가 상한을 검사한다([memorIN-backend#296](https://github.com/inu-appcenter/memorIN-backend/issues/296)).
     `request_body`는 프록시에서 한 번 더 막는 장치다. 초과 시 Caddy 2.7.0 이상은 413, 그 전은 502다.

3. **반영**: 보통 `sudo systemctl reload caddy`. 정확한 방법은 서버 관리자에게 확인한다.
4. **DNS**: 두 이름을 서버 공인 IP로 A 레코드 등록(프록시 켜짐). 공유 존이라 이름이 비어 있는지 먼저 보고, 다른 레코드는 수정하지 않는다.
5. **SSL/TLS 모드는 Full(strict)**: Flexible이면 리디렉션이 반복된다. 존 설정(SSL/TLS > Overview)은 공유 설정이라 바로 바꾸지 않고,
   두 호스트네임에 걸린 Rules도 확인한다. 존을 건드리지 않으려면 Configuration Rule(Hostname equals 두 이름을 Or, SSL: Strict)로 둔다. 앱센터와 정한다.
6. **Always Use HTTPS**: 켜져 있으면 Caddy 첫 인증서 발급(HTTP-01)이 실패할 수 있다. 발급 오류가 계속되면 앱센터와 아래 중 하나를 정한다.
   - Always Use HTTPS를 끄고 `/.well-known/`을 뺀 Redirect Rule 사용: `(http.request.scheme eq "http") and not starts_with(http.request.uri.path, "/.well-known/")`
   - 첫 발급 때만 두 레코드의 프록시를 껐다가 다시 켠다.
   - DNS-01 검증(Caddy Cloudflare DNS 모듈과 API 토큰 필요)

### 4. 이미지 확인

```sh
docker manifest inspect ghcr.io/inu-appcenter/memorin-backend:latest
docker manifest inspect ghcr.io/inu-appcenter/memorin-frontend:latest
docker manifest inspect docker.io/pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46
```

- `denied`면 이미지가 없거나 패키지가 비공개다. 비공개로 두기로 했다면 `read:packages` 토큰으로 `docker login ghcr.io -u <GitHub 사용자명>`.
- MinIO 공식 이미지는 2026-09 Docker Hub에서 삭제돼, 커뮤니티 포크 Silo를 버전과 digest로 고정해 쓴다. 설정·환경변수·데이터 형식은 MinIO와 같다([#6](https://github.com/inu-appcenter/memorIN-deploy/issues/6)).
- Docker Hub는 비로그인 pull을 IP당 6시간 100회로 제한한다. `toomanyrequests`가 나면 `docker login` 후 다시 받는다.

## 배포

```sh
git clone https://github.com/inu-appcenter/memorIN-deploy.git
cd memorIN-deploy
cp .env.example .env
vi .env   # 아래 필수값을 채운다

# FCM을 쓸 때만: .env에서 FIREBASE_ENABLED=true
cp /path/to/firebase-service-account.json secrets/
chmod 644 secrets/firebase-service-account.json   # 컨테이너는 non-root(spring)로 읽는다

docker compose pull
docker compose up -d
docker compose ps   # 4개 서비스가 모두 healthy면 된다
```

### `.env` 필수값

| 변수 | 값 | 비어 있으면 |
|---|---|---|
| `FRONTEND_PORT`, `MINIO_S3_PORT` | 사전 준비에서 고른 포트 | 해당 서비스가 뜨지 않는다 |
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` | `up`, `pull`이 시작 전에 멈춘다 |
| `MINIO_ROOT_USER` | `openssl rand -hex 12` (영숫자 3자 이상) | 〃 |
| `MINIO_ROOT_PASSWORD` | `openssl rand -base64 24` (8자 이상) | 〃 |
| `MINIO_PUBLIC_ENDPOINT` | 예: `https://memorin-storage.inuappcenter.kr` | backend가 뜨지 않는다 |
| `JWT_SECRET` | `openssl rand -base64 32` (256비트 이상) | backend가 뜨지 않는다 |
| `CORS_ALLOWED_ORIGINS` | 예: `https://memorin.inuappcenter.kr` | 로그인 같은 POST와 WebSocket이 403 |

- 비밀값에 기본값을 두지 않은 것은 공개 저장소라 기본값이 곧 공개 값이 되기 때문이다.
- backend가 뜨지 않으면 frontend도 뜨지 않는다.
- 브라우저 푸시는 `WEB_PUSH_ENABLED=true`와 VAPID 키 두 개(`npx web-push generate-vapid-keys`)를 채운다.
- 운영 중에 `POSTGRES_PASSWORD`를 바꿀 때는 '운영 > DB 비밀번호 바꾸기'를 따른다.

## 배포 후 확인

호스트네임이 바뀌었다면 확정된 이름으로 바꿔 쓴다.

1. `docker compose ps`가 모두 `healthy`. `dependency failed to start`면 `docker compose logs backend`부터 본다.
2. `curl -fsS https://memorin.inuappcenter.kr/api/health`에 `"status":"UP"`(DB 연결까지 확인).
3. `curl -fsS https://memorin-storage.inuappcenter.kr/minio/health/live`가 오류 없이 끝난다.
4. 웹에서 회원가입·로그인. 403이면 `CORS_ALLOWED_ORIGINS`를 본다.
5. 사진을 올리고 다시 연다. 실패하면 `MINIO_PUBLIC_ENDPOINT`와 Caddy 스토리지 블록을 본다(버킷은 첫 업로드 때 생성).
6. 서버 밖에서 443/80 외 포트(8080, 9000, `FRONTEND_PORT`, `MINIO_S3_PORT`)로 접속이 안 되는지 확인한다.

   ```sh
   nc -vz -w 3 <서버IP> 8080
   nc -vz -w 3 <서버IP> 9000
   ```

## 운영

### 업데이트

먼저 실행 중인 이미지의 커밋 해시를 적어 두고(롤백용) 백업한다.

```sh
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' memorin_backend memorin_frontend
git pull                # compose.yaml, .env.example 변경
docker compose pull     # 앱만 올릴 때는 docker compose pull backend frontend
docker compose up -d
```

- `git pull` 뒤 `.env.example`에 새 필수값이 생겼는지 `.env`와 비교한다.
- `BACKEND_TAG`, `FRONTEND_TAG`를 `sha-` 태그로 고정해 두었다면 `latest`로 되돌려야 새 이미지를 받는다.
- backend만 다시 만든 뒤 웹의 `/api`가 502면 `docker compose restart frontend`(frontend#115 수정 전까지).
- Silo는 버전을 고정했다. 올릴 때는 [보안 권고](https://silo.pgsty.com/about/security-advisories/)와 릴리스 노트를 보고 `compose.yaml`의
  태그와 digest(`docker buildx imagetools inspect docker.io/pgsty/silo:<태그>`)를 함께 바꾼다. 헬스체크가 `mc`를 쓰므로 `-distroless` 이미지는 쓰지 않는다.
- 끝나면 `docker image prune`, 그리고 '배포 후 확인'을 다시 한다.

### 롤백

```sh
# .env의 BACKEND_TAG(또는 FRONTEND_TAG)를 sha-<커밋 해시 40자>로 바꾼 뒤
docker compose up -d backend   # 또는 frontend
```

- 해시는 업데이트 전에 적어 둔 값이나 GitHub 조직 Packages 화면의 태그를 쓴다. 짧은 해시 태그는 없다.
- DB 마이그레이션이 들어간 릴리스는 이미지만 되돌려 복구되지 않을 수 있다. backend 담당자와 먼저 확인하고 필요하면 백업으로 복원한다.
- API 형식이 바뀐 릴리스는 backend와 frontend를 같은 시점 태그로 함께 되돌린다.
- 원인을 고친 이미지가 올라오면 태그를 `latest`로 되돌린다.

### DB 비밀번호 바꾸기

볼륨이 이미 있으면 postgres는 `.env`의 `POSTGRES_PASSWORD`를 다시 읽지 않는다. DB 비밀번호를 먼저 바꾸고 `.env`를 고친다.

```sh
docker compose exec postgres psql -U memorin_user -d memorin_db   # 기본값을 바꿨다면 .env 값
```

psql에서 `\password memorin_user`로 바꾼다. `ALTER USER ... PASSWORD`는 `log_statement = 'ddl'` 때문에 로그에 평문이 남으니 쓰지 않는다.
그다음 `.env`를 같은 값으로 고치고 `docker compose up -d`.

### 백업

자동 백업은 아직 없다([#8](https://github.com/inu-appcenter/memorIN-deploy/issues/8)). 첫 배포 직후와 업데이트 전에 직접 받는다.

```sh
mkdir -p ~/memorin-backups && chmod 700 ~/memorin-backups
docker compose exec -T postgres pg_dump -U memorin_user -Fc memorin_db > ~/memorin-backups/memorin-$(date +%F).dump
```

- 덤프에는 사용자 정보와 비밀번호 해시가 있다. 저장소 폴더 밖에 두고, 가능하면 서버 밖에도 보관한다(`.gitignore`에 `*.dump`, `*.sql` 포함).
- `.env`와 `secrets/`도 백업 대상이다. 스토리지 백업과 복원 절차는 #8에서 정한다.
- `docker compose down -v`는 `postgres_data`, `minio_data` 볼륨까지 지우므로 운영에서 쓰지 않는다.

### 운영 DB와 스토리지 콘솔 접속

postgres와 콘솔(9001)은 127.0.0.1에만 열려 있다. 내 PC에서 SSH 터널을 연다.

```sh
ssh -N -L 15432:127.0.0.1:<POSTGRES_PORT> -L 9001:127.0.0.1:<MINIO_CONSOLE_PORT> <사용자>@<서버IP>
```

- DB: `localhost:15432`, 계정은 서버 `.env`의 `POSTGRES_*`.
- 콘솔: `http://localhost:9001`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`.
- SSH 터널을 쓸 수 없으면 서버에서 `docker compose exec postgres psql -U memorin_user -d memorin_db`.

## 참고

### 스토리지 호스트네임을 따로 두는 이유

presigned URL(SigV4)은 경로까지 서명하므로 `memorin.../storage/...`처럼 경로로 나눠 프록시하면 `SignatureDoesNotMatch`가 난다
([minio/minio#7857](https://github.com/minio/minio/issues/7857)). 두 단계 서브도메인(`storage.memorin.inuappcenter.kr`)은
Cloudflare Universal SSL이 한 단계(`*.inuappcenter.kr`)까지만 덮어서 쓰지 않는다.

### 이미지 빌드와 태그

- backend: `main` 푸시(release PR 머지) 때 `build`, `migrations`를 통과한 커밋만 `ghcr.io/inu-appcenter/memorin-backend`에 올린다.
- frontend: `main` 푸시 때 `ghcr.io/inu-appcenter/memorin-frontend`에 올린다.
- 둘 다 `latest`와 바뀌지 않는 `sha-<커밋 해시 40자>` 태그를 올린다.

### 로컬 개발

로컬 개발에는 `memorIN-backend`의 `docker-compose.yml`을 쓴다(소스 빌드, pgAdmin 포함). 로컬 DB 접속과 권한 설정은
`memorIN-backend/docs/pgadmin-onboarding-grant-guide.md`를 본다.

### 기여

PR 제목은 `<type>: <설명>` 형식이다. CI가 `compose.yaml` 설정 검사와 제목 검사를 돌리고, `main`은 PR로만 바꿀 수 있다.

## 라이선스

배포 설정은 [MIT License](LICENSE)를 따른다. Copyright (c) 2026 INU AppCenter.
애플리케이션은 각 저장소 라이선스(backend AGPL-3.0, frontend MIT)를, 외부 이미지는 각자의 라이선스(Silo는 AGPL-3.0)를 따른다.
