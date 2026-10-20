// 记忆服务单测：原文编辑面（读取/保存/容量/冲突/取消）与回炉注入块。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CODEPOINT_LIMITS,
  MEMORY_TOOL_GUIDELINES,
  buildMemoryBlock,
  countCodePoints,
  createMemoryService,
} from './memory.mjs';

function makeService() {
  const root = mkdtempSync(path.join(tmpdir(), 'hemi-mem-'));
  const service = createMemoryService({ memoryDir: path.join(root, 'memory') });
  service.ensureReady();
  return { root, service };
}

test('ensureReady：建目录与空文件（记忆始终启用，无开关）', () => {
  const { root, service } = makeService();
  try {
    assert.equal(readFileSync(path.join(root, 'memory', 'USER.md'), 'utf8'), '');
    assert.equal(readFileSync(path.join(root, 'memory', 'MEMORY.md'), 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('设置保存：expectedText 比对保护草稿；清空＝保存空文本', async () => {
  const { root, service } = makeService();
  try {
    const seeded = await service.saveDocument({
      target: 'user', text: '条目甲\n', expectedText: '',
    });
    assert.equal(seeded.ok, true);
    const onDisk = readFileSync(path.join(root, 'memory', 'USER.md'), 'utf8');

    // 草稿基于旧原文，磁盘已被别处更新 → 冲突拒绝，草稿在调用方手里。
    const stale = await service.saveDocument({
      target: 'user', text: '草稿内容', expectedText: '',
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);

    // 带正确原文保存成功。
    const saved = await service.saveDocument({
      target: 'user', text: '手工整理的内容\n', expectedText: onDisk,
    });
    assert.equal(saved.ok, true);
    assert.equal(readFileSync(path.join(root, 'memory', 'USER.md'), 'utf8'), '手工整理的内容\n');

    // 清空。
    const cleared = await service.saveDocument({
      target: 'user', text: '', expectedText: '手工整理的内容\n',
    });
    assert.equal(cleared.ok, true);
    assert.equal(readFileSync(path.join(root, 'memory', 'USER.md'), 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('容量：超限拒绝写入且原文件字节不变；读取保护跳过超大文件', async () => {
  const { root, service } = makeService();
  try {
    const fat = '甲'.repeat(CODEPOINT_LIMITS.memory);
    const seeded = await service.saveDocument({
      target: 'memory', text: fat, expectedText: '',
    });
    assert.equal(seeded.ok, true);

    const over = await service.saveDocument({
      target: 'memory', text: `${fat}再多一条`, expectedText: fat,
    });
    assert.equal(over.ok, false);
    assert.match(over.error, /超出容量/);
    assert.equal(readFileSync(path.join(root, 'memory', 'MEMORY.md'), 'utf8'), fat);

    // 注入：容量写满但未超读取保护的文件正常注入。
    const docs = service.readDocuments();
    assert.equal(docs.memory.issue, null);
    assert.ok(buildMemoryBlock(docs).includes(fat));

    // 外部塞进超过 64KiB 的文件：完整保留、暂停注入、带原因。
    writeFileSync(path.join(root, 'memory', 'MEMORY.md'), '乙'.repeat(70 * 1024));
    const guarded = service.readDocuments();
    assert.equal(guarded.memory.issue, 'oversized');
    assert.equal(guarded.memory.text, null);
    assert.equal(readFileSync(path.join(root, 'memory', 'MEMORY.md'), 'utf8').length, 70 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('注入块：带标签的资料与事实分节；空记忆出空块', () => {
  const block = buildMemoryBlock({
    user: { text: '喜欢简短回答\n', issue: null },
    memory: { text: '项目甲用仓库名 Hemi\n', issue: null },
  });
  assert.ok(block.includes('［长期记忆 · 用户资料（USER.md）］'));
  assert.ok(block.includes('喜欢简短回答'));
  assert.ok(block.includes('［长期记忆 · 全局记忆（MEMORY.md）］'));
  assert.ok(block.includes('项目甲用仓库名 Hemi'));
  assert.equal(countCodePoints(block) > 0, true);
  assert.equal(buildMemoryBlock(null), '');
  assert.ok(MEMORY_TOOL_GUIDELINES.includes('memory_write'));
});

test('取消：提交前检查 signal，已取消不写盘', async () => {
  const { root, service } = makeService();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await service.saveDocument({
      target: 'user', text: '不该落盘', expectedText: '', signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.canceled, true);
    assert.equal(readFileSync(path.join(root, 'memory', 'USER.md'), 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
