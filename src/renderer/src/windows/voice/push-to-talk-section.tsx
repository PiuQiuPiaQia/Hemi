import { useEffect, useState } from 'react';

import type { Capability, UiPreferences } from '@/shared/types';
import { holdKeyLabel } from '@/windows/voice/lib/platform-format';
import { useCapability } from '@/windows/voice/lib/use-platform-state';

/**
 * 022 设置页·全局长按说话区块。043 起平台数据驱动（不再仅 darwin 渲染）：
 * - macOS：自包含读偏好、开关热启停（setPushToTalkConfig 统一入口），授权链
 *   两层提示（辅助功能 / 输入监控）与自愈轮询保持 022 语义；
 * - Windows：按能力快照渲染——WP-04 探针未过前如实「暂不可用」，不显示
 *   已授权/可配置的假象（AC-03）。
 * 037：渲染为「唤起与显示」分组里的一行（h37-row + h37-switch）。
 */
export function PushToTalkSection() {
  const isMac = window.hemiVoice?.platform === 'darwin';
  const pttCapability = useCapability('pushToTalk');

  return isMac ? <MacPushToTalkRow /> : <CapabilityPushToTalkRow capability={pttCapability} />;
}

function MacPushToTalkRow() {
  const [prefs, setPrefs] = useState<UiPreferences | null>(null);
  const enabled = prefs?.globalPushToTalkEnabled ?? true;
  // 偏好没读到时按「可用」渲染，避免给用户凭空的告警。
  const ready = prefs?.globalPushToTalkReady ?? true;
  const listening = prefs?.globalPushToTalkListening ?? true;
  // 加载失败是硬故障（不是缺授权），轮询救不回来，如实展示原因即可。
  const startError = prefs?.globalPushToTalkStartError ?? '';
  const keyLabel = holdKeyLabel(prefs?.globalPushToTalkKey || 'option', 'darwin');

  useEffect(() => {
    void window.hemiVoice?.getUiPreferences().then(setPrefs).catch(() => {});
  }, []);

  useEffect(() => {
    if (!prefs || !enabled || startError || (ready && listening)) return undefined;
    // 待授权/未确认轮询：主进程状态翻绿（钩子跑起来/事件流到达）即停。
    const timer = window.setInterval(() => {
      void window.hemiVoice
        ?.getUiPreferences()
        .then(setPrefs)
        .catch(() => {});
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [enabled, prefs, listening, ready, startError]);

  const toggleEnabled = (next: boolean) => {
    setPrefs((prev) =>
      prev
        ? {
            ...prev,
            globalPushToTalkEnabled: next,
            globalPushToTalkReady: false,
            globalPushToTalkListening: false,
          }
        : prev,
    );
    void window.hemiVoice
      ?.setPushToTalkConfig({ enabled: next })
      .then((status) => {
        setPrefs((prev) =>
          prev
            ? {
                ...prev,
                globalPushToTalkEnabled: status.globalPushToTalkEnabled,
                globalPushToTalkReady: status.globalPushToTalkReady,
                globalPushToTalkListening: status.globalPushToTalkListening,
                globalPushToTalkStartError: status.globalPushToTalkStartError,
              }
            : prev,
        );
      })
      .catch(() => {
        setPrefs((prev) => (prev ? { ...prev, globalPushToTalkEnabled: !next } : prev));
      });
  };

  const requestTrust = () => {
    void window.hemiVoice?.requestAccessibilityTrust().catch(() => {});
  };

  const openMonitoring = () => {
    void window.hemiVoice?.openInputMonitoringPane().catch(() => {});
  };

  const needsTrust = enabled && !startError && !ready;
  const needsMonitoring = enabled && !startError && ready && !listening;

  return (
    <div className="h37-row">
      <span className="h37-row-text">
        <b>长按 {keyLabel} 说话</b>
        <span>在任何应用里按住 {keyLabel} 说话，松开发送；按到其他键自动取消。</span>
        {enabled && startError ? (
          <span className="h37-error-text">启动失败：{startError}</span>
        ) : null}
        {needsTrust ? (
          <span className="h37-error-text">
            需要「辅助功能」权限，授权后自动生效。
          </span>
        ) : null}
        {needsMonitoring ? (
          <span className="h37-error-text">
            还没收到按键：请在「输入监控」里也允许 Hemi，按几个键后自动确认。
          </span>
        ) : null}
      </span>
      <span className="h37-row-end">
        {needsTrust ? (
          <button type="button" className="h37-btn h37-btn-secondary h37-btn-sm" onClick={requestTrust}>
            去授权
          </button>
        ) : null}
        {needsMonitoring ? (
          <button
            type="button"
            className="h37-btn h37-btn-secondary h37-btn-sm"
            onClick={openMonitoring}
          >
            打开输入监控
          </button>
        ) : null}
        <button
          type="button"
          role="switch"
          className="h37-switch"
          aria-checked={enabled}
          aria-label={`长按 ${keyLabel} 说话`}
          onClick={() => toggleEnabled(!enabled)}
        />
      </span>
    </div>
  );
}

/** Windows / 其他平台：能力快照驱动（unsupported 时开关置灰，文案如实）。 */
function CapabilityPushToTalkRow({ capability }: { capability: Capability | null }) {
  const checking = !capability || capability.state === 'checking';
  const unavailable = capability ? capability.state === 'unavailable' || capability.supported === false : false;
  const hint = unavailable
    ? '正在适配这台系统的全局按键，暂时不可用。'
    : checking
      ? '正在检测系统按键支持…'
      : '按键支持状态异常，暂时无法启用。';

  return (
    <div className="h37-row">
      <span className="h37-row-text">
        <b>长按说话</b>
        <span>在任何应用里按住配置的按键说话，松开发送。</span>
        <span className={unavailable ? 'h37-help' : undefined}>{hint}</span>
      </span>
      <span className="h37-row-end">
        <button
          type="button"
          role="switch"
          className="h37-switch"
          aria-checked={false}
          aria-disabled={unavailable || checking || undefined}
          aria-label="长按说话"
          title="当前平台暂不可用"
          onClick={(event) => event.preventDefault()}
        />
      </span>
    </div>
  );
}
