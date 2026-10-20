// jev-client 单测：纯函数直测 + 注入 fetch/sleep 的行为覆盖。
// 契约夹具取自实验实录（experiments/jev-12306/results/*-jev.json 的真实响应形状）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  STATE_CONVENTIONS,
  buildQuestions,
  buildState,
  createJevClient,
  parseDecision,
  pingJev,
} from './jev-client.mjs';

const SNAP = {
  title: '12306',
  url: 'https://kyfw.12306.cn/otn/leftTicket/init',
  lines: ['[1] link 首页', '[2] textbox (fromStationText) 简拼 · 北京', '[3] clickable (query_ticket) 查询'],
  click: [{ i: '1', text: '[1] link 首页' }, { i: '3', text: '[3] clickable (query_ticket) 查询' }],
  type: [{ i: '2', text: '[2] textbox (fromStationText) 简拼 · 北京' }],
  select: [],
  refs: 3,
};

test('buildQuestions：空 select 列表省略问题，click/type 恒在或按需', () => {
  const q = buildQuestions(SNAP);
  assert.equal(q.operation.type, 'choice');
  assert.ok(q.operation.criteria.CLICK);
  assert.equal(q.click_target.criteria['3'], '[3] clickable (query_ticket) 查询');
  assert.ok(q.type_target, '有 textbox 时应有 type_target');
  assert.equal(q.select_target, undefined, '空 select 列表应省略问题');
});

test('parseDecision：正常解析、未知操作拒绝、越界下标拒绝', () => {
  const d = parseDecision(
    { operation: { type: 'choice', choice: 'CLICK', confidence: 0.88 }, click_target: { choice: '3' } },
    SNAP,
  );
  assert.deepEqual({ op: d.op, target: d.target }, { op: 'CLICK', target: 3 });
  assert.equal(d.confidence, 0.88);

  assert.throws(() => parseDecision({ operation: { choice: 'FIRE_MISSILE' } }, SNAP), /未知操作/);
  assert.throws(
    () => parseDecision({ operation: { choice: 'CLICK' }, click_target: { choice: '99' } }, SNAP),
    /不在元素表里/,
  );
  assert.throws(
    () => parseDecision({ operation: { choice: 'TYPE_TEXT' }, type_target: { choice: 'abc' } }, SNAP),
    /不在元素表里/,
  );
  // 非目标类操作不需要 target。
  const done = parseDecision({ operation: { choice: 'DONE', confidence: 0.5 } }, SNAP);
  assert.equal(done.target, null);
});

test('buildState：含目标、判据、上一步与通用约定', () => {
  const state = buildState({
    goal: '在出发地填入北京',
    successCriteria: '出发地框显示北京',
    snap: SNAP,
    last: { op: 'TYPE_TEXT', label: '出发地框', status: 'ok' },
  });
  assert.match(state, /当前子目标：在出发地填入北京/);
  assert.match(state, /成功判据：出发地框显示北京/);
  assert.match(state, /上一步：TYPE_TEXT（出发地框） → ok/);
  assert.match(state, new RegExp(STATE_CONVENTIONS.slice(0, 12)));
  assert.match(state, /\[3\] clickable \(query_ticket\) 查询/);
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('createJevClient：成功解析 + 429 退避计入 waitMs + 服务端错误重试一次', async () => {
  const sleeps = [];
  let calls = 0;
  const fetchLog = [];
  const client = createJevClient({
    baseUrl: 'https://jev.test/typesafe',
    apiKey: 'k-test',
    model: 'jev-test',
    fetchFn: async (url, init) => {
      calls += 1;
      fetchLog.push({ url: String(url), body: JSON.parse(init.body) });
      if (calls === 1) return jsonResponse(429, { error: { message: 'Rate limit exceeded: Retry after 2s' } });
      if (calls === 2) return jsonResponse(500, { error: { message: 'boom' } });
      return jsonResponse(200, {
        model: 'jev-test',
        answers: {
          operation: { type: 'choice', choice: 'CLICK', confidence: 0.9 },
          click_target: { choice: '3' },
        },
        usage: { input_tokens: 100 },
      });
    },
    sleepFn: async (ms) => sleeps.push(ms),
  });

  const d = await client.decide({ state: 'state-text', snap: SNAP });
  assert.deepEqual({ op: d.op, target: d.target }, { op: 'CLICK', target: 3 });
  assert.equal(d.usage.input_tokens, 100);
  // 429 → 2000+1000ms；500 → 2000ms。
  assert.deepEqual(sleeps, [3000, 2000]);
  assert.equal(d.waitMs, 5000);
  assert.equal(fetchLog[0].url, 'https://jev.test/typesafe/v1/systemone');
  assert.equal(fetchLog[0].body.model, 'jev-test');
  assert.equal(fetchLog[0].body.state, 'state-text');
});

test('createJevClient：401 不重试直接抛错', async () => {
  const client = createJevClient({
    baseUrl: 'https://jev.test',
    apiKey: 'bad',
    fetchFn: async () => jsonResponse(401, { error: { message: 'bad key' } }),
    sleepFn: async () => assert.fail('401 不应重试'),
  });
  await assert.rejects(client.decide({ state: 's', snap: SNAP }), /HTTP 401/);
});

test('createJevClient：noul 返回 0-1 概率', async () => {
  const client = createJevClient({
    baseUrl: 'https://jev.test',
    apiKey: 'k',
    fetchFn: async () => jsonResponse(200, { answers: { ok: { noul: 0.92 } } }),
    sleepFn: async () => {},
  });
  const v = await client.noul({ state: 's', instructions: '结果出现了吗？' });
  assert.equal(v.satisfied, 0.92);
});

test('pingJev：200 返回置信与模型名，questions/criteria 走 record 形状', async () => {
  const seen = [];
  const result = await pingJev({
    baseUrl: 'https://jev.test/',
    apiKey: 'k',
    model: 'typesafe-ai/jev',
    fetchImpl: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return jsonResponse(200, {
        model: 'typesafe-ai/jev',
        answers: { ping: { type: 'choice', choice: 'b', confidence: 1 } },
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedModel, 'typesafe-ai/jev');
  assert.equal(result.confidence, 1);
  assert.equal(seen[0].url, 'https://jev.test/v1/systemone');
  assert.equal(seen[0].body.questions.ping.criteria.b, '2');
});

test('pingJev：401 文案点破「模型 ID 错也报认证失败」；缺配置直接拒绝', async () => {
  await assert.rejects(
    pingJev({
      baseUrl: 'https://jev.test',
      apiKey: 'k',
      fetchImpl: async () => jsonResponse(401, { message: 'Authentication failed' }),
    }),
    /模型 ID/,
  );
  await assert.rejects(
    pingJev({
      baseUrl: 'https://jev.test',
      apiKey: 'k',
      fetchImpl: async () => jsonResponse(404, { message: 'Not found' }),
    }),
    /服务地址/,
  );
  await assert.rejects(pingJev({ baseUrl: '', apiKey: 'k' }), /服务地址未配置/);
  await assert.rejects(pingJev({ baseUrl: 'https://jev.test', apiKey: '' }), /Key 未配置/);
});

// ---------- 021：双置信度、取消、有界退避、证据透传 ----------

test('021 parseDecision：目标置信度单独保留，缺失为 null（act-policy 负责判定）', () => {
  const d = parseDecision(
    {
      operation: { choice: 'CLICK', confidence: 0.99 },
      click_target: { choice: '3', confidence: 0.1 },
    },
    SNAP,
  );
  assert.equal(d.confidence, 0.99, 'confidence 延续 020 语义＝操作置信度');
  assert.equal(d.operationConfidence, 0.99);
  assert.equal(d.targetConfidence, 0.1, 'review 基线 P1 的 0.99/0.1 现在两头都留痕');

  const noTarget = parseDecision(
    { operation: { choice: 'TYPE_TEXT', confidence: 0.8 }, type_target: { choice: '2' } },
    SNAP,
  );
  assert.equal(noTarget.targetConfidence, null, '目标答案没带 confidence → null，不伪造');
  assert.equal(noTarget.operationConfidence, 0.8);

  const done = parseDecision({ operation: { choice: 'DONE', confidence: 0.6 } }, SNAP);
  assert.equal(done.target, null);
  assert.equal(done.targetConfidence, null);
});

test('021 buildState：快照带结果证据时，正文节选与截断标注进 state', () => {
  const withEvidence = buildState({
    goal: 'g',
    successCriteria: 'c',
    snap: {
      ...SNAP,
      evidence: { excerpt: 'G1 次列车 有票', textChars: 1200, digest: 'e1', truncated: true },
    },
    last: null,
  });
  assert.match(withEvidence, /页面可见正文（节选/);
  assert.match(withEvidence, /G1 次列车 有票/);
  assert.match(withEvidence, /覆盖不完整/, '截断必须显式声明');

  const without = buildState({ goal: 'g', snap: SNAP, last: null });
  assert.ok(!without.includes('页面可见正文'), '旧快照（无证据段）不伪造正文');
});

test('0.2.2 复盘：recentOps 进 state；证据截断与扩展侧 cap（1200）同步', () => {
  const withOps = buildState({
    goal: '按价格排序',
    snap: SNAP,
    last: { op: 'CLICK', label: '低价优先', status: 'ok' },
    recentOps: ['CLICK 低价优先 → 已执行', '核验未过（判据满足度 0.3），继续操作'],
  });
  assert.match(withOps, /最近操作（从旧到新；某操作后页面无变化就别再重复它）：CLICK 低价优先 → 已执行；核验未过/);

  const long = '价'.repeat(1500);
  const capped = buildState({
    goal: 'g',
    snap: { ...SNAP, evidence: { excerpt: long, textChars: 1500, digest: 'e', truncated: true } },
    last: null,
  });
  assert.ok(capped.includes(long.slice(0, 1200)), '1200 字内应完整保留');
  assert.ok(!capped.includes(long.slice(0, 1201)), '第二层截断放宽到 1200（与扩展同步）');

  const noOps = buildState({ goal: 'g', snap: SNAP, last: null });
  assert.ok(!noOps.includes('最近操作'), '无操作史时不伪造该行');
});

test('021 AbortSignal：取消后不再发出请求，等待中的决策立即中断', async () => {
  const client = createJevClient({
    baseUrl: 'https://jev.test',
    apiKey: 'k',
    fetchFn: async () => {
      throw new Error('取消后不应再发请求');
    },
    sleepFn: async () => {},
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.decide({ state: 's', snap: SNAP, signal: controller.signal }),
    /中断/,
    '已取消的信号在发请求前就该拒绝',
  );
});

test('021 AbortSignal：在途请求被外部中止时立刻失败，不进入网络错重试', async () => {
  let calls = 0;
  const client = createJevClient({
    baseUrl: 'https://jev.test',
    apiKey: 'k',
    fetchFn: async (_url, init) => {
      calls += 1;
      // 模拟真实 fetch：外部 signal 中止 → 请求 reject。
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    },
    sleepFn: async () => assert.fail('取消不应触发重试等待'),
  });
  const controller = new AbortController();
  const pending = client.decide({ state: 's', snap: SNAP, signal: controller.signal });
  pending.catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  await assert.rejects(pending, /中断/);
  assert.equal(calls, 1);
});

test('021 有界退避：429 要求的等待超过总额上限时放弃，不发更多请求', async () => {
  let calls = 0;
  const client = createJevClient({
    baseUrl: 'https://jev.test',
    apiKey: 'k',
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(429, { error: { message: 'Rate limit exceeded: Retry after 30s' } });
    },
    sleepFn: async () => assert.fail('超上限不应真的等待'),
  });
  await assert.rejects(client.decide({ state: 's', snap: SNAP }), /限流退避超过上限/);
  assert.equal(calls, 1, '第一次就超上限 → 只发一次');
});

test('5xx 三连 503 后恢复：递增退避 2s/3s/4s 吸收十几秒网关抖动（2026-09-23 复盘）', async () => {
  const sleeps = [];
  let calls = 0;
  const client = createJevClient({
    baseUrl: 'https://jev.test/typesafe',
    apiKey: 'k-test',
    fetchFn: async () => {
      calls += 1;
      if (calls <= 3) {
        return jsonResponse(503, { error: { message: 'Service temporarily unavailable. Please try again shortly.' } });
      }
      return jsonResponse(200, {
        answers: { operation: { type: 'choice', choice: 'DONE', confidence: 0.9 } },
      });
    },
    sleepFn: async (ms) => sleeps.push(ms),
  });
  const d = await client.noul({ state: 's', instructions: 'ok?' });
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [2000, 3000, 4000]);
  assert.equal(d.waitMs, 9000);
});

test('5xx 超过 3 次重试后如实报错（分钟级故障不硬等）', async () => {
  let calls = 0;
  const client = createJevClient({
    baseUrl: 'https://jev.test/typesafe',
    apiKey: 'k-test',
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(503, { error: { message: 'Service temporarily unavailable.' } });
    },
    sleepFn: async () => {},
  });
  await assert.rejects(() => client.noul({ state: 's', instructions: 'ok?' }), /HTTP 503/);
  assert.equal(calls, 4); // 首调 + 3 次重试
});

test('createJevClient：空 key 不发请求，提前报「未配置」（空 Bearer 在官方端点恰好是 403）', async () => {
  let calls = 0;
  const client = createJevClient({
    baseUrl: 'https://jev.test/typesafe',
    apiKey: '',
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(200, { answers: {} });
    },
  });
  await assert.rejects(() => client.noul({ state: 's', instructions: 'ok?' }), /未配置/);
  assert.equal(calls, 0);
});
