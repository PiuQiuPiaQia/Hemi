// Real renderer, preload/IPC, Pi runtime and Bot socket/Host. Only the model
// endpoint and SSH executable are fixtures; all files and profiles are isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';

const repo = path.resolve(import.meta.dirname, '..');
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
// macOS Unix sockets need a short path (sun_path is limited to 104 bytes).
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'hemi-files-')));
const userData = path.join(root, 'desktop');
const botData = path.join(root, 'bot-data');
const directories = { LOCAL: path.join(userData, 'workspace/default'), BOT: path.join(root, 'bot-workspace') };
const evidence = path.join(repo, '.visual/workflow/vision/registered-deliverables', mode);
fs.mkdirSync(evidence, { recursive: true });
for (const [name, dir] of Object.entries(directories)) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '已登记报告.md'), `# ${name}_DELIVERY_CONTENT`);
  fs.writeFileSync(path.join(dir, '正文 100% 文件.md'), `# ${name}_BODY_CONTENT`);
}
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
fs.writeFileSync(path.join(userData, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
const report = { mode, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), workingTree: true,
  node: process.version, environment: `${process.platform}/${process.arch}`, checks: [], errors: [], screenshots: [],
  gaps: ['SSH transport is a local executable fixture; no deployment to the user’s server.'] };
const check = text => { report.checks.push(text); console.log('PASS', text); };
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const name = JSON.stringify(body.messages).includes('BOT_FIXTURE') ? 'BOT' : 'LOCAL';
    const dir = directories[name];
    const registered = path.join(dir, '已登记报告.md');
    const loose = path.join(dir, '正文 100% 文件.md');
    const main = body.tools?.some(tool => tool.function.name === 'register_delivery');
    const done = body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'registered-file');
    const tool = main && !done ? { index: 0, id: 'registered-file', type: 'function',
      function: { name: 'register_delivery', arguments: JSON.stringify({ files: [{ path: registered }] }) } } : null;
    const content = main ? ['文件已准备好。', `[已登记文件](<${registered}>)`, `[未登记正文文件](<${loose}>)`,
      `行内路径也可打开：\`${loose}\`。`, '配置路径示例：`~/.gitconfig`、`/home/example/.config/gh/hosts.yml`。',
      `[不存在的文件](<${path.join(dir, 'missing.md')}>)`].join('\n\n') : '交付登记验证';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[tool ? { role: 'assistant', tool_calls: [tool] } : { role: 'assistant', content }, null],
      [{}, tool ? 'tool_calls' : 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'registered-files', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  } catch (error) { report.errors.push(String(error)); res.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
process.env.HEMI_BOT_DATA_DIR = botData;
const { serve } = await import('../src/main/bot/cli.mjs');
const resident = await serve({ defaultDir: directories.BOT, allowLoopbackModels: true, validateModel: async () => {} });
const hello = await resident.host.request('handshake');
const botCall = (method, params = {}) => resident.host.request(method, { ...params, instanceId: hello.instanceId, requestId: crypto.randomUUID() });
await botCall('model.sync', { models: [{ modelKey: 'fixture/main', providerId: 'fixture', name: '隔离模型', model: 'fixture-model', api: 'openai-completions', baseUrl, apiKey: 'TEST_ONLY' }] });
fs.mkdirSync(path.join(userData, 'bot'), { recursive: true });
fs.writeFileSync(path.join(userData, 'bot/connection.json'), JSON.stringify({ ...hello, host: 'fixture-cloud' }));
const ssh = path.join(root, 'ssh');
fs.writeFileSync(ssh, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst fs=require('node:fs');\nconst r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(path.join(repo, 'src/main/bot/cli.mjs'))},'rpc'],{env:{...process.env,HEMI_BOT_DATA_DIR:${JSON.stringify(botData)}},input:fs.readFileSync(0),encoding:'utf8'});\nprocess.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);\n`, { mode: 0o700 });
const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
let app, page;
async function wait(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out: ' + label);
}
const input = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const cards = () => page.locator('.h62-deliverable-card');
async function resize(width) {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows().find(win => !new URL(win.webContents.getURL()).searchParams.has('mode'));
    win.setMinimumSize(1, 1); win.setContentSize(width, 900); win.show();
  }, width);
  await page.waitForFunction(width => innerWidth === width, width);
}
async function screenshot(name) {
  await page.waitForTimeout(250); // Let the existing preview/resize transitions finish.
  await page.screenshot({ path: path.join(evidence, name + '.png'), scale: 'css' });
  report.screenshots.push(name + '.png');
}
async function exercise(name) {
  await input().waitFor();
  await input().fill(name + '_FIXTURE 生成登记文件，并在正文引用未登记文件。');
  await page.locator('.text-composer-send[data-action="send"]').click();
  await page.getByRole('link', { name: '未登记正文文件', exact: true }).waitFor();
  await wait(async () => await cards().count() === 1, name + ' registered card');
  const snapshot = async () => name === 'BOT'
    ? Object.values((await page.evaluate(() => window.hemiVoice.bot.getState())).cache.details).find(detail => detail.flow.timeline.length).flow
    : page.evaluate(async () => { const { sessions } = await window.hemiVoice.listConversations(); return window.hemiVoice.flowGetSnapshot(sessions[0].id); });
  await wait(async () => (await snapshot()).phase === 'idle', name + ' settled');
  assert.equal(Object.keys((await snapshot()).artifacts).length, 1);
  assert.equal(await cards().filter({ hasText: '已登记报告.md' }).count(), 1);
  assert.equal(await cards().filter({ hasText: /正文|gitconfig|hosts.yml|missing/ }).count(), 0);
  const collapse = () => page.getByRole('button', { name: '收起预览，返回对话', exact: true }).click();
  await page.getByRole('link', { name: '未登记正文文件', exact: true }).click();
  await page.getByRole('heading', { name: name + '_BODY_CONTENT', exact: true }).waitFor();
  await screenshot(name.toLowerCase() + '-body-preview'); await collapse();
  await page.locator('button.h62-code-link').filter({ hasText: '正文 100% 文件.md' }).click();
  await page.getByRole('heading', { name: name + '_BODY_CONTENT', exact: true }).waitFor(); await collapse();
  assert.equal(Object.keys((await snapshot()).artifacts).length, 1);
  assert.equal(await cards().count(), 1);
  await cards().getByRole('button', { name: '预览 已登记报告.md', exact: true }).click();
  await page.getByRole('heading', { name: name + '_DELIVERY_CONTENT', exact: true }).waitFor(); await collapse();
  await page.getByRole('link', { name: '不存在的文件', exact: true }).click();
  await page.getByText(/文件不存在，可能已被移动或删除/).first().waitFor();
  await page.getByText(/文件不存在，可能已被移动或删除/).first().waitFor({ state: 'hidden' });
  for (const width of [1440, 768, 375]) {
    await resize(width); await cards().scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot(name.toLowerCase() + '-' + width);
  }
  await resize(1440);
  check(name + ': exactly one registered card; Markdown and inline paths open actual unregistered bytes without registration; registered card opens; missing links report failure; 1440/768/375 have no overflow');
}
try {
  const env = { ...process.env, HEMI_USER_DATA_DIR: userData, HEMI_SSH_BIN: ssh, HEMI_TEST_MIC_GRANT: '1' };
  for (const key of ['HEMI_LLM_API_KEY', 'HEMI_LLM_BASE_URL', 'HEMI_LLM_MODEL', 'HEMI_LLM_THINKING_LEVEL']) delete env[key];
  app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: repo, env });
  await wait(() => { page = app.windows().find(page => /^(http|file):/.test(page.url()) && !new URL(page.url()).searchParams.has('mode')); return !!page; }, 'main window');
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await input().waitFor();
  report.rendererUrl = page.url();
  await page.evaluate(async baseUrl => {
    await window.hemiVoice.saveModelProfile({ id: 'fixture', name: '隔离模型', api: 'openai-completions', baseUrl,
      apiKey: 'TEST_ONLY', models: [{ id: 'main', model: 'fixture-model', thinkingLevel: 'off' }] });
    await window.hemiVoice.saveRoleModel({ main: 'fixture/main' });
  }, baseUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await input().waitFor(); await resize(1440);
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await exercise('LOCAL');
  await page.getByRole('button', { name: 'Bot', exact: true }).click();
  await wait(async () => {
    const state = await page.evaluate(() => window.hemiVoice.bot.getState());
    return state.online && state.cache?.selectedId && state.cache.details[state.cache.selectedId];
  }, 'Bot session ready');
  await exercise('BOT');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await screenshot('bot-dark-preference-reduced-motion');
  report.gaps.push('The product supports light mode only; dark preference and reduced motion were checked without changing the product theme.');
  assert.deepEqual(report.errors, []);
  check('No renderer errors in local or Bot flows');
} catch (error) {
  report.errors.push(error.stack);
  if (page && !page.isClosed()) {
    await screenshot('failure').catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  if (app) await app.close();
  await resident.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
