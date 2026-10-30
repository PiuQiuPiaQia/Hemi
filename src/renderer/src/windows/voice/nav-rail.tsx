import { Activity, Bot, MessageCircle, Settings, Workflow, type LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { SkinPicker } from '@/components/skin-picker';
import { UpdateButton } from './update-button';
import { useApplicationNavigation, type ApplicationPage } from './lib/conversation-bridge';

/** Global destinations stay in the same order in every runtime and page.
 * Standalone previews can supply local handlers without the application provider.
 */
export function NavRail({
  page,
  onShowHome,
  homePreviewProps,
  onShowWorkflows,
  onShowUsage,
  onOpenSettings,
}: {
  page: ApplicationPage;
  onShowHome?: () => void;
  homePreviewProps?: Pick<ComponentProps<'button'>, 'id' | 'aria-controls' | 'aria-expanded' | 'onPointerEnter' | 'onPointerLeave' | 'onFocusCapture' | 'onBlurCapture'>;
  onShowWorkflows?: () => void;
  onShowUsage?: () => void;
  onOpenSettings?: () => void;
}) {
  const navigation = useApplicationNavigation();
  const current = navigation?.page ?? page;
  const item = (target: ApplicationPage, label: string, Icon: LucideIcon, fallback?: () => void) => {
    const selected = current === target;
    const conversation = target === 'home' || target === 'bot';
    return (
      <button
        key={target}
        type="button"
        className="h24-navrail-item"
        data-page={target}
        data-current={selected ? 'true' : undefined}
        aria-current={selected ? 'page' : undefined}
        aria-label={label}
        title={label}
        onClick={() => {
          // Pressing the current conversation icon opens its conversation drawer.
          // It must never reinitialize the Bot runtime or stop a session again.
          if (selected) {
            if (conversation) onShowHome?.();
            return;
          }
          if (navigation) navigation.navigate(target);
          else fallback?.();
        }}
        {...(selected && conversation ? homePreviewProps : {})}
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
    );
  };

  return (
    <nav className="h24-navrail" aria-label="应用导航">
      <div className="h24-navrail-pages">
        <div className="h24-navrail-group" role="group" aria-label="对话空间">
          {item('home', '对话', MessageCircle, onShowHome)}
          {navigation ? item('bot', 'Bot', Bot) : null}
        </div>
        {navigation || onShowWorkflows || onShowUsage ? <>
          <div className="h24-navrail-divider" aria-hidden="true" />
          <div className="h24-navrail-group" role="group" aria-label="扩展工具">
            {/* 2026-10-30：技能中心收进设置页（本地与 Bot 一致），图标栏不再单列入口。 */}
            {navigation || onShowWorkflows ? item('workflows', '工作流', Workflow, onShowWorkflows) : null}
            {navigation || onShowUsage ? item('usage', '使用记录', Activity, onShowUsage) : null}
          </div>
        </> : null}
      </div>
      <div className="h24-navrail-spacer" aria-hidden="true" />
      <div className="h24-navrail-group h24-navrail-tools" role="group" aria-label="应用偏好">
        <UpdateButton />
        <SkinPicker />
        {item('settings', '设置', Settings, onOpenSettings)}
      </div>
    </nav>
  );
}
