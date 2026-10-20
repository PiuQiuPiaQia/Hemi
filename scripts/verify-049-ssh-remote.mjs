#!/usr/bin/env node
/**
 * 049 真机验收 harness（试验计划「S1～S2：第一条真实远端任务」的载体）：
 * 隔离 userData 起真实应用，经 workspace.addRemote 登记远端项目并绑定会话，
 * 从 ASR 定稿入口注入任务，真实跑完 LLM → execute_task → 门控卡 → SSH 远端
 * 工具 → 回炉交代的全链。两种模式共用同一脚本：
 *
 *   真服务器（S0 后）：
 *     node scripts/verify-049-ssh-remote.mjs --host devbox --dir '~/projects/atlas' \
 *       --task '修复失败的测试并运行' [--user-data /tmp/hemi-049-ud]
 *
 *   假 ssh 沙箱（无服务器时的确定性全链验证；本机沙箱当「服务器」）：
 *     node scripts/verify-049-ssh-remote.mjs --host devbox --dir '~/projects/atlas' --fake
 *
 * 假模式的沙箱预置：AGENTS.md（约定：新文件头一行写「# atlas 项目」——验证
 * 远端上下文注入，AC-04 的「模型能说出远端 AGENTS.md 约定」）。
 * 必查（试验计划）：
 *   1. 「服务器」（沙箱）上的文件被写入、内容一致；
 *   2. 本机诱饵目录（同名 ~/projects/atlas）未被触碰；
 *   3. 应用退出后无残留 ssh 进程（假 ssh路径 pgrep；AC-03）；
 *   4. 登记表落盘带 host（AC-01）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

function argOf(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const fakeMode = process.argv.includes('--fake');
const host = argOf('host', 'devbox');
const remoteDir = argOf('dir', '~/projects/atlas');
const password = argOf('password');
const taskText = argOf('task') ?? '先读一下这个项目的 AGENTS.md，告诉我里面有什么约定，然后按约定在项目里创建 hello.txt，内容写：049 远端自测';
const timeoutMs = Number(argOf('timeout', 420000));

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'hemi-049-verify-'));
const userData = argOf('user-data', path.join(workRoot, 'user-data'));
mkdirSync(userData, { recursive: true });

const results = [];
const check = (name, ok, note = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` · ${note}` : ''}`);
};

/** 假 ssh 环境（同 src/main/remote/fake-ssh.mjs 的脚本，独立落一份避免产品依赖测试码）。 */
function buildFakeSsh() {
  const sandbox = path.join(workRoot, 'sandbox');
  const home = path.join(sandbox, 'home');
  const project = path.join(home, 'projects', 'atlas');
  const shim = path.join(sandbox, 'shim');
  const tmp = path.join(sandbox, 'tmp');
  const sshBin = path.join(sandbox, 'ssh');
  mkdirSync(project, { recursive: true });
  mkdirSync(shim, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(project, 'AGENTS.md'), '# atlas 项目约定\n- 本项目新建的文本文件，第一行写「# atlas 项目」。\n- 提交信息用中文。\n', 'utf8');
  const script = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
let host = null; let i = 0;
for (; i < args.length; i++) {
  if (args[i] === '-O') process.exit(0);
  if (args[i] === '-o') { i += 1; continue; }
  host = args[i]; i += 1; break;
}
const command = args.slice(i).join(' ');
// 密码模式（--password）：模拟只认密码的服务器——SSH_ASKPASS 取的 HEMI_SSH_PASSWORD 不对就拒。
const wantPw = process.env.H49_FAKE_REQUIRE_PASSWORD;
if (wantPw && process.env.HEMI_SSH_PASSWORD !== wantPw) {
  process.stderr.write(host + ': Permission denied (password).\\n');
  process.exit(255);
}
const sandbox = process.env.H49_FAKE_SSH_SANDBOX;
if (!sandbox) { process.stderr.write('fake-ssh: missing H49_FAKE_SSH_SANDBOX\\n'); process.exit(254); }
const env = { PATH: path.join(sandbox, 'shim') + ':' + process.env.PATH, HOME: path.join(sandbox, 'home'), TMPDIR: path.join(sandbox, 'tmp') };
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  const out = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, ...env }, input: Buffer.concat(chunks), encoding: 'buffer' });
  if (out.stdout && out.stdout.length) process.stdout.write(out.stdout);
  if (out.stderr && out.stderr.length) process.stderr.write(out.stderr);
  process.exit(out.status == null ? 124 : out.status);
});
`;
  writeFileSync(sshBin, script, 'utf8');
  chmodSync(sshBin, 0o755);
  writeFileSync(path.join(shim, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', 'utf8');
  writeFileSync(path.join(shim, 'setsid'), '#!/bin/sh\nexec "$@"\n', 'utf8');
  chmodSync(path.join(shim, 'sha256sum'), 0o755);
  chmodSync(path.join(shim, 'setsid'), 0o755);
  return { sandbox, sshBin, project };
}

const fake = fakeMode ? buildFakeSsh() : null;

// 隔离 userData：从生产拷 4 件套配置（safeStorage 同机可解密，AGENTS 自驱动口径）。
const prodData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi');
for (const name of ['doubao-asr.json', 'text-model.json', 'text-model-profiles.json', 'web-search.json']) {
  const from = path.join(prodData, name);
  if (existsSync(from)) cpSync(from, path.join(userData, name));
}
if (!existsSync(path.join(userData, 'text-model.json'))) {
  console.error('[verify-049] 生产配置缺失（text-model.json），无法跑真实模型链路');
  process.exit(2);
}

// 本机诱饵：与远端同名字符串路径（AC-04 必查 2——确认零本机读写）。
const decoy = path.join(os.homedir(), 'projects', 'atlas');
const decoyBefore = existsSync(decoy) ? execFileSync('find', [decoy, '-type', 'f', '-exec', 'stat', '-f', '%m %N', '{}', ';']).toString() : '(不存在)';

const electronBin = path.join(appRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const child = spawn(electronBin, [path.join(appRoot, 'scripts', 'self-run-task.mjs')], {
  env: {
    ...process.env,
    HEMI_SMOKE_TEST: '1',
    HEMI_USER_DATA_DIR: userData,
    HEMI_SELF_RUN_TASK: taskText,
    HEMI_SELF_RUN_REMOTE: `${host}::${remoteDir}`,
    HEMI_SELF_RUN_TIMEOUT: String(timeoutMs),
    ...(password ? { HEMI_SELF_RUN_REMOTE_PASSWORD: password } : {}),
    ...(fake ? {
      HEMI_SSH_BIN: fake.sshBin,
      H49_FAKE_SSH_SANDBOX: fake.sandbox,
      ...(password ? { H49_FAKE_REQUIRE_PASSWORD: password } : {}),
    } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
child.stdout.on('data', (chunk) => {
  appLog += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => { appLog += chunk; });
const timer = setTimeout(() => {
  console.error('[verify-049] 超时，杀掉应用');
  child.kill('SIGKILL');
}, timeoutMs + 60000);
const code = await new Promise((resolve) => child.on('close', resolve));
clearTimeout(timer);

console.log('\n==== 049 verify 汇总 ====');
check('应用 exit 0（远端任务终态 complete）', code === 0, `exit=${code}`);

const logText = (() => {
  try { return readFileSync(path.join(userData, 'hemi.log'), 'utf8'); } catch { return ''; }
})();

// 1. 「服务器」上的文件被写入（假模式可查；真模式提示人工核对）。
if (fake) {
  const hello = path.join(fake.project, 'hello.txt');
  const written = existsSync(hello) ? readFileSync(hello, 'utf8') : null;
  // 任务要求「按 AGENTS.md 约定创建」——约定行（# atlas 项目）在第一行属正确执行。
  check(
    '远端（沙箱）hello.txt 已写入（含约定行与正文）',
    written != null && written.includes('# atlas 项目') && written.includes('049 远端自测'),
    written == null ? '文件不在' : `内容="${written.trim().replace(/\n/g, ' ⏎ ').slice(0, 60)}"`,
  );
  check('AGENTS.md 约定进了任务上下文（交代提到约定）', /约定|第一行/.test(appLog) || /AGENTS/.test(appLog), '看应用输出里的交代');
} else {
  console.log(`[人工核对] 在 ${host} 上检查 ${remoteDir}/hello.txt 内容为「049 远端自测」`);
}

// 2. 本机诱饵未被触碰。
const decoyAfter = existsSync(decoy) ? execFileSync('find', [decoy, '-type', 'f', '-exec', 'stat', '-f', '%m %N', '{}', ';']).toString() : '(不存在)';
check('本机同名诱饵目录未被触碰', decoyBefore === decoyAfter);

// 3. 无残留 ssh 进程（假模式按假 ssh 路径 pgrep；真模式按 ControlPath 前缀）。
await new Promise((r) => setTimeout(r, 1500));
let sshLeft = 0;
try {
  const pgrep = execFileSync('pgrep', ['-f', fake ? fake.sshBin : `${userData}/ssh/`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  sshLeft = pgrep.split('\n').filter(Boolean).length;
} catch { sshLeft = 0; }
check('退出后无残留 ssh 进程', sshLeft === 0, `count=${sshLeft}`);

// 4. 登记表落盘带 host。
let registryOk = false;
try {
  const registry = JSON.parse(readFileSync(path.join(userData, 'workspaces.json'), 'utf8'));
  registryOk = (registry.projects ?? []).some((item) => item.host === host);
} catch { registryOk = false; }
check('workspaces.json 登记远端条目（带 host）', registryOk);

// 5. 任务档案的 workspace 快照带 host（R-04）。
const taskDir = path.join(userData, 'task-history');
let snapshotOk = false;
try {
  const files = execFileSync('find', [taskDir, '-name', '*.json']).toString().split('\n').filter(Boolean);
  snapshotOk = files.some((file) => readFileSync(file, 'utf8').includes(`"host": "${host}"`));
} catch { snapshotOk = false; }
check('任务档案快照带 host（R-04）', snapshotOk);

// 6. 远端工具确实经 ssh 执行（日志有远端命令留痕或远端上下文注入）。
check('执行链路走了远端（日志留痕）', /远端命令|远端工作区已登记|remote/.test(logText), 'hemi.log');
if (password) {
  check('密码登录链路（SSH_ASKPASS）走通', code === 0 && /远端工作区已登记/.test(logText), '只认密码的假服务器上完成登记与任务');
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `FAILED ${failed.length}/${results.length}`}`);
if (!process.argv.includes('--keep')) {
  try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* 残留不致命 */ }
}
process.exit(failed.length === 0 ? 0 : 1);
