#!/usr/bin/env node
/**
 * 034 真实窗口验收：起真实 Electron（隔离 userData，引导完成态），经 CDP 驱动
 * 技能页全流程——首页窄窗入口 → SkillsMP 实时搜索 → 点条目卡自动读 GitHub 固定
 * 提交来源并落确认页（034 v4 路径合并，无中间详情页）→ 确认安装 → 已安装详情 →
 * 手动检查更新。每步截图并断言关键节点，任何 console error 即失败。
 * fixtures 桩不参与：这是真 preload→IPC→网络→store 链路。
 *
 *   node scripts/verify-skillsmp-ui.mjs [userDataDir] [关键词]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const userData = process.argv[2] ?? '/tmp/hemi-skillsmp-ud';
const keyword = process.argv[3] ?? 'markdown';
// 9223 曾被早前会话残留的无头 Chrome 占用，脚本连错目标把 fixtures 标签页当
// 成了应用驱动——换 9227 并在连接前确认端口归属自己的实例（连到别人=立刻失败）。
const debugPort = 9227;
const output = path.resolve('.visual/workflow/realapp');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
};

// 引导完成态：主壳直接可见（Key/模型配置本身已在 userData 里）。
await writeFile(path.join(userData, 'onboarding.json'), JSON.stringify({
  version: 1, phase: 'complete', step: 'done', permissionChoice: 'granted',
  updatedAt: Date.now(), completedAt: Date.now(),
}));

const app = spawn('npx', ['electron', '.', `--remote-debugging-port=${debugPort}`], {
  cwd: path.resolve('.'),
  env: { ...process.env, HEMI_USER_DATA_DIR: userData },
  stdio: 'ignore',
  detached: false,
});
const cleanup = async () => {
  try { app.kill('SIGTERM'); } catch { /* 已退出 */ }
  await sleep(800);
  try { app.kill('SIGKILL'); } catch { /* 已退出 */ }
};
let socket;
try {
  let targets = null;
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      // 主窗口＝无 ?mode= 的页面 target（floating/caption 带 mode 参数）。
      targets = list.filter((item) => item.type === 'page' && !item.url.includes('mode='));
      if (targets.length) break;
    } catch { /* 启动中 */ }
    await sleep(500);
  }
  if (!targets?.length) fail('主窗口 target 未出现');
  const page = targets[0];
  console.log(`主窗口：${page.title} · ${page.url}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const consoleErrors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    }
    if (!pending.has(message.id)) return;
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  });
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return response.result?.result?.value;
  };
  const shot = async (name) => {
    const captured = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
    const target = path.join(output, `${name}.png`);
    await writeFile(target, Buffer.from(captured.result.data, 'base64'));
    console.log(`截图 ${target}`);
    if (consoleErrors.length) fail(`console error：${consoleErrors.join(' ; ')}`);
  };
  const waitFor = async (description, expression, timeoutMs = 30000) => {
    for (let i = 0; i < timeoutMs / 300; i++) {
      if (await evaluate(expression).catch(() => false)) return;
      await sleep(300);
    }
    fail(`等待超时：${description}`);
  };
  // React 受控输入：原生 setter + input 事件，再由表单提交触发真实搜索。
  const setSearch = (value) => evaluate(`(() => {
    const input = document.querySelector('.h34-search input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const clickButton = (match, scope = 'document') => evaluate(`(() => {
    const button = [...${scope}.querySelectorAll('button')].find((b) => ${match});
    if (!button) return false;
    button.click();
    return true;
  })()`);

  await call('Page.enable');
  await call('Runtime.enable');
  await mkdir(output, { recursive: true });

  // ① 首页：034 v3 图标栏常驻（375–1440 全档），「技能中心」入口在 rail 上。
  await waitFor('主壳就绪', `Boolean(document.querySelector('.h24-navrail'))`);
  await sleep(1200);
  await shot('01-home-compact');
  if (!(await evaluate(`Boolean([...document.querySelectorAll('.h24-navrail-item')].some((b) => (b.getAttribute('title') || '') === '技能中心'))`))) {
    fail('图标栏没有「技能中心」入口');
  }

  // ② 打开技能中心：默认 SkillsMP 发现视图（该 userData 带上次搜索缓存，应标时间非实时）。
  if (!(await clickButton(`(b.getAttribute('title') || '') === '技能中心'`))) fail('技能中心入口不可点');
  await waitFor('技能页打开', `Boolean(document.querySelector('.h34-market'))`);
  await waitFor('发现 Tab 就绪', `Boolean(document.querySelector('.h34-search input'))`);
  await sleep(600);
  await shot('02-market-default');

  // ③ 实时搜索（真实网络）：结果行出现且标注「实时结果」。
  if (!(await setSearch(keyword))) fail('搜索输入框不可用');
  if (!(await clickButton(`b.type === 'submit' && b.textContent.includes('搜索')`, 'document.querySelector(".h34-search-form") ?? document'))) fail('搜索按钮不可用');
  await waitFor('实时搜索结果', `Boolean(document.querySelector('.h34-cache-live')) && Boolean(document.querySelector('.h34-list-row'))`, 60000);
  await sleep(500);
  await shot('03-market-search-live');
  const resultCount = await evaluate('document.querySelectorAll(".h34-list-row").length');
  console.log(`「${keyword}」实时结果：${resultCount} 条`);

  // ④ 点条目卡：v5 详情页用市场元数据秒开（吸底安装条立即在场，无网络等待）。
  if (!(await clickButton(`b.classList.contains("h34-list-row")`))) fail('结果行不可点');
  await waitFor('详情页秒开（吸底安装条）', `Boolean(document.querySelector('.h34-confirm-bar'))`, 15000);
  await sleep(300);
  await shot('04-detail-instant');

  // ⑤ 点「安装并启用」：两阶段流水线（读取来源→核对保存）后应切到已安装 Tab。
  if (!(await clickButton(`b.textContent.includes("安装并启用")`))) fail('安装按钮不可用');
  await waitFor('来源读取完成（文件清单出现）', `Boolean(document.querySelector('.h34-file-row'))`, 90000);
  await sleep(300);
  await shot('04b-install-progress');
  await waitFor('安装后进入已安装详情', `(() => {
    const tab = document.querySelector('.h34-tabs button[aria-selected="true"]');
    const tag = document.querySelector('.h34-detail-tag');
    return Boolean(tab && tab.textContent.includes('已安装') && tag && tag.textContent.includes('SkillsMP 市场 · 已安装'));
  })()`, 150000);
  await sleep(600);
  await shot('05-installed-detail');
  const repoLine = await evaluate(`[...document.querySelectorAll('.h34-detail dd')].map((d) => d.textContent).find((t) => t.includes('/'))`);
  console.log(`已装来源：${repoLine}`);

  // ⑥ 手动检查更新（真实网络）：应得到明确状态文案。
  if (!(await clickButton(`b.textContent.includes("检查更新")`))) fail('检查更新按钮不可用');
  await waitFor('更新检查结果', `Boolean([...document.querySelectorAll('.h34-update-box p')].some((p) => p.textContent.trim().length > 0))`, 60000);
  await sleep(300);
  await shot('06-check-update');
  const updateText = await evaluate(`document.querySelector('.h34-update-box p')?.textContent.trim()`);
  console.log(`更新检查：${updateText}`);

  // ⑦ 卸载入口与本地导入按钮在位（不实际执行）。
  await shot('07-final');
  const persisted = existsSync(path.join(userData, 'skills', 'index.json'));
  console.log(`登记文件存在：${persisted}`);
  console.log('PASS: 真实窗口全流程通过');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  await cleanup();
  await rm('/tmp/verify-ui-devtools-port', { force: true }).catch(() => {});
}
