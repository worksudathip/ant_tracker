import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
const TH=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
const THF=['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
const REG=['BKK','CR','ER','NER','NR','SR'];
const TYPES=['ANT AWN','Microwave','ANT DTAC'];
const mL=k=>{const[y,m]=k.split('-');return TH[+m-1]+' '+y.slice(2)};
const mLF=k=>{const[y,m]=k.split('-');return THF[+m-1]+' '+y};
const mNext=k=>{let[y,m]=k.split('-').map(Number);m++;if(m>12){m=1;y++}return y+'-'+String(m).padStart(2,'0')};
const mPrev=k=>{let[y,m]=k.split('-').map(Number);m--;if(m<1){m=12;y--}return y+'-'+String(m).padStart(2,'0')};
const fmt=n=>n==null||n===''?'':Number(n).toLocaleString('en-US');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=id=>document.getElementById(id);
const sum=a=>a.reduce((x,y)=>x+y,0);

let D, R=[], N=0, MONTHS, BASE, BASEIDX, BASE_ROWS=[], KEYIDX=new Map(), CH={};
let base; // {ant:[Int32Array x3], now:Int32Array, st:Array}
let STATE={}; // month -> state
let store={mode:'db',changes:new Map(),months:new Map(),extras:new Map()};
let canWrite=false, conn='pending', ME=null, PROFILES=new Map();
const downloads={save:async({filename,data})=>{const url=URL.createObjectURL(data);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);return{status:'saved'}}};
const sb=createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
let WORK, CLOSED=[];
let names={};

/* ---------- load ---------- */
async function boot(data){
  D=data;
  MONTHS=D.months; BASE=MONTHS[MONTHS.length-1]; BASEIDX=MONTHS.length-1;
  const c=D.cols, dc=D.dicts;
  const occ=new Map();
  D.rows.forEach((r,i)=>{
    const o={i};
    c.forEach((k,j)=>{o[k]=dc[k]?dc[k][r[j]]:r[j]});
    o.ev=D.events[i]||{};
    o.key=(o.sc+' '+o.nm+' '+o.lid+' '+o.pv).toLowerCase();
    o.k=nextKey(occ,o.lid,o.sc,o.an);
    o.b=splitAt(o,BASEIDX)||[0,0,0];
    // capacity from Jul-69 quarterly data
    const j=splitAt(o,MONTHS.indexOf('2569-07'));
    const tj=j?j[0]+j[1]+j[2]:0;
    o.cap = o.remark==='full cap' ? tj : (o.avail!=null ? o.avail+tj : null);
    BASE_ROWS.push(o);
  });
  await loadStore();
  $('boot').classList.add('hide');
  rebuildRows(); initFilters(); recomputeNow(); route();
  window.addEventListener('hashchange',route);
  document.addEventListener('pointerdown',ev=>{if(!ev.target.closest('.chart'))document.querySelectorAll('.chart .tip').forEach(t=>t.style.display='none')});
  let rw=window.innerWidth,rt=null;window.addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(()=>{if(Math.abs(window.innerWidth-rw)>20){rw=window.innerWidth;renderOverview()}},200)});
  connect();
}
function splitAt(o,mi){let v=null;for(const e of o.hist){if(e[0]<=mi)v=e;else break}return v?[v[1],v[2],v[3]]:null}
function nextKey(occ,lid,sc,an){const b=`${lid}|${String(sc??'').trim().toUpperCase()}|${String(an??'').trim().toUpperCase()}`;const n=(occ.get(b)||0)+1;occ.set(b,n);return b+'|'+n}
function safeId(k){return k.replace(/[^A-Za-z0-9_.~:@+-]/g,'-')}
// rows = original rows + sites added later (from imported files)
function rebuildRows(){
  const ex=[...store.extras.values()].filter(e=>e&&e.k).sort((a,b)=>(a.from+a.k).localeCompare(b.from+b.k));
  R=BASE_ROWS.slice();const have=new Set(R.map(o=>o.k));
  for(const e of ex){if(have.has(e.k))continue;have.add(e.k);
    const o=Object.assign({},e,{i:R.length,hist:[],ev:{},cap:null,avail:null,remark:'',totArea:'',status:'',extra:true,b:[0,0,0]});
    o.key=(o.sc+' '+o.nm+' '+o.lid+' '+o.pv).toLowerCase();R.push(o)}
  N=R.length;KEYIDX=new Map(R.map(o=>[o.k,o.i]));
  base={ant:[new Int32Array(N),new Int32Array(N),new Int32Array(N)],now:new Int32Array(N),st:new Array(N)};
  for(const o of R){const i=o.i;if(o.extra){base.st[i]='';continue}
    base.ant[0][i]=o.b[0];base.ant[1][i]=o.b[1];base.ant[2][i]=o.b[2];base.now[i]=o.now;base.st[i]=o.st||''}
}

/* ---------- persistence (Supabase) ---------- */
const chKey=(m,k)=>m+'|'+k;
function rowToCh(r){return{month:r.month,k:r.k,row:r.row_idx,sc:r.sc,lid:r.lid,rm:r.rm||[0,0,0],ins:r.ins||[0,0,0],note:r.note||'',tower:!!r.tower,now:r.now_val,st:r.st,by:r.updated_by||r.created_by,at:r.updated_at,src:r.src,file:r.file}}
function chToRow(c){return{month:c.month,k:c.k,row_idx:c.row??null,sc:c.sc??null,lid:c.lid!=null?String(c.lid):null,rm:(c.rm||[0,0,0]).map(v=>v|0),ins:(c.ins||[0,0,0]).map(v=>v|0),note:c.note||'',tower:!!c.tower,now_val:c.now??null,st:c.st??null,src:c.src||'manual',file:c.file||null}}
function dbErr(error){const e=new Error(error.message||'error');e.code=error.code;if(error.code==='42501'){e.message='ไม่มีสิทธิ์บันทึก (ต้องเป็นผู้บันทึกหรือผู้ดูแล)'}return e}
async function fetchAll(table){const out=[];const P=1000;for(let from=0;;from+=P){const{data,error}=await sb.from(table).select('*').range(from,from+P-1);if(error)throw dbErr(error);out.push(...data);if(data.length<P)break}return out}
async function loadStore(){
  const[ch,ms,ex]=await Promise.all([fetchAll('changes'),fetchAll('months'),fetchAll('extra_sites')]);
  store.changes=new Map(ch.map(r=>[chKey(r.month,r.k),rowToCh(r)]));
  store.months=new Map(ms.map(r=>[r.month,{closed:r.closed,at:r.closed_at,by:r.closed_by}]));
  store.extras=new Map(ex.map(r=>[r.k,Object.assign({},r.data,{k:r.k,from:r.from_month})]));
}
let rtTimer=null;
function connect(){
  conn='db';renderMode();
  const apply=(table,p)=>{
    const n=p.new&&Object.keys(p.new).length?p.new:null,o=p.old||{};
    if(table==='changes'){if(p.eventType==='DELETE')store.changes.delete(chKey(o.month,o.k));else store.changes.set(chKey(n.month,n.k),rowToCh(n));recompute()}
    else if(table==='months'){if(p.eventType==='DELETE')store.months.delete(o.month);else store.months.set(n.month,{closed:n.closed,at:n.closed_at,by:n.closed_by});recompute()}
    else if(table==='extra_sites'){if(p.eventType==='DELETE')store.extras.delete(o.k);else store.extras.set(n.k,Object.assign({},n.data,{k:n.k,from:n.from_month}));rebuildRows();recompute()}
    else if(table==='profiles'){if(n){PROFILES.set(n.id,n);if(n.id===ME.id&&n.role!==ME.role)location.reload()}if(isAdmin())renderAdmin()}
  };
  const ch=sb.channel('awn-db');
  ['changes','months','extra_sites','profiles'].forEach(t=>ch.on('postgres_changes',{event:'*',schema:'public',table:t},p=>apply(t,p)));
  ch.subscribe(status=>{
    if(status==='SUBSCRIBED'){setSync('ok',canWrite?'ออนไลน์ · อัปเดตอัตโนมัติ':'ออนไลน์ · ดูอย่างเดียว');
      // catch up anything missed while (re)connecting
      clearTimeout(rtTimer);rtTimer=setTimeout(()=>loadStore().then(()=>{rebuildRows();recomputeNow()}).catch(()=>{}),300)}
    else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED')setSync('warn','การอัปเดตอัตโนมัติขาดหาย — กดรีเฟรชหน้า');
  });
}
function renderMode(){
  const el=$('modeNote');if(!el)return;document.body.classList.toggle('ro',!canWrite);
  el.innerHTML=!canWrite?'<div class="msg info">บัญชีนี้มีสิทธิ์ “ผู้ดู” — ดูข้อมูลและดาวน์โหลดรายงานได้ หากต้องบันทึก ให้ขอสิทธิ์ “ผู้บันทึก” จากผู้ดูแลระบบ</div>':'';
}
function setSync(k,t){$('syncDot').className='dot '+k;$('syncTxt').textContent=t}
async function putExtra(id,obj){
  const{error}=await sb.from('extra_sites').upsert({k:obj.k,from_month:obj.from,data:obj},{onConflict:'k'});if(error)throw dbErr(error);
  store.extras.set(obj.k,obj);rebuildRows();recomputeNow();
}
async function putChanges(list){
  for(let i=0;i<list.length;i+=500){const part=list.slice(i,i+500);
    const{error}=await sb.from('changes').upsert(part.map(chToRow),{onConflict:'month,k'});if(error)throw dbErr(error);
    part.forEach(c=>store.changes.set(chKey(c.month,c.k),Object.assign({},c,{by:ME.id,at:new Date().toISOString()})))}
  recompute();
}
async function putChange(id,obj){await putChanges([obj])}
async function delChange(id){
  const c=store.changes.get(id);if(!c)return;
  const{error}=await sb.from('changes').delete().eq('month',c.month).eq('k',c.k);if(error)throw dbErr(error);
  store.changes.delete(id);recompute();
}
async function putMonth(m,obj){
  const row={month:m,closed:!!obj.closed,closed_at:obj.closed?new Date().toISOString():null,closed_by:obj.closed?ME.id:null};
  const{error}=await sb.from('months').upsert(row,{onConflict:'month'});if(error)throw dbErr(error);
  store.months.set(m,{closed:row.closed,at:row.closed_at,by:row.closed_by});recompute();
}
async function myId(){return ME?ME.id:null}
function isAdmin(){return ME&&ME.role==='admin'}
function nameOf(id){const p=PROFILES.get(id);return p?(p.full_name||p.email||''):''}

/* ---------- state engine ---------- */
function changesOf(m){const a=[];for(const[id,c] of store.changes){if(c.month!==m)continue;const row=c.k!=null&&KEYIDX.has(c.k)?KEYIDX.get(c.k):c.row;if(row==null||row>=N)continue;a.push(Object.assign({id},c,{row}))}return a}
function chId(m,o){return chKey(m,o.k)}
function getCh(m,i){return (CH[m]||new Map()).get(i)}
function cloneState(s){return{ant:s.ant.map(a=>a.slice()),now:s.now.slice(),st:s.st.slice()}}
function applyMonth(s,m){
  const t=cloneState(s);
  for(const o of R){if(o.extra&&o.from===m){const i=o.i;for(let j=0;j<3;j++)t.ant[j][i]=o.init?.[j]||0;t.now[i]=o.nowInit||0;t.st[i]=o.stInit||''}}
  for(const c of changesOf(m)){const r=c.row;
    for(let j=0;j<3;j++)t.ant[j][r]+=(c.ins?.[j]||0)-(c.rm?.[j]||0);
    if(c.tower){t.now[r]=0;t.st[r]='เสารื้อถอนแล้ว'}
    if(c.now!=null)t.now[r]=c.now;
    if(c.st!=null)t.st[r]=c.st;}
  return t;
}
let rcT=null;
function recompute(){clearTimeout(rcT);rcT=setTimeout(recomputeNow,120)}
function recomputeNow(){
  CLOSED=[];let m=BASE;
  while(store.months.get(mNext(m))?.closed){m=mNext(m);CLOSED.push(m)}
  WORK=mNext(m);
  CH={};for(const c of [...CLOSED,WORK])CH[c]=new Map(changesOf(c).map(x=>[x.row,x]));
  STATE={};STATE[BASE]=base;let prev=base;
  for(const c of [...CLOSED,WORK]){STATE[c]=applyMonth(prev,c);prev=STATE[c]}
  $('workPill').textContent='เดือนที่บันทึก: '+mLF(WORK);
  $('recBadge').textContent=changesOf(WORK).length;
  renderAll();
}
function allMonths(){return [...MONTHS,...CLOSED,WORK]}
// totals for a month: {nw,mw,dt,total,towers,rm,ins,sitesRm,sitesIn,reg:{}}
function monthTotals(m){
  const mi=MONTHS.indexOf(m);
  if(mi>=0){
    const rm=D.regionMonth[m]; const meta=D.meta.find(x=>x.month===m);
    const reg={};let a=[0,0,0];
    for(const g of REG){const v=rm[g]||[0,0,0];reg[g]=v[0]+v[1]+v[2];a=a.map((x,j)=>x+v[j])}
    let sr=0,si=0;for(const o of R){const e=o.ev[m];if(e){if(e[0])sr++;if(e[1])si++}}
    return{nw:a[0],mw:a[1],dt:a[2],total:a[0]+a[1]+a[2],towers:meta?meta.towers:(m===MONTHS[0]?11449:null),rm:meta?meta.rm:null,ins:meta?meta.in:null,sitesRm:meta?sr:null,sitesIn:meta?si:null,reg};
  }
  const s=STATE[m];if(!s)return null;
  const reg={};REG.forEach(g=>reg[g]=0);let a=[0,0,0],tw=0;
  for(let i=0;i<N;i++){const t=s.ant[0][i]+s.ant[1][i]+s.ant[2][i];a[0]+=s.ant[0][i];a[1]+=s.ant[1][i];a[2]+=s.ant[2][i];reg[R[i].rg]=(reg[R[i].rg]||0)+t;tw+=s.now[i]}
  let rm=0,ins=0,sr=0,si=0;for(const c of changesOf(m)){const x=sum(c.rm||[]),y=sum(c.ins||[]);rm+=x;ins+=y;if(x)sr++;if(y)si++}
  return{nw:a[0],mw:a[1],dt:a[2],total:a[0]+a[1]+a[2],towers:tw,rm,ins,sitesRm:sr,sitesIn:si,reg};
}
function rowAt(i,m){ // split [nw,mw,dt] for row i at month m
  if(R[i].extra&&m<R[i].from)return null;
  const mi=MONTHS.indexOf(m);
  if(mi>=0)return splitAt(R[i],mi);
  const s=STATE[m];return s?[s.ant[0][i],s.ant[1][i],s.ant[2][i]]:null;
}
function prevMonthState(m){return m===mNext(BASE)?base:STATE[mPrev(m)]}

/* ---------- routing ---------- */
const VIEWS=['overview','sites','record','reports','checks','admin'];
function route(){
  if(typeof closeModal==='function')closeModal();
  let v=VIEWS.includes(location.hash.slice(1))?location.hash.slice(1):'overview';
  if(v==='admin'&&!isAdmin())v='overview';
  VIEWS.forEach(x=>{$('v-'+x).classList.toggle('on',x===v)});
  document.querySelectorAll('#tabs a').forEach(a=>a.classList.toggle('on',a.dataset.v===v));
  if(v==='overview')renderOverview();
  if(v==='admin'){renderAdmin();loadAudit()}
}
function renderAll(){
  renderOverview();renderSites();renderRecord();renderReports();renderChecks();renderAdmin();
}

/* ---------- charts ---------- */
function niceTicks(min,max,n){const span=max-min||1;const step0=span/n;const mag=Math.pow(10,Math.floor(Math.log10(step0)));const s=[1,2,2.5,5,10].map(x=>x*mag).find(x=>x>=step0);const lo=Math.floor(min/s)*s,hi=Math.ceil(max/s)*s;const t=[];for(let v=lo;v<=hi+1e-9;v+=s)t.push(v);return t}
function tipAt(el,html,x,y){let t=el.querySelector('.tip');if(!t){t=document.createElement('div');t.className='tip';el.appendChild(t)}t.innerHTML=html;t.style.display='block';const w=el.clientWidth;const tw=t.offsetWidth;t.style.left=Math.min(Math.max(x-tw/2,0),w-tw)+'px';t.style.top=(y-t.offsetHeight-10)+'px'}
function tipHide(el){const t=el.querySelector('.tip');if(t)t.style.display='none'}
function lineChart(el,labels,vals,draftIdx){
  const W=Math.max(300,Math.round(el.clientWidth||560)),H=W<520?210:240,L=W<520?48:58,Rr=14,T=14,B=30;const pw=W-L-Rr,ph=H-T-B;
  const v=vals.filter(x=>x!=null);const ticks=niceTicks(Math.min(...v),Math.max(...v),4);const lo=ticks[0],hi=ticks[ticks.length-1];
  const X=i=>L+(labels.length===1?pw/2:i*pw/(labels.length-1)),Y=x=>T+ph-(x-lo)/(hi-lo)*ph;
  let s=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Total ANT รายเดือน">`;
  ticks.forEach(t=>{s+=`<line x1="${L}" x2="${W-Rr}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${L-8}" y="${Y(t)+4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(t)}</text>`});
  const lstep=Math.ceil(labels.length*46/pw);labels.forEach((l,i)=>{if((labels.length-1-i)%lstep===0)s+=`<text x="${X(i)}" y="${H-8}" text-anchor="middle" font-size="11" fill="var(--muted)">${l}</text>`});
  const solid=vals.map((x,i)=>[X(i),Y(x)]).slice(0,draftIdx==null?vals.length:draftIdx);
  s+=`<polyline fill="none" stroke="var(--s1)" stroke-width="2" points="${solid.map(p=>p.join(',')).join(' ')}"/>`;
  if(draftIdx!=null&&draftIdx>0){s+=`<line x1="${X(draftIdx-1)}" y1="${Y(vals[draftIdx-1])}" x2="${X(draftIdx)}" y2="${Y(vals[draftIdx])}" stroke="var(--s1)" stroke-width="2" stroke-dasharray="4 4"/>`}
  vals.forEach((x,i)=>{s+=`<circle cx="${X(i)}" cy="${Y(x)}" r="${i===vals.length-1?4.5:3}" fill="${i===draftIdx?'var(--surface)':'var(--s1)'}" stroke="var(--s1)" stroke-width="2"/>`});
  const last=vals.length-1;s+=`<text x="${X(last)}" y="${Y(vals[last])-10}" text-anchor="end" font-size="12" font-weight="600" fill="var(--text)">${fmt(vals[last])}</text>`;
  s+=`<line id="xh" x1="0" x2="0" y1="${T}" y2="${T+ph}" stroke="var(--line-2)" visibility="hidden"/>`;
  s+=`<rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent" class="hit"/></svg>`;
  el.innerHTML=s;
  const svg=el.querySelector('svg'),hit=svg.querySelector('.hit'),xh=svg.querySelector('#xh');
  const mv=ev=>{const r=svg.getBoundingClientRect();const sx=(ev.clientX-r.left)*W/r.width;let i=Math.round((sx-L)/pw*(labels.length-1));i=Math.max(0,Math.min(labels.length-1,i));xh.setAttribute('x1',X(i));xh.setAttribute('x2',X(i));xh.setAttribute('visibility','visible');const d=i>0?vals[i]-vals[i-1]:null;tipAt(el,`<b>${labels[i]}${i===draftIdx?' (กำลังบันทึก)':''}</b>Total ANT ${fmt(vals[i])}${d!=null?`<br><span class="muted">เทียบเดือนก่อน ${d>0?'+':''}${fmt(d)}</span>`:''}`,X(i)*r.width/W,Y(vals[i])*r.height/H)};
  hit.addEventListener('pointermove',mv);hit.addEventListener('pointerdown',mv);
  hit.addEventListener('pointerleave',ev=>{if(ev.pointerType==='touch')return;xh.setAttribute('visibility','hidden');tipHide(el)});
}
function barChart(el,labels,a,b){
  const W=Math.max(300,Math.round(el.clientWidth||560)),H=W<520?210:240,L=40,Rr=10,T=14,B=30;const pw=W-L-Rr,ph=H-T-B;
  const mx=Math.max(1,...a.map(x=>x||0),...b.map(x=>x||0));const ticks=niceTicks(0,mx,4);const hi=ticks[ticks.length-1];
  const bw=pw/labels.length;const w=Math.min(16,(bw-8)/2);const Y=x=>T+ph-(x/hi)*ph;
  let s=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="รื้อถอนและติดตั้งรายเดือน">`;
  ticks.forEach(t=>{s+=`<line x1="${L}" x2="${W-Rr}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${L-8}" y="${Y(t)+4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(t)}</text>`});
  const bar=(x,v,col)=>{if(!v)return'';const y=Y(v),h=T+ph-y;const r=Math.min(4,h);return`<path d="M${x},${T+ph} V${y+r} q0,-${r} ${r},-${r} h${w-2*r} q${r},0 ${r},${r} V${T+ph} Z" fill="${col}"/>`};
  const bstep=Math.ceil(46/bw);labels.forEach((l,i)=>{const cx=L+bw*i+bw/2;s+=bar(cx-w-1,a[i],'var(--s2)')+bar(cx+1,b[i],'var(--s3)');if((labels.length-1-i)%bstep===0)s+=`<text x="${cx}" y="${H-8}" text-anchor="middle" font-size="11" fill="var(--muted)">${l}</text>`;s+=`<rect x="${L+bw*i}" y="${T}" width="${bw}" height="${ph}" fill="transparent" data-i="${i}" class="hit"/>`});
  s+=`<line x1="${L}" x2="${W-Rr}" y1="${T+ph}" y2="${T+ph}" stroke="var(--line-2)"/></svg>`;
  el.innerHTML=s;const svg=el.querySelector('svg');
  svg.querySelectorAll('.hit').forEach(h=>{const mv=()=>{const i=+h.dataset.i;const r=svg.getBoundingClientRect();tipAt(el,`<b>${labels[i]}</b>รื้อถอน ${fmt(a[i]||0)} ANT<br>ติดตั้งเพิ่ม ${fmt(b[i]||0)} ANT`,(L+bw*i+bw/2)*r.width/W,Y(Math.max(a[i]||0,b[i]||0))*r.height/H)};h.addEventListener('pointermove',mv);h.addEventListener('pointerdown',mv);h.addEventListener('pointerleave',ev=>{if(ev.pointerType!=='touch')tipHide(el)})});
}

/* ---------- overview ---------- */
function renderOverview(){
  if(!$('v-overview').classList.contains('on'))return;
  const ms=allMonths().filter(m=>m>='2569-01'||m===BASE);
  const last=CLOSED.length?CLOSED[CLOSED.length-1]:BASE;
  const T=monthTotals(last),P=monthTotals(mPrev(last)),W=monthTotals(WORK);
  $('ovSub').textContent=`ข้อมูลล่าสุดที่ปิดแล้ว: ${mLF(last)} · กำลังบันทึก ${mLF(WORK)} (${changesOf(WORK).length} รายการ)`;
  const d=(a,b)=>{if(b==null)return'';const x=a-b;return x===0?'ไม่เปลี่ยน':`<span class="${x<0?'neg':'pos'}">${x>0?'+':''}${fmt(x)}</span> จากเดือนก่อน`};
  const k=(l,v,pv)=>`<div class="card kpi"><div class="lbl">${l}</div><div class="val num">${fmt(v)}</div><div class="dl">${d(v,pv)}</div></div>`;
  $('kpis').innerHTML=k('จำนวน Tower เช่า ณ ปัจจุบัน',T.towers,P?.towers)+k('ANT AWN',T.nw,P?.nw)+k('Microwave',T.mw,P?.mw)+k('ANT DTAC',T.dt,P?.dt)+k('Total ANT · '+mL(last),T.total,P?.total)
   +`<div class="card kpi" style="border-color:var(--accent)"><div class="lbl">ร่าง ${mL(WORK)} (ยังไม่ปิดเดือน)</div><div class="val num">${fmt(W.total)}</div><div class="dl">รื้อถอน ${fmt(W.rm)} · ติดตั้ง ${fmt(W.ins)} ANT</div></div>`;
  const tots=ms.map(m=>monthTotals(m));
  lineChart($('chTotal'),ms.map(mL),tots.map(t=>t.total),ms.length-1);
  const fm=ms.filter(m=>m!==BASE||MONTHS.indexOf(m)>0).slice(-12);
  const ft=fm.map(m=>monthTotals(m));
  barChart($('chFlow'),fm.map(mL),ft.map(t=>t.rm),ft.map(t=>t.ins));
  // region table
  const show=allMonths().slice(-7);const st=show.map(m=>monthTotals(m));
  let h=`<thead><tr><th>ภาค</th>${show.map(m=>`<th class="r">${mL(m)}${m===WORK?' <span class="badge info">ร่าง</span>':''}</th>`).join('')}<th class="r">เปลี่ยนแปลง (${mL(show[0])}→${mL(show[show.length-1])})</th></tr></thead><tbody>`;
  for(const g of REG){const a=st.map(t=>t.reg[g]);const dd=a[a.length-1]-a[0];h+=`<tr><td>${g}</td>${a.map(v=>`<td class="r num">${fmt(v)}</td>`).join('')}<td class="r num" style="color:${dd<0?'var(--bad)':dd>0?'var(--good)':'inherit'}">${dd>0?'+':''}${fmt(dd)}</td></tr>`}
  const a=st.map(t=>t.total);const dd=a[a.length-1]-a[0];
  h+=`<tr class="total"><td>Total</td>${a.map(v=>`<td class="r num">${fmt(v)}</td>`).join('')}<td class="r num">${dd>0?'+':''}${fmt(dd)}</td></tr></tbody>`;
  $('tblRegion').innerHTML=h;
  $('tblYear').innerHTML=yearTableHTML();
}
function yearRows(){
  const rows=D.year.map(r=>({lbl:r[0],tw:r[1],rm:r[2],ins:r[3],awn:r[4],dt:r[5],tot:r[6],sp:r[7]}));
  for(const m of CLOSED){const t=monthTotals(m);rows.push({lbl:mLF(m),tw:t.towers,rm:t.rm,ins:t.ins,awn:t.nw+t.mw,dt:t.dt,tot:t.total,sp:null})}
  const t=monthTotals(WORK);rows.push({lbl:mLF(WORK)+' (ร่าง)',tw:t.towers,rm:t.rm,ins:t.ins,awn:t.nw+t.mw,dt:t.dt,tot:t.total,sp:null,draft:1});
  return rows;
}
function yearTableHTML(){
  let h=`<thead><tr><th>ช่วงเวลา</th><th class="r">Tower</th><th class="r">รื้อถอน</th><th class="r">ติดตั้งเพิ่ม</th><th class="r">AWN คงเหลือ (ANT+MW)</th><th class="r">DTAC</th><th class="r">Total ANT</th><th class="r">Available Space</th></tr></thead><tbody>`;
  for(const r of yearRows())h+=`<tr${r.draft?' style="color:var(--accent)"':''}><td>${esc(r.lbl)}</td><td class="r num">${fmt(r.tw)}</td><td class="r num">${fmt(r.rm)}</td><td class="r num">${fmt(r.ins)}</td><td class="r num">${fmt(r.awn)}</td><td class="r num">${fmt(r.dt)}</td><td class="r num">${fmt(r.tot)}</td><td class="r num">${fmt(r.sp)}</td></tr>`;
  return h+'</tbody>';
}

/* ---------- sites ---------- */
let page=0;const PS=100;
function initFilters(){
  const opt=(sel,vals)=>{vals.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;sel.appendChild(o)})};
  opt($('fRg'),REG);opt($('fPv'),[...new Set(R.map(o=>o.pv))].sort((a,b)=>a.localeCompare(b,'th')));opt($('fTt'),[...new Set(R.map(o=>o.tt))].filter(Boolean).sort());
  ['fQ','fRg','fPv','fTt','fSt'].forEach(id=>$(id).addEventListener('input',()=>{page=0;renderSites()}));
  $('fRg').addEventListener('change',()=>{const g=$('fRg').value;const pv=[...new Set(R.filter(o=>!g||o.rg===g).map(o=>o.pv))].sort((a,b)=>a.localeCompare(b,'th'));$('fPv').innerHTML='<option value="">ทุกจังหวัด</option>';opt($('fPv'),pv)});
  setupRecord();setupReports();
}
function curOf(i){const s=STATE[WORK];return[s.ant[0][i],s.ant[1][i],s.ant[2][i]]}
function prevOf(i){const s=prevMonthState(WORK);return[s.ant[0][i],s.ant[1][i],s.ant[2][i]]}
function availOf(i,a){const o=R[i];if(o.cap==null)return null;return Math.max(o.cap-sum(a),0)}
function renderSites(){
  if(!STATE[WORK])return;
  const q=$('fQ').value.trim().toLowerCase(),g=$('fRg').value,pv=$('fPv').value,tt=$('fTt').value,st=$('fSt').value;
  const chg=new Set(changesOf(WORK).map(c=>c.row));const s=STATE[WORK];
  const list=R.filter(o=>{const i=o.i;if(g&&o.rg!==g)return false;if(pv&&o.pv!==pv)return false;if(tt&&o.tt!==tt)return false;if(q&&!o.key.includes(q))return false;
    const t=s.ant[0][i]+s.ant[1][i]+s.ant[2][i];
    if(st==='active'&&!t)return false;if(st==='zero'&&t)return false;if(st==='removed'&&!String(s.st[i]).includes('เสารื้อถอน'))return false;if(st==='changed'&&!chg.has(i))return false;if(st==='space'&&!(availOf(i,curOf(i))>0))return false;return true});
  const pages=Math.max(1,Math.ceil(list.length/PS));page=Math.min(page,pages-1);
  let h=`<thead><tr><th>SITECODE</th><th>ชื่อสถานี</th><th>จังหวัด</th><th>ภาค</th><th>ประเภท/สูง</th><th class="r">Tower</th><th class="r">ANT AWN</th><th class="r">MW</th><th class="r">DTAC</th><th class="r">Total</th><th class="r">ว่าง</th><th>สถานะ</th></tr></thead><tbody>`;
  for(const o of list.slice(page*PS,page*PS+PS)){const i=o.i;const a=curOf(i),t=sum(a);const av=availOf(i,a);
    h+=`<tr class="click" data-i="${i}"><td><b>${esc(o.sc)}</b></td><td>${esc(o.nm)}</td><td>${esc(o.pv)}</td><td>${o.rg}</td><td>${esc(o.tt)} ${o.hi??''}m</td><td class="r num">${s.now[i]}</td><td class="r num">${a[0]}</td><td class="r num">${a[1]||''}</td><td class="r num">${a[2]||''}</td><td class="r num"><b>${t}</b></td><td class="r num">${av==null?'':av}</td><td>${chg.has(i)?'<span class="badge info">มีรายการ</span> ':''}${String(s.st[i]).includes('เสารื้อถอน')?'<span class="badge">เสารื้อถอนแล้ว</span>':''}</td></tr>`}
  if(!list.length)h+=`<tr><td colspan="12" class="muted" style="padding:30px;text-align:center">ไม่พบสถานีที่ตรงเงื่อนไข</td></tr>`;
  $('tblSites').innerHTML=h+'</tbody>';
  $('tblSites').querySelectorAll('tr.click').forEach(tr=>tr.onclick=()=>openSite(+tr.dataset.i));
  $('pager').innerHTML=`พบ ${fmt(list.length)} รายการ · หน้า ${page+1}/${pages} <button class="btn sm" ${page?'':'disabled'} id="pgP">ก่อนหน้า</button><button class="btn sm" ${page<pages-1?'':'disabled'} id="pgN">ถัดไป</button>`;
  $('pgP').onclick=()=>{page--;renderSites()};$('pgN').onclick=()=>{page++;renderSites()};
}
function openSite(i){
  const o=R[i];const ms=allMonths();
  let rows='';let prev=null;
  for(const m of ms){const a=rowAt(i,m);if(!a){prev=null;continue}const t=sum(a);
    let ev='';const e=o.ev[m];if(e)ev=`${e[0]?`รื้อ ${e[0]}`:''} ${e[1]?`ติดตั้ง ${e[1]}`:''} <span class="muted">${esc(e[2])}</span>`;
    const c=getCh(m,i);if(c)ev=`${sum(c.rm)?`รื้อ ${sum(c.rm)}`:''} ${sum(c.ins)?`ติดตั้ง ${sum(c.ins)}`:''} <span class="muted">${esc(c.note)}</span>`;
    rows=`<tr><td>${mL(m)}${m===WORK?' <span class="badge info">ร่าง</span>':''}</td><td class="r num">${a[0]}</td><td class="r num">${a[1]||''}</td><td class="r num">${a[2]||''}</td><td class="r num"><b>${t}</b></td><td class="r num">${prev!=null&&t!==prev?`<span style="color:${t<prev?'var(--bad)':'var(--good)'}">${t>prev?'+':''}${t-prev}</span>`:''}</td><td>${ev}</td></tr>`+rows;prev=t}
  const s=STATE[WORK];const a=curOf(i);
  $('modal').innerHTML=`<div class="modal-h"><div><h2>${esc(o.sc)} · ${esc(o.nm)}</h2><div class="muted">${esc(o.pv)} · ${o.rg} · ${esc(o.zn)}</div></div><button class="btn sm" id="mClose">ปิด</button></div>
  <div class="kv">
    <div><span>LOCATION ID</span>${o.lid}</div><div><span>ARTICLE</span>${esc(o.an)}</div><div><span>รายละเอียดเสา</span>${esc(o.ad)}</div>
    <div><span>ประเภท / ความสูง</span>${esc(o.tt)} · ${o.hi??'-'} m</div><div><span>Tower ที่เช่า_TOT / ปัจจุบัน</span>${o.tot} / ${s.now[i]}</div>
    <div><span>Available Space (ประมาณ)</span>${availOf(i,a)??'-'}${o.cap!=null?` <span class="muted">(ความจุ ${o.cap})</span>`:''}</div>
    <div><span>สถานะ</span>${esc(s.st[i])||'-'}</div><div><span>STATUS (V.69-7)</span>${esc(o.status)||'-'}</div>
    <div><span>พิกัด</span>${o.lat&&o.lon?`<a href="https://www.google.com/maps?q=${o.lat},${o.lon}" target="_blank" rel="noopener">${o.lat}, ${o.lon}</a>`:'-'}</div>
  </div>
  <h3>ประวัติรายเดือน</h3>
  <div class="tbl-wrap" style="max-height:340px"><table><thead><tr><th>เดือน</th><th class="r">ANT AWN</th><th class="r">MW</th><th class="r">DTAC</th><th class="r">Total</th><th class="r">±</th><th>รายการ</th></tr></thead><tbody>${rows}</tbody></table></div>
  <div class="row" style="margin-top:14px"><button class="btn pri" id="mRec">บันทึกรื้อถอน/ติดตั้ง ${mL(WORK)}</button></div>`;
  $('modalBg').classList.add('on');
  $('mClose').onclick=closeModal;$('mRec').onclick=()=>{closeModal();location.hash='record';pickSite(i)};
}
function closeModal(){$('modalBg').classList.remove('on')}
$('modalBg').addEventListener('click',e=>{if(e.target.id==='modalBg')closeModal()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();$('confirmBg').classList.remove('on')}});
function confirmBox(title,body,okTxt){return new Promise(res=>{$('confirmBox').innerHTML=`<h3>${title}</h3><p class="muted">${body}</p><div class="row" style="justify-content:flex-end"><button class="btn" id="cNo">ยกเลิก</button><button class="btn pri" id="cOk">${okTxt}</button></div>`;$('confirmBg').classList.add('on');$('cNo').onclick=()=>{$('confirmBg').classList.remove('on');res(false)};$('cOk').onclick=()=>{$('confirmBg').classList.remove('on');res(true)}})}

/* ---------- record ---------- */
let SEL=null, acIdx=-1, acItems=[], BULK=[];
const NOTES=['รื้อถอน ANT AWN','ติดตั้ง ANT AWN','รื้อถอน ANT Dtac','รื้อถอน MICROWAVE','รื้อถอน ANT AWN และ รื้อถอน MICROWAVE','ย้ายตำแหน่ง ANT'];
function findSites(q){q=q.trim().toLowerCase();if(q.length<2)return[];const ex=[],st=[],inc=[];for(const o of R){const sc=o.sc.toLowerCase();if(sc===q||String(o.lid)===q)ex.push(o);else if(sc.startsWith(q))st.push(o);else if(o.key.includes(q))inc.push(o);if(ex.length+st.length+inc.length>60)break}return[...ex,...st,...inc].slice(0,30)}
function setupRecord(){
  const inp=$('acIn'),list=$('acList');
  inp.addEventListener('input',()=>{acItems=findSites(inp.value);acIdx=acItems.length?0:-1;drawAc()});
  inp.addEventListener('keydown',e=>{if(list.style.display!=='block')return;if(e.key==='ArrowDown'){acIdx=Math.min(acIdx+1,acItems.length-1);drawAc();e.preventDefault()}else if(e.key==='ArrowUp'){acIdx=Math.max(acIdx-1,0);drawAc();e.preventDefault()}else if(e.key==='Enter'&&acIdx>=0){pickSite(acItems[acIdx].i);e.preventDefault()}});
  document.addEventListener('click',e=>{if(!e.target.closest('.ac'))list.style.display='none'});
  $('noteChips').innerHTML=NOTES.map(n=>`<span class="chip">${n}</span>`).join('');
  $('noteChips').querySelectorAll('.chip').forEach(c=>c.onclick=()=>{$('note').value=c.textContent});
  for(let j=0;j<3;j++){['rm','in'].forEach(p=>$(p+j).addEventListener('input',updForm))}
  $('saveBtn').onclick=saveForm;$('clearBtn').onclick=()=>{SEL=null;$('acIn').value='';$('selSite').innerHTML='';$('formBody').classList.add('hide')};
  $('impFile').addEventListener('change',e=>handleImportFile(e.target.files[0]));
  const card=$('impCard');
  card.addEventListener('dragover',e=>{e.preventDefault();card.classList.add('over')});
  card.addEventListener('dragleave',()=>card.classList.remove('over'));
  card.addEventListener('drop',e=>{e.preventDefault();card.classList.remove('over');handleImportFile(e.dataTransfer.files[0])});
  $('bulkCheck').onclick=checkBulk;$('bulkSave').onclick=saveBulk;$('recQ').addEventListener('input',renderRecTable);
}
function drawAc(){const list=$('acList');if(!acItems.length){list.style.display=$('acIn').value.trim().length>=2?'block':'none';list.innerHTML='<div class="muted">ไม่พบสถานี</div>';return}
  list.innerHTML=acItems.map((o,k)=>`<div data-i="${o.i}" class="${k===acIdx?'hl':''}"><b>${esc(o.sc)}</b> ${esc(o.nm)}<br><small>${o.lid} · ${esc(o.pv)} · ${esc(o.tt)} ${o.hi??''}m · ANT ${sum(curOf(o.i))}</small></div>`).join('');list.style.display='block';
  list.querySelectorAll('div[data-i]').forEach(d=>d.onclick=()=>pickSite(+d.dataset.i))}
function pickSite(i){
  SEL=i;const o=R[i];$('acList').style.display='none';$('acIn').value=o.sc;
  const dup=R.filter(x=>x.sc===o.sc).length;
  $('selSite').innerHTML=`<div class="site-card"><b>${esc(o.sc)}</b> · ${esc(o.nm)}<br><span class="muted">${o.lid} · ${esc(o.pv)} · ${o.rg} · ${esc(o.ad)}</span>${dup>1?`<br><span class="badge warn">SITECODE นี้มี ${dup} แถว (หลายเสา) — กำลังแก้แถวนี้</span>`:''}</div>`;
  const ex=getCh(WORK,i);
  for(let j=0;j<3;j++){$('rm'+j).value=ex?.rm?.[j]||'';$('in'+j).value=ex?.ins?.[j]||''}
  $('note').value=ex?.note||'';$('towerRm').checked=!!ex?.tower;$('formMsg').innerHTML=ex?'<div class="msg info">สถานีนี้มีรายการในเดือนนี้แล้ว — แก้ไขแล้วกดบันทึกเพื่อแทนที่</div>':'';
  $('formBody').classList.remove('hide');updForm();
}
function formVals(){const v=k=>Math.max(0,parseInt($(k).value)||0);return{rm:[0,1,2].map(j=>v('rm'+j)),ins:[0,1,2].map(j=>v('in'+j))}}
function updForm(){if(SEL==null)return;const p=prevOf(SEL),{rm,ins}=formVals();for(let j=0;j<3;j++){$('p'+j).textContent=p[j];const n=p[j]-rm[j]+ins[j];$('n'+j).innerHTML=n<0?`<span style="color:var(--bad)">${n}</span>`:`<b>${n}</b>`}
  if(!$('note').value||NOTES.includes($('note').value)){const parts=[];if(rm[0])parts.push('รื้อถอน ANT AWN');if(rm[1])parts.push('รื้อถอน MICROWAVE');if(rm[2])parts.push('รื้อถอน ANT Dtac');if(ins[0])parts.push('ติดตั้ง ANT AWN');if(ins[1])parts.push('ติดตั้ง MICROWAVE');if(ins[2])parts.push('ติดตั้ง ANT Dtac');if(parts.length)$('note').value=parts.join(' และ ')}}
async function saveForm(){
  if(SEL==null)return;if(!canWrite){$('formMsg').innerHTML='<div class="msg err">บัญชีนี้มีสิทธิ์ดูอย่างเดียว</div>';return}
  const p=prevOf(SEL),{rm,ins}=formVals();const tower=$('towerRm').checked;
  if(!sum(rm)&&!sum(ins)&&!tower){const ex=getCh(WORK,SEL);if(ex){await delChange(ex.id);$('formMsg').innerHTML='<div class="msg ok">ลบรายการของสถานีนี้แล้ว</div>'}else $('formMsg').innerHTML='<div class="msg err">กรุณาใส่จำนวนรื้อถอนหรือติดตั้ง</div>';return}
  for(let j=0;j<3;j++)if(p[j]-rm[j]+ins[j]<0){$('formMsg').innerHTML=`<div class="msg err">${TYPES[j]} รื้อถอนมากกว่าที่มีอยู่ (${p[j]})</div>`;return}
  const o=R[SEL];const by=await myId();
  try{await putChange(getCh(WORK,SEL)?.id||chId(WORK,o),{month:WORK,row:SEL,k:o.k,sc:o.sc,lid:o.lid,rm,ins,note:$('note').value.trim(),tower,by,at:new Date().toISOString()});
    $('formMsg').innerHTML=`<div class="msg ok">บันทึก ${esc(o.sc)} แล้ว</div>`;
    setTimeout(()=>{SEL=null;$('acIn').value='';$('selSite').innerHTML='';$('formBody').classList.add('hide');$('formMsg').innerHTML='';$('acIn').focus()},900);
  }catch(e){$('formMsg').innerHTML=`<div class="msg err">บันทึกไม่สำเร็จ: ${esc(e.message||e.code)}</div>`}
}
function typeIdx(t){t=String(t||'').toLowerCase().replace(/\s/g,'');if(!t||t.startsWith('ant')&&!t.includes('dtac')||t==='awn'||t==='nw')return 0;if(t.startsWith('mw')||t.startsWith('micro'))return 1;if(t.includes('dtac'))return 2;return -1}
function checkBulk(){
  const lines=$('bulkIn').value.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const bySc={};R.forEach(o=>{const k=o.sc.toLowerCase();(bySc[k]=bySc[k]||[]).push(o.i);(bySc[String(o.lid)]=bySc[String(o.lid)]||[]).push(o.i)});
  const agg=new Map();BULK=[];const out=[];
  lines.forEach((l,n)=>{let c=l.split('\t');if(c.length<3)c=l.split(/\s*[,;]\s*|\s{2,}/);
    if(/^site/i.test(c[0]))return; // header
    let sc=c[0].trim(),t,rm,ins,note;
    if(c.length>=4&&isNaN(+c[1])){t=c[1];rm=c[2];ins=c[3];note=c.slice(4).join(' ')}else{t='';rm=c[1];ins=c[2];note=c.slice(3).join(' ')}
    rm=parseInt(rm)||0;ins=parseInt(ins)||0;const ti=typeIdx(t);
    const cand=bySc[sc.toLowerCase()];let err='',warn='',row=null;
    if(!cand)err='ไม่พบ SITECODE';else if(ti<0)err='ประเภทไม่ถูกต้อง (ใช้ ANT/MW/DTAC)';else if(!rm&&!ins)err='ไม่มีจำนวน';
    else{row=cand.find(i=>prevOf(i)[ti]>0)??cand[0];if(cand.length>1)warn=`มี ${cand.length} แถว ใช้แถว LOCATION ${R[row].lid} / ${esc(R[row].ad)}`}
    if(row!=null&&!err){const a=agg.get(row)||{rm:[0,0,0],ins:[0,0,0],notes:[]};a.rm[ti]+=rm;a.ins[ti]+=ins;if(note)a.notes.push(note.trim());agg.set(row,a)}
    out.push({n:n+1,sc,t:TYPES[ti]||t,rm,ins,note,err,warn,row});});
  // validate aggregated against stock (merge with existing)
  for(const[row,a] of agg){const ex=getCh(WORK,row);const rmT=a.rm.map((x,j)=>x+(ex?.rm?.[j]||0)),inT=a.ins.map((x,j)=>x+(ex?.ins?.[j]||0));const p=prevOf(row);
    const bad=[0,1,2].find(j=>p[j]-rmT[j]+inT[j]<0);
    if(bad!=null){out.filter(x=>x.row===row).forEach(x=>{x.err=`รื้อถอน ${TYPES[bad]} เกินที่มี (${p[bad]})`})}
    else BULK.push({row,rm:rmT,ins:inT,note:[ex?.note,...a.notes].filter(Boolean).filter((v,k,s)=>s.indexOf(v)===k).join(', '),tower:!!ex?.tower,merged:!!ex})}
  const ok=out.filter(x=>!x.err).length;
  let h=`<div class="msg ${ok===out.length?'ok':'warn'}">ถูกต้อง ${ok} / ${out.length} บรรทัด → ${BULK.length} สถานี${BULK.some(b=>b.merged)?' (บางสถานีรวมกับรายการเดิม)':''}</div><div class="tbl-wrap" style="max-height:300px"><table><thead><tr><th>#</th><th>ผล</th><th>SITECODE</th><th>ประเภท</th><th class="r">รื้อ</th><th class="r">ติดตั้ง</th><th>หมายเหตุ</th></tr></thead><tbody>`;
  out.forEach(x=>h+=`<tr><td>${x.n}</td><td style="white-space:normal">${x.err?`<span class="badge bad">${esc(x.err)}</span>`:x.warn?`<span class="badge warn">ตรวจ</span> <small class="muted">${x.warn}</small>`:'<span class="badge good">พร้อม</span>'}</td><td>${esc(x.sc)}</td><td>${esc(x.t)}</td><td class="r">${x.rm||''}</td><td class="r">${x.ins||''}</td><td>${esc(x.note)}</td></tr>`);
  $('bulkOut').innerHTML=h+'</tbody></table></div>';$('bulkSave').classList.toggle('hide',!BULK.length);
}
async function saveBulk(){
  if(!canWrite){$('bulkOut').insertAdjacentHTML('afterbegin','<div class="msg err">บัญชีนี้มีสิทธิ์ดูอย่างเดียว</div>');return}
  $('bulkSave').disabled=true;const by=await myId();let n=0;
  try{await putChanges(BULK.map(b=>{const o=R[b.row];return{month:WORK,row:b.row,k:o.k,sc:o.sc,lid:o.lid,rm:b.rm,ins:b.ins,note:b.note,tower:b.tower,src:'bulk'}}));n=BULK.length;
    $('bulkOut').innerHTML=`<div class="msg ok">บันทึกแล้ว ${n} สถานี</div>`;$('bulkIn').value='';BULK=[];$('bulkSave').classList.add('hide');
  }catch(e){$('bulkOut').insertAdjacentHTML('afterbegin',`<div class="msg err">บันทึกไม่สำเร็จ: ${esc(e.message||e.code)}</div>`)}
  $('bulkSave').disabled=false;
}
function renderRecord(){
  $('recMonth').textContent=mLF(WORK);
  const ch=changesOf(WORK);const rm=sum(ch.map(c=>sum(c.rm||[]))),ins=sum(ch.map(c=>sum(c.ins||[])));
  const sr=ch.filter(c=>sum(c.rm||[])).length,si=ch.filter(c=>sum(c.ins||[])).length,tw=ch.filter(c=>c.tower||c.now===0).length;
  const T=monthTotals(WORK);
  $('recKpis').innerHTML=`<div class="card kpi"><div class="lbl">รื้อถอน</div><div class="val num">${fmt(rm)}</div><div class="dl">${sr} Site</div></div><div class="card kpi"><div class="lbl">ติดตั้งเพิ่ม</div><div class="val num">${fmt(ins)}</div><div class="dl">${si} Site</div></div><div class="card kpi"><div class="lbl">เสารื้อถอน</div><div class="val num">${tw}</div><div class="dl">ต้น</div></div><div class="card kpi"><div class="lbl">Total ANT หลังปรับ</div><div class="val num">${fmt(T.total)}</div><div class="dl">${rm-ins?`<span class="neg">${fmt(ins-rm)}</span>`:'ไม่เปลี่ยน'}</div></div>`;
  updForm();renderRecTable();
}
function renderRecTable(){
  const q=($('recQ').value||'').toLowerCase();const ch=changesOf(WORK).filter(c=>!q||(c.sc+' '+R[c.row]?.nm+' '+c.note).toLowerCase().includes(q)).sort((a,b)=>(b.at||'').localeCompare(a.at||''));
  let h=`<thead><tr><th>SITECODE</th><th>ชื่อ</th><th>ภาค</th><th class="r">ก่อน</th><th class="r">รื้อ</th><th class="r">ติดตั้ง</th><th class="r">หลัง</th><th>หมายเหตุ</th><th>ผู้บันทึก</th><th></th></tr></thead><tbody>`;
  const ids=[...new Set(ch.map(c=>c.by).filter(Boolean))];
  for(const c of ch){const o=R[c.row];if(!o)continue;const p=sum(prevOf(c.row)),a=sum(curOf(c.row));
    h+=`<tr><td><b>${esc(o.sc)}</b></td><td>${esc(o.nm)}</td><td>${o.rg}</td><td class="r num">${p}</td><td class="r num">${sum(c.rm||[])||''}${c.rm?.[1]?` <small class="muted">MW${c.rm[1]}</small>`:''}${c.rm?.[2]?` <small class="muted">DT${c.rm[2]}</small>`:''}</td><td class="r num">${sum(c.ins||[])||''}</td><td class="r num"><b>${a}</b></td><td>${esc(c.note)}${c.tower?' <span class="badge">เสารื้อถอน</span>':''}</td><td class="muted" data-by="${esc(c.by||'')}">${esc(nameOf(c.by))}</td><td><button class="btn sm" data-e="${c.row}">แก้ไข</button> <button class="btn sm danger" data-d="${esc(c.id)}">ลบ</button></td></tr>`}
  if(!ch.length)h+=`<tr><td colspan="10" class="muted" style="padding:30px;text-align:center">ยังไม่มีรายการในเดือนนี้</td></tr>`;
  $('tblRec').innerHTML=h+'</tbody>';
  $('tblRec').querySelectorAll('[data-e]').forEach(b=>b.onclick=()=>{pickSite(+b.dataset.e);window.scrollTo({top:0,behavior:'smooth'})});
  $('tblRec').querySelectorAll('[data-d]').forEach(b=>b.onclick=async()=>{if(await confirmBox('ลบรายการ?','ลบรายการของสถานีนี้ออกจากเดือน '+mLF(WORK),'ลบ'))delChange(b.dataset.d)});
}

/* ---------- import monthly file ---------- */
let XLSXP=null, IMP=null;
function loadXLSX(){if(window.XLSX)return Promise.resolve();if(XLSXP)return XLSXP;XLSXP=new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=res;s.onerror=()=>{XLSXP=null;rej(new Error('โหลดตัวอ่าน Excel ไม่ได้ — ตรวจการเชื่อมต่ออินเทอร์เน็ต'))};document.head.appendChild(s)});return XLSXP}
const normH=x=>String(x??'').replace(/\s+/g,' ').trim();
function parseMonthKey(h){const m=String(h).match(/\(\s*([ก-๙.]+)\s*(\d{2,4})\s*\)/);if(!m)return null;const mi=TH.findIndex(t=>t.replace(/\./g,'')===m[1].replace(/\./g,''));if(mi<0)return null;let y=m[2];if(y.length===2)y='25'+y;return y+'-'+String(mi+1).padStart(2,'0')}
function parseMonthlyFile(wb){
  let best=null;
  for(const name of wb.SheetNames){const aoa=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:true,defval:null});
    for(let r=0;r<Math.min(8,aoa.length);r++){const h=(aoa[r]||[]).map(normH);if(h.includes('REGION')&&h.some(x=>/^Total ANT/i.test(x))){if(!best||aoa.length>best.aoa.length)best={name,aoa,hr:r,h};break}}}
  if(!best)throw new Error('ไม่พบชีตที่มีหัวคอลัมน์ REGION และ “Total ANT (เดือน)” — ตรวจว่าเป็นไฟล์รูปแบบรายเดือน');
  const{aoa,hr,h}=best;
  const tots=h.map((x,i)=>/^Total ANT/i.test(x)?i:-1).filter(i=>i>=0);
  const cur=tots[tots.length-1],pt=tots.length>1?tots[tots.length-2]:null;
  const month=parseMonthKey(h[cur]),pmonth=pt!=null?parseMonthKey(h[pt]):null;
  if(!month)throw new Error('อ่านเดือนจากหัวคอลัมน์ “'+h[cur]+'” ไม่ได้');
  const U=h.map(x=>x.toUpperCase().replace(/[_ ]/g,''));
  const col=(names,from=0)=>{for(let i=from;i<h.length;i++){if(names.some(n=>U[i]===n.toUpperCase().replace(/[_ ]/g,'')))return i}return -1};
  const ix={rg:col(['REGION']),zn:col(['ZONE']),pv:col(['PROVINCE']),lid:col(['LOCATION ID']),nm:col(['LOCATION_NAME']),sc:col(['SITECODE','SITECODE OSPID']),an:col(['ARTICLE_NO']),ad:col(['ARTICLE_DESC']),tt:col(['Tower type']),hi:col(['High']),tot:col(['จำนวน TOWER ที่เช่า_TOT']),now:col(['จำนวน TOWER เช่า ณ ปัจจุบัน']),rm:col(['รื้อถอน'],cur+1),ins:col(['ติดตั้งเพิ่ม'],cur+1),note:col(['หมายเหตุ'],cur+1),st:col(['สถานะ'],cur+1),lat:col(['LATITUDE']),lon:col(['LONGITUDE'])};
  if(ix.lid<0||ix.sc<0)throw new Error('ไม่พบคอลัมน์ LOCATION ID หรือ SITECODE');
  const num=v=>{const n=typeof v==='number'?v:parseFloat(String(v??'').replace(/,/g,''));return isFinite(n)?Math.round(n):0};
  const occ=new Map(),rows=[];
  for(let r=hr+1;r<aoa.length;r++){const a=aoa[r];if(!a)continue;const lid=a[ix.lid],sc=a[ix.sc];if(lid==null||lid===''||!sc)continue;
    const g=k=>ix[k]>=0?a[ix[k]]:null;
    rows.push({k:nextKey(occ,String(lid).trim(),sc,g('an')),src:r+1,rg:g('rg'),zn:g('zn'),pv:g('pv'),lid:typeof lid==='number'?lid:String(lid).trim(),nm:g('nm'),sc:String(sc).trim(),an:g('an'),ad:g('ad'),tt:g('tt'),hi:g('hi'),
      tot:num(g('tot')),now:ix.now>=0?num(g('now')):null,cur:[num(a[cur-3]),num(a[cur-2]),num(a[cur-1])],prev:pt!=null?[num(a[pt-3]),num(a[pt-2]),num(a[pt-1])]:null,
      frm:ix.rm>=0?num(g('rm')):null,fin:ix.ins>=0?num(g('ins')):null,note:g('note')!=null?String(g('note')).trim():'',st:g('st')!=null?String(g('st')).trim():'',lat:g('lat'),lon:g('lon')})}
  let summ=null;const sn=wb.SheetNames.find(n=>n.trim()==='สรุป');
  if(sn){const a2=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,raw:true,defval:null});summ={};for(const r of a2){const k=r&&String(r[0]??'').trim();if(k&&[...REG,'Total'].includes(k)&&typeof r[1]==='number')summ[k]=r[1]}if(!Object.keys(summ).length)summ=null}
  return{sheet:best.name,month,pmonth,curLabel:h[cur],rows,summ};
}
function diffImport(P){
  const m=WORK,ps=prevMonthState(m);
  const res={changes:[],extras:[],warn:[],missing:[],matched:0,regAfter:{},fileTotal:0};
  REG.forEach(g=>res.regAfter[g]=0);
  for(let i=0;i<N;i++){const o=R[i];if(o.extra&&o.from>=m)continue;res.regAfter[o.rg]=(res.regAfter[o.rg]||0)+ps.ant[0][i]+ps.ant[1][i]+ps.ant[2][i]}
  const seen=new Set();
  for(const f of P.rows){
    res.fileTotal+=sum(f.cur);
    let i=KEYIDX.get(f.k),o,p,pnow,pst,isNew=false;
    if(i==null||(R[i].extra&&R[i].from>=m)){isNew=true;
      const init=f.prev||[0,0,0];
      o={k:f.k,from:m,init,nowInit:f.now??f.tot??1,stInit:f.st||'',rg:f.rg,zn:f.zn,pv:f.pv,lid:f.lid,nm:f.nm,sc:f.sc,an:f.an,ad:f.ad,tt:f.tt,hi:f.hi,tot:f.tot,now:f.now??f.tot,st:f.st||'',lat:f.lat,lon:f.lon};
      res.extras.push(o);p=init;pnow=o.nowInit;pst=o.stInit;res.regAfter[f.rg]=(res.regAfter[f.rg]||0)+sum(init);
    }else{seen.add(i);res.matched++;o=R[i];p=[ps.ant[0][i],ps.ant[1][i],ps.ant[2][i]];pnow=ps.now[i];pst=String(ps.st[i]||'').trim();
      if(f.prev&&f.prev.some((v,j)=>v!==p[j]))res.warn.push({f,o,msg:`ยอด ${P.pmonth?mL(P.pmonth):'เดือนก่อน'} ในไฟล์ = ${sum(f.prev)} แต่ในระบบ = ${sum(p)}`})}
    const rm=[0,1,2].map(j=>Math.max(p[j]-f.cur[j],0)),ins=[0,1,2].map(j=>Math.max(f.cur[j]-p[j],0));
    const ch={rm,ins,note:'',now:null,st:null,f,o,isNew,before:sum(p),after:sum(f.cur)};
    if(f.now!=null&&f.now!==pnow)ch.now=f.now;
    if((f.st||'')!==pst)ch.st=f.st||'';
    if(sum(rm)||sum(ins))ch.note=f.note;
    res.regAfter[o.rg]=(res.regAfter[o.rg]||0)+sum(ins)-sum(rm);
    if(f.frm!=null&&(f.frm!==sum(rm)||(f.fin||0)!==sum(ins)))res.warn.push({f,o,msg:`คอลัมน์ รื้อถอน/ติดตั้งเพิ่ม ในไฟล์ = ${f.frm||0}/${f.fin||0} แต่ส่วนต่างยอดจริง = ${sum(rm)}/${sum(ins)}`});
    if(sum(rm)||sum(ins)||ch.now!=null||ch.st!=null)res.changes.push(ch);
  }
  for(const o of R){if(seen.has(o.i)||(o.extra&&o.from>=m))continue;const i=o.i;const t=ps.ant[0][i]+ps.ant[1][i]+ps.ant[2][i];if(t>0||ps.now[i]>0)res.missing.push({o,t})}
  return res;
}
async function handleImportFile(file){
  const out=$('impOut');IMP=null;
  if(!file)return;
  out.innerHTML=`<div class="msg info">กำลังอ่าน ${esc(file.name)}…</div>`;
  try{await loadXLSX();const buf=await file.arrayBuffer();const wb=XLSX.read(buf,{type:'array'});
    const P=parseMonthlyFile(wb);
    if(P.month<=BASE){out.innerHTML=`<div class="msg warn">ไฟล์นี้เป็นข้อมูลเดือน ${mLF(P.month)} ซึ่งมีอยู่ในระบบแล้ว (ข้อมูลตั้งต้นถึง ${mLF(BASE)})</div>`;return}
    if(CLOSED.includes(P.month)){out.innerHTML=`<div class="msg warn">เดือน ${mLF(P.month)} ปิดไปแล้ว — ถ้าจะนำเข้าใหม่ ให้ไปที่ “ออกรายงาน” แล้วกด “เปิดเดือนล่าสุดอีกครั้ง” ก่อน</div>`;return}
    if(P.month!==WORK){out.innerHTML=`<div class="msg warn">ไฟล์นี้เป็นข้อมูลเดือน ${mLF(P.month)} แต่ระบบกำลังรอข้อมูลเดือน ${mLF(WORK)} — นำเข้า/ปิดเดือน ${mLF(WORK)} ก่อน แล้วค่อยนำเข้าไฟล์นี้</div>`;return}
    if(!P.rows.length){out.innerHTML='<div class="msg err">ไม่พบแถวข้อมูลในไฟล์</div>';return}
    IMP={file:file.name,P,res:diffImport(P)};renderImport();
  }catch(e){out.innerHTML=`<div class="msg err">อ่านไฟล์ไม่สำเร็จ: ${esc(e.message||e)}</div>`}
}
function renderImport(){
  if(!IMP)return;const{P,res}=IMP;const ch=res.changes;
  const rmA=sum(ch.map(c=>sum(c.rm))),inA=sum(ch.map(c=>sum(c.ins))),rmS=ch.filter(c=>sum(c.rm)).length,inS=ch.filter(c=>sum(c.ins)).length,tw=ch.filter(c=>c.now!=null).length;
  const after=sum(Object.values(res.regAfter));const existing=changesOf(WORK).length;
  let h=`<div style="margin-top:14px"><b>${esc(IMP.file)}</b> <span class="muted">· ชีต “${esc(P.sheet)}” · ข้อมูลเดือน <b>${mLF(P.month)}</b>${P.pmonth?` เทียบกับ ${mLF(P.pmonth)}`:''}</span></div>
  <div class="imp-sum">
    <div><span>แถวในไฟล์</span><b class="num">${fmt(P.rows.length)}</b></div>
    <div><span>จับคู่กับระบบได้</span><b class="num">${fmt(res.matched)}</b></div>
    <div><span>สถานีใหม่</span><b class="num">${fmt(res.extras.length)}</b></div>
    <div><span>รื้อถอน</span><b class="num">${fmt(rmA)}</b> <small class="muted">ANT · ${rmS} Site</small></div>
    <div><span>ติดตั้งเพิ่ม</span><b class="num">${fmt(inA)}</b> <small class="muted">ANT · ${inS} Site</small></div>
    <div><span>Tower เปลี่ยน</span><b class="num">${fmt(tw)}</b> <small class="muted">สถานี</small></div>
    <div><span>Total ANT หลังนำเข้า</span><b class="num">${fmt(after)}</b>${after===res.fileTotal?' <span class="badge good">ตรงกับไฟล์</span>':` <span class="badge warn">ไฟล์ ${fmt(res.fileTotal)}</span>`}</div>
  </div>`;
  if(P.summ){h+=`<div class="tbl-wrap" style="margin-bottom:12px"><table><thead><tr><th>ภาค</th><th class="r">ระบบหลังนำเข้า</th><th class="r">ชีต “สรุป” ในไฟล์</th><th>ผล</th></tr></thead><tbody>`;
    for(const g of [...REG,'Total']){const a=g==='Total'?after:res.regAfter[g]||0,b=P.summ[g];h+=`<tr${g==='Total'?' class="total"':''}><td>${g}</td><td class="r num">${fmt(a)}</td><td class="r num">${b==null?'–':fmt(b)}</td><td>${b==null?'':a===b?'<span class="badge good">ตรง</span>':`<span class="badge bad">ต่าง ${a-b>0?'+':''}${fmt(a-b)}</span>`}</td></tr>`}
    h+='</tbody></table></div>'}
  if(res.warn.length)h+=`<div class="msg warn">มี ${res.warn.length} จุดที่ควรตรวจ (ไม่ขัดการนำเข้า — ระบบยึดยอด “${esc(P.curLabel)}” ในไฟล์เป็นหลัก)</div><div class="tbl-wrap" style="max-height:220px;margin-bottom:10px"><table><thead><tr><th>แถว</th><th>SITECODE</th><th>ชื่อ</th><th>รายละเอียด</th></tr></thead><tbody>${res.warn.slice(0,300).map(w=>`<tr><td>${w.f.src}</td><td><b>${esc(w.f.sc)}</b></td><td>${esc(w.f.nm)}</td><td>${esc(w.msg)}</td></tr>`).join('')}</tbody></table></div>`;
  if(res.missing.length)h+=`<div class="msg warn">มี ${res.missing.length} สถานีในระบบที่ไม่อยู่ในไฟล์ (ยังมี ANT/เสา) — ระบบจะคงยอดเดิมไว้: ${res.missing.slice(0,12).map(x=>esc(x.o.sc)).join(', ')}${res.missing.length>12?' …':''}</div>`;
  if(existing)h+=`<div class="msg info">เดือนนี้มีรายการบันทึกไว้แล้ว ${existing} รายการ — การนำเข้าจะ<b>แทนที่</b>รายการเดิมทั้งหมดด้วยข้อมูลจากไฟล์</div>`;
  h+=`<div class="tbl-wrap" style="max-height:300px"><table><thead><tr><th>SITECODE</th><th>ชื่อ</th><th>ภาค</th><th class="r">ก่อน</th><th class="r">รื้อ</th><th class="r">ติดตั้ง</th><th class="r">หลัง</th><th>หมายเหตุ / สถานะ</th></tr></thead><tbody>`;
  for(const c of ch.slice(0,400))h+=`<tr><td><b>${esc(c.f.sc)}</b>${c.isNew?' <span class="badge info">ใหม่</span>':''}</td><td>${esc(c.f.nm)}</td><td>${esc(c.f.rg)}</td><td class="r num">${c.before}</td><td class="r num">${sum(c.rm)||''}</td><td class="r num">${sum(c.ins)||''}</td><td class="r num"><b>${c.after}</b></td><td>${esc(c.note)}${c.now!=null?` <span class="badge">Tower → ${c.now}</span>`:''}${c.st!=null?` <span class="badge">${esc(c.st)||'ล้างสถานะ'}</span>`:''}</td></tr>`;
  if(ch.length>400)h+=`<tr><td colspan="8" class="muted">แสดง 400 จาก ${ch.length} รายการ</td></tr>`;
  if(!ch.length)h+=`<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">ไม่มีสถานีที่ยอดเปลี่ยนจากเดือนก่อน</td></tr>`;
  h+=`</tbody></table></div><div id="impProg"></div><div class="row" style="margin-top:12px"><button class="btn pri" id="impGo" ${canWrite?'':'disabled'}>นำเข้า ${fmt(ch.length)} รายการ${res.extras.length?` + สถานีใหม่ ${res.extras.length}`:''}</button><button class="btn" id="impCancel">ยกเลิก</button></div>`;
  $('impOut').innerHTML=h;
  $('impGo').onclick=saveImport;$('impCancel').onclick=()=>{IMP=null;$('impOut').innerHTML='';$('impFile').value=''};
}
async function runPool(tasks,n,onProg){let i=0,done=0;const errs=[];
  async function w(){while(i<tasks.length){const t=tasks[i++];let tries=0;for(;;){try{await t();break}catch(e){if((e.code==='resource_exhausted'||e.code==='unavailable')&&tries<5){tries++;await new Promise(r=>setTimeout(r,500*tries+Math.random()*400));continue}errs.push(e);break}}done++;onProg(done)}}
  await Promise.all(Array.from({length:n},w));return errs}
async function saveImport(){
  if(!IMP||!canWrite)return;const{res,file}=IMP;const m=WORK;
  const existing=changesOf(m);
  if(existing.length&&!await confirmBox('แทนที่รายการเดิม?',`ลบ ${existing.length} รายการเดิมของ ${mLF(m)} แล้วใช้ข้อมูลจากไฟล์ ${esc(file)} แทน`,'แทนที่'))return;
  $('impGo').disabled=true;$('impCancel').disabled=true;
  const by=await myId(),at=new Date().toISOString();
  const exDocs=res.extras.map(e=>[e.k,Object.assign({},e,{file})]);
  const chDocs=res.changes.map(c=>[chId(m,c.o),{month:m,k:c.o.k,row:c.isNew?null:c.o.i,sc:c.f.sc,lid:c.f.lid,rm:c.rm,ins:c.ins,note:c.note||'',now:c.now,st:c.st,src:'import',file,by,at}]);
  const keep=new Set(chDocs.map(d=>d[0]));const dels=existing.filter(c=>!keep.has(c.id)).map(c=>c.id);
  const total=exDocs.length+chDocs.length+dels.length;
  const prog=n=>{$('impProg').innerHTML=`<div class="prog"><i style="width:${Math.round(n/total*100)}%"></i></div><small class="muted">กำลังบันทึก ${n} / ${total}</small>`};prog(0);
  let errs=[];let done=0;
  try{
    for(let i=0;i<exDocs.length;i+=500){const part=exDocs.slice(i,i+500);const{error}=await sb.from('extra_sites').upsert(part.map(([id,d])=>({k:d.k,from_month:d.from,data:d})),{onConflict:'k'});if(error)throw dbErr(error);part.forEach(([id,d])=>store.extras.set(d.k,d));done+=part.length;prog(done)}
    if(exDocs.length)rebuildRows();
    errs=await runPool(dels.map(id=>()=>delChange(id)),4,n=>prog(done+n));done+=dels.length;
    const list=chDocs.map(([id,d])=>d);
    for(let i=0;i<list.length;i+=500){await putChanges(list.slice(i,i+500));done+=Math.min(500,list.length-i);prog(done)}
  }catch(e){errs.push(e)}
  recomputeNow();
  if(errs.length){$('impProg').innerHTML=`<div class="msg err">บันทึกไม่สำเร็จ ${errs.length} รายการ (${esc(errs[0].message||errs[0].code)}) — กดนำเข้าซ้ำได้ ระบบจะเขียนทับรายการเดิม</div>`;$('impGo').disabled=false;$('impCancel').disabled=false;return}
  IMP=null;$('impFile').value='';
  $('impOut').innerHTML=`<div class="msg ok">นำเข้า ${esc(file)} แล้ว: ${chDocs.length} รายการ${exDocs.length?`, สถานีใหม่ ${exDocs.length}`:''} — ตรวจรายการด้านล่าง แล้วออกรายงาน/ปิดเดือนได้ที่แท็บ “ออกรายงาน Excel”</div><div class="row"><a class="btn" href="#reports">ไปที่ออกรายงาน / ปิดเดือน</a><a class="btn" href="#checks">ตรวจสอบข้อมูล</a></div>`;
}

/* ---------- checks ---------- */
function computeChecks(){
  const issues=[];const add=(sev,cat,o,msg)=>issues.push({sev,cat,o,msg});
  // 1. balance per data month
  for(let mi=1;mi<MONTHS.length;mi++){const m=MONTHS[mi];for(const o of R){const p=splitAt(o,mi-1),c=splitAt(o,mi);if(!p||!c)continue;const e=o.ev[m]||[0,0];const d=sum(p)-(e[0]||0)+(e[1]||0)-sum(c);if(d)add('bad','ยอดไม่สมดุล',o,`${mL(m)}: เดือนก่อน ${sum(p)} − รื้อ ${e[0]||0} + ติดตั้ง ${e[1]||0} ≠ ${sum(c)} (ไม่มีบันทึกรื้อถอน/ติดตั้ง)`)}}
  // 2. note counts vs computed
  for(const meta of D.meta){const m=meta.month;let sr=0,si=0;for(const o of R){const e=o.ev[m];if(e){if(e[0])sr++;if(e[1])si++}}
    const nr=(meta.notes[0]||'').match(/ทั้งหมด\s*([\d,]+)\s*Site/),ni=(meta.notes[1]||'').match(/ทั้งหมด\s*([\d,]+)\s*Site/);
    if(nr&&+nr[1].replace(/,/g,'')!==sr)add('warn','หมายเหตุจำนวน Site',null,`${mL(m)}: หมายเหตุเขียน ${nr[1]} Site ที่รื้อถอน แต่นับจากแถวได้ ${sr} Site`);
    if(ni&&+ni[1].replace(/,/g,'')!==si)add('warn','หมายเหตุจำนวน Site',null,`${mL(m)}: หมายเหตุเขียน ${ni[1]} Site ที่ติดตั้ง แต่นับจากแถวได้ ${si} Site`)}
  // 3. master year vs monthly
  for(const r of D.year){const i=THF.indexOf(r[0]);if(i<0)continue;const m='2569-'+String(i+1).padStart(2,'0');const meta=D.meta.find(x=>x.month===m);if(!meta)continue;
    if(r[2]!==meta.rm||r[3]!==meta.in)add('warn','ไฟล์สรุปรายปีไม่ตรง',null,`${mL(m)}: ไฟล์ TOWER AWN 2026 บันทึกรื้อ ${r[2]} / ติดตั้ง ${r[3]} แต่ไฟล์รายเดือนรวมได้ รื้อ ${meta.rm} / ติดตั้ง ${meta.in}`)}
  // 4. state checks (working)
  const s=STATE[WORK];
  for(let i=0;i<N;i++){const o=R[i];const t=s.ant[0][i]+s.ant[1][i]+s.ant[2][i];
    if(String(s.st[i]).trim()==='เสารื้อถอนแล้ว'&&t>0)add('warn','เสารื้อถอนแล้วแต่ยังมี ANT',o,`สถานะ “เสารื้อถอนแล้ว” แต่ Total ANT = ${t}`);
    if(s.now[i]===0&&t>0&&!String(s.st[i]).includes('เสารื้อถอน'))add('warn','Tower = 0 แต่ยังมี ANT',o,`จำนวน TOWER เช่า ณ ปัจจุบัน = 0 แต่ Total ANT = ${t}`);
    for(let j=0;j<3;j++)if(s.ant[j][i]<0)add('bad','ยอดติดลบ',o,`${TYPES[j]} ติดลบ (${s.ant[j][i]}) ใน ${mL(WORK)}`);
    if(!o.lat||!o.lon)if(t>0)add('info','ไม่มีพิกัด',o,'LATITUDE/LONGITUDE ว่างหรือเป็น 0');}
  return issues;
}
function renderChecks(){
  if(!STATE[WORK])return;const is=computeChecks();
  $('chkBadge').textContent=is.filter(x=>x.sev!=='info').length;
  const cats={};is.forEach(x=>{(cats[x.cat]=cats[x.cat]||{sev:x.sev,items:[]}).items.push(x)});
  const order={bad:0,warn:1,info:2};
  $('chkSummary').innerHTML=Object.entries(cats).sort((a,b)=>order[a[1].sev]-order[b[1].sev]).map(([k,v])=>`<div class="card kpi"><div class="lbl"><span class="badge ${v.sev==='info'?'':v.sev}">${v.sev==='bad'?'ต้องแก้':v.sev==='warn'?'ควรตรวจ':'ข้อมูล'}</span> ${k}</div><div class="val num">${fmt(v.items.length)}</div></div>`).join('')||'<div class="msg ok">ไม่พบปัญหา</div>';
  let h='';for(const[k,v] of Object.entries(cats).sort((a,b)=>order[a[1].sev]-order[b[1].sev])){
    h+=`<div class="sec-h"><h3>${k} (${v.items.length})</h3></div><div class="tbl-wrap" style="max-height:320px"><table><thead><tr><th>SITECODE</th><th>ชื่อ</th><th>จังหวัด</th><th>รายละเอียด</th></tr></thead><tbody>`;
    for(const x of v.items.slice(0,300))h+=`<tr ${x.o?`class="click" data-i="${x.o.i}"`:''}><td>${x.o?`<b>${esc(x.o.sc)}</b>`:'—'}</td><td>${x.o?esc(x.o.nm):''}</td><td>${x.o?esc(x.o.pv):''}</td><td>${esc(x.msg)}</td></tr>`;
    if(v.items.length>300)h+=`<tr><td colspan="4" class="muted">แสดง 300 จาก ${v.items.length}</td></tr>`;h+='</tbody></table></div>'}
  $('chkList').innerHTML=h;$('chkList').querySelectorAll('tr.click').forEach(tr=>tr.onclick=()=>openSite(+tr.dataset.i));
}

/* ---------- reports ---------- */
function setupReports(){
  $('repMonthBtn').onclick=()=>run(()=>exportMonthly($('repMonth').value));
  $('repQBtn').onclick=()=>run(()=>exportQuarter([$('q1').value,$('q2').value,$('q3').value]));
  $('repYBtn').onclick=()=>run(exportYear);
  $('repLogBtn').onclick=()=>run(()=>exportLog($('repLogMonth').value));
  $('closeBtn').onclick=async()=>{const n=changesOf(WORK).length;if(!isAdmin())return;if(await confirmBox(`ปิดเดือน ${mLF(WORK)}?`,`มี ${n} รายการ ยอดคงเหลือจะกลายเป็นยอดตั้งต้นของ ${mLF(mNext(WORK))} (เปิดกลับได้ภายหลัง)`,'ปิดเดือน')){try{await putMonth(WORK,{closed:true,at:new Date().toISOString(),by:await myId()});$('closeMsg').innerHTML='<div class="msg ok">ปิดเดือนแล้ว</div>'}catch(e){$('closeMsg').innerHTML=`<div class="msg err">ไม่สำเร็จ ${esc(e.message||e.code)}</div>`}}};
  $('reopenBtn').onclick=async()=>{const m=CLOSED[CLOSED.length-1];if(!m||!isAdmin())return;if(await confirmBox(`เปิดเดือน ${mLF(m)} อีกครั้ง?`,`รายการของ ${mLF(WORK)} ยังเก็บไว้ แต่จะยังไม่นับจนกว่าจะปิด ${mLF(m)} อีกครั้ง`,'เปิดอีกครั้ง')){try{await putMonth(m,{closed:false})}catch(e){$('closeMsg').innerHTML=`<div class="msg err">${esc(e.message)}</div>`}}};
}
function renderDlNote(){}
function renderReports(){
  const ms=allMonths().filter(m=>m>='2569-01');
  const opts=(sel,list,def)=>{const v=sel.value;sel.innerHTML=list.map(m=>`<option value="${m}">${mL(m)}${m===WORK?' (ร่าง)':''}</option>`).join('');sel.value=list.includes(v)?v:def};
  opts($('repMonth'),ms,WORK);opts($('repLogMonth'),[...CLOSED,WORK],WORK);
  const qa=allMonths();const qd=[qa[qa.length-7]||qa[0],qa[qa.length-4]||qa[0],qa[qa.length-1]];
  ['q1','q2','q3'].forEach((id,k)=>opts($(id),qa,qd[k]));
  const n=changesOf(WORK).length;
  $('closeTxt').innerHTML=`เดือนที่กำลังบันทึก: <b>${mLF(WORK)}</b> (${n} รายการ) · เมื่อปิดเดือน ยอดคงเหลือจะเป็นยอดตั้งต้นของเดือนถัดไปโดยอัตโนมัติ`;
  $('reopenBtn').disabled=!CLOSED.length||!isAdmin();$('closeBtn').disabled=!isAdmin();
  if(!isAdmin())$('closeTxt').innerHTML+='<br><span class="badge">เฉพาะผู้ดูแลระบบ</span>';
}
let XL=null;
function loadExcel(){if(window.ExcelJS)return Promise.resolve();if(XL)return XL;XL=new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';s.onload=res;s.onerror=()=>{XL=null;rej(new Error('โหลดตัวสร้าง Excel ไม่ได้'))};document.head.appendChild(s)});return XL}
async function run(fn){
  $('repMsg').innerHTML='<div class="msg info">กำลังสร้างไฟล์…</div>';
  try{await loadExcel();const{wb,name}=await fn();const buf=await wb.xlsx.writeBuffer();
    if(!downloads){$('repMsg').innerHTML='<div class="msg warn">สร้างไฟล์แล้ว แต่มุมมองนี้ดาวน์โหลดไม่ได้ — เปิดใน claude.ai</div>';return}
    await downloads.save({filename:name,data:new Blob([buf])});$('repMsg').innerHTML=`<div class="msg ok">ดาวน์โหลด ${esc(name)} แล้ว</div>`;
  }catch(e){$('repMsg').innerHTML=e.code==='declined'?'':`<div class="msg err">สร้างไฟล์ไม่สำเร็จ: ${esc(e.code||e.message)}</div>`}
}
const HDR_FILL={type:'pattern',pattern:'solid',fgColor:{argb:'FFDDEBF7'}};
const CHG_FILL={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF2CC'}};
const thin={style:'thin',color:{argb:'FFBFBFBF'}};
function styleHeader(row,h){row.height=h||45;row.eachCell(c=>{c.font={bold:true,name:'Tahoma',size:10};c.fill=HDR_FILL;c.alignment={wrapText:true,vertical:'middle',horizontal:'center'};c.border={top:thin,bottom:thin,left:thin,right:thin}})}
const colL=n=>{let s='';while(n>0){const m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26)}return s};
// per-row data for any month >= 2569-01
function monthData(m){
  const pm=mPrev(m);const out=[];
  const custom=MONTHS.indexOf(m)<0;const chs=custom?new Map(changesOf(m).map(c=>[c.row,c])):null;
  const s=custom?STATE[m]:null;
  for(let i=0;i<N;i++){const o=R[i];const c=rowAt(i,m);if(!c)continue;const p=o.extra&&o.from===m?(o.init||[0,0,0]):rowAt(i,pm);
    let rm=0,ins=0,note='',st=o.st,now=o.now;
    if(custom){const ch=chs.get(i);if(ch){rm=sum(ch.rm||[]);ins=sum(ch.ins||[]);note=ch.note||''}st=s.st[i];now=s.now[i]}
    else{const e=o.ev[m];if(e){rm=e[0];ins=e[1];note=e[2]}}
    out.push({o,p:p||[0,0,0],c,rm,ins,note,st,now})}
  return out;
}
async function exportMonthly(m){
  const pm=mPrev(m),pl=mL(pm),cl=mL(m);const rows=monthData(m);
  const wb=new ExcelJS.Workbook();wb.creator='ระบบติดตาม ANT AWN';
  const s1=wb.addWorksheet('สรุป'),s2=wb.addWorksheet('เสาเช่า (new)',{views:[{state:'frozen',xSplit:6,ySplit:2}]});
  const H=['REGION','ZONE','PROVINCE','LOCATION ID','LOCATION_NAME','SITECODE','GROUP_ARTICLE','ARTICLE_NO','ARTICLE_DESC','Tower type','High','UNIT COUNT','จำนวน TOWER \nที่เช่า_TOT','จำนวน TOWER เช่า ณ ปัจจุบัน',`Ant from NW (${pl})`,`Microwave (${pl})`,`ANT.Dtac (${pl})`,`Total ANT (${pl})`,`Ant from NW (${cl})`,`Microwave (${cl})`,`ANT.Dtac (${cl})`,`Total ANT (${cl})`,'รื้อถอน','ติดตั้งเพิ่ม','หมายเหตุ','สถานะ','LATITUDE','LONGITUDE'];
  s2.addRow([]);s2.addRow(H);styleHeader(s2.getRow(2));
  const last=rows.length+2;let k=3;const z=v=>v?v:null;
  const tot=new Array(29).fill(0);
  for(const r of rows){const o=r.o;const pt=sum(r.p),ct=sum(r.c);
    const vals=[o.rg,o.zn,o.pv,o.lid,o.nm,o.sc,'FACILITY->TOWER',o.an,o.ad,o.tt,o.hi,'SET',o.tot,r.now,r.p[0],z(r.p[1]),z(r.p[2]),{formula:`O${k}+P${k}+Q${k}`,result:pt},r.c[0],z(r.c[1]),z(r.c[2]),{formula:`S${k}+T${k}+U${k}`,result:ct},z(r.rm),z(r.ins),r.note||null,r.st||null,o.lat||null,o.lon||null];
    const row=s2.addRow(vals);if(r.rm||r.ins){[23,24,25].forEach(c=>row.getCell(c).fill=CHG_FILL)}
    [o.tot,r.now,r.p[0],r.p[1],r.p[2],pt,r.c[0],r.c[1],r.c[2],ct,r.rm,r.ins].forEach((v,j)=>tot[13+j]+=v||0);k++}
  for(let c=13;c<=24;c++){const L=colL(c);const cell=s2.getRow(1).getCell(c);cell.value={formula:`SUBTOTAL(9,${L}3:${L}${last})`,result:tot[c]};cell.font={bold:true,color:{argb:'FFC00000'}};cell.numFmt='#,##0';cell.alignment={horizontal:'center'}}
  s2.autoFilter={from:'A2',to:`AB${last}`};
  [6,22,14,10,22,10,15,20,30,9,6,7,10,10,10,10,10,10,10,10,10,10,8,8,26,18,11,11].forEach((w,j)=>s2.getColumn(j+1).width=w);
  // summary
  s1.getCell('A1').value='สรุปจำนวน ANT';s1.getCell('A1').font={bold:true,size:14,name:'Tahoma'};
  s1.getCell('A3').value='ภาค';s1.getCell('B3').value=`Antenna  (${cl})`;styleHeader(s1.getRow(3),24);
  const reg={};rows.forEach(r=>reg[r.o.rg]=(reg[r.o.rg]||0)+sum(r.c));
  REG.forEach((g,j)=>{const rr=4+j;s1.getCell('A'+rr).value=g;s1.getCell('B'+rr).value={formula:`SUMIF('เสาเช่า (new)'!$A$3:$A$${last},A${rr},'เสาเช่า (new)'!$V$3:$V$${last})`,result:reg[g]||0};s1.getCell('B'+rr).numFmt='#,##0'});
  s1.getCell('A10').value='Total';s1.getCell('B10').value={formula:'SUM(B4:B9)',result:sum(Object.values(reg))};s1.getCell('B10').numFmt='#,##0';s1.getRow(10).font={bold:true};
  for(let rr=3;rr<=10;rr++)['A','B'].forEach(c=>s1.getCell(c+rr).border={top:thin,bottom:thin,left:thin,right:thin});
  const sr=rows.filter(r=>r.rm).length,si=rows.filter(r=>r.ins).length;
  s1.getCell('A12').value='หมายเหตุ';s1.getCell('A12').font={bold:true};
  s1.getCell('A13').value=`- Site ที่โยกย้ายรื้อถอนทั้งหมด ${fmt(sr)} Site  จำนวน ${fmt(tot[23])} Ant`;
  s1.getCell('A14').value=`- Site ที่ติดตั้งเพิ่มทั้งหมด ${fmt(si)} Site  จำนวน ${fmt(tot[24])} Ant`;
  s1.getColumn(1).width=14;s1.getColumn(2).width=22;
  const no=+m.split('-')[1];return{wb,name:`${no}. Tower ที่ใช้บริการติดตั้ง ANT (${TH[no-1]} ${m.slice(2,4)}).xlsx`};
}
async function exportQuarter(ms){
  ms=[...new Set(ms)].sort();const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('11946',{views:[{state:'frozen',xSplit:6,ySplit:2}]});
  const H=['REGION','ZONE','PROVINCE','LOCATION ID','LOCATION_NAME','SITECODE OSPID','GROUP_ARTICLE','ARTICLE_NO','ARTICLE_DESC','Tower type','High','UNIT_COUNT','จำนวน TOWER \nที่เช่า_TOT','จำนวน TOWER เช่า ณ ปัจจุบัน'];
  ms.forEach(m=>{const l=mL(m);H.push(`Ant from NW (${l})`,`Microwave (${l})`,`ANT.Dtac (${l})`,`Total ANT (${l})`)});
  H.push('Available Space ','REMARK','LATITUDE','LONGITUDE','ตั้งอยู่ในพื้นที่ TOT','STATUS');
  ws.addRow([]);ws.addRow(H);styleHeader(ws.getRow(2));
  const lastM=ms[ms.length-1];const sLast=MONTHS.indexOf(lastM)<0?STATE[lastM]:null;
  let k=3;const tot=new Array(H.length+1).fill(0);const z=v=>v?v:null;
  for(let i=0;i<N;i++){const o=R[i];const a=ms.map(m=>rowAt(i,m));if(!a[a.length-1])continue;
    const now=sLast?sLast.now[i]:o.now;const vals=[o.rg,o.zn,o.pv,o.lid,o.nm,o.sc,'FACILITY->TOWER',o.an,o.ad,o.tt,o.hi,'SET',o.tot,now];tot[13]+=o.tot;tot[14]+=now;
    a.forEach((v,j)=>{v=v||[0,0,0];const c0=15+j*4;const L=colL(c0),L1=colL(c0+1),L2=colL(c0+2);vals.push(v[0],z(v[1]),z(v[2]),{formula:`${L}${k}+${L1}${k}+${L2}${k}`,result:sum(v)});tot[c0]+=v[0];tot[c0+1]+=v[1];tot[c0+2]+=v[2];tot[c0+3]+=sum(v)});
    const t=sum(a[a.length-1]||[0,0,0]);let av=null,rem=null;if(o.cap!=null){av=Math.max(o.cap-t,0);if(t>=o.cap){av=null;rem='full cap'}}tot[15+ms.length*4]+=av||0;
    vals.push(av,rem,o.lat||null,o.lon||null,o.totArea||null,o.status||null);ws.addRow(vals);k++}
  const last=k-1;for(let c=13;c<=15+ms.length*4;c++){const L=colL(c);const cell=ws.getRow(1).getCell(c);cell.value={formula:`SUBTOTAL(9,${L}3:${L}${last})`,result:tot[c]};cell.font={bold:true,color:{argb:'FFC00000'}};cell.numFmt='#,##0'}
  ws.autoFilter={from:'A2',to:`${colL(H.length)}${last}`};
  H.forEach((h,j)=>ws.getColumn(j+1).width=j<14?[6,22,14,10,22,10,15,20,30,9,6,7,10,10][j]:11);
  return{wb,name:`TOWER ที่ใช้บริการ V.${lastM.slice(2,4)}-${+lastM.split('-')[1]}.xlsx`};
}
async function exportYear(){
  const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('สรุป');
  ws.getCell('A1').value='จำนวน Antenna ที่ บริษัท AWN ใช้บริการติดตั้งบนเสาโทรคมนาคมของ บมจ.โทรคมนาคมแห่งชาติ';ws.getCell('A1').font={bold:true,size:13,name:'Tahoma'};
  ws.addRow([]);ws.addRow(['ช่วงเวลา','Tower','AWN (ANT+Microwave)','','','DTAC','Total ANT.','Available Space','Remark']);ws.addRow(['','','รื้อถอน','ติดตั้งเพิ่ม','คงเหลือ','','','','']);
  ws.mergeCells('C3:E3');['A','B','F','G','H','I'].forEach(c=>ws.mergeCells(`${c}3:${c}4`));styleHeader(ws.getRow(3),22);styleHeader(ws.getRow(4),22);
  for(const r of yearRows()){const row=ws.addRow([r.lbl,r.tw,r.rm,r.ins,r.awn,r.dt,{formula:`E${ws.rowCount+1}+F${ws.rowCount+1}`,result:r.tot},r.sp,r.draft?'ยังไม่ปิดเดือน':null]);row.eachCell((c,j)=>{c.border={top:thin,bottom:thin,left:thin,right:thin};if(j>1)c.numFmt='#,##0'})}
  ws.getColumn(1).width=26;for(let j=2;j<=9;j++)ws.getColumn(j).width=14;
  return{wb,name:'สรุป TOWER AWN '+WORK.slice(0,4)+'.xlsx'};
}
async function exportLog(m){
  const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('รายการ '+mL(m));
  ws.addRow(['REGION','PROVINCE','LOCATION ID','LOCATION_NAME','SITECODE','Total ANT ก่อน','รื้อถอน ANT AWN','รื้อถอน Microwave','รื้อถอน ANT DTAC','ติดตั้ง ANT AWN','ติดตั้ง Microwave','ติดตั้ง ANT DTAC','Total ANT หลัง','หมายเหตุ','เสารื้อถอน']);styleHeader(ws.getRow(1),36);
  const ps=prevMonthState(m),cs=STATE[m];
  for(const c of changesOf(m).sort((a,b)=>a.row-b.row)){const o=R[c.row];const p=ps.ant[0][c.row]+ps.ant[1][c.row]+ps.ant[2][c.row],a=cs.ant[0][c.row]+cs.ant[1][c.row]+cs.ant[2][c.row];
    ws.addRow([o.rg,o.pv,o.lid,o.nm,o.sc,p,...(c.rm||[0,0,0]).map(v=>v||null),...(c.ins||[0,0,0]).map(v=>v||null),a,c.note||null,c.tower?'ใช่':null])}
  const n=ws.rowCount;ws.addRow(['รวม','','','','',null,...[7,8,9,10,11,12].map(j=>({formula:`SUM(${colL(j)}2:${colL(j)}${n})`}))]).font={bold:true};
  [7,10,22,24,10,10,10,10,10,10,10,10,10,30,9].forEach((w,j)=>ws.getColumn(j+1).width=w);
  return{wb,name:`รายการรื้อถอน-ติดตั้ง ${mL(m)}.xlsx`};
}


/* ---------- login / users / admin ---------- */
const ROLE_TH={pending:'รออนุมัติ',viewer:'ผู้ดู',editor:'ผู้บันทึก',admin:'ผู้ดูแล'};
let entering=false, RECOVERY=false;
function gate(kind,msg){
  $('gate').classList.remove('hide');$('app').classList.add('hide');
  const B=$('gateBody');const note=msg?`<div class="msg ${msg.t||'err'}">${esc(msg.m)}</div>`:'';
  const back='<div class="links"><a data-g="login">← กลับไปหน้าเข้าสู่ระบบ</a></div>';
  if(kind==='config'){B.innerHTML='<div class="msg err">ยังไม่ได้ตั้งค่า Supabase — แก้ไฟล์ js/config.js ใส่ SUPABASE_URL และ SUPABASE_KEY ของโปรเจกต์</div>';return}
  if(kind==='login')B.innerHTML=`<h3>เข้าสู่ระบบ</h3>${note}<form id="fLogin"><div class="field"><label>อีเมล</label><input type="email" id="lEmail" autocomplete="username" required></div><div class="field"><label>รหัสผ่าน</label><input type="password" id="lPass" autocomplete="current-password" required></div><button class="btn pri" type="submit">เข้าสู่ระบบ</button></form><div class="links"><a data-g="signup">สมัครใช้งาน</a><a data-g="forgot">ลืมรหัสผ่าน</a></div>`;
  if(kind==='signup')B.innerHTML=`<h3>สมัครใช้งาน</h3>${note}<form id="fSignup"><div class="field"><label>ชื่อ–นามสกุล</label><input type="text" id="sName" required maxlength="120"></div><div class="field"><label>อีเมล</label><input type="email" id="sEmail" autocomplete="username" required></div><div class="field"><label>รหัสผ่าน (อย่างน้อย 8 ตัว)</label><input type="password" id="sPass" autocomplete="new-password" minlength="8" required></div><button class="btn pri" type="submit">สมัคร</button></form><p class="muted" style="font-size:12.5px;margin:10px 0 0">หลังสมัคร ผู้ดูแลระบบต้องอนุมัติก่อนจึงจะเห็นข้อมูล</p>${back}`;
  if(kind==='forgot')B.innerHTML=`<h3>ลืมรหัสผ่าน</h3>${note}<form id="fForgot"><div class="field"><label>อีเมลที่ใช้สมัคร</label><input type="email" id="fEmail" required></div><button class="btn pri" type="submit">ส่งลิงก์ตั้งรหัสผ่านใหม่</button></form>${back}`;
  if(kind==='reset')B.innerHTML=`<h3>ตั้งรหัสผ่านใหม่</h3>${note}<form id="fReset"><div class="field"><label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)</label><input type="password" id="rPass" autocomplete="new-password" minlength="8" required></div><button class="btn pri" type="submit">บันทึกรหัสผ่าน</button></form>`;
  if(kind==='pending')B.innerHTML=`<h3>รอผู้ดูแลอนุมัติ</h3><p class="muted">บัญชี <b>${esc(ME?.email)}</b> สมัครเรียบร้อยแล้ว แจ้งผู้ดูแลระบบให้กำหนดสิทธิ์ แล้วกด “ตรวจสอบอีกครั้ง”</p><div class="row"><button class="btn pri" id="gRetry" style="width:auto">ตรวจสอบอีกครั้ง</button><button class="btn" id="gOut">ออกจากระบบ</button></div>`;
  if(kind==='nobase')B.innerHTML=`<h3>ยังไม่มีข้อมูลตั้งต้น</h3><p class="muted">ผู้ดูแลระบบยังไม่ได้อัปโหลดไฟล์ข้อมูลตั้งต้น (sites.json)</p><div class="row"><button class="btn pri" id="gRetry" style="width:auto">ตรวจสอบอีกครั้ง</button><button class="btn" id="gOut">ออกจากระบบ</button></div>`;
  if(kind==='setup')B.innerHTML=`<h3>ตั้งค่าครั้งแรก</h3>${note}<p class="muted" style="font-size:13px">คุณเป็นผู้ดูแลระบบ อัปโหลดไฟล์ข้อมูลตั้งต้น <b>sites.json</b> (มากับชุดติดตั้ง) เพื่อเริ่มใช้งาน ไฟล์จะเก็บใน Supabase Storage แบบไม่เปิดสาธารณะ</p><label class="btn pri" style="width:100%;justify-content:center">เลือกไฟล์ sites.json<input type="file" id="setupFile" accept=".json,application/json" class="hide"></label><div id="setupMsg"></div><div class="row" style="margin-top:12px"><button class="btn" id="gOut">ออกจากระบบ</button></div>`;
  if(kind==='error')B.innerHTML=`<h3>เกิดข้อผิดพลาด</h3>${note}<div class="row"><button class="btn pri" id="gRetry" style="width:auto">ลองอีกครั้ง</button><button class="btn" id="gOut">ออกจากระบบ</button></div>`;
  B.querySelectorAll('[data-g]').forEach(a=>a.onclick=()=>gate(a.dataset.g));
  const busy=(f,on)=>{const b=f.querySelector('button[type=submit]');b.disabled=on;b.textContent=on?'กรุณารอสักครู่…':b.dataset.t||(b.dataset.t=b.textContent)};
  const f=B.querySelector('form');if(f){const b=f.querySelector('button[type=submit]');b.dataset.t=b.textContent}
  if($('fLogin'))$('fLogin').onsubmit=async e=>{e.preventDefault();busy(e.target,true);const{data,error}=await sb.auth.signInWithPassword({email:$('lEmail').value.trim(),password:$('lPass').value});if(error){gate('login',{m:error.message==='Invalid login credentials'?'อีเมลหรือรหัสผ่านไม่ถูกต้อง':error.message});return}enter(data.session)};
  if($('fSignup'))$('fSignup').onsubmit=async e=>{e.preventDefault();busy(e.target,true);const{data,error}=await sb.auth.signUp({email:$('sEmail').value.trim(),password:$('sPass').value,options:{data:{full_name:$('sName').value.trim()},emailRedirectTo:location.origin+location.pathname}});if(error){gate('signup',{m:error.message});return}if(data.session)enter(data.session);else gate('login',{t:'ok',m:'สมัครแล้ว — เปิดอีเมลเพื่อยืนยัน แล้วกลับมาเข้าสู่ระบบ'})};
  if($('fForgot'))$('fForgot').onsubmit=async e=>{e.preventDefault();busy(e.target,true);const{error}=await sb.auth.resetPasswordForEmail($('fEmail').value.trim(),{redirectTo:location.origin+location.pathname});gate('login',error?{m:error.message}:{t:'ok',m:'ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว'})};
  if($('fReset'))$('fReset').onsubmit=async e=>{e.preventDefault();busy(e.target,true);const{data,error}=await sb.auth.updateUser({password:$('rPass').value});if(error){gate('reset',{m:error.message});return}RECOVERY=false;const{data:s}=await sb.auth.getSession();if(s.session)enter(s.session);else gate('login',{t:'ok',m:'ตั้งรหัสผ่านใหม่แล้ว'})};
  if($('gRetry'))$('gRetry').onclick=async()=>{const{data}=await sb.auth.getSession();if(data.session)enter(data.session,true);else gate('login')};
  if($('gOut'))$('gOut').onclick=()=>sb.auth.signOut();
  if($('setupFile'))$('setupFile').onchange=e=>uploadBaseline(e.target.files[0],$('setupMsg'),true);
}
async function enter(session,force){
  if(!session||(entering&&!force)||RECOVERY)return;entering=true;
  try{
    ME={id:session.user.id,email:session.user.email};
    const{data:p,error}=await sb.from('profiles').select('*').eq('id',ME.id).maybeSingle();
    if(error)throw error;
    ME.role=p?.role||'pending';ME.name=p?.full_name||'';
    if(ME.role==='pending'){entering=false;gate('pending');return}
    canWrite=ME.role==='editor'||ME.role==='admin';
    (await fetchAll('profiles')).forEach(x=>PROFILES.set(x.id,x));
    $('gateBody').innerHTML='<div class="loading" style="padding:30px">กำลังโหลดข้อมูล…</div>';
    const{data:blob,error:e2}=await sb.storage.from('baseline').download('sites.json');
    if(e2||!blob){entering=false;gate(isAdmin()?'setup':'nobase');return}
    const data=JSON.parse(await blob.text());
    $('gate').classList.add('hide');$('app').classList.remove('hide');
    renderUser();
    await boot(data);
  }catch(e){entering=false;gate('error',{m:e.message||String(e)})}
}
function renderUser(){
  $('userPill').textContent=(ME.name||ME.email)+' · '+ROLE_TH[ME.role];
  $('logoutBtn').onclick=()=>sb.auth.signOut();
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hide',!isAdmin()));
}
async function uploadBaseline(file,out,reload){
  if(!file)return;out.innerHTML='<div class="msg info">กำลังตรวจไฟล์…</div>';
  try{const txt=await file.text();const d=JSON.parse(txt);
    if(!Array.isArray(d.rows)||!Array.isArray(d.months)||!d.cols)throw new Error('ไม่ใช่ไฟล์ข้อมูลตั้งต้นของระบบนี้');
    out.innerHTML=`<div class="msg info">กำลังอัปโหลด ${fmt(d.rows.length)} สถานี…</div>`;
    const{error}=await sb.storage.from('baseline').upload('sites.json',new Blob([txt],{type:'application/json'}),{upsert:true,contentType:'application/json'});
    if(error)throw error;
    out.innerHTML='<div class="msg ok">อัปโหลดแล้ว — กำลังเปิดระบบ…</div>';
    if(reload){const{data:ss}=await sb.auth.getSession();entering=false;enter(ss.session,true)}else setTimeout(()=>location.reload(),1200);
  }catch(e){out.innerHTML=`<div class="msg err">อัปโหลดไม่สำเร็จ: ${esc(e.message)}</div>`}
}
async function renderAdmin(){
  if(!isAdmin())return;
  const ps=[...PROFILES.values()].sort((a,b)=>(a.role==='pending'?0:1)-(b.role==='pending'?0:1)||String(a.created_at).localeCompare(String(b.created_at)));
  const pend=ps.filter(p=>p.role==='pending').length;$('pendBadge').textContent=pend;$('pendBadge').classList.toggle('hide',!pend);
  if(!$('v-admin').classList.contains('on'))return;
  let h='<thead><tr><th>ชื่อ</th><th>อีเมล</th><th>สิทธิ์</th><th>สมัครเมื่อ</th></tr></thead><tbody>';
  for(const p of ps)h+=`<tr><td>${esc(p.full_name)||'<span class="muted">–</span>'}${p.id===ME.id?' <span class="badge info">คุณ</span>':''}</td><td>${esc(p.email)}</td><td><select class="role-sel" data-u="${p.id}">${Object.entries(ROLE_TH).map(([k,v])=>`<option value="${k}"${p.role===k?' selected':''}>${v}</option>`).join('')}</select>${p.role==='pending'?' <span class="badge warn">ใหม่</span>':''}</td><td class="muted">${p.created_at?new Date(p.created_at).toLocaleDateString('th-TH'):''}</td></tr>`;
  $('tblUsers').innerHTML=h+'</tbody>';
  $('tblUsers').querySelectorAll('select').forEach(s=>s.onchange=async()=>{const id=s.dataset.u;const{error}=await sb.from('profiles').update({role:s.value}).eq('id',id);
    if(error){$('userMsg').innerHTML=`<div class="msg err">${esc(error.message)}</div>`;s.value=PROFILES.get(id).role;return}
    PROFILES.set(id,Object.assign({},PROFILES.get(id),{role:s.value}));$('userMsg').innerHTML=`<div class="msg ok">ปรับสิทธิ์ ${esc(nameOf(id))} เป็น “${ROLE_TH[s.value]}” แล้ว</div>`;renderAdmin()});
  $('baseInfo').textContent=`ปัจจุบัน: ${fmt(BASE_ROWS.length)} สถานี · ประวัติ ${mL(MONTHS[0])} – ${mL(BASE)} · สถานีที่เพิ่มจากไฟล์รายเดือน ${fmt(store.extras.size)} สถานี (การอัปโหลดไฟล์ใหม่ไม่ลบรายการที่บันทึกไว้)`;
  $('baseFile').onchange=async e=>{const f=e.target.files[0];if(!f)return;if(await confirmBox('แทนที่ข้อมูลตั้งต้น?','ทุกคนจะใช้ไฟล์ใหม่นี้เป็นยอดตั้งต้นทันที','แทนที่'))uploadBaseline(f,$('baseMsg'));else e.target.value=''};
  $('auditReload').onclick=loadAudit;
}
async function loadAudit(){
  if(!isAdmin())return;$('tblAudit').innerHTML='<tbody><tr><td class="muted">กำลังโหลด…</td></tr></tbody>';
  const{data,error}=await sb.from('audit_log').select('*').order('at',{ascending:false}).limit(200);
  if(error){$('tblAudit').innerHTML=`<tbody><tr><td class="msg err">${esc(error.message)}</td></tr></tbody>`;return}
  const act={INSERT:'เพิ่ม',UPDATE:'แก้ไข',DELETE:'ลบ'};
  const desc=r=>{const x=r.new_row||r.old_row||{};
    if(r.tbl==='changes')return`${mL(x.month)} · <b>${esc(x.sc)}</b> รื้อ ${sum(x.rm||[])} ติดตั้ง ${sum(x.ins||[])} ${esc(x.note||'')}${x.src==='import'?' <span class="badge">นำเข้าไฟล์</span>':''}`;
    if(r.tbl==='months')return`${mLF(x.month)} → ${x.closed?'ปิดเดือน':'เปิดเดือน'}`;
    if(r.tbl==='profiles')return`${esc(x.email)}: ${ROLE_TH[r.old_row?.role]||''} → ${ROLE_TH[x.role]||''}`;
    if(r.tbl==='extra_sites')return`สถานีใหม่ <b>${esc(x.data?.sc)}</b> (${mL(x.from_month)})`;return''};
  $('tblAudit').innerHTML='<thead><tr><th>เวลา</th><th>ผู้ใช้</th><th>การกระทำ</th><th>รายละเอียด</th></tr></thead><tbody>'+(data.map(r=>`<tr><td class="muted">${new Date(r.at).toLocaleString('th-TH')}</td><td>${esc(nameOf(r.user_id))||'<span class="muted">ระบบ</span>'}</td><td>${act[r.action]||r.action}</td><td style="white-space:normal">${desc(r)}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">ยังไม่มีประวัติ</td></tr>')+'</tbody>';
}
async function start(){
  if(!SUPABASE_URL||/YOUR-PROJECT/.test(SUPABASE_URL)||!SUPABASE_KEY||/YOUR-/.test(SUPABASE_KEY)){gate('config');return}
  sb.auth.onAuthStateChange((ev,session)=>{
    if(ev==='PASSWORD_RECOVERY'){RECOVERY=true;gate('reset');return}
    if(ev==='SIGNED_OUT'){location.hash='';location.reload();return}
    if(ev==='SIGNED_IN'&&session&&!ME&&!RECOVERY)setTimeout(()=>enter(session),0);
  });
  const{data:{session}}=await sb.auth.getSession();
  if(RECOVERY)return;
  if(session)enter(session);else gate('login');
}
start();

