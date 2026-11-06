import {api} from './platform';
type Memory = {id:string;scope:'personal'|'project';content:string;revision:number;sources:{channel:string;sessionId?:string;at:string}[]};
export function mountMemory(container:HTMLElement) {
 const panel=document.createElement('details');panel.className='agent-packages';panel.setAttribute('aria-label','长期记忆');
 const title=document.createElement('summary');title.textContent='长期记忆';
 const note=document.createElement('p');note.textContent='本机独立持久化；个人偏好跨项目共享，项目事实仅限门神。词法检索可能漏召回；不自动保存聊天、秘密或临时进度。修改和删除影响下一轮召回，不清除聊天历史。';
 const scope=document.createElement('select');scope.setAttribute('aria-label','记忆范围');
 for(const [value,label] of [['project','门神项目事实'],['personal','共享个人偏好']]) {const option=document.createElement('option');option.value=value;option.textContent=label;scope.append(option);}
 const refresh=document.createElement('button');refresh.type='button';refresh.textContent='刷新记忆';
 const status=document.createElement('p');status.setAttribute('role','status');
 const list=document.createElement('div');panel.append(title,note,scope,refresh,status,list);container.prepend(panel);
 let generation=0;
 const load=async()=>{
  const current=++generation;status.textContent='正在读取记忆…';list.replaceChildren();
  try {
   const data=await api<{memories:Memory[]}>('agent_memory_list',{scope:scope.value});if(current!==generation)return;
   status.textContent=`已读取 ${data.memories.length} 条记忆（最多显示 200 条）`;
   for(const memory of data.memories){
    const row=document.createElement('div');row.className='agent-package';
    const content=document.createElement('textarea');content.value=memory.content;content.maxLength=500;content.rows=2;content.setAttribute('aria-label','记忆内容');
    const source=document.createElement('small');source.textContent=`版本 ${memory.revision} · ${memory.sources.map(s=>`${s.channel==='manager'?'管理界面':'会话 '+s.sessionId} · ${s.at}`).join(' → ')}`;
    const save=document.createElement('button');save.type='button';save.textContent='保存纠正';
    const forget=document.createElement('button');forget.type='button';forget.textContent='删除记忆';
    const mutate=async(command:string)=>{
     save.disabled=true;forget.disabled=true;status.textContent='正在保存…';
     try {await api(command,{scope:memory.scope,id:memory.id,expectedRevision:memory.revision,...(command==='agent_memory_update'?{content:content.value}:{})});await load();status.textContent=command==='agent_memory_update'?'已纠正并读回':'已删除，读回列表中不再存在';}
     catch(error){status.textContent=error instanceof Error?error.message:'记忆操作失败';save.disabled=false;forget.disabled=false;}
    };
    save.onclick=()=>{void mutate('agent_memory_update');};forget.onclick=()=>{void mutate('agent_memory_forget');};
    row.append(content,source,save,forget);list.append(row);
   }
  } catch(error){if(current===generation)status.textContent=error instanceof Error?error.message:'记忆读取失败，请重试';}
 };
 scope.onchange=()=>{void load();};refresh.onclick=()=>{void load();};panel.ontoggle=()=>{if(panel.open)void load();};
}
