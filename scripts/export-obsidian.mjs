// 메모장을 옵시디언 노트(.md)로 기록 — GitHub Actions에서 매주 일요일 07:00(KST) 실행
//   ① 이번 주 노트 `YYYY-Www.md` : Completed Tasks · To do List · Refer 세 칸 (Thinking은 Inbox_thinking에 따로 기록)
//   ② 지난 주 노트가 이 형식으로 이미 있고 앱 내용이 그 뒤에 바뀌었으면 갱신 (예전 형식 노트는 건드리지 않음)
//   ③ `To do.md` : 이번 주 To do List 한 장 (매주 덮어씀)
// 사용: MEMO_PASSWORD=... node scripts/export-obsidian.mjs <vault.json> <옵시디언 저장소 폴더>
// 노트 형식(weekNote)은 index.html의 weekMarkdown과 같아야 함 (그쪽을 바꾸면 여기도 함께)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto as crypto, createHash } from 'node:crypto';

const [vaultPath, outRoot] = process.argv.slice(2).filter(a => !a.startsWith('--'));   // 예전 --notes/--todo 인자는 무시
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

const todoOfWeek = w => (typeof w?.todo === 'string' ? w.todo : '');
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

const bare = l => l.trim().replace(/^(?:[-*•]\s+)?(?:\[[ xX\/-]\]\s*)?/, '');
const nLines = t => String(t || '').split('\n').filter(l => l.trim()).length;
const itemLines = (text, mark) => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const p = parseLine(l); return `- [${mark}] ${mark === 'x' && p?.status === 'done' ? p.text : bare(l)}`; });
function weekNote(key, done, todo, memo) {
  const nd = nLines(done), nt = nLines(todo), rate = nd + nt ? Math.round(nd / (nd + nt) * 100) : 0, s = weekStart(key), e = weekEnd(key);
  return ['---', `week: ${key}`, `period: ${ymd(s)} ${hm(s)} ~ ${ymd(e)} ${hm(e)}`, `completed: ${nd}`, `todo: ${nt}`, `completion: ${rate}`, 'tags: [주간메모]', '---', '',
    `# ${key} 메모장`, '', `> ${weekRange(key)} · 완료 ${nd} · 할 일 ${nt} · 완료율 ${rate}%`, '',
    '## ✅ Completed Tasks', '', ...(nd ? itemLines(done, 'x') : ['_없음_']), '',
    '## 📋 To do List', '', ...(nt ? itemLines(todo, ' ') : ['_없음_']), '',
    '## 📝 Refer', '', memo.trim() || '_없음_', ''].join('\n');
}

/* ───── 기존 노트 보호 ─────
   옵시디언·정리 루틴이 노트에 붙인 속성(예: `보안: 사내전용`, 고친 tags)은 다시 쓸 때도 그대로 둔다.
   앱 내용이 안 바뀐 주(memo-hash 동일)는 노트를 건드리지 않아 옵시디언에서 고친 본문도 지켜진다. */
const OURS = new Set(['week', 'period', 'completed', 'completion', 'todo', 'doing', 'done', 'hold', 'updated', 'memo-hash']);   // 매번 우리가 계산하는 속성
function parseFront(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return { blocks: [], body: txt };
  const blocks = [];
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^([^\s:#\-][^:]*):/);
    if (k || !blocks.length) blocks.push({ key: k ? k[1].trim() : '', lines: [line] }); else blocks[blocks.length - 1].lines.push(line);   // 들여쓴 줄·목록은 앞 속성에 붙임
  }
  return { blocks, body: txt.slice(m[0].length) };
}
const hashOf = (...parts) => createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 10);
function mergeNote(gen, existing, hash) {
  const g = parseFront(gen), e = existing ? parseFront(existing) : { blocks: [] };
  const extras = e.blocks.filter(b => b.key && !OURS.has(b.key)), extraKeys = new Set(extras.map(b => b.key));
  const blocks = [...g.blocks.filter(b => !extraKeys.has(b.key)), ...extras];   // tags처럼 겹치면 기존 것이 우선
  if (hash) blocks.push({ key: 'memo-hash', lines: [`memo-hash: ${hash}`] });
  return `---\n${blocks.flatMap(b => b.lines).join('\n')}\n---\n${g.body}`;
}
const hashInNote = txt => parseFront(txt).blocks.find(b => b.key === 'memo-hash')?.lines[0].split(':')[1]?.trim() || '';

/* 이번 주 To do List → 항상 같은 노트 하나를 갱신 */
function todoNote(key, todo, at) {
  const nt = nLines(todo);
  return ['---', `week: ${key}`, `updated: ${ymd(at)} ${hm(at)}`, `todo: ${nt}`, 'tags: [할일]', '---', '',
    `# To do · ${key}`, '', `> 메모 앱이 매주 일요일 07:00에 자동으로 덮어씁니다 (여기서 고치지 마세요) · ${weekRange(key)}`, '',
    ...(nt ? itemLines(todo, ' ') : ['_이번 주 To do List가 비어 있습니다._']), ''].join('\n');
}

/* ───── 실행 ───── */
let db;
try { db = await openVault(JSON.parse(readFileSync(vaultPath, 'utf8')), password); }
catch { console.error('복호화 실패: MEMO_PASSWORD가 앱 비밀번호와 같은지 확인하세요'); process.exit(1); }

const saved = db.settings?.obsidian?.folder;
function migrateObsFolder(f) {   // 예전 최상위 폴더명을 새 번호 폴더로 (이미 새 이름이면 그대로, 그 밖의 폴더는 통과)
  const T = { '0. 지식 카드': '1. 지식 카드', '1. Project': '2. Project', '2. Area of Responsibility': '3. Area of Responsibility', '3. Resource (외부지식)': '4. Resource (외부지식)', '4. 보관': '5. 보관' };
  const K = { inbox_ai: 'Inbox_AI', inbox_mail: 'Inbox_Mail', inbox_memo: 'Inbox_memo', inbox_messenger: 'Inbox_messenger', inbox_sound: 'Inbox_sound', inbox_squedule: 'Inbox_Squedule', inbox_thinking: 'Inbox_thinking', inbox_youtube: 'Inbox_Youtube', 'inbox-youtube': 'Inbox-Youtube' };
  const p = String(f || '').replace(/^\/+/, '').split('/'), h = p[0], lc = h.toLowerCase();
  if (Object.hasOwn(T, h)) p[0] = T[h];
  else if (lc === 'inbox') p[0] = '0. Inbox';
  else if (Object.hasOwn(K, lc) || /^inbox[_-]/.test(lc)) p.splice(0, 1, '0. Inbox', Object.hasOwn(K, lc) ? K[lc] : h);
  return p.join('/');
}
const folder = migrateObsFolder((process.env.OBSIDIAN_FOLDER || (saved && saved !== '메모/주간' ? saved : '') || '3. Area of Responsibility/주간 메모').replace(/^\/+|\/+$/g, ''));   // 예전 기본값·예전 최상위 폴더명은 새 폴더로 (migrateObsFolder)
const dir = join(outRoot, folder);
mkdirSync(dir, { recursive: true });
const cur = isoWeek(), prev = (() => { const d = weekStart(cur); d.setDate(d.getDate() - 7); return isoWeek(d); })();
const wk = key => { const w = db.weeks?.[key]; return { done: w?.completed || '', todo: w?.todo || '', memo: textOfWeek(w) }; };

// ① 이번 주 · ② 지난 주(새 형식으로 이미 있고 앱 내용이 바뀐 경우만)
for (const key of [prev, cur]) {
  const { done, todo, memo } = wk(key);
  if (![done, todo, memo].some(t => t.trim())) continue;
  const file = join(dir, `${key}.md`), gen = weekNote(key, done, todo, memo), hash = hashOf('v3', done, todo, memo);
  const ex = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (ex !== null) {
    const had = hashInNote(ex);
    if (had === hash) { console.log(`그대로: ${key}.md (앱 내용 변화 없음)`); continue; }   // 옵시디언에서 고친 부분도 그대로 둠
    if (!had) { console.log(`건드리지 않음: ${key}.md (예전 형식으로 만든 노트)`); continue; }
  }
  writeFileSync(file, mergeNote(gen, ex, hash));
  console.log(`${ex === null ? '작성' : '갱신'}: ${folder}/${key}.md`);
}
// ③ To do.md
const tf = join(dir, 'To do.md');
writeFileSync(tf, mergeNote(todoNote(cur, wk(cur).todo, new Date()), existsSync(tf) ? readFileSync(tf, 'utf8') : null, null));
console.log(`To do 갱신: ${folder}/To do.md (${cur}, ${nLines(wk(cur).todo)}건)`);
