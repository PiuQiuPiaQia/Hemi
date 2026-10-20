import { useId, useState } from 'react'
import { X } from 'lucide-react'

/**
 * 049 · 密码重输对话框（2026-10-12 用户裁决：支持密码登录）——重试连接遇到
 * 认证失败（密码不 remembered 或本机无免密密钥）时弹出；提交后带密码重新探测。
 * 只用产品既有 h37 对话框/表单样式，不新增 CSS。
 */
export function RemotePasswordDialog({
  host,
  onClose,
  onSubmit,
  busy = false,
}: {
  host: string
  onClose: () => void
  onSubmit: (password: string, remember: boolean) => void
  busy?: boolean
}) {
  const titleId = useId()
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
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
            <h3 id={titleId}>重新连接 {host}</h3>
          </div>
          <button type="button" className="h37-access-dialog-close" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="h37-access-dialog-body">
          <div className="h37-field">
            <label htmlFor="h49-retry-password">密码</label>
            <input
              id="h49-retry-password"
              className="h37-input h37m-mono"
              type="password"
              placeholder={`${host} 的登录密码`}
              value={password}
              disabled={busy}
              autoFocus
              onChange={(event) => setPassword(event.target.value)}
            />
            <label
              htmlFor="h49-retry-remember"
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--sp-8)',
                marginTop: 'var(--sp-8)', fontSize: 'var(--fs-12)', color: 'var(--muted)',
                ...(busy ? { opacity: 0.5, pointerEvents: 'none' } : {}),
              }}
            >
              <input
                id="h49-retry-remember"
                type="checkbox"
                checked={remember}
                disabled={busy}
                onChange={(event) => setRemember(event.target.checked)}
                style={{ accentColor: 'var(--accent, #4a9eff)' }}
              />
              记住这台服务器的密码
            </label>
          </div>
        </div>
        <div className="h37-dialog-foot">
          <span className="h37-start h37-access-dialog-summary" aria-live="polite">
            {busy ? `正在连接 ${host}…` : ''}
          </span>
          <button type="button" className="h37-btn h37-btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="h37-btn h37-btn-primary"
            disabled={!password.trim() || busy}
            onClick={() => onSubmit(password, remember)}
          >
            {busy ? '正在连接…' : '重新连接'}
          </button>
        </div>
      </div>
    </div>
  )
}
