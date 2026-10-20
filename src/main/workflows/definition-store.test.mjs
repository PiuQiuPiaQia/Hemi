import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefinitionStore, contentHash, DEFINITION_ERRORS } from './definition-store.mjs';

/** 内存 fs：单文件即真相，验证原子写（tmp＋rename）语义。 */
function memoryFs() {
  const files = new Map();
  let renameCalls = 0;
  // 键归一成 POSIX 形态：store 在 win 用 path.join 产反斜杠路径，测试侧白盒
  // reach-in（如 unlink('/ud/.../head.json')）是正斜杠——不归一则两套拼写对不上
  // （2026-10-20 win CI：readdir 前缀拼不上→list 归零、unlink 落空→恢复失败）。
  const normalize = (p) => p.replace(/\\/g, '/').replaceAll(/\/+/g, '/').replace(/\/$/, '');
  return {
    files,
    renameCalls: () => renameCalls,
    ops: {
      mkdir: async () => {},
      readFile: async (p) => {
        const v = files.get(normalize(p));
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFile: async (p, data) => {
        files.set(normalize(p), data);
      },
      rename: async (a, b) => {
        renameCalls += 1;
        const v = files.get(normalize(a));
        if (v === undefined) throw new Error(`ENOENT rename: ${a}`);
        files.delete(normalize(a));
        files.set(normalize(b), v);
      },
      unlink: async (p) => {
        files.delete(normalize(p));
      },
      readdir: async (p) => {
        const prefix = normalize(p) + '/';
        const direct = new Set();
        for (const f of [...files.keys()].filter((k) => k.startsWith(prefix))) {
          direct.add(f.slice(prefix.length).split('/')[0]);
        }
        return [...direct];
      },
    },
  };
}

const SIMPLE_GRAPH = {
  nodes: [
    { id: 'in', type: 'hemi-input', meta: { position: { x: 0, y: 0 } }, data: { parameters: [{ key: 'topic', type: 'string', required: true }] } },
    { id: 'agent', type: 'hemi-agent', meta: { position: { x: 1, y: 0 } }, data: { title: '起草', goal: '按主题起草', outputSchema:{type:'object',properties:{result:{type:'string'}}} } },
    { id: 'deliver', type: 'hemi-deliver', meta: { position: { x: 2, y: 0 } }, data: { title: '交付', summary: '交付说明' } },
  ],
  edges: [
    { sourceNodeID: 'in', targetNodeID: 'agent' },
    { sourceNodeID: 'agent', targetNodeID: 'deliver' },
  ],
};

test('saveDraft 往返：draftRevision 递增、expected 冲突拒且不清数据', async () => {
  const mem = memoryFs();
  const store = createDefinitionStore({ dir: '/ud/workflows', fsOps: mem.ops });
  const first = await store.saveDraft({ workflowId: 'wf1', name: '周报', document: SIMPLE_GRAPH });
  assert.equal(first.draftRevision, 1);
  const second = await store.saveDraft({ workflowId: 'wf1', document: SIMPLE_GRAPH, expectedDraftRevision: 1 });
  assert.equal(second.draftRevision, 2);
  await assert.rejects(
    () => store.saveDraft({ workflowId: 'wf1', document: SIMPLE_GRAPH, expectedDraftRevision: 1 }),
    (e) => e.code === DEFINITION_ERRORS.revisionConflict
  );
  const draft = await store.getDraft('wf1');
  assert.equal(draft.draftRevision, 2, '冲突请求不得改写数据');
  assert.equal(draft.name, '周报', '旧 name 保留');
});

test('publish：校验通过才出 revision，版本递增，head 落盘，草稿保留', async () => {
  const mem = memoryFs();
  const store = createDefinitionStore({ dir: '/ud/workflows', fsOps: mem.ops });
  await store.saveDraft({ workflowId: 'wf1', name: '周报', document: SIMPLE_GRAPH });
  const pub1 = await store.publish({ workflowId: 'wf1' });
  assert.equal(pub1.revision, 1);
  const pub2 = await store.publish({ workflowId: 'wf1', expectedRevision: 1 });
  assert.equal(pub2.revision, 2);
  const head = await store.getHead('wf1');
  assert.equal(head.revision, 2);
  assert.equal(head.contentHash, pub2.contentHash);
  const rev = await store.getRevision('wf1', 1);
  assert.equal(rev.document.nodes.length, 3);
  assert.equal((await store.getDraft('wf1')).draftRevision, 1, '发布不清草稿');
  assert.equal(rev.contentHash, contentHash(rev.document));
});

test('publish：图校验失败带定位错误、不出 revision；expected 冲突拒', async () => {
  const mem = memoryFs();
  const store = createDefinitionStore({ dir: '/ud/workflows', fsOps: mem.ops });
  const bad = { nodes: [{ id: 'a', type: 'hemi-agent', meta: {}, data: { goal: 'x' } }], edges: [] };
  await store.saveDraft({ workflowId: 'wf1', document: bad });
  await assert.rejects(
    () => store.publish({ workflowId: 'wf1' }),
    (e) => {
      assert.equal(e.code, DEFINITION_ERRORS.invalidGraph);
      assert.ok(e.issues.length > 0);
      assert.ok(e.issues.some((i) => i.code === 'input-cardinality' || i.code === 'no-delivery'));
      return true;
    }
  );
  assert.equal(await store.getHead('wf1'), null, '校验失败不出 revision');
  // expectedRevision 冲突
  await store.saveDraft({ workflowId: 'wf2', document: SIMPLE_GRAPH });
  await store.publish({ workflowId: 'wf2' });
  await assert.rejects(
    () => store.publish({ workflowId: 'wf2', expectedRevision: 9 }),
    (e) => e.code === DEFINITION_ERRORS.revisionConflict
  );
});

test('发布写序：revision 成功 head 失败时，head 仍指旧版（孤立 revision 不冒进），head 丢失才从文件恢复', async () => {
  const mem = memoryFs();
  let failHead = false;
  const ops = {
    ...mem.ops,
    rename: async (a, b) => {
      if (failHead && b.includes('head.json')) throw new Error('disk full');
      return mem.ops.rename(a, b);
    },
  };
  const store = createDefinitionStore({ dir: '/ud/workflows', fsOps: ops });
  await store.saveDraft({ workflowId: 'wf1', document: SIMPLE_GRAPH });
  await store.publish({ workflowId: 'wf1' });
  failHead = true;
  await store.saveDraft({ workflowId: 'wf1', document: SIMPLE_GRAPH });
  await assert.rejects(() => store.publish({ workflowId: 'wf1', expectedRevision: 1 }), /disk full/);
  failHead = false;
  // 契约 §6：孤立 revision 可回收但不改变旧 head——旧 head（rev 1）仍是权威
  const head = await store.getHead('wf1');
  assert.equal(head.revision, 1);
  assert.equal(head.recovered, undefined);
  // head 文件整个丢失（崩溃时序更糟的一档）：从 revision 文件恢复最新
  await mem.ops.unlink('/ud/workflows/definitions/wf1/head.json');
  const recovered = await store.getHead('wf1');
  assert.equal(recovered.revision, 2, '从孤立 revision 恢复');
  assert.equal(recovered.recovered, true);
});

test('list 与 remove：目录即真相', async () => {
  const mem = memoryFs();
  const store = createDefinitionStore({ dir: '/ud/workflows', fsOps: mem.ops });
  await store.saveDraft({ workflowId: 'wf1', name: 'A', document: SIMPLE_GRAPH });
  await store.saveDraft({ workflowId: 'wf2', name: 'B', document: SIMPLE_GRAPH });
  await store.publish({ workflowId: 'wf2' });
  const rows = await store.list();
  assert.equal(rows.length, 2);
  const wf2 = rows.find((r) => r.workflowId === 'wf2');
  assert.equal(wf2.published.revision, 1);
  assert.equal(wf2.hasDraft, true);
  assert.deepEqual(wf2.parameters,SIMPLE_GRAPH.nodes.find(node=>node.type==='hemi-input').data.parameters);
  const wf1 = rows.find((r) => r.workflowId === 'wf1');
  assert.equal(wf1.published, null, '只有草稿的工作流无 published');
  await store.remove('wf1');
  assert.equal((await store.list()).length, 1);
});

test('原子替换：每次写入都走 tmp＋rename，无原地覆盖', async () => {
  const mem = memoryFs();
  const store = createDefinitionStore({ dir: '/ud/workflows', fsOps: mem.ops });
  await store.saveDraft({ workflowId: 'wf1', document: SIMPLE_GRAPH });
  await store.saveDraft({ workflowId: 'wf1', document: SIMPLE_GRAPH });
  assert.ok(mem.renameCalls() >= 2);
  const leftovers = [...mem.files.keys()].filter((f) => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, 'tmp 文件不残留');
});

test('非法 workflowId 快速拒绝（同步或异步都表现为 rejection）', async () => {
  const store = createDefinitionStore({ dir: '/ud/workflows', fsOps: memoryFs().ops });
  await assert.rejects(Promise.resolve().then(() => store.saveDraft({ workflowId: '../evil', document: SIMPLE_GRAPH })));
  await assert.rejects(Promise.resolve().then(() => store.publish({ workflowId: 'x/y' })));
});
