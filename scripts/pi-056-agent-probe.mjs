// 056 前置探针：Pi SDK 能否承载「主 agent 持全工具 ＋ 角色化子 agent」。
// 本地 mock Anthropic Messages 端点，钉死 056 方案依赖的 SDK 行为：
//   A1 同一条助手消息里的多个 task 调用并发执行（task 不标 sequential，其余工具标 sequential）
//   A2 混入一个 sequential 工具时整批串行
//   A3 createAgentSession({ tools }) 白名单同样约束扩展注册的工具（子 agent 工具面裁剪）
//   A4 additionalSkillPaths 加载项目 Skill（含软链目录），名称进系统提示词（前提：会话有 read 或 bash 工具）
//   A5 后台完成唤醒：空闲 sendCustomMessage(triggerTurn) 起新回合；忙时 followUp 排到当前回合后
//   A6 子会话运行中 steer 送达（下一个模型请求里可见）
//   A7 两个独立会话各用各的 provider/模型，互不串（子 agent 角色模型）
//   A8 主会话前缀（system＋tools）跨回合逐字节稳定
//   A9 忙时多条 followUp 逐条各起一次请求（FIFO）、同一 run 内消化（settled 单次，
//      prompt 等全队列收口）
//   A10 空闲时 followUp 不自动起轮（消息滞留队列，pendingMessageCount 可见）
//   A11 abort 后 followUp 队列保留且不自动跑；clearQueue 显式清空（停止语义）
//   A12 用户文本 followUp 与 sendCustomMessage followUp 混排按投递顺序各起一轮
//   A13 空闲滞留的 followUp 随下次 prompt 一并送达（abort 后必须 clearQueue 防残渣）
// 运行：node scripts/pi-056-agent-probe.mjs（exit 0＝全过）
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const sdkEntryPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
const sdkPackageDir = path.resolve(path.dirname(sdkEntryPath), '..')
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkPackageDir, 'package.json'), 'utf8')).version
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
const stripCache = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === 'cache_control' ? undefined : v)))
const same = (a, b) => JSON.stringify(stripCache(a)) === JSON.stringify(stripCache(b))

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
const systemText = (body) => (Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : String(body.system ?? ''))

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    requests.push(body)
    const step = respond(body) ?? { text: 'OK' }
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

/** tools: [{ name, sequential, impl(params, signal) }]；model: mock 模型 id（按它分流应答）。 */
async function createSession({ model, tools = [], allow = null, skillPaths = [], cwd = mkdtemp('hemi-056-cwd-'), systemPrompt = 'PROBE_SYSTEM' }) {
  const agentDir = mkdtemp('hemi-056-agent-')
  const ext = {
    name: `probe-${model}`,
    factory: (pi) => {
      pi.registerProvider(`p-${model}`, {
        baseUrl: mockBase, apiKey: 'probe', api: 'anthropic-messages',
        models: [{ id: model, name: model, reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
      })
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
  const settingsManager = SettingsManager.inMemory({})
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: [ext],
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    additionalSkillPaths: skillPaths,
    noSkills: skillPaths.length === 0,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd, agentDir, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: 'builtin',
    ...(allow ? { tools: allow } : {}),
  })
  await session.setModel(session.modelRuntime.getModels(`p-${model}`)[0])
  await session.bindExtensions({ mode: 'rpc', uiContext: new Proxy({}, { get: () => async () => undefined }) })
  return session
}

// ---------------------------------------------------------------- A1/A2 并发语义
{
  const spans = []
  const timed = (name) => async () => { const s = Date.now(); await sleep(300); spans.push({ name, s, e: Date.now() }); return `${name}-done` }
  const main = await createSession({
    model: 'main-a',
    tools: [
      { name: 'task', sequential: false, impl: timed('task') },
      { name: 'read_probe', sequential: true, impl: timed('read') },
    ],
  })
  let phase = 'parallel'
  responders.set('main-a', (body) => {
    if (lastIsToolResult(body)) return { text: 'DONE' }
    return phase === 'parallel'
      ? { toolCalls: [{ name: 'task', args: { x: '1' } }, { name: 'task', args: { x: '2' } }] }
      : { toolCalls: [{ name: 'task', args: { x: '3' } }, { name: 'read_probe', args: {} }] }
  })
  await withTimeout(main.prompt('并行'), 10000, 'A1')
  const p = spans.splice(0)
  const overlapped = p.length === 2 && p[1].s < p[0].e && p[0].s < p[1].e
  record('A1-parallel-task', '同一消息两个 task 调用并发执行', overlapped, p.map((x) => x.name))
  phase = 'mixed'
  await withTimeout(main.prompt('混合'), 10000, 'A2')
  const m = spans.splice(0)
  const serial = m.length === 2 && (m[1].s >= m[0].e || m[0].s >= m[1].e)
  record('A2-mixed-serial', '混入 sequential 工具时整批串行', serial, m.map((x) => x.name))
  main.dispose()
}

// ---------------------------------------------------------------- A3 工具白名单约束扩展工具
{
  const child = await createSession({
    model: 'child-a3',
    tools: [
      { name: 'read_probe', sequential: true, impl: async () => 'r' },
      { name: 'write_probe', sequential: true, impl: async () => 'w' },
      { name: 'task', impl: async () => 't' },
    ],
    allow: ['read_probe'],
  })
  responders.set('child-a3', () => ({ text: 'OK' }))
  const before = requests.length
  await withTimeout(child.prompt('看看工具'), 10000, 'A3')
  const declared = (requests[before]?.tools ?? []).map((t) => t.name)
  record('A3-tool-allowlist', 'tools 白名单只声明 read_probe（扩展注册的 write/task 不进请求）',
    declared.length === 1 && declared[0] === 'read_probe', declared)
  child.dispose()
}

// ---------------------------------------------------------------- A4 项目 Skill（含软链）
{
  const project = mkdtemp('hemi-056-proj-')
  const external = mkdtemp('hemi-056-ext-skill-')
  const mkSkill = (dir, name, desc) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\nbody\n`)
  }
  mkSkill(path.join(project, '.claude/skills/douyin-publish'), 'douyin-publish', 'PROBE_DESC_DOUYIN')
  mkSkill(path.join(external, 'lemo-opuscar'), 'lemo-opuscar', 'PROBE_DESC_LEMO')
  fs.symlinkSync(path.join(external, 'lemo-opuscar'), path.join(project, '.claude/skills/lemo-opuscar'))
  const skillFiles = fs.readdirSync(path.join(project, '.claude/skills'))
    .map((name) => path.join(project, '.claude/skills', name, 'SKILL.md'))
    .filter((file) => fs.existsSync(file))
  // SDK 事实：只有激活了 read 或 bash 工具，Skill 清单才渲染进系统提示词（system-prompt.js）。
  const s = await createSession({ model: 'skill-a4', skillPaths: skillFiles, cwd: project, tools: [{ name: 'read', sequential: true, impl: async () => 'r' }] })
  responders.set('skill-a4', () => ({ text: 'OK' }))
  const before = requests.length
  await withTimeout(s.prompt('有哪些 skill'), 10000, 'A4')
  const sys = systemText(requests[before] ?? {})
  record('A4-project-skills', '项目 .claude/skills（含软链目录）进系统提示词',
    sys.includes('douyin-publish') && sys.includes('PROBE_DESC_DOUYIN') && sys.includes('lemo-opuscar'),
    { found: ['douyin-publish', 'lemo-opuscar'].filter((n) => sys.includes(n)) })
  s.dispose()
}

// ---------------------------------------------------------------- A5 后台完成唤醒
{
  const main = await createSession({ model: 'main-a5', tools: [{ name: 'task', impl: async () => 'started' }] })
  const turns = []
  main.subscribe((e) => { if (e.type === 'agent_settled') turns.push(Date.now()) })
  responders.set('main-a5', (body) => {
    const text = bodyText(body)
    if (text.includes('TASK_DONE_IDLE') && !text.includes('ACK_IDLE')) return { text: 'ACK_IDLE' }
    if (text.includes('TASK_DONE_BUSY') && !text.includes('ACK_BUSY')) return { text: 'ACK_BUSY' }
    return { text: 'PLAIN', delayMs: 300 }
  })
  await withTimeout(main.prompt('先聊一句'), 10000, 'A5-a')
  // 空闲：triggerTurn
  const idleBefore = requests.length
  await main.sendCustomMessage({ customType: 'hemi_task_notification', content: 'TASK_DONE_IDLE', display: false }, { triggerTurn: true })
  await withTimeout(main.waitForIdle(), 10000, 'A5-idle')
  const idleWoke = requests.slice(idleBefore).some((b) => bodyText(b).includes('TASK_DONE_IDLE'))
  // 忙：followUp
  const busyRun = main.prompt('再聊一句')
  await sleep(50)
  const busyBefore = requests.length
  await main.sendCustomMessage({ customType: 'hemi_task_notification', content: 'TASK_DONE_BUSY', display: false }, { deliverAs: 'followUp' })
  await withTimeout(busyRun, 10000, 'A5-busy')
  await withTimeout(main.waitForIdle(), 10000, 'A5-busy-idle')
  const busyAfter = requests.slice(busyBefore)
  const busyQueued = busyAfter.length >= 1 && bodyText(busyAfter.at(-1)).includes('TASK_DONE_BUSY')
  record('A5-background-wake', '空闲 triggerTurn 唤醒；忙时 followUp 排到当前回合后',
    idleWoke && busyQueued, { idleWoke, busyQueued, requestsAfterBusy: busyAfter.length })
  main.dispose()
}

// ---------------------------------------------------------------- A6 子会话 steer
{
  let release
  const gate = new Promise((r) => { release = r })
  const child = await createSession({ model: 'child-a6', tools: [{ name: 'slow', sequential: true, impl: async () => { await gate; return 'slow-done' } }] })
  responders.set('child-a6', (body) => (lastIsToolResult(body) ? { text: 'CHILD_DONE' } : { toolCall: { name: 'slow', args: {} } }))
  const before = requests.length
  const run = child.prompt('干活')
  await sleep(150)
  await child.steer('STEER_MARK 改成只看 README')
  release()
  await withTimeout(run, 10000, 'A6')
  const seen = requests.slice(before).some((b) => bodyText(b).includes('STEER_MARK'))
  record('A6-child-steer', '子会话运行中 steer 在下一个模型请求里可见', seen)
  child.dispose()
}

// ---------------------------------------------------------------- A7 两会话各用各的模型
{
  responders.set('role-fast', () => ({ text: 'FAST' }))
  responders.set('role-strong', () => ({ text: 'STRONG' }))
  const a = await createSession({ model: 'role-fast' })
  const b = await createSession({ model: 'role-strong' })
  const before = requests.length
  await Promise.all([withTimeout(a.prompt('x'), 10000, 'A7a'), withTimeout(b.prompt('y'), 10000, 'A7b')])
  const models = requests.slice(before).map((r) => r.model).sort()
  record('A7-per-role-model', '并行两会话请求分别打到各自模型', JSON.stringify(models) === JSON.stringify(['role-fast', 'role-strong']), models)
  a.dispose(); b.dispose()
}

// ---------------------------------------------------------------- A8 主会话前缀稳定
{
  const main = await createSession({
    model: 'main-a8',
    tools: [{ name: 'task', impl: async () => 't' }, { name: 'read_probe', sequential: true, impl: async () => 'r' }],
  })
  responders.set('main-a8', () => ({ text: 'OK' }))
  const before = requests.length
  await withTimeout(main.prompt('一'), 10000, 'A8a')
  await withTimeout(main.prompt('二'), 10000, 'A8b')
  const [r1, r2] = requests.slice(before)
  const stable = r1 && r2 && same(r1.system, r2.system) && same(r1.tools, r2.tools)
    && same(r1.messages, r2.messages.slice(0, r1.messages.length))
  record('A8-prefix-stable', '第二回合 system＋tools＋前序消息与第一回合逐字节一致', Boolean(stable))
  main.dispose()
}

// ---------------------------------------------------------------- A9 多条 followUp 的批量合并语义
{
  const main = await createSession({ model: 'main-a9' })
  const timeline = []
  let reqSeq = 0
  const origPush = requests.push.bind(requests)
  requests.push = (body) => { reqSeq += 1; const n = reqSeq; timeline.push(`req${n}:${bodyText(body).includes('FU_FIRST') ? 'F1' : ''}${bodyText(body).includes('FU_SECOND') ? '+F2' : ''}`); return origPush(body) }
  main.subscribe((e) => { if (e.type === 'agent_settled') timeline.push('settled') })
  responders.set('main-a9', (body) => {
    const text = bodyText(body)
    if (text.includes('FU_FIRST') && !text.includes('ACK1')) return { text: 'ACK1' }
    if (text.includes('FU_SECOND') && !text.includes('ACK2')) return { text: 'ACK2' }
    return { text: 'PLAIN', delayMs: 300 }
  })
  const firstRun = main.prompt('先忙这一轮')
  await sleep(100)
  await main.followUp('追加第一条 FU_FIRST')
  await main.followUp('追加第二条 FU_SECOND')
  await withTimeout(firstRun, 10000, 'A9-first')
  timeline.push('prompt-resolved')
  await withTimeout(main.waitForIdle(), 10000, 'A9-idle')
  timeline.push('idle')
  const seen = requests.map((b) => bodyText(b))
  const f1Solo = seen.findIndex((t) => t.includes('FU_FIRST') && !t.includes('FU_SECOND'))
  const f2At = seen.findIndex((t, i) => t.includes('FU_SECOND') && i > f1Solo)
  const settledCount = timeline.filter((x) => x === 'settled').length
  // SDK 实测行为：多条 followUp 逐条各起一次模型请求（FIFO），在同一 agent run 内消化——
  // settled 只发一次，prompt 等全部排队消息消化完才 resolve。
  record('A9-multi-followup-sequential', '多条 followUp 逐条各起一次请求（FIFO）、同一 run 内消化；settled 单次、prompt 等全队列收口',
    f1Solo >= 0 && f2At >= 0 && settledCount === 1 && timeline.indexOf('prompt-resolved') > timeline.findIndex((x) => x.startsWith('req') && x.includes('F1')),
    { timeline, settledCount })
  main.dispose()
}

// ---------------------------------------------------------------- A10 空闲 followUp 不起轮
{
  const main = await createSession({ model: 'main-a10' })
  responders.set('main-a10', () => ({ text: 'OK' }))
  await withTimeout(main.prompt('暖场'), 10000, 'A10-warm')
  const before = requests.length
  await main.followUp('空闲排一条 IDLE_FU')
  await sleep(400)
  const fired = requests.slice(before).some((b) => bodyText(b).includes('IDLE_FU'))
  const pending = main.pendingMessageCount
  record('A10-idle-followup-holds', '空闲时 followUp 不自动起轮，滞留队列（入队实现必须按忙/闲分流）',
    !fired && pending >= 1, { fired, pending })
  main.dispose()
}

// ---------------------------------------------------------------- A11 abort 后队列保留、clearQueue 显式清
{
  const main = await createSession({ model: 'main-a11' })
  responders.set('main-a11', () => ({ text: 'PLAIN', delayMs: 300 }))
  const run = main.prompt('这一轮要被打断')
  await sleep(100)
  await main.followUp('停止前的排队 ABORT_FU')
  await main.abort().catch(() => {})
  await run.catch(() => {})
  const before = requests.length
  await sleep(500)
  const fired = requests.slice(before).some((b) => bodyText(b).includes('ABORT_FU'))
  const kept = main.getFollowUpMessages().some((t) => String(t).includes('ABORT_FU'))
  const cleared = main.clearQueue()
  const afterClear = main.pendingMessageCount
  record('A11-abort-keeps-queue', 'abort 后 followUp 队列保留且不自动跑；clearQueue 拿回并清空（停止＝暂停，不丢消息）',
    !fired && kept && cleared.followUp.length >= 1 && afterClear === 0,
    { fired, kept, clearedFollowUp: cleared.followUp.length, afterClear })
  main.dispose()
}

// ---------------------------------------------------------------- A12 用户 followUp 与 custom message followUp 混排
{
  const main = await createSession({ model: 'main-a12' })
  responders.set('main-a12', (body) => {
    const text = bodyText(body)
    if (text.includes('MIX_USER') && !text.includes('ACK_USER')) return { text: 'ACK_USER' }
    if (text.includes('MIX_TASK') && !text.includes('ACK_TASK')) return { text: 'ACK_TASK' }
    return { text: 'PLAIN', delayMs: 300 }
  })
  const run = main.prompt('忙时先用户后宿主')
  await sleep(100)
  await main.followUp('用户追加 MIX_USER')
  await main.sendCustomMessage({ customType: 'hemi_subagent_result', content: '宿主通知 MIX_TASK', display: false }, { deliverAs: 'followUp' })
  await withTimeout(run, 10000, 'A12-run')
  await withTimeout(main.waitForIdle(), 10000, 'A12-idle')
  const seen = requests.map((b) => bodyText(b))
  const userSolo = seen.findIndex((t) => t.includes('MIX_USER') && !t.includes('MIX_TASK'))
  const taskAt = seen.findIndex((t, i) => t.includes('MIX_TASK') && i > userSolo)
  const orderKept = userSolo >= 0 && seen[userSolo].indexOf('MIX_USER') >= 0
  // 与 A9 同源：用户 followUp 与宿主 custom followUp 同一条队列，逐条按投递顺序各起一轮。
  record('A12-user-vs-host-fifo', '用户文本 followUp 与宿主通知 followUp 逐条各起一轮、按投递顺序（用户先、宿主后）',
    orderKept && userSolo >= 0 && taskAt > userSolo, { userSolo, taskAt })
  main.dispose()
}

// ---------------------------------------------------------------- A13 空闲滞留 followUp 在下次 prompt 时的归宿
{
  const main = await createSession({ model: 'main-a13' })
  responders.set('main-a13', () => ({ text: 'OK' }))
  await withTimeout(main.prompt('暖场'), 10000, 'A13-warm')
  await main.followUp('滞留的 STALE_FU')
  await sleep(200)
  const before = requests.length
  await withTimeout(main.prompt('新回合文本'), 10000, 'A13-next')
  const after = requests.slice(before)
  const staleIdx = after.findIndex((t) => bodyText(t).includes('STALE_FU'))
  const freshIdx = after.findIndex((t) => bodyText(t).includes('新回合文本'))
  // 决定 abort 处置：若滞留消息会随下次 prompt 冒出来，abort 后必须 clearQueue，
  // 否则被中止回合的残留 followUp（宿主通知等）会在下个回合突然送达。
  record('A13-stale-followup-next-prompt', '空闲滞留的 followUp 随下次 prompt 一并送达（先于/伴随新文本）',
    staleIdx >= 0, { staleIdx, freshIdx, requestCount: after.length })
  main.dispose()
}

// ---------------------------------------------------------------- 收尾
await sleep(100)
const pass = findings.filter((f) => f.ok).length
console.log(`\n=== 056 agent probe summary: ${pass}/${findings.length} passed ===`)
console.log(JSON.stringify({ sdk: sdkVersion, node: process.version, pass, total: findings.length, failed: findings.filter((f) => !f.ok).map((f) => f.id) }, null, 2))
server.close()
for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
process.exit(pass === findings.length ? 0 : 1)
