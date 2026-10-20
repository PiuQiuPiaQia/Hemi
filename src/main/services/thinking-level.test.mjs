import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeThinkingFormat,
  normalizeThinkingLevel,
  THINKING_FORMATS,
  THINKING_LEVELS,
} from './thinking-level.mjs';

test('normalizeThinkingLevel：合法值原样、非法回落 default', () => {
  for (const level of THINKING_LEVELS) {
    assert.equal(normalizeThinkingLevel(level), level);
  }
  assert.equal(normalizeThinkingLevel('ultra'), 'default');
  assert.equal(normalizeThinkingLevel(undefined), 'default');
  assert.equal(normalizeThinkingLevel(3), 'default');
});

test('normalizeThinkingFormat：非法/缺省返回 null（自动探测），合法原样', () => {
  for (const format of THINKING_FORMATS) {
    assert.equal(normalizeThinkingFormat(format), format);
  }
  assert.equal(normalizeThinkingFormat('anthropic'), null);
  assert.equal(normalizeThinkingFormat(undefined), null);
});
