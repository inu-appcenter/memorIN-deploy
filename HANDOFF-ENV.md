# 작업 환경 보고 (2026-10-23)

HANDOFF.md 작업 세션이 의존한 환경. 값은 적지 않는다.

## 기본 제공 도구
- Ubuntu 24.04(noble), git, python3, curl
- OpenJDK 21.0.11 (JDK 17 없음), Gradle wrapper 8.14.5
- Node v22.22.0, npm 10.9.4 (Node 보안 패치 전 버전)
- PostgreSQL 16 (`/usr/lib/postgresql/16`), Docker CLI(데몬 사용 불가)
- gh, gcloud, bq, gsutil

## 세션 중 설치
- apt: `nginx`, `nginx-common`, `gettext-base`(envsubst), 의존성 `iproute2`, `libbpf1`
- npx 일회 실행: `expo-doctor@1.20.4`
- 프로젝트 의존성: frontend `npm ci`, backend Gradle 의존성·wrapper 배포본

## 사용한 환경 변수 이름
- 네트워크: `HTTPS_PROXY`, `JAVA_TOOL_OPTIONS`(프록시·truststore)
- frontend 빌드·nginx: `BACKEND_ORIGIN`, `EXPO_PUBLIC_API_BASE_URL`, `CI`, `EXPO_NO_TELEMETRY`
- backend 로컬 실행: `SPRING_PROFILES_ACTIVE`, `SPRING_DATASOURCE_URL`, `SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `CORS_ALLOWED_ORIGINS`, `JWT_SECRET`, `SIGNUP_ENABLED`, `TZ`

## 접근한 외부 도메인
- GitHub: `github.com`, `api.github.com`, `raw.githubusercontent.com`, GitHub MCP 연동
- 이미지 레지스트리: `ghcr.io`, `auth.docker.io`, `registry-1.docker.io`, `hub.docker.com`
- 패키지: `registry.npmjs.org`, `repo.maven.apache.org`, `repo1.maven.org`, `services.gradle.org`, `archive.ubuntu.com`, `security.ubuntu.com`, `download.docker.com`
- 문서·취약점: `nodejs.org`, `spring.io`, `osv.dev`, 웹 검색
