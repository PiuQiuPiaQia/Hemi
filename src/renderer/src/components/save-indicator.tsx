import { useEffect, useState } from 'react'
import { AlertCircle, Check } from 'lucide-react'

/**
 * 设置页自动保存的状态提示（P2 起各页统一用它，取代「修改后需保存」＋底部主按钮）。
 * 原在 model-profiles-section 内私有，抽出来供语音页共用；新增 error 态。
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** 等待 <300ms 不出 spinner：active 持续超过 delay 才返回 true。 */
export function useDelayed(active: boolean, delay = 300): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(true), delay)
    return () => window.clearTimeout(timer)
  }, [active, delay])
  return shown
}

export function SaveIndicator({
  state,
  idleText,
  errorText,
}: {
  state: SaveState
  /** 给了就常驻显示（「✓ 自动保存」），保存后短暂变「已保存」；不给则只在保存后出现。 */
  idleText?: string
  errorText?: string
}) {
  const slow = useDelayed(state === 'saving')
  if (state === 'error') {
    return (
      <span className="h37-saved" data-tone="danger" role="alert" title={errorText}>
        <AlertCircle aria-hidden />
        {errorText || '保存失败'}
      </span>
    )
  }
  if (state === 'saving') {
    return (
      <span className="h37-saved" role="status" data-state={slow ? undefined : 'hidden'}>
        <span className="h37-spinner" aria-hidden />
        保存中…
      </span>
    )
  }
  if (idleText) {
    return (
      <span className="h37-saved" role="status">
        <Check aria-hidden />
        {state === 'saved' ? '已保存' : idleText}
      </span>
    )
  }
  return (
    <span className="h37-saved" role="status" data-state={state === 'saved' ? undefined : 'hidden'}>
      <Check aria-hidden />
      已保存
    </span>
  )
}
