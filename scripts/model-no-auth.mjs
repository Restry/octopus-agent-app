import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {convertResponsesMessages, convertResponsesTools, getResponsesToolSupport, processResponsesStream} from '@earendil-works/pi-ai/api/openai-responses-shared';
import {resolveTranscript, resolveTranscriptTools} from '@earendil-works/pi-ai/utils/transcript';
import {Stream} from 'openai/core/streaming.mjs';

// Pi 1.4's client requires a nonempty credential. Reuse its Responses codec without
// constructing that authenticated client: no ambient credentials or dummy key.
export function streamWithoutAuth(model, context, options = {}) {
  const stream = new AssistantMessageEventStream();
  const output = {role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'pending',timestamp:Date.now()};
  void (async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(options.timeoutMs ?? 60000),...(options.signal ? [options.signal] : [])]);
    try {
      const transcript = resolveTranscript(context,false);
      const tools = resolveTranscriptTools(transcript.messages,getResponsesToolSupport({}));
      const params = {model:model.id,input:convertResponsesMessages(model,transcript,new Set(['openai','openai-codex','opencode'])),stream:true,store:false};
      if (tools.requestTools.length) params.tools = convertResponsesTools(tools.requestTools);
      if (options.maxTokens) params.max_output_tokens = Math.max(16,options.maxTokens);
      if (options.temperature !== undefined) params.temperature = options.temperature;
      if (options.toolChoice !== undefined) params.tool_choice = options.toolChoice;
      if (model.reasoning) {
        const effort = options.reasoning && options.reasoning !== 'off' ? options.reasoning : 'off';
        params.reasoning = {effort:model.thinkingLevelMap?.[effort] ?? (effort === 'off' ? 'none' : effort)};
        if (effort !== 'off') { params.reasoning.summary = 'auto'; params.include = ['reasoning.encrypted_content']; }
      }
      await options.onPayload?.(params,model);
      const response = await (options.fetch ?? fetch)(`${model.baseUrl.replace(/\/$/,'')}/responses`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify(params),signal,redirect:'error'});
      if (!response.ok) { await response.body?.cancel(); throw new Error('模型请求失败'); }
      stream.push({type:'start',partial:output});
      await processResponsesStream(Stream.fromSSEResponse(response,controller),output,stream,model,{onProviderStreamEvent:options.onProviderStreamEvent});
      if (signal.aborted || ['pending','error','aborted'].includes(output.stopReason)) throw new Error('模型响应未完成');
      stream.push({type:'done',reason:output.stopReason,message:output});
    } catch {
      for (const block of output.content) { delete block.index; delete block.partialJson; delete block.customInput; }
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = '模型请求失败（诊断已隐藏）';
      stream.push({type:'error',reason:output.stopReason,error:output});
    } finally { controller.abort(); stream.end(); }
  })();
  return stream;
}
