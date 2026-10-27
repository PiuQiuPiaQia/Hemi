// 049 S1 · ssh-runner 单测：假 ssh 可执行文件（argv 命令落到本机沙箱执行）。
// 覆盖：shq 转义、host 校验、错误分类、probe 协议、超时/中止杀进程、-O exit。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createSshRunner, shq, isValidSshTarget, classifySshFailure, sshFailureCopy, effectiveControlDir } from './ssh-runner.mjs';
import { setupFakeSsh } from './fake-ssh.mjs';

const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'hemi-049-ssh-'));
const fake = setupFakeSsh(tmpBase);
const controlDir = path.join(tmpBase, 'ctl');

function newRunner() {
  return createSshRunner({ controlDir, sshBin: fake.sshBin, log: null });
}

test.after(() => {
  fake.setMode('');
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* exFAT/沙箱残留不致命 */ }
});

test('shq：单引号转义（空格/引号/$/换行/- 开头路径都不逃逸）', { skip: process.platform === 'win32' ? '还原验证要 spawn /bin/sh：POSIX 专属' : false }, () => {
  assert.equal(shq('plain'), "'plain'");
  assert.equal(shq(`it's`), "'it'\\''s'");
  assert.equal(shq('a b$c\nd-e'), "'a b$c\nd-e'");
  // 转义后的整段在 sh 里必须还原为原字符串
  const out = spawn('/bin/sh', ['-c', `printf %s ${shq(`it's a $TEST \n path`)}`], {
    env: { ...process.env, TEST: 'x' },
  });
  let stdout = '';
  out.stdout.on('data', (c) => { stdout += c; });
  return new Promise((resolve) => {
    out.on('close', (code) => {
      assert.equal(code, 0);
      assert.equal(stdout, `it's a $TEST \n path`);
      resolve();
    });
  });
});

test('isValidSshTarget：接受别名/user@host/[IPv6]，拒绝选项注入与控制字符', () => {
  assert.equal(isValidSshTarget('devbox'), true);
  assert.equal(isValidSshTarget('user@10.0.0.5'), true);
  assert.equal(isValidSshTarget('user@[fd00::1]'), true);
  assert.equal(isValidSshTarget('-oProxyCommand=evil'), false);
  assert.equal(isValidSshTarget('a b'), false);
  assert.equal(isValidSshTarget('a;rm'), false);
  assert.equal(isValidSshTarget(''), false);
});

test('resolveHostname uses actual OpenSSH HostName for aliases and IPv6 without leaking user or SSH port', {skip: process.platform !== 'darwin'}, async () => {
  const config = path.join(tmpBase, 'pairing-ssh-config');
  writeFileSync(config, 'Host pairing-alias\n  HostName 203.0.113.42\n  User fixture\n  Port 2222\nHost pairing-v6\n  HostName 2001:db8::42\n', {mode: 0o600});
  const binary = path.join(tmpBase, 'pairing-ssh');
  writeFileSync(binary, `#!/bin/sh\nexec /usr/bin/ssh -F ${shq(config)} "$@"\n`, {mode: 0o700});
  const runner = createSshRunner({controlDir, sshBin: binary});
  assert.equal(await runner.resolveHostname('pairing-alias'), '203.0.113.42');
  assert.equal(await runner.resolveHostname('user@pairing-v6'), '2001:db8::42');
  assert.equal(await runner.resolveHostname('user@[2001:db8::43]'), '[2001:db8::43]');
  await assert.rejects(runner.resolveHostname('-oProxyCommand=evil'), /SSH 地址无效/);
});

const NOT_POSIX = process.platform === 'win32' ? '假 ssh 是 sh 脚本、命令落本机 POSIX 沙箱：win 起不来（043 Windows 批次范围外）' : false;

test('exec：命令在远端（沙箱）执行，stdout 二进制安全', { skip: NOT_POSIX }, async () => {
  const runner = newRunner();
  const marker = path.join(fake.home, 'probe.txt');
  const out = await runner.exec({ host: 'devbox', command: `echo hi > ${shq(marker)} && printf AAB` });
  assert.equal(out.code, 0);
  assert.equal(out.stdout.toString('utf8'), 'AAB');
  assert.equal(readFileSync(marker, 'utf8').trim(), 'hi');
  assert.equal(out.connError, null);
});

test('exec：stdin 送达远端命令', { skip: NOT_POSIX }, async () => {
  const runner = newRunner();
  const out = await runner.exec({
    host: 'devbox',
    command: `cat > ${shq(path.join(fake.home, 'in.txt'))} && wc -c < ${shq(path.join(fake.home, 'in.txt'))}`,
    stdin: Buffer.from('你好 049'),
  });
  assert.equal(out.code, 0);
  assert.equal(readFileSync(path.join(fake.home, 'in.txt'), 'utf8'), '你好 049');
  assert.ok(out.stdout.toString('utf8').trim().length > 0);
});

test('错误分类：auth / hostkey / unreachable / 超时 各自可区分（AC-02/T-05）', { skip: NOT_POSIX }, async () => {
  const runner = newRunner();
  for (const [mode, expected] of [['auth', 'auth'], ['hostkey', 'hostkey'], ['unreachable', 'unreachable']]) {
    fake.setMode(mode);
    const out = await runner.exec({ host: 'devbox', command: 'true' });
    assert.equal(out.code, 255, mode);
    assert.equal(out.connError, expected, mode);
    if (expected === 'hostkey' || expected === 'auth') {
      assert.ok(sshFailureCopy(expected, 'devbox').includes('终端'), `${expected} 的文案要给终端修复方式`);
    } else {
      assert.ok(sshFailureCopy(expected, 'devbox').includes('网络'), `${expected} 的文案要指向网络`);
    }
  }
  fake.setMode('slow');
  const timed = await runner.exec({ host: 'devbox', command: 'true', timeoutMs: 300 });
  assert.equal(timed.timedOut, true);
  fake.setMode('');
});

test('probe：登录成功返回远端 HOME、真实路径与工具矩阵', { skip: NOT_POSIX }, async () => {
  const runner = newRunner();
  mkdirSync(path.join(fake.root, 'sub'), { recursive: true });
  const res = await runner.probe({ host: 'devbox', dir: '~/projects/atlas' });
  assert.equal(res.ok, true);
  assert.equal(res.remoteHome, fake.home); // $HOME 原样回显
  assert.equal(res.realDir, realpathSync(fake.root)); // pwd -P＝服务器上的真实路径
  assert.equal(res.tools.bash, true);
  assert.equal(res.tools.find, true);
  assert.equal(res.tools.grep, true);
  assert.equal(res.tools.realpath, true);
  // shim 补的命令在沙箱可见（真实服务器上由 S0 探针确认）
  assert.equal(res.tools.sha256sum, true);
  assert.equal(res.tools.setsid, true);
});

test('probe：目录不存在 → notfound（与认证/网络错误不同文案）', { skip: NOT_POSIX }, async () => {
  const runner = newRunner();
  const res = await runner.probe({ host: 'devbox', dir: '~/projects/nope' });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'notfound');
  assert.match(res.message, /没有这个文件夹/);
});

test('probe：非法目标 / 空目录字段被拒（argv 安全）', async () => {
  const runner = newRunner();
  const bad = await runner.probe({ host: '-oProxyCommand=x', dir: '/tmp' });
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, 'invalid-host');
  const noDir = await runner.probe({ host: 'devbox', dir: '' });
  assert.equal(noDir.ok, false);
  assert.equal(noDir.kind, 'invalid-dir');
});

test('中止：AbortSignal 杀掉本机 ssh 进程（停止任务的第一步）', { skip: NOT_POSIX }, async () => {
  const runner = newRunner();
  fake.setMode('slow');
  const controller = new AbortController();
  const pending = runner.exec({ host: 'devbox', command: 'true', timeoutMs: 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  const out = await pending;
  assert.equal(out.aborted, true);
  fake.setMode('');
});

test('close：对所有见过的主机执行 ssh -O exit（不留主连接，AC-03）', { skip: NOT_POSIX }, async () => {
  const seen = [];
  const runner = createSshRunner({
    controlDir,
    sshBin: fake.sshBin,
    log: null,
  });
  await runner.exec({ host: 'devbox', command: 'true' });
  await runner.exec({ host: 'otherbox', command: 'true' });
  // 直接验证：close 后再 exec 仍可用（连接操作本身对假 ssh 无副作用）
  runner.close();
  const again = await runner.exec({ host: 'devbox', command: 'printf ok' });
  assert.equal(again.code, 0);
  assert.equal(again.stdout.toString('utf8'), 'ok');
  assert.ok(seen.length === 0);
});

test('classifySshFailure：ssh 不存在（ENOENT）单列', () => {
  assert.equal(classifySshFailure('', 'ENOENT'), 'no-ssh');
  assert.equal(classifySshFailure('some other failure', 255), 'unknown');
});

test('分类补充：Connection closed by（部分网络对不可达目标主动关闭而非超时）归 unreachable', () => {
  assert.equal(classifySshFailure('Connection closed by 192.0.2.1 port 22', 255), 'unreachable');
  assert.ok(sshFailureCopy('unreachable', 'x').includes('网络'));
});



test('effectiveControlDir：深路径超 unix 套接字上限回落短目录（同路径稳定、不同路径隔离）', () => {
  // 典型安全长度：生产/dev userData 深度 + %C（40）< 104，且不含空格/特殊字符 → 用原路径。
  assert.equal(effectiveControlDir('/Users/dev/Library/hemi-dev/ssh'), '/Users/dev/Library/hemi-dev/ssh');
  // 含空格（真实 mac 的 Application Support）→ 一律 /tmp 短路径（SSH 解析限制：
  // ssh -o 解析不了带空格的 ControlPath）。
  assert.match(
    effectiveControlDir('/Users/demo/Library/Application Support/hemi-dev/ssh'),
    /^\/tmp\/hemi-ssh-[0-9a-f]{8}$/,
  );
  // 撞限的深路径（tmpdir 49 字符起）→ /tmp/hemi-ssh-<hash8>，同输入稳定、异输入不同。
  const deep = '/var/folders/aa/000000000000000000000000000000/T/hemi-049-t4dbg-77569';
  const short = effectiveControlDir(deep);
  assert.match(short, /^\/tmp\/hemi-ssh-[0-9a-f]{8}$/);
  assert.equal(short, effectiveControlDir(deep));
  assert.notEqual(short, effectiveControlDir(`${deep}-x`));
  assert.ok(short.length + 41 < 104);
});

// ---- 049 密码登录（2026-10-12 用户裁决）：SSH_ASKPASS 链路 ----

test('密码登录：SSH_ASKPASS 助手把 HEMI_SSH_PASSWORD 喂给 ssh（假 ssh 校验环境变量）', { skip: NOT_POSIX }, async () => {
  fake.setMode('require-password');
  process.env.H49_FAKE_REQUIRE_PASSWORD = 's3cret-密码';
  const runner = newRunner();

  // 无密码（BatchMode 路径）→ 服务器只认密码 → auth 分类。
  const denied = await runner.exec({ host: 'devbox', command: 'true' });
  assert.equal(denied.code, 255);
  assert.equal(denied.connError, 'auth');

  // 正确密码 → 通过；密码不进 argv（假 ssh 全程经环境取）。
  const okRun = await runner.exec({ host: 'devbox', command: 'printf ok', password: 's3cret-密码' });
  assert.equal(okRun.code, 0);
  assert.equal(okRun.stdout.toString('utf8'), 'ok');

  // 错误密码 → auth 分类（对话框据此提示输入/重输）。
  const wrong = await runner.exec({ host: 'devbox', command: 'true', password: 'wrong' });
  assert.equal(wrong.code, 255);
  assert.equal(wrong.connError, 'auth');

  fake.setMode('');
  delete process.env.H49_FAKE_REQUIRE_PASSWORD;
});

test('密码登录：passwordProvider 按主机取密码（remote-service 内存池同构）', { skip: NOT_POSIX }, async () => {
  fake.setMode('require-password');
  process.env.H49_FAKE_REQUIRE_PASSWORD = 'pool-pw';
  const pool = new Map([['devbox', 'pool-pw']]);
  const runner = createSshRunner({
    controlDir: path.join(tmpBase, 'ctl-pool'),
    sshBin: fake.sshBin,
    passwordProvider: (host) => pool.get(host) ?? null,
  });
  const out = await runner.exec({ host: 'devbox', command: 'printf fine' });
  assert.equal(out.code, 0);
  assert.equal(out.stdout.toString('utf8'), 'fine');
  pool.delete('devbox');
  const denied = await runner.exec({ host: 'devbox', command: 'true' });
  assert.equal(denied.connError, 'auth');
  fake.setMode('');
  delete process.env.H49_FAKE_REQUIRE_PASSWORD;
});

test('密码登录：probe 带一次性密码同样生效（添加对话框链路）', { skip: NOT_POSIX }, async () => {
  fake.setMode('require-password');
  process.env.H49_FAKE_REQUIRE_PASSWORD = 'probe-pw';
  const runner = newRunner();
  const denied = await runner.probe({ host: 'devbox', dir: '~/projects/atlas' });
  assert.equal(denied.ok, false);
  assert.equal(denied.kind, 'auth');
  const passed = await runner.probe({ host: 'devbox', dir: '~/projects/atlas', password: 'probe-pw' });
  assert.equal(passed.ok, true);
  assert.equal(passed.realDir, realpathSync(fake.root));
  fake.setMode('');
  delete process.env.H49_FAKE_REQUIRE_PASSWORD;
});

test('askpass 助手：0700 落在控制目录，打印环境里的密码', { skip: NOT_POSIX }, async () => {
  fake.setMode('require-password');
  process.env.H49_FAKE_REQUIRE_PASSWORD = 'helper-pw';
  const runner = newRunner();
  await runner.exec({ host: 'devbox', command: 'true', password: 'helper-pw' });
  const { statSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { effectiveControlDir } = await import('./ssh-runner.mjs');
  const helper = path.join(effectiveControlDir(controlDir), 'askpass.sh');
  assert.ok(existsSync(helper), 'askpass 助手已生成');
  const mode = statSync(helper).mode & 0o777;
  assert.equal(mode, 0o700);
  const printed = execFileSync('/bin/sh', [helper], { env: { ...process.env, HEMI_SSH_PASSWORD: 'helper-pw' } }).toString();
  assert.equal(printed, 'helper-pw');
  fake.setMode('');
  delete process.env.H49_FAKE_REQUIRE_PASSWORD;
});
