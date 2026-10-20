/**
 * 043 B1 · win32 平台后端：Windows 能力事实（准确 unknown/unavailable）。
 *
 * 边界（technical-plan「实施顺序」与 specs AC-03）：
 * - 只有 WP 探针真机通过的能力才允许 ready；本版除麦克风隐私线索外全部
 *   如实不可用（backend-not-verified），UI/工具/提示词消费同一状态；
 * - 禁止把非 macOS 默认视为已授权：麦克风读系统隐私设置真实值，不弹
 *   mac 的 askForMediaAccess，打开系统设置用 ms-settings URI。
 */

/**
 * @param {object} deps
 * @param {(mediaType: string) => string} deps.getMediaAccessStatus Windows 隐私设置线索
 */
export function win32Backend(deps) {
  /** Windows 状态 → 快照能力（granted 只是隐私线索；设备可用性由采集实测补）。 */
  const microphoneCapability = () => {
    let status = 'unknown';
    try {
      status = deps.getMediaAccessStatus('microphone');
    } catch {
      status = 'unknown';
    }
    if (status === 'granted') {
      return { state: 'ready', supported: true, actions: ['open-microphone-settings', 'recheck'] };
    }
    if (status === 'denied' || status === 'restricted') {
      return { state: 'blocked', reason: 'privacy-disabled', supported: true, actions: ['open-microphone-settings', 'recheck'] };
    }
    // unknown/not_available：未检测不显示已授权（AC-03 反例口径）。
    return { state: 'blocked', supported: true, actions: ['open-microphone-settings', 'recheck'] };
  };

  /** Windows 麦克风开关只回答「隐私设置未拒绝」；不执行 mac 授权弹窗。 */
  const microphoneGranted = () => microphoneCapability().state === 'ready';

  return {
    // Q2 未定案（右 Alt 候选、AltGr/IME 待 WP-04）：不落默认键。
    shortcut: { pushToTalk: null },

    microphoneStatus: () => {
      try {
        return deps.getMediaAccessStatus('microphone');
      } catch {
        return 'unknown';
      }
    },
    requestMicrophoneAccess: async () => microphoneGranted(),

    probes: {
      microphone: microphoneCapability,
      // Swift/VPIO helper 是 mac 专属；Windows 音频后端等 WP-04 定案。
      audioDuplex: () => ({ state: 'unavailable', reason: 'backend-not-verified', supported: false }),
      // uiohook 在 Windows 的钩子链未验证（WP-04）；不启用、不假装可用。
      pushToTalk: () => ({ state: 'unavailable', reason: 'backend-not-verified', supported: false }),
      // cua-driver 声明了 Windows 原生包，但 Hemi 的桌面链（身份/授权/中文键
      // 入/DPI）未过 WP-03：不可用，不为「包存在」背书。
      desktop: () => ({ state: 'unavailable', reason: 'backend-not-verified', supported: false }),
      browser: () => ({ state: 'unavailable', reason: 'backend-not-verified', supported: false }),
      // 命令隔离在 Windows 没有 Seatbelt 后端；WP-01 未过不注册命令工具。
      command: () => ({ state: 'unavailable', reason: 'backend-not-verified', supported: false }),
      // scutil 是 darwin 专属；Windows 静态代理适配是 P1（R-19）。
      systemProxy: () => ({ state: 'unavailable', reason: 'unsupported-proxy', supported: false }),
      capture: () => ({ state: 'unavailable', reason: 'backend-not-verified', supported: false }),
      currentPage: () => ({ state: 'unavailable', reason: 'backend-not-verified', supported: false }),
      appCatalog: () => ({ state: 'unavailable', reason: 'backend-not-verified', supported: false }),
    },
  };
}
