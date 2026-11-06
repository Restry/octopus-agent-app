import {Type} from 'typebox';
import {MemoryError, validateMemoryContent} from '@personal-agent/core';

export const memoryReasons = ['MEMORY_SCOPE_DENIED','MEMORY_UNSAFE_CONTENT','MEMORY_TRANSIENT_CONTENT','MEMORY_INVALID_SOURCE','MEMORY_INVALID_STORAGE','MEMORY_READ_FAILED','MEMORY_WRITE_FAILED','MEMORY_BUSY','MEMORY_CAPACITY_EXCEEDED','MEMORY_INVALID_QUERY','MEMORY_NOT_FOUND','MEMORY_REVISION_CONFLICT','MEMORY_NOT_AUTHORIZED'];
export function memoryTools({provider, tool, intent, sessionId, privateStrings}) {
  const scope = Type.Union([Type.Literal('personal'),Type.Literal('project')]);
  const id = Type.String({pattern:'^[0-9a-f-]{36}$'});
  const expectedRevision = Type.Integer({minimum:1});
  const content = Type.String({minLength:1,maxLength:500});
  const source = {channel:'conversation',sessionId};
  const authorize = (operation, args) => {
    const verbs = {remember:/记住|记下来|保存.*(?:偏好|事实|记忆)|remember/i, update:/纠正|更正|修改.*记忆|更新.*记忆|correct.*memor|update.*memor/i, forget:/忘记|遗忘|删除.*记忆|forget|delete.*memor/i};
    if (!verbs[operation].test(intent) || /不要|别(?:再|去)?|不(?:要|用|必)|do not|don't/i.test(intent)) throw new MemoryError('MEMORY_NOT_AUTHORIZED');
    if (args.scope === 'personal' && operation !== 'forget' && !/个人偏好|跨项目|所有项目|共享|personal preference|across projects/i.test(intent)) throw new MemoryError('MEMORY_SCOPE_DENIED');
    if (args.content) {
      validateMemoryContent(args.content);
      if (privateStrings.some(value=>value && args.content.includes(value))) throw new MemoryError('MEMORY_UNSAFE_CONTENT');
    }
  };
  return [
    tool('memory_recall','检索当前项目事实或明确共享的个人偏好。scope 不接受其他项目。',{scope,query:Type.String({maxLength:2000})},args=>provider.recall({...args,limit:8})),
    tool('memory_remember','仅在当前用户明确要求记住时保存长期事实；个人偏好共享须明确请求。不得保存秘密或任务进度。',{scope,content},args=>{authorize('remember',args);return provider.remember({...args,source});}),
    tool('memory_update','纠正已有记忆，保留来源链；先召回获取 id 和 revision。',{scope,id,content,expectedRevision},args=>{authorize('update',args);return provider.update({...args,source});}),
    tool('memory_forget','用户明确要求遗忘时删除已有记忆；先召回获取 id 和 revision。',{scope,id,expectedRevision},async args=>{authorize('forget',args);const result=await provider.forget(args);if((await provider.recall({scope:args.scope,limit:200})).some(record=>record.id===args.id))throw new MemoryError('MEMORY_WRITE_FAILED');return result;}),
  ];
}
