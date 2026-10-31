import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverProjectSkills, skillDescriptionOf } from './project-skills.mjs';

test('项目 Skill：.claude/skills 与 .agents/skills 都收，描述按 frontmatter 读（含块标量）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hemi-ps-'));
  try {
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.claude', 'skills', 'alpha'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 发布到抖音\n---\n正文');
    await mkdir(path.join(root, '.agents', 'skills', 'beta'), { recursive: true });
    await writeFile(path.join(root, '.agents', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: >\n  多行\n  描述\n---\n');
    await mkdir(path.join(root, '.claude', 'skills', 'nodoc'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'skills', 'nodoc', 'SKILL.md'), '没有 frontmatter');
    const diagnostics = [];
    const found = discoverProjectSkills(root, { diagnostics });
    const byName = Object.fromEntries(found.map((s) => [s.name, s.description]));
    assert.equal(byName.alpha, '发布到抖音');
    assert.match(byName.beta, /多行/);
    assert.equal(byName.nodoc, undefined);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].path, /nodoc[\\/]SKILL\.md$/);
    assert.equal(skillDescriptionOf(path.join(root, 'missing')), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
