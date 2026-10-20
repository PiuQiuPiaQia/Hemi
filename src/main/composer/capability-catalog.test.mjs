import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLASH_COMMANDS,
  filterSlashCandidates,
  skillCandidatesOf,
  validateSkillSelections,
} from './capability-catalog.mjs';

test('063 R-01：技能候选形状稳定（skillId/name/description/source），同名去重、上限 50', () => {
  const items = [
    { id: 'pdf-1', name: 'pdf', description: '处理 PDF', source: 'library' },
    { id: 'pdf-2', name: 'pdf', description: '同名第二份', source: 'library' },
    { id: 'p:pdf', name: 'pdf', description: '项目同名', source: 'project' },
    { name: '无 id 技能', source: 'library' },
    ...Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, name: `技能${i}`, source: 'library' })),
  ];
  const candidates = skillCandidatesOf(items);
  assert.equal(candidates.length, 50, '超过 50 截断');
  const pdf = candidates.filter((item) => item.name === 'pdf');
  assert.equal(pdf.length, 2, '库/项目同名各留一份');
  assert.deepEqual(pdf.map((item) => item.source).sort(), ['library', 'project']);
  const noId = candidates.find((item) => item.name === '无 id 技能');
  assert.equal(noId.skillId, 'library:无 id 技能', '缺 id 时按 source:name 兜底');
});

test('063 R-01：搜索名称精确/前缀优先于说明弱匹配，保持命令→技能分组', () => {
  const data = {
    commands: SLASH_COMMANDS,
    skills: [
      { skillId: 'a', name: 'model-helper', description: '', source: 'library' },
      { skillId: 'b', name: '表格', description: '把 model 数据导出', source: 'library' },
    ],
  };
  const { commands, skills } = filterSlashCandidates(data, 'model');
  assert.equal(commands[0].id, 'model', '命令名命中排最前');
  assert.equal(skills[0].skillId, 'a', '名称匹配优先于说明匹配');
  const none = filterSlashCandidates(data, '不存在的词');
  assert.deepEqual(none.commands, []);
  assert.deepEqual(none.skills, []);
});

test('063 R-04：派发校验按 skillId+source；不可用如实报缺，不按名字换技能', () => {
  const available = [
    { id: 'pdf-1', name: 'pdf', source: 'library' },
    { id: 'p:pdf', name: 'pdf', source: 'project' },
  ];
  assert.equal(validateSkillSelections(
    [{ token: 'pdf', name: 'pdf', source: 'library', skillId: 'pdf-1' }], available).ok, true);
  assert.equal(validateSkillSelections(
    [{ token: 'pdf', name: 'pdf', source: 'project', skillId: 'p:pdf' }], available).ok, true);
  // 同名但 source 不对：不按显示名换另一份。
  const wrongSource = validateSkillSelections(
    [{ token: 'pdf', name: 'pdf', source: 'library', skillId: 'p:pdf' }], available);
  assert.equal(wrongSource.ok, false);
  const removed = validateSkillSelections(
    [{ token: 'gone', name: 'gone', source: 'library', skillId: 'gone-1' }], available);
  assert.equal(removed.ok, false);
  assert.match(removed.missing[0].reason, /删除|禁用|不可读/);
  assert.equal(validateSkillSelections([], available).ok, true, '空选择恒通过');
});
