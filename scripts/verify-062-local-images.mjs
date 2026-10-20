// 真实产品入口回归；仅外部 provider 使用可控端点。可选隔离历史副本，不改用户数据。
// node scripts/verify-062-local-images.mjs
// HEMI_IMAGE_HISTORY_ID=conv-... VITE_DEV_SERVER_URL=http://127.0.0.1:5178 node scripts/verify-062-local-images.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(fs.existsSync(bundled) ? pathToFileURL(bundled).href : 'playwright');
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const evidenceDir = path.resolve(`.visual/workflow/vision/062-local-images/${mode}`);
const root = fs.mkdtempSync(path.join(os.homedir(), 'hemi-image-verify-'));
const ud = path.join(root, 'userData');
const workspace = path.join(ud, 'workspace/default');
const mark = `LOCAL_IMAGE_${Date.now()}`;
const imagePath = path.join(workspace, '已登记 图.svg');
const loosePath = path.join(workspace, '未登记 100% 图.svg');
const missingPath = path.join(workspace, '不存在.png');
const fileUrl = pathToFileURL(loosePath).href;
const checks = [], errors = [], requests = [], expectedRemoteErrors = [];
let historical = null;
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(ud, 'onboarding.json'), JSON.stringify({ version: 1, phase: 'complete', step: 'done', completedAt: Date.now() }));
if (process.env.HEMI_IMAGE_HISTORY_ID) {
  const sourceUd = process.env.HEMI_IMAGE_HISTORY_UD ?? path.join(os.homedir(), 'Library/Application Support/hemi-dev');
  const id = process.env.HEMI_IMAGE_HISTORY_ID;
  const dir = ['runtime-v2/conversations', 'conversations'].find(dir => fs.existsSync(path.join(sourceUd, dir, `${id}.json`)));
  assert.ok(dir, '历史测试资源必须存在');
  historical = JSON.parse(fs.readFileSync(path.join(sourceUd, dir, `${id}.json`), 'utf8'));
  fs.mkdirSync(path.join(ud, 'conversations'));
  fs.writeFileSync(path.join(ud, 'conversations', `${id}.json`), JSON.stringify(historical));
  fs.copyFileSync(path.join(sourceUd, 'workspaces.json'), path.join(ud, 'workspaces.json'));
}
const check = (name, detail = true) => { checks.push({ name, detail }); console.log(`PASS ${name}`); };
const svg = label => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#dce7da"/><text x="24" y="170" font-size="20">${mark} ${label}</text></svg>`;
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ model: body.model, tools: (body.tools ?? []).map(t => t.function.name) });
    const calls = body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).map(t => t.id);
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'image-test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const tool = (name, args, id) => { send({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) { send({ role: 'assistant', content: '本地图片验证' }); send({}, 'stop'); }
    else if (!calls.includes('image-registered')) tool('write', { path: imagePath, content: svg('registered') }, 'image-registered');
    else if (!calls.includes('image-loose')) tool('write', { path: loosePath, content: svg('unregistered') }, 'image-loose');
    else if (!calls.includes('image-register')) tool('register_delivery', { files: [{ path: imagePath }] }, 'image-register');
    else {
      send({ role: 'assistant', content: [
        '图片已生成，请点击查看。',
        `![已登记图片](<${imagePath}>)`,
        `![未登记图片](<${loosePath}>)`,
        '![相对路径图片](<./未登记 100% 图.svg>)',
        `![文件 URL 图片](<${fileUrl}>)`,
        `![缺失图片](<${missingPath}>)`,
        `[![外层链接](<${loosePath}>)](<${imagePath}>)`,
        `![网络图片](http://127.0.0.1:${imageServer.address().port}/image.svg)`,
      ].join('\n\n') });
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  } catch (error) { console.error(error); res.destroy(error); }
});
const imageServer = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' }); res.end(svg('remote')); });
await Promise.all([new Promise(r => server.listen(0, '127.0.0.1', r)), new Promise(r => imageServer.listen(0, '127.0.0.1', r))]);
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const remoteImageUrl = `http://127.0.0.1:${imageServer.address().port}/image.svg`;
fs.writeFileSync(path.join(ud, 'text-model-profiles.json'), JSON.stringify({ version: 3, defaultModelId: 'audit/main', lastConversationModelKey: 'audit/main', providers: [{ id: 'audit', name: '本地图片验证', api: 'openai-completions', baseUrl, models: [{ id: 'main', model: 'image-test', thinkingLevel: 'off' }] }] }));
let electron, page, rendererUrl, success = false;
const wait = async (fn, label) => { const end = Date.now() + 30000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 80)); } throw new Error(`等待超时：${label}`); };
try {
  const env = { ...process.env, HEMI_USER_DATA_DIR: ud };
  for (const key of ['HEMI_LLM_API_KEY', 'HEMI_LLM_BASE_URL', 'HEMI_LLM_MODEL', 'HEMI_LLM_THINKING_LEVEL']) delete env[key];
  electron = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: ['.'], env });
  await wait(() => { page = electron.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page; }, '主窗口');
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // 现有 CSP 只允许 self/data 图片；单列这张外部测试图片的明确拒绝，不忽略其他错误。
    if (message.text().includes(`Loading the image '${remoteImageUrl}' violates the following Content Security Policy directive:`)) expectedRemoteErrors.push(message.text());
    else errors.push(message.text());
  });
  await page.getByRole('textbox', { name: '输入消息', exact: true }).waitFor();
  // 与设置页相同的公开配置接口；真实 safeStorage／凭据解析，不写 ready 状态。
  await page.evaluate(async baseUrl => {
    await window.hemiVoice.saveModelProfile({ id: 'audit', name: '本地图片验证', api: 'openai-completions', baseUrl, apiKey: 'local-dummy-key', models: [{ id: 'main', model: 'image-test', thinkingLevel: 'default' }] });
    await window.hemiVoice.saveRoleModel({ main: 'audit/main' });
  }, baseUrl);
  await page.reload();
  await page.getByRole('textbox', { name: '输入消息', exact: true }).waitFor();
  rendererUrl = page.url();
  const resize = async width => {
    await electron.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')); win.setMinimumSize(1, 1); win.setContentSize(width, 900); win.show(); }, width);
  };
  const shot = async name => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) }); };
  const imageReady = async () => page.waitForFunction(() => document.querySelector('.h24-preview-image')?.naturalWidth > 0);
  const collapse = () => page.getByRole('button', { name: '收起预览，返回对话', exact: true }).click();
  await resize(1440);
  if (historical) {
    await page.locator('.h24-sidebar-open').filter({ hasText: historical.title }).click();
    const link = page.getByRole('link', { name: '发布后的作品管理页', exact: true });
    await link.click(); await imageReady();
    assert.equal(requests.length, 0);
    await shot('history-image-1440');
    check('问题历史会话图片可点击、实际解码，零模型请求');
    await collapse();
  }
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('LOCAL_IMAGE_GENERATE 创建两张 SVG，只登记其中一张，并以 Markdown 图片语法回复。');
  await page.locator('.text-composer-send:not(.is-stop)').click();
  await page.getByRole('link', { name: '已登记图片', exact: true }).waitFor({ timeout: 45000 });
  await wait(async () => {
    const list = await page.evaluate(() => window.hemiVoice.listConversations());
    return list.sessions.some(s => s.id !== historical?.id);
  }, '新会话落盘');
  const list = await page.evaluate(() => window.hemiVoice.listConversations());
  const cid = list.sessions.find(s => s.id !== historical?.id).id;
  const flow = await page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), cid);
  assert.ok(Object.values(flow.artifacts).some(a => a.path === imagePath));
  assert.ok(!Object.values(flow.artifacts).some(a => a.path === loosePath));
  assert.match(fs.readFileSync(loosePath, 'utf8'), new RegExp(mark));
  assert.equal(await page.locator('a a').count(), 0);
  assert.equal(await page.getByText('本地图片不在本任务登记的文件里，无法解析', { exact: true }).count(), 0);
  check('真实写入和登记；未声明图片不自动登记；无误报或嵌套链接');
  await shot('image-links-1440');
  for (const name of ['已登记图片', '未登记图片', '相对路径图片', '文件 URL 图片', '外层链接']) {
    await page.getByRole('link', { name, exact: true }).click(); await imageReady();
    const shown = await page.locator('.h24-preview-image').getAttribute('src');
    const contents = Buffer.from(shown.split(',')[1], 'base64').toString();
    assert.ok(contents.includes(mark));
    const expected = ['已登记图片', '外层链接'].includes(name) ? 'registered' : 'unregistered';
    assert.ok(contents.includes(`${mark} ${expected}</text>`), `${name} 必须读取对应文件`);
    if (name === '未登记图片') await shot('image-preview-1440');
    await collapse();
  }
  check('已登记／未登记／中文空格与百分号／相对路径／file URL／外层链接实际读取正确图片');
  await page.getByRole('link', { name: '未登记图片', exact: true }).click(); await imageReady();
  assert.equal(await page.getByRole('tab').filter({ hasText: '未登记 100% 图.svg' }).count(), 1);
  fs.renameSync(loosePath, `${loosePath}.moved`);
  await page.getByRole('button', { name: '重新读取当前文件', exact: true }).click();
  await page.getByText('文件不在原位置，可能已被移动或删除', { exact: true }).waitFor();
  fs.renameSync(`${loosePath}.moved`, loosePath);
  await page.getByRole('button', { name: '重试读取', exact: true }).click(); await imageReady();
  check('文件实际移走后重读失败，恢复后重试成功；同文件 Tab 去重');
  for (const width of [375, 768]) {
    await resize(width); await imageReady(); await shot(`image-preview-${width}`);
    assert.ok(await page.getByRole('button', { name: '收起预览，返回对话', exact: true }).isVisible());
    assert.ok(await page.locator('.h24-preview-image').evaluate(img => { const r = img.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; }));
    await collapse();
    await page.getByRole('link', { name: '未登记图片', exact: true }).click(); await imageReady();
  }
  check('375／768 无横向溢出，收起与重新打开可用');
  await collapse(); await resize(1440);
  await page.getByRole('link', { name: '缺失图片', exact: true }).click();
  await page.getByText('文件不存在，可能已被移动或删除', { exact: true }).waitFor();
  assert.equal(await page.locator('.h24-preview-image').count(), 0);
  await page.getByText('网络图片加载失败（可能已下线或需要登录）', { exact: true }).waitFor();
  assert.ok(expectedRemoteErrors.length > 0, '现有 CSP 必须确实拒绝外部测试图片');
  check('缺失路径给出真实原因；网络图片保留现有失败反馈', { remoteImage: '既有 CSP 拒绝，未修改 img-src', expectedCspErrors: expectedRemoteErrors.length });
  // 在点击与读取后再次核对，没有将本地图片链接伪装为正式交付。
  const after = await page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), cid);
  assert.ok(!Object.values(after.artifacts).some(a => a.path === loosePath));
  assert.deepEqual(errors, []);
  check('零未预期 renderer 错误；打开未登记图片不新增交付事实');
  success = true;
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(evidenceDir, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(evidenceDir, 'failure.txt'), `${error.stack}\n${await page.locator('body').innerText()}`);
  }
  throw error;
} finally {
  fs.writeFileSync(path.join(evidenceDir, 'checks.json'), JSON.stringify({ success, mode, rendererUrl, root, checks, requests, errors, expectedRemoteErrors }, null, 2));
  if (electron) {
    // Hemi 的窗口关闭默认隐藏；先退出隔离应用，避免自动化 close 等待隐藏窗口。
    await electron.evaluate(({ app }) => app.quit()).catch(() => {});
    let timer;
    await Promise.race([electron.close().catch(() => {}), new Promise(resolve => {
      timer = setTimeout(() => { electron.process().kill('SIGTERM'); resolve(); }, 5000);
    })]);
    clearTimeout(timer);
  }
  for (const s of [server, imageServer]) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  if (success && process.env.HEMI_KEEP_IMAGE_FIXTURE !== '1') fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ success, mode, rendererUrl, checks: checks.length, evidenceDir }));
