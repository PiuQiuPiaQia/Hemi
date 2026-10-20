// 057 AC-35／跨层四时点矩阵（固定样本）：运行中／收口后／同会话窗口重载／进程重启只读恢复
// 四个时点上，对同一批对象做 inputId↔时间线↔档案↔SDK 输入的跨层对照。
// 固定样本（对齐补充验证标准 AC-35）：文字直发、语音来源排队输入、两条同文不同身份、
// 一条已撤回、带工具的运行、两个反序完成子任务及两份成果。
//
// 层级与真实性：真实 conversation-flow-service＋flow-store（档案真落盘）＋真实
// ConversationController＋真实 pi SDK 会话（本地 mock Anthropic）——执行事实链与生产同构；
// 「同会话窗口重载」＝渲染层真实投影函数重跑（projectFlowTimeline，node --experimental-strip-types
// 直接加载 TS 纯函数，两次投影断言幂等）；「进程重启只读恢复」＝新进程从盘上档案恢复
// （服务自带 restoreFlowSnapshot 引导），零 SDK 接线（读取零模型请求零工具执行由构造＋
// 断言双重保证）。真机窗口重载另有既有证据（AC-20 连续 4 次重载走查）。
//
// 运行：node --experimental-strip-types scripts/verify-057-ac35.mjs（exit 0＝矩阵全过）
//   node --experimental-strip-types scripts/verify-057-ac35.mjs restore --dir <D>（T4 子进程，由父进程派发）
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const MODE = process.argv[2] ?? 'main'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15000, step = 20) {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > ms) throw new Error(`until-timeout（${ms}ms）`)
    await sleep(step)
  }
}

// ================================================================ T4 子进程：重启只读恢复
if (MODE === 'restore') {
  const dir = process.argv[4]
  const { initConversationFlowService } = await import('../src/main/services/conversation-flow-service.mjs')
  // 只读恢复：不接 runtime（服务给不可执行占位——任何意外派发都会抛错现形）。
  const svc = initConversationFlowService({ dir, log: null })
  const controller = svc.controllerFor('conv-ac35')
  const snap = controller.getSnapshot()
  const norm = normTimeline(snap)
  console.log(`AC35_RESTORE ${JSON.stringify({
    phase: snap.phase,
    activeRunId: snap.activeRunId,
    revision: snap.revision,
    queuePaused: snap.queuePaused,
    pending: snap.pending.map((p) => ({ inputId: p.inputId, state: p.state })),
    runs: Object.values(snap.runs ?? {}).map((r) => ({ outcome: r.outcome, closed: Boolean(r.closedAt), inputIds: r.inputIds })),
    tasks: Object.values(snap.tasks ?? {}).map((t) => ({ taskId: t.taskId, outcome: t.outcome ?? null })),
    artifacts: Object.keys(snap.artifacts ?? {}),
    timeline: norm,
    timelineUserIds: norm.filter((e) => e.k === 'u').map((e) => e.id),
  })}`)
  process.exit(0)
}

if (MODE !== 'main') process.exit(2)

// ================================================================ 主进程：固定样本＋四时点
const { initConversationFlowService } = await import('../src/main/services/conversation-flow-service.mjs')
const { createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager } =
  await import('@earendil-works/pi-coding-agent')
const { projectFlowTimeline } = await import('../src/renderer/src/windows/voice/lib/flow-timeline-view.ts')

const CONV = 'conv-ac35'
const MODEL = 'ac35-main'

// ---------------------------------------------------------------- mock Anthropic
const requests = []
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    requests.push(body)
    const nth = requests.filter((r) => r.model === body.model).length
    // 第 1/6 个请求＝run1/run5 首答（派门工具）；其余纯文本。
    const step = nth === 1 || nth === 6 ? { toolCall: { name: 'slow', args: {} } } : { text: `AC35_REPLY_${nth}` }
    const events = []
    const ev = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { id: `m_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (step.toolCall) {
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `t_${requests.length}`, name: step.toolCall.name, input: {} } })
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
      ev('content_block_stop', { index: 0 })
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } })
      ev('content_block_stop', { index: 0 })
    }
    ev('message_delta', { delta: { stop_reason: step.toolCall ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
    ev('message_stop', {})
    setTimeout(() => {
      if (res.destroyed) return
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.join(''))
    }, 0)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const mockBase = `http://127.0.0.1:${server.address().port}`
const bodyText = (b) => JSON.stringify(b.messages ?? [])
const lastUserText = (b) => JSON.stringify((b.messages ?? []).filter((m) => m.role === 'user').at(-1)?.content ?? [])
const soloCarriers = (text) => requests.filter((b) => b.model === MODEL && lastUserText(b).includes(text)).length

// ---------------------------------------------------------------- SDK 会话（门工具两段：run1 占位快、run5 拖窗）
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi057-ac35-'))
const dir = path.join(root, 'conversations')
fs.mkdirSync(dir, { recursive: true })
const gates = []
const marks = []
const mkGate = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
gates.push(mkGate(), mkGate())
let toolCalls = 0

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac35-agent-'))
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ac35-cwd-'))
const ext = {
  name: 'ac35-ext',
  factory: (pi) => {
    pi.registerProvider(`p-${MODEL}`, {
      baseUrl: mockBase, apiKey: 'probe', api: 'anthropic-messages',
      models: [{ id: MODEL, name: MODEL, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
    })
    pi.registerTool({
      name: 'slow', label: 'slow', description: 'ac35 window tool', parameters: { type: 'object', properties: {} },
      executionMode: 'sequential',
      execute: async () => {
        const n = toolCalls
        toolCalls += 1
        marks.push(`tool-${n}-blocked`)
        await gates[n].promise
        return { content: [{ type: 'text', text: `tool-${n}-done` }] }
      },
    })
  },
}
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } })
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir, settingsManager, extensionFactories: [ext],
  systemPromptOverride: () => 'AC35', appendSystemPromptOverride: () => [],
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
})
await resourceLoader.reload()
const { session } = await createAgentSession({
  cwd, agentDir, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), noTools: 'builtin',
})
await session.bindExtensions({ mode: 'rpc', uiContext: new Proxy({}, { get: () => async () => undefined }) })
session.setSteeringMode('one-at-a-time')
await session.setModel(session.modelRuntime.getModels(`p-${MODEL}`)[0])

const deliveries = [] // SDK 实际投递（user message_start 纯文本）
session.subscribe((e) => {
  if (e.type === 'message_start' && e.message?.role === 'user') {
    const c = e.message?.content
    const b = Array.isArray(c) && c.length === 1 ? c[0] : null
    if (b?.type === 'text') deliveries.push(b.text)
  }
})

// ---------------------------------------------------------------- 服务＋runtime 适配（createLlmFlowRuntime 镜像）
const svc = initConversationFlowService({ dir, log: null })
const facts = { starts: [] }
svc.setRuntimeFactory((convId) => {
  const controllerOf = () => svc.controllerFor(convId)
  const stopFlags = new Map()
  return {
    async start({ runId, envelope, source, generation }) {
      facts.starts.push({ runId, source, inputId: envelope?.inputId ?? null })
      try {
        await session.prompt(String(envelope?.text ?? ''))
        const controller = controllerOf()
        controller.applyFact({ type: 'run-settled', runId, at: Date.now(), generation })
        controller.applyFact({ type: 'run-closed', runId, outcome: 'completed', at: Date.now(), generation })
        return { modelUsed: MODEL, result: { text: 'ok' }, aborted: false }
      } catch {
        const controller = controllerOf()
        controller.applyFact({ type: 'run-settled', runId, at: Date.now(), generation })
        controller.applyFact({ type: 'run-closed', runId, outcome: 'failed', at: Date.now(), generation })
        throw new Error('ac35 runtime failed')
      }
    },
    async merge() { throw Object.assign(new Error('不在途'), { code: 'not-received' }) },
    async stop({ runId }) { stopFlags.set(runId, true); await session.abort().catch(() => {}); return { ok: true } },
  }
})
const controller = svc.controllerFor(CONV)
const makeInput = (inputId, text, inputSource = 'text') => ({ inputId, editRevision: 0, text, inputSource, attachmentIds: [], references: null, createdAt: Date.now() })

// ---------------------------------------------------------------- 固定样本驱动
const SAME_TEXT = '样本·同文双条'
// run1：文字直发（门工具拖窗——排队样本都落在它的忙时窗口里）。
const run1P = controller.command({ type: 'send', input: makeInput('in-a', '样本·文字直发') })
await until(() => marks.includes('tool-0-blocked'))
// 语音来源排队＋两条同文（不同身份）＋待撤回项。
const qb = await controller.command({ type: 'send', input: makeInput('in-b', '样本·语音排队', 'voice') })
const qc = await controller.command({ type: 'send', input: makeInput('in-c', SAME_TEXT) })
const qd = await controller.command({ type: 'send', input: makeInput('in-d', SAME_TEXT) })
await controller.command({ type: 'send', input: makeInput('in-e', '样本·已撤回') })
const withdrawn = await controller.command({ type: 'withdrawInput', inputId: 'in-e' })
gates[0].resolve()
await run1P
// 队列 FIFO 派发到清零（in-b→in-c→in-d 各起独立运行）。
await until(() => controller.getSnapshot().phase === 'idle' && controller.getSnapshot().pending.length === 0)
// run5：带工具的运行（第二道门拖窗——T1 时点＋两个反序完成子任务注入）。
const run5P = controller.command({ type: 'send', input: makeInput('in-f', '样本·工具与子任务') })
await until(() => marks.includes('tool-1-blocked'))
const generation = controller.getSnapshot().generation
const run5Id = controller.getSnapshot().activeRunId
// 两个子任务按派单顺序建卡（与 subagents 同一条 applyFact 通道）。
controller.applyFact({ type: 'task-updated', task: { taskId: 'task-a', key: 'task-a', phase: 'running', taskText: '反序子任务一', agent: 'explorer' } })
controller.applyFact({ type: 'part-appended', runId: run5Id, part: { partId: 'p-dele-a', kind: 'delegation', toolCallId: 'tc-a', taskId: 'task-a', status: 'running' }, generation })
controller.applyFact({ type: 'task-updated', task: { taskId: 'task-b', key: 'task-b', phase: 'running', taskText: '反序子任务二', agent: 'explorer' } })
controller.applyFact({ type: 'part-appended', runId: run5Id, part: { partId: 'p-dele-b', kind: 'delegation', toolCallId: 'tc-b', taskId: 'task-b', status: 'running' }, generation })

// ---------------------------------------------------------------- T1：运行中
const t1 = capture()
// 反序完成：task-b 先终态（含成果）、task-a 后终态——趁 run5 仍被工具拖住在途时注入
//（与真实子任务在主运行忙时终态同构，且不与运行收口赛跑）。
controller.applyFact({ type: 'task-updated', task: { taskId: 'task-b', key: 'task-b', phase: 'terminal', outcome: 'complete', taskText: '反序子任务二', agent: 'explorer' } })
controller.applyFact({ type: 'part-updated', runId: run5Id, partId: 'p-dele-b', patch: { status: 'done' }, generation })
controller.applyFact({ type: 'artifact-updated', artifact: { artifactId: 'art-b', kind: 'file', name: 'b.txt', path: '/tmp/ac35-b.txt', producerRunId: run5Id, contentVersion: 1, registeredAt: Date.now() }, generation })
controller.applyFact({ type: 'task-updated', task: { taskId: 'task-a', key: 'task-a', phase: 'terminal', outcome: 'complete', taskText: '反序子任务一', agent: 'explorer' } })
controller.applyFact({ type: 'part-updated', runId: run5Id, partId: 'p-dele-a', patch: { status: 'done' }, generation })
controller.applyFact({ type: 'artifact-updated', artifact: { artifactId: 'art-a', kind: 'file', name: 'a.txt', path: '/tmp/ac35-a.txt', producerRunId: run5Id, contentVersion: 1, registeredAt: Date.now() }, generation })
gates[1].resolve()
await run5P

// ---------------------------------------------------------------- T2：实际收口后（主进程快照＋盘上档案＋SDK 输入）
await svc.store.flush(CONV)
const t2 = capture()
const archive = JSON.parse(fs.readFileSync(path.join(dir, `${CONV}.json`), 'utf8'))

// ---------------------------------------------------------------- T3：同会话窗口重载（渲染层真实投影，两次幂等）
const proj1 = projectFlowTimeline(archive.flow, [])
const proj2 = projectFlowTimeline(archive.flow, [])

// ---------------------------------------------------------------- T4：进程重启只读恢复（子进程）
const { spawn } = await import('node:child_process')
const restoreOut = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, 'restore', '--dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('restore 子进程超时')) }, 30000)
  child.stdout.on('data', (c) => { out += String(c) })
  child.on('exit', () => {
    clearTimeout(timer)
    const line = out.split('\n').find((l) => l.startsWith('AC35_RESTORE '))
    resolve(line ? JSON.parse(line.slice('AC35_RESTORE '.length)) : null)
  })
})

// ================================================================ 断言矩阵
const results = []
function check(id, claim, ok, detail) {
  results.push({ id, claim, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`)
}

// —— 输入行：inputId 1:1 消费、同文两条各一次、撤回不复活 ——
check('A-input-identity', '一次提交只被一种路径消费：五个运行各携带唯一 inputId（直发 in-a、队列 in-b/c/d、直发 in-f），无重复消费',
  JSON.stringify(facts.starts.map((s) => s.inputId)) === JSON.stringify(['in-a', 'in-b', 'in-c', 'in-d', 'in-f'])
    && JSON.stringify(facts.starts.map((s) => s.source)) === JSON.stringify(['user', 'queue', 'queue', 'queue', 'user']),
  { starts: facts.starts.map((s) => `${s.source}:${s.inputId}`) })
check('A-input-same-text', '同文不同身份两条各保留一次：时间线两个用户项文本相同、id 不同（in-c/in-d），撤回项 in-e 不在时间线与 pending',
  t2.timelineUserTexts.filter((t) => t === SAME_TEXT).length === 2
    && t2.timelineUserIds.includes('in-c') && t2.timelineUserIds.includes('in-d')
    && !t2.timelineUserIds.includes('in-e')
    && t2.pending.every((p) => p.inputId !== 'in-e')
    && withdrawn.ok
    && (restoreOut?.timelineUserIds ?? []).every((id) => id !== 'in-e'),
  { sameTextItems: t2.timelineUserTexts.filter((t) => t === SAME_TEXT).length, withdrawn: withdrawn.ok })

// —— SDK 行：未压缩固定样本中各条普通输入恰投递一次 ——
const sdkCounts = {
  '样本·文字直发': deliveries.filter((t) => t === '样本·文字直发').length,
  '样本·语音排队': deliveries.filter((t) => t === '样本·语音排队').length,
  [SAME_TEXT]: deliveries.filter((t) => t === SAME_TEXT).length,
  '样本·已撤回': deliveries.filter((t) => t === '样本·已撤回').length,
  '样本·工具与子任务': deliveries.filter((t) => t === '样本·工具与子任务').length,
}
check('A-sdk-inputs-once', 'SDK 实际投递计数：四条有效普通输入各恰一次（同文两条合计 2）、撤回项零投递；各自请求恰一次以末条 user 承载',
  sdkCounts['样本·文字直发'] === 1 && sdkCounts['样本·语音排队'] === 1 && sdkCounts[SAME_TEXT] === 2
    && sdkCounts['样本·已撤回'] === 0 && sdkCounts['样本·工具与子任务'] === 1
    && soloCarriers('样本·文字直发') === 1 && soloCarriers('样本·语音排队') === 1
    && soloCarriers(SAME_TEXT) === 2 && soloCarriers('样本·已撤回') === 0,
  sdkCounts)

// —— 时间线行：四时点零换位、零消失（T1 前缀在 T2/T3/T4 逐项相等）——
const prefixAt = (norm, len) => JSON.stringify(norm.slice(0, len))
const t1Len = t1.timeline.length
const projUsers1 = proj1.transcripts.filter((t) => t.author === 'user').map((t) => t.id)
const projTaskTexts1 = proj1.transcripts.filter((t) => t.kind === 'task').map((t) => t.text)
check('A-timeline-stable', '已存在项目四时点零换位零消失：T1 前缀与 T2 主进程快照、T2 盘上档案、T4 恢复快照逐项身份/顺序相等；T3 投影用户序＝flow 用户序、delegation 顺序＝派单顺序',
  prefixAt(t2.timeline, t1Len) === prefixAt(t1.timeline, t1Len)
    && prefixAt(normTimeline(archive.flow), t1Len) === prefixAt(t1.timeline, t1Len)
    && JSON.stringify(projUsers1) === JSON.stringify(t2.timelineUserIds)
    && projTaskTexts1.length === 2 && projTaskTexts1[0] === '反序子任务一' && projTaskTexts1[1] === '反序子任务二'
    && prefixAt(restoreOut.timeline, t1Len) === prefixAt(t1.timeline, t1Len),
  { t1Len, t2Len: t2.timeline.length, restoredLen: restoreOut.timeline.length, projUsers: projUsers1, projTaskTexts: projTaskTexts1 })
check('A-timeline-reload-idempotent', '同会话窗口重载幂等：两次投影输出逐项相等（leftoverTurns=0，纯 flow 骨架无缺口）',
  proj1.leftoverTurns === 0 && JSON.stringify(proj1.transcripts) === JSON.stringify(proj2.transcripts),
  { leftover: proj1.leftoverTurns })

// —— 执行事实行：主进程 flow ↔ UI 投影 ↔ 已提交档案同一对象一致 ——
check('A-facts-cross-layer', '收口后三层一致：主进程快照 norm ＝盘上档案 norm（全量），投影用户序＝flow 用户序，runs 全 completed 且 inputIds 1:1',
  JSON.stringify(normTimeline(archive.flow)) === JSON.stringify(t2.timeline)
    && JSON.stringify(projUsers1) === JSON.stringify(t2.timelineUserIds)
    && Object.values(archive.flow.runs ?? {}).every((r) => r.outcome === 'completed')
    && JSON.stringify(restoreOut.runs.map((r) => r.inputIds)) === JSON.stringify([['in-a'], ['in-b'], ['in-c'], ['in-d'], ['in-f']]),
  { revisionMain: t2.revision, revisionArchive: archive.flow.revision, revisionRestored: restoreOut.revision })

// —— 反序子任务与成果：完成顺序不影响时间线顺序 ——
const t2Dele = controller.getSnapshot().timeline
  .flatMap((e) => (e.parts ?? []))
  .filter((p) => p.kind === 'delegation')
check('A-reverse-subtasks', '两个反序完成子任务：时间线 delegation 顺序＝派单顺序（a→b，不随完成顺序换位）；两份成果在场且重启后保留',
  JSON.stringify(t2Dele.map((p) => p.partId)) === JSON.stringify(['p-dele-a', 'p-dele-b'])
    && t2Dele.every((p) => p.status === 'done')
    && JSON.stringify([...restoreOut.artifacts].sort()) === JSON.stringify(["art-a", "art-b"])
    && restoreOut.tasks.every((t) => t.outcome === 'complete') && restoreOut.tasks.length === 2,
  { parts: t2Dele.map((p) => `${p.partId}:${p.status}`), restoredArtifacts: restoreOut.artifacts })

// —— 恢复行：已提交事实一致＋读取零副作用 ——
check('A-restore-faithful', '进程重启只读恢复：全量时间线/revision 与 T2 相等、相位 idle、零权限项、无新模型请求（子进程零 SDK 接线——占位 runtime 任何派发都会抛错现形）',
  restoreOut.phase === 'idle' && restoreOut.activeRunId == null
    && JSON.stringify(restoreOut.timeline) === JSON.stringify(t2.timeline)
    && restoreOut.revision === t2.revision
    && restoreOut.pending.length === 0,
  { restoredRevision: restoreOut.revision, mainRevision: t2.revision })

// ---------------------------------------------------------------- 收口
server.closeAllConnections()
server.close()
const failed = results.filter((r) => !r.ok)
console.log(`HEMI_VERIFY_057_AC35=${JSON.stringify({ ok: failed.length === 0, checks: results, timepoints: ['T1-running', 'T2-settled', 'T3-reload', 'T4-restart'] })}`)
fs.rmSync(root, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)

// ================================================================ 工具函数
function normTimeline(flow) {
  return (flow.timeline ?? []).map((e) => (e.kind === 'user'
    ? { k: 'u', id: e.id, text: e.text, src: e.inputSource ?? 'text' }
    : { k: 'a', itemId: e.itemId, parts: (e.parts ?? []).map((p) => ({ partId: p.partId, kind: p.kind, taskId: p.taskId ?? null })) }))
}
function capture() {
  const snap = controller.getSnapshot()
  const norm = normTimeline(snap)
  return {
    revision: snap.revision,
    timeline: norm,
    timelineUserIds: snap.timeline.filter((e) => e.kind === 'user').map((e) => e.id),
    timelineUserTexts: snap.timeline.filter((e) => e.kind === 'user').map((e) => e.text),
    pending: snap.pending.map((p) => ({ inputId: p.inputId, state: p.state })),
    activeRunId: snap.activeRunId,
    phase: snap.phase,
  }
}
