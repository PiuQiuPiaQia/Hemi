import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createConversationOperationJournal} from './conversation-operation-journal.mjs';
test('local IPC receipts survive restart, coalesce concurrent requests and never replay pending work',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-command-receipts-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let journal=createConversationOperationJournal({dir}),count=0;const operation={requestId:'same',generation:1},command={type:'resumeQueue'};
 const run=()=>new Promise(resolve=>setTimeout(()=>{count++;resolve({ok:true,revision:2});},10));
 const results=await Promise.all([journal.execute('chat',operation,command,run),journal.execute('chat',operation,command,run)]);assert.equal(count,1);assert.deepEqual(results[0],results[1]);
 journal=createConversationOperationJournal({dir});assert.equal((await journal.execute('chat',operation,command,run)).ok,true);assert.equal(count,1);assert.equal(journal.lookup('chat','same').revision,2);
 assert.equal((await journal.execute('chat',operation,{type:'stop'},run)).code,'conflict');
 const missing={requestId:'uncertain',generation:1};await journal.execute('chat',missing,command,async()=>{count++;throw Error('Lost outcome');});
 journal=createConversationOperationJournal({dir});assert.equal((await journal.execute('chat',missing,command,run)).code,'unknown');assert.equal(count,2);assert.equal(journal.lookup('chat','uncertain'),null);
});
