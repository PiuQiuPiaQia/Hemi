#!/usr/bin/env node
// 042 · P0-4 SDK 门控探针：工具替换与任务级隔离的接法验证（technical-plan §3/§5）。
// 验证（照 pi-sdk-probe 的 mock 回路模式）：
//   C1 内置 bash 默认在工具列表（对照）；
//   C2 扩展注册同名 bash → 模型请求里的定义是我们的（描述标记），调用走我们的
//      execute（返回标记而非真实 shell 输出）＝内置实现被顶掉；
//   C3 tool_call hook 对同名工具仍可 block（gate 前置于执行）；
//   C4 两个会话各自工厂注册的同名工具闭包互不串扰（任务级快照/状态的可行性）；
//   C5 tool_call hook 返回 { input } 能否改写参数（决定路径归一化放 wrapper 还是 hook）。
// 运行：node scripts/perm-sdk-gate-probe.mjs。exit 0 = 全过（C5 允许“不支持”结论，记 FACT）。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager } =
  await import('@earendil-works/pi-coding-agent')

const findings = []
const record = (id, claim, ok, detail) => {
  findings.push({ id, claim, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}`)
  if (detail !== undefined) console.log(`      → ${JSON.stringify(detail)}`)
}

// ---------------------------------------------------------------- mock server
let script = []
let scriptIndex = 0
const toolDefs = []   // 每次请求里 bash 的 function 定义
const setScript = (steps) => { script = steps; scriptIndex = 0 }
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = body ? JSON.parse(body) : {}
    const step = script[Math.min(scriptIndex, script.length - 1)]
    scriptIndex++
    const bashDef = (parsed.tools || []).find((t) => t.function?.name === 'bash')
    if (bashDef) toolDefs.push(bashDef.function)
    const chunk = (delta, finish) => JSON.stringify({
      id: 'p0x', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const parts = []
      if (step.toolCall) {
        parts.push(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `c${scriptIndex}`, type: 'function', function: { name: step.toolCall.name, arguments: '' } }] }))
        parts.push(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.toolCall.args) } }] }))
        parts.push(chunk({}, 'tool_calls'))
      } else {
        parts.push(chunk({ role: 'assistant', content: step.text ?? '' }))
        parts.push(chunk({}, 'stop'))
      }
      parts.push('[DONE]')
      res.write(parts.map((p) => `data: ${p}\n\n`).join(''))
      res.end()
    }, step.delayMs ?? 0)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const mockUrl = `http://127.0.0.1:${server.address().port}/v1`

// ---------------------------------------------------------------- 工厂：同名 bash 包装
const makeFactory = (tag) => (pi) => {
  pi.registerProvider('hemi-probe', {
    name: 'Hemi Probe', baseUrl: mockUrl, apiKey: 'k', api: 'openai-completions',
    models: [{ id: 'm', name: 'M', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  })
  const state = { calls: 0, lastInput: null }
  state.tag = tag
  pi.registerTool({
    name: 'bash', // 与 SDK 内置同名：验证覆盖
    label: 'Bash (wrapped)',
    description: `HEMI_WRAPPED_BASH_${tag}: restricted bash facade for 042 probe`,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (_id, params) => {
      state.calls++
      state.lastInput = params
      return { content: [{ type: 'text', text: `wrapped:${tag}:${params.command}` }] } // 绝不真跑 shell
    },
  })
  pi.on('tool_call', async (event) => {
    if (event.toolName === 'bash' && String(event.input?.command ?? '').startsWith('BLOCKED:')) {
      return { block: true, reason: 'blocked by 042 probe gate' }
    }
    if (event.toolName === 'bash' && String(event.input?.command ?? '').startsWith('REWRITE:')) {
      return { input: { command: String(event.input.command).replace('REWRITE:', 'REWRITTEN:') } }
    }
    return {}
  })
  return { state }
}

const mkSession = async (tag) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-p0x-${tag}-`))
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-p0x-a-${tag}-`))
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [(pi) => makeFactory(tag)(pi)],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory() })
  const models = session.modelRuntime.getModels('hemi-probe')
  await session.setModel(models[0])
  const ui = new Proxy({}, { get: (_t, p) => (p === 'select' ? async () => undefined : async () => false) })
  await session.bindExtensions({ mode: 'rpc', uiContext: ui, abortHandler: () => {} })
  return { session, state: null }
}

let sessionA, sessionB, factoryStateA, factoryStateB
try {
  // 工厂状态在闭包里，为断言方便手动再建一份句柄：直接复用 makeFactory 的 state 收集
  const states = {}
  const wrapFactory = (tag) => (pi) => { const r = makeFactory(tag)(pi); states[tag] = r.state; return r }
  const build = async (tag) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-p0x-${tag}-`))
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `hemi-p0x-a-${tag}-`))
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: SettingsManager.inMemory(),
      extensionFactories: [wrapFactory(tag)],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory() })
    const models = session.modelRuntime.getModels('hemi-probe')
    await session.setModel(models[0])
    const ui = new Proxy({}, { get: (_t, p) => (p === 'select' ? async () => undefined : async () => false) })
    await session.bindExtensions({ mode: 'rpc', uiContext: ui, abortHandler: () => {} })
    return { session, state: states[tag] }
  }
  ;({ session: sessionA, state: factoryStateA } = await build('A'))
  ;({ session: sessionB, state: factoryStateB } = await build('B'))
  record('S0-setup', '两个独立会话＋同名 bash 包装可创建（inline factory × 2）', true)
} catch (err) {
  record('S0-setup', '两个独立会话＋同名 bash 包装可创建', false, { error: String(err) })
  process.exit(1)
}
void mkSession

const texts = (s) => new Promise((resolve) => {
  const acc = []
  s.subscribe((e) => {
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      acc.push((e.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''))
    }
    if (e.type === 'turn_end') resolve([...acc])
  })
  setTimeout(() => resolve([...acc]), 20_000)
})

// C1＋C2：会话 A 首轮——模型请求里的 bash 定义是我们的；调用走包装不落真 shell
toolDefs.length = 0
setScript([{ toolCall: { name: 'bash', args: { command: 'echo HI' } } }, { text: 'A1_DONE' }])
await sessionA.prompt('调用 bash')
const defA = toolDefs[0]
const wrappedDef = Boolean(defA && String(defA.description ?? '').includes('HEMI_WRAPPED_BASH_A'))
record('C2-override', '同名注册顶掉内置：模型请求里 bash 描述是我们的标记，执行走包装（返回标记串而非真 shell 输出）',
  wrappedDef && factoryStateA.calls === 1 && factoryStateA.lastInput?.command === 'echo HI',
  { desc: defA?.description?.slice(0, 60), callsA: factoryStateA.calls, note: '结果文本 wrapped:A:*（内置不会产出）' })

// C3：hook 仍可拦截同名工具
let blockedEndText = ''
{
  const acc = []
  sessionA.subscribe((e) => { if (e.type === 'tool_execution_end') acc.push(JSON.stringify(e.result?.content ?? '')) })
  setScript([{ toolCall: { name: 'bash', args: { command: 'BLOCKED: rm -rf /' } } }, { text: 'A2_DONE' }])
  const before = factoryStateA.calls
  await sessionA.prompt('再调一次 bash（被拦）')
  record('C3-hook-block', 'tool_call hook 对同名工具 block：execute 未跑，结果带拒绝理由',
    factoryStateA.calls === before && acc.some((t) => t.includes('blocked by 042 probe gate')),
    { callsA: factoryStateA.calls, ends: acc })
}

// C5：hook 返回 { input } 是否改写参数
{
  setScript([{ toolCall: { name: 'bash', args: { command: 'REWRITE: normalize/me' } } }, { text: 'A3_DONE' }])
  await sessionA.prompt('再调一次 bash（改写）')
  const rewritten = factoryStateA.lastInput?.command === 'REWRITTEN: normalize/me'
  if (rewritten) record('C5-hook-rewrite', 'tool_call hook 返回 { input } 可改写参数（归一化可放 hook）', true, factoryStateA.lastInput)
  else record('C5-hook-rewrite', 'hook 不支持 { input } 改写 → FACT：参数归一化必须放工具包装层（本探针结论同样可用）',
    factoryStateA.lastInput?.command === 'REWRITE: normalize/me', factoryStateA.lastInput)
}

// C4：会话 B 同名工具闭包独立
{
  const callsABefore = factoryStateA.calls
  setScript([{ toolCall: { name: 'bash', args: { command: 'echo B' } } }, { text: 'B1_DONE' }])
  await sessionB.prompt('调用 bash')
  const defB = toolDefs[toolDefs.length - 1]
  record('C4-session-isolation', '两会话同名 bash 互不串扰（B 的定义带 B 标记、A 的计数不变）',
    String(defB?.description ?? '').includes('HEMI_WRAPPED_BASH_B') && factoryStateB.calls === 1 && factoryStateA.calls === callsABefore,
    { callsA: factoryStateA.calls, callsABefore, callsB: factoryStateB.calls, descB: defB?.description?.slice(0, 40) })
}

server.close()
const fails = findings.filter((f) => !f.ok)
console.log(`\nP0-4 结果：${findings.length - fails.length}/${findings.length} 通过${fails.length ? '，存在 FAIL' : ''}`)
process.exit(fails.length ? 1 : 0)
