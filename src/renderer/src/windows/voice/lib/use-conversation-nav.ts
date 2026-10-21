import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, PointerEvent } from 'react';

/** The collapsed list can be previewed by hover/focus or kept open by a click. */
export function useConversationNav(page: 'home' | 'skills' | 'workflows') {
  const [media] = useState(() => window.matchMedia('(max-width: 880px)'));
  const [collapsed, setCollapsed] = useState(media.matches);
  const [mode, setMode] = useState<'preview' | 'pinned' | null>(null);
  const closeTimer = useRef<number | null>(null);
  const focusedElement = useRef<EventTarget | null>(null);
  const sidebarId = useId();
  const triggerId = useId();

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const close = useCallback(() => {
    cancelClose();
    setMode(null);
  }, [cancelClose]);
  const preview = useCallback(() => {
    if (!collapsed || page !== 'home') return;
    cancelClose();
    setMode((current) => current ?? 'preview');
  }, [collapsed, page, cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    // Leave enough time to cross the gap between the rail icon and the list.
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      // A sliding drawer can briefly change the pointer target. Recheck the
      // actual hovered region before acting on an earlier leave event.
      const hovered = [sidebarId, triggerId].some((id) => document.getElementById(id)?.matches(':hover'));
      // Removing a focused portalled menu does not always emit blur.
      if (!hovered && focusedElement.current !== document.activeElement) {
        setMode((current) => current === 'preview' ? null : current);
      }
    }, 200);
  }, [cancelClose, sidebarId, triggerId]);

  useEffect(() => {
    const resize = () => { setCollapsed(media.matches); close(); };
    media.addEventListener('change', resize);
    return () => { media.removeEventListener('change', resize); cancelClose(); };
  }, [media, close, cancelClose]);
  useEffect(close, [page, close]);
  useEffect(() => {
    if (!mode || !collapsed) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      // Focus first: the focus preview must not reopen a just-dismissed list.
      if (document.getElementById(sidebarId)?.contains(document.activeElement)) {
        document.getElementById(triggerId)?.focus();
      }
      close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [mode, collapsed, sidebarId, triggerId, close]);

  const interactionProps = {
    onPointerEnter: (event: PointerEvent) => { if (event.pointerType !== 'touch') preview(); },
    onPointerLeave: scheduleClose,
    // React focus events include the list's portalled context menu, so keyboard
    // navigation and renaming stay open even when the pointer leaves the list.
    onFocusCapture: (event: FocusEvent) => {
      focusedElement.current = event.target;
      cancelClose();
      // Portalled dialogs may focus after explicitly closing the drawer.
      // Only focus on the icon/list itself starts a new preview.
      if (event.currentTarget.contains(event.target)) preview();
    },
    onBlurCapture: () => { focusedElement.current = null; scheduleClose(); },
  };

  return {
    collapsed,
    open: mode !== null,
    previewOnly: mode === 'preview',
    close,
    toggle: () => { cancelClose(); setMode((current) => current === 'pinned' ? null : 'pinned'); },
    sidebarProps: { id: sidebarId, ...interactionProps },
    triggerProps: {
      id: triggerId,
      'aria-controls': collapsed && page === 'home' ? sidebarId : undefined,
      'aria-expanded': collapsed && page === 'home' ? mode !== null : undefined,
      ...interactionProps,
      onFocusCapture: (event: FocusEvent) => {
        // Clicking the icon must not keep later hover previews open forever.
        focusedElement.current = null;
        if (event.target.matches(':focus-visible')) interactionProps.onFocusCapture(event);
      },
    },
  };
}
