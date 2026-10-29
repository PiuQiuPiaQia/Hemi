import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { APP_MENU_GROUPS, type AppMenuCommand, type AppMenuId } from '@shared/app-menu.mjs';
import { useApplicationNavigation, type ApplicationPage } from '@/windows/voice/lib/conversation-bridge';

export function WindowsMenuBar({ onNewConversation, onOpenWorkspace }: {
  onNewConversation?: () => void;
  onOpenWorkspace?: () => void;
}) {
  const navigation = useApplicationNavigation();
  const [open, setOpen] = useState<AppMenuId | null>(null);
  const [error, setError] = useState('');
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const lastInput = useRef<HTMLElement | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const handlers: Partial<Record<AppMenuCommand, () => void>> = {
    ...(onNewConversation ? { 'new-conversation': onNewConversation } : {}),
    ...(onOpenWorkspace ? { 'open-workspace': onOpenWorkspace } : {}),
    logs: () => { void window.hemiVoice.revealLogFile(); },
    ...(navigation ? Object.fromEntries(['home', 'bot', 'skills', 'workflows', 'usage', 'settings'].map(page =>
      [page, () => navigation.navigate(page as ApplicationPage)])) : {}),
  };

  const show = async (menu: AppMenuId, button: HTMLButtonElement) => {
    if (pending.current || !window.hemiVoice?.showAppMenu) return;
    pending.current = true;
    setOpen(menu);
    setError('');
    const rect = button.getBoundingClientRect();
    // A native Edit menu must operate on the text field that preceded the menubar.
    if (lastInput.current?.isConnected) lastInput.current.focus({ preventScroll: true });
    try {
      const command = await window.hemiVoice.showAppMenu({ menu, x: rect.left, y: rect.bottom,
        enabledCommands: Object.keys(handlers) as AppMenuCommand[] });
      if (mounted.current && command) handlers[command]?.();
    } catch {
      if (mounted.current) setError('菜单暂时无法打开');
    } finally {
      pending.current = false;
      if (mounted.current) setOpen(null);
    }
  };
  const showRef = useRef(show);
  showRef.current = show;

  useEffect(() => {
    mounted.current = true;
    const rememberInput = () => {
      const element = document.activeElement;
      if (element instanceof HTMLElement && element.matches('input, textarea, [contenteditable="true"]')) lastInput.current = element;
    };
    rememberInput();
    document.addEventListener('focusin', rememberInput);
    const shortcut = (event: KeyboardEvent) => {
      if (window.hemiVoice?.platform !== 'win32' || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.isComposing) return;
      // Modal dialogs retain their own keyboard scope.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.key === 'F10' && !event.altKey) {
        event.preventDefault();
        buttons.current.find(button => button?.getClientRects().length)?.focus();
      } else if (event.altKey) {
        const index = APP_MENU_GROUPS.findIndex(group => group.accessKey === event.key.toLowerCase());
        const button = buttons.current[index];
        if (index >= 0 && button) {
          event.preventDefault();
          const visible = button.getClientRects().length ? button : buttons.current[4];
          if (visible) void showRef.current(APP_MENU_GROUPS[index].id, visible);
        }
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => {
      mounted.current = false;
      document.removeEventListener('focusin', rememberInput);
      window.removeEventListener('keydown', shortcut);
    };
  }, []);

  return <>
    <div className="app-menubar" role="menubar" aria-label="应用菜单">
      {[...APP_MENU_GROUPS, { id: 'all' as const, label: '菜单', accessKey: '' }].map((group, index) =>
        <button key={group.id} ref={element => { buttons.current[index] = element; }} type="button" role="menuitem"
          className={group.id === 'all' ? 'app-menubar-compact' : 'app-menubar-item'}
          aria-haspopup="menu" aria-expanded={open === group.id} aria-keyshortcuts={group.accessKey ? `Alt+${group.accessKey.toUpperCase()}` : undefined}
          tabIndex={index === 0 || index === 4 ? 0 : -1}
          disabled={!window.hemiVoice?.showAppMenu}
          onMouseDown={event => event.preventDefault()}
          onClick={event => void show(group.id, event.currentTarget)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); void show(group.id, event.currentTarget);
            } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const visible = buttons.current.filter(button => button?.getClientRects().length);
              const current = visible.indexOf(event.currentTarget);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
              visible[next]?.focus();
            }
          }}>
          {group.label}{group.id === 'all' ? <ChevronDown size={12} aria-hidden="true" /> : null}
        </button>)}
    </div>
    {error ? <span className="app-menubar-error" role="status">{error}</span> : null}
  </>;
}
