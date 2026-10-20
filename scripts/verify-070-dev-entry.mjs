// 070 AC-07 开发入口驱动（纯 node，配合已就绪的 vite dev server）：
//   常驻固定端口 mock（OpenAI 兼容，两步脚本：write 工具调用 → 收尾）→ 以 VITE_DEV_SERVER_URL
//   拉起真实应用（渲染层从 vite 加载）→ CDP 进主窗口页面，经 preload 桥（window.hemiVoice.chatTextModel
//   → IPC.llm.chat）提交唯一标记文件任务 → 断言回复与工作区文件均含标记，记录实际 renderer URL。
// 前置：UD 已用 verify-070-first-task.mjs 的 configure 模式配好 provider（指向本驱动的 mock 端口）。
// 运行（在导出目录，vite 已在 HEMI_DEV_URL 上运行）：
//   node scripts/verify-070-dev-entry.mjs
// 打印一行 HEMI_VERIFY_070_DEV=<JSON>，exit 0＝断言通过。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronBinary from 'electron';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UD = path.resolve(process.env.HEMI_USER_DATA_DIR ?? '');
const DEV_URL = process.env.HEMI_DEV_URL ?? 'http://127.0.0.1:5199';
const MOCK_PORT = Number(process.env.HEMI_VERIFY_MOCK_PORT ?? 18770);
const CDP_PORT = Number(process.env.HEMI_VERIFY_CDP_PORT ?? 18771);
const MARKER = `070-dev-entry-${Date.now().toString(36)}`;
const FILE_NAME = process.env.HEMI_VERIFY_TASK_FILE ?? 'hello-070-dev.txt';
const CONVERSATION_ID = 'conv-verify070-dev';

if (!process.env.HEMI_USER_DATA_DIR) {
  console.error('[verify-070-dev] 需要 HEMI_USER_DATA_DIR');
  process.exit(1);
}

const result = { rendererUrl: null, replyText: null, file: null, fileContent: null, exitCode: 1 };
function finish(code) {
  result.exitCode = code;
  console.log(`HEMI_VERIFY_070_DEV=${JSON.stringify(result)}`);
  try { electron?.kill('SIGTERM'); } catch { /* */ }
  mockServer?.close();
  setTimeout(() => process.exit(code), 800);
}

// —— mock：与 first-task 同款两步脚本 ——
let mockServer = null;
await new Promise((resolve) => {
  let requestIndex = 0;
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requestIndex += 1;
      const chunk = (delta, finish) => JSON.stringify({
        id: 'chatcmpl-070dev', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = requestIndex === 1
        ? [
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_w0', type: 'function', function: { name: 'write', arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: FILE_NAME, content: `唯一标记：${MARKER}\n` }) } }] }),
          chunk({}, 'tool_calls'),
        ]
        : [chunk({ role: 'assistant', content: `文件已创建，内容含唯一标记 ${MARKER}。` }), chunk({}, 'stop')];
      parts.push('[DONE]');
      res.write(parts.map((p) => `data: ${p}\n\n`).join(''));
      res.end();
    });
  });
  mockServer.listen(MOCK_PORT, '127.0.0.1', resolve);
});

// —— 拉起真实应用（渲染层走 vite dev server） ——
const electron = spawn(electronBinary, ['.', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
  stdio: ['ignore', 'pipe', 'pipe'],
});
electron.stdout.on('data', () => {});
electron.stderr.on('data', () => {});
electron.once('error', (error) => { result.error = error.message; finish(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdpPages() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1500) });
    return await res.json();
  } catch { return []; }
}

setTimeout(() => finish(1), Number(process.env.HEMI_VERIFY_TIMEOUT ?? 120000));

// 等主窗口页面（vite URL）出现
let page = null;
for (let i = 0; i < 60 && !page; i++) {
  await sleep(1000);
  const pages = await cdpPages();
  page = pages.find((p) => p.type === 'page' && String(p.url ?? '').startsWith(DEV_URL)) ?? null;
}
if (!page) { result.error = '主窗口页面未出现'; finish(1); }
result.rendererUrl = page.url;

// CDP evaluate
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
let seq = 0;
const pending = new Map();
ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
async function evaluate(expression) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  return await new Promise((resolve) => pending.set(id, resolve));
}

// 等渲染层桥就绪
let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  await sleep(500);
  const r = await evaluate('typeof window.hemiVoice?.chatTextModel');
  ready = r?.result?.result?.value === 'function';
}
if (!ready) { result.error = '渲染层桥未就绪'; finish(1); }

// 经真实渲染层提交任务（renderer → preload → IPC.llm.chat → 主 agent → write 工具）
const expression = `(window.hemiVoice.chatTextModel({
  turnId: 9801, conversationId: ${JSON.stringify(CONVERSATION_ID)}, inputSource: 'text',
  messages: [{ role: 'user', content: '在当前工作区创建 ${FILE_NAME}，内容写：唯一标记：${MARKER}' }],
}))`;
const reply = await evaluate(expression);
const value = reply?.result?.result?.value ?? null;
result.replyText = value?.text ?? (reply?.result?.exceptionDetails?.exception?.description ?? null);

const file = path.join(UD, 'workspace', 'default', FILE_NAME);
try { result.fileContent = fs.readFileSync(file, 'utf8'); } catch { /* 断言里体现 */ }
result.file = file;
const pass = typeof result.replyText === 'string' && result.replyText.includes(MARKER)
  && typeof result.fileContent === 'string' && result.fileContent.includes(MARKER);
finish(pass ? 0 : 1);
