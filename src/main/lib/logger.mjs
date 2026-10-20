import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

import { formatLogTime } from './log-time.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
/** 日志文件超过 5MB 时轮转一份 .old（只保留一代，够排查用也不吃磁盘）。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

function resolveMinLevel() {
  const requested = process.env.HEMI_LOG_LEVEL?.toLowerCase();
  if (requested && requested in LEVELS) return requested;
  return isDevelopment ? 'debug' : 'info';
}

const minLevel = resolveMinLevel();

export function logFilePath() {
  return path.join(app.getPath('userData'), 'hemi.log');
}

let rotationChecked = false;
async function rotateIfNeeded() {
  if (rotationChecked) return;
  rotationChecked = true;
  try {
    const info = await stat(logFilePath());
    if (info.size < MAX_LOG_BYTES) return;
    await mkdir(path.dirname(logFilePath()), { recursive: true });
    await rename(logFilePath(), `${logFilePath()}.old`);
  } catch {
    // 还没有日志文件或轮转失败：追加写会自己重建，不打断业务。
  }
}

function write(level, scope, message) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  // 本地时区 + 日期（2026-09-29 起；此前只有 UTC 时间，跨天取证不可行）。
  const line = `[${formatLogTime()}] [${level}] [${scope}] ${message}`;
  if (level === 'warn') console.warn(line);
  else if (level === 'error') console.error(line);
  else console.log(line);
  void rotateIfNeeded().then(() => {
    void appendFile(logFilePath(), `${line}\n`, 'utf8').catch(() => {});
  });
}

/** 按域取一个分级 logger：createLogger('asr').warn('...')。 */
export function createLogger(scope) {
  return {
    debug: (message) => write('debug', scope, message),
    info: (message) => write('info', scope, message),
    warn: (message) => write('warn', scope, message),
    error: (message) => write('error', scope, message),
  };
}

/** 兼容旧调用面：等价 info 级。 */
export function logLine(scope, message) {
  write('info', scope, message);
}

/**
 * 渲染层经 `app:log` 上报的行。统一走 `level|scope|message` 线格式，
 * 主进程按当前级别过滤后落盘；不匹配的旧格式按 info 记。
 */
export function logRendererLine(line) {
  const text = String(line ?? '');
  const match = /^(debug|info|warn|error)\|([^|]+)\|(.*)$/.exec(text);
  if (match) {
    write(match[1], `renderer/${match[2]}`, match[3]);
    return;
  }
  write('info', 'renderer', text.slice(0, 400));
}

/** 会话横幅：日志文件里分隔多轮运行，顺带记录环境与生效级别。 */
export function logSessionStart() {
  write(
    'info',
    'session',
    `— 启动 v${app.getVersion()} · electron ${process.versions.electron} · node ${process.versions.node} · ${process.platform}-${process.arch} · 级别 ${minLevel} · ${logFilePath()}`,
  );
}

export function logSessionEnd(reason = '退出') {
  write('info', 'session', `— ${reason}`);
}
