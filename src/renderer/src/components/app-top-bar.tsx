import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { BrandIcon } from './brand-icon';
import { WindowsMenuBar } from './windows-menu-bar';
import './app-top-bar.css';

const DevPerformanceMonitor = import.meta.env.DEV ? lazy(() => import('@/windows/voice/dev-performance-monitor').catch(error => {
  console.warn('[perf] 开发性能监控加载失败', error);
  return { default: () => <></> };
})) : null;

/** One window navigation row for every desktop page. Native controls own their
 * platform edge; page content never supplies traffic-light or caption offsets. */
export function AppTopBar({
  title,
  leading,
  actions,
  back,
  showBrand = true,
  onNewConversation,
  onOpenWorkspace,
}: {
  title?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void; disabled?: boolean };
  showBrand?: boolean;
  onNewConversation?: () => void;
  onOpenWorkspace?: () => void;
}) {
  return (
    <header className="app-topbar titlebar-drag" data-platform={window.hemiVoice?.platform ?? 'linux'}>
      <WindowsMenuBar onNewConversation={onNewConversation} onOpenWorkspace={onOpenWorkspace} />
      {back || leading || showBrand ? <div className="app-topbar-leading">
        {back ? <button type="button" className="app-topbar-back" aria-label={back.label} title={back.label} onClick={back.onClick} disabled={back.disabled}>
          <ArrowLeft size={16} aria-hidden="true" />
        </button> : null}
        {leading}
        {showBrand ? <div className="app-topbar-brand"><BrandIcon width={24} height={24} /><span>Hemi</span></div> : null}
      </div> : null}
      <div className="app-topbar-title">
        {typeof title === 'string' ? <span className="app-topbar-label">{title}</span> : title}
      </div>
      <div className="app-topbar-actions">
        {DevPerformanceMonitor ? <Suspense fallback={null}><DevPerformanceMonitor /></Suspense> : null}
        {actions}
      </div>
    </header>
  );
}
