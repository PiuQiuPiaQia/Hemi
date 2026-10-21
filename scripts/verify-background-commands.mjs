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
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', completedAt: Date.now() }));
const requests = [], checks = [], errors = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const wait = async (predicate, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error(`等待超时：${label}`);
};
const text = messages => JSON.stringify(messages);
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
    command: `printf STARTED; until [ -f '${path.join(userData, 'release-a')}' ]; do sleep 0.1; done; printf BACKGROUND_ACTUAL_RESULT`, yield_ms: 50,
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
let electron, page, rendererUrl;
const flow = id => page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), id);
async function resize(width, height = 900) {
  await electron.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
    win.setMinimumSize(300, 400); win.setContentSize(width, height);
  }, { width, height });
}
async function open(id) {
  await page.locator('.h24-sidebar-open').filter({ hasText: id }).first().click();
}
async function snapshot(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`) }); }
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
  await wait(() => { page = electron.windows().find(p => /^(?:http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page; }, '主窗口');
  rendererUrl = page.url();
  page.on('pageerror', error => errors.push(error.message));
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
  assert.match(await page.locator('textarea.text-composer-input').getAttribute('placeholder'), /任务等待中/);
  assert.equal(await page.locator('.streaming-copy').count(), 0, '等待期间不显示模型生成光标');
  const waiting = await flow(a);
  assert.equal(waiting.phase, 'running');
  assert.equal(waiting.runs[waiting.activeRunId].activity.jobs.length, 1);
  assert.equal(waiting.runs[waiting.activeRunId].closedAt, null);
  check('模型生成结束后目标保留等待，真实后台进程仍运行');
  const before = requests.length;
  await page.reload();
  await page.locator('.h56-run-activity[data-phase="waiting-background"]').waitFor();
  assert.equal(requests.length, before);
  check('重载 renderer 恢复等待状态，不重跑命令或模型');
  await page.locator('.h56-background-job summary').click();
  await page.getByLabel('后台命令最近输出').waitFor();
  for (const [width, height] of [[1440, 900], [768, 900], [375, 812]]) {
    await resize(width, height);
    await page.waitForTimeout(150);
    const fits = await page.locator('.h56-run-activity').evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && el.scrollWidth <= el.clientWidth;
    });
    assert.ok(fits, `等待面板在 ${width} 宽下不得横向溢出`);
    await snapshot(`waiting-background-${width}`);
  }
  check('375/768/1440 等待面板、耗时、输出与停止入口可见');
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
  assert.ok((await page.locator('.h56-run-activity').innerText()).includes('另一个操作正在占用此工作区'));
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
  const count = requests.length;
  await page.getByRole('button', { name: '停止当前任务及后台命令', exact: true }).click();
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
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ mode, rendererUrl, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, platform: `${process.platform}/${process.arch}`, checks, errors }, null, 2));
  await electron?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(userData, { recursive: true, force: true });
}
