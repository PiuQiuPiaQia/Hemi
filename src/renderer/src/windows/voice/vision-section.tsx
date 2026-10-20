import { useEffect, useState } from 'react';

import type { Capability, ComputerUsePreferences, VisionPermissionStatus } from '@/shared/types';
import { useCapability } from '@/windows/voice/lib/use-platform-state';

/**
 * 006 设置页·电脑控制区块：总开关（R-11，默认开）与平台能力状态。
 * 043 起平台分支：
 * - macOS：两项系统授权（屏幕录制/辅助功能）的状态与授权引导（R-02）保持原语义；
 * - Windows：不虚构 TCC 两勾——按平台快照渲染驱动状态与受阻原因
 *   （WP-03 探针未过前如实「暂不可用」），高权限目标失败属于单个动作，
 *   不改全局能力状态（contracts §作用域分开）。
 * 执行视觉模型 2026-09-20 起归 设置 → 模型，这里只留一行跳转。
 * 037：按 surfaces 稿「权限与控制 · 桌面操控」改成 h37 分组列表。
 */

const PRIVACY_HINT = '截图会发给模型服务商，与文本对话同一信任边界';

const PERMISSION_ROWS = [
  {
    key: 'screenRecording' as const,
    title: '屏幕录制',
    hint: '截屏需要；未授权时操控任务会失败',
  },
  {
    key: 'accessibility' as const,
    title: '辅助功能',
    hint: '点击和键入需要；首次使用时系统会询问',
  },
];

/** Windows 桌面能力的受阻文案（reason → 用户可懂的一句话 + 处理入口）。 */
function desktopBlockedCopy(capability: Capability | null): { text: string; recheckable: boolean } {
  if (!capability || capability.state === 'checking') {
    return { text: '正在检测桌面操控支持…', recheckable: false };
  }
  if (capability.reason === 'backend-not-verified') {
    return { text: '正在适配这台系统的桌面操控，暂时不可用。', recheckable: false };
  }
  if (capability.reason === 'driver-load-failed') {
    return { text: '桌面操控组件没有加载起来，可重新检测。', recheckable: true };
  }
  return { text: '桌面操控暂不可用，可重新检测。', recheckable: true };
}

function PermissionBadge({ state }: { state: boolean | null }) {
  if (state === true) {
    return (
      <span className="h37-badge" data-tone="ok">
        已授权
      </span>
    );
  }
  if (state === false) {
    return (
      <span className="h37-badge" data-tone="warn">
        未授权
      </span>
    );
  }
  return <span className="h37-badge">未知</span>;
}

export function VisionSection({ onShowModel }: { onShowModel?: () => void }) {
  const isMac = window.hemiVoice?.platform === 'darwin';
  const desktopCapability = useCapability('desktop');

  return isMac ? (
    <MacVisionSection onShowModel={onShowModel} />
  ) : (
    <PlatformVisionSection capability={desktopCapability} onShowModel={onShowModel} />
  );
}

function MacVisionSection({ onShowModel }: { onShowModel?: () => void }) {
  const [prefs, setPrefs] = useState<ComputerUsePreferences | null>(null);
  const [permissions, setPermissions] = useState<VisionPermissionStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [slowProbe, setSlowProbe] = useState(false);

  useEffect(() => {
    void window.hemiVoice?.getComputerUse().then(setPrefs).catch(() => {});
    void refreshPermissions();
  }, []);

  // 等待 <300ms 不换文案（不闪「检测中…」）。
  useEffect(() => {
    if (!probing) {
      setSlowProbe(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowProbe(true), 300);
    return () => window.clearTimeout(timer);
  }, [probing]);

  const refreshPermissions = async () => {
    setProbing(true);
    try {
      const status = await window.hemiVoice?.getVisionPermissions();
      if (status) setPermissions(status);
    } finally {
      setProbing(false);
    }
  };

  const toggleEnabled = (enabled: boolean) => {
    setPrefs((prev) => (prev ? { ...prev, enabled } : prev));
    void window.hemiVoice?.setComputerUse({ enabled }).then(setPrefs).catch(() => {});
  };

  const enabled = prefs?.enabled ?? true;

  return (
    <VisionSectionShell enabled={enabled} onToggle={toggleEnabled} onShowModel={onShowModel} probing={probing} slowProbe={slowProbe} onRefresh={() => void refreshPermissions()}>
      {PERMISSION_ROWS.map((row) => {
        const state = permissions ? permissions[row.key] : null;
        return (
          <div key={row.key} className="h37-row">
            <span className="h37-row-text">
              <b>{row.title}</b>
              <span>{row.hint}</span>
            </span>
            <span className="h37-row-end">
              <PermissionBadge state={state} />
              {state !== true ? (
                <button
                  type="button"
                  className="h37-btn h37-btn-secondary"
                  onClick={() => void window.hemiVoice?.openVisionPermissionPane(row.key)}
                >
                  去授权
                </button>
              ) : null}
            </span>
          </div>
        );
      })}
    </VisionSectionShell>
  );
}

function PlatformVisionSection({
  capability,
  onShowModel,
}: {
  capability: Capability | null;
  onShowModel?: () => void;
}) {
  const [prefs, setPrefs] = useState<ComputerUsePreferences | null>(null);

  useEffect(() => {
    void window.hemiVoice?.getComputerUse().then(setPrefs).catch(() => {});
  }, []);

  const toggleEnabled = (enabled: boolean) => {
    setPrefs((prev) => (prev ? { ...prev, enabled } : prev));
    void window.hemiVoice?.setComputerUse({ enabled }).then(setPrefs).catch(() => {});
  };

  const enabled = prefs?.enabled ?? true;
  const blocked = desktopBlockedCopy(capability);

  return (
    <VisionSectionShell enabled={enabled} onToggle={toggleEnabled} onShowModel={onShowModel}>
      <div className="h37-row">
        <span className="h37-row-text">
          <b>桌面操控支持</b>
          <span>{blocked.text}</span>
        </span>
        <span className="h37-row-end">
          {blocked.recheckable ? (
            <button
              type="button"
              className="h37-btn h37-btn-secondary"
              onClick={() => void window.hemiVoice?.platformRecheck?.('desktop')}
            >
              重新检测
            </button>
          ) : (
            <span className="h37-badge" data-tone={capability?.state === 'checking' ? undefined : 'warn'}>
              {capability?.state === 'checking' ? '检测中' : '暂不可用'}
            </span>
          )}
        </span>
      </div>
    </VisionSectionShell>
  );
}

/** 共用壳：总开关行 + 可折叠内容区 + 底部脚注（视觉与 006/037 稿一致）。 */
function VisionSectionShell({
  enabled,
  onToggle,
  onShowModel,
  probing,
  slowProbe,
  onRefresh,
  children,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  onShowModel?: () => void;
  probing?: boolean;
  slowProbe?: boolean;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="h37-section" id="settings-desktop">
      <div className="h37-section-head">
        <h3>桌面操控</h3>
      </div>
      <div className="h37-group">
        <div className="h37-row">
          <span className="h37-row-text">
            <b id="h37m-cu-title">允许看屏幕、点鼠标、敲键盘</b>
            <span id="h37m-cu-hint">{PRIVACY_HINT}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-labelledby="h37m-cu-title"
            aria-describedby="h37m-cu-hint"
            className="h37-switch"
            onClick={() => onToggle(!enabled)}
          />
        </div>
        <div className="h37-collapse h37m-perm-collapse" data-open={enabled ? 'true' : 'false'}>
          <div inert={!enabled}>{children}</div>
        </div>
      </div>
      <div className="h37-section-foot h37m-perm-foot">
        <span>看图模型在「模型与路由」统一配置</span>
        {onShowModel ? (
          <button type="button" className="h37-link" onClick={onShowModel}>
            去设置
          </button>
        ) : null}
        {enabled && onRefresh ? (
          <>
            <span className="h37m-dot" aria-hidden>
              ·
            </span>
            <button type="button" className="h37-link" disabled={probing} onClick={onRefresh}>
              {slowProbe ? '检测中…' : '重新检测'}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
