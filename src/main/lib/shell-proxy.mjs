import { execFile } from 'node:child_process';

/**
 * 2026-09-26（dsh 下载复盘）：执行器终端命令的代理支持。git/curl 等命令行
 * 工具不读 macOS 系统代理设置（scutil 面板），直连 GitHub 等站点常被限到
 * 几十 KiB/s——「下载卡住」的主因。开关打开时把系统代理（HTTPS 优先，其次
 * HTTP，再退 SOCKS）写进主进程环境变量，bash 工具的子进程 spawn 时继承；
 * Node 侧 fetch/undici 与 WebSocket 不读这些变量，Hemi 自身的模型/ASR 请求
 * 不受影响（Electron net 走自己的系统代理通道，也与此无关）。
 */

/** bash 子进程会读的代理变量（大小写成对写，兼容不同工具的读取习惯）。 */
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
];

/** 解析 `scutil --proxy` 输出（纯函数，测试直接喂文本）。 */
export function parseScutilProxy(text) {
  const input = String(text ?? '');
  const number = (key) => {
    const match = input.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const pair = (enableKey, hostKey, portKey) => {
    if (number(enableKey) !== 1) return null;
    const host = input.match(new RegExp(`^\\s*${hostKey}\\s*:\\s*(\\S+)\\s*$`, 'm'))?.[1];
    const port = number(portKey);
    return host && port ? { host, port } : null;
  };
  const https = pair('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort');
  if (https) return `http://${https.host}:${https.port}`;
  const http = pair('HTTPEnable', 'HTTPProxy', 'HTTPPort');
  if (http) return `http://${http.host}:${http.port}`;
  const socks = pair('SOCKSEnable', 'SOCKSProxy', 'SOCKSPort');
  if (socks) return `socks5://${socks.host}:${socks.port}`;
  return null;
}

/** 读系统代理（仅 macOS；其它平台/未开启返回 null）。异步 execFile，不阻塞事件循环。 */
export function readSystemProxyUrl() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('scutil', ['--proxy'], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(parseScutilProxy(stdout));
    });
  });
}

/** 按开关写/清代理环境变量（幂等；返回最终生效的代理地址或 null）。 */
export function applyExecutorProxyEnv(enabled, proxyUrl) {
  if (!enabled || !proxyUrl) {
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
    return null;
  }
  for (const key of PROXY_ENV_KEYS) process.env[key] = proxyUrl;
  return proxyUrl;
}

/** 开关落位：读系统代理 → 应用 → 返回实际状态（UI 回执同源）。 */
export async function syncExecutorProxy(enabled, { log } = {}) {
  const proxyUrl = enabled ? await readSystemProxyUrl() : null;
  if (enabled && !proxyUrl) {
    log?.warn('执行器代理开关已打开，但没读到可用的系统代理（scutil）——本次未注入环境变量');
  }
  const applied = applyExecutorProxyEnv(enabled, proxyUrl);
  if (applied) log?.info(`执行器终端命令走系统代理：${applied}`);
  else if (!enabled) log?.info('执行器终端命令恢复直连（代理开关关闭）');
  return { enabled: Boolean(applied), proxy: applied };
}
