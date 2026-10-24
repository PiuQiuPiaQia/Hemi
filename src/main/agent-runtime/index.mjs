import { app } from 'electron';
import { browserBridgeStatePathFor } from '../agent/permission-state.mjs';
import { getBrowserBridgeService } from '../services/browser-bridge-service.mjs';
import { getPermissionService } from '../services/permission-instance.mjs';
import { getRemoteService } from '../remote/remote-service.mjs';
import { readStoredConfig, resolveJevConfig, resolveVisionModelConfig, resolveWebSearchConfig } from '../lib/config-store.mjs';
import { getProfiles } from '../lib/profiles-holder.mjs';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import { createAgentRuntime as createCoreRuntime, resolveWorkspacePlacement as resolveLocalPlacement } from './core.mjs';
export { collectSkills } from './core.mjs';

/** 能力开关与扩展配置（设置页三件套 + 视觉/浏览器/Jev），每次建会话现读。 */
export async function resolveCapabilities() {
  const userDataDir = app.getPath('userData');
  const stored = await readStoredConfig();
  const vision = await resolveVisionModelConfig();
  const visionOn = stored.computerUseEnabled !== false;
  const browserOn = stored.browserControlEnabled === true;
  const web = await resolveWebSearchConfig();
  const webOn = stored.webSearchEnabled === true && Boolean(web.apiKey);
  const jev = await resolveJevConfig();
  const jevOn = browserOn && jev.enabled;
  return {
    vision,
    visionOn,
    browserOn,
    features: { vision: visionOn, browser: browserOn, web: webOn },
    extensionConfig: {
      web: { enabled: webOn, provider: web.provider, apiKey: web.apiKey },
      browser: {
        enabled: browserOn,
        statePath: browserBridgeStatePathFor(userDataDir),
        act: jevOn,
        jev: { baseUrl: jev.baseUrl, apiKey: jevOn ? jev.apiKey : '', model: jev.model },
      },
    },
  };
}

export async function resolveWorkspacePlacement(workspace, { log } = {}) {
  const realHome = await realpath(os.homedir()).catch(() => os.homedir());
  if (workspace?.host && workspace?.dir) {
    const remoteService = getRemoteService();
    let contextText = '';
    if (remoteService) {
      try {
        contextText = await remoteService.remoteFsFor({ host: workspace.host, dir: workspace.dir, remoteHome: workspace.remoteHome }).contextExcerpt();
      } catch (error) {
        log?.warn?.(`[remote] 远端上下文读取失败（${workspace.host}）：${error?.message ?? error}`);
      }
    }
    return {
      cwd: realHome,
      accessWorkspaceDir: null,
      loadContextFiles: false,
      remote: { host: workspace.host, dir: workspace.dir, home: workspace.remoteHome ?? null, runner: remoteService?.runner ?? null, contextText },
    };
  }
  return resolveLocalPlacement(workspace, {log});
}

/** Desktop-only host bindings. Execution, model/role lifecycle and resource scheduling live in core.mjs. */
export function createAgentRuntime(deps) {
  const userDataDir = app.getPath('userData');
  return createCoreRuntime({
    ...deps, userDataDir, getProfiles, resolveCapabilities, resolvePlacement: resolveWorkspacePlacement,
    getAccessService: () => getPermissionService({userDataDir, log: deps.log}),
    createBrowserClient: options => getBrowserBridgeService({statePath: browserBridgeStatePathFor(userDataDir), log: deps.log}).createClient(options),
  });
}
