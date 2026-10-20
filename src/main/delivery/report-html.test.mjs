// 025 报告 HTML 导出单测：转义、无脚本、同源内容、https 边界（纯函数）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeHtml, renderBodyReportHtml, renderMarkdownHtml, renderReportHtml, reportFileName } from './report-html.mjs';

function baseDelivery(overrides = {}) {
  return {
    schemaVersion: 1,
    form: 'report',
    kind: 'report',
    title: '调研报告',
    summary: '一句结论。',
    blocks: [
      { type: 'p', text: '第一段正文。' },
      {
        type: 'section',
        title: '关键发现',
        blocks: [{ type: 'p', text: '结论 A。' }],
      },
      {
        type: 'table',
        columns: ['候选', '结论'],
        rows: [['A', '3.6g'], ['B', '未查到']],
      },
    ],
    sources: [
      { id: 'src-1', title: '官方文档', url: 'https://docs.example.com/a' },
      { id: 'src-2', title: '内部备注', note: '用户提供' },
    ],
    mainArtifacts: [],
    attachmentArtifacts: ['art-9'],
    reason: '多主题调研',
    partial: null,
    degraded: [],
    presentationError: null,
    registeredAt: 1758600000000,
    ...overrides,
  };
}

test('renderReportHtml：标题/结论/表格/来源齐备，目录含章节', () => {
  const html = renderReportHtml({
    delivery: baseDelivery(),
    task: { taskText: '做一次调研', outcome: 'complete' },
    artifacts: [{ id: 'art-9', kind: 'file', name: '附录.md', path: '/tmp/附录.md' }],
    generatedAt: 1758600100000,
  });
  assert.ok(html.includes('<title>调研报告</title>'));
  assert.ok(html.includes('一句结论。'));
  assert.ok(html.includes('第一段正文。'));
  assert.ok(html.includes('关键发现'));
  assert.ok(html.includes('未查到'));
  assert.ok(html.includes('href="#section-1"'));
  assert.ok(html.includes('https://docs.example.com/a'));
  assert.ok(html.includes('附录.md'));
  assert.ok(html.includes('用户提供'));
});

test('renderReportHtml：HTML/脚本注入全部转义，输出无 script 标签', () => {
  const html = renderReportHtml({
    delivery: baseDelivery({
      title: '<script>alert(1)</script>',
      summary: '<img src=x onerror=alert(2)>',
      blocks: [{ type: 'p', text: '</style><script>fetch("//evil")</script>' }],
      sources: [{ id: 'src-1', title: 'x', url: 'https://a.example.com/"onmouseover="alert(3)' }],
    }),
    task: { taskText: '<b>任务</b>' },
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img')); // 事件属性不会成为真实标签（转义后只是文本）
  assert.ok(!html.includes('<b>任务</b>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderReportHtml：非 https 来源链接不出现在导出里', () => {
  const html = renderReportHtml({
    delivery: baseDelivery({
      sources: [{ id: 'src-1', title: '危险链接', url: 'javascript:alert(1)' }],
    }),
    task: {},
  });
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('危险链接'));
});

test('renderReportHtml：readImage 提供图片则内嵌 data URL', () => {
  const html = renderReportHtml({
    delivery: baseDelivery({
      blocks: [{ type: 'image', artifactId: 'art-1', caption: '架构图' }],
    }),
    task: {},
    readImage: (artifactId) => (artifactId === 'art-1' ? 'data:image/png;base64,AAAA' : null),
  });
  assert.ok(html.includes('data:image/png;base64,AAAA'));
  assert.ok(html.includes('架构图'));
});

test('escapeHtml 与 reportFileName 基本语义', () => {
  assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  // 全角冒号是合法文件名字符，保留；半角非法字符直接删除。
  assert.equal(reportFileName('北京 天气：<调研>?'), '北京 天气：调研.html');
  assert.equal(reportFileName('a/b\\c*d'), 'abcd.html');
  assert.equal(reportFileName(''), '任务报告.html');
});

// ---- 050：正文契约导出（renderMarkdownHtml / renderBodyReportHtml） ----

test('renderMarkdownHtml：标题/列表/表格/代码/行内标记（导出用确定性渲染）', () => {
  const md = [
    '有 3 家可用，见下表。',
    '',
    '## 对比',
    '',
    '| 平台 | 价格 |',
    '| --- | --- |',
    '| A | ¥10 |',
    '| B | ¥20 |',
    '',
    '- **A 家**最便宜',
    '- 普通 `代码` 项',
    '',
    '1. 第一条',
    '2. 第二条',
    '',
    '```js',
    'const x = 1 < 2;',
    '```',
    '',
    '详见 [官网](https://example.com)（http 链接不点开）。',
  ].join('\n');
  const html = renderMarkdownHtml(md);
  assert.match(html, /<p>有 3 家可用/);
  assert.match(html, /<h3>对比<\/h3>/, '## 渲染为 h3（h1 留给页标题）');
  assert.match(html, /<th>平台<\/th>/);
  assert.match(html, /<td>¥10<\/td>/);
  assert.match(html, /<li><strong>A 家<\/strong>最便宜<\/li>/);
  assert.match(html, /<code>代码<\/code>/);
  assert.match(html, /<ol>[\s\S]*?<li>第一条<\/li>[\s\S]*?<li>第二条<\/li>[\s\S]*?<\/ol>/);
  assert.match(html, /&lt;script&gt;/.test(html) ? /never/ : /const x = 1 &lt; 2;/);
  assert.match(html, /<a href="https:\/\/example\.com\/?"/);
  assert.ok(!/<a href="http:/.test(html), 'http 链接降级为纯文本');
});

test('renderBodyReportHtml：正文＋notices＋sources，标题用任务原文', () => {
  const html = renderBodyReportHtml({
    task: { taskText: '调研生图平台', outcome: 'complete', resultText: '有 **6** 家。', notices: ['一个页面异常'] },
    sources: [
      { title: 'A', url: 'https://a.example.com', visited: true },
      { title: 'B', url: 'https://b.example.com', visited: false },
    ],
    generatedAt: Date.UTC(2026, 9, 10, 8, 30),
  });
  assert.match(html, /<h1>调研生图平台<\/h1>/);
  assert.match(html, /<strong>6<\/strong>/);
  assert.match(html, /附带提醒：一个页面异常/);
  assert.match(html, /href="https:\/\/a\.example\.com\/?"/);
  assert.match(html, /声明未访问/);
});
