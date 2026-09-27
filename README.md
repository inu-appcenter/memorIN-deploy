# memorIN-deploy

`memorIN`의 **운영 배포 전용** 저장소다. 앱 소스는 [`memorIN-backend`](https://github.com/inu-appcenter/memorIN-backend),
[`memorIN-frontend`](https://github.com/inu-appcenter/memorIN-frontend)에 있고, 이 저장소는 두 앱의
GHCR 이미지를 조합해 `docker compose`로 띄우는 방법만 담는다.

이 저장소는 **public**이다. `.env`, `secrets/` 내용물은 `.gitignore`로 막혀 있으니 절대 커밋하지 않는다.

## 왜 별도 저장소인가

- 서버에서 소스를 빌드하지 않는다 — 두 앱 저장소의 CI가 GHCR에 미리 빌드한 이미지를 올리고,
  여기서는 `image:`로 pull만 한다. 배포가 `docker compose pull && docker compose up -d` 두 줄로 끝난다.
- 인바운드 포트를 하나도 열지 않는다 — 진입점은 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) 하나뿐이라
  기업/기관망처럼 인바운드 방화벽이 막혀 있는 환경에서도 서버를 그대로 올릴 수 있다.

## 구성

```
compose.yaml                    # Docker Compose V2. postgres · minio · backend · frontend · cloudflared
.env.example                    # cp .env.example .env 후 채운다 (.env는 커밋 금지)
infra/postgres/postgresql.conf  # memorIN-backend/infra/postgres/postgresql.conf 사본
secrets/                        # firebase-service-account.json 등 (내용물은 .gitignore로 커밋 금지)
```

## 사전 준비

1. **도메인 2개** (모두 같은 Cloudflare Tunnel, 같은 인증서로 나간다)
   - `memorin.inuappcenter.co.kr` — 웹(SPA) + API + WebSocket
   - `storage.memorin.inuappcenter.co.kr` — MinIO S3 API 전용

   MinIO는 presigned URL이 서명에 경로까지 포함하는 SigV4를 쓰기 때문에 **경로(subpath) 리버스
   프록시가 불가능**하다. `memorin.../storage/...` 같은 구성은 `SignatureDoesNotMatch`로 실패한다
   ([minio/minio#7857](https://github.com/minio/minio/issues/7857),
   [#20765](https://github.com/minio/minio/issues/20765)). 그래서 스토리지만 전용 호스트네임을 쓴다.

2. **Cloudflare Tunnel 생성 및 ingress 설정** (Zero Trust 대시보드 > Networks > Tunnels)
   - `Create a tunnel` → Cloudflared 커넥터 선택 → 토큰을 `.env`의 `CLOUDFLARE_TUNNEL_TOKEN`에 복사
   - Public Hostname 2개 추가(이 저장소에는 ingress 설정 파일이 없다 — 대시보드가 원본이다):

     | Public hostname | Service |
     |---|---|
     | `memorin.inuappcenter.co.kr` | `http://frontend:80` |
     | `storage.memorin.inuappcenter.co.kr` | `http://minio:9000` |

3. **서버 요구사항**
   - Docker Engine + Compose V2 플러그인 (`docker compose version`으로 확인, `docker-compose`
     하이픈 버전이 아니다)
   - 아웃바운드 **TCP 7844** 허용 (아래 "포트 제한 우회" 참고). 인바운드 포트는 필요 없다.

## 배포

```sh
git clone https://github.com/inu-appcenter/memorIN-deploy.git
cd memorIN-deploy
cp .env.example .env
vi .env   # 필수값 채우기 (아래 표)

# FCM을 쓴다면(FIREBASE_ENABLED=true)
cp /path/to/firebase-service-account.json secrets/
chmod 644 secrets/firebase-service-account.json   # 컨테이너가 non-root(spring)로 읽는다

docker compose pull
docker compose up -d
docker compose ps   # 전 서비스 healthy 확인
```

`.env` 필수값:

| 변수 | 채울 값 |
|---|---|
| `CLOUDFLARE_TUNNEL_TOKEN` | Zero Trust 대시보드에서 발급한 터널 토큰 |
| `POSTGRES_PASSWORD` | 무작위 긴 값 (`openssl rand -base64 24`) |
| `MINIO_ROOT_USER` | 무작위 영숫자 3자 이상 (`openssl rand -hex 12`) |
| `MINIO_ROOT_PASSWORD` | 무작위 8자 이상 (`openssl rand -base64 24`) |
| `MINIO_PUBLIC_ENDPOINT` | 스토리지 공개 주소 (`https://` + 위 "사전 준비"의 스토리지 호스트네임) |
| `JWT_SECRET` | 256비트 이상 무작위 값 (`openssl rand -base64 32`) |
| `CORS_ALLOWED_ORIGINS` | 웹 공개 주소 (`https://` + 위 "사전 준비"의 웹 호스트네임) |

- `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`는 기본값이 없다. 이 저장소가 public이라
  기본값이 곧 공개된 값이기 때문이다. 비어 있으면 compose가 기동 전에 에러를 내고 멈춘다
  (`docker compose ps`·`logs`·`down`도 같은 에러로 멈추니 `.env`부터 고친다).
- 나머지 네 값은 비어 있어도 compose는 진행된다. 대신 `JWT_SECRET`·`MINIO_PUBLIC_ENDPOINT`가 비면
  backend가, `CLOUDFLARE_TUNNEL_TOKEN`이 비면 cloudflared가 기동에 실패한다. `CORS_ALLOWED_ORIGINS`가
  비거나 공개 주소와 다르면 기동은 되지만 로그인 같은 POST 요청이 403으로 막힌다.
- 이미 한 번 기동해 `postgres_data` 볼륨이 있는 서버에서 `POSTGRES_PASSWORD`를 바꿀 때는 `.env`만 바꾸면
  안 된다. postgres 이미지는 데이터 디렉터리가 비어 있을 때만 이 값을 적용하므로 DB 쪽 비밀번호는 옛 값으로
  남고, backend만 새 값으로 접속하다 실패한다. 먼저 DB 비밀번호를 바꾼 뒤 `.env`를 고친다:
  ```sh
  docker compose exec postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB> \n    -c "ALTER USER <POSTGRES_USER> PASSWORD '<새 비밀번호>';"
  # 그다음 .env의 POSTGRES_PASSWORD를 같은 값으로 바꾸고
  docker compose up -d
  ```

업데이트(새 이미지 반영):

```sh
docker compose pull
docker compose up -d
```

롤백(직전 이미지로):

```sh
# .env 에서 BACKEND_TAG(또는 FRONTEND_TAG)를 GHCR의 sha-<커밋해시> 태그로 바꾼 뒤
docker compose up -d backend   # 또는 frontend
```

## 포트 제한 우회 (Cloudflare Tunnel)

이 서버는 **인바운드 포트를 하나도 열지 않는다.** `cloudflared` 컨테이너가 서버 → Cloudflare 엣지로
나가는 **아웃바운드 연결만** 맺고, 그 연결을 거꾸로 타고 들어온 요청을 `frontend`/`minio`
컨테이너로 넘긴다. 기업/기관 방화벽이 인바운드를 전부 막아도, 아웃바운드 한 포트만 열려 있으면
동작하는 구조다.

- **필요한 포트는 443이 아니라 TCP/UDP 7844다.** `cloudflared`는 엣지 연결에 기본적으로
  QUIC(UDP/7844)을 쓰고, 안 되면 HTTP/2(TCP/7844)로 자동 폴백한다. 443은 자동 업데이트 확인 등
  *선택* 기능에만 쓰이고 터널 자체 동작에는 필요 없다
  ([Cloudflare 공식 문서](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)).
- 기관망은 UDP 아웃바운드를 막는 경우가 흔하다. `compose.yaml`의 `cloudflared` 서비스는
  `TUNNEL_TRANSPORT_PROTOCOL: http2`로 **TCP 7844만** 쓰도록 고정해 두었다 — UDP가 전부 막혀 있어도
  TCP 7844만 열려 있으면 동작한다.
- 배포 전에 서버에서 아웃바운드가 열려 있는지 먼저 확인한다:
  ```sh
  nc -vz region1.v2.argotunnel.com 7844
  nc -vz region2.v2.argotunnel.com 7844
  ```
  둘 다 실패하면(TCP/UDP 모두 막힘) 이 구성 자체가 동작할 수 없다 — 망 관리자에게
  `region1.v2.argotunnel.com` / `region2.v2.argotunnel.com` 아웃바운드 TCP 7844 허용을 요청해야 한다.
- 배포 후 확인: `docker compose logs cloudflared`에 `Registered tunnel connection`이 여러 건 보이고
  `protocol=http2`로 찍히면 정상이다.
- 서버 바깥에서 8080/9000으로 직접 접근이 막혀 있는지도 확인한다(둘 다 실패해야 정상):
  ```sh
  nc -vz <서버IP> 8080
  nc -vz <서버IP> 9000
  ```

## 이미지가 올라오는 경로

`backend`, `frontend` 이미지는 이 저장소가 아니라 각 앱 저장소의 CI가 만든다.

- `memorIN-backend`: `main` 브랜치 푸시(=release PR 머지) 시
  `.github/workflows/ci.yml`의 `image` job이 `build`/`migrations` job을 모두 통과한 커밋만
  `ghcr.io/inu-appcenter/memorin-backend`로 푸시한다.
- `memorIN-frontend`: `main` 브랜치 푸시 시 `.github/workflows/ci.yml`의 `image` job이
  `ghcr.io/inu-appcenter/memorin-frontend`로 푸시한다.

두 저장소 모두 `latest` 태그와 `sha-<커밋해시>` 불변 태그를 함께 민다. 평소엔 `latest`를 쓰고,
문제가 생기면 직전 `sha-...` 태그로 `BACKEND_TAG`/`FRONTEND_TAG`를 고정해 롤백한다.

## 로컬 개발과의 차이

로컬 개발은 이 저장소가 아니라 `memorIN-backend`의 `docker-compose.yml`을 쓴다
(소스에서 직접 빌드, pgAdmin 포함, 포트가 호스트에 그대로 열림). 이 저장소는 운영 전용이며
pgAdmin을 포함하지 않는다 — 운영 DB에 접속해야 하면 SSH 터널 + DBeaver를 쓴다
(`memorIN-backend/docs/pgadmin-onboarding-grant-guide.md` 참고, 접속 정보는 로컬 기준이지만
호스트 대신 SSH 터널을 거치는 절차는 동일하다).

## 라이선스

이 저장소의 배포 설정은 [MIT License](LICENSE)를 따른다. Copyright (c) 2026 INU AppCenter.

- 애플리케이션 코드는 각 저장소의 라이선스를 따른다: `memorIN-backend`는 AGPL-3.0, `memorIN-frontend`는 MIT.
- 이 구성이 받아 쓰는 외부 이미지(PostgreSQL, MinIO, cloudflared 등)는 각자의 라이선스를 따른다.
