#!/usr/bin/env bash
# release.env의 형식과, 적힌 이미지 태그가 GHCR에 실제로 있는지 검사한다.
# CI(PR)와 배포 job이 함께 쓴다. 로그인 없이 공개 이미지만 조회한다.
set -euo pipefail

file="${1:-release.env}"
declare -A repo=([BACKEND_TAG]=memorin-backend [FRONTEND_TAG]=memorin-frontend)
fail=0

for key in BACKEND_TAG FRONTEND_TAG; do
  lines=$(grep -cE "^${key}=" "$file" || true)
  if [ "$lines" != "1" ]; then
    echo "::error file=$file::$key 줄이 정확히 1개여야 합니다(현재 $lines개)"
    fail=1
    continue
  fi
  tag=$(grep -E "^${key}=" "$file" | cut -d= -f2-)
  if [[ ! "$tag" =~ ^sha-[0-9a-f]{40}$ ]]; then
    echo "::error file=$file::$key=$tag — sha-<커밋 해시 40자> 형식이어야 합니다"
    fail=1
    continue
  fi
  image="inu-appcenter/${repo[$key]}"
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:${image}:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/')
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/${image}/manifests/${tag}")
  if [ "$code" = "200" ]; then
    echo "OK: ghcr.io/${image}:${tag}"
  else
    echo "::error file=$file::ghcr.io/${image}:${tag} 를 찾을 수 없습니다(HTTP $code). 이미지 빌드가 끝났는지 확인합니다"
    fail=1
  fi
done

exit "$fail"
