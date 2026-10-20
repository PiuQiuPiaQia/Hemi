// 033 工作区登记单测：默认工作区固定身份、项目 realpath 去重、移除不删盘、
// 失效如实标注不猜测替代、最近使用排序与容量裁剪、登记表损坏按空表起步。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_WORKSPACE_ID,
  createWorkspaceStore,
  defaultWorkspaceDir,
} from './workspace-store.mjs';

function makeEnv() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hemi-workspace-'));
  // dataRoot 模拟 userData（默认工作区定位根，ZCode 口径 workspace/default）。
  const dataRoot = path.join(root, 'user-data');
  mkdirSync(dataRoot);
  const filePath = path.join(root, 'workspaces.json');
  return { root, dataRoot, filePath };
}

test('默认工作区：固定身份 + 数据根下 workspace/default（ZCode 口径），ensureDefault 幂等', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const store = createWorkspaceStore({ filePath, dataRoot });
    // 应用数据根下的 workspace/default；界面名称是中文映射（2026-10-01 用户裁决）。
    assert.equal(defaultWorkspaceDir(dataRoot), path.join(dataRoot, 'workspace', 'default'));
    // 初次未创建：状态如实标 missing（不假装可用）。
    let state = store.getState();
    assert.equal(state.default.id, DEFAULT_WORKSPACE_ID);
    assert.equal(state.default.type, 'default');
    assert.equal(state.default.name, '默认空间');
    assert.equal(state.default.status, 'missing');
    // 按需创建后转 ok，目录为 realpath 归一（macOS tmpdir 的 /private 前缀）。
    assert.equal(store.ensureDefault().ok, true);
    state = store.getState();
    assert.equal(state.default.status, 'ok');
    assert.equal(state.default.dir, realpathSync(defaultWorkspaceDir(dataRoot)));
    // 再次 ensure 幂等。
    assert.equal(store.ensureDefault().ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('addProject：登记 id/名称/路径；resolve 与 getState 可见', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const project = path.join(dataRoot, 'Projects', 'Atlas');
    mkdirSync(project, { recursive: true });
    const store = createWorkspaceStore({ filePath, dataRoot });
    const result = store.addProject(project);
    assert.equal(result.ok, true);
    assert.equal(result.deduped, undefined);
    assert.equal(result.workspace.name, 'Atlas');
    assert.equal(result.workspace.dir, realpathSync(project));
    assert.match(result.workspace.id, /^ws-/);
    assert.equal(store.resolve(result.workspace.id).name, 'Atlas');
    assert.equal(store.getState().projects.length, 1);
    // 相对路径与非目录拒绝。
    assert.equal(store.addProject('relative/path').ok, false);
    writeFileSync(path.join(dataRoot, 'afile.txt'), 'x');
    assert.equal(store.addProject(path.join(dataRoot, 'afile.txt')).ok, false);
    assert.equal(store.addProject(path.join(dataRoot, 'nope')).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('addProject：同一路径与符号链接别名去重（返回既有身份）', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const project = path.join(dataRoot, 'Projects', 'Studio');
    mkdirSync(project, { recursive: true });
    const alias = path.join(dataRoot, 'studio-link');
    symlinkSync(project, alias);
    const store = createWorkspaceStore({ filePath, dataRoot });
    const first = store.addProject(project);
    const again = store.addProject(project); // 原路径重复
    const viaLink = store.addProject(alias); // 别名（realpath 后同源）
    assert.equal(again.ok && again.deduped, true);
    assert.equal(viaLink.ok && viaLink.deduped, true);
    assert.equal(again.workspace.id, first.workspace.id);
    assert.equal(viaLink.workspace.id, first.workspace.id);
    assert.equal(store.getState().projects.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removeProject：只摘列表不删磁盘；移除后 resolve 不再命中', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const project = path.join(dataRoot, 'Projects', 'Keep');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'data.txt'), 'x');
    const store = createWorkspaceStore({ filePath, dataRoot });
    const { workspace } = store.addProject(project);
    assert.equal(store.removeProject(workspace.id).ok, true);
    assert.equal(store.resolve(workspace.id), null);
    assert.equal(store.getState().projects.length, 0);
    assert.ok(existsSync(path.join(project, 'data.txt')), '移除列表项不得删除磁盘文件');
    assert.equal(store.removeProject(workspace.id).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录失效：删除后如实标 missing + 原因；不猜测替代目录', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const project = path.join(dataRoot, 'External', 'Disk');
    mkdirSync(project, { recursive: true });
    const store = createWorkspaceStore({ filePath, dataRoot });
    const { workspace } = store.addProject(project);
    assert.equal(store.resolve(workspace.id).status, 'ok');
    rmSync(project, { recursive: true, force: true });
    const after = store.resolve(workspace.id);
    assert.equal(after.status, 'missing');
    assert.ok(after.message, '失效要带可展示原因');
    assert.equal(after.dir, workspace.dir, '失效时保留原路径，不替换成别的目录');
    // 重新出现（如外接盘重新挂载）自动恢复 ok——状态实时探测不缓存。
    mkdirSync(project, { recursive: true });
    assert.equal(store.resolve(workspace.id).status, 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('touch：项目绑定刷新最近使用（列表按新→旧排）；默认工作区 no-op', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const a = path.join(dataRoot, 'pa');
    const b = path.join(dataRoot, 'pb');
    mkdirSync(a);
    mkdirSync(b);
    const store = createWorkspaceStore({ filePath, dataRoot });
    const wa = store.addProject(a, { at: 1000 }).workspace;
    const wb = store.addProject(b, { at: 2000 }).workspace;
    // b 更新（2000 > 1000）在前；touch a 后 a 置顶。
    assert.equal(store.getState().projects[0].id, wb.id);
    assert.equal(store.touch(wa.id, { at: 3000 }).ok, true);
    assert.equal(store.getState().projects[0].id, wa.id);
    assert.equal(store.touch(DEFAULT_WORKSPACE_ID).ok, true);
    assert.equal(store.touch('ws-nope').ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('持久化与重启：登记跨实例保留；损坏按空表起步并标注 corrupt', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const project = path.join(dataRoot, 'persist');
    mkdirSync(project);
    const first = createWorkspaceStore({ filePath, dataRoot });
    const { workspace } = first.addProject(project);
    const second = createWorkspaceStore({ filePath, dataRoot });
    assert.equal(second.resolve(workspace.id).name, 'persist');
    writeFileSync(filePath, '{broken json', 'utf8');
    const third = createWorkspaceStore({ filePath, dataRoot });
    assert.equal(third.getState().corrupt, true);
    assert.equal(third.getState().projects.length, 0);
    assert.equal(third.getState().default.id, DEFAULT_WORKSPACE_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('容量裁剪：超过上限裁最旧，新加的必留', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const store = createWorkspaceStore({ filePath, dataRoot });
    for (let index = 0; index < 25; index += 1) {
      const dir = path.join(dataRoot, `p${index}`);
      mkdirSync(dir);
      store.addProject(dir, { at: 1000 + index });
    }
    const state = store.getState();
    assert.equal(state.projects.length, 20);
    // 最新（p24）保留，最旧（p0）被裁。
    assert.ok(state.projects.some((item) => item.name === 'p24'));
    assert.ok(!state.projects.some((item) => item.name === 'p0'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 049 · 远端工作区（SSH）登记 ----

test('049 addRemote：登记带 host/remoteHome；同主机同路径去重；本机同名路径不算重复', { skip: process.platform === 'win32' ? '「本机路径登记远端不与本地互为别名」的构造要求本机路径是 POSIX 绝对路径：win 盘符路径本就不可能是远端目录' : false }, () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const store = createWorkspaceStore({ filePath, dataRoot });
    const added = store.addRemote({ host: 'devbox', dir: '/home/u/projects/atlas', remoteHome: '/home/u', at: 2000 });
    assert.equal(added.ok, true);
    assert.equal(added.workspace.host, 'devbox');
    assert.equal(added.workspace.remoteHome, '/home/u');
    assert.equal(added.workspace.dir, '/home/u/projects/atlas');
    assert.equal(added.workspace.status, 'ok'); // 登记即探测通过（缓存起步 ok）

    const again = store.addRemote({ host: 'devbox', dir: '/home/u/projects/atlas', at: 3000 });
    assert.equal(again.ok, true);
    assert.equal(again.deduped, true);
    assert.equal(again.workspace.id, added.workspace.id);

    // R-04：不同主机的同名路径是两个项目；本机同名字符串路径也不与远端互为别名——
    // 用一个真实存在的本机目录字符串登记远端条目，再以本机身份添加，不得去重。
    const other = store.addRemote({ host: 'buildbox', dir: '/home/u/projects/atlas', at: 4000 });
    assert.equal(other.ok, true);
    assert.notEqual(other.workspace.id, added.workspace.id);
    const twin = path.join(dataRoot, 'twin');
    mkdirSync(twin, { recursive: true });
    const remoteTwin = store.addRemote({ host: 'devbox', dir: twin, at: 4500 });
    assert.equal(remoteTwin.ok, true);
    const localTwin = store.addProject(twin, { at: 5000 });
    assert.equal(localTwin.ok, true);
    assert.equal(localTwin.deduped, undefined);
    assert.notEqual(localTwin.workspace.id, remoteTwin.workspace.id);
    assert.equal(store.getState().projects.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('049 远端条目：状态走探测缓存（不碰本机文件系统）；落盘重启后仍在、旧档无 host＝本机', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const store = createWorkspaceStore({ filePath, dataRoot });
    const remote = store.addRemote({ host: 'devbox', dir: '/srv/app', at: 1000 }).workspace;
    // 本机不存在的 /srv/app 不会被判 missing（远端状态只认缓存）。
    assert.equal(store.resolve(remote.id).status, 'ok');
    store.setRemoteStatus(remote.id, { status: 'missing', message: 'Connection to devbox timed out' });
    const missing = store.resolve(remote.id);
    assert.equal(missing.status, 'missing');
    assert.equal(missing.message, 'Connection to devbox timed out');
    // 恢复。
    store.setRemoteStatus(remote.id, { status: 'ok' });
    assert.equal(store.resolve(remote.id).status, 'ok');

    // 落盘 → 重启读回（远端条目带 host；缓存清零后按 ok 起步）。
    const reborn = createWorkspaceStore({ filePath, dataRoot });
    const view = reborn.resolve(remote.id);
    assert.equal(view.host, 'devbox');
    assert.equal(view.dir, '/srv/app');
    assert.equal(view.status, 'ok');
    // 本机条目不受影响；旧档（无 host）按本机解析。
    mkdirSync(path.join(dataRoot, 'localp'), { recursive: true });
    reborn.addProject(path.join(dataRoot, 'localp'), { at: 2000 });
    const local = createWorkspaceStore({ filePath, dataRoot }).getState().projects.find((item) => !item.host);
    assert.ok(local);
    assert.equal(local.host, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('049 removeProject：远端条目移除只删登记（状态缓存一并清）', () => {
  const { root, dataRoot, filePath } = makeEnv();
  try {
    const store = createWorkspaceStore({ filePath, dataRoot });
    const remote = store.addRemote({ host: 'devbox', dir: '/srv/app', at: 1000 }).workspace;
    assert.equal(store.removeProject(remote.id).ok, true);
    assert.equal(store.resolve(remote.id), null);
    const reborn = createWorkspaceStore({ filePath, dataRoot });
    assert.equal(reborn.getState().projects.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
