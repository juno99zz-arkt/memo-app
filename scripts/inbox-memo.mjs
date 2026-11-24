// 메모 앱 내용을 옵시디언에 기록 — GitHub Actions에서 매일 05:00·22:00(KST) 실행
//   · `0. Inbox/Inbox_memo/YYYY-Www 메모.md`     : Completed Tasks · To do List · Refer
//   · `0. Inbox/Inbox_thinking/YYYY-Www Thinking.md` : Thinking (내 문장 그대로)
//   내용이 바뀐 경우에만 다시 쓴다. 정리 루틴이 노트를 다른 폴더로 옮겨도 `memo-app` 속성으로 찾아 그 자리에서 갱신한다
// 사용: MEMO_PASSWORD=... node scripts/inbox-memo.mjs <vault.json> <옵시디언 저장소 폴더>
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { webcrypto as crypto, createHash } from 'node:crypto';

const [vaultPath, outRoot] = process.argv.slice(2);
const password = process.env.MEMO_PASSWORD, FOLDER = process.env.INBOX_MEMO_FOLDER || '0. Inbox/Inbox_memo', THINK_FOLDER = process.env.INBOX_THINKING_FOLDER || '0. Inbox/Inbox_thinking';
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
  KEYOBJ = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(file.kdf.salt), iterations: file.kdf.iter }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, KEYOBJ, unb64(file.ct))));
}
let db, KEYOBJ;
try { db = await openVault(JSON.parse(readFileSync(vaultPath, 'utf8')), password); }
catch { console.error('복호화 실패: MEMO_PASSWORD가 앱 비밀번호와 같은지 확인하세요'); process.exit(1); }

/* 속성 보호: 옵시디언·정리 루틴이 붙인 속성(보안, 고친 tags 등)은 유지 */
const OURS = new Set(['week', 'period', 'saved', 'memo-hash', 'source', 'memo-app']);
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

/* 정리 루틴이 노트를 다른 폴더로 옮겼어도 찾는다: 앞부분(속성)만 읽어 `memo-app: <종류>` + `week: <주>`가 같은 노트를 고른다 */
function* mdFiles(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const f = join(d, e.name);
    if (e.isDirectory()) yield* mdFiles(f); else if (e.name.endsWith('.md')) yield f;
  }
}
function headOf(f) { const fd = openSync(f, 'r'), b = Buffer.alloc(700), n = readSync(fd, b, 0, 700, 0); closeSync(fd); return b.toString('utf8', 0, n); }
function findNote(kind, key) {
  for (const f of mdFiles(outRoot)) {
    const h = headOf(f); if (!h.startsWith('---')) continue;
    const fm = (h.match(/^---\r?\n([\s\S]*?)(?:\r?\n---|$)/) || [])[1] || '';
    if (new RegExp(`^memo-app:\\s*${kind}\\s*$`, 'm').test(fm) && new RegExp(`^week:\\s*${key}\\s*$`, 'm').test(fm)) return f;
  }
  return null;
}

const textOfWeek = w => typeof w?.text === 'string' ? w.text : '';      // Refer
const thinkOfWeek = w => typeof w?.thinking === 'string' ? w.thinking : '';

/* 붙여넣은 이미지: 본문의 {{img:ID}}를 옵시디언 첨부(Attachments/memo-ID.jpg) 링크로 바꾼다.
   이미지는 앱이 같은 열쇠로 암호화해 이 저장소의 img/ID.bin에 올려 둔다(1바이트 종류 + 이미지). 아직 올라오지 않았으면 자리표시만 남기고 다음 실행에 다시 시도 */
const IMG_RE = /\{\{img:([0-9a-f]{16})\}\}/g, IMG_DIR = join(dirname(vaultPath), 'img'), ATT_DIR = join(outRoot, 'Attachments');
const EXT = { 1: 'jpg', 2: 'png', 3: 'webp' };
async function withImages(text) {
  const t = String(text || ''), ids = [...new Set([...t.matchAll(IMG_RE)].map(m => m[1]))], link = {};
  for (const id of ids) {
    const f = join(IMG_DIR, `${id}.bin`);
    try {
      const have = Object.values(EXT).map(x => `memo-${id}.${x}`).find(n => existsSync(join(ATT_DIR, n)));
      if (have) { link[id] = `![[${have}]]`; continue; }
      if (!existsSync(f)) throw new Error('아직 없음');
      const raw = new Uint8Array(readFileSync(f)), pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, KEYOBJ, raw.slice(12)));
      const name = `memo-${id}.${EXT[pt[0]] || 'jpg'}`;
      mkdirSync(ATT_DIR, { recursive: true }); writeFileSync(join(ATT_DIR, name), pt.slice(1)); link[id] = `![[${name}]]`;
      console.log(`이미지: Attachments/${name}`);
    } catch { link[id] = `_(이미지 ${id} 처리 대기)_`; }
  }
  return t.replace(IMG_RE, (_, id) => link[id]);
}
const box = (t, mark) => String(t || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => `- [${mark}] ${l.replace(/^(?:[-*•]\s+)?(?:\[[ xX\/-]\]\s*)?/, '')}`);
const front = (key, kind, savedAt, tags) => ['---', `week: ${key}`, `period: ${ymd(weekStart(key))} ${hm(weekStart(key))} ~ ${ymd(weekEnd(key))} ${hm(weekEnd(key))}`, `saved: ${savedAt}`, '보안: 개인정보', `tags: [${tags}]`, 'source: 메모 앱 (Actions가 매일 05:00·22:00에 기록)', `memo-app: ${kind}`, '---', ''];
function memoNote(key, w, savedAt) {
  const done = box(w.completed, 'x'), todo = box(w.todo, ' '), refer = textOfWeek(w).trim();
  return [...front(key, 'memo', savedAt, '메모앱'), `# ${key} 메모`, '', '> 메모 앱 내용의 사본입니다. 앱이 바뀐 내용을 다시 씁니다 — 여기서 고치지 말고 앱에서 고치세요.', '',
    '## ✅ Completed Tasks', '', ...(done.length ? done : ['_없음_']), '',
    '## 📋 To do List', '', ...(todo.length ? todo : ['_없음_']), '',
    '## 📝 Refer', '', refer || '_없음_', ''].join('\n');
}
function thinkNote(key, w, savedAt) {   // 내 문장은 고치지 않고 그대로
  return [...front(key, 'thinking', savedAt, '메모앱, 생각'), `# ${key} Thinking`, '', '> 메모 앱 Thinking 칸의 사본입니다. 앱이 바뀐 내용을 다시 씁니다 — 여기서 고치지 말고 앱에서 고치세요.', '',
    thinkOfWeek(w).trim() || '_없음_', ''].join('\n');
}

const cur = isoWeek(), prev = isoWeek(new Date(weekStart(cur).getTime() - 864e5)), now = new Date();
function put(kind, key, defaultPath, gen, hash, savedAt) {
  const found = findNote(kind, key), file = found || defaultPath, ex = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const rel = file.slice(outRoot.length).replace(/^\/+/, '');
  if (ex !== null && hashInNote(ex) === hash) { console.log(`그대로: ${rel}`); return; }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, merge(gen(savedAt), ex, hash));
  console.log(`${ex === null ? '작성' : '갱신'}: ${rel}`);
}
for (const key of [prev, cur]) {
  const w = db.weeks?.[key]; if (!w) continue;
  const saved = w.updated || w.todoUpdated || w.completedUpdated || w.thinkingUpdated ? (d => `${ymd(d)} ${hm(d)}`)(new Date([w.updated, w.todoUpdated, w.completedUpdated, w.thinkingUpdated].filter(Boolean).sort().pop())) : `${ymd(now)} ${hm(now)}`;
  const h = (...p) => createHash('sha1').update(p.join('\0')).digest('hex').slice(0, 10);
  const referT = await withImages(textOfWeek(w)), thinkT = await withImages(thinkOfWeek(w));   // 이미지는 링크로 바꾼 본문 기준으로 비교(이미지가 늦게 올라오면 다음 실행에 반영)
  if ([w.completed, w.todo, textOfWeek(w)].some(t => String(t || '').trim()) || findNote('memo', key))
    put('memo', key, join(outRoot, FOLDER, `${key} 메모.md`), sv => memoNote(key, { ...w, text: referT }, sv), h('inbox-v2', w.completed || '', w.todo || '', referT), saved);
  if (thinkOfWeek(w).trim() || findNote('thinking', key))
    put('thinking', key, join(outRoot, THINK_FOLDER, `${key} Thinking.md`), sv => thinkNote(key, { ...w, thinking: thinkT }, sv), h('think-v1', thinkT), saved);
}
