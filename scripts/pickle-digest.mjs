// 피클(모바일 AI)이 읽을 "한 주 브리핑용" 요약 노트를 만든다 — 노트 한 장만 읽으면 되도록
//   · 이번 주·지난 주 메모장: 완료 / 할 일 줄 (Memo 자유 메모 본문은 넣지 않음)
//   · 최근 7일 정리 리포트: 한 줄 요약 + 최신 리포트의 다음 기한 (보안이 공개·비식별인 리포트만)
// 구글 캘린더는 피클이 직접 읽는다. 사내전용·개인정보 노트와 수집함(0. Inbox/Inbox_*) 본문은 읽지 않는다.
// 사용: MEMO_PASSWORD=... node scripts/pickle-digest.mjs <vault.json> <옵시디언 저장소 폴더>
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';

const [vaultPath, outRoot] = process.argv.slice(2);
const password = process.env.MEMO_PASSWORD;
if (!vaultPath || !outRoot) { console.error('사용: node pickle-digest.mjs <vault.json> <옵시디언 폴더>'); process.exit(2); }
if (!password) { console.error('MEMO_PASSWORD 시크릿이 없습니다'); process.exit(2); }

const WEEK_START_HOUR = 5, DAYS = 7;
const p2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const md = d => `${d.getMonth() + 1}/${d.getDate()}`;
function isoWeek(d = new Date()) {
  const s = new Date(d.getTime() - WEEK_START_HOUR * 36e5);
  const t = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);
  const y = t.getFullYear(), jan4 = new Date(y, 0, 4);
  return `${y}-W${p2(1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7))}`;
}
function weekStart(key) {
  const [y, w] = key.split('-W').map(Number), jan4 = new Date(y, 0, 4);
  const mon = new Date(y, 0, 4 - ((jan4.getDay() + 6) % 7), WEEK_START_HOUR);
  mon.setDate(mon.getDate() + (w - 1) * 7);
  return mon;
}
const weekEnd = key => { const e = weekStart(key); e.setDate(e.getDate() + 7); return e; };

const unb64 = s => Uint8Array.from(Buffer.from(s, 'base64'));
async function openVault(file, pw) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(file.kdf.salt), iterations: file.kdf.iter }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, key, unb64(file.ct))));
}
let db;
try { db = await openVault(JSON.parse(readFileSync(vaultPath, 'utf8')), password); }
catch { console.error('복호화 실패: MEMO_PASSWORD가 앱 비밀번호와 같은지 확인하세요'); process.exit(1); }

const now = new Date();
const lines = t => String(t || '').split('\n').map(l => l.trim()).filter(Boolean)
  .map(l => l.replace(/^(?:[-*•]\s+)?(?:\[[ xX\/-]\]\s*)?/, '').replace(/^(?:준비|진행|완료|보류)\s*[:：.\-]?\s+/, '').replace(/^\d+\s*[.)]\s*/, '').trim()).filter(Boolean);   // 번호만 있는 빈 줄은 뺌
const bullet = a => a.length ? a.map(l => `- ${l}`) : ['- 없음'];

/* ── 메모장 ── */
const cur = isoWeek(now), prev = isoWeek(new Date(weekStart(cur).getTime() - 864e5));
function weekBlock(key, title) {
  const w = db.weeks?.[key] || {}, done = lines(w.completed), todo = lines(w.todo);
  const rate = done.length + todo.length ? Math.round(done.length / (done.length + todo.length) * 100) : 0;
  return [`### ${title} · ${key} (${md(weekStart(key))}~${md(weekEnd(key))})`, `완료 ${done.length} · 할 일 ${todo.length} · 완료율 ${rate}%`, '',
    '**완료한 일**', ...bullet(done), '', '**아직 할 일**', ...bullet(todo), ''];
}

/* ── 정리 리포트 (보안이 공개·비식별인 것만) ── */
const frontOf = t => (t.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
const plain = s => s.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');
const repDir = join(outRoot, '3. Area of Responsibility', 'AI·HR', '정리 리포트');
const since = new Date(now); since.setDate(since.getDate() - DAYS); const sinceStr = ymd(since);
const reports = existsSync(repDir) ? readdirSync(repDir).filter(f => /^\d{4}-\d{2}-\d{2} 정리 리포트\.md$/.test(f) && f.slice(0, 10) >= sinceStr).sort() : [];
const sum = [], skipped = [];
let topDue = '', latest = '';
for (const f of reports) {
  const txt = readFileSync(join(repDir, f), 'utf8'), sec = (frontOf(txt).match(/^보안:\s*(\S+)/m) || [])[1];
  if (!['공개', '비식별'].includes(sec)) { skipped.push(f.slice(0, 10)); continue; }
  // 예전 형식 `**한 줄 요약**: …` 과 11/9부터 쓰는 `## 한 줄 요약` 제목 다음 줄 형식 모두 읽음
  const one = (txt.match(/^\*\*한 줄 요약\*\*:\s*(.+)$/m) || txt.match(/^## 한 줄 요약[ \t]*\r?\n(?:[ \t]*\r?\n)*(?!#)(.+)$/m) || [])[1];
  if (one) sum.push(`- ${f.slice(5, 10).replace('-', '/')} ${plain(one).trim()}`);
  const top = txt.match(/^## 다음 기한 Top \d+\s*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  if (top) { topDue = plain(top[1]).trim(); latest = f.slice(0, 10); }
}

/* ── ① 오늘 정리 리포트: 한 줄 요약 + 체계 상태 ── */
const secOf = (txt, head) => (txt.match(new RegExp(`^## ${head}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm')) || [])[1] || '';
const cut = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;
function todayReport() {
  const f = `${ymd(now)} 정리 리포트.md`, p = join(repDir, f);
  if (!existsSync(p)) return [`- 오늘 정리 리포트가 아직 없음${reports.length ? ` (최신: ${reports[reports.length - 1].slice(0, 10)})` : ''}`];
  const txt = readFileSync(p, 'utf8');
  if (!['공개', '비식별'].includes((frontOf(txt).match(/^보안:\s*(\S+)/m) || [])[1])) return ['- 오늘 리포트는 보안 표시 때문에 싣지 않음'];
  const one = (txt.match(/^\*\*한 줄 요약\*\*:\s*(.+)$/m) || txt.match(/^## 한 줄 요약[ \t]*\r?\n(?:[ \t]*\r?\n)*(?!#)(.+)$/m) || [])[1];
  const sys = secOf(txt, '체계 상태').split('\n').map(l => l.trim()).filter(l => /^[-*]\s/.test(l)).slice(0, 5).map(l => '- ' + cut(plain(l.replace(/^[-*]\s+/, '')), 220));
  const check = secOf(txt, '확인 필요').split('\n').map(l => l.trim()).filter(l => /^[-*]\s/.test(l)).slice(0, 5).map(l => '- ' + cut(plain(l.replace(/^[-*]\s+/, '')), 160));
  return [...(one ? [`**요약**: ${plain(one).trim()}`, ''] : []), ...(sys.length ? ['**체계 상태**', ...sys, ''] : []), ...(check.length ? ['**확인 필요**', ...check] : [])];
}

/* ── ② Inbox 할 일: vault-agent 할 일 수집 결과에서 기한 있는 것만 ── */
const digestPath = join(outRoot, '3. Area of Responsibility', '브리핑', '할 일·주요사항.md');
function inboxTodos() {
  if (!existsSync(digestPath)) return ['- 할 일 수집 결과 없음 (vault-agent 할 일 수집이 아직 볼트에 쓰지 않음)'];
  const d = readFileSync(digestPath, 'utf8'), updated = (frontOf(d).match(/^updated:\s*(.+)$/m) || [])[1] || '미확인';
  const tidy = l => cut(plain(l.replace(/^- \[[ xX]\]\s*/, '- ').replace(/ \[\[[^\]]+\]\]/g, '')), 160);
  const head = h => (d.match(new RegExp(`^## ${h}[^\\n]*$`, 'm')) || [''])[0].replace(/^## /, '');
  const items = h => secOf(d, h).split('\n').filter(l => /^- \[/.test(l));
  const urgent = items('🔴'), dated = items('✅').filter(l => / — (D-\d+|\*\*오늘\*\*)/.test(l)).slice(0, 10), overdue = items('⏳');
  return [`자료 기준: ${updated}${updated !== ymd(now) ? ' (오늘 수집 아님)' : ''} · 완료 체크는 메모 앱 기준`, '',
    `**${head('🔴') || '오늘·임박'}**`, ...(urgent.length ? urgent.map(tidy) : ['- 없음']), '',
    `**기한 있는 열린 할 일 (가까운 순 ${dated.length})**`, ...(dated.length ? dated.map(tidy) : ['- 없음']), '',
    ...(overdue.length ? [`**${head('⏳').replace(/ — .*/, '')}** (앞 5개)`, ...overdue.slice(0, 5).map(tidy)] : [])];
}

/* ── ③ AI 작업 남은 일: 진행 중 전부 + 최근 3일 완료 중 남은일 있는 것 (개인정보 기록은 건수만) ── */
function aiWork() {
  const dir = join(outRoot, '3. Area of Responsibility', 'AI·HR', 'AI 작업기록');
  if (!existsSync(dir)) return ['- 작업기록 폴더 없음'];
  const field = (fm, k) => ((fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1] || '').trim().replace(/^"(.*)"$/, '$1');
  const recs = readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const fm = frontOf(readFileSync(join(dir, f), 'utf8'));
    return { tool: field(fm, '도구'), st: field(fm, '상태'), task: field(fm, '작업'), next: field(fm, '남은일'), sec: field(fm, '보안'), start: field(fm, '시작'), up: field(fm, '갱신') };
  });
  const recent = new Date(now); recent.setDate(recent.getDate() - 3); const recentStr = ymd(recent);
  const openR = recs.filter(r => r.st === '진행 중').sort((a, b) => a.start.localeCompare(b.start));
  const doneR = recs.filter(r => r.st === '완료' && r.next && !/^(없음|-)$/.test(r.next) && r.up.slice(0, 10) >= recentStr).sort((a, b) => b.up.localeCompare(a.up));
  const hidden = [...openR, ...doneR].filter(r => r.sec === '개인정보').length;
  const show = r => r.sec !== '개인정보';
  const day = s => s ? `${+s.slice(5, 7)}/${+s.slice(8, 10)}` : '';
  const o = openR.filter(show).map(r => `- ${r.tool} · ${day(r.start)}~ · ${cut(r.task, 80)}${r.next ? ` → 남은 일: ${cut(r.next, 100)}` : ''}`);
  const dn = doneR.filter(show).slice(0, 10).map(r => `- ${r.tool} · ${day(r.up)} · ${cut(r.task, 60)} → ${cut(r.next, 110)}`);
  return [`**진행 중 ${openR.length}**`, ...(o.length ? o : ['- 없음']), '',
    `**최근 3일 완료 · 남은 일 있음 ${doneR.length}**${doneR.length > 10 ? ' (최신 10개)' : ''}`, ...(dn.length ? dn : ['- 없음']),
    ...(hidden ? ['', `_개인정보 기록 ${hidden}건은 내용 없이 건수만 표시_`] : [])];
}

/* ── ④ Thinking: 메모 앱 이번 주 Thinking 칸 (비었으면 지난 주) ── */
function thinking() {
  const t = k => typeof db.weeks?.[k]?.thinking === 'string' ? db.weeks[k].thinking.trim() : '';
  const key = t(cur) ? cur : t(prev) ? prev : '';
  if (!key) return ['- 이번 주·지난 주 Thinking 없음'];
  const ls = t(key).split('\n').map(l => l.trim()).filter(Boolean);
  return [`${key === cur ? '이번 주' : '지난 주'} · ${key}`, '', ...ls.slice(0, 30).map(l => cut(l, 240)), ...(ls.length > 30 ? [`…외 ${ls.length - 30}줄`] : [])];
}

let out = ['---', `생성: ${ymd(now)} ${p2(now.getHours())}:${p2(now.getMinutes())}`, `기간: ${sinceStr} ~ ${ymd(now)}`, '보안: 개인정보', 'tags: [피클]', '원본: AI 초안 (메모 앱 Actions가 매일 갱신)', '---', '',
  '# 피클 브리핑용 요약', '',
  '> 이 노트 하나와 **구글 캘린더**(지난 7일·다음 7일)를 읽고 브리핑하세요. 순서: ① 오늘 정리 리포트 → ② 할 일 → ③ AI 작업 남은 일 → ④ Thinking → 메모장·기한. 개인정보 노트 본문은 넣지 않았고, 할 일과 Thinking은 사용자 본인 기록입니다.', '',
  '## ① 오늘 정리 리포트', '', ...todayReport(), '',
  '## ② 할 일 (기한 있는 것)', '', ...inboxTodos(), '',
  '## ③ AI 작업 남은 일', '', ...aiWork(), '',
  '## ④ Thinking', '', ...thinking(), '',
  '## 이번 주 · 지난 주 메모장', '', ...weekBlock(cur, '이번 주'), ...weekBlock(prev, '지난 주'),
  '## 최근 7일 정리 리포트 요약', '', ...(sum.length ? sum : ['- 읽을 수 있는 리포트 없음']), '',
  ...(topDue ? [`## 다가오는 기한 (${latest} 리포트 기준)`, '', topDue, ''] : []),
  ...(skipped.length ? [`_보안 표시가 없어 건너뛴 리포트: ${skipped.join(', ')}_`, ''] : [])].join('\n');

// NoJI 자동화 주간 점검(vault-agent, 금요일 저녁)이 남긴 피클 보고 — 8일 안의 것만 싣는다
const auditPath = join(outRoot, '3. Area of Responsibility', 'AI·HR', 'NoJI 주간 점검', '피클 보고.md');
if (existsSync(auditPath)) {
  const audit = readFileSync(auditPath, 'utf8');
  const day = (frontOf(audit).match(/^날짜:\s*(\d{4}-\d{2}-\d{2})/m) || [])[1];
  if (day && (now - new Date(day + 'T00:00:00')) / 864e5 <= 8)
    out += `\n\n## NoJI 자동화 주간 점검 (${day})\n\n> 이 구역이 새로 바뀐 날에는 브리핑 맨 앞에서 먼저 보고하세요.\n\n` +
      audit.replace(/^---[\s\S]*?---\s*/, '').split('\n').slice(0, 40).join('\n');
}

const dir = join(outRoot, '3. Area of Responsibility', 'AI·HR');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'Pickle 브리핑용.md'), out);
console.log(`작성: 3. Area of Responsibility/AI·HR/Pickle 브리핑용.md (메모 ${cur}·${prev}, 리포트 ${sum.length}건)`);
