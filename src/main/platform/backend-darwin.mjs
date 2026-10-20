/**
 * 043 B1 · darwin 平台后端：能力探测的 mac 实现。
 * 不直接 import electron——系统依赖经 deps 注入（platform-instance 组装，
 * node --test 用桩跑全链路）。这里只回答「该构建此能力是否实现、当前是否可用」。
 */

/**
 * @param {object} deps
 * @param {(mediaType: string) => string} deps.getMediaAccessStatus
 * @param {(status: string) => Promise<boolean>} [deps.askForMediaAccess]
 * @param {() => boolean} [deps.micTestOverride] 冒烟/自驱动强制麦克风已授权
 * @param {() => boolean} deps.pushToTalkRunning
 * @param {() => boolean} deps.pushToTalkListening
 * @param {() => string} deps.pushToTalkStartError
 */
export function darwinBackend(deps) {
  const micStatus = () => {
    if (deps.micTestOverride?.()) return 'granted';
    return deps.getMediaAccessStatus('microphone');
  };

  return {
    shortcut: { pushToTalk: { key: 'option', label: 'Option' } },

    /** 旧 permissions IPC 的投影源：真实 TCC 状态；未知时由调用方走 ask 流程。 */
    microphoneStatus: micStatus,
    async requestMicrophoneAccess() {
      if (deps.micTestOverride?.()) return true;
      const status = micStatus();
      if (status === 'granted') return true;
      if (status === 'denied' || status === 'restricted') return false;
      if (!deps.askForMediaAccess) return false;
      return deps.askForMediaAccess('microphone');
    },

    probes: {
      // mac 上「隐私授权」是麦克风的主门槛；设备级可用性由采集链路（ASR 起
      // 会话）验证，失败走既有错误提示，不在快照里越权断言。
      microphone: async () => {
        const status = micStatus();
        if (status === 'granted') return { state: 'ready', supported: true, actions: ['open-microphone-settings', 'recheck'] };
        if (status === 'denied' || status === 'restricted') {
          return { state: 'blocked', reason: 'privacy-disabled', supported: true, actions: ['open-microphone-settings', 'recheck'] };
        }
        // notdetermined/unknown：未检测不显示已授权。
        return { state: 'blocked', supported: true, actions: ['open-microphone-settings', 'recheck'] };
      },
      audioDuplex: () => ({ state: 'ready', supported: true, actions: ['recheck'] }),
      // 钩子运行态是运行事实（enabled 意图由服务层从配置投影，探测不掺和）：
      // 启动失败 → error；没在跑 → blocked（缺授权/被关闭，UI 按 enabled 区分）。
      pushToTalk: () => {
        if (deps.pushToTalkStartError()) return { state: 'error', supported: true, actions: ['change-shortcut', 'recheck'] };
        if (!deps.pushToTalkRunning()) return { state: 'blocked', supported: true, actions: ['change-shortcut', 'recheck'] };
        return { state: 'ready', supported: true, actions: ['change-shortcut', 'recheck'] };
      },
      desktop: () => ({ state: 'ready', supported: true, actions: ['recheck'] }),
      browser: () => ({ state: 'ready', supported: true, actions: ['manage-extension', 'recheck'] }),
      command: () => ({ state: 'ready', supported: true, actions: ['recheck'] }),
      systemProxy: () => ({ state: 'ready', supported: true, actions: ['recheck'] }),
      capture: () => ({ state: 'ready', supported: true, actions: ['recheck'] }),
      currentPage: () => ({ state: 'ready', supported: true, actions: ['recheck'] }),
      appCatalog: () => ({ state: 'ready', supported: true, actions: ['recheck'] }),
    },
  };
}
