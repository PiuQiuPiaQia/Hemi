import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReferenceCandidates, resolveReferencesEnvelope } from './references.mjs';

test('buildReferenceCandidates：三类来源合并、query 过滤、上限 12', () => {
  const candidates = buildReferenceCandidates(
    {
      attachments: [{ attachmentId: 'att-1', name: '项目笔记.md', source: 'picker' }],
      taskArtifacts: [
        { taskId: 't1', artifactId: 'a1', name: '整理结果.md', taskText: '把下载的图片按月份整理好' },
        { taskId: 't2', artifactId: 'a2', name: '报价对比.md', taskText: '查办公椅报价' },
      ],
      contextObjects: [{ id: 'ctx-1', source: '网页', title: 'Hemi 文档' }],
    },
    '',
  );
  assert.equal(candidates.length, 4);
  assert.deepEqual(
    [...new Set(candidates.map((item) => item.kind))].sort(),
    ['artifact', 'attachment', 'context'],
  );

  const filtered = buildReferenceCandidates(
    {
      taskArtifacts: [
        { taskId: 't1', artifactId: 'a1', name: '报价对比.md', taskText: '查办公椅报价' },
        { taskId: 't2', artifactId: 'a2', name: '整理结果.md', taskText: '整理文件' },
      ],
    },
    '报价',
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, '报价对比.md');
  assert.equal(filtered[0].taskId, 't1', '身份字段随候选携带');
});

test('resolveReferencesEnvelope：三来源按身份解析；失效降级说明块（不吞回合）', async () => {
  const envelope = await resolveReferencesEnvelope({
    references: [
      { kind: 'attachment', attachmentId: 'att-1' },
      { kind: 'artifact', taskId: 't1', artifactId: 'a1' },
      { kind: 'context', contextId: 'ctx-1' },
      { kind: 'attachment', attachmentId: 'att-gone' },
    ],
    readAttachment: async (id) =>
      id === 'att-1'
        ? { ok: true, name: '项目笔记.md', scope: '文件', text: '笔记内容甲' }
        : { ok: false, name: '旧附件', message: '已失效' },
    readArtifact: async () => ({ ok: true, name: '整理结果.md', scope: '登记文件', text: '成果内容乙' }),
    readContextObject: async () => ({ ok: true, name: 'Hemi 文档', scope: '网页', capturedAt: Date.now(), text: '页面内容丙' }),
  });
  assert.match(envelope, /引用附件「项目笔记.md」/);
  assert.match(envelope, /笔记内容甲/);
  assert.match(envelope, /引用任务成果「整理结果.md」/);
  assert.match(envelope, /成果内容乙/);
  assert.match(envelope, /引用当前对象「Hemi 文档」/);
  assert.match(envelope, /页面内容丙/);
  assert.match(envelope, /已失效/, '失效引用降级为说明块');

  const empty = await resolveReferencesEnvelope({ references: [] });
  assert.equal(empty, '');
});

test('resolveReferencesEnvelope：读取抛错降级说明块；未知类型忽略', async () => {
  const envelope = await resolveReferencesEnvelope({
    references: [
      { kind: 'context', contextId: 'boom' },
      { kind: 'mystery' },
    ],
    readContextObject: async () => {
      throw new Error('炸了');
    },
  });
  assert.match(envelope, /解析失败：炸了/);
  assert.match(envelope, /未知类型/);
});

// ---- 063：行内引用四类（workflow/file/folder/conversation）----

test('063：候选新增 工作流→文件→文件夹→对话 分组，旧三类排尾部兼容区', () => {
  const candidates = buildReferenceCandidates(
    {
      workflows: [{ workflowId: 'wf-1', name: '周报流程', revision: 3 }],
      workspaceFiles: [
        { refPath: 'docs/plan.md', name: 'plan.md' },
        { refPath: 'src/data.csv', name: 'data.csv' },
      ],
      workspaceFolders: [{ refPath: 'docs', name: 'docs' }],
      conversations: [{ id: 'conv-2', title: '上周调研', updatedHint: '10-01' }],
      attachments: [{ attachmentId: 'att-1', name: '笔记.md', source: 'picker' }],
    },
    '',
  );
  assert.deepEqual(candidates.map((item) => item.kind), ['workflow', 'file', 'file', 'folder', 'conversation', 'attachment']);
  assert.deepEqual(candidates[0], {
    kind: 'workflow', key: 'workflow:wf-1', workflowId: 'wf-1', workflowRevision: 3,
    name: '周报流程', subtitle: '工作流 · v3',
  });
  assert.equal(candidates[1].refPath, 'docs/plan.md');
  assert.equal(candidates[3].name, 'docs');
  assert.equal(candidates[4].targetConversationId, 'conv-2');
  const filtered = buildReferenceCandidates({ workspaceFiles: [{ refPath: 'docs/plan.md', name: 'plan.md' }] }, 'plan');
  assert.equal(filtered.length, 1);
});

test('063：四类行内引用按固定身份解析；失效降级说明块不吞回合', async () => {
  const envelope = await resolveReferencesEnvelope({
    references: [
      { kind: 'workflow', workflowId: 'wf-1', workflowRevision: 3 },
      { kind: 'file', refPath: 'docs/plan.md' },
      { kind: 'folder', refPath: 'docs' },
      { kind: 'conversation', targetConversationId: 'conv-2' },
    ],
    readWorkflow: async () => ({ ok: true, name: '周报流程', revision: 3, text: '{"nodes":[]}' }),
    readFileReference: async () => ({ ok: false, name: 'plan.md', message: '文件不存在' }),
    listFolderReference: async () => ({ ok: true, name: 'docs', text: '📁 sub/\na.md' }),
    readConversation: async () => ({ ok: true, name: '上周调研', text: '用户：调研 A' }),
  });
  assert.match(envelope, /引用工作流「周报流程」（v3 的已保存定义；这里只是引用定义供讨论，不代表已运行）/);
  assert.match(envelope, /引用文件「plan.md」—— 文件不存在/);
  assert.match(envelope, /引用文件夹「docs」的目录清单/);
  assert.match(envelope, /引用对话「上周调研」/);
  assert.match(envelope, /用户：调研 A/);
});

test('063：工作流定义读取失败如实说明；未挂 provider 的类型降级不抛错', async () => {
  const envelope = await resolveReferencesEnvelope({
    references: [
      { kind: 'workflow', workflowId: 'wf-gone' },
      { kind: 'file', refPath: 'x.txt' },
    ],
    readWorkflow: async () => ({ ok: false, message: '定义已删除或版本不存在' }),
  });
  assert.match(envelope, /引用工作流「wf-gone」—— 定义已删除或版本不存在/);
  assert.match(envelope, /引用文件「x.txt」—— 已失效/);
});
