import assert from 'node:assert/strict';
import test from 'node:test';

import { createProfileStore } from './model-profiles.mjs';

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const error = (code) => Object.assign(new Error(code), { code });
  return {
    files,
    readFile: async (p) => (files.has(p) ? files.get(p) : Promise.reject(error('ENOENT'))),
    writeFile: async (p, c) => files.set(p, c),
    rename: async (from, to) => {
      if (!files.has(from)) return Promise.reject(error('ENOENT'));
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

const importInput = (operationId, planHash, providers, firstDefaultModelKey = null) => ({
  operationId, planHash, providers, firstDefaultModelKey,
});

test('批量原子导入：一次生成全部供应商＋默认＋同文件回执；Key 加密；幂等重试返回原回执', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  const committed = await store.importProvidersAtomic(importInput('op-1', 'hash-1', [
    { deterministicId: 'mpi-a', name: '站A · default', baseUrl: 'https://s/v1', api: 'openai-completions', models: [{ model: 'gpt-5.2' }], apiKey: 'sk-shared' },
    { deterministicId: 'mpi-b', name: '站A · default · Anthropic', baseUrl: 'https://s', api: 'anthropic-messages', models: [{ model: 'claude-opus-4.6' }], apiKey: 'sk-shared' },
  ], 'mpi-b/claude-opus-4.6'));

  assert.equal(committed.receipt.operationId, 'op-1');
  assert.deepEqual(committed.receipt.providerIds, ['mpi-a', 'mpi-b']);
  assert.equal(committed.providers.length, 2);
  // 首次导入（空目录）：firstDefaultModelKey 生效
  const list = await store.list();
  assert.equal(list.defaultModelId, 'mpi-b/claude-opus-4.6');
  assert.equal(list.providers.length, 2);
  assert.equal(list.providers[1].api, 'anthropic-messages');
  assert.equal(list.providers[0].hasApiKey, true);
  // 同文件回执＋密文
  const raw = JSON.parse(fs.files.get('/ud/text-model-profiles.json'));
  assert.equal(raw.version, 3);
  assert.equal(raw.importReceipts.length, 1);
  assert.equal(JSON.stringify(raw).includes('sk-shared'), false);

  // 幂等：同 operationId＋planHash 重试 → 原回执，不重复写
  const again = await store.importProvidersAtomic(importInput('op-1', 'hash-1', [
    { deterministicId: 'mpi-a', name: 'x', baseUrl: 'https://s/v1', api: 'openai-completions', models: [{ model: 'g' }], apiKey: 'sk-other' },
  ]));
  assert.equal(again.receipt.committedAt, committed.receipt.committedAt);
  const listAfter = await store.list();
  assert.equal(listAfter.providers.length, 2, '重试不追加');

  // hash 异 → 冲突
  await assert.rejects(
    () => store.importProvidersAtomic(importInput('op-1', 'hash-2', [
      { deterministicId: 'mpi-c', name: 'y', baseUrl: 'https://s/v1', api: 'openai-completions', models: [{ model: 'g' }], apiKey: 'sk' },
    ])),
    /计划变了/,
  );
});

test('已有目录：默认/角色/旧供应商保留；deterministicId 撞车拒绝；v2 回执缺省为空', async () => {
  const fs = memoryFs({ '/ud/text-model-profiles.json': JSON.stringify({
    version: 2,
    defaultModelId: 'old/m1',
    roleModels: { explorer: 'old/m1' },
    providers: [
      { id: 'old', name: '旧站', baseUrl: 'https://old/v1', encryptedApiKey: 'enc:oldkey', models: [{ id: 'm1', model: 'old-model' }] },
    ],
  }) });
  const store = storeFor(fs);

  const committed = await store.importProvidersAtomic(importInput('op-2', 'h2', [
    { deterministicId: 'mpi-new', name: '新站', baseUrl: 'https://new/v1', api: 'openai-completions', models: [{ model: 'new-model' }], apiKey: 'sk-new' },
  ]));
  const list = await store.list();
  assert.equal(list.providers.length, 2);
  assert.equal(list.defaultModelId, 'old/m1', '已有有效默认保持');
  assert.equal(list.roleModels.explorer, 'old/m1', '角色引用保留');
  const credentials = await store.providerCredentials('mpi-new');
  assert.equal(credentials.apiKey, 'sk-new');

  // 撞车
  await assert.rejects(
    () => store.importProvidersAtomic(importInput('op-3', 'h3', [
      { deterministicId: 'old', name: '撞', baseUrl: 'https://x/v1', api: 'openai-completions', models: [{ model: 'm' }], apiKey: 'sk' },
    ])),
    /id 冲突/,
  );

  // 普通保存路径不丢回执
  await store.saveProvider({ id: 'mpi-new', name: '新站改名', baseUrl: 'https://new/v1', models: [{ id: 'new-model', model: 'new-model' }] });
  const raw = JSON.parse(fs.files.get('/ud/text-model-profiles.json'));
  assert.equal(raw.importReceipts.length, 1);
  assert.equal((await store.findImportReceipt('op-2')).operationId, 'op-2');
  assert.equal(await store.findImportReceipt('op-none'), null);
});

test('严格门禁：未知协议/缺 Key/空计划/加密不可用/环境覆盖都拒绝', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  await assert.rejects(
    () => store.importProvidersAtomic(importInput('op-a', 'h', [
      { deterministicId: 'x1', name: 'x', baseUrl: 'https://s/v1', api: 'gemini-raw', models: [{ model: 'm' }], apiKey: 'sk' },
    ])),
    /未知线协议/,
  );
  await assert.rejects(
    () => store.importProvidersAtomic(importInput('op-b', 'h', [
      { deterministicId: 'x1', name: 'x', baseUrl: 'https://s/v1', api: 'openai-completions', models: [{ model: 'm' }], apiKey: '' },
    ])),
    /缺少 Key/,
  );
  await assert.rejects(() => store.importProvidersAtomic(importInput('op-c', 'h', [])), /导入计划为空/);

  const noEnc = storeFor(memoryFs(), { safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.of(), decryptString: () => '' } });
  await assert.rejects(
    () => noEnc.importProvidersAtomic(importInput('op-d', 'h', [
      { deterministicId: 'x1', name: 'x', baseUrl: 'https://s/v1', api: 'openai-completions', models: [{ model: 'm' }], apiKey: 'sk' },
    ])),
    /无法加密/,
  );

  const envStore = storeFor(memoryFs(), { env: { HEMI_LLM_API_KEY: 'env-key' } });
  await assert.rejects(
    () => envStore.importProvidersAtomic(importInput('op-e', 'h', [
      { deterministicId: 'x1', name: 'x', baseUrl: 'https://s/v1', api: 'openai-completions', models: [{ model: 'm' }], apiKey: 'sk' },
    ])),
    /环境变量/,
  );
});
