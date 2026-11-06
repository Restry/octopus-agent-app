import {api} from './platform';
type McpConfig={type?:string;command?:string;args?:string[];env?:Record<string,string>;url?:string};
export async function installMcpServers(servers:Record<string,McpConfig>,sessionId:string) {
 const entries=Object.entries(servers);
 if(!entries.length||entries.length>16)throw new Error('请提供 1–16 个 MCP 配置');
 const commands=entries.filter(([,c])=>c.command);
 if(commands.length&&!window.confirm('允许启动以下本机 MCP 程序？请核对程序与参数。不会自动下载安装。\n\n'+commands.map(([id,c])=>id+'\n'+JSON.stringify({command:c.command,args:c.args||[],envNames:Object.keys(c.env||{})},null,2)).join('\n\n')))throw new Error('已取消启动 MCP');
 const installed:string[]=[];
 for(const [id,config] of entries){
  const request=await api<{requestId:string;intent:string}>('agent_prepare_install',{instruction:'请添加 MCP',installation:{kind:'mcp',id,config},sessionId,confirmCommand:!!config.command});
  await api('agent_install_prepared',{...request,sessionId});installed.push(id);
  window.dispatchEvent(new Event('octopus:connections-changed'));
 }
 return '已连接 '+installed.join('、')+'，已完成握手与工具发现。新建会话后可使用这些工具；已有会话保持原能力。';
}
export function mountMcpSettings(container:HTMLElement,ensureSession:()=>Promise<string>) {
 const panel=document.createElement('section');panel.className='agent-packages';panel.setAttribute('aria-label','添加 MCP');
 const title=document.createElement('strong');title.textContent='添加 MCP';
 const status=document.createElement('p');status.setAttribute('role','status');
 const app=document.createElement('input');app.value='/Applications/Menshen.app';app.setAttribute('aria-label','门神应用路径');
 const preset=document.createElement('button');preset.type='button';preset.textContent='连接本机门神（stdio）';
 const hint=document.createElement('p');hint.textContent='选择已安装的新版门神：填写 .app 路径。旧版若没有 stdio 入口，握手将失败，请先升级。也可在聊天粘贴“请添加”及标准 mcpServers JSON。无需先配置模型。';
 const input=document.createElement('textarea');input.rows=6;input.autocomplete='off';input.spellcheck=false;input.setAttribute('aria-label','MCP 配置 JSON');input.placeholder='{"mcpServers":{"example":{"command":"/absolute/path/to/server","args":[]}}}';
 const save=document.createElement('button');save.type='button';save.textContent='检查并添加 MCP';
 const install=async(servers:Record<string,McpConfig>)=>{
  save.disabled=preset.disabled=true;status.textContent='正在握手并发现工具…';
  try{status.textContent=await installMcpServers(servers,await ensureSession());input.value='';}
  catch(error){status.textContent=error instanceof Error?error.message:'连接失败，未安装';}
  finally{save.disabled=preset.disabled=false;}
 };
 preset.onclick=()=>{const value=app.value.trim().replace(/\/$/,'');if(!value.startsWith('/')||!value.endsWith('.app')){status.textContent='请填写已安装门神的绝对 .app 路径';return;}void install({menshen:{command:value+'/Contents/MacOS/menshen-desktop',args:['--mcp-stdio']}});};
 save.onclick=()=>{try{const data=JSON.parse(input.value);if(!data.mcpServers||typeof data.mcpServers!=='object'||Array.isArray(data.mcpServers))throw new Error();void install(data.mcpServers);}catch{status.textContent='请填写标准 mcpServers JSON';}};
 panel.append(title,status,hint,app,preset,input,save);container.prepend(panel);
 void api<{id:string;connected:boolean;tools:number}[]>('connections').then(items=>{status.textContent=items.length?items.map(c=>`${c.id}：${c.connected?'已连接':'连接失败'}（${c.tools} 工具）`).join('；'):'尚未添加 MCP';}).catch(()=>{status.textContent='连接状态读取失败';});
}
