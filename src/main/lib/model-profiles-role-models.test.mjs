// 056：角色路由（roleModels）持久化、逐项保存、旧 autoRouting 迁移、角色解析（离线单测）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createProfileStore, normalizeDirectory } from './model-profiles.mjs';
import { resolveRoleModel, resolveRoutingMain, roleModelsView } from './role-models.mjs';
import { loadRoles } from '../agent/agent-roles.mjs';

const safeStub = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decryptString: (buf) => {
    const text = Buffer.from(buf).toString('utf8');
    return text.startsWith('enc:') ? text.slice(4) : '';
  },
};
const enc = (plain) => Buffer.from(`enc:${plain}`).toString('base64');

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
    writeFile: async (p, content) => files.set(p, content),
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    mkdir: async () => {},
  };
}

function storeFor(fs, overrides = {}) {
  return createProfileStore({
    filePath: '/ud/text-model-profiles.json',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    mkdir: fs.mkdir,
    safeStorage: safeStub,
    ...overrides,
  });
}

const PROVIDERS = [
  {
    id: 'p-a',
    name: '供应商A',
    baseUrl: 'https://a.example/v1',
    encryptedApiKey: enc('key-a'),
    models: [{ id: 'm1', model: 'model-a', thinkingLevel: 'medium', supportsVision: true }],
  },
  {
    id: 'p-b',
    name: '供应商B',
    baseUrl: 'https://b.example/v1',
    encryptedApiKey: enc('key-b'),
    models: [{ id: 'm1', model: 'model-b', thinkingLevel: 'low' }],
  },
];

test('normalizeDirectory：缺 roleModels＝未配置；旧 autoRouting 的主脑→main、备用→fallback，执行角色退役', () => {
  const plain = normalizeDirectory({ version: 2, defaultModelId: 'p-a/m1', providers: PROVIDERS });
  assert.equal(plain.roleModels, undefined);
  const legacy = normalizeDirectory({
    version: 2,
    defaultModelId: 'p-a/m1',
    autoRouting: { chatModelKey: 'p-a/m1', executionModelKey: 'p-b/m1', fallbackModelKey: 'p-b/m1' },
    providers: PROVIDERS,
  });
  assert.deepEqual(legacy.roleModels, { main: 'p-a/m1', fallback: 'p-b/m1' });
  assert.equal(legacy.autoRouting, undefined);
});

test('normalizeDirectory：roleModels 保留合法槽位，非法值与未知槽位丢弃', () => {
  const dir = normalizeDirectory({
    version: 2,
    defaultModelId: 'p-a/m1',
    roleModels: { main: 'p-a/m1', explorer: 'p-b/m1', oracle: 'not-a-key', chat: 'p-a/m1' },
    providers: PROVIDERS,
  });
  assert.deepEqual(dir.roleModels, { main: 'p-a/m1', explorer: 'p-b/m1' });
});

test('saveRoleModel：逐项保存、null 清除、一次一个字段、引用必须在目录里', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  await store.saveProvider({ id: 'p-a', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'key-a', models: [{ id: 'm1', model: 'model-a' }] });
  await store.saveProvider({ id: 'p-b', name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'key-b', models: [{ id: 'm1', model: 'model-b' }] });
  const first = await store.saveRoleModel({ main: 'p-a/m1' });
  assert.equal(first.roleModels.main, 'p-a/m1');
  assert.equal(first.roleModels.oracle, null);
  await store.saveRoleModel({ explorer: 'p-b/m1' });
  await store.saveRoleModel({ fallback: 'p-b/m1' });
  const cleared = await store.saveRoleModel({ explorer: null });
  assert.equal(cleared.roleModels.explorer, null);
  assert.equal(cleared.roleModels.fallback, 'p-b/m1');
  await assert.rejects(store.saveRoleModel({ explorer: 'p-a/m1', oracle: 'p-b/m1' }), /一次只能保存一个/);
  await assert.rejects(store.saveRoleModel({ chat: 'p-a/m1' }), /一次只能保存一个/);
  await assert.rejects(store.saveRoleModel({ oracle: 'p-zzz/m9' }), /没有这个模型/);
  // 整体保存供应商不丢角色引用。
  await store.saveProvider({ id: 'p-a', name: 'A', baseUrl: 'https://a.example/v1', models: [{ id: 'm1', model: 'model-a', thinkingLevel: 'high' }] });
  assert.equal((await store.list()).roleModels.main, 'p-a/m1');
});

test('064 角色路由：沿用原槽位，固定模型全体一致；角色模型与实际图像要求匹配', async () => {
  const fs = memoryFs(), store = storeFor(fs), roles = loadRoles();
  await store.saveProvider({ id: 'p-a', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'key-a', models: [{ id: 'm1', model: 'model-a', supportsVision: true }] });
  await store.saveProvider({ id: 'p-b', name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'key-b', models: [{ id: 'm1', model: 'model-b' }] });
  assert.equal((await resolveRoutingMain(store)).ok, false);
  await store.saveRoleModel({ main: 'p-b/m1' });
  await store.saveRoleModel({ explorer: 'p-a/m1' });
  const main = (await resolveRoutingMain(store)).config;
  assert.equal(main.model, 'model-b');
  assert.equal((await resolveRoleModel({ role: roles.get('explorer'), store, mainConfig: main, routed: true })).config.model, 'model-a');
  assert.equal((await resolveRoleModel({ role: roles.get('oracle'), store, mainConfig: main, routed: true })).config.model, 'model-b');
  assert.equal((await resolveRoleModel({ role: roles.get('explorer'), store, mainConfig: main, routed: false })).config.model, 'model-b');
  assert.equal((await resolveRoleModel({ role: roles.get('designer'), store, mainConfig: main, routed: true })).ok, true, '没有图像需求的设计任务不强制视觉型号');
  const image = await resolveRoleModel({ role: roles.get('designer'), store, mainConfig: main, routed: true, requirements: { imageInput: true } });
  assert.equal(image.ok, false); assert.match(image.message, /图像/);
  await store.saveRoleModel({ designer: 'p-a/m1' });
  const imageReady = await resolveRoleModel({ role: roles.get('designer'), store, mainConfig: main, routed: true, requirements: { imageInput: true } });
  assert.equal(imageReady.config.model, 'model-a');
});

test('064 路由视图：原角色槽位直接可用，失效角色不改指默认', () => {
  const roles = loadRoles();
  const providers = [{ hasApiKey: true, models: [{ modelKey: 'x/text', model: 'text' }, { modelKey: 'x/vision', model: 'vision', supportsVision: true }] }];
  const view = roleModelsView({ providers, roleModels: { main: 'x/text', designer: 'x/vision' } }, roles);
  assert.equal(view.ready, true);
  assert.equal(view.slots.oracle.modelKey, null);
  assert.equal(view.slots.designer.modelKey, 'x/vision');
  const broken = roleModelsView({ providers, roleModels: { main: 'x/text', fixer: 'gone/m1' } }, roles);
  assert.equal(broken.ready, false); assert.equal(broken.slots.fixer.reason, 'missing');
});

test('resolveStrict：不借用默认回退；缺凭据与缺失给出明确原因', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  await store.saveProvider({ id: 'p-a', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'key-a', models: [{ id: 'm1', model: 'model-a' }] });
  await store.saveProvider({ id: 'p-b', name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'key-b', models: [{ id: 'm1', model: 'model-b' }] });
  const ok = await store.resolveStrict('p-a/m1');
  assert.equal(ok.ok, true);
  assert.equal(ok.config.modelKey, 'p-a/m1');
  assert.equal(ok.config.apiKey, 'key-a');
  assert.equal(ok.config.thinkingLevel, 'default');

  const missing = await store.resolveStrict('p-zzz/m9');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing');

  // resolveStrict 原样返回目录解析出的凭据（密文由 safeStorage 解开）。
  const plain = await store.resolveStrict('p-b/m1');
  assert.equal(plain.ok, true);
  assert.equal(plain.config.apiKey, 'key-b');
});


test('visionModelKey：旧档从默认模型条目迁（自己能看图／挂了看图模型键／同供应商裸名），之后单独保存', async () => {
  const self = normalizeDirectory({ version: 2, defaultModelId: 'p-a/m1', providers: PROVIDERS });
  assert.equal(self.visionModelKey, 'p-a/m1', '默认模型自己能看图');
  const helper = normalizeDirectory({
    version: 2, defaultModelId: 'p-b/m1',
    providers: [PROVIDERS[0], { ...PROVIDERS[1], models: [{ id: 'm1', model: 'model-b', visionModel: 'p-a/m1' }] }],
  });
  assert.equal(helper.visionModelKey, 'p-a/m1', '默认条目挂的看图模型键');
  const none = normalizeDirectory({ version: 2, defaultModelId: 'p-b/m1', providers: PROVIDERS });
  assert.equal(none.visionModelKey, null);
  const explicit = normalizeDirectory({ version: 2, defaultModelId: 'p-a/m1', visionModelKey: null, providers: PROVIDERS });
  assert.equal(explicit.visionModelKey, null, '显式 null（已单独设置过「不看图」）不再迁移');

  const fs = memoryFs();
  const store = storeFor(fs);
  await store.saveProvider({ id: 'p-a', name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'key-a', models: [{ id: 'm1', model: 'model-a' }] });
  await store.saveProvider({ id: 'p-b', name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'key-b', models: [{ id: 'm1', model: 'model-b' }] });
  assert.equal((await store.setVisionModel('p-b/m1')).visionModelKey, 'p-b/m1');
  await store.saveProvider({ id: 'p-a', name: 'A', baseUrl: 'https://a.example/v1', models: [{ id: 'm1', model: 'model-a', thinkingLevel: 'high' }] });
  assert.equal((await store.list()).visionModelKey, 'p-b/m1', '整体保存供应商不丢看图模型');
  await assert.rejects(store.setVisionModel('p-zzz/m9'), /没有这个模型/);
  assert.equal((await store.setVisionModel(null)).visionModelKey, null);
});
