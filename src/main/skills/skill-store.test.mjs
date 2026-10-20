import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSkillStore, OFFICIAL_CATALOG_URL, validateFileSet } from './skill-store.mjs';

async function withStore(callback, fetchImpl = async () => { throw new Error('offline'); }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hemi-skill-test-'));
  try { await callback(createSkillStore({ root, fetchImpl }), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const official = new URL('./official/', import.meta.url);

test('文件数上限 256：百文件包通过校验（2026-10-09 自 64 上调，87 文件的真实技能曾被拒）', () => {
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: many-files\ndescription: 多文件技能\n---\n').toString('base64') }];
  for (let index = 0; index < 100; index += 1) {
    files.push({ path: `references/${index}.md`, contentBase64: Buffer.from('x').toString('base64') });
  }
  const { files: validated } = validateFileSet(files);
  assert.equal(validated.length, 101);
});

test('frontmatter 块标量（>/|）的 description 可解析为完整文本', () => {
  const folded = '---\nname: block-demo\ndescription: >\n  四柱八字命理分析。\n  Triggers: "算八字", "bazi"。\n---\n\n# 用法\n';
  const { metadata } = validateFileSet([{ path: 'SKILL.md', contentBase64: Buffer.from(folded).toString('base64') }]);
  assert.equal(metadata.description, '四柱八字命理分析。 Triggers: "算八字", "bazi"。');
  const literal = '---\nname: block-demo\ndescription: |-\n  第一行\n  第二行\n---\n\n# 用法\n';
  assert.equal(
    validateFileSet([{ path: 'SKILL.md', contentBase64: Buffer.from(literal).toString('base64') }]).metadata.description,
    '第一行\n第二行',
  );
});

test('内置三项真实包可离线安装，启停持久化，卸载不删本地来源', async () => {
  await withStore(async (store, root) => {
    assert.equal(store.state().catalog.length, 3);
    for (const item of store.state().catalog) {
      const result = await store.installMarket(item.id);
      assert.equal(result.ok, true);
      assert.equal(result.skill.name, item.name);
      assert.equal((await store.readSkill(result.skill.id)).includes('---'), true);
    }
    const selected = store.snapshot('market:source-check');
    assert.equal(selected.items.length, 3);
    assert.equal(selected.selectedId, 'market:source-check');
    selected.release();
    await store.setEnabled('market:source-check', false);
    assert.throws(() => store.snapshot('market:source-check'), /未安装或已禁用/);
    const reopened = createSkillStore({ root, fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(reopened.state().installed.find((item) => item.id === 'market:source-check')?.enabled, false);
    const source = path.join(root, 'original');
    await mkdir(source);
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: local-demo\ndescription: 本地演示技能\n---\n\n# 用法\n');
    const local = await reopened.importDirectory(source);
    assert.equal(local.skill.origin, 'local');
    await reopened.remove(local.skill.id);
    assert.equal(existsSync(path.join(source, 'SKILL.md')), true);
  });
});

test('非法源、重名和链接拒绝，已有版本保持可用', async () => {
  await withStore(async (store, root) => {
    await store.installMarket('source-check');
    const source = path.join(root, 'bad');
    await mkdir(source);
    await assert.rejects(() => store.importDirectory(source), /缺少 SKILL.md/);
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: source-check\ndescription: 重名技能\n---\n');
    await assert.rejects(() => store.importDirectory(source), /同名 Skill/);
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: local-test\n---\n');
    await assert.rejects(() => store.importDirectory(source), /description/);
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: local-test\ndescription: 有效描述\n---\n');
    await writeFile(path.join(source, 'engine.dylib'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00, 0x00, 0x01]));
    await assert.rejects(() => store.importDirectory(source), /可执行内容/);
    await rm(path.join(source, 'engine.dylib'));
    await symlink(path.join(source, 'SKILL.md'), path.join(source, 'link.md'));
    await assert.rejects(() => store.importDirectory(source), /符号链接/);
    assert.equal(store.state().installed.length, 1);
  });
});

test('更新保留在途快照；篡改包、越界路径和目录损坏不替换旧版', async () => {
  const originalCatalog = JSON.parse(await readFile(new URL('catalog.json', official)));
  const originalBundle = JSON.parse(await readFile(new URL('bundles/source-check-1.0.0.json', official)));
  const updated = structuredClone(originalBundle);
  updated.files.find((file) => file.path === 'SKILL.md').contentBase64 = Buffer.from(
    Buffer.from(updated.files.find((file) => file.path === 'SKILL.md').contentBase64, 'base64').toString('utf8') + '\n新版操作提示。\n',
  ).toString('base64');
  const updatedBytes = Buffer.from(JSON.stringify(updated) + '\n');
  const catalog = structuredClone(originalCatalog);
  catalog.publishedAt = '2026-10-02';
  Object.assign(catalog.items.find((item) => item.id === 'source-check'), {
    version: '1.1.0',
    package: 'bundles/source-check-1.1.0.json',
    sha256: hash(updatedBytes),
  });
  const packages = new Map([
    [OFFICIAL_CATALOG_URL, Buffer.from(JSON.stringify(catalog))],
    [new URL('bundles/source-check-1.1.0.json', OFFICIAL_CATALOG_URL).href, updatedBytes],
  ]);
  const fetchImpl = async (url) => new Response(packages.get(url) ?? '', { status: packages.has(url) ? 200 : 404 });
  await withStore(async (store) => {
    await store.installMarket('source-check');
    const old = store.snapshot('market:source-check');
    const oldPath = old.items[0].path;
    assert.equal((await store.refreshCatalog()).ok, true);
    assert.equal(store.state().installed[0].updateAvailable, true);
    await store.installMarket('source-check');
    const newer = store.snapshot('market:source-check');
    assert.notEqual(newer.items[0].path, oldPath);
    assert.equal(existsSync(oldPath), true);
    packages.set(new URL('bundles/source-check-1.1.0.json', OFFICIAL_CATALOG_URL).href, Buffer.from('tampered'));
    await assert.rejects(() => store.installMarket('source-check'), /SHA-256/);
    assert.equal(store.state().installed[0].version, '1.1.0');
    const malicious = Buffer.from(JSON.stringify({ schema: 1, files: [
      ...updated.files,
      { path: '../escape.md', contentBase64: Buffer.from('escape').toString('base64') },
    ] }));
    catalog.items.find((item) => item.id === 'source-check').sha256 = hash(malicious);
    packages.set(OFFICIAL_CATALOG_URL, Buffer.from(JSON.stringify(catalog)));
    packages.set(new URL('bundles/source-check-1.1.0.json', OFFICIAL_CATALOG_URL).href, malicious);
    await store.refreshCatalog();
    await assert.rejects(() => store.installMarket('source-check'), /文件路径/);
    assert.equal(store.state().installed[0].version, '1.1.0');
    packages.set(OFFICIAL_CATALOG_URL, Buffer.from('{ invalid'));
    assert.equal((await store.refreshCatalog()).ok, false);
    assert.equal(store.state().catalog.length, 3);
    old.release();
    newer.release();
    await store.prune();
    assert.equal(existsSync(oldPath), false);
  }, fetchImpl);
});

test('损坏登记文件保留受控副本并明确阻止覆盖', async () => {
  await withStore(async (store, root) => {
    await store.installMarket('meeting-notes');
    const versionPath = store.snapshot().items[0].path;
    await writeFile(path.join(root, 'index.json'), '{ invalid');
    const reopened = createSkillStore({ root, fetchImpl: async () => { throw new Error('offline'); } });
    assert.match(reopened.state().storageError, /登记文件损坏/);
    await reopened.prune();
    assert.equal(existsSync(versionPath), true);
    await reopened.prune();
    await assert.rejects(() => reopened.installMarket('source-check'), /登记文件损坏/);
  });
});

test('skillsmp 登记身份被篡改时按损坏处理，受控副本保留', async () => {
  await withStore(async (store, root) => {
    const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: mp-demo\ndescription: 市场技能\n---\n').toString('base64') }];
    const bytes = Buffer.from(JSON.stringify({ schema: 1, files }) + '\n');
    const result = await store.installFromSnapshot({
      skillsmpId: 'demo-org-skills-mp-demo-skill-md', githubUrl: 'https://github.com/demo-org/skills/tree/main/skills/mp-demo',
      skillsmpUrl: 'https://skillsmp.com/creators/demo-org/skills-mp-demo',
      repo: 'demo-org/skills', dirPath: 'skills/mp-demo', commit: 'a'.repeat(40),
      files: [{ path: 'SKILL.md', bytes: Buffer.from('---\nname: mp-demo\ndescription: 市场技能\n---\n') }],
      metadata: { name: 'mp-demo', title: 'mp-demo', description: '市场技能' },
    });
    assert.equal(result.skill.origin, 'skillsmp');
    const index = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8'));
    index.installed[0].github.commit = 'not-a-sha';
    await writeFile(path.join(root, 'index.json'), JSON.stringify(index));
    const reopened = createSkillStore({ root, fetchImpl: async () => { throw new Error('offline'); } });
    assert.match(reopened.state().storageError, /登记文件损坏/);
    assert.equal(reopened.state().installed.length, 0);
    assert.throws(() => reopened.snapshot('skillsmp:demo-org-skills-mp-demo-skill-md'), /未安装或已禁用/);
  });
});
