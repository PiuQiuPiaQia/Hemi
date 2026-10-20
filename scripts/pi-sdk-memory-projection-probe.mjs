// 037 SDK 专项探针：验证「每会话记忆桥」依赖的 pi-coding-agent 1.0.0 行为。
// 覆盖技术方案 runtime-and-forgetting.md 的实施前置：
//   context_with_system 每请求投影、原 system/工具声明保留、纯记忆结果改写（工具边界）、
//   钩子异常被派发器吞掉、压缩摘要请求绕过投影、多会话内联工厂闭包隔离、
//   before_agent_start.systemPrompt（forced prompt）与投影的折叠冲突。
// 用本地 mock OpenAI 兼容端点驱动完整回路，断言基于真实 provider 请求体，不是钩子返回值。
// 运行：node scripts/pi-sdk-memory-projection-probe.mjs（037 实施前置，SDK 升级时必跑）
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// 1.0.0 的 exports 只有 import 条件且不暴露 ./package.json 子路径（同 pi-sdk-probe 口径）。
const sdkEntryPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const sdkPackageDir = path.resolve(path.dirname(sdkEntryPath), '..')
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkPackageDir, 'package.json'), 'utf8')).version

const { createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager } =
  await import('@earendil-works/pi-coding-agent')

// ---------------------------------------------------------------- 探针记录
const findings = []
function record(id, claim, ok, detail) {
  findings.push({ id, claim, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}`)
  if (detail !== undefined) console.log(`      → ${JSON.stringify(detail)}`)
}

// ---------------------------------------------------------------- mock server
// 按「本段脚本内」请求序号回放；每个会话用不同 model id 区分，便于归属断言。
const requests = []
let script = []
let scriptIndex = 0
function setScript(steps) {
  script = steps
  scriptIndex = 0
}
function collectText(parsed) {
  const texts = []
  const systemTexts = []
  for (const m of parsed.messages || []) {
    if (typeof m.content === 'string') {
      texts.push(m.content)
      if (m.role === 'system') systemTexts.push(m.content)
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) if (typeof c?.text === 'string') texts.push(c.text)
    }
  }
  return { texts, systemTexts }
}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {}
    const step = script[Math.min(scriptIndex, script.length - 1)]
    scriptIndex++
    const { texts, systemTexts } = collectText(parsed)
    const entry = {
      model: parsed.model,
      tools: (parsed.tools || []).map((t) => t.function?.name),
      roles: (parsed.messages || []).map((m) => m.role),
      texts,
      systemTexts,
    }
    requests.push(entry)
    console.log(`[mock] request #${requests.length} model=${entry.model} tools=[${entry.tools.join(', ')}] msgs=${entry.roles.length}`)
    const chunk = (delta, finish) => JSON.stringify({
      id: 'chatcmpl-mem-probe', object: 'chat.completion.chunk', created: 1, model: parsed.model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const parts = []
      if (step.toolCall) {
        parts.push(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: step.toolCall.name, arguments: '' } }] }))
        parts.push(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.toolCall.args) } }] }))
        parts.push(chunk({}, 'tool_calls'))
      } else {
        parts.push(chunk({ role: 'assistant', content: step.text ?? '' }))
        parts.push(chunk({}, 'stop'))
      }
      parts.push(JSON.stringify({ id: 'chatcmpl-mem-probe', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      parts.push('[DONE]')
      res.write(parts.map((p) => `data: ${p}\n\n`).join(''))
      res.end()
    }, step.delayMs ?? 0)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const mockUrl = `http://127.0.0.1:${server.address().port}/v1`
console.log(`[mock] listening on ${mockUrl}`)

// ---------------------------------------------------------------- 记忆桥模拟扩展
// 闭包持有全部状态（037 方案要求：禁止模块级状态），与旧 pi-memory 的模块级变量形成对照。
function makeMemoryBridge({ name, providerId, modelId, tag, state }) {
  return {
    name,
    factory: (pi) => {
      pi.registerProvider(providerId, {
        name: `${name} provider`,
        baseUrl: mockUrl,
        apiKey: 'probe-key-not-real',
        api: 'openai-completions',
        models: [{
          id: modelId, name: `${name} model`, reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000, maxTokens: 4096,
        }],
      })
      pi.registerTool({
        name: 'hemi_mem_read',
        label: 'Read memory',
        description: 'Read the current memory view. Use this when the user asks to read memory.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({ content: [{ type: 'text', text: `MEMRESULT:RAW-${tag}` }] }),
      })
      pi.on('context_with_system', async (event) => {
        const toolResults = event.messages.filter((m) => m.role === 'toolResult')
        state.hooks.push({
          firstRole: event.messages[0]?.role,
          roles: event.messages.map((m) => m.role),
          injectedInInput: event.messages.some((m) => m.role === 'system' && m.sections && Object.prototype.hasOwnProperty.call(m.sections, 'hemi_memory')),
          rawToolResultInInput: JSON.stringify(toolResults).includes('MEMRESULT:RAW'),
        })
        if (state.failNext) {
          state.failNext = false
          throw new Error('probe: memory bridge projection failure')
        }
        // 037 投影：克隆中改写桥标记的纯记忆工具结果，末尾追加仅本请求的 system section。
        const messages = event.messages.map((m) => {
          if (m.role !== 'toolResult' || !Array.isArray(m.content)) return m
          const content = m.content.map((c) =>
            c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string' && c.text.startsWith('MEMRESULT:RAW')
              ? { ...c, text: `MEMRESULT:PROJECTED-${tag}` }
              : c)
          return { ...m, content }
        })
        messages.push({ role: 'system', content: '', sections: { hemi_memory: state.viewText }, timestamp: Date.now() })
        return { messages }
      })
      if (state.forcedSystemPrompt) {
        pi.on('before_agent_start', async () => ({ systemPrompt: state.forcedSystemPrompt }))
      }
    },
  }
}

const uiContext = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'select') return async () => undefined
    if (prop === 'confirm') return async () => false
    if (prop === 'input') return async () => undefined
    return () => {}
  },
})

const tmpDirs = []
async function createProbeSession(bridge, state, appendMarker, settingsOverrides) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-memprobe-cwd-'))
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-memprobe-agent-'))
  tmpDirs.push(cwd, agentDir)
  const settingsManager = SettingsManager.inMemory(settingsOverrides)
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [bridge],
    appendSystemPromptOverride: (base) => [...base, appendMarker],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager })
  const models = session.modelRuntime.getModels(state.providerId)
  await session.setModel(models[0])
  await session.bindExtensions({ mode: 'rpc', uiContext, abortHandler: () => {} })
  return session
}

const reqsFor = (modelId) => requests.filter((r) => r.model === modelId)
const lastReq = (modelId) => reqsFor(modelId).at(-1)
const textOf = (modelId) => (reqsFor(modelId).at(-1)?.texts ?? []).join('\n')
const hasText = (modelId, needle) => textOf(modelId).includes(needle)
const APPEND_MARKER = 'HEMI_MEMPROBE_APPEND_IDENTITY'

// ---------------------------------------------------------------- 会话 A：投影主链路
const stateA = {
  providerId: 'hemi-mem-a', modelId: 'probe-model-a', tag: 'A',
  viewText: 'HEMI_MEMORY_VIEW_A1 全局+工作区A的有效记忆(第1版)',
  hooks: [], failNext: false, forcedSystemPrompt: null,
}
const sessionA = await createProbeSession(
  makeMemoryBridge({ name: 'hemi-bridge-a', providerId: stateA.providerId, modelId: stateA.modelId, tag: stateA.tag, state: stateA }),
  stateA, APPEND_MARKER,
  // M6 需要一次真实压缩：默认 keepRecentTokens=20000，探针会话远小于该窗口，
  // 「近期窗口」内全保留导致没有可摘要内容；压到 1 让切割点前移（只影响本探针，非产品值）。
  { compaction: { keepRecentTokens: 1 } })
const compactEvents = []
// 会话总线终态事件是 compaction_end；session_compact 是扩展侧事件名，别混用。
sessionA.subscribe((e) => { if (e.type === 'compaction_end') compactEvents.push(e) })

// M1+M2+M3+M8：一次 prompt 触发「请求1(工具)→执行→请求2(总结)」，覆盖每请求钩子、
// 注入可见且不回写、原 system/工具保留、纯记忆结果在下一请求前被改写。
setScript([
  { toolCall: { name: 'hemi_mem_read', args: {} } },
  { text: 'A_ROUND1_DONE' },
])
await sessionA.prompt('请读取一次记忆')
const aReqs = () => reqsFor(stateA.modelId)
record('M1-per-request', 'context_with_system 每次模型请求前触发，钩子输入为含 system 的完整消息',
  stateA.hooks.length === 2 && aReqs().length === 2 && stateA.hooks.every((h) => h.firstRole === 'system'),
  { hooks: stateA.hooks.length, requests: aReqs().length, firstRoles: stateA.hooks.map((h) => h.firstRole) })

const allTextsJoined = aReqs().map((r) => r.texts.join('\n'))
record('M2-injection-visible', '末尾注入 sections.hemi_memory 进入真实 provider 请求，且不回写会话（后续钩子输入无注入段）',
  allTextsJoined.every((t, i) => t.includes(i === 0 ? 'HEMI_MEMORY_VIEW_A1' : 'HEMI_MEMORY_VIEW_A1'))
    && stateA.hooks.every((h) => !h.injectedInInput),
  { perRequestHasView: allTextsJoined.map((t) => t.includes('HEMI_MEMORY_VIEW_A1')), injectedInInput: stateA.hooks.map((h) => h.injectedInInput) })

// 会话条目不含注入段（inMemory 会话管理器可读时核验）。
let entriesLeak = 'n/a'
try {
  if (typeof sessionA.sessionManager?.getEntries === 'function') {
    entriesLeak = JSON.stringify(sessionA.sessionManager.getEntries()).includes('hemi_memory')
  }
} catch { /* 保持 n/a，不作为门 */ }
record('M2b-no-session-persist', '注入段不进入持久会话条目（getEntries 无 hemi_memory）', entriesLeak === false, { entriesLeak })

record('M3-system-tools-preserved', '投影保留原 system 与工具声明：首 system 文本逐字一致且含宿主追加段，工具列表一致',
  aReqs()[0].systemTexts[0] === aReqs()[1].systemTexts[0]
    && (aReqs()[0].systemTexts[0] ?? '').includes(APPEND_MARKER)
    && JSON.stringify(aReqs()[0].tools) === JSON.stringify(aReqs()[1].tools)
    && aReqs()[0].tools.includes('hemi_mem_read'),
  { sysEqual: aReqs()[0].systemTexts[0] === aReqs()[1].systemTexts[0], toolsEqual: JSON.stringify(aReqs()[0].tools) === JSON.stringify(aReqs()[1].tools), tools: aReqs()[0].tools })

const hook2 = stateA.hooks[1]
record('M8-tool-result-projection', '工具边界：钩子在工具结果后、下一请求前触发，输入含原始 toolResult，返回值可将其改写为投影结果',
  hook2?.rawToolResultInInput === true
    && hasText(stateA.modelId, 'MEMRESULT:PROJECTED-A')
    && !hasText(stateA.modelId, 'MEMRESULT:RAW-A'),
  { hook2RawSeen: hook2?.rawToolResultInInput, hook2Roles: hook2?.roles, lastTextsHasProjected: hasText(stateA.modelId, 'MEMRESULT:PROJECTED-A'), lastTextsHasRaw: hasText(stateA.modelId, 'MEMRESULT:RAW-A') })

// M4：视图更新只替换不累积。
stateA.viewText = 'HEMI_MEMORY_VIEW_A2 全局+工作区A的有效记忆(第2版)'
setScript([{ text: 'A_ROUND2_DONE' }])
await sessionA.prompt('再总结一次')
record('M4-view-replacement', '视图更新后请求只含新视图，旧视图不累积残留',
  hasText(stateA.modelId, 'HEMI_MEMORY_VIEW_A2') && !hasText(stateA.modelId, 'HEMI_MEMORY_VIEW_A1'),
  { hasA2: hasText(stateA.modelId, 'HEMI_MEMORY_VIEW_A2'), hasA1: hasText(stateA.modelId, 'HEMI_MEMORY_VIEW_A1'), requests: aReqs().length })

// M5：钩子抛错被派发器吞掉——请求仍发出、走未投影原文、system/工具不受损。
stateA.failNext = true
const hooksBeforeThrow = stateA.hooks.length
setScript([{ text: 'A_ROUND3_DONE_AFTER_THROW' }])
await sessionA.prompt('继续，这次投影会失败')
const throwReq = lastReq(stateA.modelId)
record('M5-hook-throw-swallowed', '钩子抛错被捕获：请求仍发出、payload 无注入记忆、首 system 与工具声明不受损',
  aReqs().length === 4 && stateA.hooks.length === hooksBeforeThrow + 1
    && !(throwReq.texts.join('\n').includes('HEMI_MEMORY_VIEW'))
    && (throwReq.systemTexts[0] ?? '').includes(APPEND_MARKER)
    && throwReq.tools.includes('hemi_mem_read'),
  { requests: aReqs().length, hooks: stateA.hooks.length, viewInPayload: throwReq.texts.join('\n').includes('HEMI_MEMORY_VIEW'), sysHasMarker: (throwReq.systemTexts[0] ?? '').includes(APPEND_MARKER), tools: throwReq.tools })

// M6：压缩摘要请求绕过 transformContext（源码事实：compact 直接用 agent.streamFunction）。
const hooksBeforeCompact = stateA.hooks.length
const reqIdxBeforeCompact = aReqs().length
setScript([{ text: 'COMPACTION_SUMMARY_TEXT' }, { text: 'TURN_PREFIX_TEXT' }, { text: 'A_ROUND4_DONE' }])
let compactErr = null
try { await sessionA.compact('probe') } catch (e) { compactErr = String(e) }
// 压缩产生 1～2 个摘要请求（split-turn 时主摘要＋轮前缀各一次）：无工具声明、
// 无注入记忆、期间不触发钩子。
const summarizationReqs = aReqs().slice(reqIdxBeforeCompact)
const hooksAfterCompact = stateA.hooks.length
stateA.viewText = 'HEMI_MEMORY_VIEW_A3 全局+工作区A的有效记忆(第3版)'
await sessionA.prompt('压缩后继续')
const postCompactReq = lastReq(stateA.modelId)
record('M6-compaction-bypass', '压缩摘要请求（1～2 个）不触发钩子、不含注入记忆与工具声明；压缩后下一请求投影恢复且无旧视图',
  compactErr === null
    && summarizationReqs.length >= 1 && summarizationReqs.length <= 2
    && hooksAfterCompact === hooksBeforeCompact
    && summarizationReqs.every((r) => !r.texts.join('\n').includes('HEMI_MEMORY_VIEW'))
    && summarizationReqs.every((r) => !r.tools.includes('hemi_mem_read'))
    && postCompactReq.texts.join('\n').includes('HEMI_MEMORY_VIEW_A3')
    && !postCompactReq.texts.join('\n').includes('HEMI_MEMORY_VIEW_A1')
    && !postCompactReq.texts.join('\n').includes('HEMI_MEMORY_VIEW_A2')
    && compactEvents.length >= 1,
  { compactErr, summarizationRequests: summarizationReqs.length, hooksBeforeCompact, hooksAfterCompact, compactEvents: compactEvents.length, summaryReqsClean: summarizationReqs.map((r) => !r.texts.join('\n').includes('HEMI_MEMORY_VIEW')), summaryReqTools: summarizationReqs.map((r) => r.tools), postCompactHasA3: postCompactReq.texts.join('\n').includes('HEMI_MEMORY_VIEW_A3') })

// ---------------------------------------------------------------- 会话 B：并行闭包隔离
const stateB = {
  providerId: 'hemi-mem-b', modelId: 'probe-model-b', tag: 'B',
  viewText: 'HEMI_MEMORY_VIEW_B1 工作区B的有效记忆(第1版)',
  hooks: [], failNext: false, forcedSystemPrompt: null,
}
const sessionB = await createProbeSession(
  makeMemoryBridge({ name: 'hemi-bridge-b', providerId: stateB.providerId, modelId: stateB.modelId, tag: stateB.tag, state: stateB }),
  stateB, APPEND_MARKER)
setScript([{ text: 'B_ROUND1_DONE' }])
await sessionB.prompt('读取记忆并总结')
stateA.viewText = 'HEMI_MEMORY_VIEW_A4 全局+工作区A的有效记忆(第4版)'
setScript([{ text: 'A_ROUND5_DONE' }])
await sessionA.prompt('最后总结一次')
record('M7-closure-isolation', '两个并行会话的内联工厂闭包互不串扰：各自请求只含本会话视图',
  hasText(stateB.modelId, 'HEMI_MEMORY_VIEW_B1') && !hasText(stateB.modelId, 'HEMI_MEMORY_VIEW_A')
  && hasText(stateA.modelId, 'HEMI_MEMORY_VIEW_A4') && !hasText(stateA.modelId, 'HEMI_MEMORY_VIEW_B1'),
  { bHasOwn: hasText(stateB.modelId, 'HEMI_MEMORY_VIEW_B1'), bHasA: hasText(stateB.modelId, 'HEMI_MEMORY_VIEW_A'), aHasOwn: hasText(stateA.modelId, 'HEMI_MEMORY_VIEW_A4'), aHasB: hasText(stateA.modelId, 'HEMI_MEMORY_VIEW_B1') })

// ---------------------------------------------------------------- 会话 C：forced prompt 冲突钉死
const stateC = {
  providerId: 'hemi-mem-c', modelId: 'probe-model-c', tag: 'C',
  viewText: 'HEMI_MEMORY_VIEW_C1 工作区C的有效记忆(第1版)',
  hooks: [], failNext: false,
  forcedSystemPrompt: 'FORCED_SYSTEM_TEXT_PROBE 另一扩展强制了完整系统提示词',
}
const sessionC = await createProbeSession(
  makeMemoryBridge({ name: 'hemi-bridge-c', providerId: stateC.providerId, modelId: stateC.modelId, tag: stateC.tag, state: stateC }),
  stateC, APPEND_MARKER)
setScript([{ text: 'C_ROUND1_DONE' }])
await sessionC.prompt('读取记忆并总结')
const cReq = lastReq(stateC.modelId)
record('M9-forced-prompt-conflict', 'before_agent_start.systemPrompt 的 forced 投影在钩子后折叠全部 system：桥注入段被丢弃（Hemi 桥不得返回 forced systemPrompt）',
  stateC.hooks.length >= 1
    && (cReq.systemTexts[0] ?? '').includes('FORCED_SYSTEM_TEXT_PROBE')
    && !(cReq.texts.join('\n').includes('HEMI_MEMORY_VIEW_C1')),
  { cHooks: stateC.hooks.length, forcedLeads: (cReq.systemTexts[0] ?? '').includes('FORCED_SYSTEM_TEXT_PROBE'), viewSurvived: cReq.texts.join('\n').includes('HEMI_MEMORY_VIEW_C1'), roles: cReq.roles })

// ---------------------------------------------------------------- 资源清理
sessionA.dispose()
sessionB.dispose()
sessionC.dispose()
await new Promise((r) => setTimeout(r, 100))
const resources = process.getActiveResourcesInfo()
const timers = resources.filter((r) => r === 'Timeout').length
record('M10-resources', '全部会话 dispose 后无遗留 timer / 活跃 socket（除探针自身 mock server）', timers === 0,
  { timers, resources: [...new Set(resources)] })

// ---------------------------------------------------------------- 汇总
const pass = findings.filter((f) => f.ok).length
console.log(`\n=== memory projection probe summary: ${pass}/${findings.length} passed (sdk ${sdkVersion}, node ${process.version}) ===`)
server.close()
for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
process.exit(pass === findings.length ? 0 : 1)
