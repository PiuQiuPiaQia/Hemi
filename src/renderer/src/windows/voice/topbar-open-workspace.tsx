import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, CircleAlert, Code2, Folder, Terminal } from 'lucide-react';

import type { WorkspaceOpenTarget, WorkspaceView } from '@/shared/types';
import { Menu, MenuGroup, MenuItem } from '@/components/menu';
import { fileManagerName } from '@/windows/voice/lib/platform-format';

/**
 * 066 · 顶栏「打开工作区目录」（参考 ZCode 顶栏同位入口的 split button 形态）。
 *
 * - 主按钮＝用默认方式立即打开（图标跟随默认方式）；下拉箭头选方式，
 *   选中即成为新默认（落配置，跨会话保持）并立即打开。
 * - 只在本机项目工作区出现（默认空间/旧会话家目录/远端项目不显示——
 *   远端目录在本地文件管理器里没有对应物）。
 * - 失败（目录失效、VS Code 未装等）弹 h37-toast 如实说明，不静默。
 */
const TARGET_ICONS: Record<WorkspaceOpenTarget, typeof Folder> = {
  finder: Folder,
  terminal: Terminal,
  vscode: Code2,
};

function targetName(target: WorkspaceOpenTarget, platform: string): string {
  if (target === 'finder') return fileManagerName(platform);
  return target === 'terminal' ? '终端' : 'VS Code';
}

/** 菜单项文案：拉丁名（VS Code）两侧留空格，中文名不加。 */
function targetLabel(target: WorkspaceOpenTarget, platform: string): string {
  return target === 'vscode' ? '在 VS Code 中打开' : `在${targetName(target, platform)}中打开`;
}

export function TopbarOpenWorkspace({
  view,
  platform = window.hemiVoice?.platform ?? 'darwin',
  fixtureOpen = false,
}: {
  view: WorkspaceView;
  /** fixtures 场景可注入平台，验两套文案。 */
  platform?: string;
  /** fixtures 用：初始即展开方式菜单（静态截图取证）。 */
  fixtureOpen?: boolean;
}) {
  const [target, setTarget] = useState<WorkspaceOpenTarget>('finder');
  const [menuOpen, setMenuOpen] = useState(Boolean(fixtureOpen));
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    void window.hemiVoice
      ?.getWorkspaceOpenTarget?.()
      .then((result) => {
        if (alive && result?.target) setTarget(result.target);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const openWith = async (next: WorkspaceOpenTarget) => {
    try {
      const result = await window.hemiVoice?.openWorkspaceDir?.(view.id, next);
      if (result && !result.ok) {
        setToast({ id: ++seq.current, text: result.message ?? '没打开成功' });
      }
    } catch {
      setToast({ id: ++seq.current, text: '没打开成功' });
    }
  };

  const choose = (next: WorkspaceOpenTarget) => {
    setMenuOpen(false);
    if (next === target) {
      void openWith(next);
      return;
    }
    setTarget(next);
    void window.hemiVoice?.setWorkspaceOpenTarget?.(next).catch(() => {});
    void openWith(next);
  };

  const MainIcon = TARGET_ICONS[target];
  const openTitle = `${targetLabel(target, platform)}「${view.name}」`;

  return (
    <div className="h65-open-group" ref={groupRef}>
      <button
        type="button"
        className="icon-btn h65-open-main"
        title={openTitle}
        aria-label={openTitle}
        onClick={() => void openWith(target)}
      >
        <MainIcon className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn h65-open-more"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="选择打开方式"
        title="选择打开方式"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <ChevronDown className="size-3" aria-hidden="true" />
      </button>
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={groupRef}
        placement="anchor-down"
        transformOrigin="top right"
        zIndex={10000}
      >
        <MenuGroup label="打开方式" />
        {(['finder', 'terminal', 'vscode'] as const).map((item) => {
          const Icon = TARGET_ICONS[item];
          return (
            <MenuItem
              key={item}
              role="menuitemradio"
              checked={target === item}
              icon={<Icon className="size-4" aria-hidden="true" />}
              label={targetLabel(item, platform)}
              onClick={() => choose(item)}
            />
          );
        })}
      </Menu>
      {toast
        ? createPortal(
            <div className="h37-toast h37-toast-card" role="status" key={toast.id} data-tone="err">
              <CircleAlert aria-hidden="true" />
              <span>{toast.text}</span>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
