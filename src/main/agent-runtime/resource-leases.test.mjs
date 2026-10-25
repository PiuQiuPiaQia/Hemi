import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceLeases, resourceGateway } from './resource-leases.mjs';
test('重叠文件资源串行，独立路径／主机可并行，取消队首不残留',async()=>{
  const leases=createResourceLeases();
  const first=await leases.acquire({host:'local',scope:'file:/tmp/a',mode:'write'});
  let entered=false;const controller=new AbortController();
  const pending=leases.acquire({host:'local',scope:'file:/tmp/a/child',mode:'write'},controller.signal).then(()=>entered=true);
  const independent=await leases.acquire({host:'local',scope:'file:/tmp/b',mode:'write'});
  const remote=await leases.acquire({host:'remote',scope:'file:/tmp/a',mode:'write'});
  assert.equal(entered,false);controller.abort();await assert.rejects(pending,/取消/);
  independent.release();remote.release();first.release();assert.deepEqual(leases.snapshot(),{holders:[],waiting:[]});
});
test('同一批工具先完成注册再并行 execute，重叠写入没有 prepare 死锁且不会同时进入',async()=>{
  const tools=[];let active=0,maxActive=0;
  const factories=resourceGateway({factories:[{name:'test',factory:pi=>pi.registerTool({name:'write',execute:async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,5));active--;return 'ok';}})}],resolvePath:async p=>({real:p}),browserOwner:'c',getExecution:()=>null,leases:createResourceLeases()});
  factories[0].factory({registerTool:t=>tools.push(t)});
  await Promise.all([tools[0].execute('a',{path:'/tmp/x'}),tools[0].execute('b',{path:'/tmp/x'})]);assert.equal(maxActive,1);
});

test('命令清理未确认只阻止原目标继续执行，不给其他目标留下目录锁',async()=>{
 const leases=createResourceLeases(),execution={cleanupUnconfirmed:false};const tools=[];
 const wrapped=resourceGateway({factories:[{factory:pi=>{
   pi.registerTool({name:'bash',execute:async()=>{execution.cleanupUnconfirmed=true;execution.fatalError='cleanup unconfirmed';throw Error(execution.fatalError);}});
   pi.registerTool({name:'write',execute:async()=>assert.fail('the failed goal cannot execute another tool')});
 }}],resolvePath:async()=>({real:'/tmp/workspace/file'}),getExecution:()=>execution,leases});
 wrapped[0].factory({registerTool:t=>tools.push(t)});
 await assert.rejects(tools[0].execute('call',{}),/cleanup unconfirmed/);
 await assert.rejects(tools[1].execute('next',{path:'/tmp/workspace/file'}),/cleanup unconfirmed/);
 const controller=new AbortController();
 const next=leases.acquire({host:'local',scope:'file:/tmp/workspace/file',mode:'write'},controller.signal);
 try {assert.equal(leases.snapshot().waiting.length,0);(await next).release();}
 finally {controller.abort();await next.catch(()=>{});}
});

for (const shell of ['bash', 'powershell']) test(`${shell} 运行期间，同目录文件读写与另一条命令可以继续`, async t => {
  const leases = createResourceLeases(), tools = new Map();
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  const wrapped = resourceGateway({factories: [{factory: pi => {
    pi.registerTool({name: shell, async execute(id) {
      if (id === 'long-command') {entered.resolve();await finish.promise;}
      return id;
    }});
    for (const name of ['read', 'write']) pi.registerTool({name, async execute() {return name;}});
  }}], resolvePath: async raw => ({real: raw === '.' ? '/workspace/a' : raw}), getExecution: () => null, leases});
  wrapped[0].factory({registerTool: tool => tools.set(tool.name, tool)});
  const running = tools.get(shell).execute('long-command', {});await entered.promise;
  const controller = new AbortController();
  let parallel;
  try {
    parallel = Promise.all([tools.get('read').execute('read', {path: '/workspace/a/input'}, controller.signal),
      tools.get('write').execute('write', {path: '/workspace/a/output'}, controller.signal),
      tools.get(shell).execute('another-command', {}, controller.signal)]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(leases.snapshot().waiting.length, 0, 'an unrelated operation must not wait for the shell');
    assert.deepEqual(await parallel, ['read', 'write', 'another-command']);
  } finally {controller.abort();await parallel?.catch(()=>{});finish.resolve();await running;}
});

test('写同一文件时协调读写，独立文件不等待，取消的工具不会迟到执行', async t => {
  const leases = createResourceLeases(), tools = new Map(), calls = [];
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  const wrapped = resourceGateway({factories: [{factory: pi => {
    for (const name of ['read', 'write', 'edit']) pi.registerTool({name, async execute(id) {
      calls.push(id);if (id === 'first-write') {entered.resolve();await finish.promise;}return id;
    }});
  }}], resolvePath: async raw => ({real: raw}), getExecution: () => null, leases});
  wrapped[0].factory({registerTool: tool => tools.set(tool.name, tool)});
  const writing = tools.get('write').execute('first-write', {path: '/workspace/a/output'});await entered.promise;
  const cancelled = new AbortController();
  const edit = tools.get('edit').execute('cancelled-edit', {path: '/workspace/a/output'}, cancelled.signal);
  const reading = tools.get('read').execute('same-file-read', {path: '/workspace/a/output'});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['first-write']);assert.equal(leases.snapshot().waiting.length, 2);
  assert.equal(await tools.get('write').execute('other-file-write', {path: '/workspace/a/other'}), 'other-file-write');
  cancelled.abort();await assert.rejects(edit, /取消/);finish.resolve();await writing;await reading;
  assert.deepEqual(calls, ['first-write', 'other-file-write', 'same-file-read']);
  assert.deepEqual(leases.snapshot(), {holders: [], waiting: []});
});
