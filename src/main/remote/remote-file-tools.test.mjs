// 049 S2 · 远端工具接管单测：同名注册的 read/write/edit/ls/grep/glob/bash 经
// 假 ssh 在沙箱执行；越界拒绝、并发修改检测、断线如实报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSshRunner } from './ssh-runner.mjs';
import { createRemoteFs } from './remote-fs.mjs';
import { createRemoteAccessContext, hemiRemoteFileTools, hemiRemoteBash } from './remote-file-tools.mjs';
import { setupFakeSsh } from './fake-ssh.mjs';

const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'hemi-049-tools-'));
const fake = setupFakeSsh(tmpBase);
const runner = createSshRunner({ controlDir: path.join(tmpBase, 'ctl'), sshBin: fake.sshBin });
// 登记根必须用 canonical 路径（真实流程＝probe 的 pwd -P；macOS /var→/private/var
// firmlink 会让词法路径与 realpath 不一致，正好把这条纪律钉进测试）。
const root = realpathSync(fake.root);
const remoteHome = fake.home;
const fs = createRemoteFs({ runner, host: 'devbox', workspaceDir: root, remoteHome });

/** 收集 registerTool 注册的工具（伪 pi）。 */
function collectTools() {
  const tools = new Map();
  const pi = {
    registerTool(def) {
      tools.set(def.name, def);
    },
  };
  return { tools, pi };
}

const access = createRemoteAccessContext({ taskId: 'task-1', host: 'devbox', workspaceDir: root, remoteHome });
const { tools, pi } = collectTools();
hemiRemoteFileTools(pi, { config: { access, fs, log: null } });
hemiRemoteBash(pi, { config: { access, runner, log: null } });

test.after(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* 残留不致命 */ }
});

test('访问上下文：resolvePath 的 ~/相对/.. 三态与显示路径', () => {
  const a = createRemoteAccessContext({ taskId: 't', host: 'devbox', workspaceDir: '/home/u/proj', remoteHome: '/home/u' });
  assert.deepEqual(a.resolvePath('src/a.ts'), { raw: 'src/a.ts', real: '/home/u/proj/src/a.ts', abs: '/home/u/proj/src/a.ts', display: '~/proj/src/a.ts', host: 'devbox' });
  assert.equal(a.resolvePath('~/notes/x').abs, '/home/u/notes/x');
  assert.equal(a.resolvePath('~/notes/x').display, '~/notes/x');
  assert.equal(a.resolvePath('../outside').abs, '/home/u/outside');
  assert.equal(a.isControlPath('/anything'), false);
});

test('访问上下文：scopeForPath 只标出项目目录；没有授权卡（2026-10-15 文件夹授权退役）', () => {
  const a = createRemoteAccessContext({ taskId: 't', host: 'devbox', workspaceDir: '/home/u/proj', remoteHome: '/home/u' });
  assert.deepEqual(a.scopeForPath('/home/u/proj/src/x.ts'), { kind: 'workspace', capability: 'edit' });
  assert.equal(a.scopeForPath('/home/u/other/f'), null);
  assert.deepEqual(a.grantFromCard({ kind: 'dir', capability: 'access', target: { real: '/home/u/other' } }), { ok: false });
});

const NOT_POSIX = process.platform === 'win32' ? '工具经假 ssh（sh 脚本）在本机 POSIX 沙箱执行：win 起不来（043 Windows 批次范围外）' : false;

test('read/write/edit/ls/grep/glob：在服务器（沙箱）上真实执行（AC-04 的 S2 等价）', { skip: NOT_POSIX }, async () => {
  const wrote = await tools.get('write').execute('c1', { path: 'src/app.ts', content: 'export const v = 1;\n' });
  assert.equal(wrote.isError, undefined);
  assert.match(wrote.content[0].text, /已写入 devbox:/);

  const read = await tools.get('read').execute('c1', { path: 'src/app.ts' });
  assert.equal(read.content[0].text, 'export const v = 1;\n');

  const edited = await tools.get('edit').execute('c1', { path: 'src/app.ts', old_string: 'v = 1', new_string: 'v = 2' });
  assert.match(edited.content[0].text, /已修改 devbox:/);
  assert.equal(readFileSync(path.join(fake.root, 'src/app.ts'), 'utf8'), 'export const v = 2;\n');

  const listed = await tools.get('ls').execute('c1', { path: 'src' });
  assert.equal(listed.content[0].text, 'app.ts');

  const hit = await tools.get('grep').execute('c1', { pattern: 'v = 2' });
  assert.equal(hit.content[0].text, './src/app.ts:1: export const v = 2;');

  const found = await tools.get('glob').execute('c1', { pattern: '**/*.ts' });
  assert.equal(found.content[0].text, './src/app.ts');

  const missed = await tools.get('edit').execute('c1', { path: 'src/app.ts', old_string: '不存在的串', new_string: 'x' });
  assert.equal(missed.isError, true);
  assert.match(missed.content[0].text, /找不到/);
});

test('完全访问：项目外读写放行；家内凭据（.ssh）与系统目录写按服务器真实路径拒', { skip: NOT_POSIX }, async () => {
  const allowed = await tools.get('write').execute('c2', { path: '~/outside/ok.txt', content: '远端外文件' });
  assert.equal(allowed.isError, undefined, allowed.content?.[0]?.text);
  assert.equal(readFileSync(path.join(fake.home, 'outside/ok.txt'), 'utf8'), '远端外文件');
  const ssh = await tools.get('write').execute('c3', { path: '~/.ssh/authorized_keys', content: 'x' });
  assert.equal(ssh.isError, true);
  assert.match(ssh.content[0].text, /禁止清单/);
  const sys = await tools.get('write').execute('c4', { path: '/etc/hemi-honey', content: 'x' });
  assert.equal(sys.isError, true);
  assert.match(sys.content[0].text, /系统目录|禁止清单/);
});

test('edit：读后被并发修改 → 写回前哈希比对拒绝（技术方案 R-05/06）', { skip: NOT_POSIX }, async () => {
  // 用包装 fs 固定服务器哈希（模拟文件在「读取之后、写回之前」被别人改了）
  const wrappedFs = {
    ...fs,
    sha256Hex: fs.sha256Hex,
    sha256: async () => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  };
  const a2 = createRemoteAccessContext({ taskId: 't2', host: 'devbox', workspaceDir: root, remoteHome });
  const { tools: t2, pi: pi2 } = collectTools();
  hemiRemoteFileTools(pi2, { config: { access: a2, fs: wrappedFs, log: null } });
  writeFileSync(path.join(fake.root, 'race.txt'), '初始内容');
  const raced = await t2.get('edit').execute('c1', { path: 'race.txt', old_string: '初始', new_string: '改后' });
  assert.equal(raced.isError, true);
  assert.match(raced.content[0].text, /被修改过/);
  assert.equal(readFileSync(path.join(fake.root, 'race.txt'), 'utf8'), '初始内容');
});

test('bash：在项目目录执行、退出码透传、stderr 分离（R-07）', { skip: NOT_POSIX }, async () => {
  const out = await tools.get('bash').execute('c1', { command: 'pwd && printf OUT && printf ERR >&2' });
  assert.equal(out.isError, undefined);
  const text = out.content[0].text;
  assert.equal(text.split('\n')[0], root);
  assert.match(text, /OUT/);
  assert.match(text, /stderr:\nERR/);
  assert.match(text, /exit=0/);
  const fail = await tools.get('bash').execute('c1', { command: 'exit 3' });
  assert.match(fail.content[0].text, /exit=3/);
});

test('bash：命令携带引号/$/反引号内容逐字节原样生效（shq 纪律，不进本机 shell）', { skip: NOT_POSIX }, async () => {
  const { shq } = await import('./ssh-runner.mjs');
  const tricky = "it's a $VAR `cmd` \"q\"";
  const out = await tools.get('bash').execute('c1', { command: `printf %s ${shq(tricky)} > tricky.txt` });
  assert.match(out.content[0].text, /exit=0/);
  assert.equal(readFileSync(path.join(fake.root, 'tricky.txt'), 'utf8'), tricky);
});

test('bash：停止（AbortSignal）→ 已被停止 + 连接中断如实报错（R-08）', { skip: NOT_POSIX }, async () => {
  const controller = new AbortController();
  const pending = tools.get('bash').execute('c1', { command: 'sleep 8', timeout_ms: 60_000 }, controller.signal);
  setTimeout(() => controller.abort(), 300);
  const stopped = await pending;
  assert.match(stopped.content[0].text, /已被停止/);

  fake.setMode('auth');
  const broken = await tools.get('bash').execute('c1', { command: 'echo hi' });
  assert.equal(broken.isError, true);
  assert.match(broken.content[0].text, /连接中断/);
  assert.match(broken.content[0].text, /留在服务器上/);
  fake.setMode('');
});

test('read：目录/超大/缺失的如实分支', { skip: NOT_POSIX }, async () => {
  mkdirSync(path.join(fake.root, 'adir'), { recursive: true });
  const dirRead = await tools.get('read').execute('c1', { path: 'adir' });
  assert.equal(dirRead.isError, true);
  assert.match(dirRead.content[0].text, /这是文件夹/);
  const missing = await tools.get('read').execute('c1', { path: 'no-such-file' });
  assert.equal(missing.isError, true);
});
