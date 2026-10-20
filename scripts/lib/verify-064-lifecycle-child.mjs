// 隔离驱动：通过真实 renderer preload 调用产品 IPC，不替换内部工厂或运行状态。
import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { initializeStableSafeStorageIdentity } from '../../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../../src/main/ipc/index.mjs';
import { createMainWindow } from '../../src/main/windows/main-window.mjs';
import { state } from '../../src/main/state.mjs';
import { getAgentRuntime } from '../../src/main/ipc/llm.ipc.mjs';
import { disposeTaskManager } from '../../src/main/ipc/task.ipc.mjs';
const dir=process.env.HEMI_USER_DATA_DIR,phase=process.env.HEMI_EDGE_PHASE,baseUrl=process.env.HEMI_EDGE_URL;
app.setName('hemi');app.setPath('userData',dir);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,label,ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await pause(50);}throw Error(label);};
const invoke=code=>state.mainWindow.webContents.executeJavaScript(code);
const call=(name,...args)=>invoke(`window.hemiVoice.${name}(...${JSON.stringify(args)})`);
const modelIds=['main','fixer','oracle','alternate','backup'];
const models=modelIds.map(id=>({id,model:id,thinkingLevel:'off'}));
const send=async(cid,text,model='auto')=>{const r=await call('submitChatTurn',{conversationId:cid,requestId:`${phase}-${text}`,profileId:model,workspaceId:'default',inputSource:'text',messages:[{role:'user',content:text}]});assert.equal(r.ok,true,JSON.stringify(r));return r;};
const flow=cid=>call('flowGetSnapshot',cid);
const idle=cid=>wait(async()=>{const s=await flow(cid);return s.phase==='idle'&&s.pending.length===0&&Object.keys(s.runs).length?s:null;},`${cid}未收口`);
const exists=name=>readFile(path.join(dir,'workspace/default',name),'utf8').catch(()=>false);
const result={phase,ok:false,terminal:false};
async function inspectConversation(cid,label,marker=label==='插队后的对话'?'EDGE_PROMOTE_NEW':'EDGE_RESUME_SECOND') {
 const title=`064 ${label}`;
 await call('renameConversation',cid,title);
 await wait(()=>invoke(`!![...document.querySelectorAll('.h24-sidebar-open')].find(e=>e.title.startsWith(${JSON.stringify(title)}))`),'会话标题未更新');
 await invoke(`[...document.querySelectorAll('.h24-sidebar-open')].find(e=>e.title.startsWith(${JSON.stringify(title)})).click()`);
 await wait(()=>invoke(`document.body.innerText.includes(${JSON.stringify(marker)})`),'对话内容未显示');
 const snapshot=await flow(cid);
 const delegations=snapshot.timeline.flatMap(item=>(item.parts??[]).filter(part=>part.kind==='delegation').map(part=>({runId:item.runId,part})));
 assert.ok(delegations.length>0);
 for(const {runId,part} of delegations){
  if(part.status==='error'&&!part.taskId)continue;
  assert.ok(part.taskId,'派单未绑定真实任务身份');
  const task=snapshot.tasks[part.taskId];assert.equal(task?.phase,'terminal','已收口任务没有终态');assert.equal(task.rootRunId,runId,'子任务关联到错误根目标');
 }
 if(phase==='resume'||phase==='controls'){
  const files=Object.values(snapshot.artifacts).filter(a=>a.name==='resume.txt');assert.equal(files.length,1);
  const roots=snapshot.timeline.filter(item=>item.kind==='user'&&item.text.startsWith('EDGE_RESUME_')).map(item=>item.runId);
  assert.deepEqual(files[0].producers.map(p=>p.runId),roots,'恢复交付被相同短调用ID串到别的运行');
 }
 result.screenshots=[];
 for(const width of [1440,375,768]){
  state.mainWindow.setMinimumSize(300,400);state.mainWindow.setContentSize(width,900);await pause(500);
  const image=path.resolve(`.visual/workflow/vision/064-lifecycle-${phase}-${width}.png`);
  await writeFile(image,(await state.mainWindow.webContents.capturePage()).toPNG());result.screenshots.push(image);
  assert.equal(await invoke('document.documentElement.scrollWidth<=innerWidth'),true,'对话横向溢出');
  assert.equal(await invoke("!!document.querySelector('.h56-delegation .h37-spinner')"),false,'终态任务仍在转圈');
 }
 result.visibleText=(await invoke('document.body.innerText')).slice(-2400);
}

app.whenReady().then(async()=>{try{
 initializeStableSafeStorageIdentity();await mkdir(dir,{recursive:true});
 if(phase==='first'){
  await writeFile(path.join(dir,'text-model-profiles.json'),JSON.stringify({version:3,defaultModelId:'p/main',roleModels:{main:'p/main',fixer:'p/fixer',oracle:'p/oracle',fallback:'p/backup'},providers:[{id:'p',name:'隔离生命周期验证',baseUrl,encryptedApiKey:safeStorage.encryptString('TEST_64').toString('base64'),models}]}));
  await writeFile(path.join(dir,'onboarding.json'),JSON.stringify({version:1,phase:'complete',step:'done',completedAt:Date.now()}));
 }
 await registerAllIpcHandlers();await createMainWindow();state.mainWindow.show();await wait(()=>invoke(`!!document.querySelector('textarea[aria-label="输入消息"]')`),'renderer未就绪');result.rendererUrl=state.mainWindow.webContents.getURL();
 if(phase.startsWith('crash-')){
  const kind=phase.slice(6);await send(`conv-edge-crash-${kind}`,`EDGE_CRASH_${kind.toUpperCase()}`);await new Promise(()=>{});
 }
 if(phase.startsWith('recover-')){
  const kind=phase.slice(8),cid=`conv-edge-crash-${kind}`;
  const previous=await flow(cid);assert.equal(previous.phase,'idle');assert.equal(Object.values(previous.runs)[0].outcome,'interrupted');
  await send(cid,'EDGE_POST_CRASH_SAFE');await idle(cid);
 }
 if(phase==='first'){await send('conv-edge-resume','EDGE_RESUME_FIRST');await idle('conv-edge-resume');}
 if(phase==='resume'){await send('conv-edge-resume','EDGE_RESUME_SECOND');await idle('conv-edge-resume');await inspectConversation('conv-edge-resume','重启续用的对话');}
 if(phase==='controls'){for(const marker of ['EDGE_FOREIGN','EDGE_WRONG_ROLE','EDGE_CROSS_CONTROL']){const cid=marker==='EDGE_WRONG_ROLE'?'conv-edge-resume':`conv-${marker.toLowerCase().replaceAll('_','-')}`;await send(cid,marker);await idle(cid);}
 await inspectConversation('conv-edge-resume','派单拒绝后的对话','EDGE_WRONG_ROLE');}
 if(phase==='queue'){
  await send('conv-edge-queue','EDGE_HOLDER');await wait(()=>exists('holder-started'),'工具未开始');
  const queued=await send('conv-edge-queue','EDGE_QUEUED');assert.equal(queued.disposition,'queued');
  await call('saveRoleModel',{main:'p/alternate'});
  await call('saveModelProfile',{id:'p',name:'隔离生命周期验证',baseUrl:baseUrl.replace('/old/','/new/'),apiKey:'ROTATED_64',models});
  await writeFile(path.join(dir,'workspace/default/release-holder'),'release');await idle('conv-edge-queue');
  await send('conv-edge-new-config','EDGE_NEW_CONFIG');await idle('conv-edge-new-config');
 }
 if(phase==='cancel'){await send('conv-edge-cancel','EDGE_CANCEL_ONE');await idle('conv-edge-cancel');}
 if(phase==='promote'){
  await send('conv-edge-promote','EDGE_PROMOTE_OLD');await wait(()=>exists('promote-started'),'插队前工具未开始');
  const receipt=await send('conv-edge-promote','EDGE_PROMOTE_NEW');assert.equal(receipt.disposition,'queued');
  const promoted=await call('flowCommand','conv-edge-promote',{type:'promoteInput',inputId:receipt.inputId});assert.equal(promoted.ok,true);
  const f=await idle('conv-edge-promote');assert.equal(Object.values(f.runs).length,2);assert.equal(Object.values(f.runs)[0].outcome,'stopped');assert.equal(Object.values(f.runs)[1].outcome,'completed');await inspectConversation('conv-edge-promote','插队后的对话');
 }
 if(phase==='boundaries'){
  for(const marker of ['EDGE_DIRECT','EDGE_EMPTY_FOLLOW','EDGE_READONLY','EDGE_CAPABILITY','EDGE_LOADOUT_FIRST']){const cid=`conv-${marker.toLowerCase().replaceAll('_','-')}`;await send(cid,marker);await idle(cid);}
  await writeFile(path.join(dir,'workspace/default/AGENTS.md'),'# Isolated fixture\nHEMI_064_LOADOUT_CHANGED\n');
  await send('conv-edge-loadout-first','EDGE_LOADOUT_SECOND');await idle('conv-edge-loadout-first');
 }
 if(phase==='limits'){
  await send('conv-edge-concurrency','EDGE_CONCURRENCY');
  const concurrent=await wait(async()=>{const state=await call('getTaskState');const tasks=state.tasks.filter(t=>t.conversationId==='conv-edge-concurrency');return tasks.length===6&&tasks.filter(t=>t.phase==='running').length===5&&tasks.filter(t=>t.phase==='waiting').length===1?tasks:null;},'并发名额未按5运行1等待受理');
  assert.equal(concurrent.length,6);await writeFile(path.join(dir,'workspace/default/release-concurrency'),'release');await idle('conv-edge-concurrency');
  await send('conv-edge-budget','EDGE_BUDGET');const f=await idle('conv-edge-budget');assert.equal(Object.values(f.runs)[0].outcome,'failed');
 }
 if(phase==='auth'){
  await call('saveRoleModel',{main:'p/main'});await send('conv-edge-auth','EDGE_AUTH');const f=await idle('conv-edge-auth');assert.equal(Object.values(f.runs)[0].outcome,'failed');
  await send('conv-edge-fallback','EDGE_FALLBACK');await idle('conv-edge-fallback');
 }
 result.ok=true;result.terminal=true;
}catch(error){result.error=error.stack;console.error(error.stack);}finally{
 await writeFile(path.join(dir,`${phase}.json`),JSON.stringify(result,null,2));disposeTaskManager();getAgentRuntime().disposeAll();state.isQuitting=true;setTimeout(()=>app.exit(result.ok?0:1),200);
}});
