import { MessageCircle, Settings, Sparkles, Workflow } from 'lucide-react';

/**
 * 034 v3（2026-10-02 用户裁决，参考 Codex 桌面版）：应用级页面导航收进
 * 左侧图标栏——「首页」「技能中心」两个页面 tab＋底部设置入口；对话列表
 * 降为首页页面内面板，技能中心与首页平级、占满主区。顶栏不引入浏览器式
 * 前进/后退与多标签；悬浮球开关随本裁决挪进设置页。图标栏三档常驻
 * （48px，含 375 档），≤880 只收对话列表抽屉。
 *
 * 037 视觉系统：首页图标改对话气泡（首页即对话），当前页白底 shadow-1；
 * 设置成为壳内页面后同样以 data-current 标出。
 */
export function NavRail({
  page,
  onShowHome,
  onShowSkills,
  onShowWorkflows,
  onOpenSettings,
}: {
  page: 'home' | 'skills' | 'workflows' | 'settings';
  onShowHome: () => void;
  onShowSkills: () => void;
  /** 059：工作流页（与技能中心平级，R-01）；可选＝未接线的宿主不显示入口。 */
  onShowWorkflows?: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <nav className="h24-navrail" aria-label="应用导航">
      <button
        type="button"
        className="h24-navrail-item"
        data-current={page === 'home' ? 'true' : undefined}
        aria-current={page === 'home' ? 'page' : undefined}
        onClick={onShowHome}
        title="对话"
        aria-label="对话"
      >
        <MessageCircle className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="h24-navrail-item"
        data-current={page === 'skills' ? 'true' : undefined}
        aria-current={page === 'skills' ? 'page' : undefined}
        onClick={onShowSkills}
        title="技能中心"
        aria-label="技能中心"
      >
        <Sparkles className="size-4" aria-hidden="true" />
      </button>
      {onShowWorkflows ? (
        <button
          type="button"
          className="h24-navrail-item"
          data-current={page === 'workflows' ? 'true' : undefined}
          aria-current={page === 'workflows' ? 'page' : undefined}
          onClick={onShowWorkflows}
          title="工作流"
          aria-label="工作流"
        >
          <Workflow className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      <div className="h24-navrail-spacer" />
      <button
        type="button"
        className="h24-navrail-item"
        data-current={page === 'settings' ? 'true' : undefined}
        aria-current={page === 'settings' ? 'page' : undefined}
        onClick={onOpenSettings}
        title="设置"
        aria-label="设置"
      >
        <Settings className="size-4" aria-hidden="true" />
      </button>
    </nav>
  );
}
