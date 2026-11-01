import {readRunJournalFileSync} from '../src/main/agent-runtime/journal-inspection.mjs';
// Real renderer → preload → IPC → runtime → Pi → shell; only model HTTP is scripted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {_electron} from 'playwright-core';
import electronPath from 'electron';
import {GOAL_CHECK_SYSTEM} from '../src/main/agent-runtime/goal-driver.mjs';

const mode = process.argv.includes('--dev') ? 'dev' : 'built';
const evidence = path.resolve('.visual/workflow/subagent-handoff',mode);
const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hemi-review-handoff-')));
const workspace = path.join(userData,'workspace/default');
fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(userData,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',completedAt:Date.now()}));
fs.writeFileSync(path.join(userData,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
fs.writeFileSync(path.join(workspace,'gate.cjs'),"const fs=require('fs');fs.writeFileSync('started','yes');const t=setInterval(()=>{if(fs.existsSync('release')){clearInterval(t);fs.writeFileSync('proof.txt','REAL_CHILD_PROOF');console.log('REAL_CHILD_PROOF')}},30)");
let app,page,vite,cid,initialSpawned=false,reviewSpawned=false,rootReported=false;
const childCalls = new Map();
const report = {mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,checks:[],errors:[]};
const reply = (res,body,content,tool) => {
  if(res.destroyed)return;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta = tool ? {role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]} : {role:'assistant',content};
  for(const [value,finish] of [[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:randomUUID(),model:body.model,choices:[{index:0,delta:value,finish_reason:finish}],...(finish?{usage:{prompt_tokens:20,completion_tokens:10}}:{})})}\n\n`);
  res.end('data: [DONE]\n\n');
};
const server = http.createServer(async(req,res)=>{
  try {
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),all=JSON.stringify(body.messages);
    if(body.messages.some(m=>m.role==='system'&&String(m.content).includes(GOAL_CHECK_SYSTEM))){
      assert.ok(fs.existsSync(path.join(workspace,'proof.txt')));
      assert.ok(reviewSpawned);
      reply(res,body,JSON.stringify({status:'complete',reason:'真实文件和续跑任务均已核对',evidence:['REAL_CHILD_PROOF','CHILD_CHECK_DONE'],remaining:[],nextAction:''}));
    } else if(!body.tools?.length)reply(res,body,'任务交接验证');
    else if(body.tools.some(t=>t.function.name==='task')){
      if(!initialSpawned){initialSpawned=true;reply(res,body,null,{name:'task',args:{agent:'fixer',description:'后台文件工作',prompt:'CHILD_BACKGROUND 启动 gate.cjs，保留后台命令并交接。'}});}
      else if(fs.existsSync(path.join(workspace,'proof.txt'))&&!reviewSpawned){reviewSpawned=true;reply(res,body,null,{name:'task',args:{agent:'fixer',description:'续跑核对文件',prompt:'CHILD_REVIEW 读取 proof.txt，报告 CHILD_CHECK_DONE。'}});}
      else {
        const done=reviewSpawned&&childCalls.get('review')===2&&!rootReported;
        if(done)rootReported=true;
        reply(res,body,done?'ROOT_DONE':'');
      }
    } else {
      const review=all.includes('CHILD_REVIEW'),key=review?'review':'background',count=(childCalls.get(key)??0)+1;childCalls.set(key,count);
      if(count===1)reply(res,body,null,review?{name:'read',args:{path:'proof.txt'}}:{name:'bash',args:{command:`"${process.execPath}" gate.cjs`,description:'真实后台文件工作',run_in_background:true,timeout_ms:90000}});
      else if((review&&count===2)||(!review&&count===3)){
        if(!review)assert.deepEqual(body.tools.map(t=>t.function.name),['submit_task_result']);
        reply(res,body,null,{name:'submit_task_result',args:{version:1,summary:review?'CHILD_CHECK_DONE':'后台工作已交接',completed:[review?'已读取真实 proof.txt':'已启动受管命令'],remaining:review?[]:['等候命令真实结果'],blockers:[],verification:[{check:'真实文件',status:review?'passed':'not_run',evidence:review?'read 返回 REAL_CHILD_PROOF':'后台工作仍在运行'}],nextAction:review?'':'主目标等待并核对结果'}});
      } else reply(res,body,review?(count===3?'CHILD_CHECK_DONE':''):(count===2?'验收仍在后台执行，交回原目标等待真实结果。':''));
    }
  } catch(error){report.errors.push(String(error.stack));res.destroy();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
const wait=async(fn,label)=>{const end=Date.now()+30000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,40));}throw new Error(`Timeout: ${label}`);};
const flow=()=>page.evaluate(id=>window.hemiVoice.flowGetSnapshot(id),cid);
const check=name=>{report.checks.push(name);console.log(`PASS ${mode}: ${name}`);};
const checkReturnMark=async(entry,label)=>{
  const icon=entry.locator('.h56-delegation-return-mark');await icon.waitFor();
  assert.equal(await icon.getAttribute('aria-label'),label);
  const style=await icon.evaluate(el=>{const s=getComputedStyle(el);return {width:s.width,height:s.height,shrink:s.flexShrink,color:s.color};});
  assert.equal(style.width,'12px');assert.equal(style.height,'12px');assert.equal(style.shrink,'0');
  assert.equal(style.color,await entry.locator('.h56-delegation-meta').evaluate(el=>getComputedStyle(el).color));
  assert.equal(await entry.locator('.h56-delegation-fail').count(),0);
  check(`${label} marker stays 12px and neutral`);
};
try {
  if(mode==='dev'){
    const {createServer}=await import('vite');vite=await createServer({configFile:path.resolve('vite.config.ts'),cacheDir:path.join(userData,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0}});await vite.listen();process.env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];
  } else delete process.env.VITE_DEV_SERVER_URL;
  app=await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'handoff-test'}});
  await wait(()=>{page=app.windows().find(p=>/^(file|http):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode'));return page;},'main window');
  page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
  const input=()=>page.locator('textarea.text-composer-input');await input().waitFor();
  report.environment=await app.evaluate(({app})=>({app:app.getVersion(),electron:process.versions.electron,node:process.versions.node}));
  await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'handoff-test',name:'交接验收',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'handoff-test',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
  await page.reload();await input().waitFor();
  await input().fill('REVIEW_HANDOFF 启动子任务，结果出来后再派任务核对。');await input().press('Enter');
  cid=await wait(()=>page.evaluate(async()=>{for(const c of (await window.hemiVoice.listConversations()).sessions){const record=await window.hemiVoice.openConversation(c.id);if(record.turns.some(t=>t.author==='user'&&t.text.startsWith('REVIEW_HANDOFF')))return c.id;}return null;}),'conversation');
  const waiting=await wait(async()=>{const s=await flow();return s.phase==='idle'&&Object.values(s.tasks).some(t=>t.outcome==='handoff')&&s;},'child handoff');
  const original=Object.values(waiting.runs)[0].runId;
  assert.equal(Object.values(waiting.runs)[0].outcome,'awaiting-background');
  assert.equal(Object.keys(waiting.tasks).length,1);
  const handoffEntry=page.locator('.h56-delegation[data-state="handoff"]');await handoffEntry.waitFor();
  await checkReturnMark(handoffEntry,'已交接');
  const record=await page.evaluate(id=>window.hemiVoice.openConversation(id),cid);
  assert.ok(record.turns.some(t=>t.author==='hemi'&&t.text.includes('任务已交接到后台')));
  assert.doesNotMatch(JSON.stringify(record.turns),/没有生成内容，请再说一次/);
  await page.getByText('任务已交接到后台，结果就绪后会继续处理。',{exact:true}).waitFor();
  await page.screenshot({path:path.join(evidence,'waiting-handoff.png')});
  check('accepted child with live command shows handoff; empty main reply uses background state');
  fs.writeFileSync(path.join(workspace,'release'),'go');
  const done=await wait(async()=>{const s=await flow();return s.phase==='idle'&&Object.values(s.runs).some(r=>r.source==='event'&&r.outcome==='completed')&&s;},'resumed goal completes');
  const child=Object.values(done.tasks).find(t=>t.taskText==='续跑核对文件');assert.ok(child);
  assert.equal(child.outcome,'returned');assert.equal(child.rootRunId,original);
  const anchor=done.timeline.flatMap(i=>(i.parts??[]).map(p=>({item:i,part:p}))).find(x=>x.part.taskId===child.taskId);assert.ok(anchor);
  assert.notEqual(anchor.item.runId,original);assert.equal(done.runs[anchor.item.runId].rootRunId,original);
  assert.equal(fs.readFileSync(path.join(workspace,'proof.txt'),'utf8'),'REAL_CHILD_PROOF');
  const entry=page.locator('.h56-delegation[data-state="returned"]').filter({hasText:'续跑核对文件'});await entry.waitFor();
  await checkReturnMark(entry,'已返回');
  await entry.getByRole('button').first().click();
  const processView=page.getByLabel('执行过程',{exact:true});await processView.waitFor();
  await processView.getByText('CHILD_CHECK_DONE',{exact:true}).waitFor();
  assert.match(await processView.locator('header').innerText(),/已返回/);
  report.processBounds=await wait(()=>processView.evaluate(el=>{
    const r=el.getBoundingClientRect();let opacity=1;
    for(let node=el;node;node=node.parentElement)opacity*=Number(getComputedStyle(node).opacity);
    return r.left>=0&&r.right<=innerWidth&&r.width>100&&opacity>=0.99?{left:r.left,right:r.right,width:r.width,opacity}:null;
  }),'process panel finishes opening');
  await processView.screenshot({path:path.join(evidence,'process-content.png')});
  await page.screenshot({path:path.join(evidence,'returned-process.png')});
  check('background event delegation binds original owner and opens the returned task process');
  await page.reload();await input().waitFor();
  const restored=await flow();assert.equal(restored.tasks[child.taskId].outcome,'returned');
  assert.equal(restored.runs[anchor.item.runId].rootRunId,original);
  assert.equal(restored.timeline.filter(i=>i.kind==='user').length,1);
  assert.equal(Object.keys(restored.tasks).length,2);assert.equal(restored.backgroundJobs.length,0);
  assert.equal(childCalls.get('background'),3);assert.equal(childCalls.get('review'),2);
  const journal=readRunJournalFileSync(path.join(userData,'runtime-v2/run-journal.json'));
  const results=Object.values(journal.tasks).map(t=>t.result.handoff);
  assert.equal(results.length,2);assert.ok(results.every(h=>h.version===1&&h.submission.status==='submitted'));
  assert.ok(results.every(h=>h.owner.rootRunId===original));
  assert.ok(results.some(h=>h.execution.pendingBackground&&h.submission.data.remaining.length));
  check('both reports persist protocol v1; missing handoff repairs with submission tool only');
  check('reload preserves both task identities and statuses without replay');
  assert.deepEqual(report.errors,[]);
} catch(error){report.failure=String(error.stack);if(page)await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});throw error;}
finally {
  if(app)await app.close();if(vite)await vite.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
  fs.rmSync(userData,{recursive:true,force:true,maxRetries:6,retryDelay:100});
}
