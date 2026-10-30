// Real renderer / preload / IPC / runtime / Pi SDK / shell / HTTP service.
// Only model replies are synthetic; each invocation owns a fresh user-data directory.
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

const mode=process.argv.includes('--dev')?'dev':'built';
const evidence=path.resolve('.visual/workflow/background-goals',mode);
const userData=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hemi-session-service-')));
const workspace=path.join(userData,'workspace/default');
fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(userData,'onboarding.json'),JSON.stringify({version:2,phase:'complete',step:'done',completedAt:Date.now()}));
fs.writeFileSync(path.join(userData,'appearance.json'),JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
fs.writeFileSync(path.join(workspace,'service.cjs'),`const fs=require('node:fs');require('node:http').createServer((q,s)=>s.end('REAL_SERVICE_READY')).listen(0,'127.0.0.1',function(){fs.writeFileSync('port',String(this.address().port))});`);
fs.writeFileSync(path.join(workspace,'probe.cjs'),`const fs=require('node:fs'),end=Date.now()+10000;async function probe(){try{if(fs.existsSync('allow-ready')){const r=await fetch('http://127.0.0.1:'+fs.readFileSync('port','utf8'),{signal:AbortSignal.timeout(500)});if(await r.text()==='REAL_SERVICE_READY'){fs.writeFileSync('ready-proof','HTTP_READY');console.log('BOUNDED_HTTP_READY');return}}}catch{}if(Date.now()>end)process.exit(1);setTimeout(probe,30)}probe();`);
fs.writeFileSync(path.join(workspace,'build.cjs'),`const fs=require('node:fs');fs.writeFileSync('build-started','YES');const t=setInterval(()=>{if(fs.existsSync('build-release')){clearInterval(t);fs.writeFileSync('build-proof','REAL_BUILD_RESULT');console.log('REAL_BUILD_RESULT')}},30);`);
const report={mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:`${process.platform}/${process.arch}`,checks:[],errors:[]};
const counts=new Map(),verifications=new Map();let app,page,vite,serviceId;
const journal=()=>JSON.parse(fs.readFileSync(path.join(userData,'runtime-v2/run-journal.json'),'utf8'));
const reply=(res,body,content,tool)=>{
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{role:'assistant',content};
  for(const [value,finish] of [[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:randomUUID(),model:body.model,choices:[{index:0,delta:value,finish_reason:finish}],...(finish?{usage:{prompt_tokens:25,completion_tokens:10}}:{})})}\n\n`);
  res.end('data: [DONE]\n\n');
};
const server=http.createServer(async(req,res)=>{
  try{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),all=JSON.stringify(body.messages);
    const checking=body.messages.some(m=>m.role==='system'&&String(m.content).includes(GOAL_CHECK_SYSTEM));
    if(checking){
      assert.ok(fs.existsSync(path.join(workspace,'ready-proof')),'completion follows independent readiness');
      const objective=JSON.stringify(JSON.parse(body.messages.at(-1).content).objective);
      verifications.set(objective,(verifications.get(objective)??0)+1);
      assert.ok(!objective.includes('START_SERVICE'),'live jobs defer target verification without blocking the chat');
      if(objective.includes('BUILD_CASE')){
        const job=Object.values(journal().processes).find(p=>p.command.endsWith('build.cjs'));
        assert.equal(job.status,'succeeded');assert.equal(job.cleanupConfirmed,true);
      }
      reply(res,body,JSON.stringify({status:'complete',reason:'真实 HTTP 就绪或后续问题已回答',evidence:['BOUNDED_HTTP_READY'],remaining:[],nextAction:''}));return;
    }
    if(!body.tools?.length){reply(res,body,'服务生命周期验收');return;}
    const marker=body.messages.filter(m=>m.role==='user').reverse().map(m=>{
      const text=JSON.stringify(m.content);return text.includes('STOP_SERVICE')?'stop':text.includes('BUILD_CASE')?'build':text.includes('FOLLOW_UP_QUESTION')?'follow':text.includes('START_SERVICE')?'start':null;
    }).find(Boolean)??'start';
    const count=(counts.get(marker)??0)+1;counts.set(marker,count);
    if(marker==='start'&&count===1)reply(res,body,null,{name:'bash',args:{command:`"${process.execPath}" service.cjs`,description:'启动开发服务供验证',run_in_background:true,timeout_ms:120000}});
    else if(marker==='start'&&count===2)reply(res,body,null,{name:'bash',args:{command:`"${process.execPath}" probe.cjs`,description:'有界 HTTP 就绪核验',yield_ms:12000,timeout_ms:15000}});
    else if(marker==='stop'&&count===1)reply(res,body,null,{name:'job_kill',args:{job_id:serviceId}});
    else if(marker==='build'&&count===1)reply(res,body,null,{name:'bash',args:{command:`"${process.execPath}" build.cjs`,description:'构建并核对实际结果',run_in_background:true,timeout_ms:120000}});
    else if(marker==='build')reply(res,body,fs.existsSync(path.join(workspace,'build-proof'))?'已读取 REAL_BUILD_RESULT，构建退出成功。':'等待原构建命令的真实结果。');
    else reply(res,body,marker==='start'?'SERVICE_READY_CONFIRMED':marker==='follow'?'FOLLOW_UP_ANSWER':'SERVICE_STOPPED');
  }catch(error){report.errors.push(String(error.stack));res.destroy();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
const wait=async(fn,label,timeout=30000)=>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,40));}
  throw new Error(`Timeout: ${label}`);
};
const check=name=>{report.checks.push(name);console.log(`PASS ${mode}: ${name}`);};
const flow=cid=>page.evaluate(cid=>window.hemiVoice.flowGetSnapshot(cid),cid);
const input=()=>page.locator('textarea.text-composer-input');
try{
  if(mode==='dev'){
    const {createServer}=await import('vite');
    vite=await createServer({configFile:path.resolve('vite.config.ts'),cacheDir:path.join(userData,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});
    await vite.listen();process.env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];
  }else delete process.env.VITE_DEV_SERVER_URL;
  app=await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'service-test'}});
  await wait(()=>{page=app.windows().find(p=>/^(?:file|http):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode'));return page;},'main window');
  page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await input().waitFor();
  report.environment=await app.evaluate(({app})=>({app:app.getVersion(),electron:process.versions.electron,node:process.versions.node,renderer:process.env.VITE_DEV_SERVER_URL??'built'}));
  await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'service-test',name:'服务验收',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'service-test',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
  await page.reload();await input().waitFor();
  const initial='START_SERVICE 启动并保留开发服务，核验就绪。';await input().fill(initial);await input().press('Enter');
  const cid=await wait(()=>page.evaluate(async text=>{
    for(const item of (await window.hemiVoice.listConversations()).sessions){const record=await window.hemiVoice.openConversation(item.id);if(record.turns.some(t=>t.author==='user'&&t.text===text))return record.id;}return null;
  },initial),'conversation persisted');
  await wait(()=>counts.get('start')===2&&fs.existsSync(path.join(workspace,'port')),'service running and readiness probe underway');
  const processFact=Object.values(journal().processes).find(p=>p.command.endsWith('service.cjs'));serviceId=processFact.id;
  assert.equal(processFact.state,'active');
  await input().fill('FOLLOW_UP_QUESTION 现在回答下一条问题。');await input().press('Enter');
  await wait(async()=>(await flow(cid)).pending.length===1,'follow-up enters normal input queue');
  fs.writeFileSync(path.join(workspace,'allow-ready'),'go');
  const done=await wait(async()=>{const s=await flow(cid);return s.phase==='idle'&&Object.keys(s.runs).length===2?s:null;},'initial turn releases foreground and queued follow-up executes');
  assert.deepEqual(Object.values(done.runs).map(r=>r.outcome),['awaiting-background','completed']);
  assert.equal(done.pending.length,0);assert.ok(JSON.stringify(done.timeline).includes('FOLLOW_UP_ANSWER'));
  assert.equal(done.timeline.flatMap(i=>i.parts??[]).find(p=>p.tool==='bash'&&p.args?.command.endsWith('service.cjs')).status,'done');
  assert.equal(Object.values(journal().processes).find(p=>p.id===serviceId).state,'active');
  const url='http://127.0.0.1:'+fs.readFileSync(path.join(workspace,'port'),'utf8');assert.equal(await (await fetch(url)).text(),'REAL_SERVICE_READY');
  assert.equal(await page.getByRole('button',{name:'停止当前任务',exact:true}).count(),0);
  assert.equal(await page.locator('.h56-run-activity').count(),0);assert.equal(await page.locator('.streaming-copy').count(),0);
  check('service stays live while its turn yields without verification and queued follow-up completes');
  await page.reload();await input().waitFor();assert.equal((await flow(cid)).phase,'idle');assert.equal(counts.get('start'),3);
  assert.equal(await (await fetch(url)).text(),'REAL_SERVICE_READY');
  await input().fill('');await page.screenshot({path:path.join(evidence,'idle-service-follow-up.png')});
  check('renderer reload preserves idle flow and live service without replay');
  await input().fill('BUILD_CASE 运行构建并告诉我真实结果。');await input().press('Enter');
  const waiting=await wait(async()=>{const s=await flow(cid);return s.phase==='idle'&&Object.keys(s.runs).length===3?s:null;},'build runs independently while foreground is idle');
  assert.equal(Object.values(waiting.runs).at(-1).outcome,'awaiting-background');
  const build=Object.values(journal().processes).find(p=>p.command.endsWith('build.cjs'));
  assert.equal(build.state,'active');
  assert.equal([...verifications.keys()].some(key=>key.includes('BUILD_CASE')),false);
  const modelCalls=counts.get('build');await new Promise(r=>setTimeout(r,150));assert.equal(counts.get('build'),modelCalls,'waiting does not poll the model');
  assert.equal(await page.getByRole('button',{name:'停止当前任务',exact:true}).count(),0);
  assert.equal(await page.locator('.streaming-copy').count(),0);
  await page.screenshot({path:path.join(evidence,'idle-background-build.png')});
  await input().fill('FOLLOW_UP_QUESTION 构建期间继续回答下一条问题。');await input().press('Enter');
  await wait(async()=>{const s=await flow(cid);return s.phase==='idle'&&Object.keys(s.runs).length===4;},'another question completes while build is live');
  assert.equal(journal().processes[build.id].state,'active');
  fs.writeFileSync(path.join(workspace,'build-release'),'go');
  const built=await wait(async()=>{const s=await flow(cid);return s.phase==='idle'&&Object.keys(s.runs).length===5?s:null;},'completion event resumes original build goal');
  assert.equal(Object.values(built.runs).at(-1).outcome,'completed');assert.equal(Object.values(built.runs).at(-1).source,'event');
  assert.equal(built.timeline.filter(item=>item.kind==='user').length,4,'completion adds no fake user input');
  assert.equal(journal().processes[build.id].status,'succeeded');
  assert.ok(JSON.stringify(built.timeline).includes('REAL_BUILD_RESULT'));assert.equal(journal().processes[serviceId].state,'active');
  const buildRoot=journal().roots[build.owner.rootRunId];assert.equal(buildRoot.goal.phase,'complete');assert.equal(buildRoot.goal.round,2);
  check('finite build releases foreground, another question completes, then real completion wakes its original goal once');
  await input().fill('STOP_SERVICE 停止前面保留的开发服务。');await input().press('Enter');
  await wait(async()=>{const s=await flow(cid);return s.phase==='idle'&&Object.keys(s.runs).length===6;},'new root stops retained service');
  const stopped=journal().processes[serviceId];assert.equal(stopped.status,'cancelled');assert.equal(stopped.cleanupConfirmed,true);
  await assert.rejects(fetch(url));assert.equal(counts.get('start'),3);assert.equal(counts.get('follow'),2);
  assert.deepEqual(report.errors,[]);check('later root can stop the same managed service, cleanup is confirmed and old goal never resumes');
}catch(error){
  if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  if(fs.existsSync(path.join(userData,'hemi.log')))fs.copyFileSync(path.join(userData,'hemi.log'),path.join(evidence,'hemi.log'));
  throw error;
}finally{
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
  await app?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await vite?.close();fs.rmSync(userData,{recursive:true,force:true});
}
