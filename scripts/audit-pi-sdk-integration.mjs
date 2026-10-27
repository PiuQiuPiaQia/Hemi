/**
 * Pi SDK 接缝审计：真实 SDK／生产适配器＋本机可控 provider，无真实模型请求。
 *
 * 从工程根目录运行：npx electron scripts/audit-pi-sdk-integration.mjs
 * 输出：HEMI_PI_AUDIT_EVIDENCE/summary.json；默认在 .visual 下新建时间戳目录。
 * exit 0 仅代表诊断跑完；result 记录实际观察，不代表产品验收通过。
 * 路由 overflow 单独调用生产回调，未覆盖完整压缩恢复；其余调用边界见 scope。
 */
import { app } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { createHemiSession } from '../src/main/agent/hemi-session.mjs';
import { createAgentRuntime } from '../src/main/agent-runtime/index.mjs';
import {
  createRoutingExtension,
} from '../src/main/agent/pi-factory.mjs';
import { candidateModelDef, providerRegistrationOf } from '../src/main/lib/pi-model.mjs';
import { chatTurn } from '../src/main/services/text-model.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-sdk-audit-'));
app.setName('hemi');
app.setPath('userData', path.join(temp, 'userData'));

const servers = [];
const sessions = [];
const requests = [];
const result = {};
let runtime;
let phase = '';
let sequence = 0;
let sessionSequence = 0;
let blockedToolExecutions = 0;

function respond(res, body, tool = null, anthropic = false) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (anthropic) {
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', { message: { id: `audit-${sequence}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'AUDIT_OK' } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    emit('message_stop', {}); res.end(); return;
  }
  const emit = (data) => res.write(`data: ${JSON.stringify({
    id: `audit-${sequence}`, object: 'chat.completion.chunk', created: 1, model: body.model, ...data,
  })}\n\n`);
  const delta = tool
    ? { role: 'assistant', tool_calls: [{
      index: 0, id: `call-${sequence}`, type: 'function',
      function: { name: tool, arguments: '{}' },
    }] }
    : { role: 'assistant', content: 'AUDIT_OK' };
  emit({ choices: [{ index: 0, delta, finish_reason: null }] });
  emit({
    choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  });
  res.end('data: [DONE]\n\n');
}

async function endpoint(label) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        sequence++;
        const body = JSON.parse(raw);
        requests.push({
          phase, endpoint: label, path: req.url, body,
          authIsOriginal: req.headers.authorization === 'Bearer audit-original' || req.headers['x-api-key'] === 'audit-original',
          authIsRotated: req.headers.authorization === 'Bearer audit-rotated' || req.headers['x-api-key'] === 'audit-rotated',
        });
        // 第二次请求已经有 tool 消息，直接收口，避免反复触发工具。
        const tool = phase === 'blocked-tool' && body.messages?.at(-1)?.role !== 'tool'
          ? 'audit_unclassified_tool' : null;
        respond(res, body, tool, new URL(req.url, 'http://localhost').pathname.endsWith('/messages'));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function observed(name) {
  return requests.filter((request) => request.phase === name).map((request) => ({
    endpoint: request.endpoint,
    path: request.path,
    model: request.body.model,
    reasoning_effort: request.body.reasoning_effort ?? null,
    thinking: request.body.thinking ?? null,
    enable_thinking: request.body.enable_thinking ?? null,
    max_tokens: request.body.max_tokens ?? null,
    max_completion_tokens: request.body.max_completion_tokens ?? null,
    output_config: request.body.output_config ?? null,
    authIsOriginal: request.authIsOriginal,
    authIsRotated: request.authIsRotated,
  }));
}

function sessionDir(label) {
  const dir = path.join(temp, `${label}-${sessionSequence++}`);
  fs.mkdirSync(dir);
  return dir;
}

async function hemi(name, options) {
  phase = name;
  const dir = sessionDir('hemi');
  const session = createHemiSession({
    cwd: dir, agentDir: dir, tools: [], features: {},
    settings: { retry: { enabled: false } }, ...options,
  });
  sessions.push(session);
  try {
    assert.equal((await session.prompt('audit synthetic request')).lastText, 'AUDIT_OK');
    return observed(name);
  } finally {
    session.dispose();
  }
}

async function nativeSdk(name, base, level) {
  phase = name;
  const dir = sessionDir('native');
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(dir, 'auth.json'), modelsPath: path.join(dir, 'models.json'),
  });
  // 与 Hemi 使用同一 provider 定义；只对照 SDK 创建会话时的 model/level 装配。
  modelRuntime.registerProvider('native-audit', providerRegistrationOf(base));
  const model = modelRuntime.getModel('native-audit', base.model);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model, thinkingLevel: level,
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir),
    tools: [], noTools: 'all',
  });
  sessions.push(session);
  try {
    await session.prompt('audit native SDK');
    return observed(name);
  } finally {
    session.dispose();
  }
}

app.whenReady().then(async () => {
  try {
    const a = await endpoint('A');
    const b = await endpoint('B');
    const base = {
      baseUrl: a, api: 'openai-completions', apiKey: 'audit-original',
      model: 'audit-generic', thinkingLevel: 'high',
    };

    // 产品保留低／中／高三档，分别对照真实发出的请求，不能只看配置快照。
    result.thinkingLevels = {};
    for (const level of ['low', 'medium', 'high']) {
      result.thinkingLevels[level] = {
        hemi: await hemi(`hemi-${level}`, { model: base, thinking: { level } }),
        nativeSdk: await nativeSdk(`native-${level}`, base, level),
        routed: await hemi(`routed-${level}`, {
          routing: { execution: { ...base, thinkingLevel: level }, fallback: null },
        }),
      };
    }

    result.formatMatrix = [];
    const formats = ['openai', 'deepseek', 'zai', 'qwen'];
    for (const format of formats) {
      for (const level of ['low', 'medium', 'high']) {
        const config = { ...base, thinkingFormat: format, thinkingLevel: level };
        const agent = await hemi(`format-${format}-${level}`, { model: config, thinking: { level, format } });
        phase = `light-${format}-${level}`;
        await chatTurn({ ...config, messages: [{ role: 'user', content: 'audit format' }], maxPreStreamRetries: 0 });
        result.formatMatrix.push({ format, level, agent, light: observed(phase) });
      }
    }
    result.anthropicLevels = [];
    for (const model of ['audit-anthropic', 'claude-opus-4-6']) {
      for (const level of ['low', 'medium', 'high']) {
        const config = { ...base, model, api: 'anthropic-messages' };
        const agent = await hemi(`anthropic-${model}-${level}`, { model: config, thinking: { level } });
        phase = `light-anthropic-${model}-${level}`;
        const response = await chatTurn({ ...config, thinkingLevel: level, messages: [{ role: 'user', content: 'audit anthropic' }], maxPreStreamRetries: 0 });
        assert.equal(response.content, 'AUDIT_OK');
        result.anthropicLevels.push({ model, level, agent, light: observed(phase) });
      }
    }

    // 诊断对照：用 SDK settings 固定 medium，排除上面的初始化故障，再单查 format。
    result.manualFormatControl = await hemi('manual-format-control', {
      model: base, thinking: { level: 'medium', format: 'deepseek' },
      settings: { defaultThinkingLevel: 'medium', retry: { enabled: false } },
    });
    result.routedFormat = await hemi('routed-format', {
      routing: { execution: { ...base, thinkingLevel: 'medium', thinkingFormat: 'deepseek' }, fallback: null },
    });

    const catalog = DEEPSEEK_MODELS['deepseek-flash'];
    result.catalogDefinitions = {
      sdk: {
        contextWindow: catalog.contextWindow, maxTokens: catalog.maxTokens,
        thinkingLevelMap: catalog.thinkingLevelMap, compat: catalog.compat,
      },
      hemi: candidateModelDef({ ...base, model: 'deepseek-flash' }),
    };
    result.hemiRoutedDeepseek = await hemi('hemi-routed-deepseek', {
      routing: { execution: { ...base, model: 'deepseek-flash', thinkingLevel: 'default' }, fallback: null },
    });
    for (const format of [null, 'qwen']) {
      phase = `light-catalog-${format}`;
      await chatTurn({
        ...base, model: 'deepseek-flash', thinkingFormat: format, thinkingLevel: 'medium',
        messages: [{ role: 'user', content: 'audit light' }], timeoutMs: 3000, maxPreStreamRetries: 0,
      });
      result[phase] = observed(phase);
    }

    result.fullUrlAgent = await hemi('full-url-agent', {
      model: { ...base, baseUrl: `${a}/chat/completions` }, thinking: { level: 'medium' },
    });
    phase = 'full-url-light';
    await chatTurn({
      ...base, baseUrl: `${a}/chat/completions`, messages: [{ role: 'user', content: 'audit light' }],
      timeoutMs: 3000, maxPreStreamRetries: 0,
    });
    result.fullUrlLight = observed(phase);

    phase = 'blocked-tool';
    const progress = [];
    const dir = sessionDir('blocked-tool');
    const blocked = createHemiSession({
      cwd: dir, agentDir: dir, model: base, features: {}, tools: ['audit_unclassified_tool'],
      settings: { retry: { enabled: false } },
      extraExtensions: [{
        name: 'audit-tool',
        factory: (pi) => pi.registerTool({
          name: 'audit_unclassified_tool', label: 'audit tool', description: 'synthetic tool without Hemi boundary',
          parameters: { type: 'object', properties: {} },
          async execute() {
            blockedToolExecutions++;
            throw new Error('AUDIT_TOOL_EXECUTED_UNEXPECTEDLY');
          },
        }),
      }],
    });
    sessions.push(blocked);
    blocked.on('progress', (event) => progress.push(event));
    await blocked.prompt('audit gate error event');
    const archive = await blocked.exportEntries();
    result.blockedTool = {
      executeCalls: blockedToolExecutions,
      adapterEvents: progress.map((event) => ({
        kind: event.kind, tool: event.tool, isError: event.isError, text: event.text?.slice(0, 150),
      })),
      sdkResults: archive.entries.map((entry) => entry.message).filter((message) => message?.role === 'toolResult')
        .map((message) => ({ isError: message.isError, content: message.content })),
    };
    blocked.dispose();

    // 真实生产 runtime.obtain；未走设置页 IPC，也未替换内部会话工厂。
    const archives = new Map();
    runtime = createAgentRuntime({
      loadArchiveAgent: (id) => archives.get(id), loadArchiveTurns: () => [],
      saveArchiveAgent: (id, payload) => { archives.set(id, payload); return true; },
      getSkillService: () => null, getWorkspaceService: () => null,
      onEventTurn: () => {}, onTaskState: () => {},
    });
    const context = {
      conversationId: 'conv-provider-cache-audit', inputSource: 'text', workspace: null, routed: false,
      config: { ...base, modelKey: 'audit/same-id', supportsVision: true },
    };
    phase = 'cache-first';
    const first = await runtime.obtain(context);
    await first.runTurn({ userText: 'audit first' });
    phase = 'cache-updated';
    const updated = await runtime.obtain({
      ...context, config: { ...context.config, baseUrl: b, apiKey: 'audit-rotated' },
    });
    await updated.runTurn({ userText: 'audit provider config updated' });
    result.providerCache = {
      sameInstance: first === updated, first: observed('cache-first'),
      afterProviderChange: observed('cache-updated'), expectedEndpoint: 'B', expectedAuthRotated: true,
    };

    // 仅生产路由回调级诊断；没有执行真实 SDK 的溢出／摘要／压缩重试。
    let virtual;
    const routingRuntime = { state: { slot: 'primary', fallbackUsed: false } };
    createRoutingExtension({
      routing: { execution: base, fallback: { ...base, model: 'audit-fallback' } }, runtime: routingRuntime,
    }).factory({ registerProvider() {}, registerVirtualModel(value) { virtual = value; } });
    const ctx = { modelRegistry: { find: (provider, model) => `${provider}/${model}` } };
    const before = virtual.route({ reason: 'user' }, ctx);
    const after = virtual.route({
      reason: 'retry', state: before.state,
      failed: { message: { stopReason: 'error', errorMessage: '400 context_length_exceeded maximum context length exceeded', content: [] } },
    }, ctx);
    result.overflowRoute = { before, after, expectedModel: before.model, expectedFallbackUsed: false };

    const summary = {
      sdk: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).version,
      hemi: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version,
      scope: 'Installed SDK + production adapters + localhost provider, synthetic config only. No renderer/settings IPC/live provider. Format control injects SDK settings for diagnosis. Overflow only calls the production route callback.',
      result,
    };
    const output = path.resolve(process.env.HEMI_PI_AUDIT_EVIDENCE ?? path.join(root, '.visual/workflow/vision', `pi-sdk-integration-${Date.now()}`), 'summary.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
    if (process.argv.includes('--verify')) {
      for (const level of ['low', 'medium', 'high']) {
        for (const kind of ['hemi', 'nativeSdk', 'routed']) assert.equal(result.thinkingLevels[level][kind][0].reasoning_effort, level);
      }
      for (const row of result.formatMatrix) {
        const [agent] = row.agent, [light] = row.light;
        for (const key of ['reasoning_effort', 'thinking', 'enable_thinking', 'max_tokens']) assert.deepEqual(agent[key], light[key]);
        if (row.format === 'openai') assert.equal(agent.reasoning_effort, row.level);
        else if (row.format === 'qwen') assert.equal(agent.enable_thinking, true);
        else assert.equal(agent.thinking.type, 'enabled');
      }
      for (const row of result.anthropicLevels) {
        const [agent] = row.agent, [light] = row.light;
        assert.equal(new URL(agent.path, 'http://localhost').pathname, '/v1/messages');
        assert.equal(agent.authIsOriginal, true);
        assert.ok(agent.thinking);
        for (const key of ['thinking', 'output_config', 'max_tokens']) assert.deepEqual(agent[key], light[key]);
      }
      assert.deepEqual(result.manualFormatControl[0].thinking, result.routedFormat[0].thinking);
      assert.equal(result.catalogDefinitions.hemi.compat.requiresReasoningContentOnAssistantMessages, true);
      assert.deepEqual(result.catalogDefinitions.hemi.thinkingLevelMap, result.catalogDefinitions.sdk.thinkingLevelMap);
      assert.equal(result['light-catalog-qwen'][0].enable_thinking, true);
      assert.equal(result['light-catalog-qwen'][0].thinking, null);
      assert.equal(result.fullUrlAgent[0].path, result.fullUrlLight[0].path);
      assert.equal(result.blockedTool.executeCalls, 0);
      assert.equal(result.blockedTool.adapterEvents.find((e) => e.kind === 'tool-end').isError, true);
      assert.equal(result.blockedTool.sdkResults[0].isError, true);
      assert.equal(result.providerCache.sameInstance, false);
      assert.equal(result.providerCache.afterProviderChange[0].endpoint, 'B');
      assert.equal(result.providerCache.afterProviderChange[0].authIsRotated, true);
      assert.equal(result.overflowRoute.after.model, result.overflowRoute.before.model);
      assert.equal(result.overflowRoute.after.state.fallbackUsed, false);
    }
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('AUDIT_FAILED_PHASE', phase, requests.slice(-3).map((request) => ({ phase: request.phase, path: request.path })));
    console.error(error);
    process.exitCode = 1;
  } finally {
    runtime?.disposeAll();
    for (const session of sessions) session.dispose();
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  }
});
