// 066 · workspace-open 单测：平台分支全注入（真实 shell/spawn 不碰），
// mac 实例上同样覆盖 win32/linux 分支（platform 参数化）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createWorkspaceOpener, normalizeOpenTarget, WORKSPACE_OPEN_TARGETS } from './workspace-open.mjs';

/** 假 spawn：script(command,args,options) 返回 {code} 或 {error}；记录调用。 */
function fakeSpawn(script) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    const behavior = script(command, args, options) ?? { code: 0 };
    queueMicrotask(() => {
      if (behavior.error) child.emit('error', new Error(behavior.error));
      else child.emit('close', behavior.code ?? 0);
    });
    return child;
  };
  return { fn, calls };
}

const openPathOk = async () => '';
const openPathFail = async () => '应用不存在';

test('normalizeOpenTarget：未知值回落 finder，合法值透传', () => {
  assert.equal(normalizeOpenTarget('terminal'), 'terminal');
  assert.equal(normalizeOpenTarget('vscode'), 'vscode');
  assert.equal(normalizeOpenTarget('finder'), 'finder');
  assert.equal(normalizeOpenTarget('bogus'), 'finder');
  assert.equal(normalizeOpenTarget(undefined), 'finder');
  assert.deepEqual(WORKSPACE_OPEN_TARGETS, ['finder', 'terminal', 'vscode']);
});

test('darwin finder：openPath 成功返回空串、失败带错误文案', async () => {
  const ok = createWorkspaceOpener({ platform: 'darwin', openPath: openPathOk });
  assert.deepEqual(await ok.openDir('finder', '/tmp/p'), { ok: true });

  const fail = createWorkspaceOpener({ platform: 'darwin', openPath: openPathFail });
  const result = await fail.openDir('finder', '/tmp/p');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'open-failed');
  assert.match(result.message, /文件管理器没打开/);
});

test('darwin terminal：spawn open -a Terminal 带目录参数', async () => {
  const { fn, calls } = fakeSpawn(() => ({ code: 0 }));
  const opener = createWorkspaceOpener({ platform: 'darwin', openPath: openPathOk, spawnFn: fn });
  assert.deepEqual(await opener.openDir('terminal', '/tmp/proj'), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'open');
  assert.deepEqual(calls[0].args, ['-a', 'Terminal', '/tmp/proj']);
});

test('darwin terminal：spawn 失败如实报 open-failed', async () => {
  const { fn } = fakeSpawn(() => ({ error: 'ENOENT' }));
  const opener = createWorkspaceOpener({ platform: 'darwin', openPath: openPathOk, spawnFn: fn });
  const result = await opener.openDir('terminal', '/tmp/proj');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'open-failed');
});

test('darwin vscode：open -a 失败后回落 CLI 候选，全失败报 not-found', async () => {
  const { fn, calls } = fakeSpawn((command) => (command === 'open' ? { code: 1 } : { code: 0 }));
  const opener = createWorkspaceOpener({ platform: 'darwin', openPath: openPathOk, spawnFn: fn });
  assert.deepEqual(await opener.openDir('vscode', '/tmp/proj'), { ok: true });
  assert.deepEqual(
    calls.map((call) => call.command),
    ['open', '/usr/local/bin/code'],
  );

  const { fn: none } = fakeSpawn(() => ({ error: 'ENOENT' }));
  const failOpener = createWorkspaceOpener({ platform: 'darwin', openPath: openPathOk, spawnFn: none });
  const result = await failOpener.openDir('vscode', '/tmp/proj');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'not-found');
  assert.match(result.message, /没找到 VS Code/);
});

test('win32 terminal：wt.exe 优先，失败退 cmd.exe 新控制台（cwd=工作区）', async () => {
  const { fn, calls } = fakeSpawn((command) => (command === 'wt.exe' ? { error: 'ENOENT' } : { code: 0 }));
  const opener = createWorkspaceOpener({ platform: 'win32', openPath: openPathOk, spawnFn: fn });
  assert.deepEqual(await opener.openDir('terminal', 'C:\\Users\\me\\proj'), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['-d', 'C:\\Users\\me\\proj']);
  assert.equal(calls[1].command, 'cmd.exe');
  assert.deepEqual(calls[1].args, ['/k']);
  assert.equal(calls[1].options.cwd, 'C:\\Users\\me\\proj');
  assert.equal(calls[1].options.detached, true);
});

test('win32 terminal：wt 与 cmd 都失败如实报错', async () => {
  const { fn } = fakeSpawn(() => ({ error: 'ENOENT' }));
  const opener = createWorkspaceOpener({ platform: 'win32', openPath: openPathOk, spawnFn: fn });
  const result = await opener.openDir('terminal', 'C:\\proj');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'open-failed');
});

test('win32 vscode：按 LOCALAPPDATA/ProgramFiles 探测 Code.exe，全无再试 PATH 的 code', async () => {
  const { fn, calls } = fakeSpawn((command) => (command.endsWith('Code.exe') ? { error: 'ENOENT' } : { code: 0 }));
  const opener = createWorkspaceOpener({
    platform: 'win32',
    openPath: openPathOk,
    spawnFn: fn,
    env: {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    },
  });
  assert.deepEqual(await opener.openDir('vscode', 'C:\\proj'), { ok: true });
  assert.deepEqual(
    calls.map((call) => call.command),
    [
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
      'cmd.exe',
    ],
  );
  assert.deepEqual(calls[3].args, ['/d', '/c', 'code', 'C:\\proj']);
});

test('win32 vscode：所有路径都没有时报 not-found', async () => {
  const { fn } = fakeSpawn(() => ({ error: 'ENOENT' }));
  const opener = createWorkspaceOpener({ platform: 'win32', openPath: openPathOk, spawnFn: fn, env: {} });
  const result = await opener.openDir('vscode', 'C:\\proj');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'not-found');
});

test('win32 finder：走 openPath（资源管理器），不经 spawn', async () => {
  const { fn, calls } = fakeSpawn(() => ({ code: 0 }));
  const opener = createWorkspaceOpener({ platform: 'win32', openPath: openPathOk, spawnFn: fn });
  assert.deepEqual(await opener.openDir('finder', 'C:\\proj'), { ok: true });
  assert.equal(calls.length, 0);
});

test('linux 分支（非发行目标）：终端候选逐个尝试，finder 走 openPath', async () => {
  const { fn, calls } = fakeSpawn((command) => (command === 'konsole' ? { code: 0 } : { error: 'ENOENT' }));
  const opener = createWorkspaceOpener({ platform: 'linux', openPath: openPathOk, spawnFn: fn });
  assert.deepEqual(await opener.openDir('terminal', '/home/me/proj'), { ok: true });
  assert.deepEqual(
    calls.map((call) => call.command),
    ['gnome-terminal', 'konsole'],
  );

  const fail = createWorkspaceOpener({ platform: 'linux', openPath: openPathOk, spawnFn: fn });
  const vscode = await fail.openDir('vscode', '/home/me/proj');
  assert.equal(vscode.ok, false);
  assert.equal(vscode.kind, 'not-found');

  assert.deepEqual(await opener.openDir('finder', '/home/me/proj'), { ok: true });
});

test('openDir 对未知 target 归一成 finder（偏好坏值不炸）', async () => {
  const opener = createWorkspaceOpener({ platform: 'darwin', openPath: openPathOk });
  assert.deepEqual(await opener.openDir('garbage', '/tmp/p'), { ok: true });
});

test('缺 openPath 注入直接抛错（装配契约）', () => {
  assert.throws(() => createWorkspaceOpener({ platform: 'darwin' }), /openPath/);
});
