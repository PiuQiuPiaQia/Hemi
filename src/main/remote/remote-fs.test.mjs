// 049 S1 · remote-fs 单测：经假 ssh 在本机沙箱上验证 read/write/edit 原语、
// 越界检查与路径归一（不依赖真实服务器；服务器行为差异由 S0 探针钉）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSshRunner } from './ssh-runner.mjs';
import { createRemoteFs, posixNormalize, posixResolve, isWithinRemote } from './remote-fs.mjs';
import { setupFakeSsh } from './fake-ssh.mjs';

const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'hemi-049-fs-'));
const fake = setupFakeSsh(tmpBase);
const runner = createSshRunner({ controlDir: path.join(tmpBase, 'ctl'), sshBin: fake.sshBin });
// 沙箱 home 经 macOS firmlink 会得到 /private/... 真实路径——remote-fs 全部
// 以 probe 的 realDir 为根，这里对齐（等价真实服务器上的登记流程）。
import { realpathSync } from 'node:fs';
const root = realpathSync(fake.root);
const fs = createRemoteFs({ runner, host: 'devbox', workspaceDir: root, remoteHome: fake.home });

test.after(() => {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* 残留不致命 */ }
});

test('posix 原语：归一/相对解析/~ 展开/包含判定', () => {
  assert.equal(posixNormalize('/a/./b/../c//'), '/a/c');
  assert.equal(posixNormalize('a/../../x'), '../x');
  assert.equal(posixResolve('src/x.ts', { base: '/home/u/p' }), '/home/u/p/src/x.ts');
  assert.equal(posixResolve('~/notes', { base: '/home/u/p', home: '/home/u' }), '/home/u/notes');
  assert.equal(isWithinRemote('/home/u/p', '/home/u/p/sub/f'), true);
  assert.equal(isWithinRemote('/home/u/p', '/home/u/p'), true);
  assert.equal(isWithinRemote('/home/u/p', '/home/u/p2/f'), false);
  assert.equal(isWithinRemote('/home/u/p', '/home/u/p/../../../etc'), false);
});

const NOT_POSIX = process.platform === 'win32' ? '经假 ssh（sh 脚本）在本机 POSIX 沙箱执行：win 起不来（043 Windows 批次范围外）' : false;

test('readBytes/writeText：文本读写往返；上限截断；不存在如实报错', { skip: NOT_POSIX }, async () => {
  const target = path.posix.join(root, 'notes/a.txt');
  const wrote = await fs.writeText(target, '第一行\nsecond line\n');
  assert.equal(wrote.ok, true);
  const read = await fs.readBytes(target, 512 * 1024);
  assert.equal(read.ok, true);
  assert.equal(read.buf.toString('utf8'), '第一行\nsecond line\n');
  const clipped = await fs.readBytes(target, 4);
  assert.equal(clipped.ok, true);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.buf.length, 5);
  const missing = await fs.readBytes(path.posix.join(root, 'nope.txt'), 1024);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing');
});

test('writeText：文件名含空格/引号/$/换行的路径安全（shq 纪律）', { skip: NOT_POSIX }, async () => {
  const nasty = path.posix.join(root, `dir with space/it's $HOME "q"/n'a"m"e.txt`);
  const wrote = await fs.writeText(nasty, '内容 049');
  assert.equal(wrote.ok, true);
  const read = await fs.readBytes(nasty, 1024);
  assert.equal(read.ok, true);
  assert.equal(read.buf.toString('utf8'), '内容 049');
});

test('writeText：临时文件不残留（mv 原子写）', { skip: NOT_POSIX }, async () => {
  const dir = path.posix.join(root, 'tmpcheck');
  await fs.writeText(path.posix.join(dir, 'f.txt'), 'x');
  const listed = await fs.lsEntries(dir);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.names, ['f.txt']);
});

test('stat：目录/文件/不存在三分', { skip: NOT_POSIX }, async () => {
  const d = await fs.stat(root);
  assert.equal(d.ok && d.isDirectory, true);
  const f = await fs.stat(path.posix.join(root, 'notes/a.txt'));
  assert.equal(f.ok && f.isFile, true);
  assert.equal(f.size, Buffer.byteLength('第一行\nsecond line\n', 'utf8'));
  const n = await fs.stat(path.posix.join(root, 'gone'));
  assert.equal(n.ok, false);
  assert.equal(n.reason, 'missing');
});

test('sha256：与本地 sha256Hex 同口径（edit 并发比对的基础）', { skip: NOT_POSIX }, async () => {
  const target = path.posix.join(root, 'hash.txt');
  await fs.writeText(target, '待校验内容');
  const remote = await fs.sha256(target);
  const local = fs.sha256Hex('待校验内容');
  assert.equal(typeof remote, 'string');
  assert.equal(remote, local);
  assert.equal(await fs.sha256(path.posix.join(root, 'no-such')), null);
});

test('lsEntries：目录带 / 后缀、按名排序、空目录为空数组', { skip: NOT_POSIX }, async () => {
  mkdirSync(path.join(fake.root, 'lsdir/b'), { recursive: true });
  writeFileSync(path.join(fake.root, 'lsdir/a.txt'), 'x');
  const res = await fs.lsEntries(path.posix.join(root, 'lsdir'));
  assert.equal(res.ok, true);
  assert.deepEqual(res.names, ['a.txt', 'b/']);
  const empty = await fs.lsEntries(path.posix.join(root, 'lsdir/b'));
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.names, []);
});

test('walkFiles：递归列出文件；点开头条目按段排除（与本地 walk 口径一致）', { skip: NOT_POSIX }, async () => {
  mkdirSync(path.join(fake.root, 'walk/.hidden'), { recursive: true });
  mkdirSync(path.join(fake.root, 'walk/sub'), { recursive: true });
  writeFileSync(path.join(fake.root, 'walk/a.ts'), 'x');
  writeFileSync(path.join(fake.root, 'walk/sub/b.ts'), 'x');
  writeFileSync(path.join(fake.root, 'walk/.dot.ts'), 'x');
  writeFileSync(path.join(fake.root, 'walk/.hidden/c.ts'), 'x');
  const res = await fs.walkFiles(path.posix.join(root, 'walk'));
  assert.equal(res.ok, true);
  const rel = res.files.map((f) => path.posix.relative(path.posix.join(root, 'walk'), f)).sort();
  assert.deepEqual(rel, ['a.ts', 'sub/b.ts']);});

test('grepLines：命中带 ./相对路径与行号；include 过滤；无匹配不是错误', { skip: NOT_POSIX }, async () => {
  mkdirSync(path.join(fake.root, 'g/sub'), { recursive: true });
  writeFileSync(path.join(fake.root, 'g/a.md'), 'hello alpha\nnope\n');
  writeFileSync(path.join(fake.root, 'g/sub/b.txt'), 'alpha here\n');
  writeFileSync(path.join(fake.root, 'g/c.txt'), 'alpha but txt\n');
  const hit = await fs.grepLines(path.posix.join(root, 'g'), 'alpha', {});
  assert.equal(hit.ok, true);
  assert.deepEqual([...hit.lines].sort(), ['./a.md:1: hello alpha', './c.txt:1: alpha but txt', './sub/b.txt:1: alpha here']);
  const mdOnly = await fs.grepLines(path.posix.join(root, 'g'), 'alpha', { include: '*.md' });
  assert.equal(mdOnly.ok, true);
  assert.deepEqual(mdOnly.lines, ['./a.md:1: hello alpha']);
  const none = await fs.grepLines(path.posix.join(root, 'g'), 'zeta', {});
  assert.equal(none.ok, true);
  assert.deepEqual(none.lines, []);
  // 无效正则的报错形态依赖远端 grep 方言（GNU exit 2 / BSD 可能按字面处理）——
  // 不做断言，真实服务器行为由 S0 探针钉。
});

test('realpath：服务器归一（越界检查用）；不存在路径也归一（realpath -m）', { skip: NOT_POSIX }, async () => {
  const real = await fs.realpath(path.posix.join(root, 'notes/../notes/a.txt'));
  assert.equal(real, path.posix.join(root, 'notes/a.txt'));
  const future = await fs.realpath(path.posix.join(root, 'new/deep/file.txt'));
  assert.equal(future, path.posix.join(root, 'new/deep/file.txt'));
});

test('contextExcerpt：AGENTS.md 优先于 override 缺席时，README 一并带上', { skip: NOT_POSIX }, async () => {
  writeFileSync(path.join(fake.root, 'AGENTS.md'), '# 约定\n全用中文注释。');
  writeFileSync(path.join(fake.root, 'README.md'), '# atlas\n演示项目。');
  const text = await fs.contextExcerpt();
  assert.match(text, /AGENTS\.md/);
  assert.match(text, /全用中文注释/);
  assert.match(text, /README\.md/);
  writeFileSync(path.join(fake.root, 'AGENTS.override.md'), 'override 生效');
  const overridden = await fs.contextExcerpt();
  assert.match(overridden, /override 生效/);
  assert.doesNotMatch(overridden, /全用中文注释/);
});

test('连接错误：ssh 255 时所有原语返回 kind:"conn"（断线语义交调用方）', async () => {
  fake.setMode('auth');
  const read = await fs.readBytes(path.posix.join(root, 'notes/a.txt'), 1024);
  assert.equal(read.ok, false);
  assert.equal(read.kind, 'conn');
  const st = await fs.stat(root);
  assert.equal(st.ok, false);
  assert.equal(st.kind, 'conn');
  fake.setMode('');
});
