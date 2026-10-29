// 066 订阅额度：资格判断、未知百分比、格式化与有界轮询/迟到结果防护。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQuotaPoller,
  formatQuotaReset,
  formatQuotaValue,
  normalizeQuotaView,
  quotaTargets,
  quotaTone,
} from './subscription-quota.ts';

const sub = (id, oauthProvider, extra = {}) => ({ id, oauthProvider, hasApiKey: true, updatedAt: 1, ...extra });

test('只查询本机已登录的 openai / bigmodel 订阅', () => {
  const providers = [sub('a', 'openai'), sub('b', 'bigmodel'), sub('c', 'anthropic'), sub('d', 'github-copilot'), { id: 'e', hasApiKey: true }, sub('f', 'openai', { source: 'cloud' }), sub('g', 'bigmodel', { hasApiKey: false })];
  assert.deepEqual(quotaTargets(providers, { canQuery: true }).map((t) => t.providerId), ['a', 'b']);
});

test('Bot / 外部目录 / 缺桥方法时一律不查询', () => {
  const providers = [sub('a', 'openai')];
  assert.equal(quotaTargets(providers, { canQuery: true, environment: 'bot' }).length, 0);
  assert.equal(quotaTargets(providers, { canQuery: true, external: true }).length, 0);
  assert.equal(quotaTargets(providers, { canQuery: false }).length, 0);
});

test('账号重新登录（updatedAt 变化）身份随之变化', () => {
  const [before] = quotaTargets([sub('a', 'openai', { updatedAt: 1 })], { canQuery: true });
  const [after] = quotaTargets([sub('a', 'openai', { updatedAt: 2 })], { canQuery: true });
  assert.notEqual(before.identity, after.identity);
});

test('未知百分比不显示 0%，也不画进度', () => {
  const view = normalizeQuotaView({ provider: 'openai', status: 'ok', fetchedAt: 1, windows: [{ id: 'w', label: '周额度', remainingPercent: 'NaN' }] }, 'openai');
  assert.equal(view.windows[0].remainingPercent, null);
  assert.equal(formatQuotaValue(view.windows[0]).text, '剩余未知');
  assert.equal(quotaTone(null), 'unknown');
  assert.equal(formatQuotaValue({ id: 'w', label: 'x', remainingPercent: null, used: 30, unit: '次' }).text, '已用 30 次');
});

test('非 ok 状态丢弃窗口；provider 不匹配视为无效', () => {
  const view = normalizeQuotaView({ provider: 'openai', status: 'unavailable', fetchedAt: 1, windows: [{ id: 'w', label: 'x', remainingPercent: 50 }] }, 'openai');
  assert.deepEqual(view.windows, []);
  assert.equal(normalizeQuotaView({ provider: 'bigmodel', status: 'ok', windows: [] }, 'openai'), null);
});

test('百分比钳到 0–100，计数给出剩余/上限', () => {
  const view = normalizeQuotaView({ provider: 'openai', status: 'ok', fetchedAt: 1, windows: [{ id: 'w', label: 'x', remainingPercent: 140, used: 72, limit: 1200, unit: '次' }] }, 'openai');
  assert.equal(view.windows[0].remainingPercent, 100);
  assert.deepEqual(formatQuotaValue(view.windows[0]), { text: '剩 100%', detail: '1,128 / 1,200 次' });
  assert.equal(quotaTone(8), 'danger');
  // 服务器 remaining 与 limit-used 有取整差时以服务器值为准（GLM 实测差 1）。
  assert.equal(formatQuotaValue({ id: 'w', label: 'x', remainingPercent: 98, used: 195, limit: 12000, remaining: 11804, unit: '积分' }).detail, '11,804 / 12,000 积分');
  assert.deepEqual(formatQuotaValue({ id: 'w', label: 'x', remainingPercent: null, limit: 100, remaining: 40 }), { text: '剩 40', detail: '共 100' });
  assert.equal(quotaTone(20), 'warn');
});

test('重置时间：一天内相对，远期给星期或日期', () => {
  const now = new Date(2026, 9, 29, 23, 0).getTime();
  assert.equal(formatQuotaReset(now + 47 * 60_000, now), '47 分钟后重置');
  assert.equal(formatQuotaReset(now + 2.5 * 3_600_000, now), '2 小时 30 分后重置');
  assert.equal(formatQuotaReset(now + 3 * 86_400_000, now), '周日 23:00 重置');
  assert.equal(formatQuotaReset(now + 10 * 86_400_000, now), '11月8日 重置');
  assert.equal(formatQuotaReset(undefined, now), null);
  assert.equal(formatQuotaReset(now - 3_600_000, now), null);
});

function fakeTimers() {
  const queue = [];
  return {
    timers: { setTimeout: (fn, ms) => { const h = { fn, ms }; queue.push(h); return h; }, clearTimeout: (h) => { const i = queue.indexOf(h); if (i >= 0) queue.splice(i, 1); } },
    fire() { const h = queue.shift(); h?.fn(); },
    get pending() { return queue.length; },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const okView = (provider, percent) => ({ provider, status: 'ok', fetchedAt: 1, windows: [{ id: 'w', label: 'x', remainingPercent: percent }] });
const target = { oauthProvider: 'openai', identity: 'openai:a:1:1' };

test('挂载读一次；不可见时跳过轮询，可见后补查过期项', async () => {
  let clock = 0;
  let visible = true;
  const calls = [];
  const t = fakeTimers();
  const poller = createQuotaPoller({ targets: [target], fetchQuota: async (p, o) => { calls.push(o?.force ?? false); return okView(p, 50); }, onChange() {}, now: () => clock, isVisible: () => visible, timers: t.timers });
  poller.start();
  await flush();
  assert.equal(calls.length, 1);
  visible = false;
  clock = 60_000;
  t.fire();
  await flush();
  assert.equal(calls.length, 1, '不可见时不发请求');
  visible = true;
  poller.onVisible();
  await flush();
  assert.equal(calls.length, 2);
  clock = 61_000;
  t.fire();
  await flush();
  assert.equal(calls.length, 2, '刚查过的不重复查');
  poller.dispose();
  assert.equal(t.pending, 0);
});

test('卸载后迟到结果被丢弃', async () => {
  let resolve;
  const changes = [];
  const t = fakeTimers();
  const poller = createQuotaPoller({ targets: [target], fetchQuota: () => new Promise((r) => { resolve = r; }), onChange: (e) => changes.push(e), timers: t.timers });
  poller.start();
  const before = changes.length;
  poller.dispose();
  resolve(okView('openai', 40));
  await flush();
  assert.equal(changes.length, before);
});

test('强制刷新让在途旧结果作废；失败保留旧数据并带错误', async () => {
  const resolvers = [];
  const t = fakeTimers();
  let latest = {};
  const poller = createQuotaPoller({ targets: [target], fetchQuota: () => new Promise((resolve, reject) => resolvers.push({ resolve, reject })), onChange: (e) => { latest = e; }, timers: t.timers });
  poller.start();
  poller.refresh();
  resolvers[1].resolve(okView('openai', 70));
  await flush();
  resolvers[0].resolve(okView('openai', 10));
  await flush();
  assert.equal(latest[target.identity].view.windows[0].remainingPercent, 70);
  poller.refresh();
  resolvers[2].reject(new Error("Error invoking remote method 'q': Error: 超时"));
  await flush();
  assert.equal(latest[target.identity].error, '超时');
  assert.equal(latest[target.identity].view.windows[0].remainingPercent, 70);
  poller.dispose();
});

test('缓存中的在途标记不被新 poller 继承', () => {
  const t = fakeTimers();
  const poller = createQuotaPoller({ targets: [target], fetchQuota: async () => okView('openai', 1), onChange() {}, initial: { [target.identity]: { view: null, error: null, loading: true, receivedAt: null } }, isVisible: () => false, timers: t.timers });
  assert.equal(poller.snapshot()[target.identity].loading, false);
  poller.dispose();
});
