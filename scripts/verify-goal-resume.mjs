import {readRunJournalFileSync} from '../src/main/agent-runtime/journal-inspection.mjs';
// Goal-resume 真实链路验证：运行 → 用户显式停止 → goal-resume 命令 → 续跑 → 完成，
// 外加恢复进行中重复恢复被拒；渲染层场景：目标横幅出现 + 点击「恢复」按钮续跑、
// 输入框「继续」精确命中白名单 → goal-resume（原话时间线回显）、
// 「继续，但换个思路」→ 普通文本回合，以及语音定稿恢复的回显排序。
// 仅合成模型响应、ASR 服务与静音采集设备；文件、IPC、账本、flow 和渲染器均走真实实现。
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
import {WebSocketServer} from 'ws';
import {IPC} from '../src/shared/ipc-channels.mjs';

const mode = process.argv.includes('--dev') ? 'dev' : 'built';
const evidence = path.resolve('.visual/workflow/goal-resume-history', mode);
const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hemi-goal-resume-${mode}-`)));
const workspace = path.join(userData, 'workspace/default');
fs.mkdirSync(workspace, {recursive:true}); fs.mkdirSync(evidence, {recursive:true});
fs.writeFileSync(path.join(workspace,'seed.txt'), 'GOAL_RESUME_SEED');
fs.writeFileSync(path.join(userData,'onboarding.json'), JSON.stringify({version:2,phase:'complete',step:'done',completedAt:Date.now()}));
fs.writeFileSync(path.join(userData,'appearance.json'), JSON.stringify({schemaVersion:1,skinId:'classic',mode:'light'}));
const report = {mode,startedAt:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:true,node:process.version,platform:`${process.platform}/${process.arch}`,checks:[],errors:[],requests:[]};
const held = new Set();
// UI 排序检查时停在真实首字前状态，避免用固定延时碰运气截图。
const pausedResumes = new Set();
const heldResumes = new Map();
const releaseResume = marker => { pausedResumes.delete(marker); heldResumes.get(marker)?.(); heldResumes.delete(marker); };
const pausedInputs = new Set();
const heldInputs = new Map();
const releaseInput = text => { pausedInputs.delete(text); heldInputs.get(text)?.(); heldInputs.delete(text); };
let app, page, vite;
const verdict = (status, reason, remaining = [], question) => ({status,reason,evidence:['实际会话与真实工具结果'],remaining,nextAction:status === 'continue' ? '写入剩余成果' : '',...(question ? {question} : {})});
const MARKER = 'PC_GOAL_RESUME';
// 多轮目标各用各的 marker：stage-<marker>.txt / proof-<marker>.txt 区分产物，
// 避免第二轮目标看到上一轮 proof 立即判完成。
const markerOf = value => (String(value).match(/PC_[A-Z0-9_]+/g) ?? [])[0] ?? null;
const stagePath = marker => path.join(workspace, `stage-${marker}.txt`);
const proofPath = marker => path.join(workspace, `proof-${marker}.txt`);
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
    const body = JSON.parse(raw);
    const checking = body.messages.some(message => message.role==='system' && JSON.stringify(message.content).includes(GOAL_CHECK_SYSTEM)), main = Boolean(body.tools?.length);
    const userTexts = body.messages.filter(message => message.role==='user').map(message => typeof message.content==='string' ? message.content
      : Array.isArray(message.content) ? message.content.filter(part => part.type==='text').map(part => part.text).join('\n') : JSON.stringify(message.content)).reverse();
    const texts = checking ? [JSON.parse(userTexts[0]).objective] : userTexts;
    // 当前消息的宿主事实锚点会引用历史目标；模拟服务只按用户输入或恢复正文选择场景。
    const currentText = (texts[0] ?? '').split('\n\n【本轮事实锚点】')[0];
    const resumeTurn = !checking && currentText.startsWith('［宿主目标恢复');
    const marker = markerOf(currentText);
    report.requests.push({marker,text:currentText.slice(0, 60),checking,main,model:body.model,resumeContext:resumeTurn,tools:body.tools?.length ?? 0});
    if (!main && !checking) { respond(res,body,marker ?? 'PC 验收'); return; }
    if (checking) {
      assert.equal(body.tools?.length ?? 0,0); assert.equal(body.tool_choice,'none');
      // 完成校验只认真实产物（无 marker 的普通目标直接判完成）；带 marker 的
      // 第一段产物在途时挂起，等用户停止或恢复后收口。
      if (marker && !fs.existsSync(proofPath(marker))) { const entry = {res,body}; held.add(entry); res.on('close', () => held.delete(entry)); return; }
      respond(res,body,JSON.stringify(verdict('complete', marker ? '实际文件已写入并核对' : '普通文本回合，无需产物'))); return;
    }
    let content, tool;
    const pausedInput = [...pausedInputs].find(text => (texts[0] ?? '').includes(text));
    if (pausedInput) await new Promise(resolve => heldInputs.set(pausedInput, resolve));
    // 恢复回合的判定看最后一条 user 消息是否为宿主注入的恢复上下文——
    // 不能全量 includes：历史里会残留早前目标的恢复消息（多轮目标会误判）。
    const resumeMarker = markerOf(resumeTurn ? currentText : '');
    if (resumeTurn) {
      // 恢复回合：宿主注入恢复上下文；UI 检查释放后才开始输出与真实文件操作。
      if (pausedResumes.has(resumeMarker)) await new Promise(resolve => heldResumes.set(resumeMarker, resolve));
      await new Promise(r=>setTimeout(r,400));
      if (fs.existsSync(stagePath(resumeMarker)) && !fs.existsSync(proofPath(resumeMarker))) tool = {name:'write',args:{path:proofPath(resumeMarker),content:`${resumeMarker}_RESUMED`}};
      else content = `恢复后已完成 ${resumeMarker}。`;
    } else if (marker && !fs.existsSync(stagePath(marker))) {
      await new Promise(r=>setTimeout(r,300));
      tool = {name:'write',args:{path:stagePath(marker),content:`${marker}_STAGE`}};
    } else if (marker) {
      await new Promise(r=>setTimeout(r,300));
      content = '第一段成果已写入，等待完成校验。';
    } else content = '等待完成校验。';
    respond(res,body,content,tool);
  } catch (error) { report.errors.push(String(error.stack)); res.destroy(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
// 沿用语音回归的边界：本地 ASR WebSocket＋静音合成设备，定稿经真实 IPC 到提交入口。
const asr = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise(resolve => asr.on('listening', resolve));
let asrSocket;
const asrFrame = (utterances, final = false) => {
  const body = Buffer.from(JSON.stringify({ result: { utterances } }));
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from([0x11, final ? 0x92 : 0x90, 0x10, 0]), size, body]);
};
asr.on('connection', socket => {
  asrSocket = socket;
  socket.on('message', data => {
    if ((data[1] & 0xf) === 3) { socket.send(asrFrame([], true)); socket.close(); }
  });
});
fs.writeFileSync(path.join(userData,'text-model-profiles.json'), JSON.stringify({version:4,thinkingLevel:'off',lastConversationModelKey:'pc-goals/main',roleModels:{main:'pc-goals/main'},providers:[{id:'pc-goals',name:'PC 目标恢复验收',api:'openai-completions',baseUrl,models:[{id:'main',model:'pc-goals',thinkingLevel:'off',supportsVision:false}]}]}));
const wait = async (predicate,label,timeout=45000) => {
  const deadline = Date.now()+timeout;
  while (Date.now()<deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve,50)); }
  throw new Error(`Timeout: ${label}`);
};
const check = name => { report.checks.push(name); console.log(`PASS ${mode}: ${name}`); };
const flow = cid => page.evaluate(cid => window.hemiVoice.flowGetSnapshot(cid),cid);
const journal = () => readRunJournalFileSync(path.join(userData,'runtime-v2/run-journal.json'));
const input = () => page.locator('textarea.text-composer-input');
const goalBar = () => page.locator('.h24-goal-bar');
const assertNoLegacyResume = async () => {
  assert.equal(await page.getByRole('button', {name:'继续任务',exact:true}).count(), 0, '旧「继续任务」按钮必须退役');
  assert.equal(await page.locator('.h24-queue-resume-only').count(), 0, '空队列不再渲染目标恢复分支');
};
async function assertEchoOrder(text, runId, {waiting = true, call = false} = {}) {
  const row = page.locator(`[data-run-id="${runId}"]`).first();
  if (waiting) await row.locator('.h24-waiting-status').waitFor({state:'visible'});
  await row.scrollIntoViewIfNeeded();
  const order = await page.evaluate(({text,runId}) => {
    const rows = [...document.querySelectorAll('.conversation-list [data-flow-row]')];
    const echo = rows.find(node => node.querySelector('.h24-user-bubble')?.textContent.trim() === text);
    const response = rows.find(node => node.getAttribute('data-run-id') === runId);
    const following = element => Boolean(echo && (echo.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
    const echoBox = echo?.querySelector('article')?.getBoundingClientRect();
    const responseBox = response?.querySelector('article')?.getBoundingClientRect();
    // 顶栏通话图标是全局状态；只核对对话区/输入区的活动指示。
    const activity = [...document.querySelectorAll('.h24-main .h24-waiting-status, .h24-main .h56-run-activity, .h24-main .h37-call-activity')];
    return {text,runId,echoIndex:rows.indexOf(echo),responseIndex:rows.indexOf(response),
      echoBottom:echoBox?.bottom,responseTop:responseBox?.top,
      activities:activity.map(node => ({className:node.className,afterEcho:following(node)})),
      callIndicators:document.querySelectorAll('.h24-composer .h37-call-activity').length};
  }, {text,runId});
  assert.ok(order.echoIndex >= 0, '本地原话必须在时间线内');
  assert.equal(order.responseIndex, order.echoIndex + 1, '回显后紧跟当前运行占位/回复，不插入其他内容');
  assert.ok(order.echoBottom <= order.responseTop, '视觉位置必须是用户气泡在上、活动/回复在下');
  assert.ok(order.activities.every(item => item.afterEcho), '对话/输入区的全部活动指示必须在原话之后');
  if (call) assert.equal(order.callIndicators, 1, '语音恢复期间通话活动指示仍在输入区');
  (report.echoOrder ??= []).push(order);
}
async function launch() {
  app = await _electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,HEMI_USER_DATA_DIR:userData,HEMI_TEST_MIC_GRANT:'1',HEMI_LLM_API_KEY:'SYNTHETIC_ONLY',HEMI_LLM_BASE_URL:baseUrl,HEMI_LLM_MODEL:'pc-goals',DOUBAO_ASR_ENDPOINT:`ws://127.0.0.1:${asr.address().port}`}});
  await wait(() => { page=app.windows().find(p => /^(?:file|http):/.test(p.url())&&!new URL(p.url()).searchParams.has('mode')); return page; },'main window');
  page.setDefaultTimeout(15000); page.on('pageerror',error => report.errors.push(error.message));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), destination = context.createMediaStreamDestination();
      const source = context.createConstantSource(); source.offset.value = 0; source.connect(destination); source.start();
      const stream = destination.stream;
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track); track.stop = () => { stop(); void context.close(); };
      }
      return stream;
    };
  });
  // 只替换硬件获取边界，绝不启动真实麦克风或 native duplex 设备。
  await app.evaluate(({ipcMain}, channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => ({ok:false,reason:'isolated-device-test'}));
  }, IPC.duplex.start);
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
const errors = snapshot => snapshot.timeline.flatMap(item => item.parts ?? []).filter(part => part.kind==='notice'&&part.level==='error');
const stopRun = (cid, runId) => page.evaluate(({cid,runId}) => window.hemiVoice.flowCommand(cid,{type:'stop',targetRunId:runId}),{cid,runId});
const waitForResumable = async cid => wait(async()=>{const v=await flow(cid);return v.goal?.resumable===true?v.goal:null;},'goal projected as resumable');
const continuationRuns = async (cid, sourceRunId) => { const value = await flow(cid); return Object.values(value.runs).filter(run => run.continuationOf===sourceRunId); };
try {
  if (mode==='dev') {
    const {createServer} = await import('vite');
    vite = await createServer({configFile:path.resolve('vite.config.ts'),cacheDir:path.join(userData,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false}});
    await vite.listen(); process.env.VITE_DEV_SERVER_URL=vite.resolvedUrls.local[0];
  } else delete process.env.VITE_DEV_SERVER_URL;
  await launch();
  await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({id:'pc-goals',name:'PC 目标恢复验收',api:'openai-completions',baseUrl,apiKey:'SYNTHETIC_ONLY',models:[{id:'main',model:'pc-goals',thinkingLevel:'off',supportsVision:false}]}),baseUrl);
  await page.evaluate(() => window.hemiVoice.saveConfig({apiKey:'SYNTHETIC_ONLY',ttsEnabled:false}));
  await page.reload(); await input().waitFor();

  // 1) 真实目标运行：第一段写 stage 文件；完成校验在途时用户显式停止。
  const cid = await send('PC_GOAL_RESUME 先做第一段，我会在校验期间停止，然后再显式恢复。');
  await wait(() => held.size===1,'verifier request in flight');
  assert.ok(fs.existsSync(stagePath(MARKER)),'first stage effect is real');
  const originalRun = (await flow(cid)).activeRunId;
  await stopRun(cid, originalRun);
  const stopped = await settled(cid);
  assert.equal(stopped.runs[originalRun].outcome,'stopped'); assert.deepEqual(errors(stopped),[]);
  const stoppedRoot = journal().roots[originalRun];
  assert.equal(stoppedRoot.status,'cancelled');
  assert.notEqual(stoppedRoot.goal.phase,'complete');
  check('真实目标运行中被停止：run stopped、账本 root cancelled 且目标未完成');

  // 2) 停止后 flow 快照投影可恢复目标，恢复入口只留目标横幅。
  await waitForResumable(cid);
  await goalBar().waitFor({state:'visible'});
  await assertNoLegacyResume();
  assert.equal((await flow(cid)).goal.goalId,originalRun);
  await page.screenshot({path:path.join(evidence,'stopped-resumable.png')});
  check('停止后快照 goal 投影标记可恢复，goalId 指向停止的根目标');

  // 3) 用户显式恢复：新建 root 接续原目标；宿主恢复上下文进入真实模型请求。
  const accepted = await page.evaluate(cid => window.hemiVoice.flowCommand(cid,{type:'goal-resume'}),cid);
  assert.equal(accepted.ok,true); assert.equal(accepted.disposition,'started');
  const resumedRunId = accepted.runId;
  assert.notEqual(resumedRunId,originalRun);
  await wait(()=>report.requests.some(r=>r.resumeContext&&r.main),'resume context reaches real model request');
  await wait(async()=>{const v=await flow(cid);return v.runs[resumedRunId]?.continuationOf===originalRun;},'restored run continues original root');
  check('goal-resume 受理并启动恢复回合：continuationOf 指向来源 root，恢复上下文进入模型请求');

  // 4) 恢复进行中重复恢复被拒（幂等无害）。
  const busyAgain = await page.evaluate(cid => window.hemiVoice.flowCommand(cid,{type:'goal-resume'}),cid);
  assert.equal(busyAgain.ok,false); assert.equal(busyAgain.code,'busy');

  // 5) 恢复回合续跑至完成校验收口；账本保持「新建 root 接续」形状。
  const resumed = await settled(cid,2);
  assert.equal(resumed.runs[resumedRunId].outcome,'completed'); assert.deepEqual(errors(resumed),[]);
  assert.equal(fs.readFileSync(proofPath(MARKER),'utf8'),`${MARKER}_RESUMED`);
  const resumedRoot = journal().roots[resumedRunId];
  assert.equal(resumedRoot.goal.id,originalRun,'restored goal keeps the original goal.id');
  assert.equal(resumedRoot.goal.continuedFrom,originalRun);
  assert.equal(resumedRoot.status,'completed');
  assert.equal(resumedRoot.goal.phase,'complete');
  assert.equal(journal().roots[originalRun].status,'continued');
  assert.equal(journal().roots[originalRun].goal.phase,'continued');
  check('恢复回合续跑完成：新 root completed、goal.id/continuedFrom 保持接续，旧 root 标 continued');

  // 6) 完成后无可恢复目标；再次 goal-resume 如实拒绝。
  await wait(async()=>{const v=await flow(cid);return v.goal===null;},'completed goal leaves no resumable projection');
  const denied = await page.evaluate(cid => window.hemiVoice.flowCommand(cid,{type:'goal-resume'}),cid);
  assert.equal(denied.ok,false); assert.equal(denied.code,'goal-not-resumable');
  assert.equal(denied.message,'没有可恢复的任务。');
  await page.screenshot({path:path.join(evidence,'resume-completed.png')});
  check('完成后 goal 投影清空，重复恢复如实拒绝并带中文说明');

  // 7) 渲染层 UI：停止后目标横幅出现并带「恢复」按钮；点击按钮（真实 UI 点击，
  //    不直发命令）续跑完成；完成后横幅消失。
  const UI_MARKER = 'PC_RESUME_UI';
  await send(`${UI_MARKER} 先做第一段，稍后停止再用横幅上的恢复按钮续跑。`);
  await wait(() => held.size===1,'ui verifier request in flight');
  assert.ok(fs.existsSync(stagePath(UI_MARKER)),'ui scenario stage effect is real');
  const uiSourceRun = (await flow(cid)).activeRunId;
  await stopRun(cid, uiSourceRun);
  await settled(cid,3);
  await waitForResumable(cid);
  await goalBar().waitFor({state:'visible'});
  assert.equal(await goalBar().getAttribute('data-resumable'),'true');
  const resumeButton = goalBar().locator('.h24-goal-resume');
  await resumeButton.waitFor({state:'visible'});
  assert.equal(await resumeButton.count(),1,'横幅只提供一个恢复按钮');
  await assertNoLegacyResume();
  check('入口收敛：停止后只有目标横幅「恢复」，没有旧「继续任务」按钮或空队列恢复条');
  await page.screenshot({path:path.join(evidence,'ui-goal-bar-resumable.png')});
  await resumeButton.click();
  await wait(async()=>(await continuationRuns(cid,uiSourceRun)).length>0,'goal bar resume button starts continuation run');
  check('目标横幅：停止后出现（可恢复态）并带「恢复」按钮，点击按钮启动恢复回合');
  const uiSettled = await settled(cid,4);
  assert.equal(fs.readFileSync(proofPath(UI_MARKER),'utf8'),`${UI_MARKER}_RESUMED`);
  assert.deepEqual(errors(uiSettled),[]);
  await wait(async()=>{const v=await flow(cid);return v.goal===null;},'ui goal completes and clears projection');
  await goalBar().waitFor({state:'detached'});
  await page.screenshot({path:path.join(evidence,'ui-goal-bar-completed.png')});
  check('目标横幅：按钮恢复后续跑完成（真实产物核对），完成后横幅消失');

  // 8) 历史停止目标不能在新普通问答中反复冒出；最新目标停止后仍可正常恢复。
  const TEXT_MARKER = 'PC_RESUME_TEXT';
  await send(`${TEXT_MARKER} 先做第一段，稍后停止后我会输入继续类指令。`);
  await wait(() => held.size===1,'whitelist verifier request in flight');
  let textSourceRun = (await flow(cid)).activeRunId;
  await stopRun(cid, textSourceRun);
  await settled(cid,5);
  const historicalProjection = await waitForResumable(cid);
  // 8a) 白名单外文本是独立新目标；在真实模型首字前挂住，核对旧条即时消失。
  const ordinaryInput = '继续，但换个思路';
  pausedInputs.add(ordinaryInput);
  await input().fill(ordinaryInput); await input().press('Enter');
  await wait(() => heldInputs.has(ordinaryInput),'ordinary question held before first output');
  assert.notEqual((await flow(cid)).goal?.resumable,true,'新普通回合运行中不能保留旧恢复状态');
  await goalBar().waitFor({state:'detached'});
  await assertNoLegacyResume();
  await page.screenshot({path:path.join(evidence,'ordinary-running-no-goal-bar.png')});
  check('停止旧目标后提出普通问题：新回合首字前不再显示旧恢复条');
  releaseInput(ordinaryInput);
  await wait(async()=>{const v=await flow(cid);return v.phase==='idle'&&Object.keys(v.runs).length===6&&v.goal===null;},'ordinary question completed without reviving old goal');
  assert.ok(report.requests.some(r=>r.main&&!r.resumeContext&&(r.text ?? '').includes(ordinaryInput)),'non-whitelist text reaches the model as a normal turn');
  assert.equal((await continuationRuns(cid,textSourceRun)).length,0,'non-whitelist text must not trigger goal-resume');
  const historicalGoal = textSourceRun;
  for (const goalId of [undefined,historicalGoal]) {
    const receipt = await page.evaluate(({cid,goalId}) => window.hemiVoice.flowCommand(cid,{type:'goal-resume',...(goalId?{goalId}:{})}),{cid,goalId});
    assert.equal(receipt.ok,false); assert.equal(receipt.code,'goal-not-resumable');
  }
  await goalBar().waitFor({state:'detached'});
  await page.reload(); await input().waitFor();
  assert.equal((await flow(cid)).goal,null,'重新打开会话也不能复活历史停止目标');
  await goalBar().waitFor({state:'detached'});
  await page.screenshot({path:path.join(evidence,'ordinary-completed-no-goal-bar.png')});
  check('普通问答完成及页面重载后均无旧恢复条；默认和指定历史 goalId 的恢复均被拒');

  // 8a-restart) 持久化注入旧客户端遗留的可恢复投影，再真正重启隔离应用。
  await app.close(); app=null; page=null;
  const conversationFile = path.join(userData,'runtime-v2/conversations',`${cid}.json`);
  const savedConversation = JSON.parse(fs.readFileSync(conversationFile,'utf8'));
  savedConversation.flow.goal = {...historicalProjection,resumable:true};
  fs.writeFileSync(conversationFile,JSON.stringify(savedConversation,null,2));
  await launch(); await input().waitFor();
  assert.equal((await flow(cid)).goal,null,'应用重启恢复账本时必须清掉被新普通目标遮蔽的旧投影');
  await goalBar().waitFor({state:'detached'});
  await page.screenshot({path:path.join(evidence,'ordinary-restarted-no-goal-bar.png')});
  check('隔离应用真实重启后，旧持久恢复条不会复活');

  // 8b) 新建当前目标再停止：精确白名单仍只接续这个最新目标。
  await send(`${TEXT_MARKER} 新目标做到第一段，停止后输入继续。`);
  await wait(() => held.size===1,'latest text goal verifier in flight');
  textSourceRun = (await flow(cid)).activeRunId;
  await stopRun(cid,textSourceRun);
  await settled(cid,7);
  const latestResume = await waitForResumable(cid);
  assert.equal(latestResume.goalId,textSourceRun);
  await app.close(); app=null; page=null;
  await launch(); await input().waitFor();
  assert.equal((await flow(cid)).goal?.goalId,textSourceRun,'最新停止目标的恢复投影应跨应用重启保留');
  assert.equal((await flow(cid)).goal?.resumable,true,'重启清理旧投影不能误清真正的最新停止目标');
  await goalBar().waitFor();
  check('最新停止目标的恢复入口跨隔离应用重启保留，可继续原目标');
  pausedResumes.add(TEXT_MARKER);
  await input().fill('继续'); await input().press('Enter');
  const [textResume] = await wait(async()=>{const runs=await continuationRuns(cid,textSourceRun);return runs.length ? runs : null;},'whitelist phrase triggers goal-resume');
  await wait(()=>heldResumes.has(TEXT_MARKER),'text resume held before first output');
  await wait(() => page.locator('.h24-user-bubble').evaluateAll(nodes => nodes.some(node => (node.textContent ?? '').trim()==='继续')),'「继续」原话在时间线以用户气泡回显');
  await wait(async()=>{const v=await flow(cid);return !v.pending.some(item=>item.text==='继续');},'「继续」不是排队的普通输入');
  await assertEchoOrder('继续',textResume.runId);
  await assertNoLegacyResume();
  await page.screenshot({path:path.join(evidence,'ui-continue-whitelist.png')});
  check('输入「继续」精确命中白名单：改发 goal-resume；用户回显在前，「正在想」占位紧随其后');
  releaseResume(TEXT_MARKER);
  const textSettled = await settled(cid,8);
  assert.equal(fs.readFileSync(proofPath(TEXT_MARKER),'utf8'),`${TEXT_MARKER}_RESUMED`);
  assert.deepEqual(errors(textSettled),[]);
  await page.locator(`[data-run-id="${textResume.runId}"] .h24-waiting-status`).waitFor({state:'detached'});
  await assertEchoOrder('继续',textResume.runId,{waiting:false});
  await page.screenshot({path:path.join(evidence,'ui-continue-completed.png')});
  check('「继续」恢复回合续跑完成（真实产物核对），回显仍在完成回复之前');

  // 9) 普通文本回合回归：无 marker 输入走原文本回合并得到模型回应。
  const rootsBefore = Object.keys(journal().roots).length;
  await send('继续，但换个思路这个说法只是普通输入');
  await wait(async()=>{const v=await flow(cid);return v.phase==='idle'&&Object.keys(v.runs).length===9;},'plain text turn settled');
  assert.ok(report.requests.some(r=>r.main&&!r.checking&&(r.text ?? '').includes('这个说法只是普通输入')),'plain text reaches the model');
  assert.equal(Object.keys(journal().roots).length,rootsBefore+1,'plain turn opens its own root, not a goal-resume continuation');
  assert.equal((await continuationRuns(cid,textSourceRun)).length,1,'plain turn does not extend the resumed goal');
  check('普通输入回归：走原文本回合（模型收到原文），不触发 goal-resume 续接');

  // 10) 沿用前一批已加入的 ASR/静音设备边界：真实通话定稿走同一个回显排序路径。
  const VOICE_MARKER = 'PC_RESUME_VOICE';
  await send(`${VOICE_MARKER} 先做第一段，停止后我会在通话中说接着做。`);
  await wait(()=>held.size===1,'voice verifier request in flight');
  const voiceSourceRun = (await flow(cid)).activeRunId;
  await stopRun(cid,voiceSourceRun);
  await settled(cid,10);
  await waitForResumable(cid);
  await assertNoLegacyResume();
  pausedResumes.add(VOICE_MARKER);
  await page.getByRole('button',{name:'开始通话',exact:true}).click();
  await wait(async()=>asrSocket?.readyState===1 && (await page.evaluate(()=>window.hemiVoice.getUiState())).sessionState==='listening','isolated voice call ready');
  asrSocket.send(asrFrame([{text:'接着做',start_time:0,end_time:100,definite:true,additions:{speaker_id:'1'}}]));
  const [voiceResume] = await wait(async()=>{const runs=await continuationRuns(cid,voiceSourceRun);return runs.length ? runs : null;},'voice phrase triggers goal-resume');
  await wait(()=>heldResumes.has(VOICE_MARKER),'voice resume held before first output');
  assert.equal((await flow(cid)).pending.some(item=>item.text==='接着做'),false,'语音白名单不进入普通输入队列');
  await assertEchoOrder('接着做',voiceResume.runId,{call:true});
  await assertNoLegacyResume();
  await page.screenshot({path:path.join(evidence,'ui-voice-continue-whitelist.png')});
  check('语音定稿「接着做」触发 goal-resume：原话气泡在前，占位与通话活动指示均在后');
  releaseResume(VOICE_MARKER);
  const voiceSettled = await settled(cid,11);
  assert.equal(fs.readFileSync(proofPath(VOICE_MARKER),'utf8'),`${VOICE_MARKER}_RESUMED`);
  assert.deepEqual(errors(voiceSettled),[]);
  await page.locator(`[data-run-id="${voiceResume.runId}"] .h24-waiting-status`).waitFor({state:'detached'});
  await assertEchoOrder('接着做',voiceResume.runId,{waiting:false,call:true});
  await goalBar().waitFor({state:'detached'});
  await page.screenshot({path:path.join(evidence,'ui-voice-continue-completed.png')});
  await page.getByRole('button',{name:'结束通话',exact:true}).click();
  await wait(async()=>!(await page.evaluate(()=>window.hemiVoice.getUiState())).callActive,'isolated voice call ended');
  check('语音恢复续跑完成、横幅消失且回显位置不变；测试通话正常挂断');

  assert.deepEqual(report.errors,[]); report.result='PASS';
} catch (error) {
  report.result='FAIL'; report.failure=String(error.stack); if (page&&!page.isClosed()) await page.screenshot({path:path.join(evidence,'failure.png')}).catch(() => {});
  throw error;
} finally {
  for (const marker of pausedResumes) releaseResume(marker);
  for (const text of pausedInputs) releaseInput(text);
  await app?.close().catch(() => {}); for (const item of held) item.res.destroy();
  for (const client of asr.clients) client.terminate();
  await new Promise(resolve => asr.close(resolve));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await vite?.close();
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
  if (report.result==='PASS') fs.rmSync(userData,{recursive:true,force:true});
  else console.log(`Isolated failure data: ${userData}`);
}
