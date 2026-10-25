// 지난 주 메모장을 옵시디언 노트(.md)로 내보내기 — GitHub Actions에서 매주 월 05:00(KST) 실행
// 사용: MEMO_PASSWORD=... node scripts/export-obsidian.mjs <vault.json> <옵시디언 저장소 폴더>
// 상태 읽기·주 계산·노트 형식은 index.html과 같아야 함 (그쪽을 바꾸면 여기도 함께)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';

const [vaultPath, outRoot] = process.argv.slice(2);
const password = process.env.MEMO_PASSWORD;
if (!vaultPath || !outRoot) { console.error('사용: node export-obsidian.mjs <vault.json> <출력 폴더>'); process.exit(2); }
if (!password) { console.error('MEMO_PASSWORD 시크릿이 없습니다'); process.exit(2); }

const WEEK_START_HOUR = 5;
const ST = { todo: '준비', doing: '진행', done: '완료', hold: '보류' };
const ST_ORDER = ['todo', 'doing', 'done', 'hold'];
const ST_EMOJI = { done: '✅', doing: '🔄', todo: '📋', hold: '⏸' };

/* ───── 주 (월 05:00 ~ 다음 월 05:00, 현지 시간 = TZ 환경변수) ───── */
function isoWeek(d = new Date()) {
  const s = new Date(d.getTime() - WEEK_START_HOUR * 36e5);
  const t = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);
  const y = t.getFullYear(), jan4 = new Date(y, 0, 4);
  const w = 1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
function weekStart(key) {
  const [y, w] = key.split('-W').map(Number), jan4 = new Date(y, 0, 4);
  const mon = new Date(y, 0, 4 - ((jan4.getDay() + 6) % 7), WEEK_START_HOUR);
  mon.setDate(mon.getDate() + (w - 1) * 7);
  return mon;
}
function weekEnd(key) { const e = weekStart(key); e.setDate(e.getDate() + 7); return e; }
const md = d => `${d.getMonth() + 1}/${d.getDate()}`;
const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const weekRange = key => `${md(weekStart(key))}(월) ~ ${md(weekEnd(key))}(월) 05:00`;

/* ───── 복호화 (PBKDF2-SHA256 → AES-256-GCM, 앱과 동일) ───── */
const unb64 = s => Uint8Array.from(Buffer.from(s, 'base64'));
async function openVault(file, pw) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(file.kdf.salt), iterations: file.kdf.iter }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, key, unb64(file.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* 이전 버전(메모 여러 개)도 메모장 텍스트로 */
function textOfWeek(w) {
  if (typeof w?.text === 'string') return w.text;
  return (w?.memos || []).filter(m => !m.deleted).map(m => [m.title, ...(m.items || []).filter(i => i.text?.trim()).map(i => `${ST[i.status] || '준비'} ${i.text.trim()}`), m.note?.trim()].filter(Boolean).join('\n')).join('\n\n');
}

/* ───── 상태 읽기 ───── */
const KW = { '준비': 'todo', '진행': 'doing', '완료': 'done', '보류': 'hold' };
const BOX = { ' ': 'todo', '/': 'doing', 'x': 'done', 'X': 'done', '-': 'hold' };
function parseLine(line) {
  let m = line.match(/^\s*(?:[-*•]\s*)?[\[(]?(준비|진행|완료|보류)[\])]?\s*[:：.\-]?\s+(\S.*)$/);
  if (m) return { status: KW[m[1]], text: m[2].trim() };
  m = line.match(/^\s*[-*]\s*\[([ \/xX-])\]\s+(\S.*)$/);
  if (m) return { status: BOX[m[1]], text: m[2].trim() };
  return null;
}
function collect(text) {
  const g = { todo: [], doing: [], done: [], hold: [] };
  for (const line of text.split('\n')) { const p = parseLine(line); if (p) g[p.status].push(p); }
  return g;
}
const totalOf = g => ST_ORDER.reduce((s, k) => s + g[k].length, 0);
const rateOf = g => { const t = totalOf(g); return t ? Math.round(g.done.length / t * 100) : 0; };

function weekMarkdown(key, text) {
  const g = collect(text), s = weekStart(key), e = weekEnd(key);
  const L = ['---', `week: ${key}`, `period: ${ymd(s)} ${hm(s)} ~ ${ymd(e)} ${hm(e)}`, `completion: ${rateOf(g)}`,
    `todo: ${g.todo.length}`, `doing: ${g.doing.length}`, `done: ${g.done.length}`, `hold: ${g.hold.length}`, 'tags: [주간메모]', '---', '',
    `# ${key} 메모장`, '', `> ${weekRange(key)} · 준비 ${g.todo.length} · 진행 ${g.doing.length} · 완료 ${g.done.length} · 보류 ${g.hold.length} · 완료율 ${rateOf(g)}%`, ''];
  if (totalOf(g)) {
    L.push('## 단계별 정리');
    for (const k of ['done', 'doing', 'todo', 'hold']) if (g[k].length) { L.push('', `### ${ST_EMOJI[k]} ${ST[k]} (${g[k].length})`); for (const p of g[k]) L.push(`- [${k === 'done' ? 'x' : ' '}] ${p.text}`); }
    L.push('');
  }
  L.push('## 메모', '', text.trim());
  return L.join('\n') + '\n';
}

/* ───── 실행: 마감된 모든 지난 주를 쓰고(내용 같으면 그대로), 바뀐 파일 수 출력 ───── */
let db;
try { db = await openVault(JSON.parse(readFileSync(vaultPath, 'utf8')), password); }
catch { console.error('복호화 실패: MEMO_PASSWORD가 앱 비밀번호와 같은지 확인하세요'); process.exit(1); }

const saved = db.settings?.obsidian?.folder;
const folder = (process.env.OBSIDIAN_FOLDER || (saved && saved !== '메모/주간' ? saved : '') || '2. Area of Responsibility/주간 메모').replace(/^\/+|\/+$/g, '');   // 예전 기본값은 새 기본 폴더로
const dir = join(outRoot, folder);
mkdirSync(dir, { recursive: true });
const cur = isoWeek();
let written = 0;
for (const key of Object.keys(db.weeks || {}).filter(k => k < cur).sort()) {
  const text = textOfWeek(db.weeks[key]);
  if (!text.trim()) continue;
  const file = join(dir, `${key}.md`), body = weekMarkdown(key, text);
  if (existsSync(file) && readFileSync(file, 'utf8') === body) continue;
  writeFileSync(file, body); written++;
  console.log(`작성: ${folder}/${key}.md`);
}
console.log(`완료 · 이번 주 ${cur} · 새로 쓰거나 바뀐 노트 ${written}개`);
