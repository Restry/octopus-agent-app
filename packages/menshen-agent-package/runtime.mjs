import { PersonalAgentRuntime as CoreRuntime } from '@personal-agent/core';
import { homedir } from 'node:os';
import path from 'node:path';

export class PersonalAgentRuntime extends CoreRuntime {
  constructor(directory = process.env.OCTOPUS_AGENT_DIR || path.join(homedir(), 'Library/Application Support/Octopus', 'sessions')) {
    super(directory, {title:text=>{try{return JSON.parse(text).intent || '新对话';}catch{return '新对话';}}});
  }
  async history(id, {before} = {}) {
    const manager = await this.manager(id);
    const branch = manager.getBranch();
    const end = before === undefined ? branch.length : branch.findIndex(e => e.id === before);
    if (end < 0 || (before !== undefined && typeof before !== 'string')) throw new Error('历史游标无效，请重新加载会话');
    const messages = [], activities = [];
    let start = end, hasMore = false;
    for (let i = end - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== 'message') continue;
      const m = entry.message;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const text = typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (!text && m.role === 'assistant') continue;
      if (messages.length === 50) { hasMore = true; break; }
      let display = text;
      if (m.role === 'user') {
        try { const p = JSON.parse(text); display = p.intent + (p.availableKeys?.length ? '\n' + p.availableKeys.map(k => `${k}（值已在本机拆分）`).join('\n') : ''); } catch {}
      }
      messages.unshift({id:entry.id,role:m.role,text:display});
      start = i;
    }
    let afterMessageId;
    const visibleIds = new Set(messages.map(message => message.id));
    for (let i = start; i < end; i++) {
      const entry = branch[i];
      if (visibleIds.has(entry.id)) afterMessageId = entry.id;
      if (entry.type === 'custom' && entry.customType === 'host-tool') {
        const e = entry.data;
        const title = e.tool || e.name || 'tool';
        activities.push({id:e.callId || entry.id,afterMessageId,state:e.status==='completed'?'completed':e.status==='cancelled'?'cancelled':'failed',label:title,steps:[{id:e.callId || entry.id,title,description:'',status:e.status,...(Object.hasOwn(e,'input') ? {input:e.input} : {}),...(Object.hasOwn(e,'output') ? {output:e.output} : {}),...(e.error ? {error:e.error} : {})}]});
      }
    }
    return {sessionId:id,messages,activities,nextCursor:hasMore ? messages[0].id : null,pendingPlan:this.pendingPlan(manager)};
  }
  pendingPlan(manager) {
    return [...manager.getBranch()].reverse().find(e=>e.type==='custom' && e.customType==='menshen-plan')?.data || null;
  }
}
