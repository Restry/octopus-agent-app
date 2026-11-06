(async()=>{
 const invoke=window.__TAURI_INTERNALS__.invoke;
 const report=(name,data)=>invoke('desktop_report',{name,data});
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const check=(value,message)=>{if(!value)throw new Error(message);};
 try{
  for(let i=0;i<150&&(!document.documentElement.dataset.desktopReady||!document.querySelectorAll('.octopus-project-hit').length);i++)await pause(100);
  const root=document.querySelector('.octopus-widget'),head=root.querySelector('.octopus-head-hit');
  const buttons=()=>[...root.querySelectorAll('.octopus-project-hit')];
  const initial=await invoke('agent_request',{command:'connections',args:{},onEvent:`__CHANNEL__:${window.__TAURI_INTERNALS__.transformCallback(()=>{})}`});
  check(buttons().length===new Set(initial.map(c=>c.id)).size,'connection count');
  await report('catalog',{ids:buttons().map(b=>b.dataset.connectionId),native:await invoke('desktop_probe')});
  for(const connection of initial){
   const button=buttons().find(b=>b.dataset.connectionId===connection.id);button.click();await pause(400);
   const text=root.querySelector('.octopus-package-list').textContent;
   check(root.querySelector('.octopus-capabilities strong').textContent===`${connection.id} · MCP`,'selected identity');
   check(connection.names.every(name=>text.includes(name)),'missing selected tools');
   check(button.getAttribute('aria-expanded')==='true','expanded state');
   await report('connection',{id:connection.id,tools:connection.names.length,connected:connection.connected});
  }
  root.querySelector('.octopus-dismiss').click();await pause(400);
  for(const key of ['ArrowRight','ArrowLeft']){root.querySelector('.octopus-resize').dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));await pause(400);}
  const bounds=buttons().map(button=>{const r=button.getBoundingClientRect();check(r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,'clipped tentacle');const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);check(hit?.closest('.octopus-project-hit')===button,'DOM hit area');return {id:button.dataset.connectionId,rect:r.toJSON()};});
  await report('native-bounds',{bounds,native:await invoke('desktop_probe'),note:'DOM hit regions only; OS click-through not exercised'});
  head.click();await pause(500);check(!document.querySelector('.agent-panel').hidden,'chat did not open');
  await report('chat-open',{native:await invoke('desktop_probe'),panel:document.querySelector('.agent-panel').getBoundingClientRect().toJSON()});
  head.click();await pause(500);check(document.querySelector('.agent-panel').hidden,'chat did not close');
  const previous=root.dataset.creatureHeight;
  window.dispatchEvent(new Event('octopus:connections-changed'));await pause(800);
  check(buttons().length===new Set(initial.map(c=>c.id)).size&&root.dataset.creatureHeight===previous,'refresh changed directory');
  await report('tentacles-pass',{count:buttons().length,checks:['per-connection click','failed connection retained','keyboard resize','native bounds','DOM hit area','head chat toggle','catalog refresh'],unverified:['OS cursor click-through','physical drag','release direct interaction']});
 }catch(error){await report('smoke-error',{message:String(error)});}
})();
