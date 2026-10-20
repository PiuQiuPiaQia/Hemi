// 057 前置探针（S0）：把对话流重构依赖的 SDK 输入／投递／停止边界钉成契约。
// 本地 mock Anthropic Messages 端点（骨架复用 056 探针），分场景：
//   B1 双同文并入：one-at-a-time 下两条同文 steer 各自一次 user 投递事件＋各一次
//      请求、settled 单次、pending 归零——身份按登记顺序，不按文本认领
//   B2 图片并入：steer 携带图片经队列投递，请求体含 image 块（附件不丢）
//   B3 input hook 变写：扩展 transform 后实际投递的是改写文本；宿主不能按原文
//      认领。steer ACK 与 user 投递事件的先后作为观察事实记录（两种顺序都成立）
//   B4 handled：扩展接管输入时 steer 返回 handled、无投递无请求——宿主不得
//      当已投递，也不得自动重发（条目保留待核对）
//   B5 request.reason 观察：steer 投递后的请求 reason 与新回合相同（user）——
//      宿主不能靠 SDK reason 区分并入与新回合（AC-32 修复依据）
//   B6 并入前后主备切换：按现行 pi-factory 口径实现路由（reason=user 重置主模型），
//      证明并入投递会把已切备用的运行拉回主模型——「并入不重置备用」要宿主自己记
//   B7 目标收口滞留输入：abort 后滞留 steer 的去向（保留/丢弃）；clearQueue 只还
//      文本不还图片；下轮 prompt 前必须回收，否则滞留输入随新回合冒出
//   C1 在途请求 abort：请求已发未回时停止 → settled 单次、无重试风暴
//   C2 慢工具 abort：工具阻塞中停止 → abort signal 送达工具、settled 单次
//   C3 abort 与迟到 steer 竞争：停止已发起后提交输入不复活运行（去向事实记录）
//   C4 dispose 后迟到提交：静默返回不抛错、无请求（056 事实的 steer 补充）
// 运行：node scripts/pi-057-flow-probe.mjs（exit 0＝全过）。
// 改主／子 agent 运行时前，先跑 node scripts/pi-056-agent-probe.mjs（13 项）。
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

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

// ---------------------------------------------------------------- mock Anthropic Messages（按模型名分流应答）
const requests = []
const responders = new Map() // model → (body) => step
function respond(body) {
  const fn = responders.get(body.model) ?? (() => ({ text: 'OK' }))
  return fn(body)
}
function lastIsToolResult(body) {
  const last = body.messages?.at(-1)
  return Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result')
}
const bodyText = (body) => JSON.stringify(body.messages ?? [])

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    requests.push(body)
    const step = respond(body) ?? { text: 'OK' }
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

// ---------------------------------------------------------------- 会话工厂
const tmpRoots = []
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpRoots.push(d); return d }
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * 057 探针会话工厂。options 相对 056 探针新增：
 * - models: 多物理模型 id 列表（B6 主备用；缺省 [model]）
 * - route: (request, ctx) => 虚拟模型路由（注册为 probe-route/auto，观察 request.reason）
 * - inputHook: (event) => InputEventResult（B3 transform / B4 handled）
 * - settings: 会话 settings（B6 开 SDK 重试预算）
 * - steeringMode: 缺省 one-at-a-time（057 并入口径）
 */
async function createSession({
  model, models = null, tools = [], route = null, inputHook = null, settings = {},
  steeringMode = 'one-at-a-time', systemPrompt = 'PROBE_SYSTEM',
}) {
  const physicalModels = models ?? [model]
  const agentDir = mkdtemp('hemi-057-agent-')
  const ext = {
    name: `probe-${model}`,
    factory: (pi) => {
      for (const m of physicalModels) {
        pi.registerProvider(`p-${m}`, {
          baseUrl: mockBase, apiKey: 'probe', api: 'anthropic-messages',
          models: [{ id: m, name: m, reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
        })
      }
      if (route) {
        pi.registerVirtualModel({
          provider: 'probe-route', id: 'auto', name: 'probe-route',
          thinkingLevels: ['off'],
          route: (request, ctx) => route(request, {
            find: (m) => ctx.modelRegistry.find(`p-${m}`, m),
          }),
        })
      }
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
  const cwd = mkdtemp('hemi-057-cwd-')
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: [ext],
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd, agentDir, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: 'builtin',
  })
  await session.bindExtensions({ mode: 'rpc', uiContext: new Proxy({}, { get: () => async () => undefined }) })
  session.setSteeringMode(steeringMode)
  const chosen = route
    ? session.modelRuntime.getModel('probe-route', 'auto')
    : session.modelRuntime.getModels(`p-${physicalModels[0]}`)[0]
  await session.setModel(chosen)
  return session
}

/** 订阅投递/收口事件。user 的 message_start 即实际投递边界——注意工具结果
 *  也以 user 角色发出 message_start，靠登记文本（而非事件本身）区分输入投递。 */
function trackDelivery(session, events) {
  session.subscribe((e) => {
    if (e.type === 'message_start' && e.message?.role === 'user') {
      events.push(`user-start:${String(JSON.stringify(e.message?.content ?? '')).slice(0, 60)}`)
    } else if (e.type === 'agent_settled') {
      events.push('settled')
    }
  })
}

/** 请求末条 user 消息的文本（anthropic 线上格式）。 */
function lastUserMessageText(body) {
  const userMessages = (body.messages ?? []).filter((m) => m.role === 'user')
  return JSON.stringify(userMessages.at(-1)?.content ?? [])
}

// ---------------------------------------------------------------- B1 双同文并入
{
  const timeline = []
  let release
  const gate = new Promise((r) => { release = r })
  const session = await createSession({
    model: 'b1-main',
    tools: [{ name: 'slow', sequential: true, impl: async () => { timeline.push('tool-blocked'); await gate; return 'slow-done' } }],
  })
  trackDelivery(session, timeline)
  let n = 0
  responders.set('b1-main', () => (++n === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'B1_DONE' }))
  const before = requests.length
  const run = session.prompt('B1 开局')
  while (!timeline.includes('tool-blocked')) await sleep(10)
  const d1 = await session.steer('同文追加')
  timeline.push('ack1')
  const d2 = await session.steer('同文追加')
  timeline.push('ack2')
  release()
  await withTimeout(run, 10000, 'B1-run')
  await withTimeout(session.waitForIdle(), 10000, 'B1-idle')
  const after = requests.slice(before)
  const userStarts = timeline.filter((x) => x.startsWith('user-start:') && x.includes('同文追加')).length
  // 承载请求：末条 user 消息恰为该条同文（第 2、3 次请求分别承载第 1、2 条）
  const soloCarriers = after.filter((b) => {
    const last = lastUserMessageText(b)
    return last.includes('同文追加') && !last.includes('B1 开局')
  })
  record('B1-identical-merge', '两条同文 steer 各自一次 user 投递事件＋各一次请求；settled 单次、pending 归零（身份按登记顺序）',
    d1 === 'queued' && d2 === 'queued' && userStarts === 2 && soloCarriers.length === 2
      && timeline.filter((x) => x === 'settled').length === 1 && session.pendingMessageCount === 0,
    { dispositions: [d1, d2], userStarts, carrierRequests: soloCarriers.length, settled: timeline.filter((x) => x === 'settled').length, pending: session.pendingMessageCount, timeline })
  session.dispose()
}

// ---------------------------------------------------------------- B2 图片并入
{
  const timeline = []
  let release
  const gate = new Promise((r) => { release = r })
  const session = await createSession({
    model: 'b2-main',
    tools: [{ name: 'slow', sequential: true, impl: async () => { timeline.push('tool-blocked'); await gate; return 'slow-done' } }],
  })
  trackDelivery(session, timeline)
  let n = 0
  responders.set('b2-main', () => (++n === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'B2_DONE' }))
  const before = requests.length
  const run = session.prompt('B2 开局')
  while (!timeline.includes('tool-blocked')) await sleep(10)
  const img = { type: 'image', data: PNG_1PX, mimeType: 'image/png' }
  const d = await session.steer('B2 看这张图', [img])
  timeline.push('ack')
  release()
  await withTimeout(run, 10000, 'B2-run')
  const carrier = requests.slice(before).find((b) => bodyText(b).includes('B2 看这张图'))
  const hasImage = Boolean(carrier) && /"type"\s*:\s*"image"/.test(bodyText(carrier))
  record('B2-image-merge', 'steer 携带的图片经队列投递进入模型请求（附件不丢）',
    d === 'queued' && hasImage,
    { disposition: d, hasImage })
  session.dispose()
}

// ---------------------------------------------------------------- B3 input hook 变写
{
  const timeline = []
  let release
  const gate = new Promise((r) => { release = r })
  const session = await createSession({
    model: 'b3-main',
    tools: [{ name: 'slow', sequential: true, impl: async () => { timeline.push('tool-blocked'); await gate; return 'slow-done' } }],
    inputHook: (event) => (
      String(event.text ?? '').includes('HOOK原文')
        ? { action: 'transform', text: String(event.text).replace('HOOK原文', 'HOOK改写') }
        : { action: 'continue' }
    ),
  })
  trackDelivery(session, timeline)
  let n = 0
  responders.set('b3-main', () => (++n === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'B3_DONE' }))
  const before = requests.length
  const run = session.prompt('B3 开局')
  while (!timeline.includes('tool-blocked')) await sleep(10)
  const d = await session.steer('这是 HOOK原文 的补充')
  timeline.push('ack')
  release()
  await withTimeout(run, 10000, 'B3-run')
  const after = bodyText({ messages: requests.slice(before).flatMap((b) => b.messages ?? []) })
  const deliveredRewritten = after.includes('HOOK改写')
  const originalGone = !after.includes('HOOK原文')
  const ackIdx = timeline.indexOf('ack')
  const firstUserStart = timeline.findIndex((x) => x.startsWith('user-start:') && x.includes('HOOK改写'))
  record('B3-input-hook-transform', '扩展 transform 后实际投递的是改写文本（宿主不能按原文认领）；ACK 与投递事件先后仅作观察事实',
    d === 'queued' && deliveredRewritten && originalGone,
    { disposition: d, deliveredRewritten, originalGone, ackBeforeDelivery: ackIdx >= 0 && firstUserStart >= 0 && ackIdx < firstUserStart })
  session.dispose()
}

// ---------------------------------------------------------------- B4 handled
{
  const session = await createSession({
    model: 'b4-main',
    inputHook: (event) => (
      String(event.text ?? '').includes('TAKE_OVER')
        ? { action: 'handled' }
        : { action: 'continue' }
    ),
  })
  responders.set('b4-main', () => ({ text: 'B4_DONE' }))
  const before = requests.length
  await withTimeout(session.prompt('B4 开局'), 10000, 'B4-warm')
  const d = await session.steer('TAKE_OVER 这条被扩展接管')
  await sleep(100)
  const noRequest = requests.length === before + 1 // 只有开局那一次
  record('B4-handled-disposition', '扩展接管输入时 steer 返回 handled：无投递、无新请求、不进 SDK 队列——宿主按待核对保留，不自动重发',
    d === 'handled' && noRequest && session.pendingMessageCount === 0,
    { disposition: d, requestsAfter: requests.length - before - 1, pending: session.pendingMessageCount })
  session.dispose()
}

// ---------------------------------------------------------------- B5 request.reason 观察
{
  const reasons = []
  const session = await createSession({
    model: 'b5-main',
    route: (request, ctx) => {
      reasons.push(request.reason)
      return { model: ctx.find('b5-main'), thinkingLevel: 'off' }
    },
    tools: [],
  })
  let n = 0
  responders.set('b5-main', () => (++n <= 1 ? { toolCall: undefined, text: 'B5_FIRST' } : { text: 'B5_DONE' }))
  const before = requests.length
  const run = session.prompt('B5 开局')
  await withTimeout(run, 10000, 'B5-first')
  const steerDisp = await session.steer('B5 并入这条')
  const second = session.prompt('B5 新回合')
  await withTimeout(second, 10000, 'B5-second')
  // 空闲滞留的并入随下一次 prompt 一并送达（同一请求携带两段文本），
  // 该请求 reason=user——与新回合不可区分（重置语义见 B6）。
  const secondBody = bodyText(requests.at(-1) ?? {})
  const absorbed = secondBody.includes('B5 并入这条') && secondBody.includes('B5 新回合')
  record('B5-idle-steer-absorbed', '空闲滞留的并入随下一次 prompt 一并送达（同一请求带两段文本），reason=user——与新回合请求不可区分',
    steerDisp === 'queued' && absorbed && reasons.length === 2 && reasons.every((r) => r === 'user'),
    { reasons, steerDisposition: steerDisp, absorbed })
  session.dispose()
}

// ---------------------------------------------------------------- B6 并入前后主备切换（按现行 pi-factory 口径路由）
// 两个确定性子场景：B6a 工具阻塞中并入（同 turn 消化，continuation）；
// B6b 回合间隙并入（SDK 为它开新 turn，reason=user）。
async function failoverScenario({ id, midRun, claim, expectReasons, expectModels }) {
  const reasons = []
  const routed = []
  const runtimeState = { slot: 'primary', fallbackUsed: false }
  let release
  const gate = new Promise((r) => { release = r })
  const session = await createSession({
    model: 'main-m6',
    models: ['main-m6', 'fb-m6'],
    settings: { retry: { enabled: true, maxRetries: 1, provider: { maxRetries: 0 } } },
    route: (request, ctx) => {
      reasons.push(request.reason)
      const state = request.reason === 'direct' ? runtimeState : request.state ?? runtimeState
      let next = state
      // 现行 pi-factory 口径：reason=user 且当前在备用 → 重置回主模型。
      if (request.reason === 'user' && state.slot === 'fallback') next = { slot: 'primary', fallbackUsed: false }
      if (request.reason === 'retry') next = { slot: 'fallback', fallbackUsed: true }
      runtimeState.slot = next.slot
      runtimeState.fallbackUsed = next.fallbackUsed
      const pick = next.slot === 'fallback' ? 'fb-m6' : 'main-m6'
      routed.push(pick)
      return { model: ctx.find(pick), thinkingLevel: 'off', state: request.reason === 'direct' ? undefined : next }
    },
    tools: [{
      name: 'slow', sequential: true,
      impl: () => (midRun ? new Promise((resolve) => { gate.then(() => resolve('slow-done')) }) : Promise.resolve('slow-done')),
    }],
  })
  let mainN = 0
  let fbN = 0
  responders.set('main-m6', () => (++mainN === 1 ? { status: 500 } : { text: 'MAIN_AFTER_STEER' }))
  responders.set('fb-m6', () => (++fbN === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: midRun ? 'FB_DONE' : 'FB_MID', ...(midRun ? {} : { delayMs: 400 }) }))
  const timeline = []
  trackDelivery(session, timeline)
  const before = requests.length
  const steerText = `${id} 并入六`
  const run = session.prompt(`${id} 开局`)
  // 开局：主模型 500 → retry 切备用 → 备用派 slow 工具。B6a 等到工具请求（第 2 个）
  // 后在工具阻塞中并入；B6b 工具立即完成，等到 continuation 请求（第 3 个）在途后
  // 并入——400ms 延迟窗口保证 steer 落在终笔在途期间。
  while (requests.length < before + (midRun ? 2 : 3)) await sleep(10)
  if (midRun) await sleep(80)
  const d = await session.steer(steerText)
  if (midRun) release()
  await withTimeout(run, 15000, `${id}-run`)
  const models = requests.slice(before).map((b) => b.model)
  const steerCarrier = requests.slice(before).find((b) => bodyText(b).includes(steerText))
  const settledOnce = timeline.filter((x) => x === 'settled').length === 1
  record(`${id}-failover-merge`, claim,
    d === 'queued' && settledOnce
      && JSON.stringify(reasons) === JSON.stringify(expectReasons)
      && JSON.stringify(models) === JSON.stringify(expectModels)
      && steerCarrier?.model === expectModels.at(-1),
    { disposition: d, reasons, routed, models, settledOnce })
  release()
  session.dispose()
}
// 实测（2026-10-15）：工具边界的并入让 SDK 开新 turn（reason=user）消化——
// 现行 pi-factory 口径随即重置回主模型。并入属于同一应用运行、不是新回合，
// 这就是 AC-32 要修的坑：宿主必须自己记应用回合，不能沿用 reason=user 判定。
await failoverScenario({
  id: 'B6a', midRun: true,
  claim: '工具边界的并入以 reason=user 新 turn 消化：现行口径把已切备用的运行拉回主模型——并入≠新回合，AC-32 修复依据',
  expectReasons: ['user', 'retry', 'user'],
  expectModels: ['main-m6', 'fb-m6', 'main-m6'],
})
// 实测（2026-10-15）：在途终笔窗口的并入先由 continuation 收当前消息，再开
// 新 turn（user）消化并入——同样被拉回主模型。两种时序下并入都不该重置备用。
await failoverScenario({
  id: 'B6b', midRun: false,
  claim: '在途终笔窗口的并入：continuation 收当前消息后 SDK 开新 turn（user）消化并入，同样被现行口径拉回主模型',
  expectReasons: ['user', 'retry', 'continuation', 'user'],
  expectModels: ['main-m6', 'fb-m6', 'fb-m6', 'main-m6'],
})

// ---------------------------------------------------------------- B7 目标收口滞留输入
{
  let release
  const gate = new Promise((r) => { release = r })
  const session = await createSession({
    model: 'b7-main',
    tools: [{
      name: 'slow', sequential: true,
      impl: (_params, signal) => new Promise((resolve) => {
        const done = () => resolve(signal?.aborted ? 'aborted' : 'slow-done')
        signal?.addEventListener('abort', done)
        gate.then(done)
      }),
    }],
  })
  let n = 0
  responders.set('b7-main', () => (++n === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'B7_DONE' }))
  const before = requests.length
  const run = session.prompt('B7 开局')
  await sleep(150) // 工具已开跑（阻塞中）
  const img = { type: 'image', data: PNG_1PX, mimeType: 'image/png' }
  const d = await session.steer('B7 滞留文本', [img])
  session.abort()
  await withTimeout(run, 10000, 'B7-abort')
  const pendingAfterAbort = session.pendingMessageCount
  // 危险面：不清队列直接开新回合 → 滞留输入随新 prompt 冒出。
  const stale = session.prompt('B7 新回合')
  await withTimeout(stale, 10000, 'B7-stale')
  const staleSurfaced = bodyText(requests.at(-1) ?? {}).includes('B7 滞留文本')
  const cleared = session.clearQueue()
  const pendingAfterClear = session.pendingMessageCount
  const next = session.prompt('B7 再来')
  await withTimeout(next, 10000, 'B7-next')
  const resurfaced = bodyText(requests.at(-1) ?? {}).includes('B7 滞留文本')
  record('B7-abort-stranded-input', 'abort 后滞留 steer 不在 pending 队列（clearQueue 无可清）、但已进入会话条目：随后续 prompt 出现在模型上下文——宿主要么接受入上下文标待核对，要么 dispose 重建实例丢弃',
    d === 'queued' && pendingAfterAbort === 0 && staleSurfaced && cleared.steering.length === 0 && cleared.followUp.length === 0 && resurfaced,
    { disposition: d, pendingAfterAbort, staleSurfaced, cleared, pendingAfterClear, resurfaced })
  release()
  session.dispose()
}

// ---------------------------------------------------------------- C1 在途请求 abort
{
  const session = await createSession({ model: 'c1-main', settings: { retry: { enabled: false } } })
  responders.set('c1-main', () => ({ text: 'C1_DONE', delayMs: 500 }))
  const timeline = []
  trackDelivery(session, timeline)
  const before = requests.length
  const run = session.prompt('C1 开局')
  while (requests.length === before) await sleep(10)
  session.abort()
  await withTimeout(run, 10000, 'C1-run')
  await sleep(300)
  record('C1-abort-inflight-request', '请求已发未回时 abort：settled 单次、无重试风暴、请求次数不增',
    timeline.filter((x) => x === 'settled').length === 1 && requests.length === before + 1,
    { settled: timeline.filter((x) => x === 'settled').length, requestsAfter: requests.length - before })
  session.dispose()
}

// ---------------------------------------------------------------- C2 慢工具 abort
{
  let release
  const gate = new Promise((r) => { release = r })
  const toolFacts = { aborted: false, finished: false }
  const session = await createSession({
    model: 'c2-main',
    tools: [{
      name: 'slow', sequential: true,
      impl: (_params, signal) => new Promise((resolve) => {
        signal?.addEventListener('abort', () => { toolFacts.aborted = true; resolve('aborted') })
        gate.then(() => { toolFacts.finished = true; resolve('slow-done') })
      }),
    }],
  })
  let n = 0
  responders.set('c2-main', () => (++n === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'C2_DONE' }))
  const timeline = []
  trackDelivery(session, timeline)
  const before = requests.length
  const run = session.prompt('C2 开局')
  while (requests.length === before) await sleep(10)
  await sleep(100) // 工具已在跑
  session.abort()
  await withTimeout(run, 10000, 'C2-run')
  record('C2-abort-slow-tool', '工具阻塞中 abort：abort signal 送达工具、settled 单次、不再发后续请求',
    toolFacts.aborted && timeline.filter((x) => x === 'settled').length === 1 && requests.length === before + 1,
    { toolFacts, settled: timeline.filter((x) => x === 'settled').length, requestsAfter: requests.length - before })
  release()
  session.dispose()
}

// ---------------------------------------------------------------- C3 abort 与迟到 steer 竞争
{
  const session = await createSession({
    model: 'c3-main',
    tools: [{
      name: 'slow', sequential: true,
      impl: (_params, signal) => new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve('aborted'))
      }),
    }],
  })
  let n = 0
  responders.set('c3-main', () => (++n === 1 ? { toolCall: { name: 'slow', args: {} } } : { text: 'C3_DONE' }))
  const timeline = []
  trackDelivery(session, timeline)
  const before = requests.length
  const run = session.prompt('C3 开局')
  while (requests.length === before) await sleep(10)
  await sleep(100)
  session.abort()
  const lateDisp = await session.steer('C3 迟到输入').catch((error) => `throw:${error?.message}`)
  await withTimeout(run, 10000, 'C3-run')
  await sleep(200)
  const leaked = requests.slice(before + 1).some((b) => bodyText(b).includes('C3 迟到输入'))
  record('C3-late-steer-vs-abort', '停止已发起后的迟到 steer 不复活运行：无新请求承载它；去向（队列滞留/拒绝）作为事实记录',
    !leaked && timeline.filter((x) => x === 'settled').length === 1,
    { lateDisposition: String(lateDisp), leaked, pendingAfter: session.pendingMessageCount })
  session.dispose()
}

// ---------------------------------------------------------------- C4 dispose 后迟到提交
{
  const session = await createSession({ model: 'c4-main' })
  responders.set('c4-main', () => ({ text: 'C4_DONE' }))
  await withTimeout(session.prompt('C4 开局'), 10000, 'C4-warm')
  const before = requests.length
  session.dispose()
  const steerResult = await session.steer('C4 迟到').then((v) => `resolved:${v}`).catch((error) => `throw:${error?.message}`)
  const promptResult = await session.prompt('C4 迟到回合').then(() => 'resolved').catch((error) => `throw:${error?.message}`)
  record('C4-late-input-after-dispose', 'dispose 后 steer/prompt 不抛错且仍会真实执行（实测发出请求）——宿主绝不能复用已 dispose 实例，必须 epoch 守卫',
    steerResult === 'resolved:queued' && promptResult === 'resolved' && requests.length === before + 1,
    { steerResult, promptResult, requestsAfter: requests.length - before })
}

// ---------------------------------------------------------------- 收口
const failed = findings.filter((f) => !f.ok)
console.log(`\n057 flow probe：${findings.length - failed.length}/${findings.length} 通过`)
if (failed.length) {
  console.log(failed.map((f) => `FAIL ${f.id}: ${JSON.stringify(f.detail)}`).join('\n'))
  process.exitCode = 1
}
server.closeAllConnections()
server.close()
for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true })
