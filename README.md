# 나의 메모

비밀번호로 잠긴 개인 주간 메모장 — https://juno99zz-arkt.github.io/memo-app/

- **기본 포맷**: 제목 · 분류 · 항목(상태 칩: 준비→진행→완료→보류) · 자유 메모
- **주 단위 축적**: ISO 주(월~일)별로 쌓임, ‹ › 또는 목록으로 지난 주 열람
- **주간 정리**: 완료/진행/준비/보류별 묶음, 완료율, 공유용 요약 복사(한 줄 26자 이내)
- **자동 마감**: 새 주에 앱을 열면 지난 주를 마감하고 미완료(준비·진행) 항목을 다음 주 `이월 항목` 메모로 옮김 (설정에서 끔)
- **보안**: 브라우저에서 PBKDF2(60만 회)+AES-256-GCM 암호화 후 `vault.json`(main)에 저장 — 저장소에는 암호문만 올라감. 비밀번호를 잊으면 복구 불가.
- **처음 설정**: GitHub → Settings → Developer settings → Fine-grained token → 이 저장소만, Contents: Read and write → 첫 화면의 토큰 칸에 입력 (토큰도 암호화되어 저장, 다른 기기에서는 비밀번호만 입력)

## 파일
- `index.html` 앱 전체 (단일 파일, 외부 라이브러리 없음)
- `vault.json` 암호화된 메모 (앱이 GitHub API로 직접 읽고 씀)
- `.github/workflows/pages.yml` 앱 변경 시 gh-pages 배포
