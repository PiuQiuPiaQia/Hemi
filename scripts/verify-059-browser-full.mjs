// 059 S4 browser 节点真模型全链验证（需用户配合）：Chrome 启用「Hemi 浏览器控制」
// 扩展并退出占用 9467 端口的 Hemi 实例后运行——
//   B1 扩展桥连接（waitReady 成功）
//   B2 browser 节点真模型：打开 https://example.com 并提取页面标题 → 输出 JSON
//   B3 交付核查：输出 title 非空（真实页面内容）
// 结果打一行 HEMI_059_BROWSER_RESULT；exit 0＝全过。
// 运行（先退出正在跑的 Hemi 实例，让扩展连到本验证进程的 9467）：
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-059-browser-ud \
//   npx electron scripts/verify-059-browser-full.mjs
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-059-browser-ud'));

const { resolveTextModelConfig } = await import('../src/main/lib/config-store.mjs');
const { createHemiSession } = await import('../src/main/agent/hemi-session.mjs');
const { createPermissionService } = await import('../src/main/services/permission-service.mjs');
const { getBrowserBridgeService } = await import('../src/main/services/browser-bridge-service.mjs');
const { browserBridgeStatePathFor } = await import('../src/main/agent/permission-state.mjs');
const { createWorkflowNodeAgent } = await import('../src/main/agent/workflow-node-agent.mjs');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  console.log(`HEMI_059_BROWSER_RESULT=${JSON.stringify({ passed: results.every((r) => r.ok), results })}`);
  setTimeout(() => app.exit(code), 400);
};

const workDir = (() => {
  fs.mkdirSync(path.join(process.cwd(), '.verify-059'), { recursive: true });
  return fs.mkdtempSync(path.join(process.cwd(), '.verify-059', 'browser-'));
})();

app.whenReady().then(async () => {
  try {
    const config = await resolveTextModelConfig();
    if (!config.apiKey) {
      check('模型 Key', false, '拷贝 text-model.json 到 userData 或设 HEMI_LLM_API_KEY');
      return finish(1);
    }
    const userDataDir = app.getPath('userData');
    const agentDir = path.join(userDataDir, 'pi-agent');
    const accessService = createPermissionService({ dir: path.join(agentDir, 'access-store'), nowFn: Date.now });
    await accessService.load().catch(() => {});
    const bridge = getBrowserBridgeService({ statePath: browserBridgeStatePathFor(userDataDir), log: { warn: (...a) => console.log('[w]', ...a), info: () => {} } });
    const client = bridge.createClient({ taskId: 'wf-browser-verify', taskLabel: '059 browser 全链' });

    // B1 桥连接（waitReady 内部等扩展 WebSocket 接入，超时即失败）
    let bridgeReady = false;
    try {
      await client.ensureReady?.() ?? bridge.ensureStarted?.();
      bridgeReady = true;
    } catch (error) {
      check('B1 扩展桥连接', false, String(error?.message ?? error).slice(0, 160));
      return finish(1);
    }
    check('B1 扩展桥连接', bridgeReady);

    // B2 browser 节点真模型：打开 example.com 提取标题
    const nodeSpec = {
      nodeId: 'br-1',
      nodeType: 'hemi-browser',
      nodeData: {
        title: '取页面标题',
        goal: '用浏览器工具打开 https://example.com，提取页面主标题（Example Domain），不做什么其它操作。',
        targetUrl: 'https://example.com',
        outputSchema: { type: 'object', properties: { title: { type: 'string', description: '页面主标题原文' } } },
      },
    };
    const session = createHemiSession({
      cwd: workDir,
      agentDir,
      model: { baseUrl: config.baseUrl, api: 'openai-completions', apiKey: config.apiKey, model: config.model },
      mode: 'run',
      tools: ['read', 'write', 'edit', 'ls', 'browser_navigate', 'browser_extract', 'browser_tabs', 'browser_act'],
      browserBridge: { createClient: () => client },
      appendSystem: ['所有文字输出一律用中文（代码、命令、路径、文件内容除外）。'],
      accessId: 'wf-browser-verify',
      accessService,
      label: 'wf-browser 节点',
      log: { info: () => {}, warn: (...a) => console.log('[w]', ...a) },
    });
    session.on('permission', ({ id, options }) => {
      const optionsText = JSON.stringify(options ?? []);
      const value = optionsText.includes('task') ? 'task' : optionsText.includes('once') ? 'once' : options?.[0];
      session.respondPermission(id, { value });
    });
    await session.ready();
    const agent = createWorkflowNodeAgent({ session, nodeSpec, executionOwner: { workflowRunId: 'wrun-browser', nodeId: 'br-1', attemptId: 'try-1' } });
    const outcome = await agent.run({ inputs: {} });
    session.dispose();

    // B3 产物核查：title 为真实页面标题
    const title = outcome.outputs?.title;
    const b3 = typeof title === 'string' && /example/i.test(title);
    check('B2 browser 节点真模型（打开页面＋提取标题）', Boolean(title), JSON.stringify(outcome.outputs ?? {}));
    check('B3 标题来自真实页面（Example Domain）', b3, String(title));
    finish(results.every((r) => r.ok) ? 0 : 1);
  } catch (error) {
    console.log(`HEMI_059_BROWSER_RESULT=${JSON.stringify({ passed: false, fatal: String(error?.stack ?? error) })}`);
    app.exit(1);
  }
});
