import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSkillRefs, acquireSkillLease } from './skill-executor.mjs';

const AVAILABLE = [
  { name: 'weekly-report', version: '1.2.3', path: '/s/weekly' },
  { name: 'data-clean', version: '本地导入', path: '/s/clean' },
];

test('resolveSkillRefs：按名命中；声明 semver 时版本比对；本地导入版本不参与比对', () => {
  const ok = resolveSkillRefs({ refs: [{ name: 'weekly-report', version: '1.2.3' }, { name: 'data-clean' }], available: AVAILABLE });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.selected.map((s) => s.name), ['weekly-report', 'data-clean']);

  const mismatch = resolveSkillRefs({ refs: [{ name: 'weekly-report', version: '2.0.0' }], available: AVAILABLE });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.missing[0].reason, /版本不符/);

  const localVersionIgnored = resolveSkillRefs({ refs: [{ name: 'data-clean', version: '本地导入' }], available: AVAILABLE });
  assert.equal(localVersionIgnored.ok, true, '非 semver 声明不比对（受控 sha256 承担版本性）');
});

test('resolveSkillRefs：缺失与空引用', () => {
  const miss = resolveSkillRefs({ refs: [{ name: 'ghost' }], available: AVAILABLE });
  assert.equal(miss.ok, false);
  assert.equal(miss.missing[0].reason, '未安装或已禁用');
  assert.deepEqual(resolveSkillRefs({ refs: [], available: AVAILABLE }).selected, []);
  assert.equal(resolveSkillRefs({ refs: null, available: null }).ok, true);
});

test('acquireSkillLease：命中返回选中 items＋release 幂等；缺失抛 dependency-unavailable 且租约已释放', () => {
  let released = 0;
  const skillService = {
    snapshot: () => ({ items: AVAILABLE, release: () => { released += 1; } }),
  };
  const lease = acquireSkillLease({ refs: [{ name: 'weekly-report' }], skillService });
  assert.deepEqual(lease.items.map((s) => s.name), ['weekly-report']);
  lease.release();
  lease.release();
  assert.equal(released, 1, 'release 幂等');

  assert.throws(
    () => acquireSkillLease({ refs: [{ name: 'ghost' }], skillService }),
    (e) => e.code === 'dependency-unavailable' && /未安装或已禁用/.test(e.message),
  );
  assert.equal(released, 2, '失败路径租约也释放');
});

test('acquireSkillLease：快照失效（文件损坏）与无服务各报 dependency-unavailable', () => {
  assert.throws(
    () => acquireSkillLease({ refs: [{ name: 'x' }], skillService: { snapshot: () => { throw new Error('Skill 文件失效：周报'); } } }),
    (e) => e.code === 'dependency-unavailable' && /Skill 文件失效/.test(e.message),
  );
  assert.throws(
    () => acquireSkillLease({ refs: [{ name: 'x' }], skillService: null }),
    (e) => e.code === 'dependency-unavailable',
  );
});

test('acquireSkillLease：无 refs 直接空租约（不触 snapshot）', () => {
  let called = 0;
  const lease = acquireSkillLease({ refs: [], skillService: { snapshot: () => { called += 1; return { items: [], release: () => {} }; } } });
  assert.deepEqual(lease.items, []);
  assert.equal(called, 0);
});
