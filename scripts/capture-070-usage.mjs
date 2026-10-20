// 070：真实模型、实际文档任务、生产用量账本截图；不生成或改写 usage。
// 仅复制加密模型配置、onboarding 与待审文档到独立 /tmp/hemi-070-real-*。
// HEMI_USER_DATA_DIR=<隔离目录> HEMI_SMOKE_TEST=1 HEMI_070_USAGE_RUN=1 \
//   npx electron scripts/capture-070-usage.mjs
// 不传 RUN 时，仅恢复该隔离会话并补拍；UI 驱动已获用户明确授权。
import { app, Menu, ipcMain } from 'electron';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { createMainWindow } from '../src/main/windows/main-window.mjs';
import { installNativeShell } from '../src/main/windows/native-shell.mjs';
import { state } from '../src/main/state.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';
import { getAgentRuntime } from '../src/main/ipc/llm.ipc.mjs';

const dataDir = path.resolve(process.env.HEMI_USER_DATA_DIR || '.');
if (!/^\/(?:private\/)?tmp\/hemi-070-real-/.test(dataDir)) throw Error('必须使用独立 /tmp/hemi-070-real-* userData');
app.setName('hemi'); app.setPath('userData', dataDir);
const out = path.resolve('.visual/workflow/vision/070-features');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = code => state.mainWindow.webContents.executeJavaScript(code);
const invoke = (channel, payload) => ipcMain._invokeHandlers.get(channel)({}, payload);
const manifest = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  boundary: 'real configured providers and real document review; no scripted responses or usage editing', errors: [],
};
const task = '请检查工作区中的 README.md、README.zh-CN.md 和 docs/media/screenshots/SOURCES.md，产出一份实际可用的中文 README 检查报告。先请侦察角色盘点双语四项特色及图片引用，再请顾问独立审阅两种语言的承诺是否一致、截图来源说明是否准确；你汇总后把报告写入工作区 readme-review.md。报告包含双语差异、图片引用检查、公开前应修改的具体建议，引用对应文件和段落。不要改输入文件，不联网搜索，不访问工作区以外的文件或应用；不需要读取 PNG 像素。任务重点是审阅当前内容，不用为了展示去调用无关角色。';
async function waitFor(code, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await exec(code)) return; await sleep(150); }
  throw Error('等待超时：' + label);
}
async function close(code = 0) {
  await writeFile(path.join(out, 'usage-real-capture.json'), JSON.stringify(manifest, null, 2));
  disposeTaskManager(); getAgentRuntime()?.disposeAll(); state.isQuitting = true; app.exit(code);
}
app.whenReady().then(async () => {
  await mkdir(out, { recursive: true });
  initializeStableSafeStorageIdentity(); await registerAllIpcHandlers();
  if (process.env.HEMI_070_USAGE_RUN === '1') {
    const saved = await invoke(IPC.llm.setLastConversationModel, { modelKey: 'auto' });
    if (!saved.ok) throw Error('自动路由选择未保存');
  }
  installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: false });
  await createMainWindow(); state.mainWindow.setSize(1100, 840);
  state.mainWindow.setTitle('Hemi README 检查'); state.mainWindow.show();
  state.mainWindow.webContents.on('console-message', event => { if (event.level === 'error') manifest.errors.push(event.message); });
  manifest.rendererUrl = state.mainWindow.webContents.getURL();
  manifest.rendererSha256 = hash(await readFile('dist-renderer/index.html'));
  await waitFor('!!document.querySelector("textarea[aria-label=输入消息]")', '对话入口');
  if (process.env.HEMI_070_USAGE_RUN === '1') {
    await waitFor('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="自动路由")', '自动路由就绪');
    await exec(`(() => { const e = document.querySelector('textarea[aria-label="输入消息"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, ${JSON.stringify(task)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor('[...document.querySelectorAll("button")].some(b=>!b.disabled&&b.getAttribute("aria-label")==="发送消息")', '可发送');
    await exec('[...document.querySelectorAll("button")].find(b=>!b.disabled&&b.getAttribute("aria-label")==="发送消息").click()');
    console.log('HEMI_070_REAL_TASK_SUBMITTED');
    const deadline = Date.now() + 600000;
    let progress = '', completed = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      const journal = await readFile(path.join(dataDir, 'runtime-v2/run-journal.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (!journal) continue;
      const roots = Object.values(journal.roots);
      const next = JSON.stringify({ requests: Object.keys(journal.requests).length, completedRoots: roots.filter(r=>r.status==='completed').length, roots: roots.length, terminalTasks: Object.keys(journal.tasks).length });
      if (next !== progress) { console.log('HEMI_070_REAL_PROGRESS ' + next); progress = next; }
      if (!roots.some(root=>root.policySnapshot) || roots.some(root=>!['completed','failed','cancelled'].includes(root.status))) continue;
      if (await exec('!!document.querySelector("button[aria-label=停止当前任务]")')) continue;
      await sleep(2000); completed = true; break;
    }
    if (!completed) throw Error('真实任务尚未收口，未拍摄');
    const report = await readFile(path.join(dataDir, 'workspace/default/readme-review.md'));
    if (report.length < 300 || !report.toString().includes('README')) throw Error('报告缺失或内容不足');
    manifest.report = { filename: 'readme-review.md', bytes: report.length, sha256: hash(report) };
    await writeFile(path.join(out, 'readme-review-real.md'), report);
  }
  const session = await invoke(IPC.conversation.last, {});
  if (!session?.id) throw Error('没有真实任务会话');
  manifest.conversationId = session.id;
  const ledger = await invoke(IPC.usage.getLedger, { conversationId: session.id });
  manifest.usage = ledger.records.map(({ role, requestedModel, input, output, cacheRead, cacheWrite, genMs, calls, missing, purpose, coverage }) => ({ role, requestedModel, input, output, cacheRead, cacheWrite, genMs, calls, missing, purpose, coverage }));
  if (!manifest.usage.some(r=>r.output>0&&r.missing!==1)) throw Error('没有供应商返回的实际用量');
  await waitFor('!!document.querySelector(".h48-usage-entry")', '真实用量入口');
  const point = await exec(`(() => { const r = document.querySelector('.h48-usage-entry').getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`);
  state.mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 100 }); await sleep(200);
  state.mainWindow.webContents.sendInputEvent({ type: 'mouseEnter', ...point });
  state.mainWindow.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  await waitFor('!!document.querySelector(".h48-usage-panel")?.getBoundingClientRect().width', '用量弹窗'); await sleep(700);
  const rect = await exec(`(() => { const r = document.querySelector('.h48-usage-panel').getBoundingClientRect(); return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
  manifest.panelText = await exec('document.querySelector(".h48-usage-panel").innerText');
  const full = await state.mainWindow.webContents.capturePage();
  await writeFile(path.join(out, 'feature-usage-real-full.png'), full.toPNG());
  const focused = await state.mainWindow.webContents.capturePage(rect); const bytes = focused.toPNG();
  await writeFile(path.join(out, 'feature-usage-real-focus.png'), bytes);
  manifest.screenshot = { rect, size: focused.getSize(), sha256: hash(bytes), capturedAt: new Date().toISOString() };
  console.log('HEMI_070_REAL_USAGE_CAPTURED ' + JSON.stringify({ calls: manifest.usage.length, screenshot: manifest.screenshot }));
  await close();
}).catch(async error => { manifest.error = error.message; console.error('HEMI_070_REAL_CAPTURE_ERROR ' + error.message); await close(1); });
