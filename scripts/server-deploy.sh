#!/usr/bin/env bash
# 운영 서버 배포 스크립트. GitHub Actions의 배포 job이 SSH로 이 스크립트만 실행한다.
#
# 설치(서버, 한 번): README '자동 배포 > 서버 준비'를 따른다.
#   install -m 700 scripts/server-deploy.sh ~/bin/memorin-deploy.sh
# 저장소 안의 이 파일을 직접 실행하지 않고 복사본을 쓴다. 저장소가 바뀌어도 서버에서 실행되는 코드는
# 사람이 다시 설치할 때만 바뀌게 하려는 것이다.
#
# 공개 저장소라 Actions 로그는 누구나 본다. 화면에는 단계와 결과만 내고, 자세한 내용은
# 서버의 ~/memorin-deploy.log에만 남긴다.
set -euo pipefail

DEPLOY_DIR="${MEMORIN_DEPLOY_DIR:-$HOME/memorIN-deploy}"
BACKUP_DIR="${MEMORIN_BACKUP_DIR:-$HOME/memorin-backups}"
LOG="$HOME/memorin-deploy.log"
HEALTH_TIMEOUT=240

# 백업 덤프와 로그에는 개인정보가 들어가므로 이 둘만 본인만 읽게 만든다.
# umask를 스크립트 전체에 걸면 아래 git merge가 갱신하는 저장소 파일도 600이 되어,
# postgres 컨테이너(postgres 계정)가 infra/postgres/postgresql.conf를 읽지 못하고 기동에 실패한다.
(umask 077 && touch "$LOG") && chmod 600 "$LOG"

say() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }
die() { say "실패: $*"; exit 1; }

exec 9>"$HOME/.memorin-deploy.lock"
flock -n 9 || die "다른 배포가 진행 중"

# SSH로 넘어온 명령은 "deploy <커밋 해시>"만 받는다(authorized_keys의 command=가 이 스크립트를 강제한다).
read -r action expected <<<"${SSH_ORIGINAL_COMMAND:-deploy}"
[ "$action" = "deploy" ] || die "알 수 없는 명령"
if [ -n "${expected:-}" ] && [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then die "커밋 해시 형식 오류"; fi

cd "$DEPLOY_DIR" || die "배포 디렉터리 없음"
say "배포 시작"

# 1. 저장소를 main으로 맞춘다. 서버에서 손으로 고친 추적 파일이 있으면 멈춘다.
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "서버 저장소에 로컬 수정이 있음(git status 확인)"
git fetch -q origin main >>"$LOG" 2>&1 || die "git fetch 실패"
git merge -q --ff-only origin/main >>"$LOG" 2>&1 || die "main으로 fast-forward 불가"
if [ -n "${expected:-}" ]; then
  git merge-base --is-ancestor "$expected" HEAD 2>/dev/null || die "요청한 커밋이 서버 저장소에 없음"
fi
say "저장소: $(git rev-parse --short HEAD)"

# 2. release.env를 읽어 검사하고 .env의 태그 줄에 반영한다.
#    .env에 반영해 두어야 사람이 손으로 docker compose를 실행해도 같은 버전이 뜬다.
declare -A tags
for key in BACKEND_TAG FRONTEND_TAG; do
  val=$(grep -E "^${key}=" release.env | tail -1 | cut -d= -f2- || true)
  [[ "$val" =~ ^sha-[0-9a-f]{40}$ ]] || die "release.env의 $key 형식 오류"
  tags[$key]=$val
done
cp -p .env "$HOME/.memorin-env.bak"
for key in BACKEND_TAG FRONTEND_TAG; do
  if grep -qE "^${key}=" .env; then
    sed -i -E "s|^${key}=.*|${key}=${tags[$key]}|" .env
  else
    printf '%s=%s\n' "$key" "${tags[$key]}" >>.env
  fi
done
say "버전: backend ${tags[BACKEND_TAG]:4:7}, frontend ${tags[FRONTEND_TAG]:4:7}"

docker compose config -q >>"$LOG" 2>&1 || { cp -p "$HOME/.memorin-env.bak" .env; die "compose 설정 검사 실패(.env 원복함)"; }

# 3. 배포 직전 DB 백업. backend가 기동하면서 Flyway 마이그레이션을 적용하므로 되돌릴 지점을 남긴다.
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
pg_user=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || true); pg_db=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- || true)
dump="$BACKUP_DIR/pre-deploy-$(date +%Y%m%d-%H%M%S).dump"
if (umask 077 && docker compose exec -T postgres pg_dump -U "${pg_user:-memorin_user}" -Fc "${pg_db:-memorin_db}" >"$dump") 2>>"$LOG"; then
  say "DB 백업 완료"
  ls -1t "$BACKUP_DIR"/pre-deploy-*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f   # 직전 10개만 보관
else
  rm -f "$dump"; die "DB 백업 실패(배포 중단)"
fi

# 4. 이미지 받기와 갱신. 바뀐 서비스만 다시 만들어진다.
say "이미지 받는 중"
docker compose pull -q >>"$LOG" 2>&1 || die "이미지 pull 실패"
docker compose up -d >>"$LOG" 2>&1 || die "docker compose up 실패"

# 5. 헬스체크
say "헬스체크 대기(최대 ${HEALTH_TIMEOUT}초)"
port=$(grep -E '^FRONTEND_PORT=' .env | cut -d= -f2- || true)
[ -n "$port" ] || die ".env에 FRONTEND_PORT 없음"
deadline=$((SECONDS + HEALTH_TIMEOUT))
while :; do
  bad=""
  for c in memorin_postgres memorin_minio memorin_backend memorin_frontend; do
    st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)
    [ "$st" = "healthy" ] || bad="$bad $c:$st"
  done
  if [ -z "$bad" ] && curl -fsS -m 5 "http://127.0.0.1:${port}/api/health" >>"$LOG" 2>&1; then
    echo >>"$LOG"; say "배포 성공"
    exit 0
  fi
  [ "$SECONDS" -ge "$deadline" ] && die "헬스체크 시간 초과:$bad (서버의 ~/memorin-deploy.log와 docker compose logs 확인)"
  sleep 10
done
