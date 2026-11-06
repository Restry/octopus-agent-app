import type {
  ChatPanelEvents,
  ChatPanelModel,
  ChatPanelSlots,
  ChatMessage,
  ChatActivity,
} from "./types";
import "./styles.css";
import { renderMarkdown } from "./markdown";

const paths: Record<string, string> = {
  back: '<path d="m14 5-7 7 7 7M7 12h15"/>',
  menu: '<path d="M4 5h16M4 12h16M4 19h16"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  new: '<path d="M13 5H5v15h15v-8M11 13l2-5 6-6 3 3-6 6-5 2Z"/>',
  expand:
    '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M13 12h5v5h-5z"/>',
  more: '<circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 3v18M3 12h18"/>',
  pin: '<path d="M18 9c0 5-6 11-6 11S6 14 6 9a6 6 0 1 1 12 0Z"/><circle cx="12" cy="9" r="2"/>',
  arrow: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor"/>',
  link: '<path d="M9 6H6a4 4 0 0 0 0 8h12m-4-4 4 4-4 4"/>',
};
function svg(name: string) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.link}</svg>`;
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(label: string, icon: string, action: () => void) {
  const el = node("button", "cp-icon");
  el.type = "button";
  el.title = label;
  el.setAttribute("aria-label", label);
  el.innerHTML = svg(icon);
  el.onclick = action;
  return el;
}

/** DOM-only view: callers supply safe display data and own all side effects. */
export class ChatPanel {
  readonly element = node("section", "chat-panel");
  readonly input = node("textarea", "cp-input");
  readonly auxiliary: HTMLElement;
  readonly composerSlot: HTMLElement;
  readonly modelPopover = node("div", "cp-model-popover");
  private title = node("span", "cp-title");
  private welcome = node("div", "cp-welcome", "你好，我是章鱼。点触角查看真实连接，或在这里开始对话。");
  private titleButton: HTMLButtonElement;
  private expand: HTMLButtonElement;
  private log = node("div", "cp-log");
  private context = node("div", "cp-context");
  private send: HTMLButtonElement;
  private sources = node("div", "cp-sources");
  private mode = node("button", "cp-mode");
  private status = node("span", "cp-status");
  private rows = new Map<
    string,
    { element: HTMLElement; text: HTMLElement; refs: HTMLElement }
  >();
  private timelines = new Map<
    string,
    {
      element: HTMLDivElement;
      label: HTMLElement;
      steps: HTMLElement;
      rows: Map<string, HTMLDetailsElement>;
    }
  >();
  private composing = false;
  private sourcesKey = "";
  private contextKey = "";
  private model!: ChatPanelModel;
  private markdownPending = new Map<HTMLElement, string>();
  private markdownTimer: number | undefined;
  private preservingAnchor = false;
  private scheduleMarkdown(target: HTMLElement, source: string) {
    this.markdownPending.set(target, source);
    if (this.markdownTimer !== undefined) return;
    this.markdownTimer = window.setTimeout(() => {
      this.markdownTimer = undefined;
      const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 100;
      for (const [element, text] of this.markdownPending) if (element.isConnected) renderMarkdown(element, text);
      if (atBottom) this.log.scrollTop = this.log.scrollHeight;
      this.markdownPending.clear();
    }, 60);
  }
  constructor(
    private events: ChatPanelEvents,
    slots: ChatPanelSlots = {},
  ) {
    this.element.setAttribute("aria-label", "聊天面板");
    const header = node("header", "cp-header");
    this.titleButton = node("button", "cp-brand");
    this.titleButton.type = "button";
    this.titleButton.setAttribute("aria-label", "助手设置");
    const logo = node("span", "cp-logo");
    logo.setAttribute("aria-hidden", "true");
    logo.innerHTML =
      '<svg viewBox="0 0 36 40"><path fill="#386bcc" d="m2 9 12-7v24L2 32Z"/><path fill="#8a58bd" d="m14 2 20 10v19l-12 7V16L14 12Z"/><path fill="#d2ab4e" d="m14 2 9 5v11l-9-6Z"/><path fill="#80a355" d="m2 25 12-7v12l8 8-10-3Z"/></svg>';
    this.titleButton.append(logo, this.title);
    this.titleButton.onclick = events.onTitle;
    this.expand = button("展开面板", "expand", events.onExpand);
    header.append(
      button("返回", "back", events.onBack),
      button("会话列表", "menu", events.onMenu),
      this.titleButton,
    );
    const actions = node("div", "cp-header-actions");
    actions.append(
      button("新对话", "new", events.onNew),
      this.expand,
      button("更多操作", "more", events.onMore),
      button("关闭助手", "close", events.onClose),
    );
    if (slots.header) actions.prepend(slots.header);
    header.append(actions);
    this.auxiliary = slots.auxiliary || node("div", "cp-auxiliary");
    this.auxiliary.classList.add("cp-auxiliary");
    this.auxiliary.hidden = true;
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");
    this.log.setAttribute("aria-relevant", "additions text");
    this.log.append(this.welcome);
    this.log.addEventListener("scroll", () => {
      if (!this.element.hidden && !this.preservingAnchor && this.log.scrollTop <= 1)
        this.events.onLoadOlder?.();
    }, { passive: true });
    const bottom = node("div", "cp-bottom");
    const form = node("form", "cp-form");
    this.composerSlot = slots.composer || node("div", "cp-composer-slot");
    this.composerSlot.classList.add("cp-composer-slot");
    const box = node("div", "cp-composer");
    this.input.rows = 3;
    this.input.maxLength = 65536;
    this.input.setAttribute("aria-label", "消息");
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.input.addEventListener("compositionend", () => {
      this.composing = false;
    });
    this.input.addEventListener("input", () => {
      events.onDraft?.(this.input.value);
      this.updateSend();
    });
    this.input.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        !this.composing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        if (!this.model.busy) form.requestSubmit();
      }
    });
    const toolbar = node("div", "cp-toolbar");
    const left = node("div", "cp-toolbar-left");
    left.append(
      button("添加上下文或粘贴文本", "plus", events.onAddContext),
      this.sources,
    );
    const right = node("div", "cp-toolbar-right");
    this.mode.type = "button";
    this.mode.setAttribute("aria-label", "选择模型");
    this.mode.setAttribute("aria-haspopup", "dialog");
    this.mode.setAttribute("aria-expanded", "false");
    this.mode.onclick = events.onModel;
    this.modelPopover.hidden = true;
    this.modelPopover.setAttribute("role", "dialog");
    this.modelPopover.setAttribute("aria-label", "选择模型");
    this.send = button("发送消息", "arrow", () => {});
    this.send.classList.add("cp-send");
    this.send.type = "submit";
    right.append(this.mode, this.send);
    toolbar.append(left, right);
    box.append(this.input, toolbar, this.modelPopover);
    this.status.setAttribute("role", "status");
    form.append(this.composerSlot, box, this.status);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (this.model.busy) events.onCancel();
      else if (this.input.value.trim()) events.onSubmit(this.input.value);
    };
    bottom.append(this.context, form);
    this.element.append(header, this.auxiliary, this.log, bottom);
  }
  setModelPickerOpen(open: boolean) {
    this.modelPopover.hidden = !open;
    this.mode.setAttribute("aria-expanded", String(open));
  }
  setDraft(value: string) {
    this.input.value = value;
    this.updateSend();
  }
  focus() {
    this.input.focus({ preventScroll: true });
  }
  scrollBottom() {
    this.log.scrollTop = this.log.scrollHeight;
  }
  preserveHistoryAnchor(render: () => void) {
    const anchor = [...this.rows.values()].map(row => row.element)
      .find(element => element.getBoundingClientRect().bottom > this.log.getBoundingClientRect().top);
    const top = anchor?.getBoundingClientRect().top;
    this.preservingAnchor = true;
    try {
      render();
      if (anchor && top !== undefined) this.log.scrollTop += anchor.getBoundingClientRect().top - top;
    } finally { this.preservingAnchor = false; }
  }
  private updateSend() {
    if (this.model)
      this.send.disabled = !!this.model.modelChanging || (!this.model.busy && !this.input.value.trim());
  }
  update(model: ChatPanelModel) {
    this.model = model;
    this.title.textContent = model.title;
    this.titleButton.title = "助手设置";
    this.titleButton.disabled = model.busy || !!model.modelChanging;
    this.mode.disabled = model.busy || !!model.modelChanging;
    this.welcome.hidden = !!model.messages.length;
    this.expand.setAttribute(
      "aria-label",
      model.expanded ? "收起面板" : "展开面板",
    );
    this.expand.setAttribute("aria-pressed", String(model.expanded));
    this.element.classList.toggle("cp-expanded", model.expanded);
    this.element.setAttribute("aria-busy", String(model.busy));
    this.input.disabled = model.busy || !!model.modelChanging;
    this.input.placeholder =
      model.placeholder || "描述你想了解或接下来要做的事";
    this.send.innerHTML = svg(model.busy ? "stop" : "arrow");
    this.send.setAttribute("aria-label", model.busy ? "停止回复" : "发送消息");
    this.send.title = model.busy ? "停止回复" : "发送消息";
    this.updateSend();
    this.status.textContent = model.status;
    this.status.hidden = !model.status;
    this.mode.textContent = model.modelLabel || "Auto";
    this.mode.title = model.modelLabel || "选择模型";
    const sourcesKey = JSON.stringify(model.sources);
    if (sourcesKey !== this.sourcesKey) {
      this.sourcesKey = sourcesKey;
      this.sources.replaceChildren();
      this.sources.title = model.sources.map((s) => s.label).join("、");
      this.sources.setAttribute(
        "aria-label",
        `可用工具：${this.sources.title}`,
      );
      for (const source of model.sources.slice(0, 4)) {
        const glyph = node("span", "cp-source", source.glyph);
        glyph.title = source.label;
        this.sources.append(glyph);
      }
      if (model.sources.length)
        this.sources.append(
          node("span", "cp-source-count", String(model.sources.length)),
        );
    }
    const contextKey = JSON.stringify(model.contexts);
    if (contextKey !== this.contextKey) {
      this.contextKey = contextKey;
      this.context.replaceChildren();
      this.context.hidden = !model.contexts.length;
      const label = node("span", "cp-context-label");
      label.innerHTML = svg("pin");
      label.append("Context:");
      this.context.append(label);
      const chips = node("div", "cp-context-chips");
      for (const item of model.contexts) {
        const chip = node("span", "cp-chip", item.label);
        chip.title = item.kind || item.label;
        chips.append(chip);
      }
      this.context.append(
        chips,
        button("移除上下文", "close", () => {
          for (const item of [...this.model.contexts])
            this.events.onRemoveContext(item.id);
        }),
      );
    }
    const atBottom =
      this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 70;
    const wanted = new Set(model.messages.map((m) => m.id));
    for (const [id, row] of this.rows)
      if (!wanted.has(id)) {
        row.element.remove();
        this.rows.delete(id);
      }
    const activities = new Set(model.activities.map((a) => a.id));
    for (const [id, row] of this.timelines)
      if (!activities.has(id)) {
        row.element.remove();
        this.timelines.delete(id);
      }
    let cursor: ChildNode | null = this.welcome.nextSibling;
    const place = (element: HTMLElement) => {
      if (element !== cursor) this.log.insertBefore(element, cursor);
      cursor = element.nextSibling;
    };
    for (const message of model.messages) {
      this.renderMessage(message);
      place(this.rows.get(message.id)!.element);
      for (const activity of model.activities.filter(
        (a) => (a.afterMessageId ?? a.id) === message.id,
      ))
        { this.renderActivity(activity); place(this.timelines.get(activity.id)!.element); }
    }
    for (const activity of model.activities.filter((a) => !wanted.has(a.afterMessageId ?? a.id)))
      { this.renderActivity(activity); place(this.timelines.get(activity.id)!.element); }
    if (atBottom && !this.preservingAnchor) this.log.scrollTop = this.log.scrollHeight;
  }
  private renderMessage(message: ChatMessage) {
    let row = this.rows.get(message.id);
    const existing = !!row;
    if (!row) {
      const element = node("article", `cp-message cp-${message.role}`);
      element.dataset.messageId = message.id;
      const text = node("div", "cp-message-text");
      const refs = node("div", "cp-references");
      element.append(text, refs);
      row = { element, text, refs };
      this.rows.set(message.id, row);
      this.log.append(element);
    }
    if (row.text.dataset.source !== message.text) {
      row.text.dataset.source = message.text;
      if (message.role === "assistant") {
        if (existing && this.model.busy) this.scheduleMarkdown(row.text, message.text);
        else renderMarkdown(row.text, message.text);
      }
      else row.text.textContent = message.text;
    }
    const refsKey = JSON.stringify(message.references || []);
    if (row.refs.dataset.key === refsKey) return;
    row.refs.dataset.key = refsKey;
    row.refs.replaceChildren();
    row.refs.hidden = !message.references?.length;
    if (message.references?.length) {
      const label = node("span", "cp-reference-label");
      label.innerHTML = svg("link");
      label.append("Referencing");
      row.refs.append(label);
      for (const ref of message.references) {
        const chip = node("span", "cp-chip", ref.label);
        if (this.events.onRemoveReference)
          chip.append(
            button("移除此引用", "close", () =>
              this.events.onRemoveReference?.(message.id, ref.id),
            ),
          );
        row.refs.append(chip);
      }
    }
  }
  private renderActivity(activity: ChatActivity) {
    let timeline = this.timelines.get(activity.id);
    if (!timeline) {
      const element = node("div", "cp-activity");
      const label = node("span", "cp-agent-state");
      const steps = node("div", "cp-steps");
      element.append(label, steps);
      timeline = { element, label, steps, rows: new Map() };
      this.timelines.set(activity.id, timeline);
    }
    timeline.label.hidden = activity.state !== "running" || activity.steps.length > 0;
    timeline.label.textContent = timeline.label.hidden ? "" : activity.label;
    for (const step of activity.steps) {
      let row = timeline.rows.get(step.id);
      if (!row) {
        row = node("details", "cp-step");
        const summary = node("summary", "cp-step-heading");
        summary.innerHTML = svg("down");
        summary.append(node("span", "cp-step-title"));
        row.append(summary, node("div", "cp-step-detail"));
        timeline.rows.set(step.id, row);
        timeline.steps.append(row);
      }
      row.setAttribute("aria-busy", String(step.status === "running"));
      row.dataset.status = step.status;
      const stepKey = JSON.stringify(step);
      if (row.dataset.key === stepKey) continue;
      row.dataset.key = stepKey;
      row.querySelector<HTMLElement>(".cp-step-title")!.textContent = step.title;
      const detail = row.querySelector<HTMLElement>(".cp-step-detail")!;
      detail.replaceChildren();
      for (const [label, value] of [["Input", step.input], ["Output", step.output]] as const) {
        if (value === undefined) continue;
        detail.append(node("div", "cp-tool-label", label), node("pre", "cp-tool-json", JSON.stringify(value, null, 2)));
      }
      if (step.error) detail.append(node("div", "cp-tool-error", `Error: ${step.error}`));
      if (step.input === undefined && step.output === undefined && (step.detail || step.description))
        detail.append(node("pre", "cp-tool-json", step.detail || step.description));
    }
  }
}
