import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {updateJsonRecord} from './atomic-json-store.mjs';
import {createFlowStore} from '../services/flow-store.mjs';
import {createConversationStore} from '../history/conversation-store.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hemi-json-worker-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('prepared asynchronous writes retry after a synchronous sibling edit',async t=>{
  const dir=fixture(t),file=path.join(dir,'conv-race.json');fs.writeFileSync(file,JSON.stringify({id:'conv-race',turns:[]}));
  let attempts=0;
  await updateJsonRecord(file,record=>{
    if(++attempts===1){const tmp=file+'.sibling';fs.writeFileSync(tmp,JSON.stringify({...record,turns:[{text:'preserved'}],workspaceId:'project'}));fs.renameSync(tmp,file);}
    return {...record,flow:{revision:2}};
  });
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(attempts,2);assert.equal(saved.turns[0].text,'preserved');assert.equal(saved.workspaceId,'project');assert.equal(saved.flow.revision,2);
  assert.deepEqual(fs.readdirSync(dir),['conv-race.json']);
});
test('concurrent flow updates and one usage batch preserve each other through actual IO',async t=>{
  const dir=fixture(t),id='conv-batch';fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({id,turns:[{id:'u',author:'user',text:'keep',createdAt:1}]}));
  const flow=createFlowStore({dir}),archive=createConversationStore({dir});
  const records=Array.from({length:46},(_,i)=>({source:'chat',input:i+1,output:1,at:i+1}));
  await Promise.all([flow.saveFlow(id,{schemaVersion:1,revision:1}),archive.appendUsageRecordsAsync(id,records),flow.saveFlow(id,{schemaVersion:1,revision:2})]);
  await flow.flush(id);
  const saved=JSON.parse(fs.readFileSync(path.join(dir,id+'.json'),'utf8'));
  assert.equal(saved.flow.revision,2);assert.equal(saved.usageLedger.length,46);assert.equal(saved.turns[0].text,'keep');
});
