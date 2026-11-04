/**
 * 草稿资产上挂加固（v0.2.59 CI41816791105：Windows job 的
 * `gh release upload --clobber` 删除旧资产 709101156 后遭 HTTP 502，
 * exe 丢失、整轮打包被迫重建）。
 *
 * 只包一层有界重试，mac bash 与 win pwsh 经 scripts/upload-draft-assets.mjs 共用：
 * - 仅「确认的 HTTP 500/502/503/504」重试，最多 3 次上挂、有限短延迟；
 *   每次重试传同一批已生成且不变的文件（同一 argv）。
 * - 每次产生资产副作用（upload --clobber）前，必须用
 *   `gh release view TAG --json isDraft` 核实仍是草稿；非草稿或核实失败
 *   立即停止，绝不覆盖已正式发布的资产。核实本身不重试。
 * - spawn ENOENT/超时/被信号/HTTP 403/其他非确认 5xx：一律不重试，
 *   返回真实非 0 退出码（ENOENT 127、超时 124、信号 128+n、其余透传 gh）。
 * - gh 参数保持数组，不经 shell 拼接或 eval；环境原样继承（GH_TOKEN 由
 *   调用方注入，本模块不读任何凭据文件）。
 */
import { spawn } from 'node:child_process';

/** 唯一允许重试的服务端错误（gh 输出里的 `HTTP 5xx` 字样为准）。 */
export const RETRYABLE_HTTP_STATUSES = [500, 502, 503, 504];
/** 最多 3 次上挂（含首次），用尽即失败。 */
export const DEFAULT_MAX_UPLOAD_ATTEMPTS = 3;
/** 重试间隔：首次失败后 5s，第二次失败后 15s。 */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000];
/** `gh release view`（读操作）的硬时限。 */
export const VIEW_TIMEOUT_MS = 60_000;
/** `gh release upload`（上传 ~100MB 安装包）的硬时限。 */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

const KILL_GRACE_MS = 5_000;
const SIGNAL_EXIT_BASE = 128;
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

const HTTP_STATUS_RE = /HTTP[ \t]+(\d{3})\b/gi;

function truncate(text, max = 400) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 校验 tag 与文件列表（在产生任何副作用之前拒绝）。 */
export function validateUploadArgs(tag, files) {
  if (typeof tag !== 'string' || !tag.trim()) throw new Error('缺 tag 参数');
  if (tag.startsWith('-')) throw new Error(`tag 不能以 - 开头（会被当成 gh 旗标）：${tag}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('至少要有一个资产文件');
  for (const file of files) {
    if (typeof file !== 'string' || !file.trim()) throw new Error(`资产路径必须是非空字符串：${JSON.stringify(file)}`);
    if (file.startsWith('-')) throw new Error(`资产路径不能以 - 开头（会被当成 gh 旗标）：${file}`);
  }
}

/**
 * 把一次 run 结果归类：是否可重试、最终退出码、人类可读原因。
 * 退出码约定：ENOENT 127、EACCES 126、超时 124、信号 128+n、gh 自身退出码透传。
 */
export function classifyRunFailure(result) {
  if (result.error === 'ENOENT') {
    return { retryable: false, exitCode: 127, reason: '外部命令启动失败（spawn ENOENT，gh 不在 PATH）' };
  }
  if (result.error === 'EACCES') {
    return { retryable: false, exitCode: 126, reason: '外部命令无执行权限（spawn EACCES）' };
  }
  if (result.error) {
    return { retryable: false, exitCode: 125, reason: `外部命令启动失败（${result.error}）` };
  }
  if (result.timedOut) {
    return { retryable: false, exitCode: 124, reason: `超过硬时限被终止（${result.signal ?? 'SIGTERM'}）` };
  }
  if (result.code === null || result.code === undefined) {
    if (result.signal) {
      const exitCode = SIGNAL_EXIT_BASE + (SIGNAL_NUMBERS[result.signal] ?? 0);
      return { retryable: false, exitCode, reason: `被信号终止：${result.signal}` };
    }
    return { retryable: false, exitCode: 125, reason: '无退出码也无信号（未知失败）' };
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const statuses = [...output.matchAll(HTTP_STATUS_RE)].map(match => Number(match[1]));
  if (result.code !== 0 && statuses.length && statuses.every(status => RETRYABLE_HTTP_STATUSES.includes(status))) {
    return { retryable: true, exitCode: result.code, reason: `确认 HTTP ${statuses.join('/')}（GitHub 服务端错误）` };
  }
  if (result.code === 0) {
    return { retryable: false, exitCode: 1, reason: 'gh 退出 0 但伴随异常状态' };
  }
  return { retryable: false, exitCode: result.code, reason: `gh 退出码 ${result.code}（非确认 5xx）：${truncate(output)}` };
}

/** 上传前核实 release 仍是草稿；任何失败都让调用方停止（绝不重试核实）。 */
async function verifyStillDraft({ tag, run, timeoutMs }) {
  const res = await run(['release', 'view', tag, '--json', 'isDraft'], { timeoutMs });
  if (res.error || res.timedOut || res.signal || res.code !== 0) {
    const cls = classifyRunFailure(res);
    return { ok: false, exitCode: cls.exitCode, reason: `草稿核实失败（gh release view 异常）：${cls.reason}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, exitCode: 1, reason: `草稿核实失败：--json isDraft 输出不是合法 JSON：${truncate(res.stdout)}` };
  }
  if (parsed?.isDraft !== true) {
    return {
      ok: false,
      exitCode: 1,
      reason: `release ${tag} 已不是草稿（isDraft=${JSON.stringify(parsed?.isDraft)}），停止上挂以免覆盖正式资产`,
    };
  }
  return { ok: true };
}

/**
 * 有界重试的草稿资产上挂。`run(argv, { timeoutMs })` 与 `sleep(ms)` 均可注入
 * （单测边界）；返回进程退出码（0 成功，非 0 失败）。
 */
export async function uploadDraftAssetsWithRetry(options) {
  const {
    tag,
    files,
    run,
    sleep,
    maxAttempts = DEFAULT_MAX_UPLOAD_ATTEMPTS,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    viewTimeoutMs = VIEW_TIMEOUT_MS,
    uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
    log = console.error,
  } = options;
  validateUploadArgs(tag, files);

  let uploads = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const check = await verifyStillDraft({ tag, run, timeoutMs: viewTimeoutMs });
    if (!check.ok) {
      log(`[${tag}] ${check.reason}（已上挂 ${uploads} 次）`);
      return check.exitCode;
    }
    uploads += 1;
    log(`[${tag}] 第 ${attempt}/${maxAttempts} 次上挂 ${files.length} 个资产（--clobber，同一批文件）`);
    // 每次都是同一 argv：tag + 同一批文件 + --clobber，绝不拼 shell 字符串。
    const res = await run(['release', 'upload', tag, ...files, '--clobber'], { timeoutMs: uploadTimeoutMs });
    if (!res.error && !res.timedOut && !res.signal && res.code === 0) {
      log(`[${tag}] 上挂成功（共 ${uploads} 次尝试）`);
      return 0;
    }
    const cls = classifyRunFailure(res);
    if (!cls.retryable || attempt === maxAttempts) {
      log(`[${tag}] 上挂失败（第 ${uploads} 次尝试）：${cls.reason}，退出码 ${cls.exitCode}`);
      return cls.exitCode || 1;
    }
    const delayMs = retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0;
    log(`[${tag}] ${cls.reason}，${delayMs}ms 后用同一批文件重试`);
    await sleep(delayMs);
  }
  return 1;
}

/**
 * 真实 gh 绑定：数组参数直传、stdio 管道、硬时限到点 SIGTERM（5s 后 SIGKILL）。
 * 结果：{ code, signal, error, stdout, stderr, timedOut }，error 为 spawn 错误码。
 */
export function runGh(argv, { timeoutMs = VIEW_TIMEOUT_MS, ghBin = 'gh', env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ghBin, argv, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
    } catch (error) {
      resolve({ code: null, signal: null, error: String(error?.code ?? error), stdout: '', stderr: '', timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let settled = false;
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, KILL_GRACE_MS).unref();
    }, timeoutMs);
    killTimer.unref();
    child.on('error', (error) => {
      spawnError = error?.code ?? String(error);
    });
    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(killTimer);
      resolve({ code, signal, error: spawnError, stdout, stderr, timedOut });
    });
  });
}
