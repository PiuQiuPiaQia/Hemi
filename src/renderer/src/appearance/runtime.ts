import {DEFAULT_APPEARANCE,validSnapshot} from '@shared/appearance/schema.mjs';
import {getSkin} from '@shared/appearance/skins.mjs';
import type {AppearanceBootstrap,AppearanceSnapshot,AppearanceActivity,AppearanceSetResult,SkinId} from '@shared/appearance/types';
import {assetsFor} from './assets';
type State={snapshot:AppearanceSnapshot;activity:AppearanceActivity;initialized:boolean};
const bridge=()=>window.hemiVoice;
const fallback:AppearanceSnapshot={sessionId:'browser-preview',revision:0,preference:{...DEFAULT_APPEARANCE},resolvedMode:'light',recovery:null};
let bootstrap:AppearanceBootstrap|null=null;
try{bootstrap=bridge()?.getAppearanceBootstrap?.()??null;}catch{}
let state:State={snapshot:validSnapshot(bootstrap?.snapshot)?bootstrap.snapshot:fallback,activity:bootstrap?.activity??{visible:!document.hidden,focused:document.hasFocus()},initialized:false};
const listeners=new Set<()=>void>();let generation=0,initialization:Promise<void>|undefined,fixture=false;const disposers:Array<()=>void>=[];
const notify=()=>{for(const listener of listeners)listener();};
export const getAppearanceState=()=>state;
export const subscribeAppearance=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const getAppearanceBootstrap=()=>bootstrap;
const paint=()=>new Promise<void>(resolve=>{let finished=false;const done=()=>{if(finished)return;finished=true;clearTimeout(timer);resolve();};const timer=setTimeout(done,80);requestAnimationFrame(()=>requestAnimationFrame(done));});
async function apply(snapshot:AppearanceSnapshot,authoritative=false){
  if(!validSnapshot(snapshot))return;
  const current=state.snapshot;
  if(snapshot.sessionId!==current.sessionId&&!authoritative)return;
  if(snapshot.sessionId===current.sessionId&&snapshot.revision<current.revision)return;
  if(state.initialized&&snapshot.sessionId===current.sessionId&&snapshot.revision===current.revision){await paint();bridge()?.reportAppearanceApplied?.({sessionId:current.sessionId,revision:current.revision,status:'ready'});return;}
  const id=++generation,skin=getSkin(snapshot.preference.skinId),html=document.documentElement;
  html.dataset.skin=skin.id;html.dataset.colorMode='light';html.style.backgroundColor=html.dataset.window==='main'?skin.windowBackground:'transparent';
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content',skin.windowBackground);
  state={...state,snapshot,initialized:true};html.dataset.appearanceReady='true';notify();
  let status:'ready'|'degraded'='ready';const asset=assetsFor(skin.id);
  if(asset&&html.dataset.window==='main'){
    const image=new Image();image.src=asset.image;
    try{await Promise.race([image.decode(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Image preparation timeout')),120))]);}catch{status='degraded';}
  }
  await paint();if(id!==generation)return;
  bridge()?.reportAppearanceApplied?.({sessionId:snapshot.sessionId,revision:snapshot.revision,status});
}
export function initializeAppearance(options:{fixtureSkin?:SkinId}={}){
  return initialization??=(async()=>{
    fixture=!!options.fixtureSkin&&!bootstrap;
    if(fixture)state={...state,snapshot:{...fallback,preference:{...DEFAULT_APPEARANCE,skinId:options.fixtureSkin!}}};
    const off=bridge()?.onAppearanceChanged?.(next=>{
      if(next.sessionId===state.snapshot.sessionId)void apply(next);
      else void bridge()?.getAppearance?.().then(snapshot=>apply(snapshot,true)).catch(()=>{});
    });if(off)disposers.push(off);
    const offActivity=bridge()?.onAppearanceActivity?.(activity=>{state={...state,activity};notify();});if(offActivity)disposers.push(offActivity);
    await apply(state.snapshot,true);
    if(bootstrap)void bridge()?.getAppearance?.().then(snapshot=>apply(snapshot,true)).catch(()=>{});
  })();
}
export async function chooseSkin(skinId:SkinId):Promise<AppearanceSetResult>{
  const request={requestId:crypto.randomUUID(),skinId,mode:'light' as const};let result:AppearanceSetResult;
  if(fixture){const snapshot={...state.snapshot,preference:{...DEFAULT_APPEARANCE,skinId},revision:state.snapshot.revision+1};result={ok:true,requestId:request.requestId,changed:true,snapshot};}
  else if(bridge()?.setAppearance)result=await bridge().setAppearance(request);
  else result={ok:false,requestId:request.requestId,code:'SAVE_FAILED',snapshot:state.snapshot};
  await apply(result.snapshot);return result;
}
export function reportVisualReady(){const snapshot=state.snapshot;bridge()?.reportAppearanceVisualReady?.({sessionId:snapshot.sessionId,revision:snapshot.revision,status:'ready'});}
export function disposeAppearance(){generation++;for(const off of disposers.splice(0))off();listeners.clear();}
import.meta.hot?.dispose(disposeAppearance);
