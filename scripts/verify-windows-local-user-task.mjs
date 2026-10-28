// 无真实凭据的 Windows 用户流程验收；仅本次隔离实例的 loopback CDP。
// node scripts/verify-windows-local-user-task.mjs [--dev=http://127.0.0.1:5173]
// provider 初始化使用真实 IPC；后续引导、输入、发送、新建、设置开关均走 DOM。
// 本地模型只脚本化协议响应，文件只能由生产 agent 的 write 工具创建。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.versions.electron) {
  const { app, BrowserWindow } = await import('electron');
  // 自动化后台运行，不显示/聚焦窗口；不修改产品源码或用户实例。
  BrowserWindow.prototype.show = function () {};
  BrowserWindow.prototype.showInactive = function () {};
  BrowserWindow.prototype.focus = function () {};
  process.on('message', message => { if (message === 'verify-local-quit') app.quit(); });
  await import('../src/main/index.mjs');
  app.on('browser-window-created', (_event, win) => win.webContents.on('did-finish-load', () => win.hide()));
} else {
  const { default: electronBinary } = await import('electron');
  const { chromium } = await import('playwright-core');
  const dev = process.argv.find(arg => arg.startsWith('--dev='))?.slice(6);
  const mode = dev ? 'dev' : 'built';
  const out = path.join(ROOT, 'tmp', `windows-user-${mode}-${Date.now()}`);
  const ud = path.join(out, 'userData');
  fs.mkdirSync(out, { recursive: true });
  const marker = `windows-${mode}-${Date.now().toString(36)}`;
  const file = path.join(ud, 'workspace', 'default', 'hello-user.txt');
  const results = [];
  const requests = [];
  const record = (name, detail) => { results.push({ name, ok: true, detail }); console.log(`PASS ${name} ${JSON.stringify(detail ?? '')}`); };
  let child, browser, page;
  let stopping = false;
  let cdpPort;
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  cdpPort = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  let wrote = false;
  const mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const input = JSON.parse(body || '{}');
      const tools = input.tools?.map(tool => tool.function?.name) ?? [];
      requests.push({ url: req.url, tools, messages: input.messages });
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-1', object: 'model' }] }));
        return;
      }
      let delta;
      if (tools.includes('hemi_connection_check')) {
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'check', type: 'function', function: { name: 'hemi_connection_check', arguments: '{"ok":true}' } }] };
      } else if (tools.includes('write') && !wrote) {
        wrote = true;
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'write-local', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'hello-user.txt', content: `唯一标记：${marker}\n` }) } }] };
      } else {
        delta = { role: 'assistant', content: tools.includes('write') ? `文件已创建，唯一标记 ${marker}` : '本地文件任务' };
      }
      const finish = delta.tool_calls ? 'tool_calls' : 'stop';
      if (input.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'local-mock', object: 'chat.completion', choices: [{ index: 0, message: delta, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (d, f) => `data: ${JSON.stringify({ id: 'local-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-1', choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
        res.end(chunk(delta, null) + chunk({}, finish) + 'data: [DONE]\n\n');
      }
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;
  async function launch(restart = false) {
    const env = { ...process.env, HEMI_USER_DATA_DIR: ud };
    delete env.HEMI_SMOKE_TEST;
    delete env.HEMI_SELF_RUN_TEXT;
    delete env.HEMI_SELF_RUN_TEXT_SCENARIOS;
    delete env.ELECTRON_RUN_AS_NODE;
    if (dev) env.VITE_DEV_SERVER_URL = dev;
    else delete env.VITE_DEV_SERVER_URL;
    child = spawn(electronBinary, [fileURLToPath(import.meta.url), '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const log = fs.createWriteStream(path.join(out, restart ? 'restart.log' : 'electron.log'));
    child.stdout.pipe(log); child.stderr.pipe(log);
    child.once('error', error => console.error(error));
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch {}
      if (child.exitCode !== null) throw new Error(`Electron 提前退出 ${child.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const context = browser.contexts()[0];
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      page = context.pages().find(p => (dev ? p.url().startsWith(dev) : p.url().includes('/dist-renderer/index.html')) && !p.url().includes('mode='));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!page) throw new Error('未找到本次主窗口');
    page.setDefaultTimeout(20000);
    await page.waitForFunction(() => typeof window.hemiVoice?.saveModelProfile === 'function');
    record(restart ? '重启加载' : '真实主窗口加载', page.url());
  }
  async function stop() {
    if (!child || stopping) return;
    stopping = true;
    // 仅本 harness 的父子进程 IPC 触发正常 app.quit（Windows 的 Browser.close 会被窗口 close 拦截）。
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
    try { child.send('verify-local-quit'); } catch {}
    const done = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 8000))]);
    if (!done && child.exitCode === null) {
      results.push({ name: '正常退出', ok: false, detail: 'app.quit 超时，仅终止本次子进程' });
      child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    try { await Promise.race([browser?.close(), new Promise(resolve => setTimeout(resolve, 2000))]); } catch {}
    browser = null; page = null; stopping = false;
  }
  async function settings() {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('switch', { name: '悬浮球', exact: true }).waitFor();
  }
  let code = 1;
  try {
    await launch();
    const saved = await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({ name: 'Windows 本地 Mock', baseUrl, apiKey: 'dummy-local-only', models: [{ model: 'mock-1' }] }), `http://127.0.0.1:${mockPort}/v1`);
    if (!saved?.ok) throw new Error('隔离 dummy provider IPC 保存失败');
    record('隔离 dummy provider 经真实 IPC 保存', { mockPort });
    await page.getByRole('button', { name: '开始设置', exact: true }).click();
    await page.getByRole('button', { name: '验证并继续', exact: true }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '开始使用', exact: true }).click();
    const composer = page.locator('textarea.text-composer-input');
    await composer.waitFor();
    record('DOM 首启引导与工具连接测试', '跳过语音；模型验证由本地 mock 响应');
    if (fs.existsSync(file)) throw new Error('发送前目标文件意外存在');
    await composer.fill(`在当前工作区创建 hello-user.txt，内容为唯一标记：${marker}`);
    await page.locator('.text-composer-send').click();
    await page.waitForFunction(m => document.body.innerText.includes(`文件已创建，唯一标记 ${m}`), marker, { timeout: 90000 });
    const content = fs.readFileSync(file, 'utf8');
    if (content !== `唯一标记：${marker}\n`) throw new Error('真实文件内容不匹配');
    const toolResult = requests.some(request => request.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'write-local'));
    if (!toolResult) throw new Error('缺少主 agent 回送的真实工具结果');
    record('DOM 输入发送 → preload/IPC → agent write → 文件与回复核验', { file, content, toolResult });
    await composer.fill('原会话未发送草稿');
    await page.locator('.h24-sidebar-new').click();
    await page.waitForFunction(() => document.querySelector('textarea.text-composer-input')?.value === '');
    record('DOM 新建对话清空输入', true);
    await composer.fill('新对话重启持久化草稿');
    await settings();
    const orb = page.getByRole('switch', { name: '悬浮球', exact: true });
    const old = await orb.getAttribute('aria-checked');
    await orb.click();
    await page.waitForFunction(expected => document.querySelector('[role="switch"][aria-label="悬浮球"]')?.getAttribute('aria-checked') === expected, old === 'true' ? 'false' : 'true');
    const prefs = await page.evaluate(() => window.hemiVoice.getUiPreferences());
    if (prefs.floatingOrbEnabled !== (old !== 'true')) throw new Error('设置真实 IPC 读回不匹配');
    record('DOM 设置开关保存并真实 IPC 读回', { floatingOrbEnabled: prefs.floatingOrbEnabled });
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('textarea.text-composer-input')?.value === '新对话重启持久化草稿');
    await stop();
    await launch(true);
    await page.waitForFunction(() => document.querySelector('textarea.text-composer-input')?.value === '新对话重启持久化草稿');
    record('重启后新对话草稿恢复', true);
    await settings();
    // 设置组件先以默认值渲染，再异步读取 IPC；同时核对宿主事实与最终 DOM，不能读取首帧默认值。
    const restartedPrefs = await page.evaluate(() => window.hemiVoice.getUiPreferences());
    if (restartedPrefs.floatingOrbEnabled !== (old !== 'true')) throw new Error('设置重启后真实 IPC 未持久化');
    await page.waitForFunction(expected => document.querySelector('[role="switch"][aria-label="悬浮球"]')?.getAttribute('aria-checked') === expected, old === 'true' ? 'false' : 'true');
    const persisted = await page.getByRole('switch', { name: '悬浮球', exact: true }).getAttribute('aria-checked');
    if (persisted !== (old === 'true' ? 'false' : 'true')) throw new Error('设置重启未持久化');
    record('重启后设置 DOM 持久化', persisted);
    if (fs.readFileSync(file, 'utf8') !== content) throw new Error('重启后文件不一致');
    record('重启后文件仍在', file);
    code = 0;
  } catch (error) {
    results.push({ name: '流程异常', ok: false, detail: error.stack });
    console.error(error);
    if (page) console.error('当前 DOM：', (await page.locator('body').innerText().catch(() => '')).slice(0, 12000));
  } finally {
    await stop();
    await new Promise(resolve => mock.close(resolve));
    if (results.some(result => !result.ok)) code = 1;
    const report = { mode, platform: process.platform, node: process.version, out, userData: ud, cdpPort, marker, mockBoundary: '仅本地 OpenAI 协议响应，无真实模型联网；write 由真实生产 agent 执行', results, requests };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    console.log(`HEMI_WINDOWS_USER_VERIFY=${JSON.stringify({ out, code, results })}`);
    process.exitCode = code;
  }
}
