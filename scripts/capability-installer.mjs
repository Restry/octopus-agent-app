import {mkdir,lstat,writeFile,rename,readdir,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {parseDocument} from 'yaml';
import {Type} from 'typebox';
import {dataDirectory,privateFile,validateMcp,probeMcp,activateMcp,connectionStatus} from './mcp-client.mjs';
export const installationReasons=['本轮没有匹配的明确安装授权','安装请求已失效，请重新提交','MCP 握手或工具发现失败；未安装','安装目标已存在，禁止覆盖','安装配置存储失败；未安装','技能格式无效；仅接受匹配 slug 的 name 和 description frontmatter','安装路径不安全'];
const fail=message=>{throw new Error(message);};
async function safeDirectory(directory){
 const resolved=path.resolve(directory);let current=path.parse(resolved).root;
 for(const part of resolved.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);try{await mkdir(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())fail('安装路径不安全');}
}
export function validateSkill({slug,content}){
 if(typeof slug!=='string'||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)||slug.length>64||slug==='credential-organizing'||typeof content!=='string'||Buffer.byteLength(content)>32768||content.includes('\0'))fail('技能格式无效；仅接受匹配 slug 的 name 和 description frontmatter');
 const match=content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);if(!match)fail('技能格式无效；仅接受匹配 slug 的 name 和 description frontmatter');
 try{const doc=parseDocument(match[1],{uniqueKeys:true});if(doc.errors.length)throw new Error();const meta=doc.toJS({maxAliasCount:0});if(!meta||Object.keys(meta).some(k=>!['name','description'].includes(k))||meta.name!==slug||typeof meta.description!=='string'||!meta.description.trim()||meta.description.length>1024||!match[2].trim())throw new Error();}catch{fail('技能格式无效；仅接受匹配 slug 的 name 和 description frontmatter');}
 return {slug,content};
}
export function createCapabilityInstaller({directory=dataDirectory()}={}){
 const pending=new Map();let queue=Promise.resolve();
 const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
 const registry=path.join(directory,'mcp-installed.json'),skillsRoot=path.join(directory,'skills');
 const readRegistry=async()=>{try{return JSON.parse(await privateFile(registry));}catch(e){if(e.code==='ENOENT')return {};throw e;}};
 async function prepare({instruction,installation,sessionId,confirmCommand=false}){
  if(typeof instruction!=='string'||instruction.length>200||!/^(?:请帮我|请|帮我|现在|直接|please)?\s*(?:安装|添加|接入|install\b|add\b|connect\b)/i.test(instruction)||/不要|不许|禁止|只读|别|暂不|do not|don't|never|如何|怎么|方案|解释/i.test(instruction)||!/^[-\p{L}\p{N}\s，。,:：!！]+$/u.test(instruction)||typeof sessionId!=='string')fail('本轮没有匹配的明确安装授权');
  if(!installation||Object.keys(installation).some(k=>!['kind','id','config','slug','content'].includes(k)))fail('本轮没有匹配的明确安装授权');
  let payload;
  if(installation.kind==='mcp'){
   payload={kind:'mcp',id:installation.id,config:validateMcp(installation.id,installation.config)};
   if(payload.config.type==='stdio'&&confirmCommand!==true)fail('本轮没有匹配的明确安装授权');
  }else if(installation.kind==='skill')payload={kind:'skill',...validateSkill(installation)};
  else fail('本轮没有匹配的明确安装授权');
  for(const [id,p] of pending)if(Date.now()-p.createdAt>600000)pending.delete(id);
  if(pending.size>=32)fail('安装请求已失效，请重新提交');
  const requestId=randomBytes(8).toString('hex');
  const intent=`请安装${payload.kind==='mcp'?' MCP '+payload.id:'技能 '+payload.slug}。安装引用 ${requestId}。仅使用本轮受控安装工具，报告真实结果。`;
  pending.set(requestId,{payload,sessionId,intent,createdAt:Date.now()});
  return {requestId,intent};
 }
 function claim(requestId,kind,input){const p=pending.get(requestId);if(!p||Date.now()-p.createdAt>600000)fail('安装请求已失效，请重新提交');if(p.payload.kind!==kind||input.installRequestId!==requestId||input.sessionId!==p.sessionId||input.intent!==p.intent)fail('本轮没有匹配的明确安装授权');pending.delete(requestId);return p.payload;}
 async function installMcp(requestId,input){const p=claim(requestId,'mcp',input);return serial(async()=>{
  const registered=await readRegistry();if(Object.hasOwn(registered,p.id)||connectionStatus().some(e=>e.id===p.id))fail('安装目标已存在，禁止覆盖');
  const entry=await probeMcp(p.id,p.config);const temporary=registry+'.'+randomUUID()+'.pending';
  try{await safeDirectory(directory);await writeFile(temporary,JSON.stringify({...registered,[p.id]:p.config},null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,registry);}catch{await entry.client.close().catch(()=>{});await unlink(temporary).catch(()=>{});fail('安装配置存储失败；未安装');}
  await activateMcp(entry);return {installed:true,id:p.id,connected:true,tools:entry.tools.map(t=>t.name),effect:'new_sessions'};
 });}
 async function installSkill(requestId,input){const p=claim(requestId,'skill',input);return serial(async()=>{
  await safeDirectory(skillsRoot);const target=path.join(skillsRoot,p.slug);
  try{await mkdir(target,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('安装目标已存在，禁止覆盖');throw e;}
  if((await lstat(target)).isSymbolicLink())fail('安装路径不安全');
  try{await writeFile(path.join(target,'SKILL.md'),p.content,{mode:0o600,flag:'wx'});}catch{await unlink(path.join(target,'SKILL.md')).catch(()=>{});await rmdir(target).catch(()=>{});fail('安装配置存储失败；未安装');}
  return {installed:true,slug:p.slug,path:`skills/${p.slug}/SKILL.md`,effect:'new_sessions'};
 });}
 async function skills(){
  let entries;try{entries=await readdir(skillsRoot,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
  await safeDirectory(skillsRoot);const result=[];
  for(const entry of entries){if(entry.isSymbolicLink()||!entry.isDirectory())fail('安装路径不安全');const content=await privateFile(path.join(skillsRoot,entry.name,'SKILL.md'));validateSkill({slug:entry.name,content});result.push({path:`skills/${entry.name}/SKILL.md`,content,requiresTools:[]});}
  return result;
 }
 const tools=(tool,input)=>[
  tool('install_mcp','仅执行本条用户明确提供并经后端校验的 MCP 安装引用；握手和工具发现成功后才落盘，新会话可用。禁止自行生成配置。',{requestId:Type.String({pattern:'^[a-f0-9]{16}$'})},({requestId})=>installMcp(requestId,input)),
  tool('install_skill','仅安装本条用户提供的纯 SKILL.md 引用，不执行脚本，不联网下载，不覆盖内置技能；新会话提供 read_skill。',{requestId:Type.String({pattern:'^[a-f0-9]{16}$'})},({requestId})=>installSkill(requestId,input))
 ];
 return {prepare,skills,tools,installMcp};
}
