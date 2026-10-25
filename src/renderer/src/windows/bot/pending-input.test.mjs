import test from 'node:test';
import assert from 'node:assert/strict';
import {botInputCurrent, botInputObserved, projectPendingBotInputs} from './pending-input.ts';
import {messageViewFromTranscript} from '@hemi/conversation-flow/core';

const input = (extra = {}) => ({conversationId: 'conversation', instanceId: 'bot', generation: 1, requestId: 'send-input', kind: 'send', createdAt: 1,
  input: {inputId: 'input', text: 'same text', attachmentIds: ['file'], attachmentViews: [{attachmentId: 'file'}], references: [{key: 'reference'}], skills: [{skillId: 'skill'}]}, ...extra});
const snapshot = (extra = {}) => ({conversationId: 'conversation', generation: 1, pending: [], timeline: [], runs: {}, ...extra});
const row = (id, author = 'user') => ({id, author, text: id, createdAt: 0});

test('online send appears immediately without changing the Host snapshot or permitting edits', () => {
  const flow = snapshot(), rows = [row('previous')], submission = input();
  const original = structuredClone({flow, rows});
  const displayed = projectPendingBotInputs(flow, rows, [submission]);
  assert.deepEqual(displayed.map(item => item.id), ['previous', 'input']);
  assert.deepEqual(displayed[1].attachments, submission.input.attachmentViews);
  assert.deepEqual(displayed[1].references, submission.input.references);
  assert.deepEqual(displayed[1].skills, submission.input.skills);
  assert.equal(messageViewFromTranscript(displayed[1]).actions.edit, false);
  assert.deepEqual({flow, rows}, original);
});

test('Host delivery replaces the preview by identity; equal text from another device remains separate', () => {
  const submission = input(), rows = [{...row('other'), text: 'same text'}];
  const flow = snapshot({timeline: [{kind: 'user', id: 'other'}]});
  assert.equal(botInputObserved(flow, submission), false);
  assert.deepEqual(projectPendingBotInputs(flow, rows, [submission]).map(item => item.id), ['other', 'input']);
  const delivered = {...flow, timeline: [...flow.timeline, {kind: 'user', id: 'input'}]};
  const authoritative = [...rows, row('input')];
  assert.equal(projectPendingBotInputs(delivered, authoritative, [submission]), authoritative);
  assert.equal(botInputObserved(delivered, submission), true);
});

test('a Host queue owns accepted inputs and a preparing reply stays after its input', () => {
  const submission = input(), preparing = snapshot({runs: {run: {inputIds: ['input']}}});
  const rows = [{...row('waiting', 'hemi'), flow: {runId: 'run'}}];
  assert.deepEqual(projectPendingBotInputs(preparing, rows, [submission]).map(item => item.id), ['input', 'waiting']);
  const queued = {...preparing, pending: [{inputId: 'input', state: 'pending'}]};
  assert.equal(projectPendingBotInputs(queued, [], [submission]).length, 0);
});

test('rewind previews a replacement locally and rolls back by removing only its overlay', () => {
  const rows = [row('prefix'), row('edit'), row('answer', 'hemi'), row('later')];
  const flow = snapshot({timeline: rows.map(item => ({kind: item.author === 'user' ? 'user' : 'assistant', id: item.id}))});
  const original = structuredClone({flow, rows});
  const submission = input({kind: 'rewind', targetInputId: 'edit'});
  assert.deepEqual(projectPendingBotInputs(flow, rows, [submission]).map(item => item.id), ['prefix', 'input']);
  assert.equal(projectPendingBotInputs(flow, rows, []), rows);
  assert.deepEqual({flow, rows}, original);
});

test('another device rewind invalidates a stale preview without hiding newer history', () => {
  const submission = input({kind: 'rewind', targetInputId: 'edit'});
  const rows = [row('prefix'), row('remote-edit'), row('remote-answer', 'hemi')];
  const fresh = snapshot({generation: 2, runs: {remote: {inputIds: ['remote-edit']}}});
  assert.equal(botInputCurrent(fresh, submission), false);
  assert.equal(projectPendingBotInputs(fresh, rows, [submission]), rows);
  assert.equal(projectPendingBotInputs(fresh, rows, [input()]), rows);
});

test('own accepted rewind bridges the new generation before delivery but never another conversation', () => {
  const submission = input({kind: 'rewind', targetInputId: 'edit'});
  const flow = snapshot({generation: 2, runs: {own: {inputIds: ['input']}}});
  assert.equal(botInputCurrent(flow, submission), true);
  assert.deepEqual(projectPendingBotInputs(flow, [], [submission]).map(item => item.id), ['input']);
  assert.equal(projectPendingBotInputs({...flow, conversationId: 'different'}, [], [submission]).length, 0);
  assert.equal(projectPendingBotInputs({...flow, generation: 3}, [], [submission]).length, 0);
});
