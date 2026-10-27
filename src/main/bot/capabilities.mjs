import path from 'node:path';
import {createSkillStore} from '../skills/skill-store.mjs';
import {createSkillsmpService} from '../skills/skillsmp-service.mjs';
import {createBrowserBridgeService} from '../services/browser-bridge-service.mjs';
import {findHeadlessExecutable} from '../services/headless-browser-service.mjs';
import {createLocalSecretStorage} from '../lib/local-secrets.mjs';
import {atomicJson, readJson, fail} from './storage.mjs';

/** Bot owns its configuration and credentials; every client sees the same host facts. */
export function createBotCapabilities({dataDir, platform = process.platform, desktop = null, fetchImpl = fetch, webFetchImpl = null, browserFactory = createBrowserBridgeService} = {}) {
  const file = path.join(dataDir, 'capabilities.json');
  const secrets = createLocalSecretStorage({directory: path.join(dataDir, 'secrets')});
  let config = readJson(file, {browserEnabled: true, computerUseEnabled: platform === 'win32', webSearchEnabled: true});
  const encrypt = value => value ? secrets.encryptString(value).toString('base64') : '';
  const decrypt = value => value ? secrets.decryptString(Buffer.from(value, 'base64')) : '';
  const skills = createSkillStore({root: path.join(dataDir, 'skills'), fetchImpl});
  const marketplace = createSkillsmpService({store: skills, cacheFile: path.join(dataDir, 'skills/skillsmp-cache.json'), fetchImpl});
  let browser = null;
  const browserService = () => browser ??= browserFactory({statePath: path.join(dataDir, 'browser-state.json')});
  function view() {
    return {
      platform, browserEnabled: config.browserEnabled !== false,
      computerUseEnabled: platform === 'win32' && config.computerUseEnabled !== false,
      computerUseSupported: platform === 'win32', webSearchEnabled: config.webSearchEnabled !== false,
      hasSearchKey: Boolean(config.searchKey), browserActEnabled: config.browserActEnabled === true,
      hasBrowserActKey: Boolean(config.browserActKey), browserActUrl: config.browserActUrl ?? '', browserActModel: config.browserActModel ?? '',
    };
  }
  return {
    skills, marketplace, view,
    configure(input) {
      const next = {...config};
      for (const name of ['browserEnabled', 'computerUseEnabled', 'webSearchEnabled', 'browserActEnabled']) {
        if (Object.hasOwn(input, name)) {
          if (typeof input[name] !== 'boolean') fail('能力开关必须是布尔值。');
          next[name] = input[name];
        }
      }
      if (next.computerUseEnabled && platform !== 'win32') next.computerUseEnabled = false;
      for (const [name, storage] of [['searchApiKey', 'searchKey'], ['browserActApiKey', 'browserActKey']]) {
        if (Object.hasOwn(input, name)) {
          if (typeof input[name] !== 'string' || input[name].length > 8192) fail('API Key 格式无效。');
          next[storage] = encrypt(input[name].trim());
        }
      }
      for (const name of ['browserActUrl', 'browserActModel']) {
        if (Object.hasOwn(input, name)) {
          if (typeof input[name] !== 'string' || input[name].length > 2048) fail('浏览器决策模型配置无效。');
          next[name] = input[name].trim();
        }
      }
      if (next.browserActUrl) {
        let url;try {url = new URL(next.browserActUrl);} catch {fail('浏览器决策接口地址无效。');}
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('浏览器决策接口需要 HTTP 或 HTTPS 地址。');
      }
      atomicJson(file, next);config = next;return view();
    },
    async resolve() {
      const current = view();
      const web = current.webSearchEnabled && current.hasSearchKey;
      return {
        visionOn: current.computerUseEnabled, browserOn: current.browserEnabled,
        features: {vision: current.computerUseEnabled, desktop: current.computerUseEnabled, browser: current.browserEnabled, web},
        extensionConfig: {
          browser: {enabled: current.browserEnabled, act: current.browserActEnabled && current.hasBrowserActKey,
            jev: {baseUrl: current.browserActUrl, model: current.browserActModel, apiKey: decrypt(config.browserActKey)}},
          web: {enabled: web, provider: 'tavily', apiKey: decrypt(config.searchKey), ...(webFetchImpl ? {fetchImpl: webFetchImpl} : {})},
        },
      };
    },
    createBrowserClient(options) {return browserService().createClient(options);},
    async inspect() {
      const current = view();
      let executable = null, browserError = '';
      try {executable = findHeadlessExecutable();} catch (error) {browserError = error.message;}
      const desktopStatus = current.computerUseSupported && desktop
        ? await desktop.status().catch(error => ({available: false, reason: error.message}))
        : {available: false, reason: '此主机不提供 Windows 桌面控制。'};
      return {...current, browser: {executable, error: browserError}, desktop: desktopStatus};
    },
    async close() {await browser?.stopHub();await desktop?.dispose?.();},
  };
}
