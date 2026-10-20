// 057 AC-15 崩溃注入真机验证（两段驱动，外层 bash 编排）：
//   ①起隔离实例（HEMI_USER_DATA_DIR=/tmp/hemi057-ac15 + 预置空档 conv-ac15 + --remote-debugging-port=9246）
//   ②node scripts/verify-057-ac15.mjs setup 9246   —— 主 agent 自执行慢任务跑起＋两条入队后回填基线
//   ③lsof -ti :9246 | xargs kill -9                 —— 运行在途 SIGKILL
//   ④同 UD 重启（--remote-debugging-port=9248）
//   ⑤node scripts/verify-057-ac15.mjs verify 9248   —— 断言 restoreFlowSnapshot 语义：
//     遗留运行标 interrupted＋closedAt、activeRunId 清空相位回 idle、pending 保留且
//     queuePaused=true（不自动重放）、用户轮档案存活、重启后时间线渲染正常。
//     submitting→needs-review 的崩溃窗口过窄，由 flow-bootstrap 单测覆盖。

//   phase=setup   起实例→发起慢任务→等任务 running→入队两条→回填快照基线（stdout JSON）
//   phase=verify  （SIGKILL + 重启后由外层调用）断言恢复语义＋档案一致＋UI 渲染
const PHASE = process.argv[2];
const PORT = Number(process.argv[3] ?? 9246);
const UD = '/tmp/hemi057-ac15';
const LOG = `${UD}/hemi.log`;
const fs = await import('node:fs');

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
const page = targets.find((t) => t.type === 'page' && !/mode=/.test(t.url));
if (!page) { console.error(JSON.stringify({ ok: false, error: 'no main window' })); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (PHASE === 'setup') {
  await send('Runtime.enable');
  // 慢任务：多文件逐个写（拖长运行窗口）
  // 主 agent 自己动手的慢任务（主运行保持在途——派单会让主回合提前收口）。
  const chatPromise = evalJs(`window.hemiVoice.chatTextModel({ turnId: 9902, conversationId: 'conv-ac15', workspaceId: 'default', profileId: 'mp-muxxaz5x-s2frgd/m-new-muxxaz5x-0', inputSource: 'text', messages: [{ role: 'user', content: '不要派子 agent，你自己直接在 /tmp/hemi-ac15 目录创建 g1.txt 到 g8.txt 八个文件，每个内容写 100 行「文件 N 第 M 行」，一个一个做，每写完一个用 read 核对一遍再写下一个，慢慢做仔细做。' }] }).then(() => 'settled', (e) => 'rejected:' + e)`);
  void chatPromise;
  // 等 fixer 任务 running
  // 等主运行真正在途（流相位 running＋有 activeRun）且已产出至少一个文件。
  let mainRunning = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const snapNow = await evalJs(`window.hemiVoice.flowGetSnapshot('conv-ac15')`);
    const files = fs.readdirSync('/tmp/hemi-ac15').length;
    if (snapNow?.activeRunId && files >= 1) { mainRunning = true; break; }
  }
  // 入队两条（pending）
  const q1 = await evalJs(`window.hemiVoice.enqueueTurn({ conversationId: 'conv-ac15', text: '排队第一条：完成后告诉我文件个数', inputSource: 'text' })`);
  const q2 = await evalJs(`window.hemiVoice.enqueueTurn({ conversationId: 'conv-ac15', text: '排队第二条：只回答数字 7', inputSource: 'voice' })`);
  await sleep(1500);
  const snap = await evalJs(`window.hemiVoice.flowGetSnapshot('conv-ac15')`);
  console.log(JSON.stringify({ ok: true, mainRunning, q1ok: q1?.ok, q2ok: q2?.ok,
    activeRunId: snap?.activeRunId, phase: snap?.phase,
    pending: (snap?.pending ?? []).map((p) => p.state ?? p.dispatchState ?? '?'), queuePaused: snap?.queuePaused }));
  ws.close(); process.exit(0);
}

if (PHASE === 'verify') {
  await send('Runtime.enable');
  await sleep(1500);
  const snap = await evalJs(`window.hemiVoice.flowGetSnapshot('conv-ac15')`);
  const runs = Object.entries(snap?.runs ?? {}).map(([id, run]) => ({ id, outcome: run.outcome, closedAt: run.closedAt ?? null }));
  const crashed = runs.find((run) => run.outcome === 'interrupted');
  const pend = (snap?.pending ?? []).map((p) => ({ text: String(p.text ?? '').slice(0, 18), state: p.state ?? p.dispatchState ?? '?' }));
  const dom = await evalJs(`(() => ({
    timeline: document.body.innerText.includes('g1.txt'),
    empty: document.body.innerText.includes('今天想做什么'),
    queueRows: (document.body.innerText.match(/排队第[一二]条/g) ?? []).length,
  }))()`);
  const archive = JSON.parse(fs.readFileSync(`${UD}/conversations/conv-ac15.json`, 'utf8'));
  const userTurns = (archive.turns ?? []).filter((t) => t.author === 'user');
  const log = fs.readFileSync(LOG, 'utf8');
  const recovered = [...log.matchAll(/补标中断 (\d+) 条/g)].map((m) => Number(m[1]));
  const out = {
    ok: true,
    restore: {
      activeRunIdCleared: snap?.activeRunId == null,
      phaseIdle: snap?.phase === 'idle',
      crashedRunInterrupted: Boolean(crashed),
      runs,
      pendingKept: pend.length === 2,
      pendingStates: pend.map((p) => p.state),
      queuePaused: snap?.queuePaused === true,
    },
    archive: { userTurnPersisted: userTurns.length >= 1, flowInArchive: Boolean(archive.flow) },
    ui: dom,
    taskRecovery: { marks: recovered, lastBoot: recovered.at(-1) ?? 0 },
  };
  out.ok = out.restore.activeRunIdCleared && out.restore.phaseIdle && out.restore.crashedRunInterrupted
    && out.restore.pendingKept && out.restore.queuePaused && out.archive.userTurnPersisted
    && out.ui.timeline && !out.ui.empty;
  console.log('HEMI_VERIFY_057_AC15=' + JSON.stringify(out));
  ws.close(); process.exit(out.ok ? 0 : 1);
}
ws.close(); process.exit(1);
