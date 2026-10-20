import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from './session-store.mjs';
test('私有条目跨进程恢复，归属与内容校验失败不能作为空会话续用', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'h64-sessions-')); t.after(() => rm(dir, { recursive:true,force:true }));
  const store = createSessionStore({dir}), record = {owner:{conversationId:'c',rootRunId:'old',taskId:'t'},role:'oracle',workspace:{dir:'/tmp'},payload:{header:{type:'session'},entries:[{id:'e',private:'original'}]}};
  await store.save('session-test',record);
  const restored = await createSessionStore({dir}).load('session-test','c'); assert.equal(restored.payload.entries[0].private,'original');
  await assert.rejects(store.load('session-test','another'),/当前对话/);
  const {revision} = JSON.parse(await readFile(path.join(dir,'session-test.json'),'utf8'));
  await writeFile(path.join(dir,`entries-${revision}.json`),JSON.stringify({...restored,role:'fixer'}));
  await assert.rejects(store.load('session-test','c'),/条目损坏/);
  await assert.rejects(store.load('../../escape','c'),/引用无效/);
});
