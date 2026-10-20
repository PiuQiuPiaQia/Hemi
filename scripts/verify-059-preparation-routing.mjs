// 生产 preload IPC → 主 agent → 准备卡工具/工作流 → flow/档案。只替换外部 provider。
// HEMI_SMOKE_TEST=1 npx electron scripts/verify-059-preparation-routing.mjs
// HEMI059_PREP_REAL=1 使用本机默认组的真实模型（不跑可控慢工具停止场景）。
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const sourceRoot = path.resolve(process.env.HEMI059_SOURCE_ROOT ?? 'src');
const source = relative => import(pathToFileURL(path.join(sourceRoot, relative)).href);

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hemi059-prep-')));
app.setName('hemi');
app.setPath('userData', path.join(temp, 'ud'));
const real = process.env.HEMI059_PREP_REAL === '1';
const evidence = path.resolve(process.env.HEMI059_EVIDENCE ?? `.visual/workflow/vision/059-preparation-routing/${real ? 'real' : 'controlled'}`);
fs.mkdirSync(evidence, { recursive: true });
const marker = `PREP-${Date.now()}`, wire = [], checks = [], rendererErrors = [];
const messages = [
  '我是让你改工作流，不是提供参数。这里只需回复“已收到”。',
  '这个工作流开始不应该缺少参数，这都是模型应该自动生成的。这里只需回复“已收到”。',
  '先聊别的：不用联网，回复一句你好。',
];
let targetInvocationId = null, win;
const started = path.join(temp, 'started'), late = path.join(temp, 'late');
const queueStarted = path.join(temp, 'queue-started'), queueEffects = path.join(temp, 'queue-effects');
const outputFile = path.join(temp, 'ud/workspace/default/auto-result.txt');
const seedFile = path.join(temp, 'ud/workspace/default/episodes.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); assert.ok(ok, name); console.log('PASS', name); };
const wait = async (name, read, timeout = real ? 180000 : 20000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await read(); if (value) return value; await sleep(50); }
  throw new Error(`等待超时：${name}`);
};
const js = source => win.webContents.executeJavaScript(source);
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    const body = JSON.parse(raw), text = JSON.stringify(body.messages);
    const lastUser = [...body.messages].reverse().find(message => message.role === 'user');
    const user = typeof lastUser?.content === 'string' ? lastUser.content : (lastUser?.content ?? []).map(block => block.text ?? '').join('\n');
    const last = body.messages.at(-1);
    const call = [...body.messages].reverse().find(message => message.tool_calls?.length)?.tool_calls.at(-1)?.function;
    const args = call?.arguments ? JSON.parse(call.arguments) : {};
    const toolText = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map(block => block.text ?? '').join('');
    let toolResult; try { toolResult = JSON.parse(toolText); } catch {}
    const node = user.includes('［工作流节点执行');
    const instruction = node ? user : user.split('\n\n')[0];
    wire.push({ prep: text.includes('［工作流补参'), node, tools: (body.tools ?? []).map(tool => tool.function.name), text, images: text.includes('image_url'), model: body.model });
    let content = `主 agent 已收到 ${marker}`, tool;
    if (instruction.includes('AUTO_GENERATE')) {
      if (last?.role !== 'tool') tool = { name: 'read', args: { path: seedFile } };
      else content = '```json\n' + JSON.stringify({ episode: 'zp009' }) + '\n```';
    } else if (instruction.includes('AUTO_WRITE')) {
      if (last?.role !== 'tool') tool = { name: 'write', args: { path: outputFile, content: `${marker} ${user.match(/- episode = ([^\n]+)/)?.[1]}` } };
      else content = '```json\n' + JSON.stringify({ file: outputFile }) + '\n```';
    } else if (instruction.includes('STOP_PREP')) {
      if (last?.role !== 'tool') tool = { name: 'bash', args: { command: `printf started > '${started}'; sleep 3; printf late > '${late}'` } };
    } else if (instruction.includes('QUEUE_PREP')) {
      if (last?.role !== 'tool') tool = { name: 'bash', args: { command: `printf started > '${queueStarted}'; printf q >> '${queueEffects}'; sleep 1` } };
    } else if (instruction.includes('本次运行的主题用月报')) {
      if (last?.role !== 'tool') tool = { name: 'workflow_preparation', args: { action: 'get', invocationId: targetInvocationId } };
      else if (args.action === 'get') tool = { name: 'workflow_preparation', args: { action: 'update', invocationId: toolResult.invocationId, expectedDraftRevision: toolResult.draftRevision, set: { topic: '月报' } } };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: marker, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } } : {}) }) + '\n\n');
    chunk({ role: 'assistant', ...(tool ? { tool_calls: [{ index: 0, id: `call-${wire.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content }) });
    chunk({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const document = {
  nodes: [
    { id: 'input', type: 'hemi-input', meta: { position: { x: 60, y: 80 } }, data: { title: '输入', parameters: [{ key: 'topic', type: 'string', required: true, label: '主题' }] } },
    { id: 'agent', type: 'hemi-agent', meta: { position: { x: 300, y: 80 } }, data: { title: '执行', goal: '整理主题', outputSchema: { type: 'object', properties: { result: { type: 'string' } } } } },
    { id: 'end', type: 'hemi-deliver', meta: { position: { x: 540, y: 80 } }, data: { title: '交付', summary: '完成' } },
  ],
  edges: [{ sourceNodeID: 'input', targetNodeID: 'agent' }, { sourceNodeID: 'agent', targetNodeID: 'end' }],
};
app.whenReady().then(async () => {
  let fatal;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    let profiles;
    if (real) {
      const source = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/hemi/text-model-profiles.json'), 'utf8'));
      const provider = source.providers.find(provider => provider.id === 'mp-legacy');
      assert.ok(provider, '真实提供方存在');
      profiles = { version: 3, defaultModelId: `${provider.id}/${provider.models[0].id}`, providers: [{ ...provider, models: [provider.models[0]] }] };
    } else profiles = { version: 3, defaultModelId: 'prep/main', providers: [{ id: 'prep', name: '隔离补参回归', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, encryptedApiKey: safeStorage.encryptString('isolated-test').toString('base64'), models: [{ id: 'main', model: 'prep-model', supportsVision: true }] }] };
    fs.writeFileSync(path.join(app.getPath('userData'), 'text-model-profiles.json'), JSON.stringify(profiles));
    fs.writeFileSync(path.join(app.getPath('userData'), 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now(), updatedAt: Date.now() }));
    await (await source('main/ipc/index.mjs')).registerAllIpcHandlers();
    await (await source('main/windows/main-window.mjs')).createMainWindow();
    win = (await source('main/state.mjs')).state.mainWindow;
    win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
    await wait('preload', () => js('Boolean(window.hemiVoice && document.querySelector("textarea"))'));
    // 冒烟模式抑制自动弹窗；用产品的打开入口显示后，再验证真实窗口和交互。
    (await source('main/windows/main-window.mjs')).showMainWindow();
    await wait('窗口已显示', () => win.isVisible());
    check('真实主窗口可见', win.isVisible());
    const { getWorkflowService } = await source('main/workflows/workflow-service.mjs');
    const service = getWorkflowService();
    await js(`(async()=>{const draft=await window.hemiVoice.workflowSaveDraft('prep-regression',${JSON.stringify(document)},'补参分流验收');await window.hemiVoice.workflowPublish('prep-regression',draft.draftRevision);})()`);
    await js(`document.querySelector('button[title="工作流"]').click()`);
    await wait('工作流列表', () => js(`Boolean(document.querySelector('[data-testid="workflow-row"]'))`));
    await js(`[...document.querySelectorAll('[data-testid="workflow-row"] button')].find(button=>button.textContent.trim()==='去对话运行').click()`);
    await wait('准备卡可见', () => js(`Boolean(document.querySelector('[data-testid="workflow-card"][data-status="preparing"]'))`));
    const prep = (await service.listInvocations({ workflowId: 'prep-regression' }))[0], cid = prep.conversationId;
    targetInvocationId = prep.invocationId;
    fs.writeFileSync(seedFile, JSON.stringify({ episodes: [{ id: 'zp008' }] }));
    const snapshot = () => js(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`);
    const submit = (text, extra = {}) => js(`window.hemiVoice.submitChatTurn(${JSON.stringify({ conversationId: cid, profileId: profiles.defaultModelId, workspaceId: 'default', requestId: `${marker}-${Math.random()}`, inputSource: 'text', messages: [{ role: 'user', content: text }], ...extra })})`);
    const settled = receipt => wait('回合闭合', async () => {
      const flow = await snapshot();
      receipt.runId ??= Object.values(flow.runs).find(run => run.inputIds?.includes(receipt.inputId))?.runId;
      return flow.runs[receipt.runId]?.closedAt ? flow : null;
    });
    const before = (await service.getInvocation(prep.invocationId)).draftRevision;
    let missingRejected = false;
    try { await js(`window.hemiVoice.workflowStartPrepared(${JSON.stringify({ invocationId: prep.invocationId, cardId: prep.cardId, expectedDraftRevision: prep.draftRevision, conversationId: cid, requestId: 'missing-required' })})`); }
    catch { missingRejected = true; }
    check('真正缺必填参数拒绝启动', missingRejected && !(await service.getInvocation(prep.invocationId)).startReceipt);
    for (const text of messages) {
      const receipt = await submit(text), flow = await settled(receipt);
      const record = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'runtime-v2/conversations', `${cid}.json`), 'utf8'));
      check('普通指令进入主 agent 并保存回答', record.turns.some(turn => turn.author === 'hemi' && turn.runId === receipt.runId && turn.text && !turn.id.startsWith('reply-prep-')) && flow.runs[receipt.runId].outcome === 'completed');
      check('普通指令没有修改准备参数或启动工作流', (await service.getInvocation(prep.invocationId)).draftRevision === before && !(await service.getInvocation(prep.invocationId)).startReceipt);
    }
    if (!real) check('provider 实际收到持工具的主模型请求', wire.filter(row => row.tools.includes('write') && row.tools.includes('workflow_preparation')).length >= messages.length && wire.every(row => !row.prep));
    if (!real) {
      const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4ryDwHxkzkC4AAKLAIuEUh8J9AAAAAElFTkSuQmCC';
      const attachment = await js(`window.hemiVoice.attachPasteImage(${JSON.stringify({ conversationId: cid, dataUrl: `data:image/png;base64,${tiny}` })})`);
      check('真实图片已从粘贴入口登记', attachment.ok);
      const imageReceipt = await submit('图片消息仍由主 agent 处理，回复已收到即可', { attachmentIds: [attachment.attachment.attachmentId] });
      const imageFlow = await settled(imageReceipt);
      check('缺参卡存在时原生图片仍到主模型', imageFlow.runs[imageReceipt.runId].outcome === 'completed' && wire.some(row => row.images && row.text.includes(tiny) && row.tools.includes('workflow_preparation')));
      const queuedWork = await submit('QUEUE_PREP');
      await wait('队列前项工具真实开始', () => fs.existsSync(queueStarted));
      const queuedOne = await submit('排队第一条'), queuedTwo = await submit('排队第二条');
      check('忙时两条普通消息确实入队', queuedOne.disposition === 'queued' && queuedTwo.disposition === 'queued' && (await snapshot()).pending.length === 2);
      await settled(queuedWork); await settled(queuedOne);
      const queueFlow = await settled(queuedTwo);
      const queueUsers = queueFlow.timeline.filter(item => item.kind === 'user').map(item => item.id);
      check('队列按身份与发送顺序收口，前项工具只执行一次', queueUsers.indexOf(queuedOne.inputId) < queueUsers.indexOf(queuedTwo.inputId) && queueFlow.runs[queuedOne.runId].outcome === 'completed' && queueFlow.runs[queuedTwo.runId].outcome === 'completed' && fs.readFileSync(queueEffects, 'utf8') === 'q');
    }
    const openParameters = async () => {
      await js(`(()=>{const viewport=document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');if(viewport)viewport.scrollTop=0;})()`);
      await wait('参数卡已滚入可视区', () => js(`[...document.querySelectorAll('[data-testid="workflow-card"] button')].some(button=>button.textContent.trim()==='修改参数')`));
      await js(`(()=>{const button=[...document.querySelectorAll('[data-testid="workflow-card"] button')].find(button=>button.textContent.trim()==='修改参数');button.scrollIntoView({block:'center'});button.click();})()`);
      await wait('对应卡片参数表单', () => js(`Boolean(document.querySelector('[role="dialog"][aria-label="修改本次参数"]'))`));
    };
    const cancelParameters = () => js(`[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent.trim()==='取消').click()`);
    await openParameters(); await cancelParameters();
    await wait('取消表单', () => js(`!document.querySelector('[role="dialog"]')`));
    await openParameters();
    win.setMinimumSize(320, 500);
    for (const width of [1440, 768, 375]) {
      win.setContentSize(width, 812);
      await js(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{})))`);
      check(`参数表单 ${width} 确认按钮可见`, await js(`(()=>{const button=[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent.trim()==='保存参数');const rect=button?.getBoundingClientRect();return Boolean(rect&&rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth)})()`));
      fs.writeFileSync(path.join(evidence, `parameters-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.setContentSize(1200, 812);
    await js(`(()=>{const input=document.querySelector('[role="dialog"] form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'手动主题');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await js(`document.querySelector('[role="dialog"] form').requestSubmit()`);
    await wait('表单保存', () => js(`!document.querySelector('[role="dialog"]')`));
    check('表单更新指定卡且不启动', (await service.getInvocation(prep.invocationId)).preparation.values.topic === '手动主题' && !(await service.getInvocation(prep.invocationId)).startReceipt);
    const receipt = await submit('本次运行的主题用月报'), flow = await settled(receipt);
    const ready = await service.getInvocation(prep.invocationId);
    check('真正补参更新原卡且零执行', ready.preparation.values.topic === '月报' && ready.preparation.ready && !ready.startReceipt);
    const opened = await js(`window.hemiVoice.openConversation(${JSON.stringify(cid)})`);
    const turns = opened.session?.turns ?? opened.turns;
    check('补参输入与回答经打开会话 IPC 可读', turns.some(turn => turn.id === receipt.inputId) && turns.some(turn => turn.runId === receipt.runId && turn.author === 'hemi'));
    check('补参回答跟随同一输入身份', flow.timeline.some(item => item.kind === 'assistant' && item.runId === receipt.runId && item.afterInputId === receipt.inputId));
    check('参数更新由主 agent 实际工具完成', flow.timeline.some(item => item.runId === receipt.runId && item.parts?.some(part => part.kind === 'tool' && part.tool === 'workflow_preparation' && part.status === 'done')));
    for (const parameters of [[], [{ key: 'idea', type: 'text', required: false }]]) {
      const automatic = {
        nodes: [
          { id: 'in', type: 'hemi-input', meta: { position: { x: 40, y: 100 } }, data: { title: '可选输入', parameters } },
          { id: 'plan', type: 'hemi-agent', meta: { position: { x: 280, y: 100 } }, data: { title: '自动定集号', goal: `AUTO_GENERATE 读取 ${seedFile} 的 episodes 数组，找到最大的 zp 编号并加一生成 episode。不要向用户索要集号；可选 idea 没有提供时仍继续。`, inputBindings: parameters.length ? [{ kind: 'parameter', key: 'idea', type: 'string' }] : [], outputSchema: { type: 'object', properties: { episode: { type: 'string' } } } } },
          { id: 'write', type: 'hemi-agent', meta: { position: { x: 520, y: 100 } }, data: { title: '写实际文件', goal: `AUTO_WRITE 用 write 工具创建 ${outputFile}，内容含 ${marker} 和绑定的 episode。必须实际写文件。完成后交付 file。`, inputBindings: [{ kind: 'node-output', nodeId: 'plan', key: 'episode', type: 'string' }], outputSchema: { type: 'object', properties: { file: { type: 'file' } } } } },
          { id: 'end', type: 'hemi-deliver', meta: { position: { x: 760, y: 100 } }, data: { title: '交付', summary: '自动参数文件', artifacts: [{ label: '文件', binding: { kind: 'node-output', nodeId: 'write', key: 'file', type: 'file' } }] } },
        ],
        edges: [{ sourceNodeID: 'in', targetNodeID: 'plan' }, { sourceNodeID: 'plan', targetNodeID: 'write' }, { sourceNodeID: 'write', targetNodeID: 'end' }],
      };
      const id = parameters.length ? 'optional-flow' : 'zero-input-flow';
      const automaticPrep = await js(`(async()=>{const draft=await window.hemiVoice.workflowSaveDraft(${JSON.stringify(id)},${JSON.stringify(automatic)},${JSON.stringify(id)});await window.hemiVoice.workflowPublish(${JSON.stringify(id)},draft.draftRevision);return window.hemiVoice.workflowPrepare({workflowId:${JSON.stringify(id)},conversationId:${JSON.stringify(cid)},entryMode:'chat'});})()`);
      check(`${id} 空输入准备就绪`, automaticPrep.ready);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
      await js(`window.hemiVoice.workflowStartPrepared(${JSON.stringify({ invocationId: automaticPrep.invocationId, cardId: automaticPrep.cardId, expectedDraftRevision: automaticPrep.draftRevision, conversationId: cid, requestId: `${id}-${marker}` })})`);
      const completed = await wait(`${id} 自动生成并交付`, async () => { const invocation = await service.getInvocation(automaticPrep.invocationId); if (invocation.run?.status === 'failed') throw new Error(JSON.stringify(invocation.run.issues)); return invocation.run?.status === 'completed' ? invocation : null; });
      check(`${id} 首节点实际生成，下游实际文件含唯一标记`, completed.run.nodes.plan?.outputs?.episode === 'zp009' && fs.readFileSync(outputFile, 'utf8').includes(marker) && fs.readFileSync(outputFile, 'utf8').includes('zp009'));
    }
    const requestCount = wire.length;
    win.webContents.reloadIgnoringCache();
    await wait('重载后准备卡仍可见', () => js(`Boolean(document.querySelector('[data-testid="workflow-card"]'))`));
    check('重载不重新执行', wire.length === requestCount);
    await js(`Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{})))`);
    fs.writeFileSync(path.join(evidence, 'reopened.png'), (await win.webContents.capturePage()).toPNG());
    const rewind = await js(`window.hemiVoice.flowRewind(${JSON.stringify({ conversationId: cid, targetInputId: receipt.inputId, removedTurnKeys: [] })})`);
    check('补参输入回卷成功', rewind.ok);
    if (!real) {
      const beforeStop = (await service.getInvocation(prep.invocationId)).draftRevision;
      const delayed = await submit('STOP_PREP');
      await wait('主 agent 工具确实已开始', () => fs.existsSync(started));
      await js(`window.hemiVoice.flowCommand(${JSON.stringify(cid)},{type:'stop'})`);
      const stopped = await settled(delayed);
      await sleep(3500);
      check('在途主工具停止，无迟到文件或参数写入', stopped.runs[delayed.runId].outcome === 'stopped' && (await service.getInvocation(prep.invocationId)).draftRevision === beforeStop && !fs.existsSync(late));
      const next = await submit(messages[0]);
      check('停止后普通输入正常完成', (await settled(next)).runs[next.runId].outcome === 'completed');
      check('下一普通消息没有重放旧工具', !(await snapshot()).timeline.some(item => item.runId === next.runId && item.parts?.some(part => part.kind === 'tool')));
    }
    const journal = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'runtime-v2/run-journal.json'), 'utf8'));
    check('整个链路没有补参辅助模型请求', Object.values(journal.requests).every(request => request.purpose !== 'workflow-preparation'));
    check('renderer 使用真实入口', /file:|http:\/\/127.0.0.1:5173/.test(win.webContents.getURL()));
    check('renderer 无运行错误', rendererErrors.length === 0);
  } catch (error) { fatal = error.stack; console.error(fatal); }
  finally {
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: !fatal, real, marker, checks, fatal, rendererErrors, rendererUrl: win?.webContents.getURL(), sourceRoot, wire: wire.map(({ text, ...row }) => row) }, null, 2));
    console.log('HEMI059_PREPARATION_RESULT=' + JSON.stringify({ passed: !fatal, real, checks, fatal }));
    server.closeAllConnections(); server.close();
    await (await source('main/ipc/llm.ipc.mjs')).getAgentRuntime().disposeAll();
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(fatal ? 1 : 0);
  }
});
