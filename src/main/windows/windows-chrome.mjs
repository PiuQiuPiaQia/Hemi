/**
 * Windows 主窗框集成（titleBarOverlay 与渲染层 52px 顶栏共存）。
 *
 * 借鉴 ZCode desktop 源码（desktopWindowButtonPosition.ts / desktopWindowChrome.ts）的两条经验：
 * 1. overlay 背景保持全透明（#00000000），顶栏底色由渲染层自绘。不透明 overlay 会在
 *    resize／换肤窗口期与页面各画一层底色，出现色带或错位；透明后只有 symbolColor
 *    需要跟随皮肤，窗口控件命中区仍完全原生（Win11 Snap Layouts 等系统行为保留）。
 * 2. WCO/frameless 窗口偶发「只更新 bounds、renderer 最后一帧不重绘」，手动拉伸结束
 *    （resized）或隐藏到悬浮球后再次 show 时，新扩展区域会留宿主底色。用有界双帧
 *    重绘（立即 + 32ms 后）兜底，不 reload renderer。
 */

export const WINDOWS_TITLE_BAR_HEIGHT_PX = 52;
export const WINDOWS_OVERLAY_TRANSPARENT = '#00000000';
export const WINDOWS_SYMBOL_COLOR_FALLBACK = '#2d2d2c';

/**
 * 构造 Windows titleBarOverlay 配置。皮肤缺失时不抛错，用正文色兜底，
 * 保证窗口创建路径不被皮肤加载失败连坐。
 */
export function buildWindowsTitleBarOverlay(skin) {
  return {
    color: WINDOWS_OVERLAY_TRANSPARENT,
    symbolColor: skin?.colors?.['--body'] ?? WINDOWS_SYMBOL_COLOR_FALLBACK,
    height: WINDOWS_TITLE_BAR_HEIGHT_PX,
  };
}

/**
 * Windows 重绘兜底：resized / show 后补一次完整窗口重绘。
 * 返回 dispose，供测试或提前解绑；closed 时自动清理定时器与监听。
 */
export function attachWindowsWindowRepaint(targetWindow) {
  let pendingTimer = null;
  const repaint = () => {
    if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) return;
    targetWindow.webContents.invalidate();
  };
  const scheduleRepaint = () => {
    repaint();
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      repaint();
    }, 32);
  };
  const onResized = () => scheduleRepaint();
  const onShow = () => scheduleRepaint();
  targetWindow.on('resized', onResized);
  targetWindow.on('show', onShow);
  const dispose = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    // 销毁后的窗口上 removeListener 是无害 no-op，无条件解绑便于测试与提前 dispose。
    targetWindow.removeListener('resized', onResized);
    targetWindow.removeListener('show', onShow);
  };
  targetWindow.once('closed', dispose);
  return dispose;
}
