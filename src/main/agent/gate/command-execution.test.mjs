import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand, createCommandScope, commandToolResult, defaultGroupProbe } from './command-execution.mjs';
import { withExecutionScope } from '../../agent-runtime/execution-scope.mjs';

const posix = { skip: process.platform === 'win32' ? 'POSIX 进程组用例；Windows taskkill 需 Windows 真机验证' : false };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('060 真实退出、启动失败与输出预算保留到工具结果；EPERM 不伪造沙箱归因', posix, async () => {
  const ok = await runCommand({ command: 'printf direct' });
  assert.equal(ok.status, 'succeeded');
  assert.equal(ok.stdout, 'direct');
  const fail = await runCommand({ command: "printf 'Operation not permitted' >&2; exit 7" });
  assert.equal(fail.code, 7);
  assert.equal(commandToolResult(fail).isError, true);
  assert.doesNotMatch(commandToolResult(fail).content[0].text, /受保护位置|沙箱拒绝/);
  const missing = await runCommand({ command: 'echo must-not-run', cwd: '/no-such-hemi060-directory' });
  assert.equal(missing.status, 'start-failed');
  assert.equal(missing.spawnError, 'ENOENT');
  const huge = await runCommand({ command: 'printf 123456789', maxOutput: 4 });
  assert.equal(huge.stdout, '6789');
  assert.equal(huge.truncated, true);
});

test('060 超时、取消和正常退出均清理同组后台子孙；独立命令不受影响', posix, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi060-command-'));
  const own = createCommandScope(), independent = createCommandScope();
  try {
    const late = path.join(dir, 'late');
    const timeout = await runCommand({ command: `(sleep 1; echo leaked > '${late}') & sleep 30`, timeoutMs: 50 });
    assert.equal(timeout.status, 'timed-out', JSON.stringify(timeout));
    assert.equal(timeout.cleanupConfirmed, true);
    const other = independent.run({ command: 'sleep 0.3; printf independent' });
    const cancelled = own.run({ command: 'sleep 30' });
    await pause(25);
    await own.abort();
    assert.equal((await cancelled).status, 'cancelled');
    assert.equal((await other).stdout, 'independent');
    const background = await runCommand({ command: `(sleep 1; echo leaked > '${late}') & echo started` });
    assert.equal(background.status, 'succeeded', JSON.stringify(background));
    assert.match(background.stdout, /started/);
    await pause(1100);
    assert.equal(await stat(late).then(() => true, () => false), false);
  } finally { await Promise.all([own.abort(), independent.abort()]); await rm(dir, { recursive: true, force: true }); }
});

test('060 首轮信号遗漏的同组后代仍须清理，不能只等组长退出', { ...posix, timeout: 5000 }, async t => {
  const nativeKill = process.kill.bind(process);
  const controller = new AbortController(), ready = Promise.withResolvers();
  let pgid = null, signals = 0;
  // 确定性模拟首轮信号发出后组里仍有活成员（例如 fork 同窗）：第一次保留
  // 真实的受管进程组，后续必须补发信号，不能放宽 cleanupConfirmed。
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -pgid && signal === 'SIGKILL' && ++signals === 1) return true;
    return nativeKill(pid, signal);
  });
  const independent = runCommand({ command: 'sleep 0.3; printf independent' });
  const pending = runCommand({
    command: `"${process.execPath}" -e "process.stdout.write('READY');setTimeout(()=>{},8000)"`,
    signal: controller.signal, cleanupTimeoutMs: 900,
    onSpawn: pid => { pgid = pid; },
    onOutput: () => ready.resolve(),
  });
  try {
    await ready.promise;
    controller.abort();
    const result = await pending;
    assert.equal(result.cleanupConfirmed, true, JSON.stringify(result));
    assert.equal(result.status, 'cancelled');
    assert.ok(signals >= 2, '探针确认仍有活后代后必须再次清理本组');
    const other = await independent;
    assert.equal(other.status, 'succeeded');
    assert.equal(other.stdout, 'independent', '其它独立命令不能被补杀波及');
  } finally {
    controller.abort();
    if (pgid !== null) { try { nativeKill(-pgid, 'SIGKILL'); } catch {} }
    await Promise.allSettled([pending, independent]);
  }
});

test('060 期限后才返回的阳性探针不能再向旧进程组补发信号', { ...posix, timeout: 5000 }, async t => {
  const nativeKill = process.kill.bind(process), controller = new AbortController();
  const spawned = Promise.withResolvers(), entered = Promise.withResolvers(), release = Promise.withResolvers(), returned = Promise.withResolvers();
  let pgid = null, signals = 0;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -pgid && signal === 'SIGKILL' && ++signals > 1) return true;
    return nativeKill(pid, signal);
  });
  const pending = runCommand({
    command: 'sleep 30', signal: controller.signal, cleanupTimeoutMs: 250,
    onSpawn: pid => { pgid = pid; spawned.resolve(); },
    groupProbe: async () => {
      entered.resolve();
      await release.promise;
      returned.resolve();
      return { stdout: `${pgid} S` };
    },
  });
  try {
    await spawned.promise;
    controller.abort();
    await entered.promise;
    const result = await pending;
    assert.equal(result.cleanupConfirmed, false, '期限内未获得证据不能报告清理成功');
    release.resolve();
    await returned.promise;
    await pause(25);
    assert.equal(signals, 1, '清理失效后不得因迟到阳性探针向旧 PGID 发信号');
  } finally {
    release.resolve();
    if (pgid !== null) { try { nativeKill(-pgid, 'SIGKILL'); } catch {} }
    await pending;
  }
});

test('060 已取消信号不启动命令，不留下副作用', posix, async () => {
  const out = await runCommand({ command: 'echo must-not-run', signal: AbortSignal.abort() });
  assert.equal(out.status, 'cancelled');
  assert.equal(out.stdout, '');
  assert.equal(commandToolResult(out).isError, true);
});

test('060 清理确认：ps 探针偶发失败在期限内重试，不误判为清理失败', posix, async () => {
  // 复现 CI 实撞（v0.2.28 mac runner）：单次 /bin/ps 超时曾把 cleanupConfirmed 打成 false。
  const real = async timeoutMs => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    return promisify(execFile)('/bin/ps', ['-axo', 'pgid=,stat='], { timeout: timeoutMs });
  };
  let failures = 2;
  const flaky = async timeoutMs => {
    if (failures-- > 0) throw Object.assign(new Error('probe timed out (simulated)'), { code: 'ETIMEDOUT' });
    return real(timeoutMs);
  };
  const controller = new AbortController();
  const running = runCommand({ command: 'sleep 30', signal: controller.signal, groupProbe: flaky });
  await pause(60);
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cleanupConfirmed, true, JSON.stringify(result));
});

test('060 清理确认：探针全程失败仍按未确认处理（fail-closed 不放宽）', posix, async () => {
  const controller = new AbortController();
  const running = runCommand({ command: 'sleep 30', signal: controller.signal, cleanupTimeoutMs: 900, groupProbe: async () => { throw new Error('ps unavailable'); } });
  await pause(60);
  controller.abort();
  const result = await running;
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.status, 'cleanup-failed');
});

test('060 清理确认：组内无任何成员时 kill-0 内核直接给出空快照，不依赖 ps', posix, async () => {
  // 复现 v0.2.47 mac CI：高负载下 /bin/ps 单次超过固定探针预算被反复超时，组明明已死却拿不到证据。
  const { spawn } = await import('node:child_process');
  const doomed = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  process.kill(-doomed.pid, 'SIGKILL');
  await new Promise(resolve => doomed.once('exit', resolve));
  await pause(20);
  const snapshot = await defaultGroupProbe(2000, doomed.pid);
  assert.deepEqual(snapshot, { stdout: '' }, 'ESRCH 应映射为空快照（ps 快照不可能为空）');
});

test('060 清理确认：kill-0 不会把仍存活的进程组误判为已消失', posix, async () => {
  const { spawn } = await import('node:child_process');
  const alive = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    const snapshot = await defaultGroupProbe(2000, alive.pid);
    const present = snapshot.stdout.split('\n').some(row => {
      const [group] = row.trim().split(/\s+/);
      return Number(group) === alive.pid;
    });
    assert.equal(present, true, `存活组必须出现在探针快照中：${snapshot.stdout.slice(0, 200)}`);
  } finally { try { process.kill(-alive.pid, 'SIGKILL'); } catch {} }
});

test('060 清理确认：单次探针超过固定片仍能在清理窗口内拿到证据', posix, async () => {
  // 复现 v0.2.47 mac CI（cleanup-unconfirmed，8.3s）：ps 持续慢于固定 2s 片时全程拿不到快照。
  const budgets = [];
  const slowProbe = async timeoutMs => {
    budgets.push(timeoutMs);
    await pause(2100);
    return { stdout: '' };
  };
  const controller = new AbortController();
  const running = runCommand({ command: 'sleep 30', signal: controller.signal, groupProbe: slowProbe });
  await pause(60);
  const began = Date.now();
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cleanupConfirmed, true, JSON.stringify(result));
  assert.ok(budgets[0] > 2000, `首个探针应拿到剩余清理窗口预算，实际 ${budgets[0]}ms`);
  assert.ok(Date.now() - began < 5000, `确认应在首个慢探针返回后完成，实际 ${Date.now() - began}ms`);
});

test('后台短时间连续输出的最后一条仍推送到界面，不把无输出期误记为旧进度', posix, async () => {
  const views = [];
  const commands = createCommandScope({ onChange: jobs => views.push(jobs) });
  try {
    await commands.run({ command: 'printf first; sleep 0.1; printf second; sleep 30', runInBackground: true });
    const deadline = Date.now() + 3000;
    while (!views.some(jobs => jobs[0]?.output.includes('second'))) {
      assert.ok(Date.now() < deadline, '最后一次输出应在节流窗口后送达');
      await pause(20);
    }
    const first = views.find(jobs => jobs[0]?.output === 'first')?.[0];
    const latest = views.find(jobs => jobs[0]?.output.includes('second'))?.[0];
    assert.ok(first, '真实进程先产生首条输出');
    assert.ok(latest.lastOutputAt > first.lastOutputAt);
  } finally { await commands.abort(); }
});

test('064 命令在进程身份持久化前不执行，登记失败或等待中取消无副作用', posix, async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hemi064-start-gate-'));
  try {
    const marker=path.join(dir,'marker');let release,entered;
    const gate=new Promise(r=>{release=r;}), started=new Promise(r=>{entered=r;});
    const pending=runCommand({command:`printf actual > '${marker}'`,onSpawn:async()=>{entered();await gate;}});
    await started;assert.equal(await readFile(marker,'utf8').catch(()=>null),null);
    release();assert.equal((await pending).status,'succeeded');assert.equal(await readFile(marker,'utf8'),'actual');
    await rm(marker);
    const failure=await runCommand({command:`printf forbidden > '${marker}'`,onSpawn:async()=>{throw Error('disk write failed');}});
    assert.equal(failure.status,'start-failed');assert.equal(await readFile(marker,'utf8').catch(()=>null),null);
    const controller=new AbortController();let releaseCancel,enteredCancel;
    const cancelGate=new Promise(r=>{releaseCancel=r;}),cancelStarted=new Promise(r=>{enteredCancel=r;});
    const cancelled=runCommand({command:`printf forbidden > '${marker}'`,signal:controller.signal,onSpawn:async()=>{enteredCancel();await cancelGate;}});
    await cancelStarted;controller.abort();releaseCancel();assert.equal((await cancelled).status,'cancelled');
    assert.equal(await readFile(marker,'utf8').catch(()=>null),null);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('后台结果按根目标和子任务隔离；非阻塞消费与收口等待共享一次性结果', posix, async () => {
  const commands = createCommandScope();
  const first = { conversationId: 'c', rootRunId: 'r', generation: 0, taskId: 'first' };
  const second = { ...first, taskId: 'second' };
  try {
    await withExecutionScope({ owner: first }, null, () => commands.run({ command: 'sleep 0.1; printf FIRST; exit 7', runInBackground: true }));
    await withExecutionScope({ owner: second }, null, () => commands.run({ command: 'sleep 0.3; printf SECOND', runInBackground: true }));
    assert.deepEqual(commands.takeCompleted(second), [], '仍在运行的任务不等待也不消费');
    assert.deepEqual(commands.takeCompleted({ ...first, rootRunId: 'other' }), []);
    assert.deepEqual(commands.takeCompleted({ ...first, generation: 1 }), []);
    const [result] = await commands.waitForCompletion(first);
    assert.equal(result.code, 7); assert.match(result.text, /FIRST/);
    assert.deepEqual(commands.takeCompleted(first), []);
    assert.equal(commands.hasBackground(first), false);
    assert.equal(commands.hasBackground(second), true);
    const [remaining] = await commands.waitForCompletion(second);
    assert.match(remaining.text, /SECOND/);
    assert.deepEqual(await commands.waitForCompletion(second), []);
  } finally { await commands.abort(); }
});
