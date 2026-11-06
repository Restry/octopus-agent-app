import {readFile,writeFile,mkdir,copyFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const config=JSON.parse(await readFile(path.join(root,'desktop/src-tauri/tauri.conf.json'),'utf8'));
const cargo=await readFile(path.join(root,'desktop/src-tauri/Cargo.toml'),'utf8');
if(config.version!==version||!cargo.includes(`version = "${version}"`))throw new Error('Version mismatch');
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Only built darwin-aarch64 assets may be published');
const hash=data=>createHash('sha256').update(data).digest('hex');
const sourceFile=path.join(root,'desktop/src-tauri/target/build-source.json');
const snapshot=async()=>{
  const allowlist=JSON.parse(await readFile(path.join(root,'publish-files.json'),'utf8')).files;
  const files={};
  for(const file of [...allowlist].sort())files[file]=hash(await readFile(path.join(root,file)));
  return {files,sourceHash:hash(JSON.stringify(files))};
};
if(process.argv.includes('--capture-source')){
  const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const pub_date=new Date(execFileSync('git',['show','-s','--format=%cI',source],{cwd:root,encoding:'utf8'}).trim()).toISOString();
  await mkdir(path.dirname(sourceFile),{recursive:true});
  await writeFile(sourceFile,JSON.stringify({schema:1,source,pub_date,version,target:'darwin-aarch64',node:process.version,...await snapshot()},null,2)+'\n');
  process.exit(0);
}
// Read provenance captured BEFORE the native build, never relabel an old binary with current HEAD.
const source=JSON.parse(await readFile(sourceFile,'utf8'));
if(source.schema!==1||source.version!==version||source.sourceHash!==(await snapshot()).sourceHash)throw new Error('Source changed since build capture; rebuild native assets');
const out=path.join(root,'release',version);await mkdir(out,{recursive:true});
const bundle=path.join(root,'desktop/src-tauri/target/release/bundle');
const archive=`Octopus_${version}_aarch64.app.tar.gz`;
await copyFile(path.join(bundle,'macos/Octopus.app.tar.gz'),path.join(out,archive));
await copyFile(path.join(bundle,'macos/Octopus.app.tar.gz.sig'),path.join(out,archive+'.sig'));
const files=[archive,archive+'.sig'];
execFileSync('codesign',['--verify','--deep','--strict',path.join(bundle,'macos/Octopus.app')],{stdio:'inherit'});
const dmg=`Octopus_${version}_aarch64.dmg`;
try{await copyFile(path.join(bundle,'dmg',dmg),path.join(out,dmg));files.push(dmg);}catch(e){if(e.code!=='ENOENT')throw e;}
const manifest={version,notes:`Octopus ${version} for macOS Apple Silicon`,pub_date:source.pub_date,platforms:{'darwin-aarch64':{signature:(await readFile(path.join(out,archive+'.sig'),'utf8')).trim(),url:`https://github.com/Restry/octopus-agent-app/releases/download/v${version}/${archive}`}}};
await writeFile(path.join(out,'latest.json'),JSON.stringify(manifest,null,2)+'\n');files.push('latest.json');
await writeFile(path.join(out,'build-source.json'),JSON.stringify(source,null,2)+'\n');files.push('build-source.json');
const sums=[];
for(const file of files){const data=await readFile(path.join(out,file));sums.push(`${hash(data)}  ${file}`);console.log(JSON.stringify({path:path.join(out,file),size:(await stat(path.join(out,file))).size}));}
await writeFile(path.join(out,'SHA256SUMS'),sums.join('\n')+'\n');
