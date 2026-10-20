import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedPushToTalkKey } from './hold-keys.mjs';

test('mac：option 是唯一已验证键', () => {
  assert.equal(isAllowedPushToTalkKey('darwin', 'option'), true);
  assert.equal(isAllowedPushToTalkKey('darwin', 'right-alt'), false);
  assert.equal(isAllowedPushToTalkKey('darwin', 'command'), false);
});

test('win32：WP-04 未过，白名单为空——任何键都不可配置', () => {
  for (const key of ['option', 'right-alt', 'f8', 'f9', '']) {
    assert.equal(isAllowedPushToTalkKey('win32', key), false, `win32 不允许配置 ${key}`);
  }
});

test('未知平台按空白名单收紧', () => {
  assert.equal(isAllowedPushToTalkKey('linux', 'option'), false);
});
