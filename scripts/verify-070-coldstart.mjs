// 070 AC-06 真机验收驱动：隔离 userData 起真实应用，从产品入口（IPC.llm.chat）验证
//   - corrupt：text-model-profiles.json 为损坏 JSON → chat 准确报「损坏」（不误报未配置）、
//     目录视图 corrupt:true 只读占位、损坏期间保存被拒（按损坏处理，不覆盖用户文件）；
//   - badkey：损坏文件删除（用户修复路径）→ 正常设置入口（llm:save-model-profile）配置
//     mock 供应商与无效 Key → chat 如实失败（不误报成功、不换模型）→ 同入口修正 Key →
//     chat 成功拿到唯一标记回复（修正重试闭环）。
// 运行（worktree 根目录）：
//   UD=/tmp/hemi-070-coldstart && rm -rf "$UD" && mkdir -p "$UD" && printf '{oops' > "$UD/text-model-profiles.json"
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD HEMI_VERIFY_MODE=corrupt npx electron scripts/verify-070-coldstart.mjs
//   rm "$UD/text-model-profiles.json"
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD HEMI_VERIFY_MODE=badkey npx electron scripts/verify-070-coldstart.mjs
// 每种模式打印一行 HEMI_VERIFY_070=<JSON>，exit 0＝该模式断言通过。
import { app, ipcMain } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createLogger } from '../src/main/lib/logger.mjs';
import { abortActiveTextModelTurn } from '../src/main/ipc/llm.ipc.mjs';

const log = createLogger('verify-070');
const MODE = process.env.HEMI_VERIFY_MODE ?? 'corrupt';
const CONVERSATION_ID = 'conv-verify070-a';
const MARKER = '凭据修正后成功-070';

if (!process.env.HEMI_USER_DATA_DIR) {
  console.error('[verify-070] 需要 HEMI_USER_DATA_DIR（隔离实例）');
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
  console.log(`HEMI_VERIFY_070=${JSON.stringify({ mode: MODE, ...result, exitCode: code })}`);
  try { abortActiveTextModelTurn(); } catch { /* 退出路径 */ }
  setTimeout(() => app.exit(code), 500);
}

// OpenAI chat completions 兼容 mock（形状同 pi-sdk-probe）：Authorization 带 invalid-key → 401；
// 否则流式回放固定标记文本。凭据对错由服务器按真实请求头判定，不在客户端作弊。
function startMock() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization ?? '';
      if (auth.includes('invalid-key')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
      const chunk = (delta, finish) => JSON.stringify({
        id: 'chatcmpl-070', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = [
        chunk({ role: 'assistant', content: `好的，${MARKER}。` }),
        chunk({}, 'stop'),
        '[DONE]',
      ];
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
    const list = handler(IPC.llm.listModelProfiles);
    const save = handler(IPC.llm.saveModelProfile);
    const conversationsDir = path.join(app.getPath('userData'), 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });
    const archiveOf = path.join(conversationsDir, `${CONVERSATION_ID}.json`);
    if (!fs.existsSync(archiveOf)) {
      fs.writeFileSync(archiveOf, `${JSON.stringify({ id: CONVERSATION_ID, turns: [], createdAt: Date.now(), updatedAt: Date.now() }, null, 2)}\n`);
    }
    const submit = (turnId) => chat({}, {
      turnId, conversationId: CONVERSATION_ID, workspaceId: 'default', inputSource: 'text',
      messages: [{ role: 'user', content: '冒烟' }],
    });
    const chatError = async (turnId) => {
      try { const r = await submit(turnId); return { ok: true, text: r?.text ?? '' }; }
      catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
    };

    if (MODE === 'bootstrap') {
      // 只完成 runtime-v2 迁移（落迁移清单），供外壳随后注入损坏/空配置文件。
      const view = await list();
      finish(view.corrupt === false ? 0 : 1, { bootstrapped: true });
      return;
    }

    if (MODE === 'corrupt') {
      console.log('[stage] list…');
      const view = await list();
      console.log('[stage] chat…');
      const chatResult = await chatError(9601);
      console.log('[stage] save…');
      let saveRejected = null;
      try {
        await save({}, { name: 'X', baseUrl: 'https://x/v1', apiKey: 'k', models: [{ model: 'm' }] });
        console.log('[stage] save resolved (unexpected)');
        saveRejected = false;
      } catch (error) {
        console.log('[stage] save rejected');
        saveRejected = /损坏/.test(error instanceof Error ? error.message : String(error));
      }
      console.log('[stage] finish…');
      const pass = view.corrupt === true
        && /只读/.test(String(view.providers?.[0]?.name ?? ''))
        && chatResult.ok === false && /损坏/.test(chatResult.message) && !/未配置/.test(chatResult.message)
        && saveRejected === true;
      finish(pass ? 0 : 1, { corruptView: view.corrupt, placeholder: view.providers?.[0]?.name ?? null, chatError: chatResult.message, saveRejected });
      return;
    }

    if (MODE === 'badkey') {
      const { server, port } = await startMock();
      // 修复后的空目录：未配置、可写（corrupt 模式里被拒的保存在这里应当成功）。
      const freshView = await list();
      const firstSave = await save({}, { name: 'Mock 站', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'invalid-key', models: [{ model: 'mock-1' }] });
      const badKeyResult = await chatError(9602);
      // 无效凭据不得误报成功：唯一供应商、错误如实上抛（消息带 401/无效 Key 语义，由服务器真实返回）。
      const honestFailure = badKeyResult.ok === false && /invalid|401|key|凭据| unauthorized/i.test(badKeyResult.message);
      // 修正重试：同入口换有效 Key（服务器按 Authorization 判定），同一会话再次提问成功。
      const secondSave = await save({}, { id: firstSave.providerId, name: 'Mock 站', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'good-key', models: [{ model: 'mock-1' }] });
      const retry = await submit(9603);
      server.close();
      const pass = freshView.corrupt === false && (freshView.providers?.length ?? 0) === 0
        && firstSave.ok === true && secondSave.ok === true
        && honestFailure
        && typeof retry?.text === 'string' && retry.text.includes(MARKER);
      finish(pass ? 0 : 1, { freshProviders: freshView.providers?.length ?? -1, firstSaveOk: firstSave.ok, badKeyError: badKeyResult.message, honestFailure, retryText: retry?.text ?? null });
      return;
    }

    throw new Error(`未知模式：${MODE}`);
  } catch (error) {
    finish(1, { error: error instanceof Error ? error.message : String(error) });
  }
});
