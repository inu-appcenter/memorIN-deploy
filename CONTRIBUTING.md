# memorIN-deploy 기여 안내

## 브랜치와 PR
- `main`에서 브랜치를 만들어 `main`으로 PR을 올리고, merge commit으로 병합합니다.
- `main`은 직접 푸시, force push, 삭제가 막혀 있고, 병합된 브랜치는 자동으로 삭제됩니다.
- PR 제목: `<type>: <설명>`
  - type: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`
- 현재 병합에 필요한 승인 수는 0명입니다. <!-- 결정 필요: 승인 필수 인원 -->
- 커밋 메시지와 PR 본문에 도구가 자동으로 붙이는 서명·꼬리말은 넣지 않습니다(커밋·본문 서명 검사가 막습니다).
- PR에서 도는 검사: compose 설정 검사, PR 제목 컨벤션 검사, 커밋·본문 서명 검사

## 바꾸기 전에 확인할 것
- `compose.yaml`을 바꿨으면 CI와 같은 방법으로 설정 검사를 돌립니다. 아래 비밀값은 검사용 임시 값입니다.

  ```bash
  POSTGRES_PASSWORD=ci-dummy MINIO_ROOT_USER=ci-dummy MINIO_ROOT_PASSWORD=ci-dummy JWT_SECRET=ci-dummy \
  FRONTEND_PORT=18000 MINIO_S3_PORT=18001 \
  docker compose --env-file .env.example config -q
  ```

- backend나 frontend에 환경변수가 새로 생기면 `compose.yaml`과 `.env.example`을 함께 갱신합니다.
  - `compose.yaml`이 넘기지 않은 값은 `.env`에 적어도 반영되지 않습니다.
- 외부 이미지(Silo)는 태그와 digest를 함께 고정하고, 올릴 때도 둘을 함께 바꿉니다.
- Dependabot이 매주 월요일 09:00(KST)에 외부 이미지(postgres, Silo) 묶음 PR을 올립니다.
  - PostgreSQL 메이저 업그레이드는 데이터 이전(pg_upgrade 또는 덤프·복원)이 필요해 받지 않습니다.

## 공개 저장소 주의
- `.env`, `secrets/` 안의 파일, DB 백업 덤프는 커밋하지 않습니다. `git add -f`도 쓰지 않습니다.
- 서버 접속 정보, 계정, 토큰, `.env` 값은 이슈와 코멘트에도 적지 않습니다.
- 보안 문제 제보는 [SECURITY.md](SECURITY.md)를 봅니다.
