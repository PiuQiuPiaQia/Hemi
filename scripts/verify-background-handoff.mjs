// Real renderer -> preload/IPC/controller -> shared runtime -> Pi -> real shell/WebSocket.
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
import {WebSocketServer} from 'ws';
import {GOAL_CHECK_SYSTEM} from '../src/main/agent-runtime/goal-driver.mjs';

const mode = process.argv.includes('--dev') ? 'dev' : 'built';
const output = path.resolve('.visual/workflow/background-handoff', mode);
const userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `hemi-handoff-${mode}-`)));
const workspace = path.join(userData, 'workspace/default');
await fs.mkdir(workspace, {recursive:true}); await fs.mkdir(output, {recursive:true});
await fs.writeFile(path.join(userData,'onboarding.json'), JSON.stringify({version:2,phase:'complete',step:'done',completedAt:Date.now()}));
await fs.writeFile(path.join(userData,'appearance.json'), JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
const report = {mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(),workingTree:true,node:process.version,
  checks:[],errors:[],requests:[],gaps:['No installed-app, production Bot or physical-device deployment.']};
let app, page, vite;
const counts = new Map(), held = new Map();
const ws = new WebSocketServer({host:'127.0.0.1',port:0}); await new Promise(resolve => ws.on('listening',resolve));
await fs.writeFile(path.join(workspace,'work.cjs'), `const fs=require('fs');const ws=new WebSocket('ws://127.0.0.1:${ws.address().port}');ws.onopen=()=>{fs.writeFileSync(process.argv[2],'WORK_DONE');console.log('WORK_DONE_WITH_OPEN_WS')};`);
const journal = async () => JSON.parse(await fs.readFile(path.join(userData,'runtime-v2/run-journal.json'),'utf8'));
const wait = async (read,label,timeout=60000) => {
  const end = Date.now()+timeout;
  while (Date.now()<end) {const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error(`Timeout: ${label}`);
};
function respond(res,body,content,tool) {
  if (res.destroyed) return;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{role:'assistant',content};
  for(const [value,reason] of [[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:randomUUID(),model:body.model,choices:[{index:0,delta:value,finish_reason:reason}],...(reason?{usage:{prompt_tokens:25,completion_tokens:10}}:{})})}\n\n`);
  res.end('data: [DONE]\n\n');
}
const server=http.createServer(async(req,res)=>{
  try {
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);
    const checking=body.messages.some(item=>item.role==='system'&&JSON.stringify(item.content).includes(GOAL_CHECK_SYSTEM));
    const marker=JSON.stringify(body.messages).includes('HANDOFF_STOP')?'HANDOFF_STOP':'HANDOFF_FINISH';
    report.requests.push({marker,checking,main:Boolean(body.tools?.length)});
    if(checking){
      const state=await journal();assert.ok(Object.values(state.processes).every(item=>item.cleanupConfirmed&&item.state==='finished'));
      respond(res,body,JSON.stringify({status:'complete',reason:'文件与后台清理已核对',evidence:['实际 WORK_DONE 文件与清理记录'],remaining:[],nextAction:''}));return;
    }
    if(!body.tools?.length){respond(res,body,'分段交接验收');return;}
    const n=(counts.get(marker)??0)+1;counts.set(marker,n);
    if(n===1){respond(res,body,null,{name:'bash',args:{command:`"${process.execPath}" "${path.join(workspace,'work.cjs')}" "${marker}.txt"`,description:'生成文件后保留调试连接',run_in_background:true,timeout_ms:120000}});return;}
    if(n<=60){await wait(()=>fs.stat(path.join(workspace,`${marker}.txt`)).catch(()=>null),'real file');respond(res,body,null,{name:'read',args:{path:path.join(workspace,`${marker}.txt`)}});return;}
    const state=await journal(),job=Object.values(state.processes).find(item=>item.command.includes(`${marker}.txt`));
    if(n===61){
      assert.ok(JSON.stringify(body.messages).includes('分段交接'));
      held.set(marker,()=>respond(res,body,null,{name:'job_output',args:{job_id:job.id}}));return;
    }
    if(n===62){respond(res,body,null,{name:'job_kill',args:{job_id:job.id}});return;}
    respond(res,body,'文件任务完成，已处理残留后台任务。');
  } catch(error){report.errors.push(String(error.stack));res.destroy();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
await fs.writeFile(path.join(userData,'text-model-profiles.json'),JSON.stringify({version:3,defaultModelId:'handoff/main',lastConversationModelKey:'handoff/main',providers:[{id:'handoff',name:'交接验收',api:'openai-completions',baseUrl,models:[{id:'main',model:'handoff',supportsVision:false,thinkingLevel:'off'}]}]}));
const input=()=>page.locator('textarea.text-composer-input');
const flow=cid=>page.evaluate(cid=>window.hemiVoice.flowGetSnapshot(cid),cid);
const check=name=>{report.checks.push(name);console.log(`PASS ${mode}: ${name}`);};
async function send(marker){
  await input().fill(`${marker} 生成文件，核对成果后处理不再需要的后台任务。`);await input().press('Enter');
  return wait(()=>page.evaluate(async marker=>{
    for(const session of (await window.hemiVoice.listConversations()).sessions){const s=await window.hemiVoice.openConversation(session.id);if(s.turns.some(turn=>turn.author==='user'&&turn.text.includes(marker)))return session.id;}return null;
  },marker),'input persisted');
}
async function settled(cid,outcome){
  const s=await wait(async()=>{const value=await flow(cid);return value.phase==='idle'?value:null;},'run settled');
  assert.equal(Object.keys(s.runs).length,1);assert.equal(s.timeline.filter(item=>item.kind==='user').length,1);
  assert.equal(Object.values(s.runs)[0].outcome,outcome);
  assert.equal(s.timeline.flatMap(item=>item.parts??[]).filter(part=>part.kind==='notice'&&part.level==='error').length,0);
  return s;
}
try{
  if(mode==='dev'){
    vite=await createServer({configFile:path.resolve('vite.config.ts'),cacheDir:path.join(userData,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});
    await vite.listen();process.env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];
  }else delete process.env.VITE_DEV_SERVER_URL;
  app=await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'handoff'}});
  page=await wait(()=>app.windows().find(window=>/^(file|http):/.test(window.url())&&!new URL(window.url()).searchParams.has('mode')),'main window');
  page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));await input().waitFor();
  report.environment=await app.evaluate(({app})=>({version:app.getVersion(),electron:process.versions.electron,node:process.versions.node,renderer:process.env.VITE_DEV_SERVER_URL??'built'}));
  await page.evaluate(baseUrl=>window.hemiVoice.saveModelProfile({id:'handoff',name:'交接验收',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'handoff',supportsVision:false,thinkingLevel:'off'}],makeDefault:true}),baseUrl);
  await page.reload();await input().waitFor();
  const cid=await send('HANDOFF_FINISH');await wait(()=>held.has('HANDOFF_FINISH'),'default 60-request segment handoff');
  let s=await flow(cid);const runId=s.activeRunId,job=s.runs[runId].activity.jobs[0];
  assert.equal(job.status,'running');assert.equal(job.deadlineAt-job.startedAt,120000);
  let state=await journal();assert.equal(state.roots[runId].goal.round,2);assert.equal(state.roots[runId].goal.checkpoints.length,1);assert.equal(state.roots[runId].goal.verifications.length,0);
  await page.screenshot({path:path.join(output,'handoff.png')});
  await page.reload();await input().waitFor();s=await flow(cid);
  assert.equal(s.activeRunId,runId);assert.equal(s.runs[runId].activity.jobs[0].id,job.id);assert.equal(s.runs[runId].activity.jobs[0].deadlineAt,job.deadlineAt);
  check('real 60-request handoff preserves root, job, deadline and reload state without early verification');
  held.get('HANDOFF_FINISH')();await settled(cid,'completed');state=await journal();
  assert.equal(Object.values(state.processes).filter(item=>item.owner.rootRunId===runId).length,1);assert.equal(state.processes[job.id].status,'cancelled');assert.equal(state.processes[job.id].cleanupConfirmed,true);
  assert.equal(state.roots[runId].goal.verifications.length,1);assert.equal(await fs.readFile(path.join(workspace,'HANDOFF_FINISH.txt'),'utf8'),'WORK_DONE');
  await page.screenshot({path:path.join(output,'completed.png')});check('new segment reads and stops the actual open-WebSocket process, then completes exactly once');
  await page.getByRole('button',{name:'新建对话',exact:true}).click();const stopId=await send('HANDOFF_STOP');
  await wait(()=>held.has('HANDOFF_STOP'),'second handoff');s=await flow(stopId);const stopRun=s.activeRunId;
  await page.evaluate(cid=>window.hemiVoice.flowCommand(cid,{type:'stop'}),stopId);held.get('HANDOFF_STOP')();await settled(stopId,'stopped');
  const count=report.requests.length;await new Promise(resolve=>setTimeout(resolve,150));assert.equal(report.requests.length,count);
  state=await journal();assert.ok(Object.values(state.processes).filter(item=>item.owner.rootRunId===stopRun).every(item=>item.cleanupConfirmed));assert.notEqual(state.roots[stopRun].goal.phase,'complete');
  check('stop during the next-segment request cancels the process and rejects late model work');
  assert.deepEqual(report.errors,[]);
}catch(error){report.errors.push(String(error.stack));process.exitCode=1;console.error(error);}
finally{
  await app?.close();await vite?.close();for(const client of ws.clients)client.terminate();await new Promise(resolve=>ws.close(resolve));
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await fs.rm(userData,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
