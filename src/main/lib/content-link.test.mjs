import assert from 'node:assert/strict';
import test from 'node:test';

import { isOpenableContentLink } from './content-link.mjs';

test('对话内容链接：任意 http/https 放行，其他协议与坏串拒绝', () => {
  assert.equal(isOpenableContentLink('https://example.com/a?b=1'), true);
  assert.equal(isOpenableContentLink('http://localhost:3000/'), true);
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'vscode://x', 'https://', 'not a url', '', null]) {
    assert.equal(isOpenableContentLink(bad), false, String(bad));
  }
});
