#!/usr/bin/env node
/**
 * 049 S0 环境探针（试验计划 T-01～T-05 的载体）：对指定 SSH 目标跑
 * 支持矩阵与关键行为测量，结果打 JSON（表观供技术方案回填）。
 *
 *   node scripts/probe-049-s0.mjs --host devbox [--dir '~/projects/atlas'] [--fake]
 *
 * - T-01 登录＋命令矩阵：bash/find/grep/realpath/ls/setsid/sha256sum/head/wc/stat。
 * - T-02 ControlMaster 往返：首连（握手）耗时 vs 复用后 20 次中位/均值（技术方案
 *   性能口径：复用后单次工具往返目标几十毫秒量级）。
 * - T-03 setsid 进程组停止：长命令包 pgid（与 hemiRemoteBash 同一包装），另一条
 *   连接按组 TERM，验证进程树全灭（AC-06 的远端侧依据）。
 * - T-04 断线错误形态：杀主连接（ssh -O exit＋删 socket）后 exec 应为 255 且可分类
 *   （真实「断网」形态由 AC-06 手动关网罩复核，脚本只钉 master 失效）。
 * - T-05 错误分类（指纹未确认/认证失败）需要真实故障主机，脚本打印手动步骤。
 * --fake：用假 ssh（本机沙箱当服务器）自验探针链路，不连任何真实主机。
 * 纪律：只读探测＋远端 mktemp 试验目录（带 hemi-049-s0 标识），结束即清理，
 * 不碰已有项目（specs「服务器上需要的命令」/试验计划前置）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSshRunner, shq } from '../src/main/remote/ssh-runner.mjs';

function argOf(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const fakeMode = process.argv.includes('--fake');
const host = argOf('host', 'devbox');
const dir = argOf('dir');

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

let fake = null;
if (fakeMode) {
  const { setupFakeSsh } = await import('../src/main/remote/fake-ssh.mjs');
  const base = mkdtempSync(path.join(os.tmpdir(), 'h49-s0-'));
  fake = setupFakeSsh(base);
  process.on('exit', () => { try { rmSync(base, { recursive: true, force: true }); } catch {} });
}

const controlDir = fake ? path.join(fake.sandbox, 'ctl') : path.join(os.tmpdir(), `hemi-049-s0-${process.pid}`);
const runner = createSshRunner({ controlDir, sshBin: fake ? fake.sshBin : 'ssh' });

const out = { date: new Date().toISOString().slice(0, 10), host, mode: fakeMode ? 'fake' : 'real', checks: [] };
const check = (id, pass, data = {}) => {
  out.checks.push({ id, pass: Boolean(pass), ...data });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}${data.note ? ` · ${data.note}` : ''}`);
};

// ---- T-01：登录＋命令矩阵（含试验目录探察） ----
{
  const probeTarget = dir ?? '~';
  const res = await runner.probe({ host, dir: probeTarget });
  if (!res.ok) {
    console.error(`T-01 登录失败（${res.kind}）：${res.message}`);
    process.exit(1);
  }
  check('T-01 登录与命令矩阵', true, { note: `home=${res.remoteHome} · tools=${Object.entries(res.tools).filter(([, v]) => v).map(([k]) => k).join(',')}`, tools: res.tools, remoteHome: res.remoteHome });
}

// ---- T-02：ControlMaster 往返耗时 ----
{
  const t0 = Date.now();
  await runner.exec({ host, command: 'true' });
  const firstMs = Date.now() - t0;
  const samples = [];
  for (let i = 0; i < 20; i += 1) {
    const t = Date.now();
    await runner.exec({ host, command: 'true' });
    samples.push(Date.now() - t);
  }
  const reusedMedian = median(samples);
  check('T-02 ControlMaster 复用往返', reusedMedian < 500, {
    note: `首连 ${firstMs}ms · 复用中位 ${reusedMedian}ms / 均值 ${Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)}ms`,
    firstMs, reusedMedianMs: reusedMedian,
  });
}

// ---- T-03：setsid 进程组停止（远端 mktemp 试验目录内跑，结束清理） ----
{
  const mk = await runner.exec({ host, command: 'd=$(mktemp -d /tmp/hemi-049-s0.XXXXXX) && printf %s "$d"' });
  const trialDir = mk.stdout.toString('utf8').trim();
  const marker = `${trialDir}/pgid`;
  const start = Date.now();
  const longRun = runner.exec({
    host,
    command: [
      `cd ${shq(trialDir)}`,
      `if command -v setsid >/dev/null 2>&1; then setsid sh -c 'sleep 60; touch done' & else sh -c 'sleep 60; touch done' & fi`,
      `printf '%s' "$!" > ${shq(marker)}`,
      'wait "$!"',
    ].join('\n'),
    timeoutMs: 15_000,
  }).catch((e) => ({ code: -1, stderr: String(e), stdout: Buffer.alloc(0) }));
  await new Promise((r) => setTimeout(r, fake ? 600 : 1200)); // 等远端进程起、pgid 落盘
  const pgid = (await runner.exec({ host, command: `cat ${shq(marker)} 2>/dev/null` })).stdout.toString('utf8').trim();
  await runner.exec({ host, command: `p=$(cat ${shq(marker)} 2>/dev/null); [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null; sleep 2; kill -KILL -- "-$p" 2>/dev/null` }).catch(() => {});
  const settled = await longRun;
  const alive = (await runner.exec({
    host,
    command: pgid ? `ps -eo pgid= | grep -qw "${pgid}" && echo ALIVE || echo GONE` : 'echo NOPGID',
  })).stdout.toString('utf8').trim();
  await runner.exec({ host, command: `rm -rf ${shq(trialDir)}` }).catch(() => {});
  check('T-03 setsid 进程组停止', alive === 'GONE' && pgid !== '', {
    note: `pgid=${pgid || '(未取到)'} · 组内进程=${alive} · 命令退出码=${settled.code} · 耗时 ${Date.now() - start}ms`,
    pgid, alive, exitCode: settled.code,
  });
}

// ---- T-04：不可达目标的错误形态（真实「断网」形态由 AC-06 手动关网复核） ----
// `-O exit` 后 ControlMaster=auto 会直接重建主连接（exit 0 属正确行为），测不出
// 断连——这里改用保证不可路由的 TEST-NET-1 地址（RFC 5737，连接必然超时、不会
// 触达任何真实主机）验证分类链。用真 ssh（fake 模式下也走真 ssh——假 ssh 无法
// 模拟网络超时）。
{
  const unroutable = createSshRunner({ controlDir: path.join(os.tmpdir(), `hemi-049-s0-t4-${process.pid}`) });
  const t0 = Date.now();
  const broken = await unroutable.exec({ host: '192.0.2.1', command: 'true' });
  const classified = broken.connError ?? 'none';
  check('T-04 不可达目标 → 255 可分类', broken.code === 255 && ['timeout', 'unreachable'].includes(classified), {
    note: `exit=${broken.code} · 分类=${classified} · ${Date.now() - t0}ms`,
    exitCode: broken.code, kind: classified,
  });
  unroutable.close();
}

// ---- T-05：指纹/认证分类需要真实故障目标（打印手动步骤，不自动制造） ----
console.log('T-05（手动）：指纹未确认——用一个未登录过的新主机（或删 known_hosts 对应行）观察 stderr 是否「Host key verification failed」；认证失败——临时改一个错密码账号观察「Permission denied」。两者都应在添加对话框得到各自的终端修复文案（AC-02）。');

runner.close();
console.log(`\n${out.checks.every((c) => c.pass) ? 'S0 ALL PASS' : 'S0 HAS FAILURES'}`);
console.log(JSON.stringify(out, null, 2));
process.exit(out.checks.every((c) => c.pass) ? 0 : 1);
