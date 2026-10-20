import { lazy, Suspense, type ReactNode } from 'react';

import { BrandIcon } from '@/components/brand-icon';

const DevPerformanceMonitor = import.meta.env.DEV ? lazy(() => import('./dev-performance-monitor').catch(error => {
  console.warn('[perf] 开发性能监控加载失败', error);
  return { default: () => <></> };
})) : null;

/**
 * 共用顶栏（titlebar）：主窗口与设置页共用同一结构、同一套样式
 * （compact-shell 作用域下的 .app-bar 家族，62px、macOS 让位原生红绿灯 88px、
 * -webkit-app-region 拖拽区）。
 *
 * 024 全页面重构：中间加可选的会话标题槽（窄屏自动隐藏）；
 * `leading` 渲染在品牌区内（窄屏的抽屉导航按钮），`actions` 仍在右侧。
 */
export function AppTopBar({
  title,
  leading,
  actions,
  showBrand = true,
}: {
  title?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  /** 026 R-01：主窗顶栏去品牌行（侧栏「新建对话」是首个明显操作；关于页仍可识别品牌）。 */
  showBrand?: boolean;
}) {
  return (
    <header className="app-bar titlebar-drag">
      <div className={showBrand ? 'brand-row titlebar-no-drag-exempt' : 'brand-row is-bare titlebar-no-drag-exempt'}>
        {leading}
        {showBrand ? (
          <>
            <BrandIcon className="brand-mark" />
            <div className="brand-wordmark">
              <p>Hemi</p>
            </div>
          </>
        ) : null}
      </div>
      {title != null ? (
        // 标题块并入拖拽区（2026-10-10）：顶栏中间也要能拖窗/双击缩放还原，
        // 槽内交互件（抽屉钮、技能页分段控件等）由 .titlebar-drag button/input 兜回 no-drag。
        <div className="app-bar-title">{title}</div>
      ) : null}
      <div className="bar-actions titlebar-no-drag">
        {/* 监控自身 portal 到 body；此处只管理生命周期，不占顶栏空间。 */}
        {DevPerformanceMonitor ? <Suspense fallback={null}><DevPerformanceMonitor /></Suspense> : null}
        {actions}
      </div>
    </header>
  );
}
