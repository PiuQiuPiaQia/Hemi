// 历史专项：060 已按用户裁决移除队列并入，本脚本不再作为现行门禁。
console.error('060 已移除队列并入；此历史专项探针已退役，请使用 verify-060-queue.mjs journey。');
process.exit(2);
// 057 S 层探针（AC-36）：六组竞争时序的「真 SDK mock」关键边界三连跑。
// U 层（conversation-controller.race.test.mjs）用可控替身＋种子证明归约层不变量；
// 本探针把**真实 ConversationController** 接上**真实 pi-coding-agent 会话**（本地
// mock Anthropic Messages 端点），适配层镜像生产 createLlmFlowRuntime 契约：
//   start＝session.prompt（自闭合：收口时自呈 run-settled/run-closed）
//   merge＝isBusy 检查＋session.steer＋user message_start 认领投递（watchMergeDelivery 同口径）
//   stop＝标记＋session.abort
// 六组边界（对齐补充验证标准 AC-36；组6 订阅/快照/补丁链是宿主归约层、无 SDK 面，
// 记录说明行）：
//   G1 merge×原运行关闭：S-G1a 在途并入完整投递链；S-G1b 收口先于投递（滞留→待核对）
//   G2 实际投递×ACK：S-G2b handled 接管；S-G2c hook 改写；S-G2d 投递/ACK 先后探测
//   G3 stop×准备/在途/工具/settled：S-G3a~d（准备期停止、在途停止、慢工具停止、
//       迟到/重复 stop 对新回合无效）
//   G4 发送×队列派发×后台报告：S-G4a 三条队列 FIFO＋单主运行；S-G4b 报告不抢队列
//       （非暂停/暂停两态）
//   G5 rewind×旧回执：S-G5a 回卷代次隔离；S-G5b dispose 后迟到提交不串新实例
// 完整三连跑：整个 battery 连跑 3 轮（每轮全新会话/临时目录），全部通过才算过；
// 不按平均通过率放行。运行：node scripts/pi-057-s-layer.mjs（exit 0＝3/3 全过）。
// 改主/子 agent 运行时前，先跑 node scripts/pi-056-agent-probe.mjs（13 项）。
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { createConversationController } from '../src/main/services/conversation-controller.mjs'

const { createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager } =
  await import('@earendil-works/pi-coding-agent')

const findings = []
function record(id, claim, ok, detail) {
  findings.push({ id, claim, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}`)
  if (detail !== undefined) console.log(`      → ${JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function withTimeout(p, ms, label) {
  let timer
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}-timeout`)), ms) })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}
async function until(fn, ms = 15000, step = 20) {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > ms) throw new Error(`until-timeout（${ms}ms）`)
    await sleep(step)
  }
}
function deferred() {
  let resolve; let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------- mock Anthropic Messages
const requests = []
const responders = new Map() // model → (body, nth) => step
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    requests.push(body)
    const nth = requests.filter((r) => r.model === body.model).length
    const step = (responders.get(body.model) ?? (() => ({ text: 'OK' })))(body, nth) ?? { text: 'OK' }
    if (step.status) {
      res.writeHead(step.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { message: `probe-injected-${step.status}` } }))
      return
    }
    const events = []
    const ev = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
    let index = 0
    const calls = step.toolCalls ?? (step.toolCall ? [step.toolCall] : [])
    if (calls.length) {
      for (const call of calls) {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${requests.length}_${index}`, name: call.name, input: {} } })
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args ?? {}) } })
        ev('content_block_stop', { index })
        index++
      }
    } else {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: String(step.text ?? '') } })
      ev('content_block_stop', { index })
    }
    ev('message_delta', { delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
    ev('message_stop', {})
    setTimeout(() => {
      if (res.destroyed) return
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.join(''))
    }, step.delayMs ?? 0)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const mockBase = `http://127.0.0.1:${server.address().port}`

const bodyText = (body) => JSON.stringify(body.messages ?? [])
const lastUserText = (body) => {
  const users = (body.messages ?? []).filter((m) => m.role === 'user')
  return JSON.stringify(users.at(-1)?.content ?? [])
}
const modelRequests = (model) => requests.filter((b) => b.model === model)
/** 某文本作为「末条 user 消息」被请求承载的次数（同文各一次的投递证据）。 */
const soloCarriers = (model, text, notText = null) => modelRequests(model).filter((b) =>
  lastUserText(b).includes(text) && (!notText || !lastUserText(b).includes(notText))).length
const carriersOf = (model, text) => modelRequests(model).filter((b) => bodyText(b).includes(text)).length

// ---------------------------------------------------------------- 会话工厂（057 探针同骨架）
const tmpRoots = []
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpRoots.push(d); return d }

async function createSession({
  model, tools = [], inputHook = null, steeringMode = 'one-at-a-time',
  agentDir = null, cwd = null, systemPrompt = 'PROBE_SYSTEM',
  settings = { retry: { enabled: false } }, // C1 口径：探针不掺 038 备用重试域
}) {
  const dir = agentDir ?? mkdtemp('hemi-057s-agent-')
  const workDir = cwd ?? mkdtemp('hemi-057s-cwd-')
  const ext = {
    name: `probe-${model}`,
    factory: (pi) => {
      pi.registerProvider(`p-${model}`, {
        baseUrl: mockBase, apiKey: 'probe', api: 'anthropic-messages',
        models: [{ id: model, name: model, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
      })
      if (inputHook) pi.on('input', inputHook)
      for (const tool of tools) {
        pi.registerTool({
          name: tool.name, label: tool.name, description: `probe tool ${tool.name}`,
          parameters: { type: 'object', properties: { x: { type: 'string' } } },
          ...(tool.sequential ? { executionMode: 'sequential' } : {}),
          execute: async (_id, params, signal) => ({ content: [{ type: 'text', text: await tool.impl(params, signal) }] }),
        })
      }
    },
  }
  const settingsManager = SettingsManager.inMemory(settings)
  const resourceLoader = new DefaultResourceLoader({
    cwd: workDir, agentDir: dir, settingsManager,
    extensionFactories: [ext],
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: workDir, agentDir: dir, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(workDir),
    noTools: 'builtin',
  })
  await session.bindExtensions({ mode: 'rpc', uiContext: new Proxy({}, { get: () => async () => undefined }) })
  session.setSteeringMode(steeringMode)
  await session.setModel(session.modelRuntime.getModels(`p-${model}`)[0])
  return session
}

// ---------------------------------------------------------------- 控制器接线（镜像 createLlmFlowRuntime）
/** 生产契约镜像：start＝prompt 自闭合（收口自呈 settled/closed，outcome 按 stop 标记）；
 * merge＝isBusy 门＋steer＋投递认领（单文本块匹配登记文本，watchMergeDelivery 同口径）；
 * stop＝runId 标记＋abort。事件回合（input=null）以占位文本起 prompt。 */
function wireController({ session, store = null }) {
  const facts = {
    deliveries: [], // 纯文本投递 { text, at }
    settled: 0,
    startCalls: [], // { runId, source, inputId }
    activeStarts: 0, maxActiveStarts: 0,
    stops: [],
  }
  session.subscribe((e) => {
    if (e.type === 'message_start' && e.message?.role === 'user') {
      const content = e.message?.content
      const block = Array.isArray(content) && content.length === 1 ? content[0] : null
      if (block?.type === 'text' && typeof block.text === 'string') facts.deliveries.push({ text: block.text, at: Date.now() })
    } else if (e.type === 'agent_settled') {
      facts.settled += 1
    }
  })
  let controller
  const watchDelivery = ({ inputId, text, runId, generation }) => {
    let done = false
    session.subscribe((e) => {
      if (done) return
      if (e.type !== 'message_start' || e.message?.role !== 'user') return
      const content = e.message?.content
      const block = Array.isArray(content) && content.length === 1 ? content[0] : null
      if (block?.type !== 'text' || block.text !== text) return
      done = true
      controller.applyFact({ type: 'input-delivered', input: { inputId, text, inputSource: 'text' }, runId, at: Date.now(), generation })
    })
    return () => { done = true }
  }
  const stopFlags = new Map()
  // 原生 SDK 会话没有 isBusy（那是 hemi-session 包装层的自有标志）——适配层
  // 自记忙态（prompt 起 → 收口止），与 hemi-session.mjs 的 busy 追踪同构。
  let busy = false
  const runtime = {
    async start({ runId, envelope, source, generation }) {
      facts.startCalls.push({ runId, source, inputId: envelope?.inputId ?? null })
      facts.activeStarts += 1
      facts.maxActiveStarts = Math.max(facts.maxActiveStarts, facts.activeStarts)
      busy = true
      try {
        await session.prompt(String(envelope?.text ?? '[event-turn]'))
        const stopped = stopFlags.get(runId) === true
        controller.applyFact({ type: 'run-settled', runId, at: Date.now(), generation })
        controller.applyFact({ type: 'run-closed', runId, outcome: stopped ? 'stopped' : 'completed', at: Date.now(), generation })
        return { modelUsed: null, result: { text: 'done' }, aborted: stopped }
      } finally {
        busy = false
        facts.activeStarts -= 1
      }
    },
    async merge({ runId, inputId, envelope, generation }) {
      if (!busy) {
        const error = new Error('主 agent 不在途，并入未接收')
        error.code = 'not-received'
        throw error
      }
      watchDelivery({ inputId, text: String(envelope.text ?? ''), runId, generation })
      const result = await session.steer(String(envelope.text ?? ''))
      if (result && result.ok === false) {
        const error = new Error(`并入未接收（${result.reason ?? 'unknown'}）`)
        error.code = 'not-received'
        throw error
      }
      return result?.disposition === 'handled' ? 'handled' : 'queued'
    },
    async stop({ runId }) {
      facts.stops.push(runId)
      stopFlags.set(runId, true)
      await session.abort()
      return { ok: true }
    },
  }
  controller = createConversationController({
    conversationId: 'conv-057s',
    effects: { runtime, store: store ?? { update: async () => {}, flush: async () => {} } },
  })
  return { controller, facts }
}

const makeInput = (inputId, text, inputSource = 'text') => ({
  inputId, editRevision: 0, text, inputSource, attachmentIds: [], references: null, createdAt: Date.now(),
})
const pendingState = (controller, inputId) => controller.getSnapshot().pending.find((e) => e.inputId === inputId)
const timelineUserTexts = (controller) => controller.getSnapshot().timeline.filter((e) => e.kind === 'user').map((e) => e.text)
const runsArray = (controller) => Object.values(controller.getSnapshot().runs ?? {})

/** 门工具：阻塞直至 release；abort 可观察。 */
function gateTool(marks, mark) {
  let release
  const gate = new Promise((r) => { release = r })
  return {
    release,
    tool: {
      name: 'slow', sequential: true,
      impl: (_params, signal) => new Promise((resolve) => {
        marks.push(mark)
        signal?.addEventListener('abort', () => { marks.push(`${mark}-aborted`); resolve('aborted') })
        gate.then(() => resolve('slow-done'))
      }),
    },
  }
}

// ================================================================ 六组边界 battery
async function battery(pass) {
  console.log(`\n━━━ 第 ${pass} 轮 ━━━`)

  // ---------------------------------------------------------------- G1a 在途并入完整投递链（TC-057-007 顺序一：ACK→旧尾部→投递→新输出）
  {
    const marks = []
    const g = gateTool(marks, 'tool-blocked')
    const model = `g1a-${pass}`
    const session = await createSession({ model, tools: [g.tool] })
    responders.set(model, (_b, nth) => (nth === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'G1A_DONE' }))
    const { controller, facts } = wireController({ session })
    const sentP = controller.command({ type: 'send', input: makeInput('in-g1a', 'G1A 开局') })
    await until(() => marks.includes('tool-blocked'))
    const q1 = await controller.command({ type: 'send', input: makeInput('in-g1a-q1', 'G1A 并入补充', 'voice') })
    const merged = await controller.command({ type: 'mergeInput', inputId: 'in-g1a-q1', expectedEditRevision: 0 })
    g.release()
    const sent = await sentP
    const delivery = facts.deliveries.find((d) => d.text === 'G1A 并入补充') ?? null
    const dupFact = controller.applyFact({
      type: 'input-delivered', input: { inputId: 'in-g1a-q1', text: 'G1A 并入补充', inputSource: 'voice' },
      runId: sent.runId, at: Date.now(), generation: controller.getSnapshot().generation,
    })
    record('S-G1a-merge-delivered', '在途并入：ACK 先回、投递恰一次、转正用户项、运行 completed；迟到重复 input-delivered 幂等拒绝',
      q1.ok && q1.disposition === 'queued' && merged.ok && merged.disposition === 'waiting-delivery'
        && facts.deliveries.filter((d) => d.text === 'G1A 并入补充').length === 1
        && delivery != null
        && pendingState(controller, 'in-g1a-q1') == null
        && timelineUserTexts(controller).filter((t) => t === 'G1A 并入补充').length === 1
        && soloCarriers(model, 'G1A 并入补充', 'G1A 开局') === 1
        && runsArray(controller).every((r) => r.outcome === 'completed')
        && dupFact.applied === false,
      { merged, dupApplied: dupFact.applied, deliveries: facts.deliveries.map((d) => d.text), carriers: soloCarriers(model, 'G1A 并入补充', 'G1A 开局') })
    session.dispose()
  }

  // ---------------------------------------------------------------- G1b 收口先于投递（滞留→待核对，不自动重发）
  {
    const marks = []
    const g = gateTool(marks, 'tool-blocked')
    const model = `g1b-${pass}`
    const session = await createSession({ model, tools: [g.tool] })
    responders.set(model, (_b, nth) => (nth === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'G1B_DONE' }))
    const { controller } = wireController({ session })
    void controller.command({ type: 'send', input: makeInput('in-g1b', 'G1B 开局') })
    await until(() => marks.includes('tool-blocked'))
    await controller.command({ type: 'send', input: makeInput('in-g1b-q1', 'G1B 未及投递') })
    const merged = await controller.command({ type: 'mergeInput', inputId: 'in-g1b-q1', expectedEditRevision: 0 })
    const stopped = await controller.command({ type: 'stop' })
    await until(() => runsArray(controller).every((r) => r.closedAt))
    const stableAt = modelRequests(model).length
    await sleep(300)
    // 停止竞速的双态结局（都合法，断言按实际落点分类）：
    //   甲）投递事件先于 abort 落地——并入转正为用户项（模型未消费，部分内容保留语义）；
    //   乙）未投递——滞留回待核对。两态均不得自动重发/复活。
    const deliveredIntoDying = timelineUserTexts(controller).includes('G1B 未及投递')
    const itemState = pendingState(controller, 'in-g1b-q1')?.state ?? null
    const snap = controller.getSnapshot()
    // 停机窗口内零自动请求（数值在 flush 前取，flush 属显式动作）。
    const requestsStableInWindow = modelRequests(model).length === stableAt
    const carriersBeforeFlush = carriersOf(model, 'G1B 未及投递')
    // SDK 事实（B7 同口径）：滞留/已入条的并入文本随下轮 prompt 冒出。
    await session.prompt('G1B 新回合')
    const strandedSurfaced = bodyText(requests.at(-1) ?? {}).includes('G1B 未及投递')
    record('S-G1b-stranded-merge', '停止×并入竞速：投递先于 abort 则转正（模型未消费，不重发不复活）；未投递则回待核对。两态均停机窗口零自动请求、队列暂停',
      merged.ok && merged.disposition === 'waiting-delivery' && stopped.ok
        && (deliveredIntoDying ? itemState === null : itemState === 'needs-review')
        && requestsStableInWindow
        && carriersBeforeFlush === 0 // 模型在停机窗口内从未消费该文本
        && snap.queuePaused === true
        && runsArray(controller).some((r) => r.outcome === 'stopped'),
      { merged, outcome: deliveredIntoDying ? 'delivered-into-dying-run' : 'stranded-needs-review', itemState, queuePaused: snap.queuePaused, requestsStableInWindow, strandedSurfaced })
    session.dispose()
  }

  // ---------------------------------------------------------------- G2b handled 扩展接管（TC-057-010）
  {
    const marks = []
    const g = gateTool(marks, 'tool-blocked')
    const model = `g2b-${pass}`
    const session = await createSession({
      model, tools: [g.tool],
      inputHook: (event) => (String(event.text ?? '').includes('TAKEOVER') ? { action: 'handled' } : { action: 'continue' }),
    })
    responders.set(model, (_b, nth) => (nth === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'G2B_DONE' }))
    const { controller, facts } = wireController({ session })
    void controller.command({ type: 'send', input: makeInput('in-g2b', 'G2B 开局') })
    await until(() => marks.includes('tool-blocked'))
    await controller.command({ type: 'send', input: makeInput('in-g2b-q1', 'TAKEOVER 接管这条') })
    const merged = await controller.command({ type: 'mergeInput', inputId: 'in-g2b-q1', expectedEditRevision: 0 })
    g.release()
    await until(() => runsArray(controller).every((r) => r.closedAt))
    record('S-G2b-handled', '扩展接管（忙窗口登记 queued、投递期被扩展吞掉）：无投递事件、无请求承载、条目回待核对（不当已投递、不自动重发）；空闲窗口的 handled 位移见 flow-probe B4',
      merged.ok && merged.disposition === 'waiting-delivery' // 忙窗口 steer 先回 queued；接管发生在投递期
        && facts.deliveries.every((d) => d.text !== 'TAKEOVER 接管这条')
        && carriersOf(model, 'TAKEOVER 接管这条') === 0
        && pendingState(controller, 'in-g2b-q1')?.state === 'needs-review'
        && timelineUserTexts(controller).every((t) => t !== 'TAKEOVER 接管这条'),
      { merged, itemState: pendingState(controller, 'in-g2b-q1')?.state })
    session.dispose()
  }

  // ---------------------------------------------------------------- G2c input hook 改写（TC-057-010）
  {
    const marks = []
    const g = gateTool(marks, 'tool-blocked')
    const model = `g2c-${pass}`
    const session = await createSession({
      model, tools: [g.tool],
      inputHook: (event) => (
        String(event.text ?? '').includes('G2C 原文')
          ? { action: 'transform', text: String(event.text).replace('G2C 原文', 'G2C 改写') }
          : { action: 'continue' }
      ),
    })
    responders.set(model, (_b, nth) => (nth === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'G2C_DONE' }))
    const { controller } = wireController({ session })
    void controller.command({ type: 'send', input: makeInput('in-g2c', 'G2C 开局') })
    await until(() => marks.includes('tool-blocked'))
    await controller.command({ type: 'send', input: makeInput('in-g2c-q1', '并入这条 G2C 原文 补充') })
    const merged = await controller.command({ type: 'mergeInput', inputId: 'in-g2c-q1', expectedEditRevision: 0 })
    g.release()
    await until(() => runsArray(controller).every((r) => r.closedAt))
    record('S-G2c-transform', 'hook 改写后实际投递的是改写文本：SDK 只见改写文；宿主按登记文本认领不中→回待核对（不按原文冒认）',
      merged.ok && merged.disposition === 'waiting-delivery'
        && carriersOf(model, 'G2C 原文') === 0 && carriersOf(model, 'G2C 改写') >= 1
        && pendingState(controller, 'in-g2c-q1')?.state === 'needs-review'
        && timelineUserTexts(controller).every((t) => t !== '并入这条 G2C 原文 补充'),
      { merged, itemState: pendingState(controller, 'in-g2c-q1')?.state, carriersOriginal: carriersOf(model, 'G2C 原文'), carriersRewritten: carriersOf(model, 'G2C 改写') })
    session.dispose()
  }

  // ---------------------------------------------------------------- G2d 投递×ACK 先后探测（TC-057-007 顺序二物理探测）
  {
    const marks = []
    const g = gateTool(marks, 'tool-blocked')
    const model = `g2d-${pass}`
    const session = await createSession({ model, tools: [g.tool] })
    responders.set(model, (_b, nth) => (nth === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'G2D_DONE' }))
    const deliveryEvents = []
    session.subscribe((e) => {
      if (e.type === 'message_start' && e.message?.role === 'user') {
        const content = e.message?.content
        const block = Array.isArray(content) && content.length === 1 ? content[0] : null
        if (block?.type === 'text') deliveryEvents.push({ text: block.text, at: Date.now() })
      }
    })
    void session.prompt('G2D 开局')
    await until(() => marks.includes('tool-blocked'))
    // 顺序一（常规）：ACK 先于投递——两条并入在阻塞窗口登记。
    const ackA = await session.steer('G2D 甲')
    const deliveredBeforeAckA = deliveryEvents.some((d) => d.text === 'G2D 甲')
    // 顺序二（竞争）：释放与登记同拍——探测投递事件能否先于 ACK。
    g.release()
    const ackB = await session.steer('G2D 乙')
    const deliveredBeforeAckB = deliveryEvents.some((d) => d.text === 'G2D 乙')
    await withTimeout(session.waitForIdle(), 10000, 'G2D-idle')
    // 滞留兜底：若「乙」未在本次运行内消化，补一次 prompt 冲刷（B5/B7 事实）。
    if (!carriersOf(model, 'G2D 乙')) await session.prompt('G2D 收尾')
    // 「恰投递一次」按投递事件数（user message_start）计——flush 时历史重放会让
    // 请求体重复包含已投递文本，那是上下文回放不是二次投递。
    const deliveriesA = deliveryEvents.filter((d) => d.text === 'G2D 甲').length
    const deliveriesB = deliveryEvents.filter((d) => d.text === 'G2D 乙').length
    const soloA = soloCarriers(model, 'G2D 甲', 'G2D 开局')
    const soloB = soloCarriers(model, 'G2D 乙', 'G2D 开局')
    record('S-G2d-delivery-ack-order', '实际投递与 ACK：登记即回 ACK（顺序一）；释放同拍的竞争并入无论何时投递，投递事件恰一次、至少一次以末条 user 消息承载——顺序无关性由 U 层组2 随机矩阵＋幂等归约保证',
      ackA === 'queued' && ackB === 'queued'
        && deliveriesA === 1 && deliveriesB === 1
        && soloA === 1 && soloB === 1,
      { ackA, ackB, deliveredBeforeAckA, deliveredBeforeAckB, deliveriesA, deliveriesB, soloA, soloB, note: 'deliveredBeforeAck=true 即顺序二（投递先于 ACK）在本轮物理出现；三连跑未出现时以 U 层矩阵佐证顺序无关' })
    session.dispose()
  }

  // ---------------------------------------------------------------- G3a 准备期停止（受理保存窗口）
  {
    const marks = []
    const model = `g3a-${pass}`
    const session = await createSession({ model, tools: [gateTool(marks, 'tool-blocked').tool] })
    responders.set(model, () => ({ text: 'G3A_DONE' }))
    const gate = deferred()
    const store = { update: () => gate.promise, flush: async () => {} }
    const { controller, facts } = wireController({ session, store })
    const sendP = controller.command({ type: 'send', input: makeInput('in-g3a', 'G3A 直接发') })
    await until(() => controller.getSnapshot().phase === 'preparing')
    const stopped = await controller.command({ type: 'stop' })
    gate.resolve()
    const sent = await sendP
    await sleep(200)
    const startsBeforeSecond = facts.startCalls.length
    const requestsBeforeSecond = modelRequests(model).length
    await sleep(300)
    await controller.command({ type: 'resumeQueue' })
    const second = await controller.command({ type: 'send', input: makeInput('in-g3a-2', 'G3A 二次') })
    record('S-G3a-stop-preparing', '准备期停止：迟到准备结果不启动模型（零请求）、运行 stopped、队列暂停；resumeQueue 后新发送正常执行',
      stopped.ok && sent.ok === false && sent.code === 'run-changed'
        && startsBeforeSecond === 0
        && requestsBeforeSecond === 0
        && runsArray(controller).every((r) => r.outcome === 'stopped' || r.outcome === 'completed')
        && second.ok && facts.startCalls.length === 1,
      { stopped, sent, startsBeforeSecond, requestsBeforeSecond, secondOk: second.ok })
    session.dispose()
  }

  // ---------------------------------------------------------------- G3b 在途请求停止
  {
    const model = `g3b-${pass}`
    const session = await createSession({ model })
    responders.set(model, (_b, nth) => ({ text: `G3B_DONE_${nth}`, delayMs: nth === 1 ? 400 : 0 }))
    const { controller, facts } = wireController({ session })
    const runP = controller.command({ type: 'send', input: makeInput('in-g3b', 'G3B 开局') })
    await until(() => modelRequests(model).length >= 1)
    await controller.command({ type: 'stop' })
    await runP
    const countAfter = modelRequests(model).length
    await sleep(300)
    // 稳定值在二次发送前取（数值求值时机：二次发送本身会加请求）。
    const requestsStableAfterStop = modelRequests(model).length === countAfter
    const second = await controller.command({ type: 'send', input: makeInput('in-g3b-2', 'G3B 二次') })
    record('S-G3b-stop-inflight', '在途请求停止：运行 stopped、请求不增长（无重试风暴）；随后新回合正常',
      runsArray(controller).some((r) => r.outcome === 'stopped')
        && facts.settled >= 1
        && requestsStableAfterStop
        && second.ok,
      { requestsStableAfterStop, settled: facts.settled, secondOk: second.ok })
    session.dispose()
  }

  // ---------------------------------------------------------------- G3c 慢工具停止
  {
    const marks = []
    const g = gateTool(marks, 'tool-blocked')
    const model = `g3c-${pass}`
    const session = await createSession({ model, tools: [g.tool] })
    responders.set(model, (_b, nth) => (nth === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'G3C_DONE' }))
    const { controller } = wireController({ session })
    const runP = controller.command({ type: 'send', input: makeInput('in-g3c', 'G3C 开局') })
    await until(() => marks.includes('tool-blocked'))
    await controller.command({ type: 'stop' })
    await runP
    const countAfter = modelRequests(model).length
    await sleep(250)
    record('S-G3c-stop-slow-tool', '工具阻塞中停止：abort signal 送达工具、无后续请求、运行 stopped',
      marks.includes('tool-blocked-aborted')
        && runsArray(controller).some((r) => r.outcome === 'stopped')
        && modelRequests(model).length === countAfter,
      { toolAborted: marks.includes('tool-blocked-aborted'), requestsStable: modelRequests(model).length === countAfter })
    session.dispose()
  }

  // ---------------------------------------------------------------- G3d 迟到/重复 stop
  {
    const model = `g3d-${pass}`
    const session = await createSession({ model })
    responders.set(model, (_b, nth) => ({ text: `G3D_DONE_${nth}`, delayMs: nth === 2 ? 350 : 0 }))
    const { controller, facts } = wireController({ session })
    const first = await controller.command({ type: 'send', input: makeInput('in-g3d-1', 'G3D 一') })
    const secondP = controller.command({ type: 'send', input: makeInput('in-g3d-2', 'G3D 二') })
    await until(() => modelRequests(model).length >= 2)
    const lateStop = await controller.command({ type: 'stop', targetRunId: first.runId })
    const stop1 = await controller.command({ type: 'stop' })
    const stop2 = await controller.command({ type: 'stop' })
    const second = await secondP
    record('S-G3d-late-double-stop', '旧 runId 的迟到 stop 明确 run-changed（不取消新回合）；stopping 期重复 stop 幂等不重复 abort；两运行各收口一次',
      lateStop.ok === false && lateStop.code === 'run-changed'
        && stop1.ok && stop2.ok
        && second.ok
        && facts.stops.length === 1
        && runsArray(controller).find((r) => r.runId === first.runId)?.outcome === 'completed'
        && runsArray(controller).find((r) => r.runId === second.runId)?.outcome === 'stopped'
        && facts.settled === 2,
      { lateStop, stop1: stop1.disposition, stop2: stop2.disposition, aborts: facts.stops.length, settled: facts.settled })
    session.dispose()
  }

  // ---------------------------------------------------------------- G4a 三条队列独立派发（TC-057-003）
  {
    const marks = []
    const g = gateTool(marks, 'tool-blocked')
    const model = `g4a-${pass}`
    const session = await createSession({ model, tools: [g.tool] })
    responders.set(model, (_b, nth) => (nth === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'G4A_DONE' }))
    const { controller, facts } = wireController({ session })
    void controller.command({ type: 'send', input: makeInput('in-g4a-r1', 'G4A 开局') })
    await until(() => marks.includes('tool-blocked'))
    const q1 = await controller.command({ type: 'send', input: makeInput('in-g4a-q1', 'G4A 队列一', 'voice') })
    const q2 = await controller.command({ type: 'send', input: makeInput('in-g4a-q2', 'G4A 队列二') })
    const q3 = await controller.command({ type: 'send', input: makeInput('in-g4a-q3', 'G4A 队列三') })
    const requestsWhileBlocked = modelRequests(model).length
    g.release()
    await until(() => controller.getSnapshot().phase === 'idle' && controller.getSnapshot().pending.length === 0)
    const sources = facts.startCalls.map((s) => s.source)
    const order = facts.deliveries.map((d) => d.text).filter((t) => t.startsWith('G4A '))
    record('S-G4a-queue-fifo', '忙时三条排队：阻塞期不派发；释放后 FIFO 独立派发（user→queue×3）、主运行并发恒 1、每条恰投递/承载一次、队列清零',
      q1.ok && q2.ok && q3.ok
        && requestsWhileBlocked === 1
        && JSON.stringify(sources) === JSON.stringify(['user', 'queue', 'queue', 'queue'])
        && facts.maxActiveStarts === 1
        && JSON.stringify(order) === JSON.stringify(['G4A 开局', 'G4A 队列一', 'G4A 队列二', 'G4A 队列三'])
        && soloCarriers(model, 'G4A 队列一', 'G4A 开局') === 1
        && soloCarriers(model, 'G4A 队列二', 'G4A 开局') === 1
        && soloCarriers(model, 'G4A 队列三', 'G4A 开局') === 1
        && runsArray(controller).every((r) => r.outcome === 'completed'),
      { sources, order, maxActiveStarts: facts.maxActiveStarts, queueLeft: controller.getSnapshot().pending.length, requestsWhileBlocked })
    session.dispose()
  }

  // ---------------------------------------------------------------- G4b 后台报告 vs 队列（TC-057-014 两态）
  for (const paused of [false, true]) {
    const marks = []
    const g = gateTool(marks, 'tool-blocked')
    const model = `g4b-${paused ? 'p' : 'n'}-${pass}`
    const session = await createSession({ model, tools: [g.tool] })
    responders.set(model, (_b, nth) => (nth === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'G4B_DONE' }))
    const { controller, facts } = wireController({ session })
    void controller.command({ type: 'send', input: makeInput('in-g4b-r1', 'G4B 开局') })
    await until(() => marks.includes('tool-blocked'))
    await controller.command({ type: 'send', input: makeInput('in-g4b-q1', 'G4B 队列一') })
    controller.applyFact({ type: 'report-queued', report: { taskId: 'T1', resultVersion: 1 } })
    if (paused) await controller.command({ type: 'stop' })
    g.release()
    if (paused) {
      await until(() => runsArray(controller).every((r) => r.closedAt))
      const stableAt = modelRequests(model).length
      await sleep(400)
      const held = modelRequests(model).length === stableAt
        && controller.getSnapshot().pendingReports.length === 1
        && pendingState(controller, 'in-g4b-q1') != null
      await controller.command({ type: 'resumeQueue' })
      await until(() => controller.getSnapshot().phase === 'idle' && controller.getSnapshot().pending.length === 0 && controller.getSnapshot().pendingReports.length === 0)
      record('S-G4b-paused', '真停止暂停：收口后队列与报告都不自动续排/转述；显式 resumeQueue 后仍按队列优先（user→queue→event）',
        held
          && JSON.stringify(facts.startCalls.map((s) => s.source)) === JSON.stringify(['user', 'queue', 'event'])
          && facts.maxActiveStarts === 1,
        { held, sources: facts.startCalls.map((s) => s.source) })
    } else {
      await until(() => controller.getSnapshot().phase === 'idle' && controller.getSnapshot().pending.length === 0 && controller.getSnapshot().pendingReports.length === 0)
      record('S-G4b-nonpaused', '非暂停：R1 收口后续排按队列优先、报告随后事件回合转述（user→queue→event），并发恒 1、报告不抢占',
        JSON.stringify(facts.startCalls.map((s) => s.source)) === JSON.stringify(['user', 'queue', 'event'])
          && facts.maxActiveStarts === 1,
        { sources: facts.startCalls.map((s) => s.source) })
    }
    session.dispose()
  }

  // ---------------------------------------------------------------- G5a 回卷代次隔离
  {
    const marks = []
    const g = gateTool(marks, 'tool-blocked')
    const model = `g5a-${pass}`
    const session = await createSession({ model, tools: [g.tool] })
    responders.set(model, (_b, nth) => (nth === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'G5A_NEW' }))
    const { controller } = wireController({ session })
    const firstP = controller.command({ type: 'send', input: makeInput('in-g5a-old', 'G5A 旧问题') })
    await until(() => marks.includes('tool-blocked'))
    const rewindP = controller.command({ type: 'rewind', targetInputId: 'in-g5a-old', input: makeInput('in-g5a-new', 'G5A 新问题') })
    await until(() => controller.getSnapshot().generation >= 2)
    const ghostFact = controller.applyFact({
      type: 'input-accepted', input: makeInput('in-g5a-ghost', 'G5A 幽灵旧输入'), generation: 1,
    })
    g.release()
    await rewindP
    await firstP.catch(() => {})
    await until(() => runsArray(controller).every((r) => r.closedAt))
    record('S-G5a-rewind-generation', '回卷：preempt 关旧运行、generation+1、旧代次新事实被归约层拒绝；新分支只含替换输入并正常收口',
      controller.getSnapshot().generation === 2
        && ghostFact.applied === false
        && timelineUserTexts(controller).every((t) => t !== 'G5A 旧问题')
        && timelineUserTexts(controller).includes('G5A 新问题')
        && soloCarriers(model, 'G5A 新问题', 'G5A 旧问题') === 1
        && runsArray(controller).every((r) => r.outcome === 'stopped' || r.outcome === 'completed'),
      { generation: controller.getSnapshot().generation, ghostApplied: ghostFact.applied, timeline: timelineUserTexts(controller) })
    session.dispose()
  }

  // ---------------------------------------------------------------- G5b dispose 后迟到提交不串新实例
  {
    const sharedAgent = mkdtemp('hemi-057s-agent-')
    const sharedCwd = mkdtemp('hemi-057s-cwd-')
    const oldModel = `g5b1-${pass}`
    const newModel = `g5b2-${pass}`
    const old = await createSession({ model: oldModel, agentDir: sharedAgent, cwd: sharedCwd })
    responders.set(oldModel, () => ({ text: 'G5B_OLD' }))
    await withTimeout(old.prompt('G5B 一号'), 10000, 'G5B-warm')
    old.dispose()
    const lateDisp = await old.steer('G5B 迟到旧输入').then((v) => String(v)).catch((e) => `throw:${e?.message}`)
    // C4 口径：dispose 后 steer 只入队；补一次 prompt 触发旧实例（真实发出请求）。
    const oldBefore = modelRequests(oldModel).length
    const flushResult = await old.prompt('G5B 冲刷').then(() => 'resolved', (e) => `throw:${e?.message}`)
    await until(() => modelRequests(oldModel).length >= oldBefore + 1, 8000).catch(() => null)
    const oldLateInAnyRequest = carriersOf(oldModel, 'G5B 迟到旧输入') >= 1
    const fresh = await createSession({ model: newModel, agentDir: sharedAgent, cwd: sharedCwd })
    responders.set(newModel, () => ({ text: 'G5B_NEW' }))
    await withTimeout(fresh.prompt('G5B 二号'), 10000, 'G5B-new')
    record('S-G5b-dispose-isolation', 'dispose 后迟到提交不抛错、旧实例仍会发出请求（C4 计数口径；实测该请求为旧上下文重放、不含迟到新文本）；同 agentDir 新实例零泄漏——宿主必须 epoch 守卫',
      lateDisp === 'queued' && flushResult === 'resolved'
        && modelRequests(oldModel).length >= oldBefore + 1
        && carriersOf(newModel, 'G5B 迟到旧输入') === 0
        && carriersOf(newModel, 'G5B 冲刷') === 0,
      { lateDisp, flushResult, oldRequestsAfter: modelRequests(oldModel).length - oldBefore, oldLateTextInRequests: oldLateInAnyRequest, freshLeakLate: carriersOf(newModel, 'G5B 迟到旧输入'), freshLeakFlush: carriersOf(newModel, 'G5B 冲刷') })
    fresh.dispose()
  }
}

// ---------------------------------------------------------------- G6：宿主归约层（无 SDK 面）
record('S-G6-host-layer-note', '组6（首次订阅/快照响应×补丁到达）是宿主归约与订阅桥边界、不经 SDK：由 U 层组6 种子矩阵（race.test）与渲染层 E 证据覆盖，本探针不设 SDK 面',
  true, { coveredBy: 'conversation-controller.race.test.mjs 组6；TC-057-016 层级 U＋E（无 S）' })

// ---------------------------------------------------------------- 三连跑
let passOk = true
for (const pass of [1, 2, 3]) {
  try {
    await battery(pass)
  } catch (error) {
    passOk = false
    console.log(`FAIL  battery-pass-${pass}  第 ${pass} 轮异常中断：${error?.stack ?? error}`)
    findings.push({ id: `battery-pass-${pass}`, claim: '整轮完整执行', ok: false, detail: String(error?.stack ?? error) })
  }
}
const failed = findings.filter((f) => !f.ok)
console.log(`\n057 S 层三连跑：${findings.length - failed.length}/${findings.length} 通过（3 轮完整执行${passOk ? '，无中断' : '，存在中断'}）`)
if (failed.length) {
  console.log(failed.map((f) => `FAIL ${f.id}: ${JSON.stringify(f.detail)}`).join('\n'))
  process.exitCode = 1
}
server.closeAllConnections()
server.close()
for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true })
