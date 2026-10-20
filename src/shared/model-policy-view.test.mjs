import test from 'node:test';
import assert from 'node:assert/strict';
import { modelPolicyView } from './model-policy-view.mjs';
const directory = { providers: [{hasApiKey: true, models: [{modelKey: 'p/a', model: 'A'}, {modelKey: 'p/b', model: 'B'}]}], roleModels: {main: 'p/a', fixer: 'p/b'} };
test('原角色模型配置直接可用，未配主模型时不可选自动', () => {
  assert.equal(modelPolicyView(directory).ready, true);
  assert.equal(modelPolicyView({...directory, roleModels: {main: null}}).ready, false);
  assert.equal(modelPolicyView({...directory, roleModels: {main: 'p/a'}}).ready, true);
});
test('角色模型或共用备用失效、缺凭据及环境覆盖与宿主受理口径一致', () => {
  for (const slot of ['main', 'explorer', 'oracle', 'fixer', 'designer', 'fallback']) {
    assert.equal(modelPolicyView({...directory, roleModels: {...directory.roleModels, [slot]: 'missing'}}).ready, false);
  }
  assert.equal(modelPolicyView({...directory, envOverride: true}).ready, false);
  assert.equal(modelPolicyView({...directory, providers: [{...directory.providers[0], hasApiKey: false}]}).ready, false);
});
