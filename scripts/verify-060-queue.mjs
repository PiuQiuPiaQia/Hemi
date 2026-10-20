// 060 S1 验证：执行中普通发送默认排队（R-01/R-04/R-05）。
//   真实慢工具执行中连发三条文字 → 断言：
//   ① 旧任务不被打断（仍占原运行槽）；
//   ② 三条只出现在待发送区（对话流用户气泡不含它们；托盘计数 3）；
//   ③ 旧任务收口后按输入顺序逐条派发转正（气泡出现、托盘递减）；
//   ④ 全部结束后：四条用户气泡各恰一次、顺序＝开局→1→2→3、托盘清零、无重复。
// 运行：node scripts/verify-060-queue.mjs（隔离 userData＋CDP，exit 0＝断言过）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.HEMI_Q060_PORT ?? 9274)
const PROFILE_ID = process.env.HEMI_Q060_PROFILE ?? null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// HEMI_Q060_ONLY=promote：只跑插队段；并入功能已按用户要求移除。
// ac15：归属取消；reload：三组问答重载；commands：合成进程；ui：原生输入操作留证；
// journey：连续发送→两次编辑→阶段优先→重载→停止→历史阅读→恢复的单会话串联；缺省 full。
// presentation：满额8条／第9条拒绝、小窗口布局、滚动区排序、长Markdown流式阅读与录屏。
const ONLY = process.env.HEMI_Q060_ONLY ?? 'full'
if (ONLY === 'merge') throw new Error('060 已移除补充到当前任务；使用 journey 验证现行队列链路。')
// HEMI_Q060_KEEP=1：失败时保留隔离 userData 供取证（缺省跑完即删）。
const KEEP = process.env.HEMI_Q060_KEEP === '1'
const checks = {}
let n1 = -1
let n2 = -1
let finalBubbles = []
const Q = ['队列一号：只回答 甲。', '队列二号：只回答 乙。', '队列三号：只回答 丙。']
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'hemi-dev')
const electronBin = path.join('node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hemi060-queue-'))
const UD = path.join(root, 'userData')
const evidenceDir = path.resolve(process.env.HEMI_Q060_EVIDENCE ?? path.join('.visual', 'workflow', 'vision', `060-${ONLY}-${Date.now()}`))
fs.mkdirSync(evidenceDir, { recursive: true })
fs.mkdirSync(path.join(UD, 'conversations'), { recursive: true })
for (const name of ['text-model.json', 'text-model-profiles.json', 'onboarding.json']) {
  fs.copyFileSync(path.join(realUserData, name), path.join(UD, name))
}
if (PROFILE_ID) {
  const configPath = path.join(UD, 'text-model-profiles.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const keys = config.providers.flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`))
  if (!keys.includes(PROFILE_ID)) throw new Error(`测试模型不存在：${PROFILE_ID}`)
  config.defaultModelId = PROFILE_ID
  config.lastConversationModelKey = PROFILE_ID
  fs.writeFileSync(configPath, JSON.stringify(config))
}
console.log(`[q060-dbg] 实例与证据：${JSON.stringify({ mode: ONLY, userData: UD, evidenceDir, profileId: PROFILE_ID })}`)
const childLog = fs.openSync(path.join(evidenceDir, 'electron.log'), 'w')
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { env: { ...process.env, HEMI_USER_DATA_DIR: UD }, stdio: ['ignore', childLog, childLog] })
fs.closeSync(childLog)
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
const evalJs = async (expression, timeoutMs = 30_000) => {
  const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(timeoutMs).then(() => null)]).catch(() => null)
  if (r == null) return undefined
  if (r?.exceptionDetails) throw new Error(`page-eval: ${r.exceptionDetails.text ?? ''}`.slice(0, 200))
  return r?.result?.value
}
await send('Runtime.enable')
for (let i = 0; i < 120; i += 1) {
  if (await evalJs('window.hemiVoice && Boolean(document.querySelector("textarea")) && !document.querySelector(".setup-shell")')) break
  await sleep(500)
}
const typeAndSend = (text) => evalJs(`(() => {
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
const bodyText = async () => (await evalJs('document.body.innerText')) ?? ''
const bubbleTexts = async () => JSON.parse((await evalJs(`JSON.stringify([...document.querySelectorAll('.h24-user-bubble')].map((e) => (e.textContent || '').trim()))`)) ?? '[]')
// 完整列表对照，包含助手正文；旧脚本只数用户气泡，会漏掉三条助手被追加两次。
const uiRows = async () => (await evalJs(`Array.from(document.querySelector('.conversation-list')?.children ?? []).flatMap((e) => {
  if (!e.hasAttribute('data-flow-row')) return [];
  const identity = { id: e.dataset.flowRow, runId: e.dataset.runId, inputId: e.dataset.inputId, itemId: e.dataset.itemId,
    partIds: JSON.parse(e.dataset.partIds || '[]'), taskId: e.dataset.taskId, taskRun: e.dataset.taskRun,
    tools: [...e.querySelectorAll('[data-tool-states]')].flatMap((n) => JSON.parse(n.dataset.toolStates || '[]')) };
  const user = e.querySelector('.h24-user-bubble');
  if (user) return [{ ...identity, kind: 'user', text: user.textContent.trim() }];
  const copies = [...e.querySelectorAll('.assistant-copy')];
  if (copies.length) return [{ ...identity, kind: 'assistant', text: copies.map((n) => n.textContent.trim()).join('\\n\\n') }];
  const text = (e.textContent || '').trim();
  return text ? [{ ...identity, kind: e.dataset.flowKind, text }] : [];
})`)) ?? []
const trayCount = async () => Number((await bodyText()).match(/待发送消息（(\d+)）/)?.[1] ?? 0)
const waitRunningCommand = async (command) => {
  for (let i = 0; i < 120; i += 1) {
    const files = fs.readdirSync(path.join(UD, 'conversations')).filter((f) => f.endsWith('.json') && !f.startsWith('._'))
    const archive = files.map((f) => JSON.parse(fs.readFileSync(path.join(UD, 'conversations', f), 'utf8'))).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (archive?.id) {
      const flow = await evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(archive.id)})`)
      if (flow?.timeline?.some((item) => item.runId === flow.activeRunId && item.parts?.some((part) =>
        part.tool === 'bash' && part.status === 'running' && String(part.args?.command ?? '').includes(command)))) return flow.activeRunId
    }
    await sleep(250)
  }
  return null
}
const lastNumber = async () => {
  const nums = [...(await bodyText()).matchAll(/\b(\d{1,4})\b/g)].map((x) => Number(x[1]))
  return nums.length ? Math.max(...nums.filter((n) => n < 2000)) : -1
}

const submitAndWait = async (text) => {
  const oldCount = (await uiRows()).filter((row) => row.kind === 'assistant').length
  await typeAndSend(text)
  for (let i = 0; i < 180; i += 1) {
    if ((await uiRows()).filter((row) => row.kind === 'assistant').length > oldCount && !(await busyNow())) return true
    await sleep(500)
  }
  return false
}

if (ONLY === 'journey') {
  const { runJourney } = await import('./lib/verify-060-journey.mjs');
  await runJourney({ evalJs, send, ws, uiRows, busyNow, evidenceDir, UD, checks });
}

if (ONLY === 'presentation') {
  const { runPresentation } = await import('./lib/verify-060-presentation.mjs');
  await runPresentation({ evalJs, send, ws, uiRows, evidenceDir, UD, checks });
}

if (ONLY === 'commands') {
  const servers = []
  const stopServers = () => { for (const server of servers) { try { server.child.kill('SIGKILL') } catch { /* 已退出 */ } } }
  process.on('exit', stopServers)
  const startServer = () => new Promise((resolve, reject) => {
    const service = spawn(process.execPath, ['--input-type=module', '-e', 'import http from "node:http"; const server = http.createServer((_q,r)=>r.end("060-test")); server.listen(0,"127.0.0.1",()=>console.log(server.address().port));'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const record = { child: service, pid: service.pid, port: null }
    servers.push(record)
    service.once('error', reject)
    service.stdout.once('data', (data) => { record.port = Number(String(data).trim()); resolve(record) })
  })
  const alive = async (server) => fetch(`http://127.0.0.1:${server.port}`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false)
  try {
    const target = await startServer()
    const control = await startServer()
    const queryCommand = `/bin/ps -p ${target.pid} -o pid=,comm=`
    const killCommand = `/bin/kill -TERM ${target.pid}`
    checks.commandQueryAnswered = await submitAndWait(`命令查询验收：这是本轮专用测试进程。请仅调用一次 bash 执行以下原样命令并如实报告结果：${queryCommand}。不要重试或换工具。`)
    checks.commandKillAnswered = await submitAndWait(`精确关闭验收：PID ${target.pid}、端口 ${target.port} 是本轮专门创建的测试 HTTP 服务。请仅调用一次 bash 原样执行：${killCommand}。不要使用 pkill、killall、sudo 或其他解释器。只报告真实结果，不能关闭其他服务。`)
    checks.commandFailureAnswered = await submitAndWait('失败状态验收：请仅用一次 bash 原样执行 printf \"simulated-permission-error\\n\" >&2; exit 7。请如实报告，不要重试。')
    await sleep(500)
    checks.commandTargetStopped = !(await alive(target))
    checks.commandControlAlive = await alive(control)
    const archiveFiles = fs.readdirSync(path.join(UD, 'conversations')).filter((f) => f.endsWith('.json') && !f.startsWith('._'))
    const archive = archiveFiles.map((f) => JSON.parse(fs.readFileSync(path.join(UD, 'conversations', f), 'utf8'))).sort((a,b) => b.updatedAt-a.updatedAt)[0]
    const messages = (archive?.agentSession?.entries ?? []).map((e) => e.message).filter(Boolean)
    const calls = messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((c) => c.type === 'toolCall') : [])
    const results = messages.filter((m) => m.role === 'toolResult').map((m) => ({ id: m.toolCallId, isError: Boolean(m.isError), text: Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : String(m.content) }))
    const query = calls.find((c) => c.name === 'bash' && c.arguments?.command === queryCommand)
    const kill = calls.find((c) => c.name === 'bash' && c.arguments?.command === killCommand)
    checks.commandExactScope = calls.length === 3 && Boolean(query && kill)
    const queryResult = results.find((r) => r.id === query?.id)
    checks.commandProcessQueryAllowed = Boolean(queryResult && queryResult.text.includes(String(target.pid)) && !/Operation not permitted/.test(queryResult.text))
    const failed = results.filter((r) => /Operation not permitted|exit=[1-9]/.test(r.text))
    const flowTools = (archive?.flow?.timeline ?? []).flatMap((item) => item.parts ?? []).filter((part) => part.kind === 'tool')
    checks.commandFailurePropagated = failed.length > 0 && failed.every((r) => r.isError && flowTools.find((part) => part.toolCallId === r.id)?.status === 'error')
    fs.writeFileSync(path.join(evidenceDir, 'command-evidence.json'), JSON.stringify({ target: { pid: target.pid, port: target.port }, control: { pid: control.pid, port: control.port }, calls, results, flowTools, checks }, null, 2))
  } finally {
    stopServers()
  }
}

if (ONLY === 'reload') {
  for (const marker of ['甲', '乙', '丙']) {
    await typeAndSend(`重载核对${marker}：请只回答「答复${marker}-060」。`)
    let answered = false
    for (let i = 0; i < 120; i += 1) {
      if ((await uiRows()).some((row) => row.kind === 'assistant' && row.text.includes(`答复${marker}-060`)) && !(await busyNow())) { answered = true; break }
      await sleep(500)
    }
    checks[`reloadAnswered${marker}`] = answered
    if (!answered) break
  }
}

if (ONLY === 'ui') {
  console.log('[q060-dbg] 原生 UI 验证窗口就绪；等待 manual-checks.json（最多 5 分钟）')
  const donePath = path.join(evidenceDir, 'manual-checks.json')
  for (let i = 0; i < 600 && !fs.existsSync(donePath); i += 1) await sleep(500)
  if (fs.existsSync(donePath)) Object.assign(checks, JSON.parse(fs.readFileSync(donePath, 'utf8')))
  else checks.manualUiCompleted = false
  fs.writeFileSync(path.join(evidenceDir, 'native-ui-final-rows.json'), JSON.stringify(await uiRows(), null, 2))
}

if (ONLY === 'editor') {
  const setDraft = (text) => evalJs(`(() => { const ta = document.querySelector('.text-composer-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const observeButtons = (previous = { maxPrimary: 0, duplicatePrimary: false, spinningSend: false }) => evalJs(`(() => {
    window.q060Buttons = ${JSON.stringify(previous)};
    const sample = () => {
      const buttons = [...document.querySelectorAll('.text-composer-send')].filter((el) => el.offsetParent !== null);
      window.q060Buttons.maxPrimary = Math.max(window.q060Buttons.maxPrimary, buttons.length);
      window.q060Buttons.duplicatePrimary ||= buttons.length > 1;
      window.q060Buttons.spinningSend ||= buttons.some((el) => el.querySelector('.animate-spin'));
    };
    window.q060ButtonObserver = new MutationObserver(sample);
    window.q060ButtonObserver.observe(document.body, { childList: true, subtree: true, attributes: true }); sample();
  })()`);
  await observeButtons();
  await typeAndSend('编辑060开局：请仅用 bash 执行 sleep 12，结束后只回答「开局结束」。');
  checks.editorSlowToolConfirmed = Boolean(await waitRunningCommand('sleep 12'));
  if (!checks.editorSlowToolConfirmed) throw new Error('编辑用例没有真实慢工具');
  await typeAndSend('编辑060B原文：请只回答「旧B」。');
  await typeAndSend('编辑060C：请只回答「C完成」。');
  await setDraft('编辑060未发送原稿必须保留');
  await evalJs(`(() => { const row = [...document.querySelectorAll('.h24-queue-item')].find((el) => el.textContent.includes('编辑060B原文')); row?.querySelector('button[aria-label="编辑这条"]')?.click(); })()`);
  for (let i = 0; i < 40; i++) {
    if (await evalJs(`Boolean(document.querySelector('.queue-composer-editing'))`)) break;
    await sleep(100);
  }
  checks.editorUsesMainInput = await evalJs(`document.querySelectorAll('textarea').length === 1 && document.querySelector('.text-composer-input').value.includes('编辑060B原文')`);
  checks.editorRowLocked = await evalJs(`Boolean(document.querySelector('.h24-queue-item[data-state="editing"]'))`);
  checks.editorOnlyOnePriorityButton = await evalJs(`document.querySelectorAll('.h24-queue-item button[aria-label="优先执行"]').length === 2 && !document.querySelector('.h24-queue-item button[title*="并入"]')`);
  await setDraft('编辑060B修改：请只回答「修改B完成」。');
  await sleep(650);
  const beforeButtonSamples = await evalJs('window.q060Buttons');
  await send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 80; i++) {
    if (await evalJs(`Boolean(document.querySelector('.h24-queue-item[data-state="editing"]'))`)) break;
    await sleep(100);
  }
  await observeButtons(beforeButtonSamples);
  await evalJs(`document.querySelector('.h24-queue-item[data-state="editing"] button[aria-label="编辑这条"]')?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await evalJs(`Boolean(document.querySelector('.queue-composer-editing'))`)) break;
    await sleep(100);
  }
  checks.editorDraftSurvivesReload = await evalJs(`document.querySelector('.text-composer-input').value.includes('编辑060B修改')`);

  for (const width of [1440, 768, 375]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidenceDir, `editor-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(13000);
  checks.editorNotDispatchedWhileEditing = !(await bubbleTexts()).some((text) => text.includes('编辑060B') || text.includes('编辑060C'));
  await evalJs(`document.querySelector('.text-composer-send[data-action="save"]')?.click()`);
  for (let i = 0; i < 120; i++) { if (!(await busyNow()) && (await trayCount()) === 0) break; await sleep(500); }
  checks.editorRestoresUnsentDraft = await evalJs(`document.querySelector('.text-composer-input').value === '编辑060未发送原稿必须保留'`);
  const rows = await uiRows();
  const users = rows.filter((row) => row.kind === 'user');
  checks.editorSavedOnceInOriginalOrder = users.length === 3 && users[1].text.includes('编辑060B修改') && users[2].text.includes('编辑060C');
  checks.editorNoOldTextSent = !users.some((row) => row.text.includes('编辑060B原文') || row.text.includes('未发送原稿'));
  const buttons = await evalJs(`(() => { window.q060ButtonObserver.disconnect(); return window.q060Buttons; })()`);
  checks.editorNoDuplicateOrSpinningSend = buttons.maxPrimary === 1 && !buttons.duplicatePrimary && !buttons.spinningSend;
  fs.writeFileSync(path.join(evidenceDir, 'editor-evidence.json'), JSON.stringify({ rows, buttons, checks }, null, 2));
}

if (ONLY === 'full') {
  // 真实慢工具保证忙态窗口；不再依赖模型是否愿意数满 3000 个数字。
  const opening = '开局060：请仅用 bash 执行 sleep 15，结束后只回答「开局完成060」。'
  await typeAndSend(opening)
  let openingRunId = null
  let openingConversationId = null
  for (let i = 0; i < 120; i += 1) {
    // 会话身份从真实存档读取，UI 状态不冒充正在执行的慢工具。
    const files = fs.readdirSync(path.join(UD, 'conversations')).filter((f) => f.endsWith('.json') && !f.startsWith('._'))
    const archive = files.map((f) => JSON.parse(fs.readFileSync(path.join(UD, 'conversations', f), 'utf8'))).sort((a,b) => b.updatedAt-a.updatedAt)[0]
    if (archive?.id) {
      const live = await evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(archive.id)})`)
      if (live?.timeline?.some((item) => item.parts?.some((part) => part.tool === 'bash' && part.status === 'running'))) { openingRunId = live.activeRunId; openingConversationId = archive.id; break }
    }
    await sleep(250)
  }
  checks.openingSlowToolConfirmed = Boolean(openingRunId)
  if (!openingRunId) throw new Error('模型未启动慢工具，本轮不能证明忙时排队')

  // 执行中连发三条（普通发送——默认排队）。
  for (const text of Q) { await typeAndSend(text); await sleep(400) }
  await sleep(1000)

  // ② 三条只在待发送区（气泡里没有；托盘 3）。
  const bubblesAfterSend = await bubbleTexts()
  checks.queueOnlyInTray = Q.every((text) => !bubblesAfterSend.some((b) => b.includes(text.slice(0, 6))))
  checks.trayShowsThree = (await trayCount()) === 3
  if (process.env.HEMI_Q060_VISUAL === '1') {
    const viewports = [];
    for (const width of [1440, 768, 375]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(150);
      const layout = await evalJs(`(() => {
        const box = document.querySelector('textarea')?.getBoundingClientRect();
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          composerVisible: Boolean(box && box.width > 0 && box.left >= 0 && box.right <= innerWidth),
          queueItems: document.querySelectorAll('.h24-queue-item').length };
      })()`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidenceDir, `queue-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      viewports.push(layout);
    }
    await send('Emulation.clearDeviceMetricsOverride');
    fs.writeFileSync(path.join(evidenceDir, 'responsive-layout.json'), JSON.stringify(viewports, null, 2));
    checks.responsiveNoOverflow = viewports.every((view) => view.composerVisible && view.scrollWidth <= view.width);
  }
  await sleep(1500)
  const continuation = await evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(openingConversationId)})`)
  checks.oldTaskNotInterrupted = continuation?.activeRunId === openingRunId && !continuation?.runs?.[openingRunId]?.stopRequested
  checks.oldTaskStillBusy = await busyNow()

  // ③ 等逐条派发转正（最长 10 分钟）：第一条字母「甲」的回答出现时，其气泡也应转正。
  let firstPromoted = false
  for (let i = 0; i < 300; i += 1) {
    const bubbles = await bubbleTexts()
    if (bubbles.some((b) => b.includes(Q[0].slice(0, 6)))) { firstPromoted = true; break }
    await sleep(2000)
  }
  checks.firstPromotedInOrder = firstPromoted
  // ④ 全部完成：四条气泡各恰一次 + 顺序正确 + 托盘清零。
  for (let i = 0; i < 400; i += 1) {
    if (!(await busyNow()) && (await trayCount()) === 0) break
    await sleep(2000)
  }
  await sleep(1500)
  finalBubbles = await bubbleTexts()
  const countOf = (text) => finalBubbles.filter((b) => b.includes(text)).length
  checks.eachExactlyOnce = Q.every((text) => countOf(text.slice(0, 6)) === 1) && finalBubbles.filter((b) => b.includes('开局060')).length === 1
  const joined = finalBubbles.join('\n')
  const order = ['开局060', ...Q.map((t) => t.slice(0, 6))].map((t) => joined.indexOf(t))
  checks.inOrder = order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))
  checks.trayCleared = (await trayCount()) === 0


}

// ④.5 显式并入原子化（060 R-11）：长任务在途 → 追加一条（排队）→ 点托盘行「并入」
//     → 条目被单次锁定（原 inputId）→ 投递后沿原身份转正上屏；托盘行消失、不重复。
// 开局（长工具）＋确认真的忙起来（最多三次尝试；模型偶尔不跑工具直接作答——
// 那样 30s 内不会看到忙态，等它收口后重开一局）。ONLY=ac15 时整段跳过（走 ④.92 专项）。
if (ONLY === 'full' || ONLY === 'promote') {
  let promoteOpening = false
  for (let attempt = 0; attempt < 3 && !promoteOpening; attempt += 1) {
    await typeAndSend('请在 shell 里执行命令 sleep 60，等它结束再回答。完成后只回答一个词：完成。')
    promoteOpening = Boolean(await waitRunningCommand('sleep 60'))
    if (!promoteOpening) for (let i = 0; i < 120 && (await busyNow()); i += 1) await sleep(1000)
  }
  checks.promoteSlowToolConfirmed = promoteOpening
  if (!promoteOpening) throw new Error('旧任务未进入真实慢工具，不能证明插队清理')
  let promoteQueued = false
  for (let attempt = 0; attempt < 2 && !promoteQueued; attempt += 1) {
    await typeAndSend('插队测试条：这个先做。')
    for (let i = 0; i < 12; i += 1) { if ((await trayCount()) >= 1) { promoteQueued = true; break } await sleep(500) }
  }
  await sleep(800)
  const promoteClicked = await evalJs(`(() => {
    const row = [...document.querySelectorAll('.h24-queue-item')].find((e) => (e.innerText || '').includes('插队测试条'));
    if (!row) return 'no-row';
    const btn = [...row.querySelectorAll('button')].find((b) => (b.title || '').includes('直接运行'));
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`)
  console.log('[q060-dbg] promote prep:', JSON.stringify({ promoteOpening, promoteQueued, promoteClicked }))
  checks.promoteClicked = promoteClicked === 'clicked'
  await sleep(300)
  checks.promoteWaitsForStage = (await busyNow()) && !(await bubbleTexts()).some((b) => b.includes('插队测试条'))
  // 插队条目上屏（停止确认后优先派发；气泡出现）＋ 旧任务不再占用。
  let promoteBubbleSeen = false
  for (let i = 0; i < 150; i += 1) {
    const bubbles = await bubbleTexts()
    if (bubbles.some((b) => b.includes('插队测试条'))) { promoteBubbleSeen = true; break }
    await sleep(1000)
  }
  checks.promoteBubbleOnScreen = promoteBubbleSeen
  checks.promoteExactlyOnce = (await bubbleTexts()).filter((b) => b.includes('插队测试条')).length === 1
  checks.promoteTrayCleared = !/待发送消息[（(]/.test(await bodyText())
  for (let i = 0; i < 200; i += 1) { if (!(await busyNow())) break; await sleep(1000) }
}

// ④.92 AC-15 真机证据（R-22 归属取消）：先让回合 1 派**独立后台 D**（自己的根），
//      再开局 A＝长 sleep＋后台派**A 所属子 agent**；插队 B 后断言（读隔离 userData
//      的会话档案 task 卡）：A 所属子 agent 终态 stopped（取消原因带「取代」），
//      独立 D 正常 complete 不被误停。
if (ONLY === 'ac15') {
  const readArchive = async () => {
    const dir = path.join(UD, 'conversations')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({
      f, m: fs.statSync(path.join(dir, f)).mtimeMs,
    })).sort((a, b) => b.m - a.m)
    if (!files.length) return null
    try { return JSON.parse(fs.readFileSync(path.join(dir, files[0].f), 'utf8')) } catch { return null }
  }
  const taskCards = (archive) => (archive?.turns ?? []).filter((t) => t.kind === 'task' && t.taskSnap)
  const cardByMarker = (archive, marker) => taskCards(archive).find((t) => String(t.taskSnap.taskText ?? '').includes(marker)) ?? null
  // 运行中档案卡只持有初始／收口快照，工具进度从实时任务接口读取。
  const liveTasks = async () => (await evalJs('window.hemiVoice.getTaskState()'))?.tasks ?? []

  // ① 回合 1：派独立后台 D（回合很快收口，D 继续跑）。
  await typeAndSend('请用 task 工具派一个后台子 agent：agent 用 fixer，background 设为 true，description 写「独立D数数」，prompt 要求它仅用 bash 执行 sleep 45，再回答「独立D已完成」。不要等它完成，派完立刻回答：已派出。')
  for (let i = 0; i < 120 && (await busyNow()); i += 1) await sleep(1000)
  let dSpawned = false
  for (let i = 0; i < 60 && !dSpawned; i += 1) {
    if (cardByMarker(await readArchive(), '独立D数数')) dSpawned = true
    else await sleep(2000)
  }
  checks.ac15DSpawned = dSpawned

  // ② 开局 A：长 sleep＋后台派 A 所属子 agent（rootRunId 记在 A 的运行上）。
  let ac15Opening = false
  for (let attempt = 0; attempt < 2 && !ac15Opening; attempt += 1) {
    await typeAndSend('请在同一条助手消息里并行调用两个工具：bash 执行 sleep 120；task 派一个后台 fixer，background 为 true，description 写「插队A数数」，prompt 要求仅用 bash 执行 sleep 120 后报告「A子任务完成」。不要先等待 sleep 返回再派 task。全部结束后只回答：完成。')
    for (let i = 0; i < 180; i += 1) { if (await busyNow()) { ac15Opening = true; break } await sleep(500) }
    if (!ac15Opening) for (let i = 0; i < 120 && (await busyNow()); i += 1) await sleep(1000)
  }
  // A 所属子 agent 真的已派出（档案有卡）才插队——否则取消断言没意义。
  let aSpawned = false
  for (let i = 0; i < 120 && !aSpawned; i += 1) {
    const task = (await liveTasks()).find((task) => String(task.taskText ?? '').includes('插队A数数'))
    if (task?.phase === 'running' && task.lastAction?.tool === 'bash') aSpawned = true
    else await sleep(2000)
  }
  checks.ac15ASpawned = aSpawned
  const activeBefore = await liveTasks()
  const dBefore = activeBefore.find((task) => String(task.taskText ?? '').includes('独立D数数'))
  checks.ac15DActiveAtPromote = Boolean(dBefore && dBefore.phase === 'running' && dBefore.lastAction?.tool === 'bash')

  // ③ 排队 B＋点「让这条优先」。
  let ac15Queued = false
  for (let attempt = 0; attempt < 2 && !ac15Queued; attempt += 1) {
    await typeAndSend('插队测试条：这个先做。')
    for (let i = 0; i < 12; i += 1) { if ((await trayCount()) >= 1) { ac15Queued = true; break } await sleep(500) }
  }
  await sleep(800)
  const ac15Clicked = await evalJs(`(() => {
    const row = [...document.querySelectorAll('.h24-queue-item')].find((e) => (e.innerText || '').includes('插队测试条'));
    if (!row) return 'no-row';
    const btn = [...row.querySelectorAll('button')].find((b) => (b.title || '').includes('直接运行'));
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`)
  console.log('[q060-dbg] ac15 prep:', JSON.stringify({ dSpawned, ac15Opening, aSpawned, ac15Queued, ac15Clicked }))
  checks.ac15PromoteClicked = ac15Clicked === 'clicked'
  let ac15Bubble = false
  for (let i = 0; i < 150; i += 1) {
    if ((await bubbleTexts()).some((b) => b.includes('插队测试条'))) { ac15Bubble = true; break }
    await sleep(1000)
  }
  checks.ac15BPromoted = ac15Bubble
  for (let i = 0; i < 200; i += 1) { if (!(await busyNow())) break; await sleep(1000) }

  // ④ 读档案断言归属取消：A 子 stopped；独立 D 不受影响（跑完 complete）。
  let aCard = null
  let dCard = null
  for (let i = 0; i < 100; i += 1) {
    const archive = await readArchive()
    aCard = cardByMarker(archive, '插队A数数')
    dCard = cardByMarker(archive, '独立D数数')
    const aDone = aCard && aCard.taskSnap.phase === 'terminal'
    const dDone = dCard && dCard.taskSnap.phase === 'terminal'
    if (aDone && dDone) break
    await sleep(5000)
  }
  const aSnap = aCard?.taskSnap ?? {}
  const dSnap = dCard?.taskSnap ?? {}
  console.log('[q060-dbg] ac15 cards:', JSON.stringify({
    a: { outcome: aSnap.outcome, reason: aSnap.outcomeReason },
    d: { outcome: dSnap.outcome, reason: dSnap.outcomeReason },
  }))
  checks.ac15SubOfAStopped = aSnap.outcome === 'stopped' && String(aSnap.outcomeReason ?? '').includes('取代')
  checks.ac15IndependentDUntouched = dSnap.outcome === 'complete'
  const settledArchive = await readArchive()
  const oldRun = Object.values(settledArchive?.flow?.runs ?? {}).find((run) => run.stopReason === 'promote')
  checks.ac15OldRunStopped = oldRun?.outcome === 'stopped'
  fs.writeFileSync(path.join(evidenceDir, 'ac15-evidence.json'), JSON.stringify({
    before: { independentD: dBefore, ownedA: activeBefore.find((task) => String(task.taskText ?? '').includes('插队A数数')) },
    after: { independentD: dSnap, ownedA: aSnap, oldRun },
    ui: await uiRows(),
  }, null, 2))
}

if (ONLY === 'full' || ONLY === 'promote') {
  const files = fs.readdirSync(path.join(UD, 'conversations')).filter((f) => f.endsWith('.json') && !f.startsWith('._'));
  const archive = files.map((f) => JSON.parse(fs.readFileSync(path.join(UD, 'conversations', f), 'utf8'))).sort((a,b) => b.updatedAt-a.updatedAt)[0];
  const flow = await evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(archive.id)})`);
  const oldRun = Object.values(flow.runs).find((run) => run.stopReason === 'promote');
  const newUser = flow.timeline.find((item) => item.kind === 'user' && item.text.includes('插队测试条'));
  const oldParts = flow.timeline.filter((item) => item.runId === oldRun?.runId).flatMap((item) => item.parts ?? []);
  const newParts = flow.timeline.filter((item) => item.runId === newUser?.runId).flatMap((item) => item.parts ?? []);
  checks.promoteOldRunStopped = oldRun?.outcome === 'stopped';
  checks.promoteOldToolsClosed = oldParts.every((part) => part.status !== 'running');
  checks.promoteCurrentStageCompleted = oldParts.some((part) => part.tool === 'bash' && part.status === 'done');
  checks.promoteNoOldCommandReplay = !newParts.some((part) => part.tool === 'bash' && String(part.args?.command ?? '').includes('sleep 60'));
  fs.writeFileSync(path.join(evidenceDir, 'priority-evidence.json'), JSON.stringify({ oldRun, oldParts, newRunId: newUser?.runId, newParts, checks }, null, 2));
}

// ⑤ 窗口重载（060 AC-10 时点）：档案身份投影后四条气泡仍在、顺序不变、无双份。
if (ONLY !== 'ac15' && ONLY !== 'ui') {
const beforeReloadRows = await uiRows()
fs.writeFileSync(path.join(evidenceDir, 'before-reload.json'), JSON.stringify(beforeReloadRows, null, 2))
// renderer 发起的 location.reload 会被原生导航守卫拦截；用真实 Page.reload，
// 并验证 timeOrigin 已变化，避免“根本没重载”的假通过。
const previousTimeOrigin = await evalJs('performance.timeOrigin')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
let nextTimeOrigin = previousTimeOrigin
for (let i = 0; i < 80; i += 1) {
  nextTimeOrigin = await evalJs('performance.timeOrigin', 2000)
  if (nextTimeOrigin && nextTimeOrigin !== previousTimeOrigin && await evalJs('Boolean(document.querySelector("textarea"))')) break
  await sleep(250)
}
checks.windowActuallyReloaded = Boolean(nextTimeOrigin && nextTimeOrigin !== previousTimeOrigin)
fs.writeFileSync(path.join(evidenceDir, 'reload-lifecycle.json'), JSON.stringify({ previousTimeOrigin, nextTimeOrigin }, null, 2))
await sleep(1500)
for (let i = 0; i < 80; i += 1) {
  const body = await bodyText()
  if (ONLY === 'reload' ? body.includes('重载核对丙') : ONLY !== 'full' || (body.includes('队列三号') && body.includes('完成'))) break
  await sleep(500)
}
await sleep(1000)
const reloadBubbles = await bubbleTexts()
const fullReloadKeepsAll = ONLY !== 'full' || (Q.every((text) => reloadBubbles.filter((b) => b.includes(text.slice(0, 6))).length === 1)
    && reloadBubbles.filter((b) => b.includes('开局060')).length === 1
)
const reloadJoined = reloadBubbles.join('\n')
const orderTexts = ONLY !== 'full' ? [] : ['开局060', ...Q.map((t) => t.slice(0, 6))]
const reloadOrder = orderTexts.map((t) => reloadJoined.indexOf(t))
const afterReloadRows = await uiRows()
const restoredIndexes = beforeReloadRows.map((row) => afterReloadRows.findIndex((after) => after.id === row.id))
checks.reloadKeepsAll = beforeReloadRows.length > 0 && fullReloadKeepsAll
  && beforeReloadRows.every((row) => afterReloadRows.filter((after) => after.id === row.id).length === 1)
checks.reloadOrder = restoredIndexes.every((value, index) => value >= 0 && (index === 0 || value > restoredIndexes[index - 1]))
  && reloadOrder.every((value, index) => value >= 0 && (index === 0 || value > reloadOrder[index - 1]))
fs.writeFileSync(path.join(evidenceDir, 'after-reload.json'), JSON.stringify(afterReloadRows, null, 2))
checks.reloadFullStructure = beforeReloadRows.length > 0 && JSON.stringify(beforeReloadRows) === JSON.stringify(afterReloadRows)
checks.reloadStableIdentities = afterReloadRows.every((row) => row.id && row.runId && row.itemId) && new Set(afterReloadRows.map((row) => row.id)).size === afterReloadRows.length
if (ONLY === 'reload') checks.reloadThreePairs = afterReloadRows.length === 6
}

const ok = Object.values(checks).every(Boolean)
const result = { ok, mode: ONLY, checks, n1, n2, bubbles: finalBubbles, evidenceDir }
fs.writeFileSync(path.join(evidenceDir, 'result.json'), JSON.stringify(result, null, 2))
console.log(`HEMI_VERIFY_060_QUEUE=${JSON.stringify(result)}`)
const observeMs = Math.min(60000, Math.max(0, Number(process.env.HEMI_Q060_OBSERVE_MS ?? 0)))
if (observeMs) {
  console.log(`[q060-dbg] 观察窗口保留 ${observeMs}ms`)
  await sleep(observeMs)
}
ws.close()
shutdown()
await sleep(400)
if (!KEEP) fs.rmSync(root, { recursive: true, force: true })
else console.log(`[q060-dbg] 保留 userData：${UD}`)
process.exit(ok ? 0 : 1)
