import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProfileStore,
  envOverrideActive,
  normalizeDirectory,
  parseModelKey,
} from './model-profiles.mjs';

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (p) => {
      if (!files.has(p)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(p);
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    mkdir: async () => {},
  };
}

const safeStub = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decryptString: (buf) => {
    const text = Buffer.from(buf).toString('utf8');
    return text.startsWith('enc:') ? text.slice(4) : '';
  },
};

const enc = (plain) => Buffer.from(`enc:${plain}`).toString('base64');

function storeFor(fs, overrides = {}) {
  return createProfileStore({
    filePath: '/ud/text-model-profiles.json',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    mkdir: fs.mkdir,
    safeStorage: safeStub,
    env: {},
    log: null,
    ...overrides,
  });
}

test('parseModelKey／normalizeDirectory：键解析、供应商去重、默认模型回落', () => {
  assert.deepEqual(parseModelKey('mp-a/m1'), { providerId: 'mp-a', modelId: 'm1' });
  assert.equal(parseModelKey('no-separator'), null);

  const dir = normalizeDirectory({
    defaultModelId: 'gone/m9',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1' }, { id: 'm2', model: 'model-a2' }] },
      { id: 'a', name: '重复', models: [{ id: 'm1', model: 'dup' }] }, // 同 id 供应商去重
      { id: 'b', models: [] }, // 无模型 → 归一化丢弃
    ],
  });
  assert.equal(dir.providers.length, 1);
  assert.equal(dir.defaultModelId, 'a/m1', '无效默认回落首个模型键');
});

test('CRUD：供应商级保存（多模型）、编辑互不影响；Key 非空才覆盖', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    providers: [
      {
        id: 'a', name: 'DeepSeek', baseUrl: 'https://a/v1', encryptedApiKey: enc('key-a'),
        models: [
          { id: 'm1', model: 'deepseek-chat', thinkingLevel: 'default', supportsVision: true, visionModel: '' },
          { id: 'm2', model: 'deepseek-reasoner', thinkingLevel: 'high', supportsVision: false, visionModel: '' },
        ],
      },
      { id: 'b', name: '本地', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'm1', model: 'qwen3:14b', thinkingLevel: 'off' }] },
    ],
  }) });
  const store = storeFor(fs);

  // 新建供应商带两个模型。
  const created = await store.saveProvider({
    name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'key-or',
    models: [{ model: 'gpt-4o' }, { model: 'claude-4', thinkingLevel: 'high' }],
  });
  assert.equal(created.ok, true);
  assert.equal(created.modelKeys.length, 2);
  const list1 = await store.list();
  assert.equal(list1.providers.length, 3);

  // 编辑 A 的端点并加一个模型——不动 B、不动 A 的 Key。
  const edited = await store.saveProvider({
    id: 'a', name: 'DeepSeek', baseUrl: 'https://a2/v1',
    models: [
      { id: 'm1', model: 'deepseek-chat', supportsVision: true },
      { id: 'm2', model: 'deepseek-reasoner', thinkingLevel: 'high' },
      { model: 'deepseek-coder' },
    ],
  });
  const resolvedA = await store.resolve({ modelKey: 'a/m1' });
  assert.equal(resolvedA.baseUrl, 'https://a2/v1');
  assert.equal(resolvedA.apiKey, 'key-a', '未传 Key 保留供应商已存');
  assert.equal(resolvedA.supportsVision, true);
  const newKey = edited.modelKeys.find((key) => !['a/m1', 'a/m2'].includes(key));
  assert.ok(newKey, '新模型拿到稳定键');
  const resolvedNew = await store.resolve({ modelKey: newKey });
  assert.equal(resolvedNew.model, 'deepseek-coder');
  const resolvedB = await store.resolve({ modelKey: 'b/m1' });
  assert.equal(resolvedB.baseUrl, 'http://127.0.0.1:11434/v1', 'B 不受影响');
});

test('resolve：模型键 → 供应商端点/Key + 模型字段；失效回落默认', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', encryptedApiKey: enc('key-a'), models: [{ id: 'm1', model: 'model-a1' }, { id: 'm2', model: 'model-a2', thinkingLevel: 'high' }] },
      { id: 'b', name: 'B', baseUrl: 'https://b/v1', models: [{ id: 'm1', model: 'model-b1' }] },
    ],
  }) });
  const store = storeFor(fs);
  assert.equal((await store.resolve({ modelKey: 'b/m1' })).model, 'model-b1');
  assert.equal((await store.resolve({ modelKey: 'b/m1' })).apiKey, '', 'B 无 Key');
  assert.equal((await store.resolve({ modelKey: 'a/m2' })).thinkingLevel, 'high', '思考档随模型');
  assert.equal((await store.resolve({})).model, 'model-a1');
  const missing = await store.resolve({ modelKey: 'gone/m9' });
  assert.equal(missing.missingModelKey, true);
  assert.equal(missing.model, 'model-a1', '失效选择回落默认模型');

  await store.setDefault('b/m1');
  assert.equal((await store.resolve({})).model, 'model-b1');
});

test('删除供应商：含默认模型需显式替代；事务替换默认', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', encryptedApiKey: enc('key-a'), models: [{ id: 'm1', model: 'model-a1' }] },
      { id: 'b', name: 'B', baseUrl: 'https://b/v1', models: [{ id: 'm1', model: 'model-b1' }, { id: 'm2', model: 'model-b2' }] },
    ],
  }) });
  const store = storeFor(fs);
  await assert.rejects(store.removeProvider({ providerId: 'a' }), /默认模型/, '含默认模型且未给替代 → 拒绝');
  await store.removeProvider({ providerId: 'b' }); // 不含默认 → 直接删
  // 重建 b 再验替代路径（此时 a 是唯一供应商 + 默认所在）。
  await store.saveProvider({ name: 'B2', baseUrl: 'https://b/v1', models: [{ model: 'model-b1' }, { model: 'model-b2' }] });
  const providers = (await store.list()).providers;
  const b2 = providers.find((p) => p.name === 'B2');
  await assert.rejects(store.removeProvider({ providerId: 'a' }), /默认模型/);
  const result = await store.removeProvider({ providerId: 'a', replacementModelId: `${b2.id}/${b2.models[0].id}` });
  assert.equal(result.defaultModelId, `${b2.id}/${b2.models[0].id}`);
});

test('envOverride：环境覆盖返回有效值并置空模型键；损坏目录只读回落', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    providers: [{ id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1' }] }],
  }) });
  const store = storeFor(fs, { env: { HEMI_LLM_MODEL: 'env-model', HEMI_LLM_API_KEY: 'env-key' } });
  assert.equal(envOverrideActive({ HEMI_LLM_MODEL: 'x' }), true);
  const resolved = await store.resolve({ modelKey: 'a/m1' });
  assert.equal(resolved.envOverride, true);
  assert.equal(resolved.model, 'env-model');
  assert.equal(resolved.profileId, null, '环境覆盖下不冒充选择');

  const broken = memoryFs({ '/ud/text-model-profiles.json': '{oops' });
  const brokenStore = storeFor(broken);
  const list = await brokenStore.list();
  assert.equal(list.corrupt, true);
  assert.match(list.providers[0].name, /只读/);
  await assert.rejects(brokenStore.saveProvider({ name: 'x', baseUrl: 'y', models: [{ model: 'm' }] }), /损坏/);
});

// —— 070：未配置与损坏分开报（全新 userData 冒烟曾把未配置误报成「配置目录损坏」）——

test('070 resolveStrict：文件不存在／空供应商列表＝未配置，只有解析失败或结构无效才是损坏', async () => {
  const fresh = storeFor(memoryFs({}));
  const none = await fresh.resolveStrict(null);
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'unconfigured');
  assert.match(none.message, /未配置/);
  assert.doesNotMatch(none.message, /损坏/);
  assert.equal((await fresh.list()).corrupt, false);

  const empty = storeFor(memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({ version: 2, providers: [] }) }));
  assert.equal((await empty.resolveStrict('a/m1')).reason, 'unconfigured');
  const emptyList = await empty.list();
  assert.equal(emptyList.corrupt, false);
  assert.deepEqual(emptyList.providers, []);
  // 空目录可以直接建首组，不被当损坏拒绝保存。
  const saved = await empty.saveProvider({ name: 'A', baseUrl: 'https://a/v1', apiKey: 'k', models: [{ model: 'm' }] });
  assert.equal(saved.ok, true);
  assert.equal((await empty.resolveStrict(saved.modelKeys[0])).ok, true);

  const broken = storeFor(memoryFs({ '/ud/text-model-profiles.json': '{oops' }));
  const brokenResult = await broken.resolveStrict('a/m1');
  assert.equal(brokenResult.reason, 'corrupt');
  assert.match(brokenResult.message, /损坏/);
  assert.doesNotMatch(brokenResult.message, /未配置/);

  // 结构对不上（供应商全部非法）仍按损坏处理，不把用户文件当空目录覆盖。
  const junk = storeFor(memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({ version: 2, providers: [{ nope: true }] }) }));
  assert.equal((await junk.resolveStrict('a/m1')).reason, 'corrupt');
  assert.equal((await junk.list()).corrupt, true);
});

// —— 032：空目录首组创建即默认；makeDefault；不落明文 ——

test('空目录首组创建即默认并回读生效', async () => {
  const fs = memoryFs({});
  const store = storeFor(fs);
  let list = await store.list();
  assert.equal(list.providers.length, 0, '空目录不生成占位组');
  assert.equal(list.defaultModelId, null);

  const saved = await store.saveProvider({
    name: '首组', baseUrl: 'https://first/v1', apiKey: 'key-1', models: [{ model: 'model-1' }],
  });
  list = await store.list();
  assert.equal(list.providers.length, 1);
  assert.equal(list.defaultModelId, saved.modelKeys[0], '首组保存即默认');
  const resolved = await store.resolve({});
  assert.equal(resolved.model, 'model-1');
  assert.equal(resolved.apiKey, 'key-1');
  // 回读核验：落盘文件里的默认键就是这个组（重启后仍生效）。
  const persisted = JSON.parse(fs.files.get('/ud/text-model-profiles.json'));
  assert.equal(persisted.defaultModelId, saved.modelKeys[0]);
});

test('makeDefault（首启引导裁决）：保存的分组取代既有默认组', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', encryptedApiKey: enc('key-a'), models: [{ id: 'm1', model: 'model-a1' }] },
    ],
  }) });
  const store = storeFor(fs);
  const saved = await store.saveProvider({
    name: '引导组', baseUrl: 'https://b/v1', apiKey: 'key-b', models: [{ model: 'model-b1' }], makeDefault: true,
  });
  const list = await store.list();
  assert.equal(list.defaultModelId, saved.modelKeys[0], '引导保存的分组成为默认');
  assert.notEqual(list.defaultModelId, 'a/m1');
  // 不带 makeDefault 的普通新建不抢默认（设置页语义不变）。
  const second = await store.saveProvider({ name: '普通', baseUrl: 'https://c/v1', models: [{ model: 'model-c1' }] });
  const after = await store.list();
  assert.equal(after.defaultModelId, saved.modelKeys[0]);
  assert.ok(second.modelKeys.every((key) => key !== after.defaultModelId));
});

test('safeStorage 不可用：带新 Key 的保存被拒、不落明文；目录不损坏', async () => {
  const fs = memoryFs({});
  const store = storeFor(fs, {
    safeStorage: { isEncryptionAvailable: () => false },
  });
  await assert.rejects(
    store.saveProvider({ name: 'X', baseUrl: 'https://x/v1', apiKey: 'plain-key', models: [{ model: 'm' }] }),
    /无法加密保存/,
  );
  assert.equal(fs.files.has('/ud/text-model-profiles.json'), false, '被拒的保存不落盘');
  const list = await store.list();
  assert.equal(list.providers.length, 0);
});

test('providerCredentials：按供应商取端点与解密 Key；未知/无 Key 如实返回（041 拉取模型）', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', encryptedApiKey: enc('key-a'), models: [{ id: 'm1', model: 'model-a1' }] },
      { id: 'b', name: 'B', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'm1', model: 'model-b1' }] },
    ],
  }) });
  const store = storeFor(fs);
  const a = await store.providerCredentials('a');
  assert.equal(a.name, 'A');
  assert.equal(a.baseUrl, 'https://a/v1');
  assert.equal(a.apiKey, 'key-a');
  assert.equal(a.hasApiKey, true);
  const b = await store.providerCredentials('b');
  assert.equal(b.apiKey, '');
  assert.equal(b.hasApiKey, false);
  assert.equal(await store.providerCredentials('nope'), null);
});

// ---- 未配置 ≠ 损坏（win 恢复：无配置首启的对话拒绝被误报「配置目录损坏」） ----

test('resolveStrict：未配置（文件不存在）报 unconfigured 与「未配置」文案，不冒充目录损坏', async () => {
  const store = storeFor(memoryFs({}));
  const verdict = await store.resolveStrict(null);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unconfigured');
  assert.match(verdict.message, /未配置/);
  assert.doesNotMatch(verdict.message, /损坏/);
});

test('resolveStrict：目录真损坏（JSON 解析失败）仍报 corrupt', async () => {
  const store = storeFor(memoryFs({ '/ud/text-model-profiles.json': '{oops' }));
  const verdict = await store.resolveStrict(null);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'corrupt');
  assert.match(verdict.message, /损坏/);
});

// ---- 046：供应商线协议字段 ----

test('046 api：归一化缺省/非法回落 openai-completions，resolve/get 透传', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', api: 'anthropic-messages', encryptedApiKey: enc('key-a'), models: [{ id: 'm1', model: 'claude-opus-5-5' }] },
      { id: 'b', name: 'B', baseUrl: 'https://b/v1', api: '不认识的协议', encryptedApiKey: enc('key-b'), models: [{ id: 'm1', model: 'model-b1' }] },
      { id: 'c', name: 'C', baseUrl: 'https://c/v1', encryptedApiKey: enc('key-c'), models: [{ id: 'm1', model: 'model-c1' }] },
    ],
  }) });
  const store = storeFor(fs);

  const a = await store.resolveStrict('a/m1');
  assert.equal(a.ok, true);
  assert.equal(a.config.api, 'anthropic-messages', '已存协议透传');
  const b = await store.resolveStrict('b/m1');
  assert.equal(b.config.api, 'openai-completions', '非法协议回落');
  const c = await store.resolve({ modelKey: 'c/m1' });
  assert.equal(c.api, 'openai-completions', '缺省字段补默认');
  assert.equal((await store.get('a/m1')).api, 'anthropic-messages', 'get 同样透传');
});

test('046 api：保存整单缺 api 时沿旧值，显式修改生效；视图带 api', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', api: 'anthropic-messages', encryptedApiKey: enc('key-a'), models: [{ id: 'm1', model: 'claude-opus-5-5' }] },
    ],
  }) });
  const store = storeFor(fs);

  // 整单提交（思考档拨盘等部分保存）不带 api → 沿旧值。
  await store.saveProvider({
    id: 'a', name: 'A', baseUrl: 'https://a/v1',
    models: [{ id: 'm1', model: 'claude-opus-5-5', thinkingLevel: 'high' }],
  });
  assert.equal((await store.get('a/m1')).api, 'anthropic-messages', '缺省沿旧值');

  // 显式改回 openai-completions。
  await store.saveProvider({
    id: 'a', name: 'A', baseUrl: 'https://a/v1', api: 'openai-completions',
    models: [{ id: 'm1', model: 'claude-opus-5-5', thinkingLevel: 'high' }],
  });
  const listed = await store.list();
  assert.equal(listed.providers[0].api, 'openai-completions', '显式修改生效且视图透传');
});

// ---- 2026-10-08：上次主脑模型选择（新建对话优先恢复，失效回落默认） ----

test('lastConversationModelKey：归一化保留有效模型键/auto，丢弃失效引用', () => {
  const dir = normalizeDirectory({
    defaultModelId: 'a/m1',
    lastConversationModelKey: 'a/m2',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1' }, { id: 'm2', model: 'model-a2' }] },
    ],
  });
  assert.equal(dir.lastConversationModelKey, 'a/m2', '有效模型键保留');

  const auto = normalizeDirectory({
    defaultModelId: 'a/m1',
    lastConversationModelKey: 'auto',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1' }] },
    ],
  });
  assert.equal(auto.lastConversationModelKey, 'auto', 'auto 保留值合法');

  const stale = normalizeDirectory({
    defaultModelId: 'a/m1',
    lastConversationModelKey: 'gone/m9',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1' }] },
    ],
  });
  assert.equal(stale.lastConversationModelKey, undefined, '失效引用丢弃');
});

test('setLastConversationModel：记录/auto/清空；同值不落盘；空目录不抛错', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', encryptedApiKey: enc('key-a'), models: [{ id: 'm1', model: 'model-a1' }] },
      { id: 'b', name: 'B', baseUrl: 'https://b/v1', models: [{ id: 'm1', model: 'model-b1' }] },
    ],
  }) });
  const store = storeFor(fs);

  await store.setLastConversationModel('b/m1');
  assert.equal((await store.list()).lastConversationModelKey, 'b/m1', '记录后视图可读');
  assert.equal(JSON.parse(fs.files.get('/ud/text-model-profiles.json')).lastConversationModelKey, 'b/m1', '落盘可见');

  // 同值重记（启动种子化每次都会发一笔）不再写文件。
  const before = fs.files.get('/ud/text-model-profiles.json');
  await store.setLastConversationModel('b/m1');
  assert.equal(fs.files.get('/ud/text-model-profiles.json'), before, '同值不落盘');

  await store.setLastConversationModel('auto');
  assert.equal((await store.list()).lastConversationModelKey, 'auto', 'auto 可记');

  await store.setLastConversationModel('gone/x');
  assert.equal((await store.list()).lastConversationModelKey, null, '失效值清空（不抛错）');

  const empty = storeFor(memoryFs({}));
  const result = await empty.setLastConversationModel('a/m1');
  assert.equal(result.ok, false, '空目录没东西可记');
});

test('lastConversationModelKey：供应商保存/导入不丢；删除所在供应商后清理', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    lastConversationModelKey: 'a/m2',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1' }, { id: 'm2', model: 'model-a2' }] },
    ],
  }) });
  const store = storeFor(fs);

  // 编辑无关供应商（新建 B）——上次选择保留。
  await store.saveProvider({ name: 'B', baseUrl: 'https://b/v1', models: [{ model: 'model-b1' }] });
  assert.equal((await store.list()).lastConversationModelKey, 'a/m2', '供应商保存不丢上次选择');

  // 删除 A（不含默认模型 m1？含——a/m1 是默认）需替代；替代后上次选择指向被删供应商 → 清理。
  const list = await store.list();
  const b = list.providers.find((p) => p.name === 'B');
  await store.removeProvider({ providerId: 'a', replacementModelId: `${b.id}/${b.models[0].id}` });
  assert.equal((await store.list()).lastConversationModelKey, null, '指向被删供应商 → 清理');

  // 重新记一笔后走 047 导入路径——同文件字段不丢。
  const replacementKey = (await store.list()).defaultModelId;
  await store.setLastConversationModel(replacementKey);
  await store.importProvidersAtomic({
    operationId: 'op-1',
    planHash: 'hash-1',
    providers: [{ deterministicId: 'imp-1', name: '导入', baseUrl: 'https://imp/v1', apiKey: 'k', api: 'openai-completions', models: [{ model: 'imp-model' }] }],
  });
  assert.equal((await store.list()).lastConversationModelKey, replacementKey, '导入不丢上次选择');
});
