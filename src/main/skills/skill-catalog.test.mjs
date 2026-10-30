import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectSkills } from './skill-catalog.mjs';
import { createSkillStore, validateFileSet } from './skill-store.mjs';
import { skillCandidatesOf, validateSkillSelections } from '../composer/capability-catalog.mjs';

const badSkill = '---\nname: broken\ndescription: Inspect changes. Trigger phrases include: "sync"\n---\nBAD_BODY';
const goodSkill = '---\nname: reviewed-name\ndescription: >-\n  Valid project skill\n  with full description.\n---\nGOOD_BODY';

test('Hemi 安装与发现同用严格解析，坏项目技能不影响候选，显式调用给出文件和原因', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hemi-skill-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  const skills = path.join(root, '.agents/skills');
  for (const [name, content] of [['broken', badSkill], ['directory-alias', goodSkill]]) {
    await mkdir(path.join(skills, name), { recursive: true });
    await writeFile(path.join(skills, name, 'SKILL.md'), content);
  }
  assert.throws(() => validateFileSet([{ path: 'SKILL.md', contentBase64: Buffer.from(badSkill).toString('base64') }]), /YAML 格式错误/);
  const warnings = [];
  const catalog = collectSkills({ workspace: { dir: root }, log: { warn: message => warnings.push(message) } });
  t.after(catalog.release);
  const candidates = skillCandidatesOf(catalog.items);
  assert.deepEqual(candidates.map(item => item.name), ['reviewed-name']);
  assert.equal(candidates[0].skillId, 'project:directory-alias');
  assert.equal(catalog.items[0].skill.name, candidates[0].name);
  assert.equal(catalog.items[0].skill.description, candidates[0].description);
  assert.equal(catalog.diagnostics.length, 1);
  assert.match(warnings[0], /broken\/SKILL.md.*YAML 格式错误/);
  const selection = { source: 'project', skillId: 'project:broken', name: 'broken' };
  const verdict = validateSkillSelections([selection], catalog.items, catalog.diagnostics);
  assert.equal(verdict.ok, false);
  assert.match(verdict.missing[0].reason, /YAML 格式错误.*broken\/SKILL.md/);
  assert.equal(validateSkillSelections([], catalog.items, catalog.diagnostics).ok, true);
  const firstRevision = catalog.items[0].revision;
  await writeFile(path.join(skills, 'directory-alias', 'SKILL.md'), goodSkill.replace('Valid project', 'Updated project'));
  const updated = collectSkills({ workspace: { dir: root } });
  t.after(updated.release);
  assert.notEqual(updated.items[0].revision, firstRevision);
});

test('一个已安装技能失效只排除该项，保留其余租约和项目技能，明确选择时拒绝', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hemi-skill-store-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createSkillStore({ root: path.join(root, 'library'), fetchImpl: async () => { throw new Error('offline'); } });
  await store.installMarket('source-check');
  await store.installMarket('meeting-notes');
  const before = store.snapshot();
  const broken = before.items.find(item => item.name === 'source-check');
  before.release();
  const original = await readFile(path.join(broken.path, 'SKILL.md'), 'utf8');
  await writeFile(path.join(broken.path, 'SKILL.md'), badSkill);
  const catalog = collectSkills({ skillService: store });
  t.after(catalog.release);
  assert.deepEqual(catalog.items.map(item => item.name), ['meeting-notes']);
  assert.equal(catalog.diagnostics[0].skillId, broken.id);
  assert.throws(() => store.snapshot(broken.id), /指定的 Skill 不可用.*YAML 格式错误/);
  await writeFile(path.join(broken.path, 'SKILL.md'), original);
  const repaired = store.snapshot();
  t.after(repaired.release);
  assert.equal(repaired.items.length, 2);
});

test('共享解析支持 BOM/CRLF 和调用策略，拒绝与 YAML 语义不符的字段类型', () => {
  const content = '\uFEFF---\r\nname: manual-skill\r\ndescription: "Read: exactly"\r\ndisable-model-invocation: true\r\n---\r\nBody';
  const { metadata } = validateFileSet([{ path: 'SKILL.md', contentBase64: Buffer.from(content).toString('base64') }]);
  assert.equal(metadata.description, 'Read: exactly');
  assert.equal(metadata.disableModelInvocation, true);
  assert.throws(() => validateFileSet([{ path: 'SKILL.md', contentBase64: Buffer.from(content.replace('description: "Read: exactly"', 'description: [list]')).toString('base64') }]), /description/);
});
