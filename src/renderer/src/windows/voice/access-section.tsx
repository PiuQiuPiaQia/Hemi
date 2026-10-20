import { useCallback, useEffect, useRef, useState } from 'react';

import { Plus } from 'lucide-react';

import type { ApplicationChoice, AccessMutationResult, AccessStateDto } from '@/shared/types';

import { AccessAddDialog } from './access-add-dialog';

/**
 * 042 · 设置页「访问授权」区。2026-10-15 用户裁决「只保留应用级授权」：文件读写与命令
 * 默认完全访问，这里只管理「能操作哪些桌面应用」；文件夹授权（添加文件夹、访问/编辑
 * 分段）整体退役。受保护位置（凭据、个人数据、系统目录）是硬拒，没有开关。
 */

type AccessResource = AccessStateDto['resources'][number];
type AccessGrant = AccessStateDto['grants'][number];

/** 写面失败码 → 用户文案（不把内部码/操作名直接上屏）。 */
function errorCopy(code: string | undefined): string {
  switch (code) {
    case 'STORE_UNAVAILABLE':
      return '暂时无法读取访问设置，请稍后重试。';
    case 'PERSIST_FAILED':
      return '没能保存这次更改，请重试。';
    case 'REVISION_CONFLICT':
      return '授权刚刚有变化，列表已刷新，请再试一次。';
    case 'UNKNOWN_GRANT':
    case 'UNKNOWN_RESOURCE':
      return '这项授权已经不存在了，列表已刷新。';
    case 'UNSUPPORTED_CAPABILITY':
      return '应用只能设为「访问」。';
    case 'FEATURE_DISABLED':
      return '这项功能暂时不可用。';
    case 'NOT_APPLICATION':
      return '这一项不是应用，不能这样设置。';
    case 'APP_REF_STALE':
      return '应用清单刚刷新过，请重新选择后再添加。';
    case 'APP_IDENTITY_CHANGED':
      return '这个应用已经变化（可能被移动、更新或删除），请重新选择。';
    case 'INVALID_INPUT':
      return '选择的内容无效，请重新选择。';
    case 'FORBIDDEN':
      return '只能在 Hemi 的设置窗口里修改授权。';
    default:
      return '没能完成操作，请重试。';
  }
}

/** 资源表 ∪ grants 引用的资源（任务级发现态资源缺表时按 id 兜底一行）。 */
function resourceRows(state: AccessStateDto | null): Array<{ resource: AccessResource; grants: AccessGrant[] }> {
  if (!state) return [];
  const byId = new Map<string, AccessResource>();
  for (const resource of state.resources ?? []) byId.set(resource.resourceId, resource);
  for (const grant of state.grants ?? []) {
    if (byId.has(grant.resourceId)) continue;
    if (!grant.resourceId.startsWith('app:')) continue; // 旧档残留的文件夹授权不显示
    byId.set(grant.resourceId, { resourceId: grant.resourceId, type: 'app' });
  }
  return [...byId.values()]
    .map((resource) => ({
      resource,
      grants: (state.grants ?? []).filter((g) => g.resourceId === resource.resourceId),
    }))
    .filter((row) => row.grants.length > 0);
}

function resourceTitle(resource: AccessResource): string {
  return resource.displayName ?? resource.resourceId.replace(/^app:/, '');
}

export function AccessSection() {
  const [state, setState] = useState<AccessStateDto | null>(null);
  const [adding, setAdding] = useState(false);
  const [apps, setApps] = useState<ApplicationChoice[] | null>(null);
  const [appsFailed, setAppsFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const revisionRef = useRef(-1);
  const busyRef = useRef(false);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);

  const refresh = useCallback(() => {
    void window.hemiVoice
      ?.accessGetState?.()
      .then((dto) => {
        if (!dto) return;
        // 迟到的旧 revision 回包不覆盖较新的状态（变更广播与写面回执可能交错）。
        if (typeof dto.revision === 'number' && dto.revision < revisionRef.current) return;
        if (typeof dto.revision === 'number') revisionRef.current = dto.revision;
        setState(dto);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const off = window.hemiVoice?.onAccessChanged?.(refresh);
    return () => off?.();
  }, [refresh]);

  /** 写面统一包装：一次只允许一笔在途；失败如实上屏；无论成败都重读状态。 */
  const mutate = async (
    run: () => Promise<AccessMutationResult | undefined> | undefined,
    { inDialog = false, onOk }: { inDialog?: boolean; onOk?: () => void } = {},
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const setErr = inDialog ? setDialogError : setError;
    setErr(null);
    try {
      const out = await run();
      if (out && !out.ok) setErr(errorCopy(out.errorCode));
      else onOk?.();
    } catch {
      setErr(errorCopy(undefined));
    } finally {
      busyRef.current = false;
      setBusy(false);
      refresh();
    }
  };

  const closeAdd = useCallback(() => {
    setAdding(false);
    setDialogError(null);
    addTriggerRef.current?.focus();
  }, []);

  const loadApps = async () => {
    setApps(null);
    setAppsFailed(false);
    try {
      setApps((await window.hemiVoice?.accessListApplications?.()) ?? []);
    } catch {
      setApps([]);
      setAppsFailed(true);
    }
  };

  const openAdd = () => {
    setAdding(true);
    setDialogError(null);
    void loadApps();
  };

  // 添加成功的回执（设计稿「添加成功」文案），几秒后自动收起。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 043 B2a：提交只带宿主签发的 ref（appRef+catalogRevision）；名称不是身份。
  const addApplication = (app: ApplicationChoice) =>
    mutate(
      () =>
        window.hemiVoice?.accessAddApplication?.({
          ref: { appRef: app.ref.appRef, catalogRevision: app.ref.catalogRevision },
          expectedRevision: state?.revision,
        }),
      {
        inDialog: true,
        onOk: () => {
          closeAdd();
          setNotice(`已允许访问「${app.name}」，随时可以在这里撤销。`);
        },
      },
    );

  const removeGrant = (grantId: string) =>
    mutate(() => window.hemiVoice?.accessRemoveGrant?.({ grantId, expectedRevision: state?.revision }));

  const revokeResource = (resourceId: string) =>
    mutate(() => window.hemiVoice?.accessRevokeResource?.({ resourceId, expectedRevision: state?.revision }));

  const corrupt = state?.health === 'corrupt' || state?.health === 'unavailable';
  const retrySave = () => mutate(() => window.hemiVoice?.accessRetrySave?.());
  const rows = corrupt ? [] : resourceRows(state);
  const addedResourceIds = new Set((state?.grants ?? []).filter((g) => g.lifetime === 'persistent').map((g) => g.resourceId));

  return (
    <section className="h37-section" id="settings-access">
      <div className="h37-section-head">
        <h3>应用授权</h3>
        {rows.length ? <span className="h37-count">{rows.length}</span> : null}
        <span className="h37-aside">
          <button
            ref={addTriggerRef}
            type="button"
            className="h37-btn h37-btn-primary h37-btn-sm"
            disabled={corrupt || busy}
            onClick={() => void openAdd()}
          >
            <Plus aria-hidden="true" />
            添加应用…
          </button>
        </span>
      </div>
      <p className="h37-help">
        Hemi 能操作哪些应用，由你在这里决定；任务里第一次用到某个应用时会先向你申请。
        读写文件和运行命令不用授权，删除、改系统设置这类危险命令仍会先问你。
      </p>

      {corrupt ? (
        <div className="h37-note" data-tone="danger" role="alert">
          <span className="h37-note-text">暂时无法读取访问设置，Hemi 已暂停相关访问。请重试。</span>
          <button type="button" className="h37-btn h37-btn-ghost h37-btn-sm" onClick={refresh}>
            重新加载
          </button>
        </div>
      ) : null}
      {state?.health === 'write_failed' ? (
        <div className="h37-note" data-tone="warn" role="status">
          <span className="h37-note-text">上次更改没能保存。下面显示的是当前实际生效的授权。</span>
          <button type="button" className="h37-btn h37-btn-ghost h37-btn-sm" disabled={busy} onClick={() => void retrySave()}>
            重试保存
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="h37-note" data-tone="danger" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="h37-note" data-tone="g" role="status">
          {notice}
        </div>
      ) : null}

      {corrupt ? null : rows.length === 0 ? (
        <div className="h37-group h37-access-empty">要操作某个应用时，Hemi 会先向你申请</div>
      ) : (
        <div className="h37-group" aria-busy={busy || undefined}>
          {rows.map(({ resource, grants }) => {
            const persistentGrant = grants.find((g) => g.lifetime === 'persistent');
            const title = resourceTitle(resource);
            return (
              <div key={resource.resourceId} className="h37-row h37-access-row">
                <span className="h37-tile">{title.slice(0, 1)}</span>
                <span className="h37-row-text">
                  <b className="h37-row-title" title={title}>
                    {title}
                  </b>
                  <span className="h37-row-desc">{persistentGrant ? '持续授权' : '本次对话'}</span>
                </span>
                <span className="h37-row-end">
                  {grants.length > 1 && persistentGrant ? (
                    <button
                      type="button"
                      className="h37-btn h37-btn-ghost h37-btn-sm"
                      disabled={busy}
                      onClick={() => void removeGrant(persistentGrant.grantId)}
                      title="只移除持续授权；进行中任务的本任务授权保留到任务结束"
                    >
                      移除持续授权
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="h37-btn h37-btn-ghost h37-btn-sm h37-access-revoke"
                    disabled={busy}
                    onClick={() => void revokeResource(resource.resourceId)}
                  >
                    撤销
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="h37-section-foot">
        钥匙串、邮件、信息、浏览器数据、凭据文件（如 .ssh、.env）和 Hemi 自身的配置始终不会被访问；系统目录只读。
      </p>

      {adding ? (
        <AccessAddDialog
          apps={apps}
          appsFailed={appsFailed}
          addedResourceIds={addedResourceIds}
          busy={busy}
          error={dialogError}
          onClose={closeAdd}
          onReloadApps={() => void loadApps()}
          onAddApplication={(app) => void addApplication(app)}
        />
      ) : null}
    </section>
  );
}
