/**
 * 057 对话流纯数据归约（S1）：稳定身份、有序时间线、待发送队列与旧回执过滤。
 *
 * 本模块只做内存状态归约：不依赖 Electron／SDK／React／文件系统，不执行 IO、
 * 不调用模型、不派任务（契约 §1）。事件（fact）是进程内类型与测试输入，
 * 不作持久事件协议；生产保存的是归约后的快照。
 *
 * 核心不变量（技术方案「成功不变量」）：
 *  1. 同会话最多一个主运行——phase 四态（idle/preparing/running/stopping）＋activeRunId。
 *  2. 一条输入一个稳定 inputId，只能被「排队派发」或「并入」消费一次。
 *  3. timeline 数组顺序即展示顺序；条目创建后位置稳定，只原位更新自身。
 *  4. 旧 generation／外 runId 的回执不能改变当前状态（迟到事实按身份丢弃）。
 *  5. revision 只在事实真实改变状态时递增（同步用）；generation 只随回卷/重建递增。
 */

export const FLOW_SCHEMA_VERSION = 1;
export const PENDING_CAPACITY = 8;

/** 会话主运行四态（XState 候选仅覆盖这一小块；S1 以纯转移函数实施，可整体替换）。 */
export const FLOW_PHASES = ['idle', 'preparing', 'running', 'stopping'];

/**
 * @param {object} [options]
 * @param {string} options.conversationId
 * @param {number} [options.revision] 恢复时从已提交快照继续递增
 * @param {number} [options.generation]
 * @returns {object}
 */
export function createFlowSnapshot({ conversationId, revision = 0, generation = 1 }) {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    conversationId,
    revision,
    generation,
    phase: 'idle',
    activeRunId: null,
    queuePaused: false,
    pending: [],
    timeline: [],
    runs: {},
    tasks: {},
    artifacts: {},
    permissions: {},
    pendingReports: [],
  };
}

/** 运行是否仍可接受该 runId 的事实（未关闭且非更早 generation 的遗留运行）。 */
function runAccepts(snapshot, runId) {
  const run = snapshot.runs[runId];
  return Boolean(run && !run.closedAt);
}

/** 定位 run 内最后一个助手段（afterInputId 匹配；不匹配则新建段）。 */
function assistantItemFor(snapshot, runId, afterInputId) {
  for (let i = snapshot.timeline.length - 1; i >= 0; i -= 1) {
    const item = snapshot.timeline[i];
    if (item.kind === 'assistant' && item.runId === runId && item.afterInputId === (afterInputId ?? null)) return item;
  }
  return null;
}

function touchPartTarget(snapshot, fact) {
  const runId = fact.runId;
  if (snapshot.generation !== (fact.generation ?? snapshot.generation)) return null;
  if (!runAccepts(snapshot, runId)) return null;
  const partId = fact.partId ?? fact.part?.partId;
  for (let i = snapshot.timeline.length - 1; i >= 0; i -= 1) {
    const item = snapshot.timeline[i];
    if (item.kind !== 'assistant' || item.runId !== runId) continue;
    const part = item.parts.find((p) => p.partId === partId);
    if (part) return { item, part };
  }
  return null;
}

/**
 * 应用一条运行事实。返回 { snapshot, patch, applied }：
 * - applied=false 表示按身份判定丢弃（旧 generation／外 run／重复投递），状态与 revision 不变；
 * - patch 是该事实的最小补丁（FlowPatch），供桥层发布与测试断言。
 *
 * @param {object} snapshot
 * @param {object} fact
 */
export function applyFlowFact(snapshot, fact) {
  const generation = fact.generation ?? snapshot.generation;
  if (generation !== snapshot.generation) return { snapshot, patch: null, applied: false, dropped: 'stale-generation' };

  switch (fact.type) {
    case 'workflow-card-upserted': {
      const card = fact.card;
      if (!card?.invocationId) return { snapshot, patch: null, applied: false };
      const itemId = `workflow-${card.invocationId}`;
      const previous = snapshot.timeline.find(item => item.itemId === itemId);
      const runId = previous?.runId ?? `preparation-${card.invocationId}`;
      const part = { ...previous?.parts?.[0], ...card, kind: 'workflow-card', partId: `card-${card.invocationId}` };
      const item = { ...previous, itemId, kind: 'assistant', runId, afterInputId: previous?.afterInputId ?? null, parts: [part] };
      const timeline = previous ? snapshot.timeline.map(row => row.itemId === itemId ? item : row) : [...snapshot.timeline, item];
      const runs = snapshot.runs[runId] ? snapshot.runs : { ...snapshot.runs, [runId]: { runId, inputIds: [], startedAt: fact.at, closedAt: fact.at, outcome: 'completed' } };
      const next = { ...snapshot, revision: snapshot.revision + 1, timeline, runs };
      return { snapshot: next, patch: { kind: 'multi', changes: [{kind:'runs', runs}, {kind: previous ? 'item-updated' : 'item-appended', item}] }, applied: true };
    }
    case 'input-accepted': {
      if (snapshot.pending.some((entry) => entry.inputId === fact.input.inputId)) {
        return { snapshot, patch: null, applied: false, dropped: 'duplicate-input' };
      }
      if (snapshot.pending.length >= PENDING_CAPACITY) {
        return { snapshot, patch: null, applied: false, dropped: 'queue-full' };
      }
      const next = { ...snapshot, revision: snapshot.revision + 1, pending: [...snapshot.pending, { ...fact.input, state: 'pending', targetRunId: null }] };
      return { snapshot: next, patch: { kind: 'queue', pending: next.pending }, applied: true };
    }
    case 'input-edit-started':
    case 'input-edit-draft':
    case 'input-edit-finished':
    case 'input-edit-restored': {
      const index = snapshot.pending.findIndex((entry) => entry.inputId === fact.inputId);
      if (index < 0) return { snapshot, patch: null, applied: false, dropped: 'not-found' };
      const current = snapshot.pending[index];
      const expectedState = fact.type === 'input-edit-started' ? 'pending' : 'editing';
      if (fact.type !== 'input-edit-restored' && current.state !== expectedState) return { snapshot, patch: null, applied: false, dropped: 'locked' };
      if (fact.expectedEditRevision != null && current.editRevision !== fact.expectedEditRevision) return { snapshot, patch: null, applied: false, dropped: 'stale-input' };
      if (fact.type === 'input-edit-draft' && fact.draftRevision <= (current.editDraftRevision ?? -1)) return { snapshot, patch: null, applied: false, dropped: 'stale-input' };
      const updated = fact.type === 'input-edit-restored' ? fact.input : fact.type === 'input-edit-draft'
        ? { ...current, editDraft: fact.patch, editDraftRevision: fact.draftRevision }
        : fact.type === 'input-edit-started'
        ? { ...current, state: 'editing' }
        : { ...current, ...(fact.patch ?? {}), editDraft: undefined, editDraftRevision: undefined, state: 'pending', editRevision: current.editRevision + (fact.patch ? 1 : 0) };
      const pending = snapshot.pending.map((entry, i) => i === index ? updated : entry);
      const next = { ...snapshot, revision: snapshot.revision + 1, pending };
      return { snapshot: next, patch: { kind: 'queue', pending }, applied: true };
    }
    case 'input-updated': {
      const index = snapshot.pending.findIndex((entry) => entry.inputId === fact.inputId);
      if (index < 0) return { snapshot, patch: null, applied: false, dropped: 'not-found' };
      const current = snapshot.pending[index];
      if (current.state !== 'pending') return { snapshot, patch: null, applied: false, dropped: 'locked' };
      if (fact.expectedEditRevision != null && current.editRevision !== fact.expectedEditRevision) {
        return { snapshot, patch: null, applied: false, dropped: 'stale-input' };
      }
      const updated = {
        ...current,
        ...(fact.patch.text !== undefined ? { text: fact.patch.text } : {}),
        ...(fact.patch.attachmentIds !== undefined ? { attachmentIds: fact.patch.attachmentIds } : {}),
        ...(fact.patch.references !== undefined ? { references: fact.patch.references } : {}),
        ...(fact.patch.skills !== undefined ? { skills: fact.patch.skills } : {}),
        ...(fact.patch.text !== undefined && fact.patch.text !== current.text ? { editRevision: current.editRevision + 1 } : {}),
      };
      const pending = snapshot.pending.map((entry, i) => (i === index ? updated : entry));
      const next = { ...snapshot, revision: snapshot.revision + 1, pending };
      return { snapshot: next, patch: { kind: 'queue', pending }, applied: true };
    }
    case 'input-reordered': {
      const ids = snapshot.pending.map((entry) => entry.inputId);
      if (!Array.isArray(fact.expectedInputIds) || ids.length !== fact.expectedInputIds.length
        || ids.some((id, index) => id !== fact.expectedInputIds[index])) {
        return { snapshot, patch: null, applied: false, dropped: 'stale-queue' };
      }
      const from = ids.indexOf(fact.inputId), to = ids.indexOf(fact.overInputId);
      if (from < 0 || to < 0) return { snapshot, patch: null, applied: false, dropped: 'not-found' };
      if (from === to) return { snapshot, patch: null, applied: false, dropped: 'no-op' };
      // 编辑项的位置是承诺；待交接与投递未明项同样是锚点，不能靠拖拽越过。
      if (snapshot.pending.slice(Math.min(from, to), Math.max(from, to) + 1)
        .some((entry) => entry.state !== 'pending' || entry.promoteAt != null)) {
        return { snapshot, patch: null, applied: false, dropped: 'locked' };
      }
      const pending = [...snapshot.pending];
      pending.splice(to, 0, pending.splice(from, 1)[0]);
      const next = { ...snapshot, revision: snapshot.revision + 1, pending };
      return { snapshot: next, patch: { kind: 'queue', pending }, applied: true };
    }
    case 'input-withdrawn': {
      const index = snapshot.pending.findIndex((entry) => entry.inputId === fact.inputId);
      if (index < 0) return { snapshot, patch: null, applied: false, dropped: 'not-found' };
      const current = snapshot.pending[index];
      if (current.state === 'submitting' && !fact.force) {
        return { snapshot, patch: null, applied: false, dropped: 'locked' };
      }
      const pending = snapshot.pending.filter((_, i) => i !== index);
      const next = { ...snapshot, revision: snapshot.revision + 1, pending };
      return { snapshot: next, patch: { kind: 'queue', pending }, applied: true };
    }
    case 'input-promoted': {
      // 060 R-21：显式插队——冻结提升关系（promoteTarget＝被停止的旧目标 runId）；
      // 条目身份与普通 pending 相同，停止确认后由控制器优先派发。
      const index = snapshot.pending.findIndex((entry) => entry.inputId === fact.inputId);
      if (index < 0) return { snapshot, patch: null, applied: false, dropped: 'not-found' };
      const current = snapshot.pending[index];
      if (current.state !== 'pending') return { snapshot, patch: null, applied: false, dropped: 'locked' };
      const pending = snapshot.pending.map((entry, i) => (i === index ? { ...entry, promoteTarget: fact.targetRunId ?? null, promoteAt: fact.at ?? null } : entry));
      const next = { ...snapshot, revision: snapshot.revision + 1, pending };
      return { snapshot: next, patch: { kind: 'queue', pending }, applied: true };
    }
    case 'input-locked': {
      const index = snapshot.pending.findIndex((entry) => entry.inputId === fact.inputId);
      if (index < 0) return { snapshot, patch: null, applied: false, dropped: 'not-found' };
      const current = snapshot.pending[index];
      if (current.state !== 'pending') return { snapshot, patch: null, applied: false, dropped: 'locked' };
      const pending = snapshot.pending.map((entry, i) => (i === index ? { ...entry, state: 'submitting', targetRunId: fact.targetRunId ?? null } : entry));
      const next = { ...snapshot, revision: snapshot.revision + 1, pending };
      return { snapshot: next, patch: { kind: 'queue', pending }, applied: true };
    }
    case 'input-delivered': {
      // 幂等：已投递（含同 run 的重复投递事件、迟到 ACK）不再建第二条用户项。
      if (snapshot.timeline.some((entry) => (entry.kind === 'user' && entry.id === fact.input.inputId) || entry.inputId === fact.input.inputId)) {
        return { snapshot, patch: null, applied: false, dropped: 'duplicate-delivery' };
      }
      if (!runAccepts(snapshot, fact.runId)) return { snapshot, patch: null, applied: false, dropped: 'stale-run' };
      const pendingEntry = snapshot.pending.find((entry) => entry.inputId === fact.input.inputId);
      const pending = snapshot.pending.filter((entry) => entry.inputId !== fact.input.inputId);
      // 059：workflow-start 结构化输入不冒充用户文字（契约 §8「不伪造一句用户文字」）——
      // 投递即出执行卡（assistant item 的 workflow-card part），参数与进展由后续
      // part-updated 事实在同一 partId 上更新。
      if (fact.input.workflow) {
        const wf = fact.input.workflow;
        const existingCard = snapshot.timeline.find(item => item.itemId === `workflow-${wf.invocationId}`);
        const cardPart = {
          ...existingCard?.parts?.[0], ...wf,
          partId: `card-${wf.invocationId}`,
          kind: 'workflow-card',
          invocationId: wf.invocationId,
          workflowId: wf.workflowId ?? null,
          workflowRunId: wf.workflowRunId ?? null,
          title: wf.title ?? '工作流',
          status: 'starting',
          updatedAt: fact.at ?? null,
        };
        const cardItem = {
          itemId: `workflow-${wf.invocationId}`,
          inputId: fact.input.inputId,
          kind: 'assistant',
          runId: fact.runId,
          afterInputId: null,
          parts: [cardPart],
        };
        const nextWf = {
          ...snapshot,
          revision: snapshot.revision + 1,
          pending,
          timeline: existingCard ? snapshot.timeline.map(item => item === existingCard ? cardItem : item) : [...snapshot.timeline, cardItem],
          runs: snapshot.runs[fact.runId]
            ? { ...snapshot.runs, [fact.runId]: { ...snapshot.runs[fact.runId], inputIds: [...new Set([...snapshot.runs[fact.runId].inputIds, fact.input.inputId])] } }
            : snapshot.runs,
        };
        return {
          snapshot: nextWf,
          patch: { kind: 'multi', changes: [{ kind: 'queue', pending }, { kind: existingCard ? 'item-updated' : 'item-appended', item: cardItem }] },
          applied: true,
        };
      }
      const userItem = {
        id: fact.input.inputId,
        kind: 'user',
        runId: fact.runId,
        // 060 R-11：并入投递的输入挂在目标运行上（非 queue 来源）——mergedInto 标注
        // 其「显式并入」身份：渲染层的直发气泡规则据此放行其上屏（提交路径不 push）。
        ...(pendingEntry?.targetRunId ? { mergedInto: pendingEntry.targetRunId } : {}),
        text: fact.input.text,
        inputSource: fact.input.inputSource ?? 'text',
        attachmentIds: fact.input.attachmentIds ?? [],
        // 057 S3-2：附件视图随投递冻结进用户项（重载 chips 的 flow 侧来源）。
        ...(Array.isArray(fact.input.attachmentViews) && fact.input.attachmentViews.length
          ? { attachments: fact.input.attachmentViews }
          : {}),
        references: fact.input.references ?? null,
        // 063：引用与显式技能随投递冻结（正式流用户项的标签回显来源）。
        ...(Array.isArray(fact.input.skills) && fact.input.skills.length
          ? { skills: fact.input.skills }
          : {}),
        acceptedAt: fact.input.createdAt ?? null,
        deliveredAt: fact.at ?? null,
      };
      const next = {
        ...snapshot,
        revision: snapshot.revision + 1,
        pending,
        timeline: [...snapshot.timeline, userItem],
        runs: snapshot.runs[fact.runId]
          ? { ...snapshot.runs, [fact.runId]: { ...snapshot.runs[fact.runId], inputIds: [...new Set([...snapshot.runs[fact.runId].inputIds, fact.input.inputId])] } }
          : snapshot.runs,
      };
      return {
        snapshot: next,
        patch: { kind: 'multi', changes: [{ kind: 'queue', pending }, { kind: 'item-appended', item: userItem }, { kind: 'runs', runs: next.runs }] },
        applied: true,
      };
    }
    case 'input-recovered': {
      const index = snapshot.pending.findIndex((entry) => entry.inputId === fact.inputId);
      if (index < 0) return { snapshot, patch: null, applied: false, dropped: 'not-found' };
      const current = snapshot.pending[index];
      if (current.state !== 'submitting') return { snapshot, patch: null, applied: false, dropped: 'not-submitting' };
      const pending = snapshot.pending.map((entry, i) => (i === index ? { ...entry, state: fact.to, targetRunId: null } : entry));
      const next = { ...snapshot, revision: snapshot.revision + 1, pending };
      return { snapshot: next, patch: { kind: 'queue', pending }, applied: true };
    }
    case 'run-preparing': {
      if (snapshot.phase !== 'idle') return { snapshot, patch: null, applied: false, dropped: 'slot-busy' };
      const run = {
        runId: fact.runId,
        generation: snapshot.generation,
        source: fact.source ?? 'user',
        inputIds: fact.inputIds ?? [],
        startedAt: fact.at ?? null,
        endedAt: null,
        closedAt: null,
        outcome: null,
      };
      const next = { ...snapshot, revision: snapshot.revision + 1, phase: 'preparing', activeRunId: fact.runId, runs: { ...snapshot.runs, [fact.runId]: run } };
      return { snapshot: next, patch: { kind: 'multi', changes: [{ kind: 'meta', meta: metaOf(next) }, { kind: 'runs', runs: next.runs }] }, applied: true };
    }
    case 'run-started': {
      if (snapshot.activeRunId !== fact.runId || snapshot.phase !== 'preparing') {
        return { snapshot, patch: null, applied: false, dropped: 'not-active-run' };
      }
      const run = { ...snapshot.runs[fact.runId], startedAt: snapshot.runs[fact.runId].startedAt ?? fact.at ?? null, modelUsed: fact.modelUsed ?? null };
      const next = { ...snapshot, revision: snapshot.revision + 1, phase: 'running', runs: { ...snapshot.runs, [fact.runId]: run } };
      return {
        snapshot: next,
        patch: { kind: 'multi', changes: [{ kind: 'meta', meta: metaOf(next) }, { kind: 'runs', runs: next.runs }] },
        applied: true,
      };
    }
    case 'run-stopping': {
      if (snapshot.activeRunId !== fact.runId || !['running', 'preparing', 'stopping'].includes(snapshot.phase)) {
        return { snapshot, patch: null, applied: false, dropped: 'not-active-run' };
      }
      const run = { ...snapshot.runs[fact.runId], stopRequested: true, stopReason: fact.reason ?? 'stop' };
      const next = { ...snapshot, revision: snapshot.revision + 1, phase: 'stopping', queuePaused: fact.reason === 'stop' ? true : snapshot.queuePaused, runs: { ...snapshot.runs, [fact.runId]: run } };
      return {
        snapshot: next,
        patch: { kind: 'multi', changes: [{ kind: 'meta', meta: metaOf(next) }, { kind: 'runs', runs: next.runs }] },
        applied: true,
      };
    }
    case 'run-settled': {
      // SDK settled 只是收口的第一步（契约 §4）；phase 不变，等 runtime-closed。
      if (snapshot.activeRunId !== fact.runId) return { snapshot, patch: null, applied: false, dropped: 'not-active-run' };
      const run = { ...snapshot.runs[fact.runId], sdkSettledAt: fact.at ?? null };
      const next = { ...snapshot, revision: snapshot.revision + 1, runs: { ...snapshot.runs, [fact.runId]: run } };
      return { snapshot: next, patch: { kind: 'runs', runs: next.runs }, applied: true };
    }
    case 'run-closed': {
      if (snapshot.activeRunId !== fact.runId) return { snapshot, patch: null, applied: false, dropped: 'not-active-run' };
      const run = {
        ...snapshot.runs[fact.runId],
        endedAt: fact.at ?? null,
        closedAt: fact.at ?? null,
        outcome: fact.outcome ?? 'unknown',
        ...(fact.usage ? { usage: fact.usage } : {}),
      };
      const next = { ...snapshot, revision: snapshot.revision + 1, phase: 'idle', activeRunId: null, runs: { ...snapshot.runs, [fact.runId]: run } };
      return {
        snapshot: next,
        patch: { kind: 'multi', changes: [{ kind: 'meta', meta: metaOf(next) }, { kind: 'runs', runs: next.runs }] },
        applied: true,
      };
    }
    case 'part-appended': {
      // 追加不要求 part 已存在——只做代次与运行归属校验（新 part 找不到是正常态）。
      if (fact.generation != null && fact.generation !== snapshot.generation) {
        return { snapshot, patch: null, applied: false, dropped: 'stale-generation' };
      }
      if (!runAccepts(snapshot, fact.runId)) return { snapshot, patch: null, applied: false, dropped: 'stale-run' };
      const existing = assistantItemFor(snapshot, fact.runId, fact.afterInputId);
      if (existing) {
        if (existing.parts.some((p) => p.partId === fact.part.partId)) {
          return { snapshot, patch: null, applied: false, dropped: 'duplicate-part' };
        }
        const item = { ...existing, parts: [...existing.parts, fact.part] };
        const timeline = snapshot.timeline.map((entry) => (entry === existing ? item : entry));
        const next = { ...snapshot, revision: snapshot.revision + 1, timeline };
        return { snapshot: next, patch: { kind: 'item-updated', item }, applied: true };
      }
      const item = { itemId: fact.itemId ?? `${fact.runId}:a:${fact.afterInputId ?? 'root'}`, kind: 'assistant', runId: fact.runId, afterInputId: fact.afterInputId ?? null, parts: [fact.part] };
      const timeline = [...snapshot.timeline, item];
      const next = { ...snapshot, revision: snapshot.revision + 1, timeline };
      return { snapshot: next, patch: { kind: 'item-appended', item }, applied: true };
    }
    case 'part-updated': {
      const target = touchPartTarget(snapshot, fact);
      if (!target) return { snapshot, patch: null, applied: false, dropped: 'stale-run' };
      // 纯文本归约取「当前内容替换」口径：同值内容替换不重复递增 revision（防逐字空转）。
      const patchKeys = Object.keys(fact.patch);
      if (patchKeys.length === 1 && patchKeys[0] === 'content' && fact.patch.content === target.part.content) {
        return { snapshot, patch: null, applied: false, dropped: 'no-op' };
      }
      const part = { ...target.part, ...fact.patch };
      const item = { ...target.item, parts: target.item.parts.map((p) => (p === target.part ? part : p)) };
      const timeline = snapshot.timeline.map((entry) => (entry === target.item ? item : entry));
      const next = { ...snapshot, revision: snapshot.revision + 1, timeline };
      return { snapshot: next, patch: { kind: 'item-updated', item }, applied: true };
    }
    case 'queue-paused': {
      if (snapshot.queuePaused) return { snapshot, patch: null, applied: false, dropped: 'no-op' };
      const next = { ...snapshot, revision: snapshot.revision + 1, queuePaused: true };
      return { snapshot: next, patch: { kind: 'meta', meta: metaOf(next) }, applied: true };
    }
    case 'queue-resumed': {
      if (!snapshot.queuePaused) return { snapshot, patch: null, applied: false, dropped: 'no-op' };
      const next = { ...snapshot, revision: snapshot.revision + 1, queuePaused: false };
      return { snapshot: next, patch: { kind: 'meta', meta: metaOf(next) }, applied: true };
    }
    case 'task-updated': {
      const id = fact.task.taskId ?? fact.task.key;
      const previous = snapshot.tasks[id];
      const task = { ...fact.task, executions: { ...previous?.executions, ...(fact.task.toolCallId ? { [fact.task.toolCallId]: fact.task } : {}) } };
      const next = { ...snapshot, revision: snapshot.revision + 1, tasks: { ...snapshot.tasks, [id]: task } };
      return { snapshot: next, patch: { kind: 'tasks', tasks: next.tasks }, applied: true };
    }
    case 'artifact-updated': {
      const next = { ...snapshot, revision: snapshot.revision + 1, artifacts: { ...snapshot.artifacts, [fact.artifact.artifactId]: fact.artifact } };
      return { snapshot: next, patch: { kind: 'artifacts', artifacts: next.artifacts }, applied: true };
    }
    case 'permission-updated': {
      const next = { ...snapshot, revision: snapshot.revision + 1, permissions: { ...snapshot.permissions, [fact.permission.permissionId]: fact.permission } };
      return { snapshot: next, patch: { kind: 'permissions', permissions: next.permissions }, applied: true };
    }
    case 'report-queued': {
      const key = `${fact.report.taskId}:${fact.report.resultVersion}`;
      if (snapshot.pendingReports.some((entry) => `${entry.taskId}:${entry.resultVersion}` === key)) {
        return { snapshot, patch: null, applied: false, dropped: 'duplicate-report' };
      }
      const next = { ...snapshot, revision: snapshot.revision + 1, pendingReports: [...snapshot.pendingReports, fact.report] };
      return { snapshot: next, patch: { kind: 'reports', pendingReports: next.pendingReports }, applied: true };
    }
    case 'report-consumed': {
      const remaining = snapshot.pendingReports.filter((entry) => !(entry.taskId === fact.taskId && entry.resultVersion === fact.resultVersion));
      if (remaining.length === snapshot.pendingReports.length) return { snapshot, patch: null, applied: false, dropped: 'not-found' };
      const next = { ...snapshot, revision: snapshot.revision + 1, pendingReports: remaining };
      return { snapshot: next, patch: { kind: 'reports', pendingReports: remaining }, applied: true };
    }
    case 'generation-bumped': {
      // 回卷/会话重建：裁掉目标用户项之后的时间线（该输入项本身由替换输入重发覆盖），
      // pending 保留（契约：保留草稿与有效队列）；旧 generation 回执自此全部失效。
      const cutIndex = snapshot.timeline.findIndex((entry) => entry.kind === 'user' && entry.id === fact.cutAfterInputId);
      if (cutIndex < 0) return { snapshot, patch: null, applied: false, dropped: 'not-found' };
      const timeline = snapshot.timeline.slice(0, cutIndex);
      // 任务摘要也会注入下一轮上下文；撤掉工具行后不能继续把所属任务当成最近结果。
      const removedCalls = new Set(snapshot.timeline.slice(cutIndex).flatMap((item) => item.parts ?? [])
        .map((part) => part.toolCallId).filter(Boolean));
      const tasks = Object.fromEntries(Object.entries(snapshot.tasks).flatMap(([id, task]) => {
        const executions = Object.fromEntries(Object.entries(task.executions ?? {}).filter(([call]) => !removedCalls.has(call)));
        if (!removedCalls.has(task.toolCallId)) return [[id, { ...task, executions }]];
        const previous = Object.values(executions).at(-1);
        return previous ? [[id, { ...previous, executions }]] : [];
      }));
      const removedTasks = new Set(Object.keys(snapshot.tasks).filter((id) => !tasks[id]));
      const artifacts = Object.fromEntries(Object.entries(snapshot.artifacts).filter(([, artifact]) => !removedTasks.has(artifact.taskId)));
      const permissions = Object.fromEntries(Object.entries(snapshot.permissions).filter(([, permission]) => !removedTasks.has(permission.taskId)));
      const pendingReports = snapshot.pendingReports.filter((report) => !removedTasks.has(report.taskId));
      const next = { ...snapshot, revision: snapshot.revision + 1, generation: snapshot.generation + 1, timeline, tasks, artifacts, permissions, pendingReports };
      return {
        snapshot: next,
        patch: { kind: 'multi', changes: [{ kind: 'meta', meta: metaOf(next) }, { kind: 'timeline', timeline },
          { kind: 'tasks', tasks }, { kind: 'artifacts', artifacts }, { kind: 'permissions', permissions }, { kind: 'reports', pendingReports }] },
        applied: true,
      };
    }
    default:
      return { snapshot, patch: null, applied: false, dropped: 'unknown-fact' };
  }
}

function metaOf(snapshot) {
  return { phase: snapshot.phase, activeRunId: snapshot.activeRunId, queuePaused: snapshot.queuePaused, generation: snapshot.generation };
}

/**
 * 桥层补丁应用（客户端侧）。baseRevision 不匹配返回 { ok:false, code:'stale' }——
 * 订阅方须重取完整快照，不得本地重放执行。
 * @param {object} snapshot
 * @param {object} change
 */
export function applyFlowChange(snapshot, change) {
  if (change.kind === 'snapshot') {
    // 旧响应不覆盖新状态（AC-36 组六）：revision／generation 倒退的快照在纯归约层
    // 即拒绝——守卫收敛进本层，桥层（use-conversation-flow）的同款判断保留为兜底。
    const incoming = change.snapshot;
    if (typeof incoming?.revision === 'number' && incoming.revision < (snapshot.revision ?? 0)) {
      return { ok: false, code: 'stale' };
    }
    if ((incoming?.generation ?? 1) < (snapshot.generation ?? 1)) return { ok: false, code: 'stale' };
    return { ok: true, snapshot: incoming };
  }
  if (change.generation !== snapshot.generation) return { ok: false, code: 'stale' };
  if (change.baseRevision !== snapshot.revision) return { ok: false, code: 'stale' };
  let next = snapshot;
  for (const patch of change.changes) {
    for (const resolved of patch.kind === 'multi' ? patch.changes : [patch]) {
      next = applyPatch(next, resolved);
    }
  }
  next = { ...next, revision: change.revision };
  return { ok: true, snapshot: next };
}

function applyPatch(snapshot, patch) {
  switch (patch.kind) {
    case 'meta': return { ...snapshot, ...patch.meta };
    case 'queue': return { ...snapshot, pending: patch.pending };
    case 'timeline': return { ...snapshot, timeline: patch.timeline };
    case 'item-appended': {
      if (snapshot.timeline.some((entry) => entryId(entry) === entryId(patch.item))) return snapshot;
      return { ...snapshot, timeline: [...snapshot.timeline, patch.item] };
    }
    case 'item-updated': {
      const timeline = snapshot.timeline.map((entry) => (entryId(entry) === entryId(patch.item) ? patch.item : entry));
      return { ...snapshot, timeline };
    }
    case 'runs': return { ...snapshot, runs: patch.runs };
    case 'tasks': return { ...snapshot, tasks: patch.tasks };
    case 'artifacts': return { ...snapshot, artifacts: patch.artifacts };
    case 'permissions': return { ...snapshot, permissions: patch.permissions };
    case 'reports': return { ...snapshot, pendingReports: patch.pendingReports };
    default: return snapshot;
  }
}

const entryId = (entry) => (entry.kind === 'user' ? entry.id : entry.itemId);

/** 连续文本补丁合并：同 part 的多次 part-updated 只保留最终值（发布侧合批用）。 */
export function coalesceFlowChanges(first, second) {
  if (!first) return second;
  if (first.kind !== 'patch' || second.kind !== 'patch') return second;
  if (second.baseRevision !== first.revision) return second; // 不连续则不合，交由订阅方重取
  const changes = [...first.changes];
  for (const patch of second.changes) {
    const last = changes[changes.length - 1];
    if (
      patch.kind === 'item-updated' && last?.kind === 'item-updated'
      && entryId(patch.item) === entryId(last.item)
    ) {
      changes[changes.length - 1] = patch; // 同条目替换为最终值
    } else {
      changes.push(patch);
    }
  }
  return { ...first, revision: second.revision, changes };
}
