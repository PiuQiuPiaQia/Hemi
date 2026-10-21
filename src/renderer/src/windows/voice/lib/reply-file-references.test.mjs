import assert from 'node:assert/strict';
import test from 'node:test';
import { replyFileReferences } from './reply-file-references.ts';

test('明确文件引用支持中文空格、图片、引用式链接、完整 code 路径，忽略网页和代码块', () => {
  const text = '[报告](<./产出/季度 报告.pdf>)\n\n![横版](</tmp/封面 图.png>)\n\n[表格][sheet]\n\n[sheet]: ./结果.xlsx\n\n`~/Desktop/archive.zip`\n\n[站点](https://example.com/a.pdf)\n\n```md\n![假的](/tmp/no.png)\n```';
  assert.deepEqual(replyFileReferences(text).files.map(f => f.path), ['./产出/季度 报告.pdf', '/tmp/封面 图.png', './结果.xlsx', '~/Desktop/archive.zip']);
  assert.deepEqual(replyFileReferences('图片在 `public/episodes/demo/`，不要把 `npm run build` 当路径').directories, ['public/episodes/demo/']);
});

test('file URL 的百分号只交宿主解码一次，不从普通文字猜测文件', () => {
  assert.deepEqual(replyFileReferences('[图](file:///tmp/100%2525.png)').files.map(f => f.path), ['file:///tmp/100%2525.png']);
  assert.equal(replyFileReferences('我看过 report.pdf 和 /tmp/参考图.png；随后给你结果。').files.length, 0);
  assert.equal(replyFileReferences('[危险](javascript:alert.pdf)').files.length, 0);
});
