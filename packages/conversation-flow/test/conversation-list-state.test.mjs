import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';

const {reconcileConversationList, sortConversationsByUpdatedAt} = await moduleUnderTest('../src/navigation/conversation-list-state.ts');

test('live updates preserve row positions and date groups while updating status and titles', () => {
  const previous = [{id:'new',updatedAt:30,title:'New'}, {id:'old',updatedAt:10,title:'Old'}];
  const incoming = [{id:'old',updatedAt:50,title:'Changed',status:'running'}, {id:'new',updatedAt:30,title:'New'}];
  const rows = reconcileConversationList(previous, incoming);
  assert.deepEqual(rows, [incoming[1], {...incoming[0],updatedAt:10}]);
  assert.equal(incoming[0].updatedAt, 50, 'the source keeps its actual latest timestamp');
  assert.deepEqual(previous.map(item=>item.id), ['new','old']);
});

test('explicit refresh uses actual update times, preserves pinned order and does not promote the selected old row', () => {
  const items = [{id:'old',updatedAt:10},{id:'pin-a',pinned:true,updatedAt:1},{id:'middle',updatedAt:20},{id:'pin-b',pinned:true,updatedAt:100},{id:'new',updatedAt:30}];
  const rows = sortConversationsByUpdatedAt(items);
  assert.deepEqual(rows.map(item=>item.id), ['pin-a','pin-b','new','middle','old']);
  assert.deepEqual(reconcileConversationList(items,rows,true), rows);
  assert.equal(rows.find(item=>item.id==='old').updatedAt,10);
  assert.equal(items[0].id,'old','sorting does not mutate the source');
});

test('new and removed sessions reconcile without restoring deleted rows or changing existing positions', () => {
  const previous = [{id:'a',updatedAt:2},{id:'removed',updatedAt:1},{id:'b',updatedAt:0}];
  const incoming = [{id:'b',updatedAt:20},{id:'new',updatedAt:30},{id:'a',updatedAt:10}];
  assert.deepEqual(reconcileConversationList(previous,incoming), [{id:'new',updatedAt:30},{id:'a',updatedAt:2},{id:'b',updatedAt:0}]);
});

test('cached sessions without timestamps remain usable until fresh metadata arrives', () => {
  const cached = [{id:'legacy'},{id:'recent',updatedAt:10}];
  const incoming = [{id:'legacy',updatedAt:20},{id:'recent',updatedAt:10}];
  assert.deepEqual(sortConversationsByUpdatedAt(cached).map(item=>item.id), ['recent','legacy']);
  assert.deepEqual(sortConversationsByUpdatedAt(incoming).map(item=>item.id), ['legacy','recent']);
});
