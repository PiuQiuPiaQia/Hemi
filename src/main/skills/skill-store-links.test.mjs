import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSkillStore, readSkillDirectory, validateFileSet } from './skill-store.mjs';
import { prepareSkills } from './skill-definition.mjs';
import { observeLiveSkillItems, resolveSkillRefs } from '../workflows/skill-executor.mjs';
import { createLocalSkillScanner } from './local-agent-skills.mjs';

const text = (name = 'live-demo', body = '初版') => `---\nname: ${name}\ndescription: 本地演示\n---\n${body}\n`;
async function setup(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hemi-link-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'store');
  const source = path.join(temp, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), text());
  const store = createSkillStore({ root });
  return { temp, root, source, store };
}

test('默认真实软链接：大文件、多文件、原生载荷及非包路径不经复制门槛', async t => {
  const { root, source, store } = await setup(t);
  await writeFile(path.join(source, '巨大资源.bin'), Buffer.alloc(5 * 1024 * 1024, 3));
  await writeFile(path.join(source, 'native.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  for (let i = 0; i < 270; i++) await writeFile(path.join(source, `resource-${i}.txt`), 'x');
  const result = await store.importDirectory(source);
  assert.equal(result.skill.importMode, 'symlink');
  assert.equal(result.skill.version, '随源更新');
  assert.equal(result.skill.sha256, null);
  assert.equal(result.skill.sourceAvailable, true);
  assert.deepEqual(result.skill.files, ['SKILL.md']);
  const dir = store.managedPath(result.skill.id);
  assert.equal((await lstat(dir)).isSymbolicLink(), true);
  assert.equal(await realpath(dir), await realpath(source));
  assert.deepEqual(await readdir(path.dirname(dir)), [path.basename(dir)]);
  assert.equal(existsSync(path.join(root, 'staging')), false);
  assert.match(await store.readSkill(result.skill.id), /初版/);
  const first = store.snapshot();
  await writeFile(path.join(source, 'SKILL.md'), text('live-demo', '新版'));
  await writeFile(path.join(source, 'resource-0.txt'), '资源已更新');
  const second = store.snapshot();
  assert.notEqual(second.items[0].revision, first.items[0].revision);
  assert.equal(second.items[0].sha256, null);
  assert.match(await store.readSkill(result.skill.id), /新版/);
  assert.equal(await readFile(path.join(first.items[0].path, 'resource-0.txt'), 'utf8'), '资源已更新');
  const observed = prepareSkills(first.items).items[0];
  assert.equal(observed.revision, second.items[0].revision);
  assert.equal(observed.sha256, null, '排队的 lease 再装配时也不能带旧包摘要');
  assert.equal(observeLiveSkillItems(first.items)[0].revision, second.items[0].revision);
  assert.equal(resolveSkillRefs({ refs: [{ name: 'live-demo', version: '1.0.0' }], available: second.items }).ok, false);
  assert.equal(resolveSkillRefs({ refs: [{ name: 'live-demo' }], available: second.items }).ok, true);
  first.release(); second.release(); await store.prune();
});

test('源移动/失效/删除及重启均降级；修复源后恢复，不影响其他技能', async t => {
  const { temp, root, source, store } = await setup(t);
  const { skill } = await store.importDirectory(source);
  await store.installMarket('meeting-notes');
  const queued = store.snapshot();
  const moved = path.join(temp, 'moved');
  await rename(source, moved);
  assert.throws(() => observeLiveSkillItems(queued.items), { code: 'dependency-unavailable' });
  queued.release();
  const reopened = createSkillStore({ root });
  assert.equal(reopened.state().storageError, '');
  let state = reopened.state().installed.find(x => x.id === skill.id);
  assert.equal(state.sourceAvailable, false);
  assert.match(state.sourceError, /不可用/);
  let snapshot = reopened.snapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.diagnostics.length, 1);
  snapshot.release();
  assert.throws(() => reopened.snapshot(skill.id), /不可用/);
  assert.throws(() => reopened.managedPath(skill.id));
  await assert.rejects(() => reopened.readSkill(skill.id));
  await rename(moved, source);
  assert.equal(reopened.state().installed.find(x => x.id === skill.id).sourceAvailable, true);
  await writeFile(path.join(source, 'SKILL.md'), text('changed-name'));
  assert.match(reopened.state().installed.find(x => x.id === skill.id).sourceError, /name/);
  snapshot = reopened.snapshot(); assert.equal(snapshot.items.length, 1); snapshot.release();
  await writeFile(path.join(source, 'SKILL.md'), '无效正文');
  assert.match(reopened.state().installed.find(x => x.id === skill.id).sourceError, /frontmatter/);
  await rm(source, { recursive: true });
  await reopened.remove(skill.id); await reopened.prune();
  assert.equal(reopened.state().installed.length, 1);
});

test('卸载与 prune 仅删除受管链接；在途引用保留链接，切换 copy/link 不冲突', async t => {
  const { root, source, store } = await setup(t);
  const original = await store.importDirectory(source, { mode: 'copy' });
  const copyLease = store.snapshot(); const copyPath = copyLease.items[0].path;
  const linked = await store.importDirectory(source);
  assert.equal(linked.skill.id, original.skill.id);
  const linkLease = store.snapshot(); const linkPath = linkLease.items[0].path;
  assert.notEqual(copyPath, linkPath);
  const back = await store.importDirectory(source, { mode: 'copy' });
  assert.equal(back.skill.id, linked.skill.id);
  assert.equal((await lstat(copyPath)).isDirectory(), true);
  await store.remove(back.skill.id); await store.prune();
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.equal(existsSync(path.join(source, 'SKILL.md')), true);
  copyLease.release(); linkLease.release(); await store.prune();
  assert.equal(existsSync(copyPath), false);
  await assert.rejects(() => lstat(linkPath), { code: 'ENOENT' });
  assert.match(await readFile(path.join(source, 'SKILL.md'), 'utf8'), /初版/);
  assert.equal(createSkillStore({ root }).state().storageError, '');
});

test('旧副本带 sourcePath 不迁移/不推断为链接，重启后保持旧正文', async t => {
  const { root, source, store } = await setup(t);
  const { skill } = await store.importDirectory(source, { mode: 'copy' });
  const file = path.join(root, 'index.json');
  const index = JSON.parse(await readFile(file, 'utf8'));
  delete index.installed[0].importMode;
  await writeFile(file, JSON.stringify(index));
  await writeFile(path.join(source, 'SKILL.md'), text('live-demo', '新源正文'));
  const reopened = createSkillStore({ root });
  assert.equal(reopened.state().installed[0].importMode, 'copy');
  assert.equal((await lstat(reopened.managedPath(skill.id))).isSymbolicLink(), false);
  assert.match(await reopened.readSkill(skill.id), /初版/);
  await rm(source, { recursive: true });
  assert.equal(reopened.state().storageError, '');
  assert.match(await reopened.readSkill(skill.id), /初版/);
});

test('旧副本原始 sourcePath 别名切换链接复用 id，不发生同名冲突', async t => {
  const { temp, root, source, store } = await setup(t);
  const copied = await store.importDirectory(source, { mode: 'copy' });
  const alias = path.join(temp, 'alias');
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const indexFile = path.join(root, 'index.json');
  const index = JSON.parse(await readFile(indexFile, 'utf8'));
  delete index.installed[0].importMode; index.installed[0].sourcePath = alias;
  await writeFile(indexFile, JSON.stringify(index));
  const reopened = createSkillStore({ root });
  assert.equal(reopened.state().installed[0].importMode, 'copy');
  const linked = await reopened.importDirectory(source);
  assert.equal(linked.skill.id, copied.skill.id);
  assert.equal(linked.skill.importMode, 'symlink');
});

test('copy/market 文件校验器/Bot 远传仍执行 2MiB、4MiB、256 文件限制', async t => {
  const { source, store } = await setup(t);
  const big = Buffer.alloc(2 * 1024 * 1024 + 1);
  await writeFile(path.join(source, 'big.bin'), big);
  await assert.rejects(() => store.importDirectory(source, { mode: 'copy' }), /复制导入失败.*2 MiB/);
  await assert.rejects(() => readSkillDirectory(source), /2 MiB/);
  const encoded = [{ path: 'SKILL.md', contentBase64: Buffer.from(text()).toString('base64') }, { path: 'big.bin', contentBase64: big.toString('base64') }];
  assert.throws(() => validateFileSet(encoded), /2 MiB/);
  await assert.rejects(() => store.importFiles({ files: encoded, mode: 'symlink' }), /2 MiB/);
  await rm(path.join(source, 'big.bin'));
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from(text()).toString('base64') }];
  for (let i = 0; i < 3; i++) {
    const bytes = Buffer.alloc(1500 * 1024);
    await writeFile(path.join(source, `part-${i}`), bytes);
    files.push({ path: `part-${i}`, contentBase64: bytes.toString('base64') });
  }
  await assert.rejects(() => readSkillDirectory(source), /4 MiB/);
  await assert.rejects(() => store.importDirectory(source, { mode: 'copy' }), /4 MiB/);
  await assert.rejects(() => store.importFiles({ files }), /4 MiB/);
  assert.throws(() => validateFileSet(files), /4 MiB/);
  for (let i = 0; i < 3; i++) await rm(path.join(source, `part-${i}`));
  for (let i = 0; i < 256; i++) await writeFile(path.join(source, `f-${i}`), 'x');
  await assert.rejects(() => readSkillDirectory(source), /256/);
  await assert.rejects(() => store.importDirectory(source, { mode: 'copy' }), /256/);
  const many = Array.from({ length: 257 }, (_, i) => ({ path: i ? `f-${i}` : 'SKILL.md', contentBase64: Buffer.from(i ? 'x' : text()).toString('base64') }));
  await assert.rejects(() => store.importFiles({ files: many }), /数量超限/);
  assert.throws(() => validateFileSet(many), /数量超限/);
  assert.equal(store.state().installed.length, 0);
  const imported = await store.importFiles({ files: many.slice(0, 1), mode: 'symlink' });
  assert.equal(imported.skill.importMode, 'copy');
  assert.equal(imported.skill.sourcePath, null);
});

test('链接入口格式/路径校验与批量 options 透传，不读额外目录', async t => {
  const { temp, source, store } = await setup(t);
  await assert.rejects(() => store.importDirectory('relative'));
  await assert.rejects(() => store.importDirectory(source, { mode: 'invalid' }), /导入方式/);
  await rm(path.join(source, 'SKILL.md'));
  await assert.rejects(() => store.importDirectory(source), /缺少 SKILL.md/);
  const elsewhere = path.join(temp, 'entry.md'); await writeFile(elsewhere, text());
  await symlink(elsewhere, path.join(source, 'SKILL.md'));
  await assert.rejects(() => store.importDirectory(source), /普通文件/);
  await rm(path.join(source, 'SKILL.md'));
  await writeFile(path.join(source, 'SKILL.md'), text());
  const home = path.join(temp, 'home'); const candidate = path.join(home, '.agents/skills/demo');
  await mkdir(path.dirname(candidate), { recursive: true }); await symlink(source, candidate, process.platform === 'win32' ? 'junction' : 'dir');
  const scanner = createLocalSkillScanner({ home: () => home, listWorkspaceDirs: () => [], getInstalled: () => [],
    importOne: (dir, options) => store.importDirectory(dir, options), state: store.state });
  const scan = await scanner.scan();
  const result = await scanner.import(scan.candidates.map(x => x.path), { mode: 'copy' });
  assert.equal(result.state.installed[0].importMode, 'copy');
  const again = await scanner.import(scan.candidates.map(x => x.path));
  assert.equal(again.state.installed[0].importMode, 'symlink');
});

test('软链创建权限失败绝不偷偷复制', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { root, source, store } = await setup(t);
  const result = await store.importDirectory(source, { mode: 'copy' });
  const owner = path.dirname(store.managedPath(result.skill.id));
  await chmod(owner, 0o500);
  try {
    await assert.rejects(() => store.importDirectory(source), /无法创建.*软链接.*未复制/);
    assert.equal(store.state().installed[0].importMode, 'copy');
    assert.equal((await readdir(owner)).length, 1);
  } finally { await chmod(owner, 0o700); }
});
