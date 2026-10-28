// Actual PC renderer -> preload/IPC/controller -> shared Pi runtime -> HTTP/files.
// Only model responses are synthetic. Every run owns a fresh HEMI_USER_DATA_DIR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {_electron} from 'playwright';
import electronPath from 'electron';
import {GOAL_CHECK_SYSTEM} from '../src/main/agent-runtime/goal-driver.mjs';

const mode = process.argv.includes('--dev') ? 'dev' : 'built';
const evidence = path.resolve('.visual/workflow/desktop-goals', mode);
const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hemi-pc-goals-${mode}-`)));
const workspace = path.join(userData, 'workspace/default');
fs.mkdirSync(workspace, {recursive:true}); fs.mkdirSync(evidence, {recursive:true});
fs.writeFileSync(path.join(workspace,'seed.txt'), 'REAL_PC_GOAL_SEED');
fs.writeFileSync(path.join(userData,'onboarding.json'), JSON.stringify({version:2,phase:'complete',step:'done',completedAt:Date.now()}));
fs.writeFileSync(path.join(userData,'appearance.json'), JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
const report = {mode,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:`${process.platform}/${process.arch}`,checks:[],errors:[],requests:[]};
const counts = new Map(), held = new Set();
let app, page, vite;
const verdict = (status, reason, remaining = [], question) => ({status,reason,evidence:['实际会话与真实工具结果'],remaining,nextAction:status === 'continue' ? '写入剩余成果' : '',...(question ? {question} : {})});
const markers = ['PC_GOAL_CHUNK','PC_GOAL_WAIT_STOP','PC_GOAL_WAIT','PC_GOAL_STOP','PC_GOAL_INVALID','PC_GOAL_BLOCKED'];
function respond(res, body, content, tool) {
  if (res.destroyed) return;
  res.writeHead(200, {'content-type':'text/event-stream'});
  const delta = tool ? {role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]} : {role:'assistant',content};
  for (const [value, finish] of [[delta,null],[{},tool ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({id:randomUUID(),model:body.model,choices:[{index:0,delta:value,finish_reason:finish}],...(finish ? {usage:{prompt_tokens:25,completion_tokens:10}} : {})})}\n\n`);
  res.end('data: [DONE]\n\n');
}
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), all = JSON.stringify(body.messages);
    const checking = body.messages.some(message => message.role==='system' && JSON.stringify(message.content).includes(GOAL_CHECK_SYSTEM)), main = Boolean(body.tools?.length);
    const userTexts = body.messages.filter(message => message.role==='user').map(message => typeof message.content==='string' ? message.content : JSON.stringify(message.content)).reverse();
    const texts = checking ? [JSON.stringify(JSON.parse(userTexts[0]).objective)] : userTexts;
    const marker = texts.map(text => markers.find(item => text.includes(item))).find(Boolean);
    report.requests.push({marker,checking,main,model:body.model,tools:body.tools?.length ?? 0});
    if (!main && !checking) { respond(res,body,marker ?? 'PC 验收'); return; }
    if (checking) {
      assert.equal(body.tools?.length ?? 0,0); assert.equal(body.tool_choice,'none');
      if (marker === 'PC_GOAL_STOP') { const entry = {res,body}; held.add(entry); res.on('close', () => held.delete(entry)); return; }
      if (marker === 'PC_GOAL_INVALID') { respond(res,body,'invalid json'); return; }
      if (marker === 'PC_GOAL_BLOCKED') { respond(res,body,JSON.stringify({...verdict('blocked','实际命令已确认外部资源不可用',['等待外部资源恢复']),nextAction:'请恢复外部资源后继续'})); return; }
      const done = marker === 'PC_GOAL_CHUNK' ? fs.existsSync(path.join(workspace,'chunk-proof.txt'))
        : marker === 'PC_GOAL_WAIT' && fs.existsSync(path.join(workspace,'clarified-proof.txt'));
      const value = done ? verdict('complete','实际文件已写入并核对')
        : marker?.startsWith('PC_GOAL_WAIT') ? verdict('awaiting_user','需要用户提供内容',['写入用户指定的内容'],'文件里写什么内容？')
          : verdict('continue','尚有明确可执行的剩余工作',['写入 chunk-proof.txt']);
      respond(res,body,JSON.stringify(value)); return;
    }
    counts.set(marker,(counts.get(marker) ?? 0)+1);
    const count = counts.get(marker);
    let content, tool;
    if (marker === 'PC_GOAL_CHUNK') {
      if (!all.includes('宿主目标续跑')) tool = {name:'read',args:{path:path.join(workspace,'seed.txt')}};
      else if (!fs.existsSync(path.join(workspace,'chunk-proof.txt'))) tool = {name:'write',args:{path:path.join(workspace,'chunk-proof.txt'),content:'PC_CHUNK_PROOF'}};
      else content = '已完成 PC_CHUNK_PROOF。';
    } else if (marker?.startsWith('PC_GOAL_WAIT')) {
      if (count === 1) tool = {name:'write',args:{path:path.join(workspace,`${marker}-once.txt`),content:'INITIAL_EFFECT_ONCE'}};
      else if (!all.includes('CLARIFIED_VALUE')) content = '文件里写什么内容？';
      else if (!fs.existsSync(path.join(workspace,'clarified-proof.txt'))) tool = {name:'write',args:{path:path.join(workspace,'clarified-proof.txt'),content:'CLARIFIED_VALUE'}};
      else content = '已写入 CLARIFIED_VALUE。';
    } else if (marker === 'PC_GOAL_BLOCKED') {
      if(count===1)tool={name:'bash',args:{command:`"${process.execPath}" -e "process.stderr.write('EXTERNAL_RESOURCE_UNAVAILABLE');process.exit(23)"`,yield_ms:1000}};
      else content='已核对命令返回，外部资源不可用，请恢复资源后继续。';
    } else content = '等待完成校验。';
    respond(res,body,content,tool);
  } catch (error) { report.errors.push(String(error.stack)); res.destroy(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData,'text-model-profiles.json'), JSON.stringify({version:3,defaultModelId:'pc-goals/main',lastConversationModelKey:'pc-goals/main',providers:[{id:'pc-goals',name:'PC 目标验收',api:'openai-completions',baseUrl,models:[{id:'main',model:'pc-goals',thinkingLevel:'off',supportsVision:false}]}]}));
const wait = async (predicate,label,timeout=45000) => {
  const deadline = Date.now()+timeout;
  while (Date.now()<deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve,50)); }
  throw new Error(`Timeout: ${label}`);
};
const check = name => { report.checks.push(name); console.log(`PASS ${mode}: ${name}`); };
const flow = cid => page.evaluate(cid => window.hemiVoice.flowGetSnapshot(cid),cid);
const journal = () => JSON.parse(fs.readFileSync(path.join(userData,'runtime-v2/run-journal.json'),'utf8'));
const input = () => page.locator('textarea.text-composer-input');
async function launch() {
  app = await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'pc-goals'}});
  await wait(() => { page=app.windows().find(p => /^(?:file|http):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode')); return page; },'main window');
  page.setDefaultTimeout(15000); page.on('pageerror',error => report.errors.push(error.message));
  await input().waitFor();
  report.environment = await app.evaluate(({app}) => ({app:app.getVersion(),electron:process.versions.electron,node:process.versions.node,renderer:process.env.VITE_DEV_SERVER_URL ?? 'built'}));
}
async function send(text) {
  await input().fill(text); await input().press('Enter');
  return wait(() => page.evaluate(async text => {
    for (const item of (await window.hemiVoice.listConversations()).sessions) {
      const record = await window.hemiVoice.openConversation(item.id);
      if (record.turns.some(turn => turn.author==='user'&&turn.text===text)) return record.id;
    }
    return null;
  },text),'user input persisted');
}
async function settled(cid, runs=1) { return wait(async () => { const value=await flow(cid); return value?.phase==='idle'&&Object.keys(value.runs).length===runs ? value : null; },'goal settled'); }
async function newChat() { await page.getByRole('button',{name:'新建对话',exact:true}).click(); await input().waitFor(); }
const errors = snapshot => snapshot.timeline.flatMap(item => item.parts ?? []).filter(part => part.kind==='notice'&&part.level==='error');
try {
  if (mode==='dev') {
    const {createServer} = await import('vite');
    vite = await createServer({configFile:path.resolve('vite.config.ts'),cacheDir:path.join(userData,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});
    await vite.listen(); process.env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];
  } else delete process.env.VITE_DEV_SERVER_URL;
  await launch();
  await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({id:'pc-goals',name:'PC 目标验收',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'pc-goals',thinkingLevel:'off',supportsVision:false}],makeDefault:true}),baseUrl);
  await page.reload(); await input().waitFor();
  const chunkId = await send('PC_GOAL_CHUNK 读取现有记录后写入 chunk-proof.txt，内容 PC_CHUNK_PROOF。');
  const chunkFlow = await settled(chunkId), chunkRun = Object.values(chunkFlow.runs)[0], chunkRoot = journal().roots[chunkRun.runId];
  assert.equal(chunkRun.outcome,'completed',JSON.stringify(chunkFlow.timeline)); assert.deepEqual(errors(chunkFlow),[]);
  assert.equal(chunkFlow.timeline.filter(item => item.kind==='user').length,1); assert.equal(chunkRoot.goal.round,2);
  assert.equal(chunkRoot.goal.policy.maxRequestsPerRound,60); assert.equal(chunkRoot.goal.limitHistory[0].limit,60);
  assert.deepEqual(chunkRoot.goal.verifications.map(item => item.status),['continue','complete']);
  assert.equal(fs.readFileSync(path.join(workspace,'chunk-proof.txt'),'utf8'),'PC_CHUNK_PROOF');
  const rows = Object.values(journal().requests).filter(row => row.owner.rootRunId===chunkRun.runId);
  assert.equal(rows.filter(row => row.purpose==='main').length,62); assert.equal(rows.filter(row => row.purpose==='goal-verification').length,2);
  assert.ok(rows.every(row => row.endedAt));
  const archive = await page.evaluate(cid => window.hemiVoice.openConversation(cid),chunkId);
  assert.ok(archive.usageLedger.filter(row => row.requestedModel==='pc-goals').length>=64,'execution and goal verification usage must both be recorded');
  await page.screenshot({path:path.join(evidence,'chunk-completed.png')});
  check('默认 60 次触顶后同一输入/运行自动续跑，真实写入文件，校验和用量均入账');

  await newChat(); const waitId=await send('PC_GOAL_WAIT 先保存现有成果，然后询问我文件内容。');
  const waiting = await settled(waitId), originalRun = waiting.awaitingUser.runId;
  assert.equal(waiting.runs[originalRun].outcome,'awaiting-user'); assert.deepEqual(errors(waiting),[]);
  assert.equal(journal().roots[originalRun].status,'awaiting_user');
  await page.getByText('等待你的回复',{exact:true}).waitFor(); await page.screenshot({path:path.join(evidence,'awaiting-user.png')});
  assert.equal(await page.locator('.turn-error-notice').count(),0);
  await app.close(); await launch();
  const requestCount = Object.keys(journal().requests).length;
  await page.getByText('等待你的回复',{exact:true}).waitFor(); await page.waitForTimeout(200);
  assert.equal(Object.keys(journal().requests).length,requestCount); assert.equal((await flow(waitId)).awaitingUser.runId,originalRun);
  await send('文件内容写入 CLARIFIED_VALUE。'); const answered=await settled(waitId,2), answerRun=Object.values(answered.runs).at(-1), answerRoot=journal().roots[answerRun.runId];
  assert.equal(answerRun.outcome,'completed'); assert.equal(answerRun.continuationOf,originalRun); assert.equal(answerRoot.goal.id,originalRun);
  assert.equal(journal().roots[originalRun].status,'continued'); assert.equal(answerRoot.goal.replies.length,1); assert.equal(answered.awaitingUser,null);
  assert.equal(fs.readFileSync(path.join(workspace,'clarified-proof.txt'),'utf8'),'CLARIFIED_VALUE'); assert.deepEqual(errors(answered),[]);
  assert.equal(Object.values(journal().observations).filter(row => row.tool==='write'&&row.owner.rootRunId===originalRun).length,1);
  check('必要提问正常等待，应用重启不自动执行；用户回答续接原目标并保留已有成果');

  await newChat(); const waitStopId=await send('PC_GOAL_WAIT_STOP 先保存现有成果，再询问文件内容。');
  const waitStop=await settled(waitStopId), waitStopRun=waitStop.awaitingUser.runId;
  await app.close(); await launch();
  await page.getByText('等待你的回复',{exact:true}).waitFor();
  await page.evaluate(({cid,runId}) => window.hemiVoice.flowCommand(cid,{type:'stop',targetRunId:runId}),{cid:waitStopId,runId:waitStopRun});
  assert.equal((await flow(waitStopId)).awaitingUser,null); assert.equal(journal().roots[waitStopRun].status,'cancelled');
  check('显式停止等待同时取消持久目标，不留下幽灵等待');

  await newChat(); const stopId=await send('PC_GOAL_STOP 等待校验期间我会停止。');
  await wait(() => held.size===1,'verifier request in flight');
  const stopRun=(await flow(stopId)).activeRunId;
  await page.evaluate(({cid,runId}) => window.hemiVoice.flowCommand(cid,{type:'stop',targetRunId:runId}),{cid:stopId,runId:stopRun});
  const stopped=await settled(stopId); assert.equal(stopped.runs[stopRun].outcome,'stopped'); assert.notEqual(journal().roots[stopRun].goal.phase,'complete');
  for (const item of held) respond(item.res,item.body,JSON.stringify(verdict('continue','迟到校验',['不应执行'])));
  await page.waitForTimeout(150); assert.equal(counts.get('PC_GOAL_STOP'),1);
  check('停止取消真实在途完成校验，迟到结果不能触发续跑');

  await newChat(); const blockedId=await send('PC_GOAL_BLOCKED 尝试访问外部资源，按实际结果处理。');
  const blocked=await settled(blockedId),blockedRun=Object.values(blocked.runs)[0];
  assert.equal(blockedRun.outcome,'blocked');assert.equal(journal().roots[blockedRun.runId].status,'blocked');assert.deepEqual(errors(blocked),[]);
  assert.match(blockedRun.blocked.reason,/外部资源不可用/);assert.equal(blocked.activeRunId,null);
  await page.getByText(/任务受阻：实际命令已确认外部资源不可用/).waitFor();assert.equal(await page.locator('.turn-error-notice').count(),0);
  const blockedRequests=Object.keys(journal().requests).length;
  await app.close();await launch();await page.getByText(/任务受阻：实际命令已确认外部资源不可用/).waitFor();
  assert.equal(Object.keys(journal().requests).length,blockedRequests);assert.equal((await flow(blockedId)).runs[blockedRun.runId].outcome,'blocked');
  await page.screenshot({path:path.join(evidence,'blocked-normal-result.png')});
  check('真实工具失败交回主 agent，blocked 正常收口并展示普通说明；重启保持阻塞且不自动重跑');

  await newChat(); const invalidId=await send('PC_GOAL_INVALID 校验异常不得判定完成。');
  const invalid=await settled(invalidId); assert.equal(Object.values(invalid.runs)[0].outcome,'failed');
  assert.equal(errors(invalid).length,1); assert.match(errors(invalid)[0].text,/JSON/);
  await wait(async () => await page.locator('.turn-error-notice').count()===1,'one visible error notice');
  check('完成校验失败保留未完成状态，界面只显示一条错误');
  assert.deepEqual(report.errors,[]); report.result='PASS';
} catch (error) {
  report.result='FAIL'; report.failure=String(error.stack); if (page&&!page.isClosed()) await page.screenshot({path:path.join(evidence,'failure.png')}).catch(() => {});
  throw error;
} finally {
  await app?.close().catch(() => {}); for (const item of held) item.res.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await vite?.close();
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
  if (report.result==='PASS') fs.rmSync(userData,{recursive:true,force:true});
  else console.log(`Isolated failure data: ${userData}`);
}
