import { useRef, useState } from 'react'

import { Brain, ChevronDown } from 'lucide-react'

import { THINKING_LEVEL_OPTIONS } from '@/shared/types'
import type { ThinkingLevel } from '@/shared/types'
import { Menu, MenuItem } from '@/components/menu'

/**
 * 033 首页·思考强度快捷拨盘：输入工具行里的一个脑形 icon，点开浮层选档
 * （图标颜色随档位深浅表强度）。
 * 选档立即经 llm:set-thinking-level 落库（只写档位，不碰其他配置），下一轮
 * 对话即生效；值由 page 侧持有（modelForm.thinkingLevel），设置页模型 tab
 * 的下拉与这里同源。
 * 041 用户裁决（2026-10-05）：思考强度是全局一档，不随会话/自动路由变化——
 * 038 的「自动模式只读按模型设置」退役；发送侧按各供应商映射翻译全局档。
 * 2026-10-07 用户裁决：全局档只在会话内保持——每个新会话重置回「自动」
 * （page 侧 resetThinkingLevelForNewConversation，进入新对话态时触发）。
 * 2026-10-06：迁移到统一 Menu 组件，单行 32px，右侧 ✓ 标记。
 * P1 视觉收敛（2026-10-08）：自动档只留脑形图标（data-compact），拨到非默认档才露出文字。
 */

/** 触发键颜色随档位：从「跟随」的灰到「高」的琥珀，强度越高越暖。 */
const LEVEL_TONES: Record<ThinkingLevel, string> = {
  default: 'var(--muted)',
  off: 'var(--faint)',
  low: 'var(--g-500)',
  medium: 'var(--g-600)',
  high: 'var(--warn)'
}

export function ThinkingLevelStrip({
  level,
  onChange
}: {
  level: ThinkingLevel
  onChange: (level: ThinkingLevel) => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const current = THINKING_LEVEL_OPTIONS.find((option) => option.value === level) ?? THINKING_LEVEL_OPTIONS[0]

  const selectLevel = (next: ThinkingLevel) => {
    setOpen(false)
    if (next !== level) onChange(next)
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        className="h37-tool"
        data-compact={level === 'default' ? 'true' : undefined}
        aria-label={`思考强度：${current.label}${level === 'default' ? '（自动）' : ''}`}
        title={`思考强度：${current.label}${level === 'default' ? '（自动 · 厂商中档）' : ''}。全局档，按各供应商的等级映射生效`}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Brain style={{ color: LEVEL_TONES[level] ?? LEVEL_TONES.default }} aria-hidden="true" />
        <span className="h37-tool-label">{`思考${current.label}`}</span>
        <ChevronDown className="h37-tool-chev" aria-hidden="true" />
      </button>

      {open && (
        <Menu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={buttonRef}
          placement="anchor-up"
          className="h37-thinking-menu"
        >
          <div
            style={{
              fontSize: 'var(--fs-12)',
              color: 'var(--faint)',
              padding: 'var(--sp-4) var(--sp-10)',
              marginBottom: 'var(--sp-2)'
            }}
          >
            思考强度 · 当前：{current.label}
          </div>
          {THINKING_LEVEL_OPTIONS.map((option) => (
            <MenuItem
              key={option.value}
              role="menuitemradio"
              icon={
                <span
                  style={{
                    display: 'block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: LEVEL_TONES[option.value],
                    flexShrink: 0
                  }}
                  aria-hidden="true"
                />
              }
              label={`${option.label}${option.hint ? ` · ${option.hint}` : ''}`}
              checked={option.value === level}
              onClick={() => selectLevel(option.value)}
            />
          ))}
        </Menu>
      )}
    </div>
  )
}
