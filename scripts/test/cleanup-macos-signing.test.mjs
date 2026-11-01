import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_TIMEOUT_MS,
  STAGE_NAMES,
  WATCHDOG_GRACE_MS,
  WATCHDOG_PYTHON_SOURCE,
  resolveCleanupContext,
  runCleanupStage,
  watchdogRun,
} from '../cleanup-macos-signing.mjs';
import { certificatePath } from '../lib/macos-signing.mjs';

const RUNNER_TEMP = path.join(os.tmpdir(), 'hemi-runner-temp');
const SIGNING_DIR = path.join(RUNNER_TEMP, 'hemi-build-signing');
const HOSTED = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_TEMP,
  HEMI_MAC_SIGNING_DIR: SIGNING_DIR,
};
const RECORD = (counts, key) => () => { counts[key] += 1; };

// ── 入口守卫：任何不满足都在副作用之前拒绝 ──────────────────────────────

test('守卫表驱动：非托管/缺参/错目录一律拒绝且零 exists/run/remove 副作用', () => {
  const cases = [
    [{}, '缺 GITHUB_ACTIONS'],
    [{ ...HOSTED, GITHUB_ACTIONS: undefined }, 'GITHUB_ACTIONS 非 true'],
    [{ ...HOSTED, RUNNER_ENVIRONMENT: 'self-hosted' }, 'self-hosted'],
    [{ ...HOSTED, RUNNER_TEMP: undefined }, '缺 RUNNER_TEMP'],
    [{ ...HOSTED, HEMI_MAC_SIGNING_DIR: undefined }, '缺显式目录（禁止默认回退）'],
    [{ ...HOSTED, HEMI_MAC_SIGNING_DIR: RUNNER_TEMP }, 'RUNNER_TEMP 本身'],
    [{ ...HOSTED, HEMI_MAC_SIGNING_DIR: path.join(RUNNER_TEMP, 'other') }, '非预定名（越界）'],
    [{ ...HOSTED, HEMI_MAC_SIGNING_DIR: path.join(SIGNING_DIR, '../..') }, '路径穿越'],
    [{ ...HOSTED, HEMI_MAC_SIGNING_DIR: path.join(os.homedir(), 'Library/Application Support/Hemi Build Signing') }, '本机长期身份目录'],
  ];
  for (const [env, label] of cases) {
    for (const stage of STAGE_NAMES) {
      const counts = { run: 0, exists: 0, remove: 0 };
      const result = runCleanupStage(stage, {
        env,
        run: RECORD(counts, 'run'), exists: RECORD(counts, 'exists'), removeTree: RECORD(counts, 'remove'),
        log: () => {},
      });
      assert.equal(result.ok, false, `${label} 必须拒绝`);
      assert.deepEqual(counts, { run: 0, exists: 0, remove: 0 }, `${label} 必须零副作用`);
    }
  }
});

test('合法上下文解析出严格等于 RUNNER_TEMP/hemi-build-signing 的目录', () => {
  const context = resolveCleanupContext({ env: HOSTED });
  assert.deepEqual(context, { ok: true, directory: SIGNING_DIR });
});

// ── 阶段行为（注入执行器，不触碰本机 security）──────────────────────────

function spyRun(outcomes = []) {
  const calls = [];
  return {
    calls,
    run: (command, args, options = {}) => {
      calls.push({ command, args, options });
      return outcomes[calls.length - 1] ?? { ok: true, detail: '', timedOut: false };
    },
  };
}

test('托管 runner：撤销经 sudo 包装且命令语义不变', () => {
  const { run, calls } = spyRun();
  const logs = [];
  const result = runCleanupStage('revoke-trust', { env: HOSTED, run, log: line => logs.push(line) });
  assert.deepEqual(result, { ok: true, failures: 0 });
  assert.deepEqual(calls, [{ command: '/usr/bin/security', args: ['remove-trusted-cert', '-d', certificatePath], options: { sudo: true } }]);
  assert.ok(logs.some(line => line.includes('remove-trusted-cert')));
});

test('钥匙串不存在（导入早失败）跳过且不算失败；存在则删除', () => {
  const absent = spyRun();
  assert.deepEqual(runCleanupStage('delete-keychain', { env: HOSTED, run: absent.run, exists: () => false, log: () => {} }), { ok: true, failures: 0 });
  assert.equal(absent.calls.length, 0);

  const present = spyRun();
  const result = runCleanupStage('delete-keychain', { env: HOSTED, run: present.run, exists: () => true, log: () => {} });
  assert.deepEqual(result, { ok: true, failures: 0 });
  assert.deepEqual(present.calls, [{ command: '/usr/bin/security', args: ['delete-keychain', path.join(SIGNING_DIR, 'hemi-signing.keychain-db')], options: {} }]);
});

test('执行器抛异常被隔离为阶段失败，不冒泡', () => {
  const boom = () => { throw new Error('executor exploded'); };
  const revoked = runCleanupStage('revoke-trust', { env: HOSTED, run: boom, log: () => {} });
  assert.equal(revoked.ok, false);
  const deleted = runCleanupStage('delete-keychain', { env: HOSTED, run: boom, exists: () => true, log: () => {} });
  assert.equal(deleted.ok, false);
  const removed = runCleanupStage('remove-directory', { env: HOSTED, removeTree: boom, log: () => {} });
  assert.equal(removed.ok, false);
});

test('目录删除按阶段执行且目标是守卫目录本身', () => {
  const removed = [];
  const result = runCleanupStage('remove-directory', { env: HOSTED, removeTree: target => removed.push(target), log: () => {} });
  assert.deepEqual(result, { ok: true, failures: 0 });
  assert.deepEqual(removed, [SIGNING_DIR]);
});

// ── watchdog 参数组装（注入 spawn，不真跑 sudo）─────────────────────────

test('sudo 包装在 root 侧执行 watchdog，deadline 与兜底超时都注入', () => {
  const calls = [];
  const run = watchdogRun({
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { ok: true, stderr: '', status: 0 };
    },
  });
  const result = run('/usr/bin/security', ['remove-trusted-cert', '-d', '/cert.cer'], { sudo: true, timeoutMs: 60_000 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    command: 'sudo',
    args: ['-n', '/usr/bin/python3', '-c', WATCHDOG_PYTHON_SOURCE, '60', '/usr/bin/security', 'remove-trusted-cert', '-d', '/cert.cer'],
    options: { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS + WATCHDOG_GRACE_MS },
  }]);
});

test('非 sudo 包装由当前用户直接执行 watchdog', () => {
  const calls = [];
  const run = watchdogRun({
    spawn: (command, args) => {
      calls.push({ command, args });
      return { ok: true, stderr: '', status: 0 };
    },
  });
  run('/usr/bin/security', ['delete-keychain', '/k'], { timeoutMs: 10_000 });
  assert.deepEqual(calls, [{
    command: '/usr/bin/python3',
    args: ['-c', WATCHDOG_PYTHON_SOURCE, '10', '/usr/bin/security', 'delete-keychain', '/k'],
  }]);
});

test('启动错误与外部信号不误报为超时，仍按失败处理', () => {
  for (const result of [
    { error: { code: 'ENOENT' }, status: null, stderr: '' },
    { error: { code: 'EACCES' }, status: null, stderr: '' },
    { status: null, signal: 'SIGTERM', stderr: '' },
  ]) {
    const run = watchdogRun({ spawn: () => result });
    const outcome = run('/nonexistent', []);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, false);
  }
});

// ── 真硬截止：真实忽略 SIGTERM 的进程（无凭据，不用 security/sudo）────────

function findPython() {
  for (const candidate of ['/usr/bin/python3', 'python3', 'python']) {
    const probe = spawnSync(candidate, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 10_000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = findPython();
// 真实忽略 SIGTERM 的 node 假命令：打印 ready 后常驻，验证只能靠 SIGKILL 收掉。
const IGNORE_SIGTERM_CODE = "process.on('SIGTERM', () => {});process.stdout.write('ready\\n');setInterval(() => {}, 1000);";

test('watchdog 真硬截止忽略 SIGTERM 的进程，且后续命令仍可执行', { skip: PYTHON ? false : '需要可用的 python3' }, () => {
  const run = watchdogRun({ pythonPath: PYTHON });
  const started = Date.now();
  const hung = run(process.execPath, ['-e', IGNORE_SIGTERM_CODE], { timeoutMs: 1500 });
  const elapsed = Date.now() - started;
  assert.equal(hung.ok, false, '超时必须计为失败');
  assert.equal(hung.timedOut, true, '必须标记为超时');
  assert.ok(elapsed >= 1500 && elapsed < 12_000, `deadline 后应迅速 SIGKILL（实际 ${elapsed}ms）`);

  const follower = run(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5000 });
  assert.equal(follower.ok, true, '截止后执行器仍可运行后续命令');
});

test('正常命令经 watchdog 包装返回成功', { skip: PYTHON ? false : '需要可用的 python3' }, () => {
  const run = watchdogRun({ pythonPath: PYTHON });
  const result = run(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5000 });
  assert.equal(result.ok, true);
});
