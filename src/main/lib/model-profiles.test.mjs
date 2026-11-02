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

  // 2026-11 v3→v4：defaultModelId 指针删除；全局思考档从默认条目迁一次。
  const dir = normalizeDirectory({
    version: 3,
    defaultModelId: 'a/m2',
    lastConversationModelKey: 'a/m1',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1' }, { id: 'm2', model: 'model-a2', thinkingLevel: 'high' }] },
      { id: 'a', name: '重复', models: [{ id: 'm1', model: 'dup' }] }, // 同 id 供应商去重
      { id: 'b', models: [] }, // 无模型 → 归一化丢弃
    ],
  });
  assert.equal(dir.providers.length, 1);
  assert.equal(dir.defaultModelId, undefined, 'v4 目录不再有默认模型指针');
  assert.equal(dir.version, 4, '目录归一化即 v4');
  assert.equal(dir.thinkingLevel, 'high', '全局档从 defaultModelId 指向条目迁');
  assert.equal(dir.lastConversationModelKey, 'a/m1', '上次选择保留');

  // 顶层已有 thinkingLevel 的 v4 目录：直接使用，不再看条目。
  const explicit = normalizeDirectory({
    version: 4,
    thinkingLevel: 'low',
    defaultModelId: 'a/m2',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1', thinkingLevel: 'high' }] },
    ],
  });
  assert.equal(explicit.thinkingLevel, 'low', '目录级单值优先于条目档');

  // 条目上的 thinkingLevel 继续容忍（normalize 不丢）——但只作数据保留。
  assert.equal(
    normalizeDirectory({
      version: 3,
      defaultModelId: 'a/m1',
      providers: [
        { id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1', thinkingLevel: 'off' }] },
      ],
    }).providers[0].models[0].thinkingLevel,
    'off',
    '条目 thinkingLevel 容忍保留',
  );
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

test('resolve：模型键 → 供应商端点/Key + 模型字段；思考档一律全局档；缺省沿上次选择', async () => {
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
  // 2026-11：发送档位是目录级单值（v3 迁移自默认条目 a/m1——无档 → 'default'），
  // 与所请求的模型条目无关（a/m2 条目档 high 不再作为发送依据）。
  assert.equal((await store.resolve({ modelKey: 'a/m2' })).thinkingLevel, 'default', '思考档全局单值');
  const missing = await store.resolve({ modelKey: 'gone/m9' });
  assert.equal(missing.missingModelKey, true);
  assert.equal(missing.model, 'model-a1', '失效选择回落首个模型（只读兜底）');

  // 缺省解析沿上次选择（非 auto）；没有上次选择回落第一个模型。
  await store.setLastConversationModel('b/m1');
  assert.equal((await store.resolve({})).model, 'model-b1');
  await store.setLastConversationModel('auto');
  assert.equal((await store.resolve({})).model, 'model-a1', 'auto 不作固定解析，回落首个');
});

test('删除供应商：直接删除；上次选择指向被删供应商时清空', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    lastConversationModelKey: 'a/m1',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', encryptedApiKey: enc('key-a'), models: [{ id: 'm1', model: 'model-a1' }] },
      { id: 'b', name: 'B', baseUrl: 'https://b/v1', models: [{ id: 'm1', model: 'model-b1' }, { id: 'm2', model: 'model-b2' }] },
      { id: 'c', name: 'C', baseUrl: 'https://c/v1', models: [{ id: 'm1', model: 'model-c1' }] },
    ],
  }) });
  const store = storeFor(fs);
  await store.removeProvider({ providerId: 'b' }); // 不持有任何选择 → 直接删
  const result = await store.removeProvider({ providerId: 'a' });
  assert.equal(result.ok, true, '删除不再要求「默认模型替代」');
  const list = await store.list();
  assert.equal(list.providers.length, 1);
  assert.equal(list.lastConversationModelKey, null, '上次选择指向被删供应商 → 清空（回落自动路由）');
  assert.equal(list.defaultModelId, undefined, '目录视图无默认模型字段');
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

// —— 032→2026-11：空目录首组创建；「默认组/默认模型」概念删除 ——

test('空目录首组创建并回读生效；目录不再有默认指针', async () => {
  const fs = memoryFs({});
  const store = storeFor(fs);
  let list = await store.list();
  assert.equal(list.providers.length, 0, '空目录不生成占位组');
  assert.equal(list.defaultModelId, undefined);
  assert.equal(list.thinkingLevel, 'default');

  const saved = await store.saveProvider({
    name: '首组', baseUrl: 'https://first/v1', apiKey: 'key-1', models: [{ model: 'model-1' }],
  });
  list = await store.list();
  assert.equal(list.providers.length, 1);
  assert.equal(list.defaultModelId, undefined, '保存不再设置任何「默认」指针');
  assert.deepEqual(Object.keys(list.providers[0].models[0]).sort(), [
    'id', 'model', 'modelKey', 'supportsVision', 'thinkingLevel', 'visionModel',
  ], '渲染层模型条目只含配置字段，选择由角色槽位/上次选择维护');
  const resolved = await store.resolve({});
  assert.equal(resolved.model, 'model-1', '缺省解析回落首个模型（只读兜底）');
  assert.equal(resolved.apiKey, 'key-1');
  // 回读核验：落盘文件不含 defaultModelId / makeDefault 痕迹。
  const persisted = JSON.parse(fs.files.get('/ud/text-model-profiles.json'));
  assert.equal(persisted.defaultModelId, undefined);
  assert.equal(persisted.thinkingLevel, 'default');
});

test('保存供应商不触碰既有选择与全局档（makeDefault 输入被忽略）', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'a/m1',
    thinkingLevel: 'high',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', encryptedApiKey: enc('key-a'), models: [{ id: 'm1', model: 'model-a1' }] },
    ],
  }) });
  const store = storeFor(fs);
  const saved = await store.saveProvider({
    name: '引导组', baseUrl: 'https://b/v1', apiKey: 'key-b', models: [{ model: 'model-b1' }], makeDefault: true,
  });
  const list = await store.list();
  assert.equal(list.defaultModelId, undefined, '2026-11：没有「引导组成为默认」这回事');
  assert.equal(list.thinkingLevel, 'high', '全局档不受供应商保存影响');
  const persisted = JSON.parse(fs.files.get('/ud/text-model-profiles.json'));
  assert.equal(persisted.defaultModelId, undefined, '落盘文件同样无指针');
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

test('模型状态与非密钥编辑不访问钥匙串，实际解析仍能解密原有 Key', async () => {
  const filePath = '/ud/text-model-profiles.json';
  const encryptedApiKey = enc('existing-key');
  const fs = memoryFs({ [filePath]: JSON.stringify({
    version: 3, defaultModelId: 'a/m1', providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', encryptedApiKey, models: [{ id: 'm1', model: 'model-a1' }] },
    ],
  }) });
  let reads = 0;
  const store = storeFor(fs, { safeStorage: {
    ...safeStub,
    isEncryptionAvailable() { reads += 1; return true; },
    decryptString(buf) { reads += 1; return safeStub.decryptString(buf); },
  } });
  assert.equal((await store.list()).providers[0].hasApiKey, true);
  const view = await store.resolve({ decryptSecrets: false });
  assert.equal(view.hasApiKey, true);
  assert.equal(view.keyStoredSecurely, true);
  assert.equal(view.apiKey, '');
  assert.equal((await store.get('a/m1', { decryptSecrets: false })).hasApiKey, true);
  await store.saveProvider({ id: 'a', name: 'Renamed', models: [{ id: 'm1', model: 'model-a1' }] });
  assert.equal(reads, 0);
  assert.equal(JSON.parse(fs.files.get(filePath)).providers[0].encryptedApiKey, encryptedApiKey);
  assert.equal((await store.resolve({})).apiKey, 'existing-key');
  assert.ok(reads > 0);
});

test('账号模型的状态查询使用凭据索引，不读取 token', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 3, defaultModelId: 'account/main', providers: [
      { id: 'account', oauthProvider: 'openai', models: [{ id: 'main', model: 'account-model' }] },
    ],
  }) });
  const store = storeFor(fs, { oauth: {
    credentials: { list: async () => [{ providerId: 'openai' }] },
    connected: () => assert.fail('状态查询不应解密账号 token'),
  } });
  assert.equal((await store.list()).providers[0].hasApiKey, true);
  assert.equal((await store.resolve({ decryptSecrets: false })).hasApiKey, true);
  assert.equal((await store.get('account/main', { decryptSecrets: false })).hasApiKey, true);
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

  // 删除 A（上次选择 a/m2 在它名下）——2026-11：直接删除，无需替代；上次选择清理。
  await store.removeProvider({ providerId: 'a' });
  assert.equal((await store.list()).lastConversationModelKey, null, '指向被删供应商 → 清理');

  // 重新记一笔后走 047 导入路径——同文件字段不丢。
  const bListed = (await store.list()).providers.find((provider) => provider.name === 'B');
  const remembered = `${bListed.id}/${bListed.models[0].id}`;
  await store.setLastConversationModel(remembered);
  await store.importProvidersAtomic({
    operationId: 'op-1',
    planHash: 'hash-1',
    providers: [{ deterministicId: 'imp-1', name: '导入', baseUrl: 'https://imp/v1', apiKey: 'k', api: 'openai-completions', models: [{ model: 'imp-model' }] }],
  });
  assert.equal((await store.list()).lastConversationModelKey, remembered, '导入不丢上次选择');
});

// —— 2026-11：思考强度目录级单值（拨盘读写这一份，不碰模型条目） ——

test('setThinkingLevel：写目录级单值；模型条目 thinkingLevel 原样保留；同值不落盘', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 3,
    defaultModelId: 'a/m2',
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://a/v1', models: [{ id: 'm1', model: 'model-a1' }, { id: 'm2', model: 'model-a2', thinkingLevel: 'high' }] },
    ],
  }) });
  const store = storeFor(fs);
  // v3→v4 迁移：全局档 := 默认条目（a/m2）的档位。
  assert.equal((await store.list()).thinkingLevel, 'high', '迁移后全局档＝原默认条目档');

  // 拨盘改档：只动目录顶层，条目档保持原样。
  const receipt = await store.setThinkingLevel('low');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.thinkingLevel, 'low');
  const persisted = JSON.parse(fs.files.get('/ud/text-model-profiles.json'));
  assert.equal(persisted.thinkingLevel, 'low', '目录顶层落盘');
  assert.equal(persisted.providers[0].models[1].thinkingLevel, 'high', '条目档不随拨盘改动');
  assert.equal(persisted.defaultModelId, undefined, '迁移后文件不再含默认指针');
  assert.equal((await store.resolve({ modelKey: 'a/m2' })).thinkingLevel, 'low', '发送解析读全局档');

  // 非法值归一为 default；同值重写不落盘。
  await store.setThinkingLevel('胡说的');
  assert.equal((await store.list()).thinkingLevel, 'default');
  const before = fs.files.get('/ud/text-model-profiles.json');
  await store.setThinkingLevel('default');
  assert.equal(fs.files.get('/ud/text-model-profiles.json'), before, '同值不落盘');
});
