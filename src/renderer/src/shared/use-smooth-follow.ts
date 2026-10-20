'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefCallback,
} from 'react';

import { followAfterScroll, followStep } from './smooth-follow-math';

/** 距底部多近算「贴着底部」，低于它就恢复跟随。 */
const PIN_THRESHOLD_PX = 36;

type SmoothFollowHandlers = {
  onScroll: () => void;
  onWheel: (event: WheelEvent) => void;
  onTouchMove: (event: TouchEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  resizeObserver: ResizeObserver;
};

declare global {
  interface HTMLElement {
    __smoothFollow?: SmoothFollowHandlers;
  }
}
/** 每帧向目标靠近的比例：0.22 ≈ 220ms 内基本到位，流式时连续重定向不打断。 */
const APPROACH_RATIO = 0.22;

/**
 * 聊天区的平滑跟随滚动：
 * - 内容增长（新消息 / 流式增量）时用 rAF 指数逼近滑到底部，避免逐字跳动的生硬感；
 * - 用户明确上滚（滚轮 / 触摸 / 上翻键）即暂停跟随，露出「回到底部」；
 * - 重新贴近底部后自动恢复跟随。
 *
 * `scrollSelector` 用于在绑定的容器里找真正的滚动元素
 * （Base UI ScrollArea 的滚动发生在 viewport 子节点上）。
 */
export function useSmoothFollow<T extends HTMLElement>(
  scrollSelector?: string,
): {
  bindRef: RefCallback<T>;
  pinned: boolean;
  follow: () => void;
  scrollToBottom: () => void;
  resetToBottom: () => void;
} {
  const scrollElRef = useRef<HTMLElement | null>(null);
  const pinnedRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const [pinned, setPinned] = useState(true);

  const setPinnedState = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  const stopAnimation = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const animateToBottom = useCallback(() => {
    if (rafRef.current !== null) return; // 已在动画中：目标每帧重算，天然支持重定向
    const step = () => {
      rafRef.current = null;
      const el = scrollElRef.current;
      if (!el || !pinnedRef.current) return;
      const target = el.scrollHeight - el.clientHeight;
      const before = el.scrollTop;
      const { next, done } = followStep(before, target, APPROACH_RATIO);
      el.scrollTop = next;
      // 到位，或浏览器取整/夹紧让这一步没走动：结束，绝不留每帧空转的 rAF。
      if (done || Math.abs(el.scrollTop - before) < 0.5) return;
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  const follow = useCallback(() => {
    if (!pinnedRef.current) return;
    animateToBottom();
  }, [animateToBottom]);

  const scrollToBottom = useCallback(() => {
    setPinnedState(true);
    stopAnimation();
    animateToBottom();
  }, [animateToBottom, setPinnedState, stopAnimation]);

  // 历史载入属于定位：由调用方在布局阶段执行，首帧前到位，不能复用流式缓动。
  const resetToBottom = useCallback(() => {
    setPinnedState(true);
    stopAnimation();
    const el = scrollElRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [setPinnedState, stopAnimation]);

  const bindRef = useCallback(
    (node: T | null) => {
      stopAnimation();
      const previous = scrollElRef.current;
      if (previous?.__smoothFollow) {
        const handlers = previous.__smoothFollow;
        previous.removeEventListener('scroll', handlers.onScroll);
        previous.removeEventListener('wheel', handlers.onWheel);
        previous.removeEventListener('touchmove', handlers.onTouchMove);
        previous.removeEventListener('keydown', handlers.onKeyDown);
        handlers.resizeObserver.disconnect();
      }
      scrollElRef.current = null;

      if (!node) return;
      const el = (
        scrollSelector ? node.querySelector<HTMLElement>(scrollSelector) : node
      );
      if (!el) return;

      // 滚动后的跟随判定（smooth-follow-math）：往下回到底部附近才恢复跟随；
      // 往上（含拖滚动条）暂停——轻轻上滑停在阈值内不再被拽回底部。
      let lastTop = el.scrollTop;
      let lastHeight = el.clientHeight;
      let lastContentHeight = el.scrollHeight;
      const onScroll = () => {
        const movedBy = el.scrollTop - lastTop;
        lastTop = el.scrollTop;
        const resized = lastHeight !== el.clientHeight || lastContentHeight !== el.scrollHeight;
        lastHeight = el.clientHeight;
        lastContentHeight = el.scrollHeight;
        // 布局夹紧 scrollTop 不代表用户上翻。明确的滚轮／触摸／按键仍先暂停，
        // 不把队列收起、工具折叠导致的自动位移当成阅读意图。
        if (resized) { follow(); return; }
        const decision = followAfterScroll(
          el.scrollHeight - el.scrollTop - el.clientHeight,
          movedBy,
          PIN_THRESHOLD_PX,
        );
        if (decision === 'pin') setPinnedState(true);
        else if (decision === 'unpin') {
          setPinnedState(false);
          stopAnimation();
        }
      };
      // 只有明确的「往上翻」才取消跟随，程序自己滚过去不算。
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY < 0) {
          setPinnedState(false);
          stopAnimation();
        }
      };
      let lastTouchY: number | null = null;
      const onTouchMove = (event: TouchEvent) => {
        const first = event.touches[0];
        const previousY = lastTouchY;
        lastTouchY = first?.clientY ?? null;
        if (previousY !== null && first && first.clientY > previousY + 1) {
          setPinnedState(false);
        }
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
          setPinnedState(false);
        }
      };

      // 尺寸变化独立于消息条数：队列展开／停止标记／流式工具内容都可能改变
      // 视口或内容高度。只在原本跟随时重定向，用户上翻后保持阅读位置。
      const resizeObserver = new ResizeObserver(() => {
        lastHeight = el.clientHeight;
        lastContentHeight = el.scrollHeight;
        lastTop = el.scrollTop;
        follow();
      });
      resizeObserver.observe(el);
      if (el.firstElementChild) resizeObserver.observe(el.firstElementChild);

      el.__smoothFollow = { onScroll, onWheel, onTouchMove, onKeyDown, resizeObserver };
      el.addEventListener('scroll', onScroll, { passive: true });
      el.addEventListener('wheel', onWheel, { passive: true });
      el.addEventListener('touchmove', onTouchMove, { passive: true });
      el.addEventListener('keydown', onKeyDown);
      el.scrollTop = el.scrollHeight;
      lastTop = el.scrollTop;
      scrollElRef.current = el;
    },
    [scrollSelector, setPinnedState, stopAnimation, follow],
  );

  useEffect(() => stopAnimation, [stopAnimation]);

  return { bindRef, pinned, follow, scrollToBottom, resetToBottom };
}
