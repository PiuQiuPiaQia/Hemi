// pi-web 单测：纯函数直测 + 假 pi/fetch 覆盖工具注册与执行路径。
// 不触网（fetchImpl 全注入）、不触 userData。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WEB_PROVIDERS,
  WEB_TOOLS,
  clampSnippet,
  createResultCache,
  default as hemiWeb,
  formatExtractResult,
  formatSearchResults,
  isSafeWebUrl,
} from './pi-web.mjs';
import { POLICY_READONLY } from './policy.mjs';

/** 假 pi：只记 registerTool 的调用。 */
function fakePi() {
  const registered = [];
  return {
    registered,
    registerTool(tool) {
      registered.push(tool);
    },
  };
}

/** 假 fetch：按 URL 分发应答体，记录每次调用。 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    const route = routes.find(([match]) => String(url).includes(match));
    if (!route) throw new Error(`假 fetch 没有路由：${url}`);
    const [, respond] = route;
    return { ok: true, status: 200, json: async () => respond(calls[calls.length - 1]) };
  };
  return { impl, calls };
}

/** 023：扩展开关经显式 config 注入，测试不再改全局 process.env（R-06）。 */
let currentConfig = {};
function withConfig(config, run) {
  const saved = currentConfig;
  currentConfig = { ...saved, ...config };
  try {
    return run();
  } finally {
    currentConfig = saved;
  }
}

test('WEB_TOOLS 进门禁只读层（挂上即免问放行的单一事实）', () => {
  for (const tool of WEB_TOOLS) {
    assert.ok(POLICY_READONLY.readOnlyTools.includes(tool), `${tool} 应在 readOnlyTools`);
  }
});

test('isSafeWebUrl：公网 http/https 放行，协议与内网地址拒绝', () => {
  assert.equal(isSafeWebUrl('https://example.com/a?b=1'), true);
  assert.equal(isSafeWebUrl('http://example.com'), true);
  assert.equal(isSafeWebUrl('ftp://example.com'), false);
  assert.equal(isSafeWebUrl('file:///etc/passwd'), false);
  assert.equal(isSafeWebUrl('javascript:alert(1)'), false);
  assert.equal(isSafeWebUrl('not a url'), false);
  assert.equal(isSafeWebUrl(''), false);

  // 回环 / 内网 / 链路本地 / CGNAT / 云元数据。
  for (const bad of [
    'http://localhost',
    'http://localhost:8080',
    'http://127.0.0.1/x',
    'http://10.1.2.3/',
    'http://172.16.0.9/',
    'http://172.31.255.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://metadata.google.internal/',
    'http://something.internal/',
    'http://nas.local/',
  ]) {
    assert.equal(isSafeWebUrl(bad), false, `${bad} 应被拒`);
  }
  // 公网 v4 与普通域名不受影响。
  assert.equal(isSafeWebUrl('http://8.8.8.8/'), true);
  assert.equal(isSafeWebUrl('https://172.256.1.1/'), false); // 非法 v4 也不放行
});

test('clampSnippet / formatSearchResults：空白归一、空结果有交代', () => {
  assert.equal(clampSnippet('a\n b\t c'), 'a b c');
  assert.ok(clampSnippet('长'.repeat(400)).endsWith('…'));

  assert.ok(formatSearchResults('x', []).includes('没有搜到'));
  const text = formatSearchResults('豆包 价格', [
    { title: '结果一', url: 'https://a.com', snippet: '摘要' },
    { title: '', url: 'https://b.com', snippet: '摘要二' },
  ]);
  assert.ok(text.includes('搜到 2 条'));
  assert.ok(text.includes('1. 结果一'));
  assert.ok(text.includes('(无标题)'));
});

test('formatExtractResult：空正文给指引，超长截断', () => {
  assert.ok(formatExtractResult('https://a.com', '', 1000).includes('没有可提取的正文'));
  const long = formatExtractResult('https://a.com', '字'.repeat(20000), 500);
  assert.ok(long.includes('【正文已截断】'));
  assert.ok(long.length < 600);
});

test('createResultCache：TTL 过期与容量淘汰（注入时钟）', () => {
  let tick = 1000;
  const cache = createResultCache({ ttlMs: 100, maxEntries: 2, now: () => tick });
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  tick = 1050; // 未过期
  assert.equal(cache.get('a'), 1);
  tick = 1200; // 过期
  assert.equal(cache.get('a'), null);

  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // 容量 2，最旧的 a 被淘汰
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  cache.get('b'); // 刷新 b 的位次
  cache.set('d', 4); // 淘汰 c（不是 b）
  assert.equal(cache.get('c'), null);
  assert.equal(cache.get('b'), 2);
});

test('hemiWeb：环境未开/没 key 不注册任何工具', () => {
  withConfig({ enabled: false }, () => {
    const pi = fakePi();
    hemiWeb(pi);
    assert.equal(pi.registered.length, 0);
  });
  withConfig({ enabled: true, apiKey: '' }, () => {
    const pi = fakePi();
    hemiWeb(pi);
    assert.equal(pi.registered.length, 0);
  });
});

test('hemiWeb：开启后注册 web_search / web_extract，执行走注入的 fetch', async () => {
  const { impl, calls } = fakeFetch([
    ['/search', () => ({
      results: [
        { title: 'Tavily 结果', url: 'https://example.com/a', content: '正文  摘要\n换行' },
      ],
    })],
  ]);

  const pi = fakePi();
  await withConfig(
    {
      enabled: true,
      provider: 'tavily',
      apiKey: 'tvly-test',
    },
    async () => {
      hemiWeb(pi, { config: currentConfig, fetchImpl: impl });
      assert.deepEqual(
        pi.registered.map((tool) => tool.name).sort(),
        ['web_extract', 'web_search'],
      );

      const search = pi.registered.find((tool) => tool.name === 'web_search');
      const first = await search.execute('id1', { query: '豆包 tts 价格' });
      assert.ok(first.content[0].text.includes('Tavily 结果'));
      assert.equal(first.details.cached, false);
      assert.equal(calls[0].body.query, '豆包 tts 价格');
      assert.equal(calls[0].body.max_results, 5);

      // 相同查询命中缓存：不再发请求。
      const second = await search.execute('id2', { query: '豆包 tts 价格' });
      assert.equal(second.details.cached, true);
      assert.equal(calls.length, 1);

      // count 夹取：超界回落到 10。
      await search.execute('id3', { query: '另一问', count: 99 });
      assert.equal(calls[1].body.max_results, 10);
    },
  );
});

test('hemiWeb：web_extract 拒绝内网地址，公网地址走 provider 并缓存', async () => {
  const { impl, calls } = fakeFetch([
    ['/extract', ({ body }) => (body.urls[0] === 'https://example.com/doc'
      ? { results: [{ url: 'https://example.com/doc', raw_content: `${'长'.repeat(50)}正文` }], failed_results: [] }
      : { results: [], failed_results: [{ url: body.urls[0], error: 'x' }] })],
  ]);

  const pi = fakePi();
  await withConfig(
    { enabled: true, provider: 'tavily', apiKey: 'tvly-test' },
    async () => {
      hemiWeb(pi, { config: currentConfig, fetchImpl: impl });
      const extract = pi.registered.find((tool) => tool.name === 'web_extract');

      await assert.rejects(
        () => extract.execute('e0', { url: 'http://169.254.169.254/' }),
        /内网|localhost|http/,
      );
      assert.equal(calls.length, 0); // 校验拦在请求之前

      const ok = await extract.execute('e1', { url: 'https://example.com/doc' });
      assert.ok(ok.content[0].text.includes('正文'));
      assert.equal(ok.details.cached, false);

      const cached = await extract.execute('e2', { url: 'https://example.com/doc' });
      assert.equal(cached.details.cached, true);
      assert.equal(calls.length, 1);
    },
  );
});

test('WEB_PROVIDERS.tavily.search：非 200 出人话错误', async () => {
  const boom = async () => ({ ok: false, status: 401, text: async () => '{"detail":"bad key"}' });
  await assert.rejects(
    () => WEB_PROVIDERS.tavily.search({ query: 'q', count: 5, apiKey: 'k', fetchImpl: boom }),
    /401/,
  );
});

test('tavily：5xx 三连后恢复；网络错 3 次重试后如实穿透（2026-09-23 加固）', async () => {
  const respond = (status, body) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  const mkPi = () => {
    const registered = [];
    return { registered, registerTool: (t) => registered.push(t) };
  };
  const config = { enabled: true, provider: 'tavily', apiKey: 'tvly-test' };

  // 5xx 三连 → 第四次成功
  let calls = 0;
  const pi1 = mkPi();
  hemiWeb(pi1, {
    config,
    fetchImpl: async () => {
      calls += 1;
      return calls <= 2 ? respond(503, { error: 'unavailable' }) : respond(200, { results: [] });
    },
  });
  const search1 = pi1.registered.find((t) => t.name === 'web_search');
  const r1 = await search1.execute('id1', { query: '重试测试一' });
  assert.equal(calls, 3); // 首调 + 2 次重试后恢复（退避 1s）
  assert.ok(r1);

  // 网络错四次 → 报「连不上」
  let netCalls = 0;
  const pi2 = mkPi();
  hemiWeb(pi2, {
    config,
    fetchImpl: async () => {
      netCalls += 1;
      throw new Error('ECONNRESET');
    },
  });
  const search2 = pi2.registered.find((t) => t.name === 'web_search');
  await assert.rejects(
    () => search2.execute('id2', { query: '重试测试二' }),
    /搜索服务连不上/,
  );
  assert.equal(netCalls, 4); // 首调 + 3 次重试
});
