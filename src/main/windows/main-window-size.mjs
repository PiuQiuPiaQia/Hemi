// 024 主窗口初始尺寸（2026-09-26 用户裁决）：按主屏工作区等比例开窗，
// 比固定 980×680 更高更宽；小屏用下限兜底（不够放就贴工作区）。
// 纯函数不 import electron，node --test 直接跑；宽度档（setMainWindowExpanded
// 的 560/980）与本函数无关——那是冒烟与旧收起档的口径。

/** 比例下限：再小的屏也不低于原展开档（980×680）。 */
export const MAIN_WINDOW_MIN = { width: 980, height: 680 };

/** 工作区占比：宽 88%、高 94%（2026-09-26 用户二轮：再宽再高，近全幅留薄边）。 */
const WIDTH_RATIO = 0.88;
const HEIGHT_RATIO = 0.94;

/** 主窗口初始尺寸：max(下限, 工作区×比例)，再贴工作区上限。 */
export function mainWindowSizeFor(workArea) {
  const byRatio = {
    width: Math.round(workArea.width * WIDTH_RATIO),
    height: Math.round(workArea.height * HEIGHT_RATIO),
  };
  return {
    width: Math.min(workArea.width, Math.max(MAIN_WINDOW_MIN.width, byRatio.width)),
    height: Math.min(workArea.height, Math.max(MAIN_WINDOW_MIN.height, byRatio.height)),
  };
}
