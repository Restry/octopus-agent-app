import { api } from './platform';
import type { Catalog } from './packages';
import type { ChatPanelModel } from './components/chat-panel/types';
import { octopusState } from './octopus-state';
import './octopus.css';

export function mountOctopus(openAssistant: () => void) {
  const root = document.createElement('aside');
  root.className = 'octopus-widget';
  root.setAttribute('aria-label', '章鱼 Agent 状态');
  root.innerHTML = `
    <div class="octopus-card">
      <div class="octopus-heading"><span>AGENT / 章鱼</span><span class="octopus-live">本机会话</span></div>
      <div class="octopus-body"><div class="octopus-anatomy">
      <svg class="octopus-creature" viewBox="0 0 280 174" aria-hidden="true">
        <defs>
          <linearGradient id="octopus-skin" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#83b8a6"/><stop offset="1" stop-color="#387e73"/></linearGradient>
          <linearGradient id="octopus-arm" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#559583"/><stop offset="1" stop-color="#81b0a0"/></linearGradient>
        </defs>
        <g class="octopus-decor" fill="none" stroke-linecap="round">
          <path d="M179 83 C205 88 223 97 227 81 C229 72 220 72 219 78"/>
          <path d="M173 87 C190 110 205 126 218 115 C226 107 216 101 213 108"/>
          <path d="M156 88 C161 107 181 132 189 122"/>
          <path d="M141 85 C126 99 120 115 132 119 C141 122 145 113 141 109"/>
          <path d="M127 79 C105 85 98 100 109 106"/>
        </g>
        <g class="octopus-connection-arms" fill="none" stroke-linecap="round"></g>
        <g class="octopus-brain">
          <path d="M122 79 C112 63 115 35 135 25 C156 12 182 26 188 46 C193 61 186 81 176 90 C163 102 132 95 122 79Z" fill="url(#octopus-skin)" stroke="#3d7869" stroke-width="1.5"/>
          <path d="M127 51 C125 37 138 28 150 29" fill="none" stroke="#c5ded0" stroke-width="4" stroke-linecap="round" opacity=".55"/>
          <g class="octopus-eyes"><ellipse cx="139" cy="64" rx="7" ry="9" fill="#e9f0e6"/><ellipse cx="168" cy="64" rx="7" ry="9" fill="#e9f0e6"/><ellipse cx="141" cy="65" rx="3" ry="4.5" fill="#244c43"/><ellipse cx="166" cy="65" rx="3" ry="4.5" fill="#244c43"/><circle cx="142" cy="63" r="1" fill="white"/><circle cx="167" cy="63" r="1" fill="white"/></g>
          <path d="M148 79 Q153 83 159 78" stroke="#285b4e" stroke-width="2" fill="none" stroke-linecap="round"/>
          <ellipse cx="129" cy="77" rx="5" ry="2.5" fill="#bdc7b4" opacity=".5"/><ellipse cx="178" cy="77" rx="5" ry="2.5" fill="#bdc7b4" opacity=".5"/>
        </g>
      </svg>
      <button class="octopus-head-hit" type="button" aria-label="章鱼大脑：打开助手" aria-controls="menshen-agent-panel"></button>
      <div class="octopus-connections"></div>
      </div></div>
      <div class="octopus-status" role="status" aria-live="polite"></div>
      <div class="octopus-metrics"><span class="octopus-connection-count">读取连接…</span><span class="octopus-counts"></span></div>
      <button class="octopus-resize" type="button" role="slider" aria-label="调整章鱼大小" aria-description="拖动调整大小；方向右、上或加号放大，方向左、下或减号缩小，Shift 加速。" aria-orientation="horizontal" title="拖动缩放 · 方向键或 + / −"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M10 15l5-5"/></svg></button>
    </div>
    <section id="octopus-capabilities" class="octopus-capabilities" aria-label="连接工具与技能" hidden>
      <header><strong>连接能力</strong><button type="button" class="octopus-dismiss" aria-label="收起工具和技能">×</button></header>
      <p>握手与工具发现不代表业务健康。启停、工具和技能更新仅对新会话生效；已有会话保持原快照。</p>
      <div class="octopus-package-list"></div>
      <button type="button" class="octopus-refresh">刷新连接与能力目录</button>
      <small>淡色短角仅为装饰；带连接名称的长触角可点击。</small>
    </section>`;
  const head = root.querySelector<HTMLButtonElement>('.octopus-head-hit')!;
  type Connection = { id: string; connected: boolean; enabled: boolean; tools: number; names: string[] };
  const connections = root.querySelector<HTMLElement>('.octopus-connections')!;
  const creature = root.querySelector<SVGSVGElement>('.octopus-creature')!;
  const arms = root.querySelector<SVGGElement>('.octopus-connection-arms')!;
  let directory: Connection[] = [];
  let catalog: Catalog | undefined;
  let selectedId: string | undefined;
  let creatureHeight = 174;
  const details = root.querySelector<HTMLElement>('.octopus-capabilities')!;
  const list = root.querySelector<HTMLElement>('.octopus-package-list')!;
  const counts = root.querySelector<HTMLElement>('.octopus-counts')!;
  const status = root.querySelector<HTMLElement>('.octopus-status')!;
  const refresh = root.querySelector<HTMLButtonElement>('.octopus-refresh')!;
  const collapse = () => { details.hidden = true; for (const button of connections.querySelectorAll('button')) button.setAttribute('aria-expanded', 'false'); };
  const closeDetails = () => {
    const button = [...connections.querySelectorAll<HTMLButtonElement>('button')].find(item => item.dataset.connectionId === selectedId);
    collapse(); button?.focus();
  };
  const card = root.querySelector<HTMLElement>('.octopus-card')!;
  const resize = root.querySelector<HTMLButtonElement>('.octopus-resize')!;
  const sizeKey = 'menshen:octopus-size';
  let preferredWidth: number | undefined;
  const positionKey = 'menshen:octopus-position';
  let position: { x: number; y: number } | undefined;
  let gesture: { id: number; x: number; y: number; left: number; top: number; width: number; resizing: boolean; dragging: boolean; handle: Element } | undefined;
  let suppressClick = false;
  const viewport = () => {
    const visual = window.visualViewport;
    return { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight };
  };
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  const placeDetails = () => {
    if (details.hidden) return;
    const view = viewport();
    details.style.maxWidth = `${Math.max(0, view.width - 16)}px`;
    details.style.maxHeight = `${Math.max(0, view.height - 16)}px`;
    const anchor = root.getBoundingClientRect();
    const panel = details.getBoundingClientRect();
    details.style.left = `${clamp(anchor.right - panel.width, view.left + 8, view.left + view.width - panel.width - 8)}px`;
    details.style.top = `${clamp(anchor.bottom - panel.height, view.top + 8, view.top + view.height - panel.height - 8)}px`;
  };
  const place = (x: number, y: number) => {
    root.dataset.positioned = 'true';
    const view = viewport();
    const rect = root.getBoundingClientRect();
    position = { x: clamp(x, view.left + 8, view.left + view.width - rect.width - 8), y: clamp(y, view.top + 8, view.top + view.height - rect.height - 8) };
    root.style.left = `${position.x}px`;
    root.style.top = `${position.y}px`;
    placeDetails();
  };
  const savePosition = () => {
    try { if (position) localStorage.setItem(positionKey, JSON.stringify(position)); } catch { /* Position remains usable when storage is unavailable. */ }
  };
  const fitSize = () => {
    const view = viewport();
    const min = Math.min(160, Math.max(1, view.width - 16));
    let max = Math.max(1, Math.min(480, view.width - 16));
    if (preferredWidth !== undefined) root.style.width = `${clamp(preferredWidth, Math.min(min, max), max)}px`;
    // SVG height scales with width; text and borders retain their natural size.
    const rect = card.getBoundingClientRect();
    const creature = root.querySelector<SVGElement>('.octopus-creature')!.getBoundingClientRect();
    if (creature.height > 0) {
      max = Math.max(1, Math.min(max, (view.height - 16 - (rect.height - creature.height)) * 280 / creatureHeight));
      const width = clamp(preferredWidth ?? rect.width, Math.min(min, max), max);
      if (preferredWidth !== undefined || rect.width > max) root.style.width = `${width}px`;
    }
    resize.setAttribute('aria-valuemin', String(Math.round(Math.min(min, max))));
    resize.setAttribute('aria-valuemax', String(Math.floor(max)));
    resize.setAttribute('aria-valuenow', String(Math.round(root.getBoundingClientRect().width)));
    resize.setAttribute('aria-valuetext', `${Math.round(root.getBoundingClientRect().width)} 像素宽`);
  };
  const reflow = () => {
    fitSize();
    const rect = root.getBoundingClientRect();
    const view = viewport();
    if (position || rect.left < view.left + 8 || rect.top < view.top + 8 || rect.right > view.left + view.width - 8 || rect.bottom > view.top + view.height - 8) place(position?.x ?? rect.left, position?.y ?? rect.top);
    else placeDetails();
  };
  const saveSize = () => {
    try { if (preferredWidth !== undefined) localStorage.setItem(sizeKey, JSON.stringify(preferredWidth)); } catch { /* Resizing also works without storage. */ }
    savePosition();
  };
  const setSize = (width: number, x: number, y: number) => {
    // Manual sizing leaves the compact chat layout, just like manual movement.
    place(x, y);
    preferredWidth = width;
    fitSize();
    preferredWidth = root.getBoundingClientRect().width;
    place(x, y);
  };
  resize.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = { ArrowRight: 1, ArrowUp: 1, '+': 1, '=': 1, ArrowLeft: -1, ArrowDown: -1, '-': -1, '−': -1 }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = root.getBoundingClientRect();
    setSize(rect.width + direction * (event.shiftKey ? 40 : 10), rect.left, rect.top);
    saveSize();
  });
  card.addEventListener('keydown', event => {
    const button = (event.target as Element).closest('.octopus-head-hit, .octopus-project-hit');
    if (!button) return;
    button.setAttribute('aria-description', '按住拖动可调整位置；聚焦后用方向键移动，Shift 加速。');
    {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = root.getBoundingClientRect();
      const step = event.shiftKey ? 40 : 10;
      place(rect.left + direction[0] * step, rect.top + direction[1] * step);
      savePosition();
    }
  });
  card.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || gesture) return;
    const handle = (event.target as Element).closest('button, .octopus-connection-arms path') ?? card;
    const rect = root.getBoundingClientRect();
    suppressClick = false;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, resizing: handle === resize, dragging: false, handle };
    handle.setPointerCapture(event.pointerId);
  });
  card.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.dragging && Math.hypot(dx, dy) < 6) return;
    gesture.dragging = true;
    suppressClick = true;
    if (gesture.resizing) {
      root.dataset.resizing = 'true';
      const ratio = creatureHeight / 280;
      setSize(gesture.width + (dx + dy * ratio) / (1 + ratio * ratio), gesture.left, gesture.top);
    } else {
      root.dataset.dragging = 'true';
      place(gesture.left + dx, gesture.top + dy);
    }
  });
  const finishDrag = (event: PointerEvent) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const { handle, dragging, resizing } = gesture;
    gesture = undefined;
    delete root.dataset.dragging;
    delete root.dataset.resizing;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (dragging) { if (resizing) saveSize(); else savePosition(); }
  };
  card.addEventListener('pointerup', finishDrag);
  card.addEventListener('pointercancel', finishDrag);
  card.addEventListener('lostpointercapture', finishDrag);
  card.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
  }, true);
  window.addEventListener('resize', reflow);
  window.visualViewport?.addEventListener('resize', reflow);
  window.visualViewport?.addEventListener('scroll', reflow);
  const layoutObserver = new ResizeObserver(reflow);
  layoutObserver.observe(card);
  layoutObserver.observe(details);
  const appendNames = (label: string, names: string[], parent: HTMLElement = list) => {
    const heading = document.createElement('h4'); heading.textContent = `${label} · ${names.length}`;
    const items = document.createElement('ul');
    for (const name of names.length ? names : ['无']) { const item = document.createElement('li'); item.textContent = name; items.append(item); }
    parent.append(heading, items);
  };
  const describe = (connection: Connection) => !connection.connected ? '连接失败 / 未连接' : connection.enabled ? '已握手 · 新会话启用' : '已握手 · 新会话停用';
  const drawSelected = () => {
    const connection = directory.find(item => item.id === selectedId);
    if (!connection) { collapse(); return; }
    details.setAttribute('aria-label', `${connection.id} 工具与技能`);
    details.querySelector('strong')!.textContent = `${connection.id} · MCP`;
    list.replaceChildren();
    const state = document.createElement('p'); state.textContent = `${describe(connection)}；业务健康未验证。`; list.append(state);
    appendNames('该连接工具', connection.names);
    // Catalog skills currently have no server ownership. Never infer a mount from the aggregate package id.
    appendNames('该连接专属技能（无已声明归属）', []);
    const global = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '全局技能 · 未挂载到此 MCP'; global.append(summary);
    const skills = catalog?.installed.flatMap(pkg => {
      const active = catalog!.packages.some(binding => binding.id === pkg.id && binding.version === pkg.version);
      return pkg.skills.map(skill => `${skill.path}${active && pkg.enabled && pkg.compatible ? '' : '（停用 / 不可用）'}`);
    });
    if (skills) appendNames('全局技能', [...new Set(skills)], global);
    else { const hint = document.createElement('p'); hint.textContent = '技能目录读取失败，刷新重试。'; global.append(hint); }
    list.append(global);
    placeDetails();
  };
  const drawConnections = (items: Connection[]) => {
    directory = [...new Map(items.map(item => [item.id, { ...item, names: [...new Set(item.names)] }])).values()];
    const focused = (document.activeElement as HTMLElement | null)?.dataset.connectionId;
    connections.replaceChildren(); arms.replaceChildren();
    creatureHeight = Math.max(174, 126 + Math.ceil(directory.length / 2) * 58);
    creature.setAttribute('viewBox', `0 0 280 ${creatureHeight}`);
    root.dataset.creatureHeight = String(creatureHeight);
    head.style.setProperty('top', `${22 / creatureHeight * 100}%`, 'important'); head.style.setProperty('height', `${74 / creatureHeight * 100}%`, 'important');
    for (const [index, connection] of directory.entries()) {
      const left = index % 2 === 0, x = left ? 68 : 212, y = 120 + Math.floor(index / 2) * 58;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${left ? 136 : 172} 84 C${left ? 114 : 196} ${y - 16} ${x} ${y - 32} ${x} ${y + 12}`);
      path.setAttribute('stroke', connection.connected ? '#528f7e' : '#a58c6c'); path.setAttribute('stroke-width', '12');
      const suckers = path.cloneNode() as SVGPathElement; suckers.setAttribute('stroke', '#d4e5d6'); suckers.setAttribute('stroke-width', '3'); suckers.setAttribute('stroke-dasharray', '1 9');
      arms.append(path, suckers);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'octopus-project-hit'; button.dataset.connectionId = connection.id;
      button.style.left = `${(left ? 8 : 148) / 280 * 100}%`; button.style.top = `${(y + 5) / creatureHeight * 100}%`;
      button.style.width = `${124 / 280 * 100}%`; button.style.height = `${44 / creatureHeight * 100}%`;
      button.setAttribute('aria-label', `${connection.id}：${describe(connection)}；查看工具与技能`);
      button.setAttribute('aria-controls', 'octopus-capabilities'); button.setAttribute('aria-expanded', String(!details.hidden && selectedId === connection.id));
      button.setAttribute('aria-description', '按住拖动；方向键移动；Enter 或空格展开该连接。');
      const label = document.createElement('span'); label.textContent = connection.id;
      const state = document.createElement('small'); state.textContent = !connection.connected ? '未连接' : connection.enabled ? `${connection.names.length} 工具 · 已握手` : '已握手 · 停用'; button.append(label, state);
      button.onclick = () => {
        if (selectedId === connection.id && !details.hidden) { collapse(); return; }
        collapse(); selectedId = connection.id; details.hidden = false; button.setAttribute('aria-expanded', 'true'); drawSelected();
      };
      path.addEventListener('click', () => button.click());
      suckers.addEventListener('click', () => button.click());
      connections.append(button);
    }
    root.querySelector('.octopus-connection-count')!.textContent = `${directory.length} 个 MCP 连接`;
    counts.textContent = directory.length ? `${directory.reduce((sum, item) => sum + item.names.length, 0)} 工具` : '尚未配置 MCP';
    if (!details.hidden) drawSelected();
    if (focused) [...connections.querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.connectionId === focused)?.focus();
    reflow(); window.dispatchEvent(new Event('octopus:geometry-changed'));
  };
  let request = 0;
  const load = async () => {
    const current = ++request;
    refresh.disabled = true;
    const [connectionResult, catalogResult] = await Promise.allSettled([api<Connection[]>('connections'), api<Catalog>('agent_packages')]);
    if (current !== request) return;
    catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : undefined;
    if (connectionResult.status === 'fulfilled') drawConnections(connectionResult.value);
    else { counts.textContent = '连接目录读取失败，保留上次目录'; if (!details.hidden) drawSelected(); }
    refresh.disabled = false;
  };
  head.onclick = () => { collapse(); openAssistant(); };
  root.querySelector<HTMLButtonElement>('.octopus-dismiss')!.onclick = closeDetails;
  refresh.onclick = () => { void load(); };
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && !details.hidden) { event.preventDefault(); event.stopPropagation(); closeDetails(); } });
  document.addEventListener('pointerdown', event => { if (!root.contains(event.target as Node)) collapse(); });
  window.addEventListener('menshen:packages-changed', () => { void load(); });
  window.addEventListener('octopus:connections-changed', () => { void load(); });
  document.body.append(root);
  try {
    const saved = JSON.parse(localStorage.getItem(positionKey) ?? 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position = { x: saved.x, y: saved.y };
  } catch { /* Ignore invalid or inaccessible saved positions. */ }
  try {
    const saved = JSON.parse(localStorage.getItem(sizeKey) ?? 'null');
    if (typeof saved === 'number' && Number.isFinite(saved) && saved > 0) preferredWidth = saved;
  } catch { /* Ignore invalid or inaccessible saved sizes. */ }
  reflow();
  void load();
  return {
    update(model: ChatPanelModel, preparing: boolean) {
      const state = octopusState(model, preparing);
      root.dataset.state = state.kind;
      root.dataset.expanded = String(model.expanded);
      status.textContent = state.label;
      head.title = `${state.label} · 打开章鱼助手`;
      reflow();
    },
    setChatOpen(open: boolean) { root.dataset.chatOpen = String(open); if (open) collapse(); reflow(); },
  };
}
