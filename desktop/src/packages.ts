import {api} from './platform';
type Binding = {id:string;version:string};
type Installed = Binding & {enabled:boolean;compatible:boolean;error?:string;tools:string[];skills:{path:string;requiresTools:string[]}[]};
export type Catalog = {packages:Binding[];installed:Installed[];effect:'new_sessions'};
export function mountPackages(container:HTMLElement) {
 const panel=document.createElement('section');panel.className='agent-packages';panel.setAttribute('aria-label','能力包');
 const heading=document.createElement('strong');heading.textContent='能力包';
 const note=document.createElement('p');note.textContent='仅管理本机已安装包。更改仅对新建会话生效；进行中及已有会话保持原版本和技能快照。';
 const status=document.createElement('p');status.setAttribute('role','status');
 const list=document.createElement('div');panel.append(heading,note,status,list);container.prepend(panel);
 let catalog:Catalog;
 const draw=()=>{
  list.replaceChildren();
  const ids=[...new Set(catalog.installed.map(p=>p.id))];
  if(!ids.length){list.textContent='没有已安装的能力包';return;}
  for(const id of ids){
   const versions=catalog.installed.filter(p=>p.id===id), selected=catalog.packages.find(p=>p.id===id);
   const row=document.createElement('div');row.className='agent-package';
   const label=document.createElement('label');label.className='agent-check';
   const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=!!selected;enabled.setAttribute('aria-label',`启用 ${id}`);
   const title=document.createElement('span');title.textContent=`${id} · ${selected?'已启用':'已停用'}`;label.append(enabled,title);
   const version=document.createElement('select');version.setAttribute('aria-label',`${id} 版本`);
   for(const pkg of versions){const option=document.createElement('option');option.value=pkg.version;option.textContent=`${pkg.version}${pkg.compatible?'':`（不可用：${pkg.error}）`}`;option.disabled=!pkg.compatible;version.append(option);}
   version.value=selected?.version||versions.find(p=>p.compatible)?.version||versions[0].version;
   enabled.disabled=!selected&&!versions.some(p=>p.compatible);
   const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('p');
   const describe=()=>{const pkg=versions.find(p=>p.version===version.value)!;summary.textContent=`${pkg.tools.length} 个工具 · ${pkg.skills.length} 项技能`;body.textContent=`工具：${pkg.tools.join('、')||'无'}\n技能：${pkg.skills.map(s=>s.path).join('、')||'无'}${pkg.error?`\n校验：${pkg.error}`:''}`;};describe();details.append(summary,body);
   const hint=document.createElement('small');const compatibleCount=versions.filter(p=>p.compatible).length;hint.textContent=compatibleCount===0?'无兼容的已安装版本':compatibleCount===1?'无可回退版本（仅一个兼容的已安装版本）':'选择其他已安装兼容版本即可切换或回退';
   const save=async()=>{
    const packages=catalog.packages.filter(p=>p.id!==id);if(enabled.checked)packages.push({id,version:version.value});
    for(const control of list.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select'))control.disabled=true;
    status.textContent='正在校验并保存…';
    try {catalog=await api<Catalog>('agent_packages_update',{packages});window.dispatchEvent(new CustomEvent<Catalog>('menshen:packages-changed',{detail:catalog}));status.textContent='已保存并读回。新建会话生效；已有会话保持固定。';}
    catch(error){status.textContent=error instanceof Error?error.message:'保存失败';}
    draw();
   };
   enabled.onchange=()=>{void save();};version.onchange=()=>{describe();if(enabled.checked)void save();};
   row.append(label,version,hint,details);list.append(row);
  }
 };
 const load=async()=>{status.textContent='正在读取已安装能力包…';try{catalog=await api<Catalog>('agent_packages');draw();status.textContent='已读取实例配置';}catch(error){status.textContent=error instanceof Error?error.message:'能力包读取失败';const retry=document.createElement('button');retry.type='button';retry.textContent='重试';retry.onclick=()=>{void load();};list.replaceChildren(retry);}};
 void load();
}
