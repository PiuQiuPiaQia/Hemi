import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_PRESETS,
  findDefaultModel,
  guessVision,
  hostOf,
  isLocalEndpoint,
  matchPreset,
  modelUsage,
  providerSaveInput,
  providerTile,
  uniqueProviderName,
} from './provider-presets.ts';

const entry = (id, model, extra = {}, providerId = 'p1') => ({
  id,
  modelKey: `${providerId}/${id}`,
  model,
  thinkingLevel: 'default',
  supportsVision: false,
  visionModel: '',
  isDefault: false,
  ...extra,
});

const directory = () => ({
  version: 2,
  defaultModelId: 'p1/m-max',
  providers: [
    {
      id: 'p1',
      name: '通义千问',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      hasApiKey: true,
      keyStoredSecurely: true,
      updatedAt: 0,
      models: [
        entry('m-max', 'qwen-max', { isDefault: true, visionModel: 'qwen-vl-max' }),
        entry('m-vl', 'qwen-vl-max', { supportsVision: true }),
        entry('m-plus', 'qwen-plus'),
      ],
    },
    {
      id: 'p2',
      name: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      hasApiKey: true,
      keyStoredSecurely: true,
      updatedAt: 0,
      models: [
        entry('m-glm', 'glm-4.5', {}, 'p2'),
        entry('m-glmv', 'glm-4.5v', { supportsVision: true }, 'p2'),
      ],
    },
  ],
});

test('预设清单：8 家、id 唯一、除自定义外都有接口地址与常用型号', () => {
  assert.equal(PROVIDER_PRESETS.length, 8);
  assert.equal(new Set(PROVIDER_PRESETS.map((p) => p.id)).size, 8);
  for (const preset of PROVIDER_PRESETS) {
    if (preset.id === 'custom') continue;
    assert.ok(/^https?:\/\//.test(preset.baseUrl), preset.id);
    assert.ok(preset.models.length > 0, preset.id);
    assert.ok(preset.models.some((model) => model.pick), `${preset.id} 至少默认勾一个`);
    if (!preset.keyless) assert.ok(preset.keyUrl.startsWith('https://'), preset.id);
  }
});

test('hostOf / matchPreset / providerTile / isLocalEndpoint', () => {
  assert.equal(hostOf('https://api.deepseek.com/v1'), 'api.deepseek.com');
  assert.equal(hostOf('127.0.0.1:11434/v1'), '127.0.0.1:11434');
  assert.equal(hostOf(''), '');
  assert.equal(matchPreset('https://api.deepseek.com/v1/')?.id, 'deepseek');
  assert.equal(matchPreset('http://localhost:11434/v1')?.id, 'ollama');
  assert.equal(matchPreset('https://example.com/v1'), null);
  assert.equal(providerTile('随便', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), '通');
  assert.equal(providerTile('my gateway', 'https://gw.example.com'), 'MY');
  assert.equal(providerTile('本地模型', 'https://gw.example.com'), '本');
  assert.equal(isLocalEndpoint('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLocalEndpoint('https://api.openai.com/v1'), false);
});

test('findDefaultModel：defaultModelId 优先，回落 isDefault 与第一个', () => {
  const dir = directory();
  assert.equal(findDefaultModel(dir)?.model.model, 'qwen-max');
  dir.defaultModelId = null;
  dir.providers[0].models[0].isDefault = false;
  assert.equal(findDefaultModel(dir)?.model.model, 'qwen-max');
  assert.equal(findDefaultModel(null), null);
});

test('providerSaveInput：整体提交、空 Key 不覆盖、空型号过滤、视觉名为空不传', () => {
  const dir = directory();
  const provider = dir.providers[0];
  const input = providerSaveInput(provider, {
    models: [...provider.models, entry('', '  ')],
  });
  assert.equal(input.id, 'p1');
  assert.equal(input.apiKey, undefined);
  assert.equal(input.models.length, 3);
  assert.equal(input.models[0].visionModel, 'qwen-vl-max');
  assert.equal(input.models[1].visionModel, undefined);
  assert.equal(providerSaveInput(provider, { apiKey: ' sk-1 ' }).apiKey, 'sk-1');
  assert.equal(providerSaveInput(provider, { name: ' 新名 ' }).name, '新名');
});

test('modelUsage：只有目录的 visionModelKey 指向的型号算看图占用', () => {
  const dir = directory();
  const [max, vl] = dir.providers[0].models;
  const [, glmv] = dir.providers[1].models;
  assert.equal(modelUsage(dir, vl), null);
  dir.visionModelKey = 'p2/m-glmv';
  assert.equal(modelUsage(dir, glmv), 'vision');
  assert.equal(modelUsage(dir, max), null);
  assert.equal(modelUsage(null, glmv), null);
});

test('guessVision / uniqueProviderName', () => {
  const qwen = PROVIDER_PRESETS.find((p) => p.id === 'qwen');
  assert.equal(guessVision(qwen, 'qwen-vl-max'), true);
  assert.equal(guessVision(qwen, 'qwen-max'), false);
  assert.equal(guessVision(null, 'my-vl-model'), true);
  assert.equal(guessVision(null, 'deepseek-chat'), false);
  assert.equal(uniqueProviderName('DeepSeek', ['DeepSeek']), 'DeepSeek 2');
  assert.equal(uniqueProviderName('Kimi', ['DeepSeek']), 'Kimi');
});
