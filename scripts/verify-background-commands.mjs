// Production Electron renderer -> IPC -> Pi SDK -> real shell -> completion -> renderer.
// Only the external model and native folder picker are controlled. No personal data is copied.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const evidence = path.resolve(`.visual/workflow/vision/background-commands/${mode}`);
const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-background-ui-')));
const project = path.join(userData, 'independent-project');
fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
for (const name of ['failure.png', 'failure-ui.txt', 'requests.json', 'hemi.log']) fs.rmSync(path.join(evidence, name), { force: true });
fs.writeFileSync(path.join(evidence, 'stderr.log'), '');
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', completedAt: Date.now() }));
const requests = [], checks = [], errors = [], layout = {};
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const wait = async (predicate, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error(`等待超时：${label}`);
};
const text = messages => JSON.stringify(messages);
const commandDescription = '检查 GitHub 构建状态，等待安装包与更新清单生成后继续核对发布结果';
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const messages = text(body.messages);
  const marker = ['BACKGROUND_CANCEL', 'INDEPENDENT_B', 'RESOURCE_C', 'BACKGROUND_A'].find(key => messages.includes(key));
  const completed = messages.includes('［后台命令完成');
  const called = body.messages.some(message => message.role === 'tool');
  let call, content;
  if (!body.tools?.length) content = '后台任务验证';
  else if (completed) content = 'BACKGROUND_A_RESUMED_ACTUAL_RESULT';
  else if (called) content = marker === 'BACKGROUND_A' || marker === 'BACKGROUND_CANCEL' ? '后台命令已启动，完成后继续。' : `${marker}_DONE`;
  else if (marker === 'RESOURCE_C') call = { name: 'read', arguments: { path: path.join(userData, 'workspace/default/existing.txt') } };
  else call = { name: 'bash', arguments: marker === 'BACKGROUND_A' ? {
    command: `export HEMI_VERIFICATION=background\nprintf STARTED; printed=; until [ -f '${path.join(userData, 'release-a')}' ]; do if [ -z "$printed" ] && [ -f '${path.join(userData, 'progress-a')}' ]; then printf '\\nBUILD_IN_PROGRESS'; printed=1; fi; sleep 0.1; done; printf BACKGROUND_ACTUAL_RESULT`,
    description: commandDescription, yield_ms: 50,
  } : marker === 'BACKGROUND_CANCEL' ? {
    command: `sleep 3; printf FORBIDDEN > '${path.join(userData, 'late')}'`, run_in_background: true,
  } : { command: 'printf INDEPENDENT_ACTUAL_RESULT' } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
    : { role: 'assistant', content };
  for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }]) {
    res.write(`data: ${JSON.stringify({ id: 'background-verification', object: 'chat.completion.chunk', model: body.model, ...chunk })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify({
  version: 3, defaultModelId: 'audit/main', lastConversationModelKey: 'audit/main',
  providers: [{ id: 'audit', name: '后台任务验证', api: 'openai-completions', baseUrl, models: [{ id: 'main', model: 'background-test', thinkingLevel: 'off', supportsVision: false }] }],
}));
let electron, page, rendererUrl, environment;
const flow = id => page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), id);
async function moveDevMonitor() {
  const handle = page.getByRole('button', { name: '移动性能监控', exact: true });
  if (!await handle.count()) return;
  // Move the existing developer HUD with its supported controls, so it cannot cover Stop.
  for (let i = 0; i < 30 && (await handle.boundingBox()).y > 60; i++) await handle.press('Shift+ArrowUp');
}
async function resize(width, height = 900) {
  await electron.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
    win.setMinimumSize(300, 400); win.setContentSize(width, height);
  }, { width, height });
  await moveDevMonitor();
}
async function open(id) {
  await page.locator('.h24-sidebar-open').filter({ hasText: id }).first().click();
}
async function snapshot(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`) }); }
// Presentation-only boundary cases reuse the real renderer; command lifecycle checks remain real.
async function displayActivity(id, activity) {
  await electron.evaluate(async (_electron, { id, activity, serviceUrl }) => {
    // Playwright evaluates callbacks in a VM without a dynamic-import hook.
    const vm = process.getBuiltinModule('node:vm');
    const { getConversationFlowService } = await vm.runInThisContext(`import(${JSON.stringify(serviceUrl)})`, {
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    const controller = getConversationFlowService().controllerFor(id);
    const state = controller.getSnapshot();
    controller.applyFact({ type: 'run-activity', runId: state.activeRunId, generation: state.generation, activity });
  }, { id, activity, serviceUrl: pathToFileURL(path.resolve('src/main/services/conversation-flow-service.mjs')).href });
}
async function submit(marker) {
  const input = page.locator('textarea.text-composer-input');
  await input.fill(marker); await page.locator('.text-composer-send:not(.is-stop)').click();
  let session;
  await wait(async () => {
    session = await page.evaluate(async marker => {
      for (const item of (await window.hemiVoice.listConversations()).sessions) {
        const record = await window.hemiVoice.openConversation(item.id);
        if (record.turns.some(turn => turn.author === 'user' && turn.text === marker)) return record;
      }
      return null;
    }, marker);
    return !!session;
  }, `${marker} 建档`);
  return session.id;
}
async function dispatch(id, marker, workspaceId) {
  const saved = await page.evaluate(({ id, workspaceId }) => window.hemiVoice.saveConversation({ id, turns: [], profileId: 'audit/main', workspaceId }), { id, workspaceId });
  assert.equal(saved.ok, true);
  const accepted = await page.evaluate(({ id, marker, workspaceId }) => window.hemiVoice.flowCommand(id, { type: 'send', input: { text: marker, profileId: 'audit/main', workspaceId } }), { id, marker, workspaceId });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
}
try {
  electron = await _electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: ['.'],
    env: { ...process.env, HEMI_USER_DATA_DIR: userData, HEMI_TEST_MIC_GRANT: '1', HEMI_LLM_API_KEY: 'TEST_ONLY', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'background-test' },
  });
  electron.process().stderr.on('data', data => fs.appendFileSync(path.join(evidence, 'stderr.log'), data));
  environment = await electron.evaluate(({ app }) => ({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch }));
  await wait(() => { page = electron.windows().find(p => /^(?:http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page; }, '主窗口');
  rendererUrl = page.url();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('requestfailed', request => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`request: ${request.url()} ${request.failure()?.errorText}`);
  });
  await page.locator('textarea.text-composer-input').waitFor();
  await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({ id: 'audit', name: '后台任务验证', api: 'openai-completions', baseUrl, apiKey: 'TEST_ONLY', models: [{ id: 'main', model: 'background-test', thinkingLevel: 'off', supportsVision: false }], makeDefault: true }), baseUrl);
  await page.reload(); await page.locator('textarea.text-composer-input').waitFor();
  await electron.evaluate(({ dialog, BrowserWindow }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode')).show();
  }, project);
  const workspace = await page.evaluate(() => window.hemiVoice.addWorkspaceFolder());
  assert.equal(workspace.ok, true);
  fs.writeFileSync(path.join(userData, 'workspace/default/existing.txt'), 'RESOURCE_READ_ACTUAL_RESULT');
  await resize(1440);
  const a = await submit('BACKGROUND_A');
  await page.locator('.h56-run-activity[data-phase="waiting-background"]').waitFor();
  assert.equal(await page.locator('textarea.text-composer-input').getAttribute('placeholder'), '可继续输入，发送后排队…');
  assert.equal(await page.getByRole('button', { name: '停止当前任务', exact: true }).count(), 1);
  assert.equal(await page.locator('.h56-run-activity button').count(), 0);
  await page.locator('textarea.text-composer-input').fill('稍后核对发布结果');
  assert.equal(await page.getByRole('button', { name: '加入队列', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '停止当前任务', exact: true }).count(), 1);
  await page.locator('textarea.text-composer-input').fill('');
  assert.equal(await page.locator('.h56-run-activity [role="status"]').innerText(), commandDescription);
  assert.equal(await page.locator('.h56-run-activity-time').count(), 1);
  assert.match(await page.locator('.h56-run-activity-time').innerText(), /^已运行 /);
  assert.equal(await page.locator('.h56-run-activity details[open]').count(), 0);
  assert.ok(!(await page.locator('.turn-activity-head').allInnerTexts()).some(text => text.includes('export ')));
  assert.equal(await page.locator('.streaming-copy').count(), 0, '等待期间不显示模型生成光标');
  const waiting = await flow(a);
  assert.equal(waiting.phase, 'running');
  assert.equal(waiting.runs[waiting.activeRunId].activity.jobs.length, 1);
  assert.equal(waiting.runs[waiting.activeRunId].activity.jobs[0].description, commandDescription);
  assert.equal(waiting.runs[waiting.activeRunId].closedAt, null);
  check('模型生成结束后目标保留等待，真实后台进程仍运行');
  const before = requests.length;
  await page.reload();
  await page.locator('.h56-run-activity[data-phase="waiting-background"]').waitFor();
  await moveDevMonitor();
  assert.equal(requests.length, before);
  assert.equal(await page.locator('.h56-run-activity [role="status"]').innerText(), commandDescription);
  assert.match(await page.locator('.h56-run-activity-time').innerText(), /^已运行 /);
  check('重载 renderer 恢复等待状态，不重跑命令或模型');
  await wait(async () => (await flow(a)).runs[waiting.activeRunId].activity.jobs[0].lastOutputAt != null, '首次输出时间');
  const firstOutputAt = (await flow(a)).runs[waiting.activeRunId].activity.jobs[0].lastOutputAt;
  fs.writeFileSync(path.join(userData, 'progress-a'), 'done');
  await wait(async () => (await flow(a)).runs[waiting.activeRunId].activity.jobs[0].output.includes('BUILD_IN_PROGRESS'), '真实输出更新');
  assert.ok((await flow(a)).runs[waiting.activeRunId].activity.jobs[0].lastOutputAt > firstOutputAt);
  await page.locator('.h56-background-output-time').waitFor({ state: 'attached' });
  await snapshot('waiting-background-collapsed');
  for (const [width, height] of [[1440, 900], [768, 900], [375, 812]]) {
    await resize(width, height);
    await page.waitForTimeout(100);
    layout[width] = await page.locator('.h56-run-activity').evaluate(el => ({ width: el.clientWidth, height: el.getBoundingClientRect().height, scrollWidth: el.scrollWidth }));
    assert.ok(layout[width].height <= 36, `${width} 宽度下默认状态应只有一行：${layout[width].height}`);
    assert.ok(layout[width].scrollWidth <= layout[width].width, '收起状态不横向溢出');
    await snapshot(`waiting-background-collapsed-${width}`);
  }
  check('可读说明贯穿真实工具调用与重载，单一运行计时、最近输出时间和唯一停止入口可见');
  await page.locator('.h56-run-activity-head').click();
  await page.getByLabel('后台命令最近输出').waitFor();
  assert.equal(await page.locator('.h56-background-job-description').innerText(), commandDescription, '展开后可读完整说明');
  assert.match(await page.getByLabel('后台命令', { exact: true }).innerText(), /export HEMI_VERIFICATION=background\nprintf STARTED/);
  await page.keyboard.press('Tab'); // Enable the application's native keyboard-navigation mode.
  await page.locator('.h56-run-activity-head').focus();
  await page.locator('.h56-run-activity-head').press('Enter');
  await wait(async () => await page.locator('.h56-run-activity details[open]').count() === 0, '键盘折叠详情');
  await page.locator('.h56-run-activity-head').press('Enter');
  await page.getByLabel('后台命令最近输出').waitFor();
  for (const [width, height] of [[1440, 900], [768, 900], [375, 812]]) {
    await resize(width, height);
    await page.waitForTimeout(150);
    const fits = await page.locator('.h56-run-activity').evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && el.scrollWidth <= el.clientWidth;
    });
    assert.ok(fits, `等待面板在 ${width} 宽下不得横向溢出`);
    assert.ok((await page.locator('.h56-run-activity').boundingBox()).height <= 260, '展开区域限制总高度');
    await snapshot(`waiting-background-${width}`);
  }
  check('375/768/1440 长说明、单一运行计时、原始命令和输出不溢出，详情支持键盘展开');
  const actualActivity = (await flow(a)).runs[waiting.activeRunId].activity;
  try {
    const activity = { ...actualActivity, jobs: [
      { ...actualActivity.jobs[0], startedAt: Date.now() - 3_925_000 },
      { ...actualActivity.jobs[0], id: 'display-only-legacy', description: undefined, lastOutputAt: undefined, output: '', startedAt: Date.now() - 67_000 },
    ] };
    await page.locator('.h56-run-activity-head').click();
    await displayActivity(a, activity);
    await page.locator('.h56-background-job').nth(1).waitFor({ state: 'attached' });
    assert.equal(await page.locator('.h56-run-activity-head .h56-run-activity-time').innerText(), '2 条命令');
    for (const [width, height] of [[1440, 900], [768, 900], [375, 812]]) {
      await resize(width, height);
      await page.waitForTimeout(150);
      assert.ok(await page.locator('.h56-run-activity').evaluate(el => el.scrollWidth <= el.clientWidth));
      assert.ok((await page.locator('.h56-run-activity').boundingBox()).height <= 36, '多命令默认也只有一行');
      await snapshot(`display-boundary-multiple-collapsed-${width}`);
      await page.locator('.h56-run-activity-head').click();
      assert.match((await page.locator('.h56-run-activity-time').allInnerTexts()).join(' '), /65 分/);
      assert.equal(await page.locator('.h56-background-job-description').nth(1).innerText(), '后台命令');
      assert.ok((await page.locator('.h56-run-activity').boundingBox()).height <= 260, '多命令展开高度有上限');
      await snapshot(`display-boundary-multiple-${width}`);
      await page.locator('.h56-run-activity-head').click();
    }
    check('展示边界样本：多命令分别计时、超过一小时和旧数据缺字段，在三种宽度正常显示');
  } finally { await displayActivity(a, actualActivity); }
  await resize(1440);
  const b = 'conv-independent-background-b', c = 'conv-background-resource-c';
  await dispatch(b, 'INDEPENDENT_B', workspace.workspace.id);
  await wait(async () => (await flow(b))?.phase === 'idle', '独立工作区完成');
  assert.notEqual((await flow(a)).phase, 'idle');
  const bState = await flow(b);
  assert.ok(JSON.stringify(bState.timeline).includes('INDEPENDENT_B_DONE'));
  check('后台 Shell 不阻塞其他会话和独立工作区真实命令');
  await dispatch(c, 'RESOURCE_C', 'default');
  await wait(async () => { const state = await flow(c); return state.runs[state.activeRunId]?.activity?.phase === 'waiting-resource'; }, '同工作区资源排队');
  await open('RESOURCE_C');
  await page.locator('.h56-run-activity[data-phase="waiting-resource"]').waitFor();
  assert.ok((await page.locator('.h56-run-activity').boundingBox()).height <= 36, '资源等待默认也只有一行');
  assert.equal(await page.locator('.h56-run-activity details[open]').count(), 0, '切换会话不继承展开状态');
  await page.locator('.h56-run-activity-head').click();
  assert.ok((await page.locator('.h56-run-activity').innerText()).includes('另一个操作正在占用此工作区'));
  assert.match(await page.locator('.h56-run-activity-time').innerText(), /^已等待 /);
  assert.ok((await page.locator('.h56-run-activity').innerText()).includes(commandDescription));
  assert.ok(!(await page.locator('.h56-run-activity').innerText()).includes('export '));
  await snapshot('waiting-resource');
  check('同工作区读写仍受协调，界面明确展示资源等待原因');
  fs.writeFileSync(path.join(userData, 'release-a'), 'done');
  await wait(async () => (await flow(a)).phase === 'idle' && (await flow(c)).phase === 'idle', '后台完成后原目标续跑');
  const resumed = requests.filter(r => r.tools?.length && text(r.messages).includes('［后台命令完成'));
  assert.equal(resumed.length, 1);
  assert.match(text(resumed[0].messages), /BACKGROUND_ACTUAL_RESULT/);
  assert.ok(JSON.stringify((await flow(a)).timeline).includes('BACKGROUND_A_RESUMED_ACTUAL_RESULT'));
  assert.equal((await page.evaluate(() => window.hemiVoice.listConversations())).sessions.find(s => s.id === a).status, null);
  check('完成事件只唤醒原目标一次，读取真实结果并收口，释放工作区等待者');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  const cancel = await submit('BACKGROUND_CANCEL');
  await page.locator('.h56-run-activity[data-phase="waiting-background"]').waitFor();
  assert.equal(await page.locator('.h56-run-activity [role="status"]').innerText(), '后台命令');
  await page.locator('.h56-run-activity-head').click();
  assert.equal(await page.getByLabel('后台命令最近输出').innerText(), '尚无输出，正在等待命令返回。');
  assert.equal(await page.locator('.h56-background-output-time').count(), 0);
  await snapshot('waiting-without-description-or-output');
  const count = requests.length;
  await page.getByRole('button', { name: '停止当前任务', exact: true }).click();
  await wait(async () => (await flow(cancel)).phase === 'idle', '停止屏障关闭');
  await page.waitForTimeout(3200);
  assert.equal(fs.existsSync(path.join(userData, 'late')), false);
  assert.equal(requests.length, count);
  assert.equal(await page.locator('.h56-run-activity').count(), 0);
  check('界面停止会回收真实后台进程，迟到完成不唤醒，等待面板消失');
  assert.deepEqual(errors, []);
  const journal = JSON.parse(fs.readFileSync(path.join(userData, 'runtime-v2/run-journal.json'), 'utf8'));
  assert.ok(Object.values(journal.processes).every(process => !['active', 'unknown'].includes(process.state)));
  check('Renderer 无运行错误，所有受控命令已确认退出');
} catch (error) {
  if (page && !page.isClosed()) {
    await snapshot('failure').catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => ''));
  }
  if (fs.existsSync(path.join(userData, 'hemi.log'))) fs.copyFileSync(path.join(userData, 'hemi.log'), path.join(evidence, 'hemi.log'));
  fs.writeFileSync(path.join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  throw error;
} finally {
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ mode, rendererUrl, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: true, node: process.version, platform: `${process.platform}/${process.arch}`, environment, layout, checks, errors }, null, 2));
  await electron?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(userData, { recursive: true, force: true });
}
