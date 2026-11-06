// Provider-owned text never leaves this module: values and field names use fixed allowlists.
const knownFields = ['type','error','response','code','message','param','status','status_code','incomplete_details','reason'];
const codes = new Set(['rate_limit_exceeded','insufficient_quota','invalid_api_key','invalid_request_error','invalid_value','unsupported_parameter','model_not_found','context_length_exceeded','server_error','content_filter','content_policy_violation']);
const types = new Set(['error','invalid_request_error','authentication_error','permission_error','not_found_error','rate_limit_error','server_error','api_error','insufficient_quota']);
const parameters = new Set(['model','tools','tools.parameters','reasoning','reasoning_effort','reasoning.effort','input','max_output_tokens','temperature']);
const statuses = new Set(['failed','incomplete','cancelled']);
const incompleteReasons = new Set(['max_output_tokens','content_filter']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = value => record(value) ? knownFields.filter(field => Object.hasOwn(value,field)) : [];

function messageCategory(message) {
  if (typeof message !== 'string') return undefined;
  if (/function tools.*reasoning_effort.*not supported/i.test(message)) return 'tools_reasoning_unsupported';
  if (/schema|parameters|additionalProperties|required/i.test(message)) return 'tool_schema';
  if (/reasoning|effort/i.test(message)) return 'reasoning_unsupported';
  if (/context|token.*limit|too.*long/i.test(message)) return 'token_limit';
  return 'unclassified';
}

// Accepts either a parsed SDK event or an SSE payload plus its event name.
export function safeProviderDiagnostic(event, eventName) {
  const envelope = record(event) ? event : {};
  const eventType = ['error','response.failed','response.incomplete'].includes(envelope.type) ? envelope.type : undefined;
  const namedType = ['error','response.failed','response.incomplete'].includes(eventName) ? eventName : undefined;
  if (!eventType && !namedType && !envelope.error) return undefined;
  const response = record(envelope.response) ? envelope.response : {};
  const error = record(envelope.error) ? envelope.error : record(response.error) ? response.error : envelope;
  const status = error.status ?? error.status_code ?? response.status;
  const incompleteReason = response.incomplete_details?.reason;
  const category = messageCategory(error.message);
  return {
    event: namedType || eventType || 'top_level_error',
    fields: fields(envelope),
    errorFields: fields(error),
    ...(record(envelope.response) ? {responseFields:fields(response)} : {}),
    ...(codes.has(error.code) ? {code:error.code} : {}),
    ...(types.has(error.type) ? {type:error.type} : {}),
    ...(parameters.has(error.param) ? {param:error.param} : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 || statuses.has(status) ? {status} : {}),
    ...(category ? {messageCategory:category} : {}),
    ...(incompleteReasons.has(incompleteReason) ? {incompleteReason} : {}),
  };
}

// One event is capped at 16 KiB of decoded text. Oversized events are skipped until the next blank line.
// Decode in 4 KiB slices so even a huge source chunk cannot allocate a huge diagnostic string.
function sseObserver(onDiagnostic) {
  const decoder = new TextDecoder();
  const limit = 16384;
  let line = '', data = '', eventName, size = 0, nonempty = false, skipLF = false, discarded = false, stopped = false;
  const reset = () => { line = ''; data = ''; eventName = undefined; size = 0; nonempty = false; discarded = false; };
  const dispatch = () => {
    if (!discarded && data) {
      const payload = data.slice(0,-1);
      if (payload === '[DONE]') stopped = true;
      else {
        try {
          const diagnostic = safeProviderDiagnostic(JSON.parse(payload),eventName);
          if (diagnostic) onDiagnostic(diagnostic);
        } catch { /* Leave malformed payload handling to the SDK; never expose raw data. */ }
      }
    }
    reset();
  };
  const finishLine = () => {
    if (!nonempty) { dispatch(); return; }
    if (!discarded) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0,colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = ['error','response.failed','response.incomplete'].includes(value) ? value : undefined;
      if (field === 'data') data += `${value}\n`;
    }
    line = ''; nonempty = false;
  };
  const append = piece => {
    if (!piece) return;
    nonempty = true;
    skipLF = false;
    size += piece.length;
    if (size > limit) { discarded = true; line = ''; data = ''; eventName = undefined; size = limit + 1; }
    else if (!discarded) line += piece;
  };
  const text = value => {
    let offset = 0;
    for (const match of value.matchAll(/[\r\n]/g)) {
      append(value.slice(offset,match.index));
      if (match[0] === '\n' && skipLF) skipLF = false;
      else { finishLine(); skipLF = match[0] === '\r'; }
      offset = match.index + 1;
      if (stopped) return;
    }
    append(value.slice(offset));
  };
  return {
    push(chunk) {
      for (let offset = 0; offset < chunk.byteLength && !stopped; offset += 4096) {
        text(decoder.decode(chunk.subarray(offset,offset + 4096),{stream:true}));
      }
    },
    end() {
      if (!stopped) { text(decoder.decode()); if (nonempty) finishLine(); dispatch(); }
      this.clear();
    },
    clear() { stopped = true; reset(); },
  };
}

// One pull-through reader, with no tee/clone or accumulated response body. Cancel reaches the source reader.
export function tapProviderResponse(response, onDiagnostic, {signal} = {}) {
  if (!response.ok || !response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) return response;
  const observer = sseObserver(onDiagnostic);
  const reader = response.body.getReader();
  let finished = false;
  let streamController;
  const detach = () => { signal?.removeEventListener('abort',abort); observer.clear(); };
  const cancel = async reason => {
    if (finished) return;
    finished = true;
    detach();
    try { await reader.cancel(reason); }
    finally { reader.releaseLock(); }
  };
  const abort = () => {
    if (finished) return;
    streamController.error(signal.reason);
    void cancel(signal.reason).catch(() => {});
  };
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      try {
        const {value,done} = await reader.read();
        if (finished) return;
        if (done) {
          observer.end(); finished = true; detach(); reader.releaseLock(); controller.close();
        } else {
          observer.push(value);
          controller.enqueue(value);
        }
      } catch (error) {
        if (finished) return;
        finished = true; detach(); reader.releaseLock(); controller.error(error);
      }
    },
    cancel,
  },{highWaterMark:0});
  const tapped = new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  for (const property of ['url','redirected','type']) Object.defineProperty(tapped,property,{value:response[property]});
  return tapped;
}
