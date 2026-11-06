import {getVersion} from '@tauri-apps/api/app';
import {check, type Update} from '@tauri-apps/plugin-updater';
import {relaunch} from '@tauri-apps/plugin-process';
import {api, native} from './platform';

export function createUpdater(isBusy: () => boolean, setInstalling: (value: boolean) => void) {
  let version = '', update: Update | null = null, phase = 'idle', message = '', received = 0, total = 0;
  const panels = new Set<HTMLElement>();
  const draw = () => {
    if (!native) return;
    for (const panel of panels) {
      if (!panel.isConnected) { panels.delete(panel); continue; }
      panel.replaceChildren();
      const status = document.createElement('p');
      status.setAttribute('role','status');
      status.textContent = `章鱼 ${version || '…'} · ${message || '自动检查更新已启用'}`;
      panel.append(status);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = phase === 'ready' ? '安装更新并重启' : update ? `下载 ${update.version}` : '检查更新';
      button.disabled = ['checking','downloading','installing'].includes(phase) || phase === 'ready' && isBusy();
      button.onclick = () => { void (phase === 'ready' ? install() : update ? download() : inspect()); };
      panel.append(button);
      if (phase === 'downloading') {
        const progress = document.createElement('progress');
        if (total) { progress.max = total; progress.value = received; }
        progress.setAttribute('aria-label','更新下载进度');
        panel.append(progress);
      }
    }
  };
  const error = (label: string, reason: unknown) => {
    phase = 'error';
    message = `${label}：${String(reason instanceof Error ? reason.message : reason).slice(0,240)}`;
    draw();
  };
  async function inspect() {
    if (!native || ['checking','downloading','installing','ready'].includes(phase) || update) return;
    phase = 'checking'; message = '正在检查更新…'; draw();
    try {
      update = await check({timeout:15000});
      phase = 'idle';
      message = update !== null ? `发现 ${update.version}，可下载` : '已是最新版本';
      draw();
    } catch (reason) { error('检查失败，可重试',reason); }
  }
  async function download() {
    if (!update || phase === 'downloading') return;
    phase = 'downloading'; received = 0; total = 0; message = '正在下载…'; draw();
    try {
      await update.download(event => {
        if (event.event === 'Started') total = event.data.contentLength || 0;
        if (event.event === 'Progress') received += event.data.chunkLength;
        message = total ? `下载 ${Math.min(100,Math.round(received / total * 100))}%` : `已下载 ${(received / 1048576).toFixed(1)} MiB`;
        draw();
      },{timeout:120000});
      phase = 'ready'; message = '签名已验证，安装就绪；空闲时点击安装并重启'; draw();
    } catch (reason) {
      await update.close().catch(()=>{}); update = null;
      error('下载或签名验证失败，请重新检查',reason);
    }
  }
  async function install() {
    if (!update || phase !== 'ready' || isBusy()) return;
    setInstalling(true);
    try {
      await api('agent_update_lock',{locked:true});
      phase = 'installing'; message = '正在安装，随后重启…'; draw();
      await update.install();
      await relaunch();
    } catch (reason) {
      await api('agent_update_lock',{locked:false}).catch(()=>{});
      setInstalling(false);
      await update?.close().catch(()=>{}); update = null;
      error('安装或重启失败，请重新检查',reason);
    }
  }
  if (native) {
    void getVersion().then(value=>{version=value;draw();}).catch(reason=>error('版本读取失败',reason));
    window.setTimeout(()=>{void inspect();},15000);
    window.setInterval(()=>{void inspect();},6*60*60*1000);
  }
  return {
    mount(container: HTMLElement) {
      const panel = document.createElement('section');
      panel.setAttribute('aria-label','软件更新');
      container.append(panel); panels.add(panel);
      if (native) draw(); else panel.textContent = '软件更新仅在桌面应用内可用';
    },
    refresh: draw,
  };
}
