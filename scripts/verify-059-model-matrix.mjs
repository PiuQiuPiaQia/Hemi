// 059 P07 模型矩阵观测（收口 46～52 组核心断言）：本地 mock OpenAI 端点记录
// 每次真实请求体的 model 字段，观测三条产品口径（模型需求 model-selection.md）：
//   M1 固定模型：executionModel {mode:'fixed', modelKey} 的节点运行，真实请求体
//      model 字段＝计划模型（不是「展示什么就信什么」——观测 wire 真相）
//   M2 本次改选：换一个 executionModel 再跑，新请求 model＝新值（旧运行快照不受影响）
//   M3 失效明确报错：baseUrl 指向无服务端口 → 节点失败、错误如实（不静默换模型）
// 结果打一行 HEMI_059_MODEL_RESULT；exit 0＝全过。
// 运行：HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-059-model-ud \
//       npx electron scripts/verify-059-model-matrix.mjs
import { app } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-059-model-ud'));

const { createHemiSession } = await import('../src/main/agent/hemi-session.mjs');
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
  console.log(`HEMI_059_MODEL_RESULT=${JSON.stringify({ passed: results.every((r) => r.ok), results })}`);
  setTimeout(() => app.exit(code), 400);
};

const seenModels = [];
const seenRequestCount = { n: 0 };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      seenModels.push(parsed.model ?? null);
      seenRequestCount.n += 1;
    } catch { /* 非 JSON（探测等）忽略 */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});

const workDir = (() => {
  fs.mkdirSync(path.join(process.cwd(), '.verify-059'), { recursive: true });
  return fs.mkdtempSync(path.join(process.cwd(), '.verify-059', 'model-'));
})();

app.whenReady().then(async () => {
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    async function runNodeWithModel(modelName, { baseUrl = `http://127.0.0.1:${port}/v1` } = {}) {
      const session = createHemiSession({
        cwd: workDir,
        agentDir: path.join(app.getPath('userData'), 'pi-agent'),
        model: { baseUrl, api: 'openai-completions', apiKey: 'mock-key', model: modelName },
        mode: 'run',
        tools: [],
        label: `wf-model-${modelName}`,
        log: { info: () => {}, warn: () => {} },
        initTimeoutMs: 20_000,
        stallTimeoutMs: 30_000,
      });
      await session.ready();
      const agent = createWorkflowNodeAgent({
        session,
        nodeSpec: { nodeId: 'n', nodeType: 'hemi-agent', nodeData: { goal: '回答完成即可' } },
      });
      const result = await agent.run({ inputs: {} });
      session.dispose();
      return result;
    }

    // M1 固定模型：请求体 model＝计划值
    const before = seenRequestCount.n;
    await runNodeWithModel('matrix-model-a');
    const m1Models = seenModels.slice(before);
    check('M1 固定模型请求体 model＝计划值', m1Models.length > 0 && m1Models.every((m) => m === 'matrix-model-a'), JSON.stringify(m1Models));

    // M2 本次改选：新执行用新 model（不沿用旧计划）
    const before2 = seenRequestCount.n;
    await runNodeWithModel('matrix-model-b');
    const m2Models = seenModels.slice(before2);
    check('M2 改选后请求体 model＝新值', m2Models.length > 0 && m2Models.every((m) => m === 'matrix-model-b'), JSON.stringify(m2Models));

    // M3 失效明确报错：端口无服务 → pi-session 口径＝重试耗尽后带 modelError 的
    // settled（不抛）；节点失败、不静默换用别的模型。
    let failed = null;
    let m3Result = null;
    try {
      m3Result = await runNodeWithModel('matrix-model-c', { baseUrl: 'http://127.0.0.1:9/v1' });
    } catch (error) {
      failed = error;
    }
    const m3ModelError = failed ? String(failed.message) : (m3Result?.modelError ?? null);
    // wire 真相兜底：model-c 一次都没出现在真实请求里（没有静默换模型），且零成功请求。
    const noSilentSwap = !seenModels.includes('matrix-model-c') && m3Result?.usage == null;
    check('M3 端点失效明确报错（不静默换模型）', Boolean(m3ModelError) && noSilentSwap, `modelError=${String(m3ModelError).slice(0, 90)} noSilentSwap=${noSilentSwap}`);

    finish(results.every((r) => r.ok) ? 0 : 1);
  } catch (error) {
    console.log(`HEMI_059_MODEL_RESULT=${JSON.stringify({ passed: false, fatal: String(error?.stack ?? error) })}`);
    app.exit(1);
  }
});
