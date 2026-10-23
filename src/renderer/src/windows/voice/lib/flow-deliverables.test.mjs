import assert from 'node:assert/strict';
import test from 'node:test';
import { flowDeliverableParts } from './flow-deliverables.ts';
import { createFlowTimelineProjector } from './flow-timeline-view.ts';

const row = (itemId, runId, parts, afterInputId = 'input') => ({ kind: 'assistant', itemId, runId, parts, afterInputId });
const text = content => ({ partId: 'text', kind: 'text', content });
const read = path => ({ partId: `read:${path}`, kind: 'tool', tool: 'read', args: { path }, status: 'done' });
const artifact = { artifactId: 'image', kind: 'file', name: 'cover.png', path: '/workspace/public/episode/cover.png',
  previewKind: 'image', contentVersion: 2, producers: [{ runId: 'r2', generation: 1 }] };
const snapshot = timeline => ({ conversationId: 'demo', generation: 1, revision: 1, timeline,
  runs: { r1: { closedAt: 2 }, r2: { closedAt: 4 } }, tasks: {}, artifacts: { image: artifact } });

test('旧会话：已交付目录与已登记图片的成功读取相交，恢复生成回合；参考图不成为成果', () => {
  const flow = snapshot([
    row('generated', 'r1', [read(artifact.path), read('/workspace/references/ref.png'), text('封面存在 `public/episode/`。')]),
    row('answer', 'r2', [text('两张图在这里。')]),
    row('orphan', 'r2', [{ partId: 'delivery', kind: 'deliverable', artifactId: 'image', name: 'cover.png' }], null),
  ]);
  const before = structuredClone(flow);
  const cards = flowDeliverableParts(flow);
  assert.deepEqual(cards.get('generated').filter(p => p.kind === 'deliverable').map(p => p.artifactId), ['image']);
  assert.equal(cards.get('answer').at(-1).artifactId, 'image');
  assert.equal(cards.has('orphan'), false);
  assert.deepEqual(flow, before);
  const noHandover = flowDeliverableParts(snapshot([row('read-only', 'r1', [read(artifact.path), text('我先读取参考图。')])]));
  assert.equal(noHandover.get('read-only').filter(p => p.kind === 'deliverable').length, 0);
});

test('只剩 registry 的成果恢复到对应回合；正文链接无登记仍提供受控读取候选', () => {
  const cards = flowDeliverableParts(snapshot([row('answer', 'r2', [text('[报告](<./本轮 报告.pdf>)')])]));
  const files = cards.get('answer').filter(p => p.kind === 'deliverable');
  assert.deepEqual(files.map(p => p.artifactId), ['', 'image']);
  assert.equal(files[0].linkPath, './本轮 报告.pdf');
  assert.equal(files[1].contentVersion, 2);
});

test('相同快照的成果行缓存稳定，版本变化后重新投影；回卷撤掉的成果不恢复', () => {
  const project = createFlowTimelineProjector();
  const flow = snapshot([row('answer', 'r2', [{ partId: 'd', kind: 'deliverable', artifactId: 'image' }])]);
  const first = project(flow).transcripts;
  assert.strictEqual(project({ ...flow, revision: 2 }).transcripts[0], first[0]);
  const updated = project({ ...flow, artifacts: { image: { ...artifact, contentVersion: 3 } } }).transcripts;
  assert.equal(updated[0].parts[0].contentVersion, 3);
  assert.notStrictEqual(first[0], updated[0]);
  assert.equal(project({ ...flow, timeline: [] }).transcripts.length, 0);
});

test('relative delivery links resolve to their own producing run after a directory switch',()=>{
 const a={artifactId:'old-report',kind:'file',name:'report.md',path:'/old/report.md',producerRunId:'r1'},b={...a,artifactId:'new-report',path:'/new/report.md',producerRunId:'r2'};
 const flow={...snapshot([row('old','r1',[text('[报告](report.md)')]),row('new','r2',[text('[报告](report.md)')])]),artifacts:{a,b}};
 const parts=flowDeliverableParts(flow);assert.deepEqual(parts.get('old').filter(p=>p.kind==='deliverable').map(p=>p.artifactId),['old-report']);assert.deepEqual(parts.get('new').filter(p=>p.kind==='deliverable').map(p=>p.artifactId),['new-report']);
});
