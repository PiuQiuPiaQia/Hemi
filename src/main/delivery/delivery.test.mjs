// 025 → 050 交付数据契约单测：v2 校验（files＋sources）与 v1 旧档案投影
// （projectDelivery，AC-11 确定性回看）。纯函数，无 IO。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_LIMITS,
  cleanSourceUrl,
  projectDelivery,
  validateDelivery,
} from './delivery.mjs';

function baseInput(overrides = {}) {
  return {
    files: [{ path: '/tmp/report.md', description: '调研报告' }],
    sources: [{ title: '气象台', url: 'https://weather.example.com' }],
    ...overrides,
  };
}

test('validateDelivery v2：合法输入通过并归一化', () => {
  const verdict = validateDelivery(baseInput());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.schemaVersion, 2);
  assert.deepEqual(verdict.value.files, [{ path: '/tmp/report.md', description: '调研报告' }]);
  assert.deepEqual(verdict.value.sources, [{ title: '气象台', url: 'https://weather.example.com/' }]);
});

test('validateDelivery v2：非对象拒绝；files 与 sources 全空拒绝（reason 面向执行器）', () => {
  assert.equal(validateDelivery('not-an-object').ok, false);
  assert.match(validateDelivery({}).reason, /至少占其一/);
  assert.match(validateDelivery({ files: [], sources: [] }).reason, /至少占其一/);
});

test('validateDelivery v2：纯来源声明（调研任务无交付文件）合法', () => {
  const verdict = validateDelivery({ files: [], sources: [{ title: 'A', url: 'https://a.example.com' }] });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.value.files, []);
  assert.equal(verdict.value.sources.length, 1);
});

test('validateDelivery v2：files 每项须有 path；数量上限拒绝', () => {
  assert.match(validateDelivery({ files: [{ description: '没有路径' }], sources: [] }).reason, /path/);
  const tooMany = Array.from({ length: DELIVERY_LIMITS.files + 1 }, (_, i) => ({ path: `/tmp/f${i}` }));
  assert.match(validateDelivery({ files: tooMany }).reason, /超出/);
});

test('validateDelivery v2：description 截到上限', () => {
  const verdict = validateDelivery({ files: [{ path: '/tmp/a.md', description: '长'.repeat(DELIVERY_LIMITS.fileDescription + 50) }] });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.files[0].description.length, DELIVERY_LIMITS.fileDescription);
});

test('validateDelivery v2：非 https 来源链接降级为纯标题条目', () => {
  const verdict = validateDelivery({
    files: [],
    sources: [
      { title: 'A', url: 'http://a.example.com' },
      { title: 'B', url: 'https://b.example.com' },
      { title: 'C', url: 'file:///etc/passwd' },
    ],
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(
    verdict.value.sources.map((s) => (s.url ? 'https' : 'plain')),
    ['plain', 'https', 'plain'],
  );
});

test('validateDelivery v2：指向本地文件/工作目录且无 https 的来源拒绝', () => {
  assert.match(
    validateDelivery({ files: [], sources: [{ title: '/Users/demo/Documents/估算.md' }] }).reason,
    /本地文件不是来源/,
  );
  assert.match(
    validateDelivery({ files: [], sources: [{ title: '高德路线实测', url: '本地文件：1280.1km' }] }).reason,
    /本地文件不是来源/,
  );
});

test('validateDelivery v2：有 https 链接的条目即使标题像路径也保留（外部依据）', () => {
  const verdict = validateDelivery({ files: [], sources: [{ title: '/Users/demo 页面快照', url: 'https://example.com/a' }] });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.sources.length, 1);
});

test('validateDelivery v2：来源数量上限拒绝', () => {
  const tooMany = Array.from({ length: DELIVERY_LIMITS.sources + 1 }, (_, i) => ({ title: `S${i}`, url: `https://s${i}.example.com` }));
  assert.match(validateDelivery({ files: [], sources: tooMany }).reason, /超出/);
});

test('cleanSourceUrl：只认可解析的 https', () => {
  assert.equal(cleanSourceUrl('https://a.example.com/x'), 'https://a.example.com/x');
  assert.equal(cleanSourceUrl('http://a.example.com'), null);
  assert.equal(cleanSourceUrl('not a url'), null);
  assert.equal(cleanSourceUrl(''), null);
});

// ---- v1 旧档案投影（projectDelivery；S0 探针 48/48 的规则移植） ----

test('projectDelivery：card 形态（summary＋blocks＋sources）投影成 Markdown', () => {
  const md = projectDelivery({
    form: 'card',
    kind: 'comparison',
    title: '天气对比',
    summary: '北京多云，上海晴。',
    blocks: [
      { type: 'p', text: '降水概率不同。' },
      { type: 'metrics', items: [{ label: '北京降水', value: '30', unit: '%', note: '午后' }] },
      {
        type: 'table',
        caption: '两市对比',
        columns: ['城市', '天气'],
        rows: [['北京', '多云'], ['上海', '晴|转多云']],
      },
      { type: 'checklist', groups: [{ title: '建议', items: [{ text: '带伞', note: '北京' }] }] },
    ],
    sources: [{ title: '气象台', url: 'https://weather.example.com', note: '今日口径' }],
    files: [],
  });
  assert.match(md, /^北京多云，上海晴。/);
  assert.match(md, /- \*\*北京降水\*\*：30%（午后）/);
  assert.match(md, /\*两市对比\*/);
  assert.match(md, /\| 城市 \| 天气 \|/);
  assert.match(md, /\| 北京 \| 多云 \|/);
  assert.match(md, /上海 \| 晴\\\|转多云/, '表格竖线转义');
  assert.match(md, /\*\*建议\*\*/);
  assert.match(md, /- 带伞（北京）/);
  assert.match(md, /\[气象台\]\(https:\/\/weather\.example\.com\)（今日口径）/);
});

test('projectDelivery：report 形态 section 降级为三级标题、partial 与空值如实', () => {
  const md = projectDelivery({
    form: 'report',
    kind: 'report',
    title: '调研报告',
    summary: '结论。',
    blocks: [
      { type: 'section', title: '章节一', blocks: [{ type: 'p', text: '内容' }] },
    ],
    partial: { missing: ['第二项未完成'], note: '其余可用' },
    sources: [],
    files: [],
  });
  assert.match(md, /### 章节一/);
  assert.match(md, /\*\*未完成\*\*：第二项未完成/);
});

test('projectDelivery：未知块类型抛错（调用方降级旧 resultText）', () => {
  assert.throws(() => projectDelivery({ summary: 's', blocks: [{ type: 'mystery' }], sources: [] }), /未知块类型/);
});
