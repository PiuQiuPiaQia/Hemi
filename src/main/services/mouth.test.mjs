import assert from 'node:assert/strict';
import test from 'node:test';

// 055 R-01（口）：语音转述的行为约束与选模规则（Q5）。chatTurn 不打桩——
// 请求形状（系统提示词带渠道规则、原文进 user）在集成链路可见；这里测
// 错误路径的诚实性（空回答拒绝、连不上如实抛）与 Q5 选模。
import { summarizeForSpeech } from './mouth.mjs';
import { resolveLightModel } from '../lib/light-model.mjs';

test('口：空回答拒绝（不拿空串让转述模型编话）；服务不可达如实抛错', async () => {
  await assert.rejects(
    summarizeForSpeech({ config: {}, question: 'q', answer: '' }),
    /没有可转述/,
  );
  await assert.rejects(
    summarizeForSpeech({
      config: { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'light', api: 'openai-completions' },
      question: 'q',
      answer: 'a'.repeat(20),
    }),
    /连不上|超时|失败/,
  );
});

// ---- Q5 轻量选模（口与标题共用） ----

function fakeProfiles({ strictResults = {}, resolved = null, directory = null } = {}) {
  const calls = [];
  return {
    calls,
    profiles: {
      list: async () => directory ?? { providers: [], defaultModelId: null },
      resolveStrict: async (modelKey) => {
        calls.push(['strict', modelKey]);
        return strictResults[modelKey] ?? { ok: false, reason: 'missing', message: 'x' };
      },
      resolve: async () => {
        calls.push(['resolve']);
        return resolved ?? { baseUrl: 'http://default', apiKey: 'k', model: 'default-model', api: 'openai-completions' };
      },
    },
  };
}

test('resolveLightModel：具体模型 → 按模型键解析（不走自动路由）', async () => {
  const resolved = { baseUrl: 'http://x', apiKey: 'k', model: 'picked', api: 'openai-completions' };
  const profiles = {
    list: async () => { throw new Error('具体模型不应读自动路由目录'); },
    resolve: async () => { throw new Error('具体模型不应退默认'); },
    resolveStrict: async () => ({ok:true,config:resolved}),
  };
  const config = await resolveLightModel({ getProfiles: () => profiles, profileId: 'p/m' });
  assert.equal(config.model, 'picked');
});

test('resolveLightModel（056）：自动（角色路由）→ 路由主 agent 模型，未配/失效不暗换默认', async () => {
  const strictOk = { ok: true, config: { baseUrl: 'http://main', apiKey: 'k', model: 'routing-main', api: 'openai-completions' } };
  const fake = fakeProfiles({
    strictResults: { 'p/main': strictOk },
    directory: { providers: [], defaultModelId: null, roleModels: { main: 'p/main' } },
  });
  const config = await resolveLightModel({ getProfiles: () => fake.profiles, profileId: 'auto' });
  assert.equal(config.model, 'routing-main');
  const unset = fakeProfiles({ directory: { providers: [], defaultModelId: null } });
  const fallback = await resolveLightModel({ getProfiles: () => unset.profiles, profileId: 'auto' });
  assert.equal(fallback, null);
});
