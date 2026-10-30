import { randomUUID } from 'node:crypto';
import { OAUTH_PROVIDERS, isOAuthProvider } from './oauth-models.mjs';

const abortError = () => new DOMException('登录已取消', 'AbortError');
// Provider response bodies can contain credentials. Only controlled messages cross IPC.
function loginError(error) {
  const message = String(error?.message ?? '');
  if (/1455|EADDRINUSE|port .*in use/i.test(message)) return '登录回调端口被占用，请先结束其他 ChatGPT 登录后重试。';
  if (/keychain|钥匙串|凭据文件|无法解密/.test(message)) return message;
  if (/chatgpt.tokens.use.direct/.test(message)) return '尚未授权使用 ChatGPT 额度，请重新登录并同意该权限。';
  if (/Failed to extract accountId from token/.test(message)) return '登录令牌缺少账号标识，请重新登录并确认账号已开通 Codex 访问。';
  if (/^GLM 编程套餐/.test(message)) return message;
  if (/^Bot 未能验证账号模型/.test(message)) return message;
  if (/^(配置目录损坏|环境变量正在覆盖|ChatGPT 模型目录|这个账号没有返回)/.test(message)) return message;
  return '账号登录未完成，请检查浏览器中的授权结果和网络后重试。';
}

/** One cancellable browser/device flow. Pollable DTO survives renderer reloads. */
export function createOAuthLogin({ runtime, credentials, profiles, openExternal, timeoutMs = 10 * 60 * 1000 }) {
  let active = null;
  let sequence = 0;
  const snapshot = () => active ? structuredClone(active.state) : null;
  function publish(op, patch) {
    if (active !== op) return;
    op.state = { ...op.state, ...patch, revision: ++sequence };
  }
  function prompt(op, request) {
    return new Promise((resolve, reject) => {
      const signal = request.signal ? AbortSignal.any([request.signal, op.controller.signal]) : op.controller.signal;
      if (signal.aborted) { reject(abortError()); return; }
      const id = randomUUID();
      const cleanup = () => {
        signal.removeEventListener('abort', cancel);
        if (op.prompt?.id === id) { op.prompt = null; publish(op, { prompt: null }); }
      };
      const cancel = () => { cleanup(); reject(abortError()); };
      signal.addEventListener('abort', cancel, { once: true });
      op.prompt = { id, answer: value => { cleanup(); resolve(value); } };
      publish(op, { prompt: {
        id, type: request.type,
        message: request.type === 'select' ? '选择登录方式' : request.type === 'manual_code' ? '浏览器未自动返回时，粘贴授权码或完整回调地址' : 'GitHub Enterprise 域名（个人账号留空）',
        placeholder: request.placeholder ?? '',
        ...(request.options ? { options: request.options.map(option => ({ id: option.id, label: option.id === 'browser' ? '浏览器登录' : option.id === 'copy_code' ? '复制授权码登录' : option.id === 'device_code' ? '设备验证码登录' : option.label })) } : {}),
      } });
    });
  }
  function authUrl(op, raw) {
    const provider = op.state.provider;
    const url = new URL(raw);
    const allowed = provider === 'bigmodel' ? ['bigmodel.cn', 'www.bigmodel.cn'] : provider === 'openai' ? ['auth.openai.com'] : provider === 'anthropic' ? ['claude.ai', 'platform.claude.com'] : ['github.com', op.enterpriseHost].filter(Boolean);
    if (url.protocol !== 'https:' || url.username || url.password || (allowed && !allowed.includes(url.hostname))) throw new Error('登录地址无效');
    return url.href;
  }
  async function run(op) {
    const timer = setTimeout(() => { op.timedOut = true; op.controller.abort(); }, timeoutMs);
    try {
      const deviceId = await credentials.deviceId();
      await runtime.models.login(op.state.provider, 'oauth', {
        signal: op.controller.signal,
        prompt: request => prompt(op, request),
        notify: event => {
          if (op.controller.signal.aborted) return;
          if (event.type === 'auth_url' || event.type === 'device_code') {
            const url = authUrl(op, event.url ?? event.verificationUri);
            publish(op, { url, userCode: event.userCode ?? null, message: event.type === 'device_code' ? '在浏览器输入设备验证码并授权' : '请在浏览器完成账号登录和授权' });
            void openExternal(url).catch(() => publish(op, { message: '未能打开浏览器，请复制登录链接在浏览器打开' }));
          } else if (event.type === 'progress') publish(op, { message: '正在验证授权并获取账号模型…' });
        },
      }, { agentName: 'Hemi', getDeviceId: () => deviceId });
      op.controller.signal.throwIfAborted();
      const catalog = await runtime.catalog(op.state.provider, { refresh: true, signal: op.controller.signal });
      if (!catalog.length) throw new Error('这个账号没有返回 Hemi 支持的模型，请检查订阅权限或更新模型目录。');
      op.controller.signal.throwIfAborted();
      op.committing = true;
      const result = await profiles.saveOAuthProvider(op.state.provider, catalog);
      publish(op, { phase: 'success', message: '登录成功，模型已加入列表', providerId: result.providerId, prompt: null, url: null, userCode: null });
    } catch (error) {
      publish(op, { phase: op.controller.signal.aborted ? 'cancelled' : 'failed', message: op.timedOut ? '登录等待超时，请重新登录。' : op.controller.signal.aborted ? '登录已取消' : loginError(error), prompt: null, url: null, userCode: null });
    } finally { clearTimeout(timer); }
  }
  return {
    getState: snapshot,
    async start(provider) {
      if (!isOAuthProvider(provider)) throw new Error('不支持这个账号服务商');
      if (active?.state.phase === 'login') throw new Error('请先完成或取消当前登录');
      const op = { controller: new AbortController(), state: { id: randomUUID(), revision: ++sequence, provider, name: OAUTH_PROVIDERS[provider], phase: 'login', message: '正在准备账号登录…', prompt: null, url: null, userCode: null } };
      active = op;
      op.done = run(op);
      return snapshot();
    },
    answer({ id, promptId, value }) {
      if (active?.state.id !== id || active.state.phase !== 'login' || active.prompt?.id !== promptId) throw new Error('这个登录步骤已结束，请刷新后重试');
      if (typeof value !== 'string' || value.length > 16000) throw new Error('登录输入无效');
      const options = active.state.prompt?.options;
      if (options && !options.some(option => option.id === value)) throw new Error('请选择一个登录方式');
      if (active.state.provider === 'github-copilot' && active.state.prompt?.type === 'text' && value.trim()) {
        try { active.enterpriseHost = new URL(value.includes('://') ? value : `https://${value}`).hostname; }
        catch { throw new Error('GitHub Enterprise 域名无效'); }
      }
      active.prompt.answer(value.trim());
      return snapshot();
    },
    async cancel(id) {
      if (active?.state.id === id && active.state.phase === 'login') { if (!active.committing) active.controller.abort(); await active.done; }
      return snapshot();
    },
    async logout(provider) {
      if (!isOAuthProvider(provider)) throw new Error('不支持这个账号服务商');
      if (active?.state.phase === 'login') throw new Error('请先完成或取消当前登录');
      await runtime.models.logout(provider);
      if (active?.state.provider === provider) active = null;
      return { ok: true };
    },
    dispose() { active?.controller.abort(); },
  };
}
