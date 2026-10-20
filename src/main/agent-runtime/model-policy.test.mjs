import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeModelPolicy, resolveModelPlan, hydrateCandidate, compileRolePolicy, sessionCompatibility } from './model-policy.mjs';

function fixture() {
  const configs = { 'p/main': { modelKey: 'p/main', providerId: 'p', model: 'main', baseUrl: 'https://old.invalid', apiKey: 'secret' }, 'p/vision': { modelKey: 'p/vision', providerId: 'p', model: 'vision', baseUrl: 'https://old.invalid', apiKey: 'secret', supportsVision: true } };
  const directory = { defaultModelId: 'p/main', roleModels: { main: 'p/main', oracle: 'p/vision', fallback: 'p/vision' } };
  return { configs, directory, store: { list: async () => directory, resolveStrict: async key => configs[key] ? { ok: true, config: configs[key] } : { ok: false, message: '已撤销' } } };
}
test('固定选择冻结准确身份，不受角色或后续全局选择变化影响，不持久凭据', async () => {
  const { store, directory } = fixture(); const snapshot = await freezeModelPolicy({ store, modelKey: 'p/main' });
  directory.defaultModelId = 'p/vision';
  for (const role of ['main','explorer','fixer','oracle','designer']) {
    const plan = resolveModelPlan(snapshot, { role });
    assert.equal(plan.primary.modelKey, 'p/main'); assert.deepEqual(plan.allowedFallbacks, []);
  }
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.ok(snapshot.budgets.maxRequestsPerRun > 0);
  assert.throws(() => resolveModelPlan(snapshot, { role: 'designer', requirements: { imageInput: true } }), /图像/);
});
test('角色各用已配模型、空槽跟随主模型，共用备用且受理后配置冻结', async () => {
  const { store, directory } = fixture(); const snapshot = await freezeModelPolicy({ store, modelKey: 'auto' });
  directory.roleModels.oracle = 'p/main';
  directory.roleModels.fallback = null;
  assert.equal(resolveModelPlan(snapshot, { role: 'fixer' }).primary.modelKey, 'p/main');
  assert.equal(resolveModelPlan(snapshot, { role: 'oracle', requirements: { imageInput: true } }).primary.modelKey, 'p/vision');
  assert.equal(resolveModelPlan(snapshot, { role: 'explorer' }).primary.modelKey, 'p/main');
  assert.deepEqual(resolveModelPlan(snapshot, { role: 'explorer' }).allowedFallbacks.map(item => item.modelKey), ['p/vision']);
  assert.deepEqual(resolveModelPlan(snapshot, { role: 'oracle' }).allowedFallbacks, []);
  directory.envOverride = true;
  await assert.rejects(freezeModelPolicy({store,modelKey:'auto'}),/环境变量/);
  assert.throws(() => resolveModelPlan(snapshot, { role: 'unknown' }), /未知角色/);
});
test('同凭据轮换取新 secret，但 endpoint 变化不改冻结计划；撤销失败', async () => {
  const { store, configs } = fixture(); const snapshot = await freezeModelPolicy({ store }); const candidate = resolveModelPlan(snapshot).primary;
  configs['p/main'].apiKey = 'rotated'; configs['p/main'].baseUrl = 'https://new.invalid';
  const live = await hydrateCandidate(candidate, store); assert.equal(live.apiKey, 'rotated'); assert.equal(live.baseUrl, 'https://old.invalid');
  delete configs['p/main']; await assert.rejects(hydrateCandidate(candidate, store), /撤销/);
});
test('未配主模型、失效角色及无效预算明确拒绝', async () => {
  const { store, directory } = fixture(); delete directory.roleModels;
  await assert.rejects(freezeModelPolicy({ store, modelKey: 'auto' }), /没配主/);
  assert.equal(compileRolePolicy({}), null);
  directory.roleModels = { main: 'p/main', fixer: 'gone/model' };
  await assert.rejects(freezeModelPolicy({ store, modelKey: 'auto' }), /撤销/);
  await assert.rejects(freezeModelPolicy({ store, budgets: { maxRequestsPerRun: 0 } }), /正整数/);
});
test('续用不能仅按角色相同，跨工作区／模型计划拒绝', async () => {
  const { store } = fixture(); const snapshot = await freezeModelPolicy({ store }); const plan = resolveModelPlan(snapshot);
  assert.equal(sessionCompatibility({ previous: plan, next: plan, roleRevision: 'a', previousRoleRevision: 'a' }), null);
  assert.match(sessionCompatibility({ previous: plan, next: plan, workspace: { host: 'remote' }, previousWorkspace: { host: 'local' } }), /工作区/);
});
