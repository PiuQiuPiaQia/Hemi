import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, CircleAlert } from 'lucide-react'

/**
 * 复制统一出口（2026-10-08 收口，取代散落各处的 navigator.clipboard）：
 * 主进程 system:copy-text 优先——页面剪贴板被权限闸门按 clipboard-read 拦
 * （本版 Electron 连只写也走读权限），且主进程路径不受窗口焦点影响；桥不可
 * 用/未成（dev 热更新混跑旧 preload）才退回页面剪贴板。两条路都失败返回
 * false，由调用方如实反馈，不假装复制成功。
 */
export async function copyTextViaBridge(text: string): Promise<boolean> {
  try {
    const viaBridge = await window.hemiVoice?.copyText?.(text)
    if (viaBridge?.ok) return true
  } catch {
    /* 落到页面剪贴板 */
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * 复制＋toast 反馈（2026-10-08 用户反馈「很多地方缺 toast」后的统一口径）：
 * copy(text, successText) 走桥复制，成/败各弹一条 h37-toast-card（底部居中
 * 2.6s 自动消退——与会话菜单/记忆页同形态同节奏）；toastNode 放进调用方
 * 渲染树任意位置（portal 到 body）。失败文案统一「没复制成功」。
 */
export function useClipboardCopy() {
  const [toast, setToast] = useState<{ id: number; ok: boolean; text: string } | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const copy = useCallback(async (text: string, successText = '已复制') => {
    const ok = await copyTextViaBridge(text)
    setToast({ id: ++seq.current, ok, text: ok ? successText : '没复制成功' })
    return ok
  }, [])

  const toastNode = toast
    ? createPortal(
        <div
          className="h37-toast h37-toast-card"
          role="status"
          key={toast.id}
          data-tone={toast.ok ? undefined : 'err'}
        >
          {toast.ok ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
          <span>{toast.text}</span>
        </div>,
        document.body,
      )
    : null

  return { copy, toastNode }
}
