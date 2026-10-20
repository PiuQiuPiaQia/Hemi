import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignStep,
  createOnboardingStore,
  ONBOARDING_STEPS,
} from './onboarding-state.mjs';

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

function storeFor(fs, { asr = false, model = false } = {}) {
  return createOnboardingStore({
    filePath: '/ud/onboarding.json',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    mkdir: fs.mkdir,
    hasPersistedAsrKey: async () => asr,
    defaultModelComplete: async () => model,
    log: null,
  });
}

/** 播种「上一段生命周期留下的进行中状态」。 */
function seedInProgress(fs, step = 'welcome', permissionChoice = 'pending') {
  fs.files.set('/ud/onboarding.json', JSON.stringify({
    version: 1,
    phase: 'in_progress',
    step,
    permissionChoice,
    updatedAt: 1,
    completedAt: null,
  }));
}

test('首次启动（无状态、无 ASR Key）：写 in_progress/welcome 再展示欢迎屏', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  const state = await store.getState();
  assert.equal(state.phase, 'in_progress');
  assert.equal(state.step, 'welcome');
  assert.equal(state.permissionChoice, 'pending');
  assert.ok(fs.files.has('/ud/onboarding.json'), '进行中状态立即落盘');
  assert.equal(store.isInProgress(), true);
});

test('第二段生命周期（同一文件、Key 已存）：仍是进行中，步骤不被顶替', async () => {
  const fs = memoryFs();
  // 第一段生命周期：无 Key 启动 → 写 in_progress/welcome。
  let store = storeFor(fs, { asr: false });
  assert.equal((await store.getState()).phase, 'in_progress');
  // 第二段生命周期（同一文件、Key 已存）：仍是进行中，回到未完成步骤。
  store = storeFor(fs, { asr: true, model: false });
  const state = await store.getState();
  assert.equal(state.phase, 'in_progress');
  assert.equal(state.step, 'welcome', '步骤保留在未完成处');
  assert.equal(state.asrSaved, true);
});

test('advance：顺序前进与硬门槛；跳步/缺配置被拒', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);

  let result = await store.advance({ to: 'microphone' });
  assert.equal(result.ok, true);
  assert.equal(result.state.step, 'microphone');

  // 麦克风 → 语音服务：必须先做权限选择。
  result = await store.advance({ to: 'asr' });
  assert.equal(result.ok, false);
  assert.match(result.message, /允许麦克风|稍后开启/);
  result = await store.advance({ to: 'asr', permissionChoice: 'granted' });
  assert.equal(result.ok, true);
  assert.equal(result.state.permissionChoice, 'granted');

  // 语音服务 → 模型：ASR Key 未持久保存则被拒。
  result = await store.advance({ to: 'model' });
  assert.equal(result.ok, false);
  assert.match(result.message, /语音服务/);

  // 跳步直达完成同样被拒。
  result = await store.advance({ to: 'done' });
  assert.equal(result.ok, false);
});

test('advance/complete：两项配置齐备才能走到完成（模型步由保存动作推进）', async () => {
  const fs = memoryFs();
  seedInProgress(fs, 'welcome');
  const store = storeFor(fs, { asr: true, model: false });
  await store.advance({ to: 'microphone' });
  await store.advance({ to: 'asr', permissionChoice: 'skipped' });
  let result = await store.advance({ to: 'model' });
  assert.equal(result.ok, true, 'ASR 已存，进模型步不卡');

  // 模型步保存完成后（defaultModelComplete 翻真）才能进完成屏。
  const fs2 = memoryFs({ '/ud/onboarding.json': fs.files.get('/ud/onboarding.json') });
  const store2 = storeFor(fs2, { asr: true, model: true });
  result = await store2.getState();
  assert.equal(result.step, 'model', '配置对齐只退不进，停在模型步');
  result = await store2.advance({ to: 'done' });
  assert.equal(result.ok, true);

  // 完成屏「开始使用」：双门槛复核后写 complete；幂等。
  result = await store2.complete();
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, 'complete');
  result = await store2.complete();
  assert.equal(result.ok, true, '重复完成幂等');
  const persisted = JSON.parse(fs2.files.get('/ud/onboarding.json'));
  assert.equal(persisted.phase, 'complete');
  assert.equal(persisted.completedAt != null, true);
});

test('complete：缺任一配置被拒，不写完成', async () => {
  const fs = memoryFs();
  seedInProgress(fs, 'model', 'granted');
  const store = storeFor(fs, { asr: true, model: false });
  const result = await store.complete();
  assert.equal(result.ok, false);
  assert.match(result.message, /模型/);
  const persisted = JSON.parse(fs.files.get('/ud/onboarding.json'));
  assert.equal(persisted.phase, 'in_progress');
});

test('配置对齐：进行中配置被删只退步；完成态不回退', async () => {
  // 已走到 model 步、双配置齐备。
  const fs = memoryFs();
  seedInProgress(fs, 'welcome');
  const store = storeFor(fs, { asr: true, model: true });
  await store.advance({ to: 'microphone' });
  await store.advance({ to: 'asr', permissionChoice: 'granted' });
  await store.advance({ to: 'model' });
  // 模型组被清掉 → 退回模型步；ASR Key 再被删 → 退回语音服务步。
  let state = await createOnboardingStore({
    filePath: '/ud/onboarding.json',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    mkdir: fs.mkdir,
    hasPersistedAsrKey: async () => true,
    defaultModelComplete: async () => false,
  }).getState();
  assert.equal(state.step, 'model');
  state = await createOnboardingStore({
    filePath: '/ud/onboarding.json',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    mkdir: fs.mkdir,
    hasPersistedAsrKey: async () => false,
    defaultModelComplete: async () => false,
  }).getState();
  assert.equal(state.step, 'asr');

  // 完成后的用户配置失效：phase 保持 complete，不回引导。
  const done = memoryFs({
    '/ud/onboarding.json': JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'granted', updatedAt: 1, completedAt: 2 }),
  });
  const after = await storeFor(done, { asr: false, model: false }).getState();
  assert.equal(after.phase, 'complete');
  assert.equal(after.step, 'done');
});

test('后退与返回：允许任意后退，已存配置不丢、权限选择保留', async () => {
  const fs = memoryFs();
  seedInProgress(fs, 'welcome');
  const store = storeFor(fs, { asr: true, model: true });
  await store.advance({ to: 'microphone' });
  await store.advance({ to: 'asr', permissionChoice: 'granted' });
  await store.advance({ to: 'model' });
  const back = await store.advance({ to: 'microphone' });
  assert.equal(back.ok, true);
  assert.equal(back.state.step, 'microphone');
  assert.equal(back.state.permissionChoice, 'granted', '后退不清权限选择');
  // 回到麦克风步后再前进：门槛按已存配置放行。
  const forward = await store.advance({ to: 'asr', permissionChoice: 'granted' });
  assert.equal(forward.ok, true);
});

test('alignStep（纯函数）：只退不进、complete 不动', () => {
  const base = { version: 1, phase: 'in_progress', step: 'model', permissionChoice: 'granted', updatedAt: 1, completedAt: null };
  assert.equal(alignStep(base, { asrSaved: true, modelComplete: false }).step, 'model');
  assert.equal(alignStep(base, { asrSaved: false, modelComplete: false }).step, 'asr');
  assert.equal(alignStep(base, { asrSaved: false, modelComplete: true }).step, 'asr', '模型虽全，ASR 缺仍退语音步');
  const done = { ...base, phase: 'complete', step: 'done' };
  assert.equal(alignStep(done, { asrSaved: false, modelComplete: false }).step, 'done');
  assert.deepEqual(ONBOARDING_STEPS, ['welcome', 'microphone', 'asr', 'model', 'done']);
});

test('损坏的 onboarding.json 按无状态重建；并发初始化单飞', async () => {
  const fs = memoryFs({ '/ud/onboarding.json': '{oops' });
  const store = storeFor(fs);
  const state = await store.getState();
  assert.equal(state.phase, 'in_progress');
  assert.equal(state.step, 'welcome');

  // 单飞：两个并发 ensureInitialized 只做一次首次判定（这里用持久化计数验证）。
  let writes = 0;
  const counting = memoryFs({ '/ud/onboarding.json': '{oops' });
  const originalWrite = counting.writeFile;
  counting.writeFile = async (p, c) => {
    writes += 1;
    return originalWrite(p, c);
  };
  const store2 = storeFor(counting);
  await Promise.all([store2.getState(), store2.getState(), store2.ensureInitialized()]);
  assert.equal(writes, 1, '并发初始化只落一次盘');
});
