import assert from 'node:assert/strict';
import test from 'node:test';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { candidateModelDef, modelBaseUrl, piModelOf, providerRegistrationOf, sdkThinkingLevelOf } from './pi-model.mjs';

test('完整接口地址统一归一，agent 注册和轻量模型使用相同基址', () => {
  for (const [api, url, expected] of [
    ['openai-completions', 'https://relay/v1/chat/completions/', 'https://relay/v1'],
    ['anthropic-messages', 'https://relay/v1/messages/', 'https://relay'],
    ['anthropic-messages', 'https://relay/v1/', 'https://relay'],
  ]) {
    const config = { api, baseUrl: url, model: 'unknown' };
    assert.equal(modelBaseUrl(url, api), expected);
    assert.equal(piModelOf(config).baseUrl, expected);
    assert.equal(providerRegistrationOf(config).baseUrl, expected);
  }
});

test('非 Anthropic 目录保留 SDK 兼容和能力信息，输出上限集中为宿主预算', () => {
  const native = DEEPSEEK_MODELS['deepseek-flash'];
  const model = candidateModelDef({ model: 'deepseek-flash' });
  assert.deepEqual(model.thinkingLevelMap, native.thinkingLevelMap);
  assert.equal(model.compat.thinkingFormat, native.compat.thinkingFormat);
  assert.equal(model.compat.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(model.compat.maxTokensField, 'max_tokens');
  assert.equal(model.contextWindow, native.contextWindow);
  assert.equal(model.maxTokens, 32768);
  assert.equal(model.compat.supportsStrictMode, false);
});

test('显式格式覆盖目录默认值，不修改 SDK 目录或让会话互相污染', () => {
  const qwen = candidateModelDef({ model: 'deepseek-flash', thinkingFormat: 'qwen' });
  assert.equal(qwen.compat.thinkingFormat, 'qwen');
  assert.equal(qwen.compat.supportsReasoningEffort, false);
  qwen.thinkingLevelMap.low = 'high';
  assert.equal(candidateModelDef({ model: 'deepseek-flash' }).compat.thinkingFormat, 'deepseek');
  assert.equal(DEEPSEEK_MODELS['deepseek-flash'].thinkingLevelMap.low, 'low');
});

test('产品三档不扩充，默认映射中档；未知输入仍按默认处理', () => {
  assert.deepEqual(['low', 'medium', 'high', 'off', 'default', 'bad'].map(sdkThinkingLevelOf),
    ['low', 'medium', 'high', 'off', 'medium', 'medium']);
});

test('兼容端点不继承型号目录的原生会话控制，也不把未知图像能力当作支持', () => {
  const model = candidateModelDef({ api: 'anthropic-messages', model: 'claude-opus-5-5' });
  assert.equal(model.compat.supportsMidConvoEffort, false);
  assert.equal(model.compat.supportsMidConvoSystemMessages, false);
  assert.equal(model.compat.supportsMidConvoToolChanges, false);
  assert.equal(model.compat.forceAdaptiveThinking, true);
  assert.deepEqual(model.input, ['text']);
  assert.deepEqual(candidateModelDef({ model: 'text', supportsVision: true }).input, ['text','image']);
});
