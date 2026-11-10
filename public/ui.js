// Small helpers shared by the admin and volunteer pages.
const h=(t,a={},...k)=>{const e=document.createElement(t);for(const[x,v]of Object.entries(a))x in e&&x!=='style'?e[x]=v:e.setAttribute(x,v);e.append(...k);return e};
const caretSvg=()=>{const t=document.createElement('template');t.innerHTML='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';return t.content.firstChild};
const closeMenus=()=>document.querySelectorAll('.menu').forEach(m=>m.hidden=true);
document.addEventListener('click',closeMenus);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenus()});
// "Download ▾": the main part runs the default action, the arrow opens the other choices.
function split(label,main,items,right,disabled){
  const mainB=h('button',{className:'ghost sm'+(items?' main':''),onclick:main,disabled:!!disabled},label);
  if(!items)return mainB;
  const menu=h('div',{className:'menu'+(right?' right':''),hidden:true,role:'menu'},...items.map(([l,f])=>h('button',{role:'menuitem',onclick:()=>{menu.hidden=true;f()}},l)));
  const caret=h('button',{className:'ghost sm caret','aria-haspopup':'menu','aria-label':'More download options',onclick:e=>{e.stopPropagation();const open=menu.hidden;closeMenus();menu.hidden=!open}},caretSvg());
  return h('div',{className:'split'},mainB,caret,menu);
}
// Zip a week's files in the browser. plan() resolves to {zipName, files:[{url,name}]}; say(text) shows progress.
async function zipDownload(plan,say){
  try{
    say('Preparing…');
    const r=await plan();
    if(!r.files.length){say('Nothing to download');return}
    const zip=new JSZip();let n=0;
    for(const f of r.files){say(`Preparing ${++n} of ${r.files.length}…`);const res=await fetch(f.url);if(!res.ok)throw new Error('could not fetch '+f.name);zip.file(f.name,await res.blob())}
    const blob=await zip.generateAsync({type:'blob',compression:'STORE'});
    const a=h('a',{href:URL.createObjectURL(blob),download:r.zipName});document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),60000);say('');
  }catch(e){say('Download failed: '+e.message)}
}
