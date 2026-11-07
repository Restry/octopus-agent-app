import {mkdir,copyFile,chmod,access,rm,cp,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Only macOS Apple Silicon has been validated.');
const root=fileURLToPath(new URL('../',import.meta.url));
const resources=path.join(root,'desktop/src-tauri/resources');
const runtime=path.join(resources,'runtime');
const env={...process.env,CI:'true'};
// Remap embedded Rust panic/source locations so public binaries do not expose the builder's home.
env.CARGO_ENCODED_RUSTFLAGS=[env.CARGO_ENCODED_RUSTFLAGS,`--remap-path-prefix=${homedir()}=/build/user`].filter(Boolean).join('\x1f');
const key=path.join(homedir(),'.config/octopus-agent-app/updater/release.key');
if(!env.TAURI_SIGNING_PRIVATE_KEY){await access(key);env.TAURI_SIGNING_PRIVATE_KEY=key;env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD='';}
const toolchain=path.join(homedir(),'.rustup/toolchains/stable-aarch64-apple-darwin/bin');
try{await access(path.join(toolchain,'cargo'));env.PATH=`${toolchain}:${path.dirname(process.execPath)}:${env.PATH}`;env.RUSTC=path.join(toolchain,'rustc');}catch{}
const run=(bin,args,cwd=root)=>new Promise((resolve,reject)=>{const child=spawn(bin,args,{cwd,env,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${path.basename(bin)} exited ${code}`)));});
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
console.log(`Building octopus-agent-app ${version} from ${root} for darwin-aarch64`);
await run(process.execPath,[path.join(root,'scripts/release-assets.mjs'),'--capture-source']);
await rm(runtime,{recursive:true,force:true});
await mkdir(path.join(runtime,'scripts'),{recursive:true});
for(const file of ['agent-service.mjs','agent-memory.mjs','agent-provider-diagnostics.mjs','agent-runs.mjs','model-catalog.mjs','model-config.mjs','model-no-auth.mjs','mcp-client.mjs','capability-installer.mjs','server.mjs'])await copyFile(path.join(root,'scripts',file),path.join(runtime,'scripts',file));
await cp(path.join(root,'packages'),path.join(runtime,'packages'),{recursive:true});
await cp(path.join(root,'vendor'),path.join(runtime,'vendor'),{recursive:true});
for(const file of ['package.json','package-lock.json'])await copyFile(path.join(root,file),path.join(runtime,file));
await copyFile(process.execPath,path.join(runtime,'node'));await chmod(path.join(runtime,'node'),0o755);
// Retain the debug runtime location used by the native smoke runner.
await copyFile(process.execPath,path.join(resources,'node'));await chmod(path.join(resources,'node'),0o755);
await run('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],runtime);
// Validate the staged production import closure before native compilation/signing.
await run(path.join(runtime,'node'),['--input-type=module','-e','await import("./scripts/agent-service.mjs"); console.log("Staged runtime import check passed");'],runtime);
await run(path.join(root,'node_modules/.bin/tauri'),['build','--bundles',process.env.OCTOPUS_BUNDLES||'app,dmg'],path.join(root,'desktop'));
await run(process.execPath,[path.join(root,'scripts/release-assets.mjs')]);
