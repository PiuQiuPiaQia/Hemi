/**
 * 057 运行事实投影（S2 UI 批次，契约 §2）：执行内胆的流事件 → flow part 事实、
 * 子 agent 快照 → task 事实。纯函数、无 IO——身份校验与幂等由 conversation-flow
 * 归约层承担（重复 part、外 run、旧代次都会被丢弃）。
 *
 * 口径：
 *  - 正文／思考增量 → 首次出现 part-appended、后续 part-updated 携带**累计内容**
 *    （「当前内容替换」口径，不是 delta 再拼接）；工具往返后的新段另建 part。
 *  - 工具 → tool part（task 派单 → delegation part，带 toolCallId 供快照关联）。
 *  - 失败 → notice part（正文进 turns 档案，时间线标错误事实）。
 *  - 任务快照投影只保留展示／恢复必需字段（正文大段留在任务档案，预览 200 字）。
 */

const MAX_ERROR_DETAIL_CHARS = 16_000;
function boundedErrorDetail(error) {
  const text = String(error?.message ?? error);
  return text.length <= MAX_ERROR_DETAIL_CHARS ? text
    : `${text.slice(0, MAX_ERROR_DETAIL_CHARS)}\n…（错误详情过长，已截断；完整记录见应用日志）`;
}

/**
 * @param {object} options
 * @param {string} options.runId
 * @param {number} [options.generation]
 * @returns {{ handle: (event: object) => Array<object>, finish: (outcome: {error?: Error|null}) => Array<object> }}
 *   handle 接收 executeChatTurn 的 streamEvent（text、thinking 系列、tool 系列）；
 *   finish 在运行收口时调用（失败补 notice）。
 */
export function createRunPartProjector({ runId, generation = null, inputId = null, now = Date.now } = {}) {
  let afterInputId = inputId;
  let seq = 0;
  let textPart = null;
  let thinkingPart = null;
  let requestParts = [];
  /** toolCallId → { partId, kind } */
  const toolParts = new Map();
  const backgroundParts = new Map();
  const nextId = (kind) => `${runId}:${kind}${(seq += 1)}`;
  const gen = () => ({ afterInputId, ...(generation == null ? {} : { generation }) });

  /** 工具起跑＝上一段正文/思考收口；工具后的输出另起新段（056 分段口径）。 */
  function closeOpenParts() {
    const facts = thinkingPart ? [{ type: 'part-updated', runId, partId: thinkingPart.partId, patch: { endedAt: now() }, ...gen() }] : [];
    textPart = null;
    thinkingPart = null;
    return facts;
  }

  function handle(event) {
    const facts = [];
    switch (event?.kind) {
      case 'recovery':
        return [{ type: 'run-recovery', runId, recovery: event.recovery, ...gen() }];
      case 'request-start':
        requestParts = [];
        return closeOpenParts();
      case 'request-reset': {
        const resets = requestParts.map(partId => ({ type: 'part-updated', runId, partId, patch: { content: '' }, ...gen() }));
        textPart = null; thinkingPart = null; requestParts = [];
        return resets;
      }
      case 'activity':
        return [{ type: 'run-activity', runId, activity: event.activity, ...gen() }];
      case 'text': {
        const delta = typeof event.text === 'string' ? event.text : '';
        if (!delta) return facts;
        if (!textPart) {
          textPart = { partId: nextId('t'), content: delta };
          requestParts.push(textPart.partId);
          facts.push({ type: 'part-appended', runId, part: { partId: textPart.partId, kind: 'text', content: delta }, ...gen() });
        } else {
          textPart.content += delta;
          facts.push({ type: 'part-updated', runId, partId: textPart.partId, patch: { content: textPart.content }, ...gen() });
        }
        return facts;
      }
      case 'thinking_start':
        return facts; // 思考段由首个 delta 创建
      case 'thinking': {
        const delta = typeof event.text === 'string' ? event.text : '';
        if (!delta) return facts;
        if (!thinkingPart) {
          thinkingPart = { partId: nextId('k'), content: delta, startedAt: now() };
          requestParts.push(thinkingPart.partId);
          facts.push({ type: 'part-appended', runId, part: { partId: thinkingPart.partId, kind: 'thinking', content: delta, startedAt: thinkingPart.startedAt }, ...gen() });
        } else {
          thinkingPart.content += delta;
          facts.push({ type: 'part-updated', runId, partId: thinkingPart.partId, patch: { content: thinkingPart.content }, ...gen() });
        }
        return facts;
      }
      case 'thinking_end':
        if (thinkingPart) facts.push({ type: 'part-updated', runId, partId: thinkingPart.partId, patch: { endedAt: now() }, ...gen() });
        thinkingPart = null;
        return facts;
      case 'tool_start': {
        facts.push(...closeOpenParts());
        const toolCallId = String(event.toolCallId ?? nextId('u'));
        const isDelegation = event.tool === 'task';
        const partId = nextId(isDelegation ? 'd' : 'w');
        toolParts.set(toolCallId, { partId, kind: isDelegation ? 'delegation' : 'tool' });
        facts.push({
          type: 'part-appended',
          runId,
          part: {
            partId,
            kind: isDelegation ? 'delegation' : 'tool',
            tool: String(event.tool ?? ''),
            toolCallId,
            status: 'running',
            ...(event.args && typeof event.args === 'object' ? { args: event.args } : {}),
          },
          ...gen(),
        });
        return facts;
      }
      case 'tool_end': {
        const callId = String(event.toolCallId ?? '');
        const entry = !event.background && event.commandId
          ? backgroundParts.get(event.commandId) : toolParts.get(callId);
        if (!entry) return facts;
        if (event.background && event.commandId) {
          backgroundParts.set(event.commandId,entry); toolParts.delete(callId);
        } else if (!event.background) {
          if(event.commandId)backgroundParts.delete(event.commandId);
          else toolParts.delete(callId);
        }
        facts.push({
          type: 'part-updated',
          runId,
          partId: entry.partId,
          patch: { status: event.background ? 'running' : event.stopped ? 'stopped' : event.isError ? 'error' : 'done' },
          ...gen(),
        });
        return facts;
      }
      default:
        return facts;
    }
  }

  /** 收口：失败补 notice（成功不加——正文 part 已完整）。 */
  function finish({ error = null, stopped = false, blocked = null, halted = null } = {}) {
    const facts = [...closeOpenParts(), ...[...toolParts.values(),...backgroundParts.values()].map(({ partId }) => ({
      type: 'part-updated', runId, partId, patch: { status: stopped ? 'stopped' : 'error' }, ...gen(),
    }))];
    toolParts.clear();
    backgroundParts.clear();
    if (!error && !blocked && !halted && !(stopped && seq === 0)) return facts;
    const partId = nextId('n');
    return [...facts, {
      type: 'part-appended',
      runId,
      part: { partId, kind: 'notice', level: error ? 'error' : 'info', text: error
        ? boundedErrorDetail(error)
        : halted && !stopped ? `${halted.kind==='budget_limited'?'任务达到预算上限':'任务暂无进展'}：${halted.reason}\n${halted.nextAction??''}` : blocked && !stopped ? `任务受阻：${blocked.reason}${blocked.nextAction ? '\n'+blocked.nextAction : ''}` : '本任务已停止。' },
      ...gen(),
    }];
  }

  return { handle, finish, get afterInputId() { return afterInputId; }, delivered(inputId) { const facts = closeOpenParts(); afterInputId = inputId; return facts; } };
}

const TASK_PREVIEW_LIMIT = 200;

/** 子 agent 快照 → task-updated 事实（展示必需字段；正文大段留任务档案，预览带出处）。 */
export function projectTaskFact(snapshot, { generation = null } = {}) {
  const snap = snapshot ?? {};
  const id = snap.taskId ?? snap.key ?? null;
  if (!id) return null;
  const resultText = typeof snap.resultText === 'string' ? snap.resultText : null;
  const task = {
    taskId: id,
    key: snap.key ?? id,
    conversationId: snap.conversationId ?? null,
    rootRunId: snap.rootRunId ?? null,
    agent: snap.agent ?? null,
    agentTitle: snap.agentTitle ?? null,
    background: Boolean(snap.background),
    phase: snap.phase ?? null,
    outcome: snap.outcome ?? null,
    outcomeReason: snap.outcomeReason ?? null,
    taskText: typeof snap.taskText === 'string' ? snap.taskText.slice(0, 400) : '',
    progressText: snap.progressText ?? null,
    conversation: snap.conversation ?? null,
    activity: snap.activity ?? null,
    stageText: snap.stageText ?? null,
    readOnly: Boolean(snap.readOnly),
    permission: snap.permission ?? null,
    startedAt: snap.startedAt ?? null,
    endedAt: snap.endedAt ?? null,
    runs: snap.runs ?? 1,
    toolCallId: snap.toolCallId ?? null,
    steeredCount: snap.steeredCount ?? 0,
    sources: Array.isArray(snap.sources) ? snap.sources.slice(0, 40) : [],
    fileChanges: snap.fileChanges ?? null,
    fileTouchCount: snap.fileTouchCount ?? 0,
    artifacts: Array.isArray(snap.artifacts) ? snap.artifacts : [],
    delivery: snap.delivery ?? null,
    resultPreview: resultText ? resultText.slice(0, TASK_PREVIEW_LIMIT) : null,
    resultVersion: snap.resultVersion ?? 0,
    approvals: snap.approvals ?? null,
  };
  return { type: 'task-updated', task, ...(generation == null ? {} : { generation }) };
}

/**
 * 本轮状态与最近任务事实随用户输入冻结。用户原文已由主 agent 保存，不在这里
 * 再截断重述任务，避免摘要切掉参数或引号后被误当作另一份指令。
 *
 * @param {object} snapshot flow 快照（可为 null——无会话流时不出块）
 * @param {{ inputSource?: string, runId?: string|null }} turn 本轮身份
 */
export function buildFlowFactsBlock(snapshot, { inputSource = 'text', runId = null } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const lines = [];
  lines.push(`【本轮事实锚点】（宿主在本轮输入时冻结的内部运行事实；后续状态以新消息和工具结果为准。面向用户说明实际结果，不主动复述本块、内部编号或标签；用户明确询问诊断信息时可据实解释）`);
  lines.push(`- 本轮任务以当前用户消息原文为准（${inputSource === 'voice' ? '语音' : '文字'}来源），本块只记录状态，不补充或改写用户指令。指代结合本轮问题与已知结果理解；含义不清且影响执行时澄清，不把孤立数字或单词擅自对应到历史选项。`);
  const uncertain = Object.values(snapshot.runs ?? {}).filter(run => run.runId !== runId && ['interrupted','failed','partial','blocked'].includes(run.outcome));
  if (uncertain.length) {
    lines.push('- 下列旧目标已经结束或中断，不是当前待办；未确认完成的动作要先核对实际结果，不自动重试、恢复或重放旧指令。只有用户明确的新目标才能开始新的工作。');
    for (const previous of uncertain.slice(-5)) lines.push(`  旧目标 ${previous.runId}：${previous.outcome}；已完成事实保留，未确认部分不能当作成功。`);
  }
  const stopped = Object.values(snapshot.runs ?? {}).filter((run) => run.runId !== runId && run.outcome === 'stopped');
  if (stopped.length) {
    lines.push('- 下列旧目标已经停止，其未完成工作已取消，不是当前待办；不得自动补做、重放命令、恢复旧目标或把旧问题当作当前输入的默认含义。新输入不明确时应澄清。');
    for (const previous of stopped.slice(-5)) {
      const inputs = snapshot.timeline.filter((item) => item.kind === 'user' && item.runId === previous.runId).map((item) => String(item.text).slice(0, 180));
      lines.push(`  已停止目标 ${previous.runId}${previous.stopReason === 'promote' ? '（插队取代）' : ''}：${inputs.join('；')}`);
    }
  }
  lines.push('- 本次正式派发的是一个新的用户目标，只处理本轮主问题；普通队列中的其他输入尚未交给你执行，由宿主按顺序派发，不自行合并或提前处理。');
  const tasks = Object.values(snapshot.tasks ?? {});
  const active = tasks.filter((task) => task.phase && task.phase !== 'terminal');
  if (active.length) {
    const described = active.slice(0, 5).map((task) =>
      `${task.agent ?? '?'}「${String(task.taskText ?? '').slice(0, 40)}」${task.phase ?? ''}${task.runs > 1 ? `（第 ${task.runs} 次运行）` : ''}${task.background ? '·后台' : ''}`);
    lines.push(`- 当前任务（按真实状态回答进度，未开始/未执行的事实照实说）：${described.join('；')}`);
  } else {
    lines.push(`- 当前没有在途任务。历史任务已收口；用户问进度时按最近已知结果回答，不凭空启动新检查。`);
  }
  const finished = tasks
    .filter((task) => task.phase === 'terminal')
    .sort((a, b) => Number(b.endedAt ?? 0) - Number(a.endedAt ?? 0))
    .slice(0, 3);
  if (finished.length) {
    const described = finished.map((task) =>
      `${task.agent ?? '?'}「${String(task.taskText ?? '').slice(0, 40)}」${task.outcome ?? 'unknown'}`);
    lines.push(`- 最近完成任务：${described.join('；')}`);
  }
  const preparations = (snapshot.timeline ?? []).flatMap(item => item.kind === 'assistant' ? item.parts ?? [] : [])
    .filter(part => part.kind === 'workflow-card' && part.status === 'preparing');
  if (preparations.length) {
    lines.push('- 用户已建立的工作流准备卡（仅供理解指代，不改变普通聊天的处理方式；需要修改参数时先用 workflow_preparation 读取最新 schema/版本，不能自动启动。可自动生成的资料由执行节点处理）：');
    for (const card of preparations.slice(-8)) lines.push(`  ${JSON.stringify({ invocationId: card.invocationId, title: card.title, draftRevision: card.draftRevision, ready: card.ready, values: card.values, issues: card.issues }).slice(0, 4000)}`);
  }
  const workflows = (snapshot.timeline ?? []).flatMap(item=>item.kind==='assistant' ? item.parts??[] : [])
    .filter(part=>part.kind==='workflow-card' && part.status==='completed').slice(-3);
  if(workflows.length){
    lines.push('- 最近已完成的工作流交付（可在本轮继续使用；路径引用不代表你已读取文件正文，需要内容时先读取，不重新启动流程）：');
    for(const card of workflows){
      const delivered=Object.fromEntries(Object.entries(card.outputs??{}).filter(([key])=>!key.startsWith('__')));
      lines.push(`  ${card.title??'工作流'}（${card.invocationId}）：${JSON.stringify(delivered).slice(0,4000)}`);
    }
  }
  if ((snapshot.pending ?? []).length) {
    lines.push(`- 待发送队列还有 ${snapshot.pending.length} 条（尚未进入模型上下文，不代表用户已选择任何历史选项）。`);
  }
  lines.push(`- 指代不明时先说明上述已知状态再澄清；未执行的检查不声称已执行，读取得到的观察不升级为已核验结论。`);
  return lines.join('\n');
}
