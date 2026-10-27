import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskConversation } from './task-conversation.mjs';
import { createTaskHistory, snapshotFromRecord } from '../history/task-history.mjs';
import { projectTaskFact } from '../services/flow-parts-projection.mjs';

test('child conversation preserves stream order, completed tool outputs, and immutable snapshots', () => {
  const c = createTaskConversation({ taskId: 'child-a', prompt: '核对文件' });
  c.stream({ type: 'hemi_request_start' });
  c.stream({ type: 'thinking_delta', delta: '先读资料' });
  const early = c.snapshot();
  c.stream({ type: 'text_delta', delta: '我先核对文件。' });
  c.progress({ kind: 'tool-start', tool: 'read', toolCallId: 'read-a', args: { path: 'proof.txt' } });
  c.progress({ kind: 'tool-end', tool: 'read', toolCallId: 'read-a', text: 'PROOF', isError: false });
  c.stream({ type: 'hemi_request_start' });
  c.stream({ type: 'text_delta', delta: '核对完成。' });
  c.finish({ report: '核对完成。' });
  const messages = c.snapshot().messages;
  assert.deepEqual(messages.map(m => m.author), ['user', 'hemi', 'hemi']);
  assert.deepEqual(messages[1].parts.map(p => p.type), ['thinking', 'text', 'tools']);
  assert.equal(messages[1].parts[2].calls[0].state, 'done');
  assert.equal(messages[1].parts[2].calls[0].output, 'PROOF');
  assert.equal(messages[2].text, '核对完成。');
  assert.equal(early.messages[1].parts.length, 1);
  assert.equal(early.messages[1].parts[0].endedAt, null);
});

test('retry removes only uncommitted output; stopping closes thinking/tools without a success mark', () => {
  const c = createTaskConversation({ taskId: 'child', prompt: 'test' });
  c.stream({ type: 'hemi_request_start' });
  c.progress({ kind: 'tool-start', tool: 'read', toolCallId: 't1' });
  c.progress({ kind: 'tool-end', tool: 'read', toolCallId: 't1', text: 'kept' });
  c.stream({ type: 'hemi_request_start' });
  c.stream({ type: 'text_delta', delta: 'discarded partial' });
  c.stream({ type: 'hemi_request_reset' });
  c.stream({ type: 'thinking_delta', delta: 'retry thinking' });
  c.progress({ kind: 'tool-start', tool: 'bash', toolCallId: 't2' });
  c.finish({ stopped: true });
  assert.doesNotMatch(JSON.stringify(c.snapshot()), /discarded partial/);
  assert.match(JSON.stringify(c.snapshot()), /kept/);
  assert.equal(c.snapshot().messages.at(-1).parts.at(-1).calls[0].state, 'stopped');
  const final = c.snapshot();
  c.stream({ type: 'text_delta', delta: 'late output' });
  assert.equal(c.snapshot(), final);
});

test('conversation IPC is bounded, omits write payloads, and retains recent calls after forty tools', () => {
  const c = createTaskConversation({ taskId: 'bounded', prompt: 'p'.repeat(100_000) });
  for (let index = 0; index < 190; index++) {
    c.stream({ type: 'hemi_request_start' });
    c.stream({ type: 'thinking_delta', delta: 'think'.repeat(8000) });
    c.progress({ kind: 'tool-start', tool: 'write', toolCallId: `t${index}`, args: { path: `p${index}`, content: 'PRIVATE_WRITE_PAYLOAD' } });
    c.progress({ kind: 'tool-end', tool: 'write', toolCallId: `t${index}`, text: 'result'.repeat(8000) });
  }
  const value = c.snapshot(), json = JSON.stringify(value);
  assert.ok(json.length < 260_000, `snapshot has ${json.length} characters`);
  assert.equal(value.truncated, true);
  assert.equal(value.messages[0].author, 'user');
  assert.match(json, /t189/);
  assert.doesNotMatch(json, /PRIVATE_WRITE_PAYLOAD/);
});

test('actual history files and flow facts preserve the child conversation for reload', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-child-conversation-'));
  try {
    const history = createTaskHistory({ dir });
    const { taskId } = history.createRecord({ taskText: 'read', context: 'read', conversationId: 'parent' });
    const c = createTaskConversation({ taskId, prompt: 'read' });
    c.stream({ type: 'text_delta', delta: 'done' }); c.finish();
    history.finishRecord(taskId, { outcome: 'complete', resultText: 'done', conversation: c.snapshot() });
    const recovered = snapshotFromRecord(createTaskHistory({ dir }).getRecord(taskId), 1);
    assert.deepEqual(recovered.conversation, c.snapshot());
    assert.deepEqual(projectTaskFact(recovered).task.conversation, c.snapshot());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('background call stays pending across model requests and settles in its original message', () => {
  const c=createTaskConversation({taskId:'background',prompt:'push'});
  c.progress({kind:'tool-start',tool:'bash',toolCallId:'push'});
  c.progress({kind:'tool-end',tool:'bash',toolCallId:'push',background:true,text:'ACCEPTED'});
  c.stream({type:'hemi_request_start'});
  c.stream({type:'text_delta',delta:'Independent work'});
  const call=()=>c.snapshot().messages[1].parts[0].calls[0];
  assert.equal(call().state,'running');
  c.progress({kind:'tool-end',tool:'bash',toolCallId:'push',isError:true,text:'exit=7 · failed'});
  assert.equal(call().state,'error');assert.match(call().output,/exit=7/);
  c.progress({kind:'tool-end',tool:'bash',toolCallId:'push',background:true,text:'LATE_ACK'});
  assert.equal(call().state,'error');assert.doesNotMatch(call().output,/LATE_ACK/);
  assert.equal(c.snapshot().messages.at(-1).text,'Independent work');
});

test('repeated provider tool IDs cannot settle another background command',()=>{
  const c=createTaskConversation({taskId:'collision',prompt:'two pushes'});
  for(const commandId of ['job-a','job-b']){
    c.progress({kind:'tool-start',tool:'bash',toolCallId:'call-0'});
    c.progress({kind:'tool-end',tool:'bash',toolCallId:'call-0',commandId,background:true});
    c.stream({type:'hemi_request_start'});
  }
  c.progress({kind:'tool-end',tool:'bash',toolCallId:'call-0',commandId:'job-a',text:'FIRST_DONE'});
  const calls=c.snapshot().messages.flatMap(m=>(m.parts??[]).flatMap(p=>p.type==='tools'?p.calls:[]));
  assert.equal(calls[0].state,'done');assert.equal(calls[1].state,'running');assert.equal(calls[0].output,'FIRST_DONE');
  c.progress({kind:'tool-end',tool:'bash',toolCallId:'call-0',commandId:'job-b',text:'SECOND_FAILED',isError:true});
  const final=c.snapshot().messages.flatMap(m=>(m.parts??[]).flatMap(p=>p.type==='tools'?p.calls:[]));
  assert.equal(final[1].state,'error');assert.equal(final[1].output,'SECOND_FAILED');
});
