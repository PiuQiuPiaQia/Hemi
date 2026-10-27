import { createOAuthModels } from '../services/oauth-models.mjs';
import { createOAuthLogin } from '../services/oauth-login.mjs';
import { transientOAuthCredentials } from './oauth.mjs';
import { fail } from './storage.mjs';

/** Desktop-only authorization, with the Bot's host identity and no disk copy. */
export function createBotOAuthLogin({ prepare, install, openExternal }) {
  let login = null, credentials = null, starting = false, disposed = false;
  return {
    getState: () => {
      const state = login?.getState() ?? null;
      if (state && state.phase !== 'login') credentials?.clear();
      return state;
    },
    async start(provider) {
      if (disposed) fail('Bot 连接已更换，请重新打开模型设置。', 'conflict');
      if (starting || login?.getState()?.phase === 'login') fail('请先完成或取消当前登录。', 'busy');
      starting = true;
      try {
        const { deviceId } = await prepare();
        if (disposed) fail('Bot 连接已更换。', 'conflict');
        login?.dispose(); credentials?.clear();
        credentials = transientOAuthCredentials(deviceId);
        const staged = credentials;
        login = createOAuthLogin({
          credentials: staged, runtime: createOAuthModels(staged), openExternal,
          profiles: { async saveOAuthProvider(provider) {
            try { return await install(provider, await staged.read(provider)); }
            finally { staged.clear(); }
          } },
        });
        return await login.start(provider);
      } finally { starting = false; }
    },
    answer: payload => { if (!login) fail('这个登录步骤已结束，请重新登录。'); return login.answer(payload); },
    cancel: async id => { const result = await login?.cancel(id); if (result?.phase !== 'login') credentials?.clear(); return result ?? null; },
    dispose() { disposed = true; login?.dispose(); credentials?.clear(); },
  };
}
