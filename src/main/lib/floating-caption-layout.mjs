/**
 * 悬浮字幕条（跟随悬浮球的独立透明窗口）的几何计算。
 *
 * 抽成不依赖 Electron 的纯函数：主进程只负责把结果套到窗口上，单元测试可以
 * 直接验证「字幕贴着球的上方、不越出窗口、窗口不越出工作区」这些约束。
 *
 * 宽度策略（2026-09-19 用户反馈：先「框再宽一点」、后定「300px 就够」）：
 * 卡片尽量用满允许宽度，只有窗口贴到屏幕边缘、球心太靠边时按窗口内缘让位，
 * 不再因为球贴近屏幕边缘就把文字收成窄条。
 */

/** 宽度 440：给 300px 卡片留出横向让位余量；高度 200：回应换行展示，不裁顶。 */
export const FLOATING_CAPTION_SIZE = { width: 440, height: 200 };
export const FLOATING_CAPTION_GAP = 6;
export const FLOATING_CAPTION_PADDING = 16;
/**
 * 卡片宽度的下限与上限。上限决定一行的字数（13px 字号下约 22 个汉字一行，
 * 2026-09-19 用户定：太宽反而不好读），下限是极窄工作区下的兜底。
 */
export const FLOATING_CAPTION_MIN_WIDTH = 220;
export const FLOATING_CAPTION_MAX_WIDTH = 300;

function clamp(min, max, value) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 计算字幕窗口位置与文字排版参数。
 *
 * 返回值：
 * - `x` / `y`：字幕窗口左上角（始终落在 workArea 内）。
 * - `anchorX`：文字中心的横坐标（窗口内坐标），渲染层用它做 `translateX(-50%)`。
 * - `maxWidth`：文字最大宽度，渲染层套到 `--caption-max-width`。
 * - `placement`：`above` 表示字幕在球上方，`below` 表示上方放不下、改放球下方。
 */
export function computeFloatingCaptionLayout({
  orbX,
  orbY,
  orbSize,
  workArea,
  size = FLOATING_CAPTION_SIZE,
  gap = FLOATING_CAPTION_GAP,
  padding = FLOATING_CAPTION_PADDING,
  minWidth = FLOATING_CAPTION_MIN_WIDTH,
  maxWidth = FLOATING_CAPTION_MAX_WIDTH,
}) {
  const horizontalLimit = Math.max(0, size.width - padding * 2);
  const minTextWidth = Math.min(minWidth, horizontalLimit);
  const maxTextWidth = Math.max(
    minTextWidth,
    Math.min(maxWidth, horizontalLimit),
  );

  const orbCenterX = orbX + orbSize / 2;

  // 窗口默认与球同心，越出工作区时贴边；文字位置再按窗口内的实际余量修正。
  const desiredX = orbX + (orbSize - size.width) / 2;
  const x = Math.round(
    clamp(workArea.x, workArea.x + workArea.width - size.width, desiredX),
  );

  const desiredY = orbY - size.height - gap;
  const fallbackY = orbY + orbSize + gap;
  const maxY = workArea.y + workArea.height - size.height;
  const placement = desiredY >= workArea.y ? 'above' : 'below';
  const y = Math.round(
    clamp(
      workArea.y,
      maxY,
      placement === 'above' ? desiredY : Math.min(fallbackY, maxY),
    ),
  );

  // 球心在字幕窗口里的横向位置。宽度直接用满允许值（窗口内缘减去内边距）——
  // 卡片换行更少、更好读；位置取球心，仅在窗口贴到屏幕边缘、球心太靠边时
  // 按窗口内缘让位。代价是贴边时卡片中心会偏到球心一旁，但它始终「挂在球的
  // 上方」且球心落在卡片横向范围内，视觉上仍是一体的。
  const orbOffsetX = orbCenterX - x;
  const textWidth = Math.round(clamp(minTextWidth, maxTextWidth, horizontalLimit));
  const anchorX = Math.round(
    clamp(
      padding + textWidth / 2,
      size.width - padding - textWidth / 2,
      orbOffsetX,
    ),
  );

  return { x, y, anchorX, maxWidth: textWidth, placement };
}
