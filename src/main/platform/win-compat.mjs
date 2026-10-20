/**
 * Windows 工程兼容原语（2026-10-09 移植自 ZCode 桌面版实测代码）。
 *
 * 职责边界：只做跨平台工程原语（进程树终止／spawn 语义／环境变量大小写／
 * 命令输出编码／cmd 方言／可执行文件发现），不碰 043 能力状态机——某能力
 * 在 Windows 是否可用仍由 backend-win32 按探针事实回答，本模块只给「启用
 * 之后怎么把事做对」的底层答案。
 *
 * 全部函数 platform/env/execFile 注入，mac 上单测即可覆盖 win 分支（无真机
 * CI 的口径；等价于 ZCode 的 global.TESTING_WINDOWS 手法，但按参数注入更直白）。
 *
 * 与 ZCode 原实现的三处有意差异：
 * - 输出解码用 Node 内置 TextDecoder（full-icu），不引入 iconv-lite；
 *   代价是 OEM 拉丁页（cp437/850）拿不到——返回 null 走 utf-8 兜底，中文页
 *   （gbk/gb18030/shift_jis/euc-kr/ibm866/big5）全覆盖，正是乱码痛点所在；
 * - chcp 探测用异步 execFile（ZCode 用 sync 版）——主进程有 ≥250ms 事件循环
 *   阻塞监控，同步起子进程会自己触发告警；
 * - locale 兜底默认编码：ZCode 猜 cp437，这里返回 null（不猜西文页）——
 *   纯 ASCII 输出下 utf-8 解码无损，混合输出猜错更糟。
 */
import { spawn } from 'node:child_process';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileDefault = promisify(execFileCb);

/* ───────────────────────── 信号与 spawn 语义 ───────────────────────── */

/** Windows 没有 SIGHUP；超时/中断的收殓信号集合按平台取。 */
export function signalSet(platform = process.platform) {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

/**
 * 子进程公共 spawn 选项。win 不 detached：负 pid 进程组杀法在 win 不可用，
 * 树终止改走 taskkill /T（见 terminateProcessTree）；windowsHide 防 cmd 窗口
 * 闪烁（posix 上是 no-op，统一设置无害）。extra 覆盖 cwd/env/stdio 等。
 */
export function childProcessOptions(platform = process.platform, extra = {}) {
  return {
    detached: platform !== 'win32',
    windowsHide: true,
    ...extra,
  };
}

/**
 * 终止整棵进程树（含 `cmd &` 拉起的后台子孙）。
 * - win32：`taskkill /pid <pid> /T /F`（/T 连树、/F 强杀）；taskkill 本身
 *   起不来（ENOENT 等）时兜底对 child 单发 kill('SIGKILL')（win 上映射
 *   TerminateProcess）；
 * - posix：进程组（detached spawn，组长＝pid）先 SIGTERM，child close 即收；
 *   宽限 graceMs 后组+组长双 SIGKILL 收殓残余。不持 child 时（只知 pid）
 *   只能等满宽限——调用方一般都持 child。
 * @param {object} opts
 * @param {string} opts.platform
 * @param {number} opts.pid 根进程 pid
 * @param {import('node:child_process').ChildProcess} [opts.child]
 * @param {Function} [opts.spawnImpl] 注入测试
 * @param {Function} [opts.killImpl] (target, signal) => void，缺省 process.kill
 * @param {number} [opts.graceMs] SIGTERM→SIGKILL 宽限
 * @returns {Promise<void>}
 */
export function terminateProcessTree({
  platform = process.platform,
  pid,
  child,
  spawnImpl = spawn,
  killImpl = (target, signal) => process.kill(target, signal),
  graceMs = 3000,
}) {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) throw new Error(`terminateProcessTree: 非法 pid ${pid}`);
  const tryKill = (target, signal) => {
    try {
      killImpl(target, signal);
      return true;
    } catch {
      return false; // 目标已退出
    }
  };

  if (platform === 'win32') {
    return new Promise((resolve) => {
      const tk = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      tk.once('error', () => {
        child?.kill('SIGKILL');
        resolve();
      });
      tk.once('close', () => resolve());
    });
  }

  return new Promise((resolve) => {
    if (child?.exitCode != null) {
      // 主进程已退，组内可能有后台残余：直接强杀收尾。
      tryKill(-pid, 'SIGKILL');
      tryKill(pid, 'SIGKILL');
      resolve();
      return;
    }
    tryKill(-pid, 'SIGTERM');
    tryKill(pid, 'SIGTERM');
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.removeListener('close', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      tryKill(-pid, 'SIGKILL');
      tryKill(pid, 'SIGKILL');
      finish();
    }, graceMs);
    child?.once('close', finish);
    if (!child) {
      // 无 child 可等：SIGKILL 发完即收，不等宽限。
      setImmediate(() => {
        tryKill(-pid, 'SIGKILL');
        tryKill(pid, 'SIGKILL');
        finish();
      });
    }
  });
}

/* ─────────────────── 环境变量大小写语义（win 不区分） ─────────────────── */

export function envGet(env, key, platform = process.platform) {
  if (platform !== 'win32') return env?.[key];
  const hit = Object.keys(env ?? {}).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? env[hit] : undefined;
}

/** win 上设键先清掉所有同 lowercase 的既有键（PATH/Path 只留一个）。 */
export function envSet(env, key, value, platform = process.platform) {
  if (platform !== 'win32') {
    env[key] = value;
    return env;
  }
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) delete env[k];
  }
  env[key] = value;
  return env;
}

/* ─────────────── 命令输出编码（中文 Windows 控制台是 GBK，不是 UTF-8） ─────────────── */

/** 解析 `chcp` 输出（"Active code page: 936"）→ 页号；认不出返回 null。 */
export function codePageFromChcpOutput(text) {
  const m = /(\d{3,5})/.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Windows 代码页 → TextDecoder 标签。未收录的页（含 cp437/850 等 OEM 拉丁页，
 * TextDecoder 不支持）返回 null——调用方按 utf-8 兜底，纯 ASCII 输出无损。
 */
const CP_TO_DECODER_LABEL = new Map([
  [65001, 'utf-8'],
  [936, 'gbk'],
  [54936, 'gb18030'],
  [932, 'shift_jis'],
  [949, 'euc-kr'],
  [950, 'big5'],
  [866, 'ibm866'],
  [874, 'windows-874'],
  [1250, 'windows-1250'],
  [1251, 'windows-1251'],
  [1252, 'windows-1252'],
  [1253, 'windows-1253'],
  [1254, 'windows-1254'],
  [1255, 'windows-1255'],
  [1256, 'windows-1256'],
  [1257, 'windows-1257'],
  [1258, 'windows-1258'],
]);

export function textDecoderLabelForCodePage(cp) {
  return CP_TO_DECODER_LABEL.get(cp) ?? null;
}

/**
 * 真机跑一次 `chcp` 探当前控制台代码页。任何失败（超时/非 win/解析不出）→ null。
 * 用 ComSpec 定位 cmd（win 环境变量大小写不敏感，走 envGet）。
 */
export async function readWindowsCodePage({
  env = process.env,
  execFile = execFileDefault,
  platform = process.platform,
  timeoutMs = 1500,
} = {}) {
  if (platform !== 'win32') return null;
  const shell = comSpecPath(env, 'win32');
  try {
    const { stdout } = await execFile(shell, cmdExecArgs('chcp'), {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env,
    });
    return codePageFromChcpOutput(stdout);
  } catch {
    return null;
  }
}

/**
 * chcp 探不到时的 locale 兜底：zh→gb18030（GBK 超集）、ja→shift_jis、
 * ko→euc-kr、ru→ibm866，其余不猜（null）。线索优先级 LC_ALL > LC_CTYPE >
 * LANG > 系统 locale（调用方注入，测试可桩）。
 */
export function fallbackDecoderLabelForLocale(env = process.env, resolvedLocale = '') {
  const clues = [
    envGet(env, 'LC_ALL', 'win32'),
    envGet(env, 'LC_CTYPE', 'win32'),
    envGet(env, 'LANG', 'win32'),
    resolvedLocale,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/(zh|chinese|cn|hans|hant)/.test(clues)) return 'gb18030';
  if (/(ja|japanese|jp)/.test(clues)) return 'shift_jis';
  if (/(ko|korean|kr)/.test(clues)) return 'euc-kr';
  if (/(ru|russian)/.test(clues)) return 'ibm866';
  return null;
}

const decoderCache = new Map();

function decoderFor(label) {
  if (!decoderCache.has(label)) {
    try {
      decoderCache.set(label, new TextDecoder(label));
    } catch {
      decoderCache.set(label, null);
    }
  }
  return decoderCache.get(label);
}

/**
 * 按标签解码子进程输出（非致命：坏字节落 U+FFFD，不抛错）。label 为 null 或
 * TextDecoder 不认识时按 utf-8。注意按整段 buffer 解——多字节字符被流式分块
 * 切开时，先收集完整段再解（沙箱命令是整段收集口径）。
 */
export function decodeChildOutput(buffer, label) {
  const decoder = (label && decoderFor(label)) || decoderFor('utf-8');
  return decoder.decode(buffer);
}

/** 一步到位：chcp 实测优先，探不到走 locale 兜底；非 win 平台恒 null（utf-8 世界）。 */
export async function resolveChildOutputDecoderLabel({
  platform = process.platform,
  env = process.env,
  execFile,
  resolvedLocale,
} = {}) {
  if (platform !== 'win32') return null;
  const cp = await readWindowsCodePage({ env, execFile, platform });
  const fromCp = cp === null ? null : textDecoderLabelForCodePage(cp);
  if (fromCp) return fromCp;
  return fallbackDecoderLabelForLocale(env, resolvedLocale ?? Intl.DateTimeFormat().resolvedOptions().locale);
}

/* ───────────────────────── cmd.exe 方言 ───────────────────────── */

/** 命令解释器路径：win 读 ComSpec（大小写不敏感）兜底 cmd.exe；posix 用 /bin/sh。 */
export function comSpecPath(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return '/bin/sh';
  return envGet(env, 'ComSpec', 'win32') ?? 'cmd.exe';
}

/**
 * cmd.exe 参数转义（ZCode 实测口径）：空串→`""`；含空白或 cmd 元字符
 * （`" % & ( ) < > ^ |`）→ 双引号包裹并把元字符逐一 `^` 转义（^ 在引号内仍生效）。
 */
export function quoteCmdArg(arg) {
  const s = String(arg);
  if (s.length === 0) return '""';
  if (!/[\s"%&()<>^|]/.test(s)) return s;
  return `"${s.replace(/(["%&()<>^|])/g, '^$1')}"`;
}

/** 经 cmd.exe 跑一条命令的参数：/d 跳过 AutoRun 注册表脚本、/s 保证引号解析。 */
export function cmdExecArgs(command) {
  return ['/d', '/s', '/c', command];
}

/* ─────────────────── 可执行文件发现（PATHEXT／PATH／Git Bash） ─────────────────── */

/** PATHEXT 扩展（小写、去重）；posix 恒 ['']（无扩展名语义）。 */
export function pathextExtensions(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return [''];
  const raw = envGet(env, 'PATHEXT', 'win32') ?? '.COM;.EXE;.BAT;.CMD';
  const list = raw
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : ['.com', '.exe', '.bat', '.cmd'];
}

/**
 * 解析命令名到候选绝对路径列表（按优先序，存在性由调用方核）。
 * - 绝对路径／含分隔符：原样（或按 cwd resolve）；win 上无扩展名补 PATHEXT 变体；
 * - 裸名：cwd 优先，再按序扫 PATH 各段 × PATHEXT 变体（win 的 PATH 键大小写不敏感）。
 */
export function executableCandidates(file, { env = process.env, cwd, platform = process.platform } = {}) {
  const w = platform === 'win32';
  const p = w ? path.win32 : path.posix;
  const exts = pathextExtensions(env, platform);
  // 无扩展名时带原样候选在前（Windows 对无扩展文件也尝试执行），再补 PATHEXT 变体。
  const variants = (base) => {
    if (p.extname(base)) return [base];
    const withExt = exts.filter(Boolean).map((e) => base + e);
    return withExt.length ? [base, ...withExt] : [base];
  };
  if (p.isAbsolute(file) || file.includes('/') || file.includes('\\')) {
    const base = p.isAbsolute(file) ? file : cwd ? p.resolve(cwd, file) : file;
    return variants(base);
  }
  const dirs = [
    cwd,
    ...(envGet(env, 'PATH', platform) ?? '').split(p.delimiter),
  ].filter(Boolean);
  return [...new Set(dirs.flatMap((d) => variants(p.join(d, file))))];
}

/**
 * 从一个已知存在的 Git 可执行路径反推 Git Bash 候选（ZCode 实测公式）：
 * git.exe 在 <git>\cmd 或 <git>\mingw64\bin 下，bash.exe 在 <git>\bin 与
 * <git>\usr\bin——上跳一/两级各拼一次 bin\bash.exe。
 */
export function gitBashCandidates(gitPath) {
  const dir = path.win32.dirname(gitPath);
  return [
    path.win32.normalize(path.win32.join(dir, '..', 'bin', 'bash.exe')),
    path.win32.normalize(path.win32.join(dir, '..', '..', 'bin', 'bash.exe')),
  ];
}
