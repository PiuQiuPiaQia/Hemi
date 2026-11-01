import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskHandoffChannel } from './task-handoff.mjs';

const data = () => ({version:1,summary:'已核对',completed:['读取真实结果'],remaining:[],blockers:[],verification:[],nextAction:''});
test('submission is task scoped, immutable after acceptance and never authorizes more work', async () => {
  let execution = {owner:{conversationId:'c',rootRunId:'r',generation:0,taskId:'a'}}, stopped = false;
  const channel = createTaskHandoffChannel({getExecution:()=>execution,stopped:()=>stopped});
  let tool, guard;
  channel.extension.factory({on:(_event,fn)=>{guard=fn;},registerTool:value=>{tool=value;}});
  channel.begin();
  const bad = await tool.execute('bad',{...data(),summary:' '});
  assert.equal(bad.isError,true); assert.equal(channel.read(),null);
  assert.equal((await tool.execute('first',data())).isError,false);
  assert.equal((await tool.execute('duplicate',data())).isError,false);
  assert.equal((await tool.execute('conflict',{...data(),summary:'different'})).isError,true);
  assert.equal(guard({toolName:'write'}).block,true);
  assert.equal(guard({toolName:'submit_task_result'}),undefined);
  execution = {...execution,owner:{...execution.owner,taskId:'b'}};
  assert.equal(channel.read(),null);
  assert.equal((await tool.execute('stale',data())).isError,true);
  channel.begin(); assert.equal(channel.read(),null);
  channel.setRepair(true); assert.equal(guard({toolName:'bash'}).block,true);
  await tool.execute('fresh',data()); stopped=true;
  assert.equal(channel.read(),null);
  assert.equal((await tool.execute('cancelled',data())).isError,true);
});
