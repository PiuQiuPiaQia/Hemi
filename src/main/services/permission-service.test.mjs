// 042 P1 · permission-service 单测（node --test，假时钟＋临时目录，无 Electron）。
// 覆盖 contracts.md §2 的必测面：grant 合并、临时期限、并发写、撤销优先、
// 保存失败、崩溃恢复、缺库与首次启动区分；外加 epoch/请求生命周期/文件夹授权退役（只剩应用资源）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createPermissionService } from './permission-service.mjs';

async function freshService(extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hemi-psvc-'));
  const clock = { now: 1_000_000 };
  const svc = createPermissionService({ dir, nowFn: () => clock.now, ...extra });
  await svc.load();
  return { svc, dir, clock, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test('首次启动：无标识无库无 journal → 建空库，ready，空表 ≠ 损坏', async () => {
  const { svc, dispose } = await freshService();
  assert.equal(svc.health, 'ready');
  const st = svc.getState();
  assert.equal(st.grants.length, 0);
  assert.equal(st.health, 'ready');
  await dispose();
});

test('已初始化后丢库 → corrupt（不是首次启动），不回退不重建', async () => {
  const { svc, dir, dispose } = await freshService();
  await svc.addApplication({ identityKey: 'com.example.app', displayName: '示例' });
  await rm(path.join(dir, 'access-grants.json'));
  const svc2 = createPermissionService({ dir });
  await svc2.load();
  assert.equal(svc2.health, 'corrupt');
  assert.equal(svc2.checkAccess({ taskId: 't1', resourceId: svc2.appResourceId('com.example.app') }).errorCode, 'STORE_UNAVAILABLE');
  await dispose();
});

test('库文件损坏 → corrupt 且留备份', async () => {
  const { svc, dir, dispose } = await freshService();
  await svc.addApplication({ identityKey: 'com.example.app', displayName: '示例' });
  await writeFile(path.join(dir, 'access-grants.json'), '{ not json', 'utf-8');
  const svc2 = createPermissionService({ dir });
  await svc2.load();
  assert.equal(svc2.health, 'corrupt');
  // 备份文件存在（.corrupt- 时间戳后缀）
  const files = await import('node:fs/promises').then((fsp) => fsp.readdir(dir));
  assert.ok(files.some((f) => f.startsWith('access-grants.json.corrupt-')), files.join(','));
  await dispose();
});

test('未知 schemaVersion → corrupt', async () => {
  const { svc, dir, dispose } = await freshService();
  await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  const p = path.join(dir, 'access-grants.json');
  const doc = JSON.parse(await readFile(p, 'utf-8'));
  doc.schemaVersion = 99;
  await writeFile(p, JSON.stringify(doc));
  const svc2 = createPermissionService({ dir });
  await svc2.load();
  assert.equal(svc2.health, 'corrupt');
  await dispose();
});

test('添加应用＝持续 access；checkAccess 通过并给出 viaGrant', async () => {
  const { svc, dispose } = await freshService();
  const r = await svc.addApplication({ identityKey: 'com.tencent.xinWeChat', displayName: '微信' });
  assert.equal(r.ok, true);
  const chk = svc.checkAccess({ taskId: 't1', resourceId: r.resourceId, capability: 'access' });
  assert.equal(chk.ok, true);
  assert.equal(typeof chk.viaGrant, 'string');
  // 应用不可请求 edit
  assert.equal(svc.checkAccess({ taskId: 't1', resourceId: r.resourceId, capability: 'edit' }).errorCode, 'UNSUPPORTED_CAPABILITY');
  await dispose();
});

test('任务临时授权：仅本任务可见，cleanupTask 后失效；不影响其他任务', async () => {
  const { svc, dispose } = await freshService();
  // 发现态资源（无持续授权）——卡片流程的真实前置
  const r = svc.noteResource({ type: 'app', identityKey: 'com.a', displayName: 'A' });
  assert.equal(svc.checkAccess({ taskId: 't0', resourceId: r.resourceId }).ok, false); // 未授权基线
  svc.grantTaskScope({ taskId: 't1', resourceId: r.resourceId });
  assert.equal(svc.checkAccess({ taskId: 't1', resourceId: r.resourceId }).ok, true);
  assert.equal(svc.checkAccess({ taskId: 't2', resourceId: r.resourceId }).ok, false); // 不跨任务
  svc.cleanupTask('t1');
  assert.equal(svc.checkAccess({ taskId: 't1', resourceId: r.resourceId }).ok, false);
  await dispose();
});

test('grant 并集：persistent + task 同一应用两份来源；移除任务那份，持续那份仍有效', async () => {
  const { svc, dispose } = await freshService();
  const r = await svc.addApplication({ identityKey: 'com.x', displayName: 'X' });
  svc.grantTaskScope({ taskId: 't1', resourceId: r.resourceId, capability: 'access' });
  assert.equal(svc.checkAccess({ taskId: 't1', resourceId: r.resourceId }).ok, true);
  const remaining = svc.grantsForResource(r.resourceId);
  assert.equal(remaining.length, 2); // 来源可解释
  svc.cleanupTask('t1');
  assert.equal(svc.grantsForResource(r.resourceId).length, 1);
  assert.equal(svc.checkAccess({ taskId: 't1', resourceId: r.resourceId }).ok, true); // persistent 仍在
  await dispose();
});

test('整资源撤销：只撤该应用（不连带别的应用）；任务临时授权与待确认请求一并取消；epoch 递增', async () => {
  const { svc, dispose } = await freshService();
  const app = await svc.addApplication({ identityKey: 'com.tencent.xinWeChat', displayName: '微信' });
  const other = await svc.addApplication({ identityKey: 'com.other', displayName: '其他' });
  svc.grantTaskScope({ taskId: 't1', resourceId: app.resourceId });
  svc.createRequest({ taskId: 't1', requirements: [{ resourceId: app.resourceId, capability: 'access' }] });
  const epochBefore = svc.resourceEpoch(app.resourceId);
  await svc.revokeResource({ resourceId: app.resourceId });
  assert.equal(svc.checkAccess({ taskId: 't1', resourceId: app.resourceId }).ok, false);
  assert.equal(svc.checkAccess({ taskId: 't1', resourceId: other.resourceId }).ok, true); // 不连带
  assert.equal(svc.resourceEpoch(app.resourceId), epochBefore + 1);
  assert.equal(svc.getState('t1').pendingRequests.length, 0);
  await dispose();
});

test('来源级移除：只移除该份；剩余来源仍有效', async () => {
  const { svc, dispose } = await freshService();
  const r = await svc.addApplication({ identityKey: 'com.y', displayName: 'Y' });
  const r2 = await svc.upsertCardGrant({ type: 'app', identityKey: 'com.y', capability: 'access' }); // 第二份来源（授权卡）
  const st = svc.getState();
  assert.equal(st.grants.filter((g) => g.resourceId === r.resourceId).length, 2);
  const out = await svc.removeGrant({ grantId: r.grantId });
  assert.equal(out.ok, true);
  assert.equal(svc.checkAccess({ taskId: 't', resourceId: r2.resourceId }).ok, true); // 另一份仍在
  await dispose();
});

test('请求生命周期：过期作废、决议不可复用、kind 与 decision 匹配', async () => {
  const { svc, clock, dispose } = await freshService();
  const app = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  const { requestId } = svc.createRequest({
    taskId: 't1', requirements: [{ resourceId: app.resourceId, capability: 'access' }],
  });
  clock.now += 31_000; // 超时
  assert.equal(svc.decide(requestId, 'task').errorCode, 'REQUEST_EXPIRED');
  // action 卡只能 action-once
  const { requestId: rid2 } = svc.createRequest({ taskId: 't1', kind: 'action', requirements: [] });
  assert.equal(svc.decide(rid2, 'task').errorCode, 'KIND_MISMATCH');
  const { requestId: rid3 } = svc.createRequest({ taskId: 't1', kind: 'action', requirements: [] });
  assert.deepEqual(svc.decide(rid3, 'action-once'), { ok: true, effect: 'action-once' });
  // 决议后不可复用
  assert.equal(svc.decide(rid3, 'action-once').errorCode, 'REQUEST_EXPIRED');
  await dispose();
});

test('decide(task)：产生绑定任务的临时授权；deny 不产生任何 grant', async () => {
  const { svc, dispose } = await freshService();
  const app = svc.noteResource({ type: 'app', identityKey: 'com.a', displayName: 'A' }); // 发现态，未授权
  const { requestId } = svc.createRequest({
    taskId: 't1', requirements: [{ resourceId: app.resourceId, capability: 'access' }],
  });
  const out = svc.decide(requestId, 'task');
  assert.equal(out.ok, true);
  assert.equal(out.effect, 'task');
  assert.equal(svc.checkAccess({ taskId: 't1', resourceId: app.resourceId }).ok, true);
  const { requestId: r2 } = svc.createRequest({
    taskId: 't2', requirements: [{ resourceId: app.resourceId, capability: 'access' }],
  });
  const d = svc.decide(r2, 'deny');
  assert.equal(d.effect, 'denied');
  assert.equal(svc.checkAccess({ taskId: 't2', resourceId: app.resourceId }).ok, false);
  await dispose();
});

test('并发写：两个连续添加串行落库，revision 单调 +2，文件含两者', async () => {
  const { svc, dir, dispose } = await freshService();
  const [a, b] = await Promise.all([
    svc.addApplication({ identityKey: 'com.a', displayName: 'A' }),
    svc.addApplication({ identityKey: 'com.b', displayName: 'B' }),
  ]);
  assert.ok(a.ok && b.ok);
  const doc = JSON.parse(await readFile(path.join(dir, 'access-grants.json'), 'utf-8'));
  assert.equal(doc.revision, 2);
  assert.equal(doc.persistentGrants.length, 2);
  await stat(path.join(dir, 'access-grants.json')); // 落盘
  await dispose();
});

test('expectedRevision 冲突：旧卡迟到写入被拒（REVISION_CONFLICT）', async () => {
  const { svc, dispose } = await freshService();
  const base = svc.getState().revision;
  await svc.addApplication({ identityKey: 'com.a', displayName: 'A' }); // revision +1
  const out = await svc.addApplication({ identityKey: 'com.c', displayName: 'C', expectedRevision: base });
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'REVISION_CONFLICT');
  await dispose();
});

test('保存失败（新增类）：返回 PERSIST_FAILED，内存不授予、后续同资源操作继续可用', async () => {
  const { svc, dispose } = await freshService({
    fsHooks: { persistFailure: (op) => op.kind === 'add-app' },
  });
  const out = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'PERSIST_FAILED');
  assert.equal(svc.checkAccess({ taskId: 't', resourceId: svc.appResourceId('com.a') }).ok, false); // 未授予
  // 其他写入不受影响（新增失败不锁资源）：授权卡写同一应用照常落库
  const d = await svc.upsertCardGrant({ type: 'app', identityKey: 'com.a', capability: 'access' });
  assert.equal(d.ok, true);
  assert.equal(svc.checkAccess({ taskId: 't', resourceId: svc.appResourceId('com.a') }).ok, true);
  await dispose();
});

test('decide(persistent) 保存失败：保底本任务范围（taskFallback），不假报成功', async () => {
  const { svc, dispose } = await freshService({
    fsHooks: { persistFailure: (op) => op.kind === 'upsert-card-grant' },
  });
  const z = svc.noteResource({ type: 'app', identityKey: 'com.z', displayName: 'Z' }); // 发现态，未授权
  const { requestId: rid } = svc.createRequest({
    taskId: 't9', requirements: [{ resourceId: z.resourceId, capability: 'access' }],
  });
  const out = await svc.decide(rid, 'persistent');
  assert.equal(out.ok, true);
  assert.equal(out.effect, 'persistent-save-failed');
  assert.equal(out.taskFallback, true);
  // 本任务保底可用，其他任务不可用
  assert.equal(svc.checkAccess({ taskId: 't9', resourceId: z.resourceId }).ok, true);
  assert.equal(svc.checkAccess({ taskId: 'other', resourceId: z.resourceId }).ok, false);
  // 服务进入 write_failed 但 add-application 通道未被全局锁死
  assert.equal(svc.health, 'write_failed');
  await dispose();
});

test('保存失败（撤销类）：内存保持撤销（不恢复权限）＋锁定资源待重试', async () => {
  const { svc, dispose } = await freshService({
    fsHooks: { persistFailure: (op) => op.kind === 'revoke-resource' },
  });
  const app = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  const out = await svc.revokeResource({ resourceId: app.resourceId });
  assert.equal(out.ok, false);
  // 内存已撤销（更安全态），不能继续访问
  assert.equal(svc.checkAccess({ taskId: 't', resourceId: app.resourceId }).ok, false);
  // 锁定：该资源的新授权被拒
  const again = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  assert.equal(again.errorCode, 'PERSIST_FAILED');
  await dispose();
});

test('崩溃恢复：journal 里未完成的新增不授予（重载后无 grant、revision 前进）', async () => {
  const { svc, dir, dispose } = await freshService();
  const app = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  const before = JSON.parse(await readFile(path.join(dir, 'access-grants.json'), 'utf-8'));
  // 伪造崩溃：写 journal（准备记录）后没写快照
  await writeFile(path.join(dir, 'access-grants.json.journal'), `${JSON.stringify({
    id: 'x', baseRevision: before.revision,
    op: { kind: 'add-app', resourceId: 'app:com.ghost' },
  })}\n`);
  const svc2 = createPermissionService({ dir });
  await svc2.load();
  assert.equal(svc2.health, 'ready');
  assert.equal(svc2.checkAccess({ taskId: 't', resourceId: 'app:com.ghost' }).ok, false); // 未授予
  assert.equal(svc2.checkAccess({ taskId: 't', resourceId: app.resourceId }).ok, true); // 已提交的不受影响
  await dispose();
});

test('崩溃恢复：journal 里未完成的撤销按更严格结果恢复（重载后已撤销）', async () => {
  const { svc, dir, dispose } = await freshService();
  const app = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  const before = JSON.parse(await readFile(path.join(dir, 'access-grants.json'), 'utf-8'));
  await writeFile(path.join(dir, 'access-grants.json.journal'), `${JSON.stringify({
    id: 'x', baseRevision: before.revision,
    op: { kind: 'revoke-resource', resourceId: app.resourceId },
  })}\n`);
  const svc2 = createPermissionService({ dir });
  await svc2.load();
  assert.equal(svc2.health, 'ready');
  assert.equal(svc2.checkAccess({ taskId: 't', resourceId: app.resourceId }).ok, false); // 撤销生效（更严格）
  await dispose();
});

test('journal 残留但已提交（baseRevision 落后）：丢弃 journal，快照为准', async () => {
  const { svc, dir, dispose } = await freshService();
  const app = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  const before = JSON.parse(await readFile(path.join(dir, 'access-grants.json'), 'utf-8'));
  await writeFile(path.join(dir, 'access-grants.json.journal'), `${JSON.stringify({
    id: 'x', baseRevision: before.revision - 1, // 落后一版：说明那次已提交
    op: { kind: 'revoke-resource', resourceId: app.resourceId },
  })}\n`);
  const svc2 = createPermissionService({ dir });
  await svc2.load();
  assert.equal(svc2.checkAccess({ taskId: 't', resourceId: app.resourceId }).ok, true); // 以快照为准
  await dispose();
});

test('应用界面开关：关掉后 access 被拒（FEATURE_DISABLED），epoch 递增', async () => {
  const { svc, dispose } = await freshService();
  const app = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  const e1 = svc.resourceEpoch(app.resourceId);
  await svc.setUiEnabled({ resourceId: app.resourceId, enabled: false });
  assert.equal(svc.checkAccess({ taskId: 't', resourceId: app.resourceId }).errorCode, 'FEATURE_DISABLED');
  assert.equal(svc.resourceEpoch(app.resourceId), e1 + 1);
  await svc.setUiEnabled({ resourceId: app.resourceId, enabled: true });
  assert.equal(svc.checkAccess({ taskId: 't', resourceId: app.resourceId }).ok, true);
  await dispose();
});

test('onChange：每次成功提交广播 revision；订阅可取消', async () => {
  const { svc, dispose } = await freshService();
  const seen = [];
  const off = svc.onChange((e) => seen.push(e.revision));
  await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  await svc.addApplication({ identityKey: 'com.n', displayName: 'N' });
  assert.deepEqual(seen, [1, 2]);
  off();
  await svc.addApplication({ identityKey: 'com.m', displayName: 'M' });
  assert.equal(seen.length, 2);
  await dispose();
});

test('重启保留持续授权（正常路径）', async () => {
  const { svc, dir, dispose } = await freshService();
  const app = await svc.addApplication({ identityKey: 'com.tencent.xinWeChat', displayName: '微信' });
  const card = await svc.upsertCardGrant({ type: 'app', identityKey: 'com.b', displayName: 'B', capability: 'access' });
  await svc.setUiEnabled({ resourceId: card.resourceId, enabled: false });
  const svc2 = createPermissionService({ dir });
  await svc2.load();
  assert.equal(svc2.health, 'ready');
  assert.equal(svc2.checkAccess({ taskId: 'any', resourceId: app.resourceId }).ok, true);
  assert.equal(svc2.checkAccess({ taskId: 'any', resourceId: card.resourceId }).errorCode, 'FEATURE_DISABLED'); // 界面开关也保留
  assert.equal(svc2.getState().grants.length, 2);
  await dispose();
});

// ---------------------------------------------------------------- 评审修正批次

async function seededDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'hemi-psvc-'));
  const svc = createPermissionService({ dir });
  await svc.load();
  return { dir, svc, dispose: () => rm(dir, { recursive: true, force: true }) };
}

const readDoc = async (dir) => JSON.parse(await readFile(path.join(dir, 'access-grants.json'), 'utf-8'));

test('load 完成前的写：排在 load 之后，不从空表起草覆盖盘上数据', async () => {
  const { dir, svc, dispose } = await seededDir();
  await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  const svc2 = createPermissionService({ dir });
  const pending = svc2.addApplication({ identityKey: 'com.early', displayName: 'Early' }); // load 之前发起
  await svc2.load();
  const out = await pending;
  assert.equal(out.ok, true);
  const doc = await readDoc(dir);
  assert.equal(doc.persistentGrants.length, 2); // A 未被覆盖
  assert.ok(doc.resources['app:com.a']);
  await dispose();
});

test('从未 load：变更被拒（STORE_UNAVAILABLE），不落盘', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hemi-psvc-'));
  const svc = createPermissionService({ dir });
  const out = await svc.addApplication({ identityKey: 'com.a' });
  assert.equal(out.errorCode, 'STORE_UNAVAILABLE');
  await rm(dir, { recursive: true, force: true });
});

test('load 抛错：进入终态 unavailable（不停在 initializing），变更与检查都拒绝', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'hemi-psvc-'));
  const fileAsDir = path.join(base, 'not-a-dir');
  await writeFile(fileAsDir, 'x');
  const svc = createPermissionService({ dir: fileAsDir });
  await assert.rejects(svc.load());
  assert.equal(svc.health, 'unavailable');
  assert.equal((await svc.addApplication({ identityKey: 'com.a' })).errorCode, 'STORE_UNAVAILABLE');
  const r = svc.noteResource({ type: 'app', identityKey: 'com.a' });
  svc.grantTaskScope({ taskId: 't', resourceId: r.resourceId });
  assert.equal(svc.checkAccess({ taskId: 't', resourceId: r.resourceId }).errorCode, 'STORE_UNAVAILABLE');
  await rm(base, { recursive: true, force: true });
});

test('崩溃恢复（revoke-resource 多资源）：journal 里 resourceIds 全部撤销，恢复快照先落盘再删 journal', async () => {
  const { dir, svc, dispose } = await seededDir();
  const app = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
  const d = await svc.addApplication({ identityKey: 'com.b', displayName: 'B' });
  const before = await readDoc(dir);
  await writeFile(path.join(dir, 'access-grants.json.journal'), `${JSON.stringify({
    id: 'x', baseRevision: before.revision,
    op: { kind: 'revoke-resource', resourceId: app.resourceId, resourceIds: [app.resourceId, d.resourceId] },
  })}\n`);
  const svc2 = createPermissionService({ dir });
  await svc2.load();
  assert.equal(svc2.checkAccess({ taskId: 't', resourceId: d.resourceId }).ok, false);
  const after = await readDoc(dir);
  assert.equal(after.persistentGrants.length, 0); // 已耐久
  assert.equal(after.revision, before.revision + 1);
  await assert.rejects(stat(path.join(dir, 'access-grants.json.journal')));
  await dispose();
});

test('崩溃恢复：随附的未落盘撤销（关界面）按更严格恢复；本次未完成的新增不授予', async () => {
  const { dir, svc, dispose } = await seededDir();
  const app = await svc.addApplication({ identityKey: 'com.a' });
  const before = await readDoc(dir);
  await writeFile(path.join(dir, 'access-grants.json.journal'), `${JSON.stringify({
    id: 'x', baseRevision: before.revision,
    op: { kind: 'add-app', resourceId: 'app:com.ghost' },
    pendingRevokes: [{ kind: 'set-ui', resourceId: app.resourceId, enabled: false }],
  })}\n`);
  const svc2 = createPermissionService({ dir });
  await svc2.load();
  assert.equal(svc2.checkAccess({ taskId: 't', resourceId: app.resourceId }).errorCode, 'FEATURE_DISABLED');
  assert.equal(svc2.checkAccess({ taskId: 't', resourceId: 'app:com.ghost' }).ok, false);
  assert.equal((await readDoc(dir)).resources[app.resourceId].uiEnabled, false); // 已耐久
  await dispose();
});

test('撤销失败后崩溃：journal baseRevision 对齐盘上 revision，重启按更严格恢复', async () => {
  let fail = true;
  const { svc, dir, dispose } = await freshService({
    fsHooks: { persistFailure: (op) => fail && op.kind === 'revoke-resource' },
  });
  const app = await svc.addApplication({ identityKey: 'com.a' });
  const out = await svc.revokeResource({ resourceId: app.resourceId });
  assert.equal(out.ok, false);
  assert.equal(svc.getState().revision, 2); // 内存先行
  assert.equal((await readDoc(dir)).revision, 1); // 盘上未动
  const svc2 = createPermissionService({ dir }); // 模拟崩溃重启（journal 留盘）
  await svc2.load();
  assert.equal(svc2.checkAccess({ taskId: 't', resourceId: app.resourceId }).ok, false);
  fail = false;
  await dispose();
});

test('retrySave：撤销失败锁定的资源在重试成功后解锁，盘上落撤销结果', async () => {
  let fail = true;
  const { svc, dir, dispose } = await freshService({
    fsHooks: { persistFailure: (op) => fail && op.kind === 'revoke-resource' },
  });
  const app = await svc.addApplication({ identityKey: 'com.a' });
  await svc.revokeResource({ resourceId: app.resourceId });
  assert.equal(svc.health, 'write_failed');
  assert.deepEqual(svc.getState().lockedResourceIds, [app.resourceId]);
  fail = false;
  const r = await svc.retrySave();
  assert.equal(r.ok, true);
  assert.equal(svc.health, 'ready');
  assert.deepEqual(svc.getState().lockedResourceIds, []);
  const doc = await readDoc(dir);
  assert.equal(doc.persistentGrants.length, 0);
  assert.equal(doc.revision, svc.getState().revision);
  assert.equal((await svc.addApplication({ identityKey: 'com.a' })).ok, true); // 解锁
  await dispose();
});

test('upsertCardGrant：已有资源追加 card grant；再次请求复用同一份；不碰 settings grant、不重置资源', async () => {
  const { svc, dir, dispose } = await freshService();
  const settings = await svc.addApplication({ identityKey: 'com.x', displayName: 'X', ownedRoots: ['/private/tmp/x'] });
  await svc.revokeResource({ resourceId: settings.resourceId }); // epoch → 1
  const s2 = await svc.addApplication({ identityKey: 'com.x', displayName: 'X' });
  const epoch = svc.resourceEpoch(s2.resourceId);
  const a = await svc.upsertCardGrant({ type: 'app', identityKey: 'com.x', capability: 'access' });
  assert.equal(a.ok, true);
  const c = await svc.upsertCardGrant({ type: 'app', identityKey: 'com.x', capability: 'access' });
  assert.equal(c.grantId, a.grantId); // 同一份 card grant，不重复新增
  const doc = await readDoc(dir);
  const grants = doc.persistentGrants.filter((g) => g.resourceId === s2.resourceId);
  assert.deepEqual(grants.map((g) => [g.source, g.capability]).sort(), [['card', 'access'], ['settings', 'access']]);
  assert.equal(doc.resources[s2.resourceId].epoch, epoch);
  assert.deepEqual(doc.resources[s2.resourceId].ownedRoots, ['/private/tmp/x']); // 不重置资源
  // 新资源 + app
  const app = await svc.upsertCardGrant({ type: 'app', identityKey: 'com.b', displayName: 'B', capability: 'access' });
  assert.equal(app.ok, true);
  assert.equal(svc.checkAccess({ taskId: 'any', resourceId: 'app:com.b' }).ok, true);
  assert.equal((await svc.upsertCardGrant({ type: 'app', identityKey: 'com.b', capability: 'edit' })).errorCode, 'UNSUPPORTED_CAPABILITY');
  // 文件夹授权已退役：dir 类型一律 INVALID_INPUT
  assert.equal((await svc.upsertCardGrant({ type: 'dir', canonicalRoot: '/private/tmp/cg', capability: 'access' })).errorCode, 'INVALID_INPUT');
  await dispose();
});

test('removeGrant：任务临时 grant 真删除；未知 grant 返回 UNKNOWN_GRANT', async () => {
  const { svc, dispose } = await freshService();
  const r = svc.noteResource({ type: 'app', identityKey: 'com.tg' });
  const { grantId } = svc.grantTaskScope({ taskId: 't1', resourceId: r.resourceId, capability: 'access' });
  const out = await svc.removeGrant({ grantId });
  assert.equal(out.ok, true);
  assert.equal(svc.checkAccess({ taskId: 't1', resourceId: r.resourceId }).ok, false);
  assert.equal((await svc.removeGrant({ grantId })).errorCode, 'UNKNOWN_GRANT');
  await dispose();
});

test('getState：无 taskId 不含任务 grant；带 taskId 含本任务 grant 与其引用的发现态资源', async () => {
  const { svc, dispose } = await freshService();
  await svc.addApplication({ identityKey: 'com.a' });
  const r = svc.noteResource({ type: 'app', identityKey: 'com.disc', displayName: '发现态' });
  svc.grantTaskScope({ taskId: 't1', resourceId: r.resourceId });
  const settings = svc.getState();
  assert.equal(settings.grants.length, 1);
  assert.ok(!settings.resources.some((x) => x.resourceId === r.resourceId));
  const t1 = svc.getState('t1');
  assert.equal(t1.grants.length, 2);
  assert.equal(t1.resources.find((x) => x.resourceId === r.resourceId)?.displayName, '发现态');
  assert.equal(svc.getState('t2').grants.length, 1);
  await dispose();
});

test('notify：任务临时授权、cleanupTask 都广播', async () => {
  const { svc, dispose } = await freshService();
  const seen = [];
  svc.onChange((e) => seen.push(e.op.kind));
  const r = svc.noteResource({ type: 'app', identityKey: 'com.nt' });
  svc.grantTaskScope({ taskId: 't1', resourceId: r.resourceId });
  svc.cleanupTask('t1');
  svc.cleanupTask('t1'); // 无变化不广播
  assert.deepEqual(seen, ['grant-task-scope', 'cleanup-task']);
  await dispose();
});

test('setUiEnabled／noteResource：非应用或未落库返回错误码（不抛）', async () => {
  const { svc, dispose } = await freshService();
  const disc = svc.noteResource({ type: 'app', identityKey: 'com.only-disc' });
  assert.equal((await svc.setUiEnabled({ resourceId: disc.resourceId, enabled: false })).errorCode, 'UNKNOWN_RESOURCE');
  assert.equal((await svc.setUiEnabled({ resourceId: 'dir:/private/tmp/sd', enabled: false })).errorCode, 'UNKNOWN_RESOURCE');
  assert.deepEqual(svc.noteResource({ type: 'dir', canonicalRoot: '/private/tmp/sd' }), { ok: false, errorCode: 'INVALID_INPUT' });
  assert.equal(svc.storeDir.length > 0, true);
  await dispose();
});

test('withoutDirectoryGrants：去掉 dir: 资源与授权，保留应用，不改入参', async () => {
  const { withoutDirectoryGrants } = await import('./permission-service.mjs');
  const input = {
    revision: 3,
    resources: { 'app:com.a': { type: 'app' }, 'dir:/x': { type: 'dir' } },
    persistentGrants: [{ grantId: 'g1', resourceId: 'app:com.a' }, { grantId: 'g2', resourceId: 'dir:/x' }],
  };
  const out = withoutDirectoryGrants(input);
  assert.deepEqual(Object.keys(out.resources), ['app:com.a']);
  assert.deepEqual(out.persistentGrants.map((g) => g.grantId), ['g1']);
  assert.equal(out.revision, 3);
  assert.equal(Object.keys(input.resources).length, 2); // 入参未被改写
});

test('056 对话级授权：落在对话范围的临时授权，对话内各任务都可见；清对话范围即失效', async () => {
  const { svc, dispose } = await freshService();
  try {
    const r = svc.noteResource({ type: 'app', identityKey: 'com.proj', displayName: 'Proj' });
    svc.grantTaskScope({ taskId: 'conv-a', resourceId: r.resourceId, capability: 'access' });
    assert.equal(svc.checkAccess({ taskId: ['task-1', 'conv-a'], resourceId: r.resourceId }).ok, true);
    assert.equal(svc.checkAccess({ taskId: ['task-2', 'conv-a'], resourceId: r.resourceId }).ok, true);
    assert.equal(svc.checkAccess({ taskId: ['task-3', 'conv-b'], resourceId: r.resourceId }).ok, false, '别的对话不可见');
    assert.equal(svc.getState(['task-1', 'conv-a']).grants.length, 1);
    svc.cleanupTask('task-1'); // 子 agent 终态只清自己
    assert.equal(svc.checkAccess({ taskId: ['task-2', 'conv-a'], resourceId: r.resourceId }).ok, true);
    svc.cleanupTask('conv-a');
    assert.equal(svc.checkAccess({ taskId: ['task-2', 'conv-a'], resourceId: r.resourceId }).ok, false);
  } finally { await dispose(); }
});

test('文件夹授权退役：盘上旧库含 dir: 资源与授权 → 加载后只剩应用；下次写入落盘不再含 dir:', async () => {
  const { dir, svc, dispose } = await seededDir();
  try {
    const app = await svc.addApplication({ identityKey: 'com.a', displayName: 'A' });
    const doc = await readDoc(dir);
    doc.resources['dir:/private/tmp/old'] = {
      type: 'dir', resourceId: 'dir:/private/tmp/old', canonicalRoot: '/private/tmp/old', epoch: 0,
    };
    doc.persistentGrants.push({
      grantId: 'g-old', resourceId: 'dir:/private/tmp/old', capability: 'edit', lifetime: 'persistent', source: 'settings',
    });
    await writeFile(path.join(dir, 'access-grants.json'), JSON.stringify(doc));
    const svc2 = createPermissionService({ dir });
    await svc2.load();
    assert.equal(svc2.health, 'ready');
    const st = svc2.getState();
    assert.deepEqual(st.resources.map((r) => r.resourceId), [app.resourceId]);
    assert.deepEqual(st.grants.map((g) => g.resourceId), [app.resourceId]);
    assert.equal(svc2.checkAccess({ taskId: 't', resourceId: 'dir:/private/tmp/old' }).errorCode, 'UNKNOWN_RESOURCE');
    assert.ok((await readDoc(dir)).resources['dir:/private/tmp/old'], '只改内存，加载不迁移写');
    assert.equal((await svc2.addApplication({ identityKey: 'com.b', displayName: 'B' })).ok, true);
    const after = await readDoc(dir);
    assert.ok(!Object.keys(after.resources).some((id) => id.startsWith('dir:')));
    assert.ok(!after.persistentGrants.some((g) => g.resourceId.startsWith('dir:')));
    assert.deepEqual(Object.keys(after.resources).sort(), ['app:com.a', 'app:com.b']);
  } finally { await dispose(); }
});
