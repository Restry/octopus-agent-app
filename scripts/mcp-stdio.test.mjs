import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,lstat,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAgentService} from './agent-service.mjs';
import {validateMcp,callMcp,connectionStatus,initializeConnections,closeConnections} from './mcp-client.mjs';
test('stdio requires current consent, keeps secrets out of references, persists privately and closes child processes',async()=>{
 const directory=await realpath(await mkdtemp(path.join(tmpdir(),'octopus-stdio-')));
 const before=Object.fromEntries(['OCTOPUS_DATA_DIR','OCTOPUS_AGENT_DIR','STDIO_PARENT_SECRET'].map(k=>[k,process.env[k]]));
 Object.assign(process.env,{OCTOPUS_DATA_DIR:directory,OCTOPUS_AGENT_DIR:path.join(directory,'sessions'),STDIO_PARENT_SECRET:'parent-secret-must-not-inherit'});
 const serverFile=path.join(directory,'server.mjs'),secret='explicit-fixture-auth-secret',argSecret='argument-fixture-secret';
 await writeFile(serverFile,`import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};const server=new Server({name:'stdio-fixture',version:'1'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'inspect',inputSchema:{type:'object',properties:{}}}]}));server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:JSON.stringify({pid:process.pid,parent:!!process.env.STDIO_PARENT_SECRET,auth:process.env.FIXTURE_AUTH,arg:process.argv.at(-1)})}]}));await server.connect(new StdioServerTransport());`);
 const service=createAgentService({config:async()=>{throw new Error('no model configured');}});
 const {sessionId}=await service('agent_session_new');
 const installation={kind:'mcp',id:'stdio_fixture',config:{command:process.execPath,args:[serverFile,argSecret],env:{FIXTURE_AUTH:secret}}};
 const prepare=extra=>service('agent_prepare_install',{instruction:'请添加 MCP',installation,sessionId,...extra});
 try{
  await assert.rejects(prepare(),/授权/);
  for(const command of ['sh','/bin/zsh','npx','npm','uvx'])assert.throws(()=>validateMcp('unsafe',{command,args:['-c','echo forbidden']}));
  await assert.rejects(service('agent_install_prepared',{requestId:'0123456789abcdef',sessionId,intent:'模型生成命令'}));
  const request=await prepare({confirmCommand:true});assert.equal(JSON.stringify(request).includes(secret),false);assert.equal(JSON.stringify(request).includes(argSecret),false);
  await assert.rejects(service('agent_install_prepared',{...request,sessionId:'wrong-session'}));
  assert.equal((await service('agent_install_prepared',{...request,sessionId})).connected,true);
  assert.equal((await lstat(path.join(directory,'mcp-installed.json'))).mode&0o777,0o600);
  const reply=await callMcp('stdio_fixture','inspect',{}),data=JSON.parse(reply.content[0].text);
  assert.equal(data.parent,false);assert.equal(data.auth,'[已隐藏]');assert.equal(data.arg,'[已隐藏]');
  await closeConnections();assert.throws(()=>process.kill(data.pid,0));
  await initializeConnections();assert.equal(connectionStatus().find(c=>c.id==='stdio_fixture').connected,true);
  const second=JSON.parse((await callMcp('stdio_fixture','inspect',{})).content[0].text);assert.notEqual(second.pid,data.pid);
  const history=await service('agent_session_history',{sessionId});assert.equal(JSON.stringify(history).includes(secret),false);
  assert.ok((await readFile(path.join(directory,'mcp-installed.json'),'utf8')).includes(secret));
  await closeConnections();assert.throws(()=>process.kill(second.pid,0));
 }finally{await closeConnections();for(const [k,v] of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;await rm(directory,{recursive:true,force:true});}
});
