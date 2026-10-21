import { useEffect, useId, useRef, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { X } from 'lucide-react';

const narrowQuery = '(max-width: 600px)';
const isNarrow = () => window.matchMedia(narrowQuery).matches;
const subscribeNarrow = (notify: () => void) => {
  const query = window.matchMedia(narrowQuery);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};

/** 信息浮层：与菜单共用 040 动效 token；Base UI 保留退出节点、处理碰撞与焦点。
 * 菜单项导航仍交给 Menu，此处只承载可交互的信息面板。
 */
export function InfoPopover({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  headerActions,
  openOnHover = false,
  className = '',
  side = 'top',
  align,
  initialFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  title: string;
  description?: ReactNode;
  headerActions?: ReactNode;
  /** 只读信息预览：悬浮打开，不显示关闭按钮或模态遮罩。 */
  openOnHover?: boolean;
  className?: string;
  side?: 'top'|'right'|'bottom'|'left';
  align?: 'start'|'center'|'end';
  initialFocus?: React.ComponentProps<typeof Popover.Popup>['initialFocus'];
  children: ReactNode;
}) {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const suppressFocusOpen = useRef(false);

  useEffect(() => {
    if (!open) return;
    // 先截住 Esc，避免应用的停止／拒绝快捷键同时消费。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressFocusOpen.current = openOnHover;
      onOpenChange(false);
      if (!openOnHover || popupRef.current?.contains(document.activeElement)) {
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onOpenChange, openOnHover]);

  return (
    <Popover.Root open={open} onOpenChange={(nextOpen, details) => {
      // 鼠标点击不把悬浮面板钉住；触屏和键盘继续使用原生按压语义。
      if (openOnHover && details.reason === 'trigger-press' && 'pointerType' in details.event && details.event.pointerType === 'mouse') {
        details.cancel();
        return;
      }
      onOpenChange(nextOpen);
    }} modal={narrow && !openOnHover}>
      <Popover.Trigger
        ref={triggerRef}
        render={trigger}
        openOnHover={openOnHover}
        delay={200}
        closeDelay={140}
        onFocus={openOnHover ? event => {
          if (!suppressFocusOpen.current && event.currentTarget.matches(':focus-visible')) onOpenChange(true);
        } : undefined}
        onBlur={openOnHover ? () => { suppressFocusOpen.current = false; } : undefined}
      />
      <Popover.Portal className="compact-shell" style={{ display: 'contents' }}>
        {/* Portal 容器保持稳定；不能在 ref 就绪后从 body 搬到 shell，打断退出生命周期。 */}
        {!openOnHover ? <Popover.Backdrop className="h37-info-scrim" /> : null}
        <Popover.Positioner
          className={`h37-info-positioner${openOnHover ? ' h37-info-hover-positioner' : ''}`}
          side={side}
          align={align ?? (openOnHover ? 'center' : 'start')}
          sideOffset={8}
          collisionPadding={12}
          positionMethod="fixed"
        >
          <Popover.Popup
            ref={popupRef}
            className={`h37-info-popover${openOnHover ? ' h37-info-hover' : ''} ${className}`}
            aria-labelledby={titleId}
            initialFocus={initialFocus ?? (openOnHover ? false : undefined)}
            finalFocus={openOnHover ? false : undefined}
          >
            <header className="h37-info-head">
              <div className="h37-info-heading">
                <Popover.Title id={titleId} className="h37-info-title">{title}</Popover.Title>
                {description ? <div className="h37-info-description">{description}</div> : null}
              </div>
              {headerActions}
              {!openOnHover ? <Popover.Close className="h37-info-close" aria-label={`关闭${title}`}>
                <X aria-hidden="true" />
              </Popover.Close> : null}
            </header>
            <div className="h37-info-body">{children}</div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
