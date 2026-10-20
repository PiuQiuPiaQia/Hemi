// 059 S0 Runtime 探针：钉死 @flowgram.ai/runtime-js@1.0.16 发布包的真实能力边界。
// 只经包的公开导出（TaskRun/Report/Result/Cancel/Validate API）驱动；工作负载用内置 http 节点
// 打到探针自起的 127.0.0.1 临时服务器（探针专用，不属产品架构）：
//   E01 导出面＝5 个 API 函数，引擎/容器/executor 注册表不导出 → 自定义 Hemi executor 无公开挂载路径
//   E02 Validate：合法图过；环／双 start／缺 end／输入类型错全拒
//   E03 条件两支＋互斥汇合：选中的支执行、未选支在 report 里整个缺失（reports 只收启动过的节点，
//       连 pending 项都没有；skipped 语义只能靠宿主自己投影）、end 只执行一次、
//       汇合双绑定（fromA/fromB）只有选中支的键出现
//   E04 同图换输入走 else 支，对称成立
//   E05 确定性：同输入两跑输出 deep-equal；两次 taskID 不同（每跑一个 uuid，无运行身份连续性）
//   E06 自定义节点类型（hemi-agent）→ workflow failed，错误＝No executor found for node type
//   E07 节点失败传播：http 节点 socket 被断 → 终态 failed、下游未执行、result()＝{}
//   E08 内置 CodeExecutor 在 quickjs-emscripten@0.32.0 上必挂（Lifetime not alive：
//       getPromiseState(promiseState).value 与 unwrapResult 句柄同命，双重 dispose）——发布包自带 bug
//   C01 在途取消：慢节点 2 processing 时 cancel → 终态 canceled、节点 3 永不启动且服务端零新请求、
//       被取消节点快照无 outputs（迟到结果被丢，终态不倒退）；
//       服务端日志证明在途 HTTP 在 cancel 之后仍跑完（Runtime 不中止在途工作）
//   C02 完成后 cancel：状态保持 succeeded
//   C03 未知 taskID cancel → success:false
//   R01 跨进程持久化：子进程 A 跑完退出，子进程 B 查同 taskID → report undefined
//   R02 canceled／failed 的 result() 均为 {}，与成功空输出不可区分（只能看 report 状态）
// 历史能力探针，不随产品安装上游 runtime。复跑前在独立目录安装固定版本：
//   npm install --prefix /tmp/hemi-flowgram-probe @flowgram.ai/runtime-js@1.0.16
//   HEMI_FLOWGRAM_PROBE_DIR=/tmp/hemi-flowgram-probe node scripts/probe-059-runtime.mjs
// exit 0＝全过；本脚本不会自动安装依赖。
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'

if (!process.env.HEMI_FLOWGRAM_PROBE_DIR) throw new Error('历史上游能力探针需要独立安装目录：设置 HEMI_FLOWGRAM_PROBE_DIR；Hemi 生产引擎不依赖该包')
const probeRoot = path.resolve(process.env.HEMI_FLOWGRAM_PROBE_DIR)
const runtimeRoot = path.join(probeRoot, 'node_modules/@flowgram.ai/runtime-js')
const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'))
if (runtimeManifest.version !== '1.0.16') throw new Error('历史探针只验证 @flowgram.ai/runtime-js@1.0.16')
const runtimeUrl = pathToFileURL(path.join(runtimeRoot, 'dist/esm/index.js')).href
const require = createRequire(path.join(runtimeRoot, 'package.json'))
const pkg = await import(runtimeUrl)
const { TaskRunAPI, TaskReportAPI, TaskResultAPI, TaskCancelAPI, TaskValidateAPI } = pkg

const findings = []
function record(id, claim, ok, detail) {
  findings.push({ id, claim, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${claim}`)
  if (detail !== undefined) console.log(`      → ${JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 探针服务器（127.0.0.1 临时端口，记录每个请求的 start/done） ----------

const requestLog = []
const server = http.createServer((req, res) => {
  const entry = { path: req.url, startedAt: Date.now(), doneAt: null }
  requestLog.push(entry)
  const u = new URL(req.url, 'http://127.0.0.1')
  if (u.pathname === '/kill') {
    res.destroy()
    entry.doneAt = Date.now()
    return
  }
  const ms = Number(u.searchParams.get('ms') ?? 30)
  const topic = u.searchParams.get('topic') ?? 'x'
  const kind = u.searchParams.get('kind') ?? 'k'
  setTimeout(() => {
    entry.doneAt = Date.now()
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`${topic}→${kind}`)
  }, ms)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const requestsTo = (pathPrefix) => requestLog.filter((e) => e.path.startsWith(pathPrefix))

// ---------- 图构造 ----------

const ref = (nodeId, key) => ({ type: 'ref', content: [nodeId, key] })
const constant = (v) => ({ type: 'constant', content: v })
const node = (id, type, data) => ({ id, type, meta: { position: { x: 0, y: 0 } }, data })
const edge = (sourceNodeID, targetNodeID, sourcePortID, targetPortID) => ({
  sourceNodeID,
  targetNodeID,
  ...(sourcePortID ? { sourcePortID } : {}),
  ...(targetPortID ? { targetPortID } : {}),
})
// start 节点 data.outputs＝workflow 输入声明（JSON Schema）；url 是模板串，可嵌 {{节点.字段}}
const httpNode = (id, title, url, ms = 30) =>
  node(id, 'http', {
    title,
    api: { method: 'GET', url: { type: 'template', content: `${url}${url.includes('?') ? '&' : '?'}ms=${ms}` } },
    headers: { type: 'object' },
    headersValues: {},
    params: { type: 'object' },
    paramsValues: {},
    body: { bodyType: 'none' },
    timeout: { retryTimes: 0, timeout: 30000 },
    outputs: { type: 'object', properties: { body: { type: 'string' }, statusCode: { type: 'number' } } },
  })
const chainEdges = (ids) => [
  edge('n-start', ids[0]),
  ...ids.slice(0, -1).map((id, i) => edge(id, ids[i + 1])),
  edge(ids[ids.length - 1], 'n-end'),
]
const endNode = (id, inputsValues, properties) =>
  node(id, 'end', { title: '交付', inputs: { type: 'object', properties }, inputsValues })

// 条件图：start(format/topic) → cond(ppt?) → taskA/taskB(http) → end(fromA/fromB 双绑定)
const conditionGraph = {
  nodes: [
    node('n-start', 'start', {
      title: '输入',
      outputs: {
        type: 'object',
        properties: { format: { type: 'string' }, topic: { type: 'string' } },
        required: ['format', 'topic'],
      },
    }),
    node('n-cond', 'condition', {
      title: '按格式分流',
      conditions: [{ key: 'ppt', value: { left: ref('n-start', 'format'), operator: 'eq', right: constant('ppt') } }],
    }),
    httpNode('n-taskA', '产 PPT', `http://127.0.0.1:${PORT}/work?topic={{n-start.topic}}&kind=slides`),
    httpNode('n-taskB', '产文字', `http://127.0.0.1:${PORT}/work?topic={{n-start.topic}}&kind=text`),
    endNode(
      'n-end',
      { fromA: ref('n-taskA', 'body'), fromB: ref('n-taskB', 'body') },
      { fromA: { type: 'string' }, fromB: { type: 'string' } }
    ),
  ],
  edges: [
    edge('n-start', 'n-cond'),
    edge('n-cond', 'n-taskA', 'ppt'),
    edge('n-cond', 'n-taskB', 'else'),
    edge('n-taskA', 'n-end'),
    edge('n-taskB', 'n-end'),
  ],
}
const linearGraph = (workNodes) => ({
  nodes: [
    node('n-start', 'start', {
      title: '输入',
      outputs: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    }),
    ...workNodes,
    endNode('n-end', { line: ref(workNodes[workNodes.length - 1].id, 'body') }, { line: { type: 'string' } }),
  ],
  edges: chainEdges(workNodes.map((n) => n.id)),
})

// ---------- 运行与轮询 ----------

async function run(graph, inputs) {
  const { taskID } = await TaskRunAPI({ schema: JSON.stringify(graph), inputs })
  return taskID
}
async function waitSettled(taskID, timeoutMs = 30000) {
  const t0 = Date.now()
  for (;;) {
    const report = await TaskReportAPI({ taskID })
    if (report?.workflowStatus?.terminated) return report
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitSettled timeout taskID=${taskID}`)
    await sleep(25)
  }
}
const nodeStatus = (report, id) => report?.reports?.[id]?.status
const nodeSnapshots = (report, id) => report?.reports?.[id]?.snapshots ?? []
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------- E01 导出面 ----------

{
  const exported = Object.keys(pkg).sort()
  const expected = ['TaskCancelAPI', 'TaskReportAPI', 'TaskResultAPI', 'TaskRunAPI', 'TaskValidateAPI', 'WorkflowRuntimeAPIs'].sort()
  record(
    'E01',
    '公开导出只有 5 个 API 函数＋聚合表：引擎/容器/executor 注册表不导出，自定义 Hemi executor 无公开挂载路径',
    deepEqual(exported, expected),
    { exported }
  )
}

// ---------- E02 Validate ----------

{
  const ok = await TaskValidateAPI({ schema: JSON.stringify(conditionGraph), inputs: { format: 'ppt', topic: 'weekly' } })
  record('E02a', 'Validate：合法图＋合法输入 → valid', ok.valid === true, ok)

  const cycle = { nodes: conditionGraph.nodes, edges: [...conditionGraph.edges, edge('n-end', 'n-cond')] }
  const rCycle = await TaskValidateAPI({ schema: JSON.stringify(cycle), inputs: { format: 'ppt', topic: 'x' } })
  record('E02b', 'Validate：有环 → 拒（cycle detection）', rCycle.valid === false, rCycle.errors)

  const twoStarts = {
    nodes: [...conditionGraph.nodes, node('n-start2', 'start', { title: 'x', outputs: { type: 'object' } })],
    edges: conditionGraph.edges,
  }
  const rTwo = await TaskValidateAPI({ schema: JSON.stringify(twoStarts), inputs: { format: 'ppt', topic: 'x' } })
  record('E02c', 'Validate：双 start → 拒', rTwo.valid === false, rTwo.errors)

  const noEnd = {
    nodes: conditionGraph.nodes.filter((n) => n.type !== 'end'),
    edges: conditionGraph.edges.filter((e) => e.targetNodeID !== 'n-end'),
  }
  const rNoEnd = await TaskValidateAPI({ schema: JSON.stringify(noEnd), inputs: { format: 'ppt', topic: 'x' } })
  record('E02d', 'Validate：缺 end → 拒', rNoEnd.valid === false, rNoEnd.errors)

  const rBadInput = await TaskValidateAPI({ schema: JSON.stringify(conditionGraph), inputs: { format: 123, topic: 'x' } })
  record('E02e', 'Validate：输入类型错（format=123 对 string 声明）→ 拒', rBadInput.valid === false, rBadInput.errors)
}

// ---------- E03/E04 条件两支＋互斥汇合 ----------

{
  const taskID = await run(conditionGraph, { format: 'ppt', topic: 'weekly' })
  const report = await waitSettled(taskID)
  const result = await TaskResultAPI({ taskID })
  record(
    'E03a',
    '选 ppt：taskA succeeded、taskB 在 report 里整个缺失（reports 只收启动过的节点，无 skipped 态）、end succeeded',
    nodeStatus(report, 'n-taskA') === 'succeeded' &&
      report.reports['n-taskB'] === undefined &&
      nodeStatus(report, 'n-end') === 'succeeded',
    { taskA: nodeStatus(report, 'n-taskA'), taskB: report.reports['n-taskB'] ?? '(absent)', end: nodeStatus(report, 'n-end'), workflow: report.workflowStatus.status }
  )
  record(
    'E03b',
    '汇合双绑定：输出只有 fromA（未选支的 ref 被丢弃），值来自选中支（含模板 {{start.topic}} 注入）',
    deepEqual(result, { fromA: 'weekly→slides' }),
    result
  )
  record(
    'E03c',
    '服务端只见 slides 请求、零 text 请求（未选支根本不发）',
    requestsTo('/work').filter((e) => e.path.includes('kind=slides')).length === 1 &&
      requestsTo('/work').filter((e) => e.path.includes('kind=text')).length === 0,
    requestsTo('/work').map((e) => e.path)
  )

  const taskID2 = await run(conditionGraph, { format: 'text', topic: 'monthly' })
  const report2 = await waitSettled(taskID2)
  const result2 = await TaskResultAPI({ taskID: taskID2 })
  record(
    'E04',
    '同图 else 支：taskB succeeded、taskA 报告缺失、输出只有 fromB',
    nodeStatus(report2, 'n-taskB') === 'succeeded' &&
      report2.reports['n-taskA'] === undefined &&
      deepEqual(result2, { fromB: 'monthly→text' }),
    { taskA: report2.reports['n-taskA'] ?? '(absent)', taskB: nodeStatus(report2, 'n-taskB'), result2 }
  )
}

// ---------- E05 确定性 ----------

{
  const a = await run(conditionGraph, { format: 'ppt', topic: 'weekly' })
  const b = await run(conditionGraph, { format: 'ppt', topic: 'weekly' })
  await waitSettled(a)
  await waitSettled(b)
  const ra = await TaskResultAPI({ taskID: a })
  const rb = await TaskResultAPI({ taskID: b })
  record('E05a', '同输入两跑输出 deep-equal', deepEqual(ra, rb), { ra, rb })
  record('E05b', '两次运行 taskID 不同（每次 uuid，无跨运行身份）', a !== b, { a, b })
}

// ---------- E06 自定义节点类型 ----------

{
  const g = linearGraph([httpNode('n-agent', 'agent', `http://127.0.0.1:${PORT}/work?kind=agent`)])
  g.nodes[1].type = 'hemi-agent'
  const taskID = await run(g, { topic: 'x' })
  const report = await waitSettled(taskID)
  const errors = report.messages?.error?.map((m) => m.message) ?? []
  record(
    'E06',
    '自定义类型 hemi-agent：终态 failed、错误＝No executor found（发布包不能注册 Hemi executor）',
    report.workflowStatus.status === 'failed' && errors.some((m) => m.includes('No executor found for node type hemi-agent')),
    { status: report.workflowStatus.status, errors }
  )
}

// ---------- E07 节点失败传播 ----------

{
  const g = linearGraph([
    httpNode('n-ok', 'ok', `http://127.0.0.1:${PORT}/work?kind=ok`),
    httpNode('n-bad', 'bad', `http://127.0.0.1:${PORT}/kill`),
    httpNode('n-after', 'after', `http://127.0.0.1:${PORT}/work?kind=after`),
  ])
  const taskID = await run(g, { topic: 'x' })
  const report = await waitSettled(taskID)
  const result = await TaskResultAPI({ taskID })
  const afterRequests = requestsTo('/work').filter((e) => e.path.includes('kind=after')).length
  record(
    'E07',
    '节点失败（socket 断）：终态 failed、n-ok succeeded、n-bad failed、下游报告缺失且服务端零请求、result()＝{}',
    report.workflowStatus.status === 'failed' &&
      nodeStatus(report, 'n-ok') === 'succeeded' &&
      nodeStatus(report, 'n-bad') === 'failed' &&
      report.reports['n-after'] === undefined &&
      deepEqual(result, {}) &&
      afterRequests === 0,
    { status: report.workflowStatus.status, nAfter: report.reports['n-after'] ?? '(absent)', afterRequests, result }
  )
}

// ---------- E08 内置 CodeExecutor 自带 bug ----------

{
  const quickjsVersion = require('quickjs-emscripten/package.json').version
  const g = linearGraph([httpNode('n-code', 'code', `http://127.0.0.1:${PORT}/work?kind=should-not-run`)])
  g.nodes[1] = node('n-code', 'code', {
    title: 'code',
    script: { language: 'javascript', content: "function main(p){ return { line: 'x' } }" },
    inputs: { type: 'object', properties: {} },
    inputsValues: {},
    outputs: { type: 'object', properties: { line: { type: 'string' } } },
  })
  const taskID = await run(g, { topic: 'x' })
  const report = await waitSettled(taskID)
  const errors = report.messages?.error?.map((m) => m.message) ?? []
  record(
    'E08',
    `CodeExecutor 在 quickjs-emscripten@${quickjsVersion} 上必挂：Lifetime not alive（fulfilled 态的 value 与 unwrapResult 句柄同命，双重 dispose）`,
    report.workflowStatus.status === 'failed' && errors.some((m) => m.includes('Lifetime not alive')),
    { status: report.workflowStatus.status, errors, quickjsVersion }
  )
}

// ---------- C01 在途取消 ----------

{
  const slow = (id) => httpNode(id, id, `http://127.0.0.1:${PORT}/inflight?tag=${id}`, 1500)
  const g = linearGraph([slow('n-slow1'), slow('n-slow2'), slow('n-slow3')])
  const taskID = await run(g, { topic: 'x' })

  const t0 = Date.now()
  for (;;) {
    const report = await TaskReportAPI({ taskID })
    if (nodeStatus(report, 'n-slow1') === 'succeeded' && nodeStatus(report, 'n-slow2') === 'processing') break
    if (Date.now() - t0 > 30000) throw new Error('C01 never saw slow2 processing')
    await sleep(20)
  }
  const cancelAt = Date.now()
  const cancel = await TaskCancelAPI({ taskID })
  const report = await waitSettled(taskID)
  // 等在途请求在服务端收尾，再看它的完成时刻是否晚于 cancel
  await sleep(1700)
  const slow2Entry = requestsTo('/inflight').find((e) => e.path.includes('tag=n-slow2'))
  const slow3Count = requestsTo('/inflight').filter((e) => e.path.includes('tag=n-slow3')).length
  const slow2Snaps = nodeSnapshots(report, 'n-slow2')
  const hasOutputs = slow2Snaps.some((s) => s.outputs && Object.keys(s.outputs).length > 0)
  record(
    'C01a',
    '在途取消：终态 canceled、slow3 报告缺失且服务端零新请求、slow2 快照无 outputs（迟到结果被丢，终态不倒退）',
    cancel.success === true &&
      report.workflowStatus.status === 'canceled' &&
      nodeStatus(report, 'n-slow2') === 'canceled' &&
      report.reports['n-slow3'] === undefined &&
      slow3Count === 0 &&
      !hasOutputs,
    { workflow: report.workflowStatus.status, slow2: nodeStatus(report, 'n-slow2'), slow3: report.reports['n-slow3'] ?? '(absent)', slow3Count, hasOutputs }
  )
  record(
    'C01b',
    '在途 HTTP 在 cancel 之后仍跑完（Runtime 不向执行器传播中止，真实停止必须由宿主自己 abort）',
    slow2Entry?.doneAt !== null && slow2Entry.doneAt > cancelAt,
    { cancelAt, slow2DoneAt: slow2Entry?.doneAt, gapMs: slow2Entry?.doneAt != null ? slow2Entry.doneAt - cancelAt : null }
  )
}

// ---------- C02/C03 取消边界 ----------

{
  const g = linearGraph([httpNode('n-quick', 'q', `http://127.0.0.1:${PORT}/work?kind=q`)])
  const taskID = await run(g, { topic: 'x' })
  await waitSettled(taskID)
  const cancel = await TaskCancelAPI({ taskID })
  const result = await TaskResultAPI({ taskID })
  record('C02', '完成后 cancel：success true 但终态保持 succeeded、result 不受影响', cancel.success === true && deepEqual(result, { line: 'x→q' }), {
    cancel,
    result,
  })

  const r = await TaskCancelAPI({ taskID: 'nonexistent-task' })
  record('C03', '未知 taskID cancel → success:false', r.success === false, r)
}

// ---------- R01 跨进程持久化 ----------

{
  const crossGraph = JSON.stringify(linearGraph([httpNode('n-quick', 'q', `http://127.0.0.1:${PORT}/work?kind=cross`)]))
  const childCode = `
    const { TaskRunAPI, TaskReportAPI } = await import(${JSON.stringify(runtimeUrl)})
    const mode = process.argv[1]
    if (mode === 'run') {
      const { taskID } = await TaskRunAPI({ schema: process.env.PROBE_GRAPH, inputs: { topic: 'x' } })
      for (let i = 0; i < 2000; i++) {
        const r = await TaskReportAPI({ taskID })
        if (r?.workflowStatus?.terminated) break
        await new Promise((res) => setTimeout(res, 20))
      }
      console.log('PROBE_CHILD ' + JSON.stringify({ taskID }))
    } else {
      const r = await TaskReportAPI({ taskID: process.env.PROBE_TASK_ID })
      console.log('PROBE_CHILD ' + JSON.stringify({ report: r ?? null }))
    }
  `
  const cwd = probeRoot
  const runA = spawnSync(process.execPath, ['--input-type=module', '-e', childCode, 'run'], {
    cwd,
    env: { ...process.env, PROBE_GRAPH: crossGraph },
    encoding: 'utf8',
    timeout: 60000,
  })
  const lineA = (runA.stdout ?? '').split('\n').find((l) => l.startsWith('PROBE_CHILD '))
  if (!lineA) throw new Error(`R01 child A failed: ${runA.stderr}`)
  const { taskID } = JSON.parse(lineA.slice('PROBE_CHILD '.length))
  const runB = spawnSync(process.execPath, ['--input-type=module', '-e', childCode, 'report'], {
    cwd,
    env: { ...process.env, PROBE_TASK_ID: taskID },
    encoding: 'utf8',
    timeout: 60000,
  })
  const lineB = (runB.stdout ?? '').split('\n').find((l) => l.startsWith('PROBE_CHILD '))
  const { report } = JSON.parse(lineB.slice('PROBE_CHILD '.length))
  record('R01', '跨进程：A 跑完退出后 B 查同 taskID → report 不存在（任务只在内存，无跨重启持久化）', report === null, {
    taskID,
    reportB: report,
  })
}

// ---------- R02 canceled/failed 的 result 语义 ----------

{
  const g = linearGraph([httpNode('n-bad', 'bad', `http://127.0.0.1:${PORT}/kill`)])
  const failedID = await run(g, { topic: 'x' })
  await waitSettled(failedID)
  const failedResult = await TaskResultAPI({ taskID: failedID })

  const okEmptyID = await run(
    {
      nodes: [node('n-start', 'start', { title: 'i', outputs: { type: 'object' } }), node('n-end', 'end', { title: 'd' })],
      edges: [edge('n-start', 'n-end')],
    },
    {}
  )
  await waitSettled(okEmptyID)
  const okEmptyResult = await TaskResultAPI({ taskID: okEmptyID })
  record(
    'R02',
    'failed 的 result()＝{}，与成功空输出不可区分（终态只能看 report）',
    deepEqual(failedResult, {}) && deepEqual(okEmptyResult, {}),
    { failedResult, okEmptyResult }
  )
}

// ---------- 收口 ----------

server.close()
const failed = findings.filter((f) => !f.ok)
console.log(`\n${findings.length - failed.length}/${findings.length} 项通过`)
if (failed.length > 0) {
  console.log(`未过：${failed.map((f) => f.id).join('、')}`)
  process.exit(1)
}
