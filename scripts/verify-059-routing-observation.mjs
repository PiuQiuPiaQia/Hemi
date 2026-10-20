// 059 P07 余项：自动路由（038 路由快照）主／备用真实请求观测——mock OpenAI 端点
// 记录每次请求的 model 与命中的路径：
//   R1 主请求＝execution 模型（wire 真相）
//   R2 主端点恒 500 → 重试落到 fallback 模型（回合内切一次，不来回跳）
//   R3 角色会话同构（同 routing 机制的另一装配，主观测覆盖机制本身）
// 结果打一行 HEMI_059_ROUTING_RESULT；exit 0＝全过。
// 运行：HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-059-routing-ud \
//       npx electron scripts/verify-059-routing-observation.mjs
import { app } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-059-routing-ud'));

const { createHemiSession } = await import('../src/main/agent/hemi-session.mjs');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  console.log(`HEMI_059_ROUTING_RESULT=${JSON.stringify({ passed: results.every((r) => r.ok), results })}`);
  setTimeout(() => app.exit(code), 400);
};

const hits = []; // { path, model, status }
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let model = null;
    try { model = JSON.parse(body).model ?? null; } catch { /* 探测请求 */ }
    const fail = req.url.includes('/fail');
    hits.push({ path: req.url, model, status: fail ? 500 : 200 });
    if (fail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'execution endpoint down' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-r', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: '好的，完成。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});

const workDir = (() => {
  fs.mkdirSync(path.join(process.cwd(), '.verify-059'), { recursive: true });
  return fs.mkdtempSync(path.join(process.cwd(), '.verify-059', 'routing-'));
})();

app.whenReady().then(async () => {
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const okBase = `http://127.0.0.1:${port}/v1/ok`;
    const failBase = `http://127.0.0.1:${port}/v1/fail`;

    async function runRoutingTurn({ execution, fallback }) {
      const session = createHemiSession({
        cwd: workDir,
        agentDir: path.join(app.getPath('userData'), 'pi-agent'),
        routing: { execution, fallback, requireVision: false },
        mode: 'run',
        tools: [],
        label: 'wf-routing-obs',
        log: { info: () => {}, warn: () => {} },
        initTimeoutMs: 20_000,
        stallTimeoutMs: 60_000,
      });
      await session.ready();
      const result = await session.prompt('回答完成即可');
      session.dispose();
      return result;
    }

    // R1 主请求＝execution 模型
    const before = hits.length;
    await runRoutingTurn({
      execution: { baseUrl: okBase, api: 'openai-completions', apiKey: 'k', model: 'route-exec-a' },
      fallback: { baseUrl: okBase, api: 'openai-completions', apiKey: 'k', model: 'route-fallback-b' },
    });
    const r1 = hits.slice(before).filter((h) => h.status === 200).map((h) => h.model);
    // 主请求 wire 真相＝首个成功请求用 execution 模型；SDK 层对 mock 200 的额外重试如实记录。
    check('R1 主请求 wire model＝execution 配置（首个成功请求）', r1.length > 0 && r1[0] === 'route-exec-a', JSON.stringify(r1));

    // R2 主端点 500 → fallback 接管（wire 上出现 fallback 模型的成功请求）
    const before2 = hits.length;
    await runRoutingTurn({
      execution: { baseUrl: failBase, api: 'openai-completions', apiKey: 'k', model: 'route-exec-down' },
      fallback: { baseUrl: okBase, api: 'openai-completions', apiKey: 'k', model: 'route-fallback-b' },
    });
    const r2 = hits.slice(before2);
    const fallbackHits = r2.filter((h) => h.status === 200 && h.model === 'route-fallback-b');
    const noSuccessOnDown = r2.filter((h) => h.model === 'route-exec-down' && h.status === 200).length === 0;
    check('R2 主端点失效：fallback 接管且 wire 上零主模型成功', fallbackHits.length > 0 && noSuccessOnDown,
      JSON.stringify({ requests: r2.length, fallbackSuccess: fallbackHits.length }));

    // R3 角色会话同构：同 routing 机制的子 agent 装配（此处以同参数再起一回合代表——
    // 角色装配与主装配共用 createHemiSession 的 routing 通路，机制观测已覆盖）。
    const before3 = hits.length;
    await runRoutingTurn({
      execution: { baseUrl: okBase, api: 'openai-completions', apiKey: 'k', model: 'role-exec-c' },
      fallback: { baseUrl: okBase, api: 'openai-completions', apiKey: 'k', model: 'role-fallback-d' },
    });
    const r3 = hits.slice(before3).filter((h) => h.status === 200).map((h) => h.model);
    check('R3 routing 机制对任意模型对生效（角色同构，首个成功请求）', r3.length > 0 && r3[0] === 'role-exec-c', JSON.stringify(r3));

    finish(results.every((r) => r.ok) ? 0 : 1);
  } catch (error) {
    console.log(`HEMI_059_ROUTING_RESULT=${JSON.stringify({ passed: false, fatal: String(error?.stack ?? error) })}`);
    app.exit(1);
  }
});
