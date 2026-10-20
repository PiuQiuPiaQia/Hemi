type Level = 'debug' | 'info' | 'warn' | 'error';

const isDevelopment = import.meta.env.DEV;

/**
 * 渲染层统一 logger：与主进程同一套级别语义。
 * 行经 `app:log` 上报，线格式 `level|scope|message` 由主进程解析、
 * 按当前级别过滤后落盘（scope 记为 `renderer/<scope>`）。
 * debug 级只在开发构建上报，避免生产环境的 IPC 噪音。
 */
export function createLogger(scope: string) {
  function send(level: Level, message: unknown) {
    const text = String(message ?? '').slice(0, 400);
    if (level === 'debug' && !isDevelopment) return;

    if (isDevelopment) {
      const tag = `[${scope}]`;
      if (level === 'warn') console.warn(tag, text);
      else if (level === 'error') console.error(tag, text);
      else console.log(tag, text);
    }
    window.hemiVoice?.logLine(`${level}|${scope}|${text}`);
  }

  return {
    debug: (message: unknown) => send('debug', message),
    info: (message: unknown) => send('info', message),
    warn: (message: unknown) => send('warn', message),
    error: (message: unknown) => send('error', message),
  };
}
