// Focused Electron -> production IPC/Pi SDK -> real read/bash -> renderer check.
// Only the external provider is controlled; all data lives in a fresh temporary profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';

const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const evidence = path.resolve(`.visual/workflow/vision/turn-stage-flow/${mode}`);
const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hemi-stage-flow-${mode}-`)));
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
fs.writeFileSync(path.join(userData, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
const workspace = path.join(userData, 'workspace/default');
fs.mkdirSync(workspace, { recursive: true });
const source = path.join(workspace, 'stage-source.md');
fs.writeFileSync(source, 'STAGE_SOURCE_ACTUAL_CONTENT\n阶段验证资料。');
const requests = [], releases = new Map(), thinkingUpdates = new Map();
const report = { mode, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: true,
  node: process.version, platform: `${process.platform}/${process.arch}`, checks: [], errors: [], screenshots: [] };
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const wait = async (predicate, label, timeout = 25000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out: ${label}`);
};
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: `stage-${requests.length}`,
      object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const done = () => { chunk({}, 'stop'); res.end('data: [DONE]\n\n'); };
    const tool = (name, args) => {
      chunk({ tool_calls: [{ index: 0, id: `call-stage-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n');
    };
    const hold = key => new Promise(resolve => { releases.set(key, resolve); res.on('close', resolve); });
    chunk({ role: 'assistant' });
    if (!body.tools?.length) { chunk({ content: '阶段对话流验证' }); done(); return; }
    if (JSON.stringify(body.messages).includes('STAGE_STOP')) {
      chunk({ content: '我先检查资料，再继续处理。' });
      chunk({ reasoning_content: 'STOP_PRIVATE_THINKING：核对资料与执行边界。' });
      await hold('stop'); if (!res.destroyed) done(); return;
    }
    const lastUser = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '');
    if (lastUser.includes('SDK_CORE_')) {
      chunk({content: 'SDK_CORE_REPLY：' + (lastUser.match(/SDK_CORE_(QUEUE|ONE|TWO)/)?.[0] ?? '已处理')});
      if (lastUser.includes('SDK_CORE_QUEUE')) await hold('core-queue');
      if (!res.destroyed) done(); return;
    }
    const count = body.messages.filter(message => message.role === 'tool').length;
    if (count === 0) {
      chunk({ content: '我会先读取资料，再运行检查命令。' });
      tool('read', { path: source });
    } else if (count === 1) {
      chunk({ reasoning_content: 'PRIVATE_THINKING：文件已读取，需要运行检查命令。' });
      thinkingUpdates.set('inspect', text => chunk({ reasoning_content: text }));
      await hold('inspect');
      thinkingUpdates.delete('inspect');
      if (!res.destroyed) tool('bash', { command: 'printf STAGE_COMMAND_ACTUAL_RESULT' });
    } else if (count === 2) {
      chunk({ reasoning_content: 'PRIVATE_THINKING_2：检查命令已结束，核对缺失文件。' });
      chunk({ content: '已读到资料，检查命令也已结束。接下来核对缺失文件。' });
      tool('read', { path: path.join(workspace, 'missing.md') });
    } else {
      chunk({ content: '资料和命令检查已完成；缺失文件读取失败，需要补充该文件。' });
      done();
    }
  } catch (error) { report.errors.push(String(error)); res.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify({ version: 3,
  defaultModelId: 'stage/main', lastConversationModelKey: 'stage/main',
  providers: [{ id: 'stage', name: '阶段验证', api: 'openai-completions', baseUrl,
    models: [{ id: 'main', model: 'stage-test', thinkingLevel: 'default', supportsVision: false }] }],
}));
let app, page;
const shot = async name => {
  const file = `${name}.png`; await page.screenshot({ path: path.join(evidence, file), scale: 'css' });
  report.screenshots.push(file);
};
const resize = async width => {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));
    win.setMinimumSize(1, 1); win.setContentSize(width, 900); win.show();
  }, width);
  await page.waitForFunction(width => innerWidth === width, width);
  await page.mouse.move(width - 20, 860);
  await page.locator('textarea.text-composer-input').focus();
  if (width <= 880) await page.locator('.h24-sidebar').waitFor({ state: 'hidden' });
};
const groups = () => page.locator('.turn-activity');
const flow = id => page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), id);
try {
  app = await _electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env,
    HEMI_USER_DATA_DIR: userData, HEMI_TEST_MIC_GRANT: '1', HEMI_LLM_API_KEY: 'TEST_ONLY',
    HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'stage-test' } });
  await wait(() => { page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page; }, 'main window');
  report.rendererUrl = page.url(); page.setDefaultTimeout(Number(process.env.HEMI_UI_TIMEOUT_MS ?? 15000));
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.locator('textarea.text-composer-input').waitFor();
  await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({ id: 'stage', name: '阶段验证', api: 'openai-completions', baseUrl,
    apiKey: 'TEST_ONLY', models: [{ id: 'main', model: 'stage-test', thinkingLevel: 'default', supportsVision: false }], makeDefault: true }), baseUrl);
  await page.reload({waitUntil:'domcontentloaded'}); await page.locator('textarea.text-composer-input').waitFor();
  await resize(1440);
  await page.locator('textarea.text-composer-input').fill('STAGE_FLOW：请读取资料并运行检查。');
  await page.locator('.text-composer-send:not(.is-stop)').click();
  await wait(() => releases.has('inspect'), 'streamed thinking');
  await page.locator('.turn-activity[data-running="true"]').waitFor();
  assert.equal(await groups().count(), 1);
  assert.equal(await page.locator('.h48-thinking-latest').count(), 0, 'inner thinking stays unmounted while process is closed');
  assert.equal(await page.locator('.turn-activity-list').count(), 0);
  assert.match(await page.locator('.chat-copy.assistant-copy').innerText(), /先读取资料/);
  check('中途 text 原样可见，工具/思考默认收成同一个过程组');
  const preview = groups().first().locator('.turn-activity-preview');
  await preview.waitFor();
  assert.match(await preview.innerText(), /PRIVATE_THINKING/);
  const timer = groups().first().locator('.turn-activity-timer');
  const initialTime = await timer.innerText();
  await wait(async () => await timer.innerText() !== initialTime, 'elapsed time without new chunks');
  const latestThought = '正在核对第一份资料的来源、关联文件与检查命令，确认依赖后继续执行。';
  thinkingUpdates.get('inspect')(`\n\n${latestThought}`);
  await wait(async () => await preview.innerText() === latestThought, 'live preview update');
  for (const width of [1440, 768, 375]) {
    await resize(width);
    const fits = await groups().first().locator('.turn-activity-head').evaluate(node => {
      const preview = node.querySelector('.turn-activity-preview');
      return node.scrollWidth <= node.clientWidth && preview.getBoundingClientRect().width > 0
        && preview.scrollHeight === preview.clientHeight;
    });
    assert.ok(fits, `${width}: single line preview and controls fit`);
    await shot(`thinking-preview-${width}`);
  }
  await resize(1440);
  await groups().first().screenshot({ path: path.join(evidence, 'thinking-preview.png'), scale: 'css' });
  report.screenshots.push('thinking-preview.png');
  check('收起时最新思考随分片更新、无新分片时耗时继续走，三档宽度固定一行');
  const head = groups().first().locator('.turn-activity-head');
  await head.focus(); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await wait(async () => await head.getAttribute('aria-expanded') === 'true', 'keyboard disclosure');
  assert.equal(await groups().first().locator('.turn-activity-label').innerText(), '执行过程');
  assert.equal(await groups().first().locator('.turn-activity-preview').count(), 0);
  assert.equal(await groups().first().locator('.turn-activity-timer').count(), 0);
  assert.equal(await groups().first().locator('.h48-thinking-head').count(), 1);
  assert.deepEqual(await groups().first().locator('[data-activity-kind]').evaluateAll(nodes => nodes.map(n => n.dataset.activityKind)), ['tool', 'thinking']);
  await groups().first().locator('.h48-thinking-head').click();
  assert.match(await groups().first().locator('.h48-thinking-body').innerText(), /PRIVATE_THINKING/);
  await shot('streaming-expanded');
  releases.get('inspect')(); releases.delete('inspect');
  await page.locator('.chat-copy.assistant-copy').filter({ hasText: '缺失文件读取失败' }).waitFor();
  await page.locator('.text-composer-send.is-stop').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.turn-activity-preview, .turn-activity-timer').count(), 0, 'completed thinking removes live indicator');
  assert.equal(await groups().count(), 2);
  assert.equal(await head.getAttribute('aria-expanded'), 'true', 'append and text boundary retain expansion');
  assert.equal(await groups().first().locator('.h48-thinking-head').first().getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await groups().first().locator('[data-activity-kind]').evaluateAll(nodes => nodes.map(n => n.dataset.activityKind)), ['tool', 'thinking', 'tool', 'thinking']);
  assert.match(await groups().last().locator('.turn-activity-head').innerText(), /1 项失败/);
  const order = await page.locator('.h24-hemi-message').last().evaluate(node => [...node.children].map(child => child.classList.contains('turn-activity') ? 'activity' : child.classList.contains('chat-copy') ? 'text' : 'other'));
  assert.deepEqual(order, ['text', 'activity', 'text', 'activity', 'text']);
  check('真实 read/bash 结果回流，多轮思考归为一组，text 划分阶段且失败在收起态可见');
  const conversationId = await page.evaluate(async () => (await window.hemiVoice.listConversations()).sessions[0].id);
  const snapshot = await flow(conversationId);
  const toolResults = requests.flatMap(request => request.messages.filter(message => message.role === 'tool'));
  assert.match(JSON.stringify(toolResults), /STAGE_SOURCE_ACTUAL_CONTENT/);
  assert.match(JSON.stringify(toolResults), /STAGE_COMMAND_ACTUAL_RESULT/);
  assert.ok(snapshot.timeline.some(item => item.parts?.some(part => part.kind === 'thinking')));
  assert.ok(snapshot.timeline.some(item => item.parts?.some(part => part.kind === 'tool' && part.status === 'error')));
  check('生产 flow 保留原始思考/工具事实，外部模型替身收到真实文件与命令结果');
  await head.click();
  await page.locator('.h24-hemi-message').last().screenshot({ path: path.join(evidence, 'stage-flow.png'), scale: 'css' });
  report.screenshots.push('stage-flow.png');
  for (const width of [1440, 768, 375]) {
    await resize(width);
    await page.waitForTimeout(200);
    assert.ok(await groups().evaluateAll(nodes => nodes.every(node => {
      const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth;
    })), `${width}: activity overflow`);
    await shot(`collapsed-${width}`);
    await groups().first().locator('.turn-activity-head').click();
    await groups().last().locator('.turn-activity-head').click();
    assert.ok(await page.locator('.turn-activity-step').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)));
    await shot(`expanded-${width}`);
    await groups().first().locator('.turn-activity-head').click();
    await groups().last().locator('.turn-activity-head').click();
  }
  check('1440/768/375 收起与展开布局无横向溢出');
  await resize(1440);
  // The current appearance schema supports light only. Check dark OS preference without inventing a dark theme.
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.locator('html').getAttribute('data-color-mode'), 'light');
  await page.waitForTimeout(200); await shot('collapsed-1440-dark-preference');
  await groups().first().locator('.turn-activity-head').click();
  await shot('expanded-1440-dark-preference');
  const beforeReload = requests.length;
  await page.reload({waitUntil:'domcontentloaded'}); await page.locator('.turn-activity').first().waitFor();
  assert.equal(await groups().count(), 2);
  assert.equal(await groups().first().locator('.turn-activity-head').getAttribute('aria-expanded'), 'false');
  assert.deepEqual((await flow(conversationId)).timeline, snapshot.timeline);
  assert.equal(requests.length, beforeReload);
  check('重载由原始时间线恢复相同阶段，不重跑模型或工具');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.locator('textarea.text-composer-input').fill('STAGE_STOP：检查资料。');
  await page.locator('.text-composer-send:not(.is-stop)').click();
  await wait(() => releases.has('stop'), 'stoppable thinking');
  await page.locator('.turn-activity[data-running="true"]').waitFor();
  await page.locator('.turn-activity-preview').waitFor();
  const stop = page.locator('.text-composer-send.is-stop');
  await stop.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  await page.locator('.h24-reply-stopped').waitFor();
  assert.equal(await page.locator('.turn-activity[data-running="true"]').count(), 0);
  assert.equal(await page.locator('.turn-activity-preview, .turn-activity-timer').count(), 0);
  assert.equal(await page.locator('.turn-activity-list').count(), 0);
  check('停止思考后过程退出运行态，未完成回复明确标为已停止');
  const stopConversation = await page.evaluate(async () => (await window.hemiVoice.listConversations()).sessions[0].id);
  await page.evaluate(id => window.hemiVoice.renameConversation(id, 'SDK 草稿恢复验证'), stopConversation);
  const composer = page.locator('textarea.text-composer-input');
  await composer.fill('SDK_CORE_DRAFT：切换与重载必须保留');
  await wait(async () => (await page.evaluate(id => window.hemiVoice.getDraft(id), stopConversation))?.text === 'SDK_CORE_DRAFT：切换与重载必须保留', 'SDK draft persisted through real IPC');
  await page.getByRole('button', {name: '新建对话', exact: true}).click();
  await wait(async () => await composer.inputValue() === '', 'new conversation clears its slot');
  await page.locator('.h24-sidebar-open').filter({hasText:'SDK 草稿恢复验证'}).click();
  await wait(async () => await composer.inputValue() === 'SDK_CORE_DRAFT：切换与重载必须保留', 'SDK draft restores on navigation');
  await page.reload({waitUntil:'domcontentloaded'}); await composer.waitFor();
  await wait(async () => await composer.inputValue() === 'SDK_CORE_DRAFT：切换与重载必须保留', 'SDK draft restores after reload');
  check('SDK 草稿通过真实 IPC 自动保存，切换会话与 renderer 重载后恢复');
  await page.getByRole('button', {name: '新建对话', exact: true}).click();
  await composer.fill('SDK_CORE_QUEUE：等待我放行。');
  await page.locator('.text-composer-send:not(.is-stop)').click();
  await wait(() => releases.has('core-queue'), 'held main run');
  for (const text of ['SDK_CORE_ONE：队列一', 'SDK_CORE_TWO：队列二']) {
    await composer.fill(text);
    await composer.press('Enter');
    await wait(async () => await composer.inputValue() === '', 'queued input accepted');
  }
  await page.getByText('待发送消息（2）', {exact:true}).waitFor();
  assert.equal(await page.locator('.h24-user-bubble').filter({hasText:'SDK_CORE_ONE'}).count(),0);
  await shot('sdk-core-queue');
  releases.get('core-queue')(); releases.delete('core-queue');
  await wait(async () => await page.locator('.h24-user-bubble').filter({hasText:'SDK_CORE_TWO'}).count()===1 && await page.locator('.text-composer-send.is-stop').count()===0, 'queued runs complete');
  const inputs = await page.locator('.h24-user-bubble').allTextContents();
  assert.deepEqual(inputs.map(text => text.match(/SDK_CORE_(QUEUE|ONE|TWO)/)?.[1]).filter(Boolean), ['QUEUE','ONE','TWO']);
  assert.equal(await page.locator('.h24-queue-tray').count(),0);
  check('SDK 队列组件通过生产控制器受理两条输入，依次转正且没有重复消息');
  const saved = await page.evaluate(async () => {
    const turns = Array.from({ length: 150 }, (_, index) => ({ id: `stage-history-${index}`,
      author: index % 2 ? 'hemi' : 'user', createdAt: Date.now() - (150 - index) * 1000,
      text: index % 2 ? `阶段历史 ${index}。\n\n${'完整正文保留在时间线上。'.repeat(40)}` : `问题 ${index}`,
      ...(index % 2 ? { parts: [
        { type: 'thinking', text: `历史思考 ${index}`, startedAt: 100, endedAt: 200 },
        { type: 'tools', calls: [{ id: `history-read-${index}`, tool: 'read', args: { path: '/tmp/history.md' }, state: 'done' }] },
        { type: 'text', text: `阶段历史 ${index}。\n\n${'完整正文保留在时间线上。'.repeat(40)}` },
      ] } : {}),
    }));
    const result = await window.hemiVoice.saveConversation({ id: 'conv-stage-history', turns });
    await window.hemiVoice.renameConversation('conv-stage-history', '阶段组卸载验证');
    return result;
  });
  assert.equal(saved.ok, true);
  await page.locator('.h24-sidebar-open').filter({ hasText: '阶段组卸载验证' }).click();
  const viewport = page.locator('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');
  await page.locator('[data-virtual-total="150"]').waitFor();
  await viewport.evaluate(node => { node.scrollTop = 0; });
  const row = page.locator('[data-virtual-row="stage-history-1"]');
  await row.locator('.turn-activity-head').click();
  await row.locator('.h48-thinking-head').click();
  await page.locator('textarea.text-composer-input').focus();
  await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await wait(async () => await row.count() === 0, 'expanded row unmount');
  await viewport.evaluate(node => { node.scrollTop = 0; });
  await row.locator('.h48-thinking-head').waitFor();
  assert.equal(await row.locator('.turn-activity-head').getAttribute('aria-expanded'), 'true');
  assert.equal(await row.locator('.h48-thinking-head').getAttribute('aria-expanded'), 'true');
  check('150 条历史中过程组与思考展开状态跨真实虚拟列表卸载恢复');
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = String(error);
  if (page && !page.isClosed()) {
    await shot('failure').catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => ''));
  }
  if (fs.existsSync(path.join(userData, 'hemi.log'))) fs.copyFileSync(path.join(userData, 'hemi.log'), path.join(evidence, 'hemi.log'));
  fs.writeFileSync(path.join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  throw error;
} finally {
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  for (const release of releases.values()) release();
  await app?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(userData, { recursive: true, force: true });
}
