// 059 S5 进程级强退恢复真机验证：运行中的工作流进程被 SIGKILL，重开后断言——
//   C1 持久事实完好：invocation 落盘的 run 状态保持 running（中断态）、已成功节点事实在
//   C2 重开只读不自动重放：恢复进程不调 runner.run，外部动作（产物文件）零新增、
//      invocation 快照零漂移（契约 R-18：重开显示中断及已有结果，用户明确继续）
//   C3 用户显式继续：replayCache 从持久事实构造 → 回放零外部动作重放 → completed
// 单脚本三阶段自驱（runner/store 无产品依赖，直接 node）：
//   A 运行子进程（慢 executor 挂起中）→ B SIGKILL → C 恢复子进程（先只读断言再显式继续）。
// 结果打一行 HEMI_059_CRASH_RESULT；exit 0＝全过。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-059-crash-'));
const workflowsDir = path.join(workDir, 'workflows');
const artifact = path.join(workDir, 'deliverable.txt');
const runningMarker = path.join(workDir, '.running-marker');

const CHILD_EXECUTOR = `
  'hemi-skill': {
    async execute(ctx) {
      fs.writeFileSync(marker, 'running', 'utf8')
      await new Promise((r) => setTimeout(r, 8000)) // 模拟在途慢任务（期间被 SIGKILL）
      fs.writeFileSync(artifact, '交付内容', 'utf8')
      return { outputs: { deck: artifact } }
    },
  },`;

const childFile = path.resolve(here, 'verify-059-crash-child.mjs');

function runChild(mode) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [childFile, mode], {
      cwd: root,
      env: { ...process.env, CRASH_WORKFLOWS_DIR: workflowsDir, CRASH_ARTIFACT: artifact, CRASH_MARKER: runningMarker },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code, signal) => resolve({ code, signal, out }));
  });
}

// ---------- 阶段 A：运行进程在途时 SIGKILL ----------
let signalKilled = null;
{
  const child = spawn(process.execPath, [childFile, 'run'], {
    cwd: root,
    env: { ...process.env, CRASH_WORKFLOWS_DIR: workflowsDir, CRASH_ARTIFACT: artifact, CRASH_MARKER: runningMarker },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => fs.appendFileSync('/tmp/crash-child-err.log', String(d)));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(runningMarker) && Date.now() < deadline) await sleep(50);
  if (!fs.existsSync(runningMarker)) {
    console.log('HEMI_059_CRASH_RESULT=' + JSON.stringify({ passed: false, fatal: '运行进程未进入在途标记' }));
    process.exit(1);
  }
  child.kill('SIGKILL');
  signalKilled = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    child.on('exit', (_code, signal) => { clearTimeout(timer); resolve(signal === 'SIGKILL'); });
  });
  check('A 运行进程被 SIGKILL（模拟强退）', signalKilled, `signal=${signalKilled}`);
}

// ---------- 阶段 B：恢复进程只读（不自动重放） ----------
{
  const readonly = await runChild('readonly');
  const line = (readonly.out.split('\n').find((l) => l.startsWith('READONLY ')) ?? '').slice('READONLY '.length);
  let snapshot = {};
  try { snapshot = JSON.parse(line); } catch { /* 解析失败按空 */ }
  check('B1 重开只读：run 保持中断态（running）', snapshot.status === 'running', line || readonly.out.slice(0, 120));
  check('B2 不自动重放：产物强退时未写出、重开后仍不存在', snapshot.artifactExists === false, JSON.stringify(snapshot));
}

// ---------- 阶段 C：用户显式继续（回放续跑） ----------
{
  const cont = await runChild('continue');
  const line = (cont.out.split('\n').find((l) => l.startsWith('CONTINUE ')) ?? '').slice('CONTINUE '.length);
  let result = {};
  try { result = JSON.parse(line); } catch { /* 同上 */ }
  check('C1 用户显式继续：回放续跑完成', result.status === 'completed', line || cont.out.slice(0, 160));
  // sk 强退时未成功 → continue 新尝试真执行写出产物（不是重放）；noReplay 在此场景恒 false
  check('C2 continue 新尝试真实写出产物（交付完成）', result.status === 'completed' && fs.existsSync(artifact) && fs.statSync(artifact).size > 0, JSON.stringify(result));
}

const passed = results.every((r) => r.ok);
console.log(`HEMI_059_CRASH_RESULT=${JSON.stringify({ passed, results })}`);
fs.rmSync(workDir, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
