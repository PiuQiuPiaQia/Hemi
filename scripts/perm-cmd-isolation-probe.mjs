#!/usr/bin/env node
// 042 · P0-1 命令隔离探针：Seatbelt（sandbox-exec）候选后端的反向验证。
// 钉死的事实（2026-10-05 实测，macOS darwin 25）：
//   F1 窄读白名单（deny default＋少量 allow）会让常见二进制静默 SIGABRT（无日志），不可用；
//   F2 裸 (allow file-read*) 之后，subpath 级 (deny file-read*) 无效（通配 allow 压过窄 deny，与顺序无关）；
//   F3 但具体操作的窄 deny——(deny file-read-data/metadata (subpath X))——能压过通配 allow；
//   F4 显式裸 (deny file-write*) 连继承管道的 stdout 写都拦（deny default 不拦）→ 写用「白名单＋deny default」；
//   F5 /bin/sh 在本机会转 exec /bin/bash（variant 机制），exec 白名单必须带上实际解释器；
//   F6 执法按解析后的真实路径（错误信息里是 /private/var/... 字面）——链接语义由用例⑧实测。
// 可用 profile 形态：全读 － 具体操作窄 deny（用户树/范围外）＋ 写白名单 ＋ deny network* ＋ exec 白名单。
// 输出 PASS/FAIL；非 0 退出＝存在 FAIL。
import { mkdtemp, rm, mkdir, writeFile, symlink, stat, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const results = [];
const check = (name, ok, note = '') => {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ' · ' + note : ''}`);
};

const raw = await mkdtemp(path.join(tmpdir(), 'hemi-p0-cmd-'));
const tmp = await realpath(raw);                 // 授权根存真实路径（P0-3 事实）
const allow = path.join(tmp, 'allow');
const outside = path.join(tmp, 'outside');
await mkdir(path.join(allow, 'sub'), { recursive: true });
await mkdir(outside, { recursive: true });
const inFile = path.join(allow, 'in.txt');
await writeFile(inFile, 'inside');
await writeFile(path.join(outside, 'secret.txt'), 'outside');
await symlink(path.join(outside, 'secret.txt'), path.join(allow, 'leak-link'));
await symlink(outside, path.join(allow, 'leak-dir'));
const homeCanary = path.join(homedir(), '.zshenv'); // 用户树样本（存在与否都行）

// exec 白名单：/bin/sh 转exec bash（F5），故同时列 bash/sh；curl 用于网络层用例。
const EXECS = ['/bin/bash', '/bin/sh', '/bin/cat', '/bin/ls', '/bin/mkdir', '/usr/bin/curl'];
const profile = `
(version 1)
(deny default)
(allow file-read*)
(deny file-read-data (subpath "${outside}") (subpath "${homedir()}"))
(deny file-read-metadata (subpath "${outside}") (subpath "${homedir()}"))
(allow file-write* (subpath "${allow}") (literal "/dev/null"))
(allow process-fork)
(deny network*)
(allow process-exec${EXECS.map((e) => ` (literal "${e}")`).join('')})
`;
const profilePath = path.join(tmp, 'profile.sb');
await writeFile(profilePath, profile);

const run = (argv, timeout = 20_000) =>
  new Promise((resolve) => {
    execFile('/usr/bin/sandbox-exec', ['-f', profilePath, ...argv],
      { timeout, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 'ERR') : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
const sh = (script, timeout = 20_000) => run(['/bin/bash', '-c', script], timeout);

// ① 范围内读
{
  const r = await sh(`cat ${JSON.stringify(inFile)}`);
  check('范围内读放行', r.code === 0 && r.stdout.trim() === 'inside', r.code === 0 ? '' : `code=${r.code} ${r.stderr.slice(0, 60)}`);
}
// ② 范围内写＋回读
{
  const r = await sh(`echo hi > ${JSON.stringify(path.join(allow, 'w.txt'))} && cat ${JSON.stringify(path.join(allow, 'w.txt'))}`);
  check('范围内写＋回读放行', r.code === 0 && r.stdout.trim() === 'hi', r.code === 0 ? '' : `code=${r.code} ${r.stderr.slice(0, 60)}`);
}
// ③ 范围外读拒（直接 + 经 shell）
{
  const r1 = await run(['/bin/cat', path.join(outside, 'secret.txt')]);
  const r2 = await sh(`cat ${JSON.stringify(path.join(outside, 'secret.txt'))}`);
  check('范围外读拒绝（直接与经 shell）', r1.code !== 0 && r2.code !== 0, `direct=${r1.code} sh=${r2.code}`);
}
// ③b 用户树读拒（生产形态核心：/Users 下的东西默认不可读）
{
  const r = await run(['/bin/cat', homeCanary]);
  const denied = r.code !== 0 && !r.stdout.trim();
  check('用户主目录读拒绝（通配 allow ＋ 具体操作窄 deny 生效）', denied, `code=${r.code}`);
}
// ④ 范围外写拒（文件不落地）
{
  const r = await sh(`echo x > ${JSON.stringify(path.join(outside, 'x.txt'))}`);
  const leaked = await stat(path.join(outside, 'x.txt')).then(() => true, () => false);
  check('范围外写拒绝（未落地）', r.code !== 0 && !leaked, `code=${r.code} leaked=${leaked}`);
}
// ⑤ 网络：curl 可执行但必须连不出去（起真实本地监听，避免「拒绝连接」冒充拦截）
{
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.end('REACHED'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const r = await sh(`/usr/bin/curl -sS --max-time 5 http://127.0.0.1:${port}/ 2>&1; echo "exit=$?"`);
  const denied = !r.stdout.includes('REACHED');
  // 对照：同一监听、无沙箱必须能连通，否则上面的"拒绝"只是端口问题（假阳性）。
  const ctrl = await new Promise((resolve) => {
    execFile('/usr/bin/curl', ['-sS', '--max-time', '5', `http://127.0.0.1:${port}/`],
      (_e, stdout) => resolve(String(stdout)));
  });
  check('网络出口拒绝（exec 白名单内但 deny network* 生效）', denied && ctrl.includes('REACHED'),
    `sandbox=${r.stdout.trim().slice(0, 60)} / 对照可达=${ctrl.includes('REACHED')}`);
  server.close();
}
// ⑥ 未白名单可执行文件拒绝（python3）
{
  const r = await run(['/usr/bin/python3', '-c', 'print(1)']);
  check('未白名单可执行文件拒绝（python3）', r.code !== 0, `code=${r.code}`);
}
// ⑦ AppleScript 拒绝
{
  const r = await run(['/usr/bin/osascript', '-e', 'return 1']);
  check('AppleScript/OSA 拒绝', r.code !== 0, `code=${r.code}`);
}
// ⑧ 链接逃逸：范围内链接 → 范围外文件（读）与链接目录＋新文件（写）
{
  const r = await run(['/bin/cat', path.join(allow, 'leak-link')]);
  const blocked = r.code !== 0 && !r.stdout.includes('outside');
  check('符号链接逃逸（读）被拦', blocked, `code=${r.code} out=${r.stdout.slice(0, 20)}`);
}
{
  const r = await sh(`echo pwn > ${JSON.stringify(path.join(allow, 'leak-dir', 'pwn.txt'))}`);
  const landed = await stat(path.join(outside, 'pwn.txt')).then(() => true, () => false);
  check('链接目录逃逸（写）被拦且未落地', r.code !== 0 && !landed, `code=${r.code} landed=${landed}`);
}
// ⑨ 终止信号可及（撤销可取消在途命令）
{
  const t0 = Date.now();
  const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/bash', '-c', 'sleep 30']);
  const code = await new Promise((resolve) => {
    const done = (c) => resolve(c);
    child.on('exit', done); child.on('error', () => done('ERR'));
    setTimeout(() => { child.kill('SIGKILL'); setTimeout(() => done('TIMEOUT'), 500); }, 4000);
  });
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGTERM');
  const dt = Date.now() - t0;
  check('终止信号可及（SIGTERM 秒级退出）', code !== 0 && code !== null && dt < 3000, `exit=${code} ${dt}ms`);
}

console.log(`FACT  profile 落盘：${profilePath}（本轮结束即删；形态见文件头注释 F1–F6）`);
await rm(raw, { recursive: true, force: true }).catch(() => {});
const fails = results.filter((r) => !r.ok);
console.log(`\nP0-1 结果：${results.length - fails.length}/${results.length} 通过${fails.length ? '，存在 FAIL' : ''}`);
process.exit(fails.length ? 1 : 0);
