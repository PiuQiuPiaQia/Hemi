import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { piModelOf } from '../lib/pi-model.mjs';
import { controlledStream } from './usage-ledger.mjs';
import { createRunJournal } from './run-journal.mjs';
import { sanitizedUrl, sanitizeErrorText, projectUsageRecord, projectUsageHistory } from './usage-history.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const localStamp = (ms = new Date()) => {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};

test('真实 SSE：URL 脱敏落盘、TTFT 从首个有效输出起算、token/reasoning 按 provider 报告、重开投影一致', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'h-usage-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const firstOutputObserved = Promise.withResolvers();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // 先发空 delta（无可见内容），150ms 后才发首个有效输出——TTFT 不应把响应头或空事件当起点。
      res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`);
        // Wait until the actual consumer has seen output, then create a measurable
        // generation window. Batched same-tick output legitimately has no TPS.
        void firstOutputObserved.promise.then(() => setTimeout(() => {
          res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 10 } } })}\n\n`);
          res.end('data: [DONE]\n\n');
        }, 20));
      }, 150);
    });
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  // 真实 fetch 规范拒绝 userinfo URL，userinfo/query 脱敏由 sanitizedUrl 单测覆盖；apiKey 不应落盘。
  const config = { modelKey: 'p/m', providerId: 'p', credentialRef: 'p', model: 'test-model', thinkingLevel: 'off', baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'DO_NOT_PERSIST' };
  const owner = { conversationId: 'conv-1', rootRunId: 'r1', generation: 1 };
  const journal = createRunJournal({ dir });
  await journal.beginRoot(owner);
  const execution = { journal, owner, plan: { role: 'main', primary: config, allowedFallbacks: [] }, store: { resolveStrict: async () => ({ ok: true, config }) }, budgets: { maxRequestsPerRun: 5 }, purpose: 'main' };
  const stream = controlledStream(streamSimple, () => execution)(piModelOf(config, 'hemi'),
    { messages: [{ role: 'system', content: 'Hemi', timestamp: 0, toolsAdded: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }] }, { role: 'user', content: 'hi', timestamp: 0 }] });
  for await (const event of stream) if (event.type === 'text_delta' && event.delta) firstOutputObserved.resolve();
  const answer = await stream.result();
  assert.equal(answer.stopReason, 'stop');

  const raw = await readFile(path.join(dir, 'run-journal.json'), 'utf8');
  assert.equal(raw.includes('DO_NOT_PERSIST'), false, 'apiKey 不得落盘');
  const row = Object.values(JSON.parse(raw).requests)[0];
  assert.equal(row.url, `http://127.0.0.1:${port}/v1/chat/completions`, '只保留协议+主机+路径');
  assert.ok(row.responseAt <= row.firstOutputAt, 'TTFT 基准不早于响应头');
  assert.ok(row.firstOutputAt - row.startedAt >= 100, '空 delta 不算首个有效输出');
  assert.deepEqual(row.tokenUsage, { uncachedInput: 5, output: 6, cacheRead: 10, cacheWrite: 0, reasoning: 0 }, 'openai-completions 明确报告 reasoning 分解（0）→ 如实取 0');

  // 重开（进程重启语义）后投影一致：持久化投影全链路可用。
  const reopened = createRunJournal({ dir });
  const page = projectUsageHistory(await reopened.snapshot(), {});
  assert.equal(page.total, 1);
  const record = page.records[0];
  assert.equal(record.status, 'success');
  assert.equal(record.conversationId, 'conv-1');
  assert.equal(record.url, `http://127.0.0.1:${port}/v1/chat/completions`);
  assert.equal(record.model, 'test-model');
  assert.equal(record.protocol, 'openai-completions');
  assert.equal(record.thinkingLevel, 'off');
  assert.equal(record.role, 'main');
  assert.equal(record.purpose, 'main');
  assert.equal(record.httpStatus, 200);
  assert.equal(record.input, 5);
  assert.equal(record.output, 6);
  assert.equal(record.cacheRead, 10);
  assert.equal(record.reasoning, 0, 'provider 明确报告 0 → 0；未报告才 null（test 3 覆盖）');
  assert.ok(record.ttftMs >= 100);
  assert.ok(record.durationMs >= record.ttftMs);
  assert.ok(record.tps > 0);
  assert.ok(record.error === null);
  assert.deepEqual(page.totals, { requests: 1, input: 5, output: 6, cacheRead: 10, cacheWrite: 0 });
  assert.equal(page.earliestAt, record.at);
  assert.deepEqual(page.daily, [{ date: localStamp(record.at), requests: 1, input: 5, output: 6, cacheRead: 10, cacheWrite: 0 }]);
});

test('回退逐 attempt 分行：失败 attempt 保留且不承担 tokens（不双计），成功 attempt 完整记录', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'h-usage-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let hits = 0;
  const sseChunk = payload => `data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', model: 'test', ...payload })}\n\n`;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits += 1;
      if (hits === 1) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'upstream exploded' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }));
      res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } }));
      res.end('data: [DONE]\n\n');
    });
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const configA = { modelKey: 'p/a', providerId: 'p', credentialRef: 'p', model: 'a-model', baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'K1' };
  const configB = { ...configA, modelKey: 'p/b', model: 'b-model' };
  const owner = { conversationId: 'conv-2', rootRunId: 'r2', generation: 1 };
  const journal = createRunJournal({ dir });
  await journal.beginRoot(owner);
  // recoveryTestClock：回退间隔（≥1s）压缩到毫秒级，只影响测试时钟不影响事实。
  const execution = { journal, owner, plan: { role: 'main', primary: configA, allowedFallbacks: [configB] },
    store: { resolveStrict: async key => ({ ok: true, config: key === 'p/a' ? configA : configB }) },
    budgets: { maxRequestsPerRun: 5 }, purpose: 'main',
    recoveryTestClock: { timers: { setTimeout: fn => setTimeout(fn, 1), clearTimeout: id => clearTimeout(id) } } };
  const answer = await controlledStream(streamSimple, () => execution)(piModelOf(configA, 'hemi'), { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }).result();
  assert.equal(answer.stopReason, 'stop');

  const state = await journal.snapshot();
  const rows = Object.values(state.requests).sort((x, y) => x.startedAt - y.startedAt);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].logicalCallId, rows[1].logicalCallId, '同一逻辑调用的两次 HTTP attempt');
  assert.equal(rows[0].actualModel.model, 'a-model');
  assert.equal(rows[1].actualModel.model, 'b-model');
  assert.equal(rows[0].httpStatus, 500);
  assert.ok(rows[0].error);
  assert.ok(rows[0].firstOutputAt === null, '失败 attempt 无有效输出');
  assert.deepEqual(rows[0].tokenUsage, { uncachedInput: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null }, '失败 attempt 不承担 tokens');
  assert.deepEqual(rows[1].tokenUsage, { uncachedInput: 4, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, '成功 attempt：openai 明确报告 reasoning 分解（0）');

  const page = projectUsageHistory(state, {});
  assert.equal(page.total, 2);
  assert.deepEqual(page.records.map(r => r.status).sort(), ['error', 'success']);
  assert.deepEqual(page.totals, { requests: 2, input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, 'tokens 只计成功 attempt，不双计');
  const failed = page.records.find(r => r.status === 'error');
  assert.equal(failed.httpStatus, 500);
  assert.ok(failed.error);
  assert.equal(failed.input, null);
  assert.equal(failed.output, null);
  assert.equal(failed.tps, null);
  assert.equal(failed.ttftMs, null);
  const success = page.records.find(r => r.status === 'success');
  assert.equal(success.model, 'b-model');
  assert.ok(success.ttftMs !== null);
  assert.equal(page.totals.input, page.records.filter(r => r.status === 'success').reduce((sum, r) => sum + r.input, 0));
});

test('running/重启不猜测终态；旧记录缺字段投影 null；零 token 成功请求保留且不伪 0', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'h-usage-fields-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = createRunJournal({ dir });
  const owner = { conversationId: 'conv-3', rootRunId: 'r3', generation: 1 };
  await journal.beginRoot(owner);
  await journal.requestStart(owner, { requestId: 'live', purpose: 'main', role: 'main', actualModel: { model: 'm', api: 'openai-completions', thinkingLevel: 'high' }, url: 'https://api.example.com/v1/chat' }, 5);
  await journal.requestResponse('live', { httpStatus: 200 });
  await journal.requestEnd('live', { tokenUsage: { uncachedInput: 3, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 7 }, coverage: 'complete' });
  // 旧格式：无 url/api/thinkingLevel/role/firstOutputAt/httpStatus。
  await journal.requestStart(owner, { requestId: 'legacy', purpose: 'subagent', actualModel: { modelKey: 'p/x', model: 'old' } }, 5);
  await journal.requestResponse('legacy', { httpStatus: 429 });
  // 零 token 成功：usage 整体未知。
  await journal.requestStart(owner, { requestId: 'zero', purpose: 'title', role: 'main', actualModel: { model: 't', api: 'openai-completions' }, url: 'https://api.example.com/v1/chat' }, 5);
  await journal.requestEnd('zero', { tokenUsage: { uncachedInput: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null }, coverage: 'unknown', error: null, failure: null });
  // 在途：无 requestEnd。
  await journal.requestStart(owner, { requestId: 'ghost', purpose: 'main', role: 'main', actualModel: { model: 'g', api: 'openai-completions' }, url: 'https://api.example.com/v1/chat' }, 5);

  const before = projectUsageHistory(await journal.snapshot(), {});
  assert.equal(before.total, 4);
  const byId = Object.fromEntries(before.records.map(r => [r.id, r]));
  assert.equal(byId.live.status, 'success');
  assert.equal(byId.live.reasoning, 7, 'provider 明确报告的 reasoning 保留数值');
  assert.equal(byId.legacy.status, 'running', '响应头已到但未终结 → running');
  assert.equal(byId.legacy.httpStatus, 429);
  assert.equal(byId.legacy.url, null, '旧记录无 url → null');
  assert.equal(byId.legacy.protocol, null, '旧记录无协议 → null');
  assert.equal(byId.legacy.thinkingLevel, null, '旧记录无思考强度 → null');
  assert.equal(byId.legacy.role, null, '旧子请求无角色 → null 不猜测');
  assert.equal(byId.legacy.endedAt, null);
  assert.equal(byId.legacy.durationMs, null);
  assert.equal(byId.legacy.ttftMs, null);
  assert.equal(byId.zero.status, 'success');
  assert.equal(byId.zero.input, null, '零 token 成功请求 usage 未知 → null 不伪 0');
  assert.equal(byId.zero.reasoning, null, 'provider 未报告（null/缺失）→ null，不伪 0');
  assert.equal(byId.ghost.status, 'running');

  await journal.recover(); // 进程重启：未终结请求不是在途——带 interruptionReason 归 error，页面不误判为进行中。
  const after = projectUsageHistory(await journal.snapshot(), {});
  const afterById = Object.fromEntries(after.records.map(r => [r.id, r]));
  assert.equal(afterById.live.status, 'success');
  assert.deepEqual(after.records.filter(r => r.status === 'error').map(r => r.id).sort(), ['ghost', 'legacy']);
  assert.ok(afterById.ghost.error.includes('进程重启'), '错误信息带重启原因');
});

test('sanitizedUrl 与投影纯函数：脱敏、缺字段、筛选统计与分页边界', () => {
  assert.equal(sanitizedUrl('https://user:pass@api.example.com/v1/chat?key=secret&sid=x#frag'), 'https://api.example.com/v1/chat');
  assert.equal(sanitizedUrl('http://127.0.0.1:9/v1'), 'http://127.0.0.1:9/v1');
  assert.equal(sanitizedUrl('not a url'), null);
  assert.equal(sanitizedUrl(''), null);
  assert.equal(sanitizedUrl(undefined), null);

  const at = (month, day, hour = 12, minute = 0) => new Date(2024, month - 1, day, hour, minute, 0, 0).getTime();
  const row = (id, startedAt, patch = {}) => ({
    requestId: id, startedAt, endedAt: startedAt + 1000, owner: { conversationId: 'c1' },
    purpose: 'main', role: 'main', actualModel: { model: 'm-a', api: 'openai-completions', thinkingLevel: 'high' },
    url: 'https://api.example.com/v1/chat', httpStatus: 200,
    tokenUsage: { uncachedInput: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 }, ...patch,
  });
  const unknown = { uncachedInput: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
  const state = { requests: {
    r1: row('r1', at(5, 1, 23, 59)),
    r2: row('r2', at(5, 2, 0, 0), { owner: { conversationId: 'c1' } }),
    // HTTP>=400 但无 error/failure 也如实归失败。
    r3: row('r3', at(5, 2, 10), { httpStatus: 500, tokenUsage: unknown }),
    r4: row('r4', at(5, 3, 9), { owner: { conversationId: 'c2' }, url: null, endedAt: null, tokenUsage: { uncachedInput: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 7 } }),
    r5: row('r5', at(5, 2, 11), { actualModel: { model: 'm-b', api: 'anthropic-messages', thinkingLevel: 'off' } }),
  } };

  const all = projectUsageHistory(state, {});
  assert.equal(all.total, 5);
  assert.deepEqual(all.records.map(r => r.id), ['r4', 'r5', 'r3', 'r2', 'r1'], '按开始时间降序');
  assert.deepEqual(all.daily.map(d => d.date), ['2024-05-01', '2024-05-02', '2024-05-03'], '本地日分桶升序，跨日边界 23:59/00:00');
  assert.equal(all.daily[1].requests, 3);
  assert.equal(all.daily[2].requests, 1);
  assert.deepEqual(all.totals, { requests: 5, input: 31, output: 16, cacheRead: 6, cacheWrite: 3 }, 'usage 未知的 r3 不贡献 tokens 但计数');
  assert.equal(all.earliestAt, at(5, 1, 23, 59));

  // from/to 含端点（按请求开始时间）。
  assert.deepEqual(projectUsageHistory(state, { from: at(5, 2, 0, 0), to: at(5, 2, 10) }).records.map(r => r.id), ['r3', 'r2']);
  // status 筛选同时影响 total/totals。
  const errors = projectUsageHistory(state, { status: 'error' });
  assert.deepEqual(errors.records.map(r => r.id), ['r3']);
  assert.deepEqual(errors.totals, { requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(projectUsageHistory(state, { status: 'running' }).total, 1);
  assert.equal(projectUsageHistory(state, { status: 'success' }).total, 3);
  assert.equal(projectUsageHistory(state, { status: 'all' }).total, 5);
  assert.equal(projectUsageHistory(state, { status: 'bogus' }).total, 5, '非法 status 不过滤');
  // query 不区分大小写子串（模型/URL/协议/会话）。
  assert.deepEqual(projectUsageHistory(state, { query: 'm-b' }).records.map(r => r.id), ['r5']);
  assert.deepEqual(projectUsageHistory(state, { query: 'M-B' }).records.map(r => r.id), ['r5']);
  assert.equal(projectUsageHistory(state, { query: 'anthropic' }).total, 1);
  assert.equal(projectUsageHistory(state, { query: 'api.example.com' }).total, 4, 'url 为 null 的 r4 不匹配');
  assert.equal(projectUsageHistory(state, { query: 'c2' }).total, 1);
  assert.deepEqual(projectUsageHistory(state, { query: 'no-such' }), { records: [], total: 0, daily: [], totals: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, earliestAt: null });
  // 分页只切 records；total/daily/totals/earliestAt 仍是全筛选集。
  const page = projectUsageHistory(state, { limit: 2, offset: 1 });
  assert.deepEqual(page.records.map(r => r.id), ['r5', 'r3']);
  assert.equal(page.total, 5);
  assert.equal(page.daily.length, 3);
  assert.deepEqual(page.totals, all.totals);
  assert.equal(page.earliestAt, all.earliestAt);
  assert.equal(projectUsageHistory(state, { limit: 2 }).records.length, 2, 'offset 缺省 0');
  assert.equal(projectUsageHistory(state, { limit: 5000 }).records.length, 5, 'limit 上限截断不越界');
  // 单条投影：reasoning 数值保留、tps 口径（生成窗口）。
  const record = projectUsageRecord(row('x', at(5, 2), { endedAt: at(5, 2) + 4000, firstOutputAt: at(5, 2) + 2000 }));
  assert.equal(record.tps, 2.5, 'output/((endedAt−firstOutputAt)/1000)');
  assert.equal(projectUsageRecord(row('y', 1000, { endedAt: 2000, tokenUsage: unknown })).tps, null);
  // 错误文本与 URL 二次脱敏：userinfo/query/hash 不进页面（旧记录/外部数据也防）。
  const leak = projectUsageRecord(row('leak', at(5, 2), { error: '请求失败: https://user:pass@api.example.com/v1/chat?api-key=secret#frag 上游 500', url: 'https://user:pass@api.example.com/v1/chat?key=k' }));
  assert.equal(leak.status, 'error');
  assert.equal(leak.error.includes('user:pass'), false);
  assert.equal(leak.error.includes('api-key'), false);
  assert.equal(leak.error.includes('#frag'), false);
  assert.ok(leak.error.includes('https://api.example.com/v1/chat'));
  assert.equal(leak.url, 'https://api.example.com/v1/chat');
  assert.equal(sanitizeErrorText('https://a.com/x@mail.com 失败'), 'https://a.com/x@mail.com 失败', 'path 中的 @ 不误伤');
  assert.equal(sanitizeErrorText(null), null);
});

test('真实 runtime 装配：createAgentRuntime.usageHistory 投影临时 journal（core→投影同源，含二次脱敏）', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'h-usage-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { createAgentRuntime } = await import('./core.mjs');
  const deps = { userDataDir: dir, getProfiles: () => ({}), resolveCapabilities: () => ({}), getAccessService: () => ({}), log: { info() {}, warn() {}, error() {} } };
  const runtime = await createAgentRuntime(deps);
  t.after(() => { try { runtime.disposeAll?.(); } catch { /* 测试结束清理 */ } });
  // 经 runtime 暴露的真实 journal 事实接口写入（不经过被测投影）；旧式带 query 的 url 模拟历史数据。
  const ownerA = { conversationId: 'conv-A', rootRunId: 'ra', generation: 0 };
  await runtime.journal.beginRoot(ownerA);
  await runtime.journal.requestStart(ownerA, { requestId: 'rq1', purpose: 'main', role: 'main',
    actualModel: { model: 'm', api: 'openai-completions', thinkingLevel: 'off' }, url: 'https://api.example.com/v1/chat?api-key=sekret' }, 5);
  await runtime.journal.requestEnd('rq1', { tokenUsage: { uncachedInput: 2, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, coverage: 'complete' });
  const ownerB = { conversationId: 'conv-B', rootRunId: 'rb', generation: 0 };
  await runtime.journal.beginRoot(ownerB);
  await runtime.journal.requestStart(ownerB, { requestId: 'rq2', purpose: 'subagent', actualModel: { model: 'old' } }, 5);

  const page = await runtime.usageHistory({ query: 'api.example.com' });
  assert.equal(page.total, 1);
  assert.equal(page.records[0].id, 'rq1');
  assert.equal(page.records[0].url, 'https://api.example.com/v1/chat', '投影侧 URL 二次脱敏（旧数据去 query）');
  assert.equal(page.records[0].reasoning, 0);
  const all = await runtime.usageHistory({});
  assert.equal(all.total, 2, '跨会话全局');
  assert.deepEqual(all.records.map(r => r.status).sort(), ['running', 'success'], 'rq2 未终结且非重启残留 → running；重启残留归 error 由 test 3 覆盖');
  assert.equal(all.records.find(r => r.id === 'rq2').conversationId, 'conv-B');

  // 持久化：同一 userDataDir 新开 runtime 读到同一历史（进程重启语义）。
  const runtime2 = await createAgentRuntime(deps);
  t.after(() => { try { runtime2.disposeAll?.(); } catch { /* 测试结束清理 */ } });
  const page2 = await runtime2.usageHistory({ status: 'success' });
  assert.equal(page2.total, 1);
  assert.equal(page2.records[0].id, 'rq1');
  assert.equal((await runtime2.usageHistory({})).earliestAt, page.records[0].at);
});

test('全链路集成：真实 SSE → controlledStream → 磁盘 journal → runtime.usageHistory（IPC 同一服务入口）筛选/分页/统计', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'h-usage-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let hits = 0;
  const sseChunk = payload => `data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', model: 'test', ...payload })}\n\n`;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits += 1;
      if (hits === 1) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'upstream exploded' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // 空 delta 先到：TTFT 不从响应头/空事件起算。
      res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: null }] }));
      setTimeout(() => {
        res.write(sseChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '好的' }, finish_reason: null }] }));
        setTimeout(() => {
          // 第二段内容与终态 usage 间隔 30ms：生成窗口稳定为正，TPS 可断言（同毫秒收尾会让窗口为 0）。
          res.write(sseChunk({ choices: [{ index: 0, delta: { content: '，已收到' }, finish_reason: null }] }));
          res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } }));
          res.end('data: [DONE]\n\n');
        }, 30);
      }, 120);
    });
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { createAgentRuntime } = await import('./core.mjs');
  const runtime = await createAgentRuntime({ userDataDir: dir, getProfiles: () => ({}), resolveCapabilities: () => ({}), getAccessService: () => ({}), log: { info() {}, warn() {}, error() {} } });
  t.after(() => { try { runtime.disposeAll?.(); } catch { /* 测试结束清理 */ } });
  await runtime.usageHistory({}); // 空查询等待 runtime 启动恢复（journalReady）完成，避免与 recover() 竞态。
  const configA = { modelKey: 'p/a', providerId: 'p', credentialRef: 'p', model: 'a-model', baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'K1' };
  const configB = { ...configA, modelKey: 'p/b', model: 'b-model' };
  const owner = { conversationId: 'conv-e2e', rootRunId: 're2e', generation: 0 };
  await runtime.journal.beginRoot(owner);
  const execution = { journal: runtime.journal, owner, plan: { role: 'main', primary: configA, allowedFallbacks: [configB] },
    store: { resolveStrict: async key => ({ ok: true, config: key === 'p/a' ? configA : configB }) },
    budgets: { maxRequestsPerRun: 5 }, purpose: 'main',
    recoveryTestClock: { timers: { setTimeout: fn => setTimeout(fn, 1), clearTimeout: id => clearTimeout(id) } } };
  const answer = await controlledStream(streamSimple, () => execution)(piModelOf(configA, 'hemi'),
    { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }).result();
  assert.equal(answer.stopReason, 'stop');

  // runtime.usageHistory 与 IPC usage:get-history 处理器调用的是同一入口。
  const all = await runtime.usageHistory({});
  assert.equal(all.total, 2, '回退两次 HTTP attempt 各一行');
  const success = all.records[0];
  assert.equal(success.status, 'success');
  assert.equal(success.model, 'b-model', '真实请求模型（回退后的候选）');
  assert.equal(success.protocol, 'openai-completions');
  assert.ok(success.ttftMs >= 100, 'TTFT 从首个有效输出起算，跳过响应头与空 delta');
  assert.equal(success.output, 2, '成功 attempt 按 provider 报告计 tokens');
  assert.ok(success.tps > 0, '生成窗口 TPS');
  const failed = all.records[1];
  assert.equal(failed.status, 'error');
  assert.equal(failed.httpStatus, 500);
  assert.equal(failed.output, null, '失败 attempt tokens 不伪 0');
  assert.equal(all.earliestAt, failed.at);

  // 筛选影响 total/totals/daily/earliestAt；分页只切 records 且统计不随之重复计算。
  const successOnly = await runtime.usageHistory({ status: 'success' });
  assert.equal(successOnly.total, 1);
  assert.deepEqual(successOnly.totals, { requests: 1, input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, 'tokens 只由成功 attempt 承担');
  assert.equal((await runtime.usageHistory({ query: 'b-model' })).total, 1);
  const paged = await runtime.usageHistory({ limit: 1, offset: 1 });
  assert.deepEqual(paged.records.map(r => r.model), ['a-model']);
  assert.equal(paged.total, 2);
  assert.deepEqual(paged.totals, all.totals);
  assert.deepEqual(paged.daily, all.daily);
  assert.equal(paged.earliestAt, all.earliestAt);
  assert.equal(all.daily.reduce((sum, bucket) => sum + bucket.requests, 0), 2, '按日统计覆盖全部筛选结果');
  assert.equal(all.daily.reduce((sum, bucket) => sum + bucket.input, 0), 4, '按日 tokens 与 totals 同源不双计');
});

test('failure-only 旧记录投影：status=error 且错误文本来自 failure.message（经脱敏）', () => {
  const record = projectUsageRecord({ requestId: 'f', startedAt: 1000, endedAt: 2000, failure: { kind: 'http', message: '上游 429: https://user:pass@api.example.com/v1?k=s' } });
  assert.equal(record.status, 'error');
  assert.equal(record.error, '上游 429: https://api.example.com/v1', '错误文本来自 failure.message 且去 query/userinfo');
  assert.equal(record.error.includes('user:pass'), false);
  assert.equal(record.error.includes('k=s'), false);
  assert.equal(projectUsageRecord({ requestId: 'g', startedAt: 1000, endedAt: 2000 }).error, null);
});

test('IPC 边界静态接线：preload getUsageHistory → usage:get-history → usageHistory 服务入口', async () => {
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ipc = await readFile(path.join(here, '../ipc/conversation.ipc.mjs'), 'utf8');
  const preload = await readFile(path.join(here, '../../preload/index.cjs'), 'utf8');
  const handlerAt = ipc.indexOf('ipcMain.handle(IPC.usage.getHistory');
  const serviceAt = ipc.indexOf('getAgentRuntime().usageHistory(options)');
  assert.ok(handlerAt >= 0 && serviceAt > handlerAt, 'usage:get-history 处理器必须调用 usageHistory 服务入口');
  assert.ok(preload.includes('getUsageHistory:'), 'preload 暴露 getUsageHistory');
  assert.ok(preload.includes("'usage:get-history'"), 'preload 经 usage:get-history 通道');
});
