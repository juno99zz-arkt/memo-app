// NOJI캘린더(Firestore) → 구글 캘린더 매일 동기화 + 바뀐 일정은 옵시디언 Inbox_Squedule에 기록
// GitHub Actions에서 실행. 내 구글 계정 권한(리프레시 토큰)으로 동작하므로 PC가 꺼져 있어도 되고,
// 알림(전날 09:00 · 7일 전 09:00)도 내 캘린더에 그대로 적용된다.
//
// 사용: NOJI_CLIENT_ID=… NOJI_CLIENT_SECRET=… NOJI_REFRESH_TOKEN=… node scripts/noji-sync.mjs [--dry-run] [옵시디언 저장소 폴더]
//   --dry-run : 무엇을 바꿀지 출력만 하고 캘린더·옵시디언은 건드리지 않음
//
// 동기화 규칙
//   - 원본은 NOJI. 구글 캘린더 쪽은 NOJI가 관리하는 일정(설명에 "NOJI캘린더에서 관리")만 만들고·고치고·지운다.
//   - 처음 실행 때 예전에 만들어 둔 NOJI 일정(표시 없는 것)은 제목·날짜로 짝을 찾아 이어받는다. 짝이 없는 예전 일정은 지우지 않고 보고만 한다.
//   - 옵시디언에는 일정 메타데이터(변경 종류·날짜·분류·제목·상태·ID·원본 수정일)만 남긴다. 메모 본문은 옮기지 않는다(볼트 보안 규칙).
//   - 첫 실행(이어받기)에는 옵시디언 기록을 남기지 않는다(최초 연결 이전 이력은 일괄 수집하지 않는다).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2), DRY = argv.includes('--dry-run'), outRoot = argv.find(a => !a.startsWith('--'));
const { NOJI_CLIENT_ID, NOJI_CLIENT_SECRET, NOJI_REFRESH_TOKEN } = process.env;
if (!NOJI_CLIENT_ID || !NOJI_CLIENT_SECRET || !NOJI_REFRESH_TOKEN) { console.error('NOJI_CLIENT_ID / NOJI_CLIENT_SECRET / NOJI_REFRESH_TOKEN 시크릿이 필요합니다'); process.exit(2); }

const PROJECT = 'chaenggim-calendar', DATA_UID = 'hsglp2oy1jexIRllxsOeC8Fb2582', CAL = 'primary';
const APP_URL = 'https://juno99zz-arkt.github.io/chaenggim-calendar/', MARK = 'NOJI캘린더에서 관리';
const TOKEN_URL = process.env.TOKEN_URL || 'https://oauth2.googleapis.com/token';                       // 테스트용으로만 바꿈
const FS_BASE = process.env.FS_BASE || 'https://firestore.googleapis.com/v1';
const CAL_BASE = process.env.CAL_BASE || 'https://www.googleapis.com/calendar/v3';

// NOJI 앱(index.html)과 같은 분류·상태. 색·알림은 지금까지 구글 캘린더에 만들어 둔 NOJI 일정과 같게.
const CATS = { family: { short: '가족', color: '4', remind: [900] }, estate: { short: '부동산·세금', color: '2', remind: [900, 9540] },
               expense: { short: '지출', color: '5', remind: [900, 9540] }, work: { short: '회사', color: '9', remind: [900] } };   // 900분 = 전날 09:00, 9540분 = 7일 전 09:00 (종일 일정 기준)
const STATUS = { 확정: '확정', 목표: '내부 목표', 예상: '예상', 확인필요: '확인 필요' };

/* ───── 날짜 (TZ=Asia/Seoul) ───── */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const TODAY = iso(new Date());

/* ───── 음력 (NOJI와 같은 korean-lunar-calendar) ───── */
let KLC = null;
try { const KoreanLunarCalendar = createRequire(import.meta.url)('korean-lunar-calendar'); KLC = new KoreanLunarCalendar(); } catch { /* 음력 일정이 있을 때만 필요 */ }
function lunarToSolar(y, m, d) {   // NOJI와 같이: 30일이 없는 달이면 29일, 반복 회차는 평달 기준
  for (let dd = d; dd >= Math.max(1, d - 1); dd--) {
    if (!KLC.setLunarDate(y, m, dd, false)) continue;
    const s = KLC.getSolarCalendar(); KLC.setSolarDate(s.year, s.month, s.day); const l = KLC.getLunarCalendar();
    if (l.month === m && l.day === dd && !l.intercalation) return `${s.year}-${pad(s.month)}-${pad(s.day)}`;
  }
  return null;
}

/* ───── HTTP ───── */
async function getToken() {
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: NOJI_CLIENT_ID, client_secret: NOJI_CLIENT_SECRET, refresh_token: NOJI_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`구글 인증 실패 (${r.status} ${j.error || ''}) — 리프레시 토큰이 만료·취소됐으면 다시 발급해 NOJI_REFRESH_TOKEN을 바꿔 주세요`);
  return j.access_token;
}
let TOKEN = '';
async function api(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  if (r.status === 204 || r.status === 410) return null;   // 삭제 완료 / 이미 삭제됨
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${opt.method || 'GET'} ${url.split('?')[0].replace(/^https:\/\/[^/]+/, '')} → ${r.status} ${j.error?.message || ''}`);
  return j;
}

/* ───── NOJI(Firestore) 읽기 ───── */
const fsVal = v => 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? Number(v.integerValue)
  : 'doubleValue' in v ? v.doubleValue : 'timestampValue' in v ? v.timestampValue : 'mapValue' in v ? fsObj(v.mapValue.fields || {})
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(fsVal) : null;
const fsObj = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, fsVal(v)]));
async function readNoji() {
  const out = []; let page = '';
  do {
    const j = await api(`${FS_BASE}/projects/${PROJECT}/databases/(default)/documents/users/${DATA_UID}/events?pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
    for (const d of j.documents || []) out.push({ id: d.name.split('/').pop(), ...fsObj(d.fields || {}) });
    page = j.nextPageToken || '';
  } while (page);
  return out;
}

/* ───── NOJI 일정 → 구글 캘린더 일정(들) ───── */
function monthlyRule(day) {   // NOJI는 그달에 그 날짜가 없으면 말일로 당김 → 29~31일은 "그 날짜 이하 중 마지막 날"
  if (day <= 28) return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${day}`;
  return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${Array.from({ length: day - 27 }, (_, i) => 28 + i).join(',')};BYSETPOS=-1`;
}
function desiredFor(ev) {
  const c = CATS[ev.cat] || CATS.estate;
  if (!ev.title || !ev.date) return [];
  const st = ev.status && ev.status !== '확정' ? `[${STATUS[ev.status] || ev.status}] ` : '';
  const desc = [(st + (ev.memo || '')).trim(), ev.lunar && ev.lm ? `음력 ${ev.lm}.${ev.ld}${ev.leap ? '(윤)' : ''}` : '', ev.src ? `출처: ${ev.src}` : '', `${MARK} · ${APP_URL}`].filter(Boolean).join('\n');
  const base = { summary: `[${c.short}] ${ev.title}`, description: desc, colorId: c.color, transparency: 'transparent',
    reminders: { useDefault: false, overrides: c.remind.map(m => ({ method: 'popup', minutes: m })) } };
  const span = ev.end && ev.end > ev.date ? Math.round((parse(ev.end) - parse(ev.date)) / 864e5) : 0;
  const one = (start, extra = {}) => ({ ...base, start: { date: start }, end: { date: addDays(start, span + 1) }, ...extra });
  if (ev.lunar && ev.lm && ev.repeat === 'yearly') {   // 구글 캘린더는 음력 반복이 없어 올해·내년 회차를 따로 만든다
    if (!KLC) { console.warn(`  ! 음력 계산 모듈이 없어 건너뜀: ${ev.title}`); return []; }
    const y = Number(TODAY.slice(0, 4)), dates = [y - 1, y, y + 1].map(yy => lunarToSolar(yy, ev.lm, ev.ld)).filter(d => d && d >= ev.date && d >= addDays(TODAY, -7));
    return dates.map(d => ({ key: `${ev.id}_${d}`, occ: d, body: one(d) }));
  }
  if (ev.repeat === 'yearly') return [{ key: ev.id, body: one(ev.date, { recurrence: ['RRULE:FREQ=YEARLY'] }) }];
  if (ev.repeat === 'monthly') return [{ key: ev.id, body: one(ev.date, { recurrence: [monthlyRule(Number(ev.date.slice(8)))] }) }];
  return [{ key: ev.id, body: one(ev.date), old: addDays(ev.end && ev.end > ev.date ? ev.end : ev.date, 60) < TODAY }];
}

/* ───── 비교 ───── */
const sig = e => JSON.stringify([e.summary || '', (e.description || '').trim(), e.start?.date || e.start?.dateTime || '', e.end?.date || e.end?.dateTime || '',
  (e.recurrence || []).join('|'), e.colorId || '', e.transparency || 'opaque',
  e.reminders?.useDefault ? 'default' : (e.reminders?.overrides || []).map(o => `${o.method}:${o.minutes}`).sort().join(',')]);

/* ───── 실행 ───── */
TOKEN = await getToken();
const noji = await readNoji();
const nojiById = new Map(noji.map(e => [e.id, e]));

// 구글 캘린더의 NOJI 일정: 표시(extendedProperties)가 붙은 것 + 예전에 만든 것(설명에 MARK만 있는 것)
const listAll = async q => { const out = []; let page = ''; do { const j = await api(`${CAL_BASE}/calendars/${CAL}/events?${q}&maxResults=2500&showDeleted=false${page ? '&pageToken=' + encodeURIComponent(page) : ''}`); out.push(...(j.items || [])); page = j.nextPageToken || ''; } while (page); return out; };
const tagged = await listAll('privateExtendedProperty=noji%3D1');
const legacy = (await listAll(`q=${encodeURIComponent(MARK)}`)).filter(e => !e.extendedProperties?.private?.nojiKey && (e.description || '').includes(MARK) && !e.recurringEventId);
const byKey = new Map(tagged.map(e => [e.extendedProperties.private.nojiKey, e]));
const firstRun = tagged.length === 0;

const changes = [], plan = [], usedLegacy = new Set();
const tagOf = (ev, d) => ({ private: { noji: '1', nojiId: ev.id, nojiKey: d.key, ...(d.occ ? { nojiOcc: d.occ } : {}) } });
const metaOf = (ev, d) => ({ 날짜: d.occ || ev.date, 분류: (CATS[ev.cat] || CATS.estate).short, 제목: ev.title, 상태: STATUS[ev.status] || ev.status || '확정', id: ev.id, 수정: ev.updatedAt || '' });

for (const ev of noji) for (const d of desiredFor(ev)) {
  const cur = byKey.get(d.key);
  if (cur) {
    if (sig(cur) !== sig(d.body)) { plan.push({ op: 'patch', id: cur.id, body: { ...d.body, recurrence: d.body.recurrence || [] }, label: d.body.summary }); changes.push({ 변경: '변경', ...metaOf(ev, d) }); }
    byKey.delete(d.key); continue;
  }
  // 예전에 만들어 둔 일정 이어받기: 같은 제목 + 같은 시작일(반복 일정은 같은 제목이면 시작일이 달라도)
  const old = legacy.find(e => !usedLegacy.has(e.id) && e.summary === d.body.summary && (e.start?.date === d.body.start.date || (d.body.recurrence && e.recurrence)));
  if (old) {
    usedLegacy.add(old.id);
    plan.push({ op: 'patch', id: old.id, body: { ...d.body, recurrence: d.body.recurrence || [], extendedProperties: tagOf(ev, d) }, label: `${d.body.summary} (이어받기)` });
    if (!firstRun && sig(old) !== sig(d.body)) changes.push({ 변경: '변경', ...metaOf(ev, d) });
    continue;
  }
  if (d.old) continue;   // 두 달 넘게 지난 일회성 일정은 새로 만들지 않음
  plan.push({ op: 'insert', body: { ...d.body, extendedProperties: tagOf(ev, d) }, label: d.body.summary });
  if (!firstRun) changes.push({ 변경: '추가', ...metaOf(ev, d) });
}
// 남은 표시 일정: NOJI에서 지워졌거나(전부) 음력 회차가 바뀜(앞으로의 회차만) → 삭제
for (const [key, e] of byKey) {
  const p = e.extendedProperties.private, ev = nojiById.get(p.nojiId);
  if (ev && p.nojiOcc && p.nojiOcc < TODAY) continue;   // 지난 음력 회차는 기록으로 둠
  plan.push({ op: 'delete', id: e.id, label: e.summary });
  changes.push({ 변경: '삭제', 날짜: p.nojiOcc || e.start?.date || '', 분류: (e.summary.match(/^\[([^\]]+)\]/) || [])[1] || '', 제목: e.summary.replace(/^\[[^\]]+\]\s*/, ''), 상태: '', id: p.nojiId, 수정: '' });
}
const orphans = legacy.filter(e => !usedLegacy.has(e.id));

console.log(`NOJI 일정 ${noji.length}개 · 캘린더의 NOJI 일정 ${tagged.length}개(+예전 ${legacy.length}개) · ${firstRun ? '첫 연결(이어받기)' : '정기 동기화'}${DRY ? ' · 미리보기(--dry-run)' : ''}`);
for (const x of plan) console.log(`  ${{ insert: '추가', patch: '수정', delete: '삭제' }[x.op]}: ${x.label}`);
if (!plan.length) console.log('  바뀐 일정 없음');
if (orphans.length) console.log(`  ! NOJI에서 짝을 못 찾은 예전 캘린더 일정 ${orphans.length}개(지우지 않음): ${orphans.map(e => e.summary).join(' / ')}`);

if (!DRY) {
  for (const x of plan) {
    const u = `${CAL_BASE}/calendars/${CAL}/events${x.id ? '/' + encodeURIComponent(x.id) : ''}`;
    if (x.op === 'insert') await api(u, { method: 'POST', body: JSON.stringify(x.body) });
    if (x.op === 'patch') await api(u, { method: 'PATCH', body: JSON.stringify(x.body) });
    if (x.op === 'delete') await api(u, { method: 'DELETE' });
  }
  // 옵시디언: 바뀐 일정 메타데이터만 Inbox_Squedule에 (첫 연결 때는 남기지 않음)
  if (outRoot && changes.length) {
    const now = new Date(), stamp = `${iso(now).replace(/-/g, '')}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
    const body = ['---', '보안: 개인정보', '원본: AI 초안', 'source: NOJI캘린더 자동 동기화', `수집: ${iso(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`, '---', '',
      `# NOJI 일정 변경 ${iso(now)}`, '', `NOJI캘린더 원본에서 바뀐 일정을 구글 캘린더에 반영했습니다. 메모 등 세부 내용은 [NOJI캘린더](${APP_URL})에서 확인하세요.`, '',
      '| 변경 | 날짜 | 분류 | 제목 | 상태 | NOJI ID | 원본 수정일 |', '|---|---|---|---|---|---|---|',
      ...changes.map(c => `| ${c.변경} | ${c.날짜} | ${cell(c.분류)} | ${cell(c.제목)} | ${cell(c.상태)} | ${c.id} | ${c.수정} |`), ''];
    mkdirSync(join(outRoot, 'Inbox_Squedule'), { recursive: true });
    writeFileSync(join(outRoot, 'Inbox_Squedule', `${stamp}-NOJI-변경.md`), body.join('\n'));
    console.log(`옵시디언 기록: Inbox_Squedule/${stamp}-NOJI-변경.md (${changes.length}건)`);
  }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, [`### NOJI → 구글 캘린더 ${DRY ? '(미리보기)' : ''}`, `NOJI ${noji.length}개 · 반영 ${plan.length}건${firstRun ? ' (첫 연결)' : ''}`, '',
    ...plan.map(x => `- ${{ insert: '추가', patch: '수정', delete: '삭제' }[x.op]}: ${x.label}`),
    ...(orphans.length ? ['', `**NOJI에서 짝을 못 찾은 예전 캘린더 일정 ${orphans.length}개** (지우지 않음, 필요 없으면 캘린더에서 직접 삭제)`, ...orphans.map(e => `- ${e.summary} (${e.start?.date || ''})`)] : [])].join('\n') + '\n', { flag: 'a' });
}
