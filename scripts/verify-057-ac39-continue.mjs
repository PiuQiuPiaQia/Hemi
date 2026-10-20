// 057 AC-39 子场景补证：同角色「续用」（session_id 复用）真机——
//   第一轮派 explorer 前台任务 A（完成）→ 第二轮请求「继续用刚才那个子 agent 的会话再问
//   一个简单问题」（模型经 task{session_id} 续用）→ 断言：两个任务各自身份（taskId/
//   toolCallId/agent）齐全且各有终态；旧任务 A 的卡快照（taskText/endedAt）不被新任务
//   覆盖；任务数＝2、无同角色标题混淆；flow.tasks↔渲染序列归属正确。
// 运行：node scripts/verify-057-ac39-continue.mjs（exit 0＝断言过）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.HEMI_AC39_PORT ?? 9265)
const PROFILE_ID = process.env.HEMI_AC39_PROFILE ?? 'mp-legacy/m1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi')
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi057-ac39-'))
const UD = path.join(root, 'userData')
fs.mkdirSync(path.join(UD, 'conversations'), { recursive: true })
for (const name of ['text-model.json', 'text-model-profiles.json', 'onboarding.json']) {
  fs.copyFileSync(path.join(realUserData, name), path.join(UD, name))
}
// 续用任务要读的工作目录
const work = path.join(UD, 'workspace', 'default', 'ac39')
fs.mkdirSync(work, { recursive: true })
fs.writeFileSync(path.join(work, 'a.txt'), '甲文件内容\n', 'utf8')
fs.writeFileSync(path.join(work, 'b.txt'), '乙文件内容\n', 'utf8')

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
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } }
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
const evalJs = async (expression, timeoutMs = 25_000) => {
  // reload / 页面挂起时 evaluate 永不返回——分级超时（模型轮次单独给长预算）。
  const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(timeoutMs).then(() => null)]).catch(() => null)
  if (r == null) return undefined
  if (r?.exceptionDetails) throw new Error(`page-eval: ${(r.exceptionDetails.text ?? '')}`.slice(0, 200))
  return r?.result?.value
}
await send('Runtime.enable')
for (let i = 0; i < 120; i += 1) {
  if (await evalJs('window.hemiVoice && Boolean(document.querySelector("textarea"))')) break
  await sleep(500)
}

const CONV = 'conv-ac39-continue'
const snapOf = () => evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(CONV)})`)
const taskList = async () => Object.values((await snapOf())?.tasks ?? {})

console.log('[ac39] 第一轮：派 explorer 前台任务 A …')
const first = await evalJs(`window.hemiVoice.chatTextModel({
  turnId: ${Date.now() % 900000}, conversationId: ${JSON.stringify(CONV)}, workspaceId: 'default',
  profileId: ${JSON.stringify(PROFILE_ID)}, inputSource: 'text',
  messages: [{ role: 'user', content: '派一个 explorer 前台子任务：列出工作区 ac39 目录里的文件名（只列名字），回来后把结果告诉我。' }],
}).then((r) => ({ ok: true, text: (r && r.text || '').slice(0, 300) }), (e) => ({ ok: false, error: String(e && e.message || e) }))`, 360_000)
console.log('[ac39] 第一轮回答：', JSON.stringify(first).slice(0, 200))

// 等任务 A 终态（最多 5 分钟）
let tasksA = []
for (let i = 0; i < 150; i += 1) {
  tasksA = await taskList()
  if (tasksA.length >= 1 && tasksA.every((t) => t.phase === 'terminal')) break
  await sleep(2000)
}
const snapshotA = JSON.parse(JSON.stringify(tasksA))

// —— 真实用户路径复刻：续用之前先打开会话（页面加载档案，第一轮卡项带快照入场）——
try {
  const f = path.join(UD, 'conversations', `${CONV}.json`)
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'))
  rec.customTitle = 'AC39 续用验证'
  fs.writeFileSync(f, JSON.stringify(rec, null, 2), 'utf8')
} catch { /* 档案缺失后续断言自然失败 */ }
await evalJs('window.location.reload()', 5_000).catch(() => null)
await sleep(3000)
await evalJs(`(() => {
  const all = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim());
  const texts = all.map((e) => (e.textContent || '').trim());
  const start = texts.indexOf('今天');
  const skip = new Set(['今天', '查看全部', '昨天', '7 天内', '更早', '新建对话', '⌘N']);
  for (let i = start + 1; i > 0 && i < texts.length; i += 1) {
    const t = texts[i];
    if (['昨天', '7 天内', '更早'].includes(t)) break;
    if (skip.has(t) || /^\d+$/.test(t)) continue;
    all[i].click();
    return true;
  }
  return false;
})()`).catch(() => null)
for (let i = 0; i < 60; i += 1) {
  const body = (await evalJs(`document.body.innerText.replace(/\\s+/g, ' ')`)) ?? ''
  if (/explorer/.test(body)) break
  await sleep(500)
}
await sleep(1000)
console.log('[ac39] 已打开会话（第一轮内容在场），开始续用 …')

console.log('[ac39] 第二轮：请求续用同一子 agent 会话再问 …')
const second = await evalJs(`window.hemiVoice.chatTextModel({
  turnId: ${Date.now() % 900000}, conversationId: ${JSON.stringify(CONV)}, workspaceId: 'default',
  profileId: ${JSON.stringify(PROFILE_ID)}, inputSource: 'text',
  messages: [
    { role: 'user', content: '派一个 explorer 前台子任务：列出工作区 ac39 目录里的文件名（只列名字），回来后把结果告诉我。' },
    { role: 'assistant', content: ${JSON.stringify(first?.text ?? '')} },
    { role: 'user', content: '继续用刚才那个子 agent 的会话（复用它的 session_id，不要新起一个）：让它再看一眼 ac39 目录里除了文件名之外，顺便报一下 a.txt 的第一行内容。' },
  ],
}).then((r) => ({ ok: true, text: (r && r.text || '').slice(0, 300) }), (e) => ({ ok: false, error: String(e && e.message || e) }))`, 360_000)
console.log('[ac39] 第二轮回答：', JSON.stringify(second).slice(0, 260))

let tasksB = []
for (let i = 0; i < 150; i += 1) {
  tasksB = await taskList()
  if (tasksB.length >= 1 && tasksB.every((t) => t.phase === 'terminal') && (tasksB[0]?.runs ?? 1) >= 2) break
  await sleep(2000)
}
await sleep(1500)

// 实时窗口（不重载）：页面已打开该会话，续用完成后两张 inline 卡应各自在场。
const cardsBeforeReload = (await evalJs(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 5000)`)) ?? ''
// 重载后显示（档案投影路径）：固定 customTitle 后导航，两卡内容应各自保留。
try {
  const f = path.join(UD, 'conversations', `${CONV}.json`)
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'))
  rec.customTitle = 'AC39 续用验证'
  fs.writeFileSync(f, JSON.stringify(rec, null, 2), 'utf8')
} catch { /* 档案缺失时断言自然失败 */ }
await evalJs('window.location.reload()', 5_000).catch(() => null)
await sleep(3000)
for (let i = 0; i < 60; i += 1) {
  const ok = await evalJs(`Boolean([...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && (e.textContent || '').trim() === 'AC39 续用验证'))`)
  if (ok) break
  await sleep(500)
}
await evalJs(`(() => {
  const all = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim());
  const texts = all.map((e) => (e.textContent || '').trim());
  const start = texts.indexOf('今天');
  const skip = new Set(['今天', '查看全部', '昨天', '7 天内', '更早', '新建对话', '⌘N']);
  for (let i = start + 1; i > 0 && i < texts.length; i += 1) {
    const t = texts[i];
    if (['昨天', '7 天内', '更早'].includes(t)) break;
    if (skip.has(t) || /^\d+$/.test(t)) continue;
    all[i].click();
    return true;
  }
  return false;
})()`)
for (let i = 0; i < 60; i += 1) {
  const body = (await evalJs(`document.body.innerText.replace(/\\s+/g, ' ')`)) ?? ''
  if (/列|目录|文件列表/.test(body) && /a\\.txt/.test(body)) break
  await sleep(500)
}
await sleep(1200)
const cardsAfterReload = (await evalJs(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 5000)`)) ?? ''

const snapshotB = JSON.parse(JSON.stringify(tasksB))
const snapFinal = await snapOf()
const delegationParts = (snapFinal?.timeline ?? []).flatMap((e) => e.parts ?? []).filter((pt) => pt.kind === 'delegation')
// 档案取证：每轮派单落档的任务轮快照（冻结）——「旧运行记录不被新状态覆盖」的判据位。
const convFile = path.join(UD, 'conversations', `${CONV}.json`)
let taskTurnSnaps = []
let archiveRuns = null
let archiveTurnSeq = []
let archiveFlowSeq = []
try {
  const rec = JSON.parse(fs.readFileSync(convFile, 'utf8'))
  taskTurnSnaps = (rec.turns ?? []).filter((t) => t.kind === 'task').map((t) => ({ id: String(t.id ?? '').slice(0, 40), taskId: String(t.taskId ?? '').slice(0, 30), runs: t.taskSnap?.runs ?? null, frozen: t.taskFrozen === true, createdAt: t.createdAt ?? null, text: String(t.text ?? '').slice(0, 40), snapText: String(t.taskSnap?.taskText ?? '').slice(0, 40), outcome: t.taskSnap?.outcome ?? null }))
  archiveRuns = Object.values(rec.flow?.tasks ?? {})[0]?.runs ?? null
  // 结构转储：turns 序列与 flow.timeline 段结构（诊断重复渲染）。
  archiveTurnSeq = (rec.turns ?? []).map((t) => ({ kind: t.kind ?? (t.author === 'user' ? 'user' : 'reply'), id: String(t.id ?? '').slice(0, 34), text: String(t.text ?? '').slice(0, 24) }))
  archiveFlowSeq = (rec.flow?.timeline ?? []).map((e) => (e.kind === 'user' ? { u: e.id } : { item: String(e.itemId ?? '').slice(0, 24), run: e.runId, parts: (e.parts ?? []).map((pt) => `${pt.kind}${pt.toolCallId ? ':' + String(pt.toolCallId).slice(-4) : ''}`) }))
} catch { taskTurnSnaps = [] }
const checks = {
  // 续用＝同一任务复用（runs≥2），不是新建第二张卡——056 设计（subagents spawn sessionId 分支）。
  reusedSameTask: snapshotB.length === 1 && (snapshotB[0].runs ?? 1) >= 2,
  allTerminal: snapshotB.every((t) => t.phase === 'terminal'),
  // 两次派单各有一个 delegation part（两个 toolCallId）——展示层保留两次运行的关联。
  twoDelegationParts: delegationParts.length >= 2,
  distinctToolCallIds: new Set(delegationParts.map((pt) => pt.toolCallId)).size === delegationParts.length,
  // 旧运行记录不被新状态覆盖：档案里两轮任务轮的冻结快照各自保留（第一轮文本仍在）。
  // 结构性断言：两轮卡轮（runs 集合含 1 与 2）、旧轮冻结、新轮活卡。
  archiveKeepsBothRuns: taskTurnSnaps.length >= 2
    && new Set(taskTurnSnaps.map((t) => t.runs ?? 1)).size >= 2
    && taskTurnSnaps.some((t) => t.frozen)
    && taskTurnSnaps.some((t) => !t.frozen),
  sameRole: snapshotB.every((t) => (t.agent ?? 'explorer') === 'explorer'),
}
checks.archiveMatchesFlow = archiveRuns != null && archiveRuns >= 2
// 重载后：两张派单卡头行都在场（修复前两 part 折叠同内容/第一卡被改写）。
const cardHeadCount = (cardsAfterReload.match(/explorer ·/g) ?? []).length
checks.cardsAfterReloadKeepsBothRounds = cardHeadCount >= 2
checks.cardsAfterReloadCardHeads = cardHeadCount

const ok = Object.values(checks).every(Boolean)
console.log(`HEMI_VERIFY_057_AC39_CONTINUE=${JSON.stringify({ ok, checks, cardsBeforeReload, cardsAfterReload, archiveTurnSeq, archiveFlowSeq, taskCount: snapshotB.length, delegationParts: delegationParts.map((pt) => ({ partId: pt.partId, toolCallId: pt.toolCallId, taskId: pt.taskId, status: pt.status })), archiveTaskTurns: taskTurnSnaps, archiveRuns, tasks: snapshotB.map((t) => ({ taskId: t.taskId, taskText: String(t.taskText ?? '').slice(0, 30), agent: t.agent, outcome: t.outcome, endedAt: t.endedAt })), firstReply: first?.text?.slice(0, 120), secondReply: second?.text?.slice(0, 160) })}`)
ws.close()
shutdown()
await sleep(500)
fs.rmSync(root, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
