// 025 → 050 交付声明工具单测（纯函数，无 SDK 依赖）。
import assert from 'node:assert/strict';
import test from 'node:test';

import hemiDelivery, { DELIVERY_TOOL_NAME } from './pi-delivery.mjs';

/** 捕获 registerTool 注册的 fake pi。 */
function fakePi() {
  const tools = [];
  return {
    tools,
    registerTool(def) {
      tools.push(def);
    },
    on() {},
  };
}

test('pi-delivery：run 模式注册 register_delivery，工具校验反馈可修正错误', async () => {
  const pi = fakePi();
  hemiDelivery(pi, { config: { enabled: true } });
  assert.equal(pi.tools.length, 1);
  const tool = pi.tools[0];
  assert.equal(tool.name, DELIVERY_TOOL_NAME);

  // v2：files＋sources 声明。
  const ok = await tool.execute('id-1', {
    files: [{ path: '/tmp/report.md', description: '调研报告' }],
    sources: [{ title: '气象台', url: 'https://weather.example.com' }],
  });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.details.deliveryAccepted, true);
  assert.equal(ok.details.files, 1);
  assert.match(ok.content[0].text, /已声明/);

  // 纯来源声明（调研任务）合法。
  const sourcesOnly = await tool.execute('id-1b', {
    files: [],
    sources: [{ title: '气象台', url: 'https://weather.example.com' }],
  });
  assert.equal(sourcesOnly.isError, undefined);

  // v1 形参（form/title/blocks）已退役：按 v2 口径拒绝并给可行动理由。
  const legacy = await tool.execute('id-1c', {
    form: 'card',
    title: '天气卡',
    summary: '多云。',
    blocks: [{ type: 'p', text: '降水 30%。' }],
  });
  assert.equal(legacy.isError, true);
  assert.match(legacy.content[0].text, /至少占其一/);

  const bad = await tool.execute('id-2', { files: [{ description: '没有路径' }] });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /path/);
});

test('pi-delivery：未启用时不注册（verify 只读复核不产交付）', () => {
  const pi = fakePi();
  hemiDelivery(pi, { config: {} });
  assert.equal(pi.tools.length, 0);
});
