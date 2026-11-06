import { api, native, streamAgent } from "./platform";
import "./agent.css";
import { mountPackages } from './packages';
import { mountMemory } from './memory';
import { ChatPanel } from "./components/chat-panel/ChatPanel";
import { purgeLegacyChatHistory } from "./chat-history";
import { mountOctopus } from './octopus';
import {createUpdater} from './updater';
import {installMcpServers,mountMcpSettings} from './mcp-settings';
import type {
  ChatPanelModel,
  ChatContext,
} from "./components/chat-panel/types";

type Reply = {
  text: string;
  events: { tool: string; key: string; ok: boolean; error?: string }[];
  error?: boolean;
  cancelled?: boolean;
};
type Config = { baseUrl: string; model: string; credentialRef: string };
// Split locally before rendering a user bubble or sending any model intent.
function splitMessage(raw: string, defaultProject: string, knownKeys: string[] = []) {
  if (raw.length > 65536) throw new Error("消息超过 64 KiB。");
  const start = raw.search(/(?:export\s+)?[A-Za-z0-9_./-]+\s*=|\{/);
  let text = raw.trim(),
    credentials = "",
    keys: string[] = [];
  if (start >= 0) {
    text = raw
      .slice(0, start)
      .trim()
      .replace(/[：:]$/, "")
      .trim();
    const body = raw.slice(start).trim();
    const pairs: [string, string][] = [];
    if (body.startsWith("{")) {
      let obj;
      try {
        obj = JSON.parse(body);
      } catch {
        throw new Error("请在同一输入框中使用 key=value 或 JSON 字符串对象。");
      }
      if (!obj || Array.isArray(obj) || typeof obj !== "object")
        throw new Error("JSON 必须是 key 到字符串值的对象。");
      pairs.push(...(Object.entries(obj) as [string, string][]));
    } else {
      const prose: string[] = [];
      for (const line of body.split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith("#")) continue;
        const match = line.match(
          /^\s*(?:export\s+)?([A-Za-z0-9_./-]+)\s*=\s*(.*)$/,
        );
        if (!match) {
          prose.push(line);
          continue;
        }
        let value = match[2];
        if (/^["']/.test(value)) {
          if (value.at(-1) !== value[0])
            throw new Error("多行凭据请使用 JSON 字符串。");
          value = value.slice(1, -1);
        }
        pairs.push([match[1], value]);
      }
      text = [text, ...prose].filter(Boolean).join("\n");
    }
    if (!pairs.length) throw new Error("未找到可保存的凭据。");
    const project =
      text.match(/(?:项目\s*|project\s+)([A-Za-z0-9_.-]+)/i)?.[1] ||
      defaultProject ||
      "default";
    const seen = new Set<string>();
    const resolved = pairs.map(([key, value]) => {
      key = key.includes("/") ? key : `${project}/${key}`;
      if (
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+$/.test(key) ||
        key.split("/").some((p) => !p || p === "." || p === "..") ||
        typeof value !== "string" ||
        !value ||
        value.includes("\0") ||
        seen.has(key)
      )
        throw new Error("凭据路径、值或重复项无效。");
      seen.add(key);
      return [key, value];
    });
    keys = [...seen];
    credentials = JSON.stringify(Object.fromEntries(resolved));
    text ||= "请新增这些凭据";
    defaultProject = project;
  }
  const allowed = new Set(knownKeys);
  const checked = text.replace(/[A-Za-z0-9+_\/-]{24,}/g, token => allowed.has(token) ? "[凭据路径]" : token);
  if (
    !text ||
    text.length > 2000 ||
    /[={}\u0000]|-----BEGIN|Bearer\s|https?:\/\/\S*[?@]|[A-Za-z0-9+_\/-]{24,}|(?:密码|密钥|secret|token|api[_ -]?key)\s*(?:是|为|[:：])\s*\S+/i.test(
      checked,
    )
  )
    throw new Error(
      "这条消息可能含凭据，无法安全拆分。请在这里使用 key=value 或 JSON 格式，再附上你的要求。",
    );
  return {
    intent: text,
    credentials,
    project: defaultProject,
    keys,
    display: [text, ...keys.map((key) => `${key}=[已隐藏]`)].join("\n"),
  };
}
async function prepareInstallation(raw: string, sessionId: string, project: string) {
  const start = raw.indexOf('{');
  if (start < 0 || raw.slice(0,start).trim() && !/(安装|添加|接入|install|add|connect)/i.test(raw.slice(0,start))) return null;
  let data: Record<string, any>;
  try { data = JSON.parse(raw.slice(start).replace(/\s*```\s*$/, '')); }
  catch { throw new Error('安装 JSON 无效；请提供完整配置或 slug、content。'); }
  if(!raw.slice(0,start).trim()&&!data.mcpServers)return null;
  let installation: Record<string, unknown>;
  if (data.mcpServers) {
    const intent=await installMcpServers(data.mcpServers,sessionId);
    return {intent,credentials:'',project,keys:[] as string[],display:intent,installRequestId:undefined,localOnly:true};
  } else if (data.slug && data.content) installation = {kind:'skill',slug:data.slug,content:data.content};
  else if (data.id && data.url) {
    const {id,...config} = data;
    installation = {kind:'mcp',id,config};
  } else if (data.kind === 'mcp' || data.kind === 'skill') installation = data;
  else throw new Error('安装需要 mcpServers 配置，或技能的 slug、content JSON。');
  const instruction = raw.slice(0,start).replace(/```(?:json)?\s*$/, '').trim();
  const prepared = await api<{requestId:string;intent:string}>('agent_prepare_install',{instruction,installation,sessionId});
  return {intent:prepared.intent,installRequestId:prepared.requestId,credentials:'',project,keys:[] as string[],display:prepared.intent};
}
export function mountAgent(refresh: () => Promise<void>, popover: boolean) {
  const launcher = document.createElement("button");
  launcher.className = "agent-launcher";
  launcher.id = "agent-launcher";
  launcher.type = "button";
  launcher.setAttribute("aria-label", "打开门神助手");
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "menshen-agent-panel");
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 16h8"/><circle cx="8" cy="12" r="1"/><circle cx="16" cy="12" r="1"/></svg>';
  const model: ChatPanelModel = {
    title: "章鱼",
    subtitle: "独立助手 · MCP",
    messages: [],
    activities: [],
    contexts: [],
    sources: [],
    busy: false,
    expanded: false,
    status: "",
    modeLabel: "Auto",
    modeDescription:
      "根据本轮要求自动选择可用工具；写入仍受授权和上下文范围限制。",
  };
  let id = "",
    epoch = 0,
    project = "",
    controller: AbortController | undefined;
  let configuration: Config | undefined;
  const catalogs = new Map<string, {models:string[];at:number}>();
  let preparing = false;
  let installingUpdate = false;
  const updater = createUpdater(() => model.busy || preparing || !!model.modelChanging, value => { installingUpdate = value; });
  const catalogRequests = new Map<string, Promise<{models:string[];current:string}>>();
  const catalogIdentity = (config: Config) => JSON.stringify([config.baseUrl, config.credentialRef]);
  let configRequest = 0;
  const loadConfiguration = async () => {
    const request = ++configRequest;
    try {
      const loaded = await api<Config>("agent_config");
      if (request !== configRequest) return;
      configuration = loaded;
      model.modelLabel = loaded.model;
      model.status = "";
      render();
      return loaded;
    } catch (error) {
      if (request === configRequest) {
        model.modelLabel = configuration?.model || "加载失败 · 重试";
        model.status = error instanceof Error ? error.message : "模型配置加载失败，点击模型重试。";
        render();
      }
      throw error;
    }
  };
  type SessionSummary = {id:string;title:string;updatedAt:number};
  type RunSnapshot = {id:string;state:"running"|"completed"|"failed"|"cancelled"|"interrupted";result?:Reply;error?:string};
  type HistoryPage = {messages:ChatPanelModel["messages"];activities:ChatPanelModel["activities"];nextCursor:string|null;run?:RunSnapshot};
  let sessions: SessionSummary[] = [];
  let activeId = "";
  let nextCursor: string | null = null;
  let olderRequest = 0;
  let loadingOlder = false;
  let recoveryTimer: number | undefined;
  const recoverSession = async (target: string, requestEpoch: number, preserveOlder = false) => {
    const saved = await api<HistoryPage>("agent_session_open",{sessionId:target});
    if (requestEpoch !== epoch) return;
    activeId = target;
    const first = model.messages.findIndex(m=>m.id===saved.messages[0]?.id);
    const older = preserveOlder && first > 0 ? model.messages.slice(0,first) : [];
    model.messages = [...older,...saved.messages];
    const ids = new Set(older.map(m=>m.id));
    model.activities = [...model.activities.filter(a=>a.afterMessageId && ids.has(a.afterMessageId)),...saved.activities];
    if (!older.length) nextCursor = saved.nextCursor;
    model.busy = saved.run?.state === "running";
    id = model.busy ? saved.run!.id : "";
    model.status = saved.run?.error || "";
    if (saved.run && !model.busy) {
      const reply = saved.run.result;
      if (reply?.text && (reply.error || reply.cancelled) && !model.messages.some(m=>m.text===reply.text))
        model.messages.push({id:`${saved.run.id}-result`,role:"assistant",text:reply.text});
      for (const activity of model.activities) {
        if (activity.state === "running") activity.state = saved.run.state === "cancelled" ? "cancelled" : "failed";
        for (const step of activity.steps) if (step.status === "running") step.status = activity.state;
      }
    }
    render();
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    if (model.busy) recoveryTimer = window.setTimeout(() => {
      void recoverSession(target,requestEpoch,true).catch(() => {
        if (requestEpoch !== epoch) return;
        model.status = "运行状态暂时无法读取，正在重连；请勿重复发送。";
        render();
        retryRecovery(target,requestEpoch);
      });
    },750);
  };
  const retryRecovery = (target: string, requestEpoch: number) => {
    recoveryTimer = window.setTimeout(() => {
      if (requestEpoch !== epoch) return;
      void recoverSession(target,requestEpoch,true).catch(() => retryRecovery(target,requestEpoch));
    },1000);
  };
  const activeKey = "menshen-personal-agent-active";
  const persist = () => {
    if (activeId) localStorage.setItem(activeKey, activeId);
  };
  const loadSessions = async () => {
    const data = await api<{sessions:{id:string;title:string;updatedAt:number}[]}>("agent_sessions");
    sessions = data.sessions;
  };
  const loadSession = async (target: string) => {
    detach();
    const requestEpoch=epoch;
    olderRequest++; loadingOlder=false;
    model.contexts=[];
    await recoverSession(target,requestEpoch);
    if (requestEpoch!==epoch) return;
    persist(); render(); view.scrollBottom();
  };
  const loadOlder = async () => {
    if (!activeId || !nextCursor || loadingOlder) return;
    const target=activeId, before=nextCursor, request=++olderRequest;
    loadingOlder=true;
    try {
      const saved=await api<HistoryPage>("agent_session_history",{sessionId:target,before});
      if (request!==olderRequest || target!==activeId) return;
      const messages=new Set(model.messages.map(m=>m.id));
      const activities=new Set(model.activities.map(a=>a.id));
      model.messages=[...saved.messages.filter(m=>!messages.has(m.id)),...model.messages];
      model.activities=[...saved.activities.filter(a=>!activities.has(a.id)),...model.activities];
      nextCursor=saved.nextCursor;
      view.preserveHistoryAnchor(() => render());
    } catch (error) {
      if (request===olderRequest) { model.status=error instanceof Error?error.message:"更早记录加载失败，请重新滚至顶部重试"; render(); }
    } finally { if (request===olderRequest) loadingOlder=false; }
  };
  const ensureSession = async () => {
    if (!activeId) activeId=(await api<{sessionId:string}>("agent_session_new")).sessionId;
    persist();
  };
  let section = "";
  const overwrite = document.createElement("label");
  overwrite.hidden = true;
  overwrite.innerHTML =
    '<input type="checkbox" id="agent-overwrite"> 确认本轮更新同名凭据';
  const cancelRun = () => {
    if (id) {
      controller?.abort();
      const cancelledEpoch = epoch;
      const cancelledId = id;
      void api("agent_cancel", { id }).catch(() => { if (epoch !== cancelledEpoch || id !== cancelledId) return; model.status = "停止请求未送达；连接已关闭，已完成操作请刷新确认。"; render(); });
    }
  };
  const render = () => {
    view.update(model);
    octopus.update(model, preparing);
    persist();
    updater.refresh();
  };
  const hideAux = () => {
    section = "";
    view.auxiliary.hidden = true;
    view.auxiliary.replaceChildren();
    view.setModelPickerOpen(false);
    view.modelPopover.replaceChildren();
  };
  const settle = () => {
    for (const activity of model.activities)
      if (activity.state === "running") {
        activity.state = "cancelled";
        activity.label = "已停止处理";
        for (const step of activity.steps)
          if (step.status === "running") {
            step.status = "cancelled";
            step.description = "已取消；已完成操作不会回滚";
          }
      }
  };
  const reset = () => {
    epoch++;
    cancelRun();
    settle();
    id = "";
    controller = undefined;
    preparing = false;
    activeId = "";
    nextCursor=null; olderRequest++; loadingOlder=false;
    model.messages = [];
    model.activities = [];
    model.contexts = [];
    model.busy = false;
    model.status = "";
    view.setDraft("");
    overwrite.hidden = true;
    (overwrite.firstElementChild as HTMLInputElement).checked = false;
    project = "";
    hideAux();
    render();
  };
  const detach = () => {
    epoch++;
    clearTimeout(recoveryTimer);
    controller?.abort();
    controller = undefined;
    id = "";
    preparing = false;
    view.setDraft("");
    overwrite.hidden = true;
    (overwrite.firstElementChild as HTMLInputElement).checked = false;
    persist();
  };
  const suspend = () => {
    epoch++;
    clearTimeout(recoveryTimer);
    cancelRun();
    settle();
    id = "";
    controller = undefined;
    preparing = false;
    model.busy = false;
    view.setDraft("");
    overwrite.hidden = true;
    (overwrite.firstElementChild as HTMLInputElement).checked = false;
    persist();
  };
  const close = () => {
    hideAux();
    render();
    view.element.hidden = true;
    launcher.hidden = false;
    launcher.setAttribute("aria-expanded", "false");
    octopus.setChatOpen(false);
    launcher.focus();
  };
  const open = () => {
    view.element.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    launcher.hidden = true;
    octopus.setChatOpen(true);
    view.focus();
    view.scrollBottom();
    void loadConfiguration().catch(() => {});
  };
  const aux = (name: string) => {
    if (section === name) {
      hideAux();
      return false;
    }
    section = name;
    view.setModelPickerOpen(false);
    view.auxiliary.replaceChildren();
    view.auxiliary.hidden = false;
    return true;
  };
  const action = (label: string, fn: () => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = fn;
    return button;
  };
  const settings = async () => {
    if (model.modelChanging || !aux("settings")) return;
    const form = document.createElement("form");
    form.id = "agent-config-form";
    form.innerHTML =
      '<p role="status">正在读取本机配置…</p><fieldset disabled><label>HTTPS 模型端点<input name="baseUrl" required autocomplete="off" placeholder="https://api.openai.com/v1"></label><label>模型（需支持 Responses API）<input name="model" required autocomplete="off"></label><label>本机密钥引用<input name="credentialRef" required autocomplete="off" placeholder="file/model-api-key"></label><p>密钥只在后端读取：本机 model-api-key 文件（权限 600），或 env/OPENAI_API_KEY 环境变量。不要在聊天中粘贴模型密钥。</p><label>默认项目<input name="project" placeholder="default" maxlength="100"></label><label class="agent-check"><input name="confirm" type="checkbox" required>确认向此端点发送对话和工具结果</label><button type="submit">保存本机配置</button></fieldset>';
    view.auxiliary.append(form);
    updater.mount(view.auxiliary);
    mountPackages(view.auxiliary);
    mountMemory(view.auxiliary);
    mountMcpSettings(view.auxiliary,async()=>{await ensureSession();return activeId;});
    const fieldset = form.querySelector("fieldset")!;
    const status = form.querySelector("p")!;
    const current = () => section === "settings" && view.auxiliary.contains(form);
    // Bind synchronously: an early Enter must never perform the browser's default form navigation.
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (fieldset.disabled || model.busy || model.modelChanging) return;
      const data = new FormData(form);
      fieldset.disabled = true;
      model.modelChanging = true;
      render();
      try {
        const saved = await api<Config>("agent_configure", {
          config: {baseUrl:data.get("baseUrl"),model:data.get("model"),credentialRef:data.get("credentialRef")},
          confirmEndpoint: data.get("confirm") === "on",
        });
        configuration = saved;
        model.modelLabel = saved.model;
        project = String(data.get("project") || "").trim();
        if (current()) hideAux();
        model.status = "模型配置已保存到本机。";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "配置保存失败，请重试。";
        fieldset.disabled = false;
      } finally { model.modelChanging = false; render(); }
    };
    const load = async () => {
      status.textContent = "正在读取本机配置…";
      try {
        const loaded = await loadConfiguration();
        if (!current() || !loaded) return;
        for (const name of ["baseUrl", "model", "credentialRef"] as const)
          (form.elements.namedItem(name) as HTMLInputElement).value = loaded[name];
        (form.elements.namedItem("project") as HTMLInputElement).value = project;
        fieldset.disabled = false;
        status.textContent = '配置已读取；模型密钥只由后端读取。';
      } catch {
        if (!current()) return;
        status.textContent = '请填写模型配置；密钥另存本机文件或环境变量。';
        (form.elements.namedItem('baseUrl') as HTMLInputElement).value = 'https://api.openai.com/v1';
        (form.elements.namedItem('model') as HTMLInputElement).value = 'gpt-4.1-mini';
        (form.elements.namedItem('credentialRef') as HTMLInputElement).value = 'file/model-api-key';
        fieldset.disabled = false;
      }
    };
    await load();
  };
  const chooseModel = async () => {
    if (model.busy || model.modelChanging) return;
    if (section === "models") { hideAux(); view.focus(); return; }
    hideAux();
    section = "models";
    view.setModelPickerOpen(true);
    const panel = document.createElement("div");
    panel.className = "agent-model-picker";
    view.modelPopover.append(panel);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索模型";
    search.setAttribute("aria-label", "搜索模型");
    const list = document.createElement("div");
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "端点可用模型");
    const refreshModels = action("刷新模型列表", () => { void load(true); });
    refreshModels.className = "agent-model-refresh";
    const heading = document.createElement("div");
    heading.className = "agent-model-heading";
    heading.append(status, refreshModels);
    panel.append(heading, search, list);
    let models: string[] = configuration ? catalogs.get(catalogIdentity(configuration))?.models || [] : [];
    const current = () => section === "models" && view.modelPopover.firstElementChild === panel;
    const draw = () => {
      list.replaceChildren();
      for (const name of models.filter(name => name.toLowerCase().includes(search.value.toLowerCase()))) {
        const option = action(name, () => { void select(name); });
        const check = document.createElement("span");
        check.textContent = configuration?.model === name ? "✓" : "";
        check.setAttribute("aria-hidden", "true");
        option.append(check);
        option.dataset.model = name;
        option.setAttribute("aria-pressed", String(configuration?.model === name));
        option.disabled = !!model.modelChanging;
        list.append(option);
      }
      if (!list.childElementCount) list.textContent = "没有匹配的模型。";
    };
    const select = async (name: string) => {
      if (!configuration || model.busy || model.modelChanging) return;
      model.modelChanging = true;
      status.textContent = `正在保存 ${name}…`;
      draw(); render();
      try {
        const saved = await api<Config>("agent_select_model", {model:name,expectedModel:configuration.model});
        const readback = await api<Config>("agent_config");
        if (saved.model !== name || readback.model !== name) throw new Error("模型读回不一致，请重新加载。");
        configuration = readback;
        model.modelLabel = readback.model;
        model.status = "";
        if (current()) hideAux();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "模型切换失败，当前模型未更改。";
      } finally {
        model.modelChanging = false;
        if (current()) draw();
        render();
        if (!section) view.focus();
      }
    };
    search.oninput = draw;
    const load = async (refresh = false) => {
      refreshModels.disabled = true;
      status.textContent = models.length ? `${models.length} 个可用模型` : "正在读取模型目录…";
      draw();
      try {
        const loaded = configuration || await loadConfiguration();
        if (!loaded) return;
        const identity = catalogIdentity(loaded);
        const cached = catalogs.get(identity);
        if (!refresh && cached && Date.now() - cached.at < 600000) {
          models = cached.models;
        } else {
          let request = catalogRequests.get(identity);
          if (!request) {
            request = api<{models:string[];current:string}>("agent_models",{refresh});
            catalogRequests.set(identity,request);
            request.finally(() => catalogRequests.delete(identity)).catch(() => {});
          }
          const catalog = await request;
          catalogs.set(identity,{models:catalog.models,at:Date.now()});
          if (configuration && catalogIdentity(configuration) === identity) models = catalog.models;
        }
        if (!current()) return;
        status.textContent = `${models.length} 个可用模型`;
        draw();
        search.focus();
      } catch (error) {
        if (!current()) return;
        status.textContent = error instanceof Error ? error.message : "模型目录加载失败，点击刷新重试。";
        if (models.length) draw();
        else list.textContent = "加载失败，可刷新重试。";
      } finally { refreshModels.disabled = false; }
    };
    draw();
    if (models.length) status.textContent = `${models.length} 个可用模型`;
    await load();
  };
  const chooseContext = () => {
    if (!aux("context")) return;
    const hint = document.createElement("p");
    hint.textContent =
      "选择当前控制台已选凭据/项目，仅附加名称；或直接在消息框粘贴 key=value，发送前在本机拆分。";
    view.auxiliary.append(hint);
    window.dispatchEvent(
      new CustomEvent("menshen:request-agent-context", {
        detail: {
          select: (context: ChatContext) => {
            view.auxiliary.append(
              action(`选择 ${context.label}`, () => {
                if (model.busy) {
                  model.status = "当前轮范围已固定；请停止后再选择。";
                  render();
                  return;
                }
                model.contexts = [context];
                hideAux();
                render();
                view.focus();
              }),
            );
          },
        },
      }),
    );
    view.auxiliary.append(
      action("在消息框粘贴文本", () => {
        hideAux();
        view.focus();
      }),
    );
  };
  const newChat = async () => {
    suspend();
    reset();
    try { await ensureSession(); await loadSessions(); render(); view.focus(); }
    catch (error) { model.status=error instanceof Error?error.message:"新建会话失败"; render(); }
  };
  const view = new ChatPanel(
    {
      onLoadOlder: () => { void loadOlder(); },
      onSubmit: (text) => {
        void submit(text);
      },
      onCancel: () => {
        cancelRun();
        model.status = "正在取消；已完成操作不会回滚。";
        render();
      },
      onDraft: (text) => {
        overwrite.hidden = !(
          /更新|覆盖|替换|update|replace|overwrite/i.test(text) &&
          /[={]/.test(text)
        );
      },
      onBack: () => {
        if (section) {
          hideAux();
          view.focus();
        } else close();
      },
      onMenu: () => { void (async () => {
        if (!aux("sessions")) return;
        await loadSessions();
        for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
          const row = document.createElement("div");
          row.className = "agent-history-row";
          const select = action(session.title, () => { void (async () => {
            detach();
            await loadSession(session.id);
            hideAux(); render(); view.focus();
          })().catch(error=>{model.status=String(error);render();}); });
          select.title = session.title;
          if (session.id === activeId) select.setAttribute("aria-current", "true");
          const time = document.createElement("time");
          time.dateTime = new Date(session.updatedAt).toISOString();
          time.textContent = new Date(session.updatedAt).toLocaleString("zh-CN", {month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false});
          time.title = new Date(session.updatedAt).toLocaleString("zh-CN");
          const remove = action("×", () => { void (async () => {
            if (!window.confirm(`删除“${session.title}”？`)) return;
            if (session.id === activeId) suspend();
            await api("agent_session_delete",{sessionId:session.id});
            if (session.id===activeId) { reset(); localStorage.removeItem(activeKey); }
            await loadSessions();
            hideAux(); render();
          })().catch(error=>{model.status=String(error);render();}); });
          remove.setAttribute("aria-label", `删除会话：${session.title}`);
          remove.title = "删除会话";
          row.append(select, time);
          if (session.id === activeId) {
            const current = document.createElement("small");
            current.textContent = "当前";
            row.append(current);
          }
          row.append(remove);
          view.auxiliary.append(row);
        }
      })().catch(error=>{model.status=String(error);render();}); },
      onTitle: () => {
        void settings();
      },
      onModel: () => { void chooseModel(); },
      onNew: newChat,
      onExpand: () => {
        model.expanded = !model.expanded;
        render();
      },
      onMore: () => {
        if (aux("more"))
          view.auxiliary.append(
            action("新建对话", newChat),
            action("高级设置", () => {
              void settings();
            }),
            action("添加 MCP", () => {
              void settings();
            }),
            action('软件更新', () => { if (aux('updates')) updater.mount(view.auxiliary); }),
            action("重新加载会话", () => { void (activeId ? loadSession(activeId) : loadSessions()).catch(error=>{model.status=String(error);render();}); }),
            action("清除全部会话", () => { void (async () => {
              if (!window.confirm("删除后端全部 Personal Agent 会话？")) return;
              suspend(); await loadSessions();
              for (const saved of sessions) await api("agent_session_delete",{sessionId:saved.id});
              sessions=[]; reset(); localStorage.removeItem(activeKey); render();
            })().catch(error=>{model.status=String(error);render();}); }),
          );
      },
      onClose: close,
      onAddContext: chooseContext,
      onRemoveContext: (key) => {
        model.contexts = model.contexts.filter((c) => c.id !== key);
        render();
      },
      onRemoveReference: (messageId, key) => {
        const msg = model.messages.find((m) => m.id === messageId);
        if (msg) msg.references = msg.references?.filter((c) => c.id !== key);
        model.contexts = model.contexts.filter((c) => c.id !== key);
        render();
      },
    },
    { composer: overwrite },
  );
  view.element.classList.add("agent-panel");
  view.element.id = "menshen-agent-panel";
  view.element.hidden = true;
  const octopus = mountOctopus(() => {
    if (popover) { void api('open_agent_console'); return; }
    open();
  });
  document.body.append(launcher, view.element);
  const mcpEntry=document.createElement('button');mcpEntry.type='button';mcpEntry.textContent='添加 MCP';mcpEntry.className='agent-mcp-entry';
  const mcpState=document.createElement('p');mcpState.setAttribute('role','status');
  mcpEntry.onclick=()=>{void settings();};
  const mcpBar=document.createElement('div');mcpBar.className='agent-mcp-bar';mcpBar.append(mcpState,mcpEntry);view.element.querySelector('.cp-bottom')!.prepend(mcpBar);
  const refreshMcpState=()=>{void api<{id:string;connected:boolean}[]>('connections').then(items=>{mcpState.textContent=items.length?items.map(c=>c.id+' · '+(c.connected?'已连接':'连接失败')).join('；'):'尚未添加 MCP';}).catch(()=>{mcpState.textContent='MCP 状态读取失败';});};
  window.addEventListener('octopus:connections-changed',refreshMcpState);refreshMcpState();
  const ready = (async () => {
    purgeLegacyChatHistory();
    await loadSessions();
    const previous=localStorage.getItem(activeKey);
    const target=sessions.find(s=>s.id===previous)?.id || sessions[0]?.id;
    if (target) await loadSession(target);
  })().catch(error=>{model.status=error instanceof Error?error.message:"会话加载失败";render();throw error;});
  void ready.catch(()=>{});
  render();
  launcher.onclick = () => {
    if (popover) {
      void api("open_agent_console");
      return;
    }
    if (view.element.hidden) open();
    else close();
  };
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || view.element.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!view.modelPopover.hidden || section) {
      hideAux();
      view.focus();
    } else close();
  }, true);
  async function submit(raw: string) {
    if (id || preparing || model.modelChanging || installingUpdate) return;
    preparing = true;
    render();
    let preparationEpoch = epoch;
    let parsed;
    try {
      await ready;
      preparationEpoch = epoch;
      if (id || model.busy) return;
      await ensureSession();
      const knownKeys = /[A-Za-z0-9+_\/-]{24,}/.test(raw) && !/[={}]/.test(raw) ? (await api<{keys:string[]}>("vault_metadata")).keys : [];
      parsed = await prepareInstallation(raw, activeId, project) || {...splitMessage(raw, project, knownKeys),installRequestId:undefined};
    } catch (error) {
      if (preparationEpoch !== epoch) return;
      view.setDraft("");
      model.status =
        error instanceof Error ? error.message : "无法安全拆分消息。";
      render();
      return;
    } finally { if (preparationEpoch === epoch) { preparing = false; render(); } }
    if (preparationEpoch !== epoch) return;
    if ('localOnly' in parsed && parsed.localOnly) {
      view.setDraft('');model.status=parsed.intent;render();return;
    }
    project = parsed.project;
    const runId = `chat-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join('-')}`, 
      current = ++epoch;
    id = runId;
    controller = new AbortController();
    const signal = controller.signal;
    model.busy = true;
    model.status = "";
    view.setDraft("");
    hideAux();
    const contexts = structuredClone(model.contexts);
    const messageId = `${runId}-user`;
    // Keep only split credentials in memory for the immediate request.
    raw = "";
    model.messages.push({
      id: messageId,
      role: "user",
      text: parsed.display,
      references: contexts,
    });
    const activity = {
      id: messageId,
      state: "running" as const,
      label: "门神正在处理…",
      steps: [],
    } as ChatPanelModel["activities"][number];
    model.activities.push(activity);
    render();
    persist();
    const args = {
      id: runId,
      sessionId: activeId,
      intent: parsed.intent,
      credentials: parsed.credentials,
      installRequestId: parsed.installRequestId,
      project,
      context: contexts.map((c) => ({ kind: c.kind, key: c.id })),
      allowUpdate: (overwrite.firstElementChild as HTMLInputElement).checked,
    };
    const finish = (state: "completed" | "failed" | "cancelled") => {
      activity.state = state;
      activity.label = {
        completed: "处理完成",
        failed: "处理失败",
        cancelled: "已停止处理",
      }[state];
      for (const item of model.activities.filter(a=>a.id.startsWith(`${runId}-tool-`))) {
        for (const step of item.steps) if (step.status === "running") {
          step.status = state === "completed" ? "failed" : state;
          step.error = state === "cancelled" ? "已取消；已完成操作不会回滚" : "连接已结束，未收到完成结果";
        }
        item.state = item.steps[0].status;
      }
    };
    try {
      if (current !== epoch) return;
      const request = streamAgent<Reply>(
        args,
        (event) => {
          if (current !== epoch) return;
          if (event.type === "text_delta" && event.delta) {
            const key = `${runId}-text-${event.messageId || 0}`;
            let message = model.messages.find((m) => m.id === key);
            if (!message) {
              message = { id: key, role: "assistant", text: "" };
              model.messages.push(message);
            }
            message.text += event.delta;
          }
          if (event.type === "tool" && event.callId) {
            const toolId = `${runId}-tool-${event.callId}`;
            let item = model.activities.find(a=>a.id === toolId);
            if (!item) {
              item = {id:toolId,afterMessageId:model.messages.at(-1)?.id || messageId,state:"running",label:"",steps:[{id:event.callId,title:event.tool || event.name || "tool",description:"",status:"running"}]};
              model.activities.push(item);
            }
            const step = item.steps[0];
            step.title = event.tool || event.name || "tool";
            step.status = event.status || "running";
            step.input = event.input;
            step.output = event.output;
            step.error = event.error;
            item.state = step.status;
          }
          render();
        },
        signal,
      );
      args.credentials = "";
      parsed.credentials = "";
      const reply = await request;
      if (current !== epoch) return;
      if (reply.text && (
        !model.messages.some((m) => m.id.startsWith(`${runId}-text-`)) ||
        reply.error ||
        reply.cancelled
      ))
        model.messages.push({
          id: `${runId}-result`,
          role: "assistant",
          text: reply.text,
        });
      for (const failed of reply.events.filter(e=>!e.ok)) {
        if (!model.activities.some(a=>a.id.startsWith(`${runId}-tool-`) && a.steps.some(s=>s.error === failed.error)))
          model.activities.push({id:`${runId}-tool-failed-${model.activities.length}`,afterMessageId:model.messages.at(-1)?.id || messageId,state:"failed",label:"",steps:[{id:`failed-${model.activities.length}`,title:failed.tool,description:"",status:"failed",error:failed.error}]});
      }
      finish(
        reply.cancelled ? "cancelled" : reply.error || reply.events.some(e=>!e.ok) ? "failed" : "completed",
      );
      model.status = "";
      model.busy = false;
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
      if (reply.events.some(e=>e.ok && ['install_mcp','install_skill'].includes(e.tool))) window.dispatchEvent(new Event('octopus:connections-changed'));
      await refresh();
    } catch {
      if (current === epoch) {
        // A broken subscription says nothing about whether the run has stopped.
        await recoverSession(activeId,current,true).catch(() => {
          model.status = "连接中断，正在恢复服务端运行状态；请勿重复发送。";
          retryRecovery(activeId,current);
        });
        await refresh().catch(() => {});
      }
    } finally {
      args.credentials = "";
      parsed.credentials = "";
      if (current === epoch) {
        if (!model.busy || !recoveryTimer) {
          id = "";
          model.busy = false;
        }
        controller = undefined;
        overwrite.hidden = true;
        (overwrite.firstElementChild as HTMLInputElement).checked = false;
        render();
        view.focus();
      }
    }
  }
  window.addEventListener("menshen:open-agent", open);
  window.addEventListener("pagehide", detach);
  window.addEventListener("beforeunload", detach);
  window.addEventListener("pageshow", event => { if (event.persisted && activeId) void loadSession(activeId); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) detach();
    else if (activeId) void loadSession(activeId);
  });
  const fitViewport = () => {
    const vp = window.visualViewport;
    document.documentElement.style.setProperty(
      "--keyboard-inset",
      `${vp ? Math.max(0, window.innerHeight - vp.height - vp.offsetTop) : 0}px`,
    );
    document.documentElement.style.setProperty(
      "--visual-height",
      `${vp?.height || window.innerHeight}px`,
    );
  };
  window.visualViewport?.addEventListener("resize", fitViewport);
  window.visualViewport?.addEventListener("scroll", fitViewport);
  fitViewport();
}
