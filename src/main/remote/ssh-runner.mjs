// 049 · SSH 传输层：远端工作区唯一的执行通道。
//
// 纪律（specs R-02/R-03、技术方案约束 1/3/5）：
// - 本机只以 argv 调用系统 ssh——绝不拼 shell 字符串；远端命令行经 shq() 单引号
//   转义拼装（路径一律转义），用户 bash 命令原样作为 `bash -c` 的参数传过去。
// - BatchMode=yes：不弹任何密码/指纹交互；认证全部交给系统 OpenSSH（用户的
//   ~/.ssh/config、密钥和 agent）。Hemi 不读取也不保存私钥或口令。
// - ControlMaster/ControlPath/ControlPersist 复用主连接：同一主机多次工具调用
//   只握手一次；ControlPath 目录在 userData 下（dev/生产隔离），权限 0700。
// - 退出码 255 一律按连接错误分类（hostkey/auth/timeout/unreachable），断线
//   语义由调用方按分类收束任务。
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** POSIX sh 单引号转义：值外面包一层单引号，内部单引号闭合再转义再重开。 */
export function shq(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/** SSH 目标（Host 别名或 user@host）合法性：argv 安全 + 无控制字符。 */
export function isValidSshTarget(host) {
  return /^[A-Za-z0-9_@.\-:[\]]+$/.test(String(host ?? '').trim()) && !String(host).trim().startsWith('-');
}

/**
 * ssh 失败分类（stderr 文本匹配；退出码 255 或本机无法启动）。
 * kinds：hostkey（指纹未确认/变化）、auth（认证失败）、timeout（连接超时）、
 * unreachable（不可达/无法解析/拒绝）、unknown。
 */
export function classifySshFailure(stderr, code) {
  const text = String(stderr ?? '');
  if (/host key verification failed|host key for .+ has changed|no matching host key/i.test(text)) return 'hostkey';
  if (/permission denied|authentication failed|no supported authentication|identity file .+ (invalid|not accessible)/i.test(text)) return 'auth';
  if (/connection timed out|connection attempt timed out|timed out/i.test(text)) return 'timeout';
  if (/could not resolve hostname|no route to host|network is (down|unreachable)|connection refused|connection reset by peer|connection closed by/i.test(text)) return 'unreachable';
  if (code === 'ENOENT') return 'no-ssh';
  return 'unknown';
}

const CONNECT_TIMEOUT_S = 10;

/** %C 的展开长度（sha1 十六进制）——ControlPath 总长必须留出这个空间。 */
const CONTROL_HASH_LEN = 40;
/** macOS unix 域套接字路径上限（sun_path 104）。 */
const MAX_SOCKET_PATH = 104;

/**
 * ControlPath 长度守卫（实测雷：userData 深路径 + %C 会超 104 字节，ssh 直接
 * 拒绝并报「ControlPath too long」——2026-10-10 S0 探针自测钓出）。超限时回落
 * 到 /tmp 下的短目录（sha256 前 8 位区分实例，保持 dev/生产隔离；0700）。
 * 纯函数，导出供单测。
 */
export function effectiveControlDir(controlDir, log = null) {
  const dir = String(controlDir ?? '');
  // 三种情形必须走 /tmp 短路径：① 含空格（ssh -o 解析不了）；② 超套接字上限；
  // ③ 路径里有单引号等 shell 特殊字符。/tmp 下 sha256 前 8 位区分实例。
  const needsShort = /[^A-Za-z0-9/_.\-]/.test(dir) || dir.length + 1 + CONTROL_HASH_LEN > MAX_SOCKET_PATH - 2;
  if (!needsShort) return dir;
  const short = `/tmp/hemi-ssh-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
  log?.info?.(`[ssh] ControlPath 走短目录 ${short}（原路径含空格或超长）`);
  return short;
}

/**
 * SSH 执行器工厂。
 * @param {object} deps
 * @param {string} deps.controlDir ControlMaster socket 目录（userData/ssh；自动建、0700）
 * @param {string} [deps.sshBin] ssh 可执行文件（测试注入假 ssh；缺省 'ssh'）
 * @param {Function} [deps.passwordProvider] (host) => string|null——密码模式下按主机
 *        取会话内存里的密码（remote-service 注入；null＝无密码，走密钥免密）
 * @param {object} [deps.log]
 */
export function createSshRunner({ controlDir, sshBin = 'ssh', passwordProvider = null, log = null }) {
  if (!controlDir) throw new Error('ssh-runner 缺少 controlDir');
  // ControlPath 长度守卫：深 userData + %C 超套接字上限时回落短目录（见函数注）。
  const socketDir = effectiveControlDir(controlDir, log);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  /** 已见主机（退出时逐个 `ssh -O exit`，不留主连接进程）。 */
  const seenHosts = new Set();

  function baseArgs(host, { password = null } = {}) {
    const args = [
      // 密码模式（2026-10-12 用户裁决：支持密码登录）：去 BatchMode，密码经
      // SSH_ASKPASS 助手喂给系统 ssh；主机指纹仍必须已在 known_hosts——
      // StrictHostKeyChecking=yes 让未知指纹硬失败（走「终端确认指纹」口径）。
      // 无密码时维持 BatchMode（密钥/agent 免密，未知指纹同样硬失败）。
      '-o', password ? 'StrictHostKeyChecking=yes' : 'BatchMode=yes',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${socketDir}/%C`,
      '-o', 'ControlPersist=10m',
      '-o', 'ServerAliveInterval=15',
      '-o', `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
      host,
    ];
    return args;
  }

  /**
   * SSH_ASKPASS 助手（密码模式）：OpenSSH ≥8.4 在 SSH_ASKPASS_REQUIRE=force 下
   * 经它取口令；密码本身经子进程环境 HEMI_SSH_PASSWORD 传入（不进 argv、不落盘）。
   */
  function ensureAskpassHelper() {
    const helper = path.join(socketDir, 'askpass.sh');
    try {
      writeFileSync(helper, '#!/bin/sh\nprintf %s "$HEMI_SSH_PASSWORD"\n', { encoding: 'utf8', mode: 0o700 });
      chmodSync(helper, 0o700);
      return helper;
    } catch {
      return null;
    }
  }

  /**
   * 在主机上执行一条远端命令（整条命令串由调用方用 shq 拼好）。
   * @param {object} input
   * @param {string} input.host SSH 目标
   * @param {string} input.command 远端 shell 命令串（经 shq 拼装）
   * @param {string|Buffer} [input.stdin] 写入远端命令 stdin 的内容
   * @param {number} [input.timeoutMs] 整体超时（缺省 120s；含连接）
   * @param {AbortSignal} [input.signal] 取消信号（工具层停止）
   * @param {Function} [input.onKill] 超时/取消时的远端清理钩子（如杀远端进程组），
   *        async，await 上限 5s，之后杀本机 ssh 进程
   * @param {string} [input.password] 显式密码（一次性；缺省按 passwordProvider(host) 取）
   * @returns {Promise<{code:number, stdout:Buffer, stderr:string, timedOut?:boolean,
   *            aborted?:boolean, connError?:string|null}>}
   */
  function exec({ host, command, stdin = null, timeoutMs = 120_000, signal = null, onKill = null, password = null }) {
    const target = String(host ?? '').trim();
    if (!isValidSshTarget(target)) {
      return Promise.resolve({ code: -1, stdout: Buffer.alloc(0), stderr: '', connError: 'invalid-host' });
    }
    seenHosts.add(target);
    const effectivePassword = password != null
      ? String(password)
      : (typeof passwordProvider === 'function' ? passwordProvider(target) : null);
    const askpassHelper = effectivePassword != null ? ensureAskpassHelper() : null;
    const childEnv = askpassHelper && effectivePassword != null
      ? {
          ...process.env,
          SSH_ASKPASS: askpassHelper,
          SSH_ASKPASS_REQUIRE: 'force',
          HEMI_SSH_PASSWORD: effectivePassword,
          DISPLAY: process.env.DISPLAY ?? ':0',
        }
      : process.env;
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          sshBin,
          [...baseArgs(target, { password: effectivePassword }), String(command ?? '')],
          { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv },
        );
      } catch (error) {
        resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(error?.message ?? error), connError: 'spawn-failed' });
        return;
      }
      const outChunks = [];
      let errText = '';
      let settled = false;
      let killReason = null; // 'timeout' | 'abort'
      let killGraceTimer = null;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killGraceTimer);
        const result = {
          code,
          stdout: Buffer.concat(outChunks),
          stderr: errText,
        };
        if (killReason === 'timeout') result.timedOut = true;
        if (killReason === 'abort') result.aborted = true;
        result.connError = code === 255 ? classifySshFailure(errText) : null;
        if (result.connError || code === 255) {
          log?.debug?.(`[ssh] ${target} 连接错误（${result.connError}）：${errText.split('\n')[0].slice(0, 160)}`);
        }
        resolve(result);
      };

      child.stdout.on('data', (chunk) => outChunks.push(chunk));
      child.stderr.on('data', (chunk) => { errText += chunk.toString('utf8'); });
      child.on('error', (error) => {
        if (error?.code === 'ENOENT') { finish(255); errText += '\nssh: command not found'; return; }
        finish(-1);
      });
      child.on('close', (code) => finish(code == null ? -1 : code));

      if (stdin != null) {
        child.stdin.on('error', () => {}); // 对端先退（命令失败）时 EPIPE 不许抛
        child.stdin.end(stdin);
      } else {
        child.stdin.end();
      }

      const terminate = async (reason) => {
        if (killReason) return;
        killReason = reason;
        // 先给远端清理钩子一次机会（杀远端进程组等），再杀本机 ssh。
        try {
          const capped = new Promise((resolveKill) => {
            const t = setTimeout(resolveKill, 5000);
            if (typeof t.unref === 'function') t.unref();
            Promise.resolve(onKill?.(reason)).finally(() => { clearTimeout(t); resolveKill(); });
          });
          await capped;
        } catch { /* 清理失败也要继续杀本地进程 */ }
        if (child.exitCode == null && !child.killed) child.kill('SIGKILL');
        // SIGKILL 后 close 事件负责收口；5s 仍没 close 就硬收。
        killGraceTimer = setTimeout(() => finish(-1), 5000);
        if (typeof killGraceTimer.unref === 'function') killGraceTimer.unref();
      };

      const timer = timeoutMs > 0 ? setTimeout(() => { void terminate('timeout'); }, timeoutMs) : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      signal?.addEventListener('abort', () => { clearTimeout(timer); void terminate('abort'); }, { once: true });
    });
  }

  /** 只读探测可重试一次（技术方案约束 4）。 */
  async function execReadOnly({ host, command, timeoutMs = 30_000, password = null }) {
    const first = await exec({ host, command, timeoutMs, password });
    if (first.code === 255 && first.connError && first.connError !== 'hostkey' && first.connError !== 'auth') {
      const second = await exec({ host, command, timeoutMs, password });
      return second;
    }
    return first;
  }

  /** 服务器上必须有的一组命令（specs「服务器上需要的命令」；不需要 Node）。 */
  const REQUIRED_TOOLS = ['bash', 'find', 'grep', 'realpath', 'ls'];

  /**
   * 探测目标与目录（添加登记 / 重试连接 / 任务发送前共用）：
   * 登录成功 → 拿远端 $HOME、目录真实路径（pwd -P）与命令支持矩阵。
   * @returns {Promise<{ok:true, host, realDir, remoteHome, tools}|{ok:false, kind, message}>}
   */
  async function probe({ host, dir, password = null }) {
    const target = String(host ?? '').trim();
    const rawDir = String(dir ?? '').trim();
    if (!isValidSshTarget(target)) {
      return { ok: false, kind: 'invalid-host', message: `服务器格式不对：填 SSH 配置里的 Host，或 user@host（收到「${target || '空'}」）` };
    }
    if (!rawDir || rawDir.startsWith('-')) {
      return { ok: false, kind: 'invalid-dir', message: '文件夹路径不能为空' };
    }
    // 远端先展开 ~（shq 单引号会让 ~ 保持字面）：~ 与 ~/… 按 $HOME 解析。
    const cmd = [
      `printf '__H49_HOME=%s\\n' "$HOME"`,
      `for c in ${REQUIRED_TOOLS.concat(['setsid', 'sha256sum', 'head', 'wc']).map((c) => shq(c)).join(' ')}; do command -v "$c" >/dev/null 2>&1 && printf '__H49_TOOL_%s=1\\n' "$c"; done`,
      `d=${shq(rawDir)}; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac;`,
      `if [ -d "$d" ]; then cd "$d" && printf '__H49_PWD=%s\\n' "$(pwd -P)"; else printf '__H49_NODIR=1\\n'; fi`,
    ].join('\n');
    const out = await execReadOnly({ host: target, command: cmd, timeoutMs: (CONNECT_TIMEOUT_S + 10) * 1000, password });
    if (out.code === 255 || out.connError) {
      const kind = out.connError ?? 'unknown';
      return { ok: false, kind, message: sshFailureCopy(kind, target), stderr: out.stderr };
    }
    if (out.code !== 0) {
      return { ok: false, kind: 'unknown', message: `探测命令失败（exit ${out.code}）：${out.stderr.split('\n')[0].slice(0, 160)}` };
    }
    const text = out.stdout.toString('utf8');
    const home = /^__H49_HOME=(.*)$/m.exec(text)?.[1] ?? null;
    const realDir = /^__H49_PWD=(.*)$/m.exec(text)?.[1] ?? null;
    if (text.includes('__H49_NODIR=1') || !realDir) {
      return { ok: false, kind: 'notfound', message: `服务器上没有这个文件夹：${rawDir}` };
    }
    const tools = {};
    for (const name of REQUIRED_TOOLS.concat(['setsid', 'sha256sum', 'head', 'wc'])) {
      tools[name] = text.includes(`__H49_TOOL_${name}=1`);
    }
    const missing = REQUIRED_TOOLS.filter((name) => !tools[name]);
    if (missing.length) {
      return { ok: false, kind: 'unsupported', message: `服务器环境缺少必要命令：${missing.join('、')}`, tools };
    }
    return { ok: true, host: target, realDir, remoteHome: home, tools };
  }

  /** 应用退出时关闭主连接（不留 ssh 进程，AC-03）。 */
  function close() {
    for (const host of seenHosts) {
      const exit = spawn(sshBin, ['-o', `ControlPath=${socketDir}/%C`, '-O', 'exit', host], { stdio: 'ignore' });
      exit.on('error', () => {});
    }
    seenHosts.clear();
  }

  return { exec, execReadOnly, probe, close, shq };
}

/** 连接错误分类 → 可操作的中文文案（终端修复方式；应用内不做指纹确认/密码输入）。 */
export function sshFailureCopy(kind, host) {
  switch (kind) {
    case 'hostkey':
      return `还没确认过 ${host} 的主机指纹。先在终端运行一次 ssh ${host} 并确认指纹，再回来重试。`;
    case 'auth':
      return `${host} 拒绝了登录（Permission denied）。先在终端运行 ssh ${host} 确认能免密登录，再回来重试。`;
    case 'timeout':
      return `连接 ${host} 超时。检查网络或 VPN 后重试。`;
    case 'unreachable':
      return `连不上 ${host}（无法解析主机名或网络不可达）。检查网络或 VPN 后重试。`;
    case 'no-ssh':
      return `本机找不到 ssh 命令。请先安装 OpenSSH（macOS 自带，检查 PATH）。`;
    default:
      return `连接 ${host} 失败，原因未能识别。可在终端运行 ssh ${host} 看具体报错。`;
  }
}

/** 本地占位：sha256（edit 写回前的并发修改比对用，与远端 sha256sum 同口径）。 */
export function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(String(text ?? ''), 'utf8')).digest('hex');
}
