// 피클 아침 브리핑 ⑤ 어젯밤 전화영어 복습 — 볼트 저장소 english-coach가 만든 .noji/english/index.json을 읽는다
// 화·목 밤 수업 → 수·금 아침에 나온다. 이틀 안 수업이 없으면 빈 배열(구역 생략).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function englishBrief(outRoot, now = new Date()) {
  const p = join(outRoot, '.noji', 'english', 'index.json');
  if (!existsSync(p)) return [];
  let sessions;
  try { sessions = JSON.parse(readFileSync(p, 'utf8')).sessions || []; } catch { return []; }
  const since = new Date(now); since.setDate(since.getDate() - 2);
  const s = sessions.filter(x => x.date >= ymd(since) && x.date <= ymd(now)).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!s) return [];
  const y = new Date(now); y.setDate(y.getDate() - 1);
  const when = s.date === ymd(y) ? '어젯밤' : `${+s.date.slice(5, 7)}/${+s.date.slice(8, 10)}`;
  // 누적 자주 나온 실수 (최근 8회 수업)
  const count = {};
  sessions.slice(0, 8).forEach(x => (x.corrections || []).forEach(c => { count[c.pattern] = (count[c.pattern] || 0) + 1; }));
  const top = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, n]) => n > 1);
  const L = [
    `## ⑤ ${when} 전화영어 복습 (${s.date})`, '',
    '> 사용자 본인의 수업 기록입니다. 요약을 한두 문장으로 말하고, 교정 문장은 영어를 천천히 읽은 뒤 사용자가 따라 말할 수 있게 잠깐 멈추세요. 끝에 오늘의 표현과 다음 수업 연습을 짧게 전하세요.', '',
    `**한 줄**: ${s.headline}${s.tutor ? ` (강사 ${s.tutor})` : ''}`, '',
    '**다시 말해보기**',
    ...(s.corrections || []).slice(0, 3).map((c, i) => `${i + 1}. 내가 한 말 "${c.said}" → "${c.better}" — ${c.why}`), '',
    '**오늘의 표현**',
    ...(s.expressions || []).slice(0, 3).map(e => `- ${e.en} — ${e.ko}`), '',
    ...((s.next || []).length ? ['**다음 수업에서**', ...s.next.slice(0, 2).map(x => `- ${x}`), ''] : []),
    ...(top.length ? [`**요즘 자주 나오는 실수**: ${top.map(([k, n]) => `${k} ${n}회`).join(' · ')}`, ''] : []),
    `전체 교정 ${(s.corrections || []).length}개는 옵시디언 \`3. Area of Responsibility/전화영어/${s.date} 전화영어 복습\`과 전화영어 복습 웹앱에 있습니다.`, ''];
  return L;
}
