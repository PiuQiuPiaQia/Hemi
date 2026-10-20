import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, CircleAlert, Copy, PencilLine, Trash2 } from 'lucide-react'

import type { ConversationSummary } from '@/shared/types'
import { Menu, MenuSeparator } from '@/components/menu'
import { copyTextViaBridge } from '@/lib/use-clipboard-copy'

/**
 * 会话行右键菜单（2026-10-05）：复制会话 ID、重命名；2026-10-07 加删除。
 * 使用统一 Menu 组件，fixed 定位在右键坐标，支持翻转/内收、键盘导航、退出动画。
 * point/session 任一为 null 即收起；损坏行复制与删除仍可用（删除即清掉损坏
 * 档案文件，是唯一的界面清理途径）、重命名置灰。
 * 删除与历史弹窗同款两步确认：首点把危险项武装成「确认删除」，再点才回调
 * onDelete；Esc/点外收起即解除武装。
 * 复制后弹 h37-toast（底部居中，成/败两态）——toast 状态留在本组件里，
 * 菜单收起后仍存活，调用方须在菜单关闭后保持本组件挂载（session 可传 null）。
 */
export function ConversationContextMenu({
  session,
  point,
  onRename,
  onDelete,
  onClose
}: {
  session: ConversationSummary | null
  point: { x: number; y: number } | null
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}) {
  /** 复制反馈：菜单已收起也继续显示，2.6s 自动消退（与记忆 toast 同节奏）。 */
  const [toast, setToast] = useState<{ id: number; ok: boolean } | null>(null)
  /** 删除两步确认：true＝已武装，菜单收起即复位。 */
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const toastSeq = useRef(0)

  const open = point !== null && session !== null

  useEffect(() => {
    if (!open) setConfirmingDelete(false)
  }, [open])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const copyId = async () => {
    onClose()
    if (!session) return
    const id = ++toastSeq.current
    // 统一复制出口（主进程桥优先，页面剪贴板兜底）；成/败都如实弹 toast。
    const ok = await copyTextViaBridge(session.id)
    setToast({ id, ok })
  }

  const toastNode = toast
    ? createPortal(
        <div
          className="h37-toast h37-toast-card"
          role="status"
          key={toast.id}
          data-tone={toast.ok ? undefined : 'err'}
        >
          {toast.ok ? <Check aria-hidden /> : <CircleAlert aria-hidden />}
          <span>{toast.ok ? '已复制会话 ID' : '没复制成功'}</span>
        </div>,
        document.body
      )
    : null

  if (!session || !point) return toastNode

  return (
    <>
      <Menu
        open={open}
        onClose={onClose}
        placement="fixed"
        position={point}
        autoFocusFirst={true}
      >
        <button
          type="button"
          role="menuitem"
          className="h37-menu-item"
          title={session.id}
          onClick={() => void copyId()}
          tabIndex={-1}
        >
          <Copy aria-hidden style={{ width: 14, height: 14, color: 'var(--faint)' }} />
          <span style={{ flex: 1 }}>复制会话 ID</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="h37-menu-item"
          disabled={Boolean(session.corrupt)}
          title={session.corrupt ? '这条会话档案损坏，无法重命名' : undefined}
          onClick={() => {
            onClose()
            onRename()
          }}
          tabIndex={-1}
        >
          <PencilLine aria-hidden style={{ width: 14, height: 14, color: 'var(--faint)' }} />
          <span style={{ flex: 1 }}>重命名</span>
        </button>
        <MenuSeparator />
        {/* 图标颜色不写死在行内——danger 确认态靠 CSS 里的
            [data-danger]/[data-confirm] 规则接管，行内 style 会盖掉它们。 */}
        <button
          type="button"
          role="menuitem"
          className="h37-menu-item"
          data-danger="true"
          data-confirm={confirmingDelete ? 'true' : undefined}
          title={
            confirmingDelete
              ? '再点一次删除；Esc 或点菜单外取消'
              : session.corrupt
                ? '档案已损坏，删除即清掉残留文件'
                : undefined
          }
          onClick={() => {
            if (!confirmingDelete) {
              setConfirmingDelete(true)
              return
            }
            onClose()
            onDelete()
          }}
          tabIndex={-1}
        >
          <Trash2 aria-hidden style={{ width: 14, height: 14 }} />
          <span style={{ flex: 1 }}>{confirmingDelete ? '确认删除' : '删除会话'}</span>
        </button>
      </Menu>
      {toastNode}
    </>
  )
}
