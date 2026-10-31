import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignStep,
  createOnboardingStore,
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
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
    version: ONBOARDING_VERSION,
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

test('新用户先接模型；未配置模型不能进入能力页或绕过步骤完成', async () => {
  const fs = memoryFs();
  const store = storeFor(fs);
  assert.equal((await store.advance({ to: 'microphone' })).ok, false);
  assert.equal((await store.advance({ to: 'model' })).ok, true);
  const blocked = await store.advance({ to: 'capabilities' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /模型/);
  assert.equal((await store.complete()).ok, false);
  assert.equal(JSON.parse(fs.files.get('/ud/onboarding.json')).phase, 'in_progress');
});

test('只有模型也能完成：不授麦克风，不填写 ASR，重启后仍直接使用', async () => {
  const fs = memoryFs();
  const store = storeFor(fs, { model: true, asr: false });
  await store.advance({ to: 'model' });
  assert.equal((await store.advance({ to: 'capabilities' })).ok, true);
  assert.equal((await store.advance({ to: 'done' })).ok, true);
  assert.equal((await store.complete()).ok, true);
  assert.equal(store.isInProgress(), false);
  assert.equal((await store.complete()).ok, true, '完成幂等');
  const persisted = JSON.parse(fs.files.get('/ud/onboarding.json'));
  assert.equal(persisted.phase, 'complete');
  assert.equal(persisted.version, ONBOARDING_VERSION);
  assert.ok(persisted.completedAt);
  const restarted = await storeFor(fs, { model: true }).getState();
  assert.equal(restarted.phase, 'complete');
  assert.equal(restarted.asrSaved, false);
});

test('可选语音能进入、跳过并返回；未授麦克风不能误标已完成权限', async () => {
  const fs = memoryFs();
  const store = storeFor(fs, { model: true });
  await store.advance({ to: 'model' });
  await store.advance({ to: 'capabilities' });
  assert.equal((await store.advance({ to: 'microphone' })).ok, true);
  assert.equal((await store.advance({ to: 'asr' })).ok, false);
  const skipped = await store.advance({ to: 'capabilities', permissionChoice: 'skipped' });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.state.permissionChoice, 'skipped');
  await store.advance({ to: 'microphone' });
  assert.equal((await store.advance({ to: 'asr', permissionChoice: 'granted' })).ok, true);
  const after = await store.advance({ to: 'capabilities' });
  assert.equal(after.ok, true, '语音密钥未填仍可返回文字路径');
  assert.equal(after.state.asrSaved, false);
  assert.equal((await store.advance({ to: 'done' })).ok, true);
  assert.equal((await store.complete()).ok, true);
});

test('进行中仅模型缺失会退步；ASR 缺失不会把已选择的步骤打回', async () => {
  const fs = memoryFs();
  seedInProgress(fs, 'capabilities', 'granted');
  assert.equal((await storeFor(fs, { model: true, asr: false }).getState()).step, 'capabilities');
  assert.equal((await storeFor(fs, { model: false, asr: true }).getState()).step, 'model');
});

test('模型在完成前被删：拒绝完成，重新读取回到模型页', async () => {
  const fs = memoryFs();
  seedInProgress(fs, 'done');
  const store = storeFor(fs, { model: false });
  const result = await store.complete();
  assert.equal(result.ok, false);
  assert.match(result.message, /模型/);
  assert.equal((await store.getState()).step, 'model');
});

test('完成后配置失效不再回引导，包括旧版完成状态', async () => {
  for (const version of [1, ONBOARDING_VERSION]) {
    const fs = memoryFs({ '/ud/onboarding.json': JSON.stringify({ version, phase: 'complete', step: 'done', completedAt: 42 }) });
    const state = await storeFor(fs).getState();
    assert.equal(state.phase, 'complete');
    assert.equal(state.step, 'done');
    assert.equal(state.modelComplete, false);
  }
});

test('旧版尚未完成的语音/模型/完成步骤接回模型页，保留已有配置与权限选择', async () => {
  for (const step of ['microphone', 'asr', 'model', 'done']) {
    const fs = memoryFs({ '/ud/onboarding.json': JSON.stringify({ version: 1, phase: 'in_progress', step, permissionChoice: 'granted' }) });
    const state = await storeFor(fs, { model: true, asr: true }).getState();
    assert.equal(state.step, 'model');
    assert.equal(state.version, ONBOARDING_VERSION);
    assert.equal(state.permissionChoice, 'granted');
    assert.equal(state.asrSaved, true);
    assert.equal(state.modelComplete, true);
  }
});

test('后退保留配置与权限选择，新的可选能力页支持重启续接', async () => {
  const fs = memoryFs();
  seedInProgress(fs, 'capabilities', 'skipped');
  const store = storeFor(fs, { model: true, asr: true });
  assert.equal((await store.getState()).step, 'capabilities');
  const back = await store.advance({ to: 'model' });
  assert.equal(back.ok, true);
  assert.equal(back.state.permissionChoice, 'skipped');
  assert.equal(back.state.asrSaved, true);
  assert.equal((await store.advance({ to: 'welcome' })).ok, true);
  assert.equal((await store.advance({ to: 'done' })).ok, false, '欢迎页不能绕过流程');
});

test('alignStep 只按模型门槛回退，完整配置不自动替用户前进', () => {
  const base = { version: ONBOARDING_VERSION, phase: 'in_progress', step: 'done' };
  assert.equal(alignStep(base, { modelComplete: false, asrSaved: true }).step, 'model');
  assert.equal(alignStep(base, { modelComplete: true, asrSaved: false }).step, 'done');
  assert.equal(alignStep({ ...base, step: 'model' }, { modelComplete: true }).step, 'model');
  assert.equal(alignStep({ ...base, phase: 'complete' }, { modelComplete: false }).step, 'done');
  assert.deepEqual(ONBOARDING_STEPS, ['welcome', 'restore', 'model', 'capabilities', 'microphone', 'asr', 'done']);
});

test('跳过引导/恢复完成：force complete 无模型也可进入主界面；welcome 可进入 restore', async () => {
  const store = storeFor(memoryFs({}));
  await store.getState();
  const skipped = await store.complete({ force: true });
  assert.equal(skipped.ok, true, 'force 应绕过模型门槛直接完成');
  assert.equal((await store.getState()).phase, 'complete');
  // 非强制仍要求模型
  const store2 = storeFor(memoryFs({}));
  await store2.getState();
  assert.equal((await store2.complete()).ok, false);
  // welcome → restore 合法（不受模型门拦截）
  const store3 = storeFor(memoryFs({}));
  await store3.getState();
  const entered = await store3.advance({ to: 'restore' });
  assert.equal(entered.ok, true, 'welcome 应可进入从备份恢复步骤');
  assert.equal((await store3.getState()).step, 'restore');
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
