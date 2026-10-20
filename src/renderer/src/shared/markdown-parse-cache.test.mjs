import test from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { MarkdownParseCache, remarkCachedParser } from './markdown-parse-cache.ts';

test('067 有界解析缓存保留 GFM，返回独立树，转换器不能污染下次渲染', () => {
  const cache = new MarkdownParseCache();
  const parse = text => unified().use(remarkParse).use(remarkGfm).use(remarkCachedParser, cache).parse(text);
  const text = '| 表头 |\n| --- |\n| 正文 |';
  const first = parse(text);
  assert.equal(first.children[0].type, 'table');
  first.children.length = 0;
  const second = parse(text);
  assert.equal(second.children[0].type, 'table');
  assert.equal(cache.parses, 1); assert.equal(cache.hits, 1);
  assert.ok(cache.bytes > text.length); assert.ok(cache.bytes <= 4 * 1024 * 1024);
});

test('067 缓存 LRU 同时守条数和字节，超大单项不驻留', () => {
  const cache = new MarkdownParseCache();
  const parse = text => cache.parse(text, () => ({ type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }] }));
  for (let i = 0; i < 160; i++) parse(`entry-${i}`);
  assert.equal(cache.size, 128);
  parse('entry-0'); assert.equal(cache.parses, 161, '最旧项已淘汰');
  const before = cache.size;
  parse('x'.repeat(4 * 1024 * 1024));
  assert.equal(cache.size, before); assert.ok(cache.bytes <= 4 * 1024 * 1024);
  for (let i = 0; i < 40; i++) parse(`${i}`.padEnd(100000, 'x'));
  assert.ok(cache.bytes <= 4 * 1024 * 1024); assert.ok(cache.size < 40);
});
