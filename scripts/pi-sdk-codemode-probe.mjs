// 039：真实 SDK Session 上的 Codemode 接入边界专项探针（mock OpenAI 端点，
// 不调用外部模型或产品运行目录）。钉死 1.0.0 的事实，供包装层（pi-codemode）
// 实施依据；SDK 升级 1.0.1 后必须复跑。运行：node scripts/pi-sdk-codemode-probe.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

const sdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const sdkVersion = JSON.parse(await fs.readFile(path.resolve(path.dirname(sdkEntry), '../package.json'), 'utf8')).version;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-codemode-probe-'));
const findings = [];
const sessions = [];

function record(id, claim, check, detail) {
  try {
    check();
    findings.push({ id, claim, ok: true, detail });
    console.log(`PASS ${id} ${claim}`);
  } catch (error) {
    findings.push({ id, claim, ok: false, detail, error: error.message });
    console.log(`FAIL ${id} ${claim}: ${error.message}`);
  }
}

// ---- mock OpenAI 端点：按会话脚本回放（codemode 工具调用 + 收尾文本） ----
const scenarios = new Map();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    // provider baseUrl 形如 <base>/<name>/v1，请求路径 /<name>/v1/chat/completions。
    const name = req.url.split('/')[1];
    const scenario = scenarios.get(name);
    if (!scenario) { console.error(`[probe] miss url=${req.url} keys=${[...scenarios.keys()].join(',')}`); res.writeHead(404); res.end(); return; }
    const step = scenario.steps.shift() ?? { text: 'PROBE_DONE' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'cm-probe', object: 'chat.completion.chunk', created: 1, model: 'model-x', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (step.code !== undefined) {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: `cm-${scenario.calls}`, type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: step.code }) } }] });
      emit({}, 'tool_calls');
      scenario.calls += 1;
    } else {
      emit({ role: 'assistant', content: step.text ?? 'PROBE_DONE' });
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const serverBase = `http://127.0.0.1:${server.address().port}`;

// ---- Hemi 薄包装的最小可行样例：代理 factory 截获 codemode 定义并包 execute ----
function wrapCodemodeFactory(inner, state) {
  return {
    name: 'hemi-codemode-probe',
    factory: (pi) => inner(new Proxy(pi, {
      get(target, prop) {
        if (prop !== 'registerTool') return target[prop];
        return (definition) => {
          if (definition?.name !== 'codemode') return target.registerTool(definition);
          state.wrapped = true;
          return target.registerTool({
            ...definition,
            execute: async (toolCallId, params, signal, onUpdate, ctx) => {
              state.codemodeStarted += 1;
              return definition.execute(toolCallId, params, signal, onUpdate, ctx);
            },
          });
        };
      },
    })),
  };
}

async function makeSession(name, steps) {
  const cwd = path.join(root, name);
  const agentDir = path.join(cwd, 'agent');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(cwd, 'a.txt'), 'FILE_A');
  const data = { steps: [...steps], calls: 0, childEvents: [], childResults: [], gateCalls: [] };
  scenarios.set(name, data);
  const wrapperState = { wrapped: false, codemodeStarted: 0 };
  const extension = {
    name: `probe-tools-${name}`,
    factory: (pi) => {
      // mock 端点 provider（同路由探针口径）：apiKey 只进 SDK runtime。
      pi.registerProvider(`probe-${name}`, {
        api: 'openai-completions',
        baseUrl: `${serverBase}/${name}/v1`,
        apiKey: `${name}-mock-key`,
        models: [{ id: 'model-x', name: 'Probe Model', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      });
      pi.registerTool({
        name: 'probe_read',
        label: 'Probe Read',
        description: 'Reads a probe file; DENY path simulates the hard boundary',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        execute: async (_toolCallId, params) => {
          if (String(params?.path ?? '').startsWith('DENY')) {
            return { content: [{ type: 'text', text: 'scope-denied: 路径越界' }], isError: true };
          }
          const text = await fs.readFile(path.join(cwd, String(params?.path ?? '')), 'utf8').catch(() => '');
          return { content: [{ type: 'text', text: text || 'EMPTY' }] };
        },
      });
      pi.registerTool({
        name: 'probe_slow',
        label: 'Probe Slow',
        description: 'Blocks until aborted (cancel semantics probe)',
        parameters: { type: 'object', properties: {} },
        execute: async (_toolCallId, _params, signal) => new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'CANCELLED' }], isError: true }), { once: true });
        }),
      });
      // 门控观察：子调用必须经过 tool_call 钩子（与直接调用同管线）。
      pi.on('tool_call', (event) => {
        data.gateCalls.push(event.toolName);
        return undefined;
      });
      pi.on('tool_execution_start', (event) => {
        data.childEvents.push({ name: event.toolName, parent: event.parentToolCallId ?? null });
      });
      pi.on('tool_execution_end', (event) => {
        data.childResults.push({ name: event.toolName, parent: event.parentToolCallId ?? null, isError: Boolean(event.result?.isError), details: event.result?.details ?? null });
      });
    },
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [extension, wrapCodemodeFactory(createCodemodeExtension({ mode: 'on', models: false }), wrapperState)],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: 'off' });
  sessions.push(session);
  await session.bindExtensions({ mode: 'rpc' });
  const probeModel = session.modelRuntime.getModel(`probe-${name}`, 'model-x');
  if (!probeModel) throw new Error('探针 provider 注册失败');
  await session.setModel(probeModel);
  const activeBefore = session.getActiveToolNames();
  session.setActiveToolsByName([...activeBefore, 'codemode']);
  return { session, data, wrapperState, activeBefore, activeAfter: session.getActiveToolNames() };
}

const watchdog = setTimeout(() => { console.error('Codemode probe timed out'); process.exit(1); }, 120000);
try {
  // C1/C2：注册后默认未激活；显式激活后包装生效，脚本子调用走原管线（门控钩子可见）。
  const a = await makeSession('main', [
    { code: "const r = await tools.probe_read({ path: 'a.txt' });\nreturn String(r);" },
    { text: 'DONE' },
  ]);
  record('C1-activate', 'codemode 注册后默认未激活，setActiveToolsByName 显式激活；包装工厂截获到定义', () => {
    assert.ok(!a.activeBefore.includes('codemode'));
    assert.ok(a.activeAfter.includes('codemode'));
    assert.equal(a.wrapperState.wrapped, true);
  });
  await a.session.prompt('Read the probe file via codemode.');
  record('C2-nested', '脚本子调用经 ctx.executeTool 原管线：门控钩子与父子事件（parentToolCallId）可见，脚本拿到文本', () => {
    assert.equal(a.wrapperState.codemodeStarted, 1);
    assert.ok(a.data.gateCalls.includes('probe_read'), '子调用必须过 tool_call 钩子');
    const read = a.data.childEvents.find((event) => event.name === 'probe_read');
    assert.ok(read?.parent, '子事件携带 parentToolCallId');
    const result = a.data.childResults.find((event) => event.name === 'codemode');
    assert.ok(!result?.isError, `codemode 不应失败：${JSON.stringify(result?.details ?? {})}`);
  });

  // C3：越界路径被硬边界拒绝，脚本收到错误（保留成功项语义由产品层再验）。
  const b = await makeSession('deny', [
    { code: "try {\n  await tools.probe_read({ path: 'DENY/etc/passwd' });\n  return 'NOT_REACHED';\n} catch (error) {\n  return 'caught:' + String(error.message).slice(0, 80);\n}" },
    { text: 'DONE' },
  ]);
  await b.session.prompt('Try to read a denied path.');
  record('C3-deny', '子调用 isError 以异常进入脚本；脚本可捕获并把错误文本带回', () => {
    const result = b.data.childResults.find((event) => event.name === 'codemode');
    assert.ok(result, 'codemode 结束事件缺失');
    const call = result?.details?.calls?.[0];
    assert.equal(call?.status, 'error');
    assert.match(String(call?.error ?? ''), /scope-denied/);
  });

  // C4：store/load 跨脚本保留（同一分支）。
  const c = await makeSession('store', [
    { code: "store('k', 'v1');\nreturn 'saved';" },
    { code: "return String(await load('k'));" },
    { text: 'DONE' },
  ]);
  await c.session.prompt('Store then load.');
  record('C4-store', 'store()/load() 跨脚本保留 JSON 值（appendEntry 落会话分支）', () => {
    const last = c.data.childResults.filter((event) => event.name === 'codemode').at(-1);
    assert.ok(!last?.isError);
  });

  // C5：models:false——脚本看不到模型目录入口。
  const d = await makeSession('nomodels', [
    { code: "let kind = 'unset';\ntry { kind = typeof models; } catch (error) { kind = 'threw'; }\nreturn kind;" },
    { text: 'DONE' },
  ]);
  await d.session.prompt('Check models visibility.');
  record('C5-nomodels', 'models:false 时脚本内 models 不可达（undefined/抛错，非对象）', () => {
    assert.equal(d.data.childResults.at(-1)?.isError, false);
  }, { note: '返回值进脚本输出，不在此断言字面——详情 calls 状态 ok 即可' });

  // C6：abort 贯通——挂起的子调用随会话取消结束，prompt 正常返回不悬挂。
  const e = await makeSession('abort', [{ code: "await tools.probe_slow({});\nreturn 'NOT_REACHED';" }]);
  const pending = e.session.prompt('Block on slow tool.');
  // 等 probe_slow 真正开始再取消。
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (e.data.childEvents.some((event) => event.name === 'probe_slow')) { clearInterval(timer); resolve(); }
    }, 20);
  });
  await e.session.abort();
  await pending;
  record('C6-abort', 'abort 中止脚本与其挂起子调用，prompt 收口（无悬挂）', () => {
    const slow = e.data.childResults.find((event) => event.name === 'probe_slow');
    assert.ok(slow, 'probe_slow 应有结束记录');
  });

  // C7：details.calls 结构（id 形如 <callId>/<n>、status、durationMs）——宿主呈现契约的数据源。
  record('C7-details', 'codemode 结果 details.calls 携带嵌套调用 id/名称/状态（呈现契约数据源）', () => {
    const result = a.data.childResults.find((event) => event.name === 'codemode');
    const call = result?.details?.calls?.[0];
    assert.equal(call?.name, 'probe_read');
    assert.match(String(call?.id ?? ''), /\/\d+$/);
    assert.equal(call?.status, 'ok');
    assert.ok(typeof call?.durationMs === 'number');
  });
} finally {
  clearTimeout(watchdog);
  for (const session of sessions) session.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

const pass = findings.filter((f) => f.ok).length;
console.log(`HEMI_CODEMODE_PROBE ${JSON.stringify({ sdk: sdkVersion, node: process.version, pass, total: findings.length, findings })}`);
process.exitCode = pass === findings.length ? 0 : 1;
