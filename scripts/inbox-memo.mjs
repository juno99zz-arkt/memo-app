// 메모 앱 내용을 옵시디언 `0. Inbox/Inbox_memo/`에 기록 — GitHub Actions에서 매일 05:00·22:00(KST) 실행
//   주마다 노트 한 장 `YYYY-Www 메모.md` (Completed Tasks · To do List · Memo 전체 본문). 내용이 바뀐 경우에만 다시 씀
// 사용: MEMO_PASSWORD=... node scripts/inbox-memo.mjs <vault.json> <옵시디언 저장소 폴더>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto as crypto, createHash } from 'node:crypto';

const [vaultPath, outRoot] = process.argv.slice(2);
const password = process.env.MEMO_PASSWORD, FOLDER = process.env.INBOX_MEMO_FOLDER || '0. Inbox/Inbox_memo';
if (!vaultPath || !outRoot) { console.error('사용: node inbox-memo.mjs <vault.json> <옵시디언 폴더>'); process.exit(2); }
if (!password) { console.error('MEMO_PASSWORD 시크릿이 없습니다'); process.exit(2); }

const WEEK_START_HOUR = 5, p2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, hm = d => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
function isoWeek(d = new Date()) {
  const s = new Date(d.getTime() - WEEK_START_HOUR * 36e5), t = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);
  const y = t.getFullYear(), jan4 = new Date(y, 0, 4);
  return `${y}-W${p2(1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7))}`;
}
function weekStart(key) {
  const [y, w] = key.split('-W').map(Number), jan4 = new Date(y, 0, 4), mon = new Date(y, 0, 4 - ((jan4.getDay() + 6) % 7), WEEK_START_HOUR);
  mon.setDate(mon.getDate() + (w - 1) * 7); return mon;
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

/* 속성 보호: 옵시디언·정리 루틴이 붙인 속성(보안, 고친 tags 등)은 유지 */
const OURS = new Set(['week', 'period', 'saved', 'memo-hash', 'source']);
function parseFront(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/); if (!m) return { blocks: [], body: txt };
  const blocks = [];
  for (const line of m[1].split(/\r?\n/)) { const k = line.match(/^([^\s:#\-][^:]*):/); if (k || !blocks.length) blocks.push({ key: k ? k[1].trim() : '', lines: [line] }); else blocks[blocks.length - 1].lines.push(line); }
  return { blocks, body: txt.slice(m[0].length) };
}
const hashInNote = t => parseFront(t).blocks.find(b => b.key === 'memo-hash')?.lines[0].split(':')[1]?.trim() || '';
function merge(gen, existing, hash) {
  const g = parseFront(gen), e = existing ? parseFront(existing) : { blocks: [] };
  const extras = e.blocks.filter(b => b.key && !OURS.has(b.key)), keys = new Set(extras.map(b => b.key));
  const blocks = [...g.blocks.filter(b => !keys.has(b.key)), ...extras, { key: 'memo-hash', lines: [`memo-hash: ${hash}`] }];
  return `---\n${blocks.flatMap(b => b.lines).join('\n')}\n---\n${g.body}`;
}

const textOfWeek = w => typeof w?.text === 'string' ? w.text : '';
const box = (t, mark) => String(t || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => `- [${mark}] ${l.replace(/^(?:[-*•]\s+)?(?:\[[ xX\/-]\]\s*)?/, '')}`);
function note(key, w, savedAt) {
  const s = weekStart(key), e = weekEnd(key), done = box(w.completed, 'x'), todo = box(w.todo, ' '), memo = textOfWeek(w).trim();
  return ['---', `week: ${key}`, `period: ${ymd(s)} ${hm(s)} ~ ${ymd(e)} ${hm(e)}`, `saved: ${savedAt}`, '보안: 개인정보', 'tags: [메모앱]', 'source: 메모 앱 (Actions가 매일 05:00·22:00에 기록)', '---', '',
    `# ${key} 메모`, '', '> 메모 앱 내용의 사본입니다. 앱이 바뀐 내용을 다시 씁니다 — 여기서 고치지 말고 앱에서 고치세요.', '',
    '## ✅ Completed Tasks', '', ...(done.length ? done : ['_없음_']), '',
    '## 📋 To do List', '', ...(todo.length ? todo : ['_없음_']), '',
    '## 📝 Memo', '', memo || '_없음_', ''].join('\n');
}

const dir = join(outRoot, FOLDER); mkdirSync(dir, { recursive: true });
const cur = isoWeek(), prev = isoWeek(new Date(weekStart(cur).getTime() - 864e5)), now = new Date();
for (const key of [prev, cur]) {
  const w = db.weeks?.[key]; if (!w || ![w.completed, w.todo, textOfWeek(w)].some(t => String(t || '').trim())) continue;
  const hash = createHash('sha1').update(['inbox-v1', w.completed || '', w.todo || '', textOfWeek(w)].join('\0')).digest('hex').slice(0, 10);
  const file = join(dir, `${key} 메모.md`), ex = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (ex !== null && hashInNote(ex) === hash) { console.log(`그대로: ${FOLDER}/${key} 메모.md`); continue; }
  const saved = w.updated ? ymd(new Date(w.updated)) + ' ' + hm(new Date(w.updated)) : `${ymd(now)} ${hm(now)}`;
  writeFileSync(file, merge(note(key, w, saved), ex, hash));
  console.log(`${ex === null ? '작성' : '갱신'}: ${FOLDER}/${key} 메모.md`);
}
