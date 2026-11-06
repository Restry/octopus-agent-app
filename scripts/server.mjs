import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createAgentService} from './agent-service.mjs';
import {initializeConnections,connectionStatus,closeConnections} from './mcp-client.mjs';
import {VaultError} from './model-config.mjs';
const port=Number(process.env.OCTOPUS_PORT||43917);
const token=process.env.OCTOPUS_BRIDGE_TOKEN||randomBytes(32).toString('hex');
await initializeConnections();
const agent=createAgentService();
const dist=fileURLToPath(new URL('../desktop/dist/',import.meta.url));
const server=http.createServer(async(req,res)=>{
 const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${port}`||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'请求被拒绝'});
 if(req.method==='GET'&&req.url==='/health')return send(200,{ready:true});
 if(req.method==='POST'&&/^\/api\/[a-z_]+$/.test(req.url)){
  const auth=req.headers.authorization||'';const expected=`Bearer ${token}`;if(Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected)))return send(401,{error:'原生桥认证失败'});
  let body='',size=0;try{for await(const chunk of req){size+=chunk.length;if(size>65536)return send(413,{error:'请求过长'});body+=chunk;}const args=JSON.parse(body||'{}'),command=req.url.slice(5);
   if(command==='connections'){const catalog=await agent('agent_packages');const enabled=catalog.packages.some(p=>p.id==='menshen');return send(200,{result:connectionStatus().map(c=>({...c,enabled:c.connected&&enabled}))});}
   if(command==='vault_metadata')return send(200,{result:{keys:[]}});
   if(args.credentials) return send(403,{error:'此独立版通过只读门神 MCP 工作；请在门神管理凭据'});
   if(command==='agent_run'){res.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'});const result=await agent(command,args,{onEvent:e=>{if(!res.destroyed)res.write(JSON.stringify(e)+'\n');}});if(!res.destroyed)res.end(JSON.stringify({id:args.id,type:'done',result})+'\n');}
   else send(200,{result:await agent(command,args)});
  }catch(error){const known=error instanceof VaultError;const message=known?error.message:'本地服务请求失败';if(res.headersSent)res.end(JSON.stringify({type:'error',error:message})+'\n');else send(known?error.status:500,{error:message});}return;
 }
 if(req.method!=='GET')return send(404,{error:'未知请求'});
 try{const file=req.url==='/'?'index.html':decodeURIComponent(req.url.slice(1));const target=path.resolve(dist,file);if(!target.startsWith(dist))throw new Error();const content=await readFile(target);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream'});res.end(content);}catch{send(404,{error:'未找到资源'});}
});
server.listen(port,'127.0.0.1',()=>console.log(`Octopus service ready http://127.0.0.1:${port} PID ${process.pid}`));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await closeConnections();server.close(()=>process.exit());});
// Only the native launcher owns this pipe; standalone servers may have closed stdin.
if(process.env.OCTOPUS_DESKTOP_PARENT==='1'){
 process.stdin.once('end',()=>process.kill(process.pid,'SIGTERM'));
 process.stdin.resume();
}
