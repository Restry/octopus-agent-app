import {invoke} from '@tauri-apps/api/core';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {PhysicalPosition} from '@tauri-apps/api/dpi';
import {native} from './platform';
export async function mountDesktop(){
 if(!native)return;
 const root=document.querySelector<HTMLElement>('.octopus-widget')!;
 const panel=document.querySelector<HTMLElement>('.agent-panel')!;
 const details=document.querySelector<HTMLElement>('.octopus-capabilities')!;
 document.documentElement.classList.add('native-desktop');
 let width=280,mode='',ignore=false,gesture:{x:number;y:number;resizing:boolean;width:number;dragged:boolean}|undefined;
 let applyingUntil=0,suppressUntil=0;
 const layout=(capture=false)=>{const next=!panel.hidden?'chat':!details.hidden?'tools':'compact';mode=next;chain=chain.catch(()=>{}).then(async()=>{applyingUntil=Date.now()+700;const g=await invoke<{width:number;petHeight:number}>('desktop_layout',{mode:next,width,creatureHeight:Number(root.dataset.creatureHeight||174),capture});width=g.width;document.documentElement.style.setProperty('--pet-width',`${width}px`);document.documentElement.style.setProperty('--pet-height',`${g.petHeight}px`);});return chain;};
 let chain=Promise.resolve();
 await layout();
 new MutationObserver(()=>{const next=!panel.hidden?'chat':!details.hidden?'tools':'compact';if(next!==mode)void layout();}).observe(panel,{attributes:true,attributeFilter:['hidden']});
 new MutationObserver(()=>{const next=!panel.hidden?'chat':!details.hidden?'tools':'compact';if(next!==mode)void layout();}).observe(details,{attributes:true,attributeFilter:['hidden']});
 window.addEventListener('octopus:geometry-changed',()=>{void layout();});
 document.addEventListener('keydown',e=>{if(!(e.target as Element).closest('.octopus-head-hit,.octopus-project-hit')||e.altKey||e.ctrlKey||e.metaKey)return;const direction:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};const delta=direction[e.key];if(!delta)return;e.preventDefault();e.stopImmediatePropagation();void chain.then(async()=>{const win=getCurrentWindow(),position=await win.outerPosition(),scale=await win.scaleFactor(),step=(e.shiftKey?40:10)*scale;await win.setPosition(new PhysicalPosition(position.x+delta[0]*step,position.y+delta[1]*step));await layout(true);});},true);
 document.addEventListener('pointerdown',e=>{if(!(e.target as Element).closest('.octopus-card')||e.button!==0)return;e.stopImmediatePropagation();gesture={x:e.screenX,y:e.screenY,resizing:!!(e.target as Element).closest('.octopus-resize'),width,dragged:false};(e.target as Element).setPointerCapture(e.pointerId);},true);
 document.addEventListener('pointermove',e=>{if(!gesture)return;e.stopImmediatePropagation();const dx=e.screenX-gesture.x,dy=e.screenY-gesture.y;if(Math.hypot(dx,dy)<6&&!gesture.dragged)return;gesture.dragged=true;suppressUntil=Date.now()+500;if(gesture.resizing){width=Math.max(180,Math.min(400,gesture.width+dx));void layout();}else{gesture=undefined;void getCurrentWindow().startDragging();}},true);
 document.addEventListener('pointerup',e=>{if(!gesture)return;const dragged=gesture.dragged;gesture=undefined;if(dragged){e.preventDefault();e.stopImmediatePropagation();}},true);
 document.addEventListener('click',e=>{if(e.detail&&Date.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}},true);
 root.querySelector('.octopus-resize')!.addEventListener('keydown',e=>{const event=e as KeyboardEvent;const direction=['ArrowUp','ArrowRight','+','='].includes(event.key)?1:['ArrowDown','ArrowLeft','-'].includes(event.key)?-1:0;if(direction){event.preventDefault();event.stopImmediatePropagation();width=Math.max(180,Math.min(400,width+direction*10));void layout();}},true);
 let movedTimer:number;await getCurrentWindow().onMoved(()=>{if(Date.now()<applyingUntil)return;clearTimeout(movedTimer);movedTimer=window.setTimeout(()=>{void layout(true);},250);});
 // Query the OS cursor even while click-through is active. SVG painted paths and controls
 // determine native hit testing, so transparent pixels do not capture desktop clicks.
 let polling=false;setInterval(async()=>{if(polling)return;polling=true;try{const [x,y]=await invoke<[number,number]>('desktop_cursor');const element=document.elementFromPoint(x,y);const next=!element||element===document.body||element===document.documentElement;if(next!==ignore){await invoke('desktop_ignore',{ignore:next});ignore=next;}}finally{polling=false;}},50);
 const head=root.querySelector<HTMLButtonElement>('.octopus-head-hit')!;head.setAttribute('aria-label','章鱼脑袋：展开聊天；按住拖动桌面窗口');head.onclick=()=>{if(panel.hidden)window.dispatchEvent(new Event('menshen:open-agent'));else panel.querySelector<HTMLButtonElement>('[aria-label="关闭助手"]')?.click();};
 details.addEventListener('click',()=>{if(!details.hidden&&!panel.hidden){panel.hidden=true;void layout();}});
 root.addEventListener('click',e=>{if((e.target as Element).closest('.octopus-project-hit')&&!details.hidden){panel.hidden=true;void layout();}});
 document.documentElement.dataset.desktopReady='true';
}
