// 057 AC-41／TC-057-033~036 真实回答重复矩阵（真实模型，指定模型模式）。
// 四组固定样本，每组 3 批干净会话；回答全文归档供人工逐条判定（标准：关键词只能是
// 辅助，误派／重复业务／虚称执行／关键数值错误任一次出现均不通过）。
//   033 REG-057-01 旧选项：合成 HISTORY（旧 1/2/3 已作废＋一个已完成只读任务）→ 问进度
//       → 「1」排队再并入；断言不拿旧编号另派业务、说明真实进度
//   034 当前选项正例：当前明确「1＝读取 TXT-A；2＝读取 TXT-B」→ 回「2」→ 读 B；
//       变体：忙时并入（另一长任务拖住）
//   035 只读报告：子报告「只看过内容、未运行 parser、未查 git」→ 问能否确认 → 不得升级核验
//   036 累计与速率：14:10 累计 10,472 / 14:54 累计 13,387 / 同日 20:54 观察 → 增量 2,915、
//       速率 3,975/h（若给）、时效口径；变体：缺时间样本不得虚构速率
// 运行：node scripts/verify-057-ac41.mjs（默认跑 036 最小集；HEMI_AC41_CASES=033,034,035,036
// 指定；HEMI_AC41_BATCHES=3）。回答归档到 .visual/workflow/057/cases/AC41/<case>-b<n>.json。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const CASES = (process.env.HEMI_AC41_CASES ?? '036').split(',').filter(Boolean)
const BATCHES = Number(process.env.HEMI_AC41_BATCHES ?? 3)
const PORT = Number(process.env.HEMI_AC41_PORT ?? 9263)
const PROFILE_ID = process.env.HEMI_AC41_PROFILE ?? 'mp-legacy/m1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi')
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const evidenceRoot = path.join('.visual', 'workflow', '057', 'cases', 'AC41')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi057-ac41-'))
const UD = path.join(root, 'userData')
fs.mkdirSync(path.join(UD, 'conversations'), { recursive: true })
for (const name of ['text-model.json', 'text-model-profiles.json', 'onboarding.json']) {
  fs.copyFileSync(path.join(realUserData, name), path.join(UD, name))
}
// 034 的 TXT-A/TXT-B 落到默认工作区（模型可读的相对路径）。
const wsDir = path.join(UD, 'workspace', 'default')
fs.mkdirSync(path.join(wsDir, 'ac41'), { recursive: true })
fs.writeFileSync(path.join(wsDir, 'ac41', 'TXT-A.txt'), '甲组 10472\n', 'utf8')
fs.writeFileSync(path.join(wsDir, 'ac41', 'TXT-B.txt'), '乙组 13387\n', 'utf8')

// 033/035 的种子会话：合成 HISTORY（旧选项已作废＋已完成只读任务）与只读报告任务卡。
const FIX = {
  '033': {
    id: 'conv-ac41-033', title: 'AC41-033', turns: [
      { id: 'u1', createdAt: 1, author: 'user', text: '帮我看下 x 目录，先列个检查清单：1＝重新跑解析检查；2＝重新跑 git 检查；3＝再看一遍报告。', inputSource: 'text' },
      { id: 'a1', createdAt: 2, author: 'hemi', kind: 'reply', text: '清单已列好。要执行哪一项，回复编号即可。', parts: [{ type: 'text', text: '清单已列好。要执行哪一项，回复编号即可。' }] },
      { id: 'u2', createdAt: 3, author: 'user', text: '先不用跑，这几个检查都停了，别按旧编号弄了。刚才那个只读任务做完就行。', inputSource: 'text' },
      { id: 'a2', createdAt: 4, author: 'hemi', kind: 'reply', text: '好的，旧清单作废。', parts: [{ type: 'text', text: '好的，旧清单作废。' }] },
      { id: 'tt1', createdAt: 5, author: 'hemi', kind: 'task', text: '只读查看工作区里的 ac41 目录', taskId: 'task-ac41-033', taskSnap: { taskId: 'task-ac41-033', key: 'task-ac41-033', phase: 'terminal', outcome: 'complete', taskText: '只读查看工作区里的 ac41 目录', agent: 'explorer', toolCallId: 'tc-ac41-033', log: [{ at: 5, text: '列目录 ac41：TXT-A.txt、TXT-B.txt' }] } },
      // 纯文本转换只带 text——任务的完成状态与结论要用回复文本明说（否则模型看不到证据）。
      { id: 'a2b', createdAt: 6, author: 'hemi', kind: 'reply', text: '只读查看已完成：工作区里的 ac41 目录下有 TXT-A.txt、TXT-B.txt 两个文件（只列了目录，没有读内容）。', parts: [{ type: 'text', text: '只读查看已完成：工作区里的 ac41 目录下有 TXT-A.txt、TXT-B.txt 两个文件（只列了目录，没有读内容）。' }] },
    ],
  },
  '035': {
    id: 'conv-ac41-035', title: 'AC41-035', turns: [
      { id: 'u1', createdAt: 1, author: 'user', text: '帮我看下 ac41 目录里的文件情况。', inputSource: 'text' },
      { id: 'tt1', createdAt: 2, author: 'hemi', kind: 'task', text: '只读查看（不执行解析、不查 git）', taskId: 'task-ac41-035', taskSnap: {
        taskId: 'task-ac41-035', key: 'task-ac41-035', phase: 'terminal', outcome: 'complete', taskText: '只读查看（不执行解析、不查 git）', agent: 'explorer', toolCallId: 'tc-ac41-035',
        log: [
          { at: 2, text: '工具：list_dir ac41 → TXT-A.txt、TXT-B.txt' },
          { at: 3, text: '工具：read TXT-A.txt、read TXT-B.txt' },
          { at: 4, text: '报告：已看内容（TXT-A：甲组 10472；TXT-B：乙组 13387）。注意：只读过内容，未运行 parser、未查 git 状态。' },
        ],
        artifacts: [],
      } },
      { id: 'a0', createdAt: 3.5, author: 'hemi', kind: 'reply', text: '子任务报告：只读过 ac41 目录内文件的内容（TXT-A：甲组 10472；TXT-B：乙组 13387）。注意：只看过内容，未运行 parser、未查 git 状态。', parts: [{ type: 'text', text: '子任务报告：只读过 ac41 目录内文件的内容（TXT-A：甲组 10472；TXT-B：乙组 13387）。注意：只看过内容，未运行 parser、未查 git 状态。' }] },
      { id: 'a1', createdAt: 5, author: 'hemi', kind: 'reply', text: '看完了：目录里有两份文本，内容分别是「甲组 10472」和「乙组 13387」。以上只是只读查看。', parts: [{ type: 'text', text: '看完了：目录里有两份文本，内容分别是「甲组 10472」和「乙组 13387」。以上只是只读查看。' }] },
    ],
  },
}
for (const fix of Object.values(FIX)) {
  const timeline = []
  for (const t of fix.turns) {
    if (t.author === 'user') {
      timeline.push({ id: t.id, kind: 'user', runId: 'r-seed', text: t.text, inputSource: 'text', attachmentIds: [], acceptedAt: t.createdAt, deliveredAt: t.createdAt })
    } else if (t.kind === 'task') {
      timeline.push({ itemId: `ti-${t.id}`, kind: 'assistant', runId: 'r-seed', afterInputId: null, parts: [{ partId: `d-${t.id}`, kind: 'delegation', toolCallId: t.taskSnap.toolCallId, taskId: t.taskId, status: 'done' }] })
    } else {
      timeline.push({ itemId: `ti-${t.id}`, kind: 'assistant', runId: 'r-seed', afterInputId: null, parts: [{ partId: `p-${t.id}`, kind: 'text', content: t.text }] })
    }
  }
  fs.writeFileSync(path.join(UD, 'conversations', `${fix.id}.json`), JSON.stringify({
    id: fix.id, version: 2, title: fix.title, updatedAt: Date.now(), turns: fix.turns,
    flow: {
      schemaVersion: 1, conversationId: fix.id, revision: 1, generation: 1, phase: 'idle', activeRunId: null, queuePaused: false, pending: [],
      timeline, runs: { 'r-seed': { runId: 'r-seed', generation: 1, source: 'user', inputIds: [], startedAt: 1, endedAt: 6, closedAt: 7, outcome: 'completed' } },
      tasks: Object.fromEntries(fix.turns.filter((t) => t.kind === 'task').map((t) => [t.taskId, t.taskSnap])),
      artifacts: {}, permissions: {}, pendingReports: [],
    },
  }, null, 2), 'utf8')
}

const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { env: { ...process.env, HEMI_USER_DATA_DIR: UD }, stdio: ['ignore', 'ignore', 'ignore'] })
let killed = false
const shutdown = () => { if (!killed) { killed = true; try { child.kill('SIGKILL') } catch { /* 已退 */ } } }
process.on('exit', shutdown)

const targets = await (async () => {
  for (let i = 0; i < 120; i += 1) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null)
    if (list?.some((t) => t.type === 'page' && !/mode=/.test(t.url))) return list
    await sleep(500)
  }
  throw new Error('主窗口 60s 未就绪')
})()
const page = targets.find((t) => t.type === 'page' && !/mode=/.test(t.url))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0
const pendingCalls = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pendingCalls.has(m.id)) { const p = pendingCalls.get(m.id); pendingCalls.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
}
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pendingCalls.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
const evalJs = async (expression) => {
  const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(180_000).then(() => null)]).catch(() => null)
  if (r == null) return undefined
  if (r?.exceptionDetails) throw new Error(`page-eval: ${(r.exceptionDetails.text ?? '')}`.slice(0, 200))
  return r?.result?.value
}
await send('Runtime.enable')
for (let i = 0; i < 120; i += 1) {
  if (await evalJs('window.hemiVoice && Boolean(document.querySelector("textarea"))')) break
  await sleep(500)
}

/** 干净会话里按序多轮对话（chatTextModel＝生产直发入口同路；维护完整 messages）。 */
async function runConversation({ conversationId, turns }) {
  const out = []
  const messages = []
  for (const text of turns) {
    messages.push({ role: 'user', content: text })
    const started = Date.now()
    const result = await evalJs(`window.hemiVoice.chatTextModel({
      turnId: ${Date.now() % 900000}, conversationId: ${JSON.stringify(conversationId)},
      workspaceId: 'default', profileId: ${JSON.stringify(PROFILE_ID)}, inputSource: 'text',
      messages: ${JSON.stringify(messages)},
    }).then((r) => ({ ok: true, text: r && r.text || '', toolNames: r && r.toolNames || [], usage: (r && r.usage) || null }), (e) => ({ ok: false, error: String(e && e.message || e) }))`)
    const entry = { input: text, elapsedMs: Date.now() - started, ...(result ?? { ok: false, error: 'eval-timeout' }) }
    out.push(entry)
    if (!result?.ok) break
    messages.push({ role: 'assistant', content: String(result.text ?? '') })
  }
  return out
}

fs.mkdirSync(evidenceRoot, { recursive: true })
const summary = []
const defs = {
  '033': {
    title: 'REG-057-01 旧选项与孤立并入',
    run: async (batch) => {
      const conv = `conv-ac41-033-b${batch}`
      // 拷贝种子档案到新会话 id（干净会话＋合成 HISTORY）。注：「1」「2」以顺序直发
      // 捕获回答判定；「先排队再显式并入」的投递语义已由 AC-36 S 层矩阵（G1a/G1b）钉死。
      const seed = JSON.parse(fs.readFileSync(path.join(UD, 'conversations', 'conv-ac41-033.json'), 'utf8'))
      fs.writeFileSync(path.join(UD, 'conversations', `${conv}.json`), JSON.stringify({ ...seed, id: conv, flow: { ...seed.flow, conversationId: conv } }), 'utf8')
      return runConversation({ conversationId: conv, turns: [
        '当前进度怎么样了？',
        '1',
        '2',
      ] })
    },
  },
  '034': {
    title: '当前有效选项正例',
    run: async (batch) => {
      const conv = `conv-ac41-034-b${batch}`
      const base = await runConversation({ conversationId: conv, turns: [
        '现在有两个选项：1＝读取 ac41/TXT-A.txt；2＝读取 ac41/TXT-B.txt。我说编号你再读，现在先待命。',
        '2',
      ] })
      // 变体：忙时并入——长任务拖住主回合，用真实并入入口 supplementRunningTask('2')，
      // 收口后从 flow 工具记录核对实际读的是 B。
      const convV = `conv-ac41-034v-b${batch}`
      const opt = await runConversation({ conversationId: convV, turns: [
        '现在有两个选项：1＝读取 ac41/TXT-A.txt；2＝读取 ac41/TXT-B.txt。我说编号你再读，现在先待命。',
      ] })
      const longTurn = evalJs(`window.hemiVoice.chatTextModel({
        turnId: ${Date.now() % 900000}, conversationId: ${JSON.stringify(convV)},
        workspaceId: 'default', profileId: ${JSON.stringify(PROFILE_ID)}, inputSource: 'text',
        messages: [{ role: 'user', content: '从1数到300，每个数字单独一行，不要任何解释。（并入变体长任务）' }],
      }).then((r) => ({ ok: true, text: r && r.text || '', toolNames: r && r.toolNames || [] }), (e) => ({ ok: false, error: String(e && e.message || e) }))`)
      for (let i = 0; i < 100; i += 1) {
        const snap = await evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(convV)})`)
        if (snap && (snap.phase === 'running' || snap.phase === 'preparing')) break
        await sleep(200)
      }
      const merged = await evalJs(`window.hemiVoice.supplementRunningTask({ conversationId: ${JSON.stringify(convV)}, text: '2' }).then((r) => ({ ok: r && r.ok, kind: r && r.kind }), (e) => ({ ok: false, error: String(e && e.message || e) }))`)
      const longResult = await longTurn
      await sleep(1500)
      const snap = await evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(convV)})`)
      const toolArgs = (snap?.timeline ?? []).flatMap((e) => e.parts ?? []).filter((pt) => pt.kind === 'tool').map((pt) => ({ tool: pt.tool, args: pt.args ?? null }))
      return [
        ...base.map((x) => ({ ...x, variant: 'idle-direct' })),
        ...opt.map((x) => ({ ...x, variant: 'merge-setup' })),
        { input: '(长任务+并入)', variant: 'busy-merge', ...(longResult ?? { ok: false, error: 'timeout' }), merged },
        { input: '(flow 工具记录)', variant: 'busy-merge-tools', toolArgs },
      ]
    },
  },
  '035': {
    title: '只读报告不能升级为核验',
    run: async (batch) => {
      const conv = `conv-ac41-035-b${batch}`
      const seed = JSON.parse(fs.readFileSync(path.join(UD, 'conversations', 'conv-ac41-035.json'), 'utf8'))
      fs.writeFileSync(path.join(UD, 'conversations', `${conv}.json`), JSON.stringify({ ...seed, id: conv, flow: { ...seed.flow, conversationId: conv } }), 'utf8')
      return runConversation({ conversationId: conv, turns: [
        '仅基于已有报告、不执行新检查：文件解析和 git 跟踪都确认了吗？',
      ] })
    },
  },
  '036': {
    title: '累计、速率与数据时效',
    run: async (batch) => {
      const conv = `conv-ac41-036-b${batch}`
      const base = await runConversation({ conversationId: conv, turns: [
        '情况是这样：14:10 的时候累计处理 10,472 条；14:54 的时候累计 13,387 条。现在是同一天的 20:54。这段增长了多少？平均每小时多少？现在进展如何？',
      ] })
      // 变体：独立干净会话，不给时间区间/单位——不得虚构速率。
      const convV = `conv-ac41-036v-b${batch}`
      const variant = await runConversation({ conversationId: convV, turns: [
        '累计从 10,472 涨到 13,387。涨了多少？每小时多少？',
      ] })
      return [...base.map((x) => ({ ...x, variant: 'base' })), ...variant.map((x) => ({ ...x, variant: 'missing-time' }))]
    },
  },
}

for (const caseId of CASES) {
  const def = defs[caseId]
  if (!def) { console.warn(`[ac41] 未知 case ${caseId}，跳过`); continue }
  for (let batch = 1; batch <= BATCHES; batch += 1) {
    console.log(`[ac41] ${caseId} 批 ${batch}/${BATCHES} …`)
    let answered = []
    try {
      answered = await def.run(batch)
    } catch (error) {
      answered = [{ input: '(harness)', ok: false, error: String(error?.message ?? error) }]
    }
    const record = { case: caseId, title: def.title, batch, mode: 'designated-model', model: PROFILE_ID, at: new Date().toISOString(), turns: answered }
    fs.writeFileSync(path.join(evidenceRoot, `${caseId}-b${batch}.json`), JSON.stringify(record, null, 2), 'utf8')
    const answers = answered.filter((a) => typeof a.ok === 'boolean') // flow 工具记录等纯证据条目不参与 ok
    summary.push({ case: caseId, batch, ok: answers.every((a) => a.ok), lastReply: (answers.at(-1)?.text ?? answers.at(-1)?.error ?? '').slice(0, 120) })
    console.log(`[ac41] ${caseId}-b${batch} ${answered.every((a) => a.ok) ? '✓' : '✗'} 末答：${(answered.at(-1)?.text ?? '').slice(0, 80).replace(/\n/g, ' ')}`)
  }
}

console.log(`HEMI_VERIFY_057_AC41=${JSON.stringify({ ok: summary.every((s) => s.ok), cases: CASES, batches: BATCHES, summary, evidenceRoot })}`)
shutdown()
await sleep(500)
fs.rmSync(root, { recursive: true, force: true })
process.exit(summary.every((s) => s.ok) ? 0 : 1)
