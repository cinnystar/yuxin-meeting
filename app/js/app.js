/* 會議紀錄管理系統：會議總覽、會議總表、會議內容、會議查詢、新增／編輯會議紀錄。
   資料來源：data/meetings.js（正式資料）＋本機瀏覽器暫存（尚未寫入資料夾的新會議）。
   連結資料夾後（File System Access API），新增／編輯會直接寫入 data/meetings.js 與 會議紀錄/<年>/<編號>/ 附件。 */
(function(){
'use strict';

// ---------- helpers ----------
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const el=h=>{const t=document.createElement('template');t.innerHTML=h.trim();return t.content.firstElementChild};
const fmtSize=b=>!b?'':b<1024?b+' B':b<1048576?(b/1024).toFixed(0)+' KB':(b/1048576).toFixed(1)+' MB';
const roc=y=>y-1911;
const WD='日一二三四五六';
const rocDate=d=>d?`${roc(+d.slice(0,4))}/${d.slice(5,7)}/${d.slice(8,10)}`:'—';
const wday=d=>d?WD[new Date(d+'T00:00:00').getDay()]:'';
const TODAY=new Date();
const TODAY_S=new Date(TODAY.getTime()-TODAY.getTimezoneOffset()*60000).toISOString().slice(0,10);
const CUR_Y=TODAY.getFullYear();
const reEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fileUrl=p=>p.split('/').map(encodeURIComponent).join('/');
const safeName=s=>String(s).replace(/[\\/:*?"<>|]/g,'_').trim()||'file';
function toast(msg){const t=el(`<div class="toast" role="status">${esc(msg)}</div>`);document.body.append(t);setTimeout(()=>t.remove(),2600)}
const store={
  get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true}catch(e){toast('瀏覽器無法儲存資料');return false}}
};

// ---------- IndexedDB：暫存附件檔、記住連結的資料夾 ----------
const idb={
  db:null,
  open(){if(this.db)return Promise.resolve(this.db);return new Promise((res,rej)=>{let r;try{r=indexedDB.open('meeting-files',1)}catch(e){return rej(e)}r.onupgradeneeded=()=>{r.result.createObjectStore('files');r.result.createObjectStore('kv')};r.onsuccess=()=>{this.db=r.result;res(this.db)};r.onerror=()=>rej(r.error)})},
  async put(st,k,v){const db=await this.open();return new Promise((res,rej)=>{const tx=db.transaction(st,'readwrite');tx.objectStore(st).put(v,k);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)})},
  async get(st,k){const db=await this.open();return new Promise((res,rej)=>{const q=db.transaction(st).objectStore(st).get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})},
  async del(st,k){const db=await this.open();return new Promise(res=>{const tx=db.transaction(st,'readwrite');tx.objectStore(st).delete(k);tx.oncomplete=res;tx.onerror=res})}
};

// ---------- 資料夾寫入（File System Access API） ----------
const fsx={
  dir:null,name:'',
  supported:typeof window.showDirectoryPicker==='function',
  async restore(){if(!this.supported)return;try{const h=await idb.get('kv','dir');if(h){this.dir=h;this.name=h.name}}catch(e){}},
  // 使用者可選 app 資料夾或專案資料夾（自動往下找 app）
  async connect(){
    let h=await window.showDirectoryPicker({id:'meeting-app',mode:'readwrite'});
    const has=async(d,n)=>{try{await d.getDirectoryHandle(n);return true}catch(e){return false}};
    if(!await has(h,'data')&&await has(h,'app'))h=await h.getDirectoryHandle('app');
    if(!await has(h,'data'))throw new Error('請選擇含有 data 資料夾的系統資料夾（app）');
    this.dir=h;this.name=h.name;await idb.put('kv','dir',h);return true;
  },
  async ready(ask){
    if(!this.dir)return false;
    let p=await this.dir.queryPermission({mode:'readwrite'});
    if(p!=='granted'&&ask)p=await this.dir.requestPermission({mode:'readwrite'});
    return p==='granted';
  },
  async subdir(parts){let d=this.dir;for(const p of parts)d=await d.getDirectoryHandle(p,{create:true});return d},
  async write(path,blob){const parts=path.split('/'),name=parts.pop();const d=await this.subdir(parts);const fh=await d.getFileHandle(name,{create:true});const w=await fh.createWritable();await w.write(blob);await w.close()},
  async removeFolder(parts){try{const name=parts.pop();const d=await this.subdir(parts);await d.removeEntry(name,{recursive:true})}catch(e){}},
  async removeFile(path){try{const parts=path.split('/'),name=parts.pop();const d=await this.subdir(parts);await d.removeEntry(name)}catch(e){}}
};
function dataJs(list){
  const keep=m=>({id:m.id,type:m.type,date:m.date,time:m.time||'',end:m.end||'',title:m.title,who:m.who||'',att:!!m.att,files:(m.files||[]).filter(f=>f.path).map(f=>[f.path,f.size]),src:m.src||'',content:m.content||''});
  const rows=list.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id)).map(m=>JSON.stringify(keep(m)));
  return `// 會議紀錄資料：由「新增會議紀錄」頁寫入，也可手動編輯（每筆一行）。\n// 欄位：id、type 會議類別、date 日期、time 開始時間、end 結束時間、title 主題、who 出席者、content 內容（## 標題、### 小標、- 項目）、att 是否有附件、files 附件 [路徑, 大小]、src 原始來源\n// 最後更新：${new Date().toLocaleString('zh-TW',{hour12:false})}\nwindow.MEETING_DATA=[\n${rows.join(',\n')}\n];\n`;
}

// ---------- data ----------
// 固定類別；新增時選「其他」輸入的名稱會自動加入類別清單
const BASE_TYPES=['廠長會議','服務部會議','改善會議','課程會議'];
let OFFICIAL=[],PENDING=[],MEETINGS=[];
function norm(m,pending){
  const files=(m.files||[]).map(f=>Array.isArray(f)?{name:f[0].split('/').pop(),path:f[0],size:f[1]}:f);
  const o={id:m.id,type:m.type||'其他會議',date:m.date||'',time:m.time||'',end:m.end||'',title:m.title||'',who:m.who||'',att:!!m.att||files.length>0,files,src:m.src||'',content:m.content||'',pending:!!pending};
  o.year=+o.date.slice(0,4);o.month=+o.date.slice(5,7);
  o.todos=todosOf(o.content);
  o._hay=[o.title,o.type,o.who,o.content,files.map(f=>f.name).join(' ')].join('\n').toLowerCase();
  return o;
}
function load(){
  OFFICIAL=(window.MEETING_DATA||[]).map(m=>norm(m,false));
  PENDING=store.get('meetings.pending',[]).map(m=>norm(m,true));
  const pid=new Set(PENDING.map(m=>m.id));
  MEETINGS=[...OFFICIAL.filter(m=>!pid.has(m.id)),...PENDING];
  MEETINGS.sort((a,b)=>b.date.localeCompare(a.date)||(b.time||'').localeCompare(a.time||'')||b.id.localeCompare(a.id));
}
const savePending=()=>store.set('meetings.pending',PENDING.map(m=>({id:m.id,type:m.type,date:m.date,time:m.time,end:m.end,title:m.title,who:m.who,att:m.att,files:m.files,src:m.src,content:m.content})));
const types=()=>[...new Set([...BASE_TYPES,...MEETINGS.map(m=>m.type)])];
const typeCls=t=>{const i=types().indexOf(t);return i===0?'t1':i===1?'t2':i===2?'t3':'t4'};
const typeColor=t=>{const i=types().indexOf(t);return 'var(--k'+Math.min(i+1,4)+')'};
const typePill=t=>`<span class="pill ${typeCls(t)}">${esc(t)}</span>`;
const years=()=>{const s=[...new Set(MEETINGS.map(m=>m.year).filter(Boolean))];if(!s.includes(CUR_Y))s.push(CUR_Y);return s.sort((a,b)=>b-a)};
const byId=id=>MEETINGS.find(m=>m.id===id);
let YEAR=CUR_Y,TYPE='';
const scoped=()=>MEETINGS.filter(m=>(YEAR==='all'||m.year===YEAR)&&(!TYPE||m.type===TYPE));
const yearLabel=y=>y==='all'?'全部年度':`${roc(y)} 年度（${y}）`;
const when=m=>`${rocDate(m.date)}（${wday(m.date)}）${m.time?' '+m.time+(m.end?'–'+m.end:''):''}`;

// ---------- 內容格式：## 大標、### 小標、- 項目（前面空兩格為子項目） ----------
function todosOf(c){
  const out=[];let on=false;
  for(const line of String(c||'').split('\n')){
    const h=/^#{2}\s+(.*)/.exec(line);
    if(h){on=/待辦|追蹤|action/i.test(h[1]);continue}
    if(/^#\s/.test(line)){on=false;continue}
    if(/^#{3}\s/.test(line))continue;
    const li=/^- (.*)/.exec(line);
    if(on&&li)out.push(li[1].trim());
  }
  return out;
}
// 待辦拆解：「各廠長：11月13日內完成…」→ 交辦對象、期限（取最後一天）、事項
const ymd=(y,m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const lastDay=(y,m)=>new Date(y,m,0).getDate();
function parseTodo(text,mDate){
  let who='',task=text;
  const w=/^([^：:]{1,14})[：:]\s*(.+)$/.exec(text);
  if(w){who=w[1].trim();task=w[2].trim()}
  // 「（負責人未明確指定）」是 Notion 的附註，拿掉；有寫對象就照對象，沒寫才算未指定
  task=task.replace(/\s*[（(]\s*負責人未(?:明確)?指定\s*[)）]/,'').trim();
  // 多個對象拆開：「濱江、北投、汐止」「各廠長與主管」
  const whoList=who?who.split(/\s*(?:[、,，\/／]|及|與|和)\s*/).filter(Boolean):[];
  const my=+mDate.slice(0,4),mm=+mDate.slice(5,7);
  const yOf=m=>m<mm-6?my+1:my;
  let due='',dueTxt='';
  // 允許空格：「12 月 1 日」「12 月 26、27 日」
  let r=/(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:[至到~～－–\-、]\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日?)?/.exec(task);
  if(r){const m1=+r[1],d1=+r[2],m2=r[3]?+r[3]:m1,d2=r[4]?+r[4]:null;
    due=ymd(yOf(m2),m2,d2||d1);dueTxt=d2?`${m1}/${d1}–${m2!==m1?m2+'/':''}${d2}`:`${m1}/${d1}`}
  else if((r=/(\d{1,2})\s*月\s*(底|初|中)/.exec(task))){const m1=+r[1],y=yOf(m1),d=r[2]==='底'?lastDay(y,m1):r[2]==='初'?5:15;due=ymd(y,m1,d);dueTxt=`${m1}月${r[2]}`}
  // 沒寫日期＝持續追蹤，期限算到會議當月月底
  let track=false;
  if(!due){track=true;const d=lastDay(my,mm);due=ymd(my,mm,d);dueTxt=`${mm}/${d}`}
  return {who,whoList,task,due,dueTxt,track};
}
const asgTags=t=>t.whoList.length?t.whoList.map(x=>`<span class="asg-tag">${esc(x)}</span>`).join(''):'<span class="asg-tag none">未指定</span>';
function dueCell(t){
  return `<span class="due">${esc(t.dueTxt)}${t.track?'<small>持續追蹤</small>':''}</span>`;
}
// ---------- 貼上轉換：Notion／網頁／Word 的 HTML 或純文字 → ## / ### / - 格式 ----------
const HEAD_MAP={'action items':'待辦事項','action item':'待辦事項','next steps':'待辦事項','decisions':'決議事項','open questions':'待釐清問題','questions':'待釐清問題','summary':'會議摘要','notes':'筆記','key takeaways':'重點摘要','agenda':'議程'};
const mapHead=s=>HEAD_MAP[s.trim().toLowerCase()]||s.trim();
// Notion AI 摘要的引用編號（例：「…回報 1​」「… 2 3​」）
const cleanCite=s=>String(s).replace(/[\s ]*(?:\d{1,3}[\s ]*)+​/g,'').replace(/[​‌‍﻿]/g,'').replace(/[\s ]+/g,' ').trim();
function htmlToMd(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  doc.querySelectorAll('script,style,meta,link,sup,[class*=citation],[class*=footnote]').forEach(x=>x.remove());
  const out=[];
  const isList=e=>/^(UL|OL)$/.test(e.tagName);
  const cls=e=>String(e.className||'');
  const isHead=e=>/^H[1-6]$/.test(e.tagName)||/header-block/.test(cls(e));
  const isItem=e=>e.tagName==='LI'||/(bulleted_list|numbered_list|to_do|toggle)-block/.test(cls(e));
  const isBlock=e=>isList(e)||isHead(e)||isItem(e)||/^(P|DIV|TABLE|SECTION|BLOCKQUOTE|PRE)$/.test(e.tagName);
  // 只取這一層的文字，不含子清單／子區塊
  const inline=e=>{let s='';e.childNodes.forEach(n=>{if(n.nodeType===3)s+=n.textContent;else if(n.nodeType===1){if(n.tagName==='BR')s+=' ';else if(!isBlock(n)||(n.tagName==='DIV'&&!n.querySelector('ul,ol,li,p,h1,h2,h3,h4,[class*=-block]')))s+=n.textContent}});return cleanCite(s)};
  const level=e=>{const m=/^H(\d)$/.exec(e.tagName);if(m)return +m[1];const c=cls(e);return /sub_sub_header/.test(c)?3:/sub_header/.test(c)?2:1};
  const walk=(node,depth)=>{
    for(const c of node.children){
      if(isHead(c)){const t=cleanCite(c.textContent);if(t)out.push((level(c)<=2?'## ':'### ')+mapHead(t));continue}
      if(isList(c)){walk(c,depth);continue}
      if(isItem(c)){const t=inline(c);if(t)out.push('  '.repeat(depth)+'- '+t);walk(c,depth+(t?1:0));continue}
      if(c.tagName==='P'||/text-block/.test(cls(c))){const t=inline(c);if(t)out.push(depth?'  '.repeat(depth-1)+'- '+t:(HEAD_MAP[t.toLowerCase()]?'## '+mapHead(t):t));walk(c,depth);continue}
      if(c.tagName==='TR'){const t=[...c.children].map(x=>cleanCite(x.textContent)).filter(Boolean).join('｜');if(t)out.push('- '+t);continue}
      if(c.children.length)walk(c,depth);
      else{const t=cleanCite(c.textContent);if(t&&/^(DIV|SPAN|TD)$/.test(c.tagName))out.push(depth?'  '.repeat(depth-1)+'- '+t:t)}
    }
  };
  walk(doc.body,0);
  return out.join('\n');
}
// 純文字整理：去掉引用編號；英文段落名改中文大標題；「•」「・」「*」開頭改成「- 」
// 段落標題底下的一般行視為項目；「會議摘要」段落中沒有引用編號的短行視為小標題（Notion AI 摘要的寫法）
function tidyText(t){
  let sec='';
  return String(t).replace(/\r/g,'').split('\n').map(l=>{
    const ind=(/^[ \t]*/.exec(l)[0]).replace(/\t/g,'  ');
    const cited=/\d[\s ]*​/.test(l);
    let s=cleanCite(l);
    if(!s)return '';
    const h=/^(#{2,3})\s+(.*)$/.exec(s);
    if(h){if(h[1]==='##')sec=h[2];return s}
    if(/^-\s/.test(s))return ind+s;
    if(HEAD_MAP[s.toLowerCase()]){sec=mapHead(s);return '## '+sec}
    const b=/^[•・●▪◦*‧]\s*(.*)$/.exec(s);if(b)return ind+'- '+b[1];
    const n=/^\d{1,2}[.、)]\s*(.*)$/.exec(s);if(n&&n[1])return ind+'- '+n[1];
    if(!sec)return ind?ind+'- '+s:s;
    if(/摘要|筆記/.test(sec)&&!cited&&!ind&&s.length<=20&&!/[。；，]$/.test(s))return '### '+s;
    return ind+'- '+s;
  }).join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
function renderMd(c,hl){
  const lines=String(c||'').replace(/\r/g,'').split('\n');
  let html='',depth=0,todo=false;
  const close=to=>{while(depth>to){html+='</li></ul>';depth--}};
  for(const raw of lines){
    if(!raw.trim()){continue}
    const h1=/^#\s+(.*)/.exec(raw);   // # 階段（例：第一階段、第二階段）
    if(h1){close(0);todo=false;html+=`<div class="phase">${hlText(h1[1],hl)}</div>`;continue}
    const h2=/^##\s+(.*)/.exec(raw),h3=/^###\s+(.*)/.exec(raw),li=/^(\s*)[-*•]\s+(.*)/.exec(raw);
    if(h3){close(0);html+=`<h3>${hlText(h3[1],hl)}</h3>`;continue}
    if(h2&&!h3){close(0);todo=/待辦|追蹤|action/i.test(h2[1]);html+=`<h2>${hlText(h2[1],hl)}</h2>`;continue}
    if(li){
      const lv=Math.min(3,Math.floor(li[1].replace(/\t/g,'  ').length/2)+1);
      if(lv>depth){while(depth<lv){html+=`<ul${depth===0&&todo?' class="todo"':''}><li>`;depth++}}
      else{close(lv);html+='</li><li>'}
      const w=todo&&lv===1?/^([^：:]{1,14})([：:])(.*)$/.exec(li[2]):null;
      html+=w?`<b class="who">${hlText(w[1],hl)}</b>${w[2]}${hlText(w[3],hl)}`:hlText(li[2],hl);continue;
    }
    close(0);html+=`<p>${hlText(raw.trim(),hl)}</p>`;
  }
  close(0);
  return html.replace(/<li><\/li>/g,'');
}

// ---------- routes ----------
const ROUTES=[
  {g:'會議'},
  {id:'board',t:'會議總覽',r:renderBoard},
  {id:'list',t:'會議總表',r:renderList},
  {g:'查詢'},
  {id:'search',t:'會議查詢',r:renderSearch},
  {g:'管理'},
  {id:'new',t:'新增會議紀錄',r:renderForm}
];
function initShell(){
  let n=0;
  $('#nav').innerHTML=ROUTES.map(r=>r.g?`<div class="nav-g">${r.g}</div>`:`<a class="nav-a" href="#/${r.id}" data-id="${r.id}"><span class="no">${++n}</span>${r.t}</a>`).join('');
  const side=$('#side');
  $('#menuBtn').onclick=()=>side.classList.toggle('open');
  $('#nav').addEventListener('click',e=>{if(e.target.closest('.nav-a'))side.classList.remove('open')});
  if(!years().includes(YEAR))YEAR=years()[0]||CUR_Y;
  fillScope();
  $('#yrSel').onchange=e=>{YEAR=e.target.value==='all'?'all':+e.target.value;route()};
  $('#tpSel').onchange=e=>{TYPE=e.target.value;route()};
  window.addEventListener('hashchange',route);
}
function fillScope(){
  $('#yrSel').innerHTML=years().map(y=>`<option value="${y}">${roc(y)} 年（${y}）</option>`).join('')+'<option value="all">全部年度</option>';
  $('#yrSel').value=String(YEAR);
  $('#tpSel').innerHTML='<option value="">全部會議</option>'+types().map(t=>`<option>${esc(t)}</option>`).join('');
  $('#tpSel').value=TYPE;
}
function setYear(y){YEAR=y;fillScope()}
function route(){
  const h=location.hash.replace(/^#\/?/,'');
  const [path,qs]=h.split('?');
  const parts=path.split('/');
  const params=new URLSearchParams(qs||'');
  // 從總入口進來：#/board?tp=廠長會議 → 切換類別後把 tp 從網址拿掉
  if(params.has('tp')){TYPE=params.get('tp');fillScope();params.delete('tp');const q=params.toString();history.replaceState(null,'','#/'+path+(q?'?'+q:''))}
  const main=$('#main');main.innerHTML='';tip(null);
  if(parts[0]==='m'){renderMeeting(main,decodeURIComponent(parts[1]||''));setNav('list')}
  else if(parts[0]==='edit'){$('#topTitle').textContent='編輯會議紀錄';renderForm(main,params,decodeURIComponent(parts[1]||''));setNav('new')}
  else{const r=ROUTES.find(x=>x.id===parts[0])||ROUTES[1];$('#topTitle').textContent=r.t;r.r(main,params);setNav(r.id)}
  $('#topMeta').textContent=`${yearLabel(YEAR)}${TYPE?' · '+TYPE:''} · ${scoped().length} 場會議`;
  $('#sideFoot').textContent=`共 ${MEETINGS.length} 場會議${PENDING.length?` · ${PENDING.length} 場未寫入資料夾`:''}`;
  window.scrollTo(0,0);
}
function setNav(id){document.querySelectorAll('.nav-a').forEach(a=>{if(a.dataset.id===id)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')})}
const go=h=>{location.hash=h};
const openMeeting=id=>go('#/m/'+encodeURIComponent(id));

// ---------- shared UI ----------
function pageH(t,p,actions){return el(`<div class="page-h"><div><h1>${t}</h1>${p?`<p>${p}</p>`:''}</div>${actions?`<div class="btn-row">${actions}</div>`:''}</div>`)}
function cards(items){
  const w=el('<div class="cards"></div>');
  items.forEach(c=>{const b=el(`<${c.go?'button type="button"':'div'} class="card ${c.cls||''}"><span class="lbl">${c.l}</span><span class="val num">${c.val}</span><span class="sub">${c.sub||''}</span></${c.go?'button':'div'}>`);if(c.go)b.onclick=c.go;w.append(b)});
  return w;
}
function fileExt(name){const m=/\.([a-z0-9]+)$/i.exec(name||'');const e=m?m[1].toLowerCase():'';return /^(png|jpe?g|gif|webp|bmp)$/.test(e)?'img':e}
function tip(e,html){const t=$('#tip');if(!e||!html){t.hidden=true;return}t.innerHTML=html;t.hidden=false;const x=Math.min(e.clientX+14,innerWidth-t.offsetWidth-8);t.style.left=x+'px';t.style.top=(e.clientY+14)+'px'}
function hlText(s,kw){s=esc(s);const terms=(kw||[]).filter(Boolean).map(t=>reEsc(esc(t)));if(!terms.length)return s;return s.replace(new RegExp('('+terms.join('|')+')','gi'),'<mark>$1</mark>')}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000)}
const attCell=m=>m.files.length?`<span class="clip" title="${m.files.length} 個附件">📎${m.files.length}</span>`:m.att?'<span class="note">有（未上傳）</span>':'<span class="note">無</span>';

// 堆疊直條圖：items=[{label,key,vals:{類別:數量}}]
function stackChart(items,tps,{onPick,hiKey}={}){
  const tot=x=>tps.reduce((s,t)=>s+(x.vals[t]||0),0);
  const mx=Math.max(1,...items.map(tot));
  const W=560,H=220,P={l:30,r:8,t:12,b:24},bw=(W-P.l-P.r)/items.length;
  const yv=v=>P.t+(H-P.t-P.b)*(1-v/mx);
  const step=Math.max(1,Math.ceil(mx/4));
  let svg=`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  for(let v=0;v<=mx;v+=step)svg+=`<line x1="${P.l}" x2="${W-P.r}" y1="${yv(v)}" y2="${yv(v)}" stroke="var(--line)"/><text x="${P.l-6}" y="${yv(v)+4}" text-anchor="end">${v}</text>`;
  items.forEach((x,i)=>{const x0=P.l+i*bw+bw*.2,w=bw*.6;let acc=0;
    tps.forEach(t=>{const v=x.vals[t]||0;if(!v)return;const y1=yv(acc+v),y0=yv(acc);svg+=`<rect x="${x0}" y="${y1}" width="${w}" height="${y0-y1}" fill="${typeColor(t)}" opacity="${hiKey&&x.key!==hiKey?.55:1}"/>`;acc+=v});
    if(acc)svg+=`<text x="${x0+w/2}" y="${yv(acc)-4}" text-anchor="middle" style="fill:var(--ink-2)">${acc}</text>`;
    svg+=`<rect class="hb-hit" data-i="${i}" x="${P.l+i*bw}" y="${P.t}" width="${bw}" height="${H-P.t-P.b}" fill="transparent" style="cursor:${onPick?'pointer':'default'}"/><text x="${P.l+i*bw+bw/2}" y="${H-6}" text-anchor="middle">${esc(x.label)}</text>`});
  const box=el(`<div class="chart">${svg}</svg><div class="legend" style="margin-top:6px">${tps.map(t=>`<span><i class="lgd" style="background:${typeColor(t)}"></i>${esc(t)}</span>`).join('')}</div></div>`);
  box.querySelectorAll('.hb-hit').forEach(r=>{const x=items[+r.dataset.i];
    r.onmousemove=e=>tip(e,`<b>${esc(x.label)}</b><br>${tps.map(t=>`${esc(t)}：${x.vals[t]||0} 場`).join('<br>')}`);r.onmouseleave=()=>tip(null);
    if(onPick)r.onclick=()=>{tip(null);onPick(x.key)}});
  return box;
}

// 尚未寫入資料夾的提醒
function pendingBanner(){
  if(!PENDING.length)return null;
  const b=el(`<div class="banner"><span>⚠️ 有 <b>${PENDING.length}</b> 場會議只存在此瀏覽器，尚未寫入系統資料夾（其他人看不到）。</span><span class="btn-row">${fsx.supported?'<button type="button" class="btn btn-pri btn-xs" data-a="sync">寫入資料夾</button>':''}<button type="button" class="btn btn-xs" data-a="dl">下載 meetings.js</button></span></div>`);
  const s=b.querySelector('[data-a="sync"]');if(s)s.onclick=syncPending;
  b.querySelector('[data-a="dl"]').onclick=downloadData;
  return b;
}
function downloadData(){
  downloadBlob(new Blob([dataJs(MEETINGS)],{type:'text/javascript'}),'meetings.js');
  toast(PENDING.some(m=>m.files.length)?'已下載；暫存的附件檔需另外放到 會議紀錄 資料夾':'已下載 meetings.js，請覆蓋 app\\data\\meetings.js');
}
async function ensureFolder(){
  if(!fsx.supported){toast('此瀏覽器不支援直接寫入資料夾，請改用 Edge 或 Chrome');return false}
  try{
    if(fsx.dir&&await fsx.ready(true))return true;
    await fsx.connect();return await fsx.ready(true);
  }catch(e){if(e.name!=='AbortError')toast(e.message);return false}
}
// 把暫存的會議（含附件）寫入資料夾
async function syncPending(){
  if(!await ensureFolder())return;
  try{
    for(const m of PENDING.slice()){
      await writeMeetingFiles(m);
      const i=OFFICIAL.findIndex(x=>x.id===m.id);if(i>=0)OFFICIAL[i]=m;else OFFICIAL.push(m);
    }
    await fsx.write('data/meetings.js',new Blob([dataJs(OFFICIAL)],{type:'text/javascript'}));
    window.MEETING_DATA=JSON.parse(JSON.stringify(OFFICIAL.map(m=>({...m,files:m.files.map(f=>[f.path,f.size])}))));
    for(const m of PENDING)for(const f of m.files)if(f.key)await idb.del('files',f.key);
    PENDING=[];savePending();load();fillScope();toast('已寫入資料夾');route();
  }catch(e){toast('寫入失敗：'+e.message)}
}
// 暫存檔（IndexedDB）→ 會議紀錄/<年>/<編號>/檔名
async function writeMeetingFiles(m){
  const out=[];
  for(const f of m.files){
    if(f.path){out.push(f);continue}
    const blob=await idb.get('files',f.key);if(!blob)continue;
    const path=`會議紀錄/${m.year}/${m.id}/${safeName(f.name)}`;
    await fsx.write(path,blob);out.push({name:f.name,path,size:f.size});
  }
  m.files=out;m.pending=false;
}

// ---------- 會議總覽 ----------
function renderBoard(main){
  const list=scoped();
  const isCur=YEAR===CUR_Y,curM=TODAY.getMonth()+1;
  main.append(pageH(`${yearLabel(YEAR)} 會議總覽`,'廠長、服務部、改善、課程會議整合在一起；右上角可切換類別與年度，點卡片、長條或主題可進入清單或會議內容。','<a class="btn" href="#/list">開啟會議總表 →</a><a class="btn btn-pri" href="#/new">＋ 新增會議紀錄</a>'));
  const pb=pendingBanner();if(pb)main.append(pb);
  const tps=types().filter(t=>!TYPE||t===TYPE);
  main.append(cards([
    {l:'會議總數',val:list.length,sub:YEAR==='all'?'全部年度':'本年度',cls:'info',go:()=>go('#/list')},
    ...tps.slice(0,4).map((t,i)=>({l:t,val:list.filter(m=>m.type===t).length,sub:'場',cls:'k'+(types().indexOf(t)+1),go:()=>{TYPE=t;fillScope();go('#/list')}})),
    isCur?{l:`${curM} 月會議`,val:list.filter(m=>m.month===curM).length,sub:'本月',cls:'good',go:()=>go('#/list?month='+curM)}:null,
    {l:'待辦事項',val:list.reduce((s,m)=>s+m.todos.length,0),sub:'項（會議紀錄中的待辦）'}
  ].filter(Boolean)));

  // 版面：上排「最新會議｜各類別最新一場」→ 待辦事項 → 每月（歷年）會議場次
  const g=el('<div class="grid2"></div>');
  const lp=el('<section class="panel"><div class="panel-h"><h2>最新會議</h2><p>最近 10 場</p></div></section>');
  lp.append(meetingTable(list.slice(0,10)));
  g.append(lp);
  let cp;
  if(YEAR!=='all'){
    cp=el('<section class="panel"><div class="panel-h"><h2>每月會議場次</h2><p>依類別堆疊 · 點長條看該月清單</p></div></section>');
    cp.append(stackChart(Array.from({length:12},(_,i)=>{const vals={};list.filter(m=>m.month===i+1).forEach(m=>vals[m.type]=(vals[m.type]||0)+1);return {label:(i+1)+'月',key:i+1,vals}}),tps,{onPick:m=>go('#/list?month='+m),hiKey:isCur?curM:null}));
  }else{
    cp=el('<section class="panel"><div class="panel-h"><h2>歷年會議場次</h2><p>點長條切換年度</p></div></section>');
    cp.append(stackChart(years().slice().reverse().map(y=>{const vals={};MEETINGS.filter(m=>m.year===y&&(!TYPE||m.type===TYPE)).forEach(m=>vals[m.type]=(vals[m.type]||0)+1);return {label:String(roc(y)),key:y,vals}}),tps,{onPick:y=>{setYear(y);route()}}));
  }
  // 最近一個有開會（且有待辦）的月份，該月所有會議的待辦事項；新的月份開會後才換月（依右上角類別篩選）
  const lastM=MEETINGS.find(m=>m.date<=TODAY_S&&(!TYPE||m.type===TYPE)&&m.todos.length);
  const ym=lastM?lastM.date.slice(0,7):TODAY_S.slice(0,7),tm=+ym.slice(5,7);
  const monthMs=MEETINGS.filter(m=>m.date.startsWith(ym)&&(!TYPE||m.type===TYPE)&&m.todos.length);
  const tp=el(`<section class="panel"><div class="panel-h"><h2>最近會議的待辦事項</h2><p>${roc(+ym.slice(0,4))} 年 ${tm} 月所有會議（${monthMs.length} 場）· 依期限排序 · 點列看會議內容</p></div><div class="asg-bar"></div><div class="tbl-wrap"><table class="todo-t"><thead><tr><th class="l">期限</th><th class="l">交辦對象</th><th class="l">事項</th><th class="l">會議</th></tr></thead><tbody></tbody></table></div></section>`);
  const items=monthMs.flatMap(m=>m.todos.map(t=>({...parseTodo(t,m.date),m}))).sort((a,b)=>a.due.localeCompare(b.due)||(a.track-b.track)||a.m.date.localeCompare(b.m.date));
  const tb=tp.querySelector('tbody');
  // 交辦對象篩選：點對象只看他的待辦
  const keyOf=t=>t.whoList.length?t.whoList:['未指定'];
  const cnt={};items.forEach(t=>keyOf(t).forEach(k=>cnt[k]=(cnt[k]||0)+1));
  const bar=tp.querySelector('.asg-bar');let pick='';
  const drawRows=()=>{
    tb.innerHTML='';
    items.filter(t=>!pick||keyOf(t).includes(pick)).forEach(t=>{const tr=el(`<tr class="click"><td>${dueCell(t)}</td><td class="l asg">${asgTags(t)}</td><td class="l">${esc(t.task)}</td><td class="l src">${typePill(t.m.type)}<br>${rocDate(t.m.date)}</td></tr>`);tr.onclick=()=>openMeeting(t.m.id);tb.append(tr)});
    if(!items.length)tb.innerHTML=`<tr><td colspan="4" class="empty">目前會議都沒有待辦事項</td></tr>`;
    bar.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.k===pick));
  };
  if(items.length){
    const ks=Object.keys(cnt).sort((a,b)=>(a==='未指定')-(b==='未指定')||cnt[b]-cnt[a]);
    bar.innerHTML='<span class="asg-l">交辦對象</span>'+[['',items.length,'全部'],...ks.map(k=>[k,cnt[k],k])].map(([k,n,l])=>`<button type="button" data-k="${esc(k)}" class="${k==='未指定'?'none':''}">${esc(l)}<b>${n}</b></button>`).join('');
    bar.onclick=e=>{const b=e.target.closest('button');if(!b)return;pick=b.dataset.k;drawRows()};
  }else bar.remove();
  drawRows();
  // 各類別最新一場
  const lp0=el('<section class="panel"><div class="panel-h"><h2>各類別最新一場會議</h2><p>點項目看會議內容</p></div><div class="hits"></div></section>');
  tps.forEach(t=>{const m=MEETINGS.find(x=>x.type===t);const b=el(m?`<button type="button" class="hit" style="border-left-color:${typeColor(t)}"><span class="h-t">${typePill(t)} ${esc(m.title)}</span><span class="h-m">${when(m)} · 待辦 ${m.todos.length} 項${m.files.length?' · 📎'+m.files.length:''}</span></button>`:`<div class="hit" style="border-left-color:${typeColor(t)};cursor:default"><span class="h-t">${typePill(t)} <span class="note">尚無會議紀錄</span></span></div>`);if(m)b.onclick=()=>openMeeting(m.id);lp0.querySelector('.hits').append(b)});
  g.append(lp0);
  main.append(g);
  main.append(tp);
  const g3=el('<div class="grid2 half"></div>');g3.append(cp);main.append(g3);
}

// ---------- 會議總表 ----------
function meetingTable(rows,hl){
  const w=el(`<div class="tbl-wrap"><table><thead><tr><th class="l" data-k="date">日期</th><th class="l" data-k="type">類別</th><th class="l" data-k="title">主題</th><th class="l">待辦</th><th class="l">附件</th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector('tbody');
  if(!rows.length){tb.innerHTML='<tr><td colspan="5" class="empty">沒有符合條件的會議</td></tr>';return w}
  rows.forEach(m=>{
    const tr=el(`<tr class="click"><td class="num">${rocDate(m.date)}（${wday(m.date)}）</td><td class="l">${typePill(m.type)}</td><td class="l subj"><button type="button" class="subj-a">${hlText(m.title,hl)}</button>${m.pending?'<span class="pill y">未寫入資料夾</span>':''}</td><td class="num">${m.todos.length||'—'}</td><td class="l">${attCell(m)}</td></tr>`);
    tr.onclick=()=>openMeeting(m.id);tb.append(tr)});
  return w;
}
function renderList(main,params){
  const st={q:params.get('q')||'',month:params.get('month')||'',sort:'date',dir:-1};
  main.append(pageH(`${yearLabel(YEAR)}${TYPE?' '+TYPE:''} 會議總表`,'點主題開啟會議內容；欄位標題可排序。','<button type="button" class="btn" id="csvBtn">匯出 CSV</button><a class="btn btn-pri" href="#/new">＋ 新增會議紀錄</a>'));
  const pb=pendingBanner();if(pb)main.append(pb);
  const list=scoped();
  const p=el(`<section class="panel"><div class="tbl-tools"><div class="btn-row">
    <input type="search" id="fq" placeholder="搜尋主題、內容、出席者、附件檔名" value="${esc(st.q)}" style="width:300px">
    ${YEAR==='all'?'':`<select id="fm"><option value="">全部月份</option>${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${String(i+1)===st.month?'selected':''}>${i+1} 月</option>`).join('')}</select>`}
    <button type="button" class="btn btn-xs" id="fclr">清除條件</button></div><span class="note" id="fcount"></span></div><div id="tblBox"></div></section>`);
  main.append(p);
  let rows=[];
  const draw=()=>{
    const q=st.q.trim().toLowerCase();
    rows=list.filter(m=>(!st.month||m.month===+st.month)&&(!q||m._hay.includes(q)));
    rows.sort((a,b)=>String(a[st.sort]).localeCompare(String(b[st.sort]),'zh-Hant')*st.dir||b.date.localeCompare(a.date));
    const box=p.querySelector('#tblBox');box.innerHTML='';
    const t=meetingTable(rows,q?[st.q.trim()]:null);box.append(t);
    t.querySelectorAll('th[data-k]').forEach(th=>{if(th.dataset.k===st.sort)th.setAttribute('aria-sort',st.dir>0?'ascending':'descending');th.onclick=()=>{if(st.sort===th.dataset.k)st.dir*=-1;else{st.sort=th.dataset.k;st.dir=th.dataset.k==='date'?-1:1}draw()}});
    p.querySelector('#fcount').textContent=`顯示 ${rows.length} / ${list.length} 場`;
  };
  p.querySelector('#fq').oninput=e=>{st.q=e.target.value;draw()};
  if(p.querySelector('#fm'))p.querySelector('#fm').onchange=e=>{st.month=e.target.value;draw()};
  p.querySelector('#fclr').onclick=()=>{if(location.hash==='#/list')route();else go('#/list')};
  main.querySelector('#csvBtn').onclick=()=>{
    const head=['日期','星期','開始時間','結束時間','類別','主題','出席者','待辦事項數','是否附件','附件數'];
    const q=v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
    const csv='﻿'+[head,...rows.map(m=>[m.date,wday(m.date),m.time,m.end,m.type,m.title,m.who,m.todos.length,m.att?'是':'否',m.files.length])].map(r=>r.map(q).join(',')).join('\r\n');
    downloadBlob(new Blob([csv],{type:'text/csv'}),`會議總表_${YEAR==='all'?'全部':roc(YEAR)}${TYPE?'_'+TYPE:''}.csv`);
  };
  draw();
}

// ---------- 會議內容 ----------
function renderMeeting(main,id){
  const m=byId(id);
  $('#topTitle').textContent='會議內容';
  if(!m){main.append(el('<section class="panel empty">找不到這場會議。<br><a href="#/list">回會議總表</a></section>'));return}
  if(YEAR!=='all'&&m.year!==YEAR)setYear(m.year);
  const hl=(new URLSearchParams(location.hash.split('?')[1]||'').get('hl')||'').split(/\s+/).filter(Boolean);
  const scope=scoped(),idx=scope.indexOf(m),prev=scope[idx-1],next=scope[idx+1];
  const crumbs=el(`<div class="crumbs"><button type="button">會議總表</button><span>›</span><span class="cur">${esc(m.title)}</span></div>`);
  crumbs.querySelector('button').onclick=()=>go('#/list');
  main.append(crumbs);
  if(m.pending){const pb=pendingBanner();if(pb)main.append(pb)}
  const kv=[['類別',typePill(m.type)],['日期',`${rocDate(m.date)}（星期${wday(m.date)}）<span class="note">${m.date}</span>`],['時間',esc(m.time?m.time+(m.end?' – '+m.end:''):'未填')],['出席者',esc(m.who||'未填')],['是否附件',m.att?(m.files.length?`有（${m.files.length} 份）`:'有（未上傳電子檔）'):'無'],['待辦事項',m.todos.length?m.todos.length+' 項':'—']];
  if(m.src)kv.push(['原始紀錄',`<a href="${esc(m.src)}" target="_blank" rel="noopener">開啟來源 ↗</a>`]);
  const doc=el(`<div class="doc"><article class="doc-paper">
      <div class="doc-no">${typePill(m.type)}</div>
      <h1>${hlText(m.title,hl)}</h1>
      <div class="note">${when(m)}${m.who?'　出席：'+esc(m.who):''}</div>
      ${m.content.trim()?`<div class="md">${renderMd(m.content,hl)}</div>`:'<p class="note" style="margin-top:16px">此會議尚未填寫內容。</p>'}
      <div id="viewer"></div>
    </article>
    <aside class="doc-side">
      <section class="panel"><div class="panel-h"><h2>會議資訊</h2></div><div class="kv">${kv.map(([k,v])=>`<div>${k}</div><div>${v}</div>`).join('')}</div></section>
      <section class="panel"><div class="panel-h"><h2>會議附件</h2><p>${m.files.length} 份</p></div><div class="files" id="files"></div></section>
      <div class="btn-row">${prev?'<button type="button" class="btn" id="pv">← 較新一場</button>':''}${next?'<button type="button" class="btn" id="nx">較舊一場 →</button>':''}</div>
      <div class="btn-row"><a class="btn" href="#/edit/${encodeURIComponent(m.id)}">編輯</a><button type="button" class="btn" id="prt">列印</button><button type="button" class="btn" id="delM">刪除</button></div>
    </aside></div>`);
  main.append(doc);
  if(prev)doc.querySelector('#pv').onclick=()=>openMeeting(prev.id);
  if(next)doc.querySelector('#nx').onclick=()=>openMeeting(next.id);
  doc.querySelector('#prt').onclick=()=>window.print();
  const fl=doc.querySelector('#files');
  if(!m.files.length)fl.innerHTML=`<div class="note">${m.att?'標示有附件，但尚未上傳電子檔。':'此會議沒有附件。'}</div>`;
  m.files.forEach(f=>{
    const ext=fileExt(f.name),canView=/^(pdf|img|txt)$/.test(ext);
    const row=el(`<div class="file"><span class="ic ${ext}">${ext==='img'?'IMG':esc((ext||'FILE').toUpperCase().slice(0,4))}</span><span style="min-width:0"><div class="fn" title="${esc(f.name)}">${esc(f.name)}</div><div class="fs">${fmtSize(f.size)}</div></span><span class="btn-row" style="flex-wrap:nowrap">${canView?'<button type="button" class="btn btn-xs" data-a="v">預覽</button>':''}<a class="btn btn-xs" ${f.path?`href="${fileUrl(f.path)}" target="_blank" rel="noopener"`:'href="#" data-a="o"'}>開啟</a></span></div>`);
    const v=row.querySelector('[data-a="v"]');if(v)v.onclick=()=>showFile(f);
    const o=row.querySelector('[data-a="o"]');if(o)o.onclick=e=>{e.preventDefault();showFile(f,false,true)};
    fl.append(row);
  });
  doc.querySelector('#delM').onclick=async()=>{
    if(!confirm(`確定刪除「${m.title}」？${m.pending?'':'會從系統資料夾移除這筆紀錄與附件，'}此動作無法復原。`))return;
    if(m.pending){
      PENDING=PENDING.filter(x=>x.id!==m.id);savePending();
      for(const f of m.files)if(f.key)await idb.del('files',f.key);
    }else{
      if(!await ensureFolder())return;
      try{
        OFFICIAL=OFFICIAL.filter(x=>x.id!==m.id);
        await fsx.write('data/meetings.js',new Blob([dataJs(OFFICIAL)],{type:'text/javascript'}));
        if(m.files.some(f=>f.path))await fsx.removeFolder(['會議紀錄',String(m.year),m.id]);
        window.MEETING_DATA=OFFICIAL.map(x=>({...x,files:x.files.map(f=>[f.path,f.size])}));
      }catch(e){toast('刪除失敗：'+e.message);return}
    }
    load();fillScope();toast('已刪除');go('#/list');
  };
}
async function showFile(f,quiet,download){
  let url;
  if(f.path)url=fileUrl(f.path);
  else{let blob;try{blob=await idb.get('files',f.key)}catch(e){}if(!blob){if(!quiet)toast('找不到檔案（可能已清除瀏覽器資料）');return}if(download){downloadBlob(blob,f.name);return}url=URL.createObjectURL(blob)}
  const ext=fileExt(f.name),v=$('#viewer');if(!v)return;
  v.innerHTML=`<div class="viewer">${ext==='img'?`<img src="${url}" alt="${esc(f.name)}">`:`<iframe src="${url}" title="${esc(f.name)}"></iframe>`}</div><p class="note" style="margin-top:6px">預覽：${esc(f.name)}</p>`;
  if(!quiet)v.scrollIntoView({behavior:'smooth'});
}

// ---------- 會議查詢 ----------
// 每個方格是一個條件，可任意組合（同時符合）；不受右上角年度／類別限制。
const SQ_EMPTY={kw:'',scope:'all',types:[],d1:'',d2:'',att:'',who:''};
let SQ={...SQ_EMPTY,types:[]};
function snippet(m,terms){
  if(!terms.length)return '';
  const lines=m.content.split('\n').map(l=>l.replace(/^#+\s*|^\s*[-*•]\s*/,'').trim()).filter(Boolean);
  const hit=lines.filter(l=>terms.some(t=>l.toLowerCase().includes(t.toLowerCase()))).slice(0,3);
  return hit.map(l=>'… '+hlText(l.length>90?l.slice(0,90)+'…':l,terms)).join('<br>');
}
function renderSearch(main){
  main.append(pageH('會議查詢',`${types().join('、')}一起查。每個方格是一個條件，都可以不填、也可任意組合；結果即時更新，不受右上角年度與類別限制。`,'<button type="button" class="btn" id="sqClr">清除全部條件</button>'));
  // 建議查詢：常用組合＋會議內容的主題（### 小標）＋常見關鍵字
  const m1=TODAY.getMonth()+1;
  const QUICK=[
    ['本月會議',{d1:ymd(CUR_Y,m1,1),d2:ymd(CUR_Y,m1,lastDay(CUR_Y,m1))}],
    ['近 30 天的待辦',{scope:'todo',d1:new Date(Date.now()-30*864e5-TODAY.getTimezoneOffset()*6e4).toISOString().slice(0,10)}],
    ...types().map(t=>[`${t}的待辦`,{types:[t],scope:'todo'}]),
    ['有附件的會議',{att:'y'}]
  ];
  const topics=[...new Set(MEETINGS.flatMap(m=>[...m.content.matchAll(/^###\s+(.+)$/gm)].map(x=>x[1].trim())))].slice(0,12);
  const words=['CSI','線上表單','定保','營收','人力','出納','褒獎','終檢','預約','改善','教育訓練','客訴','保固','零件'].filter(w=>MEETINGS.some(m=>m._hay.includes(w.toLowerCase()))&&!topics.some(t=>t.includes(w)));
  const pz=el(`<section class="panel presets"><div class="row"><span>常用查詢</span>${QUICK.map((q,i)=>`<button type="button" class="chip" data-q="${i}">${esc(q[0])}</button>`).join('')}</div>
    ${topics.length?`<div class="row"><span>會議主題</span>${topics.map(t=>`<button type="button" class="chip" data-k="${esc(t)}">${esc(t)}</button>`).join('')}</div>`:''}
    ${words.length?`<div class="row"><span>關鍵字</span>${words.map(t=>`<button type="button" class="chip" data-k="${esc(t)}">${esc(t)}</button>`).join('')}</div>`:''}</section>`);
  pz.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>{SQ={...SQ_EMPTY,types:[],...QUICK[+b.dataset.q][1]};route()});
  pz.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>{SQ={...SQ_EMPTY,types:[],kw:b.dataset.k};route()});
  main.append(pz);
  const g=el(`<div class="qgrid">
    <section class="qbox qwide"><h3><span class="qn">1</span>關鍵字</h3><input id="sqK" placeholder="多個關鍵字以空白分隔，需全部符合；例：CSI 線上表單" value="${esc(SQ.kw)}">
      <div class="qseg">${[['all','主題＋內容＋附件檔名'],['title','只找主題'],['todo','只找待辦事項']].map(([v,t])=>`<label><input type="radio" name="sqs" value="${v}" ${SQ.scope===v?'checked':''}>${t}</label>`).join('')}</div></section>
    <section class="qbox"><h3><span class="qn">2</span>會議類別</h3><div class="seg" id="sqT">${types().map(t=>`<label><input type="checkbox" value="${esc(t)}" ${SQ.types.includes(t)?'checked':''}>${esc(t)}</label>`).join('')}</div></section>
    <section class="qbox"><h3><span class="qn">3</span>日期範圍</h3><div class="qrow"><input type="date" id="sqD1" value="${SQ.d1}"><span>～</span><input type="date" id="sqD2" value="${SQ.d2}"></div></section>
    <section class="qbox"><h3><span class="qn">4</span>附件</h3><select id="sqA"><option value="">不限</option><option value="y" ${SQ.att==='y'?'selected':''}>有附件</option><option value="n" ${SQ.att==='n'?'selected':''}>無附件</option></select></section>
    <section class="qbox"><h3><span class="qn">5</span>出席者 <span class="note" style="font-weight:400">（選填）</span></h3><input id="sqW" placeholder="姓名，可部分輸入" value="${esc(SQ.who)}"></section>
  </div>`);
  main.append(g);
  const res=el('<section class="panel"><div class="panel-h"><h2 id="sqTitle">查詢結果</h2><p id="sqDesc"></p></div><div class="hits" id="sqBox"></div></section>');
  main.append(res);
  const draw=()=>{
    const kws=SQ.kw.trim().split(/\s+/).filter(Boolean);
    const d1=SQ.d1||'0000',d2=SQ.d2||'9999',who=SQ.who.trim();
    const txt=m=>SQ.scope==='title'?m.title.toLowerCase():SQ.scope==='todo'?m.todos.join('\n').toLowerCase():m._hay;
    const rows=MEETINGS.filter(m=>m.date>=d1&&m.date<=d2&&(!SQ.types.length||SQ.types.includes(m.type))
      &&(!SQ.att||(SQ.att==='y'?m.att:!m.att))&&(!who||m.who.includes(who))
      &&(SQ.scope!=='todo'||m.todos.length)&&kws.every(k=>txt(m).includes(k.toLowerCase())));
    const on=[SQ.kw.trim(),SQ.types.length,SQ.d1||SQ.d2,SQ.att,who];
    g.querySelectorAll('.qbox').forEach((c,i)=>c.classList.toggle('on',!!on[i]));
    const nOn=on.filter(Boolean).length;
    res.querySelector('#sqTitle').innerHTML=`查詢結果 <span class="num" style="color:var(--accent)">${rows.length}</span> 場`;
    res.querySelector('#sqDesc').textContent=nOn?`已套用 ${nOn} 個條件`:'尚未設定條件，顯示全部會議';
    const box=res.querySelector('#sqBox');box.innerHTML='';
    if(!rows.length){box.innerHTML='<div class="empty">沒有符合條件的會議</div>';return}
    rows.forEach(m=>{
      let sn='';
      if(SQ.scope==='todo')sn=m.todos.filter(t=>kws.every(k=>t.toLowerCase().includes(k.toLowerCase()))).map(t=>{const p=parseTodo(t,m.date);return `☐ ${p.dueTxt?`<b>${esc(p.dueTxt)}</b> `:''}${p.who?`<b>${hlText(p.who,kws)}</b>：`:''}${hlText(p.task,kws)}`}).join('<br>');
      else sn=snippet(m,kws);
      const b=el(`<button type="button" class="hit"><span class="h-t">${typePill(m.type)} ${hlText(m.title,kws)}</span><span class="h-m">${when(m)}${m.who?' · '+esc(m.who):''} · 待辦 ${m.todos.length} 項${m.files.length?' · 📎'+m.files.length:''}</span>${sn?`<span class="h-s">${sn}</span>`:''}</button>`);
      b.onclick=()=>go('#/m/'+encodeURIComponent(m.id)+(kws.length?'?hl='+encodeURIComponent(kws.join(' ')):''));
      box.append(b);
    });
  };
  const bind=(id,key,ev='change')=>g.querySelector(id).addEventListener(ev,e=>{SQ[key]=e.target.value;draw()});
  bind('#sqK','kw','input');bind('#sqD1','d1');bind('#sqD2','d2');bind('#sqA','att');bind('#sqW','who','input');
  g.querySelectorAll('input[name=sqs]').forEach(r=>r.onchange=()=>{SQ.scope=r.value;draw()});
  g.querySelectorAll('#sqT input').forEach(c=>c.onchange=()=>{SQ.types=[...g.querySelectorAll('#sqT input:checked')].map(x=>x.value);draw()});
  main.querySelector('#sqClr').onclick=()=>{SQ={...SQ_EMPTY,types:[]};route()};
  draw();
  setTimeout(()=>g.querySelector('#sqK').focus(),0);
}

// ---------- 新增／編輯會議紀錄 ----------
const TEMPLATE='## 待辦事項\n- \n## 決議事項\n- \n## 待釐清問題\n- \n## 會議摘要\n### 主題一\n- ';
function newId(date){
  const base='M'+date.replace(/-/g,'');let n=1;
  while(MEETINGS.some(m=>m.id===`${base}-${String(n).padStart(2,'0')}`))n++;
  return `${base}-${String(n).padStart(2,'0')}`;
}
function renderForm(main,params,editId){
  const m=editId?byId(editId):null;
  if(editId&&!m){main.append(el('<section class="panel empty">找不到這場會議。<br><a href="#/list">回會議總表</a></section>'));return}
  const isOther=m&&!BASE_TYPES.includes(m.type);
  main.append(pageH(m?'編輯會議紀錄':'新增會議紀錄',m?`編輯「${esc(m.title)}」`:'填寫日期時間、主題、內容與是否有附件；儲存後立即出現在會議總覽與查詢。'));
  const folder=el('<div class="banner"></div>');
  const drawFolder=async()=>{
    const ok=fsx.dir&&await fsx.ready(false);
    folder.className='banner'+(ok?' ok':'');
    folder.innerHTML=!fsx.supported?'<span>此瀏覽器不支援直接寫入資料夾：儲存後會先存在此瀏覽器，可再用「下載 meetings.js」更新系統資料。建議改用 Edge 或 Chrome。</span>'
      :ok?`<span>✅ 儲存位置：已連結系統資料夾 <b>${esc(fsx.name)}</b>，儲存後直接寫入 <code>data/meetings.js</code>，其他人重新整理即可看到。</span><button type="button" class="btn btn-xs" data-a="c">更換資料夾</button>`
      :`<span>📁 儲存位置：<b>${fsx.dir?'需要重新授權':'尚未連結系統資料夾'}</b>。${fsx.dir?'按右側按鈕允許寫入。':'請按右側按鈕選擇系統的 <code>app</code> 資料夾，之後儲存會直接寫入；未連結時先存在此瀏覽器。'}</span><button type="button" class="btn btn-pri btn-xs" data-a="c">${fsx.dir?'允許寫入':'連結系統資料夾'}</button>`;
    const c=folder.querySelector('[data-a="c"]');
    if(c)c.onclick=async()=>{try{if(fsx.dir&&c.textContent==='允許寫入')await fsx.ready(true);else await fsx.connect();await fsx.ready(true)}catch(e){if(e.name!=='AbortError')toast(e.message)}drawFolder()};
  };
  main.append(folder);drawFolder();
  const f=el(`<section class="panel"><form class="form" id="mf">
    <div class="wide"><div style="font-weight:600;margin-bottom:6px">會議類別</div><div class="seg" id="fType">
      ${BASE_TYPES.map(t=>`<label><input type="radio" name="type" value="${t}" ${(m?m.type===t:t===BASE_TYPES[0])?'checked':''}>${t}</label>`).join('')}
      <label><input type="radio" name="type" value="_other" ${isOther?'checked':''}>其他</label>
      <input name="typeOther" placeholder="請輸入會議名稱，例如：技術會議" value="${isOther?esc(m.type):''}" style="width:220px" ${isOther?'':'hidden'}>
    </div></div>
    <label>會議日期<input type="date" name="date" value="${m?m.date:TODAY_S}" required></label>
    <label><span>開始時間 <span class="hint">（選填）</span></span><input type="time" name="time" value="${m?esc(m.time):''}"></label>
    <label><span>結束時間 <span class="hint">（選填）</span></span><input type="time" name="end" value="${m?esc(m.end):''}"></label>
    <label><span>出席者 <span class="hint">（選填）</span></span><input name="who" value="${m?esc(m.who):''}" placeholder="例如：各廠長、服務部主管"></label>
    <label class="wide">會議主題<input name="title" required value="${m?esc(m.title):''}" placeholder="例如：11月廠長會議（標題開頭若是 20261112 會自動帶入日期）"></label>
    <label class="wide"><span>Notion 網址 <span class="hint">（選填，存成原始紀錄連結，會議內容頁可點開）</span></span><input name="src" type="url" value="${m?esc(m.src):''}" placeholder="https://app.notion.com/p/…"></label>
    <label class="wide"><span>會議內容 <span class="hint">可直接從 Notion 複製貼上，會自動轉成標題與項目格式；也可手動輸入：「## 」大標題、「### 」小標題、「- 」項目（前面空兩格為子項目）。「待辦事項」段落會顯示在總覽。</span></span>
      <textarea name="content" class="big" placeholder="${esc(TEMPLATE)}">${m?esc(m.content):''}</textarea></label>
    <div class="wide btn-row" style="margin-top:-6px"><button type="button" class="btn btn-xs" id="tpl">插入範本</button><button type="button" class="btn btn-xs" id="tidy">整理格式</button><button type="button" class="btn btn-xs" id="pvw">預覽</button><span class="note" id="pasteNote"></span></div>
    <div class="wide" id="pvBox" hidden><div class="doc-paper" style="padding:16px 20px"><div class="md" id="pvMd"></div></div></div>
    <div class="wide"><div style="font-weight:600;margin-bottom:6px">是否有附件</div><div class="seg">
      <label><input type="radio" name="att" value="y" ${m&&m.att?'checked':''}>有</label><label><input type="radio" name="att" value="n" ${!m||!m.att?'checked':''}>無</label></div></div>
    <div class="wide" id="attBox" ${m&&m.att?'':'hidden'}>
      ${m&&m.files.length?`<div class="note">目前附件（取消勾選即移除）：</div><div class="cur-files">${m.files.map((x,i)=>`<label><input type="checkbox" data-i="${i}" checked>${esc(x.name)} <span class="note">${fmtSize(x.size)}</span></label>`).join('')}</div>`:''}
      <div class="drop" id="drop" style="margin-top:8px">拖曳附件到這裡，或 <label style="display:inline;color:var(--accent);cursor:pointer;text-decoration:underline">選擇檔案<input type="file" id="mfFiles" multiple hidden></label><div id="dropList" class="note" style="margin-top:6px">也可以先不上傳，只標示「有附件」（例如紙本資料）。</div></div>
    </div>
    <div class="wide btn-row"><button class="btn btn-pri" type="submit">${m?'儲存修改':'儲存會議紀錄'}</button>${m?`<a class="btn" href="#/m/${encodeURIComponent(m.id)}">取消</a>`:'<button class="btn" type="reset">清除</button>'}</div>
  </form></section>`);
  main.append(f);
  const form=f.querySelector('#mf');
  const other=form.querySelector('[name=typeOther]');
  form.querySelectorAll('[name=type]').forEach(r=>r.onchange=()=>{other.hidden=form.type.value!=='_other';if(!other.hidden)other.focus()});
  form.querySelectorAll('[name=att]').forEach(r=>r.onchange=()=>{f.querySelector('#attBox').hidden=form.att.value!=='y'});
  f.querySelector('#tpl').onclick=()=>{const ta=form.content;ta.value=(ta.value.trim()?ta.value.replace(/\s*$/,'\n'):'')+TEMPLATE;ta.focus()};
  // 從 Notion（或 Word、網頁）貼上：讀剪貼簿的 HTML，轉成 ## / ### / - 格式
  const ta=form.content,pvBox=f.querySelector('#pvBox');
  const refreshPv=()=>{if(!pvBox.hidden)f.querySelector('#pvMd').innerHTML=renderMd(ta.value)||'<p class="note">（尚無內容）</p>'};
  ta.addEventListener('paste',e=>{
    const html=e.clipboardData&&e.clipboardData.getData('text/html');
    const text=e.clipboardData&&e.clipboardData.getData('text/plain');
    const out=html?htmlToMd(html):text?tidyText(text):'';
    if(!out)return;
    e.preventDefault();
    const s=ta.selectionStart,en=ta.selectionEnd;
    ta.value=ta.value.slice(0,s)+out+ta.value.slice(en);
    ta.selectionStart=ta.selectionEnd=s+out.length;
    f.querySelector('#pasteNote').textContent=html?'已轉換貼上的格式，可按「預覽」確認':'已整理貼上的文字';
    if(pvBox.hidden){pvBox.hidden=false;f.querySelector('#pvw').textContent='關閉預覽'}
    refreshPv();
  });
  ta.addEventListener('input',refreshPv);
  f.querySelector('#tidy').onclick=()=>{ta.value=tidyText(ta.value);refreshPv();toast('已整理格式')};
  f.querySelector('#pvw').onclick=e=>{pvBox.hidden=!pvBox.hidden;e.target.textContent=pvBox.hidden?'預覽':'關閉預覽';refreshPv()};
  // 主題開頭是 20261112 時自動帶入日期；含類別名稱時自動選類別
  form.title.addEventListener('change',()=>{
    const v=form.title.value,d=/^(20\d{2})(\d{2})(\d{2})/.exec(v);
    if(d&&!m)form.date.value=`${d[1]}-${d[2]}-${d[3]}`;
    const t=BASE_TYPES.find(x=>v.includes(x.replace('會議','')));
    if(t&&!m){const r=form.querySelector(`[name=type][value="${t}"]`);if(r){r.checked=true;other.hidden=true}}
  });
  let picked=[];
  const showPicked=()=>{f.querySelector('#dropList').textContent=picked.length?'待上傳：'+picked.map(x=>x.name).join('、'):'也可以先不上傳，只標示「有附件」（例如紙本資料）。'};
  f.querySelector('#mfFiles').onchange=e=>{picked=[...picked,...e.target.files];e.target.value='';showPicked()};
  const dz=f.querySelector('#drop');
  dz.ondragover=e=>{e.preventDefault();dz.classList.add('on')};dz.ondragleave=()=>dz.classList.remove('on');
  dz.ondrop=e=>{e.preventDefault();dz.classList.remove('on');picked=[...picked,...e.dataTransfer.files];showPicked()};
  form.onreset=()=>{picked=[];showPicked();setTimeout(()=>{other.hidden=true;f.querySelector('#attBox').hidden=true},0)};
  form.onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(form);
    let type=fd.get('type');if(type==='_other')type=String(fd.get('typeOther')||'').trim();
    if(!type){toast('請輸入會議類別名稱');other.focus();return}
    const date=fd.get('date');
    const id=m?m.id:newId(date);
    const att=fd.get('att')==='y';
    const keepIdx=new Set([...f.querySelectorAll('.cur-files input:checked')].map(x=>+x.dataset.i));
    const kept=m?m.files.filter((x,i)=>att&&keepIdx.has(i)):[];
    const removed=m?m.files.filter(x=>!kept.includes(x)):[];
    const rec={id,type,date,time:fd.get('time')||'',end:fd.get('end')||'',title:String(fd.get('title')).trim(),who:String(fd.get('who')||'').trim(),content:String(fd.get('content')||'').replace(/\s+$/,''),att,src:String(fd.get('src')||'').trim(),files:kept.slice()};
    const btn=form.querySelector('[type=submit]');btn.disabled=true;btn.textContent='儲存中…';
    try{
      const newFiles=att?picked:[];
      if(fsx.dir&&await fsx.ready(true)){
        // 寫入系統資料夾
        const year=date.slice(0,4);
        for(const x of newFiles){const path=`會議紀錄/${year}/${id}/${safeName(x.name)}`;await fsx.write(path,x);rec.files.push({name:x.name,path,size:x.size})}
        // 若是暫存紀錄，先把暫存附件寫出
        const n=norm(rec,false);
        if(m&&m.pending){const tmp=norm({...rec,files:rec.files},true);await writeMeetingFiles(tmp);n.files=tmp.files}
        const others=OFFICIAL.filter(x=>x.id!==id);
        await fsx.write('data/meetings.js',new Blob([dataJs([...others,n])],{type:'text/javascript'}));
        for(const x of removed)if(x.path&&!n.files.some(y=>y.path===x.path))await fsx.removeFile(x.path);
        OFFICIAL=[...others,n];
        window.MEETING_DATA=OFFICIAL.map(x=>({...x,files:x.files.map(y=>[y.path,y.size])}));
        if(m&&m.pending){PENDING=PENDING.filter(x=>x.id!==id);savePending()}
        load();fillScope();toast('已儲存並寫入系統資料夾');
      }else{
        // 先存在此瀏覽器
        for(const x of newFiles){const key=id+'/'+Date.now().toString(36)+'-'+x.name;await idb.put('files',key,x);rec.files.push({name:x.name,size:x.size,key})}
        for(const x of removed)if(x.key)await idb.del('files',x.key);
        PENDING=[...PENDING.filter(x=>x.id!==id),norm(rec,true)];
        if(!savePending())return;
        load();fillScope();toast('已儲存在此瀏覽器（尚未寫入系統資料夾）');
      }
      setYear(+date.slice(0,4));openMeeting(id);
    }catch(err){toast('儲存失敗：'+err.message)}
    finally{btn.disabled=false;btn.textContent=m?'儲存修改':'儲存會議紀錄'}
  };
}

// ---------- start ----------
fsx.restore().finally(()=>{
  load();
  initShell();
  if(!location.hash)location.hash='#/board';else route();
});
})();
