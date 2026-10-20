// 2026-10-08 复制反馈验证（用户反馈「很多地方缺 toast，比如会话的复制按钮」）：
// 隔离 userData＋预置一条会话档案（用户消息＋Hemi 回复），真实 DOM 点消息上的
// 复制按钮——断言三件事：① 出现 h37-toast-card 且文案「已复制」；② 主进程
// 剪贴板内容＝消息原文（复制走 system:copy-text 桥——此前 navigator.clipboard
// 被权限闸门拦，复制整体是坏的）；③ 用户消息与 Hemi 回复两条路径都过。
// 运行：HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-ct-ud npx electron scripts/verify-copy-toast.mjs
import { app, clipboard } from 'electron';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');

const USER_TEXT = '帮我把这段原样复制出去';
const HEMI_TEXT = '好的，这条回复用来验证复制链路。';
const log = createLogger('ct-verify');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
};
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  console.log(`HEMI_COPY_TOAST_RESULT=${JSON.stringify({ passed: results.every((item) => item.ok) })}`);
  setTimeout(() => app.exit(code), 400);
};

const exec = (code, ms = 8000) => {
  const contents = appState.mainWindow.webContents;
  return Promise.race([
    contents.executeJavaScript(code),
    new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms)),
  ]).catch((error) => `__error__:${error?.message}`);
};

const waitFor = async (predicateScript, label, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await exec(predicateScript)) === true) return true;
    await sleep(200);
  }
  log.warn(`等待超时：${label}`);
  return false;
};

/** 剪贴板读取（本版 Electron 的 readText 回 Promise，统一 await＋String 化）。 */
const clipboardText = async () => String((await clipboard.readText()) ?? '');

/** 点指定消息的复制钮 → 轮询等 toast 出现（复制走 IPC 异步）→ 返回文案。 */
const copyAndReadToast = async (messageSelector, label) => {
  const clicked = await exec(`(function () {
    const msg = document.querySelector(${JSON.stringify(messageSelector)});
    const btn = msg && msg.querySelector('button.h24-msg-copy');
    if (!btn) return 'missing';
    btn.click();
    return 'clicked';
  })()`);
  if (clicked !== 'clicked') return `按钮没找到（${label}）`;
  const appeared = await waitFor(`Boolean(document.querySelector('.h37-toast-card'))`, 'toast 出现', 4000);
  if (!appeared) return 'missing';
  const toastText = await exec(`(function () {
    const toast = document.querySelector('.h37-toast-card');
    return toast ? (toast.textContent ?? '').trim() : null;
  })()`);
  return toastText ?? 'missing';
};

app.setName('hemi');
const userDataDir = path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-ct-ud');
await rm(userDataDir, { recursive: true, force: true });
app.setPath('userData', userDataDir);

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    const now = Date.now();
    await mkdir(path.join(userDataDir, 'conversations'), { recursive: true });
    await writeFile(
      path.join(userDataDir, 'conversations', 'conv-verify-copy.json'),
      JSON.stringify({
        version: 1,
        id: 'conv-verify-copy',
        title: '复制验证会话',
        createdAt: now - 60_000,
        updatedAt: now - 30_000,
        turns: [
          { id: 't-1', text: USER_TEXT, createdAt: now - 60_000, author: 'user', inputSource: 'text' },
          { id: 't-2', text: HEMI_TEXT, createdAt: now - 30_000, author: 'hemi' },
        ],
      }),
    );
    await writeFile(
      path.join(userDataDir, 'onboarding.json'),
      `${JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'granted', updatedAt: now, completedAt: now })}\n`,
    );

    await registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: !app.isPackaged, openExternal: openExternalIfAllowed });
    await createMainWindow();
    await sleep(1200);

    const ready = await waitFor(
      `Boolean(document.querySelector('.h24-hemi-message') && document.querySelector('.h24-user-message'))`,
      '会话消息渲染',
    );
    check('预置会话铺回对话流', ready);
    if (!ready) return finish(1);

    // Hemi 回复的复制。
    const hemiToast = await copyAndReadToast('.h24-hemi-message', 'hemi');
    check('回复复制弹 toast「已复制」', hemiToast === '已复制', hemiToast);
    check('剪贴板内容＝回复原文（走桥复制）', (await clipboardText()) === HEMI_TEXT, (await clipboardText()).slice(0, 40));
    await waitFor(`Boolean(!document.querySelector('.h37-toast-card'))`, 'toast 消退', 6000);

    // 用户消息的复制（旧 toast 已消退，新的应重新出现）。
    const userToast = await copyAndReadToast('.h24-user-message', 'user');
    check('消息复制弹 toast「已复制」', userToast === '已复制', userToast);
    check('剪贴板内容＝消息原文（走桥复制）', (await clipboardText()) === USER_TEXT, (await clipboardText()).slice(0, 40));

    finish(results.every((item) => item.ok) ? 0 : 1);
  } catch (error) {
    log.warn(`验证脚本异常：${error?.stack ?? error}`);
    check('脚本无异常', false, error?.message);
    finish(1);
  }
});
