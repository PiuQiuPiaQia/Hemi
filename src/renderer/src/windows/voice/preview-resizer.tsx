import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'hemi.preview-width';
const DEFAULT_WIDTH = 410;
const MIN_WIDTH = 360;
const MAX_WIDTH = 720;
const RESIZER_WIDTH = 10;
const KEYBOARD_STEP = 16;

/**
 * 预览面板拖拽调整宽度手柄（≥1180px 并排模式显示）。
 *
 * - 贴在预览面板左缘，热区 10px，hover/拖动时显示 1px 强调线；
 * - pointerdown 捕获指针，按起点差量实时更新宽度；
 * - 边界：最小 360，最大取 (窗口宽 - 侧栏 - 主区最小宽 - 手柄) 与 720 的较小值；
 * - 双击恢复默认 410；
 * - 可访问性：role="separator"、方向键调整、aria 属性；
 * - 松手后写 localStorage，下次恢复。
 */
export function PreviewResizer({
  width,
  onWidthChange,
  sidebarWidth,
  mainMinWidth,
  marketOpen,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  sidebarWidth: number;
  mainMinWidth: number;
  marketOpen: boolean;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 松手时要落盘的是「拖动后的宽度」：pointerup 与最后一次 setState 可能同帧，
  // 闭包里的 width 还是旧值，所以单独记一份最新值。
  const widthRef = useRef(width);
  widthRef.current = width;

  const clampWidth = useCallback(
    (w: number) => {
      // 可用宽 = 工作区自身的宽（窗口减去左侧图标栏），不是 window.innerWidth：
      // .h24-frame 里 NavRail 与工作区并列，用窗口宽会高估 48px，把主区压到最小宽以下。
      const host = hostRef.current?.offsetParent;
      const available = host instanceof HTMLElement ? host.clientWidth : window.innerWidth;
      // 最大值：可用宽 - 侧栏宽（技能页打开时侧栏不占位）- 主区最小宽 - 手柄宽，
      // 但不超过 720px（避免预览过宽）
      const usedSidebarWidth = marketOpen ? 0 : sidebarWidth;
      const availableMax = Math.max(
        MIN_WIDTH,
        available - usedSidebarWidth - mainMinWidth - RESIZER_WIDTH
      );
      const effectiveMax = Math.min(MAX_WIDTH, availableMax);
      return Math.max(MIN_WIDTH, Math.min(effectiveMax, w));
    },
    [sidebarWidth, mainMinWidth, marketOpen]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsDragging(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
    },
    [width]
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!isDragging) return;
      const delta = startXRef.current - e.clientX;
      const newWidth = clampWidth(startWidthRef.current + delta);
      onWidthChange(newWidth);
    },
    [isDragging, clampWidth, onWidthChange]
  );

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      if (!isDragging) return;
      setIsDragging(false);
      // 松手后持久化（用最新宽度，不是闭包里的旧值）
      try {
        localStorage.setItem(STORAGE_KEY, String(widthRef.current));
      } catch (err) {
        // 忽略 localStorage 错误
      }
    },
    [isDragging]
  );

  const handleDoubleClick = useCallback(() => {
    onWidthChange(DEFAULT_WIDTH);
    try {
      localStorage.setItem(STORAGE_KEY, String(DEFAULT_WIDTH));
    } catch (err) {
      // 忽略
    }
  }, [onWidthChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const newWidth = clampWidth(width + KEYBOARD_STEP);
        onWidthChange(newWidth);
        try {
          localStorage.setItem(STORAGE_KEY, String(newWidth));
        } catch (err) {
          // 忽略
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const newWidth = clampWidth(width - KEYBOARD_STEP);
        onWidthChange(newWidth);
        try {
          localStorage.setItem(STORAGE_KEY, String(newWidth));
        } catch (err) {
          // 忽略
        }
      }
    },
    [width, clampWidth, onWidthChange]
  );

  // 监听全局 pointermove/pointerup（拖动期间）
  useEffect(() => {
    if (!isDragging) return;
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDragging, handlePointerMove, handlePointerUp]);

  // 拖动期间：全局 cursor + 禁止选中
  useEffect(() => {
    if (!isDragging) return;
    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
    };
  }, [isDragging]);

  // 宽度合法化：挂载时先收敛一次（localStorage 里可能是上次更宽窗口的值），
  // 之后跟随窗口尺寸变化。
  useEffect(() => {
    const handleResize = () => {
      const clamped = clampWidth(width);
      if (clamped !== width) {
        onWidthChange(clamped);
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [width, clampWidth, onWidthChange]);

  const effectiveMax = clampWidth(MAX_WIDTH);

  return (
    <div
      ref={hostRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整预览面板宽度"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={effectiveMax}
      tabIndex={0}
      className="h24-preview-resizer"
      data-dragging={isDragging ? 'true' : undefined}
      data-hovered={isHovered ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    />
  );
}

/**
 * 从 localStorage 读取预览宽度，失败回落默认值。
 */
export function loadPreviewWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (!Number.isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
        return parsed;
      }
    }
  } catch (err) {
    // 忽略读取错误
  }
  return DEFAULT_WIDTH;
}
