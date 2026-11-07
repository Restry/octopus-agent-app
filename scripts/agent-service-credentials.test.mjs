import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,chmod} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createAgentService} from './agent-service.mjs';

const finderPath='/usr/bin:/bin:/usr/sbin:/sbin';
const credentialRef='fixture/--literal.key';
const fixtureValue='fixture-only-local-cli-output';

async function fixture(t) {
  const directory=await mkdtemp(path.join(process.env.BH_AGENT_WORKSPACE || tmpdir(),'octopus-local-cli-fixture-'));
  const home=path.join(directory,'home');
  await mkdir(path.join(home,'.local/bin'),{recursive:true});
  await symlink(process.execPath,path.join(home,'.local/bin/octopus-fixture-node'));
  const cli=path.join(directory,'vault fixture; exit 29');
  const record=path.join(directory,'invocation.json');
  await writeFile(cli,`#!/usr/bin/env octopus-fixture-node
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),path:process.env.PATH,directory:process.env.VAULT_DIR,identity:process.env.VAULT_IDENTITY}));
process.stdout.write(${JSON.stringify(fixtureValue+'\n')});
`,{mode:0o700});
  const env={HOME:home,PATH:finderPath+':relative-bin::/usr/bin',MENSHEN_VAULT_CLI:cli,VAULT_DIR:path.join(directory,'selected-vault'),VAULT_IDENTITY:path.join(directory,'selected-identity'),OCTOPUS_DATA_DIR:path.join(directory,'data'),OCTOPUS_AGENT_DIR:path.join(directory,'sessions'),OCTOPUS_MODEL_CONFIG:path.join(directory,'model.json')};
  const previous=Object.fromEntries(Object.keys(env).map(name=>[name,process.env[name]]));
  Object.assign(process.env,env);
  t.after(async()=>{
    for(const [name,value] of Object.entries(previous)) if(value===undefined) delete process.env[name]; else process.env[name]=value;
    await rm(directory,{recursive:true,force:true});
  });
  const run=async()=>{
    const controller=new AbortController();
    const service=createAgentService({
      config:async()=>{controller.abort();return {baseUrl:'https://api.openai.com/v1',model:'gpt-4.1-mini',credentialRef};},
      installedPackages:[()=>({id:'menshen',version:'0.4.2',apiVersion:1,runtime:'node',dependencies:{},permissions:[],tools:[],skills:[]})],
      modelStream:()=>assert.fail('fixture must stop before model startup'),
    });
    // Cancellation is checked immediately after the real privateGet completes.
    // It provides a bootstrap checkpoint without a model, provider or network call.
    await service('agent_run',{id:'fixture-run',intent:'你好'},{signal:controller.signal});
  };
  return {directory,home,cli,record,env,run};
}

test('fixture: local CLI bootstraps with minimal Finder PATH before model startup',async t=>{
  const f=await fixture(t);
  await assert.rejects(new Promise((resolve,reject)=>execFile(f.cli,['get',credentialRef],{env:{...process.env,PATH:finderPath}},error=>error?reject(error):resolve())),error=>Number.isInteger(error.code));
  await assert.rejects(f.run(),error=>error.status===409&&error.message==='已取消');
  const recorded=JSON.parse(await readFile(f.record,'utf8'));
  assert.deepEqual(recorded.args,['get',credentialRef]);
  assert.equal(recorded.directory,f.env.VAULT_DIR);
  assert.equal(recorded.identity,f.env.VAULT_IDENTITY);
  assert.equal(recorded.path.split(path.delimiter)[0],path.join(f.home,'.local/bin'));
  assert.ok(recorded.path.split(path.delimiter).every(p=>path.isAbsolute(p)));
  assert.equal(new Set(recorded.path.split(path.delimiter)).size,recorded.path.split(path.delimiter).length);
});

test('fixture: trusted CLI safe launch, permission, exit, empty-output and timeout failures',async t=>{
  const f=await fixture(t);
  const check=async(pattern)=>assert.rejects(f.run(),error=>{
    assert.equal(error.status,503);
    assert.match(error.message,pattern);
    for(const value of [fixtureValue,credentialRef,f.cli])assert.ok(!error.message.includes(value));
    return true;
  });
  process.env.MENSHEN_VAULT_CLI=path.join(f.directory,'missing');
  await check(/ENOENT/);
  process.env.MENSHEN_VAULT_CLI=f.cli;
  await chmod(f.cli,0o600);await check(/权限不足/);
  await chmod(f.cli,0o700);
  await writeFile(f.cli,`#!/usr/bin/env octopus-fixture-node\nprocess.stderr.write(${JSON.stringify(fixtureValue)});process.exit(23);`);
  await check(/非零退出/);
  await writeFile(f.cli,'#!/usr/bin/env octopus-fixture-node\nprocess.stdout.write(" ");');
  await check(/未返回密钥/);
  await writeFile(f.cli,'#!/usr/bin/env octopus-fixture-node\nsetInterval(()=>{},1000);');
  await check(/超时/);
});
