export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ChatContext = { id: string; label: string; kind?: string };
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  references?: ChatContext[];
};
export type ChatStep = {
  id: string;
  title: string;
  description: string;
  status: "running" | "completed" | "failed" | "cancelled";
  detail?: string;
  input?: JsonValue;
  output?: JsonValue;
  error?: string;
};
export type ChatActivity = {
  id: string;
  afterMessageId?: string;
  state: "running" | "completed" | "failed" | "cancelled";
  label: string;
  steps: ChatStep[];
};
export type ChatPanelModel = {
  title: string;
  subtitle?: string;
  modelLabel?: string;
  modelChanging?: boolean;
  messages: ChatMessage[];
  activities: ChatActivity[];
  contexts: ChatContext[];
  sources: { label: string; glyph: string }[];
  busy: boolean;
  expanded: boolean;
  status: string;
  placeholder?: string;
  modeLabel?: string;
  modeDescription?: string;
};
export type ChatPanelEvents = {
  onSubmit(text: string): void;
  onCancel(): void;
  onDraft?(text: string): void;
  onLoadOlder?(): void;
  onBack(): void;
  onMenu(): void;
  onTitle(): void;
  onModel(): void;
  onNew(): void;
  onExpand(): void;
  onMore(): void;
  onClose(): void;
  onAddContext(): void;
  onRemoveContext(id: string): void;
  onRemoveReference?(messageId: string, id: string): void;
};
export type ChatPanelSlots = {
  header?: HTMLElement;
  auxiliary?: HTMLElement;
  composer?: HTMLElement;
};
