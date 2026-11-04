import assert from 'node:assert/strict';
import test from 'node:test';
import { isVisibleCaptionSample } from './caption-smoke-probe.mjs';

test('visible status pills and missing caption lines do not satisfy caption readiness', () => {
  assert.equal(isVisibleCaptionSample({ visible: 'true', lineOpacities: [] }), false);
  assert.equal(isVisibleCaptionSample({ visible: 'true' }), false);
  assert.equal(isVisibleCaptionSample(null), false);
});

test('readiness requires every caption line to be visible, not a faded or partial sample', () => {
  assert.equal(isVisibleCaptionSample({ visible: 'false', lineOpacities: [1] }), false);
  for (const value of [0, 0.5, NaN, Infinity]) {
    assert.equal(isVisibleCaptionSample({ visible: 'true', lineOpacities: [1, value] }), false);
  }
  assert.equal(isVisibleCaptionSample({ visible: 'true', lineOpacities: [1, 0.95] }), true);
});

test('initial readiness matches the published caption rather than an older visible sample', () => {
  const state = { visible: 'true', lineOpacities: [1], lines: ['first caption'], copyWidth: 300 };
  assert.equal(isVisibleCaptionSample(state, 'second caption'), false);
  assert.equal(isVisibleCaptionSample(state, 'first caption'), true);
});
