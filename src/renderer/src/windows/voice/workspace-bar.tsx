import {DirectoryControlButton} from '@hemi/conversation-flow/controls';
import {SelectionSurface, useControlDisclosure} from '@hemi/ui';
import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, FolderOpen, FolderPlus, House, Server, X } from 'lucide-react'

import type { WorkspaceState, WorkspaceView } from '@/shared/types'
import { MenuSearch, MenuSeparator } from '@/components/menu'
import { displayPath } from '@/windows/voice/lib/path-format'
import { RemoteFolderDialog } from './remote-folder-dialog'

/**
 * 033 · 工作区上下文（037 起收进输入工具行的一个带名芯片）（v2 默认空间优先交互）。
 *
 * - 选「默认空间」或项目＝改绑当前会话（2026-10-01 用户裁决：已有会话也
 *   支持原地绑定）；项目名旁 × 撤销回默认，草稿与附件不动。改绑只影响
 *   接下来的任务——已受理任务按受理时冻结的快照执行（R-03）。
 * - 目录失效（被移走/卸载/拒绝访问）：琥珀条解释原因并给「重新选择」，
 *   发送被禁用、草稿保留——不静默改道（R-07）。
 * - 旧会话（033 前建档、无绑定）：显示「家目录」，绑定前的新任务按旧语义
 *   在家目录执行；用户可随时在此改绑。
 * - 2026-10-06：迁移到统一 Menu 组件，因有搜索框，焦点留在输入框。
 * - 049：远端项目＝另一种工作区（设计稿 v2）——芯片/菜单用服务器图标、
 *   名称后缀「· 主机」、路径显示 host:路径；连不上复用同一条琥珀提示条，
 *   按钮改「重试连接」；菜单尾部新增「服务器上的文件夹…」打开添加对话框。
 */
export type WorkspaceBarValue = { kind: 'view'; view: WorkspaceView } | { kind: 'legacy' }

const hostOf = (view: WorkspaceView | null | undefined) => view?.host ?? null

/** 路径显示：远端 host:路径（~ 按远端家缩写）；本机 displayPath。 */
function pathOf(view: WorkspaceView): string {
  const host = hostOf(view)
  if (!host) return displayPath(view.dir)
  const home = view.remoteHome
  const shortened = home && (view.dir === home || view.dir.startsWith(`${home}/`))
    ? `~${view.dir.slice(home.length)}`
    : view.dir
  return `${host}:${shortened}`
}

export function WorkspaceBar({
  state,
  current,
  sendBlocked = false,
  fixtureOpen = false,
  alertSlot,
  onSelect,
  onClear,
  onPickFolder,
  onRemoteAdded,
  onRetryRemote,
  onRemove
}: {
  /** 登记状态（默认空间 + 项目列表；含实时可用性）。 */
  state: WorkspaceState | null
  /** 当前绑定（view＝已绑定；legacy＝旧会话家目录语义）。 */
  current: WorkspaceBarValue | null
  /** 目录失效 → 发送禁用（提示条由本组件承担）。 */
  sendBlocked?: boolean
  /** fixtures 用：初始即展开菜单（静态截图取证）。 */
  fixtureOpen?: boolean
  /** 037：芯片进了输入工具行，目录失效提示条经 portal 渲染到输入框上方的槽位。 */
  alertSlot?: HTMLElement | null
  onSelect: (id: string) => void
  onClear: () => void
  onPickFolder: () => void
  /**
   * 049：远端项目添加成功——带主进程返回的最新登记状态（含新项目），调用方先落
   * 状态再绑定；缺省回落 onSelect（fixtures 无桥环境，页面状态本就是桩）。
   */
  onRemoteAdded?: (workspace: WorkspaceView, state: WorkspaceState | null) => void
  /** 049：远端连接不可用时的「重试连接」（重新探测；缺省＝本地无桥环境隐藏按钮动作）。 */
  onRetryRemote?: (id: string) => void
  onRemove: (id: string) => void
}) {
  const {open, setOpen} = useControlDisclosure({defaultOpen: fixtureOpen})
  const [filter, setFilter] = useState('')
  const [remoteDialog, setRemoteDialog] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const currentView = current?.kind === 'view' ? current.view : null
  const isProject = currentView?.type === 'project'
  const missing = currentView?.status === 'missing'
  const currentHost = hostOf(currentView)

  const projects = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    if (!keyword) return state?.projects ?? []
    return (state?.projects ?? []).filter(
      (item) =>
        item.name.toLowerCase().includes(keyword) ||
        item.dir.toLowerCase().includes(keyword) ||
        (hostOf(item) ?? '').toLowerCase().includes(keyword),
    )
  }, [state, filter])

  const label = currentView ? (currentHost ? `${currentView.name} · ${currentHost}` : currentView.name) : '家目录'
  const dirTitle = currentView ? pathOf(currentView) : '旧会话：033 之前的会话没有工作区绑定，任务在家目录执行'
  const triggerTitle = `${label} · ${dirTitle}（点击切换，只影响接下来的任务）`

  const alert = missing ? (
    <div className="h33-workspace-alert" role="status">
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
      <div className="h33-workspace-alert-text">
        <strong>{currentHost ? `连不上 ${currentHost}` : `${currentView?.name} 工作区不可用`}</strong>
        <span>
          {currentView?.message ?? (currentHost ? '连接不上服务器' : '目录不存在或已移走')}；发送已暂停，草稿已保留。
        </span>
      </div>
      <button
        type="button"
        onClick={() => {
          if (currentHost) {
            if (currentView?.id) onRetryRemote?.(currentView.id)
            return
          }
          setFilter('')
          setOpen(true)
        }}
      >
        {currentHost ? '重试连接' : '重新选择'}
        <span aria-hidden="true"> ›</span>
      </button>
    </div>
  ) : null

  return (
    <div className="h33-workspace">
      {alert ? (alertSlot ? createPortal(alert, alertSlot) : alert) : null}
      <div className="h33-workspace-bar" data-missing={missing ? 'true' : undefined}>
        <DirectoryControlButton
          ref={triggerRef} text={label} title={triggerTitle} aria-haspopup="menu" aria-expanded={open}
          icon={currentHost ? <Server aria-hidden="true"/> : isProject ? <FolderOpen aria-hidden="true"/> : <House aria-hidden="true"/>}
          indicator={missing ? <AlertTriangle className="size-3 h33-workspace-warn" aria-hidden="true"/> : null}
          onClick={() => {setFilter(''); setOpen(!open)}}
        />
        {isProject ? (
          <button
            type="button"
            className="h33-workspace-clear"
            aria-label="撤销项目指定，回到默认空间"
            title="撤销项目指定，回到默认空间（草稿保留）"
            onClick={onClear}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        ) : null}
        {sendBlocked && !missing ? (
          <span className="h33-workspace-note" role="status">
            {currentHost ? '连不上服务器，发送已暂停' : '工作区不可用，发送已暂停'}
          </span>
        ) : null}
      </div>
      {open && (
        <SelectionSurface
          title="选择工作目录"
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          menuProps={{placement:"anchor-up",autoFocusFirst:false,className:"h37-workspace-menu",maxHeight:"min(420px, 60vh)"}}
        >
          {(state?.projects ?? []).length ? (
            <MenuSearch
              placeholder="搜索项目"
              aria-label="搜索项目"
              value={filter}
              autoFocus
              onChange={(event) => setFilter(event.target.value)}
            />
          ) : null}
          {state?.default ? (
            <button
              type="button"
              role="menuitemradio"
              className="h37-menu-item h37-workspace-item"
              aria-checked={currentView?.id === state.default.id}
              onClick={() => {
                setOpen(false)
                if (currentView?.id !== state.default.id) onSelect(state.default.id)
              }}
              tabIndex={-1}
            >
              <House className="h37-workspace-icon" aria-hidden="true" />
              <div className="h37-workspace-content">
                <span className="h37-workspace-name">默认空间</span>
                <span className="h37-workspace-path" title={state.default.dir}>
                  {displayPath(state.default.dir)}
                </span>
              </div>
              {currentView?.id === state.default.id && (
                <Check className="h37-workspace-check" aria-label="当前工作区" />
              )}
            </button>
          ) : null}
          {projects.map((item) => {
            const host = hostOf(item)
            return (
              <div
                key={item.id}
                className="h37-workspace-item-wrapper"
                data-missing={item.status === 'missing' ? 'true' : undefined}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  className="h37-menu-item h37-workspace-item"
                  aria-checked={currentView?.id === item.id}
                  onClick={() => {
                    setOpen(false)
                    if (currentView?.id !== item.id) onSelect(item.id)
                  }}
                  tabIndex={-1}
                >
                  {host ? (
                    <Server className="h37-workspace-icon" aria-hidden="true" />
                  ) : (
                    <FolderOpen className="h37-workspace-icon" aria-hidden="true" />
                  )}
                  <div className="h37-workspace-content">
                    <span className="h37-workspace-name">
                      {item.name}
                      {item.status === 'missing' ? (
                        <em className="h37-workspace-missing">{host ? '连不上' : '不可用'}</em>
                      ) : null}
                    </span>
                    <span className="h37-workspace-path" title={pathOf(item)}>
                      {pathOf(item)}
                    </span>
                  </div>
                  {currentView?.id === item.id && (
                    <Check className="h37-workspace-check" aria-label="当前工作区" />
                  )}
                </button>
                <button
                  type="button"
                  className="h37-workspace-remove"
                  aria-label={`从列表移除 ${item.name}`}
                  title={host ? '从列表移除（不动服务器上的文件）' : '从列表移除（不删除磁盘上的文件夹）'}
                  onClick={() => onRemove(item.id)}
                >
                  <X className="h37-workspace-remove-icon" aria-hidden="true" />
                </button>
              </div>
            )
          })}
          <MenuSeparator />
          <button
            type="button"
            role="menuitem"
            className="h37-menu-item h37-workspace-add"
            onClick={() => {
              setOpen(false)
              onPickFolder()
            }}
            tabIndex={-1}
          >
            <FolderPlus className="h37-workspace-icon" aria-hidden="true" />
            <span className="h37-workspace-name">打开文件夹…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="h37-menu-item h37-workspace-add"
            data-h49="remote-add"
            onClick={() => {
              setOpen(false)
              setRemoteDialog(true)
            }}
            tabIndex={-1}
          >
            <Server className="h37-workspace-icon" aria-hidden="true" />
            <span className="h37-workspace-name">服务器上的文件夹…</span>
          </button>
        </SelectionSurface>
      )}
      {remoteDialog
        ? createPortal(
            <RemoteFolderDialog
              onClose={() => setRemoteDialog(false)}
              onAdded={(added, state) => {
                setRemoteDialog(false)
                if (!added) return
                if (onRemoteAdded) onRemoteAdded(added, state ?? null)
                else onSelect(added.id)
              }}
            />,
            document.body,
          )
        : null}
    </div>
  )
}
