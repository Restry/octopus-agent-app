import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {createAgentService,loadConfig,saveConfig} from './agent-service.mjs';
import {AgentRuns} from './agent-runs.mjs';

test('public configuration reads backend-only credentials and updates never interrupt active runs',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'octopus-public-'));
  const names=['OCTOPUS_DATA_DIR','OCTOPUS_AGENT_DIR','OCTOPUS_MODEL_CONFIG','OCTOPUS_MODEL_BASE_URL','OCTOPUS_MODEL','OCTOPUS_API_KEY'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  process.env.OCTOPUS_DATA_DIR=directory;process.env.OCTOPUS_AGENT_DIR=path.join(directory,'sessions');process.env.OCTOPUS_MODEL_CONFIG=path.join(directory,'model.json');delete process.env.OCTOPUS_MODEL_BASE_URL;
  const credential='fixture-model-key-backend-only';
  let release,started;const entering=new Promise(resolve=>{started=resolve;});
  const service=createAgentService({modelStream:(model,context,options)=>{
    assert.equal(options.apiKey,credential);
    const stream=createAssistantMessageEventStream();
    release=()=>{const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:'public model configured'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};stream.push({type:'done',reason:'stop',message});stream.end(message);};
    started();return stream;
  }});
  try {
    await assert.rejects(loadConfig(),/配置文件不存在/);
    const config={baseUrl:'https://api.openai.com/v1',model:'gpt-4.1-mini',credentialRef:'file/model-api-key'};
    await assert.rejects(service('agent_configure',{config}),/确认/);
    await writeFile(path.join(directory,'model-api-key'),credential,{mode:0o600});
    assert.deepEqual(await service('agent_configure',{config,confirmEndpoint:true}),{...config,authRequired:true,credentialSource:'direct',directKeyPresent:true});
    assert.equal((await lstat(process.env.OCTOPUS_MODEL_CONFIG)).mode&0o777,0o600);
    assert.equal(JSON.stringify(await service('agent_config')).includes(credential),false);
    await assert.rejects(saveConfig({...config,baseUrl:'http://127.0.0.1/v1'}));
    await service('agent_update_lock',{locked:true});
    await assert.rejects(service('agent_run',{id:'blocked',intent:'hello'}),/更新安装中/);
    await service('agent_update_lock',{locked:false});
    const {sessionId}=await service('agent_session_new');
    const running=service('agent_run',{id:'running',sessionId,intent:'hello'});
    await entering;
    assert.equal((await service('agent_update_status')).busy,true);
    await assert.rejects(service('agent_update_lock',{locked:true}),/正忙/);
    await assert.rejects(service('agent_configure',{config,confirmEndpoint:true}),/正忙/);
    release();const reply=await running;assert.equal(reply.error,undefined);assert.equal(reply.text,'public model configured');
    assert.equal((await service('agent_update_status')).busy,false);
    assert.equal((await readFile(path.join(directory,'sessions',sessionId+'.jsonl'),'utf8')).includes(credential),false);
    process.env.OCTOPUS_MODEL_BASE_URL='https://api.openai.com/v1';process.env.OCTOPUS_API_KEY=credential;process.env.OCTOPUS_MODEL='gpt-4.1-mini';
    assert.equal((await loadConfig()).credentialRef,'env/OCTOPUS_API_KEY');
    assert.equal(JSON.stringify(await loadConfig()).includes(credential),false);
  } finally {
    release?.();for(const name of names)if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];
    await rm(directory,{recursive:true,force:true});
  }
});

test('missing model configuration and credentials remain actionable after run recovery',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'octopus-missing-model-'));
  const names=['OCTOPUS_DATA_DIR','OCTOPUS_AGENT_DIR','OCTOPUS_MODEL_CONFIG','OCTOPUS_MODEL_BASE_URL'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  process.env.OCTOPUS_DATA_DIR=directory;process.env.OCTOPUS_AGENT_DIR=path.join(directory,'sessions');process.env.OCTOPUS_MODEL_CONFIG=path.join(directory,'model.json');delete process.env.OCTOPUS_MODEL_BASE_URL;
  try {
    const service=createAgentService();
    const {sessionId}=await service('agent_session_new');
    for(const [id,expected] of [['missing-config','指定的模型配置文件不存在'],['missing-key','模型密钥缺失或权限不安全：请创建权限 600 的本机 model-api-key 文件']]) {
      await assert.rejects(service('agent_run',{id,sessionId,intent:'你好'}),error=>error.status===503&&error.message===expected);
      const recovered=await service('agent_session_open',{sessionId});
      assert.equal(recovered.run.state,'failed');
      assert.equal(recovered.run.error,expected);
      assert.equal(recovered.messages.length,0);
      if(id==='missing-config') await writeFile(process.env.OCTOPUS_MODEL_CONFIG,JSON.stringify({baseUrl:'https://api.openai.com/v1',model:'gpt-4.1-mini',credentialRef:'file/model-api-key'}),{mode:0o600});
    }
    const runs=new AgentRuns(path.join(directory,'sessions'));
    const projection=runs.start(sessionId,'unknown-error',{messages:[],activities:[],nextCursor:null});
    await projection.finish(undefined,Object.assign(new Error('private backend diagnostic'),{status:503}));
    const recovered=await runs.read(sessionId);
    assert.equal(recovered.state,'failed');
    assert.equal(recovered.error,'执行失败，请检查配置及已完成操作。');
    assert.equal(JSON.stringify(recovered).includes('private backend diagnostic'),false);
  } finally {
    for(const name of names)if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];
    await rm(directory,{recursive:true,force:true});
  }
});
