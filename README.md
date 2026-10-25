# 나의 메모

비밀번호로 잠긴 개인 주간 메모장 — https://juno99zz-arkt.github.io/memo-app/

- **한 주 = 메모장 하나**: 흰 화면에 텍스트 창 하나. 입력을 멈추면 자동 저장
- **상태 집계**: 줄 앞에 `준비` `진행` `완료` `보류`(또는 `- [ ]` `- [/]` `- [x]` `- [-]`)를 쓰면 메모장 아래에 개수 표시
- **월요일 05:00**: 새 메모장이 열리고, 지난주의 준비·진행 줄이 새 메모장 맨 위로 이월
- **지난 메모장**: 아래 목록에서 열어 보기·수정, 옵시디언으로 보내기(`obsidian://`) / .md 저장 / 요약 복사(한 줄 26자 이내)
- **옵시디언 자동 보관**: 매주 월요일 05:00(KST) Actions가 지난 메모장들을 `.md` 노트로 만들어 비공개 옵시디언 저장소에 커밋 → 옵시디언의 Obsidian Git 플러그인이 받아옴 (아래 설정 참고)
- **스마트폰 앱**: PWA — 아이폰 Safari 공유→홈 화면에 추가 / 안드로이드 Chrome ⋮→앱 설치
- **보안**: 브라우저에서 PBKDF2(60만 회)+AES-256-GCM 암호화 후 `vault.json`(main)에 저장 — 저장소에는 암호문만 올라감. 비밀번호를 잊으면 복구 불가.
- **처음 설정**: GitHub → Settings → Developer settings → Fine-grained token → 이 저장소만, Contents: Read and write → 첫 화면의 토큰 칸에 입력 (토큰도 암호화되어 저장, 다른 기기에서는 비밀번호만 입력)

## 파일
- `index.html` 앱 전체 (단일 파일, 외부 라이브러리 없음)
- `vault.json` 암호화된 메모 (앱이 GitHub API로 직접 읽고 씀)
- `sw.js` 오프라인용 서비스 워커, `manifest.webmanifest` 앱 설치 정보
- `.github/workflows/pages.yml` 앱 변경 시 gh-pages 배포
- `.github/workflows/obsidian.yml` + `scripts/export-obsidian.mjs` 매주 옵시디언 보관

## 옵시디언 자동 보관 설정
1. 비공개 저장소 `obsidian-vault` (기존 보관함, 다른 이름이면 Variables에 `OBSIDIAN_REPO=owner/이름`)
2. Fine-grained 토큰: 그 저장소만, Contents: Read and write
3. memo-app → Settings → Secrets and variables → Actions → Secrets
   - `MEMO_PASSWORD`: 앱 비밀번호 (앱에서 비밀번호를 바꾸면 여기도 변경)
   - `OBSIDIAN_TOKEN`: 2번 토큰
4. 옵시디언: **Obsidian Git** 플러그인으로 그 저장소를 동기화 (자동 pull 켜기)
5. Actions → 옵시디언 자동 보관 → Run workflow 로 바로 확인

노트 폴더는 앱 설정의 옵시디언 폴더(기본 `2. Area of Responsibility/주간 메모`)를 따름. 이미 보관된 주도 앱에서 고치면 다음 실행 때 갱신됨.
비밀번호는 GitHub 시크릿(암호화 보관)에 맡겨지고, 풀린 노트는 비공개 저장소에만 올라감.
