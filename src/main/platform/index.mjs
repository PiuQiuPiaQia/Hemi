/**
 * 043 B1 · 平台服务工厂：按平台选后端，组装能力服务。
 * 纯模块——electron/配置/钩子等系统依赖全部经 deps 注入（见 platform-instance），
 * mac 单测不 import Windows 代码路径，也不碰 electron。
 */
import { createCapabilityService } from './capabilities.mjs';
import { darwinBackend } from './backend-darwin.mjs';
import { win32Backend } from './backend-win32.mjs';

/**
 * @param {object} options
 * @param {'darwin'|'win32'} [options.platform] 缺省取 process.platform
 * @param {object} options.deps 后端系统依赖（systemPreferences 钩子状态等）
 * @param {Record<string, boolean>} [options.enabledIntents] 能力的已保存用户意图
 * @param {(snapshot: object) => void} [options.notify]
 */
export function createPlatformService({ platform = process.platform, deps, enabledIntents, notify } = {}) {
  if (platform === 'win32') return createWithBackend(win32Backend(deps ?? {}), { platform, enabledIntents, notify });
  // 未知平台按 darwin 底座降级（其探测会如实给出结果）；快照 platform 仍写实际值。
  return createWithBackend(darwinBackend(deps ?? {}), { platform, enabledIntents, notify });
}

function createWithBackend(backend, { platform, enabledIntents, notify }) {
  const service = createCapabilityService({ platform, probes: backend.probes, enabledIntents, notify });
  if (backend.shortcut?.pushToTalk) {
    service.setShortcut(backend.shortcut.pushToTalk.key, backend.shortcut.pushToTalk.label);
  }
  return Object.assign(service, {
    /** 旧 permissions IPC 的投影源（同一份状态判断，不留第二套）。 */
    microphoneStatus: backend.microphoneStatus,
    requestMicrophoneAccess: backend.requestMicrophoneAccess,
  });
}
