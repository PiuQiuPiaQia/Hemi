import { useCallback, useEffect, useRef, useState } from 'react';

import { ShieldCheck, ChevronDown } from 'lucide-react';
import { InfoPopover } from '@/components/info-popover';

import type { AccessStateDto } from '@shared/protocol';

/**
 * 042 · 访问范围浮层：盾牌触发，只读展示 Hemi 当前能操作的应用（持续授权＋进行中任务的
 * 本次授权；其他已结束任务的临时授权不展示），管理入口进设置 → 电脑与浏览器 → 访问授权。
 * 2026-10-15 文件夹授权退役：文件读写不需要授权，这里只列应用。
 */

type AccessGrantRow = AccessStateDto['grants'][number];

function describeGrant(
  grant: AccessGrantRow,
  resources: AccessStateDto['resources'],
): { key: string; title: string; sub: string } {
  const resource = resources.find((r) => r.resourceId === grant.resourceId);
  return {
    key: grant.grantId,
    title: resource?.displayName ?? grant.resourceId.replace(/^app:/, ''),
    sub: grant.lifetime === 'persistent' ? '持续授权' : '本次对话',
  };
}

export function ScopePopover({
  demoOpen = false,
  activeTaskIds = [],
  onManage,
}: {
  demoOpen?: boolean;
  /** 进行中任务的 taskId（本任务授权只展示这些任务的）。 */
  activeTaskIds?: string[];
  /** 「管理访问授权」→ 设置 → 电脑与浏览器 → 访问授权。 */
  onManage?: () => void;
} = {}) {
  const [open, setOpen] = useState(demoOpen);
  const [state, setState] = useState<AccessStateDto | null>(null);
  const revisionRef = useRef(-1);

  const refresh = useCallback(() => {
    void window.hemiVoice
      ?.accessGetState?.()
      .then((dto) => {
        if (!dto) return;
        // 并发读面：迟到的旧 revision 回包不得覆盖较新的状态。
        if (typeof dto.revision === 'number' && dto.revision < revisionRef.current) return;
        revisionRef.current = typeof dto.revision === 'number' ? dto.revision : revisionRef.current;
        setState(dto);
      })
      .catch(() => {});
  }, []);

  // P1：触发键要显示授权数，状态常驻订阅（不再只在展开时读）。
  useEffect(() => {
    refresh();
    return window.hemiVoice?.onAccessChanged?.(refresh);
  }, [refresh]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const activeSet = new Set(activeTaskIds);
  const rows = (state?.grants ?? [])
    .filter((g) => g.resourceId.startsWith('app:')) // 旧档残留的文件夹授权不展示
    .filter((g) => g.lifetime === 'persistent' || (g.taskId != null && activeSet.has(g.taskId)))
    .map((g) => describeGrant(g, state?.resources ?? []));

  return (
    <InfoPopover
      open={open}
      onOpenChange={setOpen}
      title="访问范围"
      description={rows.length ? `${rows.length} 个应用` : '暂无授权'}
      className="h37-scope-panel"
      trigger={(
        <button
          type="button"
          className="h37-tool"
          data-compact={rows.length ? undefined : 'true'}
          aria-label={rows.length ? `访问范围：${rows.length} 个应用` : '访问范围：暂无应用授权'}
          title="访问范围：Hemi 当前能操作哪些应用"
        >
          <ShieldCheck aria-hidden="true" />
          <span className="h37-tool-label">{`${rows.length} 个应用`}</span>
          <ChevronDown className="h37-tool-chev" aria-hidden="true" />
        </button>
      )}
    >
      {rows.length ? (
        <ul className="scope-popover-list" aria-label="已授权的应用">
          {rows.slice(0, 8).map((row) => (
            <li key={row.key} className="scope-popover-item">
              <span className="scope-popover-title" title={row.title}>{row.title}</span>
              <span className="scope-popover-sub">{row.sub}</span>
            </li>
          ))}
          {rows.length > 8 ? <li className="scope-popover-more">…共 {rows.length} 项</li> : null}
        </ul>
      ) : (
        <p className="scope-popover-empty">操作应用前会向你申请授权。</p>
      )}
      <div className="scope-popover-foot">
        <button
          type="button"
          className="text-btn"
          onClick={() => {
            setOpen(false);
            onManage?.();
          }}
        >
          管理应用授权 →
        </button>
      </div>
    </InfoPopover>
  );
}
