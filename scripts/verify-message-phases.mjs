// Electron -> actual IPC/controller/Pi -> local provider -> persisted flow -> shared UI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';
import { GOAL_CHECK_SYSTEM } from '../src/main/agent-runtime/goal-driver.mjs';

const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const evidence = path.resolve(`.visual/workflow/vision/message-phases/${mode}`);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-message-phases-${mode}-`));
fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(userData,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',permissionChoice:'skipped',completedAt:Date.now()}));
fs.writeFileSync(path.join(userData,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
const report = {mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(),workingTree:true,node:process.version,platform:`${process.platform}/${process.arch}`,checks:[],errors:[]};
const check = name => {report.checks.push(name);console.log(`PASS ${name}`);};
const wait = async (fn,label) => {
  const end=Date.now()+30000;
  while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,60));}
  throw Error(`Timed out: ${label}`);
};
const answer='**PHASE_RESULT 完整答案**\n\n- 第一步：核对系统版本\n- 第二步：按版本选择教程';
const requests=[],held=new Set();
const server=http.createServer(async(req,res)=>{
  try {
    let raw='';for await(const data of req)raw+=data;
    const body=JSON.parse(raw);
    const checking=JSON.stringify(body.messages?.filter(message=>message.role==='system')).includes(GOAL_CHECK_SYSTEM);
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'phase-test',model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    const done=()=>{if(!res.destroyed){chunk({},'stop');res.end('data: [DONE]\n\n');}};
    if(checking){chunk({role:'assistant',content:JSON.stringify({status:'complete',reason:'完整答案与来源已交付',evidence:['已输出正文'],remaining:[],nextAction:''})});done();return;}
    if(!body.tools?.length){chunk({role:'assistant',content:'消息阶段验证'});done();return;}
    requests.push(body);
    assert.ok(body.tools.some(tool=>tool.function.name==='report_progress'));
    assert.match(JSON.stringify(body.messages),/消息用途协议/);
    const count=body.messages.filter(message=>message.role==='tool').length;
    const stopped=JSON.stringify(body.messages).includes('PHASE_STOP');
    const tool=(name,args)=>{
      chunk({tool_calls:[{index:0,id:`phase-tool-${requests.length}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
      chunk({},'tool_calls');res.end('data: [DONE]\n\n');
    };
    if(count===0){tool('report_progress',{text:'**PHASE_PROGRESS** 正在核对资料'});return;}
    if(count===1&&!stopped){chunk({content:answer});tool('register_delivery',{files:[],sources:[{title:'验证来源',url:'https://example.com/reference'}]});return;}
    chunk({content:stopped?'PHASE_STOP_RESULT 已经查到部分结果':'PHASE_ACK 来源已登记'});
    const release=()=>{done();held.delete(release);};held.add(release);res.on('close',()=>held.delete(release));
  }catch(error){report.errors.push(error.message);res.destroy();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
let app,page;
const input=()=>page.locator('textarea.text-composer-input');
const flow=id=>page.evaluate(id=>window.hemiVoice.flowGetSnapshot(id),id);
const chat=()=>page.evaluate(async()=>(await window.hemiVoice.listConversations()).sessions[0]);
const submit=async text=>{await input().fill(text);await page.locator('.text-composer-send:not(.is-stop)').click();};
const resize=async width=>{
  await app.evaluate(({BrowserWindow},width)=>{const win=BrowserWindow.getAllWindows().find(win=>!new URL(win.webContents.getURL()).searchParams.has('mode'));win.setMinimumSize(1,1);win.setContentSize(width,900);},width);
  await page.waitForFunction(width=>innerWidth===width,width);
};
const launch=async()=>{
  app=await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1',HEMI_LLM_API_KEY:'TEST_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'phase-test'}});
  await wait(()=>{page=app.windows().find(page=>/^(http|file):/.test(page.url())&&!new URL(page.url()).searchParams.has('mode'));return !!page;},'main window');
  page.setDefaultTimeout(15000);report.rendererUrl=page.url();
  page.on('pageerror',error=>report.errors.push(error.message));
  await input().waitFor();
  const monitor=page.getByRole('button',{name:'移动性能监控',exact:true});
  if(await monitor.count())for(let i=0;i<12;i++)await monitor.press('ArrowLeft');
};
try {
  await launch();
  await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'phase',name:'阶段验证',api:'openai-completions',baseUrl,apiKey:'TEST_ONLY',models:[{id:'main',model:'phase-test',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
  await page.reload({waitUntil:'domcontentloaded'});await input().waitFor();await resize(1440);
  await submit('PHASE_MAIN：请交付完整答案并登记来源');
  await wait(()=>held.size>0,'final text streaming');
  const result=()=>page.locator('.chat-copy.assistant-copy').filter({hasText:'PHASE_RESULT'});
  await result().waitFor();
  assert.equal(await result().locator('strong').innerText(),'PHASE_RESULT 完整答案');
  assert.equal(await result().locator('li').count(),2);
  await page.locator('[data-message-phase="commentary"]').waitFor();
  check('执行中进度可见，答案在后续登记工具执行后仍显示完整 Markdown');
  for(const release of [...held])release();
  await page.locator('.text-composer-send.is-stop').waitFor({state:'hidden'});
  await wait(async()=>await page.locator('.chat-copy.assistant-copy[data-message-phase="commentary"]').count()===0,'commentary folded');
  assert.equal(await result().count(),1);
  await page.locator('.chat-copy.assistant-copy[data-message-phase="unclassified"]').filter({hasText:'PHASE_ACK'}).waitFor();
  const cid=(await chat()).id;
  const snapshot=await flow(cid);
  const texts=snapshot.timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='text');
  assert.deepEqual(texts.map(part=>part.phase),['commentary','unclassified','unclassified']);
  assert.equal(texts[1].content,answer);
  const group=page.locator('.turn-activity').first();
  await group.locator('.turn-activity-head').click();
  assert.equal(await group.locator('.turn-activity-say strong').innerText(),'PHASE_PROGRESS');
  await group.locator('.turn-activity-head').click();
  check('完成后只折叠显式进度，完整答案与短确认同时保留，展开进度仍为 Markdown');
  for(const width of [1440,768,375]){
    await resize(width);await result().scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(evidence,`answer-${width}.png`),scale:'css'});
  }
  check('共享布局在 1440/768/375 下保持答案可读且无横向溢出');
  assert.equal(requests.length,3,'unclassified fallback must not request a classification repair');
  check('缺少阶段即时兜底 unclassified，无额外纠正请求');
  const count=requests.length;
  await page.reload({waitUntil:'domcontentloaded'});await result().waitFor();
  assert.deepEqual((await flow(cid)).timeline,snapshot.timeline);
  assert.equal(requests.length,count);
  await app.close();app=null;
  await launch();await result().waitFor();
  assert.deepEqual((await flow(cid)).timeline,snapshot.timeline);
  assert.equal(requests.length,count);
  check('renderer 重载及应用重启从真实持久记录恢复相同阶段，不重跑模型或工具');
  await resize(1440);
  await page.getByRole('button',{name:'新建对话',exact:true}).click();
  await submit('PHASE_STOP：核对后等待');await wait(()=>held.size>0,'stoppable request');
  await page.locator('.chat-copy.assistant-copy').filter({hasText:'PHASE_STOP_RESULT'}).waitFor();
  const monitor=page.getByRole('button',{name:'移动性能监控',exact:true});
  if(await monitor.count()){
    const box=await monitor.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(500,100,{steps:8});await page.mouse.up();
  }
  await page.locator('.text-composer-send.is-stop').click();
  await page.locator('.h24-reply-stopped').waitFor();
  await page.locator('.chat-copy.assistant-copy').filter({hasText:'PHASE_STOP_RESULT'}).waitFor();
  await page.locator('.chat-copy.assistant-copy[data-message-phase="commentary"]').waitFor();
  check('停止时保留已收到的答案和进度，不套用正常完成折叠');
  assert.deepEqual(report.errors,[]);
}catch(error){report.errors.push(error.stack??String(error));if(page)await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});throw error;}
finally{
  if(app)await app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
  fs.rmSync(userData,{recursive:true,force:true});
}
