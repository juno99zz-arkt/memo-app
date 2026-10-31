# 나의 메모

비밀번호로 잠긴 개인 주간 메모장 — https://juno99zz-arkt.github.io/memo-app/

- **한 주 = 메모장 하나, 칸 둘**: 위는 작은 **To do**, 아래는 큰 **Inbox**. 입력을 멈추면 자동 저장
- **상태 집계**: 줄 앞에 `준비` `진행` `완료` `보류`(또는 `- [ ]` `- [/]` `- [x]` `- [-]`)를 쓰면 메모장 아래에 개수 표시 (To do·Inbox 합산)
- **월요일 05:00**: 새 메모장이 열리고, 지난주의 준비·진행 줄이 새 To do 맨 위로 이월
- **지난 메모장**: 아래 목록에서 열어 보기·수정, 옵시디언으로 보내기(`obsidian://`) / .md 저장 / 요약 복사(한 줄 26자 이내)
- **옵시디언 자동 보관**: Actions가 비공개 옵시디언 저장소에 커밋 — **매주 일요일 07:00(KST) 이번 주 To do를 `To do.md`로 갱신** (주별 노트 자동 보관은 2026-10-31 중단, 지난 메모장은 앱에서 직접 보내기) → 옵시디언의 Obsidian Git 플러그인이 받아옴 (아래 설정 참고)
- **Google 로그인**: 메모를 푸는 열쇠를 내 Google 드라이브의 숨김 앱 폴더(`appDataFolder`)에 보관하고, Google 로그인으로 꺼내 연다. 비밀번호는 복구용·옵시디언 자동 보관용으로 유지 (아래 설정 참고)
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

`To do.md`는 매주 덮어쓰는 노트 한 장입니다(본문은 옵시디언에서 직접 고치지 마세요).
옵시디언/정리 루틴이 노트에 붙인 속성(`보안`, 고친 `tags` 등)은 다시 쓸 때도 보존하고, 앱에서 안 고친 주의 노트는 건드리지 않습니다(`memo-hash`로 판단). 주별 노트는 To do가 없는 주는 예전 형식 그대로 유지됩니다.
노트 폴더는 앱 설정의 옵시디언 폴더(기본 `2. Area of Responsibility/주간 메모`)를 따름. 이미 보관된 주도 앱에서 고치면 다음 실행 때 갱신됨.
비밀번호는 GitHub 시크릿(암호화 보관)에 맡겨지고, 풀린 노트는 비공개 저장소에만 올라감.

## Google 로그인 설정 (한 번만)
1. https://console.cloud.google.com → 새 프로젝트
2. API 및 서비스 → 라이브러리 → **Google Drive API** 사용 설정
3. OAuth 동의 화면(Google Auth Platform): 외부 → 앱 이름·이메일 입력 → 범위에 `drive.appdata`(+ `openid`, `email`) 추가 → 테스트 사용자에 본인 Gmail 추가 (`drive.appdata`는 민감하지 않은 범위라 **앱 게시**해도 심사 없음)
4. 사용자 인증 정보 → OAuth 클라이언트 ID → **웹 애플리케이션** → 승인된 자바스크립트 원본: `https://juno99zz-arkt.github.io`
5. 클라이언트 ID(`…apps.googleusercontent.com`, 공개값)를 `index.html`의 `DEFAULT_CFG.googleClientId`에 넣거나 앱 잠금 화면의 「Google 로그인 설정」에 입력
6. 비밀번호로 열고 → ⚙ 설정 → **Google 계정에 연결**

동작: 열쇠(비밀번호+salt로 만든 AES 키)를 Drive 앱 폴더 `memo-key.json`에 저장. 비밀번호를 바꾸면 열쇠도 함께 갱신. 연결 해제 시 그 파일 삭제.

## NOJI캘린더 ⇄ 구글 캘린더 · 옵시디언 홈 → NOJI 매일 동기화 (`noji-sync.yml`)
매일 04:37(KST, GitHub 예약이라 늦어질 수 있음) PC 없이 실행. 내 구글 계정 권한(리프레시 토큰)으로 동작해 알림(전날 09:00, 부동산·세금·지출은 7일 전 09:00 추가)이 내 캘린더에 그대로 적용된다.
1. **NOJI → 구글**: NOJI 일정을 개인 캘린더에 `[분류] 제목` + 설명 "NOJI캘린더에서 관리"로 만들고 고친다. NOJI에서 지우면 구글에서도 지운다. 음력 반복은 올해·내년 회차, 매월 29~31일 반복은 말일로.
2. **구글 → NOJI**: 가족 캘린더 일정 전부 + 개인 캘린더의 반복 아닌 일정을 가져온다(분류 없으면 개인=회사·확인 필요, 가족=가족·확정. 시간·장소는 메모로). 가져온 일정은 원본과 제목·날짜를 서로 맞춘다(원본 설명·알림·색은 그대로). NOJI가 담지 못하는 반복(매주 등)은 건너뜀. NOJI에 이미 있는 같은 일정은 중복으로 만들지 않음.
3. **옵시디언 → NOJI**: `00. 홈.md`의 '다가오는 기한' 표에서 날짜가 정확한 항목만(11/3, 12/12~12/20, ~12/15 …). 구분 → 상태, 기준 노트 → 출처. 다른 노트 본문은 읽지 않음. 한 번 본 항목은 NOJI에서 지워도 다시 가져오지 않음.
- 양쪽에서 고치면 나중에 고친 쪽(같은 날이면 NOJI). 구글에서 NOJI 일정을 지워도 NOJI는 유지(다음 동기화 때 다시 생김). NOJI에서 지운 '구글에서 가져온 일정'은 구글 원본을 남기고 다시 가져오지 않음.
- 마지막 동기화 상태는 NOJI `users/{uid}/sync/state` 문서(NOJI 앱은 쓰지 않음). 첫 실행 때 예전에 만든 NOJI 일정은 이어받고, 짝이 없는 예전 일정은 지우지 않고 보고만.
- 바뀐 일정은 옵시디언 `Inbox_Squedule/YYYYMMDD-HHMM-NOJI-변경.md`에 메타데이터만(`보안: 개인정보`, 메모 본문 제외). 첫 연결 때는 기록하지 않음.
- 시크릿: `NOJI_CLIENT_ID`, `NOJI_CLIENT_SECRET`, `NOJI_REFRESH_TOKEN`(범위 `calendar.events`, `datastore`), `OBSIDIAN_TOKEN`
- 처음엔 Actions → NOJI 캘린더 동기화 → Run workflow에서 「미리보기」를 체크해 무엇이 바뀔지 먼저 확인
