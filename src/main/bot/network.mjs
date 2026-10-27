import { Agent, Pool, buildConnector, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

let installed, configuration;
const CONNECTION_FAILURES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET',
  'ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH',
]);

function directFirstPool(origin, options) {
  // EnvHttpProxyAgent also calls this factory for NO_PROXY origins. Those
  // pools have no tunnel connector and must always stay direct.
  if (typeof options.connect !== 'function') return new Pool(origin, options);
  const direct = buildConnector({ allowH2: false, timeout: 3000 });
  return new Pool(origin, { ...options, connect(opts, callback) {
    direct(opts, (error, socket) => {
      if (!error) return callback(null, socket);
      if (!CONNECTION_FAILURES.has(error.code)) return callback(error, null);
      // Switch only before a socket is established: no request bytes or model
      // output have been sent, so POSTs and streaming bodies are never replayed.
      options.connect(opts, callback);
    });
  } });
}

/** The SDK imports Undici 8, replacing Node's flag-configured dispatcher. Set
 * the Bot's optional network policy after all Host imports. */
export function configureBotNetwork() {
  const mode = process.env.HEMI_BOT_NETWORK_MODE?.trim().toLowerCase() || 'auto';
  if (!['auto', 'direct', 'proxy'].includes(mode))
    throw new Error('Bot 网络模式无效，请在 network.env 中使用 auto、direct 或 proxy。');
  const enabled = !!process.env.HEMI_BOT_NETWORK_MODE || process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');
  const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (mode === 'proxy' && !httpProxy && !httpsProxy)
    throw new Error('Bot 尚未配置代理，请在 network.env 中设置 HTTP_PROXY 或 HTTPS_PROXY。');
  if (mode !== 'direct' && (!enabled || (!httpProxy && !httpsProxy))) return false;
  const options = mode === 'direct' ? { allowH2: false } : {
    httpProxy, httpsProxy, noProxy: process.env.no_proxy ?? process.env.NO_PROXY,
    allowH2: false, proxyTunnel: true,
  };
  const signature = JSON.stringify({ mode, ...options });
  if (configuration === signature && getGlobalDispatcher() === installed) return true;
  let dispatcher;
  try {
    dispatcher = mode === 'direct' ? new Agent(options)
      : new EnvHttpProxyAgent({ ...options, ...(mode === 'auto' ? { factory: directFirstPool } : {}) });
  }
  catch { throw new Error('Bot 代理配置无效，请检查服务器 network.env。'); }
  setGlobalDispatcher(dispatcher);
  installed = dispatcher;
  configuration = signature;
  return true;
}
