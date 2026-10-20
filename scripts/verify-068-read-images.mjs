// 068 产品接线：仅外部 provider 是可控端点；真实 preload/IPC/主子装配/read/快照/历史。
import { app, safeStorage, nativeImage } from 'electron';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, unlink, realpath } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { testPng } from './lib/local-image-fixtures.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createMainWindow } from '../src/main/windows/main-window.mjs';
import { state } from '../src/main/state.mjs';
import { getAgentRuntime } from '../src/main/ipc/llm.ipc.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hemi-read-images-')));
const ud = path.join(root, 'user-data'), workspace = path.join(root, 'images');
await mkdir(ud); await mkdir(workspace);
app.setName('hemi'); app.setPath('userData', ud);
const evidence = { userData: ud, workspace, checks: [], requests: [], provider: 'controlled-local-endpoint', realSemanticVision: false };
const cases = new Map();
const hash = data => createHash('sha256').update(data).digest('hex');
const check = (name, condition) => { evidence.checks.push({ name, pass: Boolean(condition) }); assert.ok(condition, name); console.log(`PASS ${name}`); };
const exec = code => state.mainWindow.webContents.executeJavaScript(code);
async function wait(fn, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`等待超时：${label}`);
}
function imagesOf(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (value.type === 'image_url' && value.image_url?.url?.startsWith('data:image/')) {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(value.image_url.url);
    if (match) found.push({ mimeType: match[1], data: match[2] });
  } else if (value.type === 'image' && value.source?.type === 'base64') {
    found.push({ mimeType: value.source.media_type, data: value.source.data });
  }
  for (const item of Object.values(value)) if (item && typeof item === 'object') imagesOf(item, found);
  return found;
}
function toolResultPresent(messages) {
  return messages.some(message => message.role === 'tool' || Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
}
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), anthropic = req.url.includes('/messages');
    const current = [...body.messages].reverse().find(message => message.role === 'user' && /READ_CASE:([a-z-]+)/.test(JSON.stringify(message.content)));
    const id = JSON.stringify(current?.content ?? '').match(/READ_CASE:([a-z-]+)/)?.[1];
    const scenario = cases.get(id);
    const images = imagesOf(body.messages);
    const hasTask = body.tools?.some(tool => (tool.name ?? tool.function?.name) === 'task');
    const record = { model: body.model, protocol: anthropic ? 'anthropic' : 'openai', case: id, images: images.map(image => ({ mimeType: image.mimeType, hash: hash(Buffer.from(image.data, 'base64')) })) };
    evidence.requests.push(record);
    let text = '验证对话', call = null;
    if (scenario) {
      const afterTool = toolResultPresent(body.messages);
      if (scenario.kind === 'child' && hasTask) {
        if (!afterTool) call = { name: 'task', args: { agent: 'fixer', description: '读取本地图片', requirements: { imageInput: true }, prompt: `READ_CASE:${id} 使用 read 读取 ${scenario.file}，只报告工具实际返回的图片。` } };
        else text = `子任务返回：${scenario.marker}`;
      } else if (scenario.kind === 'history' || afterTool) {
        if (scenario.kind === 'text' || scenario.kind === 'corrupt') {
          check(`${id} 未向固定模型发送图像`, images.length === 0);
          check(`${id} 工具明确报告原因`, /unsupported-modality|格式无效|无法解码|损坏/.test(JSON.stringify(body.messages)));
          text = '图片未读取，已明确报告原因。';
        } else {
          check(`${id} provider 实际收到图片`, images.length > 0);
          const image = images.at(-1), bytes = Buffer.from(image.data, 'base64');
          if (scenario.resized) {
            const decoded = nativeImage.createFromBuffer(bytes), size = decoded.getSize();
            check(`${id} provider 收到缩放后的真实像素`, size.width === 2000 && size.height === 80 && decoded.toBitmap()[2] === scenario.seed);
          } else check(`${id} 图片字节与本次文件完全一致`, hash(bytes) === scenario.hash);
          scenario.seen = true; text = scenario.marker;
        }
      } else call = { name: 'read', args: { path: scenario.file } };
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(anthropic
        ? { id: randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }
        : { id: randomUUID(), object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    } else if (anthropic) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message: { id: randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: call ? { type: 'tool_use', id: `tool-${randomUUID()}`, name: call.name, input: {} } : { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } : { type: 'text_delta', text } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } });
      event('message_stop', {}); res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = call ? { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: text };
      const chunks = [{ choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }];
      for (const chunk of chunks) res.write(`data: ${JSON.stringify({ id: 'read-test', object: 'chat.completion.chunk', model: body.model, ...chunk })}\n\n`);
      res.end('data: [DONE]\n\n');
    }
  } catch (error) {
    evidence.providerError = error.stack;
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

async function addCase(id, kind, options = {}) {
  const bytes = options.bytes ?? testPng(options);
  const file = path.join(workspace, `${id}.png`); await writeFile(file, bytes);
  const scenario = { kind, file, hash: hash(bytes), marker: `IMAGE_WIRE_${randomUUID()}`, ...options };
  cases.set(id, scenario); return scenario;
}
async function archive(cid) {
  return JSON.parse(await readFile(path.join(ud, 'runtime-v2/conversations', `${cid}.json`), 'utf8'));
}
async function send(cid, id, profileId) {
  const text = `READ_CASE:${id} 请使用 read 查看图片 ${cases.get(id).file}。`;
  const receipt = await exec(`window.hemiVoice.submitChatTurn(${JSON.stringify({ conversationId: cid, profileId, inputSource: 'text', requestId: randomUUID(), turnId: Date.now(), workspaceId: 'default', messages: [{ role: 'user', content: text }] })})`);
  check(`${id} 真实聊天入口受理`, receipt.ok);
  const flow = await wait(async () => { const f = await exec(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`); return f?.phase === 'idle' && Object.keys(f.runs).length && f; }, id);
  check(`${id} 回合成功收口`, Object.values(flow.runs).at(-1).outcome === 'completed');
  const saved = await archive(cid);
  check(`${id} 回答已持久化`, saved.turns.some(turn => turn.author === 'hemi' && turn.text.includes(cases.get(id).kind === 'text' || cases.get(id).kind === 'corrupt' ? '图片未读取' : cases.get(id).marker)));
  return saved;
}

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    const encryptedApiKey = safeStorage.encryptString('SYNTHETIC_READ_ONLY').toString('base64');
    await writeFile(path.join(ud, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'read-openai/main', roleModels: { main: 'read-openai/main', fixer: 'read-openai/fixer' }, providers: [
      { id: 'read-openai', name: 'Read 验证 OpenAI', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, encryptedApiKey, models: [{ id: 'main', model: 'read-main', supportsVision: true }, { id: 'fixer', model: 'read-fixer', supportsVision: true }, { id: 'text', model: 'read-text', supportsVision: false }] },
      { id: 'read-anthropic', name: 'Read 验证 Anthropic', api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${server.address().port}`, encryptedApiKey, models: [{ id: 'main', model: 'read-anthropic', supportsVision: true }, { id: 'fixer', model: 'read-anthropic-fixer', supportsVision: true }] },
    ] }));
    await writeFile(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
    await registerAllIpcHandlers(); await createMainWindow();
    evidence.rendererUrl = state.mainWindow.webContents.getURL();
    await wait(() => exec('Boolean(window.hemiVoice?.submitChatTurn)'), 'preload');
    await addCase('main-png', 'main', { width: 512, height: 512, noisy: true, seed: (Date.now() >>> 0) || 1 });
    check('产品图片实际超过 512KiB', (await readFile(cases.get('main-png').file)).length > 512 * 1024);
    const main = await send('conv-read-main', 'main-png', 'read-openai/main');
    check('主 agent 原生图像进入持久历史', main.agentSession.entries.some(entry => entry.message?.role === 'toolResult' && entry.message.content.some(block => block.type === 'image')));
    await unlink(cases.get('main-png').file);
    cases.set('history', { ...cases.get('main-png'), kind: 'history', marker: `HISTORY_${randomUUID()}` });
    await send('conv-read-main', 'history', 'read-openai/main');
    check('删除源文件后的续聊仍回放同一图像', cases.get('history').seen);
    await addCase('child-png', 'child'); await send('conv-read-child', 'child-png', 'auto');
    await addCase('main-anthropic', 'main'); await send('conv-read-anthropic', 'main-anthropic', 'read-anthropic/main');
    check('通过产品设置切换 fixer 模型', (await exec(`window.hemiVoice.saveRoleModel({fixer:'read-anthropic/fixer'})`)).ok);
    await addCase('child-anthropic', 'child'); await send('conv-read-anthropic-child', 'child-anthropic', 'auto');
    await addCase('wide-png', 'main', { width: 3000, height: 120, seed: 83, resized: true }); await send('conv-read-wide', 'wide-png', 'read-openai/main');
    await addCase('text-model', 'text'); await send('conv-read-text', 'text-model', 'read-openai/text');
    await addCase('corrupt', 'corrupt', { bytes: Buffer.from('broken PNG') }); await send('conv-read-corrupt', 'corrupt', 'read-openai/main');
    const journal = await getAgentRuntime().journal.snapshot();
    const children = Object.values(journal.tasks).filter(task => task.owner.conversationId.startsWith('conv-read-'));
    check('两种协议的 fixer 均成功完成', children.length === 2 && children.every(task => task.result.outcome === 'complete'));
    const childRead = Object.values(journal.observations).filter(item => item.owner.taskId && item.tool === 'read');
    check('子任务 read 原始快照保存真实图片', childRead.length === 2 && (await Promise.all(childRead.map(async item => JSON.parse(await readFile(path.join(ud, 'runtime-v2/contexts', `${item.outputRef}.json`), 'utf8')).content.some(block => block.type === 'image')))).every(Boolean));
    check('实际 fixer 请求模型与所选模型一致', evidence.requests.some(req => req.case === 'child-png' && req.model === 'read-fixer' && req.images.length) && evidence.requests.some(req => req.case === 'child-anthropic' && req.model === 'read-anthropic-fixer' && req.images.length));
    check('文本模型未被偷换', evidence.requests.filter(req => req.case === 'text-model').every(req => req.model === 'read-text'));
    check('可控端点未发生断言错误', !evidence.providerError);
  } catch (error) { evidence.error = error.stack; console.error(error); }
  finally {
    evidence.passed = !evidence.error && evidence.checks.every(item => item.pass);
    const output = path.resolve('.visual/workflow/vision/068-read-images-product.json');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(evidence, null, 2));
    console.log(`HEMI_068_READ_IMAGES_RESULT=${JSON.stringify({ passed: evidence.passed, checks: evidence.checks.length, output, userData: ud, error: evidence.error })}`);
    disposeTaskManager(); getAgentRuntime().disposeAll(); server.closeAllConnections(); server.close(); state.isQuitting = true;
    setTimeout(() => app.exit(evidence.passed ? 0 : 1), 300);
  }
});
