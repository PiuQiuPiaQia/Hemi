import {useConversationEnvironment} from './lib/conversation-bridge';
import { modelPolicyView } from '@shared/model-policy-view.mjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Cpu, Settings2, Sparkles } from 'lucide-react'

import type { ModelEntryView, ModelProfilesDirectory, ModelProviderView } from '@/shared/types'
import { Menu, MenuGroup, MenuSearch } from '@/components/menu'
import { ModelRoutingDialog } from '@/windows/voice/model-routing-dialog'

/**
 * 031 R-03：输入区当前模型选择器。
 *
 * - 触发器 chip 显示当前会话生效的配置组（名称·型号）；下拉按提供方域名分组、
 *   可按名称/型号过滤、键盘可达（Enter 确认、Esc 关闭回触发器）。
 * - 选择只影响后续回合（page 侧随回合提交冻结）；环境覆盖时只读提示；
 *   未配 Key 的组不可选（列出但禁用并说明）。
 * - 056（2026-10-14 用户裁决）：两种模式——「自动路由」按模型路由弹窗分配主 agent 与各
 *   子 agent 角色的模型（备用也只在这里生效）；选具体模型＝Hemi 和所有子 agent 都用它。
 *   自动路由行尾齿轮打开模型路由弹窗（与设置页同一个）；没配主 agent 时自动路由不可选。
 * - 2026-10-06：迁移到统一 Menu 组件，但因有搜索框，焦点留在输入框不走标准键盘导航。
 */
export function ModelSelectorChip({
  directory,
  currentProfileId,
  onSelect,
  onOpenAutoRoutingSettings,
  fixtureOpen = false
}: {
  directory: ModelProfilesDirectory | null
  currentProfileId: string | null
  onSelect: (profileId: string) => void
  /** 056：模型路由弹窗关闭后通知 page 重读模型目录（「自动路由」就绪随之刷新）。 */
  onOpenAutoRoutingSettings?: () => void
  /** fixtures 用：初始即展开下拉（静态截图取证）。 */
  fixtureOpen?: boolean
}) {
  const bot = useConversationEnvironment() === 'bot';
  const [open, setOpen] = useState(Boolean(fixtureOpen))
  /** 056：模型路由弹窗（菜单齿轮打开；关闭后让 page 重读目录刷新「自动」就绪）。 */
  const [routingOpen, setRoutingOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // v2：currentProfileId 是模型键（providerId/modelId）；保留值 'auto'＝自动（角色路由）。
  const isAuto = currentProfileId === 'auto'
  const { ready: autoReady, hint: autoHint } = modelPolicyView(directory)
  const keyword = filter.trim().toLowerCase()
  const showAuto = !bot && (!keyword || `自动路由 auto ${autoHint}`.toLowerCase().includes(keyword))
  const current = useMemo(() => {
    if (!directory || isAuto) return null
    for (const provider of directory.providers) {
      const model = provider.models.find((entry) => entry.modelKey === currentProfileId)
      if (model) return { provider, model }
    }
    if (currentProfileId) return null
    for (const provider of directory.providers) {
      const model = provider.models.find((entry) => entry.modelKey === directory.defaultModelId)
      if (model) return { provider, model }
    }
    const provider = directory.providers[0]
    return provider ? { provider, model: provider.models[0] ?? null } : null
  }, [directory, currentProfileId, isAuto])

  const groups = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    const out: Array<[string, Array<{ provider: ModelProviderView; model: ModelEntryView }>]> = []
    for (const provider of directory?.providers ?? []) {
      const matched = provider.models.filter((model) => {
        if (!keyword) return true
        return (
          provider.name.toLowerCase().includes(keyword) ||
          model.model.toLowerCase().includes(keyword) ||
          provider.baseUrl.toLowerCase().includes(keyword)
        )
      })
      if (matched.length)
        out.push([
          provider.name || provider.baseUrl || '未命名供应商',
          matched.map((model) => ({ provider, model }))
        ])
    }
    return out
  }, [directory, filter])

  if (!directory || !directory.providers.length) return null

  return (
    <div className="h24-model-select">
      <button
        type="button"
        ref={triggerRef}
        className="h24-model-chip h37-tool"
        aria-haspopup="menu"
        aria-expanded={open}
        data-auto={isAuto ? 'true' : undefined}
        title={
          directory.envOverride
            ? '模型由环境变量覆盖，这里的选择暂不生效'
            : isAuto
              ? `自动路由：${autoHint}（点击切换）`
              : `当前模型：${current?.model?.model ?? '默认'}${current?.provider?.name ? ` · ${current.provider.name}` : ''}（点击切换，只影响接下来的回合）`
        }
        onClick={() => {
          setFilter('')
          setOpen((value) => !value)
        }}
      >
        <Cpu aria-hidden="true" />
        <span className="h24-model-chip-label h37-tool-label">
          {isAuto ? '自动路由' : current?.model?.model || '模型'}
        </span>
        <ChevronDown className="h37-tool-chev" aria-hidden="true" />
      </button>
      {open && (
        <Menu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          placement="anchor-up"
          autoFocusFirst={false}
          className="h37-model-menu"
        >
          <MenuSearch
            className="h24-model-filter"
            placeholder="搜索名称 / 型号 / 端点"
            value={filter}
            autoFocus
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setOpen(false)
              }
            }}
          />
          {directory.envOverride ? (
            <p
              style={{
                fontSize: 'var(--fs-12)',
                color: 'var(--muted)',
                padding: 'var(--sp-4) var(--sp-8)',
                margin: 0
              }}
              role="note"
            >
              环境变量覆盖中：切换要等环境变量移除后才生效。
            </p>
          ) : null}
          {/* 056：自动路由项＋行尾齿轮（打开模型路由弹窗，与设置页同一个）。未配置时自动项
              不可选，提示行本身就是配置入口。 */}
          {showAuto ? <div className="h56-route-item" style={{ marginBottom: 'var(--sp-4)' }}>
            <button
              type="button"
              role="menuitemradio"
              className="h37-menu-item"
              aria-checked={isAuto}
              disabled={!autoReady}
              title={autoHint}
              onClick={() => {
                setOpen(false)
                if (!isAuto) onSelect('auto')
              }}
              tabIndex={-1}
            >
              <Sparkles style={{ width: 14, height: 14, color: 'var(--faint)' }} aria-hidden="true" />
              <span style={{ flex: 1 }}>自动路由 · {autoHint}</span>
              {isAuto && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0, color: 'var(--body)' }}
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="h56-route-gear"
              aria-label="配置模型路由"
              title="配置模型路由"
              onClick={() => {
                setOpen(false)
                setRoutingOpen(true)
              }}
              tabIndex={-1}
            >
              <Settings2 aria-hidden="true" />
            </button>
          </div> : null}
          {groups.length ? (
            groups.map(([groupName, entries]) => (
              <div key={groupName}>
                <MenuGroup label={groupName} />
                {entries.map(({ provider, model }) => {
                  // 已选「自动」时列表不得再标任何 active——current 为 null 会回退到
                  // defaultModelId，曾致「自动」与默认模型双高亮（2026-10-06 用户反馈）。
                  const active =
                    !isAuto && model.modelKey === (current?.model.modelKey ?? directory.defaultModelId)
                  const disabled = !provider.hasApiKey
                  return (
                    <button
                      key={model.modelKey}
                      type="button"
                      role="menuitemradio"
                      className="h37-menu-item"
                      aria-checked={active}
                      disabled={disabled}
                      title={
                        disabled ? (provider.oauthProvider ? '账号未登录，到 设置 → 模型 重新登录后可选' : '这个供应商还没配 API Key，到 设置 → 模型 补上后可选') : undefined
                      }
                      onClick={() => {
                        setOpen(false)
                        if (!active) onSelect(model.modelKey)
                      }}
                      tabIndex={-1}
                    >
                      <span style={{ flex: 1 }}>
                        {model.model || '未填型号'}
                      </span>
                      <span style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)' }}>{provider.name}</span>
                      {!provider.hasApiKey ? (
                        <small style={{ fontSize: 'var(--fs-12)', color: 'var(--danger)' }}>未配 Key</small>
                      ) : null}
                      {active && (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ flexShrink: 0, color: 'var(--body)' }}
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          ) : !showAuto ? (
            <p style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)', padding: 'var(--sp-4) var(--sp-8)' }}>
              没有匹配的模型。
            </p>
          ) : null}
        </Menu>
      )}
      {routingOpen ? (
        <ModelRoutingDialog
          onClose={() => {
            setRoutingOpen(false)
            onOpenAutoRoutingSettings?.()
          }}
        />
      ) : null}
    </div>
  )
}
