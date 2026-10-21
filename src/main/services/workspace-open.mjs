// 066 · 顶栏「打开工作区目录」执行器：访达/资源管理器、终端、VS Code。
//
// 只做「把一个已存在的本机目录交给系统应用打开」；工作区身份解析、远端拒绝、
// 目录存在性都在 IPC 层（workspace.ipc）完成。平台分支按注入 platform 可测，
// 不 import electron——shell.openPath 与 child_process.spawn 全部注入。
//
// 跨平台口径（Windows 真机矩阵未跑，行为以代码评审＋注入测试为准）：
// - 文件管理器统一走 shell.openPath（mac 访达 / win 资源管理器 / linux xdg-open）。
// - 终端：win 优先 wt.exe（Windows 10 1809+ 自带），没装再退 cmd.exe 新控制台
//   （GUI 父进程下 console 子进程会开自己的窗口，cwd 即工作区目录）。
// - VS Code：win 按常见安装路径探测 Code.exe，再退 PATH 里的 code；
//   mac 优先 open -a（GUI 应用 PATH 很短，`code` CLI 不可靠），失败再试常见 CLI 路径。
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';

/** Registered workspaces retain their identity; legacy chats use the host's real home directory. */
export function workspaceViewForOpen(store, id, { home = os.homedir() } = {}) {
  if (id !== 'legacy-home') return store.resolve(id);
  const view = { id: 'legacy-home', type: 'default', name: '家目录', dir: home };
  try {
    const dir = realpathSync(home);
    if (statSync(dir).isDirectory()) return { ...view, dir, status: 'ok' };
  } catch { /* report the actual unavailable location */ }
  return { ...view, status: 'missing', message: '家目录不可用' };
}

export const WORKSPACE_OPEN_TARGETS = ['finder', 'terminal', 'vscode'];

/** 偏好与请求参数的统一归一：未知值回落 finder（顶栏主按钮的默认方式）。 */
export function normalizeOpenTarget(value) {
  return WORKSPACE_OPEN_TARGETS.includes(value) ? value : 'finder';
}

/** spawn 包装：一次成败（error 与 close 竞态由 Promise 只结算一次兜住）。 */
function run(spawnFn, command, args, { detached = false, cwd = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, {
        stdio: 'ignore',
        detached,
        ...(cwd ? { cwd } : {}),
      });
      if (detached && typeof child.unref === 'function') child.unref();
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    child.on('error', (error) => resolve({ ok: false, error: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

/** macOS GUI PATH 只有 /usr/bin:/bin:…——CLI 候选显式列常见安装位。 */
const DARWIN_CODE_CLI_CANDIDATES = ['/usr/local/bin/code', '/opt/homebrew/bin/code'];

/** win32 VS Code 安装位（按用户级 → Program Files → x86 顺序探测）。 */
function windowsCodeCandidates(env) {
  const local = env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe` : null;
  const pf64 = env.ProgramFiles ? `${env.ProgramFiles}\\Microsoft VS Code\\Code.exe` : null;
  const pf86 = env['ProgramFiles(x86)'] ? `${env['ProgramFiles(x86)']}\\Microsoft VS Code\\Code.exe` : null;
  return [local, pf64, pf86].filter(Boolean);
}

export function createWorkspaceOpener({
  platform = process.platform,
  openPath,
  spawnFn = spawn,
  env = process.env,
} = {}) {
  if (typeof openPath !== 'function') throw new Error('workspace-open 缺少 openPath 注入');

  async function openInFileManager(dir) {
    const message = await openPath(dir);
    // Electron 约定：成功返回 ''，失败返回错误文案。
    return message ? { ok: false, kind: 'open-failed', message: `文件管理器没打开：${message}` } : { ok: true };
  }

  async function openInTerminal(dir) {
    if (platform === 'darwin') {
      const result = await run(spawnFn, 'open', ['-a', 'Terminal', dir]);
      return result.ok ? { ok: true } : { ok: false, kind: 'open-failed', message: `终端没打开：${result.error ?? `exit ${result.code}`}` };
    }
    if (platform === 'win32') {
      const wt = await run(spawnFn, 'wt.exe', ['-d', dir], { detached: true });
      if (wt.ok) return { ok: true };
      // wt 不可用（未装/启动失败）→ cmd 新控制台；cwd 即工作区，绕开 start 的引号泥潭。
      const cmd = await run(spawnFn, 'cmd.exe', ['/k'], { detached: true, cwd: dir });
      return cmd.ok
        ? { ok: true }
        : { ok: false, kind: 'open-failed', message: `终端没打开：${cmd.error ?? `exit ${cmd.code}`}` };
    }
    // linux（非发行目标，尽力而为）：逐个常见终端试过去。
    const candidates = [
      ['gnome-terminal', ['--working-directory', dir]],
      ['konsole', ['--workdir', dir]],
      ['xfce4-terminal', ['--working-directory', dir]],
    ];
    for (const [command, args] of candidates) {
      const result = await run(spawnFn, command, args, { detached: true });
      if (result.ok) return { ok: true };
    }
    return { ok: false, kind: 'open-failed', message: '终端没打开：没找到可用的终端程序' };
  }

  async function openInVsCode(dir) {
    if (platform === 'darwin') {
      const viaApp = await run(spawnFn, 'open', ['-a', 'Visual Studio Code', dir]);
      if (viaApp.ok) return { ok: true };
      for (const cli of DARWIN_CODE_CLI_CANDIDATES) {
        const result = await run(spawnFn, cli, [dir], { detached: true });
        if (result.ok) return { ok: true };
      }
      return { ok: false, kind: 'not-found', message: '没找到 VS Code：应用未安装，命令行工具也不可用' };
    }
    if (platform === 'win32') {
      for (const exe of windowsCodeCandidates(env)) {
        const result = await run(spawnFn, exe, [dir], { detached: true });
        if (result.ok) return { ok: true };
      }
      // 安装位都没有 → 试 PATH 里的 code（code.cmd 需经 cmd 壳解析）。
      const viaPath = await run(spawnFn, 'cmd.exe', ['/d', '/c', 'code', dir], { detached: true });
      return viaPath.ok
        ? { ok: true }
        : { ok: false, kind: 'not-found', message: '没找到 VS Code：常见安装位置和 PATH 里都没有' };
    }
    const result = await run(spawnFn, 'code', [dir], { detached: true });
    return result.ok
      ? { ok: true }
      : { ok: false, kind: 'not-found', message: '没找到 VS Code：PATH 里没有 code 命令' };
  }

  /** 统一入口：target 归一后按平台分发；结果只带 ok/kind/message，不含路径。 */
  async function openDir(target, dir) {
    const normalized = normalizeOpenTarget(target);
    if (normalized === 'terminal') return openInTerminal(dir);
    if (normalized === 'vscode') return openInVsCode(dir);
    return openInFileManager(dir);
  }

  return { openDir };
}
