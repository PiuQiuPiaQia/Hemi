/**
 * 首启真实窗口验收：生产 IPC/模型目录/导入服务/主 agent，只有外部模型站点受控。
 * HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=<全新目录> npx electron scripts/verify-onboarding.mjs manual|newapi|partial
 * 同一目录再次运行 resume 验证冷启动续接，完成后运行 return 验证不重弹。
 * VITE_DEV_SERVER_URL=http://127.0.0.1:5173 可验证开发入口；缺省验证构建产物。
 * 不预写 onboarding/模型/权限就绪状态，不替换内部服务工厂。
 */
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startMockSite, TEST_USER } from './mock-newapi-site.mjs';

if (!process.env.HEMI_USER_DATA_DIR || process.env.HEMI_SMOKE_TEST !== '1') throw new Error('请指定隔离 userData 并启用 HEMI_SMOKE_TEST=1');
const mode = process.argv[2] ?? 'manual';
const entry = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'build';
const out = path.resolve('.visual/workflow/vision/onboarding-2026-10-21');
const marker = `onboarding-${entry}-${mode}`;
const checks = [];
const errors = [];
const requests = [];
let failTools = true;
let site;
let win;
let writeRequested = false;
let verificationCalls = 0;
let finished = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) throw new Error(name);
}
const exec = code => win.webContents.executeJavaScript(code);
async function wait(code, label, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await exec(code)) return; await sleep(120); }
  throw new Error(`等待超时：${label}；${await exec('document.body.innerText.slice(-1200)')}`);
}
async function click(text, scope = 'document') {
  check(`点击 ${text}`, await exec(`(() => {
    const node = [...(${scope}).querySelectorAll('button')].find(item => (item.textContent + ' ' + (item.getAttribute('aria-label') || '')).includes(${JSON.stringify(text)}) && !item.disabled);
    if (!node) return false;
    node.scrollIntoView({ block: 'center' }); node.click(); return true;
  })()`));
  await sleep(80);
}
async function fill(selector, value) {
  check(`填写 ${selector}`, await exec(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`));
  await sleep(80);
}
const step = value => wait(`document.querySelector('.onboarding-page')?.dataset.step === ${JSON.stringify(value)}`, value);
async function shot(name, width = 1440, height = 1000) {
  win.setMinimumSize(320, 400);
  win.setContentSize(width, height);
  await sleep(650);
  const metrics = await exec(`({ innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, errors: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent) })`);
  check(`${name} 无横向溢出`, metrics.scrollWidth <= metrics.innerWidth && metrics.bodyWidth <= metrics.innerWidth, metrics);
  await fs.writeFile(path.join(out, `${entry}-${mode}-${name}-${width}.png`), (await win.webContents.capturePage()).toPNG());
}
function inference({ body, res, api }) {
  requests.push({ api, stream: body.stream === true, model: body.model, tools: body.tools?.map(tool => tool.function?.name ?? tool.name) ?? [] });
  const verify = body.tools?.some(tool => (tool.function?.name ?? tool.name) === 'hemi_connection_check');
  const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (verify) {
    verificationCalls += 1;
    if (failTools) return json(api === 'anthropic-messages' ? { content: [{ type: 'text', text: 'plain response' }] } : { choices: [{ message: { content: 'plain response' } }] });
    return json(api === 'anthropic-messages'
      ? { content: [{ type: 'tool_use', name: 'hemi_connection_check', input: { ok: true } }] }
      : { choices: [{ message: { tool_calls: [{ function: { name: 'hemi_connection_check', arguments: '{"ok":true}' } }] } }] });
  }
  if (!body.stream) return json({ model: body.model, choices: [{ message: { role: 'assistant', content: 'pong' } }] });
  // 真实 Pi 会话按声明工具完成一次文件交付，后续请求收口。
  const tool = body.tools?.find(tool => tool.function?.name === 'write');
  const toolResult = body.messages?.some(message => message.role === 'tool');
  const parts = [];
  const content = `已创建 onboarding-check.txt，内容为 ${marker}。`;
  if (tool && !toolResult && !writeRequested) {
    writeRequested = true;
    parts.push({ choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_onboarding_write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'onboarding-check.txt', content: marker }) } }] }, finish_reason: null }] });
    parts.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    parts.push({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
    parts.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const part of parts) res.write(`data: ${JSON.stringify({ id: 'onboarding-test', object: 'chat.completion.chunk', model: body.model, ...part })}\n\n`);
  res.end('data: [DONE]\n\n');
}

app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR));
async function finish(code, error) {
  if (finished) return;
  finished = true;
  if (error) errors.push(String(error.stack ?? error));
  if (errors.length) code = 1;
  const result = { entry, mode, rendererUrl: win?.webContents.getURL(), checks, errors, requests, passed: code === 0 };
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, `${entry}-${mode}-result.json`), JSON.stringify(result, null, 2));
  console.log(`HEMI_ONBOARDING_RESULT ${JSON.stringify({ entry, mode, passed: result.passed, checks: checks.length, errors })}`);
  site?.server.closeAllConnections();
  site?.server.close();
  app.exit(code);
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(out, { recursive: true });
    site = await startMockSite({ inferenceHandler: inference });
    // 仅种外部假站的 API 凭据，Hemi 模型配置始终由 UI 创建。
    site.state.tokens.push({ id: 1, key: 'onboarding-manual', revoked: false });
    const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
    const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
    const { ensureOnboardingInitialized } = await import('../src/main/ipc/onboarding.ipc.mjs');
    const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
    const { state } = await import('../src/main/state.mjs');
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    await ensureOnboardingInitialized();
    await createMainWindow();
    win = state.mainWindow;
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') {
        errors.push(event.message);
        console.error('RENDERER_ERROR', event.message, event.sourceId, event.lineNumber, new Date().toISOString());
      }
    });
    win.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
    win.show();
    if (mode === 'return') {
      await wait(`Boolean(document.querySelector('.text-composer'))`, '完成后重启进入主界面');
      check('重启不再弹引导', await exec(`!document.querySelector('.onboarding-page')`));
      return finish(0);
    }
    if (mode === 'resume') {
      await step('capabilities');
      check('冷启动恢复未完成的可选能力页', true);
      await click('继续', `document.querySelector('.onboarding-actions')`);
      await step('done');
      await click('开始使用');
      await wait(`Boolean(document.querySelector('.text-composer'))`, '恢复后完成引导');
      return finish(0);
    }
    await step('welcome');
    await shot('welcome');
    await click('开始设置');
    await step('model');
    await wait(`Boolean(document.querySelector('#h47n-url'))`, 'New API 接入入口');
    check('先连接模型，无麦克风/ASR 门槛', await exec(`!document.querySelector('#onboarding-asr-key')`));
    await shot('model-entry');
    await shot('model-entry', 375, 900);
    win.setContentSize(1440, 1000);
    if (mode === 'manual' || mode === 'partial') {
      await click('手动配置');
      await click('自定义', `document.querySelector('[aria-label="选择供应商"]')`);
      await fill('#h37m-add-name', 'Onboarding test');
      await fill('#h37m-add-key', 'sk-onboarding-manual');
      await fill('#h37m-add-url', `${site.origin}/v1`);
      await click('从服务拉取');
      await wait(`Boolean([...document.querySelectorAll('.h37-chip')].find(item => item.textContent.includes('mock-gpt-5.2')))`, '模型列表');
      await click('mock-gpt-5.2');
      await shot('manual-model');
      await click('添加 1 个模型');
    } else {
      const { getProviderImportService } = await import('../src/main/ipc/provider-import.ipc.mjs');
      await fill('#h47n-url', site.origin);
      await click('打开站点并登录');
      await wait(`Boolean(document.querySelector('.h47n-browser'))`, 'New API 登录页');
      let contents;
      for (let i = 0; i < 60; i += 1) {
        contents = getProviderImportService().testBrowserContents();
        if (contents && await contents.executeJavaScript(`Boolean(document.getElementById('login-form'))`).catch(() => false)) break;
        await sleep(100);
      }
      check('站点 View 在窗口可见', getProviderImportService().testBrowserVisible());
      await shot('newapi-login');
      await shot('newapi-login', 375, 900);
      check('窄窗口隐藏原生站点 View，避免遮住引导按钮', !getProviderImportService().testBrowserVisible());
      win.setContentSize(1440, 1000);
      await sleep(450);
      check('恢复宽窗口后站点 View 重新可见', getProviderImportService().testBrowserVisible());
      await contents.executeJavaScript(`document.getElementById('username').value=${JSON.stringify(TEST_USER.username)}; document.getElementById('password').value=${JSON.stringify(TEST_USER.password)}; document.getElementById('login-form').requestSubmit();`);
      await sleep(500);
      await click('我已登录，继续');
      await wait(`Boolean(document.querySelector('#h47n-group'))`, '选择分组');
      await fill('#h47n-group', 'default');
      await wait(`Boolean([...document.querySelectorAll('.h37-chip')].find(item => item.textContent.includes('mock-gpt-5.2')))`, '型号');
      await click('mock-gpt-5.2');
      await wait(`Boolean([...document.querySelectorAll('button')].find(item => item.textContent.includes('创建 Key 并导入') && !item.disabled))`, '创建按钮');
      await click('创建 Key 并导入', `document.querySelector('.h47n-submit')`);
      await wait(`document.querySelector('.h47n')?.dataset.phase === 'success'`, '导入成功', 45000);
      check('只创建一个站点令牌', site.state.createCalls === 1);
      await click('完成');
    }
    await wait(`Boolean(document.querySelector('#onboarding-default-model'))`, '默认模型选择');
    await click('验证并继续');
    await wait(`Boolean([...document.querySelectorAll('[role="alert"]')].find(item => item.textContent.includes('有效的工具调用')))`, '不支持工具的模型被阻止');
    check('工具测试失败仍留在模型页', await exec(`document.querySelector('.onboarding-page')?.dataset.step === 'model'`));
    check('失败后默认模型仍保留', await exec(`document.querySelector('#onboarding-default-model').selectedOptions[0].textContent === 'mock-gpt-5.2'`));
    failTools = false;
    await click('验证并继续');
    await step('capabilities');
    check('失败重试确实调用了模型两次', verificationCalls === 2);
    await shot('capabilities');
    await shot('capabilities', 375, 900);
    for (const title of ['桌面操控', '浏览器控制']) {
      await exec(`(() => { const node = [...document.querySelectorAll('details')].find(item => item.querySelector('summary').textContent.includes(${JSON.stringify(title)})); node.open = true; node.scrollIntoView(); })()`);
      await shot(title === '桌面操控' ? 'desktop' : 'browser', 375, 900);
      await exec(`document.querySelectorAll('details').forEach(item => item.open = false)`);
    }
    await click('配置路由');
    await wait(`Boolean(document.querySelector('.h56-route-dialog'))`, '路由弹窗');
    // 当前工作区另有开发性能面板改动；通过它提供的键盘操作移开遮挡，不改 DOM/样式。
    if (entry === 'dev') {
      for (let index = 0; index < 30; index += 1) {
        await exec(`document.querySelector('[aria-label="移动性能监控"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }))`);
        await sleep(20);
      }
    }
    await shot('routing', 375, 900);
    check('窄窗口路由完成按钮可见且未被遮挡', await exec(`(() => {
      const button = [...document.querySelectorAll('.h56-route-dialog button')].find(item => item.textContent.trim() === '完成');
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return rect.top >= 0 && rect.bottom <= innerHeight && Boolean(hit && button.contains(hit));
    })()`));
    await click('完成', `document.querySelector('.h56-route-dialog')`);
    await shot('capabilities', 768, 1000);
    win.setContentSize(1440, 1000);
    await click('配置语音');
    await step('microphone');
    await shot('microphone');
    await click('暂时跳过');
    await step('capabilities');
    // 刷新 renderer 重建组件，状态从主进程回读，不能依靠组件内存继续。
    win.webContents.reload();
    await step('capabilities');
    check('重载后仍停在可选能力页', true);
    if (mode === 'partial') return finish(0);
    await click('继续', `document.querySelector('.onboarding-actions')`);
    await step('done');
    check('完成页如实说明语音尚未就绪', await exec(`document.body.textContent.includes('语音尚未就绪')`));
    await shot('done');
    await click('开始使用');
    await wait(`Boolean(document.querySelector('.text-composer'))`, '主界面');
    const dataRoot = app.getPath('userData');
    const onboarding = JSON.parse(await fs.readFile(path.join(dataRoot, 'onboarding.json'), 'utf8'));
    check('纯文字首启完成状态持久化', onboarding.phase === 'complete' && onboarding.version === 2);
    const asr = await fs.readFile(path.join(dataRoot, 'doubao-asr.json'), 'utf8').then(JSON.parse).catch(() => null);
    check('从未填写或保存语音密钥', !asr?.encryptedApiKey);
    const textarea = 'textarea';
    await fill(textarea, `请用 write 文件工具在当前工作区创建 onboarding-check.txt，内容必须为 ${marker}。不要运行命令。`);
    await exec(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));`);
    const artifact = path.join(dataRoot, 'workspace/default/onboarding-check.txt');
    const until = Date.now() + 45000;
    let actual = '';
    while (Date.now() < until) { actual = await fs.readFile(artifact, 'utf8').catch(() => ''); if (actual === marker) break; await sleep(200); }
    check('进入主界面后的真实主 agent 完成文件任务', actual === marker, { artifact });
    check('实际调用了写文件工具', writeRequested);
    await wait(`Boolean([...document.querySelectorAll('.assistant-copy')].some(item => item.textContent.includes(${JSON.stringify(marker)}))) && !document.querySelector('[aria-label="停止当前任务"]')`, '助手实际回答并结束任务');
    check('助手结果已显示且任务已经收口', true);
    await shot('first-task');
    check('无 renderer 控制台错误', errors.length === 0, errors);
    await finish(0);
  } catch (error) { console.error(error); await finish(1, error); }
});
setTimeout(() => void finish(1, new Error('验收总超时')), 180000).unref();
