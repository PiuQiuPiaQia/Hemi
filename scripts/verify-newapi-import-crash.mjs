// 047 强杀崩溃恢复演练（父进程编排）：
//   1. 假站在本进程内启动（跨两次 Electron 运行存活），探活故障挂住；
//   2. run A（crash）：跑到 validating（Key 已持、无回执）app.exit(0) 强杀；
//   3. run B（resume）：同 userData 冷启动 → listPending → resumePending → 断点续跑成功；
//   4. 断言：远端创建仍为 1（恢复不重建）、两次运行检查全过。
// 运行：node scripts/verify-newapi-import-crash.mjs（需先 npm run build）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { startMockSite } = await import('./mock-newapi-site.mjs');

const site = await startMockSite({});
site.state.fault = 'probe-hang'; // run A 的验证挂住 → 停在 validating 等强杀
const UD = '/tmp/hemi-047-crash-ud';
fs.rmSync(UD, { recursive: true, force: true });
fs.mkdirSync(UD, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
};

function runElectron(mode, { fault }) {
  return new Promise((resolve, reject) => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const electronBin = path.join(root, 'node_modules', '.bin', 'electron');
    const child = spawn(electronBin, ['scripts/verify-047-crash-electron.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        HEMI_SMOKE_TEST: '1',
        HEMI_PROVIDER_IMPORT_TEST_HTTP: '1',
        HEMI_USER_DATA_DIR: UD,
        HEMI_047_CRASH_MODE: mode,
        HEMI_047_CRASH_SITE: site.origin,
        HEMI_047_FAULT: fault,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => resolve({ code, output }));
    child.on('error', reject);
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 200000);
  });
}

function parseChecks(output) {
  const checks = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('CRASH_CHECK ')) {
      try { checks.push(JSON.parse(line.slice('CRASH_CHECK '.length))); } catch { /* ignore */ }
    }
  }
  return checks;
}

try {
  // —— run A：强杀 ——
  const crash = await runElectron('crash', { fault: 'probe-hang' });
  const crashChecks = parseChecks(crash.output);
  for (const item of crashChecks) check(`A·${item.name}`, item.ok, item.detail);
  check('A：强杀发生在 validating（无回执窗口）', crash.output.includes('CRASH_AT validating') && crash.code === 0, `exit=${crash.code}`);
  check('A：远端创建恰好一次', site.state.createCalls === 1, `createCalls=${site.state.createCalls}`);
  check('A：journal 残留待处理', fs.readdirSync(path.join(UD, 'provider-import')).some((name) => name.endsWith('.json')));

  // —— 解除故障，run B：冷启动断点恢复 ——
  site.state.fault = null;
  const resume = await runElectron('resume', { fault: null });
  const resumeChecks = parseChecks(resume.output);
  for (const item of resumeChecks) check(`B·${item.name}`, item.ok, item.detail);
  check('B：恢复后远端创建仍为 1（不重建）', site.state.createCalls === 1, `createCalls=${site.state.createCalls}`);
  check('B：journal 已清空', !fs.readdirSync(path.join(UD, 'provider-import')).some((name) => name.endsWith('.json')));
  check('B：退出码 0', resume.code === 0, `exit=${resume.code}`);

  site.server.closeAllConnections?.();
  await site.close().catch(() => undefined);
  const passed = results.every((item) => item.ok);
  console.log(`HEMI_047_CRASH_RESULT=${JSON.stringify({ passed, results })}`);
  process.exit(passed ? 0 : 1);
} catch (error) {
  console.error('[crash-verify] 失败：', error);
  site.server.closeAllConnections?.();
  process.exit(1);
}
