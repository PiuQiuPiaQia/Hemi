// Real renderer -> IPC/controller -> shared Pi runtime. Only the external model is controlled.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {_electron} from 'playwright-core';
import electronPath from 'electron';
import {createServer} from 'vite';
import {GOAL_CHECK_SYSTEM} from '../src/main/agent-runtime/goal-driver.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const output = path.join(repo, '.visual/workflow/run-lifecycle');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-run-lifecycle-'));
await fs.mkdir(output, {recursive:true});
const report = {commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), workingTree:true,
  node:process.version, platform:`${process.platform}/${process.arch}`, results:[],
  boundary:'Real Electron, renderer, preload, IPC, controller, Pi SDK, goal verifier and local background command; controlled HTTP model.',
  gaps:['No installed-app update or production Bot/device deployment.', 'Appearance supports light mode only.']};
let app, page, vite, held = new Map(), counts = new Map(), current;
const markers = ['LIFE_CONTINUE','LIFE_STOP','LIFE_COMPACT','LIFE_BACKGROUND'];
const requestMarker = body => markers.find(marker => JSON.stringify(body.messages).includes(marker));
function chunk(res, body, delta, finish = null, promptTokens = 25) {
  res.write(`data: ${JSON.stringify({id:randomUUID(),model:body.model,choices:[{index:0,delta,finish_reason:finish}],
    ...(finish ? {usage:{prompt_tokens:promptTokens,completion_tokens:12}} : {})})}\n\n`);
}
function finish(res, body, promptTokens = 25, reason = 'stop') {
  if (res.destroyed) return;
  chunk(res,body,{},reason,promptTokens); res.end('data: [DONE]\n\n');
}
function answer(res, body, content, promptTokens = 25) {
  chunk(res,body,{role:'assistant',content}); finish(res,body,promptTokens);
}
function hold(key, res, body, text) {
  if (text) chunk(res,body,{role:'assistant',content:text});
  held.set(key,{res,body});
}
function release(key, content) {
  const entry=held.get(key); assert.ok(entry,`held ${key}`); held.delete(key);
  if (content) answer(entry.res,entry.body,content); else finish(entry.res,entry.body);
}
const verdict = status => JSON.stringify({status,reason:status==='continue'?'还有可执行的剩余工作':'实际结果已经核对',
  evidence:['已输出回答并核对执行记录'],remaining:status==='continue'?['输出剩余结果']:[],nextAction:status==='continue'?'继续完成剩余结果':''});
const server = http.createServer(async (req,res) => {
  try {
    let raw=''; for await (const chunk of req) raw+=chunk;
    const body=JSON.parse(raw), system=JSON.stringify(body.messages.filter(message=>message.role==='system'));
    const marker=requestMarker(body), checking=system.includes(GOAL_CHECK_SYSTEM), compact=system.includes('You are a context summarization assistant');
    res.writeHead(200,{'content-type':'text/event-stream'});
    current.requests.push({marker,checking,compact,main:Boolean(body.tools?.length)});
    if (compact) { hold('compact',res,body); return; }
    if (checking) {
      const key=`${marker}-check`, n=(counts.get(key)??0)+1; counts.set(key,n);
      hold(`${key}-${n}`,res,body); return;
    }
    if (!body.tools?.length) { answer(res,body,marker??'生命周期验收'); return; }
    const n=(counts.get(marker)??0)+1; counts.set(marker,n);
    if (marker==='LIFE_CONTINUE') {
      hold(n===1?'first-output':'continuation-output',res,body,n===1?'第一段回答已经输出。':undefined); return;
    }
    // SDK 需要有实际可压缩的历史；仅伪造较高 usage 而历史很短会直接跳过压缩。
    if (marker==='LIFE_COMPACT') { answer(res,body,`压缩前的回答已经输出。\n\n${'验收用历史记录。'.repeat(6000)}`,190000); return; }
    if (marker==='LIFE_BACKGROUND' && n===1) {
      chunk(res,body,{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'bash',arguments:JSON.stringify({
        command:`"${process.execPath}" -e "const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync('release-job')){clearInterval(t);fs.writeFileSync('job-proof','DONE')}},30)"`,
        description:'等待本机验收任务完成',run_in_background:true,timeout_ms:60000,
      })}}]}); finish(res,body,25,'tool_calls'); return;
    }
    answer(res,body,marker==='LIFE_BACKGROUND'?'已检查后台任务进度。':'回答已经输出。');
  } catch(error) { current?.errors.push(String(error.stack)); res.destroy(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
const wait=async(predicate,label,timeout=30000)=>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,40));}
  throw new Error(`Timeout: ${label}`);
};
const input=()=>page.locator('textarea.text-composer-input');
const flow=cid=>page.evaluate(cid=>window.hemiVoice.flowGetSnapshot(cid),cid);
const phase=async(cid,value)=>wait(async()=>{const s=await flow(cid);return s?.runs[s.activeRunId]?.activity?.phase===value?s:null;},value);
const check=name=>{current.checks.push(name);console.log(`PASS ${current.mode}: ${name}`);};
const cursorCount=()=>page.locator('.streaming-copy').count();
async function send(text){
  await input().fill(text);await input().press('Enter');
  return wait(()=>page.evaluate(async text=>{
    for(const session of (await window.hemiVoice.listConversations()).sessions){
      const record=await window.hemiVoice.openConversation(session.id);
      if(record.turns.some(turn=>turn.author==='user'&&turn.text===text))return record.id;
    }return null;
  },text),'input persisted');
}
async function newChat(){
  const open=page.getByRole('button',{name:'打开导航',exact:true});
  if(await open.count()&&await open.first().isVisible())await open.first().click();
  await page.getByRole('button',{name:'新建对话',exact:true}).click();
}
async function idle(cid,outcome){
  return wait(async()=>{const s=await flow(cid);return s?.phase==='idle'&&Object.values(s.runs).at(-1)?.outcome===outcome?s:null;},outcome);
}
async function capture(name){await page.screenshot({path:path.join(output,`${current.mode}-${name}.png`),animations:'disabled'});}
try {
  vite=await createServer({configFile:path.join(repo,'vite.config.ts'),cacheDir:path.join(root,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});
  await vite.listen();
  for(const mode of ['dev','built']){
    held=new Map();counts=new Map();current={mode,checks:[],errors:[],requests:[]};report.results.push(current);
    const profile=path.join(root,mode),workspace=path.join(profile,'workspace/default');await fs.mkdir(workspace,{recursive:true});
    await fs.writeFile(path.join(profile,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',completedAt:Date.now()}));
    await fs.writeFile(path.join(profile,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
    await fs.writeFile(path.join(profile,'doubao-asr.json'),JSON.stringify({globalPushToTalkEnabled:false}));
    await fs.writeFile(path.join(profile,'text-model-profiles.json'),JSON.stringify({version:3,defaultModelId:'lifecycle/main',lastConversationModelKey:'lifecycle/main',providers:[{
      id:'lifecycle',name:'生命周期验收',api:'openai-completions',baseUrl,models:[{id:'main',model:'lifecycle',thinkingLevel:'off',supportsVision:false}],
    }]}));
    const env={...process.env,HEMI_USER_DATA_DIR:profile,HEMI_TEST_MIC_GRANT:'1',HEMI_BOT_AUTO_UPDATE:'0',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'lifecycle'};
    if(mode==='dev')env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];else delete env.VITE_DEV_SERVER_URL;
    app=await _electron.launch({executablePath:electronPath,args:['.'],cwd:repo,env});
    await wait(()=>{page=app.windows().find(p=>/^(file|http):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode'));return page;},'main window');
    page.setDefaultTimeout(15000);page.on('pageerror',error=>current.errors.push(error.message));
    await input().waitFor();
    await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'lifecycle',name:'生命周期验收',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'lifecycle',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
    await page.reload();await input().waitFor();
    await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>!new URL(w.webContents.getURL()).searchParams.has('mode'));win.setMinimumSize(300,400);win.setContentSize(1440,900);});
    const cid=await send('LIFE_CONTINUE 请完整执行任务，检查后继续剩余工作。');
    await wait(async()=>await cursorCount()>0,'cursor during text output');await capture('generating');
    release('first-output');await phase(cid,'verifying');
    await page.getByText('正在检查完成情况',{exact:true}).waitFor();assert.equal(await cursorCount(),0);
    assert.equal(await page.getByRole('button',{name:'停止当前任务',exact:true}).isEnabled(),true);
    const runId=(await flow(cid)).activeRunId;
    for(const width of [1440,768,375]){
      await page.setViewportSize({width,height:900});
      if(width<1000){
        for(const close of await page.getByRole('button',{name:'关闭导航',exact:true}).all()){
          if(await close.isVisible()){await close.click();break;}
        }
      }
      const summary=page.locator('.h56-run-activity');
      const bounds=await summary.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1);
      assert.equal(await summary.locator('details').count(),0);
      await wait(()=>summary.locator('.h56-run-activity-title').evaluate(el=>{
        const box=el.getBoundingClientRect(),top=document.elementFromPoint(box.left+3,box.top+box.height/2);
        return el===top||el.contains(top);
      }),'status text is visible and unobscured');
      await capture(`verifying-${width}`);
    }
    await page.setViewportSize({width:1440,height:900});await page.reload();await input().waitFor();
    await page.getByText('正在检查完成情况',{exact:true}).waitFor();assert.equal(await cursorCount(),0);
    check('正文结束停止光标，校验保持运行，重载及三种窗口宽度正常');
    release('LIFE_CONTINUE-check-1',verdict('continue'));await phase(cid,'continuing');
    await wait(()=>held.has('continuation-output'),'continuation request');
    await page.getByText('继续处理剩余工作',{exact:true}).waitFor();assert.equal(await cursorCount(),0);await capture('continuing');
    const next=held.get('continuation-output');chunk(next.res,next.body,{role:'assistant',content:'续跑后的结果正在输出。'});
    await wait(async()=>await cursorCount()>0,'cursor returns during continuation');release('continuation-output');
    await phase(cid,'verifying');await wait(()=>held.has('LIFE_CONTINUE-check-2'),'second verifier');
    assert.equal((await flow(cid)).activeRunId,runId);release('LIFE_CONTINUE-check-2',verdict('complete'));
    await idle(cid,'completed');assert.equal(await page.locator('.h56-run-activity').count(),0);assert.equal(await cursorCount(),0);await capture('completed');
    check('完成校验继续原目标，恢复输出时恢复光标，通过校验后才关闭');
    await newChat();
    const compactId=await send('LIFE_COMPACT 回答后检查上下文压缩状态。');
    await phase(compactId,'compacting');await page.getByText('正在压缩上下文',{exact:true}).waitFor();
    assert.equal(await cursorCount(),0);await capture('compacting');
    while((await flow(compactId)).runs[(await flow(compactId)).activeRunId]?.activity?.phase==='compacting'){
      await wait(()=>held.has('compact'),'SDK compaction model');release('compact','# Summary\n已保留用户目标和实际回答，后续检查完成情况。');
      await wait(async()=>held.has('compact')||(await flow(compactId)).runs[(await flow(compactId)).activeRunId]?.activity?.phase!=='compacting','compaction advanced');
    }
    await phase(compactId,'verifying');release('LIFE_COMPACT-check-1',verdict('complete'));await idle(compactId,'completed');
    check('真实 SDK 自动压缩显示独立阶段，完成后继续校验');
    await newChat();
    const backgroundId=await send('LIFE_BACKGROUND 等待后台任务实际完成。');
    await phase(backgroundId,'waiting-background');assert.equal(await cursorCount(),0);await capture('background');
    await fs.writeFile(path.join(workspace,'release-job'),'release');
    await phase(backgroundId,'verifying');release('LIFE_BACKGROUND-check-1',verdict('complete'));await idle(backgroundId,'completed');
    assert.equal(await fs.readFile(path.join(workspace,'job-proof'),'utf8'),'DONE');
    check('真实后台任务等待无正文光标，完成后正常校验收口');
    await newChat();
    const stopId=await send('LIFE_STOP 在完成校验期间停止。');await phase(stopId,'verifying');
    // 开发 HUD 默认覆盖右下角；用其公开拖动手柄移开后，点击真实停止按钮。
    const monitor=page.getByRole('button',{name:'移动性能监控',exact:true});
    if(await monitor.count()){
      const box=await monitor.boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      await page.mouse.move(350,100,{steps:8});await page.mouse.up();
    }
    await page.getByRole('button',{name:'停止当前任务',exact:true}).click();
    await idle(stopId,'stopped');release('LIFE_STOP-check-1',verdict('continue'));
    assert.equal(counts.get('LIFE_STOP'),1);assert.equal(await page.locator('.h56-run-activity').count(),0);assert.equal(await cursorCount(),0);
    check('校验阶段可停止，迟到结果不会续跑或恢复状态行');
    assert.deepEqual(current.errors,[]);current.result='PASS';await app.close();app=null;
  }
  report.result='PASS';
} catch(error){
  report.result='FAIL';report.failure=String(error.stack);if(page&&!page.isClosed())await capture('failure').catch(()=>{});process.exitCode=1;
} finally {
  await app?.close().catch(()=>{});await vite?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  if(report.result==='PASS')await fs.rm(root,{recursive:true,force:true});else console.log(`Isolated diagnostic data: ${root}`);
  console.log(`${report.result}: ${path.join(output,'report.json')}`);
}
