import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceLeases, resourceGateway } from './resource-leases.mjs';
test('重叠目录与任意 shell 串行，独立路径／主机可并行，取消队首不残留',async()=>{
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

test('命令清理未确认时保留冲突资源，新的写入不能默认放行且等待可取消',async()=>{
 const leases=createResourceLeases(),execution={cleanupUnconfirmed:false};const tools=[];
 const wrapped=resourceGateway({factories:[{factory:pi=>pi.registerTool({name:'bash',execute:async()=>{execution.cleanupUnconfirmed=true;throw Error('cleanup unconfirmed');}})}],resolvePath:async()=>({real:'/tmp/workspace'}),getExecution:()=>execution,leases});
 wrapped[0].factory({registerTool:t=>tools.push(t)});
 await assert.rejects(tools[0].execute('call',{}),/cleanup unconfirmed/);
 assert.equal(leases.snapshot().holders.length,1);
 const controller=new AbortController();const waiting=leases.acquire({host:'local',scope:'file:/tmp/workspace/file',mode:'write'},controller.signal);
 assert.equal(leases.snapshot().waiting.length,1);controller.abort();await assert.rejects(waiting,/取消/);
});

test('Shell 只串行所属工作区，后台持锁到真实结束；其他项目和浏览器可并行', async () => {
  const leases = createResourceLeases(), tools = [], events = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const { currentExecutionScope } = await import('./execution-scope.mjs');
  const wrapped = resourceGateway({
    factories: [{ factory: pi => pi.registerTool({ name: 'bash', async execute() {
      currentExecutionScope().retainResourceUntil(done);
      return { content: [{ type: 'text', text: 'background' }] };
    } }) }],
    resolvePath: async () => ({ real: '/workspace/a' }), getExecution: () => null, leases,
    onActivity: event => events.push(event),
  });
  wrapped[0].factory({ registerTool: tool => tools.push(tool) });
  await tools[0].execute('shell', {});
  const browser = await leases.acquire({ host: 'local', scope: 'browser:another-chat', mode: 'write' });
  const project = await leases.acquire({ host: 'local', scope: 'file:/workspace/b', mode: 'write' });
  let entered = false, blockers;
  const waiting = leases.acquire({ host: 'local', scope: 'file:/workspace/a/file', mode: 'write' }, null,
    { onWait: values => { blockers = values; } }).then(lease => { entered = true; return lease; });
  assert.equal(entered, false);
  assert.equal(blockers[0].tool, 'bash');
  finish();
  (await waiting).release(); browser.release(); project.release();
  assert.equal(entered, true);
  assert.equal(leases.snapshot().holders.length, 0);
});
