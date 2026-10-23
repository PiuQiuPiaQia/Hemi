import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyModelFailure, createModelRecovery, RECOVERY_WINDOW_MS, retryAfterMs} from './model-recovery.mjs';

function clock() {
  let time = 0, id = 0;
  const jobs = new Map();
  return { now: () => time, jobs,
    timers: { setTimeout(fn, delay) { jobs.set(++id, {fn, at: time + delay}); return id; }, clearTimeout(key) { jobs.delete(key); } },
    async advance(ms) {
      time += ms;
      for (const [key, job] of [...jobs]) if (job.at <= time) { jobs.delete(key); job.fn(); }
      await Promise.resolve(); await Promise.resolve();
    },
  };
}

test('structured status and permanent error precedence; quota 429 is not a rate-limit retry', () => {
  for (const status of [408,429,500,502,503,504]) assert.ok(classifyModelFailure({status}));
  for (const status of [400,401,403,404,405,413,422,501]) assert.equal(classifyModelFailure({status}),null);
  for (const message of ['insufficient_quota', 'billing balance exhausted', '运行请求上限', 'context length limit', 'unsupported-modality', 'HEMI_RECOVERY_EXPIRED', 'arbitrary internal failure']) {
    assert.equal(classifyModelFailure({message, ...(message === 'insufficient_quota' ? {status:429} : {})}),null);
  }
  assert.equal(classifyModelFailure({code:'ECONNRESET'}).category,'network');
  assert.equal(classifyModelFailure({status:503,aborted:true}),null);
  assert.equal(retryAfterMs('120'),120000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT',0),120000);
});

test('real coordinator retries for 30 minutes with gradual backoff and one immutable deadline', async () => {
  const c=clock(), events=[];
  const recovery=createModelRecovery({...c,onState:s=>events.push(s)});
  const delays=[];
  let count=0;
  while (count<100) {
    const before=c.now(), pending=recovery.failed({status:503});
    const waiting=recovery.state;
    assert.equal(waiting.deadlineAt,RECOVERY_WINDOW_MS);
    delays.push(waiting.nextRetryAt-before);
    await c.advance(waiting.nextRetryAt-before);
    if (!await pending) break;
    count++;
  }
  assert.equal(count,34);
  assert.deepEqual(delays.slice(0,7),[1000,2000,5000,10000,20000,30000,60000]);
  assert.equal(c.now(),RECOVERY_WINDOW_MS);
  assert.equal(recovery.state.phase,'expired');assert.equal(recovery.state.attemptsMade,34);
  assert.ok(events.every(e=>e.history.length<=64));
  assert.equal(c.jobs.size,0);
});

test('manual retry obeys cooldown, shares deadline and only one click wakes a waiting attempt', async () => {
  const c=clock(), recovery=createModelRecovery(c);
  const first=recovery.failed({status:503});await c.advance(1000);assert.equal(await first,true);
  const next=recovery.failed({status:429,retryAfterMs:120000});
  const id=recovery.state.id,deadline=recovery.state.deadlineAt;
  assert.equal(recovery.tryNow(id),false);
  await c.advance(119000);assert.equal(recovery.tryNow(id),false);
  await c.advance(1000);assert.equal(await next,true);
  const third=recovery.failed({status:503});await c.advance(1000);
  assert.equal(recovery.tryNow('stale'),false);
  assert.equal(recovery.tryNow(id),true);assert.equal(recovery.tryNow(id),false);
  assert.equal(await third,true);assert.equal(recovery.state.attempt,3);
  assert.equal(recovery.state.deadlineAt,deadline);
});

test('offline and sleep count toward deadline; no missed interval is replayed', async () => {
  const c=clock(), recovery=createModelRecovery({...c,isOnline:()=>false});
  const pending=recovery.failed({code:'ENETDOWN'});
  assert.equal(recovery.state.phase,'offline');
  await c.advance(RECOVERY_WINDOW_MS+1);
  assert.equal(await pending,false);assert.equal(recovery.state.phase,'expired');assert.equal(c.jobs.size,0);
});

test('server Retry-After cannot extend the window, and abort cancels timer and late wake', async () => {
  const c=clock(), recovery=createModelRecovery(c);
  const pending=recovery.failed({status:429,retryAfterMs:RECOVERY_WINDOW_MS*2});
  await c.advance(RECOVERY_WINDOW_MS);assert.equal(await pending,false);
  const d=clock(), controller=new AbortController(), second=createModelRecovery({...d,signal:controller.signal});
  const stopped=second.failed({status:503});controller.abort();
  await assert.rejects(stopped,{name:'AbortError'});
  assert.equal(d.jobs.size,0);assert.equal(second.state.phase,'stopped');
  assert.equal(second.tryNow(second.state.id),false);
});
