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
  const one = (txt.match(/^\*\*한 줄 요약\*\*:\s*(.+)$/m) || [])[1];
  if (one) sum.push(`- ${f.slice(5, 10).replace('-', '/')} ${plain(one).trim()}`);
  const top = txt.match(/^## 다음 기한 Top \d+\s*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  if (top) { topDue = plain(top[1]).trim(); latest = f.slice(0, 10); }
}

const out = ['---', `생성: ${ymd(now)} ${p2(now.getHours())}:${p2(now.getMinutes())}`, `기간: ${sinceStr} ~ ${ymd(now)}`, '보안: 개인정보', 'tags: [피클]', '원본: AI 초안 (메모 앱 Actions가 매일 갱신)', '---', '',
  '# 피클 브리핑용 요약', '',
  '> 이 노트 하나와 **구글 캘린더**(지난 7일·다음 7일)를 읽고 한 주를 브리핑하세요. 사내전용·개인정보 노트와 수집함 본문은 포함하지 않았습니다.', '',
  '## 이번 주 · 지난 주 메모장', '', ...weekBlock(cur, '이번 주'), ...weekBlock(prev, '지난 주'),
  '## 최근 7일 정리 리포트 요약', '', ...(sum.length ? sum : ['- 읽을 수 있는 리포트 없음']), '',
  ...(topDue ? [`## 다가오는 기한 (${latest} 리포트 기준)`, '', topDue, ''] : []),
  ...(skipped.length ? [`_보안 표시가 없어 건너뛴 리포트: ${skipped.join(', ')}_`, ''] : [])].join('\n');

const dir = join(outRoot, '3. Area of Responsibility', 'AI·HR');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'Pickle 브리핑용.md'), out);
console.log(`작성: 3. Area of Responsibility/AI·HR/Pickle 브리핑용.md (메모 ${cur}·${prev}, 리포트 ${sum.length}건)`);
