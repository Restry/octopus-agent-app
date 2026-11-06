import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {Type} from 'typebox';
export const dataDirectory=()=>process.env.OCTOPUS_DATA_DIR||path.join(homedir(),'Library/Application Support/Octopus');
const connections=new Map();
const secrets=new Set();
export async function privateFile(file){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw new Error('PRIVATE_CONFIG_REQUIRED');return readFile(file,'utf8');}
export function sanitize(value){
 const redact=text=>{for(const secret of secrets)if(secret)text=text.replaceAll(secret,'[已隐藏]');return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [已隐藏]');};
 const visit=item=>{
  if(typeof item==='string'){
   if(/^\s*[\[{]/.test(item)){try{return JSON.stringify(visit(JSON.parse(item)));}catch{}}
   return redact(item);
  }
  if(Array.isArray(item))return item.map(visit);
  if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,item])=>[redact(key),visit(item)]));
  return item;
 };
 return visit(value);
}
export function validateMcp(id,config){
 if(typeof id!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/i.test(id)||!config||typeof config!=='object'||Array.isArray(config))throw new Error('MCP 配置无效');
 if(config.type==='stdio'||!config.type&&config.command){
  if(Object.keys(config).some(k=>!['type','command','args','env'].includes(k))||typeof config.command!=='string'||!config.command||config.command.length>4096||/[\r\n\0]/.test(config.command))throw new Error('stdio command 无效');
  const basename=path.basename(config.command).replace(/\.exe$/i,'').toLowerCase();
  if(['sh','bash','zsh','fish','dash','cmd','powershell','pwsh','npx','npm','pnpm','yarn','bunx','uvx'].includes(basename))throw new Error('请使用已安装 MCP 的直接可执行文件；不执行 shell 或自动下载');
  const args=config.args||[],env=config.env||{};
  if(!Array.isArray(args)||args.length>128||args.some(a=>typeof a!=='string'||a.length>8192||a.includes('\0'))||!env||typeof env!=='object'||Array.isArray(env)||Object.keys(env).length>64||Object.entries(env).some(([k,v])=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(k)||typeof v!=='string'||v.length>8192||v.includes('\0')))throw new Error('stdio args/env 无效');
  for(const value of [...args,...Object.values(env)])if(value.length>2)secrets.add(value);
  return {type:'stdio',command:config.command,args,env};
 }
 if(typeof config.url!=='string'||!['http','streamable-http'].includes(config.type))throw new Error('仅支持 stdio 或明确指定的 Streamable HTTP MCP');
 if(Object.keys(config).some(k=>!['type','url','headers'].includes(k)))throw new Error('MCP 配置含不支持的字段');
 let url;try{url=new URL(config.url);}catch{throw new Error('MCP URL 无效');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('MCP URL 必须为 HTTP 或 HTTPS，且不能含认证、查询或片段');
 const headers=config.headers||{};
 if(typeof headers!=='object'||Array.isArray(headers)||Object.keys(headers).length>16||Object.entries(headers).some(([k,v])=>!/^authorization$|^x-api-key$/i.test(k)||typeof v!=='string'||!v||v.length>8192||/[\r\n\0]/.test(v)))throw new Error('MCP 认证 headers 无效');
 for(const value of Object.values(headers)){secrets.add(value);if(value.startsWith('Bearer '))secrets.add(value.slice(7));}
 return {type:'http',url:url.href,headers};
}
export async function probeMcp(id,config){
 const checked=validateMcp(id,config),client=new Client({name:'octopus',version:'0.1.0'}),entry={id,connected:false,tools:[],client};
 try{
  const transport=checked.type==='stdio'?new StdioClientTransport({command:checked.command,args:checked.args,env:{HOME:homedir(),PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',SHELL:'/bin/sh',TERM:'dumb',LOGNAME:process.env.LOGNAME||'',USER:process.env.USER||'',...checked.env},stderr:'pipe'}):new StreamableHTTPClientTransport(new URL(checked.url),{requestInit:{headers:checked.headers,redirect:'error'}});
  transport.stderr?.resume();
  client.onclose=()=>{entry.connected=false;};
  await client.connect(transport,{timeout:10000});
  let cursor;const cursors=new Set(),names=new Set();
  do{const page=await client.listTools({cursor},{timeout:10000});for(const t of sanitize(page.tools)){if(!/^[A-Za-z_][A-Za-z0-9_-]{0,80}$/.test(t.name)||names.has(t.name)||t.inputSchema?.type!=='object')throw new Error();names.add(t.name);entry.tools.push(t);}cursor=page.nextCursor;if(entry.tools.length>300||cursor&&cursors.has(cursor))throw new Error();cursors.add(cursor);}while(cursor);
  entry.connected=true;return entry;
 }catch{await client.close().catch(()=>{});throw new Error('MCP 握手或工具发现失败；未安装');}
}
export async function activateMcp(entry){const old=connections.get(entry.id);connections.set(entry.id,entry);await old?.client?.close().catch(()=>{});}
export async function connectMcp(id,config){
 validateMcp(id,config);
 try{const entry=await probeMcp(id,config);await activateMcp(entry);return {id,connected:true,tools:entry.tools.length};}
 catch{if(!connections.has(id))connections.set(id,{id,connected:false,tools:[],client:null});return {id,connected:false,tools:0};}
}
export async function initializeConnections(){
 const directory=dataDirectory();
 let token;try{token=(await privateFile(path.join(directory,'menshen-token'))).trim();}catch{}
 let mem0;try{mem0=JSON.parse(await privateFile(path.join(directory,'mem0.json'))).mcpServers['mem0-memory-service'];}catch{}
 let registered={};try{registered=JSON.parse(await privateFile(path.join(directory,'mcp-installed.json')));}catch(error){if(error.code!=='ENOENT')throw error;}
 await Promise.all([...(token?[connectMcp('menshen',{type:'http',url:'http://127.0.0.1:43918/mcp',headers:{Authorization:`Bearer ${token}`}})]:[]),...(mem0?[connectMcp('mem0',mem0)]:[]),...Object.entries(registered).map(([id,c])=>connectMcp(id,c))]);
 return connectionStatus();
}
export const connectionStatus=()=>[...connections.values()].map(e=>({id:e.id,connected:e.connected,tools:e.tools.length,names:e.tools.map(t=>t.name)}));
export async function callMcp(id,name,args){const e=connections.get(id);if(!e?.connected||!e.tools.some(t=>t.name===name))throw new Error('MCP_TOOL_UNAVAILABLE');const reply=await e.client.callTool({name,arguments:args},undefined,{timeout:30000});if(reply.isError)throw new Error('MCP_TOOL_FAILED');const safe=sanitize(reply);if(Buffer.byteLength(JSON.stringify(safe))>65536)throw new Error('MCP_RESULT_TOO_LARGE');return safe;}
export async function closeConnections(){await Promise.all([...connections.values()].map(e=>e.client?.close().catch(()=>{})));connections.clear();}
export function createMcpPackage({tool}){
 const tools=[];for(const e of connections.values())if(e.connected)for(const t of e.tools){const name=e.id==='menshen'?t.name:`${e.id}__${t.name}`;const required=new Set(t.inputSchema.required||[]);const props=Object.fromEntries(Object.entries(t.inputSchema.properties||{}).map(([k,v])=>[k,required.has(k)?v:Type.Optional(v)]));tools.push(tool(name,`${e.id} MCP：${t.description||t.name}`,props,args=>callMcp(e.id,t.name,args)));}
 return {id:'menshen',version:'0.4.2',apiVersion:1,runtime:'node',dependencies:{},permissions:['mcp:server-authority'],tools,skills:[]};
}
