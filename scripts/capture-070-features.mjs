// 070 文档截图：真实 Electron / preload / IPC，隔离数据；仅外部模型与 New API 站点为本机演示端点。
// 不使用 fixtures、不改 DOM 内容、不写入 ready 状态或直接修改产品数据文件。
// HEMI_USER_DATA_DIR=<全新目录> npx electron scripts/capture-070-features.mjs
import { app, Menu } from 'electron';
import http from 'node:http';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { getProviderImportService } from '../src/main/ipc/provider-import.ipc.mjs';
import { createMainWindow } from '../src/main/windows/main-window.mjs';
import { installNativeShell } from '../src/main/windows/native-shell.mjs';
import { state } from '../src/main/state.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';
import { getAgentRuntime } from '../src/main/ipc/llm.ipc.mjs';
import { startMockSite, TEST_USER } from './mock-newapi-site.mjs';
import { completeOnboardingUi } from './lib/complete-onboarding-ui.mjs';

if (!process.env.HEMI_USER_DATA_DIR) throw Error('必须指定隔离 HEMI_USER_DATA_DIR');
app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR));
const out = path.resolve('.visual/workflow/vision/070-features');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
const evidence = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), screenshots: [], checks: [], errors: [], requests: [] };
const check = (name, ok) => { evidence.checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); console.log('PASS ' + name); };
const exec = code => state.mainWindow.webContents.executeJavaScript(code);
const wait = async (code, label, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await exec(code)) return; await sleep(120); } throw Error('等待超时：' + label); };
async function click(text, scope = 'document') {
  check('点击 ' + text, await exec(`(()=>{const e=[...(${scope}).querySelectorAll('button')].find(b=>!b.disabled&&[b.textContent,b.title,b.getAttribute('aria-label')].join(' ').includes(${j(text)}));if(!e)return false;e.click();return true})()`));
  await sleep(180);
}
const input = (selector, value) => exec(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('input missing');const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${j(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
async function shot(name, focus = null) {
  await sleep(700);
  const image = await state.mainWindow.webContents.capturePage();
  const bytes = image.toPNG();
  const file = path.join(out, name + '.png');
  await writeFile(file, bytes);
  evidence.screenshots.push({ name, file, size: image.getSize(), sha256: createHash('sha256').update(bytes).digest('hex'), rendererUrl: state.mainWindow.webContents.getURL() });
  if (focus) {
    const rect = typeof focus === 'string' ? await exec(`(()=>{const r=document.querySelector(${j(focus)}).getBoundingClientRect();return {x:Math.max(0,Math.floor(r.left-24)),y:Math.max(0,Math.floor(r.top-24)),width:Math.ceil(r.width+48),height:Math.ceil(r.height+48)}})()`) : focus;
    const focused = await state.mainWindow.webContents.capturePage(rect);
    const focusedBytes = focused.toPNG();
    const focusFile = path.join(out, name + '-focus.png');
    await writeFile(focusFile, focusedBytes);
    evidence.screenshots.push({ name: name + '-focus', file: focusFile, rect, size: focused.getSize(), sha256: createHash('sha256').update(focusedBytes).digest('hex'), rendererUrl: state.mainWindow.webContents.getURL() });
  }
  check(name + ' 无横向溢出', await exec('document.documentElement.scrollWidth<=innerWidth'));
}
async function page(name) { await click(name, 'document.querySelector(".settings-nav")'); await sleep(400); }

let site, server;
let completed = false;
async function finish(error) {
  if (completed) return;
  completed = true;
  if (error) { evidence.error = error.stack; console.error(error.stack); await shot('failure').catch(() => {}); }
  evidence.passed = !error;
  await writeFile(path.join(out, 'capture.json'), JSON.stringify(evidence, null, 2));
  disposeTaskManager();
  getAgentRuntime()?.disposeAll();
  await site?.close();
  server?.closeAllConnections();
  server?.close();
  state.isQuitting = true;
  console.log('HEMI_070_CAPTURE=' + JSON.stringify({ passed: evidence.passed, screenshots: evidence.screenshots.map(s => s.name), error: error?.message }));
  setTimeout(() => app.exit(error ? 1 : 0), 300);
}

app.whenReady().then(async () => {
  await mkdir(out, { recursive: true });
  setTimeout(() => finish(Error('capture timeout')), 240000).unref();
  try {
    site = await startMockSite();
    server = http.createServer(async (req, res) => {
      let raw = ''; for await (const piece of req) raw += piece;
      const body = raw ? JSON.parse(raw) : {};
      if (body.stream !== true) {
        const handshake = body.tools?.some(tool => tool.function?.name === 'hemi_connection_check');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, choices: [{ message: handshake ? { role: 'assistant', tool_calls: [{ id: 'demo-check', type: 'function', function: { name: 'hemi_connection_check', arguments: '{"ok":true}' } }] } : { role: 'assistant', content: 'pong' } }] }));
        return;
      }
      const messages = body.messages ?? [];
      evidence.requests.push({ model: body.model, toolNames: (body.tools ?? []).map(t => t.function?.name), memoryPresent: JSON.stringify(messages).includes('先给结论') });
      const start = messages.findLastIndex(m => m.role === 'user');
      const toolDone = messages.slice(start).some(m => m.role === 'tool');
      const wantsMemory = JSON.stringify(messages.slice(start)).includes('演示偏好');
      const calls = wantsMemory && !toolDone && body.tools?.some(t => t.function?.name === 'memory_write')
        ? ['回答先给结论\n解释之前先给清晰、简短的结论。', '待办使用简短清单\n整理待办时，每项只保留一件明确的事。'].map((text, index) => ({ index, id: 'demo-memory-' + index, type: 'function', function: { name: 'memory_write', arguments: JSON.stringify({ target: 'long_term', content: text }) } })) : [];
      const delta = calls.length ? { role: 'assistant', tool_calls: calls } : { role: 'assistant', content: wantsMemory ? '已将这两项偏好记入此桌面的共享记忆，之后会按这个习惯协作。' : '好的，我会先给结论，并用简短清单整理待办。' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [part, reason] of [[delta, null], [{}, calls.length ? 'tool_calls' : 'stop']]) res.write('data: ' + JSON.stringify({ id: 'demo-070', object: 'chat.completion.chunk', created: 1, model: body.model ?? 'demo-quality', choices: [{ index: 0, delta: part, finish_reason: reason }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const modelUrl = `http://127.0.0.1:${server.address().port}/v1`;
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: false });
    await createMainWindow();
    state.mainWindow.setSize(1440, 1000);
    state.mainWindow.show();
    state.mainWindow.webContents.on('console-message', event => { if (event.level === 'error') evidence.errors.push(event.message); });
    await wait('!!document.querySelector(".onboarding-page")', '首次引导');
    await completeOnboardingUi({ exec, baseUrl: modelUrl, model: 'demo-quality', apiKey: 'hemi-demo-not-a-real-model-key' });
    const saved = await exec(`window.hemiVoice.saveModelProfile(${j({ name: '演示模型服务', baseUrl: modelUrl, apiKey: 'hemi-demo-not-a-real-model-key', makeDefault: true, models: [{ id: 'quality', model: 'demo-quality', supportsVision: true }, { id: 'fast', model: 'demo-fast' }, { id: 'reasoning', model: 'demo-reasoning', supportsVision: true }] })})`);
    check('经设置 IPC 保存演示模型', saved.ok);
    for (const [slot, model] of Object.entries({ main: saved.modelKeys[0], explorer: saved.modelKeys[1], oracle: saved.modelKeys[2], fixer: saved.modelKeys[0], designer: saved.modelKeys[2], fallback: saved.modelKeys[1] })) await exec(`window.hemiVoice.saveRoleModel(${j({ [slot]: model })})`);
    await click('设置'); await wait('!!document.querySelector(".settings-nav")', '设置页'); await page('模型与路由');
    await click('配置…', 'document.querySelector("[data-role-models]")');
    await wait('document.querySelectorAll("[data-route-slot]").length===6', '角色模型配置');
    await shot('feature-routing', '.h56-route-dialog');
    await click('关闭', 'document.querySelector(".h56-route-dialog")??document.querySelector("[role=dialog]")');
    await page('电脑与浏览器');
    for (const pattern of ['计算器|Calculator', '文本编辑|TextEdit']) {
      await click('添加应用');
      await wait('!![...document.querySelectorAll("[role=option]")].find(e=>new RegExp(' + j(pattern) + ').test(e.textContent))', '实际安装应用');
      await exec(`[...document.querySelectorAll('[role=option]')].find(e=>new RegExp(${j(pattern)}).test(e.textContent)).click()`);
      await click('添加', 'document.querySelector(".h37-dialog-foot")');
      await wait('!document.querySelector("[role=dialog]")', '授权已保存');
    }
    await exec('document.querySelector("#settings-access").scrollIntoView({block:"center"})');
    await sleep(4200); await shot('feature-app-permissions', '#settings-access');
    await page('模型与路由'); await click('添加供应商');
    await wait('!!document.querySelector("#h47n-url")', 'New API 入口');
    await input('#h47n-url', site.origin);
    await shot('feature-newapi-start', { x: 468, y: 62, width: 780, height: 460 });
    await click('打开站点并登录');
    await wait('document.querySelector(".h47n")?.dataset.phase==="login"', '站点登录阶段');
    let contents;
    for (let i = 0; i < 100; i++) { contents = getProviderImportService().testBrowserContents(); if (contents && !contents.isDestroyed() && await contents.executeJavaScript('!!document.querySelector("#login-form")').catch(() => false)) break; await sleep(150); }
    check('真实登录 View 就绪', !!contents && !contents.isDestroyed());
    await contents.executeJavaScript(`(()=>{document.querySelector('#username').value=${j(TEST_USER.username)};document.querySelector('#password').value=${j(TEST_USER.password)};document.querySelector('#login-form').requestSubmit();})()`);
    await sleep(800); await click('我已登录，继续');
    await wait('!!document.querySelector("#h47n-group")', '读取分组'); await input('#h47n-group', 'default');
    await wait('!![...document.querySelectorAll(".h37-chip")].find(e=>e.textContent.includes("mock-gpt-5.2"))', '型号候选');
    await click('mock-gpt-5.2', 'document.querySelector(".h47n")');
    await wait('[...document.querySelectorAll("button")].some(e=>e.textContent.includes("创建 Key 并导入")&&!e.disabled)', '导入就绪');
    await click('创建 Key 并导入', 'document.querySelector(".h47n-submit")');
    await wait('document.querySelector(".h47n")?.dataset.phase==="success"', '真实导入成功', 50000);
    check('本机 New API 实际创建 Key 一次', site.state.createCalls === 1);
    await shot('feature-newapi'); await click('完成');
    await click('返回主窗口');
    await wait('!!document.querySelector("textarea[aria-label=输入消息]")', '对话输入');
    await input('textarea[aria-label=输入消息]', '演示偏好：我习惯回答先给结论，再解释；整理待办时使用简短清单。');
    await click('发送');
    await wait('document.body.innerText.includes("记入此桌面的共享记忆")', '主 agent 真实写入记忆', 45000);
    await click('设置'); await wait('!!document.querySelector(".settings-nav")', '设置页'); await page('记忆');
    await wait('document.body.innerText.includes("回答先给结论")&&document.body.innerText.includes("待办使用简短清单")', '原生记忆文件可见');
    await shot('feature-memory', { x: 468, y: 62, width: 780, height: 480 });
    evidence.rendererSha256 = createHash('sha256').update(await readFile('dist-renderer/index.html')).digest('hex');
    evidence.newApiDemo = { origin: site.origin, creates: site.state.createCalls, logins: site.state.loginCalls };
    evidence.platform = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch };
    check('模型真实执行了记忆写入工具', evidence.requests.some(r => r.toolNames.includes('memory_write')));
    await finish();
  } catch (error) { await finish(error); }
});
