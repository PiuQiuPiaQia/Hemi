import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContextStore, projectToolText } from './context-store.mjs';
test('长输出保留首尾错误、明确省略和可完整范围读取；跨根合法、跨对话／派发范围拒绝', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'h64-context-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store = createContextStore({dir}), owner = { conversationId:'c', rootRunId:'old' };
  const content=[{type:'text',text:'START'+'x'.repeat(16000)+'ERROR_EXIT_7'}];
  const ref=await store.put({owner,content,source:{path:'/tmp/source'}});
  const projected=projectToolText(content,ref,200);assert.match(projected[0].text,/START/);assert.match(projected[0].text,/ERROR_EXIT_7/);assert.match(projected[0].text,/省略/);
  const read=await store.read({ref,owner:{conversationId:'c',rootRunId:'new'},offset:16005,limit:100,validateSource:async()=>true});assert.match(read.content[0].text,/ERROR_EXIT_7/);
  await assert.rejects(store.read({ref,owner:{conversationId:'other'}}),/当前对话/);
  await assert.rejects(store.read({ref,owner,allowedRefs:[]}),/派发范围/);
  await assert.rejects(store.read({ref,owner}),/策略不可用/);
  await assert.rejects(store.read({ref,owner,validateSource:async()=>false}),/权限/);
  await assert.rejects(store.read({ref,owner,validateSource:async()=>({allowed:false})}),/权限/);
  const drift=await store.read({ref,owner,validateSource:async()=>({allowed:true,drift:true,sourceState:'changed'})});
  assert.equal(drift.sourceStatus.drift,true);
  await assert.rejects(store.read({ref:'../../private',owner}),/无效/);
});
test('图像引用必须由支持图像的模型读取，不把路径视为图像',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h64-image-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=createContextStore({dir}),owner={conversationId:'c'};
  const ref=await store.put({owner,content:[{type:'image',mimeType:'image/png',data:'actual-image'}]});
  await assert.rejects(store.read({ref,owner}),/unsupported-modality/);
  assert.equal((await store.read({ref,owner,imageInput:true})).content[1].data,'actual-image');
});
