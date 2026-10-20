import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { createAccessContext } from './access-context.mjs';
import { judgeAccess } from './access-policy.mjs';

// 2026-10-08 会话审计（第 10 轮）：默认工作区 userData/workspace/default（033 单数
// 布局）曾被控制面豁免的复数死路径（storeDir/workspaces，磁盘上不存在）漏掉，
// 整棵落进控制面——042 起默认空间任务的文件工具全被「Hemi 自身的控制文件」硬拒，
// 只读核实读不回交付文件（prod/dev 真机实录）。本文件钉死豁免边界。

const HOME = '/fake/home';
const STORE = path.join(HOME, 'Library', 'Hemi');
const WS = path.join(STORE, 'workspace', 'default');

function makeService() {
  const calls = { noted: [], granted: [] };
  const resources = new Map();
  return {
    storeDir: STORE,
    calls,
    noteResource: (r) => { resources.set(r.canonicalRoot ?? r.identityKey, r); calls.noted.push(r); },
    grantTaskScope: ({ resourceId, capability }) => { calls.granted.push({ resourceId, capability }); return { ok: true }; },
    listDiscoveredResources: () => [],
    getState: () => ({ resources: [...resources.values()], grants: [] }),
    checkAccess: () => ({ ok: true }),
    upsertCardGrant: async () => ({ ok: true }),
  };
}

test('默认工作区不属控制面；控制面本体（授权库/配置/记忆）照旧硬拒', () => {
  const ctx = createAccessContext({ service: makeService(), taskId: 't1', home: HOME, workspaceDir: WS, cwd: WS });
  assert.equal(ctx.isControlPath(WS), false);
  assert.equal(ctx.isControlPath(path.join(WS, '北京_明日天气_2026-10-08.md')), false);
  assert.equal(ctx.isControlPath(path.join(STORE, 'access-grants.json')), true);
  assert.equal(ctx.isControlPath(path.join(STORE, 'text-model.json')), true);
  // 记忆底稿（含记忆库自己的 workspaces 子目录）仍是控制面。
  assert.equal(ctx.isControlPath(path.join(STORE, 'memory', 'workspaces', 'ws-x', 'MEMORY.md')), true);
  // 登记表文件与工作区根只差一个后缀，不得被前缀匹配误豁免。
  assert.equal(ctx.isControlPath(path.join(STORE, 'workspaces.json')), true);
});

test('工作区自动 edit 授权不再被控制面前置检查作废；verify 读回交付＝allow', async () => {
  const service = makeService();
  const ctx = createAccessContext({ service, taskId: 't1', home: HOME, workspaceDir: WS, cwd: WS });
  assert.deepEqual(ctx.scopeForPath(path.join(WS, '交付.md')), { kind: 'workspace', capability: 'edit' });
  const q = {
    resolvePath: (raw) => ({ real: path.join(WS, '交付.md'), raw }),
    deniedPath: () => null,
    isControlPath: (p) => ctx.isControlPath(p),
    scopeForPath: (p) => ctx.scopeForPath(p),
  };
  const readVerdict = await judgeAccess({ tool: 'read', input: { path: './交付.md' }, phase: 'verify', q });
  assert.equal(readVerdict.verdict, 'allow');
  // run 态写自家工作区同样恢复 allow（此前 HARDLINE deny，连授权卡都不给）。
  const writeVerdict = await judgeAccess({ tool: 'write', input: { path: './out.md' }, phase: 'run', q });
  assert.equal(writeVerdict.verdict, 'allow');
  // 控制面文件在 verify 态依旧拒（豁免不是整棵 userData 开洞）。
  const controlVerdict = await judgeAccess({
    tool: 'read',
    input: { path: path.join(STORE, 'access-grants.json') },
    phase: 'verify',
    q: {
      ...q,
      resolvePath: (raw) => ({ real: path.join(STORE, 'access-grants.json'), raw }),
    },
  });
  assert.equal(controlVerdict.verdict, 'deny');
  assert.equal(controlVerdict.reasonCode, 'HARDLINE');
  // 060：结构化文件工具保留控制面硬拒；任意命令不再声明 OS 文件隔离。
});

test('项目工作区（userData 外）不受豁免影响，行为不变', () => {
  const project = path.join(HOME, 'Projects', 'Hemi');
  const ctx = createAccessContext({ service: makeService(), taskId: 't2', home: HOME, workspaceDir: project, cwd: project });
  assert.equal(ctx.isControlPath(path.join(project, 'package.json')), false);
  assert.equal(ctx.isControlPath(path.join(STORE, 'access-grants.json')), true);
  assert.deepEqual(ctx.scopeForPath(path.join(project, 'README.md')), { kind: 'workspace', capability: 'edit' });
});

// 2026-10-10 会话审计（第 12 轮）：034 Skill 的相对资源（references/scripts）落在
// userData 控制面内，042 起 read/ls 全被「控制文件」硬拒、沙箱 readDirs 也不含它——
// 八字 skill 任务（dev task-4-mv1zzmvu）只能违反 skill 契约自行口算排盘。修＝任务
// 受理时冻结的租约目录开只读面。本组钉死：租约内可读、租约外同级版本仍拒、
// 只读档不可被授权升成可写、沙箱只进读面。

test('Skill 租约：租约内目录不属控制面、scopeForPath 返只读档；未租约的同级版本目录照拒', { skip: process.platform === 'win32' ? '路径桩 /fake/home 在 win 被 path.resolve 挂盘符、与断言原串对不上；沙箱读面口径同 file-tools 的 Skill 租约用例（mac 实现）' : false }, () => {
  const leased = path.join(STORE, 'skills', 'versions', 'bazi_x', 'aa842809');
  const sibling = path.join(STORE, 'skills', 'versions', 'bazi_x', 'deadbeef00');
  const ctx = createAccessContext({
    service: makeService(), taskId: 't3', home: HOME, workspaceDir: WS, cwd: WS,
    skillRoots: [leased],
  });
  assert.equal(ctx.isControlPath(path.join(leased, 'SKILL.md')), false);
  assert.equal(ctx.isControlPath(path.join(leased, 'references', 'wuxing-tables.md')), false);
  assert.deepEqual(ctx.scopeForPath(path.join(leased, 'references', 'wuxing-tables.md')), { kind: 'skill-lease', capability: 'access' });
  // 未租约的同版本目录与 skills 根本体：仍是控制面。
  assert.equal(ctx.isControlPath(path.join(sibling, 'SKILL.md')), true);
  assert.equal(ctx.isControlPath(path.join(STORE, 'skills', 'index.json')), true);
  assert.equal(ctx.scopeForPath(path.join(sibling, 'SKILL.md')), null);
  // 租约约束由文件工具与门控执行；直接命令不作 OS 隔离保证。
});

test('Skill 租约只读不可被授权升级：覆盖租约根的目录 grant 不改变 access 档', () => {
  const leased = path.join(STORE, 'skills', 'versions', 'bazi_x', 'aa842809');
  const service = makeService();
  const resources = new Map([[`dir:${STORE}`, { type: 'dir', canonicalRoot: STORE }]]);
  service.getState = () => ({ resources: [...resources.values()], grants: [{ grantId: 'g1', resourceId: `dir:${STORE}`, capability: 'edit' }] });
  const ctx = createAccessContext({
    service, taskId: 't4', home: HOME, workspaceDir: WS, cwd: WS,
    skillRoots: [leased],
  });
  // edit 级 grant 盖着整个 storeDir，租约内仍必须是 access 档（早返回先于 grant 扫描）。
  assert.deepEqual(ctx.scopeForPath(path.join(leased, 'scripts', 'pai_pan.py')), { kind: 'skill-lease', capability: 'access' });
  // 工作区路径不受租约影响（workspace 档照旧 edit）。
  assert.deepEqual(ctx.scopeForPath(path.join(WS, '交付.md')), { kind: 'workspace', capability: 'edit' });
});

test('056 并行授权卡合并：同一对话范围、同一资源的并发请求只问一次，其余等同一结果；不同对话各问各的', async () => {
  const service = makeService();
  const a1 = createAccessContext({ service, taskId: 't1', grantScopeId: 'conv-a', home: HOME, workspaceDir: null, cwd: HOME });
  const a2 = createAccessContext({ service, taskId: 't2', grantScopeId: 'conv-a', home: HOME, workspaceDir: null, cwd: HOME });
  const b1 = createAccessContext({ service, taskId: 't3', grantScopeId: 'conv-b', home: HOME, workspaceDir: null, cwd: HOME });
  let asked = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ask = () => { asked += 1; return gate; };
  const p1 = a1.sharedGrantPrompt('dir:/data:access', ask);
  const p2 = a2.sharedGrantPrompt('dir:/data:access', ask);
  const p3 = b1.sharedGrantPrompt('dir:/data:access', () => { asked += 1; return Promise.resolve('拒绝'); });
  release('本任务允许');
  assert.deepEqual(await Promise.all([p1, p2, p3]), ['本任务允许', '本任务允许', '拒绝']);
  assert.equal(asked, 2, 'conv-a 一张卡＋conv-b 一张卡');
  // 在途结束后再请求会重新问（不缓存选择本身，授权由 grant 表承载）。
  await a1.sharedGrantPrompt('dir:/data:access', () => { asked += 1; return Promise.resolve('本任务允许'); });
  assert.equal(asked, 3);
});
