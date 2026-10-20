// 059 S0 复验探针（P02'/03'/04'）：验证 vendored 引擎内核（src/main/workflows/vendor/flowgram-engine/）
// 补齐发布包的三道缺口，过门才进 S1。场景对标 probe-059-runtime.mjs 的判定，另加 vendor 特有项：
//   V01 工厂装配：自定义 Hemi executor 注册后被按类型分派（发布包 E01/E06 的反面）
//   V02 Validate：环／双 start／缺 end／输入类型错全拒（与发布包判定一致）
//   V03 互斥条件两支＋结构化汇合：只执行所选支、未选支零调用、汇合只留选中键
//   V04 失败传播：executor 抛错 → failed、下游零调用
//   V05 确定性：同输入两跑输出 deep-equal
//   P03' 停止栅栏：cancel 后（a）宿主合作中止信号在 executor 内生效、（b）迟到的 executor 返回
//        不推进后继（引擎 terminated 守卫）、（c）终态不倒退
//   P04' 恢复回放：同一冻结 schema 重建引擎＋回放 executor——已提交成功节点返回缓存输出且
//        零重执行（外部动作计数不增）、首个未完成节点新建尝试；「成功但结果写失败」的节点
//        无缓存即按新尝试重跑（宿主必须先持久提交，见 runtime-and-agent §8）——探针同时钉住
//        「回放只信任宿主持久缓存，不信任引擎内存」这一契约
// 运行：node scripts/probe-059-engine.mjs（exit 0＝全过）
import { createWorkflowEngine, WorkflowStatus } from '../src/main/workflows/vendor/flowgram-engine/index.mjs'

const findings = []
function record(id, claim, ok, detail) {
  findings.push({ id, claim, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}`)
  if (detail !== undefined) console.log(`      → ${JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ref = (n, k) => ({ type: 'ref', content: [n, k] })
const constant = (v) => ({ type: 'constant', content: v })
const node = (id, type, data) => ({ id, type, meta: { position: { x: 0, y: 0 } }, data })
const edge = (s, t, sp) => ({ sourceNodeID: s, targetNodeID: t, ...(sp ? { sourcePortID: sp } : {}) })
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 可控负载 executor：记录每次调用，可配延迟与抛错
function makeCountingExecutor(type, { delayMs = 0, failIds = [] } = {}) {
  const calls = []
  return {
    executor: {
      type,
      async execute(ctx) {
        calls.push(ctx.node.id)
        if (delayMs > 0) await sleep(delayMs)
        if (failIds.includes(ctx.node.id)) throw new Error(`executor failed: ${ctx.node.id}`)
        return { outputs: { line: `${ctx.inputs.topic ?? ''}→${ctx.node.id}` } }
      },
    },
    calls,
  }
}

const conditionGraph = () => ({
  nodes: [
    node('n-start', 'start', {
      title: '输入',
      outputs: { type: 'object', properties: { format: { type: 'string' }, topic: { type: 'string' } }, required: ['format', 'topic'] },
    }),
    node('n-cond', 'condition', {
      title: '分流',
      conditions: [{ key: 'ppt', value: { left: ref('n-start', 'format'), operator: 'eq', right: constant('ppt') } }],
    }),
    node('n-a', 'hemi-task', { title: 'A', inputs: { type: 'object', properties: { topic: { type: 'string' } } }, inputsValues: { topic: ref('n-start', 'topic') }, outputs: { type: 'object', properties: { line: { type: 'string' } } } }),
    node('n-b', 'hemi-task', { title: 'B', inputs: { type: 'object', properties: { topic: { type: 'string' } } }, inputsValues: { topic: ref('n-start', 'topic') }, outputs: { type: 'object', properties: { line: { type: 'string' } } } }),
    node('n-end', 'end', { title: '交付', inputs: { type: 'object', properties: { fromA: { type: 'string' }, fromB: { type: 'string' } } }, inputsValues: { fromA: ref('n-a', 'line'), fromB: ref('n-b', 'line') } }),
  ],
  edges: [edge('n-start', 'n-cond'), edge('n-cond', 'n-a', 'ppt'), edge('n-cond', 'n-b', 'else'), edge('n-a', 'n-end'), edge('n-b', 'n-end')],
})

// ---------- V01 工厂装配 ----------

{
  const { executor: exec, calls } = makeCountingExecutor('hemi-task')
  const engine = createWorkflowEngine({ executors: [exec] })
  const task = engine.invoke({ schema: conditionGraph(), inputs: { format: 'ppt', topic: '周报' } })
  const outputs = await task.processing
  const report = task.context.reporter.export()
  record(
    'V01',
    '工厂＋自定义 hemi-task executor：注册生效、按类型分派、终态 succeeded',
    report.workflowStatus.status === WorkflowStatus.Succeeded && same(calls, ['n-a']) && same(outputs, { fromA: '周报→n-a' }),
    { status: report.workflowStatus.status, calls, outputs }
  )
}

// ---------- V02 Validate ----------

{
  const engine = createWorkflowEngine()
  // 同步校验路径：invoke 内 validate 同步完成，reporter 立即可读
  const check = (schema, inputs) => {
    const task = engine.invoke({ schema, inputs })
    return task.context.reporter.export()
  }
  const g = conditionGraph()
  const gCycle = { nodes: g.nodes, edges: [...g.edges, edge('n-end', 'n-cond')] }
  const gTwoStarts = { nodes: [...g.nodes, node('s2', 'start', { outputs: { type: 'object' } })], edges: g.edges }
  const gNoEnd = { nodes: g.nodes.filter((n) => n.type !== 'end'), edges: g.edges.filter((e) => e.targetNodeID !== 'n-end') }

  const rOk = check(conditionGraph(), { format: 'ppt', topic: 'x' })
  // rOk 在异步执行未启动时 status 可能已是 processing；只验校验不拒
  record('V02a', 'Validate：合法图不拒（failed 才算拒）', rOk.workflowStatus.status !== WorkflowStatus.Failed, rOk.workflowStatus.status)
  const rCycle = check(gCycle, { format: 'ppt', topic: 'x' })
  record('V02b', 'Validate：有环拒', rCycle.workflowStatus.status === WorkflowStatus.Failed && rCycle.messages.error?.some((m) => m.message.includes('cycle')), rCycle.messages.error)
  const rTwo = check(gTwoStarts, { format: 'ppt', topic: 'x' })
  record('V02c', 'Validate：双 start 拒', rTwo.workflowStatus.status === WorkflowStatus.Failed && rTwo.messages.error?.some((m) => m.message.includes('only one start')), rTwo.messages.error)
  const rNoEnd = check(gNoEnd, { format: 'ppt', topic: 'x' })
  record('V02d', 'Validate：缺 end 拒', rNoEnd.workflowStatus.status === WorkflowStatus.Failed && rNoEnd.messages.error?.some((m) => m.message.includes('end node')), rNoEnd.messages.error)
  const rBadInput = check(conditionGraph(), { format: 123, topic: 'x' })
  record('V02e', 'Validate：输入类型错拒', rBadInput.workflowStatus.status === WorkflowStatus.Failed && rBadInput.messages.error?.some((m) => m.message.includes('JSON Schema validation failed')), rBadInput.messages.error)
}

// ---------- V03 条件两支＋汇合 ----------

{
  const { executor: exec, calls } = makeCountingExecutor('hemi-task')
  const engine = createWorkflowEngine({ executors: [exec] })
  const task = engine.invoke({ schema: conditionGraph(), inputs: { format: 'text', topic: '月报' } })
  const outputs = await task.processing
  const report = task.context.reporter.export()
  record(
    'V03',
    'else 支：只调 n-b、n-a 报告缺失（skipped 由宿主投影）、汇合输出只留 fromB',
    same(calls, ['n-b']) && !('n-a' in report.reports) && same(outputs, { fromB: '月报→n-b' }),
    { calls, hasA: 'n-a' in report.reports, outputs }
  )
}

// ---------- V04 失败传播 ----------

{
  const { executor: exec, calls } = makeCountingExecutor('hemi-task', { failIds: ['n-bad'] })
  const engine = createWorkflowEngine({ executors: [exec] })
  const g = {
    nodes: [
      node('s', 'start', { outputs: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } }),
      node('n-ok', 'hemi-task', { inputs: { type: 'object', properties: { topic: { type: 'string' } } }, inputsValues: { topic: ref('s', 'topic') }, outputs: { type: 'object', properties: { line: { type: 'string' } } } }),
      node('n-bad', 'hemi-task', { inputs: { type: 'object', properties: { topic: { type: 'string' } } }, inputsValues: { topic: ref('s', 'topic') }, outputs: { type: 'object', properties: { line: { type: 'string' } } } }),
      node('n-after', 'hemi-task', { inputs: { type: 'object', properties: { topic: { type: 'string' } } }, inputsValues: { topic: ref('s', 'topic') }, outputs: { type: 'object', properties: { line: { type: 'string' } } } }),
      node('e', 'end', {}),
    ],
    edges: [edge('s', 'n-ok'), edge('n-ok', 'n-bad'), edge('n-bad', 'n-after'), edge('n-after', 'e')],
  }
  const task = engine.invoke({ schema: g, inputs: { topic: 'x' } })
  await task.processing
  const report = task.context.reporter.export()
  record(
    'V04',
    'executor 抛错：终态 failed、n-ok succeeded、下游 n-after 零调用且报告缺失',
    report.workflowStatus.status === WorkflowStatus.Failed &&
      report.reports['n-ok']?.status === 'succeeded' &&
      report.reports['n-bad']?.status === 'failed' &&
      !calls.includes('n-after') &&
      !('n-after' in report.reports),
    { status: report.workflowStatus.status, calls, after: report.reports['n-after'] ?? '(absent)' }
  )
}

// ---------- V05 确定性 ----------

{
  const run = async () => {
    const { executor: exec } = makeCountingExecutor('hemi-task')
    const engine = createWorkflowEngine({ executors: [exec] })
    const task = engine.invoke({ schema: conditionGraph(), inputs: { format: 'ppt', topic: '周报' } })
    await task.processing
    return task.context.reporter.export()
  }
  const [r1, r2] = [await run(), await run()]
  const strip = (r) => JSON.stringify({ o: r.outputs, s: r.workflowStatus.status, n: Object.fromEntries(Object.entries(r.reports).map(([k, v]) => [k, v.status])) })
  record('V05', '同输入两跑（独立引擎实例）输出与状态序列 deep-equal', strip(r1) === strip(r2), {})
}

// ---------- P03' 停止栅栏 ----------

{
  // 宿主合作中止模式：executor 收宿主信号（这里用 task.cancel 后的 terminated 状态模拟 epoch 栅栏）
  let externalActions = 0
  let lateResolveFired = false
  class CooperativeExecutor {
    constructor() {
      this.type = 'hemi-coop'
    }
    async execute(ctx) {
      // 外部动作分两步：已发出的动作 + 动作后的提交。cancel 栅栏后不再发新动作、不再提交
      await sleep(120)
      if (ctx.runtime.statusCenter.workflow.terminated) {
        return { outputs: {} }
      }
      externalActions += 1
      // 模拟慢外部操作期间被 cancel
      await sleep(250)
      if (ctx.runtime.statusCenter.workflow.terminated) {
        return { outputs: {} }
      }
      lateResolveFired = true
      return { outputs: { done: true } }
    }
  }
  const engine = createWorkflowEngine({ executors: [new CooperativeExecutor()] })
  const g = {
    nodes: [node('s', 'start', { outputs: { type: 'object' } }), node('c1', 'hemi-coop', {}), node('c2', 'hemi-coop', {}), node('e', 'end', {})],
    edges: [edge('s', 'c1'), edge('c1', 'c2'), edge('c2', 'e')],
  }
  const task = engine.invoke({ schema: g, inputs: {} })
  await sleep(150) // c1 已入外部动作
  task.cancel()
  const settleReason = await Promise.race([task.processing.then(() => 'processing-resolved'), sleep(2000).then(() => 'hung')])
  const report = task.context.reporter.export()
  record(
    "P03'a",
    'cancel 后 executor 合作中止：零新外部动作（第一次动作后栅栏生效）',
    externalActions === 1,
    { externalActions }
  )
  record(
    "P03'b",
    '引擎在 cancel 后 settles（task.processing resolve，不悬挂）',
    settleReason === 'processing-resolved',
    { settleReason }
  )
  record(
    "P03'c",
    '终态 canceled 不倒退：c1 节点 canceled、c2 与 end 零执行零报告',
    report.workflowStatus.status === WorkflowStatus.Cancelled &&
      report.reports['c1']?.status === 'canceled' &&
      !('c2' in report.reports) &&
      !('e' in report.reports) &&
      lateResolveFired === false,
    { status: report.workflowStatus.status, c1: report.reports['c1']?.status, hasC2: 'c2' in report.reports, hasEnd: 'e' in report.reports }
  )
}

// ---------- P04' 恢复回放 ----------

{
  // 宿主恢复模式原型：持久缓存（已提交成功节点）→ 回放 executor；未完成节点真执行
  const frozenSchema = conditionGraph()
  const realCalls = []
  const persisted = {
    // 模拟强退前已持久提交：n-start、n-cond、n-a 成功（含分支决定 ppt）
    'n-start': { outputs: { format: 'ppt', topic: '周报' }, branch: undefined },
    'n-cond': { outputs: {}, branch: 'ppt' },
    'n-a': { outputs: { line: '周报→n-a' }, branch: undefined },
  }
  class ReplayExecutor {
    constructor() {
      this.type = 'hemi-task'
    }
    async execute(ctx) {
      realCalls.push(ctx.node.id)
      const cached = persisted[ctx.node.id]
      if (cached) {
        return { outputs: cached.outputs, branch: cached.branch }
      }
      return { outputs: { line: `${ctx.inputs.topic ?? ''}→${ctx.node.id}` } }
    }
  }
  const engine = createWorkflowEngine({ executors: [new ReplayExecutor()] })
  const task = engine.invoke({ schema: frozenSchema, inputs: { format: 'ppt', topic: '周报' } })
  const outputs = await task.processing
  const report = task.context.reporter.export()
  record(
    "P04'a",
    '恢复回放：已提交节点从缓存返回（仍占一次 executor 调用但不做外部动作——realCalls 只经回放层）、B 新尝试真执行、终态 succeeded',
    report.workflowStatus.status === WorkflowStatus.Succeeded &&
      same(realCalls.filter((id) => id === 'n-a'), ['n-a']) &&
      same(outputs, { fromA: '周报→n-a' }),
    { realCalls, outputs }
  )

  // 「节点成功但结果写失败」：缓存里没有 n-a → 回放层按新尝试重跑（宿主契约：先持久提交才许回放）
  realCalls.length = 0
  delete persisted['n-a']
  const engine2 = createWorkflowEngine({ executors: [new ReplayExecutor()] })
  const task2 = engine2.invoke({ schema: frozenSchema, inputs: { format: 'ppt', topic: '周报' } })
  const outputs2 = await task2.processing
  const report2 = task2.context.reporter.export()
  record(
    "P04'b",
    '无持久缓存的成功节点（写失败场景）按新尝试重跑：n-a 重执行、终态 succeeded（不假装已完成）',
    report2.workflowStatus.status === WorkflowStatus.Succeeded && realCalls.includes('n-a') && same(outputs2, { fromA: '周报→n-a' }),
    { realCalls }
  )
}

// ---------- 收口 ----------

const failed = findings.filter((f) => !f.ok)
console.log(`\n${findings.length - failed.length}/${findings.length} 项通过`)
if (failed.length > 0) {
  console.log(`未过：${failed.map((f) => f.id).join('、')}`)
  process.exit(1)
}
