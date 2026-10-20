// 070 AC-07 真机验收驱动：干净导出里「正常设置入口配置 provider → 完成唯一标记文件任务」。
//   - 隔离 userData 起真实应用（真实 IPC 注册、生产 store/safeStorage/控制器/主 agent 装配）；
//   - provider 为协议边界上的本地可控 mock（OpenAI 兼容流式，脚本化两步：write 工具调用 → 收尾文本），
//     工具在主 agent 真实执行（Pi write 工具落盘，不经 mock 伪造）；
//   - 断言：回复文本含标记；工作区文件存在且内容含标记（可读成果）。
// 运行（在干净导出目录）：
//   UD=/tmp/hemi-070-firsttask && rm -rf "$UD" && mkdir -p "$UD"
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD npx electron scripts/verify-070-first-task.mjs
// 打印一行 HEMI_VERIFY_070_TASK=<JSON>，exit 0＝断言通过。
import { app, ipcMain } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createLogger } from '../src/main/lib/logger.mjs';
import { abortActiveTextModelTurn } from '../src/main/ipc/llm.ipc.mjs';

const log = createLogger('verify-070-task');
const CONVERSATION_ID = 'conv-verify070-task';
const MARKER = `070-first-task-${Date.now().toString(36)}`;
const FILE_NAME = process.env.HEMI_VERIFY_TASK_FILE ?? 'hello-070.txt';
// SDK 升级复验：在旧版本实际完成过任务的隔离 userData 上续聊，
// 断言旧用户消息确实进入新版本首个 provider 请求，而非只验证新建会话。
const expectedHistory = process.env.HEMI_VERIFY_EXPECT_HISTORY ?? null;
const requestBodies = [];

if (!process.env.HEMI_USER_DATA_DIR) {
  console.error('[verify-070-task] 需要 HEMI_USER_DATA_DIR（隔离实例）');
  process.exit(1);
}
app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR));

const handler = (channel) => {
  const fn = ipcMain._invokeHandlers?.get(channel);
  if (typeof fn !== 'function') throw new Error(`找不到 IPC handler：${channel}`);
  return fn;
};

let finished = false;
function finish(code, result) {
  if (finished) return;
  finished = true;
  console.log(`HEMI_VERIFY_070_TASK=${JSON.stringify({ ...result, exitCode: code })}`);
  try { abortActiveTextModelTurn(); } catch { /* 退出路径 */ }
  setTimeout(() => app.exit(code), 500);
}

// 两步脚本：①write 工具调用（真实执行）；②看到工具结果后收尾。请求序号在「本段脚本内」递增。
function startMock() {
  let requestIndex = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      requestBodies.push(request);
      const taskRequest = request.tools?.some(tool => tool.function?.name === 'write');
      if (taskRequest) requestIndex += 1;
      // 后台标题等无工具请求不消耗业务回合的脚本步骤。
      const step = taskRequest ? requestIndex : 0;
      const chunk = (delta, finish) => JSON.stringify({
        id: 'chatcmpl-070task', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = step === 1
        ? [
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_w0', type: 'function', function: { name: 'write', arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: FILE_NAME, content: `唯一标记：${MARKER}\n` }) } }] }),
          chunk({}, 'tool_calls'),
        ]
        : [
          chunk({ role: 'assistant', content: taskRequest ? `文件已创建，内容含唯一标记 ${MARKER}。` : '文件任务验证' }),
          chunk({}, 'stop'),
        ];
      parts.push('[DONE]');
      res.write(parts.map((p) => `data: ${p}\n\n`).join(''));
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

app.whenReady().then(async () => {
  setTimeout(() => finish(1, { error: 'timeout' }), Number(process.env.HEMI_VERIFY_TIMEOUT ?? 120000));
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const chat = handler(IPC.llm.chat);
    const save = handler(IPC.llm.saveModelProfile);
    const getState = handler(IPC.task.getState);
    const action = handler(IPC.task.action);

    // 确认卡兜底自动应答（文件写在默认授权内不弹卡；保留 watcher 以防万一）。
    const watcher = setInterval(async () => {
      try {
        const snapshot = await getState({}, {});
        const pendings = [...(snapshot.agentPermissions ?? []), ...(snapshot.tasks ?? []).filter((t) => t.permission?.id && t.phase !== 'terminal')];
        for (const pending of pendings) {
          await action({}, { action: 'decide', choice: pending.permission.kind === 'grant' ? 'task' : 'once', taskKey: pending.key });
        }
      } catch { /* 轮询容错 */ }
    }, 500);
    watcher.unref?.();

    const { server, port } = await startMock();
    if (process.env.HEMI_VERIFY_MODE === 'configure') {
      // 只经设置入口保存 provider（baseUrl 指向驱动方即将常驻的固定 mock 端口），供后续真实应用启动复用。
      const wantedPort = Number(process.env.HEMI_VERIFY_MOCK_PORT ?? 0);
      const savedCfg = await save({}, { name: 'Mock 站', baseUrl: `http://127.0.0.1:${wantedPort || port}/v1`, apiKey: 'good-key', models: [{ model: 'mock-1' }] });
      server.close();
      finish(savedCfg?.ok === true ? 0 : 1, { configured: savedCfg?.ok === true, baseUrl: `http://127.0.0.1:${wantedPort || port}/v1` });
      return;
    }
    // 设置入口配置 provider（与设置页同一 IPC；Key 加密落盘）。
    let previousProvider, previousModel;
    if (expectedHistory) {
      const profiles = await handler(IPC.llm.listModelProfiles)({}, {});
      previousProvider = profiles.providers.find(provider => provider.models.some(model => model.isDefault));
      previousModel = previousProvider?.models.find(model => model.isDefault);
      if (previousProvider?.name !== 'Mock 站' || !previousProvider.baseUrl.startsWith('http://127.0.0.1:') || previousModel?.model !== 'mock-1') {
        throw new Error('跨版本复验仅允许复用本脚本创建的隔离 Mock 配置');
      }
    }
    const saved = await save({}, {
      ...(previousProvider ? { id: previousProvider.id } : {}),
      name: 'Mock 站', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'good-key',
      models: [{ ...(previousModel ? { id: previousModel.id } : {}), model: 'mock-1' }],
    });
    if (!saved?.ok) throw new Error(`保存供应商失败：${JSON.stringify(saved)}`);

    const reply = await chat({}, {
      turnId: 9701, conversationId: CONVERSATION_ID, workspaceId: 'default', inputSource: 'text',
      messages: [{ role: 'user', content: `在当前工作区创建 ${FILE_NAME}，内容写：唯一标记：${MARKER}` }],
    });
    server.close();

    const workspaceFile = path.join(app.getPath('userData'), 'workspace', 'default', FILE_NAME);
    let fileContent = null;
    try { fileContent = fs.readFileSync(workspaceFile, 'utf8'); } catch { /* 断言里体现 */ }
    const firstTaskRequest = requestBodies.find(request => request.tools?.some(tool => tool.function?.name === 'write'));
    const historyRetained = !expectedHistory || firstTaskRequest?.messages?.some(
      (message) => message.role === 'user' && JSON.stringify(message.content).includes(expectedHistory),
    );
    const pass = typeof reply?.text === 'string' && reply.text.includes(MARKER)
      && typeof fileContent === 'string' && fileContent.includes(MARKER) && historyRetained;
    finish(pass ? 0 : 1, {
      replyText: reply?.text ?? null,
      file: workspaceFile,
      fileContent: fileContent ?? null,
      toolNames: reply?.toolNames ?? null,
      ...(expectedHistory ? { expectedHistory, historyRetained } : {}),
    });
  } catch (error) {
    finish(1, { error: error instanceof Error ? error.message : String(error) });
  }
});
