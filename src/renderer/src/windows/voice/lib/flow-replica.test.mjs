import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowReplica } from './flow-replica.ts';
import { createFlowSnapshot, applyFlowFact } from '../../../../../shared/conversation-flow.mjs';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const next = () => new Promise((resolve) => setImmediate(resolve));

test('060：初始 RPC 已读取旧快照时到达最后一条补丁，缓冲并追平，不等新事件', async () => {
  const base = createFlowSnapshot({ conversationId: 'c' });
  const updated = applyFlowFact(base, { type: 'input-accepted', input: { inputId: 'A', text: 'A' } });
  const rpc = deferred(), published = [];
  const replica = createFlowReplica({ fetchSnapshot: () => rpc.promise, publish: (s) => published.push(s) });
  const fetching = replica.refresh();
  replica.receive({ kind: 'patch', conversationId: 'c', generation: 1, baseRevision: 0, revision: 1, changes: [updated.patch] });
  rpc.resolve(base);
  await fetching;
  assert.equal(published.at(-1).revision, 1);
  assert.equal(published.at(-1).pending[0].inputId, 'A');
  replica.dispose();
});

test('060：离开会话后旧重取 RPC 迟到，不能覆盖新会话；重复补丁幂等', async () => {
  const base = createFlowSnapshot({ conversationId: 'old' });
  const rpc = deferred(), published = [];
  const replica = createFlowReplica({ fetchSnapshot: () => rpc.promise, publish: (s) => published.push(s) });
  const fetching = replica.refresh();
  replica.dispose();
  rpc.resolve(base);
  await fetching; await next();
  assert.deepEqual(published, []);
});
