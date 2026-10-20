import { useEffect, useState } from 'react';

import { Check, Globe } from 'lucide-react';

/**
 * 2026-09-26（dsh 下载复盘）：执行器终端命令的代理快捷开关——看到任务慢就能
 * 当场打开。背景：git/curl 不读 macOS 系统代理，直连 GitHub 等站点常被限到
 * 几十 KiB/s，表现为「下载卡住」。默认关＝直连；打开后主进程把系统代理写进
 * env，bash 子进程继承走代理（对新起的命令立即生效）。设置全局持久，多张卡
 * 共享同一状态（各自挂载时读取，切换即写库）。Hemi 自身的模型/语音请求不受影响。
 *
 * 025 任务卡聚焦稿 v3：开关从卡片操作行收进任务卡「⋯」菜单（低频操作），
 * 菜单项形态见 ShellProxyMenuItem。
 */
function useShellProxy() {
  const [enabled, setEnabled] = useState(false);
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.hemiVoice?.getShellProxy().then((status) => {
      setEnabled(status.enabled);
      setApplied(status.applied ?? status.enabled);
    }).catch(() => {});
  }, []);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const status = await window.hemiVoice?.setShellProxy(!enabled);
      if (status) {
        setEnabled(status.enabled);
        setApplied(status.applied ?? status.enabled);
      }
    } catch {
      /* 失败保持原状态 */
    } finally {
      setBusy(false);
    }
  };

  return { enabled, applied, busy, toggle };
}

export function ShellProxyMenuItem() {
  const { enabled, applied, busy, toggle } = useShellProxy();
  const title = enabled
    ? `终端命令代理：已开${applied ? '' : '（未读到系统代理，暂未生效）'}，点击恢复直连`
    : '终端命令代理：关（直连）。下载慢时可打开走系统代理';
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={enabled}
      aria-disabled={busy || undefined}
      className="h37-menu-item"
      title={title}
      tabIndex={-1}
      onClick={() => void toggle()}
    >
      <Globe aria-hidden="true" />
      <span style={{ flex: 1 }}>
        终端命令走代理{enabled && !applied ? '（未生效）' : ''}
      </span>
      {enabled ? <Check aria-hidden="true" /> : null}
    </button>
  );
}
