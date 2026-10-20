import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppCatalog, decodeBundleAppRef, encodeBundleAppRef } from './app-catalog.mjs';

const APPS = [
  { bundleId: 'com.example.alpha', name: 'Alpha', path: '/Applications/Alpha.app' },
  { bundleId: 'com.example.beta', name: 'Beta', path: '/Applications/Beta.app' },
];

function makeCatalog(apps = APPS) {
  let calls = 0;
  const listInstalled = async () => {
    calls += 1;
    return apps;
  };
  return { catalog: createAppCatalog({ listInstalled }), listCalls: () => calls };
}

test('listApplications：DTO 字段齐全，rowId 唯一，ref 带当前代次', async () => {
  const { catalog } = makeCatalog();
  const rows = await catalog.listApplications();
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['icon', 'name', 'platform', 'ref', 'rowId', 'running', 'source'].sort());
  assert.notEqual(rows[0].rowId, rows[1].rowId);
  assert.equal(rows[0].ref.catalogRevision, 1);
  assert.equal(rows[0].platform, 'darwin');
  assert.equal(rows[0].source.kind, 'bundle');
  assert.equal(rows[0].source.locationLabel, '/Applications/Alpha.app');
});

test('appRef 编解码往返；渲染层伪造/篡改的 ref 解不开', async () => {
  const ref = encodeBundleAppRef('com.example.alpha');
  assert.equal(decodeBundleAppRef(ref), 'com.example.alpha');
  assert.equal(decodeBundleAppRef('com.example.alpha'), null, '裸 bundleId 不是合法 ref');
  assert.equal(decodeBundleAppRef('hemi-appref-1:!!!'), null);
  assert.equal(decodeBundleAppRef(undefined), null);
});

test('resolveAppRef：当前代次 + 应用在清单里 → 放行 bundleId', async () => {
  const { catalog } = makeCatalog();
  await catalog.listApplications();
  const ref = encodeBundleAppRef('com.example.beta');
  const result = await catalog.resolveAppRef(ref, catalog.catalogRevision);
  assert.deepEqual(result, { ok: true, bundleId: 'com.example.beta' });
});

test('resolveAppRef：旧代次 ref → APP_REF_STALE（重开弹窗刷新）', async () => {
  const { catalog } = makeCatalog();
  const rows = await catalog.listApplications();
  const staleRef = rows[0].ref;
  await catalog.listApplications(); // 代次推进
  const result = await catalog.resolveAppRef(staleRef.appRef, staleRef.catalogRevision);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'APP_REF_STALE');
});

test('resolveAppRef：应用被删除 → APP_IDENTITY_CHANGED（不静默放行旧身份）', async () => {
  const apps = [...APPS];
  const holder = { apps };
  const catalog = createAppCatalog({ listInstalled: async () => holder.apps });
  const rows = await catalog.listApplications();
  holder.apps = APPS.filter((a) => a.bundleId !== 'com.example.alpha');
  const result = await catalog.resolveAppRef(rows[0].ref.appRef, rows[0].ref.catalogRevision);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'APP_IDENTITY_CHANGED');
});

test('resolveAppRef：非整数/缺代次 → APP_REF_STALE', async () => {
  const { catalog } = makeCatalog();
  await catalog.listApplications();
  const ref = encodeBundleAppRef('com.example.alpha');
  assert.equal((await catalog.resolveAppRef(ref, undefined)).errorCode, 'APP_REF_STALE');
  assert.equal((await catalog.resolveAppRef(ref, 1.5)).errorCode, 'APP_REF_STALE');
  assert.equal((await catalog.resolveAppRef(ref, '1')).errorCode, 'APP_REF_STALE');
});

test('runningNames：运行态只做展示排序，不影响 ref 复核', async () => {
  const { catalog } = makeCatalog();
  const rows = await catalog.listApplications({ runningNames: new Map([['com.example.beta', { name: 'Beta' }]]) });
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].name, 'Beta');
  const result = await catalog.resolveAppRef(rows[0].ref.appRef, rows[0].ref.catalogRevision);
  assert.equal(result.ok, true);
});

test('同名不同应用：两行各自持有独立 ref（rowId 不冲突）', async () => {
  const apps = [
    { bundleId: 'com.a.notes', name: '备忘录', path: '/Applications/备忘录.app' },
    { bundleId: 'com.b.notes', name: '备忘录', path: '/Users/x/备忘录.app' },
  ];
  const catalog = createAppCatalog({ listInstalled: async () => apps });
  const rows = await catalog.listApplications();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].rowId, rows[1].rowId);
  assert.notEqual(rows[0].ref.appRef, rows[1].ref.appRef);
});
