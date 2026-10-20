import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineFilePath, decodeFileHref } from './local-file-link.ts';

test('文件路径覆盖本会话的图片与视频、中文空格、绝对与 Windows 路径', () => {
  for (const value of ['packages/lulu/public/episodes/lu008/source.mp4', 'packages/lulu/out/lu008/contact-small.jpg', '/Volumes/Projects/成 片.mp4', '~/Desktop/a.svg', './a.txt', 'C:\\成果\\样片.mov', 'file:///tmp/a%20b.png']) assert.equal(inlineFilePath(value), value);
});

test('代码和命令不伪装文件入口；百分号原文不使 Markdown 崩溃', () => {
  for (const value of ['foo.bar', 'npm run packages/a.txt', 'cat /tmp/a.txt', 'https://example.com/a.png', 'javascript:alert(1)', 'packages/foo/', 'a/b.txt\n', 'a/b.txt;rm', '$(cat)/a.txt']) assert.equal(inlineFilePath(value), null, value);
  assert.equal(decodeFileHref('a/100%.png'), 'a/100%.png');
  assert.equal(decodeFileHref('a/%E5%9B%BE.png'), 'a/图.png');
});
