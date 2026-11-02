import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {acquireAgentEnvironment} from '../../src/main/agent-runtime/process-environment.mjs';
import {createBotCapabilityFixture} from '../lib/bot-capability-fixture.mjs';

const listeners=()=>process.getActiveResourcesInfo().filter(value=>value==='TCPServerWrap').length;
test('failed real Host initialization closes the fixture listener and temporary root', async t=>{
 const owner=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-fixture-owner-'));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-fixture-failed-'));
 const environment=acquireAgentEnvironment({dataDir:owner});
 t.after(async()=>{environment.release();await fs.rm(owner,{recursive:true,force:true});await fs.rm(root,{recursive:true,force:true});});
 const before=listeners();
 await assert.rejects(createBotCapabilityFixture(()=>({content:'UNUSED'}),{root}),/一个执行进程只能属于/);
 await setImmediate();await setImmediate();
 assert.equal(listeners(),before);
 await assert.rejects(fs.stat(root),{code:'ENOENT'});
});
test('fixture close shares one cleanup and remains idempotent', async()=>{
 const fixture=await createBotCapabilityFixture(()=>({content:'UNUSED'}));
 await Promise.all([fixture.close(),fixture.close()]);
 await fixture.close();
 await assert.rejects(fs.stat(fixture.root),{code:'ENOENT'});
});
