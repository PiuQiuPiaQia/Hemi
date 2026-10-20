import { useId, useState } from 'react'
import { X } from 'lucide-react'

import type { WorkspaceState, WorkspaceView } from '@/shared/types'

/**
 * 049 ·「服务器上的文件夹…」添加对话框（交互稿 v2）：两个字段——服务器
 * （SSH 配置里的 Host 或 user@host）与文件夹（远端路径）。校验由主进程经
 * 系统 ssh 完成（BatchMode，不弹密码框）；错误按分类给终端修复方式。
 * 只用产品既有的 h37 对话框/表单/提示样式，不新增 CSS。
 */
type Phase = 'idle' | 'checking' | 'error'

type AddRemoteResult = {
  ok: boolean
  cancelled?: boolean
  kind?: string
  field?: 'host' | 'dir'
  message?: string
  /** kind=auth：本机无免密密钥，提示可输密码。 */
  canPassword?: boolean
  workspace?: WorkspaceView
  state?: WorkspaceState
}

/** fixtures 静态场景预置（产品运行不传；对齐交互稿 v2 的多状态截图）。 */
export type RemoteFolderDialogFixture = {
  host?: string
  dir?: string
  password?: string
  phase?: Phase
  error?: { field: 'host' | 'dir'; text: string }
};

export function RemoteFolderDialog({
  onClose,
  onAdded,
  fixture,
}: {
  onClose: () => void
  /** 添加成功（state＝主进程随登记返回的最新状态，调用方应先落状态再绑定，见 WorkspaceBar）。 */
  onAdded?: (workspace: WorkspaceView, state?: WorkspaceState) => void
  fixture?: RemoteFolderDialogFixture
}) {
  const titleId = useId()
  const [host, setHost] = useState(fixture?.host ?? '')
  const [dir, setDir] = useState(fixture?.dir ?? '')
  const [password, setPassword] = useState(fixture?.password ?? '')
  const [remember, setRemember] = useState(true)
  const [phase, setPhase] = useState<Phase>(fixture?.phase ?? 'idle')
  const [error, setError] = useState<{ field: 'host' | 'dir'; text: string } | null>(fixture?.error ?? null)
  const checking = phase === 'checking'
  const canSubmit = host.trim() !== '' && dir.trim() !== '' && !checking

  const submit = async () => {
    if (!canSubmit) return
    setPhase('checking')
    setError(null)
    let result: AddRemoteResult | undefined
    try {
      result = await window.hemiVoice?.addRemoteWorkspace?.(
        host.trim(),
        dir.trim(),
        password.trim() ? password : undefined,
        remember,
      )
    } catch (error_) {
      result = { ok: false, message: `添加失败：${String((error_ as Error)?.message ?? error_)}` }
    }
    if (!result) {
      setPhase('idle')
      return
    }
    if (!result.ok) {
      setPhase('error')
      const text = result.kind === 'auth' && result.canPassword && !password.trim()
        ? `${result.message ?? ''} 也可以在这里输入这台服务器的密码（只在本机内存里用，不保存）。`
        : result.message ?? '添加失败，原因未知'
      setError({ field: result.field ?? 'host', text })
      return
    }
    if (result.workspace) onAdded?.(result.workspace, result.state)
  }

  return (
    <div className="h37-scrim" onClick={onClose} role="presentation">
      <div
        className="h37-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <div className="h37-access-dialog-head">
          <div>
            <h3 id={titleId}>添加服务器上的文件夹</h3>
          </div>
          <button type="button" className="h37-access-dialog-close" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="h37-access-dialog-body">
          <div className="h37-field">
            <label htmlFor="h49-host">服务器</label>
            <input
              id="h49-host"
              className="h37-input h37m-mono"
              placeholder="SSH 配置里的 Host，或 user@host"
              value={host}
              disabled={checking}
              aria-invalid={error?.field === 'host' ? true : undefined}
              onChange={(event) => {
                setHost(event.target.value)
                setPhase('idle')
                setError(null)
              }}
            />
            {error?.field === 'host' ? <span className="h37-error-text">{error.text}</span> : null}
          </div>
          <div className="h37-field">
            <label htmlFor="h49-dir">文件夹</label>
            <input
              id="h49-dir"
              className="h37-input h37m-mono"
              placeholder="服务器上的路径，如 ~/projects/atlas"
              value={dir}
              disabled={checking}
              aria-invalid={error?.field === 'dir' ? true : undefined}
              onChange={(event) => {
                setDir(event.target.value)
                setPhase('idle')
                setError(null)
              }}
            />
            {error?.field === 'dir' ? <span className="h37-error-text">{error.text}</span> : null}
          </div>
          <div className="h37-field">
            <label htmlFor="h49-password">密码（可选）</label>
            <input
              id="h49-password"
              className="h37-input h37m-mono"
              type="password"
              placeholder="用密钥免密登录时留空"
              value={password}
              disabled={checking}
              onChange={(event) => {
                setPassword(event.target.value)
                setPhase('idle')
                setError(null)
              }}
            />
            <label
              htmlFor="h49-remember"
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--sp-8)',
                marginTop: 'var(--sp-8)', fontSize: 'var(--fs-12)', color: 'var(--muted)',
                ...(checking ? { opacity: 0.5, pointerEvents: 'none' } : {}),
              }}
            >
              <input
                id="h49-remember"
                type="checkbox"
                checked={remember}
                disabled={checking}
                onChange={(event) => setRemember(event.target.checked)}
                style={{ accentColor: 'var(--accent, #4a9eff)' }}
              />
              记住这台服务器的密码
            </label>
          </div>
          <p className="h37-help">走本机的 SSH 登录；密码加密存在本机。</p>
        </div>

        <div className="h37-dialog-foot">
          <span className="h37-start h37-access-dialog-summary" aria-live="polite">
            {checking ? `正在连接 ${host}…` : ''}
          </span>
          <button type="button" className="h37-btn h37-btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="h37-btn h37-btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            {checking ? '正在检查…' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}
