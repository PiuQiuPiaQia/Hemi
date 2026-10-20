import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownPlainText } from './markdown-plain-text.ts';

test('067 跨屏外复制保留代码／表格／链接的可读正文，不混入 Markdown 标记或链接目标', () => {
  const text = markdownPlainText('**标题** [链接](https://example.com/private) `value`\n\n| 名称 | 数量 |\n| --- | --- |\n| 结果 | 42 |\n\n```ts\nconst answer = 42;\n```');
  assert.ok(text.includes('标题 链接 value'));
  assert.ok(text.includes('名称\t数量') && text.includes('结果\t42'));
  assert.ok(text.includes('const answer = 42;'));
  assert.ok(!text.includes('**') && !text.includes('https://example.com/private') && !text.includes('```'));
});
