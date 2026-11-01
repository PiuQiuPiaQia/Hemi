import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_TIMEOUT_MS,
  STAGE_NAMES,
  WATCHDOG_GRACE_MS,
  WATCHDOG_PYTHON_SOURCE,
  isExpectedTrustDenial,
  parseAdminTrustPolicies,
  resolveCleanupContext,
  runCleanupStage,
  watchdogRun,
} from '../cleanup-macos-signing.mjs';
import { runTrustRevocationPreflight } from '../verify-macos-trust-revocation.mjs';
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

test('托管 runner：revoke-trust 走 deny 覆盖 + 状态/实际双证据', () => {
  const outcomes = [
    { ok: true, detail: '', timedOut: false, status: 0, stdout: '', stderr: '' }, // add-trusted-cert deny
    { ok: true, detail: '', timedOut: false, status: 0, stdout: '', stderr: '' }, // trust-settings-export
    { ok: false, detail: 'CSSMERR_TP_CERT_TRUST', timedOut: false, status: 1, stdout: 'Cert Verify Result: CSSMERR_TP_CERT_TRUST', stderr: '' }, // verify-cert 预期拒绝
  ];
  const { run, calls } = spyRun(outcomes);
  const logs = [];
  const result = runCleanupStage('revoke-trust', {
    env: HOSTED, run, exists: () => true, log: line => logs.push(line),
    parseTrustSettings: () => [{ policy: 'codeSign', result: 3 }],
  });
  assert.deepEqual(result, { ok: true, failures: 0 });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, ['add-trusted-cert', '-d', '-r', 'deny', '-p', 'codeSign', '-k', path.join(SIGNING_DIR, 'hemi-signing.keychain-db'), certificatePath]);
  assert.equal(calls[0].options.sudo, true);
  assert.deepEqual(calls[1].args, ['trust-settings-export', '-d', path.join(SIGNING_DIR, 'admin-trust-settings-export.plist')]);
  assert.equal(calls.find(call => call.args[0] === 'add-trusted-cert').options.sudo, true);
  assert.deepEqual(calls[2].args, ['verify-cert', '-c', certificatePath, '-p', 'codeSign', '-N', '-L']);
  assert.equal(calls[2].options.sudo, undefined);
  assert.ok(logs.some(line => line.includes('deny')) && logs.some(line => line.includes('verify-cert')));
});

test('状态证据不足（无 deny 或存在 allow）直接失败且不做实际验证', () => {
  for (const policies of [[], [{ policy: 'ssl', result: 3 }], [{ policy: 'codeSign', result: 1 }], [{ policy: 'codeSign', result: 3 }, { policy: 'codeSign', result: 2 }], [{ policy: 'codeSign', result: 3 }, { policy: 'ssl', result: 4 }]]) {
    const { run, calls } = spyRun();
    const result = runCleanupStage('revoke-trust', {
      env: HOSTED, run, exists: () => true, log: () => {}, parseTrustSettings: () => policies,
    });
    assert.equal(result.ok, false, JSON.stringify(policies));
    assert.equal(calls.length, 2, '状态证据失败后不再跑 verify-cert');
  }
});

test('verify-cert 仍信任/超时/其它错误都不接受为撤销成功', () => {
  const cases = [
    [{ ok: true, detail: '', timedOut: false, status: 0, stdout: '', stderr: '' }, '仍信任'],
    [{ ok: false, detail: 'ETIMEDOUT', timedOut: true, status: null, stdout: '', stderr: '' }, '超时'],
    [{ ok: false, detail: 'ENOENT', timedOut: false, status: null, stdout: '', stderr: '' }, '工具缺失'],
    [{ ok: false, detail: 'CSSMERR_TP_CERT_TRUST', timedOut: false, status: null, stdout: '', stderr: '' }, '未确认退出状态不能只凭输出放行'],
    [{ ok: false, detail: 'exit 64', timedOut: false, status: 64, stdout: 'usage error', stderr: '' }, '参数错误'],
  ];
  for (const [verifyOutcome, label] of cases) {
    const { run } = spyRun([{ ok: true }, { ok: true }, verifyOutcome]);
    const result = runCleanupStage('revoke-trust', {
      env: HOSTED, run, exists: () => true, log: () => {},
      parseTrustSettings: () => [{ policy: 'codeSign', result: 3 }],
    });
    assert.equal(result.ok, false, label);
  }
});

test('revoke-trust 幂等：deny 覆盖可重复执行且每次双证据', () => {
  const revokeOnce = () => runCleanupStage('revoke-trust', {
    env: HOSTED,
    run: (() => {
      let verifyCalled = 0;
      return (command, args) => {
        if (args[0] === 'verify-cert') {
          verifyCalled += 1;
          return { ok: false, detail: 'CSSMERR_TP_CERT_TRUST', timedOut: false, status: 1, stdout: 'CSSMERR_TP_CERT_TRUST', stderr: '' };
        }
        return { ok: true, detail: '', timedOut: false, status: 0, stdout: '', stderr: '' };
      };
    })(),
    exists: () => true,
    log: () => {},
    parseTrustSettings: () => [{ policy: 'codeSign', result: 3 }],
  });
  assert.deepEqual(revokeOnce(), { ok: true, failures: 0 });
  assert.deepEqual(revokeOnce(), { ok: true, failures: 0 });
});

test('钥匙串缺失不能当作管理员域信任已撤销', () => {
  const { run, calls } = spyRun();
  const result = runCleanupStage('revoke-trust', { env: HOSTED, run, exists: () => false });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
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
  const revoked = runCleanupStage('revoke-trust', { env: HOSTED, run: boom, exists: () => true, log: () => {} });
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

// ── deny 撤销的双证据支撑 ────────────────────────────────────────────────

test('verify-cert 信任拒绝分类：信任错误命中，其它错误不命中', () => {
  assert.equal(isExpectedTrustDenial({ stderr: 'Cert Verify Result: CSSMERR_TP_CERT_TRUST' }), true);
  assert.equal(isExpectedTrustDenial({ detail: 'CSSMERR_TP_NOT_TRUSTED' }), true);
  assert.equal(isExpectedTrustDenial({ stdout: 'denied by trust settings' }), true);
  assert.equal(isExpectedTrustDenial({ detail: 'ENOENT' }), false);
  assert.equal(isExpectedTrustDenial({ stdout: 'usage error', detail: 'exit 64' }), false);
  assert.equal(isExpectedTrustDenial({}), false);
});

test('信任设置读取器只提取目标证书的 policy/result（真实 plist）', { skip: PYTHON ? false : '需要可用的 python3' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-trust-'));
  try {
    const plistPath = path.join(dir, 'settings.plist');
    const sha1 = 'a'.repeat(40);
    const generator = [
      'import plistlib',
      `data = {'trustVersion': 1, 'trustList': {'${sha1.toUpperCase()}': {'trustSettings': [{'kSecTrustSettingsPolicyName': 'codesigning', 'kSecTrustSettingsResult': 3}], 'issuerName': b'public-certificate-data'},`,
      `        'ffff': {'trustSettings': [{'kSecTrustSettingsPolicyName': 'ssl', 'kSecTrustSettingsResult': 1}]}}}`,
      `open(r'${plistPath}', 'wb').write(plistlib.dumps(data))`,
    ].join('\n');
    const gen = spawnSync(PYTHON, ['-c', generator], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(gen.status, 0, gen.stderr);
    assert.deepEqual(
      parseAdminTrustPolicies({ pythonPath: PYTHON, plistPath, sha1 }),
      [{ policy: 'codeSign', result: 3 }],
      '只输出目标 SHA1 的记录，且深入嵌套收集 policy 条目',
    );
    assert.deepEqual(parseAdminTrustPolicies({ pythonPath: PYTHON, plistPath, sha1: 'b'.repeat(40) }), [], '目标证书无记录时返回空数组');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 无私钥 preflight（注入执行器，不触碰本机 security）──────────────────

test('preflight：授予→撤销→幂等全链路，finally 始终清理', () => {
  const outcomes = Array.from({ length: 7 }, () => ({
    ok: true, detail: '', timedOut: false, status: 0, stdout: '', stderr: '',
  }));
  const { run, calls } = spyRun(outcomes);
  const revokes = [];
  const cleanups = [];
  const logs = [];
  const result = runTrustRevocationPreflight({
    env: HOSTED, run,
    revokeStage: log => { revokes.push(log); return { ok: true, failures: 0 }; },
    cleanupStage: stage => { cleanups.push(stage); return { ok: true, failures: 0 }; },
    parseTrustSettings: () => [{ policy: 'codeSign', result: 1 }],
    log: line => logs.push(line),
  });
  assert.deepEqual(result, { ok: true, failures: 0 });
  assert.equal(revokes.length, 2, '生产 revoke 调用两次（含幂等验证）');
  assert.deepEqual(cleanups, ['delete-keychain', 'remove-directory']);
  assert.deepEqual(calls.map(call => call.args[0]), ['create-keychain', 'set-keychain-settings', 'unlock-keychain', 'unlock-keychain', 'add-trusted-cert', 'verify-cert', 'trust-settings-export']);
  assert.equal(calls[0].args[2], 'fake-public-probe', 'keychain 密码是公开占位符');
  assert.equal(calls.find(call => call.args[0] === 'add-trusted-cert').options.sudo, true);
  assert.ok(logs.some(line => line.includes('PASS: 重复 revoke-trust 幂等成功')));
});

test('preflight：revoke 失败计失败但仍执行清理', () => {
  const { run } = spyRun();
  const cleanups = [];
  const result = runTrustRevocationPreflight({
    env: HOSTED, run,
    revokeStage: () => ({ ok: false, failures: 1 }),
    cleanupStage: stage => { cleanups.push(stage); return { ok: true, failures: 0 }; },
    parseTrustSettings: () => [],
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.deepEqual(cleanups, ['delete-keychain', 'remove-directory']);
});

test('preflight：非托管环境拒绝且零副作用', () => {
  const { run, calls } = spyRun();
  const result = runTrustRevocationPreflight({ env: {}, run, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

// ── preflight workflow 接线（静态，LF/CRLF 无关）────────────────────────

test('preflight workflow：无 secrets、只读权限、手动触发、无发布', () => {
  const raw = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/macos-signing-preflight.yml'), 'utf8');
  for (const lineEnding of ['\n', '\r\n']) {
    const text = raw.replace(/\r?\n/g, lineEnding);
    assert.match(text, /workflow_dispatch:/, `手动触发（${lineEnding}）`);
    assert.match(text, /permissions:\s*?\n\s*contents: read/, `只读权限（${lineEnding}）`);
    assert.match(text, /runs-on: macos-15/, `托管 runner（${lineEnding}）`);
    assert.match(text, /node-version: 22/, `Node 22（${lineEnding}）`);
    assert.match(text, /node scripts\/verify-macos-trust-revocation\.mjs/, `preflight 入口（${lineEnding}）`);
    assert.match(text, /cleanup-macos-signing\.mjs delete-keychain/, `兜底清理 keychain（${lineEnding}）`);
    assert.match(text, /cleanup-macos-signing\.mjs remove-directory/, `兜底清理目录（${lineEnding}）`);
    assert.ok(!/secrets\./.test(text), `不引用任何 secrets（${lineEnding}）`);
    assert.ok(!/npm ci/.test(text), `不装依赖（${lineEnding}）`);
    assert.ok(!/electron-builder/.test(text), `不打包（${lineEnding}）`);
    assert.ok(!/gh release|git push|--draft/.test(text), `不发布不推 tag（${lineEnding}）`);
  }
});
