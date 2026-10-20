// 033 工作区上下文块单测：项目身份/目录概览/说明摘录/边界（非项目、失效、
// 不可读目录、无说明文件、截断上限）。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceContextBlock } from './context.mjs';

function makeProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-wsctx-'));
  return dir;
}

test('项目视图：身份 + 根目录概览（目录带 /）+ AGENTS/README 摘录', () => {
  const dir = makeProject();
  try {
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'package.json'), '{}');
    writeFileSync(path.join(dir, 'AGENTS.md'), '# 项目规范\n全部代码用中文注释。');
    writeFileSync(path.join(dir, 'README.md'), '# Atlas\n这是一个报价管理项目。');
    const block = buildWorkspaceContextBlock({ id: 'ws-x', type: 'project', name: 'Atlas', dir, status: 'ok' });
    assert.match(block, /［工作区 · 当前项目］/);
    assert.match(block, /项目「Atlas」/);
    assert.match(block, /src\//);
    assert.match(block, /package\.json(?!\/)/);
    assert.match(block, /AGENTS\.md（摘录）：\n# 项目规范/);
    assert.match(block, /README\.md（摘录）：\n# Atlas/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('边界：非项目/失效/缺目录不注入；空项目目录不注入（无内容可感知）', () => {
  assert.equal(buildWorkspaceContextBlock(null), '');
  assert.equal(buildWorkspaceContextBlock({ id: 'default', type: 'default', name: '默认空间', dir: '/tmp/x', status: 'ok' }), '');
  assert.equal(buildWorkspaceContextBlock({ id: 'ws', type: 'project', name: 'P', dir: '/tmp/x', status: 'missing' }), '');
  const dir = makeProject();
  try {
    const block = buildWorkspaceContextBlock({ id: 'ws', type: 'project', name: 'P', dir, status: 'ok' });
    // 空目录：只有身份两行 → 不注入。
    assert.equal(block, '');
    // 只放普通文件（无说明文件）：身份 + 目录概览 → 注入。
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    const withEntry = buildWorkspaceContextBlock({ id: 'ws', type: 'project', name: 'P', dir, status: 'ok' });
    assert.match(withEntry, /根目录：a\.txt/);
    assert.ok(!/摘录/.test(withEntry));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('有界：概览条目上限与文件摘录截断', () => {
  const dir = makeProject();
  try {
    for (let i = 0; i < 50; i += 1) writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}.txt`), 'x');
    writeFileSync(path.join(dir, 'AGENTS.md'), '长'.repeat(2000));
    const block = buildWorkspaceContextBlock({ id: 'ws', type: 'project', name: 'P', dir, status: 'ok' });
    assert.match(block, /…（共 \d+\+ 项）/);
    assert.ok(!block.includes('长'.repeat(1300)), '摘录超上限必须截断');
    assert.match(block, /（截断）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
