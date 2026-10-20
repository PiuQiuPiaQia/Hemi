// 037 Phase A 单测：管理块格式解析/渲染/外部编辑 diff/预算（纯函数）。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTRY_KINDS,
  ENTRY_LIMITS,
  countCodePoints,
  diffExternalDocument,
  parseManagedDocument,
  renderManagedDocument,
  validateEntryContent,
} from './memory-format.mjs';

function entryBlock(entry, overrides = {}) {
  const meta = {
    id: entry.id ?? 'mem-test-1',
    version: entry.version ?? 1,
    kind: entry.kind ?? 'fact',
    sourceRefs: entry.sourceRefs ?? [],
    relatedEntryIds: entry.relatedEntryIds ?? [],
    createdAt: entry.createdAt ?? 1700000000000,
    updatedAt: entry.updatedAt ?? 1700000000000,
    ...overrides,
  };
  const heading = entry.title ? `## ${entry.title}\n` : '';
  return `<!-- hemi-entry ${JSON.stringify(meta)} -->\n${heading}${entry.body ?? ''}\n<!-- /hemi-entry -->`;
}

test('parse：管理块条目（标题+正文+元数据）与 loose 片段交错保留顺序', () => {
  const doc = [
    '旧的一行全局约定',
    '',
    entryBlock({ id: 'mem-a', title: '周报使用英文', body: '本项目交付文档用英文。', kind: 'feedback', version: 2 }),
    '',
    '另一段未包裹文本',
  ].join('\n');
  const parsed = parseManagedDocument(doc);
  assert.equal(parsed.entries.length, 1);
  const entry = parsed.entries[0];
  assert.equal(entry.id, 'mem-a');
  assert.equal(entry.version, 2);
  assert.equal(entry.kind, 'feedback');
  assert.equal(entry.title, '周报使用英文');
  assert.equal(entry.body, '本项目交付文档用英文。');
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.segments.map((s) => s.type), ['loose', 'entry', 'loose']);
});

test('parse：无标题块整体作为 body；条目间 loose 顺序不丢', () => {
  const doc = `${entryBlock({ id: 'mem-b', title: '', body: '只有正文' })}\n尾巴文本`;
  const parsed = parseManagedDocument(doc);
  assert.equal(parsed.entries[0].title, '');
  assert.equal(parsed.entries[0].body, '只有正文');
  assert.equal(parsed.looseSegments.length, 1);
});

test('parse：格式异常降级待整理（未闭合 / JSON 无效 / 非法字段），不丢字', () => {
  const unterminated = '<!-- hemi-entry {"id":"mem-x","version":1} -->\n## 标题\n正文没闭合';
  const badJson = '<!-- hemi-entry {oops} -->\n## t\nb\n<!-- /hemi-entry -->';
  const badVersion = `<!-- hemi-entry ${JSON.stringify({ id: 'mem-y', version: 0 })} -->\n## t\nb\n<!-- /hemi-entry -->`;
  for (const [doc, reason] of [[unterminated, 'unterminated_entry_block'], [badJson, 'invalid_meta_json'], [badVersion, 'invalid_entry_version']]) {
    const parsed = parseManagedDocument(doc);
    assert.equal(parsed.entries.length, 0, reason);
    assert.ok(parsed.issues.some((i) => i.reason === reason), reason);
    // 原文逐字保留在 loose 里（除行尾空白外不修复）。
    assert.ok(parsed.looseSegments.join('\n').includes('## 标题') || parsed.looseSegments.join('\n').includes('b'), reason);
  }
});

test('render：条目规范重排、loose 正文逐字保留，round-trip 稳定', () => {
  const doc = `前言 loose\n\n${entryBlock({ id: 'mem-r', title: '标题', body: '正文', version: 3 })}\n\n后记 loose`;
  const parsed = parseManagedDocument(doc);
  const rendered = renderManagedDocument(parsed.segments);
  assert.ok(rendered.includes('前言 loose'));
  assert.ok(rendered.includes('后记 loose'));
  assert.ok(rendered.includes('"id":"mem-r"'));
  // 再解析＝同一批条目（幂等），正文不变。
  const reparsed = parseManagedDocument(rendered);
  assert.equal(reparsed.entries[0].body, '正文');
  assert.equal(reparsed.entries[0].version, 3);
  assert.equal(renderManagedDocument(reparsed.segments), rendered);
});

test('render：空集合渲染为空字符串（clearScope 后的文件形态）', () => {
  assert.equal(renderManagedDocument([]), '');
  assert.equal(renderManagedDocument(parseManagedDocument('').segments), '');
});

test('diffExternalDocument：修改/新增/删除/loose 变化按 id 判定，版本不算内容', () => {
  const prev = parseManagedDocument([
    entryBlock({ id: 'mem-1', title: 'A', body: 'a', version: 1 }),
    entryBlock({ id: 'mem-2', title: 'B', body: 'b', version: 4 }),
    '旧 loose',
  ].join('\n'));
  const next = parseManagedDocument([
    entryBlock({ id: 'mem-1', title: 'A', body: 'a2', version: 1 }), // 正文变化
    entryBlock({ id: 'mem-3', title: 'C', body: 'c', version: 1 }), // 新增
    '旧 loose',
  ].join('\n'));
  const diff = diffExternalDocument(prev, next);
  assert.deepEqual(diff.removedEntryIds, ['mem-2']);
  const modified = diff.changedEntries.find((c) => c.id === 'mem-1');
  assert.equal(modified.change, 'modified');
  assert.equal(modified.prevVersion, 1);
  assert.ok(diff.changedEntries.some((c) => c.id === 'mem-3' && c.change === 'added'));
  assert.equal(diff.looseChanged, false);

  const onlyVersionBump = parseManagedDocument([
    entryBlock({ id: 'mem-1', title: 'A', body: 'a', version: 9 }),
    entryBlock({ id: 'mem-2', title: 'B', body: 'b', version: 4 }),
    '旧 loose',
  ].join('\n'));
  assert.deepEqual(diffExternalDocument(prev, onlyVersionBump), { changedEntries: [], removedEntryIds: [], looseChanged: false });
});

test('validateEntryContent：标题/正文码点与 kind 枚举', () => {
  assert.equal(validateEntryContent({ title: 't', body: 'b', kind: 'experience' }), null);
  assert.match(validateEntryContent({ title: '', body: 'b' }), /title/);
  assert.match(validateEntryContent({ title: 'x'.repeat(ENTRY_LIMITS.title + 1), body: 'b' }), /title 超过/);
  assert.match(validateEntryContent({ title: 't', body: '字'.repeat(ENTRY_LIMITS.body + 1) }), /body 超过/);
  assert.match(validateEntryContent({ title: 't', body: 'b', kind: 'diary' }), /kind/);
  assert.equal(countCodePoints('a𝐛c'), 3); // 码点计数不是 UTF-16 单元
  assert.deepEqual(ENTRY_KINDS, ['profile', 'fact', 'feedback', 'experience', 'reference']);
});
