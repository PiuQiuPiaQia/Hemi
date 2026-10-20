// 主窗口尺寸保留真机验证：真实 Electron 实例调整→退出→重开，
// 断言防抖落盘、退出补存、无记录默认、最大化还原尺寸四条路径。
// 不聊天、不依赖模型 Key；只复制 onboarding.json 过引导闸。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mainWindowSizeFor } from '../src/main/windows/main-window-size.mjs';

const runtime = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { _electron } = await import(pathToFileURL(runtime).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-window-state-'));
const ud = path.join(root, 'userData');
fs.mkdirSync(ud, { recursive: true });
const realUd = path.join(os.homedir(), 'Library/Application Support/hemi-dev');
if (fs.existsSync(path.join(realUd, 'onboarding.json'))) {
  fs.copyFileSync(path.join(realUd, 'onboarding.json'), path.join(ud, 'onboarding.json'));
}
const stateFile = path.join(ud, 'window-state.json');

const wait = async (fn, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
};

// 主窗口判别与 verify-060 同口径：http/file 且无 ?mode= 的页面所在窗口。

let electron;
const checks = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };

async function launch() {
  electron = await _electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: ['.'],
    env: { ...process.env, HEMI_USER_DATA_DIR: ud },
  });
  await wait(() => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .some((w) => { try { const url = new URL(w.webContents.getURL()); return /^(http|file):$/.test(url.protocol) && !url.searchParams.has('mode') && w.isVisible(); } catch { return false; } })), '主窗口可见');
}

async function stopApp() {
  const proc = electron.process();
  const exited = new Promise((resolve) => { proc.once('exit', resolve); setTimeout(resolve, 15000); });
  try { await electron.evaluate(({ app }) => app.quit()); } catch { /* 已随窗口关闭退出 */ }
  await exited;
  try { await electron.close(); } catch { /* 连接随进程回收 */ }
  electron = null;
}

const mainInfo = () => electron.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) => { try { const url = new URL(w.webContents.getURL()); return /^(http|file):$/.test(url.protocol) && !url.searchParams.has('mode'); } catch { return false; } });
  return win ? { bounds: win.getBounds(), normal: win.getNormalBounds(), maximized: win.isMaximized() } : null;
});

const setMainBounds = (bounds) => electron.evaluate(({ BrowserWindow }, b) => {
  const win = BrowserWindow.getAllWindows().find((w) => { try { const url = new URL(w.webContents.getURL()); return /^(http|file):$/.test(url.protocol) && !url.searchParams.has('mode'); } catch { return false; } });
  if (!win) throw new Error('主窗口不在场');
  win.setBounds(b);
  return win.getBounds();
}, bounds);

const mainAction = (action) => electron.evaluate(({ BrowserWindow }, act) => {
  const win = BrowserWindow.getAllWindows().find((w) => { try { const url = new URL(w.webContents.getURL()); return /^(http|file):$/.test(url.protocol) && !url.searchParams.has('mode'); } catch { return false; } });
  if (!win) throw new Error('主窗口不在场');
  if (act === 'maximize') win.maximize();
  if (act === 'unmaximize') win.unmaximize();
  return { maximized: win.isMaximized(), bounds: win.getBounds(), normal: win.getNormalBounds() };
}, action);

const near = (actual, expected, label, tolerance = 2) => {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance, `${label}：${key} 实际 ${actual[key]} 期望 ~${expected[key]}（±${tolerance}）`);
  }
};

try {
  // 第 1 轮：无记录 → 等比例默认；手动调整后防抖落盘。
  await launch();
  const workArea = await electron.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const expectedDefault = mainWindowSizeFor(workArea);
  const first = await mainInfo();
  near(first.bounds, {
    x: Math.round(workArea.x + (workArea.width - expectedDefault.width) / 2),
    y: Math.round(workArea.y + (workArea.height - expectedDefault.height) / 2),
    ...expectedDefault,
  }, '无记录时按等比例默认开窗');
  check('无记录回退等比例默认（居中）');

  // 测试值按当前工作区取整，保证完整可见（否则恢复时按契约夹回、断言就不是原值）。
  const A = { x: workArea.x + 100, y: workArea.y + 60, width: 900, height: 650 };
  near(await setMainBounds(A), A, '调整尺寸 A');
  await new Promise((resolve) => setTimeout(resolve, 1600)); // 防抖 800ms + 落盘
  const savedA = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  near(savedA.bounds, A, '防抖落盘内容');
  assert.equal(savedA.maximized, false);
  assert.equal(savedA.version, 1);
  check('拖拽/缩放后 800ms 防抖落盘 window-state.json');
  await stopApp();

  // 第 2 轮：重开恢复 A；再调整后立刻退出（防抖未到期）→ 只能靠退出补存。
  await launch();
  near((await mainInfo()).bounds, A, '重启后恢复尺寸 A');
  check('重启后恢复上次尺寸与位置');

  const B = { x: workArea.x + 60, y: workArea.y + 120, width: 1230, height: Math.min(700, workArea.height - 140) };
  await setMainBounds(B);
  await stopApp(); // 不等防抖：真退出路径（before-quit → close）补存
  const savedB = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  near(savedB.bounds, B, '退出补存内容');
  check('退出时补存（防抖未到期的调整不丢）');

  // 第 3 轮：恢复 B 后最大化——存还原尺寸＋maximized 标记。
  await launch();
  near((await mainInfo()).bounds, B, '重启后恢复尺寸 B');
  check('两次调整后的最终值恢复');
  const zoomed = await mainAction('maximize');
  assert.equal(zoomed.maximized, true, '最大化生效');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const savedZoom = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(savedZoom.maximized, true);
  near(savedZoom.bounds, B, '最大化时保存还原尺寸');
  check('最大化保存还原尺寸与标记');
  await stopApp();

  // 第 4 轮：重开应直接最大化，还原尺寸仍是 B；取消最大化回到原位。
  await launch();
  await wait(async () => (await mainInfo())?.maximized === true, '重开最大化', 8000);
  const restored = await mainInfo();
  near(restored.normal, B, '最大化态的还原尺寸');
  check('重启后恢复最大化状态');
  const back = await mainAction('unmaximize');
  assert.equal(back.maximized, false);
  near(back.bounds, B, '取消最大化回到原尺寸');
  check('取消最大化回到原位');
  await stopApp();

  // 第 5 轮：记录越出当前工作区（换屏/改分辨率后的旧档）→ 恢复时夹回完整可见。
  const C = { x: workArea.x + workArea.width - 200, y: workArea.y + workArea.height - 100, width: 900, height: 650 };
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, bounds: C, maximized: false }));
  await launch();
  const clamped = (await mainInfo()).bounds;
  for (const key of ['x', 'y']) {
    assert.ok(clamped[key] >= workArea[key] - 2, `夹回后 ${key}=${clamped[key]} 不小于工作区 ${key}=${workArea[key]}`);
  }
  assert.ok(clamped.x + clamped.width <= workArea.x + workArea.width + 2, `夹回后右缘 ${clamped.x + clamped.width} 在工作区内`);
  assert.ok(clamped.y + clamped.height <= workArea.y + workArea.height + 2, `夹回后下缘 ${clamped.y + clamped.height} 在工作区内`);
  check('越界旧档夹回当前工作区完整可见');
  await stopApp();

  console.log(`HEMI_WINDOW_STATE_RESULT ${JSON.stringify({ pass: checks.length, checks, userData: ud })}`);
  process.exit(0);
} catch (error) {
  console.error(`FAIL ${error?.message ?? error}`);
  try { await electron?.evaluate(({ app }) => app.quit()); } catch { /* 尽力退出 */ }
  try { await electron?.close(); } catch { /* 连接可能已断 */ }
  process.exit(1);
}
