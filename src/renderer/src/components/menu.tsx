import {
  useEffect,
  useRef,
  useCallback,
  type InputHTMLAttributes,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { Popover } from "@base-ui/react/popover";

interface MenuProps {
  /** 是否显示 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 菜单项（需自行处理 role/tabIndex/data-* 等） */
  children: ReactNode;
  /** 锚点元素引用（用于定位和焦点回归，fixed 定位时可选） */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** 定位方式：'anchor-up'（相对锚点向上）或 'fixed'（固定坐标） */
  placement?: "anchor-up" | "anchor-down" | "fixed";
  /** placement='fixed' 时的坐标 */
  position?: { x: number; y: number };
  /** 最大高度（默认 min(420px, 60vh)） */
  maxHeight?: string;
  /** transform-origin（默认 'top right'） */
  transformOrigin?: string;
  /** 自动聚焦首项（默认 true） */
  autoFocusFirst?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 浮层层级（默认 80；066：顶栏菜单要压过 dev 性能 HUD 的 9999 时按需传更高） */
  zIndex?: number;
}

const enabledMenuItems = (menu: HTMLElement) =>
  Array.from(
    menu.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not([aria-disabled="true"]):not(:disabled)',
    ),
  );

/**
 * 统一的菜单浮层组件（对话窗口下拉规范 v1）
 *
 * 样式：白底、--shadow-2、10px 圆角、无边框、z-index 80
 * 交互：↑↓/Home/End 导航、Enter/Space 确认、Esc/Tab 关闭并回焦点、点外关闭（不回焦）
 * 动画：200ms pop 入场、140ms 淡出退场
 *
 * 使用方式：
 * - 单选菜单项用 role="menuitemradio" aria-checked
 * - 普通菜单项用 role="menuitem"
 * - 选中标记统一在右侧加 lucide Check 图标
 */
export function Menu({
  open,
  onClose,
  children,
  anchorRef,
  placement = "anchor-up",
  position,
  maxHeight = "min(420px, 60vh)",
  transformOrigin = "top right",
  autoFocusFirst = true,
  className = "",
  zIndex = 80,
}: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);

  // 定位（anchor-up 在布局副作用里计算，fixed 直接用传入坐标）
  useEffect(() => {
    if (!open || !menuRef.current) return;
    if (placement === "fixed" && position) {
      const menu = menuRef.current;
      const { x, y } = position;
      // 先放在目标位置，测量后收敛到视口内
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
      menu.style.visibility = "visible";

      const rect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const clampMargin = 8;

      let finalX = x;
      let finalY = y;
      let origin = transformOrigin;

      // 右边溢出：拉回
      if (rect.right > vw - clampMargin) {
        finalX = vw - rect.width - clampMargin;
      }
      // 左边溢出
      if (finalX < clampMargin) {
        finalX = clampMargin;
      }

      // 下边溢出：翻转到上方
      if (rect.bottom > vh - clampMargin) {
        finalY = y - rect.height;
        origin = "bottom right";
      }
      // 翻转后仍溢出顶部
      if (finalY < clampMargin) {
        finalY = clampMargin;
      }

      menu.style.left = `${finalX}px`;
      menu.style.top = `${finalY}px`;
      menu.style.setProperty("--transform-origin", origin);
    }
  }, [open, placement, position, anchorRef, transformOrigin]);

  // 关闭；restoreFocus 只在键盘关闭（Esc/Tab）时回焦锚点——点外关闭时焦点
  // 跟随用户点到的位置，不能被拽回锚点。
  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      if (closingRef.current) return;
      closingRef.current = true;
      const menu = menuRef.current;
      const finish = () => {
        onClose();
        if (restoreFocus) anchorRef?.current?.focus({ preventScroll: true });
        closingRef.current = false;
        if (menu) menu.dataset.closing = "";
      };
      if (menu) {
        menu.dataset.closing = "true";
        setTimeout(finish, 140);
      } else {
        finish();
      }
    },
    [onClose, anchorRef],
  );

  // 自动聚焦首个可达项；没有可聚焦项（或调用方未自行聚焦菜单内元素）时聚焦
  // 菜单容器本身，保证键盘处理（↑↓/Tab/Esc）有落点。
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const menu = menuRef.current;
    if (autoFocusFirst) {
      const firstItem = enabledMenuItems(menu)[0];
      if (firstItem) {
        firstItem.focus({ preventScroll: true });
        return;
      }
    }
    if (!menu.contains(document.activeElement)) menu.focus({ preventScroll: true });
  }, [open, autoFocusFirst]);

  // Esc：捕获阶段先于其他窗口级 Esc 处理（任务确认卡把 Esc 当拒绝），
  // 截住后只关菜单。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeMenu(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, closeMenu]);

  // 键盘导航
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!menuRef.current) return;
      if (e.key === "Tab") {
        e.preventDefault();
        closeMenu(true);
        return;
      }
      const items = enabledMenuItems(menuRef.current);
      if (items.length === 0) return;

      const current = document.activeElement as HTMLElement;
      const index = items.indexOf(current);
      // 搜索框里的上下键在这里转成菜单焦点巡航；交给原生输入层时仍被视为文字编辑。
      // 显式进入键盘模态，随后 Enter 才能激活菜单项并显示焦点环。
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key))
        document.documentElement.classList.add("kb-nav");

      switch (e.key) {
        case "Enter":
        case " ":
          if (index >= 0) {
            e.preventDefault();
            e.stopPropagation();
            items[index].click();
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          items[(index + 1) % items.length]?.focus({ preventScroll: true });
          break;
        case "ArrowUp":
          e.preventDefault();
          items[(index - 1 + items.length) % items.length]?.focus({ preventScroll: true });
          break;
        case "Home":
          e.preventDefault();
          items[0]?.focus({ preventScroll: true });
          break;
        case "End":
          e.preventDefault();
          items[items.length - 1]?.focus({ preventScroll: true });
          break;
      }
    },
    [closeMenu],
  );

  // 点外关闭（捕获阶段，在锚点的 click 冒泡前处理）；不回焦锚点
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: globalThis.PointerEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        (!anchorRef?.current || !anchorRef.current.contains(target))
      ) {
        closeMenu(false);
      }
    };
    const handleResize = () => closeMenu(false);
    // 菜单自身（长列表）滚动不算外部滚动，否则一滚就收
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, closeMenu, anchorRef]);

  if (!open) return null;

  const menuNode = (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      className={`h37-menu ${className}`}
      data-placement={placement}
      onKeyDown={handleKeyDown}
      style={{
        position: placement === "fixed" ? "fixed" : undefined,
        maxHeight,
        overflowY: "auto",
        // fixed 需先测量再定位，测量前隐藏；anchor-up 由 CSS 绝对定位，无需测量
        visibility: placement === "fixed" ? "hidden" : undefined,
      }}
    >
      {children}
    </div>
  );

  if (placement === "fixed") return createPortal(menuNode, document.body);
  if (!anchorRef) return menuNode;
  // 库负责锚点定位、翻转与视口约束，菜单不再受滚动容器裁切。
  return (
    <Popover.Root open modal={false}>
      <Popover.Portal
        container={
          anchorRef.current?.closest<HTMLElement>(".compact-shell") ??
          document.body
        }
        style={{ display: "contents" }}
      >
        <Popover.Positioner
          anchor={anchorRef}
          side={placement === "anchor-down" ? "bottom" : "top"}
          align="start"
          sideOffset={placement === "anchor-down" ? 16 : 8}
          collisionPadding={placement === "anchor-down" ? 16 : 8}
          positionMethod="fixed"
          style={{ zIndex }}
        >
          <Popover.Popup
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            className={`h37-menu ${className}`}
            data-placement={placement}
            onKeyDown={handleKeyDown}
            initialFocus={
              autoFocusFirst
                ? () =>
                    menuRef.current
                      ? (enabledMenuItems(menuRef.current)[0] ??
                        menuRef.current)
                      : false
                : false
            }
            finalFocus={false}
            style={{
              position: "relative",
              left: "auto",
              right: "auto",
              bottom: "auto",
              maxHeight: `min(${maxHeight},var(--available-height))`,
              overflowY: "auto",
            }}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * 菜单顶部搜索行：无框输入＋放大镜，底部一条分隔线，滚动时吸顶（不再框中套框）。
 */
export function MenuSearch({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="h37-menu-search">
      <Search aria-hidden="true" />
      <input
        type="search"
        className={`h37-menu-search-input ${className}`}
        {...props}
      />
    </div>
  );
}

/**
 * 菜单项（单行，32px/13px）
 */
interface MenuItemProps {
  icon?: ReactNode;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  role?: "menuitem" | "menuitemradio";
}

export function MenuItem({
  icon,
  label,
  checked,
  disabled,
  danger,
  onClick,
  role = "menuitem",
}: MenuItemProps) {
  const handleClick = () => {
    if (disabled) return;
    onClick?.();
  };

  return (
    <button
      role={role}
      aria-checked={role === "menuitemradio" ? checked : undefined}
      aria-disabled={disabled}
      className="h37-menu-item"
      data-danger={danger || undefined}
      onClick={handleClick}
      tabIndex={-1}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {checked && (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, color: "var(--body)" }}
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </button>
  );
}

/**
 * 菜单分隔线
 */
export function MenuSeparator() {
  return <div className="h37-menu-sep" />;
}

/**
 * 菜单分组标题
 */
export function MenuGroup({ label }: { label: string }) {
  return (
    <div
      style={{
        fontSize: "var(--fs-12)",
        color: "var(--faint)",
        padding: "var(--sp-4) var(--sp-10)",
        marginTop: "var(--sp-2)",
      }}
    >
      {label}
    </div>
  );
}
