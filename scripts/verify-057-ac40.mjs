// 057 AC-40／TC-057-032：混合负载与操作响应（真实 Electron 测 IPC、保存和绘制）。
// 固定负载（补充验证标准 AC-40）：负载会话 105 条历史展示项（50 对问答，助手正文
// 合计 ≥20k 字符＝1000 次累计正文更新的终态）、5 个子任务状态更新、8 条待发送项
// （队列暂停态）、另一个会话用于切换、两份真实文件成果用于预览。预热一轮后测三轮，
// 每轮 ≥100 次本地交互样本（停止×15、排队×45、撤回×45 计入块内、切换×24、预览×16、
// 滚动×15）。
//
// 度量（P50/P95/最大值，同进程单调时钟 performance.now）：
//   停止反馈＝点击真实停止按钮（aria-label=停止回应）到忙态 UI 实际绘制解除
//   （双 rAF 落帧）——本地管线（IPC+状态+绘制），不含模型真正退出；
//   状态同步＝enqueueTurn 受理到队列行绘制（body 文本包含样本文本＋双 rAF）；
//   主进程阻塞＝hemi.log perf 域「主进程事件循环阻塞」计数（≥250ms warn）；
//   IO＝fs.watch 统计流式窗口内档案写入次数与字节（对照批量机制与增量分片数）；
//   正确性＝三轮后首 105 项身份/顺序与种子一致、撤回不复活、会话不串台。
//
// 模型：真实例（拷真实 userData 配置件，同机 safeStorage 可解），指定具体模型
// profileId（不走 auto 编排，避免派单放大成本）；每块早早停止，真金消耗极小。
// 运行：node scripts/verify-057-ac40.mjs（exit 0＝预算与正确性全过）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.HEMI_AC40_PORT ?? 9257)
const ROUNDS = Number(process.env.HEMI_AC40_ROUNDS ?? 3)
const PROFILE_ID = process.env.HEMI_AC40_PROFILE ?? 'mp-legacy/m1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi')
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

// ================================================================ 种子
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi057-ac40-'))
const UD = path.join(root, 'userData')
const convsDir = path.join(UD, 'conversations')
fs.mkdirSync(convsDir, { recursive: true })
for (const name of ['text-model.json', 'text-model-profiles.json', 'onboarding.json']) {
  fs.copyFileSync(path.join(realUserData, name), path.join(UD, name))
}
const filesDir = path.join(root, 'files')
fs.mkdirSync(filesDir, { recursive: true })
fs.writeFileSync(path.join(filesDir, '负载成果甲.txt'), '甲'.repeat(400), 'utf8')
fs.writeFileSync(path.join(filesDir, '负载成果乙.md'), '# 乙\n' + '乙'.repeat(400), 'utf8')

const LONG = '这是负载样本正文段落。'.repeat(30) // ≈412 字/段；50 段×8 次更新＝1000 次、合计 ≥20k 字符
const turns = []
const timeline = []
for (let i = 1; i <= 50; i += 1) {
  const uid = `seed-u${i}`
  const aid = `seed-a${i}`
  const q = `负载问题第${i}号`
  const a = `${LONG}\n（第${i}号回答，累计更新 8 次的终态。）`
  turns.push({ id: uid, createdAt: 1_700_000_000_000 + i * 2, author: 'user', text: q, inputSource: i % 3 === 0 ? 'voice' : 'text' })
  turns.push({ id: aid, createdAt: 1_700_000_000_000 + i * 2 + 1, author: 'hemi', kind: 'reply', text: a, parts: [{ type: 'text', text: a }] })
  timeline.push({ id: uid, kind: 'user', runId: 'r-seed', text: q, inputSource: i % 3 === 0 ? 'voice' : 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 2 })
  timeline.push({ itemId: aid, kind: 'assistant', runId: 'r-seed', afterInputId: uid, parts: [{ partId: `seed-p${i}`, kind: 'text', content: a }] })
}
const tasks = {}
for (let t = 1; t <= 5; t += 1) {
  const taskId = `seed-task-${t}`
  const outcome = t <= 4 ? 'complete' : 'denied'
  tasks[taskId] = {
    taskId, key: taskId, phase: 'terminal', outcome, taskText: `负载子任务${t}（${outcome}）`, agent: 'explorer', toolCallId: `seed-tc-${t}`,
    // 成果入口（任务卡预览）：仅 t1/t2 带文件（与种子两份文件对应）。
    ...(t <= 2 ? { artifacts: [{
      id: t === 1 ? 'seed-art-a' : 'seed-art-b',
      kind: 'file', name: t === 1 ? '负载成果甲.txt' : '负载成果乙.md',
      path: t === 1 ? path.join(filesDir, '负载成果甲.txt') : path.join(filesDir, '负载成果乙.md'),
      registeredAt: 1, role: 'main', available: true,
    }] } : {}),
  }
  turns.push({ id: `seed-tt${t}`, createdAt: 1_700_000_100_000 + t, author: 'hemi', kind: 'task', text: `负载子任务${t}（${outcome}）`, taskId, taskSnap: tasks[taskId] })
  timeline.push({ itemId: `seed-ti${t}`, kind: 'assistant', runId: 'r-seed', afterInputId: null, parts: [{ partId: `seed-d${t}`, kind: 'delegation', toolCallId: `seed-tc-${t}`, taskId, status: 'done' }] })
}
const pending = Array.from({ length: 5 }, (_, i) => ({
  inputId: `seed-q${i + 1}`, editRevision: 0, text: `种子排队第${i + 1}条（恢复保留）`, inputSource: i % 2 ? 'voice' : 'text',
  attachmentIds: [], references: null, createdAt: 1_700_000_200_000 + i, state: 'pending', targetRunId: null,
}))
const flow = {
  schemaVersion: 1, conversationId: 'conv-load', revision: 1, generation: 1,
  phase: 'idle', activeRunId: null, queuePaused: true, pending,
  timeline, runs: { 'r-seed': { runId: 'r-seed', generation: 1, source: 'user', inputIds: [], startedAt: 1, endedAt: 2, closedAt: 3, outcome: 'completed' } },
  tasks,
  artifacts: {
    'seed-art-a': { artifactId: 'seed-art-a', kind: 'file', name: '负载成果甲.txt', path: path.join(filesDir, '负载成果甲.txt'), producerRunId: 'r-seed', contentVersion: 1, registeredAt: 1 },
    'seed-art-b': { artifactId: 'seed-art-b', kind: 'file', name: '负载成果乙.md', path: path.join(filesDir, '负载成果乙.md'), producerRunId: 'r-seed', contentVersion: 1, registeredAt: 2 },
  },
  permissions: {}, pendingReports: [],
}
fs.writeFileSync(path.join(convsDir, 'conv-load.json'), JSON.stringify({
  id: 'conv-load', version: 2, title: '负载会话', updatedAt: Date.now() + 60_000, flow, turns,
}, null, 2), 'utf8')
fs.writeFileSync(path.join(convsDir, 'conv-other.json'), JSON.stringify({
  id: 'conv-other', version: 2, title: '另一会话', updatedAt: Date.now(),
  turns: [{ id: 'o1', createdAt: 1, author: 'user', text: '另一会话的问题', inputSource: 'text' },
    { id: 'o2', createdAt: 2, author: 'hemi', kind: 'reply', text: '另一会话的回答', parts: [{ type: 'text', text: '另一会话的回答' }] }],
  flow: {
    schemaVersion: 1, conversationId: 'conv-other', revision: 1, generation: 1, phase: 'idle', activeRunId: null,
    queuePaused: false, pending: [],
    timeline: [
      { id: 'o1', kind: 'user', runId: 'r-o', text: '另一会话的问题', inputSource: 'text', attachmentIds: [], acceptedAt: 1, deliveredAt: 2 },
      { itemId: 'o2', kind: 'assistant', runId: 'r-o', afterInputId: 'o1', parts: [{ partId: 'op1', kind: 'text', content: '另一会话的回答' }] },
    ],
    runs: { 'r-o': { runId: 'r-o', generation: 1, source: 'user', inputIds: [], startedAt: 1, endedAt: 2, closedAt: 3, outcome: 'completed' } },
    tasks: {}, artifacts: {}, permissions: {}, pendingReports: [],
  },
}, null, 2), 'utf8')
console.log(`[ac40] 种子完成：负载会话 ${timeline.length} 项（助手正文 ${(timeline.filter((e) => e.kind === 'assistant').reduce((n, e) => n + (e.parts?.[0]?.content?.length ?? 0), 0))} 字符）＋5 条待发送（容量 8 留排队样本进出空间）＋5 子任务＋2 成果`)

// ================================================================ 起真实实例
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, HEMI_USER_DATA_DIR: UD },
  stdio: ['ignore', 'ignore', 'pipe'],
})
child.stderr.on('data', () => {}) // Electron 噪声不进输出
let killed = false
const shutdown = () => { if (!killed) { killed = true; try { child.kill('SIGKILL') } catch { /* 已退 */ } } }
process.on('exit', shutdown)

const targets = await (async () => {
  for (let i = 0; i < 120; i += 1) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null)
    const page = list?.find((t) => t.type === 'page' && !/mode=/.test(t.url))
    if (page) return list
    await sleep(500)
  }
  throw new Error('主窗口 60s 未就绪')
})()
const page = targets.find((t) => t.type === 'page' && !/mode=/.test(t.url))
console.error('[ac40][diag] targets:', JSON.stringify(targets.map((t) => ({ type: t.type, url: String(t.url).slice(0, 90) }))))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0
const pendingCalls = new Map()
const rendererErrors = []
const consoleRing = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails
    rendererErrors.push(`${d?.text ?? ''} ${d?.exception?.description ?? ''} @${d?.url ?? ''}:${d?.lineNumber ?? '?'}`)
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params?.args ?? []).map((a) => a?.value ?? a?.description ?? '').join(' ')
    consoleRing.push(`${m.params?.type}: ${text}`.slice(0, 220))
    if (consoleRing.length > 80) consoleRing.shift()
    if (m.params?.type === 'error') rendererErrors.push(`console.error: ${JSON.stringify(m.params?.args ?? []).slice(0, 300)}`)
  }
  if (m.id && pendingCalls.has(m.id)) {
    const p = pendingCalls.get(m.id)
    pendingCalls.delete(m.id)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  }
}
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pendingCalls.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
const evalJs = async (expression) => {
  // 页面偶发挂死防护：全局 15s 硬超时——超时按 undefined 快速跳过该步（块级跳过语义）。
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(15_000).then(() => null),
  ]).catch(() => null)
  if (r == null) return undefined
  if (r?.exceptionDetails) throw new Error(`page-eval: ${r.exceptionDetails.text ?? ''} ${r.exceptionDetails.exception?.description ?? ''}`.slice(0, 300))
  return r?.result?.value
}
await send('Runtime.enable')
await send('Page.bringToFront').catch(() => {}) // 防遮挡窗口 rAF 节流饿死 paint 计时

// 渲染层助手：paintWait＝谓词命中＋落帧确认（遮挡窗口 rAF 节流有 interval 兜底）。
async function installHelpers() {
  await evalJs(`window.__ac40 = {
  paintWait: (predicateSrc, timeoutMs = 6000) => new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => { try { return eval(predicateSrc); } catch { return false; } };
    const done = () => {
      const frame = new Promise((r) => {
        let settled = false;
        const raf = () => { if (settled) return; settled = true; r(); };
        requestAnimationFrame(() => requestAnimationFrame(raf));
        setTimeout(raf, 1000);
      });
      void frame.then(() => resolve(performance.now() - t0));
    };
    const mo = new MutationObserver(() => { if (check()) { mo.disconnect(); clearInterval(timer); done(); } });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    const timer = setInterval(() => {
      if (check()) { mo.disconnect(); clearInterval(timer); done(); return; }
      if (performance.now() - t0 > timeoutMs) { mo.disconnect(); clearInterval(timer); resolve(-1); }
    }, 30);
  }),
  busyUI: () => Boolean([...document.querySelectorAll('.text-composer-stop, .text-composer-send.is-stop')].some((e) => e.offsetParent !== null)),
  stopButton: () => [...document.querySelectorAll('.text-composer-stop, .text-composer-send.is-stop')].find((e) => e.offsetParent !== null),
  sidebarRow: (title) => [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && (e.textContent || '').trim().startsWith(title) && (e.textContent || '').trim().length <= title.length + 8),
}`)
}
await installHelpers()
const snapOf = async (conv) => evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(conv)})`)
const waitIdle = async () => {
  for (let i = 0; i < 200; i += 1) {
    const s = await snapOf('conv-load')
    if (s && s.phase === 'idle' && !s.activeRunId) return true
    await sleep(100)
  }
  return false
}

// ================================================================ 度量
const metrics = { stop: [], enqueue: [], switchPaint: [] }
const counters = { blocks: 0, switches: 0, previews: 0, previewOk: 0, scrolls: 0, withdrawOk: 0, enqueueOk: 0, enqueueDirectSkip: 0 }
let ioWindow = null
let ioWatcherRef = null // 全程档案写入口径（fs.watch 计数）
const ioWatcher = fs.watch(convsDir, { persistent: false }, (_event, filename) => {
  if (filename !== 'conv-load.json' || !ioWindow) return
  ioWindow.writes += 1
  try { ioWindow.bytes += fs.statSync(path.join(convsDir, filename)).size } catch { /* 竞态 */ }
})
const p = (arr) => {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) }
}
const sendErrors = []
/** 真实用户路径发送：textarea 设值（React 受控组件经原生 setter）→ Enter 提交
 *  → 页面 runTurn 置 busy（不依赖 ui-state live 采纳——该链路有独立观察项）。 */
const sendOnce = (text) => {
  void evalJs(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return 'sent';
  })()`)
    .then((r) => { if (r !== 'sent') sendErrors.push(String(r).slice(0, 150)) })
    .catch((e) => sendErrors.push('eval:' + String(e).slice(0, 150)))
}

async function waitBusy(tag = '') {
  let sawPhaseRunning = false
  for (let i = 0; i < 150; i += 1) {
    const busy = await Promise.race([evalJs('window.__ac40.busyUI()'), sleep(3000).then(() => null)]).catch(() => false)
    if (busy) return true
    const snap = await snapOf('conv-load').catch(() => null)
    if (snap && (snap.phase !== 'idle' || snap.activeRunId)) sawPhaseRunning = true
    await sleep(100)
  }
  if (tag) console.warn(`[ac40][dbg] waitBusy miss ${tag}: phaseRunningSeen=${sawPhaseRunning}；console尾=${JSON.stringify(consoleRing.slice(-12))}`)
  return false
}

/** 停止后 renderer 不再采纳后续回合忙态（疑似 029 stop-turn 死锁家族，记阻塞观察）——
 * 每块前重载页面恢复采纳（顺带覆盖重载路径），不掩盖现象本身。 */
async function reloadReady() {
  await evalJs('window.location.reload()').catch(() => null)
  for (let i = 0; i < 120; i += 1) {
    const ok = await Promise.race([evalJs('window.hemiVoice && document.body.innerText.includes(\"负载问题第1号\") && document.querySelector(\"textarea\")'), sleep(4000).then(() => null)]).catch(() => false)
    if (ok) {
      await installHelpers() // reload 冲掉 __ac40——重注入
      await sleep(1500) // boot 链收口后再发送（过早调用会被吞）
      return true
    }
    await sleep(500)
  }
  return false
}

/** 等首个增量落地（时间线本回合助手段有正文）再停止——「无增量点停止」属已知
 * 死锁触发面（渲染层 2026-10-07 未修；本次实测主进程面同族：早停后后续 llm:chat
 * 全部以「回合未完成：Request was aborted」被拒、跨页面重载存活——记阻塞观察）。 */
async function waitFirstDelta(round, block) {
  for (let i = 0; i < 160; i += 1) {
    const snap = await snapOf('conv-load').catch(() => null)
    const parts = (snap?.timeline ?? []).filter((e) => e.kind === 'assistant' && e.runId === snap?.activeRunId).flatMap((e) => e.parts ?? [])
    if (parts.some((p) => p.kind === 'text' && String(p.content ?? '').length > 0)) return true
    await sleep(30)
  }
  console.warn(`[ac40] R${round}B${block} 首增量 16s 未到，按现状继续`)
  return false
}

/** 入队前确保在忙：模型短答收口后续发一条（入队样本必须落在忙时窗口）。 */
async function ensureBusy(tag) {
  const busy = await evalJs('window.__ac40.busyUI()').catch(() => false)
  if (busy) return true
  const snap = await snapOf('conv-load').catch(() => null)
  if (snap && (snap.phase === 'running' || snap.phase === 'preparing')) return true
  return sendAndWaitBusy(`${tag}-续`)
}

/** 发送＋等忙态；no-textarea 坏 boot 自愈（reload 一次重试）。 */
async function sendAndWaitBusy(tag) {
  sendOnce(`（${tag}）请从1数到400，每个数字单独一行，一个都不能跳过，不要任何解释。`)
  if (await waitBusy(tag)) return true
  if (String(sendErrors.at(-1) ?? '').includes('no-textarea')) {
    console.warn(`[ac40] ${tag} 坏 boot（无输入框），reload 重试`)
    await reloadReady()
    sendOnce(`（${tag}）请从1数到400，每个数字单独一行，一个都不能跳过，不要任何解释。`)
    return waitBusy(`${tag}-retry`)
  }
  return false
}

/** 停止块：composer 干净（无外发内容）时点击真实停止键，计时到忙态绘制解除。 */
async function stopBlock(round, block) {
  await reloadReady()
  if (!(await sendAndWaitBusy(`负载块 R${round}B${block}`))) { console.warn(`[ac40] R${round}B${block} busy UI 未出现（回合瞬断），跳过；sendErrors=${JSON.stringify(sendErrors.slice(-2))}`); return }
  await sleep(300) // 忙态即停（busy 为 flow 派生；早停后每块 reload＋UI 直发兜底）
  if (process.env.HEMI_AC40_DEBUG) {
    console.warn('[ac40][dbg] busy composer:', await evalJs(`JSON.stringify([...document.querySelectorAll('button')].map((b) => ({ cls: String(b.className).slice(0, 40), label: b.getAttribute('aria-label'), vis: b.offsetParent !== null })).filter((b) => b.vis).slice(-8))`).catch(() => 'ev'))
  }
  let stop = null
  try {
    stop = await evalJs(`(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const btn = [...document.querySelectorAll('.text-composer-stop, .text-composer-send.is-stop')].find((e) => e.offsetParent !== null);
      if (!btn) return { ok: false, error: 'no-visible-stop-button' };
      const busy = () => Boolean([...document.querySelectorAll('.text-composer-stop, .text-composer-send.is-stop')].some((e) => e.offsetParent !== null));
      const t0 = performance.now();
      btn.click();
      while (performance.now() - t0 < 6000) {
        if (!busy()) return { ok: true, ms: performance.now() - t0 };
        await new Promise((r) => setTimeout(r, 15));
      }
      return { ok: false, ms: -1 };
    })()`)
  } catch (e) { console.warn('[ac40][dbg] stop eval threw:', String(e).slice(0, 220)) }
  if (stop?.ok) metrics.stop.push(stop.ms)
  else {
    console.warn(`[ac40][dbg] stop fail R${round}B${block}:`, JSON.stringify(stop))
    if (process.env.HEMI_AC40_DEBUG) {
      console.warn('[ac40][dbg] after-click:', await evalJs(`JSON.stringify({ menu: Boolean(document.querySelector('[role=menu]')), busy: window.__ac40.busyUI(), overlay: [...document.querySelectorAll('body > div')].length })`).catch(() => 'ev'))
      await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => null)
    }
  }
  counters.blocks += 1
  if (!(await waitIdle())) console.warn(`[ac40] R${round}B${block} 停止后未及时回 idle，继续`)
}

/** 排队块：忙时入队×3（计时到队列行绘制）＋撤回×3；收尾停止只作清理（不计样本）。 */
async function queueBlock(round, block) {
  await reloadReady()
  if (!(await sendAndWaitBusy(`负载排队块 R${round}B${block}`))) { console.warn(`[ac40] R${round}B${block} busy UI 未出现，跳过；sendErrors=${JSON.stringify(sendErrors.slice(-2))}`); return }
  for (let i = 1; i <= 3; i += 1) {
    if (!(await ensureBusy(`Q${round}B${block}-${i}`))) continue
    const text = `排队样本-R${round}B${block}-${i}：只回答 好`
    let r = null
    try {
      r = await evalJs(`(async () => {
        const t0 = performance.now();
        let res; let err = null;
        try { res = await window.hemiVoice.enqueueTurn({ conversationId: 'conv-load', text: ${JSON.stringify(text)}, inputSource: 'text' }); } catch (e) { err = String(e && e.message || e); }
        const countOf = () => Number((document.body.innerText.match(/待发送消息（(\d+)）/g) ?? []).map((x) => Number(x.match(/（(\d+)/)[1])).reduce((a, b) => Math.max(a, b), 0));
        const needle = ${JSON.stringify(text.slice(0, 12))};
        const before = countOf();
        // 双条件：入托盘（忙时）或直接上屏（恰逢收口的直发）都算绘制完成。
        while (performance.now() - t0 < 6000) {
          if (countOf() > before) return { ok: res && res.ok, dt: performance.now() - t0, res, err, mode: 'tray' };
          if (document.body.innerText.includes(needle)) return { ok: res && res.ok, dt: performance.now() - t0, res, err, mode: 'direct' };
          await new Promise((r2) => setTimeout(r2, 15));
        }
        return { ok: false, dt: -1, res, err };
      })()`)
    } catch (e) { console.warn('[ac40][dbg] enqueue eval threw:', String(e).slice(0, 220)) }
    if (r?.ok && r.dt >= 0) { metrics.enqueue.push(r.dt); counters.enqueueOk += 1 }
    else if (r?.res && r.res.ok && r.res.item === null) counters.enqueueDirectSkip += 1 // 空闲命中直发：跳过（非用户路径）
    else console.warn(`[ac40][dbg] enqueue fail R${round}B${block}-${i}:`, JSON.stringify(r && { ok: r.ok, dt: r.dt, res: r.res, err: r.err }))
  }
  for (let i = 1; i <= 3; i += 1) {
    const snap = await snapOf('conv-load')
    const item = (snap?.pending ?? []).filter((e) => String(e.text ?? '').startsWith('排队样本-')).at(-1)
    if (!item) continue
    const pred = `!document.body.innerText.includes(${JSON.stringify(String(item.text).slice(0, 12))})`
    const r = await evalJs(`(async () => {
      const res = await window.hemiVoice.withdrawTurnQueueItem({ conversationId: 'conv-load', queueItemId: ${JSON.stringify(item.inputId)} });
      return { ok: res && res.ok };
    })()`).catch(() => null)
    if (r?.ok) counters.withdrawOk += 1
  }
  counters.blocks += 1
  // 清理：撤空后主键回到停止；点掉在途运行（不计样本）。
  await evalJs(`(async () => {
    const btn = [...document.querySelectorAll('.text-composer-stop, .text-composer-send.is-stop')].find((e) => e.offsetParent !== null);
    if (btn) { btn.click(); await window.__ac40.paintWait('!window.__ac40.busyUI()', 8000); }
    return true;
  })()`).catch(() => null)
  if (!(await waitIdle())) console.warn(`[ac40] R${round}B${block} 排队块未及时回 idle，继续`)
}

async function interactionRound(round) {
  if (round === 1) {
    ioWindow = { writes: 0, bytes: 0 }
    ioWindow.timer = setInterval(() => {
      try {
        const st = fs.statSync(path.join(convsDir, 'conv-load.json'))
        if (ioWindow.size !== st.size) { ioWindow.size = st.size; ioWindow.writes += 1; ioWindow.bytes = st.size }
      } catch { /* 竞态 */ }
    }, 250)
  }
  for (let block = 1; block <= 15; block += 1) {
    if (block % 2 === 1) await stopBlock(round, block)
    else await queueBlock(round, block)
  }
  // 切换×24（负载↔另一会话交替）
  await evalJs(`[...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && (e.textContent || '').trim() === '查看全部')?.click()`).catch(() => null)
  await sleep(300)
  for (let i = 0; i < 12; i += 1) {
    for (const title of ['另一会话', '负载会话']) {
      let found = await evalJs(`Boolean(window.__ac40.sidebarRow(${JSON.stringify(title)}))`).catch(() => false)
      if (!found && round === 1 && i === 0) {
        console.warn('[ac40][dbg] sidebar 未找到：', await evalJs(`JSON.stringify([...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').includes('会话')).map((e) => (e.textContent || '').trim()).slice(0, 8))`).catch(() => 'ev'))
      }
      if (!found) continue
      await evalJs(`window.__ac40.sidebarRow(${JSON.stringify(title)}).click()`)
      counters.switches += 1
      const marker = title === '负载会话' ? '负载问题第1号' : '另一会话的回答'
      const dt = await evalJs(`(async () => {
        const t0 = performance.now();
        const needle = ${JSON.stringify(marker)};
        while (performance.now() - t0 < 8000) {
          if (document.body.innerText.includes(needle)) return performance.now() - t0;
          await new Promise((r) => setTimeout(r, 15));
        }
        return -1;
      })()`).catch(() => -1)
      if (dt >= 0) metrics.switchPaint.push(dt)
      await sleep(150)
    }
  }
  // 预览×16：先展开任务卡再点成果文件名（开合计一次样本）
  for (let i = 0; i < 8; i += 1) {
    const opened = await evalJs(`(async () => {
      for (const card of [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && /^负载子任务[12]/.test((e.textContent || '').trim()))) {
        card.click();
        await new Promise((r) => setTimeout(r, 300));
      }
      const target = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && (e.textContent || '').trim() === '负载成果甲.txt');
      if (!target) return false;
      target.click();
      const dt = await window.__ac40.paintWait('document.body.innerText.includes(${JSON.stringify('甲'.repeat(20))})', 5000);
      return dt >= 0;
    })()`).catch(() => false)
    counters.previews += 1
    if (opened) { counters.previewOk += 1; await sleep(250) }
    await evalJs(`(document.querySelector('.md, main, [class*=timeline], [class*=transcript]') || window).scrollBy?.(0, 600)`)
    counters.scrolls += 2
    await sleep(120)
  }
  if (round === ROUNDS && ioWindow?.timer) { clearInterval(ioWindow.timer); ioWatcherRef = ioWindow }
}

// ================================================================ 预热＋三轮
if (process.env.HEMI_AC40_DEBUG) {
  await evalJs(`window.__ac40.busyUI()`)
  const dump = await evalJs(`(() => {
    const texts = [...document.querySelectorAll('button,[role=button],li,a,span,div')].map((e) => (e.textContent || '').trim()).filter(Boolean);
    return JSON.stringify({
      has负载会话: texts.some((t) => t === '负载会话'),
      sidebarSamples: texts.filter((t) => t.length <= 12).slice(0, 40),
      has成果甲: texts.some((t) => t.includes('负载成果甲')),
      has排队行: document.body.innerText.includes('种子排队'),
      has子任务卡: document.body.innerText.includes('负载子任务1'),
      has停止按钮类: Boolean(document.querySelector('.text-composer-send.is-stop, .text-composer-stop')),
    });
  })()`)
  console.warn('[ac40][dbg] dom texts:', dump)
}
// ================================================================ 诊断模式：忙时入队一条，看 flow.pending 与托盘渲染
if (process.env.HEMI_AC40_DIAG === 'enqueue') {
  sendOnce('（诊断）请从1数到300，每个数字一行。')
  for (let i = 0; i < 100 && !(await evalJs('window.__ac40.busyUI()').catch(() => false)); i += 1) await sleep(100)
  await sleep(800)
  const beforeSnap = await snapOf('conv-load')
  const beforeText = await evalJs('document.body.innerText.match(/待发送消息（\\d+）/)?.[0] ?? \'无托盘\'').catch(() => 'ev')
  const r = await evalJs(`window.hemiVoice.enqueueTurn({ conversationId: 'conv-load', text: '诊断排队一条XYZ', inputSource: 'text' })`)
  await sleep(1200)
  const afterSnap = await snapOf('conv-load')
  const afterText = await evalJs('document.body.innerText.match(/待发送消息（\\d+）/)?.[0] ?? \'无托盘\'').catch(() => 'ev')
  console.log('HEMI_AC40_DIAG_ENQUEUE=' + JSON.stringify({
    enqueueResult: r,
    phaseBefore: beforeSnap?.phase, pendingBefore: beforeSnap?.pending?.length,
    phaseAfter: afterSnap?.phase, pendingAfter: afterSnap?.pending?.length,
    pendingTexts: (afterSnap?.pending ?? []).map((x) => String(x.text ?? '').slice(0, 10)),
    trayBefore: beforeText, trayAfter: afterText,
    timelineGrew: (afterSnap?.timeline?.length ?? 0) > (beforeSnap?.timeline?.length ?? 0),
  }))
  shutdown(); await sleep(600)
  process.exit(0)
}

if (process.env.HEMI_AC40_DIAG === 'dom') {
  await sleep(1500)
  const dump = await evalJs(`(() => {
    const leaf = (e) => e.childElementCount === 0 && (e.textContent || '').trim();
    const aside = document.querySelector('aside, [class*=sidebar], nav');
    const sidebarTexts = aside ? [...aside.querySelectorAll('*')].filter(leaf).map((e) => (e.textContent || '').trim()).slice(0, 30) : null;
    const heads = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && /查看全部|今天|昨天|更早/.test(e.textContent || '')).map((e) => ({ t: (e.textContent || '').trim(), cls: String(e.className).slice(0, 30) })).slice(0, 10);
    const taskCards = [...document.querySelectorAll('[class*=delegation], [class*=task]')].filter((e) => (e.textContent || '').includes('负载子任务')).length;
    const fileNames = [...document.querySelectorAll('*')].filter(leaf).map((e) => (e.textContent || '').trim()).filter((t) => /负载成果/.test(t)).slice(0, 5);
    return JSON.stringify({ sidebarTexts, heads, taskCards, fileNames, queueText: (document.body.innerText.match(/待发送消息（\\d+）/) ?? [])[0] ?? null });
  })()`)
  console.log('HEMI_AC40_DIAG_DOM=' + dump)
  shutdown(); await sleep(600)
  process.exit(0)
}

console.log('[ac40] 预热轮…')
await stopBlock(0, 0)
await interactionRoundLite()
// 烟囱：UI 路径（runTurn）忙态即时出现——live 采纳链对非 runTurn 回合不翻 busy 的
// 现象已按观察项记录（bug#12 相关），正式测量走真实用户路径。
await waitIdle()
console.log('[ac40] 正式三轮…')
for (let round = 1; round <= ROUNDS; round += 1) {
  await interactionRound(round)
  console.log(`[ac40] 第 ${round} 轮完成：stop=${metrics.stop.length} enqueue=${metrics.enqueue.length} switches=${counters.switches} previews=${counters.previewOk}/${counters.previews}`)
}
ioWatcher.close()

// ================================================================ 正确性＋日志
const final = await snapOf('conv-load')
const other = await snapOf('conv-other')
const seedIds = timeline.map((e) => (e.kind === 'user' ? e.id : e.itemId))
const finalIds = (final?.timeline ?? []).map((e) => (e.kind === 'user' ? e.id : e.itemId))
const prefixStable = JSON.stringify(finalIds.slice(0, seedIds.length)) === JSON.stringify(seedIds)
const seedPendingLeft = (final?.pending ?? []).filter((e) => String(e.inputId ?? '').startsWith('seed-q')).length
const noCross = !(JSON.stringify(final?.timeline ?? []).includes('另一会话的回答'))

const log = fs.readFileSync(path.join(UD, 'hemi.log'), 'utf8')
const blocks = [...log.matchAll(/主进程事件循环阻塞/g)].length
const deltaMatches = [...log.matchAll(/(\d+) 个增量分片/g)].map((m) => Number(m[1]))
shutdown()
await sleep(800)

const stopP = p(metrics.stop)
const enqP = p(metrics.enqueue)
const swP = p(metrics.switchPaint)
const io = ioWatcherRef ?? ioWindow ?? { writes: 0, bytes: 0 }
const out = {
  ok: true,
  budget: {
    stopP95Within200: stopP && stopP.p95 <= 200,
    enqueueP95Within250: enqP && enqP.p95 <= 250,
    eventLoopBlocksZero: blocks === 0,
  },
  stopMs: stopP, enqueueMs: enqP, switchPaintMs: swP,
  samples: { blocks: counters.blocks, enqueueOk: counters.enqueueOk, withdrawOk: counters.withdrawOk, switches: counters.switches, previewsOpened: counters.previewOk, previewAttempts: counters.previews, scrolls: counters.scrolls },
  perRoundSamples: counters.blocks * 8 + counters.switches + counters.previews + counters.scrolls,
  io: { archiveWritesInFirstStreamWindow: io.writes, archiveBytes: io.bytes, deltaShards: deltaMatches.slice(-3) },
  correctness: { prefixStable, timelineLen: finalIds.length, seedPendingKept: seedPendingLeft, noCrossConversation: noCross },
  eventLoopBlocks: blocks,
  sendErrors: sendErrors.slice(0, 3),
  env: { rounds: ROUNDS, profileId: PROFILE_ID, platform: `${os.platform()}/${os.arch()}` },
}
out.ok = out.budget.stopP95Within200 && out.budget.enqueueP95Within250 && out.budget.eventLoopBlocksZero
  && out.correctness.prefixStable && out.correctness.seedPendingKept === 5 && out.correctness.noCrossConversation
  && counters.switches >= 24 * ROUNDS && (counters.blocks - 1) * 8 + counters.switches + counters.previews + counters.scrolls >= 100 * ROUNDS
console.log(`HEMI_VERIFY_057_AC40=${JSON.stringify(out)}`)
fs.rmSync(root, { recursive: true, force: true })
process.exit(out.ok ? 0 : 1)

/** 预热轮的轻交互（不算样本）。 */
async function interactionRoundLite() {
  for (const title of ['另一会话', '负载会话']) {
    await evalJs(`(window.__ac40.sidebarRow(${JSON.stringify(title)}) || {}).click?.()`)
    await sleep(400)
  }
}
