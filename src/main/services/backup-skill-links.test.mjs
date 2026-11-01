import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectEntries, createBackup, extractBackup, mergeRestore, estimateMerge } from './backup-service.mjs';
import { createSkillStore } from '../skills/skill-store.mjs';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-backup-links-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['user', 'external', 'out', 'stage', 'target', 'safe'].map(key => [key, path.join(temp, key)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  return dirs;
}
const skillText = '---\nname: backup-live\ndescription: 本地技能\n---\n正文';

test('真实备份仅保存链接登记，不跟随外部源、循环链或断链；异机恢复明确不可用', async t => {
  const { user, external, out, stage, target, safe } = setup(t);
  fs.writeFileSync(path.join(external, 'SKILL.md'), skillText);
  fs.writeFileSync(path.join(external, 'SENTINEL'), '绝不能打包的外部资源');
  fs.symlinkSync(external, path.join(external, 'cycle'), linkType);
  const store = createSkillStore({ root: path.join(user, 'skills') });
  const { skill } = await store.importDirectory(external);
  const link = store.managedPath(skill.id);
  // 白名单顶层以及深层的断链/循环也不能递归。
  fs.symlinkSync(user, path.join(user, 'skills', 'cycle'), linkType);
  fs.symlinkSync(path.join(external, 'missing'), path.join(user, 'skills', 'broken'), linkType);
  fs.symlinkSync(external, path.join(user, 'pi-memory'), linkType);
  const entries = collectEntries(user);
  assert.ok(entries.some(e => e.rel === 'skills/index.json'));
  assert.ok(!entries.some(e => /SENTINEL|SKILL.md|cycle|broken|pi-memory|link-/.test(e.rel)));
  const { backupDir, manifest } = await createBackup({ userDataDir: user, outDir: out });
  assert.equal(manifest.entries.files, 1);
  await extractBackup({ backupDir, stagingDir: stage });
  assert.equal(fs.existsSync(path.join(stage, path.relative(user, link))), false);
  await mergeRestore({ stagingDir: stage, userDataDir: target, safeCopyRoot: safe });
  const restored = createSkillStore({ root: path.join(target, 'skills') });
  assert.equal(restored.state().storageError, '');
  const entry = restored.state().installed[0];
  assert.equal(entry.importMode, 'symlink');
  assert.equal(entry.sha256, null);
  assert.equal(entry.sourceAvailable, false, '未恢复链接，不把同路径存在的源假装成安装副本');
  assert.match(entry.sourceError, /不可用/);
  const snapshot = restored.snapshot();
  assert.equal(snapshot.items.length, 0); assert.equal(snapshot.diagnostics.length, 1); snapshot.release();
  assert.equal(fs.readFileSync(path.join(external, 'SENTINEL'), 'utf8'), '绝不能打包的外部资源');
});

test('断源后的登记仍可备份恢复，不读取失效源、不使技能库登记损坏', async t => {
  const { user, external, out, stage, target, safe } = setup(t);
  fs.writeFileSync(path.join(external, 'SKILL.md'), skillText);
  const store = createSkillStore({ root: path.join(user, 'skills') });
  await store.importDirectory(external);
  fs.rmSync(external, { recursive: true });
  const { backupDir } = await createBackup({ userDataDir: user, outDir: out });
  await extractBackup({ backupDir, stagingDir: stage });
  await mergeRestore({ stagingDir: stage, userDataDir: target, safeCopyRoot: safe });
  const restored = createSkillStore({ root: path.join(target, 'skills') });
  assert.equal(restored.state().storageError, '');
  assert.equal(restored.state().installed[0].sourceAvailable, false);
  await restored.remove(restored.state().installed[0].id);
});

for (const placement of ['skills', 'skills/versions/local_demo/hash', 'skills/index.json', 'broken-dir', 'broken-file']) {
  test(`恢复真实归档不沿目标链接写入外部源：${placement}`, async t => {
    const { user, external, out, stage, target, safe } = setup(t);
    const relDir = 'skills/versions/local_demo/hash';
    fs.mkdirSync(path.join(user, relDir), { recursive: true });
    fs.writeFileSync(path.join(user, relDir, 'SKILL.md'), '备份技能正文');
    fs.writeFileSync(path.join(user, 'skills/index.json'), '{"restored":true}');
    fs.writeFileSync(path.join(external, 'SKILL.md'), '外部源正文，不可覆写');
    fs.writeFileSync(path.join(external, 'SENTINEL'), '外部哨兵');
    const { backupDir } = await createBackup({ userDataDir: user, outDir: out });
    await extractBackup({ backupDir, stagingDir: stage });
    const rel = placement === 'broken-dir' ? relDir : placement === 'broken-file' ? 'skills/index.json' : placement;
    const isFile = rel.endsWith('.json');
    const linkTarget = placement.startsWith('broken-') ? path.join(external, 'missing')
      : isFile ? path.join(external, 'SKILL.md') : external;
    const targetPath = path.join(target, rel);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.symlinkSync(linkTarget, targetPath, isFile ? 'file' : linkType);
    const before = fs.readdirSync(external).sort();
    const estimate = await estimateMerge({ stagingDir: stage, userDataDir: target });
    assert.ok(estimate.conflicts > 0);
    await mergeRestore({ stagingDir: stage, userDataDir: target, safeCopyRoot: safe });
    assert.equal(fs.readFileSync(path.join(external, 'SKILL.md'), 'utf8'), '外部源正文，不可覆写');
    assert.equal(fs.readFileSync(path.join(external, 'SENTINEL'), 'utf8'), '外部哨兵');
    assert.deepEqual(fs.readdirSync(external).sort(), before);
    assert.equal(fs.lstatSync(path.join(safe, rel)).isSymbolicLink(), true, '安全副本只移动链接本身');
    assert.equal(fs.lstatSync(targetPath).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(target, relDir, 'SKILL.md'), 'utf8'), '备份技能正文');
    assert.equal(fs.existsSync(path.join(external, 'missing')), false);
  });
}

test('恢复目标循环链接及安全副本链接不被递归，安全副本外部哨兵不改写', async t => {
  const { user, external, stage, target, safe } = setup(t);
  fs.mkdirSync(path.join(stage, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'skills/index.json'), 'backup');
  fs.symlinkSync(target, path.join(target, 'skills'), linkType);
  await mergeRestore({ stagingDir: stage, userDataDir: target, safeCopyRoot: safe });
  assert.equal(fs.lstatSync(path.join(safe, 'skills')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(target, 'skills/index.json'), 'utf8'), 'backup');
  const stage2 = path.join(user, 'stage2'); fs.mkdirSync(path.join(stage2, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(stage2, 'skills/index.json'), 'different');
  fs.writeFileSync(path.join(external, 'SENTINEL'), 'unchanged');
  fs.rmSync(path.join(safe, 'skills')); fs.symlinkSync(external, path.join(safe, 'skills'), linkType);
  await assert.rejects(() => mergeRestore({ stagingDir: stage2, userDataDir: target, safeCopyRoot: safe }), /安全副本路径含符号链接/);
  assert.deepEqual(fs.readdirSync(external), ['SENTINEL']);
  assert.equal(fs.readFileSync(path.join(external, 'SENTINEL'), 'utf8'), 'unchanged');
});
