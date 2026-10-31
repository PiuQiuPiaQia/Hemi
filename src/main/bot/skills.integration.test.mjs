import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBotCapabilityFixture } from '../../../scripts/lib/bot-capability-fixture.mjs';

test('Bot 实际 Host/SDK：坏项目技能不阻断普通/新会话，修正后目录与驻留会话一起更新', { timeout: 30000 }, async t => {
  const fixture = await createBotCapabilityFixture(() => ({ content: 'SKILL_ISOLATION_OK' }), { capabilityOptions: { platform: 'linux' } });
  t.after(() => fixture.close());
  const workspace = path.join(fixture.root, 'workspace');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const writeSkill = async (name, description) => {
    const dir = path.join(workspace, '.agents/skills', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${name} body`);
  };
  await writeSkill('good', 'GOOD_PROJECT_SKILL');
  await writeSkill('bad', 'Inspect changes. Trigger phrases include: "sync"');
  const first = await fixture.call('session.create');
  const directory = await fixture.call('skills', { id: first.id });
  assert.deepEqual(directory.skills.map(item => item.name), ['good']);
  assert.match(directory.skillsError, /YAML 格式错误/);
  assert.match(directory.skillsError, /bad[\\/]SKILL\.md/);
  for (const id of [first.id, (await fixture.call('session.create')).id]) {
    const detail = await fixture.send(id, 'ORDINARY_INPUT');
    assert.equal(Object.values(detail.flow.runs).at(-1).outcome, 'completed');
    const system = fixture.requests.at(-1).messages.find(message => message.role === 'system').content;
    assert.match(system, /GOOD_PROJECT_SKILL/);
    assert.doesNotMatch(system, /<name>bad<\/name>/);
  }
  const count = fixture.requests.length;
  await assert.rejects(fixture.send(first.id, 'EXPLICIT_BAD', { skills: [{ skillId: 'project:bad', source: 'project', name: 'bad', token: 'bad' }] }), /YAML 格式错误.*bad[\\/]SKILL\.md/);
  assert.equal(fixture.requests.length, count);
  await writeSkill('bad', 'REPAIRED_PROJECT_SKILL');
  await writeSkill('good', 'UPDATED_PROJECT_SKILL');
  const repaired = await fixture.call('skills', { id: first.id });
  assert.deepEqual(repaired.skills.map(item => item.name), ['bad', 'good']);
  assert.equal(repaired.skillsError, '');
  const detail = await fixture.send(first.id, 'REPAIRED_INPUT');
  assert.equal(Object.values(detail.flow.runs).at(-1).outcome, 'completed');
  const system = fixture.requests.at(-1).messages.find(message => message.role === 'system').content;
  assert.match(system, /REPAIRED_PROJECT_SKILL/);
  assert.match(system, /UPDATED_PROJECT_SKILL/);
  assert.doesNotMatch(system, /GOOD_PROJECT_SKILL/);
  await writeSkill('good', 'SAME_PATH_REVISION');
  const updated = await fixture.send(first.id, 'SAME_PATH_UPDATE');
  assert.equal(Object.values(updated.flow.runs).at(-1).outcome, 'completed');
  const latest = fixture.requests.at(-1).messages.find(message => message.role === 'system').content;
  assert.match(latest, /SAME_PATH_REVISION/);
  assert.doesNotMatch(latest, /UPDATED_PROJECT_SKILL/);
});
