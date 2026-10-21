import {pathToFileURL} from 'node:url';
import {getAppearanceService,onAppearanceCommit} from '../services/appearance-instance.mjs';
import {getSkin} from '../../shared/appearance/skins.mjs';
import {IPC} from '../../shared/ipc-channels.mjs';
import {isSmokeTest} from '../state.mjs';
import {createLogger} from '../lib/logger.mjs';
const entries=new Map(),log=createLogger('appearance');
const activity=entry=>({visible:entry.window.isVisible()&&!entry.window.isMinimized(),focused:entry.window.isFocused()});
function matches(entry){const s=getAppearanceService().getSnapshot();return entry.applied?.sessionId===s.sessionId&&entry.applied.revision===s.revision;}
function flush(entry){
  if(!entry.nativeReady||!entry.visualReady||!matches(entry))return;
  for(const resolve of entry.waiters)resolve(true);entry.waiters.clear();
  if(entry.show){const show=entry.show;entry.show=null;show();}
}
const sendSnapshot=entry=>{if(!entry.window.isDestroyed())entry.window.webContents.send(IPC.appearance.changed,getAppearanceService().getSnapshot());};
onAppearanceCommit(snapshot=>{
  for(const entry of entries.values()){
    if(entry.window.isDestroyed())continue;
    if(entry.mode==='main')entry.window.setBackgroundColor(getSkin(snapshot.preference.skinId).windowBackground);
    try{entry.window.webContents.send(IPC.appearance.changed,snapshot);}catch{log.warn('外观窗口广播失败');}
  }
});
export function registerAppearanceWindow(window,mode,target){
  const contents=window.webContents,id=contents.id;
  if(entries.has(id))return;
  const expected=new URL(target.type==='file'?pathToFileURL(target.value).href:target.value);if(mode!=='main')expected.searchParams.set('mode',mode);
  const entry={window,mode,expected,applied:null,nativeReady:false,visualReady:mode!=='main',documents:0,show:null,waiters:new Set()};entries.set(id,entry);
  window.setBackgroundColor(mode==='main'?getSkin(getAppearanceService().getSnapshot().preference.skinId).windowBackground:'#00000000');
  window.on('ready-to-show',()=>{entry.nativeReady=true;flush(entry);});
  window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame){entry.applied=null;entry.visualReady=mode!=='main';}});
  for(const event of ['show','hide','focus','blur','minimize','restore'])window.on(event,()=>{if(!window.isDestroyed()){window.webContents.send(IPC.appearance.activity,activity(entry));if(event==='show'||event==='restore')sendSnapshot(entry);}});
  window.once('closed',()=>{entries.delete(id);for(const resolve of entry.waiters)resolve(false);entry.waiters.clear();});
}
export function appearanceCaller(event,write=false){
  const entry=entries.get(event.sender.id);if(!entry||entry.window.isDestroyed()||event.senderFrame!==event.sender.mainFrame||write&&entry.mode!=='main')return null;
  try{const url=new URL(event.senderFrame.url||event.sender.getURL());const expected=entry.expected;if(url.protocol!==expected.protocol||url.host!==expected.host||url.pathname!==expected.pathname||url.searchParams.get('mode')!==expected.searchParams.get('mode'))return null;}catch{return null;}
  return entry;
}
export function appearanceBootstrap(entry){
  const snapshot=getAppearanceService().getSnapshot(),coldStart=entry.mode==='main'&&entry.documents++===0&&!isSmokeTest;
  return {snapshot,windowMode:entry.mode,backgroundColor:entry.mode==='main'?getSkin(snapshot.preference.skinId).windowBackground:'#00000000',coldStart,activity:activity(entry)};
}
export function appearanceApplied(entry,value){
  const current=getAppearanceService().getSnapshot();
  if(value?.sessionId!==current.sessionId||value?.revision!==current.revision||!['ready','degraded','error'].includes(value?.status)){sendSnapshot(entry);return;}
  entry.applied={sessionId:value.sessionId,revision:value.revision};flush(entry);
}
export function appearanceVisualReady(entry,value){const current=getAppearanceService().getSnapshot();if(value?.sessionId===current.sessionId&&value?.revision===current.revision){entry.visualReady=true;flush(entry);}else sendSnapshot(entry);}
export function requestAppearanceShow(window,show){const entry=entries.get(window.webContents.id);if(!entry){show();return;}entry.show=show;flush(entry);}
export async function waitForAppearance(window){
  const entry=entries.get(window.webContents.id);if(!entry)return true;
  if(entry.nativeReady&&entry.visualReady&&matches(entry))return true;sendSnapshot(entry);
  return new Promise(resolve=>{const done=value=>{clearTimeout(timer);entry.waiters.delete(done);resolve(value);};const timer=setTimeout(()=>{log.warn('等待窗口外观就绪超时');done(false);},4000);entry.waiters.add(done);});
}
