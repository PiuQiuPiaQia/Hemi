import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleUnderTest} from './compile.mjs';
const {createSnapshotPersistence}=await moduleUnderTest('../src/core.ts');
const scope={environmentId:'test',conversationId:'same'};
const snapshot=revision=>({schemaVersion:1,conversationId:'same',revision,generation:1,phase:'idle',activeRunId:null,queuePaused:false,pending:[],timeline:[],runs:{},tasks:{},artifacts:{},permissions:{},pendingReports:[]});

test('a replay burst checkpoints only the latest immutable view without cloning each history',async()=>{
 const writes=[],history='h'.repeat(5*1024*1024),cache=createSnapshotPersistence({scope,save:async(_scope,value)=>{writes.push(value)}});
 let latest;for(let revision=1;revision<=200;revision++){latest={...snapshot(revision),runs:{finished:{history}}};cache.update(latest);}
 assert.equal(writes.length,0);await cache.flush();assert.equal(writes.length,1);assert.equal(writes[0],latest);assert.equal(writes[0].revision,200);await cache.close();
});

test('a slow async store has one write in flight and only one latest checkpoint waiting',async()=>{
 let release;const gate=new Promise(r=>release=r),writes=[];
 const cache=createSnapshotPersistence({scope,save:async(_scope,value)=>{writes.push(value.revision);if(writes.length===1)await gate}});
 cache.update(snapshot(1));const first=cache.flush();await new Promise(r=>setImmediate(r));
 for(let revision=2;revision<=100;revision++)cache.update(snapshot(revision));
 release();await first;await cache.close();assert.deepEqual(writes,[1,100]);
});

test('cache failures do not reject a checkpoint flush or poison later writes',async()=>{
 let fail=true,errors=0,saved=0;
 const cache=createSnapshotPersistence({scope,save:async()=>{if(fail)throw Error('quota')},onSaved:()=>saved++,onError:()=>errors++});
 cache.update(snapshot(1));await cache.flush();assert.equal(errors,1);
 fail=false;cache.update(snapshot(2));await cache.close();assert.equal(saved,1);
});
