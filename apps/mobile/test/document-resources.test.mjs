import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {moduleUnderTest} from '../../../packages/conversation-flow/test/compile.mjs';
import {resourceFixture} from './resource-fixture.mjs';
import {pdfFixture,docxFixture,xlsxFixture,pptxFixture} from '../../../scripts/lib/document-fixtures.mjs';
const {createBotResources} = await moduleUnderTest('../../../apps/mobile/test/resource-cache-test-api.ts');

test('actual Host supplies verified original documents, video and scoped body-link chunks', async t => {
  const files={'扫描件.pdf':await fs.readFile(new URL('../../../scripts/fixtures/documents/scan.pdf',import.meta.url)),'预览.pdf':Buffer.from(pdfFixture()),'预览.docx':Buffer.from(docxFixture()),'预览.xlsx':Buffer.from(xlsxFixture()),'预览.pptx':Buffer.from(pptxFixture()),'预览.webm':Buffer.from([0x1a,0x45,0xdf,0xa3])};
  const f=await resourceFixture({additionalFiles:files});t.after(()=>f.close());
  const environmentId=`bot:${f.instanceId}`;
  const resource=createBotResources({environmentId,request:(method,params)=>f.call(method,params)});t.after(()=>resource.dispose());
  const context={scope:{environmentId,conversationId:f.id,generation:'1'},requestId:randomUUID(),signal:new AbortController().signal};
  for(const [name,bytes] of Object.entries(files)) {
    const result=await resource.read({ref:{id:'deliverable:'+f.byName[name],version:'0'},purpose:'preview'},context);
    assert.equal(result.ok,true,name);
    if(name.endsWith('webm'))assert.equal(result.value.content.mimeType,'video/webm');
    else {
      assert.equal(result.value.content.kind,'document');
      const source=result.value.content.source;
      assert.equal(source.format,name.split('.').at(-1));
      if(source.format==='xlsx')assert.ok(source.sheets?.length>0);
      else assert.deepEqual(Buffer.from(source.bytes),bytes);
      if(name==='扫描件.pdf')assert.match(source.textError,/PDF 没有可提取的文字/);
    }
    result.value.release();
  }
  await fs.writeFile(path.join(f.work,'正文预览.pdf'),files['预览.pdf']);
  const link=await f.call('file.resolve',{id:f.id,path:'./正文预览.pdf'});
  const metadata=await f.call('resource.stat',{id:f.id,kind:'link',artifactId:link.artifactId,path:link.path});
  assert.equal(metadata.size,files['预览.pdf'].length);
  await assert.rejects(f.call('resource.stat',{id:f.other,kind:'link',artifactId:link.artifactId,path:link.path}),{code:'missing'});
  await assert.rejects(f.call('resource.stat',{id:f.id,kind:'link',artifactId:link.artifactId,path:'./预览.docx'}),{code:'missing'});
});

test('a client-only iPhone update keeps body links readable on an older Bot without bypassing read authority', async t => {
  const f=await resourceFixture();t.after(()=>f.close());
  const environmentId=`bot:${f.instanceId}`,calls=[];
  const resources=createBotResources({environmentId,request:(method,params)=>{
    calls.push(method);
    if(method==='resource.stat'&&params.kind==='link')throw Object.assign(new Error('文件资源类型无效。'),{code:'invalid'});
    return f.call(method,params);
  }});t.after(()=>resources.dispose());
  const context={scope:{environmentId,conversationId:f.id,generation:'1'},requestId:randomUUID(),signal:new AbortController().signal};
  const link=await resources.resolve({href:'./普通正文.md'},context);assert.equal(link.ok,true);
  const result=await resources.read({ref:link.value,purpose:'preview'},context);
  assert.equal(result.ok,true);assert.equal(result.value.content.text,'# BODY_PREVIEW');
  assert.ok(calls.includes('file.read'));assert.ok(!calls.includes('resource.chunk'));
  result.value.release();
  assert.equal((await resources.read({ref:link.value,purpose:'preview'},{...context,scope:{...context.scope,conversationId:f.other}})).ok,false);
});
