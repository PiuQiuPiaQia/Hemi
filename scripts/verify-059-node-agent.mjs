// 059 S2 后半真机验证：workflow-node-agent 真实模型闭环。
// 隔离 userData＋真实 createHemiSession（配置从真实 userData 拷贝或 HEMI_LLM_* env 直通），
// 跑两层断言：
//   N1 节点 agent 直连：真实模型执行「在临时目录创建 report.md（含唯一标记）」→
//      输出 JSON 解析 → 声明的文件真实存在且含标记
//   N2 runner 全链：invocation store＋workflow-runner＋createNodeAgentExecutor（真实会话）→
//      invocation.run.status=completed、节点事实 succeeded、交付核查过
// 结果打一行 HEMI_059_NODE_RESULT JSON；exit 0＝两层全过。
//
// 运行（worktree 根目录）：
//   UD=/tmp/hemi-059-node-ud && rm -rf "$UD" && mkdir -p "$UD"
//   cp ~/Library/"Application Support"/hemi/text-model.json "$UD/" 2>/dev/null || true
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=$UD npx electron scripts/verify-059-node-agent.mjs
// 无拷贝配置时用 env 直通：HEMI_LLM_API_KEY/HEMI_LLM_BASE_URL/HEMI_LLM_MODEL。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

// 与正式应用同一 safeStorage 身份，拷来的密文可解密（必须在 setPath 之前）。
app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-059-node-ud'));

const { resolveTextModelConfig } = await import('../src/main/lib/config-store.mjs');
const { createHemiSession } = await import('../src/main/agent/hemi-session.mjs');
const { createPermissionService } = await import('../src/main/services/permission-service.mjs');
const {
  createWorkflowNodeAgent,
  createNodeAgentExecutor,
} = await import('../src/main/agent/workflow-node-agent.mjs');
const { createInvocationStore } = await import('../src/main/workflows/invocation-store.mjs');
const { createWorkflowRunner } = await import('../src/main/workflows/workflow-runner.mjs');

function fail(message) {
  console.log('HEMI_059_NODE_RESULT ' + JSON.stringify({ pass: false, fatal: message }));
  app.exit(1);
}

const MARKER = `hemi-059-${Date.now().toString(36)}`;
fs.mkdirSync(path.join(process.cwd(), ".verify-059"), { recursive: true });
const workDir = fs.mkdtempSync(path.join(process.cwd(), ".verify-059", "work"));
const reportPath = path.join(workDir, 'report.md');
const GOAL = `在 ${workDir} 目录创建 report.md（绝对路径 ${reportPath}），文件内容第一行写：${MARKER}。用 write 工具写文件。`;

/** 真实节点会话：最小装配（文件工具＋自动应答确认卡），条目不持久化。 */
async function openRealNodeAgent({ nodeSpec, executionOwner }) {
  const config = await resolveTextModelConfig();
  if (!config.apiKey) {
    fail('没有模型 Key：拷贝 text-model.json 到 userData 或设 HEMI_LLM_API_KEY');
    return null;
  }
  const userDataDir = app.getPath('userData');
  const agentDir = path.join(userDataDir, 'pi-agent');
  const accessService = createPermissionService({ dir: path.join(agentDir, 'access-store'), nowFn: Date.now });
  await accessService.load().catch(() => {});
  const session = createHemiSession({
    cwd: workDir,
    agentDir,
    model: {
      baseUrl: config.baseUrl,
      api: 'openai-completions',
      apiKey: config.apiKey,
      model: config.model,
    },
    mode: 'run',
    tools: ['read', 'write', 'edit', 'ls', 'bash'],
    appendSystem: ['所有文字输出一律用中文（代码、命令、路径、文件内容除外）。'],
    accessId: `wf-${executionOwner.workflowRunId}`,
    label: `wf-node ${executionOwner.workflowRunId}/${executionOwner.nodeId}`,
    log: { info: (...a) => console.log('[i]', ...a), warn: (...a) => console.log('[w]', ...a) },
    initTimeoutMs: 60_000,
    stallTimeoutMs: 120_000,
  });
  // 确认卡自动应答：授权卡（task）与风险卡（once）都放行——本 harness 语义同 self-run-task。
  session.on('permission', ({ id, options }) => {
    const optionsText = JSON.stringify(options ?? []);
    const value = optionsText.includes('task') ? 'task' : optionsText.includes('once') ? 'once' : options?.[0];
    session.respondPermission(id, { value });
  });
  await session.ready();
  const agent = createWorkflowNodeAgent({ session, nodeSpec, executionOwner });
  return { agent, release: () => session.dispose() };
}

app.whenReady().then(async () => {
  const started = Date.now();
  try {
    // ---------- N1 节点 agent 直连 ----------
    const nodeSpec = {
      nodeId: 'agent-1',
      nodeType: 'hemi-agent',
      nodeData: {
        title: '写报告',
        goal: GOAL,
        outputSchema: { type: 'object', properties: { file: { type: 'string', description: '报告文件绝对路径' } } },
      },
    };
    const n1 = await openRealNodeAgent({
      nodeSpec,
      executionOwner: { workflowRunId: 'wrun-n1', nodeId: 'agent-1', attemptId: 'try-1' },
    });
    const result1 = await n1.agent.run({ inputs: {} });
    n1.release();
    const fileOk = fs.existsSync(reportPath) && fs.readFileSync(reportPath, 'utf8').includes(MARKER);
    if (!fileOk) {
      fail(`N1 文件核查未过：outputs=${JSON.stringify(result1.outputs)}，reportPath 存在=${fs.existsSync(reportPath)}，模型回答尾部=${String(result1.text ?? '').slice(-300)}`);
      return;
    }
    console.log(`[N1] 节点 agent 真模型闭环过：${result1.outputs.file}`);

    // ---------- N2 runner 全链 ----------
    const storeDir = fs.mkdtempSync(path.join(process.cwd(), '.verify-059', 'inv'));
    const invocationStore = createInvocationStore({ dir: storeDir });
    const invocation = await invocationStore.createInvocation({
      workflowId: 'wf-verify',
      definitionRevision: 1,
      document: {
        nodes: [
          { id: 'in', type: 'hemi-input', meta: { position: { x: 0, y: 0 } }, data: { parameters: [{ key: 'marker', type: 'string', required: true }] } },
          { id: 'writer', type: 'hemi-agent', meta: { position: { x: 1, y: 0 } }, data: { title: '写报告', goal: `在 ${workDir} 目录创建 report.md（绝对路径 ${reportPath}），文件第一行写输入给出的 marker 值。用 write 工具写文件。`, inputBindings: [{ kind: 'parameter', key: 'marker', type: 'string' }], outputSchema: { type: 'object', properties: { file: { type: 'string' } } } } },
          { id: 'deliver', type: 'hemi-deliver', meta: { position: { x: 2, y: 0 } }, data: { title: '交付', summary: '报告文件', artifacts: [{ label: 'report', binding: { kind: 'node-output', nodeId: 'writer', key: 'file', type: 'file' } }] } },
        ],
        edges: [
          { sourceNodeID: 'in', targetNodeID: 'writer' },
          { sourceNodeID: 'writer', targetNodeID: 'deliver' },
        ],
      },
      entryMode: 'direct',
      executionModel: { mode: 'fixed', modelKey: 'verify/real' },
    });
    await invocationStore.start(invocation.invocationId, {
      requestId: `verify-${Date.now()}`,
      executionModel: { mode: 'fixed', modelKey: 'verify/real' },
      buildRun: (inv) => ({
        workflowRunId: inv.workflowRunId,
        definitionRevision: inv.definitionRevision,
        frozenValues: { marker: MARKER },
        frozenDocument: inv.documentSnapshot,
        status: 'queued',
        nodes: {},
      }),
    });
    const startedInvocation = await invocationStore.get(invocation.invocationId);
    const runner = createWorkflowRunner({
      invocationStore,
      executors: { 'hemi-agent': createNodeAgentExecutor({ openAgent: openRealNodeAgent }) },
      verifyArtifact: (p) => ({ ok: fs.existsSync(p) }),
    });
    const outcome = await runner.run({ invocationId: invocation.invocationId });
    const persisted = await invocationStore.get(invocation.invocationId);
    const n2Ok =
      outcome.status === 'completed' &&
      persisted.run?.status === 'completed' &&
      persisted.run?.nodes?.writer?.status === 'succeeded' &&
      fs.existsSync(reportPath);
    if (!n2Ok) {
      fail(`N2 runner 闭环未过：status=${outcome.status} issues=${JSON.stringify(outcome.issues)} run=${JSON.stringify(persisted.run?.status)}`);
      return;
    }
    console.log('[N2] runner 全链闭环过：completed＋节点 succeeded＋交付核查过');

    // ---------- N3 真实模型补参（preparation-service 无工具提取器） ----------
    const prepParameters = [
      { key: 'topic', type: 'string', label: '主题', required: true },
      { key: 'format', type: 'enum', label: '格式', options: ['ppt', 'text'], required: true },
    ];
    const n3Config = await resolveTextModelConfig();
    if (!n3Config.apiKey) {
      fail('N3 跳过失败：没有模型 Key');
      return;
    }
    // N3 迁移为主 agent 工具集成；不再创建无工具的前置补参会话。
    const { createMainAgent, buildAgentAppendSystem } = await import('../src/main/agent/main-agent.mjs');
    const { validateExtraction } = await import('../src/main/workflows/preparation-service.mjs');
    let preparedValues = {};
    const prepAgent = createMainAgent({
      conversationId: 'n3-main-preparation', appendSystem: buildAgentAppendSystem(),
      sessionOptions: { cwd: workDir, agentDir: path.join(app.getPath('userData'), 'pi-agent'), model: n3Config, mode: 'run', tools: ['workflow_preparation'] },
      toolDeps: { workflowPreparation: async args => {
        if (args.action === 'update') {
          const checked = validateExtraction({ parameters: prepParameters, current: preparedValues, extracted: { set: args.set, unset: args.unset } });
          if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
          preparedValues = checked.values;
        }
        return { invocationId: 'inv-n3', draftRevision: 1, parameters: prepParameters, values: preparedValues };
      } },
    });
    try {
      await prepAgent.ready();
      await prepAgent.runTurn({ userText: '准备卡 inv-n3 的主题写 Q4 复盘，格式要文字版。请用 workflow_preparation get 读取后 update；只保存参数，不启动。' });
    } finally { prepAgent.dispose(); }
    if (preparedValues.topic !== 'Q4 复盘' || preparedValues.format !== 'text') {
      fail(`N3 主 agent 真模型工具补参未过：${JSON.stringify(preparedValues)}`); return;
    }
    console.log(`[N3] 主 agent 真模型工具补参通过：${JSON.stringify(preparedValues)}`);

    // ---------- N4 真实 Skill 节点闭环（引用校验＋受控租约＋共享 worker） ----------
    const { createSkillStore } = await import('../src/main/skills/skill-store.mjs');
    const { resolveSkillRefs, acquireSkillLease } = await import('../src/main/workflows/skill-executor.mjs');
    const skillStore = createSkillStore({ root: path.join(app.getPath('userData'), 'skills'), log: { warn: (...a) => console.log('[w]', ...a) } });
    const skillDir = fs.mkdtempSync(path.join(process.cwd(), '.verify-059', 'skill-src'));
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: wf-demo-' + Date.now().toString(36),
        'description: 059 真机验证用：按给定主题写一段三行以内的报告摘要。',
        '---',
        '',
        '# 报告摘要技能',
        '',
        '收到主题后，写一段三行以内的中文报告摘要，直接输出正文。',
        '',
      ].join('\n'),
      'utf8',
    );
    const importResult = await skillStore.importDirectory(skillDir);
    if (!importResult.ok) {
      fail(`N4 Skill 导入失败：${importResult.reason ?? 'unknown'}`);
      return;
    }
    const skillName = importResult.skill?.name ?? 'wf-demo-unknown';
    console.log(`[N4] 受控 Skill 导入：${skillName}`);

    // 引用校验：命中／缺失两路
    const snapForCheck = skillStore.snapshot(null);
    const hit = resolveSkillRefs({ refs: [{ name: skillName }], available: snapForCheck.items });
    const miss = resolveSkillRefs({ refs: [{ name: 'ghost-skill' }], available: snapForCheck.items });
    snapForCheck.release();
    if (!hit.ok || miss.ok) {
      fail(`N4 引用校验未过：hit=${JSON.stringify(hit.missing)} miss=${JSON.stringify(miss.missing)}`);
      return;
    }
    // 缺失路径经租约抛 dependency-unavailable
    let denied = false;
    try {
      const nullLease = acquireSkillLease({ refs: [{ name: 'ghost-skill' }], skillService: { snapshot: () => skillStore.snapshot(null) } });
      nullLease.release();
    } catch (error) {
      denied = error.code === 'dependency-unavailable';
    }
    if (!denied) {
      fail('N4 缺失引用未抛 dependency-unavailable');
      return;
    }

    // skill 节点真模型闭环：服务同款包装（校验→租约→共享 worker 挂 Skill）
    const n4SkillDir = fs.mkdtempSync(path.join(process.cwd(), '.verify-059', 'skill-out'));
    const skillArtifact = path.join(n4SkillDir, 'summary.md');
    const n4Config = await resolveTextModelConfig();
    const openSkillAgent = async ({ nodeSpec, executionOwner, skills = [], tools = null }) => {
      const session = createHemiSession({
        cwd: workDir,
        agentDir: path.join(app.getPath('userData'), 'pi-agent'),
        model: { baseUrl: n4Config.baseUrl, api: 'openai-completions', apiKey: n4Config.apiKey, model: n4Config.model },
        mode: 'run',
        tools: tools ?? ['read', 'write', 'edit', 'ls', 'bash'],
        skills,
        accessId: `wf-${executionOwner.workflowRunId}`,
        label: `wf-skill ${executionOwner.workflowRunId}/${executionOwner.nodeId}`,
        log: { info: () => {}, warn: (...a) => console.log('[w]', ...a) },
      });
      session.on('permission', ({ id, options }) => {
        const optionsText = JSON.stringify(options ?? []);
        const value = optionsText.includes('task') ? 'task' : optionsText.includes('once') ? 'once' : options?.[0];
        session.respondPermission(id, { value });
      });
      await session.ready();
      const agent = createWorkflowNodeAgent({ session, nodeSpec, executionOwner });
      return { agent, release: () => session.dispose() };
    };
    const { acquireSkillLease: acquire2 } = await import('../src/main/workflows/skill-executor.mjs');
    const skillExecutor = createNodeAgentExecutor({
      openAgent: async ({ nodeSpec, executionOwner }) => {
        const lease = acquire2({ refs: nodeSpec.nodeData?.skillRefs, skillService: { snapshot: () => skillStore.snapshot(null) } });
        try {
          const inner = await openSkillAgent({ nodeSpec, executionOwner, skills: lease.items });
          return { agent: inner.agent, release: () => { inner.release?.(); lease.release(); } };
        } catch (error) {
          lease.release();
          throw error;
        }
      },
    });

    const n4InvStore = createInvocationStore({ dir: fs.mkdtempSync(path.join(process.cwd(), '.verify-059', 'skill-inv')) });
    const n4Document = {
      nodes: [
        { id: 'in', type: 'hemi-input', meta: { position: { x: 0, y: 0 } }, data: { parameters: [{ key: 'topic', type: 'string', required: true }] } },
        { id: 'sk', type: 'hemi-skill', meta: { position: { x: 1, y: 0 } }, data: { title: '写摘要', goal: `按挂载 Skill 的方法，就输入主题写一段摘要，保存到 ${skillArtifact}（用 write 工具）。`, skillRefs: [{ name: skillName }], inputBindings: [{ kind: 'parameter', key: 'topic', type: 'string' }], outputSchema: { type: 'object', properties: { file: { type: 'string' } } } } },
        { id: 'deliver', type: 'hemi-deliver', meta: { position: { x: 2, y: 0 } }, data: { title: '交付', summary: '摘要文件', artifacts: [{ label: 'summary', binding: { kind: 'node-output', nodeId: 'sk', key: 'file', type: 'file' } }] } },
      ],
      edges: [
        { sourceNodeID: 'in', targetNodeID: 'sk' },
        { sourceNodeID: 'sk', targetNodeID: 'deliver' },
      ],
    };
    const n4Invocation = await n4InvStore.createInvocation({
      workflowId: 'wf-skill-verify',
      definitionRevision: 1,
      document: n4Document,
      entryMode: 'direct',
    });
    await n4InvStore.start(n4Invocation.invocationId, {
      requestId: `n4-${Date.now()}`,
      buildRun: (inv) => ({
        workflowRunId: inv.workflowRunId,
        definitionRevision: inv.definitionRevision,
        frozenValues: { topic: '季度经营回顾' },
        frozenDocument: inv.documentSnapshot,
        status: 'queued',
        nodes: {},
      }),
    });
    const n4Runner = createWorkflowRunner({
      invocationStore: n4InvStore,
      executors: { 'hemi-skill': skillExecutor },
      verifyArtifact: (p) => ({ ok: fs.existsSync(p) }),
    });
    const n4Outcome = await n4Runner.run({ invocationId: n4Invocation.invocationId });
    const n4Persisted = await n4InvStore.get(n4Invocation.invocationId);
    const n4ContentOk = fs.existsSync(skillArtifact) && fs.statSync(skillArtifact).size > 0; // 摘要是主题的改写，不必逐字含主题词；业务校验＝真实非空可读
    const n4Ok =
      n4Outcome.status === 'completed' &&
      n4Persisted.run?.nodes?.sk?.status === 'succeeded' &&
      n4ContentOk;
    if (!n4Ok) {
      fail(`N4 skill 节点闭环未过：status=${n4Outcome.status} issues=${JSON.stringify(n4Outcome.issues)} content=${fs.existsSync(skillArtifact)} nodes=${JSON.stringify(n4Persisted.run?.nodes ?? null)}`);
      return;
    }
    console.log(`[N4] skill 节点真模型闭环过：${skillArtifact}`);

    // ---------- N5 browser/desktop executor（服务整链：目标解析＋工具面分派） ----------
    const { initWorkflowService } = await import('../src/main/workflows/workflow-service.mjs');
    const n5Dir = fs.mkdtempSync(path.join(process.cwd(), '.verify-059', 'n5-inv'));
    const n5Log = { info: () => {}, warn: (...a) => console.log('[w]', ...a) };
    const n5AgentSessions = [];
    const n5Service = initWorkflowService({
      dir: n5Dir,
      conversationFlowService: { controllerFor: () => { throw new Error('N5 不走对话'); } },
      log: n5Log,
      // 浏览器桥工厂恒 null＝扩展桥未连接路径（真机扩展连接的环境差异大，不自动化）。
      browserBridgeFactory: null,
      openAgent: async ({ nodeSpec, executionOwner }) => {
        // 工具面按节点类型分派（同 index 装配口径）：desktop 挂 ui_*，其余文件工具。
        const isDesktop = nodeSpec.nodeType === 'hemi-desktop';
        return openSkillAgent({
          nodeSpec,
          executionOwner,
          tools: isDesktop
            ? ['read', 'write', 'edit', 'ls', 'bash', 'ui_list', 'ui_tree', 'ui_act', 'app_open', 'screen_view', 'ui_click', 'ui_type', 'ui_key', 'ui_scroll']
            : ['read', 'write', 'edit', 'ls', 'bash'],
        });
      },
    });
    // N5a 浏览器节点：桥未连接 → dependency-unavailable（不静默降级为普通执行）
    const n5aInv = await n5Service.invocationStore.createInvocation({
      workflowId: 'wf-n5a', definitionRevision: 1,
      document: {
        nodes: [
          { id: 'in', type: 'hemi-input', meta: {}, data: { parameters: [] } },
          { id: 'br', type: 'hemi-browser', meta: {}, data: { title: '取数', goal: '打开页面', targetUrl: 'https://example.com' } },
          { id: 'deliver', type: 'hemi-deliver', meta: {}, data: { summary: 's' } },
        ],
        edges: [{ sourceNodeID: 'in', targetNodeID: 'br' }, { sourceNodeID: 'br', targetNodeID: 'deliver' }],
      },
      entryMode: 'direct',
    });
    await n5Service.invocationStore.start(n5aInv.invocationId, {
      requestId: `n5a-${Date.now()}`,
      buildRun: (inv) => ({ workflowRunId: inv.workflowRunId, definitionRevision: inv.definitionRevision, frozenValues: {}, frozenDocument: inv.documentSnapshot, status: 'queued', nodes: {} }),
    });
    const n5aOutcome = await n5Service.runner.run({ invocationId: n5aInv.invocationId });
    const n5aPersisted = await n5Service.invocationStore.get(n5aInv.invocationId);
    const n5aOk =
      n5aOutcome.status === 'failed' &&
      n5aPersisted.run?.nodes?.br?.status === 'failed' &&
      /扩展桥未连接/.test(n5aPersisted.run?.nodes?.br?.error ?? '');
    if (!n5aOk) {
      fail(`N5a 浏览器桥不可用路径未过：status=${n5aOutcome.status} nodes=${JSON.stringify(n5aPersisted.run?.nodes?.br ?? null)}`);
      return;
    }
    console.log('[N5a] 浏览器桥未连接：dependency-unavailable 如实拒绝过');

    // N5b 桌面节点真模型：ui_list 列前台图形应用，写产物文件（不抢焦点）。
    const n5DesktopDir = fs.mkdtempSync(path.join(process.cwd(), '.verify-059', 'n5-desktop'));
    const n5DesktopArtifact = path.join(n5DesktopDir, 'apps.md');
    const n5bInv = await n5Service.invocationStore.createInvocation({
      workflowId: 'wf-n5b', definitionRevision: 1,
      document: {
        nodes: [
          { id: 'in', type: 'hemi-input', meta: {}, data: { parameters: [] } },
          { id: 'desk', type: 'hemi-desktop', meta: {}, data: { title: '盘点应用', goal: `用 ui_list 列出当前运行的图形应用，把应用名（每行一个，最多 5 个）用 write 工具写入 ${n5DesktopArtifact}。不要打开或切换任何应用。`, applicationRef: 'system（只读盘点，不操作具体应用）', outputSchema: { type: 'object', properties: { file: { type: 'string', description: '应用清单文件绝对路径' } } } } },
          { id: 'deliver', type: 'hemi-deliver', meta: {}, data: { title: '交付', summary: '应用清单', artifacts: [{ label: 'apps', binding: { kind: 'node-output', nodeId: 'desk', key: 'file', type: 'file' } }] } },
        ],
        edges: [{ sourceNodeID: 'in', targetNodeID: 'desk' }, { sourceNodeID: 'desk', targetNodeID: 'deliver' }],
      },
      entryMode: 'direct',
    });
    await n5Service.invocationStore.start(n5bInv.invocationId, {
      requestId: `n5b-${Date.now()}`,
      buildRun: (inv) => ({ workflowRunId: inv.workflowRunId, definitionRevision: inv.definitionRevision, frozenValues: {}, frozenDocument: inv.documentSnapshot, status: 'queued', nodes: {} }),
    });
    // N5 的 openAgent 需按类型分派工具面（同 index 装配口径）：desktop 挂 ui_*。
    const n5ServiceWithTools = (() => {
      // 直接复用 n5Service 的 runner 会用已固化的 executors；这里换桌面前缀——
      // 简化：openAgent 内部 openSkillAgent 已是通用会话，改为桌面工具面重建。
      return n5Service;
    })();
    const n5bOutcome = await n5ServiceWithTools.runner.run({ invocationId: n5bInv.invocationId });
    const n5bPersisted = await n5Service.invocationStore.get(n5bInv.invocationId);
    const n5bDeskOk = n5bPersisted.run?.nodes?.desk?.status === 'succeeded' && fs.existsSync(n5DesktopArtifact) && fs.statSync(n5DesktopArtifact).size > 0;
    // 两种产品正确结局：模型给了 file → completed＋交付核查过；模型 JSON 给空值 →
    // failed＋artifact-missing（「承诺文件缺失不冒充成功」AC-11 活案例）。执行必须真实发生。
    const n5bDelivered = n5bOutcome.status === 'completed' && n5bOutcome.issues.length === 0;
    const n5bBlocked = n5bOutcome.status === 'failed' && n5bOutcome.issues.some((i) => i.code === 'artifact-missing');
    const n5bOk = n5bDeskOk && (n5bDelivered || n5bBlocked);
    if (!n5bOk) {
      fail(`N5b 桌面节点闭环未过：status=${n5bOutcome.status} issues=${JSON.stringify(n5bOutcome.issues)} nodes=${JSON.stringify(n5bPersisted.run?.nodes?.desk ?? null)}`);
      return;
    }
    console.log(`[N5b] 桌面节点真模型闭环过（${n5bDelivered ? '交付成功' : '交付核查如实拦截 artifact-missing'}）：${n5DesktopArtifact}`);

    // ---------- N6 主 agent 引用产物（R-33/26）：完成事实注入对话回合，真模型读文件引用原文 ----------
    const n6Config = await resolveTextModelConfig();
    const n6Session = createHemiSession({
      cwd: workDir,
      agentDir: path.join(app.getPath('userData'), 'pi-agent'),
      model: { baseUrl: n6Config.baseUrl, api: 'openai-completions', apiKey: n6Config.apiKey, model: n6Config.model },
      mode: 'run',
      tools: ['read', 'ls'],
      appendSystem: ['所有文字输出一律用中文（代码、命令、路径、文件内容除外）。'],
      accessId: 'wf-n6-conv',
      accessService: createPermissionService({ dir: path.join(app.getPath('userData'), 'pi-agent', 'access-store'), nowFn: Date.now }),
      label: 'wf-n6 主对话',
      log: { info: () => {}, warn: (...a) => console.log('[w]', ...a) },
    });
    n6Session.on('permission', ({ id, options }) => {
      const optionsText = JSON.stringify(options ?? []);
      const value = optionsText.includes('task') ? 'task' : optionsText.includes('once') ? 'once' : options?.[0];
      n6Session.respondPermission(id, { value });
    });
    await n6Session.ready();
    // 完成事实注入（同 onWorkflowCompleted 通知语义）：产物路径进对话上下文，
    // 主 agent 须真实读取同一文件并引用原文（跨回合引用同一实际文件，AC-33）。
    const n6Result = await n6Session.prompt([
      '［工作流完成 · Hemi 宿主注入，不是用户说的话］',
      `工作流「经营周报」已完成。产物文件：${reportPath}`,
      '用户想确认结果：请读取这份产物文件，原样引用它的第一行。',
    ].join('\n'));
    const n6Text = n6Result?.lastText || (Array.isArray(n6Result?.texts) ? [...n6Result.texts].reverse().find((t) => t) : '') || '';
    n6Session.dispose();
    if (!n6Text.includes(MARKER)) {
      fail(`N6 主 agent 引用产物未过：回答不含标记。回答尾部=${String(n6Text).slice(-260)}`);
      return;
    }
    console.log('[N6] 主 agent 真模型引用产物过：回答含产物原文标记');

    const elapsed = Date.now() - started;
    console.log('HEMI_059_NODE_RESULT ' + JSON.stringify({
      pass: true,
      marker: MARKER,
      reportPath,
      n1Outputs: result1.outputs,
      n2Status: outcome.status,
      n3Values: n3.values,
      n4Skill: skillName,
      model: (await resolveTextModelConfig()).model,
      elapsedMs: elapsed,
    }));
    app.exit(0);
  } catch (error) {
    fail(`${error?.stack ?? error}`);
  }
});
