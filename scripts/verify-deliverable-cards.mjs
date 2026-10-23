// Actual renderer + production IPC/controller/tool execution. Only the model endpoint is controlled.
// Optional HEMI_DELIVERABLE_HISTORY_ID/UD load a private, read-only source into isolated userData.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';
import { discoverFileApplications } from '../src/main/services/file-application-discovery.mjs';

const runtime = process.env.HEMI_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);
const mode = process.env.VITE_DEV_SERVER_URL ? 'dev' : 'built';
const evidence = path.resolve(`.visual/workflow/vision/deliverable-cards/${mode}`);
const userData = fs.mkdtempSync(path.join(os.homedir(), `hemi-deliverable-${mode}-`));
const workspace = path.join(userData, 'workspace/default');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now() }));
fs.writeFileSync(path.join(userData, 'appearance.json'), JSON.stringify({ schemaVersion: 1, skinId: 'classic', mode: 'light' }));
const report = { mode, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: true,
  node: process.version, environment: `${process.platform}/${process.arch}`, checks: [], errors: [], screenshots: [] };
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const sourceId = process.env.HEMI_DELIVERABLE_HISTORY_ID;
const legacyId = 'conv-verify-deliverable-legacy-home';
fs.mkdirSync(path.join(userData, 'conversations'), { recursive: true });
fs.writeFileSync(path.join(userData, 'conversations', `${legacyId}.json`), JSON.stringify({
  version: 2, id: legacyId, title: '旧会话目录验证', workspaceId: null, createdAt: 1, updatedAt: 1,
  turns: [{ id: 'legacy-input', author: 'user', text: '旧会话目录验证', createdAt: 1 }],
}));
let sourceFile, sourceBytes, historical;
if (sourceId) {
  const sourceUd = process.env.HEMI_DELIVERABLE_HISTORY_UD ?? path.join(os.homedir(), 'Library/Application Support/hemi');
  sourceFile = ['runtime-v2/conversations', 'conversations'].map(dir => path.join(sourceUd, dir, `${sourceId}.json`)).find(fs.existsSync);
  assert.ok(sourceFile, 'history source exists');
  sourceBytes = fs.readFileSync(sourceFile);
  historical = JSON.parse(sourceBytes);
  fs.writeFileSync(path.join(userData, 'conversations', `${sourceId}.json`), sourceBytes);
  const workspacesFile = path.join(sourceUd, 'workspaces.json');
  if (fs.existsSync(workspacesFile)) fs.copyFileSync(workspacesFile, path.join(userData, 'workspaces.json'));
}

const imagePath = path.join(workspace, '横版封面.svg');
const loosePath = path.join(workspace, '竖版 100% 封面.svg');
const documentPath = path.join(workspace, '封面说明.md');
const missingPath = path.join(workspace, '尚未生成.svg');
const marker = `DELIVERY_${Date.now()}`;
const applicationReceipt = path.join(userData, 'application-receipt.txt');
const applicationFixture = path.join(os.homedir(), 'Applications', `Hemi Delivery Verification-${marker}.app`);
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
if (process.platform === 'darwin') {
  const source = path.join(userData, 'file-handler.applescript');
  fs.writeFileSync(source, `on open inputFiles\nset targetPath to POSIX path of (item 1 of inputFiles)\nset fileRef to open for access POSIX file "${applicationReceipt}" with write permission\nset eof fileRef to 0\nwrite targetPath to fileRef as «class utf8»\nclose access fileRef\nend open\n`);
  execFileSync('/usr/bin/osacompile', ['-o', applicationFixture, source]);
  const plist = path.join(applicationFixture, 'Contents/Info.plist');
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', `ai.hemi.delivery-verification.${Date.now()}`, plist]);
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleDocumentTypes', '-json', JSON.stringify([
    { CFBundleTypeName: 'Text', LSItemContentTypes: ['public.text'], LSHandlerRank: 'Alternate', CFBundleTypeRole: 'Editor' },
  ]), plist]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', applicationFixture]);
  execFileSync(lsregister, ['-f', applicationFixture]);
}
const svg = (portrait, updated = false) => `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 360 : 640}" height="${portrait ? 540 : 360}"><rect width="100%" height="100%" fill="${updated ? '#e7cbb9' : '#d6e2d1'}"/><text x="24" y="100" font-size="22">${marker}${updated ? '_UPDATED' : ''}</text></svg>`;
let requests = 0;
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const main = (body.tools ?? []).length > 0;
    if (main) requests++;
    const calls = body.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []).map(t => t.id);
    const update = body.messages.some(m => m.role === 'user' &&
      (Array.isArray(m.content) ? m.content.map(part => part.text ?? '').join('\n') : String(m.content)).includes('UPDATE_DELIVERY'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'delivery-cards', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const tool = (name, args, id) => { send({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); send({}, 'tool_calls'); };
    if (!main) { send({ role: 'assistant', content: '交付物展示验证' }); send({}, 'stop'); }
    else if (update && !calls.includes('update-image')) tool('write', { path: imagePath, content: svg(false, true) }, 'update-image');
    else if (update && !calls.includes('update-register')) tool('register_delivery', { files: [{ path: imagePath, description: '已更新的横版封面' }] }, 'update-register');
    else if (update) { send({ role: 'assistant', content: '横版封面已更新。' }); send({}, 'stop'); }
    else if (!calls.includes('write-image')) tool('write', { path: imagePath, content: svg(false) }, 'write-image');
    else if (!calls.includes('write-loose')) tool('write', { path: loosePath, content: svg(true) }, 'write-loose');
    else if (!calls.includes('write-document')) tool('write', { path: documentPath, content: `# 封面说明\n\n${marker}\n\n横版与竖版封面用于不同发布比例。` }, 'write-document');
    else if (!calls.includes('register-files')) tool('register_delivery', { files: [{ path: imagePath, description: '横版封面' }, { path: documentPath, description: '封面与发布比例说明' }] }, 'register-files');
    else {
      send({ role: 'assistant', content: ['封面已生成，横竖版可直接预览。', `[横版](<${imagePath}>)`,
        `![竖版](<${loosePath}>)`, `![同一竖版的相对路径](<./竖版 100% 封面.svg>)`,
        `![同一竖版的 file URL](<${pathToFileURL(loosePath).href}>)`, `[封面说明](<${documentPath}>)`,
        `![缺失文件](<${missingPath}>)`].join('\n\n') });
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  } catch (error) { report.errors.push(String(error)); res.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify({ version: 3,
  defaultModelId: 'delivery/main', lastConversationModelKey: 'delivery/main', providers: [{ id: 'delivery', name: '交付展示验证', api: 'openai-completions', baseUrl,
    models: [{ id: 'main', model: 'delivery-test', thinkingLevel: 'off', supportsVision: true }] }] }));

let app, page, success = false;
const wait = async (predicate, label, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timed out: ${label}`);
};
const input = () => page.getByRole('textbox', { name: '输入消息', exact: true });
const cards = () => page.locator('.h62-deliverable-card');
const imageReady = () => page.waitForFunction(() => document.querySelector('.h24-preview-image')?.naturalWidth > 0);
const collapse = () => page.getByRole('button', { name: '收起预览，返回对话', exact: true }).click();
const shot = async name => {
  await page.waitForTimeout(250); // Capture after the existing menu/resize transitions settle.
  await page.screenshot({ path: path.join(evidence, `${name}.png`), scale: 'css' }); report.screenshots.push(`${name}.png`);
};
async function resize(width) {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows().find(w => !new URL(w.webContents.getURL()).searchParams.has('mode'));
    win.setMinimumSize(1, 1); win.setContentSize(width, 1000); win.show();
  }, width);
  await page.waitForFunction(width => innerWidth === width, width);
  await page.waitForTimeout(300);
}
async function start() {
  const env = { ...process.env, HEMI_USER_DATA_DIR: userData, HEMI_TEST_MIC_GRANT: '1' };
  for (const key of ['HEMI_LLM_API_KEY', 'HEMI_LLM_BASE_URL', 'HEMI_LLM_MODEL', 'HEMI_LLM_THINKING_LEVEL']) delete env[key];
  app = await _electron.launch({ executablePath: electronPath, args: ['.'], env });
  await wait(() => { page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page; }, 'main window');
  page.setDefaultTimeout(Number(process.env.HEMI_UI_TIMEOUT_MS ?? 15000));
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await app.evaluate(({ shell }) => {
    globalThis.__workspaceOpenPaths = [];
    const original = shell.openPath;
    shell.openPath = async target => { globalThis.__workspaceOpenPaths.push(target); return original(target); };
  });
  await input().waitFor();
  report.rendererUrl = page.url();
  await resize(1440);
}
async function stop() {
  if (!app) return;
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  let timer;
  await Promise.race([app.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(() => { app.process().kill('SIGTERM'); resolve(); }, 5000); })]);
  clearTimeout(timer); app = null;
}
async function openChat(id) {
  const list = await page.evaluate(() => window.hemiVoice.listConversations());
  const entry = list.sessions.find(s => s.id === id);
  assert.ok(entry);
  await page.locator('.h24-sidebar-open').filter({ hasText: entry.title }).click();
}
async function checkHistory(label) {
  await openChat(sourceId);
  const flow = await page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), sourceId);
  const artifact = Object.values(flow.artifacts).find(a => a.previewKind === 'image');
  assert.ok(artifact);
  await page.getByRole('button', { name: `预览 ${artifact.name}`, exact: true }).last().scrollIntoViewIfNeeded();
  await wait(() => page.locator('.h62-deliverable-thumbnail img').evaluateAll(images => images.some(img => img.naturalWidth > 0)), 'historical thumbnails decode');
  await shot(`${label}-history-1440`);
  const historyCard = page.getByRole('button', { name: `预览 ${artifact.name}`, exact: true }).last();
  await historyCard.click({ button: 'right' });
  await page.locator('.h62-file-applications [role="menuitem"]').first().waitFor();
  await page.getByRole('menuitem', { name: '打开所在目录', exact: true }).waitFor();
  await shot(`${label}-history-context-menu`);
  await page.keyboard.press('Escape');
  const producers = new Set(Object.values(flow.artifacts).flatMap(a => (a.producers ?? []).map(p => p.runId)));
  // Verify the generating run independently from the later registration run.
  const recovered = await page.locator('[data-flow-row]').evaluateAll(rows => rows.filter(row => row.querySelector('.h62-deliverable-card')).map(row => ({ runId: row.dataset.runId, count: row.querySelectorAll('.h62-deliverable-card').length })));
  assert.ok(recovered.some(row => !producers.has(row.runId) && row.count >= 2), 'original generating run recovered both images');
  assert.ok(recovered.some(row => producers.has(row.runId) && row.count >= 2), 'registered reply retains both images');
  await page.getByRole('button', { name: `预览 ${artifact.name}`, exact: true }).last().click();
  await imageReady();
  const src = await page.locator('.h24-preview-image').getAttribute('src');
  assert.equal(Buffer.from(src.split(',')[1], 'base64').compare(fs.readFileSync(artifact.path)), 0);
  await shot(`${label}-history-preview`);
  await collapse();
  assert.equal(requests, 0, 'historical replay never calls model');
  check(`${label}: original conversation has thumbnails in generating and registration runs; actual file bytes; zero model calls`);
}

try {
  await start();
  await openChat(legacyId);
  await page.getByRole('button', { name: '选择打开方式', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '在访达中打开', exact: true }).click();
  await wait(async () => (await app.evaluate(() => globalThis.__workspaceOpenPaths)).includes(os.homedir()), 'legacy topbar opens real home');
  check('legacy conversation restores top-right shortcuts and opens actual home directory');
  if (historical) await checkHistory('initial');
  await page.evaluate(async baseUrl => {
    await window.hemiVoice.saveModelProfile({ id: 'delivery', name: '交付展示验证', api: 'openai-completions', baseUrl,
      apiKey: 'TEST_ONLY', models: [{ id: 'main', model: 'delivery-test', thinkingLevel: 'default' }] });
    await window.hemiVoice.saveRoleModel({ main: 'delivery/main' });
  }, baseUrl);
  await page.reload({waitUntil:'domcontentloaded'}); await input().waitFor();
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  fs.rmSync(workspace, { recursive: true, force: true }); // First-use open must create its managed default directory.
  await page.getByRole('button', { name: '选择打开方式', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '在终端中打开', exact: true }).waitFor();
  await page.getByRole('menuitemradio', { name: '在 VS Code 中打开', exact: true }).waitFor();
  await shot('default-workspace-open-menu');
  await page.getByRole('menuitemradio', { name: '在访达中打开', exact: true }).click();
  await wait(async () => (await app.evaluate(() => globalThis.__workspaceOpenPaths)).includes(workspace), 'default topbar opens its own directory');
  check('default conversation restores top-right Finder/terminal/VS Code shortcuts and opens actual default workspace');
  await input().fill('CREATE_DELIVERY 创建横竖封面与说明，声明横版和说明，以明确路径引用竖版。');
  await input().press('Enter');
  await page.getByRole('link', { name: '封面说明', exact: true }).waitFor({ timeout: 45000 });
  await wait(async () => (await cards().count()) >= 4, 'image and file cards');
  const cid = (await page.evaluate(() => window.hemiVoice.listConversations())).sessions.find(s => s.id !== sourceId && s.id !== legacyId).id;
  await wait(async () => (await page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), cid)).phase === 'idle', 'turn closes');
  const flow = await page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), cid);
  assert.equal(Object.keys(flow.artifacts).length, 2);
  assert.ok(!Object.values(flow.artifacts).some(a => a.path === loosePath));
  assert.ok(!flow.timeline.some(i => i.kind === 'assistant' && i.afterInputId == null && i.parts.some(p => p.kind === 'deliverable')));
  const loose = cards().filter({ has: page.locator('.h62-deliverable-name', { hasText: '竖版 100% 封面.svg' }) });
  await loose.first().scrollIntoViewIfNeeded();
  await wait(async () => await loose.count() === 1, 'canonical alias dedup');
  await loose.locator('img').waitFor();
  assert.equal(await cards().filter({ hasText: '封面说明.md' }).count(), 1);
  check('production tools write files and register; correct input anchor; undeclared path thumbnails; alias and same-turn dedup');
  await cards().filter({ hasText: '封面说明.md' }).getByRole('button').click();
  await page.getByText(marker, { exact: true }).waitFor(); await collapse();
  check('file card opens actual Markdown content through production IPC');
  assert.equal(await page.locator('.h62-deliverable-meta, .h62-deliverable-description').count(), 0);
  const documentCard = cards().filter({ hasText: '封面说明.md' });
  assert.ok((await documentCard.boundingBox()).height <= 48, 'ordinary file stays one compact row');
  if (process.platform === 'darwin') {
    const applicationList = await page.evaluate(async ({ cid, documentPath }) => {
      const file = await window.hemiVoice.resolveConversationLink(cid, documentPath);
      return window.hemiVoice.listConversationDeliverableApplications(cid, file.artifactId, file.path);
    }, { cid, documentPath });
    assert.ok(applicationList.ok);
    const receiver = (await discoverFileApplications(documentPath)).find(application => application.path === applicationFixture);
    assert.ok(receiver, 'real macOS file-handler query finds the registered test application');
    assert.ok(applicationList.applications.length > 0 && applicationList.applications.length <= 4);
    assert.ok(applicationList.applications.some(application => /文本编辑|TextEdit|Visual Studio Code/.test(application.name)));
    assert.ok(!applicationList.applications.some(application => /Excel|夸克|Hemi Delivery Verification/.test(application.name)));
    await app.evaluate(({ dialog, shell }) => {
      globalThis.__deliveryOsActions = [];
      dialog.showOpenDialog = async () => { throw new Error('direct application menus must not open a chooser'); };
      const originalOpenPath = shell.openPath;
      shell.openPath = async target => { globalThis.__deliveryOsActions.push({ intent: 'directory', target }); return originalOpenPath(target); };
      const originalShowItemInFolder = shell.showItemInFolder;
      shell.showItemInFolder = target => { globalThis.__deliveryOsActions.push({ intent: 'reveal', target }); originalShowItemInFolder(target); };
    });
    const contextAction = async name => {
      await documentCard.getByRole('button', { name: '预览 封面说明.md', exact: true }).click({ button: 'right' });
      await page.getByRole('menuitem', { name, exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).waitFor({ state: 'hidden' });
    };
    await documentCard.getByRole('button', { name: '预览 封面说明.md', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: applicationList.applications[0].name, exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitem', { name: /^(预览|用默认程序打开|打开方式…)$/ }).count(), 0);
    await shot('file-application-menu');
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem', { name: applicationList.applications[0].name, exact: true }).waitFor({ state: 'hidden' });
    const selected = await page.evaluate(async ({ cid, documentPath, applicationId }) => {
      const file = await window.hemiVoice.resolveConversationLink(cid, documentPath);
      return window.hemiVoice.openConversationDeliverable(cid, file.artifactId, file.path, 'application', applicationId);
    }, { cid, documentPath, applicationId: receiver.id });
    assert.ok(selected.ok);
    await wait(() => fs.existsSync(applicationReceipt), 'selected native application receives open-file event');
    assert.equal(fs.readFileSync(applicationReceipt, 'utf8'), documentPath);
    await contextAction('打开所在目录');
    await wait(() => app.evaluate(() => globalThis.__deliveryOsActions.length > 0), 'native file reveal invoked');
    const osActions = await app.evaluate(() => globalThis.__deliveryOsActions);
    assert.deepEqual(osActions.filter(a => a.target).map(a => [a.intent, a.target]), [['reveal', documentPath]]);
    assert.equal(await documentCard.locator('.h62-deliverable-error').count(), 0);
    const forged = await page.evaluate(async ({ cid, documentPath }) => {
      const file = await window.hemiVoice.resolveConversationLink(cid, documentPath);
      return window.hemiVoice.openConversationDeliverable(cid, file.artifactId, file.path, 'application', 'forged-id');
    }, { cid, documentPath });
    assert.equal(forged.ok, false);
    check('menu shows only common type-matched applications; real IPC opens exact file with a registered app without a chooser; directory action reveals the exact file in Finder; forged app rejected');
  }
  for (const width of [1440, 768, 375]) {
    await resize(width);
    await loose.scrollIntoViewIfNeeded();
    await wait(() => loose.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), 'portrait visible');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await loose.locator('img').evaluate(img => getComputedStyle(img).objectFit === 'contain' && img.naturalHeight > img.naturalWidth));
    assert.ok(await loose.evaluate(card => card.getBoundingClientRect().right <= innerWidth));
    assert.ok(await loose.locator('.h62-deliverable-thumbnail').evaluate(node => node.getBoundingClientRect().height <= 121));
    await shot(`cards-${width}`);
    await loose.getByRole('button', { name: '预览 竖版 100% 封面.svg', exact: true }).click(); await imageReady(); await collapse();
  }
  check('1440/768/375 preserve portrait ratio, no horizontal overflow, preview open/close');
  await resize(1440);
  const missing = cards().filter({ hasText: path.basename(missingPath) });
  await missing.scrollIntoViewIfNeeded();
  await missing.getByRole('button', { name: '重试', exact: true }).waitFor();
  fs.writeFileSync(missingPath, svg(false));
  await missing.getByRole('button', { name: '重试', exact: true }).click();
  await wait(() => missing.locator('img').evaluate(img => img.naturalWidth > 0), 'retry reads restored file');
  check('missing file shows reason; retry reads restored actual file');
  await page.getByRole('button', { name: '预览 横版封面.svg', exact: true }).click(); await imageReady();
  await input().fill('UPDATE_DELIVERY 更新横版封面并再次声明。'); await input().press('Enter');
  await wait(async () => (await page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), cid)).artifacts[Object.keys(flow.artifacts).find(id => flow.artifacts[id].path === imagePath)]?.contentVersion === 2, 'version increments');
  await wait(async () => {
    const src = await page.locator('.h24-preview-image').getAttribute('src');
    return src && Buffer.from(src.split(',')[1], 'base64').toString().includes('_UPDATED');
  }, 'open preview refreshes in place');
  assert.equal(await page.getByRole('tab').filter({ hasText: '横版封面.svg' }).count(), 1);
  await collapse();
  assert.equal(await page.getByRole('button', { name: '预览 横版封面.svg', exact: true }).count(), 2);
  await shot('updated-cards');
  check('update shown in new turn, existing preview refreshes, same file retains one tab');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await shot('dark-preference-reduced-motion');
  check('dark preference and reduced motion render without errors');
  await stop();
  requests = 0;
  await start();
  if (historical) await checkHistory('restart');
  await openChat(cid);
  await page.getByRole('button', { name: '预览 横版封面.svg', exact: true }).last().click(); await imageReady();
  assert.equal(requests, 0);
  check('restart restores file cards and reads files without model calls');
  if (sourceFile) assert.equal(Buffer.compare(fs.readFileSync(sourceFile), sourceBytes), 0);
  assert.deepEqual(report.errors, []);
  success = true;
} catch (error) {
  if (page && !page.isClosed()) {
    await shot('failure').catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure.txt'), `${error.stack}\n${await page.locator('body').innerText()}`);
  }
  throw error;
} finally {
  await stop();
  if (process.platform === 'darwin') {
    try { execFileSync(lsregister, ['-u', applicationFixture]); } catch { /* application may already be unregistered */ }
    fs.rmSync(applicationFixture, { recursive: true, force: true });
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify({ ...report, success, userData }, null, 2));
  if (success && process.env.HEMI_KEEP_DELIVERABLE_FIXTURE !== '1') fs.rmSync(userData, { recursive: true, force: true });
}
console.log(JSON.stringify({ success, mode, checks: report.checks.length, evidence }));
