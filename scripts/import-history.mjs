import {readdir,lstat,readFile,writeFile,mkdir,copyFile,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import path from 'node:path';
const source=path.join(homedir(),'.menshen-agent/sessions');
const target=path.join(homedir(),'Library/Application Support/Octopus/sessions');
await mkdir(target,{recursive:true,mode:0o700});
let copied=0,existing=0;const checks=[];
for(const name of await readdir(source)){
 if(!/^[a-f0-9-]{36}\.(jsonl|run\.json)$/.test(name))continue;
 const file=path.join(source,name);const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())continue;
 const before=createHash('sha256').update(await readFile(file)).digest('hex');
 try{await copyFile(file,path.join(target,name),constants.COPYFILE_EXCL);await chmod(path.join(target,name),0o600);copied++;}catch(error){if(error.code!=='EEXIST')throw error;existing++;}
 const after=createHash('sha256').update(await readFile(file)).digest('hex');if(before!==after)throw new Error('SOURCE_CHANGED_DURING_SNAPSHOT');checks.push({name,sha256:before});
}
await writeFile(path.join(target,'legacy-import-manifest.json'),JSON.stringify({source,createdAt:new Date().toISOString(),checks}),{mode:0o600});
console.log(JSON.stringify({copied,existing,sourceFilesVerified:checks.length,mode:'exclusive snapshot; source unchanged; legacy memory not imported'}));
