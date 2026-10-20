import assert from 'node:assert/strict';
import test from 'node:test';

import { boundAutolink } from './autolink-boundary.ts';

test('自动链接尾巴的全角右括号被剥掉（href 百分号编码形态）', () => {
  const r = boundAutolink('https://kie.ai/zh-CN%EF%BC%89', 'https://kie.ai/zh-CN）');
  assert.equal(r.href, 'https://kie.ai/zh-CN');
  assert.equal(r.text, 'https://kie.ai/zh-CN');
});

test('www 自动链接补了 http 前缀也能对上并剥掉', () => {
  const r = boundAutolink('http://www.apiyi.com%EF%BC%89', 'www.apiyi.com）');
  assert.equal(r.href, 'http://www.apiyi.com');
  assert.equal(r.text, 'www.apiyi.com');
});

test('连续多个收尾标点一次剥净', () => {
  const r = boundAutolink('https://example.com/a%EF%BC%89%E3%80%82', 'https://example.com/a）。');
  assert.equal(r.href, 'https://example.com/a');
  assert.equal(r.text, 'https://example.com/a');
});

test('显式链接（文字不是网址）不动', () => {
  const pair = { href: 'https://example.com/a%EF%BC%89', text: '看这个网站）' };
  assert.deepEqual(boundAutolink(pair.href, pair.text), pair);
});

test('文本没有尾部标点＝普通自动链接，照原样', () => {
  const pair = { href: 'https://example.com/a', text: 'https://example.com/a' };
  assert.deepEqual(boundAutolink(pair.href, pair.text), pair);
});

test('href 与文本的尾巴不一致时不动', () => {
  const pair = { href: 'https://example.com/a', text: 'https://example.com/a）' };
  assert.deepEqual(boundAutolink(pair.href, pair.text), pair);
});

test('尾巴剥掉后保留路径中的中文（IRI 原样）', () => {
  const r = boundAutolink(
    'https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87%EF%BC%89',
    'https://zh.wikipedia.org/wiki/中文）',
  );
  assert.equal(r.href, 'https://zh.wikipedia.org/wiki/中文');
  assert.equal(r.text, 'https://zh.wikipedia.org/wiki/中文');
});

test('空文本（富文本/元素子节点）不动', () => {
  const pair = { href: 'https://example.com/a%EF%BC%89', text: '' };
  assert.deepEqual(boundAutolink(pair.href, pair.text), pair);
});
