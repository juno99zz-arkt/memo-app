// 검증된 제안만 암호화 메모장에 추가한다. 기존 문장·완료 항목은 보존한다.
import {readFileSync,writeFileSync} from 'node:fs';
import {webcrypto as crypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const normalize=t=>String(t).replace(/⟨t:[0-9a-f]+⟩/g,'').replace(/^(?:[-*•]\s*)?(?:\[[ xX/\-]\]\s*)?(?:(?:준비|진행|완료|보류)\s*[:：.\-]?\s+)?/,'').replace(/\s*·\s*(?:~|메일|통화|AI|생각|Inbox|노트).*$/,'').replace(/\s+/g,' ').trim();
export function apply(db, proposal, now=new Date()){
  if(!Array.isArray(proposal.items)||!Number.isFinite(Date.parse(proposal.generated))||now-new Date(proposal.generated)>36*36e5||new Date(proposal.generated)-now>5*6e4)throw Error('제안 형식 또는 최신성 오류');
  const shifted=new Date(now.getTime()-5*36e5),t=new Date(shifted.getFullYear(),shifted.getMonth(),shifted.getDate());
  t.setDate(t.getDate()-((t.getDay()+6)%7)+3);
  const y=t.getFullYear(),jan4=new Date(y,0,4),w=1+Math.round(((t-jan4)/864e5-3+((jan4.getDay()+6)%7))/7);
  const key=y+'-W'+String(w).padStart(2,'0'),week=db.weeks?.[key]||{};
  if(week.todoUpdated && now-new Date(week.todoUpdated)<15*6e4)return {added:0,reason:'사용자 편집 중'};
  const all=Object.values(db.weeks||{}).flatMap(x=>[x.todo||'',x.completed||'']).join('\n');
  const tags=new Set([...all.matchAll(/⟨t:([0-9a-f]{6})⟩/g)].map(m=>m[1]));
  const texts=new Set(all.split('\n').map(normalize).filter(Boolean));
  const seen={...(db.noji_applied||{})},lines=[];
  for(const it of proposal.items.slice(0,10)){
    if(it.confirmed!==true || /(n8n|메신저봇|kakaoobsidian|kakaomessenger)/i.test(it.text) || (it.due && (!/^20\d\d-\d\d-\d\d$/.test(it.due) || new Date(it.due+'T23:59:59+09:00')<now)) || !/^[0-9a-f]{6}$/.test(it.id)||it.kind!=='todo'||(it.owner&&it.owner!=='나')||typeof it.text!=='string'||!it.text.trim()||/[\r\n]/.test(it.text))continue;
    if(seen[it.id]||tags.has(it.id)||texts.has(normalize(it.text)))continue;
    lines.push('준비 '+it.text+(it.due?' · ~'+it.due:'')+' · '+String(it.source||'노트').replace(/[\r\n]/g,'')+' ⟨t:'+it.id+'⟩');
    seen[it.id]=now.toISOString();texts.add(normalize(it.text));
  }
  if(!lines.length)return {added:0,reason:'새 항목 없음'};
  db.weeks??={};db.weeks[key]={...week,todo:[week.todo||'',...lines].filter(Boolean).join('\n'),todoUpdated:now.toISOString()};
  db.noji_applied=seen;
  return {added:lines.length,week:key};
}
async function keyFor(file,password){
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:Buffer.from(file.kdf.salt,'base64'),iterations:file.kdf.iter},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [file,proposalPath]=process.argv.slice(2),password=process.env.MEMO_PASSWORD;
  if(!password)throw Error('MEMO_PASSWORD 없음');
  const envelope=JSON.parse(readFileSync(file,'utf8')),key=await keyFor(envelope,password);
  const db=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(envelope.iv,'base64')},key,Buffer.from(envelope.ct,'base64'))));
  const result=apply(db,JSON.parse(readFileSync(proposalPath,'utf8')));
  if(result.added){
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(db)));
    writeFileSync(file,JSON.stringify({...envelope,iv:Buffer.from(iv).toString('base64'),ct:Buffer.from(ct).toString('base64')}));
  }
  console.log('할 일 추가 '+result.added+'개'+(result.reason?' · '+result.reason:''));
}
