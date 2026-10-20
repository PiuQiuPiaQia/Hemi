// 历史专项：060 已按用户裁决移除队列并入，本脚本不再作为现行门禁。
console.error('060 已移除队列并入；此历史专项探针已退役，请使用 verify-060-queue.mjs journey。');
process.exit(2);
// 057 AC-38／TC-057-019：六个保存/执行故障切点注入（F1~F6），临时档案＋隔离子进程，
// 不触碰用户真实 userData。三种角色：
//   node scripts/verify-057-ac38.mjs                  父进程编排：本地 mock Anthropic 服务
//                                                     ＋进程内 F1/F5/F6＋子进程强退 F2/F3/F4
//   node scripts/verify-057-ac38.mjs child F2|F3|F4    驱动到切点后挂起（stdout 打 AC38_READY）
//   node scripts/verify-057-ac38.mjs recover F2|F3|F4  新进程恢复观察（stdout 打 AC38_RECOVER）
// 子进程用真实 conversation-flow-service＋flow-store（磁盘真实同步写入）＋真实 pi SDK
// 会话（mock provider 指向父进程服务）；恢复走服务自带 restoreFlowSnapshot 引导。
// 切点对齐补充验证标准 AC-38：
//   F1 受理保存前失败（注入 fsOps 写失败）   F2 受理已保存、SDK 调用前 SIGKILL
//   F3 SDK 已接收（steer 入队）、ACK 未落定 SIGKILL
//   F4 工具已执行（副作用落盘）、结果保存前 SIGKILL
//   F5 标题/flow/agentSession 竞争保存（真 flow-store 新鲜读合并＋写失败保留待重试；
//      交错点＝写链之间——生产同步临界段内不可交错，注入异步 IO 只在读前挂起）
//   F6 迁移备份/原子替换中途状态（同步临界段两 kill 态＝状态模拟）＋坏档/高版本保护
// 汇总打 HEMI_VERIFY_057_AC38 JSON；exit 0＝六切点全过。
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const MODE = process.argv[2] ?? 'parent'
const VARIANT = process.argv[3] ?? null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, step = 20) {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > ms) return null
    await sleep(step)
  }
}

// ================================================================ 子进程阶段（child/recover）
if (MODE === 'child' || MODE === 'recover') {
  const dir = process.env.HEMI_AC38_DIR
  const base = process.env.HEMI_AC38_BASE
  const variant = process.env.HEMI_AC38_VARIANT ?? VARIANT
  if (!dir || !base || !variant) { console.error('child/recover 需要 HEMI_AC38_DIR/BASE/VARIANT'); process.exit(2) }

  const { initConversationFlowService } = await import('../src/main/services/conversation-flow-service.mjs')
  const { createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager } =
    await import('@earendil-works/pi-coding-agent')

  const MODELS = { F2: 'ac38-f2', F3: 'ac38-f3', F4: 'ac38-f4' }
  const model = MODELS[variant]
  const sideEffectPath = path.join(dir, `side-effect-${variant}.log`)

  async function createSdkSession() {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `ac38-${variant.toLowerCase()}-agent-`))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `ac38-${variant.toLowerCase()}-cwd-`))
    const ext = {
      name: `ac38-${variant}`,
      factory: (pi) => {
        pi.registerProvider(`p-${model}`, {
          baseUrl: base, apiKey: 'probe', api: 'anthropic-messages',
          models: [{ id: model, name: model, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
        })
        if (variant === 'F4') {
          pi.registerTool({
            name: 'sideffect', label: 'sideffect', description: 'ac38 side effect tool',
            parameters: { type: 'object', properties: {} }, executionMode: 'sequential',
            // F4 切点：副作用已落盘（计数＋1）、结果保存前永久阻塞。
            execute: async () => {
              fs.appendFileSync(sideEffectPath, `exec ${Date.now()}\n`)
              await new Promise(() => {})
              return { content: [{ type: 'text', text: 'never' }] }
            },
          })
        }
      },
    }
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } })
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, extensionFactories: [ext],
      systemPromptOverride: () => 'AC38', appendSystemPromptOverride: () => [],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd, agentDir, resourceLoader, settingsManager,
      sessionManager: SessionManager.inMemory(cwd), noTools: 'builtin',
    })
    await session.bindExtensions({ mode: 'rpc', uiContext: new Proxy({}, { get: () => async () => undefined }) })
    session.setSteeringMode('one-at-a-time')
    await session.setModel(session.modelRuntime.getModels(`p-${model}`)[0])
    return session
  }

  const sdkUserTexts = []
  const starts = { count: 0 }
  const neverGate = new Promise(() => {})
  const session = await createSdkSession()
  session.subscribe((e) => {
    if (e.type === 'message_start' && e.message?.role === 'user') {
      const c = e.message?.content
      const b = Array.isArray(c) && c.length === 1 ? c[0] : null
      if (b?.type === 'text') sdkUserTexts.push(b.text)
    }
  })

  const svc = initConversationFlowService({ dir, log: null })
  const conversationId = `conv-ac38-${variant.toLowerCase()}`
  svc.setRuntimeFactory((convId) => {
    const controllerOf = () => svc.controllerFor(convId)
    return {
      // start 镜像 createLlmFlowRuntime：prompt 自闭合；F2 切点＝prompt 前挂起。
      async start({ runId, envelope, generation }) {
        if (MODE === 'child' && variant === 'F2') await neverGate
        starts.count += 1
        try {
          await session.prompt(String(envelope?.text ?? ''))
          const controller = controllerOf()
          controller.applyFact({ type: 'run-settled', runId, at: Date.now(), generation })
          controller.applyFact({ type: 'run-closed', runId, outcome: 'completed', at: Date.now(), generation })
          return { modelUsed: model, result: { text: 'ok' }, aborted: false }
        } catch {
          const controller = controllerOf()
          controller.applyFact({ type: 'run-settled', runId, at: Date.now(), generation })
          controller.applyFact({ type: 'run-closed', runId, outcome: 'failed', at: Date.now(), generation })
          throw new Error('AC38 runtime failed')
        }
      },
      async merge({ envelope }) {
        const result = await session.steer(String(envelope.text ?? ''))
        if (MODE === 'child' && variant === 'F3') await neverGate // SDK 已接收、ACK 未落定
        return result?.disposition === 'handled' ? 'handled' : 'queued'
      },
      async stop() { await session.abort().catch(() => {}); return { ok: true } },
    }
  })

  const controller = svc.controllerFor(conversationId)
  const makeInput = (inputId, text) => ({ inputId, editRevision: 0, text, inputSource: 'text', attachmentIds: [], references: null, createdAt: Date.now() })
  const readFlow = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, `${conversationId}.json`), 'utf8')).flow ?? null
    } catch { return null }
  }

  if (MODE === 'child') {
    if (variant === 'F2') {
      // 受理已保存（flow-store 同步落盘 preparing＋inputIds）、SDK 调用前挂起。
      void controller.command({ type: 'send', input: makeInput('in-f2', 'F2 受理后强退') })
      const flow = await until(() => {
        const f = readFlow()
        return f?.activeRunId && f.runs?.[f.activeRunId]?.inputIds?.includes('in-f2') ? f : null
      }, 10000)
      console.log(`AC38_READY ${JSON.stringify({ variant, diskPrepared: Boolean(flow), activeRunId: flow?.activeRunId ?? null, starts: starts.count })}`)
    }
    if (variant === 'F3') {
      // R1 在途（父进程 responder 长延迟拖住请求）；Q1 并入：steer 已入队、ACK 挂起。
      const sendP = controller.command({ type: 'send', input: makeInput('in-f3-r1', 'F3 主运行') })
      await until(() => controller.getSnapshot().activeRunId != null, 10000)
      await controller.command({ type: 'send', input: makeInput('in-f3-q1', 'F3 并入未落定') })
      void controller.command({ type: 'mergeInput', inputId: 'in-f3-q1', expectedEditRevision: 0 })
      const flow = await until(() => {
        const f = readFlow()
        return f?.pending?.some((p) => p.inputId === 'in-f3-q1' && p.state === 'submitting') ? f : null
      }, 10000)
      console.log(`AC38_READY ${JSON.stringify({ variant, diskSubmitting: Boolean(flow), activeRunId: controller.getSnapshot().activeRunId })}`)
      void sendP
    }
    if (variant === 'F4') {
      // 工具副作用已落盘、结果保存前阻塞（父进程 responder 首答派工具）。
      void controller.command({ type: 'send', input: makeInput('in-f4', 'F4 工具副作用') })
      const landed = await until(() => fs.existsSync(sideEffectPath) && fs.readFileSync(sideEffectPath, 'utf8').trim().length > 0, 15000)
      const count = landed ? fs.readFileSync(sideEffectPath, 'utf8').trim().split('\n').length : 0
      console.log(`AC38_READY ${JSON.stringify({ variant, sideEffects: count })}`)
    }
    // 切点就位：定时器句柄保活（顶层挂起 await 不保事件循环），await 挡住底部干净退出。
    setInterval(() => {}, 1 << 30)
    await new Promise(() => {})
  }

  if (MODE === 'recover') {
    await sleep(3000) // 恢复观察窗：任何自动 prompt/派发/工具重放都会在窗内现形
    const snap = controller.getSnapshot()
    const result = {
      variant,
      starts: starts.count,
      snapshot: {
        phase: snap.phase,
        activeRunId: snap.activeRunId,
        queuePaused: snap.queuePaused,
        runs: Object.values(snap.runs ?? {}).map((r) => ({ outcome: r.outcome, closedAt: r.closedAt ?? null, inputIds: r.inputIds ?? [] })),
        pending: snap.pending.map((p) => ({ inputId: p.inputId, state: p.state })),
      },
      ...(variant === 'F4' ? { sideEffects: fs.existsSync(sideEffectPath) ? fs.readFileSync(sideEffectPath, 'utf8').trim().split('\n').length : 0 } : {}),
      ...(variant === 'F3' ? { sdkUserTexts } : {}),
    }
    console.log(`AC38_RECOVER ${JSON.stringify(result)}`)
    process.exit(0)
  }
}

// ================================================================ 父进程
if (MODE !== 'parent') process.exit(0)
const { createFlowStore } = await import('../src/main/services/flow-store.mjs')
const { migrateConversationDirToV2 } = await import('../src/main/services/conversation-migration.mjs')
const { createConversationController } = await import('../src/main/services/conversation-controller.mjs')

// mock Anthropic Messages：F2/F3/F4 子进程的模型请求都打到这里（服务端计数＝请求证据；
// F4 首答派工具、F3 首答长延迟拖住在途）。
const parentRequests = []
const parentResponders = new Map()
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    parentRequests.push(body)
    const nth = parentRequests.filter((r) => r.model === body.model).length
    const step = (parentResponders.get(body.model) ?? (() => ({ text: 'PARENT_DONE' })))(body, nth)
    const events = []
    const ev = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { id: `m_${parentRequests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    const calls = step.toolCalls ?? (step.toolCall ? [step.toolCall] : [])
    let index = 0
    if (calls.length) {
      for (const call of calls) {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: `t_${parentRequests.length}_${index}`, name: call.name, input: {} } })
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '{}' } })
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
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const mockBase = `http://127.0.0.1:${server.address().port}`
const modelCount = (model) => parentRequests.filter((b) => b.model === model).length
const modelTextCarriers = (model, text) => parentRequests.filter((b) => b.model === model && JSON.stringify(b.messages ?? []).includes(text)).length

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi057-ac38-'))
const results = {}
function note(variant, ok, extra = {}) {
  results[variant] = { ok, ...extra }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${variant}  ${JSON.stringify(extra)}`)
}

/** 子进程阶段驱动：child＝等到 READY 行后 SIGKILL；recover＝等 RECOVER 行拿结果。 */
async function runChildPhase(phase, variant, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, phase, variant], {
      env: { ...process.env, HEMI_AC38_DIR: dir, HEMI_AC38_BASE: mockBase, HEMI_AC38_VARIANT: variant },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let payload = null
    let killed = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${phase}-${variant} 超时`)) }, 60000)
    child.stdout.on('data', (c) => {
      out += String(c)
      for (const line of out.split('\n')) {
        const prefix = phase === 'child' ? 'AC38_READY ' : 'AC38_RECOVER '
        if (line.startsWith(prefix)) payload = JSON.parse(line.slice(prefix.length))
      }
      if (payload && phase === 'child' && !killed) {
        killed = true
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退 */ } }, 200) // 切点就位后真实强退
      }
    })
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ payload, signal, code, stderr: err.slice(-2000) })
    })
  })
}

// ---------------------------------------------------------------- F2 受理已保存、SDK 调用前终止
{
  const dir = path.join(root, 'f2')
  fs.mkdirSync(dir, { recursive: true })
  parentResponders.set('ac38-f2', () => ({ text: 'F2_DONE' }))
  const childOut = await runChildPhase('child', 'F2', dir)
  const afterChild = modelCount('ac38-f2')
  const killedBySignal = childOut.signal === 'SIGKILL'
  const archive = JSON.parse(fs.readFileSync(path.join(dir, 'conv-ac38-f2.json'), 'utf8'))
  const flow = archive.flow ?? {}
  const childPrepared = flow.activeRunId != null && flow.runs?.[flow.activeRunId]?.inputIds?.includes('in-f2')
  const recoverOut = await runChildPhase('recover', 'F2', dir)
  const requestsDuringRecover = modelCount('ac38-f2') - afterChild
  const r = recoverOut.payload
  note('F2', killedBySignal && childPrepared && r?.starts === 0 && requestsDuringRecover === 0
    && r?.snapshot.phase === 'idle' && r?.snapshot.activeRunId == null
    && r?.snapshot.runs.some((x) => x.outcome === 'interrupted' && x.inputIds.includes('in-f2')), {
    killedBySignal, childPrepared, runOutcomes: r?.snapshot.runs.map((x) => x.outcome),
    inputIdsKept: r?.snapshot.runs.flatMap((x) => x.inputIds),
    autoStarts: r?.starts, requestsDuringRecover, stderr: recoverOut.stderr ? recoverOut.stderr.slice(0, 200) : undefined,
  })
}

// ---------------------------------------------------------------- F3 SDK 已接收、ACK 未落定终止
{
  const dir = path.join(root, 'f3')
  fs.mkdirSync(dir, { recursive: true })
  parentResponders.set('ac38-f3', () => ({ text: 'F3_DONE', delayMs: 60000 })) // 主运行请求拖住在途
  const childOut = await runChildPhase('child', 'F3', dir)
  const afterChild = modelCount('ac38-f3')
  const carriersAfterChild = modelTextCarriers('ac38-f3', 'F3 并入未落定')
  const killedBySignal = childOut.signal === 'SIGKILL'
  const recoverOut = await runChildPhase('recover', 'F3', dir)
  const requestsDuringRecover = modelCount('ac38-f3') - afterChild
  const r = recoverOut.payload
  const q1 = r?.snapshot.pending.find((p) => p.inputId === 'in-f3-q1')
  // 恢复窗口判定（按窗计量——child 阶段已有的承载不算）：不自动重新投递/重新并入。
  const noAutoRedeliver = !(r?.sdkUserTexts ?? []).includes('F3 并入未落定')
    && modelTextCarriers('ac38-f3', 'F3 并入未落定') - carriersAfterChild === 0
  note('F3', killedBySignal && Boolean(childOut.payload?.diskSubmitting) && q1?.state === 'needs-review'
    && r?.starts === 0 && requestsDuringRecover === 0 && noAutoRedeliver
    && r?.snapshot.runs.some((x) => x.outcome === 'interrupted'), {
    killedBySignal, diskSubmitting: childOut.payload?.diskSubmitting, q1State: q1?.state,
    runOutcomes: r?.snapshot.runs.map((x) => x.outcome),
    autoStarts: r?.starts, requestsDuringRecover, noAutoRedeliver, carriersAfterChild, recoverSawQ1Delivery: (r?.sdkUserTexts ?? []).includes('F3 并入未落定'), stderr: recoverOut.stderr ? recoverOut.stderr.slice(0, 200) : undefined,
  })
}

// ---------------------------------------------------------------- F4 工具已执行、结果保存前终止
{
  const dir = path.join(root, 'f4')
  fs.mkdirSync(dir, { recursive: true })
  parentResponders.set('ac38-f4', (_b, nth) => (nth === 1 ? { toolCall: { name: 'sideffect', args: {} } } : { text: 'F4_DONE' }))
  const childOut = await runChildPhase('child', 'F4', dir)
  const afterChild = modelCount('ac38-f4')
  const killedBySignal = childOut.signal === 'SIGKILL'
  const sideEffectsAtKill = childOut.payload?.sideEffects
    ?? (fs.existsSync(path.join(dir, 'side-effect-F4.log')) ? fs.readFileSync(path.join(dir, 'side-effect-F4.log'), 'utf8').trim().split('\n').length : 0)
  const recoverOut = await runChildPhase('recover', 'F4', dir)
  const requestsDuringRecover = modelCount('ac38-f4') - afterChild
  const r = recoverOut.payload
  note('F4', killedBySignal && sideEffectsAtKill === 1
    && r?.sideEffects === 1 && r?.starts === 0 && requestsDuringRecover === 0
    && r?.snapshot.runs.some((x) => x.outcome === 'interrupted')
    && (r?.snapshot.runs ?? []).every((x) => x.outcome !== 'completed'), {
    killedBySignal, sideEffectsAtKill, sideEffectsAfterRecover: r?.sideEffects,
    runOutcomes: r?.snapshot.runs.map((x) => x.outcome),
    autoStarts: r?.starts, requestsDuringRecover, stderr: recoverOut.stderr ? recoverOut.stderr.slice(0, 200) : undefined,
  })
}

// ---------------------------------------------------------------- F1 受理保存前失败（进程内：真实 flow-store＋注入写失败）
{
  const dir = path.join(root, 'f1')
  fs.mkdirSync(dir, { recursive: true })
  let failOnce = true
  const io = {
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: async (p, data) => {
      if (failOnce) { failOnce = false; throw new Error('probe-injected-eacces') }
      fs.writeFileSync(p, data, 'utf8')
    },
    rename: (a, b) => fs.renameSync(a, b),
    unlink: (p) => { try { fs.unlinkSync(p) } catch { /* 不在 */ } },
  }
  const store = createFlowStore({ dir, fsOps: io })
  let controller
  const storeEffect = {
    update: (id) => store.update(id, (record) => ({ ...record, flow: controller.getSnapshot() })),
    flush: (id) => store.flush(id),
  }
  // F1 断言的是「保存失败则 SDK 根本不执行」：runtime.start 计数即门证据；真实 SDK
  // 请求侧由 F2/F3/F4 的同门覆盖（runtime.start 未被调用则 prompt 不存在）。
  const starts = { count: 0 }
  const runtime = {
    async start() { starts.count += 1; return { modelUsed: null, result: { text: 'x' }, aborted: false } },
    async merge() { throw Object.assign(new Error('未接收'), { code: 'not-received' }) },
    async stop() { return { ok: true } },
  }
  controller = createConversationController({ conversationId: 'conv-ac38-f1', effects: { runtime, store: storeEffect } })
  const makeInput = (inputId, text) => ({ inputId, editRevision: 0, text, inputSource: 'text', attachmentIds: [], references: null, createdAt: Date.now() })
  const sent = await controller.command({ type: 'send', input: makeInput('in-f1', 'F1 保存前失败') })
  await sleep(400)
  const startsAfterFailure = starts.count
  const pendingAfter = controller.getSnapshot().pending.find((p) => p.inputId === 'in-f1')
  const snapAfter = controller.getSnapshot()
  const storeFailedOnce = !failOnce
  // 显式重发（写链已恢复）才执行——保存失败不自动重试。
  const resent = await controller.command({ type: 'resendInput', inputId: 'in-f1' })
  await sleep(300)
  const snapFinal = controller.getSnapshot()
  note('F1', sent.ok === false && sent.code === 'storage-failed' && storeFailedOnce
    && startsAfterFailure === 0
    && pendingAfter != null && pendingAfter.text === 'F1 保存前失败'
    && snapAfter.queuePaused === true
    && resent.ok && starts.count === 1
    && snapFinal.timeline.filter((e) => e.kind === 'user' && e.text === 'F1 保存前失败').length === 1, {
    sendResult: { ok: sent.ok, code: sent.code }, startsAfterFailure, inputVisible: pendingAfter?.text,
    queuePaused: snapAfter.queuePaused, resendOk: resent.ok, startsTotal: starts.count,
  })
}

// ---------------------------------------------------------------- F5 标题/flow/agentSession 竞争保存
{
  const dir = path.join(root, 'f5')
  fs.mkdirSync(dir, { recursive: true })
  // 甲：flow 写链在读档前挂起（生产同步临界段内不可交错——注入异步 IO 只在临界段
  // 前挂起，等价于「两条写链之间」交错）：conversation 侧先完整落标题＋agentSession，
  // flow 链随后新鲜读合并——两侧字段都保留。
  let holdFirst = true
  let releaseHold = () => {}
  const hold = new Promise((r) => { releaseHold = r })
  const ioA = {
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    readFile: async (p) => { if (holdFirst) { holdFirst = false; await hold } return fs.readFileSync(p, 'utf8') },
    writeFile: (p, data) => fs.writeFileSync(p, data, 'utf8'),
    rename: (a, b) => fs.renameSync(a, b),
    unlink: (p) => { try { fs.unlinkSync(p) } catch { /* 不在 */ } },
  }
  const storeA = createFlowStore({ dir, fsOps: ioA })
  const convWrite = (mutate) => {
    const p = path.join(dir, 'conv-ac38-f5.json')
    const rec = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { id: 'conv-ac38-f5' }
    const tmp = `${p}.convtmp`
    fs.writeFileSync(tmp, JSON.stringify(mutate(rec), null, 2), 'utf8')
    fs.renameSync(tmp, p)
  }
  const flowOf = (revision) => ({ conversationId: 'conv-ac38-f5', revision, schemaVersion: 1, timeline: [], pending: [] })

  const flowWriteA = storeA.update('conv-ac38-f5', (rec) => ({ ...rec, flow: flowOf(1) }))
  await sleep(80) // flow 链挂在读档前
  convWrite((rec) => ({ ...rec, title: '标题A', agentSession: { entries: 5 } }))
  releaseHold()
  await flowWriteA.catch(() => {})
  const afterA = JSON.parse(fs.readFileSync(path.join(dir, 'conv-ac38-f5.json'), 'utf8'))

  // 乙：反向——flow 已提交，conversation 侧后写（保留 flow 字段），再补一次 flow 更新。
  convWrite((rec) => ({ ...rec, title: '标题B2' }))
  await storeA.update('conv-ac38-f5', (rec) => ({ ...rec, flow: flowOf(2) })).catch(() => {})
  const afterB = JSON.parse(fs.readFileSync(path.join(dir, 'conv-ac38-f5.json'), 'utf8'))

  // 丙：flow 写失败一次——变更保留待重试（failures 标记），盘上保持最近成功记录；
  // 下一次 update 合并补写，不丢已提交字段。
  const dirC = path.join(root, 'f5c')
  fs.mkdirSync(dirC, { recursive: true })
  let failOnce = true
  const ioC = {
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: async (p, data) => { if (failOnce) { failOnce = false; throw new Error('probe-injected-eacces') } fs.writeFileSync(p, data, 'utf8') },
    rename: (a, b) => fs.renameSync(a, b),
    unlink: (p) => { try { fs.unlinkSync(p) } catch { /* 不在 */ } },
  }
  const storeC = createFlowStore({ dir: dirC, fsOps: ioC })
  await storeC.update('conv-c1', (rec) => ({ ...rec, flow: flowOf(1), title: '丙首写' })).catch(() => {})
  const diskAfterFail = fs.existsSync(path.join(dirC, 'conv-c1.json')) ? 'present' : 'absent'
  const failedFlag = storeC.hasFailure('conv-c1')
  await storeC.update('conv-c1', (rec) => ({ ...rec, flow: flowOf(2) })).catch(() => {})
  const afterC = JSON.parse(fs.readFileSync(path.join(dirC, 'conv-c1.json'), 'utf8'))

  note('F5', afterA.title === '标题A' && afterA.agentSession?.entries === 5 && afterA.flow?.revision === 1
    && afterB.title === '标题B2' && afterB.agentSession?.entries === 5 && afterB.flow?.revision === 2
    && diskAfterFail === 'absent' && failedFlag === true
    && afterC.title === '丙首写' && afterC.flow?.revision === 2, {
    a: { title: afterA.title, agentEntries: afterA.agentSession?.entries, flowRevision: afterA.flow?.revision },
    b: { title: afterB.title, agentEntries: afterB.agentSession?.entries, flowRevision: afterB.flow?.revision },
    c: { diskAfterFail, failedFlag, title: afterC.title, flowRevision: afterC.flow?.revision },
  })
}

// ---------------------------------------------------------------- F6 迁移备份/原子替换中途状态＋坏档保护
{
  const dir = path.join(root, 'f6')
  fs.mkdirSync(dir, { recursive: true })
  const writeJson = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2), 'utf8')
  const readBytes = (name) => fs.readFileSync(path.join(dir, name), 'utf8')

  // v1 样本：数组顺序与 createdAt 乱序、同文两条不同 id、一条 withdrawn、一个任务 turn。
  const v1 = {
    id: 'conv-mig1', version: 1,
    turns: [
      { id: 't2', author: 'hemi', kind: 'reply', text: '先答', createdAt: 200 },
      { id: 't1', author: 'user', text: '同文问题', createdAt: 100 },
      { id: 't3', author: 'user', text: '同文问题', createdAt: 150 },
      { id: 't4', author: 'user', text: '已撤回的排队', createdAt: 180, withdrawn: true },
      { id: 't5', author: 'hemi', kind: 'task', text: '任务卡', createdAt: 300, taskId: 'task-x', taskSnap: { taskId: 'task-x', key: 'task-x', phase: 'terminal', outcome: 'complete', taskText: '任务卡' } },
    ],
  }
  writeJson('conv-mig1.json', v1)
  // 状态甲：备份已落、替换未做（同步临界段的 kill 态之一）——备份与原档字节一致。
  fs.copyFileSync(path.join(dir, 'conv-mig1.json'), path.join(dir, 'conv-mig1.json.migration-v1.json'))
  const backupBytesBefore = readBytes('conv-mig1.json.migration-v1.json')

  // 状态乙：tmp 已写、rename 未做（kill 态之二）——残留 tmp 无害。
  writeJson('conv-mig2.json', { id: 'conv-mig2', version: 1, turns: [{ id: 'u1', author: 'user', text: '二号', createdAt: 5 }] })
  fs.writeFileSync(path.join(dir, 'conv-mig2.json.migtmp-999'), '{partial junk', 'utf8')

  // 坏档＋高版本：保留不覆盖。
  fs.writeFileSync(path.join(dir, 'conv-corrupt.json'), '{oops', 'utf8')
  writeJson('conv-high.json', { id: 'conv-high', version: 9, turns: [{ id: 'h1', author: 'user', text: '未来版本', createdAt: 1 }] })

  const report1 = migrateConversationDirToV2(dir)
  const report2 = migrateConversationDirToV2(dir) // 幂等复跑

  const m1 = JSON.parse(readBytes('conv-mig1.json'))
  const m2 = JSON.parse(readBytes('conv-mig2.json'))
  const backupBytesAfter = readBytes('conv-mig1.json.migration-v1.json')
  const corruptAfter = readBytes('conv-corrupt.json')
  const high = JSON.parse(readBytes('conv-high.json'))
  const flow1Users = (m1.flow?.timeline ?? []).filter((e) => e.kind === 'user').map((e) => e.text)

  note('F6', report1.migrated === 2 && report1.skippedCorrupt === 1
    && report2.migrated === 0
    && m1.version === 2 && m1.turns.length === 5
    && backupBytesAfter === backupBytesBefore // 备份幂等未重写
    && JSON.stringify(flow1Users) === JSON.stringify(['同文问题', '同文问题']) // 同文不删重；withdrawn 不复活
    && (m1.flow?.timeline ?? []).some((e) => Array.isArray(e.parts) && e.parts.some((p) => p.kind === 'delegation'))
    && m2.version === 2 && m2.flow?.revision === 1
    && corruptAfter === '{oops' && high.version === 9, {
    report1, report2, m1Version: m1.version, turnsKept: m1.turns.length,
    backupUntouched: backupBytesAfter === backupBytesBefore,
    usersMigrated: flow1Users, corruptKept: corruptAfter === '{oops', highKept: high.version === 9,
    leftoverTmpIgnored: fs.existsSync(path.join(dir, 'conv-mig2.json.migtmp-999')),
  })
}

// ---------------------------------------------------------------- 汇总
server.closeAllConnections()
server.close()
const failed = Object.entries(results).filter(([, r]) => !r.ok)
console.log(`HEMI_VERIFY_057_AC38=${JSON.stringify({ ok: failed.length === 0, variants: results })}`)
fs.rmSync(root, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
