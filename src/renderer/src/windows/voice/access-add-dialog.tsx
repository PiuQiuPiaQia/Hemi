import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Check, Search, X } from "lucide-react";

import type { ApplicationChoice } from "@/shared/types";

/**
 * 042 · 添加应用授权弹窗（设计稿 add-dialog）。2026-10-15 文件夹授权退役，只剩选应用：
 * 选中一项 → 底部「添加」确认；已添加态、底部摘要可见再确认。
 * 键盘：应用清单 ↑/↓ 选择、Enter 添加；双击应用直接添加；Esc 关。
 */

export function AccessAddDialog({
  apps,
  appsFailed,
  addedResourceIds,
  busy,
  error,
  onClose,
  onReloadApps,
  onAddApplication,
}: {
  apps: ApplicationChoice[] | null;
  appsFailed: boolean;
  /** 已在授权列表里的资源 id（宿主核对后写进条目的 addedResourceId）。 */
  addedResourceIds: Set<string>;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onReloadApps: () => void;
  onAddApplication: (app: ApplicationChoice) => void;
}) {
  const titleId = useId();
  const listId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedApp, setSelectedApp] = useState<string | null>(null);

  const filterText = filter.trim().toLowerCase();
  const visibleApps = useMemo(
    () =>
      (apps ?? []).filter(
        (app) =>
          app.ref?.appRef &&
          (!filterText ||
            app.name.toLowerCase().includes(filterText) ||
            (app.source?.locationLabel ?? "").toLowerCase().includes(filterText)),
      ),
    [apps, filterText],
  );
  // 043：已添加态用宿主核对的 addedResourceId（rowId/appRef 都不是授权键）。
  const isAdded = (app: ApplicationChoice) =>
    Boolean(app.addedResourceId) && addedResourceIds.has(app.addedResourceId!);
  const selectable = visibleApps.filter((app) => !isAdded(app));
  const currentApp =
    visibleApps.find((app) => app.rowId === selectedApp && !isAdded(app)) ??
    null;

  // 过滤后选中项不在可见范围：清掉选中（不留看不见的选中态去「添加」）。
  useEffect(() => {
    if (selectedApp && !selectable.some((app) => app.rowId === selectedApp))
      setSelectedApp(null);
  }, [selectable, selectedApp]);

  // Esc 只关弹窗（捕获阶段截住，不落到任务卡的 Esc）；首焦点给搜索框。
  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // 选中项随键盘移动时滚入视野。
  useEffect(() => {
    if (!selectedApp) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${CSS.escape(selectedApp)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedApp]);

  const canSubmit = !busy && Boolean(currentApp);
  const submit = () => {
    if (canSubmit && currentApp) onAddApplication(currentApp);
  };

  const moveSelection = (delta: number) => {
    if (!selectable.length) return;
    const index = selectable.findIndex((app) => app.rowId === selectedApp);
    const next =
      index < 0
        ? delta > 0
          ? 0
          : selectable.length - 1
        : Math.min(selectable.length - 1, Math.max(0, index + delta));
    setSelectedApp(selectable[next].rowId);
  };

  const onListKeys = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const summary = currentApp ? `允许操作「${currentApp.name}」` : "";

  return (
    <div className="h37-scrim" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="h37-dialog h37-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h37-access-dialog-head">
          <div>
            <h3 id={titleId}>添加应用</h3>
            <p>选择允许 Hemi 操作的应用。</p>
          </div>
          <button
            type="button"
            className="h37-access-dialog-close"
            aria-label="关闭"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="h37-access-dialog-body">
          <>
              <label className="h37-access-search">
                <Search aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  placeholder="搜索应用"
                  aria-label="搜索应用"
                  aria-controls={listId}
                  aria-activedescendant={
                    currentApp ? `${listId}-${currentApp.rowId}` : undefined
                  }
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={onListKeys}
                />
              </label>

              {apps === null ? (
                <div className="h37-access-pick-state" aria-busy="true">
                  正在读取应用清单…
                </div>
              ) : appsFailed ? (
                <div className="h37-access-pick-state">
                  没能读取应用清单。
                  <button
                    type="button"
                    className="h37-btn h37-btn-ghost h37-btn-sm"
                    onClick={onReloadApps}
                  >
                    重试
                  </button>
                </div>
              ) : visibleApps.length === 0 ? (
                <div className="h37-access-pick-state">
                  {filterText
                    ? `没有名称包含「${filter.trim()}」的应用`
                    : "没有可添加的应用"}
                </div>
              ) : (
                <div
                  ref={listRef}
                  id={listId}
                  className="h37-access-pick-list"
                  role="listbox"
                  aria-label="应用"
                  tabIndex={-1}
                  onKeyDown={onListKeys}
                >
                  {visibleApps.map((app) => {
                    const added = isAdded(app);
                    const selected = app.rowId === currentApp?.rowId;
                    return (
                      <div
                        key={app.rowId}
                        id={`${listId}-${app.rowId}`}
                        data-row={app.rowId}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={added || undefined}
                        className="h37-access-pick-row"
                        title={app.source?.locationLabel}
                        onClick={() => !added && setSelectedApp(app.rowId)}
                        onDoubleClick={() => {
                          if (added || busy) return;
                          setSelectedApp(app.rowId);
                          onAddApplication(app);
                        }}
                      >
                        {app.icon ? (
                          <img
                            className="h37-access-app-icon"
                            src={app.icon}
                            alt=""
                            draggable={false}
                          />
                        ) : (
                          <span className="h37-tile" data-tone="g">
                            {app.name.slice(0, 1)}
                          </span>
                        )}
                        <span className="h37-access-pick-text">
                          <span className="h37-access-pick-name">
                            {app.name}
                          </span>
                          <span className="h37-access-pick-sub">
                            {added
                              ? "已添加"
                              : app.running
                                ? "正在运行"
                                : "已安装"}
                          </span>
                        </span>
                        {selected ? (
                          <Check
                            className="h37-access-pick-check"
                            aria-hidden="true"
                          />
                        ) : app.running && !added ? (
                          <span className="h37-run-dot" title="正在运行" />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}

              <p className="h37-help">
                添加后 Hemi 可以查看和操作这个应用的界面，相关内容会发送给你使用的 AI 模型。随时可以在设置里撤销。
              </p>
            </>

          {error ? (
            <div className="h37-note" data-tone="danger" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <div className="h37-dialog-foot">
          <span
            className="h37-start h37-access-dialog-summary"
            aria-live="polite"
          >
            {summary}
          </span>
          <button
            type="button"
            className="h37-btn h37-btn-ghost"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="h37-btn h37-btn-primary"
            disabled={!canSubmit}
            onClick={submit}
          >
            {busy ? "正在添加…" : "添加"}
          </button>
        </div>
      </div>
    </div>
  );
}
