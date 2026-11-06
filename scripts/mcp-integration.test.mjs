import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {Type} from 'typebox';
import {connectMcp,createMcpPackage,callMcp,connectionStatus} from './mcp-client.mjs';

test('MCP authenticates, preserves optional parameters, redacts auth echoes, and rejects unlisted tools',async()=>{
 const secret='fixture-only-authentication-"token\\with-escape';const transports=new Set();
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});res.end();return;}
  if(req.headers.authorization!==`Bearer ${secret}`){res.writeHead(401);res.end();return;}
  let body='';for await(const chunk of req)body+=chunk;
  const mcp=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',description:'fixture',inputSchema:{type:'object',properties:{query:{type:'string'}},additionalProperties:false}}]}));
  mcp.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:JSON.stringify({echo:secret})}]}));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});transports.add(transport);res.once('close',()=>{transports.delete(transport);void transport.close();void mcp.close();});await mcp.connect(transport);await transport.handleRequest(req,res,JSON.parse(body));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  assert.equal((await connectMcp('denied',{type:'http',url,headers:{Authorization:'Bearer wrong'}})).connected,false);
  assert.equal((await connectMcp('fixture',{type:'http',url,headers:{Authorization:`Bearer ${secret}`}})).connected,true);
  assert.equal(connectionStatus().find(c=>c.id==='fixture').tools,1);
  const pkg=createMcpPackage({tool:(name,description,props)=>({name,parameters:Type.Object(props)})});
  assert.deepEqual(pkg.tools.find(t=>t.name==='fixture__echo').parameters.required,undefined);
  assert.equal(JSON.parse((await callMcp('fixture','echo',{})).content[0].text).echo,'[已隐藏]');
  await assert.rejects(callMcp('fixture','unlisted',{}),/MCP_TOOL_UNAVAILABLE/);
 }finally{for(const transport of transports)await transport.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
