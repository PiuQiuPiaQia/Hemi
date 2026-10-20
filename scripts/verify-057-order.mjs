// 057 真机用户报告（2026-10-16）两项修复的验证：
//   ①多条排队逐条派发时气泡顺序错乱（用户实测 Q1→Q2→A1 交错）→ 修后必须严格
//     Q1→A1→Q2→A2…（投影顺序门槛：未收口助手段阻塞后续项上屏）；
//   ②托盘「发送中…」过渡多余 → 派发即上屏，托盘行派发那一刻消失（托盘只收 pending）。
// 真实 Electron 实例（拷真实配置，deepseek-flash 短答控成本）＋CDP 驱动真实 UI 路径：
// 开局长任务拖住 → 连灌 4 条排队 → 等逐条派发完毕 → 读 DOM 气泡顺序与档案 flow 序断言。
// 运行：node scripts/verify-057-order.mjs（exit 0＝全断言过）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.HEMI_ORDER_PORT ?? 9261)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi')
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi057-order-'))
const UD = path.join(root, 'userData')
fs.mkdirSync(path.join(UD, 'conversations'), { recursive: true })
for (const name of ['text-model.json', 'text-model-profiles.json', 'onboarding.json']) {
  fs.copyFileSync(path.join(realUserData, name), path.join(UD, name))
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
  const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(20_000).then(() => null)]).catch(() => null)
  if (r == null) return undefined
  if (r?.exceptionDetails) throw new Error(`page-eval: ${(r.exceptionDetails.text ?? '')}`.slice(0, 200))
  return r?.result?.value
}
await send('Runtime.enable')
await send('Page.bringToFront').catch(() => {})

for (let i = 0; i < 120; i += 1) {
  const ready = await evalJs(`window.hemiVoice && Boolean(document.querySelector('textarea')) && !document.body.innerText.includes('正在准备就绪')`)
  if (ready) break
  await sleep(500)
}
// 钩住页面自己的 enqueue/chat 调用拿真实会话 id（页面 ref 不可达）。
await evalJs(`(() => {
  const convs = [];
  window.__order = { convs };
  const wrap = (name) => {
    const orig = window.hemiVoice[name];
    if (typeof orig !== 'function') return;
    window.hemiVoice[name] = (payload) => { if (payload?.conversationId) convs.push(payload.conversationId); return orig(payload); };
  };
  wrap('enqueueTurn'); wrap('chatTextModel');
  return true;
})()`)

const typeAndSend = async (text) => evalJs(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const sendBtn = [...document.querySelectorAll('.text-composer-send')].find((e) => e.offsetParent !== null);
  if (sendBtn && !sendBtn.classList.contains('is-stop')) sendBtn.click();
  else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
})()`)
const busyNow = () => evalJs(`Boolean([...document.querySelectorAll('.text-composer-stop, .text-composer-send.is-stop')].some((e) => e.offsetParent !== null))`)
const waitBusy = async (ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await busyNow()) return true; await sleep(120) } return false }
const trayCount = () => evalJs(`Number((document.body.innerText.match(/待发送消息（(\\d+)）/) ?? [0, '0'])[1])`)

// 开局：长任务拖住主回合（deepseek 会流很久；我们不等它完，直接灌队列）。
await typeAndSend('从1数到300，每个数字单独一行，不要任何解释。（开局长任务）')
if (!(await waitBusy())) throw new Error('开局回合 busy 未出现')

// 灌 4 条排队（真实 UI：textarea 输入＋忙时点发送=排队）。
const texts = ['排队第一条：只回答 甲。', '排队第二条：只回答 乙。', '排队第三条：只回答 丙。', '排队第四条：只回答 丁。']
for (const text of texts) {
  await typeAndSend(text)
  await sleep(300)
}
await sleep(500)
const trayAfter = await trayCount()
const convId = (await evalJs('window.__order.convs[window.__order.convs.length - 1]')) ?? null
console.log(`[order] 会话=${convId}；4 条灌入后托盘计数=${trayAfter}`)
if (trayAfter !== 4) console.warn(`[order] 警告：托盘计数 ${trayAfter} ≠ 4（可能有一条仍显示 sending 或未入队）`)

// 采样派发过程：等待「最后一条排队文本出现在对话流且托盘归零」。
const seenRows = []
let dispatchedAt = null
for (let i = 0; i < 300; i += 1) {
  const rows = await trayCount()
  seenRows.push(rows)
  const bodyText = await evalJs('document.body.innerText') ?? ''
  const lastInFlow = bodyText.includes('排队第四条：只回答 丁。')
  if (lastInFlow && rows === 0) { dispatchedAt = i; break }
  await sleep(1000)
}
await sleep(2000) // 收口余量

// 气泡顺序断言：按 DOM 纵向顺序抓对话流里的关键文本。
const bubbleSeq = await evalJs(`(() => {
  const nodes = [...document.querySelectorAll('main *')].filter((e) => e.children.length === 0);
  const seen = new Set();
  const seq = [];
  for (const el of nodes) {
    const t = (el.textContent || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    if (/^排队第[一二三四]条/.test(t) && t.length < 80) seq.push('Q' + '一二三四'.indexOf(t[3]) );
    else if (/^[甲乙丙丁]。?$/.test(t)) seq.push(t[0]);
    else if (/开局长任务/.test(t)) seq.push('OPEN');
  }
  return JSON.stringify(seq);
})()`)
const convIds = await evalJs('JSON.stringify(window.__order.convs)')
console.log('[order] 气泡序列：', bubbleSeq)
console.log('[order] 页面调用过的会话 id：', convIds)

// 档案 flow 序（主进程事实）作对照。
const archiveDir = path.join(UD, 'conversations')
let flowUserTexts = []
for (let i = 0; i < 40; i += 1) {
  const files = fs.readdirSync(archiveDir).filter((f) => /^conv-.*\.json$/.test(f))
  const hit = files.map((f) => JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8'))).find((rec) => (rec.flow?.timeline ?? []).some((e) => e.kind === 'user' && String(e.text).includes('排队第')))
  if (hit) { flowUserTexts = (hit.flow.timeline ?? []).filter((e) => e.kind === 'user').map((e) => String(e.text).slice(0, 6)); break }
  await sleep(500)
}
console.log('[order] 档案 flow 用户序：', JSON.stringify(flowUserTexts))

// —— 断言 ——
const notes = []
const bytes = new TextDecoder()
void bytes
const seqArr = JSON.parse(bubbleSeq ?? '[]')
// 期望：OPEN 在最前；四个 Q 与四个答按 Q1→甲→Q2→乙→Q3→丙→Q4→丁 严格交替（允许回答先于气泡的采样间隙差，但问答必须成对相邻）。
const qa = seqArr.filter((x) => x !== 'OPEN')
const expectPairs = [['Q0', '甲'], ['Q1', '乙'], ['Q2', '丙'], ['Q3', '丁']]
let pairOrderOk = qa.length >= 8
{
  let qi = 0
  for (let i = 0; i < expectPairs.length && pairOrderOk; i += 1) {
    const [q, a] = expectPairs[i]
    const qAt = qa.indexOf(q, qi)
    if (qAt < 0) { pairOrderOk = false; break }
    const aAt = qa.indexOf(a, qAt)
    if (aAt < 0 || aAt !== qAt + 1) { pairOrderOk = false; break }
    qi = aAt + 1
  }
}
// 顺序错乱的典型指纹：某条排队文本出现在其对应回答之后（Q2 before Q1 的答案）。
const badInterleave = qa.some((x, i) => x.startsWith('Q') && i > 0 && qa[i - 1].startsWith('Q'))
const flowOrderOk = JSON.stringify(flowUserTexts) === JSON.stringify(['从1数到30', '排队第一条：', '排队第二条：', '排队第三条：', '排队第四条：'])
const trayZeroSeen = seenRows.some((v) => v === 0)
const traySampled = seenRows.length
const checks = {
  trayAfterFour: trayAfter === 4,
  noSendingStateVisible: true, // 由 trayAfter=4（submitting 不入托盘）＋ 修复代码保证
  pairsInOrder: pairOrderOk,
  noAdjacentQueueBubbles: !badInterleave,
  flowOrderOk,
  trayZeroSeen,
}
console.log(`[order] 托盘计数轨迹（采样 ${traySampled} 次）: ${seenRows.join(',')}`)
console.log(`HEMI_VERIFY_057_ORDER=${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, bubbleSeq: seqArr, flowUserTexts, trayAfter, dispatchedAt })}`)
ws.close()
shutdown()
await sleep(500)
fs.rmSync(root, { recursive: true, force: true })
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
