// 023 SDK API 探针：驱动 Hemi 适配器依赖的完整 SDK 契约面（针对安装的 pi-coding-agent）。
// 用本地 mock OpenAI 兼容端点驱动完整回路，验证 023 技术方案依赖的全部 SDK 行为。
// 运行：node scripts/pi-sdk-probe.mjs
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// 1.0.0 的 exports 只有 import 条件且不暴露 ./package.json 子路径，
// 用 import.meta.resolve 定位主入口再回溯包目录读版本。
const sdkEntryPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const sdkPackageDir = path.resolve(path.dirname(sdkEntryPath), '..')
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkPackageDir, 'package.json'), 'utf8')).version

const { createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager } =
  await import('@earendil-works/pi-coding-agent')

// ---------------------------------------------------------------- 探针记录
const findings = []
const eventLog = []
const assistantTexts = []
const toolEnds = []
function record(id, claim, ok, detail) {
  findings.push({ id, claim, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}`)
  if (detail !== undefined) console.log(`      → ${JSON.stringify(detail)}`)
}
function summaryType(e) {
  if (e.type === 'tool_execution_start') return `tool_execution_start:${e.toolName}`
  if (e.type === 'tool_execution_end') return `tool_execution_end:${e.toolName}`
  if (e.type === 'message_end') return `message_end:${e.message?.role}`
  if (e.type === 'message_update') return null // 流式增量太吵，只记 start/end
  if (e.type === 'tool_execution_update') return null
  return e.type
}

// ---------------------------------------------------------------- mock server
// OpenAI chat completions 兼容 mock：按「本段脚本内」的请求序号回放脚本化响应，支持流式与非流式。
const requests = []
let firstSystemText = null
let script = []
let scriptIndex = 0
function setScript(steps) {
  script = steps
  scriptIndex = 0
}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {}
    const step = script[Math.min(scriptIndex, script.length - 1)]
    scriptIndex++
    const entry = { tools: (parsed.tools || []).map((t) => t.function?.name), messages: parsed.messages?.length, stream: !!parsed.stream }
    requests.push(entry)
    const sysMsg = (parsed.messages || []).find((m) => m.role === 'system')
    if (sysMsg && firstSystemText === null) firstSystemText = String(sysMsg.content ?? '')
    console.log(`[mock] request #${requests.length} stream=${entry.stream} tools=[${entry.tools.join(', ')}] msgs=${entry.messages}`)
    const chunk = (delta, finish) => JSON.stringify({
      id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: 'hemi-probe-model',
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })
    const sendDelay = step.delayMs ?? 0
    setTimeout(() => {
      if (parsed.stream) {
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
        parts.push(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: 'hemi-probe-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
        parts.push('[DONE]')
        res.write(parts.map((p) => `data: ${p}\n\n`).join(''))
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        const message = step.toolCall
          ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${requests.length}`, type: 'function', function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.args) } }] }
          : { role: 'assistant', content: step.text ?? '' }
        res.end(JSON.stringify({
          id: 'chatcmpl-probe', object: 'chat.completion', created: 1, model: 'hemi-probe-model',
          choices: [{ index: 0, message, finish_reason: step.toolCall ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }))
      }
    }, sendDelay)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const mockUrl = `http://127.0.0.1:${server.address().port}/v1`
console.log(`[mock] listening on ${mockUrl}`)

// ---------------------------------------------------------------- 探针会话
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-probe-cwd-'))
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-probe-agent-'))
const echoCalls = []
let deniedExecuted = false
let hookCalls = []
let execCtx = null
let blockedEndRaw = null

const hemiProbeExtension = {
  name: 'hemi-probe',
  factory: (pi) => {
    pi.registerProvider('hemi-probe', {
      name: 'Hemi Probe',
      baseUrl: mockUrl,
      apiKey: 'probe-key-not-real',
      api: 'openai-completions',
      models: [{
        id: 'hemi-probe-model',
        name: 'Hemi Probe Model',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      }],
    })
    pi.registerTool({
      name: 'hemi_probe_echo',
      label: 'Echo',
      description: 'Echo the given text back. Use this when the user asks to echo.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        echoCalls.push(params)
        execCtx = { mode: ctx.mode, hasUI: ctx.hasUI }
        return { content: [{ type: 'text', text: `echo:${params.text}` }] }
      },
    })
    pi.registerTool({
      name: 'hemi_probe_denied',
      label: 'Denied',
      description: 'A tool that the Hemi gate always denies.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        deniedExecuted = true
        return { content: [{ type: 'text', text: 'should never run' }] }
      },
    })
    pi.on('tool_call', async (event) => {
      hookCalls.push({ toolName: event.toolName, input: event.input })
      if (event.toolName === 'hemi_probe_denied') {
        await new Promise((r) => setTimeout(r, 50)) // 证明 hook 可以异步挂起（权限等待的前提）
        return { block: true, reason: 'denied by hemi gate probe', terminate: true }
      }
      return {}
    })
  },
}

const sessionManager = SessionManager.inMemory(cwd)
const settingsManager = SettingsManager.inMemory()
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  extensionFactories: [hemiProbeExtension],
  appendSystemPromptOverride: (base) => [...base, 'HEMI_PROBE_APPEND_MARKER: probe identity'],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
})
await resourceLoader.reload()

let session
try {
  ;({ session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager, settingsManager }))
} catch (err) {
  record('P1-create', 'createAgentSession + inMemory + inline factory 可创建会话', false, { error: String(err) })
  process.exit(1)
}

// 扩展工厂注册的 provider 是否进入 ModelRuntime；显式 setModel 选中它。
try {
  const models = session.modelRuntime.getModels('hemi-probe')
  const probeModel = models[0] ?? null
  if (probeModel) await session.setModel(probeModel)
  record('P1-create', 'createAgentSession + inMemory + inline factory；扩展注册 provider 可被 runtime 发现并 setModel',
    !!probeModel, { models: models.map((m) => `${m.provider}/${m.id}`), selected: session.model?.id })
} catch (err) {
  record('P1-create', 'createAgentSession + inMemory + inline factory；扩展注册 provider 可被 runtime 发现并 setModel', false, { error: String(err) })
  process.exit(1)
}

session.subscribe((event) => {
  const t = summaryType(event)
  if (t) eventLog.push(t)
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    assistantTexts.push((event.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''))
  }
  if (event.type === 'tool_execution_end') {
    toolEnds.push({ toolName: event.toolName, isError: event.result?.isError, content: (event.result?.content || []).map((c) => c.text ?? c.type).join('|') })
    if (event.toolName === 'hemi_probe_denied') {
      blockedEndRaw = { isError: event.result?.isError, details: event.result?.details, content: event.result?.content, stopReason: event.message?.stopReason, errorMessage: event.message?.errorMessage }
    }
  }
})

// 可诊断性：uiContext 用 Proxy 兜底，任何未实现方法调用都会被记录而不是崩溃。
const uiCalls = []
const uiContext = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'select') return async () => { uiCalls.push('select'); return undefined }
    if (prop === 'confirm') return async () => { uiCalls.push('confirm'); return false }
    if (prop === 'input') return async () => { uiCalls.push('input'); return undefined }
    return () => { uiCalls.push(String(prop)) }
  },
})
let abortHandlerFired = false
try {
  await session.bindExtensions({
    mode: 'rpc', // SDK 扩展运行时能力模式（023 方案：非 Pi CLI RPC 子进程）
    uiContext,
    abortHandler: () => { abortHandlerFired = true },
  })
  record('P2-bind', 'bindExtensions({mode:"rpc", uiContext, abortHandler}) 可用', true, { uiCallsSoFar: uiCalls.length })
} catch (err) {
  record('P2-bind', 'bindExtensions({mode:"rpc", uiContext, abortHandler}) 可用', false, { error: String(err) })
}

// ---------------------------------------------------------------- P3 正常回路：prompt → tool → report
setScript([{ toolCall: { name: 'hemi_probe_echo', args: { text: 'hello' } } }, { text: 'PROBE_ROUND1_DONE' }])
hookCalls = []
assistantTexts.length = 0
toolEnds.length = 0
const t3 = Date.now()
await session.prompt('请调用 hemi_probe_echo 工具')
record('P3-loop', 'prompt→tool_call→execute→report 全回路（含 async hook 与工具结果回传）',
  echoCalls.length === 1 && assistantTexts.includes('PROBE_ROUND1_DONE'),
  { echoCalls, ms: Date.now() - t3, hookCalls, toolEnds, assistantTexts, events: eventLog.slice(), execCtx })
eventLog.length = 0

// ---------------------------------------------------------------- P3b 系统提示词追加段
// 适配器依赖：appendSystemPromptOverride 的返回值进入发给模型的 system 消息，
// 且 SDK 默认提示词仍完整保留——append 不吞默认段。cwd 行自 1.0.0 起为
// <cwd>…</cwd> 标签（0.85.x 是 "Current working directory: …" 措辞）。
record('P3b-append-system', 'appendSystemPromptOverride 追加段进入 system 消息，默认提示词（cwd 段）仍在',
  Boolean(firstSystemText?.includes('HEMI_PROBE_APPEND_MARKER')) && /<cwd>[\s\S]*<\/cwd>|Current working directory/.test(firstSystemText ?? ''),
  { length: firstSystemText?.length, tail: firstSystemText?.slice(-240) })

// ---------------------------------------------------------------- P4 拦截：block + terminate
setScript([{ toolCall: { name: 'hemi_probe_denied', args: {} } }, { text: 'PROBE_SHOULD_NOT_NEED_THIS' }])
deniedExecuted = false
hookCalls = []
assistantTexts.length = 0
toolEnds.length = 0
blockedEndRaw = null
await session.prompt('请调用 hemi_probe_denied 工具')
const blockedByHook = hookCalls.some((h) => h.toolName === 'hemi_probe_denied') && !deniedExecuted
  && toolEnds.some((t) => t.toolName === 'hemi_probe_denied' && t.content.includes('denied by hemi gate probe'))
record('P4-block', 'tool_call hook 异步返回 {block,reason,terminate}：工具不执行、reason 进入工具结果、无后续模型请求',
  blockedByHook,
  { deniedExecuted, hookCalls, toolEnds, assistantTexts, blockedEndRaw, events: eventLog.slice(), mockRequests: requests.length })
eventLog.length = 0

// ---------------------------------------------------------------- P5 steer 运行中转向
setScript([
  { toolCall: { name: 'hemi_probe_echo', args: { text: 'steer-me' } } },
  { text: 'PROBE_SLOW_DONE', delayMs: 600 },
  { text: 'PROBE_AFTER_STEER_DONE' },
])
hookCalls = []
assistantTexts.length = 0
toolEnds.length = 0
const msgsBeforeSteer = requests.length
const steerPromise = session.steer('STEER:先做别的').catch((e) => `steer-error:${e.message}`)
await new Promise((r) => setTimeout(r, 350)) // 等第二轮请求在途
await session.prompt('请先 echo，然后慢慢总结')
const steerResult = await steerPromise
// 1.0.0（0.99.0 起）：steer/followUp 成功时返回 per-input disposition 字符串
// （"handled"｜"queued"），0.85.x 返回 undefined。适配器当 void 消费，不依赖值。
const steerDispositionOk = steerResult === undefined || (typeof steerResult === 'string' && steerResult.length > 0)
record('P5-steer', '运行中 steer() 被接受并触发后续模型轮次',
  steerDispositionOk && requests.length > msgsBeforeSteer,
  { steerResult, assistantTexts, events: eventLog.slice(), mockRequests: requests.length, msgsBeforeSteer })
eventLog.length = 0

// ---------------------------------------------------------------- P6 followUp 排队补充
setScript([
  { toolCall: { name: 'hemi_probe_echo', args: { text: 'fu' } } },
  { text: 'PROBE_FU_FIRST' },
  { text: 'PROBE_FU_SECOND' },
])
hookCalls = []
assistantTexts.length = 0
const fuPromise = session.followUp('FOLLOWUP:补充指令').catch((e) => `followUp-error:${e.message}`)
await new Promise((r) => setTimeout(r, 100))
const fuStart = requests.length
await session.prompt('请 echo 一次')
const fuResult = await fuPromise
const fuDispositionOk = fuResult === undefined || (typeof fuResult === 'string' && fuResult.length > 0)
record('P6-followUp', 'followUp() 排队并在当前轮后自动执行新轮',
  fuDispositionOk && requests.length > fuStart,
  { fuResult, assistantTexts, events: eventLog.slice(), mockRequests: requests.length })
eventLog.length = 0

// ---------------------------------------------------------------- P7 abort 取消
setScript([{ text: 'PROBE_NEVER_ARRIVES', delayMs: 3000 }])
hookCalls = []
assistantTexts.length = 0
const t7 = Date.now()
const p7 = session.prompt('慢慢回答').then(() => 'resolved', (e) => `rejected:${e.name}:${e.message}`)
await new Promise((r) => setTimeout(r, 200))
let abortErr1 = null
let abortErr2 = null
try { await session.abort() } catch (e) { abortErr1 = String(e) }
try { await session.abort() } catch (e) { abortErr2 = String(e) } // 幂等性
const p7Result = await p7
let idleErr = null
try {
  await Promise.race([session.waitForIdle(), new Promise((_, rej) => setTimeout(() => rej(new Error('waitForIdle-timeout')), 3000))])
} catch (e) { idleErr = String(e) }
record('P7-abort', 'abort() 取消在途回合、幂等、prompt 收敛、waitForIdle 返回',
  abortErr1 === null && abortErr2 === null && idleErr === null,
  { promptOutcome: p7Result, abortErr1, abortErr2, idleErr, abortHandlerFired, ms: Date.now() - t7, events: eventLog.slice() })
eventLog.length = 0
abortHandlerFired = false

// ---------------------------------------------------------------- P8 dispose
let disposeErr = null
try { session.dispose() } catch (e) { disposeErr = String(e) }
let disposeErr2 = null
try { session.dispose() } catch (e) { disposeErr2 = String(e) }
let promptAfterDispose = 'no-throw'
try { await session.prompt('x') } catch (e) { promptAfterDispose = `throw:${e.name}` }
// 探针事实：dispose 后 prompt 不抛错而是静默返回 —— 适配器必须用 runEpoch 自己挡住
// dispose/abort 之后的调用与迟到事件，不能依赖 SDK 抛错。
record('P8-dispose', 'dispose() 幂等（prompt-after-dispose 行为如实记录，适配器需自行防护）',
  disposeErr === null && disposeErr2 === null,
  { disposeErr, disposeErr2, promptAfterDispose, note: 'SDK 不阻止 dispose 后 prompt；适配器必须以 epoch 守卫' })

// ---------------------------------------------------------------- P9 内存会话零落盘
const cwdFiles = fs.readdirSync(cwd)
const agentFiles = fs.readdirSync(agentDir)
// 探针事实：cwd 无 session 文件；agentDir 出现 auth.json / models-store.json
// （provider 注册与模型存储的落点）。适配器将传入受 Hemi 管理的 agentDir，或改用
// ModelRuntime 的内存 store；是否保留这两个文件属于实施决策，记录到技术方案。
record('P9-nofiles', 'inMemory 会话不在 cwd 产生 session 文件；agentDir 落点如实记录',
  cwdFiles.length === 0,
  { cwdFiles, agentFiles, note: 'auth.json/models-store.json 由 provider 注册与模型 store 写入 agentDir' })

// ---------------------------------------------------------------- P10 遗留资源
await new Promise((r) => setTimeout(r, 100))
const resources = process.getActiveResourcesInfo()
const timers = resources.filter((r) => r === 'Timeout').length
const sockets = resources.filter((r) => r.includes('Socket')).length
record('P10-resources', 'dispose 后无遗留 timer / 活跃 socket（除探针自身 mock server）', timers === 0,
  { timers, sockets, resources: [...new Set(resources)] })

// ---------------------------------------------------------------- 汇总
const pass = findings.filter((f) => f.ok).length
console.log(`\n=== probe summary: ${pass}/${findings.length} passed ===`)
console.log(JSON.stringify({
  sdk: sdkVersion, node: process.version, pass, total: findings.length,
  eventVocabulary: [...new Set(eventLog)],
}, null, 2))
server.close()
fs.rmSync(cwd, { recursive: true, force: true })
fs.rmSync(agentDir, { recursive: true, force: true })
process.exit(pass === findings.length ? 0 : 1)
