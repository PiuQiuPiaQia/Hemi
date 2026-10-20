// 060 连续真机链：真实输入事件／Electron IPC／Pi／配置模型；仅操作隔离 userData。
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;

export async function runJourney({ evalJs, send, ws, uiRows, busyNow, evidenceDir, UD, checks }) {
  const stages = [], reloads = [], probes = [], errors = [], movieFrames = [];
  const framesDir = path.join(evidenceDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify(value, null, 2));
  const stage = (name) => { const item = { name, at: Date.now() }; stages.push(item); write('progress.json', item); console.log(`[q060-journey] ${name}`); };
  const must = (condition, label) => { checks[label] = Boolean(condition); if (!condition) throw new Error(`journey assertion: ${label}`); };
  const wait = async (label, predicate, timeout = 45000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(50); }
    throw new Error(`journey timeout: ${label}`);
  };
  const archive = () => {
    const dir = path.join(UD, 'conversations');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('._'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  };
  let cid = null;
  const flow = async () => { cid ??= archive()?.id; return cid ? evalJs(`window.hemiVoice.flowGetSnapshot(${JSON.stringify(cid)})`) : null; };
  const user = (snapshot, prefix) => snapshot?.timeline.find((item) => item.kind === 'user' && item.text.startsWith(prefix));
  const tools = (snapshot, runId) => snapshot?.timeline.filter((item) => item.runId === runId).flatMap((item) => item.parts ?? []).filter((part) => part.kind === 'tool') ?? [];
  const draft = () => evalJs(`document.querySelector('.text-composer-input')?.value`);
  const type = async (text) => {
    await evalJs(`(() => { const ta = document.querySelector('.text-composer-input'); ta.focus({preventScroll:true}); ta.select(); })()`);
    await send('Input.insertText', { text });
    await wait('输入事件', async () => (await draft()) === text);
  };
  const enter = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  };
  const submit = async (text, clear = true) => {
    await type(text); const at = Date.now(); await enter();
    if (clear) { await wait('受理后清草稿', async () => (await draft()) === '', 8000); stages.push({ name: `受理 ${text.slice(0, 12)}`, at, clearAt: Date.now() }); }
  };
  const clickQueue = async (prefix, label) => {
    const found = await evalJs(`(() => { const row = [...document.querySelectorAll('.h24-queue-item')].find((el) => el.textContent.includes(${JSON.stringify(prefix)})); const button = row?.querySelector('button[aria-label="${label}"]'); if (!button || button.disabled) return false; button.click(); return true; })()`);
    must(found, `click-${prefix}-${label}`);
  };
  const shot = async (name) => { const frame = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(evidenceDir, `${name}.png`), Buffer.from(frame.data, 'base64')); };
  const installProbe = async () => evalJs(`(() => {
    const m = window.q060Journey = { origin: performance.timeOrigin, start: Date.now(), gaps: [], changes: [], scroll: [], composerAncestorScroll: [], emptySpacerLeaks: [], violations: [], host: [], firstSeen: {}, previous: [], stopped: false, lastFrame: null };
    const rows = () => [...document.querySelectorAll('[data-flow-row]')];
    const frame = (stamp) => {
      if (m.stopped) return;
      if (m.lastFrame !== null) m.gaps.push(stamp - m.lastFrame); m.lastFrame = stamp;
      const all = rows(), keys = all.map((el) => el.dataset.flowRow);
      const emptySpacer=document.querySelector('.h24-empty-spacer');
      if(all.length&&emptySpacer&&emptySpacer.getBoundingClientRect().height>1) m.emptySpacerLeaks.push({at:Date.now(),height:emptySpacer.getBoundingClientRect().height});
      for (let el=document.querySelector('.text-composer-input')?.parentElement;el;el=el.parentElement) {
        if (el.scrollTop || el.scrollLeft) m.composerAncestorScroll.push({at:Date.now(),class:el.className,top:el.scrollTop,left:el.scrollLeft});
      }
      const viewport = document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');
      if (viewport) {
        const scroll = { top: viewport.scrollTop, height: viewport.clientHeight, content: viewport.scrollHeight, unpinned: document.querySelector('.panel-jump')?.dataset.visible === 'true' };
        const signature = JSON.stringify(scroll);
        if (signature !== m.scrollSignature) { m.scrollSignature = signature; m.scroll.push({ at: Date.now(), ...scroll }); }
      }
      if (new Set(keys).size !== keys.length) m.violations.push({ at: Date.now(), kind: 'duplicate-row', keys });
      if (m.previous.length) {
        const common = m.previous.filter((key) => keys.includes(key));
        if (JSON.stringify(common) !== JSON.stringify(keys.filter((key) => common.includes(key)))) m.violations.push({ at: Date.now(), kind: 'reordered-row', keys, previous: m.previous });
        const removed = m.previous.filter((key) => !keys.includes(key));
        if (removed.length) m.violations.push({ at: Date.now(), kind: 'removed-row', removed, keys });
      }
      for (const el of all) if (!m.firstSeen[el.dataset.flowRow]) m.firstSeen[el.dataset.flowRow] = Date.now();
      const buttons = [...document.querySelectorAll('.text-composer-send')].filter((el) => el.offsetParent !== null);
      if (buttons.length > 1) m.violations.push({ at: Date.now(), kind: 'duplicate-primary' });
      const signature = all.map((el) => [el.dataset.flowRow, el.textContent.length, el.querySelector('[data-tool-states]')?.dataset.toolStates]);
      const text = JSON.stringify(signature);
      if (text !== m.signature) { m.signature = text; m.changes.push({ at: Date.now(), keys, signature }); }
      m.previous = keys;
      requestAnimationFrame(frame);
    };
    m.off = window.hemiVoice.onFlowChanged((event) => { const change = event.change; const changes = change.kind === 'patch' ? change.changes : [];
      for (const c of changes) {
        if (c.kind === 'item-appended' && c.item.kind === 'user') m.host.push({ at: Date.now(), kind: 'user-delivered', id: c.item.id, runId: c.item.runId });
        if (c.kind === 'meta') m.host.push({ at: Date.now(), kind: 'phase', phase: c.meta.phase, runId: c.meta.activeRunId });
      }
    });
    requestAnimationFrame(frame); return true;
  })()`);
  const collect = async () => { const value = await evalJs(`(() => { const m = window.q060Journey; if (!m || m.stopped) return null; m.stopped = true; m.off?.(); const { off, ...data } = m; return data; })()`); if (value) probes.push(value); };
  const reload = async (name) => {
    const beforeRows = await uiRows(); const before = await flow(); const origin = await evalJs('performance.timeOrigin');
    await collect(); const at = Date.now(); await send('Page.reload', { ignoreCache: true });
    await wait('真实重载并恢复正式列表', async () => {
      const next = await evalJs('performance.timeOrigin'); if (!next || next === origin) return false;
      const rows = await uiRows(); return beforeRows.every((old) => rows.some((row) => row.id === old.id));
    }, 12000);
    const after = await flow(); const afterRows = await uiRows();
    must(beforeRows.map((row) => row.id).every((id, i, all) => afterRows.findIndex((row) => row.id === id) > (i ? afterRows.findIndex((row) => row.id === all[i - 1]) : -1)), `${name}-顺序保持`);
    must(before.pending.map((p) => p.inputId).join() === after.pending.map((p) => p.inputId).join(), `${name}-队列身份保持`);
    reloads.push({ name, at, recoveredAt: Date.now(), oldOrigin: origin, newOrigin: await evalJs('performance.timeOrigin'), beforeRows, afterRows, beforePending: before.pending, afterPending: after.pending });
    await installProbe();
    // 重载后的首批 DOM 已有身份，但启动布局仍可能在改变高度；等几何稳定后
    // 截图／操作拖拽，避免拿尚在入场的旧 rect 驱动键盘坐标。
    let previousGeometry = '', stableFrames = 0;
    await wait('重载后布局稳定', async () => {
      const geometry = await evalJs(`JSON.stringify([...document.querySelectorAll('.h24-queue-tray, .text-composer, [data-transcript-scroll]')].map((el) => { const r = el.getBoundingClientRect(); return [r.x,r.y,r.width,r.height].map((n) => Math.round(n * 2)); }))`);
      stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0; previousGeometry = geometry;
      return stableFrames >= 4;
    }, 5000);
    await wait('重载后录屏恢复', () => movieFrames.some(frame => frame.at > at), 5000);
    must(movieFrames.some(frame => frame.at > at), `${name}-录屏跨重载继续`);
    await shot(name);
  };
  let recording = false;
  const receive = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push({ console: message.params.args.map((arg) => arg.description ?? arg.value) });
    if (message.method === 'Page.loadEventFired' && recording) void send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1440, maxHeight: 900, everyNthFrame: 3 }).catch(() => {});
    if (message.method !== 'Page.screencastFrame') return;
    const { data, metadata, sessionId } = message.params;
    void send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!recording) return;
    const file = `frame-${String(movieFrames.length).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(framesDir, file), Buffer.from(data, 'base64'));
    movieFrames.push({ file, at: Date.now(), metadata });
  };
  ws.addEventListener('message', receive);
  await send('Page.enable'); await send('Page.bringToFront');
  if (process.env.HEMI_Q060_NATIVE_VIEWPORT !== '1') await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const captureViewport = await evalJs('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
  await installProbe(); recording = true;
  await send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1440, maxHeight: 900, everyNthFrame: 3 });
  const A = '串联060A：仅用一次 bash 执行 sleep 18; printf "STAGE_A_DONE\\n"。得到工具结果后，再单独回答 A_FINAL_NOT_EXPECTED。不要把回答写入命令。';
  const B = '串联060B原文：只回答 B_ORIGINAL。';
  const B1 = '串联060B修改一：只回答 B_EDIT_ONE。';
  const B2 = '串联060B修改二：只回答 B_EDIT_TWO。';
  const C = '串联060C：只回答 C_DONE。';
  const D = '串联060D优先：仅用一次 bash 执行 sleep 8; printf "STAGE_D_DONE\\n"，结束后只回答 D_DONE。';
  const E = '串联060E停止：仅用 bash 执行 sleep 30，结束后只回答 E_SHOULD_NOT_FINISH。';
  const F = '串联060F恢复：只回答 F_DONE。';
  const unsent = '串联060未发送草稿：所有任务结束后仍应保留。';
  let flowA, flowD, flowE;
  try {
    stage('A 实际慢工具开始'); await submit(A);
    flowA = await wait('A 工具在途', async () => { const f = await flow(); return tools(f, f?.activeRunId).some((t) => t.status === 'running' && t.args?.command.includes('sleep 18')) ? f : null; });
    const runA = flowA.activeRunId;
    stage('连续发送 B/C/D');
    await submit(B); await submit(C); await submit(D);
    let f = await flow();
    must(f.activeRunId === runA && f.pending.map((p) => p.text).join('|') === [B, C, D].join('|'), '连续发送只排队且FIFO');
    must((await uiRows()).filter((row) => row.kind === 'user').length === 1, '排队未提前上屏');
    must(await evalJs(`!document.querySelector('.h24-queue-tray [aria-label="更多操作"]') && !document.body.innerText.includes('补充到当前任务') && typeof window.hemiVoice.supplementRunningTask === 'undefined'`), '并入菜单与预加载接口已移除');
    const retired = await evalJs(`window.hemiVoice.flowCommand(${JSON.stringify(cid)}, {type: 'mergeInput', inputId: ${JSON.stringify(f.pending[0].inputId)}, expectedEditRevision: 0})`);
    must(retired?.ok === false && retired.code === 'unsupported' && (await flow()).activeRunId === runA
      && (await flow()).pending.map((p) => p.text).join('|') === [B,C,D].join('|'), '旧并入命令拒绝且队列不变');
    if (process.env.HEMI_Q060_DRAG === '1') {
      stage('指针拖动 D 到队首，重载后键盘排序回原顺序');
      const points = await evalJs(`(() => { const rows = [...document.querySelectorAll('.h24-queue-item')]; const d = rows.find((r) => r.textContent.includes('串联060D')); const b = rows.find((r) => r.textContent.includes('串联060B')); const h = d.querySelector('.h24-queue-drag').getBoundingClientRect(); const to = b.getBoundingClientRect(); return {x: h.x+h.width/2, from: h.y+h.height/2, to: to.y+to.height/2}; })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x, y: points.from });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.x, y: points.from, button: 'left', buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 6; step++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x, y: points.from + (points.to - points.from) * step / 6, button: 'left', buttons: 1 });
        await sleep(40);
      }
      await shot('00a-dragging');
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.x, y: points.to, button: 'left', buttons: 0, clickCount: 1 });
      await wait('拖拽排序由宿主确认', async () => (await flow()).pending.map((p) => p.text).join('|') === [D, B, C].join('|'));
      must((await flow()).activeRunId === runA && (await uiRows()).filter((r) => r.kind === 'user').length === 1, '拖拽只排序不启动或打断');
      await reload('00b-reload-sorted');
      const key = async (code, key, value) => {
        for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: value, nativeVirtualKeyCode: value });
      };
      await key('Tab', 'Tab', 9);
      await evalJs(`document.querySelector('.h24-queue-item .h24-queue-drag').focus()`);
      await key('Space', ' ', 32); await sleep(100);
      await key('ArrowDown', 'ArrowDown', 40); await sleep(250);
      await key('ArrowDown', 'ArrowDown', 40); await sleep(250);
      await key('Space', ' ', 32);
      await wait('键盘排序恢复B/C/D', async () => (await flow()).pending.map((p) => p.text).join('|') === [B, C, D].join('|'));
      must(true, '真实指针与键盘排序及重载保持');
    }
    await type(unsent); stage('B 回主输入框编辑并保存原位置');
    await clickQueue('串联060B原文', '编辑这条');
    await wait('编辑模式', () => evalJs(`Boolean(document.querySelector('.queue-composer-editing'))`));
    await type(B1); await enter();
    await wait('恢复原草稿', async () => (await draft()) === unsent);
    f = await flow(); const bId = f.pending.find((p) => p.text === B1)?.inputId;
    must(Boolean(bId) && f.pending[0].inputId === bId, '编辑保持原队首');
    stage('D 请求阶段结束后优先；等待期重载');
    const priorityClickAt = Date.now(); await clickQueue('串联060D优先', '直接运行');
    await wait('等待阶段反馈', () => evalJs(`document.body.innerText.includes('等待交接')`));
    const priorityFeedbackAt = Date.now();
    f = await flow();
    must(f.activeRunId === runA && !user(f, '串联060D') && tools(f, runA).some((t) => t.status === 'running'), '当前阶段未完成D不上屏');
    await shot('01-priority-wait'); await reload('02-reload-waiting');
    must((await draft()) === unsent, '等待交接重载保留草稿');
    flowD = await wait('D 开始实际工具', async () => { const f = await flow(); const d = user(f, '串联060D'); return d && tools(f, d.runId).some((t) => t.status === 'running') ? f : null; });
    const runD = user(flowD, '串联060D').runId;
    must(flowD.runs[runA].outcome === 'stopped' && tools(flowD, runA).every((t) => t.status === 'done'), 'A阶段自然完成后交接且目标停止');
    stage('D 执行中再次编辑 B，编辑中重载');
    await clickQueue('串联060B修改一', '编辑这条'); await wait('第二次编辑', () => evalJs(`Boolean(document.querySelector('.queue-composer-editing'))`));
    await type(B2);
    await reload('03-reload-editing');
    must((await flow()).pending.find((p) => p.inputId === bId)?.editDraft?.text === B2, '立即重载也保留最新编辑稿');
    await clickQueue('串联060B修改一', '编辑这条');
    await wait('编辑稿恢复', async () => (await draft()) === B2);
    must((await flow()).pending.find((p) => p.inputId === bId)?.state === 'editing', '重载后仍锁定原项');
    await enter(); await wait('保存后恢复原草稿', async () => (await draft()) === unsent);
    stage('D 收口后 B/C 自动续排');
    await wait('B/C 全部完成', async () => { const f = await flow(); return f.phase === 'idle' && f.pending.length === 0 && user(f, '串联060C') ? f : null; });
    f = await flow();
    must(f.timeline.filter((i) => i.kind === 'user').map((i) => i.text).join('|') === [A, D, B2, C].join('|'), '完整正式输入顺序ADB修改C');
    must(user(f, '串联060B').id === bId, '编辑两次仍同一输入身份');
    must(!(await uiRows()).some((row) => row.text.includes('A_FINAL_NOT_EXPECTED') && row.kind !== 'user'), '旧A不进入下一模型阶段');
    await shot('04-drained');
    stage('E 慢工具中主动停止，F 保持暂停'); await submit(E);
    flowE = await wait('E 工具在途', async () => { const f = await flow(); const e = user(f, '串联060E'); return e && tools(f, e.runId).some((t) => t.status === 'running') ? f : null; });
    const runE = user(flowE, '串联060E').runId;
    await submit(F); await type(unsent);
    const stopClickAt = Date.now();
    must(await evalJs(`(() => { const btn = document.querySelector('.text-composer-stop'); if (!btn || btn.disabled) return false; btn.click(); return true; })()`), '主动停止按钮可用');
    await wait('E 真实停止', async () => (await flow()).runs[runE].outcome === 'stopped');
    const stopClosedAt = Date.now();
    f = await flow();
    must(f.queuePaused && !user(f, '串联060F') && f.pending.length === 1, '主动停止暂停F而不误派');
    must(tools(f, runE).every((t) => t.status === 'stopped'), 'E工具准确标停止');
    await wait('UI停止标记', () => evalJs(`document.body.innerText.includes('未完成 · 已停止')`));
    await wait('停止状态滚动跟随可见', () => evalJs(`(() => {
      const viewport = document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]');
      const last = [...document.querySelectorAll('[data-flow-row]')].at(-1)?.querySelector('.h24-reply-stopped');
      if (!viewport || !last) return false;
      const v = viewport.getBoundingClientRect(), r = last.getBoundingClientRect();
      return r.bottom <= v.bottom + 2 && r.top >= v.top;
    })()`), 2000);
    const stopVisibleAt = Date.now();
    await shot('05-stopped'); await reload('06-reload-paused');
    must((await flow()).queuePaused && (await draft()) === unsent, '暂停重载不自发执行且草稿保留');
    stage('手动上翻后收起队列，不拉回底部');
    const scrollPoint = await evalJs(`(() => { const r = document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scrollPoint, deltaX: 0, deltaY: -220 });
    await wait('用户上翻暂停跟随', () => evalJs(`document.querySelector('.panel-jump')?.dataset.visible === 'true'`));
    const readingTop = await evalJs(`document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]').scrollTop`);
    await evalJs(`document.querySelector('.h24-queue-head').click()`);
    await sleep(500);
    const readAfter = await evalJs(`(() => { const v = document.querySelector('[data-transcript-scroll] [data-slot="scroll-area-viewport"]'); return { top: v.scrollTop, distance: v.scrollHeight - v.scrollTop - v.clientHeight, unpinned: document.querySelector('.panel-jump')?.dataset.visible === 'true' }; })()`);
    must(readAfter.unpinned && Math.abs(readAfter.top - readingTop) < 2 && readAfter.distance > 36, '队列尺寸变化不抢手动历史阅读位置');
    await shot('06b-reading-position');
    await evalJs(`document.querySelector('.h24-queue-head').click(); document.querySelector('.panel-jump').click()`);
    stage('手动恢复 F 并最终重载');
    must(await evalJs(`(() => { const btn = document.querySelector('.h24-queue-resume'); if (!btn) return false; btn.click(); return true; })()`), '继续队列按钮可用');
    await wait('F 完成', async () => { const f = await flow(); return f.phase === 'idle' && !f.pending.length && user(f, '串联060F'); });
    f = await flow();
    const expected = [A, D, B2, C, E, F];
    must(f.timeline.filter((i) => i.kind === 'user').map((i) => i.text).join('|') === expected.join('|'), '最终六条输入顺序正确且各一次');
    must((await draft()) === unsent, '全链路结束未发送草稿仍保留');
    const finalRows = await uiRows();
    await reload('07-final-reload');
    must(JSON.stringify(finalRows) === JSON.stringify(await uiRows()), '最终完整结构重载相等');
    const allTools = f.timeline.flatMap((item) => item.parts ?? []).filter((part) => part.kind === 'tool');
    must(allTools.length === 3 && allTools.every((part) => part.status !== 'running'), '无工具重放或残留running');
    await collect();
    // The initial new conversation intentionally animates its first message out of the empty state.
    // Every subsequent probe belongs to a reloaded, already populated conversation.
    write('initial-empty-spacer-transition.json',probes[0]?.emptySpacerLeaks ?? []);
    const emptySpacerLeaks=probes.slice(1).flatMap(probe=>probe.emptySpacerLeaks);
    write('empty-spacer-leaks.json',emptySpacerLeaks);
    must(emptySpacerLeaks.length===0,'重载已有消息时不播放空态输入区居中动画');
    const composerAncestorScroll = probes.flatMap(probe=>probe.composerAncestorScroll);
    must(composerAncestorScroll.length===0,'队列编辑与聚焦不滚动输入区祖先容器');
    write('composer-ancestor-scroll.json',composerAncestorScroll);
    const violations = probes.flatMap((probe) => probe.violations);
    must(violations.length === 0, '所有采样帧无搬移消失重复主按钮');
    const gaps = probes.flatMap((probe) => probe.gaps);
    const deliveries = probes.flatMap((probe) => probe.host.filter((event) => event.kind === 'user-delivered').map((event) => ({ ...event, visibleAt: probe.firstSeen[event.id] ?? null })));
    const metrics = {
      priorityFeedbackMs: priorityFeedbackAt - priorityClickAt,
      stopConfirmedMs: stopClosedAt - stopClickAt,
      stopVisibleMs: stopVisibleAt - stopClickAt,
      receiptClearMs: stages.filter((s) => s.clearAt).map((s) => s.clearAt - s.at),
      frameCount: gaps.length, frameGapP50Ms: percentile(gaps, .5), frameGapP95Ms: percentile(gaps, .95), maxFrameGapMs: Math.max(...gaps),
      longFrameCount250ms: gaps.filter((gap) => gap >= 250).length,
      deliveredToVisibleMs: deliveries.filter((event) => event.visibleAt).map((event) => event.visibleAt - event.at),
      reloadRecoveryMs: reloads.map((entry) => ({ name: entry.name, ms: entry.recoveredAt - entry.at })),
      handoffRunGapMs: f.runs[runD].startedAt - f.runs[runA].closedAt,
    };
    checks.journeyPriorityFeedbackWithin250ms = metrics.priorityFeedbackMs <= 250;
    checks.journeyStopConfirmedWithin500ms = metrics.stopConfirmedMs <= 500;
    checks.journeyNoRendererStall250ms = metrics.longFrameCount250ms === 0;
    checks.journeyNoRendererException = errors.length === 0;
    write('journey-summary.json', { ok: Object.values(checks).every(Boolean), cid, captureViewport, checks, stages, metrics, violations, errors, finalRows, finalFlow: f, reloads });
    write('frame-probes.json', probes);
    stage('串联完成');
  } catch (error) {
    await shot('failure').catch(() => {});
    write('failure.json', { message: error.message, flow: await flow().catch(() => null), rows: await uiRows().catch(() => null) });
    throw error;
  } finally {
    await collect().catch(() => {});
    write('stages.json', stages); write('frame-probes.json', probes); write('runtime-errors.json', errors);
    recording = false; await send('Page.stopScreencast').catch(() => {});
    ws.removeEventListener('message', receive);
    write('screencast-frames.json', movieFrames);
    const concat = movieFrames.map((frame, index) => `file '${frame.file}'\nduration ${Math.max(.02, ((movieFrames[index + 1]?.at ?? frame.at + 1000) - frame.at) / 1000).toFixed(3)}\n`).join('');
    fs.writeFileSync(path.join(framesDir, 'frames.txt'), concat);
    await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
}
