import type { ChatPanelModel } from './components/chat-panel/types';

export type OctopusState = { kind: 'idle' | 'thinking' | 'responding' | 'tool' | 'error' | 'cancelled' | 'attention'; label: string; tool?: string };

// Only the latest turn is relevant; an old failed tool must not taint a new turn.
export function octopusState(model: ChatPanelModel, preparing = false): OctopusState {
  let start = model.activities.length - 1;
  while (start >= 0 && model.activities[start].steps.length !== 0) start--;
  const root = model.activities[start];
  if (model.busy) {
    for (let index = Math.max(0, start); index < model.activities.length; index++) {
      for (const step of model.activities[index].steps) {
        if (step.status === 'running') return { kind: 'tool', label: `执行工具 · ${step.title}`, tool: step.title };
      }
    }
    const prefix = root?.id.replace(/-user$/, '-text-');
    if (prefix && model.messages.some(message => message.role === 'assistant' && message.id.startsWith(prefix))) return { kind: 'responding', label: '正在回复' };
    return { kind: 'thinking', label: '正在思考' };
  }
  if (preparing) return { kind: 'thinking', label: '正在准备会话' };
  for (let index = Math.max(0, start); index < model.activities.length; index++) {
    if (model.activities[index].state === 'failed') return { kind: 'error', label: '本轮执行出错' };
  }
  if (root?.state === 'cancelled') return { kind: 'cancelled', label: '已停止' };
  if (model.status) return { kind: 'attention', label: '助手有提示' };
  return { kind: 'idle', label: '空闲 · 等你开口' };
}
