import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,realpath,readFile,lstat,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {createAgentService} from './agent-service.mjs';
import {connectionStatus,initializeConnections} from './mcp-client.mjs';
import {createCapabilityInstaller,validateSkill} from './capability-installer.mjs';

test('chat installation references authenticate MCP, persist privately, and expose MCP/skill to real runtime in a new session',async()=>{
 const directory=await realpath(await mkdtemp(path.join(tmpdir(),'octopus-install-'))),secret='fixture-auth-only-do-not-persist-in-history',transports=new Set();
 const before={data:process.env.OCTOPUS_DATA_DIR,agent:process.env.OCTOPUS_AGENT_DIR};
 process.env.OCTOPUS_DATA_DIR=directory;process.env.OCTOPUS_AGENT_DIR=path.join(directory,'sessions');
 let calls=0;
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  if(req.headers.authorization!==`Bearer ${secret}`){res.writeHead(401);res.end();return;}
  let body='';for await(const chunk of req)body+=chunk;
  const mcp=new Server({name:'install-fixture',version:'1'},{capabilities:{tools:{}}});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',description:'Authenticated fixture echo',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}));
  mcp.setRequestHandler(CallToolRequestSchema,async()=>{calls++;return {content:[{type:'text',text:JSON.stringify({ok:true,echo:secret})}]};});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});transports.add(transport);res.once('close',()=>{transports.delete(transport);void transport.close();void mcp.close();});await mcp.connect(transport);await transport.handleRequest(req,res,JSON.parse(body));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/mcp`,seen=[];let actions=[];
 const modelStream=(model,context)=>{
  seen.push(context);assert.equal(JSON.stringify(context).includes(secret),false);
  const action=actions.shift();
  if(action)assert.ok(context.messages.flatMap(m=>m.toolsAdded||[]).some(t=>t.name===action.name),action.name+' is registered');
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:action?[{type:'toolCall',id:'call-'+seen.length,...action}]:[{type:'text',text:'fixture completed'}],stopReason:action?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end(message);});return stream;
 };
 const service=createAgentService({modelStream,config:async()=>({model:'gpt-6.1-sol',baseUrl:'https://fixture.openai.azure.com/openai/v1',credentialRef:'fixture/AUTH'}),key:async()=>'fixture-provider-key',vault:async()=>({keys:[],projects:{},secrets_meta:{}})});
 let run=0;
 const execute=async(sessionId,intent,action,installRequestId)=>{actions=[action];const reply=await service('agent_run',{id:'fixture-'+(++run),sessionId,intent,installRequestId});assert.equal(reply.error,undefined,JSON.stringify({reply,seen:seen.map(c=>({tools:c.tools?.map(t=>t.name)}))}));return reply;};
 try{
  const {sessionId}=await service('agent_session_new');
  const prepare=installation=>service('agent_prepare_install',{instruction:'请安装',installation,sessionId});
  const prepared=await prepare({kind:'mcp',id:'fixturechat',config:{type:'http',url,headers:{Authorization:`Bearer ${secret}`}}});
  assert.equal(JSON.stringify(prepared).includes(secret),false);
  const installed=await execute(sessionId,prepared.intent,{name:'install_mcp',arguments:{requestId:prepared.requestId}},prepared.requestId);
  assert.equal(installed.events.find(e=>e.tool==='install_mcp').ok,true,JSON.stringify(installed.events));
  assert.equal((await lstat(path.join(directory,'mcp-installed.json'))).mode&0o777,0o600);
  const registry=JSON.parse(await readFile(path.join(directory,'mcp-installed.json'),'utf8'));assert.equal(registry.fixturechat.headers.Authorization,`Bearer ${secret}`);
  const skill='---\nname: fixture-skill\ndescription: A harmless installed fixture skill\n---\nReturn the words installed skill proof.\n';
  const skillRequest=await prepare({kind:'skill',slug:'fixture-skill',content:skill});
  const skillReply=await execute(sessionId,skillRequest.intent,{name:'install_skill',arguments:{requestId:skillRequest.requestId}},skillRequest.requestId);
  assert.equal(skillReply.events.find(e=>e.tool==='install_skill').ok,true);
  await initializeConnections();
  const restarted=createAgentService({modelStream,config:async()=>({model:'gpt-6.1-sol',baseUrl:'https://fixture.openai.azure.com/openai/v1',credentialRef:'fixture/AUTH'}),key:async()=>'fixture-provider-key'});
  const next=await restarted('agent_session_new');
  actions=[{name:'fixturechat__echo',arguments:{}},{name:'read_skill',arguments:{packageId:'menshen',path:'skills/fixture-skill/SKILL.md'}}];
  const reply=await restarted('agent_run',{id:'after-install',sessionId:next.sessionId,intent:'请调用 fixturechat 的 echo 并读取 fixture-skill 技能'});
  assert.equal(reply.error,undefined);assert.equal(calls,1);
  assert.equal(reply.events.find(e=>e.tool==='fixturechat__echo').ok,true);
  assert.ok(seen.some(c=>JSON.stringify(c.messages).includes('installed skill proof')));
  assert.ok(seen.some(c=>c.messages.some(m=>m.role==='system'&&JSON.stringify(m).includes('fixture-skill'))));
  const unauthorized=await execute(sessionId,'只读查询，不要安装',{name:'install_mcp',arguments:{requestId:prepared.requestId}});
  assert.equal(unauthorized.events.find(e=>e.tool==='install_mcp').ok,false);
  const bad=await prepare({kind:'mcp',id:'bad-auth',config:{type:'http',url,headers:{Authorization:'Bearer invalid'}}});
  const failed=await execute(sessionId,bad.intent,{name:'install_mcp',arguments:{requestId:bad.requestId}},bad.requestId);
  assert.equal(failed.events.find(e=>e.tool==='install_mcp').ok,false);
  assert.equal(connectionStatus().some(c=>c.id==='bad-auth'),false);
  assert.equal((await readFile(path.join(directory,'mcp-installed.json'),'utf8')).includes('bad-auth'),false);
  for(const instruction of ['不要安装','如何安装','请先给安装方案','请安装但不要执行'])await assert.rejects(service('agent_prepare_install',{instruction,sessionId,installation:{kind:'mcp',id:'denied-intent',config:{type:'http',url}}}));
  const duplicate=await prepare({kind:'skill',slug:'fixture-skill',content:skill});
  const duplicateReply=await execute(sessionId,duplicate.intent,{name:'install_skill',arguments:{requestId:duplicate.requestId}},duplicate.requestId);
  assert.equal(duplicateReply.events.find(e=>e.tool==='install_skill').ok,false);
  assert.equal(await readFile(path.join(directory,'skills/fixture-skill/SKILL.md'),'utf8'),skill);
  const scopedRequest=await prepare({kind:'mcp',id:'wrong-session',config:{type:'http',url}});
  const scopedReply=await execute(next.sessionId,scopedRequest.intent,{name:'install_mcp',arguments:{requestId:scopedRequest.requestId}},scopedRequest.requestId);
  assert.equal(scopedReply.events.find(e=>e.tool==='install_mcp').ok,false);
  assert.equal(connectionStatus().some(c=>c.id==='wrong-session'),false);
  for(const config of [{type:'stdio',command:'sh'},{url},{type:'http',url:'file:///tmp/mcp'},{type:'http',url:url+'?token=secret'}])await assert.rejects(prepare({kind:'mcp',id:'invalid',config}));
  for(const slug of ['../escape','/absolute','credential-organizing'])assert.throws(()=>validateSkill({slug,content:skill}));
  assert.throws(()=>validateSkill({slug:'fixture-skill',content:'---\nname: fixture-skill\nname: duplicate\ndescription: x\n---\nx'}));
  const linked=path.join(directory,'linked');await symlink(directory,linked);
  const unsafe=createCapabilityInstaller({directory:linked});const request=await unsafe.prepare({instruction:'安装',sessionId,installation:{kind:'skill',slug:'other-skill',content:skill.replaceAll('fixture-skill','other-skill')}});
  const tools=unsafe.tools((name,d,props,fn)=>({name,fn}),{sessionId,intent:request.intent,installRequestId:request.requestId});await assert.rejects(tools.find(t=>t.name==='install_skill').fn({requestId:request.requestId}),/安装路径不安全/);
  for(const file of await readdir(path.join(directory,'sessions')))if(file.endsWith('.jsonl')||file.endsWith('.json'))assert.equal((await readFile(path.join(directory,'sessions',file),'utf8')).includes(secret),false);
 }finally{
  for(const transport of transports)await transport.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  for(const [k,v] of [['OCTOPUS_DATA_DIR',before.data],['OCTOPUS_AGENT_DIR',before.agent]])if(v===undefined)delete process.env[k];else process.env[k]=v;
  await rm(directory,{recursive:true,force:true});
 }
});
