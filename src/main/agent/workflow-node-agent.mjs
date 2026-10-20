/**
 * 059 工作流节点 Agent（S2 后半，运行接线 §5）：一个任务节点的隔离执行上下文。
 *
 * 与对话主 agent 的边界：
 * - 会话驻留键是 workflowRunId/nodeId/attemptId（label 携带 owner），不进对话 LRU、
 *   不写 conversations/*.json 的 agentSession——条目是否持久化由宿主决定（首期内存随
 *   尝试释放，过程事实由 runner 写 invocation）；
 * - 只带必需的节点上下文（业务目标＋绑定输入＋输出契约），不复制对话历史；
 * - 下游只消费声明输出（outputSchema），不共享上一个 Pi 会话的隐藏状态。
 *
 * 真实装配（生产）从 agent-runtime 的 createRoleSession 同源抽取（capabilities/placement/
 * skills/modelOptions），由 workflow-service（S3）注入 deps；本模块的工厂签名保持可注入，
 * 单测用 mock session 验证接线契约。改 hemi-session/main-agent 前先跑
 * scripts/pi-056-agent-probe.mjs（本轮已跑 13/13）。
 */

/**
 * 构造节点提示词（纯函数，独立可测）。产出契约放在回合末，模型按契约输出 JSON。
 * @param {object} params
 * @param {object} params.nodeData 节点 data（goal/inputBindings/outputSchema/acceptance…）
 * @param {object} params.inputs 已解析的绑定输入值
 * @param {string} params.nodeType hemi-agent/hemi-skill/hemi-browser/hemi-desktop
 */
export function buildNodePrompt({ nodeType, nodeData, inputs }) {
  const lines = [];
  lines.push('［工作流节点执行 · Hemi 宿主注入，不是用户说的话］');
  lines.push(`节点类型：${nodeType}。`);
  if (nodeData.title) lines.push(`节点：${nodeData.title}`);
  lines.push(`任务目标：${nodeData.goal ?? '（未声明）'}`);
  if (nodeData.acceptance) lines.push(`完成条件：${nodeData.acceptance}`);

  const inputEntries = Object.entries(inputs ?? {});
  if (inputEntries.length > 0) {
    lines.push('绑定输入（值已由宿主解析冻结）：');
    for (const [key, value] of inputEntries) {
      const rendered = typeof value === 'string' ? value : JSON.stringify(value);
      lines.push(`- ${key==='__hemi_resume_note'?'用户继续时补充':key} = ${rendered}`);
    }
  }
  if (Array.isArray(nodeData.skillRefs) && nodeData.skillRefs.length > 0) {
    lines.push(`已挂载 Skill（按其方法与资源完成目标）：${nodeData.skillRefs.map((s) => s.name).join('、')}`);
  }

  const props = nodeData.outputSchema?.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length > 0) {
    lines.push('完成后必须交付以下声明输出（不要遗漏字段）：');
    for (const key of keys) {
      lines.push(`- ${key}（${props[key]?.type ?? 'string'}${props[key]?.description ? `：${props[key].description}` : ''}）`);
    }
    lines.push(
      '在回答的最后一行输出一个 JSON 代码块（```json ... ```）只含上述字段；' +
        '文件类字段给绝对路径，文本类字段给正文。'
    );
  } else {
    lines.push('完成后用文字总结结果。');
  }
  return lines.join('\n');
}

const SCALAR_TYPES = new Set(['string', 'number', 'boolean']);

/** 从助手最终文本提取末尾的 ```json 块（无则 null）。 */
export function extractOutputJson(text) {
  const source = String(text ?? '');
  const fence = [...source.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1);
  if (fence) return fence[1].trim();
  const anyFence = source.match(/```\s*([\s\S]*?)```/);
  if (anyFence) return anyFence[1].trim();
  // 无围栏：末段整体像对象就当对象
  const tail = source.trim();
  if (tail.startsWith('{') && tail.endsWith('}')) return tail;
  return null;
}

/**
 * 解析并校验节点输出（纯函数）。失败抛带 code 的错误，由 runner 记为节点失败
 * （预算内的一次定向格式修复是 runner/服务层职责，这里不做）。
 * @returns {{ outputs: object, warnings: string[] }}
 */
export function parseNodeOutputs({ text, outputSchema }) {
  const props = outputSchema?.properties ?? {};
  const requiredKeys = Object.keys(props);
  const raw = extractOutputJson(text);
  if (requiredKeys.length === 0) {
    return { outputs: {}, warnings: [] };
  }
  if (raw == null) {
    const error = new Error('节点回答缺少输出 JSON 块');
    error.code = 'node-output-missing';
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const error = new Error(`输出 JSON 解析失败：${String(raw).slice(0, 120)}`);
    error.code = 'node-output-invalid';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('输出 JSON 不是对象');
    error.code = 'node-output-invalid';
    throw error;
  }
  const warnings = [];
  const outputs = {};
  for (const key of requiredKeys) {
    const declared = props[key]?.type ?? 'string';
    const value = parsed[key];
    if (value === undefined) {
      const error = new Error(`输出缺少声明字段 ${key}`);
      error.code = 'node-output-missing-field';
      error.field = key;
      throw error;
    }
    if((declared==='file'&&(typeof value!=='string'||!value.trim()))||(declared==='files'&&(!Array.isArray(value)||!value.length||value.some(file=>typeof file!=='string'||!file.trim())))){
      const error=new Error(`输出字段 ${key} 需要有效文件路径`);error.code='node-output-type-mismatch';throw error;
    }
    if((declared==='array'&&!Array.isArray(value))||(declared==='object'&&(!value||typeof value!=='object'||Array.isArray(value)))){
      const error=new Error(`输出字段 ${key} 需要 ${declared}`);error.code='node-output-type-mismatch';throw error;
    }
    if (SCALAR_TYPES.has(declared)) {
      const actual = value === null ? 'null' : typeof value;
      if (actual !== declared) {
        if (declared === 'string' && typeof value === 'number') {
          warnings.push(`字段 ${key} 以数字给出，按字符串收下`);
          outputs[key] = String(value);
          continue;
        }
        const error = new Error(`输出字段 ${key} 需要 ${declared}，实际 ${actual}`);
        error.code = 'node-output-type-mismatch';
        error.field = key;
        throw error;
      }
    }
    outputs[key] = value;
  }
  return { outputs, warnings };
}

/**
 * 创建节点 agent：包装一个 hemi-session 形状的对象（生产＝createHemiSession 产物，
 * 测试＝mock）。run() 解析输出；abort() 贯通真实停止（runner 栅栏调用）。
 * @param {object} params
 * @param {object} params.session prompt/abort/dispose/isBusy
 * @param {object} params.nodeSpec { nodeId, nodeType, nodeData, outputSchema }
 * @param {object} params.executionOwner workflow-node 归属（日志与角色路由用）
 */
export function createWorkflowNodeAgent({ session, nodeSpec, executionOwner, log = null }) {
  const ownerLabel = executionOwner
    ? `${executionOwner.workflowRunId}/${executionOwner.nodeId}/${executionOwner.attemptId}`
    : 'no-owner';
  async function run({ inputs = {} } = {}) {
    const prompt = buildNodePrompt({
      nodeType: nodeSpec.nodeType,
      nodeData: nodeSpec.nodeData ?? {},
      inputs,
    });
    log?.info?.(`[workflow-node] ${ownerLabel} 起跑（${nodeSpec.nodeType}）`);
    const result = await session.prompt(prompt);
    // hemi-session prompt 收口形状：{ texts: string[], lastText, usages, requests, toolNames }。
    // lastText 可能是空串（收口异常/纯工具轮），回退取最后一条非空 texts。
    const fromTexts = Array.isArray(result?.texts) ? [...result.texts].reverse().find((t) => t) : '';
    const text = result?.lastText || fromTexts || '';
    if (result?.aborted) throw new DOMException('工作流节点已停止', 'AbortError');
    if (result?.modelError) throw new Error(result.modelError);
    const used=result?.toolNames??[];
    if((nodeSpec.nodeType==='hemi-browser'&&!used.some(name=>name.startsWith('browser_')))||(nodeSpec.nodeType==='hemi-desktop'&&!used.some(name=>/^(ui_|app_open$|screen_view$)/.test(name)))){
      const error=new Error('专用节点没有成功使用声明的浏览器／桌面能力，不能认定步骤完成');error.code='capability-not-used';throw error;
    }
    const { outputs, warnings } = parseNodeOutputs({ text, outputSchema: nodeSpec.nodeData?.outputSchema });
    for (const warning of warnings) log?.warn?.(`[workflow-node] ${ownerLabel} ${warning}`);
    return { outputs, text, usage: result?.usages?.[result.usages.length - 1] ?? null, modelError: result?.modelError ?? null };
  }
  return {
    ownerLabel,
    run,
    abort: () => session.abort(),
    requestHandoff: () => session.requestHandoff?.(),
    dispose: () => session.dispose(),
    isBusy: () => session.isBusy?.() ?? false,
  };
}

/**
 * hemi 任务节点 executor 工厂：给 runner 用的四类任务执行器（agent/skill/browser/desktop）
 * 都经节点 agent 跑（S2 首期同一会话形态；浏览器／桌面专属 executor 的目标解析在 S4/S5 细化）。
 * @param {object} params
 * @param {(spec: { nodeSpec, executionOwner }) => Promise<{agent, release: Function}>} params.openAgent
 *   宿主注入：为一次尝试开一个节点 agent（生产＝真实 createHemiSession 装配；测试＝mock）
 */
export function createNodeAgentExecutor({ openAgent, log = null }) {
  return {
    async execute(ctx) {
      ctx.signal?.throwIfAborted();
      const executionOwner = {
        workflowRunId: ctx.workflowRunId ?? null,
        nodeId: ctx.node.id,
        attemptId: ctx.attemptId ?? `try-${Date.now()}`,
      };
      const { agent, release } = await openAgent({
        nodeSpec: { nodeId: ctx.node.id, nodeType: ctx.node.type, nodeData: ctx.node.data },
        executionOwner, inputs: ctx.inputs, signal: ctx.signal,
        invocation: ctx.invocation, onModelCall: ctx.onModelCall,onTrace:ctx.onTrace,onResourceWait:ctx.onResourceWait,
      });
      const clearHandoff = ctx.registerHandoff?.(() => agent.requestHandoff?.());
      let stopping = null;
      const abort = () => { stopping ??= Promise.resolve().then(() => agent.abort()); void stopping.catch(() => {}); };
      ctx.signal?.addEventListener('abort', abort, { once: true });
      try {
        if (ctx.signal?.aborted) abort();
        ctx.signal?.throwIfAborted();
        const resume=ctx.invocation?.run?.resumeInfo;
        const inputs=resume?.nodeId===ctx.node.id?{...ctx.inputs,__hemi_resume_note:resume.message}:ctx.inputs;
        const { outputs } = await agent.run({ inputs });
        return { outputs };
      } catch (error) {
        log?.warn?.(`[workflow-node] ${agent.ownerLabel} 失败：${error?.message ?? error}`);
        throw error;
      } finally {
        clearHandoff?.();
        ctx.signal?.removeEventListener('abort', abort);
        try {
          if (stopping) await stopping;
        } finally {
          await release?.();
        }
      }
    },
  };
}
