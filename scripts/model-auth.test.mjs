import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createAgentService,loadConfig,saveConfig} from './agent-service.mjs';

const direct='fixture-direct-model-secret-129837';
const ambient='fixture-ambient-secret-987321';
const base={baseUrl:'https://fixture.example/v1',model:'gpt-4.1-mini'};
const pkg=()=>({id:'menshen',version:'0.4.2',apiVersion:1,runtime:'node',dependencies:{},permissions:[],tools:[],skills:[]});
export function fixtureResponse(text='fixture response') {
  const item={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
  const events=[{type:'response.created',response:{id:'resp_fixture'}},{type:'response.output_item.added',output_index:0,item:{...item,content:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:text},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}
async function setup(t) {
  const dir=await mkdtemp(path.join(process.env.BH_AGENT_WORKSPACE || tmpdir(),'octopus-auth-'));
  const names=['OCTOPUS_DATA_DIR','OCTOPUS_AGENT_DIR','OCTOPUS_MODEL_CONFIG','OCTOPUS_MODEL_BASE_URL','OPENAI_API_KEY','OCTOPUS_API_KEY','OPENAI_ADMIN_KEY','AZURE_OPENAI_API_KEY','OPENAI_LOG'];
  const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  Object.assign(process.env,{OCTOPUS_DATA_DIR:dir,OCTOPUS_AGENT_DIR:path.join(dir,'sessions'),OCTOPUS_MODEL_CONFIG:path.join(dir,'model.json'),OPENAI_API_KEY:ambient,OCTOPUS_API_KEY:ambient,OPENAI_ADMIN_KEY:ambient,AZURE_OPENAI_API_KEY:ambient});
  delete process.env.OCTOPUS_MODEL_BASE_URL;delete process.env.OPENAI_LOG;
  const originalFetch=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async(url,options)=>{
    assert.ok(String(url).startsWith(base.baseUrl));
    requests.push({url:String(url),headers:new Headers(options?.headers),body:options?.body});
    return String(url).endsWith('/models') ? Response.json({data:[{id:base.model}]}) : fixtureResponse();
  };
  t.after(async()=>{globalThis.fetch=originalFetch;for(const [name,value] of Object.entries(old))if(value===undefined)delete process.env[name];else process.env[name]=value;await rm(dir,{recursive:true,force:true});});
  return {dir,requests,service:createAgentService({installedPackages:[pkg]})};
}
async function files(directory) {
  const values=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())values.push(...await files(file));
    else if(entry.name!=='model-api-key')values.push(await readFile(file,'utf8'));
  }
  return values.join('\n');
}

test('direct key save/get/reload, blank edits, endpoint failure and switching sources preserve private bytes',async t=>{
  const {dir,service}=await setup(t);
  await assert.rejects(saveConfig({...base,authRequired:true,credentialSource:'direct'}),/密钥缺失/);
  const response=await service('agent_configure',{confirmEndpoint:true,config:{...base,authRequired:true,credentialSource:'direct',apiKey:direct}});
  assert.equal(response.directKeyPresent,true);assert.ok(!JSON.stringify(response).includes(direct));
  assert.equal((await stat(dir)).mode&0o777,0o700);
  assert.equal((await stat(path.join(dir,'model-api-key'))).mode&0o777,0o600);
  assert.equal((await stat(path.join(dir,'model.json'))).mode&0o777,0o600);
  assert.ok(!JSON.stringify(await loadConfig()).includes(direct));
  assert.ok(!JSON.stringify(await service('agent_config')).includes(direct));
  await saveConfig({model:'gpt-4.1',apiKey:''});
  assert.equal((await loadConfig()).credentialSource,'direct');
  assert.equal((await readFile(path.join(dir,'model-api-key'),'utf8')).trim(),direct);
  await assert.rejects(saveConfig({baseUrl:'http://localhost/v1',apiKey:'fixture-replacement'}),/HTTPS/);
  assert.equal((await readFile(path.join(dir,'model-api-key'),'utf8')).trim(),direct);
  assert.equal((await loadConfig()).baseUrl,base.baseUrl);
  await saveConfig({authRequired:false});
  await saveConfig({authRequired:true,credentialSource:'menshen',credentialRef:'fixture/MODEL_KEY'});
  await saveConfig({credentialSource:'direct',apiKey:''});
  assert.equal((await loadConfig()).credentialSource,'direct');
  assert.ok(!(await files(dir)).includes(direct));
});

test('disabled authentication discards invalid unused references without blocking save',async t=>{
  const {dir}=await setup(t);
  for (const [credentialSource,credentialRef] of [['menshen','unfinished'],['menshen','env/UNUSED'],['env','not-an-env-reference']]) {
    const saved=await saveConfig({...base,authRequired:false,credentialSource,credentialRef});
    assert.equal(saved.authRequired,false);
    assert.equal(saved.credentialRef,undefined);
    assert.equal((await loadConfig()).credentialRef,undefined);
    assert.ok(!(await readFile(path.join(dir,'model.json'),'utf8')).includes(credentialRef));
  }
  await assert.rejects(saveConfig({...base,authRequired:true,credentialSource:'menshen',credentialRef:'unfinished'}),/凭据引用无效/);
  const valid=await saveConfig({...base,authRequired:false,credentialSource:'menshen',credentialRef:'fixture/MODEL_KEY'});
  assert.equal(valid.credentialRef,'fixture/MODEL_KEY');
});

test('all auth modes reach catalog and real Responses request boundary; no-auth ignores ambient secrets',async t=>{
  const {dir,service,requests}=await setup(t);
  const modes=[{authRequired:true,credentialSource:'direct',apiKey:direct}, {authRequired:true,credentialSource:'env',credentialRef:'env/OPENAI_API_KEY'}, {authRequired:false,credentialSource:'direct'}];
  for(const [index,mode] of modes.entries()) {
    await saveConfig({...base,...mode});
    const settings=await service('agent_config');
    assert.equal(settings.authRequired,mode.authRequired);
    const start=requests.length;
    const catalog=await service('agent_models',{refresh:true});assert.ok(catalog.models.includes(base.model));
    const session=await service('agent_session_new');
    const result=await service('agent_run',{id:`fixture-${index}`,sessionId:session.sessionId,intent:'你好'});
    assert.equal(result.error,undefined);assert.match(result.text,/fixture response/);
    const outgoing=requests.slice(start);
    assert.ok(outgoing.some(r=>r.url.endsWith('/models')));assert.ok(outgoing.some(r=>r.url.endsWith('/responses')));
    for(const request of outgoing) {
      if(!mode.authRequired) {
        for(const name of ['authorization','api-key','x-api-key','proxy-authorization'])assert.equal(request.headers.has(name),false);
        assert.ok(!JSON.stringify([...request.headers]).includes(ambient));
      } else assert.equal(request.headers.get('authorization'),`Bearer ${mode.credentialSource==='direct'?direct:ambient}`);
      assert.ok(!request.body?.includes(direct));assert.ok(!request.body?.includes(ambient));
    }
    const history=await service('agent_session_history',{sessionId:session.sessionId});
    assert.ok(!JSON.stringify(history).includes(direct));assert.ok(!JSON.stringify(history).includes(ambient));
  }
  // No-auth must not even resolve the selected reference.
  const noLookup=createAgentService({key:()=>assert.fail('credential lookup in no-auth'),installedPackages:[pkg]});
  await noLookup('agent_models',{refresh:true});
  await noLookup('agent_run',{id:'no-lookup',intent:'你好'});
  assert.ok(!(await files(dir)).includes(direct));assert.ok(!(await files(dir)).includes(ambient));
});

test('legacy file/env and literal Menshen references retain their source across partial saves',async t=>{
  const {dir,requests}=await setup(t);
  await writeFile(path.join(dir,'model-api-key'),direct,{mode:0o600});
  for(const [ref,source] of [['file/model-api-key','direct'],['env/OPENAI_API_KEY','env'],['fixture/MODEL_KEY','menshen']]) {
    await writeFile(path.join(dir,'model.json'),JSON.stringify({...base,credentialRef:ref}),{mode:0o600});
    const reloaded=await loadConfig();assert.equal(reloaded.credentialSource,source);assert.equal(reloaded.authRequired,true);
    await saveConfig({model:'gpt-4.1'});assert.equal((await loadConfig()).credentialRef,ref);
    const service=createAgentService({installedPackages:[pkg],...(source==='menshen'?{key:async key=>{assert.equal(key,ref);return direct;}}:{})});
    await service('agent_models',{refresh:true});
    const result=await service('agent_run',{id:`legacy-${source}`,intent:'你好'});assert.equal(result.error,undefined);
    assert.equal(requests.at(-1).headers.get('authorization'),`Bearer ${source==='env'?ambient:direct}`);
  }
});

test('failed endpoint confirmation and filesystem errors never reflect supplied key',async t=>{
  const {dir,service}=await setup(t);
  await assert.rejects(service('agent_configure',{confirmEndpoint:false,config:{...base,apiKey:direct,credentialSource:'direct'}}),error=>!error.message.includes(direct));
  await mkdir(path.join(dir,'model.json'));
  await assert.rejects(saveConfig({...base,apiKey:direct,credentialSource:'direct'}),error=>!error.message.includes(direct));
  assert.ok(!(await files(dir)).includes(direct));
});

test('no-auth Responses preserves tool execution and second-turn tool results without auth',async t=>{
  const {requests}=await setup(t);
  await saveConfig({...base,authRequired:false,credentialSource:'menshen'});
  let calls=0, executed=0;
  const service=createAgentService({key:()=>assert.fail('no-auth looked up a key'),installedPackages:[()=>({...pkg(),tools:[{name:'fixture_echo',label:'fixture_echo',description:'Controlled local fixture',parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{executed++;return {content:[{type:'text',text:'fixture tool result'}]};}}]})]});
  const ordinaryFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(!String(url).endsWith('/responses')||calls++>0)return ordinaryFetch(url,options);
    requests.push({url:String(url),headers:new Headers(options.headers),body:options.body});
    const item={type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'fixture_echo',arguments:'{}',status:'completed'};
    const events=[{type:'response.output_item.added',output_index:0,item:{...item,arguments:''}},{type:'response.function_call_arguments.delta',output_index:0,delta:'{}'},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{status:'completed',output:[item]}}];
    return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  const result=await service('agent_run',{id:'tool-flow',intent:'使用工具检查'});
  assert.equal(result.error,undefined);assert.equal(executed,1);assert.equal(calls,2);
  assert.match(requests.at(-1).body,/function_call_output/);assert.match(requests.at(-1).body,/fixture tool result/);
  for(const request of requests)assert.equal(request.headers.has('authorization'),false);
});

test('direct credential echoes and upstream errors cannot leak to events or history',async t=>{
  const {dir,service}=await setup(t);
  const logs=[],originalConsole={log:console.log,warn:console.warn,error:console.error,debug:console.debug};
  for(const name of Object.keys(originalConsole))console[name]=(...args)=>{logs.push(args.map(String).join(' '));};
  t.after(()=>Object.assign(console,originalConsole));
  await saveConfig({...base,credentialSource:'direct',apiKey:direct});
  globalThis.fetch=async()=>fixtureResponse(direct);
  const session=await service('agent_session_new'),events=[];
  const result=await service('agent_run',{id:'echo-check',sessionId:session.sessionId,intent:'你好'},{onEvent:event=>events.push(event)});
  assert.ok(!JSON.stringify({result,events}).includes(direct));
  globalThis.fetch=async()=>Response.json({error:{message:direct}},{status:401});
  const error=await service('agent_run',{id:'error-check',sessionId:session.sessionId,intent:'你好'});
  assert.equal(error.error,true);assert.ok(!JSON.stringify(error).includes(direct));
  assert.ok(!(await files(dir)).includes(direct));
  assert.ok(!logs.join('\n').includes(direct));
});