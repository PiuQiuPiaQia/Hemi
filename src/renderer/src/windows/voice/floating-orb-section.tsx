import { useEffect, useState } from 'react';

/**
 * 034 v3（2026-10-02 用户裁决）：悬浮球开关从主界面侧栏挪进设置页——
 * 与 PushToTalkSection 同区（都是「在其他地方唤起 Hemi」的全局开关）。
 * 自包含：自己读 UiPreferences、开关联动 IPC 立即生效（无保存按钮语义），
 * 主界面不再镜像该状态。
 * 037：渲染为「其他」分组里的一行（h37-row + h37-switch）。
 */
export function FloatingOrbSection() {
  // 偏好没读到时按默认开渲染（主进程默认 true），避免凭空的告警。
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    // fixtures 桩可能缺方法（hemiVoice 存在但 getUiPreferences 未定义）：
    // 同步调用前先探方法，缺了就保持默认值渲染。
    const bridge = window.hemiVoice;
    if (!bridge?.getUiPreferences) return;
    bridge
      .getUiPreferences()
      .then((prefs) => setEnabled(prefs.floatingOrbEnabled !== false))
      .catch(() => {});
  }, []);

  const toggle = (next: boolean) => {
    setEnabled(next);
    setError('');
    const bridge = window.hemiVoice;
    if (!bridge?.setFloatingOrbEnabled) return;
    bridge
      .setFloatingOrbEnabled(next)
      .then((saved) => setEnabled(saved.floatingOrbEnabled))
      .catch(() => {
        setEnabled(!next);
        setError('没有改成功，请再试一次。');
      });
  };

  return (
    <div className="h37-row">
      <span className="h37-row-text">
        <b>悬浮球</b>
        <span>
          主窗口被遮住或收起时出现在屏幕边缘：长按说话，点击回主窗口。
        </span>
        {error ? <span className="h37-error-text">{error}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        className="h37-switch"
        aria-checked={enabled}
        aria-label="悬浮球"
        onClick={() => toggle(!enabled)}
      />
    </div>
  );
}
