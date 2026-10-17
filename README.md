# 나의 메모

비밀번호로 잠긴 개인 주간 메모장 — https://juno99zz-arkt.github.io/memo-app/

- **한 주 = 메모장 하나**: 흰 화면에 텍스트 창 하나. 입력을 멈추면 자동 저장
- **상태 집계**: 줄 앞에 `준비` `진행` `완료` `보류`(또는 `- [ ]` `- [/]` `- [x]` `- [-]`)를 쓰면 메모장 아래에 개수 표시
- **월요일 05:00**: 새 메모장이 열리고, 지난주의 준비·진행 줄이 새 메모장 맨 위로 이월
- **지난 메모장**: 아래 목록에서 열어 보기·수정, 옵시디언으로 보내기(`obsidian://`) / .md 저장 / 요약 복사(한 줄 26자 이내)
- **스마트폰 앱**: PWA — 아이폰 Safari 공유→홈 화면에 추가 / 안드로이드 Chrome ⋮→앱 설치
- **보안**: 브라우저에서 PBKDF2(60만 회)+AES-256-GCM 암호화 후 `vault.json`(main)에 저장 — 저장소에는 암호문만 올라감. 비밀번호를 잊으면 복구 불가.
- **처음 설정**: GitHub → Settings → Developer settings → Fine-grained token → 이 저장소만, Contents: Read and write → 첫 화면의 토큰 칸에 입력 (토큰도 암호화되어 저장, 다른 기기에서는 비밀번호만 입력)

## 파일
- `index.html` 앱 전체 (단일 파일, 외부 라이브러리 없음)
- `vault.json` 암호화된 메모 (앱이 GitHub API로 직접 읽고 씀)
- `sw.js` 오프라인용 서비스 워커, `manifest.webmanifest` 앱 설치 정보
- `.github/workflows/pages.yml` 앱 변경 시 gh-pages 배포
