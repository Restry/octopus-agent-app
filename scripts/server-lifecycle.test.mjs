import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const serverFile=fileURLToPath(new URL('./server.mjs',import.meta.url));
async function until(check){
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){if(await check())return;await delay(50);}
 assert.fail('backend lifecycle transition timed out');
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};

test('native parent death releases the backend port and closes stdio MCP children before relaunch',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'octopus-lifecycle-'));
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const env={...process.env,OCTOPUS_PORT:String(port),OCTOPUS_DATA_DIR:directory,OCTOPUS_AGENT_DIR:path.join(directory,'sessions'),OCTOPUS_MODEL_CONFIG:path.join(directory,'model.json'),OCTOPUS_DESKTOP_PARENT:'1'};
 const fixture=path.join(directory,'mcp.mjs'),pidFile=path.join(directory,'mcp.pid');
 await writeFile(fixture,`import {writeFileSync} from 'node:fs';import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};import {ListToolsRequestSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const server=new Server({name:'lifecycle-fixture',version:'1'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));await server.connect(new StdioServerTransport());`);
 await writeFile(path.join(directory,'mcp-installed.json'),JSON.stringify({lifecycle:{type:'stdio',command:process.execPath,args:[fixture]}}),{mode:0o600});
 const parents=[],backends=[],mcpChildren=[];
 const ready=async()=>{try{return (await fetch(`http://127.0.0.1:${port}/health`)).ok;}catch{return false;}};
 try{
  for(const signal of ['SIGKILL','SIGTERM']){
   const parent=spawn(process.execPath,['--input-type=module','-e',`import {spawn} from 'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(serverFile)}],{stdio:['pipe','inherit','inherit']});process.send(child.pid);`],{env,stdio:['ignore','pipe','pipe','ipc']});
   parents.push(parent);
   let diagnostics='';parent.stdout.on('data',chunk=>{diagnostics+=chunk;});parent.stderr.on('data',chunk=>{diagnostics+=chunk;});
   const [pid]=await once(parent,'message');backends.push(pid);
   try{await until(async()=>{assert.equal(parent.exitCode,null,diagnostics);assert.ok(alive(pid),diagnostics);return ready();});}catch(error){assert.fail(`${error.message}\n${diagnostics}`);}
   const mcpPid=Number(await readFile(pidFile,'utf8'));mcpChildren.push(mcpPid);assert.ok(alive(mcpPid));
   const exited=once(parent,'exit');parent.kill(signal);await exited;
   await until(()=>!alive(pid)&&!alive(mcpPid));
   assert.equal(await ready(),false);
  }
 }finally{
  for(const child of parents)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  for(const pid of [...backends,...mcpChildren])if(alive(pid))process.kill(pid,'SIGKILL');
  await rm(directory,{recursive:true,force:true});
 }
});

test('standalone server stays ready with closed stdin and still exits on SIGTERM',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'octopus-standalone-'));
 const env={...process.env,OCTOPUS_PORT:'0',OCTOPUS_DATA_DIR:directory,OCTOPUS_AGENT_DIR:path.join(directory,'sessions'),OCTOPUS_MODEL_CONFIG:path.join(directory,'model.json')};delete env.OCTOPUS_DESKTOP_PARENT;
 const child=spawn(process.execPath,[serverFile],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output+=chunk;});
 child.stderr.on('data',chunk=>{output+=chunk;});
 try{
  await until(()=>{assert.equal(child.exitCode,null,output);return output.includes('Octopus service ready');});
  await delay(150);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
  const exited=once(child,'exit');child.kill('SIGTERM');const [code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  await rm(directory,{recursive:true,force:true});
 }
});
