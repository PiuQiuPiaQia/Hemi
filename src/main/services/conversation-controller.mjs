/**
 * 057 会话控制器（S1）：每会话一个，唯一拥有主运行受理／停止、待发送队列、
 * 并入占用与时间线更新（契约 §1）。四态生命周期以纯转移函数实施（idle→
 * preparing→running→stopping→idle）；XState 若接入只替换 nextFlowPhase 一处。
 *
 * 效果全部注入（runtime／store），S1 测试用可控替身以确定顺序枚举相邻事件；
 * 未接线真实 SDK——S2 才替换现有入口（llm.ipc／turn-queue／conversation-turns）。
 *
 * 关键纪律（技术方案「四条关键路径」）：
 *  - 同会话任何时刻只有一个被受理的主运行；用户新发送、队列派发、后台唤醒共用本入口。
 *  - 一条输入只能被派发一次；宿主短状态转换锁定条目（submitting），
 *    迟到操作不能取走已派发项。
 *  - 串行的是一次短状态转换，不是 await 整轮模型；stop 立即反馈，不排长任务后。
 *  - 真停止暂停队列（queuePaused 不因 settled 自动复位，显式 resumeQueue 才解除；
 *    2026-10-18 裁决补充：空队列下用户显式新任务直发时一并解除——「继续任务」
 *    按钮只在没有新任务时出现）；抢话／编辑替换（preempt）不暂停。
 */
import { applyFlowFact, createFlowSnapshot } from '../../shared/conversation-flow.mjs';

/** 纯四态转移表（导出供单测直接枚举；非法转移返回原状态）。 */
export function nextFlowPhase(phase, action) {
  switch (action) {
    case 'claim': return phase === 'idle' ? 'preparing' : phase;
    case 'ready': return phase === 'preparing' ? 'running' : phase;
    case 'prepare-failed': return phase === 'preparing' ? 'idle' : phase;
    case 'stop': return phase === 'preparing' || phase === 'running' ? 'stopping' : phase;
    case 'closed': return phase === 'preparing' || phase === 'running' || phase === 'stopping' ? 'idle' : phase;
    default: return phase;
  }
}

/**
 * @param {object} options
 * @param {string} options.conversationId
 * @param {{ runtime: object, store: object }} options.effects
 *   runtime: { start(spec)→Promise, stop(spec)→Promise }
 *   store: { update(conversationId, payload)→Promise, flush(conversationId)→Promise }
 * @param {() => number} [options.now]
 * @param {(prefix: string) => string} [options.makeId]
 * @param {number} [options.closeWaitMs] 运行收口/回卷时等待在途提交的上限；
 *   超过按「不明」继续收口（待核对不自动重发）——上游挂死不能把调度器一起钉死
 *   （2026-10-17 真机：模型请求无响应时新发送永久等待，见审计「挂死兜底」）。
 */
export function createConversationController({
  conversationId, effects, now = Date.now, makeId = defaultMakeId, closeWaitMs = 30_000,
}) {
  const { runtime, store } = effects;
  let snapshot = createFlowSnapshot({ conversationId });
  const listeners = new Set();
  /** 在途提交（inputId → promise）：目标运行关闭时先等它们返回再续排。 */
  const submissions = new Map();
  const withdrawing = new Set();
  /** 关闭后待执行的下一次运行：回卷＝裁剪＋generation+1＋替换输入；抢话＝仅替换输入。 */
  let pendingNext = null;
  /** preparing 期间被 stop/preempt 打断：迟到的准备结果不得再启动模型。 */
  let preparingAborted = false;
  const seq = { input: 0, run: 0 };
  const backgroundEvents = new Map();

  // ------------------------------------------------------------ 状态与发布

  function commit(fact) {
    if(fact.type==='run-closed'&&(fact.cleanupUnconfirmed||fact.dispatchPaused)&&snapshot.activeRunId===fact.runId&&snapshot.generation===(fact.generation??snapshot.generation)){
      // A failed handoff/save preserves its replacement for review, without dispatching it.
      if(pendingNext){
        const next=pendingNext;pendingNext=null;
        if(!snapshot.pending.some(input=>input.inputId===next.input.inputId))commit({type:'input-accepted',input:next.input,needsReview:true,generation:snapshot.generation});
      }
      // Promotion cannot bypass failed cleanup or persistence of the old run.
      for(const input of snapshot.pending.filter(input=>input.state==='pending'&&input.promoteTarget===fact.runId)){
        commit({type:'input-promoted',inputId:input.inputId,targetRunId:null,at:null,generation:snapshot.generation});
      }
      commit({type:'queue-paused',generation:snapshot.generation});
    }
    const previousActivity = snapshot.runs[fact.runId]?.activity;
    const result = applyFlowFact(snapshot, fact);
    if (!result.applied) return result;
    snapshot = result.snapshot;
    const change = {
      kind: 'patch',
      conversationId,
      generation: snapshot.generation,
      baseRevision: snapshot.revision - 1,
      revision: snapshot.revision,
      changes: result.patch.kind === 'multi' ? result.patch.changes : [result.patch],
    };
    for (const listener of listeners) {
      try { listener(change); } catch { /* 订阅方异常不阻断归约 */ }
    }
    if (fact.type === 'run-closed') {
      void postClose();
    }
    const activityChanged = fact.type === 'run-activity' && (
      previousActivity?.phase !== fact.activity?.phase
      || JSON.stringify(previousActivity?.jobs?.map(job => job.id)) !== JSON.stringify(fact.activity?.jobs?.map(job => job.id))
    );
    if (fact.type === 'input-delivered' || fact.type === 'run-closed' || fact.type === 'run-recovery' || activityChanged) {
      // 派发与收口是持久事实：长任务／退出前也必须保存正式输入，不能只留下
      // preparing 快照，让 turns 已有用户项而 flow 缺项。文本流不逐 token 写盘。
      void store.update(conversationId, { revision: snapshot.revision }).catch(() => {});
    }
    return result;
  }

  /** 等在途提交落定，最多 closeWaitMs——挂死的上游提交不阻塞后续调度（超时按不明）。 */
  async function awaitSubmissions() {
    const pending = [...submissions.values()];
    if (!pending.length) return;
    let timer = null;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => { timer = setTimeout(resolve, closeWaitMs); timer.unref?.(); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /** 运行关闭后的统一收口：等在途提交 → 回卷/抢话替换或续排；无解释的 submitting 标待核对。 */
  async function postClose() {
    await awaitSubmissions();
    for (const item of snapshot.pending.filter((entry) => entry.state === 'submitting')) {
      // 并入未落定（ACK 已返回但无投递证据）——契约 §5：不明则待核对，不自动重发。
      commit({ type: 'input-recovered', inputId: item.inputId, to: 'needs-review', generation: snapshot.generation });
    }
    if (pendingNext) {
      const next = pendingNext;
      pendingNext = null;
      if (next.cutAfterInputId) {
        commit({ type: 'generation-bumped', cutAfterInputId: next.cutAfterInputId, generation: snapshot.generation });
        if (snapshot.queuePaused && !snapshot.pending.length) commit({ type: 'queue-resumed', generation: snapshot.generation });
      }
      await startRun({ input: next.input, source: 'user' });
      return;
    }
    // 060 R-21：显式插队——旧目标停止确认后，被提升的条目**优先**于普通队首先行派发
    //（提升请求在停止前已持久；A 不续跑；普通队列 C 在其后按 FIFO 继续，不暂停队列）。
    maybeDrain();
  }

  // ------------------------------------------------------------ 主运行启动（用户发送/队列派发/事件唤醒共用）

  async function startRun({ input, source, fromPending = false, background = null }) {
    const runId = makeId(`run-${++seq.run}`);
    const continuationOf = input && !input.workflow ? snapshot.awaitingUser?.runId ?? null : null;
    preparingAborted = false;
    commit({ type: 'run-preparing', runId, continuationOf, source, inputIds: input ? [input.inputId] : [], at: now(), generation: snapshot.generation });
    try {
      // 受理先落最小快照再执行（契约 §8）：运行记录带 inputIds 保存输入身份；
      // 用户消息项在保存成功后才转正（失败回 pending 时时间线不留残影）。
      await store.update(conversationId, { revision: snapshot.revision });
    } catch (error) {
      if(background)backgroundEvents.set(background.rootRunId,background);
      return failStart(runId, input, fromPending, 'storage-failed', error);
    }
    if (preparingAborted || snapshot.activeRunId !== runId) {
      // 准备期间被停止/回卷：迟到准备结果不得启动模型（契约 §4）。
      commit({ type: 'run-closed', runId, outcome: 'stopped', at: now(), generation: snapshot.generation });
      return { ok: false, code: 'run-changed' };
    }
    if (input) {
      // 空闲直发/队首派发：保存成功即转正为用户消息项（R-04 派发=展示口径）。
      commit({ type: 'input-delivered', input, runId, at: now(), generation: snapshot.generation });
    }
    let started;
    try {
      started = await runtime.start({ conversationId, generation: snapshot.generation, runId, continuationOf, envelope: input, source, ...(background?{background}: {}) });
    } catch (error) {
      // 真实适配层在运行终态时已自行 applyFact 关闭运行（自闭合）——那种情况不重复收口。
      if (snapshot.activeRunId !== runId) {
        return { ok: false, code: 'runtime-failed', message: String(error?.message ?? error), runId };
      }
      if(background)backgroundEvents.set(background.rootRunId,background);
      return failStart(runId, input, fromPending, 'runtime-failed', error);
    }
    if (snapshot.activeRunId === runId && !preparingAborted) {
      // 替身语义（runtime 不自闭合）：成功返回即占稳运行槽。
      commit({ type: 'run-started', runId, at: now(), modelUsed: started?.modelUsed ?? null, generation: snapshot.generation });
      return { ok: true, disposition: 'started', runId, inputId: input?.inputId ?? null, runtimeResult: started ?? null };
    }
    if (snapshot.activeRunId === runId && preparingAborted) {
      // stop 恰落在 runtime.start 在途（替身语义）：补取消；关闭事实由适配层回。
      void runtime.stop({ conversationId, generation: snapshot.generation, runId, reason: 'stop' }).catch(() => {});
      return { ok: true, disposition: 'stop-requested', runId };
    }
    // 真实适配层已自闭合（成功收口或被停止）：结果随 started 透传。
    return {
      ok: true,
      disposition: started?.aborted ? 'stop-requested' : 'started',
      runId,
      inputId: input?.inputId ?? null,
      runtimeResult: started ?? null,
    };
  }

  /** 启动失败收口：运行关闭＋输入回可见状态（队列项回 pending，直发项补入队）。
   * 保存/启动失败暂停自动续排（契约 §8：重试需用户操作），恢复的输入不再自动派发。 */
  function failStart(runId, input, fromPending, code, error) {
    commit({ type: 'run-closed', runId, outcome: 'failed', at: now(), generation: snapshot.generation });
    commit({ type: 'queue-paused', generation: snapshot.generation });
    if (input) {
      if (fromPending) {
        commit({ type: 'input-recovered', inputId: input.inputId, to: 'pending', generation: snapshot.generation });
      } else {
        commit({ type: 'input-accepted', input: { ...input, createdAt: now() }, generation: snapshot.generation });
      }
    }
    return { ok: false, code, message: String(error?.message ?? error), runId };
  }

  // ------------------------------------------------------------ 队列派发（FIFO；暂停不派）

  function maybeDrain() {
    if (snapshot.phase !== 'idle') return;
    // 显式优先允许单独处理选中项，普通队列仍可保持暂停。编辑中的队首不能被后项越过。
    const promoted = snapshot.pending.find((entry) => entry.state === 'pending' && entry.promoteAt != null);
    if (snapshot.queuePaused && !promoted) return;
    const next = promoted ?? snapshot.pending[0];
    if (next && (next.state !== 'pending' || withdrawing.has(next.inputId))) return;
    if (!next) {
      if(!snapshot.awaitingUser&&backgroundEvents.size){
        const [key,event]=backgroundEvents.entries().next().value;
        backgroundEvents.delete(key);
        if(event.generation===snapshot.generation)void startRun({input:null,source:'event',background:event});
        else maybeDrain();
        return;
      }
      maybeDrainReports();
      return;
    }
    void (async () => {
      // 占用条目（submitting 后不能再次消费）。
      if (!commit({ type: 'input-locked', inputId: next.inputId, generation: snapshot.generation }).applied) return;
      const submission = startRun({ input: next, source: 'queue', fromPending: true });
      submissions.set(next.inputId, submission);
      try { await submission; } finally { submissions.delete(next.inputId); }
    })();
  }

  /** 后台报告待处理（Q3 建议：非暂停时空闲自动转述；队列优先）。 */
  function maybeDrainReports() {
    if (snapshot.phase !== 'idle' || snapshot.awaitingUser || snapshot.queuePaused || snapshot.pendingReports.length === 0) return;
    const report = snapshot.pendingReports[0];
    commit({ type: 'report-consumed', taskId: report.taskId, resultVersion: report.resultVersion, generation: snapshot.generation });
    void startRun({ input: null, source: 'event' });
  }

  // ------------------------------------------------------------ 命令实现

  async function handleSend(inputSpec, { preempt = 'none' } = {}) {
    const inputId = inputSpec.inputId ?? makeId(`in-${++seq.input}`);
    // 停止屏障尚未关闭时，同一通话请求重试仍是同一受理；另一次输入不能覆盖它。
    if (pendingNext?.input?.inputId === inputId) {
      return { ok: true, disposition: 'preempting', inputId, runId: snapshot.activeRunId };
    }
    if (
      snapshot.pending.some((entry) => entry.inputId === inputId)
      || Object.values(snapshot.runs).some(run => run.inputIds?.includes(inputId))
      || snapshot.timeline.some((entry) => (entry.kind === 'user' && entry.id === inputId) || entry.inputId === inputId)
    ) {
      const existingRun = Object.values(snapshot.runs).find(run => run.inputIds?.includes(inputId));
      return Promise.resolve({ ok: true, disposition: 'already-accepted', inputId, ...(existingRun ? {runId: existingRun.runId} : {}) });
    }
    if (preempt === 'active' && pendingNext) return { ok: false, code: 'handoff-busy', inputId };
    if (runtime.freezeInput && !inputSpec.workflow && !inputSpec.modelPolicySnapshot) inputSpec = { ...inputSpec, ...await runtime.freezeInput(inputSpec) };
    const input = {
      inputId,
      editRevision: 0,
      text: inputSpec.text ?? '',
      inputSource: inputSpec.inputSource ?? 'text',
      attachmentIds: structuredClone(inputSpec.attachmentIds ?? []),
      attachmentViews: structuredClone(inputSpec.attachmentViews ?? []),
      ...(inputSpec.profileId !== undefined ? { profileId: inputSpec.profileId } : {}),
      ...(inputSpec.workspaceId !== undefined ? { workspaceId: inputSpec.workspaceId } : {}),
      ...(inputSpec.modelPolicySnapshot ? { modelPolicySnapshot: structuredClone(inputSpec.modelPolicySnapshot) } : {}),
      ...(inputSpec.workspaceSnapshot ? { workspaceSnapshot: structuredClone(inputSpec.workspaceSnapshot) } : {}),
      references: structuredClone(inputSpec.references ?? null),
      // 063：显式技能选择随 inputId 冻结（派发还原与队列/历史回显共用同一身份）。
      skills: structuredClone(inputSpec.skills ?? null),
      // 059：workflow-start 结构化输入（invocationId/workflowRunId 等）——runtime router
      // 据此分派，不冒充用户文字；普通输入恒为 null。
      workflow: inputSpec.workflow ?? null,
      createdAt: now(),
    };
    if (snapshot.phase !== 'idle' || snapshot.pending.length) {
      // preempt='active'（llm:chat 用户直发口径）：抢话替换——取消当前运行，
      // 关闭后立刻作为新回合重发；不暂停队列（沿用既有抢话语义）。其余情况默认排队。
      if (preempt === 'active' && snapshot.activeRunId) {
        const mine = { input };
        pendingNext = mine;
        const stopResult = await commandStop({ type: 'stop', reason: 'preempt' });
        if (snapshot.phase === 'idle' && pendingNext === mine) {
          // 目标运行在受理与停止之间自行收口：postClose 不会再触发，直接起跑。
          pendingNext = null;
          return startRun({ input, source: 'user' });
        }
        return {
          ok: stopResult.ok,
          disposition: stopResult.ok ? 'preempting' : stopResult.code,
          inputId,
          runId: stopResult.runId ?? null,
        };
      }
      const accepted = commit({ type: 'input-accepted', input, generation: snapshot.generation });
      if (!accepted.applied) {
        return Promise.resolve({ ok: false, code: accepted.dropped === 'queue-full' ? 'queue-full' : 'invalid', inputId });
      }
      return store.update(conversationId, { revision: snapshot.revision })
        .then(() => { maybeDrain(); return { ok: true, disposition: 'queued', inputId, revision: snapshot.revision }; })
        .catch(() => {
          commit({ type: 'input-withdrawn', inputId, generation: snapshot.generation });
          return { ok: false, code: 'storage-failed', inputId };
        });
    }
    // 2026-10-18 用户裁决：手动停止后没有新任务时只展示「继续任务」按钮——
    // 用户显式发起新任务（idle 且空队列的直发）即离开「停止待继续」态：空队列的
    // 暂停随之解除（按钮退场、被扣住的后台交代恢复转述）；有排队项仍走上面排队分支。
    if (snapshot.queuePaused) commit({ type: 'queue-resumed', generation: snapshot.generation });
    return startRun({ input, source: 'user' });
  }

  async function commandSend(command) {
    const recovering = ['waiting','offline','connecting'].includes(snapshot.runs[snapshot.activeRunId]?.recovery?.phase);
    return handleSend(command.input ?? {}, { preempt: recovering ? 'none' : command.preempt ?? 'none' });
  }

  async function commandStop(command) {
    const reason = command.reason ?? 'stop';
    if (snapshot.phase === 'idle' && snapshot.awaitingUser && reason === 'stop') {
      const runId=snapshot.awaitingUser.runId;
      if (command.targetRunId && command.targetRunId !== runId) return {ok:false,code:'run-changed'};
      await runtime.cancelWaitingUser?.({conversationId,runId,generation:snapshot.generation});
      commit({type:'user-wait-cancelled',runId,at:now(),generation:snapshot.generation});
      commit({type:'queue-paused',generation:snapshot.generation});
      await store.update(conversationId,{revision:snapshot.revision});
      return {ok:true,disposition:'stopped',runId};
    }
    const targetRunId = Object.hasOwn(command, 'targetRunId') ? command.targetRunId : snapshot.activeRunId;
    if (targetRunId !== snapshot.activeRunId) return { ok: false, code: 'run-changed' };
    if (reason === 'stop') {
      for (const item of snapshot.pending.filter((entry) => entry.promoteAt != null)) {
        commit({ type: 'input-promoted', inputId: item.inputId, targetRunId: null, at: null, generation: snapshot.generation });
      }
    }
    if (snapshot.phase === 'stopping') {
      if (reason === 'stop' && snapshot.runs[snapshot.activeRunId]?.stopReason === 'promote') {
        commit({ type: 'run-stopping', runId: snapshot.activeRunId, reason: 'stop', generation: snapshot.generation });
        void runtime.stop({ conversationId, runId: snapshot.activeRunId, reason: 'stop' }).catch(() => {});
      }
      return { ok: true, disposition: 'stop-requested', runId: snapshot.activeRunId };
    }
    if (snapshot.phase === 'running' || snapshot.phase === 'preparing') {
      const runId = snapshot.activeRunId;
      preparingAborted = true;
      commit({ type: 'run-stopping', runId, reason, at: now(), generation: snapshot.generation });
      if (reason === 'stop') commit({ type: 'queue-paused', generation: snapshot.generation });
      void runtime.stop({ conversationId, generation: snapshot.generation, runId, reason }).catch(() => {});
      return { ok: true, disposition: 'stop-requested', runId, revision: snapshot.revision };
    }
    if (command.pauseQueue) commit({ type: 'queue-paused', generation: snapshot.generation });
    return { ok: true, disposition: 'idle', revision: snapshot.revision };
  }

  /** 060 R-21/R-23：显式插队——持久受理优先关系后才请求停止旧目标；停止确认由
   *  postClose 的优先派发承担（A 原位保留已停止记录、不自动续跑、不重新入队）。
   *  空闲时无旧目标：仅标记提升，交由 maybeDrain/postClose 优先派发。 */
  async function commandPromote(command) {
    const item = snapshot.pending.find((entry) => entry.inputId === command.inputId);
    if (!item) return { ok: false, code: 'not-found' };
    if (item.state !== 'pending' || withdrawing.has(item.inputId)) return { ok: false, code: 'locked' };
    if (item.promoteAt != null) return { ok: true, disposition: 'already-promoting', inputId: item.inputId };
    const targetRunId = command.targetRunId ?? snapshot.activeRunId ?? null;
    const result = commit({
      type: 'input-promoted', inputId: command.inputId, targetRunId, at: now(), generation: snapshot.generation,
    });
    if (!result.applied) return { ok: false, code: result.dropped ?? 'invalid' };
    try {
      await store.update(conversationId, { revision: snapshot.revision });
    } catch {
      commit({ type: 'input-promoted', inputId: command.inputId, targetRunId: null, at: null, generation: snapshot.generation });
      return { ok: false, code: 'storage-failed' };
    }
    if (targetRunId && snapshot.activeRunId === targetRunId && (snapshot.phase === 'running' || snapshot.phase === 'preparing')) {
      // 保存成功后才停止旧目标（契约 §1：保存失败则 A 继续，不出现「旧停了新没接上」）。
      const stopResult = await commandStop({ type: 'stop', reason: 'promote', targetRunId });
      if (!stopResult.ok) return { ok: false, code: stopResult.code };
      return { ok: true, disposition: 'promoting', inputId: command.inputId, runId: stopResult.runId ?? null };
    }
    maybeDrain();
    return { ok: true, disposition: 'promoted', inputId: command.inputId };
  }

  async function commandRewind(command) {
    const accepted = () => {
      if (pendingNext) return pendingNext.input.inputId === command.input?.inputId
        ? {ok: true, disposition: 'rewinding', replacementInputId: pendingNext.input.inputId, runId: snapshot.activeRunId}
        : {ok: false, code: 'handoff-busy'};
      const run = command.input?.inputId && Object.values(snapshot.runs).find(run => run.inputIds?.includes(command.input.inputId));
      return run ? {ok: true, disposition: 'already-accepted', inputId: command.input.inputId, runId: run.runId} : null;
    };
    const previous = accepted();
    if (previous) return previous;
    if (!snapshot.timeline.some((entry) => entry.kind === 'user' && entry.id === command.targetInputId)) {
      return { ok: false, code: 'not-found' };
    }
    const generation = snapshot.generation;
    const frozen = runtime.freezeInput ? await runtime.freezeInput(command.input ?? {}) : {};
    if (snapshot.phase === 'idle') await awaitSubmissions();
    // Freezing may await files/model configuration. A competing rewind can finish
    // during that wait; never cut its newer timeline or overwrite its handoff.
    const competing = accepted();
    if (competing) return competing;
    if (snapshot.generation !== generation || !snapshot.timeline.some(entry => entry.kind === 'user' && entry.id === command.targetInputId))
      return {ok: false, code: 'conflict'};
    const replacement = {
      ...frozen,
      inputId: command.input?.inputId ?? makeId(`in-${++seq.input}`),
      editRevision: 0,
      text: command.input?.text ?? '',
      inputSource: command.input?.inputSource ?? 'text',
      attachmentIds: command.input?.attachmentIds ?? [],
      references: command.input?.references ?? null,
      skills: command.input?.skills ?? null,
      createdAt: now(),
    };
    if (snapshot.phase !== 'idle') {
      // 只有等待旧运行关闭时才登记接续；空闲直启不能留给 postClose 再消费一次。
      pendingNext = { input: replacement, cutAfterInputId: command.targetInputId };
      const stopResult = await commandStop({ type: 'stop', reason: 'preempt', targetRunId: snapshot.activeRunId });
      if (!stopResult.ok) return stopResult;
      return { ok: true, disposition: 'rewinding', runId: stopResult.runId ?? null, replacementInputId: replacement.inputId };
    }
    commit({ type: 'generation-bumped', cutAfterInputId: command.targetInputId, generation: snapshot.generation });
    if (snapshot.queuePaused && !snapshot.pending.length) commit({ type: 'queue-resumed', generation: snapshot.generation });
    return startRun({ input: replacement, source: 'user' });
  }

  // ------------------------------------------------------------ 对外 API

  return {
    conversationId,
    enqueueBackground(event) {
      if(!event?.rootRunId||event.generation!==snapshot.generation)return false;
      backgroundEvents.set(event.rootRunId,event);
      maybeDrain();
      return true;
    },

    getSnapshot: () => snapshot,

    /** 恢复/引导：用持久快照整体替换当前状态（revision 沿用、不广播——订阅方取快照）。 */
    restore(restored) {
      if (!restored || typeof restored !== 'object' || typeof restored.revision !== 'number') return false;
      snapshot = restored;
      return true;
    },

    /** 订阅补丁流（UI 先订阅再取快照；条目连续文本合批由桥层做，S2 接线）。 */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** 运行事实入口（runtime 适配层调用）：身份校验在归约层，旧回执按 generation/runId 丢弃。 */
    applyFact(fact) {
      return commit(fact);
    },

    /** 外部运行（事件回合等未走 runtime 的执行）收口后的续排触发；暂停时不派。 */
    poke() {
      maybeDrain();
    },

    async command(command) {
      switch (command.type) {
        case 'send': return commandSend(command);
        case 'backgroundCommand': {
          if((snapshot.activeRunId!==command.targetRunId&&snapshot.runs[command.targetRunId]?.outcome!=='awaiting-background') || snapshot.phase==='stopping')return {ok:false,code:'run-changed'};
          if(!['list','read','review','stop'].includes(command.action))return {ok:false,code:'unsupported'};
          try {return {ok:true,data:await runtime.backgroundCommand?.({runId:command.targetRunId,action:command.action,jobId:command.jobId,from:command.from})};}
          catch(error){return {ok:false,code:'failed',message:error.message};}
        }
        case 'retryRecovery': {
          const run = snapshot.runs[snapshot.activeRunId];
          if (!run || command.targetRunId !== run.runId || command.recoveryId !== run.recovery?.id || !['waiting','offline'].includes(run.recovery.phase)) return { ok: false, code: 'run-changed' };
          return runtime.retryRecovery?.({ runId: run.runId, recoveryId: command.recoveryId }) ?? { ok: false, code: 'unsupported' };
        }
        case 'reorderInput': {
          const result = commit({ type: 'input-reordered', inputId: command.inputId, overInputId: command.overInputId,
            expectedInputIds: command.expectedInputIds, generation: snapshot.generation });
          if (!result.applied) return { ok: result.dropped === 'no-op', code: result.dropped };
          try { await store.update(conversationId, { revision: snapshot.revision }); }
          catch { return { ok: false, code: 'storage-failed' }; }
          return { ok: true, disposition: 'reordered', revision: snapshot.revision };
        }
        case 'saveInputEditDraft': {
          const result = commit({ type: 'input-edit-draft', inputId: command.inputId, draftRevision: command.draftRevision,
            patch: structuredClone(command.patch ?? {}), generation: snapshot.generation });
          if (!result.applied) return { ok: result.dropped === 'stale-input', code: result.dropped };
          try { await store.update(conversationId, { revision: snapshot.revision }); return { ok: true }; }
          catch { return { ok: false, code: 'storage-failed' }; }
        }
        case 'beginEditInput':
        case 'finishEditInput': {
          const original = snapshot.pending.find((entry) => entry.inputId === command.inputId);
          if (!original) return { ok: false, code: 'not-found' };
          if(original.workflow)return {ok:false,code:'workflow-frozen'};
          const begin = command.type === 'beginEditInput';
          if (begin && original.state === 'editing') return { ok: true, disposition: 'editing', inputId: original.inputId, input: structuredClone(original) };
          if (begin && snapshot.pending.some((entry) => entry.state === 'editing')) return { ok: false, code: 'locked' };
          const patch = begin || command.cancel ? null : {
            text: String(command.patch?.text ?? '').trim(),
            attachmentIds: structuredClone(command.patch?.attachmentIds ?? original.attachmentIds ?? []),
            attachmentViews: structuredClone(command.patch?.attachmentViews ?? original.attachmentViews ?? []),
            references: structuredClone(command.patch?.references ?? original.references ?? []),
            // 063：队列编辑保存的技能身份与正文/引用同批（保存不是发送，不新增回合）。
            skills: structuredClone(command.patch?.skills ?? original.skills ?? []),
          };
          if (patch && !patch.text && !patch.attachmentIds.length) return { ok: false, code: 'empty' };
          const result = commit({ type: begin ? 'input-edit-started' : 'input-edit-finished', inputId: original.inputId,
            expectedEditRevision: command.expectedEditRevision, patch, generation: snapshot.generation });
          if (!result.applied) return { ok: false, code: result.dropped };
          try { await store.update(conversationId, { revision: snapshot.revision }); }
          catch { commit({ type: 'input-edit-restored', inputId: original.inputId, input: original, generation: snapshot.generation }); return { ok: false, code: 'storage-failed' }; }
          const input = structuredClone(snapshot.pending.find((entry) => entry.inputId === original.inputId));
          if (!begin) maybeDrain();
          return { ok: true, disposition: begin ? 'editing' : 'updated', inputId: original.inputId, input };
        }
        case 'updateInput': {
          if(snapshot.pending.find(input=>input.inputId===command.inputId)?.workflow)return {ok:false,code:'workflow-frozen'};
          const result = commit({
            type: 'input-updated', inputId: command.inputId,
            expectedEditRevision: command.expectedEditRevision, patch: command.patch, generation: snapshot.generation,
          });
          if (!result.applied) {
            const code = result.dropped === 'stale-input' ? 'stale-input' : result.dropped === 'locked' ? 'locked' : 'not-found';
            return { ok: false, code };
          }
          return { ok: true, disposition: 'updated', inputId: command.inputId, revision: snapshot.revision };
        }
        case 'withdrawInput': {
          const original=snapshot.pending.find(input=>input.inputId===command.inputId);
          if(!original)return {ok:false,code:'not-found'};
          if(command.restoreToDraft) {
            if(original.workflow)return {ok:false,code:'workflow-frozen'};
            if(!['pending','editing'].includes(original.state)||original.promoteAt!=null)return {ok:false,code:'locked'};
            if(command.expectedEditRevision!=null&&command.expectedEditRevision!==original.editRevision)return {ok:false,code:'stale-input'};
          }
          if(withdrawing.has(original.inputId)||(original.state==='submitting'&&!command.force))return {ok:false,code:'locked'};
          withdrawing.add(original.inputId);
          try {
            if(original.workflow)await runtime.withdraw?.({input:original});
            const result=commit({type:'input-withdrawn',inputId:original.inputId,force:command.force===true,generation:snapshot.generation});
            return result.applied?{ok:true,disposition:'withdrawn',inputId:original.inputId,revision:snapshot.revision,
              ...(command.restoreToDraft?{input:structuredClone(original)}:{})}:{ok:false,code:result.dropped};
          } catch(error){return {ok:false,code:'storage-failed',message:error.message};}
          finally {withdrawing.delete(original.inputId);maybeDrain();}
        }
        case 'resendInput': {
          // 用户显式重发中断/待核对输入：撤下原条目、按原文走一次全新 send（禁止自动调用）。
          const item = snapshot.pending.find((entry) => entry.inputId === command.inputId);
          if (!item) return { ok: false, code: 'not-found' };
          if(item.workflow)return {ok:false,code:'workflow-frozen'};
          commit({ type: 'input-withdrawn', inputId: command.inputId, force: true, generation: snapshot.generation });
          return handleSend({ ...item, inputId: undefined, modelPolicySnapshot: undefined, workspaceSnapshot: undefined });
        }
        case 'stop': return commandStop(command);
        case 'resumeQueue': {
          const result = commit({ type: 'queue-resumed', generation: snapshot.generation });
          // 解除要落盘：否则只改内存，控制器重建/重启后暂停位复活（2026-10-18 真机）。
          if (result.applied) void store.update(conversationId, { revision: snapshot.revision }).catch(() => {});
          maybeDrain();
          return { ok: true, disposition: result.applied ? 'resumed' : 'already', revision: snapshot.revision };
        }
        case 'promoteInput': return commandPromote(command);
        case 'rewind': return commandRewind(command);
        default: return { ok: false, code: 'unsupported' };
      }
    },

    /** 退出/淘汰前收口（S2 接线用；S1 供测试）。 */
    async close({ outcome = 'interrupted' } = {}) {
      if (snapshot.phase !== 'idle' && snapshot.activeRunId) {
        preparingAborted = true;
        const runId = snapshot.activeRunId;
        commit({ type: 'run-stopping', runId, reason: 'stop', at: now(), generation: snapshot.generation });
        await runtime.stop({ conversationId, generation: snapshot.generation, runId, reason: 'stop' }).catch(() => {});
        commit({ type: 'run-closed', runId, outcome, at: now(), generation: snapshot.generation });
      }
      await awaitSubmissions();
      await store.flush(conversationId).catch(() => {});
    },
  };
}

let idCounter = 0;
function defaultMakeId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
