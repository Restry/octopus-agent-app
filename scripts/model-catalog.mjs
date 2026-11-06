import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename, lstat, rm } from 'node:fs/promises';

const ttl = 10 * 60 * 1000;
const caches = new Map();
// Native launches short-lived sidecars: persist only model IDs and freshness, never credentials.
export async function modelCatalog(settings, refresh, fetchModels) {
  const directory = process.env.OCTOPUS_DATA_DIR || path.join(homedir(), 'Library/Application Support/Octopus');
  const identity = createHash('sha256').update(JSON.stringify([settings.baseUrl, settings.credentialRef])).digest('hex');
  const cacheKey = `${directory}:${identity}`;
  let entry = caches.get(cacheKey);
  if (!entry) {
    entry = {};
    caches.set(cacheKey, entry);
    entry.initializing = (async () => {
      try {
        const folder = path.join(directory, 'model-catalog');
        if ((await lstat(folder)).isSymbolicLink()) throw new Error();
        const filename = path.join(folder, identity + '.json');
        if ((await lstat(filename)).isSymbolicLink()) throw new Error();
        const saved = JSON.parse(await readFile(filename, 'utf8'));
        if (Number.isFinite(saved.at) && saved.at <= Date.now() && Array.isArray(saved.models) && saved.models.length && saved.models.every(id => typeof id === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(id))) Object.assign(entry, saved);
      } catch { /* A missing cache only causes a catalog fetch. */ }
    })();
  }
  await entry.initializing;
  if (entry.inflight) return {models:await entry.inflight,current:settings.model};
  if (!refresh && entry.models && Date.now() - entry.at < ttl) return {models:entry.models,current:settings.model};
  entry.inflight = (async () => {
    const models = await fetchModels();
    const at = Date.now();
    // Failed refreshes leave the last successful list untouched.
    entry.models = models;
    entry.at = at;
    try {
      const folder = path.join(directory, 'model-catalog');
      await mkdir(folder,{recursive:true,mode:0o700});
      if ((await lstat(folder)).isSymbolicLink()) throw new Error();
      const filename = path.join(folder, identity + '.json');
      const pending = `${filename}.${process.pid}.pending`;
      try {
        await writeFile(pending,JSON.stringify({models,at}),{mode:0o600,flag:'wx'});
        await rename(pending,filename);
      } finally { await rm(pending,{force:true}); }
    } catch { /* Memory caching remains valid if optional persistence is unavailable. */ }
    return models;
  })();
  try { return {models:await entry.inflight,current:settings.model}; }
  finally { delete entry.inflight; }
}
