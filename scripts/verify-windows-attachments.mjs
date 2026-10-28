// Windows 附件隔离验收。node scripts/verify-windows-attachments.mjs [--dev]
// 仅连接本脚本新建的后台 Electron CDP；DOM 合成粘贴，不代表物理剪贴板或真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.versions.electron) {
  const { app, BrowserWindow } = await import('electron');
  BrowserWindow.prototype.show = function () {};
  BrowserWindow.prototype.showInactive = function () {};
  BrowserWindow.prototype.focus = function () {};
  process.on('message', message => { if (message === 'attachment-quit') app.quit(); });
  await import('../src/main/index.mjs');
  app.on('browser-window-created', (_event, win) => win.webContents.on('did-finish-load', () => win.hide()));
} else {
  const { default: electronBinary } = await import('electron');
  const { chromium } = await import('playwright-core');
  const mode = process.argv.includes('--dev') ? 'dev' : 'built';
  const recovery = process.argv.includes('--recovery');
  const out = path.join(ROOT, 'tmp', `windows-attachments-${mode}-${Date.now()}`);
  const ud = path.join(out, 'userData');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
  const checks = [], errors = [], requests = [], held = new Map(), exits = [];
  let errorInjected = false;
  const check = name => { checks.push({ name, status: '通过' }); console.log(`PASS ${name}`); };
  const wait = async (predicate, label, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`等待超时：${label}`);
  };
  const mock = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      const marker = JSON.stringify(body.messages?.findLast(m => m.role === 'user')?.content ?? '').match(/ATTACH_[A-Z]+/)?.[0] ?? 'OTHER';
      const main = body.tools?.some(t => t.function?.name === 'task') === true;
      requests.push({ marker, main, body });
      if (main && marker === 'ATTACH_ERROR' && !errorInjected) {
        errorInjected = true;
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'LOCAL_SYNTHETIC_401: test rejection', type: 'authentication_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'attachment-local', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      frame({ role: 'assistant', content: '本地附件模拟响应。' });
      const done = () => { frame({}, 'stop'); res.end('data: [DONE]\n\n'); held.delete(marker); };
      if (main) { held.set(marker, { done, res }); res.on('close', () => { if (held.get(marker)?.res === res) held.delete(marker); }); } else done();
    } catch (error) { res.end(String(error)); }
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const cdpPort = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  let vite, devUrl, child, browser, page, rendererUrl, code = 1;
  const stop = async () => {
    if (!child) return;
    const current = child;
    const exit = current.exitCode !== null ? Promise.resolve(current.exitCode) : new Promise(resolve => current.once('exit', resolve));
    if (current.connected) current.send('attachment-quit', () => {});
    const result = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve('timeout'), 30000))]);
    exits.push(result);
    if (result === 'timeout') { current.kill(); throw new Error('本次 Electron 正常退出超时'); }
    assert.equal(result, 0, 'Electron 退出码');
    await browser?.close().catch(() => {}); child = null; browser = null; page = null;
  };
  const launch = async restart => {
    const env = { ...process.env, HEMI_USER_DATA_DIR: ud };
    for (const key of Object.keys(env)) if (/^HEMI_(LLM_|SELF_RUN|SMOKE_TEST|PLAYWRIGHT)/.test(key)) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    if (devUrl) env.VITE_DEV_SERVER_URL = devUrl; else delete env.VITE_DEV_SERVER_URL;
    child = spawn(electronBinary, [fileURLToPath(import.meta.url), '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const log = fs.createWriteStream(path.join(out, restart ? 'restart.log' : 'electron.log'));
    child.stdout.pipe(log); child.stderr.pipe(log);
    await wait(async () => {
      if (child.exitCode !== null) throw new Error(`Electron 提前退出 ${child.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, 'CDP 启动', 120000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    await wait(() => { page = browser.contexts()[0].pages().find(p => (devUrl ? p.url().startsWith(devUrl) : p.url().includes('/dist-renderer/index.html')) && !p.url().includes('mode=')); return !!page; }, '主窗口');
    rendererUrl = page.url(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.locator('textarea.text-composer-input').waitFor();
  };
  const snapshot = () => page.evaluate(async () => { const { sessions } = await window.hemiVoice.listConversations(); return sessions[0] ? window.hemiVoice.flowGetSnapshot(sessions[0].id) : null; });
  const imageCount = request => { const content = request.body.messages.findLast(m => m.role === 'user')?.content; return Array.isArray(content) ? content.filter(p => p.type === 'image_url').length : 0; };
  const paste = async color => {
    const dataUrl = await page.locator('textarea.text-composer-input').evaluate((ta, color) => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 200);
      ctx.fillStyle = 'white'; ctx.font = '28px sans-serif'; ctx.fillText('HEMI TEST', 50, 110);
      const url = canvas.toDataURL(); const bytes = Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0));
      const data = new DataTransfer(); data.items.add(new File([bytes], 'synthetic.png', { type: 'image/png' }));
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return url;
    }, color);
    fs.writeFileSync(path.join(out, `synthetic-${color.slice(1)}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    await wait(() => page.locator('.h24-attach-tray .h24-attach-thumb').evaluateAll(imgs => imgs.length === 1 && imgs[0].naturalWidth > 0), '草稿缩略图加载');
    return dataUrl;
  };
  const preview = async locator => {
    await locator.click();
    await wait(() => page.locator('img.h24-preview-image').evaluateAll(imgs => imgs.some(img => img.naturalWidth === 320 && img.naturalHeight === 200)), '原图预览加载');
    await page.getByRole('button', { name: '收起预览，返回对话' }).click();
  };
  try {
    if (mode === 'dev') {
      const { createServer } = await import('vite');
      vite = await createServer({ configFile: path.join(ROOT, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
      await vite.listen(); devUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;
    }
    await launch(false); check('隔离主窗口启动');
    const saved = await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({ id: 'attachment-test', name: '本地附件测试', api: 'openai-completions', baseUrl, apiKey: 'DUMMY_LOCAL_ONLY', models: [{ id: 'main', model: 'attachment-local', supportsVision: true, thinkingLevel: 'off' }], makeDefault: true }), baseUrl);
    assert.equal(saved.ok, true); await page.reload();
    const input = page.locator('textarea.text-composer-input'); await input.waitFor();
    if (recovery) {
      await input.fill('ATTACH_ERROR 模拟一次上游认证失败'); await input.press('Enter');
      await wait(() => requests.some(r => r.main && r.marker === 'ATTACH_ERROR'), '合成错误请求');
      await wait(() => page.locator('body').innerText().then(text => text.includes('模型访问未通过验证')), '界面展示认证错误提示');
      check('合成 HTTP 401 转换为可读认证错误提示');
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await wait(() => held.has('ATTACH_ERROR'), '点击重试重新请求原输入');
      held.get('ATTACH_ERROR').done();
      await wait(async () => (await snapshot())?.phase === 'idle', '原输入重试成功');
      check('DOM 点击重试恢复原失败回合并完成');
      await input.fill('ATTACH_RETRY 错误后重新发送'); await input.press('Enter');
      await wait(() => held.has('ATTACH_RETRY'), '错误后新请求'); held.get('ATTACH_RETRY').done();
      await wait(async () => (await snapshot())?.phase === 'idle', '错误后新回合完成');
      check('上游错误后可重新发送并完成，无需重启');
      const rename = async name => {
        await page.locator('.h24-sidebar-open[aria-current="page"]').dblclick();
        const editor = page.getByRole('textbox', { name: '重命名会话', exact: true });
        await editor.fill(name); await editor.press('Enter');
        await wait(async () => await page.locator('.h24-sidebar-open').filter({ hasText: name }).count() === 1, '会话重命名保存');
      };
      await rename('恢复测试A'); check('DOM 双击重命名会话');
      await input.fill('会话A独立未发送草稿');
      await input.press('Control+n');
      await wait(async () => await input.inputValue() === '', 'Ctrl+N 新建清空输入');
      check('Windows Ctrl+N 新建对话快捷键');
      await input.fill('ATTACH_SESSIONB 创建第二个会话'); await input.press('Enter');
      await wait(() => held.has('ATTACH_SESSIONB'), '会话B请求'); held.get('ATTACH_SESSIONB').done();
      await wait(async () => (await snapshot())?.phase === 'idle', '会话B完成');
      await rename('恢复测试B');
      await input.fill('会话B独立未发送草稿');
      await page.locator('.h24-sidebar-open').filter({ hasText: '恢复测试A' }).click();
      await wait(async () => await input.inputValue() === '会话A独立未发送草稿', '切回A草稿');
      assert.ok((await page.locator('body').innerText()).includes('ATTACH_ERROR'));
      check('切回会话A恢复独立草稿与错误历史');
      await page.locator('.h24-sidebar-open').filter({ hasText: '恢复测试B' }).click();
      await wait(async () => await input.inputValue() === '会话B独立未发送草稿', '切回B草稿');
      check('切回会话B恢复独立草稿，不串到A');
      await page.reload(); await input.waitFor();
      await wait(async () => await input.inputValue() === '会话B独立未发送草稿', '重载B草稿');
      assert.equal(await page.locator('.h24-sidebar-open').filter({ hasText: '恢复测试A' }).count(), 1);
      assert.equal(await page.locator('.h24-sidebar-open').filter({ hasText: '恢复测试B' }).count(), 1);
      check('重载后当前会话、重命名及草稿持久化');
    } else {
    await paste('#247567'); check('DOM 合成粘贴图片并加载草稿缩略图');
    await preview(page.locator('.h24-attach-tray .h24-attach-open')); check('草稿原图预览与关闭');
    await page.locator('.h24-attach-remove').click();
    await wait(async () => await page.locator('.h24-attach-tray .h24-attach-card').count() === 0, '移除草稿'); check('DOM 移除附件');
    await paste('#247567'); await input.fill('ATTACH_FIRST 检查第一张图片'); await input.press('Enter');
    const bubble = () => page.locator('.h24-attach-card[data-state="sent"][data-kind="image"] .h24-attach-open');
    await wait(() => held.has('ATTACH_FIRST'), '首张请求');
    await wait(async () => await input.inputValue() === '' && await bubble().count() === 1, '发送清空草稿与历史气泡');
    assert.equal(await page.locator('.h24-attach-tray .h24-attach-card').count(), 0);
    assert.equal(imageCount(requests.find(r => r.main && r.marker === 'ATTACH_FIRST')), 1);
    check('发送受理清理草稿，冻结历史附件与实际 mock 请求各一张');
    await preview(bubble()); check('运行中历史原图预览');
    await input.fill('ATTACH_TEXT 只有文字'); await input.press('Enter');
    await wait(async () => (await snapshot())?.pending.length === 1, '纯文字排队');
    assert.equal((await snapshot()).pending[0].attachmentIds.length, 0);
    held.get('ATTACH_FIRST').done(); await wait(() => held.has('ATTACH_TEXT'), '纯文字派发');
    assert.equal(imageCount(requests.find(r => r.main && r.marker === 'ATTACH_TEXT')), 0); check('忙时文字队列与请求不继承旧附件');
    await paste('#ad5e29'); await input.fill('ATTACH_SECOND 第二张图片'); await input.press('Enter');
    await wait(async () => (await snapshot())?.pending.length === 1, '新图排队');
    assert.equal((await snapshot()).pending[0].attachmentIds.length, 1);
    assert.equal(await page.locator('.h24-attach-tray .h24-attach-card').count(), 0);
    held.get('ATTACH_TEXT').done(); await wait(() => held.has('ATTACH_SECOND'), '新图派发');
    assert.equal(imageCount(requests.find(r => r.main && r.marker === 'ATTACH_SECOND')), 1);
    held.get('ATTACH_SECOND').done(); await wait(async () => (await snapshot())?.phase === 'idle', '全部完成');
    check('运行中粘贴新图入队冻结，清理草稿且只派发一张新图');
    assert.equal(await bubble().count(), 2);
    await stop(); await launch(true); check('进程正常退出并以同一隔离数据重启');
    await wait(async () => await bubble().count() === 2, '重启恢复两张历史图');
    await wait(() => bubble().locator('img').evaluateAll(imgs => imgs.length === 2 && imgs.every(img => img.naturalWidth > 0)), '重启缩略图加载');
    assert.equal(await page.locator('.h24-attach-tray .h24-attach-card').count(), 0);
    await preview(bubble().first()); await preview(bubble().last()); check('重启历史两张缩略图及原图预览恢复，无旧草稿');
    const resumedInput = page.locator('textarea.text-composer-input');
    await resumedInput.fill('ATTACH_STOP 停止此在途回应'); await resumedInput.press('Enter');
    await wait(() => held.has('ATTACH_STOP'), '停止前请求抵达 mock');
    await page.getByRole('button', { name: '停止当前任务', exact: true }).click();
    await wait(() => !held.has('ATTACH_STOP'), '停止中断 mock 连接');
    await wait(async () => (await snapshot())?.phase === 'idle', '停止后恢复空闲');
    check('DOM 停止在途回应并中断本地 SSE 连接');
    await resumedInput.fill('ATTACH_RECOVER 停止后继续发送'); await resumedInput.press('Enter');
    await wait(() => held.has('ATTACH_RECOVER'), '停止后新请求抵达 mock');
    held.get('ATTACH_RECOVER').done();
    await wait(async () => (await snapshot())?.phase === 'idle', '停止后新回合完成');
    check('停止在途回合后继续发送并完成');
    }
    assert.deepEqual(errors, []); check('renderer 无 console error 或未捕获异常');
    code = 0;
  } catch (error) {
    checks.push({ name: '流程异常，之后项目未测', status: '失败', error: error.stack }); console.error(error);
    if (page) {
      fs.writeFileSync(path.join(out, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => ''));
      fs.writeFileSync(path.join(out, 'failure-state.json'), JSON.stringify(await page.evaluate(async () => ({ workspace: await window.hemiVoice.getWorkspaceState(), conversations: await window.hemiVoice.listConversations() })).catch(error => ({ error: String(error) })), null, 2));
    }
  } finally {
    for (const { res } of held.values()) res.destroy();
    try { await stop(); } catch (error) { code = 1; errors.push(error.stack); }
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    await vite?.close();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ mode, code, commit: '80ded7cc3013c994996d4d05a940d55c68ffcaa3', platform: process.platform, node: process.version, rendererUrl, out, userData: ud, cdpPort, devUrl, checks, errors, exits, requests, boundary: '后台隔离 Electron + DOM 合成粘贴 + 本地 mock；非物理桌面/系统剪贴板/真实模型；未获取截图' }, null, 2));
    console.log(`HEMI_WINDOWS_ATTACHMENTS=${JSON.stringify({ mode, code, out, passed: checks.filter(c => c.status === '通过').length, errors, exits })}`);
    process.exitCode = code;
  }
}
