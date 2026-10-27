import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import type { HemiVoiceBridge, ModelProfilesDirectory, RoleModelSlot, RoleModelsView } from '@/shared/types';
import { Pick } from '@/windows/voice/model-profiles-section';

/**
 * 056 · 模型路由弹窗（2026-10-14 用户裁决：普通模型配置与自动路由是两个功能，路由在弹窗里配）。
 *
 * 对话模型菜单选「自动路由」时生效：主 agent（必填）、四个子 agent 角色（空＝同主 agent）、
 * 备用模型（只在自动路由下生效）。全部手动选择、逐项即时保存，失败标在对应行并可重试。
 * 两个入口打开同一个弹窗：设置 → 模型 的「模型路由」卡，以及对话模型菜单里自动路由旁的配置。
 */

/** 角色职责（一句话，面向用户；完整定义在 src/main/agent/roles/*.md）。 */
const ROLE_DUTY: Record<string, string> = {
  explorer: '只读：查文件、查资料，返回摘要',
  oracle: '只读：架构决策、疑难排错、评审',
  fixer: '动手：改代码、跑命令、浏览器与桌面',
  designer: '界面设计与实现，按任务检查图像能力',
};

/** 下拉的「未配置」哨兵值（映射回 null）。 */
const UNSET = '__unset__';

/** fixtures：预置视图、目录与失败态（截图取证用；生产不传）。 */
export type ModelRoutingFixture = { view: RoleModelsView; directory: ModelProfilesDirectory; error?: { slot: RoleModelSlot; message: string } };

export function ModelRoutingDialog({ onClose, fixture = null, api }: { onClose: () => void; fixture?: ModelRoutingFixture | null; api?: HemiVoiceBridge }) {
  const bridge = api ?? window.hemiVoice;
  const fixturePreset = fixture;
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<RoleModelsView | null>(() => fixturePreset?.view ?? null);
  const [directory, setDirectory] = useState<ModelProfilesDirectory | null>(() => fixturePreset?.directory ?? null);
  const [saving, setSaving] = useState<RoleModelSlot | null>(null);
  const [error, setError] = useState<{ slot: RoleModelSlot; message: string } | null>(() => fixturePreset?.error ?? null);
  const [loading, setLoading] = useState(!fixturePreset);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const savePending = useRef(false);
  const lastPatch = useRef<{ slot: RoleModelSlot; value: string | null } | null>(null);

  useEffect(() => {
    if (fixturePreset?.view) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setLoadError(null);
    void Promise.race([
      Promise.all([bridge.getRoleModels(), bridge.listModelProfiles()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('读取模型路由超时，请检查连接后重新读取。')), 20000);
      }),
    ])
      .then(([nextView, nextDirectory]) => {
        if (!alive) return;
        if (!nextView?.slots || !nextDirectory?.providers) throw new Error('未能读取完整的模型路由，请重新读取。');
        setView(nextView);
        setDirectory(nextDirectory);
      })
      .catch(failure => {
        if (alive) setLoadError(failure instanceof Error ? failure.message : '未能读取模型路由，请重新读取。');
      })
      .finally(() => {
        clearTimeout(timer);
        if (alive) setLoading(false);
      });
    return () => { alive = false; clearTimeout(timer); };
  }, [bridge, fixturePreset, readAttempt]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('select:not(:disabled), button')?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  const setSlot = useCallback(async (slot: RoleModelSlot, value: string | null) => {
    if (savePending.current || loading || loadError || !view || !directory) return;
    savePending.current = true;
    setSaving(slot);
    try {
      const result = await bridge.saveRoleModel({ [slot]: value });
      if (!result?.ok) throw new Error('主进程没有确认模型路由');
      setView({ roles: result.roles, slots: result.slots, ready: result.ready });
      setError((prev) => (prev?.slot === slot ? null : prev));
    } catch (failure) {
      lastPatch.current = { slot, value };
      setError({ slot, message: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      savePending.current = false;
      setSaving(null);
    }
  }, [bridge, directory, loadError, loading, view]);

  const modelLabel = (modelKey: string | null) => {
    if (!modelKey) return null;
    for (const provider of directory?.providers ?? []) {
      const model = provider.models.find((entry) => entry.modelKey === modelKey);
      if (model) return { model: model.model, provider: provider.name };
    }
    return { model: '（型号已不存在）', provider: undefined };
  };
  const mainLabel = modelLabel(view?.slots.main.modelKey ?? null);
  const followMain = mainLabel ? `同主 agent（${mainLabel.model}）` : '同主 agent';

  const row = (slot: RoleModelSlot, label: string, unsetText: string, hint?: string) => {
    const state = view?.slots[slot];
    const manual = state?.modelKey ?? null;
    const chosen = modelLabel(manual);
    const warning = state && !state.ready
      ? state.reason === 'no-vision' ? '选的模型不支持看图' : '选的模型已不存在，请重选'
      : null;
    return (
      <div key={slot}>
        <div className="h37-row h37m-use-row" data-route-slot={slot}>
          <span className="h37-row-text">
            <b>{label}</b>
            {warning ? <span className="h56-role-warn">{warning}</span> : hint ? <span>{hint}</span> : null}
          </span>
          <span className="h37-row-end">
            <Pick
              label={label}
              value={manual ?? UNSET}
              display={chosen ? chosen.model : unsetText}
              sub={chosen?.provider}
              disabled={saving !== null || loading || !!loadError || !view || !directory}
              onChange={(next) => void setSlot(slot, next === UNSET ? null : next)}
            >
              <option value={UNSET}>{unsetText}</option>
              {(directory?.providers ?? []).map((provider) => (
                <optgroup key={provider.id} label={provider.name}>
                  {provider.models.map((model) => (
                    <option key={model.modelKey} value={model.modelKey} disabled={!provider.hasApiKey}>
                      {model.model}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Pick>
          </span>
        </div>
        {error?.slot === slot ? (
          <div className="h37m-auto-error" role="alert" data-route-error={slot}>
            <span>{error.message}</span>
            <button
              type="button"
              className="h37-btn h37-btn-secondary"
              disabled={saving !== null || loading || !!loadError}
              onClick={() => lastPatch.current && void setSlot(lastPatch.current.slot, lastPatch.current.value)}
            >
              重试
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  return createPortal(
    <div
      className="h37-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="h37-dialog h56-route-dialog h64-route-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="h56-route-head">
          <h3 id={titleId}>模型路由</h3>
          <button type="button" className="h37-access-dialog-close" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="h64-route-content" aria-busy={loading || saving !== null}>
        {loadError ? <div className="h37m-auto-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="h37-btn h37-btn-secondary" onClick={() => setReadAttempt(value => value + 1)}>重新读取</button>
        </div> : null}
        {directory && !directory.providers.length ? (
          <p className="h56-route-empty">还没有可选的模型：先在 设置 → 模型 添加供应商。</p>
        ) : (
          <>
            <div className="h37-group h56-route-group">
              {row('main', '主 agent', '未配置', '与你对话，也能直接执行；按需调用专家')}
            </div>
            <div className="h56-route-label">子 agent</div>
            <div className="h37-group h56-route-group">
              {(view?.roles ?? []).map((role) =>
                row(role.name, `${role.title} ${role.name}`, followMain, ROLE_DUTY[role.name] ?? role.description))}
            </div>
            <div className="h37-group h56-route-group">
              {row('fallback', '备用模型', '不使用', '模型服务出故障时接替一次')}
            </div>
          </>
        )}
        </div>
        <div className="h37-dialog-foot">
          <span className="h37-start h56-route-status" role="status">
            {saving ? '正在保存…' : loading ? '正在读取模型路由…' : !loadError && view && !view.ready ? '配好主 agent 才能用自动路由' : ''}
          </span>
          <button type="button" className="h37-btn h37-btn-primary" data-primary="true" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
