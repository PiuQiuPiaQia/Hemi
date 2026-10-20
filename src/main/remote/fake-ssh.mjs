// 049 测试支撑：生成一个假 ssh 可执行文件（node 脚本），把远端命令落到本机
// 沙箱目录执行——ssh-runner/remote-fs 的确定性单测用（S1 口径：mock ssh 可
// 执行文件；真实服务器行为由 S0 探针验收）。
//
// 环境变量（测试进程设置，spawn 继承）：
//   H49_FAKE_SSH_SANDBOX  沙箱根：home=$SANDBOX/home，PATH 前置 $SANDBOX/shim
//   H49_FAKE_SSH_MODE     故障注入：auth / hostkey / unreachable / slow / crash
//   H49_FAKE_SSH_STDERR_EXIT  额外：命令以 255 退出并打这段 stderr（测断线分类）
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

const FAKE_SSH_SCRIPT = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
let host = null;
let i = 0;
for (; i < args.length; i++) {
  if (args[i] === '-O') process.exit(0); // ControlMaster 管理操作：一律成功
  if (args[i] === '-o') { i += 1; continue; }
  host = args[i];
  i += 1;
  break;
}
const command = args.slice(i).join(' ');
const mode = process.env.H49_FAKE_SSH_MODE;
if (mode === 'auth') { process.stderr.write(host + ': Permission denied (publickey).\\n'); process.exit(255); }
if (mode === 'hostkey') { process.stderr.write('Host key verification failed.\\n'); process.exit(255); }
if (mode === 'unreachable') { process.stderr.write('ssh: Could not resolve hostname ' + host + ': nodename nor servname provided\\n'); process.exit(255); }
if (mode === 'slow') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); process.exit(0); }
if (mode === 'stderr-exit') { process.stderr.write(process.env.H49_FAKE_SSH_STDERR_EXIT + '\\n'); process.exit(255); }
// 密码模式：H49_FAKE_REQUIRE_PASSWORD=<期望密码>——模拟「只认密码」的服务器：
// 子进程环境 HEMI_SSH_PASSWORD（SSH_ASKPASS 助手取的那个）不对就 Permission denied。
if (mode === 'require-password') {
  const want = process.env.H49_FAKE_REQUIRE_PASSWORD;
  const got = process.env.HEMI_SSH_PASSWORD;
  if (!got || got !== want) { process.stderr.write(host + ': Permission denied (password).\\n'); process.exit(255); }
}
const sandbox = process.env.H49_FAKE_SSH_SANDBOX;
if (!sandbox) { process.stderr.write('fake-ssh: missing H49_FAKE_SSH_SANDBOX\\n'); process.exit(254); }
const env = {
  PATH: path.join(sandbox, 'shim') + ':' + process.env.PATH,
  HOME: path.join(sandbox, 'home'),
  TMPDIR: path.join(sandbox, 'tmp'),
};
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => { /* 对端先退，按已有内容继续 */ });
process.stdin.on('end', () => {
  const out = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, ...env }, input: Buffer.concat(chunks), encoding: 'buffer' });
  if (out.stdout && out.stdout.length) process.stdout.write(out.stdout);
  if (out.stderr && out.stderr.length) process.stderr.write(out.stderr);
  process.exit(out.status == null ? 124 : out.status);
});
`;

/**
 * 建一个假 ssh 环境。
 * @returns {{ sshBin: string, sandbox: string, home: string, root: string,
 *             setMode(mode?: string): void, setStderrExit(text?: string): void }}
 *  root＝拟远端项目目录（sandbox/home/projects/atlas），预先创建。
 */
export function setupFakeSsh(baseDir) {
  const sandbox = path.join(baseDir, 'sandbox');
  const home = path.join(sandbox, 'home');
  const root = path.join(home, 'projects', 'atlas');
  const shim = path.join(sandbox, 'shim');
  const tmp = path.join(sandbox, 'tmp');
  const bin = path.join(sandbox, 'ssh');
  mkdirSync(home, { recursive: true });
  mkdirSync(shim, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(bin, FAKE_SSH_SCRIPT, 'utf8');
  chmodSync(bin, 0o755);
  // macOS 无 sha256sum/setsid：shim 补齐（sha256sum=shasum -a 256；setsid=直通）。
  writeFileSync(path.join(shim, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', 'utf8');
  writeFileSync(path.join(shim, 'setsid'), '#!/bin/sh\nexec "$@"\n', 'utf8');
  chmodSync(path.join(shim, 'sha256sum'), 0o755);
  chmodSync(path.join(shim, 'setsid'), 0o755);
  process.env.H49_FAKE_SSH_SANDBOX = sandbox;
  return {
    sshBin: bin,
    sandbox,
    home,
    root,
    setMode(mode = '') {
      if (mode) process.env.H49_FAKE_SSH_MODE = mode;
      else delete process.env.H49_FAKE_SSH_MODE;
    },
    setStderrExit(text = '') {
      if (text) process.env.H49_FAKE_SSH_STDERR_EXIT = text;
      else delete process.env.H49_FAKE_SSH_STDERR_EXIT;
    },
  };
}
