# memorIN-deploy 기여 안내

## 이슈와 진행판 (memorIN 저장소 3개 공통)
- 작업 요청과 결정은 이슈로 남기고, 채팅에서는 이슈 링크를 함께 붙입니다.
  - 여러 저장소에 걸친 일과 서버·운영 일은 이 저장소에 엽니다.
- 이슈는 양식(버그 신고, 기능 요청, 작업 요청)으로만 열 수 있습니다. 양식에서 고른 우선순위와 종류가 진행판에 자동으로 들어갑니다.

  | 우선순위 | 기준 | 처리 기한 |
  |---|---|---|
  | P0 긴급 | 서비스 중단, 보안 사고, 데이터 손실 | 당일 |
  | P1 높음 | 공개를 막는 문제, 주요 기능 오류 | 이번 주 |
  | P2 보통 | 이번 마일스톤 안에 할 일 | 마일스톤 |
  | P3 낮음 | 여유 있을 때 | - |

- 진행판(조직 Projects "memorIN 진행판")의 칸은 아래처럼 자동으로 옮겨집니다.
  - 이슈 번호를 넣은 브랜치를 올리면(`fix/347-설명` 또는 이슈 화면의 "Create a branch") "진행 중"
  - PR 본문에 `Closes #번호`를 적고 PR을 열면 "리뷰 중", 수정 요청 리뷰를 받으면 다시 "진행 중"
  - 이슈가 닫히면 "완료"
- 규칙은 `.github/scripts/project-sync.mjs`, 토큰 설정은 `.github/workflows/project-sync.yml` 맨 위 설명에 있습니다. backend와 frontend는 이 저장소의 공용 워크플로를 호출합니다.

## 브랜치와 PR
- `main`에서 브랜치를 만들어 `main`으로 PR을 올리고, merge commit으로 병합합니다.
- `main`은 직접 푸시, force push, 삭제가 막혀 있고, 병합된 브랜치는 자동으로 삭제됩니다.
- PR 제목: `<type>: <설명>`
  - type: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`
- 현재 병합에 필요한 승인 수는 0명입니다. <!-- 결정 필요: 승인 필수 인원 -->
- 커밋 메시지와 PR 본문에 도구가 자동으로 붙이는 서명·꼬리말은 넣지 않습니다(커밋·본문 서명 검사가 막습니다).
- PR에서 도는 검사: compose 설정 검사, 배포 버전 검사, 진행판 규칙 시험, PR 제목 컨벤션 검사, 커밋·본문 서명 검사
- `release.env`, `compose.yaml`, `infra/`를 바꾼 PR은 병합하는 즉시 운영 서버에 배포됩니다(README '자동 배포').

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
