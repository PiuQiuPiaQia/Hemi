import { cloneElement, type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './tooltip.css';

interface TooltipProps {
  content: ReactNode;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  /** 延迟显示（毫秒），默认300 */
  delay?: number;
}

/**
 * 精致Tooltip组件：支持鼠标悬浮、键盘focus、深浅色、边缘防裁切、Portal防遮挡。
 */
export function Tooltip({ content, children, delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState<boolean>(false);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tooltipId = useId();

  const updatePosition = () => {
    if (!triggerRef.current || !tooltipRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const tooltipHeight = tooltipRect.height;
    const tooltipWidth = tooltipRect.width;

    // 默认在上方居中
    let top = triggerRect.top - tooltipHeight - 8;
    let left = triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2;

    // 边缘检测：顶部溢出时显示在下方
    if (top < 8) {
      top = triggerRect.bottom + 8;
    }

    // 左右边缘防裁切
    if (left < 8) {
      left = 8;
    } else if (left + tooltipWidth > window.innerWidth - 8) {
      left = window.innerWidth - tooltipWidth - 8;
    }

    setPosition({ top, left });
  };

  const show = () => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setVisible(true);
      setMounted(true);
    }, delay);
  };

  const hide = () => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
    }
    setVisible(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && visible) {
      hide();
    }
  };

  useEffect(() => {
    if (visible && mounted) {
      // 等待渲染完成后测量真实尺寸
      requestAnimationFrame(() => {
        updatePosition();
      });
    }
  }, [visible, mounted]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const tooltipElement = visible && mounted ? (
    <div
      ref={tooltipRef}
      id={tooltipId}
      className="h37-tooltip"
      style={{ top: `${position.top}px`, left: `${position.left}px` }}
      role="tooltip"
    >
      {content}
    </div>
  ) : null;

  return (
    <>
      <span
        ref={triggerRef}
        className="h37-tooltip-trigger"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={handleKeyDown}
      >
        {cloneElement(children, {
          'aria-describedby': [children.props['aria-describedby'], visible ? tooltipId : undefined].filter(Boolean).join(' ') || undefined,
        })}
      </span>
      {tooltipElement && createPortal(tooltipElement, document.body)}
    </>
  );
}
