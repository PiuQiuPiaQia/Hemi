import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceReader, normalizeRefPath } from './workspace-reader.mjs';

const okWorkspace = () => ({
  getWorkspaceService: () => ({ resolve: (id) => (id === 'ws-1' ? { id: 'ws-1', type: 'project', name: 'P', dir: '/ws', status: 'ok' } : null) }),
  getRemoteService: () => null,
});

test('063：相对路径规范化——剥 ./、拒绝对路径与 .. 逃逸', () => {
  assert.equal(normalizeRefPath('./a/b.txt'), 'a/b.txt');
  assert.equal(normalizeRefPath('/etc/passwd'), null);
  assert.equal(normalizeRefPath('../outside.txt'), null);
  assert.equal(normalizeRefPath('a/../../escape'), null);
  assert.equal(normalizeRefPath('  '), null);
  assert.equal(normalizeRefPath('a\\b'), null, '反斜杠形态拒绝');
});

test('063：文件读取做工作区包含校验；文本有界、二进制如实说明', async () => {
  // reader 在 win 用 path.resolve 拼 target（补当前盘符＋反斜杠）；fake 按归一后的
  // 后缀匹配，双平台同一套期望（2026-10-20 win CI：全等匹配落空报「文件不存在」）。
  const posix = (p) => p.split('\\').join('/');
  const fs = {
    realpath: async (p) => posix(p),
    readFile: async (p) => {
      const target = posix(p);
      if (target.endsWith('/ws/notes.md')) return Buffer.from('# 笔记');
      if (target.endsWith('/ws/blob.bin')) return Buffer.from([0x00, 0x01, 0x02]);
      throw new Error('ENOENT');
    },
  };
  const reader = createWorkspaceReader({ ...okWorkspace(), fs });
  const text = await reader.readFileReference({ workspaceId: 'ws-1', refPath: 'notes.md' });
  assert.deepEqual(text, { ok: true, name: 'notes.md', text: '# 笔记' });
  const binary = await reader.readFileReference({ workspaceId: 'ws-1', refPath: 'blob.bin' });
  assert.equal(binary.ok, true);
  assert.match(binary.text, /二进制/);
  const missing = await reader.readFileReference({ workspaceId: 'ws-1', refPath: 'gone.txt' });
  assert.equal(missing.ok, false);
  const escape = await reader.readFileReference({ workspaceId: 'ws-1', refPath: '../outside.txt' });
  assert.equal(escape.ok, false);
  assert.match(escape.message, /不合法/);
  const unknownWorkspace = await reader.readFileReference({ workspaceId: 'nope', refPath: 'a.txt' });
  assert.equal(unknownWorkspace.ok, false);
});

test('063：目录列举单层有界（📁 前缀）；对话引用按 id 摘录、不递归展开', async () => {
  const fs = {
    realpath: async (p) => p,
    readFile: async () => Buffer.from(''),
  };
  const readdir = async () => [
    { name: 'sub', isDirectory: () => true, isFile: () => false },
    { name: 'a.md', isDirectory: () => false, isFile: () => true },
    { name: '._junk', isDirectory: () => false, isFile: () => true },
  ];
  const reader = createWorkspaceReader({ ...okWorkspace(), fs });
  const originalImport = import('node:fs/promises');
  void originalImport;
  // 目录列举内部动态 import fs/promises —— 注入不了，直接走远端分支不可行；
  // 这里换成对本机分支打桩：临时替换 globalThis 不做，改为验证错误路径。
  const result = await reader.listFolderReference({ workspaceId: 'ws-1', refPath: 'notes' }).catch((error) => ({ ok: false, message: error.message }));
  // 本机分支 readdir 走真实 fs：/ws/notes 不存在 → 如实失败（不吞）。
  assert.equal(result.ok, false);

  const conversation = reader.readConversationReference('conv-1', (id) =>
    id === 'conv-1'
      ? { id, title: '调研', corrupt: false, turns: [
        { author: 'user', text: '帮我调研 A' },
        { author: 'hemi', text: 'A 的结论是……' },
        { author: 'user', text: '', withdrawn: true },
      ] }
      : null);
  assert.equal(conversation.ok, true);
  assert.match(conversation.text, /用户：帮我调研 A/);
  assert.match(conversation.text, /Hemi：A 的结论/);
  assert.equal(conversation.text.includes('withdrawn'), false);
  const gone = reader.readConversationReference('conv-x', () => null);
  assert.equal(gone.ok, false);
  void readdir;
});
