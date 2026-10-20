// 042 · file-tools 单测：同名工具在授权范围内读写、越界拒、edit 语义、grep/glob。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat, truncate, symlink } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import hemiFileTools, { hemiCommandTool, MAX_IMAGE_READ_BYTES } from './file-tools.mjs';
import { testPng, encodedImages } from '../../../../scripts/lib/local-image-fixtures.mjs';
import { createPermissionService } from '../../services/permission-service.mjs';
import { createAccessContext } from './access-context.mjs';

async function fixture({ grantWorkspace = true, extraDir = null, extraCapability = 'access' } = {}) {
  const raw = await mkdtemp(path.join(tmpdir(), 'hemi-ft-'));
  const root = await realpath(raw);
  const workspace = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  await mkdir(workspace); await mkdir(outside);
  await writeFile(path.join(outside, 's.txt'), 'outside-secret');
  const service = createPermissionService({ dir: path.join(root, 'store'), nowFn: () => 1 });
  await service.load();
  if (extraDir) {
    await service.addDirectory({ canonicalRoot: extraDir });
    if (extraCapability === 'edit') await service.setDirectoryCapability({ resourceId: `dir:${extraDir}`, capability: 'edit' });
  }
  const access = createAccessContext({
    service, taskId: 't1', home: root,
    workspaceDir: grantWorkspace ? workspace : null,
    listAppWindows: async () => [],
  });
  const tools = new Map();
  const pi = { registerTool: (spec) => tools.set(spec.name, spec) };
  hemiFileTools(pi, { config: { access } });
  hemiCommandTool(pi, { config: { access } });
  const run = (name, args, signal) => tools.get(name).execute('id', args, signal);
  return { run, workspace, outside, root, dispose: () => rm(raw, { recursive: true, force: true }) };
}

const text = (out) => out?.content?.map((c) => c.text ?? '').join('') ?? '';

test('068 read 按实际内容读取四种图片，不再落到文本上限或二进制提示', async () => {
  const f = await fixture();
  try {
    const png = testPng({ width: 512, height: 512, noisy: true });
    assert.ok(png.length > 512 * 1024, '真实图片确实超过旧文本读取上限');
    for (const [kind, bytes] of [['png', png], ...Object.entries(encodedImages).map(([kind, data]) => [kind, Buffer.from(data, 'base64')])]) {
      const file = path.join(f.workspace, `image-${kind}.bin`);
      await writeFile(file, bytes);
      const result = await f.run('read', { path: `image-${kind}.bin` });
      assert.notEqual(result.isError, true, text(result));
      const image = result.content.find(c => c.type === 'image');
      assert.ok(image, `${kind} 必须返回真实图片块`);
      assert.equal(image.mimeType, `image/${kind}`);
      assert.deepEqual(Buffer.from(image.data, 'base64'), bytes);
      assert.doesNotMatch(text(result), /二进制|文件过大/);
    }
  } finally { await f.dispose(); }
});

test('068 大图真实缩放；损坏、超限与取消不会伪报读图成功', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.workspace, 'wide.png'), testPng({ width: 3000, height: 120 }));
    const resized = await f.run('read', { path: 'wide.png' });
    assert.equal(resized.details.image.originalWidth, 3000);
    assert.equal(resized.details.image.width, 2000);
    assert.equal(resized.details.image.height, 80);
    assert.equal(resized.details.image.resized, true);
    assert.ok(resized.content.some(c => c.type === 'image' && c.data.length < 4.5 * 1024 * 1024));
    for (const [name, bytes] of [['bad.png', Buffer.from('not an image')], ['broken.jpg', Buffer.from([0xff, 0xd8, 0xff, 0, 0])]]) {
      await writeFile(path.join(f.workspace, name), bytes);
      const broken = await f.run('read', { path: name });
      assert.equal(broken.isError, true);
      assert.equal(broken.content.some(c => c.type === 'image'), false);
    }
    const big = path.join(f.workspace, 'big.png');
    await writeFile(big, testPng()); await truncate(big, MAX_IMAGE_READ_BYTES + 1);
    const tooLarge = await f.run('read', { path: big });
    assert.equal(tooLarge.isError, true); assert.match(text(tooLarge), /图片过大/);
    assert.equal(tooLarge.content.some(c => c.type === 'image'), false);
    await assert.rejects(f.run('read', { path: 'wide.png' }, AbortSignal.abort()), /abort/i);
  } finally { await f.dispose(); }
});

test('068 图片继续按真实落点拒绝敏感目录与符号链接，不能先读出图像字节', async () => {
  const f = await fixture();
  try {
    const mail = path.join(f.root, 'Library', 'Mail'); await mkdir(mail, { recursive: true });
    const file = path.join(mail, 'private.png'); await writeFile(file, testPng());
    await symlink(mail, path.join(f.workspace, 'linked-mail'));
    for (const target of [file, 'linked-mail/private.png']) {
      const out = await f.run('read', { path: target });
      assert.equal(out.isError, true); assert.match(text(out), /禁止清单/);
      assert.equal(out.content.some(c => c.type === 'image'), false);
    }
  } finally { await f.dispose(); }
});

test('工作区内外：write/read/edit/ls/grep/glob 全通（2026-10-15 本机完全访问）；个人数据库与系统目录写仍拒', async () => {
  const f = await fixture();
  try {
    const w = await f.run('write', { path: 'a/b.txt', content: 'hello hemi 042' });
    assert.equal(w.isError, undefined, text(w));
    assert.match(text(await f.run('read', { path: 'a/b.txt' })), /hello hemi 042/);
    const e = await f.run('edit', { path: 'a/b.txt', old_string: 'hemi', new_string: 'Hemi' });
    assert.equal(e.isError, undefined, text(e));
    assert.match(text(await f.run('read', { path: 'a/b.txt' })), /hello Hemi 042/);
    assert.match(text(await f.run('ls', { path: '.' })), /a\//);
    assert.match(text(await f.run('grep', { pattern: 'Hemi', path: '.' })), /b\.txt:1/);
    assert.match(text(await f.run('glob', { pattern: '**/*.txt', path: '.' })), /a[\\/]b\.txt/);

    const ro = await f.run('read', { path: `${f.outside}/s.txt` });
    assert.equal(ro.isError, undefined, text(ro));
    assert.match(text(ro), /outside-secret/);
    const wo = await f.run('write', { path: `${f.outside}/x.txt`, content: 'ok' });
    assert.equal(wo.isError, undefined, text(wo));
    assert.ok(await stat(`${f.outside}/x.txt`).then(() => true, () => false), '区外文件落地');
    // 个人数据库（家目录＝fixture root）按真实落点拒。
    await mkdir(path.join(f.root, 'Library', 'Mail'), { recursive: true });
    await writeFile(path.join(f.root, 'Library', 'Mail', 'm.txt'), 'mail');
    const mail = await f.run('read', { path: `${f.root}/Library/Mail/m.txt` });
    assert.equal(mail.isError, true);
    assert.match(text(mail), /禁止清单/);
    // 系统目录按平台取真实存在的根（win 的 /usr/local 只是盘相对死路径）。
    const sysTarget = process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'hemi-should-not-exist.txt')
      : '/usr/local/hemi-should-not-exist.txt';
    const sys = await f.run('write', { path: sysTarget, content: 'x' });
    assert.equal(sys.isError, true);
    assert.match(text(sys), /系统目录/);
  } finally { await f.dispose(); }
});

test('文件工具在完全访问下仍拒敏感点文件（.ssh/.env/.netrc 等）', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, '.netrc'), 'machine x password y');
    const netrc = await f.run('read', { path: `${f.root}/.netrc` });
    assert.equal(netrc.isError, true);
    assert.match(text(netrc), /禁止清单/);
  } finally { await f.dispose(); }
});

test('060 bash：直接执行与真实失败，不将末尾成功冒称关键操作成功', async () => {
  const f = await fixture();
  try {
    const success = await f.run('bash', { command: 'echo direct-command' });
    assert.equal(success.isError, false);
    assert.match(text(success), /direct-command/);
    const failed = await f.run('bash', { command: process.platform === 'win32' ? 'echo failure 1>&2 & exit /b 7' : 'echo failure >&2; exit 7' });
    assert.equal(failed.isError, true);
    assert.equal(failed.details.code, 7);
    assert.match(text(failed), /failure/);
    assert.doesNotMatch(text(failed), /沙箱拒绝|受保护位置/);
  } finally { await f.dispose(); }
});

// 2026-10-10 会话审计（第 12 轮）：Skill 相对资源在 userData 控制面内被硬拒——
// 结构化工具与沙箱 bash 都要能读租约目录，写两条路都要拒。单 root 自建（skill 树
// 必须落在控制根 store 之内才能证豁免真的穿过了控制面）。
test('Skill 租约目录：结构化工具只读、直接命令不宣称 OS 文件隔离', async () => {
  const raw = await mkdtemp(path.join(tmpdir(), 'hemi-ft-skill-'));
  const root = await realpath(raw);
  const store = path.join(root, 'store');
  const workspace = path.join(root, 'ws');
  const skill = path.join(store, 'skills', 'versions', 'bazi_x', 'aa842809');
  const sibling = path.join(store, 'skills', 'versions', 'bazi_x', 'deadbeef00');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# 八字 skill');
  await writeFile(path.join(skill, 'references', 'wuxing-tables.md'), '五行：木火土金水');
  await writeFile(path.join(sibling, 'SKILL.md'), '# 未租约版本');
  const service = createPermissionService({ dir: store, nowFn: () => 1 });
  await service.load();
  const access = createAccessContext({
    service, taskId: 't1', home: root, workspaceDir: workspace, skillRoots: [skill],
    listAppWindows: async () => [],
  });
  const tools = new Map();
  const pi = { registerTool: (spec) => tools.set(spec.name, spec) };
  hemiFileTools(pi, { config: { access } });
  hemiCommandTool(pi, { config: { access } });
  const run = (name, args) => tools.get(name).execute('id', args, undefined);
  try {
    assert.match(text(await run('read', { path: path.join(skill, 'SKILL.md') })), /八字 skill/);
    assert.match(text(await run('read', { path: path.join(skill, 'references', 'wuxing-tables.md') })), /木火土金水/);
    assert.match(text(await run('ls', { path: skill })), /references\//);
    assert.match(text(await run('grep', { pattern: '木火', path: skill })), /wuxing-tables\.md:1/);
    // 沙箱 bash 读租约资源（cat）可用。
    if (process.platform !== 'win32') {
    const cat = await run('bash', { command: `cat '${path.join(skill, 'references', 'wuxing-tables.md')}'` });
    assert.match(text(cat), /木火土金水/);
    }
    // 结构化工具继续拒写受控租约；直接命令不承诺 OS 文件隔离。
    const w = await run('write', { path: path.join(skill, 'SKILL.md'), content: '篡改' });
    assert.equal(w.isError, true);
    assert.match(text(w), /受控版本（只读）/);
    const e = await run('edit', { path: path.join(skill, 'SKILL.md'), old_string: '#', new_string: '##' });
    assert.equal(e.isError, true);
    // 未租约的同级版本目录：读仍拒（控制面）。
    const ro = await run('read', { path: path.join(sibling, 'SKILL.md') });
    assert.equal(ro.isError, true);
    assert.match(text(ro), /控制文件/);
  } finally { await rm(raw, { recursive: true, force: true }); }
});

test('edit：old_string 不存在时报错不写', async () => {
  const f = await fixture();
  try {
    await f.run('write', { path: 'x.txt', content: 'abc' });
    const bad = await f.run('edit', { path: 'x.txt', old_string: 'zzz', new_string: 'y' });
    assert.equal(bad.isError, true);
    assert.match(text(await f.run('read', { path: 'x.txt' })), /^abc$/);
  } finally { await f.dispose(); }
});

test('中间段符号链接逃逸：ws/h -> ~/Library/Mail，读写都按真实落点拒', async () => {
  const f = await fixture();
  try {
    const { symlink, readFile } = await import('node:fs/promises');
    const mailDir = path.join(f.root, 'Library', 'Mail');
    await mkdir(mailDir, { recursive: true });
    await writeFile(path.join(mailDir, 's.txt'), 'mail-secret');
    await symlink(mailDir, path.join(f.workspace, 'h'));
    const r = await f.run('read', { path: 'h/s.txt' });
    assert.equal(r.isError, true, text(r));
    assert.doesNotMatch(text(r), /mail-secret/);
    const w = await f.run('write', { path: 'h/s.txt', content: 'pwn' });
    assert.equal(w.isError, true);
    assert.equal(await readFile(path.join(mailDir, 's.txt'), 'utf-8'), 'mail-secret');
    const g = await f.run('grep', { pattern: 'secret', path: 'h' });
    assert.equal(g.isError, true);
  } finally { await f.dispose(); }
});

test('edit：new_string 里的 $& / $$ 原样写入，保留原权限位', async () => {
  const f = await fixture();
  try {
    const { chmod, readFile } = await import('node:fs/promises');
    const file = path.join(f.workspace, 'run.sh');
    await writeFile(file, 'cost a\n');
    await chmod(file, 0o755);
    const e = await f.run('edit', { path: 'run.sh', old_string: 'a', new_string: '$& $$5' });
    assert.equal(e.isError, undefined, text(e));
    assert.equal(await readFile(file, 'utf-8'), 'cost $& $$5\n');
    // POSIX 权限位只在类 unix 上有意义（win 的 chmod 近似 no-op）。
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o755);
    }
  } finally { await f.dispose(); }
});

test('未绑定工作区：相对路径按执行器 cwd 解析（不回落家目录），且 cwd 本身不自动授权', async () => {
  const raw = await mkdtemp(path.join(tmpdir(), 'hemi-ft-cwd-'));
  const root = await realpath(raw);
  try {
    const service = createPermissionService({ dir: path.join(root, 'store'), nowFn: () => 1 });
    await service.load();
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    const access = createAccessContext({ service, taskId: 't1', home: path.join(root, 'home'), workspaceDir: null, cwd, listAppWindows: async () => [] });
    const t = await access.resolvePath('a.txt');
    assert.equal(t.real, path.join(cwd, 'a.txt'));
    assert.equal(access.scopeForPath(t.real), null);
  } finally { await rm(raw, { recursive: true, force: true }); }
});
