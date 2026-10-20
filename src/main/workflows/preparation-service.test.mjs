import assert from 'node:assert/strict';
import test from 'node:test';

import { validateExtraction } from './preparation-service.mjs';

const PARAMETERS = [
  { key: 'topic', type: 'string', label: '主题', required: true },
  { key: 'format', type: 'enum', label: '格式', options: ['ppt', 'text'], required: true },
  { key: 'weeks', type: 'number', label: '周数' },
  { key: 'urgent', type: 'boolean', label: '加急' },
];

test('validateExtraction：合法 set 收敛类型、未声明字段拒绝、unset 清除', () => {
  const verdict = validateExtraction({
    parameters: PARAMETERS,
    current: { topic: '旧主题' },
    extracted: {
      set: { topic: '月报', format: 'PPT', weeks: '4', urgent: '是', hacker: 'x' },
      unset: ['weeks', 'ghost'],
    },
  });
  assert.equal(verdict.ok, true, '必填全部补齐');
  assert.equal(verdict.values.topic, '月报');
  assert.equal(verdict.values.format, 'ppt', '枚举大小写归一');
  assert.equal(verdict.values.weeks, 4);
  assert.equal(verdict.values.urgent, true);
  assert.equal('ghost' in verdict.values, false, '未声明字段不进 values');
  assert.deepEqual(verdict.rejected.sort(), ['ghost', 'hacker']);
});

test('validateExtraction：枚举越界、数字非数、布尔不识各报 invalid-value', () => {
  const bad = validateExtraction({
    parameters: PARAMETERS,
    current: { topic: 't', format: 'ppt' },
    extracted: { set: { format: 'word', weeks: '很多', urgent: '也许' } },
  });
  const fields = Object.fromEntries(bad.issues.filter((i) => i.code === 'invalid-value').map((i) => [i.field, true]));
  assert.ok(fields.format && fields.weeks && fields.urgent);
  assert.equal(bad.values.format, 'ppt', '越界值不覆盖旧值');
});

test('validateExtraction：空串不算清除也不算缺（missing 用空判定）', () => {
  const verdict = validateExtraction({
    parameters: PARAMETERS,
    current: { topic: '' },
    extracted: { set: { format: 'text', topic: '' } },
  });
  assert.equal(verdict.values.topic, '');
  assert.ok(verdict.issues.some((i) => i.code === 'missing-input' && i.field === 'topic'));
});

test('validateExtraction：零参数与可选空输入可就绪，真正必填仍阻止启动', () => {
  assert.equal(validateExtraction({ parameters: [], current: {}, extracted: {} }).ok, true);
  assert.equal(validateExtraction({ parameters: [{ key: 'idea', type: 'text' }], current: {}, extracted: {} }).ok, true);
  const required = validateExtraction({ parameters: PARAMETERS, current: {}, extracted: {} });
  assert.equal(required.ok, false);
  assert.deepEqual(required.issues.filter(issue => issue.code === 'missing-input').map(issue => issue.field), ['topic', 'format']);
});
