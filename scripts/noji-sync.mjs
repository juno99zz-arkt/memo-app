// NOJI캘린더 ⇄ 구글 캘린더 양방향 동기화 + 옵시디언 홈 기한표 → NOJI, 바뀐 일정은 옵시디언 Inbox_Squedule에 기록
// GitHub Actions에서 매일 실행. 내 구글 계정 권한(리프레시 토큰)으로 동작하므로 PC가 꺼져 있어도 되고,
// 알림(전날 09:00 · 7일 전 09:00)도 내 캘린더에 그대로 적용된다.
//
// 사용: NOJI_CLIENT_ID=… NOJI_CLIENT_SECRET=… NOJI_REFRESH_TOKEN=… node scripts/noji-sync.mjs [--dry-run] [옵시디언 저장소 폴더]
//   --dry-run : 무엇을 바꿀지 출력만 하고 NOJI·캘린더·옵시디언은 건드리지 않음
//
// 동기화 규칙 (2026-10-31 사용자 결정)
//  1. NOJI → 구글: NOJI 일정은 개인 캘린더에 "[분류] 제목" + 설명 "NOJI캘린더에서 관리"로 만들고 고친다. NOJI에서 지우면 구글에서도 지운다.
//  2. 구글 → NOJI: 가족 캘린더 일정 전부 + 개인 캘린더의 반복 아닌 일정을 NOJI로 가져온다(분류 없으면 개인=회사·확인 필요, 가족=가족).
//     · 가져온 일정은 구글 원본과 제목·날짜를 서로 맞춘다(원본의 설명·알림·색은 건드리지 않음).
//     · NOJI에서 지우면 구글 원본은 그대로 두고 다시 가져오지 않는다.
//  3. 옵시디언 → NOJI: `00. 홈.md`의 '다가오는 기한' 표에서 날짜가 정확한 항목만 NOJI로 가져온다(다른 노트 본문은 읽지 않음).
//  · 양쪽에서 고친 경우 나중에 고친 쪽을 따른다(같은 날이면 NOJI 우선).
//  · 구글에서 NOJI 일정을 지워도 NOJI에서는 지우지 않는다(다음 동기화 때 다시 생김).
//  · 마지막 동기화 상태는 NOJI의 users/{uid}/sync/state 문서에 둔다(NOJI 앱은 이 문서를 쓰지 않음).
//  · 옵시디언에는 메타데이터(변경·방향·날짜·분류·제목·상태·ID)만 남긴다. 메모 본문은 옮기지 않는다(볼트 보안 규칙). 첫 연결 때는 남기지 않는다.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2), DRY = argv.includes('--dry-run'), outRoot = argv.find(a => !a.startsWith('--'));
const { NOJI_CLIENT_ID, NOJI_CLIENT_SECRET, NOJI_REFRESH_TOKEN } = process.env;
if (!NOJI_CLIENT_ID || !NOJI_CLIENT_SECRET || !NOJI_REFRESH_TOKEN) { console.error('NOJI_CLIENT_ID / NOJI_CLIENT_SECRET / NOJI_REFRESH_TOKEN 시크릿이 필요합니다'); process.exit(2); }

const PROJECT = 'chaenggim-calendar', DATA_UID = 'hsglp2oy1jexIRllxsOeC8Fb2582';
const PRIMARY = 'primary', FAMILY = 'family16526564032112364840@group.calendar.google.com';
const APP_URL = 'https://juno99zz-arkt.github.io/chaenggim-calendar/', MARK = 'NOJI캘린더에서 관리';
const TOKEN_URL = process.env.TOKEN_URL || 'https://oauth2.googleapis.com/token';                       // 테스트용으로만 바꿈
const FS_BASE = process.env.FS_BASE || 'https://firestore.googleapis.com/v1';
const CAL_BASE = process.env.CAL_BASE || 'https://www.googleapis.com/calendar/v3';
const FS_DOC = `${FS_BASE}/projects/${PROJECT}/databases/(default)/documents/users/${DATA_UID}`;

// NOJI 앱(index.html)과 같은 분류·상태. 색·알림은 지금까지 구글 캘린더에 만들어 둔 NOJI 일정과 같게.
const CATS = { family: { short: '가족', color: '4', remind: [900] }, estate: { short: '부동산·세금', color: '2', remind: [900, 9540] },
               expense: { short: '지출', color: '5', remind: [900, 9540] }, work: { short: '회사', color: '9', remind: [900] } };   // 900분 = 전날 09:00, 9540분 = 7일 전 09:00 (종일 일정 기준)
const CAT_BY_SHORT = Object.fromEntries(Object.entries(CATS).map(([k, c]) => [c.short, k]));
const STATUS = { 확정: '확정', 목표: '내부 목표', 예상: '예상', 확인필요: '확인 필요' };
const STATUS_BY_LABEL = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));

/* ───── 날짜 (TZ=Asia/Seoul) ───── */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const dayDiff = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const NOW = new Date(), TODAY = iso(NOW);
const WIN_FROM = addDays(TODAY, -7), WIN_TO = addDays(TODAY, 400);   // 구글에서 가져올 기간 (예전 이력은 일괄로 가져오지 않음)
const h = o => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12);

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
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`${opt.method || 'GET'} ${url.split('?')[0].replace(/^https?:\/\/[^/]+/, '')} → ${r.status} ${j.error?.message || ''}`); e.status = r.status; throw e; }
  return j;
}
const calUrl = (cal, id = '') => `${CAL_BASE}/calendars/${encodeURIComponent(cal)}/events${id ? '/' + encodeURIComponent(id) : ''}`;
async function listCal(cal, q) {
  const out = []; let page = '';
  do { const j = await api(`${calUrl(cal)}?${q}&maxResults=2500&showDeleted=false${page ? '&pageToken=' + encodeURIComponent(page) : ''}`); out.push(...(j.items || [])); page = j.nextPageToken || ''; } while (page);
  return out;
}

/* ───── Firestore ───── */
const fsVal = v => 'stringValue' in v ? v.stringValue : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? Number(v.integerValue)
  : 'doubleValue' in v ? v.doubleValue : 'timestampValue' in v ? v.timestampValue : 'mapValue' in v ? fsObj(v.mapValue.fields || {})
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(fsVal) : null;
const fsObj = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, fsVal(v)]));
const fsEnc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : Array.isArray(v) ? { arrayValue: { values: v.map(fsEnc) } }
  : typeof v === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fsEnc(x)])) } } : { stringValue: String(v) };
const EV_FIELDS = ['title', 'cat', 'status', 'date', 'end', 'repeat', 'src', 'memo', 'updatedAt', 'createdAt', 'lunar', 'ly', 'lm', 'ld', 'leap'];   // NOJI 앱이 저장하는 모양 그대로
async function readNoji() {
  const out = []; let page = '';
  do {
    const j = await api(`${FS_DOC}/events?pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
    for (const d of j.documents || []) out.push({ id: d.name.split('/').pop(), ...fsObj(d.fields || {}) });
    page = j.nextPageToken || '';
  } while (page);
  return out;
}
let fakeId = 0;
async function nojiSave(id, ev) {   // id 없으면 새로 만들고 새 id를 돌려준다. NOJI 앱처럼 문서 전체를 덮어씀
  const fields = Object.fromEntries(EV_FIELDS.filter(k => ev[k] !== undefined).map(k => [k, fsEnc(ev[k])]));
  if (DRY) return id || `(새 NOJI ${++fakeId})`;
  if (id) { await api(`${FS_DOC}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ fields }) }); return id; }
  return (await api(`${FS_DOC}/events`, { method: 'POST', body: JSON.stringify({ fields }) })).name.split('/').pop();
}
async function readState() {
  try { const j = await api(`${FS_DOC}/sync/state`); const s = fsObj(j.fields || {}); return { links: s.links || {}, ignored: s.ignored || {}, homeSeen: s.homeSeen || {} }; }
  catch (e) { if (e.status === 404) return { links: {}, ignored: {}, homeSeen: {} }; throw e; }
}
async function writeState(s) {
  if (DRY) return;
  await api(`${FS_DOC}/sync/state`, { method: 'PATCH', body: JSON.stringify({ fields: { links: fsEnc(s.links), ignored: fsEnc(s.ignored), homeSeen: fsEnc(s.homeSeen), syncedAt: fsEnc(NOW.toISOString()) } }) });
}

/* ───── NOJI 일정 → 구글 캘린더 일정(들) ───── */
function monthlyRule(day) {   // NOJI는 그달에 그 날짜가 없으면 말일로 당김 → 29~31일은 "그 날짜 이하 중 마지막 날"
  if (day <= 28) return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${day}`;
  return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${Array.from({ length: day - 27 }, (_, i) => 28 + i).join(',')};BYSETPOS=-1`;
}
function desiredFor(ev) {
  if (!ev.title || !ev.date) return [];
  const c = CATS[ev.cat] || CATS.estate;
  const st = ev.status && ev.status !== '확정' ? `[${STATUS[ev.status] || ev.status}] ` : '';
  const desc = [(st + (ev.memo || '')).trim(), ev.lunar && ev.lm ? `음력 ${ev.lm}.${ev.ld}${ev.leap ? '(윤)' : ''}` : '', ev.src ? `출처: ${ev.src}` : '', `${MARK} · ${APP_URL}`].filter(Boolean).join('\n');
  // 2026-10-27 첫 동기화 때 만든 형식을 그대로 따른다(이어받기·중복 방지):
  //   음력 반복 → '제목 (음 M.D)' 회차별 일정(올해부터 5년치) / 기간 일정 → 8일 이상(가족 제외)이면 '제목 시작 (~M/D)' + '제목 마감'(회사는 '종료') 두 일정, 그보다 짧으면 한 일정
  const name = `[${c.short}] ${ev.title}` + (ev.lunar && ev.lm ? ` (음 ${ev.lm}.${ev.ld}${ev.leap ? '(윤)' : ''})` : '');
  const base = { summary: name, description: desc, colorId: c.color, transparency: 'transparent',
    reminders: { useDefault: false, overrides: c.remind.map(m => ({ method: 'popup', minutes: m })) } };
  const hasEnd = ev.end && ev.end > ev.date, split = hasEnd && ev.cat !== 'family' && dayDiff(ev.date, ev.end) >= 8, span = hasEnd && !split ? dayDiff(ev.date, ev.end) : 0;   // 일주일 안팎 기간은 한 일정, 그보다 길면(가족 제외) 시작·마감 두 일정
  const one = (start, extra = {}) => ({ ...base, start: { date: start }, end: { date: addDays(start, span + 1) }, ...extra });
  const rec = d => ev.repeat === 'yearly' ? { recurrence: ['RRULE:FREQ=YEARLY'] } : ev.repeat === 'monthly' ? { recurrence: [monthlyRule(Number(d.slice(8)))] } : {};
  if (ev.lunar && ev.lm && ev.repeat === 'yearly') {   // 구글 캘린더는 음력 반복이 없어 회차를 따로 만든다
    if (!KLC) { console.warn(`  ! 음력 계산 모듈이 없어 건너뜀: ${ev.title}`); return []; }
    const y = Number(TODAY.slice(0, 4));   // 올해부터 5년치(올해 이미 지난 날짜도 포함해 기존 일정과 맞춤). 지난 회차는 새로 만들지 않고 이어받기만
    const dates = Array.from({ length: 5 }, (_, i) => lunarToSolar(y + i, ev.lm, ev.ld)).filter(d => d && d >= ev.date);
    return dates.map(d => ({ key: `${ev.id}_${d}`, occ: d, old: d < addDays(TODAY, -7), body: one(d) }));
  }
  const old = addDays(hasEnd ? ev.end : ev.date, 60) < TODAY && ev.repeat !== 'yearly' && ev.repeat !== 'monthly';
  if (split) {
    const md = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}`;
    return [{ key: `${ev.id}#s`, part: 's', old, body: { ...one(ev.date, rec(ev.date)), summary: `${name} 시작 (~${md(ev.end)})` } },
            { key: `${ev.id}#e`, part: 'e', old, body: { ...one(ev.end, rec(ev.end)), summary: `${name} ${ev.cat === 'work' ? '종료' : '마감'}` } }];
  }
  return [{ key: ev.id, old, body: one(ev.date, rec(ev.date)) }];
}

/* ───── 구글 일정 → NOJI 값 ───── */
const repeatOf = e => { const r = (e.recurrence || []).join('|'); return !r ? 'none' : /FREQ=YEARLY/.test(r) ? 'yearly' : /FREQ=MONTHLY/.test(r) ? 'monthly' : null; };   // null = NOJI가 못 담는 반복(매주 등)
function datesOf(e) {
  if (e.start?.date) { const s = e.start.date, last = addDays(e.end?.date || addDays(s, 1), -1); return { date: s, end: last > s ? last : '' }; }
  const s = iso(new Date(e.start.dateTime)), last = iso(new Date(new Date(e.end?.dateTime || e.start.dateTime) - 1));
  return { date: s, end: last > s ? last : '' };
}
function fromManaged(e, prev) {   // NOJI가 만든 일정을 구글에서 고쳤을 때 → NOJI 값으로 되돌려 읽기
  const m = (e.summary || '').match(/^\[([^\]]+)\]\s*(.*)$/);
  const lines = (e.description || '').split('\n').map(s => s.trim()).filter(l => l && !l.includes(MARK) && !/^음력 \d/.test(l));
  let src = prev.src || ''; const body = [];
  for (const l of lines) { if (l.startsWith('출처:')) src = l.slice(3).trim(); else body.push(l); }
  let memo = body.join('\n'), status = '확정';
  const sm = memo.match(/^\[(내부 목표|예상|확인 필요|확정)\]\s*/); if (sm) { status = STATUS_BY_LABEL[sm[1]]; memo = memo.slice(sm[0].length); }
  return { ...prev, title: ((m ? m[2] : e.summary) || prev.title).trim(), cat: (m && CAT_BY_SHORT[m[1]]) || prev.cat, status, memo, src, ...datesOf(e), repeat: repeatOf(e) || prev.repeat, updatedAt: TODAY };
}
const stripHtml = s => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();
function fromImport(e, cal, prev = {}) {   // 구글에서 가져온 일정
  const m = (e.summary || '').match(/^\[([^\]]+)\]\s*(.*)$/), mc = m && CAT_BY_SHORT[m[1]];
  const time = e.start?.dateTime ? `${hm(new Date(e.start.dateTime))}~${hm(new Date(e.end?.dateTime || e.start.dateTime))} ` : '';
  const memo = (time + (e.location ? `@${e.location} ` : '') + stripHtml(e.description)).trim().slice(0, 600);
  return { createdAt: TODAY, ...prev, title: ((mc ? m[2] : e.summary) || '(제목 없음)').trim(), cat: prev.cat && !mc ? prev.cat : mc || (cal === FAMILY ? 'family' : 'work'),
    status: prev.status || (mc || cal === FAMILY ? '확정' : '확인필요'), ...datesOf(e), repeat: repeatOf(e) || 'none', memo, src: cal === FAMILY ? '구글 캘린더(가족)' : '구글 캘린더', updatedAt: TODAY };
}

/* ───── 비교·서명 ───── */
const sigFull = e => JSON.stringify([e.summary || '', (e.description || '').trim(), e.start?.date || e.start?.dateTime || '', e.end?.date || e.end?.dateTime || '',
  (e.recurrence || []).join('|'), e.colorId || '', e.transparency || 'opaque',
  e.reminders?.useDefault ? 'default' : (e.reminders?.overrides || []).map(o => `${o.method}:${o.minutes}`).sort().join(',')]);
const gSigOf = e => h([e.summary || '', (e.description || '').trim(), e.start?.date || e.start?.dateTime || '', e.end?.date || e.end?.dateTime || '', (e.recurrence || []).join('|')]);   // 사용자가 구글에서 고치는 부분
const nSigOf = ev => h([ev.title, ev.cat, ev.status || '확정', ev.date, ev.end || '', ev.repeat || 'none', ev.memo || '', ev.src || '', !!ev.lunar, ev.lm || 0, ev.ld || 0]);
const gDate = e => e.updated ? iso(new Date(e.updated)) : '';

/* ───── 같은 일정 찾기 (구글·홈에서 가져올 때 NOJI에 이미 있으면 새로 만들지 않음) ───── */
const norm = s => String(s || '').replace(/\[[^\]]*\]/g, '').replace(/[\s·.,:;()~\-—_/'"]/g, '').toLowerCase();
const toks = s => new Set(String(s || '').replace(/\[[^\]]*\]/g, ' ').split(/[\s·.,:;()/~]+/).filter(t => t.length >= 2));
const bigr = s => { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; };
function similar(a, b) {
  const A = norm(a), B = norm(b); if (!A || !B) return false;
  if (A.includes(B) || B.includes(A)) return true;
  const ta = toks(a), tb = toks(b), ti = [...ta].filter(t => tb.has(t)).length;
  if (ta.size && tb.size && ti / Math.min(ta.size, tb.size) >= 0.5) return true;
  const ba = bigr(A), bb = bigr(B), bi = [...ba].filter(x => bb.has(x)).length;
  return ba.size && bb.size ? bi / Math.min(ba.size, bb.size) >= 0.4 : false;   // findSame은 항상 같은 날짜일 때만 부름
}
const onDate = (e, date) => e.date === date || (e.repeat === 'yearly' && e.date.slice(5) === date.slice(5)) || (e.repeat === 'monthly' && e.date.slice(8) === date.slice(8));
const findSame = (list, date, end, title) => list.find(e => onDate(e, date) && (similar(e.title, title) || (end && e.end === end && [...toks(e.title)].some(t => toks(title).has(t)))));

/* ───── 옵시디언 홈 '다가오는 기한' 표 ───── */
const KIND = { '확정 기한': '확정', '확정 일정': '확정', '내부 목표': '목표', '예상·대기': '예상', '예상': '예상', '확인 필요': '확인필요' };
const CAT_WORDS = [['family', /가족|여행|기념일|생일|생신|제사|어머니|아버지|아이/], ['expense', /카드|지출|연회비|결제|구독|보험료/],
                   ['estate', /세금|임대|부동산|등기|용답|사당|520|보증|렌트홈|재산세|종부세|종합부동산|비트코인|투자|재건축|계약신고|감정평가/]];
function parseHome(md) {
  const sec = md.split(/\n## /).find(s => /다가오는 기한/.test(s.split('\n')[0])); if (!sec) return [];
  const y0 = NOW.getFullYear(), m0 = NOW.getMonth() + 1, out = [];
  const ymd = (m, d) => { const y = m < m0 - 2 ? y0 + 1 : y0; return `${y}-${pad(m)}-${pad(d)}`; };   // 연말에 1~2월 날짜는 내년
  for (const line of sec.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    const c = line.split('|').slice(1, -1).map(s => s.trim()); if (c.length < 3 || c[0] === '날짜') continue;
    const status = KIND[c[1]]; if (!status) continue;                                   // 완료 기록 등은 건너뜀
    const dm = c[0].match(/^~?\s*(\d{1,2})\/(\d{1,2})(?:\s*~\s*(\d{1,2})\/(\d{1,2}))?$/) || c[0].match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dm) continue;                                                                  // '11월 초'·'미정' 등 날짜가 정확하지 않으면 건너뜀
    let date, end = '';
    if (dm[0].length === 10 && dm[0][4] === '-') date = dm[0];
    else { date = ymd(+dm[1], +dm[2]); if (dm[3]) end = ymd(+dm[3], +dm[4]); if (end && end < date) end = addDays(end, 365); }
    const what = c[2].replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').replace(/\*\*/g, '');
    const cut = what.search(/[.:]\s|:/), title = (cut > 0 ? what.slice(0, cut) : what).trim(), memo = cut > 0 ? what.slice(cut + 1).replace(/^[\s.:]+/, '').trim() : '';
    const refs = [...(c[3] || '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(x => x[1].split('#')[0].trim());
    const cat = (CAT_WORDS.find(([, re]) => re.test(refs.join(' '))) || CAT_WORDS.find(([, re]) => re.test(what)) || ['work'])[0];   // 기준 노트 이름을 먼저, 없으면 항목 문구로
    out.push({ key: h([date, norm(title)]), date, end, status, title, memo, cat, src: ['옵시디언 홈', ...new Set(refs)].join(' · ') });
  }
  return out;
}

/* ═════════ 실행 ═════════ */
TOKEN = await getToken();
const noji = await readNoji();
const state = await readState();
const firstRun = !Object.keys(state.links).length;
const changes = [], plan = [], warn = [];
const meta = (ev, d) => ({ 날짜: d || ev.date, 분류: (CATS[ev.cat] || CATS.estate).short, 제목: ev.title, 상태: STATUS[ev.status] || ev.status || '확정', id: ev.id });
const log = (변경, 방향, ev, d) => changes.push({ 변경, 방향, ...meta(ev, d) });
const byId = () => new Map(noji.map(e => [e.id, e]));

// ── ① 구글에서 가져온 일정: 원본과 제목·날짜 맞추기
for (const [nid, L] of Object.entries(state.links).filter(([, l]) => l.kind === 'import')) {
  const ev = byId().get(nid);
  if (!ev) { state.ignored[`${L.cal}|${L.gid}`] = true; delete state.links[nid]; plan.push({ label: `가져온 일정 연결 해제(NOJI에서 지움, 구글 원본은 그대로): ${L.title || nid}` }); continue; }
  let g = null; try { g = await api(calUrl(L.cal, L.gid)); } catch (e) { if (![404, 410].includes(e.status)) throw e; }
  if (!g || g.status === 'cancelled') { delete state.links[nid]; plan.push({ label: `구글 원본이 지워짐 → NOJI 일정은 유지하고 NOJI 일정으로 전환: ${ev.title}` }); continue; }   // ② 단계에서 개인 캘린더에 다시 만들어짐
  const nCh = L.nSig !== nSigOf(ev), gCh = L.gSig !== gSigOf(g);
  if (gCh && (!nCh || gDate(g) > (ev.updatedAt || ''))) {
    const nv = fromImport(g, L.cal, ev); nv.memo = ev.memo; nv.src = ev.src;   // 메모·출처는 NOJI 쪽을 유지, 제목·날짜·반복만 원본을 따름
    await nojiSave(nid, nv); Object.assign(ev, nv); log('변경', '구글→NOJI', ev); plan.push({ label: `NOJI 수정(구글 원본 따라): ${ev.title}` });
  } else if (nCh) {
    const body = { summary: (L.prefix ? `[${(CATS[ev.cat] || CATS.work).short}] ` : '') + ev.title };
    if (g.start?.date) { body.start = { date: ev.date }; body.end = { date: addDays(ev.end && ev.end > ev.date ? ev.end : ev.date, 1) }; }
    else { const sh = dayDiff(iso(new Date(g.start.dateTime)), ev.date), mv = t => new Date(new Date(t).getTime() + sh * 864e5).toISOString(); body.start = { dateTime: mv(g.start.dateTime) }; body.end = { dateTime: mv(g.end.dateTime) }; }
    if (!DRY) g = await api(calUrl(L.cal, L.gid), { method: 'PATCH', body: JSON.stringify(body) }); else g = { ...g, ...body };
    log('변경', 'NOJI→구글', ev); plan.push({ label: `구글 원본 수정(제목·날짜): ${ev.title}` });
  }
  Object.assign(L, { nSig: nSigOf(ev), gSig: gSigOf(g), title: ev.title });
}

// ── ② 구글 → NOJI 새로 가져오기: 가족 캘린더 전부 + 개인 캘린더의 반복 아닌 일정
const win = `timeMin=${encodeURIComponent(WIN_FROM + 'T00:00:00+09:00')}&timeMax=${encodeURIComponent(WIN_TO + 'T00:00:00+09:00')}&singleEvents=false`;
const linkedG = new Set(Object.values(state.links).map(l => `${l.cal}|${l.gid}`));
const isManaged = e => (e.description || '').includes(MARK) || e.extendedProperties?.private?.noji === '1';
const famAll = await listCal(FAMILY, win), priAll = await listCal(PRIMARY, win);
const stat = { 가족: famAll.length, 개인: priAll.length, 개인반복제외: priAll.filter(e => e.recurrence || e.recurringEventId).length, NOJI관리: [...famAll, ...priAll].filter(isManaged).length };
const candidates = [
  ...famAll.map(e => ({ e, cal: FAMILY })),
  ...priAll.filter(e => !e.recurrence && !e.recurringEventId).map(e => ({ e, cal: PRIMARY })),
].filter(({ e, cal }) => e.status !== 'cancelled' && (!e.eventType || e.eventType === 'default') && !isManaged(e) && !e.recurringEventId
  && !linkedG.has(`${cal}|${e.id}`) && !state.ignored[`${cal}|${e.id}`] && !(e.attendees || []).some(a => a.self && a.responseStatus === 'declined'));
for (const { e, cal } of candidates) {
  if (repeatOf(e) === null) { state.ignored[`${cal}|${e.id}`] = true; warn.push(`매주 등 NOJI가 못 담는 반복이라 건너뜀(이후 다시 묻지 않음): ${e.summary}`); continue; }
  const nv = fromImport(e, cal), same = findSame(noji, nv.date, nv.end, nv.title);
  const prefix = !!CAT_BY_SHORT[((e.summary || '').match(/^\[([^\]]+)\]/) || [])[1]];
  if (same) {   // NOJI에 이미 있는 일정 → 중복으로 만들지 않음 (NOJI 쪽 일정이 개인 캘린더에 따로 동기화됨)
    state.ignored[`${cal}|${e.id}`] = true; warn.push(`NOJI에 이미 있는 일정이라 가져오지 않음: ${e.summary} ↔ ${same.title}`); continue;
  }
  nv.id = await nojiSave(null, nv); noji.push(nv);
  state.links[nv.id] = { kind: 'import', cal, gid: e.id, prefix, nSig: nSigOf(nv), gSig: gSigOf(e), title: nv.title };
  log('추가', '구글→NOJI', nv); plan.push({ label: `NOJI 추가(구글${cal === FAMILY ? ' 가족' : ''}): ${nv.title} ${nv.date}` });
}

// ── ③ 옵시디언 홈 '다가오는 기한' → NOJI
const homePath = outRoot && join(outRoot, '00. 홈.md');
if (homePath && existsSync(homePath)) {
  for (const it of parseHome(readFileSync(homePath, 'utf8'))) {
    if (state.homeSeen[it.key] || it.date < TODAY) continue;                           // 한 번 본 항목은 다시 가져오지 않음(NOJI에서 지워도)
    const same = findSame(noji, it.date, it.end, it.title);
    if (same) { state.homeSeen[it.key] = same.id; continue; }
    const nv = { title: it.title, cat: it.cat, status: it.status, date: it.date, end: it.end, repeat: 'none', src: it.src, memo: it.memo, createdAt: TODAY, updatedAt: TODAY };
    nv.id = await nojiSave(null, nv); noji.push(nv); state.homeSeen[it.key] = nv.id;
    log('추가', '옵시디언 홈→NOJI', nv); plan.push({ label: `NOJI 추가(옵시디언 홈): ${nv.title} ${nv.date}` });
  }
} else if (outRoot) warn.push('옵시디언 00. 홈.md를 찾지 못해 홈 기한표는 건너뜀');

// ── ④ NOJI 일정 ⇄ 개인 캘린더 (NOJI가 관리하는 일정)
const tagged = await listCal(PRIMARY, 'privateExtendedProperty=noji%3D1');
const legacy = (await listCal(PRIMARY, `q=${encodeURIComponent(MARK)}`)).filter(e => !e.extendedProperties?.private?.nojiKey && (e.description || '').includes(MARK) && !e.recurringEventId);
const byKey = new Map(tagged.map(e => [e.extendedProperties.private.nojiKey, e])), usedLegacy = new Set(), desiredKeys = new Set();
const tagOf = (ev, d) => ({ private: { noji: '1', nojiId: ev.id, nojiKey: d.key, ...(d.occ ? { nojiOcc: d.occ } : {}) } });
const calOps = [];   // 실제 쓰기는 마지막에 한 번에
for (const ev of noji.filter(e => state.links[e.id]?.kind !== 'import')) for (const d of desiredFor(ev)) {
  desiredKeys.add(d.key);
  const L = state.links[d.key], cur = byKey.get(d.key);
  if (cur) {
    const nCh = !L || L.nSig !== nSigOf(ev), gCh = !!L && L.gSig !== gSigOf(cur);
    const pull = gCh && !ev.lunar && repeatOf(cur) !== null && (!nCh || gDate(cur) > (ev.updatedAt || ''));
    if (pull) {   // 구글에서 고친 것이 더 최근 → NOJI에 반영
      const nv = fromManaged(cur, ev); nv.title = nv.title.replace(/ 시작 \(~[^)]*\)$| (마감|종료)$/, '').replace(/ \(음 [^)]*\)$/, '');
      if (d.part === 's') nv.end = ev.end; if (d.part === 'e') { nv.end = nv.date; nv.date = ev.date; }
      await nojiSave(ev.id, nv); Object.assign(ev, nv); log('변경', '구글→NOJI', ev, d.occ);
      plan.push({ label: `NOJI 수정(구글에서 고친 내용): ${ev.title}` });
      const nd = desiredFor(ev).find(x => x.key === d.key) || d;   // 표시 형식(색·알림·설명 줄)만 다시 맞춤
      if (sigFull(cur) !== sigFull(nd.body)) calOps.push({ op: 'patch', id: cur.id, key: d.key, ev, body: { ...nd.body, recurrence: nd.body.recurrence || [] }, label: `${nd.body.summary} (형식 맞춤)` });
      else state.links[d.key] = { kind: 'noji', gid: cur.id, nSig: nSigOf(ev), gSig: gSigOf(cur) };
      continue;
    }
    if (gCh && nCh) warn.push(`양쪽에서 고침 → NOJI 쪽을 따름(NOJI ${ev.updatedAt || '?'} ≥ 구글 ${gDate(cur)}): ${ev.title}`);
    if (sigFull(cur) !== sigFull(d.body)) { calOps.push({ op: 'patch', id: cur.id, key: d.key, ev, body: { ...d.body, recurrence: d.body.recurrence || [] }, label: d.body.summary }); if (!firstRun && nCh) log('변경', 'NOJI→구글', ev, d.occ); }
    else state.links[d.key] = { kind: 'noji', gid: cur.id, nSig: nSigOf(ev), gSig: gSigOf(cur) };
    continue;
  }
  // 예전에 만들어 둔 일정 이어받기: 같은 제목 + 같은 시작일(반복 일정은 같은 제목이면 시작일이 달라도)
  const old = legacy.find(e => !usedLegacy.has(e.id) && e.summary === d.body.summary && (e.start?.date === d.body.start.date || (d.body.recurrence && e.recurrence)));
  if (old) { usedLegacy.add(old.id); calOps.push({ op: 'patch', id: old.id, key: d.key, ev, body: { ...d.body, recurrence: d.body.recurrence || [], extendedProperties: tagOf(ev, d) }, label: `${d.body.summary} (이어받기)` }); continue; }
  if (d.old) continue;   // 두 달 넘게 지난 일회성 일정은 새로 만들지 않음
  calOps.push({ op: 'insert', key: d.key, ev, body: { ...d.body, extendedProperties: tagOf(ev, d) }, label: d.body.summary });
  if (!firstRun) log(L ? '다시 만듦(구글에서 지워짐)' : '추가', 'NOJI→구글', ev, d.occ);
}
// NOJI에서 지워진 일정(또는 바뀐 음력 회차) → 구글에서도 삭제
for (const [key, e] of byKey) {
  if (desiredKeys.has(key)) continue;
  const p = e.extendedProperties.private, ev = byId().get(p.nojiId);
  if (ev && state.links[ev.id]?.kind === 'import') continue;
  if (ev && p.nojiOcc && p.nojiOcc < TODAY) continue;   // 지난 음력 회차는 기록으로 둠
  calOps.push({ op: 'delete', id: e.id, key, label: e.summary });
  changes.push({ 변경: '삭제', 방향: 'NOJI→구글', 날짜: p.nojiOcc || e.start?.date || '', 분류: (e.summary.match(/^\[([^\]]+)\]/) || [])[1] || '', 제목: e.summary.replace(/^\[[^\]]+\]\s*/, ''), 상태: '', id: p.nojiId });
}
for (const k of Object.keys(state.links)) if (state.links[k].kind === 'noji' && !desiredKeys.has(k)) delete state.links[k];
const orphans = legacy.filter(e => !usedLegacy.has(e.id));

for (const x of calOps) {
  plan.push({ label: `구글 ${{ insert: '추가', patch: '수정', delete: '삭제' }[x.op]}: ${x.label}` });
  if (DRY) continue;
  const u = calUrl(PRIMARY, x.id || '');
  const res = x.op === 'insert' ? await api(u, { method: 'POST', body: JSON.stringify(x.body) })
    : x.op === 'patch' ? await api(u, { method: 'PATCH', body: JSON.stringify(x.body) }) : (await api(u, { method: 'DELETE' }).catch(e => { if (![404, 410].includes(e.status)) throw e; }), null);
  if (res) state.links[x.key] = { kind: 'noji', gid: res.id, nSig: nSigOf(x.ev), gSig: gSigOf(res) };
}
await writeState(state);

/* ───── 보고 ───── */
console.log(`구글 일정 읽음: 가족 캘린더 ${stat.가족}개 · 개인 캘린더 ${stat.개인}개(매주 등 반복 ${stat.개인반복제외}개는 가져오지 않음, NOJI가 관리하는 ${stat.NOJI관리}개 제외)`);
console.log(`NOJI ${noji.length}개 · ${firstRun ? '첫 연결' : '정기 동기화'}${DRY ? ' · 미리보기(--dry-run, 아무것도 바꾸지 않음)' : ''}`);
for (const x of plan) console.log(`  ${x.label}`);
if (!plan.length) console.log('  바뀐 일정 없음');
for (const w of warn) console.log(`  ! ${w}`);
if (orphans.length) console.log(`  ! NOJI에서 짝을 못 찾은 예전 캘린더 일정 ${orphans.length}개(지우지 않음): ${orphans.map(e => e.summary).join(' / ')}`);

if (!DRY && outRoot && changes.length && !firstRun) {   // 옵시디언: 바뀐 일정 메타데이터만 Inbox_Squedule에
  const stamp = `${TODAY.replace(/-/g, '')}-${pad(NOW.getHours())}${pad(NOW.getMinutes())}`, cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const body = ['---', '보안: 개인정보', '원본: AI 초안', 'source: NOJI캘린더 자동 동기화', `수집: ${TODAY} ${hm(NOW)}`, '---', '',
    `# NOJI 일정 변경 ${TODAY}`, '', `NOJI캘린더·구글 캘린더·옵시디언 홈 사이에서 바뀐 일정입니다. 메모 등 세부 내용은 [NOJI캘린더](${APP_URL})에서 확인하세요.`, '',
    '| 변경 | 방향 | 날짜 | 분류 | 제목 | 상태 | NOJI ID |', '|---|---|---|---|---|---|---|',
    ...changes.map(c => `| ${c.변경} | ${c.방향} | ${c.날짜} | ${cell(c.분류)} | ${cell(c.제목)} | ${cell(c.상태)} | ${c.id} |`), ''];
  mkdirSync(join(outRoot, 'Inbox_Squedule'), { recursive: true });
  writeFileSync(join(outRoot, 'Inbox_Squedule', `${stamp}-NOJI-변경.md`), body.join('\n'));
  console.log(`옵시디언 기록: Inbox_Squedule/${stamp}-NOJI-변경.md (${changes.length}건)`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, [`### NOJI ⇄ 구글 캘린더 · 옵시디언 홈 ${DRY ? '(미리보기)' : ''}`, `NOJI ${noji.length}개 · 반영 ${plan.length}건${firstRun ? ' (첫 연결)' : ''}`, '',
    ...plan.map(x => `- ${x.label}`), ...warn.map(w => `- ⚠️ ${w}`),
    ...(orphans.length ? ['', `**NOJI에서 짝을 못 찾은 예전 캘린더 일정 ${orphans.length}개** (지우지 않음, 필요 없으면 캘린더에서 직접 삭제)`, ...orphans.map(e => `- ${e.summary} (${e.start?.date || ''})`)] : [])].join('\n') + '\n', { flag: 'a' });
}
