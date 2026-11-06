import type { JsonValue } from './components/chat-panel/types';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';

export const native = isTauri();
let pending: {key: string; value: string} | null = null;
let pendingTimer: number | undefined;
let copyEpoch = 0;
export function clearPendingCopy() {
  copyEpoch++;
  if (pending) pending.value = '';
  pending = null;
  clearTimeout(pendingTimer);
}
export async function api<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (native) {
    try { return await invoke<T>('agent_request',{command,args,onEvent:new Channel<AgentStreamEvent>()}); }
    catch (error) { throw error instanceof Error ? error : new Error(typeof error === 'string' ? error : '本地服务请求失败'); }
  }
  const response = await fetch(`/api/${command}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args),cache:'no-store',credentials:'same-origin',redirect:'error'});
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '本地服务请求失败');
  return data.result as T;
}
export type AgentStreamEvent = {
  id: string;
  type: 'text_delta' | 'tool' | 'done' | 'error';
  messageId?: number;
  delta?: string;
  callId?: string;
  tool?: string;
  name?: string;
  key?: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
  summary?: string;
  durationMs?: number;
  input?: JsonValue;
  output?: JsonValue;
  result?: unknown;
  error?: string;
};
export async function streamAgent<T>(args: Record<string, unknown>, onEvent: (event: AgentStreamEvent) => void, signal: AbortSignal): Promise<T> {
  let done = false, result: T | undefined;
  const receive = (event: AgentStreamEvent) => {
    if (event.id !== args.id || signal.aborted) return;
    if (event.type === 'error') throw new Error(event.error || '流式请求失败');
    if (event.type === 'done') { done = true; result = event.result as T; }
    else onEvent(event);
  };
  if (native) {
    const channel = new Channel<AgentStreamEvent>();
    channel.onmessage = event => { if (event.type !== 'error') receive(event); };
    signal.throwIfAborted();
    const reply = await invoke<T>('agent_request',{command:'agent_run',args,onEvent:channel});
    signal.throwIfAborted();
    return reply;
  }
  const response = await fetch('/api/agent_run',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'},body:JSON.stringify(args),cache:'no-store',credentials:'same-origin',redirect:'error',signal});
  if (!response.ok || !response.body) throw new Error('流式请求失败');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const part = await reader.read();
      pending += decoder.decode(part.value,{stream:!part.done});
      let boundary;
      while ((boundary = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0,boundary); pending = pending.slice(boundary+1);
        if (line) receive(JSON.parse(line));
      }
      if (part.done) break;
    }
    if (!done || pending.trim()) throw new Error('回复连接已中断，请刷新确认已完成操作');
    return result as T;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function copySecret(key: string): Promise<boolean> {
  if (native) { await api('vault_copy',{key}); return true; }
  // This branch executes synchronously in the second click, before any await.
  if (pending?.key === key) {
    const area = document.createElement('textarea');
    area.value = pending.value;
    area.readOnly = true;
    area.setAttribute('aria-label','临时剪贴板内容');
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
    const focused = document.activeElement as HTMLElement | null;
    document.body.append(area);
    area.focus();
    area.select();
    area.setSelectionRange(0,area.value.length);
    let copied = false;
    try { copied = document.execCommand('copy'); }
    finally { area.value = ''; area.remove(); clearPendingCopy(); focused?.focus(); }
    if (!copied) throw new Error('浏览器禁止复制，请使用本机 http://127.0.0.1:3812 重试');
    return true;
  }
  clearPendingCopy();
  const epoch = copyEpoch;
  let value = await api<string>('vault_reveal',{key});
  if (epoch !== copyEpoch || document.hidden || !document.hasFocus()) { value = ''; throw new Error('页面已切换或失去焦点，请重新复制'); }
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(value); value = ''; return true; }
    catch { /* Permission denial also uses the explicit second gesture. */ }
  }
  if (epoch !== copyEpoch) { value = ''; throw new Error('页面已切换，请重新复制'); }
  pending = {key,value};
  value = '';
  pendingTimer = setTimeout(clearPendingCopy,15000);
  return false;
}
