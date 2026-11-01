import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRunJournal} from './run-journal.mjs';
import {readRunJournal} from './journal-storage.mjs';
const owner={conversationId:'fixture',rootRunId:'root',generation:1};
const empty=()=>({version:2,roots:{},dispatches:{},tasks:{},inbox:{},requests:{},observations:{},processes:{}});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hemi-journal-storage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('legacy facts migrate once without changing JSON, and subsequent commits update only changed rows',async t=>{
  const dir=await fixture(t),state=empty();state.roots.root={owner,status:'running'};
  state.observations.old={id:'old',owner,phase:'finished',payload:'x'.repeat(100000)};
  const legacy=JSON.stringify(state);await fs.writeFile(path.join(dir,'run-journal.json'),legacy);
  const journal=createRunJournal({dir});t.after(()=>journal.dispose());await journal.ready();
  await journal.observationStart({id:'new',owner,tool:'read'});
  await journal.observationEnd('new',{outcome:'ok'});
  assert.equal(await fs.readFile(path.join(dir,'run-journal.json'),'utf8'),legacy);
  const restored=await readRunJournal(dir);assert.equal(restored.observations.new.phase,'finished');assert.equal(restored.observations.old.payload,state.observations.old.payload);
  const selected=await journal.snapshot({tables:['observations'],ids:['new']});
  assert.deepEqual(Object.keys(selected.observations),['new']);assert.deepEqual(selected.requests,{});
  assert.equal(await journal.project(s=>Object.keys(s.observations).length),2);
});
test('a second writer cannot overwrite an admission from an earlier revision',async t=>{
  const dir=await fixture(t),first=createRunJournal({dir}),second=createRunJournal({dir});t.after(()=>{first.dispose();second.dispose();});
  await Promise.all([first.ready(),second.ready()]);await first.beginRoot(owner);
  await assert.rejects(second.beginRoot({...owner,rootRunId:'other'}),{code:'journal-conflict'});
  assert.equal((await second.snapshot()).roots.other,undefined);
  assert.deepEqual(Object.keys((await readRunJournal(dir)).roots),['root']);
});
test('failed operations do not mutate shared historical records or admit partial changes',async t=>{
  const dir=await fixture(t),base=createRunJournal({dir});t.after(()=>base.dispose());await base.beginRoot(owner);
  await base.beginGoal(owner,'finish',{maxRounds:2,maxRequests:10,maxRequestsPerRound:5});
  await assert.rejects(base.beginGoal({...owner,rootRunId:'missing'},'bad',{}, {rootRunId:'root',inputId:'x',answer:'x'}));
  assert.equal((await base.root(owner)).status,'running');assert.equal((await base.root(owner)).goal.phase,'active');
  assert.equal((await readRunJournal(dir)).roots.root.goal.phase,'active');
});
