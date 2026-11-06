import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {VaultError} from './model-config.mjs';

const textLimit = 8192;
const projectionLimit = 256 * 1024;
const clipped = value => typeof value === 'string' && value.length > textLimit ? value.slice(0,textLimit)+'\n[运行快照已截断；完成后查看完整历史]' : value;
const detail = value => value === undefined || JSON.stringify(value).length <= textLimit ? value : '[工具详情过长；完成后查看完整历史]';
// One bounded projection per session, never a request/credential replay log.
export class AgentRuns {
  constructor(directory) { this.directory=directory; }
  file(sessionId) { return path.join(this.directory,`${sessionId}.run.json`); }
  async read(sessionId) {
    let run;
    try { run=JSON.parse(await readFile(this.file(sessionId),'utf8')); }
    catch(error) { if(error.code==='ENOENT')return null; throw error; }
    // The long-lived host verifies ownership; a status-request process owns no runs.
    return run;
  }
  async remove(sessionId) { await rm(this.file(sessionId),{force:true}); }
  start(sessionId,id,history) {
    const run={id,sessionId,state:'running',messages:history.messages.map(message=>({...message,text:clipped(message.text)})),activities:history.activities.slice(-100).map(activity=>({...activity,steps:activity.steps.map(step=>({...step,input:detail(step.input),output:detail(step.output)}))})),nextCursor:history.nextCursor};
    let pending, dirty=false;
    let timer;
    const bound=()=>{
      if(run.messages.length>50)run.messages.splice(0,run.messages.length-50);
      if(run.activities.length>100)run.activities.splice(0,run.activities.length-100);
      while(Buffer.byteLength(JSON.stringify(run))>projectionLimit && (run.messages.length>1 || run.activities.length || run.result?.events.length)) {
        if(run.activities.length)run.activities.shift();
        else if(run.messages.length>1)run.messages.shift();
        else run.result.events.shift();
      }
    };
    const save=()=>{
      bound();
      dirty=true;
      if(!pending)pending=(async()=>{
        while(dirty) {
          dirty=false;
          const content=JSON.stringify(run);
          const temporary=`${this.file(sessionId)}.${randomUUID()}.pending`;
          try {
            await writeFile(temporary,content,{mode:0o600,flag:'wx'});
            await rename(temporary,this.file(sessionId));
          } finally { await rm(temporary,{force:true}); }
        }
      })().finally(()=>{pending=undefined;});
      // Observe failures immediately; flush still propagates them to the owner.
      void pending.catch(()=>{});
      return pending;
    };
    const messageId=`${id}-user`;
    return {
      run, save,
      validated(intent,keys) {
        run.messages.push({id:messageId,role:'user',text:clipped(intent+(keys.length?'\n'+keys.map(key=>`${key}（值已在本机拆分）`).join('\n'):''))});
        save();
      },
      event(event) {
        if(event.type==='text_delta') {
          const key=`${id}-text-${event.messageId || 0}`;
          let message=run.messages.find(m=>m.id===key);
          if(!message)run.messages.push(message={id:key,role:'assistant',text:''});
          message.text=clipped(message.text+event.delta);
        }
        if(event.type==='tool'&&event.callId) {
          const key=`${id}-tool-${event.callId.slice(0,200)}`;
          let activity=run.activities.find(a=>a.id===key);
          if(!activity)run.activities.push(activity={id:key,afterMessageId:run.messages.at(-1)?.id || messageId,state:'running',label:'',steps:[]});
          activity.state=event.status;
          activity.steps=[{id:event.callId.slice(0,200),title:clipped(event.tool || event.name),description:'',status:event.status,input:detail(event.input),output:detail(event.output),error:clipped(event.error)}];
        }
        bound();
        if (!timer) timer=setTimeout(()=>{timer=undefined;save();},50);
      },
      async finish(reply,error) {
        clearTimeout(timer);
        run.state=error?'failed':reply.cancelled?'cancelled':reply.error || reply.events.some(event=>!event.ok)?'failed':'completed';
        if(reply)run.result={text:clipped(reply.text),events:reply.events.slice(-100).map(event=>({tool:clipped(event.tool),key:clipped(event.key),ok:event.ok,error:clipped(event.error)})),...(reply.error?{error:true}:{}),...(reply.cancelled?{cancelled:true}:{})};
        if(error)run.error=error instanceof VaultError ? error.message : '执行失败，请检查配置及已完成操作。';
        await save();
      },
    };
  }
}
