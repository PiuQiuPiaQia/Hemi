// 066 顶栏「打开工作区目录」真机验证：隔离 userData＋预置登记项目与会话档案
// （会话绑定 ws-verify066 → /tmp/hemi-066-project），真实 DOM 驱动产品闭环：
//   ① 绑定本机项目的会话顶栏出现 split 按钮（与「开始通话」并排）；
//   ② 主按钮（默认访达）点击 → Finder 真实打开该目录并置前＋hemi.log 留痕；
//   ③ 下拉菜单三项（menuitemradio）文案与勾选正确；
//   ④ 选「在终端中打开」→ Terminal 真实打开并置前＋默认方式落盘为 terminal＋主钮图标/文案切换；
//   ⑤ 目录被移走 → 失败 toast 如实报目录不可用（不静默）；
//   ⑥ 新建对话（默认空间）→ 按钮消失；
//   ⑦ 偏好经 readStoredConfig 重读仍是 terminal（跨重启口径的文件层证据）。
// 运行前先 build（脚本吃 dist-renderer 产物）：
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-066-ud npx electron scripts/verify-066-open-workspace.mjs
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');
const { readStoredConfig } = await import('../src/main/lib/config-store.mjs');

const PROJECT_DIR = '/tmp/hemi-066-project';
const log = createLogger('066-verify');
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
  console.log(`HEMI_066_RESULT=${JSON.stringify({ passed: results.every((item) => item.ok), checks: results })}`);
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

/** 当前最前台应用名（System Events；无障碍受阻时返回 null，不抛）。 */
const frontmostApp = async () => {
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
};

const waitForFrontmost = async (appName, timeoutMs = 12000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await frontmostApp()) === appName) return true;
    await sleep(300);
  }
  return false;
};

const logHas = async (userDataDir, needle) => {
  try {
    const raw = await readFile(path.join(userDataDir, 'hemi.log'), 'utf8');
    return raw.includes(needle);
  } catch {
    return false;
  }
};

const waitForLog = async (userDataDir, needle, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await logHas(userDataDir, needle)) return true;
    await sleep(300);
  }
  return false;
};

app.setName('hemi');
const userDataDir = path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-066-ud');
await rm(userDataDir, { recursive: true, force: true });
await rm(PROJECT_DIR, { recursive: true, force: true });
app.setPath('userData', userDataDir);

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    const now = Date.now();
    await mkdir(path.join(userDataDir, 'conversations'), { recursive: true });
    await mkdir(PROJECT_DIR, { recursive: true });
    await writeFile(path.join(PROJECT_DIR, 'marker.txt'), '066 验证项目\n', 'utf8');
    await writeFile(
      path.join(userDataDir, 'workspaces.json'),
      JSON.stringify(
        {
          version: 1,
          projects: [
            { id: 'ws-verify066', name: '验证项目', dir: PROJECT_DIR, createdAt: now - 60_000, lastUsedAt: now - 30_000 },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(userDataDir, 'conversations', 'conv-verify-066.json'),
      JSON.stringify({
        version: 1,
        id: 'conv-verify-066',
        title: '066 打开入口验证',
        createdAt: now - 60_000,
        updatedAt: now - 30_000,
        workspaceId: 'ws-verify066',
        turns: [
          { id: 't-1', text: '这个会话绑定验证项目', createdAt: now - 60_000, author: 'user', inputSource: 'text' },
          { id: 't-2', text: '好的，用顶栏按钮打开这个项目看看。', createdAt: now - 30_000, author: 'hemi' },
        ],
      }),
    );
    await writeFile(
      path.join(userDataDir, 'onboarding.json'),
      `${JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'granted', updatedAt: now, completedAt: now })}\n`,
    );

    registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: !app.isPackaged, openExternal: openExternalIfAllowed });
    await createMainWindow();
    await sleep(1200);

    // ① 绑定项目的会话：顶栏出现 split 按钮，与「开始通话」并排。
    const appeared = await waitFor(
      `Boolean(document.querySelector('.bar-actions .h65-open-main') && document.querySelector('.bar-actions .h65-open-more'))`,
      '顶栏 split 按钮',
    );
    check('AC-01 绑定本机项目的会话顶栏出现 split 按钮', appeared);
    if (!appeared) return finish(1);
    const withCall = (await exec(`Boolean(document.querySelector('.bar-actions .h24-call-nav'))`)) === true;
    check('AC-01 与「开始通话」按钮并排（不互相挤掉）', withCall);

    // ② 主按钮默认方式＝访达；点击后 Finder 真实打开该目录并置前。
    const titleBefore = await exec(`document.querySelector('.h65-open-main')?.title ?? ''`);
    check('AC-03 主按钮默认方式为访达（title 文案）', String(titleBefore).includes('访达') && String(titleBefore).includes('验证项目'), titleBefore);
    await exec(`document.querySelector('.h65-open-main').click()`);
    const finderFront = await waitForFrontmost('Finder');
    check('AC-03 点击主按钮 → Finder 置前（真实打开）', finderFront, `frontmost=${await frontmostApp()}`);
    const finderLogged = await waitForLog(userDataDir, '066 工作区已按 finder 打开');
    check('AC-03 主进程留痕（hemi.log）', finderLogged);

    // ③ 下拉菜单：三项文案＋默认勾选。
    await exec(`document.querySelector('.h65-open-more').click()`);
    const menuOk = await waitFor(`Boolean(document.querySelector('.h37-menu [role="menuitemradio"]'))`, '方式菜单展开');
    const labels = menuOk
      ? await exec(`Array.from(document.querySelectorAll('.h37-menu [role="menuitemradio"]')).map((el) => el.textContent.trim())`)
      : [];
    const labelsOk =
      Array.isArray(labels) &&
      labels.length === 3 &&
      String(labels[0]).includes('访达') &&
      String(labels[1]).includes('终端') &&
      String(labels[2]).includes('VS Code');
    check('AC-04 菜单列出三种方式（访达/终端/VS Code）', labelsOk, JSON.stringify(labels));
    const checkedLabel = await exec(
      `document.querySelector('.h37-menu [role="menuitemradio"][aria-checked="true"]')?.textContent.trim() ?? ''`,
    );
    check('AC-04 当前默认（访达）带勾选', String(checkedLabel).includes('访达'), checkedLabel);

    // ④ 选「在终端中打开」：立即打开＋成为新默认＋落盘＋主钮切换。
    await exec(
      `(function () {
        const items = Array.from(document.querySelectorAll('.h37-menu [role="menuitemradio"]'));
        const terminal = items.find((el) => el.textContent.includes('终端'));
        if (terminal) terminal.click();
        return terminal ? 'clicked' : 'missing';
      })()`,
    );
    const terminalFront = await waitForFrontmost('Terminal');
    check('AC-05 选终端 → Terminal 置前（真实打开）', terminalFront, `frontmost=${await frontmostApp()}`);
    const terminalLogged = await waitForLog(userDataDir, '066 工作区已按 terminal 打开');
    check('AC-05 主进程留痕（hemi.log）', terminalLogged);
    await sleep(600);
    const titleAfter = await exec(`document.querySelector('.h65-open-main')?.title ?? ''`);
    check('AC-05 主按钮切换为终端（图标与文案）', String(titleAfter).includes('终端'), titleAfter);
    let storedTarget = '';
    try {
      const stored = JSON.parse(await readFile(path.join(userDataDir, 'doubao-asr.json'), 'utf8'));
      storedTarget = stored.workspaceOpenTarget ?? '';
    } catch {
      storedTarget = '(读档失败)';
    }
    check('AC-06 默认方式落盘（doubao-asr.json workspaceOpenTarget=terminal）', storedTarget === 'terminal', storedTarget);
    const reread = await readStoredConfig();
    check('AC-06 readStoredConfig 重读保持 terminal（跨重启文件层证据）', reread.workspaceOpenTarget === 'terminal', reread.workspaceOpenTarget);

    // ⑤ 目录被移走：点击如实失败（toast），不静默、不改道。
    await rename(PROJECT_DIR, `${PROJECT_DIR}.bak`);
    await sleep(300);
    await exec(`document.querySelector('.h65-open-main').click()`);
    const failToast = await waitFor(`Boolean(document.querySelector('.h37-toast-card[data-tone="err"]'))`, '失败 toast', 6000);
    const toastText = failToast ? await exec(`document.querySelector('.h37-toast-card')?.textContent.trim() ?? ''`) : '';
    check('AC-07 目录失效弹失败 toast（不静默）', failToast && /目录|连不上|不存在/.test(String(toastText)), toastText);
    await rename(`${PROJECT_DIR}.bak`, PROJECT_DIR);

    // ⑥ 新建对话回到默认空间：按钮消失。
    const menuClosed = await waitFor(`Boolean(!document.querySelector('.h37-menu [role="menuitemradio"]'))`, '菜单收起', 4000);
    if (!menuClosed) await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await exec(`document.querySelector('.h24-sidebar-new')?.click()`);
    const gone = await waitFor(`Boolean(!document.querySelector('.bar-actions .h65-open-main'))`, '新建对话后按钮消失');
    check('AC-02 默认空间会话不出现按钮', gone);

    finish(results.every((item) => item.ok) ? 0 : 1);
  } catch (error) {
    log.warn(`验证脚本异常：${error?.stack ?? error}`);
    check('脚本无异常', false, error?.message);
    finish(1);
  }
});
